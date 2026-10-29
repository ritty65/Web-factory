import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateInput } from '../src/contracts.mjs';
import { intakeFixture } from './helpers-batch.mjs';

test('batch intake binds factual excerpts, real queries, page purposes, contact routes, activity and image views', async () => {
  const { assessIntake } = await import('../src/intake.mjs');
  const f = intakeFixture(), c = candidateInput(f.candidate), gate = assessIntake(c, f);
  assert.equal(gate.ready, true, gate.reasons.join('\n'));
  assert.equal(gate.contacts[0].sourceUrl, c.contacts.instagram);
  assert.equal(gate.contacts[0].channel, 'instagram');
  assert.equal(gate.humanDecision, null);
});
test('a qualification boolean cannot bypass missing host observations or unrelated search identity', async () => {
  const { assessIntake } = await import('../src/intake.mjs'); const f = intakeFixture(), c = candidateInput(f.candidate);
  assert.equal(assessIntake(c, { observations: [], searches: [], imageViews: [] }).ready, false);
  f.searches[0].results = [{ title: 'Generic tacos', url: 'https://tacos.example/', description: 'Unrelated' }];
  assert.equal(assessIntake(c, f).ready, false);
  f.searches[0].query = 'A query the model never actually used';
  assert.equal(assessIntake(c, f).ready, false);
});
test('fake image IDs, unviewed pixels, guessed permalinks and fabricated contact values hold before production', async () => {
  const { assessIntake } = await import('../src/intake.mjs');
  for (const mutate of [f => { f.candidate.media[0].imageId = 'image-ffffffff'; }, f => { f.imageViews = []; }, f => { f.candidate.media[0].postUrl = 'https://www.instagram.com/p/unobserved/'; }, f => { f.candidate.contacts.email = 'guessed@juniper.example'; f.candidate.contactSources.email = f.candidate.sourceUrls[0]; }]) {
    const f = intakeFixture(); mutate(f); assert.equal(assessIntake(candidateInput(f.candidate), f).ready, false);
  }
});
test('five page purposes require actual fact bindings; changed facts cannot cite an invented excerpt', async () => {
  const { assessIntake } = await import('../src/intake.mjs'); const f = intakeFixture();
  f.candidate.pagePurposes[4].factIds = ['fact-999']; assert.equal(assessIntake(candidateInput(f.candidate), f).ready, false);
  f.candidate.pagePurposes[4].factIds = ['fact-1']; f.candidate.facts[0].excerpt = 'Invented text';
  assert.equal(assessIntake(candidateInput(f.candidate), f).ready, false);
});
test('activity must be bound to a dated first-party observation, not an undated assertion', async () => {
  const { assessIntake } = await import('../src/intake.mjs'); const f = intakeFixture();
  delete f.candidate.activityEvidence; assert.equal(assessIntake(candidateInput(f.candidate), f).ready, false);
  f.candidate.activityEvidence = { sourceId: f.observations[0].id, excerpt: 'Not in the observation', dateText: 'yesterday', date: '2020-01-01' };
  assert.equal(assessIntake(candidateInput(f.candidate), f).ready, false);
});
test('uninspected outbound possible website links and blocked counterevidence remain holds', async () => {
  const { assessIntake } = await import('../src/intake.mjs'); const f = intakeFixture();
  f.observations[0].links.push({ url: 'https://juniper.example/', text: 'Our website' });
  assert.equal(assessIntake(candidateInput(f.candidate), f).ready, false);
  f.candidate.websiteCheck.linkChecks.push({ url: 'https://juniper.example/', sourceId: 'source-ffff', status: 'unofficial', reason: 'Unverified model assertion' });
  assert.equal(assessIntake(candidateInput(f.candidate), f).ready, false);
});
test('discovery queries cannot masquerade as the two exact-business website checks', async () => {
  const { assessIntake } = await import('../src/intake.mjs'); const f = intakeFixture();
  f.searches.forEach(s => { s.intent = 'discover'; });
  assert.equal(assessIntake(candidateInput(f.candidate), f).ready, false);
});

test('a complete but out-of-Houston dossier cannot be admitted by the saved Houston workflow', async () => {
  const { assessIntake } = await import('../src/intake.mjs'); const f = intakeFixture();
  f.candidate.area = 'Austin';
  f.candidate.facts = f.candidate.facts.map(v => ({ ...v, text: v.text.replaceAll('Houston', 'Austin'), excerpt: v.excerpt.replaceAll('Houston', 'Austin') }));
  f.observations.forEach(o => { o.text = o.text.replaceAll('Houston', 'Austin'); });
  assert.equal(assessIntake(candidateInput(f.candidate), f).ready, false);
});
