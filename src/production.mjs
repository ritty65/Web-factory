import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { assessEvidence, fail, hash, safeRelative, validateProposal } from './contracts.mjs';
import { readObservations } from './browser.mjs';
import { prepareMedia } from './media.mjs';
import { stageProposal, treeHashes, workRelative } from './proposal.mjs';
import { checkSite } from './qa.mjs';
import { packageReview } from './package.mjs';
import { noLinks } from './db.mjs';
import { stageRuntime, renderStudies, reviewImages, validateSelection, readCreativeSeed, readDirectionSeed } from './craft.mjs';
import * as creative from './creative.mjs';
import { validateInteraction } from './interaction-contract.mjs';
import { assertAssistedBinding, readAssistedEvidence } from './assisted-evidence.mjs';

export function passingStudyEvidence(rendered){
  const studies=rendered.studies.filter(s=>s.pass===true&&[1280,390].every(w=>rendered.captures.some(c=>c.index===s.index&&c.viewport?.[0]===w)));
  if(!studies.length)fail('DESIGN_STUDY_QA','No alternative has passing desktop and phone evidence; failed studies retained.');
  return {...rendered,pass:true,studies,captures:rendered.captures.filter(c=>studies.some(s=>s.index===c.index))};
}
export function assertPassingStudySelection(rendered,selection){
  if(!rendered.studies.some(s=>s.index===selection.selectedDirection&&s.pass===true))fail('DESIGN_SELECTION','The selected original study index must have passing desktop and phone evidence.');
}
// The caller resolves and validates source-bound revision content first. Keep
// canonical qualification/identity immutable; only creative inputs gain facts.
export function candidateWithDesignContent(candidate,content){
  if(!content?.facts?.length)return candidate;
  return {...candidate,facts:[...candidate.facts,...content.facts],sourceUrls:[...new Set([...candidate.sourceUrls,...content.facts.map(f=>f.sourceUrl)])]};
}

async function reuseMedia(store, parent, jobRoot) {
  const manifest = JSON.parse(await readFile(path.join(store.stateRoot, safeRelative(parent.outputs.packageRelative), 'manifest.json'), 'utf8'));
  if (manifest.siteDigest !== parent.outputs.siteDigest || manifest.humanDecision !== null || manifest.publicRelease !== false) fail('STALE_PACKAGE', 'Parent package is not the bound private proposal');
  return copyVerifiedMedia(path.join(store.stateRoot, workRelative(parent)), manifest.media, jobRoot);
}
export async function copyVerifiedMedia(parentRoot, media, jobRoot) {
  for (const m of media) for (const [field, sha] of [['web_file', m.web_sha256], ['original_file', m.original_sha256]]) {
    const relative = safeRelative(m[field]);
    if (!(field === 'web_file' ? /^site\/assets\/photos\// : /^media\/originals\//).test(relative)) fail('MEDIA_PATH', 'Reused media must retain its original host namespace');
    const source = path.join(parentRoot, relative), target = path.join(jobRoot, relative); await noLinks(source); await noLinks(target);
    const bytes = await readFile(source); if (hash(bytes) !== sha) fail('STALE_MEDIA', 'Parent original/derivative bytes changed');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    try { await writeFile(target, bytes, { flag: 'wx', mode: 0o640 }); } catch (e) { if (e.code !== 'EEXIST' || hash(await readFile(target)) !== sha) throw e; }
  }
  return media;
}
export async function matchingProposal(attemptRoot, siteHashes) {
  for (const name of ['creative-repair', 'repair', 'proposal']) {
    try {
      const saved = JSON.parse(await readFile(path.join(attemptRoot, `checkpoint-${name}.json`), 'utf8'));
      if (hash(saved.value) !== saved.sha256) fail('STALE_PROPOSAL', 'Frozen model proposal changed');
      const proposal = validateProposal(saved.value);
      if (proposal.files.every(f => siteHashes[f.path] === hash(f.content))) return proposal;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  fail('STALE_PROPOSAL', 'No validated preserved model proposal matches the current site');
}
export async function produceSite({ store, job, campaign, stage, register, jobRoot, jobRelative, signal, adapters }) {
  // Check even when qualification/media stages are cached. Assisted evidence is
  // an explicit imported bundle, never a fabricated native discovery job.
  const batchRow=store.db.prepare("SELECT record FROM factory_operation WHERE kind='batch' AND json_extract(record,'$.campaignId')=?").get(job.campaignId);
  const batch=batchRow&&JSON.parse(batchRow.record);
  let assisted=null;
  if(batch?.assistedIntake){assertAssistedBinding(store,batch,job);assisted=readAssistedEvidence(store,batch.assistedIntake);}
  const candidate = await stage('qualification', async () => {
    const value = store.candidate(job.input.candidateId); const assessment = assessEvidence(value);
    if (assessment.state !== 'qualified') fail('QUALIFICATION', assessment.reason);
    if (job.input.parentSiteJobId) {
      const parent = store.job(job.input.parentSiteJobId), frozen = JSON.parse(await readFile(path.join(store.stateRoot, workRelative(parent), 'checkpoint-qualification.json'), 'utf8')).value;
      if (hash(frozen) !== hash(value)) fail('STALE_FACTS', 'A revision cannot silently change its parent business evidence');
      if (hash(await treeHashes(path.join(store.stateRoot, safeSite(parent.outputs.siteRelative)))) !== job.input.parentSiteDigest) fail('STALE_PROPOSAL', 'Exact parent bytes changed before revision production');
    }
    return value;
  });
  const directionSeed = job.directionRepair ? await readDirectionSeed({ store, job, selectionDigest: job.directionRepair.selectionDigest, candidate }) : null;
  const media = await stage('media', async () => {
    if (directionSeed) return copyVerifiedMedia(directionSeed.base, directionSeed.media, jobRoot);
    if(assisted)return copyVerifiedMedia(assisted.root,assisted.media,jobRoot);
    if (job.input.parentSiteJobId) return reuseMedia(store, store.job(job.input.parentSiteJobId), jobRoot);
    const discoveryRow = store.db.prepare("SELECT j.record FROM factory_job j, json_each(j.record,'$.outputs.candidateIds') v WHERE j.campaign_id=? AND json_extract(j.record,'$.kind')='discovery' AND v.value=? ORDER BY j.rowid DESC LIMIT 1").get(candidate.campaignId, candidate.id);
    const discovery = discoveryRow && JSON.parse(discoveryRow.record);
    if (!discovery) fail('SOURCE_REQUIRED', 'A bound discovery/source-observation job is required before automatic media production');
    const observationRoot = path.join(store.stateRoot, 'jobs', discovery.id, `attempt-${discovery.attempt}`, 'sources');
    const observations = await readObservations(observationRoot);
    for (const id of candidate.observationJobIds || []) { const observedJob = store.job(id); if (observedJob.campaignId !== candidate.campaignId || !['source', 'discovery'].includes(observedJob.kind)) fail('SOURCE_BINDING', 'Cross-campaign evidence is not supported'); const root = path.join(store.stateRoot, 'jobs', id, `attempt-${observedJob.attempt}`, 'sources'); observations.push(...await readObservations(root)); }
    return (adapters.prepareMedia || prepareMedia)({ candidate, jobRoot, observations, signal });
  });
  for (const m of media) {
    for (const [field, expected] of [['web_file', m.web_sha256], ['original_file', m.original_sha256]]) { const target = path.join(jobRoot, m[field]); await noLinks(target); if (hash(await readFile(target)) !== expected) fail('STALE_MEDIA', 'Bound media bytes changed since normalization'); }
    await register(`${jobRelative}/${m.web_file}`, 'photo', `${candidate.name} · ${m.role}`);
  }
  const references = store.references().filter(r => r.status === 'inspected');
  const designContent=job.input.assistedRevisionId?await stage('design-content',async()=>{
    const {readDesignContent}=await import('./assisted-redesign.mjs');return readDesignContent(store,job);
  }):null;
  const creativeCandidate=candidateWithDesignContent(candidate,designContent);
  if(designContent){await writeFile(path.join(jobRoot,'design-content.json'),JSON.stringify({...designContent,provenance:'Source-bound content from retained external observations; not a new qualification, native verification or human acceptance.'},null,2),{mode:0o640});await register(`${jobRelative}/design-content.json`,'design_content','Retained source-backed service detail for this exact revision');}
  const visualFiles = [...media.slice(0, 5).map(m => path.join(jobRoot, m.web_file)), ...references.filter(r => ['titos', 'intown', 'danzica'].includes(r.id)).slice(0, 2).map(r => r.captures?.[0]?.artifact?.relative).filter(Boolean).map(r => path.join(store.stateRoot, r))];
  const assistedNote=assisted?'Assisted externally observed research for a PRIVATE proposal. The business already has booking/social pages; do not claim it has no web presence. Link to its actual supported booking service, never implement a fake booking/payment/submission flow. Do not invent legal identity, a storefront or customer visits from an unconfirmed registry/home address. Use only supported facts and actual retained photos; exact-version human review remains required.':null;
  const common = { candidate:creativeCandidate, media, references, directory: jobRoot, model: campaign.model, signal, files: visualFiles, feedback: [job.input.feedback,assistedNote].filter(Boolean).join('\n') || null };
  const seed = directionSeed || (job.input.reuseStudyJobId ? await readCreativeSeed({ store, sourceJobId: job.input.reuseStudyJobId, parent: store.job(job.input.parentSiteJobId), feedback: job.input.feedback, candidate }) : null);
  const brief = await stage('brief', () => seed ? seed.brief : (adapters.makeBrief || creative.makeBrief)(common));
  // Every newly generated proposal, including explicit old-study/direction seeds,
  // must meet today's contract. Only unchanged-site verification may use legacy.
  validateInteraction(brief.signatureInteraction, { candidate:creativeCandidate, media, pages: Array.isArray(brief.pageMap) ? brief.pageMap.map(p => p.file) : [] });
  await writeFile(path.join(jobRoot, 'creative-brief.json'), JSON.stringify(brief, null, 2), { mode: 0o640 }); await register(`${jobRelative}/creative-brief.json`, 'brief', 'Business-specific creative brief');
  const studies = await stage('directions', async () => {
    if (directionSeed) {
      const index = directionSeed.selection.selectedDirection;
      const replacement = await (adapters.repairStudy || creative.repairStudy)({ ...common, brief, selectedStudy: seed.studies[index], failures: directionSeed.selection.blockingDefects, files: [1280, 390].map(w => path.join(directionSeed.base, `directions/study-${index}-${w}.png`)) });
      return seed.studies.map((study, i) => i === index ? replacement : study);
    }
    return seed ? seed.studies : (adapters.makeStudies || creative.makeStudies)({ ...common, brief });
  });
  await writeFile(path.join(jobRoot, 'visual-studies.json'), JSON.stringify(studies), { mode: 0o640 }); await register(`${jobRelative}/visual-studies.json`, 'directions', 'Three actual opening-study sources');
  const rendered = await stage('directions-render', () => renderStudies({ studies, media, candidate, jobRoot, signal }));
  await register(`${jobRelative}/directions/results.json`, 'directions', 'Actual desktop/phone study rendering evidence');
  for (const c of rendered.captures) await register(`${jobRelative}/${c.relative}`, 'direction_capture', `${c.name} · ${c.viewport[0]}px`);
  store.updateJob(job.id, { outputs: { ...store.job(job.id).outputs, candidateId: candidate.id, studyRoots: rendered.studies.map(s => `${jobRelative}/${s.relative}`), craftVersion: 2, ...(seed?.sourceJobId ? { creativeSeedJobId: seed.sourceJobId } : {}), directionRepairs: job.directionRepair ? 1 : 0 } });
  const eligible=passingStudyEvidence(rendered);
  const selection = await stage('selection', () => (adapters.selectDirection || creative.selectDirection)({ ...common, brief, rendered:eligible, reviewFiles: eligible.captures.map(c => path.join(jobRoot, c.relative)) }));
  validateSelection(selection);
  assertPassingStudySelection(eligible,selection);
  await writeFile(path.join(jobRoot, 'direction-selection.json'), JSON.stringify(selection, null, 2), { mode: 0o640 }); await register(`${jobRelative}/direction-selection.json`, 'selection', 'Delegated AI selection from actual study pixels — not acceptance');
  if (selection.blockingDefects.length) fail('DESIGN_SELECTION', 'Rendered directions require creative leadership before a full proposal; see exact selection record');
  const generation = { ...common, brief, selection, selectedStudy: studies[selection.selectedDirection] };
  let proposal = await stage('proposal', () => (adapters.generateProposal || creative.generateProposal)(generation));
  let finalRoot, finalRelative, qa, critique, iteration = 0, technicalRepairs = 0, creativeRepairs = job.directionRepair ? 1 : 0, critiqueIndex = 0;
  for (; iteration < 3; iteration++) {
    finalRelative = `${jobRelative}/proposal-${iteration}/site`; finalRoot = path.join(store.stateRoot, finalRelative);
    await mkdir(path.join(finalRoot, 'assets/photos'), { recursive: true, mode: 0o750 });
    for (const m of media) await copyFile(path.join(jobRoot, m.web_file), path.join(finalRoot, m.web_file.replace(/^site\//, '')));
    await stageRuntime(finalRoot);
    await stageProposal(finalRoot, proposal);
    store.updateJob(job.id, { outputs: { ...store.job(job.id).outputs, siteRelative: finalRelative, candidateId: candidate.id }, message: `Checking proposal ${iteration + 1}` });
    qa = await stage(`qa-${iteration}`, () => (adapters.checkSite || checkSite)({ siteRoot: finalRoot, outputRoot: path.join(jobRoot, `qa-${iteration}`), candidate:creativeCandidate, media, signal, interaction: brief.signatureInteraction }));
    await register(`${jobRelative}/qa-${iteration}/results.json`, 'qa', `Actual QA · proposal ${iteration + 1}`);
    for (const capture of qa.captures || []) await register(`${jobRelative}/qa-${iteration}/${capture.relative}`, 'site_capture', `${candidate.name} · ${capture.file || 'motion'} · ${capture.viewport[0]}px`);
    store.updateJob(job.id, { outputs: { ...store.job(job.id).outputs, qaRelative: `${jobRelative}/qa-${iteration}`, qaPass: qa.pass, proposalVersions: iteration + 1, technicalRepairs, creativeRepairs, reviewStatus: qa.pass ? 'creative_review_pending' : 'technical_rework_required' } });
    if (!qa.pass) {
      if (technicalRepairs >= 1 || iteration >= 2) fail('QA_FAILED', 'The single technical repair budget is exhausted; prior proposals and failure evidence retained');
      technicalRepairs++;
      proposal = await stage('repair', () => (adapters.generateProposal || creative.generateProposal)({ ...generation, previous: proposal, failures: qa.issues, repairKind: 'technical' })); continue;
    }
    const captures = qa.captures?.length ? reviewImages(qa) : adapters.critique ? [] : reviewImages(qa);
    critique = await stage(`critique-${critiqueIndex}`, () => (adapters.critique || creative.critique)({ ...generation, qa, files: captures.map(v => path.join(jobRoot, `qa-${iteration}`, v.relative)), captureManifest: captures }));
    const reviewFile = `visual-review-${critiqueIndex}.json`; await writeFile(path.join(jobRoot, reviewFile), JSON.stringify(critique, null, 2), { mode: 0o640 });
    await register(`${jobRelative}/${reviewFile}`, 'critique', `All-page AI pixel critique ${critiqueIndex + 1} — not human acceptance`); critiqueIndex++;
    if (!critique.blockingDefects?.length) break;
    store.updateJob(job.id, { outputs: { ...store.job(job.id).outputs, reviewStatus: 'creative_rework_required', critiqueNotes: critique.notes, blockingDefects: critique.blockingDefects }, message: 'Technical QA passed; creative review requests changes' });
    if (creativeRepairs >= 1 || iteration >= 2) fail('DESIGN_REWORK', 'The single creative repair budget is exhausted; exact blockers and versions remain for human review');
    creativeRepairs++;
    proposal = await stage('creative-repair', () => (adapters.generateProposal || creative.generateProposal)({ ...generation, files: captures.map(v => path.join(jobRoot, `qa-${iteration}`, v.relative)), previous: proposal, failures: critique.blockingDefects, repairKind: 'creative' }));
  }
  if (!qa?.pass || !critique || critique.blockingDefects?.length) fail('DESIGN_REWORK', 'A passing technical and AI creative record is required before packaging');
  await stage('critique', async () => critique);
  if (hash(store.candidate(candidate.id)) !== hash(candidate)) fail('STALE_FACTS', 'Candidate evidence changed during production; review and rerun before packaging');
  const pack = await stage('package', () => packageReview({ siteRoot: finalRoot, outputRoot: path.join(jobRoot, 'package'), candidate:creativeCandidate, media, qa, design: proposal.design }));
  const archive = await register(`${jobRelative}/package/${pack.archive}`, 'package', `${candidate.name} · exact private review ZIP`);
  const manifest = await register(`${jobRelative}/package/manifest.json`, 'manifest', 'Package manifest and review state');
  return { ...store.job(job.id).outputs, candidateId: candidate.id, siteRelative: finalRelative, qaRelative: `${jobRelative}/qa-${iteration}`, packageRelative: `${jobRelative}/package`, siteDigest: pack.siteDigest, archiveId: archive.id, manifestId: manifest.id, reviewStatus: 'operator_review_required', humanDecision: null, publicRelease: false, proposalVersions: iteration + 1, technicalRepairs, creativeRepairs, selectedDirection: selection.selectedDirection, selectionNotes: selection.notes, qaPass: qa.pass, brief: proposal.design.thesis, critiqueNotes: critique.notes, blockingDefects: [], photoCount: media.length, craftVersion: 2, ...(job.input.parentSiteJobId ? { parentSiteJobId: job.input.parentSiteJobId, parentSiteDigest: job.input.parentSiteDigest } : {}) };
}
export async function verifyExisting({ store, job, stage, register, jobRoot, jobRelative, signal, adapters = {} }) {
  const parent = store.job(job.input.siteJobId), attemptRoot = path.join(store.stateRoot, workRelative(parent));
  const frozen = JSON.parse(await readFile(path.join(attemptRoot, 'checkpoint-qualification.json'), 'utf8')).value;
  if (hash(store.candidate(frozen.id)) !== hash(frozen)) fail('STALE_FACTS', 'Business evidence changed; a QA-only rerun cannot validate a differently briefed proposal');
  const siteRoot = path.join(store.stateRoot, safeSite(parent.outputs.siteRelative));
  const siteHashes = await treeHashes(siteRoot), siteDigest = hash(siteHashes);
  if (siteDigest !== job.input.siteDigest) fail('STALE_PROPOSAL', 'Site bytes changed outside the bound proposal');
  let media, design;
  if (parent.outputs.packageRelative) {
    const prior = JSON.parse(await readFile(path.join(store.stateRoot, safeRelative(parent.outputs.packageRelative), 'manifest.json'), 'utf8'));
    if (prior.siteDigest !== siteDigest) fail('STALE_PACKAGE', 'Prior package no longer binds these site bytes'); media = prior.media; design = prior.design;
  } else {
    const frozenMedia = JSON.parse(await readFile(path.join(attemptRoot, 'checkpoint-media.json'), 'utf8'));
    if (hash(frozenMedia.value) !== frozenMedia.sha256) fail('STALE_MEDIA', 'Frozen media ledger changed'); media = frozenMedia.value;
    design = (await matchingProposal(attemptRoot, siteHashes)).design;
  }
  const brief = JSON.parse(await readFile(path.join(attemptRoot, 'creative-brief.json'), 'utf8'));
  const qa = await stage('qa', () => (adapters.checkSite || checkSite)({ siteRoot, outputRoot: path.join(jobRoot, 'qa'), candidate: frozen, media, interaction: brief.signatureInteraction, signal }));
  await register(`${jobRelative}/qa/results.json`, 'qa', 'Expanded current-policy browser/task QA');
  for (const capture of qa.captures || []) await register(`${jobRelative}/qa/${capture.relative}`, 'site_capture', `${frozen.name} · ${capture.file} · ${capture.viewport[0]}px`);
  if (!qa.pass) { store.updateJob(parent.id, { state: 'blocked', message: 'Current-policy QA found a defect; previous package/evidence retained, no automatic repair or acceptance', outputs: { ...parent.outputs, siteDigest, qaPass: false, verificationJobId: job.id, qaRelative: `${jobRelative}/qa` } }); fail('QA_FAILED', 'Expanded verification failed; inspect exact report before any further work'); }
  const captures = qa.captures?.length ? reviewImages(qa) : adapters.critique ? [] : reviewImages(qa);
  const critique = await stage('critique', () => (adapters.critique || creative.critique)({ candidate: frozen, brief, qa, directory: jobRoot, model: store.campaign(parent.campaignId).model, signal, files: captures.map(c => path.join(jobRoot, 'qa', c.relative)), captureManifest: captures }));
  await writeFile(path.join(jobRoot, 'visual-review.json'), JSON.stringify(critique, null, 2), { mode: 0o640 });
  await register(`${jobRelative}/visual-review.json`, 'critique', 'Fresh all-page AI pixel critique — not human acceptance');
  const reviewOutput = { ...parent.outputs, siteDigest, qaPass: true, verificationJobId: job.id, qaRelative: `${jobRelative}/qa`, critiqueRelative: `${jobRelative}/visual-review.json`, critiqueNotes: critique.notes, blockingDefects: critique.blockingDefects || [], humanDecision: null, publicRelease: false };
  if (critique.blockingDefects?.length) { store.updateJob(parent.id, { state: 'blocked', message: 'Read-only QA passed, but exact all-page AI critique requests creative review; no repair budget reset', outputs: { ...reviewOutput, reviewStatus: 'creative_rework_required' } }); fail('DESIGN_REWORK', 'Fresh all-page critique still blocks packaging; no automatic extra creative repair'); }
  const pack = await stage('package', () => packageReview({ siteRoot, outputRoot: path.join(jobRoot, 'package'), candidate: frozen, media, qa, design }));
  const archive = await register(`${jobRelative}/package/${pack.archive}`, 'package', 'Current-policy exact private review ZIP');
  const manifest = await register(`${jobRelative}/package/manifest.json`, 'manifest', 'Current-policy package manifest');
  store.updateJob(parent.id, { state: 'review_ready', errorCode: null, message: 'Unchanged private proposal passed fresh current-policy QA and all-page AI critique. Exact human visual acceptance remains pending.', outputs: { ...reviewOutput, reviewStatus: 'operator_review_required', packageRelative: `${jobRelative}/package`, archiveId: archive.id, manifestId: manifest.id, brief: design.thesis } });
  store.event(parent.id, 'qa.verified', 'All-page interactions rechecked; new review ZIP bound to expanded QA. Original site bytes unchanged.', { qaJobId: job.id, policyDigest: job.input.policyDigest });
  return { parentSiteJobId: parent.id, siteDigest: pack.siteDigest, archiveId: archive.id, manifestId: manifest.id, reviewStatus: 'operator_review_required', humanDecision: null };
}
function safeSite(relative) { if (typeof relative !== 'string' || !/^jobs\/job-[a-f0-9]{20}\/attempt-[01]\/(?:direction-repair\/)?proposal-[0-2]\/site$/.test(relative)) fail('PROPOSAL_PATH', 'Invalid host proposal binding'); return relative; }
