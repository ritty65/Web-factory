import {hash,now,fail,publicResourceKey,publicUrl} from './contracts.mjs';
import {getBatch,batchForCampaign,parseRecord,identitiesOverlap,existingEntity,suppressionFor,guardBatchJob} from './batch-store.mjs';
import {sourceJobPolicy} from './batch-budget.mjs';
import {transaction} from './sales.mjs';
import {operationRecord} from './pilot.mjs';
import {validateResearchOutput} from './research-check.mjs';
import {readIntakeEvidence,potentialWebsiteTargets,profileAnchors,identityObservations,observedSocialTarget,candidateDestinations} from './intake.mjs';
import {screeningContext,assessScreening} from './screening.mjs';
import {freshEvidence,isLinkHubUrl} from './destinations.mjs';
import {assessMaterial,completionCapacity,discoveryQueries} from './acquisition.mjs';
import {stablePostUrl} from './evidence-context.mjs';
import {inspectSource,publicObservation} from './browser.mjs';
import {searchPublic} from './search.mjs';

const same=(a,b)=>Boolean(publicResourceKey(a)&&publicResourceKey(a)===publicResourceKey(b));
const anchorsFor=c=>[...new Set([...profileAnchors(c),...profileAnchors({...c,contacts:{}})])].sort();
const identityKey=c=>hash(anchorsFor(c).length?anchorsFor(c):{name:c.name.toLowerCase(),area:c.area.toLowerCase()});
const registrationReason=Symbol('scout registration failure');
function rejectRegistration(reason,message){
  try{fail('SOURCE_IDENTITY_EXTENSION',message);}catch(error){
    Object.defineProperty(error,registrationReason,{value:reason});throw error;
  }
}
function records(store,batchId,kind){return store.db.prepare("SELECT record FROM factory_operation WHERE kind=? AND json_extract(record,'$.batchId')=? ORDER BY rowid").all(kind,batchId).map(parseRecord);}
function retainedIdentities(store,job,batchId){
  const identities=records(store,batchId,'scout_identity').filter(v=>v.jobId===job.id),limit=job.input.candidateLimit;
  // Fail closed rather than silently truncating anchors a complete draft must keep.
  if(!Number.isInteger(limit)||limit<1||limit>100||identities.length>limit)return null;
  const result=[];
  for(const v of identities){
    const original=v.originalAnchors||[],verified=v.verifiedAnchors||original;
    if(typeof v.name!=='string'||v.name.length>150||typeof v.identityKey!=='string'||!/^[a-f0-9]{64}$/.test(v.identityKey)||
      ![original,verified].every(list=>Array.isArray(list)&&list.length<=80&&list.every(a=>typeof a==='string'&&a.length<=1200&&publicResourceKey(a)===a)))return null;
    result.push({name:v.name,identityKey:v.identityKey,originalAnchors:[...original],verifiedAnchors:[...verified]});
  }
  return Buffer.byteLength(JSON.stringify(result),'utf8')<=64*1024?result:null;
}
export function scoutRegistrationFailure(store,jobId,error){
  const reason=error?.[registrationReason];
  if(!['merge','original_anchor_removed','unsupported_account_extension'].includes(reason))return null;
  const job=store.job(jobId),b=batchForCampaign(store,job.campaignId);
  if(b?.acquisition?.version!==1||job.input.phase!=='discovery')return null;
  const retainedDraftIdentities=retainedIdentities(store,job,b.id);
  return retainedDraftIdentities?{reason,retainedDraftIdentities}:null;
}
// Reuse the shared job guard for owned native/cache admission; it validates the
// frozen receipt just as direct source and model reservations do.
export function seedResearchContext(store,jobId){
  const job=store.job(jobId),b=batchForCampaign(store,job.campaignId);
  if(!b?.seedCohort)return null;
  guardBatchJob(store,job,{claiming:true});return b.seedCohort;
}
function seedUrls(seed){
  const urls=[],visit=value=>{if(typeof value==='string')urls.push(value);else if(value&&typeof value==='object')Object.values(value).forEach(visit);};
  visit(seed.urls);return urls.slice(0,40);
}
function usableSeeds(store,b){
  return b.seedCohort.items.filter(seed=>{
    const urls=seedUrls(seed),contacts={};
    for(const url of urls)if(retainedRouteRank(url)===0){const channel=publicUrl(url).hostname.includes('instagram')?'instagram':'facebook';contacts[channel]=url;}
    const locator={name:seed.name,area:'Houston',contacts};
    return !existingEntity(store,locator,{excludeId:null})&&!suppressionFor(store,locator);
  });
}
function seedQueries(store,b){
  const seeds=usableSeeds(store,b),result=[];
  for(const family of ['seed_identity','seed_instagram','seed_facebook'])for(const seed of seeds){
    const name=String(seed.name).normalize('NFKC').replace(/[^\p{L}\p{N} &'’-]/gu,' ').replace(/\s+/g,' ').trim().slice(0,120);
    if(!/[\p{L}\p{N}]{3}/u.test(name))continue;
    const query=`${family==='seed_instagram'?'site:instagram.com ':family==='seed_facebook'?'site:facebook.com ':''}"${name}" Houston Texas business`;
    if(!result.some(q=>q.query===query))result.push({family,query,seedId:seed.id});
  }
  return result.slice(0,6);
}
function seedProfileQuestion(store,b,job,evidence,tasks){
  if(tasks.filter(t=>t.jobId===job.id&&t.purpose==='seed_profile').length>=6)return null;
  const attempted=records(store,b.id,'source_attempt');
  for(const seed of usableSeeds(store,b)){
    // Keep the real selected-provider planned-search guard even when a seed
    // already contains an original-profile pointer. No synthetic seed receipt.
    const searched=tasks.some(t=>t.jobId===job.id&&t.attempt===job.attempt&&t.seedId===seed.id&&t.type==='search'&&t.status==='completed'&&evidence.searches.some(s=>s.provider===b.settings.searchProvider&&s.intent==='discover'&&s.status==='completed'&&s.query===t.query&&hash(s)===t.resultDigest&&freshEvidence(s.at)&&Date.parse(s.at)<=Date.now()&&Date.parse(s.at)>=Date.parse(t.at)&&Date.parse(s.at)<=Date.parse(t.finishedAt)));
    if(!searched)continue;
    for(const url of seedUrls(seed)){
      if(retainedRouteRank(url)!==0||tasks.some(t=>same(t.url,url))||attempted.some(t=>same(t.url,url))||evidence.observations.some(o=>same(o.url,url)||same(o.finalUrl,url)))continue;
      return {id:`scout-task-${hash({batchId:b.id,url:publicResourceKey(url)}).slice(0,24)}`,type:'seed_profile',purpose:'seed_profile',seedId:seed.id,url:publicUrl(url).href};
    }
  }
  return null;
}
export function scoutSummary(store,batchId){
  const tasks=records(store,batchId,'scout_task'),counts={total:tasks.length,completed:0,blocked:0,claimed:0,stopped:0};
  for(const t of tasks)if(Object.hasOwn(counts,t.status))counts[t.status]++;
  return {version:1,counts,queryFamilies:[...new Set(tasks.filter(t=>t.type==='search').map(t=>t.family))],limitations:['Attempts and retained source outcomes, not business qualification, finished sites or dollars']};
}
function resolveRegistration(c,old,evidence){
  const anchors=anchorsFor(c),matches=old.filter(v=>(v.verifiedAnchors||v.originalAnchors||[]).some(a=>anchors.includes(a)));
  if(matches.length>1)rejectRegistration('merge','Separate registered businesses cannot be merged into one draft.');
  const prior=matches[0]||old.find(v=>v.identityKey===identityKey(c));
  if(!prior)return {identityKey:identityKey(c),originalAnchors:anchors,verifiedAnchors:anchors};
  const original=prior.originalAnchors||[],added=anchors.filter(a=>!(prior.verifiedAnchors||original).includes(a));
  if(original.some(a=>!anchors.includes(a)))rejectRegistration('original_anchor_removed','Retain original registered account anchors; an added account cannot replace them.');
  const bound=evidence.observations.filter(o=>c.inspectionIds.includes(o.id)&&!o.blocked&&freshEvidence(o.inspectedAt));
  const originalView={...c,contacts:{}};
  for(const a of original)originalView.contacts[publicUrl(a).hostname.replace(/^(www|m)\./,'').split('.')[0]]=a;
  const roots=identityObservations(originalView,bound).filter(o=>original.some(a=>same(a,o.url)));
  for(const a of added){
    const channel=publicUrl(a).hostname.replace(/^(www|m)\./,'').split('.')[0],view={...c,contacts:{...c.contacts,[channel]:a}};
    if(!roots.some(o=>(o.links||[]).some(l=>same(observedSocialTarget(l.url),a)))||!identityObservations(view,bound).some(o=>same(o.url,a)))rejectRegistration('unsupported_account_extension','An additional account needs a fresh original-profile link and inspected matching account; no inferred alias.');
  }
  return {identityKey:prior.identityKey,originalAnchors:original,verifiedAnchors:[...new Set([...(prior.verifiedAnchors||original),...anchors])]};
}
function registerDraft(store,b,job,candidates,evidence){
  return transaction(store,()=>{
    guardBatchJob(store,store.job(job.id),{claiming:true});
    const old=records(store,b.id,'scout_identity').filter(v=>v.jobId===job.id),resolved=candidates.map(c=>resolveRegistration(c,old,evidence)),keys=new Set(old.map(v=>v.identityKey));
    for(const r of resolved)keys.add(r.identityKey);
    if(keys.size>job.input.candidateLimit)fail('SOURCE_COHORT_CAP','The original round identity ceiling was reached; do not replace registered drafts.');
    for(const [i,c] of candidates.entries()){const r=resolved[i],key=r.identityKey,prior=old.find(v=>v.identityKey===key);
      operationRecord(store,`scout-identity-${hash({jobId:job.id,key}).slice(0,24)}`,'scout_identity',{...prior,batchId:b.id,jobId:job.id,...r,name:prior?.name||c.name,at:prior?.at||now()});
    }
    return resolved;
  });
}
function questions(c,evidence,key,{screening,material}){
  const {view,bound,identity,listings}=screeningContext(c,evidence);
  // A fresh original-profile destination may supply missing location evidence.
  // Reading that observed route is not a positive geography/qualification claim;
  // known outside-base conflicts still stop, along with existing-site/booking cases.
  if(!identity.length||['excluded','booking_only'].includes(screening.status)||screening.geography==='conflict')return [];
  const graph=candidateDestinations(view,evidence.observations,bound,identity,listings);
  // Scheduling only: a non-hub domain is not proof of an official website.
  // Stable ties keep observed order, and every hub remains a required check.
  const result=graph.unresolved.filter(v=>v.url&&['missing_inspection','stale'].includes(v.reason)).map(v=>({type:'destination',purpose:'destination',url:v.url,sourceId:v.sourceId,identityKey:key})).sort((a,b)=>Number(isLinkHubUrl(a.url)||Boolean(observedSocialTarget(a.url)))-Number(isLinkHubUrl(b.url)||Boolean(observedSocialTarget(b.url))));
  const unknownGeography=screening.geography==='unknown',purpose=unknownGeography?(material.feasible?'geography':'geography_and_material'):'material';
  if(!material.feasible||unknownGeography)for(const source of identity)for(const link of source.links||[]){
    const post=stablePostUrl(link.url,source.url);
    if(post&&!evidence.observations.some(o=>same(o.url,post)||same(o.finalUrl,post)))result.push({type:'post',purpose,url:post,sourceId:source.id,identityKey:key});
  }
  return result;
}
// Search only for an already bound promising identity; snippets locate candidate
// listings and can never supply location, no-site evidence or qualification.
function listingQuestion(c,evidence,key,{screening,material},b,tasks){
  if(screening.geography!=='unknown'||!material.feasible||['excluded','booking_only'].includes(screening.status))return null;
  if(tasks.filter(t=>t.family==='candidate_listing').length>=4||tasks.some(t=>t.family==='candidate_listing'&&t.identityKey===key))return null;
  if(b.settings.maxInspections-b.usage.inspections<=b.acquisition.reserve.inspections)return null;
  const {identity}=screeningContext(c,evidence),root=identity.find(o=>profileAnchors(c).includes(publicResourceKey(o.url))&&o.method==='fresh_guest_rendered_dom'&&o.evidenceContextVersion===1&&same(o.url,o.finalUrl));
  if(!root)return null;
  const literal=s=>String(s||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
  if(![root.title,root.text].some(value=>literal(value).includes(literal(c.name))))return null;
  const name=c.name.normalize('NFKC').replace(/[^\p{L}\p{N} &'-]/gu,' ').replace(/\s+/g,' ').trim().slice(0,100);
  if(!/[\p{L}\p{N}]{3}/u.test(name))return null;
  return {type:'search',family:'candidate_listing',purpose:'candidate_listing',query:`"${name}" Houston Texas business directory`,sourceId:root.id,identityKey:key};
}
// Discovery locators only: never derive a profile from a post, or treat a
// snippet/domain as identity, geography, official-site or absence evidence.
function retainedRouteRank(value){
  try{
    const u=publicUrl(value),h=u.hostname.replace(/^www\./,''),p=u.pathname.replace(/\/+$/,'');
    // Intake anchors are broader than discovery scheduling. Platform controls
    // must not spend a finite business-profile inspection slot.
    const platform=h.replace(/^m\./,'');
    if(platform==='facebook.com'&&/^\/(?:watch|marketplace|messages|messenger|notifications|friends|gaming|events|pages|saved|memories|settings|checkpoint|challenge|login(?:\.php)?|logout(?:\.php)?|recover(?:\.php)?|reg|register|signup|dialog|oauth|security|two_factor)(?:\/|$)/i.test(p)||
      platform==='instagram.com'&&/^\/(?:direct|challenge|checkpoint|accounts|emails|session|settings|notifications|login|logout|signup|oauth|developer|download)(?:\/|$)/i.test(p))return null;
    if(profileAnchors({sourceUrls:[u.href]}).length&&(!u.search||['facebook.com','m.facebook.com'].includes(h)&&p==='/profile.php'&&[...u.searchParams.keys()].length===1))return 0;
    if(!u.search&&(h==='yelp.com'&&/^\/biz\/[^/]+$/i.test(p)||h==='yellowpages.com'&&/^\/[^/]+\/mip\/[^/]+$/i.test(p)||h==='bbb.org'&&/^\/us\/[^/]+\/[^/]+\/profile\/[^/]+\/[^/]+$/i.test(p)||h==='chamberofcommerce.com'&&/^\/business-directory\/[^/]+\/[^/]+\/[^/]+\/[^/]+$/i.test(p)))return 1;
  }catch{ /* Unsafe URLs are never actions; the ordinary reader still owns DNS. */ }
  return null;
}
function retainedRouteQuestion(store,b,job,evidence,tasks){
  const triage=tasks.filter(t=>t.jobId===job.id&&t.purpose==='search_result');
  if(triage.length>=4)return null;
  const attempted=records(store,b.id,'source_attempt'),routes=[],seen=new Set();
  for(const t of tasks){
    if(t.jobId!==job.id||t.attempt!==job.attempt||t.type!=='search'||t.status!=='completed'||triage.filter(q=>q.searchDigest===t.resultDigest).length>=3)continue;
    const s=evidence.searches.find(s=>s.provider===b.settings.searchProvider&&s.intent==='discover'&&s.status==='completed'&&s.query===t.query&&hash(s)===t.resultDigest);
    if(!s||!freshEvidence(s.at)||Date.parse(s.at)>Date.now()||!(Date.parse(s.at)>=Date.parse(t.at)&&Date.parse(s.at)<=Date.parse(t.finishedAt)))continue;
    for(const result of (Array.isArray(s.results)?s.results:[]).slice(0,10)){
      const rank=retainedRouteRank(result.url),key=publicResourceKey(result.url);
      if(rank===null||!key||seen.has(key)||tasks.some(v=>same(v.url,result.url))||attempted.some(v=>same(v.url,result.url))||evidence.observations.some(o=>same(o.url,result.url)||same(o.finalUrl,result.url)))continue;
      seen.add(key);routes.push({type:'search_result',purpose:'search_result',url:publicUrl(result.url).href,searchDigest:t.resultDigest,rank});
    }
  }
  routes.sort((a,b)=>a.rank-b.rank);
  const route=routes[0];if(!route)return null;
  const {rank,...question}=route;
  return {...question,id:`scout-task-${hash({batchId:b.id,url:publicResourceKey(route.url)}).slice(0,24)}`};
}
// A single call does one host-chosen I/O action at most; no model launch or import.
export async function scoutStep({store,jobId,directory,output,inspect=inspectSource,search=searchPublic}){
  const policy=sourceJobPolicy(store,jobId,directory),scope=policy.researchContext(),job=store.job(jobId);
  if(scope.acquisition?.version!==1||job.input.phase!=='discovery')fail('SOURCE_SCOUT_SCOPE','Scouting belongs only to the exact new-mode discovery job.');
  const parsed=validateResearchOutput(output,scope.candidateLimit);if(!parsed.valid)fail('RESEARCH_SCHEMA','Scout draft must pass the complete strict research contract before any action.');
  const b=JSON.parse(store.db.prepare("SELECT record FROM factory_operation WHERE kind='batch' AND json_extract(record,'$.campaignId')=?").get(job.campaignId).record);
  const evidence=await readIntakeEvidence(directory),registrations=registerDraft(store,b,job,parsed.candidates,evidence),tasks=records(store,b.id,'scout_task');
  const feedback=parsed.candidates.map((c,index)=>({index,screening:assessScreening(c,evidence,scope.settings),material:assessMaterial(c,evidence)}));
  transaction(store,()=>{
    policy.researchContext();
    for(const [i,c] of parsed.candidates.entries()){
      const id=`scout-identity-${hash({jobId:job.id,key:registrations[i].identityKey}).slice(0,24)}`,prior=parseRecord(store.db.prepare('SELECT record FROM factory_operation WHERE id=?').get(id));
      operationRecord(store,id,'scout_identity',{...prior,materialFeasible:feedback[i].material.feasible&&feedback[i].screening.status==='clear_for_enrichment'&&!existingEntity(store,c,{excludeId:null}),draftDigest:hash(c)});
    }
  });
  const retained=()=>retainedIdentities(store,job,b.id)||records(store,b.id,'scout_identity').filter(v=>v.jobId===jobId).map(v=>({name:v.name,identityKey:v.identityKey}));
  const response=(status,extra={})=>({status,feedback,retainedDraftIdentities:retained(),...extra,fullQualification:false,humanAcceptance:false});
  if(tasks.some(t=>t.jobId===jobId&&t.status==='claimed'))return response('inflight_or_interrupted');
  if(!completionCapacity(getBatch(store,b.id)).available)return response('capacity_held');
  let task;
  if(parsed.candidates.length){
    if(feedback.some(f=>f.screening.status==='clear_for_enrichment'&&f.material.feasible&&!existingEntity(store,parsed.candidates[f.index],{excludeId:null})))return response('ready_to_finalize');
    const unique=[],groups=[];
    for(const [index,c] of parsed.candidates.entries()){if(unique.some(other=>identitiesOverlap(c,other))||existingEntity(store,c,{excludeId:null}))continue;unique.push(c);
      const assessment=feedback[index],key=registrations[index].identityKey,observed=questions(c,evidence,key,assessment),listing=listingQuestion(c,evidence,key,assessment,b,tasks);
      groups.push({index,blockingGapCount:assessment.screening.reasons.length+assessment.material.gaps.length,questions:[...observed.filter(q=>q.type==='destination'),...(listing?[listing]:[]),...observed.filter(q=>q.type!=='destination')]});
    }
    // Completion preference only, never a qualification or purchase-likelihood score.
    groups.sort((a,b)=>a.blockingGapCount-b.blockingGapCount||a.index-b.index);
    for(const group of groups){
      for(const q of group.questions){
        const id=`scout-task-${hash(q.type==='search'?{batchId:b.id,identityKey:q.identityKey,purpose:q.purpose}:{batchId:b.id,identityKey:q.identityKey,url:publicResourceKey(q.url)}).slice(0,24)}`;
        if(!tasks.some(v=>v.id===id)){task={...q,id,candidateIndex:group.index,blockingGapCount:group.blockingGapCount};break;}
      }if(task)break;
    }
    if(!task){
      for(const c of unique){
        const assessment=feedback[parsed.candidates.indexOf(c)].screening;
        if(['excluded','booking_only'].includes(assessment.status)||assessment.geography==='conflict')continue;
        const {view,bound,identity,listings}=screeningContext(c,evidence),graph=candidateDestinations(view,evidence.observations,bound,identity,listings);
        const pending=graph.unresolved.find(v=>v.reason==='unclassified'),observed=pending&&evidence.observations.find(o=>o.id===pending.observationId);
        if(observed&&!observed.blocked&&freshEvidence(observed.inspectedAt))return response('classification_needed',{observation:publicObservation({...observed,images:observed.images||[],captures:observed.captures||[]})});
      }
      return response(feedback.some(f=>f.screening.status==='clear_for_enrichment'&&f.material.feasible)?'ready_to_finalize':'cohort_needs_evidence');
    }
  }else{
    if(records(store,b.id,'scout_identity').some(v=>v.jobId===jobId&&v.materialFeasible))return response('ready_to_finalize');
    if(retained().length>=scope.candidateLimit)return response('cohort_exhausted');
    task=(b.seedCohort?seedProfileQuestion(store,b,job,evidence,tasks):null)||retainedRouteQuestion(store,b,job,evidence,tasks);
    if(!task){
      if(tasks.filter(t=>t.jobId===jobId&&t.type==='search').length>=6)return response('query_ceiling');
      const plan=(b.seedCohort?seedQueries(store,b):discoveryQueries(scope.settings)).find(q=>!tasks.some(t=>t.type==='search'&&t.query===q.query));
      if(!plan)return response('query_plan_exhausted');
      task={id:`scout-task-${hash({batchId:b.id,query:plan.query}).slice(0,24)}`,type:'search',...plan};
    }
  }
  const explanation=task.type==='search'&&task.family!=='candidate_listing'?{}:['search_result','seed_profile'].includes(task.purpose)?{question:{purpose:task.purpose,...(task.seedId?{seedId:task.seedId}:{})}}:{question:{candidateIndex:task.candidateIndex,purpose:task.purpose,blockingGapCount:task.blockingGapCount}};
  const binding={...task,batchId:b.id,jobId,attempt:job.attempt,at:now(),status:'claimed'};
  try{
    policy.reserve(task.type==='search'?'searches':'inspections',{provider:scope.settings.searchProvider,url:task.url,planned:true,onReserved:()=>{
      if(records(store,b.id,'scout_task').some(t=>t.id===task.id||t.jobId===jobId&&t.status==='claimed'))fail('SOURCE_SCOUT_BUSY','An existing question is in flight, interrupted or already attempted.');
      operationRecord(store,task.id,'scout_task',binding);store.event(jobId,'scout.task_started','Evidence scout question reserved',{type:task.type});
    }});
  }catch(e){if(['SOURCE_SCOUT_BUSY','SOURCE_ALREADY_ATTEMPTED'].includes(e.code))return response('inflight_or_interrupted');if(/^BATCH_/.test(e.code||''))return response('capacity_held');throw e;}
  let result;
  try{
    result=task.type==='search'?await search(task.query,{directory,provider:scope.settings.searchProvider,intent:'discover'}):await inspect(task.url,{directory,linked:true});
    policy.researchContext();
    const after=await readIntakeEvidence(directory);
    if(task.sourceId&&hash(after.observations.find(o=>o.id===task.sourceId))!==hash(evidence.observations.find(o=>o.id===task.sourceId)))fail('SOURCE_SCOUT_CHANGED','The bound original source changed during its question.');
    if(task.searchDigest&&!after.searches.some(s=>hash(s)===task.searchDigest))fail('SOURCE_SCOUT_CHANGED','The retained discovery receipt changed during its question.');
    const blocked=result.blocked===true||task.type==='search'&&result.status!=='completed';
    transaction(store,()=>{
      policy.researchContext();
      operationRecord(store,task.id,'scout_task',{...binding,status:blocked?'blocked':'completed',finishedAt:now(),resultDigest:hash(result)});
      store.event(jobId,blocked?'scout.task_blocked':'scout.task_completed',blocked?'Evidence scout source held':'Evidence scout observation retained',{type:task.type});
    });
    return response(blocked?'blocked':task.type==='search'?'searched':'observed',{...explanation,...(task.type==='search'?{search:result}:{observation:publicObservation(result)})});
  }catch(e){
    const stopped=/^BATCH_|^CANCELLED|^DEADLINE/.test(e.code||'');
    operationRecord(store,task.id,'scout_task',{...binding,status:stopped?'stopped':'blocked',finishedAt:now(),code:/^[A-Z_]{2,60}$/.test(e.code||'')?e.code:'SOURCE_FAILED'});
    store.event(jobId,'scout.task_blocked','Evidence scout stopped; attempt retained',{type:task.type});
    return response(stopped?'stopped':'blocked',explanation);
  }
}
export function assertScoutWorkflow(store,jobId,candidates,evidence){
  const job=store.job(jobId),row=store.db.prepare("SELECT record FROM factory_operation WHERE kind='batch' AND json_extract(record,'$.campaignId')=?").get(job.campaignId),b=row&&JSON.parse(row.record);
  if(b?.acquisition?.version!==1||job.input.phase!=='discovery')return;
  const tasks=records(store,b.id,'scout_task').filter(t=>t.jobId===jobId);
  if(!tasks.some(t=>t.type==='search'&&t.status==='completed'&&evidence.searches.some(s=>s.provider===b.settings.searchProvider&&s.intent==='discover'&&s.query===t.query&&hash(s)===t.resultDigest)))fail('SOURCE_SCOUT_REQUIRED','New discovery needs an actual retained host-planned search receipt; tool claims and unplanned cached output do not qualify.');
  if(scoutDraftIssues(store,jobId,candidates,evidence).length)fail('SOURCE_COHORT_BINDING','Final whole output must retain the exact registered draft identities, including held/excluded cases. No substitution or partial import.');
}
export function scoutDraftIssues(store,jobId,candidates,evidence={observations:[]}){
  const job=store.job(jobId),row=store.db.prepare("SELECT record FROM factory_operation WHERE kind='batch' AND json_extract(record,'$.campaignId')=?").get(job.campaignId),b=row&&JSON.parse(row.record);
  if(b?.acquisition?.version!==1||job.input.phase!=='discovery')return [];
  const identities=records(store,b.id,'scout_identity').filter(t=>t.jobId===jobId);let keys;
  try{keys=new Set(candidates.map(c=>resolveRegistration(c,identities,evidence).identityKey));}catch{return [{path:'candidates',message:'Retain original account anchors; register a genuinely observed linked account extension through sources.scout, never an unrelated alias.'}];}
  return keys.size!==candidates.length||identities.length!==keys.size||identities.some(i=>!keys.has(i.identityKey))?[{path:'candidates',message:'Register every new or updated COMPLETE draft with sources.scout before checking, including terminal holds/exclusions. Retain every registered identity without duplicates or substitutions.'}]:[];
}
// Reader admission only, never an intake verdict. Selected enrichment must re-read
// the exact original profile and its actually observed routes in its OWN staging
// directory. The caller cannot request rendering or widen the fixed host policy.
export async function selectedLinkedRead({store,jobId,directory,url}){
  const scope=sourceJobPolicy(store,jobId,directory).researchContext(),job=store.job(jobId);
  if(scope.acquisition?.version!==1||job.input.phase!=='enrichment'||!isLinkHubUrl(url))return false;
  const c=store.candidate(job.input.recheckCandidateId),evidence=await readIntakeEvidence(directory);
  const view={...c,inspectionIds:evidence.observations.map(o=>o.id)},roots=screeningContext(view,evidence).identity.filter(o=>!o.finalUrl||same(o.finalUrl,o.url));
  const queue=roots.map(source=>({source,depth:0})),visited=new Set();
  while(queue.length){
    const {source,depth}=queue.shift();
    for(const target of potentialWebsiteTargets(view,source,roots,{includeText:true})){
      if(!target.url||!isLinkHubUrl(target.url)||depth>=2)continue;
      const key=publicResourceKey(target.url);if(visited.has(key))continue;visited.add(key);if(visited.size>40)return false;
      if(same(target.url,url))return true;
      const observed=evidence.observations.find(o=>(same(o.url,target.url)||same(o.finalUrl,target.url))&&!o.blocked&&freshEvidence(o.inspectedAt));
      if(observed&&isLinkHubUrl(observed.finalUrl||target.url))queue.push({source:observed,depth:depth+1});
    }
  }
  return false;
}
