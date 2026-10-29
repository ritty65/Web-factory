import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateInput } from '../src/contracts.mjs';
import { assessIntake } from '../src/intake.mjs';
import { assessProspect } from '../src/prospects.mjs';
import { intakeFixture } from './helpers-batch.mjs';
import { observedDate, stablePostUrl } from '../src/evidence-context.mjs';

function fixture() {
  const f = intakeFixture(), o = f.observations[0];
  const date = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const excerpt = `Photo by ${f.candidate.name} on ${date}. A completed chair restoration.`;
  o.evidenceContextVersion = 1; o.images[0].alt = excerpt; o.images[0].postUrl = f.candidate.media[0].postUrl;
  const ref = { kind: 'image_alt', sourceId: o.id, imageId: o.images[0].id, postUrl: o.images[0].postUrl };
  f.candidate.facts.push({ text: 'The inspected account metadata labels a restoration photograph.', sourceUrl: o.url, excerpt, evidenceRef: ref });
  f.candidate.activityEvidence = { sourceId: o.id, excerpt, dateText: date, date, evidenceRef: structuredClone(ref) };
  return f;
}
const gate = f => assessIntake(candidateInput(f.candidate), f);

test('explicit image-alt evidence survives parsing, binds to its actual image/post and counts consistently', () => {
  const f = fixture(), c = candidateInput(f.candidate);
  assert.deepEqual(c.facts[3].evidenceRef, f.candidate.facts[3].evidenceRef);
  assert.deepEqual(c.activityEvidence.evidenceRef, f.candidate.activityEvidence.evidenceRef);
  assert.deepEqual(candidateInput(c), c);
  assert.equal(gate(f).ready, true, gate(f).reasons.join('\n'));
  assert.equal(assessProspect(c, f).factsObserved, 4);
});

for (const [label, mutate] of [
  ['missing explicit reference', f => { delete f.candidate.facts[3].evidenceRef; delete f.candidate.activityEvidence.evidenceRef; }],
  ['forged image ID', f => { f.candidate.facts[3].evidenceRef.imageId = 'image-ffffffff'; }],
  ['forged source ID', f => { f.candidate.facts[3].evidenceRef.sourceId = 'source-forged'; }],
  ['unbound source', f => { f.candidate.inspectionIds = []; }],
  ['blocked source', f => { f.observations[0].blocked = true; }],
  ['stale source', f => { f.observations[0].inspectedAt = '2020-01-01'; }],
  ['unmatched account', f => { f.observations[0].url = 'https://www.instagram.com/somebody_else/'; }],
  ['unobserved image-to-post binding', f => { delete f.observations[0].images[0].postUrl; }],
  ['unobserved post link', f => { f.observations[0].links = []; }],
  ['different post', f => { f.candidate.activityEvidence.evidenceRef.postUrl = 'https://www.instagram.com/p/other/'; }],
  ['profile-as-post', f => { f.observations[0].images[0].postUrl = f.candidate.contacts.instagram; f.candidate.activityEvidence.evidenceRef.postUrl = f.candidate.contacts.instagram; }],
  ['fabricated alt excerpt', f => { f.candidate.facts[3].excerpt = 'Not actually returned by the reader'; }],
  ['legacy observation without context version', f => { delete f.observations[0].evidenceContextVersion; }],
]) test(`typed source evidence holds ${label}`, () => {
  const f = fixture(); mutate(f); assert.equal(gate(f).ready, false);
});

for (const [label, mutate] of [
  ['null', f => { f.candidate.facts[3].evidenceRef = null; }],
  ['unknown kind', f => { f.candidate.facts[3].evidenceRef.kind = 'model_assertion'; }],
  ['extra authority', f => { f.candidate.facts[3].evidenceRef.approved = true; }],
  ['missing image ID', f => { delete f.candidate.facts[3].evidenceRef.imageId; }],
  ['signed post URL', f => { f.candidate.facts[3].evidenceRef.postUrl += '?token=fixture'; }],
  ['conflicting activity source', f => { f.candidate.activityEvidence.sourceId = 'source-other'; }],
]) test(`malformed provided evidence is rejected rather than discarded: ${label}`, () => {
  const f = fixture(); mutate(f);
  assert.throws(() => candidateInput(f.candidate), e => e.code === 'INVALID_EVIDENCE_REF');
});

test('activity requires the date inside the same excerpt, not elsewhere on a page', () => {
  const f = intakeFixture();
  f.candidate.activityEvidence.excerpt = 'Offers fabric selection consultations.';
  assert.equal(gate(f).ready, false);
});
test('activity normalized day must match the literal observed date, not another recent day', () => {
  const f = intakeFixture();
  f.candidate.activityEvidence.date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  assert.equal(gate(f).ready, false);
});
test('new typed evidence does not waive website, page usefulness or pixel-view gates', () => {
  const f = fixture(); f.candidate.websiteCheck.status = 'unknown'; f.candidate.pagePurposes = []; f.imageViews = [];
  const result = gate(f); assert.equal(result.ready, false);
  for (const fragment of ['Website absence', 'Five distinct', 'image-view receipt']) assert.ok(result.reasons.some(r => r.includes(fragment)), fragment);
});

test('absolute observed dates validate the calendar, never locale guesses, relative dates or rollover', () => {
  assert.equal(observedDate('July 06, 2026'), '2026-07-06');
  assert.equal(observedDate('2024-02-29'), '2024-02-29');
  for (const raw of ['February 30, 2026', '2026-02-29', '2026-13-01', '2026-01-32', 'yesterday', '07/06/26', '© 2026', '2026-10-26T12:00:00Z']) assert.equal(observedDate(raw), null, raw);
});
test('post routes never become cross-platform, cross-account, profile, login or signed aliases', () => {
  const profile = 'https://www.instagram.com/juniper1/';
  assert.equal(stablePostUrl('https://www.instagram.com/juniper1/p/abc123/', profile), 'https://www.instagram.com/juniper1/p/abc123/');
  for (const raw of ['https://www.instagram.com/other/p/abc123/', 'https://www.facebook.com/page/posts/123', profile, 'https://www.instagram.com/accounts/login/', 'https://www.instagram.com.evil.example/p/abc/', 'https://www.instagram.com/p/abc/?token=fixture']) assert.equal(stablePostUrl(raw, profile), null, raw);
});

test('a second unrelated supplied social account cannot contribute typed facts, counts or published contacts', () => {
  const f = fixture(), o = structuredClone(f.observations[0]);
  o.id = 'source-'+'e'.repeat(20); o.url = 'https://www.facebook.com/unrelated_account/';
  o.title = 'Another Business'; o.text = 'An unrelated company with a different name. '.repeat(12);
  o.images[0].id = 'image-'+'f'.repeat(20); o.images[0].postUrl = o.url+'posts/123'; o.images[0].alt = 'Photo by Another Business on July 06, 2026.';
  o.links = [{url:o.images[0].postUrl,text:'Post'}]; f.observations.push(o);
  f.candidate.inspectionIds.push(o.id); f.candidate.contacts.facebook = o.url; f.candidate.contactSources.facebook = o.url;
  f.candidate.facts.push({text:'Another account metadata label.',sourceUrl:o.url,excerpt:o.images[0].alt,evidenceRef:{kind:'image_alt',sourceId:o.id,imageId:o.images[0].id,postUrl:o.images[0].postUrl}});
  const c = candidateInput(f.candidate), result = assessIntake(c,f);
  assert.equal(result.ready,false);
  assert.ok(result.reasons.some(r=>r.startsWith('At least three useful facts')));
  assert.equal(assessProspect(c,f).factsObserved,4);
  assert.equal(result.contacts.some(c=>c.channel==='facebook'),false);
});

for (const valid of [true, false]) test(`real service/SQLite selected enrichment ${valid ? 'preserves typed evidence and queues one site' : 'holds missing image-to-post proof without a site'}`, async t => {
  const {mkdtemp, mkdir, writeFile} = await import('node:fs/promises');
  const path = await import('node:path');
  const {initialize, openStore} = await import('../src/db.mjs');
  const {createService} = await import('../src/service.mjs');
  const {executeJob} = await import('../src/worker.mjs');
  const {reconcileBatches} = await import('../src/batches.mjs');
  const {hash} = await import('../src/contracts.mjs');
  const root = await mkdtemp('/tmp/context-worker-');
  const options = {dbPath:path.join(root,'fixture.sqlite3'),stateRoot:path.join(root,'state'),autoRun:false,batchPrerequisites:async()=>({ready:true})};
  await initialize(options); const store = openStore(options); t.after(()=>store.close());
  const service = createService(store,options);
  const settings = {area:'Houston city limits',niche:'Synthetic source-context fixture only',targetCount:1,candidateLimit:1,maxResearchRounds:1,searchProvider:'guest_bing',maxSearches:4,discoverySearchLimit:2,maxInspections:12,maxImageViews:6,maxModelRequests:10,batchMinutes:60,jobMinutes:10,workflow:'leads_first'};
  await service.dispatch('batch_preset_save',{version:0,requestId:'context-preset',settings,acknowledged:true});
  const batch = await service.dispatch('batch_start',{presetVersion:1,requestId:'context-start',authorized:true});
  async function sourceResult(f, ctx) {
    const dir = path.join(ctx.jobRoot,'sources'); await mkdir(dir,{recursive:true});
    for (const o of f.observations) await writeFile(path.join(dir,o.id+'.json'),JSON.stringify(o));
    for (const s of f.searches) await writeFile(path.join(dir,'search-'+hash(s.query).slice(0,16)+'.json'),JSON.stringify(s));
    for (const v of f.imageViews) await writeFile(path.join(dir,'image-view-'+hash(v).slice(0,16)+'.json'),JSON.stringify(v));
    return {candidates:[f.candidate],live:false,shortfall:'Isolated typed-evidence fixture, not live research'};
  }
  const first = await executeJob(store,batch.researchJobIds[0],{discover:(_,ctx)=>sourceResult(intakeFixture(),ctx)});
  assert.equal(first.state,'review_ready',first.message); await reconcileBatches(store);
  const original = store.candidate(first.outputs.candidateIds[0]);
  const selected = await service.dispatch('batch_build_selected',{id:batch.id,candidateId:original.id,evidenceDigest:hash(original),requestId:'context-selection',authorized:true});
  const enriched = fixture(), o = enriched.observations[0];
  o.id = 'source-'+'c'.repeat(20); o.images[0].id = 'image-'+'d'.repeat(20);
  enriched.candidate.inspectionIds = [o.id];
  enriched.candidate.media[0].sourceId = o.id; enriched.candidate.media[0].imageId = o.images[0].id;
  for (const ref of [enriched.candidate.facts[3].evidenceRef,enriched.candidate.activityEvidence.evidenceRef]) {ref.sourceId=o.id;ref.imageId=o.images[0].id;}
  enriched.candidate.activityEvidence.sourceId = o.id;
  enriched.imageViews[0].sourceId = o.id; enriched.imageViews[0].imageId = o.images[0].id;
  if (!valid) delete o.images[0].postUrl;
  const done = await executeJob(store,selected.job.id,{discover:(_,ctx)=>sourceResult(enriched,ctx)});
  assert.equal(done.state,'review_ready',done.message); await reconcileBatches(store);
  const detail = await service.dispatch('batch_get',{id:batch.id});
  assert.equal(detail.batch.members[0].ready,valid);
  assert.equal(store.jobs().filter(j=>j.kind==='site').length,valid?1:0);
  assert.equal(detail.batch.deadlineAt,batch.deadlineAt);
  assert.equal(detail.batch.humanDecision,null);
  assert.deepEqual(store.candidate(original.id).facts[3].evidenceRef,enriched.candidate.facts[3].evidenceRef);
  assert.equal(store.candidate(original.id).previousEvidenceDigests.at(-1),hash(original));
});
