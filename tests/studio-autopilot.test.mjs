import test from 'node:test';import assert from 'node:assert/strict';
import {autopilotFixture} from './helpers-studio-autopilot.mjs';
import {autopilotDispatch,studioReadiness} from '../src/studio-autopilot.mjs';
import {settingsDigest,saveSettings} from '../src/studio-config.mjs';
import {executeJob} from '../src/worker.mjs';import {record,saveRecord,records} from '../src/studio-state.mjs';

const start=f=>autopilotDispatch(f.store,'studio_autopilot_start',{version:0,settingsDigest:settingsDigest(f.store),requestId:'start-fixed-fixture-pilot',authorized:true},{request:f.request});
test('readiness distinguishes simulated checks from live account access',async t=>{const f=await autopilotFixture(t);assert.equal((await studioReadiness(f.store)).ready,false);assert.equal((await studioReadiness(f.store,{allowFixture:true})).ready,true);});
test('start queues one owned daily job, replay makes no calls, and pause preserves the campaign/ledger',async t=>{
 const f=await autopilotFixture(t),before=f.calls.length,a=await start(f);assert.equal(a.queued,true);assert.equal(f.calls.length,before);const b=await start(f);assert.equal(b.replayed,true);assert.equal(a.jobId,b.jobId);const paused=await autopilotDispatch(f.store,'studio_autopilot_pause',{version:1},{request:f.request});assert.equal(paused.enabled,false);assert.equal(f.store.job(a.jobId).state,'cancelled');assert.equal(f.store.campaigns().length,1);
});
test('missing required Apollo capability cannot be silently replaced by another source',async t=>{
 const f=await autopilotFixture(t);const check=record(f.store,'provider-check-apollo','studio_provider_check');saveRecord(f.store,'provider-check-apollo','studio_provider_check',{...check,capabilities:{companySearch:true}});await assert.rejects(start(f),e=>e.code==='SETUP_INCOMPLETE');assert.equal(f.store.jobs().length,0);
});
test('known source failure pauses the pilot and retains the attempted request',async t=>{
 const f=await autopilotFixture(t,{requestFailure:429}),a=await start(f);const result=await executeJob(f.store,a.jobId,{studioRequest:f.request,observeSource:f.observe});assert.equal(result.state,'blocked');assert.equal(result.errorCode,'PROVIDER_RATE_LIMIT');assert.equal(record(f.store,'studio-autopilot','studio_autopilot').enabled,false);assert.ok(records(f.store,'studio_spend').some(r=>r.purpose==='lead:discovery'&&r.state==='failed'));
});
test('shared phone pointers are held on both sides and do not trigger paid enrichment or builds',async t=>{
 const f=await autopilotFixture(t,{count:3,sharedPhones:true}),a=await start(f);const before=f.calls.length,result=await executeJob(f.store,a.jobId,{studioRequest:f.request,observeSource:f.observe});assert.equal(result.state,'review_ready',result.message);const assessments=records(f.store,'studio_assessment');assert.equal(assessments.length,3);assert.ok(assessments.every(a=>a.state==='held'));assert.equal(f.store.jobs().filter(j=>j.kind==='site').length,0);assert.equal(f.calls.length-before,1);
});
test('source-checked automatic proof is distinct from an operator-supplied confirmation',async t=>{
 const f=await autopilotFixture(t,{count:1}),a=await start(f);const result=await executeJob(f.store,a.jobId,{studioRequest:f.request,observeSource:f.observe});assert.equal(result.state,'review_ready',result.errorCode+': '+result.message);const assessment=records(f.store,'studio_assessment')[0];assert.equal(assessment.state,'source_checked',assessment.reasons.join(';'));assert.equal(assessment.publicRelease,false);assert.equal(assessment.buyingInterest,'unknown');const site=f.store.jobs().find(j=>j.kind==='site');assert.ok(site?.input.apiConcept);assert.equal(site.input.ownerIntake,undefined);assert.equal(f.store.candidates().length,0);assert.equal(f.store.businesses().length,0);assert.equal(records(f.store,'studio_intake').length,0);
 // Tampering with a source receipt stops the generated proof before coding.
 const observation=record(f.store,assessment.observationRefs[0].id,'studio_observation');saveRecord(f.store,observation.id,'studio_observation',{...observation,text:'Tampered source'});const stopped=await executeJob(f.store,site.id,{studioRequest:f.request});assert.equal(stopped.errorCode,'SOURCE_PROOF_BINDING');
});
test('changing the saved target cannot reset a frozen cohort or its build allowance',async t=>{
 const f=await autopilotFixture(t);const activated=await start(f);await autopilotDispatch(f.store,'studio_autopilot_pause',{version:1},{request:f.request});const changed=structuredClone(f.data);changed.niche='plumbing';await saveSettings(f.store,{version:1,data:changed,credentials:{}});const result=await autopilotDispatch(f.store,'studio_autopilot_tick',{}, {request:f.request});assert.equal(result.state,'disabled');assert.equal(f.store.campaigns().length,1);
});
