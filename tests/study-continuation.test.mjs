import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { assistedFixture, assistedStore } from './helpers-assisted.mjs';
import { assistedDispatch } from '../src/assisted.mjs';
import { assistedProofId } from '../src/assisted-evidence.mjs';
import { policyIdentity } from '../src/policy.mjs';
import { hash, workRelative } from '../src/contracts.mjs';
import { getBatch, saveBatch, guardBatchJob } from '../src/batch-store.mjs';
import { reconcileBatches } from '../src/batches.mjs';
import { studyContinuation, STUDY_CONTINUATION_OPERATIONS } from '../src/study-continuation.mjs';

// Synthetic external evidence and rendered pixels only. No native observations,
// public receipt, production-model/source calls or canonical database are used.
async function fixture(t, { passes = true } = {}) {
  const store = await assistedStore(t), f = await assistedFixture();
  f.usage.modelRequests = 2;
  const saved = await assistedDispatch(store, 'assisted_save', f);
  const policy = await policyIdentity('production');
  const { job, batch } = await assistedDispatch(store, 'assisted_build', { id: saved.id, bundleDigest: saved.bundleDigest, evidenceDigest: saved.evidenceDigest, policyDigest: policy.digest, requestId: 'build-study-fixture', authorized: true });
  const root = path.join(store.stateRoot, workRelative(job));
  await mkdir(path.join(root, 'directions'), { recursive: true });
  const rendered = { pass: false, studies: [], captures: [] };
  for (let index = 0; index < 3; index++) {
    const relative = `directions/study-${index}/site`;
    await mkdir(path.join(root, relative), { recursive: true });
    const html = `Synthetic study ${index}`;
    await writeFile(path.join(root, relative, 'index.html'), html);
    const pass = passes && index < 2;
    rendered.studies.push({ index, relative, pass, siteDigest: hash({ 'index.html': hash(html) }), issues: pass ? [] : ['Synthetic rejected alternative'], viewports: pass ? [1280, 390].map(w => ({ viewport: [w, w === 390 ? 844 : 720], pass: true })) : [] });
    if (pass) for (const w of [1280, 390]) {
      const relative = `directions/study-${index}-${w}.png`, bytes = Buffer.from(`Synthetic pixels ${index}/${w}`);
      await writeFile(path.join(root, relative), bytes);
      rendered.captures.push({ index, relative, viewport: [w, w === 390 ? 844 : 720] });
      store.artifact({ jobId: job.id, relative: `${workRelative(job)}/${relative}`, sha256: hash(bytes), kind: 'direction_capture' });
    }
  }
  let dependency = hash({ dependency: hash({ jobId: job.id, input: job.input, attempt: job.attempt, campaign: store.campaign(job.campaignId) }), policy: policy.digest });
  const values = { qualification: store.candidate(job.input.candidateId), media: [], brief: { fixture: true }, directions: [0, 1, 2], 'directions-render': rendered };
  for (const [name, value] of Object.entries(values)) {
    const sha256 = hash(value);
    await writeFile(path.join(root, `checkpoint-${name}.json`), JSON.stringify({ dependency, value, sha256 }));
    dependency = sha256;
  }
  const bytes = Buffer.from(JSON.stringify(rendered, null, 2));
  await writeFile(path.join(root, 'directions/results.json'), bytes);
  store.artifact({ jobId: job.id, relative: `${workRelative(job)}/directions/results.json`, sha256: hash(bytes), kind: 'directions' });
  const blocked = store.updateJob(job.id, { state: 'blocked', stage: 'directions-render', errorCode: 'DESIGN_STUDY_QA', deadlineAt: new Date(Date.now() + 3600000).toISOString(), message: 'Original synthetic failure' });
  saveBatch(store, { ...batch, state: 'held', message: 'Original hold' });
  return { store, root, job: blocked, batch, policy, rendered, input: { id: job.id, renderDigest: hash(bytes), policyDigest: policy.digest, requestId: 'continue-study-fixture', authorized: true } };
}
const records = store => store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, store.db.prepare(`SELECT * FROM ${name}`).all()]);

test('one exact same-attempt continuation preserves failure, usage, input, deadlines and checkpoint bytes', async t => {
  const f = await fixture(t), before = await readFile(path.join(f.root, 'checkpoint-directions-render.json'));
  const r = await studyContinuation(f.store, f.input);
  assert.equal(r.replayed, false); assert.equal(r.job.id, f.job.id);
  assert.equal(r.job.state, 'queued'); assert.equal(r.job.stage, 'selection');
  assert.equal(r.job.attempt, 0); assert.equal(r.job.deadlineAt, f.job.deadlineAt);
  assert.deepEqual(r.job.input, f.job.input); assert.equal(r.job.directionRepair, undefined);
  assert.equal(r.batch.state, 'active'); assert.deepEqual(r.batch.usage, f.batch.usage);
  assert.equal(r.batch.deadlineAt, f.batch.deadlineAt); assert.equal(r.batch.createdAt, f.batch.createdAt);
  assert.deepEqual(await readFile(path.join(f.root, 'checkpoint-directions-render.json')), before);
  const receipt = JSON.parse(f.store.db.prepare("SELECT record FROM factory_operation WHERE kind='study_continuation'").get().record);
  assert.deepEqual(receipt.failedJob, f.job); assert.deepEqual(receipt.passingStudyIndices, [0, 1]);
  assert.equal(receipt.originalPolicyDigest, f.policy.digest);
  assert.ok(f.store.events(f.job.id).some(e => e.type === 'study.continuation_requested' && e.detail.failedJob.errorCode === 'DESIGN_STUDY_QA'));
  guardBatchJob(f.store, r.job, { claiming: true });
  f.store.updateJob(f.job.id, { state: 'running' });
  assert.equal((await studyContinuation(f.store, f.input)).job.state, 'running');
  await assert.rejects(studyContinuation(f.store, { ...f.input, requestId: 'different-request' }), { code: 'STUDY_CONTINUATION_USED' });
  assert.equal(f.store.jobs().length, 1);
});

for (const [name, mutate] of [
  ['authorization', async f => { f.input.authorized = false; }],
  ['unknown fields', async f => { f.input.reset = true; }],
  ['stale policy', async f => { f.input.policyDigest = '0'.repeat(64); }],
  ['wrong render digest', async f => { f.input.renderDigest = '0'.repeat(64); }],
  ['wrong failure', async f => { f.store.updateJob(f.job.id, { errorCode: 'DESIGN_SELECTION' }); }],
  ['wrong stage', async f => { f.store.updateJob(f.job.id, { stage: 'proposal' }); }],
  ['retry attempt', async f => { f.store.updateJob(f.job.id, { attempt: 1 }); }],
  ['stopped batch', async f => { saveBatch(f.store, { ...getBatch(f.store, f.batch.id), state: 'stopped' }); }],
  ['expired original job deadline', async f => { f.store.updateJob(f.job.id, { deadlineAt: new Date(Date.now() - 1).toISOString() }); }],
  ['insufficient original job time', async f => { f.store.updateJob(f.job.id, { deadlineAt: new Date(Date.now() + 60000).toISOString() }); }],
  ['changed candidate', async f => { const c=f.store.candidate(f.job.input.candidateId); f.store.db.prepare('UPDATE factory_candidate SET record=? WHERE id=?').run(JSON.stringify({ ...c, summary: 'changed' }), c.id); }],
  ['suppressed candidate', async f => { f.store.db.prepare('INSERT INTO factory_sales_case VALUES(?,?,?)').run('case-fixture', f.job.input.candidateId, JSON.stringify({ suppressed: true })); }],
  ['duplicate identity', async f => { const c={ ...f.store.candidate(f.job.input.candidateId), id: 'lead-duplicate-fixture' }; f.store.db.prepare('INSERT INTO factory_candidate VALUES(?,?,?)').run(c.id, c.campaignId, JSON.stringify(c)); }],
  ['exhausted model floor', async f => { saveBatch(f.store, { ...getBatch(f.store, f.batch.id), usage: { ...f.batch.usage, modelRequests: 11 } }); }],
  ['assisted proof binding', async f => { const id=assistedProofId((await assistedFixture()).scope.authorizationId), row=f.store.db.prepare('SELECT record FROM factory_operation WHERE id=?').get(id), proof=JSON.parse(row.record); f.store.db.prepare('UPDATE factory_operation SET record=? WHERE id=?').run(JSON.stringify({ ...proof, bundleDigest: '0'.repeat(64) }), id); }],
  ['changed render bytes', async f => { await writeFile(path.join(f.root, 'directions/results.json'), '{}'); }],
  ['changed checkpoint dependency', async f => { const p=path.join(f.root, 'checkpoint-brief.json'), c=JSON.parse(await readFile(p)); c.dependency='0'.repeat(64); await writeFile(p, JSON.stringify(c)); }],
  ['changed study bytes', async f => { await writeFile(path.join(f.root, 'directions/study-0/site/index.html'), 'tampered'); }],
  ['changed capture bytes', async f => { await writeFile(path.join(f.root, 'directions/study-0-390.png'), 'tampered'); }],
  ['symlink capture', async f => { const p=path.join(f.root, 'directions/study-0-390.png'); const { unlink }=await import('node:fs/promises'); await unlink(p); await symlink('study-0-1280.png', p); }],
  ['dangling downstream symlink', async f => { await symlink('missing-selection.json', path.join(f.root, 'checkpoint-selection.json')); }],
]) test(`rejects ${name} without database side effects`, async t => {
  const f=await fixture(t); await mutate(f); const before=records(f.store);
  await assert.rejects(studyContinuation(f.store, f.input)); assert.deepEqual(records(f.store), before);
});

test('no passing desktop/phone study is not continuation authority', async t => {
  const f=await fixture(t, { passes: false }), before=records(f.store);
  await assert.rejects(studyContinuation(f.store, f.input), { code: 'STUDY_CONTINUATION_RENDER' });
  assert.deepEqual(records(f.store), before);
});

test('operation contract is strict and mutating', () => {
  const op=STUDY_CONTINUATION_OPERATIONS.study_continue;
  assert.equal(op.readOnly, false);
  assert.equal(op.schema.safeParse({ id: 'job-aa', renderDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), requestId: 'request-one', authorized: true }).success, true);
  assert.equal(op.schema.safeParse({ id: 'job-aa', renderDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), requestId: 'request-one', authorized: true, retry: true }).success, false);
});

test('explicit adoption stores exact current policy files and preserves the original cached dependency policy', async t => {
  const f=await fixture(t), oldPolicy='c'.repeat(64), b=getBatch(f.store, f.batch.id);
  saveBatch(f.store, { ...b, policyDigest: oldPolicy });
  const file=path.join(f.root, 'checkpoint-qualification.json'), checkpoint=JSON.parse(await readFile(file));
  checkpoint.dependency=hash({ dependency: hash({ jobId: f.job.id, input: f.job.input, attempt: f.job.attempt, campaign: f.store.campaign(f.job.campaignId) }), policy: oldPolicy });
  await writeFile(file, JSON.stringify(checkpoint));
  const r=await studyContinuation(f.store, f.input);
  assert.equal(r.job.studyContinuation.originalPolicyDigest, oldPolicy);
  assert.equal(r.batch.policyDigest, f.policy.digest);
  assert.deepEqual(r.batch.policyFiles, f.policy.files);
  assert.equal(r.batch.policyHistory.at(-1).previousPolicyDigest, oldPolicy);
  const proofId=assistedProofId((await assistedFixture()).scope.authorizationId), proof=JSON.parse(f.store.db.prepare('SELECT record FROM factory_operation WHERE id=?').get(proofId).record);
  assert.deepEqual(proof.policyFiles, f.policy.files);
  guardBatchJob(f.store, r.job, { claiming: true });
});

test('concurrent exact requests consume only one atomic continuation record', async t => {
  const f=await fixture(t), results=await Promise.all([studyContinuation(f.store, f.input), studyContinuation(f.store, f.input)]);
  assert.deepEqual(results.map(r=>r.replayed).sort(), [false, true]);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM factory_operation WHERE kind='study_continuation'").get().n, 1);
  assert.equal(f.store.events(f.job.id).filter(e=>e.type==='study.continuation_requested').length, 1);
});

test('actual reconciler first_site_review failure phase continues to production with original held phase retained', async t => {
  const f=await fixture(t);
  saveBatch(f.store, { ...getBatch(f.store, f.batch.id), state: 'active', phase: 'production' });
  await reconcileBatches(f.store);
  const held=getBatch(f.store, f.batch.id);
  assert.equal(held.state, 'held'); assert.equal(held.phase, 'first_site_review'); assert.equal(held.checkpoint, null);
  const result=await studyContinuation(f.store, f.input);
  assert.equal(result.batch.state, 'active'); assert.equal(result.batch.phase, 'production');
  const receipt=JSON.parse(f.store.db.prepare("SELECT record FROM factory_operation WHERE kind='study_continuation'").get().record);
  assert.equal(receipt.heldBatch.phase, 'first_site_review');
  guardBatchJob(f.store, result.job, { claiming: true });
});
