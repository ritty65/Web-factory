import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync } from 'node:fs';
import { z } from 'zod';
import { hash, now, fail, publicUrl } from './contracts.mjs';
import { key, requestId, requirePilot, transaction } from './sales.mjs';
import { operationRecord } from './pilot.mjs';
import { existingEntity, suppressionFor, identitiesOverlap } from './batch-store.mjs';
import { requireBoundary } from './boundaries.mjs';
import { createSeedCapture, verifySeedCapture } from './seed-capture.mjs';

const MAX_BYTES = 1024 * 1024;
const receiptKey = z.string().regex(/^seed-[a-f0-9]{32}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const LOCAL_MODE = 'houston_local_radius_v1';
const LOCAL_ROOT = 'seed-0de2a46309d14565b96b5a87949952bd';
const LOCAL_PREDECESSOR = 'seed-b51d21e8dd56416daa89b0307cd3bbbf';
const LOCAL_PROVENANCE_FAILURE = 'seed-afd6bffd4b674fe6bd893d56963b8a1a';
const LOCAL_FOURTH_FAILURE = 'seed-1144bc0a7d9a4a4bb673c73ea73026e8';
const RECORD_POLICY = 'quarantine_v1';
export const SEED_OPERATIONS = {
  seed_prepare: { description:'Explicitly prepare ONE bounded unverified seed cohort under its exact approved failed-predecessor chain. Optional quarantine_v1 requires separately authorized fifth-record scope and private replay capture; no replacement or sixth preparation. Approximate discovery is never city eligibility, qualification or publication.', schema:z.object({presetVersion:z.number().int().min(0),requestId,authorized:z.literal(true),failedPreparationId:receiptKey.optional(),discoveryMode:z.enum([LOCAL_MODE]).optional(),recordPolicy:z.enum([RECORD_POLICY]).optional()}).strict(), readOnly:false },
  seed_get: { description:'Read a registered unverified seed receipt and verify its immutable bytes without source calls or writes.', schema:z.object({id:receiptKey}).strict(), readOnly:true },
};
const parse = row => row ? JSON.parse(row.record) : null;
const get = (store,id) => parse(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='seed_preparation'").get(id));
const invalid = () => fail('SEED_PROVENANCE','Seed source data is unsafe, incomplete or exceeds the bounded provenance contract.');
function nonempty(value) {
  return typeof value === 'string' ? Boolean(value.trim()) : Array.isArray(value) ? value.length > 0 && value.some(nonempty) : value && typeof value === 'object' ? Object.values(value).some(nonempty) : false;
}
function validLocation(location) {
  if(!location || typeof location!=='object' || Array.isArray(location))return false;
  const coordinateKeys=['lat','latitude','lon','lng','longitude','coordinates'];
  if(coordinateKeys.some(k=>Object.hasOwn(location,k))) {
    const lat=location.lat??location.latitude??location.coordinates?.[1],lon=location.lon??location.lng??location.longitude??location.coordinates?.[0];
    return typeof lat==='number' && Number.isFinite(lat) && Math.abs(lat)<=90 && typeof lon==='number' && Number.isFinite(lon) && Math.abs(lon)<=180;
  }
  return ['city','locality','address','formattedAddress'].some(k=>typeof location[k]==='string' && location[k].trim());
}
// Retain actual nested source metadata without interpreting it as trusted facts.
// Reject secret-bearing fields/URLs rather than storing and later trying to redact them.
function safeData(value,depth=0) {
  if(depth>12) invalid();
  if(value===null || typeof value==='boolean' || typeof value==='number' && Number.isFinite(value)) return;
  if(typeof value==='string') {
    if(value.length>8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid();
    for(const match of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
      try { const u=publicUrl(match[0]);if([...u.searchParams.keys()].some(k=>/key|token|secret|pass|auth|signature|credential/i.test(k))) invalid(); } catch { invalid(); }
    }
    if(/\b(?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]/i.test(value)) invalid();
    return;
  }
  if(Array.isArray(value)) { if(value.length>100) invalid();for(const v of value)safeData(v,depth+1);return; }
  if(value && Object.getPrototypeOf(value)===Object.prototype) {
    if(Object.keys(value).length>100) invalid();
    for(const [k,v] of Object.entries(value)) {
      if(k.length>100 || /(?:token|password|secret|credential|authorization|api[_-]?key|__proto__|constructor|prototype)/i.test(k)) invalid();
      safeData(v,depth+1);
    }
    return;
  }
  invalid();
}
function checkAdmission(summary,items) {
  if(!summary || summary.schemaVersion!==1 || !['sampled','attempted','admitted','quarantined'].every(k=>Number.isInteger(summary[k]) && summary[k]>=0 && summary[k]<=20) || summary.attempted!==summary.admitted+summary.quarantined || summary.attempted!==summary.sampled || !Array.isArray(summary.records) || summary.records.length!==summary.attempted)invalid();
  const admitted=new Set(),seen=new Set();let previousCall=0;
  for(const [index,record]of summary.records.entries()){
    if(!record || record.sampleIndex!==index || typeof record.sourceId!=='string' || !record.sourceId || record.sourceId.length>200 || seen.has(record.sourceId) || !Number.isInteger(record.callIndex) || record.callIndex<=previousCall || record.callIndex>27 || !digestSchema.safeParse(record.responseSha256).success)invalid();
    seen.add(record.sourceId);previousCall=record.callIndex;
    if(record.outcome==='admitted'){admitted.add(record.sourceId);if(record.code!==undefined || record.field!==undefined)invalid();}
    else if(record.outcome!=='quarantined' || !['SEED_SOURCE_PROVENANCE','SEED_SOURCE_LICENSE_UNKNOWN'].includes(record.code) || !['source_annotation','origin_record_id','origin_missing','source_license'].includes(record.field))invalid();
  }
  if(admitted.size!==summary.admitted || summary.records.length-admitted.size!==summary.quarantined || items.some(item=>!admitted.has(item.id)))invalid();
}
function checkAdmissionCapture(capture,summary) {
  const recorded=capture.events.find(event=>event.phase==='summary');
  if(capture.state!=='complete' || !recorded || recorded.sha256!==hash(summary) || summary.records.some(record=>!capture.events.some(event=>event.phase==='response' && event.tool==='place_details' && event.callIndex===record.callIndex && event.sha256===record.responseSha256)))fail('SEED_SOURCE_CAPTURE','Admission summary does not match its retained source receipts.');
}
function sourceData(source,discoveryMode,recordPolicy) {
  let bytes;try { bytes=JSON.stringify(source); } catch { invalid(); }
  if(!bytes || Buffer.byteLength(bytes)>MAX_BYTES) invalid();
  safeData(source);
  if(source.provider!=='placeroot' || !Number.isFinite(Date.parse(source.retrievedAt)) || Date.parse(source.retrievedAt)>Date.now()+300000 || !nonempty(source.version) || !nonempty(source.attribution) || !Array.isArray(source.limitations) || !source.limitations.every(v=>typeof v==='string' && v.trim()) || !Array.isArray(source.items) || !source.items.length || source.items.length>20) invalid();
  if(discoveryMode!==undefined && discoveryMode!==LOCAL_MODE)invalid();
  const discovery=source.version.discovery;
  if(discoveryMode===LOCAL_MODE) {
    if(!discovery || discovery.mode!==LOCAL_MODE || discovery.lat!==29.75893783569336 || discovery.lon!==-95.3676986694336 || discovery.radiusM!==15000 || discovery.cityEligibility!=='unknown' || !Array.isArray(discovery.pages) || !discovery.pages.length || discovery.pages.length>3 || discovery.pages.some(page=>!page || Object.getPrototypeOf(page)!==Object.prototype || !Object.keys(page).length))invalid();
  } else if(discovery!==undefined)invalid();
  if(recordPolicy!==undefined){if(recordPolicy!==RECORD_POLICY || discoveryMode!==LOCAL_MODE)invalid();checkAdmission(discovery.admissionSummary,source.items);}
  else if(source.version.recordPolicy!==undefined || source.version.sourceCaptureDigest!==undefined)invalid();
  const ids=new Set();
  for(const item of source.items) {
    if(!item || typeof item.id!=='string' || !item.id.trim() || item.id.length>200 || typeof item.name!=='string' || !item.name.trim() || item.name.length>300 || !validLocation(item.location) || !nonempty(item.categories) || !nonempty(item.provenance) || ids.has(item.id)) invalid();
    ids.add(item.id);
    // URLs may be a list or a provider-labelled object, never synthesized.
    const urls=[];
    const gather=v=>{if(typeof v==='string')urls.push(v);else if(Array.isArray(v))v.forEach(gather);else if(v && typeof v==='object')Object.values(v).forEach(gather);else if(v!==null && v!==undefined)invalid();};
    gather(item.urls);
    for(const url of urls)try{publicUrl(url);}catch{invalid();}
  }
  const {provider,retrievedAt,version,attribution,limitations,items}=JSON.parse(bytes);
  return {provider,retrievedAt,version,attribution,limitations,items};
}
function checkScope(s) {
  const caps={targetCount:1,candidateLimit:6,maxResearchRounds:2,maxSearches:16,discoverySearchLimit:6,maxInspections:48,maxImageViews:12,maxModelRequests:16,batchMinutes:90,jobMinutes:45};
  const niche=String(s?.niche||'').toLowerCase().replace(/; photo-rich independent no-site businesses$/,'');
  if(!s || s.area!=='Houston city limits' || s.workflow!=='leads_first' || s.searchProvider!=='firecrawl' || !/detailer/.test(niche) || !/baker/.test(niche) || !/event decorator/.test(niche) || niche.replace(/mobile|car|auto|detailers?|custom|bakers?|event decorators?|and|[\s,;/&+()-]/g,'')) fail('SEED_SCOPE','Seeds require the approved Houston city detailer/baker/event-decorator leads-first preset.');
  for(const [field,max] of Object.entries(caps))if(!Number.isInteger(s[field]) || s[field]<1 || s[field]>max)fail('SEED_SCOPE','Seeded work cannot expand the approved original allowances.');
}
function noLinks(target) {
  let current=path.resolve(target);
  for(;;) {
    try { if(lstatSync(current).isSymbolicLink())fail('SEED_PATH','Seed paths cannot contain symbolic links.'); } catch(e) { if(e.code!=='ENOENT')throw e; }
    const parent=path.dirname(current);if(parent===current)break;current=parent;
  }
}
function fileFor(store,id,create=false) {
  if(!receiptKey.safeParse(id).success)fail('SEED_RECEIPT','Invalid registered seed receipt.');
  const directory=path.join(store.stateRoot,'references','seed-cohorts');noLinks(directory);
  if(create)mkdirSync(directory,{recursive:true,mode:0o750});
  const file=path.join(directory,id+'.json');noLinks(file);return file;
}
function freeze(value) { if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value; }
function preview(receipt) {
  return {id:receipt.id,digest:receipt.digest,label:receipt.discoveryMode===LOCAL_MODE?'unverified local seeds / city eligibility unknown':'unverified seeds',...(receipt.discoveryMode?{discoveryMode:receipt.discoveryMode}:{}),...(receipt.recordPolicy?{recordPolicy:receipt.recordPolicy}:{}),provider:receipt.provider,retrievedAt:receipt.retrievedAt,version:receipt.version,attribution:receipt.attribution,count:receipt.items.length,limitations:receipt.limitations,items:receipt.items.map(({id,name,location,categories,urls})=>({id,name,location,categories,...(urls===undefined?{}:{urls})}))};
}
// Synchronous by design: caller can verify/claim inside its BEGIN IMMEDIATE.
// No filesystem content or SQL/path selection is supplied by the public caller.
export function validateSeedReceipt(store,reference,settings) {
  requirePilot(store);
  if(!receiptKey.safeParse(reference?.id).success || !digestSchema.safeParse(reference?.digest).success)fail('SEED_RECEIPT','Invalid registered seed receipt.');
  const row=get(store,reference.id);
  if(!row || row.state!=='prepared' || row.digest!==reference.digest)fail('SEED_RECEIPT','Seed receipt is missing, foreign or not successfully prepared.');
  const scope=settings || row.settings;checkScope(scope);
  if(hash(scope)!==row.settingsDigest || hash(row.settings)!==row.settingsDigest)fail('SEED_SCOPE','Seed receipt does not match this exact saved scope and allowances.');
  let bytes,fd;
  try {
    fd=openSync(fileFor(store,row.id),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(fd);if(!stat.isFile() || stat.nlink!==1 || stat.size>MAX_BYTES)fail('SEED_RECEIPT','Seed receipt is not a bounded immutable regular file.');
    bytes=readFileSync(fd);
  } catch { fail('SEED_RECEIPT','Seed receipt file is missing or unsafe.'); } finally { if(fd!==undefined)closeSync(fd); }
  if(bytes.length>MAX_BYTES || hash(bytes)!==row.digest)fail('SEED_RECEIPT','Seed receipt bytes changed.');
  let receipt;try{receipt=JSON.parse(bytes);}catch{fail('SEED_RECEIPT','Seed receipt is invalid.');}
  if(receipt.id!==row.id || receipt.schemaVersion!==1 || hash(receipt.settings)!==row.settingsDigest || receipt.presetVersion!==row.presetVersion)fail('SEED_RECEIPT','Seed receipt scope binding changed.');
   if(receipt.discoveryMode!==row.discoveryMode || receipt.recordPolicy!==row.recordPolicy || row.discoveryMode===LOCAL_MODE && (![LOCAL_PREDECESSOR,LOCAL_PROVENANCE_FAILURE,LOCAL_FOURTH_FAILURE].includes(receipt.retryOf) || receipt.retryOf!==row.retryOf || hash(receipt.version)!==row.sourceVersionDigest))fail('SEED_RECEIPT','Seed receipt discovery binding changed.');
   sourceData(receipt,row.discoveryMode,row.recordPolicy);
   if(row.recordPolicy){const capture=verifySeedCapture(store,row);if(capture.state!=='complete' || receipt.version.sourceCaptureDigest!==capture.digest || receipt.version.recordPolicy!==RECORD_POLICY)fail('SEED_RECEIPT','Seed replay evidence changed or is incomplete.');checkAdmissionCapture(capture,receipt.version.discovery.admissionSummary);}
  return freeze({...receipt,digest:row.digest});
}
export function claimSeedReceipt(store,receipt,batchId) {
  if(!store.db.isTransaction)fail('SEED_CLAIM','Claim must share the caller batch transaction.');
  if(!key.safeParse(batchId).success)fail('SEED_CLAIM','Invalid batch ID.');
  const verified=validateSeedReceipt(store,receipt,receipt.settings);
  const row=get(store,verified.id);
  if(row.claimedBatchId && row.claimedBatchId!==batchId)fail('SEED_CLAIM','This receipt already belongs to another batch; no replacement adoption.');
  if(!row.claimedBatchId)operationRecord(store,row.id,'seed_preparation',{...row,claimedBatchId:batchId,claimedAt:now()});
  return verified;
}
function seedIdentity(item) {
  const contacts={};const collect=value=>{if(typeof value==='string'){try{const u=publicUrl(value);if(/(^|\.)instagram\.com$/.test(u.hostname))contacts.instagram=value;if(/(^|\.)facebook\.com$/.test(u.hostname))contacts.facebook=value;}catch{}}else if(value && typeof value==='object')Object.values(value).forEach(collect);};collect(item.urls);
  return {name:item.name,area:'Houston',contacts};
}
export async function seedDispatch(store,name,input,options={}) {
  requirePilot(store);
  const operation=SEED_OPERATIONS[name];if(!operation)fail('UNKNOWN_OPERATION','Unsupported seed operation.');
  const parsed=operation.schema.safeParse(input);if(!parsed.success)fail('INVALID_INPUT','Invalid strict seed operation input.');input=parsed.data;
  if(input.recordPolicy && input.discoveryMode!==LOCAL_MODE)fail('INVALID_INPUT','Record quarantine requires explicit local discovery mode.');
  if(name==='seed_get') { const row=get(store,input.id);if(!row || row.state!=='prepared')fail('SEED_RECEIPT','No completed seed receipt exists.');return preview(validateSeedReceipt(store,{id:row.id,digest:row.digest})); }
  const requestKey=hash(input.requestId),inputDigest=hash(input);
  const reservation=transaction(store,()=>{
    const old=parse(store.db.prepare("SELECT record FROM factory_operation WHERE kind='seed_preparation' AND json_extract(record,'$.requestKey')=?").get(requestKey));
    if(old){if(old.inputDigest!==inputDigest)fail('IDEMPOTENCY_CONFLICT','This seed request ID already records different input.');return {old};}
    const preset=typeof options.preset==='function'?options.preset(store):options.preset;
    if(!preset?.adopted)fail('SEED_SCOPE','Adopt the approved saved preset before seed preparation.');
    if(preset.version!==input.presetVersion)fail('STALE_PRESET','Saved preset changed before seed preparation.');
    checkScope(preset.settings);
    const prior=store.db.prepare("SELECT record FROM factory_operation WHERE kind='seed_preparation'").all().map(parse);
    if(input.discoveryMode===LOCAL_MODE){
      const root=prior.find(v=>v.id===LOCAL_ROOT),child=prior.find(v=>v.id===LOCAL_PREDECESSOR);
      const corrected=input.failedPreparationId===LOCAL_PROVENANCE_FAILURE,third=prior.find(v=>v.id===LOCAL_PROVENANCE_FAILURE),fourth=prior.find(v=>v.id===LOCAL_FOURTH_FAILURE);
      const fixedChain=root && child && !root.retryOf && child.retryOf===LOCAL_ROOT && root.discoveryMode===undefined && child.discoveryMode===undefined;
      const approvedPredecessor=input.recordPolicy===RECORD_POLICY ? input.failedPreparationId===LOCAL_FOURTH_FAILURE && prior.length===4 && third?.retryOf===LOCAL_PREDECESSOR && third.discoveryMode===LOCAL_MODE && third.errorCode==='SEED_SOURCE_PROVENANCE' && fourth?.retryOf===LOCAL_PROVENANCE_FAILURE && fourth.discoveryMode===LOCAL_MODE && fourth.errorCode==='SEED_SOURCE_PROVENANCE' && fourth.sourceDiagnostic?.tool==='place_details' && fourth.sourceDiagnostic?.callIndex===11 && fourth.sourceDiagnostic?.field==='source_annotation' && prior.every(v=>v.recordPolicy===undefined) : corrected ? prior.length===3 && third?.retryOf===LOCAL_PREDECESSOR && third.discoveryMode===LOCAL_MODE && third.errorCode==='SEED_SOURCE_PROVENANCE' : input.failedPreparationId===LOCAL_PREDECESSOR && prior.length===2;
      if(!fixedChain || !approvedPredecessor || prior.some(v=>v.state!=='failed' || v.claimedBatchId || v.presetVersion!==preset.version || v.settingsDigest!==hash(preset.settings) || hash(v.settings)!==v.settingsDigest))fail('SEED_ALREADY_ATTEMPTED','Local proof requires its exact approved failed predecessor chain under unchanged scope; no automatic replacement or fifth preparation.');
    }else if(input.failedPreparationId){
      const parent=prior.find(v=>v.id===input.failedPreparationId);
      if(prior.length!==1||!parent||parent.state!=='failed'||parent.claimedBatchId||parent.retryOf||parent.presetVersion!==preset.version||parent.settingsDigest!==hash(preset.settings))fail('SEED_ALREADY_ATTEMPTED','Explicit retry needs the single exact failed unclaimed root under unchanged scope; only one child is permitted.');
    }else if(prior.length)fail('SEED_ALREADY_ATTEMPTED','A preparation is already recorded; no automatic retry or replacement cohort.');
    const boundary=input.discoveryMode===LOCAL_MODE?undefined:(options.boundaryPreflight||requireBoundary)(store);
    const row={id:`seed-${randomUUID().replaceAll('-','')}`,requestKey,inputDigest,presetVersion:preset.version,settings:JSON.parse(JSON.stringify(preset.settings)),settingsDigest:hash(preset.settings),state:'preparing',startedAt:now(),claimedBatchId:null,...(input.failedPreparationId?{retryOf:input.failedPreparationId}:{}),...(input.discoveryMode?{discoveryMode:input.discoveryMode}:{}),...(input.recordPolicy?{recordPolicy:input.recordPolicy}:{})};
    operationRecord(store,row.id,'seed_preparation',row);return {row,boundary};
  });
  if(reservation.old){const row=reservation.old;if(row.state!=='prepared')fail('SEED_ALREADY_ATTEMPTED','Prior preparation failed or was interrupted/in progress; it cannot be repeated.');return preview(validateSeedReceipt(store,{id:row.id,digest:row.digest}));}
  const row=reservation.row,controller=new AbortController();let timer,capture;
  try {
    if(typeof options.collectSeeds!=='function')fail('SEED_SOURCE_UNAVAILABLE','Seed collector is unavailable.');
    if(row.recordPolicy)capture=await createSeedCapture(store,row,{signal:controller.signal});
    const source=sourceData(await Promise.race([
       options.collectSeeds({settings:freeze(JSON.parse(JSON.stringify(row.settings))),signal:controller.signal,boundary:reservation.boundary,...(row.discoveryMode?{discoveryMode:row.discoveryMode}:{}),...(capture?{recordPolicy:row.recordPolicy,recordSourceEvent:capture.recordSourceEvent}:{})}),
      new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();try{fail('SEED_DEADLINE','Preparation reached its original ten-minute deadline.');}catch(e){reject(e);}},10*60000);}),
    ]),row.discoveryMode,row.recordPolicy);
    if(capture){const journal=await capture.finish('complete');checkAdmissionCapture(journal,source.version.discovery.admissionSummary);source.version={...source.version,recordPolicy:row.recordPolicy,sourceCaptureDigest:journal.digest};}
    const seen=[];let filtered=0;
    const items=source.items.filter(item=>{const identity=seedIdentity(item);if(existingEntity(store,identity)||suppressionFor(store,identity)||seen.some(prior=>identitiesOverlap(prior,identity))){filtered++;return false;}seen.push(identity);return true;});
    items.sort((a,b)=>Object.keys(seedIdentity(b).contacts).length-Object.keys(seedIdentity(a).contacts).length);
    if(!items.length)fail('SEED_EMPTY','No usable new seed identities remain.');
    const receipt={schemaVersion:1,id:row.id,presetVersion:row.presetVersion,settings:row.settings,...(row.discoveryMode?{discoveryMode:row.discoveryMode,retryOf:row.retryOf}:{}),...(row.recordPolicy?{recordPolicy:row.recordPolicy}:{}),...source,items,limitations:[...source.limitations,'Unverified discovery pointers only: missing website is not absence, location/activity/material/contact/rights remain unproved.',...(row.discoveryMode===LOCAL_MODE?['Approximate local-radius discovery only; Houston city eligibility unknown and requires independent first-party verification.']:[]),...(filtered?[`${filtered} existing, suppressed or duplicate identities omitted.`]:[])]};
    const bytes=Buffer.from(JSON.stringify(receipt));if(bytes.length>MAX_BYTES)invalid();
    const file=fileFor(store,row.id,true);let fd;
    try{fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o440);writeFileSync(fd,bytes);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
    transaction(store,()=>operationRecord(store,row.id,'seed_preparation',{...row,...(capture?{sourceCapture:get(store,row.id).sourceCapture}:{}),state:'prepared',digest:hash(bytes),...(row.discoveryMode?{sourceVersionDigest:hash(source.version)}:{}),finishedAt:now()}));
    return preview(validateSeedReceipt(store,{id:row.id,digest:hash(bytes)},row.settings));
  } catch(e) {
    controller.abort();
    if(capture && get(store,row.id)?.sourceCapture?.state==='collecting'){try{await capture.finish('incomplete');}catch{/* Preserve the last durable capture prefix. */}}
    // Never retain provider error bodies, stack traces or arbitrary source values.
    const messages={SEED_EMPTY:'No usable new seed identities remain.',SEED_PROVENANCE:'Source provenance is incomplete, unsafe or oversized.',SEED_PATH:'Receipt storage contains an unsafe path.',SEED_SOURCE_UNAVAILABLE:'The local seed collector is unavailable.',SEED_DEADLINE:'Preparation reached its original ten-minute deadline.',SEED_PREPARATION_FAILED:'Seed preparation failed safely; source details were not retained.'};
    const knownSource=/^SEED_SOURCE_(?:PROCESS|RESPONSE_BOUND|REQUEST_BOUND|PROTOCOL|SCHEMA|ABORTED|PROVENANCE|INCOMPLETE|URL|LICENSE_UNKNOWN|IDENTITY|TIMEOUT|CALL_LIMIT|VERSION|CATEGORY|AREA|EMPTY|UNAVAILABLE|BOUNDARY_NOT_READY|BOUNDARY_STALE|PAGINATION|MODE|CAPTURE)$/.test(e?.code||'');
    const errorCode=Object.hasOwn(messages,e?.code)||knownSource?e.code:'SEED_PREPARATION_FAILED';
    const message=knownSource?'The source connector stopped in the recorded failure category; provider details were not retained.':messages[errorCode];
    const d=e?.diagnostic;
    const sourceDiagnostic=knownSource && d && Object.keys(d).sort().join(',')==='callIndex,field,tool' && ['data_version','search_categories','geocode','find_places','place_details','unspecified'].includes(d.tool) && Number.isInteger(d.callIndex) && d.callIndex>=0 && d.callIndex<=28 && ['origin_record_id','source_license','source_annotation','origin_missing','unspecified'].includes(d.field) ? {tool:d.tool,callIndex:d.callIndex,field:d.field} : null;
    transaction(store,()=>operationRecord(store,row.id,'seed_preparation',{...row,...(get(store,row.id)?.sourceCapture?{sourceCapture:get(store,row.id).sourceCapture}:{}),state:'failed',finishedAt:now(),errorCode,message,...(sourceDiagnostic?{sourceDiagnostic}:{})}));
    fail(errorCode,message+' No automatic retry or replacement is authorized.');
  } finally { clearTimeout(timer); }
}
