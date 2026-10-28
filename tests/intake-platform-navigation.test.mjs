import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateInput,now } from '../src/contracts.mjs';
import { assessIntake } from '../src/intake.mjs';
import { intakeFixture } from './helpers-batch.mjs';

const gate = f => assessIntake(candidateInput(f.candidate), f);
const outbound = result => result.reasons.some(reason => reason.startsWith('A possible outbound official'));
const navigation = [
  { url: 'https://about.meta.com/', text: 'Meta' },
  { url: 'https://www.meta.ai/', text: 'Meta AI' },
  { url: 'https://www.threads.com/', text: 'Threads' },
  { url: 'https://www.threads.net/', text: 'Threads' },
];

test('known exact social-platform navigation is not a business website finding', () => {
  const f = intakeFixture(); f.observations[0].links.push(...navigation);
  assert.equal(gate(f).ready, true, gate(f).reasons.join('\n'));
});

test('navigation is not a domain-wide, label-only or redirect exemption', () => {
  for (const link of [
    { url: 'https://www.threads.com/@juniper', text: 'Threads' },
    { url: 'https://www.meta.ai/business/juniper', text: 'Meta AI' },
    { url: 'https://about.meta.com/redirect?url=https%3A%2F%2Fjuniper.example', text: 'Meta' },
    { url: 'https://www.threads.com/?url=https%3A%2F%2Fjuniper.example', text: 'Threads' },
    { url: 'https://about.meta.com/', text: 'Our website' },
    { url: 'https://about.meta.com.evil.example/', text: 'Meta' },
    { url: 'https://linktr.ee/juniper', text: 'Threads' },
    { url: 'https://juniper.example/', text: 'Meta' },
    { url: 'https://muse.ai/', text: 'Muse' },
    { url: 'https://l.instagram.com/?u=https%3A%2F%2Fwww.threads.com%2F', text: 'Threads' },
  ]) {
    const f = intakeFixture(); f.observations[0].links.push(link);
    assert.equal(outbound(gate(f)), true, JSON.stringify(link));
  }
});

test('platform navigation never establishes website absence or clears missing evidence', () => {
  const f = intakeFixture(); f.observations[0].links.push(...navigation);
  f.candidate.websiteCheck.status = 'unknown';
  f.candidate.activityEvidence.excerpt = 'Unobserved activity assertion';
  f.candidate.pagePurposes = []; f.candidate.media = [];
  const result = gate(f);
  assert.equal(result.ready, false);
  assert.equal(outbound(result), false);
  for (const fragment of ['Website absence', 'Recent activity', 'Five distinct', 'photography is missing']) assert.ok(result.reasons.some(reason => reason.includes(fragment)), fragment);
});

test('a real unresolved bio website still blocks alongside known platform navigation', () => {
  const f = intakeFixture(); f.observations[0].links.push(...navigation, { url: 'https://booksy.com/en-us/juniper', text: 'Book' });
  assert.equal(outbound(gate(f)), true);
});

test('versioned structural platform-footer evidence can classify an unfamiliar footer link, but never a bio link or inferred legacy context', () => {
  const f = intakeFixture(), o = f.observations[0];
  o.evidenceContextVersion = 1; o.method = 'fresh_guest_rendered_dom';
  o.links.push({url:'https://muse.ai/',text:'Muse',region:'platform_footer'});
  assert.equal(gate(f).ready, true);
  delete o.evidenceContextVersion; assert.equal(outbound(gate(f)), true);
  o.evidenceContextVersion = 1; delete o.links.at(-1).region; assert.equal(outbound(gate(f)), true);
  o.links.at(-1).region = 'platform_footer'; o.method = 'static_https_no_script'; assert.equal(outbound(gate(f)), true);
});

function threadsFixture(){
  const f=intakeFixture(),url='https://www.threads.com/@juniper?xmt=fixture';
  f.observations[0].links.push({url,text:'Our Threads profile'});
  const o={id:'source-threads-nav',url,finalUrl:url,inspectedAt:now(),blocked:false,evidenceContextVersion:1,method:'fresh_guest_rendered_dom',text:'Juniper public Threads profile. No threads yet.',links:[],images:[]};
  f.observations.push(o);f.candidate.websiteCheck.linkChecks.push({url,sourceId:o.id,status:'unofficial',reason:'Observed social profile, not an independent website'});return {f,o};
}
test('an inspected Threads profile does not turn exact platform UI and its own account tabs into eight business-site questions',()=>{
  const {f,o}=threadsFixture();o.links=[{url:'https://www.threads.com/',text:'Home'},{url:'https://www.threads.com/search',text:''},{url:'https://www.threads.com/login',text:'Log in'},{url:'https://www.threads.com/login?show_choice_screen=false',text:'Log in'}];
  for(const suffix of ['', '/replies','/media','/reposts'])o.links.push({url:'https://www.threads.com/@juniper'+suffix,text:'Threads'});
  o.links.push({url:'https://l.threads.com/?u='+encodeURIComponent('https://www.facebook.com/privacy/policy/')+'&e=fixture',text:'Privacy Policy'});
  assert.equal(gate(f).ready,true,gate(f).reasons.join('\n'));
});
test('Threads platform UI never exempts another account, business destination, semantic query, unsafe wrapper or unproved context',()=>{
  for(const link of [{url:'https://www.threads.com/@another',text:'Threads'},{url:'https://www.threads.com/@juniper/post/other',text:'Threads'},{url:'https://business.example/',text:'Home'},{url:'https://www.threads.com/login?next=https%3A%2F%2Fbusiness.example',text:'Log in'},{url:'https://www.threads.com/@juniper?xmt=fixture&target=business',text:'Threads'},{url:'https://www.threads.com.evil.example/search',text:''},{url:'https://l.threads.com/?u='+encodeURIComponent('https://business.example/')+'&e=fixture',text:'Privacy Policy'},{url:'https://l.threads.com/?u='+encodeURIComponent('https://www.facebook.com/privacy/policy/')+'&u='+encodeURIComponent('https://business.example/'),text:'Privacy Policy'}]){
    const {f,o}=threadsFixture();o.links=[link];assert.equal(outbound(gate(f)),true,link.url);
  }
  for(const change of [o=>{delete o.evidenceContextVersion;},o=>{o.method='static_https_no_script';},o=>{o.blocked=true;},o=>{o.inspectedAt='2020-01-01';},o=>{o.finalUrl='https://www.threads.com/@another';}]){
    const {f,o}=threadsFixture();o.links=[{url:'https://www.threads.com/search',text:''}];change(o);assert.equal(outbound(gate(f)),true);
  }
});

test('an observed Threads profile treats only its exact post and named login controls as navigation',()=>{
  const {f,o}=threadsFixture();
  o.links=[
    {url:'https://www.threads.com/@juniper/post/Abc12345678',text:'10/05/26'},
    {url:'https://www.threads.com/@juniper/post/Abc12345678/media',text:''},
    {url:'https://www.threads.com/login?interaction_source=FOLLOW&show_choice_screen=false',text:'Follow'},
    {url:'https://www.threads.com/login?interaction_source=OTHER&show_choice_screen=false',text:'Mention'},
  ];
  assert.equal(outbound(gate(f)),false);
  f.candidate.websiteCheck.status='unknown';
  assert.equal(gate(f).ready,false,'Platform navigation is never website-absence evidence');
});

test('Threads post and login classification rejects mismatched accounts, arbitrary descendants and semantic queries',()=>{
  for(const link of [
    {url:'https://www.threads.com/@another/post/Abc12345678',text:'10/05/26'},
    {url:'https://www.threads.com/@juniper/post/Abc12345678/redirect',text:''},
    {url:'https://www.threads.com/@juniper/post/Abc12345678?next=https%3A%2F%2Fbusiness.example',text:'10/05/26'},
    {url:'https://www.threads.com/login?interaction_source=FOLLOW&show_choice_screen=false&next=https%3A%2F%2Fbusiness.example',text:'Follow'},
    {url:'https://www.threads.com/login?interaction_source=FOLLOW&show_choice_screen=false',text:'Our website'},
    {url:'https://www.threads.com/login?interaction_source=OTHER&show_choice_screen=false',text:'Follow'},
    {url:'https://www.threads.com/login?interaction_source=FOLLOW&interaction_source=FOLLOW&show_choice_screen=false',text:'Follow'},
  ]){
    const {f,o}=threadsFixture();o.links=[link];assert.equal(outbound(gate(f)),true,link.url);
  }
});
