import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { salesFixture } from './helpers-commercial.mjs';

test('one startup command reuses only the matching healthy app and isolated preview', async t => {
  const { openFactory } = await import('../src/startup.mjs');
  const { service, store } = await salesFixture(t);
  const first = await openFactory(service, { port: 0, previewPort: 0 }); t.after(() => first.server.close());
  const port = Number(new URL(first.url).port), previewPort = Number(new URL(first.previewUrl).port);
  const second = await openFactory(service, { port, previewPort });
  assert.equal(second.reused, true); assert.equal(second.url, first.url); assert.equal(second.server, null);
  assert.equal(store.jobs().length, 0);
  const health = await (await fetch(first.url + '/api/health')).json();
  assert.equal(health.app, 'simulacra-factory'); assert.equal(health.automaticBatchStart, false);
  assert.equal(JSON.stringify(health).includes(store.dbPath), false);
});
test('startup never takes over an unrelated listener or a matching app using a different database', async t => {
  const { openFactory } = await import('../src/startup.mjs');
  const { service } = await salesFixture(t), other = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ app: 'unrelated' })); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => other.close(resolve)));
  await assert.rejects(openFactory(service, { port: other.address().port, previewPort: 0 }), e => e.code === 'FACTORY_PORT_IN_USE');
  const first = await openFactory(service, { port: 0, previewPort: 0 }); t.after(() => first.server.close());
  const foreign = await salesFixture(t);
  await assert.rejects(openFactory(foreign.service, { port: Number(new URL(first.url).port), previewPort: Number(new URL(first.previewUrl).port) }), e => e.code === 'FACTORY_PORT_IN_USE');
  assert.equal((await fetch(first.url + '/api/health')).status, 200);
});

test('a claimed healthy app cannot hide a missing or foreign isolated preview', async t => {
  const { openFactory, storeIdentity } = await import('../src/startup.mjs');
  const { service, store } = await salesFixture(t);
  const fake = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ app: 'simulacra-factory', workflow: 'one-button-v1', storeIdentity: storeIdentity(store), previewOrigin: 'http://127.0.0.1:1' })); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => fake.close(r)));
  await assert.rejects(openFactory(service, { port: fake.address().port, previewPort: 1 }), e => e.code === 'FACTORY_PREVIEW_UNAVAILABLE');
});
