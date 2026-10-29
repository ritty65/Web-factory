import path from 'node:path';
import { constants, lstatSync, mkdirSync, openSync, closeSync, fstatSync, writeFileSync, fsyncSync, readSync } from 'node:fs';
import { hash, fail } from './contracts.mjs';
import { operationRecord } from './pilot.mjs';
import { transaction } from './sales.mjs';

// Private application-level JSON representations, NOT original transport bytes.
// Files are deliberately not registered as downloadable Factory artifacts.
const CALL_BYTES=1024*1024, TOTAL_BYTES=16*CALL_BYTES, SUMMARY_BYTES=64*1024;
const TOOLS=['data_version','search_categories','geocode','find_places','place_details'];
const FAILURES=new Set(['PROCESS','RESPONSE_BOUND','REQUEST_BOUND','PROTOCOL','SCHEMA','ABORTED','PROVENANCE','INCOMPLETE','URL','LICENSE_UNKNOWN','IDENTITY','TIMEOUT','CALL_LIMIT','VERSION','CATEGORY','AREA','EMPTY','UNAVAILABLE','BOUNDARY_NOT_READY','BOUNDARY_STALE','PAGINATION','MODE','CAPTURE'].map(v=>'SEED_SOURCE_'+v));
const invalid=()=>fail('SEED_SOURCE_CAPTURE','Private source capture is missing, unsafe, changed or outside its bounded contract.');
const plain=v=>v && Object.getPrototypeOf(v)===Object.prototype;
const keys=(v,names)=>plain(v) && Object.keys(v).sort().join(',')===names.split(',').sort().join(',');
const digest=v=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const seedId=v=>typeof v==='string' && /^seed-[a-f0-9]{32}$/.test(v);
const copy=v=>JSON.parse(JSON.stringify(v));

function binding(row) {
  if(!seedId(row?.id) || !digest(row.inputDigest) || !digest(row.settingsDigest) || row.discoveryMode!=='houston_local_radius_v1' || row.recordPolicy!=='quarantine_v1' || row.retryOf!==undefined && !seedId(row.retryOf))invalid();
  return {id:row.id,inputDigest:row.inputDigest,settingsDigest:row.settingsDigest,discoveryMode:row.discoveryMode,recordPolicy:row.recordPolicy,retryOf:row.retryOf??null};
}
function stamp(bound,capture) {
  const {schemaVersion,state,events,totalBytes}=capture;
  return {...capture,digest:hash({binding:bound,schemaVersion,state,events,totalBytes})};
}
function registered(store,row) {
  const found=store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='seed_preparation'").get(row.id);
  if(!found)invalid();
  const latest=JSON.parse(found.record);
  if(hash(binding(latest))!==hash(binding(row)))invalid();
  return latest;
}
function noLinks(target) {
  for(let current=path.resolve(target);;current=path.dirname(current)) {
    try { const stat=lstatSync(current);if(stat.isSymbolicLink())invalid(); }
    catch(e){if(e.code!=='ENOENT')throw e;}
    if(path.dirname(current)===current)break;
  }
}
function privateStat(stat,directory) {
  if(stat.uid!==process.getuid() || (stat.mode&0o7777)!==(directory?0o700:0o600) || (directory?!stat.isDirectory():!stat.isFile() || stat.nlink!==1))invalid();
}
function roots(store,row) {
  binding(row);
  const parent=path.join(store.stateRoot,'references','seed-source-receipts');
  return {parent,directory:path.join(parent,row.id)};
}
function checkDirectories(parent,directory) {
  noLinks(directory);privateStat(lstatSync(parent),true);privateStat(lstatSync(directory),true);
}
function syncDirectory(directory) {
  let fd;
  try {fd=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);privateStat(fstatSync(fd),true);fsyncSync(fd);}
  finally {if(fd!==undefined)closeSync(fd);}
}
const filename=(directory,event)=>path.join(directory,`${event.callIndex}-${event.phase}.json`);

// Also validates prefixes from failed/interrupted preparations. Complete means
// no pending call, not that a diagnostic journal is an admitted seed cohort.
function sequence(events,state) {
  if(!Array.isArray(events) || events.length>55)invalid();
  let next=1,pending=null,ended=false,total=0,callBytes=0;
  for(const event of events) {
    if(!keys(event,'phase,callIndex,tool,bytes,sha256') || !Number.isInteger(event.bytes) || event.bytes<1 || !digest(event.sha256) || ended)invalid();
    total+=event.bytes;if(total>TOTAL_BYTES)invalid();
    if(event.phase==='summary') {
      if(event.callIndex!==0 || event.tool!=='collection' || event.bytes>SUMMARY_BYTES)invalid();
      ended=true;continue;
    }
    if(!TOOLS.includes(event.tool) || !Number.isInteger(event.callIndex) || event.callIndex<1 || event.callIndex>27)invalid();
    if(event.phase==='request') {
      if(pending || event.callIndex!==next)invalid();
      pending=event;callBytes=event.bytes;
    } else {
      if(!['response','failure'].includes(event.phase) || !pending || event.callIndex!==pending.callIndex || event.tool!==pending.tool)invalid();
      callBytes+=event.bytes;pending=null;next++;
    }
    if(callBytes>CALL_BYTES)invalid();
  }
  if(state==='complete' && pending)invalid();
  return total;
}
function checkCapture(bound,capture) {
  if(!keys(capture,'schemaVersion,state,events,totalBytes,digest') || capture.schemaVersion!==1 || !['collecting','complete','incomplete'].includes(capture.state) || !Number.isInteger(capture.totalBytes) || !digest(capture.digest))invalid();
  if(sequence(capture.events,capture.state)!==capture.totalBytes || stamp(bound,capture).digest!==capture.digest)invalid();
}
function load(store,row) {
  const bound=binding(row),latest=registered(store,row),capture=row.sourceCapture;
  checkCapture(bound,capture);
  if(hash(latest.sourceCapture)!==hash(capture))invalid();
  const {parent,directory}=roots(store,row);checkDirectories(parent,directory);
  const buffers=[];
  for(const event of capture.events) {
    let fd;
    try {
      checkDirectories(parent,directory);
      fd=openSync(filename(directory,event),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const before=fstatSync(fd);privateStat(before,false);
      if(before.size!==event.bytes)invalid();
      // Fixed allocation plus one byte detects growth without an unbounded read.
      const buffer=Buffer.alloc(event.bytes+1);let count=0,n;
      while(count<buffer.length && (n=readSync(fd,buffer,count,buffer.length-count,null))>0)count+=n;
      const after=fstatSync(fd);privateStat(after,false);
      if(count!==event.bytes || after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs)invalid();
      const bytes=buffer.subarray(0,count);if(hash(bytes)!==event.sha256)invalid();buffers.push(bytes);
    } finally {if(fd!==undefined)closeSync(fd);}
  }
  return {capture:copy(capture),buffers};
}
export function verifySeedCapture(store,row) {
  try {return load(store,row).capture;}catch {invalid();}
}
export function readSeedCaptureEvents(store,row) {
  try {
    const {capture,buffers}=load(store,row);
    // Parse only after every registered descriptor, binding and file is verified.
    return capture.events.map((event,index)=>({...event,value:JSON.parse(buffers[index].toString('utf8'))}));
  } catch {invalid();}
}

export function createSeedCapture(store,row,{signal}={}) {
  try {
    // Freeze primitive identity bindings against mutation of the caller's object.
    row={...row};
    const bound=binding(row),{parent,directory}=roots(store,row);
    if(signal?.aborted || registered(store,row).sourceCapture!==undefined)invalid();
    noLinks(directory);
    mkdirSync(path.dirname(parent),{recursive:true,mode:0o700});
    try {mkdirSync(parent,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
    privateStat(lstatSync(parent),true);
    mkdirSync(directory,{mode:0o700}); // Never reopen/resume an old run directory.
    checkDirectories(parent,directory);syncDirectory(directory);syncDirectory(parent);
    let capture=stamp(bound,{schemaVersion:1,state:'collecting',events:[],totalBytes:0});
    let failed=false,terminal=false;
    function persist(next,initial=false) {
      const update=()=>{
        const latest=registered(store,row);
        if(initial?latest.sourceCapture!==undefined:hash(latest.sourceCapture)!==hash(capture))invalid();
        operationRecord(store,row.id,'seed_preparation',{...latest,sourceCapture:next});
      };
      if(store.db.isTransaction)update();else transaction(store,update);
      capture=next;
    }
    persist(capture,true);
    return {
      // All filesystem/ledger operations are synchronous before the promise is
      // resolved: no outstanding write can race finish, abort or another event.
      async recordSourceEvent(event) {
        if(terminal || failed)invalid();
        try {
          if(signal?.aborted || !keys(event,'phase,callIndex,tool,value'))invalid();
          if(event.phase==='request' && (!keys(event.value,'name,arguments') || event.value.name!==event.tool || !plain(event.value.arguments)))invalid();
          if(event.phase==='failure' && (!keys(event.value,'code') || !FAILURES.has(event.value.code)))invalid();
          const text=JSON.stringify(event.value);if(typeof text!=='string')invalid();
          const bytes=Buffer.from(text),descriptor={phase:event.phase,callIndex:event.callIndex,tool:event.tool,bytes:bytes.length,sha256:hash(bytes)};
          const events=[...capture.events,descriptor],totalBytes=sequence(events,'collecting');
          const next=stamp(bound,{schemaVersion:1,state:'collecting',events,totalBytes});
          if(signal?.aborted)invalid();
          registered(store,row);checkDirectories(parent,directory);
          let fd;
          try {
            fd=openSync(filename(directory,descriptor),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
            privateStat(fstatSync(fd),false);writeFileSync(fd,bytes);fsyncSync(fd);privateStat(fstatSync(fd),false);
          } finally {if(fd!==undefined)closeSync(fd);}
          syncDirectory(directory);
          if(signal?.aborted)invalid();
          persist(next);
          return {...descriptor};
        } catch {failed=true;invalid();}
      },
      async finish(state) {
        try {
          if(!['complete','incomplete'].includes(state))invalid();
          if(terminal){if(capture.state!==state)invalid();return copy(capture);}
          // A failed/aborted sink may only seal its durable prefix incomplete.
          if(state==='complete' && (failed || signal?.aborted))invalid();
          sequence(capture.events,state);
          const next=stamp(bound,{...capture,state});
          persist(next);terminal=true;
          return copy(capture);
        } catch {failed=true;invalid();}
      },
    };
  } catch {invalid();}
}
