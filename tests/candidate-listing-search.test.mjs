import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {hash,now} from '../src/contracts.mjs';
import {scoutStep} from '../src/scout.mjs';
import {getBatch,saveBatch} from '../src/batch-store.mjs';
import {openStore} from '../src/db.mjs';
import {sourceJobPolicy} from '../src/batch-budget.mjs';
import {acquisitionFixture,draftFixture} from './helpers-acquisition.mjs';

async function fixture(t){
  const f=await acquisitionFixture(t),d=await draftFixture(f),c=d.output.candidates[0],o=d.evidence.observations[0];
  const old=c.facts[0].excerpt,line='Repairs upholstered chairs by appointment.';
  c.facts[0]={text:line,excerpt:line,sourceUrl:o.url};o.text=o.text.replace(old,line);o.finalUrl=o.url;o.method='fresh_guest_rendered_dom';o.evidenceContextVersion=1;
  c.websiteCheck.status='unknown';c.websiteCheck.queries=[];
  await writeFile(path.join(f.directory,o.id+'.json'),JSON.stringify(o));
  return {f,d,c,o};
}
function args(f,d,adapters={}){return {store:f.store,jobId:f.job.id,directory:f.directory,output:d.output,...adapters};}
function fakeSearch(f,seen){return async(query,ctx)=>{
  seen.push(query);assert.equal(ctx.provider,'firecrawl');assert.equal(ctx.intent,'discover');
  const result={query,provider:ctx.provider,intent:ctx.intent,status:'completed',at:now(),results:[{url:'https://directory.example/synthetic',title:'Synthetic Juniper workshop Houston',description:'A search result, not a verified business listing.'}]};
  await writeFile(path.join(f.directory,`search-${hash(query).slice(0,16)}.json`),JSON.stringify(result));return result;
};}
const inspect=async url=>({id:'source-post-attempt',url,inspectedAt:now(),blocked:true,text:'Unavailable synthetic page',links:[],images:[]});

test('a fresh promising identity with unknown geography gets one host-planned candidate listing search inside the discovery cap',async t=>{
  const {f,d,c}=await fixture(t),seen=[];
  const result=await scoutStep(args(f,d,{search:fakeSearch(f,seen),inspect}));
  assert.equal(result.status,'searched');assert.equal(seen.length,1);
  assert.match(seen[0],/"Juniper 1 Upholstery"/);assert.match(seen[0],/Houston/i);assert.match(seen[0],/directory/i);
  assert.equal(result.question.purpose,'candidate_listing');assert.equal(result.question.candidateIndex,0);
  assert.equal(result.feedback[0].screening.geography,'unknown');assert.equal(result.feedback[0].material.feasible,true);
  assert.equal(result.fullQualification,false);assert.equal(result.humanAcceptance,false);assert.equal(f.store.candidates().length,0);
  const b=getBatch(f.store,f.b.id);assert.equal(b.usage.searches,1);assert.equal(b.discoveryUsage.searches,1);assert.equal(b.usage.inspections,0);assert.equal(b.usage.imageViews,0);
  assert.equal(c.websiteCheck.status,'unknown');
  const next=await scoutStep(args(f,d,{search:fakeSearch(f,seen),inspect}));
  assert.equal(next.status,'blocked');assert.equal(seen.length,1,'The same registered candidate lookup cannot repeat.');
});

for(const state of ['blocked','stale','redirected','no_final_url','static','outside'])test(`a ${state} original profile cannot trigger a candidate listing search`,async t=>{
  const {f,d,o}=await fixture(t),seen=[];
  if(state==='blocked')o.blocked=true;
  if(state==='stale')o.inspectedAt='2020-01-01';
  if(state==='redirected')o.finalUrl='https://www.instagram.com/different/';
  if(state==='no_final_url')delete o.finalUrl;
  if(state==='static')o.method='static_https_no_script';
  if(state==='outside')o.text+='\nBased in Katy, Texas.';
  await writeFile(path.join(f.directory,o.id+'.json'),JSON.stringify(o));
  const result=await scoutStep(args(f,d,{search:fakeSearch(f,seen),inspect}));
  assert.deepEqual(seen,[]);assert.notEqual(result.status,'searched');assert.equal(getBatch(f.store,f.b.id).usage.searches,0);
});

test('a failed candidate lookup is charged once and cannot be retried for that identity',async t=>{
  const {f,d}=await fixture(t);let calls=0;
  const search=async()=>{calls++;throw new Error('Synthetic blocked search');};
  const first=await scoutStep(args(f,d,{search,inspect}));assert.equal(first.status,'blocked');
  const reopened=openStore(f.options);try{await scoutStep({...args(f,d,{search,inspect}),store:reopened});}finally{reopened.close();}
  assert.equal(calls,1);assert.equal(getBatch(f.store,f.b.id).usage.searches,1);
});

test('candidate search cannot spend the reserved ability to inspect a found listing',async t=>{
  const {f,d}=await fixture(t),b=getBatch(f.store,f.b.id),seen=[];
  saveBatch(f.store,{...b,usage:{...b.usage,inspections:b.settings.maxInspections-b.acquisition.reserve.inspections}});
  const result=await scoutStep(args(f,d,{search:fakeSearch(f,seen),inspect}));
  assert.deepEqual(seen,[]);assert.equal(result.status,'capacity_held');assert.equal(getBatch(f.store,f.b.id).usage.searches,0);
});

test('candidate-specific query construction treats the model-provided business name only as bounded text',async t=>{
  const {f,d,c,o}=await fixture(t),seen=[];
  c.name='Juniper Workshop" OR site:attacker';o.title=c.name;o.text=c.name+'. '+o.text;
  await writeFile(path.join(f.directory,o.id+'.json'),JSON.stringify(o));
  await scoutStep(args(f,d,{search:fakeSearch(f,seen),inspect}));
  assert.equal(seen.length,1);assert.ok(seen[0].length<=300);assert.doesNotMatch(seen[0],/site:|attacker\.example|" OR /i);
});

test('a merely similar model-provided name is not enough to spend on a candidate listing search',async t=>{
  const {f,d,c}=await fixture(t),seen=[];
  c.name='Juniper Upholstery Unobserved Alias';
  const result=await scoutStep(args(f,d,{search:fakeSearch(f,seen),inspect}));
  assert.notEqual(result.status,'searched');assert.deepEqual(seen,[]);assert.equal(getBatch(f.store,f.b.id).usage.searches,0);
});

test('four retained candidate lookups across the batch block a fifth candidate lookup',async t=>{
  const {f,d}=await fixture(t),seen=[];
  for(let i=0;i<4;i++){
    const id=`scout-task-fixture${i}`,record={id,batchId:f.b.id,jobId:'job-earlier-fixture',type:'search',family:'candidate_listing',identityKey:`old-${i}`,status:'completed'};
    f.store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?)').run(id,'scout_task',JSON.stringify(record));
  }
  const result=await scoutStep(args(f,d,{search:fakeSearch(f,seen),inspect}));
  assert.notEqual(result.status,'searched');assert.deepEqual(seen,[]);assert.equal(getBatch(f.store,f.b.id).usage.searches,0);
});

test('the candidate lookup respects the original discovery share before any I/O or claim',async t=>{
  const {f,d}=await fixture(t),b=getBatch(f.store,f.b.id),seen=[];
  saveBatch(f.store,{...b,usage:{...b.usage,searches:b.settings.discoverySearchLimit},discoveryUsage:{searches:b.settings.discoverySearchLimit}});
  const result=await scoutStep(args(f,d,{search:fakeSearch(f,seen),inspect}));
  assert.equal(result.status,'capacity_held');assert.deepEqual(seen,[]);
  assert.equal(getBatch(f.store,f.b.id).usage.searches,b.settings.discoverySearchLimit);
});

test('a source changed during a candidate search cannot publish the returned result',async t=>{
  const {f,d,o}=await fixture(t);let calls=0;
  const search=async(query,ctx)=>{
    calls++;o.text+=' Changed after the search claim.';await writeFile(path.join(f.directory,o.id+'.json'),JSON.stringify(o));
    return {query,provider:ctx.provider,intent:ctx.intent,status:'completed',at:now(),results:[]};
  };
  const result=await scoutStep(args(f,d,{search,inspect}));
  assert.equal(calls,1);assert.equal(result.status,'blocked');assert.equal(result.search,undefined);assert.equal(getBatch(f.store,f.b.id).usage.searches,1);
});

test('a searched and independently inspected identity-matched listing can complete screening but never full intake',async t=>{
  const {f,d,c,o}=await fixture(t),url='https://www.yelp.com/biz/juniper-1-upholstery-houston';
  const search=async(query,ctx)=>{
    const result={query,provider:ctx.provider,intent:ctx.intent,status:'completed',at:now(),results:[{url,title:`${c.name} - Houston, TX - Yelp`,description:'Synthetic search result only'}]};
    await writeFile(path.join(f.directory,`search-${hash(query).slice(0,16)}.json`),JSON.stringify(result));return result;
  };
  const first=await scoutStep(args(f,d,{search,inspect}));assert.equal(first.status,'searched');assert.equal(first.feedback[0].screening.geography,'unknown');
  const listing={id:'source-a1b2c3d4',url,finalUrl:url,title:`${c.name} - Houston, TX - Yelp`,text:`${c.name} 123 Main Street, Houston, TX 77002`,inspectedAt:now(),blocked:false,method:'static_https_no_script',links:[{url:o.url,text:'Instagram'}],images:[]};
  sourceJobPolicy(f.store,f.job.id,f.directory).reserve('inspections',{url});
  await writeFile(path.join(f.directory,listing.id+'.json'),JSON.stringify(listing));
  c.inspectionIds.push(listing.id);c.sourceUrls.push(url);c.facts.push({text:'Located at 123 Main Street, Houston, TX 77002.',excerpt:'123 Main Street, Houston, TX 77002',sourceUrl:url});
  const second=await scoutStep(args(f,d,{search,inspect}));
  assert.equal(second.feedback[0].screening.geography,'supported');assert.equal(second.feedback[0].screening.status,'clear_for_enrichment');
  assert.equal(second.status,'ready_to_finalize');assert.equal(second.fullQualification,false);assert.equal(c.websiteCheck.status,'unknown');
  assert.equal(f.store.candidates().length,0);assert.equal(f.store.jobs().filter(job=>job.kind==='site').length,0);
});
