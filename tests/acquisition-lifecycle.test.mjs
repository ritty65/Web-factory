import test from 'node:test';
import assert from 'node:assert/strict';
import {acquisitionFixture} from './helpers-acquisition.mjs';
import {getBatch,saveBatch} from '../src/batch-store.mjs';
import {reconcileBatches} from '../src/batches.mjs';
import {reserveBatchUsage} from '../src/batch-budget.mjs';
import {assessProspect} from '../src/prospects.mjs';
import {hash} from '../src/contracts.mjs';
import {intakeFixture} from './helpers-batch.mjs';
import {discoveryQueries} from '../src/acquisition.mjs';

async function pause(f,material=true){
  const evidence=intakeFixture();if(!material)delete evidence.candidate.activityEvidence;
  const c=f.store.saveCandidate(f.b.campaignId,evidence.candidate),p=assessProspect(c,evidence,f.settings);
  f.store.updateJob(f.job.id,{state:'review_ready',outputs:{candidateIds:[c.id],intake:[{candidateId:c.id,ready:material,reasons:[],contacts:[],prospect:p}]}});
  await reconcileBatches(f.store);return c;
}
test('new leads-first runs freeze acquisition policy without editing saved scope or old records',async t=>{
  const f=await acquisitionFixture(t);assert.equal(f.b.acquisition.version,1);assert.equal(f.b.acquisition.reserve.inspections,6);
  assert.deepEqual(f.b.settings,f.settings);assert.equal(f.store.jobs().length,1);
});
test('an otherwise screened prospect with missing material cannot invite or start selection',async t=>{
  const f=await acquisitionFixture(t),c=await pause(f,false),b=getBatch(f.store,f.b.id);
  assert.equal(b.state,'held');const p=(await f.service.dispatch('lead_list',{batchId:b.id})).items[0];
  assert.equal(p.screening.status,'clear_for_enrichment');assert.equal(p.material.feasible,false);assert.equal(p.canSelect,false);
  assert.ok(p.reasons.some(r=>r.includes('Material check')));
  await assert.rejects(f.service.dispatch('batch_build_selected',{id:b.id,candidateId:c.id,evidenceDigest:hash(c),requestId:'no-material-select',authorized:true}));
  assert.equal(f.store.jobs().length,1);
});
test('discovery cannot consume completion floors; a denial does not consume another unit',async t=>{
  const f=await acquisitionFixture(t);
  for(let n=0;n<6;n++)reserveBatchUsage(f.store,f.job.id,'inspections');
  assert.throws(()=>reserveBatchUsage(f.store,f.job.id,'inspections'),e=>e.code==='BATCH_COMPLETION_BUDGET');
  assert.equal(getBatch(f.store,f.b.id).usage.inspections,6);
  for(let n=0;n<8;n++)reserveBatchUsage(f.store,f.job.id,'modelRequests');
  assert.throws(()=>reserveBatchUsage(f.store,f.job.id,'modelRequests'),e=>e.code==='BATCH_COMPLETION_BUDGET');
  assert.equal(getBatch(f.store,f.b.id).usage.modelRequests,8);
});
test('insufficient completion time holds selection without new work or deadline changes',async t=>{
  const f=await acquisitionFixture(t),c=await pause(f),original=getBatch(f.store,f.b.id),deadline=new Date(Date.now()+10*60000).toISOString();
  saveBatch(f.store,{...original,deadlineAt:deadline});
  await assert.rejects(f.service.dispatch('batch_build_selected',{id:f.b.id,candidateId:c.id,evidenceDigest:hash(c),requestId:'not-enough-time',authorized:true}),e=>e.code==='BATCH_COMPLETION_BUDGET');
  assert.equal(f.store.jobs().length,1);assert.equal(getBatch(f.store,f.b.id).deadlineAt,deadline);assert.deepEqual(getBatch(f.store,f.b.id).usage,original.usage);
});
test('enrichment preserves six native launches for production and failed calls do not refund',async t=>{
  const f=await acquisitionFixture(t),c=await pause(f),selected=await f.service.dispatch('batch_build_selected',{id:f.b.id,candidateId:c.id,evidenceDigest:hash(c),requestId:'reserve-craft',authorized:true});
  for(let n=0;n<10;n++)reserveBatchUsage(f.store,selected.job.id,'modelRequests');
  assert.throws(()=>reserveBatchUsage(f.store,selected.job.id,'modelRequests'),e=>e.code==='BATCH_COMPLETION_BUDGET');
  assert.equal(getBatch(f.store,f.b.id).usage.modelRequests,10);
});
test('two niche categories do not collapse the query matrix onto the same four pairs',()=>{
  const q=discoveryQueries({area:'Houston city limits',niche:'custom bakers/event decorators'});
  assert.equal(q.length,8);assert.equal(new Set(q.map(v=>v.query)).size,8);
});
for(const viable of [true,false])test(`two-round scheduling ${viable?'pauses immediately for a viable prospect':'holds before a nonviable extra launch crosses the reserve'}`,async t=>{
  const f=await acquisitionFixture(t,{candidateLimit:6,maxResearchRounds:2,maxModelRequests:9});
  reserveBatchUsage(f.store,f.job.id,'modelRequests');await pause(f,viable);
  const b=getBatch(f.store,f.b.id);assert.equal(b.state,viable?'awaiting_selection':'held');assert.equal(b.round,1);assert.equal(f.store.jobs().length,1);
  assert.equal(b.usage.modelRequests,1);assert.equal(b.deadlineAt,f.b.deadlineAt);
});
