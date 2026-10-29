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
import { reserveBatchUsage } from '../src/batch-budget.mjs';
import { hash, now } from '../src/contracts.mjs';
import { executeJob } from '../src/worker.mjs';
import { intakeFixture } from './helpers-batch.mjs';
import {assessProspect} from '../src/prospects.mjs';

const settings = { area: 'Houston city limits', niche: 'Synthetic workshops', targetCount: 1, candidateLimit: 3, maxResearchRounds: 1, searchProvider: 'guest_bing', maxSearches: 4, discoverySearchLimit: 2, maxInspections: 12, maxImageViews: 6, maxModelRequests: 10, batchMinutes: 60, jobMinutes: 10, workflow: 'leads_first' };
async function fixture(t) {
  const root = await mkdtemp('/tmp/leads-first-');
  const options = { dbPath: path.join(root, 'db.sqlite'), stateRoot: path.join(root, 'state'), autoRun: false, batchPrerequisites: async () => ({ ready: true }) };
  await initialize(options); const store = openStore(options); t.after(() => store.close());
  const service = createService(store, options);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'fixture-setup', acknowledged: true, settings });
  const b = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'fixture-start', authorized: true });
  const job = store.jobs()[0];
  const evidence=intakeFixture(99),c=store.saveCandidate(b.campaignId,evidence.candidate);
  return { store, service, b, job, c, evidence };
}
async function pause(f) {
  f.store.updateJob(f.job.id, { state: 'review_ready', outputs: { candidateIds: [f.c.id], intake: [{ candidateId: f.c.id, ready: true, reasons: [], contacts: [], prospect:assessProspect(f.c,f.evidence,settings) }] } });
  await reconcileBatches(f.store);
}
test('leads-first qualified discovery pauses without building; strict selection is replayable once and keeps deadline', async t => {
  const f = await fixture(t); await pause(f);
  assert.equal(getBatch(f.store, f.b.id).phase, 'selection');
  assert.equal(f.store.jobs().length, 1);
  await assert.rejects(f.service.dispatch('build_site', { candidateId: f.c.id }), e => /^BATCH_/.test(e.code));
  await assert.rejects(f.service.dispatch('candidate_recheck', { id: f.c.id }));
  const input = { id: f.b.id, candidateId: f.c.id, evidenceDigest: hash(f.c), requestId: 'select-fixture', authorized: true };
  const result = await f.service.dispatch('batch_build_selected', input);
  assert.deepEqual(await f.service.dispatch('batch_build_selected', input), result);
  await assert.rejects(f.service.dispatch('batch_build_selected', { ...input, evidenceDigest: '0'.repeat(64) }), e => e.code === 'IDEMPOTENCY_CONFLICT');
  const b = getBatch(f.store, f.b.id), enrichment = f.store.jobs().find(j => j.id !== f.job.id);
  assert.equal(b.deadlineAt, f.b.deadlineAt); assert.equal(b.round, 1);
  assert.equal(enrichment.input.recheckCandidateId, f.c.id); assert.equal(enrichment.input.phase, 'enrichment');
  assert.equal(f.store.jobs().length, 2);
});
for(const mode of ['empty','unresolved','official','booking','expired','duplicate'])test(`finished discovery with no selectable member is held without spending or pretending to await a choice: ${mode}`,async t=>{
  const f=await fixture(t),e=f.evidence;
  if(['unresolved','official','booking'].includes(mode)){
    const url=mode==='booking'?'https://booksy.com/en-us/juniper':'https://business.example/';
    e.observations[0].links.push({url,text:'Business destination'});
    if(mode!=='unresolved'){
      e.observations.push({id:'source-selection-destination',url,inspectedAt:now(),blocked:false,text:'Synthetic destination',links:[]});
      e.candidate.websiteCheck.linkChecks.push({url,sourceId:'source-selection-destination',status:'official',reason:'Synthetic observed destination'});
      f.store.replaceCandidate(f.c.id,e.candidate,'selection-fixture');f.c=f.store.candidate(f.c.id);
    }
  }
  if(mode==='duplicate'){
    const other=f.store.createCampaign({name:'Older test identity',query:'Synthetic only',area:'Houston',niche:'Test'});
    const duplicate=f.store.saveCandidate(other.id,{...f.c,name:f.c.name+' LLC'});assert.notEqual(duplicate.id,f.c.id);
  }
  const prospect=assessProspect(f.c,e,settings);if(mode==='expired')prospect.evidenceValidUntil='2020-01-01T00:00:00.000Z';
  reserveBatchUsage(f.store,f.job.id,'modelRequests');reserveBatchUsage(f.store,f.job.id,'searches');
  const before=getBatch(f.store,f.b.id);
  f.store.updateJob(f.job.id,{state:'review_ready',outputs:{candidateIds:mode==='empty'?[]:[f.c.id],intake:mode==='empty'?[]:[{candidateId:f.c.id,ready:false,reasons:['Full evidence not complete'],contacts:[],prospect}]}});
  await reconcileBatches(f.store);const b=getBatch(f.store,f.b.id);
  assert.equal(b.state,'held');assert.equal(b.phase,'discovery');assert.match(b.message,/no prospect eligible for selection/i);
  assert.deepEqual(b.usage,before.usage);assert.equal(b.deadlineAt,before.deadlineAt);assert.equal(b.round,before.round);
  assert.equal(b.members.length,mode==='empty'?0:1);assert.equal(b.selection,null);assert.equal(f.store.jobs().length,1);
  const changes=f.store.db.prepare('SELECT total_changes() n').get().n,detail=await f.service.dispatch('batch_get',{id:b.id});
  assert.equal(detail.batch.counts.selectable,0);assert.equal(detail.batch.outcome.kind,'no_selectable_prospect');
  assert.equal(detail.progress.stages.find(s=>s.id==='selection').state,'pending');
  assert.equal((await f.service.dispatch('lead_list',{batchId:b.id})).items.some(p=>p.canSelect),false);
  await reconcileBatches(f.store);assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,changes);
  await assert.rejects(f.service.dispatch('batch_build_selected',{id:b.id,candidateId:f.c.id,evidenceDigest:hash(f.c),requestId:'cannot-select-held',authorized:true}),e=>e.code==='BATCH_SELECTION');
  assert.equal(f.store.jobs().length,1);
});
for(const [unit,cap] of [['searches','maxSearches'],['inspections','maxInspections'],['imageViews','maxImageViews'],['modelRequests','maxModelRequests']])test(`an exhausted ${unit} allowance is not displayed as an available selection`,async t=>{
  const f=await fixture(t),original=getBatch(f.store,f.b.id);
  saveBatch(f.store,{...original,usage:{...original.usage,[unit]:original.settings[cap]}});
  await pause(f);const detail=await f.service.dispatch('batch_get',{id:f.b.id});
  assert.equal(detail.batch.state,'held');assert.equal(detail.batch.counts.selectable,0);
  assert.equal((await f.service.dispatch('lead_list',{batchId:f.b.id})).items[0].canSelect,false);
  assert.equal(detail.batch.usage[unit],original.settings[cap]);assert.equal(detail.batch.deadlineAt,original.deadlineAt);assert.equal(f.store.jobs().length,1);
});
test('discovery attempts cannot consume reserved enrichment searches and totals never reset', async t => {
  const f = await fixture(t);
  reserveBatchUsage(f.store, f.job.id, 'searches'); reserveBatchUsage(f.store, f.job.id, 'searches');
  assert.throws(() => reserveBatchUsage(f.store, f.job.id, 'searches'), e => e.code === 'BATCH_DISCOVERY_BUDGET');
  await pause(f);
  await f.service.dispatch('batch_build_selected', { id: f.b.id, candidateId: f.c.id, evidenceDigest: hash(f.c), requestId: 'budget-select', authorized: true });
  const j = f.store.jobs().find(j => j.input.phase === 'enrichment');
  reserveBatchUsage(f.store, j.id, 'searches'); reserveBatchUsage(f.store, j.id, 'searches');
  assert.throws(() => reserveBatchUsage(f.store, j.id, 'searches'), e => e.code === 'BATCH_BUDGET');
  assert.equal(getBatch(f.store, f.b.id).usage.searches, 4);
  assert.equal(getBatch(f.store, f.b.id).discoveryUsage.searches, 2);
});
test('stale, stopped, expired, nonmember and unsupported settings fail without new jobs', async t => {
  for (const mode of ['stale', 'stopped', 'expired', 'nonmember', 'official']) {
    const f = await fixture(t); await pause(f);
    const input = { id: f.b.id, candidateId: f.c.id, evidenceDigest: hash(f.c), requestId: 'bad-select', authorized: true };
    if (mode === 'stale') input.evidenceDigest = '0'.repeat(64);
    if (mode === 'stopped') await f.service.dispatch('batch_stop', { id: f.b.id });
    if (mode === 'expired') saveBatch(f.store, { ...getBatch(f.store, f.b.id), deadlineAt: '2020-01-01T00:00:00Z' });
    if (mode === 'nonmember') input.candidateId = 'lead-not-a-member';
    if (mode === 'official') f.store.replaceCandidate(f.c.id, { ...f.c, websiteCheck: { ...f.c.websiteCheck, status: 'official_site_found' } }, 'fixture');
    await assert.rejects(f.service.dispatch('batch_build_selected', input), e => /^BATCH_|^STALE_/.test(e.code));
    assert.equal(f.store.jobs().length, 1);
  }
  const f = await fixture(t);
  await assert.rejects(f.service.dispatch('batch_preset_save', { version: 1, requestId: 'invalid-allocation', acknowledged: true, settings: { ...settings, discoverySearchLimit: 4 } }), e => e.code === 'INVALID_INPUT');
});

async function sourceFixture(ctx, candidate) {
  const f = intakeFixture(), directory = path.join(ctx.jobRoot, 'sources'); await mkdir(directory, { recursive: true });
  if (candidate) f.candidate = candidate;
  for (const o of f.observations) await writeFile(path.join(directory, o.id + '.json'), JSON.stringify(o));
  for (const s of f.searches) await writeFile(path.join(directory, `search-${hash(s.query).slice(0, 16)}.json`), JSON.stringify(s));
  for (const v of f.imageViews) await writeFile(path.join(directory, `image-view-${hash(v).slice(0, 16)}.json`), JSON.stringify(v));
  return { candidates: [f.candidate], live: false, shortfall: 'Isolated source fixture only' };
}
test('worker full intake updates exact member once, retains history, excludes selected from seen and gates production', async t => {
  const f = await fixture(t);
  const discovered = await executeJob(f.store, f.job.id, { discover: async (campaign, ctx) => {
    assert.equal(ctx.batch.phase, 'discovery');
    return sourceFixture(ctx);
  } });
  assert.equal(discovered.state, 'review_ready', discovered.message);
  await reconcileBatches(f.store);
  const c = f.store.candidate(discovered.outputs.candidateIds[0]), originalMember = getBatch(f.store, f.b.id).members[0];
  assert.equal(originalMember.ready, true); assert.equal(f.store.jobs().filter(j => j.kind === 'site').length, 0);
  const listing = await f.service.dispatch('lead_list', { batchId: f.b.id, limit: 1 });
  assert.equal(listing.items[0].state, 'ready'); assert.equal(listing.items[0].canSelect, true);
  const before = f.store.db.prepare('SELECT total_changes() n').get().n;
  await f.service.dispatch('lead_list', { batchId: f.b.id, state: 'ready', offset: 0, limit: 1 });
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n, before);
  const selected = await f.service.dispatch('batch_build_selected', { id: f.b.id, candidateId: c.id, evidenceDigest: hash(c), requestId: 'exact-enrichment', authorized: true });
  const done = await executeJob(f.store, selected.job.id, { discover: async (campaign, ctx) => {
    assert.equal(campaign.candidateLimit, 1); assert.equal(ctx.recheck.id, c.id); assert.equal(ctx.batch.phase, 'enrichment');
    assert.equal(ctx.batch.seen.some(v => v.name === c.name), false);
    return sourceFixture(ctx);
  } });
  assert.equal(done.state, 'review_ready', done.message);
  await reconcileBatches(f.store);
  const b = getBatch(f.store, f.b.id), m = b.members.find(m => m.candidateId === c.id);
  assert.equal(b.members.length, 1); assert.equal(m.ready, true, m.reasons.join('\n')); assert.equal(m.evidenceDigest, hash(f.store.candidate(c.id)));
  assert.deepEqual(m.history[0], originalMember); assert.equal(b.round, 1);
  assert.equal(f.store.jobs().filter(j => j.kind === 'site').length, 1);
  assert.equal(f.store.candidate(c.id).previousEvidenceDigests.at(-1), hash(c));
});
test('selected enrichment cannot substitute a different business or trigger replacement discovery', async t => {
  const f = await fixture(t); await pause(f);
  const selected = await f.service.dispatch('batch_build_selected', { id: f.b.id, candidateId: f.c.id, evidenceDigest: hash(f.c), requestId: 'no-replacement', authorized: true });
  const done = await executeJob(f.store, selected.job.id, { discover: async () => ({ candidates: [{ ...f.c, name: 'Replacement business' }], live: false }) });
  assert.equal(done.errorCode, 'SOURCE_RECHECK'); await reconcileBatches(f.store);
  assert.equal(getBatch(f.store, f.b.id).state, 'held'); assert.equal(f.store.jobs().length, 2); assert.deepEqual(f.store.candidate(f.c.id), f.c);
});
test('missing new media/activity cannot inherit prior readiness or stale optional fields', async t => {
  const f = await fixture(t);
  const first = await executeJob(f.store, f.job.id, { discover: (campaign, ctx) => sourceFixture(ctx) });
  await reconcileBatches(f.store);
  const c = f.store.candidate(first.outputs.candidateIds[0]);
  const selected = await f.service.dispatch('batch_build_selected', { id: f.b.id, candidateId: c.id, evidenceDigest: hash(c), requestId: 'missing-new-evidence', authorized: true });
  const done = await executeJob(f.store, selected.job.id, { discover: (campaign, ctx) => {
    const candidate = { ...intakeFixture().candidate, media: [] };
    delete candidate.activityEvidence; delete candidate.pagePurposes;
    return sourceFixture(ctx, candidate);
  } });
  assert.equal(done.state, 'review_ready', done.message); await reconcileBatches(f.store);
  const b = getBatch(f.store, f.b.id), updated = f.store.candidate(c.id);
  assert.equal(b.state, 'held'); assert.equal(b.members.length, 1); assert.equal(b.members[0].ready, false);
  assert.equal(updated.activityEvidence, undefined); assert.equal(updated.pagePurposes, undefined);
  assert.equal(b.members[0].evidenceDigest, hash(updated)); assert.equal(b.members[0].history[0].ready, true);
  assert.equal(f.store.jobs().filter(j => j.kind === 'site').length, 0);
});
test('suppression and duplicate identity block selection; later suppression blocks enrichment before adapter', async t => {
  for (const mode of ['suppressed', 'duplicate', 'after_selection']) {
    const f = await fixture(t); await pause(f);
    const input = { id: f.b.id, candidateId: f.c.id, evidenceDigest: hash(f.c), requestId: 'protected-select', authorized: true };
    let selected;
    if (mode === 'after_selection') selected = await f.service.dispatch('batch_build_selected', input);
    if (mode === 'duplicate') {
      const campaign = f.store.createCampaign({ name: 'Older fixture', area: 'Houston', niche: 'Synthetic', query: 'Fixture only' });
      f.store.saveCandidate(campaign.id, { ...f.c, name: f.c.name + ' LLC' });
    } else {
      const salesCase = await f.service.dispatch('case_open', { candidateId: f.c.id });
      await f.service.dispatch('case_event', { id: salesCase.id, requestId: 'fixture-optout', kind: 'suppressed', note: 'Synthetic opt-out only', occurredAt: now() });
    }
    if (selected) {
      let calls = 0;
      const j = await executeJob(f.store, selected.job.id, { discover: async () => { calls++; throw new Error('Must not run'); } });
      assert.equal(calls, 0); assert.equal(j.errorCode, 'BATCH_SUPPRESSED');
    } else await assert.rejects(f.service.dispatch('batch_build_selected', input), e => e.code === 'BATCH_SELECTION');
  }
});
test('new read operation rejects paths and discovery image work cannot consume the enrichment reserve', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.dispatch('lead_list', { batchId: '../db.sqlite' }), e => e.code === 'INVALID_INPUT');
  assert.throws(() => reserveBatchUsage(f.store, f.job.id, 'imageViews'), e => e.code === 'BATCH_DISCOVERY_BUDGET');
  assert.equal(getBatch(f.store, f.b.id).usage.imageViews, 0);
  assert.throws(() => f.store.createJob({ campaignId: f.b.campaignId, kind: 'discovery', input: { batchId: f.b.id, round: 1, phase: 'enrichment', recheckCandidateId: f.c.id, candidateLimit: 1 } }), e => e.code === 'BATCH_SELECTION');
});

test('needs-changes feedback removes ready listing and blocks selection and legacy production', async t => {
  const f = await fixture(t);
  const j = await executeJob(f.store, f.job.id, { discover: (campaign, ctx) => sourceFixture(ctx) }); await reconcileBatches(f.store);
  const c = f.store.candidate(j.outputs.candidateIds[0]);
  await f.service.dispatch('batch_item_note', { id: f.b.id, candidateId: c.id, requestId: 'review-hold-note', disposition: 'needs_changes', note: 'Synthetic evidence needs changes' });
  const held = await f.service.dispatch('lead_list', { batchId: f.b.id });
  assert.equal(held.items[0].state, 'held'); assert.equal(held.items[0].ready, false); assert.equal(held.items[0].canSelect, false);
  assert.equal((await f.service.dispatch('lead_list', { batchId: f.b.id, state: 'ready' })).total, 0);
  await assert.rejects(f.service.dispatch('batch_build_selected', { id: f.b.id, candidateId: c.id, evidenceDigest: hash(c), requestId: 'held-selection', authorized: true }));
  await assert.rejects(f.service.dispatch('build_site', { candidateId: c.id })); await reconcileBatches(f.store);
  assert.equal(f.store.jobs().filter(j => j.kind === 'site').length, 0);
});

test('persisted strong and ready evidence expires on read without writes', async t => {
  for (const state of ['strong', 'ready']) {
    const f = await fixture(t);
    const j = await executeJob(f.store, f.job.id, { discover: (campaign, ctx) => {
      if (state === 'ready') return sourceFixture(ctx);
      const candidate = { ...intakeFixture().candidate, media: [] }; delete candidate.activityEvidence; delete candidate.pagePurposes;
      return sourceFixture(ctx, candidate);
    } }); await reconcileBatches(f.store);
    assert.equal(j.state, 'review_ready');
    const first = (await f.service.dispatch('lead_list', { batchId: f.b.id })).items[0]; assert.equal(first.state, state);
    assert.ok(Number.isFinite(Date.parse(first.evidenceValidUntil)));
    const changes = f.store.db.prepare('SELECT total_changes() n').get().n, originalNow = Date.now;
    try {
      Date.now = () => Date.parse(first.evidenceValidUntil) + 1;
      const expired = (await f.service.dispatch('lead_list', { batchId: f.b.id })).items[0];
      assert.equal(expired.state, 'held'); assert.equal(expired.ready, false); assert.equal(expired.websiteStatus, 'unknown');
      assert.equal((await f.service.dispatch('lead_list', { batchId: f.b.id, state })).total, 0);
      assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n, changes);
    } finally { Date.now = originalNow; }
  }
});

test('real worker retains cap failure honestly without retry or invented partial leads', async t => {
  const f = await fixture(t);
  const result = await executeJob(f.store, f.job.id, { discover: async () => {
    reserveBatchUsage(f.store, f.job.id, 'searches'); reserveBatchUsage(f.store, f.job.id, 'searches'); reserveBatchUsage(f.store, f.job.id, 'searches');
    throw new Error('Unreachable');
  } });
  assert.equal(result.errorCode, 'BATCH_DISCOVERY_BUDGET'); await reconcileBatches(f.store);
  const b = getBatch(f.store, f.b.id); assert.equal(b.state, 'held'); assert.equal(b.members.length, 0); assert.equal(b.usage.searches, 2); assert.equal(f.store.jobs().length, 1);
});

test('worker supplies remaining discovery and total budget, and reservations expose discovery share', async t => {
  const f = await fixture(t);
  const reservation = reserveBatchUsage(f.store, f.job.id, 'searches');
  assert.equal(reservation.discoveryUsed, 1); assert.equal(reservation.discoveryCap, 2); assert.equal(reservation.discoveryRemaining, 1);
  const done = await executeJob(f.store, f.job.id, { discover: async (campaign, ctx) => {
    assert.equal(ctx.batch.budget.discoverySearchesRemaining, 1);
    assert.deepEqual(ctx.batch.budget.totalRemaining, { modelRequests: 10, searches: 3, inspections: 12, imageViews: 6 });
    return { candidates: [], live: false };
  } }); assert.equal(done.state, 'review_ready', done.message);
});

test('actual lightweight second-round prompt contains exact host remaining snapshot and early finalization instruction', async () => {
  const root = await mkdtemp('/tmp/leads-prompt-budget-'), bin = path.join(root, 'bin'), sources = path.join(root, 'job/sources'), capture = path.join(root, 'argv.json');
  await mkdir(bin); await mkdir(sources, { recursive: true });
  await writeFile(path.join(sources, 'search-123abc.json'), JSON.stringify({ provider: 'firecrawl', status: 'completed', intent: 'verify', query: 'Synthetic business', results: [{ url: 'https://fixture.example/', title: 'Synthetic business' }] }));
  await writeFile(path.join(bin, 'opencode'), `#!${process.execPath}\n(async()=>{const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));const output={candidates:[],shortfall:'Fixture only'};const {checkResearchOutput}=await import(${JSON.stringify(new URL('../src/research-check.mjs',import.meta.url).href)});await checkResearchOutput({directory:process.env.FACTORY_SOURCES,requestId:process.env.FACTORY_RESEARCH_REQUEST,candidateLimit:Number(process.env.FACTORY_RESEARCH_LIMIT),output});console.log(JSON.stringify({type:'text',sessionID:'fixture',part:{text:JSON.stringify(output)}}));})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});`, { mode: 0o700 });
  const budget = { discoverySearchesRemaining: 1, totalRemaining: { searches: 7, inspections: 9, imageViews: 6, modelRequests: 8 } };
  const script = `import {discover} from ${JSON.stringify(new URL('../src/research.mjs', import.meta.url).href)};await discover({candidateLimit:1,area:'Houston',niche:'Synthetic',deadlineMinutes:2},{jobRoot:${JSON.stringify(path.dirname(sources))},batch:{settings:{workflow:'leads_first',searchProvider:'firecrawl',discoverySearchLimit:5},phase:'discovery',round:2,seen:[],budget:${JSON.stringify(budget)}}});`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { env: { PATH: bin, HOME: root }, timeout: 20000 });
  const prompt = JSON.parse(await readFile(capture, 'utf8')).at(-1);
  const snapshot = JSON.parse(prompt.split('\n').find(line => line.startsWith('HOST REMAINING BUDGET: ')).slice('HOST REMAINING BUDGET: '.length));
  assert.deepEqual(snapshot, budget); assert.match(prompt, /Finalize collected prospects BEFORE exhausting/); assert.match(prompt, /site:instagram.com/);
  assert.match(prompt, /record its exact profile URL in contacts.instagram or contacts.facebook/);
  assert.match(prompt, /bind contactSources to the exact inspected supporting URL/);
  assert.match(prompt, /NOT permission to contact/);
});

test('two fully ready discovery members never autobuild; only the explicitly selected second member builds', async t => {
  const f = await fixture(t);
  const j = await executeJob(f.store, f.job.id, { discover: async (campaign, ctx) => {
    const first = await sourceFixture(ctx), second = intakeFixture(2), directory = path.join(ctx.jobRoot, 'sources');
    for (const o of second.observations) await writeFile(path.join(directory, o.id + '.json'), JSON.stringify(o));
    for (const s of second.searches) await writeFile(path.join(directory, `search-${hash(s.query).slice(0, 16)}.json`), JSON.stringify(s));
    for (const v of second.imageViews) await writeFile(path.join(directory, `image-view-${hash(v).slice(0, 16)}.json`), JSON.stringify(v));
    return { ...first, candidates: [...first.candidates, second.candidate] };
  } }); await reconcileBatches(f.store);
  const b = getBatch(f.store, f.b.id); assert.equal(b.members.filter(m => m.ready).length, 2); assert.equal(f.store.jobs().filter(j => j.kind === 'site').length, 0);
  const c = f.store.candidate(j.outputs.candidateIds[1]);
  const selected = await f.service.dispatch('batch_build_selected', { id: b.id, candidateId: c.id, evidenceDigest: hash(c), requestId: 'select-second-ready', authorized: true });
  const done = await executeJob(f.store, selected.job.id, { discover: (campaign, ctx) => {
    const second = intakeFixture(2); return sourceFixture(ctx, second.candidate).then(async result => {
      const directory = path.join(ctx.jobRoot, 'sources');
      for (const o of second.observations) await writeFile(path.join(directory, o.id + '.json'), JSON.stringify(o));
      for (const s of second.searches) await writeFile(path.join(directory, `search-${hash(s.query).slice(0, 16)}.json`), JSON.stringify(s));
      for (const v of second.imageViews) await writeFile(path.join(directory, `image-view-${hash(v).slice(0, 16)}.json`), JSON.stringify(v));
      return result;
    });
  } }); assert.equal(done.state, 'review_ready', done.message); await reconcileBatches(f.store);
  const sites = f.store.jobs().filter(j => j.kind === 'site'); assert.equal(sites.length, 1); assert.equal(sites[0].input.candidateId, c.id);
});

test('selected enrichment requires a fresh bound original account, not a same-name cross-platform substitute', async t => {
  for (const mode of ['substitute', 'substitute_with_old_observation', 'missing', 'stale', 'blocked', 'unbound', 'omitted_contacts']) {
    const f = await fixture(t);
    const first = await executeJob(f.store, f.job.id, { discover: (campaign, ctx) => sourceFixture(ctx) }); await reconcileBatches(f.store);
    const original = f.store.candidate(first.outputs.candidateIds[0]);
    const selected = await f.service.dispatch('batch_build_selected', { id: f.b.id, candidateId: original.id, evidenceDigest: hash(original), requestId: 'anchor-' + mode, authorized: true });
    const result = await executeJob(f.store, selected.job.id, { discover: async (campaign, ctx) => {
      let evidence = intakeFixture();
      if (mode.startsWith('substitute')) {
        const old = evidence.candidate.contacts.instagram, replacement = 'https://www.facebook.com/unrelatedjuniper/';
        evidence = JSON.parse(JSON.stringify(evidence).replaceAll(old, replacement).replaceAll('https://www.instagram.com/p/juniper1/', 'https://www.facebook.com/unrelatedjuniper/posts/123456789/'));
        evidence.candidate.contacts = { facebook: replacement }; evidence.candidate.contactSources = { facebook: replacement };
        if (mode === 'substitute_with_old_observation') {
          const oldEvidence = intakeFixture(), oldId = oldEvidence.observations[0].id;
          evidence = JSON.parse(JSON.stringify(evidence).replaceAll(oldId, 'source-unrelated-account'));
          evidence.observations.push(oldEvidence.observations[0]); evidence.candidate.inspectionIds.push(oldId);
        }
        const { assessIntake } = await import('../src/intake.mjs'); const { candidateInput } = await import('../src/contracts.mjs');
        assert.equal(assessIntake(candidateInput(evidence.candidate), evidence).ready, true, 'Substitute would otherwise pass full intake');
      }
      if (mode === 'missing') evidence.observations = [];
      if (mode === 'stale') evidence.observations[0].inspectedAt = '2020-01-01T00:00:00Z';
      if (mode === 'blocked') evidence.observations[0].blocked = true;
      if (mode === 'unbound') evidence.candidate.inspectionIds = [];
      if (mode === 'omitted_contacts') { evidence.candidate.contacts = {}; evidence.candidate.contactSources = {}; }
      const directory = path.join(ctx.jobRoot, 'sources'); await mkdir(directory, { recursive: true });
      for (const o of evidence.observations) await writeFile(path.join(directory, o.id + '.json'), JSON.stringify(o));
      for (const s of evidence.searches) await writeFile(path.join(directory, `search-${hash(s.query).slice(0, 16)}.json`), JSON.stringify(s));
      for (const v of evidence.imageViews) await writeFile(path.join(directory, `image-view-${hash(v).slice(0, 16)}.json`), JSON.stringify(v));
      return { candidates: [evidence.candidate], live: false };
    } });
    assert.equal(result.errorCode, 'SOURCE_RECHECK', mode); assert.deepEqual(f.store.candidate(original.id), original, mode);
    await reconcileBatches(f.store); assert.equal(f.store.jobs().filter(j => j.kind === 'site').length, 0);
  }
});

test('actual selected-enrichment prompt carries depleted host total budget and exact-business instruction', async () => {
  const root = await mkdtemp('/tmp/leads-enrichment-budget-'), bin = path.join(root, 'bin'), sources = path.join(root, 'job/sources'), capture = path.join(root, 'argv.json');
  await mkdir(bin); await mkdir(sources, { recursive: true });
  await writeFile(path.join(sources, 'search-123abc.json'), JSON.stringify({ provider: 'firecrawl', status: 'completed', intent: 'verify', query: 'Synthetic business', results: [{ url: 'https://fixture.example/', title: 'Synthetic business' }] }));
  await writeFile(path.join(bin, 'opencode'), `#!${process.execPath}\n(async()=>{const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));const output={candidates:[],shortfall:'Fixture only'};const {checkResearchOutput}=await import(${JSON.stringify(new URL('../src/research-check.mjs',import.meta.url).href)});await checkResearchOutput({directory:process.env.FACTORY_SOURCES,requestId:process.env.FACTORY_RESEARCH_REQUEST,candidateLimit:Number(process.env.FACTORY_RESEARCH_LIMIT),output});console.log(JSON.stringify({type:'text',sessionID:'fixture',part:{text:JSON.stringify(output)}}));})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});`, { mode: 0o700 });
  const budget = { discoverySearchesRemaining: 0, totalRemaining: { searches: 2, inspections: 3, imageViews: 1, modelRequests: 2 } };
  const script = `import {discover} from ${JSON.stringify(new URL('../src/research.mjs', import.meta.url).href)};await discover({candidateLimit:1,area:'Houston',niche:'Synthetic',deadlineMinutes:2},{jobRoot:${JSON.stringify(path.dirname(sources))},recheck:{name:'Exact Selected Fixture'},batch:{settings:{workflow:'leads_first',searchProvider:'firecrawl',maxSearches:12},phase:'enrichment',round:2,seen:[],budget:${JSON.stringify(budget)}}});`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { env: { PATH: bin, HOME: root }, timeout: 20000 });
  const prompt = JSON.parse(await readFile(capture, 'utf8')).at(-1);
  const snapshot = JSON.parse(prompt.split('\n').find(line => line.startsWith('HOST REMAINING BUDGET: ')).slice('HOST REMAINING BUDGET: '.length));
  assert.deepEqual(snapshot, budget); assert.match(prompt, /Finalize collected prospects BEFORE exhausting/); assert.match(prompt, /EXACTLY this already researched/); assert.match(prompt, /Exact Selected Fixture/);
});
