import { z } from 'zod';
import { hash, now, fail, publicUrl } from './contracts.mjs';
import { transaction } from './sales.mjs';
import { providerHttp } from './provider-http.mjs';
import { leadTarget, screenLead, leadHealth } from './lead-screening.mjs';
import { LEAD_RESEARCH_OPERATIONS, leadResearchDispatch } from './lead-research.mjs';

const key = z.string().regex(/^[a-z0-9][a-z0-9-]{7,95}$/);
const word = z.string().trim().min(1).max(300).refine(v => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v));
const url = z.string().max(1800).refine(v => { try { return publicUrl(v).href === v || !!publicUrl(v); } catch { return false; } });
const stamp = z.string().datetime({ offset: true });
const row = z.object({ name: word, area: word, phone: z.string().max(40).default(''), website: z.union([url,z.literal('')]).default(''), sourceUrl: url, sourceId: z.string().max(200).default(''), observedAt: stamp, provider: z.enum(['manual','csv','google_places']).default('manual') }).strict();
const gateNames = ['identity','location','activity','websiteNeed','contact','content'];
const gate = z.object({ status: z.enum(['pass','fail','unknown']), sourceUrl: url, checkedAt: stamp, note: z.string().trim().min(8).max(1500) }).strict();
const op = (description,schema,readOnly=false) => ({description,schema,readOnly});
export const LEAD_WORKSPACE_OPERATIONS = {
  ...LEAD_RESEARCH_OPERATIONS,
  leads_target_get: op('Read target area/service rules. No external requests.',z.object({}).strict(),true),
  leads_target_save: op('Save exact-version deterministic triage rules. Does not verify facts or authorize work.',z.object({version:z.number().int().min(0),target:leadTarget}).strict()),
  leads_health: op('Read lead freshness, quality gaps, source yield and scheduler alerts. No external requests.',z.object({}).strict(),true),
  leads_queue: op('Read a paginated review queue ranked by transparent research priority, never buying probability.',z.object({offset:z.number().int().min(0).max(100000).default(0),limit:z.number().int().min(1).max(100).default(30),query:z.string().max(200).default(''),state:z.enum(['all','research_first','reviewed_shortlist','needs_evidence','excluded']).default('all')}).strict(),true),
  leads_import: op('Import bounded unverified pointers; preserve provenance and duplicates. Never qualifies or starts work.',z.object({requestId:key,rows:z.array(row.extend({provider:z.literal('manual').default('manual')})).min(1).max(100)}).strict()),
  leads_csv: op('Parse a bounded CSV into unverified pointers. Every row needs a source and observation date.',z.object({requestId:key,csv:z.string().min(1).max(200000)}).strict()),
  leads_list: op('Read paginated pointers with current qualification gaps and freshness. No provider calls.',z.object({offset:z.number().int().min(0).max(100000).default(0),limit:z.number().int().min(1).max(100).default(30),query:z.string().max(200).default('')}).strict(),true),
  leads_get: op('Read one pointer, its bounded provenance and declared evidence. Not authenticated source truth.',z.object({id:key}).strict(),true),
  leads_review: op('Save exact-version operator-declared evidence; never an automatic native verification or site build.',z.object({id:key,version:z.number().int().min(0),reviewer:word,gates:z.object(Object.fromEntries(gateNames.map(n=>[n,gate]))).strict(),resolveSourceConflict:z.boolean().default(false),resolveIdentityConflict:z.boolean().default(false),resolveWebsiteConflict:z.boolean().default(false)}).strict()),
  leads_suppress: op('Permanently suppress this pointer locally; evidence/refresh cannot clear suppression.',z.object({id:key,reason:word}).strict()),
  leads_source_status: op('Read provider configuration, quota and unresolved attempts without external requests.',z.object({}).strict(),true),
  leads_source_resolve: op('Explicitly acknowledge a stranded source attempt as uncertain, preserving its consumed quota. No retry/refund/provider call.',z.object({id:key,startedAt:stamp,acknowledged:z.literal(true)}).strict()),
  leads_schedule_get: op('Read opt-in schedule and recent outcomes; startup alone never starts paid work.',z.object({}).strict(),true),
  leads_schedule_save: op('Explicit daily discovery. Rotate areas and optionally authorize up to three secondary searches daily. Pause on failure or saturation; no builds or sending.',z.object({version:z.number().int().min(0),enabled:z.boolean(),query:word,area:word,areas:z.array(word).min(1).max(12).optional(),researchEnabled:z.boolean().default(false),hour:z.number().int().min(0).max(23),minute:z.number().int().min(0).max(59).default(0),timeZone:z.literal('America/Chicago'),termsReviewed:z.literal(true),authorized:z.literal(true)}).strict()),
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
  if(r.websiteResearchHold)gaps.push('Secondary research found possible independent websites; inspect and explicitly resolve the website conflict');
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
  const withinTransaction=fn=>store.db.isTransaction?fn():transaction(store,fn);
  return withinTransaction(()=>{
    const prior=getRecord(store,receiptId,'lead_import');if(prior){if(prior.inputDigest!==digest)fail('IDEMPOTENCY_CONFLICT','Import request already contains different rows');return {...prior,replayed:true};}
    // Load once per transaction, not once per row. Refreshes must remain possible
    // at capacity; only a genuinely new identity consumes another storage slot.
    const existing=all(store,'workspace_lead');
    const byId=new Map(existing.map(r=>[r.id,r]));
    const ids=[],quarantined=[];let newCount=0,refreshedCount=0;
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
      // Flag both sides of a shared-phone conflict. Older reviewed records must
      // not remain apparently clear after another identity claims their number.
      if(collision)for(const other of existing.filter(r=>r.id!==id&&r.phone===phone&&!r.identityConflict)){
        const held={...other,identityConflict:true,version:other.version+1,updatedAt:now()};
        put(store,held.id,'workspace_lead',held);byId.set(held.id,held);existing[existing.findIndex(r=>r.id===held.id)]=held;
      }
      const duplicateSource=priorLead?.sources.some(s=>hash(s)===hash(source));
      const sources=duplicateSource?priorLead.sources:[...(priorLead?.sources||[]),source].slice(-30);
      const r=priorLead?{...priorLead,sources,identityConflict:priorLead.identityConflict||!!changed||collision,version:priorLead.version+(duplicateSource?0:1),updatedAt:now()}:
        {id,name:source.name,area:source.area,phone,website:source.website,sources,gates:{},version:0,createdAt:now(),updatedAt:now(),identityConflict:collision,suppression:null};
      // New pointers do not refresh old qualification or clear suppression.
      if(!ids.includes(id)){if(priorLead)refreshedCount++;else newCount++;}
      put(store,id,'workspace_lead',r);byId.set(id,r);const position=existing.findIndex(x=>x.id===id);if(position<0)existing.push(r);else existing[position]=r;ids.push(id);
    }
    const receipt={id:receiptId,inputDigest:digest,ids:[...new Set(ids)],newCount,refreshedCount,quarantined,rows:rows.length,at:now(),replayed:false};put(store,receiptId,'lead_import',receipt);return receipt;
  });
}
export function leadSourceStatus(store){
  const runs=all(store,'lead_source_run'),recent=runs.filter(r=>Date.now()-Date.parse(r.startedAt)<86400000);
  const failures=recent.filter(r=>['failed','uncertain'].includes(r.state)&&Date.now()-Date.parse(r.startedAt)<1800000);
  return {provider:'google_places',configured:!!process.env.FACTORY_GOOGLE_PLACES_KEY,liveVerified:runs.some(r=>r.state==='completed'&&r.transport==='live_api'),sustainedLeadQualityProven:false,callsLast24h:recent.length,callLimit:3,circuitOpen:failures.length>=3,unresolved:runs.filter(r=>r.state==='requesting').map(r=>({id:r.id,startedAt:r.startedAt})),fallback:'Manual entry and CSV remain available. No automatic provider switch.',limits:'3 request attempts per rolling 24h, max 20 pointers per attempt. Attempts are not a dollar cap.',terms:'Confirm your intended prospecting, retention, display and export use is permitted by the actual provider agreement before enabling. A terms checkbox is not a legal assessment. Returned data is unverified; missing website fields never prove absence.'};
}
export async function leadWorkspaceDispatch(store,name,input,{request=providerHttp,clock=()=>new Date()}={}){
  if(LEAD_RESEARCH_OPERATIONS[name])return leadResearchDispatch(store,name,input,{request});
  const targetRecord=()=>getRecord(store,'lead-target','lead_target');
  const decorate=lead=>({...qualifyLead(lead),screening:screenLead(lead,targetRecord()?.target)});
  if(name==='leads_target_get')return targetRecord()||{version:0,target:null};
  if(name==='leads_target_save')return transaction(store,()=>{const prior=targetRecord();if((prior?.version||0)!==input.version)fail('STALE_EVIDENCE','Target rules changed; reload first');const r={...input,version:input.version+1,savedAt:now()};put(store,'lead-target','lead_target',r);return r;});
  if(name==='leads_health')return leadHealth(all(store,'workspace_lead'),all(store,'lead_source_run'),getRecord(store,'lead-schedule','lead_schedule'),targetRecord()?.target);
  if(name==='leads_queue'){
    const target=targetRecord()?.target,query=normalize(input.query);
    const items=all(store,'workspace_lead').filter(l=>normalize(l.name+' '+l.area).includes(query)).map(l=>({...qualifyLead(l),screening:screenLead(l,target)})).filter(l=>input.state==='all'||l.screening.state===input.state);
    items.sort((a,b)=>b.screening.priority-a.screening.priority||a.id.localeCompare(b.id));
    return {items:items.slice(input.offset,input.offset+input.limit),total:items.length,offset:input.offset,nextOffset:input.offset+input.limit<items.length?input.offset+input.limit:null};
  }
  if(name==='leads_import')return importRows(store,input.requestId,input.rows);
  if(name==='leads_csv')return importRows(store,input.requestId,parseLeadCsv(input.csv));
  if(name==='leads_list'){const q='%'+input.query.toLowerCase().replace(/[\\%_]/g,'\\$&')+'%';const where="kind='workspace_lead' AND lower(json_extract(record,'$.name')||' '||json_extract(record,'$.area')) LIKE ? ESCAPE '\\'";const total=store.db.prepare('SELECT count(*) n FROM factory_operation WHERE '+where).get(q).n;const rows=store.db.prepare('SELECT record FROM factory_operation WHERE '+where+' ORDER BY rowid DESC LIMIT ? OFFSET ?').all(q,input.limit,input.offset).map(r=>decorate(JSON.parse(r.record)));return {items:rows,total,offset:input.offset,nextOffset:input.offset+input.limit<total?input.offset+input.limit:null};}
  if(name==='leads_get')return decorate(getLead(store,input.id));
  if(name==='leads_source_status')return leadSourceStatus(store);
  if(name==='leads_schedule_get')return {schedule:getRecord(store,'lead-schedule','lead_schedule')||{version:0,enabled:false},recent:all(store,'lead_schedule_day').slice(0,10)};
  if(name==='leads_schedule_pause')return transaction(store,()=>{const r=getRecord(store,'lead-schedule','lead_schedule');if(!r||r.version!==input.version)fail('STALE_EVIDENCE','Schedule changed; reload before pausing');const paused={...r,enabled:false,version:r.version+1,savedAt:now()};put(store,'lead-schedule','lead_schedule',paused);return paused;});
  if(name==='leads_schedule_save')return transaction(store,()=>{const previous=getRecord(store,'lead-schedule','lead_schedule');if((previous?.version||0)!==input.version)fail('STALE_EVIDENCE','Schedule changed; reload before saving');const areas=[...new Set((input.areas||[input.area]).map(a=>a.trim()))];const r={...input,areas,cursor:previous?.cursor||0,zeroNewByArea:previous?.zeroNewByArea||{},lastCompletedAt:previous?.lastCompletedAt||null,pauseReason:null,version:input.version+1,savedAt:now()};put(store,'lead-schedule','lead_schedule',r);return r;});
  if(name==='leads_schedule_tick'){
    const config=getRecord(store,'lead-schedule','lead_schedule');if(!config?.enabled)return {state:'disabled',called:false};
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:config.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(clock()).map(p=>[p.type,p.value]));
    if(Number(parts.hour)*60+Number(parts.minute)<config.hour*60+config.minute)return {state:'not_due',called:false};
    const date=`${parts.year}-${parts.month}-${parts.day}`,slotId='schedule-day-'+date,prior=getRecord(store,slotId,'lead_schedule_day');
    if(prior)return {...prior,replayed:true,called:false};
    if(!process.env.FACTORY_GOOGLE_PLACES_KEY)return {state:'needs_configuration',called:false};
    if(config.researchEnabled&&!process.env.FIRECRAWL_API_KEY)return {state:'needs_configuration',called:false};
    const areas=config.areas||[config.area],area=areas[(config.cursor||0)%areas.length];
    const slot=transaction(store,()=>{const existing=getRecord(store,slotId,'lead_schedule_day');if(existing)return null;const currentConfig=getRecord(store,'lead-schedule','lead_schedule');if(!currentConfig?.enabled||currentConfig.version!==config.version)return null;const r={id:slotId,date,configVersion:config.version,configDigest:hash(config),state:'reserved',startedAt:now(),requestId:'scheduled-'+date,query:config.query,area};put(store,slotId,'lead_schedule_day',r);return r;});
    if(!slot)return {state:'already_reserved',called:false};
    const finish=(done,result)=>transaction(store,()=>{
      put(store,slotId,'lead_schedule_day',done);
      const currentConfig=getRecord(store,'lead-schedule','lead_schedule');
      // An in-flight response cannot undo an operator pause or configuration edit.
      if(currentConfig?.version===config.version){
        const zeroNewByArea={...(config.zeroNewByArea||{})},areaKey=hash({query:config.query,area});
        if(done.state==='completed')zeroNewByArea[areaKey]=result.newCount===0?(zeroNewByArea[areaKey]||0)+1:0;
        let next=((config.cursor||0)+1)%areas.length;
        for(let i=0;i<areas.length;i++){const index=(next+i)%areas.length;if((zeroNewByArea[hash({query:config.query,area:areas[index]})]||0)<3){next=index;break;}}
        const exhausted=areas.every(a=>(zeroNewByArea[hash({query:config.query,area:a})]||0)>=3);
        const pauseReason=done.state!=='completed'?'Source attempt failed or is uncertain; inspect the retained error and explicitly resume.':exhausted?'Each search area returned zero new identities three times. Review the target/source before spending again.':null;
        put(store,'lead-schedule','lead_schedule',{...currentConfig,cursor:next,zeroNewByArea,enabled:currentConfig.enabled&&!pauseReason,pauseReason,lastCompletedAt:done.state==='completed'?now():currentConfig.lastCompletedAt});
      }
      return {...done,called:result?!result.replayed:false};
    });
    try{
      const result=await leadWorkspaceDispatch(store,'leads_discover',{requestId:slot.requestId,query:config.query,area,termsReviewed:true,authorized:true},{request,clock});
      const research=[];
      if(result.state==='completed'&&config.researchEnabled){
        const target=targetRecord()?.target;
        const queue=result.ids.map(id=>getLead(store,id)).map(l=>({lead:l,screening:screenLead(l,target)})).filter(r=>r.screening.state==='research_first').sort((a,b)=>b.screening.priority-a.screening.priority||a.lead.id.localeCompare(b.lead.id));
        for(const {lead} of queue.slice(0,3)){
          const currentConfig=getRecord(store,'lead-schedule','lead_schedule');if(!currentConfig?.enabled||currentConfig.version!==config.version)break;
          try{const r=await leadResearchDispatch(store,'leads_research',{id:lead.id,version:lead.version,requestId:slot.requestId+'-'+hash(lead.id).slice(0,12),authorized:true,termsReviewed:true},{request});research.push({id:r.id||null,state:r.state,errorCode:r.errorCode||null});if(r.state==='failed')break;}
          catch(e){research.push({state:'held',errorCode:/^(RESEARCH_|SOURCE_|STALE_)/.test(e.code||'')?e.code:'RESEARCH_FAILED'});break;}
        }
      }
      const researchFailed=research.some(r=>['failed','held','uncertain','stale_result'].includes(r.state));
      const done={...slot,state:result.state==='completed'&&!researchFailed?'completed':result.state==='requesting'?'uncertain':'failed',sourceRunId:result.id,research,errorCode:result.errorCode||research.find(r=>r.errorCode)?.errorCode||null,leadCount:result.ids?.length||0,newCount:result.newCount??null,completedAt:now()};return finish(done,result);
    }
    catch(e){const failed={...slot,state:'held',errorCode:/^(SOURCE_|LEAD_)/.test(e.code||'')?e.code:'SCHEDULE_FAILED',completedAt:now()};return finish(failed,null);}
  }
  if(name==='leads_source_resolve')return transaction(store,()=>{const r=getRecord(store,input.id,'lead_source_run');if(!r||r.startedAt!==input.startedAt)fail('STALE_EVIDENCE','The exact source attempt must match');if(r.state!=='requesting')return r;if(Date.now()-Date.parse(r.startedAt)<120000)fail('SOURCE_ACTIVE','Wait at least two minutes before acknowledging a stranded request');const updated={...r,state:'uncertain',completedAt:now(),errorCode:'SOURCE_UNCERTAIN',message:'Operator acknowledged an incomplete attempt. Charge and result remain unknown; consumed quota retained.'};put(store,r.id,'lead_source_run',updated);return updated;});
  if(name==='leads_suppress')return transaction(store,()=>{const r=getLead(store,input.id);if(!r.suppression){r.suppression={reason:input.reason,at:now()};r.version++;put(store,r.id,'workspace_lead',r);}return qualifyLead(r);});
  if(name==='leads_review')return transaction(store,()=>{const r=getLead(store,input.id);if(r.version!==input.version)fail('STALE_EVIDENCE','Lead changed; reload before reviewing');if(Object.values(input.gates).some(g=>!fresh(g.checkedAt)))fail('STALE_EVIDENCE','Review needs current dated evidence');
    if(input.resolveSourceConflict&&r.providerHold&&(input.gates.activity.status!=='pass'||Date.parse(input.gates.activity.checkedAt)<Date.parse(r.providerHold.at)||input.gates.activity.note.length<20))fail('SOURCE_CONFLICT','Clearing a provider hold needs a new positive activity observation after that hold');
    if(input.resolveIdentityConflict&&r.identityConflict&&(input.gates.identity.status!=='pass'||input.gates.identity.note.length<20))fail('SOURCE_CONFLICT','Clearing identity conflict needs a specific positive identity observation');
    if(input.resolveWebsiteConflict&&r.websiteResearchHold&&(input.gates.websiteNeed.status!=='pass'||Date.parse(input.gates.websiteNeed.checkedAt)<Date.parse(r.websiteResearchHold.at)||input.gates.websiteNeed.note.length<20))fail('SOURCE_CONFLICT','Clearing possible website conflict needs a new specific website observation after the hold');
    const resolution=input.resolveSourceConflict||input.resolveIdentityConflict||input.resolveWebsiteConflict?{at:now(),reviewer:input.reviewer,providerHold:r.providerHold||null,identityConflict:r.identityConflict||false,websiteResearchHold:r.websiteResearchHold||null}:null;
    const updated={...r,gates:input.gates,reviewer:input.reviewer,version:r.version+1,updatedAt:now(),...(input.resolveSourceConflict?{providerHold:null}:{}),...(input.resolveIdentityConflict?{identityConflict:false}:{}),...(input.resolveWebsiteConflict?{websiteResearchHold:null}:{}),...(resolution?{conflictResolutions:[...(r.conflictResolutions||[]),resolution].slice(-20)}:{})};put(store,r.id,'workspace_lead',updated);return qualifyLead(updated);});
  if(name!=='leads_discover')fail('UNKNOWN_OPERATION','Unknown lead operation');
  const id='source-'+hash(input.requestId).slice(0,24),digest=hash(input);
  const cached=getRecord(store,id,'lead_source_run');if(cached){if(cached.inputDigest!==digest)fail('IDEMPOTENCY_CONFLICT','Source request already binds a different query');return {...cached,replayed:true};}
  if(!process.env.FACTORY_GOOGLE_PLACES_KEY)fail('LEAD_CONFIGURATION','Add FACTORY_GOOGLE_PLACES_KEY securely in environment settings. Manual and CSV intake work without it.');
  transaction(store,()=>{
    const status=leadSourceStatus(store);if(status.callsLast24h>=3||status.circuitOpen)fail('SOURCE_BUDGET','Source attempt limit/circuit reached; no call made');
    if(status.unresolved.length)fail('SOURCE_UNCERTAIN','A prior request has no final receipt. Inspect it before launching more paid-capable work; it is not automatically retried.');
    put(store,id,'lead_source_run',{id,inputDigest:digest,provider:'google_places',transport:request===providerHttp?'live_api':'injected_transport',query:input.query,area:input.area,state:'requesting',startedAt:now(),usage:{requests:1,charge:'unknown'},ids:[]});
  });
  try{
    const response=await request('https://places.googleapis.com/v1/places:searchText',{headers:{'X-Goog-Api-Key':process.env.FACTORY_GOOGLE_PLACES_KEY,'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.googleMapsUri,places.businessStatus,places.types,places.primaryType'},body:JSON.stringify({textQuery:input.query+' in '+input.area,pageSize:20}),timeout:20000});
    if(response.status!==200)fail(response.status===429?'SOURCE_RATE_LIMIT':response.status===401||response.status===403?'SOURCE_AUTH':'SOURCE_HTTP','Provider rejected the search; no automatic retry or fallback purchase');
    const data=JSON.parse(response.bytes.toString());if(!data||typeof data!=='object'||Array.isArray(data)||data.error||data.places!==undefined&&!Array.isArray(data.places)||data.places?.length>20)fail('SOURCE_SCHEMA','Unsupported provider result');
    const rows=[],quarantined=[];
    // Fresh negative provider evidence must hold an existing pointer, not leave
    // yesterday's positive operator review silently looking current.
    const inactiveIds=(data.places||[]).filter(p=>typeof p.id==='string'&&p.id&&p.businessStatus!=='OPERATIONAL').map(p=>p.id);
    if(inactiveIds.length)transaction(store,()=>{for(const lead of all(store,'workspace_lead'))if(lead.sources.some(s=>s.provider==='google_places'&&inactiveIds.includes(s.sourceId))){const updated={...lead,providerHold:{reason:'provider_status_not_operational',at:now()},version:lead.version+1,updatedAt:now()};put(store,lead.id,'workspace_lead',updated);}});
    for(const [i,p] of (data.places||[]).entries()){
      const parsed=row.safeParse({name:p.displayName?.text,area:p.formattedAddress,phone:p.nationalPhoneNumber||'',website:p.websiteUri||'',sourceUrl:p.googleMapsUri,sourceId:p.id,observedAt:now(),provider:'google_places'});
      if(!parsed.success||!p.id||p.businessStatus!=='OPERATIONAL'){quarantined.push({row:i+1,reason:!p.id?'MISSING_PROVIDER_ID':p.businessStatus!=='OPERATIONAL'?'STATUS_UNVERIFIED_OR_CLOSED':'MALFORMED_POINTER'});continue;}
      const types=Array.isArray(p.types)&&p.types.length<=50&&p.types.every(v=>typeof v==='string'&&v.length<=100)?p.types:[];
      rows.push({...parsed.data,providerEvidence:{businessStatus:p.businessStatus,types,primaryType:typeof p.primaryType==='string'&&p.primaryType.length<=100?p.primaryType:null}});
    }
    // The row updates and final source receipt commit together. A crash cannot
    // import rows while losing their new/refresh counts in a separate commit.
    return transaction(store,()=>{
      const receipt=rows.length?importRows(store,'google-'+input.requestId,rows):{ids:[],newCount:0,refreshedCount:0,quarantined:[]};
      const run={...getRecord(store,id,'lead_source_run'),state:'completed',completedAt:now(),returnedCount:(data.places||[]).length,newCount:receipt.newCount,refreshedCount:receipt.refreshedCount,ids:receipt.ids,quarantined:[...quarantined,...receipt.quarantined],attribution:'Google Maps',qualificationEstablished:false};put(store,id,'lead_source_run',run);return run;
    });
  }catch(e){const run={...getRecord(store,id,'lead_source_run'),state:'failed',completedAt:now(),errorCode:/^(SOURCE_|PROVIDER_|CANCELLED)/.test(e.code||'')?e.code:'SOURCE_RESPONSE_INVALID',message:'Search did not complete. Prior leads and consumed request remain; no automatic retry.'};put(store,id,'lead_source_run',run);return run;}
}
