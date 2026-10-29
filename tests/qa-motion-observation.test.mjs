import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { sampleScrollMotion } from '../src/qa-motion.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
async function fixture(t, { runtime = false, reduced = false } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await page.route('**/*', r => r.abort());
  await page.setContent('<main><h1>Motion observation fixture</h1><a href="#subject">Inspect the supplied subject</a><div style="height:1100px"></div><div id="subject" data-reveal="wipe" style="height:260px;background:#285b36;color:white">The same useful content remains visible</div><div style="height:800px"></div></main>');
  if (runtime) await page.addScriptTag({ content: await readFile(new URL('../runtime/motion.js', import.meta.url), 'utf8') });
  return page;
}

test('an inert declared reveal cannot claim observed movement or active cancellation', async t => {
  const page = await fixture(t);
  const report = await sampleScrollMotion(page, async () => {}, { targetId: 'subject', requireObserved: true });
  assert.equal(report.motionObservation.status, 'not_observed');
  assert.equal(report.motionObservation.pass, false);
  assert.equal(report.liveReduced.cancellationObserved, false);
  assert.equal(report.visibleFallback, true);
});

test('declared native reveal changes across real samples and cancels live without hiding its content', async t => {
  const page = await fixture(t, { runtime: true });
  const captures = [];
  const report = await sampleScrollMotion(page, async kind => { captures.push(kind); }, { targetId: 'subject', requireObserved: true });
  assert.equal(report.motionObservation.status, 'observed');
  assert.equal(report.motionObservation.pass, true, JSON.stringify(report));
  assert.equal(report.motionObservation.samples.length, 2);
  assert.notEqual(report.motionObservation.samples[0].transform, report.motionObservation.samples[1].transform);
  assert.equal(report.liveReduced.cancellationObserved, true);
  assert.equal(report.liveReduced.remaining, 0);
  assert.equal(report.visibleFallback, true);
  assert.deepEqual(captures, ['scroll-intermediate']);
  assert.equal(await page.locator('#subject').textContent(), 'The same useful content remains visible');
});

test('a real reduced-motion preference is recorded as an intentional static alternative', async t => {
  const page = await fixture(t, { runtime: true, reduced: true });
  const report = await sampleScrollMotion(page, async () => {}, { targetId: 'subject', requireObserved: true });
  assert.equal(report.motionObservation.status, 'intentionally_static');
  assert.equal(report.motionObservation.pass, true);
  assert.equal(report.liveReduced.cancellationObserved, false);
  assert.equal(report.visibleFallback, true);
});

test('a missing declared motion instance fails even in a reduced-motion context', async t => {
  const page = await fixture(t, { runtime: true, reduced: true });
  const report = await sampleScrollMotion(page, async () => {}, { targetId: 'missing-subject', requireObserved: true });
  assert.equal(report.motionObservation.status, 'not_observed');
  assert.equal(report.motionObservation.pass, false);
});

test('a delayed reveal is sampled after its delay instead of being mistaken for inert', async t => {
  const page = await fixture(t, { runtime: true });
  await page.locator('#subject').evaluate(e => { e.dataset.revealDelay = '120'; });
  const report = await sampleScrollMotion(page, async () => {}, { targetId: 'subject', requireObserved: true });
  assert.equal(report.motionObservation.status, 'observed');
  assert.equal(report.motionObservation.pass, true, JSON.stringify(report));
  assert.notEqual(report.motionObservation.samples[0].transform, report.motionObservation.samples[1].transform);
});
test('a completed animation is not falsely counted as cancellation observed during a live preference change', async t => {
  const page = await fixture(t, { runtime: true });
  const report = await sampleScrollMotion(page, async () => {
    await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
  }, { targetId: 'subject', requireObserved: true });
  assert.equal(report.motionObservation.status, 'observed');
  assert.equal(report.liveReduced.cancellationObserved, false);
  assert.equal(report.motionObservation.pass, false, 'Declared evidence needs live cancellation, not an animation that already completed');
});

test('missing animation APIs preserve an explicitly identified static alternative', async t => {
  const page = await fixture(t);
  await page.evaluate(() => { Element.prototype.animate = undefined; window.IntersectionObserver = undefined; });
  const report = await sampleScrollMotion(page, async () => {}, { targetId: 'subject', requireObserved: true });
  assert.equal(report.motionObservation.status, 'intentionally_static');
  assert.equal(report.motionObservation.pass, true);
  assert.equal(report.visibleFallback, true);
});
