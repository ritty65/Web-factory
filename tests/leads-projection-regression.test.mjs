import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { saveBatch, getBatch } from '../src/batch-store.mjs';
import { hash } from '../src/contracts.mjs';
import { batchSettings, intakeFixture } from './helpers-batch.mjs';

test('legacy recorded official-site exclusion stays excluded in the new lead desk without fabricated fresh verification', async t => {
  const root = await mkdtemp('/tmp/factory-leads-legacy-projection-');
  const config = { dbPath: path.join(root, 'db.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false, batchPrerequisites: async () => ({ ready: true }) };
  await initialize(config); const store = openStore(config); t.after(() => store.close());
  const service = createService(store, config);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'legacy-exclusion-preset', settings: batchSettings, acknowledged: true });
  const b = await service.dispatch('batch_start', { presetVersion: 1, requestId: 'legacy-exclusion-start', authorized: true });
  const raw = intakeFixture().candidate;
  raw.websiteCheck = { ...raw.websiteCheck, status: 'official_site_found', url: 'https://example.com/recorded-site' };
  const c = store.saveCandidate(b.campaignId, raw, 'fixture');
  saveBatch(store, { ...getBatch(store, b.id), state: 'complete', phase: 'complete', members: [{ candidateId: c.id, evidenceDigest: hash(c), ready: false, reasons: ['A functioning official site was found; this is not a no-site lead.'], contacts: [] }] });
  const before = store.db.prepare('SELECT total_changes() n').get().n;
  const result = await service.dispatch('lead_list', { batchId: b.id });
  assert.equal(result.items[0].state, 'excluded');
  assert.equal(result.items[0].ready, false);
  assert.equal(result.items[0].canSelect, false);
  assert.match(result.items[0].reasons.join(' '), /recorded|historical/i);
  assert.equal((await service.dispatch('lead_list', { batchId: b.id, state: 'excluded' })).total, 1);
  assert.equal(store.db.prepare('SELECT total_changes() n').get().n, before);
});

test('source capability data does not advertise Firecrawl search as a page/media reader', async t => {
  const root = await mkdtemp('/tmp/factory-leads-capability-');
  const config = { dbPath: path.join(root, 'db.sqlite3'), stateRoot: path.join(root, 'state') };
  await initialize(config); const store = openStore(config); t.after(() => store.close());
  const list = await createService(store, { autoRun: false }).dispatch('lead_list');
  const source = list.sources.find(s => s.id === 'firecrawl');
  assert.ok(source);
  assert.match(source.coverage, /web search/i);
  assert.doesNotMatch(source.coverage, /search and page inspection/i);
});
