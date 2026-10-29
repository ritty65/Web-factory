import test from 'node:test';
import assert from 'node:assert/strict';
import {assessDestinations} from '../src/destinations.mjs';
import {candidateInput,now} from '../src/contracts.mjs';
import {assessIntake,potentialWebsiteTargets} from '../src/intake.mjs';
import {assessScreening} from '../src/screening.mjs';
import {intakeFixture} from './helpers-batch.mjs';

function link(f,source,url,status='official',finalUrl=url){
  source.links.push({url,text:'Business route'});
  const o={id:`source-route-${f.observations.length}`,url,finalUrl,inspectedAt:now(),blocked:false,text:'Synthetic destination without hidden links',links:[],images:[]};
  f.observations.push(o);f.candidate.websiteCheck.linkChecks.push({url,sourceId:o.id,status,reason:'Synthetic inspected route'});return o;
}
function graph(f){
  const c=candidateInput(f.candidate),roots=[f.observations[0]];
  return assessDestinations({roots,observations:f.observations,linkChecks:c.websiteCheck.linkChecks,targetsForSource:o=>potentialWebsiteTargets(c,o,roots,{includeText:true})});
}
test('early and full intake share transparent observed official hubs without bypassing the other full gates',()=>{
  const f=intakeFixture(),a=link(f,f.observations[0],'https://linktr.ee/juniper'),b=link(f,a,'https://beacons.ai/juniper');
  link(f,b,'https://directory.example/juniper','unofficial');
  const c=candidateInput(f.candidate);
  assert.equal(graph(f).status,'clear');assert.equal(assessScreening(c,f).status,'clear_for_enrichment');
  assert.equal(assessIntake(c,f).ready,true,assessIntake(c,f).reasons.join('\n'));
  delete f.candidate.activityEvidence;
  assert.equal(assessIntake(candidateInput(f.candidate),f).ready,false);
});
test('a nested official business domain excludes consistently at both stages',()=>{
  const f=intakeFixture(),hub=link(f,f.observations[0],'https://linktr.ee/juniper');link(f,hub,'https://business.example/');
  assert.equal(graph(f).status,'official');assert.equal(assessScreening(candidateInput(f.candidate),f).status,'excluded');
  assert.equal(assessIntake(candidateInput(f.candidate),f).ready,false);
});
test('a booking destination after a hub redirect remains separately unsupported',()=>{
  const f=intakeFixture();link(f,f.observations[0],'https://linktr.ee/juniper','official','https://booksy.com/juniper');
  assert.equal(graph(f).status,'booking_only');assert.equal(assessIntake(candidateInput(f.candidate),f).ready,false);
});
test('redirected hub self-links match both requested and final URLs without hiding a different destination',()=>{
  const f=intakeFixture(),hub=link(f,f.observations[0],'https://short.example/juniper','official','https://linktr.ee/juniper');
  hub.links=[{url:hub.url},{url:hub.finalUrl}];assert.equal(graph(f).status,'clear');
  hub.links.push({url:'https://linktr.ee/someone-else'});assert.equal(graph(f).status,'unresolved');
});
test('a genuine redirected multi-hop cycle remains unresolved',()=>{
  const f=intakeFixture(),a=link(f,f.observations[0],'https://short.example/juniper','official','https://linktr.ee/juniper'),b=link(f,a,'https://beacons.ai/juniper');
  b.links.push({url:a.finalUrl});const result=graph(f);assert.equal(result.status,'unresolved');assert.ok(result.unresolved.some(v=>v.reason==='cycle'));
});
test('a third hub hop is held even when every leaf was inspected',()=>{
  const f=intakeFixture(),a=link(f,f.observations[0],'https://linktr.ee/juniper'),b=link(f,a,'https://beacons.ai/juniper'),c=link(f,b,'https://bio.site/juniper');
  link(f,c,'https://directory.example/juniper','unofficial');const result=graph(f);
  assert.equal(result.status,'unresolved');assert.ok(result.unresolved.some(v=>v.reason==='depth'));
});
for(const mode of ['missing','blocked','stale','wrong-id','unclassified'])test(`route proof cannot clear ${mode} evidence`,()=>{
  const f=intakeFixture(),o=link(f,f.observations[0],'https://business.example/','unofficial');
  if(mode==='missing')f.observations.pop();if(mode==='blocked')o.blocked=true;if(mode==='stale')o.inspectedAt='2020-01-01';
  if(mode==='wrong-id')f.candidate.websiteCheck.linkChecks[0].sourceId='source-unrelated';
  if(mode==='unclassified')f.candidate.websiteCheck.linkChecks[0].status='unresolved';
  assert.equal(graph(f).status,'unresolved');assert.equal(assessIntake(candidateInput(f.candidate),f).ready,false);
});
test('body-text domains cannot evade full intake when there is no href',()=>{
  const f=intakeFixture();f.observations[0].text+=' Website: juniper.my.canva.site';
  assert.equal(graph(f).status,'unresolved');assert.equal(assessIntake(candidateInput(f.candidate),f).ready,false);
});
test('a later contradictory official finding cannot hide behind an earlier unofficial claim',()=>{
  const f=intakeFixture(),o=link(f,f.observations[0],'https://business.example/','unofficial');
  f.candidate.websiteCheck.linkChecks.push({url:o.url,sourceId:o.id,status:'official',reason:'Synthetic official counterevidence'});
  assert.equal(graph(f).status,'official');
});
test('an observed Threads profile is a transparent social hub, not a website exclusion or a way to conceal its bio website',()=>{
  const f=intakeFixture(),profile=link(f,f.observations[0],'https://www.threads.com/@juniper','not_business');
  profile.links=[{url:'https://business.example/',text:'Our website'}];assert.equal(graph(f).status,'unresolved');
  link(f,profile,'https://business.example/','official');assert.equal(graph(f).status,'official');
});
test('Threads profile classification never exempts a lookalike host or arbitrary route',()=>{
  for(const url of ['https://threads.com.attacker.example/@juniper','https://threads.com/unrecognised-route']){
    const f=intakeFixture();link(f,f.observations[0],url,'official');assert.equal(graph(f).status,'official');
  }
});
test('shared checked hubs are not cycles and assessment never mutates retained inputs',()=>{
  const f=intakeFixture(),hub=link(f,f.observations[0],'https://linktr.ee/juniper');
  const before=JSON.stringify(f),c=candidateInput(f.candidate);
  const r=assessDestinations({roots:[f.observations[0],f.observations[0]],observations:f.observations,linkChecks:c.websiteCheck.linkChecks,targetsForSource:o=>potentialWebsiteTargets(c,o,[f.observations[0]],{includeText:true})});
  assert.equal(r.status,'clear');assert.equal(r.checked,1);assert.equal(JSON.stringify(f),before);assert.equal(hub.links.length,0);
});
