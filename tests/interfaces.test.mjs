import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { createService, OPERATIONS } from '../src/service.mjs';
import { startServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runProcess, parseModelJson } from '../src/process.mjs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

async function fixture() {
  const root = await mkdtemp('/tmp/factory-interface-');
  const options = { dbPath: path.join(root, 'library.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false };
  await initialize(options);
  const store = openStore(options);
  return { root, options, store, service: createService(store, options) };
}
const campaign = { name: 'Test pilot', area: 'Houston', niche: 'Bakery', query: 'Houston bakery' };
test('inspection identity is strict read-only, store-independent and preserves every fixture row and authority', async t => {
  assert.equal(OPERATIONS.inspection_identity?.readOnly, true);
  const { root, store, service } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  try {
    const c = store.createCampaign(campaign);
    store.createJob({ campaignId: c.id, kind: 'discovery' });
    const rows = () => store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
    const before = rows(), authority = service.snapshot().authority;
    for (let n = 0; n < 2; n++) {
      const value = await service.dispatch('inspection_identity', {});
      assert.ok(value.startupObserved.production.digest);
      assert.ok(value.currentDisk.qa.digest);
      assert.equal(typeof value.restartRequired, 'boolean'); // Working tree may change concurrently.
    }
    for (const raw of [{ root: '/arbitrary' }, { scope: 'qa' }, { authorized: true }, null, []]) {
      await assert.rejects(service.dispatch('inspection_identity', raw), e => e.code === 'INVALID_INPUT');
    }
    assert.deepEqual(rows(), before);
    assert.deepEqual(service.snapshot().authority, authority);
    const noStore = createService(new Proxy({}, { get() { throw new Error('Inspection must not access the store'); } }));
    assert.ok((await noStore.dispatch('inspection_identity')).startupObserved.qa.digest);
  } finally { store.close(); }
});

test('inspection identity uses existing CLI/MCP catalogs and project Plan retains mutation denials', async t => {
  const { root, options, store } = await fixture(); store.close();
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: '', FACTORY_DB: options.dbPath, FACTORY_STATE: options.stateRoot, FACTORY_AUTORUN: '0' };
  const cli = spawnSync(process.execPath, ['src/cli.mjs', 'inspection_identity', '{}'], { env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(JSON.parse(cli.stdout).startupObserved.production.digest);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/mcp.mjs'], env, stderr: 'pipe' });
  const client = new Client({ name: 'inspection-identity-fixture', version: '1' });
  try {
    await client.connect(transport);
    const tool = (await client.listTools()).tools.find(v => v.name === 'inspection_identity');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.inputSchema.additionalProperties, false);
    const result = await client.callTool({ name: 'inspection_identity', arguments: {} });
    assert.ok(result.structuredContent.currentDisk.production.digest);
    assert.equal(result.structuredContent.limitations.length > 0, true);
    assert.equal((await client.callTool({ name: 'inspection_identity', arguments: { root: '/arbitrary' } })).isError, true);
  } finally { await client.close(); }
  const config = JSON.parse(await readFile(new URL('../opencode.json', import.meta.url), 'utf8'));
  const permissions = config.agents.plan.permissions;
  assert.deepEqual(permissions[0], { action: 'factory_*', resource: '*', effect: 'deny' });
  assert.ok(permissions.some(v => v.action === 'factory_inspection_identity' && v.effect === 'allow'));
  for (const [name, op] of Object.entries(OPERATIONS)) if (!op.readOnly) {
    assert.equal(permissions.some(v => v.action === `factory_${name}` && v.effect === 'allow'), false, name);
  }
});
test('all interfaces share an operation allowlist with no acceptance or deployment mutation', async () => {
  const { service, store } = await fixture();
  assert.ok(OPERATIONS.status.readOnly);
  assert.ok(!OPERATIONS.campaign_create.readOnly);
  await assert.rejects(service.dispatch('accept_site', {}), /operation/i);
  await assert.rejects(service.dispatch('campaign_create', { ...campaign, shell: 'echo injected' }), /Unknown|Unsupported|unexpected/i);
  const c = await service.dispatch('campaign_create', campaign);
  const job = await service.dispatch('discover', { campaignId: c.id });
  assert.equal((await service.dispatch('job_get', { id: job.id })).job.id, job.id);
  assert.equal((await service.dispatch('status', {})).campaigns.length, 1);
  store.close();
});
test('HTTP rejects foreign Host/Origin, unauthenticated writes, unknown and oversized inputs', async t => {
  const { service, store } = await fixture();
  const app = await startServer(service, { port: 0, previewPort: 0 });
  t.after(async () => { await app.close(); store.close(); });
  const url = app.url;
  // Node 24 fetch discards custom Host; use the raw HTTP client to really send it.
  const foreignHostStatus = await new Promise((resolve, reject) => { http.get(url + '/api/status', { headers: { host: 'evil.example' } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject); });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(url + '/api/status', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(url + '/api/op', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const session = await (await fetch(url + '/api/session')).json();
  const headers = { 'content-type': 'application/json', origin: url, 'x-factory-csrf': session.csrf };
  assert.equal((await fetch(url + '/api/op', { method: 'POST', headers, body: JSON.stringify({ operation: 'campaign_create', input: campaign }) })).status, 200);
  assert.equal((await fetch(url + '/api/op', { method: 'POST', headers, body: JSON.stringify({ operation: 'deploy', input: {} }) })).status, 400);
  assert.equal((await fetch(url + '/api/op', { method: 'POST', headers, body: 'x'.repeat(1100000) })).status, 413);
});
test('artifact serving binds ID, size/hash and symlink checks, and isolates generated HTML', async t => {
  const { service, store, options, root } = await fixture();
  const target = path.join(options.stateRoot, 'qa.txt'); await writeFile(target, 'safe');
  const { hash } = await import('../src/contracts.mjs');
  const artifact = store.artifact({ jobId: null, relative: 'qa.txt', sha256: hash('safe'), bytes: 4, kind: 'report', label: 'Safe report' });
  const app = await startServer(service, { port: 0, previewPort: 0 });
  t.after(async () => { await app.close(); store.close(); });
  const result = await fetch(app.url + '/files/' + artifact.id);
  assert.equal(await result.text(), 'safe');
  assert.match(result.headers.get('content-disposition'), /attachment/);
  assert.equal((await fetch(app.url + '/preview/anything/index.html')).status, 404);
  await writeFile(target, 'changed');
  assert.equal((await fetch(app.url + '/files/' + artifact.id)).status, 409);
  const secret = path.join(root, 'outside.txt'); await writeFile(secret, 'outside');
  await symlink(secret, path.join(options.stateRoot, 'linked.txt'));
  const link = store.artifact({ jobId: null, relative: 'linked.txt', sha256: hash('outside'), bytes: 7, kind: 'report', label: 'Link' });
  assert.equal((await fetch(app.url + '/files/' + link.id)).status, 409);
});
test('official MCP client initializes, lists and calls real status and queued operations', async () => {
  const { options, store } = await fixture(); store.close();
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/mcp.mjs'], env: { ...process.env, FACTORY_DB: options.dbPath, FACTORY_STATE: options.stateRoot, FACTORY_AUTORUN: '0' }, stderr: 'pipe' });
  const client = new Client({ name: 'factory-test', version: '1' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.find(x => x.name === 'status').annotations.readOnlyHint);
    assert.equal(tools.find(x => x.name === 'campaign_create').annotations.readOnlyHint, false);
    for (const name of ['review_note', 'revise_site', 'direction_repair', 'polish_site']) assert.equal(tools.find(x => x.name === name).annotations.readOnlyHint, false);
    for (const name of ['case_open','case_update','case_event','cost_record','payment_record','handoff_prepare','research_probe','snapshot_create','snapshot_restore_check']) assert.equal(tools.find(x=>x.name===name).annotations.readOnlyHint,false);
    for (const name of ['sales_status','case_get','pilot_status','snapshot_list','job_history']) assert.equal(tools.find(x=>x.name===name).annotations.readOnlyHint,true);
    for (const name of ['batch_status','batch_get','batch_readiness']) assert.equal(tools.find(x=>x.name===name).annotations.readOnlyHint,true);
    for (const name of ['batch_preset_save','batch_start','batch_continue','batch_stop','batch_item_note']) assert.equal(tools.find(x=>x.name===name).annotations.readOnlyHint,false);
    const batchHome = await client.callTool({ name: 'batch_status', arguments: {} });
    assert.equal(batchHome.structuredContent.preset.adopted, false);
    const { batchSettings } = await import('./helpers-batch.mjs');
    const preset = await client.callTool({ name: 'batch_preset_save', arguments: { version: 0, requestId: 'official-sdk-preset', settings: batchSettings, acknowledged: true } });
    assert.equal(preset.structuredContent.version, 1);
    assert.equal((await client.callTool({ name: 'batch_status', arguments: {} })).structuredContent.preset.adopted, true);
    assert.equal((await client.callTool({ name: 'batch_start', arguments: { presetVersion: 1, requestId: 'no-authorization', authorized: false } })).isError, true);
    const created = await client.callTool({ name: 'campaign_create', arguments: campaign });
    assert.ok(created.structuredContent.id.startsWith('camp-'));
    const status = await client.callTool({ name: 'status', arguments: {} });
    assert.equal(status.structuredContent.campaigns.length, 1);
    const rejected = await client.callTool({ name: 'accept_site', arguments: {} });
    assert.ok(rejected.isError);
  } finally { await client.close(); }
});
test('bounded subprocesses support cancellation without a shell and model JSON must be complete', async () => {
  const controller = new AbortController();
  const running = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, timeout: 3000 });
  controller.abort();
  await assert.rejects(running, /abort|cancel/i);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { maxBytes: 100 }), /output/i);
  assert.deepEqual(parseModelJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => parseModelJson('{"files":['));
});
test('one idempotent recheck can resolve an imported hold without unbounded new research jobs', async () => {
  const { service, store } = await fixture();
  const c = await service.dispatch('campaign_create', campaign);
  const imported = await service.dispatch('candidates_import', { campaignId: c.id, candidates: [{ name: 'Held fixture', area: 'Houston', summary: 'Needs evidence', websiteCheck: { status: 'unknown' } }] });
  const a = await service.dispatch('candidate_recheck', { id: imported.candidates[0].id });
  const b = await service.dispatch('candidate_recheck', { id: imported.candidates[0].id });
  assert.equal(a.id, b.id); assert.equal(a.input.recheckCandidateId, imported.candidates[0].id);
  store.close();
});
test('external OpenCode evidence uses the same safe source queue and cannot rename a candidate or forge acceptance', async () => {
  const { service, store } = await fixture(); const c = await service.dispatch('campaign_create', campaign);
  await assert.rejects(service.dispatch('source_inspect', { campaignId: c.id, url: 'https://127.0.0.1/private' }));
  const source = await service.dispatch('source_inspect', { campaignId: c.id, url: 'https://www.instagram.com/fixture/' });
  assert.equal(source.kind, 'source');
  const imported = await service.dispatch('candidates_import', { campaignId: c.id, candidates: [{ name: 'Held fixture', area: 'Houston', summary: 'Needs evidence' }] });
  const lead = imported.candidates[0];
  await assert.rejects(service.dispatch('candidate_evidence_import', { id: lead.id, evidence: { ...lead, name: 'Different business' } }), /identity/i);
  const result = await service.dispatch('candidate_evidence_import', { id: lead.id, evidence: { ...lead, summary: 'Updated source evidence', states: { humanAcceptance: 'accepted', payment: 'paid' } } });
  assert.equal(result.states.humanAcceptance, 'pending'); assert.equal(result.states.payment, 'not_recorded'); assert.equal(result.origin, 'external_evidence_import'); store.close();
});
test('actual opaque-origin preview loads its own CSS/JS while the operator app stays isolated', async t => {
  const { service, store, options } = await fixture();
  const c=store.createCampaign(campaign), job=store.createJob({campaignId:c.id,kind:'site',input:{candidateId:'lead-fixture'}});
  const relative=`jobs/${job.id}/attempt-0/proposal-0/site`,root=path.join(options.stateRoot,relative);await mkdir(root,{recursive:true});
  await writeFile(path.join(root,'index.html'),'<html lang="en"><head><title>Preview fixture</title><link rel="stylesheet" href="style.css"><script src="app.js" defer></script></head><body><main><h1>Preview fixture</h1></main></body></html>');
  await writeFile(path.join(root,'style.css'),'body{background:rgb(18,52,86)}');
  await writeFile(path.join(root,'app.js'),'document.body.dataset.ready="yes";try{localStorage.getItem("fixture");document.body.dataset.storage="available"}catch{document.body.dataset.storage="blocked"}');
  store.updateJob(job.id,{outputs:{siteRelative:relative}});
  const app=await startServer(service,{port:0,previewPort:0});
  const require=createRequire(import.meta.url);const {chromium}=require('playwright');const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true});
  t.after(async()=>{await browser.close();await app.close();store.close()});
  const page=await browser.newPage();await page.goto(`${app.previewUrl}/site/${job.id}/index.html`);
  await page.waitForFunction(()=>document.body.dataset.ready==='yes',{},{timeout:3000});
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(18, 52, 86)');
  assert.equal(await page.evaluate(()=>window.origin),'null');assert.equal(await page.getAttribute('body','data-storage'),'blocked');
  assert.equal((await fetch(app.url+'/api/status',{headers:{origin:'null','sec-fetch-site':'cross-site','sec-fetch-dest':'script'}})).status,403);
});
test('candidate imports are atomic and stay idempotent at the campaign cap', async () => {
  const {service,store}=await fixture();const c=await service.dispatch('campaign_create',{...campaign,candidateLimit:1});
  const input={name:'Exact fixture',area:'Houston',summary:'Valid supplied evidence'};
  await service.dispatch('candidates_import',{campaignId:c.id,candidates:[input]});
  await service.dispatch('candidates_import',{campaignId:c.id,candidates:[input]});
  assert.equal(store.candidates().length,1);
  const other=await service.dispatch('campaign_create',{...campaign,name:'Atomic import',candidateLimit:2});
  await assert.rejects(service.dispatch('candidates_import',{campaignId:other.id,candidates:[{...input,name:'Valid new'}, {name:'Invalid without summary'}]}));
  assert.equal(store.candidates().filter(x=>x.campaignId===other.id).length,0);store.close();
});
test('source inspection caps apply to full persisted history without rejecting an idempotent repeat', async () => {
  const {service,store}=await fixture();const c=await service.dispatch('campaign_create',campaign);let first;
  for(let n=0;n<24;n++){const job=await service.dispatch('source_inspect',{campaignId:c.id,url:`https://example.com/${n}`});first ||= job;}
  for(let n=0;n<305;n++) store.createJob({kind:'reference',input:{fixture:n}});
  const repeated=await service.dispatch('source_inspect',{campaignId:c.id,url:'https://example.com/0'});assert.equal(repeated.id,first.id);
  await assert.rejects(service.dispatch('source_inspect',{campaignId:c.id,url:'https://example.com/over-cap'}),/cap/i);store.close();
});
test('rendered direction previews stay on the sandbox origin and cannot select arbitrary roots', async t => {
  const { service, store, options } = await fixture(); const c = store.createCampaign(campaign);
  const job = store.createJob({ campaignId: c.id, kind: 'site', input: { candidateId: 'lead-fixture' } });
  const relative = `jobs/${job.id}/attempt-0/directions/study-0/site`; await mkdir(path.join(options.stateRoot, relative), { recursive: true });
  await writeFile(path.join(options.stateRoot, relative, 'index.html'), '<h1>Isolated study</h1>');
  store.updateJob(job.id, { outputs: { studyRoots: [relative] } });
  const app = await startServer(service, { port: 0, previewPort: 0 }); t.after(async () => { await app.close(); store.close(); });
  const result = await fetch(`${app.previewUrl}/study/${job.id}/0/index.html`);
  assert.equal(result.status, 200); assert.match(result.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.equal((await fetch(`${app.url}/study/${job.id}/0/index.html`)).status, 404);
  assert.equal((await fetch(`${app.previewUrl}/study/${job.id}/3/index.html`)).status, 404);
  store.updateJob(job.id, { outputs: { studyRoots: ['backups'] } });
  assert.equal((await fetch(`${app.previewUrl}/study/${job.id}/0/index.html`)).status, 404);
});
