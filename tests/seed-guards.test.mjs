import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod} from 'node:fs/promises';
import path from 'node:path';
import {initialize,openStore} from '../src/db.mjs';
import {seedDispatch,validateSeedReceipt,claimSeedReceipt} from '../src/seeds.mjs';
import {operationRecord} from '../src/pilot.mjs';
import {transaction} from '../src/sales.mjs';
import {guardBatchJob,saveBatch,getBatch} from '../src/batch-store.mjs';

async function fixture(t){
  const root=await mkdtemp('/tmp/factory-seed-guards-'),options={dbPath:path.join(root,'db.sqlite3'),stateRoot:path.join(root,'state')};
  await initialize(options);const store=openStore(options);t.after(()=>{store.close();return rm(root,{recursive:true,force:true});});
  const settings={area:'Houston city limits',niche:'Mobile auto detailers, custom bakers and event decorators',targetCount:1,candidateLimit:6,maxResearchRounds:2,searchProvider:'firecrawl',maxSearches:16,maxInspections:48,maxImageViews:12,maxModelRequests:16,batchMinutes:90,jobMinutes:45,workflow:'leads_first',discoverySearchLimit:6};
  const source={provider:'placeroot',retrievedAt:new Date().toISOString(),version:'synthetic-release',attribution:['Synthetic source — not real Overture data'],limitations:['Fixture only'],items:[{id:'fictional-gers-1',name:'Fictional Blue Detailer',location:{city:'Houston',lat:29.76,lon:-95.36},categories:['car_detailing'],urls:[],provenance:{dataset:'fictional',license:'CC0-1.0'}}]};
  const preview=await seedDispatch(store,'seed_prepare',{presetVersion:1,requestId:'guard-cohort',authorized:true},{preset:{adopted:true,version:1,settings},boundaryPreflight:()=>({release:'synthetic-release',divisionId:'fictional-division'}),collectSeeds:async()=>source});
  const receipt=validateSeedReceipt(store,preview,settings),campaign=store.createCampaign({name:'Fictional seed guard',area:settings.area,niche:settings.niche,query:'Fictional test only'}),batchId='batch-seed-guard';
  const job=store.createJob({campaignId:campaign.id,kind:'discovery',input:{batchId,round:1,candidateLimit:3,phase:'discovery'}});
  transaction(store,()=>{
    claimSeedReceipt(store,receipt,batchId);
    operationRecord(store,batchId,'batch',{id:batchId,campaignId:campaign.id,state:'active',phase:'discovery',round:1,researchJobIds:[job.id],settings,deadlineAt:new Date(Date.now()+90000).toISOString(),seedCohort:receipt});
  });
  return{root,store,receipt,job,batchId};
}
test('every guarded job rejects changed immutable seed bytes before work can reserve',async t=>{
  const f=await fixture(t);assert.doesNotThrow(()=>guardBatchJob(f.store,f.job,{claiming:true}));
  const file=path.join(f.store.stateRoot,'references','seed-cohorts',f.receipt.id+'.json');
  await chmod(file,0o640);await writeFile(file,'{}');
  assert.throws(()=>guardBatchJob(f.store,f.job,{claiming:true}),e=>e.code==='SEED_RECEIPT');
});
test('every guarded job rejects frozen seed substitution even with a valid registered receipt',async t=>{
  const f=await fixture(t),b=getBatch(f.store,f.batchId);
  saveBatch(f.store,{...b,seedCohort:{...b.seedCohort,items:[{...b.seedCohort.items[0],name:'Different unregistered identity'}]}});
  assert.throws(()=>guardBatchJob(f.store,f.job,{claiming:true}),e=>e.code==='SEED_RECEIPT');
});
test('every guarded job binds frozen source metadata that enters research context',async t=>{
  const f=await fixture(t),b=getBatch(f.store,f.batchId);
  saveBatch(f.store,{...b,seedCohort:{...b.seedCohort,limitations:['Different unregistered source instructions']}});
  assert.throws(()=>guardBatchJob(f.store,f.job,{claiming:true}),e=>e.code==='SEED_RECEIPT');
});
