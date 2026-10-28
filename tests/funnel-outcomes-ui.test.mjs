import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {initialize,openStore} from '../src/db.mjs';
import {createService,OPERATIONS} from '../src/service.mjs';
import {startServer} from '../src/server.mjs';
import {getBatch,saveBatch} from '../src/batch-store.mjs';
import {assessProspect} from '../src/prospects.mjs';
import {hash} from '../src/contracts.mjs';
import {batchSettings,intakeFixture} from './helpers-batch.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright'),{default:AxeBuilder}=require('@axe-core/playwright');
async function fixture(t,kind){
  const root=await mkdtemp('/tmp/factory-funnel-ui-'),options={dbPath:path.join(root,'fixture.sqlite'),stateRoot:path.join(root,'state'),autoRun:false,batchPrerequisites:async()=>({ready:true})};
  await initialize(options);const store=openStore(options),service=createService(store,options),app=await startServer(service,{port:0,previewPort:0});
  const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true}),context=await browser.newContext(),page=await context.newPage(),errors=[],writes=[];
  await context.route('**/*',r=>r.request().url().startsWith(app.url+'/')?r.continue():r.abort());
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().endsWith('/api/op')){const x=r.postDataJSON();if(!OPERATIONS[x.operation]?.readOnly)writes.push(x.operation);}});
  t.after(async()=>{await browser.close();await app.close();store.close();});
  await service.dispatch('batch_preset_save',{version:0,requestId:'funnel-setup',acknowledged:true,settings:{...batchSettings,targetCount:1,candidateLimit:6,maxResearchRounds:2,maxSearches:16,workflow:'leads_first',discoverySearchLimit:6}});
  const b=await service.dispatch('batch_start',{presetVersion:1,requestId:'funnel-start',authorized:true}),jobId=b.researchJobIds[0];
  if(kind==='malformed'||kind==='blocked')store.updateJob(jobId,{state:kind==='malformed'?'failed':'blocked',errorCode:kind==='malformed'?'INVALID_CONTACT_SOURCE':'SOURCE_BLOCKED',message:kind==='malformed'?'Retained invalid contact format':'Retained source access blocked'});
  else{
    const x=intakeFixture();
    if(kind==='official'){
      const url='https://synthetic-official.example/';x.candidate.websiteCheck.status='official_site_found';x.candidate.websiteCheck.url=url;
      x.observations.push({id:'source-official',url,inspectedAt:new Date().toISOString(),blocked:false,text:'Synthetic official business website'});
      x.candidate.inspectionIds.push('source-official');x.candidate.websiteCheck.linkChecks.push({url,sourceId:'source-official',status:'official',reason:'Exact-business official website observed'});
    }else x.observations[0].links.push({url:'https://unresolved.example/',text:'Website'});
    const c=store.saveCandidate(b.campaignId,x.candidate),prospect=assessProspect(c,x,b.settings);
    if(kind==='official')assert.equal(prospect.websiteStatus,'independent_official_site');else assert.equal(prospect.websiteStatus,'unknown');
    const reason=kind==='official'?'Exact-business official website observed.':'Unresolved destination <img src=x onerror=alert(1)> '+ 'unknown_destination_'.repeat(30);
    saveBatch(store,{...getBatch(store,b.id),members:[{candidateId:c.id,ready:false,reasons:[reason],contacts:[],evidenceDigest:hash(c),prospect,researchJobId:jobId}]});
    store.updateJob(jobId,{state:'review_ready'});
  }
  await service.dispatch('batch_stop',{id:b.id});saveBatch(store,{...getBatch(store,b.id),discoveryUsage:{searches:6},usage:{modelRequests:1,searches:6,inspections:7,imageViews:0}});
  const original=getBatch(store,b.id),changes=store.db.prepare('SELECT total_changes() n').get().n;
  return {root,page,app,store,service,b,jobId,errors,writes,original,changes};
}
test('terminal official-site exclusion leads with actual outcomes before paid start; safe actions inspect exact run and focus existing settings',async t=>{
  const f=await fixture(t,'official'),{page,app,b,root}=f;
  await page.goto(app.url+'/#start');await page.waitForFunction(()=>window.FactoryBatchReady);
  const summary=page.getByRole('region',{name:'Saved run outcome',exact:true});assert.equal(await summary.count(),1);
  assert.match(await summary.innerText(),/1 saved prospect · 0 selectable · 0 sites/);
  assert.match(await summary.innerText(),/official website.*excluded|excluded.*official website/i);assert.match(await summary.innerText(),/not a software failure/i);
  assert.match(await summary.innerText(),/6 of 6 discovery searches/);assert.match(await summary.innerText(),/separate.*authoriz/i);
  assert.equal(await summary.evaluate(e=>Boolean(e.compareDocumentPosition(document.querySelector('.batch-start'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
  for(const [width,height]of [[1280,720],[390,844],[320,740]]){await page.setViewportSize({width,height});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual((await new AxeBuilder({page}).analyze()).violations.map(v=>v.id),[]);await page.screenshot({path:path.join(root,'outcome-'+width+'.png'),fullPage:true});}
  await summary.getByRole('button',{name:'Review search settings',exact:true}).click();assert.equal(await page.locator('.search-settings').evaluate(e=>e.open),true);assert.equal(await page.locator('.batch-setup').evaluate(e=>e.open),true);assert.equal(await page.getByLabel('Business categories',{exact:true}).evaluate(e=>e===document.activeElement),true);
  await summary.getByRole('link',{name:'Inspect saved results',exact:true}).click();await page.waitForFunction(()=>window.FactoryLeadsReady);assert.equal(new URL(page.url()).hash,'#leads/'+b.id);
  assert.match(await page.locator('.lead-run-summary h2').innerText(),/Official website/);await page.locator('.other-results > summary').click();assert.match(await page.locator('.lead-decision').innerText(),/Official website observed — excluded/);assert.equal(await page.getByRole('button',{name:'Make this website',exact:true}).count(),0);
  assert.equal(f.store.jobs().length,1);assert.deepEqual(f.writes,[]);assert.deepEqual(getBatch(f.store,b.id),f.original);assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,f.changes);assert.deepEqual(f.errors,[]);console.log('Funnel exclusion captures: '+root);
});
for(const kind of ['malformed','blocked'])test(`zero-import ${kind} outcome preserves precise failure without diagnosing unrelated software defects`,async t=>{
  const f=await fixture(t,kind),{page,app}=f;await page.goto(app.url+'/#start');await page.waitForFunction(()=>window.FactoryBatchReady);
  const summary=page.getByRole('region',{name:'Saved run outcome',exact:true});assert.equal(await summary.count(),1);assert.match(await summary.innerText(),/0 saved prospects · 0 selectable · 0 sites/);
  assert.match(await summary.innerText(),kind==='malformed'?/required data format/:/blocked.*unknown|unknown.*blocked/i);
  const research=summary.getByRole('link',{name:'Inspect retained research',exact:true});assert.equal(new URL(await research.getAttribute('href'),app.url).hash,'#jobs/'+f.jobId);await research.click();await page.waitForURL('**/#jobs/'+f.jobId);assert.deepEqual(f.writes,[]);assert.equal(f.store.jobs().length,1);assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,f.changes);
});
test('unknown retained destination on Start is not promoted into an official-site exclusion or diagnosed failure',async t=>{
  const f=await fixture(t,'held'),{page,app}=f;await page.goto(app.url+'/#start');await page.waitForFunction(()=>window.FactoryBatchReady);
  const summary=page.getByRole('region',{name:'Saved run outcome',exact:true});assert.match(await summary.innerText(),/outbound.*uninspected or unresolved/);assert.doesNotMatch(await summary.innerText(),/software failure|official website observed and excluded/i);assert.match(await summary.innerText(),/1 saved prospect · 0 selectable · 0 sites/);assert.deepEqual(f.writes,[]);
});
for(const code of ['MODEL_FAILED','BATCH_DEADLINE','NETWORK_LIMIT'])test(`blocked ${code} keeps its actual cause without claiming source access was blocked`,async t=>{
  const f=await fixture(t,'blocked');f.store.updateJob(f.jobId,{errorCode:code,message:'Synthetic retained non-access failure'});const changes=f.store.db.prepare('SELECT total_changes() n').get().n;
  await f.page.goto(f.app.url+'/#start');await f.page.waitForFunction(()=>window.FactoryBatchReady);
  const summary=f.page.getByRole('region',{name:'Saved run outcome',exact:true});assert.doesNotMatch(await summary.innerText(),/source access (?:was )?blocked/i);assert.match(await summary.innerText(),new RegExp(code));assert.match(await summary.innerText(),/Synthetic retained non-access failure/);
  await summary.getByRole('link',{name:'Inspect saved results',exact:true}).click();await f.page.waitForFunction(()=>window.FactoryLeadsReady);assert.doesNotMatch(await f.page.locator('.lead-run-summary').innerText(),/source access (?:was )?blocked/i);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,changes);assert.equal(f.store.jobs().length,1);assert.deepEqual(f.writes,[]);
});
test('official exclusion disclosure shows the recorded exact destination and literal saved facts with their sources',async t=>{
  const f=await fixture(t,'official'),{page,app,b,root}=f;await page.goto(app.url+'/#leads/'+b.id);await page.waitForFunction(()=>window.FactoryLeadsReady);await page.locator('.other-results > summary').click();
  const row=page.locator('.lead-row');await row.locator('summary').click();
  const destination=row.getByRole('link',{name:'Recorded official destination · synthetic-official.example ↗',exact:true});assert.equal(await destination.count(),1);assert.equal(await destination.getAttribute('href'),'https://synthetic-official.example/');
  const fact=row.locator('.lead-facts li').filter({hasText:'Repairs upholstered chairs in Houston.'});assert.equal(await fact.count(),1);assert.equal(await fact.getByRole('link').getAttribute('href'),'https://www.instagram.com/juniper1/');
  assert.equal(await row.locator('details').count(),1);assert.match(await row.innerText(),/recorded.*not a new fetch/i);assert.equal(f.store.jobs().length,1);assert.deepEqual(f.writes,[]);assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,f.changes);
  for(const [width,height]of [[1280,720],[390,844],[320,740]]){await page.setViewportSize({width,height});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual((await new AxeBuilder({page}).analyze()).violations.map(v=>v.id),[]);await page.screenshot({path:path.join(root,'recorded-official-facts-'+width+'.png'),fullPage:true});}console.log('Recorded official destination/facts captures: '+root);
});
test('malformed and unsafe recorded destinations are inert text; CDN signatures and raw dumps stay hidden',async t=>{
  const f=await fixture(t,'official'),{page,app,b}=f;
  await page.route('**/api/op',async r=>{if(r.request().postDataJSON().operation!=='batch_get')return r.continue();const response=await r.fetch(),body=await response.json(),c=body.items[0].candidate;c.websiteCheck.url='javascript:alert(1)';c.websiteCheck.linkChecks=[{status:'official',url:'not a valid destination'},{status:'official',url:'https://scontent.cdninstagram.com/private.jpg?signature=SECRET_FIXTURE_SIGNATURE'},{status:'official',url:'http://127.0.0.1/private'}];c.facts=[{text:'Literal <img src=x onerror=alert(1)> retained fact',sourceUrl:'javascript:alert(2)'}];await r.fulfill({response,json:body});});
  await page.goto(app.url+'/#leads/'+b.id);await page.waitForFunction(()=>window.FactoryLeadsReady);await page.locator('.other-results > summary').click();const row=page.locator('.lead-row');await row.locator('summary').click();
  assert.match(await row.innerText(),/javascript:alert\(1\)/);assert.match(await row.innerText(),/source unavailable \(not a safe public page link\)/);assert.match(await row.locator('.lead-facts').innerText(),/Literal <img src=x onerror=alert\(1\)> retained fact/);
  assert.equal(await row.locator('a[href^="javascript:"], a[href*="127.0.0.1/private"], a[href*="cdninstagram.com"], img[src=x]').count(),0);assert.doesNotMatch(await row.innerText(),/SECRET_FIXTURE_SIGNATURE|private.jpg/);assert.equal(await row.locator('details').count(),1);assert.equal(f.store.jobs().length,1);assert.deepEqual(f.writes,[]);
});
test('malformed credential-bearing destinations never echo credential values into evidence',async t=>{
  const f=await fixture(t,'official');await f.page.route('**/api/op',async r=>{if(r.request().postDataJSON().operation!=='batch_get')return r.continue();const response=await r.fetch(),body=await response.json();body.items[0].candidate.websiteCheck.url='https://account:SYNTHETIC_PRIVATE_VALUE@';await r.fulfill({response,json:body});});
  await f.page.goto(f.app.url+'/#leads/'+f.b.id);await f.page.waitForFunction(()=>window.FactoryLeadsReady);await f.page.locator('.other-results > summary').click();const row=f.page.locator('.lead-row');await row.locator('summary').click();
  assert.doesNotMatch(await row.innerText(),/SYNTHETIC_PRIVATE_VALUE/);assert.equal(await row.locator('a[href*="SYNTHETIC_PRIVATE_VALUE"]').count(),0);assert.deepEqual(f.writes,[]);
});
test('retained lead reasons stay visible with one grouped evidence disclosure, safe hosts, literal long text and focused filters',async t=>{
  const f=await fixture(t,'held'),{page,app,b,root}=f;await page.goto(app.url+'/#leads/'+b.id);await page.waitForFunction(()=>window.FactoryLeadsReady);await page.locator('.other-results > summary').click();
  const row=page.locator('.other-results .lead-row');assert.equal(await page.locator('.lead-shortlist .lead-row').count(),0);assert.match(await row.locator('.lead-decision').innerText(),/outbound.*uninspected or unresolved/);assert.equal(await row.locator('.lead-decision').isVisible(),true);
  assert.equal(await row.locator('details').count(),1);await row.locator('summary').click();
  assert.match(await row.innerText(),/Unresolved destination <img/);
  for(const label of ['Website','Location','Activity & photos'])assert.equal(await row.getByRole('heading',{name:label,exact:true}).isVisible(),true);
  assert.match(await row.innerText(),/Unknown|unknown/);assert.equal(await row.getByRole('link',{name:/instagram.com/}).count()>0,true);assert.equal(await row.locator('img[src=x]').count(),0);
  assert.equal((await row.innerText()).match(/selected ·/g)?.length,1,'Photo status must not be repeated');
  for(const [width,height]of [[1280,720],[390,844],[320,740]]){await page.setViewportSize({width,height});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual((await new AxeBuilder({page}).analyze()).violations.map(v=>v.id),[]);await page.screenshot({path:path.join(root,'evidence-'+width+'.png'),fullPage:true});}
  await page.getByRole('button',{name:'Needs verification',exact:true}).click();await page.waitForFunction(()=>window.FactoryLeadsReady);assert.equal(await page.getByRole('button',{name:'Needs verification',exact:true}).evaluate(e=>e===document.activeElement),true);
  assert.equal(f.store.jobs().length,1);assert.deepEqual(f.writes,[]);assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,f.changes);assert.deepEqual(f.errors,[]);console.log('Funnel grouped evidence captures: '+root);
});
