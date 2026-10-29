// Fixed browser probes. Plans supply literal IDs and media paths, never test code.
import {checkCinematicEffect} from './qa-cinematic.mjs';
import {CINEMATIC_EFFECTS} from './site-profile.mjs';
export function observeEffectFrames() {
  window.__factoryEffectFrames = [];
  const native = Element.prototype.animate;
  if (typeof native !== 'function') return;
  Element.prototype.animate = function (...args) {
    const animation = native.apply(this, args);
    const root = this.closest('[data-effect]');
    if (!root || args[1]?.id !== 'factory-effect-entry') return animation;
    const record = {targetId: root.id, type: root.dataset.effect, samples: []};
    if (window.__factoryEffectFrames.length >= 100||window.__factoryEffectFrames.filter(r=>r.targetId===root.id).length>=3) return animation;
    window.__factoryEffectFrames.push(record);
    const element = this;
    const sample = () => {
      const s = getComputedStyle(element);
      const r=element.getBoundingClientRect();
      record.samples.push({transform: s.transform, clipPath: s.clipPath, opacity: s.opacity, x:r.x, y:r.y});
      if (record.samples.length < 10 && animation.playState !== 'finished' && animation.playState !== 'idle') requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    return animation;
  };
}

const pause = page => page.waitForTimeout(100);
const transformed = value => value && value !== 'none' && value !== 'matrix(1, 0, 0, 1, 0, 0)';

export async function checkEffects(page, plan, {file, width, candidate, capture = async () => {}}) {
  const declared = plan.effects.filter(e => e.page === file), results = [];
  const structure = await page.evaluate(({declared, facts}) => {
    const normalize = text => text.replace(/\s+/g, ' ').trim().toLowerCase();
    const failures = [];
    const expected = new Map(declared.map(e => [e.targetId, e]));
    for (const node of document.querySelectorAll('[data-effect]')) if (!expected.has(node.id) || expected.get(node.id).type !== node.dataset.effect) failures.push('Undeclared effect: ' + node.id);
    for (const e of declared) {
      const nodes = [...document.querySelectorAll('[id]')].filter(n => n.id === e.targetId), root = nodes[0];
      if (nodes.length !== 1 || root?.dataset.effect !== e.type) { failures.push('Missing/duplicate/wrong effect: ' + e.targetId); continue; }
      if (root.matches('[data-reveal],[data-scroll-depth]') || root.querySelector('[data-reveal],[data-scroll-depth],[data-effect]') || root.parentElement?.closest('[data-effect],[data-reveal],[data-scroll-depth]')) failures.push('Conflicting nested motion: ' + e.targetId);
      const style = getComputedStyle(root), rect = root.getBoundingClientRect();
      if (!rect.width || !rect.height || style.visibility === 'hidden' || Number(style.opacity) === 0) failures.push('Invisible effect content: ' + e.targetId);
      if (e.type === 'magnetic' && (!root.matches('button,a[href]') || root.closest('nav') || root.children.length !== 1 || !root.firstElementChild.matches('[data-effect-label]') || ['inline','none'].includes(getComputedStyle(root.firstElementChild).display) || rect.width < 44 || rect.height < 44)) failures.push('Magnetic target needs a stationary 44px control and one label: ' + e.targetId);
      if (e.type === 'split-text' && (!root.matches('h1,h2,h3,h4,h5,h6') || (root.children.length && !root.querySelector('[data-effect-word]')) || (root.getAttribute('aria-label') && normalize(root.getAttribute('aria-label')) !== normalize(root.textContent)))) failures.push('Split heading changed semantic text: ' + e.targetId);
      if(e.type==='split-chars'&&(!root.matches('h1,h2,h3,h4,h5,h6')||root.textContent.length>240||root.textContent.trim().split(/\s+/).length>32||normalize(root.getAttribute('aria-label')||root.textContent)!==normalize(root.textContent)))failures.push('Character reveal needs a short semantic heading: '+e.targetId);
      if(e.type==='image-trail'||e.type==='distortion'){
        const images=[...root.querySelectorAll(e.type==='image-trail'?'img[data-trail-image]':'img')],paths=images.map(i=>(i.getAttribute('src')||'').replace(/^\.\//,''));
        if(paths.length!==e.mediaFiles.length||e.mediaFiles.some(p=>!paths.includes(p))||new Set(paths).size!==paths.length)failures.push('Advanced imagery must match the exact approved photo set: '+e.targetId);
      }
      if(e.type==='scroll-scene'&&!root.querySelector('[data-scene-layer]'))failures.push('Scroll scene needs a dedicated supporting layer: '+e.targetId);
      if (e.type === 'sticky-stack') {
        if ([...root.children].filter(n => n.hasAttribute('data-effect-card')).length < 3 || e.factIds.some(id => !normalize(root.textContent).includes(normalize(facts.find(f => f.id === id)?.text || '\u0000')))) failures.push('Stack is missing three cards or its frozen facts: ' + e.targetId);
      }
      if (e.type === 'drag-gallery') {
        const track = root.querySelector('[data-effect-track]'), prev = root.querySelector('button[data-effect-prev]'), next = root.querySelector('button[data-effect-next]');
        const paths = track ? [...track.querySelectorAll('img')].map(i => i.getAttribute('src').replace(/^\.\//, '')) : [];
        if (!track || track.tabIndex !== 0 || track.getAttribute('role') !== 'region' || !track.getAttribute('aria-label') || !prev || !next || paths.length !== e.mediaFiles.length || new Set(paths).size !== paths.length || e.mediaFiles.some(p => !paths.includes(p))) failures.push('Gallery is missing usable controls or its exact photo set: ' + e.targetId);
      }
    }
    return {pass: !failures.length, failures};
  }, {declared, facts: candidate?.facts || []});
  results.push({name: 'effects_structure', pass: structure.pass, ...structure});
  if (!structure.pass) return results;
  for (const e of declared) {
    const root = page.locator(`[id="${e.targetId}"]`);
    await root.scrollIntoViewIfNeeded(); await pause(page);
    if (e.type === 'split-text' || e.type === 'clip-reveal'||e.type==='split-chars') {
      // Observations were collected on real entry during load/the page sweep.
      const evidence = await page.evaluate(id => window.__factoryEffectFrames?.filter(r => r.targetId === id) || [], e.targetId);
      const changed = evidence.some(r => new Set(r.samples.map(s => JSON.stringify({transform:s.transform,clipPath:s.clipPath,opacity:s.opacity}))).size >= 2);
      results.push({name: e.type, targetId: e.targetId, pass: changed, evidence});
    } else if(CINEMATIC_EFFECTS.includes(e.type)){
      results.push(await checkCinematicEffect(page,e,{width,capture}));
    } else if (e.type === 'magnetic') {
      const before = await root.boundingBox(), label = root.locator('[data-effect-label]');
      await page.mouse.move(before.x + before.width * .9, before.y + before.height * .8); await pause(page);
      const during = await root.boundingBox(), transform = await label.evaluate(n => getComputedStyle(n).transform);
      const fine = await page.evaluate(() => matchMedia('(hover:hover) and (pointer:fine)').matches);
      const moved = transformed(transform);
      await capture(e);
      await root.focus(); const focused = await label.evaluate(n => getComputedStyle(n).transform);
      await page.mouse.move(0, 0);
      results.push({name: e.type, targetId: e.targetId, pass: (fine ? moved : !moved) && before.x === during.x && before.y === during.y && !transformed(focused), evidence: {before, during, transform, focused, fine}});
    } else if (e.type === 'sticky-stack') {
      const info = await root.evaluate(root => ({enabled: root.hasAttribute('data-effects-stack'), cards: [...root.children].filter(n => n.hasAttribute('data-effect-card')).map(n => ({height: n.getBoundingClientRect().height, transform: getComputedStyle(n).transform, position: getComputedStyle(n).position}))}));
      const expected = width >= 1024 && await page.evaluate(() => matchMedia('(hover:hover) and (pointer:fine)').matches) && info.cards.every(c => c.height + info.cards.length * 12 + 40 < page.viewportSize().height);
      let moved = !expected;
      if (expected) {
        await root.evaluate(n => window.scrollTo(0, window.scrollY + n.getBoundingClientRect().top + 100)); await pause(page);
        moved = await root.locator('[data-effect-card]').evaluateAll(nodes => nodes.some(n => getComputedStyle(n).transform !== 'none' && getComputedStyle(n).transform !== 'matrix(1, 0, 0, 1, 0, 0)'));
        await capture(e);
      }
      results.push({name: e.type, targetId: e.targetId, pass: info.enabled === expected && info.cards.every(c => c.position === (expected ? 'sticky' : 'relative')) && moved, evidence: {...info, expected, moved}});
    } else if (e.type === 'drag-gallery') {
      const track = root.locator('[data-effect-track]');
      await track.evaluate(n => { n.scrollLeft = 0; }); await pause(page);
      const initial = await track.evaluate(n => n.scrollLeft);
      await root.locator('[data-effect-next]').click(); await pause(page);
      const next = await track.evaluate(n => n.scrollLeft);
      await track.focus(); await page.keyboard.press('Home'); await pause(page);
      await page.keyboard.press('ArrowRight'); await pause(page);
      const keyboard = await track.evaluate(n => n.scrollLeft);
      await capture(e);
      await root.locator('[data-effect-prev]').click(); await pause(page);
      const previous = await track.evaluate(n => n.scrollLeft);
      await track.focus();await page.keyboard.press('Home');await pause(page);
      const box=await track.boundingBox(),dragStart=await track.evaluate(n=>n.scrollLeft);
      await page.mouse.move(box.x+box.width*.85,box.y+Math.min(70,box.height/2));await page.mouse.down();
      await page.mouse.move(box.x+box.width*.15,box.y+Math.min(70,box.height/2),{steps:8});
      const dragDuring=await track.evaluate(n=>n.scrollLeft);await page.mouse.up();
      await page.waitForTimeout(750);const stopped=await track.evaluate(n=>n.scrollLeft);await page.waitForTimeout(70);
      const bounded=stopped===await track.evaluate(n=>n.scrollLeft);
      results.push({name: e.type, targetId: e.targetId, pass: next > initial && keyboard > initial && previous < keyboard && dragDuring>dragStart && bounded, evidence: {initial, next, keyboard, previous,dragStart,dragDuring,stopped,bounded}});
    }
  }
  // A live preference change must cancel running transforms, not merely change a badge.
  await page.emulateMedia({reducedMotion: 'reduce'}); await pause(page);
  const reset = await page.evaluate(() => ({animations: document.getAnimations().filter(a => a.id === 'factory-effect-entry' && a.playState === 'running').length, transforms: [...document.querySelectorAll('[data-effect-label],[data-effect-word],[data-effect-card],[data-cinematic-char],[data-scene-layer]')].some(n => getComputedStyle(n).transform !== 'none'), stacks: document.querySelectorAll('[data-effects-stack]').length,cinematicDecorations:document.querySelectorAll('[data-cinematic-trail],[data-cinematic-distortion]').length}));
  results.push({name: 'effects_live_reduce', pass: !reset.animations && !reset.transforms && !reset.stacks&&!reset.cinematicDecorations, evidence: reset});
  await page.emulateMedia({reducedMotion: 'no-preference'});
  return results;
}

export async function checkEffectsFallback(page, plan, file) {
  return page.evaluate(effects => {
    const failures = [];
    for (const e of effects) {
      const root = document.getElementById(e.targetId), rect = root?.getBoundingClientRect(), style = root && getComputedStyle(root);
      if (!root || !rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) { failures.push(e.targetId); continue; }
      if (e.type === 'drag-gallery') {
        const track = root.querySelector('[data-effect-track]');
        if (!track || !['auto', 'scroll'].includes(getComputedStyle(track).overflowX) || track.tabIndex !== 0 || track.querySelectorAll('img').length < 3) failures.push(e.targetId);
      }
      if (e.type === 'sticky-stack' && root.hasAttribute('data-effects-stack')) failures.push(e.targetId);
    }
    return {pass: !failures.length, failures};
  }, plan.effects.filter(e => e.page === file));
}
