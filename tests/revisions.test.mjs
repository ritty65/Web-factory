import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { hash, now } from '../src/contracts.mjs';
import { treeHashes } from '../src/proposal.mjs';

async function fixture(t) {
  const root = await mkdtemp('/tmp/factory-revisions-');
  const options = { dbPath: path.join(root, 'db.sqlite3'), stateRoot: path.join(root, 'state') };
  await initialize(options); const store = openStore(options); t.after(() => store.close());
  const campaign = store.createCampaign({ name: 'Revision fixture', area: 'Houston', niche: 'Fixture', query: 'Fixture only', buildLimit: 1 });
  const candidate = store.saveCandidate(campaign.id, { name: 'Fixture', area: 'Houston', summary: 'Synthetic only', identityMatched: true, active: true, sourceUrls: ['https://fixture.example/'], facts: [{ text: 'Fixture makes things', sourceUrl: 'https://fixture.example/' }], websiteCheck: { status: 'no_official_site_found', queries: ['fixture'], checkedAt: now() } });
  const parent = store.createJob({ campaignId: campaign.id, kind: 'site', input: { candidateId: candidate.id } });
  const relative = `jobs/${parent.id}/attempt-0/proposal-0/site`; await mkdir(path.join(store.stateRoot, relative), { recursive: true });
  await writeFile(path.join(store.stateRoot, relative, 'index.html'), '<h1>Synthetic original</h1>');
  const digest = hash(await treeHashes(path.join(store.stateRoot, relative)));
  store.updateJob(parent.id, { state: 'review_ready', outputs: { candidateId: candidate.id, siteRelative: relative, siteDigest: digest, qaPass: true, reviewStatus: 'operator_review_required', humanDecision: null } });
  return { store, service: createService(store, { autoRun: false }), parent: store.job(parent.id), candidate, campaign };
}
test('exact-version feedback is append-only, idempotent, literal and never an acceptance', async t => {
  const { store, service, parent } = await fixture(t);
  const input = { id: parent.id, siteDigest: parent.outputs.siteDigest, note: 'More fun <img src=x onerror=alert(1)>. Not an approval.' };
  const first = await service.dispatch('review_note', input), again = await service.dispatch('review_note', input);
  assert.equal(first.seq, again.seq);
  const notes = store.events(parent.id).filter(e => e.type === 'review.note');
  assert.equal(notes.length, 1); assert.equal(notes[0].detail.note, input.note);
  assert.equal(notes[0].detail.humanDecision, null);
  assert.deepEqual(store.job(parent.id), parent);
  await assert.rejects(service.dispatch('review_note', { ...input, siteDigest: '0'.repeat(64) }), e => e.code === 'STALE_REVIEW');
  await assert.rejects(service.dispatch('review_note', { ...input, humanDecision: 'accept' }), e => e.code === 'INVALID_INPUT');
});
test('revision requests preserve parent, bind exact bytes and remain inside a history-wide cap', async t => {
  const { store, service, parent, candidate, campaign } = await fixture(t);
  const input = { id: parent.id, siteDigest: parent.outputs.siteDigest, feedback: 'Food first; expressive typography and intentional scroll choreography.' };
  const revision = await service.dispatch('revise_site', input);
  assert.equal(revision.id, (await service.dispatch('revise_site', input)).id);
  assert.equal(revision.kind, 'site'); assert.equal(revision.retryLimit, 0);
  assert.equal(revision.input.parentSiteJobId, parent.id); assert.equal(revision.input.candidateId, candidate.id);
  assert.equal(revision.input.parentSiteDigest, parent.outputs.siteDigest);
  assert.deepEqual(store.job(parent.id), parent);
  const second = await service.dispatch('revise_site', { ...input, feedback: 'A second explicit focused request.' });
  store.cancel(second.id);
  // Push older rows outside the ordinary 300-row UI collection; caps use SQL history.
  for (let i = 0; i < 302; i++) store.createJob({ kind: 'vault', input: { fixture: i } });
  await assert.rejects(service.dispatch('revise_site', { ...input, feedback: 'Do not bypass the ceiling using different notes.' }), e => e.code === 'REVISION_CAP');
  assert.throws(() => store.createJob({ campaignId: campaign.id, kind: 'site', input: { candidateId: 'lead-different' } }), e => e.code === 'BUILD_CAP');
  await assert.rejects(service.dispatch('revise_site', { ...input, siteDigest: '0'.repeat(64) }), e => e.code === 'STALE_REVIEW');
  const target = path.join(store.stateRoot, parent.outputs.siteRelative, 'index.html');
  await writeFile(target, (await readFile(target, 'utf8')) + 'tampered');
  await assert.rejects(service.dispatch('revise_site', input), e => e.code === 'STALE_PROPOSAL');
});
test('a revision cannot bind a different candidate, campaign or running/unpackaged parent', async t => {
  const { store, service, parent, campaign } = await fixture(t);
  assert.throws(() => store.createJob({ campaignId: campaign.id, kind: 'site', input: { candidateId: 'lead-other', parentSiteJobId: parent.id, parentSiteDigest: parent.outputs.siteDigest, feedback: 'Not the same business' } }), e => e.code === 'REVISION_BINDING');
  store.updateJob(parent.id, { state: 'running' });
  await assert.rejects(service.dispatch('revise_site', { id: parent.id, siteDigest: parent.outputs.siteDigest, feedback: 'Not yet reviewable' }), e => e.code === 'REVIEW_REQUIRED');
});
test('an explicit held-study reuse preserves generated work and cannot change evidence or feedback', async t => {
  const { store, service, parent, candidate } = await fixture(t);
  const input = { id: parent.id, siteDigest: parent.outputs.siteDigest, feedback: 'Same exact creative request; host checker repair only.' };
  const held = await service.dispatch('revise_site', input);
  store.updateJob(held.id, { state: 'blocked', stage: 'directions-render', errorCode: 'DESIGN_STUDY_QA' });
  const root = path.join(store.stateRoot, 'jobs', held.id, 'attempt-0'); await mkdir(root, { recursive: true });
  const design = { thesis: 'Fixture only', comparisons: ['A', 'B', 'C'] };
  for (const [name, value] of [['qualification', candidate], ['brief', { design, pageMap: [1, 2, 3, 4, 5], motionPlan: [{ purpose: 'Fixture' }] }], ['directions', ['A', 'B', 'C'].map(name => ({ name, design, files: [{ path: 'index.html', content: `<h1>${name}</h1>` }] }))]]) await writeFile(path.join(root, `checkpoint-${name}.json`), JSON.stringify({ value, sha256: hash(value) }));
  const reused = await service.dispatch('revise_site', { ...input, reuseStudyJobId: held.id });
  assert.notEqual(reused.id, held.id); assert.equal(reused.input.reuseStudyJobId, held.id);
  assert.equal(store.job(held.id).state, 'blocked');
  await assert.rejects(service.dispatch('revise_site', { ...input, feedback: 'A different creative request must not reuse an old brief.', reuseStudyJobId: held.id }), e => e.code === 'REUSE_BINDING');
  await writeFile(path.join(root, 'checkpoint-directions.json'), JSON.stringify({ value: [], sha256: '0'.repeat(64) }));
  await assert.rejects(service.dispatch('revise_site', { ...input, reuseStudyJobId: held.id }), e => e.code === 'STALE_STUDIES');
});
