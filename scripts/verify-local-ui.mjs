// Read-only smoke of a running empty/local app and the self-contained UX concept.
// Never starts a batch, model request, external search or customer delivery.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const base = 'http://127.0.0.1:8780';
const out = new URL('../docs/visuals/', import.meta.url);
await mkdir(out, { recursive: true });
const docs = http.createServer(async (req,res) => {
  const files={'/UX-PROTOTYPE.html':['UX-PROTOTYPE.html','text/html'], '/visuals/current-desktop.png':['visuals/current-desktop.png','image/png'], '/visuals/current-mobile.png':['visuals/current-mobile.png','image/png']};
  const file=files[req.url];if(!file){res.writeHead(404);return res.end();}
  try {res.setHeader('content-type',file[1]);res.end(await readFile(new URL('../docs/'+file[0],import.meta.url)));}catch {res.writeHead(404);res.end();}
});
await new Promise(resolve=>docs.listen(0,'127.0.0.1',resolve));
const concept=`http://127.0.0.1:${docs.address().port}/UX-PROTOTYPE.html`;
const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true });
const result = { kind: 'local-read-only-smoke', fixtureNotLiveIntegrationProof: true, views: [], functional: [] };
try {
  const context = await browser.newContext();
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  for (const [name, url] of [['current', base], ['concept', concept]]) {
    await page.goto(url, { waitUntil: 'load' });
    if (name === 'current') await page.waitForFunction(() => window.FactoryBatchReady);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} overflow ${width}`);
      const audit = await new AxeBuilder({ page }).analyze();
      const violations = audit.violations.map(v => ({ id: v.id, impact: v.impact, targets: v.nodes.map(n => n.target) }));
      result.views.push({ name, width, overflow: false, violations, incomplete: audit.incomplete.map(v => v.id) });
      assert.deepEqual(violations, [], `${name} accessibility ${width}`);
      if (width !== 320) await page.screenshot({ path: new URL(`${name}-${width === 1440 ? 'desktop' : 'mobile'}.png`, out).pathname, fullPage: true });
    }
    if (name === 'current') {
      const health = await page.request.get(base + '/api/health');
      assert.equal(health.status(), 200); assert.equal((await health.json()).automaticBatchStart, false);
      const preview = await page.request.get('http://127.0.0.1:8781/health');
      assert.equal((await preview.json()).staticOnly, true);
      const status = await (await page.request.get(base + '/api/status')).json();
      assert.equal(status.jobs.length, 0);
      const denied = await page.request.post(base + '/api/op', { data: { operation: 'status', input: {} } });
      assert.equal(denied.status(), 403);
      result.functional.push('app and isolated preview health; zero jobs; uncredentialed mutation rejected');
    } else {
      await page.getByRole('button', { name: '02 Opportunities' }).click();
      await page.locator('#search').fill('North'); assert.equal(await page.locator('.lead').count(), 1);
      await page.locator('#search').fill(''); await page.locator('#filter').selectOption('ready'); assert.equal(await page.locator('.lead').count(), 1);
      await page.getByRole('button', { name: 'Inspect evidence' }).click(); assert.equal(await page.locator('dialog:visible').count(), 1);
      await page.getByRole('button', { name: 'Use this demo brief' }).click(); assert.equal(await page.locator('#brief.active').count(), 1);
      await page.getByRole('button', { name: 'Inspect illustrative output' }).click(); await page.locator('#phone').click();
      assert.equal(await page.locator('#sitepreview.phone').count(), 1); assert.equal(await page.locator('#approve').isDisabled(), true);
      for (const check of await page.locator('.reviewcheck').all()) await check.check();
      await page.locator('#approve').click(); assert.equal(await page.locator('#decisionbadge').innerText(), 'Demo decision recorded');
      result.functional.push('concept search/filter; evidence dialog; brief handoff; phone review; explicitly labelled demo decision');
      for (const view of ['leads', 'brief', 'review', 'plan']) {
        await page.locator(`.side nav [data-view=${view}]`).click();
        for (const width of [1440,390,320]) {
          await page.setViewportSize({width,height:900});
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`concept ${view} overflow ${width}`);
          const a=await new AxeBuilder({page}).analyze();
          assert.deepEqual(a.violations.map(v=>v.id),[],`concept ${view} axe ${width}`);
          result.views.push({name:`concept-${view}`,width,overflow:false,violations:[],incomplete:a.incomplete.map(v=>v.id)});
        }
        if(view==='leads'||view==='review') {
          await page.setViewportSize({width:1440,height:1000});
          await page.screenshot({path:new URL(`concept-${view}.png`,out).pathname,fullPage:true});
        }
      }
    }
  }
  assert.deepEqual(errors, []); result.pageErrors = errors;
  await writeFile(new URL('smoke-results.json', out), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({pass:true,views:result.views.length,functional:result.functional}));
} finally { await browser.close(); await new Promise(resolve=>{docs.close(resolve);docs.closeIdleConnections();}); }
