import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hash } from '../src/contracts.mjs';

test('QA policy identity includes the shared motion/loading implementation, not just the entry file', async () => {
  const { policyIdentity } = await import('../src/policy.mjs');
  const value = await policyIdentity('qa');
  assert.equal(value.files['src/qa-motion.mjs'], hash(await readFile(new URL('../src/qa-motion.mjs', import.meta.url))));
  assert.equal(value.files['runtime/motion.js'], hash(await readFile(new URL('../runtime/motion.js', import.meta.url))));
  assert.equal(value.digest, hash(value.files));
});
test('interaction contract and checker helpers participate in both host policy identities', async () => {
  const { policyIdentity } = await import('../src/policy.mjs');
  const helpers = new Set();
  for (const entry of ['qa.mjs', 'creative.mjs']) {
    const source = await readFile(new URL('../src/' + entry, import.meta.url), 'utf8');
    for (const match of source.matchAll(/from\s+['"]\.\/([^'"]*interaction[^'"]*\.mjs)['"]/g)) helpers.add('src/' + match[1]);
  }
  for (const scope of ['qa', 'production']) {
    const policy = await policyIdentity(scope);
    for (const name of helpers) assert.equal(policy.files[name], hash(await readFile(new URL('../' + name, import.meta.url))), `${scope} must bind ${name}, not reuse stale interaction evidence`);
  }
});
test('vision cache keys bind actual attachment bytes, so changed pixels cannot reuse a stale critique', async () => {
  const { modelRequestIdentity } = await import('../src/model.mjs');
  const root = await mkdtemp('/tmp/factory-model-key-'), file = path.join(root, 'capture.png');
  await writeFile(file, 'synthetic pixels A');
  const options = { role: 'proposer', prompt: 'Fixture only', model: null, files: [file] };
  const first = await modelRequestIdentity(options); await writeFile(file, 'synthetic pixels B');
  const second = await modelRequestIdentity(options);
  assert.notEqual(first, second); assert.equal(second, await modelRequestIdentity(options));
  await assert.rejects(modelRequestIdentity({ ...options, files: Array(17).fill(file) }), e => e.code === 'MODEL_IMAGE_CAP');
});
test('production policy fingerprints the new host prospect-eligibility module', async () => {
  const { policyIdentity } = await import('../src/policy.mjs');
  const value = await policyIdentity('production');
  assert.equal(value.files['src/prospects.mjs'], hash(await readFile(new URL('../src/prospects.mjs', import.meta.url))));
  assert.equal(value.digest, hash(value.files));
});
test('production seed identity binds receipt guards, source connector and pinned isolated runtime', async () => {
  const { policyIdentity } = await import('../src/policy.mjs');
  const value = await policyIdentity('production');
  for (const name of ['src/seeds.mjs', 'src/seed-source.mjs', 'tools/placeroot-runtime/server.py', 'tools/placeroot-runtime/requirements.lock', 'tools/placeroot-runtime/runtime-manifest.json'])
    assert.equal(value.files[name], hash(await readFile(new URL('../'+name, import.meta.url))), name);
});
test('production policy binds private replay evidence verification before admitting new cohorts',async()=>{
  const {policyIdentity}=await import('../src/policy.mjs');const value=await policyIdentity('production');
  assert.ok(Object.hasOwn(value.files,'src/seed-capture.mjs'));
  assert.equal(value.files['src/seed-capture.mjs'],hash(await readFile(new URL('../src/seed-capture.mjs',import.meta.url))));
});
test('production policy binds the boundary gate and fixed setup helper',async()=>{
  const {policyIdentity}=await import('../src/policy.mjs');const value=await policyIdentity('production');
  for(const name of ['src/boundaries.mjs','src/boundary-source.mjs','tools/placeroot-runtime/boundary.py']){
    assert.ok(Object.hasOwn(value.files,name),name);
    assert.equal(value.files[name],hash(await readFile(new URL('../'+name,import.meta.url))));
  }
});
test('production policy binds typed post/date evidence rules rather than reusing an old qualification identity', async () => {
  const { policyIdentity } = await import('../src/policy.mjs');
  const value = await policyIdentity('production');
  assert.equal(value.files['src/evidence-context.mjs'], hash(await readFile(new URL('../src/evidence-context.mjs', import.meta.url))));
});

async function inspectionFixture(t) {
  const { policyIdentity } = await import('../src/policy.mjs');
  const root = await mkdtemp('/tmp/factory-inspection-policy-');
  t.after(() => rm(root, { recursive: true, force: true }));
  // Only policy/contracts execute. Other inventoried files are inert copied bytes;
  // concurrent edits in the working tree cannot affect assertions after this copy.
  for (const name of Object.keys((await policyIdentity('production')).files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), await readFile(new URL('../' + name, import.meta.url)));
  }
  return { root, url: pathToFileURL(path.join(root, 'src/policy.mjs')).href };
}

test('inspection identity eagerly retains startup observations, detects disk drift and cannot be mutated by callers', async t => {
  const f = await inspectionFixture(t), policy = await import(f.url);
  assert.equal(typeof policy.inspectionIdentity, 'function');
  // Mutate BEFORE the first inspection: a lazy first-call baseline would miss this.
  const original = await policy.policyIdentity('production');
  await writeFile(path.join(f.root, 'src/scout.mjs'), '// synthetic changed scout bytes\n');
  const first = await policy.inspectionIdentity();
  assert.equal(first.startupObserved.production.digest, original.digest);
  assert.equal(first.startupObserved.production.digest, hash(first.startupObserved.production.files));
  assert.notEqual(first.currentDisk.production.digest, original.digest);
  assert.equal(first.currentDisk.production.digest, hash(first.currentDisk.production.files));
  assert.deepEqual(Object.keys(first.currentDisk.production.files), Object.keys(original.files));
  assert.equal(first.startupObserved.qa.digest, first.currentDisk.qa.digest);
  assert.equal(first.restartRequired, true);
  assert.match(first.limitations.join(' '), /not.*loaded.*byte.*attestation/i);
  assert.match(first.limitations.join(' '), /not.*atomic/i);
  first.startupObserved.production.digest = 'caller mutation';
  first.startupObserved.production.files['src/scout.mjs'] = 'caller mutation';
  const repeated = await policy.inspectionIdentity();
  assert.equal(repeated.startupObserved.production.digest, original.digest);
  assert.equal(repeated.startupObserved.production.files['src/scout.mjs'], original.files['src/scout.mjs']);
  await writeFile(path.join(f.root, 'runtime/motion.css'), '/* synthetic QA drift */');
  const qaDrift = await policy.inspectionIdentity();
  assert.notEqual(qaDrift.startupObserved.qa.digest, qaDrift.currentDisk.qa.digest);
  const fresh = spawnSync(process.execPath, ['--input-type=module', '-e', `import { inspectionIdentity } from ${JSON.stringify(f.url)}; console.log(JSON.stringify(await inspectionIdentity()));`], { env: { PATH: '' }, encoding: 'utf8' });
  assert.equal(fresh.status, 0, fresh.stderr);
  const restarted = JSON.parse(fresh.stdout);
  assert.equal(restarted.restartRequired, false);
  assert.equal(restarted.startupObserved.production.digest, qaDrift.currentDisk.production.digest);
  assert.equal(restarted.startupObserved.qa.digest, qaDrift.currentDisk.qa.digest);
});

test('inspection identity fails closed when current fixture policy files disappear', async t => {
  const f = await inspectionFixture(t), policy = await import(f.url);
  assert.equal(typeof policy.inspectionIdentity, 'function');
  await unlink(path.join(f.root, 'src/scout.mjs'));
  await assert.rejects(policy.inspectionIdentity(), e => e.code === 'POLICY_INSPECTION_UNAVAILABLE');
});

test('inspection identity retains an unavailable startup baseline without changing legacy policyIdentity behavior', async t => {
  const f = await inspectionFixture(t);
  const scout = path.join(f.root, 'src/scout.mjs'), bytes = await readFile(scout);
  await unlink(scout);
  const policy = await import(f.url);
  // The missing production-only file must not prevent an unrelated legacy QA read.
  assert.equal((await policy.policyIdentity('qa')).scope, 'qa');
  await assert.rejects(policy.policyIdentity('unknown'), e => e.code === 'POLICY_SCOPE');
  await writeFile(scout, bytes);
  assert.equal((await policy.policyIdentity('production')).scope, 'production');
  // Restoring disk cannot silently invent a baseline after startup already failed.
  await assert.rejects(policy.inspectionIdentity(), e => e.code === 'POLICY_INSPECTION_UNAVAILABLE' && !e.message.includes(f.root));
});
