import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, unlink, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { transaction } from '../src/sales.mjs';
import { hash } from '../src/contracts.mjs';
import { SEED_OPERATIONS, seedDispatch, validateSeedReceipt, claimSeedReceipt } from '../src/seeds.mjs';

const settings = { area:'Houston city limits', niche:'mobile detailers, custom bakers, event decorators', workflow:'leads_first', targetCount:1, candidateLimit:6, maxResearchRounds:2, maxSearches:16, discoverySearchLimit:6, maxInspections:48, maxImageViews:12, maxModelRequests:16, batchMinutes:90, jobMinutes:45, searchProvider:'firecrawl' };
const preset = { version:10, adopted:true, settings };
const input = { presetVersion:10, requestId:'fixture-seeds-01', authorized:true };
const source = () => ({ provider:'placeroot', retrievedAt:new Date().toISOString(), version:{release:'fictional-release',dataset:'Overture Places'}, attribution:['Fictional fixture notices only'], limitations:['Unverified seeds; not qualification'], items:[{id:'fictional-gers-1',name:'Fictional Houston Cakes',location:{city:'Houston',region:'Texas'},categories:['bakery'],urls:['https://www.instagram.com/fictional_fixture_cakes/'],provenance:{dataset:'Overture Places',sources:[{dataset:'fictional',license:'fictional fixture notice'}]}}] });
async function fixture(t) {
  const root=await mkdtemp('/tmp/factory-seeds-'), options={dbPath:path.join(root,'fixture.sqlite3'),stateRoot:path.join(root,'state')};
  await initialize(options);const store=openStore(options);t.after(()=>store.close());
  return {root,store,prepare:(collectSeeds=async()=>source(),value=input)=>seedDispatch(store,'seed_prepare',value,{collectSeeds,preset,boundaryPreflight:()=>({release:'fictional-release',divisionId:'fictional-division'})})};
}
test('known connector failure categories survive without provider bodies or retry authority',async t=>{
  const f=await fixture(t);
  const failure=Object.assign(new Error('SECRET provider exception text'),{code:'SEED_SOURCE_VERSION'});
  await assert.rejects(f.prepare(async()=>{throw failure;}),e=>e.code==='SEED_SOURCE_VERSION'&&!e.message.includes('SECRET'));
  const row=JSON.parse(f.store.db.prepare("SELECT record FROM factory_operation WHERE kind='seed_preparation'").get().record);
  assert.equal(row.errorCode,'SEED_SOURCE_VERSION');assert.doesNotMatch(JSON.stringify(row),/SECRET/);
  await assert.rejects(f.prepare(),e=>e.code==='SEED_ALREADY_ATTEMPTED');
});
test('one explicit exact-failure-bound child preserves its parent and replays without collection',async t=>{
  const f=await fixture(t);await assert.rejects(f.prepare(async()=>{throw Error('Fictional failed parent');}));
  const parentRow=f.store.db.prepare("SELECT record FROM factory_operation WHERE kind='seed_preparation'").get().record,parent=JSON.parse(parentRow);
  let calls=0;const collect=async()=>{calls++;return source();};
  const retry={...input,requestId:'fixture-explicit-retry',failedPreparationId:parent.id};
  const child=await f.prepare(collect,retry);assert.equal(calls,1);
  assert.deepEqual(await f.prepare(collect,retry),child);assert.equal(calls,1);
  assert.equal(f.store.db.prepare('SELECT record FROM factory_operation WHERE id=?').get(parent.id).record,parentRow);
  const row=JSON.parse(f.store.db.prepare('SELECT record FROM factory_operation WHERE id=?').get(child.id).record);
  assert.equal(row.retryOf,parent.id);assert.equal(row.state,'prepared');
  await assert.rejects(f.prepare(collect,{...retry,requestId:'fixture-another-retry'}));
  await assert.rejects(f.prepare(collect,{...retry,requestId:'fixture-child-parent',failedPreparationId:child.id}));assert.equal(calls,1);
});
test('failed child cannot unlock a third preparation or arbitrary missing parent',async t=>{
  const f=await fixture(t);let calls=0;const broken=async()=>{calls++;throw Error('Fictional failure');};
  await assert.rejects(f.prepare(broken));const parent=JSON.parse(f.store.db.prepare("SELECT record FROM factory_operation WHERE kind='seed_preparation'").get().record);
  await assert.rejects(f.prepare(broken,{...input,requestId:'fixture-missing-parent',failedPreparationId:'seed-'+'f'.repeat(32)}));assert.equal(calls,1);
  await assert.rejects(f.prepare(broken,{...input,requestId:'fixture-failed-child',failedPreparationId:parent.id}));assert.equal(calls,2);
  const child=JSON.parse(f.store.db.prepare("SELECT record FROM factory_operation WHERE kind='seed_preparation' AND id!=?").get(parent.id).record);
  await assert.rejects(f.prepare(broken,{...input,requestId:'fixture-third',failedPreparationId:child.id}));assert.equal(calls,2);
});
test('concurrent explicit children reserve only one collection before awaiting the source',async t=>{
  const f=await fixture(t);await assert.rejects(f.prepare(async()=>{throw Error('Fictional root');}));
  const parent=JSON.parse(f.store.db.prepare("SELECT record FROM factory_operation WHERE kind='seed_preparation'").get().record);
  let finish,calls=0;const collect=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  const retry={...input,requestId:'fixture-concurrent-child',failedPreparationId:parent.id};
  const first=f.prepare(collect,retry);
  await assert.rejects(f.prepare(collect,{...retry,requestId:'fixture-competing-child'}),e=>e.code==='SEED_ALREADY_ATTEMPTED');
  assert.equal(calls,1);finish(source());await first;
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM factory_operation WHERE kind='seed_preparation'").get().n,2);
});
test('strict operations reject authority, unknown inputs, stale and expanded scopes before collection',async t=>{
  const f=await fixture(t);let calls=0;const collect=async()=>{calls++;return source();};
  for(const value of [{...input,authorized:false},{...input,url:'https://fixture.example/'},{...input,requestId:'x'},{...input,presetVersion:9}]) await assert.rejects(f.prepare(collect,value));
  await assert.rejects(seedDispatch(f.store,'seed_prepare',input,{collectSeeds:collect,preset:{...preset,settings:{...settings,maxSearches:17}}}));
  assert.equal(calls,0);assert.equal(SEED_OPERATIONS.seed_get.readOnly,true);
});
test('immutable receipt is synchronously verified, frozen, replayed and read without writes',async t=>{
  const f=await fixture(t);let calls=0;const collect=async()=>{calls++;return source();};
  const first=await f.prepare(collect),second=await f.prepare(collect);assert.deepEqual(second,first);assert.equal(calls,1);
  const receipt=validateSeedReceipt(f.store,first,settings);assert.equal(receipt.items[0].name,'Fictional Houston Cakes');assert.ok(Object.isFrozen(receipt.items[0].location));
  const changes=f.store.db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(await seedDispatch(f.store,'seed_get',{id:first.id}),first);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,changes);
  assert.equal(first.qualified,undefined);assert.equal(first.label,'unverified seeds');
});
test('missing, foreign, tampered and symlink receipts fail including replay',async t=>{
  const f=await fixture(t),result=await f.prepare(),file=path.join(f.store.stateRoot,'references/seed-cohorts',result.id+'.json');
  assert.throws(()=>validateSeedReceipt(f.store,{id:result.id,digest:'0'.repeat(64)},settings));
  assert.throws(()=>validateSeedReceipt(f.store,{id:'seed-foreign',digest:result.digest},settings));
  assert.throws(()=>validateSeedReceipt(f.store,result,{...settings,area:'Houston metro area'}));
  const bytes=await readFile(file);await chmod(file,0o640);await writeFile(file,Buffer.concat([bytes,Buffer.from(' ')]));
  assert.throws(()=>validateSeedReceipt(f.store,result,settings));await assert.rejects(f.prepare());
  await unlink(file);assert.throws(()=>validateSeedReceipt(f.store,result,settings));
  const other=path.join(f.root,'other.json');await writeFile(other,bytes);await symlink(other,file);
  assert.throws(()=>validateSeedReceipt(f.store,result,settings));
});
test('claim re-verifies bytes, allows same batch only and rolls back atomically with caller',async t=>{
  const f=await fixture(t),result=await f.prepare(),receipt=validateSeedReceipt(f.store,result,settings);
  assert.throws(()=>claimSeedReceipt(f.store,receipt,'batch-fixture-1'));
  assert.throws(()=>transaction(f.store,()=>{claimSeedReceipt(f.store,receipt,'batch-fixture-1');throw Error('rollback');}));
  transaction(f.store,()=>claimSeedReceipt(f.store,receipt,'batch-fixture-2'));
  transaction(f.store,()=>claimSeedReceipt(f.store,receipt,'batch-fixture-2'));
  assert.throws(()=>transaction(f.store,()=>claimSeedReceipt(f.store,receipt,'batch-fixture-3')));
  const file=path.join(f.store.stateRoot,'references/seed-cohorts',result.id+'.json');await chmod(file,0o640);await writeFile(file,'{}');
  assert.throws(()=>transaction(f.store,()=>claimSeedReceipt(f.store,receipt,'batch-fixture-2')));
});
test('failures are durable, sanitized and never recollected through replay or replacement IDs',async t=>{
  const f=await fixture(t);let calls=0;const collect=async()=>{calls++;throw Error('password=fixture-do-not-store https://user:secret@fixture.example/');};
  await assert.rejects(f.prepare(collect));await assert.rejects(f.prepare(collect));
  await assert.rejects(f.prepare(collect,{...input,requestId:'replacement-fixture'}));assert.equal(calls,1);
  assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT record FROM factory_operation').all()),/fixture-do-not-store|user:secret/);
});
test('concurrent requests reserve before awaiting collection and interruption stays consumed',async t=>{
  const f=await fixture(t);let release,calls=0;
  const pending=f.prepare(async()=>{calls++;await new Promise(resolve=>{release=resolve;});return source();});
  await assert.rejects(f.prepare());await assert.rejects(f.prepare(undefined,{...input,requestId:'fixture-concurrent'}));
  release();await pending;assert.equal(calls,1);
});
test('rejects empty, oversized, incomplete provenance and unsafe nested URL/secret data without raw persistence',async t=>{
  for(const mutate of [s=>{s.items=[];},s=>{s.items=Array.from({length:21},(_,i)=>({...s.items[0],id:`fixture-${i}`}));},s=>{delete s.items[0].provenance;},s=>{s.items[0].urls=['https://user:secret@fixture.example/'];},s=>{s.items[0].provenance.token='fixture-secret';},s=>{s.items[0].urls=['https://fixture.example/?api_key=fixture-secret'];},s=>{s.items[0].blob='a'.repeat(1048576);}]) {
    const f=await fixture(t),s=source();mutate(s);await assert.rejects(f.prepare(async()=>s));
    assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT record FROM factory_operation').all()),/fixture-secret|user:secret/);
  }
});
test('refuses symlink cohort directory and retains failed preparation',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'outside');await mkdir(outside);await mkdir(path.join(f.store.stateRoot,'references'));await symlink(outside,path.join(f.store.stateRoot,'references/seed-cohorts'));
  await assert.rejects(f.prepare());await assert.rejects(f.prepare());
});
test('provider envelope cannot override generated receipt identity or frozen scope',async t=>{
  const f=await fixture(t),s={...source(),id:'seed-foreign',settings:{area:'other'},schemaVersion:99,presetVersion:99};
  const result=await f.prepare(async()=>s),receipt=validateSeedReceipt(f.store,result,settings);
  assert.match(receipt.id,/^seed-[a-f0-9]{32}$/);assert.deepEqual(receipt.settings,settings);assert.equal(receipt.presetVersion,10);assert.equal(receipt.schemaVersion,1);
});
test('interrupted durable reservation survives a new store and request ID',async t=>{
  const f=await fixture(t),record={id:'seed-'+ 'a'.repeat(32),requestKey:hash(input.requestId),inputDigest:hash(input),state:'preparing'};
  f.store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?)').run(record.id,'seed_preparation',JSON.stringify(record));
  const next=openStore({dbPath:f.store.dbPath,stateRoot:f.store.stateRoot});t.after(()=>next.close());let calls=0;
  const collectSeeds=async()=>{calls++;return source();};
  await assert.rejects(seedDispatch(next,'seed_prepare',input,{preset,collectSeeds}));
  await assert.rejects(seedDispatch(next,'seed_prepare',{...input,requestId:'fresh-after-interruption'},{preset,collectSeeds}));assert.equal(calls,0);
});
test('filters existing/suppressed and repeated business identities without creating candidates',async t=>{
  const f=await fixture(t),campaign=f.store.createCampaign({name:'Fictional prior',query:'Fictional only',area:'Houston',niche:'fixture'});
  f.store.saveCandidate(campaign.id,{name:'Fictional Houston Cakes',area:'Houston',summary:'Fixture only',sourceUrls:[],facts:[],websiteCheck:{status:'unknown'}});
  const s=source();s.items.push({...s.items[0],id:'fictional-new',name:'Fictional New Detailer',urls:[]},{...s.items[0],id:'fictional-duplicate',name:'Fictional New Detailer',urls:[]});
  const result=await f.prepare(async()=>s);assert.equal(result.count,1);assert.equal(result.items[0].name,'Fictional New Detailer');assert.equal(f.store.candidates().length,1);
  assert.match(result.limitations.join(' '),/2 existing, suppressed or duplicate/);
});
test('accepts exact approved preset10 niche including the bounded photo-rich no-site suffix',async t=>{
  const f=await fixture(t),actual={...settings,niche:'Mobile auto detailers, custom bakers and event decorators; photo-rich independent no-site businesses'};
  const result=await seedDispatch(f.store,'seed_prepare',input,{preset:{...preset,settings:actual},boundaryPreflight:()=>({release:'fictional-release',divisionId:'fictional-division'}),collectSeeds:async()=>source()});
  assert.equal(validateSeedReceipt(f.store,result,actual).settings.niche,actual.niche);
});
test('coordinate-only source locations accept finite geographic ranges, not malformed coordinates',async t=>{
  const f=await fixture(t),s=source();s.items[0].location={lat:29.76,lon:-95.36};
  assert.equal((await f.prepare(async()=>s)).count,1);
  for(const location of [{lat:91,lon:0},{lat:29.76,lon:-181},{lat:29.76},{lat:'29.76',lon:-95.36},{lat:NaN,lon:-95.36}]) {
    const next=await fixture(t),invalid=source();invalid.items[0].location=location;await assert.rejects(next.prepare(async()=>invalid));
  }
});
