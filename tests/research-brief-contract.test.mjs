import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

test('actual discover argv carries bounded service-cohort and honest-evidence instructions', async t => {
  const root = await mkdtemp('/tmp/factory-research-brief-');
  const bin = path.join(root, 'bin'), sources = path.join(root, 'job/sources');
  await mkdir(bin, { mode: 0o700 });
  await mkdir(sources, { recursive: true, mode: 0o700 });
  await writeFile(path.join(sources, 'search-123abc.json'), JSON.stringify({ provider: 'firecrawl', status: 'completed', intent: 'verify', query: 'Synthetic business', results: [{ url: 'https://fixture.example/', title: 'Synthetic business' }] }), { mode: 0o600 });
  const capture = path.join(root, 'argv.json');
  await writeFile(path.join(bin, 'opencode'), `#!${process.execPath}
(async()=>{
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)), { mode: 0o600 });
const output={ candidates: [], shortfall: 'Synthetic fixture; no external research.' };
const {checkResearchOutput}=await import(${JSON.stringify(new URL('../src/research-check.mjs',import.meta.url).href)});await checkResearchOutput({directory:process.env.FACTORY_SOURCES,requestId:process.env.FACTORY_RESEARCH_REQUEST,candidateLimit:Number(process.env.FACTORY_RESEARCH_LIMIT),output});
console.log(JSON.stringify({ type: 'text', sessionID: 'synthetic-brief', part: { text: JSON.stringify(output) } }));
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
`, { mode: 0o700 });
  const script = `import { discover } from ${JSON.stringify(new URL('../src/research.mjs', import.meta.url).href)};
const result = await discover({ candidateLimit: 6, area: 'Houston', niche: 'Residential furniture reupholstery workshops', deadlineMinutes: 2 }, { jobRoot: ${JSON.stringify(path.dirname(sources))}, batch: { settings: { searchProvider: 'firecrawl' }, seen: [], checkpoint: false } });
console.log(JSON.stringify(result));`;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', script], { env: { PATH: bin, HOME: root }, timeout: 20000 });
  assert.deepEqual(JSON.parse(stdout).candidates, []);
  const argv = JSON.parse(await readFile(capture, 'utf8')), prompt = argv.at(-1);
  assert.equal(argv[argv.indexOf('--model') + 1], 'openai/gpt-6.1-sol-fast');
  const paragraph = term => {
    const value = prompt.split('\n').find(line => line.includes(term));
    assert.ok(value, `missing coherent instruction paragraph: ${term}`);
    return value;
  };
  await t.test('service workshop interpretation remains conditional on declared campaign category', () => {
    const p = paragraph('SERVICE-COHORT TRIAGE:');
    assert.match(p, /customer commissions/);
    assert.match(p, /training|tutorial/);
    assert.match(p, /retailers/);
    assert.match(p, /auto-only/);
    assert.match(p, /explicitly.*school.*class/i);
    assert.match(p, /identity.*geography.*declared services.*official.site.*before.*media/i);
  });
  await t.test('held candidate is retained without exhausting other relevant names or evading caps', () => {
    const p = paragraph('BOUNDED TRIAGE:');
    assert.match(p, /held business is not.*round success/i);
    assert.match(p, /other relevant named businesses.*budget remain/i);
    assert.match(p, /candidateLimit.*source caps/);
    assert.match(p, /actual held record.*remaining gaps/i);
    assert.match(p, /recheck.*exact.*business/i);
  });
  await t.test('contacts and dates require exact inspected support rather than synthetic aliases or dates', () => {
    const p = paragraph('EVIDENCE PRECISION:');
    assert.match(p, /contactSources.*exact inspected source URL/);
    assert.match(p, /About/);
    assert.match(p, /canonical aliases/);
    assert.match(p, /dateText.*literal.*source/i);
    assert.match(p, /current date/);
    assert.match(p, /omit.*activityEvidence.*entirely/i);
  });
  await t.test('optional held structures do not replace build-ready proof or strict source IDs', () => {
    const p = paragraph('HOLD OUTPUT:');
    assert.match(p, /omit.*pagePurposes.*media/i);
    assert.match(p, /build-ready.*all required proof/i);
    assert.match(p, /sourceId:null.*explicitly unresolved/);
    assert.match(p, /never guess.*source IDs/i);
    assert.match(prompt, /Use ONLY sources.search with provider=firecrawl/);
    assert.match(prompt, /No browser credentials\/login\/challenge bypass/);
  });
});
