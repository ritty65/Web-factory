import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateInput, now } from '../src/contracts.mjs';
import { assessProspect } from '../src/prospects.mjs';
import { intakeFixture } from './helpers-batch.mjs';

function light() {
  const f = intakeFixture();
  f.candidate.websiteCheck = {status:'unknown',queries:[],checkedAt:now(),linkChecks:[]};
  delete f.candidate.media; delete f.candidate.pagePurposes; delete f.candidate.activityEvidence;
  f.imageViews = []; return f;
}
const screen = f => assessProspect(candidateInput(f.candidate),f).screening;
function outbound(f,url,status='unofficial',sourceId='source-preflight-link') {
  f.observations[0].links.push({url,text:'Business link'});
  f.observations.push({id:sourceId,url,inspectedAt:now(),blocked:false,text:f.candidate.name+' source page',links:[]});
  f.candidate.websiteCheck.linkChecks.push({url,sourceId,status,reason:'Synthetic observed destination'});
  return f.observations.at(-1);
}
test('cheap screening can clear enrichment without claiming website absence, activity, photographs or five-page readiness',()=>{
  const f=light(),p=assessProspect(candidateInput(f.candidate),f);
  assert.equal(p.screening.status,'clear_for_enrichment');
  assert.equal(p.screening.geography,'supported');
  assert.equal(p.websiteStatus,'unknown');assert.equal(p.state,'held');assert.equal(p.photoEvidence.selected,0);
  assert.equal(p.screening.fullQualification,false);
});
test('a fresh source-only original profile can support cheap screening without fabricating a published contact or full intake',()=>{
  const f=light();f.candidate.contacts={};f.candidate.contactSources={};
  const p=assessProspect(candidateInput(f.candidate),f);
  assert.equal(p.screening.status,'clear_for_enrichment');assert.deepEqual(p.contacts,[]);assert.equal(p.state,'held');
});
test('two inspected identity-matched profiles sharing the same checked hub are not a recursive cycle',()=>{
  const f=light();outbound(f,'https://beacons.ai/juniper');
  const second=structuredClone(f.observations[0]);second.id='source-preflight-second';second.url='https://www.facebook.com/juniper1/';
  f.candidate.contacts.facebook=second.url;f.candidate.contactSources.facebook=second.url;f.candidate.inspectionIds.push(second.id);f.observations.push(second);
  assert.equal(screen(f).status,'clear_for_enrichment');
});
test('a different business route on the same hub host is not a domain-wide navigation exemption',()=>{
  const f=light(),hub=outbound(f,'https://beacons.ai/juniper');hub.links=[{url:'https://beacons.ai/another-business',text:'Website'}];
  assert.equal(screen(f).status,'needs_verification');
});
test('plain-text URL deduplication retains an inspected wrapper alias rather than discarding its proof',()=>{
  const f=light(),url='https://business.example/',wrapper='https://l.instagram.com/?u='+encodeURIComponent(url);
  f.observations[0].links.push({url:wrapper,text:'Our listing'});f.observations[0].text+=' Website: business.example';
  f.observations.push({id:'source-wrapper-proof',url,inspectedAt:now(),blocked:false,text:'An independent directory, not a business website',links:[]});
  f.candidate.websiteCheck.linkChecks.push({url:wrapper,sourceId:'source-wrapper-proof',status:'unofficial',reason:'Actually inspected directory'});
  assert.equal(screen(f).status,'clear_for_enrichment');
});
for(const [label,change] of [
  ['missing observations',f=>{f.observations=[];}],
  ['stale observation',f=>{f.observations[0].inspectedAt='2020-01-01';}],
  ['blocked observation',f=>{f.observations[0].blocked=true;}],
  ['unbound observation',f=>{f.candidate.inspectionIds=[];}],
  ['unmatched account',f=>{f.observations[0].url='https://www.instagram.com/unrelated/';}],
])test(`early screening holds ${label}`,()=>{const f=light();change(f);assert.equal(screen(f).status,'needs_verification');});
test('a Houston business name alone is not an observed location/service-area claim',()=>{
  const f=light();f.candidate.name='Houston Juniper';
  f.candidate.facts=f.candidate.facts.map(x=>({...x,text:'Houston Juniper',excerpt:'Houston Juniper'}));
  f.observations[0].title='Houston Juniper';f.observations[0].text='Houston Juniper. '+ 'Synthetic details without a location. '.repeat(10);
  assert.equal(screen(f).geography,'unknown');assert.equal(screen(f).status,'needs_verification');
});
test('a source-backed Katy base is a visible city-scope conflict, not quietly broadened Houston eligibility',()=>{
  const f=light(),text='Based in Katy, Texas. Serving Houston.';
  f.observations[0].text+=' '+text;f.candidate.facts.push({text,excerpt:text,sourceUrl:f.observations[0].url});
  assert.equal(screen(f).geography,'conflict');assert.equal(screen(f).status,'needs_verification');
});
test('non-Houston base wording is not restricted to a handpicked list of nearby suburbs',()=>{
  const f=light();f.observations[0].text+=' Based in Austin. Serving Houston.';
  assert.equal(screen(f).geography,'conflict');
});
test('merely serving Katy is not the same as being based there',()=>{
  const f=light();f.observations[0].text+=' Serving Houston and Katy, Texas.';
  assert.equal(screen(f).geography,'supported');
});
test('a link-hub page with a plain-text builder domain still needs inspection and cannot retain a positive absence label',()=>{
  const f=light(),hub=outbound(f,'https://beacons.ai/juniper');hub.text+=' Our website: juniper.my.canva.site';
  f.candidate.websiteCheck.status='no_official_site_found';f.candidate.websiteCheck.queries=f.searches.map(s=>s.query);
  assert.equal(screen(f).status,'needs_verification');assert.equal(assessProspect(candidateInput(f.candidate),f).websiteStatus,'unknown');
});
test('an actual unresolved outbound destination holds even when website status is honestly unknown',()=>{
  const f=light();f.observations[0].links.push({url:'https://business.example/',text:'Our site'});
  assert.equal(screen(f).status,'needs_verification');assert.ok(screen(f).reasons.some(r=>/outbound/i.test(r)));
});
test('an unlinked builder domain printed in the observed bio cannot evade early screening',()=>{
  const f=light();f.observations[0].text+='\nOur website: juniper.my.canva.site';
  assert.equal(screen(f).status,'needs_verification');
});
for(const domain of ['juniper.design','juniper.us','juniper.company','juniper.photography','juniper.xn--p1ai'])test(`complete plain-text domain ${domain} cannot evade screening or be truncated`,()=>{
  const f=light();f.observations[0].text+=' Website: '+domain;
  f.observations.push({id:'source-truncated-domain',url:'https://juniper.com/',inspectedAt:now(),blocked:false,text:'Unrelated independent listing',links:[]});
  f.candidate.websiteCheck.linkChecks.push({url:'https://juniper.com/',sourceId:'source-truncated-domain',status:'unofficial',reason:'Not the mentioned domain'});
  assert.equal(screen(f).status,'needs_verification');
});
for(const phrase of ['Katy-based event decorator.','Based out of Katy.','Located in Austin.'])test(`explicit outside-base wording holds: ${phrase}`,()=>{
  const f=light();f.observations[0].text+=' '+phrase+' Serving Houston.';
  assert.equal(screen(f).status,'needs_verification');assert.equal(screen(f).geography,'conflict');
});
test('Houston-based and home-based wording do not become false outside-city claims',()=>{
  const f=light();f.observations[0].text+=' We are Houston-based. A home-based workshop serving Houston.';
  assert.equal(screen(f).status,'clear_for_enrichment');
});
test('a link hub is inspected through its actual business destinations, not counted as absence by itself',()=>{
  const f=light(),hub=outbound(f,'https://beacons.ai/juniper');
  hub.links=[{url:'https://business.example/',text:'Our website'}];
  assert.equal(screen(f).status,'needs_verification');
  f.observations.push({id:'source-preflight-site',url:'https://business.example/',inspectedAt:now(),blocked:false,text:f.candidate.name+' official website',links:[]});
  f.candidate.websiteCheck.linkChecks.push({url:'https://business.example/',sourceId:'source-preflight-site',status:'official',reason:'Identity matched official website'});
  assert.equal(screen(f).status,'excluded');
  assert.equal(assessProspect(candidateInput(f.candidate),f).websiteStatus,'independent_official_site');
});
for(const domain of ['linktr.ee','beacons.ai','bio.site','lnk.bio','campsite.bio','hoo.be'])test(`an official business link hub on ${domain} is not itself an independent-site exclusion or absence proof`,()=>{
  const f=light(),hub=outbound(f,`https://${domain}/juniper`,'official');hub.links=[{url:'https://unresolved-business.example/',text:'Our site'}];
  const p=assessProspect(candidateInput(f.candidate),f);assert.equal(p.screening.status,'needs_verification');
  assert.equal(p.websiteStatus,'unknown');assert.equal(p.state,'held');assert.equal(p.screening.unresolvedDestinations,1);
});
test('a model official-site status naming only an inspected hub cannot bypass the same host-bound hub classification',()=>{
  const f=light(),url='https://linktr.ee/juniper',hub=outbound(f,url,'official');hub.links=[{url:'https://unresolved-business.example/',text:'Our website'}];
  f.candidate.websiteCheck.status='official_site_found';f.candidate.websiteCheck.url=url;f.candidate.inspectionIds.push(hub.id);
  const p=assessProspect(candidateInput(f.candidate),f);assert.equal(p.websiteStatus,'unknown');assert.equal(p.state,'held');
});
test('link-hub names are not a substring or arbitrary-host exclusion exemption',()=>{
  const f=light();outbound(f,'https://linktr.ee.other-business.example/juniper','official');
  assert.equal(assessProspect(candidateInput(f.candidate),f).websiteStatus,'independent_official_site');
});
test('an inspected redirect to a link hub follows hub evidence rather than manufacturing an independent-site exclusion',()=>{
  const f=light(),url='https://business.example/',o=outbound(f,url,'official');o.finalUrl='https://linktr.ee/juniper';o.links=[{url:'https://unresolved-business.example/',text:'Our site'}];
  f.candidate.websiteCheck.status='official_site_found';f.candidate.websiteCheck.url=url;f.candidate.inspectionIds.push(o.id);
  const p=assessProspect(candidateInput(f.candidate),f);assert.equal(p.screening.status,'needs_verification');assert.equal(p.websiteStatus,'unknown');assert.equal(p.state,'held');
});
test('a hub route that actually redirects to a verified official business site still excludes',()=>{
  const f=light(),o=outbound(f,'https://linktr.ee/juniper','official');o.finalUrl='https://business.example/';
  const p=assessProspect(candidateInput(f.candidate),f);assert.equal(p.screening.status,'excluded');assert.equal(p.websiteStatus,'independent_official_site');
});
test('an inspected redirect to a booking platform remains in the unsupported booking segment',()=>{
  const f=light(),o=outbound(f,'https://business.example/','official');o.finalUrl='https://booksy.com/en-us/juniper';
  const p=assessProspect(candidateInput(f.candidate),f);assert.equal(p.screening.status,'booking_only');assert.equal(p.websiteStatus,'booking_only');assert.ok(p.buildUnsupported);
});
for(const [label,change] of [
  ['blocked',o=>{o.blocked=true;}],['stale',o=>{o.inspectedAt='2020-01-01';}],['wrong URL',o=>{o.url='https://unrelated.example/';}],
])test(`a claimed official finding with ${label} source proof cannot become a verified exclusion`,()=>{
  const f=light(),o=outbound(f,'https://business.example/','official');change(o);
  assert.equal(screen(f).status,'needs_verification');
});
test('a checked booking destination stays separately unsupported, never a no-site loophole',()=>{
  const f=light();outbound(f,'https://booksy.com/en-us/juniper','official');
  assert.equal(screen(f).status,'booking_only');assert.ok(assessProspect(candidateInput(f.candidate),f).buildUnsupported);
});
test('model-supplied screening approval and unrelated unlinked findings cannot bypass the host screen',()=>{
  const f=light();f.candidate.screening={status:'clear_for_enrichment'};f.candidate.inspectionIds=[];
  assert.equal(screen(f).status,'needs_verification');
});
function serviceDescription(description,name='Synthetic Touch Above Decor') {
  const f=light();f.candidate.name=name;f.candidate.facts=[{text:'Observed service description',excerpt:description,sourceUrl:f.observations[0].url}];
  f.observations[0].title=name;f.observations[0].text=name+'\n'+description+'\n'+'Synthetic source evidence without an extra city claim. '.repeat(7);return f;
}
for(const label of ['📍Houston| Texas','📍 Houston | TX'])test(`an exact first-party location-marker label supports cheap geography: ${label}`,()=>{
  const f=serviceDescription(label),p=assessProspect(candidateInput(f.candidate),f);
  assert.equal(p.screening.geography,'supported');assert.equal(p.screening.status,'clear_for_enrichment');assert.equal(p.websiteStatus,'unknown');assert.equal(p.state,'held');
});
for(const line of ['Not 📍Houston| Texas','Looking for 📍Houston| Texas','“📍Houston| Texas”','📍Houston| Texas is a customer quote'])test(`location-label substring cannot discard the retained source-line context: ${line}`,()=>{
  const f=serviceDescription(line);f.candidate.facts[0].excerpt='📍Houston| Texas';
  assert.equal(screen(f).geography,'unknown');assert.equal(screen(f).status,'needs_verification');
});
test('location-marker support still needs bound fresh first-party evidence and cannot defeat an outside base',()=>{
  for(const change of [f=>{f.candidate.inspectionIds=[];},f=>{f.candidate.facts[0].sourceUrl='https://www.instagram.com/unrelated/';},f=>{f.observations[0].blocked=true;},f=>{f.observations[0].inspectedAt='2020-01-01';},f=>{f.observations[0].text+='\nBased in Katy.';}]){
    const f=serviceDescription('📍Houston| Texas');change(f);assert.equal(screen(f).status,'needs_verification');
  }
  assert.equal(screen(serviceDescription('📍Houston| Texas','📍Houston| Texas')).geography,'unknown','A business name alone is not its own location proof');
});
test('an actual first-party Houston service-description sentence clears cheap geography, not full design qualification',()=>{
  const f=serviceDescription('Houston event and party planner for all occasions.\nCreating memorable events for your special day.');
  const p=assessProspect(candidateInput(f.candidate),f);assert.equal(p.screening.geography,'supported');assert.equal(p.screening.status,'clear_for_enrichment');assert.equal(p.state,'held');assert.equal(p.screening.fullQualification,false);
});
for(const description of ['Houston mobile auto detailer for busy drivers.','Houston custom baker specializing in celebration cakes.'])test(`literal service bio is not rejected by a preposition-only matcher: ${description}`,()=>{
  assert.equal(screen(serviceDescription(description)).geography,'supported');
});
for(const description of ['#HoustonEventPlanner #HoustonBaker','Houston Event Planner','Looking for a Houston event planner for all occasions.','Not a Houston event planner for all occasions.','Houston is not a party planner for all occasions.','Houston former event planner for all occasions.','“Houston event and party planner for all occasions.”'])test(`an ambiguous name, hashtag, request, negation or quotation stays held: ${description}`,()=>{
  assert.equal(screen(serviceDescription(description)).geography,'unknown');
});
test('a service-like business name alone cannot become its own new geography proof',()=>{
  const phrase='Houston event and party planner for all occasions';assert.equal(screen(serviceDescription(phrase,phrase)).geography,'unknown');
  assert.equal(screen(serviceDescription(phrase,'Premier '+phrase)).geography,'unknown','An excerpt cut from a longer business name is not a separate service claim');
});
test('new service wording does not bypass missing identity, wrong source binding, or an outside-city base',()=>{
  for(const change of [f=>{f.candidate.inspectionIds=[];},f=>{f.candidate.facts[0].sourceUrl='https://www.instagram.com/unrelated/';},f=>{f.observations[0].text+='\nBased in Katy. Serving Houston.';}]){
    const f=serviceDescription('Houston event and party planner for all occasions.');change(f);assert.equal(screen(f).status,'needs_verification');
  }
});
for(const sourceLine of ['Not a Houston event and party planner for all occasions.','Looking for a Houston event and party planner for all occasions.','“Houston event and party planner for all occasions.”'])test(`positive substring cannot discard the actual source sentence context: ${sourceLine}`,()=>{
  const f=serviceDescription(sourceLine);f.candidate.facts[0].excerpt='Houston event and party planner for all occasions.';
  assert.equal(screen(f).geography,'unknown');assert.equal(screen(f).status,'needs_verification');
});
for(const line of ['We come to you! We service the entire Houston area.','We service the entire Houston area.'])test(`an explicit first-party service-area sentence supports cheap triage only: ${line}`,()=>{
  const f=serviceDescription(line),p=assessProspect(candidateInput(f.candidate),f);
  assert.equal(p.screening.geography,'supported');assert.equal(p.screening.fullQualification,false);assert.equal(p.state,'held');assert.equal(p.websiteStatus,'unknown');
});
test('service-area sentence recognition retains the complete observed source line, not a trimmed request, negation or quote',()=>{
  const positive='We service the entire Houston area.';
  for(const line of ['Not: '+positive,'Looking for someone who says '+positive,'“'+positive+'”','Customer quote: '+positive,positive+' is not what we offer.']){
    const f=serviceDescription(line);f.candidate.facts[0].excerpt=positive;
    assert.equal(screen(f).geography,'unknown',line);
  }
});
test('service-area support still rejects unbound, blocked, stale, wrong-account and outside-base evidence',()=>{
  for(const change of [f=>{f.candidate.inspectionIds=[];},f=>{f.observations[0].blocked=true;},f=>{f.observations[0].inspectedAt='2020-01-01';},f=>{f.candidate.facts[0].sourceUrl='https://www.instagram.com/unrelated/';},f=>{f.observations[0].text+='\nBased in Katy, Texas.';}]){
    const f=serviceDescription('We come to you! We service the entire Houston area.');change(f);assert.equal(screen(f).status,'needs_verification');
  }
});
