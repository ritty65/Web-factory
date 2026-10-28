import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { withResearcherServer } from '../src/researcher-server.mjs';

async function fixture(mode = 'connected') {
  const root = await mkdtemp('/tmp/factory-source-server-test-');
  const bin = path.join(root, 'bin'); await mkdir(bin);
  await writeFile(path.join(bin, 'opencode'), `#!${process.execPath}
const http = require('node:http'), fs = require('node:fs');
const root = process.env.FAKE_ROOT, mode = process.env.FAKE_MODE;
fs.writeFileSync(root + '/pid', String(process.pid));
if (mode === 'exit') process.exit(2);
const args = process.argv.slice(2);
if (args[0] !== 'serve' || args[1] !== '--hostname' || args[2] !== '127.0.0.1' || args[3] !== '--port') process.exit(3);
let requests = 0;
const server = http.createServer((req, res) => {
  const expected = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64');
  if (req.headers.authorization !== expected || req.url !== '/api/mcp') { res.writeHead(401); return res.end('{}'); }
  fs.writeFileSync(root + '/authenticated', 'yes');
  const status = mode === 'failed' ? 'failed' : mode === 'pending' || ++requests < 3 ? 'pending' : 'connected';
  if (status === 'connected') fs.writeFileSync(root + '/connected', 'yes');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({data:[{name:'sources',status:{status}}]}));
});
server.listen(Number(args[4]), '127.0.0.1');
process.on('SIGTERM', () => {
  if (mode === 'stubborn') return;
  server.closeAllConnections(); server.close(() => process.exit(0));
});
`, { mode: 0o700 });
  const env = { ...process.env, PATH: bin, FAKE_ROOT: root, FAKE_MODE: mode,
    FACTORY_SOURCE_JOB: 'job-fixture', FACTORY_DB: path.join(root, 'fixture.sqlite3'),
    FACTORY_STATE: path.join(root, 'state'), FACTORY_SOURCES: path.join(root, 'sources'), OPENCODE_PASSWORD: 'replaced-fixture-value' };
  return { root, env, cwd: root, timeout: 3000 };
}
async function dead(root) {
  const pid = Number(await readFile(path.join(root, 'pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('waits for connected/authenticated MCP, preserves job environment and returns callback value unchanged', async () => {
  const f = await fixture(), expected = { preserved: true };
  const value = await withResearcherServer(f, async ({ url, env, timeout }) => {
    assert.equal(await readFile(path.join(f.root, 'connected'), 'utf8'), 'yes');
    assert.equal(await readFile(path.join(f.root, 'authenticated'), 'utf8'), 'yes');
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(env.OPENCODE_PASSWORD !== f.env.OPENCODE_PASSWORD);
    assert.ok(env.OPENCODE_PASSWORD.length >= 43);
    for (const key of ['FACTORY_SOURCE_JOB', 'FACTORY_DB', 'FACTORY_STATE', 'FACTORY_SOURCES']) assert.equal(env[key], f.env[key]);
    assert.ok(timeout > 0 && timeout < f.timeout);
    return expected;
  });
  assert.equal(value, expected); assert.equal(f.env.OPENCODE_PASSWORD, 'replaced-fixture-value');
  await dead(f.root);
});

for (const mode of ['failed', 'exit', 'pending']) test(`${mode} startup never begins callback and closes owned child`, async () => {
  const f = await fixture(mode); if (mode === 'pending') f.timeout = 350;
  let began = false;
  await assert.rejects(withResearcherServer(f, () => { began = true; }), { code: 'SOURCE_WORKFLOW_UNAVAILABLE' });
  assert.equal(began, false); await dead(f.root);
});

test('spawn error fails closed without callback', async () => {
  const f = await fixture(); f.env.PATH = path.join(f.root, 'missing');
  let began = false;
  await assert.rejects(withResearcherServer(f, () => { began = true; }), { code: 'SOURCE_WORKFLOW_UNAVAILABLE' });
  assert.equal(began, false);
});

test('abort during pending readiness cancels promptly and closes private child', async () => {
  const f = await fixture('pending'), controller = new AbortController();
  let began = false;
  const timer = setTimeout(() => controller.abort(), 250), started = Date.now();
  try {
    await assert.rejects(withResearcherServer({ ...f, signal: controller.signal }, () => { began = true; }));
  } finally { clearTimeout(timer); }
  assert.equal(began, false); assert.ok(Date.now() - started < 1500); await dead(f.root);
});

test('callback rejection is retained and owned server is closed', async () => {
  const f = await fixture(), failure = new Error('fixture callback failure');
  await assert.rejects(withResearcherServer(f, async () => { throw failure; }), e => e === failure);
  await dead(f.root);
});

test('cleanup escalates when owned server ignores SIGTERM, then verifies process exit', async () => {
  const f = await fixture('stubborn');
  await withResearcherServer(f, async () => null);
  await dead(f.root);
});

test('abort after readiness closes the owned server even when callback has not settled', async () => {
  const f = await fixture(), controller = new AbortController();
  await assert.rejects(withResearcherServer({ ...f, signal: controller.signal }, () => {
    controller.abort(); return new Promise(() => {});
  }), { code: 'CANCELLED' });
  await dead(f.root);
});

test('total deadline also bounds an unsettled callback and closes the owned server', async () => {
  const f = await fixture(); f.timeout = 500;
  let began = false;
  await assert.rejects(withResearcherServer(f, () => {
    began = true; return new Promise(() => {});
  }), { code: 'SOURCE_WORKFLOW_UNAVAILABLE' });
  assert.equal(began, true); await dead(f.root);
});

test('a source-server failure aborts the callback signal so its native CLI can also be cleaned up', async () => {
  const f = await fixture(); let callbackSignal, cancelled = false;
  await assert.rejects(withResearcherServer(f, async ({ signal }) => {
    callbackSignal = signal;
    assert.ok(signal instanceof AbortSignal);
    signal.addEventListener('abort', () => { cancelled = true; }, { once: true });
    process.kill(Number(await readFile(path.join(f.root, 'pid'), 'utf8')), 'SIGTERM');
    return new Promise(() => {});
  }), { code: 'SOURCE_WORKFLOW_UNAVAILABLE' });
  assert.equal(callbackSignal.aborted, true); assert.equal(cancelled, true);
  await dead(f.root);
});
