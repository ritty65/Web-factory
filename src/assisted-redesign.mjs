import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { candidateInput, fail, hash, now, safeRelative } from './contracts.mjs';
import { key, note, requirePilot, transaction } from './sales.mjs';
import { policyIdentity } from './policy.mjs';
import { batchForCampaign, existingEntity, getBatch, guardBatchJob, saveBatch, suppressionFor } from './batch-store.mjs';
import { assistedProofId, assistedParentSiteBinding, assertAssistedBinding, assertAssistedRevision, availableDesignFacts, readAssistedEvidence } from './assisted-evidence.mjs';

export { assertAssistedRevision } from './assisted-evidence.mjs';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const literal=z.string().min(1).max(1000);
const selected=z.object({sourceId:key,excerpt:literal,text:literal}).strict();
export const DESIGN_OPERATIONS={
  design_context_get:{description:'Read exact assisted-site redesign context and bounded literal retained-source options. No source/model calls or mutation; not fresh qualification or acceptance.',schema:z.object({id:key}).strict(),readOnly:true},
  assisted_redesign:{description:'Explicit isolated exact-parent assisted redesign with supplied feedback and literal host-selected content under unchanged batch allowances. No source calls, reset, acceptance or publication.',schema:z.object({id:key,siteDigest:digest,policyDigest:digest,requestId:key,authorized:z.literal(true),feedback:note,contentFacts:z.array(selected).max(12)}).strict(),readOnly:false},
  assisted_polish:{description:'One explicit additional polish of an exact technically passing but visually held assisted site. No new facts, source calls, revision, acceptance or publication.',schema:z.object({id:key,siteDigest:digest,policyDigest:digest,requestId:key,authorized:z.literal(true),feedback:note}).strict(),readOnly:false},
};
const parse=row=>row&&JSON.parse(row.record);
const revisionCount=(store,candidateId)=>store.db.prepare("SELECT count(*) n FROM factory_job WHERE json_extract(record,'$.kind')='site' AND json_extract(record,'$.input.candidateId')=? AND json_extract(record,'$.input.parentSiteJobId') IS NOT NULL AND json_extract(record,'$.input.polishOf') IS NULL").get(candidateId).n;
const pending=(store,parentId)=>store.db.prepare("SELECT id FROM factory_job WHERE json_extract(record,'$.input.parentSiteJobId')=? AND state IN ('queued','running')").get(parentId);
function retainedContext(store,parent,policy,{minModelRequests=6}={}) {
  const batch=batchForCampaign(store,parent.campaignId);
  if(parent.kind!=='site'||!batch?.assistedIntake)fail('ASSISTED_REVISION_STATE','Choose an exact assisted site, not an arbitrary dossier or native job.');
  const value=readAssistedEvidence(store,batch.assistedIntake),candidate=store.candidate(parent.input.candidateId),reasons=[];
  if(!['active','held','awaiting_first_review'].includes(batch.state)||!['production','first_site_review'].includes(batch.phase))reasons.push('The original assisted batch is not open for this correction.');
  if(parent.outputs.qaPass!==true||!(parent.state==='review_ready'&&parent.outputs.reviewStatus==='operator_review_required'||parent.state==='blocked'&&parent.outputs.reviewStatus==='creative_rework_required')||parent.input.polishOf)reasons.push('Parent must be technically passing and review-ready or held for creative rework.');
  const parentSiteBinding=assistedParentSiteBinding(store,parent);
  if(hash(candidateInput(candidate))!==value.evidenceDigest||hash(parent.input.assistedIntake)!==hash(batch.assistedIntake)||candidate.campaignId!==batch.campaignId||candidate.origin!=='operator_imported_assisted'||batch.firstCandidateId!==candidate.id)fail('BATCH_ASSISTED_BINDING','Original assisted candidate or parent binding changed.');
  if(!value.assessment.ready)reasons.push(...value.assessment.reasons);
  if(suppressionFor(store,candidate))reasons.push('This business or identity is suppressed, lost or delivered.');
  if(existingEntity(store,candidate))reasons.push('This identity now matches another existing business.');
  const count=revisionCount(store,candidate.id);
  if(count>=2)reasons.push('Two requested revisions already exist, including failed or stopped work.');
  if(pending(store,parent.id))reasons.push('An isolated revision of this exact parent is already queued or running.');
  const remaining={...Object.fromEntries(Object.entries({searches:'maxSearches',inspections:'maxInspections',imageViews:'maxImageViews',modelRequests:'maxModelRequests'}).map(([unit,cap])=>[unit,batch.settings[cap]-batch.usage[unit]])),minutes:Math.max(0,(Date.parse(batch.deadlineAt)-Date.now())/60000)};
  if(!Number.isFinite(remaining.minutes)||remaining.minutes<20||remaining.modelRequests<minModelRequests)reasons.push(`Original batch must retain ${minModelRequests} native launches and twenty minutes; no allowances reset.`);
  const other=store.db.prepare("SELECT id FROM factory_operation WHERE kind='batch' AND id<>? AND json_extract(record,'$.state') IN ('active','held','awaiting_selection','awaiting_first_review')").get(batch.id);
  if(other)reasons.push('Another open batch prevents an isolated correction.');
  const result={id:parent.id,siteDigest:parentSiteBinding.siteDigest,policyDigest:policy.digest,name:candidate.name,parentState:parent.state,assessment:{ready:reasons.length===0,reasons},scope:value.scope,usage:batch.usage,remaining,availableFacts:availableDesignFacts(value),revisionCount:count,limitations:['Retained external observations are not native or owner verification, new qualification or fresh source checks.','Selected literal content is design context only; canonical intake, source window and consumed usage remain unchanged.','Supplied feedback and technical QA do not establish human acceptance or publication rights.']};
  return {result,batch,value,candidate,parentSiteBinding};
}

export function readDesignContent(store,job) {
  if(!job.input.assistedRevisionId)return {facts:[],sourceHashes:{}};
  const batch=batchForCampaign(store,job.campaignId);
  if(!batch)fail('BATCH_ASSISTED_BINDING','Revision batch is unavailable.');
  assertAssistedBinding(store,batch,job,{claiming:true});
  const receipt=assertAssistedRevision(store,batch,job);
  return {facts:receipt.contentFacts.map((f,i)=>({id:`design-fact-${i+1}`,text:f.text,excerpt:f.excerpt,sourceUrl:f.sourceUrl})),sourceHashes:receipt.sourceHashes};
}

export async function designDispatch(store,name,raw) {
  requirePilot(store);const op=DESIGN_OPERATIONS[name];if(!op)fail('UNKNOWN_OPERATION','Unsupported design operation.');
  const parsed=op.schema.safeParse(raw);if(!parsed.success)fail('INVALID_INPUT','Exact site/policy/request authorization, bounded feedback and literal host fact selections are required; no extra fields.');
  const input=parsed.data,policy=await policyIdentity('production');
  if(name==='design_context_get')return retainedContext(store,store.job(input.id),policy).result;
  if(name==='assisted_polish')return transaction(store,()=>{
    const receiptId=`assisted-polish-${hash({parentId:input.id,requestId:input.requestId}).slice(0,24)}`;
    const old=parse(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='assisted_polish'").get(receiptId));
    if(old){if(old.inputDigest!==hash(input))fail('IDEMPOTENCY_CONFLICT','This polish request already binds different immutable input.');return {job:store.job(old.jobId),batch:getBatch(store,old.batchId),replayed:true};}
    if(input.policyDigest!==policy.digest)fail('BATCH_POLICY','Explicit exact current production policy acknowledgement is required.');
    for(const [file,sha]of Object.entries(policy.files))if(hash(readFileSync(new URL('../'+safeRelative(file),import.meta.url)))!==sha)fail('BATCH_POLICY','Production policy changed before polish admission.');
    const parent=store.job(input.id);
    if(pending(store,parent.id))fail('ASSISTED_POLISH_PENDING','A revision or polish of this exact parent is already pending; inspect it instead of creating another.');
    const {result,batch,value,candidate,parentSiteBinding}=retainedContext(store,parent,policy,{minModelRequests:2});
    if(input.siteDigest!==result.siteDigest)fail('STALE_PROPOSAL','Polish feedback must bind the exact retained parent version.');
    if(!result.assessment.ready)fail('ASSISTED_POLISH_STATE',result.assessment.reasons.join(' '));
    if(parent.state!=='blocked'||parent.outputs.qaPass!==true||parent.outputs.reviewStatus!=='creative_rework_required'||!parent.outputs.siteRelative)fail('ASSISTED_POLISH_STATE','One additional polish requires an exact technically passing, visually held private proposal.');
    const prior=store.db.prepare("SELECT id FROM factory_job WHERE json_extract(record,'$.input.candidateId')=? AND json_extract(record,'$.input.polishOf') IS NOT NULL").get(candidate.id);
    if(prior)fail('POLISH_CAP','One additional polish already exists for this business.');
    const at=now(),history={previousPolicyDigest:batch.policyDigest,policyDigest:policy.digest,requestId:input.requestId,polishReceiptId:receiptId,at,authority:'explicit_isolated_assisted_polish_not_human_acceptance'};
    const next={...batch,policyDigest:policy.digest,policyFiles:policy.files,policyHistory:[...(batch.policyHistory||[]),history]};
    const proofId=assistedProofId(value.scope.authorizationId),proof=parse(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='assisted_proof'").get(proofId));
    if(!proof||!proof.siteJobId)fail('BATCH_ASSISTED_BINDING','The original assisted proof is unavailable.');
    store.db.prepare("UPDATE factory_operation SET record=? WHERE id=? AND kind='assisted_proof'").run(JSON.stringify({...proof,policyFiles:policy.files,policyHistory:[...(proof.policyHistory||[]),history]}),proofId);
    saveBatch(store,next);
    const childInput={candidateId:candidate.id,parentSiteJobId:parent.id,parentSiteDigest:input.siteDigest,polishOf:parent.id,feedback:input.feedback,craftVersion:2,assistedIntake:parent.input.assistedIntake};
    const jobId=`job-${hash({campaignId:parent.campaignId,kind:'site',input:childInput}).slice(0,20)}`;
    const receipt={id:receiptId,kind:'assisted_polish',jobId,batchId:batch.id,inputDigest:hash(input),jobInputDigest:hash(childInput),parentRecordDigest:hash(parent),parentSiteDigest:input.siteDigest,parentSiteBinding,candidateDigest:hash(candidate),bindingDigest:hash(batch.assistedIntake),scopeDigest:hash(value.scope),policyDigest:policy.digest,policyFiles:policy.files,at,humanDecision:null,publicRelease:false};
    store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?)').run(receiptId,'assisted_polish',JSON.stringify(receipt));
    const job=store.createJob({campaignId:parent.campaignId,kind:'site',input:childInput});
    guardBatchJob(store,job,{claiming:true});
    store.event(parent.id,'review.note','Supplied exact-version polish feedback; not authenticated human acceptance.',{source:'supplied_feedback',note:input.feedback,siteDigest:input.siteDigest,receiptId,humanDecision:null});
    return {job,batch:getBatch(store,batch.id),replayed:false};
  });
  return transaction(store,()=>{
    const receiptId=`assisted-revision-${hash({parentId:input.id,requestId:input.requestId}).slice(0,24)}`;
    const old=parse(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='assisted_revision'").get(receiptId));
    if(old){if(old.inputDigest!==hash(input))fail('IDEMPOTENCY_CONFLICT','This redesign request already binds different immutable input.');return {job:store.job(old.jobId),batch:getBatch(store,old.batchId),replayed:true};}
    if(input.policyDigest!==policy.digest)fail('BATCH_POLICY','Explicit exact current production policy acknowledgement is required.');
    for(const [file,sha]of Object.entries(policy.files))if(hash(readFileSync(new URL('../'+safeRelative(file),import.meta.url)))!==sha)fail('BATCH_POLICY','Production policy changed before redesign admission.');
    const parent=store.job(input.id);
    if(pending(store,parent.id))fail('ASSISTED_REVISION_PENDING','One revision of this exact parent is already pending; inspect it instead of creating another.');
    const {result,batch,value,candidate,parentSiteBinding}=retainedContext(store,parent,policy);
    if(input.siteDigest!==result.siteDigest)fail('STALE_PROPOSAL','Feedback must bind the exact retained parent version.');
    if(!result.assessment.ready)fail('ASSISTED_REVISION_STATE',result.assessment.reasons.join(' '));
    const contentFacts=[],seen=new Set();
    for(const f of input.contentFacts){const found=result.availableFacts.find(o=>hash({sourceId:o.sourceId,excerpt:o.excerpt,text:o.text})===hash(f));if(!found||seen.has(hash(f)))fail('ASSISTED_CONTENT','Select distinct exact host-provided literal content options only.');seen.add(hash(f));contentFacts.push(found);}
    const at=now(),history={previousPolicyDigest:batch.policyDigest,policyDigest:policy.digest,requestId:input.requestId,revisionReceiptId:receiptId,at,authority:'explicit_isolated_assisted_revision_not_human_acceptance'};
    const next={...batch,policyDigest:policy.digest,policyFiles:policy.files,policyHistory:[...(batch.policyHistory||[]),history]};
    const proofId=assistedProofId(value.scope.authorizationId),proof=parse(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='assisted_proof'").get(proofId));
    if(!proof||!proof.siteJobId)fail('BATCH_ASSISTED_BINDING','The original assisted proof is unavailable.');
    store.db.prepare("UPDATE factory_operation SET record=? WHERE id=? AND kind='assisted_proof'").run(JSON.stringify({...proof,policyFiles:policy.files,policyHistory:[...(proof.policyHistory||[]),history]}),proofId);
    saveBatch(store,next);
    // Validate the exact original lineage against adopted current policy before
    // installing child authority. This does not rewrite the original job/proof.
    assertAssistedBinding(store,next,parent,{claiming:true});
    const childInput={candidateId:candidate.id,parentSiteJobId:parent.id,parentSiteDigest:input.siteDigest,feedback:input.feedback,craftVersion:2,assistedIntake:parent.input.assistedIntake,assistedRevisionId:receiptId};
    const jobId=`job-${hash({campaignId:parent.campaignId,kind:'site',input:childInput}).slice(0,20)}`;
    const sourceHashes=Object.fromEntries([...new Set(contentFacts.map(f=>f.sourceId))].sort().map(sourceId=>[sourceId,hash(value.evidence.observations.find(o=>o.id===sourceId))]));
    const receipt={id:receiptId,kind:'assisted_revision',jobId,batchId:batch.id,inputDigest:hash(input),jobInputDigest:hash(childInput),parentRecordDigest:hash(parent),parentSiteDigest:input.siteDigest,parentSiteBinding,candidateDigest:hash(candidate),bindingDigest:hash(batch.assistedIntake),scopeDigest:hash(value.scope),policyDigest:policy.digest,policyFiles:policy.files,contentFacts,sourceHashes,at,humanDecision:null,publicRelease:false};
    store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?)').run(receiptId,'assisted_revision',JSON.stringify(receipt));
    const job=store.createJob({campaignId:parent.campaignId,kind:'site',input:childInput});
    guardBatchJob(store,job,{claiming:true});
    store.event(parent.id,'review.note','Supplied exact-version redesign feedback; not authenticated human acceptance.',{source:'supplied_feedback',note:input.feedback,siteDigest:input.siteDigest,receiptId,humanDecision:null});
    return {job,batch:getBatch(store,batch.id),replayed:false};
  });
}
