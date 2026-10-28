import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';

test('local batch readiness identifies the explicit Factory model without claiming a live probe or creating work', async t => {
  const root = await mkdtemp('/tmp/factory-launch-readiness-');
  const options = { dbPath: path.join(root, 'test.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false };
  await initialize(options); const store = openStore(options); t.after(() => store.close());
  const service = createService(store, options);
  const before = await service.dispatch('batch_status');
  const result = await service.dispatch('batch_readiness');
  assert.equal(result.model, 'openai/gpt-6.1-sol-fast');
  assert.equal(result.modelStatus, 'explicit_route_not_live_verified');
  assert.equal(result.liveVerified, false);
  const after = await service.dispatch('batch_status');
  assert.deepEqual(after.preset, before.preset); assert.equal(after.total, 0);
  assert.equal(store.jobs().length, 0); assert.equal(store.campaigns().length, 0);
});
