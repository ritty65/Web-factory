import test from 'node:test';
import assert from 'node:assert/strict';
import { firecrawlSearch, normalizeSearchResults, relevantSearchEvidence } from '../src/search.mjs';
test('optional Firecrawl search reports missing setup and validates real REST responses without leaking credentials', async () => {
  await assert.rejects(firecrawlSearch('Houston fixture', { apiKey: '' }), /configuration|configured/i);
  let input;
  const result = await firecrawlSearch('Houston fixture', { apiKey: 'fixture-only-key', request: async (url, options) => { input = { url, body: JSON.parse(options.body) }; return { status: 200, bytes: Buffer.from(JSON.stringify({ success: true, creditsUsed: 1, data: { web: [{ url: 'https://www.instagram.com/fixture/', title: 'Actual fixture result', description: 'Fixture' }] } })) }; } });
  assert.equal(input.url, 'https://api.firecrawl.dev/v2/search'); assert.equal(input.body.query, 'Houston fixture'); assert.equal(input.body.limit, 5);
  assert.equal(result.results.length, 1); assert.equal(JSON.stringify(result).includes('fixture-only-key'), false);
  await assert.rejects(firecrawlSearch('Query', { apiKey: 'fixture', request: async () => ({ status: 401, bytes: Buffer.from('forbidden') }) }), /search|authentication/i);
});
test('search normalization treats unsafe/credential/private URLs as data to reject, not new commands', () => {
  const result = normalizeSearchResults([{ url: 'https://127.0.0.1/', title: 'Attack' }, { url: 'https://example.com/?access_token=bad', title: 'Secret' }, { url: 'https://example.com/real', title: '<script>bad</script>' }]);
  assert.equal(result.length, 1); assert.equal(result[0].title, '<script>bad</script>');
});
test('unrelated generic search results cannot count as a successful exact-business check', () => {
  assert.equal(relevantSearchEvidence('"La Super Hueva" Houston website', [{url:'https://en.wikipedia.org/wiki/Los_Angeles',title:'Los Angeles',description:'LA'}]),false);
  assert.equal(relevantSearchEvidence('"La Super Hueva" Houston website', [{url:'https://www.instagram.com/lasuperhuevahtx/',title:'LaSuperHueva',description:'Houston'}]),true);
});
test('a shared food category is not an identity match for the actual known-business probe',()=>{
  const query='"Tacos y Tortas La Super Hueva" Houston, Texas Westchase Westheimer Road official website';
  const unrelated=[{url:'https://example.com/tacos/',title:'9 recetas de tacos mexicanos',description:'Prepare tacos and tortas at home'},{url:'https://example.com/houston-food/',title:'Houston food',description:'Westheimer tacos'}];
  assert.equal(relevantSearchEvidence(query,unrelated),false);
  assert.equal(relevantSearchEvidence(query,[{url:'https://www.instagram.com/lasuperhuevahtx/',title:'La Super Hueva',description:'Business profile'}]),true);
});
