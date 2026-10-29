import test from 'node:test';
import assert from 'node:assert/strict';
import {makeBrief,generateProposal} from '../src/creative.mjs';
import {fictionalBusiness,premiumExample} from '../src/premium-examples.mjs';
import {PREMIUM_PROFILE} from '../src/effects-contract.mjs';
const candidate=fictionalBusiness(0),example=premiumExample(candidate);
function common(output,extra={}){const calls=[];return{candidate,media:[],references:[],files:[],photoFree:true,designProfile:PREMIUM_PROFILE,apiInvoke:async call=>{calls.push(call);return{output,sessionId:'fictional'};},calls,...extra};}
test('premium brief requires the tested library and a normalized effect plan without invented photos',async()=>{
  const c=common(example.brief),brief=await makeBrief(c);
  assert.equal(brief.effectsPlan.profile,PREMIUM_PROFILE);assert.ok(brief.effectsPlan.effects.every(e=>Array.isArray(e.factIds)&&Array.isArray(e.mediaFiles)));
  assert.match(c.calls[0].prompt,/supersedes the legacy/);assert.match(c.calls[0].prompt,/PHOTO-FREE/);assert.match(c.calls[0].prompt,/assets\/factory-effects.js/);assert.doesNotMatch(c.calls[0].prompt,/not copied grids or an effects quota/);assert.deepEqual(c.calls[0].files,[]);
});
test('a premium brief missing its effects plan is held',async()=>{
  const brief=structuredClone(example.brief);delete brief.effectsPlan;
  await assert.rejects(makeBrief(common(brief)),e=>e.code==='EFFECTS_PLAN');
});
test('historical API briefs do not silently adopt the new profile',async()=>{
  const brief=structuredClone(example.brief);delete brief.effectsPlan;const c=common(brief,{designProfile:undefined});
  const actual=await makeBrief(c);assert.equal(actual.effectsPlan,undefined);assert.doesNotMatch(c.calls[0].prompt,/PREMIUM PROFILE/);
});
test('premium generation and bounded repair retain the same explicit effect contract',async()=>{
  for(const repair of [false,true]){
    const c=common(example,{brief:example.brief,...(repair?{previous:example,repairKind:'technical',failures:[{code:'EFFECTS_BEHAVIOR'}]}:{})});
    const proposal=await generateProposal(c);assert.equal(proposal.files.filter(f=>f.path.endsWith('.html')).length,5);
    assert.equal(c.calls[0].task,repair?'repair':'code');assert.match(c.calls[0].prompt,/premium-title/);assert.match(c.calls[0].prompt,/stationary/);assert.deepEqual(c.calls[0].files,[]);
  }
});
