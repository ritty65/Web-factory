import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { hash } from '../src/contracts.mjs';
import { BOUNDARY_OPERATIONS, boundaryDispatch, boundaryStatus, requireBoundary } from '../src/boundaries.mjs';

const input={requestId:'fictional-boundary-setup',authorized:true};
// Fictional metadata only: tests never create or warm the real runtime cache.
const release='2026-09-23.1',divisionId='fictional-houston-division',sourceGlobSha256=hash(`s3://overturemaps-us-west-2/release/${release}/theme=divisions/type=division_area/*`);
const receipt=()=>({provider:'placeroot',packageVersion:'0.12.0',release,divisionId,areaName:'Houston',cacheRelative:`cache/division_polygons/${sourceGlobSha256.slice(0,16)}/${hash(divisionId).slice(0,32)}.bin`,sourceGlobSha256,cacheSha256:'b'.repeat(64),bytes:512,bbox:[-96,-94,29,31],attribution:['Fictional fixture attribution'],stages:[{stage:'polygon',durationMs:5,outcome:'ok'}]});
const good=()=>({ready:true,reason:'ready'});
async function fixture(t) {
  const root=await mkdtemp('/tmp/factory-boundaries-'),options={dbPath:path.join(root,'fixture.sqlite3'),stateRoot:path.join(root,'state')};
  await initialize(options);const store=Object.freeze(openStore(options));t.after(()=>store.close());
  const rows=()=>store.db.prepare("SELECT record FROM factory_operation WHERE kind='boundary_preparation'").all().map(r=>JSON.parse(r.record));
  return {store,rows,prepare:(prepareBoundary=async()=>receipt(),value=input,inspectBoundaryCache=good)=>boundaryDispatch(store,'source_boundary_prepare',value,{prepareBoundary,inspectBoundaryCache})};
}
test('strict status is read-only and missing readiness fails closed without mutation',async t=>{
  const f=await fixture(t);const changes=()=>f.store.db.prepare('SELECT total_changes() AS n').get().n;const before=changes();
  assert.equal(BOUNDARY_OPERATIONS.source_boundary_status.readOnly,true);
  assert.equal(BOUNDARY_OPERATIONS.source_boundary_prepare.readOnly,false);
  const status=await boundaryDispatch(f.store,'source_boundary_status',{});
  assert.equal(status.ready,false);assert.equal(status.recordedRelease,null);
  assert.throws(()=>requireBoundary(f.store),e=>e.code==='BOUNDARY_NOT_READY');
  for(const extra of ['area','path','sql','timeout','provider','inspectBoundaryCache']) {
    await assert.rejects(boundaryDispatch(f.store,'source_boundary_status',{[extra]:'x'}),e=>e.code==='INVALID_INPUT');
    await assert.rejects(f.prepare(undefined,{...input,[extra]:'x'}),e=>e.code==='INVALID_INPUT');
  }
  for(const value of [{requestId:input.requestId},{...input,authorized:false},{...input,requestId:'x'}])await assert.rejects(f.prepare(undefined,value),e=>e.code==='INVALID_INPUT');
  assert.deepEqual(f.rows(),[]);assert.equal(changes(),before);
});
test('reservation precedes await; concurrent and new-ID calls cannot launch a second setup',async t=>{
  const f=await fixture(t);let finish,calls=0;
  const first=f.prepare(({signal})=>{calls++;assert.equal(signal.aborted,false);assert.equal(f.rows()[0].state,'preparing');return new Promise(resolve=>{finish=resolve;});});
  await assert.rejects(f.prepare(),e=>e.code==='BOUNDARY_ALREADY_ATTEMPTED');
  await assert.rejects(f.prepare(undefined,{...input,requestId:'fictional-competing'}),e=>e.code==='BOUNDARY_ALREADY_ATTEMPTED');
  assert.equal(calls,1);finish(receipt());await first;assert.equal(f.rows().length,1);
});
test('successful exact replay locally verifies without source calls; internal receipt is frozen',async t=>{
  const f=await fixture(t);let calls=0;const prepare=async()=>{calls++;return receipt();};
  const result=await f.prepare(prepare);const saved=f.rows();
  assert.deepEqual(await f.prepare(prepare),result);assert.equal(calls,1);assert.deepEqual(f.rows(),saved);
  const status=boundaryStatus(f.store,{inspectBoundaryCache:good});assert.equal(status.ready,true);assert.equal(status.recordedRelease,receipt().release);
  assert.equal(status.liveVerified,false);
  assert.doesNotMatch(JSON.stringify(status),/cacheRelative|geometry|bbox|divisionId/);
  const internal=requireBoundary(f.store,{inspectBoundaryCache:good});assert.equal(internal.cacheRelative,receipt().cacheRelative);assert.ok(Object.isFrozen(internal));assert.ok(Object.isFrozen(internal.stages));
});
test('tampered or missing cache prevents replay and discovery without rewarming',async t=>{
  const f=await fixture(t);await f.prepare();let calls=0;
  const bad=()=>({ready:false,reason:'SECRET /private/path raw SQL'});
  assert.equal(boundaryStatus(f.store,{inspectBoundaryCache:bad}).ready,false);
  assert.equal(boundaryStatus(f.store,{inspectBoundaryCache:bad}).recordedRelease,receipt().release);
  assert.doesNotMatch(JSON.stringify(boundaryStatus(f.store,{inspectBoundaryCache:bad})),/SECRET|private|SQL/);
  assert.throws(()=>requireBoundary(f.store,{inspectBoundaryCache:bad}),e=>e.code==='BOUNDARY_NOT_READY');
  await assert.rejects(f.prepare(async()=>{calls++;return receipt();},input,bad));assert.equal(calls,0);
  assert.equal(boundaryStatus(f.store).ready,false);
});
test('native local inspector must accept source key, division and file binding before readiness',async t=>{
  const f=await fixture(t);let inspected=0;
  await assert.rejects(f.prepare(async()=>receipt(),input,value=>{inspected++;assert.deepEqual(value,receipt());return {ready:false,reason:'foreign native source key'};}),e=>e.code==='BOUNDARY_PROVENANCE');
  assert.equal(inspected,1);assert.equal(f.rows()[0].state,'failed');
  assert.equal(boundaryStatus(f.store,{inspectBoundaryCache:good}).ready,false);
});
test('stored receipt digest or strict envelope tampering fails closed without rewriting history',async t=>{
  const f=await fixture(t);await f.prepare();const row=f.rows()[0];row.receipt.release='2026-10-01.1';
  f.store.db.prepare('UPDATE factory_operation SET record=? WHERE id=?').run(JSON.stringify(row),row.id);
  const before=f.rows();assert.equal(boundaryStatus(f.store,{inspectBoundaryCache:good}).ready,false);
  assert.throws(()=>requireBoundary(f.store,{inspectBoundaryCache:good}),e=>e.code==='BOUNDARY_NOT_READY');
  assert.deepEqual(f.rows(),before);
});
test('same request content conflict is detected before any runtime call',async t=>{
  const f=await fixture(t);await f.prepare();const row=f.rows()[0];row.inputDigest='0'.repeat(64);
  f.store.db.prepare('UPDATE factory_operation SET record=? WHERE id=?').run(JSON.stringify(row),row.id);
  await assert.rejects(f.prepare(()=>assert.fail('must not warm')),e=>e.code==='IDEMPOTENCY_CONFLICT');
});
test('retained interrupted setup stays consumed after reopening a local store',async t=>{
  const f=await fixture(t);await f.prepare();const row=f.rows()[0];row.state='preparing';delete row.receipt;delete row.receiptDigest;
  f.store.db.prepare('UPDATE factory_operation SET record=? WHERE id=?').run(JSON.stringify(row),row.id);
  const reopened=Object.freeze({db:f.store.db});
  assert.equal(boundaryStatus(reopened).ready,false);
  await assert.rejects(boundaryDispatch(reopened,'source_boundary_prepare',input,{prepareBoundary:()=>assert.fail('must not resume'),inspectBoundaryCache:good}),e=>e.code==='BOUNDARY_ALREADY_ATTEMPTED');
});
test('finite connector error categories retain only validated stage summaries',async t=>{
  const f=await fixture(t);const error=Object.assign(Error('SECRET provider log'),{code:'BOUNDARY_SOURCE_TIMEOUT',stages:[{stage:'polygon',durationMs:5,outcome:'running'}]});
  await assert.rejects(f.prepare(async()=>{throw error;}),e=>e.code==='BOUNDARY_SOURCE_TIMEOUT'&&!e.message.includes('SECRET'));
  assert.deepEqual(boundaryStatus(f.store).stages,error.stages);assert.doesNotMatch(JSON.stringify(f.rows()),/SECRET/);
});
test('unsafe failure stages and throwing local inspectors cannot leak details',async t=>{
  const f=await fixture(t);const error=Object.assign(Error('SECRET'),{stages:[{stage:'polygon',durationMs:2,outcome:'failed',token:'SECRET'}]});
  await assert.rejects(f.prepare(async()=>{throw error;}));assert.deepEqual(boundaryStatus(f.store).stages,[]);
  const g=await fixture(t);await g.prepare();const before=g.rows();
  const status=boundaryStatus(g.store,{inspectBoundaryCache:()=>{throw Error('SECRET /private');}});
  assert.equal(status.ready,false);assert.doesNotMatch(JSON.stringify(status),/SECRET|private/);assert.deepEqual(g.rows(),before);
});
test('malformed retained records are read-only not-ready and never echo their body',async t=>{
  const f=await fixture(t);f.store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?)').run('fictional-broken','boundary_preparation','SECRET malformed JSON');
  const before=f.store.db.prepare('SELECT record FROM factory_operation').all();
  assert.equal(boundaryStatus(f.store).ready,false);
  await assert.rejects(f.prepare(),e=>e.code==='BOUNDARY_NOT_READY'&&!e.message.includes('SECRET'));
  assert.deepEqual(f.store.db.prepare('SELECT record FROM factory_operation').all(),before);
});
test('failure aborts, is sanitized and permanently consumes setup without rewriting seed history',async t=>{
  const f=await fixture(t);f.store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?)').run('old-seed','seed_preparation',JSON.stringify({id:'old-seed',state:'failed',message:'retained'}));
  const before=f.store.db.prepare("SELECT record FROM factory_operation WHERE id='old-seed'").get().record;
  let signal;await assert.rejects(f.prepare(async options=>{signal=options.signal;throw Error('SECRET SQL provider body');}),e=>e.code==='BOUNDARY_PREPARATION_FAILED'&&!e.message.includes('SECRET'));
  assert.equal(signal.aborted,true);assert.equal(f.rows()[0].state,'failed');assert.doesNotMatch(JSON.stringify(f.rows()),/SECRET|SQL/);
  await assert.rejects(f.prepare());await assert.rejects(f.prepare(undefined,{...input,requestId:'fictional-replacement'}));
  assert.equal(f.store.db.prepare("SELECT record FROM factory_operation WHERE id='old-seed'").get().record,before);
});
for(const [label,change] of [
  ['foreign provider',v=>v.provider='other'],['wrong pin',v=>v.packageVersion='0.13.0'],['scope',v=>v.areaName='Dallas'],
  ['release',v=>v.release='latest'],['hash',v=>v.cacheSha256='bad'],['size',v=>v.bytes=33554433],
  ['bounds',v=>v.bbox=[-94,-96,29,31]],['nonfinite',v=>v.bbox[0]=Infinity],['traversal',v=>v.cacheRelative='../secret'],
  ['nested secret',v=>v.stages[0].token='SECRET'],['secret text',v=>v.attribution=['api_key=SECRET']],['extra geometry',v=>v.geometry={}],
  ['foreign source key',v=>v.sourceGlobSha256='a'.repeat(64)],['foreign native cache key',v=>v.cacheRelative='cache/other.bin'],['foreign division',v=>v.divisionId='fictional-dallas-division'],['failed success stage',v=>v.stages[0].outcome='failed'],
])test(`invalid ${label} receipt durably fails before inspector acceptance`,async t=>{
  const f=await fixture(t);const value=receipt();change(value);let inspected=0;
  await assert.rejects(f.prepare(async()=>value,input,()=>{inspected++;return good();}),e=>e.code==='BOUNDARY_PROVENANCE');
  assert.equal(inspected,0);assert.equal(f.rows()[0].state,'failed');assert.equal(f.rows()[0].receipt,undefined);
});
test('six-minute timeout propagates abort and records failure, never late success',async t=>{
  const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});let aborted=false;
  const progress=[{stage:'version',durationMs:3,outcome:'ok'},{stage:'polygon',durationMs:359000,outcome:'running'}];
  const pending=f.prepare(({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Object.assign(Error('SECRET child stopped'),{stages:progress}));},{once:true})));
  t.mock.timers.tick(360000);
  await assert.rejects(pending,e=>e.code==='BOUNDARY_DEADLINE');assert.equal(aborted,true);assert.equal(f.rows()[0].state,'failed');assert.deepEqual(f.rows()[0].stages,progress);
  t.mock.timers.reset();await assert.rejects(f.prepare());
});
