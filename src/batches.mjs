import path from 'node:path';
import { lstatSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import { hash, now, fail, safeRelative } from './contracts.mjs';
import { key, note, requestId, pageSchema, transaction, requirePilot } from './sales.mjs';
import { operationRecord } from './pilot.mjs';
import { policyIdentity } from './policy.mjs';
import { treeHashes } from './proposal.mjs';
import { DEFAULT_FACTORY_MODEL } from './model.mjs';
import { leadList, prospectItem } from './prospects.mjs';
import { profileAnchors } from './intake.mjs';
import {progressSnapshot} from './progress.mjs';
import {acquisitionPolicy,completionCapacity,discoveryAdmission} from './acquisition.mjs';
import {scoutSummary} from './scout.mjs';
import {validateSeedReceipt,claimSeedReceipt} from './seeds.mjs';
import { parseRecord, getBatch, saveBatch, batchJobs, suppressionFor, existingEntity, guardBatchJob, memberEvidenceCurrent, guardBatchCheckpoint } from './batch-store.mjs';

const settingsSchema = z.object({
  area: z.enum(['Houston city limits', 'Houston metro area']), niche: note.pipe(z.string().max(100)),
  targetCount: z.number().int().min(1).max(10), candidateLimit: z.number().int().min(1).max(40),
  maxResearchRounds: z.number().int().min(1).max(10), searchProvider: z.enum(['guest_bing', 'firecrawl']),
  maxSearches: z.number().int().min(1).max(60), maxInspections: z.number().int().min(1).max(120),
  maxImageViews: z.number().int().min(1).max(60), maxModelRequests: z.number().int().min(1).max(100),
  batchMinutes: z.number().int().min(30).max(720), jobMinutes: z.number().int().min(2).max(60),
  workflow: z.literal('leads_first').optional(), discoverySearchLimit: z.number().int().min(1).max(59).optional(),
}).strict().refine(v => v.targetCount <= v.candidateLimit, 'Candidate allowance must cover the target')
  .refine(v => v.workflow === 'leads_first' ? v.discoverySearchLimit < v.maxSearches && v.targetCount === 1 : v.discoverySearchLimit === undefined, 'Leads-first requires one site and an explicit discovery allocation smaller than the total');
const op = (description, schema, readOnly = false) => ({ description, schema, readOnly });
export const BATCH_OPERATIONS = {
  lead_list: op('Read persisted source-bound prospects without research or writes.', z.object({ batchId: key.optional(), candidateId: key.optional(), state: z.enum(['strong', 'held', 'excluded', 'ready', 'booking_only']).optional(), ...pageSchema }).strict(), true),
  batch_build_selected: op('Explicitly select ONE saved prospect for exact enrichment within the original total allowances. Never resets time or usage.', z.object({ id: key, candidateId: key, evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/), policyDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), requestId, authorized: z.literal(true) }).strict()),
  batch_status: op('Read saved Houston setup and paginated durable batch summaries. No live research, provider authentication or writes.', z.object(pageSchema).strict(), true),
  batch_get: op('Read a batch, member states, paginated review notes, reported cost coverage and source-backed UNSENT contact plans. Local previews are not owner links.', z.object({ id: key, ...pageSchema }).strict(), true),
  batch_readiness: op('Check local prerequisites without models, paid search, credentials or a live business probe. Available is not live-verified.', z.object({}).strict(), true),
  batch_preset_save: op('Explicitly save geography/category/source/usage setup. Acknowledge permitted collection and reviewed limits. Does not run or authenticate providers.', z.object({ version: z.number().int().min(0), requestId, settings: settingsSchema, acknowledged: z.literal(true) }).strict()),
  batch_start: op('ONLY with explicit live-run authority: start one bounded PRIVATE saved batch, pausing after its first complete site. Never sends/publishes. Software tests do not authorize a real batch.', z.object({ presetVersion: z.number().int().min(0), requestId, authorized: z.literal(true), seedReceipt:z.object({id:key,digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional() }).strict()),
  batch_stop: op('Stop only this batch and its owned queued/running jobs. Preserve results, failures and budgets. No automatic restart.', z.object({ id: key }).strict()),
  batch_recover_launch: op('Explicit ONE-use recovery of a conclusively pre-launch E2BIG first discovery failure, within the same claimed seed cohort, original deadline and remaining allowances. Preserves the failed job and stop history; not automatic retry.', z.object({ id: key, failedJobId: key, policyDigest: z.string().regex(/^[a-f0-9]{64}$/), requestId, authorized: z.literal(true) }).strict()),
  batch_continue: op('ONLY after actual user review and permission for remaining builds: record a supplied exact-first-site checkpoint. Not authenticated human acceptance or publication. Changed bytes fail.', z.object({ id: key, siteJobId: key, siteDigest: z.string().regex(/^[a-f0-9]{64}$/), note, reviewed: z.literal(true) }).strict()),
  batch_item_note: op('Save a supplied inbox note/disposition, not regeneration/contact/acceptance. Needs-changes/not-a-fit hold further automatic work.', z.object({ id: key, candidateId: key, requestId, disposition: z.enum(['needs_changes', 'not_a_fit', 'note']), note }).strict()),
};
const authority = { contactAuthorized: false, publicRelease: false, humanDecision: null, externalReviewUrl: null };
export function batchPreset(store) {
  return parseRecord(store.db.prepare("SELECT record FROM factory_operation WHERE id='preset-houston' AND kind='batch_preset'").get()) || {
    id: 'preset-houston', version: 0, adopted: false, settings: {
      area: 'Houston city limits', niche: '', targetCount: 10, candidateLimit: 30, maxResearchRounds: 10,
      searchProvider: 'guest_bing', maxSearches: 60, maxInspections: 120, maxImageViews: 60,
      maxModelRequests: 90, batchMinutes: 720, jobMinutes: 45,
    }, note: 'Suggestions only. Choose categories/area and review permitted sources and usage once before running.',
  };
}
function listBatches(store, { offset = 0, limit = 30 } = {}) {
  return store.db.prepare("SELECT record FROM factory_operation WHERE kind='batch' ORDER BY rowid DESC LIMIT ? OFFSET ?").all(limit, offset).map(parseRecord);
}
function batchCounts(store, b) {
  const jobs = batchJobs(store, b.campaignId), initial = jobs.filter(j => j.kind === 'site' && !j.input.parentSiteJobId);
  const latest = new Map(jobs.filter(j => j.kind === 'site').map(j => [j.input.candidateId, j]));
  const ready = [...latest.values()].filter(j => { const c = store.candidate(j.input.candidateId), m = b.members.find(m => m.candidateId === c.id); return j.state === 'review_ready' && j.outputs.reviewStatus === 'operator_review_required' && memberEvidenceCurrent(m, c) && !['not_a_fit','needs_changes'].includes(m.disposition) && !suppressionFor(store, c); }).length;
  return { researched: b.members.length, buildReady: b.members.filter(m => m.ready).length, initialAttempts: initial.length, ready,
    ...(b.settings.workflow === 'leads_first' ? { selectable: b.members.filter(m => prospectItem(store, b, m).canSelect).length } : {}),
    needsAttention: b.members.filter(m => !m.ready || m.disposition && m.disposition !== 'note').length + initial.filter(j => ['blocked', 'failed', 'cancelled'].includes(j.state)).length,
    shortfall: Math.max(0, b.settings.targetCount - ready) };
}
export function batchStatus(store, input = {}) {
  requirePilot(store); const { offset = 0, limit = 30 } = input;
  const total = store.db.prepare("SELECT count(*) n FROM factory_operation WHERE kind='batch'").get().n;
  return { preset: batchPreset(store), items: listBatches(store, input).map(b => batchSummary(store, b)), total, offset, limit,
    nextOffset: offset + limit < total ? offset + limit : null, authority, at: now() };
}
function batchSummary(store, b) {
  const counts = batchCounts(store, b), allJobs = batchJobs(store, b.campaignId), recovered = allJobs.find(j=>j.kind==='discovery'&&j.state==='failed'&&recoveredLaunchParent(store,b,j)),jobs=allJobs.filter(j=>j.id!==recovered?.id);
  let outcome = null;
  if (['complete', 'held', 'awaiting_selection'].includes(b.state)) {
    const failed = jobs.some(j => j.kind === 'discovery' && ['failed', 'blocked', 'cancelled'].includes(j.state));
    if (!counts.researched && !counts.initialAttempts && b.usage.modelRequests > 0 && !b.usage.searches && !b.usage.inspections && !b.usage.imageViews) outcome = { kind: 'research_not_run', title: 'Research did not run', explanation: 'A model launch was recorded, but no search, page inspection or image-view attempts were observed. No businesses or websites were produced.', nextStep: 'Integration needs repair; do not start another batch.' };
    else if (failed) outcome = { kind: 'research_stopped', title: 'Research stopped', explanation: 'A research job stopped on a source or model failure. Results, failed attempts and unused target remain recorded; no automatic retry.' };
    else if (b.settings.workflow === 'leads_first' && !b.selection && counts.selectable === 0 && ['discovery', 'selection'].includes(b.phase) && jobs.length && jobs.every(j => j.kind === 'discovery' && j.state === 'review_ready')) outcome = { kind: 'no_selectable_prospect', title: 'No business is ready to choose.', explanation: 'No saved business is available for selection under this run’s evidence and limits. Uncertain, excluded and booking-only results are retained. No website was made; no automatic retry or replacement.' };
    else if (b.state === 'complete' && !counts.researched) outcome = { kind: 'no_business_qualified', title: 'No business qualified', explanation: 'Research ended without a qualified business or a website. This is a shortfall, not a successful production run.' };
    else if (b.state === 'complete' && counts.shortfall) outcome = { kind: 'shortfall', title: 'Batch ended with a shortfall', explanation: `${counts.ready} of ${b.settings.targetCount} sites are ready for review. Held or failed work is retained, not counted as a finished site.` };
  }
  return { ...b, counts, outcome,...(recovered?{recoveredLaunchParentJobId:recovered.id}:{}) };
}
function replay(store, id, input) {
  const old = parseRecord(store.db.prepare('SELECT record FROM factory_operation WHERE id=?').get(id));
  if (old && old.inputDigest !== hash(input)) fail('IDEMPOTENCY_CONFLICT', 'This request ID was already used with different content.');
  return old;
}
function finish(store, b, state, message) { return saveBatch(store, { ...b, state, phase: 'complete', message, finishedAt: now() }); }
function cancelOwned(store, b) { for (const j of batchJobs(store, b.campaignId)) if (['queued', 'running'].includes(j.state)) store.cancel(j.id); }
function contactPlan(c, m, job) {
  const options = m.contacts || [], suppressed = m.suppressed;
  const allowed = Boolean(!suppressed && m.ready && job?.state === 'review_ready' && !['not_a_fit', 'needs_changes'].includes(m.disposition));
  const hook = c.facts[0]?.excerpt ? ` Your public information mentions: “${c.facts[0].excerpt.slice(0, 180)}”` : '';
  return { options: suppressed ? [] : options, status: suppressed ? 'do_not_contact' : 'preparation_only', contactAuthorized: false, externalReviewUrl: null,
    nextAction: suppressed ? 'Do not contact from this workflow. Inspect the matched prior suppressed/lost/delivered case; no opt-out is inferred merely from a loss or delivery.' : !allowed ? 'Resolve held evidence/site and review it before any owner approach.' : 'Review the exact site; separately authorize the supported owner link, recipient, channel and message before sending.',
    draft: allowed && options.length ? `Hi ${c.name} team — I’m with Simulacra.${hook} I put together an independent five-page website concept for your business. It is a private proposal, not your official website. If a website is something you’re considering, would you be interested in taking a look? No obligation.` : null,
    draftStatus: 'unsent_not_authorized', limitations: ['No owner identity or purchase intent inferred', 'A public phone is not permission for cold SMS', 'No externally accessible review link has been created'] };
}
export async function batchGet(store, id, { offset = 0, limit = 30 } = {}) {
  const b = getBatch(store, id), jobs = batchJobs(store, b.campaignId), summary = batchSummary(store, b);
  const items = b.members.map(m => {
    const c = store.candidate(m.candidateId), site = jobs.filter(j => j.kind === 'site' && j.input.candidateId === c.id).at(-1), suppressed = Boolean(suppressionFor(store, c));
    const ready = memberEvidenceCurrent(m, c), reasons = [...m.reasons, ...(m.ready && !ready ? ['Evidence changed or website checks are stale; refresh and review before further use.'] : [])];
    return { ...m, ready, reasons, suppressed, candidate: c, job: site || null, status: suppressed ? 'suppressed' : ['not_a_fit', 'needs_changes'].includes(m.disposition) ? m.disposition : b.settings.workflow === 'leads_first' && !site && ['discovery', 'selection', 'enrichment'].includes(b.phase) ? b.phase === 'enrichment' && b.selection?.candidateId === c.id ? 'enriching' : 'awaiting_selection' : !ready ? 'held' : site?.state || (['complete','stopped'].includes(b.state) ? 'not_built' : 'waiting_to_build'),
      whyFit: ready ? b.assistedIntake ? 'Booking/social presence exists; no independent marketing website found in the documented assisted checks. Imported evidence supports a private concept, not native verification or owner confirmation.' : 'No functioning official website found in the documented checks; bound content, media and public contact support a private concept. Not owner confirmation.' : 'Current qualification is held or excluded; see the recorded reasons.',
      ...(b.settings.workflow === 'leads_first' ? { prospect: prospectItem(store, b, m) } : {}), contact: contactPlan(c, { ...m, ready, suppressed }, site), capture: site ? store.artifacts(site.id).find(a => a.kind === 'site_capture' && /index-(?:first-)?1440\.png$/.test(a.relative)) || null : null };
  });
  const noteTotal = store.db.prepare("SELECT count(*) n FROM factory_operation WHERE kind='batch_item_note' AND json_extract(record,'$.batchId')=?").get(id).n;
  const notes = store.db.prepare("SELECT record FROM factory_operation WHERE kind='batch_item_note' AND json_extract(record,'$.batchId')=? ORDER BY rowid DESC LIMIT ? OFFSET ?").all(id, limit, offset).map(parseRecord);
  const costs = store.db.prepare('SELECT record FROM factory_cost WHERE campaign_id=?').all(b.campaignId).map(parseRecord);
   return { currentPolicyDigest: (await policyIdentity('production')).digest, progress: progressSnapshot(store,summary,jobs.filter(j=>j.id!==summary.recoveredLaunchParentJobId)),...(b.acquisition?.version===1?{acquisition:{...scoutSummary(store,b.id),capacity:completionCapacity(b)}}:{}),batch: summary, jobs: jobs.map(({ id, kind, state, stage, message, input, outputs, errorCode }) => ({ id, kind, state, stage, message, input, outputs, errorCode })), items, authority,
    noteHistory: { items: notes, total: noteTotal, offset, limit, nextOffset: offset + limit < noteTotal ? offset + limit : null },
    costs: { coverage: costs.length ? 'partial_operator_reported' : 'not_recorded', records: costs.length, reportedTotalCents: costs.length ? costs.reduce((sum, c) => sum + c.cashCents + c.laborCents, 0) : null, verifiedPaidSales: null },
    usageUnits: { modelRequests: 'Native OpenCode launches, not underlying provider completions/tokens/dollars; researcher <=36 agent steps per launch', searches: 'Search-reader attempts, including failures', inspections: 'Page-reader attempts, excluding pages read internally by search', imageViews: 'Observed image-view attempts' } };
}
function queueResearch(store, b) {
  const capacity=discoveryAdmission(b);if(!capacity.available)return saveBatch(store,{...b,state:'held',phase:'discovery',message:capacity.gaps[0]});
  const next = saveBatch(store, { ...b, round: b.round + 1, phase: b.settings.workflow === 'leads_first' ? 'discovery' : 'research', message: 'Researching within the saved source and usage allowances.' });
  const job = store.createJob({ campaignId: b.campaignId, kind: 'discovery', input: { batchId: b.id, round: next.round, candidateLimit: Math.min(3, b.settings.candidateLimit - b.members.length), ...(b.settings.workflow === 'leads_first' ? { phase: 'discovery' } : {}) } });
  return saveBatch(store, { ...next, researchJobIds: [...next.researchJobIds, job.id] });
}
const launchRecoveryId = id => `batch-launch-recovery-${hash(id).slice(0, 24)}`;
const launchChildId = id => `job-${hash({ launchRecovery: id }).slice(0, 20)}`;
function launchEvents(store, id) {
  // Full history, not store.events' recent-100 presentation window.
  return store.db.prepare('SELECT seq,record FROM factory_event WHERE job_id=? ORDER BY seq').all(id);
}
function guardEmptyLaunchFiles(store, job) {
  // Pre-launch failure must have NO cache, checkpoint, source/checker receipt,
  // unregistered output or additional attempt. Inspect names, never raw contents.
  const parts = path.resolve(store.stateRoot).split(path.sep).filter(Boolean);
  let current = path.parse(path.resolve(store.stateRoot)).root;
  for (const part of [...parts, 'jobs', job.id]) {
    current = path.join(current, part);
    let info; try { info = lstatSync(current); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('BATCH_RECOVERY_EVIDENCE', 'Launch evidence path is not an ordinary owned directory.');
  }
  const empty = (directory, allowedDirectory) => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry), info = lstatSync(full);
      if (entry !== allowedDirectory || !info.isDirectory() || info.isSymbolicLink()) fail('BATCH_RECOVERY_EVIDENCE', 'Retained output, source activity or an unsafe launch path prevents recovery.');
      empty(full, entry === 'attempt-0' ? 'sources' : null);
    }
  };
  empty(current, 'attempt-0');
}
function guardLaunchFailure(store, b, parent) {
  if (parent.kind !== 'discovery' || parent.campaignId !== b.campaignId || parent.state !== 'failed' || parent.stage !== 'research' || parent.errorCode !== 'E2BIG' || parent.attempt !== 0 || parent.retryLimit !== 0 || parent.ownerPid != null || hash(parent.outputs) !== hash({}) || hash(parent.input) !== hash({ batchId: b.id, round: 1, candidateLimit: Math.min(3, b.settings.candidateLimit), phase: 'discovery' })) fail('BATCH_RECOVERY_EVIDENCE', 'Only the exact first pre-launch E2BIG discovery failure is recoverable.');
  const events = launchEvents(store, parent.id).map(row => JSON.parse(row.record));
  if (hash(events.map(e => e.type)) !== hash(['job.created', 'job.started', 'stage.started', 'batch.usage_reserved', 'stage.failed', 'job.stopped'])) fail('BATCH_RECOVERY_EVIDENCE', 'Complete pre-launch failure and reservation history is required; additional work is not recoverable.');
  const reserved = events[3].detail;
  if (reserved.batchId !== b.id || reserved.unit !== 'modelRequests' || reserved.used !== 1 || reserved.cap !== b.settings.maxModelRequests || events[4].detail.errorCode !== 'E2BIG' || events[4].detail.attempt !== 0 || events[5].detail.errorCode !== 'E2BIG') fail('BATCH_RECOVERY_EVIDENCE', 'The retained host failure must prove one charged launch and pre-launch E2BIG.');
  if (store.db.prepare('SELECT 1 FROM factory_artifact WHERE job_id=? LIMIT 1').get(parent.id)) fail('BATCH_RECOVERY_EVIDENCE', 'Retained job artifacts prevent pre-launch recovery.');
  guardEmptyLaunchFiles(store, parent);
}
function recoveredLaunchParent(store, b, parent) {
  const receipt = parseRecord(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='batch_launch_recovery'").get(launchRecoveryId(b.id)));
  if (!receipt) return false;
  const { result, receiptDigest, ...bound } = receipt;
  if (!result || !receipt.previousStoppedBatch || !Array.isArray(receipt.previousStoppedBatch.researchJobIds) || !receipt.previousStoppedBatch.settings || !receipt.previousStoppedBatch.seedCohort) return false;
  if (hash(bound) !== receiptDigest || hash(result) !== receipt.resultDigest || receipt.batchId !== b.id || receipt.failedJobId !== parent.id || receipt.childJobId !== launchChildId(receipt.id) || receipt.parentJobDigest !== hash(parent) || receipt.parentEventsDigest !== hash(launchEvents(store, parent.id)) || receipt.previousStoppedBatchDigest !== hash(receipt.previousStoppedBatch)) return false;
  const before = receipt.previousStoppedBatch;
  if (before.id !== b.id || before.campaignId !== b.campaignId || before.state !== 'stopped' || before.round !== 1 || before.researchJobIds.length !== 1 || before.researchJobIds[0] !== parent.id || !b.processedResearchIds.includes(parent.id) || !b.researchJobIds.includes(receipt.childJobId) || hash(before.settings) !== hash(b.settings) || hash(before.seedCohort) !== hash(b.seedCohort) || before.deadlineAt !== b.deadlineAt) return false;
  const child = batchJobs(store, b.campaignId).find(j => j.id === receipt.childJobId);
  if (!child || child.kind !== 'discovery' || child.campaignId !== parent.campaignId || hash(child.input) !== hash(parent.input) || child.attempt !== 0 || child.retryLimit !== 0) return false;
  return b.policyHistory?.some(h => h.recoveryReceiptId === receipt.id && h.policyDigest === receipt.policyDigest && h.previousPolicyDigest === before.policyDigest && h.requestId === receipt.requestId) === true;
}
function recoverLaunch(store, input, currentPolicyDigest) {
  return transaction(store, () => {
    const receiptId = launchRecoveryId(input.id), old = replay(store, receiptId, input); if (old) return old.result;
    const b = getBatch(store, input.id), jobs = batchJobs(store, b.campaignId), parent = store.job(input.failedJobId);
    if (input.authorized !== true || input.policyDigest !== currentPolicyDigest) fail('BATCH_POLICY', 'Explicit current production policy acknowledgement is required for launch recovery.');
    if (b.state !== 'stopped' || b.settings.workflow !== 'leads_first' || !b.seedCohort || !b.acquisition || hash(b.acquisition) !== hash(acquisitionPolicy()) || b.round !== 1 || jobs.length !== 1 || jobs[0].id !== parent.id || hash(b.researchJobIds) !== hash([parent.id]) || b.processedResearchIds.length || b.members.length || b.selection || b.enrichmentJobId || b.firstCandidateId || b.checkpoint || Object.keys(b.exports).length) fail('BATCH_RECOVERY', 'Only an unused stopped seeded first discovery with unchanged completion reserves can receive one explicit launch recovery.');
    const campaign = store.campaign(b.campaignId), s = b.settings;
    if (campaign.model !== DEFAULT_FACTORY_MODEL || campaign.retryLimit !== 0 || campaign.concurrency !== 1 || campaign.autoBuild !== false || campaign.area !== s.area || campaign.niche !== s.niche || campaign.candidateLimit !== s.candidateLimit || campaign.buildLimit !== s.targetCount || campaign.deadlineMinutes !== s.jobMinutes) fail('BATCH_RECOVERY', 'Original campaign model, automatic-work limits and scope must remain unchanged.');
    if (hash(b.usage) !== hash({ modelRequests: 1, searches: 0, inspections: 0, imageViews: 0 }) || hash(b.discoveryUsage) !== hash({ searches: 0 })) fail('BATCH_RECOVERY_EVIDENCE', 'Original consumption must remain exactly one model reservation and zero source attempts.');
    if (store.db.prepare('SELECT 1 FROM factory_candidate WHERE campaign_id=? LIMIT 1').get(b.campaignId) || store.db.prepare("SELECT 1 FROM factory_operation WHERE json_extract(record,'$.batchId')=? OR json_extract(record,'$.jobId')=? LIMIT 1").get(b.id, parent.id)) fail('BATCH_RECOVERY_EVIDENCE', 'Persisted prospects or source/work receipts prevent pre-launch recovery.');
    if (store.db.prepare("SELECT 1 FROM factory_operation WHERE kind='batch' AND id<>? AND json_extract(record,'$.state') IN ('active','awaiting_selection','awaiting_first_review','held') LIMIT 1").get(b.id)) fail('BATCH_ACTIVE', 'Another open batch prevents recovery.');
    if (!Number.isFinite(Date.parse(b.deadlineAt)) || Date.now() >= Date.parse(b.deadlineAt)) fail('BATCH_DEADLINE', 'Original time allowance expired; recovery cannot reset it.');
    const capacity = discoveryAdmission(b); if (!capacity.available) fail('BATCH_COMPLETION_BUDGET', capacity.gaps[0]);
    const receipt = validateSeedReceipt(store, b.seedCohort, b.settings);
    const claim = parseRecord(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='seed_preparation'").get(receipt.id));
    const fields = ['id','digest','provider','retrievedAt','version','attribution','limitations','items'];
    if (claim?.claimedBatchId !== b.id || receipt.presetVersion !== b.presetVersion || fields.some(field => !Object.hasOwn(b.seedCohort, field) || hash(receipt[field]) !== hash(b.seedCohort[field]))) fail('SEED_RECEIPT', 'Full frozen seed provenance and exact original claim must remain unchanged.');
    guardLaunchFailure(store, b, parent);
    const at = now(), childJobId = launchChildId(receiptId);
    const recovery = { id: receiptId, kind: 'batch_launch_recovery', batchId: b.id, failedJobId: parent.id, childJobId, requestId: input.requestId, inputDigest: hash(input), policyDigest: currentPolicyDigest, previousStoppedBatch: b, previousStoppedBatchDigest: hash(b), parentJobDigest: hash(parent), parentEventsDigest: hash(launchEvents(store, parent.id)), at, authority: 'supplied_one_use_prelaunch_recovery_not_human_acceptance' };
    const batch = saveBatch(store, { ...b, state: 'active', phase: 'discovery', finishedAt: null, policyDigest: currentPolicyDigest, policyHistory: [...(b.policyHistory || []), { previousPolicyDigest: b.policyDigest, policyDigest: currentPolicyDigest, requestId: input.requestId, recoveryReceiptId: receiptId, at, authority: recovery.authority }], researchJobIds: [...b.researchJobIds, childJobId], processedResearchIds: [...b.processedResearchIds, parent.id], message: 'Explicit one-use pre-launch recovery queued within original allowances; failed work and stop history retained.' });
    // createJob hashes campaign/kind/input and would return the immutable parent.
    // This one fixed-ID child uses its EXACT input and the ordinary claim guard.
    const job = { id: childJobId, campaignId: b.campaignId, kind: 'discovery', input: parent.input, state: 'queued', stage: 'discovery', attempt: 0, retryLimit: 0, createdAt: at, updatedAt: at, message: 'Explicit one-use launch recovery queued; failed parent preserved', outputs: {}, ownerPid: null };
    guardBatchJob(store, job, { claiming: true });
    store.db.prepare('INSERT INTO factory_job VALUES(?,?,?,?)').run(job.id, job.campaignId, job.state, JSON.stringify(job));
    store.event(job.id, 'job.created', job.message, { recoveryReceiptId: receiptId, failedJobId: parent.id });
    const result = { batch, job, childJobId, recovery };
    const bound = { ...recovery, resultDigest: hash(result) };
    operationRecord(store, receiptId, 'batch_launch_recovery', { ...bound, receiptDigest: hash(bound), result });
    return result;
  });
}
export async function batchDispatch(store, name, input, { prerequisites } = {}) {
  requirePilot(store);
  if (name === 'lead_list') return leadList(store, input);
  if (name === 'batch_recover_launch') {
    const old = replay(store, launchRecoveryId(input.id), input); if (old) return old.result;
    const currentPolicyDigest = (await policyIdentity('production')).digest;
    return recoverLaunch(store, input, currentPolicyDigest);
  }
  const currentPolicyDigest = name === 'batch_build_selected' ? (await policyIdentity('production')).digest : null;
  if (name === 'batch_build_selected') return transaction(store, () => {
    const receiptId = `batch-select-${hash({ id: input.id, requestId: input.requestId }).slice(0, 24)}`, old = replay(store, receiptId, input); if (old) return old.result;
    const b = getBatch(store, input.id), m = b.members.find(m => m.candidateId === input.candidateId);
    if (b.settings.workflow !== 'leads_first' || b.state !== 'awaiting_selection' || b.phase !== 'selection' || b.selection || !m) fail('BATCH_SELECTION', 'Select a member of an unselected paused leads-first batch.');
    const jobs = batchJobs(store, b.campaignId);
    if (b.enrichmentJobId || b.firstCandidateId || jobs.some(j => j.kind === 'site' || j.input.phase === 'enrichment' || ['queued', 'running'].includes(j.state))) fail('BATCH_SELECTION', 'Selection requires no prior enrichment/site or active owned work.');
    if (input.policyDigest ? input.policyDigest !== currentPolicyDigest : b.policyDigest !== currentPolicyDigest) fail('BATCH_POLICY', 'Production policy changed. Inspect the repair and explicitly acknowledge currentPolicyDigest through advanced MCP/CLI selection; no work started.');
    if (Date.now() >= Date.parse(b.deadlineAt)) fail('BATCH_DEADLINE', 'Original time allowance expired.');
     if (b.usage.searches >= b.settings.maxSearches || b.usage.modelRequests >= b.settings.maxModelRequests || b.usage.inspections >= b.settings.maxInspections || b.usage.imageViews >= b.settings.maxImageViews) fail('BATCH_BUDGET', 'An original total allowance is exhausted; selection cannot reset it.');
     const capacity=completionCapacity(b);if(!capacity.available)fail('BATCH_COMPLETION_BUDGET',capacity.gaps[0]);
    const c = store.candidate(m.candidateId);
    if (!profileAnchors(c).length) fail('BATCH_SELECTION', 'No original valid public social profile anchor; inspect the saved source evidence before selecting.');
    if (c.campaignId !== b.campaignId || hash(c) !== input.evidenceDigest || m.evidenceDigest !== input.evidenceDigest) fail('STALE_EVIDENCE', 'The selected prospect evidence changed; refresh before selecting.');
    const prospect = prospectItem(store, b, m);
    if (suppressionFor(store, c) || existingEntity(store, c) || ['not_a_fit', 'needs_changes'].includes(m.disposition) || c.websiteCheck.status === 'official_site_found' || prospect.websiteStatus === 'independent_official_site' || prospect.buildUnsupported) fail('BATCH_SELECTION', 'Suppressed, duplicate, excluded or unsupported prospects cannot start production.');
    if (prospect.screening?.status !== 'clear_for_enrichment' || !prospect.canSelect) fail('BATCH_SCREENING', 'Early website/link-in-bio and geography screening is unresolved or expired. Inspect saved evidence; no enrichment was queued.');
    const at = now(), adoption = input.policyDigest && b.policyDigest !== currentPolicyDigest ? { policyDigest: currentPolicyDigest, policyHistory: [...(b.policyHistory || []), { previousPolicyDigest: b.policyDigest, policyDigest: currentPolicyDigest, requestId: input.requestId, candidateId: c.id, at, authority: 'supplied_selection_authority_not_human_acceptance' }] } : {};
    saveBatch(store, { ...b, ...adoption, members: b.members.map(v => v === m && adoption.policyDigest ? { ...v, ready: false, reasons: [...v.reasons, 'Selected: full new enrichment required before production.'] } : v), state: 'active', phase: 'enrichment', selection: { candidateId: c.id, evidenceDigest: input.evidenceDigest, requestId: input.requestId, at } });
    const job = store.createJob({ campaignId: b.campaignId, kind: 'discovery', input: { batchId: b.id, round: b.round, candidateLimit: 1, phase: 'enrichment', recheckCandidateId: c.id, selectionRequestId: input.requestId } });
    const batch = saveBatch(store, { ...getBatch(store, b.id), enrichmentJobId: job.id, researchJobIds: [...b.researchJobIds, job.id] });
    const result = { batch, job };
    operationRecord(store, receiptId, 'batch_selection', { inputDigest: hash(input), result }); return result;
  });
  if (name === 'batch_status') return batchStatus(store, input);
  if (name === 'batch_get') return batchGet(store, input.id, input);
  if (name === 'batch_readiness') return { ...(await prerequisites(batchPreset(store).settings)), presetAdopted: batchPreset(store).adopted, liveVerified: false, at: now() };
  if (name === 'batch_preset_save') return transaction(store, () => {
    const id = `preset-save-${hash(input.requestId).slice(0, 24)}`, old = replay(store, id, input); if (old) return old.preset;
    const previous = batchPreset(store); if (previous.version !== input.version) fail('STALE_PRESET', 'The saved setup changed. Refresh and reconcile instead of overwriting it.');
    const preset = { id: 'preset-houston', version: previous.version + 1, adopted: true, settings: input.settings, updatedAt: now(), authority: 'operator_supplied_setup_not_live_run_or_licence', inputDigest: hash(input) };
    operationRecord(store, preset.id, 'batch_preset', preset);
    operationRecord(store, id, 'batch_preset_revision', { inputDigest: hash(input), preset }); return preset;
  });
  if (name === 'batch_start') {
    const id = `batch-${hash(input.requestId).slice(0, 24)}`, old = replay(store, id, input); if (old) return old;
    const preset = batchPreset(store); if (!preset.adopted) fail('BATCH_SETUP', 'Save the one-time geography, categories, permitted source and usage setup first.');
    if (preset.version !== input.presetVersion) fail('STALE_PRESET', 'The preset changed. Review the current saved limits before starting.');
    const readiness = await prerequisites(preset.settings); if (!readiness.ready) fail('BATCH_READINESS', 'Required runtime or selected source is unavailable. Open readiness details; nothing was queued.');
    const policyDigest = (await policyIdentity('production')).digest;
    return transaction(store, () => {
      const old = replay(store, id, input); if (old) return old;
      if (batchPreset(store).version !== preset.version) fail('STALE_PRESET', 'Setup changed while checking readiness; nothing was queued.');
      if (store.db.prepare("SELECT 1 FROM factory_operation WHERE kind='batch' AND json_extract(record,'$.state') IN ('active','awaiting_selection','awaiting_first_review','held')").get()) fail('BATCH_ACTIVE', 'An active, paused or held batch already exists. Open or stop it before another run.');
      let seedCohort;
      if(input.seedReceipt){
        const s=preset.settings;
        const receipt=validateSeedReceipt(store,input.seedReceipt,s);
        const {provider,retrievedAt,version,attribution,limitations,items}=receipt;
        seedCohort={...input.seedReceipt,provider,retrievedAt,version,attribution,limitations,items};
        claimSeedReceipt(store,receipt,id);
      }
      const s = preset.settings, campaign = store.createCampaign({ name: `Houston private batch ${id.slice(-8)}`, area: s.area, niche: s.niche, query: `Identity-matched active ${s.niche} in ${s.area}; documented no-functioning-official-site checks; public business-posted photos and sourced contact`, candidateLimit: s.candidateLimit, buildLimit: s.targetCount, concurrency: 1, retryLimit: 0, deadlineMinutes: s.jobMinutes, autoBuild: false, model: DEFAULT_FACTORY_MODEL });
      const b = { id, kind: 'batch', inputDigest: hash(input), campaignId: campaign.id, presetVersion: preset.version, settings: s, policyDigest, ...(seedCohort?{seedCohort}:{}),state: 'active', phase: 'research',
        round: 0, researchJobIds: [], processedResearchIds: [], members: [], exports: {}, checkpoint: null, firstCandidateId: null,
         usage: { modelRequests: 0, searches: 0, inspections: 0, imageViews: 0 }, ...(s.workflow === 'leads_first' ? { acquisition:acquisitionPolicy(),discoveryUsage: { searches: 0 }, selection: null, enrichmentJobId: null } : {}), readiness: { ...readiness, liveVerified: false },
        createdAt: now(), updatedAt: now(), deadlineAt: new Date(Date.now() + s.batchMinutes * 60000).toISOString(), authority: 'operator_supplied_private_run', ...authority };
      operationRecord(store, id, 'batch', b); return queueResearch(store, b);
    });
  }
  if (name === 'batch_stop') return transaction(store, () => {
    const b = getBatch(store, input.id); if (['stopped', 'complete'].includes(b.state)) return b;
    cancelOwned(store, b); return finish(store, b, 'stopped', 'Stopped by request. Results, usage reservations and failed work are retained.');
  });
  if (name === 'batch_continue') {
    const b = getBatch(store, input.id);
    if (b.checkpoint) { if (b.checkpoint.inputDigest !== hash(input)) fail('IDEMPOTENCY_CONFLICT', 'A different checkpoint was already recorded.'); return b; }
    const j = store.job(input.siteJobId);
    if (!['awaiting_first_review', 'held'].includes(b.state) || j.campaignId !== b.campaignId || j.input.candidateId !== b.firstCandidateId || j.kind !== 'site' || j.state !== 'review_ready' || j.outputs.reviewStatus !== 'operator_review_required' || !j.outputs.qaPass) fail('BATCH_CHECKPOINT', 'Choose the complete review-ready first business site, not running, failed or unrelated work.');
    if (j.outputs.siteDigest !== input.siteDigest || hash(await treeHashes(path.join(store.stateRoot, safeRelative(j.outputs.siteRelative)))) !== input.siteDigest) fail('STALE_REVIEW', 'The first-site digest or bytes changed. Review the exact current work.');
    if ((await policyIdentity('production')).digest !== b.policyDigest) fail('STALE_BATCH_POLICY', 'Production policy changed; inspect rather than silently resume.');
    return transaction(store, () => {
      const current = getBatch(store, b.id); if (current.checkpoint) { if (current.checkpoint.inputDigest !== hash(input)) fail('IDEMPOTENCY_CONFLICT', 'Another checkpoint was recorded.'); return current; }
      if (!['awaiting_first_review', 'held'].includes(current.state) || Date.now() >= Date.parse(current.deadlineAt) || hash(store.job(j.id).outputs) !== hash(j.outputs) || suppressionFor(store, store.candidate(j.input.candidateId))) fail('BATCH_CHECKPOINT', 'The batch/site changed, expired or was suppressed during review.');
      const first = store.candidate(j.input.candidateId), member = current.members.find(m => m.candidateId === first.id);
      if (!memberEvidenceCurrent(member, first) || member.disposition === 'not_a_fit') fail('BATCH_FIRST_SITE_STALE', 'Current first-site evidence no longer matches the reviewed proposal, or the business is not a fit.');
      let members = current.members, exports = current.exports;
      if (member.disposition === 'needs_changes') {
        const noted = member.dispositionSiteJobId && store.db.prepare('SELECT rowid AS seq FROM factory_job WHERE id=?').get(member.dispositionSiteJobId);
        const chosen = store.db.prepare('SELECT rowid AS seq FROM factory_job WHERE id=?').get(j.id);
        if (!noted || chosen.seq <= noted.seq || !j.input.parentSiteJobId) fail('BATCH_FIRST_SITE_HELD', 'Review a newer completed correction before resolving the first-site changes hold.');
        members = members.map(m => { if (m !== member) return m; const { disposition, ...resolved } = m; return { ...resolved, changesResolvedBySiteJobId: j.id }; });
        const deferred = exports[j.id];
        // Release only this exact correction's resolved intake hold. Preserve the
        // rejection; genuine export failures and other versions stay untouched.
        if (deferred?.status === 'held' && deferred.code === 'BATCH_INTAKE') exports = { ...exports, [j.id]: { status: 'retry_after_checkpoint', previousAttempt: deferred } };
      }
      const checkpoint = { siteJobId: j.id, siteDigest: input.siteDigest, note: input.note, at: now(), inputDigest: hash(input), source: 'supplied_operator_checkpoint_authorization', humanDecision: null };
      store.event(j.id, 'batch.checkpoint_supplied', 'Supplied authorization to continue the capped batch; not human artifact acceptance', { batchId: b.id, siteDigest: input.siteDigest });
      return saveBatch(store, { ...current, members, exports, state: 'active', phase: 'production', checkpoint, message: 'First-site checkpoint supplied. Continuing only the saved remaining allowance.' });
    });
  }
  if (name === 'batch_item_note') return transaction(store, () => {
    const b = getBatch(store, input.id), m = b.members.find(m => m.candidateId === input.candidateId); if (!m) fail('BATCH_MEMBER', 'Candidate is not in this batch.');
    const id = `batch-note-${hash({ batchId: b.id, requestId: input.requestId }).slice(0, 24)}`, old = replay(store, id, input); if (old) return old;
    const { id: batchId, ...observation } = input;
    const entry = operationRecord(store, id, 'batch_item_note', { ...observation, batchId, inputDigest: hash(input), at: now(), source: 'supplied_feedback', humanDecision: null });
    if (input.disposition !== 'note') {
      for (const j of batchJobs(store, b.campaignId).filter(j => j.input.candidateId === m.candidateId && ['queued', 'running'].includes(j.state))) store.cancel(j.id);
    }
    const latestSite = batchJobs(store, b.campaignId).filter(j => j.kind === 'site' && j.input.candidateId === m.candidateId).at(-1);
    saveBatch(store, { ...b, members: b.members.map(v => v === m ? { ...v, ...(input.disposition !== 'note' ? { disposition: input.disposition, dispositionSiteJobId: latestSite?.id || null } : {}), note: input.note } : v) });
    return entry;
  });
  fail('UNKNOWN_OPERATION', 'Unsupported batch operation');
}

// Only the owned worker reconciles. GET/status must stay write-free.
export async function reconcileBatches(store, { promote } = {}) {
  if (!store.db.prepare("SELECT name FROM sqlite_master WHERE name='factory_operation'").get()) return false;
  const changesBefore = store.db.prepare('SELECT total_changes() n').get().n;
  const open = store.db.prepare("SELECT record FROM factory_operation WHERE kind='batch' AND json_extract(record,'$.state') IN ('active','awaiting_selection','awaiting_first_review','held') ORDER BY rowid").all().map(parseRecord);
  for (const initial of open) {
    let b = getBatch(store, initial.id), jobs = batchJobs(store, b.campaignId);
    if (Date.now() >= Date.parse(b.deadlineAt)) { transaction(store, () => { b = getBatch(store, b.id); cancelOwned(store, b); finish(store, b, 'complete', 'Time allowance expired. Finished work retained; remaining target is a shortfall.'); }); continue; }
    for (const j of jobs.filter(j => j.kind === 'discovery' && j.state === 'review_ready' && !b.processedResearchIds.includes(j.id))) {
      b = transaction(store, () => {
        const current = getBatch(store, b.id); if (current.processedResearchIds.includes(j.id)) return current;
        const members = [...current.members];
        for (const candidateId of j.outputs.candidateIds || []) {
          const memberIndex = members.findIndex(m => m.candidateId === candidateId);
          if (memberIndex >= 0 && !(current.settings.workflow === 'leads_first' && j.id === current.enrichmentJobId && candidateId === current.selection?.candidateId)) continue;
          const c = store.candidate(candidateId), evidence = j.outputs.intake?.find(m => m.candidateId === candidateId);
          const duplicate = c.campaignId !== b.campaignId || existingEntity(store, c), suppressed = suppressionFor(store, c);
          const reasons = [...(evidence?.reasons || ['Actual source/content/media/contact intake bindings are missing.']), ...(duplicate ? ['Existing or potentially matching business retained; no repeat build or automatic merge.'] : []), ...(suppressed ? ['Suppressed, lost or delivered business; no marketing production.'] : [])];
          const member = { candidateId, researchJobId: j.id, ready: evidence?.ready === true && !duplicate && !suppressed, reasons, evidenceDigest: hash(c), contacts: evidence?.contacts || [], discoveredAt: now(), ...(evidence?.prospect ? { prospect: evidence.prospect } : {}) };
          if (memberIndex >= 0) members[memberIndex] = { ...member, discoveredAt: members[memberIndex].discoveredAt, history: [...(members[memberIndex].history || []), members[memberIndex]] };
          else members.push(member);
        }
        return saveBatch(store, { ...current, members, processedResearchIds: [...current.processedResearchIds, j.id], lastShortfall: j.outputs.shortfall || null });
      });
    }
    for (const j of jobs.filter(j => j.kind === 'site' && j.state === 'review_ready' && (!b.exports[j.id] || b.exports[j.id].status === 'retry_after_checkpoint'))) {
      let exported; try { exported = await (promote || (await import('./promotion.mjs')).promoteReview)(store, j.id); }
      catch (e) { exported = { status: 'held', code: e.code || 'EXPORT_FAILED', note: 'Proposal retained; compatible library export needs inspection.' }; }
      b = transaction(store, () => { const current = getBatch(store, b.id), previousAttempt = current.exports[j.id]?.previousAttempt; return saveBatch(store, { ...current, exports: { ...current.exports, [j.id]: { ...exported, ...(previousAttempt ? { previousAttempt } : {}), recordedAt: now() } } }); });
    }
    b = getBatch(store, b.id); jobs = batchJobs(store, b.campaignId);
    if (b.state !== 'active') continue;
    try { guardBatchCheckpoint(store, b); } catch (e) { saveBatch(store, { ...b, state: 'held', message: e.message }); cancelOwned(store, b); continue; }
    if ((await policyIdentity('production')).digest !== b.policyDigest) { saveBatch(store, { ...b, state: 'held', message: 'Production policy changed. Inspect before resuming.' }); cancelOwned(store, b); continue; }
    if (jobs.some(j => j.kind === 'discovery' && ['failed', 'blocked', 'cancelled'].includes(j.state) && !recoveredLaunchParent(store, b, j))) {
      saveBatch(store, { ...b, state: 'held', phase: 'research', message: 'Research stopped. Results, failed attempts and usage are retained; no automatic retry.' }); continue;
    }
    if (jobs.some(j => ['queued', 'running'].includes(j.state))) continue;
    if (b.settings.workflow === 'leads_first' && !b.assistedIntake) {
       if (!b.selection) {
         const last = jobs.filter(j => j.kind === 'discovery').at(-1);
         const selectable = b.members.some(m => prospectItem(store, { ...b, state: 'awaiting_selection', phase: 'selection' }, m).canSelect);
         if(b.acquisition?.version===1&&selectable){saveBatch(store,{...b,state:'awaiting_selection',phase:'selection',message:'A materially plausible screened prospect is ready for exact selection. Further discovery stopped; fresh full intake still required.'});continue;}
         if (b.round < b.settings.maxResearchRounds && b.members.length < b.settings.candidateLimit && b.discoveryUsage.searches < b.settings.discoverySearchLimit && b.usage.modelRequests < b.settings.maxModelRequests && last?.outputs.candidateIds?.length) { transaction(store, () => queueResearch(store, getBatch(store, b.id))); continue; }
        saveBatch(store, { ...b, state: selectable ? 'awaiting_selection' : 'held', phase: selectable ? 'selection' : 'discovery', message: selectable ? 'Discovery paused. Select one saved prospect for full enrichment; no website work is authorized yet.' : 'Discovery finished with no prospect eligible for selection. Evidence and usage are retained; no enrichment, website, replacement or automatic retry.' }); continue;
      }
      const enriched = jobs.find(j => j.id === b.enrichmentJobId);
      if (!enriched || enriched.state !== 'review_ready' || !b.processedResearchIds.includes(enriched.id)) continue;
      if (!b.members.find(m => m.candidateId === b.selection.candidateId)?.ready) { saveBatch(store, { ...b, state: 'held', phase: 'enrichment', message: 'Exact selected prospect remains held after full intake. No replacement or automatic retry.' }); continue; }
      if (b.phase === 'enrichment') b = saveBatch(store, { ...b, phase: 'production' });
    }
    const firstReady = jobs.find(j => j.kind === 'site' && j.input.candidateId === b.firstCandidateId && j.state === 'review_ready');
    const initialSites = jobs.filter(j => j.kind === 'site' && !j.input.parentSiteJobId);
    if (!b.checkpoint && initialSites.length) {
      saveBatch(store, { ...b, state: firstReady ? 'awaiting_first_review' : 'held', phase: 'first_site_review', message: firstReady ? 'First complete site ready. Review actual desktop/phone work before continuing.' : 'First site needs attention. Failures retained; the other sites have not been built.' }); continue;
    }
    if (initialSites.length >= b.settings.targetCount) { finish(store, b, 'complete', `Finished within the ${b.settings.targetCount}-attempt ceiling. Failed/held work is not a completed site.`); continue; }
    if (b.usage.modelRequests >= b.settings.maxModelRequests || jobs.some(j => j.errorCode === 'BATCH_BUDGET')) { finish(store, b, 'complete', 'A saved usage allowance is exhausted. Existing work retained; no further production attempts queued.'); continue; }
    const next = b.members.find(m => m.ready && (!b.selection || m.candidateId === b.selection.candidateId) && !m.disposition && !initialSites.some(j => j.input.candidateId === m.candidateId));
    if (next) {
      transaction(store, () => {
        b = getBatch(store, b.id); if (b.state !== 'active') return;
        try {
          guardBatchJob(store, { campaignId: b.campaignId, kind: 'site', input: { candidateId: next.candidateId } });
          store.createJob({ campaignId: b.campaignId, kind: 'site', input: { candidateId: next.candidateId } });
          saveBatch(store, { ...b, firstCandidateId: b.firstCandidateId || next.candidateId, phase: 'production', message: 'Building one custom private website through the existing craft and QA workflow.' });
        } catch (e) {
          if (!/^BATCH_|^QUALIFICATION/.test(e.code || '')) throw e;
          saveBatch(store, { ...b, members: b.members.map(m => m.candidateId === next.candidateId ? { ...m, ready: false, reasons: [...m.reasons, e.message] } : m) });
        }
      }); continue;
    }
    if (b.settings.workflow === 'leads_first' || b.assistedIntake) { saveBatch(store, { ...b, state: 'held', message: 'Selected prospect cannot proceed. No replacement discovery is permitted.' }); continue; }
    const failedResearch = jobs.find(j => j.kind === 'discovery' && ['failed', 'blocked', 'cancelled'].includes(j.state));
    if (failedResearch || b.round >= b.settings.maxResearchRounds || b.members.length >= b.settings.candidateLimit || b.usage.searches >= b.settings.maxSearches || b.usage.modelRequests >= b.settings.maxModelRequests || b.usage.inspections >= b.settings.maxInspections || b.usage.imageViews >= b.settings.maxImageViews) {
      finish(store, b, 'complete', failedResearch ? 'Research stopped at a real source/model failure. Results and shortfall retained; no automatic retry.' : 'Discovery or usage allowance reached. Fewer suitable sites is an honest shortfall.'); continue;
    }
    const lastResearch = jobs.filter(j => j.kind === 'discovery').at(-1);
    if (lastResearch?.state === 'review_ready' && !(lastResearch.outputs.candidateIds || []).length) { finish(store, b, 'complete', 'No new candidates returned. Source shortfall retained; nothing fabricated to reach ten.'); continue; }
    transaction(store, () => { const current = getBatch(store, b.id); if (current.state === 'active') queueResearch(store, current); });
  }
  return store.db.prepare('SELECT total_changes() n').get().n !== changesBefore;
}
