import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as modelAdapter from '../src/model.mjs';
import { hash } from '../src/contracts.mjs';

const fast = 'openai/gpt-6.1-sol-fast';
const exec = promisify(execFile);

// Only the isolated child sees this PATH; the stub never reads/logs credentials.
async function fixture(t) {
  const root = await mkdtemp('/tmp/factory-model-routing-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), directory = path.join(root, 'cache'), calls = path.join(root, 'calls.jsonl');
  await mkdir(bin); await mkdir(directory);
  await writeFile(path.join(bin, 'opencode'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
console.log(JSON.stringify(args.at(-1) === 'fixture-failure' ? { type: 'error' } : { type: 'text', sessionID: 'fixture-session', part: { text: JSON.stringify({ args, fixture: true }) } }));
`, { mode: 0o700 });
  return {
    root, directory,
    async run(requests) {
      const script = `import { requestModel } from ${JSON.stringify(new URL('../src/model.mjs', import.meta.url).href)};
const results = [];
for (const request of ${JSON.stringify(requests)}) {
  try { results.push(await requestModel({ directory: ${JSON.stringify(directory)}, prompt: 'Synthetic routing fixture only', ...request })); }
  catch (error) { results.push({ errorCode: error.code }); }
}
console.log(JSON.stringify(results));`;
      const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: root, env: { PATH: bin, HOME: root }, timeout: 20000,
      });
      let launches = [];
      try { launches = (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { results: JSON.parse(stdout), launches };
    },
  };
}

test('Factory exports the exact native Fast default and resolves it before cache identity', async () => {
  assert.equal(modelAdapter.DEFAULT_FACTORY_MODEL, fast);
  const request = { role: 'researcher', prompt: 'Synthetic identity fixture' };
  const resolved = await modelAdapter.modelRequestIdentity({ ...request, model: fast });
  for (const model of [undefined, null, '']) {
    assert.equal(await modelAdapter.modelRequestIdentity({ ...request, model }), resolved);
  }
  assert.notEqual(resolved, hash({ ...request, model: 'native-default', inputs: [] }));
  assert.notEqual(resolved, await modelAdapter.modelRequestIdentity({ ...request, model: 'openai/gpt-6.1-sol' }));
});

for (const role of ['researcher', 'proposer']) {
  for (const model of [undefined, fast]) {
    test(`${role} launches the exact Fast route with ${model ? 'explicit' : 'omitted'} model`, async t => {
      const f = await fixture(t), { results: [saved], launches } = await f.run([{ role, model }]);
      assert.equal(launches.length, 1);
      const args = launches[0].args;
      assert.equal(args.filter(arg => arg === '--model').length, 1);
      assert.equal(args[args.indexOf('--model') + 1], fast);
      assert.equal(args[args.indexOf('--agent') + 1], `factory-${role}`);
      assert.ok(args.includes('--standalone'));
      assert.ok(!args.includes('undefined'));
      assert.equal(saved.modelSelection, fast);
      assert.equal(saved.sessionId, 'fixture-session');
      assert.equal(saved.output.fixture, true);
    });
  }
}

test('resolved default shares explicit Fast cache but never reuses legacy-default or other-model output', async t => {
  const f = await fixture(t), request = { role: 'proposer', prompt: 'Synthetic routing fixture only' };
  const legacyId = hash({ ...request, model: 'native-default', inputs: [] });
  await writeFile(path.join(f.directory, `model-${legacyId}.json`), JSON.stringify({ requestId: legacyId, output: { legacy: true } }));
  const other = 'openai/gpt-6.1-sol';
  const { results, launches } = await f.run([request, { ...request, model: fast }, { ...request, model: other }]);
  assert.equal(launches.length, 2, 'Only identical resolved routes reuse a completed cache');
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].modelSelection, fast);
  assert.notEqual(results[0].requestId, legacyId);
  assert.notEqual(results[0].requestId, results[2].requestId);
  assert.equal(results[2].modelSelection, other, 'Existing explicit overrides are not silently rewritten');
  assert.equal(launches[1].args[launches[1].args.indexOf('--model') + 1], other);
});

test('attachment cap remains 16 and rejection does not launch a worker', async t => {
  const f = await fixture(t), files = [];
  for (let i = 0; i < 16; i++) {
    const file = path.join(f.root, `fixture-${i}.png`); await writeFile(file, 'Synthetic attachment bytes'); files.push(file);
  }
  const { results, launches } = await f.run([{ role: 'proposer', files: [...files, files[0]] }, { role: 'proposer', files }]);
  assert.equal(results[0].errorCode, 'MODEL_IMAGE_CAP');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].args.filter(arg => arg === '--file').length, 16);
});

test('native errors do not trigger fallback launches or cache a success', async t => {
  const f = await fixture(t);
  const { results, launches } = await f.run([{ role: 'researcher', prompt: 'fixture-failure' }]);
  assert.deepEqual(results, [{ errorCode: 'MODEL_FAILED' }]);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].args[launches[0].args.indexOf('--model') + 1], fast);
});
