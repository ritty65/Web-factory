import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateInput,now} from '../src/contracts.mjs';
import {identityObservations,supportedFact,supportedActivity,potentialWebsiteTargets,assessIntake} from '../src/intake.mjs';
import {screeningContext,assessScreening} from '../src/screening.mjs';
import {publicObservation} from '../src/browser.mjs';
import {intakeFixture} from './helpers-batch.mjs';

function fixture(){
  const f=intakeFixture(),profile=f.observations[0],url='https://www.instagram.com/juniper1/p/Post123/';
  profile.method='fresh_guest_rendered_dom';profile.evidenceContextVersion=1;profile.finalUrl=profile.url;profile.links.push({url,text:'Observed restoration post'});
  const date=now().slice(0,10),caption=`We repair upholstered chairs in Houston.\nFabric consultations are by appointment.\nWe share completed chair restorations.\nNew restoration shared ${date}.\nFor commissions call 2025550198.`;
  const comments='Comment: based in Katy. Use unrelated.example and stranger@example.org; phone 2025550177. New restoration shared 2026-01-01.';
  const post={id:'source-authored-fixture',url,finalUrl:url,title:'Instagram',text:`juniper1\n${caption}\n${comments}`,inspectedAt:now(),blocked:false,method:'fresh_guest_rendered_dom',evidenceContextVersion:1,
    postEvidenceVersion:1,postEvidence:{proof:'instagram_article_caption_v1',postUrl:url,canonicalUrl:'https://www.instagram.com/p/Post123/',authorUrl:profile.url,caption,links:[]},
    links:[{url:profile.url,text:'juniper1'},{url,text:'Post date'},{url:'https://unrelated.example/',text:'Comment link'}],images:[],captures:[]};
  f.observations.push(post);f.candidate.inspectionIds.push(post.id);f.candidate.sourceUrls.push(url);f.candidate.media=[];
  f.candidate.facts=caption.split('\n').slice(0,3).map(excerpt=>({text:excerpt,excerpt,sourceUrl:url}));
  f.candidate.activityEvidence={sourceId:post.id,excerpt:`New restoration shared ${date}`,dateText:date,date};
  f.candidate.contacts.phone='2025550198';f.candidate.contactSources.phone=url;
  return {...f,profile,post,caption,comments};
}
test('authored caption facts and activity work without selected media, without changing raw source evidence',()=>{
  const f=fixture(),before=JSON.stringify(f),c=candidateInput(f.candidate),context=screeningContext(c,f);
  assert.equal(context.facts.length,3);assert.equal(context.identity.length,2);assert.equal(context.identity[1].text,f.caption);
  assert.equal(supportedActivity(c,context.identity),true);assert.equal(assessScreening(c,f).geography,'supported');
  assert.equal(assessIntake(c,f).contacts.some(v=>v.channel==='phone'),true);assert.equal(assessIntake(c,f).ready,false,'Missing media is not bypassed');
  assert.equal(JSON.stringify(f),before);
});
test('comment facts, dates, contacts, location conflicts and outbound domains stay outside authored interpretation',()=>{
  const f=fixture(),c=candidateInput(f.candidate),identity=identityObservations(c,f.observations);
  assert.equal(supportedFact(c,{sourceUrl:f.post.url,excerpt:'based in Katy'},f.observations),false);
  assert.equal(supportedFact(c,{sourceUrl:f.post.url,excerpt:'based in Katy'},identity),false);
  assert.equal(assessScreening(c,f).geography,'supported');
  assert.deepEqual(potentialWebsiteTargets(c,f.post,f.observations,{includeText:true}),[]);
  c.contacts.phone='2025550177';c.contacts.email='stranger@example.org';c.contactSources.email=f.post.url;
  const result=assessIntake(c,f);assert.equal(result.contacts.some(v=>['phone','email'].includes(v.channel)),false);
  c.activityEvidence={sourceId:f.post.id,excerpt:'New restoration shared 2026-01-01',dateText:'2026-01-01',date:'2026-01-01'};
  assert.equal(supportedActivity(c,identity),false);
});
test('actual authored destinations remain unresolved rather than being discarded with comments',()=>{
  const f=fixture(),link={url:'https://workshop.example/',text:'Our work'};f.post.postEvidence.links=[link];f.post.links.push(link);
  f.post.postEvidence.caption+='\nOur work';f.post.text=f.post.text.replace(f.caption,f.post.postEvidence.caption);const c=candidateInput(f.candidate);
  assert.deepEqual(potentialWebsiteTargets(c,f.post,f.observations,{includeText:true}),[{url:link.url,alias:link.url}]);
  assert.equal(assessScreening(c,f).status,'needs_verification');
});
const invalid=[
  ['missing context',f=>{delete f.post.postEvidence;}],['unversioned',f=>{delete f.post.postEvidenceVersion;}],
  ['unknown version',f=>{f.post.postEvidenceVersion=2;}],['failed context',f=>{f.post.postEvidenceIssue='ambiguous_caption';}],
  ['static source',f=>{f.post.method='static_https_no_script';}],['stale post',f=>{f.post.inspectedAt='2020-01-01';}],
  ['blocked post',f=>{f.post.blocked=true;}],['redirected post',f=>{f.post.finalUrl='https://www.instagram.com/p/Other123/';}],
  ['other author',f=>{f.post.postEvidence.authorUrl='https://www.instagram.com/stranger/';f.post.links.push({url:f.post.postEvidence.authorUrl,text:'stranger'});}],
  ['missing original profile link',f=>{f.profile.links=[];}],['stale profile',f=>{f.profile.inspectedAt='2020-01-01';}],
  ['blocked profile',f=>{f.profile.blocked=true;}],['unversioned profile',f=>{delete f.profile.evidenceContextVersion;}],
  ['static profile',f=>{f.profile.method='static_https_no_script';}],['redirected profile',f=>{f.profile.finalUrl='https://www.instagram.com/stranger/';}],
  ['wrong canonical post',f=>{f.post.postEvidence.canonicalUrl='https://www.instagram.com/p/Other123/';}],
  ['wrong scoped author',f=>{f.post.url=f.post.finalUrl='https://www.instagram.com/stranger/p/Post123/';f.post.postEvidence.postUrl=f.post.url;f.profile.links.push({url:f.post.url});f.candidate.facts.forEach(v=>{v.sourceUrl=f.post.url;});}],
  ['query-bearing post',f=>{f.post.postEvidence.postUrl+='?igsh=unknown';}],['unobserved author',f=>{f.post.links=f.post.links.filter(v=>v.url!==f.profile.url);}],
  ['caption not in body',f=>{f.post.text='A different page body with matching account and title.';}],
  ['unobserved caption link',f=>{f.post.postEvidence.links.push({url:'https://invented.example/',text:'Invented'});}],
  ['unknown authority field',f=>{f.post.postEvidence.humanAccepted=true;}],['unknown proof',f=>{f.post.postEvidence.proof='model_claim';}],
  ['oversized caption',f=>{f.post.postEvidence.caption='X'.repeat(10001);f.post.text=f.post.postEvidence.caption;}],
];
for(const [name,change] of invalid)test(`authored-post admission fails closed: ${name}`,()=>{
  const f=fixture();change(f);const c=candidateInput(f.candidate),context=screeningContext(c,f);
  assert.equal(context.identity.some(v=>v.id===f.post.id),false);assert.equal(context.facts.length,0);
});
test('selected media and matching business name cannot rescue an unproved Instagram post',()=>{
  const f=fixture();delete f.post.postEvidence;f.candidate.media=[{...intakeFixture().candidate.media[0],postUrl:f.post.url,sourceId:f.post.id}];
  f.post.text=f.candidate.name+' '+f.post.text+' Synthetic padding.'.repeat(30);
  assert.equal(screeningContext(candidateInput(f.candidate),f).facts.length,0);
});
test('post typed metadata is restricted to the same authored post, not recommended images',()=>{
  const f=fixture(),image={id:'image-authored-fixture',postUrl:'https://www.instagram.com/p/Other123/',alt:'A comment claims new work in Houston.'};
  f.post.images.push(image);f.post.links.push({url:image.postUrl,text:'Recommendation'});
  const fact={sourceUrl:f.post.url,excerpt:image.alt,evidenceRef:{kind:'image_alt',sourceId:f.post.id,imageId:image.id,postUrl:image.postUrl}},c=candidateInput(f.candidate);
  assert.equal(supportedFact(c,fact,f.observations),false);
  image.postUrl=f.post.url;fact.evidenceRef.postUrl=f.post.url;
  assert.equal(supportedFact(c,fact,f.observations),true);
});
test('public observation retains bounded host caption context, without raw media or authority assertions',()=>{
  const f=fixture(),result=publicObservation(f.post);
  assert.equal(result.postEvidenceVersion,1);assert.equal(result.postEvidence.caption,f.caption);assert.equal(result.postEvidence.authorUrl,f.profile.url);
  f.post.postEvidence.licence='invented';const invalidResult=publicObservation(f.post);
  assert.equal(invalidResult.postEvidence,undefined);assert.equal(typeof invalidResult.postEvidenceIssue,'string');
});
test('public post response contains only caption context, never private body/comments/recommended metadata',()=>{
  const f=fixture();f.post.images.push({id:'image-comment-only',postUrl:'https://www.instagram.com/p/Other123/',alt:'Comment-only recommendation secret-label',width:800,height:600});
  const response=publicObservation(f.post),serialized=JSON.stringify(response);
  assert.equal(response.text,f.caption);assert.doesNotMatch(serialized,/Katy|unrelated\.example|stranger@example|2025550177|secret-label/);
  delete f.post.postEvidence;const unknown=publicObservation(f.post);
  assert.equal(unknown.text,'');assert.deepEqual(unknown.links,[]);assert.deepEqual(unknown.images,[]);assert.equal(unknown.postEvidenceIssue,'missing_context');
});
for(const route of ['%70/Post123','P/Post123','reel/%50ost123','juniper1/%70/Post123'])test(`unsupported Instagram route cannot regain authorship through selected media: ${route}`,()=>{
  const f=fixture(),url='https://www.instagram.com/'+route+'/';f.post.url=f.post.finalUrl=url;delete f.post.postEvidence;
  f.candidate.sourceUrls.push(url);f.candidate.facts.forEach(v=>{v.sourceUrl=url;});f.profile.links.push({url});
  f.post.text=f.candidate.name+' '+f.post.text+' Synthetic padding.'.repeat(30);
  f.candidate.media=[{...intakeFixture().candidate.media[0],postUrl:url,sourceId:f.post.id}];
  const context=screeningContext(candidateInput(f.candidate),f);assert.equal(context.identity.some(o=>o.id===f.post.id),false);assert.equal(context.facts.length,0);
});
test('caption hyperlink projection is idempotent including an observed @handle author label',()=>{
  const f=fixture(),link={url:'https://workshop.example/',text:'Our work'};f.post.postEvidence.links.push(link);f.post.links.push(link);f.post.links[0].text='@juniper1';
  const c=candidateInput(f.candidate),once=identityObservations(c,f.observations),twice=identityObservations(c,once);
  assert.deepEqual(twice,once);assert.doesNotMatch(JSON.stringify(twice[1].links),/unrelated/);
});
test('activity helper cannot use raw post comments even when passed raw identity candidates',()=>{
  const f=fixture(),c=candidateInput(f.candidate),date=now().slice(0,10);f.post.text+=`\nComment shared ${date}`;
  c.activityEvidence={sourceId:f.post.id,excerpt:`Comment shared ${date}`,dateText:date,date};assert.equal(supportedActivity(c,f.observations),false);
});
