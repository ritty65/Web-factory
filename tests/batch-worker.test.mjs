import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { executeJob, work } from '../src/worker.mjs';
import { getBatch, saveBatch } from '../src/batch-store.mjs';
import { batchSettings, intakeFixture } from './helpers-batch.mjs';
import { hash, now } from '../src/contracts.mjs';
import { detailsContract } from './helpers-interaction.mjs';
import { treeHashes } from '../src/proposal.mjs';
import { promoteReview } from '../src/promotion.mjs';

async function fixture(t, settings = {}) {
  const root = await mkdtemp('/tmp/factory-batch-worker-'), options = { dbPath: path.join(root, 'db.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false, batchPrerequisites: async () => ({ ready: true }) };
  await initialize(options); const store = openStore(options); t.after(() => store.close());
  const service = createService(store, options);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'worker-preset-01', settings: { ...batchSettings, ...settings }, acknowledged: true });
  const batch = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'worker-start-01', authorized: true });
  return { store, options, service, batch };
}
async function discoverFixture(campaign, { jobRoot, batch }) {
  const f = intakeFixture(batch?.round || 1), directory = path.join(jobRoot, 'sources'); await mkdir(directory, { recursive: true });
  for (const o of f.observations) await writeFile(path.join(directory, o.id + '.json'), JSON.stringify(o));
  for (const s of f.searches) await writeFile(path.join(directory, `search-${hash(s.query).slice(0, 16)}.json`), JSON.stringify(s));
  for (const v of f.imageViews) await writeFile(path.join(directory, `image-view-${hash(v).slice(0, 16)}.json`), JSON.stringify(v));
  return { candidates: [f.candidate], live: false, observationCount: 1, shortfall: 'Synthetic boundary fixture only' };
}
test('real scheduler consumes actual fixture intake receipts, saves failure and pauses before the other sites', async t => {
  const { store, batch } = await fixture(t);
  let buildCalls = 0;
  await work(store, { adapters: { discover: discoverFixture, prepareMedia: async () => { buildCalls++; throw Object.assign(new Error('Synthetic inaccessible media'), { code: 'MEDIA_RESPONSE' }); } } });
  const b = getBatch(store, batch.id);
  assert.equal(buildCalls, 1); assert.equal(b.members.length, 1); assert.equal(b.members[0].ready, true, b.members[0].reasons.join('\n'));
  assert.equal(b.state, 'held'); assert.equal(store.jobs().filter(j => j.kind === 'site').length, 1);
  assert.equal(store.jobs().find(j => j.kind === 'site').errorCode, 'MEDIA_RESPONSE');
  assert.equal(store.db.prepare("SELECT value FROM factory_meta WHERE key='worker'").get(), undefined);
});
test('empty supply completes honestly without a website or unbounded repeated research', async t => {
  const { store, batch } = await fixture(t);
  await work(store, { adapters: { discover: async () => ({ candidates: [], live: false, shortfall: 'Synthetic source unavailable' }) } });
  assert.equal(getBatch(store, batch.id).state, 'complete');
  assert.equal(store.jobs().length, 1); assert.equal(getBatch(store, batch.id).lastShortfall, 'Synthetic source unavailable');
});
test('source/model failure is retained and cannot turn into retry or build-ready success', async t => {
  const { store, batch } = await fixture(t);
  await work(store, { adapters: { discover: async () => { throw Object.assign(new Error('Synthetic source block'), { code: 'SEARCH_BLOCKED' }); } } });
  assert.equal(getBatch(store, batch.id).state, 'held'); assert.equal(store.jobs().length, 1);
  assert.equal(store.jobs()[0].state, 'blocked');
});
test('expiry and suppression between enqueue and claim stop owned work without crashing the scheduler', async t => {
  const { store, batch } = await fixture(t), discovery = store.jobs()[0];
  saveBatch(store, { ...getBatch(store, batch.id), deadlineAt: '2020-01-01T00:00:00.000Z' });
  const result = await executeJob(store, discovery.id, { discover: () => { throw new Error('Must not run'); } });
  assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'BATCH_DEADLINE');
});
test('a restarted service resumes durable coordination, not a second batch or source flight', async t => {
  const { store, options, batch } = await fixture(t), second = openStore(options); t.after(() => second.close());
  await work(second, { adapters: { discover: async () => ({ candidates: [], live: false, shortfall: 'Resumed fixture' }) } });
  assert.equal(getBatch(store, batch.id).state, 'complete'); assert.equal(store.jobs().length, 1);
});
test('an existing spelling/social alias is held without merging or rebuilding the prior business', async t => {
  const { store, batch } = await fixture(t);
  const c = store.createCampaign({ name: 'Older synthetic', area: 'Houston', niche: 'Fixture', query: 'Synthetic' });
  const f = intakeFixture(), old = store.saveCandidate(c.id, { ...f.candidate, name: 'JUNIPER 1 UPHOLSTERY LLC' });
  await work(store, { adapters: { discover: (campaign, ctx) => discoverFixture(campaign, { ...ctx, batch: { round: 1 } }) } });
  const b = getBatch(store, batch.id);
  assert.equal(b.members[0].ready, false); assert.match(b.members[0].reasons.join(' '), /matching business/);
  assert.equal(store.jobs().filter(j => j.kind === 'site').length, 0);
  assert.deepEqual(store.candidate(old.id), old);
});

test('actual craft/package scheduler path pauses its first complete fixture and then finishes the capped remainder with compatible exports', async t => {
  const { store, batch, service, options } = await fixture(t, { maxResearchRounds: 3 });
  store.db.exec('CREATE TABLE business(id TEXT PRIMARY KEY,record TEXT NOT NULL,imported_at TEXT NOT NULL,refreshed_at TEXT,site_digest TEXT)');
  const page = name => `<!doctype html><html lang="en"><head><title>${name}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>${name} synthetic only</h1></main></body></html>`;
  const design = { thesis: 'Synthetic pipeline fixture, not a commercial design', comparisons: ['Not CakeMake', 'Not Cream Burger', 'Not H-Details'] };
  const adapters = {
    discover: discoverFixture, prepareMedia: async () => [],
    makeBrief: async ({ candidate }) => ({ design, pageMap: ['index', 'offer', 'work', 'process', 'contact'].map(file => ({ file: file + '.html' })), directions: ['A', 'B', 'C'], signatureInteraction: detailsContract(candidate) }),
    makeStudies: async () => ['A', 'B', 'C'].map(name => ({ name, design, files: [{ path: 'index.html', content: page(name) }] })),
    selectDirection: async () => ({ selectedDirection: 0, notes: ['Synthetic selection, not acceptance'], blockingDefects: [] }),
    generateProposal: async () => ({ design, files: ['index', 'offer', 'work', 'process', 'contact'].map(name => ({ path: name + '.html', content: page(name) })) }),
    checkSite: async ({ siteRoot, outputRoot }) => { await mkdir(outputRoot, { recursive: true }); const q = { pass: true, captures: [], issues: [], coverage: 'SYNTHETIC check boundary; not live site QA', siteHashes: await treeHashes(siteRoot) }; await writeFile(path.join(outputRoot, 'results.json'), JSON.stringify(q)); return q; },
    critique: async () => ({ reviewer: 'Synthetic fixture', notes: ['Not a human visual verdict'], blockingDefects: [], humanDecision: null }),
  };
  const promote = (store, id, guards) => promoteReview(store, id, { ...guards, deliverablesRoot: path.join(options.stateRoot, 'fixture-delivery') });
  await work(store, { adapters, promote });
  let b = getBatch(store, batch.id); assert.equal(b.state, 'awaiting_first_review'); assert.equal(store.businesses().length, 1);
  const first = store.jobs().find(j => j.kind === 'site'), firstArchive = await readFile(path.join(store.stateRoot, store.getArtifact(first.outputs.archiveId).relative));
  await service.dispatch('batch_continue', { id: b.id, siteJobId: first.id, siteDigest: first.outputs.siteDigest, note: 'Synthetic checkpoint, not a real review or live-run approval', reviewed: true });
  await work(store, { adapters, promote }); b = getBatch(store, b.id);
  assert.equal(b.state, 'complete'); assert.equal(store.jobs().filter(j => j.kind === 'site').length, 3);
  assert.equal(store.businesses().length, 3); assert.equal(Object.keys(b.exports).length, 3);
  assert.ok(Object.values(b.exports).every(e => e.index?.status === 'not_initialized'));
  assert.ok(store.jobs().filter(j => j.kind === 'site').every(j => j.outputs.humanDecision === null && j.outputs.publicRelease === false));
  assert.deepEqual(await readFile(path.join(store.stateRoot, store.getArtifact(first.outputs.archiveId).relative)), firstArchive);
});

test('batch suppression during an adapter is fenced before its checkpoint and before further work', async t => {
  const { store, service, batch } = await fixture(t);
  const discovery = store.jobs()[0]; await executeJob(store, discovery.id, { discover: discoverFixture });
  const { reconcileBatches } = await import('../src/batches.mjs'); await reconcileBatches(store);
  const j = store.jobs().find(j => j.kind === 'site');
  const c = await service.dispatch('case_open', { candidateId: j.input.candidateId });
  let briefCalls = 0;
  const result = await executeJob(store, j.id, {
    prepareMedia: async () => { await service.dispatch('case_event', { id: c.id, requestId: 'suppression-mid-flight', kind: 'suppressed', note: 'Synthetic opt-out', occurredAt: new Date().toISOString() }); return []; },
    makeBrief: async () => { briefCalls++; throw new Error('Must not run'); },
  });
  assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'BATCH_SUPPRESSED'); assert.equal(briefCalls, 0);
  assert.equal(store.events(j.id).some(e => e.type === 'stage.completed' && e.message === 'Completed media'), false);
});

test('checkpoint commit during scheduler shutdown is not stranded when the kick sees its old live lease', async t => {
  const { store, options, batch } = await fixture(t), child = openStore(options); t.after(() => child.close());
  const discovery = store.jobs()[0], leads = [1, 2].map(n => store.saveCandidate(batch.campaignId, { name: `Race fixture ${n}`, area: 'Houston', summary: 'Synthetic race fixture only', identityMatched: true, active: true, sourceUrls: ['https://fixture.example/'], facts: [{ text: 'Synthetic work', sourceUrl: 'https://fixture.example/' }], websiteCheck: { status: 'no_official_site_found', checkedAt: now(), queries: ['Synthetic query'] } }));
  saveBatch(store, { ...getBatch(store, batch.id), members: leads.map(c => ({ candidateId: c.id, ready: true, reasons: [], contacts: [], evidenceDigest: hash(c) })), processedResearchIds: [discovery.id] });
  store.updateJob(discovery.id, { state: 'review_ready', outputs: { candidateIds: leads.map(c => c.id) } });
  const first = store.createJob({ campaignId: batch.campaignId, kind: 'site', input: { candidateId: leads[0].id } });
  store.updateJob(first.id, { state: 'review_ready', outputs: { reviewStatus: 'operator_review_required', siteDigest: 'f'.repeat(64), qaPass: true } });
  saveBatch(store, { ...getBatch(store, batch.id), firstCandidateId: leads[0].id, state: 'awaiting_first_review', exports: { [first.id]: { status: 'synthetic_already_exported' } } });
  const adapters = { discover: async () => ({ candidates: [], live: false, shortfall: 'Synthetic supply exhausted' }), prepareMedia: async () => { throw Object.assign(new Error('Synthetic later-site stop'), { code: 'MEDIA_RESPONSE' }); } };
  const queued = store.queuedJobs.bind(store); let raced = false, kick;
  store.queuedJobs = () => {
    const jobs = queued();
    if (!jobs.length && !raced && getBatch(store, batch.id).state === 'awaiting_first_review') {
      raced = true;
      // Persisted effect of validated continuation, interleaved exactly between
      // reconciliation and the old scheduler's atomic empty/lease-release check.
      saveBatch(store, { ...getBatch(store, batch.id), state: 'active', checkpoint: { siteJobId: first.id, siteDigest: 'f'.repeat(64), source: 'synthetic_checkpoint_not_human_acceptance' } });
      kick = work(child, { adapters });
    }
    return jobs;
  };
  await work(store, { adapters }); await kick;
  assert.equal(raced, true);
  assert.equal(store.jobs().filter(j => j.kind === 'site').length, 2, 'No second manual startup/kick should be required');
});
