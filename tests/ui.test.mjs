import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { startServer } from '../src/server.mjs';
import { seedReferences } from '../src/references.mjs';
import { hash, now } from '../src/contracts.mjs';
import { treeHashes } from '../src/proposal.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright'); const { default: AxeBuilder } = require('@axe-core/playwright');

test('operator UI has real campaign/job flows, literal labels, keyboard access and five-width reflow', async t => {
  const root = await mkdtemp('/tmp/factory-ui-');
  const options = { dbPath: path.join(root, 'test.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false }; await initialize(options);
  const store = openStore(options); seedReferences(store);
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1sAAAAASUVORK5CYII=','base64');
  await writeFile(path.join(options.stateRoot,'fixture.png'),image);
  store.artifact({jobId:null,relative:'fixture.png',kind:'photo',label:'https://www.instagram.com/'+ 'x'.repeat(100),bytes:image.length,sha256:hash(image)});
  const service = createService(store, options), app = await startServer(service, { port: 0, previewPort: 0 });
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true });
  t.after(async () => { await browser.close(); await app.close(); store.close(); });
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(app.url + '/#jobs'); await page.waitForFunction(() => window.FactoryReady === true);
  await page.getByRole('button', { name: 'New campaign', exact: true }).click();
  await page.getByLabel('Campaign name').fill('Fixture <img src=x onerror=alert(1)>');
  await page.getByLabel('Area', { exact: true }).fill('Houston');
  await page.getByLabel('Business niche').fill('Fixture workshops');
  await page.getByLabel('Research query').fill('Synthetic test only; no network');
  await page.getByRole('button', { name: 'Create campaign', exact: true }).click();
  await page.getByText('Fixture <img src=x onerror=alert(1)>', { exact: true }).first().waitFor();
  assert.equal(await page.locator('img[src="x"]').count(), 0);
  await page.getByRole('button', { name: 'Research leads', exact: true }).first().click();
  await page.getByRole('button', { name: 'Inspect job', exact: true }).first().click();
  await page.getByRole('button', { name: 'Cancel job', exact: true }).click();
  await page.getByText('cancelled', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Retry job', exact: true }).click();
  await page.getByText('One bounded retry queued.', {exact:true}).waitFor();
  assert.equal(store.jobs()[0].attempt, 1);
  const captures = [], audits = [];
  for (const [width, height] of [[1440, 900], [1280, 720], [768, 1024], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height });
    for (const name of ['Jobs', 'Businesses', 'References', 'Assets', 'Integrations']) {
      await page.getByRole('navigation', { name: 'Factory' }).getByRole('link', { name, exact: true }).click();
      await page.waitForFunction(view => document.querySelector('nav[aria-label="Factory"] [aria-current]')?.getAttribute('href') === '#'+view, name.toLowerCase());
      await page.evaluate(()=>document.fonts.ready);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} at ${width}`);
      if (name === 'Jobs' || name === 'References') { const file = `${name.toLowerCase()}-${width}.png`; await page.screenshot({ path: path.join(root, file), fullPage: true }); captures.push(file); }
      if (width === 1440) { const axe = await new AxeBuilder({ page }).analyze(); audits.push({ name, violations: axe.violations.map(v => v.id) }); assert.deepEqual(axe.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })), [], name); }
    }
  }
  await page.getByRole('navigation', { name: 'Factory' }).getByRole('link', { name: 'Integrations', exact: true }).click();
  await page.getByRole('button', { name: 'Import Vault inventory', exact: true }).click();
  await page.getByLabel('Sanitized inventory JSON').fill(JSON.stringify({ previews: [{ name: 'Operator fixture', slug: 'fixture-preview', url: 'https://simulacraproductions.net/p/fixture-preview', status: 'unknown' }] }));
  await page.getByRole('button', { name: 'Import inventory', exact: true }).click();
  await page.getByText('Operator fixture', { exact: true }).waitFor();
  assert.equal(store.vault()[0].liveVerified, false);
  assert.deepEqual(errors, []);
  await writeFile(path.join(root, 'results.json'), JSON.stringify({ pass: true, coverage: 'Fixture UI database only; no live model/network or visual acceptance', captures, audits, errors }, null, 2));
});

test('review desk foregrounds latest site, compares exact parent and records literal digest-bound notes', async t => {
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp('/tmp/factory-review-ui-'), options = { dbPath: path.join(root, 'db.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false };
  await initialize(options); const store = openStore(options);
  const campaign = store.createCampaign({ name: 'Review UI fixture', area: 'Houston', niche: 'Fixture', query: 'Synthetic only' });
  const candidate = store.saveCandidate(campaign.id, { name: 'Latest fixture site', area: 'Houston', summary: 'Synthetic only', identityMatched: true, active: true, sourceUrls: ['https://fixture.example/'], facts: [{ text: 'Synthetic item', sourceUrl: 'https://fixture.example/' }], websiteCheck: { status: 'no_official_site_found', queries: ['fixture'], checkedAt: now() } });
  const parent = store.createJob({ campaignId: campaign.id, kind: 'site', input: { candidateId: candidate.id } });
  async function stage(job) {
    const relative = `jobs/${job.id}/attempt-0/proposal-0/site`; await mkdir(path.join(store.stateRoot, relative), { recursive: true });
    await writeFile(path.join(store.stateRoot, relative, 'index.html'), '<h1>Synthetic fixture only</h1>');
    const siteDigest = hash(await treeHashes(path.join(store.stateRoot, relative)));
    return store.updateJob(job.id, { state: 'review_ready', outputs: { siteRelative: relative, siteDigest, qaPass: true, reviewStatus: 'operator_review_required', humanDecision: null } });
  }
  const first = await stage(parent);
  const second = await stage(store.createJob({ campaignId: campaign.id, kind: 'site', input: { candidateId: candidate.id, parentSiteJobId: first.id, parentSiteDigest: first.outputs.siteDigest, feedback: 'Synthetic revised fixture' } }));
  const service = createService(store, options), app = await startServer(service, { port: 0, previewPort: 0 });
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true });
  t.after(async () => { await browser.close(); await app.close(); store.close(); });
  const page = await browser.newPage(); await page.goto(app.url + '/#jobs'); await page.waitForFunction(() => window.FactoryReady);
  await page.evaluate(id => { location.hash = 'jobs/' + id; }, second.id);
  await page.getByRole('region', { name: 'Version review' }).waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: 'Close detail', exact: true }).click();
  await page.getByRole('complementary', { name: 'On the bench' }).getByRole('button', { name: 'Review latest site', exact: true }).click();
  await page.getByRole('region', { name: 'Version review' }).waitFor();
  assert.ok(await page.evaluate(() => (document.querySelector('[aria-label="Version review"]').compareDocumentPosition(document.querySelector('[aria-label="Production queue"]')) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0), 'Exact-version work should appear before the long queue/history');
  await page.getByText('Previous exact version', { exact: true }).waitFor();
  assert.equal(await page.getByText(first.outputs.siteDigest.slice(0, 12), { exact: true }).count() >= 1, true);
  await page.getByLabel('Revision feedback').fill('More personality <img src=x onerror=alert(1)> and a clearer first screen.');
  await page.getByRole('button', { name: 'Save version note', exact: true }).click();
  await page.getByText('More personality <img src=x onerror=alert(1)> and a clearer first screen.', { exact: true }).waitFor();
  assert.equal(await page.locator('img[src=x]').count(), 0);
  assert.equal(store.events(second.id).filter(e => e.type === 'review.note').length, 1);
  assert.equal(store.job(second.id).outputs.humanDecision, null);
  await page.getByLabel('Revision feedback').fill('One explicit final synthetic revision request.');
  await Promise.all([
    page.waitForResponse(r => r.url() === app.url + '/api/op' && r.request().postDataJSON()?.operation === 'revise_site'),
    page.getByRole('button', { name: 'Request isolated revision', exact: true }).click(),
  ]);
  assert.equal(store.jobs().filter(j => j.input.parentSiteJobId).length, 2);
});
