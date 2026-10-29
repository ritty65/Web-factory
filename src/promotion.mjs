import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { treeHashes, workRelative } from './proposal.mjs';
import { noLinks } from './db.mjs';
import { fail, hash, now, safeRelative } from './contracts.mjs';
import { runProcess } from './process.mjs';
import { guardBatchRegistration } from './batch-store.mjs';

export const DELIVERABLES = '/home/ai_dev/04_DELIVERABLES/simulacra-factory-20261021';
async function refreshIndex(store, businessId) {
  if (!store.db.prepare("SELECT name FROM sqlite_master WHERE name='file'").get()) return { status: 'not_initialized', note: 'This fixture/library has no file index. No indexed-file success is claimed.' };
  // Fixed local Python boundary, not an agent-supplied program or shell. The
  // existing library validates its narrow dossier root and refreshes one ID.
  await runProcess('python3', ['-B', '-c', 'import sys; from pathlib import Path; import library; library.refresh(Path(sys.argv[1]), business_id=sys.argv[2])', store.dbPath, businessId], { cwd: '/home/ai_dev/01_PROJECTS/BUSINESS/simulacra-business-library', timeout: 30000, maxBytes: 4096 });
  return { status: 'indexed', fileCount: store.db.prepare('SELECT count(*) n FROM file WHERE business_id=?').get(businessId).n };
}
export async function promoteReview(store, jobId, { deliverablesRoot = DELIVERABLES, guardRegistration = () => {} } = {}) {
  const job = store.job(jobId);
  if (job.kind !== 'site' || job.state !== 'review_ready' || job.outputs.reviewStatus !== 'operator_review_required') fail('REVIEW_REQUIRED', 'Only a complete review-ready private proposal can enter the curated library');
  guardBatchRegistration(store, job); guardRegistration();
  const candidate = store.candidate(job.input.candidateId), businessId = `factory-${candidate.id}`;
  const existing = store.businesses().find(v => v.id === businessId);
  const siteRoot = path.join(store.stateRoot, safeRelative(job.outputs.siteRelative));
  const hashes = await treeHashes(siteRoot); if (hash(hashes) !== job.outputs.siteDigest) fail('STALE_PROPOSAL', 'Current proposal bytes no longer match review evidence');
  const attemptRoot = path.join(store.stateRoot, workRelative(job));
  const packageRoot = job.outputs.packageRelative ? path.join(store.stateRoot, safeRelative(job.outputs.packageRelative)) : path.join(attemptRoot, 'package');
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'manifest.json'), 'utf8'));
  if (hash(manifest.siteHashes) !== hash(hashes) || manifest.humanDecision !== null || manifest.publicRelease !== false) fail('STALE_PACKAGE', 'Review package binding/state is invalid');
  const root = path.join(deliverablesRoot, 'businesses', candidate.id, job.outputs.siteDigest.slice(0, 12)); await noLinks(root);
  async function write(relative, bytes) {
    safeRelative(relative); const target = path.join(root, relative); await noLinks(target); await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    try { await writeFile(target, bytes, { flag: 'wx', mode: 0o640 }); } catch (e) { if (e.code !== 'EEXIST' || hash(await readFile(target)) !== hash(bytes)) throw e; }
  }
  const qaDir = `qa-${job.outputs.proposalVersions ? job.outputs.proposalVersions - 1 : 0}`;
  const qaRoot = job.outputs.qaRelative ? path.join(store.stateRoot, safeRelative(job.outputs.qaRelative)) : path.join(attemptRoot, qaDir), qa = JSON.parse(await readFile(path.join(qaRoot, 'results.json'), 'utf8'));
  if (!qa.pass || hash(qa.siteHashes) !== hash(hashes)) fail('STALE_QA', 'Curated export requires current passing QA');
  const archiveName = safeRelative(manifest.archive); if (path.basename(archiveName) !== archiveName || !archiveName.endsWith('.zip')) fail('PACKAGE_PATH', 'Package must be a ZIP basename');
  const archive = await readFile(path.join(packageRoot, archiveName)); if (hash(archive) !== manifest.sha256) fail('STALE_PACKAGE', 'Archive checksum changed');
  for (const file of Object.keys(hashes)) await write('site/' + file, await readFile(path.join(siteRoot, file)));
  const media = manifest.media || [];
  for (const m of media) { const relative = safeRelative(m.original_file); if (!relative.startsWith('media/originals/')) fail('MEDIA_PATH', 'Originals must stay in the media/originals namespace'); const original = path.join(attemptRoot, relative); await noLinks(original); const bytes = await readFile(original); if (hash(bytes) !== m.original_sha256) fail('STALE_MEDIA', 'Original media checksum changed'); await write(relative, bytes); }
  await write('media/social-manifest.json', Buffer.from(JSON.stringify(media, null, 2)));
  for (const file of Object.keys(await treeHashes(qaRoot))) await write('qa/' + file, await readFile(path.join(qaRoot, file)));
  await write('packages/' + archiveName, archive); await write('packages/verification.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  await write('dossier.json', Buffer.from(JSON.stringify(candidate, null, 2)));
  await write('creative-brief.json', await readFile(path.join(attemptRoot, 'creative-brief.json')));
  // Allowlisted human evidence only. Never export raw model sessions, checkpoints,
  // source dumps, expiring CDN URLs, browser state or private failure diagnostics.
  for (const name of ['direction-selection.json', ...(await readdir(attemptRoot)).filter(n => /^visual-review-\d+\.json$/.test(n))]) {
    try { await write(name, await readFile(path.join(attemptRoot, name))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  try { for (const file of Object.keys(await treeHashes(path.join(attemptRoot, 'directions')))) await write('directions/' + file, await readFile(path.join(attemptRoot, 'directions', file))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const critique = job.outputs.critiqueRelative ? JSON.parse(await readFile(path.join(store.stateRoot, safeRelative(job.outputs.critiqueRelative)), 'utf8')) : JSON.parse(await readFile(path.join(attemptRoot, 'checkpoint-critique.json'), 'utf8')).value;
  await write('visual-review.json', Buffer.from(JSON.stringify(critique, null, 2)));
  if (job.input.parentSiteJobId) await write('DESIGN-LINEAGE.json', Buffer.from(JSON.stringify({ currentJobId: job.id, currentSiteDigest: job.outputs.siteDigest, parentSiteJobId: job.input.parentSiteJobId, parentSiteDigest: job.input.parentSiteDigest, parentWorkRecord: `http://127.0.0.1:8780/#jobs/${job.input.parentSiteJobId}`, additionalPolishPass: Boolean(job.input.polishOf), humanDecision: null, note: 'Parent studies, failed proposals and source evidence remain preserved in their original records; no human acceptance is implied.' }, null, 2)));
  await write('QUALITY.json', Buffer.from(JSON.stringify({ siteHashes: hashes, siteDigest: hash(hashes), qa: 'qa/results.json', visualReview: critique, humanDecision: null, reviewStatus: 'operator_review_required', publicRelease: false }, null, 2)));
  await write('README.md', Buffer.from(`# ${candidate.name} — private review proposal\n\nStatus: **operator_review_required**. Human exact-version acceptance: pending.\n\nOpen \`site/index.html\` or the isolated local app preview. Package: \`packages/${archiveName}\`. SHA-256: \`${manifest.sha256}\`.\n\nThis is an independent private website concept, not an official site, owner endorsement, completed sale or authorized publication. Photos remain operator_authorized_private_preview; rightsholder permission is unconfirmed, public release false.\n\nSources/unknowns: \`dossier.json\`. Creative direction: \`creative-brief.json\`. Exact QA: \`qa/results.json\`. Actual-pixel AI critique, not human approval: \`QUALITY.json\`. Original/web photographs and source credits: \`media/social-manifest.json\`.\n`));
  let record = { id: businessId, name: candidate.name, category: store.campaign(candidate.campaignId).niche, area: candidate.area, summary: candidate.summary, checked_at: candidate.websiteCheck.checkedAt, design_status: 'revision_ready', qualification: { status: 'qualified_for_design_review', rationale: candidate.assessment.reason, source: candidate.origin }, states: { owner_acceptance: 'unconfirmed', image_rights: 'operator_authorized_private_preview', contact_eligibility: 'not_authorized', payment: 'not_recorded', exact_version_acceptance: 'pending_human_review' }, contacts: Object.entries(candidate.contacts).map(([label, value]) => ({ label: label[0].toUpperCase() + label.slice(1), value, ...(/^https:/.test(value) ? { url: value } : {}) })), facts: candidate.facts.map(f => ({ label: f.id, value: f.text, source_url: f.sourceUrl })), unknowns: candidate.unknowns, feedback: [{ source: 'AI critique — not human acceptance', text: (critique.notes || []).join(' '), at: now() }], next_actions: ['Actual operator desktop/phone/interaction review of this exact version', 'Resolve missing current facts and public image rights before any separately authorized commercial release'], folders: { concept: root }, artifacts: [{ folder: 'concept', pattern: '*.md', kind: 'document', label: 'Private review guide and critique' }, { folder: 'concept', pattern: '*.json', kind: 'document', label: 'Dossier, brief and quality packet' }, { folder: 'concept', pattern: 'site/**/*', kind: 'source', label: 'Exact static proposal source' }, { folder: 'concept', pattern: 'qa/*', kind: 'qa', label: 'Actual browser evidence' }, { folder: 'concept', pattern: 'packages/*', kind: 'package', label: 'Review package and manifest' }], preview_url: `http://127.0.0.1:8781/site/${job.id}/index.html` };
  // Serialize the narrow append against current human metadata, not the stale
  // copy read before filesystem export. Existing decisions/default preview stay.
  store.db.exec('BEGIN IMMEDIATE');
  try {
    guardBatchRegistration(store, store.job(jobId));
    guardRegistration();
    if (hash(store.candidate(candidate.id)) !== hash(candidate) || hash(store.job(job.id).outputs) !== hash(job.outputs)) fail('STALE_EXPORT', 'Candidate or proposal changed during export; no curated registration was made.');
    const row = store.db.prepare('SELECT record FROM business WHERE id=?').get(businessId);
    if (row) {
      const current = JSON.parse(row.record); record = current;
      if (!Object.values(current.folders || {}).includes(root)) {
        const folder = `proposal_${job.outputs.siteDigest.slice(0, 12)}`;
        const specifications = (current.artifacts || []).filter(a => a.folder === 'concept');
        record = { ...current, folders: { ...current.folders, [folder]: root }, artifacts: [...(current.artifacts || []), ...specifications.map(a => ({ ...a, folder, label: `${a.label} · ${job.outputs.siteDigest.slice(0, 12)}` })), { folder, pattern: 'directions/**/*', kind: 'qa', label: 'Three rendered opening studies and comparison' }] };
        store.db.prepare('UPDATE business SET record=? WHERE id=?').run(JSON.stringify(record), businessId);
      }
    } else store.db.prepare('INSERT INTO business(id,record,imported_at,site_digest) VALUES(?,?,?,?)').run(businessId, JSON.stringify(record), now(), hash(hashes));
    store.db.exec('COMMIT');
  } catch (e) { if (store.db.isTransaction) store.db.exec('ROLLBACK'); throw e; }
  store.updateJob(job.id, { outputs: { ...job.outputs, curatedBusinessId: businessId, handoffRoot: root } });
  store.event(job.id, 'library.promoted', existing ? 'New version references appended; previous curated decisions, preview and files preserved' : 'Safe private review dossier added to the shared curated library; no acceptance was recorded');
  return { id: businessId, root, record, index: await refreshIndex(store, businessId) };
}
