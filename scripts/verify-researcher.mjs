/** Isolated source-MCP/native catalog check. No model or external research by default. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { workRelative } from '../src/contracts.mjs';
import { runProcess } from '../src/process.mjs';
import { requestModel } from '../src/model.mjs';
import { withJobBudget } from '../src/batch-budget.mjs';
import { readIntakeEvidence } from '../src/intake.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp('/tmp/factory-researcher-check-');
const options = { dbPath: path.join(root, 'fixture.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false,
  batchPrerequisites: async () => ({ ready: true, checks: [], liveVerified: false }) };
await initialize(options);
const store = openStore(options), service = createService(store, options);
const settings = { area: 'Houston city limits', niche: 'Synthetic MCP fixture only', targetCount: 1, candidateLimit: 3,
  maxResearchRounds: 1, searchProvider: 'guest_bing', maxSearches: 6, maxInspections: 24,
  maxImageViews: 8, maxModelRequests: 3, batchMinutes: 60, jobMinutes: 10 };
if(process.argv.includes('--scout'))Object.assign(settings,{workflow:'leads_first',discoverySearchLimit:4,maxSearches:8,maxModelRequests:16});
await service.dispatch('batch_preset_save', { version: 0, requestId: 'source-check-save', settings, acknowledged: true });
await service.dispatch('batch_start', { presetVersion: 1, requestId: 'source-check-start', authorized: true });
const job = store.updateJob(store.jobs()[0].id, { state: 'running' });
const directory = path.join(options.stateRoot, workRelative(job), 'sources');
await mkdir(directory, { recursive: true });
const cwd = path.join(project, 'workers/batch-researcher');
const password = randomBytes(32).toString('base64url');
const env = { ...process.env, PWD: cwd, FACTORY_DB: options.dbPath, FACTORY_STATE: options.stateRoot,
  FACTORY_SOURCE_JOB: job.id, FACTORY_SOURCES: directory, FACTORY_AUTORUN: '0', OPENCODE_PASSWORD: password };
if(process.argv.includes('--scout'))Object.assign(env,{FACTORY_RESEARCH_REQUEST:'a'.repeat(64),FACTORY_RESEARCH_LIMIT:'3'});
const transport = new StdioClientTransport({ command: 'node', args: [path.join(project, 'src/sources-mcp.mjs')], env, stderr: 'ignore' });
const client = new Client({ name: 'factory-source-check', version: '1.0.0' });
const report = { fixture: root, modelCalls: 0, externalResearch: false, pass: false,
  coverage: 'Raw MCP catalog, native connection and permission evaluation; model-visible catalog remains unverified without --smoke' };
let server;
try {
  await client.connect(transport);
  report.rawTools = (await client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(report.rawTools,process.argv.includes('--scout')?['check_research','image','inspect','scout','search']:['image', 'inspect', 'search']);
  await client.close();
  const reserve = http.createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const base = `http://127.0.0.1:${port}`;
  server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd, env, detached: true, stdio: 'ignore' });
  const authorization = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
  async function api(method, route, body) {
    const res = await fetch(base + route, { method, headers: { authorization, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Native API ${route} status ${res.status}`);
    return res.json();
  }
  let spec;
  for (let n = 0; n < 100; n++) {
    try { spec = await api('GET', '/openapi.json'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(spec, 'Owned native server startup');
  await writeFile(path.join(root, 'openapi.json'), JSON.stringify(spec));
  let rows;
  for (let n = 0; n < 60; n++) {
    rows = (await api('GET', '/api/mcp')).data;
    if (rows?.some(r => r.name === 'sources' && r.status?.status !== 'pending')) break;
    await new Promise(r => setTimeout(r, 250));
  }
  report.native = rows?.filter(r => r.name === 'sources').map(r => ({ name: r.name, status: { status: r.status?.status } }));
  const agent = (await api('GET', '/api/agent')).data?.find(a => a.id === 'factory-researcher');
  assert.ok(agent, 'Native factory-researcher agent exists');
  const session = (await api('POST', '/api/session', { agent: 'factory-researcher', title: 'Isolated researcher permissions; no model' })).data;
  report.permissions = [];
  for (const [action, expected] of [['sources_search', 'allow'], ['sources_inspect', 'allow'], ['sources_image', 'allow'],['sources_scout','allow'],['sources_check_research','allow'],
    ['shell', 'deny'], ['read', 'deny'], ['edit', 'deny'], ['websearch', 'deny'], ['factory_batch_start', 'deny']]) {
    const effect = (await api('POST', `/api/session/${session.id}/permission`, { agent: 'factory-researcher', action, resources: ['*'] })).data.effect;
    report.permissions.push({ action, expected, effect });
    assert.equal(effect, expected, action);
  }
  assert.equal(report.native?.[0]?.status?.status, 'connected', 'Native sources connection');
  if (process.argv.includes('--smoke')) {
    report.modelCalls = 1; report.externalResearch = true;
    report.modelSelection = 'openai/gpt-6.1-sol-fast';
    report.launchMode = process.argv.includes('--adapter') ? 'actual-requestModel-batch-adapter' : process.argv.includes('--connected') ? 'connected-owned-server' : 'standalone';
    const prompt = 'Isolated non-prospect tool smoke, not business research. Call sources_search exactly once with query MDN Web Docs and provider guest_bing and intent verify. If direct sources tools are not in your native list, use execute with return search({namespace:"sources",limit:10}); to discover the exact available source tools, then invoke those exact paths through execute. If that search succeeds call sources_inspect once with https://developer.mozilla.org/en-US/docs/Web/HTML . Regardless of search success call sources_image exactly once with sourceId source-deadbeef and imageId image-deadbeef; this intentional unknown-ID host error proves resolution only, not an image view. No shell, no reads or writes, no agents, no other namespaces. Return JSON reporting actual tool availability and failures including discovered exact names. Do not claim an image was viewed.';
    if (process.argv.includes('--adapter')) {
      const result = await withJobBudget(store, job.id, () => requestModel({ role: 'researcher', prompt: prompt + ' Return exactly one complete JSON object, without Markdown.', directory: path.dirname(directory), sourcesDirectory: directory, timeout: 180000 }));
      report.toolEvents = result.toolEvents; report.sessionId = result.sessionId;
      report.modelSelection = result.modelSelection; report.response = result.output;
      const receipts = await readIntakeEvidence(directory);
      report.persistedSearches = receipts.searches.filter(s => s.provider === settings.searchProvider && s.status === 'completed').length;
      report.persistedPageObservations = receipts.observations.length;
      report.actualImageViewReceipts = receipts.imageViews.length;
      const batch = (await service.dispatch('batch_status')).items[0]; report.reservedUsage = batch.usage;
      assert.equal(result.modelSelection, 'openai/gpt-6.1-sol-fast');
      assert.ok(report.persistedSearches >= 1, 'The actual adapter must produce a host-persisted search receipt');
      assert.ok(report.persistedPageObservations >= 2, 'Actual search and conditional MDN page inspection must leave host evidence');
      assert.equal(batch.usage.modelRequests, 1, 'One diagnostic launch, no duplicate reservation');
      assert.equal(batch.usage.searches, 1); assert.equal(batch.usage.inspections, 1); assert.equal(batch.usage.imageViews, 1);
      assert.equal(report.actualImageViewReceipts, 0, 'Unknown image IDs are a host rejection, not observed photo pixels');
    } else {
      const result = await runProcess('opencode', ['run', ...(process.argv.includes('--connected') ? ['--server', base] : ['--standalone']), '--agent', 'factory-researcher', '--model', report.modelSelection, '--format', 'json', prompt], { cwd, env, timeout: 180000, maxBytes: 1000000 });
      const events = result.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      report.toolEvents = events.filter(e => e.type === 'tool_use').map(e => ({ tool: e.part?.tool, status: e.part?.state?.status }));
      report.sessionId = events.find(e => e.sessionID)?.sessionID;
      report.response = events.filter(e => e.type === 'text').map(e => e.part?.text || '').join('\n').slice(0, 12000);
    }
    if (process.argv.includes('--connected') && report.sessionId) {
      const nativeSession = (await api('GET', `/api/session/${report.sessionId}`)).data;
      report.nativeModel = nativeSession.model;
      const messages = (await api('GET', `/api/session/${report.sessionId}/message`)).data;
      report.committedTools = messages.filter(m => m.type === 'assistant').flatMap(m => m.content)
        .filter(c => c.type === 'tool').map(c => ({ tool: c.name, status: c.state.status }));
      for (const name of ['sources_search', 'sources_image']) assert.ok(report.committedTools.some(e => e.tool === name), `Committed native ${name} invocation`);
    }
    for (const name of ['sources_search', 'sources_image']) assert.ok(report.toolEvents.some(e => e.tool === name), `Actual native ${name} invocation`);
    report.coverage = 'Actual native factory-researcher source-tool resolution in isolated fixture; unknown-ID image error is not an image-view receipt';
  }
  report.pass = true;
} catch (e) { report.failure = e.message; process.exitCode = 1; }
finally {
  await client.close().catch(() => {});
  if (server?.exitCode === null) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
    await Promise.race([new Promise(r => server.once('exit', r)), new Promise(r => setTimeout(r, 3000))]);
    if (server.exitCode === null) { try { process.kill(-server.pid, 'SIGKILL'); } catch {} }
  }
  store.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
