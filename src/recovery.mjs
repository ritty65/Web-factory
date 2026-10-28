import {readFile,writeFile,mkdir,readdir,lstat,chmod} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {z} from 'zod';
import {hash,now,fail,safeRelative} from './contracts.mjs';
import {noLinks} from './db.mjs';
import {key,pageSchema,requirePilot} from './sales.mjs';
import {operationRecord,operationList} from './pilot.mjs';
import {treeHashes} from './proposal.mjs';
import {verifySeedCapture} from './seed-capture.mjs';
import {validateSeedReceipt} from './seeds.mjs';

const SOURCE=fileURLToPath(new URL('../',import.meta.url));
const APP=['src','web','runtime','workers','tests','scripts','bin','docs','README.md','AGENTS.md','.impeccable.md','package.json','package-lock.json','opencode.json','qa.mjs'];
// Fixed small runtime inputs only: never traverse the venv, source caches or home.
APP.push(...['server.py','boundary.py','requirements.lock','runtime-manifest.json','tools-list.json'].map(name=>'tools/placeroot-runtime/'+name));
const STATE=['jobs','references','handoffs'];
const MAX_BYTES=512*1024*1024,MAX_FILES=20000;
export const RECOVERY_OPERATIONS={
  snapshot_create:{description:'Create a bounded private idle snapshot of fixed Factory source/DB/state. Rejects active/changed/symlink/oversized inputs. No credentials/node_modules or arbitrary roots.',schema:z.object({}).strict(),readOnly:false},
  snapshot_list:{description:'Read snapshot/restore metadata only; private DB/model/source bundles are not download routes.',schema:z.object({}).strict(),readOnly:true},
  snapshot_restore_check:{description:'Verify every snapshot hash and restore ONLY into a new private Factory root with automatic work disabled. Never overwrites canonical state or executes restored jobs.',schema:z.object({id:key}).strict(),readOnly:false},
  job_history:{description:'Read paginated full SQL job history and fixed recovery suggestions, including old work beyond the recent UI window.',schema:z.object({...pageSchema,state:z.enum(['queued','running','review_ready','failed','blocked','cancelled']).optional()}).strict(),readOnly:true},
};
const quote=s=>'"'+s.replaceAll('"','""')+'"';
function databaseFacts(db){
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)fail('SNAPSHOT_DATABASE','SQLite integrity/foreign keys failed');
  const tables={};for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()){
    const rows=db.prepare(`SELECT * FROM ${quote(name)}`).all();tables[name]={rows:rows.length,sha256:hash(rows)};
  }
  return tables;
}
async function filesUnder(root){
  const result=[];
  async function walk(p,rel){let info;try{info=await lstat(p);}catch(e){if(e.code==='ENOENT')return;throw e;}
    if(info.isSymbolicLink())fail('SYMLINK','Snapshots cannot follow symbolic links');
    if(info.isDirectory()){for(const e of (await readdir(p)).sort())await walk(path.join(p,e),rel?rel+'/'+e:e);}
    else if(info.isFile()){result.push({relative:rel,full:p,size:info.size});if(result.length>MAX_FILES)fail('SNAPSHOT_BUDGET','Snapshot file-count budget exceeded');}
    else fail('SNAPSHOT_FILE','Only regular files/directories can enter a snapshot');
  }
  await noLinks(root);await walk(root,'');return result;
}
async function inventory(store){
  const entries=[];
  for(const name of APP){try{await lstat(path.join(SOURCE,name));}catch{fail('SNAPSHOT_CHANGED','Required application source is missing');}for(const f of await filesUnder(path.join(SOURCE,name)))entries.push({name:'app/'+name+(f.relative?'/'+f.relative:''),...f});}
  for(const name of STATE)for(const f of await filesUnder(path.join(store.stateRoot,name)))entries.push({name:'state/'+name+(f.relative?'/'+f.relative:''),...f});
  if(entries.length>MAX_FILES)fail('SNAPSHOT_BUDGET','Snapshot file-count budget exceeded');return entries;
}
function idle(store){if(store.db.prepare("SELECT count(*) n FROM factory_job WHERE state IN ('queued','running')").get().n)fail('SNAPSHOT_BUSY','Wait for queued/running jobs to stop before a consistent snapshot');}
function version(store){return {data:store.db.prepare('PRAGMA data_version').get().data_version,changes:store.db.prepare('SELECT total_changes() n').get().n};}
async function writeNew(root,name,bytes){
  if(name!=='app/.impeccable.md')safeRelative(name);
  const target=path.join(root,name);await noLinks(target);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{flag:'wx',mode:0o600});
}
export async function createSnapshot(store,{maxBytes=MAX_BYTES}={}){
  requirePilot(store);idle(store);const id=`snapshot-${randomUUID().replaceAll('-','')}`,relative=`releases/${id}`,root=path.join(store.stateRoot,relative);
  await noLinks(root);await mkdir(path.dirname(root),{recursive:true,mode:0o700});await mkdir(root,{mode:0o700});
  const start=version(store),facts=databaseFacts(store.db);let total=0;const hashes={};
  try{
    const entries=await inventory(store);
    for(const e of entries){total+=e.size;if(e.size>32*1024*1024||total>maxBytes)fail('SNAPSHOT_BUDGET','Snapshot exceeds 32MiB/file or 512MiB total bound');await noLinks(e.full);const bytes=await readFile(e.full);if(bytes.length!==e.size)fail('SNAPSHOT_CHANGED','Input changed during snapshot');hashes[e.name]=hash(bytes);await writeNew(root,e.name,bytes);}
    // Official Node 24 SQLite online backup; never a raw copy of a live DB/WAL.
    // https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsourcedb-path-options
    const dbPath=path.join(root,'database.sqlite3');await backup(store.db,dbPath);await chmod(dbPath,0o600);const dbBytes=await readFile(dbPath);total+=dbBytes.length;
    if(dbBytes.length>32*1024*1024||total>maxBytes)fail('SNAPSHOT_BUDGET','Database exceeds per-file or remaining snapshot byte budget');hashes['database.sqlite3']=hash(dbBytes);
    const check=new DatabaseSync(dbPath,{readOnly:true});let copied;try{copied=databaseFacts(check);}finally{check.close();}
    idle(store);if(hash(start)!==hash(version(store))||hash(facts)!==hash(copied))fail('SNAPSHOT_CHANGED','Database changed during snapshot; captured root retained but not certified');
    const after=await inventory(store);if(hash(entries.map(e=>e.name))!==hash(after.map(e=>e.name)))fail('SNAPSHOT_CHANGED','Source/state membership changed during snapshot');
    for(const e of after){await noLinks(e.full);if(hash(await readFile(e.full))!==hashes[e.name])fail('SNAPSHOT_CHANGED','Source/state bytes changed during snapshot');}
    idle(store);if(hash(start)!==hash(version(store)))fail('SNAPSHOT_CHANGED','Database changed while final source/state verification was running');
    const sourceDigest=hash(Object.fromEntries(Object.entries(hashes).filter(([n])=>n.startsWith('app/'))));
    const manifest={schema:1,id,at:now(),scope:'Factory app/database/jobs/references/handoffs only',autoRun:false,files:hashes,bytes:total,sourceDigest,tables:facts,externalLibraryFilesIncluded:false,limits:['Not off-machine backup','Original indexed customer roots outside Factory state require their own backup','No credentials, node_modules, global configuration or model stores included']};
    const bytes=Buffer.from(JSON.stringify(manifest,null,2));await writeNew(root,'manifest.json',bytes);
    return operationRecord(store,id,'snapshot',{relative,sourceDigest,manifestSha256:hash(bytes),files:Object.keys(hashes).length,bytes:total,at:manifest.at,scope:manifest.scope,private:true});
  }catch(e){operationRecord(store,`failure-${id}`,'snapshot_failure',{at:now(),errorCode:e.code||'SNAPSHOT_FAILED',partialRootRetained:true,relative});throw e;}
}
export async function restoreSnapshotCheck(store,id){
  requirePilot(store);const row=store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='snapshot'").get(id);if(!row)fail('NOT_FOUND','Snapshot not found');const snap=JSON.parse(row.record);
  if(snap.relative!==`releases/${id}`)fail('SNAPSHOT_CORRUPT','Snapshot root binding changed');
  const root=path.join(store.stateRoot,snap.relative);await noLinks(root);const mBytes=await readFile(path.join(root,'manifest.json'));if(hash(mBytes)!==snap.manifestSha256)fail('SNAPSHOT_CORRUPT','Snapshot manifest changed');const manifest=JSON.parse(mBytes);
  if(manifest.schema!==1||manifest.id!==id||manifest.autoRun!==false||Object.keys(manifest.files).length>MAX_FILES||manifest.bytes>MAX_BYTES)fail('SNAPSHOT_CORRUPT','Snapshot contract/budget mismatch');
  for(const [name,sha] of Object.entries(manifest.files)){
    if(name!=='app/.impeccable.md')safeRelative(name);
    if(!/^(app\/|state\/(jobs|references|handoffs)\/|database\.sqlite3$)/.test(name))fail('SNAPSHOT_CORRUPT','Snapshot has an unsupported namespace');
    const target=path.join(root,name);await noLinks(target);if((await lstat(target)).size>32*1024*1024||hash(await readFile(target))!==sha)fail('SNAPSHOT_CORRUPT','A snapshot file is missing, oversized or changed');
  }
  const restoreId=`restore-${randomUUID().replaceAll('-','')}`,restoreRoot=path.join(store.stateRoot,'restores',restoreId);await noLinks(restoreRoot);await mkdir(path.dirname(restoreRoot),{recursive:true,mode:0o700});await mkdir(restoreRoot,{mode:0o700});
  for(const [name,sha] of Object.entries(manifest.files)){
    const source=path.join(root,name);await noLinks(source);const bytes=await readFile(source);
    if(hash(bytes)!==sha)fail('SNAPSHOT_CORRUPT','Snapshot changed between validation and restore');
    await writeNew(restoreRoot,name,bytes);
    if(hash(await readFile(path.join(restoreRoot,name)))!==sha)fail('SNAPSHOT_CORRUPT','Restored file verification failed');
  }
  const restoredDatabase=path.join(restoreRoot,'database.sqlite3'),db=new DatabaseSync(restoredDatabase,{readOnly:true});let tables,artifacts,jobs,parents,seedCaptures;const badSeedCaptures=[];
  try{tables=databaseFacts(db);artifacts=db.prepare('SELECT record FROM factory_artifact').all().map(r=>JSON.parse(r.record));jobs=db.prepare("SELECT record FROM factory_job WHERE json_extract(record,'$.outputs.siteDigest') IS NOT NULL").all().map(r=>JSON.parse(r.record));parents=new Map(jobs.filter(j=>j.kind==='site').map(j=>[j.id,j]));seedCaptures=db.prepare("SELECT record FROM factory_operation WHERE kind='seed_preparation' AND (json_type(record,'$.sourceCapture') IS NOT NULL OR (json_extract(record,'$.state')='prepared' AND json_extract(record,'$.recordPolicy')='quarantine_v1'))").all().map(r=>JSON.parse(r.record));for(const row of seedCaptures){try{const restored={db,stateRoot:path.join(restoreRoot,'state')};if(row.state==='prepared'&&row.recordPolicy==='quarantine_v1')validateSeedReceipt(restored,{id:row.id,digest:row.digest});else verifySeedCapture(restored,row);}catch{badSeedCaptures.push(row.id);}}}finally{db.close();}
  if(hash(tables)!==hash(manifest.tables))fail('SNAPSHOT_CORRUPT','Restored database contents differ from the captured snapshot');
  const bad=[];for(const a of artifacts){safeRelative(a.relative);if(manifest.files['state/'+a.relative]!==a.sha256)bad.push(a.id);}
  const badSites=[];for(const j of jobs){try{
    let relative=j.outputs.siteRelative;
    if(!relative&&j.kind==='qa'){
      // Historical QA jobs reference an exact parent; they do not own site bytes.
      const parent=parents.get(j.input.siteJobId);
      if(!parent||parent.campaignId!==j.campaignId||j.outputs.parentSiteJobId!==parent.id||j.input.siteDigest!==j.outputs.siteDigest||parent.outputs.siteDigest!==j.outputs.siteDigest)fail('SNAPSHOT_REFERENCE','QA does not bind its exact captured parent');
      relative=parent.outputs.siteRelative;
    }
    const site=path.join(restoreRoot,'state',safeRelative(relative));if(hash(await treeHashes(site))!==j.outputs.siteDigest)badSites.push(j.id);
  }catch{badSites.push(j.id);}}
  await writeNew(restoreRoot,'RESTORE-CONFIG.json',Buffer.from(JSON.stringify({autoRun:false,dbPath:restoredDatabase,stateRoot:path.join(restoreRoot,'state'),note:'Inspection-only new-root restore. No server/worker/scripts launched; canonical paths unchanged.'},null,2)));
  return operationRecord(store,`drill-${restoreId}`,'restore_drill',{at:now(),snapshotId:id,pass:bad.length===0&&badSites.length===0&&badSeedCaptures.length===0,autoRun:false,restoreRoot,restoredDatabase,tablesCompared:Object.keys(tables).length,artifactReferencesChecked:artifacts.length,siteReferencesChecked:jobs.length,seedCaptureReferencesChecked:seedCaptures.length,staleOrMissingSeedCaptureIds:badSeedCaptures,staleOrMissingArtifactIds:bad,staleOrMissingSiteJobIds:badSites,sourceDigest:manifest.sourceDigest,externalLibraryFilesIncluded:false,canonicalDatabaseNotRestoredOrOverwritten:true,operationalDrillRecordAppended:true,limits:manifest.limits});
}
export function recoverySuggestion(job){
  if(job.errorCode==='MODEL_UNCERTAIN')return 'Inspect the owned native model session before any explicit retry; do not issue a duplicate generation';
  if(/^SEARCH_|^SOURCE_/.test(job.errorCode||''))return 'Review source/provider access and relevance; failed search is not website absence';
  if(/^DESIGN_/.test(job.errorCode||''))return 'Inspect exact pixels/blockers and remaining authorized creative budget; never relabel technical QA as acceptance';
  if(/^STALE_/.test(job.errorCode||''))return 'Inputs or policy changed; preserve the old evidence and explicitly re-evaluate, not overwrite';
  if(/^QA_/.test(job.errorCode||''))return 'Inspect the exact QA report; checker-only corrections may recheck unchanged bytes without resetting model budgets';
  return job.state==='blocked'||job.state==='failed'?'Inspect retained stage evidence, dependency readiness and retry ceiling':'No recovery action currently required';
}
export async function recoveryDispatch(store,name,input){
  requirePilot(store);if(name==='snapshot_create')return createSnapshot(store);if(name==='snapshot_restore_check')return restoreSnapshotCheck(store,input.id);
  if(name==='snapshot_list')return {snapshots:operationList(store,'snapshot'),drills:operationList(store,'restore_drill'),failures:operationList(store,'snapshot_failure'),limits:'Private metadata only; no in-place restore or raw DB download'};
  if(name==='job_history'){
    const where=input.state?'WHERE state=?':'',args=input.state?[input.state]:[],total=store.db.prepare(`SELECT count(*) n FROM factory_job ${where}`).get(...args).n;
    const items=store.db.prepare(`SELECT record FROM factory_job ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(...args,input.limit,input.offset).map(r=>{const j=JSON.parse(r.record);return {...j,recoverySuggestion:recoverySuggestion(j)};});
    return {items,total,offset:input.offset,limit:input.limit,nextOffset:input.offset+input.limit<total?input.offset+input.limit:null};
  }
  fail('UNKNOWN_OPERATION','Unsupported recovery operation');
}
