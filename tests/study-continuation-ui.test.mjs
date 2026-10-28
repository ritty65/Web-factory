import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { startServer } from '../src/server.mjs';
import { hash } from '../src/contracts.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const label = 'Continue with a passing design';
const explanation = 'Failed alternatives stay rejected. Only passing desktop/phone designs can be selected. Uses the same job, original deadline and remaining allowance.';

async function fixture(t) {
  const root = await mkdtemp('/tmp/factory-study-continuation-ui-');
  const options = { dbPath: path.join(root, 'fixture.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false };
  await initialize(options);
  const store = openStore(options), service = createService(store, options), app = await startServer(service, { port: 0, previewPort: 0 });
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true });
  t.after(async () => { await browser.close(); await app.close(); store.close(); });
  const context = await browser.newContext(), page = await context.newPage(), requests = [], errors = [];
  await context.route('**/*', r => r.request().url().startsWith(app.url + '/') ? r.continue() : r.abort());
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().endsWith('/api/op')) requests.push({ ...r.postDataJSON(), method: r.method(), csrf: r.headers()['x-factory-csrf'] }); });
  const campaign = store.createCampaign({ name: 'Synthetic <img src=x onerror=alert(1)>', query: 'Fixture only', area: 'Houston', niche: 'Synthetic workshop' });
  const original = store.createJob({ campaignId: campaign.id, kind: 'site', input: {} });
  const job = store.updateJob(original.id, { state: 'blocked', stage: 'directions-render', errorCode: 'DESIGN_STUDY_QA', retryLimit: 0 });
  const relative = `jobs/${job.id}/attempt-0/directions/results.json`, bytes = Buffer.from('{"fixture":true}');
  await mkdir(path.dirname(path.join(store.stateRoot, relative)), { recursive: true });
  await writeFile(path.join(store.stateRoot, relative), bytes);
  const artifact = store.artifact({ jobId: job.id, kind: 'directions', relative, label: 'Synthetic render results', sha256: hash(bytes), bytes: bytes.length });
  const open = async () => { await page.goto(app.url + '/#jobs/' + job.id); await page.locator('#job-detail').waitFor(); };
  return { store, page, requests, errors, job, artifact, open };
}

test('study continuation is explicit, keyboard accessible, literal and exact-bound with no load mutation', async t => {
  const f = await fixture(t), policyDigest = 'a'.repeat(64);
  await f.page.route('**/api/op', async route => {
    const { operation } = route.request().postDataJSON();
    if (operation === 'batch_status') return route.fulfill({ json: { currentPolicyDigest: policyDigest, items: [] } });
    if (operation === 'study_continue') {
      f.store.updateJob(f.job.id, { state: 'queued', stage: 'selection', errorCode: null, studyContinuation: { receiptId: 'fixture-receipt' } });
      return route.fulfill({ json: { job: f.store.job(f.job.id), batch: { id: 'fixture-batch' }, replayed: false } });
    }
    return route.continue();
  });
  await f.open();
  assert.ok(f.requests.every(r => r.operation === 'job_get'));
  assert.equal(await f.page.getByText(explanation, { exact: true }).count(), 1);
  assert.equal(await f.page.locator('img[src="x"]').count(), 0);
  const control = f.page.getByRole('button', { name: label, exact: true });
  assert.equal(await control.getAttribute('type'), 'button');
  await control.focus(); await f.page.keyboard.press('Enter');
  await f.page.getByText('Study continuation queued. This is not a finished or accepted website.', { exact: true }).waitFor();
  await f.page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent === 'Continue with a passing design'));
  const request = f.requests.find(r => r.operation === 'study_continue');
  assert.equal(request.method, 'POST'); assert.match(request.csrf, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(request.input).sort(), ['authorized', 'id', 'policyDigest', 'renderDigest', 'requestId']);
  assert.deepEqual({ ...request.input, requestId: 'stable' }, { id: f.job.id, renderDigest: f.artifact.sha256, policyDigest, requestId: 'stable', authorized: true });
  assert.match(request.input.requestId, /^[A-Za-z0-9_-]+$/);
  assert.ok(f.requests.findIndex(r => r.operation === 'batch_status') < f.requests.findIndex(r => r.operation === 'study_continue'));
  assert.ok(f.requests.every(r => ['job_get', 'batch_status', 'study_continue'].includes(r.operation)));
  assert.deepEqual(f.errors, []);
});

test('unavailable policy and backend rejection stay held without automatic mutations or unsafe error markup', async t => {
  const f = await fixture(t); let policy = null;
  await f.page.route('**/api/op', async route => {
    const { operation } = route.request().postDataJSON();
    if (operation === 'batch_status') return route.fulfill({ json: { currentPolicyDigest: policy, items: [] } });
    if (operation === 'study_continue') return route.fulfill({ status: 400, json: { error: 'BATCH_COMPLETION_BUDGET', message: 'Held <img src=x onerror=alert(1)>: original remaining allowance is insufficient.' } });
    return route.continue();
  });
  await f.open(); const control = f.page.getByRole('button', { name: label, exact: true });
  await control.click(); await f.page.getByText('Current production policy unavailable. No continuation submitted.', { exact: true }).waitFor();
  assert.equal(f.requests.filter(r => r.operation === 'study_continue').length, 0);
  policy = 'e'.repeat(64);
  await control.click(); await f.page.getByText('Held <img src=x onerror=alert(1)>: original remaining allowance is insufficient.', { exact: true }).waitFor();
  assert.equal(f.requests.filter(r => r.operation === 'study_continue').length, 1);
  assert.equal(f.store.job(f.job.id).state, 'blocked');
  assert.equal(await f.page.locator('img[src="x"]').count(), 0);
  assert.equal(await control.isEnabled(), true);
  assert.ok(f.requests.every(r => ['job_get', 'batch_status', 'study_continue'].includes(r.operation)));
  assert.deepEqual(f.errors, []);
});

test('ambiguous network failure never auto-retries and preserves the entire intent on explicit second click', async t => {
  const f = await fixture(t); let policy = 'b'.repeat(64), attempts = 0;
  await f.page.route('**/api/op', async route => {
    const { operation } = route.request().postDataJSON();
    if (operation === 'batch_status') return route.fulfill({ json: { currentPolicyDigest: policy, items: [] } });
    if (operation === 'study_continue') { attempts++; return route.abort('failed'); }
    return route.continue();
  });
  await f.open(); const control = f.page.getByRole('button', { name: label, exact: true });
  await control.click(); await f.page.locator('#notice[role="alert"]').waitFor();
  assert.equal(attempts, 1);
  // A rerender and newer policy must not silently replace an ambiguously submitted intent.
  policy = 'c'.repeat(64);
  await f.page.getByRole('button', { name: 'Close detail', exact: true }).click();
  await f.page.getByRole('button', { name: 'Inspect job', exact: true }).click();
  await control.click(); await f.page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Continue with a passing design')?.disabled);
  assert.equal(attempts, 2);
  const writes = f.requests.filter(r => r.operation === 'study_continue');
  assert.deepEqual(writes[0].input, writes[1].input);
  assert.ok(f.requests.every(r => ['job_get', 'batch_status', 'study_continue'].includes(r.operation)));
  assert.deepEqual(f.errors, []);
});

test('wrong states, consumed repair/continuation and missing exact artifacts have no continuation action', async t => {
  const f = await fixture(t);
  for (const patch of [{ state: 'failed' }, { errorCode: 'DESIGN_SELECTION' }, { stage: 'proposal' }, { directionRepair: { used: true } }, { studyContinuation: { receiptId: 'used' } }, { attempt: 1 }, { input: { parentSiteJobId: 'parent' } }]) {
    f.store.updateJob(f.job.id, { ...f.job, ...patch }); await f.open();
    assert.equal(await f.page.getByRole('button', { name: label, exact: true }).count(), 0, JSON.stringify(patch));
  }
  f.store.updateJob(f.job.id, f.job);
  f.store.db.prepare('DELETE FROM factory_artifact WHERE job_id=?').run(f.job.id);
  for (const artifact of [
    { kind: 'directions', relative: `jobs/${f.job.id}/attempt-0/directions/study-0-1280.png`, sha256: 'd'.repeat(64) },
    { kind: 'qa', relative: `jobs/${f.job.id}/attempt-0/directions/results.json`, sha256: 'd'.repeat(64) },
    { kind: 'directions', relative: `jobs/${f.job.id}/attempt-0/directions/results.json`, sha256: 'invalid' },
    { kind: 'directions', relative: 'jobs/unrelated/attempt-0/directions/results.json', sha256: 'd'.repeat(64) },
  ]) {
    f.store.db.prepare('DELETE FROM factory_artifact WHERE job_id=?').run(f.job.id);
    f.store.artifact({ jobId: f.job.id, label: 'Not a matching results artifact', bytes: 1, ...artifact });
    await f.open(); assert.equal(await f.page.getByRole('button', { name: label, exact: true }).count(), 0);
  }
  assert.ok(f.requests.every(r => r.operation === 'job_get'));
  assert.deepEqual(f.errors, []);
});
