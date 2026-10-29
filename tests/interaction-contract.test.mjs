import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInteraction } from '../src/interaction-contract.mjs';

export const candidate = { facts: [{ id: 'fact-1', text: 'Inspect supplied examples before enquiring.' }] };
export const media = [{ web_file: 'site/assets/photos/one.png' }, { web_file: 'site/assets/photos/two.png' }];
export function contract(kind = 'filter') {
  return { version: 1, kind, description: 'Inspect supported examples', page: 'work.html', targetId: 'examples',
    states: [{ id: 'all', controlId: 'show-all', outputIds: ['one', 'two'] }, { id: 'first', controlId: 'show-first', outputIds: ['one'] }],
    outputs: [{ id: 'one', text: 'First supplied example', factIds: ['fact-1'] }, { id: 'two', text: 'Second supplied example', factIds: ['fact-1'] }],
    fallback: 'All examples remain available without JavaScript.', accessibility: 'Native buttons support touch and keyboard; selection is announced.', reducedMotion: 'Immediate state replacement without nonessential movement.' };
}
test('strong contract binds bounded states, output IDs and frozen facts/photos', () => {
  const value = contract(); value.outputs[0].photo = 'assets/photos/one.png'; value.motionTargetId = 'photo-entry';
  assert.deepEqual(validateInteraction(value, { candidate, media, pages: ['work.html'] }), value);
  for (const mutate of [
    v => v.kind = 'quote', v => v.page = '../work.html', v => v.targetId = 'a,body',
    v => v.outputs[0].factIds = ['fact-unknown'], v => v.outputs[0].photo = 'https://other.example/photo.png',
    v => v.states[0].outputIds = ['missing'], v => v.states[1].controlId = v.states[0].controlId,
    v => v.selector = 'body', v => v.states[0].script = 'run()', v => v.outputs[0].text = '',
    v => v.outputs[0].factIds = [], v => v.states = [], v => v.motionTargetId = 'x[onclick]',
  ]) { const bad = contract(); mutate(bad); assert.throws(() => validateInteraction(bad, { candidate, media }), /interaction|fact|photo|state|output|field|ID|page/i); }
});
test('legacy contracts are explicit and cannot claim version-one coverage or unknown kinds', () => {
  assert.throws(() => validateInteraction({ kind: 'filter' }, { candidate, media }));
  assert.deepEqual(validateInteraction({ kind: 'filter' }, { legacy: true }), { kind: 'filter', coverage: 'legacy_kind_only' });
  assert.throws(() => validateInteraction({ kind: 'unknown' }, { legacy: true }));
  assert.throws(() => validateInteraction({ kind: 'planning' }, { legacy: true }));
  assert.throws(() => validateInteraction({ ...contract(), version: 2 }, { legacy: true, candidate, media }));
});
test('planning is only a local factual process explorer, gallery requires actual photos', () => {
  const planner = contract('planning'); planner.states[0].outputIds = ['two'];
  assert.throws(() => validateInteraction(planner, { candidate, media }), /process|fact/i);
  for (const output of planner.outputs) output.text = candidate.facts[0].text;
  assert.equal(validateInteraction(planner, { candidate, media }).kind, 'planning');
  planner.outputs[0].text = 'Your booking is confirmed';
  assert.throws(() => validateInteraction(planner, { candidate, media }), /process|fact/i);
  assert.throws(() => validateInteraction(contract('gallery'), { candidate, media }), /photo/i);
});
