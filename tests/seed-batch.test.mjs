import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,chmod} from 'node:fs/promises';
import {initialize,openStore} from '../src/db.mjs';
import {batchDispatch,BATCH_OPERATIONS,batchPreset} from '../src/batches.mjs';
import {seedDispatch,validateSeedReceipt} from '../src/seeds.mjs';
import {scoutStep,assertScoutWorkflow,seedResearchContext} from '../src/scout.mjs';
import {getBatch,saveBatch} from '../src/batch-store.mjs';
import {hash,now,workRelative} from '../src/contracts.mjs';
import {withJobBudget} from '../src/batch-budget.mjs';
import {assertNativeResearchResult} from '../src/research.mjs';

const settings={area:'Houston city limits',niche:'mobile detailers, custom bakers, event decorators',workflow:'leads_first',targetCount:1,candidateLimit:6,maxResearchRounds:2,searchProvider:'firecrawl',maxSearches:16,discoverySearchLimit:6,maxInspections:48,maxImageViews:12,maxModelRequests:16,batchMinutes:90,jobMinutes:45};
const items=[{id:'fictional-gers-1',name:'Juniper Fictional Detail',location:{city:'Houston',region:'Texas',country:'US',lat:29.76,lon:-95.37},categories:['auto_detailing'],urls:['https://www.instagram.com/juniper_fictional/'],provenance:{dataset:'Overture Maps',release:'fictional-test-release',sources:[{dataset:'fictional-fixture',license:'fixture-only'}]}}];
async function fixture(t,sourceItems=items){
  const root=await mkdtemp('/tmp/factory-seed-batch-'),options={dbPath:path.join(root,'db.sqlite'),stateRoot:path.join(root,'state')};
  await initialize(options);const store=openStore(options);t.after(()=>store.close());
  await batchDispatch(store,'batch_preset_save',{version:0,requestId:'seed-batch-setup',settings,acknowledged:true});
  const prepared=await seedDispatch(store,'seed_prepare',{presetVersion:1,requestId:'fictional-seed-prepare',authorized:true},{preset:batchPreset(store),boundaryPreflight:()=>({release:'fictional-test-release',divisionId:'fictional-division'}),collectSeeds:async()=>({provider:'placeroot',retrievedAt:now(),version:{release:'fictional-test-release'},attribution:['Fictional offline fixture only'],limitations:['Unverified fixture seeds; no actual business or qualification'],items:sourceItems})});
  const seedReceipt={id:prepared.id,digest:prepared.digest};
  return {store,seedReceipt,prepared};
}
const start=(f,requestId='seed-batch-start')=>batchDispatch(f.store,'batch_start',{presetVersion:1,requestId,authorized:true,seedReceipt:f.seedReceipt},{prerequisites:async()=>({ready:true})});
async function running(f){
  const b=await start(f),job=f.store.jobs()[0],directory=path.join(f.store.stateRoot,workRelative(job),'sources');await mkdir(directory,{recursive:true});return {...f,b,job,directory};
}
function searchFixture(f,queries){return async(query,ctx)=>{queries.push(query);const result={query,provider:ctx.provider,intent:'discover',status:'completed',at:now(),results:[{url:'https://www.yelp.com/search',title:'Juniper Fictional Detail Houston Texas'}]};await writeFile(path.join(f.directory,`search-${hash(query).slice(0,16)}.json`),JSON.stringify(result));return result;};}
const scout=(f,adapters={})=>scoutStep({store:f.store,jobId:f.job.id,directory:f.directory,output:{candidates:[]},...adapters});

test('batch_start accepts only an exact optional receipt identity',()=>{
  const input={presetVersion:1,requestId:'schema-seed-start',authorized:true,seedReceipt:{id:'seed-fictional',digest:'a'.repeat(64)}};
  assert.equal(BATCH_OPERATIONS.batch_start.schema.safeParse(input).success,true);
  assert.equal(BATCH_OPERATIONS.batch_start.schema.safeParse({...input,seedReceipt:{...input.seedReceipt,items}}).success,false);
});
test('NEW seeded batch freezes the registered cohort and original limits, replay is stable and receipt cannot replace a stopped batch',async t=>{
  const f=await fixture(t),receipt=validateSeedReceipt(f.store,f.seedReceipt,settings),b=await start(f);
  assert.deepEqual(b.seedCohort.items,receipt.items);assert.equal(b.seedCohort.id,f.seedReceipt.id);assert.equal(b.seedCohort.digest,f.seedReceipt.digest);
  assert.deepEqual(b.settings,settings);assert.equal(b.round,1);assert.equal(f.store.campaign(b.campaignId).model,'openai/gpt-6.1-sol-fast');
  assert.deepEqual(await start(f),b);await batchDispatch(f.store,'batch_stop',{id:b.id});
  await assert.rejects(start(f,'seed-replacement'),e=>/^SEED_/.test(e.code));
  assert.equal(f.store.jobs().length,1);assert.equal(f.store.candidates().length,0);
});
test('host searches exact seed names, then may inspect the actual unverified profile without treating it as search or a fact',async t=>{
  const f=await running(await fixture(t)),queries=[];
  const first=await scout(f,{search:searchFixture(f,queries)});
  assert.equal(first.status,'searched');assert.match(queries[0],/"Juniper Fictional Detail"/);assert.match(queries[0],/Houston/);assert.doesNotMatch(queries[0],/DM to|mobile detailers/);
  let inspected;const second=await scout(f,{inspect:async url=>{inspected=url;return {id:'source-seed-fixture',url,inspectedAt:now(),blocked:true,text:'Fictional blocked fixture',links:[],images:[],captures:[]};}});
  assert.equal(inspected,items[0].urls[0]);assert.equal(second.question.purpose,'seed_profile');
  assert.equal(f.store.candidates().length,0);assert.equal(getBatch(f.store,f.b.id).usage.searches,1);assert.equal(getBatch(f.store,f.b.id).usage.inspections,1);
  assert.throws(()=>assertScoutWorkflow(f.store,f.job.id,[],{searches:[]}),e=>e.code==='SOURCE_SCOUT_REQUIRED');
  assert.doesNotThrow(()=>assertScoutWorkflow(f.store,f.job.id,[],{searches:[first.search]}));
});
test('frozen cohort tampering rejects scout and native cached research before source work or cache use',async t=>{
  const f=await running(await fixture(t));const b=getBatch(f.store,f.b.id);saveBatch(f.store,{...b,seedCohort:{...b.seedCohort,items:[{...b.seedCohort.items[0],name:'Replacement identity'}]}});
  let calls=0;await assert.rejects(scout(f,{search:async()=>{calls++;}}),e=>/^SEED_/.test(e.code));assert.equal(calls,0);
  assert.throws(()=>seedResearchContext(f.store,f.job.id),e=>/^SEED_/.test(e.code));
  await assert.rejects(withJobBudget(f.store,f.job.id,()=>assertNativeResearchResult({}, {jobRoot:path.dirname(f.directory),candidateLimit:3,provider:'firecrawl',evidence:{observations:[],searches:[]}})),e=>/^SEED_/.test(e.code));
});
test('foreign receipt digest fails atomically without campaign, batch or job',async t=>{
  const f=await fixture(t);f.seedReceipt.digest='0'.repeat(64);
  await assert.rejects(start(f),e=>/^SEED_/.test(e.code));assert.equal(f.store.jobs().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM factory_campaign').get().n,0);
});
test('receipt bytes changed after start fail before another source attempt and do not reset consumption',async t=>{
  const f=await running(await fixture(t)),queries=[];await scout(f,{search:searchFixture(f,queries)});
  const file=path.join(f.store.stateRoot,'references','seed-cohorts',f.seedReceipt.id+'.json');await chmod(file,0o640);await writeFile(file,'{}');
  await assert.rejects(scout(f,{search:searchFixture(f,queries)}),e=>/^SEED_/.test(e.code));
  const b=getBatch(f.store,f.b.id);assert.equal(queries.length,1);assert.equal(b.usage.searches,1);assert.equal(b.deadlineAt,f.b.deadlineAt);assert.equal(b.round,1);
});
test('a post or platform-control seed URL is not promoted to an original profile',async t=>{
  const f=await running(await fixture(t,[{...items[0],urls:['https://www.instagram.com/p/fictional-post/','https://www.facebook.com/marketplace/']}])) ,queries=[];
  await scout(f,{search:searchFixture(f,queries)});let inspections=0;
  const next=await scout(f,{search:searchFixture(f,queries),inspect:async()=>{inspections++;}});
  assert.equal(inspections,0);assert.equal(next.status,'searched');assert.equal(f.store.candidates().length,0);assert.equal(getBatch(f.store,f.b.id).usage.inspections,0);
});
test('six exact-business discovery searches never fall back to generic queries or a seventh seed search',async t=>{
  const seeds=Array.from({length:7},(_,i)=>({...items[0],id:`fictional-gers-${i+1}`,name:`Juniper Fictional Detail ${i+1}`,urls:[]}));
  const f=await running(await fixture(t,seeds)),queries=[];
  for(let i=0;i<6;i++)assert.equal((await scout(f,{search:searchFixture(f,queries)})).status,'searched');
  const next=await scout(f,{search:searchFixture(f,queries)});
  assert.equal(queries.length,6);assert.equal(new Set(queries).size,6);for(const query of queries)assert.match(query,/"Juniper Fictional Detail [1-6]"/);
  assert.equal(next.status,'query_ceiling');assert.equal(getBatch(f.store,f.b.id).discoveryUsage.searches,6);assert.equal(f.store.jobs().length,1);assert.equal(f.store.candidates().length,0);
});
