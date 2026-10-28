import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat,readdir} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {defaultSettings,saveSettings,studioStatus} from '../src/studio-config.mjs';
import {modelJson,testProvider} from '../src/studio-providers.mjs';
import {studioSpend,paidCall,acknowledgeSpend} from '../src/studio-budget.mjs';
import {studioHttp} from '../src/studio-http.mjs';
import {record,saveRecord} from '../src/studio-state.mjs';

export const fixturePrice=()=>({inputUsdPerMillion:1,outputUsdPerMillion:2,maxRequestUsd:0.01,verifiedAt:new Date().toISOString(),referenceUrl:'https://example.com/fixture-pricing-not-real'});
export async function apiFixture(t,request=canaryRequest){
  const root=await mkdtemp(path.join(os.tmpdir(),'factory-api-')),options={stateRoot:path.join(root,'state'),dbPath:path.join(root,'db')};await initialize(options);const store=openStore(options);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const data=defaultSettings();for(const p of Object.values(data.providers))p.price=fixturePrice();data.permissions={googleUse:true,apolloUse:true,firecrawlUse:true,privatePublicPhotos:true};
  await saveSettings(store,{version:0,data,credentials:Object.fromEntries(Object.keys(data.providers).map(id=>[id,'fixture-private-key-'+id]))});
  return {store,root,data,request,service:createService(store,{autoRun:false,studioRequest:request})};
}
export async function canaryRequest(url,options){
  const body=JSON.parse(options.body||'{}');
  if(url.includes('places.googleapis.com'))return response({places:[]});
  if(url.includes('apollo.io'))return response(url.includes('mixed_companies')?{organizations:[]}:url.includes('organizations')?{organization:null}:url.includes('api_search')?{people:[]}:{person:null});
  if(url.includes('firecrawl.dev'))return response(url.endsWith('/search')?{success:true,data:{web:[]}}:{success:true,data:{markdown:'Example Domain',html:'<main>Example Domain</main>'}});
  const text=JSON.stringify(body.messages?.at(-1)?.content||body.input||'');
  const output=/dominant color/.test(text)?{color:'red'}:/tiny valid static/.test(text)?{files:[{path:'index.html',content:'<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Fixture</h1></main></body></html>'}]}:{ok:true};
  return response(url.includes('api.openai.com')?{id:'fixture',model:body.model,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}],usage:{input_tokens:100,output_tokens:30}}:{id:'fixture',model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:30}});
}
export const response=(data,status=200)=>({status,bytes:Buffer.from(typeof data==='string'?data:JSON.stringify(data))});

test('setup saves keys privately, never into DB/results, and exact-version conflicts preserve old keys',async t=>{
  const f=await apiFixture(t),status=await f.service.dispatch('studio_settings_get',{});
  assert.equal(status.keysReturned,false);assert.ok(status.connections.every(c=>c.configured));
  assert.doesNotMatch(JSON.stringify(status),/fixture-private-key/);
  const rows=f.store.db.prepare('SELECT record FROM factory_operation').all();assert.doesNotMatch(JSON.stringify(rows),/fixture-private-key/);
  const directory=path.join(f.store.stateRoot,'credentials','providers');for(const name of await readdir(directory))assert.equal((await stat(path.join(directory,name))).mode&0o077,0);
  await assert.rejects(saveSettings(f.store,{version:0,data:f.data,credentials:{deepseek:'replacement-key'}}),e=>e.code==='STALE_EVIDENCE');
  assert.equal((await readdir(directory)).length,6);assert.equal(studioSpend(f.store).committedMicros,0);
});
test('unpriced requests and missing tests cannot spend',async t=>{
  const f=await apiFixture(t);await assert.rejects(modelJson(f.store,{task:'code',prompt:'JSON',requestId:'unverified-model',request:f.request}),e=>e.code==='PROVIDER_NOT_TESTED');
  const changed=structuredClone(f.data);changed.providers.deepseek.price=null;await saveSettings(f.store,{version:1,data:changed,credentials:{}});
  assert.equal((await testProvider(f.store,{provider:'deepseek',requestId:'price-missing-test'},{request:f.request})).errorCode,'PRICE_UNVERIFIED');assert.equal(studioSpend(f.store).calls.length,0);
});
test('DeepSeek receives text/code only; vision passes a real image attachment to OpenRouter',async t=>{
  const calls=[];const request=async(url,options)=>{calls.push({url,body:JSON.parse(options.body||'{}')});return canaryRequest(url,options);};const f=await apiFixture(t,request);
  const deepseek=await f.service.dispatch('studio_provider_test',{provider:'deepseek',requestId:'deepseek-canary-test',authorized:true});assert.equal(deepseek.state,'passed');assert.equal(deepseek.capabilities.coding,true);assert.equal(deepseek.capabilities.vision,undefined);assert.equal(deepseek.verification,'injected_transport');
  const router=await f.service.dispatch('studio_provider_test',{provider:'openrouter',requestId:'openrouter-canary-test',authorized:true});assert.equal(router.capabilities.vision,true);
  await modelJson(f.store,{task:'code',prompt:'Return JSON {"ok":true}',requestId:'deepseek-production-json',request});
  assert.ok(calls.filter(c=>c.url.includes('deepseek')).every(c=>c.body.model==='deepseek-chat'&&typeof c.body.messages.at(-1).content==='string'));
  assert.ok(calls.some(c=>c.url.includes('openrouter')&&Array.isArray(c.body.messages?.at(-1).content)));
  await assert.rejects(modelJson(f.store,{task:'code',prompt:'JSON',images:[Buffer.from('wrong')],requestId:'invalid-image-task',request}),e=>e.code==='MODEL_IMAGE_ROLE');
});
test('native OpenAI Responses adapter normalizes final JSON and usage',async t=>{
  const f=await apiFixture(t);const result=await testProvider(f.store,{provider:'openai',requestId:'openai-response-canary'},{request:f.request});assert.equal(result.state,'passed');assert.equal(result.capabilities.vision,true);assert.ok(studioSpend(f.store).committedMicros>0);
});
test('required source canaries check actual feature schemas and do not manufacture a matching business',async t=>{
  const f=await apiFixture(t);for(const provider of ['google','apollo','firecrawl']){const result=await f.service.dispatch('studio_provider_test',{provider,requestId:'canary-source-'+provider,authorized:true});assert.equal(result.state,'passed');assert.equal(result.leadQualityProven,false);}
  assert.equal(f.store.jobs().length,0);assert.equal(f.store.candidates().length,0);
});
test('same paid identity replays durable output once, and conflicting input cannot reuse its receipt',async t=>{
  const f=await apiFixture(t);let calls=0;const options={requestId:'durable-ledger-call',provider:'fixture',input:{name:'A'},purpose:'fixture',upperMicros:1000};
  const fn=async()=>{calls++;return{output:{ok:true},actualMicros:500};};assert.equal((await paidCall(f.store,options,fn)).output.ok,true);assert.equal((await paidCall(f.store,options,fn)).replayed,true);assert.equal(calls,1);assert.equal(studioSpend(f.store).committedMicros,500);
  await assert.rejects(paidCall(f.store,{...options,input:{name:'B'}},fn),e=>e.code==='IDEMPOTENCY_CONFLICT');
});
test('uncertain charges hold further requests, keep full allowance and need exact old-enough acknowledgement',async t=>{
  const f=await apiFixture(t);const options={requestId:'uncertain-ledger-call',provider:'fixture',input:{},purpose:'fixture',upperMicros:1000};
  await assert.rejects(paidCall(f.store,options,async()=>{throw Object.assign(new Error('private error'),{code:'PROVIDER_TIMEOUT',uncertain:true});}));
  await assert.rejects(paidCall(f.store,{...options,requestId:'cannot-repeat-work'},async()=>({})),e=>e.code==='SPEND_UNCERTAIN');
  const receipt=studioSpend(f.store).uncertain[0];assert.throws(()=>acknowledgeSpend(f.store,receipt),e=>e.code==='CALL_ACTIVE');
  const original=record(f.store,receipt.id,'studio_spend'),startedAt=new Date(Date.now()-180000).toISOString();saveRecord(f.store,receipt.id,'studio_spend',{...original,startedAt});
  assert.throws(()=>acknowledgeSpend(f.store,receipt),e=>e.code==='STALE_EVIDENCE');acknowledgeSpend(f.store,{id:receipt.id,startedAt});assert.equal(studioSpend(f.store).committedMicros,1000);
});
test('global allowance rejects overspend before the provider and cannot reset on settings/key changes',async t=>{
  const f=await apiFixture(t);let calls=0;await paidCall(f.store,{requestId:'full-pilot-reservation',provider:'fixture',input:{},purpose:'fixture',upperMicros:100_000_000},async()=>({actualMicros:null}));
  await assert.rejects(paidCall(f.store,{requestId:'over-pilot-budget',provider:'fixture',input:{},purpose:'fixture',upperMicros:1},async()=>{calls++;return{};}),e=>e.code==='PILOT_BUDGET');
  await saveSettings(f.store,{version:1,data:f.data,credentials:{deepseek:'rotated-private-key'}});assert.equal(studioSpend(f.store).committedMicros,100_000_000);assert.equal(calls,0);
});
for(const status of [401,403,429,500,302])test('AI HTTP '+status+' is sanitized and never silently switches provider',async t=>{
  let calls=0;const f=await apiFixture(t,async()=>{calls++;return response({error:{message:'fixture-private-key-deepseek'}},status);});
  const result=await testProvider(f.store,{provider:'deepseek',requestId:'failure-canary-'+status},{request:f.request});assert.equal(result.state,'failed');assert.doesNotMatch(JSON.stringify(result),/fixture-private-key/);assert.equal(calls,1);
});
test('length/tool/refusal/invalid JSON results cannot become successful proposals',async t=>{
  for(const payload of [{choices:[{finish_reason:'length',message:{content:'{}'}}]},{choices:[{finish_reason:'stop',message:{content:'{}',tool_calls:[{}]}}]},{choices:[{finish_reason:'stop',message:{content:'not JSON'}}]}]){
    const f=await apiFixture(t,async()=>response(payload));const result=await testProvider(f.store,{provider:'deepseek',requestId:'incomplete-canary-request'},{request:f.request});assert.equal(result.state,'failed');assert.equal(studioSpend(f.store).calls.length,1);
  }
});
test('transport rejects nonregistered destinations before attempting a request',async()=>{
  for(const url of ['http://127.0.0.1:8780/api/op','https://api.deepseek.com.evil.example/v1/chat/completions','https://api.openai.com/v1/responses?key=secret'])await assert.rejects(studioHttp(url),e=>['PROVIDER_DESTINATION','PUBLIC_URL'].includes(e.code)||/https|public/i.test(e.message));
});
test('zero-priced profiles need an explicit finite free allowance and retain its usage across configuration changes',async t=>{
 const f=await apiFixture(t),data=structuredClone(f.data);data.providers.google.price={...fixturePrice(),inputUsdPerMillion:0,outputUsdPerMillion:0,maxRequestUsd:0,freeRequests:0};await saveSettings(f.store,{version:1,data,credentials:{}});
 assert.equal((await studioStatus(f.store)).connections.find(c=>c.id==='google').priced,false);assert.equal((await testProvider(f.store,{provider:'google',requestId:'zero-price-without-allowance'},{request:f.request})).errorCode,'PRICE_UNVERIFIED');
 data.providers.google.price.freeRequests=1;await saveSettings(f.store,{version:2,data,credentials:{}});assert.equal((await testProvider(f.store,{provider:'google',requestId:'one-free-request-canary'},{request:f.request})).state,'passed');assert.equal((await testProvider(f.store,{provider:'google',requestId:'second-free-request-canary'},{request:f.request})).errorCode,'PROVIDER_CALL_CAP');assert.equal(studioSpend(f.store).committedMicros,0);
});
test('an old underpriced receipt beyond the visible fifty calls still stops new spending',async t=>{
 const f=await apiFixture(t);saveRecord(f.store,'old-over-ceiling','studio_spend',{id:'old-over-ceiling',reservedMicros:1,chargedMicros:2,state:'completed',provider:'fixture',purpose:'fixture'});for(let n=0;n<55;n++)saveRecord(f.store,'later-'+n,'studio_spend',{id:'later-'+n,reservedMicros:1,chargedMicros:1,state:'completed',provider:'fixture',purpose:'fixture'});
 await assert.rejects(paidCall(f.store,{requestId:'hold-old-price-violation',provider:'fixture',purpose:'fixture',input:{},upperMicros:1},async()=>({})),e=>e.code==='PRICE_CEILING_EXCEEDED');
});
test('a configured API workspace holds legacy paid routes and jobs before source or model work',async t=>{
 const f=await apiFixture(t);await assert.rejects(f.service.dispatch('leads_discover',{requestId:'legacy-spend-bypass-test',query:'mobile detailing',area:'Houston',termsReviewed:true,authorized:true}),e=>e.code==='STUDIO_METERED_WORKFLOW');
 const campaign=f.store.createCampaign({name:'Legacy held fixture',query:'fixture',area:'Houston',niche:'Fixture'}),job=f.store.createJob({campaignId:campaign.id,kind:'discovery'});const{executeJob}=await import('../src/worker.mjs');const result=await executeJob(f.store,job.id);assert.equal(result.state,'blocked');assert.equal(result.errorCode,'STUDIO_METERED_WORKFLOW');assert.equal(studioSpend(f.store).calls.length,0);
});
