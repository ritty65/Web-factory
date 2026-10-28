import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, truncateSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';

const hash = value => createHash('sha256').update(value).digest('hex');
const moduleUrl = new URL('../src/boundary-source.mjs', import.meta.url);
async function fixture(t) {
  const root = mkdtempSync('/tmp/boundary-fictional-');
  mkdirSync(join(root,'.venv/bin'),{recursive:true});
  symlinkSync(process.execPath,join(root,'.venv/bin/python'));
  for(const name of ['server.py','boundary.py','requirements.lock','runtime-manifest.json'])writeFileSync(join(root,name),'fictional runtime input only');
  const packages=[];
  for(const [name,version] of [['placeroot','0.12.0'],['duckdb','1.5.6'],['mcp','2.3.0']]){
    const site=join(root,'.venv/lib/python3.12/site-packages'),dist=join(site,`${name}-${version}.dist-info`),module=join(site,name);
    mkdirSync(dist,{recursive:true});mkdirSync(module,{recursive:true});
    const content='Fictional fixture only';writeFileSync(join(module,'__init__.py'),content);
    const digest=createHash('sha256').update(content).digest('base64url');
    const record=`${name}/__init__.py,sha256=${digest},${Buffer.byteLength(content)}\n`;
    writeFileSync(join(dist,'METADATA'),`Name: ${name}\nVersion: ${version}\n`);writeFileSync(join(dist,'RECORD'),record);
    packages.push({name,version,recordSha256:hash(record)});
  }
  writeFileSync(join(root,'runtime-manifest.json'),JSON.stringify({package:'placeroot',version:'0.12.0',python:'3.12.0',packages}));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = readFileSync(moduleUrl, 'utf8')
    .replace("fileURLToPath(new URL('../tools/placeroot-runtime/', import.meta.url))", JSON.stringify(root))
    .replace("'./seed-source.mjs'", JSON.stringify(new URL('../src/seed-source.mjs', import.meta.url).href))
    .replace("'./contracts.mjs'", JSON.stringify(new URL('../src/contracts.mjs', import.meta.url).href));
  const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const release = '2026-01-01.0', divisionId = 'fictional-division-not-source-evidence';
  const sourceGlobSha256 = hash(`s3://overturemaps-us-west-2/release/${release}/theme=divisions/type=division_area/*`);
  const cacheRelative = `cache/division_polygons/${sourceGlobSha256.slice(0, 16)}/${hash(divisionId).slice(0, 32)}.bin`;
  const path = join(root, cacheRelative);
  mkdirSync(join(path, '..'), { recursive: true });
  // Fictional little-endian polygon WKB; never a real Houston boundary.
  const wkb = Buffer.alloc(93); wkb[0] = 1; wkb.writeUInt32LE(3, 1); wkb.writeUInt32LE(1, 5); wkb.writeUInt32LE(5, 9);
  [[0,0],[1,0],[1,1],[0,1],[0,0]].flat().forEach((v, i) => wkb.writeDoubleLE(v, 13 + i * 8));
  const bytes = Buffer.alloc(33 + wkb.length); bytes[0] = 1;
  [0,1,0,1].forEach((v, i) => bytes.writeDoubleLE(v, 1 + i * 8)); wkb.copy(bytes, 33);
  writeFileSync(path, bytes);
  const receipt = { provider: 'placeroot', packageVersion: '0.12.0', release, divisionId, areaName: 'Houston', cacheRelative,
    sourceGlobSha256, cacheSha256: hash(bytes), bytes: bytes.length, bbox: [0,1,0,1],
    attribution: ['Overture Maps Foundation; © OpenStreetMap contributors; ODbL-1.0'], stages: [{ stage: 'cache', durationMs: 1, outcome: 'ok' }] };
  return { root, path, bytes, receipt, ...api };
}

test('local inspection validates fictional native cache and never writes it', async t => {
  const f = await fixture(t); assert.deepEqual(f.inspectBoundaryCache(f.receipt), { ready: true, reason: 'ready' });
  assert.deepEqual(readFileSync(f.path), f.bytes);
});
test('local status cannot claim readiness with a missing installed runtime',async t=>{
  const f=await fixture(t);rmSync(join(f.root,'.venv/bin/python'));
  assert.equal(f.inspectBoundaryCache(f.receipt).ready,false);
});
test('local status rejects missing distributions despite retained interpreter and boundary cache',async t=>{
  const f=await fixture(t);rmSync(join(f.root,'.venv/lib'),{recursive:true});
  assert.equal(f.inspectBoundaryCache(f.receipt).ready,false);
});
test('local status rejects a partially removed pinned module despite retained distribution metadata',async t=>{
  const f=await fixture(t);rmSync(join(f.root,'.venv/lib/python3.12/site-packages/placeroot/__init__.py'));
  assert.equal(f.inspectBoundaryCache(f.receipt).ready,false);
});
test('local pinned RECORD identity matches Python universal-newline reads',async t=>{
  const f=await fixture(t),file=join(f.root,'.venv/lib/python3.12/site-packages/placeroot-0.12.0.dist-info/RECORD');
  writeFileSync(file,readFileSync(file,'utf8').replace(/\n/g,'\r\n'));
  assert.equal(f.inspectBoundaryCache(f.receipt).ready,true);
});
for (const kind of ['missing', 'changed', 'symlink', 'parent-symlink', 'oversized', 'header', 'bbox', 'wkb']) {
  test(`local inspection rejects ${kind} cache`, async t => {
    const f = await fixture(t);
    if (kind === 'missing') rmSync(f.path);
    if (kind === 'changed') writeFileSync(f.path, Buffer.from('changed'));
    if (kind === 'symlink') { rmSync(f.path); symlinkSync('/dev/null', f.path); }
    if (kind === 'parent-symlink') { const parent = join(f.path, '..'); rmSync(parent, {recursive:true}); symlinkSync('/tmp', parent); }
    if (kind === 'oversized') truncateSync(f.path, 32 * 1024 * 1024 + 1);
    if (['header','bbox','wkb'].includes(kind)) {
      const b = Buffer.from(f.bytes);
      if (kind === 'header') b[0] = 0;
      if (kind === 'bbox') b.writeDoubleLE(NaN, 1);
      if (kind === 'wkb') b[33] = 9;
      writeFileSync(f.path, b); f.receipt.cacheSha256 = hash(b);
    }
    const result = f.inspectBoundaryCache(f.receipt); assert.equal(result.ready, false); assert.match(result.reason, /^[a-z_]+$/);
  });
}
for (const [key, value] of [['release','2026-01-02.0'], ['divisionId','foreign'], ['sourceGlobSha256','a'.repeat(64)],
  ['cacheRelative','../../outside'], ['bytes',Infinity], ['bbox',[1,0,0,1]], ['provider','other'], ['packageVersion','0.13.0'], ['areaName','Dallas']]) {
  test(`local inspection rejects foreign/malformed ${key}`, async t => {
    const f = await fixture(t); assert.equal(f.inspectBoundaryCache({...f.receipt,[key]:value}).ready, false);
  });
}

test('fixed child launch, credential-free environment, success and reaping', async t => {
  const f = await fixture(t); let options, args, command;
  t.mock.method(childProcess, 'spawn', (c, a, o) => {
    command = c; args = a; options = o;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.pid = 123; child.exitCode = null; child.signalCode = null;
    queueMicrotask(() => { child.stdout.end(JSON.stringify(f.receipt)); child.exitCode = 0; child.emit('close', 0); }); return child;
  }); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(await f.prepareBoundary(), f.receipt);
  assert.equal(command, join(f.root,'.venv/bin/python'));
  assert.deepEqual(args, ['-I','-S','-B',join(f.root,'server.py'),'--prepare-boundary']);
  assert.equal(options.shell, false); assert.equal(options.env.PLACEROOT_DUCKDB_MEMORY_LIMIT,'512MB');
  assert.equal(options.env.PLACEROOT_DUCKDB_THREADS,'4'); assert.equal(options.env.PATH,'/usr/bin:/bin');
  assert.ok(!Object.keys(options.env).some(k => /TOKEN$|SECRET|API_KEY|PROXY/.test(k)));
});
for (const kind of ['abort','oversized','protocol','spawn','timeout','cache']) {
  test(`child ${kind} failure is sanitized and reaped`, async t => {
    const f = await fixture(t), controller = new AbortController(); let closed = false, killed = false;
    t.mock.method(childProcess, 'spawn', () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.pid = kind === 'spawn' ? undefined : 123;
      child.exitCode = null; child.signalCode = null;
      child.kill = () => { killed = true; queueMicrotask(() => { closed = true; child.emit('close',null,'SIGTERM'); }); };
      queueMicrotask(() => {
        if (kind === 'abort') controller.abort();
        if (kind === 'oversized') child.stdout.write(Buffer.alloc(65537));
        if (kind === 'protocol') child.stdout.end('private body /private/path SQL');
        if (kind === 'cache') { child.stdout.end(JSON.stringify({...f.receipt,release:'2026-01-02.0'})); closed = true; child.emit('close',0); }
        if (kind === 'protocol' || kind === 'spawn') { closed = true; if (kind === 'spawn') child.emit('error', Error('private')); child.emit('close', 1); }
      }); return child;
    }); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    if (kind === 'timeout') t.mock.timers.enable({apis:['setTimeout']});
    const promise = f.prepareBoundary({signal:controller.signal});
    if (kind === 'timeout') t.mock.timers.tick(360000);
    await assert.rejects(promise, e => /^BOUNDARY_SOURCE_[A-Z_]+$/.test(e.code) && !/private|SQL/.test(e.message));
    assert.equal(closed,true); if (['abort','oversized','timeout'].includes(kind)) assert.equal(killed,true);
  });
}

test('already-aborted setup never spawns a child', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  t.mock.method(childProcess,'spawn',() => assert.fail('must not spawn')); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(f.prepareBoundary({signal:controller.signal}),{code:'BOUNDARY_SOURCE_ABORTED'});
});
test('six-minute setup allowance includes the two-second TERM-to-KILL cleanup window',async t=>{
  const f=await fixture(t),signals=[];let child;
  t.mock.method(childProcess,'spawn',()=>{
    child=new EventEmitter();child.stdout=new PassThrough();child.pid=123;
    child.kill=signal=>{signals.push(signal);if(signal==='SIGKILL')child.emit('close',null,'SIGKILL');return true;};return child;
  });syncBuiltinESMExports();t.mock.timers.enable({apis:['setTimeout']});
  const pending=f.prepareBoundary();pending.catch(()=>{});
  t.after(()=>{child.emit('close',null);t.mock.restoreAll();syncBuiltinESMExports();});
  t.mock.timers.tick(357999);assert.deepEqual(signals,[]);
  t.mock.timers.tick(1);assert.deepEqual(signals,['SIGTERM']);
  t.mock.timers.tick(2000);assert.deepEqual(signals,['SIGTERM','SIGKILL']);
  await assert.rejects(pending,{code:'BOUNDARY_SOURCE_TIMEOUT'});
});

test('real failed spawn in fictional uninstalled runtime settles and is sanitized', async t => {
  const f = await fixture(t);
  rmSync(join(f.root,'.venv/bin/python'));
  await assert.rejects(f.prepareBoundary(), {code:'BOUNDARY_SOURCE_PROCESS'});
});

test('oversized fictional real process ignoring TERM is KILLed and reaped', async t => {
  const f = await fixture(t), realSpawn = childProcess.spawn; let owned;
  t.mock.method(childProcess,'spawn',() => {
    owned = realSpawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); process.stdout.write(Buffer.alloc(65537)); setInterval(()=>{},1000)"],
      {env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']}); return owned;
  }); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(f.prepareBoundary(),{code:'BOUNDARY_SOURCE_RESPONSE_BOUND'});
  assert.equal(owned.signalCode,'SIGKILL'); assert.throws(() => process.kill(owned.pid,0), {code:'ESRCH'});
});

test('normal MCP entrypoint remains fixed and install verification precedes dispatch (fictional modules)', () => {
  const source = new URL('../tools/placeroot-runtime/server.py',import.meta.url).pathname;
  const script = `
import ast, sys, types
tree=ast.parse(open(${JSON.stringify(source)}).read())
# Replace only installer verification with a fictional function. No installed
# metadata, package import, version resolution, geometry or source query runs.
for i,node in enumerate(tree.body):
 if isinstance(node,ast.FunctionDef) and node.name=='verify_install':
  tree.body[i]=ast.parse("def verify_install(): events.append('verified')").body[0]
events=[]
def run():
 assert events==['verified']; events.append('mcp')
sys.modules['placeroot']=types.ModuleType('placeroot')
sys.modules['placeroot.server']=types.SimpleNamespace(mcp=types.SimpleNamespace(run=run))
sys.argv=['server.py']; ns={'__name__':'__main__','__file__':${JSON.stringify(source)},'events':events}
exec(compile(ast.fix_missing_locations(tree),'fictional-server','exec'),ns)
assert events==['verified','mcp']
print('fictional normal MCP passed')
`;
  const result = spawnSync('/usr/bin/python3',['-I','-S','-B','-c',script],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/fictional normal MCP passed/);
});

test('setup install drift emits fixed bounded JSON before any native import', () => {
  const source = new URL('../tools/placeroot-runtime/server.py',import.meta.url).pathname;
  const script = `
import ast,sys
tree=ast.parse(open(${JSON.stringify(source)}).read())
for i,node in enumerate(tree.body):
 if isinstance(node,ast.FunctionDef) and node.name=='verify_install':
  tree.body[i]=ast.parse("def verify_install(): raise RuntimeError('private path SQL')").body[0]
sys.argv=['server.py','--prepare-boundary']
exec(compile(ast.fix_missing_locations(tree),'fictional-server','exec'),{'__name__':'__main__','__file__':${JSON.stringify(source)}})
`;
  const result = spawnSync('/usr/bin/python3',['-I','-S','-B','-c',script],{encoding:'utf8'});
  assert.equal(result.status,78); assert.deepEqual(JSON.parse(result.stdout), {error:'BOUNDARY_SOURCE_INSTALL_DRIFT',stages:[]});
  assert.equal(result.stderr,'SEED_SOURCE_INSTALL_DRIFT\n');
});

test('Python boundary helper verifies native tuple with injected fictional package only', () => {
  const script = `
import importlib.util, pathlib, tempfile, struct, types, sys, hashlib, json
spec=importlib.util.spec_from_file_location('boundary', ${JSON.stringify(new URL('../tools/placeroot-runtime/boundary.py', import.meta.url).pathname)})
b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
with tempfile.TemporaryDirectory(prefix='boundary-fictional-',dir='/tmp') as d:
 b.ROOT=pathlib.Path(d)
 release='2026-01-01.0'; division='fictional-division'
 glob=f's3://overturemaps-us-west-2/release/{release}/theme=divisions/type=division_area/*'
 path=b.ROOT/'cache/division_polygons'/hashlib.sha256(glob.encode()).hexdigest()[:16]/(hashlib.sha256(division.encode()).hexdigest()[:32]+'.bin')
 wkb=struct.pack('<BIII',1,3,1,5)+struct.pack('<10d',0,0,1,0,1,1,0,1,0,0)
 calls=[]
 def geometry(id):
  calls.append(id); path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(b'\\x01'+struct.pack('<4d',0,1,0,1)+wkb); return (wkb,0.,1.,0.,1.)
 overture=types.SimpleNamespace(_upstream_glob=lambda **kw:glob,_division_polygon_disk_path=lambda *args:path,_resolve_division_geometry=geometry)
 geocode=types.SimpleNamespace(resolve_area=lambda query: {'name':'Houston','division_id':division,'admin_context':[]})
 resources=types.SimpleNamespace(data_version_payload=lambda:{'release':release,'source':'fictional'})
 sys.modules['placeroot']=types.SimpleNamespace(overture=overture,geocode=geocode,resources=resources)
 result=b.prepare_boundary(); assert calls==[division]; assert result['release']==release; assert result['bytes']==path.stat().st_size
 assert all(s['outcome']=='ok' for s in result['stages'])
 overture._resolve_division_geometry=lambda id:(b'bad',0.,1.,0.,1.)
 try: b.prepare_boundary(); raise AssertionError('mismatch accepted')
 except b.BoundaryFailure: pass
 path.write_bytes(b'\\x00'); calls.clear()
 try: b.prepare_boundary(); raise AssertionError('cached miss accepted')
 except b.BoundaryFailure: pass
 assert calls==[], 'unsafe existing cache must not invoke native resolver or be overwritten'
 assert path.read_bytes()==b'\\x00'
 path.unlink(); path.symlink_to('/dev/null')
 try: b.prepare_boundary(); raise AssertionError('symlink accepted')
 except b.BoundaryFailure: pass
 assert calls==[]
 print('fictional native checks passed')
`;
  const result = spawnSync('/usr/bin/python3',['-I','-S','-B','-c',script], {encoding:'utf8'});
  assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/fictional native checks passed/);
});
