// Capture only fixed, authored fictional demos. No real keys or generated jobs.
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {chromium} from 'playwright';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {startServer} from '../src/server.mjs';
const output=path.resolve(process.env.FACTORY_DEMO_CAPTURE_OUTPUT||'docs/visuals'),root=await mkdtemp(path.join(os.tmpdir(),'factory-demo-capture-'));
const options={dbPath:path.join(root,'db'),stateRoot:path.join(root,'state')};
let store,app,browser;
try{
  await mkdir(output,{recursive:true});await initialize(options);store=openStore(options);
  app=await startServer(createService(store,{autoRun:false}),{port:0,previewPort:0});
  browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true});
  const context=await browser.newContext(),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)errors.push('Failed static demo resource');});
  for(let index=0;index<3;index++)for(const width of [1440,390]){
    await page.setViewportSize({width,height:width===390?844:1000});await page.goto(app.previewUrl+'/demo/'+index+'/index.html');
    await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(1000);
    if(await page.locator('footer').textContent().then(s=>!s.includes('Fictional demonstration')))throw Error('Unexpected non-demo page');
    await page.screenshot({path:path.join(output,'premium-demo-'+index+'-'+width+'.png'),fullPage:true});
  }
  if(errors.length||store.jobs().length)throw Error('Demo capture generated errors or work');
  process.stdout.write('Six fictional demo captures saved; no jobs, API keys or provider calls.\n');
}finally{await browser?.close();await app?.close();store?.close();await rm(root,{recursive:true,force:true});}
