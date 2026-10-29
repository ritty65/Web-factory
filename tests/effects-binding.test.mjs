import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fictionalBusiness,premiumExample,illustrationMedia} from '../src/premium-examples.mjs';
import {stageRuntime} from '../src/craft.mjs';
import {stageProposal,treeHashes} from '../src/proposal.mjs';
import {validateEffectsPlan,effectsDigest} from '../src/effects-contract.mjs';
import {checkSite} from '../src/qa.mjs';
import {packageReview} from '../src/package.mjs';
import {policyIdentity} from '../src/policy.mjs';
const candidate=fictionalBusiness(0),example=premiumExample(candidate),plan=validateEffectsPlan(example.brief.effectsPlan,{candidate,media:[],pages:example.brief.pageMap.map(p=>p.file)});
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'factory-effects-binding-'));t.after(()=>rm(root,{recursive:true,force:true}));const siteRoot=path.join(root,'site');await stageRuntime(siteRoot,{designProfile:plan.profile});await stageProposal(siteRoot,example);return{root,siteRoot};}
test('altered host effect bytes cannot pass premium QA, even with correct HTML attributes',async t=>{
  const{root,siteRoot}=await fixture(t);await writeFile(path.join(siteRoot,'assets/factory-effects.js'),'/* placeholder claims no behavior */');
  const qa=await checkSite({siteRoot,outputRoot:path.join(root,'qa'),candidate,effectsPlan:plan});assert.equal(qa.pass,false);assert.ok(qa.issues.some(i=>i.code==='EFFECTS_RUNTIME'));assert.equal(qa.pageChecks.length,0);
});
test('each premium page must actually load its protected runtime and stylesheet',async t=>{
  const{root,siteRoot}=await fixture(t),file=path.join(siteRoot,'contact.html');
  await writeFile(file,(await readFile(file,'utf8')).replace('<script defer src="assets/factory-effects.js"></script>','').replace('<link rel="stylesheet" href="assets/factory-effects.css">',''));
  const qa=await checkSite({siteRoot,outputRoot:path.join(root,'qa'),candidate,effectsPlan:plan});assert.equal(qa.pass,false);assert.ok(qa.issues.some(i=>i.code==='EFFECTS_RUNTIME'&&i.file==='contact.html'));
});
test('packages cannot drop, change or invent the effect QA binding',async t=>{
  const{root,siteRoot}=await fixture(t),qa={pass:true,siteHashes:await treeHashes(siteRoot),effectsPlan:plan,effectsDigest:effectsDigest(plan)},base={siteRoot,outputRoot:path.join(root,'package'),candidate,media:[],design:example.design};
  await assert.rejects(packageReview({...base,qa}),e=>e.code==='STALE_EFFECTS_QA');
  await assert.rejects(packageReview({...base,qa,effectsPlan:plan}),e=>e.code==='STALE_EFFECTS_QA');
  const changed=structuredClone(plan);changed.effects[0].purpose='Changed after browser checks completed.';
  await assert.rejects(packageReview({...base,qa,effectsPlan:changed}),e=>e.code==='STALE_EFFECTS_QA');
});
test('three copies of the same image cannot satisfy gallery eligibility',()=>{
  const media=illustrationMedia().map(m=>({...m,web_sha256:'0'.repeat(64)})),c=fictionalBusiness(2),e=premiumExample(c,{variant:2,media});
  assert.throws(()=>validateEffectsPlan(e.brief.effectsPlan,{candidate:c,media,pages:e.brief.pageMap.map(p=>p.file)}),e=>e.code==='EFFECTS_PLAN');
});
test('unknown runtime profiles fail explicitly',async()=>{
  await assert.rejects(stageRuntime('/tmp/unused-factory-effects',{designProfile:'unknown'}),e=>e.code==='DESIGN_PROFILE');
});
test('both policy identities include the effect contract, probes and protected bytes',async()=>{
  for(const scope of ['qa','production']){const policy=await policyIdentity(scope);for(const file of ['src/effects-contract.mjs','src/qa-effects.mjs','runtime/effects.js','runtime/effects.css'])assert.match(policy.files[file],/^[a-f0-9]{64}$/);}
});
