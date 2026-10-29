import http from 'node:http';
import { z } from 'zod';

const schema = z.object({ enabled: z.boolean().default(false) }).strict();
export const CAMOFOX_OPERATIONS = {
  camofox_status: {
    description: 'Explicit optional loopback Camofox service diagnostics only. Disabled by default; never opens pages or establishes guest-reader readiness, qualification or run authority.',
    schema,
    readOnly: true,
  },
};

const ORIGIN = 'http://127.0.0.1:9377';
const MAX_BYTES = 1024 * 1024;
const PATHS = new Set(['/health', '/openapi.json']);
const LIMITATIONS = [
  'Service diagnostics only; no page, launch or extraction test was performed.',
  'Guest isolation is unverified: persistence may restore state or import bootstrap cookies.',
  'Public-only egress, redirect and subresource isolation are not verified.',
  'Not source evidence, caption authorship, qualification, media rights or human acceptance.',
  'No measured speed, context-saving or stealth benefit; selected Firecrawl reader is unchanged.',
];
const fault = code => Object.assign(new Error('Camofox diagnostics unavailable'), { camofoxCode: code });

// This transport is intentionally separate from public safeFetch: numeric loopback
// is permitted ONLY for these two fixed diagnostics, never a caller-selected URL.
function defaultRequest(url, { signal, maxBytes }) {
  const target = new URL(url);
  if (target.origin !== ORIGIN || !PATHS.has(target.pathname) || target.search || target.hash || target.username || target.password) {
    return Promise.reject(fault('CAMOFOX_INPUT'));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 9377, path: target.pathname, method: 'GET', headers: { accept: 'application/json' }, agent: false, signal }, res => {
      // Never follow Location, consume error bodies, or expose remote messages.
      if (res.statusCode !== 200) {
        resolve({ status: res.statusCode, bytes: Buffer.alloc(0) });
        res.destroy();
        return;
      }
      let size = 0;
      const chunks = [];
      res.on('error', reject);
      res.on('aborted', () => reject(fault('CAMOFOX_UNAVAILABLE')));
      res.on('data', chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) {
          reject(fault('CAMOFOX_RESPONSE_LIMIT'));
          res.destroy(); req.destroy();
        } else chunks.push(bytes);
      });
      res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Own the timeout as well as passing a signal: even an injected transport that
// ignores cancellation cannot leave this public operation pending indefinitely.
function boundedRequest(request, pathname, signal, deadline) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = Math.max(1, Math.min(2500, deadline - Date.now()));
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) { controller.abort(); reject(error); } else resolve(value);
    };
    const cancel = () => finish(fault('CAMOFOX_CANCELLED'));
    const timer = setTimeout(() => finish(fault('CAMOFOX_TIMEOUT')), timeout);
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => {
      if (settled) return;
      return request(ORIGIN + pathname, { method: 'GET', redirect: 'error', signal: controller.signal, timeout, maxBytes: MAX_BYTES });
    }).then(value => finish(null, value), error => finish(error));
  });
}

function parseResponse(response) {
  if (response?.status !== 200) throw fault('CAMOFOX_HTTP');
  if (!Buffer.isBuffer(response.bytes)) throw fault('CAMOFOX_MALFORMED');
  if (response.bytes.length > MAX_BYTES) throw fault('CAMOFOX_RESPONSE_LIMIT');
  try { return JSON.parse(response.bytes.toString('utf8')); }
  catch { throw fault('CAMOFOX_MALFORMED'); }
}

export async function camofoxStatus(input = {}, { request = defaultRequest, signal } = {}) {
  const result = {
    status: 'disabled', code: null, observedAt: new Date().toISOString(),
    serviceReachable: false, browserRunning: false, browserConnected: false,
    engine: null, version: null, guestReady: false, readerReady: false,
    launchTested: false, limitations: [...LIMITATIONS],
  };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ...result, status: 'unavailable', code: 'CAMOFOX_INPUT' };
  if (!parsed.data.enabled) return result;
  const deadline = Date.now() + 4500;
  try {
    const raw = await boundedRequest(request, '/health', signal, deadline);
    result.serviceReachable = Number.isInteger(raw?.status) && raw.status >= 100 && raw.status <= 599;
    const health = parseResponse(raw);
    if (!health || health.engine !== 'camoufox' || typeof health.ok !== 'boolean') throw fault('CAMOFOX_MALFORMED');
    result.engine = 'camoufox';
    if (!health.ok) throw fault('CAMOFOX_UNHEALTHY');
    if (typeof health.browserRunning !== 'boolean' || typeof health.browserConnected !== 'boolean') throw fault('CAMOFOX_MALFORMED');
    result.browserRunning = health.browserRunning;
    result.browserConnected = health.browserConnected;
    const spec = parseResponse(await boundedRequest(request, '/openapi.json', signal, deadline));
    if (!spec || typeof spec.openapi !== 'string' || !/^3\.\d+\.\d+$/.test(spec.openapi) || spec.info?.title !== 'camofox-browser' || typeof spec.info.version !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[A-Za-z0-9.-]{1,40})?$/.test(spec.info.version)) throw fault('CAMOFOX_MALFORMED');
    result.version = spec.info.version;
    result.status = 'available';
  } catch (error) {
    result.status = 'unavailable';
    const codes = new Set(['CAMOFOX_HTTP', 'CAMOFOX_INPUT', 'CAMOFOX_MALFORMED', 'CAMOFOX_RESPONSE_LIMIT', 'CAMOFOX_CANCELLED', 'CAMOFOX_TIMEOUT', 'CAMOFOX_UNHEALTHY']);
    result.code = signal?.aborted ? 'CAMOFOX_CANCELLED' : codes.has(error?.camofoxCode) ? error.camofoxCode : 'CAMOFOX_UNAVAILABLE';
  }
  return result;
}
