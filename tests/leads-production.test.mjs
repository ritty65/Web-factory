import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { executeJob } from '../src/worker.mjs';
import { reconcileBatches } from '../src/batches.mjs';
import { hash } from '../src/contracts.mjs';
import { treeHashes } from '../src/proposal.mjs';
import { detailsContract } from './helpers-interaction.mjs';
import { batchSettings, intakeFixture } from './helpers-batch.mjs';

test('selected staged lead reaches an exact review package through existing production without accepting, publishing or selecting another lead', async t => {
  const root = await mkdtemp('/tmp/factory-leads-production-');
  const config = { dbPath: path.join(root, 'db.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false, batchPrerequisites: async () => ({ ready: true }) };
  await initialize(config); const store = openStore(config); t.after(() => store.close());
  const service = createService(store, config);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'staged-package-preset', settings: { ...batchSettings, targetCount: 1, maxResearchRounds: 1, workflow: 'leads_first', discoverySearchLimit: 4 }, acknowledged: true });
  const batch = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'staged-package-start', authorized: true });
  const discovered = intakeFixture(61);
  const discover = async (_, context) => {
    const directory = path.join(context.jobRoot, 'sources'); await mkdir(directory, { recursive: true });
    for (const observation of discovered.observations) await writeFile(path.join(directory, observation.id + '.json'), JSON.stringify(observation));
    for (const search of discovered.searches) await writeFile(path.join(directory, 'search-' + hash(search.query).slice(0, 16) + '.json'), JSON.stringify(search));
    for (const view of discovered.imageViews) await writeFile(path.join(directory, 'image-view-' + hash(view).slice(0, 16) + '.json'), JSON.stringify(view));
    return { candidates: [discovered.candidate], live: false, shortfall: 'Synthetic integration evidence only, not a real prospect' };
  };
  await executeJob(store, batch.researchJobIds[0], { discover }); await reconcileBatches(store);
  let detail = await service.dispatch('batch_get', { id: batch.id });
  assert.equal(detail.batch.state, 'awaiting_selection'); assert.equal(store.jobs().filter(j => j.kind === 'site').length, 0);
  const candidateId = detail.items[0].candidateId;
  const selection = await service.dispatch('batch_build_selected', { id: batch.id, candidateId, evidenceDigest: detail.items[0].evidenceDigest, requestId: 'staged-package-selection', authorized: true });
  await executeJob(store, selection.job.id, { discover }); await reconcileBatches(store);
  const job = store.jobs().find(j => j.kind === 'site'); assert.ok(job); assert.equal(job.input.candidateId, candidateId);
  const candidate = store.candidate(candidateId);
  const html = label => `<!doctype html><html lang="en"><head><title>Synthetic ${label}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>Synthetic ${label}</h1></main></body></html>`;
  const files = ['index', 'services', 'work', 'about', 'contact'].map(name => ({ path: name + '.html', content: html(name) }));
  const design = { thesis: 'Synthetic staged integration only, not customer design work', comparisons: ['Not CakeMake print composition', 'Not Cream Burger diner typography', 'Not H-Details service layout'], interaction: 'Native disclosure fixture' };
  const result = await executeJob(store, job.id, {
    prepareMedia: async () => [],
    makeBrief: async () => ({ audience: 'Synthetic test users', pageMap: files.map(f => ({ file: f.path })), directions: ['A', 'B', 'C'], selectedDirection: 0, design, signatureInteraction: detailsContract(candidate) }),
    makeStudies: async () => ['A', 'B', 'C'].map(name => ({ name, design, files: [{ path: 'index.html', content: html(name) }] })),
    selectDirection: async () => ({ selectedDirection: 0, notes: ['Synthetic choice, not human visual acceptance'], blockingDefects: [] }),
    generateProposal: async () => ({ files, design }),
    checkSite: async ({ siteRoot, outputRoot }) => {
      await mkdir(outputRoot, { recursive: true });
      const qa = { pass: true, issues: [], siteHashes: await treeHashes(siteRoot), captures: [], coverage: 'Synthetic boundary adapter; not actual browser/site QA' };
      await writeFile(path.join(outputRoot, 'results.json'), JSON.stringify(qa)); return qa;
    },
    critique: async () => ({ notes: ['Synthetic critique only'], blockingDefects: [], humanDecision: null }),
  });
  assert.equal(result.state, 'review_ready', result.message);
  assert.equal(result.outputs.reviewStatus, 'operator_review_required'); assert.equal(result.outputs.humanDecision, null);
  const archive = store.artifacts(job.id).find(a => a.kind === 'package'); assert.ok(archive);
  assert.equal(hash(await readFile(path.join(store.stateRoot, archive.relative))), archive.sha256);
  await reconcileBatches(store, { promote: async () => ({ status: 'fixture_no_external_export' }) });
  detail = await service.dispatch('batch_get', { id: batch.id });
  assert.equal(detail.batch.state, 'awaiting_first_review');
  assert.equal(detail.batch.checkpoint, null); assert.equal(store.jobs().filter(j => j.kind === 'site').length, 1);
  assert.equal(detail.authority.contactAuthorized, false); assert.equal(detail.authority.publicRelease, false); assert.equal(detail.authority.externalReviewUrl, null);
  assert.equal(store.businesses().length, 0);
});
