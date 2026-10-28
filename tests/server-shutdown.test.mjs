import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { startServer } from '../src/server.mjs';

const fixture = () => ({ store: { dbPath: '/fixture/unused.sqlite', stateRoot: '/fixture/state' } });
function request(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { agent: false, ...options }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function unusedConnection(origin) {
  const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(origin).port) });
  await once(socket, 'connect');
  return socket;
}
async function finishesWithin(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally { clearTimeout(timer); }
}

for (const listener of ['app', 'preview']) {
  test(`shutdown closes an accepted ${listener} TCP connection with no HTTP request`, { timeout: 5000 }, async () => {
    const app = await startServer(fixture(), { port: 0, previewPort: 0 });
    let socket, closing, completed;
    try {
      const origin = listener === 'app' ? app.url : app.previewUrl;
      socket = await unusedConnection(origin);
      // A completed HTTP request on this listener is an event-loop/accept barrier:
      // the earlier raw connection is accepted but has never sent any bytes.
      const barrier = await request(origin + (listener === 'app' ? '/api/session' : '/health'));
      assert.equal(barrier.status, 200);
      assert.equal(socket.bytesWritten, 0);
      closing = app.close();
      completed = await finishesWithin(closing, 300);
    } finally {
      socket?.destroy();
      await (closing || app.close());
    }
    assert.equal(completed, true, `${listener} pre-request connection must not block shutdown`);
  });
}

test('shutdown drains an admitted operation with HTTP 200 while closing unused and idle connections', { timeout: 5000 }, async () => {
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const admitted = new Promise(resolve => { entered = resolve; });
  const service = fixture();
  service.dispatch = async operation => {
    assert.equal(operation, 'doctor');
    entered();
    await waiting;
    return { fixture: 'drained' };
  };
  const app = await startServer(service, { port: 0, previewPort: 0 });
  const idle = new http.Agent({ keepAlive: true });
  let rawApp, rawPreview, operation, closing;
  try {
    rawApp = await unusedConnection(app.url);
    rawPreview = await unusedConnection(app.previewUrl);
    const session = await request(app.url + '/api/session', { agent: idle });
    assert.equal(session.status, 200);
    const idleSocket = Object.values(idle.freeSockets).flat()[0];
    assert.ok(idleSocket, 'session request leaves a real idle keepalive client socket');
    const idleClosed = once(idleSocket, 'close');
    assert.equal((await request(app.previewUrl + '/health')).status, 200);
    const body = JSON.stringify({ operation: 'doctor', input: {} });
    operation = request(app.url + '/api/op', { method: 'POST', headers: {
      origin: app.url, 'x-factory-csrf': session.data.csrf,
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } }, body);
    await admitted;
    closing = app.close();
    assert.equal(await finishesWithin(closing, 50), false, 'admitted request must drain, not be destroyed');
    release();
    assert.deepEqual(await operation, { status: 200, data: { fixture: 'drained' } });
    assert.equal(await finishesWithin(closing, 300), true, 'unused connections must not hold shutdown after the response drains');
    assert.equal(await finishesWithin(idleClosed, 300), true, 'idle client must observe close after server shutdown');
    assert.equal(idleSocket.destroyed, true);
    assert.equal(Object.values(idle.freeSockets).flat().every(socket => socket.destroyed), true);
  } finally {
    release();
    rawApp?.destroy(); rawPreview?.destroy(); idle.destroy();
    await operation?.catch(() => {});
    await (closing || app.close());
  }
});
