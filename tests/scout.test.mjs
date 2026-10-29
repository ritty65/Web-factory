import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {scoutStep,scoutSummary,assertScoutWorkflow,scoutDraftIssues} from '../src/scout.mjs';
import {readIntakeEvidence} from '../src/intake.mjs';
import {candidateInput} from '../src/contracts.mjs';
import {getBatch,saveBatch} from '../src/batch-store.mjs';
import {sourceJobPolicy} from '../src/batch-budget.mjs';
import {openStore} from '../src/db.mjs';
import {now,hash} from '../src/contracts.mjs';
import {acquisitionFixture,draftFixture} from './helpers-acquisition.mjs';

function options(f,output,adapters={}){return {store:f.store,jobId:f.job.id,directory:f.directory,output,...adapters};}
function addTarget(d,url='https://linktr.ee/juniper'){
  d.evidence.observations[0].links.push({url,text:'Business bio link'});return url;
}
async function updateRoot(f,d){const o=d.evidence.observations[0];await writeFile(path.join(f.directory,o.id+'.json'),JSON.stringify(o));}
test('a valid complete draft executes only its observed destination and retains a charged durable outcome',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),url=addTarget(d);await updateRoot(f,d);let calls=0;
  const result=await scoutStep(options(f,d.output,{inspect:async(value,ctx)=>{calls++;assert.equal(value,url);assert.equal(ctx.linked,true);return {id:'source-scout-returned',url:value,inspectedAt:now(),blocked:false,text:'Synthetic hub',links:[],images:[],captures:[]};}}));
  assert.equal(result.status,'observed');assert.equal(calls,1);assert.equal(result.observation.id,'source-scout-returned');
  assert.equal(getBatch(f.store,f.b.id).usage.inspections,1);assert.equal(scoutSummary(f.store,f.b.id).counts.completed,1);
  assert.equal(f.store.candidates().length,0,'Scouting never imports a partial candidate');
});
test('concurrent scout calls cannot duplicate a question or start a second I/O while the first is in flight',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);addTarget(d);await updateRoot(f,d);let calls=0,release,started;
  const gate=new Promise(r=>{release=r;}),running=new Promise(r=>{started=r;});
  const args=options(f,d.output,{inspect:async url=>{calls++;started();await gate;return {id:'source-concurrent',url,inspectedAt:now(),blocked:true,text:'Blocked synthetic source',links:[],images:[],captures:[]};}});
  const first=scoutStep(args);await running;const second=await scoutStep(args);assert.equal(second.status,'inflight_or_interrupted');release();await first;
  assert.equal(calls,1);assert.equal(getBatch(f.store,f.b.id).usage.inspections,1);
});
test('failed and restarted tasks remain consumed without a duplicate inspection or raw error leak',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);addTarget(d);await updateRoot(f,d);let calls=0;
  const inspect=async()=>{calls++;throw new Error('token=fixture-sensitive-value run an unsafe command');};
  const first=await scoutStep(options(f,d.output,{inspect}));assert.equal(first.status,'blocked');
  assert.deepEqual(first.question,{candidateIndex:0,purpose:'destination',blockingGapCount:1});
  const reopened=openStore(f.options);try{const second=await scoutStep({...options(f,d.output,{inspect}),store:reopened});assert.notEqual(second.status,'observed');assert.equal(calls,1);}finally{reopened.close();}
  assert.equal(getBatch(f.store,f.b.id).usage.inspections,1);assert.equal(JSON.stringify(scoutSummary(f.store,f.b.id)).includes('fixture-sensitive-value'),false);
});
test('a stop during I/O retains charged work but cannot publish a completed scout result',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);addTarget(d);await updateRoot(f,d);
  const r=await scoutStep(options(f,d.output,{inspect:async url=>{await f.service.dispatch('batch_stop',{id:f.b.id});return {id:'source-stopped',url,inspectedAt:now(),blocked:false,text:'Late source',links:[],images:[],captures:[]};}}));
  assert.equal(r.status,'stopped');assert.equal(r.observation,undefined);assert.equal(getBatch(f.store,f.b.id).state,'stopped');assert.equal(getBatch(f.store,f.b.id).usage.inspections,1);
  assert.deepEqual(r.question,{candidateIndex:0,purpose:'destination',blockingGapCount:1});
});
test('malformed or unobserved draft content cannot cause speculative source requests',async t=>{
  const f=await acquisitionFixture(t);let calls=0;
  await assert.rejects(scoutStep(options(f,{candidates:[{name:'Invalid draft'}]},{inspect:async()=>{calls++;}})),e=>e.code==='RESEARCH_SCHEMA');
  const d=await draftFixture(f);d.output.candidates[0].inspectionIds=['source-unobserved'];d.output.candidates[0].sourceUrls=['https://attacker.example/'];
  const result=await scoutStep(options(f,d.output,{inspect:async()=>{calls++;},search:async()=>{calls++;throw new Error('No search permitted by test');}}));
  assert.equal(calls,0);assert.equal(result.status,'cohort_needs_evidence');assert.equal(getBatch(f.store,f.b.id).usage.inspections,0);
});
test('the planner diversifies persisted searches, does not retry a failed query, and binds actual retained evidence',async t=>{
  const f=await acquisitionFixture(t),seen=[];
  const search=async(query,ctx)=>{seen.push(query);const record={query,provider:ctx.provider,intent:'discover',status:'completed',at:now(),results:[{url:'https://www.yelp.com/search',title:'Synthetic workshops in Houston Texas'}]};await writeFile(path.join(f.directory,`search-${hash(query).slice(0,16)}.json`),JSON.stringify(record));return record;};
  const first=await scoutStep(options(f,{candidates:[]},{search})),second=await scoutStep(options(f,{candidates:[]},{search}));
  assert.equal(first.status,'searched');assert.equal(second.status,'searched');assert.notEqual(seen[0],seen[1]);
  assert.equal(first.question,undefined);assert.equal(second.question,undefined);
  assert.equal(getBatch(f.store,f.b.id).usage.searches,2);assert.doesNotThrow(()=>assertScoutWorkflow(f.store,f.job.id,[],{searches:[first.search,second.search]}));
  assert.throws(()=>assertScoutWorkflow(f.store,f.job.id,[],{searches:[]}),e=>e.code==='SOURCE_SCOUT_REQUIRED');
});
test('direct new-mode discovery search cannot bypass planning and direct inspections cannot repeat a reserved route',async t=>{
  const f=await acquisitionFixture(t),policy=sourceJobPolicy(f.store,f.job.id,f.directory);
  assert.throws(()=>policy.reserve('searches',{provider:'firecrawl'}),e=>e.code==='SOURCE_SCOUT_REQUIRED');
  policy.reserve('inspections',{url:'https://www.instagram.com/synthetic/'});
  assert.throws(()=>policy.reserve('inspections',{url:'https://www.instagram.com/synthetic/'}),e=>e.code==='SOURCE_ALREADY_ATTEMPTED');
  assert.equal(getBatch(f.store,f.b.id).usage.inspections,1);
});
test('exhausted completion capacity rejects before I/O without a claimed task or another charge',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);addTarget(d);await updateRoot(f,d);
  const b=getBatch(f.store,f.b.id);saveBatch(f.store,{...b,usage:{...b.usage,inspections:6}});let calls=0;
  const r=await scoutStep(options(f,d.output,{inspect:async()=>{calls++;}}));
  assert.equal(r.status,'capacity_held');assert.equal(calls,0);assert.equal(scoutSummary(f.store,f.b.id).counts.total,0);assert.equal(getBatch(f.store,f.b.id).usage.inspections,6);
});
test('an existing blocked observation is a gap, never permission for an automatic retry',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),url=addTarget(d);await updateRoot(f,d);
  await writeFile(path.join(f.directory,'source-abc123def.json'),JSON.stringify({id:'source-abc123def',url,inspectedAt:now(),blocked:true,text:'Blocked',links:[],images:[]}));
  let calls=0;const result=await scoutStep(options(f,d.output,{inspect:async()=>{calls++;},search:async()=>{calls++;}}));
  assert.equal(calls,0);assert.equal(result.status,'cohort_needs_evidence');
});
test('one materially plausible screened draft stops more host-planned discovery searches',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);await scoutStep(options(f,d.output));let calls=0;
  const next=await scoutStep(options(f,{candidates:[]},{search:async()=>{calls++;}}));
  assert.equal(calls,0);assert.equal(next.status,'ready_to_finalize');assert.equal(getBatch(f.store,f.b.id).usage.searches,0);
});
for(const readyFirst of [true,false])test(`a complete draft stops discretionary scouting with the ready prospect ${readyFirst?'first':'second'}`,async t=>{
  const f=await acquisitionFixture(t,{candidateLimit:2}),ready=await draftFixture(f,1),incomplete=await draftFixture(f,2);
  addTarget(incomplete,'https://linktr.ee/incomplete-workshop');await updateRoot(f,incomplete);delete incomplete.output.candidates[0].activityEvidence;
  const candidates=readyFirst?[ready.output.candidates[0],incomplete.output.candidates[0]]:[incomplete.output.candidates[0],ready.output.candidates[0]],output={candidates,shortfall:'Synthetic mixed-completion fixture only'},before=getBatch(f.store,f.b.id);
  const calls=[],result=await scoutStep(options(f,output,{inspect:async url=>{calls.push(['inspect',url]);return observedStub(url);},search:async query=>{calls.push(['search',query]);throw new Error('No discovery search needed');}}));
  assert.equal(result.status,'ready_to_finalize');assert.deepEqual(calls,[]);
  assert.deepEqual(getBatch(f.store,f.b.id).usage,before.usage);assert.deepEqual(getBatch(f.store,f.b.id).discoveryUsage,before.discoveryUsage);assert.equal(scoutSummary(f.store,f.b.id).counts.total,0);
  const readyFeedback=result.feedback[readyFirst?0:1],heldFeedback=result.feedback[readyFirst?1:0];
  assert.equal(readyFeedback.screening.status,'clear_for_enrichment');assert.equal(readyFeedback.material.feasible,true);
  assert.equal(heldFeedback.screening.status,'needs_verification');assert.equal(heldFeedback.material.feasible,false);assert.ok(heldFeedback.screening.reasons.length);assert.ok(heldFeedback.material.gaps.length);
  assert.deepEqual(result.retainedDraftIdentities.map(v=>v.name).sort(),candidates.map(c=>c.name).sort());
  assert.deepEqual(scoutDraftIssues(f.store,f.job.id,candidates.map(candidateInput),await readIntakeEvidence(f.directory)),[]);
  assert.equal(result.fullQualification,false);assert.equal(result.humanAcceptance,false);assert.equal(f.store.candidates().length,0);assert.equal(f.store.jobs().filter(j=>j.kind==='site').length,0);
});
for(const guard of ['inflight','capacity'])test(`a completion-ready complete draft still respects the ${guard} guard`,async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),b=getBatch(f.store,f.b.id);
  if(guard==='inflight'){
    const id='scout-task-existing-claim',record={id,batchId:b.id,jobId:f.job.id,type:'destination',status:'claimed'};
    f.store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?)').run(id,'scout_task',JSON.stringify(record));
  }else saveBatch(f.store,{...b,usage:{...b.usage,inspections:b.settings.maxInspections-b.acquisition.reserve.inspections+1}});
  const before=getBatch(f.store,b.id),tasksBefore=scoutSummary(f.store,b.id),calls=[];
  const result=await scoutStep(options(f,d.output,{inspect:async url=>{calls.push(url);},search:async query=>{calls.push(query);}}));
  assert.equal(result.feedback[0].screening.status,'clear_for_enrichment');assert.equal(result.feedback[0].material.feasible,true);
  assert.equal(result.status,guard==='inflight'?'inflight_or_interrupted':'capacity_held');assert.deepEqual(calls,[]);
  assert.deepEqual(getBatch(f.store,b.id).usage,before.usage);assert.deepEqual(scoutSummary(f.store,b.id),tasksBefore);assert.equal(result.retainedDraftIdentities.length,1);
});
test('fresh retained unclassified destinations can be returned again without another inspection',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),url=addTarget(d);await updateRoot(f,d);
  await writeFile(path.join(f.directory,'source-acde456.json'),JSON.stringify({id:'source-acde456',url,inspectedAt:now(),blocked:false,text:'Synthetic inspected destination requiring interpretation',links:[],images:[],captures:[]}));
  let calls=0;const result=await scoutStep(options(f,d.output,{inspect:async()=>{calls++;}}));
  assert.equal(calls,0);assert.equal(result.status,'classification_needed');assert.equal(result.observation.id,'source-acde456');assert.equal(getBatch(f.store,f.b.id).usage.inspections,0);
});
for(const first of ['instagram','facebook'])test(`a genuinely observed second account extends the original ${first} registration without a new identity at a full cap`,async t=>{
  const f=await acquisitionFixture(t,{candidateLimit:1}),d=await draftFixture(f),c=d.output.candidates[0],o=d.evidence.observations[0];
  if(first==='facebook'){
    const old=o.url;o.url='https://www.facebook.com/juniper1/';c.contacts={facebook:o.url};c.contactSources={facebook:o.url};c.sourceUrls=c.sourceUrls.map(u=>u===old?o.url:u);c.facts=c.facts.map(v=>({...v,sourceUrl:o.url}));c.media=[];
    await updateRoot(f,d);
  }
  await scoutStep(options(f,d.output,{inspect:async()=>{throw new Error('No I/O needed');}}));
  const channel=first==='instagram'?'facebook':'instagram',url=channel==='facebook'?'https://www.facebook.com/juniper1/':'https://www.instagram.com/juniper1/';
  o.links.push({url,text:'Our verified other account'});await updateRoot(f,d);
  const other={...structuredClone(o),id:'source-acdeff123',url,links:[]};await writeFile(path.join(f.directory,other.id+'.json'),JSON.stringify(other));
  c.contacts[channel]=url;c.contactSources[channel]=url;c.sourceUrls.push(url);c.inspectionIds.push(other.id);
  const result=await scoutStep(options(f,d.output,{inspect:async()=>{throw new Error('No I/O needed');}}));
  assert.equal(result.retainedDraftIdentities.length,1);assert.deepEqual(scoutDraftIssues(f.store,f.job.id,[candidateInput(c)],await readIntakeEvidence(f.directory)),[]);
});
test('an unlinked extra account is not a proven identity extension',async t=>{
  const f=await acquisitionFixture(t,{candidateLimit:1}),d=await draftFixture(f);await scoutStep(options(f,d.output));
  const other={...structuredClone(d.evidence.observations[0]),id:'source-acdeffa12',url:'https://www.facebook.com/unlinked/',links:[]};await writeFile(path.join(f.directory,other.id+'.json'),JSON.stringify(other));
  const c=d.output.candidates[0];c.contacts.facebook=other.url;c.contactSources.facebook=other.url;c.sourceUrls.push(other.url);c.inspectionIds.push(other.id);
  await assert.rejects(scoutStep(options(f,d.output)),e=>e.code==='SOURCE_IDENTITY_EXTENSION');
});
test('an actual killed scout process leaves its committed claim charged and cannot repeat its question after restart', {timeout:15000}, async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);addTarget(d);await updateRoot(f,d);
  const script=`import {openStore} from ${JSON.stringify(new URL('../src/db.mjs',import.meta.url).href)};import {scoutStep} from ${JSON.stringify(new URL('../src/scout.mjs',import.meta.url).href)};
    const store=openStore(${JSON.stringify(f.options)});process.on('message',()=>{});
    await scoutStep({store,jobId:${JSON.stringify(f.job.id)},directory:${JSON.stringify(f.directory)},output:${JSON.stringify(d.output)},inspect:async()=>{process.send({phase:'claimed'});await new Promise(()=>{});}});`;
  const child=spawn(process.execPath,['--input-type=module','--eval',script],{stdio:['ignore','ignore','pipe','ipc']});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  let diagnostic='';child.stderr.on('data',v=>{diagnostic+=String(v).slice(0,1000);});
  const claimed=await Promise.race([once(child,'message').then(([m])=>m),once(child,'exit').then(()=>{throw new Error('Child exited before claim: '+diagnostic);})]);
  assert.equal(claimed.phase,'claimed');const closed=once(child,'exit');child.kill('SIGKILL');await closed;
  const reopened=openStore(f.options);try{
    let calls=0;const result=await scoutStep({...options(f,d.output,{inspect:async()=>{calls++;}}),store:reopened});
    assert.equal(result.status,'inflight_or_interrupted');assert.equal(calls,0);assert.equal(getBatch(reopened,f.b.id).usage.inspections,1);assert.equal(scoutSummary(reopened,f.b.id).counts.claimed,1);
  }finally{reopened.close();}
});
test('a stale source-server attempt cannot reserve against a replacement job attempt',async t=>{
  const f=await acquisitionFixture(t),policy=sourceJobPolicy(f.store,f.job.id,f.directory);
  f.store.updateJob(f.job.id,{attempt:f.job.attempt+1});
  assert.throws(()=>policy.researchContext(),e=>e.code==='BATCH_SOURCE_BINDING');
  assert.throws(()=>policy.reserve('inspections',{url:'https://www.instagram.com/juniper1/'}),e=>e.code==='BATCH_SOURCE_BINDING');
  assert.equal(getBatch(f.store,f.b.id).usage.inspections,0);
});
test('a result from an old attempt is not published as complete when the job attempt changes during I/O',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);addTarget(d);await updateRoot(f,d);
  const result=await scoutStep(options(f,d.output,{inspect:async url=>{f.store.updateJob(f.job.id,{attempt:f.job.attempt+1});return {id:'source-attempt-test',url,inspectedAt:now(),blocked:false,text:'Late old-attempt data',links:[],images:[],captures:[]};}}));
  assert.equal(result.status,'stopped');assert.equal(result.observation,undefined);assert.equal(scoutSummary(f.store,f.b.id).counts.completed,0);assert.equal(getBatch(f.store,f.b.id).usage.inspections,1);
});
test('unknown geography does not prevent one observed business-destination question, and reading it never certifies geography or qualification',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),old=d.output.candidates[0].facts[0].excerpt,line='Offers mobile detailing by appointment.';
  d.output.candidates[0].facts[0]={text:line,excerpt:line,sourceUrl:d.evidence.observations[0].url};d.evidence.observations[0].text=d.evidence.observations[0].text.replace(old,line);
  const url=addTarget(d,'https://business.example/');await updateRoot(f,d);let calls=0;
  const result=await scoutStep(options(f,d.output,{inspect:async value=>{calls++;assert.equal(value,url);return {id:'source-unknown-location',url:value,inspectedAt:now(),blocked:false,text:'Observed route requiring factual interpretation',links:[],images:[],captures:[]};}}));
  assert.equal(result.feedback[0].screening.geography,'unknown');assert.equal(calls,1);assert.equal(result.status,'observed');assert.equal(result.fullQualification,false);assert.equal(result.feedback[0].screening.status,'needs_verification');assert.equal(getBatch(f.store,f.b.id).usage.inspections,1);
  assert.equal(f.store.candidates().length,0);
});
test('an explicit outside-city base remains a stop for scout questions, not an unknown-geography loophole',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);d.evidence.observations[0].text+='\nBased in Katy, Texas.';addTarget(d);await updateRoot(f,d);let calls=0;
  const result=await scoutStep(options(f,d.output,{inspect:async()=>{calls++;}}));assert.equal(result.feedback[0].screening.geography,'conflict');assert.equal(calls,0);assert.equal(result.status,'cohort_needs_evidence');assert.equal(getBatch(f.store,f.b.id).usage.inspections,0);
});

async function removeLocation(f,d){
  const c=d.output.candidates[0],old=c.facts[0].excerpt,line='Repairs upholstered chairs by appointment.';
  c.facts[0]={text:line,excerpt:line,sourceUrl:d.evidence.observations[0].url};
  d.evidence.observations[0].text=d.evidence.observations[0].text.replace(old,line);await updateRoot(f,d);
}
const observedStub=url=>({id:'source-completion-fixture',url,inspectedAt:now(),blocked:false,text:'Synthetic inspected route; factual interpretation still required.',links:[],images:[],captures:[]});
function taskMetadata(f){
  const rows=f.store.db.prepare("SELECT record FROM factory_operation WHERE kind='scout_task' AND json_extract(record,'$.batchId')=?").all(f.b.id);
  assert.equal(rows.length,1);const {candidateIndex,purpose,blockingGapCount}=JSON.parse(rows[0].record);return {candidateIndex,purpose,blockingGapCount};
}
test('feasible material still allows an observed post after one candidate listing search without certifying a fact',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);await removeLocation(f,d);const seen=[],searches=[];
  Object.assign(d.evidence.observations[0],{method:'fresh_guest_rendered_dom',evidenceContextVersion:1,finalUrl:d.evidence.observations[0].url});await updateRoot(f,d);
  const adapters={inspect:async url=>{seen.push(url);return observedStub(url);},search:async(query,ctx)=>{
    searches.push(query);const record={query,provider:ctx.provider,intent:ctx.intent,status:'completed',at:now(),results:[{url:'https://directory.example/synthetic',title:'Synthetic Juniper workshop Houston'}]};
    await writeFile(path.join(f.directory,`search-${hash(query).slice(0,16)}.json`),JSON.stringify(record));return record;
  }};
  const listing=await scoutStep(options(f,d.output,adapters));assert.equal(listing.question.purpose,'candidate_listing');assert.equal(searches.length,1);
  const result=await scoutStep(options(f,d.output,adapters));
  assert.equal(result.feedback[0].material.feasible,true);assert.equal(result.feedback[0].screening.geography,'unknown');
  assert.deepEqual(seen,[d.evidence.observations[0].links[0].url]);assert.equal(result.status,'observed');
  const expected={candidateIndex:0,purpose:'geography',blockingGapCount:1};assert.deepEqual(result.question,expected);
  const tasks=f.store.db.prepare("SELECT record FROM factory_operation WHERE kind='scout_task' AND json_extract(record,'$.batchId')=?").all(f.b.id).map(v=>JSON.parse(v.record));
  const {candidateIndex,purpose,blockingGapCount}=tasks.find(v=>v.type==='post');assert.deepEqual({candidateIndex,purpose,blockingGapCount},expected);
  assert.equal(result.fullQualification,false);assert.equal(result.humanAcceptance,false);assert.equal(f.store.candidates().length,0);assert.equal(getBatch(f.store,f.b.id).usage.inspections,1);
});
for(const geographyUnknown of [false,true])test(`observed material posts retain host purpose when geography is ${geographyUnknown?'unknown':'supported'}`,async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);if(geographyUnknown)await removeLocation(f,d);delete d.output.candidates[0].activityEvidence;
  const result=await scoutStep(options(f,d.output,{inspect:async url=>observedStub(url)}));
  assert.equal(result.feedback[0].material.feasible,false);assert.equal(result.status,'observed');
  const expected={candidateIndex:0,purpose:geographyUnknown?'geography_and_material':'material',blockingGapCount:geographyUnknown?2:1};assert.deepEqual(result.question,expected);assert.deepEqual(taskMetadata(f),expected);
});
for(const weakFirst of [true,false])test(`one discretionary inspection chooses the closer dossier with the weak draft ${weakFirst?'first':'second'}`,async t=>{
  const f=await acquisitionFixture(t,{candidateLimit:2}),weak=await draftFixture(f,1),near=await draftFixture(f,2);delete weak.output.candidates[0].activityEvidence;
  const weakUrl=addTarget(weak,'https://linktr.ee/completion-weak'),nearUrl=addTarget(near,'https://linktr.ee/completion-near');await updateRoot(f,weak);await updateRoot(f,near);
  const b=getBatch(f.store,f.b.id);saveBatch(f.store,{...b,usage:{...b.usage,inspections:5}});const seen=[];
  const output={candidates:weakFirst?[weak.output.candidates[0],near.output.candidates[0]]:[near.output.candidates[0],weak.output.candidates[0]],shortfall:'Synthetic completion ordering only'};
  const adapters={inspect:async url=>{seen.push(url);return observedStub(url);}};
  const result=await scoutStep(options(f,output,adapters));assert.deepEqual(seen,[nearUrl]);assert.notEqual(seen[0],weakUrl);
  const expected={candidateIndex:weakFirst?1:0,purpose:'destination',blockingGapCount:1};assert.deepEqual(result.question,expected);assert.deepEqual(taskMetadata(f),expected);
  assert.equal(result.retainedDraftIdentities.length,2);assert.equal(f.store.candidates().length,0);assert.equal(getBatch(f.store,f.b.id).usage.inspections,6);
  const next=await scoutStep(options(f,output,adapters));assert.equal(next.status,'capacity_held');assert.deepEqual(seen,[nearUrl]);assert.equal(getBatch(f.store,f.b.id).usage.inspections,6);assert.deepEqual(taskMetadata(f),expected);
});
test('equal host gap counts preserve original draft order without inventing a confidence score',async t=>{
  const f=await acquisitionFixture(t,{candidateLimit:2}),a=await draftFixture(f,1),b=await draftFixture(f,2);addTarget(a,'https://linktr.ee/completion-a');const first=addTarget(b,'https://linktr.ee/completion-b');await updateRoot(f,a);await updateRoot(f,b);
  const seen=[],result=await scoutStep(options(f,{candidates:[b.output.candidates[0],a.output.candidates[0]],shortfall:'Synthetic tie fixture'},{inspect:async url=>{seen.push(url);return observedStub(url);}}));
  assert.deepEqual(seen,[first]);assert.deepEqual(result.question,{candidateIndex:0,purpose:'destination',blockingGapCount:1});assert.equal(result.retainedDraftIdentities.length,2);
});
test('reranking reordered drafts skips the attempted top group and preserves its task while selecting a new route',async t=>{
  const f=await acquisitionFixture(t,{candidateLimit:2}),a=await draftFixture(f,1),b=await draftFixture(f,2),aUrl=addTarget(a,'https://linktr.ee/completion-reorder-a'),bUrl=addTarget(b,'https://linktr.ee/completion-reorder-b');await updateRoot(f,a);await updateRoot(f,b);
  const seen=[],adapters={inspect:async url=>{seen.push(url);return observedStub(url);}},readTasks=()=>f.store.db.prepare("SELECT record FROM factory_operation WHERE kind='scout_task' AND json_extract(record,'$.batchId')=? ORDER BY rowid").all(f.b.id).map(v=>JSON.parse(v.record));
  const first=await scoutStep(options(f,{candidates:[a.output.candidates[0],b.output.candidates[0]],shortfall:'Synthetic initial order'},adapters)),original=readTasks()[0];
  assert.deepEqual(seen,[aUrl]);assert.equal(first.question.candidateIndex,0);
  delete b.output.candidates[0].activityEvidence;
  const second=await scoutStep(options(f,{candidates:[b.output.candidates[0],a.output.candidates[0]],shortfall:'Synthetic reordered drafts with changed gaps'},adapters)),tasks=readTasks();
  assert.deepEqual(seen,[aUrl,bUrl]);assert.equal(tasks.length,2);assert.deepEqual(tasks[0],original);assert.notEqual(tasks[0].id,tasks[1].id);
  assert.deepEqual(second.question,{candidateIndex:0,purpose:'destination',blockingGapCount:2});assert.equal(tasks[1].candidateIndex,0);
  assert.deepEqual(first.retainedDraftIdentities.map(v=>v.identityKey).sort(),second.retainedDraftIdentities.map(v=>v.identityKey).sort());
  assert.equal(f.store.candidates().length,0);assert.equal(getBatch(f.store,f.b.id).usage.inspections,2);
});
test('unknown geography does not authorize an unobserved post URL',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);await removeLocation(f,d);d.evidence.observations[0].links=[];await updateRoot(f,d);let calls=0;
  const result=await scoutStep(options(f,d.output,{inspect:async()=>{calls++;throw new Error('No observed route exists');}}));
  assert.equal(calls,0);assert.equal(result.status,'cohort_needs_evidence');assert.equal(getBatch(f.store,f.b.id).usage.inspections,0);
});
for(const invalid of ['stale','blocked'])test(`unknown geography cannot inspect a post from a ${invalid} identity source`,async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);await removeLocation(f,d);if(invalid==='stale')d.evidence.observations[0].inspectedAt='2020-01-01';else d.evidence.observations[0].blocked=true;await updateRoot(f,d);let calls=0;
  const result=await scoutStep(options(f,d.output,{inspect:async()=>{calls++;throw new Error('Identity is unusable');}}));assert.equal(calls,0);assert.equal(result.status,'cohort_needs_evidence');assert.equal(getBatch(f.store,f.b.id).usage.inspections,0);
});
test('a geography-only question cannot spend the frozen inspection reserve',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);await removeLocation(f,d);const b=getBatch(f.store,f.b.id);saveBatch(f.store,{...b,usage:{...b.usage,inspections:6}});let calls=0;
  const result=await scoutStep(options(f,d.output,{inspect:async()=>{calls++;throw new Error('Reserved capacity cannot be spent');}}));
  assert.equal(result.status,'capacity_held');assert.equal(calls,0);assert.equal(scoutSummary(f.store,f.b.id).counts.total,0);assert.equal(getBatch(f.store,f.b.id).usage.inspections,6);
});
for(const target of ['https://juniper.example/','https://juniper.wixsite.com/workshop','https://juniper.square.site/'])test(`observed likely site/builder/booking route precedes secondary hubs: ${target}`,async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),hub=addTarget(d,'https://linktr.ee/juniper-priority');addTarget(d,target);addTarget(d,'https://www.threads.com/@juniper');await updateRoot(f,d);
  const seen=[],result=await scoutStep(options(f,d.output,{inspect:async url=>{seen.push(url);return observedStub(url);}}));
  assert.deepEqual(seen,[target]);assert.equal(result.feedback[0].screening.status,'needs_verification');assert.equal(result.fullQualification,false);
  const next=await scoutStep(options(f,d.output,{inspect:async url=>{seen.push(url);return observedStub(url);}}));assert.equal(next.status,'observed');assert.deepEqual(seen,[target,hub]);
});
for(const terminal of ['excluded','booking_only','conflict'])test(`classification fallback skips ${terminal} but retains complete registration and feedback`,async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),c=d.output.candidates[0],url=addTarget(d,'https://juniper-unclassified.example/');
  if(terminal==='conflict')d.evidence.observations[0].text+='\nBased in Katy, Texas.';
  else{
    const checked=addTarget(d,terminal==='booking_only'?'https://juniper.square.site/':'https://juniper-official.example/'),id='source-abc123fed';
    await writeFile(path.join(f.directory,id+'.json'),JSON.stringify({...observedStub(checked),id}));
    c.websiteCheck.linkChecks.push({url:checked,status:'official',sourceId:id,reason:'Synthetic identity-matched inspected destination'});
  }
  await updateRoot(f,d);await writeFile(path.join(f.directory,'source-acde456.json'),JSON.stringify({...observedStub(url),id:'source-acde456'}));
  const seen=[],result=await scoutStep(options(f,d.output,{inspect:async url=>{seen.push(url);},search:async query=>{seen.push(query);}}));
  assert.equal(terminal==='conflict'?result.feedback[0].screening.geography:result.feedback[0].screening.status,terminal);
  assert.equal(result.status,'cohort_needs_evidence');assert.deepEqual(seen,[]);assert.equal(result.retainedDraftIdentities.length,1);assert.equal(getBatch(f.store,f.b.id).usage.inspections,0);
});
test('likely-destination priority keeps stable site ties and blocked or unrelated results do not clear required hub checks',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),hub=addTarget(d,'https://linktr.ee/required-hub'),first=addTarget(d,'https://first-business.example/'),second=addTarget(d,'https://second-business.example/');await updateRoot(f,d);
  const seen=[],inspect=async url=>{seen.push(url);const o={...observedStub(url),id:`source-abcdef${seen.length}`,blocked:url===first,text:'Unrelated source, identity not established'};await writeFile(path.join(f.directory,o.id+'.json'),JSON.stringify(o));return o;};
  const a=await scoutStep(options(f,d.output,{inspect})),b=await scoutStep(options(f,d.output,{inspect})),c=await scoutStep(options(f,d.output,{inspect}));
  assert.deepEqual(seen,[first,second,hub]);assert.equal(a.status,'blocked');assert.equal(b.feedback[0].screening.status,'needs_verification');assert.equal(c.feedback[0].screening.status,'needs_verification');assert.equal(c.feedback[0].screening.unresolvedDestinations,3);assert.equal(f.store.candidates().length,0);
});
