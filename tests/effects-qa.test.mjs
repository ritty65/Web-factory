import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm} from 'node:fs/promises';
import {chromium} from 'playwright';
import {fictionalBusiness,premiumExample} from '../src/premium-examples.mjs';
import {stageRuntime} from '../src/craft.mjs';
import {stageProposal} from '../src/proposal.mjs';
import {staticPreview} from '../src/qa.mjs';
import {checkEffects,observeEffectFrames} from '../src/qa-effects.mjs';
const candidate=fictionalBusiness(0),example=premiumExample(candidate),plan=example.brief.effectsPlan;
async function fixture(t,{noAnimation=false}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'factory-effects-qa-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await stageRuntime(root,{designProfile:plan.profile});await stageProposal(root,example);
  const preview=await staticPreview(root);t.after(()=>preview.close());
  const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1280,height:720}});await context.addInitScript(observeEffectFrames);
  if(noAnimation)await context.addInitScript(()=>{Element.prototype.animate=undefined;});
  const page=await context.newPage();await page.goto(preview.url+'/index.html');return{page,preview};
}
for(const [label,mutate] of [
 ['missing declared target',()=>document.getElementById('premium-call').removeAttribute('id')],
 ['duplicate declared ID',()=>{const n=document.createElement('div');n.id='premium-title';document.body.append(n);}],
 ['unplanned effect',()=>{const n=document.createElement('div');n.id='unplanned';n.dataset.effect='clip-reveal';document.body.append(n);}],
 ['competing motion',()=>document.getElementById('premium-title').setAttribute('data-reveal','rise')],
 ['hidden content',()=>document.getElementById('premium-art').style.display='none'],
 ['nonstationary target markup',()=>document.getElementById('premium-call').firstElementChild.removeAttribute('data-effect-label')],
])test('browser QA holds '+label,async t=>{
  const{page}=await fixture(t);await page.evaluate(mutate);
  const result=await checkEffects(page,plan,{file:'index.html',width:1280,candidate});assert.equal(result[0].name,'effects_structure');assert.equal(result[0].pass,false);assert.ok(result[0].failures.length);
});
test('attributes and a loaded runtime cannot substitute for observed reveal movement',async t=>{
  const{page}=await fixture(t,{noAnimation:true});
  const result=await checkEffects(page,plan,{file:'index.html',width:1280,candidate});
  assert.equal(result.find(r=>r.name==='split-text').pass,false);assert.equal(result.find(r=>r.name==='clip-reveal').pass,false);
});
