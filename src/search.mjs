import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { providerHttp } from './provider-http.mjs';
import { inspectSource } from './browser.mjs';
import { publicUrl, text, fail, hash, now } from './contracts.mjs';
export function normalizeSearchResults(items) {
  const values = [];
  for (const item of items.slice(0, 10)) {
    try {
      let value = item.url;
      const raw = new URL(value);
      if (raw.hostname.endsWith('bing.com') && raw.pathname === '/ck/a') { const encoded = raw.searchParams.get('u'); if (encoded?.startsWith('a1')) value = Buffer.from(encoded.slice(2), 'base64url').toString('utf8'); }
      const url = publicUrl(value).href;
      values.push({ url, title: String(item.title || '').slice(0, 300), description: String(item.description || '').slice(0, 1500) });
    } catch { /* Invalid/secret/redirect wrappers never become evidence URLs. */ }
  }
  return values;
}
export function relevantSearchEvidence(query, results) {
  // A transport success or shared industry word is not business identity.
  // Prefer the explicitly quoted business name, not its city/road/category.
  const identity = query.match(/"([^"]+)"/)?.[1] || query;
  const words = identity.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').match(/[a-z0-9]{4,}/g) || [];
  const generic = new Set(['houston','texas','website','official','business','https','instagram','facebook','tacos','tortas','restaurant','food','truck','trucks','road']);
  const tokens = [...new Set(words.filter(w => !generic.has(w)))];
  return tokens.length > 0 && results.some(r => {
    const content = `${r.url} ${r.title} ${r.description}`.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'');
    return tokens.filter(word => content.includes(word)).length >= Math.min(2,tokens.length);
  });
}
export function relevantDiscoveryEvidence(query, results) {
  // Discovery needs topical overlap across the FULL query, not a quoted identity.
  // This is only minimum source adequacy, never business qualification or absence.
  const generic = new Set(['the','and','for','with','near','me','best','local','find','search','business','businesses','official','website','websites','https','http','www','com','instagram','facebook','shop','shops','workshop','workshops','service','services']);
  const words = value => (String(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]{3,}/g) || [])
    .filter(word => !generic.has(word))
    .map(word => {
      // Bounded suffix folding: repairs/repair, detailing/detailer,
      // upholstery/upholsterer. Whole tokens avoid auto/automation matches.
      const singular = word.length >= 7 ? word.replace(/s$/, '') : word;
      return singular.length >= 7 ? singular.replace(/(?:ing|er|y)$/, '') : singular;
    });
  const tokens = [...new Set(words(query))];
  if (tokens.length < 2) return false;
  return results.some(result => {
    const content = new Set(words(`${result.url || ''} ${result.title || ''} ${result.description || ''}`));
    return tokens.filter(token => content.has(token)).length >= 2;
  });
}
// REST contract: https://docs.firecrawl.dev/agent-source-of-truth/curl#search
export async function firecrawlSearch(query, { apiKey = process.env.FIRECRAWL_API_KEY, request = providerHttp, signal } = {}) {
  if (!apiKey) fail('SEARCH_CONFIGURATION', 'Optional Firecrawl search needs configuration; no new paid provider was connected');
  const response = await request('https://api.firecrawl.dev/v2/search', { signal, method: 'POST', redirects: 0, maxBytes: 1000000, body: JSON.stringify({ query: text(query, 'Search query', 300), limit: 5, sources: [{ type: 'web' }], country: 'US' }), headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` } });
  if (response.status !== 200) fail('SEARCH_FAILED', 'Search provider request failed or authentication is unavailable');
  const data = JSON.parse(response.bytes.toString()); if (!data.success || !Array.isArray(data.data?.web)) fail('SEARCH_FAILED', 'Search provider returned an unsupported result');
  return { provider: 'firecrawl', status: 'completed', query, at: now(), results: normalizeSearchResults(data.data.web), creditsUsed: Number.isFinite(data.creditsUsed) ? data.creditsUsed : null };
}
export async function searchPublic(query, { directory, provider = 'guest_bing', intent = 'verify', signal } = {}) {
  text(query, 'Search query', 300);
  let result;
  if (provider === 'firecrawl') result = await firecrawlSearch(query, { signal });
  else {
    const observation = await inspectSource(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, { directory, signal });
    const results = normalizeSearchResults(observation.searchResults || []);
    if (observation.blocked || !results.length || intent !== 'discover' && !relevantSearchEvidence(query, results)) fail('SEARCH_BLOCKED', 'Guest search returned blocked, unrelated or inadequate evidence; report unknown, not website absence');
    result = { provider: 'guest_bing', status: 'completed', query, sourceId: observation.id, at: observation.inspectedAt, results, limitations: 'Public result snippets/DOM, not authoritative business facts. Exact identity and linked sites require separate inspection.' };
  }
  if (intent === 'discover' && !relevantDiscoveryEvidence(query, result.results)) fail('SEARCH_INADEQUATE', 'Search provider returned unusable discovery results; report source unknown, not business or website absence');
  result.intent = intent;
  await writeFile(path.join(directory, `search-${hash({ query, intent }).slice(0, 16)}.json`), JSON.stringify(result), { mode: 0o600 });
  return result;
}
