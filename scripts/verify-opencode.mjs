/** Native V2 smoke against an isolated fixture DB, not the live campaign. */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { initialize, openStore } from '../src/db.mjs';
import { runProcess } from '../src/process.mjs';
import { now } from '../src/contracts.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp('/tmp/factory-native-check-');
const options = { dbPath: path.join(root, 'fixture.sqlite3'), stateRoot: path.join(root, 'state') };
await initialize(options);
const reserve = http.createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
const port = reserve.address().port; await new Promise(r => reserve.close(r));
const url = `http://127.0.0.1:${port}`, password = randomBytes(32).toString('base64url');
const env = { ...process.env, OPENCODE_PASSWORD: password, FACTORY_DB: options.dbPath, FACTORY_STATE: options.stateRoot, FACTORY_AUTORUN: '0' };
const authorization = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
// Do not capture startup output: the native server may print its ephemeral password.
const server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: project, env, detached: true, stdio: 'ignore' });
const result = { at: now(), pass: false, coverage: 'Actual native OpenCode V2 + stdio Factory MCP, isolated fixture database, no live lead or commercial action', sessions: [], permissions: [] };
async function api(method, route, body) {
  const response = await fetch(url + route, { method, headers: { authorization, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const data = await response.json(); if (!response.ok) throw new Error('Owned OpenCode API check failed'); return data;
}
async function run(agent, prompt) {
  const r = await runProcess('opencode', ['run', '--server', url, '--agent', agent, '--format', 'json', prompt], { cwd: project, env, timeout: 120000, maxBytes: 500000 });
  const events = r.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const calls = events.filter(e => e.type === 'tool_use').map(e => ({ tool: e.part?.tool, status: e.part?.state?.status }));
  const sessionId = events.find(e => e.sessionID)?.sessionID;
  result.sessions.push({ agent, sessionId, calls }); return { sessionId, calls };
}
try {
  // Bounded readiness only for this foreground-owned server; not a job poll.
  let ready = false;
  for (let n = 0; n < 80; n++) {
    if (server.exitCode !== null) throw new Error('Owned native server stopped during startup');
    try { await api('GET', '/openapi.json'); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(ready, 'Owned native server readiness');
  const read = await run('plan', 'Read-only Factory integration smoke. Call factory_status exactly once. If the catalog is still starting, use execute with return search({namespace:"factory",limit:30}); then call the offered direct factory_status tool once. Do not use shell, edits, subagents, web research, resources, queues or other tools. Report only returned counts.');
  assert.ok(read.calls.some(c => c.tool === 'factory_status' && c.status === 'completed'), 'Real native Plan status call');
  const pilotRead = await run('plan', 'Read-only Commercial Pilot integration smoke. Call factory_pilot_status exactly once. If needed discover only the Factory catalog through execute/search. Do not mutate, research, use shell, edit or delegate. Report actual readiness blockers, not inferred sales.');
  assert.ok(pilotRead.calls.some(c => c.tool === 'factory_pilot_status' && c.status === 'completed'), 'Real native Plan pilot-readiness call');
  const batchRead = await run('plan', 'Read-only saved-workflow integration smoke. Call factory_batch_status exactly once. If needed discover only the Factory catalog through execute/search. Do not save a preset, start or continue a batch, research, use shell, edit or delegate. Report whether setup is adopted, with no invented provider readiness.');
  assert.ok(batchRead.calls.some(c => c.tool === 'factory_batch_status' && c.status === 'completed'), 'Real native Plan saved-batch status call');
  const checks = [
    ['plan', 'factory_status', '*', 'allow'],
    ['plan', 'factory_campaign_create', '*', 'deny'],
    ['plan', 'factory_build_site', '*', 'deny'],
    ['plan', 'factory_candidate_evidence_import', '*', 'deny'],
    ['plan', 'factory_library_promote', '*', 'deny'],
    ['plan', 'factory_qa_run', '*', 'deny'],
    ['plan', 'factory_review_note', '*', 'deny'],
    ['plan', 'factory_revise_site', '*', 'deny'],
    ['plan', 'factory_direction_repair', '*', 'deny'],
    ['plan', 'factory_polish_site', '*', 'deny'],
    ...['sales_status','case_get','pilot_status','snapshot_list','job_history'].map(name=>['plan',`factory_${name}`,'*','allow']),
    ...['case_open','case_update','case_event','cost_record','payment_record','handoff_prepare','research_probe','snapshot_create','snapshot_restore_check'].map(name=>['plan',`factory_${name}`,'*','deny']),
    ...['batch_status','batch_get','batch_readiness'].map(name=>['plan',`factory_${name}`,'*','allow']),
    ...['batch_preset_save','batch_start','batch_continue','batch_stop','batch_item_note'].map(name=>['plan',`factory_${name}`,'*','deny']),
    ['plan', 'edit', 'README.md', 'deny'],
    ['build', 'read', '.env', 'deny'],
    ['build', 'shell', 'git reset --hard', 'deny'],
  ];
  for (const [agent, action, resource, expected] of checks) {
    const data = await api('POST', `/api/session/${read.sessionId}/permission`, { action, resources: [resource], agent });
    const effect = data.data?.effect; result.permissions.push({ agent, action, resource, expected, effect, pass: effect === expected });
  }
  assert.ok(result.permissions.every(v => v.pass), 'Positive and negative native permission controls');
  const mutation = await run('build', 'Authorized integration smoke: the Factory MCP server in this owned server uses a disposable fixture database with autorun disabled. Call factory_campaign_create exactly once with {"name":"Native MCP fixture","area":"Houston","niche":"Synthetic test only","query":"Fixture only; no network research","candidateLimit":1,"buildLimit":1,"concurrency":1,"autoBuild":false}. Do not call discover/build/research or use shell, edit, subagents or other tools. If startup is still pending, discover only the Factory catalog once. Report the returned campaign ID.');
  assert.ok(mutation.calls.some(c => c.tool === 'factory_campaign_create' && c.status === 'completed'), 'Real native Build mutation in fixture DB');
  const store = openStore(options); assert.equal(store.campaigns().length, 1); assert.equal(store.jobs().length, 0); store.close();
  result.pass = true;
} catch (e) { result.failure = e.message; process.exitCode = 1; }
finally {
  if (server.exitCode === null) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* owned process already gone */ }
    await Promise.race([new Promise(r => server.once('exit', r)), new Promise(r => setTimeout(r, 5000))]);
    if (server.exitCode === null) { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
  const output = '/home/ai_dev/04_DELIVERABLES/simulacra-factory-20261021/verification';
  await mkdir(output, { recursive: true, mode: 0o750 });
  const report = path.join(output, `opencode-native-${result.at.replace(/[:.]/g, '-')}.json`);
  await writeFile(report, JSON.stringify(result, null, 2), { mode: 0o640 });
  console.log(JSON.stringify({ ...result, report }, null, 2));
}
