import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { startServer } from '../src/server.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright'), { default: AxeBuilder } = require('@axe-core/playwright');
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOuoAAAAASUVORK5CYII=';
function evidence() {
  return { requestId: 'fixture-assisted-save', scope: { authorizationId: 'fixture-authority', startedAt: new Date(Date.now()-60000).toISOString(), sourceCutoff: new Date(Date.now()+60000).toISOString(), deadlineAt: new Date(Date.now()+3600000).toISOString(), limits: { searches: 12, inspections: 24, imageViews: 8, modelRequests: 16 }, authorized: false }, usage: { searches: 3, inspections: 2, imageViews: 1, modelRequests: 0 }, bundle: { version: 1, segment: 'booking_social_no_independent_marketing_site', candidate: { name: 'Fixture <img src=x onerror=alert(1)>', area: 'Houston', facts: [{ text: 'Literal <script>alert(1)</script>', sourceUrl: 'https://example.com/profile' }], sourceUrls: ['https://example.com/profile', 'javascript:alert(1)', 'https://cdn.example.com/photo?signature=secret'] }, observations: [], searches: [], imageViews: [], assets: [{ imageId: 'photo-one', sourceId: 'source-one', originalBase64: pixel, sha256: 'a'.repeat(64), contentType: 'image/png', review: { method: 'external_pixel_review', observer: 'Fixture operator', at: new Date().toISOString(), notes: 'Fixture pixels' } }] } };
}
async function fixture(t, changes = {}, failure = null) {
  const root = await mkdtemp('/tmp/factory-assisted-ui-');
  const options = { dbPath: path.join(root, 'fixture.sqlite'), stateRoot: path.join(root, 'state'), autoRun: false };
  await initialize(options); const store = openStore(options), service = createService(store, options), app = await startServer(service, { port: 0, previewPort: 0 });
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true }), context = await browser.newContext(), page = await context.newPage();
  const calls = [], remote = [], errors = [], input = evidence();
  const saved = { id: 'assisted-fixture', bundleDigest: 'b'.repeat(64), evidenceDigest: 'e'.repeat(64), assessment: { ready: true, reasons: [] }, candidate: input.bundle.candidate, scope: input.scope, usage: input.usage, provenance: { kind: 'external' }, claimedBatchId: null, ...changes };
  await context.route('**/*', async route => {
    const req = route.request();
    if (!req.url().startsWith(app.url + '/')) { remote.push(req.url()); return route.abort(); }
    if (!req.url().endsWith('/api/op')) return route.continue();
    const payload = req.postDataJSON(); calls.push(payload);
    if (payload.operation === 'batch_status') { const response = await route.fetch(), data = await response.json(); return route.fulfill({ json: { ...data, currentPolicyDigest: 'c'.repeat(64) } }); }
    if (payload.operation.startsWith('assisted_')) {
      if (failure === payload.operation) return route.fulfill({ status: 503, json: { message: 'Fixture response not confirmed' } });
      return route.fulfill({ json: payload.operation === 'assisted_build' ? { batch: { id: 'batch-fixture' }, job: { id: 'job-fixture' } } : saved });
    }
    return route.continue();
  });
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await browser.close(); await app.close(); store.close(); });
  await page.goto(app.url + '/#start'); await page.waitForFunction(() => window.FactoryBatchReady);
  await page.getByText('Assisted business intake', { exact: true }).click({ timeout: 1500 });
  const load = data => page.getByLabel('Load prepared business evidence (.json)', { exact: true }).setInputFiles({ name: 'evidence.json', mimeType: 'application/json', buffer: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)) });
  const mutations = () => calls.filter(c => !['batch_status', 'batch_get', 'state', 'dashboard'].includes(c.operation));
  return { page, root, input, saved, calls, remote, errors, load, mutations, store };
}
test('assisted file preview is literal, local, accessible and saves only on explicit authorization', async t => {
  const f = await fixture(t), { page, input, load } = f;
  await load(input); await page.getByRole('heading', { name: input.bundle.candidate.name, exact: true }).waitFor();
  assert.deepEqual(f.calls.filter(c => c.operation.startsWith('assisted_')), []);
  assert.equal(await page.locator('.assisted-intake img').count(), 1);
  await page.waitForFunction(() => { const image = document.querySelector('.assisted-intake img'); return image?.complete && image.naturalWidth > 0; }, null, { timeout: 2000 });
  assert.equal(await page.locator('img[src=x],script:not([src])').count(), 0);
  assert.equal(await page.locator('.assisted-intake a[href*="signature"],.assisted-intake a[href^="javascript:"]').count(), 0);
  assert.deepEqual(f.remote, []);
  const save = page.getByRole('button', { name: 'Save supplied evidence', exact: true });
  assert.equal(await save.isDisabled(), true);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `reflow ${width}`);
    assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map(v => v.id), []);
    await page.screenshot({ path: path.join(f.root, `assisted-${width}.png`), fullPage: true });
  }
  await page.getByLabel('I authorize saving this supplied evidence', { exact: true }).check(); await save.click();
  await page.getByText('Booking/social presence—no independent marketing website found', { exact: true }).waitFor();
  const saves = f.calls.filter(c => c.operation === 'assisted_save'); assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].input, { ...input, scope: { ...input.scope, authorized: true } });
  assert.equal(await page.getByRole('button', { name: 'Build one private proposal', exact: true }).isDisabled(), true);
  assert.deepEqual(f.errors, []); console.log('Assisted import fixture captures: ' + f.root);
});
test('ready saved evidence builds only explicitly with exact saved digests and current policy', async t => {
  const f = await fixture(t), { page } = f; await f.load(f.input);
  await page.getByLabel('I authorize saving this supplied evidence', { exact: true }).check(); await page.getByRole('button', { name: 'Save supplied evidence', exact: true }).click();
  await page.getByLabel('Authorize one private proposal within saved limits', { exact: true }).check();
  await page.getByRole('button', { name: 'Build one private proposal', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#start/batch-fixture');
  const builds = f.calls.filter(c => c.operation === 'assisted_build'); assert.equal(builds.length, 1);
  assert.deepEqual(builds[0].input, { id: f.saved.id, bundleDigest: f.saved.bundleDigest, evidenceDigest: f.saved.evidenceDigest, policyDigest: 'c'.repeat(64), requestId: builds[0].input.requestId, authorized: true });
  assert.ok(builds[0].input.requestId);
  assert.deepEqual(f.calls.filter(c => /accept|publish|build_site|candidates_import/.test(c.operation)), []);
  assert.equal(f.store.jobs().length, 0);
});
test('held, claimed, expired and missing digest saved evidence cannot build', async t => {
  for (const changes of [{ assessment: { ready: false, reasons: ['Missing literal <img src=x> proof'] } }, { claimedBatchId: 'existing-batch' }, { evidenceDigest: null }, { scope: { ...evidence().scope, deadlineAt: '2000-01-01T00:00:00Z' } }]) {
    const f = await fixture(t, changes), { page } = f; await f.load(f.input);
    await page.getByLabel('I authorize saving this supplied evidence', { exact: true }).check(); await page.getByRole('button', { name: 'Save supplied evidence', exact: true }).click();
    await page.getByLabel('Authorize one private proposal within saved limits', { exact: true }).check();
    assert.equal(await page.getByRole('button', { name: 'Build one private proposal', exact: true }).isDisabled(), true);
    assert.deepEqual(f.calls.filter(c => c.operation === 'assisted_build'), []);
  }
});
test('invalid, oversized and unsafe asset files fail locally before any assisted operation', async t => {
  const f = await fixture(t);
  for (const bad of ['{oops', '{}', ' '.repeat(1024*1024+1), { ...f.input, bundle: { ...f.input.bundle, assets: [{ ...f.input.bundle.assets[0], contentType: 'image/svg+xml' }] } }, { ...f.input, bundle: { ...f.input.bundle, assets: [{ ...f.input.bundle.assets[0], originalBase64: 'not base64!!' }] } }]) {
    await f.load(bad); await f.page.locator('.assisted-error').filter({ hasText: /./ }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'Save supplied evidence', exact: true }).isDisabled(), true);
  }
  assert.deepEqual(f.calls.filter(c => c.operation.startsWith('assisted_')), []);
});
test('ambiguous Save failure never auto-retries and explicit replay retains original payload and request', async t => {
  const f = await fixture(t, {}, 'assisted_save'), { page } = f; delete f.input.requestId; await f.load(f.input);
  await page.getByLabel('I authorize saving this supplied evidence', { exact: true }).check();
  await page.getByRole('button', { name: 'Save supplied evidence', exact: true }).click();
  await page.locator('.assisted-error').filter({ hasText: /not confirmed/i }).waitFor();
  assert.equal(f.calls.filter(c => c.operation === 'assisted_save').length, 1);
  await page.getByRole('button', { name: 'Save supplied evidence', exact: true }).click();
  await page.waitForFunction(() => !window.FactoryBatchBusy);
  const saves = f.calls.filter(c => c.operation === 'assisted_save'); assert.equal(saves.length, 2); assert.deepEqual(saves[0], saves[1]);
  await page.reload(); await page.waitForFunction(() => window.FactoryBatchReady);
  await page.getByText('Assisted business intake', { exact: true }).click(); await f.load(f.input);
  await page.getByLabel('I authorize saving this supplied evidence', { exact: true }).check();
  await page.getByRole('button', { name: 'Save supplied evidence', exact: true }).click();
  await page.waitForFunction(() => !window.FactoryBatchBusy);
  assert.deepEqual(f.calls.filter(c => c.operation === 'assisted_save')[2], saves[0], 'same prepared file retains generated request even after reload');
});
test('read-only assessment refresh clears production authority and cannot manufacture server thumbnails', async t => {
  const f = await fixture(t), { page } = f; await f.load(f.input);
  await page.getByLabel('I authorize saving this supplied evidence', { exact: true }).check();
  await page.getByRole('button', { name: 'Save supplied evidence', exact: true }).click();
  await page.getByLabel('Authorize one private proposal within saved limits', { exact: true }).check();
  f.saved.assessment = { ready: false, reasons: ['Fresh evidence gap <img src=remote>'] };
  f.saved.candidate = { ...f.saved.candidate, photoUrl: 'https://remote.invalid/photo.jpg' };
  await page.getByRole('button', { name: 'Refresh saved assessment', exact: true }).click();
  await page.getByText('Held — imported evidence needs attention', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Authorize one private proposal within saved limits', { exact: true }).isChecked(), false);
  assert.equal(await page.getByRole('button', { name: 'Build one private proposal', exact: true }).isDisabled(), true);
  assert.deepEqual(f.calls.filter(c => c.operation === 'assisted_get').map(c => c.input), [{ id: f.saved.id }]);
  assert.deepEqual(f.remote, []); assert.equal(await page.locator('img[src=remote]').count(), 0);
});
test('ambiguous Build failure requires explicit same-intent replay, never automatic retry or legacy work', async t => {
  const f = await fixture(t, {}, 'assisted_build'), { page } = f; await f.load(f.input);
  await page.getByLabel('I authorize saving this supplied evidence', { exact: true }).check();
  await page.getByRole('button', { name: 'Save supplied evidence', exact: true }).click();
  await page.getByLabel('Authorize one private proposal within saved limits', { exact: true }).check();
  await page.getByRole('button', { name: 'Build one private proposal', exact: true }).click();
  await page.locator('.assisted-error').filter({ hasText: /not confirmed/i }).waitFor();
  assert.equal(f.calls.filter(c => c.operation === 'assisted_build').length, 1);
  await page.getByRole('button', { name: 'Build one private proposal', exact: true }).click();
  await page.waitForFunction(() => !window.FactoryBatchBusy);
  const builds = f.calls.filter(c => c.operation === 'assisted_build'); assert.equal(builds.length, 2); assert.deepEqual(builds[0], builds[1]);
  assert.deepEqual(f.calls.filter(c => /accept|publish|build_site|candidates_import/.test(c.operation)), []);
});
