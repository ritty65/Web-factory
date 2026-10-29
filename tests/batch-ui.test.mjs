import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { startServer } from '../src/server.mjs';
import { batchSettings, intakeFixture } from './helpers-batch.mjs';
import { getBatch, saveBatch } from '../src/batch-store.mjs';
import { hash } from '../src/contracts.mjs';
import { treeHashes } from '../src/proposal.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright'), { default: AxeBuilder } = require('@axe-core/playwright');

async function fixture(t, extra = {}) {
  const root = await mkdtemp('/tmp/factory-batch-ui-'), options = { dbPath: path.join(root, 'db.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false, batchPrerequisites: async () => ({ ready: true, checks: [], liveVerified: false }), ...extra };
  await initialize(options); const store = openStore(options), service = createService(store, options), app = await startServer(service, { port: 0, previewPort: 0 });
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true });
  t.after(async () => { await browser.close(); await app.close(); store.close(); });
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', route => route.request().url().startsWith(app.url + '/') ? route.continue() : route.abort());
  return { root, store, service, app, browser, context, page, errors };
}
test('readiness displays the configured Fast route without a false live-verification claim or automatic work', async t => {
  const { store, app, page } = await fixture(t, { batchPrerequisites: async () => ({ ready: true, checks: [{ name: 'preview_vault', status: 'historical_live_inventory' }, { name: 'firecrawl', status: 'needs_configuration', optional: true }], selectedSource: 'guest_bing', sourceStatus: 'available_for_bounded_attempt_not_live_verified', model: 'openai/gpt-6.1-sol-fast', modelStatus: 'explicit_route_not_live_verified', liveVerified: false }) });
  await page.goto(app.url); await page.waitForFunction(() => window.FactoryBatchReady === true);
  await page.getByRole('button', { name: 'Check local readiness', exact: true }).click();
  await page.getByText('Factory model: openai/gpt-6.1-sol-fast · explicit route, not a model sign-in or live intake test.', { exact: true }).waitFor({ timeout: 2000 });
  await page.getByText('Local prerequisites available for a bounded attempt — not live-verified.', { exact: true }).waitFor();
  await page.getByText('Guest public Bing: selected; live search not tested.', { exact: true }).waitFor();
  await page.getByText('preview_vault: optional; not checked by this action', { exact: true }).waitFor();
  await page.getByText('firecrawl: optional; not selected', { exact: true }).waitFor();
  assert.equal(await page.getByText('historical_live_inventory', { exact: false }).count(), 0);
  assert.equal(store.campaigns().length, 0); assert.equal(store.jobs().length, 0);
  assert.equal((await createService(store, { autoRun: false }).dispatch('batch_status')).preset.adopted, false);
});
test('simple landing saves setup once, retains literal drafts, starts one batch and stops only owned work', async t => {
  const { root, store, app, page, errors } = await fixture(t);
  await page.goto(app.url); await page.waitForFunction(() => window.FactoryBatchReady === true);
  await page.getByRole('heading', { name: 'Find your next website customer.', exact: true }).waitFor({ timeout: 4000 });
  assert.equal(await page.getByRole('button', { name: 'Choose your setup', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: /Find & build up to 10 Houston websites/ }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'New campaign', exact: true }).isVisible(), false);
  await page.getByLabel('Business categories', { exact: true }).fill('Upholstery <img src=x onerror=alert(1)>');
  await page.getByLabel('I reviewed this scope, permitted public sources and attempt limits.').check();
  await page.getByRole('button', { name: 'Save one-time setup', exact: true }).click();
  await page.getByText('Saved setup. Nothing has started.', { exact: true }).waitFor();
  assert.equal(await page.locator('img[src=x]').count(), 0);
  await page.getByRole('button', { name: /Find & build up to 10 Houston websites/ }).click();
  await page.getByRole('button', { name: 'Stop this batch', exact: true }).waitFor();
  assert.equal(store.campaigns().length, 1); assert.equal(store.jobs().length, 1);
  assert.match(store.campaigns()[0].niche, /<img/);
  await page.getByRole('button', { name: 'Stop this batch', exact: true }).click();
  await page.getByText('Batch stopped. All work is retained.', { exact: true }).waitFor();
  assert.equal(store.jobs()[0].state, 'cancelled');
  for (const [width, height] of [[1440, 900], [1280, 720], [768, 1024], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height });
    for (const route of ['start', 'inbox']) {
      await page.goto(`${app.url}/#${route}`); await page.waitForFunction(() => window.FactoryBatchReady === true);
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => [...document.querySelectorAll('main *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).map(e => ({ tag: e.tagName, class: e.className, text: e.textContent.slice(0, 150), right: e.getBoundingClientRect().right })));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route} at ${width}: ${JSON.stringify(overflow)}`);
      if ([1440, 390].includes(width)) { await page.screenshot({ path: path.join(root, `${route}-${width}.png`), fullPage: true }); const axe = await new AxeBuilder({ page }).analyze(); assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), []); }
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(root, 'RESULT.json'), JSON.stringify({ pass: true, scope: 'Synthetic temporary database; no provider or live batch', screenshots: ['start-1440.png', 'start-390.png', 'inbox-1440.png', 'inbox-390.png'] }, null, 2));
  console.log('Batch UI fixture evidence: ' + root);
});
test('post-commit start response loss retries the same saved intent, never a duplicate batch', async t => {
  const { store, service, app, page } = await fixture(t);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'ui-save-fixture', settings: batchSettings, acknowledged: true });
  await page.goto(app.url); await page.waitForFunction(() => window.FactoryBatchReady === true);
  let first = true;
  await page.route('**/api/op', async route => {
    if (first && route.request().postDataJSON().operation === 'batch_start') {
      first = false; const response = await route.fetch(); assert.equal(response.status(), 200);
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic start response lost after commit' }) }); return;
    } await route.continue();
  });
  await page.getByRole('button', { name: /Find & build up to 3 Houston websites/ }).click();
  await page.getByText('Synthetic start response lost after commit', { exact: true }).waitFor();
  await page.getByText('The start response was not confirmed. Retry checks the same saved request; it does not start a second run.', { exact: true }).waitFor();
  await page.getByRole('button', { name: /Find & build up to 3 Houston websites/ }).click();
  await page.getByRole('button', { name: 'Stop this batch', exact: true }).waitFor();
  assert.equal(store.campaigns().length, 1); assert.equal(store.jobs().length, 1);
});
test('a definitive failed start can adopt corrected setup and start without an obsolete stored intent', async t => {
  let ready = false;
  const { store, service, app, page } = await fixture(t, { batchPrerequisites: async () => ({ ready }) });
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'preflight-fixture-setup', settings: batchSettings, acknowledged: true });
  await page.goto(app.url); await page.waitForFunction(() => window.FactoryBatchReady === true);
  await page.getByRole('button', { name: /Find & build up to 3 Houston websites/ }).click();
  await page.locator('.batch-start-error').getByText('Required runtime or selected source is unavailable. Open readiness details; nothing was queued.', { exact: true }).waitFor();
  assert.equal(store.campaigns().length, 0);
  await page.getByText('Search settings', {exact:true}).click();
  await page.getByText('Edit setup & limits', { exact: true }).click();
  await page.getByLabel('Business categories', { exact: true }).fill('Corrected synthetic category');
  await page.getByLabel('I reviewed this scope, permitted public sources and attempt limits.').check();
  await page.getByRole('button', { name: 'Save one-time setup', exact: true }).click();
  await page.getByText('Saved setup. Nothing has started.', { exact: true }).waitFor(); ready = true;
  await page.getByRole('button', { name: /Find & build up to 3 Houston websites/ }).click();
  await page.getByRole('button', { name: 'Stop this batch', exact: true }).waitFor({ timeout: 6000 });
  const status = await service.dispatch('batch_status');
  assert.equal(status.items[0].presetVersion, 2); assert.equal(store.campaigns().length, 1); assert.equal(store.jobs().length, 1);
});
test('inbox exposes source-backed unsent drafts and an exact first-site checkpoint, never owner links or acceptance', async t => {
  const { root, store, service, app, page } = await fixture(t);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'ui-save-fixture', settings: batchSettings, acknowledged: true });
  const b = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'ui-start-fixture', authorized: true });
  const c = store.saveCandidate(b.campaignId, intakeFixture().candidate), discovery = store.jobs()[0];
  store.updateJob(discovery.id, { state: 'review_ready' });
  saveBatch(store, { ...getBatch(store, b.id), firstCandidateId: c.id, members: [{ candidateId: c.id, ready: true, reasons: [], evidenceDigest: hash(c), contacts: [{ channel: 'instagram', value: c.contacts.instagram, sourceUrl: c.contacts.instagram }] }] });
  const j = store.createJob({ campaignId: b.campaignId, kind: 'site', input: { candidateId: c.id } });
  const relative = `jobs/${j.id}/attempt-0/proposal-0/site`; await mkdir(path.join(store.stateRoot, relative), { recursive: true }); await writeFile(path.join(store.stateRoot, relative, 'index.html'), '<h1>Synthetic only</h1>');
  const siteDigest = hash(await treeHashes(path.join(store.stateRoot, relative)));
  store.updateJob(j.id, { state: 'review_ready', outputs: { siteRelative: relative, siteDigest, qaPass: true, reviewStatus: 'operator_review_required', humanDecision: null, publicRelease: false } });
  saveBatch(store, { ...getBatch(store, b.id), state: 'awaiting_first_review' });
  await page.goto(`${app.url}/#inbox/${b.id}`); await page.waitForFunction(() => window.FactoryBatchReady === true);
  await page.getByText(c.name, { exact: true }).first().waitFor();
  await page.getByText('Public contact & unsent draft', { exact: true }).click();
  await page.getByText('Unsent draft · no owner link attached', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Send/ }).count(), 0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Populated inbox at ' + width);
    const axe = await new AxeBuilder({ page }).analyze(); assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), []);
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(root, `inbox-populated-${width}.png`), fullPage: true });
  }
  await page.goto(`${app.url}/#start/${b.id}`); await page.waitForFunction(() => window.FactoryBatchReady === true);
  await page.getByLabel('First-site review note', { exact: true }).fill('Synthetic checkpoint <script>literal</script>');
  await page.getByLabel('I reviewed this exact site and have authorization to build the remainder.').check();
  await page.getByRole('button', { name: 'Continue the remaining batch', exact: true }).click();
  await page.getByText('Checkpoint saved. No artifact acceptance recorded.', { exact: true }).waitFor();
  assert.equal(store.job(j.id).outputs.humanDecision, null);
  assert.equal(getBatch(store, b.id).checkpoint.siteDigest, siteDigest);
  assert.equal(getBatch(store, b.id).checkpoint.humanDecision, null);
  console.log('Populated inbox fixture evidence: ' + root);
});

async function experienceCapture(page, root, name, widths = [1280, 390]) {
  await page.waitForFunction(() => !document.querySelector('#notice').textContent);
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 844 });
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} reflows at ${width}`);
    const axe = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), []);
    await page.screenshot({ path: path.join(root, `synthetic-${name}-${width}.png`), fullPage: true });
  }
}
async function firstScreen(page, locator) {
  await locator.waitFor({ state: 'visible', timeout: 4000 });
  for (const [width, height] of [[1280, 720], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    const bounds = await locator.boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= height, `next action in first screen at ${width}: ${JSON.stringify(bounds)}`);
  }
}
test('historical zero-source completion displays a stopped research outcome, not success or a new run', async t => {
  const { root, store, service, app, page, errors } = await fixture(t);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'zero-source-setup', settings: batchSettings, acknowledged: true });
  const b = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'zero-source-start', authorized: true });
  store.updateJob(store.jobs()[0].id, { state: 'review_ready', outputs: { candidateIds: [] } });
  saveBatch(store, { ...getBatch(store, b.id), state: 'complete', phase: 'complete', message: 'Old completion message', lastShortfall: 'Synthetic model HOLD: sources.search unavailable', usage: { modelRequests: 1, searches: 0, inspections: 0, imageViews: 0 } });
  const original = getBatch(store, b.id);
  for (const route of ['start', 'inbox']) {
    await page.goto(`${app.url}/#${route}/${b.id}`); await page.waitForFunction(() => window.FactoryBatchReady);
    await page.locator(route === 'start' ? '.batch-progress' : '.batch-inbox-heading').getByRole('heading', { name: 'Research did not run', exact: true }).waitFor({ timeout: 2500 });
    assert.equal(await page.getByText(/Finished within limits/).count(), 0);
    assert.equal(await page.locator('.batch-steps li[aria-current="step"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: /Find & build up to/ }).count(), 0);
    await page.getByText('Integration needs repair; do not start another batch.', { exact: true }).waitFor();
    const technical = page.getByText('Technical details', { exact: true }).locator('..');
    assert.equal(await technical.evaluate(e => e.open), false);
    assert.equal(await page.getByText('Synthetic model HOLD: sources.search unavailable', { exact: true }).isVisible(), false);
    await experienceCapture(page, root, `zero-source-${route}`);
  }
  assert.deepEqual(getBatch(store, b.id), original); assert.deepEqual(errors, []);
  console.log('Zero-source historical fixture evidence: ' + root);
});
test('attempted research shortfalls and source failures stay distinct from three completed review sites', async t => {
  const { store, service, app, page } = await fixture(t);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'outcomes-setup', settings: batchSettings, acknowledged: true });
  const b = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'outcomes-start', authorized: true }), discovery = store.jobs()[0];
  store.updateJob(discovery.id, { state: 'review_ready', outputs: { candidateIds: [] } });
  saveBatch(store, { ...getBatch(store, b.id), state: 'complete', phase: 'complete', usage: { modelRequests: 1, searches: 1, inspections: 0, imageViews: 0 } });
  await page.goto(`${app.url}/#start/${b.id}`); await page.waitForFunction(() => window.FactoryBatchReady);
  await page.locator('.batch-progress').getByRole('heading', { name: 'No business qualified', exact: true }).waitFor();
  assert.equal(await page.getByText('Integration needs repair; do not start another batch.', { exact: true }).count(), 0);
  store.updateJob(discovery.id, { state: 'blocked', errorCode: 'SOURCE_TIMEOUT', message: 'Synthetic real source failure' });
  await page.reload(); await page.waitForFunction(() => window.FactoryBatchReady);
  await page.locator('.batch-progress').getByRole('heading', { name: 'Research stopped', exact: true }).waitFor();
  store.updateJob(discovery.id, { state: 'review_ready', errorCode: null });
  const members = [];
  for (let index = 0; index < batchSettings.targetCount; index++) {
    const c = store.saveCandidate(b.campaignId, intakeFixture(index + 1).candidate);
    members.push({ candidateId: c.id, ready: true, reasons: [], contacts: [], evidenceDigest: hash(c) });
    saveBatch(store, { ...getBatch(store, b.id), state: 'active', members });
    const j = store.createJob({ campaignId: b.campaignId, kind: 'site', input: { candidateId: c.id } });
    store.updateJob(j.id, { state: 'review_ready', outputs: { reviewStatus: 'operator_review_required', humanDecision: null, qaPass: true, siteDigest: 'a'.repeat(64) } });
    if (!index) saveBatch(store, { ...getBatch(store, b.id), firstCandidateId: c.id, checkpoint: { siteJobId: j.id, siteDigest: 'a'.repeat(64), source: 'synthetic_fixture_only', humanDecision: null } });
  }
  saveBatch(store, { ...getBatch(store, b.id), state: 'complete', members });
  const detail = await service.dispatch('batch_get', { id: b.id });
  assert.equal(detail.batch.counts.ready, 3); assert.equal(detail.batch.outcome, null);
  await page.reload(); await page.waitForFunction(() => window.FactoryBatchReady);
  await page.locator('.batch-progress').getByRole('heading', { name: 'Finished within limits', exact: true }).waitFor();
  assert.equal(await page.locator('.ledger-stages [data-stage=production]').getAttribute('data-state'),'done');
  assert.equal(await page.locator('.ledger-stages [data-stage=first_site_review]').getAttribute('data-state'),'done');
  assert.equal(await page.locator('[data-ledger-progress]').getAttribute('data-running'),'false');
});
test('experience: state-led setup and saved scope stay separate from frozen running work', async t => {
  const { root, store, service, app, page, errors } = await fixture(t);
  await page.goto(app.url); await page.waitForFunction(() => window.FactoryBatchReady);
  const choose = page.getByRole('button', { name: 'Choose your setup', exact: true });
  await choose.waitFor({ timeout: 3000 }); await firstScreen(page, choose);
  await experienceCapture(page, root, 'start-empty');
  await choose.click(); await page.getByLabel('Business categories', { exact: true }).fill('Synthetic chair workshops');
  await page.getByText('Unsaved setup edits', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Your websites',exact:true }).click();
  await page.waitForFunction(() => window.FactoryBatchReady);
  await experienceCapture(page, root, 'inbox-empty');
  await page.getByRole('navigation',{name:'Factory'}).getByRole('link', { name: 'Find leads', exact: true }).click(); await page.waitForFunction(() => window.FactoryBatchReady);
  assert.equal(await page.getByLabel('Business categories', { exact: true }).inputValue(), 'Synthetic chair workshops');
  await page.getByLabel('I reviewed this scope, permitted public sources and attempt limits.').check();
  await page.getByRole('button', { name: 'Save one-time setup', exact: true }).click();
  await page.getByText('Saved setup. Nothing has started.', { exact: true }).waitFor();
  assert.equal(store.campaigns().length, 0);
  const start = page.getByRole('button', { name: /Find & build up to 10 Houston websites/ });
  await firstScreen(page, start); await experienceCapture(page, root, 'start-ready');
  await start.click(); await page.getByRole('region', { name: 'Current batch' }).waitFor();
  const progress = page.getByRole('region', { name: 'Current batch' });
  await firstScreen(page, progress.getByRole('link', { name: 'View saved results',exact:true }));
  await progress.getByText('Run details', {exact:true}).click();
  await progress.getByText(/Review pause is included/).waitFor();
  await page.getByText('Search settings', {exact:true}).click();
  await page.getByText('Edit setup for the next run', { exact: true }).click();
  await page.getByLabel('Business categories', { exact: true }).fill('Synthetic next-run category');
  await page.getByLabel('I reviewed this scope, permitted public sources and attempt limits.').check();
  await page.getByRole('button', { name: 'Save one-time setup', exact: true }).click();
  await page.getByText('Saved setup. Nothing has started.', { exact: true }).waitFor();
  assert.match(await progress.textContent().catch(() => ''), /Frozen for this batch/);
  assert.equal((await service.dispatch('batch_status')).items[0].settings.niche, 'Synthetic chair workshops');
  await experienceCapture(page, root, 'running');
  assert.deepEqual(errors, []);
  console.log('Synthetic operator experience evidence: ' + root);
});
test('experience: mixed inbox filters preserve drafts and exact first-review navigation, with honest held state', async t => {
  const { root, store, service, app, page, errors } = await fixture(t);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'experience-setup', settings: batchSettings, acknowledged: true });
  const b = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'experience-start', authorized: true });
  store.updateJob(store.jobs()[0].id, { state: 'review_ready' });
  const c = store.saveCandidate(b.campaignId, { ...intakeFixture().candidate, name: 'Synthetic review workshop' });
  saveBatch(store, { ...getBatch(store, b.id), firstCandidateId: c.id, members: [{ candidateId: c.id, ready: true, reasons: [], evidenceDigest: hash(c), contacts: [] }] });
  const j = store.createJob({ campaignId: b.campaignId, kind: 'site', input: { candidateId: c.id } });
  const held = store.saveCandidate(b.campaignId, { ...intakeFixture().candidate, name: 'Synthetic held workshop', contacts: {} });
  const relative = `jobs/${j.id}/attempt-0/proposal-0/site`; await mkdir(path.join(store.stateRoot, relative), { recursive: true });
  await writeFile(path.join(store.stateRoot, relative, 'index.html'), '<h1>Synthetic experience fixture only</h1>');
  const siteDigest = hash(await treeHashes(path.join(store.stateRoot, relative)));
  store.updateJob(j.id, { state: 'review_ready', outputs: { siteRelative: relative, siteDigest, reviewStatus: 'operator_review_required', humanDecision: null, publicRelease: false } });
  saveBatch(store, { ...getBatch(store, b.id), state: 'awaiting_first_review', firstCandidateId: c.id, members: [
    { candidateId: c.id, ready: true, reasons: [], evidenceDigest: hash(c), contacts: [] },
    { candidateId: held.id, ready: false, reasons: ['Synthetic evidence needs inspection'], evidenceDigest: hash(held), contacts: [] }
  ] });
  await page.goto(`${app.url}/#inbox/${b.id}`); await page.waitForFunction(() => window.FactoryBatchReady);
  await page.getByRole('button', { name: 'All (2)', exact: true }).waitFor({ timeout: 3000 });
  await experienceCapture(page, root, 'mixed-inbox', [1280, 390, 320]);
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: c.name, exact: true }) });
  await card.getByText('Review note & disposition', { exact: true }).click();
  await card.getByLabel('Review note for ' + c.name, { exact: true }).fill('Synthetic literal draft <img src=x>');
  await card.getByLabel('Review disposition for ' + c.name, { exact: true }).selectOption('needs_changes');
  await page.getByRole('button', { name: 'Needs attention (1)', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: held.name, exact: true }).waitFor();
  assert.equal(await page.getByRole('article').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Needs attention (1)', exact: true }).evaluate(e => e === document.activeElement), true);
  await page.getByRole('button', { name: 'Ready to review (1)', exact: true }).click();
  await card.getByText('Review note & disposition', { exact: true }).click();
  assert.equal(await card.getByLabel('Review note for ' + c.name, { exact: true }).inputValue(), 'Synthetic literal draft <img src=x>');
  assert.equal(await card.getByLabel('Review disposition for ' + c.name, { exact: true }).inputValue(), 'needs_changes');
  await card.getByText('Unsaved review note', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Find leads', exact: true }).click(); await page.waitForFunction(() => window.FactoryBatchReady);
  await firstScreen(page, page.getByRole('link', { name: 'Review website', exact: true }));
  await experienceCapture(page, root, 'first-review');
  await page.goto(`${app.url}/#inbox/${b.id}`); await page.waitForFunction(() => window.FactoryBatchReady);
  await card.getByText('Review note & disposition', { exact: true }).click();
  assert.equal(await card.getByLabel('Review note for ' + c.name, { exact: true }).inputValue(), 'Synthetic literal draft <img src=x>');
  const noteRequests = [];
  await page.route('**/api/op', async route => {
    const request = route.request().postDataJSON();
    if (request.operation === 'batch_item_note') {
      noteRequests.push(request.input.requestId);
      if (noteRequests.length === 1) {
        const response = await route.fetch(); assert.equal(response.status(), 200);
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic note response lost after commit' }) }); return;
      }
    }
    await route.continue();
  });
  await card.getByRole('button', { name: 'Save review note', exact: true }).click();
  await page.getByText('Synthetic note response lost after commit', { exact: true }).waitFor();
  // Synthetic worker reconciliation: this fixture deliberately has autorun off.
  saveBatch(store, { ...getBatch(store, b.id), state: 'held', message: 'Synthetic changes hold — inspect retained feedback before further work.' });
  await page.getByRole('link', { name: 'Find leads', exact: true }).click(); await page.waitForFunction(() => window.FactoryBatchReady);
  await page.goto(`${app.url}/#inbox/${b.id}`); await page.waitForFunction(() => window.FactoryBatchReady);
  await page.getByRole('button', { name: 'All (2)', exact: true }).click();
  await card.getByText('Review note & disposition', { exact: true }).click();
  assert.equal(await card.getByLabel('Review note for ' + c.name, { exact: true }).inputValue(), 'Synthetic literal draft <img src=x>');
  assert.equal(await card.getByLabel('Review disposition for ' + c.name, { exact: true }).inputValue(), 'needs_changes');
  await card.getByRole('button', { name: 'Save review note', exact: true }).click();
  await page.getByText('Review note saved. No site changed or accepted.', { exact: true }).waitFor();
  await card.getByText('Saved disposition: Needs changes — hold automatic work', { exact: true }).waitFor();
  assert.equal(noteRequests.length, 2); assert.equal(noteRequests[0], noteRequests[1]);
  assert.equal((await service.dispatch('batch_get', { id: b.id })).noteHistory.total, 1);
  assert.equal(store.job(j.id).outputs.humanDecision, null);
  assert.equal(await page.locator('img[src=x]').count(), 0);
  await page.getByRole('button', { name: 'Ready to review (0)', exact: true }).click();
  await page.getByText('No results in this filter.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Show all results', exact: true }).click();
  await card.getByRole('heading', { name: c.name, exact: true }).waitFor();
  assert.equal(await page.getByRole('article').count(), 2);
  await page.getByRole('link', { name: /Review first site & continuation checkpoint/ }).click();
  await page.waitForFunction(() => window.FactoryBatchReady);
  await page.getByRole('heading', { name: 'Continuation needs attention.', exact: true }).waitFor({ timeout: 3000 });
  assert.equal(await page.getByRole('button', { name: 'Continue the remaining batch', exact: true }).count(), 0);
  assert.equal(await page.locator('#batch-checkpoint-heading').evaluate(e => e === document.activeElement), true);
  assert.equal(getBatch(store, b.id).checkpoint, null);
  await firstScreen(page, page.getByRole('link', { name: 'Review website', exact: true }));
  await experienceCapture(page, root, 'held');
  assert.equal(await page.getByRole('button', { name: /Resume/ }).count(), 0);
  await page.getByText('Run details', {exact:true}).click();
  await page.getByText('Usage & retained work', { exact: true }).click();
  await page.getByText(/Native worker launches \d+\//).waitFor();
  assert.deepEqual(errors, []);
  console.log('Synthetic mixed-state experience evidence: ' + root);
});

test('historical zero-source bookmarks link to the latest terminal or open attempt without rewriting failure or starting work', async t => {
  const { root, store, service, app, page, errors } = await fixture(t);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'latest-history-scope', settings: batchSettings, acknowledged: true });
  const historical = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'latest-history-old', authorized: true });
  store.updateJob(store.jobs()[0].id, { state: 'review_ready', outputs: { candidateIds: [] } });
  saveBatch(store, { ...getBatch(store, historical.id), state: 'complete', phase: 'complete', usage: { modelRequests: 1, searches: 0, inspections: 0, imageViews: 0 } });
  const original = getBatch(store, historical.id);
  const latest = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'latest-history-new', authorized: true });
  store.updateJob(store.jobs().find(j => j.campaignId === latest.campaignId).id, { state: 'review_ready', outputs: { candidateIds: [] } });
  await service.dispatch('batch_stop', { id: latest.id });
  const requests = [];
  page.on('request', request => { if (request.url().endsWith('/api/op')) requests.push(request.postDataJSON().operation); });
  for (const state of ['complete', 'stopped', 'active', 'awaiting_first_review', 'held']) {
    saveBatch(store, { ...getBatch(store, latest.id), state });
    for (const route of ['start', 'inbox']) {
      await page.goto(`${app.url}/#${route}/${historical.id}`); await page.waitForFunction(() => window.FactoryBatchReady);
      const open = ['active', 'awaiting_first_review', 'held'].includes(state);
      const action = page.getByRole('complementary', { name: open ? 'Current open batch' : 'Historical batch view', exact: true }).getByRole('link', { name: open ? 'Open current batch' : 'Open latest attempt', exact: true });
      await action.waitFor({ timeout: 2000 });
      const destination = new URL(await action.getAttribute('href'), app.url);
      assert.equal(destination.origin, app.url); assert.equal(destination.hash, '#start/' + latest.id);
      await firstScreen(page, action);
      await page.locator(route === 'start' ? '.batch-progress' : '.batch-inbox-heading').getByRole('heading', { name: 'Research did not run', exact: true }).waitFor();
      await page.getByText('This earlier attempt did not run research. History and usage are retained. See the latest attempt for its current progress.', { exact: true }).waitFor();
      assert.equal(await page.getByText('Integration needs repair; do not start another batch.', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: /^Find & build/ }).count(), 0);
      if (state === 'complete') await experienceCapture(page, root, `latest-terminal-${route}`);
      await action.click(); await page.waitForFunction(() => window.FactoryBatchReady);
      assert.equal(new URL(page.url()).hash, '#start/' + latest.id);
    }
  }
  // A fully completed newer attempt must remain reachable from the old bookmark too.
  const members = [];
  for (let index = 0; index < batchSettings.targetCount; index++) {
    const c = store.saveCandidate(latest.campaignId, intakeFixture(index + 1).candidate);
    members.push({ candidateId: c.id, ready: true, reasons: [], contacts: [], evidenceDigest: hash(c) });
    saveBatch(store, { ...getBatch(store, latest.id), state: 'active', members });
    const j = store.createJob({ campaignId: latest.campaignId, kind: 'site', input: { candidateId: c.id } });
    store.updateJob(j.id, { state: 'review_ready', outputs: { reviewStatus: 'operator_review_required', humanDecision: null, qaPass: true, siteDigest: 'a'.repeat(64) } });
    if (!index) saveBatch(store, { ...getBatch(store, latest.id), firstCandidateId: c.id, checkpoint: { siteJobId: j.id, siteDigest: 'a'.repeat(64), source: 'synthetic_fixture_only', humanDecision: null } });
  }
  store.updateJob(store.jobs().find(j => j.campaignId === latest.campaignId && j.kind === 'discovery').id, { state: 'review_ready' });
  saveBatch(store, { ...getBatch(store, latest.id), state: 'complete', phase: 'complete', members });
  const completed = await service.dispatch('batch_get', { id: latest.id });
  assert.equal(completed.batch.counts.ready, batchSettings.targetCount, JSON.stringify(completed.batch));
  assert.equal(completed.batch.outcome, null);
  for (const route of ['start', 'inbox']) {
    await page.goto(`${app.url}/#${route}/${historical.id}`); await page.waitForFunction(() => window.FactoryBatchReady);
    const action = page.getByRole('link', { name: 'Open latest attempt', exact: true });
    await firstScreen(page, action);
    await page.locator(route === 'start' ? '.batch-progress' : '.batch-inbox-heading').getByRole('heading', { name: 'Research did not run', exact: true }).waitFor();
    await action.click(); await page.waitForFunction(() => window.FactoryBatchReady);
    assert.equal(new URL(page.url()).hash, '#start/' + latest.id);
    await page.locator('.batch-progress').getByRole('heading', { name: 'Finished within limits', exact: true }).waitFor({ timeout: 2000 });
  }
  assert.deepEqual(getBatch(store, historical.id), original);
  assert.equal(store.campaigns().length, 2); assert.equal(store.jobs().length, 2 + batchSettings.targetCount);
  assert.ok(requests.every(operation => ['batch_status', 'batch_get'].includes(operation)), JSON.stringify(requests));
  assert.deepEqual(errors, []);
  console.log('Latest-attempt historical fixture evidence: ' + root);
});

test('older inbox picker pages keep global latest and open-attempt context independent of pagination', async t => {
  const { root, store, service, app, page, errors } = await fixture(t);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'pagination-scope', settings: batchSettings, acknowledged: true });
  const batches = [];
  for (let index = 0; index < 22; index++) {
    const b = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'pagination-attempt-' + index, authorized: true });
    store.updateJob(store.jobs().find(j => j.campaignId === b.campaignId).id, { state: 'review_ready', outputs: { candidateIds: [] } });
    saveBatch(store, { ...getBatch(store, b.id), state: 'complete', phase: 'complete', usage: { modelRequests: 1, searches: 0, inspections: 0, imageViews: 0 } });
    batches.push(b);
  }
  const historical = batches[1], latest = batches.at(-1), original = getBatch(store, historical.id), requests = [];
  page.on('request', request => { if (request.url().endsWith('/api/op')) requests.push(request.postDataJSON().operation); });
  for (const state of ['complete', 'active']) {
    saveBatch(store, { ...getBatch(store, latest.id), state });
    await page.goto(`${app.url}/#inbox/${historical.id}`); await page.reload(); await page.waitForFunction(() => window.FactoryBatchReady);
    await page.locator('.batch-picker summary').click();
    await page.getByRole('button', { name: 'Older batches', exact: true }).click();
    await page.waitForFunction(() => window.FactoryBatchReady);
    assert.equal(await page.locator(`.batch-picker a[href="#inbox/${latest.id}"]`).count(), 0);
    assert.equal(await page.locator('.batch-picker a').count(), 2);
    const action = page.getByRole('complementary', { name: state === 'active' ? 'Current open batch' : 'Historical batch view', exact: true }).getByRole('link', { name: state === 'active' ? 'Open current batch' : 'Open latest attempt', exact: true });
    await action.waitFor({ timeout: 2000 });
    const destination = new URL(await action.getAttribute('href'), app.url);
    assert.equal(destination.origin, app.url); assert.equal(destination.hash, '#start/' + latest.id);
    await firstScreen(page, action);
    await page.getByText('This earlier attempt did not run research. History and usage are retained. See the latest attempt for its current progress.', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await page.getByText('Integration needs repair; do not start another batch.', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.FactoryBatchHasActive), state === 'active');
    await page.screenshot({ path: path.join(root, `pagination-${state}-390.png`), fullPage: true });
    await action.click(); await page.waitForFunction(() => window.FactoryBatchReady);
    assert.equal(new URL(page.url()).hash, '#start/' + latest.id);
  }
  assert.deepEqual(getBatch(store, historical.id), original);
  assert.equal(store.campaigns().length, 22); assert.equal(store.jobs().length, 22);
  assert.ok(requests.every(operation => ['batch_status', 'batch_get'].includes(operation)), JSON.stringify(requests));
  assert.deepEqual(errors, []);
  console.log('Pagination historical fixture evidence: ' + root);
});

test('experience: a historical Start route keeps the different current open batch visible and reachable', async t => {
  const { store, service, app, page, errors } = await fixture(t);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'history-scope', settings: batchSettings, acknowledged: true });
  const historical = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'history-start-one', authorized: true });
  await service.dispatch('batch_stop', { id: historical.id });
  const current = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'history-start-two', authorized: true });
  for (const state of ['active', 'awaiting_first_review', 'held']) {
    saveBatch(store, { ...getBatch(store, current.id), state });
    await page.goto(`${app.url}/#start/${historical.id}`);
    await page.waitForFunction(() => window.FactoryBatchReady);
    const notice = page.getByRole('complementary', { name: 'Current open batch', exact: true });
    await notice.waitFor({ timeout: 2000 });
    const action = notice.getByRole('link', { name: 'Open current batch', exact: true });
    const destination = new URL(await action.getAttribute('href'), app.url);
    assert.equal(destination.origin, app.url);
    assert.equal(destination.hash, '#start/' + current.id);
    await firstScreen(page, action);
    await page.getByRole('region', { name: 'Current batch', exact: true }).getByRole('heading', { name: 'Stopped', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Find & build/ }).count(), 0);
    await action.click(); await page.waitForFunction(() => window.FactoryBatchReady);
    assert.equal(page.url().split('#')[1], 'start/' + current.id);
    await page.getByRole('button', { name: 'Stop this batch', exact: true }).waitFor();
  }
  assert.equal(store.campaigns().length, 2);
  assert.equal((await service.dispatch('batch_status')).total, 2);
  assert.deepEqual(errors, []);
});
