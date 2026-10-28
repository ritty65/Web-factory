import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {candidateInput} from '../src/contracts.mjs';
import {assessIntake,identityObservations,profileAnchors} from '../src/intake.mjs';
import {scoutStep} from '../src/scout.mjs';
import {intakeFixture} from './helpers-batch.mjs';
import {acquisitionFixture,draftFixture} from './helpers-acquisition.mjs';

const profile='https://www.facebook.com/people/Juniper-Workshop/100000000001001/';
function peopleFixture(){
  const f=intakeFixture(),c=f.candidate,o=f.observations[0];
  c.contacts={facebook:profile};c.contactSources={facebook:profile};c.sourceUrls=[profile];
  c.facts=c.facts.map(fact=>({...fact,sourceUrl:profile}));c.websiteCheck.status='unknown';
  c.websiteCheck.queries=[];c.media=[];delete c.pagePurposes;delete c.activityEvidence;
  o.url=profile;o.finalUrl=profile;o.links=[];o.images=[];
  return f;
}

test('an observed Facebook people profile is an exact anchor and first-party evidence, not qualification',()=>{
  const f=peopleFixture(),c=candidateInput(f.candidate);
  assert.deepEqual(profileAnchors(c),['https://facebook.com/people/Juniper-Workshop/100000000001001']);
  assert.equal(identityObservations(c,f.observations).length,1);
  const result=assessIntake(c,f);
  assert.equal(result.ready,false);
  assert.ok(result.reasons.some(reason=>reason.includes('Website absence')));
  assert.ok(result.reasons.some(reason=>reason.includes('photography is missing')));
});

test('Facebook people anchors reject unsupported paths, queries, hosts and malformed IDs',()=>{
  for(const url of [
    'https://www.facebook.com/people/Juniper-Workshop/not-an-id/',
    'https://www.facebook.com/people/Juniper-Workshop/123/',
    'https://www.facebook.com/people/Juniper-Workshop/100000000001001/posts/',
    'https://www.facebook.com/people/Juniper-Workshop/100000000001001/?redirect=https%3A%2F%2Fevil.example',
    'https://www.facebook.com.evil.example/people/Juniper-Workshop/100000000001001/',
    'https://www.facebook.com/people/Juniper%2FWorkshop/100000000001001/',
  ]) assert.deepEqual(profileAnchors({contacts:{facebook:url},sourceUrls:[]}),[],url);
});

test('a redirected or unbound Facebook people observation does not supply first-party evidence',()=>{
  const f=peopleFixture(),c=candidateInput(f.candidate),o=f.observations[0];
  o.finalUrl='https://www.facebook.com/people/Other-Workshop/100000000001002/';
  assert.deepEqual(identityObservations(c,[o]),[]);
  o.finalUrl=profile;o.blocked=true;
  assert.equal(assessIntake(c,f).reasons.some(reason=>reason.includes('No fresh identity-matched')),true);
});

test('the same Facebook people profile keeps one scout identity when area wording changes',async t=>{
  const f=await acquisitionFixture(t,{candidateLimit:1}),d=await draftFixture(f),local=peopleFixture();
  d.output.candidates=[local.candidate];
  await writeFile(path.join(f.directory,local.observations[0].id+'.json'),JSON.stringify(local.observations[0]));
  const args={store:f.store,jobId:f.job.id,directory:f.directory,output:d.output};
  const first=await scoutStep(args);assert.equal(first.retainedDraftIdentities.length,1);
  d.output.candidates[0].area='A different description of the same Houston location';
  const second=await scoutStep(args);assert.equal(second.retainedDraftIdentities.length,1);
  assert.equal(second.retainedDraftIdentities[0].identityKey,first.retainedDraftIdentities[0].identityKey);
});
