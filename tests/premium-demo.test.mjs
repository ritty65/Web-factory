import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {startServer} from '../src/server.mjs';
import {premiumDemoAsset} from '../src/premium-demo.mjs';
test('isolated fictional demos work without keys, external requests or queued jobs',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'factory-premium-demo-')),options={stateRoot:path.join(root,'state'),dbPath:path.join(root,'db')};
  await initialize(options);const store=openStore(options),app=await startServer(createService(store,{autoRun:false}),{port:0,previewPort:0}),browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true});
  t.after(async()=>{await browser.close();await app.close();store.close();await rm(root,{recursive:true,force:true});});
  const context=await browser.newContext(),page=await context.newPage(),errors=[],failed=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)failed.push(r.url());});
  for(let i=0;i<3;i++)for(const width of [1280,390,320]){
    await page.setViewportSize({width,height:900});await page.goto(app.previewUrl+'/demo/'+i+'/index.html');await page.locator('[data-effects-ready]').first().waitFor();await page.evaluate(()=>document.fonts.ready);
    assert.equal(await page.locator('[data-effect]').count(),i+3);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    assert.deepEqual((await new AxeBuilder({page}).analyze()).violations.map(v=>v.id),[]);
    assert.match(await page.locator('footer').textContent(),/Fictional demonstration/);
  }
  await page.getByRole('link',{name:'Services',exact:true}).click();await page.getByRole('heading',{name:'Care, with a clear purpose.'}).waitFor();
  assert.equal(store.jobs().length,0);assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
  const response=await fetch(app.previewUrl+'/demo/2/package.json');assert.equal(response.status,404);
});
for(const url of ['/demo/9/index.html','/demo/0/%2e%2e%2fcredentials','/demo/0/credentials/key','/demo/0/assets/missing.js'])test('demo file boundary rejects '+url,async()=>{
  await assert.rejects(premiumDemoAsset(url));
});
