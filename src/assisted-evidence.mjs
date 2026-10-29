import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { candidateInput, fail, hash, id, safeRelative, publicResourceKey, publicUrl, workRelative } from './contracts.mjs';
import { assessIntake, potentialWebsiteTargets } from './intake.mjs';

export const ASSISTED_SEGMENT = 'booking_social_no_independent_marketing_site';
export const assistedProofId = authorizationId => `assisted-proof-${hash(authorizationId).slice(0,24)}`;
const parse = row => row && JSON.parse(row.record);
function bindingFailure() { fail('BATCH_ASSISTED_BINDING','Assisted evidence, media or exact proof binding changed or is unavailable. No native verification is inferred.'); }
export function assistedRoot(store, bundleId) {
  id(bundleId); if(!/^assisted-[a-f0-9]{24}$/.test(bundleId))bindingFailure();
  const root=path.join(store.stateRoot,'references','assisted-intake',bundleId);
  for(let p=root;;p=path.dirname(p)) {
    try { if(lstatSync(p).isSymbolicLink())bindingFailure(); } catch(e){if(e.code!=='ENOENT')throw e;}
    if(path.dirname(p)===p)break;
  }
  return root;
}
function bytesAt(root, relative, max=1048576) {
  const target=path.join(root,safeRelative(relative));
  for(let p=target;p!==root;p=path.dirname(p))if(lstatSync(p).isSymbolicLink())bindingFailure();
  const info=lstatSync(target);if(!info.isFile()||info.size>max)bindingFailure();
  return readFileSync(target);
}
export function readAssistedEvidence(store,binding) {
  try {
    const receipt=parse(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='assisted_bundle'").get(id(binding.id)));
    if(!receipt||receipt.bundleDigest!==binding.bundleDigest||receipt.evidenceDigest!==binding.evidenceDigest)bindingFailure();
    const root=assistedRoot(store,receipt.id),bytes=bytesAt(root,'bundle.json');
    if(hash(bytes)!==receipt.fileSha256)bindingFailure();
    const bundle=JSON.parse(bytes);
    if(hash(bundle)!==receipt.bundleDigest||hash(bundle.candidate)!==receipt.evidenceDigest||hash(bundle.scope)!==hash(receipt.scope))bindingFailure();
    for(const m of bundle.media)for(const [file,sha] of [[m.original_file,m.original_sha256],[m.web_file,m.web_sha256]]){
      if(!/^(media\/originals\/photo-\d+\.(?:jpg|png|webp|heif)|site\/assets\/photos\/photo-\d+\.webp)$/.test(file)||hash(bytesAt(root,file,8*1024*1024))!==sha)bindingFailure();
    }
    if(hash(bytesAt(root,'media/social-manifest.json'))!==receipt.mediaManifestSha256)bindingFailure();
    const candidate=candidateInput(bundle.candidate);
    if(hash(candidate)!==receipt.evidenceDigest)bindingFailure();
    const times=[candidate.websiteCheck.checkedAt,...bundle.evidence.observations.map(o=>o.inspectedAt),...bundle.evidence.searches.map(s=>s.at),...bundle.evidence.imageViews.map(v=>v.at),...bundle.assets.map(a=>a.review.at)];
    if(times.some(t=>!Number.isFinite(Date.parse(t))||Date.parse(t)<Date.parse(bundle.scope.startedAt)||Date.parse(t)>Date.parse(bundle.scope.sourceCutoff)||Date.parse(t)>Date.now()+300000))bindingFailure();
    const assessment=assessIntake(candidate,bundle.evidence,{segment:bundle.segment});
    return {candidate,evidence:bundle.evidence,media:bundle.media,root,bundleDigest:receipt.bundleDigest,evidenceDigest:receipt.evidenceDigest,assessment,scope:bundle.scope,usage:bundle.usage,segment:bundle.segment};
  } catch(e){if(e.code==='BATCH_ASSISTED_BINDING')throw e;bindingFailure();}
}
export function assertAssistedBinding(store,batch,job,{claiming=false}={}) {
  const binding=batch.assistedIntake;
  if(!binding||binding.segment!==ASSISTED_SEGMENT||job.kind!=='site')bindingFailure();
  const value=readAssistedEvidence(store,binding),proof=parse(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='assisted_proof'").get(assistedProofId(value.scope.authorizationId)));
  const candidate=store.candidate(job.input.candidateId),member=batch.members.find(m=>m.candidateId===candidate.id);
  if(!proof||proof.batchId!==batch.id||proof.bundleId!==binding.id||proof.bundleDigest!==binding.bundleDigest||proof.evidenceDigest!==binding.evidenceDigest||
    hash(proof.scope)!==hash(value.scope)||hash(batch.settings)!==proof.settingsDigest||batch.deadlineAt!==value.scope.deadlineAt||batch.createdAt!==value.scope.startedAt||
    candidate.campaignId!==batch.campaignId||candidate.origin!=='operator_imported_assisted'||hash(candidateInput(candidate))!==value.evidenceDigest||
    !member||!member.ready||member.evidenceDigest!==hash(candidate)||!value.assessment.ready||!batch.selection||batch.selection.candidateId!==candidate.id||
    batch.selection.evidenceDigest!==hash(candidate)||batch.firstCandidateId!==candidate.id||batch.researchJobIds.length||batch.processedResearchIds.length||
    !['production','first_site_review'].includes(batch.phase)||hash(job.input.assistedIntake||null)!==hash(binding))bindingFailure();
  if (job.input.polishOf) assertAssistedPolish(store,batch,job);
  else if (job.input.parentSiteJobId || job.input.assistedRevisionId || claiming && proof.siteJobId !== job.id) assertAssistedRevision(store,batch,job);
  try {
    const files=Object.fromEntries(Object.keys(proof.policyFiles||{}).sort().map(file=>[file,hash(readFileSync(new URL('../'+safeRelative(file),import.meta.url)))]));
    if(!Object.keys(files).length||hash(files)!==batch.policyDigest)bindingFailure();
  }catch{bindingFailure();}
  const reservations=store.db.prepare("SELECT json_extract(record,'$.detail.unit') unit,count(*) n FROM factory_event WHERE json_extract(record,'$.type')='batch.usage_reserved' AND json_extract(record,'$.detail.batchId')=? GROUP BY unit").all(batch.id);
  for(const [unit,cap]of Object.entries({searches:'maxSearches',inspections:'maxInspections',imageViews:'maxImageViews',modelRequests:'maxModelRequests'})){
    if(batch.settings[cap]!==value.scope.limits[unit]||!Number.isInteger(batch.usage[unit])||batch.usage[unit]!==proof.usage[unit]+(reservations.find(r=>r.unit===unit)?.n||0)||batch.usage[unit]>batch.settings[cap])bindingFailure();
  }
  return value;
}

const normalized = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const sameUrl = (a,b) => { try { return publicResourceKey(a)===publicResourceKey(b); } catch { return false; } };
function catalogueUrl(raw) {
  try {
    const u=publicUrl(raw),allowed=new Set(['do','_branch_match_id','utm_medium','_branch_referrer']);
    if(u.hostname!=='booksy.com'||u.hash||!/^\/en-us\/\d+_[a-z0-9_-]+\/?$/i.test(u.pathname)||u.search.length>4096)return null;
    for(const [k,v]of u.searchParams)if(!allowed.has(k)||u.searchParams.getAll(k).length!==1||!v||v.length>2048||/[\u0000-\u001f\u007f]/.test(v)||k==='do'&&v!=='invite')return null;
    u.search='';return u.href;
  }catch{return null;}
}
function safeText(text) {
  return text.length >= 4 && text.length <= 1000 && !/[<>$€£\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) &&
    !/(?:https?:|data:|base64|\/home\/|\/tmp\/|@|\b(?:USD|dollars?|prices?|costs?|reviews?|reviewer|rated|stars?|owner|staff|privacy|terms)\b)/i.test(text);
}
// Only host-derived literal options, never arbitrary caller excerpts. Catalogue
// text is design context from the ORIGINAL external capture, not qualification.
export function availableDesignFacts(value) {
  const { candidate:c, evidence } = value, options=[];
  const add=(o,text,sourceUrl=o.finalUrl)=>{if(safeText(text)&&o.text.includes(text)&&!options.some(f=>f.sourceId===o.id&&f.excerpt===text))options.push({sourceId:o.id,excerpt:text,text,sourceUrl});};
  const contacts=Array.isArray(c.contacts)?c.contacts.map(v=>v.url).filter(Boolean):Object.values(c.contacts||{});
  const socials=evidence.observations.filter(o=>{
    try {return !o.blocked&&['instagram.com','facebook.com'].includes(publicUrl(o.finalUrl).hostname.replace(/^(www|m)\./,''))&&sameUrl(o.url,o.finalUrl)&&contacts.some(u=>sameUrl(u,o.url));}catch{return false;}
  });
  // Previously approved social excerpts are already identity-bound by intake.
  for(const f of c.facts)for(const o of socials)if(sameUrl(f.sourceUrl,o.url))add(o,f.excerpt);
  for(const o of evidence.observations){
    if(o.blocked)continue;
    const sourceUrl=catalogueUrl(o.finalUrl);if(!sourceUrl)continue;
    const name=normalized(c.name),title=normalized(o.title);
    if(!name||!(title===name||title.startsWith(name+' ')))continue;
    const check=c.websiteCheck.linkChecks.find(l=>l.sourceId===o.id&&l.status==='official'&&sameUrl(l.url,o.url));
    if(!check||!socials.some(s=>potentialWebsiteTargets(c,s,evidence.observations).some(t=>t.url&&sameUrl(t.url,check.url))))continue;
    // A custom Booksy alias may commit to its profile, but never to a different
    // direct profile than the one actually published by this business.
    let origin;try{origin=publicUrl(check.url);}catch{continue;}
    if(origin.hostname==='booksy.com'&&catalogueUrl(check.url)!==sourceUrl)continue;
    if(origin.hostname!=='booksy.com'&&!/^[a-z0-9-]+\.booksy\.com$/.test(origin.hostname))continue;
    const lines=o.text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    const start=lines.findIndex(s=>/^services(?:\s*\(?\d+\)?)?\s*$/i.test(s));
    if(start<0)continue;
    for(let i=start+1;i<lines.length;i++){
      const line=lines[i];
      if(/^(?:reviews?|see our work|about us|contact|business details|staff|amenities|portfolio)\b/i.test(line))break;
      if(/^(?:book|show more|more|save|share|options?|popular services|other services|services|\d+[hm](?:\s*\d+m)?|\d+\s*(?:min|minutes?|hours?))\b/i.test(line)||!safeText(line))continue;
      // A service heading is followed by description/price/duration metadata;
      // full descriptive paragraphs remain literal, without prices or inference.
      const nearby=lines.slice(i+1,i+4);
      if(nearby.some(s=>/\$\s*\d|^\d+\s*(?:h|m|min|hour)/i.test(s))||line.length>=40&&/[.!]$/.test(line))add(o,line,sourceUrl);
    }
  }
  return options.slice(0,80);
}

export function assistedSiteDigest(store,parent) {
  try {
    const root=path.join(store.stateRoot,safeRelative(parent.outputs.siteRelative)),files={};let count=0,total=0;
    for(let p=root;;p=path.dirname(p)){if(lstatSync(p).isSymbolicLink())bindingFailure();if(path.dirname(p)===p)break;}
    function walk(dir){
      if(!lstatSync(dir).isDirectory())bindingFailure();
      for(const name of readdirSync(dir)){
        if(++count>1000)bindingFailure();
        const file=path.join(dir,name),info=lstatSync(file);if(info.isSymbolicLink())bindingFailure();
        if(info.isDirectory())walk(file);
        else if(info.isFile()&&info.size<=8*1024*1024){total+=info.size;if(total>32*1024*1024)bindingFailure();files[safeRelative(path.relative(root,file))]=hash(readFileSync(file));}
        else bindingFailure();
      }
    }
    walk(root);if(!Object.keys(files).length)bindingFailure();
    return hash(Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b))));
  }catch(e){if(e.code==='BATCH_ASSISTED_BINDING')throw e;bindingFailure();}
}

// A creative hold precedes packaging, so its output digest may be absent. Only
// registered passing QA for THIS exact proposal can supply that missing binding.
// Never backfill the original output or adopt a hash based on the tree alone.
export function assistedParentSiteBinding(store,parent) {
  try {
    const actual=assistedSiteDigest(store,parent);
    if(parent.outputs.siteDigest){if(parent.outputs.siteDigest!==actual)bindingFailure();return {siteDigest:actual,kind:'output_digest'};}
    if(parent.state!=='blocked'||parent.errorCode!=='DESIGN_REWORK'||parent.outputs.qaPass!==true)bindingFailure();
    const base=workRelative(parent),qaRelative=safeRelative(parent.outputs.qaRelative);
    const match=qaRelative.match(/\/qa-([0-2])$/);
    if(!match||qaRelative!==`${base}/qa-${match[1]}`||parent.outputs.siteRelative!==`${base}/proposal-${match[1]}/site`)bindingFailure();
    const relative=`${qaRelative}/results.json`,artifact=store.artifacts(parent.id).find(a=>a.relative===relative&&a.kind==='qa');
    if(!artifact)bindingFailure();
    const bytes=bytesAt(store.stateRoot,relative,8*1024*1024),sha256=hash(bytes),qa=JSON.parse(bytes);
    if(sha256!==artifact.sha256||qa.pass!==true||!qa.siteHashes||Array.isArray(qa.siteHashes)||!Object.keys(qa.siteHashes).length||hash(qa.siteHashes)!==actual||qa.siteDigest!==actual)bindingFailure();
    return {siteDigest:actual,kind:'registered_passing_qa',relative,sha256};
  }catch(e){if(e.code==='BATCH_ASSISTED_BINDING')throw e;bindingFailure();}
}

export function assertAssistedPolish(store,batch,job) {
  try {
    const parent=store.job(job.input.polishOf);
    if(job.input.polishOf!==job.input.parentSiteJobId||parent.kind!=='site'||parent.campaignId!==job.campaignId||parent.input.candidateId!==job.input.candidateId)bindingFailure();
    if(parent.state!=='blocked'||parent.outputs.qaPass!==true||parent.outputs.reviewStatus!=='creative_rework_required'||!parent.outputs.siteRelative)bindingFailure();
    const parentSiteBinding=assistedParentSiteBinding(store,parent);
    if(job.input.parentSiteDigest!==parentSiteBinding.siteDigest)bindingFailure();
    if(typeof job.input.feedback!=='string'||!job.input.feedback.trim()||job.input.feedback.length>4000)bindingFailure();
    const prior=store.db.prepare("SELECT record FROM factory_job WHERE json_extract(record,'$.kind')='site' AND json_extract(record,'$.input.candidateId')=? AND json_extract(record,'$.input.polishOf') IS NOT NULL").all(job.input.candidateId).map(row=>JSON.parse(row.record));
    if(prior.some(other=>other.id!==job.id))bindingFailure();
    return {parent,parentSiteBinding};
  }catch(e){if(e.code==='BATCH_ASSISTED_BINDING')throw e;bindingFailure();}
}
export function assertAssistedRevision(store,batch,job) {
  try {
    const receipt=parse(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='assisted_revision'").get(id(job.input.assistedRevisionId)));
    const childId=`job-${hash({campaignId:job.campaignId,kind:job.kind,input:job.input}).slice(0,20)}`;
    if(!receipt||receipt.jobId!==childId||job.id&&job.id!==childId||receipt.jobInputDigest!==hash(job.input)||receipt.batchId!==batch.id||receipt.policyDigest!==batch.policyDigest||receipt.bindingDigest!==hash(batch.assistedIntake)||receipt.humanDecision!==null)bindingFailure();
    const parent=store.job(job.input.parentSiteJobId),value=readAssistedEvidence(store,batch.assistedIntake),parentSiteBinding=assistedParentSiteBinding(store,parent);
    if(parent.kind!=='site'||parent.campaignId!==job.campaignId||parent.input.candidateId!==job.input.candidateId||receipt.parentRecordDigest!==hash(parent)||receipt.parentSiteDigest!==parentSiteBinding.siteDigest||job.input.parentSiteDigest!==parentSiteBinding.siteDigest||hash(receipt.parentSiteBinding)!==hash(parentSiteBinding)||receipt.scopeDigest!==hash(value.scope)||receipt.candidateDigest!==hash(store.candidate(job.input.candidateId)))bindingFailure();
    // Use the shared identity matcher through the store without introducing an
    // evidence -> batch-store module cycle. Revisions do not exempt late duplicates.
    if(store.existingEntity(store.candidate(job.input.candidateId)))bindingFailure();
    const available=availableDesignFacts(value),used=new Set();
    if(!Array.isArray(receipt.contentFacts)||receipt.contentFacts.length>12)bindingFailure();
    for(const f of receipt.contentFacts){if(used.has(hash(f))||!available.some(o=>hash(o)===hash(f)))bindingFailure();used.add(hash(f));}
    const sources=Object.fromEntries([...new Set(receipt.contentFacts.map(f=>f.sourceId))].sort().map(sourceId=>[sourceId,hash(value.evidence.observations.find(o=>o.id===sourceId))]));
    if(hash(sources)!==hash(receipt.sourceHashes))bindingFailure();
    return receipt;
  }catch(e){if(e.code==='BATCH_ASSISTED_BINDING')throw e;bindingFailure();}
}
