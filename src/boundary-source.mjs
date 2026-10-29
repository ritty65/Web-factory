import { fileURLToPath } from 'node:url';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { constants, lstatSync, statSync, accessSync, openSync, closeSync, fstatSync, readSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { runtimeEnvironment } from './seed-source.mjs';
import { FactoryError } from './contracts.mjs';

const ROOT = fileURLToPath(new URL('../tools/placeroot-runtime/', import.meta.url));
const MAX_CACHE = 32 * 1024 * 1024, MAX_JSON = 64 * 1024;
const STAGES = new Set(['version', 'area', 'extension', 'schema', 'polygon', 'cache']);
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = code => new FactoryError(`BOUNDARY_SOURCE_${code}`, `BOUNDARY_SOURCE_${code}: boundary unavailable; no retry performed.`);
function validStages(stages) {
  return Array.isArray(stages) && stages.length <= 24 && stages.every(s => s && Object.keys(s).length === 3 &&
    STAGES.has(s.stage) && Number.isFinite(s.durationMs) && s.durationMs >= 0 && s.durationMs <= 360_000 && ['ok','failed','running'].includes(s.outcome));
}

// Native 0.12.0 _upstream_glob/default base and _division_polygon_disk_path.
// Environment is fixed: no mirrors, caller paths or release overrides.
function metadata(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).sort().join(',') !==
    'areaName,attribution,bbox,bytes,cacheRelative,cacheSha256,divisionId,packageVersion,provider,release,sourceGlobSha256,stages' ||
    r.provider !== 'placeroot' || r.packageVersion !== '0.12.0' || r.areaName !== 'Houston' ||
    !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(r.release) || typeof r.release !== 'string' || r.release.length > 32 ||
    typeof r.divisionId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(r.divisionId) ||
    !/^[a-f0-9]{64}$/.test(r.cacheSha256) || !Number.isSafeInteger(r.bytes) || r.bytes < 42 || r.bytes > MAX_CACHE ||
    !Array.isArray(r.bbox) || r.bbox.length !== 4 || !r.bbox.every(Number.isFinite) ||
    r.bbox[0] > r.bbox[1] || r.bbox[2] > r.bbox[3] || Math.abs(r.bbox[0]) > 180 || Math.abs(r.bbox[1]) > 180 || Math.abs(r.bbox[2]) > 90 || Math.abs(r.bbox[3]) > 90 ||
    !Array.isArray(r.attribution) || !r.attribution.length || r.attribution.length > 8 ||
    !r.attribution.every(v => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v)) || !validStages(r.stages)) return false;
  const globHash = hash(`s3://overturemaps-us-west-2/release/${r.release}/theme=divisions/type=division_area/*`);
  return r.sourceGlobSha256 === globHash && r.cacheRelative === `cache/division_polygons/${globHash.slice(0,16)}/${hash(r.divisionId).slice(0,32)}.bin`;
}

// Bounded stdlib WKB reader: native union returns Polygon or MultiPolygon, not
// arbitrary objects/SQL. Validate exact consumption, finite coordinates and bbox.
function validWkb(data, bbox) {
  let offset = 33;
  const bounds = [Infinity,-Infinity,Infinity,-Infinity];
  function polygon(multi = true) {
    const order = data.readUInt8(offset++);
    if (order !== 0 && order !== 1) throw Error();
    const uint = () => { const v = order ? data.readUInt32LE(offset) : data.readUInt32BE(offset); offset += 4; return v; };
    const double = () => { const v = order ? data.readDoubleLE(offset) : data.readDoubleBE(offset); offset += 8; return v; };
    const type = uint(), count = uint();
    if (!count || count > data.length / 4) throw Error();
    if (type === 6 && multi) { for (let i = 0; i < count; i++) polygon(false); return; }
    if (type !== 3) throw Error();
    for (let i = 0; i < count; i++) {
      const points = uint(); if (points < 4 || points > (data.length - offset) / 16) throw Error();
      let first, last;
      for (let j = 0; j < points; j++) {
        const x = double(), y = double();
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) throw Error();
        first ||= [x,y]; last = [x,y]; bounds[0] = Math.min(bounds[0],x); bounds[1] = Math.max(bounds[1],x); bounds[2] = Math.min(bounds[2],y); bounds[3] = Math.max(bounds[3],y);
      }
      if (first[0] !== last[0] || first[1] !== last[1]) throw Error();
    }
  }
  try { polygon(); return offset === data.length && bounds.every((v,i) => v === bbox[i]); } catch { return false; }
}

function installedPackagesPresent() {
  const read = file => {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024*1024) throw Error();
    return readFileSync(file,'utf8');
  };
  const manifest = JSON.parse(read(join(ROOT,'runtime-manifest.json')));
  if (manifest.package !== 'placeroot' || manifest.version !== '0.12.0' || !/^3\.\d+\.\d+$/.test(manifest.python) || !Array.isArray(manifest.packages) || !manifest.packages.length || manifest.packages.length > 100) return false;
  const venv = realpathSync(join(ROOT,'.venv'));
  const site = join(venv,'lib','python'+manifest.python.split('.').slice(0,2).join('.'),'site-packages');
  const normalize = value => value.toLowerCase().replace(/[-_.]+/g,'_');
  const installed = new Map();
  for (const entry of readdirSync(site).filter(v=>v.endsWith('.dist-info'))) {
    const directory = join(site,entry), info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const text = read(join(directory,'METADATA')), name = /^Name: ([^\r\n]+)\r?$/m.exec(text)?.[1], version = /^Version: ([^\r\n]+)\r?$/m.exec(text)?.[1];
    if (!name || !version || installed.has(normalize(name))) return false;
    installed.set(normalize(name),{directory,version});
  }
  for (const pin of manifest.packages) {
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(pin.name) || typeof pin.version !== 'string' || !/^[a-f0-9]{64}$/.test(pin.recordSha256)) return false;
    const dist = installed.get(normalize(pin.name));if (!dist || dist.version !== pin.version) return false;
    // Manifest hashes came from importlib.metadata.read_text(), which applies
    // Python universal-newline translation to pip's frequently CRLF CSV files.
    const record = read(join(dist.directory,'RECORD')).replace(/\r\n?/g,'\n');if (hash(record) !== pin.recordSha256) return false;
    for (const line of record.split(/\r?\n/).filter(Boolean)) {
      // Wheel RECORD is CSV: support escaped/quoted paths; reject unknown rows.
      const row = /^(?:"((?:[^"]|"")*)"|([^",]+)),([^,]*),(\d*)$/.exec(line);
      if (!row) return false;
      if (!row[3]) continue; // Unhashed generated bytecode/RECORD is optional.
      const path = resolve(site,(row[1]??row[2]).replace(/""/g,'"'));
      const rel = relative(venv,path);if (rel.startsWith('..') || isAbsolute(rel)) return false;
      const actual = realpathSync(path), realRel = relative(venv,actual);
      if (realRel.startsWith('..') || isAbsolute(realRel) || !lstatSync(path).isFile()) return false;
    }
  }
  return true; // Presence/version/RECORD binding; full byte hashes verify at launch.
}

export function inspectBoundaryCache(receipt) {
  let fd;
  try {
    if (!metadata(receipt)) return { ready: false, reason: 'invalid_receipt' };
    // A restored receipt/cache is not an installed operational runtime. The
    // venv interpreter may legitimately link to the fixed system Python.
    const python = join(ROOT,'.venv/bin/python');
    if (!statSync(python).isFile()) return {ready:false,reason:'runtime_unavailable'};
    accessSync(python,constants.X_OK);
    for (const name of ['server.py','boundary.py','requirements.lock','runtime-manifest.json']) {
      const info = lstatSync(join(ROOT,name));
      if (!info.isFile() || info.isSymbolicLink()) return {ready:false,reason:'runtime_unavailable'};
    }
    if (!installedPackagesPresent()) return {ready:false,reason:'runtime_unavailable'};
    // Check every component, including ROOT, before opening with O_NOFOLLOW.
    let path = ROOT;
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) return {ready:false,reason:'unsafe_cache'};
    for (const part of receipt.cacheRelative.split('/')) {
      path = join(path,part); const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (part.endsWith('.bin') ? !stat.isFile() : !stat.isDirectory())) return {ready:false,reason:'unsafe_cache'};
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== receipt.bytes || stat.size > MAX_CACHE) return {ready:false,reason:'changed_cache'};
    const data = Buffer.alloc(stat.size); let offset = 0;
    while (offset < data.length) { const n = readSync(fd,data,offset,data.length-offset,null); if (!n) return {ready:false,reason:'changed_cache'}; offset += n; }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || hash(data) !== receipt.cacheSha256) return {ready:false,reason:'changed_cache'};
    if (data[0] !== 1 || !receipt.bbox.every((v,i) => data.readDoubleLE(1+i*8) === v) || !validWkb(data,receipt.bbox)) return {ready:false,reason:'invalid_cache'};
    return { ready:true, reason:'ready' };
  } catch { return {ready:false,reason:'missing_or_unsafe_cache'}; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function prepareBoundary({ signal } = {}) {
  if (signal?.aborted) throw failure('ABORTED');
  let child, timer, killTimer, closed = false, problem, output = Buffer.alloc(0), progress = Buffer.alloc(0);
  const stages = [];
  const stop = code => {
    problem ||= code;
    if (child?.pid && !closed && !killTimer) {
      child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    }
  };
  const abort = () => stop('ABORTED');
  try {
    child = spawn(join(ROOT,'.venv/bin/python'), ['-I','-S','-B',join(ROOT,'server.py'),'--prepare-boundary'],
      { cwd:ROOT, env:runtimeEnvironment(), stdio:['ignore','pipe','pipe'], shell:false });
    const reaped = new Promise(resolve => child.once('close', code => { closed = true; resolve(code); }));
    child.on('error', () => stop('PROCESS'));
    child.stdout.on('error', () => stop('PROCESS'));
    child.stderr?.on('error', () => stop('PROCESS'));
    child.stdout.on('data', chunk => {
      if (problem) return;
      if (output.length + chunk.length > MAX_JSON) return stop('RESPONSE_BOUND');
      output = Buffer.concat([output,chunk]);
    });
    child.stderr?.on('data', chunk => {
      if (problem) return;
      if (progress.length + chunk.length > MAX_JSON) return stop('RESPONSE_BOUND');
      progress = Buffer.concat([progress,chunk]);
    });
    signal?.addEventListener('abort',abort,{once:true}); if (signal?.aborted) abort();
    // Keep the mandatory two-second TERM-to-KILL grace inside the overall
    // six-minute allowance rather than extending an expensive setup afterward.
    timer = setTimeout(() => stop('TIMEOUT'),358_000);
    const code = await reaped;
    // Only our fixed JSON progress records are retained; package log bodies are
    // never returned. Failed setup/timeout can still retain completed safe stages.
    for (const line of progress.toString('utf8').split('\n')) {
      try { const s = JSON.parse(line); if (validStages([s]) && stages.length < 24) stages.push(s); } catch { /* private logs ignored */ }
    }
    if (problem) throw failure(problem);
    let result;
    try { result = JSON.parse(output.toString('utf8')); } catch { throw failure('PROTOCOL'); }
    if (code !== 0) {
      if (result?.error === 'BOUNDARY_SOURCE_INSTALL_DRIFT') throw failure('INSTALL_DRIFT');
      throw failure('UNAVAILABLE');
    }
    if (!metadata(result) || result.stages.some(s => s.outcome !== 'ok') || !inspectBoundaryCache(result).ready) throw failure('CACHE');
    return result;
  } catch (e) {
    const safe = e instanceof FactoryError && /^BOUNDARY_SOURCE_/.test(e.code) ? e : failure('PROCESS');
    safe.stages = stages; throw safe;
  } finally { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort',abort); }
}
