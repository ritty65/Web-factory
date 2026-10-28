/** Read-only live verification. Does not start models, cancel work or contact prospects. */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { hash, now } from './src/contracts.mjs';
import { imageReadyScript } from './src/browser.mjs';
const require=createRequire('/home/ai_dev/01_PROJECTS/WEB/simulacra-productions-spanish/package.json');
const {chromium}=require('playwright'),{default:AxeBuilder}=require('@axe-core/playwright');
const app='http://127.0.0.1:8780',preview='http://127.0.0.1:8781';
const library='http://127.0.0.1:8774';
const root='/home/ai_dev/04_DELIVERABLES/simulacra-factory-20261021/verification/'+now().replace(/[:.]/g,'-');
await mkdir(root,{recursive:true,mode:0o750});
const result={at:now(),pass:false,coverage:'Actual local app and sandboxed preview, Chromium emulation only. No human visual acceptance, live Vault authentication or autonomous search certification.',views:[],axe:[],downloads:[],preview:[],errors:[]};
const browser=await chromium.launch({executablePath:'/usr/bin/brave-browser',headless:true});
try{
  const ctx=await browser.newContext({serviceWorkers:'block'});
  await ctx.route('**/*',route=>[app,preview,library].some(origin=>route.request().url().startsWith(origin+'/'))?route.continue():route.abort());
  const page=await ctx.newPage();page.on('pageerror',e=>result.errors.push(e.message));
  const snapshot=await(await fetch(app+'/api/status')).json();
  for(const [width,height]of[[1440,900],[1280,720],[768,1024],[390,844],[320,740]]){
    await page.setViewportSize({width,height});
    for(const view of['start','inbox','jobs','sales','operations','businesses','references','assets','integrations']){
      await page.goto(app+'/#'+view);await page.waitForFunction(()=>window.FactoryReady===true);
       await page.waitForFunction(view=>document.querySelector('nav[aria-label="Factory"] [aria-current]')?.getAttribute('href')==='#'+view,view);
        if(['sales','operations'].includes(view))await page.waitForFunction(()=>window.PilotReady===true);
        if(['start','inbox'].includes(view))await page.waitForFunction(()=>window.FactoryBatchReady===true);
      await page.evaluate(imageReadyScript);await page.evaluate(()=>document.fonts.ready);
      const metrics=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,h1:document.querySelectorAll('main h1').length,current:document.querySelector('nav[aria-label="Factory"] [aria-current]')?.getAttribute('href'),broken:Array.from(document.images).filter(i=>i.complete&&!i.naturalWidth).length}));
      const pass=metrics.scrollWidth<=width+1&&metrics.h1===1&&metrics.current==='#'+view&&!metrics.broken;
      result.views.push({view,viewport:[width,height],pass,metrics});assert.ok(pass,`${view} at ${width}`);
       if(width===1440||width===390||['start','inbox','jobs'].includes(view))await page.screenshot({path:path.join(root,`${view}-${width}.png`),fullPage:true});
       if(width===1440||width===390&&['start','inbox','jobs'].includes(view)){const a=await new AxeBuilder({page}).analyze();result.axe.push({view,width,violations:a.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),incomplete:a.incomplete.map(v=>v.id)});assert.equal(a.violations.length,0,`${view} Axe at ${width}`);}
   }
  }
   result.handoffs=[];
   for(const h of snapshot.pilotHandoffs||[]){
     const response=await fetch(app+'/files/'+h.artifactId),bytes=Buffer.from(await response.arrayBuffer());
     assert.equal(response.status,200);assert.equal(hash(bytes),h.sha256);assert.equal(h.intent,'operator_inspection_only');assert.equal(h.externalReviewUrl,null);assert.equal(h.contactAuthorized,false);
     result.handoffs.push({id:h.id,pass:true,bytes:bytes.length,externalReviewUrl:null,contactAuthorized:false});
   }
  // Exact downloads, including every indexed web photo and current site ZIP.
  for(const f of snapshot.libraryFiles.filter(f=>f.kind==='photo'||f.metadata.current_package)){
    const response=await fetch(app+'/library-files/'+f.id),bytes=Buffer.from(await response.arrayBuffer());
    const pass=response.ok&&hash(bytes)===f.sha256;result.downloads.push({id:f.id,kind:f.kind,pass,bytes:bytes.length});assert.ok(pass,'Indexed download hash');
  }
  await page.setViewportSize({width:1440,height:900});await page.goto(app+'/#jobs');await page.waitForFunction(()=>window.FactoryReady===true);
  const popup=ctx.waitForEvent('page');await page.locator('.sidebar-foot a').click();const viewer=await popup;
  await viewer.getByRole('heading',{name:'Business library',exact:true}).waitFor();
  result.libraryLink={pass:true,url:viewer.url(),sameSiteDocumentOnly:true};await viewer.close();
   const requested=process.env.FACTORY_QA_SITE_JOB;
   const site=requested?snapshot.jobs.find(j=>j.id===requested):snapshot.jobs.find(j=>j.kind==='site'&&j.state==='review_ready');
   if(requested)assert.ok(site?.state==='review_ready'&&site.outputs.qaPass,'Exact requested site must be review-ready with passing recorded QA; no fallback to an older site');
   if(site){
     result.siteId=site.id;result.siteDigest=site.outputs.siteDigest;
     await page.goto(app+`/#jobs/${site.id}`);await page.getByRole('region',{name:'Version review'}).waitFor();
     result.reviewDesk=[];
     for(const [width,height]of[[1440,900],[390,844],[320,740]]){
       await page.setViewportSize({width,height});await page.getByRole('region',{name:'Version review'}).scrollIntoViewIfNeeded();await page.evaluate(imageReadyScript);
       assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
       const a=await new AxeBuilder({page}).analyze();assert.equal(a.violations.length,0,`Version review Axe ${width}`);
       await page.screenshot({path:path.join(root,`review-desk-${width}.png`),fullPage:true});result.reviewDesk.push({width,pass:true,axeViolations:a.violations.length});
     }
     await page.getByRole('button',{name:'Phone',exact:true}).click();
     const selector=page.getByLabel('Review page');
     for(const option of await selector.locator('option').all()){const value=await option.getAttribute('value');await page.getByLabel('Review page').selectOption(value);assert.ok(await page.getByRole('region',{name:'Version review'}).locator('figure img').count()>=1);}
     await page.getByLabel('Review page').selectOption('index');
     const response=await fetch(app+'/files/'+site.outputs.archiveId);assert.equal(response.status,200);const zip=Buffer.from(await response.arrayBuffer());result.downloads.push({id:site.outputs.archiveId,kind:'current_proposal_zip',pass:true,bytes:zip.length});
     const manifestResponse=await fetch(app+'/files/'+site.outputs.manifestId);assert.equal(manifestResponse.status,200);const manifest=await manifestResponse.json();assert.equal(manifest.siteDigest,site.outputs.siteDigest);
     assert.equal(hash(zip),manifest.sha256,'Actual downloaded ZIP matches the exact manifest');
    // Separate credential-free context. Playwright's serviceWorkers:block shim
    // itself throws in an opaque sandbox; the real CSP/opaque origin already
    // denies workers. Do not mask the shim's error or weaken that sandbox.
    const previewContext=await browser.newContext({serviceWorkers:'allow',viewport:{width:390,height:844}});
    await previewContext.route('**/*',route=>route.request().url().startsWith(preview+'/')?route.continue():route.abort());
    const previewPage=await previewContext.newPage();previewPage.on('pageerror',e=>result.errors.push(e.message));
     for(const file of Object.keys(manifest.siteHashes).filter(f=>f.endsWith('.html'))){
       await previewPage.goto(`${preview}/site/${site.id}/${file}`);await previewPage.evaluate(imageReadyScript);
       assert.equal(await previewPage.evaluate(()=>window.origin),'null');
       assert.ok(await previewPage.evaluate(()=>{try{void navigator.serviceWorker;return false}catch{return true}}));
       assert.ok(await previewPage.locator('main h1').isVisible());
       const buttons=previewPage.locator('[data-gallery-open]:not([hidden])');
       for(let n=0;n<Math.min(await buttons.count(),6);n++){
       await buttons.nth(n).click();const dialog=previewPage.locator('dialog[open]');assert.equal(await dialog.count(),1);
      // Inspect both the actual moving entrance and a settled frame.
       await previewPage.screenshot({path:path.join(root,`preview-${file}-dialog-${n}-entering.png`)});
      await previewPage.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
      await previewPage.evaluate(imageReadyScript);assert.ok(await dialog.locator('img').evaluate(i=>i.naturalWidth>0));
       await previewPage.screenshot({path:path.join(root,`preview-${file}-dialog-${n}-settled.png`)});
      await previewPage.keyboard.press('Escape');assert.equal(await previewPage.locator('dialog[open]').count(),0);
       result.preview.push({siteId:site.id,file,photo:n,pass:true,origin:'opaque_sandbox',motion:'normal entrance plus settled frame',escape:true});
       }
     }
     result.studies=[];
     const studyOwner=site.outputs.studyRoots?.length?site:snapshot.jobs.find(j=>j.id===site.input.polishOf);
     for(let n=0;n<(studyOwner?.outputs.studyRoots||[]).length;n++){
       await previewPage.goto(`${preview}/study/${studyOwner.id}/${n}/index.html`);await previewPage.evaluate(imageReadyScript);
       assert.equal(await previewPage.evaluate(()=>window.origin),'null');assert.ok(await previewPage.locator('main h1').isVisible());result.studies.push({ownerSiteJobId:studyOwner.id,index:n,pass:true,origin:'opaque_sandbox'});
     }
    await previewContext.close();
  }
  assert.deepEqual(result.errors,[]);result.pass=true;
}catch(e){result.failure=e.message;process.exitCode=1;}
finally{await browser.close();await writeFile(path.join(root,'results.json'),JSON.stringify(result,null,2),{mode:0o640});}
console.log(JSON.stringify({pass:result.pass,siteId:result.siteId,views:result.views.length,reviewDeskChecks:result.reviewDesk?.length||0,axeAudits:result.axe.length+(result.reviewDesk?.length||0),downloads:result.downloads.length,localHandoffs:result.handoffs?.length||0,previewFlows:result.preview.length,studyPreviews:result.studies?.length||0,report:path.join(root,'results.json'),failure:result.failure},null,2));
