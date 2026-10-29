// Fixed API origins only. Arbitrary public-page requests still use the
// DNS-pinned transport in network.mjs; this does not weaken that boundary.
import { EnvHttpProxyAgent, fetch } from 'undici';
import { fail } from './contracts.mjs';

const allowed = new Set(['https://places.googleapis.com/v1/places:searchText', 'https://api.firecrawl.dev/v2/search']);
export async function providerHttp(url, { headers = {}, body, signal, timeout = 20000, maxBytes = 1048576 } = {}) {
  if (!allowed.has(url)) fail('PROVIDER_DESTINATION', 'Unsupported provider endpoint');
  const dispatcher = new EnvHttpProxyAgent();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeout);
  try {
    if (signal?.aborted) controller.abort();
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal: controller.signal, redirect: 'manual', dispatcher });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) { controller.abort(); fail('PROVIDER_LIMIT', 'Provider response exceeded its byte limit'); }
      chunks.push(chunk);
    }
    return { status: response.status, bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type')?.split(';')[0] };
  } catch (e) {
    if (e.code === 'PROVIDER_LIMIT') throw e;
    fail(signal?.aborted ? 'CANCELLED' : controller.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK', 'Provider request failed; inspect connectivity and configuration. No credentials or provider error bodies were exported.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await dispatcher.close(); }
}
