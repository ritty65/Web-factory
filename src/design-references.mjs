import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {hash,now,publicUrl,safeRelative,fail} from './contracts.mjs';
import {resolvePublic} from './network.mjs';
import {noLinks} from './db.mjs';

// These hosts were selected by the operator, never by a model response.
export const DESIGN_REFERENCE_SEEDS=Object.freeze([
  {id:'obys',name:'Obys Agency',url:'https://obys.agency/',principles:'Expressive typography, project-led composition and deliberate pointer feedback. Study the actual captures; do not assume the supplied effect descriptions match the current site.'},
  {id:'exoape',name:'Exo Ape',url:'https://www.exoape.com/',principles:'Large image-led scenes, strong type scale and continuity between sections. Adapt composition and pacing, not branding or client assets.'},
  {id:'locomotive',name:'Locomotive',url:'https://locomotive.ca/',principles:'Editorial hierarchy, changes of section geometry and coordinated scroll movement. Preserve straightforward navigation.'},
  {id:'lusion',name:'Lusion',url:'https://lusion.co/',principles:'A purposeful interactive scene, responsive pointer feedback and a memorable opening. A WebGL effect requires a useful static alternative.'},
  {id:'bruno-simon',name:'Bruno Simon',url:'https://bruno-simon.com/',principles:'A coherent playful interaction concept. A complete navigable 3D world is specialist scope, not the default for a service business.'},
]);

// Pixel variance alone accepts progress bars. Require visible page content and
// reject a large visible loading overlay before treating a capture as guidance.
export function referenceReadiness(){
  const visible=e=>e.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})!==false&&e.getBoundingClientRect().width>1&&e.getBoundingClientRect().height>1;
  const loading=[...document.querySelectorAll('[id*="loader" i],[class*="loader" i],[id*="loading" i],[class*="loading" i],[data-loader]')].filter(visible).some(e=>{const r=e.getBoundingClientRect();return r.width*r.height>innerWidth*innerHeight*.2;});
  const links=[...document.querySelectorAll('a,button')].filter(e=>visible(e)&&e.textContent.trim().length>1).length;
  const text=(document.body?.innerText||'').trim();
  const progressOnly=/^(?:[\d\s%/.]|loading|please wait)*$/i.test(text);
  return {ready:!loading&&!progressOnly&&text.length>=60&&links>=2,loading,visibleControls:links,textLength:text.length};
}

export async function auditDesignReference(referenceId,{jobRoot,signal,launchBrowser,clock=now}={}){
  const seed=DESIGN_REFERENCE_SEEDS.find(r=>r.id===referenceId);if(!seed)fail('DESIGN_REFERENCE','Choose an operator-selected reference');
  const root=path.join(jobRoot,'design-reference');await noLinks(root);await mkdir(root,{recursive:true,mode:0o700});
  const browser=await (launchBrowser?launchBrowser():chromium.launch({headless:true,executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,proxy:process.env.HTTPS_PROXY||process.env.HTTP_PROXY?{server:process.env.HTTPS_PROXY||process.env.HTTP_PROXY}:undefined}));
  const captures=[],errors=[],failures=[],blocked=[],checked=new Map();
  const abort=()=>browser.close().catch(()=>{});signal?.addEventListener('abort',abort,{once:true});
  let title='',finalUrl=seed.url,text='',statusCode=null,stackHints=[],readiness={ready:false};
  try{
    const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block',acceptDownloads:false});
    await context.route('**/*',async route=>{
      try{const request=route.request();if(!['GET','HEAD'].includes(request.method()))throw Error('read_only');const u=publicUrl(request.url());if(!checked.has(u.hostname))checked.set(u.hostname,resolvePublic(u));await checked.get(u.hostname);await route.continue();}
      catch{blocked.push({type:route.request().resourceType()});await route.abort();}
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message.slice(0,240)));page.on('requestfailed',r=>failures.push({type:r.resourceType(),reason:r.failure()?.errorText?.slice(0,120)}));
    const response=await page.goto(seed.url,{waitUntil:'domcontentloaded',timeout:30000});statusCode=response?.status();
    await page.waitForLoadState('load',{timeout:12000}).catch(()=>{});
    await page.mouse.move(820,420);
    await page.waitForFunction(`(${referenceReadiness.toString()})().ready`,undefined,{timeout:45000}).catch(()=>{});
    await page.waitForTimeout(1200);readiness=await page.evaluate(referenceReadiness);
    title=await page.title();finalUrl=page.url();text=(await page.locator('body').innerText()).slice(0,12000);
    stackHints=await page.evaluate(()=>({gsapGlobal:typeof window.gsap!=='undefined',scrollTriggerGlobal:typeof window.ScrollTrigger!=='undefined',canvasCount:document.querySelectorAll('canvas').length,videoCount:document.querySelectorAll('video').length}));
    const capture=async(kind)=>{
      if(signal?.aborted)fail('CANCELLED','Reference inspection cancelled');
      const relative='design-reference/'+kind+'.png',file=path.join(jobRoot,relative);await page.screenshot({path:file});
      const bytes=await readFile(file),stats=await sharp(bytes).stats();
      captures.push({relative,kind,viewport:[1440,900],scrollY:await page.evaluate(()=>Math.round(scrollY)),sha256:hash(bytes),visuallyNonempty:stats.channels.some(c=>c.stdev>3),contentReady:(await page.evaluate(referenceReadiness)).ready});
    };
    await capture('desktop-opening');await page.mouse.wheel(0,700);await page.waitForTimeout(1200);await capture('desktop-scroll');
    const usable=page.locator('a').filter({has:page.locator('img')}).first();
    if(await usable.count())await usable.hover({timeout:3000}).catch(()=>{});else await page.mouse.move(480,480);
    await page.waitForTimeout(500);await capture('desktop-pointer');
    await context.close();
  }catch(e){if(signal?.aborted)fail('CANCELLED','Reference inspection cancelled');errors.push(String(e.message).slice(0,600));}
  finally{signal?.removeEventListener('abort',abort);await browser.close();}
  const inspected=statusCode===200&&captures.filter(c=>c.visuallyNonempty&&c.contentReady).length>=2;
  const result={...seed,inspectedAt:clock(),title,finalUrl,httpStatus:statusCode,status:inspected?'inspected':statusCode===200?'visual_unresolved':'access_blocked',readiness,observation:text.slice(0,2400),captures,stackHints,scriptErrors:errors.slice(0,10),failedResources:failures.slice(0,30),blockedResources:blocked.slice(0,30),limitations:'Actual fresh desktop Chromium, 1440×900 viewport captures and bounded pointer/scroll input. Readiness checks reject detected loaders and blank pages; they do not establish taste, smoothness, stack equivalence, media rights or human acceptance.'};
  await writeFile(path.join(root,'audit.json'),JSON.stringify(result,null,2),{mode:0o600});return result;
}

export function selectReferenceBindings(store){
  const all=store.references();
  const eligible=DESIGN_REFERENCE_SEEDS.map(seed=>all.find(r=>r.id===seed.id)).filter(r=>r?.status==='inspected'&&Date.now()-Date.parse(r.inspectedAt)<30*86400000&&Date.parse(r.inspectedAt)<=Date.now()+300000&&r.captures?.filter(c=>c.visuallyNonempty&&c.contentReady===true&&c.artifact?.sha256).length>=2);
  if(eligible.length<2)fail('DESIGN_REFERENCES_MISSING','Audit at least two of the selected design references before a cinematic build');
  return eligible.slice(0,3).map(r=>({id:r.id,digest:hash(r)}));
}

export async function frozenReferencePacket(store,bindings){
  if(!Array.isArray(bindings)||bindings.length<2||bindings.length>3||new Set(bindings.map(b=>b.id)).size!==bindings.length)fail('DESIGN_REFERENCE_BINDING','Two or three frozen inspected references are required');
  const references=[],files=[];
  for(const binding of bindings){
    const r=store.references().find(r=>r.id===binding.id);
    if(!DESIGN_REFERENCE_SEEDS.some(s=>s.id===binding.id&&s.url===r?.url)||!r||hash(r)!==binding.digest||r.status!=='inspected'||!Number.isFinite(Date.parse(r.inspectedAt))||Date.now()-Date.parse(r.inspectedAt)>30*86400000||Date.parse(r.inspectedAt)>Date.now()+300000)fail('STALE_DESIGN_REFERENCE','The frozen reference changed or expired; inspect it before another build');
    const selected=r.captures.filter(c=>c.visuallyNonempty&&c.contentReady===true&&c.artifact).slice(0,2);
    if(selected.length!==2)fail('DESIGN_REFERENCE_BINDING','Reference needs two usable registered captures');
    for(const capture of selected){const a=capture.artifact,file=path.join(store.stateRoot,safeRelative(a.relative));await noLinks(file);if(hash(await readFile(file))!==a.sha256||capture.sha256!==a.sha256)fail('STALE_DESIGN_REFERENCE','Reference capture bytes changed');files.push(file);}
    references.push({id:r.id,name:r.name,url:r.url,principles:r.principles,inspectedAt:r.inspectedAt,captures:selected.map(c=>({kind:c.kind,viewport:c.viewport,sha256:c.sha256})),status:r.status,digest:binding.digest});
  }
  return{references,files,digest:hash(references)};
}
