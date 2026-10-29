import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const previous = {
  design: { thesis: 'Synthetic automotive visual identity', comparisons: ['Distinct photo framing', 'Distinct page rhythm', 'Distinct navigation'], interaction: 'Retain the supplied comparison disclosure' },
  files: ['index', 'services', 'work', 'about', 'contact'].map(name => ({ path: `${name}.html`, content: `<main><h1>Synthetic ${name}</h1></main>` })),
};
const common = {
  candidate: { name: 'SYNTHETIC mobile detailer', facts: [{ id: 'fact-1', text: 'Synthetic documented detailing process' }], unknowns: [] },
  media: [], references: [], previous,
  brief: { pageMap: previous.files.map(f => ({ file: f.path })), signatureInteraction: { kind: 'details' } },
  failures: ['work.html: vehicle comparison captions overlap at 390px'],
  feedback: 'Correct only the vehicle comparison captions.',
  files: [], model: 'synthetic-request-capture',
};

// Mock only the model boundary in an isolated child. The actual creative module,
// evidence serializer, shared rules and proposal validator run unchanged. No
// worker, browser, source tool, cache, database or model request is executed.
async function capturePolish(input = common) {
  const script = `
    import { mock } from 'node:test';
    let request, calls = 0;
    mock.module(${JSON.stringify(new URL('../src/model.mjs', import.meta.url).href)}, {
      namedExports: { requestModel: async value => { calls++; request = value; return { output: ${JSON.stringify(previous)} }; } }
    });
    const { polishProposal } = await import(${JSON.stringify(new URL('../src/creative.mjs', import.meta.url).href)});
    const proposal = await polishProposal(${JSON.stringify(input)});
    console.log(JSON.stringify({ request, calls, proposal }));
  `;
  const { stdout } = await exec(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '--eval', script], { timeout: 20000 });
  return JSON.parse(stdout);
}

test('nonfood polish receives no unsolicited food-site or numbered-contact corrections', async () => {
  const { request, calls } = await capturePolish();
  assert.equal(calls, 1);
  for (const unrelated of ['WHOLE burger bun', 'Antojos phone index', 'contact 02/03', 'FOUR VISUAL DEFECTS']) {
    assert.ok(!request.prompt.includes(unrelated), `Unsolicited correction: ${unrelated}`);
  }
});

test('polish preserves exact supplied blockers, feedback, frozen facts, identity and all five source pages', async () => {
  const { request, proposal } = await capturePolish();
  assert.ok(request.prompt.includes(JSON.stringify(common.failures)));
  assert.ok(request.prompt.includes(common.feedback));
  assert.ok(request.prompt.includes(JSON.stringify(common.candidate)));
  assert.ok(request.prompt.includes(JSON.stringify(previous.design)));
  assert.ok(request.prompt.includes(JSON.stringify(previous.files)));
  assert.match(request.prompt, /retaining every page, photograph, source caption, real action and progressive motion mechanism/);
  assert.match(request.prompt, /No rebranding, new facts, extra feature or additional retry is authorized/);
  assert.equal(proposal.files.length, 5);
  assert.equal(request.role, 'proposer');
  assert.equal(request.model, common.model);
  assert.deepEqual(request.files, []);
});

test('explicit supplied food and numbered-contact corrections remain intact, not blacklisted', async () => {
  const failures = ['Preserve the WHOLE burger bun inside the desktop aperture.', 'Make the Antojos phone index sign-like.', 'Fix contact 02/03 with nonwrapping digits.'];
  const feedback = 'Correct the burger bun crop and Antojos labels only; retain the food identity.';
  const { request } = await capturePolish({ ...common, candidate: { ...common.candidate, name: 'SYNTHETIC food business' }, failures, feedback });
  assert.ok(request.prompt.includes(JSON.stringify(failures)));
  assert.ok(request.prompt.includes(feedback));
});

for (const count of [0, 1, 3, 6]) test(`polish carries ${count} supplied blockers without assuming four`, async () => {
  const failures = Array.from({ length: count }, (_, index) => `Synthetic supplied blocker ${index + 1}`);
  const { request } = await capturePolish({ ...common, failures });
  assert.ok(request.prompt.includes(JSON.stringify(failures)));
  assert.ok(!request.prompt.includes('FOUR VISUAL DEFECTS'), 'The label must not invent a blocker count');
});
