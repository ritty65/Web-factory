import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {executeJob} from '../src/worker.mjs';
import {reconcileBatches} from '../src/batches.mjs';
import {hash,now} from '../src/contracts.mjs';
import {intakeFixture} from './helpers-batch.mjs';
import {getBatch,saveBatch} from '../src/batch-store.mjs';

const settings={area:'Houston city limits',niche:'Synthetic screening tests only',targetCount:1,candidateLimit:1,maxResearchRounds:1,searchProvider:'guest_bing',maxSearches:8,discoverySearchLimit:4,maxInspections:12,maxImageViews:6,maxModelRequests:10,batchMinutes:60,jobMinutes:10,workflow:'leads_first'};
async function fixture(t){
  const root=await mkdtemp('/tmp/screen-progress-'),options={dbPath:path.join(root,'fixture.sqlite3'),stateRoot:path.join(root,'state'),autoRun:false,batchPrerequisites:async()=>({ready:true})};
  await initialize(options);const store=openStore(options);t.after(()=>store.close());const service=createService(store,options);
  await service.dispatch('batch_preset_save',{version:0,requestId:'screening-preset',settings,acknowledged:true});
  const batch=await service.dispatch('batch_start',{presetVersion:1,requestId:'screening-start',authorized:true});return {root,store,service,batch};
}
for(const {blocked,legacy} of [{blocked:false,legacy:false},{blocked:true,legacy:false},{blocked:false,legacy:true}])test(`shared service ${legacy?'preserves historical lightweight selection without silently adopting scouting':blocked?'rejects unresolved early screening before any selection write':'holds materially incomplete new-mode prospects without a site'}`,async t=>{
   const {store,service,batch}=await fixture(t),f=intakeFixture();
   if(legacy){const previous=getBatch(store,batch.id);delete previous.acquisition;saveBatch(store,previous);}
  f.candidate.websiteCheck={status:'unknown',queries:[],checkedAt:now(),linkChecks:[]};delete f.candidate.media;delete f.candidate.activityEvidence;delete f.candidate.pagePurposes;
  if(blocked)f.observations[0].links.push({url:'https://business.example/',text:'Website'});
  const done=await executeJob(store,batch.researchJobIds[0],{discover:async(_,ctx)=>{
    const dir=path.join(ctx.jobRoot,'sources');await mkdir(dir,{recursive:true});
    for(const o of f.observations)await writeFile(path.join(dir,o.id+'.json'),JSON.stringify(o));
    return {candidates:[f.candidate],live:false};
  }});assert.equal(done.state,'review_ready',done.message);await reconcileBatches(store);
   const lead=(await service.dispatch('lead_list',{batchId:batch.id})).items[0];assert.equal(lead.canSelect,legacy&&!blocked);
   if(!legacy)assert.equal(lead.material.feasible,false);
  const before=store.jobs().length;
  if(blocked){
    assert.equal(getBatch(store,batch.id).state,'held');
    // Retain the deeper selection guard coverage for historical paused records,
    // independently of the new reconcile-time empty-shortlist hold.
    saveBatch(store,{...getBatch(store,batch.id),state:'awaiting_selection',phase:'selection'});
    await assert.rejects(service.dispatch('batch_build_selected',{id:batch.id,candidateId:lead.id,evidenceDigest:lead.evidenceDigest,requestId:'screening-bypass-attempt',authorized:true}),e=>e.code==='BATCH_SCREENING');
    assert.equal(store.jobs().length,before);assert.equal((await service.dispatch('batch_get',{id:batch.id})).batch.selection,null);
  }
  assert.equal(store.jobs().filter(j=>j.kind==='site').length,0);
});
test('batch progress uses retained events/attempts, does not expose raw event details or invent a completion percentage',async t=>{
  const {store,service,batch}=await fixture(t),job=batch.researchJobIds[0];
  store.event(job,'batch.usage_reserved','UNTRUSTED_RAW_MESSAGE',{unit:'inspections',used:1,cap:12,secret:'DO_NOT_EXPORT'});
  const changes=store.db.prepare('SELECT total_changes() n').get().n;
  const detail=await service.dispatch('batch_get',{id:batch.id});assert.ok(detail.progress);
  assert.equal(detail.progress.stages[0].state,'queued');
  assert.equal(detail.progress.activity.at(-1).label,'Page inspection attempt reserved');
  assert.equal(JSON.stringify(detail.progress).includes('UNTRUSTED_RAW_MESSAGE'),false);assert.equal(JSON.stringify(detail.progress).includes('DO_NOT_EXPORT'),false);
  assert.equal(detail.progress.completionPercent,undefined);assert.equal(store.db.prepare('SELECT total_changes() n').get().n,changes);
});
test('a stopped shortfall never marks unbuilt production or human review complete',async t=>{
  const {service,batch}=await fixture(t);await service.dispatch('batch_stop',{id:batch.id});
  const detail=await service.dispatch('batch_get',{id:batch.id});assert.ok(detail.progress);
  assert.equal(detail.progress.running,false);
  for(const key of ['production','first_site_review'])assert.equal(detail.progress.stages.find(s=>s.id===key).state,'pending');
});
test('a fresh operator note cannot rejuvenate stale worker activity',async t=>{
  const {store,service,batch}=await fixture(t),job=batch.researchJobIds[0];store.claim(job);
  const c=store.saveCandidate(batch.campaignId,intakeFixture().candidate);
  saveBatch(store,{...getBatch(store,batch.id),members:[{candidateId:c.id,evidenceDigest:hash(c),ready:false,reasons:[],contacts:[]}]});
  const old=new Date(Date.now()-90000).toISOString();
  for(const r of store.db.prepare('SELECT seq,record FROM factory_event WHERE job_id=?').all(job)){
    const record=JSON.parse(r.record);record.at=old;store.db.prepare('UPDATE factory_event SET record=? WHERE seq=?').run(JSON.stringify(record),r.seq);
  }
  await service.dispatch('batch_item_note',{id:batch.id,candidateId:c.id,requestId:'stale-worker-note',disposition:'note',note:'Operator annotation only; no new worker activity.'});
  const detail=await service.dispatch('batch_get',{id:batch.id});assert.equal(detail.progress.lastActivityAt,old);
  assert.ok(Date.parse(detail.batch.updatedAt)>Date.parse(detail.progress.lastActivityAt));
});
test('historical discovery does not falsely claim the new early screening stage was recorded',async t=>{
  const {store,service,batch}=await fixture(t),c=store.saveCandidate(batch.campaignId,intakeFixture().candidate);
  store.updateJob(batch.researchJobIds[0],{state:'review_ready'});
  saveBatch(store,{...getBatch(store,batch.id),state:'stopped',phase:'complete',members:[{candidateId:c.id,evidenceDigest:hash(c),ready:false,reasons:[],contacts:[]}]});
  const detail=await service.dispatch('batch_get',{id:batch.id});
  assert.equal(detail.progress.stages[0].label,'Get leads');assert.equal(detail.progress.counts.screened,0);
});
for(const phrase of ['Katy-based workshop.','Based out of Katy.'])test(`selection cannot spend on a city-scope conflict: ${phrase}`,async t=>{
  const {store,service,batch}=await fixture(t),f=intakeFixture();f.observations[0].text+=' '+phrase+' Serving Houston.';
  const done=await executeJob(store,batch.researchJobIds[0],{discover:async(_,ctx)=>{
    const dir=path.join(ctx.jobRoot,'sources');await mkdir(dir,{recursive:true});
    for(const o of f.observations)await writeFile(path.join(dir,o.id+'.json'),JSON.stringify(o));
    return {candidates:[f.candidate],live:false};
  }});assert.equal(done.state,'review_ready');await reconcileBatches(store);
  const lead=(await service.dispatch('lead_list',{batchId:batch.id})).items[0];assert.equal(lead.canSelect,false);
  assert.equal(getBatch(store,batch.id).state,'held');
  saveBatch(store,{...getBatch(store,batch.id),state:'awaiting_selection',phase:'selection'});
  await assert.rejects(service.dispatch('batch_build_selected',{id:batch.id,candidateId:lead.id,evidenceDigest:lead.evidenceDigest,requestId:'scope-bypass-attempt',authorized:true}),e=>e.code==='BATCH_SCREENING');
  assert.equal(store.jobs().length,1);assert.equal((await service.dispatch('batch_get',{id:batch.id})).batch.selection,null);
});
