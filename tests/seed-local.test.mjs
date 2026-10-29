import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { hash } from '../src/contracts.mjs';
import { SEED_OPERATIONS, seedDispatch, validateSeedReceipt, claimSeedReceipt } from '../src/seeds.mjs';
import { transaction } from '../src/sales.mjs';

const mode='houston_local_radius_v1';
const rootId='seed-0de2a46309d14565b96b5a87949952bd';
const childId='seed-b51d21e8dd56416daa89b0307cd3bbbf';
const thirdId='seed-afd6bffd4b674fe6bd893d56963b8a1a';
const settings={area:'Houston city limits',niche:'mobile detailers, custom bakers, event decorators',workflow:'leads_first',targetCount:1,candidateLimit:6,maxResearchRounds:2,maxSearches:16,discoverySearchLimit:6,maxInspections:48,maxImageViews:12,maxModelRequests:16,batchMinutes:90,jobMinutes:45,searchProvider:'firecrawl'};
const preset={version:10,adopted:true,settings};
const input={presetVersion:10,requestId:'fictional-local-proof',authorized:true,discoveryMode:mode,failedPreparationId:childId};
const source=()=>({provider:'placeroot',retrievedAt:new Date().toISOString(),version:{release:'fictional-release',discovery:{mode,lat:29.75893783569336,lon:-95.3676986694336,radiusM:15000,cityEligibility:'unknown',pages:[{count:1,moreAvailable:false}]}},attribution:['Fictional fixture only'],limitations:['Approximate discovery only'],items:[{id:'fictional-local-1',name:'Fictional Local Cakes',location:{lat:29.76,lon:-95.36},categories:['bakery'],provenance:{dataset:'fictional fixture'},urls:[]}]});
const rows=store=>store.db.prepare("SELECT record FROM factory_operation WHERE kind='seed_preparation' ORDER BY id").all().map(v=>v.record);
const put=(store,row)=>store.db.prepare('INSERT OR REPLACE INTO factory_operation VALUES(?,?,?)').run(row.id,'seed_preparation',JSON.stringify(row));
async function fixture(t,mutate=()=>{}) {
  const directory=await mkdtemp('/tmp/factory-local-seeds-');
  const options={dbPath:path.join(directory,'fictional.sqlite3'),stateRoot:path.join(directory,'state')};
  await initialize(options);const store=openStore(options);t.after(()=>store.close());
  const root={id:rootId,presetVersion:10,settings,settingsDigest:hash(settings),state:'failed',claimedBatchId:null};
  const child={...root,id:childId,retryOf:rootId};const prior=[root,child];mutate(prior);prior.forEach(row=>put(store,row));
  let boundaryCalls=0,calls=0,args;
  const prepare=(value=input,collect=async()=>source())=>seedDispatch(store,'seed_prepare',value,{preset,boundaryPreflight:()=>{boundaryCalls++;throw Error('Local must not resolve polygons');},collectSeeds:async value=>{calls++;args=value;return collect(value);}});
  return {store,prepare,get calls(){return calls;},get boundaryCalls(){return boundaryCalls;},get args(){return args;}};
}
test('optional strict local mode leaves historical input bytes and digest unchanged',()=>{
  const old={presetVersion:10,requestId:'fictional-old-input',authorized:true};
  assert.deepEqual(SEED_OPERATIONS.seed_prepare.schema.parse(old),old);
  assert.equal(hash(SEED_OPERATIONS.seed_prepare.schema.parse(old)),hash(old));
  for(const extra of [{discoveryMode:'other'},{discoveryMode:null},{lat:29.76},{radiusM:15000},{discoveryMode:mode,lon:-95.36}]) assert.equal(SEED_OPERATIONS.seed_prepare.schema.safeParse({...old,...extra}).success,false);
});
test('explicit third local preparation preserves failed bytes, binds metadata and replays without source or boundary',async t=>{
  const f=await fixture(t),before=rows(f.store),result=await f.prepare();
  assert.equal(f.calls,1);assert.equal(f.boundaryCalls,0);assert.equal(f.args.discoveryMode,mode);
  assert.equal(result.discoveryMode,mode);assert.match(result.label,/unverified local seeds.*city eligibility unknown/);
  const row=JSON.parse(rows(f.store).find(v=>JSON.parse(v).id===result.id));
  assert.equal(row.discoveryMode,mode);assert.equal(row.retryOf,childId);
  for(const bytes of before)assert.ok(rows(f.store).includes(bytes));
  const receipt=validateSeedReceipt(f.store,result,settings);
  assert.equal(receipt.discoveryMode,mode);assert.equal(receipt.retryOf,childId);assert.deepEqual(receipt.version.discovery,source().version.discovery);
  assert.deepEqual(await f.prepare(),result);assert.deepEqual(await seedDispatch(f.store,'seed_get',{id:result.id}),result);
  assert.equal(f.calls,1);assert.equal(f.boundaryCalls,0);
  transaction(f.store,()=>claimSeedReceipt(f.store,receipt,'batch-fictional-local'));
  await assert.rejects(f.prepare({...input,requestId:'fictional-fourth'}),e=>e.code==='SEED_ALREADY_ATTEMPTED');
});
test('wrong predecessor, graphs, scope, claims and states reject atomically before source',async t=>{
  const mutations=[p=>p.pop(),p=>p.push({...p[0],id:'seed-'+'f'.repeat(32)}),p=>{p[0].state='prepared';},p=>{p[1].state='preparing';},p=>{p[0].claimedBatchId='batch-fictional';},p=>{p[1].claimedBatchId='batch-fictional';},p=>{p[1].retryOf='seed-'+'e'.repeat(32);},p=>{p[0].retryOf=childId;},p=>{p[0].presetVersion=9;},p=>{p[1].settingsDigest='0'.repeat(64);},p=>{p[0].settings={...settings,maxSearches:15};},p=>{p[1].discoveryMode=mode;},p=>{p[0].id='seed-'+'e'.repeat(32);p[1].retryOf=p[0].id;}];
  for(const mutate of mutations){const f=await fixture(t,mutate),before=rows(f.store);await assert.rejects(f.prepare(),e=>e.code==='SEED_ALREADY_ATTEMPTED');assert.deepEqual(rows(f.store),before);assert.equal(f.calls,0);assert.equal(f.boundaryCalls,0);}
  for(const failedPreparationId of [undefined,rootId,'seed-'+'f'.repeat(32)]){const f=await fixture(t),before=rows(f.store);await assert.rejects(f.prepare({...input,failedPreparationId}));assert.deepEqual(rows(f.store),before);assert.equal(f.calls,0);}
});
test('concurrent local requests reserve one third record and failure remains consumed without fourth',async t=>{
  const f=await fixture(t),before=rows(f.store);let release;
  const first=f.prepare(input,()=>new Promise((resolve,reject)=>{release=()=>reject(Error('Fictional failure'));}));
  await assert.rejects(f.prepare({...input,requestId:'fictional-concurrent'}),e=>e.code==='SEED_ALREADY_ATTEMPTED');
  await assert.rejects(f.prepare(),e=>e.code==='SEED_ALREADY_ATTEMPTED');
  assert.equal(f.calls,1);release();await assert.rejects(first);
  await assert.rejects(f.prepare({...input,requestId:'fictional-after-failure'}));
  assert.equal(rows(f.store).length,3);for(const bytes of before)assert.ok(rows(f.store).includes(bytes));assert.equal(f.calls,1);
});
test('local source metadata must match fixed geometry and mode, without permitting default-mode substitution',async t=>{
  for(const mutate of [s=>{delete s.version.discovery;},s=>{s.version.discovery.mode='other';},s=>{s.version.discovery.lat=29.76;},s=>{s.version.discovery.lon=-95.36;},s=>{s.version.discovery.radiusM=16000;},s=>{s.version.discovery.cityEligibility='verified';},s=>{s.version.discovery.pages=[];},s=>{s.version.discovery.pages=[null];},s=>{s.version.discovery.pages=['unbound'];}]){
    const f=await fixture(t),value=source();mutate(value);await assert.rejects(f.prepare(input,async()=>value),e=>e.code==='SEED_PROVENANCE');assert.equal(rows(f.store).length,3);
  }
});
test('default preparation still runs boundary preflight and cannot accept local-source substitution',async t=>{
  const f=await fixture(t,p=>p.splice(0)),old={presetVersion:10,requestId:'fictional-default-boundary',authorized:true};
  await assert.rejects(f.prepare(old),/Local must not resolve polygons/);
  assert.equal(f.boundaryCalls,1);assert.equal(f.calls,0);assert.deepEqual(rows(f.store),[]);
  await assert.rejects(seedDispatch(f.store,'seed_prepare',old,{preset,boundaryPreflight:()=>({release:'fictional-release'}),collectSeeds:async()=>source()}),e=>e.code==='SEED_PROVENANCE');
});
test('read and claim reject mode/version substitution and foreign row settings provenance',async t=>{
  for(const mutate of [r=>{delete r.discoveryMode;},r=>{r.discoveryMode='other';},r=>{r.retryOf=rootId;},r=>{r.version.discovery.radiusM=1;},r=>{r.version.release='another-release';},r=>{r.version.discovery.pages[0].count=2;}]){
    const f=await fixture(t),result=await f.prepare(),file=path.join(f.store.stateRoot,'references/seed-cohorts',result.id+'.json');
    const receipt=JSON.parse(await readFile(file));mutate(receipt);const bytes=JSON.stringify(receipt);await chmod(file,0o640);await writeFile(file,bytes);
    const row=JSON.parse(rows(f.store).find(v=>JSON.parse(v).id===result.id));row.digest=hash(Buffer.from(bytes));put(f.store,row);
    assert.throws(()=>validateSeedReceipt(f.store,{id:result.id,digest:row.digest},settings));
    assert.throws(()=>transaction(f.store,()=>claimSeedReceipt(f.store,{...receipt,digest:row.digest},'batch-fictional-tampered')));
  }
  const f=await fixture(t),result=await f.prepare(),row=JSON.parse(rows(f.store).find(v=>JSON.parse(v).id===result.id));row.settings={...settings,maxSearches:15};put(f.store,row);
  assert.throws(()=>validateSeedReceipt(f.store,result,settings));
});
test('separately authorized exact local failure permits one fourth record without rewriting any predecessor',async t=>{
  const f=await fixture(t,p=>p.push({...p[1],id:thirdId,retryOf:childId,discoveryMode:mode,errorCode:'SEED_SOURCE_PROVENANCE'})),before=rows(f.store);
  const request={...input,requestId:'fictional-provenance-repair',failedPreparationId:thirdId};
  const result=await f.prepare(request);assert.equal(rows(f.store).length,4);assert.equal(f.calls,1);
  for(const bytes of before)assert.ok(rows(f.store).includes(bytes));
  assert.equal(validateSeedReceipt(f.store,result,settings).retryOf,thirdId);
  assert.deepEqual(await f.prepare(request),result);assert.equal(f.calls,1);
  await assert.rejects(f.prepare({...request,requestId:'fictional-fifth'}),e=>e.code==='SEED_ALREADY_ATTEMPTED');
});
test('fourth-record authority rejects foreign/local chains, changed failure and concurrent/fifth replacements',async t=>{
  for(const mutate of [p=>{p[2].errorCode='SEED_SOURCE_TIMEOUT';},p=>{p[2].state='prepared';},p=>{p[2].claimedBatchId='batch-fictional';},p=>{p[2].retryOf=rootId;},p=>{delete p[2].discoveryMode;},p=>{p[2].id='seed-'+'e'.repeat(32);},p=>{p[2].settingsDigest='0'.repeat(64);}]){
    const f=await fixture(t,p=>{p.push({...p[1],id:thirdId,retryOf:childId,discoveryMode:mode,errorCode:'SEED_SOURCE_PROVENANCE'});mutate(p);}),before=rows(f.store);
    await assert.rejects(f.prepare({...input,failedPreparationId:thirdId}),e=>e.code==='SEED_ALREADY_ATTEMPTED');assert.deepEqual(rows(f.store),before);assert.equal(f.calls,0);
  }
  const f=await fixture(t,p=>p.push({...p[1],id:thirdId,retryOf:childId,discoveryMode:mode,errorCode:'SEED_SOURCE_PROVENANCE'}));let reject;
  const request={...input,failedPreparationId:thirdId},pending=f.prepare(request,()=>new Promise((_,r)=>{reject=r;}));
  await assert.rejects(f.prepare({...request,requestId:'fictional-concurrent-fourth'}));assert.equal(f.calls,1);reject(Error('Fictional consumed failure'));await assert.rejects(pending);
  await assert.rejects(f.prepare({...request,requestId:'fictional-fifth-after-failure'}));assert.equal(f.calls,1);assert.equal(rows(f.store).length,4);
});
test('safe source diagnostic retains finite tool and field only, never arbitrary provider content',async t=>{
  const f=await fixture(t);const error=Object.assign(Error('Private source body must never persist'),{code:'SEED_SOURCE_PROVENANCE',diagnostic:{tool:'place_details',callIndex:8,field:'origin_record_id'}});
  await assert.rejects(f.prepare(input,async()=>{throw error;}));const failed=rows(f.store).map(JSON.parse).find(v=>v.id!==rootId&&v.id!==childId);
  assert.deepEqual(failed.sourceDiagnostic,error.diagnostic);assert.doesNotMatch(JSON.stringify(failed),/Private source body/);
  const g=await fixture(t);error.diagnostic={tool:'https://private.invalid/',callIndex:800,field:'provider body'};
  await assert.rejects(g.prepare(input,async()=>{throw error;}));assert.equal(rows(g.store).map(JSON.parse).find(v=>v.id!==rootId&&v.id!==childId).sourceDiagnostic,undefined);
  const h=await fixture(t);error.diagnostic={tool:'unspecified',callIndex:0,field:'unspecified'};
  await assert.rejects(h.prepare(input,async()=>{throw error;}));assert.deepEqual(rows(h.store).map(JSON.parse).find(v=>v.id!==rootId&&v.id!==childId).sourceDiagnostic,error.diagnostic);
});
