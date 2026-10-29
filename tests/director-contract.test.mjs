import test from 'node:test';import assert from 'node:assert/strict';
import path from 'node:path';import os from 'node:os';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {fictionalBusiness} from '../src/premium-examples.mjs';
import {directorExample,creativeReview,referenceFixtures} from './helpers-director.mjs';
import {apiFixture} from './helpers-studio.mjs';
import {stageRuntime} from '../src/craft.mjs';import {stageProposal} from '../src/proposal.mjs';
import {staticAudit,checkSite} from '../src/qa.mjs';import {validateProposal} from '../src/contracts.mjs';
import {CINEMATIC_PROFILE,CINEMATIC_HOST_ASSETS,siteBudget} from '../src/site-profile.mjs';
import {validateEffectsPlan} from '../src/effects-contract.mjs';
import {validateCreativeReview,directorExpansion} from '../src/director-creative.mjs';
import {selectReferenceBindings,frozenReferencePacket} from '../src/design-references.mjs';
import {paidCall} from '../src/studio-budget.mjs';
const candidate=fictionalBusiness(0),e=directorExample(candidate);
test('cinematic runtime has exact vendored bytes, licences and a host-selected budget',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'director-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await stageRuntime(root,{designProfile:CINEMATIC_PROFILE});await stageProposal(root,e,{designProfile:CINEMATIC_PROFILE});
 const audit=await staticAudit(root,{candidate,designProfile:CINEMATIC_PROFILE});assert.equal(audit.pass,true,JSON.stringify(audit.issues));
 assert.ok(audit.bytes.js<siteBudget(CINEMATIC_PROFILE).js);assert.ok(audit.bytes.js>siteBudget(null).js);
 for(const [name,source]of CINEMATIC_HOST_ASSETS){assert.deepEqual(await readFile(path.join(root,name)),await readFile(new URL(source,new URL('../src/site-profile.mjs',import.meta.url))));assert.throws(()=>validateProposal({...e,files:[...e.files,{path:name,content:'tampered'}]},{designProfile:CINEMATIC_PROFILE}));}
 await writeFile(path.join(root,'assets/factory-gsap.js'),'fetch("https://example.com")');
 const bad=await staticAudit(root,{candidate,designProfile:CINEMATIC_PROFILE});assert.ok(bad.issues.some(i=>i.code==='CINEMATIC_RUNTIME'));assert.ok(bad.issues.some(i=>i.code==='UNSUPPORTED_RUNTIME'));
});
test('cinematic plans require a coherent selection with an advanced family',()=>{
 assert.equal(validateEffectsPlan(e.brief.effectsPlan,{candidate,pages:e.brief.pageMap.map(p=>p.file)}).profile,CINEMATIC_PROFILE);
 const basic=structuredClone(e.brief.effectsPlan);basic.effects.find(x=>x.type==='split-chars').type='split-text';assert.throws(()=>validateEffectsPlan(basic,{candidate,pages:e.brief.pageMap.map(p=>p.file)}),{code:'EFFECTS_PLAN'});
});
test('creative pass requires all seven criteria and references to supplied current crops',()=>{
 const manifest=[{captureId:'0'}],valid=creativeReview(manifest);assert.equal(validateCreativeReview(valid,manifest).humanDecision,null);
 for(const change of [r=>delete r.criteria.mobile,r=>r.criteria.identity.captureRefs=['invented'],r=>r.criteria.mobile.status='hold',r=>r.blockingDefects=['Unresolved defect']]){const r=structuredClone(valid);change(r);assert.throws(()=>validateCreativeReview(r,manifest),{code:'DESIGN_REVIEW_SCHEMA'});}
 assert.equal(validateCreativeReview(creativeReview(manifest,'hold'),manifest).verdict,'hold');
});
test('reference packets reject loader captures, changed metadata and changed bytes',async t=>{
 const {store}=await apiFixture(t);await assert.rejects(async()=>selectReferenceBindings(store),{code:'DESIGN_REFERENCES_MISSING'});await referenceFixtures(store);
 const bindings=selectReferenceBindings(store),packet=await frozenReferencePacket(store,bindings);assert.equal(packet.files.length,4);
 const r=store.references().find(r=>r.id===bindings[0].id);store.saveReference({...r,observation:'Changed after queue'});await assert.rejects(frozenReferencePacket(store,bindings),{code:'STALE_DESIGN_REFERENCE'});
 store.saveReference(r);await writeFile(packet.files[0],'tampered capture');await assert.rejects(frozenReferencePacket(store,bindings),{code:'STALE_DESIGN_REFERENCE'});
 store.saveReference({...r,captures:r.captures.map(c=>({...c,contentReady:false}))});assert.throws(()=>selectReferenceBindings(store),{code:'DESIGN_REFERENCES_MISSING'});
});
test('four-page expansion preserves home/assets and rejects any replacement attempt',async()=>{
 const c={candidate,media:[],brief:e.brief,homepage:e.homepage,referencePacket:{references:[],files:[],digest:'fixture'},apiInvoke:async()=>({output:e.additions})};
 const result=await directorExpansion(c);assert.equal(result.files.filter(f=>f.path.endsWith('.html')).length,5);assert.deepEqual(result.files.find(f=>f.path==='style.css'),e.homepage.files.find(f=>f.path==='style.css'));
 await assert.rejects(directorExpansion({...c,apiInvoke:async()=>({output:{files:[...e.additions.files.slice(0,3),{path:'index.html',content:'hostile'}]}})}),{code:'DESIGN_EXPANSION'});
});
test('a missing cinematic script is held even when all vendor bytes are staged',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'director-load-'));t.after(()=>rm(root,{recursive:true,force:true}));const siteRoot=path.join(root,'site');
 await stageRuntime(siteRoot,{designProfile:CINEMATIC_PROFILE});await stageProposal(siteRoot,e,{designProfile:CINEMATIC_PROFILE});
 const file=path.join(siteRoot,'index.html');await writeFile(file,(await readFile(file,'utf8')).replace('<script defer src="assets/factory-cinematic.js"></script>',''));
 const qa=await checkSite({siteRoot,outputRoot:path.join(root,'qa'),candidate,effectsPlan:e.brief.effectsPlan});assert.equal(qa.pass,false);assert.ok(qa.issues.some(i=>i.code==='CINEMATIC_RUNTIME'));assert.equal(qa.pageChecks.length,0);
});
for(const [profile,limit]of [['premium-practical-v1',10],[CINEMATIC_PROFILE,16]])test('model attempts remain bounded at '+limit+' for '+profile,async t=>{
 const{store}=await apiFixture(t),job=store.createJob({kind:'site',input:{designProfile:profile}});store.claim(job.id);
 const call=i=>paidCall(store,{requestId:'bounded-'+profile+'-'+i,provider:'deepseek',purpose:'ai:code',input:{i},upperMicros:0,jobId:job.id},async()=>({actualMicros:0,fixture:true}));
 for(let i=0;i<limit;i++)await call(i);await assert.rejects(call(limit),{code:'MODEL_CALL_CAP'});
});
