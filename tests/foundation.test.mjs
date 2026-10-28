import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initialize, openStore } from '../src/db.mjs';
import { campaignInput, candidateInput, assessEvidence, safeRelative, publicUrl, validateProposal } from '../src/contracts.mjs';
import { stageProposal } from '../src/proposal.mjs';

async function fixture() {
  const root = await mkdtemp('/tmp/factory-test-');
  const dbPath = path.join(root, 'library.sqlite3');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE business (id TEXT PRIMARY KEY,record TEXT NOT NULL,imported_at TEXT,refreshed_at TEXT,site_digest TEXT)');
  db.prepare('INSERT INTO business(id,record) VALUES(?,?)').run('existing', JSON.stringify({ id: 'existing', name: 'Preserve me', states: { owner_acceptance: 'unconfirmed' } }));
  db.close();
  const options = { dbPath, stateRoot: path.join(root, 'state') };
  await initialize(options);
  return { root, options, store: openStore(options) };
}
const campaign = () => ({ name: 'Houston pilot', query: 'Houston home bakery no website', area: 'Houston', niche: 'Bakery', candidateLimit: 10, buildLimit: 1, concurrency: 2, retryLimit: 1, deadlineMinutes: 30 });

test('additive migration preserves curated records and creates a restorable backup', async () => {
  const { options, store } = await fixture();
  const before = store.businesses();
  await initialize(options);
  assert.deepEqual(store.businesses(), before);
  assert.equal(before[0].name, 'Preserve me');
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.ok(store.backups().length >= 1);
  store.close();
});
test('campaign limits are explicit and capped rather than inferred from model output', () => {
  assert.equal(campaignInput(campaign()).buildLimit, 1);
  for (const patch of [{ buildLimit: 0 }, { concurrency: 3 }, { retryLimit: 2 }, { candidateLimit: 1001 }, { deadlineMinutes: 999 }, { name: '' }]) {
    assert.throws(() => campaignInput({ ...campaign(), ...patch }));
  }
});
test('idempotent job creation and exclusive claiming do not duplicate work', async () => {
  const { store } = await fixture();
  const c = store.createCampaign(campaign());
  const a = store.createJob({ campaignId: c.id, kind: 'discovery', input: {} });
  const b = store.createJob({ campaignId: c.id, kind: 'discovery', input: {} });
  assert.equal(a.id, b.id);
  assert.equal(store.claim(a.id).state, 'running');
  assert.throws(() => store.claim(a.id), /claimed|running|queued/i);
  assert.equal(store.events(a.id).filter(e => e.type === 'job.created').length, 1);
  store.close();
});
test('cancel, retry ceiling and abandoned-owner recovery are persisted', async () => {
  const { store } = await fixture();
  const c = store.createCampaign(campaign());
  const job = store.createJob({ campaignId: c.id, kind: 'discovery', input: {} });
  store.claim(job.id);
  store.cancel(job.id);
  assert.equal(store.job(job.id).state, 'cancelled');
  store.retry(job.id);
  store.claim(job.id);
  store.updateJob(job.id, { state: 'failed', message: 'test failure' });
  assert.throws(() => store.retry(job.id), /retry/i);
  const other = store.createJob({ campaignId: c.id, kind: 'reference', input: { referenceId: 'titos' } });
  store.claim(other.id, 2147483000);
  assert.equal(store.recover().length, 1);
  assert.equal(store.job(other.id).state, 'queued');
  store.close();
});
test('website checks that failed or conflict cannot become no-site qualification', () => {
  const base = { name: 'Known business', area: 'Houston', identityMatched: true, active: true, sourceUrls: ['https://www.instagram.com/example/'], facts: [{ text: 'Home-baked cakes', sourceUrl: 'https://www.instagram.com/example/' }], websiteCheck: { status: 'no_official_site_found', queries: ['exact name Houston website'], checkedAt: new Date().toISOString() } };
  assert.equal(assessEvidence(base).state, 'qualified');
  for (const status of ['failed', 'unknown', 'conflict']) assert.equal(assessEvidence({ ...base, websiteCheck: { ...base.websiteCheck, status } }).state, 'blocked');
  assert.equal(assessEvidence({ ...base, websiteCheck: { ...base.websiteCheck, status: 'official_site_found', url: 'https://example.com' } }).state, 'excluded');
  assert.equal(assessEvidence({ ...base, identityMatched: false }).state, 'blocked');
});
test('paths, credential URLs and literal private addresses are rejected', () => {
  for (const value of ['../escape', '/etc/passwd', '.env', 'assets/.private/x', 'a\\b', 'a/../x']) assert.throws(() => safeRelative(value));
  for (const value of ['http://example.com', 'https://127.0.0.1/x', 'https://[::1]/', 'https://user:pass@example.com', 'https://example.com/?access_token=secret', 'https://169.254.169.254/latest/']) assert.throws(() => publicUrl(value));
  assert.equal(publicUrl('https://www.instagram.com/example/').hostname, 'www.instagram.com');
});
test('proposal file boundaries require a complete static site and reject remote runtime assets', () => {
  const files = ['index.html', 'services.html', 'work.html', 'about.html', 'contact.html'].map(name => ({ path: name, content: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test</title></head><body><h1>Test</h1></body></html>' }));
  assert.equal(validateProposal({ files, design: { thesis: 'Specific test direction', comparisons: ['Different composition', 'Different image treatment', 'Different page structure'] } }).files.length, 5);
  assert.throws(() => validateProposal({ files: [...files, { path: '../escape.js', content: 'x' }] }));
  assert.throws(() => validateProposal({ files: [...files, { path: 'x.php', content: 'x' }] }));
  assert.throws(() => validateProposal({ files: [{ ...files[0], content: '<script src="https://evil.example/a.js"></script>' }, ...files.slice(1)] }));
});
test('host proposal staging never follows symlinks or replaces different prior bytes', async () => {
  const { root } = await fixture();
  const site = path.join(root, 'proposal');
  const files = ['index.html', 'services.html', 'work.html', 'about.html', 'contact.html'].map(name => ({ path: name, content: '<!doctype html><html><head><title>Test</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Test</h1></body></html>' }));
  const result = await stageProposal(site, { files, design: { thesis: 'Photo-led studio', comparisons: ['A', 'B', 'C'] } });
  assert.equal(Object.keys(result.hashes).length, 5);
  await assert.rejects(stageProposal(site, { files: files.map(f => ({ ...f, content: f.content + 'changed' })), design: { thesis: 'Changed', comparisons: ['A', 'B', 'C'] } }));
  assert.match(await readFile(path.join(site, 'index.html'), 'utf8'), /<title>Test/);
  const target = path.join(root, 'linked');
  await symlink(site, target);
  await assert.rejects(stageProposal(target, { files }));
});
test('research image descriptions are bounded for alt text without rejecting a valid detailed observation', () => {
  const value = candidateInput({ name: 'Test', area: 'Houston', summary: 'Test evidence', media: [{ sourceId: 'source-abc', imageId: 'image-abc', account: 'https://www.instagram.com/example/', postUrl: 'https://www.instagram.com/p/EXAMPLE/', businessPosted: true, alt: 'Actual image description. '.repeat(20) }] });
  assert.ok(value.media[0].alt.length <= 300);
});
test('unknown future schema is rejected before any migration writes', async () => {
  const root = await mkdtemp('/tmp/factory-schema-'); const dbPath = path.join(root, 'future.sqlite3');
  const db = new DatabaseSync(dbPath); db.exec("CREATE TABLE factory_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO factory_meta VALUES('schema','99')"); db.close();
  await assert.rejects(initialize({ dbPath, stateRoot: path.join(root, 'state') }), /schema/i);
  const check = new DatabaseSync(dbPath); assert.equal(check.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n, 1); check.close();
});
test('the durable scheduler sees old queued work beyond the bounded recent UI list', async () => {
  const {store}=await fixture();const c=store.createCampaign(campaign());let first;
  for(let n=0;n<305;n++){const j=store.createJob({campaignId:c.id,kind:'reference',input:{fixture:n}});first||=j.id;}
  assert.equal(store.jobs().length,300);assert.equal(store.queuedJobs()[0].id,first);store.close();
});
test('a future Factory schema cannot be opened as a supported running service', async () => {
  const {store,options}=await fixture();store.db.prepare("UPDATE factory_meta SET value='99' WHERE key='schema'").run();store.close();
  assert.throws(()=>openStore(options),/schema/i);
});
test('recovery holds an uncheckpointed model flight instead of silently generating twice', async () => {
  const {store}=await fixture();const c=store.createCampaign(campaign());const job=store.createJob({campaignId:c.id,kind:'site',input:{candidateId:'lead-fixture'}});
  store.claim(job.id,2147483000);store.updateJob(job.id,{stage:'proposal'});store.recover();
  assert.equal(store.job(job.id).state,'blocked');assert.equal(store.job(job.id).errorCode,'MODEL_UNCERTAIN');store.close();
});
test('direction-phase recovery cannot mistake the original study checkpoint for a completed new model flight', async () => {
  const { store } = await fixture(); const c = store.createCampaign(campaign());
  const job = store.createJob({ campaignId: c.id, kind: 'site', input: { candidateId: 'lead-fixture' } });
  const original = path.join(store.stateRoot, 'jobs', job.id, 'attempt-0'); await mkdir(original, { recursive: true });
  await writeFile(path.join(original, 'checkpoint-directions.json'), '{}');
  store.claim(job.id, 2147483000); store.updateJob(job.id, { stage: 'directions', directionRepair: { selectionDigest: 'a'.repeat(64) } });
  store.recover();
  assert.equal(store.job(job.id).state, 'blocked'); assert.equal(store.job(job.id).errorCode, 'MODEL_UNCERTAIN'); store.close();
});
