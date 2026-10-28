import {hash,now,fail} from './contracts.mjs';
import {record,records,saveRecord,atomic} from './studio-state.mjs';

const LIMIT=100_000_000; // integer micro-USD; the agreed first-pilot ceiling is $100.
export function studioSpend(store){
  const budget=record(store,'studio-budget','studio_budget')||{limitMicros:LIMIT,feesMicros:0};
  const calls=records(store,'studio_spend');
  const committedMicros=budget.feesMicros+calls.reduce((sum,c)=>sum+(c.chargedMicros??c.reservedMicros),0);
  return {...budget,committedMicros,remainingMicros:Math.max(0,budget.limitMicros-committedMicros),
    recoveryHold:record(store,'studio-recovery-hold','studio_recovery_hold'),
    uncertain:calls.filter(c=>c.state==='requesting'||c.state==='uncertain').map(c=>({id:c.id,provider:c.provider,startedAt:c.startedAt})),
    calls:calls.slice(0,50).map(({result,...c})=>c),
    meaning:'App-managed, operator-attested cost ceilings. Unknown actual costs keep the full reservation. External account charges are not independently audited.'};
}
export function configureBudget(store,{limitCents=10000,feesCents=0}){
  return atomic(store,()=>{
    const prior=studioSpend(store),limitMicros=limitCents*10000,feesMicros=feesCents*10000;
    if(!Number.isSafeInteger(limitMicros)||limitMicros<10000||limitMicros>LIMIT||!Number.isSafeInteger(feesMicros)||feesMicros<prior.feesMicros)fail('BUDGET_CONFIG','The pilot ceiling is $100; recorded fees cannot be silently refunded');
    if(prior.committedMicros-prior.feesMicros+feesMicros>limitMicros)fail('BUDGET_CONFIG','New allowance is below already committed spending');
    return saveRecord(store,'studio-budget','studio_budget',{limitMicros,feesMicros,updatedAt:now()});
  });
}
export function reserveCall(store,{requestId,provider,input,purpose,upperMicros,jobId=null,providerCallLimit=300}){
  if(record(store,'studio-recovery-hold','studio_recovery_hold')?.state==='held')fail('RECOVERY_SPEND_HOLD','Reconcile provider account spending after this restore before any paid-capable request');
  if(jobId&&store.job(jobId).state!=='running')fail('CALL_JOB_STOPPED','Stopped or unclaimed jobs cannot reserve another provider call');
  if(!Number.isSafeInteger(upperMicros)||upperMicros<0||upperMicros>LIMIT)fail('PRICE_UNVERIFIED','A bounded verified cost estimate is required before a request');
  const id='spend-'+hash(requestId).slice(0,32),inputDigest=hash({provider,input,purpose,upperMicros,jobId});
  return atomic(store,()=>{
    const previous=record(store,id,'studio_spend');
    if(previous){if(previous.inputDigest!==inputDigest)fail('IDEMPOTENCY_CONFLICT','Paid request identity already binds different input');return {...previous,replayed:true};}
    const balance=studioSpend(store);
    const attempts=records(store,'studio_spend');
    if(attempts.length>=500||attempts.filter(c=>c.provider===provider).length>=providerCallLimit)fail('PROVIDER_CALL_CAP','The fixed pilot or account-specific request allowance is exhausted');
    if(balance.committedMicros>balance.limitMicros||attempts.some(c=>c.chargedMicros>c.reservedMicros))fail('PRICE_CEILING_EXCEEDED','Inspect the exceeded cost ceiling before further work');
    if(balance.uncertain.length)fail('SPEND_UNCERTAIN','An earlier request is incomplete. Resolve its exact receipt before further paid work');
    if(balance.remainingMicros<upperMicros)fail('PILOT_BUDGET','Remaining pilot allowance does not cover this request');
    if(jobId&&purpose.startsWith('ai:')&&records(store,'studio_spend').filter(c=>c.jobId===jobId&&c.purpose.startsWith('ai:')).length>=10)fail('MODEL_CALL_CAP','Ten model attempts already exist for this proposal, including failures');
    return saveRecord(store,id,'studio_spend',{id,inputDigest,provider,purpose,jobId,reservedMicros:upperMicros,chargedMicros:null,state:'requesting',startedAt:now()});
  });
}
export async function paidCall(store,options,fn){
  const receipt=reserveCall(store,options);
  if(receipt.replayed){
    if(receipt.state==='completed'){
      const cached=record(store,receipt.id,'studio_spend');
      if(cached.expiresAt&&Date.parse(cached.expiresAt)<=Date.now())fail('CALL_CACHE_EXPIRED','Paid response expired; no automatic repeat was launched');
      if(!Object.hasOwn(cached,'result'))fail('CALL_CACHE_EXPIRED','Paid response was purged; no automatic repeat was launched');
      return {...cached.result,replayed:true};
    }
    fail(receipt.state==='requesting'||receipt.state==='uncertain'?'SPEND_UNCERTAIN':'CALL_ALREADY_FAILED','This paid-capable attempt is retained and will not be repeated');
  }
  try{
    const value=await fn();
    const actual=value.actualMicros;
    if(actual!==null&&actual!==undefined&&(!Number.isSafeInteger(actual)||actual<0))fail('USAGE_INVALID','Provider usage could not be reconciled');
    const stored={...receipt,state:'completed',completedAt:now(),chargedMicros:actual??receipt.reservedMicros,
      result:value,...(options.expiresAt?{expiresAt:options.expiresAt}:{})};
    saveRecord(store,receipt.id,'studio_spend',stored);
    if(stored.chargedMicros>receipt.reservedMicros)fail('PRICE_CEILING_EXCEEDED','Reported cost exceeded the saved ceiling; inspect pricing before further work');
    return value;
  }catch(error){
    const previous=record(store,receipt.id,'studio_spend');
    if(previous?.state==='completed')throw error;
    const safeCode=/^[A-Z][A-Z0-9_]{1,70}$/.test(error.code||'')?error.code:'PROVIDER_FAILED';
    const uncertain=!!error.uncertain||/TIMEOUT|NETWORK|CANCELLED/.test(safeCode);
    saveRecord(store,receipt.id,'studio_spend',{...receipt,state:uncertain?'uncertain':'failed',chargedMicros:error.noCharge===true?0:receipt.reservedMicros,completedAt:now(),errorCode:safeCode});
    throw error;
  }
}
export function acknowledgeSpend(store,{id,startedAt}){
  return atomic(store,()=>{
    const receipt=record(store,id,'studio_spend');
    if(!receipt||receipt.startedAt!==startedAt)fail('STALE_EVIDENCE','Match the exact incomplete spending receipt');
    if(!['requesting','uncertain'].includes(receipt.state))return {id:receipt.id,state:receipt.state};
    if(Date.now()-Date.parse(receipt.startedAt)<120000)fail('CALL_ACTIVE','Wait two minutes before acknowledging an incomplete request');
    const updated={...receipt,state:'acknowledged_unknown',chargedMicros:receipt.reservedMicros,completedAt:now()};
    saveRecord(store,id,'studio_spend',updated);return {id,state:updated.state,chargedMicros:updated.chargedMicros};
  });
}
