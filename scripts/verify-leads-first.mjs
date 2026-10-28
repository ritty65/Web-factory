/** Read-only real-app coverage. Never starts research, builds, or provider calls. */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { now, hash } from '../src/contracts.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright'), { default: AxeBuilder } = require('@axe-core/playwright');
const origin = 'http://127.0.0.1:8780';
const root = process.env.FACTORY_LEADS_QA_OUT || '/tmp/factory-leads-qa-' + Date.now();
await mkdir(root, { recursive: true, mode: 0o750 });
const report = { at: now(), pass: false, coverage: 'Read-only actual local operator app; Chromium emulation, normal motion. No new source/model/site calls, owner delivery, physical-device test or human acceptance.', views: [], axe: [], errors: [], forbiddenRequests: [] };
const reads = new Set(['batch_status', 'batch_get', 'lead_list']);
const snapshot = async () => {
  const response = await fetch(origin + '/api/status'); assert.equal(response.status, 200);
  const data = await response.json();
  return hash({ campaigns: data.campaigns, candidates: data.candidates, jobs: data.jobs, businesses: data.businesses });
};
const before = await snapshot();
const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'no-preference' });
  await context.route('**/*', route => {
    const request = route.request();
    if (!request.url().startsWith(origin + '/')) return route.abort();
    if (['GET', 'HEAD'].includes(request.method())) return route.continue();
    let operation = null;
    try { operation = request.postDataJSON()?.operation; } catch { /* Fail closed. */ }
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/op' && reads.has(operation)) return route.continue();
    report.forbiddenRequests.push({ method: request.method(), operation });
    return route.abort();
  });
  const page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message));
  for (const [width, height] of [[1440, 900], [1280, 720], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height });
    for (const view of ['start', 'leads', 'inbox']) {
      await page.goto(origin + '/#' + view);
      await page.waitForFunction(view => window.FactoryReady === true && document.querySelector('nav[aria-label="Factory"] [aria-current]')?.getAttribute('href') === '#' + view, view, { timeout: 10000 });
      await page.waitForFunction(() => !document.querySelector('#content [aria-busy="true"]'), null, { timeout: 10000 });
      await page.evaluate(() => document.fonts.ready);
      const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, headings: document.querySelectorAll('main h1').length, brokenImages: [...document.images].filter(i => i.complete && !i.naturalWidth).length, loadError: /Could not read this workflow|Could not load leads/.test(document.querySelector('main').innerText) }));
      assert.ok(metrics.scrollWidth <= width + 1 && metrics.headings === 1 && !metrics.brokenImages && !metrics.loadError, `${view} ${width}: ${JSON.stringify(metrics)}`);
      report.views.push({ view, width, pass: true, metrics });
      if (width === 1440 || width === 390) {
        const a = await new AxeBuilder({ page }).analyze();
        report.axe.push({ view, width, violations: a.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), incomplete: a.incomplete.map(v => v.id) });
        assert.equal(a.violations.length, 0, `${view} Axe ${width}`);
        await page.screenshot({ path: path.join(root, `${view}-${width}.png`), fullPage: true });
      }
    }
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.forbiddenRequests, [], 'Navigation attempted an operation outside the read-only allowlist');
  report.canonicalWorkUnchanged = before === await snapshot(); assert.ok(report.canonicalWorkUnchanged);
  report.pass = true;
} catch (e) { report.failure = e.message; process.exitCode = 1; }
finally {
  await browser.close();
  try { report.canonicalWorkUnchanged = before === await snapshot(); if (!report.canonicalWorkUnchanged) { report.pass = false; report.failure ||= 'Canonical work changed during read-only verification'; process.exitCode = 1; } }
  catch (e) { report.pass = false; report.failure ||= e.message; process.exitCode = 1; }
  await writeFile(path.join(root, 'RESULT.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o640 });
}
console.log(JSON.stringify({ pass: report.pass, views: report.views.length, axeAudits: report.axe.length, canonicalWorkUnchanged: report.canonicalWorkUnchanged, report: path.join(root, 'RESULT.json'), failure: report.failure }, null, 2));
