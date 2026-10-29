// Explicit operator-supplied private concepts. This is not automatic no-site
// lead qualification; no imported prospect becomes qualified through this path.
import { z } from 'zod';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { chromium } from 'playwright';
import path from 'node:path';
import sharp from 'sharp';
import { hash, now, fail, publicUrl } from './contracts.mjs';
import { noLinks } from './db.mjs';
import { transaction } from './sales.mjs';
import { runProcess } from './process.mjs';
import { DEFAULT_FACTORY_MODEL } from './model.mjs';
import {settingsRecord,settingsDigest,studioStatus} from './studio-config.mjs';
import {PREMIUM_PROFILE} from './effects-contract.mjs';
import {SITE_PROFILES,CINEMATIC_PROFILE} from './site-profile.mjs';
import {selectReferenceBindings} from './design-references.mjs';

const key=z.string().regex(/^[a-z0-9][a-z0-9-]{7,95}$/);
const text=(max,min=1)=>z.string().trim().min(min).max(max).refine(s=>!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s));
const publicLink=z.string().max(1800).refine(v=>{try{publicUrl(v);return true;}catch{return false;}});
const draft=z.object({name:text(150),area:text(150),niche:text(150),summary:text(1800,40),services:z.array(text(300)).min(3).max(12),sourceUrl:publicLink,
  phone:z.string().max(40).default(''),email:z.union([z.email().max(200),z.literal('')]).default(''),bookingUrl:z.union([publicLink,z.literal('')]).default(''),
  goal:z.enum(['phone','email','booking']),tone:text(500).default('Clear, distinctive and welcoming'),photoIds:z.array(key).max(6).default([]),
  factsConfirmed:z.boolean(),contactConfirmed:z.boolean(),privateConceptAuthorized:z.boolean(),reviewedAt:z.string().datetime({offset:true})}).strict();
const op=(description,schema,readOnly=false)=>({description,schema,readOnly});
export const INTAKE_OPERATIONS={
  intake_save:op('Save an editable operator-supplied business brief. Does not research, qualify a prospect or start a model.',z.object({id:key,version:z.number().int().min(0),data:draft}).strict()),
  intake_get:op('Read a brief, declared readiness and its owned jobs. No source/model work.',z.object({id:key}).strict(),true),
  intake_list:op('Read recent supplied briefs. Does not infer verified facts or paid customers.',z.object({}).strict(),true),
  intake_photo:op('Store one bounded supplied photo, remove metadata and record declared private-use permission.',z.object({draftId:key,originalBase64:z.string().min(1).max(900000),contentType:z.enum(['image/jpeg','image/png','image/webp']),alt:text(300),permission:z.enum(['owned','permission_for_private_concept'])}).strict()),
  intake_build:op('Explicitly queue one private supplied-content proposal for this exact brief version and selected quality profile. Max three builds per brief; no qualification, acceptance or publication.',z.object({id:key,version:z.number().int().min(1),digest:z.string().regex(/^[a-f0-9]{64}$/),requestId:key,authorized:z.literal(true),designProfile:z.enum(SITE_PROFILES).optional()}).strict()),
  intake_runtime:op('Check actual local proposer/reader binaries without generating, researching or reading credentials.',z.object({}).strict(),true),
};
const get=(store,id,kind)=>{const r=store.db.prepare('SELECT record FROM factory_operation WHERE id=? AND kind=?').get(id,kind);return r?JSON.parse(r.record):null;};
const put=(store,id,kind,r)=>{const result=store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record WHERE factory_operation.kind=excluded.kind').run(id,kind,JSON.stringify(r));if(!result.changes)fail('STATE_NAMESPACE','Record identity belongs to a different operation type; no existing data was replaced');return result;};
export function intakeRecord(store,id){const r=get(store,id,'studio_intake');if(!r)fail('NOT_FOUND','Business brief not found');return r;}
export function intakeReadiness(data){
  const gaps=[];
  if(!data.factsConfirmed)gaps.push('Confirm the supplied facts and services');
  if(!data.contactConfirmed)gaps.push('Confirm the business contact destination');
  if(!data.privateConceptAuthorized)gaps.push('Authorize use of this content for one private concept');
  if(!Number.isFinite(Date.parse(data.reviewedAt))||Date.now()-Date.parse(data.reviewedAt)>7*86400000||Date.parse(data.reviewedAt)>Date.now()+300000)gaps.push('Review the business information again; confirmation is stale or invalid');
  if(data.goal==='phone'&&!/^\+?[\d ()+.-]{8,40}$/.test(data.phone)||data.goal==='email'&&!data.email||data.goal==='booking'&&!data.bookingUrl)gaps.push('Add a valid destination for the selected primary action');
  return {ready:gaps.length===0,gaps,provenance:'operator_supplied_not_independently_verified',leadQualified:false,humanDecision:null,publicRelease:false};
}
const ownedJobs=(store,id)=>store.db.prepare("SELECT record FROM factory_job WHERE json_extract(record,'$.input.ownerIntake.id')=? ORDER BY rowid DESC").all(id).map(r=>JSON.parse(r.record));
function metadata(store,r){return {...r,digest:hash(r.data),readiness:intakeReadiness(r.data),jobs:ownedJobs(store,r.id)};}
export async function intakeRuntime({runner=runProcess}={}){
  const backend=process.env.FACTORY_MODEL_BACKEND==='codex'?'codex':'opencode';
  const checks=[];
  for(const [name,cmd,args] of [['model',backend,['--version']],['reader','agent-browser',['--version']]]){
    try{const r=await runner(cmd,args,{timeout:10000,maxBytes:4096});checks.push({name,status:'available',version:r.stdout.trim().slice(0,100)});}catch{checks.push({name,status:'unavailable'});}
  }
  try{await access(process.env.FACTORY_BROWSER_EXECUTABLE||chromium.executablePath(),constants.X_OK);checks.push({name:'chromium',status:'available'});}catch{checks.push({name:'chromium',status:'unavailable'});}
  let authenticated=backend!=='codex';
  if(backend==='codex'){try{await runner('codex',['login','status'],{timeout:10000,maxBytes:4096});authenticated=true;}catch{}checks.push({name:'model_auth',status:authenticated?'configured_not_live_verified':'not_configured'});}
  return {backend,model:backend==='codex'?'codex/default':DEFAULT_FACTORY_MODEL,checks,canAttemptProposal:authenticated&&checks.find(c=>c.name==='model').status==='available'&&checks.find(c=>c.name==='chromium').status==='available',liveVerified:false,limitations:['Binary availability is not authenticated model/network success.','ChatGPT/Codex sign-in must be established separately on the VPS. No credentials are copied.','Lead search and customer delivery are separate integrations.']};
}
export async function apiIntakeRuntime(store){
  const status=await studioStatus(store),checks=[];
  for(const task of ['research','design','code','repair','vision']){
    const id=status.data.roles[task],connection=status.connections.find(c=>c.id===id),capability=task==='vision'?'vision':task==='research'?'json':'coding';
    const passed=connection?.configured&&connection.priced&&connection.check?.state==='passed'&&connection.check.verification==='live_api'&&connection.check.capabilities[capability]&&Date.now()-Date.parse(connection.check.at)<7*86400000;
    checks.push({name:task,status:passed?'available':'needs_live_test',provider:id});
  }
  try{await access(process.env.FACTORY_BROWSER_EXECUTABLE||chromium.executablePath(),constants.X_OK);checks.push({name:'chromium',status:'available'});}catch{checks.push({name:'chromium',status:'unavailable'});}
  return {backend:'api',model:'api/deepseek-first',checks,canAttemptProposal:checks.every(c=>c.status==='available'),liveVerified:checks.filter(c=>c.name!=='chromium').every(c=>c.status==='available'),limitations:['Connection tests are not lead-quality or website-design acceptance.','Provider charges share the fixed pilot ledger.']};
}
async function verifyPhoto(store,id,draftId){const p=get(store,id,'studio_photo');if(!p||p.draftId!==draftId)fail('INTAKE_PHOTO','Photo does not belong to this brief');for(const [file,digest] of [[p.original,p.originalSha256],[p.web,p.webSha256]]){const target=path.join(store.stateRoot,file);await noLinks(target);if(hash(await readFile(target))!==digest)fail('INTAKE_PHOTO','Retained photo bytes changed');}return p;}
export async function readIntakeProof(store,job){
  const binding=job.input.ownerIntake,p=binding&&get(store,binding.proofId,'studio_proof');
  if(!p||p.id!==binding.id||p.version!==binding.version||p.digest!==binding.digest||hash(p.data)!==p.digest||p.jobId!==job.id||p.campaignId!==job.campaignId||job.input.modelSelection!==p.modelSelection||job.input.designProfile!==p.designProfile||hash(job.input.designReferences||[])!==hash(p.designReferences||[]))fail('INTAKE_BINDING','Exact retained brief, model, design profile, references and owned job must match');
  if(!intakeReadiness(p.data).ready)fail('INTAKE_HELD','Supplied brief confirmation is incomplete or stale');
  const photos=[];for(const id of p.data.photoIds){const photo=await verifyPhoto(store,id,p.id);if(hash(photo)!==p.photoDigests?.[id])fail('INTAKE_BINDING','Photo metadata no longer matches the frozen supplied brief');photos.push(photo);}return {...p,photos};
}
export async function intakeDispatch(store,name,input,{runtime}={}){
  runtime||=settingsRecord(store)?()=>apiIntakeRuntime(store):intakeRuntime;
  if(name==='intake_runtime')return runtime();
  if(name==='intake_get')return metadata(store,intakeRecord(store,input.id));
  if(name==='intake_list')return {items:store.db.prepare("SELECT record FROM factory_operation WHERE kind='studio_intake' ORDER BY rowid DESC LIMIT 100").all().map(r=>metadata(store,JSON.parse(r.record)))};
  if(name==='intake_photo'){
    intakeRecord(store,input.draftId);
    const bytes=Buffer.from(input.originalBase64,'base64');if(bytes.toString('base64')!==input.originalBase64||bytes.length>675000)fail('INTAKE_PHOTO','Photo must be canonical base64 and no more than 675,000 bytes; resize it before upload');
    const image=sharp(bytes,{limitInputPixels:24000000,animated:false}),info=await image.metadata();
    if(!['jpeg','png','webp'].includes(info.format)||'image/'+(info.format==='jpeg'?'jpeg':info.format)!==input.contentType||info.pages>1||info.width<200||info.height<150)fail('INTAKE_PHOTO','Use a single-frame JPEG/PNG/WebP photo at least 200×150 pixels');
    const web=await image.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).webp({quality:80}).toBuffer(),dims=await sharp(web).metadata();
    const id='photo-'+hash({draftId:input.draftId,bytes:hash(bytes),alt:input.alt,permission:input.permission}).slice(0,24);
    const root=path.join(store.stateRoot,'intake','photos',id);await noLinks(root);await mkdir(root,{recursive:true,mode:0o700});
    const original=`intake/photos/${id}/original.${info.format==='jpeg'?'jpg':info.format}`,local=`intake/photos/${id}/web.webp`;
    for(const [file,data] of [[original,bytes],[local,web]]){const target=path.join(store.stateRoot,file);try{await writeFile(target,data,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||hash(await readFile(target))!==hash(data))fail('INTAKE_PHOTO','Conflicting immutable photo bytes');}}
    const p={id,draftId:input.draftId,original,web:local,originalSha256:hash(bytes),webSha256:hash(web),webBytes:web.length,dimensions:[dims.width,dims.height],alt:input.alt,permission:input.permission,publicRelease:false};put(store,id,'studio_photo',p);return {id,alt:p.alt,dimensions:p.dimensions,permission:p.permission,publicRelease:false};
  }
  if(name==='intake_save'){
    if(new Set(input.data.photoIds).size!==input.data.photoIds.length)fail('INTAKE_PHOTO','Duplicate photos are not allowed');
    let total=0;for(const id of input.data.photoIds)total+=(await verifyPhoto(store,id,input.id)).webBytes;
    if(total>1500000)fail('INTAKE_PHOTO','Selected derivatives exceed the private site photo budget. Select fewer or smaller photos.');
    return transaction(store,()=>{const previous=get(store,input.id,'studio_intake');if(previous?.version===input.version+1&&hash(previous.data)===hash(input.data))return metadata(store,previous);if((previous?.version||0)!==input.version)fail('STALE_EVIDENCE','Brief changed; reload before saving');
      const r={id:input.id,version:input.version+1,data:input.data,createdAt:previous?.createdAt||now(),updatedAt:now()};put(store,r.id,'studio_intake',r);return metadata(store,r);});
  }
  if(name!=='intake_build')fail('UNKNOWN_OPERATION','Unsupported intake operation');
  const receiptId='intake-build-'+hash(input.requestId).slice(0,24),existing=get(store,receiptId,'studio_build');
  if(existing){if(existing.inputDigest!==hash(input))fail('IDEMPOTENCY_CONFLICT','This request already binds another brief/version');return {job:store.job(existing.jobId),replayed:true};}
  const r=intakeRecord(store,input.id);if(r.version!==input.version||hash(r.data)!==input.digest)fail('STALE_EVIDENCE','Build must bind the saved exact brief');
  if(!intakeReadiness(r.data).ready)fail('INTAKE_HELD','Complete and confirm the supplied brief first');
  const photoDigests={};for(const id of r.data.photoIds)photoDigests[id]=hash(await verifyPhoto(store,id,r.id));
  if(!(await runtime()).canAttemptProposal)fail('MODEL_CONFIGURATION','Configure and sign in to the selected proposer before building');
  return transaction(store,()=>{
    const current=intakeRecord(store,input.id);if(current.version!==input.version||hash(current.data)!==input.digest)fail('STALE_EVIDENCE','Brief changed during preflight');
    const prior=get(store,receiptId,'studio_build');if(prior){if(prior.inputDigest!==hash(input))fail('IDEMPOTENCY_CONFLICT','Build request changed');return {job:store.job(prior.jobId),replayed:true};}
    const jobs=ownedJobs(store,r.id);if(jobs.some(j=>j.input.ownerIntake.version===r.version))fail('INTAKE_BUILD_EXISTS','This brief version already has a build, including stopped work. Inspect it before editing an explicit new version.');
    if(jobs.length>=3)fail('INTAKE_BUILD_CAP','Three attempts already exist for this brief; no automatic replacement or budget reset');
    const campaign=store.createCampaign({name:r.data.name+' · supplied private concept',area:r.data.area,niche:r.data.niche,query:r.id,candidateLimit:3,buildLimit:3,retryLimit:0,deadlineMinutes:30,autoBuild:false});
    const modelSelection=settingsRecord(store)?'api/deepseek-first':process.env.FACTORY_MODEL_BACKEND==='codex'?'codex/default':DEFAULT_FACTORY_MODEL;
    const proofId='proof-'+hash({id:r.id,version:r.version}).slice(0,24);
    const profile=input.designProfile||settingsRecord(store)?.data.designProfile||PREMIUM_PROFILE;
    if(profile===CINEMATIC_PROFILE&&!modelSelection.startsWith('api/'))fail('MODEL_CONFIGURATION','Cinematic generation requires tested API text and vision connections; the existing native supplied-content route remains separate');
    const design=modelSelection.startsWith('api/')?{designProfile:profile,...(profile===CINEMATIC_PROFILE?{designReferences:selectReferenceBindings(store)}:{})}:{};
    const job=store.createJob({campaignId:campaign.id,kind:'site',input:{ownerIntake:{id:r.id,version:r.version,digest:input.digest,proofId},modelSelection,...design,requestId:input.requestId}});
    put(store,proofId,'studio_proof',{id:r.id,version:r.version,digest:input.digest,data:r.data,photoDigests,jobId:job.id,campaignId:campaign.id,modelSelection,...design,...(modelSelection.startsWith('api/')?{apiSettingsDigest:settingsDigest(store)}:{}),createdAt:now(),provenance:'operator_supplied_private_concept'});
    put(store,receiptId,'studio_build',{id:receiptId,inputDigest:hash(input),jobId:job.id,at:now()});return {job,replayed:false};
  });
}
