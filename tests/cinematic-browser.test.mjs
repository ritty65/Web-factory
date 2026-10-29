import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import sharp from 'sharp';import {chromium} from 'playwright';
import {checkCinematicEffect} from '../src/qa-cinematic.mjs';
import {observeEffectFrames} from '../src/qa-effects.mjs';
import {referenceReadiness} from '../src/design-references.mjs';
const scripts=await Promise.all(['vendor/gsap.min.js','vendor/ScrollTrigger.min.js','vendor/lenis.min.js','cinematic.js'].map(f=>readFile(new URL('../runtime/'+f,import.meta.url),'utf8')));
const css=await readFile(new URL('../runtime/cinematic.css',import.meta.url),'utf8');
const pixels=Buffer.alloc(240*180*3);for(let y=0;y<180;y++)for(let x=0;x<240;x++){const i=(y*240+x)*3;pixels[i]=(x*19+y*7)%256;pixels[i+1]=(x*3+y*23)%256;pixels[i+2]=(x*17+y*13)%256;}
const picture='data:image/png;base64,'+(await sharp(pixels,{raw:{width:240,height:180,channels:3}}).png().toBuffer()).toString('base64');
async function fixture(t,{touch=false,reduce=false,noApi=false,noGL=false,noJS=false}={}){
 const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:touch?390:1280,height:720},hasTouch:touch,reducedMotion:reduce?'reduce':'no-preference',javaScriptEnabled:!noJS});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent(`<html data-smooth-scroll><head><style>${css}*{box-sizing:border-box}body{margin:0;font:22px sans-serif}h1{font-size:60px}#picture{position:relative;width:320px;max-width:100%;margin:40px}#picture img{display:block;width:100%;height:auto}#trail{height:280px;padding:24px;background:#eee}#trail img{width:90px;height:auto}#scene{height:600px;margin-top:400px;padding:60px;background:#ded}#scene>div{height:280px}footer{height:1200px}</style></head><body><a href="#scene">Skip to scene</a><h1 id="title" data-effect="split-chars">Every detail considered</h1><div id="picture" data-effect="distortion"><img src="${picture}" width="240" height="180" alt="Owned patterned shader test fixture"></div><section id="trail" data-effect="image-trail">Visible project list${[1,2,3].map(i=>`<img data-trail-image src="${picture}" width="240" height="180" alt="Owned fixture ${i}">`).join('')}</section><section id="scene" data-effect="scroll-scene"><div data-scene-layer>Useful supporting content</div></section><footer>Always readable</footer></body></html>`);
 await page.evaluate(observeEffectFrames);
 if(noApi)await page.evaluate(()=>{window.IntersectionObserver=undefined;Element.prototype.animate=undefined;});
 if(noGL)await page.evaluate(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl'?null:original.call(this,type,...args);};});
 if(!noJS)for(const script of scripts)await page.addScriptTag({content:script});
 return{page,errors};
}
test('character reveals preserve semantic text, actually move and cancel on live reduced motion',async t=>{
 const{page,errors}=await fixture(t);assert.equal(await page.getByRole('heading',{name:'Every detail considered'}).count(),1);
 await page.waitForFunction(()=>window.__factoryEffectFrames.some(r=>r.samples.length>=3));const frames=await page.evaluate(()=>window.__factoryEffectFrames);assert.ok(frames.some(r=>new Set(r.samples.map(s=>s.transform)).size>1));
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.id==='factory-effect-entry'&&a.playState==='running').length),0);assert.deepEqual(errors,[]);
});
test('real image trails stay bounded and clean up on focus, exit and reduced motion',async t=>{
 const{page,errors}=await fixture(t),root=page.locator('#trail');await root.scrollIntoViewIfNeeded();const r=await checkCinematicEffect(page,{type:'image-trail',targetId:'trail'},{width:1280,capture:async()=>{}});assert.equal(r.pass,true,JSON.stringify(r));
 await page.locator('a').focus();assert.equal(await page.locator('[data-cinematic-trail]').count(),0);assert.deepEqual(errors,[]);
});
test('the real protected WebGL shader changes rendered pixels and survives context loss',async t=>{
 const{page,errors}=await fixture(t);await page.locator('#picture').scrollIntoViewIfNeeded();const r=await checkCinematicEffect(page,{type:'distortion',targetId:'picture'},{width:1280,capture:async()=>{}});assert.equal(r.evidence.capability,undefined,'This run must actually exercise WebGL, not accept capability fallback');assert.equal(r.pass,true,JSON.stringify(r));assert.deepEqual(errors,[]);
});
test('GSAP supporting layers move with real scroll and reset on phone and keyboard keeps native scrolling',async t=>{
 const{page,errors}=await fixture(t);assert.equal(await page.locator('html').getAttribute('data-cinematic-scroll'),'smooth');await page.keyboard.press('Tab');assert.equal(await page.locator('html').getAttribute('data-cinematic-scroll'),'native');
 await page.locator('#scene').scrollIntoViewIfNeeded();const r=await checkCinematicEffect(page,{type:'scroll-scene',targetId:'scene'},{width:1280,capture:async()=>{}});assert.equal(r.pass,true,JSON.stringify(r));
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(80);assert.equal(await page.locator('[data-scene-layer]').evaluate(n=>getComputedStyle(n).transform),'none');assert.deepEqual(errors,[]);
});
for(const options of [{touch:true},{reduce:true},{noApi:true},{noGL:true},{noJS:true}])test('content remains usable for '+JSON.stringify(options),async t=>{
 const{page,errors}=await fixture(t,options);assert.equal(await page.locator('h1').textContent(),'Every detail considered');assert.equal(await page.locator('#picture img').isVisible(),true);await page.mouse.move(170,300);await page.waitForTimeout(100);
 if(options.touch||options.reduce||options.noJS)assert.equal(await page.locator('[data-cinematic-distortion],[data-cinematic-trail]').count(),0);
 assert.deepEqual(errors,[]);
});
test('reference readiness rejects a visible loading screen even when it has nonempty pixels and hidden page content',async t=>{
 const{page}=await fixture(t);await page.setContent('<div class="preloader" style="position:fixed;inset:0;background:#333;color:white">49%</div><main><h1>Actual site opening</h1><p>A longer piece of actual page content that is behind the loading overlay.</p><a href="#">Projects</a><a href="#">Contact</a></main>');assert.equal((await page.evaluate(referenceReadiness)).ready,false);await page.locator('.preloader').evaluate(n=>n.remove());assert.equal((await page.evaluate(referenceReadiness)).ready,true);
});
