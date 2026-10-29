import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { candidateInput, fail, hash, now, publicUrl, publicResourceKey } from './contracts.mjs';
import { noLinks } from './db.mjs';
import { prepareMedia, validateMediaSelection } from './media.mjs';
import { policyIdentity } from './policy.mjs';
import { DEFAULT_FACTORY_MODEL } from './model.mjs';
import { transaction, requirePilot } from './sales.mjs';
import { existingEntity, suppressionFor } from './batch-store.mjs';
import { ASSISTED_SEGMENT, assistedProofId, assistedRoot, readAssistedEvidence } from './assisted-evidence.mjs';

const key=z.string().regex(/^[a-z0-9][a-z0-9-]{1,95}$/), external=key.refine(v=>/^(external|assisted)-/.test(v));
const digest=z.string().regex(/^[a-f0-9]{64}$/), stamp=z.string().datetime({offset:true}), url=z.string().max(1800);
const review=z.object({method:z.literal('external_pixel_review'),observer:z.string().trim().min(1).max(100),at:stamp,notes:z.string().trim().min(8).max(1000)}).strict();
const limits=z.object({searches:z.literal(12),inspections:z.literal(24),imageViews:z.literal(8),modelRequests:z.literal(16)}).strict();
const usage=z.object({searches:z.number().int().min(0).max(12),inspections:z.number().int().min(0).max(24),imageViews:z.number().int().min(0).max(8),modelRequests:z.number().int().min(0).max(16)}).strict();
const scope=z.object({authorizationId:key,startedAt:stamp,sourceCutoff:stamp,deadlineAt:stamp,limits,authorized:z.literal(true)}).strict();
const observation=z.object({id:external,url,finalUrl:url,title:z.string().max(1000),text:z.string().max(60000),inspectedAt:stamp,blocked:z.boolean(),method:z.literal('assisted_external_guest_dom'),sourceKind:z.literal('external_observation'),captureRef:z.string().regex(/^external-[A-Za-z0-9._-]{1,200}$/),
  links:z.array(z.object({url,text:z.string().max(1000)}).strict()).max(40).default([]),
  images:z.array(z.object({id:external,width:z.number().int().min(1).max(24000),height:z.number().int().min(1).max(24000),mediaUrl:url,postUrl:url,alt:z.string().max(2000).optional()}).strict()).max(12).default([])}).strict();
const search=z.object({id:external,sourceKind:z.literal('external_observation'),provider:z.string().min(1).max(100),status:z.enum(['completed','failed','blocked']),intent:z.enum(['verify','discover']),query:z.string().min(1).max(300),at:stamp,
  timePrecision:z.literal('session_window_lower_bound').optional(),observedWithin:z.object({from:stamp,to:stamp}).strict().optional(),
  results:z.array(z.object({url,title:z.string().max(1000),description:z.string().max(4000)}).strict()).max(20)}).strict();
const view=z.object({id:external.optional(),sourceId:external,imageId:external,at:stamp,method:z.literal('external_pixel_review'),pixelsSha256:digest,observer:z.string().min(1).max(100),notes:z.string().min(8).max(1000)}).strict();
const asset=z.object({imageId:external,sourceId:external,originalBase64:z.string().min(1).max(950000),sha256:digest,contentType:z.enum(['image/jpeg','image/png','image/webp']),review}).strict();
const bundle=z.object({version:z.literal(1),segment:z.literal(ASSISTED_SEGMENT),candidate:z.record(z.string(),z.unknown()),observations:z.array(observation).min(1).max(24),searches:z.array(search).min(2).max(12),imageViews:z.array(view).min(1).max(8),assets:z.array(asset).min(1).max(6)}).strict();
const op=(description,schema,readOnly=false)=>({description,schema,readOnly});
export const ASSISTED_OPERATIONS={
  assisted_save:op('Save one immutable externally observed assisted bundle and proof-wide usage. No source/model calls, candidate, job or acceptance.',z.object({requestId:key,scope,usage,bundle}).strict()),
  assisted_get:op('Read sanitized assisted evidence metadata and recorded gaps. No raw captures, signed image URLs, base64 or filesystem paths.',z.object({id:key}).strict(),true),
  assisted_build:op('Explicitly claim one assisted proof for one guarded initial private site under original deadlines and all consumed allowances. Never native discovery, acceptance or publication.',z.object({id:key,bundleDigest:digest,evidenceDigest:digest,policyDigest:digest,requestId:key,authorized:z.literal(true)}).strict()),
};
const get=(store,id,kind)=>{const row=store.db.prepare('SELECT record FROM factory_operation WHERE id=? AND kind=?').get(id,kind);return row&&JSON.parse(row.record);};
function put(store,id,kind,record){store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(id,kind,JSON.stringify(record));}
function validateScope(s,u,previous){
  const start=Date.parse(s.startedAt),cutoff=Date.parse(s.sourceCutoff),end=Date.parse(s.deadlineAt);
  if(start>Date.now()||cutoff<=start||cutoff-start>3600000||end<=cutoff||end-start>14400000||Date.now()>=end)fail('BATCH_DEADLINE','Assisted scope must retain its original <=1h source and <=4h total allowance.');
  if(previous&&(hash(previous.scope)!==hash(s)||Object.keys(u).some(k=>u[k]<previous.usage[k])))fail('ASSISTED_SCOPE','An authorization cannot change scope, extend time or reduce consumed usage.');
  if(previous?.batchId)fail('ASSISTED_CLAIMED','This authorization already claimed its single batch.');
}
function publicMetadata(receipt,value,proof){
  return {id:receipt.id,bundleDigest:receipt.bundleDigest,evidenceDigest:receipt.evidenceDigest,segment:ASSISTED_SEGMENT,provenance:'operator_imported_externally_observed',
    name:value.candidate.name,scope:receipt.scope,usage:receipt.usage,assessment:value.assessment,
    counts:{observations:value.evidence.observations.length,searches:value.evidence.searches.length,imageViews:value.evidence.imageViews.length,photos:value.media.length},
    label:value.assessment.ready?'Booking/social presence; no independent marketing website found in the documented checks.':'Imported business evidence — qualification held; see recorded gaps.',claimedBatchId:proof?.batchId||null,humanDecision:null,publicRelease:false,
    limitations:['Imported observations and AI/operator pixel reviews are not native verification or authenticated human review.','Hashes establish retained-byte integrity, not documentary authenticity, ownership or a public image licence.']};
}
function validateBundle(input){
  const b=input.bundle,c=candidateInput(b.candidate),allIds=new Set();
  if(!Number.isFinite(Date.parse(b.candidate.websiteCheck?.checkedAt)))fail('ASSISTED_CAPTURE_TIME','The actual website-check timestamp must be explicitly supplied, not generated during import.');
  if((c.observationJobIds||[]).length)fail('ASSISTED_PROVENANCE','Assisted evidence cannot claim native observation jobs.');
  for(const value of [...c.inspectionIds,...c.media.flatMap(m=>[m.sourceId,m.imageId]),...(c.activityEvidence?[c.activityEvidence.sourceId]:[])])if(!/^(external|assisted)-/.test(value))fail('ASSISTED_PROVENANCE','External evidence requires explicitly external IDs.');
  for(const o of b.observations){
    if(allIds.has(o.id))fail('ASSISTED_PROVENANCE','Duplicate source IDs are not supported.');allIds.add(o.id);
    publicUrl(o.url);publicUrl(o.finalUrl);for(const link of o.links)publicUrl(link.url);
    for(const image of o.images){publicUrl(image.postUrl);const u=publicUrl(image.mediaUrl,{signed:true});if(!['fbcdn.net','cdninstagram.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))fail('ASSISTED_MEDIA','Only actual observed Instagram/Facebook media resources are supported.');}
  }
  for(const s of b.searches)for(const r of s.results)publicUrl(r.url);
  for(const s of b.searches){
    if(s.timePrecision||s.observedWithin){const w=s.observedWithin;if(s.timePrecision!=='session_window_lower_bound'||!w||s.at!==w.from||Date.parse(w.from)<Date.parse(input.scope.startedAt)||Date.parse(w.to)<Date.parse(w.from)||Date.parse(w.to)>Date.parse(input.scope.sourceCutoff)||Date.parse(w.to)>Date.now()+300000)fail('ASSISTED_CAPTURE_TIME','An external search window must preserve its conservative lower bound inside the original source window.');}
  }
  // The approved MVP uses social-profile facts. Booking/presence classification
  // does not make an incomplete third-party body a content source.
  for(const fact of c.facts){const host=publicUrl(fact.sourceUrl).hostname.replace(/^(www|m)\./,'');if(!['instagram.com','facebook.com'].includes(host))fail('ASSISTED_PROVENANCE','This assisted segment accepts factual content from matched Instagram/Facebook sources only.');}
  const times=[c.websiteCheck.checkedAt,...b.observations.map(o=>o.inspectedAt),...b.searches.map(s=>s.at),...b.imageViews.map(v=>v.at),...b.assets.map(a=>a.review.at)];
  if(times.some(t=>Date.parse(t)<Date.parse(input.scope.startedAt)||Date.parse(t)>Date.parse(input.scope.sourceCutoff)||Date.parse(t)>Date.now()+300000||!Number.isFinite(Date.parse(t))))fail('ASSISTED_CAPTURE_TIME','Captures and pixel review must belong to the original source window.');
  if(input.usage.searches<b.searches.length||input.usage.inspections<b.observations.length||input.usage.imageViews<b.imageViews.length)fail('ASSISTED_USAGE','All retained source attempts must be included in proof-wide consumed usage.');
  if(b.assets.length!==c.media.length)fail('ASSISTED_MEDIA','Every selected image requires exactly one original-byte asset.');
  const assets=new Map();
  for(const a of b.assets){
    const key=`${a.sourceId}/${a.imageId}`,bytes=Buffer.from(a.originalBase64,'base64');
    if(assets.has(key)||bytes.toString('base64')!==a.originalBase64||hash(bytes)!==a.sha256)fail('ASSISTED_MEDIA','Original bytes must be canonical base64 and match their SHA-256.');
    const o=b.observations.find(o=>o.id===a.sourceId),image=o?.images.find(i=>i.id===a.imageId),selected=c.media.find(m=>m.sourceId===a.sourceId&&m.imageId===a.imageId);
    if(!image||!selected||publicResourceKey(image.postUrl)!==publicResourceKey(selected.postUrl)||!b.imageViews.some(v=>v.sourceId===a.sourceId&&v.imageId===a.imageId&&v.pixelsSha256===a.sha256&&v.at===a.review.at&&v.observer===a.review.observer))fail('ASSISTED_MEDIA','Selected source/image/post, original bytes and external pixel review must bind exactly.');
    assets.set(key,{...a,bytes,mediaUrl:image.mediaUrl});
  }
  return {candidate:c,assets};
}
async function stagedBytes(root,relative,max=1048576){
  const file=path.join(root,relative);await noLinks(file);
  const info=await stat(file);if(!info.isFile()||info.size>max)fail('ASSISTED_STAGING','Staged evidence must be a bounded ordinary file.');
  return readFile(file);
}
async function preserveBytes(root,relative,bytes){
  const file=path.join(root,relative);await noLinks(file);
  try{await writeFile(file,bytes,{flag:'wx',mode:0o600});}
  catch(e){if(e.code!=='EEXIST')throw e;if(hash(await stagedBytes(root,relative))!==hash(bytes))fail('IDEMPOTENCY_CONFLICT','Different immutable staged evidence cannot replace this save request.');}
}
async function preparationStage(root,inputDigest){
  const file=path.join(root,'save-stage.json');await noLinks(file);
  try{await writeFile(file,JSON.stringify({version:1,inputDigest,preparationStartedAt:now()}),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  const stage=JSON.parse(await stagedBytes(root,'save-stage.json'));
  if(stage.version!==1||stage.inputDigest!==inputDigest)fail('IDEMPOTENCY_CONFLICT','This interrupted save request already binds different input.');
  if(Object.keys(stage).length!==3||!Number.isFinite(Date.parse(stage.preparationStartedAt))||Date.parse(stage.preparationStartedAt)>Date.now()+300000)fail('ASSISTED_STAGING','The retained preparation stage is invalid.');
  return stage;
}
async function retainedMedia(root,candidate,observations,assets,stage){
  let bytes;try{bytes=await stagedBytes(root,'media/social-manifest.json');}catch(e){if(e.code==='ENOENT')return null;throw e;}
  const media=JSON.parse(bytes);
  if(!Array.isArray(media)||media.length!==candidate.media.length)fail('ASSISTED_STAGING','Retained media must match the complete current selection.');
  // Revalidate the original inputs and recompute derivatives with the SAME pinned
  // normalizer. A manifest's own claimed hashes never authenticate altered pixels.
  const sharp=createRequire(import.meta.url)('sharp'),used=new Set();
  for(const [i,selected]of candidate.media.entries()){
    const m=media[i],asset=assets.get(`${selected.sourceId}/${selected.imageId}`),observation=observations.find(o=>o.id===selected.sourceId);
    const record=validateMediaSelection(candidate,selected,observation);
    if(!m||!Number.isFinite(Date.parse(m.retrieved_at))||Date.parse(m.retrieved_at)<Date.parse(stage.preparationStartedAt)||Date.parse(m.retrieved_at)>Date.now()+300000||used.has(asset.sha256))fail('ASSISTED_STAGING','Retained preparation metadata or original identity is invalid.');
    used.add(asset.sha256);
    const meta=await sharp(asset.bytes,{limitInputPixels:24000000,animated:false}).metadata();
    if(!['jpeg','png','webp','heif'].includes(meta.format)||meta.pages>1&&meta.format!=='jpeg'||meta.width<300||meta.height<200)fail('MEDIA_FORMAT','Retained source format or dimensions are unsuitable.');
    const web=await sharp(asset.bytes,{limitInputPixels:24000000}).rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer(),dims=await sharp(web).metadata();
    const original=`media/originals/photo-${i+1}.${meta.format==='jpeg'?'jpg':meta.format}`,local=`site/assets/photos/photo-${i+1}.webp`;
    const expected={...record,retrieved_at:m.retrieved_at,original_file:original,web_file:local,original_sha256:hash(asset.bytes),web_sha256:hash(web),dimensions:[dims.width,dims.height],original_dimensions:[meta.width,meta.height],bytes:web.length};
    if(hash(m)!==hash(expected)||hash(await stagedBytes(root,original,8*1024*1024))!==expected.original_sha256||hash(await stagedBytes(root,local,8*1024*1024))!==expected.web_sha256)fail('ASSISTED_STAGING','Retained originals, derivatives or provenance changed; interrupted files were not adopted.');
  }
  if(media.reduce((n,m)=>n+m.bytes,0)>1500000)fail('MEDIA_BUDGET','Retained imagery exceeds the existing site budget.');
  return media;
}
async function saveBundle(store,input){
  if(Buffer.byteLength(JSON.stringify(input))>1024*1024)fail('BODY_LIMIT','Assisted input exceeds one MiB.');
  const bundleId=`assisted-${hash(input.requestId).slice(0,24)}`,inputDigest=hash(input),old=get(store,bundleId,'assisted_bundle');
  if(old){if(old.inputDigest!==inputDigest)fail('IDEMPOTENCY_CONFLICT','This save request already contains different immutable evidence.');return publicMetadata(old,readAssistedEvidence(store,old),get(store,assistedProofId(old.scope.authorizationId),'assisted_proof'));}
  const proofId=assistedProofId(input.scope.authorizationId);validateScope(input.scope,input.usage,get(store,proofId,'assisted_proof'));
  const {candidate,assets}=validateBundle(input),root=assistedRoot(store,bundleId);
  await noLinks(root);await mkdir(root,{recursive:true,mode:0o700});
  const staging=await preparationStage(root,inputDigest);
  const observations=input.bundle.observations;
  const media=await retainedMedia(root,candidate,observations,assets,staging)||await prepareMedia({candidate,jobRoot:root,observations,download:async actualUrl=>{
    const matches=[...assets.values()].filter(a=>a.mediaUrl===actualUrl);if(matches.length!==1)fail('ASSISTED_MEDIA','A single exact observed image URL must resolve retained bytes.');
    return {bytes:matches[0].bytes,contentType:matches[0].contentType,status:200};
  }});
  for(const m of media){
    const a=input.bundle.assets.find(a=>a.imageId===m.asset_id&&a.sourceId===m.observation_id),image=observations.find(o=>o.id===a.sourceId).images.find(i=>i.id===a.imageId);
    if(image.width!==m.original_dimensions[0]||image.height!==m.original_dimensions[1])fail('ASSISTED_MEDIA','Observed original image dimensions must match decoded original pixels.');
  }
  const value={version:1,inputDigest,segment:input.bundle.segment,candidate,evidence:{observations,searches:input.bundle.searches,imageViews:input.bundle.imageViews},media,scope:input.scope,usage:input.usage,
    assets:input.bundle.assets.map(({originalBase64,...metadata})=>metadata)};
  const bytes=Buffer.from(JSON.stringify(value));await preserveBytes(root,'bundle.json',bytes);
  const receipt={id:bundleId,kind:'assisted_bundle',inputDigest,bundleDigest:hash(value),evidenceDigest:hash(candidate),fileSha256:hash(bytes),mediaManifestSha256:hash(await readFile(path.join(root,'media/social-manifest.json'))),scope:input.scope,usage:input.usage,createdAt:now()};
  transaction(store,()=>{
    const previous=get(store,proofId,'assisted_proof');validateScope(input.scope,input.usage,previous);
    put(store,proofId,'assisted_proof',{id:proofId,scope:input.scope,usage:input.usage,...(previous?{previousUsage:previous.usage}:{})});
    put(store,bundleId,'assisted_bundle',receipt);
  });
  return publicMetadata(receipt,readAssistedEvidence(store,receipt),get(store,proofId,'assisted_proof'));
}
async function buildBundle(store,input,options){
  const policy=await policyIdentity('production');if(input.policyDigest!==policy.digest)fail('BATCH_POLICY','Explicit current production policy acknowledgement is required.');
  const value=readAssistedEvidence(store,input),receipt=get(store,input.id,'assisted_bundle');
  if(!value.assessment.ready)fail('BATCH_INTAKE','Complete assisted identity/content/contact/activity/media/website evidence is required.');
  if(options.prerequisites){const ready=await options.prerequisites({searchProvider:'assisted_external'});if(!ready.ready)fail('BATCH_READINESS','Required production prerequisites are unavailable.');}
  return transaction(store,()=>{
    const proofId=assistedProofId(value.scope.authorizationId),proof=get(store,proofId,'assisted_proof');
    if(proof?.batchId){
      if(proof.buildInputDigest!==hash(input))fail('ASSISTED_CLAIMED','This authorization already claimed one exact assisted build.');
      return {batch:get(store,proof.batchId,'batch'),job:store.job(proof.siteJobId)};
    }
    validateScope(value.scope,proof.usage,proof);
    const current=readAssistedEvidence(store,input);if(!current.assessment.ready)fail('BATCH_INTAKE','Assisted evidence is no longer current.');
    if(store.db.prepare("SELECT 1 FROM factory_operation WHERE kind='batch' AND json_extract(record,'$.state') IN ('active','held','awaiting_selection','awaiting_first_review')").get())fail('BATCH_ACTIVE','Another open batch prevents this new proof.');
    if(suppressionFor(store,current.candidate))fail('BATCH_SUPPRESSED','This business matches suppressed, lost or delivered work.');
    if(existingEntity(store,current.candidate))fail('BATCH_DUPLICATE','Existing or possibly matching business requires review.');
    if(value.scope.limits.modelRequests-proof.usage.modelRequests<6||(Date.parse(value.scope.deadlineAt)-Date.now())<20*60000)fail('BATCH_COMPLETION_BUDGET','Preserve the existing six-launch and twenty-minute production completion floor; no allowance is reset.');
    const s={area:'Houston city limits',niche:'Assisted source-qualified business',targetCount:1,candidateLimit:1,maxResearchRounds:1,searchProvider:'assisted_external',workflow:'leads_first',discoverySearchLimit:1,
      maxSearches:value.scope.limits.searches,maxInspections:value.scope.limits.inspections,maxImageViews:value.scope.limits.imageViews,maxModelRequests:value.scope.limits.modelRequests,batchMinutes:Math.ceil((Date.parse(value.scope.deadlineAt)-Date.parse(value.scope.startedAt))/60000),jobMinutes:60};
    const batchId=`batch-${hash({assistedProof:proofId}).slice(0,24)}`;
    const campaign=store.createCampaign({name:`Assisted private proof ${batchId.slice(-8)}`,query:`Immutable assisted bundle ${receipt.id}`,area:s.area,niche:s.niche,candidateLimit:1,buildLimit:1,concurrency:1,retryLimit:0,deadlineMinutes:s.jobMinutes,autoBuild:false,model:DEFAULT_FACTORY_MODEL});
    const candidate=store.saveCandidate(campaign.id,current.candidate,'operator_imported_assisted');
    if(candidate.campaignId!==campaign.id)fail('BATCH_DUPLICATE','Candidate identity already belongs to another campaign.');
    const at=now(),binding={id:receipt.id,bundleDigest:receipt.bundleDigest,evidenceDigest:receipt.evidenceDigest,segment:ASSISTED_SEGMENT};
    const b={id:batchId,kind:'batch',inputDigest:hash(input),campaignId:campaign.id,presetVersion:null,settings:s,policyDigest:policy.digest,assistedIntake:binding,
      state:'active',phase:'production',round:0,researchJobIds:[],processedResearchIds:[],members:[{candidateId:candidate.id,ready:true,reasons:[],evidenceDigest:hash(candidate),contacts:current.assessment.contacts,discoveredAt:value.scope.startedAt,provenance:'operator_imported_externally_observed'}],exports:{},checkpoint:null,firstCandidateId:candidate.id,
      selection:{candidateId:candidate.id,evidenceDigest:hash(candidate),requestId:input.requestId,at},usage:proof.usage,discoveryUsage:{searches:0},createdAt:value.scope.startedAt,updatedAt:at,deadlineAt:value.scope.deadlineAt,
      authority:'operator_supplied_assisted_private_run',contactAuthorized:false,publicRelease:false,humanDecision:null,externalReviewUrl:null,message:'One assisted private site; imported observations are not native verification.'};
    put(store,batchId,'batch',b);
    put(store,proofId,'assisted_proof',{...proof,batchId,bundleId:receipt.id,bundleDigest:receipt.bundleDigest,evidenceDigest:receipt.evidenceDigest,settingsDigest:hash(s),policyFiles:policy.files,buildInputDigest:hash(input)});
    const job=store.createJob({campaignId:campaign.id,kind:'site',input:{candidateId:candidate.id,assistedIntake:binding}});
    put(store,proofId,'assisted_proof',{...get(store,proofId,'assisted_proof'),siteJobId:job.id});
    return {batch:b,job};
  });
}
export async function assistedDispatch(store,name,raw,options={}){
  requirePilot(store);const operation=ASSISTED_OPERATIONS[name];if(!operation)fail('UNKNOWN_OPERATION','Unsupported assisted operation.');
  const parsed=operation.schema.safeParse(raw);if(!parsed.success)fail('INVALID_INPUT','Unsupported assisted input fields or values.',{fields:parsed.error.issues.map(i=>i.path.join('.')).slice(0,10)});
  const input=parsed.data;
  if(name==='assisted_save')return saveBundle(store,input);
  if(name==='assisted_build')return buildBundle(store,input,options);
  const receipt=get(store,input.id,'assisted_bundle');if(!receipt)fail('NOT_FOUND','Assisted bundle not found.');
  return publicMetadata(receipt,readAssistedEvidence(store,receipt),get(store,assistedProofId(receipt.scope.authorizationId),'assisted_proof'));
}
