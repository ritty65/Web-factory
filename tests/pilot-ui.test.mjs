import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {salesFixture} from './helpers-commercial.mjs';
import {startServer} from '../src/server.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright'),{default:AxeBuilder}=require('@axe-core/playwright');

test('Sales desk persists actual next actions/activity/cost/payment observations and never invents verified sales',async t=>{
  const {service,store}=await salesFixture(t),app=await startServer(service,{port:0,previewPort:0});
  const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true});t.after(async()=>{await browser.close();await app.close();});
  const context=await browser.newContext(),page=await context.newPage();await page.goto(app.url+'/#sales');await page.getByRole('heading',{name:'Sales desk.',exact:true}).waitFor({timeout:4000});
  await page.getByRole('button',{name:'Open existing-business case',exact:true}).click();
  await page.getByLabel('Next action',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'New campaign',exact:true}).isVisible(),false,'The sales screen must not foreground unrelated production');
  assert.equal(await page.evaluate(()=>(document.querySelector('[aria-label="Next actions"]').compareDocumentPosition(document.querySelector('[aria-label="Reported financial summary"]'))&Node.DOCUMENT_POSITION_FOLLOWING)!==0),true);
  await page.getByLabel('Next action', {exact:true}).fill('Review phone pixels <img src=x onerror=alert(1)>');
  await page.getByLabel('Responsible role',{exact:true}).fill('operator');
  await page.getByLabel('Due date (UTC)',{exact:true}).fill('2026-10-01T10:00');
  await page.getByRole('button',{name:'Save next action',exact:true}).click();
  await page.getByRole('region',{name:'Next actions',exact:true}).getByText('Review phone pixels <img src=x onerror=alert(1)>',{exact:true}).waitFor();assert.equal(await page.locator('img[src=x]').count(),0);
  await page.getByRole('button',{name:'Open cost ledger',exact:true}).click();await page.getByLabel('Cash cost (USD)').fill('12.50');await page.getByLabel('Labor minutes').fill('30');await page.getByLabel('Labor rate (USD/hour)').fill('20');
  await page.getByRole('button',{name:'Record cost',exact:true}).click();await page.getByText('research · $22.50',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Open payment observations',exact:true}).click();await page.getByLabel('Money entry type').selectOption('invoice');await page.getByLabel('Total including tax (USD)').fill('1000');await page.getByLabel('Invoice or receipt reference').fill('fixture:invoice');await page.getByRole('button',{name:'Record money observation',exact:true}).click();
  await page.getByText('invoice · fixture:invoice',{exact:true}).waitFor();
  const status=await service.dispatch('sales_status',{});assert.equal(status.money.invoicedCents,100000);assert.equal(status.money.receivedCents,0);assert.equal(status.verifiedPaidSales,null);
  await page.getByText('Verified paid sales: not connected',{exact:true}).waitFor();
  const c=store.db.prepare('SELECT record FROM factory_sales_case').get();assert.match(JSON.parse(c.record).nextAction,/<img/);
  for(const width of [1440,1280,768,390,320]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  const axe=await new AxeBuilder({page}).analyze();assert.equal(axe.violations.length,0,JSON.stringify(axe.violations.map(v=>v.id)));
});
test('Operations shows real external blockers, pages history and performs a real new-root restore drill',async t=>{
  const {service}=await salesFixture(t),app=await startServer(service,{port:0,previewPort:0});
  const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true});t.after(async()=>{await browser.close();await app.close();});
  const context=await browser.newContext(),page=await context.newPage();await page.goto(app.url+'/#operations');await page.getByRole('heading',{name:'Operations.',exact:true}).waitFor({timeout:4000});
  await page.getByText('External commercial pilot: blocked',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Make recovery snapshot',exact:true}).click();
  await page.getByRole('button',{name:'Verify new-root restore',exact:true}).first().click();
  await page.getByText('Restore drill passed · automatic work disabled',{exact:true}).waitFor();
  for(const width of [1440,1280,768,390,320]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  const axe=await new AxeBuilder({page}).analyze();assert.equal(axe.violations.length,0,JSON.stringify(axe.violations.map(v=>v.id)));
  const result=await service.dispatch('snapshot_list',{});assert.equal(result.drills[0].pass,true);assert.equal(result.drills[0].autoRun,false);
});
test('a lost post-commit money response can be retried once without duplicate cash or a changed idempotency payload',async t=>{
  const {service,lead}=await salesFixture(t),c=await service.dispatch('case_open',{candidateId:lead.id}),app=await startServer(service,{port:0,previewPort:0});
  const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true});t.after(async()=>{await browser.close();await app.close();});
  const context=await browser.newContext(),page=await context.newPage();await page.goto(app.url+'/#sales/'+c.id);
  await page.getByRole('button',{name:'Open payment observations',exact:true}).click();
  await page.getByLabel('Total including tax (USD)').fill('1000');await page.getByLabel('Invoice or receipt reference').fill('fixture:response-lost');
  let first=true,release,committed;const gate=new Promise(r=>{release=r;}),observed=new Promise(r=>{committed=r;});
  await page.route('**/api/op',async route=>{
    if(first&&route.request().postDataJSON().operation==='payment_record'){
      first=false;const response=await route.fetch();assert.equal(response.status(),200);committed();await gate;
      await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic response lost after commit'})});return;
    }
    await route.continue();
  });
  const submit=page.getByRole('button',{name:'Record money observation',exact:true});await submit.click();await observed;
  const wasDisabled=await submit.isDisabled();release();await page.getByText('Synthetic response lost after commit',{exact:true}).waitFor();
  await submit.click();await page.getByText('invoice · fixture:response-lost',{exact:true}).waitFor({timeout:4000});
  assert.equal(wasDisabled,true,'Repeated submits are disabled while the observation is pending');
  assert.equal((await service.dispatch('sales_status',{})).money.invoicedCents,100000);
});
test('an older paginated work record opens through the same job API beyond the recent 300-row window',async t=>{
  const {service,store}=await salesFixture(t);let old;
  for(let n=0;n<301;n++){const j=store.createJob({kind:'reference',input:{fixture:n}});old||=j;store.cancel(j.id);}
  const app=await startServer(service,{port:0,previewPort:0}),browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true});t.after(async()=>{await browser.close();await app.close();});
  const context=await browser.newContext(),page=await context.newPage();await page.goto(app.url+'/#jobs/'+old.id);
  await page.getByRole('complementary',{name:'Job detail',exact:true}).waitFor({timeout:4000});
  await page.getByRole('complementary',{name:'Job detail',exact:true}).getByText('Cancelled by explicit request',{exact:true}).waitFor();
});
test('Sales desk preserves stale input, records literal activity, pages it, and keeps planning assumptions separate from suppression',async t=>{
  const {service,lead}=await salesFixture(t),c=await service.dispatch('case_open',{candidateId:lead.id}),app=await startServer(service,{port:0,previewPort:0});
  const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true});t.after(async()=>{await browser.close();await app.close();});
  const context=await browser.newContext(),page=await context.newPage();await page.goto(app.url+'/#sales/'+c.id);
  await page.getByLabel('Next action',{exact:true}).fill('Keep this draft after a stale edit');
  await service.dispatch('case_update',{id:c.id,version:0,stage:'review',nextAction:'Another operator already scheduled this',assignee:'operator',dueAt:null});
  await page.getByRole('button',{name:'Save next action',exact:true}).click();await page.getByText('A newer action exists; refresh before changing this case',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Next action',{exact:true}).inputValue(),'Keep this draft after a stale edit');
  await page.getByRole('button',{name:'Refresh ↻',exact:true}).click();await page.getByText('Ledger refreshed from SQLite.',{exact:true}).waitFor();await page.getByLabel('Next action',{exact:true}).waitFor();
  await page.getByLabel('Activity note',{exact:true}).fill('Literal reported note <script>never-run</script>');await page.getByRole('button',{name:'Record reported activity',exact:true}).click();
  await page.getByText('Literal reported note <script>never-run</script>',{exact:true}).waitFor();assert.equal(await page.locator('script:not([src])').count(),0);
  for(let n=0;n<22;n++)await service.dispatch('case_event',{id:c.id,requestId:'browser-history-'+n,kind:'note',note:'Fixture history '+n,occurredAt:new Date().toISOString()});
  await page.getByRole('button',{name:'Refresh ↻',exact:true}).click();await page.getByText('Ledger refreshed from SQLite.',{exact:true}).waitFor();await page.getByRole('button',{name:'Older ledger entries',exact:true}).click();await page.getByText('Literal reported note <script>never-run</script>',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Newer ledger entries',exact:true}).click();
  await page.getByText('Three-sales planning calculator · hypothetical',{exact:true}).click();
  await page.getByLabel('Assumed retained conversion (%)').fill('10');await page.getByLabel('Pre-sale cost per start (USD)').fill('20');await page.getByLabel('Fulfillment cost per sale (USD)').fill('100');
  await page.getByRole('button',{name:'Calculate hypothetical workload',exact:true}).click();await page.getByText(/Hypothetical steady state: 30 starts/).waitFor();
  assert.equal((await service.dispatch('sales_status',{})).costs.records,0,'The calculator must never write assumed costs');
  const note=page.getByLabel('Activity note',{exact:true});await note.focus();await page.keyboard.type('Fixture says do not contact');
  await page.getByLabel('Activity type',{exact:true}).selectOption('suppressed',{timeout:4000});await page.getByRole('button',{name:'Record reported activity',exact:true}).click();
  await page.getByText('Suppression is active. No new contact or handoff can be prepared.',{exact:true}).waitFor();assert.equal((await service.dispatch('case_get',{id:c.id})).case.suppressed,true);
});
test('a pending or failed refresh cannot silently consume a form draft or announce a successful read',async t=>{
  const {service,lead}=await salesFixture(t),c=await service.dispatch('case_open',{candidateId:lead.id}),app=await startServer(service,{port:0,previewPort:0});
  const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true});t.after(async()=>{await browser.close();await app.close();});
  const context=await browser.newContext(),page=await context.newPage();await page.goto(app.url+'/#sales/'+c.id);await page.getByLabel('Activity note',{exact:true}).fill('Keep this real draft on a failed read');
  let release,started;const gate=new Promise(r=>{release=r;}),observed=new Promise(r=>{started=r;});
  await page.route('**/api/status',async route=>{started();await gate;await route.fulfill({status:503,contentType:'application/json',body:'{}'});});
  await page.getByRole('button',{name:'Refresh ↻',exact:true}).click();await observed;
  const during=await page.evaluate(()=>({inert:document.querySelector('#content').inert,busy:document.querySelector('#content').getAttribute('aria-busy'),disabled:document.querySelector('#refresh').disabled}));
  release();await page.getByText('Local ledger unavailable',{exact:true}).waitFor();
  assert.equal(during.inert,true);assert.equal(during.busy,'true');assert.equal(during.disabled,true);
  assert.equal(await page.getByLabel('Activity note',{exact:true}).inputValue(),'Keep this real draft on a failed read');
  assert.equal(await page.getByText('Ledger refreshed from SQLite.',{exact:true}).count(),0);
});
