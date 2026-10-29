import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {readFile} from 'node:fs/promises';
import {apiFixture,canaryRequest} from './helpers-studio.mjs';import {directorExample,referenceFixtures,directorResponse} from './helpers-director.mjs';
import {createService} from '../src/service.mjs';import {executeJob} from '../src/worker.mjs';import {testProvider} from '../src/studio-providers.mjs';import {CINEMATIC_PROFILE} from '../src/site-profile.mjs';
import {checkSite} from '../src/qa.mjs';
const actualChecks=t=>async options=>{const qa=await checkSite(options);if(!qa.pass)t.diagnostic(JSON.stringify({pageCount:options.pageCount,issues:qa.issues}));return qa;};
async function prepare(t,{hold=false}={}){
 let example;const calls=[],request=async(url,options)=>example&&directorResponse(url,options,example,{hold,calls})||canaryRequest(url,options);
 const f=await apiFixture(t,request);await referenceFixtures(f.store);for(const provider of ['deepseek','openrouter'])await testProvider(f.store,{provider,requestId:'director-canary-'+provider},{request});
 const service=createService(f.store,{autoRun:false,studioRequest:request,intakeRuntime:async()=>({canAttemptProposal:true,backend:'fixture_api'})});
 const data={name:'Fictional Oakline Detailing',area:'Houston, Texas',niche:'Mobile detailing',summary:'Fictional supplied business offering interior cleaning, exterior care and complete detailing in Houston.',services:['Interior cleaning','Exterior care','Complete detailing'],sourceUrl:'https://example.com/fictional-business',phone:'+17135550101',email:'',bookingUrl:'',goal:'phone',tone:'Clear and distinctive',photoIds:[],factsConfirmed:true,contactConfirmed:true,privateConceptAuthorized:true,reviewedAt:new Date().toISOString()};
 const saved=await service.dispatch('intake_save',{id:'intake-director-fixture',version:0,data});
 const candidate={id:saved.id,name:data.name,area:data.area,contacts:{phone:data.phone},sourceUrls:[data.sourceUrl],facts:[{id:'supplied-summary',text:data.summary,sourceUrl:data.sourceUrl},...data.services.map((text,i)=>({id:'supplied-service-'+i,text,sourceUrl:data.sourceUrl}))]};example=directorExample(candidate);
 const {job}=await service.dispatch('intake_build',{id:saved.id,version:saved.version,digest:saved.digest,requestId:'director-build',authorized:true,designProfile:CINEMATIC_PROFILE});
 return{...f,service,job,calls,example};
}
test('cinematic API pipeline checks one actual homepage before expansion and packages five actual pages',async t=>{
 const f=await prepare(t),result=await executeJob(f.store,f.job.id,{studioRequest:f.request,checkSite:actualChecks(t)});assert.equal(result.state,'review_ready',result.errorCode+': '+result.message);
 assert.equal(result.outputs.modelVerification,'injected_or_unverified');assert.equal(result.outputs.humanDecision,null);assert.equal(result.outputs.publicRelease,false);
 const qa=JSON.parse(await readFile(path.join(f.store.stateRoot,result.outputs.qaRelative,'results.json')));assert.equal(qa.pageChecks.length,25);assert.equal(qa.effectsChecks.length,25);assert.equal(qa.captures.filter(c=>c.kind==='section_viewport').length,10);
 const home=JSON.parse(await readFile(path.join(f.store.stateRoot,result.outputs.homepageRelative,'../../homepage-qa-0/results.json')));assert.equal(home.pageChecks.length,5);assert.equal(home.pass,true);
 const firstReview=f.calls.findIndex(c=>c.task==='DIRECTOR_REVIEW'),expansion=f.calls.findIndex(c=>c.task==='DIRECTOR_EXPANSION');assert.ok(firstReview>0&&expansion>firstReview);
 const manifest=JSON.parse(await readFile(path.join(f.store.stateRoot,result.outputs.packageRelative,'manifest.json')));assert.equal(manifest.designEvidence.referenceBindings.length,2);assert.equal(manifest.designEvidence.humanDecision,null);
 assert.ok(f.calls.length<=16);assert.equal(f.calls.filter(c=>c.task==='DIRECTOR_REVIEW').length,3);
});
test('a held homepage receives only one repair and cannot expand into a full site',async t=>{
 const f=await prepare(t,{hold:true}),result=await executeJob(f.store,f.job.id,{studioRequest:f.request});assert.equal(result.errorCode,'DESIGN_HOME_REWORK',result.message);assert.equal(f.calls.some(c=>c.task==='DIRECTOR_EXPANSION'),false);assert.equal(f.calls.filter(c=>c.task==='DIRECTOR_HOMEPAGE').length,2);assert.equal(f.store.artifacts(f.job.id).some(a=>a.kind==='package'),false);
});
test('a changed reference stops a queued cinematic build before any model request',async t=>{
 const f=await prepare(t),r=f.store.references().find(r=>r.id==='obys');f.store.saveReference({...r,observation:'Changed after queue'});
 const result=await executeJob(f.store,f.job.id,{studioRequest:f.request});assert.equal(result.errorCode,'STALE_DESIGN_REFERENCE');assert.equal(f.calls.length,0);
});
