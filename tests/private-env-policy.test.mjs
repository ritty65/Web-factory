import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hash } from '../src/contracts.mjs';
import { policyIdentity } from '../src/policy.mjs';

test('production identity binds the private MCP startup code, never credential contents', async () => {
  const policy = await policyIdentity('production');
  for (const file of ['src/private-env.mjs', 'src/mcp.mjs']) assert.equal(policy.files[file], hash(await readFile(new URL('../' + file, import.meta.url))));
  assert.ok(Object.keys(policy.files).every(file => !file.includes('credentials') && !file.endsWith('.env')));
});
