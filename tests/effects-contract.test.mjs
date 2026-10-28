import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateEffectsPlan, PREMIUM_PROFILE} from '../src/effects-contract.mjs';
import {fictionalBusiness, premiumExample, illustrationMedia} from '../src/premium-examples.mjs';
import {stageRuntime} from '../src/craft.mjs';
import {validateProposal} from '../src/contracts.mjs';
const candidate=fictionalBusiness(2), media=illustrationMedia(), example=premiumExample(candidate,{variant:2,media});
const options={candidate,media,pages:example.brief.pageMap.map(p=>p.file)};
test('the five-family plan binds facts, approved images and homepage targets',()=>{
  const plan=validateEffectsPlan(example.brief.effectsPlan,options);
  assert.equal(new Set(plan.effects.map(e=>e.type)).size,5);
  assert.equal(plan.profile,PREMIUM_PROFILE);
  assert.equal(validateEffectsPlan(premiumExample(candidate).brief.effectsPlan,options).effects.length,3);
});
for(const [label,change] of [
  ['missing plan',()=>null],['unknown profile',p=>({...p,profile:'anything'})],['unknown version',p=>({...p,version:2})],
  ['too few families',p=>({...p,effects:p.effects.slice(0,2)})],['duplicate instance',p=>({...p,effects:[...p.effects,p.effects[0]]})],
  ['selector instead of ID',p=>(p.effects[0].targetId='#title',p)],['extra program',p=>(p.effects[0].script='alert(1)',p)],
  ['unknown fact',p=>(p.effects[3].factIds=['invented','service-1','service-2'],p)],['too few facts',p=>(p.effects[3].factIds=['service-1'],p)],
  ['unknown photo',p=>(p.effects[4].mediaFiles[0]='assets/invented.webp',p)],['duplicate photos',p=>(p.effects[4].mediaFiles.fill(p.effects[4].mediaFiles[0]),p)],
  ['insufficient photos',p=>(p.effects[4].mediaFiles.pop(),p)],['undeclared page',p=>(p.effects[0].page='missing.html',p)],
  ['no homepage effects',p=>(p.effects.forEach(e=>e.page='about.html'),p)],['empty purpose',p=>(p.effects[0].purpose='',p)],
])test('rejects '+label,()=>assert.throws(()=>validateEffectsPlan(change(structuredClone(example.brief.effectsPlan)),options),e=>e.code==='EFFECTS_PLAN'));
test('model output cannot replace protected effect JS or CSS',()=>{
  for(const ext of ['js','css'])assert.throws(()=>validateProposal({design:example.design,files:[...example.files,{path:'assets/factory-effects.'+ext,content:'hostile'}]}),e=>e.code==='RESERVED_ASSET');
});
test('premium runtime staging is explicit and immutable; legacy staging stays unchanged',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'factory-effects-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await stageRuntime(root);await assert.rejects(readFile(path.join(root,'assets/factory-effects.js')),e=>e.code==='ENOENT');
  await stageRuntime(root,{designProfile:PREMIUM_PROFILE});
  assert.deepEqual(await readFile(path.join(root,'assets/factory-effects.js')),await readFile(new URL('../runtime/effects.js',import.meta.url)));
  await stageRuntime(root,{designProfile:PREMIUM_PROFILE});
});
