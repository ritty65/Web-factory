import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceMode } from '../src/browser.mjs';
test('arbitrary research websites cannot execute JavaScript in a host browser', () => {
  assert.equal(sourceMode('https://www.instagram.com/business/'), 'guest_browser');
  assert.equal(sourceMode('https://www.facebook.com/business/'), 'guest_browser');
  assert.equal(sourceMode('https://titosdetailinghtx.com/'), 'guest_browser');
  for (const url of ['https://attacker.example/page','https://instagram.com.attacker.example/page','https://untrusted.titosdetailinghtx.com/page']) assert.equal(sourceMode(url), 'static_https_no_script');
  assert.throws(() => sourceMode('https://127.0.0.1/private'));
});
