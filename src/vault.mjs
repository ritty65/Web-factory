import { safeFetch } from './network.mjs';
import { now } from './contracts.mjs';
export async function vaultStatus({ signal } = {}) {
  try {
    const response = await safeFetch('https://simulacraproductions.net/api/preview-vault/list.php', { signal, maxBytes: 4000 });
    return { id: 'connection', status: [401, 403].includes(response.status) ? 'authentication_required' : response.status === 200 ? 'guest_response_requires_operator_review' : 'unavailable', httpStatus: response.status, observedAt: now(), inventorySynced: false, note: 'Read-only unauthenticated status check. No password, browser credentials or private inventory were requested. Use a sanitized operator export for inventory import.' };
  } catch { return { id: 'connection', status: 'unavailable', observedAt: now(), inventorySynced: false, note: 'Public availability check failed. The Vault is not assumed empty; authenticated inventory remains unverified.' }; }
}
