import { hash, fail } from './contracts.mjs';
import { startServer } from './server.mjs';

export const storeIdentity = store => hash({ db: store.dbPath, state: store.stateRoot });
async function health(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1500) });
  const reader = response.body.getReader(); let bytes = Buffer.alloc(0);
  for (;;) { const part = await reader.read(); if (part.done) break; if (bytes.length + part.value.length > 4096) { await reader.cancel(); return { response, data: null }; } bytes = Buffer.concat([bytes, part.value]); }
  let data; try { data = JSON.parse(bytes.toString()); } catch { data = null; }
  return { response, data };
}
// Reuse only a matching loopback app. Never take over a port, install a boot
// service, inspect credentials or create a batch as a startup side effect.
export async function openFactory(service, { port = 8780, previewPort = 8781 } = {}) {
  const url = `http://127.0.0.1:${port}`;
  if (port) {
    let observed;
    try { observed = await health(url + '/api/health'); }
    catch (e) { if (e.cause?.code !== 'ECONNREFUSED') fail('FACTORY_PORT_IN_USE', 'App port unavailable or health check timed out. No process was stopped.'); }
    if (observed) {
      const { response, data } = observed;
      if (response.ok && data?.app === 'simulacra-factory' && data.workflow === 'one-button-v1' && data.storeIdentity === storeIdentity(service.store) && data.previewOrigin === `http://127.0.0.1:${previewPort}`) {
        let preview; try { preview = await health(data.previewOrigin + '/health'); } catch { /* no alternate port or takeover */ }
        if (!preview?.response.ok || preview.data?.app !== 'simulacra-factory-preview' || preview.data.storeIdentity !== data.storeIdentity) fail('FACTORY_PREVIEW_UNAVAILABLE', 'The matching app exists but its isolated preview is unavailable. No process was stopped or alternate preview invented.');
        return { reused: true, url, previewUrl: data.previewOrigin, server: null };
      }
      fail('FACTORY_PORT_IN_USE', 'Port belongs to another/older app or store. Inspect and deliberately stop only the owned instance; startup did not replace it.');
    }
  }
  const server = await startServer(service, { port, previewPort });
  return { reused: false, url: server.url, previewUrl: server.previewUrl, server };
}
