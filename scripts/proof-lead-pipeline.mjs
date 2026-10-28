// Reproducible end-to-end proof of the actual app with a frozen fictional source.
// No live leads, provider charges, model calls, messages or public sites.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {chromium} from 'playwright';import AxeBuilder from '@axe-core/playwright';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';import {startServer} from '../src/server.mjs';

const out=new URL('../docs/visuals/',import.meta.url);
const timestamp=new Date().toISOString();
const place=(i,extra={})=>({id:'fictional-poc-'+i,displayName:{text:'Fictional Studio '+i+' Detailing'},formattedAddress:'Houston, Texas',nationalPhoneNumber:'71355501'+String(i).padStart(2,'0'),googleMapsUri:'https://maps.google.com/?cid=fictional-'+i,businessStatus:'OPERATIONAL',types:['car_wash'],...extra});
const cohort=[...Array.from({length:6},(_,i)=>place(i,i<3?{websiteUri:'https://instagram.com/fictional-studio-'+i}:{})),
 ...Array.from({length:3},(_,i)=>place(i+6,{websiteUri:'https://example.com/fictional-existing-'+i})),
 place(9,{formattedAddress:'Austin, Texas'}),place(10,{formattedAddress:'Dallas, Texas'}),
 place(11,{displayName:{text:'Fictional Plumber Eleven'},types:['plumber']}),place(12,{displayName:{text:'Fictional Electrician Twelve'},types:['electrician']}),
 place(13,{nationalPhoneNumber:'7135550190'}),place(14,{nationalPhoneNumber:'7135550190'}),
 place(15,{businessStatus:'CLOSED_PERMANENTLY'}),place(16,{businessStatus:'CLOSED_TEMPORARILY'}),place(17,{googleMapsUri:'http://localhost/private'})];
let primaryCalls=0,secondaryCalls=0;
const request=async(url,options)=>{
 if(url==='https://places.googleapis.com/v1/places:searchText'){primaryCalls++;return{status:200,bytes:Buffer.from(JSON.stringify({places:cohort}))};}
 assert.equal(url,'https://api.firecrawl.dev/v2/search');secondaryCalls++;
 const name=JSON.parse(options.body).query.match(/^"([^"]+)"/)[1];
 return{status:200,bytes:Buffer.from(JSON.stringify({success:true,data:{web:[{title:name,url:'https://example.com/fictional-missed-website-'+secondaryCalls,description:'Houston, Texas. A fictional possible website for the fixture business.'}]},creditsUsed:1}))};
};
const root=await mkdtemp(path.join(os.tmpdir(),'factory-lead-proof-')),options={dbPath:path.join(root,'db'),stateRoot:path.join(root,'state')};
const before={google:process.env.FACTORY_GOOGLE_PLACES_KEY,firecrawl:process.env.FIRECRAWL_API_KEY};
process.env.FACTORY_GOOGLE_PLACES_KEY='fictional-poc-key';process.env.FIRECRAWL_API_KEY='fictional-poc-key';
await initialize(options);const store=openStore(options),service=createService(store,{autoRun:false,leadRequest:request});
let app,browser;
try{
 await service.dispatch('leads_target_save',{version:0,target:{name:'Fictional Houston detailing proof',areaTerms:['Houston'],serviceTerms:['detailing'],excludeTerms:[],lane:'no_independent_site'}});
 await service.dispatch('leads_schedule_save',{version:0,enabled:true,query:'mobile detailing',area:'Houston, Texas',areas:['Houston, Texas','Katy, Texas'],researchEnabled:true,hour:0,minute:0,timeZone:'America/Chicago',termsReviewed:true,authorized:true});
 const run=await service.dispatch('leads_schedule_tick',{});assert.equal(run.state,'completed');
 const replay=await service.dispatch('leads_schedule_tick',{});assert.equal(replay.replayed,true);assert.equal(primaryCalls,1);assert.equal(secondaryCalls,3);
 const health=await service.dispatch('leads_health',{}),source=health.recentRuns[0];
 assert.equal(source.returnedCount,18);assert.equal(source.heldCount,3);assert.equal(source.newCount,15);
 assert.equal(health.counts.total,15);assert.equal(health.counts.research_first,3);assert.equal(health.counts.excluded,3);assert.equal(health.counts.needs_evidence,9);
 assert.equal(health.providerResponseProven,false);assert.equal(health.sustainedLeadQualityProven,false);assert.equal(store.jobs().length,0);assert.equal(store.candidates().length,0);
 app=await startServer(service,{port:0,previewPort:0});browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true});
 const context=await browser.newContext(),page=await context.newPage(),pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));await page.goto(app.url+'/#opportunities');await page.waitForFunction(()=>window.FactoryStudioReady);
 await page.getByRole('heading',{name:'Lead pipeline health',exact:true}).waitFor();
 const views=[];
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),audit=await new AxeBuilder({page}).analyze();views.push({width,overflow,violations:audit.violations.map(v=>v.id)});assert.equal(overflow,false);assert.deepEqual(audit.violations.map(v=>v.id),[]);if(width!==320){await mkdir(out,{recursive:true});await page.screenshot({path:new URL('lead-pipeline-'+(width===1440?'desktop':'mobile')+'.png',out).pathname,fullPage:false});}}
 assert.deepEqual(pageErrors,[]);
 const result={kind:'actual-app-frozen-fictional-cohort',at:timestamp,liveBusinessesTested:0,liveProviderCalls:0,modelCalls:0,paidRequests:0,injectedPrimaryRequests:primaryCalls,injectedSecondaryRequests:secondaryCalls,cohortSize:18,sourceQuarantined:3,retainedUniquePointers:15,counts:health.counts,views,pageErrors,sameDayReplayMadeNoRequests:true,websiteAbsenceProven:false,qualifiedLeadsProven:0,sourceResponseProven:false,sustainedLeadQualityProven:false,notes:['Three possible missed websites were held by secondary research.','Closed/malformed rows were quarantined without refill.','Independent-site businesses were excluded from the no-site lane.','Wrong-area, wrong-service and shared-phone identities require evidence.','A fixture proof verifies app behavior, not commercial lead supply.']};
 await writeFile(new URL('lead-pipeline-proof.json',out),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{
 if(browser)await browser.close();if(app)await app.close();store.close();await rm(root,{recursive:true,force:true});
 for(const[name,value]of [['FACTORY_GOOGLE_PLACES_KEY',before.google],['FIRECRAWL_API_KEY',before.firecrawl]])if(value===undefined)delete process.env[name];else process.env[name]=value;
}
