import { fail, hash, now, assessEvidence } from './contracts.mjs';
import { validateSeedReceipt } from './seeds.mjs';
import { assertAssistedBinding } from './assisted-evidence.mjs';

export const OPEN_BATCH_STATES = ['active', 'awaiting_selection', 'awaiting_first_review', 'held'];
export const parseRecord = row => row ? JSON.parse(row.record) : null;
export function batchForCampaign(store, campaignId) {
  if (!campaignId || !store.db.prepare("SELECT name FROM sqlite_master WHERE name='factory_operation'").get()) return null;
  return parseRecord(store.db.prepare("SELECT record FROM factory_operation WHERE kind='batch' AND json_extract(record,'$.campaignId')=? LIMIT 1").get(campaignId));
}
export function getBatch(store, id) {
  const b = parseRecord(store.db.prepare("SELECT record FROM factory_operation WHERE kind='batch' AND id=?").get(id));
  if (!b) fail('NOT_FOUND', 'Batch not found'); return b;
}
export function saveBatch(store, b) {
  const next = { ...b, updatedAt: now() };
  store.db.prepare("UPDATE factory_operation SET record=? WHERE id=? AND kind='batch'").run(JSON.stringify(next), b.id);
  return next;
}
export function batchJobs(store, campaignId) {
  return store.db.prepare('SELECT record FROM factory_job WHERE campaign_id=? ORDER BY rowid').all(campaignId).map(parseRecord);
}
export const normalized = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function identity(c) {
  const contacts = Array.isArray(c.contacts) ? Object.fromEntries(c.contacts.filter(v => v?.url).map(v => [v.kind || v.label?.toLowerCase?.(), v.url])) : c.contacts || {};
  const socials = [contacts.instagram, contacts.facebook, ...(Array.isArray(c.contacts) ? c.contacts.map(v => v?.url) : [])].filter(Boolean).map(value => {
    try { const u = new URL(value); return u.hostname.replace(/^(www|m)\./, '') + u.pathname.replace(/\/+$/, '').toLowerCase(); } catch { return ''; }
  }).filter(v => /^(instagram|facebook)\.com\/.+/.test(v));
  return { name: normalized(c.name).replace(/\b(llc|inc|ltd)\b/g, '').trim(), area: normalized(c.area), phone: String(contacts.phone || '').replace(/\D/g, '').slice(-10), email: String(contacts.email || '').toLowerCase(), socials };
}
export function identitiesOverlap(a, b) {
  const x = identity(a), y = identity(b);
  return Boolean(x.socials.some(s => y.socials.includes(s)) || x.phone.length === 10 && x.phone === y.phone || x.email && x.email === y.email || x.name && x.name === y.name && (x.area === y.area || /houston/.test(x.area) && /houston/.test(y.area)));
}
export function suppressionFor(store, candidate) {
  const rows = store.db.prepare("SELECT c.record FROM factory_sales_case s JOIN factory_candidate c ON c.id=s.candidate_id WHERE json_extract(s.record,'$.suppressed')=1 OR json_extract(s.record,'$.stage') IN ('lost','delivered')").all();
  return rows.map(parseRecord).find(c => c.id === candidate.id || identitiesOverlap(c, candidate)) || null;
}
export function existingEntity(store, candidate, { excludeId = candidate.id } = {}) {
  const all = store.db.prepare('SELECT record FROM factory_candidate').all().map(parseRecord);
  return [...all.filter(c => c.id !== excludeId), ...store.businesses()].find(c => identitiesOverlap(c, candidate)) || null;
}
export function memberEvidenceCurrent(member, candidate) { return member?.ready === true && member.evidenceDigest === hash(candidate) && assessEvidence(candidate).state === 'qualified'; }
export function guardBatchCheckpoint(store, b) {
  if (!b.checkpoint) return;
  const first = store.candidate(b.firstCandidateId), member = b.members.find(m => m.candidateId === first.id), site = store.job(b.checkpoint.siteJobId);
  if (!memberEvidenceCurrent(member, first) || ['not_a_fit', 'needs_changes'].includes(member.disposition) || suppressionFor(store, first) || site.input.candidateId !== first.id || site.campaignId !== b.campaignId || site.state !== 'review_ready' || site.outputs.siteDigest !== b.checkpoint.siteDigest || !site.outputs.qaPass || site.outputs.reviewStatus !== 'operator_review_required') fail('BATCH_FIRST_SITE_STALE', 'The reviewed first-site evidence or hold state changed. Inspect the batch before any remaining production.');
}
export function guardBatchRegistration(store, job) {
  const b = batchForCampaign(store, job.campaignId); if (!b) return;
  if (!OPEN_BATCH_STATES.includes(b.state)) fail('BATCH_STOPPED', 'A closed/stopped batch cannot register a new library export. Original work is retained.');
  const c = store.candidate(job.input.candidateId), member = b.members.find(m => m.candidateId === c.id);
  if (suppressionFor(store, c)) fail('BATCH_SUPPRESSED', 'Suppressed/lost/delivered work cannot register a batch export.');
  if (!memberEvidenceCurrent(member, c) || ['not_a_fit', 'needs_changes'].includes(member.disposition)) fail('BATCH_INTAKE', 'Current batch evidence or a review hold prevents registration.');
  guardBatchCheckpoint(store, b);
}
export function guardBatchJob(store, job, { claiming = false } = {}) {
  const b = batchForCampaign(store, job.campaignId); if (!b) return;
  if (b.seedCohort) {
    const receipt = validateSeedReceipt(store, b.seedCohort, b.settings);
    const claim = parseRecord(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='seed_preparation'").get(receipt.id));
    const fields = ['id','digest','provider','retrievedAt','version','attribution','limitations','items'];
    if (claim?.claimedBatchId !== b.id || fields.some(field => !Object.hasOwn(b.seedCohort,field) || hash(receipt[field]) !== hash(b.seedCohort[field]))) fail('SEED_RECEIPT', 'Frozen seed provenance, identities or their exact batch claim changed; no work may start.');
  }
  const revision = job.kind === 'site' && Boolean(job.input.parentSiteJobId || job.directionRepair);
  const correction = revision && job.input.candidateId === b.firstCandidateId && ['awaiting_first_review', 'held'].includes(b.state);
  // A current-policy QA recheck of the exact held first-candidate site is read-only
  // with respect to the site bytes and does not extend generation allowances.
  const recheck = job.kind === 'qa' && ['awaiting_first_review', 'held'].includes(b.state) && typeof job.input.siteJobId === 'string' && (() => {
    const row = store.db.prepare('SELECT record FROM factory_job WHERE id=?').get(job.input.siteJobId);
    const site = row ? JSON.parse(row.record) : null;
    return site?.kind === 'site' && site.campaignId === b.campaignId && site.input.candidateId === b.firstCandidateId;
  })();
  if (b.state !== 'active' && !correction && !recheck) fail('BATCH_STOPPED', 'This batch is paused or stopped. Use its exact first-site checkpoint or inspect the held work; no extra job was started.');
  if (Date.now() >= Date.parse(b.deadlineAt)) fail('BATCH_DEADLINE', 'The approved batch time allowance expired; no new work may start.');
  guardBatchCheckpoint(store, b);
  if(b.assistedIntake&&job.kind!=='site'&&!recheck)fail('BATCH_CONTROL','Assisted production cannot launch source, discovery, enrichment or separate legacy jobs.');
  if (recheck) return;
  if (job.kind === 'discovery') {
    if (b.settings.workflow === 'leads_first') {
      if (job.input.phase === 'enrichment') {
        if (b.phase !== 'enrichment' || !b.selection || job.input.recheckCandidateId !== b.selection.candidateId || job.input.selectionRequestId !== b.selection.requestId || job.input.candidateLimit !== 1 || (b.enrichmentJobId && b.enrichmentJobId !== job.id) || claiming && b.enrichmentJobId !== job.id) fail('BATCH_SELECTION', 'Only the single selected exact enrichment job may run.');
        const c = store.candidate(b.selection.candidateId), m = b.members.find(m => m.candidateId === c.id);
        if (c.campaignId !== b.campaignId || hash(c) !== b.selection.evidenceDigest || !m || ['not_a_fit', 'needs_changes'].includes(m.disposition)) fail('BATCH_SELECTION', 'Selected prospect evidence or hold changed before enrichment.');
        if (suppressionFor(store, c)) fail('BATCH_SUPPRESSED', 'Selected prospect is suppressed.');
        if (existingEntity(store, c)) fail('BATCH_DUPLICATE', 'Selected prospect now matches an existing business.');
      } else if (b.phase !== 'discovery' || b.selection || job.input.phase !== 'discovery' || job.input.recheckCandidateId) fail('BATCH_SELECTION', 'Use the explicit prospect selection workflow.');
    }
    if (job.input.batchId !== b.id || job.input.round !== b.round || b.round > b.settings.maxResearchRounds || claiming && !b.researchJobIds.includes(job.id)) fail('BATCH_CONTROL', 'Batch discovery is coordinated by the saved workflow, not separate legacy research requests.');
    return;
  }
  if (job.kind !== 'site') fail('BATCH_CONTROL', 'Use the batch workflow; separate source, probe or QA jobs cannot extend its automatic allowance.');
  if (b.assistedIntake) assertAssistedBinding(store,b,job,{claiming});
  else if (b.settings.workflow === 'leads_first' && (!b.selection || b.selection.candidateId !== job.input.candidateId || !['production', 'first_site_review'].includes(b.phase) || !b.enrichmentJobId || !b.processedResearchIds.includes(b.enrichmentJobId))) fail('BATCH_SELECTION', 'Explicit selection and current full enrichment are required before website production.');
  const m = b.members.find(m => m.candidateId === job.input.candidateId), c = store.candidate(job.input.candidateId);
  if (!memberEvidenceCurrent(m, c) || m.disposition === 'not_a_fit' || m.disposition === 'needs_changes' && !revision) fail('BATCH_INTAKE', 'Current source/content/media/contact evidence does not qualify this batch member.');
  if (suppressionFor(store, c)) fail('BATCH_SUPPRESSED', 'This business or an identity-matched prior record is suppressed, lost or already delivered.');
  if (!revision && existingEntity(store, c)) fail('BATCH_DUPLICATE', 'An existing or possibly matching business requires review before new production. No records were merged.');
  const initial = batchJobs(store, b.campaignId).filter(j => j.kind === 'site' && !j.input.parentSiteJobId);
  if (!revision && !b.checkpoint && initial.some(j => j.id !== job.id)) fail('BATCH_CHECKPOINT', 'Review the first complete exact site and explicitly continue the batch before another build.');
}
