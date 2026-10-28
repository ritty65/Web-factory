import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,chmod} from 'node:fs/promises';
import path from 'node:path';
import {initialize,openStore} from '../src/db.mjs';
import {SEED_OPERATIONS,seedDispatch,validateSeedReceipt,claimSeedReceipt} from '../src/seeds.mjs';
import {operationRecord} from '../src/pilot.mjs';
import {transaction} from '../src/sales.mjs';
import {hash,now} from '../src/contracts.mjs';

const ids=['seed-0de2a46309d14565b96b5a87949952bd','seed-b51d21e8dd56416daa89b0307cd3bbbf','seed-afd6bffd4b674fe6bd893d56963b8a1a','seed-1144bc0a7d9a4a4bb673c73ea73026e8'];
const mode='houston_local_radius_v1',policy='quarantine_v1';
const settings={area:'Houston city limits',niche:'mobile detailers, custom bakers, event decorators',workflow:'leads_first',targetCount:1,candidateLimit:6,maxResearchRounds:2,maxSearches:16,discoverySearchLimit:6,maxInspections:48,maxImageViews:12,maxModelRequests:16,batchMinutes:90,jobMinutes:45,searchProvider:'firecrawl'};
const input={presetVersion:10,requestId:'fictional-quarantine-fifth',authorized:true,discoveryMode:mode,recordPolicy:policy,failedPreparationId:ids[3]};
const rows=store=>store.db.prepare("SELECT record FROM factory_operation WHERE kind='seed_preparation' ORDER BY rowid").all().map(v=>v.record);
async function fixture(t,mutate=()=>{}){
  const root=await mkdtemp('/tmp/factory-quarantine-ledger-'),options={dbPath:path.join(root,'fixture.sqlite'),stateRoot:path.join(root,'state')};await initialize(options);const store=openStore(options);t.after(()=>store.close());
  const prior=ids.map((id,i)=>({id,state:'failed',claimedBatchId:null,presetVersion:10,settings,settingsDigest:hash(settings),...(i?{retryOf:ids[i-1]}:{}),...(i>=2?{discoveryMode:mode,errorCode:'SEED_SOURCE_PROVENANCE'}:{}),...(i===3?{sourceDiagnostic:{tool:'place_details',callIndex:11,field:'source_annotation'}}:{})}));mutate(prior);prior.forEach(row=>operationRecord(store,row.id,'seed_preparation',row));
  let calls=0;return {store,get calls(){return calls;},prepare:(collector,request=input)=>seedDispatch(store,'seed_prepare',request,{preset:{adopted:true,version:10,settings},boundaryPreflight:()=>{throw Error('Must not resolve polygons');},collectSeeds:async value=>{calls++;assert.equal(value.recordPolicy,policy);assert.equal(typeof value.recordSourceEvent,'function');return collector(value);}})};
}
async function collected({recordSourceEvent},fail=false){
  const req={name:'place_details',arguments:{id:'fictional-valid'}};
  await recordSourceEvent({phase:'request',callIndex:1,tool:'place_details',value:req});
  const descriptor=await recordSourceEvent({phase:'response',callIndex:1,tool:'place_details',value:{structuredContent:{id:'fictional-valid',researchOnly:'https://example.org/photo?token=fictional-private-value'}}});
  const summary={schemaVersion:1,sampled:1,attempted:1,admitted:fail?0:1,quarantined:fail?1:0,records:[{sampleIndex:0,sourceId:'fictional-valid',callIndex:1,responseSha256:descriptor.sha256,outcome:fail?'quarantined':'admitted',...(fail?{code:'SEED_SOURCE_PROVENANCE',field:'source_annotation'}:{})}]};
  await recordSourceEvent({phase:'summary',callIndex:0,tool:'collection',value:summary});
  if(fail)throw Object.assign(Error('Private error body must not persist'),{code:'SEED_SOURCE_EMPTY'});
  return {provider:'placeroot',retrievedAt:now(),version:{release:'2026-09-23.1',discovery:{mode,lat:29.75893783569336,lon:-95.3676986694336,radiusM:15000,cityEligibility:'unknown',pages:[{fixture:'No live source data'}],admissionSummary:summary}},attribution:['Fictional source fixture only'],limitations:['Unverified approximate pointers'],items:[{id:'fictional-valid',name:'Fictional Cake Shop',location:{lat:29.76,lon:-95.37},categories:['bakery'],urls:[],provenance:{dataset:'fictional'}}]};
}
test('new record policy is strict opt-in without changing historical request bytes',()=>{
  assert.equal(SEED_OPERATIONS.seed_prepare.schema.safeParse(input).success,true);
  const old={presetVersion:10,requestId:'fictional-old',authorized:true};assert.deepEqual(SEED_OPERATIONS.seed_prepare.schema.parse(old),old);
  assert.equal(SEED_OPERATIONS.seed_prepare.schema.safeParse({...input,recordPolicy:'anything'}).success,false);
});
test('one exact fifth preparation retains private replay evidence, historical bytes and immutable binding',async t=>{
  const f=await fixture(t),before=rows(f.store),result=await f.prepare(collected);
  assert.equal(f.calls,1);assert.equal(rows(f.store).length,5);for(const value of before)assert.ok(rows(f.store).includes(value));
  const row=JSON.parse(rows(f.store).at(-1));assert.equal(row.recordPolicy,policy);assert.equal(row.sourceCapture.state,'complete');
  assert.equal(result.version.sourceCaptureDigest,row.sourceCapture.digest);assert.equal(result.recordPolicy,policy);
  assert.doesNotMatch(JSON.stringify(result),/fictional-private-value|researchOnly|seed-source-receipts/);
  assert.deepEqual(await f.prepare(collected),result);assert.equal(f.calls,1);
  transaction(f.store,()=>claimSeedReceipt(f.store,validateSeedReceipt(f.store,result,settings),'batch-fictional-quarantine'));
  await assert.rejects(f.prepare(collected,{...input,requestId:'fictional-sixth'}),e=>e.code==='SEED_ALREADY_ATTEMPTED');
});
test('all-quarantined failure retains its journal and cannot unlock a sixth attempt',async t=>{
  const f=await fixture(t);await assert.rejects(f.prepare(args=>collected(args,true)),e=>e.code==='SEED_SOURCE_EMPTY');
  const row=JSON.parse(rows(f.store).at(-1));assert.equal(row.state,'failed');assert.equal(row.sourceCapture.state,'incomplete');assert.equal(row.sourceCapture.events.at(-1).phase,'summary');
  assert.doesNotMatch(JSON.stringify(row),/fictional-private-value|Private error body/);
  await assert.rejects(f.prepare(collected,{...input,requestId:'fictional-sixth-failure'}));assert.equal(f.calls,1);
});
test('wrong predecessor, incomplete chain, diagnostic or missing policy cannot reserve a fifth',async t=>{
  for(const mutate of [p=>p.pop(),p=>{p[3].sourceDiagnostic.field='unspecified';},p=>{p[3].retryOf=ids[0];},p=>{p[0].claimedBatchId='batch-old';},p=>{p[3].state='preparing';},p=>{p[2].settingsDigest='0'.repeat(64);}]){
    const f=await fixture(t,mutate),before=rows(f.store);await assert.rejects(f.prepare(collected),e=>e.code==='SEED_ALREADY_ATTEMPTED');assert.deepEqual(rows(f.store),before);assert.equal(f.calls,0);
  }
  const f=await fixture(t);for(const request of [{...input,recordPolicy:undefined},{...input,failedPreparationId:ids[2]},{...input,discoveryMode:undefined}])await assert.rejects(f.prepare(collected,request));assert.equal(f.calls,0);
});
test('changed raw journal blocks receipt read and claim before any further source work',async t=>{
  const f=await fixture(t),result=await f.prepare(collected),row=JSON.parse(rows(f.store).at(-1));
  const files=await import('node:fs/promises');const directory=path.join(f.store.stateRoot,'references','seed-source-receipts',row.id);const entries=await files.readdir(directory);const file=path.join(directory,entries.find(v=>v.includes('response'))||entries[0]);
  const content=await readFile(file);await chmod(file,0o600);await writeFile(file,Buffer.concat([content,Buffer.from(' ')]));
  assert.throws(()=>validateSeedReceipt(f.store,result,settings));assert.throws(()=>transaction(f.store,()=>claimSeedReceipt(f.store,result,'batch-fictional-tampered')));assert.equal(f.calls,1);
});
test('admission summary must match the retained summary and actual detail-response descriptors',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.prepare(async args=>{const source=await collected(args);source.version.discovery.admissionSummary.records[0].responseSha256='f'.repeat(64);return source;}),e=>['SEED_SOURCE_CAPTURE','SEED_PROVENANCE'].includes(e.code));
  assert.equal(JSON.parse(rows(f.store).at(-1)).state,'failed');
});
test('new captured receipts cannot downgrade to historical no-capture semantics',async t=>{
  const f=await fixture(t),result=await f.prepare(collected),row=JSON.parse(rows(f.store).at(-1));
  const file=path.join(f.store.stateRoot,'references','seed-cohorts',result.id+'.json'),receipt=JSON.parse(await readFile(file));
  delete receipt.recordPolicy;delete row.recordPolicy;const bytes=Buffer.from(JSON.stringify(receipt));row.digest=hash(bytes);await chmod(file,0o640);await writeFile(file,bytes);operationRecord(f.store,row.id,'seed_preparation',row);
  assert.throws(()=>validateSeedReceipt(f.store,{id:row.id,digest:row.digest},settings));
});
test('actual collector and private sink admit only valid fixed-sample records and bind shared stdio reads',async t=>{
  const {collectSeeds}=await import('../src/seed-source.mjs');const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const tools=JSON.parse(await readFile(new URL('../tools/placeroot-runtime/tools-list.json',import.meta.url),'utf8')).tools;
  let dataCalls=0,closed=false;const details=new Map();
  const connector=async()=>({listTools:async()=>({tools}),close:async()=>{closed=true;},callTool:async({name,arguments:args})=>{
    dataCalls++;let value;
    if(name==='data_version')value={release:'2026-09-23.1',source:'fictional-offline'};
    else if(name==='search_categories')value={results:[{slug:{'auto detailing':'auto_detailing',bakery:'bakery','event planning':'event_planning'}[args.query]}]};
    else if(name==='find_places'){
      assert.equal(args.area,undefined);assert.equal(args.radius_m,15000);
      const row={id:'fictional-'+args.category,name:'Fictional '+args.category,category:args.category,lat:29.75893783569336,lon:-95.3676986694336,distance_m:0};
      details.set(row.id,{...row,sources:[{dataset:args.category==='event_planning'?'fictional_unknown':'meta',record_id:'fixture-source-id'}],socials:[],websites:[]});value={results:[row]};
    }else if(name==='place_details')value=details.get(args.id);else throw Error('Unexpected source route');
    return {structuredContent:value};
  }});
  const f=await fixture(t),result=await f.prepare(args=>collectSeeds({...args,connector}));
  assert.equal(dataCalls,10);assert.equal(closed,true);assert.equal(result.count,2);const summary=result.version.discovery.admissionSummary;
  assert.equal(summary.sampled,3);assert.equal(summary.admitted,2);assert.equal(summary.quarantined,1);assert.equal(summary.records[2].outcome,'quarantined');
  assert.equal(result.items.some(v=>v.categories.includes('event_planning')),false);
  const {readSeedCaptureEvents}=await import('../src/seed-capture.mjs');const row=JSON.parse(rows(f.store).at(-1)),events=readSeedCaptureEvents(f.store,row);let replayIndex=0;
  const beforeReplay=f.store.db.prepare('SELECT total_changes() n').get().n;
  const replay=await collectSeeds({discoveryMode:mode,recordPolicy:policy,recordSourceEvent:async event=>{
    const expected=events[replayIndex++];assert.equal(event.phase,expected.phase);assert.equal(event.tool,expected.tool);assert.equal(event.callIndex,expected.callIndex);assert.deepEqual(event.value,expected.value);
    const {value,...descriptor}=expected;return descriptor;
  },connector:async()=>({listTools:async()=>({tools}),close:async()=>{},callTool:async request=>{
    const expected=events[replayIndex];assert.equal(expected.phase,'response');assert.equal(expected.tool,request.name);return structuredClone(expected.value);
  }})});
  assert.equal(replayIndex,events.length);assert.deepEqual(replay.version.discovery.admissionSummary,summary);assert.equal(dataCalls,10,'offline replay must not call the source connector');
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,beforeReplay);
  const client=new Client({name:'quarantine-shared-interface-fixture',version:'1'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['src/mcp.mjs'],env:{PATH:'',FACTORY_DB:f.store.dbPath,FACTORY_STATE:f.store.stateRoot,FACTORY_AUTORUN:'0'},stderr:'pipe'}));
    const tool=(await client.listTools()).tools.find(v=>v.name==='seed_prepare');assert.deepEqual(tool.inputSchema.properties.recordPolicy.enum,[policy]);
    const retained=await client.callTool({name:'seed_get',arguments:{id:result.id}});assert.equal(retained.structuredContent.digest,result.digest);assert.equal(retained.structuredContent.count,2);
    assert.doesNotMatch(JSON.stringify(retained),/structuredContent.*researchOnly|seed-source-receipts/);
  }finally{await client.close();}
});
test('restore cannot certify prepared quarantine cohorts with missing or mismatched journal bindings',async t=>{
  const {createSnapshot,restoreSnapshotCheck}=await import('../src/recovery.mjs');
  for(const defect of ['missing_capture','wrong_immutable_digest']){
    const f=await fixture(t),result=await f.prepare(collected),row=JSON.parse(rows(f.store).at(-1));
    if(defect==='missing_capture')delete row.sourceCapture;
    else{
      const file=path.join(f.store.stateRoot,'references','seed-cohorts',result.id+'.json'),receipt=JSON.parse(await readFile(file));receipt.version.sourceCaptureDigest='f'.repeat(64);
      const bytes=Buffer.from(JSON.stringify(receipt));await chmod(file,0o640);await writeFile(file,bytes);row.digest=hash(bytes);row.sourceVersionDigest=hash(receipt.version);
    }
    operationRecord(f.store,row.id,'seed_preparation',row);const snapshot=await createSnapshot(f.store),drill=await restoreSnapshotCheck(f.store,snapshot.id);
    assert.equal(drill.pass,false,defect);assert.equal(drill.seedCaptureReferencesChecked,1);assert.deepEqual(drill.staleOrMissingSeedCaptureIds,[row.id]);
  }
});
