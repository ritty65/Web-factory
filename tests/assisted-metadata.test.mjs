import test from 'node:test';
import assert from 'node:assert/strict';
import {assistedFixture,assistedStore} from './helpers-assisted.mjs';
import {assistedDispatch} from '../src/assisted.mjs';
import {policyIdentity} from '../src/policy.mjs';
test('held assisted metadata never claims an established no-independent-website finding',async t=>{
  const store=await assistedStore(t),input=await assistedFixture();input.bundle.candidate.facts[0].excerpt='This invented excerpt was not observed';
  const saved=await assistedDispatch(store,'assisted_save',input);assert.equal(saved.assessment.ready,false);assert.match(saved.label,/held|unverified/i);assert.doesNotMatch(saved.label,/no independent marketing website found/i);
});
test('assisted build checks source-independent production readiness and Get reports its existing claim',async t=>{
  const store=await assistedStore(t),input=await assistedFixture(),saved=await assistedDispatch(store,'assisted_save',input);let checked=false;
  const result=await assistedDispatch(store,'assisted_build',{id:saved.id,bundleDigest:saved.bundleDigest,evidenceDigest:saved.evidenceDigest,policyDigest:(await policyIdentity('production')).digest,requestId:'build-assisted-metadata',authorized:true},{prerequisites:async settings=>{assert.equal(settings?.searchProvider,'assisted_external');checked=true;return {ready:true};}});
  assert.equal(checked,true);const retained=await assistedDispatch(store,'assisted_get',{id:saved.id});assert.equal(retained.claimedBatchId,result.batch.id);
});
