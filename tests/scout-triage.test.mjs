import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {scoutStep,scoutSummary} from '../src/scout.mjs';
import {getBatch,saveBatch} from '../src/batch-store.mjs';
import {sourceJobPolicy} from '../src/batch-budget.mjs';
import {openStore} from '../src/db.mjs';
import {hash,now} from '../src/contracts.mjs';
import {acquisitionFixture,draftFixture} from './helpers-acquisition.mjs';

const profile='https://www.instagram.com/returned_workshop/';
const listing='https://www.yelp.com/biz/returned-workshop-houston';
const mixed=['https://www.instagram.com/reel/Returned123/','https://www.facebook.com/groups/workshops/','https://www.yelp.com/search?find_desc=workshops','https://official.example/',listing,profile];
const args=(f,extra={})=>({store:f.store,jobId:f.job.id,directory:f.directory,output:{candidates:[]},search:async()=>{throw new Error('Unexpected broad search');},inspect:async()=>{throw new Error('Unexpected inspection');},...extra});
function tasks(f){return f.store.db.prepare("SELECT record FROM factory_operation WHERE kind='scout_task' AND json_extract(record,'$.batchId')=? ORDER BY rowid").all(f.b.id).map(r=>JSON.parse(r.record));}
async function receipt(f,urls=mixed,change=()=>{}){
  let record;
  await scoutStep(args(f,{search:async(query,ctx)=>{record={query,provider:ctx.provider,intent:'discover',status:'completed',at:now(),results:urls.map(url=>({url,title:'Untrusted discovery locator only',description:'Never business facts'}))};change(record);await writeFile(path.join(f.directory,`search-${hash(query).slice(0,16)}.json`),JSON.stringify(record));return record;}}));
  return record;
}
test('returned individual profile precedes reel/group/directory/official URL and supported listing, counted once as inspection',async t=>{
  const f=await acquisitionFixture(t);await receipt(f);const seen=[];
  const adapters={inspect:async url=>{seen.push(url);return {id:'source-returned123',url,inspectedAt:now(),blocked:false,text:'Inspected locator, not an identity or qualification',links:[],images:[],captures:[]};}};
  const r=await scoutStep(args(f,adapters));assert.equal(r.status,'observed');assert.deepEqual(seen,[profile]);assert.deepEqual(r.question,{purpose:'search_result'});assert.equal(r.fullQualification,false);assert.equal(r.humanAcceptance,false);assert.equal(f.store.candidates().length,0);
  const b=getBatch(f.store,f.b.id);assert.equal(b.usage.searches,1);assert.equal(b.usage.inspections,1);assert.equal(b.discoveryUsage.searches,1);assert.equal(tasks(f)[1].purpose,'search_result');
  const reopened=openStore(f.options);try{await scoutStep({...args(f,adapters),store:reopened});}finally{reopened.close();}
  assert.deepEqual(seen,[profile,listing]);assert.equal(getBatch(f.store,f.b.id).usage.searches,1);
});
for(const outcome of ['blocked','failed','stale','attempted'])test(`retained triage does not repeat a ${outcome} route after restart`,async t=>{
  const f=await acquisitionFixture(t);await receipt(f,[profile]);let calls=0;
  const inspect=async url=>{calls++;if(outcome==='failed')throw new Error('Synthetic failure');return {id:'source-retained123',url,blocked:outcome==='blocked',inspectedAt:outcome==='stale'?'2020-01-01':now(),text:'Synthetic locator',links:[],images:[],captures:[]};};
  if(outcome==='attempted')sourceJobPolicy(f.store,f.job.id,f.directory).reserve('inspections',{url:profile});else await scoutStep(args(f,{inspect}));
  const reopened=openStore(f.options);let searched=0;try{const r=await scoutStep({...args(f,{inspect,search:async()=>{searched++;return {status:'blocked'};}}),store:reopened});assert.equal(r.status,'blocked');}finally{reopened.close();}
  assert.equal(calls,outcome==='attempted'?0:1);assert.equal(searched,1);
});
for(const invalid of ['future','stale','wrongprovider','wrongjob','wrongattempt','changed','failed'])test(`a ${invalid} search receipt cannot authorize retained route triage`,async t=>{
  const f=await acquisitionFixture(t);const record=await receipt(f,[profile],r=>{if(invalid==='future')r.at=new Date(Date.now()+60000).toISOString();if(invalid==='stale')r.at='2020-01-01';if(invalid==='wrongprovider')r.provider='guest_bing';if(invalid==='failed')r.status='blocked';});
  const task=tasks(f)[0];if(['wrongjob','wrongattempt'].includes(invalid)){task[invalid==='wrongjob'?'jobId':'attempt']=invalid==='wrongjob'?'job-other':99;f.store.db.prepare('UPDATE factory_operation SET record=? WHERE id=?').run(JSON.stringify(task),task.id);}
  if(invalid==='changed'){record.results.push({url:'https://www.facebook.com/notreturned/'});await writeFile(path.join(f.directory,`search-${hash(record.query).slice(0,16)}.json`),JSON.stringify(record));}
  let calls=0;const r=await scoutStep(args(f,{inspect:async()=>{calls++;},search:async()=>({status:'blocked'})}));assert.equal(calls,0);assert.equal(r.status,'blocked');assert.equal(getBatch(f.store,f.b.id).usage.inspections,0);
});
for(const guard of ['capacity','claimed','ready','cohort'])test(`retained routes never outrank the ${guard} guard`,async t=>{
  const f=await acquisitionFixture(t,{candidateLimit:1});await receipt(f);let output={candidates:[]};
  if(guard==='capacity'){const b=getBatch(f.store,f.b.id);saveBatch(f.store,{...b,usage:{...b.usage,inspections:6}});}
  if(guard==='claimed'){const task=tasks(f)[0];task.status='claimed';f.store.db.prepare('UPDATE factory_operation SET record=? WHERE id=?').run(JSON.stringify(task),task.id);}
  if(['ready','cohort'].includes(guard)){const d=await draftFixture(f);if(guard==='cohort')d.output.candidates[0].inspectionIds=[];await scoutStep(args(f,{output:d.output}));}
  const before=getBatch(f.store,f.b.id),r=await scoutStep(args(f,{output}));assert.equal(r.status,{capacity:'capacity_held',claimed:'inflight_or_interrupted',ready:'ready_to_finalize',cohort:'cohort_exhausted'}[guard]);assert.deepEqual(getBatch(f.store,f.b.id).usage,before.usage);
});
test('retained triage is finite per job and cannot reset its cap with another receipt',async t=>{
  const f=await acquisitionFixture(t,{maxInspections:20}),urls=Array.from({length:5},(_,i)=>`https://www.instagram.com/returned_${i}/`);await receipt(f,urls);let calls=0;
  const inspect=async url=>{calls++;return {id:'source-bounded123',url,inspectedAt:now(),blocked:true,text:'Synthetic blocked route',links:[],images:[],captures:[]};};
  for(let i=0;i<3;i++)await scoutStep(args(f,{inspect}));
  await receipt(f,urls.slice(3));await scoutStep(args(f,{inspect}));
  const r=await scoutStep(args(f,{inspect,search:async()=>({status:'blocked'})}));assert.equal(r.status,'blocked');assert.equal(calls,4);assert.equal(tasks(f).filter(v=>v.purpose==='search_result').length,4);assert.equal(scoutSummary(f.store,f.b.id).counts.claimed,0);
});
test('unsafe URLs, unsupported routes and guessed profile parents never become retained triage actions',async t=>{
  const f=await acquisitionFixture(t);await receipt(f,['https://127.0.0.1/','https://www.instagram.com/reel/DoNotInfer/','https://www.facebook.com/groups/workshops/','https://m.yelp.com/biz/not-supported','https://official.example/?token=secret']);
  let calls=0;const r=await scoutStep(args(f,{inspect:async()=>{calls++;},search:async()=>({status:'blocked'})}));assert.equal(calls,0);assert.equal(r.status,'blocked');assert.equal(getBatch(f.store,f.b.id).usage.inspections,0);
});
for(const kind of ['blocked','stale','unrelated'])test(`existing ${kind} observation is never re-inspected via a returned locator`,async t=>{
  const f=await acquisitionFixture(t);await receipt(f,[profile]);
  await writeFile(path.join(f.directory,'source-abcdef123.json'),JSON.stringify({id:'source-abcdef123',url:profile,inspectedAt:kind==='stale'?'2020-01-01':now(),blocked:kind==='blocked',text:'Unrelated workshop, no identity proof',links:[],images:[],captures:[]}));
  let calls=0;const r=await scoutStep(args(f,{inspect:async()=>{calls++;},search:async()=>({status:'blocked'})}));assert.equal(calls,0);assert.equal(r.status,'blocked');assert.equal(f.store.candidates().length,0);
});
test('changing a retained receipt during inspection keeps its charge and failed task, never a completed result',async t=>{
  const f=await acquisitionFixture(t),record=await receipt(f,[profile]);let calls=0;
  const r=await scoutStep(args(f,{inspect:async url=>{calls++;record.results=[];await writeFile(path.join(f.directory,`search-${hash(record.query).slice(0,16)}.json`),JSON.stringify(record));return {id:'source-late123',url,inspectedAt:now(),blocked:false,text:'Late locator',links:[],images:[],captures:[]};}}));
  assert.equal(r.status,'blocked');assert.equal(r.observation,undefined);assert.equal(calls,1);assert.equal(tasks(f)[1].code,'SOURCE_SCOUT_CHANGED');assert.equal(getBatch(f.store,f.b.id).usage.inspections,1);
});
test('empty-draft triage still respects retained cohort cap rather than adopting a replacement',async t=>{
  const f=await acquisitionFixture(t,{candidateLimit:1}),d=await draftFixture(f);d.output.candidates[0].inspectionIds=[];
  await scoutStep(args(f,{output:d.output}));await writeFile(path.join(f.directory,'search-abc123.json'),JSON.stringify({status:'completed',provider:'firecrawl',intent:'discover',at:now(),query:'Unplanned locator',results:[{url:profile}]}));
  const r=await scoutStep(args(f));assert.equal(r.status,'cohort_exhausted');assert.equal(r.retainedDraftIdentities.length,1);assert.equal(getBatch(f.store,f.b.id).usage.inspections,0);
});
for(const navigation of [
  'https://www.facebook.com/watch/','https://www.facebook.com/marketplace/','https://www.facebook.com/messages/',
  'https://www.facebook.com/messenger/','https://www.facebook.com/notifications/','https://www.facebook.com/friends/',
  'https://www.facebook.com/gaming/','https://www.facebook.com/events/','https://www.facebook.com/pages/',
  'https://www.facebook.com/checkpoint/','https://www.facebook.com/login/',
  'https://www.instagram.com/direct/','https://www.instagram.com/challenge/','https://www.instagram.com/accounts/',
  'https://www.instagram.com/emails/','https://www.instagram.com/session/',
])test(`retained platform control ${navigation} yields to an actually returned supported listing`,async t=>{
  const f=await acquisitionFixture(t);await receipt(f,[navigation,listing]);const seen=[];
  const inspect=async url=>{seen.push(url);return {id:'source-abcdef456',url,inspectedAt:now(),blocked:false,text:'Synthetic inspected listing, not qualification',links:[],images:[],captures:[]};};
  const r=await scoutStep(args(f,{inspect}));assert.equal(r.status,'observed');assert.deepEqual(seen,[listing]);assert.equal(tasks(f)[1].url,listing);
  const reopened=openStore(f.options);try{await scoutStep({...args(f,{inspect,search:async()=>({status:'blocked'})}),store:reopened});}finally{reopened.close();}
  assert.deepEqual(seen,[listing]);assert.equal(getBatch(f.store,f.b.id).usage.inspections,1);assert.equal(r.fullQualification,false);
});
for(const business of [profile,'https://www.facebook.com/returned_workshop/','https://www.facebook.com/people/Returned-Workshop/123456789012345/','https://www.facebook.com/profile.php?id=123456789012345'])test(`exact returned business profile still precedes listing: ${business}`,async t=>{
  const f=await acquisitionFixture(t);await receipt(f,[listing,business]);const seen=[];
  const r=await scoutStep(args(f,{inspect:async url=>{seen.push(url);return {id:'source-abcdef789',url,inspectedAt:now(),blocked:false,text:'Synthetic inspected account',links:[],images:[],captures:[]};}}));
  assert.equal(r.status,'observed');assert.deepEqual(seen,[business]);assert.equal(getBatch(f.store,f.b.id).usage.inspections,1);assert.equal(r.fullQualification,false);
});
