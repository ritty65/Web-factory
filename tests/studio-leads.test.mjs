import test from 'node:test';import assert from 'node:assert/strict';import sharp from 'sharp';
import {apiFixture} from './helpers-studio.mjs';
import {evaluateExtraction,retainResearchMedia,purgeExpiredStudioData,inspectAndRecord} from '../src/studio-leads.mjs';
import {inspectPublicSource,extractHtml,inspectRendered,readerEnvironment} from '../src/studio-readers.mjs';
import {record,saveRecord} from '../src/studio-state.mjs';
const date=()=>new Date().toISOString().slice(0,10);
export function leadEvidence(name='Fictional Oakline Detailing',phone='+17135550101'){
 const text=`${name} serves Houston, Texas. Interior cleaning. Exterior care. Complete detailing. Published work on ${date()}. Call ${phone}.`;
 const observations=['https://www.facebook.com/fixture','https://www.yelp.com/biz/fixture'].map((url,i)=>({id:'observation-fixture-'+i,url,finalUrl:url,title:name,text,links:[],images:[{url:'https://example.com/work.jpg',alt:'Business work',width:600,height:400}],contacts:['tel:'+phone],dates:[{value:date(),text:'Published work'}],structured:[],blocked:false,truncated:false,inspectedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*86400000).toISOString()}));
 const p=(text,id=observations[0].id)=>({observationId:id,text,excerpt:text});
 const extraction={identity:p(name),location:p('Houston, Texas'),services:['Interior cleaning','Exterior care','Complete detailing'].map(s=>p(s)),contact:{kind:'phone',value:phone,observationId:observations[1].id,excerpt:text},activity:{...p('Published work on '+date(),observations[1].id),date:date(),dateText:date()},independentWebsite:null,media:[{observationId:observations[0].id,imageIndex:0,businessPostedExcerpt:name+' serves Houston, Texas',alt:'Publicly observed fictional business work'}],unknowns:[]};
 const pointer={id:'prospect-fixture',placeId:'fictional-place',cohortId:'cohort-fixture',data:{name,phone,area:'Houston, Texas',website:'',operatingStatus:'OPERATIONAL'},expiresAt:new Date(Date.now()+86400000).toISOString()};
 const searches=[0,1].map(i=>({query:'"'+name+'" website '+i,at:new Date().toISOString(),identityClue:true,items:observations.map(o=>({url:o.url,title:name,description:'Houston detailing'}))}));return {pointer,observations,searches,extraction};
}
test('literal multi-source facts can support a private opportunity, never buying intent or website absence proof',()=>{const e=leadEvidence(),a=evaluateExtraction(e.pointer,e.observations,e.searches,e.extraction);assert.equal(a.state,'source_checked',a.reasons.join(';'));assert.equal(a.buyingInterest,'unknown');assert.equal(a.contactReachabilityProven,false);assert.equal(a.websiteCheck.absenceProven,false);assert.equal(a.publicRelease,false);assert.equal(a.mediaSelections.length,1);});
for(const fault of ['stale_activity','future_activity','wrong_city','missing_contact','wrong_identity','copied_fake_fact','same_publisher','unrelated_search','existing_site','unvisited_possible_site','identity_conflict','expired_pointer'])test('qualification holds '+fault,()=>{
 const e=leadEvidence();
 if(fault==='stale_activity')e.extraction.activity.date=e.extraction.activity.dateText='2001-01-01';
 if(fault==='future_activity')e.extraction.activity.date=e.extraction.activity.dateText='2099-01-01';
 if(fault==='wrong_city')e.extraction.location={...e.extraction.location,text:'Dallas',excerpt:'Dallas'};
 if(fault==='missing_contact')e.extraction.contact.value='+17135550999';
 if(fault==='wrong_identity')e.extraction.identity={...e.extraction.identity,text:'Different Company',excerpt:'Different Company'};
 if(fault==='copied_fake_fact')e.extraction.services[0]={...e.extraction.services[0],text:'Lifetime guarantee',excerpt:'Interior cleaning'};
 if(fault==='same_publisher')e.observations[1].finalUrl='https://m.facebook.com/other';
 if(fault==='unrelated_search')e.searches[0].identityClue=false;
 if(fault==='existing_site')e.pointer.data.website='https://example.com/independent';
 if(fault==='unvisited_possible_site')e.searches[0].items.push({url:'https://example.com/possible',title:e.pointer.data.name,description:'Official business'});
 if(fault==='identity_conflict')e.pointer.identityConflict=true;
 if(fault==='expired_pointer')e.pointer.expiresAt='2001-01-01T00:00:00Z';
 assert.equal(evaluateExtraction(e.pointer,e.observations,e.searches,e.extraction).state,'held');
});
test('untrusted extraction cannot add qualification flags, permission or public-release authority',()=>{const e=leadEvidence();for(const extra of [{qualified:true},{publicRelease:true},{humanDecision:true}])assert.equal(evaluateExtraction(e.pointer,e.observations,e.searches,{...e.extraction,...extra}).state,'held');});
test('Scrapling uses the installed real parser, preserves source text and never receives provider keys',async()=>{
 const parsed=await extractHtml('https://example.com/','<html><title>Source</title><body><h1>Business</h1><script>privateInstruction()</script><a href="tel:7135550101">Call</a><a href="/service">Service</a><img src="https://example.com/photo.jpg" alt="Actual picture" width="600" height="400"><time datetime="2026-10-28">October 28</time></body></html>');
 assert.equal(parsed.title,'Source');assert.ok(parsed.contacts.includes('tel:7135550101'));assert.equal(parsed.images[0].url,'https://example.com/photo.jpg');assert.ok(parsed.links.some(l=>l.url==='https://example.com/service'));assert.doesNotMatch(parsed.text,/privateInstruction/);assert.ok(Object.keys(readerEnvironment()).every(k=>!/^FACTORY_|KEY|TOKEN/.test(k)));
});
test('platform policy and private-DNS failures do not trigger browser or paid remote fallbacks',async t=>{
 const f=await apiFixture(t);let rendered=0,paid=0;
 for(const code of ['PRIVATE_DNS','PUBLIC_POLICY'])await assert.rejects(inspectPublicSource(f.store,'https://example.com/',{requestId:'policy-source-fixture',fetchPage:async()=>{throw Object.assign(Error(),{code});},render:async()=>{rendered++;},request:async()=>{paid++;}}),e=>e.code===code);
 assert.equal(rendered,0);assert.equal(paid,0);
});
test('access-restricted public pages remain blocked and do not escalate to another reader',async t=>{const f=await apiFixture(t);let rendered=0;const o=await inspectPublicSource(f.store,'https://example.com/',{requestId:'blocked-source-fixture',fetchPage:async()=>({status:403,url:'https://example.com/',bytes:Buffer.from('denied'),contentType:'text/html'}),render:async()=>{rendered++;}});assert.equal(o.blocked,true);assert.equal(rendered,0);});
test('Camofox creates fresh sessions, consumes actual normalized image metadata and closes on success/failure',async()=>{
 const calls=[];const request=async(endpoint,options)=>{calls.push({endpoint,body:options.body});if(endpoint==='/tabs')return{tabId:'fixture-tab'};if(endpoint.endsWith('/snapshot'))return{url:'https://example.com/',title:'Fixture',text:'Public page '.repeat(30),links:[],contacts:[],dates:[],httpStatus:200};if(endpoint.endsWith('/images'))return{images:[{url:'https://example.com/work.jpg',alt:'Work',width:600,height:400}]};return{closed:true};};
 const a=await inspectRendered('https://example.com/',{request,resolve:async()=>({address:'93.184.216.34',family:4})}),b=await inspectRendered('https://example.com/',{request,resolve:async()=>({address:'93.184.216.34',family:4})});assert.equal(a.images.length,1);assert.equal(a.method,'camofox_fresh_guest');assert.notEqual(calls.filter(c=>c.endpoint==='/tabs')[0].body.userId,calls.filter(c=>c.endpoint==='/tabs')[1].body.userId);assert.equal(calls.filter(c=>c.endpoint.startsWith('/sessions/')).length,2);
 let closed=0;await assert.rejects(inspectRendered('https://example.com/',{resolve:async()=>({address:'93.184.216.34',family:4}),request:async(endpoint,options)=>{if(endpoint.startsWith('/sessions/')){closed++;return{};}if(endpoint==='/tabs')return{tabId:'fixture-tab'};throw Object.assign(Error(),{code:'FIXTURE_FAILURE'});}}));assert.equal(closed,1);
});
test('research image preparation retains real bytes, strips derivatives, deduplicates and never claims owner permission',async t=>{
 const f=await apiFixture(t),e=leadEvidence(),a=evaluateExtraction(e.pointer,e.observations,e.searches,e.extraction);a.observations=e.observations;a.mediaSelections.push(a.mediaSelections[0]);
 const bytes=await sharp({create:{width:600,height:400,channels:3,background:'#426849'}}).jpeg().toBuffer();
 const media=await retainResearchMedia(f.store,a,{download:async()=>({status:200,contentType:'image/jpeg',bytes})});assert.equal(media.length,1);assert.equal(media[0].rightsholderPermission,'unconfirmed');assert.equal(media[0].publicRelease,false);assert.equal(media[0].permission,'operator_authorized_private_preview');
});
test('source request replay preserves the same observation instead of repeating fetches',async t=>{
 const f=await apiFixture(t),e=leadEvidence();let calls=0;const observe=async()=>{calls++;return e.observations[0];};const options={requestId:'durable-source-observation',observe};const a=await inspectAndRecord(f.store,e.observations[0].url,options),b=await inspectAndRecord(f.store,e.observations[0].url,options);assert.equal(a.id,b.id);assert.equal(calls,1);
});
test('expired provider data is purged while exact spending receipts remain consumed',async t=>{
 const f=await apiFixture(t);saveRecord(f.store,'spend-fixture-expired','studio_spend',{id:'spend-fixture-expired',provider:'google',reservedMicros:1000,chargedMicros:1000,state:'completed',expiresAt:'2001-01-01T00:00:00Z',result:{privatePayload:'old'}});saveRecord(f.store,'prospect-expired','studio_pointer',{id:'prospect-expired',placeId:'kept-provider-id',expiresAt:'2001-01-01T00:00:00Z',data:{name:'Old business'}});assert.equal(purgeExpiredStudioData(f.store).purged,2);assert.equal(record(f.store,'spend-fixture-expired','studio_spend').result,undefined);assert.equal(record(f.store,'spend-fixture-expired','studio_spend').chargedMicros,1000);assert.equal(record(f.store,'prospect-expired','studio_pointer').placeId,'kept-provider-id');assert.equal(record(f.store,'prospect-expired','studio_pointer').data,undefined);
});
