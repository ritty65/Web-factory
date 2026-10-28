import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { executeJob } from '../src/worker.mjs';
import { batchSettings } from './helpers-batch.mjs';
import { assertBatchSourceWorkflow } from '../src/research.mjs';

const exec = promisify(execFile);

test('saved unrelated discovery receipts cannot satisfy source coverage, including reused stage answers', () => {
  const record = { provider: 'guest_bing', status: 'completed', intent: 'discover', query: 'Houston furniture reupholstery workshops', results: [{ url: 'https://translate.example/', title: 'Translate languages online', description: 'Translation services' }] };
  const before = JSON.stringify(record);
  assert.throws(() => assertBatchSourceWorkflow([record], 'guest_bing'), e => e.code === 'SOURCE_WORKFLOW_INADEQUATE');
  assert.equal(JSON.stringify(record), before, 'old receipts are not rewritten');
  assert.equal(assertBatchSourceWorkflow([{ ...record, results: [{ url: 'https://workshop.example/', title: 'Furniture reupholstery workshop in Houston' }] }], 'guest_bing').length, 1);
});
async function fixture({ record = null, claimedTool = false, batch = true } = {}) {
  const root = await mkdtemp('/tmp/factory-research-coverage-');
  const bin = path.join(root, 'bin'), sources = path.join(root, 'job/sources');
  await mkdir(bin); await mkdir(sources, { recursive: true });
  if (record) await writeFile(path.join(sources, 'search-123abc.json'), JSON.stringify(record));
  const output = { candidates: [], shortfall: 'Synthetic worker reports no qualified candidates; no actual external research.' };
  await writeFile(path.join(bin, 'opencode'), `#!${process.execPath}
(async()=>{
${claimedTool ? `console.log(JSON.stringify({ type: 'tool_use', part: { tool: 'sources_search', state: { status: 'completed' } } }));` : ''}
if(process.env.FACTORY_RESEARCH_REQUEST){const {checkResearchOutput}=await import(${JSON.stringify(new URL('../src/research-check.mjs',import.meta.url).href)});await checkResearchOutput({directory:process.env.FACTORY_SOURCES,requestId:process.env.FACTORY_RESEARCH_REQUEST,candidateLimit:Number(process.env.FACTORY_RESEARCH_LIMIT),output:${JSON.stringify(output)}});}
console.log(JSON.stringify({ type: 'text', sessionID: 'synthetic-research', part: { text: ${JSON.stringify(JSON.stringify(output))} } }));
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
`, { mode: 0o700 });
  const script = `import { discover } from ${JSON.stringify(new URL('../src/research.mjs', import.meta.url).href)};
try {
 const result = await discover({ candidateLimit: 3, area: 'Houston city limits', niche: 'Synthetic only', deadlineMinutes: 2 }, { jobRoot: ${JSON.stringify(path.dirname(sources))}, batch: ${batch ? JSON.stringify({ settings: { searchProvider: 'guest_bing' }, seen: [], checkpoint: false }) : 'null'} });
 console.log(JSON.stringify({ result }));
} catch (e) { console.log(JSON.stringify({ errorCode: e.code, message: e.message })); }
`;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', script], { env: { PATH: bin, HOME: root }, timeout: 20000 });
  return JSON.parse(stdout);
}

test('batch research cannot call an empty no-tool response completed live research', async () => {
  const result = await fixture();
  assert.equal(result.errorCode, 'SOURCE_WORKFLOW_UNUSED');
  assert.equal(result.result, undefined);
});
test('model tool-event claims cannot substitute for persisted source search evidence', async () => {
  const result = await fixture({ claimedTool: true });
  assert.equal(result.errorCode, 'SOURCE_WORKFLOW_UNUSED');
});
test('another provider search record cannot satisfy the frozen-source coverage gate', async () => {
  const result = await fixture({ record: { provider: 'firecrawl', status: 'completed', query: 'Synthetic', results: [{ url: 'https://fixture.example/', title: 'Synthetic' }] } });
  assert.equal(result.errorCode, 'SOURCE_WORKFLOW_UNUSED');
});
test('a real saved selected-reader record permits an honest empty-candidate shortfall', async () => {
  const value = await fixture({ record: { provider: 'guest_bing', status: 'completed', query: 'Synthetic', results: [{ url: 'https://fixture.example/', title: 'Synthetic' }] } });
  assert.equal(value.errorCode, undefined);
  assert.deepEqual(value.result.candidates, []);
  assert.equal(value.result.sourceSearchCount, 1);
  assert.equal(value.result.sourceWorkflowObserved, true);
});
test('saved nonempty but unrelated discovery cannot turn model prose into completed intake', async () => {
  const value = await fixture({ record: { provider: 'guest_bing', status: 'completed', intent: 'discover', query: 'Houston furniture reupholstery workshops', results: [{ url: 'https://translate.example/', title: 'Translation services' }] } });
  assert.equal(value.errorCode, 'SOURCE_WORKFLOW_INADEQUATE');
  assert.equal(value.result, undefined);
});
test('legacy non-batch discovery remains compatible and cannot claim saved-workflow coverage', async () => {
  const value = await fixture({ batch: false });
  assert.deepEqual(value.result.candidates, []);
  assert.equal(value.result.sourceWorkflowObserved, false);
});

test('live discovery with no source evidence is blocked even when its old stage answer is cached', async t => {
  const root = await mkdtemp('/tmp/factory-source-stage-');
  const options = { dbPath: path.join(root, 'test.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false, batchPrerequisites: async () => ({ ready: true }) };
  await initialize(options); const store = openStore(options); t.after(() => store.close());
  const service = createService(store, options);
  await service.dispatch('batch_preset_save', { version: 0, requestId: 'source-stage-scope', settings: batchSettings, acknowledged: true });
  await service.dispatch('batch_start', { presetVersion: 1, requestId: 'source-stage-start', authorized: true });
  const job = store.jobs()[0];
  const result = await executeJob(store, job.id, { discover: async () => ({ candidates: [], live: true, shortfall: 'Synthetic old no-tool result' }) });
  assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'SOURCE_WORKFLOW_UNUSED');
  // Isolated fixture simulates loading a pre-existing checkpoint. This is not a
  // public retry operation and never resets a real batch/job or allowance.
  store.updateJob(job.id, { state: 'queued', ownerPid: null });
  const resumed = await executeJob(store, job.id, { discover: () => { throw new Error('Cached research must not call the adapter again'); } });
  assert.equal(resumed.state, 'blocked'); assert.equal(resumed.errorCode, 'SOURCE_WORKFLOW_UNUSED');
  assert.ok(store.events(job.id).some(e => e.type === 'stage.resumed'));
  assert.equal(store.candidates().length, 0);
  assert.equal(store.jobs().length, 1);
});
