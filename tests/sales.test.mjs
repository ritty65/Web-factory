import test from 'node:test';
import assert from 'node:assert/strict';
import {initialize,openStore} from '../src/db.mjs';
import {now} from '../src/contracts.mjs';
import {salesFixture} from './helpers-commercial.mjs';
test('sales case is same-business/idempotent and optimistic edits cannot lose a newer next action',async t=>{
  const {service,lead}=await salesFixture(t);const c=await service.dispatch('case_open',{candidateId:lead.id});
  assert.equal(c.id,(await service.dispatch('case_open',{candidateId:lead.id})).id);assert.equal(c.version,0);
  const update={id:c.id,version:0,stage:'review',nextAction:'Inspect actual phone pixels <img src=x>',assignee:'operator',dueAt:'2026-10-01T10:00:00.000Z'};
  const next=await service.dispatch('case_update',update);assert.equal(next.version,1);assert.equal(next.nextAction,update.nextAction);
  await assert.rejects(service.dispatch('case_update',update),e=>e.code==='STALE_CASE');
  const detail=await service.dispatch('case_get',{id:c.id});assert.equal(detail.case.nextAction,update.nextAction);assert.equal(detail.events.length,1);
  await assert.rejects(service.dispatch('case_update',{...update,version:1,humanDecision:'accepted'}),e=>e.code==='INVALID_INPUT');
});
test('activity idempotency binds content and suppression is sticky across ordinary edits',async t=>{
  const {service,lead}=await salesFixture(t),c=await service.dispatch('case_open',{candidateId:lead.id});
  const input={id:c.id,requestId:'event-key-001',kind:'suppressed',note:'Synthetic opt-out fixture only',reference:'fixture:optout',occurredAt:now()};
  const a=await service.dispatch('case_event',input),b=await service.dispatch('case_event',input);assert.equal(a.event.id,b.event.id);
  await assert.rejects(service.dispatch('case_event',{...input,note:'Different content'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  const detail=await service.dispatch('case_get',{id:c.id});assert.equal(detail.case.suppressed,true);
  await assert.rejects(service.dispatch('case_update',{id:c.id,version:detail.case.version,stage:'waiting_owner',nextAction:'Contact despite opt-out',assignee:'operator',dueAt:null}),e=>e.code==='SUPPRESSED');
});
test('invoices/deposits/refunds are separate reported facts, never verified sales or duplicate cash',async t=>{
  const {service,lead}=await salesFixture(t),c=await service.dispatch('case_open',{candidateId:lead.id});
  const entry=(requestId,kind,amountCents,reference,taxCents=0)=>service.dispatch('payment_record',{id:c.id,requestId,kind,amountCents,taxCents,reference,occurredAt:now()});
  await entry('invoice-001','invoice',100000,'fixture:invoice');
  let status=await service.dispatch('sales_status',{});assert.equal(status.money.reportedFullyPaidCases,0);assert.equal(status.money.receivedCents,0);
  await entry('receipt-001','receipt',50000,'fixture:deposit');status=await service.dispatch('sales_status',{});assert.equal(status.money.reportedFullyPaidCases,0);assert.equal(status.money.balanceDueCents,50000);
  await entry('receipt-002','receipt',50000,'fixture:balance');status=await service.dispatch('sales_status',{});assert.equal(status.money.reportedFullyPaidCases,1);assert.equal(status.verifiedPaidSales,null);
  await assert.rejects(entry('receipt-003','receipt',50000,'fixture:balance'),e=>e.code==='DUPLICATE_REFERENCE');
  await entry('refund-001','refund',100000,'fixture:refund');status=await service.dispatch('sales_status',{});assert.equal(status.money.reportedFullyPaidCases,0);assert.equal(status.money.netReceivedCents,0);
  await assert.rejects(entry('refund-002','refund',1,'fixture:over-refund'),e=>e.code==='MONEY_BALANCE');
  await assert.rejects(service.dispatch('payment_record',{id:c.id,requestId:'bad-money-001',kind:'receipt',amountCents:1.5,taxCents:0,reference:'fixture',occurredAt:now()}),e=>e.code==='INVALID_INPUT');
});
test('campaign rejected-research cost and all initial starts remain visible beyond recent job/case windows',async t=>{
  const {service,store,campaign,lead}=await salesFixture(t);const started=store.createJob({campaignId:campaign.id,kind:'site',input:{candidateId:lead.id}});store.claim(started.id);store.updateJob(started.id,{state:'failed',ownerPid:null});
  for(let n=0;n<305;n++)store.createJob({kind:'reference',input:{fixture:n}});
  const input={campaignId:campaign.id,requestId:'cost-key-001',stage:'research',cashCents:1000,minutes:25,hourlyRateCents:3000};
  await service.dispatch('cost_record',input);await service.dispatch('cost_record',input);
  const status=await service.dispatch('sales_status',{limit:1,offset:0});assert.equal(status.production.uniqueStarts,1);assert.equal(status.costs.cashCents,1000);assert.equal(status.costs.laborCents,1250);assert.equal(status.costs.totalCents,2250);assert.equal(status.costs.acquisitionCostPerVerifiedSaleCents,null);
  await assert.rejects(service.dispatch('cost_record',{...input,cashCents:2000}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  assert.equal(store.businesses().length,0);assert.equal(store.candidates().length,1);
});
test('unknown pilot-extension schema fails before rewriting any supported rows',async t=>{
  const {store,options}=await salesFixture(t);store.db.prepare("UPDATE factory_meta SET value='99' WHERE key='pilot_schema'").run();
  await assert.rejects(initialize(options),e=>e.code==='PILOT_SCHEMA');
  assert.throws(()=>openStore(options),e=>e.code==='PILOT_SCHEMA');
});
test('queued intentions are not production starts, and a retry cannot erase a prior real start',async t=>{
  const {service,store,campaign,lead}=await salesFixture(t),j=store.createJob({campaignId:campaign.id,kind:'site',input:{candidateId:lead.id}});
  assert.equal((await service.dispatch('sales_status',{})).production.uniqueStarts,0);
  store.claim(j.id);store.cancel(j.id);store.retry(j.id);
  assert.equal((await service.dispatch('sales_status',{})).production.uniqueStarts,1);
});
test('tax is included once and reported receipts must reconcile to the invoice tax component',async t=>{
  const {service,lead}=await salesFixture(t),c=await service.dispatch('case_open',{candidateId:lead.id});
  const entry=(requestId,kind,amountCents,taxCents)=>service.dispatch('payment_record',{id:c.id,requestId,kind,amountCents,taxCents,reference:'fixture:'+requestId,occurredAt:now()});
  await entry('tax-invoice','invoice',106600,6600);await entry('tax-deposit','receipt',53300,3300);
  await assert.rejects(entry('tax-wrong-balance','receipt',53300,0),e=>e.code==='MONEY_TAX');
  await entry('tax-balance','receipt',53300,3300);const s=await service.dispatch('sales_status',{});assert.equal(s.money.netRevenueExTaxCents,100000);assert.equal(s.money.reportedFullyPaidCases,1);
});
test('unknown founder labor cannot silently become a zero-cost observation',async t=>{
  const {service,campaign}=await salesFixture(t);
  const input={campaignId:campaign.id,requestId:'unknown-rate-001',stage:'research',cashCents:0,minutes:30,hourlyRateCents:0};
  await assert.rejects(service.dispatch('cost_record',input),e=>e.code==='INVALID_INPUT');
  await assert.rejects(service.dispatch('cost_record',{...input,minutes:0}),e=>e.code==='INVALID_INPUT');
  assert.equal((await service.dispatch('sales_status',{})).costs.coverage,'not_recorded');
});
test('partial receipts and full refunds cannot leave an impossible untaxed/tax balance',async t=>{
  const {service,lead}=await salesFixture(t),c=await service.dispatch('case_open',{candidateId:lead.id});
  const entry=(requestId,kind,amountCents,taxCents)=>service.dispatch('payment_record',{id:c.id,requestId,kind,amountCents,taxCents,reference:'fixture:'+requestId,occurredAt:now()});
  await entry('tax-split-invoice','invoice',106600,6600);
  await assert.rejects(entry('tax-split-bad','receipt',106000,0),e=>e.code==='MONEY_TAX');
  await entry('tax-split-valid','receipt',106600,6600);
  await assert.rejects(entry('tax-refund-bad','refund',106600,0),e=>e.code==='MONEY_TAX');
  await entry('tax-refund-valid','refund',106600,6600);
  assert.equal((await service.dispatch('sales_status',{})).money.netRevenueExTaxCents,0);
});
test('reported activity IDs cannot collide with internal next-action history',async t=>{
  const {service,lead}=await salesFixture(t),c=await service.dispatch('case_open',{candidateId:lead.id});
  await service.dispatch('case_event',{id:c.id,requestId:'edit-00000002',kind:'note',note:'A valid literal caller reference',occurredAt:now()});
  const next=await service.dispatch('case_update',{id:c.id,version:1,stage:'review',nextAction:'A real second action',assignee:'operator',dueAt:null});
  assert.equal(next.version,2);assert.equal((await service.dispatch('case_get',{id:c.id})).events.length,2);
});
test('every case ledger exposes honest totals and older-page navigation without truncating money totals',async t=>{
  const {service,lead}=await salesFixture(t),c=await service.dispatch('case_open',{candidateId:lead.id});
  for(let n=0;n<4;n++)await service.dispatch('payment_record',{id:c.id,requestId:'paged-invoice-'+n,kind:'invoice',amountCents:25000,taxCents:0,reference:'fixture:paged-'+n,occurredAt:now()});
  const first=await service.dispatch('case_get',{id:c.id,offset:0,limit:2}),last=await service.dispatch('case_get',{id:c.id,offset:2,limit:2});
  assert.equal(first.payments.length,2);assert.equal(first.paymentTotal,4);assert.equal(first.nextOffsets.payments,2);assert.equal(last.payments.length,2);assert.equal(last.nextOffsets.payments,null);assert.equal(last.money.invoicedCents,100000);
});
test('next-action dates are normalized to UTC before sorting and sticky suppression cannot acquire a new due date',async t=>{
  const {service,lead}=await salesFixture(t),c=await service.dispatch('case_open',{candidateId:lead.id});
  const v=await service.dispatch('case_update',{id:c.id,version:0,stage:'review',nextAction:'Inspect real pixels',assignee:'operator',dueAt:'2026-10-22T12:00:00+05:00'});assert.equal(v.dueAt,'2026-10-22T07:00:00.000Z');
  const suppressed=await service.dispatch('case_event',{id:c.id,requestId:'due-suppression-001',kind:'suppressed',note:'Do not contact fixture',occurredAt:now()});
  await assert.rejects(service.dispatch('case_update',{id:c.id,version:suppressed.case.version,stage:'lost',lossReason:'Fixture suppression',nextAction:'Contact again',assignee:'operator',dueAt:now()}),e=>e.code==='SUPPRESSED');
});
