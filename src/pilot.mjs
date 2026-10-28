import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {hash,now,fail,safeRelative,assessEvidence} from './contracts.mjs';
import {noLinks} from './db.mjs';
import {treeHashes} from './proposal.mjs';
import {zipBytes} from './package.mjs';
import {getCase,key,requirePilot,transaction} from './sales.mjs';
import {relevantSearchEvidence} from './search.mjs';

export const PILOT_OPERATIONS={
  pilot_status:{description:'Read actual local/assisted readiness and explicit external-commercial blockers. Never certifies sales, contact rights, public media licences or live Vault delivery.',schema:z.object({}).strict(),readOnly:true},
  handoff_prepare:{description:'Prepare an immutable exact local operator-inspection packet for an existing case/site. NOT an external owner link, upload, send, publication receipt or human acceptance.',schema:z.object({id:key,siteDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),readOnly:false},
  research_probe:{description:'Queue one idempotent daily guest-search probe for an EXISTING candidate only. No new discovery/import, no absence inference, login or paid connector.',schema:z.object({candidateId:key}).strict(),readOnly:false},
};
export function operationRecord(store,id,kind,record){requirePilot(store);store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(id,kind,JSON.stringify({id,kind,...record}));return {id,kind,...record};}
export function operationList(store,kind,limit=20){requirePilot(store);return store.db.prepare('SELECT record FROM factory_operation WHERE kind=? ORDER BY rowid DESC LIMIT ?').all(kind,limit).map(r=>JSON.parse(r.record));}
export function pilotStatus(store){
  requirePilot(store);const count=table=>store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  const probes=operationList(store,'research_probe',1),snapshots=operationList(store,'snapshot',1),drills=operationList(store,'restore_drill',1);
  if(probes[0]?.status==='completed'){
    const c=store.candidate(probes[0].candidateId);
    if(!relevantSearchEvidence(`"${c.name}"`,probes[0].results||[]))probes[0]={...probes[0],status:'blocked_inadequate_identity',preservedProviderStatus:'completed',currentPolicyReassessment:true,note:'Original provider observation retained; current identity gate rejects generic results. Not a usable research-path verification.'};
  }
  const qualified=store.db.prepare('SELECT record FROM factory_candidate').all().map(r=>JSON.parse(r.record)).filter(c=>assessEvidence(c).state==='qualified');
  const vault=store.vault().find(v=>v.id==='connection');
  return {at:now(),scope:'local_commercial_pilot_foundation',externalPilotReady:false,authority:{outreach:'separate_approval_required',publication:'separate_approval_required',payment:'no_charge_or_settlement_connector',humanAcceptance:'human_only_not_created_by_case_stage'},search:{mode:qualified.some(c=>c.origin==='external_evidence_import')?'assisted_evidence':'unverified',qualifiedKnownDossiers:qualified.length,probe:probes[0]||null,unattendedDiscoveryCertified:false},transport:{status:vault?.status||'not_verified',externalReviewReady:false,note:'Factory has local isolated previews only. Existing Site Studio exact lifecycle and authenticated Vault prerequisites must be satisfied; no alternate publish/upload route is exposed.'},gates:[{id:'local_workflow',status:'implemented_requires_measured_operation',next:'Use Sales desk, record actual next actions and include unsold work costs'},{id:'research',status:qualified.length?'assisted_not_unattended':'blocked',next:'Verify the permitted research connector; unknown website checks stay on hold'},{id:'review_delivery',status:'blocked',next:'Authorize and verify supported private owner-review transport; localhost is not an external sales link'},{id:'commercial_authority',status:'separate_approval_required',next:'Adopt seller/payment/tax/support terms, recipient/channel authority and budget before a new pilot'},{id:'media_release',status:'private_preview_only',next:'Resolve facts and rightsholder permission before separately authorized public release'},{id:'sales_measurement',status:'unverified',next:'Reconcile payments through an authorized financial system; reported deposits are not verified sales'},{id:'recovery',status:drills[0]?.pass?'local_drill_passed':'not_drilled',next:'Create an idle snapshot and run a new-root restore check; retain an independent/off-machine backup separately'}],counts:{cases:count('factory_sales_case'),allJobs:count('factory_job'),costEntries:count('factory_cost'),reportedMoneyEntries:count('factory_money')},lastSnapshot:snapshots[0]||null,lastRestoreDrill:drills[0]||null,limits:['No new cohort or contact authority is implied','One liked site does not establish repeatable sales or general design quality','Local snapshots are not off-machine disaster protection']};
}
export async function prepareHandoff(store,input){
  const c=getCase(store,input.id);if(c.suppressed||c.stage==='lost')fail('SUPPRESSED','A suppressed/lost business cannot prepare a review handoff');
  if(!c.siteJobId||c.siteDigest!==input.siteDigest)fail('STALE_REVIEW','Choose the exact bound site digest for this case');
  const job=store.job(c.siteJobId),o=job.outputs;
  if(job.kind!=='site'||job.input.candidateId!==c.candidateId||job.state!=='review_ready'||o.siteDigest!==input.siteDigest||!o.qaPass||o.blockingDefects?.length||o.reviewStatus!=='operator_review_required')fail('HANDOFF_REVIEW','Current exact technical/creative review gates must pass before packet preparation');
  const candidate=store.candidate(c.candidateId);if(assessEvidence(candidate).state!=='qualified')fail('QUALIFICATION','Current evidence no longer qualifies');
  const siteRoot=path.join(store.stateRoot,safeRelative(o.siteRelative));const hashes=await treeHashes(siteRoot);if(hash(hashes)!==input.siteDigest)fail('STALE_PROPOSAL','Bound site bytes changed');
  async function read(relative){const target=path.join(store.stateRoot,safeRelative(relative));await noLinks(target);return readFile(target);}
  const manifestBytes=await read(o.packageRelative+'/manifest.json'),manifest=JSON.parse(manifestBytes),qa=JSON.parse(await read(o.qaRelative+'/results.json'));
  const manifestArtifact=o.manifestId&&store.getArtifact(o.manifestId);
  if(!manifestArtifact||manifestArtifact.relative!==o.packageRelative+'/manifest.json'||manifestArtifact.sha256!==hash(manifestBytes))fail('STALE_PACKAGE','The immutable package manifest or provenance changed');
  if(!qa.pass||hash(qa)!==manifest.qaDigest||hash(qa.siteHashes)!==input.siteDigest||hash(manifest.siteHashes)!==input.siteDigest||manifest.siteDigest!==input.siteDigest||manifest.businessId!==candidate.id||manifest.candidateEvidenceDigest!==hash(candidate)||manifest.humanDecision!==null||manifest.publicRelease!==false)fail('STALE_PACKAGE','QA/package/evidence no longer match the exact private proposal');
  if(!o.critiqueRelative)fail('HANDOFF_REVIEW','A byte-bound all-page visual critique is required; technical QA alone is not visual review');
  const critiqueArtifact=[...store.artifacts(job.id),...(o.verificationJobId?store.artifacts(o.verificationJobId):[])].find(a=>a.kind==='critique'&&a.relative===o.critiqueRelative);
  if(!critiqueArtifact)fail('HANDOFF_REVIEW','The exact all-page critique artifact is missing');
  const critiqueBytes=await read(o.critiqueRelative),critique=JSON.parse(critiqueBytes);
  if(hash(critiqueBytes)!==critiqueArtifact.sha256||critique.siteDigest!==input.siteDigest||!Array.isArray(critique.blockingDefects)||critique.blockingDefects.length||critique.humanDecision!==null)fail('HANDOFF_REVIEW','The actual bound visual critique is stale or holds a blocking defect');
  const name=safeRelative(manifest.archive);if(path.basename(name)!==name||!name.endsWith('.zip'))fail('PACKAGE_PATH','Archive must be a ZIP basename');
  const archive=await read(o.packageRelative+'/'+name);if(hash(archive)!==manifest.sha256)fail('STALE_PACKAGE','Current ZIP hash changed');
  const scope={schema:2,businessName:candidate.name,caseId:c.id,siteJobId:job.id,siteDigest:input.siteDigest,intent:'operator_inspection_only',externalReviewUrl:null,contactAuthorized:false,publicRelease:false,humanDecision:null,offer:{status:'working_offer_not_customer_agreement',currency:'USD',basePriceCents:100000,tax:'applicable_tax_not_calculated_or_advised',pages:5,corrections:'subject_to_separately_adopted_terms',ownership:'portable files with applicable third-party rights/notices',exclusions:['domain/hosting','custom backend/integrations','unlimited changes','guaranteed enquiries']},unknowns:candidate.unknowns||[],mediaUse:'operator_authorized_private_preview_not_public_licence',requiredBeforeCommercialDelivery:['Actual exact-version human review','Supported authenticated private review delivery and explicit access authority','Recipient/channel/message authorization and suppression check','Adopted agreement/payment/tax/support terms','Resolve current facts and applicable asset rights']};
  const id=`handoff-${hash({caseId:c.id,siteDigest:input.siteDigest,archive:manifest.sha256,scopeDigest:hash(scope)}).slice(0,24)}`;
  function currentGate(){
    const latest=getCase(store,c.id);if(latest.suppressed||latest.stage==='lost')fail('SUPPRESSED','The current business is suppressed/lost; handoff was not registered');
    if(latest.siteJobId!==job.id||latest.siteDigest!==input.siteDigest)fail('STALE_REVIEW','The case changed its exact proposal during preparation');
    if(hash(store.candidate(c.candidateId))!==hash(candidate)||hash(store.job(job.id).outputs)!==hash(o))fail('STALE_PACKAGE','Current qualification or proposal review changed during preparation');
  }
  const old=store.db.prepare('SELECT record FROM factory_operation WHERE id=?').get(id);
  if(old){const r=JSON.parse(old.record);if(hash(await read(r.relative))!==r.sha256)fail('STALE_HANDOFF','Previously frozen handoff changed');return transaction(store,()=>{currentGate();return r;});}
  const bytes=zipBytes([{name,bytes:archive},{name:'REVIEW-SCOPE.json',bytes:Buffer.from(JSON.stringify(scope,null,2))},{name:'SOURCE-PROVENANCE.json',bytes:Buffer.from(JSON.stringify({sources:candidate.sourceUrls,media:manifest.media},null,2))},{name:'READ-ME-FIRST.txt',bytes:Buffer.from('PRIVATE OPERATOR INSPECTION PACKET\nNot a public website, externally accessible preview, sending approval or owner acceptance.\nReview the exact site and factual/media gaps. Preserve font/photo notices.\nUse only the supported, separately authorized owner-review route; do not tunnel the Factory operator app.\n')}]);
  const relative=`handoffs/${id}/operator-review-${input.siteDigest.slice(0,12)}.zip`,target=path.join(store.stateRoot,relative);await noLinks(target);await mkdir(path.dirname(target),{recursive:true,mode:0o700});
  try{await writeFile(target,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||hash(await readFile(target))!==hash(bytes))throw e;}
  return transaction(store,()=>{
    currentGate();const existing=store.db.prepare('SELECT record FROM factory_operation WHERE id=?').get(id);if(existing)return JSON.parse(existing.record);
    const artifact=store.artifact({jobId:job.id,relative,kind:'review_handoff',label:`${candidate.name} · exact local operator packet, not authority to send`,bytes:bytes.length,sha256:hash(bytes)});
    return operationRecord(store,id,'handoff',{caseId:c.id,siteJobId:job.id,siteDigest:input.siteDigest,relative,artifactId:artifact.id,sha256:hash(bytes),bytes:bytes.length,intent:scope.intent,externalReviewUrl:null,contactAuthorized:false,humanDecision:null,publicRelease:false,preparedAt:now()});
  });
}
export async function pilotDispatch(store,name,input){requirePilot(store);if(name==='pilot_status')return pilotStatus(store);if(name==='handoff_prepare')return prepareHandoff(store,input);if(name==='research_probe'){const c=store.candidate(input.candidateId);return store.createJob({campaignId:c.campaignId,kind:'probe',input:{candidateId:c.id,date:now().slice(0,10)}});}fail('UNKNOWN_OPERATION','Unsupported pilot operation');}
