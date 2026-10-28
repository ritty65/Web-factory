import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {observeEffectFrames,checkEffectsFallback} from '../src/qa-effects.mjs';
const js=await readFile(new URL('../runtime/effects.js',import.meta.url),'utf8');
const css=await readFile(new URL('../runtime/effects.css',import.meta.url),'utf8');
const markup=`<style>${css}body{margin:0;font:20px sans-serif}h1{font-size:40px;margin:20px}button{padding:16px}#spacer{height:1100px}#stack{padding:20px 0 300px}article{height:180px;background:#eee;border:1px solid #555;margin-bottom:30px}#clip{height:300px;background:coral}#gallery{width:700px;max-width:100%;padding-bottom:50px}figure{margin:0;height:180px;background:#abf}footer{height:900px}</style><h1 id="title" data-effect="split-text">Care with real character</h1><button id="magnet" data-effect="magnetic"><span data-effect-label>Contact the business</span></button><div id="spacer"></div><section id="stack" data-effect="sticky-stack"><article data-effect-card>First real service</article><article data-effect-card>Second real service</article><article data-effect-card>Third real service</article></section><section id="clip" data-effect="clip-reveal">Visible supporting content</section><section id="gallery" data-effect="drag-gallery"><button type="button" data-effect-prev>Previous</button><button type="button" data-effect-next>Next</button><div data-effect-track tabindex="0" role="region" aria-label="Test media"><figure>One</figure><figure>Two</figure><figure>Three</figure><figure>Four</figure></div></section><footer>Always visible</footer>`;
async function browserFixture(t,options={}) {
  const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:720},reducedMotion:'no-preference',...options});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent(markup);await page.evaluate(observeEffectFrames);return{page,errors,start:()=>page.addScriptTag({content:js})};
}
test('split text has real entry frames, preserves its name, and cancels live',async t=>{
  const{page,errors,start}=await browserFixture(t);await start();
  assert.equal(await page.getByRole('heading',{name:'Care with real character'}).count(),1);
  await page.waitForFunction(()=>window.__factoryEffectFrames.some(r=>r.samples.length>=3));
  const frames=await page.evaluate(()=>window.__factoryEffectFrames[0].samples.map(s=>JSON.stringify(s)));
  assert.ok(new Set(frames).size>=2);
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length),0);
  assert.equal(await page.locator('h1').textContent(),'Care with real character');assert.deepEqual(errors,[]);
});
test('magnetic feedback moves only the label and resets on focus, exit and hidden',async t=>{
  const{page,start}=await browserFixture(t);await start();const target=page.locator('#magnet'),label=target.locator('span');const before=await target.boundingBox();
  await page.mouse.move(before.x+before.width-4,before.y+before.height-4);
  const transform=await label.evaluate(n=>getComputedStyle(n).transform);assert.notEqual(transform,'none');assert.deepEqual(await target.boundingBox(),before);
  await target.focus();assert.equal(await label.evaluate(n=>n.style.transform),'');
  await page.mouse.move(0,0);assert.equal(await label.evaluate(n=>n.style.transform),'');
  await page.mouse.move(before.x+before.width-4,before.y+before.height-4);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await label.evaluate(n=>n.style.transform),'');
});
test('sticky stack scales during real scroll and becomes a normal list on resize',async t=>{
  const{page,start}=await browserFixture(t);await start();
  await page.waitForFunction(()=>document.querySelector('#stack').hasAttribute('data-effects-stack'));
  await page.locator('#stack').evaluate(n=>scrollTo(0,scrollY+n.getBoundingClientRect().top+100));await page.waitForTimeout(70);
  assert.notEqual(await page.locator('[data-effect-card]').first().evaluate(n=>getComputedStyle(n).transform),'matrix(1, 0, 0, 1, 0, 0)');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(70);
  assert.equal(await page.locator('#stack').getAttribute('data-effects-stack'),null);
  assert.equal(await page.locator('[data-effect-card]').first().evaluate(n=>getComputedStyle(n).position),'relative');
});
test('oversized cards fall back rather than trapping content in a sticky viewport',async t=>{
  const{page,start}=await browserFixture(t);await page.addStyleTag({content:'article{height:900px}'});await start();await page.waitForTimeout(70);
  assert.equal(await page.locator('#stack').getAttribute('data-effects-stack'),null);
});
test('keyboard focus releases a stack so a focused service link cannot stay covered',async t=>{
  const{page,start}=await browserFixture(t);await page.locator('[data-effect-card]').first().evaluate(n=>{const a=document.createElement('a');a.href='#clip';a.textContent='Read the service';n.append(a);});await start();
  await page.waitForFunction(()=>document.querySelector('#stack').hasAttribute('data-effects-stack'));
  await page.locator('#stack a').focus();await page.waitForTimeout(50);
  assert.equal(await page.locator('#stack').getAttribute('data-effects-stack'),null);
  assert.equal(await page.locator('[data-effect-card]').first().evaluate(n=>getComputedStyle(n).position),'relative');
  const box=await page.locator('#stack a').boundingBox();assert.ok(box.y>=0&&box.y+box.height<=720);
});
test('clip reveal runs once on actual entry with readable final content',async t=>{
  const{page,start}=await browserFixture(t);await start();await page.locator('#clip').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>window.__factoryEffectFrames.some(r=>r.targetId==='clip'&&r.samples.length>=3));
  const frames=await page.evaluate(()=>window.__factoryEffectFrames.find(r=>r.targetId==='clip').samples);
  assert.ok(new Set(frames.map(s=>s.clipPath)).size>1);
  await page.waitForTimeout(650);await page.evaluate(()=>scrollTo(0,0));await page.locator('#clip').scrollIntoViewIfNeeded();await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>window.__factoryEffectFrames.filter(r=>r.targetId==='clip').length),1);
  assert.equal(await page.locator('#clip').evaluate(n=>getComputedStyle(n).clipPath),'none');
});
test('gallery works with buttons, keyboard, actual mouse drag and bounded inertia',async t=>{
  const{page,start,errors}=await browserFixture(t);await start();const root=page.locator('#gallery'),track=root.locator('[data-effect-track]');
  await root.scrollIntoViewIfNeeded();await root.getByRole('button',{name:'Next'}).click();await page.waitForTimeout(120);
  assert.ok(await track.evaluate(n=>n.scrollLeft)>0);await track.focus();await page.keyboard.press('Home');await page.waitForTimeout(120);
  assert.equal(await track.evaluate(n=>n.scrollLeft),0);await page.keyboard.press('ArrowRight');await page.waitForTimeout(120);assert.ok(await track.evaluate(n=>n.scrollLeft)>0);
  await page.keyboard.press('Home');await page.waitForTimeout(120);const box=await track.boundingBox();
  await page.mouse.move(box.x+500,box.y+80);await page.mouse.down();await page.mouse.move(box.x+120,box.y+80,{steps:8});await page.mouse.up();
  const dragged=await track.evaluate(n=>n.scrollLeft);assert.ok(dragged>0);
  await page.waitForTimeout(800);const settled=await track.evaluate(n=>n.scrollLeft);await page.waitForTimeout(120);
  assert.equal(await track.evaluate(n=>n.scrollLeft),settled);assert.deepEqual(errors,[]);
});
test('touch keeps native scrolling; reduced motion and missing APIs keep content usable',async t=>{
  const{page,start,errors}=await browserFixture(t,{viewport:{width:390,height:844},hasTouch:true});
  await page.evaluate(()=>{window.IntersectionObserver=undefined;Element.prototype.animate=undefined;window.ResizeObserver=undefined;});await start();
  await page.locator('#magnet').tap();assert.equal(await page.locator('#magnet span').evaluate(n=>n.style.transform),'');
  await page.locator('#gallery').scrollIntoViewIfNeeded();await page.getByRole('button',{name:'Next'}).click();await page.waitForTimeout(150);
  assert.ok(await page.locator('[data-effect-track]').evaluate(n=>n.scrollLeft)>0);
  assert.equal(await page.locator('h1').evaluate(n=>getComputedStyle(n).opacity),'1');assert.deepEqual(errors,[]);
});
test('gallery keeps normal link activation and suppresses a click only after actual dragging',async t=>{
  const{page,start}=await browserFixture(t);
  await page.locator('[data-effect-track]').evaluate(n=>{for(const card of n.children)card.innerHTML='<a href="#clip" style="display:block;height:180px">Open supplied image</a>';window.galleryClicks=0;n.addEventListener('click',e=>{if(e.target.closest('a')){window.galleryClicks++;e.preventDefault();}});});await start();
  const track=page.locator('[data-effect-track]');await track.scrollIntoViewIfNeeded();await track.locator('a').first().click();assert.equal(await page.evaluate(()=>window.galleryClicks),1);
  const box=await track.boundingBox();await page.mouse.move(box.x+350,box.y+80);await page.mouse.down();await page.mouse.move(box.x+80,box.y+80,{steps:8});await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.galleryClicks),1);
});
test('no JavaScript preserves text, native scrolling and hides unusable navigation',async t=>{
  const{page}=await browserFixture(t,{javaScriptEnabled:false});
  assert.equal(await page.locator('h1').textContent(),'Care with real character');
  assert.equal(await page.locator('[data-effect-next]').isVisible(),false);
  assert.equal(await page.locator('[data-effect-track]').evaluate(n=>getComputedStyle(n).overflowX),'auto');
  const track=page.locator('[data-effect-track]');await track.focus();await page.keyboard.press('ArrowRight');await page.waitForTimeout(180);assert.ok(await track.evaluate(n=>n.scrollLeft)>0);
});
