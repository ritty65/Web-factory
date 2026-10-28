import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateInput} from '../src/contracts.mjs';
import {potentialWebsiteTargets} from '../src/intake.mjs';
import {assessProspect} from '../src/prospects.mjs';
import {intakeFixture} from './helpers-batch.mjs';

const handle='juniper.test.company',profile=`https://www.instagram.com/${handle}/`;
function fixture() {
  const f=JSON.parse(JSON.stringify(intakeFixture()).replaceAll('https://www.instagram.com/juniper1/',profile));
  const o=f.observations[0];o.evidenceContextVersion=1;o.method='fresh_guest_rendered_dom';
  o.text=`Log In\nSign Up\n${handle}\n843 followers\n290 following\n${o.text}\nShow more posts from ${handle}\nSee photos, videos and more from ${handle}\nSign up and never miss a post from ${handle}.`;
  f.candidate.websiteCheck.status='unknown';f.candidate.websiteCheck.queries=[];f.candidate.media=[];
  delete f.candidate.activityEvidence;delete f.candidate.pagePurposes;return f;
}
const targets=f=>potentialWebsiteTargets(candidateInput(f.candidate),f.observations[0],f.observations,{includeText:true});
test('exact observed Instagram account UI is not a website just because the username contains dots',()=>{
  const f=fixture(),before=JSON.stringify(f),p=assessProspect(candidateInput(f.candidate),f);
  assert.deepEqual(targets(f),[]);assert.equal(p.screening.status,'clear_for_enrichment');
  assert.equal(p.state,'held');assert.equal(p.websiteStatus,'unknown');assert.equal(p.screening.fullQualification,false);
  assert.equal(JSON.stringify(f),before,'Interpreting UI text must never change retained evidence or publish contacts');
});
for(const line of [`Website: ${handle}`,`https://${handle}/`,`www.${handle}`,`${handle}/book`,handle,'another.business.company'])test(`a real or ambiguous bio domain is still inspected: ${line}`,()=>{
  const f=fixture();f.observations[0].text=f.observations[0].text.replace('290 following\n',`290 following\n${line}\n`);
  assert.ok(targets(f).length>0);assert.equal(assessProspect(candidateInput(f.candidate),f).screening.status,'needs_verification');
});
for(const wrapped of [false,true])test(`an actual ${wrapped?'wrapped':'direct'} link cannot be hidden by matching the account's dotted username`,()=>{
  const f=fixture(),url=`https://${handle}/`;
  f.observations[0].links.push({url:wrapped?'https://l.instagram.com/?u='+encodeURIComponent(url):url,text:handle});
  assert.equal(targets(f)[0]?.url,url);assert.equal(assessProspect(candidateInput(f.candidate),f).screening.status,'needs_verification');
});
for(const [label,change] of [
  ['legacy context',f=>{delete f.observations[0].evidenceContextVersion;}],
  ['static reader',f=>{f.observations[0].method='static_https_no_script';}],
  ['unmatched profile',f=>{f.observations[0].url='https://www.instagram.com/another.account/';}],
  ['conflicting final URL',f=>{f.observations[0].finalUrl='https://www.instagram.com/another.account/';}],
  ['unobserved counter context',f=>{f.observations[0].text=f.observations[0].text.replace('843 followers\n290 following','An ordinary bio sentence');}],
])test(`account-text exemption requires exact observed profile context: ${label}`,()=>{
  const f=fixture();change(f);assert.ok(targets(f).some(t=>t.url===`https://${handle}/`));
});
test('account UI handling is not available on hubs or arbitrary sites',()=>{
  const f=fixture();f.observations[0].url='https://linktr.ee/juniper';
  assert.ok(targets(f).some(t=>t.url===`https://${handle}/`));
});
for(const [label,change] of [
  ['stale',f=>{f.observations[0].inspectedAt='2020-01-01T00:00:00.000Z';}],
  ['blocked',f=>{f.observations[0].blocked=true;}],
])test(`dotted account handling cannot clear ${label} source evidence through screening`,()=>{
  const f=fixture();change(f);const p=assessProspect(candidateInput(f.candidate),f);
  assert.equal(p.screening.status,'needs_verification');assert.equal(p.state,'held');assert.equal(p.identityObserved,false);
});
