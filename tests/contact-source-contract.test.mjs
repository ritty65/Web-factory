import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { candidateInput, hash } from '../src/contracts.mjs';
import { assessIntake } from '../src/intake.mjs';
import { intakeFixture } from './helpers-batch.mjs';
import { initialize, openStore } from '../src/db.mjs';
import { executeJob } from '../src/worker.mjs';
import { createService } from '../src/service.mjs';
import { batchSettings } from './helpers-batch.mjs';
import { reconcileBatches } from '../src/batches.mjs';

function fixture() {
  const f = intakeFixture();
  f.proof = { sourceUrl: f.observations[0].url, inspectionId: f.observations[0].id, excerpt: f.candidate.name };
  f.candidate.contactSources.instagram = { ...f.proof };
  return f;
}
test('observed object normalizes to legacy URL with preserved metadata on repeated parsing', () => {
  const f = fixture(), c = candidateInput(f.candidate);
  assert.equal(c.contactSources.instagram, f.proof.sourceUrl);
  assert.deepEqual(c.contactSourceEvidence.instagram, f.proof);
  assert.deepEqual(candidateInput(c), c);
  assert.equal(assessIntake(c, f).ready, true);
});
test('legacy strings stay strings without fabricated proof', () => {
  const f = intakeFixture(), c = candidateInput(f.candidate);
  assert.equal(c.contactSources.instagram, f.candidate.contactSources.instagram);
  assert.equal(c.contactSourceEvidence, undefined);
  assert.equal(assessIntake(c, f).ready, true);
});
for (const [label, mutate] of [
  ['array', f => { f.candidate.contactSources.instagram = []; }],
  ['null', f => { f.candidate.contactSources.instagram = null; }],
  ['null metadata map', f => { f.candidate.contactSourceEvidence = null; }],
  ['invalid legacy string', f => { f.candidate.contactSources.instagram = 'javascript:alert(1)'; }],
  ['missing excerpt', f => { delete f.candidate.contactSources.instagram.excerpt; }],
  ['authority field', f => { f.candidate.contactSources.instagram.accepted = true; }],
  ['null ID', f => { f.candidate.contactSources.instagram.inspectionId = null; }],
  ['malformed ID', f => { f.candidate.contactSources.instagram.inspectionId = '../source'; }],
  ['unsafe URL', f => { f.candidate.contactSources.instagram.sourceUrl = 'http://localhost/'; }],
  ['signed URL', f => { f.candidate.contactSources.instagram.sourceUrl += '?token=fixture'; }],
  ['URL object', f => { f.candidate.contactSources.instagram.sourceUrl = {}; }],
  ['null excerpt', f => { f.candidate.contactSources.instagram.excerpt = null; }],
  ['long excerpt', f => { f.candidate.contactSources.instagram.excerpt = 'x'.repeat(1001); }],
  ['unknown map key', f => { f.candidate.contactSourceEvidence = { approved: f.proof }; }],
  ['conflicting string/map URL', f => { f.candidate.contactSources.instagram = f.proof.sourceUrl; f.candidate.contactSourceEvidence = { instagram: { ...f.proof, sourceUrl: 'https://www.instagram.com/other/' } }; }],
  ['conflicting object/map ID', f => { f.candidate.contactSourceEvidence = { instagram: { ...f.proof, inspectionId: 'source-other' } }; }],
  ['conflicting object/map excerpt', f => { f.candidate.contactSourceEvidence = { instagram: { ...f.proof, excerpt: 'different assertion' } }; }],
  ['orphan proof', f => { f.candidate.contactSources = {}; f.candidate.contactSourceEvidence = { instagram: f.proof }; }],
]) test(`rejects malformed contact proof: ${label}`, () => {
  const f = fixture(); mutate(f);
  assert.throws(() => candidateInput(f.candidate), e => e.code === 'INVALID_CONTACT_SOURCE' && /contactSource/.test(e.message));
});
for (const [label, mutate] of [
  ['wrong ID', f => { f.candidate.contactSources.instagram.inspectionId = 'source-other'; }],
  ['unbound ID', f => { f.candidate.inspectionIds = []; }],
  ['stale observation', f => { f.observations[0].inspectedAt = '2020-01-01'; }],
  ['blocked observation', f => { f.observations[0].blocked = true; }],
  ['invented excerpt', f => { f.candidate.contactSources.instagram.excerpt = 'not observed'; }],
  ['URL mismatch', f => { f.candidate.contactSources.instagram.sourceUrl = 'https://www.instagram.com/other/'; }],
  ['stale exact ID with fresh same-URL alias', f => {
    f.observations.push({ ...f.observations[0], id: 'source-fresh-alias' });
    f.candidate.inspectionIds.push('source-fresh-alias'); f.observations[0].inspectedAt = '2020-01-01';
  }],
]) test(`actual intake holds unsupported proof: ${label}`, () => {
  const f = fixture(); mutate(f); const result = assessIntake(candidateInput(f.candidate), f);
  assert.equal(result.ready, false); assert.equal(result.contacts.length, 0);
});
test('worker saves normalized held prospect in real isolated SQLite, retaining proof on replacement', async t => {
  const root = await mkdtemp('/tmp/contact-source-worker-');
  const options = { dbPath: path.join(root, 'db.sqlite'), stateRoot: path.join(root, 'state'), autoRun: false, batchPrerequisites: async () => ({ ready: true }) };
  await initialize(options); const store = openStore(options); t.after(() => store.close());
  const service = createService(store, options);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'contact-fixture-setup', acknowledged: true, settings: batchSettings });
  await service.dispatch('batch_start', { presetVersion: 1, requestId: 'contact-fixture-start', authorized: true });
  const job = store.jobs()[0];
  const f = fixture(); f.candidate.websiteCheck.status = 'unknown'; f.candidate.media = []; delete f.candidate.activityEvidence;
  const result = await executeJob(store, job.id, { discover: async (_, ctx) => {
    const directory = path.join(ctx.jobRoot, 'sources'); await mkdir(directory, { recursive: true });
    for (const o of f.observations) await writeFile(path.join(directory, o.id + '.json'), JSON.stringify(o));
    for (const s of f.searches) await writeFile(path.join(directory, `search-${hash(s.query).slice(0, 16)}.json`), JSON.stringify(s));
    return { candidates: [f.candidate], live: false, shortfall: 'Synthetic held fixture, not live evidence' };
  } });
  assert.equal(result.state, 'review_ready', result.message);
  const saved = store.candidate(result.outputs.candidateIds[0]);
  assert.deepEqual(saved.contactSourceEvidence.instagram, f.proof);
  assert.equal(saved.contactSources.instagram, f.proof.sourceUrl);
  assert.equal(saved.assessment.state, 'blocked');
  assert.equal(result.outputs.intake[0].ready, false);
  assert.equal(result.outputs.intake[0].contacts[0].channel, 'instagram');
  store.replaceCandidate(saved.id, saved, 'fixture-only');
  assert.deepEqual(store.candidate(saved.id).contactSourceEvidence, saved.contactSourceEvidence);
  assert.equal(store.jobs().filter(j => j.kind === 'site').length, 0);
});

for (const lightweight of [false, true]) test(`captured ${lightweight ? 'lightweight' : 'full'} prompt prefers concrete URL-string sources`, async () => {
  const root = await mkdtemp('/tmp/contact-prompt-'), bin = path.join(root, 'bin'), jobRoot = path.join(root, 'job'), capture = path.join(root, 'argv.json');
  await mkdir(bin); await mkdir(path.join(jobRoot, 'sources'), { recursive: true });
  await writeFile(path.join(jobRoot, 'sources/search-abc123.json'), JSON.stringify({ provider: 'firecrawl', status: 'completed', intent: 'verify', results: [{ url: 'https://fixture.example/', title: 'Synthetic only' }] }));
  await writeFile(path.join(bin, 'opencode'), `#!${process.execPath}\n(async()=>{const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));const output={candidates:[]};const {checkResearchOutput}=await import(${JSON.stringify(new URL('../src/research-check.mjs',import.meta.url).href)});await checkResearchOutput({directory:process.env.FACTORY_SOURCES,requestId:process.env.FACTORY_RESEARCH_REQUEST,candidateLimit:Number(process.env.FACTORY_RESEARCH_LIMIT),output});console.log(JSON.stringify({type:'text',sessionID:'fixture',part:{text:JSON.stringify(output)}}));})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});`, { mode: 0o700 });
  const script = `import {discover} from ${JSON.stringify(new URL('../src/research.mjs', import.meta.url).href)};await discover({candidateLimit:1,area:'Houston',niche:'Synthetic',deadlineMinutes:2},{jobRoot:${JSON.stringify(jobRoot)},batch:{settings:{searchProvider:'firecrawl',workflow:${JSON.stringify(lightweight ? 'leads_first' : 'legacy')}},phase:'discovery',seen:[]}});`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { env: { PATH: bin, HOME: root }, timeout: 20000 });
  const argv = JSON.parse(await readFile(capture, 'utf8')), prompt = argv.at(-1);
  assert.equal(argv[argv.indexOf('--model') + 1], 'openai/gpt-6.1-sol-fast');
  assert.match(prompt, /Prefer URL strings, not objects/);
  assert.match(prompt, /"contactSources":\{"instagram":"https:\/\/www.instagram.com\/exact_handle\/"/);
  assert.match(prompt, /compatibility is defensive parsing, not evidence/);
  assert.match(prompt, /TYPED EVIDENCE CONTEXT/);
  assert.match(prompt, /Never infer a mapping from the order of images\/links/);
  assert.match(prompt,/sources\.check_research/);assert.match(prompt,/at most TWO checks/);assert.match(prompt,/final output and cached stages must match/);
});

for (const [label, mutate] of [
  ['forged ID', f => { f.candidate.contactSources.address.inspectionId = 'source-forged'; }],
  ['forged excerpt', f => { f.candidate.contactSources.address.excerpt = 'Not observed'; }],
  ['wrong URL', f => { f.candidate.contactSources.address.sourceUrl = 'https://example.com/other'; }],
  ['unbound observation', f => { f.candidate.inspectionIds = []; }],
  ['stale observation', f => { f.observations[0].inspectedAt = '2020-01-01'; }],
  ['wrong published address', f => { f.candidate.contacts.address = '999 Invented Road'; }],
  ['orphan forged proof', f => { delete f.candidate.contacts.address; f.candidate.contactSources.address.inspectionId = 'source-forged'; }],
]) test(`all supplied metadata is checked including address: ${label}`, () => {
  const f = fixture(); f.candidate.contacts.address = '123 Fixture Lane';
  f.observations[0].text += ' 123 Fixture Lane';
  f.candidate.contactSources.address = { ...f.proof };
  mutate(f); const result = assessIntake(candidateInput(f.candidate), f);
  assert.equal(result.ready, false); assert.ok(result.reasons.some(r => /address.*evidence/.test(r)));
});
test('valid address and orphan proof bind actual source without changing legacy behavior', () => {
  const f = fixture(); f.candidate.contactSources.address = { ...f.proof };
  f.observations[0].text += ' 123   Fixture Lane';
  f.candidate.contacts.address = '123 Fixture Lane';
  assert.equal(assessIntake(candidateInput(f.candidate), f).ready, true);
  delete f.candidate.contacts.address;
  assert.equal(assessIntake(candidateInput(f.candidate), f).ready, true);
  f.candidate.contacts.address = 'Legacy address assertion'; f.candidate.contactSources.address = f.proof.sourceUrl;
  assert.equal(assessIntake(candidateInput(f.candidate), f).ready, true);
});

test('generic replacement clears omitted proof, preserves explicit proof/history and rejects conflicts', async t => {
  const root = await mkdtemp('/tmp/contact-replacement-'), options = { dbPath: path.join(root, 'db.sqlite'), stateRoot: path.join(root, 'state') };
  await initialize(options); const store = openStore(options); t.after(() => store.close());
  const campaign = store.createCampaign({ name: 'Synthetic', area: 'Houston', niche: 'Synthetic', query: 'Synthetic' });
  const f = fixture(), a = store.saveCandidate(campaign.id, f.candidate);
  const b = intakeFixture().candidate; b.contactSources.instagram = 'https://www.facebook.com/juniper/about';
  const replaced = store.replaceCandidate(a.id, b, 'fixture');
  assert.equal(replaced.contactSourceEvidence, undefined);
  assert.equal(store.candidate(a.id).contactSourceEvidence, undefined);
  assert.equal(replaced.contactSources.instagram, b.contactSources.instagram);
  assert.equal(replaced.previousEvidenceDigests.at(-1), hash(a));
  const explicit = store.replaceCandidate(a.id, f.candidate, 'fixture');
  assert.deepEqual(explicit.contactSourceEvidence.instagram, f.proof);
  assert.equal(explicit.previousEvidenceDigests.at(-1), hash(replaced));
  assert.throws(() => store.replaceCandidate(a.id, { ...b, contactSourceEvidence: { instagram: f.proof } }, 'fixture'), e => e.code === 'INVALID_CONTACT_SOURCE');
  assert.deepEqual(store.candidate(a.id), explicit);
});

test('selected service/worker enrichment replaces discovery proof A with preferred strings and fresh observation B', async t => {
  const root = await mkdtemp('/tmp/contact-enrichment-'), options = { dbPath: path.join(root, 'db.sqlite'), stateRoot: path.join(root, 'state'), autoRun: false, batchPrerequisites: async () => ({ ready: true }) };
  await initialize(options); const store = openStore(options); t.after(() => store.close()); const service = createService(store, options);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'contact-enrich-setup', acknowledged: true, settings: { ...batchSettings, targetCount: 1, candidateLimit: 3, maxResearchRounds: 1, workflow: 'leads_first', discoverySearchLimit: 6 } });
  const batch = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'contact-enrich-start', authorized: true });
  const adapter = f => async (_, ctx) => {
    const directory = path.join(ctx.jobRoot, 'sources'); await mkdir(directory, { recursive: true });
    for (const o of f.observations) await writeFile(path.join(directory, o.id + '.json'), JSON.stringify(o));
    for (const s of f.searches) await writeFile(path.join(directory, `search-${hash(s.query).slice(0,16)}.json`), JSON.stringify(s));
    for (const v of f.imageViews) await writeFile(path.join(directory, `image-view-${hash(v).slice(0,16)}.json`), JSON.stringify(v));
    return { candidates: [f.candidate], live: false };
  };
  const initial = await executeJob(store, store.jobs()[0].id, { discover: adapter(fixture()) }); await reconcileBatches(store);
  assert.equal(initial.state, 'review_ready', initial.message); const a = store.candidate(initial.outputs.candidateIds[0]);
  const selected = await service.dispatch('batch_build_selected', { id: batch.id, candidateId: a.id, evidenceDigest: hash(a), requestId: 'contact-enrich-select', authorized: true });
  const f = intakeFixture(), sourceId = 'source-bbbbbbbbbbbbbbbbbbb2';
  f.observations[0].id = sourceId; f.candidate.inspectionIds = [sourceId];
  f.candidate.activityEvidence.sourceId = sourceId; f.candidate.media[0].sourceId = sourceId; f.imageViews[0].sourceId = sourceId;
  const result = await executeJob(store, selected.job.id, { discover: adapter(f) });
  assert.equal(result.state, 'review_ready', result.message);
  assert.equal(result.outputs.intake[0].ready, true, result.outputs.intake[0].reasons.join('\n'));
  assert.equal(result.outputs.intake[0].contacts[0].channel, 'instagram');
  const b = store.candidate(a.id); assert.equal(b.contactSourceEvidence, undefined);
  assert.deepEqual(b.inspectionIds, [sourceId]); assert.equal(b.previousEvidenceDigests.at(-1), hash(a));
});
