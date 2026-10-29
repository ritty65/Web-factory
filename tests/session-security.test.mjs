import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { startServer } from '../src/server.mjs';

test('restart token rejection is pre-dispatch and renewal leaves origin checks and mutation authority intact', async t => {
  const root = await mkdtemp('/tmp/factory-session-security-');
  const options = { dbPath: path.join(root, 'test.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false };
  await initialize(options); const store = openStore(options), service = createService(store, options);
  let calls = 0;
  const counted = { ...service, dispatch: (...args) => { calls++; return service.dispatch(...args); } };
  let app = await startServer(counted, { port: 0, previewPort: 0 });
  t.after(async () => { await app.close(); store.close(); });
  const url = app.url, port = Number(new URL(url).port), previewPort = Number(new URL(app.previewUrl).port);
  const old = await (await fetch(url + '/api/session')).json();
  await app.close(); app = await startServer(counted, { port, previewPort });
  const payload = JSON.stringify({ operation: 'campaign_create', input: { name: 'Session recovery fixture', area: 'Houston', niche: 'Synthetic only', query: 'No research requested', autoBuild: false } });
  const stale = await fetch(url + '/api/op', { method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-factory-csrf': old.csrf }, body: payload });
  assert.equal(stale.status, 403); assert.equal((await stale.json()).error, 'CSRF');
  assert.equal(calls, 0); assert.equal(store.campaigns().length, 0);
  const freshResponse = await fetch(url + '/api/session');
  assert.equal(freshResponse.headers.get('cache-control'), 'no-store');
  const fresh = await freshResponse.json(); assert.notEqual(fresh.csrf, old.csrf);
  for (const origin of ['https://evil.example', 'null']) {
    const blocked = await fetch(url + '/api/op', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-factory-csrf': fresh.csrf }, body: payload });
    assert.equal(blocked.status, 403); assert.equal((await blocked.json()).error, 'HOST_ORIGIN');
  }
  const missingOrigin = await fetch(url + '/api/op', { method: 'POST', headers: { 'content-type': 'application/json', 'x-factory-csrf': fresh.csrf }, body: payload });
  assert.equal(missingOrigin.status, 403); assert.equal((await missingOrigin.json()).error, 'CSRF');
  assert.equal(calls, 0);
  const success = await fetch(url + '/api/op', { method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-factory-csrf': fresh.csrf }, body: payload });
  assert.equal(success.status, 200); assert.equal(calls, 1);
  assert.equal(store.campaigns().length, 1); assert.equal(store.jobs().length, 0);
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
    const blocked = await fetch(url + '/api/session', { headers });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  }
});
