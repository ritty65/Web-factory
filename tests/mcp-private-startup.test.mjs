import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initialize } from '../src/db.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const helperUrl = new URL('../src/private-env.mjs', import.meta.url);
function fixture(t) {
  const root = mkdtempSync('/tmp/factory-mcp-private-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonical = join(root, 'canonical state'), state = join(root, 'explicit state');
  for (const dir of [canonical, state]) {
    mkdirSync(join(dir, 'credentials'), { recursive: true });
    writeFileSync(join(dir, 'credentials/firecrawl.env'), 'FIRECRAWL_API_KEY=synthetic-fixture-only\n', { mode: 0o600 });
  }
  return { root, canonical, state };
}
function runHelper(f, overrides = {}) {
  // Substitute only the private default in a copied helper: never inspect canonical credentials.
  const helper = join(f.root, 'private-env.mjs');
  writeFileSync(helper, readFileSync(helperUrl, 'utf8').replace("fileURLToPath(new URL('../.factory-state', import.meta.url))", JSON.stringify(f.canonical)));
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { loadPrivateEnvironment } from ${JSON.stringify(new URL('file://' + helper).href)};
    try { loadPrivateEnvironment(); console.log(process.env.FIRECRAWL_API_KEY === 'synthetic-explicit-only' ? 'explicit' : process.env.FIRECRAWL_API_KEY === 'synthetic-fixture-only' ? 'loaded' : 'missing'); }
    catch (e) { console.error(e.message); process.exitCode = 1; }
  `], { env: { PATH: '', ...overrides }, encoding: 'utf8' });
}

test('ordinary MCP startup loads synthetic private state without env-file or secret output', async t => {
  const f = fixture(t), dbPath = join(f.root, 'library.sqlite3');
  await initialize({ dbPath, stateRoot: f.state });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/mcp.mjs'],
    env: { PATH: '', FACTORY_DB: dbPath, FACTORY_STATE: f.state, FACTORY_AUTORUN: '0' }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'synthetic-private-startup', version: '1' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'doctor', arguments: {} });
    assert.equal(result.structuredContent.checks.find(check => check.name === 'firecrawl').status, 'configured_not_live_verified');
    assert.doesNotMatch(JSON.stringify(result) + stderr, /synthetic-fixture-only/);
  } finally { await client.close(); }
});

test('private default and explicit state load, preserving existing variables including empty', t => {
  const f = fixture(t);
  for (const overrides of [{}, { FACTORY_STATE: f.state, FACTORY_DB: join(f.root, 'isolated.sqlite3') }]) {
    const result = runHelper(f, overrides);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'loaded');
  }
  assert.equal(runHelper(f, { FIRECRAWL_API_KEY: 'synthetic-explicit-only' }).stdout.trim(), 'explicit');
  assert.equal(runHelper(f, { FIRECRAWL_API_KEY: '' }).stdout.trim(), 'missing');
});

test('DB-only and explicit empty state never fall back to private defaults', t => {
  const f = fixture(t);
  for (const overrides of [{ FACTORY_DB: join(f.root, 'isolated.sqlite3') }, { FACTORY_DB: '' }, { FACTORY_STATE: '' }]) {
    const result = runHelper(f, overrides);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'missing');
  }
});

test('missing optional credentials remain unconfigured', t => {
  const f = fixture(t);
  const result = runHelper(f, { FACTORY_STATE: join(f.root, 'absent') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'missing');
});

test('ordinary MCP rejects unsafe configuration before store creation without path dumps', t => {
  const f = fixture(t), file = join(f.state, 'credentials/firecrawl.env');
  rmSync(file);
  symlinkSync(join(f.canonical, 'credentials/firecrawl.env'), file);
  const result = spawnSync(process.execPath, ['src/mcp.mjs'], {
    env: { PATH: '', FACTORY_STATE: f.state, FACTORY_DB: join(f.root, 'must-not-open.sqlite3'), FACTORY_AUTORUN: '0' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'Factory private environment could not be loaded');
});

for (const kind of ['file symlink', 'parent symlink', 'state symlink', 'directory', 'oversized', 'owner unreadable']) {
  test(`private environment rejects ${kind} with generic errors and no secret output`, t => {
    const f = fixture(t), file = join(f.state, 'credentials/firecrawl.env');
    let state = f.state;
    if (kind === 'file symlink') { rmSync(file); symlinkSync(join(f.canonical, 'credentials/firecrawl.env'), file); }
    if (kind === 'parent symlink') { rmSync(join(f.state, 'credentials'), { recursive: true }); symlinkSync(join(f.canonical, 'credentials'), join(f.state, 'credentials')); }
    if (kind === 'state symlink') { state = join(f.root, 'linked state'); symlinkSync(f.state, state); }
    if (kind === 'directory') { rmSync(file); mkdirSync(file); }
    if (kind === 'oversized') writeFileSync(file, 'x'.repeat(65537));
    if (kind === 'owner unreadable') chmodSync(file, 0o200);
    const result = runHelper(f, { FACTORY_STATE: state });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'Factory private environment could not be loaded');
    assert.doesNotMatch(result.stderr, /synthetic|firecrawl\.env/);
  });
}
