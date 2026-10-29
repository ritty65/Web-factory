import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { startServer } from '../src/server.mjs';
import { executeJob } from '../src/worker.mjs';
import { reconcileBatches } from '../src/batches.mjs';
import { getBatch, saveBatch } from '../src/batch-store.mjs';
import { hash } from '../src/contracts.mjs';
import { batchSettings, intakeFixture } from './helpers-batch.mjs';
import { assessProspect } from '../src/prospects.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright'), { default: AxeBuilder } = require('@axe-core/playwright');
async function fixture(t) {
  const root = await mkdtemp('/tmp/factory-leads-ui-');
  const options = { dbPath: path.join(root, 'db.sqlite'), stateRoot: path.join(root, 'state'), autoRun: false, batchPrerequisites: async () => ({ ready: true }) };
  await initialize(options); const store = openStore(options), service = createService(store, options), app = await startServer(service, { port: 0, previewPort: 0 });
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true }), context = await browser.newContext(), page = await context.newPage();
  await context.route('**/*', r => r.request().url().startsWith(app.url + '/') ? r.continue() : r.abort());
  t.after(async () => { await browser.close(); await app.close(); store.close(); });
  return { root, store, service, app, page };
}
async function discover(f) {
  const j = f.store.jobs()[0];
  const done = await executeJob(f.store, j.id, { discover: async (_, ctx) => {
    const x = intakeFixture(), dir = path.join(ctx.jobRoot, 'sources'); await mkdir(dir, { recursive: true });
    for (const o of x.observations) await writeFile(path.join(dir, o.id + '.json'), JSON.stringify(o));
    for (const s of x.searches) await writeFile(path.join(dir, `search-${hash(s.query).slice(0, 16)}.json`), JSON.stringify(s));
    for (const v of x.imageViews) await writeFile(path.join(dir, `image-view-${hash(v).slice(0, 16)}.json`), JSON.stringify(v));
    return { candidates: [x.candidate], live: false };
  } });
  assert.equal(done.state, 'review_ready', done.message); await reconcileBatches(f.store);
  return (await f.service.dispatch('batch_status')).items[0];
}
test('two-step opt-in saves explicitly, discovers only, confirms exact enrichment and replays lost response after reload', async t => {
  const f = await fixture(t), { page, app, service, store, root } = f;
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'legacy-fixture', settings: batchSettings, acknowledged: true });
  await page.goto(app.url); await page.waitForFunction(() => window.FactoryBatchReady);
  await page.getByRole('button', { name: 'Use two-step setup', exact: true }).click({ timeout: 1500 });
  assert.equal((await service.dispatch('batch_status')).preset.settings.workflow, undefined);
  assert.equal(await page.getByLabel('Private site target (up to 10)', { exact: true }).inputValue(), '1');
  await page.getByLabel('Business categories', { exact: true }).fill('Photo-rich <img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'Refresh ↻', exact: true }).click(); await page.waitForFunction(() => window.FactoryBatchReady);
  assert.match(await page.getByLabel('Business categories', { exact: true }).inputValue(), /<img/);
  await page.getByText('Review the saved attempt limits', { exact: true }).click();
  await page.getByLabel('Research rounds', { exact: true }).fill('1');
  await page.getByLabel('I reviewed this scope, permitted public sources and attempt limits.').check();
  await page.getByRole('button', { name: 'Save one-time setup', exact: true }).click();
  await page.getByText('Saved setup. Nothing has started.', { exact: true }).waitFor();
  assert.equal((await service.dispatch('batch_status')).preset.settings.workflow, 'leads_first');
  await page.getByRole('button', { name: 'Find leads', exact: true }).click();
  await page.getByRole('button', { name: 'Stop this batch', exact: true }).waitFor();
  assert.equal(store.jobs().length, 1); assert.equal(store.jobs()[0].input.phase, 'discovery');
  const b = await discover(f); assert.equal(b.state, 'awaiting_selection', JSON.stringify(b)); assert.equal(store.jobs().length, 1);
  await page.goto(`${app.url}/#start/${b.id}`); await page.reload();
  await page.getByRole('heading', {name:'Choose one saved lead',exact:true}).waitFor({timeout:3000});
  const next = page.locator('.batch-next-action a.primary');
  assert.equal(new URL(await next.getAttribute('href'), app.url).hash, '#leads/' + b.id, 'Selection pause must lead to saved prospects, not the empty review inbox');
  await next.click(); await page.waitForFunction(() => window.FactoryLeadsReady);
  assert.equal(store.jobs().length, 1, 'Opening the next selection screen must not start enrichment');
  await page.getByRole('button', { name: 'Make this website', exact: true }).click();
  assert.equal(store.jobs().length, 1); assert.equal(getBatch(store, b.id).selection, null);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(store.jobs().length, 1);
  await page.getByText('Evidence: Website / Location / Activity & photos', { exact: true }).first().click();
  assert.equal(await page.getByRole('group', { name: 'Early screening', exact: true }).count(), 1, 'The named screening block needs a valid accessible group role, not a labelled generic div');
  assert.equal(await page.locator('.lead-shortlist .lead-row details details').count(), 0, 'One evidence disclosure must expose supporting evidence without nested digging');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `expanded leads reflow ${width}`);
    assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map(v => v.id), []);
    await page.screenshot({ path: path.join(root, `leads-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Make this website', exact: true }).click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `reflow ${width}`);
    assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map(v => v.id), []);
    await page.screenshot({ path: path.join(root, `confirmation-${width}.png`), fullPage: true });
  }
  const inputs = [];
  await page.route('**/api/op', async r => {
    const x = r.request().postDataJSON();
    if (x.operation === 'batch_build_selected') { inputs.push(x.input); if (inputs.length === 1) { const response = await r.fetch(); assert.equal(response.status(), 200, await response.text()); return r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture committed response loss' }) }); } }
    await r.continue();
  });
  await page.getByRole('button', { name: 'Check business & create website', exact: true }).click();
  await page.getByText(/Selection response not confirmed/).waitFor(); assert.equal(store.jobs().length, 2);
  await page.reload(); await page.waitForFunction(() => window.FactoryLeadsReady);
  assert.equal(inputs.length, 1);
  await page.getByRole('button', { name: 'Check same selection request', exact: true }).click();
  await page.getByText('Checking this business — no website yet.', { exact: true }).waitFor();
  assert.deepEqual(inputs[1], inputs[0]); assert.equal(store.jobs().length, 2); assert.equal(store.jobs().filter(j => j.kind === 'site').length, 0);
  assert.equal(await page.locator('img[src=x]').count(), 0);
  console.log('Leads UI fixture evidence: ' + root);
});
test('empty Lead desk is read-only with truthful source capabilities', async t => {
  const { page, app, store } = await fixture(t);
  await page.goto(app.url + '/#leads'); await page.waitForFunction(() => window.FactoryLeadsReady, { timeout: 2000 });
  await page.getByText('No business is ready to choose.', { exact: true }).waitFor();
  assert.equal(store.jobs().length, 0); assert.equal(store.campaigns().length, 0);
  await page.getByText('Source capabilities', { exact: true }).click();
  await page.getByText(/Maps\/Places · Booksy bulk/).waitFor();
});
test('adopted legacy completed history preserves explicit two-step opt-in without silently changing setup', async t => {
  const { root, store, service, app, page } = await fixture(t);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'frontdoor-setup', settings: batchSettings, acknowledged: true });
  const b = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'frontdoor-history', authorized: true });
  store.updateJob(store.jobs()[0].id, { state: 'review_ready', outputs: { candidateIds: [] } });
  saveBatch(store, { ...getBatch(store, b.id), state: 'complete', phase: 'complete', message: 'Retained historical shortfall. '.repeat(40), usage: { modelRequests: 1, searches: 2, inspections: 3, imageViews: 0 } });
  const original = getBatch(store, b.id), preset = (await service.dispatch('batch_status')).preset;
  for (const [width, height] of [[1280, 720], [390, 844]]) {
    await page.setViewportSize({ width, height }); await page.goto(app.url + '/#start');
    await page.waitForFunction(() => window.FactoryBatchReady); await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    assert.equal(await page.locator('.simple-outcome').evaluate(e => Boolean(e.compareDocumentPosition(document.querySelector('.batch-launch')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'A retained outcome must be explained before another paid start');
    const action = page.getByRole('button', { name: /Find & build up to 3 Houston websites/ }); await action.scrollIntoViewIfNeeded(); const bounds = await action.boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= height, `saved workflow action remains reachable at ${width}: ${JSON.stringify(bounds)}`);
    assert.equal(await page.locator('.lead-entry').evaluate(e => Boolean(e.compareDocumentPosition(document.querySelector('.batch-progress')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    await page.screenshot({ path: path.join(root, `frontdoor-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Use two-step setup', exact: true }).click();
  await page.getByText('Unsaved setup edits', { exact: true }).waitFor();
  assert.deepEqual((await service.dispatch('batch_status')).preset, preset);
  assert.deepEqual(getBatch(store, b.id), original); assert.equal(store.jobs().length, 1); assert.equal(store.campaigns().length, 1);
  console.log('Front door fixture evidence: ' + root);
});
test('booking-only, suppressed, expired and stale evidence have no usable production action; hostile reasons stay literal', async t => {
  const f = await fixture(t), { service, store, app, page } = f;
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'states-setup', acknowledged: true, settings: { ...batchSettings, targetCount: 1, maxResearchRounds: 1, workflow: 'leads_first', discoverySearchLimit: 2 } });
  const b = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'states-start', authorized: true });
  await discover(f);
  const first = getBatch(store, b.id).members[0], c = store.candidate(first.candidateId);
  const book = intakeFixture(2), url = 'https://booksy.com/en-us/synthetic';
  book.observations[0].links.push({ url, text: 'Book' });
  book.observations.push({ id: 'source-booking', url, inspectedAt: new Date().toISOString(), blocked: false, text: 'Synthetic booking' });
  book.candidate.websiteCheck.linkChecks.push({ url, sourceId: 'source-booking', status: 'official', reason: 'Observed booking' });
  const booking = store.saveCandidate(b.campaignId, book.candidate), prospect = assessProspect(booking, book);
  assert.equal(prospect.state, 'booking_only');
  saveBatch(store, { ...getBatch(store, b.id), members: [first, { candidateId: booking.id, ready: false, evidenceDigest: hash(booking), prospect, reasons: ['Literal <img src=x onerror=alert(1)>'], contacts: [] }] });
  await page.goto(`${app.url}/#leads/${b.id}`); await page.waitForFunction(() => window.FactoryLeadsReady);
  await page.locator('.other-results > summary').click();
  const row = page.getByRole('article').filter({ has: page.getByRole('heading', { name: booking.name, exact: true }) });
  assert.equal(await row.getByRole('button', { name: 'Make this website', exact: true }).count(), 0);
  await row.getByText(prospect.buildUnsupported, { exact: true }).waitFor();
  assert.equal(await page.locator('img[src=x]').count(), 0);
  await page.getByRole('button', { name: 'Booking only', exact: true }).click(); await page.waitForFunction(() => window.FactoryLeadsReady);
  assert.equal(await page.getByRole('article').count(), 1);
  await page.getByRole('button', { name: 'All leads', exact: true }).click(); await page.waitForFunction(() => window.FactoryLeadsReady);
  const selectionInputs = [];
  page.on('request', request => { if (request.url().endsWith('/api/op')) { const x = request.postDataJSON(); if (x.operation === 'batch_build_selected') selectionInputs.push(x.input); } });
  store.replaceCandidate(c.id, { ...c, summary: 'Changed evidence after listing' }, 'fixture');
  const currentCandidate = store.candidate(c.id), digest = hash(currentCandidate);
  // Synthetic host intake refresh: the browser still has the old listing/digest.
  saveBatch(store, { ...getBatch(store, b.id), members: getBatch(store, b.id).members.map(m => m.candidateId === c.id ? { ...m, evidenceDigest: digest, prospect: { ...m.prospect, evidenceDigest: digest } } : m) });
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: c.name, exact: true }) }).getByRole('button', { name: 'Make this website', exact: true }).click();
  await page.getByRole('button', { name: 'Check business & create website', exact: true }).click();
  await page.getByText(/Selection did not start/).waitFor({ timeout: 1500 }); assert.equal(store.jobs().length, 1);
  await page.waitForFunction(() => window.FactoryLeadsReady);
  assert.equal(await page.getByRole('button', { name: 'Check same selection request', exact: true }).count(), 0);
  const make = page.getByRole('article').filter({ has: page.getByRole('heading', { name: c.name, exact: true }) }).getByRole('button', { name: 'Make this website', exact: true });
  assert.equal(await make.isEnabled(), true);
  assert.equal(selectionInputs.length, 1); // Authoritative refresh never dispatches a replacement.
  await make.click(); assert.equal(store.jobs().length, 1);
  await page.getByRole('button', { name: 'Check business & create website', exact: true }).click();
  await page.getByText('Checking this business — no website yet.', { exact: true }).waitFor();
  assert.equal(store.jobs().length, 2); assert.equal(selectionInputs.length, 2);
  assert.notEqual(selectionInputs[0].requestId, selectionInputs[1].requestId);
  assert.notEqual(selectionInputs[0].evidenceDigest, selectionInputs[1].evidenceDigest);
  assert.equal(selectionInputs[1].evidenceDigest, digest);
  const salesCase = await service.dispatch('case_open', { candidateId: c.id });
  await service.dispatch('case_event', { id: salesCase.id, requestId: 'suppressed-fixture', kind: 'suppressed', note: 'Synthetic opt-out', occurredAt: new Date().toISOString() });
  await page.reload(); await page.waitForFunction(() => window.FactoryLeadsReady);
  assert.equal(await page.locator('.lead-row button:enabled').count(), 0);
  saveBatch(store, { ...getBatch(store, b.id), deadlineAt: '2020-01-01T00:00:00Z' });
  const before = store.db.prepare('SELECT total_changes() n').get().n;
  await page.reload(); await page.waitForFunction(() => window.FactoryLeadsReady);
  assert.equal(await page.locator('.lead-row button:enabled').count(), 0);
  assert.equal(store.db.prepare('SELECT total_changes() n').get().n, before);
});
for (const rejection of ['expired', 'policy']) test(`${rejection} confirmation releases only rejected intent; separately authorized new run is selectable without browser storage repair`, async t => {
  const f = await fixture(t), { service, store, page, app } = f;
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'expired-recovery-setup', acknowledged: true, settings: { ...batchSettings, targetCount: 1, maxResearchRounds: 1, workflow: 'leads_first', discoverySearchLimit: 2 } });
  const b = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'expired-recovery-start', authorized: true });
  await discover(f);
  await page.goto(`${app.url}/#leads/${b.id}`); await page.waitForFunction(() => window.FactoryLeadsReady);
  await page.getByRole('button', { name: 'Make this website', exact: true }).click();
  saveBatch(store, { ...getBatch(store, b.id), ...(rejection === 'expired' ? { deadlineAt: '2020-01-01T00:00:00Z' } : { policyDigest: '0'.repeat(64) }) });
  await page.getByRole('button', { name: 'Check business & create website', exact: true }).click();
  await page.getByText(/Selection did not start/).waitFor(); await page.waitForFunction(() => window.FactoryLeadsReady);
  assert.equal(store.jobs().length, 1); assert.equal(store.campaigns().length, 1);
  if (rejection === 'expired') assert.equal(await page.getByRole('button', { name: 'Make this website', exact: true }).count(), 0);
  else await page.getByText(/Selection did not start:.*explicitly acknowledge currentPolicyDigest/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Check same selection request', exact: true }).count(), 0);
  // Explicit fixture/operator authority, never a recovery-created campaign.
  await service.dispatch('batch_stop', { id: b.id });
  const next = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'new-authorized-recovery-start', authorized: true });
  const job = store.jobs().find(j => j.campaignId === next.campaignId);
  const c = store.saveCandidate(next.campaignId, intakeFixture(7).candidate);
  store.updateJob(job.id, { state: 'review_ready', outputs: { candidateIds: [c.id], intake: [{ candidateId: c.id, ready: false, reasons: ['Full enrichment needed'], contacts: [], prospect:assessProspect(c,intakeFixture(7)) }] } });
  await reconcileBatches(store);
  await page.goto(`${app.url}/#leads/${next.id}`); await page.waitForFunction(() => window.FactoryLeadsReady);
  assert.equal(await page.getByRole('button', { name: 'Make this website', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Make this website', exact: true }).click();
  assert.equal(store.jobs().length, 2);
  await page.getByRole('button', { name: 'Check business & create website', exact: true }).click();
  await page.getByText('Checking this business — no website yet.', { exact: true }).waitFor();
  assert.equal(store.jobs().length, 3); assert.equal(getBatch(store, b.id).selection, null);
});
