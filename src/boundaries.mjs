import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hash, now, fail } from './contracts.mjs';
import { requestId, requirePilot, transaction } from './sales.mjs';
import { operationRecord } from './pilot.mjs';
import { prepareBoundary as nativePrepareBoundary, inspectBoundaryCache as nativeInspectBoundaryCache } from './boundary-source.mjs';

export const BOUNDARY_OPERATIONS = {
  source_boundary_status:{description:'Read local exact-Houston readiness for the recorded source release only. No source calls, warming, live-version verification or supply qualification.',schema:z.object({}).strict(),readOnly:true},
  source_boundary_prepare:{description:'Explicitly reserve the ONE authorized six-minute exact native Houston boundary setup. Failure/interruption consumes this attempt; no retry, seed preparation or batch authority.',schema:z.object({requestId,authorized:z.literal(true)}).strict(),readOnly:false},
};
const KIND='boundary_preparation',DEADLINE_MS=360000;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const safeText=z.string().trim().min(1).max(1024).refine(v=>!/[\u0000-\u001f\u007f]|(?:password|secret|api[_-]?key|(?:access[_-]?)?token|authorization|credential)\s*[:=]|https?:\/\/[^\s]*[?@]/i.test(v));
const stages=z.array(z.object({stage:z.enum(['version','area','extension','schema','polygon','cache']),durationMs:z.number().finite().min(0).max(DEADLINE_MS),outcome:z.enum(['ok','failed','running'])}).strict()).max(24);
const receiptSchema=z.object({
  provider:z.literal('placeroot'),packageVersion:z.literal('0.12.0'),release:z.string().regex(/^20\d{2}-\d{2}-\d{2}\.\d{1,4}$/),
  divisionId:z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),areaName:z.literal('Houston'),
  cacheRelative:z.string().min(1).max(512).refine(v=>!v.startsWith('/')&&!v.includes('\\')&&v.split('/').every(p=>/^[a-zA-Z0-9_.-]+$/.test(p)&&p!=='.'&&p!=='..')),
  sourceGlobSha256:digest,cacheSha256:digest,bytes:z.number().int().min(1).max(32*1024*1024),
  bbox:z.tuple([z.number().finite().min(-180).max(180),z.number().finite().min(-180).max(180),z.number().finite().min(-90).max(90),z.number().finite().min(-90).max(90)]).refine(([xmin,xmax,ymin,ymax])=>xmin<xmax&&ymin<ymax),
  attribution:z.array(safeText).min(1).max(8),stages:stages.refine(v=>v.length>0&&v.every(s=>s.outcome==='ok')),
}).strict();
function validateReceipt(value) {
  const parsed=receiptSchema.safeParse(value);
  if(!parsed.success)fail('BOUNDARY_PROVENANCE','Boundary source receipt is unsafe, incomplete or outside the fixed contract.');
  const r=parsed.data,glob=hash(`s3://overturemaps-us-west-2/release/${r.release}/theme=divisions/type=division_area/*`);
  if(r.sourceGlobSha256!==glob||r.cacheRelative!==`cache/division_polygons/${glob.slice(0,16)}/${hash(r.divisionId).slice(0,32)}.bin`)fail('BOUNDARY_PROVENANCE','Boundary native cache key does not match its recorded release and division.');
  return parsed.data;
}
function freeze(value) { if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value; }
function rows(store) {
  return store.db.prepare('SELECT record FROM factory_operation WHERE kind=?').all(KIND).map(row=>{
    try {if(Buffer.byteLength(row.record)>64*1024)throw Error();const value=JSON.parse(row.record);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}
    catch {fail('BOUNDARY_NOT_READY','The retained boundary setup record is invalid; no automatic replacement is authorized.');}
  });
}
// Dependency injection is INTERNAL only. Never attach dependencies to the frozen store
// or accept them in public inputs. The production inspector does local reads only.
function checked(store,{inspectBoundaryCache=nativeInspectBoundaryCache}={}) {
  requirePilot(store);
  let all;try{all=rows(store);}catch{return {reason:'invalid_record'};}
  if(!all.length)return {reason:'not_prepared'};
  if(all.length!==1)return {reason:'invalid_record'};
  const row=all[0];
  if(row.state!=='prepared')return {row,reason:row.state==='failed'?'setup_failed':'setup_incomplete'};
  try {
    const receipt=validateReceipt(row.receipt);
    if(hash(receipt)!==row.receiptDigest)return {row,reason:'invalid_receipt'};
    if(inspectBoundaryCache(freeze(receipt))?.ready!==true)return {row,metadata:receipt,reason:'local_cache_unavailable'};
    return {row,receipt,reason:'ready_for_recorded_release'};
  } catch {return {row,reason:'local_cache_unavailable'};}
}
export function boundaryStatus(store,options={}) {
  const {row,receipt,metadata,reason}=checked(store,options);
  // Only validated receipt data may reach operator output, never cache paths,
  // geometry, raw inspector errors or arbitrary retained provider fields.
  return {ready:Boolean(receipt),reason,recordedRelease:(receipt??metadata)?.release??null,liveVerified:false,
    ...(row?{id:/^boundary-[a-f0-9]{32}$/.test(row.id)?row.id:null,state:['preparing','prepared','failed'].includes(row.state)?row.state:'unknown'}:{}),
    ...(receipt?{provider:receipt.provider,packageVersion:receipt.packageVersion,areaName:receipt.areaName,sourceGlobSha256:receipt.sourceGlobSha256,cacheSha256:receipt.cacheSha256,bytes:receipt.bytes,attribution:receipt.attribution,stages:receipt.stages}:{}),
    ...(row?.state==='failed'?{errorCode:Object.hasOwn(messages,row.errorCode)?row.errorCode:'BOUNDARY_PREPARATION_FAILED',stages:stages.safeParse(row.stages).success?row.stages:[]}:{}),
  };
}
export function requireBoundary(store,options={}) {
  const {receipt}=checked(store,options);
  if(!receipt)fail('BOUNDARY_NOT_READY','Exact Houston boundary is not locally ready for its recorded release. Explicit setup authority is required; no automatic rewarming.');
  return freeze(receipt);
}
const messages={
  BOUNDARY_PROVENANCE:'Boundary source receipt is unsafe, incomplete or outside the fixed contract.',
  BOUNDARY_DEADLINE:'Boundary setup reached its original six-minute deadline.',
  BOUNDARY_SOURCE_UNAVAILABLE:'The local boundary runtime is unavailable.',
  BOUNDARY_PREPARATION_FAILED:'Boundary preparation failed safely; source details were not retained.',
  BOUNDARY_SOURCE_TIMEOUT:'The boundary source reached its fixed deadline.',
  BOUNDARY_SOURCE_ABORTED:'The boundary source was interrupted.',
  BOUNDARY_SOURCE_PROCESS:'The boundary source process failed.',
  BOUNDARY_SOURCE_PROTOCOL:'The boundary source protocol was invalid.',
  BOUNDARY_SOURCE_IDENTITY:'The pinned boundary runtime identity did not match.',
  BOUNDARY_SOURCE_CACHE:'The local native boundary cache was not verified.',
  BOUNDARY_SOURCE_PROVENANCE:'The boundary source provenance was invalid.',
  BOUNDARY_SOURCE_RESPONSE_BOUND:'The boundary source exceeded its bounded response.',
  BOUNDARY_SOURCE_INSTALL_DRIFT:'The pinned local boundary installation changed.',
};
export async function boundaryDispatch(store,name,input,{prepareBoundary=nativePrepareBoundary,inspectBoundaryCache=nativeInspectBoundaryCache}={}) {
  requirePilot(store);
  const operation=BOUNDARY_OPERATIONS[name];if(!operation)fail('UNKNOWN_OPERATION','Unsupported boundary operation.');
  const parsed=operation.schema.safeParse(input);if(!parsed.success)fail('INVALID_INPUT','Invalid strict boundary operation input.');input=parsed.data;
  const options={inspectBoundaryCache};
  if(name==='source_boundary_status')return boundaryStatus(store,options);
  const requestKey=hash(input.requestId),inputDigest=hash(input);
  const reservation=transaction(store,()=>{
    const all=rows(store),old=all.find(row=>row.requestKey===requestKey);
    if(old){if(old.inputDigest!==inputDigest)fail('IDEMPOTENCY_CONFLICT','This boundary request ID records different input.');return {old};}
    if(all.length)fail('BOUNDARY_ALREADY_ATTEMPTED','Boundary setup is already reserved; no retry or replacement is authorized.');
    const row={id:`boundary-${randomUUID().replaceAll('-','')}`,requestKey,inputDigest,state:'preparing',startedAt:now()};
    operationRecord(store,row.id,KIND,row);return {row};
  });
  if(reservation.old) {
    if(reservation.old.state!=='prepared')fail('BOUNDARY_ALREADY_ATTEMPTED','Prior boundary setup failed, was interrupted or is in progress; it cannot repeat.');
    requireBoundary(store,options);return boundaryStatus(store,options);
  }
  const row=reservation.row,controller=new AbortController();let timer,work;
  try {
    if(typeof prepareBoundary!=='function')fail('BOUNDARY_SOURCE_UNAVAILABLE',messages.BOUNDARY_SOURCE_UNAVAILABLE);
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{
      // Reject before abort so a synchronous child-abort rejection cannot mask
      // the durable setup deadline category.
      const error=Object.assign(new Error(messages.BOUNDARY_DEADLINE),{code:'BOUNDARY_DEADLINE'});reject(error);controller.abort();
    },DEADLINE_MS);});
    work=Promise.resolve(prepareBoundary({signal:controller.signal}));
    const receipt=validateReceipt(await Promise.race([work,deadline]));
    if(inspectBoundaryCache(freeze(receipt))?.ready!==true)fail('BOUNDARY_PROVENANCE',messages.BOUNDARY_PROVENANCE);
    transaction(store,()=>operationRecord(store,row.id,KIND,{...row,state:'prepared',finishedAt:now(),receipt,receiptDigest:hash(receipt)}));
    return boundaryStatus(store,options);
  } catch(error) {
    controller.abort();
    // Native bridge settles only after its owned child is terminated/reaped.
    // Wait for that cleanup, never leave a timed-out child running in background.
    let sourceError;
    if(work)await work.catch(value=>{sourceError=value;});
    const errorCode=Object.hasOwn(messages,error?.code)?error.code:'BOUNDARY_PREPARATION_FAILED';
    const safeStages=stages.safeParse(error?.stages??sourceError?.stages);
    transaction(store,()=>operationRecord(store,row.id,KIND,{...row,state:'failed',finishedAt:now(),errorCode,message:messages[errorCode],stages:safeStages.success?safeStages.data:[]}));
    fail(errorCode,messages[errorCode]+' No automatic retry or replacement is authorized.');
  } finally {clearTimeout(timer);}
}
