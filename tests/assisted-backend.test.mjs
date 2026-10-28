import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assistedFixture, assistedStore } from './helpers-assisted.mjs';
import { candidateInput, hash } from '../src/contracts.mjs';
import { assessIntake } from '../src/intake.mjs';
import { policyIdentity } from '../src/policy.mjs';
import { getBatch, saveBatch, guardBatchJob } from '../src/batch-store.mjs';
import { reserveBatchUsage } from '../src/batch-budget.mjs';
import { reconcileBatches } from '../src/batches.mjs';

const backend = () => import('../src/assisted.mjs');
const evidence = () => import('../src/assisted-evidence.mjs');
async function save(store, input) { return (await backend()).assistedDispatch(store, 'assisted_save', input); }
async function build(store, saved, requestId = 'build-fixture-1') { return (await backend()).assistedDispatch(store, 'assisted_build', { id: saved.id, bundleDigest: saved.bundleDigest, evidenceDigest: saved.evidenceDigest, policyDigest: (await policyIdentity('production')).digest, requestId, authorized: true }); }

test('booking segment is explicit, default intake unchanged, unresolved custom websites still hold', async () => {
  const f = await assistedFixture(), c = candidateInput(f.bundle.candidate);
  assert.equal(assessIntake(c, f.bundle).ready, false);
  assert.equal(assessIntake(c, f.bundle, { segment: f.bundle.segment }).ready, true);
  f.bundle.observations[0].links.push({ url: 'https://juniper.example.com/', text: 'Our website' });
  assert.equal(assessIntake(c, f.bundle, { segment: f.bundle.segment }).ready, false);
});
test('save/get retain immutable external evidence and prepared media, without candidates or jobs', async t => {
  const store = await assistedStore(t), input = await assistedFixture(), saved = await save(store, input);
  assert.equal(saved.assessment.ready, true, saved.assessment.reasons.join('\n'));
  assert.equal(store.jobs().length, 0); assert.equal(store.candidates().length, 0);
  assert.deepEqual(await save(store, input), saved);
  const got = await (await backend()).assistedDispatch(store, 'assisted_get', { id: saved.id });
  assert.equal(got.provenance, 'operator_imported_externally_observed');
  assert.equal(JSON.stringify(got).includes('originalBase64'), false);
  assert.equal(JSON.stringify(got).includes('mediaUrl'), false);
  assert.equal(JSON.stringify(got).includes('Synthetic public workshop evidence'), false);
  const resolved = (await evidence()).readAssistedEvidence(store, saved);
  assert.equal(resolved.media.length, 1); assert.equal(resolved.candidate.name, input.bundle.candidate.name);
  input.bundle.candidate.summary += ' Changed';
  await assert.rejects(save(store, input), { code: 'IDEMPOTENCY_CONFLICT' });
});
test('build is one atomic proof-wide claim with exact original usage and no fake research jobs', async t => {
  const store = await assistedStore(t), input = await assistedFixture(), saved = await save(store, input);
  const [a, b] = await Promise.all([build(store, saved), build(store, saved)]);
  assert.equal(a.job.id, b.job.id); assert.equal(store.jobs().length, 1);
  assert.equal(a.job.kind, 'site'); assert.equal(a.batch.deadlineAt, input.scope.deadlineAt);
  assert.deepEqual(a.batch.usage, input.usage); assert.equal(a.batch.assistedIntake.id, saved.id);
  assert.equal(a.batch.enrichmentJobId, undefined); assert.equal(a.batch.researchJobIds.length, 0);
  await assert.rejects(build(store, saved, 'different-build'), { code: 'ASSISTED_CLAIMED' });
  assert.equal(store.claim(a.job.id).state, 'running');
});
test('proof scope and usage cannot reset across save IDs; malformed and native claims reject', async t => {
  const store = await assistedStore(t), f = await assistedFixture(); await save(store, f);
  for (const mutate of [v => { v.usage.searches--; }, v => { v.scope.deadlineAt = new Date(Date.parse(v.scope.deadlineAt) + 1).toISOString(); }, v => { v.bundle.observations[0].method = 'fresh_guest_rendered_dom'; }, v => { v.bundle.assets[0].sha256 = '0'.repeat(64); }]) {
    const v = structuredClone(f); v.requestId = `save-negative-${Math.random().toString(16).slice(2)}`; mutate(v);
    await assert.rejects(save(store, v));
  }
  assert.equal(store.jobs().length, 0);
});
test('bundle file mutation and stale candidate bindings prevent claim', async t => {
  const store = await assistedStore(t), f = await assistedFixture(), saved = await save(store, f), result = await build(store, saved);
  const c = store.candidate(result.job.input.candidateId);
  store.db.prepare('UPDATE factory_candidate SET record=? WHERE id=?').run(JSON.stringify({ ...c, summary: 'Tampered' }), c.id);
  assert.throws(() => store.claim(result.job.id), { code: 'BATCH_ASSISTED_BINDING' });
});
test('media bytes are rehashed on every evidence read', async t => {
  const store = await assistedStore(t), f = await assistedFixture(), saved = await save(store, f);
  const resolved = (await evidence()).readAssistedEvidence(store, saved);
  const file = path.join(resolved.root, resolved.media[0].original_file);
  const bytes = await readFile(file); await writeFile(file, Buffer.concat([bytes, Buffer.from('tampered')]));
  const evidenceModule = await evidence();
  assert.throws(() => evidenceModule.readAssistedEvidence(store, saved), { code: 'BATCH_ASSISTED_BINDING' });
});
test('known third-party presence routes can remain unreadable without becoming verified content', async () => {
  const f=await assistedFixture(),c=f.bundle.candidate,at=f.bundle.observations[0].inspectedAt;
  for(const [route,final] of [['https://www.tiktok.com/@juniper1','https://www.tiktok.com/@juniper1'],['https://g.page/r/AbC123/review','https://www.google.com/sorry/index']]){
    const sourceId=`external-presence-${f.bundle.observations.length}`;
    f.bundle.observations[0].links.push({url:route,text:'Published business presence'});
    f.bundle.observations.push({id:sourceId,url:route,finalUrl:final,title:'Incomplete third-party presence',text:'',blocked:true,inspectedAt:at,method:'assisted_external_guest_dom',sourceKind:'external_observation',captureRef:'external-route-capture',links:[],images:[]});
    c.websiteCheck.linkChecks.push({url:route,sourceId,status:'unofficial',reason:'Known third-party public presence route; body remains unknown.'});
  }
  assert.equal(assessIntake(candidateInput(c),f.bundle,{segment:f.bundle.segment}).ready,true);
  const o=f.bundle.observations.at(-1);o.finalUrl='https://juniper.example.com/';
  assert.equal(assessIntake(candidateInput(c),f.bundle,{segment:f.bundle.segment}).ready,false);
});
test('presence classification rejects Google redirect parameters and TikTok custom redirects', async () => {
  for(const [route,final]of [['https://www.google.com/maps?url=https%3A%2F%2Fjuniper.example.com','https://www.google.com/sorry/index'],['https://g.page/r/AbC123/review','https://www.google.com/sorry/index?continue=https%3A%2F%2Fjuniper.example.com'],['https://www.tiktok.com/@juniper1','https://juniper.example.com/']]){
    const f=await assistedFixture();f.bundle.observations[0].links.push({url:route,text:'Potential website'});
    f.bundle.observations.push({...f.bundle.observations[1],id:'external-potential-route',url:route,finalUrl:final,blocked:true,text:''});
    f.bundle.candidate.websiteCheck.linkChecks.push({url:route,sourceId:'external-potential-route',status:'unofficial',reason:'Unknown redirect cannot establish independent-site absence.'});
    assert.equal(assessIntake(candidateInput(f.bundle.candidate),f.bundle,{segment:f.bundle.segment}).ready,false);
  }
});
test('functioning independent website always excludes approved booking segment', async () => {
  const f=await assistedFixture(),route='https://juniper.example.com/';
  f.bundle.observations[0].links.push({url:route,text:'Official website'});
  f.bundle.observations.push({...f.bundle.observations[1],id:'external-official-site',url:route,finalUrl:route});
  f.bundle.candidate.websiteCheck.linkChecks.push({url:route,sourceId:'external-official-site',status:'official',reason:'Identity-matched official website observed.'});
  const gate=assessIntake(candidateInput(f.bundle.candidate),f.bundle,{segment:f.bundle.segment});
  assert.equal(gate.ready,false);assert.match(gate.reasons.join(' '),/functioning website/);
});
test('held supplied facts cannot build, and malformed/stale/wrong-account/oversized assets reject or hold', async t => {
  const store=await assistedStore(t);
  const cases=[
    f=>{f.bundle.candidate.facts[0].excerpt='Invented excerpt';},
    f=>{f.bundle.candidate.media[0].account='https://www.instagram.com/wrongaccount/';},
    f=>{f.bundle.observations[0].inspectedAt=new Date(Date.parse(f.scope.startedAt)-1).toISOString();},
    f=>{f.bundle.observations[0].evidenceContextVersion=1;},
    f=>{f.bundle.assets[0].originalBase64=Buffer.from('not an image').toString('base64');f.bundle.assets[0].sha256=hash(Buffer.from('not an image'));f.bundle.imageViews[0].pixelsSha256=f.bundle.assets[0].sha256;},
    f=>{f.bundle.observations[0].images[0].width=900;},
    f=>{f.bundle.observations[0].images[0].postUrl='https://www.instagram.com/p/different/';},
    f=>{f.bundle.assets[0].originalBase64='A'.repeat(1048576);},
  ];
  for(let i=0;i<cases.length;i++){
    const f=await assistedFixture();f.requestId=`negative-source-${i}`;f.scope.authorizationId=`negative-proof-${i}`;cases[i](f);
    let saved;try{saved=await save(store,f);}catch{continue;}
    assert.equal(saved.assessment.ready,false,`case ${i} unexpectedly qualified`);
    await assert.rejects(build(store,saved));
  }
  assert.equal(store.jobs().length,0);
});
test('claim rejects unbound jobs, stopped batches, source jobs and exhausted model allowance', async t => {
  const store=await assistedStore(t),f=await assistedFixture(),saved=await save(store,f),r=await build(store,saved);
  assert.throws(()=>guardBatchJob(store,{campaignId:r.batch.campaignId,kind:'site',input:{candidateId:r.job.input.candidateId}}),{code:'BATCH_ASSISTED_BINDING'});
  assert.throws(()=>store.createJob({campaignId:r.batch.campaignId,kind:'source',input:{url:'https://www.instagram.com/juniper1/'}}));
  saveBatch(store,{...getBatch(store,r.batch.id),state:'stopped'});
  assert.throws(()=>store.claim(r.job.id),{code:'BATCH_STOPPED'});
  saveBatch(store,{...getBatch(store,r.batch.id),state:'active'});
  store.claim(r.job.id);
  for(let i=0;i<16;i++)assert.equal(reserveBatchUsage(store,r.job.id,'modelRequests').used,i+1);
  assert.throws(()=>reserveBatchUsage(store,r.job.id,'modelRequests'),{code:'BATCH_BUDGET'});
});
test('reconciliation pauses for ordinary first-site review and never queues assisted discovery/replacement', async t => {
  const store=await assistedStore(t),saved=await save(store,await assistedFixture()),r=await build(store,saved);
  store.updateJob(r.job.id,{state:'blocked',errorCode:'DESIGN_SELECTION'});
  await reconcileBatches(store);assert.equal(store.jobs().length,1);assert.equal(getBatch(store,r.batch.id).state,'held');
  saveBatch(store,{...getBatch(store,r.batch.id),state:'active'});
  store.updateJob(r.job.id,{state:'review_ready',outputs:{siteDigest:'a'.repeat(64),qaPass:true,reviewStatus:'operator_review_required',humanDecision:null,publicRelease:false}});
  await reconcileBatches(store,{promote:async()=>({status:'synthetic_test_only'})});
  assert.equal(getBatch(store,r.batch.id).state,'awaiting_first_review');assert.equal(store.jobs().length,1);
});
test('new bundles cannot reset proof usage and an older bundle builds with latest charged usage', async t => {
  const store=await assistedStore(t),f=await assistedFixture(),saved=await save(store,f);
  f.requestId='save-fixture-newer';f.usage.inspections++;
  await save(store,f);
  const r=await build(store,saved);assert.equal(r.batch.usage.inspections,f.usage.inspections);
});
test('spent reservation counters cannot be reset and production completion floor applies', async t => {
  const store=await assistedStore(t),f=await assistedFixture(),saved=await save(store,f),r=await build(store,saved);
  store.claim(r.job.id);reserveBatchUsage(store,r.job.id,'modelRequests');
  saveBatch(store,{...getBatch(store,r.batch.id),usage:{...r.batch.usage}});
  assert.throws(()=>guardBatchJob(store,store.job(r.job.id),{claiming:true}),{code:'BATCH_ASSISTED_BINDING'});
});
test('insufficient remaining production capacity holds before any batch/candidate/job', async t => {
  const store=await assistedStore(t),f=await assistedFixture();f.usage.modelRequests=11;
  const saved=await save(store,f);await assert.rejects(build(store,saved),{code:'BATCH_COMPLETION_BUDGET'});
  assert.equal(store.jobs().length,0);assert.equal(store.candidates().length,0);
});
