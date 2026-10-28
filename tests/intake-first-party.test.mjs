import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateInput } from '../src/contracts.mjs';
import { assessIntake } from '../src/intake.mjs';
import { intakeFixture } from './helpers-batch.mjs';

const facebook = 'https://www.facebook.com/juniperworkshop/';
const about = `${facebook}about`;
function fixture() {
  const f = intakeFixture(), c = f.candidate, profile = f.observations[0];
  const fb = { ...structuredClone(profile), id: 'source-facebook', url: facebook, links: [{ url: about }] };
  const page = { ...structuredClone(profile), id: 'source-about', url: about,
    text: `${profile.text} Fixture phone 2025550199 and fixture@juniper.example.`,
    links: [{ url: facebook }, { url: `https://l.facebook.com/l.php?u=${encodeURIComponent(c.contacts.instagram)}` }] };
  fb.text = `${c.name}. ${'Synthetic workshop identity evidence. '.repeat(10)}`;
  c.contacts = { ...c.contacts, facebook, phone: '2025550199', email: 'fixture@juniper.example' };
  c.contactSources = Object.fromEntries(Object.keys(c.contacts).map(k => [k, about]));
  c.facts.forEach(v => { v.sourceUrl = about; });
  c.sourceUrls.push(facebook, about); c.inspectionIds.push(fb.id, page.id);
  f.observations.push(fb, page);
  return f;
}
const gate = f => assessIntake(candidateInput(f.candidate), f);
const contactSupported = (f, channel) => gate(f).contacts.some(v => v.channel === channel);
const localitySupported = f => !gate(f).reasons.some(v => v.startsWith('Houston location'));

test('observed-linked same-account About supports locality and all published contacts', () => {
  const f = fixture(), result = gate(f);
  assert.equal(result.ready, true, result.reasons.join('\n'));
  assert.deepEqual(result.contacts.map(v => v.channel).sort(), ['email', 'facebook', 'instagram', 'phone']);
});

for (const [label, mutate] of [
  ['wrong account', f => { f.observations[2].url = 'https://www.facebook.com/other/about'; f.candidate.contactSources.phone = f.observations[2].url; }],
  ['unobserved About', f => { f.observations[1].links = []; }],
  ['unbound profile', f => { f.candidate.inspectionIds = f.candidate.inspectionIds.filter(v => v !== 'source-facebook'); }],
  ['blocked profile', f => { f.observations[1].blocked = true; }],
  ['stale profile', f => { f.observations[1].inspectedAt = '2020-01-01'; }],
  ['unmatched identity', f => { f.observations[1].title = 'Other'; f.observations[1].text = 'Unrelated '.repeat(40); }],
  ['arbitrary descendant', f => { f.observations[2].url = `${facebook}groups`; f.observations[1].links = [{ url: f.observations[2].url }]; f.candidate.contactSources.phone = f.observations[2].url; }],
]) test(`About ownership rejects ${label}`, () => {
  const f = fixture(); mutate(f); assert.equal(contactSupported(f, 'phone'), false);
});

test('bounded About subroutes work but arbitrary nested About descendants do not', () => {
  for (const [suffix, expected] of [['about_contact_and_basic_info', true], ['about_places', true], ['about/other', false]]) {
    const f = fixture(), url = `${facebook}${suffix}`;
    f.observations[2].url = url; f.observations[1].links = [{ url }]; f.candidate.contactSources.phone = url;
    assert.equal(contactSupported(f, 'phone'), expected);
  }
});

for (const [label, link] of [
  ['duplicate u', 'https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.instagram.com%2Fjuniper1%2F&u=https%3A%2F%2Fwww.instagram.com%2Fjuniper1%2F'],
  ['nested wrapper', `https://l.facebook.com/l.php?u=${encodeURIComponent('https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.instagram.com%2Fjuniper1%2F')}`],
  ['wrong wrapper path', 'https://l.facebook.com/other?u=https%3A%2F%2Fwww.instagram.com%2Fjuniper1%2F'],
  ['lookalike host', 'https://l.facebook.com.evil.example/l.php?u=https%3A%2F%2Fwww.instagram.com%2Fjuniper1%2F'],
  ['unsafe target', 'https://l.facebook.com/l.php?u=javascript%3Aalert(1)'],
  ['credential target', `https://l.facebook.com/l.php?u=${encodeURIComponent('https://user:pass@www.instagram.com/juniper1/')}`],
  ['signed target', `https://l.facebook.com/l.php?u=${encodeURIComponent('https://www.instagram.com/juniper1/?token=fixture')}`],
  ['double encoded target', `https://l.facebook.com/l.php?u=${encodeURIComponent(encodeURIComponent('https://www.instagram.com/juniper1/'))}`],
  ['insecure wrapper', 'http://l.facebook.com/l.php?u=https%3A%2F%2Fwww.instagram.com%2Fjuniper1%2F'],
  ['signed wrapper', 'https://l.facebook.com/l.php?token=fixture&u=https%3A%2F%2Fwww.instagram.com%2Fjuniper1%2F'],
]) test(`social contact rejects ${label}`, () => {
  const f = fixture(); f.observations[2].links = [{ url: facebook }, { url: link }];
  assert.equal(contactSupported(f, 'instagram'), false);
});

test('cross-social contact needs an inspected identity-matched selected target profile', () => {
  const f = fixture(); f.observations[0].title = 'Other'; f.observations[0].text = 'Unrelated '.repeat(40);
  assert.equal(contactSupported(f, 'instagram'), false);
});

test('cross-social contact rejects missing, stale and blocked target observations', () => {
  for (const mutate of [f => { f.candidate.inspectionIds.shift(); }, f => { f.observations[0].blocked = true; }, f => { f.observations[0].inspectedAt = '2020-01-01'; }]) {
    const f = fixture(); mutate(f); assert.equal(contactSupported(f, 'instagram'), false);
  }
});

test('Instagram About and unverified third-party pages cannot publish sourced contacts', () => {
  for (const url of ['https://www.instagram.com/juniper1/about', 'https://directory.example/juniper']) {
    const f = fixture(); f.observations[2].url = url; f.observations[1].links = [{ url }];
    f.candidate.contactSources.phone = url;
    assert.equal(contactSupported(f, 'phone'), false);
  }
});

test('direct selected social profile link on About also supports contact', () => {
  const f = fixture(); f.observations[2].links[1] = { url: f.candidate.contacts.instagram };
  assert.equal(contactSupported(f, 'instagram'), true);
});

test('About location excerpt is usable without relaxing activity, website or media holds', () => {
  const f = fixture(); f.candidate.websiteCheck.status = 'unknown'; f.candidate.media = [];
  f.candidate.activityEvidence.excerpt = 'Unsupported model assertion';
  assert.equal(localitySupported(f), true);
  const result = gate(f); assert.equal(result.ready, false);
  for (const fragment of ['Website absence', 'Recent activity', 'photography is missing']) assert.ok(result.reasons.some(v => v.includes(fragment)));
});

function factSourceMatch(observed, claimed) {
  const f = intakeFixture(), o = structuredClone(f.observations[0]);
  o.id = 'source-query'; o.url = observed; o.links = [];
  f.observations.push(o); f.candidate.inspectionIds.push(o.id);
  f.candidate.facts[0].sourceUrl = claimed;
  return !gate(f).reasons.some(v => v.startsWith('At least three useful facts'));
}
test('23 distinct photo query identities do not collapse', () => {
  for (let i = 1; i <= 23; i++) assert.equal(factSourceMatch('https://www.facebook.com/photo/?fbid=0', `https://www.facebook.com/photo/?fbid=${i}`), false);
});
test('semantic and unknown query parameters remain identity-bearing', () => {
  for (const key of ['id', 'fbid', 'story_fbid', 'set', 'unknown']) assert.equal(factSourceMatch(`https://www.facebook.com/profile.php?${key}=1`, `https://www.facebook.com/profile.php?${key}=2`), false);
});
test('known tracking is ignored and query ordering is stable', () => {
  assert.equal(factSourceMatch('https://www.facebook.com/photo/?id=1&fbid=2&utm_source=fixture&fbclid=fixture', 'https://www.facebook.com/photo/?fbid=2&id=1'), true);
});
test('query-based different profile accounts cannot establish first-party contact', () => {
  const f = fixture(); f.candidate.contacts.facebook = 'https://www.facebook.com/profile.php?id=1';
  f.candidate.contactSources.facebook = 'https://www.facebook.com/profile.php?id=2';
  f.observations[1].url = f.candidate.contactSources.facebook;
  assert.equal(contactSupported(f, 'facebook'), false);
});

const redirect = (host, target) => `https://${host}${host === 'l.facebook.com' ? '/l.php' : '/'}?u=${encodeURIComponent(target)}`;
const outboundHeld = f => gate(f).reasons.some(v => v.startsWith('A possible outbound official'));
function outboundFixture(host, status, findingUsesWrapper = false) {
  const f = intakeFixture(), target = 'https://workshop.example/?id=123', wrapper = redirect(host, target);
  f.observations[0].links.push({ url: wrapper });
  if (status) {
    const o = { id: 'source-outbound', url: target, inspectedAt: new Date().toISOString(), blocked: false, text: 'Synthetic inspected target.' };
    f.observations.push(o);
    f.candidate.websiteCheck.linkChecks.push({ url: findingUsesWrapper ? wrapper : target, sourceId: o.id, status, reason: 'Synthetic fixture finding' });
  }
  return f;
}
for (const host of ['l.facebook.com', 'l.instagram.com']) {
  test(`${host} external target requires an actual target receipt`, () => {
    assert.equal(outboundHeld(outboundFixture(host)), true);
    for (const raw of [false, true]) assert.equal(gate(outboundFixture(host, 'unofficial', raw)).ready, true);
  });
  test(`${host} official, blocked, stale and mismatched target evidence holds`, () => {
    assert.equal(outboundHeld(outboundFixture(host, 'official')), true);
    for (const mutate of [f => { f.observations[1].blocked = true; }, f => { f.observations[1].inspectedAt = '2020-01-01'; }, f => { f.observations[1].url = 'https://other.example/'; }, f => { f.observations[1].id = 'source-wrong'; }, f => { f.observations[1].url = f.observations[0].links[1].url; }]) {
      const f = outboundFixture(host, 'unofficial', true); mutate(f); assert.equal(outboundHeld(f), true);
    }
  });
  test(`${host} invalid wrappers never skip possible websites`, () => {
    const valid = redirect(host, 'https://workshop.example/');
    for (const url of [valid.replace(host === 'l.facebook.com' ? '/l.php' : '/?u', '/unknown?u'), `${valid}&u=https%3A%2F%2Fother.example`, redirect(host, redirect(host, 'https://workshop.example/')), valid.replace('https:', 'http:'), redirect(host, 'https://workshop.example/?token=fixture'), redirect(host, 'javascript:alert(1)')]) {
      const f = intakeFixture(); f.observations[0].links.push({ url }); assert.equal(outboundHeld(f), true);
    }
  });
  test(`${host} selected verified social profile wrapper is not an outbound website`, () => {
    const f = intakeFixture(); f.observations[0].links.push({ url: redirect(host, f.candidate.contacts.instagram) });
    assert.equal(gate(f).ready, true);
  });
}
