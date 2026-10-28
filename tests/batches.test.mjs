import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { createService, OPERATIONS } from '../src/service.mjs';
import { now, hash } from '../src/contracts.mjs';
import { treeHashes } from '../src/proposal.mjs';

export const settings = {
  area: 'Houston city limits', niche: 'Synthetic independent workshops', targetCount: 3,
  candidateLimit: 12, maxResearchRounds: 4, searchProvider: 'guest_bing',
  maxSearches: 24, maxInspections: 48, maxImageViews: 24, maxModelRequests: 30,
  batchMinutes: 360, jobMinutes: 30,
};
async function fixture(t, extra = {}) {
  const root = await mkdtemp('/tmp/factory-batches-');
  const options = { dbPath: path.join(root, 'db.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false,
    batchPrerequisites: async () => ({ ready: true, checks: [], liveVerified: false }), ...extra };
  await initialize(options); const store = openStore(options); t.after(() => store.close());
  const service = createService(store, options);
  return { root, options, store, service };
}
async function configured(t, extra) {
  const f = await fixture(t, extra);
  const preset = await f.service.dispatch('batch_preset_save', { version: 0, requestId: 'save-fixture-01', settings, acknowledged: true });
  return { ...f, preset };
}
async function readyFixtureSite(store, job, label = 'Synthetic first-site checkpoint') {
  const relative = `jobs/${job.id}/attempt-0/proposal-0/site`;
  await mkdir(path.join(store.stateRoot, relative), { recursive: true });
  await writeFile(path.join(store.stateRoot, relative, 'index.html'), '<h1>' + label + '</h1>');
  const siteDigest = hash(await treeHashes(path.join(store.stateRoot, relative)));
  return store.updateJob(job.id, { state: 'review_ready', outputs: { siteRelative: relative, siteDigest, qaPass: true, reviewStatus: 'operator_review_required', humanDecision: null, publicRelease: false } });
}
async function pausedFixture(t) {
  const f = await configured(t), b = await f.service.dispatch('batch_start', start), discovery = f.store.jobs()[0];
  const leads = [1, 2].map(n => f.store.saveCandidate(b.campaignId, { name: `Checkpoint fixture ${n}`, area: 'Houston', summary: 'Synthetic only', identityMatched: true, active: true, sourceUrls: ['https://fixture.example/'], facts: [{ text: 'Synthetic work', sourceUrl: 'https://fixture.example/' }], websiteCheck: { status: 'no_official_site_found', checkedAt: now(), queries: ['Synthetic name', 'Synthetic phone'] } }));
  const { saveBatch, getBatch } = await import('../src/batch-store.mjs');
  saveBatch(f.store, { ...getBatch(f.store, b.id), members: leads.map(c => ({ candidateId: c.id, ready: true, reasons: [], contacts: [], evidenceDigest: hash(c) })), processedResearchIds: [discovery.id] });
  f.store.updateJob(discovery.id, { state: 'review_ready', outputs: { candidateIds: leads.map(c => c.id) } });
  const first = await readyFixtureSite(f.store, f.store.createJob({ campaignId: b.campaignId, kind: 'site', input: { candidateId: leads[0].id } }));
  saveBatch(f.store, { ...getBatch(f.store, b.id), state: 'awaiting_first_review', firstCandidateId: leads[0].id, exports: { [first.id]: { status: 'synthetic_fixture_only' } } });
  return { ...f, b, leads, first, continuation: { id: b.id, siteJobId: first.id, siteDigest: first.outputs.siteDigest, note: 'Synthetic supplied continuation, not real human acceptance', reviewed: true } };
}
const start = { presetVersion: 1, requestId: 'start-fixture-01', authorized: true };

test('empty research outcomes derive from observed activity without rewriting historical batches', async t => {
  const { store, service } = await configured(t);
  const { getBatch, saveBatch } = await import('../src/batch-store.mjs');
  const b = await service.dispatch('batch_start', start), discovery = store.jobs()[0];
  store.updateJob(discovery.id, { state: 'review_ready', outputs: { candidateIds: [], shortfall: 'Synthetic technical model HOLD' } });
  const historical = saveBatch(store, { ...getBatch(store, b.id), state: 'complete', phase: 'complete', usage: { modelRequests: 1, searches: 0, inspections: 0, imageViews: 0 } });
  const before = store.db.prepare('SELECT total_changes() n').get().n;
  assert.equal((await service.dispatch('batch_get', { id: b.id })).batch.outcome.kind, 'research_not_run');
  assert.equal((await service.dispatch('batch_status')).items[0].outcome.kind, 'research_not_run');
  assert.deepEqual(getBatch(store, b.id), historical);
  assert.equal(store.db.prepare('SELECT total_changes() n').get().n, before);
  saveBatch(store, { ...historical, usage: { ...historical.usage, searches: 1 } });
  assert.equal((await service.dispatch('batch_get', { id: b.id })).batch.outcome.kind, 'no_business_qualified');
});

test('source workflow failures hold retained research rather than completing or retrying it', async t => {
  const { store, service } = await configured(t);
  const { getBatch, saveBatch } = await import('../src/batch-store.mjs');
  const { reconcileBatches } = await import('../src/batches.mjs');
  const b = await service.dispatch('batch_start', start), discovery = store.jobs()[0];
  const usage = { modelRequests: 1, searches: 0, inspections: 0, imageViews: 0 };
  saveBatch(store, { ...getBatch(store, b.id), usage });
  store.updateJob(discovery.id, { state: 'blocked', errorCode: 'SOURCE_WORKFLOW_UNUSED', message: 'Synthetic source workflow unused' });
  await reconcileBatches(store);
  const result = await service.dispatch('batch_get', { id: b.id });
  assert.equal(result.batch.state, 'held'); assert.equal(result.batch.outcome.kind, 'research_not_run');
  assert.deepEqual(result.batch.usage, usage); assert.equal(store.jobs().length, 1);
  await reconcileBatches(store); assert.equal(store.jobs().length, 1);
  assert.equal(store.job(discovery.id).errorCode, 'SOURCE_WORKFLOW_UNUSED');
});

test('saved-batch campaigns explicitly bind the verified Factory Fast route without changing the approved allowance', async t => {
  const { service, store } = await configured(t);
  const batch = await service.dispatch('batch_start', start);
  const campaign = store.campaign(batch.campaignId);
  assert.equal(campaign.model, 'openai/gpt-6.1-sol-fast');
  assert.deepEqual(batch.settings, settings);
  assert.equal(campaign.retryLimit, 0); assert.equal(campaign.concurrency, 1);
  assert.equal(store.jobs().length, 1);
});

test('first-site continuation rejects changed/invalid evidence and unresolved first-member holds', async t => {
  for (const change of ['facts', 'official_site', 'not_a_fit', 'needs_changes']) {
    const { store, service, b, leads, continuation } = await pausedFixture(t);
    if (change === 'facts' || change === 'official_site') await service.dispatch('candidate_evidence_import', { id: leads[0].id, evidence: { ...leads[0], ...(change === 'facts' ? { summary: 'Changed facts, old reviewed site' } : { websiteCheck: { ...leads[0].websiteCheck, status: 'official_site_found', url: 'https://fixture.example/' } }) } });
    else await service.dispatch('batch_item_note', { id: b.id, candidateId: leads[0].id, requestId: 'hold-first-' + change, disposition: change, note: 'Synthetic unresolved first-site hold' });
    await assert.rejects(service.dispatch('batch_continue', continuation), e => /^BATCH_/.test(e.code), change);
    assert.equal((await service.dispatch('batch_get', { id: b.id })).batch.checkpoint, null);
    assert.equal(store.jobs().filter(j => j.kind === 'site').length, 1);
  }
});

test('a needs-changes hold can continue only after an explicitly reviewed newer ready first-site version', async t => {
  const { service, store, b, leads, first, continuation } = await pausedFixture(t);
  await service.dispatch('batch_item_note', { id: b.id, candidateId: leads[0].id, requestId: 'first-site-changes', disposition: 'needs_changes', note: 'Synthetic correction requested for this exact first version' });
  await assert.rejects(service.dispatch('batch_continue', continuation), e => /^BATCH_/.test(e.code));
  const revision = await service.dispatch('revise_site', { id: first.id, siteDigest: first.outputs.siteDigest, feedback: 'Synthetic explicit correction, no real model run' });
  const next = await readyFixtureSite(store, revision, 'Synthetic corrected first version');
  const continued = await service.dispatch('batch_continue', { ...continuation, siteJobId: next.id, siteDigest: next.outputs.siteDigest });
  assert.equal(continued.checkpoint.siteJobId, next.id);
  assert.equal(continued.members.find(m => m.candidateId === leads[0].id).disposition, undefined);
  assert.equal(store.job(next.id).outputs.humanDecision, null);
});

test('resolved first-site correction exports once after its deferred hold, preserving the first version and rejection', async t => {
  const { packageReview } = await import('../src/package.mjs'), { promoteReview } = await import('../src/promotion.mjs');
  const { reconcileBatches } = await import('../src/batches.mjs');
  const { service, store, root, b, leads, first, continuation } = await pausedFixture(t);
  store.db.exec('CREATE TABLE business(id TEXT PRIMARY KEY,record TEXT NOT NULL,imported_at TEXT NOT NULL,refreshed_at TEXT,site_digest TEXT)');
  async function packageFixture(job) {
    const relative = `jobs/${job.id}/attempt-0`, jobRoot = path.join(store.stateRoot, relative), qa = { pass: true, siteHashes: await treeHashes(path.join(store.stateRoot, job.outputs.siteRelative)), coverage: 'Synthetic correction lifecycle only' };
    await mkdir(path.join(jobRoot, 'qa-0')); await writeFile(path.join(jobRoot, 'qa-0/results.json'), JSON.stringify(qa));
    await packageReview({ siteRoot: path.join(store.stateRoot, job.outputs.siteRelative), outputRoot: path.join(jobRoot, 'package'), candidate: leads[0], media: [], qa, design: { thesis: 'Synthetic' } });
    await writeFile(path.join(jobRoot, 'creative-brief.json'), '{}'); await writeFile(path.join(jobRoot, 'checkpoint-critique.json'), JSON.stringify({ value: { notes: ['Synthetic only'], humanDecision: null } }));
    return store.updateJob(job.id, { outputs: { ...job.outputs, qaRelative: relative + '/qa-0', packageRelative: relative + '/package' } });
  }
  let correctionAttempts = 0;
  const promote = async (s, id) => { if (id !== first.id) correctionAttempts++; return promoteReview(s, id, { deliverablesRoot: path.join(root, 'delivery') }); };
  await packageFixture(first);
  const original = await promote(store, first.id), originalHashes = await treeHashes(original.root);
  await service.dispatch('batch_item_note', { id: b.id, candidateId: leads[0].id, requestId: 'deferred-correction-note', disposition: 'needs_changes', note: 'Synthetic supplied correction request' });
  const revision = await service.dispatch('revise_site', { id: first.id, siteDigest: first.outputs.siteDigest, feedback: 'Synthetic correction only, no model runs' });
  const corrected = await packageFixture(await readyFixtureSite(store, revision, 'Synthetic reviewed correction'));
  await reconcileBatches(store, { promote });
  const rejected = (await service.dispatch('batch_get', { id: b.id })).batch.exports[corrected.id];
  assert.equal(rejected.code, 'BATCH_INTAKE'); assert.equal(correctionAttempts, 1);
  await reconcileBatches(store, { promote }); assert.equal(correctionAttempts, 1, 'An unresolved hold must not retry automatically');
  await service.dispatch('batch_continue', { ...continuation, siteJobId: corrected.id, siteDigest: corrected.outputs.siteDigest });
  await reconcileBatches(store, { promote });
  const exported = (await service.dispatch('batch_get', { id: b.id })).batch.exports[corrected.id];
  assert.equal(exported.id, original.id, 'The exact reviewed correction must register against the same curated business');
  assert.equal(exported.previousAttempt.code, 'BATCH_INTAKE');
  assert.equal(correctionAttempts, 2);
  await reconcileBatches(store, { promote }); assert.equal(correctionAttempts, 2, 'The released correction exports once, not in a retry loop');
  const record = store.businesses()[0];
  assert.equal(record.folders.concept, original.record.folders.concept);
  assert.ok(Object.values(record.folders).includes(exported.root));
  assert.deepEqual(record.states, original.record.states); assert.deepEqual(record.feedback, original.record.feedback);
  assert.deepEqual(await treeHashes(original.root), originalHashes);
  assert.equal(store.job(corrected.id).outputs.humanDecision, null);
});

test('resolving a first-site hold never silently retries a genuine export failure', async t => {
  const { reconcileBatches } = await import('../src/batches.mjs');
  const { service, store, b, leads, first, continuation } = await pausedFixture(t);
  await service.dispatch('batch_item_note', { id: b.id, candidateId: leads[0].id, requestId: 'genuine-export-failure-note', disposition: 'needs_changes', note: 'Synthetic supplied changes' });
  const revision = await service.dispatch('revise_site', { id: first.id, siteDigest: first.outputs.siteDigest, feedback: 'Synthetic correction only' });
  const corrected = await readyFixtureSite(store, revision, 'Synthetic corrected site with export failure');
  let attempts = 0;
  const promote = async () => { attempts++; throw Object.assign(new Error('Synthetic I/O export failure'), { code: 'EXPORT_FAILED' }); };
  await reconcileBatches(store, { promote });
  const rejected = (await service.dispatch('batch_get', { id: b.id })).batch.exports[corrected.id];
  await service.dispatch('batch_continue', { ...continuation, siteJobId: corrected.id, siteDigest: corrected.outputs.siteDigest });
  await reconcileBatches(store, { promote });
  assert.equal(attempts, 1);
  assert.deepEqual((await service.dispatch('batch_get', { id: b.id })).batch.exports[corrected.id], rejected);
});

test('first-site evidence invalidation after a checkpoint holds the remainder instead of silently spending through it', async t => {
  const { store, service, b, leads, continuation } = await pausedFixture(t);
  await service.dispatch('batch_continue', continuation);
  await service.dispatch('candidate_evidence_import', { id: leads[0].id, evidence: { ...leads[0], websiteCheck: { ...leads[0].websiteCheck, status: 'official_site_found', url: 'https://fixture.example/' } } });
  const { reconcileBatches } = await import('../src/batches.mjs');
  await reconcileBatches(store);
  assert.equal((await service.dispatch('batch_get', { id: b.id })).batch.state, 'held');
  assert.equal(store.jobs().filter(j => j.kind === 'site').length, 1);
});

test('the promotion boundary rejects stopped/suppressed batch registration even through legacy library_promote', async t => {
  const { packageReview } = await import('../src/package.mjs'), { promoteReview } = await import('../src/promotion.mjs');
  for (const restriction of ['stopped', 'suppressed']) {
    const { service, store, b, leads, first, root } = await pausedFixture(t);
    store.db.exec('CREATE TABLE business(id TEXT PRIMARY KEY,record TEXT NOT NULL,imported_at TEXT NOT NULL,refreshed_at TEXT,site_digest TEXT)');
    const relative = `jobs/${first.id}/attempt-0`, jobRoot = path.join(store.stateRoot, relative), qa = { pass: true, siteHashes: await treeHashes(path.join(store.stateRoot, first.outputs.siteRelative)), coverage: 'Synthetic boundary fixture' };
    await mkdir(path.join(jobRoot, 'qa-0')); await writeFile(path.join(jobRoot, 'qa-0/results.json'), JSON.stringify(qa));
    await packageReview({ siteRoot: path.join(store.stateRoot, first.outputs.siteRelative), outputRoot: path.join(jobRoot, 'package'), candidate: leads[0], media: [], qa, design: { thesis: 'Synthetic' } });
    await writeFile(path.join(jobRoot, 'creative-brief.json'), '{}'); await writeFile(path.join(jobRoot, 'checkpoint-critique.json'), JSON.stringify({ value: { notes: ['Synthetic only'], humanDecision: null } }));
    store.updateJob(first.id, { outputs: { ...first.outputs, qaRelative: relative + '/qa-0', packageRelative: relative + '/package' } });
    if (restriction === 'stopped') await service.dispatch('batch_stop', { id: b.id });
    else { const c = await service.dispatch('case_open', { candidateId: leads[0].id }); await service.dispatch('case_event', { id: c.id, requestId: 'suppress-export-fixture', kind: 'suppressed', note: 'Synthetic opt-out', occurredAt: now() }); }
    const expected = restriction === 'stopped' ? 'BATCH_STOPPED' : 'BATCH_SUPPRESSED';
    // Even the pre-fix regression writes only below the isolated fixture root.
    await assert.rejects(promoteReview(store, first.id, { deliverablesRoot: path.join(root, 'delivery') }), e => e.code === expected);
    await assert.rejects(service.dispatch('library_promote', { id: first.id }), e => e.code === expected);
    assert.equal(store.businesses().length, 0);
  }
});

test('batch home reads without writes and has an unadopted setup, no fake provider verification', async t => {
  const { store, service } = await fixture(t);
  const before = store.db.prepare('SELECT total_changes() n').get().n;
  const s = await service.dispatch('batch_status');
  assert.equal(s.preset.version, 0); assert.equal(s.preset.adopted, false);
  assert.equal(s.preset.settings.niche, ''); assert.equal(s.items.length, 0);
  assert.equal(s.authority.contactAuthorized, false); assert.equal(s.authority.publicRelease, false);
  assert.equal(store.db.prepare('SELECT total_changes() n').get().n, before);
  await assert.rejects(service.dispatch('batch_start', start), e => e.code === 'BATCH_SETUP');
  assert.equal(store.jobs().length, 0);
});

test('saved setup is strict, versioned, request-idempotent and preserves the original record', async t => {
  const { store, service, preset } = await configured(t);
  assert.equal(preset.adopted, true); assert.equal(preset.version, 1);
  assert.deepEqual(await service.dispatch('batch_preset_save', { version: 0, requestId: 'save-fixture-01', settings, acknowledged: true }), preset);
  await assert.rejects(service.dispatch('batch_preset_save', { version: 0, requestId: 'save-fixture-01', settings: { ...settings, niche: 'Changed' }, acknowledged: true }), e => e.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(service.dispatch('batch_preset_save', { version: 0, requestId: 'save-fixture-02', settings, acknowledged: true }), e => e.code === 'STALE_PRESET');
  await assert.rejects(service.dispatch('batch_preset_save', { version: 1, requestId: 'save-fixture-03', settings: { ...settings, apiKey: 'not-a-real-key' }, acknowledged: true }), e => e.code === 'INVALID_INPUT');
  const next = await service.dispatch('batch_preset_save', { version: 1, requestId: 'save-fixture-04', settings: { ...settings, targetCount: 2 }, acknowledged: true });
  assert.equal(next.version, 2); assert.equal(store.campaigns().length, 0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM factory_operation WHERE kind='batch_preset_revision'").get().n, 2);
});

test('start is atomic, single-active and replayable across connections and terminal response loss', async t => {
  const { store, service, options } = await configured(t);
  const second = openStore(options); t.after(() => second.close());
  const svc2 = createService(second, options);
  const first = await service.dispatch('batch_start', start);
  assert.equal(first.state, 'active'); assert.equal(first.settings.targetCount, 3);
  assert.equal((await svc2.dispatch('batch_start', start)).id, first.id);
  assert.equal(store.jobs().length, 1); assert.equal(store.jobs()[0].kind, 'discovery');
  const campaign = store.campaign(first.campaignId);
  assert.equal(campaign.autoBuild, false); assert.equal(campaign.retryLimit, 0); assert.equal(campaign.concurrency, 1);
  await assert.rejects(svc2.dispatch('batch_start', { ...start, requestId: 'start-fixture-02' }), e => e.code === 'BATCH_ACTIVE');
  await assert.rejects(svc2.dispatch('batch_start', { ...start, presetVersion: 0 }), e => e.code === 'IDEMPOTENCY_CONFLICT');
  await service.dispatch('batch_stop', { id: first.id });
  assert.equal((await svc2.dispatch('batch_start', start)).state, 'stopped');
  assert.equal(store.campaigns().length, 1);
});

test('failed preflight and stale setup do not create queued jobs or adopt a provider', async t => {
  const { service, store } = await configured(t, { batchPrerequisites: async () => ({ ready: false, checks: [{ name: 'search', status: 'needs_configuration' }] }) });
  await assert.rejects(service.dispatch('batch_start', { ...start, presetVersion: 2 }), e => e.code === 'STALE_PRESET');
  await assert.rejects(service.dispatch('batch_start', start), e => e.code === 'BATCH_READINESS');
  assert.equal(store.jobs().length, 0); assert.equal(store.campaigns().length, 0);
});

test('batch stops only its owned queued/running work, retains all history and frozen settings', async t => {
  const { service, store } = await configured(t);
  const b = await service.dispatch('batch_start', start);
  const otherCampaign = store.createCampaign({ name: 'Unrelated existing work', area: 'Houston', niche: 'Fixture', query: 'Synthetic' });
  const other = store.createJob({ campaignId: otherCampaign.id, kind: 'discovery' });
  store.claim(store.jobs().find(j => j.campaignId === b.campaignId).id);
  const stopped = await service.dispatch('batch_stop', { id: b.id });
  assert.equal(stopped.state, 'stopped'); assert.equal(store.job(other.id).state, 'queued');
  assert.equal(store.jobs().find(j => j.campaignId === b.campaignId).state, 'cancelled');
  assert.deepEqual(stopped.settings, settings);
  assert.deepEqual(await service.dispatch('batch_stop', { id: b.id }), stopped);
  await assert.rejects(service.dispatch('discover', { campaignId: b.campaignId }), e => /^BATCH_/.test(e.code));
});

test('read tools are annotated read-only and every new mutation has a strict schema', () => {
  for (const n of ['batch_status', 'batch_get', 'batch_readiness']) assert.equal(OPERATIONS[n]?.readOnly, true, n);
  for (const n of ['batch_preset_save', 'batch_start', 'batch_stop', 'batch_continue', 'batch_item_note']) {
    assert.equal(OPERATIONS[n]?.readOnly, false, n);
    assert.equal(OPERATIONS[n].schema.safeParse({ unexpected: true }).success, false);
  }
});

test('persistent reservations consume failed attempts and cannot escape an allowance after restart', async t => {
  const { reserveBatchUsage } = await import('../src/batch-budget.mjs');
  const { service, store, options } = await configured(t);
  const b = await service.dispatch('batch_start', start), job = store.jobs()[0];
  for (let n = 0; n < settings.maxSearches; n++) reserveBatchUsage(store, job.id, 'searches');
  const second = openStore(options); t.after(() => second.close());
  assert.throws(() => reserveBatchUsage(second, job.id, 'searches'), e => e.code === 'BATCH_BUDGET');
  assert.equal((await service.dispatch('batch_get', { id: b.id })).batch.usage.searches, settings.maxSearches);
  await service.dispatch('batch_stop', { id: b.id });
  assert.throws(() => reserveBatchUsage(second, job.id, 'modelRequests'), e => e.code === 'BATCH_STOPPED');
});

test('source tools are bound to one owned source root and cannot switch provider or collect Maps', async t => {
  const { sourceJobPolicy } = await import('../src/batch-budget.mjs');
  const { service, store } = await configured(t); await service.dispatch('batch_start', start);
  const job = store.jobs()[0], directory = path.join(store.stateRoot, 'jobs', job.id, 'attempt-0', 'sources');
  assert.throws(() => sourceJobPolicy(store, job.id, directory + '/other'), e => e.code === 'BATCH_SOURCE_BINDING');
  const p = sourceJobPolicy(store, job.id, directory);
  assert.throws(() => p.reserve('searches', { provider: 'firecrawl' }), e => e.code === 'SOURCE_POLICY');
  assert.throws(() => p.reserve('inspections', { url: 'https://www.google.com/maps/place/fixture' }), e => e.code === 'SOURCE_POLICY');
  assert.equal((await service.dispatch('batch_get', { id: store.db.prepare("SELECT id FROM factory_operation WHERE kind='batch'").get().id })).batch.usage.searches, 0);
});

test('inbox notes remain visible, idempotent and paginated, and unrecorded costs are unknown rather than free', async t => {
  const { getBatch, saveBatch } = await import('../src/batch-store.mjs');
  const { store, service } = await configured(t), b = await service.dispatch('batch_start', start);
  const c = store.saveCandidate(b.campaignId, { name: 'Note fixture', area: 'Houston', summary: 'Synthetic only' });
  saveBatch(store, { ...getBatch(store, b.id), members: [{ candidateId: c.id, ready: false, reasons: ['Synthetic hold'], contacts: [] }] });
  const input = { id: b.id, candidateId: c.id, requestId: 'note-fixture-000', disposition: 'note', note: 'Literal supplied note <script>data</script>' };
  const first = await service.dispatch('batch_item_note', input);
  assert.deepEqual(await service.dispatch('batch_item_note', input), first);
  for (let n = 1; n < 4; n++) await service.dispatch('batch_item_note', { ...input, requestId: 'note-fixture-00' + n, note: 'Note ' + n });
  const detail = await service.dispatch('batch_get', { id: b.id, offset: 0, limit: 2 });
  assert.equal(detail.noteHistory.total, 4); assert.equal(detail.noteHistory.nextOffset, 2);
  assert.equal(detail.items[0].note, 'Note 3'); assert.equal(detail.costs.coverage, 'not_recorded'); assert.equal(detail.costs.reportedTotalCents, null);
  const older = await service.dispatch('batch_get', { id: b.id, offset: 2, limit: 2 });
  assert.ok(older.noteHistory.items.some(n => n.note === input.note));
  await service.dispatch('cost_record', { campaignId: b.campaignId, requestId: 'batch-cost-fixture', stage: 'research', cashCents: 350, minutes: 0, hourlyRateCents: 0 });
  const charged = await service.dispatch('batch_get', { id: b.id });
  assert.equal(charged.costs.coverage, 'partial_operator_reported'); assert.equal(charged.costs.reportedTotalCents, 350); assert.equal(charged.costs.verifiedPaidSales, null);
});

test('scheduler builds only one first site, rejects legacy bypass and continues only exact supplied checkpoint', async t => {
  const { reconcileBatches } = await import('../src/batches.mjs');
  const { saveBatch, getBatch } = await import('../src/batch-store.mjs');
  const { service, store } = await configured(t), b = await service.dispatch('batch_start', start);
  const discovery = store.jobs()[0];
  const leads = [1, 2].map(n => store.saveCandidate(b.campaignId, {
    name: `Synthetic workshop ${n}`, area: 'Houston', summary: 'Only a synthetic lifecycle fixture', identityMatched: true, active: true,
    sourceUrls: ['https://workshop.example/'], facts: [{ text: 'Synthetic offer', sourceUrl: 'https://workshop.example/' }],
    websiteCheck: { status: 'no_official_site_found', queries: ['fixture name', 'fixture phone'], checkedAt: now() },
  }));
  store.updateJob(discovery.id, { state: 'review_ready', outputs: { candidateIds: leads.map(c => c.id), intake: leads.map(c => ({ candidateId: c.id, ready: true, reasons: [], evidenceDigest: hash(c), contacts: [] })), shortfall: 'Synthetic only' } });
  await reconcileBatches(store, { promote: async () => ({ status: 'fixture_not_exported' }) });
  let sites = store.jobs().filter(j => j.kind === 'site'); assert.equal(sites.length, 1);
  await assert.rejects(service.dispatch('build_site', { candidateId: leads[1].id }), e => e.code === 'BATCH_CHECKPOINT');
  await assert.rejects(service.dispatch('discover', { campaignId: b.campaignId }), e => /^BATCH_/.test(e.code));
  const site = sites[0], relative = `jobs/${site.id}/attempt-0/proposal-0/site`;
  await mkdir(path.join(store.stateRoot, relative), { recursive: true });
  await writeFile(path.join(store.stateRoot, relative, 'index.html'), '<h1>Synthetic checkpoint only</h1>');
  const digest = hash(await treeHashes(path.join(store.stateRoot, relative)));
  store.updateJob(site.id, { state: 'review_ready', outputs: { siteRelative: relative, siteDigest: digest, qaPass: true, reviewStatus: 'operator_review_required', humanDecision: null, publicRelease: false } });
  await reconcileBatches(store, { promote: async () => ({ status: 'fixture_not_exported' }) });
  assert.equal(getBatch(store, b.id).state, 'awaiting_first_review');
  const input = { id: b.id, siteJobId: site.id, siteDigest: digest, note: 'Synthetic supplied checkpoint, not human acceptance', reviewed: true };
  await assert.rejects(service.dispatch('batch_continue', { ...input, siteDigest: '0'.repeat(64) }), e => e.code === 'STALE_REVIEW');
  const continued = await service.dispatch('batch_continue', input);
  assert.equal(continued.state, 'active'); assert.equal(continued.checkpoint.humanDecision, null);
  assert.equal(store.job(site.id).outputs.humanDecision, null);
  assert.equal((await service.dispatch('batch_continue', input)).checkpoint.siteDigest, digest);
  const heldDetails = await service.dispatch('batch_get', { id: b.id });
  assert.equal(heldDetails.batch.counts.ready, 1);
  await reconcileBatches(store, { promote: async () => ({ status: 'fixture_not_exported' }) });
  assert.equal(store.jobs().filter(j => j.kind === 'site').length, 2);
  // A batch's settings are frozen even if the saved preset is later changed.
  const frozen = getBatch(store, b.id); saveBatch(store, { ...frozen, state: 'stopped' });
  const old = store.candidate(leads[0].id);
  store.replaceCandidate(old.id, { ...old, websiteCheck: { ...old.websiteCheck, checkedAt: '2020-01-01T00:00:00Z' } }, 'fixture_changed_evidence');
  const stale = await service.dispatch('batch_get', { id: b.id });
  assert.equal(stale.batch.counts.ready, 0); assert.equal(stale.items.find(m => m.candidate.id === old.id).contact.draft, null);
  assert.equal(stale.items.find(m => m.candidate.id === old.id).ready, false);
});
