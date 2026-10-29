import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const launcher = readFileSync(new URL('../bin/factory', import.meta.url), 'utf8');

function fixture(t) {
  const root = mkdtempSync('/tmp/factory-credential-startup-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonical = join(root, 'canonical state');
  const state = join(root, 'explicit state');
  for (const path of [canonical, state]) {
    mkdirSync(join(path, 'credentials'), { recursive: true });
    writeFileSync(join(path, 'credentials/firecrawl.env'), 'FIRECRAWL_API_KEY=synthetic-fixture-only\n', { mode: 0o600 });
  }
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const factory = join(bin, 'factory');
  // Redirect only the launcher's default path: never probe real credentials.
  writeFileSync(factory, launcher.replace('credential_state="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/.factory-state"', `credential_state='${canonical}'`));
  chmodSync(factory, 0o755);
  const node = join(bin, 'node');
  writeFileSync(node, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(node, 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin` };
  const run = (overrides = {}, args = ['doctor', 'argument with spaces', '']) => spawnSync(factory, args, {
    env: { ...env, ...overrides }, encoding: 'utf8',
  });
  const cli = `${bin}/../src/cli.mjs`;
  return { root, canonical, state, run, cli, factory };
}

test('default state loads native env-file and preserves every argument', t => {
  const { canonical, cli, run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), [`--env-file=${canonical}/credentials/firecrawl.env`, cli, 'doctor', 'argument with spaces', '']);
});

test('explicit state with spaces selects its own env-file, even with DB override', t => {
  const { state, cli, run } = fixture(t);
  const result = run({ FACTORY_STATE: state, FACTORY_DB: '/fixture/db.sqlite' });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), [`--env-file=${state}/credentials/firecrawl.env`, cli, 'doctor', 'argument with spaces', '']);
});

test('missing explicit state credentials silently preserve startup', t => {
  const { root, cli, run } = fixture(t);
  const result = run({ FACTORY_STATE: join(root, 'missing') });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), [cli, 'doctor', 'argument with spaces', '']);
});

test('DB-only override never loads default credentials', t => {
  const { cli, run } = fixture(t);
  for (const FACTORY_DB of ['/fixture/db.sqlite', '']) {
    const result = run({ FACTORY_DB });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), [cli, 'doctor', 'argument with spaces', '']);
  }
});

test('explicit empty state never falls back to canonical credentials', t => {
  const { cli, run } = fixture(t);
  const result = run({ FACTORY_STATE: '' });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), [cli, 'doctor', 'argument with spaces', '']);
});

test('symlink env entry is rejected without reading its target', t => {
  const { state, root, run } = fixture(t);
  const file = join(state, 'credentials/firecrawl.env');
  rmSync(file);
  symlinkSync(join(root, 'unread-target'), file);
  const result = run({ FACTORY_STATE: state });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /symlink/);
});

test('native Node env-file retains explicit environment precedence without printing keys', t => {
  const { root, state, factory } = fixture(t);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/cli.mjs'), "process.stdout.write(process.env.FIRECRAWL_API_KEY === 'synthetic-explicit-only' ? 'explicit' : process.env.FIRECRAWL_API_KEY === 'synthetic-fixture-only' ? 'loaded' : 'missing');\n");
  for (const explicit of [false, true]) {
    const result = spawnSync(factory, ['-unused'], {
      // Replace the fake node with real Node, and replace CLI with a boolean-only probe.
      env: { PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/usr/bin:/bin`, FACTORY_STATE: state,
        ...(explicit ? { FIRECRAWL_API_KEY: 'synthetic-explicit-only' } : {}) },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, explicit ? 'explicit' : 'loaded');
  }
});
