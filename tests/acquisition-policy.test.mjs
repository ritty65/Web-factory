import test from 'node:test';
import assert from 'node:assert/strict';
import {acquisitionPolicy,assessMaterial,discoveryQueries,completionCapacity} from '../src/acquisition.mjs';
import {candidateInput,now} from '../src/contracts.mjs';
import {intakeFixture} from './helpers-batch.mjs';

test('material feasibility requires observed substance, a literal dated activity claim and a stable photo route, not full readiness',()=>{
  const f=intakeFixture(),r=assessMaterial(candidateInput(f.candidate),f);
  assert.equal(r.feasible,true);assert.equal(r.factCount,3);assert.equal(r.observedPhotoCount,1);assert.equal(r.datedActivity,true);
  assert.equal(r.fullQualification,false);assert.equal(r.pixelsViewed,false);assert.equal(r.publicLicence,'unconfirmed');
  delete f.candidate.pagePurposes;f.imageViews=[];
  assert.equal(assessMaterial(candidateInput(f.candidate),f).feasible,true,'Full page planning and image pixels stay in selected intake');
});
for(const [label,change] of [
  ['blocked',f=>{f.observations[0].blocked=true;}],['stale',f=>{f.observations[0].inspectedAt='2020-01-01';}],
  ['unbound identity',f=>{f.candidate.inspectionIds=[];}],['unmatched identity',f=>{f.observations[0].url='https://www.instagram.com/unrelated/';}],
  ['repeated facts',f=>{f.candidate.facts=[f.candidate.facts[0],f.candidate.facts[0],f.candidate.facts[0]];}],
  ['invented excerpt',f=>{f.candidate.facts[0].excerpt='Fabricated service';}],
  ['no date',f=>{delete f.candidate.activityEvidence;}],['relative date',f=>{f.candidate.activityEvidence.dateText='yesterday';}],
  ['unobserved date',f=>{f.candidate.activityEvidence.excerpt='An invented dated post '+now().slice(0,10);}],
  ['wrong date',f=>{f.candidate.activityEvidence.date='2020-01-01';}],['future activity',f=>{f.candidate.activityEvidence.date='2099-01-01';}],
  ['missing photos',f=>{f.observations[0].images=[];}],['tiny photos',f=>{f.observations[0].images[0].width=10;}],
  ['missing dimensions',f=>{delete f.observations[0].images[0].width;}],['missing image ID',f=>{delete f.observations[0].images[0].id;}],
  ['guessed post',f=>{f.candidate.media[0].postUrl='https://www.instagram.com/p/guessed/';}],
  ['profile as post',f=>{f.candidate.media[0].postUrl=f.observations[0].url;}],
])test(`material feasibility holds ${label} without inventing facts or images`,()=>{const f=intakeFixture();change(f);assert.equal(assessMaterial(candidateInput(f.candidate),f).feasible,false);});
test('source-only observed metadata may establish feasibility but cannot fabricate a published contact or image licence',()=>{
  const f=intakeFixture(),photo=f.observations[0].images[0];photo.postUrl=f.candidate.media[0].postUrl;
  f.candidate.contacts={};f.candidate.contactSources={};f.candidate.media=[];const before=JSON.stringify(f.candidate);
  const r=assessMaterial(candidateInput(f.candidate),f);assert.equal(r.feasible,true);assert.equal(JSON.stringify(f.candidate),before);
  assert.equal(JSON.stringify(r).includes('cdninstagram'),false);
});
test('query planning spans general, social and local discovery with unique finite saved-scope queries',()=>{
  const q=discoveryQueries({niche:'mobile detailers/custom bakers/event decorators',area:'Houston city limits'});
  assert.equal(q.length,12);assert.equal(new Set(q.map(v=>v.query)).size,12);
  assert.deepEqual(new Set(q.slice(0,4).map(v=>v.family)),new Set(['general','instagram','facebook','local_listing']));
  assert.ok(q.every(v=>v.query.includes('Houston')&&v.query.length<=300));
  assert.ok(q.some(v=>v.query.includes('custom bakers')));assert.ok(q.every(v=>!v.query.includes('maps.google')));
});
test('initial queries include directory discovery and social-order signals without claiming website absence',()=>{
  const q=discoveryQueries({niche:'Mobile auto detailers, custom bakers and event decorators; photo-rich independent no-site businesses',area:'Houston city limits'});
  assert.equal(q[0].family,'local_listing');assert.match(q[1].query,/"DM to order"/);assert.match(q[2].query,/"DM to book"/);
  assert.ok(q.some(v=>v.family==='local_listing'&&v.query.includes('directory')));
  for(const item of q){assert.ok(item.query.includes('Houston Texas'));assert.ok(!item.query.includes('no website'),'A search phrase must not pretend to establish website absence');}
  assert.ok(q.every(v=>!v.query.endsWith('public business services')));
});
test('completion capacity is frozen, conservative and fails closed on missing totals or expired time',()=>{
  const acquisition=acquisitionPolicy(),b={acquisition,settings:{maxSearches:16,maxInspections:48,maxImageViews:12,maxModelRequests:16},usage:{searches:6,inspections:14,imageViews:0,modelRequests:2},deadlineAt:new Date(Date.now()+90*60000).toISOString()};
  assert.equal(completionCapacity(b).available,true);assert.equal(acquisition.version,1);
  for(const [unit,cap] of [['searches','maxSearches'],['inspections','maxInspections'],['imageViews','maxImageViews'],['modelRequests','maxModelRequests']]){
    const x=structuredClone(b);x.usage[unit]=x.settings[cap]-acquisition.reserve[unit]+1;
    assert.equal(completionCapacity(x).available,false,unit);
  }
  assert.equal(completionCapacity({...b,deadlineAt:'2020-01-01'}).available,false);
  assert.equal(completionCapacity({...b,usage:{}}).available,false);
  assert.equal(completionCapacity({...b,acquisition:null}).available,true,'Legacy behavior does not silently adopt new floors');
});
