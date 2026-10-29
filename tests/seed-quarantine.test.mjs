import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { collectSeeds } from '../src/seed-source.mjs';

const discoveryMode = 'houston_local_radius_v1';
const recordPolicy = 'quarantine_v1';
const tools = JSON.parse(readFileSync(new URL('../tools/placeroot-runtime/tools-list.json', import.meta.url))).tools;
const sha = value => createHash('sha256').update(value).digest('hex');
const annotation = { dataset: 'Overture', provider: 'overture', resource: 'unsupported-fixture' };

function fixture({ detail = v => v, result = v => v, sink } = {}) {
  const calls = [], events = [], rows = new Map();
  let closed = false, connected = 0, detailIndex = 0;
  const recordSourceEvent = async event => {
    events.push(JSON.parse(JSON.stringify(event)));
    if (sink) return sink(event);
    const bytes = JSON.stringify(event.value);
    return { phase: event.phase, callIndex: event.callIndex, tool: event.tool, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) };
  };
  const connector = async () => {
    connected++;
    return {
      listTools: async () => ({ tools }),
      close: async () => { closed = true; },
      callTool: async request => {
        calls.push(request);
        if (events.length) {
          assert.equal(events.at(-1)?.phase, 'request');
          assert.deepEqual(events.at(-1).value, request);
        }
        const { name, arguments: args } = request;
        let value;
        if (name === 'data_version') value = { release: '2026-09-23.1', source: 'fixture' };
        else if (name === 'search_categories') value = { results: [{ slug: args.query.replaceAll(' ', '_') }] };
        else if (name === 'find_places') {
          value = { results: Array.from({ length: args.limit }, (_, i) => {
            const row = { id: `fictional-${args.category}-${i}`, name: 'Fictional workshop', category: args.category, lat: args.lat, lon: args.lon, distance_m: i };
            rows.set(row.id, { ...row, sources: [{ dataset: 'meta', record_id: row.id, license: 'CDLA-Permissive-2.0' }], websites: [], socials: [] });
            return row;
          }) };
        } else if (name === 'place_details') value = await detail(structuredClone(rows.get(args.id)), ++detailIndex);
        else throw Error('Unexpected tool');
        return result({ content: [{ type: 'text', text: JSON.stringify(value) }] }, name);
      },
    };
  };
  return { calls, events, connector, recordSourceEvent, get closed() { return closed; }, get connected() { return connected; } };
}
const collect = (f, options = {}) => collectSeeds({ discoveryMode, recordPolicy, connector: f.connector, recordSourceEvent: f.recordSourceEvent, ...options });
const summary = f => f.events.find(e => e.phase === 'summary')?.value;

test('quarantines only the unsupported fourth record within the original twenty fixed slots', async () => {
  const f = fixture({ detail: (v, i) => i === 4 ? { ...v, sources: [...v.sources, annotation] } : v });
  const source = await collect(f);
  const admission = source.version.discovery.admissionSummary;
  assert.deepEqual({ ...admission, records: [] }, { schemaVersion: 1, sampled: 20, attempted: 20, admitted: 19, quarantined: 1, records: [] });
  assert.deepEqual(summary(f), admission);
  assert.equal(source.items.length, 19);
  assert.equal(f.calls.length, 27);
  assert.equal(new Set(f.calls.filter(c => c.name === 'place_details').map(c => c.arguments.id)).size, 20);
  assert.deepEqual(f.calls.filter(c => c.name === 'find_places').map(c => c.arguments.limit), [7, 7, 6]);
  assert.ok(f.calls.filter(c => c.name === 'find_places').every(c => c.arguments.radius_m === 15000 && !('cursor' in c.arguments)));
  const rejected = admission.records[3];
  assert.deepEqual(rejected, { sampleIndex: 3, sourceId: 'fictional-auto_detailing-3', callIndex: 11,
    responseSha256: sha(JSON.stringify(f.events.find(e => e.phase === 'response' && e.callIndex === 11).value)),
    outcome: 'quarantined', code: 'SEED_SOURCE_PROVENANCE', field: 'source_annotation' });
  for (const item of source.items) assert.deepEqual(item.provenance.sources, [{ dataset: 'meta', record_id: item.id, license: 'CDLA-Permissive-2.0' }]);
  assert.equal(f.events.filter(e => e.phase === 'request').length, 27);
  assert.equal(f.events.filter(e => e.phase === 'response').length, 27);
  assert.equal(f.closed, true);
});

test('all quarantined retains twenty receipts and a summary, fails EMPTY, and never refills', async () => {
  const f = fixture({ detail: v => ({ ...v, sources: [annotation] }) });
  await assert.rejects(collect(f), { code: 'SEED_SOURCE_EMPTY' });
  assert.deepEqual({ ...summary(f), records: [] }, { schemaVersion: 1, sampled: 20, attempted: 20, admitted: 0, quarantined: 20, records: [] });
  assert.equal(summary(f).records.length, 20);
  assert.equal(f.calls.length, 27);
  assert.equal(f.events.filter(e => e.phase === 'summary').length, 1);
  assert.equal(f.closed, true);
});

for (const [label, sources, code, field] of [
  ['missing origin', [], 'SEED_SOURCE_PROVENANCE', 'origin_missing'],
  ['origin ID', [{ dataset: 'meta', record_id: null }], 'SEED_SOURCE_PROVENANCE', 'origin_record_id'],
  ['unknown licence', [{ dataset: 'unknown', record_id: 'fictional' }], 'SEED_SOURCE_LICENSE_UNKNOWN', 'source_license'],
  ['contradictory licence', [{ dataset: 'meta', record_id: 'fictional', license: 'CC0-1.0' }], 'SEED_SOURCE_LICENSE_UNKNOWN', 'source_license'],
]) test(`quarantines finite ${label} without admitting it`, async () => {
  const f = fixture({ detail: (v, i) => i === 1 ? { ...v, sources } : v });
  const source = await collect(f);
  assert.equal(source.items.length, 19);
  assert.equal(summary(f).records[0].code, code);
  assert.equal(summary(f).records[0].field, field);
});

for (const [label, change, code] of [
  ['unsafe URL', { websites: ['http://127.0.0.1/'] }, 'SEED_SOURCE_URL'],
  ['identity', { id: 'fictional-other' }, 'SEED_SOURCE_IDENTITY'],
  ['coordinate', { lat: 91 }, 'SEED_SOURCE_PROVENANCE'],
  ['truncation', { truncated: true }, 'SEED_SOURCE_INCOMPLETE'],
  ['omission', { sources_omitted_count: 1 }, 'SEED_SOURCE_INCOMPLETE'],
  ['degraded fields', { degraded_fields: ['sources'] }, 'SEED_SOURCE_INCOMPLETE'],
  ['unsafe key', { credential: 'fictional-forbidden' }, 'SEED_SOURCE_PROVENANCE'],
  ['unclassified source shape', { sources: [{ record_id: 'fictional' }] }, 'SEED_SOURCE_PROVENANCE'],
  ['unclassified provenance', { name: '' }, 'SEED_SOURCE_PROVENANCE'],
]) test(`late ${label} stays fatal and retains only the completed admission prefix`, async () => {
  const f = fixture({ detail: (v, i) => i === 4 ? { ...v, ...change } : v });
  await assert.rejects(collect(f), { code });
  assert.equal(f.calls.length, 11);
  assert.equal(summary(f).sampled, 20);
  assert.equal(summary(f).attempted, 4);
  assert.equal(summary(f).admitted, 3);
  assert.equal(summary(f).quarantined, 0);
  assert.equal(summary(f).records.length, 3);
  assert.equal(f.events.filter(e => e.phase === 'response' && e.callIndex === 11).length, 1);
  assert.equal(f.closed, true);
});

test('retains a parsed MCP result before semantic payload validation fails', async () => {
  const f = fixture({ result: (v, name) => name === 'place_details' ? { content: [{ type: 'text', text: 'not-json-fictional' }] } : v });
  await assert.rejects(collect(f), { code: 'SEED_SOURCE_PROTOCOL' });
  assert.deepEqual(f.events.find(e => e.phase === 'response' && e.callIndex === 8).value, { content: [{ type: 'text', text: 'not-json-fictional' }] });
  assert.equal(f.calls.length, 8);
});

test('structured MCP results are represented in the response hash, not claimed as wire bytes', async () => {
  const f = fixture({ result: v => ({ structuredContent: JSON.parse(v.content[0].text) }) });
  const source = await collect(f);
  const response = f.events.find(e => e.phase === 'response' && e.callIndex === 8);
  assert.equal(source.version.discovery.admissionSummary.records[0].responseSha256, sha(JSON.stringify(response.value)));
});

test('policy preserves exact supported annotations and property-attributing origins without weakening conversion', async () => {
  const derived = { property: '/properties/confidence', dataset: 'Overture', license: 'CDLA-Permissive-2.0', record_id: null,
    update_time: '2026-08-12T13:14:15Z', confidence: null, between: null, provider: 'overture', resource: 'confidence_calculation', version: '2026-08-12' };
  const f = fixture({ detail: v => ({ ...v, sources: [{ ...v.sources[0], property: '/properties/phones' }, derived] }) });
  const source = await collect(f);
  assert.equal(summary(f).admitted, 20);
  assert.equal(summary(f).quarantined, 0);
  for (const item of source.items) {
    assert.deepEqual(item.provenance.sources, [{ dataset: 'meta', record_id: item.id, license: 'CDLA-Permissive-2.0', property: '/properties/phones' }, derived]);
    assert.equal(item.provenance.licenses[0].kind, undefined);
    assert.equal(item.provenance.licenses[1].kind, 'derived_annotation');
    assert.equal(item.qualified, undefined);
  }
  assert.ok(summary(f).records.every(r => Object.keys(r).sort().join(',') === 'callIndex,outcome,responseSha256,sampleIndex,sourceId' && r.outcome === 'admitted'));
});

test('rejects unknown policies, non-local policies and missing sinks before connecting', async () => {
  for (const options of [{ recordPolicy: 'other' }, { discoveryMode: undefined }, { recordSourceEvent: undefined }]) {
    const f = fixture();
    await assert.rejects(collect(f, options), /SEED_SOURCE_(?:MODE|CAPTURE)/);
    assert.equal(f.connected, 0);
  }
});

for (const [label, alter] of [
  ['missing descriptor', () => undefined],
  ['wrong hash', d => ({ ...d, sha256: '0'.repeat(64) })],
  ['wrong byte count', d => ({ ...d, bytes: d.bytes + 1 })],
  ['unsafe byte count', d => ({ ...d, bytes: Number.MAX_SAFE_INTEGER + 1 })],
  ['wrong binding', d => ({ ...d, callIndex: 2 })],
  ['extra fields', d => ({ ...d, path: '/private/fixture' })],
]) test(`invalid request sink ${label} prevents the source call`, async () => {
  const f = fixture({ sink: event => {
    const bytes = JSON.stringify(event.value);
    return alter({ phase: event.phase, callIndex: event.callIndex, tool: event.tool, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) });
  } });
  await assert.rejects(collect(f), { code: 'SEED_SOURCE_CAPTURE' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.events.length, 1);
  assert.equal(f.closed, true);
});

test('response sink failure prevents the next source call and is never quarantined', async () => {
  const f = fixture({ sink: event => {
    if (event.phase === 'response') throw Error('private sink failure');
    const bytes = JSON.stringify(event.value);
    return { phase: event.phase, callIndex: event.callIndex, tool: event.tool, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) };
  } });
  await assert.rejects(collect(f), e => e.code === 'SEED_SOURCE_CAPTURE' && !e.message.includes('private'));
  assert.equal(f.calls.length, 1);
  assert.equal(f.events.length, 2);
});

test('a hanging sink is bounded and prevents the native call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ sink: () => { entered(); return new Promise(() => {}); } });
  const pending = collect(f);
  const rejected = assert.rejects(pending, /SEED_SOURCE_(?:TIMEOUT|ABORTED|CAPTURE)/);
  await started;
  t.mock.timers.tick(120000);
  await rejected;
  assert.equal(f.calls.length, 0);
  assert.equal(f.closed, true);
});

test('provider exceptions cannot spoof a recoverable private field and failure events contain only a finite code', async () => {
  const f = fixture({ detail: () => { throw Object.assign(Error('private raw body'), { code: 'SEED_SOURCE_PROVENANCE', diagnostic: { field: 'source_annotation' } }); } });
  await assert.rejects(collect(f), { code: 'SEED_SOURCE_UNAVAILABLE' });
  assert.deepEqual(f.events.find(e => e.phase === 'failure').value, { code: 'SEED_SOURCE_UNAVAILABLE' });
  assert.equal(f.calls.length, 8);
  assert.equal(summary(f).attempted, 1);
  assert.equal(summary(f).records.length, 0);
});

test('without record policy the local collector remains fail-fast and never invokes the sink', async () => {
  let calls = 0, sinkCalls = 0;
  const connector = async () => ({ listTools: async () => ({ tools }), close: async () => {}, callTool: async ({ name, arguments: args }) => {
    calls++;
    const value = name === 'data_version' ? { release: '2026-09-23.1', source: 'fixture' }
      : name === 'search_categories' ? { results: [{ slug: 'bakery' }] }
      : name === 'find_places' ? { results: [{ id: 'fictional', name: 'Fictional', category: 'bakery', lat: 29.7, lon: -95.3, distance_m: 1 }] }
      : { id: args.id, name: 'Fictional', category: 'bakery', lat: 29.7, lon: -95.3, sources: [annotation] };
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  } });
  await assert.rejects(collectSeeds({ discoveryMode, connector, recordSourceEvent: () => { sinkCalls++; } }), { code: 'SEED_SOURCE_PROVENANCE' });
  assert.equal(calls, 8);
  assert.equal(sinkCalls, 0);
});

test('unsupported sources cannot mask a later non-source structural error', async () => {
  const f = fixture({ detail: (v, i) => i === 4 ? { ...v, sources: [annotation], websites: {} } : v });
  await assert.rejects(collect(f), { code: 'SEED_SOURCE_PROVENANCE' });
  assert.equal(summary(f).quarantined, 0);
  assert.equal(f.calls.length, 11);
});

test('oversized MCP result retains a finite failure, never a partial response', async () => {
  const f = fixture({ result: (v, name) => name === 'place_details' ? { content: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] } : v });
  await assert.rejects(collect(f), { code: 'SEED_SOURCE_RESPONSE_BOUND' });
  assert.deepEqual(f.events.find(e => e.phase === 'failure').value, { code: 'SEED_SOURCE_RESPONSE_BOUND' });
  assert.equal(f.events.filter(e => e.phase === 'response' && e.callIndex === 8).length, 0);
  assert.equal(f.calls.length, 8);
});

test('summary persistence failure cannot return a usable cohort', async () => {
  const f = fixture({ sink: event => {
    if (event.phase === 'summary') throw Error('private summary failure');
    const bytes = JSON.stringify(event.value);
    return { phase: event.phase, callIndex: event.callIndex, tool: event.tool, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) };
  } });
  await assert.rejects(collect(f), { code: 'SEED_SOURCE_CAPTURE' });
  assert.equal(f.calls.length, 27);
  assert.equal(f.events.filter(e => e.phase === 'summary').length, 1);
});

test('sink cannot mutate the event binding and forge a matching descriptor', async () => {
  const f = fixture({ sink: event => {
    event.callIndex = 2;
    const bytes = JSON.stringify(event.value);
    return { phase: event.phase, callIndex: event.callIndex, tool: event.tool, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) };
  } });
  await assert.rejects(collect(f), { code: 'SEED_SOURCE_CAPTURE' });
  assert.equal(f.calls.length, 0);
});

test('cancellation during request capture closes without a native call or subsequent capture', async t => {
  const controller = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ sink: () => { entered(); return new Promise(() => {}); } });
  const pending = collect(f, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'SEED_SOURCE_ABORTED' });
  await started;
  controller.abort();
  await rejected;
  assert.equal(f.calls.length, 0);
  assert.equal(f.events.length, 1);
  assert.equal(f.closed, true);
});

test('capture time shares the original ten-minute total budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waits = [];
  const f = fixture({ sink: event => new Promise(resolve => {
    const bytes = JSON.stringify(event.value);
    waits.push(() => resolve({ phase: event.phase, callIndex: event.callIndex, tool: event.tool, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) }));
  }) });
  const pending = collect(f);
  const rejected = assert.rejects(pending, { code: 'SEED_SOURCE_ABORTED' });
  for (let i = 0; i < 5; i++) {
    for (let step = 0; !waits.length && step < 200; step++) await Promise.resolve();
    assert.equal(waits.length, 1);
    t.mock.timers.tick(119000);
    waits.shift()();
  }
  for (let step = 0; !waits.length && step < 200; step++) await Promise.resolve();
  assert.equal(waits.length, 1);
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(f.calls.length, 3);
  assert.equal(f.closed, true);
});
