import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as search from '../src/search.mjs';

// Sanitized title/URL/snippet subsets of the three actual failed discovery receipts.
const tourism = [
  { url: 'https://en.wikipedia.org/wiki/Houston', title: 'Houston - Wikipedia', description: 'The Greater Houston metropolitan area, at 7.8 million residents' },
  { url: 'https://www.visithoustontexas.com/', title: 'Visit Houston Texas | Things to Do, Places to Stay & Events', description: "Plan your trip to Houston’s must-see attractions" },
];
const translation = [
  { url: 'https://translate.google.com.mx/', title: 'Google Traductor', description: 'Google Traductor permite traducir palabras, frases y páginas web' },
  { url: 'https://www.deepl.com/es/translator', title: 'DeepL Translator | El traductor más preciso del mundo', description: 'Traducciones precisas de calidad empresarial' },
];
const queries = [
  'Houston furniture reupholstery "facebook" "upholstery" workshop',
  '"Houston" "upholstery" "facebook.com" furniture reupholstery',
  'furniture reupholstery workshops Houston upholstery shop',
];
test('all three saved irrelevant discovery cases are inadequate, not business-absence evidence', () => {
  for (const [i, query] of queries.entries()) {
    assert.equal(search.relevantDiscoveryEvidence(query, i === 2 ? translation : tourism), false);
  }
});
test('discovery uses the full query regardless of its first quoted phrase', () => {
  const results = [{ url: 'https://example.com/work/', title: 'Houston furniture upholsterer', description: 'Custom upholstery and furniture restoration' }];
  for (const query of [...queries, '"facebook" Houston upholstery', '"Houston" upholstery']) {
    assert.equal(search.relevantDiscoveryEvidence(query, results), true, query);
  }
});
test('other categories and locations work without an upholstery or city whitelist', () => {
  assert.equal(search.relevantDiscoveryEvidence('"Houston" mobile auto detailing "facebook"', [
    { url: 'https://example.com/', title: 'Houston mobile auto detailer', description: 'Interior and exterior detailing' },
  ]), true);
  assert.equal(search.relevantDiscoveryEvidence('"Denver" bicycle repairs instagram', [
    { url: 'https://example.com/', title: 'Denver bicycle repair', description: 'Independent cycle workshop' },
  ]), true);
});
test('generic, empty, substring-only and city-only evidence stays unknown', () => {
  for (const query of ['Houston facebook official website', 'best local businesses near me', '']) {
    assert.equal(search.relevantDiscoveryEvidence(query, tourism), false);
  }
  assert.equal(search.relevantDiscoveryEvidence(queries[0], []), false);
  assert.equal(search.relevantDiscoveryEvidence('Houston auto detailing', [{ url: 'https://example.com/', title: 'Houston automation', description: 'Detailed city guide' }]), false);
});
test('bounded suffix normalization matches category variants without an exact spelling elsewhere', () => {
  assert.equal(search.relevantDiscoveryEvidence('"Houston" upholstery', [
    { url: 'https://example.com/', title: 'Houston upholsterer', description: 'Independent specialist' },
  ]), true);
  assert.equal(search.relevantDiscoveryEvidence('"Houston" detailing', [
    { url: 'https://example.com/', title: 'Houston detailer', description: 'Independent specialist' },
  ]), true);
});
test('searchPublic gates discovery for both providers before persistence and preserves query encoding', async () => {
  const source = await readFile(new URL('../src/search.mjs', import.meta.url), 'utf8');
  const commonGuard = source.indexOf("if (intent === 'discover' && !relevantDiscoveryEvidence(query, result.results))");
  assert.ok(commonGuard > source.indexOf("result = { provider: 'guest_bing'"));
  assert.ok(commonGuard < source.indexOf('result.intent = intent'));
  assert.match(source.slice(commonGuard), /fail\('SEARCH_INADEQUATE', '[^']*unknown[^']*absence/);
  const expression = source.match(/inspectSource\((`https:\/\/www\.bing\.com\/search\?q=\$\{encodeURIComponent\(query\)\}`)/)?.[1];
  assert.ok(expression, 'test the actual query URL expression, not a copied encoder');
  for (const query of queries) {
    const url = new URL(Function('query', `return ${expression}`)(query));
    assert.equal(url.searchParams.get('q'), query);
  }
});
