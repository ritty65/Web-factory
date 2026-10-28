import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {mkdir,writeFile,readFile} from 'node:fs/promises';import {DatabaseSync} from 'node:sqlite';
import {apiFixture} from './helpers-studio.mjs';import {record,saveRecord} from '../src/studio-state.mjs';
import {reserveCall,paidCall,studioSpend} from '../src/studio-budget.mjs';import {openStore} from '../src/db.mjs';import {createService} from '../src/service.mjs';import {createSnapshot,restoreSnapshotCheck} from '../src/recovery.mjs';import {holdStudioRestore,reconcileStudioRestore} from '../src/studio-recovery.mjs';
test('private snapshot omits restricted discovery payloads, retains photos/spend and installs a paid-work restore hold',async t=>{
 const {store}=await apiFixture(t);await paidCall(store,{provider:'google',requestId:'snapshot-google-fixture',input:{},purpose:'lead:discovery',upperMicros:10000},async()=>({actualMicros:10000,data:{secretGooglePayload:'Restricted fixture sentinel'}}));
 saveRecord(store,'prospect-fixture','studio_pointer',{id:'prospect-fixture',placeId:'stable-fixture-id',data:{name:'Restricted pointer sentinel'},expiresAt:new Date(Date.now()+3600000).toISOString()});
 const relative='research/media/fixture/web.webp';await mkdir(path.dirname(path.join(store.stateRoot,relative)),{recursive:true});await writeFile(path.join(store.stateRoot,relative),'Fictional private media');
 const snap=await createSnapshot(store),manifest=JSON.parse(await readFile(path.join(store.stateRoot,snap.relative,'manifest.json'),'utf8'));assert.equal(manifest.privacy.googlePayloadsOmitted,2);assert.ok(manifest.files['app/tools/camofox-runtime/package-lock.json']);assert.ok(manifest.files['state/'+relative]);
 assert.equal(record(store,'prospect-fixture','studio_pointer').data.name,'Restricted pointer sentinel','backup sanitation must not invalidate live pointer evidence');
 const bytes=await readFile(path.join(store.stateRoot,snap.relative,'database.sqlite3'));assert.equal(bytes.includes(Buffer.from('Restricted fixture sentinel')),false);assert.equal(bytes.includes(Buffer.from('Restricted pointer sentinel')),false);
 const drill=await restoreSnapshotCheck(store,snap.id);assert.equal(drill.pass,true);const restored=openStore({dbPath:drill.restoredDatabase,stateRoot:path.join(drill.restoreRoot,'state')});t.after(()=>restored.close());
 assert.equal(record(restored,'prospect-fixture','studio_pointer').placeId,'stable-fixture-id');assert.equal(record(restored,'prospect-fixture','studio_pointer').data,undefined);assert.equal(studioSpend(restored).committedMicros,10000);
 assert.throws(()=>reserveCall(restored,{requestId:'restore-new-call',provider:'google',purpose:'test',input:{},upperMicros:10000}),e=>e.code==='RECOVERY_SPEND_HOLD');
 const hold=studioSpend(restored).recoveryHold,service=createService(restored,{autoRun:false});
 await assert.rejects(service.dispatch('studio_restore_reconcile',{snapshotId:hold.snapshotId,restoredAt:hold.restoredAt,totalLifetimeCents:0,accountTotalsChecked:true}),e=>e.code==='RECOVERY_SPEND_TOTAL');
 const cleared=await service.dispatch('studio_restore_reconcile',{snapshotId:hold.snapshotId,restoredAt:hold.restoredAt,totalLifetimeCents:3500,accountTotalsChecked:true});assert.equal(cleared.state,'reconciled');assert.equal(studioSpend(restored).committedMicros,35e6);
 assert.equal(studioSpend(store).committedMicros,10000,'canonical database remains unchanged');
});
test('restore reconciliation rejects stale identity, retained uncertain charges and a conflicting repeat',async t=>{
 const {store}=await apiFixture(t),snapshotId='snapshot-'+'a'.repeat(32),hold=holdStudioRestore(store.db,{snapshotId});
 assert.throws(()=>reconcileStudioRestore(store,{snapshotId,restoredAt:'2020-01-01T00:00:00.000Z',totalLifetimeCents:0}),e=>e.code==='STALE_EVIDENCE');
 const value={snapshotId,restoredAt:hold.restoredAt,totalLifetimeCents:0};reconcileStudioRestore(store,value);assert.equal(reconcileStudioRestore(store,value).state,'reconciled');assert.throws(()=>reconcileStudioRestore(store,{...value,totalLifetimeCents:1}),e=>e.code==='IDEMPOTENCY_CONFLICT');
});
