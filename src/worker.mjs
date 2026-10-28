import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { now, hash, fail, FactoryError, publicResourceKey } from './contracts.mjs';
import { noLinks } from './db.mjs';
import { policyIdentity } from './policy.mjs';
import { workRelative } from './proposal.mjs';
import { withJobBudget } from './batch-budget.mjs';
import { batchForCampaign, guardBatchJob } from './batch-store.mjs';
import { reconcileBatches } from './batches.mjs';
import { relevantSearchEvidence } from './search.mjs';
import { profileAnchors } from './intake.mjs';

// Only a host-created, exact one-use continuation receipt may seed the cached
// prefix with its original policy. All execution guards still use today's batch.
async function continuationPolicy(store, job, batch, currentPolicy) {
  const binding = job.studyContinuation;
  if (job.kind !== 'site' || !binding) return currentPolicy.digest;
  const bad = () => fail('STUDY_CONTINUATION_BINDING', 'Exact host continuation receipt, original attempt/checkpoints and current production policy are required.');
  try {
    const receiptId = `study-continuation-${hash(job.id).slice(0, 24)}`;
    const row = store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='study_continuation'").get(receiptId);
    if (!row) bad();
    const r = JSON.parse(row.record), failed = r.failedJob, held = r.heldBatch;
    if (!batch || binding.receiptId !== receiptId || r.id !== receiptId || r.kind !== 'study_continuation' || r.jobId !== job.id || r.batchId !== batch.id ||
      !failed || failed.id !== job.id || failed.campaignId !== job.campaignId || failed.kind !== 'site' || failed.state !== 'blocked' || failed.errorCode !== 'DESIGN_STUDY_QA' || failed.stage !== 'directions-render' || failed.attempt !== 0 || job.attempt !== failed.attempt ||
      failed.deadlineAt !== job.deadlineAt || hash(failed.input) !== hash(job.input) || job.directionRepair || job.input.parentSiteJobId ||
      !held || held.id !== batch.id || held.campaignId !== batch.campaignId || held.deadlineAt !== batch.deadlineAt || held.createdAt !== batch.createdAt || hash(held.settings) !== hash(batch.settings) ||
      !/^[a-f0-9]{64}$/.test(held.policyDigest) || r.originalPolicyDigest !== held.policyDigest || binding.originalPolicyDigest !== held.policyDigest ||
      r.policyDigest !== currentPolicy.digest || binding.policyDigest !== currentPolicy.digest || batch.policyDigest !== currentPolicy.digest || hash(r.policyFiles) !== currentPolicy.digest ||
      binding.renderDigest !== r.renderDigest || r.inputDigest !== hash({ id: job.id, renderDigest: r.renderDigest, policyDigest: r.policyDigest, requestId: r.requestId, authorized: true }) ||
      !batch.policyHistory?.some(h => h.continuationReceiptId === receiptId && h.requestId === r.requestId && h.previousPolicyDigest === held.policyDigest && h.policyDigest === currentPolicy.digest)) bad();
    const root = path.join(store.stateRoot, workRelative(job));
    let dependency = hash({ dependency: hash({ jobId: job.id, input: failed.input, attempt: failed.attempt, campaign: store.campaign(job.campaignId) }), policy: held.policyDigest });
    for (const name of ['qualification', 'media', 'brief', 'directions', 'directions-render']) {
      const file = path.join(root, `checkpoint-${name}.json`); await noLinks(file);
      const bytes = await readFile(file), saved = JSON.parse(bytes), expected = r.checkpoints?.[name];
      if (!expected || hash(bytes) !== expected.fileSha256 || saved.dependency !== dependency || expected.dependency !== dependency || saved.sha256 !== expected.sha256 || hash(saved.value) !== saved.sha256) bad();
      dependency = saved.sha256;
    }
    const render = path.join(root, 'directions/results.json'); await noLinks(render);
    const artifact = store.artifacts(job.id).find(a => a.relative === `${workRelative(job)}/directions/results.json`);
    if (!artifact || artifact.sha256 !== r.renderDigest || hash(await readFile(render)) !== r.renderDigest) bad();
    return held.policyDigest;
  } catch (e) { if (e.code === 'STUDY_CONTINUATION_BINDING') throw e; bad(); }
}

export async function executeJob(store, jobId, adapters = {}) {
  return withJobBudget(store, jobId, () => executeOwnedJob(store, jobId, adapters));
}
async function executeOwnedJob(store, jobId, adapters) {
  let current = store.job(jobId); if (current.state !== 'queued') return current;
  try { current = store.claim(jobId); } catch (e) {
    if (e.code === 'ALREADY_CLAIMED') return store.job(jobId);
    if (/^BATCH_/.test(e.code || '')) { store.event(jobId, 'batch.claim_held', e.message, { errorCode: e.code }); return store.updateJob(jobId, { state: 'blocked', errorCode: e.code, message: e.message, ownerPid: null }); }
    throw e;
  }
  const campaign = current.campaignId ? store.campaign(current.campaignId) : null;
  const batch = batchForCampaign(store, current.campaignId);
  const jobRelative = workRelative(current);
  const jobRoot = path.join(store.stateRoot, jobRelative); await noLinks(jobRoot); await mkdir(jobRoot, { recursive: true, mode: 0o750 });
  const controller = new AbortController();
  const active = () => { const latest = store.job(jobId); return latest.attempt === current.attempt && latest.state === 'running'; };
  const deadline = new Date(Math.min(Date.parse(current.deadlineAt || new Date(Date.now() + (campaign?.deadlineMinutes || 10) * 60000).toISOString()), batch ? Date.parse(batch.deadlineAt) : Infinity)).toISOString();
  store.updateJob(jobId, { deadlineAt: deadline });
  const monitor = setInterval(() => { if (!active()) controller.abort(new FactoryError('CANCELLED', 'Job cancelled or attempt superseded')); else if (Date.now() >= Date.parse(deadline)) controller.abort(new FactoryError('DEADLINE', 'Job deadline elapsed')); else if (batch) { try { guardBatchJob(store, store.job(jobId), { claiming: true }); } catch (e) { controller.abort(e); } } }, 250);
  let dependency = hash({ jobId, input: current.input, attempt: current.attempt, campaign });
  const stage = async (name, fn) => {
    if (batch) guardBatchJob(store, store.job(jobId), { claiming: true });
    if (current.kind === 'site' && current.studyContinuation) await continuationPolicy(store, store.job(jobId), batchForCampaign(store, current.campaignId), await policyIdentity('production'));
    if (Date.now() >= Date.parse(deadline)) fail('DEADLINE', 'Job deadline elapsed; no further model/source work will run');
    if (controller.signal.aborted || !active()) fail('CANCELLED', 'Job cancelled or attempt superseded');
    store.updateJob(jobId, { stage: name, message: `Working: ${name}` });
    const file = path.join(jobRoot, `checkpoint-${name}.json`); let record;
    try { record = JSON.parse(await readFile(file, 'utf8')); if (record.dependency !== dependency || hash(record.value) !== record.sha256) fail('STALE_STAGE', 'Stage evidence changed or no longer matches its inputs'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!record) {
      store.event(jobId, 'stage.started', `Starting ${name}`);
      const started = performance.now();
      try {
        const value = await fn(); if (Date.now() >= Date.parse(deadline)) fail('DEADLINE', 'Job deadline elapsed'); if (controller.signal.aborted || !active()) fail('CANCELLED', 'Job cancelled or superseded; completed adapter output was not promoted');
        if (batch) guardBatchJob(store, store.job(jobId), { claiming: true });
        record = { dependency, value, sha256: hash(value), completedAt: now(), elapsedMs: Math.round(performance.now() - started) }; await writeFile(file, JSON.stringify(record), { flag: 'wx', mode: 0o640 }); store.event(jobId, 'stage.completed', `Completed ${name}`, { digest: record.sha256, elapsedMs: record.elapsedMs, providerCharge: 'unknown_not_inferred_from_time' });
      } catch (e) {
        store.event(jobId, 'stage.failed', `Stopped ${name}`, { elapsedMs: Math.round(performance.now() - started), attempt: current.attempt, errorCode: e.code || 'STAGE_FAILED', providerCharge: 'unknown_not_inferred_from_time' });
        throw e;
      }
    } else store.event(jobId, 'stage.resumed', `Reused completed ${name} checkpoint`);
    dependency = record.sha256; return record.value;
  };
  async function register(relative, kind, label) {
    const full = path.join(store.stateRoot, relative); await noLinks(full); const bytes = await readFile(full); return store.artifact({ jobId, relative, kind, label, bytes: bytes.length, sha256: hash(bytes) });
  }
  try {
    if (['site', 'qa'].includes(current.kind)) {
      const policy = await policyIdentity(current.kind === 'site' ? 'production' : 'qa');
      dependency = hash({ dependency, policy: await continuationPolicy(store, current, batch, policy) });
    }
    const context = { jobRoot, signal: controller.signal };
    if (current.kind === 'discovery') {
      const discovery = adapters.discover || (await import('./research.mjs')).discover;
      const recheck = current.input.recheckCandidateId ? store.candidate(current.input.recheckCandidateId) : null;
      if (batch?.settings.workflow === 'leads_first' && recheck && hash(recheck) !== batch.selection.evidenceDigest) fail('STALE_EVIDENCE', 'Selected evidence changed before enrichment.');
      const seen = batch ? store.db.prepare('SELECT record FROM factory_candidate ORDER BY rowid DESC LIMIT 100').all().map(r => JSON.parse(r.record)).filter(c => c.id !== recheck?.id).map(c => ({ name: c.name, area: c.area, instagram: c.contacts?.instagram, facebook: c.contacts?.facebook })) : [];
      const budget = batch ? { discoverySearchesRemaining: Math.max(0, (batch.settings.discoverySearchLimit || 0) - (batch.discoveryUsage?.searches || 0)), totalRemaining: Object.fromEntries(Object.entries({ modelRequests: 'maxModelRequests', searches: 'maxSearches', inspections: 'maxInspections', imageViews: 'maxImageViews' }).map(([unit, cap]) => [unit, Math.max(0, batch.settings[cap] - batch.usage[unit])])) } : null;
       const result = await stage('research', () => discovery(batch ? { ...campaign, candidateLimit: current.input.candidateLimit } : campaign, { ...context, recheck, batch: batch ? { settings: batch.settings, ...(batch.acquisition?{acquisition:batch.acquisition}:{}),phase: current.input.phase || 'research', round: batch.round, checkpoint: Boolean(batch.checkpoint), seen, budget } : null }));
      const intakeEvidence = batch ? await (await import('./intake.mjs')).readIntakeEvidence(path.join(jobRoot, 'sources')) : null;
      // Also enforce outside the stage callback: an old cached native research
      // answer must not bypass the source-coverage gate on a resumed job.
      if (batch && result.live === true) {
        const research=await import('./research.mjs');research.assertBatchSourceWorkflow(intakeEvidence.searches,batch.settings.searchProvider);
         await research.assertNativeResearchResult(result,{jobRoot,candidateLimit:current.input.candidateLimit,provider:batch.settings.searchProvider,evidence:intakeEvidence});
         (await import('./scout.mjs')).assertScoutWorkflow(store,jobId,result.candidates,intakeEvidence);
      }
      if (recheck && (result.candidates.length !== 1 || result.candidates[0].name.toLowerCase() !== recheck.name.toLowerCase())) fail('SOURCE_RECHECK', 'Follow-up must return the exact held business, not expand into another cohort');
      if (batch?.settings.workflow === 'leads_first' && recheck) {
        const updated = result.candidates[0];
        for (const field of ['instagram', 'facebook']) if (recheck.contacts?.[field] && updated.contacts?.[field] && publicResourceKey(recheck.contacts[field]) !== publicResourceKey(updated.contacts[field])) fail('SOURCE_RECHECK', 'Enrichment cannot silently switch the selected business social identity.');
        const originalAccounts = profileAnchors(recheck).filter(url => ['instagram', 'facebook'].some(field => publicResourceKey(updated.contacts?.[field]) === url) && profileAnchors(updated).includes(url));
        const anchored = intakeEvidence.observations.some(o => originalAccounts.includes(publicResourceKey(o.url)) && updated.inspectionIds?.includes(o.id) && !o.blocked && Number.isFinite(Date.parse(o.inspectedAt)) && Date.now() - Date.parse(o.inspectedAt) <= 7 * 86400000 && Date.parse(o.inspectedAt) <= Date.now() + 300000 && o.text?.length >= 250 && relevantSearchEvidence(`"${recheck.name}"`, [{ url: o.url, title: o.title, description: o.text }]));
        if (!anchored) fail('SOURCE_RECHECK', 'Selected original account identity remains unresolved: enrichment must retain at least one original social contact and bind its fresh unblocked identifying observation. Same-name replacement or an unproven cross-platform relationship is not sufficient.');
      }
      if (batch?.settings.workflow === 'leads_first' && recheck && hash(store.candidate(recheck.id)) !== batch.selection.evidenceDigest) fail('STALE_EVIDENCE', 'Selected evidence changed during enrichment.');
      const leads = recheck ? result.candidates.map(c => store.replaceCandidate(recheck.id, c, result.live ? 'native_public_recheck' : 'fixture')) : store.importCandidates(campaign.id, result.candidates, result.live ? 'native_public_research' : 'fixture');
      if (batch?.settings.workflow === 'leads_first' && recheck) {
        // replaceCandidate preserves identity/history, but optional old fields must
        // not silently survive into an intake based on this new source directory.
        for (const c of leads) {
          for (const field of ['activityEvidence', 'contactSources', 'pagePurposes']) if (!result.candidates[0][field]) delete c[field];
          store.db.prepare('UPDATE factory_candidate SET record=? WHERE id=?').run(JSON.stringify(c), c.id);
        }
      }
      let intake;
      if (batch) { const { assessIntake } = await import('./intake.mjs'); const { assessProspect } = await import('./prospects.mjs'); intake = leads.map(c => {
        const result={candidateId:c.id,...assessIntake(c,intakeEvidence)};
        if(batch.settings.workflow==='leads_first') {
          result.prospect=assessProspect(c,intakeEvidence,batch.settings);
          if(result.prospect.screening.status!=='clear_for_enrichment'){result.ready=false;result.reasons=[...new Set([...result.reasons,...result.prospect.screening.reasons])];}
        }
        return result;
      }); }
      store.updateJob(jobId, { outputs: { candidateIds: leads.map(c => c.id), shortfall: result.shortfall, live: result.live === true, observationCount: result.observationCount || 0, ...(intake ? { intake } : {}) }, message: `${leads.length} researched candidate(s); ${leads.filter(c => c.assessment.state === 'qualified').length} evidence-qualified. Batch intake has separate content/media/contact gates.`, state: 'review_ready', ownerPid: null });
      // Automatic campaign production remains bounded by buildLimit and actual qualification.
      if (campaign.autoBuild && batch?.settings.workflow !== 'leads_first') for (const lead of leads.filter(c => c.assessment.state === 'qualified').slice(0, campaign.buildLimit)) store.createJob({ campaignId: campaign.id, kind: 'site', input: { candidateId: lead.id } });
    } else if (current.kind === 'probe') {
      const { searchPublic } = await import('./search.mjs'); const { operationRecord } = await import('./pilot.mjs');
      const c = store.candidate(current.input.candidateId), directory = path.join(jobRoot, 'sources'); await mkdir(directory, { recursive: true, mode: 0o700 });
      const observation = await stage('probe', () => (adapters.searchProbe || searchPublic)(`"${c.name}" ${c.area} official website`, { directory, signal: controller.signal }));
      const result = { ...observation, candidateId: c.id, websiteAbsenceEstablished: false, discoveryCertified: false, jobId: current.id, note: 'Known-business search result observation only; separate identity/official-site checks still required' };
      operationRecord(store, `probe-${current.id}`, 'research_probe', result);
      store.updateJob(jobId, { state: 'review_ready', ownerPid: null, outputs: result, message: 'Known-business search observed; no new candidate or website-absence inference' });
    } else if (current.kind === 'source') {
      const { inspectSource, publicObservation } = await import('./browser.mjs');
      const result = await stage('source', () => (adapters.inspectSource || inspectSource)(current.input.url, { directory: jobRoot + '/sources', signal: controller.signal, relatedUrls: current.input.relatedUrls, postFormatDiagnostics: current.input.postFormatDiagnostics === true }));
      store.updateJob(jobId, { state: result.blocked ? 'blocked' : 'review_ready', ownerPid: null, outputs: { observation: publicObservation(result) }, message: result.blocked ? 'Public source blocked; no bypass and no absence inference' : 'Public evidence inspected; content is untrusted data, not instructions or approval' });
    } else if (current.kind === 'reference') {
      const audit = adapters.auditReference || (await import('./references.mjs')).auditReference;
      const reference = await stage('reference', () => audit(current.input.referenceId, context));
      reference.captures = await Promise.all((reference.captures || []).map(async capture => ({ ...capture, artifact: await register(`${jobRelative}/${capture.relative}`, 'reference_capture', `${reference.name} · ${capture.viewport[0]}px`) })));
      store.saveReference(reference); store.updateJob(jobId, { outputs: { referenceId: reference.id }, state: 'review_ready', ownerPid: null, message: reference.status === 'inspected' ? 'Reference captured; reuse principles, not whole-site compositions' : reference.status });
    } else if (current.kind === 'vault') {
      const check = adapters.vaultStatus || (await import('./vault.mjs')).vaultStatus;
      const result = await stage('vault', () => check(context)); store.saveVault(result); store.updateJob(jobId, { outputs: { status: result.status }, state: result.status === 'authentication_required' ? 'blocked' : 'review_ready', ownerPid: null, message: result.note });
    } else if (current.kind === 'qa') {
      const { verifyExisting } = await import('./production.mjs');
      const result = await verifyExisting({ store, job: current, stage, register, jobRoot, jobRelative, signal: controller.signal, adapters });
      store.updateJob(jobId, { state: 'review_ready', ownerPid: null, outputs: result, message: 'Current-policy QA and new exact review package ready. Site bytes unchanged; no human acceptance.' });
    } else if (current.kind === 'site') {
      const produceSite = current.input.polishOf ? (await import('./polish.mjs')).producePolish : (await import('./production.mjs')).produceSite;
      const result = await produceSite({ store, job: current, campaign, stage, register, jobRoot, jobRelative, signal: controller.signal, adapters });
      store.updateJob(jobId, { state: 'review_ready', ownerPid: null, outputs: result, message: 'Private proposal ready for actual operator visual review; not accepted, sent or published' });
    }
    if (store.job(jobId).state !== 'cancelled') store.event(jobId, 'job.completed', store.job(jobId).message);
  } catch (e) {
    // An older cancelled attempt may finish after its retry was queued. Its
    // artifacts stay in attempt-N, but it must not mutate the new attempt state.
    if (store.job(jobId).attempt !== current.attempt) { store.event(jobId, 'attempt.superseded', 'Prior worker stopped without changing its queued retry', { attempt: current.attempt }); return store.job(jobId); }
    if (e.privateDiagnostics) await writeFile(path.join(jobRoot, 'private-failure.json'), JSON.stringify(e.privateDiagnostics), { mode: 0o600 });
    if (current.kind === 'reference') { const ref = store.references().find(r => r.id === current.input.referenceId); if (ref) store.saveReference({ ...ref, status: ref.captures.length ? 'prior_capture_current_audit_failed' : 'capture_failed', lastFailedAt: now(), lastError: e.code || 'REFERENCE_FAILED' }); }
    const cancelled = store.job(jobId).state === 'cancelled';
    if (current.kind === 'probe') { const { operationRecord } = await import('./pilot.mjs'); operationRecord(store, `probe-${current.id}`, 'research_probe', { status: 'blocked', candidateId: current.input.candidateId, jobId: current.id, errorCode: e.code || 'PROBE_FAILED', at: now(), websiteAbsenceEstablished: false, discoveryCertified: false }); }
    const blocked = /^(BATCH_|SOURCE_|SEARCH_|MEDIA_|BROWSER_|INTERACTION_|CANDIDATE_CAP|QUALIFICATION|MODEL_|STALE_|QA_|DESIGN_|PROPOSAL_|REMOTE_RUNTIME|PRIVATE_DNS|DEADLINE)/.test(e.code || '');
    store.updateJob(jobId, { state: cancelled ? 'cancelled' : blocked ? 'blocked' : 'failed', ownerPid: null, message: cancelled ? 'Cancelled; prior artifacts preserved' : e.code ? e.message : 'Worker failed; inspect setup and retained stage evidence', errorCode: e.code || 'WORKER_FAILED' });
    store.event(jobId, 'job.stopped', store.job(jobId).message, { errorCode: e.code || 'WORKER_FAILED' });
  } finally { clearInterval(monitor); }
  return store.job(jobId);
}
export async function work(store, { adapters = {}, promote } = {}) {
  // One scheduler lease; job claims additionally use transactional DB locking.
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const lease = store.db.prepare("SELECT value FROM factory_meta WHERE key='worker'").get();
    if (lease) { let alive = true; try { process.kill(Number(lease.value), 0); } catch (e) { alive = e.code !== 'ESRCH'; } if (alive) { store.db.exec('ROLLBACK'); return; } }
    store.db.prepare("INSERT INTO factory_meta VALUES('worker',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(process.pid)); store.db.exec('COMMIT');
  } catch (e) { if (store.db.isTransaction) store.db.exec('ROLLBACK'); throw e; }
  try {
    store.recover();
    for (;;) {
      const advanced = await reconcileBatches(store, { promote });
      const jobs = store.queuedJobs();
      if (!jobs.length) {
        if (advanced) continue;
        // Atomic empty-check + lease release closes the enqueue-at-shutdown race.
        store.db.exec('BEGIN IMMEDIATE');
        const pending = store.db.prepare("SELECT 1 FROM factory_job WHERE state='queued' LIMIT 1").get();
        // A validated first-site continuation commits batch state before its
        // kick. That kick can see this still-live lease and return: include the
        // resumed batch in this atomic handoff check, not just queued jobs.
        const resumedBatch = store.db.prepare("SELECT name FROM sqlite_master WHERE name='factory_operation'").get() && store.db.prepare("SELECT 1 FROM factory_operation WHERE kind='batch' AND json_extract(record,'$.state')='active' LIMIT 1").get();
        if (!pending && !resumedBatch) store.db.prepare("DELETE FROM factory_meta WHERE key='worker' AND value=?").run(String(process.pid));
        store.db.exec('COMMIT'); if (!pending && !resumedBatch) break; else continue;
      }
      const chosen = [];
      for (const job of jobs) { const c = job.campaignId ? store.campaign(job.campaignId) : null; if (c && chosen.filter(j => j.campaignId === c.id).length >= c.concurrency) continue; chosen.push(job); if (chosen.length === 2) break; }
      await Promise.all(chosen.map(j => executeJob(store, j.id, adapters)));
    }
  } finally { store.db.prepare("DELETE FROM factory_meta WHERE key='worker' AND value=?").run(String(process.pid)); }
}
