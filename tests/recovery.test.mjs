import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,symlink,stat} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {watch} from 'node:fs';
import {salesFixture} from './helpers-commercial.mjs';
import {hash} from '../src/contracts.mjs';
import {treeHashes} from '../src/proposal.mjs';

test('versioned source/DB/state snapshot restores only to a fresh private root without running work',async t=>{
  const {store,service,lead}=await salesFixture(t);await service.dispatch('case_open',{candidateId:lead.id});
  await mkdir(path.join(store.stateRoot,'references'),{recursive:true});await writeFile(path.join(store.stateRoot,'references/fixture.txt'),'Synthetic evidence');
  const snap=await service.dispatch('snapshot_create',{});assert.equal(snap.kind,'snapshot');assert.ok(snap.sourceDigest);assert.equal((await stat(path.join(store.stateRoot,snap.relative))).mode&0o777,0o700);
  const manifest=JSON.parse(await readFile(path.join(store.stateRoot,snap.relative,'manifest.json'),'utf8'));
  for(const name of ['server.py','boundary.py','requirements.lock','runtime-manifest.json','tools-list.json'])assert.ok(manifest.files['app/tools/placeroot-runtime/'+name],name+' must survive a source snapshot');
  assert.equal(Object.keys(manifest.files).some(n=>/tools\/placeroot-runtime\/(?:\.venv|cache|home|extensions)\//.test(n)),false);
  const drill=await service.dispatch('snapshot_restore_check',{id:snap.id});assert.equal(drill.pass,true);assert.equal(drill.autoRun,false);assert.notEqual(drill.restoredDatabase,store.dbPath);
  assert.equal(await readFile(path.join(drill.restoreRoot,'state/references/fixture.txt'),'utf8'),'Synthetic evidence');assert.equal((await stat(drill.restoredDatabase)).mode&0o777,0o600);
  assert.equal(store.db.prepare('SELECT count(*) n FROM factory_sales_case').get().n,1);
  const again=await service.dispatch('snapshot_restore_check',{id:snap.id});assert.notEqual(again.restoreRoot,drill.restoreRoot,'no existing restore directory can be overwritten');
  await assert.rejects(service.dispatch('snapshot_restore_check',{id:snap.id,target:store.dbPath}),e=>e.code==='INVALID_INPUT');
});
test('corruption, busy work, symlinks and out-of-budget trees fail closed',async t=>{
  const {store,service}=await salesFixture(t);const job=store.createJob({kind:'reference',input:{referenceId:'titos'}});
  await assert.rejects(service.dispatch('snapshot_create',{}),e=>e.code==='SNAPSHOT_BUSY');store.cancel(job.id);
  await mkdir(path.join(store.stateRoot,'references'),{recursive:true});await symlink('/etc/hosts',path.join(store.stateRoot,'references/escape'));
  await assert.rejects(service.dispatch('snapshot_create',{}),e=>e.code==='SYMLINK');
  // A different isolated fixture proves corruption without deleting the symlink.
  const f=await salesFixture(t),snap=await f.service.dispatch('snapshot_create',{});
  const manifest=JSON.parse(await readFile(path.join(f.store.stateRoot,snap.relative,'manifest.json'),'utf8'));
  const name=Object.keys(manifest.files).find(n=>n.startsWith('app/'));
  await writeFile(path.join(f.store.stateRoot,snap.relative,name),'tampered');
  await assert.rejects(f.service.dispatch('snapshot_restore_check',{id:snap.id}),e=>e.code==='SNAPSHOT_CORRUPT');
  const {createSnapshot}=await import('../src/recovery.mjs');await assert.rejects(createSnapshot(f.store,{maxBytes:10}),e=>e.code==='SNAPSHOT_BUDGET');
});
test('snapshot restore checks new private seed-journal references without exposing raw capture metadata',async t=>{
  const {createSeedCapture}=await import('../src/seed-capture.mjs');const {operationRecord}=await import('../src/pilot.mjs');
  const {store,service}=await salesFixture(t),id='seed-'+'a'.repeat(32);
  const row={id,state:'preparing',requestKey:'b'.repeat(64),inputDigest:'c'.repeat(64),settingsDigest:'d'.repeat(64),discoveryMode:'houston_local_radius_v1',recordPolicy:'quarantine_v1',retryOf:'seed-'+'e'.repeat(32)};
  operationRecord(store,id,'seed_preparation',row);const capture=await createSeedCapture(store,row);
  await capture.recordSourceEvent({phase:'request',callIndex:1,tool:'data_version',value:{name:'data_version',arguments:{}}});
  await capture.recordSourceEvent({phase:'response',callIndex:1,tool:'data_version',value:{structuredContent:{release:'2026-09-23.1'}}});
  await capture.finish('incomplete');
  const snap=await service.dispatch('snapshot_create',{}),drill=await service.dispatch('snapshot_restore_check',{id:snap.id});
  assert.equal(drill.pass,true);assert.equal(drill.seedCaptureReferencesChecked,1);assert.deepEqual(drill.staleOrMissingSeedCaptureIds,[]);
  assert.doesNotMatch(JSON.stringify(drill),/structuredContent|seed-source-receipts/);
  const retained=JSON.parse(store.db.prepare("SELECT record FROM factory_operation WHERE id=? AND kind='seed_preparation'").get(id).record);retained.sourceCapture.digest='0'.repeat(64);operationRecord(store,id,'seed_preparation',retained);
  const badSnap=await service.dispatch('snapshot_create',{}),bad=await service.dispatch('snapshot_restore_check',{id:badSnap.id});
  assert.equal(bad.pass,false);assert.deepEqual(bad.staleOrMissingSeedCaptureIds,[id]);
});
test('history pagination reaches older jobs beyond the 300-row UI window without changing them',async t=>{
  const {store,service}=await salesFixture(t);let first;
  for(let n=0;n<310;n++){const j=store.createJob({kind:'reference',input:{fixture:n}});first||=j.id;}
  const page=await service.dispatch('job_history',{offset:300,limit:30});assert.equal(page.total,310);assert.ok(page.items.some(j=>j.id===first));assert.equal(page.nextOffset,null);
  assert.equal(store.job(first).state,'queued');
});
test('a real killed child is recovered from a checkpoint, while uncertain model work holds',async t=>{
  const {store,options}=await salesFixture(t);
  for(const [stage,checkpoint,expected] of [['source',true,'queued'],['proposal',false,'blocked']]){
    const job=store.createJob({kind:'reference',input:{fixture:stage}});
    const script=`import {openStore} from ${JSON.stringify(new URL('../src/db.mjs',import.meta.url).href)};import{mkdir,writeFile}from'node:fs/promises';const s=openStore(JSON.parse(process.argv[1]));s.claim(process.argv[2]);s.updateJob(process.argv[2],{stage:process.argv[3]});if(process.argv[4]==='yes'){const p=s.stateRoot+'/jobs/'+process.argv[2]+'/attempt-0';await mkdir(p,{recursive:true});await writeFile(p+'/checkpoint-'+process.argv[3]+'.json','{}');}console.log('ready');setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify(options),job.id,stage,checkpoint?'yes':'no'],{stdio:['ignore','pipe','pipe']});
    await once(child.stdout,'data');const exited=once(child,'exit');child.kill('SIGKILL');await exited;store.recover();
    assert.equal(store.job(job.id).state,expected);if(!checkpoint)assert.equal(store.job(job.id).errorCode,'MODEL_UNCERTAIN');
  }
});
test('concurrent database changes invalidate a capture instead of silently claiming consistency',async t=>{
  const {store,service}=await salesFixture(t),releases=path.join(store.stateRoot,'releases');await mkdir(releases);
  let injected=false;const watcher=watch(releases,{recursive:true},(event,filename)=>{
    if(!injected&&filename?.endsWith('database.sqlite3')){injected=true;store.db.prepare("INSERT INTO factory_meta VALUES('fixture-concurrent-write','retained')").run();}
  });
  try{await assert.rejects(service.dispatch('snapshot_create',{}),e=>e.code==='SNAPSHOT_CHANGED');assert.equal(injected,true);assert.equal((await service.dispatch('snapshot_list',{})).snapshots.length,0);}finally{watcher.close();}
});
test('restore checks frozen proposal site references as well as indexed artifacts',async t=>{
  const {service,store,campaign,lead}=await salesFixture(t),j=store.createJob({campaignId:campaign.id,kind:'site',input:{candidateId:lead.id}});
  const relative=`jobs/${j.id}/attempt-0/proposal-0/site`;await mkdir(path.join(store.stateRoot,relative),{recursive:true});await writeFile(path.join(store.stateRoot,relative,'index.html'),'Synthetic stale site');
  store.updateJob(j.id,{state:'blocked',outputs:{siteRelative:relative,siteDigest:'0'.repeat(64)}});
  const snap=await service.dispatch('snapshot_create',{}),drill=await service.dispatch('snapshot_restore_check',{id:snap.id});
  assert.equal(drill.pass,false);assert.equal(drill.siteReferencesChecked,1);assert.deepEqual(drill.staleOrMissingSiteJobIds,[j.id]);
});
test('historical QA records resolve only their exact same-campaign parent site instead of inventing a site root',async t=>{
  const {service,store,campaign,lead}=await salesFixture(t),site=store.createJob({campaignId:campaign.id,kind:'site',input:{candidateId:lead.id}});
  const relative=`jobs/${site.id}/attempt-0/proposal-0/site`,root=path.join(store.stateRoot,relative);await mkdir(root,{recursive:true});await writeFile(path.join(root,'index.html'),'Synthetic exact parent');
  const siteDigest=hash(await treeHashes(root));store.updateJob(site.id,{state:'review_ready',outputs:{siteRelative:relative,siteDigest}});
  const qa=store.createJob({campaignId:campaign.id,kind:'qa',input:{siteJobId:site.id,siteDigest}});store.updateJob(qa.id,{state:'review_ready',outputs:{parentSiteJobId:site.id,siteDigest}});
  const snap=await service.dispatch('snapshot_create',{}),drill=await service.dispatch('snapshot_restore_check',{id:snap.id});
  assert.equal(drill.pass,true);assert.equal(drill.siteReferencesChecked,2);assert.deepEqual(drill.staleOrMissingSiteJobIds,[]);
  store.updateJob(qa.id,{outputs:{parentSiteJobId:site.id,siteDigest:'0'.repeat(64)}});
  const bad=await service.dispatch('snapshot_create',{}),held=await service.dispatch('snapshot_restore_check',{id:bad.id});assert.equal(held.pass,false);assert.deepEqual(held.staleOrMissingSiteJobIds,[qa.id]);
});

test('private intake originals and dependency-install controls survive a fresh-root restore',async t=>{
  const {store,service}=await salesFixture(t);
  const relative='intake/photos/photo-fictional/original.jpg';await mkdir(path.dirname(path.join(store.stateRoot,relative)),{recursive:true});await writeFile(path.join(store.stateRoot,relative),'Fictional private bytes, not a real photograph');
  const snap=await service.dispatch('snapshot_create',{}),manifest=JSON.parse(await readFile(path.join(store.stateRoot,snap.relative,'manifest.json'),'utf8'));
  for(const name of ['.npmrc','.nvmrc','.gitignore'])assert.ok(manifest.files['app/'+name]);assert.ok(manifest.files['state/'+relative]);
  const drill=await service.dispatch('snapshot_restore_check',{id:snap.id});assert.equal(drill.pass,true);assert.equal(await readFile(path.join(drill.restoreRoot,'state',relative),'utf8'),'Fictional private bytes, not a real photograph');assert.equal(await readFile(path.join(drill.restoreRoot,'app/.npmrc'),'utf8'),await readFile(new URL('../.npmrc',import.meta.url),'utf8'));
  assert.equal(Object.keys(manifest.files).some(n=>n==='app/.env'||n.includes('/credentials/')),false);
});
