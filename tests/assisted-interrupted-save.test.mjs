import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assistedFixture, assistedStore } from './helpers-assisted.mjs';
import { assistedDispatch } from '../src/assisted.mjs';
import { assistedRoot, readAssistedEvidence } from '../src/assisted-evidence.mjs';
import { hash } from '../src/contracts.mjs';
import { openStore } from '../src/db.mjs';

function interruptCommit(store) {
  store.db.exec("CREATE TEMP TRIGGER interrupt_assisted_save BEFORE INSERT ON factory_operation BEGIN SELECT RAISE(ABORT,'injected_after_bundle_write'); END;");
}
async function staged(t) {
  const store=await assistedStore(t),input=await assistedFixture();
  interruptCommit(store);
  await assert.rejects(assistedDispatch(store,'assisted_save',input),/injected_after_bundle_write/);
  const id=`assisted-${hash(input.requestId).slice(0,24)}`,root=assistedRoot(store,id);
  const manifest=await readFile(path.join(root,'media/social-manifest.json'));
  const bundle=await readFile(path.join(root,'bundle.json'));
  assert.equal(store.db.prepare('SELECT count(*) n FROM factory_operation').get().n,0);
  assert.equal(store.jobs().length,0);assert.equal(store.candidates().length,0);
  const restarted=openStore({dbPath:store.dbPath,stateRoot:store.stateRoot});t.after(()=>restarted.close());
  t.mock.timers.enable({apis:['Date'],now:Date.now()});t.mock.timers.tick(5000);
  return {store:restarted,input,id,root,manifest,bundle};
}
test('identical Save replays after file completion but before DB commit, preserving original preparation timestamps and bytes',async t=>{
  const f=await staged(t),saved=await assistedDispatch(f.store,'assisted_save',f.input);
  assert.equal(saved.assessment.ready,true);
  assert.deepEqual(await readFile(path.join(f.root,'media/social-manifest.json')),f.manifest);
  assert.deepEqual(await readFile(path.join(f.root,'bundle.json')),f.bundle);
  assert.equal(readAssistedEvidence(f.store,saved).media.length,1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM factory_operation').get().n,2);
  assert.equal(f.store.jobs().length,0);assert.equal(f.store.candidates().length,0);
});
test('an interrupted save still rejects changed input under the same request ID',async t=>{
  const f=await staged(t);f.input.bundle.candidate.summary+=' altered';
  await assert.rejects(assistedDispatch(f.store,'assisted_save',f.input),{code:'IDEMPOTENCY_CONFLICT'});
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM factory_operation').get().n,0);
});
test('interrupted staged originals and derivatives cannot be adopted after tampering',async t=>{
  for(const field of ['original_file','web_file']){
    await t.test(field,async t=>{
      const f=await staged(t),media=JSON.parse(f.manifest)[0],file=path.join(f.root,media[field]);
      await writeFile(file,Buffer.from('tampered bytes'));
      await assert.rejects(assistedDispatch(f.store,'assisted_save',f.input));
      assert.equal(f.store.db.prepare('SELECT count(*) n FROM factory_operation').get().n,0);
    });
  }
});
test('a complete media stage can resume when bundle write was not reached',async t=>{
  const f=await staged(t);
  // Test-only fault-state construction, never application recovery deletion.
  await unlink(path.join(f.root,'bundle.json'));
  const saved=await assistedDispatch(f.store,'assisted_save',f.input);
  assert.equal(saved.assessment.ready,true);
  assert.deepEqual(await readFile(path.join(f.root,'media/social-manifest.json')),f.manifest);
});
test('a forged derivative plus a matching asserted manifest hash still cannot be adopted',async t=>{
  const f=await staged(t),manifest=JSON.parse(f.manifest),replacement=Buffer.from('forged derivative');
  await unlink(path.join(f.root,'bundle.json'));
  await writeFile(path.join(f.root,manifest[0].web_file),replacement);
  manifest[0].web_sha256=hash(replacement);manifest[0].bytes=replacement.length;
  await writeFile(path.join(f.root,'media/social-manifest.json'),JSON.stringify(manifest));
  await assert.rejects(assistedDispatch(f.store,'assisted_save',f.input),{code:'ASSISTED_STAGING'});
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM factory_operation').get().n,0);
});
test('partial staging without a completed manifest resumes through original normalization',async t=>{
  const f=await staged(t),original=JSON.parse(f.manifest)[0].original_file,originalBytes=await readFile(path.join(f.root,original));
  await unlink(path.join(f.root,'bundle.json'));await unlink(path.join(f.root,'media/social-manifest.json'));
  const saved=await assistedDispatch(f.store,'assisted_save',f.input);
  assert.equal(saved.assessment.ready,true);
  assert.deepEqual(await readFile(path.join(f.root,original)),originalBytes);
});
test('incomplete or different immutable bundle bytes fail closed rather than being overwritten',async t=>{
  const f=await staged(t),broken=Buffer.from('{"incomplete":');
  await writeFile(path.join(f.root,'bundle.json'),broken);
  await assert.rejects(assistedDispatch(f.store,'assisted_save',f.input),{code:'IDEMPOTENCY_CONFLICT'});
  assert.deepEqual(await readFile(path.join(f.root,'bundle.json')),broken);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM factory_operation').get().n,0);
});
