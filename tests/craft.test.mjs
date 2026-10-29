import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';

const design = { thesis: 'Synthetic direction only', comparisons: ['Different layout than CakeMake', 'Different photographic framing than Cream Burger', 'Different navigation than H-Details'] };
const study = name => ({ name, design, files: [{ path: 'index.html', content: `<!doctype html><html lang="en"><head><title>${name} fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>${name} fixture</h1><a href="#more">Explore</a><section id="more"><h2>Real supporting section</h2></section></main></body></html>` }] });

test('visual studies require three different complete single-page compositions and safe host assets', async () => {
  const { validateStudies } = await import('../src/craft.mjs');
  const studies = [study('A'), study('B'), study('C')];
  assert.equal(validateStudies({ studies }).length, 3);
  assert.throws(() => validateStudies({ studies: studies.slice(0, 2) }), /three|3/);
  assert.throws(() => validateStudies({ studies: [studies[0], studies[0], studies[2]] }), /different|distinct/);
  assert.throws(() => validateStudies({ studies: [{ ...studies[0], files: [{ path: '../outside.html', content: 'unsafe' }] }, ...studies.slice(1)] }));
  assert.throws(() => validateStudies({ studies: [{ ...studies[0], files: [...studies[0].files, { path: 'assets/factory-motion.js', content: 'hostile replacement' }] }, ...studies.slice(1)] }), /host|reserved/);
});
test('actual study renders retain six desktop/phone pixels and bind each result to its bytes', async () => {
  const { renderStudies } = await import('../src/craft.mjs');
  const jobRoot = await mkdtemp('/tmp/factory-studies-');
  const result = await renderStudies({ studies: [study('Poster'), study('Window'), study('Photo')], media: [], jobRoot, candidate: {} });
  assert.equal(result.studies.length, 3); assert.equal(result.captures.length, 6);
  assert.ok(result.studies.every(s => s.pass && s.siteDigest.length === 64));
  assert.equal((await readFile(`${jobRoot}/${result.captures[0].relative}`)).subarray(1, 4).toString(), 'PNG');
});
test('creative image selection includes all five pages on desktop/phone, not only the homepage', async () => {
  const { reviewImages, validateSelection } = await import('../src/craft.mjs');
  const pages = ['index', 'offer', 'story', 'photos', 'contact'];
  const captures = pages.flatMap(file => [1440, 390].map(width => ({ file: file + '.html', viewport: [width, 900], kind: 'full_page', relative: `${file}-${width}.png` })));
  assert.equal(reviewImages({ captures }).length, 10);
  assert.equal(new Set(reviewImages({ captures }).map(c => c.file)).size, 5);
  assert.throws(() => reviewImages({ captures: captures.slice(0, 2) }), /five|coverage/i);
  assert.equal(validateSelection({ selectedDirection: 2, notes: ['Actual composition contrast'], blockingDefects: [] }).selectedDirection, 2);
  assert.throws(() => validateSelection({ selectedDirection: 3, notes: ['Outside'], blockingDefects: [] }));
  assert.throws(() => validateSelection({ selectedDirection: 0, notes: [], blockingDefects: [] }));
});
test('declared signature review requires phone/laptop task states without losing all-page coverage', async () => {
  const { reviewImages } = await import('../src/craft.mjs');
  const captures = ['index', 'offer', 'story', 'work', 'contact'].flatMap(file => [1440, 390].map(width => ({ file: file + '.html', viewport: [width, 900], kind: 'full_page', relative: `${file}-${width}.png` })));
  const signatureContract = { version: 1, page: 'work.html', targetId: 'examples', states: [{ id: 'all' }, { id: 'first' }] };
  assert.throws(() => reviewImages({ captures, signatureContract }), /signature|state/i);
  for (const width of [1280, 390]) for (const kind of ['signature-settled', 'signature-intermediate', 'scroll-intermediate']) captures.push({ file: 'work.html', viewport: [width, 720], kind, stateId: 'first', interactionId: 'examples', relative: `${kind}-${width}.png` });
  const selected = reviewImages({ captures, signatureContract });
  assert.equal(selected.length, 16);
  assert.equal(selected.filter(c => c.kind === 'full_page').length, 10);
  assert.equal(selected.filter(c => c.kind === 'signature-settled').length, 2);
  assert.equal(new Set(selected.map(c => c.relative)).size, 16);
  assert.throws(() => reviewImages({ captures: captures.filter(c => c.kind !== 'signature-settled' || c.viewport[0] !== 390), signatureContract }), /signature|state/i);
  assert.throws(() => reviewImages({ captures: captures.map(c => c.kind === 'signature-settled' ? { ...c, stateId: 'unrelated' } : c), signatureContract }), /signature|state/i);
});
test('a browser startup failure closes its preview and retains bounded private diagnostics, not a false study pass', async () => {
  const { renderStudies } = await import('../src/craft.mjs'); const jobRoot = await mkdtemp('/tmp/factory-study-browser-failure-');
  await assert.rejects(renderStudies({ studies: [study('A'), study('B'), study('C')], media: [], candidate: {}, jobRoot, launchBrowser: async () => { throw new Error('Synthetic browser startup unavailable'); } }), e => e.code === 'BROWSER_RENDER');
  const diagnostics = (await readdir(jobRoot)).filter(n => n.startsWith('private-browser-'));
  assert.equal(diagnostics.length, 1);
  assert.match(await readFile(`${jobRoot}/${diagnostics[0]}`, 'utf8'), /Synthetic browser startup unavailable/);
});
