import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { getBatch, saveBatch } from '../src/batch-store.mjs';
import { reconcileBatches } from '../src/batches.mjs';
import * as intake from '../src/intake.mjs';
import { hash } from '../src/contracts.mjs';
import { policyIdentity } from '../src/policy.mjs';
import { executeJob } from '../src/worker.mjs';
import { intakeFixture } from './helpers-batch.mjs';
import {assessProspect} from '../src/prospects.mjs';

const settings = { area: 'Houston city limits', niche: 'Fixture workshops', targetCount: 1, candidateLimit: 3, maxResearchRounds: 1, searchProvider: 'guest_bing', maxSearches: 8, discoverySearchLimit: 2, maxInspections: 12, maxImageViews: 6, maxModelRequests: 10, batchMinutes: 60, jobMinutes: 10, workflow: 'leads_first' };
async function fixture(t, sourceUrls = intakeFixture().candidate.sourceUrls) {
  const root = await mkdtemp('/tmp/profile-policy-'), options = { dbPath: path.join(root, 'db.sqlite'), stateRoot: path.join(root, 'state'), autoRun: false, batchPrerequisites: async () => ({ ready: true }) };
  await initialize(options); const store = openStore(options); t.after(() => store.close()); const service = createService(store, options);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'profile-setup', acknowledged: true, settings });
  const b = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'profile-start', authorized: true }), job = store.jobs()[0];
  const c = store.saveCandidate(b.campaignId, { ...intakeFixture().candidate, contacts: {}, contactSources: {}, sourceUrls });
  store.updateJob(job.id, { state: 'review_ready', outputs: { candidateIds: [c.id], intake: [{ candidateId: c.id, ready: false, reasons: ['Full intake pending; original profile seen in cheap screening'], contacts: [], prospect:assessProspect(c,intakeFixture(),settings) }] } });
  await reconcileBatches(store);
  return { store, service, b, c, input: { id: b.id, candidateId: c.id, evidenceDigest: hash(c), requestId: 'profile-select', authorized: true } };
}
test('original profile anchors use validated contacts first, then exact safe source routes', () => {
  assert.equal(typeof intake.profileAnchors, 'function');
  assert.deepEqual(intake.profileAnchors({ contacts: {}, sourceUrls: ['https://www.instagram.com/juniper1/', 'https://www.instagram.com/p/abc/', 'https://www.instagram.com/search/', 'http://127.0.0.1/a', 'https://example.com/a'] }), ['https://instagram.com/juniper1']);
  assert.deepEqual(intake.profileAnchors({ contacts: { facebook: 'https://www.facebook.com/profile.php?id=123' }, sourceUrls: ['https://www.instagram.com/other/'] }), ['https://facebook.com/profile.php?id=123']);
});
test('explicit current policy acknowledgement is atomic, replayable, preserves caps and requires new intake', async t => {
  const f = await fixture(t), before = getBatch(f.store, f.b.id), current = (await policyIdentity('production')).digest;
  saveBatch(f.store, { ...before, policyDigest: '0'.repeat(64) });
  await assert.rejects(f.service.dispatch('batch_build_selected', f.input), e => e.code === 'BATCH_POLICY');
  await assert.rejects(f.service.dispatch('batch_build_selected', { ...f.input, policyDigest: '1'.repeat(64) }), e => e.code === 'BATCH_POLICY');
  const read = await f.service.dispatch('batch_get', { id: f.b.id }); assert.equal(read.currentPolicyDigest, current);
  const input = { ...f.input, policyDigest: current }, result = await f.service.dispatch('batch_build_selected', input);
  assert.deepEqual(await f.service.dispatch('batch_build_selected', input), result);
  await assert.rejects(f.service.dispatch('batch_build_selected', { ...input, policyDigest: '2'.repeat(64) }), e => e.code === 'IDEMPOTENCY_CONFLICT');
  const b = getBatch(f.store, f.b.id); assert.equal(b.policyDigest, current); assert.equal(b.members[0].ready, false);
  assert.equal(b.policyHistory.length, 1); assert.equal(b.policyHistory[0].previousPolicyDigest, '0'.repeat(64)); assert.equal(b.policyHistory[0].policyDigest, current);
  for (const field of ['usage', 'settings', 'deadlineAt', 'round', 'discoveryUsage']) assert.deepEqual(b[field], before[field]);
  assert.equal(result.job.campaignId, before.campaignId); assert.equal(f.store.jobs().length, 2);
});
test('selection rejects no original profile, stopped, expired, selected and active owned work without mutation', async t => {
  for (const mode of ['no_anchor', 'stopped', 'expired', 'selected', 'active_job']) {
    const f = await fixture(t, mode === 'no_anchor' ? ['https://example.com/'] : undefined), b = getBatch(f.store, f.b.id);
    if (mode === 'stopped') await f.service.dispatch('batch_stop', { id: b.id });
    if (mode === 'expired') saveBatch(f.store, { ...b, deadlineAt: '2020-01-01T00:00:00Z' });
    if (mode === 'selected') saveBatch(f.store, { ...b, selection: { candidateId: f.c.id } });
    if (mode === 'active_job') f.store.updateJob(f.store.jobs()[0].id, { state: 'running' });
    if (mode === 'no_anchor') assert.equal((await f.service.dispatch('lead_list', { batchId: b.id })).items[0].canSelect, false);
    const snapshot = getBatch(f.store, b.id);
    await assert.rejects(f.service.dispatch('batch_build_selected', { ...f.input, policyDigest: (await policyIdentity('production')).digest }), e => /^BATCH_/.test(e.code));
    assert.deepEqual(getBatch(f.store, b.id), snapshot); assert.equal(f.store.jobs().length, 1);
  }
});
test('source-only exact original must gain fresh actual bound proof; substitutes and unbound proof reject', async t => {
  for (const mode of ['fresh', 'substitute', 'unbound', 'blocked', 'stale']) {
    const f = await fixture(t), selected = await f.service.dispatch('batch_build_selected', f.input);
    const done = await executeJob(f.store, selected.job.id, { discover: async (campaign, ctx) => {
      const data = intakeFixture(), dir = path.join(ctx.jobRoot, 'sources'); await mkdir(dir, { recursive: true });
      const c = { ...data.candidate, media: [], websiteCheck: { status: 'unknown', queries: [] } }; delete c.activityEvidence;
      if (mode === 'substitute') c.contacts = { instagram: 'https://www.instagram.com/samename/' };
      if (mode === 'unbound') c.inspectionIds = [];
      if (mode === 'blocked') data.observations[0].blocked = true;
      if (mode === 'stale') data.observations[0].inspectedAt = '2020-01-01T00:00:00Z';
      for (const o of data.observations) await writeFile(path.join(dir, o.id + '.json'), JSON.stringify(o));
      return { candidates: [c], live: false };
    } });
    if (mode === 'fresh') { assert.equal(done.state, 'review_ready', done.message); assert.equal(done.outputs.intake[0].ready, false); }
    else { assert.equal(done.errorCode, 'SOURCE_RECHECK', done.message); assert.deepEqual(f.store.candidate(f.c.id), f.c); }
    await reconcileBatches(f.store); assert.equal(getBatch(f.store, f.b.id).state, 'held'); assert.equal(f.store.jobs().filter(j => j.kind === 'site').length, 0);
  }
});
test('captured selected prompt preserves exact stored label instead of observed display-name rename', async () => {
  const root = await mkdtemp('/tmp/profile-name-prompt-'), bin = path.join(root, 'bin'), sources = path.join(root, 'job/sources'), capture = path.join(root, 'argv.json');
  await mkdir(bin); await mkdir(sources, { recursive: true });
  await writeFile(path.join(sources, 'search-123abc.json'), JSON.stringify({ provider: 'firecrawl', status: 'completed', intent: 'verify', query: 'Synthetic business', results: [{ url: 'https://fixture.example/', title: 'Synthetic business' }] }));
  await writeFile(path.join(bin, 'opencode'), `#!${process.execPath}\n(async()=>{const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));const output={candidates:[],shortfall:'Fixture only'};const {checkResearchOutput}=await import(${JSON.stringify(new URL('../src/research-check.mjs',import.meta.url).href)});await checkResearchOutput({directory:process.env.FACTORY_SOURCES,requestId:process.env.FACTORY_RESEARCH_REQUEST,candidateLimit:Number(process.env.FACTORY_RESEARCH_LIMIT),output});console.log(JSON.stringify({type:'text',sessionID:'fixture',part:{text:JSON.stringify(output)}}));})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});`, { mode: 0o700 });
  const name = 'Synthetic Event Decorator (@fixture.decor)';
  const script = `import {discover} from ${JSON.stringify(new URL('../src/research.mjs', import.meta.url).href)};await discover({candidateLimit:1,area:'Houston',niche:'Synthetic',deadlineMinutes:2},{jobRoot:${JSON.stringify(path.dirname(sources))},recheck:{name:${JSON.stringify(name)}},batch:{settings:{workflow:'leads_first',searchProvider:'firecrawl'},phase:'enrichment',round:1,seen:[]}});`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { env: { PATH: bin, HOME: root }, timeout: 20000 });
  const args = JSON.parse(await readFile(capture, 'utf8')), prompt = args.at(-1);
  assert.ok(prompt.includes(`Keep candidate.name EXACTLY ${JSON.stringify(name)}`));
  assert.match(prompt, /observed display names may be facts\/summary, never a rename/);
  assert.ok(args.includes('openai/gpt-6.1-sol-fast'));
});
