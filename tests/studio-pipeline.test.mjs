import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {readFile} from 'node:fs/promises';
import {apiFixture,canaryRequest} from './helpers-studio.mjs';
import {studioSiteData,siteModelResponse,sitePages} from './helpers-studio-site.mjs';
import {createService} from '../src/service.mjs';import {executeJob} from '../src/worker.mjs';
import {testProvider} from '../src/studio-providers.mjs';import {hash} from '../src/contracts.mjs';
import {saveSettings} from '../src/studio-config.mjs';
const data=()=>({name:'Fictional Oakline Detailing',area:'Houston, Texas',niche:'Mobile detailing',summary:'Fictional supplied business offering interior cleaning, exterior care and complete detailing in Houston.',services:['Interior cleaning','Exterior care','Complete detailing'],sourceUrl:'https://example.com/fictional-business',phone:'+17135550101',email:'',bookingUrl:'',goal:'phone',tone:'Clear and distinctive',photoIds:[],factsConfirmed:true,contactConfirmed:true,privateConceptAuthorized:true,reviewedAt:new Date().toISOString()});
async function prepare(t,{withPhoto=false,photoCount=withPhoto?1:0,variant=0}={}){
  let site;const calls=[];const request=async(url,options)=>{const response=site&&siteModelResponse(url,options,site);calls.push({provider:url.includes('deepseek')?'deepseek':url.includes('openrouter')?'openrouter':'other',vision:Array.isArray(JSON.parse(options.body||'{}').messages?.at(-1)?.content)});return response||canaryRequest(url,options);};
  const f=await apiFixture(t,request);for(const provider of ['deepseek','openrouter'])await testProvider(f.store,{provider,requestId:'pipeline-test-'+provider},{request});
  const service=createService(f.store,{autoRun:false,studioRequest:request,intakeRuntime:async()=>({canAttemptProposal:true,backend:'fixture_api'})});const d=data();let version=0;
  if(photoCount){
    await service.dispatch('intake_save',{id:'intake-api-site-fixture',version:0,data:d});version=1;
    const{default:sharp}=await import('sharp');
    for(let i=0;i<photoCount;i++){
      const bytes=await sharp({create:{width:1000,height:600,channels:3,background:['#24573e','#9c5423','#246293'][i]}}).jpeg().toBuffer();
      const photo=await service.dispatch('intake_photo',{draftId:'intake-api-site-fixture',originalBase64:bytes.toString('base64'),contentType:'image/jpeg',alt:'Original test image '+i+', not client work',permission:'owned'});d.photoIds.push(photo.id);
    }
  }
  const saved=await service.dispatch('intake_save',{id:'intake-api-site-fixture',version,data:d});
  const candidate={id:saved.id,name:d.name,area:d.area,contacts:{phone:d.phone},sourceUrls:[d.sourceUrl],facts:[{id:'supplied-summary',text:d.summary,sourceUrl:d.sourceUrl},...d.services.map((text,i)=>({id:'supplied-service-'+i,text,sourceUrl:d.sourceUrl}))]};site=studioSiteData(candidate,{variant,media:Array.from({length:photoCount},(_,i)=>({web_file:'site/assets/photos/photo-'+i+'.webp',dimensions:[1000,600],alt:'Original test image '+i+', not client work'}))});
  if(withPhoto)for(const file of [...site.files,...site.studies.flatMap(s=>s.files)]){if(file.path.endsWith('.html'))file.content=file.content.replace('<section id="support">','<img src="assets/photos/photo-0.webp" width="1000" height="600" alt="Fictional owned image for the private pipeline test" fetchpriority="high" style="display:block;max-width:100%;height:auto"><section id="support">');}
  const{job}=await service.dispatch('intake_build',{id:saved.id,version:saved.version,digest:saved.digest,requestId:'build-api-site-fixture',authorized:true});return{...f,service,site,job,calls};
}
test('DeepSeek-first default API pipeline renders three openings, checks five actual pages and packages exact private bytes',async t=>{
  const f=await prepare(t);const result=await executeJob(f.store,f.job.id,{studioRequest:f.request});
  assert.equal(result.state,'review_ready',result.errorCode+': '+result.message);assert.equal(result.outputs.publicRelease,false);assert.equal(result.outputs.humanDecision,null);assert.equal(result.outputs.photoCount,0);
  const qa=JSON.parse(await readFile(path.join(f.store.stateRoot,result.outputs.qaRelative,'results.json'),'utf8'));assert.equal(qa.pass,true);assert.equal(qa.pageChecks.length,25);assert.equal(qa.effectsChecks.length,25);assert.ok(qa.effectsChecks.every(c=>c.pass));assert.equal(result.outputs.designProfile,'premium-practical-v1');assert.equal(result.outputs.modelVerification,'injected_or_unverified');
  assert.equal(result.outputs.factualReview.checkedPages.length,5);assert.ok(f.calls.some(c=>c.provider==='deepseek'&&!c.vision));assert.ok(f.calls.some(c=>c.provider==='openrouter'&&c.vision));assert.ok(f.calls.filter(c=>c.provider==='deepseek').every(c=>!c.vision));
  const archive=f.store.artifacts(f.job.id).find(a=>a.kind==='package');assert.ok(archive);assert.equal(hash(await readFile(path.join(f.store.stateRoot,archive.relative))),archive.sha256);
  assert.equal(f.store.candidates().length,0);assert.equal(f.store.businesses().length,0);
});
test('changing a queued API profile holds the exact supplied proof before another model call',async t=>{
  const f=await prepare(t),before=f.calls.length;const changed=structuredClone(f.data);changed.niche='Different fixture target';await saveSettings(f.store,{version:1,data:changed,credentials:{}});
  const result=await executeJob(f.store,f.job.id,{studioRequest:f.request});assert.equal(result.state,'blocked');assert.equal(result.errorCode,'STALE_PROVIDER_PROFILE');assert.equal(f.calls.length,before);
});
test('the API pipeline describes actual supplied pixels, serves the frozen photo on all pages and keeps private provenance',async t=>{
 const f=await prepare(t,{withPhoto:true}),result=await executeJob(f.store,f.job.id,{studioRequest:f.request,checkSite:async options=>{const{checkSite}=await import('../src/qa.mjs');const qa=await checkSite(options);if(!qa.pass)t.diagnostic(JSON.stringify(qa.issues));return qa;}});assert.equal(result.state,'review_ready',result.errorCode+': '+result.message);assert.equal(result.outputs.photoCount,1);const manifest=JSON.parse(await readFile(path.join(f.store.stateRoot,result.outputs.packageRelative,'manifest.json'),'utf8'));assert.equal(manifest.media.length,1);assert.equal(manifest.media[0].rightsholder_permission,'operator_declared');assert.equal(manifest.publicRelease,false);assert.equal(f.calls.filter(c=>c.provider==='openrouter'&&c.vision).length>=3,true);
});
test('forged source-backed proof cannot start generation',async t=>{
  const f=await apiFixture(t);const campaign=f.store.createCampaign({name:'Forged API fixture',area:'Houston',niche:'Fixture',query:'Fixture'}),job=f.store.createJob({campaignId:campaign.id,kind:'site',input:{apiConcept:{proofId:'api-proof-forged',digest:'0'.repeat(64)},modelSelection:'api/deepseek-first'}});
  let calls=0;const result=await executeJob(f.store,job.id,{studioRequest:async()=>{calls++;throw Error();}});assert.equal(result.errorCode,'API_CONCEPT_BINDING');assert.equal(calls,0);
});

test('all five effects survive actual three-photo API generation, review and exact packaging',async t=>{
  const f=await prepare(t,{photoCount:3,variant:2}),result=await executeJob(f.store,f.job.id,{studioRequest:f.request,checkSite:async options=>{const{checkSite}=await import('../src/qa.mjs');const qa=await checkSite(options);if(!qa.pass)t.diagnostic(JSON.stringify(qa.issues));return qa;}});
  assert.equal(result.state,'review_ready',result.errorCode+': '+result.message);
  const manifest=JSON.parse(await readFile(path.join(f.store.stateRoot,result.outputs.packageRelative,'manifest.json'),'utf8'));
  assert.equal(new Set(manifest.effectsPlan.effects.map(e=>e.type)).size,5);assert.equal(manifest.effectsChecks.length,25);assert.ok(manifest.effectsChecks.every(c=>c.pass));
  assert.equal(manifest.media.length,3);assert.equal(manifest.effectsDigest,result.outputs.effectsDigest);assert.equal(manifest.humanDecision,null);
});
test('a new premium build cannot silently omit its effect plan',async t=>{
  const f=await prepare(t);delete f.site.brief.effectsPlan;
  const result=await executeJob(f.store,f.job.id,{studioRequest:f.request});assert.equal(result.state,'blocked');assert.equal(result.errorCode,'EFFECTS_PLAN');
  assert.equal(f.store.artifacts(f.job.id).some(a=>a.kind==='package'),false);
});
test('changing a frozen design profile holds before another model request',async t=>{
  const f=await prepare(t),before=f.calls.length;f.store.updateJob(f.job.id,{input:{...f.job.input,designProfile:'unknown'}});
  const result=await executeJob(f.store,f.job.id,{studioRequest:f.request});assert.equal(result.state,'blocked');assert.equal(result.errorCode,'DESIGN_PROFILE');assert.equal(f.calls.length,before);
});
