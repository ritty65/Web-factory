import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { publicUrl, fail, FactoryError } from './contracts.mjs';
// Native CIDR parsing handles equivalent IPv6 spellings (not string prefixes).
// https://nodejs.org/docs/latest-v24.x/api/net.html#blocklistaddsubnetnet-prefix-type
const publicV6 = new BlockList(), reservedV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');
for (const [network, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) reservedV6.addSubnet(network, bits, 'ipv6');

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113));
  }
  // Global unicast only, minus documentation and transition/tunnel mechanisms.
  return isIP(address) === 6 && publicV6.check(address, 'ipv6') && !reservedV6.check(address, 'ipv6');
}
export async function resolvePublic(url, lookup = dnsLookup) {
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some(r => !isPublicAddress(r.address))) fail('PRIVATE_DNS', 'DNS must resolve exclusively to public unicast addresses');
  return records[0];
}
export async function safeFetch(value, { maxBytes = 2 * 1024 * 1024, signal, timeout = 25000, lookup = dnsLookup, signed = false, redirects = 2, allowedHosts = null, method = 'GET', body, headers = {} } = {}) {
  const url = publicUrl(value, { signed });
  if (allowedHosts && !allowedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) fail('MEDIA_HOST', 'Observed media host is outside the permitted public CDN families');
  const address = await resolvePublic(url, lookup);
  const response = await new Promise((resolve, reject) => {
    // Resolve once, then pin the actual TLS connection to the validated address.
    const req = https.request(url, { method, headers: { 'user-agent': 'Simulacra-Private-Research/0.1', accept: '*/*', ...headers }, signal, lookup: (_host, options, cb) => options.all ? cb(null, [address]) : cb(null, address.address, address.family) }, res => {
      let total = 0; const chunks = [];
      res.on('data', data => { total += data.length; if (total > maxBytes) req.destroy(new FactoryError('NETWORK_LIMIT', 'Public response exceeds its byte limit')); else chunks.push(data); });
      res.on('end', () => resolve({ status: res.statusCode, url: url.href, headers: res.headers, bytes: Buffer.concat(chunks), contentType: String(res.headers['content-type'] || '').split(';')[0] }));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new FactoryError('NETWORK_TIMEOUT', 'Public request timed out')));
    req.on('error', reject); if (body) req.write(body); req.end();
  });
  if (response.status >= 300 && response.status < 400) {
    if (!redirects || !response.headers.location) fail('REDIRECT', 'Redirect limit or media redirect restriction reached');
    return safeFetch(new URL(response.headers.location, url).href, { maxBytes, signal, timeout, lookup, signed, redirects: redirects - 1, allowedHosts, method, body, headers });
  }
  return response;
}
