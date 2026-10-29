import test from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '../src/contracts.mjs';
import { validateMediaSelection } from '../src/media.mjs';

const profile = 'https://www.facebook.com/profile.php?id=111';
const post = 'https://www.facebook.com/photo/?fbid=333&id=111';
const candidate = { contacts: { facebook: profile } };
const selected = { sourceId: 'source-fixture', imageId: 'image-fixture', account: profile, postUrl: post, businessPosted: true, alt: 'Fixture furniture', role: 'supporting' };
const observation = { id: selected.sourceId, url: post, blocked: false, images: [{ id: selected.imageId, width: 900, height: 600 }] };

test('resource identity preserves semantic photo/account query parameters and only removes known tracking', () => {
  const key = contracts.publicResourceKey;
  assert.equal(typeof key, 'function');
  assert.notEqual(key(profile), key('https://www.facebook.com/profile.php?id=222'));
  assert.notEqual(key(post), key('https://www.facebook.com/photo/?fbid=444&id=111'));
  assert.equal(key(post), key('https://m.facebook.com/photo?id=111&fbid=333&utm_source=fixture&fbclid=tracking'));
  assert.notEqual(key('https://example.com/page?section=one'), key('https://example.com/page?section=two'));
  assert.equal(key('https://example.com/page?section=one&utm_medium=test'), key('https://example.com/page?section=one'));
  assert.equal(key('https://example.com/?access_token=not-a-real-token'), null);
  assert.equal(key('https://user:password@example.com/'), null);
});

test('a different numeric Facebook account cannot masquerade as the selected business account', () => {
  assert.throws(() => validateMediaSelection(candidate, { ...selected, account: 'https://www.facebook.com/profile.php?id=222' }, observation), e => e.code === 'MEDIA_IDENTITY');
});

test('a different photo ID on the same path cannot masquerade as the observed post', () => {
  assert.throws(() => validateMediaSelection(candidate, { ...selected, postUrl: 'https://www.facebook.com/photo/?fbid=444&id=111' }, observation), e => e.code === 'MEDIA_IDENTITY');
});

test('exact observed post identity allows parameter ordering and known tracking differences', () => {
  const value = validateMediaSelection(candidate, selected, { ...observation, url: 'https://m.facebook.com/photo?id=111&fbid=333&mibextid=tracking' });
  assert.equal(value.post_url, post);
  assert.equal(value.use_status, 'operator_authorized_private_preview');
  assert.equal(value.public_release, false);
});

test('the exact selected business profile remains a valid observation source', () => {
  assert.equal(validateMediaSelection(candidate, selected, { ...observation, url: profile }).observation_id, observation.id);
});
