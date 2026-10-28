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
