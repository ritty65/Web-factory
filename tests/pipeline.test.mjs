import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { isPublicAddress, safeFetch } from '../src/network.mjs';
import { validateMediaSelection, prepareMedia } from '../src/media.mjs';
import { packageReview, zipBytes } from '../src/package.mjs';
import { executeJob } from '../src/worker.mjs';
import { treeHashes } from '../src/proposal.mjs';
import { hash, now } from '../src/contracts.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
async function fixture() {
  const root = await mkdtemp('/tmp/factory-pipeline-');
  const options = { dbPath: path.join(root, 'library.sqlite3'), stateRoot: path.join(root, 'state') };
  await initialize(options); return { root, store: openStore(options), ...options };
}
test('network rejects all loopback/private/link-local/reserved DNS addresses before fetching', async () => {
  for (const ip of ['127.0.0.1','10.0.0.1','172.16.4.2','192.168.0.4','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','fe80::1','fc00::1','::ffff:127.0.0.1','2001:db8::1','2001:0000::1','2001:0db8:0000:0000:0000:0000:0000:0001']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(safeFetch('https://evil.example/', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }), /public|private|DNS/i);
});
test('media selection rejects wrong business, missing observation, third-party and unsupported sources', () => {
  const candidate = { contacts: { instagram: 'https://www.instagram.com/exact.business/' } };
  const observed = { id: 'source-abc', url: candidate.contacts.instagram, images: [{ id: 'image-abc', mediaUrl: 'https://scontent.cdninstagram.com/public.jpg', width: 1200, height: 1000 }] };
  const selected = { sourceId: observed.id, imageId: 'image-abc', account: candidate.contacts.instagram, postUrl: 'https://www.instagram.com/p/ABC123/', businessPosted: true, alt: 'Cake decorated in blue', role: 'hero', credit: 'Creator not separately identified' };
  assert.equal(validateMediaSelection(candidate, selected, observed).use_status, 'operator_authorized_private_preview');
  assert.throws(() => validateMediaSelection(candidate, { ...selected, account: 'https://www.instagram.com/wrong/' }, observed));
  assert.throws(() => validateMediaSelection(candidate, { ...selected, businessPosted: false }, observed));
  assert.throws(() => validateMediaSelection(candidate, { ...selected, imageId: 'invented' }, observed));
});
test('real image normalization preserves originals and strips metadata without exposing signed URLs', async () => {
  const { root } = await fixture();
  const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#804424' } }).jpeg().withMetadata({ exif: { IFD0: { Artist: 'fixture author' } } }).toBuffer();
  const observation = { id: 'source-media', url: 'https://www.instagram.com/exact.business/', images: [{ id: 'image-media', mediaUrl: 'https://scontent.cdninstagram.com/a.jpg?signature=private', width: 800, height: 600 }] };
  const candidate = { contacts: { instagram: observation.url }, media: [{ sourceId: observation.id, imageId: 'image-media', account: observation.url, postUrl: 'https://www.instagram.com/p/ABC123/', businessPosted: true, alt: 'Fixture photograph', role: 'hero', credit: 'Fixture author' }] };
  const result = await prepareMedia({ candidate, jobRoot: root, observations: [observation], download: async () => ({ bytes, contentType: 'image/jpeg' }) });
  assert.equal(result.length, 1); assert.equal(result[0].original_sha256, hash(bytes));
  assert.equal((await sharp(await readFile(path.join(root, result[0].web_file))).metadata()).exif, undefined);
  assert.equal(JSON.stringify(result).includes('signature'), false);
  assert.equal(result[0].public_release, false);
});
test('ZIP output is deterministic and review packaging rejects stale/missing QA evidence', async () => {
  assert.deepEqual(zipBytes([{ name: 'index.html', bytes: Buffer.from('same') }]), zipBytes([{ name: 'index.html', bytes: Buffer.from('same') }]));
  const { root } = await fixture(); const siteRoot = path.join(root, 'site'); await mkdir(siteRoot); await writeFile(path.join(siteRoot, 'index.html'), '<h1>Example</h1>');
  const hashes = await treeHashes(siteRoot);
  const qa = { pass: true, siteHashes: hashes, checks: [], coverage: 'fixture' };
  const result = await packageReview({ siteRoot, outputRoot: path.join(root, 'package'), candidate: { name: 'Test business', id: 'lead-test' }, media: [], qa, design: { thesis: 'test' } });
  assert.equal(result.reviewStatus, 'operator_review_required');
  assert.equal(result.humanDecision, null);
  await writeFile(path.join(siteRoot, 'index.html'), 'changed');
  await assert.rejects(packageReview({ siteRoot, outputRoot: path.join(root, 'stale'), candidate: { name: 'Test' }, media: [], qa, design: {} }), /stale|digest|changed/i);
});
test('real persisted worker records a blocked source as blocked and preserves cancellation', async () => {
  const { store } = await fixture();
  const c = store.createCampaign({ name: 'Fixture research', query: 'Fixture only', area: 'Houston', niche: 'Bakery' });
  const job = store.createJob({ campaignId: c.id, kind: 'discovery' });
  await executeJob(store, job.id, { discover: async () => { const error = new Error('Public source requires login'); error.code = 'SOURCE_BLOCKED'; throw error; } });
  assert.equal(store.job(job.id).state, 'blocked');
  const cancelled = store.createJob({ campaignId: c.id, kind: 'reference', input: { referenceId: 'titos' } });
  store.cancel(cancelled.id);
  await executeJob(store, cancelled.id, { auditReference: async () => { throw new Error('must not run'); } });
  assert.equal(store.job(cancelled.id).state, 'cancelled'); store.close();
});
test('a cancellation racing a completed adapter cannot be overwritten by review_ready', async () => {
  const { store } = await fixture(); const campaign = store.createCampaign({ name: 'Cancellation fixture', query: 'Fixture', area: 'Houston', niche: 'Fixture' });
  const job = store.createJob({ campaignId: campaign.id, kind: 'discovery' });
  const result = await executeJob(store, job.id, { discover: async () => { store.cancel(job.id); return { candidates: [], live: false }; } });
  assert.equal(result.state, 'cancelled'); assert.equal(store.events(job.id).some(e => e.type === 'job.completed'), false);store.close();
});
test('an expired recovered job cannot start another model or source request', async () => {
  const { store } = await fixture(); const campaign = store.createCampaign({ name: 'Deadline fixture', query: 'Fixture', area: 'Houston', niche: 'Fixture' }); const job = store.createJob({ campaignId: campaign.id, kind: 'discovery' });
  store.updateJob(job.id, { deadlineAt: '2026-01-01T00:00:00Z' }); let called = false;
  const result = await executeJob(store, job.id, { discover: async () => { called = true; return { candidates: [] }; } });
  assert.equal(called, false); assert.equal(result.state, 'blocked');assert.equal(result.errorCode, 'DEADLINE');store.close();
});
test('an explicit retry has a fresh deadline and no stale outputs from the previous attempt', async () => {
  const {store}=await fixture();const c=store.createCampaign({name:'Retry deadline',query:'Fixture',area:'Houston',niche:'Fixture'});
  const job=store.createJob({campaignId:c.id,kind:'discovery'});
  store.updateJob(job.id,{state:'blocked',deadlineAt:'2026-01-01T00:00:00Z',outputs:{candidateIds:['lead-old']},errorCode:'DEADLINE'});
  store.retry(job.id);let called=false;
  const result=await executeJob(store,job.id,{discover:async()=>{called=true;return{candidates:[],live:false}}});
  assert.equal(called,true);assert.equal(result.state,'review_ready');assert.equal(result.errorCode,null);assert.ok(Date.parse(result.deadlineAt)>Date.now());store.close();
});
test('a just-cancelled worker cannot publish output into its newer queued retry', async () => {
  const {store}=await fixture();const c=store.createCampaign({name:'Attempt fencing',query:'Fixture',area:'Houston',niche:'Fixture'});
  const job=store.createJob({campaignId:c.id,kind:'discovery'});
  await executeJob(store,job.id,{discover:async()=>{store.cancel(job.id);store.retry(job.id);return{candidates:[],live:false}}});
  const result=store.job(job.id);assert.equal(result.state,'queued');assert.equal(result.attempt,1);assert.deepEqual(result.outputs,{});assert.equal(store.events(job.id).some(e=>e.type==='job.completed'),false);store.close();
});
test('discovery rejects an over-cap candidate batch atomically before persisting any lead', async () => {
  const {store}=await fixture();const c=store.createCampaign({name:'Strict import',query:'Fixture',area:'Houston',niche:'Fixture',candidateLimit:1});const job=store.createJob({campaignId:c.id,kind:'discovery'});
  const result=await executeJob(store,job.id,{discover:async()=>({candidates:[{name:'First',area:'Houston',summary:'Fixture'},{name:'Second',area:'Houston',summary:'Fixture'}],live:false})});
  assert.equal(result.state,'blocked');assert.equal(store.candidates().length,0);store.close();
});
