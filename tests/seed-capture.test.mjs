import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, lstatSync, readdirSync, symlinkSync, linkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { initialize, openStore } from '../src/db.mjs';
import { operationRecord } from '../src/pilot.mjs';
import { hash } from '../src/contracts.mjs';
import { createSeedCapture, verifySeedCapture, readSeedCaptureEvents } from '../src/seed-capture.mjs';

const MiB=1024*1024;
const rejected=e=>e.code==='SEED_SOURCE_CAPTURE' && !/PRIVATE|fixture-secret|receipts\//.test(e.message);
async function fixture(t) {
  const root=mkdtempSync('/tmp/factory-seed-capture-'),options={dbPath:path.join(root,'fixture.sqlite3'),stateRoot:path.join(root,'state')};
  await initialize(options);const store=openStore(options);t.after(()=>store.close());
  const row={id:'seed-'+'a'.repeat(32),state:'preparing',inputDigest:hash('fictional input'),settingsDigest:hash({area:'fictional'}),discoveryMode:'houston_local_radius_v1',recordPolicy:'quarantine_v1',retryOf:'seed-'+'b'.repeat(32)};
  operationRecord(store,row.id,'seed_preparation',row);
  const latest=()=>JSON.parse(store.db.prepare('SELECT record FROM factory_operation WHERE id=?').get(row.id).record);
  const directory=path.join(store.stateRoot,'references','seed-source-receipts',row.id);
  return {root,store,row,latest,directory,save:r=>operationRecord(store,row.id,'seed_preparation',r)};
}
const request=(callIndex=1,tool='place_details')=>({phase:'request',callIndex,tool,value:{name:tool,arguments:{id:'fictional'}}});
const response=(callIndex=1,value={structuredContent:{fictional:true}},tool='place_details')=>({phase:'response',callIndex,tool,value});
const summary=()=>({phase:'summary',callIndex:0,tool:'collection',value:{schemaVersion:1,sampled:1,attempted:1,admitted:1,quarantined:0,records:[]}});
const eventFile=(f,event)=>path.join(f.directory,`${event.callIndex}-${event.phase}.json`);

test('durable application JSON capture stays private and preserves latest row fields',async t=>{
  const f=await fixture(t),capture=createSeedCapture(f.store,f.row);
  assert.equal(f.latest().sourceCapture.state,'collecting');
  const req=await capture.recordSourceEvent(request());
  f.save({...f.latest(),otherNewField:'keep me'});
  const value={token:'fixture-secret',url:'https://private.invalid/?signature=fixture-secret',text:'PRIVATE source body'};
  const res=await capture.recordSourceEvent(response(1,value));
  await capture.recordSourceEvent(summary());
  const complete=await capture.finish('complete');
  assert.equal(f.latest().otherNewField,'keep me');
  assert.equal(complete.state,'complete');assert.equal(complete.events.length,3);
  assert.deepEqual(Object.keys(res).sort(),['bytes','callIndex','phase','sha256','tool']);
  assert.equal(res.bytes,Buffer.byteLength(JSON.stringify(value)));assert.equal(res.sha256,hash(JSON.stringify(value)));
  assert.doesNotMatch(JSON.stringify(f.latest()),/fixture-secret|PRIVATE|signature|references\//);
  assert.equal(lstatSync(f.directory).mode&0o777,0o700);
  assert.equal(lstatSync(path.dirname(f.directory)).mode&0o777,0o700);
  for(const name of readdirSync(f.directory))assert.equal(lstatSync(path.join(f.directory,name)).mode&0o777,0o600);
  assert.equal(readFileSync(eventFile(f,res),'utf8'),JSON.stringify(value));
  const before=f.store.db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(verifySeedCapture(f.store,f.latest()),complete);
  assert.deepEqual(readSeedCaptureEvents(f.store,f.latest()).slice(0,2),[{...req,value:request().value},{...res,value}]);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,before);
  complete.events[0].tool='geocode';assert.equal(verifySeedCapture(f.store,f.latest()).events[0].tool,'place_details');
  await assert.rejects(capture.recordSourceEvent(request(2)),rejected);
});
test('failed and interrupted prefixes are verified diagnostics, never implicitly resumed',async t=>{
  const f=await fixture(t),capture=createSeedCapture(f.store,f.row);
  await capture.recordSourceEvent(request());
  assert.equal(verifySeedCapture(f.store,f.latest()).state,'collecting');
  assert.throws(()=>createSeedCapture(f.store,f.latest()),rejected);
  await capture.recordSourceEvent({phase:'failure',callIndex:1,tool:'place_details',value:{code:'SEED_SOURCE_TIMEOUT'}});
  await capture.recordSourceEvent(summary());
  const finished=await capture.finish('incomplete');assert.equal(finished.state,'incomplete');
  assert.equal(readSeedCaptureEvents(f.store,f.latest())[1].value.code,'SEED_SOURCE_TIMEOUT');
  assert.deepEqual(await capture.finish('incomplete'),finished);
  await assert.rejects(capture.finish('complete'),rejected);
});
test('incomplete may retain pending request but complete cannot certify it',async t=>{
  const f=await fixture(t),capture=createSeedCapture(f.store,f.row);await capture.recordSourceEvent(request());
  await assert.rejects(capture.finish('complete'),rejected);
  assert.equal((await capture.finish('incomplete')).state,'incomplete');
  await assert.rejects(capture.recordSourceEvent(response()),rejected);
});
test('invalid order/tool/phase/value fatally latches without adding descriptor or later writes',async t=>{
  const invalid=[request(2),response(),{...request(),phase:'other'},{...request(),tool:'https://private.invalid/'},{...request(),extra:'PRIVATE'}, {...request(),value:undefined}];
  for(const event of invalid){const f=await fixture(t),capture=createSeedCapture(f.store,f.row);await assert.rejects(capture.recordSourceEvent(event),rejected);await assert.rejects(capture.recordSourceEvent(request()),rejected);assert.equal(f.latest().sourceCapture.events.length,0);await capture.finish('incomplete');}
  for(const event of [request(),response(1,{},'geocode'),request(2)]){const f=await fixture(t),capture=createSeedCapture(f.store,f.row);await capture.recordSourceEvent(request());await assert.rejects(capture.recordSourceEvent(event),rejected);assert.equal(f.latest().sourceCapture.events.length,1);}
});
test('summary is bounded, unique and terminal even on a pending interrupted call',async t=>{
  const f=await fixture(t),capture=createSeedCapture(f.store,f.row);await capture.recordSourceEvent(request());await capture.recordSourceEvent(summary());
  await assert.rejects(capture.recordSourceEvent(summary()),rejected);await capture.finish('incomplete');
  assert.equal(verifySeedCapture(f.store,f.latest()).events.length,2);
  const g=await fixture(t),other=createSeedCapture(g.store,g.row);await assert.rejects(other.recordSourceEvent({...summary(),value:'x'.repeat(65536)}),rejected);assert.equal(readdirSync(g.directory).length,0);
});
test('byte bounds reject before writes: combined call, aggregate and 28th request',async t=>{
  const f=await fixture(t),capture=createSeedCapture(f.store,f.row);await capture.recordSourceEvent(request());
  await assert.rejects(capture.recordSourceEvent(response(1,'x'.repeat(MiB))),rejected);assert.equal(readdirSync(f.directory).length,1);
  const g=await fixture(t),other=createSeedCapture(g.store,g.row);
  for(let i=1;i<=16;i++){const req={...request(i),value:{name:'place_details',arguments:{}}};await other.recordSourceEvent(req);await other.recordSourceEvent(response(i,'x'.repeat(MiB-Buffer.byteLength(JSON.stringify(req.value))-2)));}
  assert.equal(g.latest().sourceCapture.totalBytes,16*MiB);
  await assert.rejects(other.recordSourceEvent(request(17)),rejected);assert.equal(readdirSync(g.directory).length,32);
  const h=await fixture(t),last=createSeedCapture(h.store,h.row);
  for(let i=1;i<=27;i++){await last.recordSourceEvent(request(i));await last.recordSourceEvent(response(i));}
  await assert.rejects(last.recordSourceEvent(request(28)),rejected);assert.equal(h.latest().sourceCapture.events.length,54);
});
test('serialization errors and cancellation retain a bounded valid prefix and block late writes',async t=>{
  for(const value of [1n,(()=>{const v={};v.self=v;return v;})()]){const f=await fixture(t),capture=createSeedCapture(f.store,f.row);await capture.recordSourceEvent(request());await assert.rejects(capture.recordSourceEvent(response(1,value)),rejected);await capture.finish('incomplete');assert.equal(verifySeedCapture(f.store,f.latest()).events.length,1);}
  const f=await fixture(t),controller=new AbortController(),capture=createSeedCapture(f.store,f.row,{signal:controller.signal});await capture.recordSourceEvent(request());controller.abort();
  await assert.rejects(capture.recordSourceEvent(response()),rejected);await capture.finish('incomplete');assert.equal(verifySeedCapture(f.store,f.latest()).events.length,1);
  const g=await fixture(t),aborted=new AbortController();aborted.abort();assert.throws(()=>createSeedCapture(g.store,g.row,{signal:aborted.signal}),rejected);
});
test('rejects existing namespace symlinks/public permissions and exclusive run reuse',async t=>{
  for(const mode of ['symlink','public']){const f=await fixture(t);mkdirSync(path.dirname(f.directory),{recursive:true,mode:0o700});
    if(mode==='symlink'){const outside=path.join(f.root,'outside');mkdirSync(outside);symlinkSync(outside,f.directory);}else chmodSync(path.dirname(f.directory),0o755);
    assert.throws(()=>createSeedCapture(f.store,f.row),rejected);assert.equal(f.latest().sourceCapture,undefined);
  }
  const f=await fixture(t);createSeedCapture(f.store,f.row);assert.throws(()=>createSeedCapture(f.store,f.row),rejected);
});
test('exclusive file/symlink write failure is fatal, preserves prefix and never overwrites',async t=>{
  for(const kind of ['file','symlink']){const f=await fixture(t),capture=createSeedCapture(f.store,f.row),target=eventFile(f,request());
    if(kind==='file')writeFileSync(target,'PRIVATE existing',{mode:0o600});else symlinkSync(path.join(f.root,'outside'),target);
    await assert.rejects(capture.recordSourceEvent(request()),rejected);await assert.rejects(capture.recordSourceEvent(request()),rejected);await capture.finish('incomplete');assert.equal(f.latest().sourceCapture.events.length,0);
    if(kind==='file')assert.equal(readFileSync(target,'utf8'),'PRIVATE existing');
  }
});
test('read checks hash, missing bytes, file privacy, hard links, symlinks and directory privacy',async t=>{
  for(const mutation of ['hash','missing','permissions','hardlink','symlink','directory']){const f=await fixture(t),capture=createSeedCapture(f.store,f.row);const descriptor=await capture.recordSourceEvent(request());await capture.finish('incomplete');const file=eventFile(f,descriptor);
    if(mutation==='hash')writeFileSync(file,'{}');if(mutation==='missing')unlinkSync(file);if(mutation==='permissions')chmodSync(file,0o644);
    if(mutation==='hardlink')linkSync(file,path.join(f.root,'linked'));if(mutation==='symlink'){const bytes=readFileSync(file),other=path.join(f.root,'other');writeFileSync(other,bytes,{mode:0o600});unlinkSync(file);symlinkSync(other,file);}
    if(mutation==='directory')chmodSync(f.directory,0o750);
    assert.throws(()=>verifySeedCapture(f.store,f.latest()),rejected);assert.throws(()=>readSeedCaptureEvents(f.store,f.latest()),rejected);
  }
});
test('descriptor tampering/reordering and frozen-binding substitution fail without writes',async t=>{
  for(const mutate of [r=>r.sourceCapture.events.reverse(),r=>r.sourceCapture.events[0].bytes++,r=>r.sourceCapture.totalBytes++,r=>r.sourceCapture.extra='PRIVATE',r=>r.inputDigest=hash('changed'),r=>r.settingsDigest=hash('changed'),r=>r.retryOf='seed-'+'c'.repeat(32),r=>r.recordPolicy='other',r=>r.discoveryMode='other']){
    const f=await fixture(t),capture=createSeedCapture(f.store,f.row);await capture.recordSourceEvent(request());await capture.recordSourceEvent(response());await capture.finish('complete');const row=f.latest();mutate(row);f.save(row);const changes=f.store.db.prepare('SELECT total_changes() n').get().n;assert.throws(()=>verifySeedCapture(f.store,row),rejected);assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,changes);
  }
  const f=await fixture(t),capture=createSeedCapture(f.store,f.row);await capture.finish('incomplete');const other={...f.latest(),id:'seed-'+'d'.repeat(32)};operationRecord(f.store,other.id,'seed_preparation',other);assert.throws(()=>verifySeedCapture(f.store,other),rejected);
});
test('durable write does not overwrite concurrent binding/capture changes or unrelated row fields',async t=>{
  const f=await fixture(t),capture=createSeedCapture(f.store,f.row);await capture.recordSourceEvent(request());f.save({...f.latest(),inputDigest:hash('changed')});await assert.rejects(capture.recordSourceEvent(response()),rejected);
  assert.equal(f.latest().sourceCapture.events.length,1);
});
test('capture keeps its original binding when caller mutates its row object',async t=>{
  const f=await fixture(t),capture=createSeedCapture(f.store,f.row);await capture.recordSourceEvent(request());
  f.row.inputDigest=hash('changed caller and ledger');f.save({...f.latest(),inputDigest:f.row.inputDigest});
  await assert.rejects(capture.recordSourceEvent(response()),rejected);
  assert.equal(f.latest().sourceCapture.events.length,1);assert.equal(readdirSync(f.directory).length,1);
});
test('fsync failure is sanitized, latches and retains only the previously durable descriptor prefix',async t=>{
  const f=await fixture(t),capture=createSeedCapture(f.store,f.row);await capture.recordSourceEvent(request());
  const original=fs.fsyncSync;
  try {
    fs.fsyncSync=()=>{throw Error('PRIVATE simulated fsync failure');};syncBuiltinESMExports();
    await assert.rejects(capture.recordSourceEvent(response()),rejected);
  } finally {fs.fsyncSync=original;syncBuiltinESMExports();}
  await assert.rejects(capture.recordSourceEvent(request(2)),rejected);
  await capture.finish('incomplete');assert.equal(verifySeedCapture(f.store,f.latest()).events.length,1);
  assert.equal(readSeedCaptureEvents(f.store,f.latest()).length,1);
});
test('ledger update failure cannot acknowledge a file or erase the last registered prefix',async t=>{
  const f=await fixture(t),capture=createSeedCapture(f.store,f.row);await capture.recordSourceEvent(request());
  f.store.db.exec("CREATE TEMP TRIGGER fail_capture BEFORE UPDATE ON factory_operation BEGIN SELECT RAISE(ABORT,'PRIVATE ledger failure'); END");
  await assert.rejects(capture.recordSourceEvent(response()),rejected);
  assert.equal(f.latest().sourceCapture.events.length,1);
  f.store.db.exec('DROP TRIGGER fail_capture');
  await assert.rejects(capture.recordSourceEvent(response()),rejected);await capture.finish('incomplete');
  assert.equal(verifySeedCapture(f.store,f.latest()).events.length,1);
});
test('symlink ancestor cannot redirect private journal creation',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'outside');mkdirSync(outside,{mode:0o700});
  symlinkSync(outside,path.join(f.store.stateRoot,'references'));
  assert.throws(()=>createSeedCapture(f.store,f.row),rejected);assert.equal(readdirSync(outside).length,0);
});
test('recomputed metadata digest cannot bypass descriptor sequence, bounds or complete-prefix rules',async t=>{
  for(const mutate of [r=>r.sourceCapture.events.reverse(),r=>r.sourceCapture.events[1].tool='geocode',r=>r.sourceCapture.events[0].bytes=MiB+1,r=>{r.sourceCapture.events.pop();}]) {
    const f=await fixture(t),capture=createSeedCapture(f.store,f.row);await capture.recordSourceEvent(request());await capture.recordSourceEvent(response());await capture.finish('complete');
    const row=f.latest();mutate(row);
    const {schemaVersion,state,events}=row.sourceCapture,totalBytes=events.reduce((n,e)=>n+e.bytes,0);
    const binding=Object.fromEntries(['id','inputDigest','settingsDigest','discoveryMode','recordPolicy','retryOf'].map(k=>[k,row[k]??null]));
    row.sourceCapture={schemaVersion,state,events,totalBytes,digest:hash({binding,schemaVersion,state,events,totalBytes})};f.save(row);
    assert.throws(()=>verifySeedCapture(f.store,row),rejected);
  }
});
