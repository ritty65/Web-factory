import {z} from 'zod';
import path from 'node:path';
import {hash,now,fail,safeRelative} from './contracts.mjs';
import {treeHashes} from './proposal.mjs';

export const key=z.string().regex(/^[a-z0-9][a-z0-9-]{1,95}$/);
export const note=z.string().trim().min(1).max(1500).refine(s=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s));
export const requestId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/);
export const reference=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/);
export const pageSchema={offset:z.number().int().min(0).max(1000000).default(0),limit:z.number().int().min(1).max(100).default(30)};
const cents=z.number().int().min(0).max(100000000);
const date=z.string().datetime({offset:true});
const stage=z.enum(['researching','building','review','waiting_owner','agreement','delivery','delivered','lost']);
const op=(description,schema,readOnly=false)=>({description,schema,readOnly});
export const SALES_OPERATIONS={
  sales_status:op('Read paginated next actions and all-history production/cost/reported-money totals. Verified financial sales remain unknown; no forecast is a sale.',z.object(pageSchema).strict(),true),
  case_get:op('Read a sales case and paginated append-only operator-reported activity. Does not verify contact, approval or money.',z.object({id:key,...pageSchema}).strict(),true),
  case_open:op('Open one local case for an EXISTING candidate, optionally bound to its exact stopped proposal. No new prospect, contact or approval.',z.object({candidateId:key,siteJobId:key.optional()}).strict()),
  case_update:op('Optimistic next-action/stage update; stale versions and suppressed outreach work are rejected. Stage is reported, not authority or acceptance.',z.object({id:key,version:z.number().int().min(0),stage,nextAction:note,assignee:note.pipe(z.string().max(80)),dueAt:date.nullable(),lossReason:note.optional(),siteJobId:key.optional()}).strict()),
  case_event:op('Append idempotent reported activity; never performs contact or creates an approval. Suppression is sticky.',z.object({id:key,requestId,kind:z.enum(['note','contacted','reply','owner_review','agreement','delivery','lost','suppressed']),note,reference:reference.optional(),occurredAt:date}).strict()),
  cost_record:op('Append actual operator-reported cash and labor once; campaign-level rejected research remains in acquisition cost. Unknown labor rates cannot become zero cost. Does not charge a provider.',z.object({campaignId:key,caseId:key.optional(),requestId,stage:z.enum(['research','media','design','model','qa','sales','delivery','overhead']),cashCents:cents,minutes:z.number().int().min(0).max(100000),hourlyRateCents:cents}).strict().refine(v=>(v.cashCents>0||v.minutes>0)&&(!v.minutes||v.hourlyRateCents>0),'Enter a real cash cost or labor with an adopted positive rate; unknown costs stay unknown')),
  payment_record:op('Record invoice/receipt/refund observations in USD cents with an opaque reference. No cards/bank data, charging, settlement verification or automatic accepted sale.',z.object({id:key,requestId,kind:z.enum(['invoice','receipt','refund']),amountCents:cents.refine(n=>n>0),taxCents:cents,reference,occurredAt:date}).strict()),
};
const parse=r=>r?JSON.parse(r.record):null;
export function requirePilot(store){if(store.db.prepare("SELECT value FROM factory_meta WHERE key='pilot_schema'").get()?.value!=='1')fail('PILOT_NOT_INITIALIZED','Run the backed-up factory init migration before using pilot operations');}
export function transaction(store,fn){store.db.exec('BEGIN IMMEDIATE');try{const value=fn();store.db.exec('COMMIT');return value;}catch(e){if(store.db.isTransaction)store.db.exec('ROLLBACK');throw e;}}
export function getCase(store,id){requirePilot(store);const c=parse(store.db.prepare('SELECT record FROM factory_sales_case WHERE id=?').get(id));if(!c)fail('NOT_FOUND','Sales case not found');return c;}
function rows(store,table){return store.db.prepare(`SELECT record FROM ${table} ORDER BY rowid`).all().map(parse);}
function previous(store,table,id,input){const row=parse(store.db.prepare(`SELECT record FROM ${table} WHERE id=?`).get(id));if(row&&row.inputDigest!==hash(input))fail('IDEMPOTENCY_CONFLICT','This request ID already records different content');return row;}
function saveCase(store,c){store.db.prepare('UPDATE factory_sales_case SET record=? WHERE id=?').run(JSON.stringify(c),c.id);return c;}
function recordEvent(store,c,input){const id=`activity-${hash({caseId:c.id,requestId:input.requestId,...(input.kind==='action_updated'?{channel:'internal_action'}:{})}).slice(0,24)}`;const old=previous(store,'factory_sales_event',id,input);if(old)return old;const e={id,...input,caseId:c.id,source:'operator_reported',inputDigest:hash(input),recordedAt:now()};store.db.prepare('INSERT INTO factory_sales_event VALUES(?,?,?)').run(id,c.id,JSON.stringify(e));return e;}
export function moneySummary(entries){
  const result={invoicedCents:0,receivedCents:0,refundedCents:0,invoicedTaxCents:0,receivedTaxCents:0,refundedTaxCents:0};
  for(const p of entries){const kind={invoice:'invoiced',receipt:'received',refund:'refunded'}[p.kind];result[kind+'Cents']+=p.amountCents;result[kind+'TaxCents']+=p.taxCents;}
  result.netReceivedCents=result.receivedCents-result.refundedCents;result.netRevenueExTaxCents=result.netReceivedCents-result.receivedTaxCents+result.refundedTaxCents;
  result.balanceDueCents=Math.max(0,result.invoicedCents-result.netReceivedCents);result.reportedFullyPaid=result.invoicedCents>0&&result.balanceDueCents===0;
  return result;
}
export function salesStatus(store,{offset=0,limit=30}={}){
  requirePilot(store);const all=rows(store,'factory_sales_case'),money=rows(store,'factory_money'),costs=rows(store,'factory_cost');
  const moneyByCase=new Map();for(const p of money){if(!moneyByCase.has(p.caseId))moneyByCase.set(p.caseId,[]);moneyByCase.get(p.caseId).push(p);}
  const names=new Map(store.db.prepare('SELECT id,record FROM factory_candidate').all().map(r=>[r.id,JSON.parse(r.record).name]));
  const entries=all.map(c=>({...c,name:names.get(c.candidateId),money:moneySummary(moneyByCase.get(c.id)||[]),dueState:c.suppressed?'suppressed':!c.dueAt?'unscheduled':Date.parse(c.dueAt)<Date.now()?'overdue':'scheduled'}));
  entries.sort((a,b)=>Number(a.suppressed)-Number(b.suppressed)||(a.dueAt||'9999').localeCompare(b.dueAt||'9999')||a.id.localeCompare(b.id));
  const totals=moneySummary(money);totals.reportedFullyPaidCases=entries.filter(c=>c.money.reportedFullyPaid).length;delete totals.reportedFullyPaid;
  const initial=store.db.prepare("SELECT count(DISTINCT json_extract(j.record,'$.input.candidateId')) n FROM factory_job j WHERE json_extract(j.record,'$.kind')='site' AND json_extract(j.record,'$.input.parentSiteJobId') IS NULL AND EXISTS(SELECT 1 FROM factory_event e WHERE e.job_id=j.id AND json_extract(e.record,'$.type')='job.started')").get().n;
  const sum=field=>costs.reduce((n,r)=>n+r[field],0),bucket=s=>costs.filter(c=>s(c.stage)).reduce((n,c)=>n+c.cashCents+c.laborCents,0);
  return {at:now(),items:entries.slice(offset,offset+limit),total:all.length,offset,limit,nextOffset:offset+limit<all.length?offset+limit:null,verifiedPaidSales:null,money:{...totals,source:'operator_reported_not_financially_verified'},costs:{records:costs.length,cashCents:sum('cashCents'),minutes:sum('minutes'),laborCents:sum('laborCents'),totalCents:sum('cashCents')+sum('laborCents'),preSaleCents:bucket(s=>!['delivery','overhead'].includes(s)),fulfillmentCents:bucket(s=>s==='delivery'),overheadCents:bucket(s=>s==='overhead'),acquisitionCostPerVerifiedSaleCents:null,coverage:costs.length?'partial_operator_reported':'not_recorded'},production:{uniqueStarts:initial,denominator:'all distinct initial candidate production starts, including failed/unsold; revisions add cost, not prospects'},limits:['Reported receipts are not independently settled/retained purchases','Missing costs are unknown, not zero spend','No cohort conversion forecast or three-sales/week guarantee']};
}
async function siteBinding(store,candidateId,jobId){const j=store.job(jobId);if(j.kind!=='site'||j.input.candidateId!==candidateId||['queued','running'].includes(j.state)||!j.outputs.siteRelative||!j.outputs.siteDigest)fail('CASE_SITE','Choose a stopped exact proposal for this same business');if(hash(await treeHashes(path.join(store.stateRoot,safeRelative(j.outputs.siteRelative))))!==j.outputs.siteDigest)fail('STALE_PROPOSAL','Proposal bytes changed');return {siteJobId:j.id,siteDigest:j.outputs.siteDigest};}
export async function salesDispatch(store,name,input){
  requirePilot(store);
  if(name==='sales_status')return salesStatus(store,input);
  if(name==='case_get'){
    const c=getCase(store,input.id),page=table=>store.db.prepare(`SELECT record FROM ${table} WHERE case_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(c.id,input.limit,input.offset).map(parse);
    const total=table=>store.db.prepare(`SELECT count(*) n FROM ${table} WHERE case_id=?`).get(c.id).n;
    const eventTotal=total('factory_sales_event'),paymentTotal=total('factory_money'),costTotal=total('factory_cost'),next=n=>input.offset+input.limit<n?input.offset+input.limit:null;
    return {case:c,events:page('factory_sales_event'),payments:page('factory_money'),costs:page('factory_cost'),money:moneySummary(store.db.prepare('SELECT record FROM factory_money WHERE case_id=?').all(c.id).map(parse)),eventTotal,paymentTotal,costTotal,offset:input.offset,limit:input.limit,nextOffsets:{events:next(eventTotal),payments:next(paymentTotal),costs:next(costTotal)},handoffs:store.db.prepare("SELECT record FROM factory_operation WHERE kind='handoff' AND json_extract(record,'$.caseId')=? ORDER BY rowid DESC LIMIT 20").all(c.id).map(parse)};
  }
  if(name==='case_open'){
    const lead=store.candidate(input.candidateId),binding=input.siteJobId?await siteBinding(store,lead.id,input.siteJobId):{};
    return transaction(store,()=>{const id=`case-${hash(lead.id).slice(0,20)}`,old=parse(store.db.prepare('SELECT record FROM factory_sales_case WHERE id=?').get(id));if(old)return old;const c={id,candidateId:lead.id,campaignId:lead.campaignId,...binding,version:0,stage:'review',nextAction:'Review qualification, exact proposal and commercial prerequisites',assignee:'operator',dueAt:null,suppressed:false,source:'operator_reported',createdAt:now(),updatedAt:now()};store.db.prepare('INSERT INTO factory_sales_case VALUES(?,?,?)').run(id,lead.id,JSON.stringify(c));return c;});
  }
  if(name==='case_update'){
    const initial=getCase(store,input.id),binding=input.siteJobId?await siteBinding(store,initial.candidateId,input.siteJobId):{};
    return transaction(store,()=>{const c=getCase(store,input.id);if(c.version!==input.version)fail('STALE_CASE','A newer action exists; refresh before changing this case');if(c.suppressed&&(!['lost','delivered'].includes(input.stage)||input.dueAt))fail('SUPPRESSED','This business is suppressed; do not schedule contact');if(input.stage==='lost'&&!input.lossReason)fail('LOSS_REASON','A lost case requires a recorded reason');const {id,version,siteJobId,...patch}=input;const next={...c,...patch,...binding,dueAt:input.dueAt?new Date(input.dueAt).toISOString():null,version:c.version+1,updatedAt:now()};recordEvent(store,c,{requestId:`edit-${next.version.toString().padStart(8,'0')}`,kind:'action_updated',note:input.nextAction,stage:input.stage,occurredAt:now()});return saveCase(store,next);});
  }
  if(name==='case_event')return transaction(store,()=>{const c=getCase(store,input.id),id=`activity-${hash({caseId:c.id,requestId:input.requestId}).slice(0,24)}`,old=previous(store,'factory_sales_event',id,input);if(old)return {case:c,event:old};if(c.suppressed&&['contacted','owner_review','agreement'].includes(input.kind))fail('SUPPRESSED','No new contact activity on a suppressed case');const event=recordEvent(store,c,input);const next={...c,version:c.version+1,updatedAt:now(),...(input.kind==='suppressed'?{suppressed:true,stage:'lost',lossReason:input.note,nextAction:'Do not contact; suppression retained',dueAt:null}:{})};saveCase(store,next);return {case:next,event};});
  if(name==='cost_record')return transaction(store,()=>{store.campaign(input.campaignId);if(input.caseId&&getCase(store,input.caseId).campaignId!==input.campaignId)fail('COST_BINDING','Cost must bind the same campaign');const id=`cost-${hash({campaignId:input.campaignId,requestId:input.requestId}).slice(0,24)}`,old=previous(store,'factory_cost',id,input);if(old)return old;const r={id,...input,source:'operator_reported',inputDigest:hash(input),laborCents:Math.round(input.minutes*input.hourlyRateCents/60),recordedAt:now()};store.db.prepare('INSERT INTO factory_cost VALUES(?,?,?,?)').run(id,input.campaignId,input.caseId||null,JSON.stringify(r));return r;});
  if(name==='payment_record')return transaction(store,()=>{const c=getCase(store,input.id),id=`money-${hash({caseId:c.id,requestId:input.requestId}).slice(0,24)}`,old=previous(store,'factory_money',id,input);if(old)return old;
    if(input.taxCents>input.amountCents)fail('MONEY_TAX','Tax is a component of the total, not added twice');
    if(store.db.prepare("SELECT 1 FROM factory_money WHERE case_id=? AND json_extract(record,'$.kind')=? AND json_extract(record,'$.reference')=?").get(c.id,input.kind,input.reference))fail('DUPLICATE_REFERENCE','This invoice/receipt/refund reference is already recorded');
    const totals=moneySummary(store.db.prepare('SELECT record FROM factory_money WHERE case_id=?').all(c.id).map(parse));
    if(input.kind==='receipt'&&(!totals.invoicedCents||input.amountCents>totals.balanceDueCents))fail('MONEY_BALANCE','Record the invoice first; receipts cannot exceed its remaining balance');
    if(input.kind==='receipt'){
      const remainingTax=totals.invoicedTaxCents-totals.receivedTaxCents+totals.refundedTaxCents;
      if(input.taxCents>remainingTax||input.amountCents-input.taxCents>totals.balanceDueCents-remainingTax)fail('MONEY_TAX','Receipt tax must reconcile to the invoice component; do not count tax as revenue');
    }
    if(input.kind==='refund'&&(input.amountCents>totals.netReceivedCents||input.taxCents>totals.receivedTaxCents-totals.refundedTaxCents))fail('MONEY_BALANCE','A refund cannot exceed recorded net receipts/tax');
    if(input.kind==='refund'&&input.amountCents-input.taxCents>totals.netRevenueExTaxCents)fail('MONEY_TAX','Refund tax must reconcile to the remaining receipt components');
    const r={id,...input,caseId:c.id,source:'operator_reported',financiallyVerified:false,inputDigest:hash(input),recordedAt:now()};store.db.prepare('INSERT INTO factory_money VALUES(?,?,?)').run(id,c.id,JSON.stringify(r));return r;
  });
  fail('UNKNOWN_OPERATION','Unsupported sales operation');
}
