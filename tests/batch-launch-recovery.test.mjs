import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,chmod,symlink} from 'node:fs/promises';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {batchDispatch,BATCH_OPERATIONS,batchPreset,reconcileBatches} from '../src/batches.mjs';
import {seedDispatch} from '../src/seeds.mjs';
import {getBatch,saveBatch} from '../src/batch-store.mjs';
import {reserveBatchUsage,withJobBudget,jobBudgetContext} from '../src/batch-budget.mjs';
import {policyIdentity} from '../src/policy.mjs';
import {hash,now} from '../src/contracts.mjs';

const settings={area:'Houston city limits',niche:'mobile detailers, custom bakers, event decorators',workflow:'leads_first',targetCount:1,candidateLimit:6,maxResearchRounds:2,searchProvider:'firecrawl',maxSearches:16,discoverySearchLimit:6,maxInspections:48,maxImageViews:12,maxModelRequests:16,batchMinutes:90,jobMinutes:45};
async function fixture(t){
  const root=await mkdtemp('/tmp/factory-launch-recovery-'),options={dbPath:path.join(root,'db.sqlite'),stateRoot:path.join(root,'state'),autoRun:false};
  await initialize(options);const store=openStore(options);t.after(()=>store.close());
  await batchDispatch(store,'batch_preset_save',{version:0,requestId:'launch-recovery-setup',settings,acknowledged:true});
  const prepared=await seedDispatch(store,'seed_prepare',{presetVersion:1,requestId:'launch-recovery-seed',authorized:true},{preset:batchPreset(store),boundaryPreflight:()=>({release:'fictional-test-release',divisionId:'fictional-division'}),collectSeeds:async()=>({provider:'placeroot',retrievedAt:now(),version:{release:'fictional-test-release'},attribution:['Fictional offline fixture only'],limitations:['Unverified fixture, not an actual business'],items:[{id:'fictional-launch-seed',name:'Fictional Juniper Detail',location:{city:'Houston',region:'Texas',country:'US',lat:29.76,lon:-95.37},categories:['auto_detailing'],urls:[],provenance:{dataset:'Overture Maps',release:'fictional-test-release',sources:[{dataset:'fictional-fixture',license:'fixture-only'}]}}]})});
  const b=await batchDispatch(store,'batch_start',{presetVersion:1,requestId:'launch-recovery-start',authorized:true,seedReceipt:{id:prepared.id,digest:prepared.digest}},{prerequisites:async()=>({ready:true})});
  const parent=store.claim(b.researchJobIds[0]);
  store.updateJob(parent.id,{stage:'research'});store.event(parent.id,'stage.started','Starting research');
  reserveBatchUsage(store,parent.id,'modelRequests');
  store.event(parent.id,'stage.failed','Stopped research',{attempt:0,errorCode:'E2BIG'});
  store.updateJob(parent.id,{state:'failed',stage:'research',ownerPid:null,errorCode:'E2BIG',message:'spawn E2BIG'});
  store.event(parent.id,'job.stopped','spawn E2BIG',{errorCode:'E2BIG'});
  await batchDispatch(store,'batch_stop',{id:b.id});
  const service=createService(store,options),input={id:b.id,failedJobId:parent.id,policyDigest:(await policyIdentity('production')).digest,requestId:'launch-recovery-authority',authorized:true};
  return {root,options,store,service,input,b:getBatch(store,b.id),parent:store.job(parent.id),prepared};
}
const recover=f=>f.service.dispatch('batch_recover_launch',f.input);
const rows=store=>store.db.prepare("SELECT id,record FROM factory_operation ORDER BY rowid").all();

test('launch recovery has a strict explicit authority schema',()=>{
  const schema=BATCH_OPERATIONS.batch_recover_launch?.schema;
  assert.ok(schema,'shared batch recovery operation must exist');
  const input={id:'batch-fixture',failedJobId:'job-fixture',policyDigest:'a'.repeat(64),requestId:'explicit-recovery-fixture',authorized:true};
  assert.equal(schema.safeParse(input).success,true);
  for(const patch of [{authorized:false},{policyDigest:undefined},{seedReceipt:{}},{deadlineAt:now()},{settings}])assert.equal(schema.safeParse({...input,...patch}).success,false);
});
test('one child retains exact input, parent/events, settings/cohort, deadline and consumption; next launch is unit two',async t=>{
  const f=await fixture(t),beforeEvents=f.store.events(f.parent.id),parentRow=f.store.db.prepare('SELECT record FROM factory_job WHERE id=?').get(f.parent.id).record;
  const result=await recover(f),b=getBatch(f.store,f.b.id);
  assert.equal(result.batch.id,f.b.id);assert.equal(result.job.id,result.childJobId);
  assert.notEqual(result.job.id,f.parent.id);assert.equal(result.job.campaignId,f.parent.campaignId);
  assert.deepEqual(result.job.input,f.parent.input);assert.equal(result.job.attempt,0);assert.equal(result.job.retryLimit,0);
  assert.equal(b.state,'active');assert.equal(b.phase,'discovery');assert.equal(b.round,1);assert.equal(b.finishedAt,null);assert.ok(f.b.finishedAt);
  for(const field of ['settings','seedCohort','usage','discoveryUsage','deadlineAt','createdAt'])assert.deepEqual(b[field],f.b[field],field);
  assert.deepEqual(b.researchJobIds,[f.parent.id,result.job.id]);assert.deepEqual(b.processedResearchIds,[f.parent.id]);
  assert.equal(f.store.db.prepare('SELECT record FROM factory_job WHERE id=?').get(f.parent.id).record,parentRow);
  assert.deepEqual(f.store.events(f.parent.id),beforeEvents);
  assert.deepEqual(result.recovery.previousStoppedBatch,f.b);assert.equal(result.recovery.previousStoppedBatchDigest,hash(f.b));
  assert.equal(b.policyHistory.at(-1).requestId,f.input.requestId);
  await withJobBudget(f.store,result.job.id,()=>{const ctx=jobBudgetContext();reserveBatchUsage(ctx.store,ctx.jobId,'modelRequests');});
  assert.deepEqual(getBatch(f.store,f.b.id).usage,{modelRequests:2,searches:0,inspections:0,imageViews:0});
});
test('policy change is adopted only by explicit exact current digest and appended acknowledgement',async t=>{
  const f=await fixture(t),historical='1'.repeat(64);
  saveBatch(f.store,{...f.b,policyDigest:historical,policyHistory:[{policyDigest:historical,authority:'historical-fixture'}]});
  const result=await recover(f),b=getBatch(f.store,f.b.id);
  assert.equal(b.policyDigest,f.input.policyDigest);assert.equal(b.policyHistory.length,2);
  assert.equal(b.policyHistory[0].authority,'historical-fixture');assert.equal(b.policyHistory[1].previousPolicyDigest,historical);
  assert.equal(result.recovery.previousStoppedBatch.policyDigest,historical);
});
test('exact response-loss replay is stable across concurrent connections and restart, including a later stop',async t=>{
  const f=await fixture(t),second=openStore(f.options);t.after(()=>second.close());const service=createService(second,f.options);
  const results=await Promise.all([recover(f),service.dispatch('batch_recover_launch',f.input)]);
  assert.deepEqual(results[0],results[1]);assert.equal(f.store.jobs().length,2);
  await f.service.dispatch('batch_stop',{id:f.b.id});
  const before=rows(f.store);assert.deepEqual(await service.dispatch('batch_recover_launch',f.input),results[0]);assert.deepEqual(rows(f.store),before);
  await assert.rejects(service.dispatch('batch_recover_launch',{...f.input,requestId:'another-authority-id'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  await assert.rejects(service.dispatch('batch_recover_launch',{...f.input,policyDigest:'f'.repeat(64)}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  assert.equal(f.store.jobs().length,2);
});
test('reconcile ignores only the receipted immutable parent; a successful child is processed and a failed child holds',async t=>{
  for(const outcome of ['success','failure']){
    const f=await fixture(t),result=await recover(f);
    f.store.updateJob(result.job.id,outcome==='success'?{state:'review_ready',outputs:{candidateIds:[]}}:{state:'failed',errorCode:'E2BIG'});
    await reconcileBatches(f.store);const b=getBatch(f.store,f.b.id);
    assert.equal(b.state,'held');
    if(outcome==='success'){assert.ok(b.processedResearchIds.includes(result.job.id));assert.equal(b.phase,'discovery');assert.match(b.message,/no prospect eligible/);}
    else assert.match(b.message,/Research stopped/);
    await reconcileBatches(f.store);assert.equal(f.store.jobs().length,2);
  }
});
test('operator outcome does not mistake the verified recovered parent for the current discovery outcome',async t=>{
  const f=await fixture(t),result=await recover(f);
  f.store.updateJob(result.job.id,{state:'review_ready',outputs:{candidateIds:[]}});
  const b=getBatch(f.store,f.b.id);saveBatch(f.store,{...b,usage:{modelRequests:2,searches:1,inspections:1,imageViews:0}});
  await reconcileBatches(f.store);const detail=await f.service.dispatch('batch_get',{id:f.b.id});
  assert.equal(detail.batch.outcome.kind,'no_selectable_prospect');assert.equal(detail.batch.recoveredLaunchParentJobId,f.parent.id);
  assert.equal(detail.jobs.find(j=>j.id===f.parent.id).state,'failed');
  saveBatch(f.store,{...getBatch(f.store,f.b.id),state:'awaiting_selection',phase:'selection'});
  const selectionView=await f.service.dispatch('batch_get',{id:f.b.id});assert.equal(selectionView.progress.stages.find(v=>v.id==='discovery').state,'done');
});
test('processedResearchIds alone and tampered recovery bindings never suppress a historical failure',async t=>{
  for(const mutation of ['no_receipt','parent','events','child','receipt','result']){
    const f=await fixture(t);let result;
    if(mutation==='no_receipt')saveBatch(f.store,{...f.b,state:'active',phase:'discovery',processedResearchIds:[f.parent.id]});
    else {
      result=await recover(f);f.store.updateJob(result.job.id,{state:'review_ready',outputs:{candidateIds:[]}});
      if(mutation==='parent')f.store.updateJob(f.parent.id,{message:'Changed historical failure'});
      if(mutation==='events')f.store.event(f.parent.id,'tampered.event','New event after recovery');
      if(mutation==='child')f.store.updateJob(result.job.id,{input:{...result.job.input,round:2}});
      if(mutation==='receipt')f.store.db.prepare("UPDATE factory_operation SET record=json_set(record,'$.parentJobDigest',?) WHERE kind='batch_launch_recovery'").run('0'.repeat(64));
      if(mutation==='result')f.store.db.prepare("UPDATE factory_operation SET record=json_set(record,'$.result.childJobId','job-forged') WHERE kind='batch_launch_recovery'").run();
    }
    await reconcileBatches(f.store);assert.match(getBatch(f.store,f.b.id).message,/Research stopped/,mutation);
  }
});
test('invalid recovery receipt holds even while the child is queued, before another claim or charge',async t=>{
  const f=await fixture(t),result=await recover(f);
  f.store.event(f.parent.id,'changed.history','Immutable history changed');
  await reconcileBatches(f.store);
  assert.equal(getBatch(f.store,f.b.id).state,'held');
  assert.throws(()=>f.store.claim(result.job.id),e=>e.code==='BATCH_STOPPED');
  assert.equal(getBatch(f.store,f.b.id).usage.modelRequests,1);
});
test('recovery rejects wrong policy/error/attempt/state, source consumption, selection and missing or changed frozen seed/claim',async t=>{
  const mutations={
    policy:f=>{f.input.policyDigest='0'.repeat(64);},
    error:f=>f.store.updateJob(f.parent.id,{errorCode:'MODEL_UNCERTAIN'}),
    attempt:f=>f.store.updateJob(f.parent.id,{attempt:1}),
    active:f=>saveBatch(f.store,{...f.b,state:'active'}),
    acquisition:f=>saveBatch(f.store,{...f.b,acquisition:null}),
    campaign:f=>f.store.db.prepare("UPDATE factory_campaign SET record=json_set(record,'$.retryLimit',1) WHERE id=?").run(f.b.campaignId),
    searches:f=>saveBatch(f.store,{...f.b,usage:{...f.b.usage,searches:1}}),
    discovery:f=>saveBatch(f.store,{...f.b,discoveryUsage:{searches:1}}),
    model:f=>saveBatch(f.store,{...f.b,usage:{...f.b.usage,modelRequests:0}}),
    selection:f=>saveBatch(f.store,{...f.b,selection:{candidateId:'lead-fictional'}}),
    checkpoint:f=>saveBatch(f.store,{...f.b,checkpoint:{siteJobId:'job-fictional'}}),
    output:f=>f.store.updateJob(f.parent.id,{outputs:{candidateIds:[]}}),
    cohort:f=>saveBatch(f.store,{...f.b,seedCohort:{...f.b.seedCohort,items:[]}}),
    no_seed:f=>saveBatch(f.store,{...f.b,seedCohort:null}),
    claim:f=>f.store.db.prepare("UPDATE factory_operation SET record=json_set(record,'$.claimedBatchId','batch-other') WHERE id=?").run(f.prepared.id),
    event:f=>f.store.event(f.parent.id,'source.searched','Observed source activity'),
    reservation:f=>f.store.db.prepare("DELETE FROM factory_event WHERE job_id=? AND json_extract(record,'$.type')='batch.usage_reserved'").run(f.parent.id),
    source_attempt:f=>f.store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?)').run('source-attempt-fictional','source_attempt',JSON.stringify({id:'source-attempt-fictional',kind:'source_attempt',batchId:f.b.id,jobId:f.parent.id})),
    prospect:f=>f.store.saveCandidate(f.b.campaignId,{name:'Fictional already imported',area:'Houston',summary:'Fixture only'}),
  };
  for(const [label,mutate] of Object.entries(mutations)){
    const f=await fixture(t);mutate(f);const before=rows(f.store),jobs=f.store.jobs();
    await assert.rejects(recover(f),e=>/^(BATCH_|SEED_)/.test(e.code),label);assert.deepEqual(rows(f.store),before,label);assert.deepEqual(f.store.jobs(),jobs,label);
  }
});
test('changed immutable receipt bytes and symlinked launch evidence cannot be adopted',async t=>{
  for(const mutation of ['receipt_bytes','symlink']){
    const f=await fixture(t);
    if(mutation==='receipt_bytes'){
      const file=path.join(f.options.stateRoot,'references','seed-cohorts',f.prepared.id+'.json');await chmod(file,0o640);await writeFile(file,'{}');
    }else{
      const directory=path.join(f.options.stateRoot,'jobs',f.parent.id,'attempt-0');await mkdir(directory,{recursive:true});
      await symlink(f.root,path.join(directory,'sources'));
    }
    const before=rows(f.store);await assert.rejects(recover(f),e=>/^(BATCH_|SEED_)/.test(e.code));assert.deepEqual(rows(f.store),before);assert.equal(f.store.jobs().length,1);
  }
});
test('any cache/checkpoint/source bytes, including unregistered files, block recovery',async t=>{
  for(const relative of ['model-fictional.json','checkpoint-research.json','sources/search-fictional.json','sources/research-check-fictional.json']){
    const f=await fixture(t),file=path.join(f.options.stateRoot,'jobs',f.parent.id,'attempt-0',relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'{}');
    await assert.rejects(recover(f),e=>e.code==='BATCH_RECOVERY_EVIDENCE');assert.equal(f.store.jobs().length,1);
  }
});
test('deadline, completion reserve and another open batch are enforced without resetting anything',async t=>{
  for(const mutation of ['expired','time_reserve','model_reserve','other_batch']){
    const f=await fixture(t);
    if(mutation==='expired')saveBatch(f.store,{...f.b,deadlineAt:'2020-01-01T00:00:00.000Z'});
    if(mutation==='time_reserve')saveBatch(f.store,{...f.b,deadlineAt:new Date(Date.now()+60000).toISOString()});
    if(mutation==='model_reserve')saveBatch(f.store,{...f.b,acquisition:{...f.b.acquisition,reserve:{...f.b.acquisition.reserve,modelRequests:16}}});
    if(mutation==='other_batch')f.store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?)').run('batch-other','batch',JSON.stringify({...f.b,id:'batch-other',state:'held'}));
    const before=rows(f.store);await assert.rejects(recover(f));assert.deepEqual(rows(f.store),before);assert.equal(f.store.jobs().length,1);
  }
});
test('child enqueue failure rolls back recovery, policy adoption and active-state transition',async t=>{
  const f=await fixture(t),before=rows(f.store),events=f.store.events(f.parent.id);
  f.store.db.exec("CREATE TRIGGER reject_recovery_child BEFORE INSERT ON factory_job BEGIN SELECT RAISE(ABORT,'fixture child insert failed'); END");
  await assert.rejects(recover(f),/fixture child insert failed/);
  assert.deepEqual(rows(f.store),before);assert.deepEqual(f.store.events(f.parent.id),events);assert.equal(f.store.jobs().length,1);
});
