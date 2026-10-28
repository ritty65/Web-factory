import {z} from 'zod';import path from 'node:path';
import {hash,now,fail} from './contracts.mjs';
import {record,records,saveRecord,atomic} from './studio-state.mjs';
import {settings,settingsRecord,settingsDigest,studioStatus} from './studio-config.mjs';
import {studioSpend} from './studio-budget.mjs';
import {studioHttp} from './studio-http.mjs';
import {discoverPointers,refreshPointer,investigatePointer,retainResearchMedia,purgeExpiredStudioData,testReaders} from './studio-leads.mjs';
import {websiteSurface} from './lead-screening.mjs';
import {PREMIUM_PROFILE} from './effects-contract.mjs';

const key=z.string().regex(/^[a-z0-9][a-z0-9-]{7,95}$/);
const op=(description,schema,readOnly=false)=>({description,schema,readOnly});
export const STUDIO_AUTOPILOT_OPERATIONS={
  studio_autopilot_status:op('Read actual setup blockers, cohort, proposals, source evidence and spending. Never runs providers.',z.object({}).strict(),true),
  studio_autopilot_start:op('Authorize/resume the exact configured private pilot. Queues owned work within durable daily, cohort and spending limits.',z.object({version:z.number().int().min(0),settingsDigest:z.string().regex(/^[a-f0-9]{64}$/),requestId:key,authorized:z.literal(true)}).strict()),
  studio_autopilot_pause:op('Pause future private-pilot work and cancel its queued/running owned jobs. Does not refund or discard evidence.',z.object({version:z.number().int().min(1)}).strict()),
  studio_autopilot_tick:op('Queue one due Chicago-date slot for an already authorized pilot. No automatic source purchase on startup.',z.object({}).strict()),
  studio_readers_test:op('Explicitly test real Scrapling extraction and the guarded Camofox browser. Does not establish useful lead yield.',z.object({requestId:key,authorized:z.literal(true)}).strict()),
  studio_assessment_get:op('Read an exact source-backed assessment and private media provenance. It is not buying intent or publication authority.',z.object({id:key}).strict(),true),
  studio_data_purge:op('Purge expired provider response caches and pointer fields while retaining spend and stable identity receipts.',z.object({}).strict()),
};
const pilotRecord=store=>record(store,'studio-autopilot','studio_autopilot');
const chicagoDate=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
export async function studioReadiness(store,{allowFixture=false}={}){
  const setup=await studioStatus(store),blockers=[],current=settingsDigest(store);
  if(!settingsRecord(store))blockers.push('Save the private setup first.');
  for(const task of ['research','design','code','repair','vision']){
    const name=setup.data.roles[task],c=setup.connections.find(c=>c.id===name),capability=task==='vision'?'vision':task==='research'?'json':'coding';
    if(!c?.configured||!c.priced||c.check?.state!=='passed'||!c.check.capabilities[capability]||Date.now()-Date.parse(c.check.at)>7*86400000||!allowFixture&&c.check.verification!=='live_api')blockers.push('Test a priced '+capability+' connection for '+task+' ('+name+').');
  }
  for(const[name,caps]of [['google',['discovery']],['apollo',['companySearch','company','peopleSearch','enrichment']],['firecrawl',['search','extraction']]]){
    const c=setup.connections.find(c=>c.id===name);
    if(!c?.enabled||!c.configured||!c.priced||c.check?.state!=='passed'||caps.some(cap=>!c.check.capabilities[cap])||Date.now()-Date.parse(c.check.at)>7*86400000||!allowFixture&&c.check.verification!=='live_api')blockers.push('Connect and test required '+name+' account features and pricing.');
  }
  for(const name of ['googleUse','apolloUse','firecrawlUse'])if(!setup.data.permissions[name])blockers.push('Confirm account-specific permitted use: '+name+'.');
  const readers=record(store,'studio-reader-check','studio_reader_check');
  if(readers?.state!=='passed'||!readers.capabilities.scrapling||!readers.capabilities.camofox||Date.now()-Date.parse(readers.at)>7*86400000||!allowFixture&&readers.verification!=='live_reader')blockers.push('Pass the installed Scrapling and guarded Camofox extraction checks.');
  if(setup.spending.uncertain.length)blockers.push('Resolve the exact incomplete charge receipt; its reservation remains consumed.');
  if(setup.spending.recoveryHold?.state==='held')blockers.push('Reconcile lifetime account spending after this restore in Setup before any further paid work.');
  if(setup.spending.remainingMicros<=0)blockers.push('Pilot allowance is exhausted.');
  return {ready:blockers.length===0,blockers,settingsDigest:current,verification:allowFixture?'fixture_dependencies':'live_required',leadQualityProven:false};
}
async function queueDay(store,pilot,{immediate=false,clock=()=>new Date()}={}){
  const date=chicagoDate(clock()),hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'2-digit',hourCycle:'h23'}).format(clock()));
  const restored=record(store,'studio-recovery-hold','studio_recovery_hold');
  if(restored&&date<=restored.throughChicagoDate)return {state:'restore_day_held',queued:false};
  if(!immediate&&hour<9)return {state:'not_due',queued:false};
  return atomic(store,()=>{
    const current=pilotRecord(store);if(!current?.enabled||current.version!==pilot.version)fail('AUTOPILOT_PAUSED','Pilot was paused or changed');
    const id='studio-day-'+date,previous=record(store,id,'studio_day');if(previous)return {...previous,queued:false,replayed:true};
    const job=store.createJob({campaignId:pilot.campaignId,kind:'discovery',input:{studioAutopilot:{cohortId:pilot.cohortId,profileDigest:pilot.settingsDigest,date}}});
    const slot={id,date,jobId:job.id,cohortId:pilot.cohortId,state:'queued',at:now()};saveRecord(store,id,'studio_day',slot);return {...slot,queued:true,job};
  });
}
export async function autopilotDispatch(store,name,input,{request=studioHttp,readers={},clock=()=>new Date()}={}){
  const fixture=request!==studioHttp;
  if(name==='studio_readers_test')return testReaders(store,input,readers);
  if(name==='studio_data_purge')return purgeExpiredStudioData(store);
  if(name==='studio_assessment_get'){const assessment=record(store,input.id,'studio_assessment');if(!assessment)fail('NOT_FOUND','Assessment not found');return assessment;}
  if(name==='studio_autopilot_status'){
    const pilot=pilotRecord(store)||{version:0,enabled:false},readiness=await studioReadiness(store,{allowFixture:fixture});
    const assessments=records(store,'studio_assessment').filter(a=>!pilot.cohortId||a.cohortId===pilot.cohortId),pointers=records(store,'studio_pointer').filter(p=>!pilot.cohortId||p.cohortId===pilot.cohortId);
    const jobs=store.jobs().filter(j=>j.input.studioAutopilot||j.input.apiConcept);
    return {pilot,readiness,spending:studioSpend(store),counts:{pointers:pointers.length,assessed:assessments.length,sourceChecked:assessments.filter(a=>a.state==='source_checked').length,held:assessments.filter(a=>a.state!=='source_checked').length,builds:jobs.filter(j=>j.kind==='site').length},
      assessments:assessments.slice(0,30).map(a=>({id:a.id,pointerId:a.pointerId,name:a.candidate?.name||pointers.find(p=>p.id===a.pointerId)?.data?.name||'Source data expired',state:a.state,reasons:a.reasons,at:a.at,expiresAt:a.expiresAt,verification:a.verification||'unknown',mediaCount:a.media?.length||0})),
      jobs,days:records(store,'studio_day').slice(0,10),readerCheck:record(store,'studio-reader-check','studio_reader_check'),publicRelease:false};
  }
  if(name==='studio_autopilot_pause')return atomic(store,()=>{
    const prior=pilotRecord(store);if(!prior||prior.version!==input.version)fail('STALE_EVIDENCE','Pilot changed; reload before pausing');
    const value={...prior,enabled:false,version:prior.version+1,pausedAt:now(),pauseReason:'Operator paused automation'};saveRecord(store,'studio-autopilot','studio_autopilot',value);
    for(const job of store.jobs())if(['queued','running'].includes(job.state)&&(job.input.studioAutopilot?.cohortId===prior.cohortId||job.input.apiConcept?.cohortId===prior.cohortId))store.cancel(job.id);
    return value;
  });
  if(name==='studio_autopilot_start'){
    const receiptId='studio-start-'+hash(input.requestId).slice(0,24),previous=record(store,receiptId,'studio_activation');
    if(previous){if(previous.inputDigest!==hash(input))fail('IDEMPOTENCY_CONFLICT','Activation request already binds another profile');return {...previous,replayed:true};}
    if(input.settingsDigest!==settingsDigest(store))fail('STALE_PROVIDER_PROFILE','Start must bind the exact saved provider profile');
    const readiness=await studioReadiness(store,{allowFixture:fixture});if(!readiness.ready)fail('SETUP_INCOMPLETE',readiness.blockers.join(' '));
    const pilot=atomic(store,()=>{
      const prior=pilotRecord(store),cfg=settings(store);if((prior?.version||0)!==input.version)fail('STALE_EVIDENCE','Pilot changed; reload before starting');
      const targetDigest=hash({city:cfg.city,niche:cfg.niche,areas:cfg.areas});if(prior&&prior.targetDigest!==targetDigest)fail('PILOT_SCOPE_LOCKED','This fixed-cohort pilot cannot silently change its target or reset its history');
      const campaign=prior?store.campaign(prior.campaignId):store.createCampaign({name:'Houston · DeepSeek-first private pilot',query:cfg.niche,area:cfg.city,niche:cfg.niche,candidateLimit:30,buildLimit:3,retryLimit:0,deadlineMinutes:60,concurrency:1,autoBuild:false});
      return saveRecord(store,'studio-autopilot','studio_autopilot',{...prior,version:input.version+1,enabled:true,cohortId:prior?.cohortId||'cohort-'+hash(campaign.id).slice(0,24),campaignId:campaign.id,settingsDigest:input.settingsDigest,targetDigest,startedAt:prior?.startedAt||now(),updatedAt:now(),pauseReason:null,authorization:{privateDrafts:true,publicPhotosPrivateUse:cfg.permissions.privatePublicPhotos,publicRelease:false,outreach:false,budgetCents:cfg.budgetCents}});
    });
    const slot=await queueDay(store,pilot,{immediate:true,clock});const receipt={id:receiptId,inputDigest:hash(input),pilotVersion:pilot.version,jobId:slot.jobId||null,queued:slot.queued,at:now()};saveRecord(store,receiptId,'studio_activation',receipt);return {...receipt,job:slot.job||null};
  }
  if(name==='studio_autopilot_tick'){
    const pilot=pilotRecord(store);if(!pilot?.enabled)return {state:'disabled',queued:false};
    if(pilot.settingsDigest!==settingsDigest(store))return {state:'needs_setup',queued:false,reason:'Saved provider profile changed; explicitly retest and resume.'};
    const readiness=await studioReadiness(store,{allowFixture:fixture});if(!readiness.ready)return {state:'needs_setup',queued:false,blockers:readiness.blockers};
    return queueDay(store,pilot,{clock});
  }
  fail('UNKNOWN_OPERATION','Unknown automatic-pilot operation');
}
function guardRun(store,job){
  const pilot=pilotRecord(store),binding=job.input.studioAutopilot;
  if(!pilot?.enabled||pilot.cohortId!==binding?.cohortId||pilot.campaignId!==job.campaignId||pilot.settingsDigest!==binding.profileDigest||settingsDigest(store)!==binding.profileDigest)fail('AUTOPILOT_BINDING','The owned job must match the exact enabled pilot and provider profile');
  return pilot;
}
export async function runAutopilotDiscovery({store,job,stage,jobRoot,signal,adapters={}}){
  const request=adapters.studioRequest||studioHttp;let pilot=guardRun(store,job);
  try{
    purgeExpiredStudioData(store);
    await stage('pilot-source',async()=>{
      const current=pilotRecord(store);if(current.cohortFrozen)return {frozen:true};
      let token=null,returnedCount=0,held=[];
      for(let page=0;page<2;page++){
        guardRun(store,job);const result=await discoverPointers(store,{requestId:job.id+'-source-'+page,cohortId:pilot.cohortId,area:settings(store).areas[0],pageToken:token,signal,request});
        returnedCount+=result.returnedCount;held.push(...result.held);token=result.nextPageToken;
        if(!token||records(store,'studio_pointer').filter(p=>p.cohortId===pilot.cohortId).length>=30)break;
      }
      const newest=pilotRecord(store);saveRecord(store,'studio-autopilot','studio_autopilot',{...newest,cohortFrozen:true,sourceReturnedCount:returnedCount,sourceHeld:held});return {returnedCount,heldCount:held.length,cohortFrozen:true};
    });
    pilot=guardRun(store,job);
    const processed=new Set(records(store,'studio_assessment').filter(a=>a.cohortId===pilot.cohortId).map(a=>a.pointerId));
    const pointers=records(store,'studio_pointer').filter(p=>p.cohortId===pilot.cohortId&&!processed.has(p.id)).reverse().slice(0,10);
    const assessmentIds=[];
    for(const pointer of pointers){
      guardRun(store,job);
      const assessment=await stage('investigate-'+pointer.id,async()=>{
        let p=record(store,pointer.id,'studio_pointer');if(!p.data||Date.parse(p.expiresAt)<=Date.now())p=await refreshPointer(store,p,{requestId:job.id+'-refresh-'+p.id,signal,request});
        let result;
        if(p.identityConflict||p.data.operatingStatus!=='OPERATIONAL'||p.data.website&&websiteSurface(p.data.website)==='independent_listed')result={state:'held',reasons:[p.identityConflict?'Conflicting listing identity':p.data.operatingStatus!=='OPERATIONAL'?'Provider reports changed/closed operations':'Listing has an independent website; outside the no-site lane'],candidate:null,observations:[],mediaSelections:[],verification:p.verification};
        else result=await investigatePointer(store,p,{requestId:job.id+'-'+p.id,signal,request,...(adapters.observeSource?{observe:adapters.observeSource}:{}),directory:path.join(jobRoot,'sources')});
        const media=result.state==='source_checked'?await retainResearchMedia(store,result,{signal,...(adapters.downloadSourceMedia?{download:adapters.downloadSourceMedia}:{})}):[];
        const id='assessment-'+hash({jobId:job.id,pointerId:p.id}).slice(0,24),value={...result,id,pointerId:p.id,cohortId:pilot.cohortId,settingsDigest:pilot.settingsDigest,observationRefs:(result.observations||[]).map(o=>({id:o.id,digest:hash(o)})),media,at:now(),expiresAt:new Date(Date.now()+7*86400000).toISOString(),publicRelease:false};
        delete value.observations;saveRecord(store,id,'studio_assessment',value);return value;
      });assessmentIds.push(assessment.id);
    }
    guardRun(store,job);
    const queued=await stage('pilot-build',async()=>{
      const priorSites=store.jobs().filter(j=>j.input.apiConcept?.cohortId===pilot.cohortId);
      if(priorSites.length>=3||priorSites.some(j=>['queued','running'].includes(j.state)))return {queued:false,reason:'Build cap or active proposal'};
      if(priorSites.some(j=>j.input.apiConcept.date===job.input.studioAutopilot.date))return {queued:false,reason:'One proposal already reserved for this date'};
      const used=new Set(priorSites.map(j=>j.input.apiConcept.assessmentId));
      const eligible=records(store,'studio_assessment').filter(a=>a.cohortId===pilot.cohortId&&a.state==='source_checked'&&a.settingsDigest===pilot.settingsDigest&&!used.has(a.id)&&Date.parse(a.expiresAt)>Date.now());
      const assessment=eligible[0];if(!assessment)return {queued:false,reason:'No source-checked opportunity'};
      return queueConcept(store,pilot,assessment,job.input.studioAutopilot.date);
    });
    const dayId='studio-day-'+job.input.studioAutopilot.date,day=record(store,dayId,'studio_day');if(day)saveRecord(store,dayId,'studio_day',{...day,state:'completed',assessmentIds,siteJobId:queued.jobId||null,completedAt:now()});
    const current=pilotRecord(store),all=records(store,'studio_assessment').filter(a=>a.cohortId===pilot.cohortId),total=records(store,'studio_pointer').filter(p=>p.cohortId===pilot.cohortId).length;
    const sites=store.jobs().filter(j=>j.input.apiConcept?.cohortId===pilot.cohortId).length;
    const finished=all.length>=total&&(sites>=3||!all.some(a=>a.state==='source_checked'&&!store.jobs().some(j=>j.input.apiConcept?.assessmentId===a.id)));
    saveRecord(store,'studio-autopilot','studio_autopilot',{...current,lastCompletedAt:now(),...(finished?{enabled:false,pauseReason:'Fixed-cohort work is complete or no further supported opportunities remain. Review actual results before expanding.'}:{})});
    return {cohortId:pilot.cohortId,assessmentIds,siteJobId:queued.jobId||null,publicRelease:false,leadQualityProven:false};
  }catch(error){const current=pilotRecord(store);if(current?.cohortId===pilot.cohortId)saveRecord(store,'studio-autopilot','studio_autopilot',{...current,enabled:false,pauseReason:error.code||'AUTOPILOT_FAILED',pausedAt:now()});throw error;}
}
export function queueConcept(store,pilot,assessment,date){
  return atomic(store,()=>{
    const current=pilotRecord(store);if(!current?.enabled||current.settingsDigest!==pilot.settingsDigest||assessment.state!=='source_checked')fail('AUTOPILOT_BINDING','Only the current enabled source-checked pilot may queue a concept');
    const sites=store.jobs().filter(j=>j.input.apiConcept?.cohortId===pilot.cohortId);if(sites.length>=3||sites.some(j=>j.input.apiConcept.date===date))fail('PILOT_BUILD_CAP','The daily or total proposal allowance is already consumed');
    const designProfile=PREMIUM_PROFILE;
    const digest=hash({candidate:assessment.candidate,media:assessment.media,assessmentDigest:hash(assessment),settingsDigest:pilot.settingsDigest,designProfile}),proofId='api-proof-'+hash({assessment:assessment.id,date}).slice(0,24);
    const job=store.createJob({campaignId:pilot.campaignId,kind:'site',input:{apiConcept:{proofId,digest,cohortId:pilot.cohortId,assessmentId:assessment.id,date},modelSelection:'api/deepseek-first',designProfile}});
    saveRecord(store,proofId,'studio_concept_proof',{jobId:job.id,campaignId:job.campaignId,candidate:assessment.candidate,media:assessment.media,assessmentId:assessment.id,assessmentDigest:hash(assessment),settingsDigest:pilot.settingsDigest,designProfile,digest,publicRelease:false});
    return {queued:true,jobId:job.id};
  });
}
