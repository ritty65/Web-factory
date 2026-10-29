import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { publicUrl, FactoryError } from './contracts.mjs';
import { inspectBoundaryCache } from './boundary-source.mjs';

const ROOT = fileURLToPath(new URL('../tools/placeroot-runtime/', import.meta.url));
const TOOLS = ['data_version', 'search_categories', 'geocode', 'find_places', 'place_details'];
const MAX_BYTES = 1024 * 1024;
const LOCAL_MODE = 'houston_local_radius_v1';
const LOCAL_POINT = { lat: 29.75893783569336, lon: -95.3676986694336, radius_m: 15000 };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const FAILURE_FIELD = Symbol('sourceFailureField');
const FAILURE_FIELDS = new Set(['origin_record_id', 'source_license', 'source_annotation', 'origin_missing', 'unspecified']);
const SOURCE_CODES = new Set(['PROCESS', 'RESPONSE_BOUND', 'REQUEST_BOUND', 'PROTOCOL', 'SCHEMA', 'ABORTED', 'PROVENANCE', 'INCOMPLETE', 'URL', 'LICENSE_UNKNOWN', 'IDENTITY', 'TIMEOUT', 'CALL_LIMIT', 'VERSION', 'CATEGORY', 'AREA', 'EMPTY', 'UNAVAILABLE', 'BOUNDARY_NOT_READY', 'BOUNDARY_STALE', 'PAGINATION', 'MODE', 'CAPTURE'].map(code => `SEED_SOURCE_${code}`));
const error = (code, field = 'unspecified') => Object.assign(new FactoryError(`SEED_SOURCE_${code}`, `SEED_SOURCE_${code}: source unavailable, unsafe or incomplete; no retry performed.`), { [FAILURE_FIELD]: field });
const sourceFailure = e => e instanceof FactoryError && SOURCE_CODES.has(e.code) ? e : error('UNAVAILABLE');
const ARGUMENTS = {
  data_version: {}, search_categories: { query: 'string', limit: 'integer' },
  geocode: { query: 'string', country: 'string', limit: 'integer' },
  find_places: { area: 'string', category: 'string', has_website: 'boolean', limit: 'integer', detail: 'string', confirm: 'boolean' },
  place_details: { id: 'string', near_lat: 'number', near_lon: 'number' },
};
function validateTools(listed, local = false) {
  if (listed.nextCursor || !Array.isArray(listed.tools)) throw error('SCHEMA');
  for (const name of TOOLS) {
    const matches = listed.tools.filter(t => t.name === name);
    if (matches.length !== 1 || matches[0].inputSchema?.type !== 'object') throw error('SCHEMA');
    const schema = matches[0].inputSchema;
    const args = local && name === 'find_places' ? { ...ARGUMENTS[name], lat: 'number', lon: 'number', radius_m: 'number' } : ARGUMENTS[name];
    for (const [key, type] of Object.entries(args)) {
      const property = schema.properties?.[key];
      if (!property || !(property.type === type || property.anyOf?.some(p => p.type === type))) throw error('SCHEMA');
    }
    if (schema.required?.some(key => !(key in args))) throw error('SCHEMA');
  }
}

// A narrow MCP stdio Transport for the official Client. Bound bytes BEFORE JSON
// parsing (the stock transport has no configurable incoming-line byte ceiling).
export class BoundedStdioTransport {
  constructor({ command, args, env, cwd = ROOT }) { this.options = { command, args, env, cwd }; }
  async start() {
    if (this.child || this.closing) throw error('PROCESS');
    const { command, args, env, cwd } = this.options;
    this.child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    this.buffer = Buffer.alloc(0);
    this.child.on('error', () => this.onerror?.(error('PROCESS')));
    // 'close', unlike 'exit', also occurs after ENOENT spawn failures and
    // confirms owned stdio has closed. Create this promise before any event.
    this.reaped = new Promise(resolve => this.child.once('close', () => {
      this.closed = true;
      this.onclose?.();
      resolve();
    }));
    this.child.stdin.on('error', () => this.onerror?.(error('PROCESS')));
    this.child.stdout.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let newline;
      while ((newline = this.buffer.indexOf(10)) !== -1) {
        if (newline > MAX_BYTES) return this.rejectInput();
        const line = this.buffer.subarray(0, newline); this.buffer = this.buffer.subarray(newline + 1);
        try { if (line.length) this.onmessage?.(JSON.parse(line.toString('utf8'))); }
        catch { return this.rejectInput(); }
      }
      if (this.buffer.length > MAX_BYTES) this.rejectInput();
    });
  }
  rejectInput() { this.onerror?.(error('RESPONSE_BOUND')); void this.close(); }
  async send(message) {
    const bytes = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw error('REQUEST_BOUND');
    await new Promise((resolve, reject) => this.child.stdin.write(bytes, e => e ? reject(error('PROCESS')) : resolve()));
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const child = this.child;
      if (!child || this.closed) return;
      let timer;
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.kill('SIGTERM');
      }
      try { await this.reaped; } finally { clearTimeout(timer); }
    })();
    return this.closing;
  }
}

export function runtimeEnvironment() {
  return {
    HOME: join(ROOT, 'home'), XDG_CACHE_HOME: join(ROOT, 'cache'), XDG_CONFIG_HOME: join(ROOT, 'config'),
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LOGNAME: 'placeroot', USER: 'placeroot', SHELL: '/bin/false', TERM: 'dumb',
    TMPDIR: join(ROOT, 'tmp'), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    PLACEROOT_TOOLS: TOOLS.join(','), PLACEROOT_AUTOWARM: 'off', PLACEROOT_RECREATION_LAYER: '0', PLACEROOT_NATIVE: '0',
    PLACEROOT_CACHE_DIR: join(ROOT, 'cache'), PLACEROOT_DUCKDB_EXTENSION_DIR: join(ROOT, 'extensions'),
    PLACEROOT_DUCKDB_MEMORY_LIMIT: '512MB', PLACEROOT_DUCKDB_THREADS: '4', PLACEROOT_DUCKDB_CURSORS: '1',
    PLACEROOT_CACHE_MAX_MB: '128', PLACEROOT_CACHE_DIVISIONS_MAX_MB: '32', PLACEROOT_HTTP_TIMEOUT_S: '15', PLACEROOT_TOKEN_BUDGET: '16000',
  };
}

async function connect({ signal } = {}) {
  for (const dir of ['home', 'cache', 'config', 'tmp', 'extensions']) await mkdir(join(ROOT, dir), { recursive: true });
  const client = new Client({ name: 'factory-seed-source', version: '1.0.0' });
  const transport = new BoundedStdioTransport({ command: join(ROOT, '.venv/bin/python'), args: ['-I', '-S', '-B', join(ROOT, 'server.py')], env: runtimeEnvironment() });
  const abort = () => { void transport.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  try { await client.connect(transport, { timeout: 20_000, signal }); }
  catch { signal?.removeEventListener('abort', abort); await transport.close(); throw error('PROTOCOL'); }
  return { listTools: () => client.listTools({}, { timeout: 20_000, signal }), callTool: (request) => client.callTool(request, undefined, { timeout: 120_000, signal }), close: async () => { signal?.removeEventListener('abort', abort); await client.close(); await transport.close(); } };
}

export async function preflightSource({ connector = connect, signal } = {}) {
  if (signal?.aborted) throw error('ABORTED');
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  let connection;
  try {
    connection = await bounded(() => connector({ signal: controller.signal }), controller.signal, 20_000);
    const listed = await bounded(() => connection.listTools(), controller.signal, 20_000);
    validateTools(listed);
    return { provider: 'placeroot', packageVersion: '0.12.0', tools: listed.tools };
  } finally { controller.abort(); signal?.removeEventListener('abort', abort); if (connection) await connection.close(); }
}

function complete(value, depth = 0) {
  if (depth > 12) throw error('PROVENANCE');
  if (typeof value === 'string') {
    if (value.length > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw error('PROVENANCE');
    for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
      try { publicUrl(match[0]); } catch { throw error('URL'); }
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/__proto__|constructor|prototype|password|secret|credential|authorization|api[_-]?key/i.test(key)) throw error('PROVENANCE');
    if ((/omitted_count$/.test(key) && item !== 0) || (['truncated', 'partial', 'error', 'requires_confirmation'].includes(key) && item) || key === 'degraded_fields' && item?.length) throw error('INCOMPLETE');
    complete(item, depth + 1);
  }
}
function payload(result, locator) {
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES || result?.isError) throw error('RESPONSE_BOUND');
  let value = result?.structuredContent;
  if (!value) {
    if (result?.content?.length !== 1 || result.content[0].type !== 'text') throw error('PROTOCOL');
    try { value = JSON.parse(result.content[0].text); } catch { throw error('PROTOCOL'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('PROTOCOL');
  if (locator) return locatorPage(value, result, locator);
  complete(value); return value;
}

// Native 0.12.0 cursor.py hashes Python json.dumps(sort_keys=True), whose
// separators include spaces and whose normalized radius is the float 15000.0.
// server.py:903-918 defines the full query identity (limit/detail excluded).
function localQueryHash(category) {
  const params = { area: null, brand: null, categories: null, category, division_id: null, has_phone: null,
    has_website: false, lat: LOCAL_POINT.lat, lon: LOCAL_POINT.lon, min_confidence: null, name: null,
    operating_status: null, radius_m: LOCAL_POINT.radius_m, within: null };
  const canonical = '{' + Object.keys(params).sort().map(key => `${JSON.stringify(key)}: ${key === 'radius_m' ? '15000.0' : JSON.stringify(params[key])}`).join(', ') + '}';
  return sha256(canonical).slice(0, 12);
}

function locatorPage(value, result, { request, version, pages }) {
  const rows = value.results;
  if (!Array.isArray(rows) || rows.length > request.limit) throw error('PROVENANCE');
  const ids = new Set(); let previous;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw error('PROVENANCE');
    requiredString(row.id, 200); requiredString(row.name); requiredString(row.category); coordinates(row);
    if (!Number.isInteger(row.distance_m) || row.distance_m < 0 || row.distance_m > LOCAL_POINT.radius_m || ids.has(row.id)) throw error('PROVENANCE');
    // Native overture.py orders by rounded distance_m, then id, before LIMIT.
    if (previous && (row.distance_m < previous.distance_m || row.distance_m === previous.distance_m && row.id <= previous.id)) throw error('PROVENANCE');
    ids.add(row.id); previous = row;
  }
  const moreAvailable = value.truncated === true;
  let cursorHash = null;
  if (moreAvailable) {
    // A short page could instead be budget-trimmed. Accept only a full native
    // bounded window, with every locator field still present and complete.
    if (!rows.length || rows.length !== request.limit || typeof value.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(value.cursor)) throw error('PAGINATION');
    let decoded;
    try { decoded = JSON.parse(Buffer.from(value.cursor, 'base64url').toString('utf8')); } catch { throw error('PAGINATION'); }
    if (!decoded || Object.keys(decoded).sort().join(',') !== 'o,q,r' || decoded.q !== localQueryHash(request.category) || decoded.r !== version.release || decoded.o !== rows.length || !Number.isSafeInteger(decoded.o)) throw error('PAGINATION');
    cursorHash = sha256(value.cursor);
  } else if (value.cursor !== undefined) throw error('PAGINATION');
  const normalized = { ...value };
  if (moreAvailable) { delete normalized.truncated; delete normalized.cursor; }
  // Only verified top-level pagination is normalized. All omission/degradation,
  // nested truncation, errors, URLs and detail completeness remain fail-closed.
  complete(normalized);
  const raw = result.structuredContent ? JSON.stringify(result.structuredContent) : result.content[0].text;
  pages.push({ request: { ...request }, version: { ...version }, rawSha256: sha256(raw),
    rawEncoding: result.structuredContent ? 'structuredContent-json' : 'text-utf8', normalizedSha256: sha256(JSON.stringify(normalized)),
    cursorHash, count: rows.length, moreAvailable, offset: 0, order: 'distance_m,id' });
  return normalized;
}
function requiredString(value, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw error('PROVENANCE');
  return value;
}
function coordinates(row) {
  if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon) || Math.abs(row.lat) > 90 || Math.abs(row.lon) > 180) throw error('PROVENANCE');
}
const CDLA = new Set(['meta', 'microsoft', 'birdeye', 'brightquery', 'dac', 'krick', 'opentravel', 'pinmeto', 'renderseo', 'uberall']);
const SOURCE_NOTICE = 'https://docs.overturemaps.org/guides/places/#sources-and-licensing';
function calendarDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function license(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw error('PROVENANCE', 'source_annotation');
  // The observed Overture property annotation is not an entity-origin record.
  // Preserve it verbatim, but admit only this exact derived-confidence signature.
  // Primary schema: https://docs.overturemaps.org/schema/v1.18.0/reference/places/place
  if (source.dataset === 'Overture' || source.provider === 'overture' || source.resource === 'confidence_calculation') {
    if (source.dataset !== 'Overture' || source.property !== '/properties/confidence' || source.provider !== 'overture' ||
        source.resource !== 'confidence_calculation' || source.license !== 'CDLA-Permissive-2.0' ||
        source.record_id !== null || source.confidence !== null || source.between !== null || !calendarDate(source.version) ||
        typeof source.update_time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(source.update_time) ||
        !calendarDate(source.update_time.slice(0, 10)) || !Number.isFinite(Date.parse(source.update_time))) throw error('PROVENANCE', 'source_annotation');
    return { dataset: source.dataset, license: source.license, notice: SOURCE_NOTICE, kind: 'derived_annotation' };
  }
  const dataset = requiredString(source.dataset, 100);
  if (typeof source.record_id !== 'string' || !source.record_id.trim() || source.record_id.length > 1000) throw error('PROVENANCE', 'origin_record_id');
  const key = dataset.toLowerCase();
  const value = key === 'foursquare' ? 'Apache-2.0' : key === 'alltheplaces' ? 'CC0-1.0' : CDLA.has(key) ? 'CDLA-Permissive-2.0' : null;
  if (!value || source.license != null && source.license !== value) throw error('LICENSE_UNKNOWN', 'source_license');
  return { dataset, license: value, notice: SOURCE_NOTICE };
}
function itemFrom(row, expected, version, retrievedAt) {
  if (row.id !== expected.id) throw error('IDENTITY');
  coordinates(row);
  if (!Array.isArray(row.sources) || !row.sources.length) throw error('PROVENANCE', 'origin_missing');
  const licenses = row.sources.map(license);
  if (!licenses.some(entry => entry.kind !== 'derived_annotation')) throw error('PROVENANCE', 'origin_missing');
  const urls = {};
  for (const field of ['websites', 'socials']) {
    if (row[field] != null && !Array.isArray(row[field])) throw error('PROVENANCE');
    urls[field] = (row[field] || []).map(value => {
      try { publicUrl(value); return value; } catch { throw error('URL'); }
    });
  }
  return { id: requiredString(row.id, 200), name: requiredString(row.name),
    location: { lat: row.lat, lon: row.lon, addresses: row.addresses ?? null },
    categories: [requiredString(row.category), ...(row.basic_category ? [requiredString(row.basic_category)] : [])].filter((v, i, a) => a.indexOf(v) === i),
    urls, operatingStatus: row.operating_status ?? null, confidence: row.confidence ?? null, phones: row.phones ?? null,
    provenance: { dataset: 'Overture Maps places', release: version.release, retrievedAt, sources: row.sources, licenses } };
}
async function bounded(operation, signal, milliseconds) {
  if (signal?.aborted) throw error('ABORTED');
  let timer, abort;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(error('TIMEOUT')), milliseconds);
      abort = () => reject(error('ABORTED')); signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

// Settings are deliberately NOT used as source URLs, paths, SQL or tool names.
// Shared seed_prepare validates the exact approved saved preset before calling.
export async function collectSeeds({ settings, signal, connector = connect, boundary, boundaryCacheInspector = inspectBoundaryCache, discoveryMode, recordPolicy, recordSourceEvent } = {}) {
  if (signal?.aborted) throw error('ABORTED');
  if (discoveryMode !== undefined && discoveryMode !== LOCAL_MODE) throw error('MODE');
  const local = discoveryMode === LOCAL_MODE;
  if (recordPolicy !== undefined && (recordPolicy !== 'quarantine_v1' || !local)) throw error('MODE');
  const quarantine = recordPolicy === 'quarantine_v1';
  if (quarantine && typeof recordSourceEvent !== 'function') throw error('CAPTURE');
  const guardBoundary = () => {
    if (local) return;
    try { if (!boundary || !boundaryCacheInspector(boundary)?.ready) throw error('BOUNDARY_NOT_READY'); }
    catch { throw error('BOUNDARY_NOT_READY'); }
  };
  guardBoundary();
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  const total = setTimeout(abort, 600_000);
  let connection, calls = 0, details = 0, lastTool = 'unspecified';
  let captureHealthy = true, summaryEmitted = false, responseSha256;
  const admissionSummary = { schemaVersion: 1, sampled: 0, attempted: 0, admitted: 0, quarantined: 0, records: [] };
  const emit = async event => {
    if (!quarantine) return;
    try {
      // Hash the application-level value, not transport bytes. Bound before
      // handing it to the private sink; semantic payload validation follows.
      const json = JSON.stringify(event.value);
      const bytes = Buffer.byteLength(json);
      if (bytes > (event.phase === 'summary' ? 65536 : MAX_BYTES)) throw error('CAPTURE');
      const digest = sha256(json);
      // Do not let a sink change the request, provider result or summary it is
      // attesting. Its own copy must also keep the exact event binding/value.
      const captured = { ...event, value: JSON.parse(json) };
      const descriptor = await bounded(() => recordSourceEvent(captured), controller.signal, 120_000);
      if (!descriptor || Object.getPrototypeOf(descriptor) !== Object.prototype ||
          Object.keys(descriptor).sort().join(',') !== 'bytes,callIndex,phase,sha256,tool' ||
          descriptor.phase !== event.phase || descriptor.callIndex !== event.callIndex || descriptor.tool !== event.tool ||
          !Number.isSafeInteger(descriptor.callIndex) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes !== bytes ||
          !/^[a-f0-9]{64}$/.test(descriptor.sha256) || descriptor.sha256 !== digest ||
          captured.phase !== event.phase || captured.callIndex !== event.callIndex || captured.tool !== event.tool || JSON.stringify(captured.value) !== json) throw error('CAPTURE');
      return descriptor;
    } catch (e) {
      captureHealthy = false;
      throw e instanceof FactoryError && ['SEED_SOURCE_ABORTED', 'SEED_SOURCE_TIMEOUT'].includes(e.code) ? e : error('CAPTURE');
    }
  };
  const emitSummary = async () => {
    if (!quarantine || summaryEmitted || !captureHealthy) return;
    summaryEmitted = true;
    await emit({ phase: 'summary', callIndex: 0, tool: 'collection', value: admissionSummary });
  };
  try {
    connection = await bounded(() => connector({ signal: controller.signal }), controller.signal, 20_000);
    const listed = await bounded(() => connection.listTools(), controller.signal, 20_000);
    validateTools(listed, local);
    const call = async (name, args = {}, locator) => {
      if (!TOOLS.includes(name) || ++calls > (local ? 27 : 28) || name === 'place_details' && ++details > 20) throw error('CALL_LIMIT');
      const tool = listed.tools.find(t => t.name === name);
      if (tool.inputSchema.properties && Object.keys(args).some(key => !(key in tool.inputSchema.properties))) throw error('SCHEMA');
      lastTool = name;
      const request = { name, arguments: args };
      await emit({ phase: 'request', callIndex: calls, tool: name, value: request });
      if (quarantine && name === 'place_details') admissionSummary.attempted++;
      let result;
      try {
        result = await bounded(() => connection.callTool(request), controller.signal, 120_000);
        // No complete response exists for malformed/oversized transport input.
        if (quarantine && Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw error('RESPONSE_BOUND');
      } catch (e) {
        if (!quarantine) throw e;
        const failure = sourceFailure(e);
        await emit({ phase: 'failure', callIndex: calls, tool: name, value: { code: failure.code } });
        throw failure;
      }
      const descriptor = await emit({ phase: 'response', callIndex: calls, tool: name, value: result });
      responseSha256 = descriptor?.sha256;
      return payload(result, locator);
    };
    const version = await call('data_version');
    if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(version.release) || !version.source || version.stale || version.recreation_layer) throw error('VERSION');
    if (!local && version.release !== boundary.release) throw error('BOUNDARY_STALE');
    const discovery = local ? { mode: LOCAL_MODE, lat: LOCAL_POINT.lat, lon: LOCAL_POINT.lon, radiusM: LOCAL_POINT.radius_m, cityEligibility: 'unknown', pages: [] } : null;
    const categories = [];
    for (const query of ['auto detailing', 'bakery', 'event planning']) {
      const found = await call('search_categories', { query, limit: 3 });
      const slug = found.results?.[0]?.slug;
      if (typeof slug !== 'string' || !/^[a-z0-9_]+$/.test(slug)) throw error('CATEGORY');
      categories.push(slug);
    }
    const rows = new Map();
    let resolvedArea;
    for (const [index, category] of categories.entries()) {
      const limit = index === 2 ? 6 : 7;
      guardBoundary();
      const request = { ...(local ? LOCAL_POINT : { area: 'Houston, Texas' }), category, has_website: false, limit, detail: 'compact', confirm: false };
      const found = await call('find_places', request, local ? { request, version, pages: discovery.pages } : undefined);
      // The installed native area mode resolves the region-qualified name and
      // searches that division's polygon, rejecting ambiguity. Ancestor labels
      // can legitimately be empty; they are not business-locality proof.
      if (!local) {
        if (found.area?.name !== 'Houston' || typeof found.area.division_id !== 'string' || found.area.division_id !== boundary.divisionId || !Array.isArray(found.area.admin_context) || resolvedArea && found.area.division_id !== resolvedArea.division_id) throw error('AREA');
        resolvedArea ||= found.area;
      }
      if (!Array.isArray(found.results) || found.results.length > limit) throw error('PROVENANCE');
      for (const row of found.results) { requiredString(row.id, 200); coordinates(row); if (!rows.has(row.id) && rows.size < 20) rows.set(row.id, row); }
    }
    const retrievedAt = new Date().toISOString();
    const items = [];
    if (quarantine) admissionSummary.sampled = rows.size;
    for (const [sampleIndex, row] of [...rows.values()].entries()) {
      const detail = await call('place_details', { id: row.id, near_lat: row.lat, near_lon: row.lon });
      let item;
      if (quarantine) {
        // Validate non-source fields first so unsupported provenance cannot mask
        // identity, coordinate, URL or structural failures later in itemFrom.
        if (detail.id !== row.id) throw error('IDENTITY');
        coordinates(detail); requiredString(detail.id, 200); requiredString(detail.name); requiredString(detail.category);
        if (detail.basic_category) requiredString(detail.basic_category);
        for (const field of ['websites', 'socials']) {
          if (detail[field] != null && !Array.isArray(detail[field])) throw error('PROVENANCE');
          for (const url of detail[field] || []) { try { publicUrl(url); } catch { throw error('URL'); } }
        }
        const record = { sampleIndex, sourceId: row.id, callIndex: calls, responseSha256 };
        try { item = itemFrom(detail, row, version, retrievedAt); }
        catch (e) {
          const field = e?.[FAILURE_FIELD];
          if (!(e instanceof FactoryError && (e.code === 'SEED_SOURCE_PROVENANCE' && ['source_annotation', 'origin_record_id', 'origin_missing'].includes(field) || e.code === 'SEED_SOURCE_LICENSE_UNKNOWN' && field === 'source_license'))) throw e;
          admissionSummary.quarantined++;
          admissionSummary.records.push({ ...record, outcome: 'quarantined', code: e.code, field });
          continue;
        }
        admissionSummary.admitted++;
        admissionSummary.records.push({ ...record, outcome: 'admitted' });
      } else item = itemFrom(detail, row, version, retrievedAt);
      item.provenance.selection = local ? discovery : { areaQuery: 'Houston, Texas', resolvedArea };
      items.push(item);
    }
    if (quarantine) discovery.admissionSummary = admissionSummary;
    await emitSummary();
    if (!items.length) throw error('EMPTY');
    return { provider: 'placeroot', retrievedAt, version: { package: '0.12.0', release: version.release, resolution: version, ...(local ? { discovery } : {}) },
      attribution: ['Overture Maps Foundation, overturemaps.org', 'Per-record provider sources and licenses retained in provenance.', ...(local ? [] : ['Division-boundary selection: © OpenStreetMap contributors, Overture Maps Foundation; ODbL-1.0 (separate divisions theme).'])],
      limitations: ['Unverified discovery seeds, not qualification or first-party facts.', 'Missing website metadata is unknown, not absence. Confidence measures existence, not recent activity.', local ? 'Approximate local-radius discovery only; city eligibility unknown. Trust is not identity, activity or eligibility; fresh independent exact-business corroboration is required.' : 'Category mapping and division geometry require fresh exact-business corroboration.', 'Bounded sample; no continuation, replacement sweep, retry or completeness claim.'], items };
  } catch (e) {
    let failure = quarantine ? sourceFailure(e) : e instanceof FactoryError && e.code.startsWith('SEED_SOURCE_') ? e : error('UNAVAILABLE');
    try { await emitSummary(); } catch (captureError) { failure = sourceFailure(captureError); }
    failure.diagnostic = { tool: TOOLS.includes(lastTool) ? lastTool : 'unspecified', callIndex: Math.min(27, Math.max(0, calls)),
      field: FAILURE_FIELDS.has(failure[FAILURE_FIELD]) ? failure[FAILURE_FIELD] : 'unspecified' };
    throw failure;
  }
  finally { controller.abort(); clearTimeout(total); signal?.removeEventListener('abort', abort); if (connection) await connection.close(); }
}
