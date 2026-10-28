import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { executeJob } from '../src/worker.mjs';
import { hash, now } from '../src/contracts.mjs';
import { treeHashes } from '../src/proposal.mjs';
import { createService } from '../src/service.mjs';
import { detailsContract } from './helpers-interaction.mjs';

test('host production stages a model proposal, binds QA/package bytes and never invents acceptance', async () => {
  const root = await mkdtemp('/tmp/factory-production-'); const options = { dbPath: path.join(root, 'library.sqlite3'), stateRoot: path.join(root, 'state') }; await initialize(options); const store = openStore(options);
  const campaign = store.createCampaign({ name: 'Synthetic production test', area: 'Houston', niche: 'Fixture only', query: 'Fixture only' });
  const discovery = store.createJob({ campaignId: campaign.id, kind: 'discovery' });
  const sourceRoot = path.join(store.stateRoot, 'jobs', discovery.id, 'attempt-0', 'sources'); await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, 'source-fixture.json'), JSON.stringify({ id: 'source-fixture', url: 'https://www.instagram.com/fixture/', text: 'Fixture evidence', images: [] }));
  const c = store.saveCandidate(campaign.id, { name: 'Fixture business', area: 'Houston', summary: 'Synthetic test business only', identityMatched: true, active: true, sourceUrls: ['https://www.instagram.com/fixture/'], facts: [{ text: 'Fixture makes useful objects', sourceUrl: 'https://www.instagram.com/fixture/' }], contacts: { instagram: 'https://www.instagram.com/fixture/' }, websiteCheck: { status: 'no_official_site_found', queries: ['fixture exact name'], checkedAt: now() } }, 'fixture');
  store.updateJob(discovery.id, { state: 'review_ready', outputs: { candidateIds: [c.id] } });
  const job = store.createJob({ campaignId: campaign.id, kind: 'site', input: { candidateId: c.id } });
  const files = ['index', 'services', 'work', 'about', 'contact'].map(name => ({ path: name + '.html', content: '<!doctype html><html lang="en"><head><title>Fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>Fixture</h1></main></body></html>' }));
  const design = { thesis: 'Specific synthetic test design', comparisons: ['Different from CakeMake layout', 'Different from Cream Burger typography', 'Different from H-Details service journey'], interaction: 'Native useful disclosure' };
  const adapters = {
    prepareMedia: async () => [],
    makeBrief: async () => ({ audience: 'Synthetic test users', pageMap: files.map(f => ({ file: f.path })), directions: ['A', 'B', 'C'], selectedDirection: 0, design, signatureInteraction: detailsContract(c) }),
    makeStudies: async () => ['A', 'B', 'C'].map(name => ({ name, design, files: [{ path: 'index.html', content: files[0].content.replace('<h1>Fixture', `<h1>${name} fixture`) }] })),
    selectDirection: async () => ({ selectedDirection: 0, notes: ['Synthetic fixture selection, not actual aesthetic acceptance'], blockingDefects: [] }),
    generateProposal: async () => ({ files, design }),
    checkSite: async ({ siteRoot, outputRoot }) => { await mkdir(outputRoot, { recursive: true }); const qa = { pass: true, issues: [], siteHashes: await treeHashes(siteRoot), captures: [], coverage: 'SYNTHETIC fixture, not real browser verification' }; await writeFile(path.join(outputRoot, 'results.json'), JSON.stringify(qa)); return qa; },
    critique: async () => ({ reviewer: 'Synthetic fixture', notes: ['Fixture only; no visual acceptance'], humanDecision: null }),
  };
  const result = await executeJob(store, job.id, adapters);
  assert.equal(result.state, 'review_ready', result.message);
  assert.equal(result.outputs.reviewStatus, 'operator_review_required');
  assert.equal(result.outputs.humanDecision, null);
  const archive = store.artifacts(job.id).find(a => a.kind === 'package'); assert.ok(archive);
  assert.equal(hash(await readFile(path.join(store.stateRoot, archive.relative))), archive.sha256);
  const service = createService(store, { autoRun: false });
  const verification = await service.dispatch('qa_run', { id: job.id });
  const repeated = await service.dispatch('qa_run', { id: job.id });
  assert.equal(verification.kind, 'qa'); assert.equal(verification.id, repeated.id);
  assert.equal(store.businesses().length, 0); store.close();
});

async function creativeFixture(t, alwaysBlock = false, holdDirection = false, technicalHold = false, legacyBrief = false) {
  const root = await mkdtemp('/tmp/factory-creative-loop-'), options = { dbPath: path.join(root, 'db.sqlite3'), stateRoot: path.join(root, 'state') };
  await initialize(options); const store = openStore(options); t.after(() => store.close());
  const campaign = store.createCampaign({ name: `Creative fixture ${alwaysBlock}`, area: 'Houston', niche: 'Fixture', query: 'Synthetic only' });
  const candidate = store.saveCandidate(campaign.id, { name: 'Creative fixture', area: 'Houston', summary: 'Fixture only', identityMatched: true, active: true, sourceUrls: ['https://fixture.example/'], facts: [{ text: 'Synthetic item', sourceUrl: 'https://fixture.example/' }], websiteCheck: { status: 'no_official_site_found', checkedAt: now(), queries: ['fixture'] } });
  const discovery = store.createJob({ campaignId: campaign.id, kind: 'discovery' });
  store.updateJob(discovery.id, { state: 'review_ready', outputs: { candidateIds: [candidate.id] } });
  const sourceRoot = path.join(store.stateRoot, 'jobs', discovery.id, 'attempt-0/sources'); await mkdir(sourceRoot, { recursive: true });
  const job = store.createJob({ campaignId: campaign.id, kind: 'site', input: { candidateId: candidate.id } });
  const design = { thesis: 'Synthetic art direction', comparisons: ['CakeMake: not the print stack', 'Cream Burger: not the diner layout', 'H-Details: not the card shell'] };
  const page = label => `<!doctype html><html lang="en"><head><title>${label}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>${label}</h1></main></body></html>`;
  let generations = 0, qaRuns = 0, critiques = 0, directionRuns = 0, selections = 0, studyRepairs = 0;
  const adapters = {
    prepareMedia: async () => [],
    makeBrief: async () => ({ design, directions: ['A', 'B', 'C'], selectedDirection: 0, pageMap: ['index', 'offer', 'story', 'photos', 'contact'].map(file => ({ file: file + '.html' })), motionPlan: [{ purpose: 'Synthetic visible motion' }], signatureInteraction: legacyBrief ? { kind: 'details' } : detailsContract(candidate) }),
    makeStudies: async () => { directionRuns++; return ['A', 'B', 'C'].map(name => ({ name, design, files: [{ path: 'index.html', content: page(name) }] })); },
    selectDirection: async () => ({ selectedDirection: 1, notes: ['Fixture pixel choice'], blockingDefects: holdDirection && selections++ === 0 ? ['Primary CTA below the fold'] : [] }),
    repairStudy: async ({ selectedStudy }) => { studyRepairs++; return { ...selectedStudy, files: selectedStudy.files.map(f => ({ ...f, content: f.content.replace('B</h1>', 'B corrected</h1>') })) }; },
    generateProposal: async ({ repairKind, failures, selectedStudy }) => {
      generations++; assert.equal(selectedStudy.name, 'B');
      if (generations === 2) { assert.equal(repairKind, 'technical'); assert.equal(failures[0].code, 'FIXTURE'); }
      if (generations === 3) { assert.equal(repairKind, 'creative'); assert.match(failures[0], /boring/); }
      return { design, files: ['index', 'offer', 'story', 'photos', 'contact'].map(name => ({ path: `${name}.html`, content: page(`${name} revision ${generations}`) })) };
    },
    checkSite: async ({ siteRoot, outputRoot }) => { qaRuns++; await mkdir(outputRoot, { recursive: true }); const pass = !technicalHold && (holdDirection || qaRuns !== 1); const result = { pass, siteHashes: await treeHashes(siteRoot), captures: [], coverage: 'Synthetic QA fixture only', issues: pass ? [] : [{ code: 'FIXTURE' }] }; await writeFile(path.join(outputRoot, 'results.json'), JSON.stringify(result)); return result; },
    critique: async () => { critiques++; return { notes: ['Synthetic fixture'], blockingDefects: !holdDirection && (alwaysBlock || critiques === 1) ? ['Still boring; the composition needs creative rework'] : [], humanDecision: null }; },
  };
  const result = await executeJob(store, job.id, adapters);
  return { store, result, adapters, counts: { generations, qaRuns, critiques, directionRuns }, repairs: () => studyRepairs };
}
test('one technical and one creative repair are independent, retained and followed by fresh exact-byte QA', async t => {
  const { store, result, counts } = await creativeFixture(t);
  assert.equal(result.state, 'review_ready', result.message);
  assert.deepEqual(counts, { generations: 3, qaRuns: 3, critiques: 2, directionRuns: 1 });
  assert.equal(result.outputs.technicalRepairs, 1); assert.equal(result.outputs.creativeRepairs, 1);
  assert.equal(result.outputs.proposalVersions, 3); assert.equal(result.outputs.humanDecision, null);
  assert.equal(store.artifacts(result.id).filter(a => a.kind === 'qa').length, 3);
  assert.equal(store.artifacts(result.id).filter(a => a.kind === 'critique').length, 2);
});
test('a second blocking visual critique holds instead of silently generating forever or packaging', async t => {
  const { store, result, counts } = await creativeFixture(t, true);
  assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'DESIGN_REWORK');
  assert.equal(counts.generations, 3); assert.equal(counts.critiques, 2);
  assert.equal(store.artifacts(result.id).some(a => a.kind === 'package'), false);
  assert.equal(store.artifacts(result.id).filter(a => a.kind === 'critique').length, 2);
});
test('an explicit early direction repair spends the same creative budget without a third job or overwriting studies', async t => {
  const { store, result, adapters, repairs } = await creativeFixture(t, false, true);
  assert.equal(result.errorCode, 'DESIGN_SELECTION');
  const artifact = store.artifacts(result.id).find(a => a.kind === 'selection');
  const originalStudy = path.join(store.stateRoot, 'jobs', result.id, 'attempt-0/directions/study-1/site/index.html');
  const original = await readFile(originalStudy);
  const service = createService(store, { autoRun: false });
  await assert.rejects(service.dispatch('direction_repair', { id: result.id, selectionDigest: '0'.repeat(64) }), e => e.code === 'STALE_REVIEW');
  await service.dispatch('direction_repair', { id: result.id, selectionDigest: artifact.sha256 });
  const finished = await executeJob(store, result.id, adapters);
  assert.equal(finished.state, 'review_ready', finished.message);
  assert.equal(repairs(), 1); assert.equal(finished.outputs.creativeRepairs, 1); assert.equal(finished.outputs.directionRepairs, 1);
  assert.match(finished.outputs.siteRelative, /direction-repair\/proposal-0\/site$/);
  assert.deepEqual(await readFile(originalStudy), original);
  await assert.rejects(service.dispatch('direction_repair', { id: result.id, selectionDigest: artifact.sha256 }), e => e.code === 'DIRECTION_REPAIR_LIMIT');
  assert.equal(store.jobs().filter(j => j.kind === 'site').length, 1);
});
test('read-only rechecking a host-checker hold never regenerates bytes and still requires pixel critique before packaging', async t => {
  for (const blocking of [false, true]) {
    const { store, result, adapters } = await creativeFixture(t, false, false, true);
    assert.equal(result.errorCode, 'QA_FAILED'); assert.equal(result.outputs.archiveId, undefined);
    const siteRoot = path.join(store.stateRoot, result.outputs.siteRelative), before = await treeHashes(siteRoot);
    const job = await createService(store, { autoRun: false }).dispatch('qa_run', { id: result.id });
    let critiques = 0;
    const checked = await executeJob(store, job.id, {
      ...adapters,
      generateProposal: async () => { throw new Error('QA-only verification must never regenerate'); },
      checkSite: async ({ outputRoot }) => { await mkdir(outputRoot, { recursive: true }); const q = { pass: true, siteHashes: before, captures: [], issues: [], coverage: 'Synthetic host-checker correction fixture only' }; await writeFile(path.join(outputRoot, 'results.json'), JSON.stringify(q)); return q; },
      critique: async () => { critiques++; return { notes: ['Synthetic pixel review only'], blockingDefects: blocking ? ['Still visually wrong'] : [], humanDecision: null }; },
    });
    assert.equal(critiques, 1); assert.deepEqual(await treeHashes(siteRoot), before);
    if (blocking) { assert.equal(checked.state, 'blocked'); assert.equal(checked.errorCode, 'DESIGN_REWORK'); assert.equal(store.artifacts(job.id).some(a => a.kind === 'package'), false); }
    else { assert.equal(checked.state, 'review_ready', checked.message); assert.equal(store.job(result.id).outputs.siteDigest, hash(before)); assert.equal(store.job(result.id).outputs.humanDecision, null); assert.ok(store.job(result.id).outputs.critiqueRelative); }
  }
});

test('new production rejects even a trusted adapter legacy brief before study or proposal work', async t => {
  const { result, counts } = await creativeFixture(t, false, false, false, true);
  assert.equal(result.errorCode, 'INTERACTION_CONTRACT');
  assert.equal(result.state, 'blocked');
  assert.equal(counts.directionRuns, 0); assert.equal(counts.generations, 0);
});

async function legacySeedBrief(store, job) {
  const file = path.join(store.stateRoot, 'jobs', job.id, 'attempt-0/checkpoint-brief.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.value.signatureInteraction = { kind: 'filter' }; saved.sha256 = hash(saved.value);
  await writeFile(file, JSON.stringify(saved));
}
test('a legacy direction-repair seed holds before further model work without resetting its budget', async t => {
  const { store, result, adapters, repairs } = await creativeFixture(t, false, true);
  const selection = store.artifacts(result.id).find(a => a.kind === 'selection');
  await legacySeedBrief(store, result);
  await createService(store, { autoRun: false }).dispatch('direction_repair', { id: result.id, selectionDigest: selection.sha256 });
  const stopped = await executeJob(store, result.id, adapters);
  assert.equal(stopped.state, 'blocked'); assert.equal(stopped.errorCode, 'INTERACTION_CONTRACT');
  assert.equal(repairs(), 0);
  assert.equal(store.jobs().filter(j => j.kind === 'site').length, 1);
  assert.equal(store.artifacts(result.id).some(a => a.kind === 'package'), false);
});
test('an eligible legacy held-study import cannot generate another proposal or spend another model call', async t => {
  const { store, result: parent, adapters } = await creativeFixture(t);
  const service = createService(store, { autoRun: false });
  const input = { id: parent.id, siteDigest: parent.outputs.siteDigest, feedback: 'Synthetic exact unchanged study request' };
  const revision = await service.dispatch('revise_site', input);
  const held = await executeJob(store, revision.id, { ...adapters, makeStudies: async () => ['A', 'B', 'C'].map(name => ({ name, design: { thesis: 'Synthetic held study', comparisons: ['A', 'B', 'C'] }, files: [{ path: 'index.html', content: `<h1>${name}</h1><img src="missing.png">` }] })) });
  assert.equal(held.errorCode, 'DESIGN_STUDY_QA');
  await legacySeedBrief(store, held);
  const imported = await service.dispatch('revise_site', { ...input, reuseStudyJobId: held.id });
  let calls = 0;
  const unexpected = async () => { calls++; throw new Error('Legacy study must hold before new model work'); };
  const stopped = await executeJob(store, imported.id, { ...adapters, makeBrief: unexpected, makeStudies: unexpected, selectDirection: unexpected, generateProposal: unexpected });
  assert.equal(stopped.state, 'blocked'); assert.equal(stopped.errorCode, 'INTERACTION_CONTRACT'); assert.equal(calls, 0);
  assert.equal(store.job(held.id).state, 'blocked');
  assert.equal(store.job(parent.id).outputs.siteDigest, parent.outputs.siteDigest);
});
