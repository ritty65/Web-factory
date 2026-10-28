import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { startServer } from '../src/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const session = { csrf: 'a'.repeat(64), previewOrigin: 'http://127.0.0.1:8781' };
const renewed = { ...session, csrf: 'b'.repeat(64) };
function client(fetch, initial = session) {
  const notice = { textContent: '', setAttribute() {} };
  const context = vm.createContext({ fetch, URL, location: { origin: 'http://127.0.0.1:8780' }, document: { querySelector: () => notice }, setTimeout: () => 0, clearTimeout() {} });
  vm.runInContext(source.slice(0, source.indexOf('function sectionTop')) + '\nglobalThis.client = { op, state };', context);
  context.client.state.session = initial;
  return context.client;
}

test('CSRF recovery is single-flight, including a late old-token rejection; payload bytes stay identical', async () => {
  let sessions = 0, releaseLate;
  const late = new Promise(resolve => { releaseLate = resolve; });
  const bodies = new Map(), attempts = new Map();
  const c = client(async (url, options) => {
    if (url === '/api/session') { sessions++; assert.equal(options.cache, 'no-store'); return reply(200, renewed); }
    const { input } = JSON.parse(options.body), id = input.requestId;
    bodies.set(id, [...(bodies.get(id) || []), options.body]);
    attempts.set(id, (attempts.get(id) || 0) + 1);
    if (options.headers['x-factory-csrf'] === session.csrf) {
      if (id === 'late') await late;
      return reply(403, { error: 'CSRF', message: 'fixture guard' });
    }
    if (id === 'first') releaseLate();
    return reply(200, { saved: true });
  });
  const results = await Promise.all(['first', 'second', 'late'].map(requestId => c.op('fixture_save', { requestId, note: 'literal draft' })));
  assert.ok(results.every(r => r.saved)); assert.equal(sessions, 1);
  for (const [id, values] of bodies) { assert.equal(attempts.get(id), 2); assert.equal(values[0], values[1]); }
});

test('only structured HTTP 403 CSRF is retried, never ambiguous or unrelated failures', async () => {
  for (const [status, error] of [[503, 'CSRF'], [403, 'HOST_ORIGIN'], [403, 'FORBIDDEN'], [400, 'CSRF'], [403, undefined]]) {
    let calls = 0;
    const c = client(async () => { calls++; return reply(status, { error, message: 'Same-origin session token required' }); });
    const control = { disabled: false };
    await assert.rejects(c.op('fixture_save', {}, control)); assert.equal(calls, 1); assert.equal(control.disabled, false);
  }
  let calls = 0;
  const c = client(async () => { calls++; throw new Error('network response lost'); });
  await assert.rejects(c.op('fixture_save')); assert.equal(calls, 1);
});

test('operation input is frozen at invocation even while an initial session is being acquired', async () => {
  let release, sent;
  const waiting = new Promise(resolve => { release = resolve; });
  const c = client(async (url, options) => {
    if (url === '/api/session') return waiting;
    sent = JSON.parse(options.body); return reply(200, { saved: true });
  }, null);
  const input = { requestId: 'same-intent', note: 'original submitted text' };
  const saving = c.op('fixture_save', input);
  input.note = 'later local edit';
  release(reply(200, renewed));
  assert.equal((await saving).saved, true);
  assert.deepEqual(sent.input, { requestId: 'same-intent', note: 'original submitted text' });
});

test('repeated CSRF is bounded and unsuccessful or malformed session renewal does not loop', async () => {
  for (const [sessionReply, expectedOperations] of [[reply(200, renewed), 2], [reply(503, renewed), 1], [new Error('session connection lost'), 1], [reply(200, {}), 1], [reply(200, { csrf: '', previewOrigin: session.previewOrigin }), 1], [reply(200, { ...renewed, previewOrigin: 'https://example.com' }), 1]]) {
    let sessions = 0, operations = 0;
    const c = client(async url => {
      if (url === '/api/session') { sessions++; if (sessionReply instanceof Error) throw sessionReply; return sessionReply; }
      operations++; return reply(403, { error: 'CSRF', message: 'fixture guard' });
    });
    const control = { disabled: false };
    await assert.rejects(c.op('fixture_save', {}, control));
    assert.equal(sessions, 1); assert.equal(operations, expectedOperations); assert.equal(control.disabled, false);
  }
});

test('missing session initializes safely and a failed renewal can be tried by a later explicit operation', async () => {
  let sessions = 0, operations = 0;
  const c = client(async url => {
    if (url === '/api/session') { sessions++; return sessions === 1 ? reply(503, {}) : reply(200, renewed); }
    operations++; return reply(200, { saved: true });
  }, null);
  await assert.rejects(c.op('fixture_save')); assert.equal(operations, 0);
  assert.equal((await c.op('fixture_save')).saved, true); assert.equal(sessions, 2); assert.equal(operations, 1);
});

test('existing browser tab survives real same-origin server restart, retaining drafts and saving exactly once', { timeout: 30000 }, async t => {
  const started = Date.now(), pending = new Map();
  let currentPhase = 'fixture directory';
  const phase = name => { currentPhase = name; t.diagnostic(`session recovery +${Date.now() - started}ms: ${name}`); };
  const reportAbort = () => console.error('Session recovery aborted:', JSON.stringify({ phase: currentPhase, elapsedMs: Date.now() - started, pendingPaths: [...pending.values()] }));
  t.signal.addEventListener('abort', reportAbort, { once: true });
  const root = await mkdtemp('/tmp/factory-session-recovery-');
  const options = { dbPath: path.join(root, 'db.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false };
  phase('initialize fixture');
  await initialize(options); const store = openStore(options), service = createService(store, options);
  phase('start initial server');
  let app = await startServer(service, { port: 0, previewPort: 0 });
  phase('launch browser');
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true, timeout: 5000 });
  t.after(async () => {
    phase('cleanup browser.close'); await browser.close();
    phase('cleanup app.close'); await app.close();
    phase('cleanup store.close'); store.close();
    t.signal.removeEventListener('abort', reportAbort);
    phase('cleanup complete');
  });
  phase('create original page');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }), origin = app.url;
  page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(5000);
  page.on('request', request => pending.set(request, new URL(request.url()).pathname));
  page.on('requestfinished', request => pending.delete(request));
  page.on('requestfailed', request => pending.delete(request));
  phase('install local-only route');
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  phase('initial navigation'); await page.goto(origin);
  phase('initial workflow ready'); await page.waitForFunction(() => window.FactoryBatchReady);
  const draft = 'Synthetic held-tab upholstery draft';
  phase('fill original draft');
  await page.getByLabel('Business categories', { exact: true }).fill(draft);
  let sessionReads = 0, rejectedSaves = 0, successfulSaves = 0;
  const saveBodies = [];
  page.on('response', response => {
    if (response.url().endsWith('/api/session')) sessionReads++;
    if (response.url().endsWith('/api/op') && response.request().postDataJSON().operation === 'batch_preset_save') {
      saveBodies.push(response.request().postData());
      if (response.status() === 403) rejectedSaves++;
      if (response.status() === 200) successfulSaves++;
    }
  });
  const ports = { port: Number(new URL(app.url).port), previewPort: Number(new URL(app.previewUrl).port) };
  phase('first restart app.close'); await app.close();
  phase('first restart startServer'); app = await startServer(service, ports);
  // No navigation/reload: the original JS realm and its old token remain alive.
  phase('first save consent');
  await page.getByLabel('I reviewed this scope, permitted public sources and attempt limits.').check();
  phase('first save click');
  await page.getByRole('button', { name: 'Save one-time setup', exact: true }).click();
  phase('first save confirmation');
  await page.getByText('Saved setup. Nothing has started.', { exact: true }).waitFor({ timeout: 2500 });
  phase('first save assertions');
  assert.equal(sessionReads, 1); assert.equal(rejectedSaves, 1); assert.equal(successfulSaves, 1);
  assert.equal(saveBodies[0], saveBodies[1]);
  assert.equal((await service.dispatch('batch_status')).preset.version, 1);
  assert.equal((await service.dispatch('batch_status')).preset.settings.niche, draft);
  assert.equal(store.campaigns().length, 0); assert.equal(store.jobs().length, 0);
  phase('open saved settings'); await page.getByText('Search settings', {exact:true}).click();
  phase('edit saved setup'); await page.getByText('Edit setup & limits', { exact: true }).click();
  phase('fill unsaved draft');
  await page.getByLabel('Business categories', { exact: true }).fill('Unsaved draft after save');
  phase('second restart app.close'); await app.close();
  phase('second restart startServer'); app = await startServer(service, ports);
  phase('refresh click');
  await page.getByRole('button', { name: 'Refresh ↻', exact: true }).click();
  phase('refresh workflow ready');
  await page.waitForFunction(() => window.FactoryBatchReady && !document.querySelector('#refresh').disabled);
  phase('refresh draft assertions');
  assert.equal(await page.getByLabel('Business categories', { exact: true }).inputValue(), 'Unsaved draft after save');
  assert.equal(await page.getByText('Could not read this workflow.', { exact: true }).count(), 0);
  for (const width of [1280, 390]) {
    phase(`viewport ${width}`);
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 844 });
    phase(`screenshot ${width}`);
    await page.screenshot({ path: path.join(root, `held-tab-${width}.png`), fullPage: true });
  }
  // A real committed save with a lost response must NOT be retried implicitly.
  let postCommitAttempts = 0;
  phase('install post-commit response-loss route');
  await page.route('**/api/op', async route => {
    if (route.request().postDataJSON().operation !== 'batch_preset_save') return route.continue();
    postCommitAttempts++;
    phase('post-commit route.fetch');
    const response = await route.fetch({ timeout: 5000 }); assert.equal(response.status(), 200);
    phase('post-commit route.fulfill');
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic response lost after commit' }) });
  });
  phase('post-commit save consent');
  await page.getByLabel('I reviewed this scope, permitted public sources and attempt limits.').check();
  phase('post-commit save click');
  await page.getByRole('button', { name: 'Save one-time setup', exact: true }).click();
  phase('post-commit error confirmation');
  await page.getByText('Synthetic response lost after commit', { exact: true }).waitFor();
  phase('post-commit assertions');
  assert.equal(postCommitAttempts, 1);
  assert.equal((await service.dispatch('batch_status')).preset.version, 2);
  assert.equal(await page.getByRole('button', { name: 'Save one-time setup', exact: true }).isEnabled(), true);
  assert.equal(await page.getByLabel('Business categories', { exact: true }).inputValue(), 'Unsaved draft after save');
  // A new browser still initializes normally against the restarted server.
  phase('create fresh page'); const fresh = await browser.newPage();
  fresh.setDefaultTimeout(5000); fresh.setDefaultNavigationTimeout(5000);
  phase('fresh navigation'); await fresh.goto(origin);
  phase('fresh workflow ready'); await fresh.waitForFunction(() => window.FactoryBatchReady);
  phase('fresh assertions');
  assert.equal(await fresh.getByText('Could not read this workflow.', { exact: true }).count(), 0);
  console.log('Synthetic persistent-tab recovery evidence: ' + root);
});

test('failed bootstrap session can recover using the existing Refresh button without reloading', { timeout: 15000 }, async t => {
  const root = await mkdtemp('/tmp/factory-bootstrap-recovery-');
  const options = { dbPath: path.join(root, 'db.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false };
  await initialize(options); const store = openStore(options), app = await startServer(createService(store, options), { port: 0, previewPort: 0 });
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true });
  t.after(async () => { await browser.close(); await app.close(); store.close(); });
  const page = await browser.newPage(); let reads = 0;
  await page.route('**/*', route => route.request().url().startsWith(app.url + '/') ? route.continue() : route.abort());
  await page.route('**/api/session', route => ++reads === 1 ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue());
  await page.goto(app.url);
  await page.getByText('Local session unavailable', { exact: true }).waitFor();
  assert.equal(reads, 1);
  await page.getByRole('button', { name: 'Refresh ↻', exact: true }).click();
  await page.waitForFunction(() => window.FactoryBatchReady);
  assert.equal(reads, 2);
  assert.equal(await page.getByRole('button', { name: 'Choose your setup', exact: true }).isVisible(), true);
});
