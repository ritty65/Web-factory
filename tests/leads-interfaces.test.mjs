import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { createService, OPERATIONS } from '../src/service.mjs';
import { runProcess } from '../src/process.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('lead operations are typed, side-effect-free when read, and expose CLI/MCP parity', async t => {
  const root = await mkdtemp('/tmp/factory-lead-interfaces-');
  const options = { dbPath: path.join(root, 'db.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false };
  await initialize(options); const store = openStore(options); t.after(() => store.close());
  assert.equal(OPERATIONS.lead_list?.readOnly, true);
  assert.equal(OPERATIONS.batch_build_selected?.readOnly, false);
  const service = createService(store, options);
  const before = store.db.prepare('SELECT total_changes() n').get().n;
  const list = await service.dispatch('lead_list', {});
  assert.deepEqual(list.items, []);
  assert.equal(list.total, 0);
  assert.equal(store.db.prepare('SELECT total_changes() n').get().n, before);
  const unauthorized = { id: 'batch-invalid', candidateId: 'lead-invalid', evidenceDigest: '0'.repeat(64), requestId: 'missing-authorization' };
  await assert.rejects(service.dispatch('batch_build_selected', unauthorized), error => error.code === 'INVALID_INPUT' && error.details.fields.length === 1 && error.details.fields[0] === 'authorized');
  assert.equal(store.db.prepare('SELECT total_changes() n').get().n, before);
  const env = { ...process.env, FACTORY_DB: options.dbPath, FACTORY_STATE: options.stateRoot, FACTORY_AUTORUN: '0' };
  const cli = await runProcess(process.execPath, ['src/cli.mjs', 'lead_list', '{}'], { env, timeout: 10000 });
  assert.equal(JSON.parse(cli.stdout).total, 0);
  const client = new Client({ name: 'lead-interface-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/mcp.mjs'], env, stderr: 'pipe' });
  try {
    await client.connect(transport); const { tools } = await client.listTools();
    assert.equal(tools.find(x => x.name === 'lead_list')?.annotations.readOnlyHint, true);
    assert.equal(tools.find(x => x.name === 'batch_build_selected')?.annotations.readOnlyHint, false);
    const result = await client.callTool({ name: 'lead_list', arguments: {} });
    assert.equal(result.structuredContent.total, 0);
    const rejected = await client.callTool({ name: 'batch_build_selected', arguments: unauthorized });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content.filter(c => c.type === 'text').map(c => c.text).join(' '), /authorized/);
  } finally { await client.close(); }
  assert.equal(store.campaigns().length, 0); assert.equal(store.jobs().length, 0);
});

test('project Plan permits the new lead read, never the selected-build mutation', async () => {
  const config = JSON.parse(await readFile(new URL('../opencode.json', import.meta.url), 'utf8'));
  const rules = [...config.permissions, ...config.agents.plan.permissions];
  const effect = action => rules.filter(r => r.action === action || r.action === 'factory_*').at(-1)?.effect;
  assert.equal(effect('factory_lead_list'), 'allow');
  assert.equal(effect('factory_batch_build_selected'), 'deny');
});
