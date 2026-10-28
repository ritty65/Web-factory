import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { fail, hash, now, safeRelative, workRelative } from './contracts.mjs';
import { key, requirePilot, transaction } from './sales.mjs';
import { policyIdentity } from './policy.mjs';
import { batchForCampaign, getBatch, guardBatchJob, saveBatch } from './batch-store.mjs';
import { assistedProofId, readAssistedEvidence } from './assisted-evidence.mjs';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const STUDY_CONTINUATION_OPERATIONS = {
  study_continue: {
    description: 'Explicit one-use continuation of an exact held initial DESIGN_STUDY_QA job with retained passing desktop/phone studies. Same attempt, inputs, usage and original deadlines; no retry, research, repair, acceptance or publication.',
    schema: z.object({ id: key, renderDigest: digest, policyDigest: digest, requestId: key, authorized: z.literal(true) }).strict(),
    readOnly: false,
  },
};
const parse = row => row && JSON.parse(row.record);
const reject = message => fail('STUDY_CONTINUATION_RENDER', message);

// Synchronous bounded reads allow validation and the state transition to share
// one SQLite transaction, with no asynchronous gap for another ledger writer.
function ordinary(target) {
  for (let p = target;; p = path.dirname(p)) {
    if (lstatSync(p).isSymbolicLink()) reject('Retained evidence cannot follow symbolic links.');
    if (path.dirname(p) === p) break;
  }
  return lstatSync(target);
}
function bytesAt(root, relative) {
  const target = path.join(root, safeRelative(relative)), info = ordinary(target);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) reject('Retained evidence must be a bounded ordinary file.');
  return readFileSync(target);
}
function siteDigest(root, relative) {
  const base = path.join(root, safeRelative(relative)), files = {}; let count = 0;
  function walk(dir) {
    if (!ordinary(dir).isDirectory()) reject('Study root must be an ordinary directory.');
    for (const name of readdirSync(dir)) {
      if (++count > 1000) reject('Study file-count bound exceeded.');
      const target = path.join(dir, name), info = ordinary(target);
      if (info.isDirectory()) walk(target);
      else if (info.isFile()) { const rel = safeRelative(path.relative(base, target)); files[rel] = hash(bytesAt(base, rel)); }
      else reject('Study trees contain only ordinary files.');
    }
  }
  walk(base);
  return hash(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
}
function validateRetained(store, job, batch, renderDigest) {
  const relative = workRelative(job), root = path.join(store.stateRoot, relative), checkpoints = {};
  let dependency = hash({ dependency: hash({ jobId: job.id, input: job.input, attempt: job.attempt, campaign: store.campaign(job.campaignId) }), policy: batch.policyDigest });
  const values = {};
  for (const name of ['qualification', 'media', 'brief', 'directions', 'directions-render']) {
    const bytes = bytesAt(root, `checkpoint-${name}.json`), checkpoint = JSON.parse(bytes);
    if (checkpoint.dependency !== dependency || checkpoint.sha256 !== hash(checkpoint.value)) reject('The original immutable checkpoint chain no longer matches this job, input, attempt, campaign and policy.');
    values[name] = checkpoint.value; checkpoints[name] = { sha256: checkpoint.sha256, fileSha256: hash(bytes), dependency };
    dependency = checkpoint.sha256;
  }
  if (hash(values.qualification) !== hash(store.candidate(job.input.candidateId))) fail('BATCH_INTAKE', 'Frozen study facts no longer match the exact current candidate.');
  if (!Array.isArray(values.directions) || values.directions.length !== 3) reject('Exactly three retained direction sources are required.');
  for (const m of values.media) for (const [file, sha] of [[m.original_file, m.original_sha256], [m.web_file, m.web_sha256]]) {
    if (!/^(media\/originals\/|site\/assets\/photos\/)/.test(file) || hash(bytesAt(root, file)) !== sha) reject('Retained production media changed.');
  }
  // Selection or proposal checkpoints mean this is not the narrow pre-selection
  // failure this operation authorizes. Never delete or overwrite such evidence.
  for (const name of ['checkpoint-selection.json', 'direction-selection.json', 'checkpoint-proposal.json']) {
    try { lstatSync(path.join(root, name)); reject('Downstream selection/proposal evidence already exists.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const artifacts = store.artifacts(job.id), renderBytes = bytesAt(root, 'directions/results.json');
  const artifact = artifacts.find(a => a.relative === `${relative}/directions/results.json`);
  if (!artifact || artifact.sha256 !== renderDigest || hash(renderBytes) !== renderDigest) reject('Render digest must bind the actual retained results artifact, not a caller-supplied assertion.');
  const rendered = JSON.parse(renderBytes);
  if (hash(rendered) !== hash(values['directions-render']) || rendered.pass !== false || !Array.isArray(rendered.studies) || rendered.studies.length !== 3 || !Array.isArray(rendered.captures)) reject('Render artifact and immutable checkpoint must describe the same failed comparison.');
  const passingStudyIndices = [];
  for (let index = 0; index < 3; index++) {
    const s = rendered.studies[index];
    if (s.index !== index || s.relative !== `directions/study-${index}/site` || siteDigest(root, s.relative) !== s.siteDigest) reject('Retained rendered study bytes or exact indices changed.');
    if (s.pass !== true) continue;
    for (const width of [1280, 390]) {
      const views = s.viewports?.filter(v => v.viewport?.[0] === width);
      const captures = rendered.captures.filter(c => c.index === index && c.viewport?.[0] === width);
      if (views?.length !== 1 || views[0].pass !== true || captures.length !== 1 || captures[0].relative !== `directions/study-${index}-${width}.png`) reject('A passing study requires actual matching desktop and phone viewport results and captures.');
    }
    passingStudyIndices.push(index);
  }
  for (const c of rendered.captures) {
    if (!Number.isInteger(c.index) || c.index < 0 || c.index > 2 || ![1280, 390].includes(c.viewport?.[0]) || c.relative !== `directions/study-${c.index}-${c.viewport[0]}.png`) reject('Unsupported capture namespace or index.');
    const a = artifacts.find(a => a.relative === `${relative}/${c.relative}`);
    if (!a || hash(bytesAt(root, c.relative)) !== a.sha256) reject('Actual retained capture bytes must match their registered artifact hashes.');
  }
  if (!passingStudyIndices.length) reject('At least one actual passing desktop/phone study is required.');
  return { checkpoints, passingStudyIndices };
}

export async function studyContinuation(store, raw) {
  requirePilot(store);
  const parsed = STUDY_CONTINUATION_OPERATIONS.study_continue.schema.safeParse(raw);
  if (!parsed.success) fail('INVALID_INPUT', 'Exact job/render/policy/request binding and explicit authorization are required; no extra fields.');
  const input = parsed.data, policy = await policyIdentity('production');
  return transaction(store, () => {
    const job = store.job(input.id), receiptId = `study-continuation-${hash(job.id).slice(0, 24)}`;
    const previous = parse(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='study_continuation'").get(receiptId));
    if (previous) {
      if (previous.inputDigest !== hash(input)) fail('STUDY_CONTINUATION_USED', 'This exact job already consumed its one continuation; a different request cannot continue it again.');
      return { job, batch: getBatch(store, previous.batchId), replayed: true };
    }
    if (input.policyDigest !== policy.digest) fail('BATCH_POLICY', 'Explicit exact current production policy acknowledgement is required.');
    // Rehash the exact policy inventory inside the transaction. Do not adopt a
    // stale asynchronous observation if source changed before this transition.
    for (const [file, sha] of Object.entries(policy.files)) if (hash(bytesAt(fileURLToPath(new URL('../', import.meta.url)), file)) !== sha) fail('BATCH_POLICY', 'Production policy changed during continuation validation.');
    const b = batchForCampaign(store, job.campaignId);
    if (!b || b.state !== 'held' || !['production', 'first_site_review'].includes(b.phase) || b.checkpoint || job.kind !== 'site' || job.state !== 'blocked' || job.stage !== 'directions-render' || job.errorCode !== 'DESIGN_STUDY_QA' || job.attempt !== 0 || job.directionRepair || job.input.parentSiteJobId || job.input.polishOf || job.input.reuseStudyJobId) fail('STUDY_CONTINUATION_STATE', 'Only one exact held initial pre-selection DESIGN_STUDY_QA attempt may continue.');
    const otherOpen = store.db.prepare("SELECT id FROM factory_operation WHERE kind='batch' AND id<>? AND json_extract(record,'$.state') IN ('active','held','awaiting_selection','awaiting_first_review')").get(b.id);
    if (otherOpen) fail('BATCH_ACTIVE', 'Another open batch prevents this exact continuation.');
    const remaining = Math.min(Date.parse(job.deadlineAt), Date.parse(b.deadlineAt)) - Date.now();
    if (!Number.isFinite(remaining) || remaining < 20 * 60000 || b.settings.maxModelRequests - b.usage.modelRequests < 6) fail('BATCH_COMPLETION_BUDGET', 'The original job and batch deadlines and remaining six-launch/twenty-minute completion floor must still permit completion. No allowance resets.');
    const retained = validateRetained(store, job, b, input.renderDigest), at = now();
    const history = { previousPolicyDigest: b.policyDigest, policyDigest: policy.digest, requestId: input.requestId, continuationReceiptId: receiptId, at, authority: 'explicit_same_attempt_study_continuation_not_human_acceptance' };
    const next = { ...b, state: 'active', phase: 'production', policyDigest: policy.digest, policyFiles: policy.files, policyHistory: [...(b.policyHistory || []), history], message: 'One explicit same-attempt study continuation; failed alternatives and original allowances retained.' };
    if (b.assistedIntake) {
      const value = readAssistedEvidence(store, b.assistedIntake), proofId = assistedProofId(value.scope.authorizationId);
      const proof = parse(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='assisted_proof'").get(proofId));
      if (!proof || proof.siteJobId !== job.id) fail('BATCH_ASSISTED_BINDING', 'The exact assisted proof must own this original job.');
      store.db.prepare("UPDATE factory_operation SET record=? WHERE id=? AND kind='assisted_proof'").run(JSON.stringify({ ...proof, policyFiles: policy.files, policyHistory: [...(proof.policyHistory || []), history] }), proofId);
    }
    saveBatch(store, next);
    // Includes full assisted intake/file hashes, exact selection, suppression,
    // duplicate and current candidate guards. A rejection rolls all adoption back.
    guardBatchJob(store, job, { claiming: true });
    const receipt = { id: receiptId, kind: 'study_continuation', jobId: job.id, batchId: b.id, requestId: input.requestId, inputDigest: hash(input), renderDigest: input.renderDigest, originalPolicyDigest: b.policyDigest, policyDigest: policy.digest, policyFiles: policy.files, at, failedJob: job, heldBatch: b, ...retained, humanDecision: null, publicRelease: false };
    store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?)').run(receiptId, 'study_continuation', JSON.stringify(receipt));
    store.event(job.id, 'study.continuation_requested', 'Original study failure retained before explicit same-attempt continuation; not repair, retry or human acceptance.', { receiptId, requestId: input.requestId, failedJob: job, originalPolicyDigest: b.policyDigest, policyDigest: policy.digest, renderDigest: input.renderDigest, passingStudyIndices: retained.passingStudyIndices });
    const queued = store.updateJob(job.id, { state: 'queued', stage: 'selection', ownerPid: null, errorCode: null, studyContinuation: { receiptId, originalPolicyDigest: b.policyDigest, policyDigest: policy.digest, renderDigest: input.renderDigest, passingStudyIndices: retained.passingStudyIndices }, message: next.message });
    return { job: queued, batch: getBatch(store, b.id), replayed: false };
  });
}
