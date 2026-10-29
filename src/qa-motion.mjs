// Browser APIs are evaluated in the credential-free QA target, never on the host.
// https://developer.mozilla.org/en-US/docs/Web/API/PerformanceObserver
export function observePerformance() {
  window.__factoryPerformance = { supported: [], lcpMs: null, cls: 0, longTasks: 0, longTaskMs: 0, start: performance.now() };
  if (typeof PerformanceObserver !== 'function') return;
  const result = window.__factoryPerformance;
  for (const type of ['largest-contentful-paint', 'layout-shift', 'longtask']) {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
    result.supported.push(type);
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (type === 'largest-contentful-paint') result.lcpMs = entry.startTime;
        if (type === 'layout-shift' && !entry.hadRecentInput) result.cls += entry.value;
        if (type === 'longtask') { result.longTasks++; result.longTaskMs += entry.duration; }
      }
    }).observe({ type, buffered: true });
  }
}
export async function settleImages(page, { all = false, timeout = 3500 } = {}) {
  return page.evaluate(async ({ all, timeout }) => {
    const images = [...document.images].filter(i => {
      if (all) return true;
      const rect = i.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0;
    });
    if (all) for (const image of images) if (image.loading === 'lazy') image.loading = 'eager';
    let timer;
    const timedOut = await Promise.race([
      Promise.all([document.fonts?.ready, ...images.map(i => i.decode().catch(() => {}))]).then(() => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(true), timeout); }),
    ]);
    clearTimeout(timer);
    return { timedOut, inspected: images.length, broken: images.filter(i => !i.naturalWidth).map(i => i.getAttribute('src')) };
  }, { all, timeout });
}
export async function inspectFirstScreen(page) {
  return page.evaluate(() => {
    const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0; };
    const images = [...document.images].map(i => { const r = i.getBoundingClientRect(); return { src: i.getAttribute('src'), sized: Number(i.getAttribute('width')) > 0 && Number(i.getAttribute('height')) > 0, loading: i.loading || 'eager', priority: i.fetchPriority, area: Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * r.width, inFirstScreen: r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 }; });
    const inView = images.filter(i => i.inFirstScreen), declared = inView.filter(i => i.priority === 'high');
    const critical = declared.length ? declared : [...inView].sort((a, b) => b.area - a.area).slice(0, 1);
    // Native lazy loading near the viewport is correct for supporting media.
    // Gate the critical hero, not every sliver of a lower image on tall screens.
    return { images, sized: images.every(i => i.sized), eagerFirstScreen: critical.every(i => i.loading !== 'lazy'), criticalImages: critical.map(i => i.src), visibleLazyImages: inView.filter(i => i.loading === 'lazy').length, primaryVisible: [...document.querySelectorAll('[data-primary-action]')].some(visible) };
  });
}
export async function sweepPage(page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const viewport = page.viewportSize().height;
  if (height > 32000) return { pass: false, reason: 'Page exceeds the bounded 32,000px QA scroll window' };
  for (let y = 0; y < height; y += Math.max(300, viewport * .8)) {
    await page.evaluate(y => scrollTo({ top: y, behavior: 'instant' }), y);
    await page.waitForTimeout(35); // real observer/render sample, not a network readiness wait
  }
  const images = await settleImages(page, { all: true });
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForFunction(() => document.getAnimations().every(a => a.effect?.getTiming().iterations === Infinity || a.playState !== 'running'), null, { timeout: 2000 }).catch(() => {});
  return { pass: !images.timedOut && !images.broken.length, images, height };
}
export async function sampleScrollMotion(page, capture, { targetId = null, requireObserved = false } = {}) {
  // IDs are data, never arbitrary selectors or model-supplied browser programs.
  const validId = targetId === null || typeof targetId === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(targetId);
  const target = !validId ? page.locator('html:not(html)') : targetId ? page.locator('#' + targetId) : page.locator('[data-reveal]').last();
  const depth = page.locator('[data-scroll-depth]').first();
  const result = { reveals: await page.locator('[data-reveal]').count(), depthTargets: await page.locator('[data-scroll-depth]').count(), movingSample: null, captures: [] };
  const present = await target.count() === 1 && await target.getAttribute('data-reveal') !== null;
  const environment = await page.evaluate(() => ({ reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, apiAbsent: typeof Element.prototype.animate !== 'function' || typeof IntersectionObserver !== 'function' }));
  const intentionalStatic = present && (environment.reduced || environment.apiAbsent) || !targetId && !requireObserved && result.reveals === 0;
  const samples = [];
  if (present && !intentionalStatic) {
    await target.scrollIntoViewIfNeeded();
    const element = await target.elementHandle();
    let running = false;
    try {
      // A declared delay is still part of the animation. Sampling during it would
      // read the base style twice and falsely call a real reveal inert.
      await page.waitForFunction(e => e.getAnimations().some(a => {
        if (a.id !== 'factory-entry' || a.playState !== 'running' || typeof a.currentTime !== 'number') return false;
        const delay = a.effect?.getTiming().delay || 0;
        return a.currentTime > delay + 20;
      }), element, { timeout: 1000 });
      running = true;
    } catch (e) { if (e.name !== 'TimeoutError') throw e; }
    finally { await element.dispose(); }
    if (running) {
      const sample = () => target.evaluate(e => { const s = getComputedStyle(e); return { at: performance.now(), transform: s.transform, opacity: s.opacity, clipPath: s.clipPath, state: e.dataset.motionState || null }; });
      samples.push(await sample());
      await page.waitForTimeout(45); // Two real rendered samples, not a frame-rate claim.
      samples.push(await sample());
      result.movingSample = samples[0];
    }
  }
  const observed = samples.length === 2 && ['transform', 'opacity', 'clipPath'].some(key => samples[0][key] !== samples[1][key]);
  if (observed) { await capture('scroll-intermediate'); result.captures.push('scroll-intermediate'); }
  result.motionObservation = { targetId, status: intentionalStatic ? 'intentionally_static' : observed ? 'observed' : 'not_observed', pass: !requireObserved || intentionalStatic || observed, required: requireObserved, samples, environment, note: 'Actual sampled native reveal and static alternative; not smoothness, frame-rate or physical-device certification.' };
  if (requireObserved && (!validId || !present)) result.motionObservation.pass = false;
  const tracked = present ? await target.evaluateHandle(e => e.getAnimations().filter(a => a.id === 'factory-entry' && a.playState === 'running')) : null;
  const targetBefore = tracked ? await tracked.evaluate(animations => animations.length) : 0;
  const before = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  const remaining = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length);
  const targetCancelled = tracked ? await tracked.evaluate(animations => animations.filter(a => a.playState === 'idle').length) : 0;
  await tracked?.dispose();
  result.liveReduced = { before, remaining, targetBefore, targetCancelled, pass: remaining === 0, cancellationObserved: targetBefore > 0 && targetCancelled === targetBefore };
  if (requireObserved && !intentionalStatic && !result.liveReduced.cancellationObserved) result.motionObservation.pass = false;
  // Fast-forward then reverse must never strand an element in a hidden state.
  await page.evaluate(() => { scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }); scrollTo({ top: 0, behavior: 'instant' }); });
  result.visibleFallback = await page.evaluate(() => [...document.querySelectorAll('[data-reveal]')].every(e => {
    const s = getComputedStyle(e); return Number(s.opacity) > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }));
  if (await depth.count()) result.reducedDepthReset = await depth.evaluate(e => getComputedStyle(e).transform === 'none');
  return result;
}
