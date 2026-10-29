import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { CAMOFOX_OPERATIONS, camofoxStatus } from '../src/camofox.mjs';

const health = { ok: true, engine: 'camoufox', browserRunning: false, browserConnected: false };
const spec = { openapi: '3.0.0', info: { title: 'camofox-browser', version: '1.14.0' } };
const response = (data, status = 200) => ({ status, bytes: Buffer.from(JSON.stringify(data)) });
const requestFor = (h = health, s = spec) => async url => response(url.endsWith('/health') ? h : s);
function notReady(result) {
  assert.equal(result.guestReady, false);
  assert.equal(result.readerReady, false);
  assert.equal(result.launchTested, false);
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
}

test('Camofox metadata is strict, read-only and disabled by default', async () => {
  const op = CAMOFOX_OPERATIONS.camofox_status;
  assert.equal(op.readOnly, true);
  assert.deepEqual(op.schema.parse({}), { enabled: false });
  for (const input of [{ enabled: 'true' }, { url: 'http://attacker/' }, { enabled: true, token: 'secret' }]) {
    assert.equal(op.schema.safeParse(input).success, false);
  }
  let calls = 0;
  const request = async () => { calls++; throw Error('must not run'); };
  for (const input of [undefined, {}, { enabled: false }]) {
    const result = await camofoxStatus(input, { request });
    assert.equal(result.status, 'disabled');
    assert.equal(result.serviceReachable, false);
    notReady(result);
  }
  assert.equal(calls, 0);
});

test('direct callers cannot inject unknown fields or truthy enable values', async () => {
  let calls = 0;
  for (const input of [{ enabled: 1 }, { enabled: true, url: 'http://attacker/' }, null]) {
    const result = await camofoxStatus(input, { request: async () => { calls++; } });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, 'CAMOFOX_INPUT');
  }
  assert.equal(calls, 0);
});

test('explicit diagnostics use only fixed health/spec GETs and never claim launch or reader proof', async () => {
  const calls = [];
  const result = await camofoxStatus({ enabled: true }, { request: async (url, options) => {
    calls.push({ url, options });
    return response(url.endsWith('/health') ? { ...health, raw: 'PRIVATE_SENTINEL', memory: { rssMb: 118 } } : { ...spec, paths: { '/secrets': 'PRIVATE_SENTINEL' } });
  } });
  assert.equal(result.status, 'available');
  assert.equal(result.serviceReachable, true);
  assert.equal(result.version, '1.14.0');
  assert.equal(result.engine, 'camoufox');
  assert.equal(result.browserRunning, false);
  assert.equal(result.browserConnected, false);
  assert.deepEqual(calls.map(c => c.url), ['http://127.0.0.1:9377/health', 'http://127.0.0.1:9377/openapi.json']);
  for (const { options } of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.maxBytes, 1024 * 1024);
    assert.ok(options.timeout <= 2500);
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
  assert.ok(result.limitations.some(s => /persistence/i.test(s)));
  assert.ok(result.limitations.some(s => /egress/i.test(s)));
  assert.ok(result.limitations.some(s => /speed/i.test(s)));
  notReady(result);
});

test('even a running browser is not a guest-readiness or launch-test assertion', async () => {
  const result = await camofoxStatus({ enabled: true }, { request: requestFor({ ...health, browserRunning: true, browserConnected: true }) });
  assert.equal(result.browserRunning, true);
  assert.equal(result.browserConnected, true);
  notReady(result);
});

test('HTTP errors and redirects stop without following or reflecting remote content', async () => {
  for (const status of [301, 302, 401, 403, 503]) {
    let calls = 0;
    const result = await camofoxStatus({ enabled: true }, { request: async () => { calls++; return response({ error: 'PRIVATE_SENTINEL' }, status); } });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, 'CAMOFOX_HTTP');
    assert.equal(result.serviceReachable, true);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
    notReady(result);
  }
});

test('malformed, oversized and incompatible responses are finite sanitized failures', async () => {
  const fixtures = [
    [{ status: 200, bytes: Buffer.from('{PRIVATE_SENTINEL') }, 'CAMOFOX_MALFORMED'],
    [{ status: 200, bytes: Buffer.alloc(1024 * 1024 + 1) }, 'CAMOFOX_RESPONSE_LIMIT'],
    [response({ ...health, engine: 'PRIVATE_SENTINEL' }), 'CAMOFOX_MALFORMED'],
    [response({ ...health, browserRunning: 'true' }), 'CAMOFOX_MALFORMED'],
    [response({ ...health, ok: false }), 'CAMOFOX_UNHEALTHY'],
    [response(null), 'CAMOFOX_MALFORMED'],
  ];
  for (const [fixture, code] of fixtures) {
    const result = await camofoxStatus({ enabled: true }, { request: async () => fixture });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
  }
  for (const badSpec of [{ info: { version: 'PRIVATE_SENTINEL' } }, { ...spec, info: { ...spec.info, version: '1.2.3?token=PRIVATE_SENTINEL' } }]) {
    const result = await camofoxStatus({ enabled: true }, { request: requestFor(health, badSpec) });
    assert.equal(result.code, 'CAMOFOX_MALFORMED');
    assert.equal(result.version, null);
  }
});

test('unavailable service errors never expose messages, URLs or credentials', async () => {
  const result = await camofoxStatus({ enabled: true }, { request: async () => { throw Object.assign(Error('PRIVATE_SENTINEL'), { code: 'PRIVATE_SENTINEL' }); } });
  assert.equal(result.code, 'CAMOFOX_UNAVAILABLE');
  assert.equal(result.serviceReachable, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
});

test('pre-aborted diagnostics make no request and in-flight cancellation settles ignoring transports', async () => {
  const controller = new AbortController(); controller.abort(Error('PRIVATE_SENTINEL'));
  let calls = 0;
  const result = await camofoxStatus({ enabled: true }, { signal: controller.signal, request: async () => { calls++; } });
  assert.equal(result.code, 'CAMOFOX_CANCELLED');
  assert.equal(calls, 0);
  const active = new AbortController();
  const pending = camofoxStatus({ enabled: true }, { signal: active.signal, request: () => new Promise(() => {}) });
  active.abort(Error('PRIVATE_SENTINEL'));
  assert.equal((await pending).code, 'CAMOFOX_CANCELLED');
});

test('a hung request is bounded even if the injected transport ignores abort', async () => {
  const started = Date.now();
  const result = await camofoxStatus({ enabled: true }, { request: () => new Promise(() => {}) });
  assert.equal(result.code, 'CAMOFOX_TIMEOUT');
  assert.ok(Date.now() - started < 3500);
});

test('health plus spec share a combined deadline below five seconds', async () => {
  const started = Date.now();
  let calls = 0;
  const result = await camofoxStatus({ enabled: true }, { request: async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => setTimeout(() => resolve(response(health)), 2200));
    return new Promise(() => {});
  } });
  assert.equal(calls, 2);
  assert.equal(result.code, 'CAMOFOX_TIMEOUT');
  assert.equal(result.serviceReachable, true);
  assert.ok(Date.now() - started < 5000);
});

test('native HTTP transport reads both bounded JSON responses without a real service', async t => {
  const paths = [];
  t.mock.method(http, 'request', (options, callback) => {
    paths.push(options.path);
    const req = new EventEmitter();
    req.destroy = error => { if (error) queueMicrotask(() => req.emit('error', error)); };
    req.end = () => queueMicrotask(() => {
      const body = response(options.path === '/health' ? health : spec).bytes;
      const res = Readable.from([body.subarray(0, 5), body.subarray(5)]);
      res.statusCode = 200; callback(res);
    });
    return req;
  });
  const result = await camofoxStatus({ enabled: true });
  assert.equal(result.status, 'available');
  assert.equal(result.version, '1.14.0');
  assert.deepEqual(paths, ['/health', '/openapi.json']);
  notReady(result);
});

test('native HTTP transport pins numeric loopback with no auth/cookies and never follows redirects', async t => {
  const calls = [];
  t.mock.method(http, 'request', (options, callback) => {
    calls.push(options);
    const req = new EventEmitter();
    req.destroy = error => { if (error) queueMicrotask(() => req.emit('error', error)); };
    req.end = () => queueMicrotask(() => {
      const res = Readable.from([Buffer.from('PRIVATE_SENTINEL')]); res.statusCode = 302;
      res.headers = { location: 'http://attacker/' }; callback(res);
    });
    return req;
  });
  const result = await camofoxStatus({ enabled: true });
  assert.equal(result.code, 'CAMOFOX_HTTP');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostname, '127.0.0.1');
  assert.equal(calls[0].port, 9377);
  assert.equal(calls[0].path, '/health');
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(calls[0].headers, { accept: 'application/json' });
});

test('native HTTP transport stops a streaming oversized response', async t => {
  t.mock.method(http, 'request', (_options, callback) => {
    const req = new EventEmitter();
    req.destroy = error => { if (error) queueMicrotask(() => req.emit('error', error)); };
    req.end = () => queueMicrotask(() => {
      const res = Readable.from([Buffer.alloc(1024 * 1024), Buffer.alloc(1)]); res.statusCode = 200;
      callback(res);
    });
    return req;
  });
  const result = await camofoxStatus({ enabled: true });
  assert.equal(result.code, 'CAMOFOX_RESPONSE_LIMIT');
});
