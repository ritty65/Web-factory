// Node's supported SQLite backup API: https://nodejs.org/docs/latest-v24.x/api/sqlite.html
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, lstat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { campaignInput, candidateInput, candidateKey, fail, hash, id, now, workRelative } from './contracts.mjs';
import { batchForCampaign, existingEntity, guardBatchJob } from './batch-store.mjs';
import { assertAssistedRevision } from './assisted-evidence.mjs';

export const DEFAULT_STATE = fileURLToPath(new URL('../.factory-state', import.meta.url));
export const DEFAULT_DB = path.join(DEFAULT_STATE, 'factory.sqlite3');
export async function noLinks(target) {
  let p = path.resolve(target);
  for (;;) {
    try { if ((await lstat(p)).isSymbolicLink()) fail('SYMLINK', 'Symbolic-link paths are not allowed'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(p); if (parent === p) break; p = parent;
  }
}
export async function initialize({ dbPath = DEFAULT_DB, stateRoot = DEFAULT_STATE } = {}) {
  await noLinks(dbPath); await noLinks(stateRoot);
  await mkdir(path.join(stateRoot, 'backups'), { recursive: true, mode: 0o750 });
  await mkdir(path.dirname(dbPath), { recursive: true, mode: 0o750 });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;');
    const existed = db.prepare("SELECT name FROM sqlite_master WHERE name='factory_meta'").get();
    if (existed && db.prepare("SELECT value FROM factory_meta WHERE key='schema'").get()?.value !== '1') fail('SCHEMA', 'Unsupported Factory schema; no migration writes were made');
    const pilot = existed && db.prepare("SELECT value FROM factory_meta WHERE key='pilot_schema'").get();
    if (pilot && pilot.value !== '1') fail('PILOT_SCHEMA', 'Unsupported pilot extension; no migration writes were made');
    if (!existed || !pilot) await backup(db, path.join(stateRoot, 'backups', `library-before-${existed ? 'pilot' : 'factory'}-${Date.now()}.sqlite3`));
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS factory_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_campaign (id TEXT PRIMARY KEY,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_job (id TEXT PRIMARY KEY,campaign_id TEXT REFERENCES factory_campaign(id),state TEXT NOT NULL,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_event (seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES factory_job(id),record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_candidate (id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES factory_campaign(id),record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_artifact (id TEXT PRIMARY KEY,job_id TEXT,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_reference (id TEXT PRIMARY KEY,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_vault (id TEXT PRIMARY KEY,record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS factory_job_state ON factory_job(state);
      CREATE INDEX IF NOT EXISTS factory_event_job ON factory_event(job_id);
      INSERT OR IGNORE INTO factory_meta VALUES('schema','1');
      CREATE TABLE IF NOT EXISTS factory_sales_case (id TEXT PRIMARY KEY,candidate_id TEXT UNIQUE NOT NULL REFERENCES factory_candidate(id),record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_sales_event (id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES factory_sales_case(id),record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_cost (id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES factory_campaign(id),case_id TEXT REFERENCES factory_sales_case(id),record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS factory_money (id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES factory_sales_case(id),record TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS factory_money_reference ON factory_money(case_id,json_extract(record,'$.kind'),json_extract(record,'$.reference'));
      CREATE INDEX IF NOT EXISTS factory_sales_events_case ON factory_sales_event(case_id);
      CREATE INDEX IF NOT EXISTS factory_cost_campaign ON factory_cost(campaign_id);
      CREATE TABLE IF NOT EXISTS factory_operation (id TEXT PRIMARY KEY,kind TEXT NOT NULL,record TEXT NOT NULL);
      INSERT OR IGNORE INTO factory_meta VALUES('pilot_schema','1');
      COMMIT;
    `);
    if (db.prepare("SELECT value FROM factory_meta WHERE key='schema'").get().value !== '1') fail('SCHEMA', 'Unsupported Factory schema');
  } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; } finally { db.close(); }
  return { dbPath, stateRoot };
}
export function openStore({ dbPath = DEFAULT_DB, stateRoot = DEFAULT_STATE } = {}) {
  if (!existsSync(dbPath)) fail('NOT_INITIALIZED', 'Run factory init before opening the service');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;');
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='factory_meta'").get()) { db.close(); fail('NOT_INITIALIZED', 'Run factory init to add the backed-up Factory schema'); }
  if (db.prepare("SELECT value FROM factory_meta WHERE key='schema'").get()?.value !== '1') { db.close(); fail('SCHEMA', 'Unsupported Factory schema; service was not opened'); }
  const pilot = db.prepare("SELECT value FROM factory_meta WHERE key='pilot_schema'").get();
  if (pilot && pilot.value !== '1') { db.close(); fail('PILOT_SCHEMA', 'Unsupported pilot extension; service was not opened'); }
  const parse = row => row ? JSON.parse(row.record) : null;
  const collection = table => db.prepare(`SELECT record FROM ${table} ORDER BY rowid DESC LIMIT 300`).all().map(parse);
  const store = {
    db, dbPath, stateRoot, close: () => db.close(),
    businesses() { return db.prepare("SELECT name FROM sqlite_master WHERE name='business'").get() ? db.prepare('SELECT record FROM business ORDER BY id').all().map(parse) : []; },
    libraryFiles() { return db.prepare("SELECT name FROM sqlite_master WHERE name='file'").get() ? db.prepare('SELECT record FROM file ORDER BY id LIMIT 3000').all().map(parse) : []; },
    allArtifacts() { return collection('factory_artifact'); },
    backups() { return existsSync(path.join(stateRoot, 'backups')) ? [path.join(stateRoot, 'backups')] : []; },
    campaigns: () => collection('factory_campaign'), jobs: () => collection('factory_job'), candidates: () => collection('factory_candidate'), references: () => collection('factory_reference'), vault: () => collection('factory_vault'),
    queuedJobs() { return db.prepare("SELECT record FROM factory_job WHERE state='queued' ORDER BY rowid LIMIT 100").all().map(parse); },
    campaign(key) { const result = parse(db.prepare('SELECT record FROM factory_campaign WHERE id=?').get(id(key))); if (!result) fail('NOT_FOUND', 'Campaign not found'); return result; },
    job(key) { const result = parse(db.prepare('SELECT record FROM factory_job WHERE id=?').get(id(key))); if (!result) fail('NOT_FOUND', 'Job not found'); return result; },
    candidate(key) { const result = parse(db.prepare('SELECT record FROM factory_candidate WHERE id=?').get(id(key))); if (!result) fail('NOT_FOUND', 'Candidate not found'); return result; },
    existingEntity(candidate) { return existingEntity(store,candidate); },
    event(jobId, type, message, detail = {}) { const record = { type, message, detail, at: now() }; db.prepare('INSERT INTO factory_event(job_id,record) VALUES(?,?)').run(jobId, JSON.stringify(record)); return record; },
    events(key) { return db.prepare('SELECT seq,record FROM factory_event WHERE job_id=? ORDER BY seq DESC LIMIT 100').all(id(key)).map(r => ({ seq: r.seq, ...parse(r) })).reverse(); },
    createCampaign(input) { const data = campaignInput(input), key = `camp-${hash(data).slice(0, 16)}`; const record = { id: key, ...data, createdAt: now() }; db.prepare('INSERT OR IGNORE INTO factory_campaign VALUES(?,?)').run(key, JSON.stringify(record)); return store.campaign(key); },
    createJob({ campaignId = null, kind, input = {} }) {
      if (!['discovery', 'site', 'reference', 'vault', 'source', 'qa', 'probe'].includes(kind)) fail('INVALID_JOB', 'Unknown job kind');
      const campaign = campaignId ? store.campaign(campaignId) : null;
      const key = `job-${hash({ campaignId, kind, input }).slice(0, 20)}`;
      const ownTransaction = !db.isTransaction;
      if (ownTransaction) db.exec('BEGIN IMMEDIATE');
      try {
        const existing = parse(db.prepare('SELECT record FROM factory_job WHERE id=?').get(key));
        if (existing) { if (ownTransaction) db.exec('COMMIT'); return existing; }
        guardBatchJob(store, { campaignId, kind, input });
        const revision = kind === 'site' && Boolean(input.parentSiteJobId);
        const polish = revision && Boolean(input.polishOf);
        const used = campaign ? db.prepare("SELECT count(*) n FROM factory_job WHERE campaign_id=? AND json_extract(record,'$.kind')=? AND json_extract(record,'$.input.parentSiteJobId') IS NULL").get(campaignId, kind).n : 0;
        if (revision) {
          const parent = store.job(input.parentSiteJobId);
          const assistedBatch = input.assistedRevisionId ? batchForCampaign(store,campaignId) : null;
          let assistedReceipt;
          if(input.assistedRevisionId) {
            if(!assistedBatch?.assistedIntake)fail('BATCH_ASSISTED_BINDING','Only an exact host-receipted assisted revision may extend held-parent eligibility.');
            assistedReceipt=assertAssistedRevision(store,assistedBatch,{id:key,campaignId,kind,input});
          }
          const parentEligible = polish ? input.polishOf === parent.id && parent.state === 'blocked' && parent.outputs.qaPass === true && parent.outputs.reviewStatus === 'creative_rework_required' : parent.state === 'review_ready' || Boolean(input.assistedRevisionId) && parent.state === 'blocked' && parent.errorCode === 'DESIGN_REWORK' && parent.outputs.qaPass === true && parent.outputs.reviewStatus === 'creative_rework_required';
          if (!campaign || parent.kind !== 'site' || !parentEligible || parent.campaignId !== campaignId || parent.input.candidateId !== input.candidateId || (assistedReceipt ? assistedReceipt.parentSiteDigest : parent.outputs.siteDigest) !== input.parentSiteDigest) fail('REVISION_BINDING', 'A revision/polish must bind the same business, campaign and exact eligible parent');
          const count = db.prepare("SELECT count(*) n FROM factory_job WHERE json_extract(record,'$.kind')='site' AND json_extract(record,'$.input.candidateId')=? AND json_extract(record,'$.input.parentSiteJobId') IS NOT NULL AND json_extract(record,'$.input.polishOf') IS NULL").get(input.candidateId).n;
          if (polish) {
            if (db.prepare("SELECT count(*) n FROM factory_job WHERE json_extract(record,'$.input.candidateId')=? AND json_extract(record,'$.input.polishOf') IS NOT NULL").get(input.candidateId).n >= 1) fail('POLISH_CAP', 'The one explicitly additional polish job already exists, including stopped work; no automatic extra budget');
          } else if (count >= 2) fail('REVISION_CAP', 'Two requested revision jobs already exist for this candidate, including stopped jobs. Creative leadership must review before further work.');
        }
        if (campaign && kind === 'site' && !revision && used >= campaign.buildLimit) fail('BUILD_CAP', 'Campaign initial-build cap reached');
        if (campaign && ['source', 'probe'].includes(kind) && used >= 24) fail('SOURCE_CAP', 'Campaign source/probe inspection cap reached');
        const record = { id: key, campaignId, kind, input, state: 'queued', stage: kind === 'site' ? 'qualification' : kind, attempt: 0, retryLimit: revision ? 0 : campaign?.retryLimit ?? 1, createdAt: now(), updatedAt: now(), message: revision ? 'Explicit exact-version revision queued; parent preserved' : 'Queued', outputs: {}, ownerPid: null };
        db.prepare('INSERT INTO factory_job VALUES(?,?,?,?)').run(key, campaignId, record.state, JSON.stringify(record));
        store.event(key, 'job.created', 'Job queued'); if (ownTransaction) db.exec('COMMIT'); return record;
      } catch (e) { if (ownTransaction && db.isTransaction) db.exec('ROLLBACK'); throw e; }
    },
    updateJob(key, patch) { const previous = store.job(key); if (previous.state === 'cancelled' && patch.state && !['cancelled', 'queued'].includes(patch.state)) return previous; const job = { ...previous, ...patch, updatedAt: now() }; const result = db.prepare('UPDATE factory_job SET state=?,record=? WHERE id=? AND state=?').run(job.state, JSON.stringify(job), key, previous.state); return result.changes ? job : store.job(key); },
    reviewNote(jobId, siteDigest, note) {
      const noteId = hash({ jobId, siteDigest, note }); db.exec('BEGIN IMMEDIATE');
      try {
        const parent = store.job(jobId);
        if (parent.kind !== 'site' || parent.state !== 'review_ready' || parent.outputs.siteDigest !== siteDigest) fail('STALE_REVIEW', 'Feedback must identify the current exact review-ready site');
        const old = db.prepare("SELECT seq,record FROM factory_event WHERE job_id=? AND json_extract(record,'$.detail.noteId')=?").get(jobId, noteId);
        if (old) { db.exec('COMMIT'); return { seq: old.seq, ...parse(old) }; }
        if (db.prepare("SELECT count(*) n FROM factory_event WHERE job_id=? AND json_extract(record,'$.type')='review.note'").get(jobId).n >= 40) fail('FEEDBACK_CAP', 'This version already has 40 feedback notes; consolidate before requesting more work');
        const event = store.event(jobId, 'review.note', 'Exact-version supplied feedback recorded; not human acceptance', { noteId, siteDigest, note, source: 'supplied_feedback', humanDecision: null });
        const seq = db.prepare('SELECT last_insert_rowid() seq').get().seq; db.exec('COMMIT'); return { seq, ...event };
      } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
    },
    requestDirectionRepair(key, selectionDigest) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const job = store.job(key);
        if (job.directionRepair) fail('DIRECTION_REPAIR_LIMIT', 'The single creative budget was already assigned to a direction repair');
        if (job.kind !== 'site' || job.state !== 'blocked' || job.errorCode !== 'DESIGN_SELECTION') fail('DIRECTION_REPAIR_INPUT', 'Only a held exact visual-direction selection can request this bounded repair');
        const result = store.updateJob(key, { state: 'queued', stage: 'directions', ownerPid: null, errorCode: null, directionRepair: { selectionDigest, requestedAt: now() }, message: 'One explicit direction repair queued within the existing creative budget; original studies preserved' });
        store.event(key, 'direction.repair_requested', result.message, { selectionDigest, creativeBudget: 1, humanDecision: null });
        db.exec('COMMIT'); return result;
      } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
    },
    claim(key, ownerPid = process.pid) { db.exec('BEGIN IMMEDIATE'); try { const job = store.job(key); if (job.state !== 'queued') fail('ALREADY_CLAIMED', 'Only queued jobs can be claimed; this job is already running or terminal'); guardBatchJob(store, job, { claiming: true }); const result = store.updateJob(key, { state: 'running', ownerPid, startedAt: now(), message: 'Starting' }); store.event(key, 'job.started', 'Worker claimed job'); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    cancel(key) { const job = store.job(key); if (['review_ready', 'cancelled'].includes(job.state)) return job; const result = store.updateJob(key, { state: 'cancelled', message: 'Cancelled by explicit request', ownerPid: null }); store.event(key, 'job.cancelled', result.message); return result; },
    retry(key) { const job = store.job(key); if (!['failed', 'blocked', 'cancelled'].includes(job.state) || job.attempt >= job.retryLimit) fail('RETRY_LIMIT', 'Retry is unavailable or its ceiling has been reached'); const result = store.updateJob(key, { state: 'queued', attempt: job.attempt + 1, ownerPid: null, deadlineAt: null, startedAt: null, outputs: {}, errorCode: null, stage: job.kind === 'site' ? 'qualification' : job.kind, message: 'Queued for bounded retry' }); store.event(key, 'job.retry', result.message); return result; },
    recover() {
      const ids = [];
      for (const job of db.prepare("SELECT record FROM factory_job WHERE state='running'").all().map(parse)) {
        let alive = true; try { process.kill(job.ownerPid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
        if (alive) continue;
        const modelStage = /^(research|brief|directions|selection|proposal|repair|creative-repair|critique)(?:-\d+)?$/.test(job.stage);
        const checkpoint = path.join(stateRoot, workRelative(job), `checkpoint-${job.stage}.json`);
        if (modelStage && !existsSync(checkpoint)) {
          store.updateJob(job.id, { state: 'blocked', ownerPid: null, errorCode: 'MODEL_UNCERTAIN', message: 'Worker stopped during an uncheckpointed model request. Inspect the owned native session before an explicit retry; no duplicate generation was launched.' });
          store.event(job.id, 'job.recovery_hold', 'Uncertain in-flight model held instead of silently generating twice');
        } else {
          store.updateJob(job.id, { state: 'queued', ownerPid: null, message: 'Recovered abandoned worker; completed stage artifacts will be reused' });
          store.event(job.id, 'job.recovered', 'Abandoned lease recovered');
        }
        ids.push(job.id);
      }
      return ids;
    },
    saveCandidate(campaignId, input, origin = 'operator_import') { store.campaign(campaignId); const data = candidateInput(input); const key = candidateKey(data); const existing = parse(db.prepare('SELECT record FROM factory_candidate WHERE id=?').get(key)); if (existing) return existing; const record = { id: key, campaignId, ...data, origin, createdAt: now() }; db.prepare('INSERT INTO factory_candidate VALUES(?,?,?)').run(key, campaignId, JSON.stringify(record)); return record; },
    importCandidates(campaignId, inputs, origin = 'operator_import') {
      const campaign = store.campaign(campaignId), validated = inputs.map(candidateInput);
      db.exec('BEGIN IMMEDIATE');
      try {
        const newIds = new Set(validated.map(candidateKey).filter(key => !db.prepare('SELECT 1 FROM factory_candidate WHERE id=?').get(key)));
        const existing = db.prepare('SELECT count(*) n FROM factory_candidate WHERE campaign_id=?').get(campaignId).n;
        if (existing + newIds.size > campaign.candidateLimit) fail('CANDIDATE_CAP', 'Candidate cap would be exceeded');
        const records = validated.map(v => store.saveCandidate(campaignId, v, origin)); db.exec('COMMIT'); return records;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    replaceCandidate(key, input, origin) { const previous = store.candidate(key); const data = candidateInput(input); if (data.name.toLowerCase() !== previous.name.toLowerCase()) fail('IDENTITY_CHANGE', 'A follow-up cannot silently replace the business identity'); const record = { ...previous, ...data, origin, updatedAt: now(), previousEvidenceDigests: [...(previous.previousEvidenceDigests || []), hash(previous)] }; if (!data.contactSourceEvidence) delete record.contactSourceEvidence; db.prepare('UPDATE factory_candidate SET record=? WHERE id=?').run(JSON.stringify(record), key); return record; },
    saveReference(record) { id(record.id); db.prepare('INSERT INTO factory_reference VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, JSON.stringify(record)); return record; },
    artifact(record) { const key = `file-${hash({ jobId: record.jobId, relative: record.relative }).slice(0, 24)}`; const data = { id: key, ...record }; db.prepare('INSERT INTO factory_artifact VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(key, record.jobId || null, JSON.stringify(data)); return data; },
    getArtifact(key) { const value = parse(db.prepare('SELECT record FROM factory_artifact WHERE id=?').get(id(key))); if (!value) fail('NOT_FOUND', 'Artifact not found'); return value; },
    artifacts(jobId) { return db.prepare('SELECT record FROM factory_artifact WHERE job_id=? ORDER BY rowid').all(id(jobId)).map(parse); },
    saveVault(record) { db.prepare('INSERT INTO factory_vault VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, JSON.stringify(record)); return record; },
  };
  return store;
}
