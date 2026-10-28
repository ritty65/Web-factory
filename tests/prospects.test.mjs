import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateInput, now, hash } from '../src/contracts.mjs';
import { assessProspect, prospectItem } from '../src/prospects.mjs';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { intakeFixture } from './helpers-batch.mjs';

test('prospect readiness and positive labels require real host-bound sources, not model booleans', () => {
  const f = intakeFixture(), c = candidateInput(f.candidate);
  assert.equal(assessProspect(c, f).state, 'ready');
  const empty = assessProspect(c);
  assert.equal(empty.state, 'held'); assert.equal(empty.identityObserved, false); assert.equal(empty.websiteStatus, 'unknown');
  delete f.candidate.activityEvidence; delete f.candidate.pagePurposes; delete f.candidate.media;
  const light = assessProspect(candidateInput(f.candidate), f);
  assert.equal(light.state, 'strong'); assert.equal(light.photoEvidence.publicLicence, 'unconfirmed');
  f.candidate.websiteCheck.status = 'unknown';
  assert.equal(assessProspect(candidateInput(f.candidate), f).state, 'held');
});

test('outbound supporting records outside inspectionIds bound positive expiry and read-only downgrade', async t => {
  const root = await mkdtemp('/tmp/prospect-link-expiry-'), options = { dbPath: path.join(root, 'fixture.sqlite'), stateRoot: path.join(root, 'state') };
  await initialize(options); const store = openStore(options); t.after(() => store.close());
  const f = intakeFixture(), url = 'https://directory.example/synthetic', checkedAt = new Date(Date.now() - 6 * 86400000).toISOString();
  f.observations[0].links.push({ url, text: 'Business listing' });
  f.observations.push({ id: 'source-outbound-expiry', url, inspectedAt: checkedAt, blocked: false, text: 'Independent directory, not an official website' });
  f.candidate.websiteCheck.linkChecks.push({ url, sourceId: 'source-outbound-expiry', status: 'unofficial', reason: 'Observed independent directory' });
  assert.equal(f.candidate.inspectionIds.includes('source-outbound-expiry'), false);
  const campaign = store.createCampaign({ name: 'Expiry fixture', area: 'Houston', niche: 'Synthetic', query: 'Fixture only' });
  const c = store.saveCandidate(campaign.id, f.candidate), prospect = assessProspect(c, f);
  assert.equal(prospect.state, 'ready');
  const expected = Date.parse(checkedAt) + 7 * 86400000;
  assert.equal(Date.parse(prospect.evidenceValidUntil), expected);
  const member = { candidateId: c.id, ready: true, evidenceDigest: hash(c), prospect, reasons: [] }, b = { id: 'batch-fixture', campaignId: campaign.id, settings: { niche: 'Synthetic', workflow: 'leads_first' }, state: 'awaiting_selection', deadlineAt: new Date(Date.now() + 3600000).toISOString() };
  const changes = store.db.prepare('SELECT total_changes() n').get().n, originalNow = Date.now;
  try {
    Date.now = () => expected - 1;
    assert.equal(prospectItem(store, b, member).state, 'ready'); assert.equal(prospectItem(store, b, member).ready, true);
    Date.now = () => expected + 1;
    const expired = prospectItem(store, b, member);
    assert.equal(expired.state, 'held'); assert.equal(expired.ready, false); assert.equal(expired.websiteStatus, 'unknown');
    assert.equal(store.db.prepare('SELECT total_changes() n').get().n, changes);
  } finally { Date.now = originalNow; }
  delete f.observations.at(-1).inspectedAt;
  const missing = assessProspect(candidateInput(f.candidate), f);
  assert.equal(missing.state, 'held'); assert.equal(missing.websiteStatus, 'unknown');
});
test('observed bounded booking links need matching inspected findings; spoofed domains cannot qualify', () => {
  const f = intakeFixture(), url = 'https://booksy.com/en-us/synthetic';
  f.observations[0].links.push({ url, text: 'Book' });
  f.observations.push({ id: 'source-booking', url, inspectedAt: now(), blocked: false, text: 'Synthetic booking page' });
  f.candidate.websiteCheck.linkChecks.push({ url, sourceId: 'source-booking', status: 'official', reason: 'Observed booking destination' });
  let p = assessProspect(candidateInput(f.candidate), f);
  assert.equal(p.state, 'booking_only'); assert.equal(p.websiteStatus, 'booking_only'); assert.ok(p.buildUnsupported); assert.deepEqual(p.bookingDestinations, [url]);
  f.observations[1].blocked = true;
  assert.equal(assessProspect(candidateInput(f.candidate), f).bookingDestinations.length, 0);
  f.observations[1].blocked = false;
  f.observations[0].links.at(-1).url = 'https://booksy.com.evil.example/en-us/synthetic';
  p = assessProspect(candidateInput(f.candidate), f); assert.equal(p.bookingDestinations.length, 0);
});

function profileWithQuery(url){
  const f=intakeFixture(),c=f.candidate,o=f.observations[0],channel=url.includes('facebook.com')?'facebook':'instagram';
  c.contacts={[channel]:url};c.contactSources={[channel]:url};c.sourceUrls=[url];
  c.facts=c.facts.map(fact=>({...fact,sourceUrl:url}));c.media=[];c.websiteCheck.status='unknown';
  o.url=url;o.finalUrl=url;o.links=[];o.images=[];
  return assessProspect(candidateInput(c),f);
}
test('the prospect view preserves an observed Instagram locale URL and Facebook numeric profile identity',()=>{
  for(const url of ['https://www.instagram.com/juniper1/?hl=en','https://www.facebook.com/profile.php?id=100000000001001']){
    const p=profileWithQuery(url);
    assert.equal(p.state,'held');assert.equal(p.websiteStatus,'unknown');
    assert.equal(p.sources[0]?.url,url);assert.equal(p.contacts[0]?.value,url);
  }
});
test('query-bearing social links with unrelated or duplicate parameters stay hidden',()=>{
  for(const url of [
    'https://www.instagram.com/juniper1/?hl=en&next=fixture',
    'https://www.instagram.com/juniper1/?hl=en&hl=fr',
    'https://www.instagram.com/juniper1/?hl=unexpectedvalue',
    'https://www.facebook.com/profile.php?id=100000000001001&next=fixture',
  ]){
    const p=profileWithQuery(url);assert.deepEqual(p.sources,[],url);assert.deepEqual(p.contacts,[],url);
  }
});
