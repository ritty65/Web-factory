import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {initialize,openStore} from '../src/db.mjs';
import {createService,OPERATIONS} from '../src/service.mjs';
import {startServer} from '../src/server.mjs';
import {getBatch,saveBatch} from '../src/batch-store.mjs';
import {batchSettings} from './helpers-batch.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright'),{default:AxeBuilder}=require('@axe-core/playwright');

test('seeded Start labels source pointers as unverified and remains read-only at desktop and phone widths',async t=>{
  const root=await mkdtemp('/tmp/factory-seed-ui-');
  const options={dbPath:path.join(root,'fixture.sqlite'),stateRoot:path.join(root,'state'),autoRun:false,batchPrerequisites:async()=>({ready:true})};
  await initialize(options);const store=openStore(options),service=createService(store,options),app=await startServer(service,{port:0,previewPort:0});
  const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true}),context=await browser.newContext(),page=await context.newPage();
  t.after(async()=>{await browser.close();await app.close();store.close();});
  await service.dispatch('batch_preset_save',{version:0,requestId:'seed-ui-setup',acknowledged:true,settings:{...batchSettings,targetCount:1,candidateLimit:6,maxResearchRounds:2,maxSearches:16,workflow:'leads_first',discoverySearchLimit:6}});
  const b=await service.dispatch('batch_start',{presetVersion:1,requestId:'seed-ui-start',authorized:true});
  // Synthetic view fixture only: not a registered receipt, live seed or source proof.
   saveBatch(store,{...getBatch(store,b.id),seedCohort:{id:'seed-synthetic',digest:'a'.repeat(64),provider:'placeroot',version:{release:'fixture-release',discovery:{mode:'houston_local_radius_v1',admissionSummary:{sampled:20,admitted:13,quarantined:7}}},items:[{id:'fixture-one',name:'Synthetic Workshop'}],attribution:['Synthetic attribution <img src=x onerror=alert(1)>']}});
  const before=store.db.prepare('SELECT total_changes() n').get().n,writes=[],errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.url().endsWith('/api/op')&&!OPERATIONS[r.postDataJSON().operation]?.readOnly)writes.push(r.postDataJSON().operation);});
  await page.goto(app.url+'/#start/'+b.id);await page.waitForFunction(()=>window.FactoryBatchReady);
  const region=page.getByRole('region',{name:'Discovery seed source',exact:true});
  assert.equal(await region.count(),1);assert.match(await region.innerText(),/unverified seeds/i);
  assert.match(await region.innerText(),/not.*qualification|not.*qualified/i);
  assert.match(await region.innerText(),/fixture-release/);
  assert.match(await region.innerText(),/20 sampled · 13 retained · 7 quarantined/);
  assert.match(await region.innerText(),/city eligibility.*unknown/i);
  assert.equal(await region.locator('img').count(),0);
  for(const [width,height] of [[1280,720],[390,844],[320,740]]){
    await page.setViewportSize({width,height});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.deepEqual((await new AxeBuilder({page}).analyze()).violations.map(v=>v.id),[]);
    await page.screenshot({path:path.join(root,`seed-${width}.png`),fullPage:true});
  }
  await page.getByText('Search settings',{exact:true}).click();
  await page.getByRole('button',{name:'Check local readiness',exact:true}).click();
  await page.getByText(/Houston boundary: Not ready/).waitFor();
  let camofoxChecks=0;
  await page.route('**/api/op',async route=>{
    const payload=route.request().postDataJSON();if(payload.operation!=='camofox_status')return route.continue();
    camofoxChecks++;assert.deepEqual(payload.input,{enabled:true});
    return route.fulfill({contentType:'application/json',body:JSON.stringify({serviceReachable:true,browserRunning:false,browserConnected:false,readerReady:false,version:'1.14.0'})});
  });
  assert.equal(camofoxChecks,0);
  assert.equal(await page.getByRole('button',{name:'Check optional Camofox',exact:true}).count(),1);
  await page.getByRole('button',{name:'Check optional Camofox',exact:true}).click();
  await page.getByText(/Camofox: service reachable; browser not launch-tested/).waitFor();assert.equal(camofoxChecks,1);
  assert.match(await page.getByRole('region',{name:'Discovery seed source',exact:true}).innerText(),/city eligibility.*unknown/i);
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  assert.equal(store.db.prepare('SELECT total_changes() n').get().n,before);
  console.log('Synthetic seeded-source UI captures: '+root);
});
