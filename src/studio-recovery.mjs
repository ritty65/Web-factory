import {hash,now,fail} from './contracts.mjs';
import {record,records,saveRecord,atomic} from './studio-state.mjs';
import {studioSpend,configureBudget} from './studio-budget.mjs';

// Apply to the private COPY only. Restricted discovery payloads never become
// durable backup history; stable IDs and all cost receipts remain intact.
export function sanitizeStudioSnapshot(db){
  let purged=0;
  for(const {id,kind,record:raw}of db.prepare("SELECT id,kind,record FROM factory_operation WHERE kind IN ('studio_spend','studio_pointer')").all()){
    const value=JSON.parse(raw);let changed=false;
    if(kind==='studio_spend'&&value.provider==='google'&&Object.hasOwn(value,'result')){delete value.result;changed=true;}
    if(kind==='studio_pointer'&&value.data){delete value.data;value.expired=true;changed=true;}
    if(changed){value.backupPayloadOmitted=true;db.prepare('UPDATE factory_operation SET record=? WHERE id=?').run(JSON.stringify(value),id);purged++;}
  }
  if(purged){db.exec('PRAGMA secure_delete=ON');db.exec('VACUUM');}
  return {googlePayloadsOmitted:purged};
}
export function holdStudioRestore(db,{snapshotId,restoredAt=now()}){
  if(!db.prepare("SELECT 1 FROM factory_operation WHERE kind='studio_settings'").get())return null;
  const throughChicagoDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(restoredAt));
  const store={db},hold={state:'held',snapshotId,restoredAt,throughChicagoDate,reason:'The backup cannot know charges or work after its capture. Reconcile actual lifetime pilot spending and reauthorize future dates.'};
  saveRecord(store,'studio-recovery-hold','studio_recovery_hold',hold);
  const pilot=record(store,'studio-autopilot','studio_autopilot');if(pilot)saveRecord(store,'studio-autopilot','studio_autopilot',{...pilot,enabled:false,version:pilot.version+1,pauseReason:'Restore requires account spending reconciliation and explicit resume.'});
  return hold;
}
export function reconcileStudioRestore(store,{snapshotId,restoredAt,totalLifetimeCents}){
  return atomic(store,()=>{
    const hold=record(store,'studio-recovery-hold','studio_recovery_hold');if(!hold||hold.snapshotId!==snapshotId||hold.restoredAt!==restoredAt)fail('STALE_EVIDENCE','Match the exact restored account-spending hold');
    const digest=hash({snapshotId,restoredAt,totalLifetimeCents});if(hold.state==='reconciled'){if(hold.reconciliationDigest!==digest)fail('IDEMPOTENCY_CONFLICT','This restore already has a different spending reconciliation');return hold;}
    const spend=studioSpend(store);if(spend.uncertain.length)fail('SPEND_UNCERTAIN','Acknowledge all retained incomplete receipts before reconciliation');
    const floorMicros=totalLifetimeCents*10000;if(floorMicros<spend.committedMicros||floorMicros>spend.limitMicros)fail('RECOVERY_SPEND_TOTAL','Declared lifetime spending must cover every retained charge and remain within the pilot ceiling');
    configureBudget(store,{limitCents:spend.limitMicros/10000,feesCents:Math.ceil((spend.feesMicros+floorMicros-spend.committedMicros)/10000)});
    const result={...hold,state:'reconciled',totalLifetimeCents,reconciliationDigest:digest,reconciledAt:now(),accountAudit:'operator_attested'};saveRecord(store,'studio-recovery-hold','studio_recovery_hold',result);return result;
  });
}
