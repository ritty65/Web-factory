import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { assessEvidence, fail, hash, safeRelative } from './contracts.mjs';
import { workRelative, treeHashes, stageProposal } from './proposal.mjs';
import { noLinks } from './db.mjs';
import { copyVerifiedMedia, matchingProposal } from './production.mjs';
import { stageRuntime, reviewImages } from './craft.mjs';
import * as creative from './creative.mjs';
import { checkSite } from './qa.mjs';
import { packageReview } from './package.mjs';
import { validateInteraction } from './interaction-contract.mjs';

// An explicit additional budget action, never an automatic escape from a hold.
export async function producePolish({ store, job, campaign, stage, register, jobRoot, jobRelative, signal, adapters }) {
  const parent = store.job(job.input.polishOf), parentRoot = path.join(store.stateRoot, workRelative(parent));
  async function saved(name) { const target = path.join(parentRoot, `checkpoint-${name}.json`); await noLinks(target); const data = JSON.parse(await readFile(target, 'utf8')); if (hash(data.value) !== data.sha256) fail('STALE_STAGE', 'Held source checkpoint changed'); return data.value; }
  const candidate = await stage('qualification', async () => {
    const current = store.candidate(job.input.candidateId), frozen = await saved('qualification');
    if (hash(current) !== hash(frozen)) fail('STALE_FACTS', 'Additional polish cannot silently change its business evidence');
    const assessment = assessEvidence(current); if (assessment.state !== 'qualified') fail('QUALIFICATION', assessment.reason);
    if (hash(await treeHashes(path.join(store.stateRoot, safeRelative(parent.outputs.siteRelative)))) !== job.input.parentSiteDigest) fail('STALE_PROPOSAL', 'Held parent bytes changed'); return frozen;
  });
  const media = await stage('media', async () => copyVerifiedMedia(parentRoot, await saved('media'), jobRoot));
  for (const m of media) await register(`${jobRelative}/${m.web_file}`, 'photo', `${candidate.name} · unchanged source photo`);
  const brief = JSON.parse(await readFile(path.join(parentRoot, 'creative-brief.json'), 'utf8'));
  validateInteraction(brief.signatureInteraction, { candidate, media, pages: Array.isArray(brief.pageMap) ? brief.pageMap.map(p => p.file) : [] });
  await writeFile(path.join(jobRoot, 'creative-brief.json'), JSON.stringify(brief, null, 2), { mode: 0o640 }); await register(`${jobRelative}/creative-brief.json`, 'brief', 'Retained visual-world brief · additional scoped polish');
  const previous = await matchingProposal(parentRoot, await treeHashes(path.join(store.stateRoot, parent.outputs.siteRelative)));
  const priorQaRoot = path.join(store.stateRoot, safeRelative(parent.outputs.qaRelative)), priorQa = JSON.parse(await readFile(path.join(priorQaRoot, 'results.json'), 'utf8'));
  const priorCaptures = priorQa.captures?.length ? reviewImages(priorQa) : adapters.generatePolish ? [] : reviewImages(priorQa);
  const common = { candidate, media, references: store.references().filter(r => r.status === 'inspected'), brief, previous, feedback: job.input.feedback, failures: parent.outputs.blockingDefects || [], directory: jobRoot, model: campaign.model, signal, files: priorCaptures.map(c => path.join(priorQaRoot, c.relative)) };
  const proposal = await stage('proposal', () => (adapters.generatePolish || creative.polishProposal)(common));
  const siteRelative = `${jobRelative}/proposal-0/site`, siteRoot = path.join(store.stateRoot, siteRelative);
  await mkdir(path.join(siteRoot, 'assets/photos'), { recursive: true, mode: 0o750 });
  for (const m of media) await copyFile(path.join(jobRoot, m.web_file), path.join(siteRoot, m.web_file.replace(/^site\//, '')));
  await stageRuntime(siteRoot); await stageProposal(siteRoot, proposal);
  const baseOutput = { candidateId: candidate.id, parentSiteJobId: parent.id, parentSiteDigest: job.input.parentSiteDigest, polishOf: parent.id, siteRelative, additionalPolishPass: 1, proposalVersions: 1, technicalRepairs: 0, creativeRepairs: 1, craftVersion: 2, humanDecision: null, publicRelease: false };
  store.updateJob(job.id, { outputs: baseOutput });
  const qa = await stage('qa-0', () => (adapters.checkSite || checkSite)({ siteRoot, outputRoot: path.join(jobRoot, 'qa-0'), candidate, media, interaction: brief.signatureInteraction, signal }));
  await register(`${jobRelative}/qa-0/results.json`, 'qa', 'Fresh exact-byte QA · additional polish');
  for (const c of qa.captures || []) await register(`${jobRelative}/qa-0/${c.relative}`, 'site_capture', `${candidate.name} · ${c.file} · ${c.viewport[0]}px`);
  const qaOutput = { ...baseOutput, siteDigest: hash(qa.siteHashes), qaRelative: `${jobRelative}/qa-0`, qaPass: qa.pass, reviewStatus: qa.pass ? 'creative_review_pending' : 'technical_rework_required' };
  store.updateJob(job.id, { outputs: qaOutput });
  if (!qa.pass) fail('QA_FAILED', 'The one additionally authorized polish did not pass QA; evidence retained, no automatic repair');
  const captures = qa.captures?.length ? reviewImages(qa) : adapters.critique ? [] : reviewImages(qa);
  const critique = await stage('critique', () => (adapters.critique || creative.critique)({ ...common, qa, files: captures.map(c => path.join(jobRoot, 'qa-0', c.relative)), captureManifest: captures }));
  await writeFile(path.join(jobRoot, 'visual-review.json'), JSON.stringify(critique, null, 2), { mode: 0o640 }); await register(`${jobRelative}/visual-review.json`, 'critique', 'All-page AI critique of additionally authorized polish');
  const reviewed = { ...qaOutput, critiqueRelative: `${jobRelative}/visual-review.json`, critiqueNotes: critique.notes, blockingDefects: critique.blockingDefects || [], reviewStatus: 'creative_rework_required' }; store.updateJob(job.id, { outputs: reviewed });
  if (critique.blockingDefects?.length) fail('DESIGN_REWORK', 'Additional polish still has visual blockers; no further automatic generation or acceptance');
  if (hash(store.candidate(candidate.id)) !== hash(candidate)) fail('STALE_FACTS', 'Business evidence changed during polish');
  const pack = await stage('package', () => packageReview({ siteRoot, outputRoot: path.join(jobRoot, 'package'), candidate, media, qa, design: proposal.design }));
  const archive = await register(`${jobRelative}/package/${pack.archive}`, 'package', `${candidate.name} · exact additionally polished review ZIP`), manifest = await register(`${jobRelative}/package/manifest.json`, 'manifest', 'Exact polished review manifest');
  return { ...reviewed, reviewStatus: 'operator_review_required', packageRelative: `${jobRelative}/package`, archiveId: archive.id, manifestId: manifest.id, siteDigest: pack.siteDigest, brief: proposal.design.thesis, photoCount: media.length };
}
