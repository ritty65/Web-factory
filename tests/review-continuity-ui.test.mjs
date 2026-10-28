import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {startServer} from '../src/server.mjs';
import {getBatch,saveBatch} from '../src/batch-store.mjs';
import {hash} from '../src/contracts.mjs';
import {treeHashes} from '../src/proposal.mjs';
import {batchSettings,intakeFixture} from './helpers-batch.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');

async function fixture(t,{batch=false}={}){
  const root=await mkdtemp('/tmp/factory-review-continuity-'),options={dbPath:path.join(root,'fixture.sqlite3'),stateRoot:path.join(root,'state'),autoRun:false,batchPrerequisites:async()=>({ready:true,checks:[]})};
  await initialize(options);const store=openStore(options),service=createService(store,options),app=await startServer(service,{port:0,previewPort:0});
  const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true}),context=await browser.newContext(),page=await context.newPage(),errors=[],operations=[];
  await context.route('**/*',r=>[app.url,app.previewUrl].some(url=>r.request().url().startsWith(url+'/'))?r.continue():r.abort());
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().endsWith('/api/op'))operations.push(r.postDataJSON().operation);});
  t.after(async()=>{await browser.close();await app.close();store.close();});
  await service.dispatch('batch_preset_save',{version:0,requestId:'review-continuity-setup',settings:{...batchSettings,targetCount:1,candidateLimit:3,maxResearchRounds:1,workflow:'leads_first',discoverySearchLimit:4},acknowledged:true});
  const b=batch?await service.dispatch('batch_start',{presetVersion:1,requestId:'review-continuity-run',authorized:true}):null;
  const campaign=b?{id:b.campaignId}:store.createCampaign({name:'Synthetic continuity fixture',query:'Fixture only',area:'Houston',niche:'Synthetic workshop'});
  const candidate=store.saveCandidate(campaign.id,intakeFixture(99).candidate);
  async function site(input={}){
    const j=store.createJob({campaignId:campaign.id,kind:'site',input:{candidateId:candidate.id,...input}}),relative=`jobs/${j.id}/attempt-0/proposal-0/site`,qaRelative=`jobs/${j.id}/attempt-0/qa-0`;
    await mkdir(path.join(store.stateRoot,relative),{recursive:true});await mkdir(path.join(store.stateRoot,qaRelative),{recursive:true});
    for(const name of ['index','services'])await writeFile(path.join(store.stateRoot,relative,name+'.html'),`<!doctype html><title>Synthetic ${name}</title><h1>Fixture ${name}</h1>`);
    // Capture actual fixture pixels; these are not customer-site QA evidence.
    await page.goto(app.url);await page.waitForFunction(()=>window.FactoryBatchReady);
    for(const name of ['index','services']){
      const captureRelative=`${qaRelative}/${name}-first-1440.png`,file=path.join(store.stateRoot,captureRelative);
      await page.screenshot({path:file});store.artifact({jobId:j.id,kind:'site_capture',relative:captureRelative,label:'Synthetic actual-browser screenshot',sha256:hash(await readFile(file)),bytes:(await stat(file)).size});
    }
    return store.updateJob(j.id,{state:'review_ready',outputs:{siteRelative:relative,qaRelative,siteDigest:hash(await treeHashes(path.join(store.stateRoot,relative))),qaPass:true,reviewStatus:'operator_review_required',humanDecision:null,publicRelease:false}});
  }
  if(b){for(const id of b.researchJobIds)store.updateJob(id,{state:'review_ready'});saveBatch(store,{...getBatch(store,b.id),phase:'production',firstCandidateId:candidate.id,selection:{candidateId:candidate.id,evidenceDigest:hash(candidate),requestId:'synthetic-selection'},enrichmentJobId:b.researchJobIds[0],processedResearchIds:b.researchJobIds,members:[{candidateId:candidate.id,ready:true,reasons:[],contacts:[],evidenceDigest:hash(candidate)}]});}
  const job=await site();
  if(b){for(const id of b.researchJobIds)store.updateJob(id,{state:'review_ready'});saveBatch(store,{...getBatch(store,b.id),state:'awaiting_first_review',phase:'first_site_review',firstCandidateId:candidate.id,initialAttempts:1,members:[{candidateId:candidate.id,ready:true,reasons:[],contacts:[],evidenceDigest:hash(candidate)}]});}
  let visit=0;
  async function open(j=job){await page.goto(app.url+'/?review-fixture='+ ++visit+'#review/'+j.id);await page.waitForFunction(()=>window.FactoryReviewReady===true);await page.getByLabel('Review page',{exact:true}).waitFor();}
  return {root,store,service,app,page,errors,operations,b,job,candidate,site,open};
}

test('main interactive URL follows the selected capture and normalizes before constructing a new site link',async t=>{
  const f=await fixture(t);await f.open();await f.page.getByLabel('Review page',{exact:true}).selectOption('services');
  assert.equal(await f.page.getByRole('link',{name:'Open interactive website',exact:true}).getAttribute('href'),`${f.app.previewUrl}/site/${f.job.id}/services.html`);
  assert.equal(await f.page.getByRole('img',{name:'Current proposal · services · 1440px actual pixels',exact:true}).count(),1);
  const preview=await f.page.context().newPage();await preview.goto(await f.page.getByRole('link',{name:'Open interactive website',exact:true}).getAttribute('href'));assert.equal(await preview.locator('h1').innerText(),'Fixture services');await preview.close();
  await f.page.getByRole('button',{name:'Phone',exact:true}).click();await f.page.getByText('No matching capture for this page/device yet.',{exact:true}).waitFor();
  assert.equal(await f.page.getByRole('img',{name:/Current proposal/}).count(),0);
  const other=await f.site({parentSiteJobId:f.job.id,parentSiteDigest:f.job.outputs.siteDigest});f.store.db.prepare("DELETE FROM factory_artifact WHERE job_id=? AND json_extract(record,'$.relative') LIKE '%services%'").run(other.id);
  await f.open();await f.page.getByLabel('Review page',{exact:true}).selectOption('services');
  await f.page.evaluate(id=>{location.hash='review/'+id;},other.id);await f.page.locator('#feedback-'+other.id).waitFor();
  assert.equal(await f.page.getByRole('link',{name:'Open interactive website',exact:true}).getAttribute('href'),`${f.app.previewUrl}/site/${other.id}/index.html`);
  assert.deepEqual(f.errors,[]);
});

test('page selection retains keyboard focus and review reads fit laptop, 390px and 320px without writes',async t=>{
  const f=await fixture(t),before=f.store.db.prepare('SELECT total_changes() n').get().n,jobs=f.store.jobs().length;
  await f.open();await f.page.getByLabel('Review page',{exact:true}).focus();await f.page.getByLabel('Review page',{exact:true}).selectOption('services');
  await f.page.waitForFunction(()=>!document.querySelector('[data-review-checkpoint-loading]'));
  assert.equal(await f.page.getByRole('link',{name:'Return to run review',exact:true}).count(),0,'Unrelated saved sites have no run checkpoint');
  assert.equal(await f.page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Review page');
  for(const width of [1280,390,320]){
    await f.page.setViewportSize({width,height:900});assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await f.page.screenshot({path:path.join(f.root,'review-services-'+width+'.png'),fullPage:true});
  }
  await f.page.getByRole('button',{name:'Phone',exact:true}).click();await f.page.getByText('No matching capture for this page/device yet.',{exact:true}).waitFor();
  assert.equal(await f.page.evaluate(()=>document.activeElement?.textContent),'Phone');
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(f.store.jobs().length,jobs);
  assert.ok(f.operations.every(op=>['job_get','batch_status','batch_get'].includes(op)));assert.deepEqual(f.errors,[]);console.log('Review continuity pixel evidence: '+f.root);
});

test('only the eligible exact current first-business site links back to its existing human checkpoint',async t=>{
  const f=await fixture(t,{batch:true}),before=f.store.db.prepare('SELECT total_changes() n').get().n;
  await f.open();const back=f.page.getByRole('link',{name:'Return to run review',exact:true});await back.waitFor({timeout:2500});
  assert.equal(await back.getAttribute('href'),`${f.app.url}/#start/${f.b.id}/checkpoint`);
  for(const width of [1280,390,320]){
    await f.page.setViewportSize({width,height:900});assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await f.page.screenshot({path:path.join(f.root,'review-with-return-'+width+'.png'),fullPage:true});
  }
  console.log('Eligible run-return pixel evidence: '+f.root);
  await back.click();await f.page.waitForFunction(()=>window.FactoryBatchReady);await f.page.getByRole('heading',{name:'Finish this one-site review.',exact:true}).waitFor();
  assert.equal(getBatch(f.store,f.b.id).checkpoint,null);assert.equal(f.store.job(f.job.id).outputs.humanDecision,null);assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,before);
  const revision=await f.site({parentSiteJobId:f.job.id,parentSiteDigest:f.job.outputs.siteDigest});await f.open(f.job);await f.page.waitForFunction(()=>!document.querySelector('[data-review-checkpoint-loading]'));
  assert.equal(await f.page.getByRole('link',{name:'Return to run review',exact:true}).count(),0,'An older parent cannot link to a newer revision checkpoint');
  await f.open(revision);await f.page.getByRole('link',{name:'Return to run review',exact:true}).waitFor({timeout:2500});
  saveBatch(f.store,{...getBatch(f.store,f.b.id),state:'stopped'});await f.open(revision);await f.page.waitForFunction(()=>!document.querySelector('[data-review-checkpoint-loading]'));
  assert.equal(await f.page.getByRole('link',{name:'Return to run review',exact:true}).count(),0);
  assert.ok(f.operations.every(op=>['job_get','batch_status','batch_get'].includes(op)));assert.deepEqual(f.errors,[]);
});

test('capture metadata cannot turn the page selector or isolated preview into a query/path escape',async t=>{
  const f=await fixture(t);
  for(const name of ['bad?redirect','bad%2fpage','bad#fragment','bad.html'])f.store.artifact({jobId:f.job.id,kind:'site_capture',relative:`${f.job.outputs.qaRelative}/${name}-first-1440.png`,label:'Untrusted synthetic metadata',sha256:hash(name),bytes:1});
  await f.open();assert.deepEqual(await f.page.getByLabel('Review page',{exact:true}).locator('option').evaluateAll(options=>options.map(option=>option.value)),['index','services']);
  await f.page.getByLabel('Review page',{exact:true}).selectOption('services');assert.equal(await f.page.getByRole('link',{name:'Open interactive website',exact:true}).getAttribute('href'),`${f.app.previewUrl}/site/${f.job.id}/services.html`);
  assert.notEqual(new URL(f.app.url).origin,new URL(f.app.previewUrl).origin);assert.deepEqual(f.errors,[]);
});

test('held evidence, disposition, expired deadlines and changed policy do not offer a misleading checkpoint',async t=>{
  const f=await fixture(t,{batch:true}),original=getBatch(f.store,f.b.id);
  for(const patch of [
    {members:original.members.map(m=>({...m,ready:false}))},
    {members:original.members.map(m=>({...m,disposition:'not_a_fit'}))},
    {members:original.members.map(m=>({...m,disposition:'needs_changes',dispositionSiteJobId:f.job.id}))},
    {deadlineAt:'2020-01-01T00:00:00.000Z'},
    {policyDigest:'0'.repeat(64)},
    {firstCandidateId:'unrelated-business'},
    {checkpoint:{siteJobId:f.job.id,siteDigest:f.job.outputs.siteDigest}},
  ]){
    saveBatch(f.store,{...original,...patch});const before=f.store.db.prepare('SELECT total_changes() n').get().n;
    await f.open();await f.page.waitForFunction(()=>!document.querySelector('[data-review-checkpoint-loading]'));
    assert.equal(await f.page.getByRole('link',{name:'Return to run review',exact:true}).count(),0,JSON.stringify(patch));
    if(patch.policyDigest)assert.match(await f.page.locator('#review-workspace').innerText(),/production policy changed/);
    assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,before);
  }
  assert.ok(f.operations.every(op=>['job_get','batch_status','batch_get'].includes(op)));assert.deepEqual(f.errors,[]);
});

test('failed checkpoint reads stay contextual and stale feedback is not silently retried or accepted',async t=>{
  const f=await fixture(t,{batch:true});let reads=0;
  await f.page.route('**/api/op',async route=>{
    if(route.request().postDataJSON()?.operation==='batch_get'){reads++;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'FIXTURE_READ_FAILURE',message:'Synthetic run read unavailable'})});}
    else await route.continue();
  });
  await f.open();await f.page.getByText(/Run review could not be checked: Synthetic run read unavailable/).waitFor();assert.equal(reads,1);
  assert.equal(await f.page.getByRole('link',{name:'Return to run review',exact:true}).count(),0);
  f.store.updateJob(f.job.id,{outputs:{...f.job.outputs,siteDigest:'1'.repeat(64)}});
  const before=f.store.db.prepare('SELECT total_changes() n').get().n;
  await f.page.getByLabel('Revision feedback',{exact:true}).fill('Synthetic stale feedback; never acceptance.');
  const response=f.page.waitForResponse(r=>r.url().endsWith('/api/op')&&r.request().postDataJSON()?.operation==='review_note');
  await f.page.getByRole('button',{name:'Save version note',exact:true}).click();const rejected=await response;assert.equal(rejected.status(),400);assert.equal((await rejected.json()).error,'STALE_REVIEW');
  await f.page.getByRole('alert').filter({hasText:'The feedback digest does not match this site version'}).waitFor();
  assert.equal(f.operations.filter(op=>op==='review_note').length,1);assert.equal(f.store.events(f.job.id).filter(e=>e.type==='review.note').length,0);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(getBatch(f.store,f.b.id).checkpoint,null);assert.equal(f.store.job(f.job.id).outputs.humanDecision,null);assert.deepEqual(f.errors,[]);
});
