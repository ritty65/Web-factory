import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const query = 'Houston upholstery "café" & furniture';
const relevant = [{ url: 'https://example.com/work/', title: 'Houston furniture upholstery', description: 'Independent workshop' }];
async function fixture(options = {}) {
  const script = `
import { mock } from 'node:test';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import vm from 'node:vm';
const options = ${JSON.stringify({ query, results: relevant, ...options })};
const directory = await mkdtemp('/tmp/factory-browser-boundary-');
const calls = [], requested = 'https://www.bing.com/search?q=' + encodeURIComponent(options.query);
mock.module(${JSON.stringify(new URL('../src/network.mjs', import.meta.url).href)}, { namedExports: {
  resolvePublic: async () => ({address:'93.184.216.34',family:4}),
  safeFetch: async url => ({url,status:200,bytes:Buffer.from('fixture')})
} });
mock.module(${JSON.stringify(new URL('../src/process.mjs', import.meta.url).href)}, { namedExports: {
  runProcess: async (command, args) => {
    calls.push({command,args});
    const action = args.includes('open') ? 'open' : args.includes('wait') ? 'wait' : args.includes('eval') ? 'eval' : 'close';
    if (options.throwAt === action) throw new Error('fixture failure');
    if (options.failAt === action) return {stdout:JSON.stringify({success:false,error:'fixture failure'})};
    if (action !== 'eval') return {stdout:JSON.stringify({success:true,data:{}})};
    if (options.malformed) return {stdout:'not json'};
    const document = {
      title:'Fixture search', body:{innerText:'Public search results'},
      querySelector: selector => selector === '#sb_form_q' ? (options.missingInput ? null : {value:options.searchQuery ?? options.query}) : {textContent:'Public search results'},
      querySelectorAll: () => options.results.map(item => ({querySelector: selector => selector === 'h2 a' ? {textContent:item.title,href:item.url} : {textContent:item.description}}))
    };
    const result = vm.runInNewContext(args.at(-1), {document,location:{href:options.missingLocation ? undefined : options.finalUrl ?? requested}});
    return {stdout:JSON.stringify({success:true,data:{result}})};
  }
} });
const { inspectSource, publicObservation } = await import(${JSON.stringify(new URL('../src/browser.mjs', import.meta.url).href)});
const { searchPublic } = await import(${JSON.stringify(new URL('../src/search.mjs', import.meta.url).href)});
let value, error;
try { value = options.inspect ? await inspectSource(requested,{directory}) : await searchPublic(options.query,{directory,intent:'discover'}); }
catch(e) { error = {code:e.code,message:e.message}; }
const files = await readdir(directory), records = [];
for (const name of files) if (name.endsWith('.json')) records.push({name,data:JSON.parse(await readFile(directory+'/'+name,'utf8'))});
console.log(JSON.stringify({value,error,calls,records,public:options.inspect && value ? publicObservation(value) : null,
  nonSearchPublic:options.inspect && value ? publicObservation({...value,method:'fresh_guest_rendered_dom',finalUrl:'https://example.com/?access_token=private',searchQuery:'private'}) : null}));
`;
  const { stdout } = await exec(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '--eval', script], { timeout: 15000 });
  return JSON.parse(stdout);
}
function closed(result) {
  assert.equal(result.calls.at(-1).args.at(-1), 'close');
  assert.equal(result.calls.at(-1).args[1], result.calls[0].args[1]);
}
function noSearchReceipt(result) { assert.equal(result.records.some(record => record.name.startsWith('search-')), false); }

test('real adapter captures committed query, keeps exact encoded argv and persists normalized results', async () => {
  const result = await fixture({ results: [{ ...relevant[0], url: 'https://www.bing.com/ck/a?u=a1' + Buffer.from(relevant[0].url).toString('base64url') }] });
  assert.equal(result.error, undefined);
  assert.equal(result.value.results[0].url, relevant[0].url);
  const source = result.records.find(record => record.name.startsWith('source-')).data;
  assert.equal(source.finalUrl, 'https://www.bing.com/search?q=' + encodeURIComponent(query));
  assert.equal(source.searchQuery, query);
  assert.equal(result.calls[0].args.at(-1), source.url);
  assert.ok(result.records.some(record => record.name.startsWith('search-')));
  closed(result);
});
test('public search observation exposes only validated Bing committed metadata', async () => {
  const result = await fixture({ inspect: true });
  assert.equal(result.public.finalUrl, result.value.url);
  assert.equal(result.public.searchQuery, query);
  assert.equal(result.public.searchResults, undefined);
  assert.equal(result.nonSearchPublic.finalUrl, undefined);
  assert.equal(result.nonSearchPublic.searchQuery, undefined);
  assert.equal(result.nonSearchPublic.searchResults, undefined);
});
test('public observation omits raw signed result URLs while actual search normalization rejects them', async () => {
  const signed = { url: 'https://example.com/private?access_token=fixture-only', title: 'Houston furniture upholstery', description: 'Signed fixture URL' };
  const inspected = await fixture({ inspect: true, results: [signed, ...relevant] });
  assert.equal(inspected.error, undefined);
  assert.equal(inspected.value.searchResults[0].url, signed.url, 'private raw extraction remains available for normalization');
  assert.equal(inspected.public.searchResults, undefined);
  assert.equal(JSON.stringify(inspected.public).includes('access_token=fixture-only'), false);
  const searched = await fixture({ results: [signed, ...relevant] });
  assert.equal(searched.error, undefined);
  assert.deepEqual(searched.value.results, relevant);
  const receipt = searched.records.find(record => record.name.startsWith('search-')).data;
  assert.deepEqual(receipt.results, relevant);
  closed(inspected); closed(searched);
});
for (const [label, options] of [
  ['wrong final query', {finalUrl:'https://www.bing.com/search?q=wrong'}],
  ['missing final query', {finalUrl:'https://www.bing.com/search'}],
  ['missing final location', {missingLocation:true}],
  ['duplicate final query', {finalUrl:'https://www.bing.com/search?q=wrong&q=wrong'}],
  ['wrong origin', {finalUrl:'https://example.com/search?q=secret&access_token=private'}],
  ['wrong path', {finalUrl:'https://www.bing.com/other?q=wrong'}],
  ['missing search box', {missingInput:true}],
  ['wrong rendered query', {searchQuery:'wrong'}],
]) test(`${label} retains blocked diagnostic, never a completed search receipt`, async () => {
  const result = await fixture(options);
  assert.equal(result.error?.code, 'SEARCH_BLOCKED');
  noSearchReceipt(result);
  const source = result.records.find(record => record.name.startsWith('source-')).data;
  assert.equal(source.blocked, true);
  assert.equal(source.searchMismatch, true);
  assert.match(source.limitations, /BROWSER_SEARCH_MISMATCH/);
  assert.equal(JSON.stringify(source).includes('access_token'), false);
  closed(result);
});
test('rendered query comparison permits surrounding whitespace only', async () => {
  const result = await fixture({searchQuery:'  '+query+'  '});
  assert.equal(result.error, undefined);
  assert.equal(result.records.find(record => record.name.startsWith('source-')).data.searchQuery, '  '+query+'  ');
});
for (const options of [{failAt:'open'}, {failAt:'wait'}, {throwAt:'wait'}, {malformed:true}]) test(`CLI boundary fails closed: ${JSON.stringify(options)}`, async () => {
  const result = await fixture(options);
  assert.ok(result.error);
  if (options.failAt) assert.equal(result.error.code, 'BROWSER_FAILED');
  noSearchReceipt(result);
  if (!options.malformed) assert.equal(result.calls.some(call => call.args.includes('eval')), false);
  closed(result);
});
for (const [query, results] of [
  ['Houston furniture reupholstery "facebook" "upholstery" workshop', [{url:'https://en.wikipedia.org/wiki/Houston',title:'Houston - Wikipedia',description:'Greater Houston metropolitan area'}]],
  ['"Houston" "upholstery" "facebook.com" furniture reupholstery', [{url:'https://www.visithoustontexas.com/',title:'Visit Houston Texas',description:'Things to do and places to stay'}]],
  ['furniture reupholstery workshops Houston upholstery shop', [{url:'https://translate.google.com.mx/',title:'Google Traductor',description:'Traducir palabras y páginas web'}]],
]) test(`actual search adapter rejects historical irrelevant discovery: ${query}`, async () => {
  const result = await fixture({query,results});
  assert.equal(result.error?.code, 'SEARCH_INADEQUATE');
  noSearchReceipt(result);
  closed(result);
});
