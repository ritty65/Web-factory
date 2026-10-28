import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { startServer } from '../src/server.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

async function fixture(t) {
  const root = await mkdtemp('/tmp/factory-design-ui-');
  const options = { dbPath: path.join(root, 'fixture.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false };
  await initialize(options);
  const store = openStore(options), service = createService(store, options), app = await startServer(service, { port: 0, previewPort: 0 });
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true });
  t.after(async () => { await browser.close(); await app.close(); store.close(); });
  const page = await browser.newPage(), requests = [], errors = [];
  await page.context().route('**/*', r => r.request().url().startsWith(app.url + '/') ? r.continue() : r.abort());
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().endsWith('/api/op')) requests.push(r.postDataJSON()); });
  const campaign = store.createCampaign({ name: 'Joe fixture <img src=x onerror=alert(1)>', query: 'Fixture only', area: 'Houston', niche: 'Detailing', buildLimit: 2 });
  const original = store.createJob({ campaignId: campaign.id, kind: 'site', input: {} });
  const job = store.updateJob(original.id, { state: 'blocked', stage: 'critique', retryLimit: 0, errorCode: 'DESIGN_REWORK', outputs: { qaPass: true, siteRelative: 'fixture/site', siteDigest: 'a'.repeat(64), reviewStatus: 'creative_rework_required' } });
  const facts = [
    { sourceId: 'source-booking', excerpt: 'Exterior wash', text: 'Exterior wash', sourceUrl: 'https://booksy.com/en-us/1786806_fixture' },
    { sourceId: 'source-booking', excerpt: 'Interior cleaning', text: 'Interior cleaning', sourceUrl: 'https://booksy.com/en-us/1786806_fixture' },
    { sourceId: 'source-held', excerpt: '<img src=x onerror=alert(1)>', text: '<img src=x onerror=alert(1)>', sourceUrl: 'javascript:alert(1)' },
  ];
  const context = { id: job.id, siteDigest: job.outputs.siteDigest, policyDigest: 'b'.repeat(64), name: campaign.name, parentState: 'blocked', assessment: { ready: true, reasons: [] }, scope: { deadlineAt: '2099-10-28T06:06:44Z', modelCallLimit: 16 }, usage: { modelCalls: 8 }, remaining: { modelCalls: 8 }, revisionCount: 0, availableFacts: facts, limitations: ['Address unconfirmed. No new source calls.'] };
  let submit = route => route.abort('failed');
  await page.route('**/api/op', async route => {
    const { operation } = route.request().postDataJSON();
    if (operation === 'design_context_get') return route.fulfill({ json: context });
    if (operation === 'assisted_redesign') return submit(route);
    if (operation === 'batch_status') return route.fulfill({ json: { items: [] } });
    return route.continue();
  });
  let visit = 0;
  const open = async () => { await page.goto(app.url + '/?design-fixture=' + ++visit + '#review/' + job.id); await page.waitForFunction(() => window.FactoryReviewReady); };
  const panel = async () => { await page.getByRole('button', { name: 'Redesign from feedback', exact: true }).click(); await page.getByLabel('What should change?', { exact: true }).waitFor(); };
  return { root, store, page, requests, errors, job, context, facts, open, panel, setSubmit: fn => { submit = fn; } };
}

test('retained context is explicit read-only, sourced choices start unchecked, keyboard and narrow layouts work', async t => {
  const f = await fixture(t), before = f.store.jobs().length;
  await f.open(); assert.equal(f.requests.filter(r => r.operation === 'design_context_get').length, 0);
  assert.equal(f.requests.filter(r => r.operation === 'assisted_redesign').length, 0);
  await f.page.getByRole('button', { name: 'Redesign from feedback', exact: true }).focus(); await f.page.keyboard.press('Enter');
  await f.page.getByLabel('What should change?', { exact: true }).waitFor();
  assert.equal(f.requests.filter(r => r.operation === 'design_context_get').length, 1);
  assert.equal(await f.page.locator('[data-design-workbench] input:checked').count(), 0);
  assert.equal(await f.page.locator('img[src=x]').count(), 0);
  assert.equal(await f.page.locator('[data-design-workbench] a[href^="javascript:"]').count(), 0);
  assert.match(await f.page.locator('[data-design-workbench]').innerText(), /Address unconfirmed/);
  assert.match(await f.page.locator('[data-design-workbench]').innerText(), /2099/);
  assert.equal(await f.page.getByRole('button', { name: 'Generate private revision', exact: true }).isDisabled(), true);
  assert.equal(await f.page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'What should change?');
  for (const width of [1440, 390, 320]) {
    await f.page.setViewportSize({ width, height: 900 });
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow at ${width}`);
    await f.page.screenshot({ path: path.join(f.root, `workbench-${width}.png`), fullPage: true });
  }
  assert.equal(f.store.jobs().length, before); assert.deepEqual(f.errors, []);
});

test('one explicit request sends exact multiple facts and literal feedback; ambiguity freezes intent across rerenders', async t => {
  const f = await fixture(t); await f.open(); await f.panel();
  const feedback = 'Joe site sucks <img src=x onerror=alert(1)>';
  await f.page.getByLabel('What should change?', { exact: true }).fill(feedback);
  for (const fact of f.facts.slice(0, 2)) await f.page.getByLabel(fact.text, { exact: true }).check();
  await f.page.getByLabel('Authorize one private revision within the saved remaining limits', { exact: true }).check();
  await f.page.getByRole('button', { name: 'Generate private revision', exact: true }).click();
  await f.page.getByText(/Response uncertain/).waitFor();
  const writes = () => f.requests.filter(r => r.operation === 'assisted_redesign');
  assert.equal(writes().length, 1);
  assert.deepEqual({ ...writes()[0].input, requestId: 'stable' }, { id: f.job.id, siteDigest: f.context.siteDigest, policyDigest: f.context.policyDigest, requestId: 'stable', authorized: true, feedback, contentFacts: f.facts.slice(0, 2).map(({ sourceId, excerpt, text }) => ({ sourceId, excerpt, text })) });
  assert.match(writes()[0].input.requestId, /^[A-Za-z0-9_-]+$/);
  await f.page.getByRole('button', { name: 'Phone', exact: true }).click();
  assert.equal(await f.page.getByLabel('What should change?', { exact: true }).inputValue(), feedback);
  assert.equal(await f.page.getByLabel('What should change?', { exact: true }).isDisabled(), true);
  await f.page.getByRole('button', { name: 'Refresh saved context', exact: true }).click();
  await f.page.getByRole('button', { name: 'Retry same revision request', exact: true }).click();
  await f.page.getByText(/Response uncertain/).waitFor();
  assert.equal(writes().length, 2); assert.deepEqual(writes()[0].input, writes()[1].input);
  assert.equal(await f.page.locator('img[src=x]').count(), 0); assert.deepEqual(f.errors, []);
});

test('host holds, stale hashes, exhausted budget and expired deadline cannot enable generation', async t => {
  const f = await fixture(t);
  for (const patch of [
    { assessment: { ready: false, reasons: ['Remaining model allowance exhausted'] } },
    { assessment: { ready: false, reasons: ['Original batch deadline expired'] } },
    { siteDigest: 'c'.repeat(64) },
    { policyDigest: null },
  ]) {
    Object.assign(f.context, { assessment: { ready: true, reasons: [] }, siteDigest: f.job.outputs.siteDigest, policyDigest: 'b'.repeat(64) }, patch);
    await f.open(); await f.panel();
    await f.page.getByLabel('What should change?', { exact: true }).fill('Please redesign the composition.');
    await f.page.getByLabel('Authorize one private revision within the saved remaining limits', { exact: true }).check();
    assert.equal(await f.page.getByRole('button', { name: 'Generate private revision', exact: true }).isDisabled(), true);
  }
  assert.equal(f.requests.filter(r => r.operation === 'assisted_redesign').length, 0);
});

test('wrong parent state, missing digest or consumed revision have no entry action', async t => {
  const f = await fixture(t);
  for (const patch of [{ state: 'failed' }, { outputs: { ...f.job.outputs, qaPass: false } }, { outputs: { ...f.job.outputs, siteDigest: null } }, { outputs: { ...f.job.outputs, assistedRevisionId: 'already-created' } }]) {
    f.store.updateJob(f.job.id, { ...f.job, ...patch }); await f.open();
    assert.equal(await f.page.getByRole('button', { name: 'Redesign from feedback', exact: true }).count(), 0);
  }
  assert.equal(f.requests.filter(r => r.operation === 'design_context_get').length, 0);
});

test('only an actual queued response reports generation and opens the saved child work record', async t => {
  const f = await fixture(t), original = f.store.createJob({ campaignId: f.job.campaignId, kind: 'site', input: { fixture: 'child' } }), child = f.store.updateJob(original.id, { state: 'queued' });
  f.setSubmit(route => route.fulfill({ json: { job: child, batch: { id: 'fixture-batch' }, replayed: false } }));
  await f.open(); await f.panel();
  await f.page.getByLabel('What should change?', { exact: true }).fill('Use a distinct photo-led layout.');
  await f.page.getByLabel('Authorize one private revision within the saved remaining limits', { exact: true }).check();
  await f.page.getByRole('button', { name: 'Generate private revision', exact: true }).click();
  await f.page.waitForFunction(id => location.hash === '#jobs/' + id, child.id);
  assert.match(await f.page.locator('#notice').innerText(), /Generating/);
  assert.equal(f.requests.filter(r => r.operation === 'assisted_redesign').length, 1); assert.deepEqual(f.errors, []);
});

test('actual pre-package held shape can open context without output digest; only the host-verified hash admits a request', async t => {
  const f = await fixture(t);
  f.store.updateJob(f.job.id, { outputs: { ...f.job.outputs, siteDigest: undefined, qaRelative: `jobs/${f.job.id}/attempt-0/qa-2` } });
  await f.open();
  assert.equal(await f.page.getByText('Host-verified parent version', { exact: true }).count(), 0);
  await f.panel();
  await f.page.getByText('Host-verified parent version', { exact: true }).waitFor();
  await f.page.getByLabel('What should change?', { exact: true }).fill('Joe site sucks; use a distinct photo-led design.');
  await f.page.getByLabel('Authorize one private revision within the saved remaining limits', { exact: true }).check();
  await f.page.getByRole('button', { name: 'Generate private revision', exact: true }).click();
  await f.page.getByText(/Response uncertain/).waitFor();
  const writes = f.requests.filter(r => r.operation === 'assisted_redesign');
  assert.equal(writes.length, 1); assert.equal(writes[0].input.siteDigest, f.context.siteDigest);
  assert.equal(f.store.job(f.job.id).outputs.siteDigest, undefined);
  assert.equal(f.store.job(f.job.id).state, 'blocked');
});
