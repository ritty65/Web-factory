import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {startServer} from '../src/server.mjs';
import {executeJob} from '../src/worker.mjs';
import {reconcileBatches} from '../src/batches.mjs';
import {getBatch,saveBatch} from '../src/batch-store.mjs';
import {hash} from '../src/contracts.mjs';
import {treeHashes} from '../src/proposal.mjs';
import {batchSettings,intakeFixture} from './helpers-batch.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright'),{default:AxeBuilder}=require('@axe-core/playwright');
async function fixture(t){
  const root=await mkdtemp('/tmp/factory-simple-ui-'),options={dbPath:path.join(root,'fixture.sqlite3'),stateRoot:path.join(root,'state'),autoRun:false,batchPrerequisites:async()=>({ready:true,checks:[]})};
  await initialize(options);const store=openStore(options),service=createService(store,options),app=await startServer(service,{port:0,previewPort:0});
  const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true}),context=await browser.newContext(),page=await context.newPage(),errors=[];
  await context.route('**/*',r=>[app.url,app.previewUrl].some(url=>r.request().url().startsWith(url+'/'))?r.continue():r.abort());
  page.on('pageerror',e=>errors.push(e.message));t.after(async()=>{await browser.close();await app.close();store.close();});
  await service.dispatch('batch_preset_save',{version:0,requestId:'simple-fixture-setup',settings:{...batchSettings,targetCount:1,candidateLimit:3,maxResearchRounds:1,workflow:'leads_first',discoverySearchLimit:4},acknowledged:true});
  return {root,store,service,app,page,errors};
}
async function found(f,{onlyHeld=false,longName=false}={}){
  const b=await f.service.dispatch('batch_start',{presetVersion:1,requestId:'simple-fixture-search',authorized:true});
  const done=await executeJob(f.store,b.researchJobIds[0],{discover:async(_,ctx)=>{
    const first=intakeFixture(),other=intakeFixture(2);other.observations[0].links.push({url:'https://unresolved.example/',text:'Website'});
    if(longName){first.candidate.name='SYNTHETIC LUXURY EVENT DECORATOR (@synthetic____verylongaccount)';first.observations[0].title=first.candidate.name;first.observations[0].text=first.candidate.name+'\n'+first.observations[0].text;}
    if(onlyHeld)first.observations[0].links.push({url:'https://unresolved.example/',text:'Website'});
    const dir=path.join(ctx.jobRoot,'sources');await mkdir(dir,{recursive:true});
    for(const x of [first,other]){for(const o of x.observations)await writeFile(path.join(dir,o.id+'.json'),JSON.stringify(o));for(const s of x.searches)await writeFile(path.join(dir,'search-'+hash(s.query).slice(0,16)+'.json'),JSON.stringify(s));}
    return {candidates:[first.candidate,other.candidate],live:false};
  }});assert.equal(done.state,'review_ready');await reconcileBatches(f.store);return getBatch(f.store,b.id);
}
test('adopted front door explains the retained outcome before one reachable search action',async t=>{
  const f=await fixture(t),{page,app,store,service,root}=f,b=await found(f);await service.dispatch('batch_stop',{id:b.id});
  const before=store.jobs().length;await page.goto(app.url+'/#start');await page.waitForFunction(()=>window.FactoryBatchReady);
  assert.equal(await page.getByRole('button',{name:'Find leads',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Use two-step setup',exact:true}).isVisible(),false);
  assert.equal(await page.getByRole('button',{name:'Check local readiness',exact:true}).isVisible(),false);
  assert.equal(await page.getByRole('region',{name:'Frozen for this batch'}).isVisible(),false);
  assert.equal(await page.locator('.search-settings').evaluate(e=>e.open),false);
  for(const [width,height] of [[1280,720],[390,844],[320,740]]){
    await page.setViewportSize({width,height});await page.evaluate(()=>window.scrollTo(0,0));
    assert.equal(await page.locator('.simple-outcome').evaluate(e=>Boolean(e.compareDocumentPosition(document.querySelector('.batch-launch'))&Node.DOCUMENT_POSITION_FOLLOWING)),true,'Retained outcome must precede the paid-start action');
    const action=page.getByRole('button',{name:'Find leads',exact:true});await action.scrollIntoViewIfNeeded();const box=await action.boundingBox();assert.ok(box&&box.y>=0&&box.y+box.height<=height,'The single start action remains reachable without starting work');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual((await new AxeBuilder({page}).analyze()).violations.map(v=>v.id),[]);
    await page.screenshot({path:path.join(root,'simple-home-'+width+'.png'),fullPage:true});
  }
  assert.equal(store.jobs().length,before);assert.equal(getBatch(store,b.id).state,'stopped');
});
test('shortlist separates selectable businesses from retained holds; exact confirmation is still required',async t=>{
  const f=await fixture(t),{page,app,store,root}=f,b=await found(f);await page.goto(app.url+'/#leads/'+b.id);await page.waitForFunction(()=>window.FactoryLeadsReady);
  assert.equal(await page.locator('.lead-shortlist .lead-row').count(),1);assert.equal(await page.locator('.other-results').evaluate(e=>e.open),false);
  assert.equal(await page.getByRole('button',{name:'Make this website',exact:true}).count(),1);
  await page.getByRole('button',{name:'Make this website',exact:true}).click();assert.equal(store.jobs().length,1);assert.equal(getBatch(store,b.id).selection,null);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(store.jobs().length,1);
  await page.getByText('Other results (1)',{exact:true}).click();await page.getByText('Needs verification / source limited',{exact:true}).waitFor();
  assert.equal(await page.locator('.other-results .lead-row').count(),1);
  await page.getByRole('button',{name:'Refresh ↻',exact:true}).click();await page.waitForFunction(()=>window.FactoryLeadsReady);assert.equal(await page.locator('.other-results').evaluate(e=>e.open),true);
  await page.getByRole('button',{name:'Make this website',exact:true}).click();await page.getByRole('button',{name:'Check business & create website',exact:true}).click();
  await page.getByText('Checking this business — no website yet.',{exact:true}).waitFor();assert.equal(store.jobs().length,2);assert.equal(store.jobs().filter(j=>j.kind==='site').length,0);
  assert.equal(await page.locator('.lead-shortlist .lead-row').count(),1,'The chosen business stays visible while full checks run');
  await page.screenshot({path:path.join(root,'simple-checking.png'),fullPage:true});
});
test('a run with no selectable prospects explains the gap without claiming websites or hiding retained results',async t=>{
  const f=await fixture(t),{page,app,service,store}=f,b=await found(f);await service.dispatch('batch_stop',{id:b.id});
  await page.goto(app.url+'/#leads/'+b.id);await page.waitForFunction(()=>window.FactoryLeadsReady);
  await page.getByText('No business is ready to choose.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Make this website',exact:true}).count(),0);
  assert.doesNotMatch(await page.locator('#content').innerText(),/^\s*null\s*$/m);
  await page.getByText('This run has ended. No selection or automatic restart is available.',{exact:true}).waitFor({timeout:1500});
  await page.getByText('Other results (2)',{exact:true}).click();assert.equal(await page.locator('.other-results .lead-row').count(),2);assert.equal(store.jobs().length,1);
});
for(const legacy of [false,true])test(`${legacy?'a historical empty selection pause':'an empty screened shortlist'} never tells the operator to choose a nonexistent business`,async t=>{
  const f=await fixture(t),{page,app,store,service,errors,root}=f,b=await found(f,{onlyHeld:true});
  // Reproduce both a held outcome and the earlier persisted awaiting_selection
  // bug. Opening either record must not silently migrate or requalify it.
  saveBatch(store,{...getBatch(store,b.id),state:legacy?'awaiting_selection':'held',phase:legacy?'selection':'discovery'});
  const original=getBatch(store,b.id),before=store.db.prepare('SELECT total_changes() n').get().n;
  for(const [width,height] of [[1280,720],[390,844]]){
    await page.setViewportSize({width,height});await page.goto(app.url+'/#start/'+b.id);await page.waitForFunction(()=>window.FactoryBatchReady);
    assert.equal(await page.locator('.batch-progress h2').innerText(),'No business is ready to choose.');
    assert.equal(await page.getByRole('link',{name:'Choose a business',exact:true}).count(),0);
    assert.equal(await page.locator('.progress-work-status').innerText(),'No selectable business — inspect retained results.');
    await page.getByRole('link',{name:'View saved results',exact:true}).click();await page.waitForFunction(()=>window.FactoryLeadsReady);
    assert.equal(await page.locator('.lead-run-summary h2').innerText(),'No business is ready to choose.');
    assert.doesNotMatch(await page.locator('.lead-run-summary').innerText(),/Choose one business below/);
    assert.equal(await page.getByRole('button',{name:'Make this website',exact:true}).count(),0);
    if(!await page.locator('.other-results').evaluate(e=>e.open))await page.getByText('Other results (2)',{exact:true}).click();
    assert.equal(await page.locator('.other-results .lead-row').count(),2);assert.equal(await page.locator('.other-results .lead-row').first().isVisible(),true);
    assert.deepEqual((await new AxeBuilder({page}).analyze()).violations.map(v=>v.id),[]);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(root,`empty-shortlist-${legacy?'legacy':'held'}-${width}.png`),fullPage:true});
  }
  const detail=await service.dispatch('batch_get',{id:b.id});assert.equal(detail.batch.counts.selectable,0);
  assert.equal(detail.progress.stages.find(s=>s.id==='selection').state,legacy?'blocked':'pending');
  assert.deepEqual(getBatch(store,b.id),original);assert.equal(store.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(store.jobs().length,1);assert.deepEqual(errors,[]);
});
test('retained long business names and social handles wrap at 320px without clipping or horizontal scrolling',async t=>{
  const f=await fixture(t),{page,app,store,root}=f,b=await found(f,{onlyHeld:true,longName:true});
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});await page.goto(app.url+'/#leads/'+b.id);await page.waitForFunction(()=>window.FactoryLeadsReady);
    if(!await page.locator('.other-results').evaluate(e=>e.open))await page.getByText('Other results (2)',{exact:true}).click();
    const heading=page.getByRole('heading',{name:'SYNTHETIC LUXURY EVENT DECORATOR (@synthetic____verylongaccount)',exact:true});
    assert.equal(await heading.isVisible(),true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    const box=await heading.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);
    assert.deepEqual((await new AxeBuilder({page}).analyze()).violations.map(v=>v.id),[]);
    await page.screenshot({path:path.join(root,'long-held-business-'+width+'.png'),fullPage:true});
  }
  assert.equal(store.jobs().length,1);
});
test('dedicated website review opens actual pixels and isolated interactive site without the job console or new work',async t=>{
  const f=await fixture(t),{page,app,store,root,errors}=f;
  const campaign=store.createCampaign({name:'Synthetic preserved website',query:'Fixture only',area:'Houston',niche:'Synthetic workshop'}),candidate=store.saveCandidate(campaign.id,intakeFixture(99).candidate),member={candidateId:candidate.id};
  const j=store.createJob({campaignId:campaign.id,kind:'site',input:{candidateId:member.candidateId}}),relative=`jobs/${j.id}/attempt-0/proposal-0/site`;
  await mkdir(path.join(store.stateRoot,relative),{recursive:true});await writeFile(path.join(store.stateRoot,relative,'index.html'),'<!doctype html><title>Synthetic preview</title><h1>Private test website</h1>');
  // Actual browser-generated PNG fixture, not a fabricated customer capture.
  const captureRelative=`jobs/${j.id}/attempt-0/qa-0/index-first-1440.png`;await mkdir(path.dirname(path.join(store.stateRoot,captureRelative)),{recursive:true});
  await page.goto(app.url);await page.waitForFunction(()=>window.FactoryBatchReady);await page.screenshot({path:path.join(store.stateRoot,captureRelative)});
  store.artifact({jobId:j.id,kind:'site_capture',relative:captureRelative,label:'Synthetic screenshot',sha256:hash(await readFile(path.join(store.stateRoot,captureRelative))),bytes:(await stat(path.join(store.stateRoot,captureRelative))).size});
  const siteDigest=hash(await treeHashes(path.join(store.stateRoot,relative)));
  store.updateJob(j.id,{state:'review_ready',outputs:{candidateId:member.candidateId,siteRelative:relative,qaRelative:`jobs/${j.id}/attempt-0/qa-0`,siteDigest,qaPass:true,reviewStatus:'operator_review_required',humanDecision:null,publicRelease:false}});
  const before=store.jobs().length;await page.goto(app.url+'/#review/'+j.id);await page.waitForFunction(()=>window.FactoryReviewReady===true);
  await page.getByText('Ready for your review. Nothing has been accepted or published.',{exact:true}).waitFor({timeout:1500});
  assert.equal(await page.getByRole('link',{name:'Open interactive website',exact:true}).getAttribute('href'),app.previewUrl+'/site/'+j.id+'/index.html');
  assert.equal(await page.getByRole('heading',{name:'The queue',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Request isolated revision',exact:true}).count(),0);
  assert.equal(await page.getByRole('img',{name:/Current proposal/}).count(),1);await page.getByRole('button',{name:'Phone',exact:true}).click();await page.getByText('No matching capture for this page/device yet.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Phone',exact:true}).getAttribute('aria-pressed'),'true');await page.getByRole('button',{name:'Desktop',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.activeElement?.tagName==='BUTTON'?document.activeElement.textContent:document.activeElement?.tagName),'Desktop','Device switching must retain keyboard focus on the selected control');
  await page.getByLabel('Revision feedback',{exact:true}).fill('Synthetic feedback only; this is not approval or new build authority.');
  const saved=page.waitForResponse(r=>r.url().endsWith('/api/op')&&r.request().postDataJSON()?.operation==='review_note');
  await page.getByRole('button',{name:'Save version note',exact:true}).click();const response=await saved;assert.equal(response.status(),200,await response.text());
  await page.getByText('Exact-version note saved. No acceptance recorded.',{exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('#content').inert);
  assert.equal(await page.evaluate(()=>document.activeElement?.tagName==='BUTTON'?document.activeElement.textContent:document.activeElement?.tagName),'Save version note');
  assert.equal(store.job(j.id).outputs.humanDecision,null);assert.equal(store.jobs().length,before);
  assert.equal(store.events(j.id).filter(e=>e.type==='review.note'&&e.detail.siteDigest===siteDigest).length,1,'The feedback actually reached the exact-version ledger');
  for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(root,'simple-review-'+width+'.png'),fullPage:true});assert.deepEqual((await new AxeBuilder({page}).analyze()).violations.map(v=>v.id),[]);}
  assert.deepEqual(errors,[]);console.log('Simplified workflow fixture evidence: '+root);
});
test('one-site review finishes only through an explicit exact-version checkpoint, with no second site or acceptance',async t=>{
  const {store,service,page,app}=await fixture(t),b=await service.dispatch('batch_start',{presetVersion:1,requestId:'finish-one-fixture',authorized:true});
  const c=store.saveCandidate(b.campaignId,intakeFixture(88).candidate),discovery=b.researchJobIds[0];store.updateJob(discovery,{state:'review_ready'});
  // Synthetic completed-intake state for the lifecycle UI boundary only. No real
  // researcher, photo acquisition or production run is claimed by this fixture.
  saveBatch(store,{...getBatch(store,b.id),phase:'production',firstCandidateId:c.id,selection:{candidateId:c.id,evidenceDigest:hash(c),requestId:'fixture-exact-selection'},enrichmentJobId:discovery,processedResearchIds:[discovery],members:[{candidateId:c.id,ready:true,reasons:[],contacts:[],evidenceDigest:hash(c)}]});
  const j=store.createJob({campaignId:b.campaignId,kind:'site',input:{candidateId:c.id}}),relative=`jobs/${j.id}/attempt-0/proposal-0/site`;
  await mkdir(path.join(store.stateRoot,relative),{recursive:true});await writeFile(path.join(store.stateRoot,relative,'index.html'),'<h1>Synthetic completion fixture</h1>');
  const digest=hash(await treeHashes(path.join(store.stateRoot,relative)));store.updateJob(j.id,{state:'review_ready',outputs:{siteRelative:relative,siteDigest:digest,qaPass:true,reviewStatus:'operator_review_required',humanDecision:null,publicRelease:false}});
  saveBatch(store,{...getBatch(store,b.id),state:'awaiting_first_review',phase:'first_site_review',initialAttempts:1});
  const before=store.jobs().length;await page.goto(app.url+'/#start/'+b.id);await page.waitForFunction(()=>window.FactoryBatchReady);
  assert.equal(getBatch(store,b.id).checkpoint,null);assert.equal(store.jobs().length,before);
  await page.getByText('Finish review',{exact:true}).click();await page.getByLabel('First-site review note',{exact:true}).fill('Synthetic exact-version checkpoint only; not human acceptance or publishing.');
  await page.getByLabel('I reviewed this exact website and want to finish this run.',{exact:true}).check();
  await page.getByRole('button',{name:'Finish this run',exact:true}).click();await page.getByText('Checkpoint saved. No artifact acceptance recorded.',{exact:true}).waitFor();
  await reconcileBatches(store);assert.equal(getBatch(store,b.id).state,'complete');assert.equal(getBatch(store,b.id).checkpoint.siteDigest,digest);assert.equal(store.job(j.id).outputs.humanDecision,null);assert.equal(store.jobs().length,before);
});
test('saving preferences folds settings back away without starting work or changing a running scope',async t=>{
  const {page,app,store,service}=await fixture(t);await page.goto(app.url+'/#start');await page.waitForFunction(()=>window.FactoryBatchReady);
  await page.getByText('Search settings',{exact:true}).click();await page.getByText('Edit setup & limits',{exact:true}).click();
  await page.getByLabel('Business categories',{exact:true}).fill('Synthetic new category');await page.getByLabel('I reviewed this scope, permitted public sources and attempt limits.').check();
  let release;const readGate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/status',async r=>{await readGate;await r.continue();});
  await page.getByRole('button',{name:'Save one-time setup',exact:true}).click();await page.getByText('Saved setup. Nothing has started.',{exact:true}).waitFor();
  // A committed-save toast precedes the async ledger refresh. Do not inspect
  // the old DOM/old ready flag while the real refresh is intentionally held.
  await page.waitForFunction(()=>document.querySelector('#refresh').disabled);
  assert.equal(await page.locator('.search-settings').evaluate(e=>e.open),true);release();
  await page.waitForFunction(()=>window.FactoryBatchReady&&!document.querySelector('#refresh').disabled&&!document.querySelector('.search-settings').open);
  assert.equal(await page.locator('.search-settings').evaluate(e=>e.open),false);assert.equal(store.jobs().length,0);assert.equal((await service.dispatch('batch_status')).preset.settings.niche,'Synthetic new category');
});
test('a stopped research validation failure remains plainly visible on the simple home screen',async t=>{
  const {page,app,store,service}=await fixture(t),b=await service.dispatch('batch_start',{presetVersion:1,requestId:'failed-source-fixture',authorized:true});
  store.updateJob(b.researchJobIds[0],{state:'failed',errorCode:'INVALID_CONTACT_SOURCE',message:'Synthetic malformed contact source; no import'});await service.dispatch('batch_stop',{id:b.id});
  await page.goto(app.url+'/#start');await page.waitForFunction(()=>window.FactoryBatchReady);
  await page.getByText('The last search stopped before saving any businesses.',{exact:true}).waitFor({timeout:1500});
  await page.getByText('A research response did not match the required data format. No website was made.',{exact:true}).waitFor();
  assert.equal(store.jobs().length,1);assert.equal(store.candidates().length,0);assert.equal(getBatch(store,b.id).state,'stopped');assert.equal(await page.getByRole('button',{name:/Resume|Retry/}).count(),0);
  assert.deepEqual((await new AxeBuilder({page}).analyze()).violations.map(v=>v.id),[]);
});
