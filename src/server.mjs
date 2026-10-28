import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, safeRelative, id, hash } from './contracts.mjs';
import { noLinks } from './db.mjs';
import { workRelative } from './proposal.mjs';

export const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8' };
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
function json(response, status, data) { response.writeHead(status, { 'content-type': MIME['.json'] }); response.end(JSON.stringify(data)); }
function guard(request, origin) {
  const u = new URL(origin);
  if (request.headers.host !== u.host || (request.headers.origin && request.headers.origin !== origin) || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) fail('HOST_ORIGIN', 'Only exact loopback same-origin requests are allowed');
}
function guardPreview(request, origin) {
  const url = new URL(origin), given = request.headers.origin;
  const destination = request.headers['sec-fetch-dest'];
  const resource = ['style', 'script', 'image', 'font'].includes(destination);
  if (request.headers.host !== url.host || (given && given !== origin && !(given === 'null' && resource))) fail('HOST_ORIGIN', 'Only loopback preview documents and their static subresources are allowed');
  // CSP sandbox deliberately creates an opaque origin. Its legitimate relative
  // CSS/JS/images are Sec-Fetch-Site: cross-site, with no Origin for no-cors loads.
  // This exception applies ONLY to this read-only static origin, never the app.
  if (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site']) && !resource && !(destination === 'document' && request.headers['sec-fetch-mode'] === 'navigate')) fail('HOST_ORIGIN', 'Cross-site API/fetch access is not allowed on the preview');
}
function headers(res, preview = false) {
  res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('cache-control', 'no-store');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('content-security-policy', preview
    ? "sandbox allow-scripts; default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'"
    : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('x-frame-options', 'DENY');
}
async function body(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) fail('CONTENT_TYPE', 'JSON is required');
  let size = 0, data = '';
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) fail('BODY_LIMIT', 'Input exceeds one MiB'); data += chunk; }
  try { return JSON.parse(data); } catch { fail('INVALID_JSON', 'Input must be complete JSON'); }
}
function sendError(res, error) {
  if (res.headersSent) return res.end();
  const status = error.code === 'HOST_ORIGIN' || error.code === 'CSRF' ? 403 : error.code === 'BODY_LIMIT' ? 413 : error.code === 'NOT_FOUND' || error.code === 'ENOENT' ? 404 : ['STALE_ARTIFACT', 'SYMLINK'].includes(error.code) ? 409 : 400;
  json(res, status, { error: error.code || 'REQUEST_FAILED', message: error.code && !['ENOENT', 'EACCES'].includes(error.code) ? error.message : 'Request could not be completed' });
}
async function listen(server, port) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); return `http://127.0.0.1:${server.address().port}`; }
function prepareShutdown(server) {
  // HTTP idle cleanup does not include speculative TCP connections that have
  // never supplied a request. Track only these; admitted requests must drain.
  const unused = new Set();
  server.on('connection', socket => {
    unused.add(socket);
    socket.once('close', () => unused.delete(socket));
  });
  server.on('request', request => unused.delete(request.socket));
  return () => new Promise(resolve => {
    server.close(resolve);
    server.closeIdleConnections();
    for (const socket of unused) socket.destroy();
  });
}
export async function startServer(service, { port = 8780, previewPort = 8781 } = {}) {
  // Reverse-proxy deployment remains loopback-bound. Only explicit configured
  // origins are trusted; forwarded headers never grant origin/CSRF authority.
  const configuredApp=process.env.FACTORY_APP_ORIGIN,configuredPreview=process.env.FACTORY_PREVIEW_ORIGIN;
  if(Boolean(configuredApp)!==Boolean(configuredPreview))fail('PUBLIC_ORIGIN','Configure both HTTPS app and isolated preview origins, or neither');
  for(const value of [configuredApp,configuredPreview].filter(Boolean)){
    let u;try{u=new URL(value);}catch{fail('PUBLIC_ORIGIN','Configured origins must be valid HTTPS origins');}
    if(u.protocol!=='https:'||u.origin!==value||u.username||u.password||u.hostname==='localhost'||u.hostname==='127.0.0.1')fail('PUBLIC_ORIGIN','Use exact HTTPS origins without paths, credentials or trailing slash');
  }
  if(configuredApp&&configuredApp===configuredPreview)fail('PUBLIC_ORIGIN','App and generated previews require separate origins');
  const csrf = randomBytes(32).toString('hex'); let url, previewUrl;
  const preview = http.createServer(async (req, res) => {
    headers(res, true);
    try {
      guardPreview(req, previewUrl);
      if (req.method !== 'GET' && req.method !== 'HEAD') fail('METHOD', 'Preview is read-only');
      const raw = new URL(req.url, previewUrl).pathname;
      if (raw === '/health') return json(res, 200, { app: 'simulacra-factory-preview', storeIdentity: hash({ db: service.store.dbPath, state: service.store.stateRoot }), staticOnly: true });
      const parts = raw.split('/'); if (!['site', 'study'].includes(parts[1]) || parts.length < 4) fail('NOT_FOUND', 'Preview not found');
      const job = service.store.job(id(parts[2]));
      const study = parts[1] === 'study';
      if (study && !/^[0-2]$/.test(parts[3])) fail('NOT_FOUND', 'Study not found');
      const relative = safeRelative(decodeURIComponent(parts.slice(study ? 4 : 3).join('/')) || 'index.html');
      const boundRoot = study ? job.outputs.studyRoots?.[Number(parts[3])] : job.outputs.siteRelative;
      if (!boundRoot || study && boundRoot !== `${workRelative(job)}/directions/study-${parts[3]}/site`) fail('NOT_FOUND', 'No exact staged proposal/study for this job');
      const root = path.join(service.store.stateRoot, safeRelative(boundRoot));
      const target = path.join(root, relative); await noLinks(target);
      const info = await stat(target); if (!info.isFile() || info.size > 2 * 1024 * 1024 || !MIME[path.extname(relative)]) fail('NOT_FOUND', 'Not a served static file');
      if (req.headers.origin === 'null' && ['font', 'script'].includes(req.headers['sec-fetch-dest'])) res.setHeader('access-control-allow-origin', 'null');
      res.setHeader('content-type', MIME[path.extname(relative)]); res.end(req.method === 'HEAD' ? undefined : await readFile(target));
    } catch (e) { sendError(res, e); }
  });
  const server = http.createServer(async (req, res) => {
    headers(res);
    try {
      guard(req, url); const pathname = new URL(req.url, url).pathname;
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { app: 'simulacra-factory', workflow: 'one-button-v1', storeIdentity: hash({ db: service.store.dbPath, state: service.store.stateRoot }), previewOrigin: previewUrl, automaticBatchStart: false });
      if (req.method === 'GET' && pathname === '/api/session') return json(res, 200, { csrf, previewOrigin: previewUrl });
      if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, { ...service.snapshot(), previewOrigin: previewUrl });
      if (req.method === 'POST' && pathname === '/api/op') {
        const value = req.headers['x-factory-csrf'] || '';
        if (req.headers.origin !== url || value.length !== csrf.length || !timingSafeEqual(Buffer.from(value), Buffer.from(csrf))) fail('CSRF', 'Same-origin session token required');
        const data = await body(req); if (Object.keys(data).some(k => !['operation', 'input'].includes(k))) fail('INVALID_INPUT', 'Unexpected request fields');
        return json(res, 200, await service.dispatch(data.operation, data.input));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') fail('METHOD', 'Method not supported');
      if (pathname.startsWith('/files/') || pathname.startsWith('/library-files/')) {
        const { artifact, bytes } = pathname.startsWith('/files/') ? await service.artifact(pathname.slice(7)) : await service.libraryArtifact(pathname.slice(15));
        res.setHeader('content-type', MIME[path.extname(artifact.relative)] || 'application/octet-stream');
        // Images can be used in the console. Every active/text format is attachment-only.
        const image = ['.png', '.webp', '.jpg', '.jpeg'].includes(path.extname(artifact.relative));
        res.setHeader('content-disposition', `${image ? 'inline' : 'attachment'}; filename="${path.basename(artifact.relative).replace(/[^a-zA-Z0-9._-]/g, '-')}"`);
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      const file = ({ '/': 'index.html', '/app.js': 'app.js', '/studio.js': 'studio.js', '/setup.js': 'setup.js', '/pilot.js': 'pilot.js', '/progress.js': 'progress.js', '/batches.js': 'batches.js', '/style.css': 'style.css', '/assets/DMSans-Variable.ttf': 'assets/DMSans-Variable.ttf' })[pathname];
      if (!file) fail('NOT_FOUND', 'Not found');
      res.setHeader('content-type', MIME[path.extname(file)]); res.end(req.method === 'HEAD' ? undefined : await readFile(path.join(webRoot, file)));
    } catch (e) { sendError(res, e); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  const closeServers = [server, preview].map(prepareShutdown);
  let listenUrl, previewListenUrl;
  try { previewListenUrl=await listen(preview,previewPort);previewUrl=configuredPreview||previewListenUrl;listenUrl=await listen(server,port);url=configuredApp||listenUrl; } catch (e) { preview.close(); server.close(); throw e; }
  // External timer processes enqueue only. The long-lived service owns worker
  // children, including work queued while its previous worker was idle.
  const ownedPump=setInterval(()=>service.wakeOwnedWork?.(),5000);ownedPump.unref();
  return { url, previewUrl, listenUrl, previewListenUrl, close: () => {clearInterval(ownedPump);return Promise.all(closeServers.map(close => close()));} };
}
