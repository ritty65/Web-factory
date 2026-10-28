import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { fail, id, safeRelative, hash, now, publicUrl } from './contracts.mjs';
import { noLinks } from './db.mjs';
import { runProcess } from './process.mjs';
import { treeHashes } from './proposal.mjs';
import { policyIdentity, inspectionIdentity } from './policy.mjs';
import { SALES_OPERATIONS, salesDispatch } from './sales.mjs';
import { PILOT_OPERATIONS, pilotDispatch } from './pilot.mjs';
import { operationList } from './pilot.mjs';
import { RECOVERY_OPERATIONS, recoveryDispatch } from './recovery.mjs';
import { BATCH_OPERATIONS, batchDispatch, batchPreset } from './batches.mjs';
import { batchForCampaign } from './batch-store.mjs';
import { SEED_OPERATIONS, seedDispatch } from './seeds.mjs';
import { BOUNDARY_OPERATIONS, boundaryDispatch, boundaryStatus, requireBoundary } from './boundaries.mjs';
import { CAMOFOX_OPERATIONS, camofoxStatus } from './camofox.mjs';
import { ASSISTED_OPERATIONS, assistedDispatch } from './assisted.mjs';
import { STUDY_CONTINUATION_OPERATIONS, studyContinuation } from './study-continuation.mjs';
import { DESIGN_OPERATIONS, designDispatch } from './assisted-redesign.mjs';
import { DEFAULT_FACTORY_MODEL } from './model.mjs';
import { instagramResource } from './post-evidence.mjs';
import { LEAD_WORKSPACE_OPERATIONS, leadWorkspaceDispatch } from './lead-workspace.mjs';
import { INTAKE_OPERATIONS, intakeDispatch } from './studio-intake.mjs';
import { STUDIO_SETUP_OPERATIONS, setupDispatch, settingsRecord } from './studio-config.mjs';
import { STUDIO_BASELINE_OPERATIONS, baselineDispatch } from './studio-baseline.mjs';
import { STUDIO_REVIEW_OPERATIONS, recordStudioReview, latestStudioReview } from './studio-review.mjs';
import { STUDIO_AUTOPILOT_OPERATIONS, autopilotDispatch } from './studio-autopilot.mjs';

const key = z.string().regex(/^[a-z0-9][a-z0-9-]{1,95}$/);
const empty = z.object({}).strict();
const keyed = z.object({ id: key }).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const feedback = z.string().trim().min(8).max(3000).refine(s => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s));
const operation = (description, schema, readOnly = true) => ({ description, schema, readOnly });
export const OPERATIONS = {
  ...STUDIO_SETUP_OPERATIONS,
  ...STUDIO_BASELINE_OPERATIONS,
  ...STUDIO_REVIEW_OPERATIONS,
  ...STUDIO_AUTOPILOT_OPERATIONS,
  ...LEAD_WORKSPACE_OPERATIONS,
  ...INTAKE_OPERATIONS,
  ...SALES_OPERATIONS,
  ...PILOT_OPERATIONS,
  ...RECOVERY_OPERATIONS,
  ...BATCH_OPERATIONS,
  ...SEED_OPERATIONS,
  ...BOUNDARY_OPERATIONS,
  ...CAMOFOX_OPERATIONS,
  ...ASSISTED_OPERATIONS,
  ...STUDY_CONTINUATION_OPERATIONS,
  ...DESIGN_OPERATIONS,
  status: operation('Read the real Factory campaigns, jobs, candidates, curated businesses, references and integration observations. No commercial acceptance is inferred.', empty),
  inspection_identity: operation('Read startup-observed versus current-disk production/QA policy identities and restart requirement. Filesystem observations, not loaded-byte attestation, live verification, run authority or acceptance. No store access or work launch.', empty),
  doctor: operation('Check current local runtime prerequisites without exposing credentials or launching a model.', empty),
  job_get: operation('Read one job, its persisted event history and exact artifact references.', keyed),
  candidate_get: operation('Read one researched candidate with facts, sources and separate qualification/review/rights/contact states.', keyed),
  candidate_recheck: operation('Queue ONE idempotent bounded public follow-up for a held candidate, retaining prior research. Not permission to fabricate qualification or start another cohort.', keyed, false),
  candidate_evidence_import: operation('Update an exact existing candidate from supplied research, preserving prior evidence digests. This is labelled external evidence, not a native live connector success. Cannot rename the business, claim acceptance, licence, payment or publication.', z.object({ id: key, evidence: z.record(z.string(), z.unknown()) }).strict(), false),
  library_promote: operation('Add one exact review-ready proposal to the existing curated library and export its sanitized dossier. Never overwrites existing feedback, never accepts or publishes. Original customer work is preserved.', keyed, false),
  qa_run: operation('Queue a fresh read-only-site QA run under the current QA policy. Does not regenerate or edit site bytes. Passing evidence gets a new exact review ZIP; prior evidence/packages remain. Still no human acceptance.', keyed, false),
  review_note: operation('Append exact-digest supplied feedback, not an authenticated human verdict. Cannot accept, publish or change site bytes. Identical notes are idempotent.', z.object({ id: key, siteDigest: digest, note: feedback }).strict(), false),
  direction_repair: operation('Explicitly spend the existing single creative-repair budget on a held exact direction selection, then freshly render/select before the five-page build. Same job/deadline; no new revision allowance, acceptance or overwrite of old studies.', z.object({ id: key, selectionDigest: digest }).strict(), false),
  polish_site: operation('ONLY after explicit additional task-budget authorization: one extra focused polish of an exact technically passing but visually held site. One additional polish job per business, no retries/repair loop, no acceptance or publication. Old version and ordinary revision caps remain.', z.object({ id: key, siteDigest: digest, feedback }).strict(), false),
  revise_site: operation('Explicitly request one new isolated private proposal for the same business and exact parent. Two requested revisions maximum per candidate across all history; no automatic whole-job retry. Optional reuseStudyJobId reuses only a held study gate with unchanged parent/evidence/feedback; all studies are freshly validated/rendered. No acceptance.', z.object({ id: key, siteDigest: digest, feedback, reuseStudyJobId: key.optional() }).strict(), false),
  source_inspect: operation('Queue one bounded fresh guest public-source inspection for the external OpenCode researcher. Returns actual source/image IDs via job_get; no credentials, private requests or arbitrary shell. A maximum of 24 source jobs per campaign. Optional Instagram post-format diagnostics remain private and are not attribution evidence.', z.object({ campaignId: key, url: z.string().url().max(1200), relatedUrls: z.array(z.string().url().max(1200)).max(3).default([]), postFormatDiagnostics: z.boolean().optional() }).strict(), false),
  campaign_create: operation('Create an idempotent bounded PRIVATE campaign. No outreach, publication or deployment.', z.object({ name: z.string().min(1).max(100), query: z.string().min(1).max(300), area: z.string().min(1).max(100), niche: z.string().min(1).max(100), candidateLimit: z.number().int().min(1).max(100).optional(), buildLimit: z.number().int().min(1).max(10).optional(), concurrency: z.number().int().min(1).max(2).optional(), retryLimit: z.number().int().min(0).max(1).optional(), deadlineMinutes: z.number().int().min(2).max(60).optional(), autoBuild: z.boolean().optional(), model: z.string().max(150).optional() }).strict(), false),
  discover: operation('Queue real public research for one campaign, with its candidate/deadline caps. Missing evidence holds; an existing official site excludes.', z.object({ campaignId: key }).strict(), false),
  candidates_import: operation('Import supplied research as operator-imported evidence, never as a live connector result. Invalid/unknown checks cannot qualify.', z.object({ campaignId: key, candidates: z.array(z.record(z.string(), z.unknown())).min(1).max(100) }).strict(), false),
  build_site: operation('Queue an isolated private static PROPOSAL for a qualified candidate. Uses source-backed imagery and bounded QA; never accepts or publishes.', z.object({ candidateId: key }).strict(), false),
  job_cancel: operation('Cancel one queued/running job and its owned worker work. Does not delete artifacts or history.', keyed, false),
  job_retry: operation('Queue a bounded retry of one blocked/failed/cancelled job, preserving prior attempts.', keyed, false),
  reference_audit: operation('Queue a guest-browser inspection of one of the operator-selected reference sites. No arbitrary host commands.', z.object({ referenceId: key }).strict(), false),
  vault_check: operation('Queue a read-only live Vault availability/authentication check. No credential search or login and no upload/publication.', empty, false),
  vault_import: operation('Import a sanitized operator-provided preview list; records retain imported status and cannot claim authenticated live synchronization.', z.object({ previews: z.array(z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/), name: z.string().min(1).max(150), url: z.string().url().max(300), status: z.enum(['draft', 'published', 'unknown']).default('unknown') }).strict()).max(100) }).strict(), false),
};

export function configFromEnv() { return { ...(process.env.FACTORY_DB ? { dbPath: process.env.FACTORY_DB } : {}), ...(process.env.FACTORY_STATE ? { stateRoot: process.env.FACTORY_STATE } : {}), autoRun: process.env.FACTORY_AUTORUN !== '0' }; }
export function createService(store, { autoRun = true, batchPrerequisites, boundaryPreflight = requireBoundary, seedCollector = async options => (await import('./seed-source.mjs')).collectSeeds(options), boundaryPreparer, leadRequest, intakeRuntime, studioRequest, studioReaders } = {}) {
  const prerequisites = batchPrerequisites || (async settings => {
    const runtime = await doctor(store);
    const required = ['opencode', 'browser', 'python', 'sharp', 'playwright', '@axe-core/playwright'];
    const available = required.every(name => runtime.checks.some(c => c.name === name && c.status.startsWith('available')));
    const sourceAvailable = settings.searchProvider !== 'firecrawl' || Boolean(process.env.FIRECRAWL_API_KEY);
    return { ready: available && sourceAvailable, checks: runtime.checks, selectedSource: settings.searchProvider,
      model: DEFAULT_FACTORY_MODEL, modelStatus: 'explicit_route_not_live_verified',
      sourceStatus: sourceAvailable ? 'available_for_bounded_attempt_not_live_verified' : 'needs_configuration', liveVerified: false,
      limitations: ['Local configuration only, not a model sign-in or business discovery test', 'Usage limits are attempts, not a dollar cap', 'Public source terms/access restrictions still apply'] };
  });
  async function exactReview(input) {
    const parent = store.job(input.id);
    if (parent.kind !== 'site' || parent.state !== 'review_ready' || !parent.outputs.siteRelative || !parent.outputs.siteDigest || parent.outputs.reviewStatus !== 'operator_review_required') fail('REVIEW_REQUIRED', 'Choose an exact review-ready private site, not running work or a research job');
    if (parent.outputs.siteDigest !== input.siteDigest) fail('STALE_REVIEW', 'The feedback digest does not match this site version');
    if (hash(await treeHashes(path.join(store.stateRoot, safeRelative(parent.outputs.siteRelative)))) !== input.siteDigest) fail('STALE_PROPOSAL', 'The staged site no longer matches its exact review digest');
    return parent;
  }
  function kick() {
    if (!autoRun) return;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'work'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, FACTORY_DB: store.dbPath, FACTORY_STATE: store.stateRoot }, shell: false, detached: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref();
  }
  const service = {
    store,
    wakeOwnedWork() {
      const lease=store.db.prepare("SELECT value FROM factory_meta WHERE key='worker'").get()?.value;
      if(lease&&/^\d+$/.test(lease)){try{process.kill(Number(lease),0);return;}catch(e){if(e.code!=='ESRCH')return;}}
      const pending = store.db.prepare("SELECT 1 FROM factory_job WHERE state IN ('queued','running') LIMIT 1").get();
      const activeBatch = !settingsRecord(store)&&store.db.prepare("SELECT name FROM sqlite_master WHERE name='factory_operation'").get() && store.db.prepare("SELECT 1 FROM factory_operation WHERE kind='batch' AND json_extract(record,'$.state')='active' LIMIT 1").get();
      if (pending || activeBatch) kick();
    },
    async dispatch(name, raw = {}) {
      const op = OPERATIONS[name]; if (!op) fail('UNKNOWN_OPERATION', 'Unknown or unsupported operation');
      const parsed = op.schema.safeParse(raw); if (!parsed.success) fail('INVALID_INPUT', 'Unsupported or unexpected input fields or values', { fields: parsed.error.issues.map(i => i.path.join('.')).slice(0, 10) });
      const input = parsed.data;
      if(name==='leads_schedule_save'&&input.enabled&&settingsRecord(store))fail('STUDIO_METERED_WORKFLOW','Use the Automatic drafts timer with the shared API allowance; legacy scheduling remains disabled');
      if(['leads_discover','leads_research','leads_schedule_tick','discover','source_inspect','candidate_recheck','build_site','research_probe','assisted_build','batch_start','batch_continue','batch_build_selected','batch_recover_launch','direction_repair','polish_site','revise_site'].includes(name)&&settingsRecord(store))fail('STUDIO_METERED_WORKFLOW','This workspace uses the shared API allowance. Use Setup, Automatic drafts or a new Business intake version; legacy paid routes are held.');
      if (STUDIO_SETUP_OPERATIONS[name]) return setupDispatch(store,name,input,{...(studioRequest?{request:studioRequest}:{})});
      if (STUDIO_BASELINE_OPERATIONS[name]) return baselineDispatch(store,name,input);
      if (STUDIO_REVIEW_OPERATIONS[name]) return recordStudioReview(store,input);
      if (STUDIO_AUTOPILOT_OPERATIONS[name]) {const result=await autopilotDispatch(store,name,input,{...(studioRequest?{request:studioRequest}:{}),...(studioReaders?{readers:studioReaders}:{})});if(result.queued)kick();return result;}
      if (LEAD_WORKSPACE_OPERATIONS[name]) return leadWorkspaceDispatch(store,name,input,{...(leadRequest?{request:leadRequest}:{})});
      if (INTAKE_OPERATIONS[name]) { const result=await intakeDispatch(store,name,input,{...(intakeRuntime?{runtime:intakeRuntime}:{})}); if(name==='intake_build')kick();return result; }
      if (SALES_OPERATIONS[name]) return salesDispatch(store, name, input);
      if (PILOT_OPERATIONS[name]) { const result = await pilotDispatch(store, name, input); if (name === 'research_probe') kick(); return result; }
      if (RECOVERY_OPERATIONS[name]) return recoveryDispatch(store, name, input);
      if (CAMOFOX_OPERATIONS[name]) return camofoxStatus(input);
      if (ASSISTED_OPERATIONS[name]) { const result=await assistedDispatch(store,name,input,{prerequisites});if(name==='assisted_build')kick();return result; }
      if(STUDY_CONTINUATION_OPERATIONS[name]){const result=await studyContinuation(store,input);kick();return result;}
      if(DESIGN_OPERATIONS[name]){const result=await designDispatch(store,name,input);if(name==='assisted_redesign'||name==='assisted_polish')kick();return result;}
      if (BOUNDARY_OPERATIONS[name]) return boundaryDispatch(store, name, input, { ...(boundaryPreparer ? { prepareBoundary: boundaryPreparer } : {}) });
      if (SEED_OPERATIONS[name]) return seedDispatch(store, name, input, { collectSeeds: seedCollector, preset: batchPreset(store), boundaryPreflight });
       if (BATCH_OPERATIONS[name]) { const result = await batchDispatch(store, name, input, { prerequisites: async settings => ({ ...(await prerequisites(settings)), boundary: boundaryStatus(store) }) }); if (['batch_start', 'batch_continue', 'batch_build_selected','batch_recover_launch'].includes(name)) kick(); return result; }
      switch (name) {
        case 'inspection_identity': return inspectionIdentity();
        case 'status': { const s = service.snapshot(); return { at: s.at, scope: s.scope, counts: { businesses: s.businesses.length, campaigns: s.campaigns.length, jobs: s.jobs.length, candidates: s.candidates.length, photos: new Set([...s.libraryFiles.filter(f => f.kind === 'photo'), ...s.assets].map(f => f.sha256)).size, indexedLibraryFiles: s.indexedFileCount }, authority: s.authority, campaigns: s.campaigns.map(({ id, name, candidateLimit, buildLimit, autoBuild }) => ({ id, name, candidateLimit, buildLimit, autoBuild })), businesses: s.businesses.map(({ id, name, design_status }) => ({ id, name, designStatus: design_status })), candidates: s.candidates.map(({ id, name, assessment, origin }) => ({ id, name, assessment, origin })), jobs: s.jobs.slice(0, 30).map(({ id, kind, state, stage, message, attempt }) => ({ id, kind, state, stage, message, attempt })), references: s.references.map(({ id, name, status }) => ({ id, name, status })), vault: s.vault.map(({ id, name, status, inventorySynced, liveVerified }) => ({ id, name, status, inventorySynced, liveVerified })) }; }
        case 'doctor': return doctor(store);
        case 'job_get': {
          const record = job => ({ job, ...(job.input.apiConcept||job.input.modelSelection?.startsWith('api/')?{operatorReview:latestStudioReview(store,job)}:{}), events: store.events(job.id), artifacts: [...store.artifacts(job.id), ...(job.outputs.verificationJobId ? store.artifacts(job.outputs.verificationJobId) : [])] });
          const job = store.job(input.id); return { ...record(job), comparison: job.input.parentSiteJobId ? record(store.job(job.input.parentSiteJobId)) : null };
        }
        case 'candidate_get': return { candidate: store.candidate(input.id), jobs: store.jobs().filter(j => j.input.candidateId === input.id) };
        case 'candidate_recheck': { const candidate = store.candidate(input.id); if (candidate.assessment.state !== 'blocked') fail('RECHECK', 'Only a held candidate can use the bounded follow-up'); const job = store.createJob({ campaignId: candidate.campaignId, kind: 'discovery', input: { recheckCandidateId: candidate.id } }); kick(); return job; }
        case 'candidate_evidence_import': { const c = store.candidate(input.id); for (const key of input.evidence.observationJobIds || []) { const job = store.job(key); if (job.campaignId !== c.campaignId || !['discovery', 'source'].includes(job.kind)) fail('SOURCE_BINDING', 'Observation jobs must belong to this campaign'); } return store.replaceCandidate(input.id, input.evidence, 'external_evidence_import'); }
        case 'library_promote': { if(store.job(input.id).input.ownerIntake||store.job(input.id).input.apiConcept)fail('INTAKE_WORKFLOW','Use the exact supplied-concept review ZIP. Legacy library promotion requires a separately qualified research candidate.'); const { promoteReview } = await import('./promotion.mjs'); return promoteReview(store, input.id); }
        case 'review_note': { await exactReview(input); return store.reviewNote(input.id, input.siteDigest, input.note); }
        case 'polish_site': {
          const parent = store.job(input.id);
          if (parent.kind !== 'site' || parent.state !== 'blocked' || parent.outputs.qaPass !== true || parent.outputs.reviewStatus !== 'creative_rework_required' || !parent.outputs.siteRelative) fail('POLISH_INPUT', 'Additional polish requires an exact technically passing, visually held private proposal');
          if (parent.outputs.siteDigest !== input.siteDigest) fail('STALE_REVIEW', 'Polish feedback does not identify this exact held site');
          if (hash(await treeHashes(path.join(store.stateRoot, safeRelative(parent.outputs.siteRelative)))) !== input.siteDigest) fail('STALE_PROPOSAL', 'The held proposal changed outside its review record');
          const batch = batchForCampaign(store, parent.campaignId);
          const job = store.createJob({ campaignId: parent.campaignId, kind: 'site', input: { candidateId: parent.input.candidateId, parentSiteJobId: parent.id, parentSiteDigest: input.siteDigest, polishOf: parent.id, feedback: input.feedback, craftVersion: 2, ...(batch?.assistedIntake ? { assistedIntake: batch.assistedIntake } : {}) } }); kick(); return job;
        }
        case 'direction_repair': {
          const job = store.job(input.id);
          if (job.directionRepair) fail('DIRECTION_REPAIR_LIMIT', 'This job already spent its creative-repair budget on direction correction');
          if (job.kind !== 'site' || job.state !== 'blocked' || job.errorCode !== 'DESIGN_SELECTION') fail('DIRECTION_REPAIR_INPUT', 'Choose a held exact direction-selection job');
          const selection = store.artifacts(job.id).find(a => a.kind === 'selection' && a.relative === `jobs/${job.id}/attempt-${job.attempt}/direction-selection.json`);
          if (!selection || selection.sha256 !== input.selectionDigest) fail('STALE_REVIEW', 'The direction repair must identify its exact recorded selection');
          await service.artifact(selection.id);
          const { readDirectionSeed } = await import('./craft.mjs'); await readDirectionSeed({ store, job, selectionDigest: input.selectionDigest, candidate: store.candidate(job.input.candidateId) });
          const result = store.requestDirectionRepair(job.id, input.selectionDigest); kick(); return result;
        }
        case 'revise_site': {
          const parent = await exactReview(input);
          if(parent.input.ownerIntake||parent.input.apiConcept)fail('INTAKE_WORKFLOW','Edit and save a new supplied brief version in Business intake, then explicitly build it. The prior proposal stays unchanged.');
          const c = store.candidate(parent.input.candidateId);
          if (c.assessment.state !== 'qualified') fail('QUALIFICATION', 'Current evidence must still qualify before a revision');
          if (input.reuseStudyJobId) { const { readCreativeSeed } = await import('./craft.mjs'); await readCreativeSeed({ store, sourceJobId: input.reuseStudyJobId, parent, feedback: input.feedback, candidate: c }); }
          const job = store.createJob({ campaignId: parent.campaignId, kind: 'site', input: { candidateId: c.id, parentSiteJobId: parent.id, parentSiteDigest: input.siteDigest, feedback: input.feedback, craftVersion: 2, ...(input.reuseStudyJobId ? { reuseStudyJobId: input.reuseStudyJobId } : {}) } }); kick(); return job;
        }
        case 'qa_run': {
          const parent = store.job(input.id); if (parent.kind !== 'site' || !parent.outputs.siteRelative || parent.state === 'running') fail('QA_INPUT', 'Choose a stopped/finished site proposal with staged bytes');
          if(parent.input.ownerIntake||parent.input.apiConcept)fail('INTAKE_WORKFLOW','This supplied proposal has its own exact QA package. Edit the brief and build a new version for changes; legacy lead QA is a separate workflow.');
          let siteDigest = parent.outputs.siteDigest;
          if (!siteDigest) {
            if (!parent.outputs.qaRelative) fail('QA_INPUT', 'A frozen proposal/QA report is required before a read-only recheck');
            const target = path.join(store.stateRoot, safeRelative(parent.outputs.qaRelative), 'results.json'); await noLinks(target);
            const prior = JSON.parse(await readFile(target, 'utf8')); if (!prior.siteHashes) fail('STALE_QA', 'Original QA has no frozen site hashes'); siteDigest = hash(prior.siteHashes);
          }
          if (hash(await treeHashes(path.join(store.stateRoot, safeRelative(parent.outputs.siteRelative)))) !== siteDigest) fail('STALE_PROPOSAL', 'Read-only rechecking cannot silently adopt changed site bytes');
          const policyDigest = (await policyIdentity('qa')).digest; const job = store.createJob({ campaignId: parent.campaignId, kind: 'qa', input: { siteJobId: parent.id, siteDigest, policyDigest } }); kick(); return job;
        }
        case 'source_inspect': { store.campaign(input.campaignId); publicUrl(input.url); for (const url of input.relatedUrls) publicUrl(url); if(input.postFormatDiagnostics&&!instagramResource(input.url,'post'))fail('SOURCE_DIAGNOSTIC','Private format diagnostics require a supported Instagram post URL.'); const job = store.createJob({ campaignId: input.campaignId, kind: 'source', input: { url: input.url, relatedUrls: input.relatedUrls, ...(input.postFormatDiagnostics?{postFormatDiagnostics:true}:{}) } }); kick(); return job; }
        case 'campaign_create': return store.createCampaign(input);
        case 'discover': { const job = store.createJob({ campaignId: input.campaignId, kind: 'discovery' }); kick(); return job; }
        case 'candidates_import': return { candidates: store.importCandidates(input.campaignId, input.candidates) };
        case 'build_site': { const c = store.candidate(input.candidateId); if (c.assessment.state !== 'qualified') fail('QUALIFICATION', 'Candidate is not qualified for a private proposal'); const job = store.createJob({ campaignId: c.campaignId, kind: 'site', input }); kick(); return job; }
        case 'job_cancel': return store.cancel(input.id);
        case 'job_retry': { const job = store.retry(input.id); kick(); return job; }
        case 'reference_audit': { const { REFERENCE_SEEDS } = await import('./references.mjs'); if (!REFERENCE_SEEDS.some(v => v.id === input.referenceId)) fail('REFERENCE', 'Only the operator-selected references can be audited'); const job = store.createJob({ kind: 'reference', input }); kick(); return job; }
        case 'vault_check': { const job = store.createJob({ kind: 'vault' }); kick(); return job; }
        case 'vault_import': { for (const v of input.previews) { const url = new URL(v.url); if (url.origin !== 'https://simulacraproductions.net' || url.pathname !== `/p/${v.slug}` || url.search || url.hash) fail('VAULT_URL', 'Only sanitized canonical Vault preview links are allowed'); } return { previews: input.previews.map(v => store.saveVault({ id: `preview-${v.slug}`, ...v, origin: 'operator_import', observedAt: now(), liveVerified: false })) }; }
      }
    },
    snapshot() {
      const pilotAvailable=store.db.prepare("SELECT value FROM factory_meta WHERE key='pilot_schema'").get()?.value==='1';
      return { at: now(), scope: 'local_private_proposals', pilotAvailable, pilotHandoffs:pilotAvailable?operationList(store,'handoff'):[], businesses: store.businesses(), campaigns: store.campaigns(), jobs: store.jobs(), candidates: store.candidates(), references: store.references(), assets: store.allArtifacts().filter(v => v.kind === 'photo'), siteCaptures: store.allArtifacts().filter(v => v.kind === 'site_capture'), libraryFiles: store.libraryFiles().filter(v => ['photo', 'package'].includes(v.kind)), indexedFileCount: store.libraryFiles().length, vault: store.vault(), pendingHumanReview: store.jobs().filter(j => j.kind === 'site' && j.state === 'review_ready').length, authority: { acceptance: 'human_only', outreach: 'not_authorized', deployment: 'not_authorized', publicImageRights: 'unconfirmed' } };
    },
    async artifact(key) {
      const artifact = store.getArtifact(key); safeRelative(artifact.relative);
      const target = path.join(store.stateRoot, artifact.relative); await noLinks(target);
      const info = await stat(target); if (!info.isFile() || info.size > 64 * 1024 * 1024 || info.size !== artifact.bytes) fail('STALE_ARTIFACT', 'Artifact size changed; refresh its evidence before delivery');
      const bytes = await readFile(target); if (hash(bytes) !== artifact.sha256) fail('STALE_ARTIFACT', 'Artifact bytes changed; stale evidence cannot be delivered');
      return { artifact, bytes };
    },
    async libraryArtifact(key) {
      const file = store.libraryFiles().find(v => v.id === key); if (!file) fail('NOT_FOUND', 'Indexed library file not found');
      const allowed = ['/home/ai_dev/04_DELIVERABLES/simulacra-pilot-20261021/cakemake', '/home/ai_dev/04_DELIVERABLES/simulacra-pilot-20261021/h-details', '/home/ai_dev/04_DELIVERABLES/simulacra-quality-reset-20261020/cream-burger-concept'];
      const factoryRoot = /^\/home\/ai_dev\/04_DELIVERABLES\/simulacra-factory-20261021\/businesses\/lead-[a-f0-9]{20}\/[a-f0-9]{12}$/.test(file.root);
      if ((!allowed.includes(file.root) && !factoryRoot) || !['photo', 'package'].includes(file.kind)) fail('NOT_FOUND', 'This indexed file is not exposed by the Factory console');
      const target = path.join(file.root, safeRelative(file.relative_path)); await noLinks(target);
      const info = await stat(target); if (!info.isFile() || info.size !== file.bytes || info.size > 64 * 1024 * 1024) fail('STALE_ARTIFACT', 'Indexed library file changed; refresh the library before delivery');
      const bytes = await readFile(target); if (hash(bytes) !== file.sha256) fail('STALE_ARTIFACT', 'Indexed library bytes changed; stale references cannot be delivered');
      return { artifact: { ...file, relative: file.relative_path }, bytes };
    },
  };
  return service;
}
async function doctor(store) {
  const checks = [];
  for (const [name, executable, args] of [['opencode', 'opencode', ['--version']], ['browser', 'agent-browser', ['--version']], ['python', 'python3', ['--version']]]) {
    try { const r = await runProcess(executable, args, { timeout: 15000, maxBytes: 4096 }); checks.push({ name, status: 'available', version: r.stdout.trim().slice(0, 150) }); } catch { checks.push({ name, status: 'unavailable' }); }
  }
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  for (const name of ['sharp', 'playwright', '@axe-core/playwright']) { try { require.resolve(name); checks.push({ name, status: 'available_project_dependency' }); } catch { checks.push({ name, status: 'unavailable' }); } }
  checks.push({ name: 'firecrawl', status: process.env.FIRECRAWL_API_KEY ? 'configured_not_live_verified' : 'needs_configuration', optional: true });
  checks.push({ name: 'preview_vault', status: store.vault().find(v => v.id === 'connection')?.status || 'not_checked', inventory: store.vault().filter(v => v.origin === 'operator_import').length });
  return { at: now(), node: process.version, checks, mode: 'private_review_candidates', limitations: ['No automatic human visual acceptance', 'No outreach/publication/production deployment tools', 'Public social access can require a hold', 'Other local OS accounts are outside this loopback app threat model'] };
}
