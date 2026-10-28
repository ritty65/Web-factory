import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateInput,now,hash} from '../src/contracts.mjs';
import {assessIntake} from '../src/intake.mjs';
import {assessScreening} from '../src/screening.mjs';
import {assessMaterial,discoveryQueries} from '../src/acquisition.mjs';
import {assessProspect} from '../src/prospects.mjs';
import {reconcileBatches} from '../src/batches.mjs';
import {getBatch} from '../src/batch-store.mjs';
import {intakeFixture} from './helpers-batch.mjs';
import {acquisitionFixture} from './helpers-acquisition.mjs';

function listingFixture(){
  const f=intakeFixture(),profile=f.observations[0],date=now().slice(0,10);
  f.candidate.facts[0]={text:'Repairs upholstered chairs.',excerpt:'Repairs upholstered chairs.',sourceUrl:profile.url};
  profile.text=profile.text.replace('Repairs upholstered chairs in Houston.','Repairs upholstered chairs.').replace(' Houston.','');
  profile.text+=' Business phone: (713) 555-0198.';
  const listing={id:'source-listing-fixture',url:'https://www.yelp.com/biz/juniper-1-upholstery-houston',title:`${f.candidate.name} - Houston, TX - Yelp`,
    text:`${f.candidate.name} 123 Main Street, Houston, TX 77002 Phone (713) 555-0198.`,inspectedAt:now(),blocked:false,method:'static_https_no_script',links:[],images:[]};
  listing.finalUrl=listing.url;f.observations.push(listing);f.candidate.inspectionIds.push(listing.id);f.candidate.sourceUrls.push(listing.url);
  f.candidate.facts.push({text:'Located at 123 Main Street, Houston, TX 77002.',excerpt:'123 Main Street, Houston, TX 77002',sourceUrl:listing.url});
  const image=profile.images[0];image.postUrl=f.candidate.media[0].postUrl;image.alt=`Photo by Juniper 1 Upholstery on ${date}`;
  profile.evidenceContextVersion=1;profile.method='fresh_guest_rendered_dom';profile.finalUrl=profile.url;
  f.candidate.activityEvidence={sourceId:profile.id,excerpt:image.alt,dateText:date,date,evidenceRef:{kind:'image_alt',sourceId:profile.id,imageId:image.id,postUrl:image.postUrl}};
  return {...f,profile,listing};
}

test('an identity-matched individual directory address and dated profile image metadata support intake without a post caption',()=>{
  const f=listingFixture(),c=candidateInput(f.candidate),screen=assessScreening(c,f),material=assessMaterial(c,f),intake=assessIntake(c,f);
  assert.equal(screen.geography,'supported');assert.equal(screen.status,'clear_for_enrichment');
  assert.equal(material.feasible,true);assert.equal(intake.ready,true,intake.reasons.join('\n'));
  assert.equal(intake.humanDecision,null);
});

for(const [name,mutate] of [
  ['wrong title',f=>{f.listing.title='Another Upholstery - Houston, TX - Yelp';}],
  ['different phone',f=>{f.listing.text=f.listing.text.replace('555-0198','555-0101');}],
  ['stale listing',f=>{f.listing.inspectedAt='2020-01-01';}],
  ['blocked listing',f=>{f.listing.blocked=true;}],
  ['unbound listing',f=>{f.candidate.inspectionIds.pop();}],
  ['search results rather than an individual listing',f=>{f.listing.url=f.listing.finalUrl='https://www.yelp.com/search?find_loc=Houston';f.candidate.facts.at(-1).sourceUrl=f.listing.url;}],
  ['redirect to another listing',f=>{f.listing.finalUrl='https://www.yelp.com/biz/someone-else';}],
  ['unmatched first-party profile',f=>{f.profile.title='Different business';f.profile.text='Unrelated profile. '.repeat(30);}]
])test(`directory evidence does not establish location with ${name}`,()=>{
  const f=listingFixture();mutate(f);const c=candidateInput(f.candidate);
  assert.notEqual(assessScreening(c,f).geography,'supported');assert.equal(assessIntake(c,f).ready,false);
});

test('a directory name or city mention without an actual street address does not establish location',()=>{
  const f=listingFixture();f.candidate.facts.at(-1).excerpt='Houston, TX';
  assert.notEqual(assessScreening(candidateInput(f.candidate),f).geography,'supported');
});

test('a repeated business heading after a real HTML title can bind the address',()=>{
  const f=listingFixture();f.listing.text=`${f.listing.title} Yelp navigation ${f.listing.text}`;
  assert.equal(assessScreening(candidateInput(f.candidate),f).geography,'supported');
});

test('a phone in unrelated listing-page content does not join the directory to the business',()=>{
  const f=listingFixture();f.listing.text=f.listing.text.replace('Phone (713) 555-0198.','More businesses and advertisements. Call (713) 555-0198.');
  assert.notEqual(assessScreening(candidateInput(f.candidate),f).geography,'supported');
});

test('a model cannot trim a negative location statement into a directory address',()=>{
  const f=listingFixture();f.listing.text=f.listing.text.replace('123 Main Street','Not located at 123 Main Street');
  assert.notEqual(assessScreening(candidateInput(f.candidate),f).geography,'supported');
});

test('a directory listing explicitly linked to the matched profile can bind identity without phone matching',()=>{
  const f=listingFixture();f.listing.text=f.listing.text.replace('(713) 555-0198','not published');f.listing.links.push({url:f.profile.url,text:'Instagram'});
  assert.equal(assessScreening(candidateInput(f.candidate),f).geography,'supported');
});

test('an uncorroborated listing cannot supply facts even if a profile independently establishes Houston',()=>{
  const f=listingFixture();f.profile.text+=' Located in Houston, TX.';
  f.candidate.facts.push({text:'Located in Houston, TX.',excerpt:'Located in Houston, TX.',sourceUrl:f.profile.url});
  f.listing.title='Different business - Houston, TX - Yelp';
  const c=candidateInput(f.candidate);assert.equal(assessScreening(c,f).geography,'supported');
  assert.equal(assessIntake(c,f).ready,false);
});

test('an unrelated listing review or invented paraphrase cannot become a supported business fact',()=>{
  const f=listingFixture();f.listing.text+=' Review from another customer: Award-winning service.';
  f.candidate.facts.push({text:'Award-winning service.',excerpt:'Award-winning service.',sourceUrl:f.listing.url});
  assert.equal(assessIntake(candidateInput(f.candidate),f).ready,false);
  f.candidate.facts.pop();f.candidate.facts.at(-1).text='Award-winning service located at 123 Main Street, Houston, TX 77002.';
  assert.equal(assessIntake(candidateInput(f.candidate),f).ready,false);
});

test('an observed listing website remains a hold or exclusion until actually checked',()=>{
  const f=listingFixture(),url='https://juniper-business.example/';f.listing.links.push({url,text:'Visit website'});
  assert.equal(assessScreening(candidateInput(f.candidate),f).status,'needs_verification');
  assert.equal(assessIntake(candidateInput(f.candidate),f).ready,false);
  f.observations.push({id:'source-listing-website',url,finalUrl:url,title:f.candidate.name,text:'Business website',inspectedAt:now(),blocked:false,links:[],images:[]});
  f.candidate.websiteCheck.linkChecks.push({url,sourceId:'source-listing-website',status:'official',reason:'Synthetic identity-matched business website'});
  assert.equal(assessScreening(candidateInput(f.candidate),f).status,'excluded');
  assert.equal(assessIntake(candidateInput(f.candidate),f).ready,false);
});

for(const link of [
  {url:'https://juniper-business.example/',text:'Our website'},
  {url:'https://juniper-business.example/',text:'View business'},
  {url:'https://www.yelp.com/biz_redir?url=https%3A%2F%2Fjuniper-business.example',text:''},
])test(`an ambiguously labelled directory destination is not ignored (${link.text||'redirect'})`,()=>{
  const f=listingFixture();f.listing.links.push(link);
  assert.notEqual(assessScreening(candidateInput(f.candidate),f).status,'clear_for_enrichment');
  assert.equal(assessIntake(candidateInput(f.candidate),f).ready,false);
});

test('listing-first discovery does not require a social order phrase or pretend that a search proves no website',()=>{
  const q=discoveryQueries({niche:'mobile detailers/custom bakers/event decorators',area:'Houston city limits'});
  assert.equal(q[0].family,'local_listing');assert.ok(q[0].query.includes('directory'));
  assert.ok(q.some(v=>v.family==='instagram'));assert.ok(q.some(v=>v.family==='facebook'));
  assert.ok(q.every(v=>!v.query.toLowerCase().includes('no website')));
});

test('a directory-backed fixture can be selected for exact enrichment without authorizing a site or contacting anyone',async t=>{
  const f=listingFixture(),app=await acquisitionFixture(t),c=app.store.saveCandidate(app.b.campaignId,f.candidate),p=assessProspect(c,f,app.settings);
  app.store.updateJob(app.job.id,{state:'review_ready',outputs:{candidateIds:[c.id],intake:[{candidateId:c.id,ready:true,reasons:[],contacts:p.contacts,prospect:p}]}});
  await reconcileBatches(app.store);const b=getBatch(app.store,app.b.id),lead=(await app.service.dispatch('lead_list',{batchId:b.id})).items[0];
  assert.equal(b.state,'awaiting_selection');assert.equal(lead.canSelect,true);
  const selected=await app.service.dispatch('batch_build_selected',{id:b.id,candidateId:c.id,evidenceDigest:hash(c),requestId:'listing-fixture-select',authorized:true});
  assert.equal(selected.job.input.phase,'enrichment');assert.equal(selected.job.input.recheckCandidateId,c.id);
  assert.equal(app.store.jobs().filter(j=>j.kind==='site').length,0);
});
