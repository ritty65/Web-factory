import { z } from 'zod';
import { hash, now, fail, publicUrl } from './contracts.mjs';
import { transaction } from './sales.mjs';
import { providerHttp } from './provider-http.mjs';

const key = z.string().regex(/^[a-z0-9][a-z0-9-]{7,95}$/);
const word = z.string().trim().min(1).max(300).refine(v => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v));
const url = z.string().max(1800).refine(v => { try { return publicUrl(v).href === v || !!publicUrl(v); } catch { return false; } });
const stamp = z.string().datetime({ offset: true });
const row = z.object({ name: word, area: word, phone: z.string().max(40).default(''), website: z.union([url,z.literal('')]).default(''), sourceUrl: url, sourceId: z.string().max(200).default(''), observedAt: stamp, provider: z.enum(['manual','csv','google_places']).default('manual') }).strict();
const gateNames = ['identity','location','activity','websiteNeed','contact','content'];
const gate = z.object({ status: z.enum(['pass','fail','unknown']), sourceUrl: url, checkedAt: stamp, note: z.string().trim().min(8).max(1500) }).strict();
const op = (description,schema,readOnly=false) => ({description,schema,readOnly});
export const LEAD_WORKSPACE_OPERATIONS = {
  leads_import: op('Import bounded unverified pointers; preserve provenance and duplicates. Never qualifies or starts work.',z.object({requestId:key,rows:z.array(row.extend({provider:z.literal('manual').default('manual')})).min(1).max(100)}).strict()),
  leads_csv: op('Parse a bounded CSV into unverified pointers. Every row needs a source and observation date.',z.object({requestId:key,csv:z.string().min(1).max(200000)}).strict()),
  leads_list: op('Read paginated pointers with current qualification gaps and freshness. No provider calls.',z.object({offset:z.number().int().min(0).max(100000).default(0),limit:z.number().int().min(1).max(100).default(30),query:z.string().max(200).default('')}).strict(),true),
  leads_get: op('Read one pointer, its bounded provenance and declared evidence. Not authenticated source truth.',z.object({id:key}).strict(),true),
  leads_review: op('Save exact-version operator-declared evidence; never an automatic native verification or site build.',z.object({id:key,version:z.number().int().min(0),reviewer:word,gates:z.object(Object.fromEntries(gateNames.map(n=>[n,gate]))).strict(),resolveSourceConflict:z.boolean().default(false),resolveIdentityConflict:z.boolean().default(false)}).strict()),
  leads_suppress: op('Permanently suppress this pointer locally; evidence/refresh cannot clear suppression.',z.object({id:key,reason:word}).strict()),
  leads_source_status: op('Read provider configuration, quota and unresolved attempts without external requests.',z.object({}).strict(),true),
  leads_source_resolve: op('Explicitly acknowledge a stranded source attempt as uncertain, preserving its consumed quota. No retry/refund/provider call.',z.object({id:key,startedAt:stamp,acknowledged:z.literal(true)}).strict()),
  leads_schedule_get: op('Read opt-in schedule and recent outcomes; startup alone never starts paid work.',z.object({}).strict(),true),
  leads_schedule_save: op('Explicitly enable/disable one daily discovery schedule. One attempt per Chicago calendar date, within shared quota; no website builds or sending.',z.object({version:z.number().int().min(0),enabled:z.boolean(),query:word,area:word,hour:z.number().int().min(0).max(23),minute:z.number().int().min(0).max(59).default(0),timeZone:z.literal('America/Chicago'),termsReviewed:z.literal(true),authorized:z.literal(true)}).strict()),
  leads_schedule_pause: op('Disable future scheduled source work immediately; never resets source usage or changes past outcomes.',z.object({version:z.number().int().min(1)}).strict()),
  leads_schedule_tick: op('Run one due, explicitly enabled schedule slot. Replayed slots never retry an uncertain paid request.',z.object({}).strict()),
  leads_discover: op('Explicit bounded Google Places search: one paid-capable request, at most 20 pointers, no qualification.',z.object({requestId:key,query:word,area:word,termsReviewed:z.literal(true),authorized:z.literal(true)}).strict()),
};
const getRecord=(store,id,kind)=>{const r=store.db.prepare('SELECT record FROM factory_operation WHERE id=? AND kind=?').get(id,kind);return r?JSON.parse(r.record):null;};
const put=(store,id,kind,value)=>{const result=store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record WHERE factory_operation.kind=excluded.kind').run(id,kind,JSON.stringify(value));if(!result.changes)fail('STATE_NAMESPACE','Record identity belongs to a different operation type; no existing data was replaced');return result;};
const all=(store,kind)=>store.db.prepare('SELECT record FROM factory_operation WHERE kind=? ORDER BY rowid DESC').all(kind).map(r=>JSON.parse(r.record));
function getLead(store,id){const r=getRecord(store,id,'workspace_lead');if(!r)fail('NOT_FOUND','Lead not found');return r;}
const normalize=v=>v.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function normalizePhone(v){const digits=v.replace(/\D/g,'');if(!digits){if(v.trim())fail('LEAD_PHONE','Phone needs digits, or leave it empty');return '';}const n=digits.length===10?'1'+digits:digits;if(n.length<8||n.length>15)fail('LEAD_PHONE','Phone needs 8–15 digits');return '+'+n;}
const fresh=t=>Number.isFinite(Date.parse(t))&&Date.parse(t)<=Date.now()+300000&&Date.now()-Date.parse(t)<7*86400000;
export function qualifyLead(r){
  const gaps=[];
  for(const n of gateNames){const g=r.gates?.[n];if(!g||g.status!=='pass'||!fresh(g.checkedAt))gaps.push(`${n}: ${g?.status==='fail'?'failed':g&&!fresh(g.checkedAt)?'evidence expired':'needs source review'}`);}
  if(r.suppression)gaps.unshift('Suppressed: '+r.suppression.reason);
  if(r.identityConflict)gaps.push('Conflicting provider/contact identity needs manual resolution');
  if(r.providerHold)gaps.push('Provider reports changed/closed operating status; recheck current activity before clearing the hold');
  const sourceFresh=r.sources.some(s=>fresh(s.observedAt));if(!sourceFresh)gaps.push('All discovery pointers are stale');
  return {...r,qualification:{state:r.suppression?'suppressed':gaps.length?'needs_review':'operator_reviewed',gaps,provenance:'operator_declared_not_native_verification',buildAuthorized:false,publicRelease:false},pointerFresh:sourceFresh};
}
export function parseLeadCsv(input){
  // RFC4180 quoting including embedded newlines, bounded before parsing.
  if(Buffer.byteLength(input)>200000)fail('CSV_LIMIT','CSV exceeds 200 KiB');
  const rows=[];let cells=[],cell='',quoted=false,closed=false;
  for(let i=0;i<input.length;i++){
    const c=input[i];
    if(quoted){if(c==='"'){if(input[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;}
    else if(c==='"'){if(cell||closed)fail('CSV_FORMAT','Malformed CSV quoting');quoted=true;}
    else if(c===','||c==='\n'||c==='\r'){cells.push(cell);cell='';closed=false;if(c!==','){if(c==='\r'&&input[i+1]==='\n')i++;if(cells.some(Boolean))rows.push(cells);cells=[];}}
    else{if(closed)fail('CSV_FORMAT','Characters after closing CSV quote');cell+=c;}
    if(rows.length>101||cell.length>10000||cells.length>12)fail('CSV_LIMIT','CSV has too many rows, columns or oversized fields');
  }
  if(quoted)fail('CSV_FORMAT','Unclosed CSV quote');if(cell||cells.length){cells.push(cell);rows.push(cells);}
  const headers=rows.shift()?.map(v=>v.replace(/^\uFEFF/,'').trim());
  const fields=['name','area','phone','website','sourceUrl','sourceId','observedAt'];
  if(!headers||new Set(headers).size!==headers.length||headers.some(h=>!fields.includes(h))||!['name','area','sourceUrl','observedAt'].every(h=>headers.includes(h)))fail('CSV_HEADER','Use name,area,sourceUrl,observedAt; optional phone,website,sourceId');
  if(!rows.length||rows.length>100)fail('CSV_LIMIT','Import 1–100 rows');
  return rows.map(c=>{if(c.length!==headers.length)fail('CSV_FORMAT','CSV row does not match its headers');const parsed=row.safeParse({...Object.fromEntries(headers.map((h,i)=>[h,c[i]])),provider:'csv'});if(!parsed.success)fail('CSV_ROW','A row has missing/invalid fields, source URL or timestamp');return parsed.data;});
}
function importRows(store,requestId,rows){
  const receiptId='lead-import-'+hash(requestId).slice(0,24),digest=hash(rows);
  return transaction(store,()=>{
    const prior=getRecord(store,receiptId,'lead_import');if(prior){if(prior.inputDigest!==digest)fail('IDEMPOTENCY_CONFLICT','Import request already contains different rows');return {...prior,replayed:true};}
    // Load once per transaction, not once per row. Refreshes must remain possible
    // at capacity; only a genuinely new identity consumes another storage slot.
    const existing=all(store,'workspace_lead');
    const byId=new Map(existing.map(r=>[r.id,r]));
    const ids=[],quarantined=[];
    for(const [i,input] of rows.entries()){
      if(!normalize(input.name)||!normalize(input.area)){quarantined.push({row:i+1,reason:'AMBIGUOUS_IDENTITY'});continue;}
      if(!fresh(input.observedAt)){quarantined.push({row:i+1,reason:'STALE_OR_FUTURE_POINTER'});continue;}
      let phone;try{phone=normalizePhone(input.phone);}catch{quarantined.push({row:i+1,reason:'INVALID_PHONE'});continue;}
      const source={...input,phone};
      // Match a provider identity first, otherwise exact normalized name + area.
      // A shared phone/domain alone never silently merges different businesses.
      const byProvider=source.sourceId&&existing.find(r=>r.sources.some(s=>s.provider===source.provider&&s.sourceId===source.sourceId));
      const id=byProvider?.id||'pointer-'+hash({name:normalize(source.name),area:normalize(source.area)}).slice(0,24);
      const priorLead=byId.get(id);
      if(!priorLead&&byId.size>=5000)fail('LEAD_CAP','Workspace limit reached; archive/export before importing new identities. Existing identities can still refresh.');
      const changed=priorLead&&(normalize(priorLead.name)!==normalize(source.name)||normalize(priorLead.area)!==normalize(source.area)||!!(priorLead.phone&&phone&&priorLead.phone!==phone)||!!(priorLead.website&&source.website&&priorLead.website!==source.website)||!!(source.sourceId&&priorLead.sources.some(s=>s.provider===source.provider&&s.sourceId&&s.sourceId!==source.sourceId)));
      const collision=existing.some(r=>r.id!==id&&phone&&r.phone===phone);
      const duplicateSource=priorLead?.sources.some(s=>hash(s)===hash(source));
      const sources=duplicateSource?priorLead.sources:[...(priorLead?.sources||[]),source].slice(-30);
      const r=priorLead?{...priorLead,sources,identityConflict:priorLead.identityConflict||!!changed||collision,version:priorLead.version+(duplicateSource?0:1),updatedAt:now()}:
        {id,name:source.name,area:source.area,phone,website:source.website,sources,gates:{},version:0,createdAt:now(),updatedAt:now(),identityConflict:collision,suppression:null};
      // New pointers do not refresh old qualification or clear suppression.
      put(store,id,'workspace_lead',r);byId.set(id,r);const position=existing.findIndex(x=>x.id===id);if(position<0)existing.push(r);else existing[position]=r;ids.push(id);
    }
    const receipt={id:receiptId,inputDigest:digest,ids:[...new Set(ids)],quarantined,rows:rows.length,at:now(),replayed:false};put(store,receiptId,'lead_import',receipt);return receipt;
  });
}
export function leadSourceStatus(store){
  const runs=all(store,'lead_source_run'),recent=runs.filter(r=>Date.now()-Date.parse(r.startedAt)<86400000);
  const failures=recent.filter(r=>['failed','uncertain'].includes(r.state)&&Date.now()-Date.parse(r.startedAt)<1800000);
  return {provider:'google_places',configured:!!process.env.FACTORY_GOOGLE_PLACES_KEY,liveVerified:false,callsLast24h:recent.length,callLimit:3,circuitOpen:failures.length>=3,unresolved:runs.filter(r=>r.state==='requesting').map(r=>({id:r.id,startedAt:r.startedAt})),fallback:'Manual entry and CSV remain available. No automatic provider switch.',limits:'3 request attempts per rolling 24h, max 20 pointers per attempt. Attempts are not a dollar cap.',terms:'Review Google Places storage, display and attribution rules for your account before enabling. Returned data is unverified; missing website fields never prove absence.'};
}
export async function leadWorkspaceDispatch(store,name,input,{request=providerHttp,clock=()=>new Date()}={}){
  if(name==='leads_import')return importRows(store,input.requestId,input.rows);
  if(name==='leads_csv')return importRows(store,input.requestId,parseLeadCsv(input.csv));
  if(name==='leads_list'){const q='%'+input.query.toLowerCase().replace(/[\\%_]/g,'\\$&')+'%';const where="kind='workspace_lead' AND lower(json_extract(record,'$.name')||' '||json_extract(record,'$.area')) LIKE ? ESCAPE '\\'";const total=store.db.prepare('SELECT count(*) n FROM factory_operation WHERE '+where).get(q).n;const rows=store.db.prepare('SELECT record FROM factory_operation WHERE '+where+' ORDER BY rowid DESC LIMIT ? OFFSET ?').all(q,input.limit,input.offset).map(r=>qualifyLead(JSON.parse(r.record)));return {items:rows,total,offset:input.offset,nextOffset:input.offset+input.limit<total?input.offset+input.limit:null};}
  if(name==='leads_get')return qualifyLead(getLead(store,input.id));
  if(name==='leads_source_status')return leadSourceStatus(store);
  if(name==='leads_schedule_get')return {schedule:getRecord(store,'lead-schedule','lead_schedule')||{version:0,enabled:false},recent:all(store,'lead_schedule_day').slice(0,10)};
  if(name==='leads_schedule_pause')return transaction(store,()=>{const r=getRecord(store,'lead-schedule','lead_schedule');if(!r||r.version!==input.version)fail('STALE_EVIDENCE','Schedule changed; reload before pausing');const paused={...r,enabled:false,version:r.version+1,savedAt:now()};put(store,'lead-schedule','lead_schedule',paused);return paused;});
  if(name==='leads_schedule_save')return transaction(store,()=>{const previous=getRecord(store,'lead-schedule','lead_schedule');if((previous?.version||0)!==input.version)fail('STALE_EVIDENCE','Schedule changed; reload before saving');const r={...input,version:input.version+1,savedAt:now()};put(store,'lead-schedule','lead_schedule',r);return r;});
  if(name==='leads_schedule_tick'){
    const config=getRecord(store,'lead-schedule','lead_schedule');if(!config?.enabled)return {state:'disabled',called:false};
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:config.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(clock()).map(p=>[p.type,p.value]));
    if(Number(parts.hour)*60+Number(parts.minute)<config.hour*60+config.minute)return {state:'not_due',called:false};
    const date=`${parts.year}-${parts.month}-${parts.day}`,slotId='schedule-day-'+date,prior=getRecord(store,slotId,'lead_schedule_day');
    if(prior)return {...prior,replayed:true,called:false};
    if(!process.env.FACTORY_GOOGLE_PLACES_KEY)return {state:'needs_configuration',called:false};
    const slot=transaction(store,()=>{const existing=getRecord(store,slotId,'lead_schedule_day');if(existing)return null;const r={id:slotId,date,configVersion:config.version,configDigest:hash(config),state:'reserved',startedAt:now(),requestId:'scheduled-'+date};put(store,slotId,'lead_schedule_day',r);return r;});
    if(!slot)return {state:'already_reserved',called:false};
    try{const result=await leadWorkspaceDispatch(store,'leads_discover',{requestId:slot.requestId,query:config.query,area:config.area,termsReviewed:true,authorized:true},{request,clock});const done={...slot,state:result.state==='completed'?'completed':result.state==='requesting'?'uncertain':'failed',sourceRunId:result.id,errorCode:result.errorCode||null,leadCount:result.ids?.length||0,completedAt:now()};put(store,slotId,'lead_schedule_day',done);return {...done,called:!result.replayed};}
    catch(e){const failed={...slot,state:'held',errorCode:/^(SOURCE_|LEAD_)/.test(e.code||'')?e.code:'SCHEDULE_FAILED',completedAt:now()};put(store,slotId,'lead_schedule_day',failed);return {...failed,called:false};}
  }
  if(name==='leads_source_resolve')return transaction(store,()=>{const r=getRecord(store,input.id,'lead_source_run');if(!r||r.startedAt!==input.startedAt)fail('STALE_EVIDENCE','The exact source attempt must match');if(r.state!=='requesting')return r;if(Date.now()-Date.parse(r.startedAt)<120000)fail('SOURCE_ACTIVE','Wait at least two minutes before acknowledging a stranded request');const updated={...r,state:'uncertain',completedAt:now(),errorCode:'SOURCE_UNCERTAIN',message:'Operator acknowledged an incomplete attempt. Charge and result remain unknown; consumed quota retained.'};put(store,r.id,'lead_source_run',updated);return updated;});
  if(name==='leads_suppress')return transaction(store,()=>{const r=getLead(store,input.id);if(!r.suppression){r.suppression={reason:input.reason,at:now()};r.version++;put(store,r.id,'workspace_lead',r);}return qualifyLead(r);});
  if(name==='leads_review')return transaction(store,()=>{const r=getLead(store,input.id);if(r.version!==input.version)fail('STALE_EVIDENCE','Lead changed; reload before reviewing');if(Object.values(input.gates).some(g=>!fresh(g.checkedAt)))fail('STALE_EVIDENCE','Review needs current dated evidence');
    if(input.resolveSourceConflict&&r.providerHold&&(input.gates.activity.status!=='pass'||Date.parse(input.gates.activity.checkedAt)<Date.parse(r.providerHold.at)||input.gates.activity.note.length<20))fail('SOURCE_CONFLICT','Clearing a provider hold needs a new positive activity observation after that hold');
    if(input.resolveIdentityConflict&&r.identityConflict&&(input.gates.identity.status!=='pass'||input.gates.identity.note.length<20))fail('SOURCE_CONFLICT','Clearing identity conflict needs a specific positive identity observation');
    const resolution=input.resolveSourceConflict||input.resolveIdentityConflict?{at:now(),reviewer:input.reviewer,providerHold:r.providerHold||null,identityConflict:r.identityConflict||false}:null;
    const updated={...r,gates:input.gates,reviewer:input.reviewer,version:r.version+1,updatedAt:now(),...(input.resolveSourceConflict?{providerHold:null}:{}),...(input.resolveIdentityConflict?{identityConflict:false}:{}),...(resolution?{conflictResolutions:[...(r.conflictResolutions||[]),resolution].slice(-20)}:{})};put(store,r.id,'workspace_lead',updated);return qualifyLead(updated);});
  if(name!=='leads_discover')fail('UNKNOWN_OPERATION','Unknown lead operation');
  const id='source-'+hash(input.requestId).slice(0,24),digest=hash(input);
  const cached=getRecord(store,id,'lead_source_run');if(cached){if(cached.inputDigest!==digest)fail('IDEMPOTENCY_CONFLICT','Source request already binds a different query');return {...cached,replayed:true};}
  if(!process.env.FACTORY_GOOGLE_PLACES_KEY)fail('LEAD_CONFIGURATION','Add FACTORY_GOOGLE_PLACES_KEY securely in environment settings. Manual and CSV intake work without it.');
  transaction(store,()=>{
    const status=leadSourceStatus(store);if(status.callsLast24h>=3||status.circuitOpen)fail('SOURCE_BUDGET','Source attempt limit/circuit reached; no call made');
    if(status.unresolved.length)fail('SOURCE_UNCERTAIN','A prior request has no final receipt. Inspect it before launching more paid-capable work; it is not automatically retried.');
    put(store,id,'lead_source_run',{id,inputDigest:digest,provider:'google_places',state:'requesting',startedAt:now(),usage:{requests:1,charge:'unknown'},ids:[]});
  });
  try{
    const response=await request('https://places.googleapis.com/v1/places:searchText',{headers:{'X-Goog-Api-Key':process.env.FACTORY_GOOGLE_PLACES_KEY,'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.googleMapsUri,places.businessStatus'},body:JSON.stringify({textQuery:input.query+' in '+input.area,pageSize:20}),timeout:20000});
    if(response.status!==200)fail(response.status===429?'SOURCE_RATE_LIMIT':response.status===401||response.status===403?'SOURCE_AUTH':'SOURCE_HTTP','Provider rejected the search; no automatic retry or fallback purchase');
    const data=JSON.parse(response.bytes.toString());if(!data||typeof data!=='object'||Array.isArray(data)||data.error||data.places!==undefined&&!Array.isArray(data.places)||data.places?.length>20)fail('SOURCE_SCHEMA','Unsupported provider result');
    const rows=[],quarantined=[];
    // Fresh negative provider evidence must hold an existing pointer, not leave
    // yesterday's positive operator review silently looking current.
    const inactiveIds=(data.places||[]).filter(p=>typeof p.id==='string'&&p.id&&p.businessStatus!=='OPERATIONAL').map(p=>p.id);
    if(inactiveIds.length)transaction(store,()=>{for(const lead of all(store,'workspace_lead'))if(lead.sources.some(s=>s.provider==='google_places'&&inactiveIds.includes(s.sourceId))){const updated={...lead,providerHold:{reason:'provider_status_not_operational',at:now()},version:lead.version+1,updatedAt:now()};put(store,lead.id,'workspace_lead',updated);}});
    for(const [i,p] of (data.places||[]).entries()){
      const parsed=row.safeParse({name:p.displayName?.text,area:p.formattedAddress,phone:p.nationalPhoneNumber||'',website:p.websiteUri||'',sourceUrl:p.googleMapsUri,sourceId:p.id,observedAt:now(),provider:'google_places'});
      if(!parsed.success||!p.id||p.businessStatus!=='OPERATIONAL'){quarantined.push({row:i+1,reason:!p.id?'MISSING_PROVIDER_ID':p.businessStatus!=='OPERATIONAL'?'STATUS_UNVERIFIED_OR_CLOSED':'MALFORMED_POINTER'});continue;}rows.push(parsed.data);
    }
    const receipt=rows.length?importRows(store,'google-'+input.requestId,rows):{ids:[],quarantined:[]};
    const run={...getRecord(store,id,'lead_source_run'),state:'completed',completedAt:now(),ids:receipt.ids,quarantined:[...quarantined,...receipt.quarantined],attribution:'Google Maps',qualificationEstablished:false};put(store,id,'lead_source_run',run);return run;
  }catch(e){const run={...getRecord(store,id,'lead_source_run'),state:'failed',completedAt:now(),errorCode:/^(SOURCE_|PROVIDER_|CANCELLED)/.test(e.code||'')?e.code:'SOURCE_RESPONSE_INVALID',message:'Search did not complete. Prior leads and consumed request remain; no automatic retry.'};put(store,id,'lead_source_run',run);return run;}
}
