import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { collectSeeds } from '../src/seed-source.mjs';

const mode = 'houston_local_radius_v1';
const lat = 29.75893783569336, lon = -95.3676986694336;
const version = { release: '2026-09-23.1', source: 'pinned-fallback' };
const tools = JSON.parse(readFileSync(new URL('../tools/placeroot-runtime/tools-list.json', import.meta.url))).tools;
const sha = text => createHash('sha256').update(text).digest('hex');
// Matches installed cursor.py json.dumps(sort_keys=True), including float radius.
function queryHash(category) {
  return sha(`{"area": null, "brand": null, "categories": null, "category": "${category}", "division_id": null, "has_phone": null, "has_website": false, "lat": ${lat}, "lon": ${lon}, "min_confidence": null, "name": null, "operating_status": null, "radius_m": 15000.0, "within": null}`).slice(0, 12);
}
function cursor(category, count, change = {}) {
  return Buffer.from(JSON.stringify({ q: queryHash(category), r: version.release, o: count, ...change })).toString('base64url');
}
function fake(change = {}) {
  const calls = [], pages = [], records = new Map(); let closed = false;
  const connector = async () => ({
    listTools: async () => ({ tools }), close: async () => { closed = true; },
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      let value;
      if (name === 'data_version') value = { ...version };
      else if (name === 'search_categories') value = { results: [{ slug: { 'auto detailing': 'auto_detailing', bakery: 'bakery', 'event planning': 'event_planning' }[args.query] }] };
      else if (name === 'find_places') {
        const results = Array.from({ length: args.limit }, (_, i) => {
          const row = { id: `fictional-${args.category}-${i}`, name: 'Fictional workshop', category: args.category, lat, lon, distance_m: i * 10, trust: 'weak' };
          records.set(row.id, { ...row, sources: [{ dataset: 'Foursquare', record_id: row.id }], websites: ['https://example.org/'], socials: ['https://www.instagram.com/fictional_fixture/'] });
          return row;
        });
        value = { results, truncated: true, cursor: cursor(args.category, results.length) };
      } else if (name === 'place_details') value = { ...records.get(args.id) };
      else throw Error('No area/geocode or other tool permitted');
      value = await change[name]?.(value, args) ?? value;
      const text = JSON.stringify(value);
      if (name === 'find_places') pages.push({ text, request: args });
      return { content: [{ type: 'text', text }] };
    },
  });
  return { connector, calls, pages, get closed() { return closed; } };
}
const local = f => collectSeeds({ discoveryMode: mode, settings: { lat: 0, radiusM: 1, area: 'arbitrary ignored input' }, connector: f.connector, boundaryCacheInspector: () => { throw Error('Local must never inspect polygon'); } });

test('known originating provider may attribute a particular property without becoming an Overture annotation',async()=>{
  const f=fake({place_details:row=>{row.sources[0].property='/properties/phones';return row;}});
  const result=await local(f);assert.equal(result.items[0].provenance.sources[0].property,'/properties/phones');
  assert.equal(result.items[0].provenance.licenses[0].kind,undefined);
});

test('local mode uses only the fixed native point and 7/7/6 pages, retaining unknown eligibility and honest provenance', async () => {
  const f = fake(), result = await local(f);
  assert.equal(result.items.length, 20);
  assert.equal(f.calls.length, 27);
  assert.equal(f.calls.filter(c => c.name === 'place_details').length, 20);
  const queries = f.calls.filter(c => c.name === 'find_places');
  assert.deepEqual(queries.map(c => c.args.limit), [7, 7, 6]);
  for (const { args } of queries) assert.deepEqual(args, { lat, lon, radius_m: 15000, category: args.category, has_website: false, limit: args.limit, detail: 'compact', confirm: false });
  const discovery = result.version.discovery;
  assert.deepEqual({ ...discovery, pages: [] }, { mode, lat, lon, radiusM: 15000, cityEligibility: 'unknown', pages: [] });
  assert.equal(result.version.resolution.source, 'pinned-fallback');
  assert.equal(discovery.pages.length, 3);
  for (const [i, page] of discovery.pages.entries()) {
    assert.deepEqual(page.request, f.pages[i].request);
    assert.deepEqual(page.version, version);
    assert.equal(page.rawSha256, sha(f.pages[i].text));
    assert.equal(page.cursorHash, sha(JSON.parse(f.pages[i].text).cursor));
    assert.equal(page.count, [7, 7, 6][i]);
    assert.equal(page.moreAvailable, true);
    assert.equal(page.offset, 0);
    assert.equal(page.order, 'distance_m,id');
  }
  for (const item of result.items) {
    assert.deepEqual(item.provenance.selection, discovery);
    assert.equal(item.provenance.licenses[0].license, 'Apache-2.0');
    assert.deepEqual(item.urls.websites, ['https://example.org/']);
    assert.equal(item.qualified, undefined);
  }
  assert.equal(JSON.stringify(result).includes('"cursor"'), false);
  assert.match(result.limitations.join(' '), /approximate.*city eligibility unknown/i);
  assert.equal(f.closed, true);
});

test('unknown discovery modes fail before connection and default remains exact-boundary gated', async () => {
  let connections = 0;
  const connector = async () => { connections++; throw Error('Must not connect'); };
  await assert.rejects(collectSeeds({ discoveryMode: 'other', connector }), /SEED_SOURCE_MODE/);
  await assert.rejects(collectSeeds({ connector }), /SEED_SOURCE_BOUNDARY_NOT_READY/);
  assert.equal(connections, 0);
});

test('fictional cursor fixture matches the native spike query hash without adopting its records', () => {
  assert.equal(queryHash('auto_detailing'), '9171353d263d');
});

for (const [label, mutate] of [
  ['wrong query', (v, a) => ({ ...v, cursor: cursor(a.category, a.limit, { q: queryHash('other') }) })],
  ['wrong release', (v, a) => ({ ...v, cursor: cursor(a.category, a.limit, { r: '2026-01-01.0' }) })],
  ['wrong offset', (v, a) => ({ ...v, cursor: cursor(a.category, a.limit + 1) })],
  ['boolean offset', (v, a) => ({ ...v, cursor: cursor(a.category, a.limit, { o: true }) })],
  ['extra cursor fields', (v, a) => ({ ...v, cursor: cursor(a.category, a.limit, { extra: 'unexpected' }) })],
  ['malformed cursor', v => ({ ...v, cursor: 'not-base64-json' })],
  ['missing cursor', v => { delete v.cursor; return v; }],
  ['unexplained cursor', v => ({ ...v, truncated: false })],
  ['short paginated window', v => ({ ...v, results: v.results.slice(1) })],
  ['overfull window', v => ({ ...v, results: [...v.results, v.results[0]] })],
  ['missing ID', v => { delete v.results[0].id; return v; }],
  ['missing name', v => { delete v.results[0].name; return v; }],
  ['missing category', v => { delete v.results[0].category; return v; }],
  ['invalid coordinate', v => { v.results[0].lat = 91; return v; }],
  ['duplicate locator', v => { v.results[1] = v.results[0]; return v; }],
  ['out of order', v => { v.results.reverse(); return v; }],
  ['missing distance', v => { delete v.results[0].distance_m; return v; }],
  ['outside radius', v => { v.results.at(-1).distance_m = 15001; return v; }],
  ['wrong tied ID order', v => { v.results[0].distance_m = v.results[1].distance_m; [v.results[0], v.results[1]] = [v.results[1], v.results[0]]; return v; }],
  ['omitted locator field', v => ({ ...v, fields_omitted_count: 1 })],
  ['nested truncation', v => { v.results[0].truncated = true; return v; }],
  ['confirmation', v => ({ ...v, requires_confirmation: true })],
  ['error', v => ({ ...v, error: 'blocked' })],
]) test(`local locator rejects ${label} without details or retry`, async () => {
  const f = fake({ find_places: mutate });
  await assert.rejects(local(f), /SEED_SOURCE/);
  assert.equal(f.calls.filter(c => c.name === 'find_places').length, 1);
  assert.equal(f.calls.filter(c => c.name === 'place_details').length, 0);
  assert.equal(f.closed, true);
});

test('a complete short locator page needs no pagination normalization', async () => {
  const f = fake({ find_places: v => ({ results: v.results.slice(0, 1) }) });
  const result = await local(f);
  assert.equal(result.items.length, 3);
  assert.ok(result.version.discovery.pages.every(p => p.moreAvailable === false && p.count === 1 && p.cursorHash === null));
});

for (const [label, change] of [
  ['truncated detail', { truncated: true, cursor: cursor('bakery', 1) }],
  ['detail source omission', { sources_omitted_count: 1 }],
  ['missing detail sources', { sources: [] }],
  ['detail identity mismatch', { id: 'fictional-wrong' }],
  ['detail unsafe URL', { websites: ['http://127.0.0.1/'] }],
  ['detail unknown license', { sources: [{ dataset: 'unknown', record_id: 'fictional' }] }],
]) test(`local page exception never admits ${label}`, async () => {
  const f = fake({ place_details: v => ({ ...v, ...change }) });
  await assert.rejects(local(f), /SEED_SOURCE/);
  assert.equal(f.calls.filter(c => c.name === 'place_details').length, 1);
  assert.equal(f.closed, true);
});

test('non-locator pagination remains incomplete in local mode', async () => {
  const f = fake({ search_categories: v => ({ ...v, truncated: true, cursor: cursor('bakery', 1) }) });
  await assert.rejects(local(f), /SEED_SOURCE_INCOMPLETE/);
  assert.equal(f.calls.filter(c => c.name === 'find_places').length, 0);
});

test('local data calls still time out at 120 seconds and close without retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fake({ data_version: () => { entered(); return new Promise(() => {}); } });
  const pending = local(f);
  const rejected = assert.rejects(pending, /SEED_SOURCE_TIMEOUT/);
  await started;
  t.mock.timers.tick(119999);
  assert.equal(f.closed, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(f.calls.length, 1);
  assert.equal(f.closed, true);
});

test('local collection retains its ten-minute overall deadline across shorter data calls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waits = [];
  const f = fake(Object.fromEntries(['data_version', 'search_categories', 'find_places'].map(name => [name, value => new Promise(resolve => waits.push(() => resolve(value)))])));
  const pending = local(f);
  const rejected = assert.rejects(pending, /SEED_SOURCE_ABORTED/);
  for (let i = 0; i < 5; i++) {
    for (let step = 0; !waits.length && step < 100; step++) await Promise.resolve();
    assert.equal(waits.length, 1);
    t.mock.timers.tick(119000);
    waits.shift()();
  }
  for (let step = 0; !waits.length && step < 100; step++) await Promise.resolve();
  assert.equal(waits.length, 1);
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(f.calls.length, 6);
  assert.equal(f.closed, true);
});

const annotation = {
  property: '/properties/confidence', dataset: 'Overture', license: 'CDLA-Permissive-2.0', record_id: null,
  update_time: '2026-08-12T13:14:15Z', confidence: null, between: null,
  provider: 'overture', resource: 'confidence_calculation', version: '2026-08-12',
};
const origin = { property: '', dataset: 'meta', license: 'CDLA-Permissive-2.0', record_id: 'fictional-origin-record' };

test('retains a fictional origin and exact derived confidence annotation without inventing an origin ID', async () => {
  const sources = [origin, annotation];
  const f = fake({ place_details: v => ({ ...v, sources }) });
  const result = await local(f);
  for (const item of result.items) {
    assert.deepEqual(item.provenance.sources, sources);
    assert.deepEqual(item.provenance.licenses, [
      { dataset: 'meta', license: 'CDLA-Permissive-2.0', notice: 'https://docs.overturemaps.org/guides/places/#sources-and-licensing' },
      { dataset: 'Overture', license: 'CDLA-Permissive-2.0', notice: 'https://docs.overturemaps.org/guides/places/#sources-and-licensing', kind: 'derived_annotation' },
    ]);
    assert.equal(item.provenance.selection.cityEligibility, 'unknown');
    assert.equal(item.qualified, undefined);
  }
  assert.equal(f.calls.length, 27);
});

test('annotation dates are schema-validated rather than pinned to the observed release or each other', async () => {
  const changed = { ...annotation, version: '2025-12-31', update_time: '2026-02-02T00:00:00.000Z' };
  const result = await local(fake({ place_details: v => ({ ...v, sources: [changed, origin] }) }));
  assert.deepEqual(result.items[0].provenance.sources, [changed, origin]);
});

for (const [label, sources, field] of [
  ['origin null ID', [{ ...origin, record_id: null }, annotation], 'origin_record_id'],
  ['origin absent ID', [{ dataset: 'meta' }, annotation], 'origin_record_id'],
  ['origin empty ID', [{ ...origin, record_id: '  ' }, annotation], 'origin_record_id'],
  ['origin unknown license', [{ ...origin, dataset: 'unknown' }, annotation], 'source_license'],
  ['origin contradictory license', [{ ...origin, license: 'CC0-1.0' }, annotation], 'source_license'],
  ['annotation only', [annotation], 'origin_missing'],
  ['no sources', [], 'origin_missing'],
  ...Object.entries({ property: '/properties/name', dataset: 'meta', provider: 'other', resource: 'other', license: 'CC0-1.0', version: 'not-a-date', update_time: 'not-a-time', record_id: 'fictional-annotation-id', confidence: 1, between: [] })
    .map(([key, value]) => [`annotation wrong ${key}`, [origin, { ...annotation, [key]: value }], 'source_annotation']),
  ['annotation invalid calendar', [origin, { ...annotation, version: '2026-02-30' }], 'source_annotation'],
  ['annotation missing version', [origin, Object.fromEntries(Object.entries(annotation).filter(([key]) => key !== 'version'))], 'source_annotation'],
]) test(`fails closed on ${label} with a bounded sanitized detail diagnostic`, async () => {
  const f = fake({ place_details: v => ({ ...v, sources }) });
  await assert.rejects(local(f), e => {
    assert.match(e.code, /^SEED_SOURCE_/);
    assert.deepEqual(e.diagnostic, { tool: 'place_details', callIndex: 8, field });
    assert.equal(JSON.stringify(e.diagnostic).includes('fictional'), false);
    return true;
  });
  assert.equal(f.calls.length, 8);
  assert.equal(f.closed, true);
});

test('unexpected provider exceptions cannot supply raw diagnostic fields or escape the finite whitelist', async () => {
  const f = fake({ data_version: () => { throw Object.assign(Error('raw body https://example.org/ private SQL'), { diagnostic: { tool: 'unsafe', callIndex: 900, field: 'raw body' } }); } });
  await assert.rejects(local(f), e => {
    assert.equal(e.code, 'SEED_SOURCE_UNAVAILABLE');
    assert.deepEqual(e.diagnostic, { tool: 'data_version', callIndex: 1, field: 'unspecified' });
    assert.doesNotMatch(e.message + JSON.stringify(e.diagnostic), /raw body|example.org|SQL/);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test('pre-data connection failure uses the bounded no-tool diagnostic', async () => {
  await assert.rejects(collectSeeds({ discoveryMode: mode, connector: async () => { throw Error('raw provider body'); } }), e => {
    assert.deepEqual(e.diagnostic, { tool: 'unspecified', callIndex: 0, field: 'unspecified' });
    return true;
  });
});
