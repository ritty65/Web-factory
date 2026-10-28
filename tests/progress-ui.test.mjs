import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {startServer} from '../src/server.mjs';
import {reserveBatchUsage} from '../src/batch-budget.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright'),{default:AxeBuilder}=require('@axe-core/playwright');
async function fixture(t){
  const root=await mkdtemp('/tmp/progress-ui-'),options={dbPath:path.join(root,'fixture.sqlite3'),stateRoot:path.join(root,'state'),autoRun:false,batchPrerequisites:async()=>({ready:true})};
  await initialize(options);const store=openStore(options),service=createService(store,options);
  const settings={area:'Houston city limits',niche:'Synthetic progress tests',targetCount:1,candidateLimit:1,maxResearchRounds:1,searchProvider:'guest_bing',maxSearches:8,discoverySearchLimit:4,maxInspections:12,maxImageViews:6,maxModelRequests:10,batchMinutes:60,jobMinutes:10,workflow:'leads_first'};
  await service.dispatch('batch_preset_save',{version:0,requestId:'progress-ui-preset',settings,acknowledged:true});
  const batch=await service.dispatch('batch_start',{presetVersion:1,requestId:'progress-ui-start',authorized:true});
  const job=batch.researchJobIds[0];store.claim(job);reserveBatchUsage(store,job,'searches');reserveBatchUsage(store,job,'searches');
  const app=await startServer(service,{port:0,previewPort:0}),browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true}),context=await browser.newContext(),page=await context.newPage();
  await page.route('**/*',r=>r.request().url().startsWith(app.url+'/')?r.continue():r.abort());
  t.after(async()=>{await browser.close();await app.close();store.close();});
  return {root,store,service,batch,app,page};
}
test('real responsive progress shows ledger milestones and allowance bars without success percentages',async t=>{
  const {page,app,batch,root}=await fixture(t);
  await page.goto(app.url+'/#start/'+batch.id);await page.waitForFunction(()=>window.FactoryBatchReady);
  const panel=page.getByRole('region',{name:'Evidence-backed progress'});assert.equal(await panel.count(),1);
  await panel.getByText('Progress & usage',{exact:true}).click();
  assert.equal(await panel.locator('[data-stage=discovery]').getAttribute('data-state'),'running');
  const bar=panel.getByRole('progressbar',{name:'Search attempts used'});
  assert.equal(await bar.getAttribute('value'),'2');assert.equal(await bar.getAttribute('max'),'8');
  assert.match(await panel.innerText(),/Attempts used, not completion/);assert.doesNotMatch(await panel.innerText(),/\d+%/);
  for(const width of [1280,390,320]){
    await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.deepEqual((await new AxeBuilder({page}).analyze()).violations.map(v=>v.id),[]);
    await page.screenshot({path:path.join(root,'progress-'+width+'.png'),fullPage:true});
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await panel.locator('.work-indicator').evaluate(el=>getComputedStyle(el).animationName),'none');
});
test('failed reads freeze the activity cue, retain saved counters and recover only after a new read',async t=>{
  const {page,app,batch,store}=await fixture(t);await page.goto(app.url+'/#start/'+batch.id);await page.waitForFunction(()=>window.FactoryBatchReady);
  assert.equal(await page.getByRole('region',{name:'Evidence-backed progress'}).count(),1);
  await page.getByText('Progress & usage',{exact:true}).click();
  await page.route('**/api/status',r=>r.abort());await page.getByRole('button',{name:'Refresh ↻',exact:true}).click();
  await page.getByText('Connection lost — showing saved progress.',{exact:true}).waitFor({timeout:2000});
  assert.equal(await page.locator('[data-ledger-progress]').getAttribute('data-connection'),'offline');
  assert.equal(await page.getByRole('progressbar',{name:'Search attempts used'}).getAttribute('value'),'2');
  assert.equal(store.job(batch.researchJobIds[0]).state,'running');
  await page.unroute('**/api/status');await page.getByRole('button',{name:'Refresh ↻',exact:true}).click();await page.locator('[data-ledger-progress][data-connection=online]').waitFor({timeout:3000});
  assert.equal(await page.locator('[data-ledger-progress]').getAttribute('data-connection'),'online');
});
test('stopped work has no active indicator and leaves production and review visibly pending',async t=>{
  const {page,app,batch,service}=await fixture(t);await service.dispatch('batch_stop',{id:batch.id});
  await page.goto(app.url+'/#leads/'+batch.id);await page.waitForFunction(()=>window.FactoryLeadsReady);
  const panel=page.getByRole('region',{name:'Evidence-backed progress'});assert.equal(await panel.count(),1);
  assert.equal(await panel.getAttribute('data-running'),'false');
  for(const key of ['production','first_site_review'])assert.equal(await panel.locator('[data-stage='+key+']').getAttribute('data-state'),'pending');
});
test('fresh ledger reads cannot make an idle worker look active',async t=>{
  const {page,app,batch,store}=await fixture(t),job=batch.researchJobIds[0],old=new Date(Date.now()-90000).toISOString();
  for(const r of store.db.prepare('SELECT seq,record FROM factory_event WHERE job_id=?').all(job)){
    const record=JSON.parse(r.record);record.at=old;store.db.prepare('UPDATE factory_event SET record=? WHERE seq=?').run(JSON.stringify(record),r.seq);
  }
  await page.goto(app.url+'/#start/'+batch.id);await page.waitForFunction(()=>window.FactoryBatchReady);
  await page.getByText('No recent worker activity — completion is unknown.',{exact:true}).waitFor({timeout:2000});
  assert.equal(await page.locator('[data-ledger-progress]').getAttribute('data-running'),'false');
  await page.getByText('Progress & usage',{exact:true}).click();
  assert.equal(await page.getByRole('progressbar',{name:'Search attempts used'}).getAttribute('value'),'2');
});
