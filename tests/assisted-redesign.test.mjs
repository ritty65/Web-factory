import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assistedFixture, assistedStore } from './helpers-assisted.mjs';
import { assistedDispatch } from '../src/assisted.mjs';
import { hash, workRelative } from '../src/contracts.mjs';
import { policyIdentity } from '../src/policy.mjs';
import { saveBatch, getBatch, guardBatchJob } from '../src/batch-store.mjs';

const api = () => import('../src/assisted-redesign.mjs');
async function fixture(t, mutate = () => {}) {
  const store = await assistedStore(t), f = await assistedFixture();
  f.bundle.observations[1].text = 'Services\nInterior Steam & Shampoo\nDeep cleaning of seats and carpets with steam and shampoo.\n$120.00\n2h\nExterior Wash\nHand wash and careful drying of exterior surfaces.\n$50.00\n1h\nReviews\nPrivate reviewer name and unrelated claim.';
  mutate(f);
  const saved = await assistedDispatch(store, 'assisted_save', f);
  const built = await assistedDispatch(store, 'assisted_build', { id: saved.id, bundleDigest: saved.bundleDigest, evidenceDigest: saved.evidenceDigest, policyDigest: (await policyIdentity('production')).digest, requestId: 'build-design-fixture', authorized: true });
  const relative = `jobs/${built.job.id}/site`;
  await mkdir(path.join(store.stateRoot, relative), { recursive: true });
  await writeFile(path.join(store.stateRoot, relative, 'index.html'), '<h1>Rejected fixture</h1>');
  const siteDigest = hash({ 'index.html': hash(Buffer.from('<h1>Rejected fixture</h1>')) });
  const parent = store.updateJob(built.job.id, { state: 'blocked', stage: 'critique', errorCode: 'DESIGN_REWORK', outputs: { siteRelative: relative, siteDigest, qaPass: true, reviewStatus: 'creative_rework_required' } });
  saveBatch(store, { ...built.batch, state: 'held', phase: 'first_site_review' });
  return { store, parent, saved, batch: getBatch(store, built.batch.id), f };
}
async function request(store, parent, overrides = {}) {
  const { designDispatch } = await api(), context = await designDispatch(store, 'design_context_get', { id: parent.id });
  return { id: parent.id, siteDigest: context.siteDigest, policyDigest: context.policyDigest, requestId: 'redesign-fixture-1', authorized: true, feedback: 'Reject the old composition; make a distinct useful photographic design.', contentFacts: context.availableFacts.filter(f => f.sourceId === 'external-booking-1').slice(0, 2).map(({ sourceId, excerpt, text }) => ({ sourceId, excerpt, text })), ...overrides };
}
test('a held first-site batch permits one read-only current-policy QA recheck of its exact site', async t => {
  const { store, parent } = await fixture(t);
  const qa = store.createJob({ campaignId: parent.campaignId, kind: 'qa', input: { siteJobId: parent.id, siteDigest: parent.outputs.siteDigest, policyDigest: 'a'.repeat(64) } });
  assert.equal(store.claim(qa.id).state, 'running');
  assert.throws(() => store.createJob({ campaignId: parent.campaignId, kind: 'qa', input: { siteJobId: 'job-does-not-exist', siteDigest: parent.outputs.siteDigest, policyDigest: 'a'.repeat(64) } }), { code: 'BATCH_STOPPED' });
  assert.throws(() => store.createJob({ campaignId: parent.campaignId, kind: 'source', input: { url: 'https://www.instagram.com/juniper1/' } }), { code: 'BATCH_STOPPED' });
});
test('one assisted polish adopts current policy for an exact visually held site and a second polish is refused', async t => {
  const { store, parent, batch } = await fixture(t);
  const { designDispatch } = await api(), context = await designDispatch(store, 'design_context_get', { id: parent.id });
  const input = { id: parent.id, siteDigest: context.siteDigest, policyDigest: context.policyDigest, requestId: 'polish-fixture-1', authorized: true, feedback: 'Fix only the two recorded visual blockers.' };
  const result = await designDispatch(store, 'assisted_polish', input);
  assert.equal(result.job.input.polishOf, parent.id);
  assert.equal(result.job.input.parentSiteDigest, parent.outputs.siteDigest);
  assert.equal(result.job.input.assistedIntake.id, batch.assistedIntake.id);
  assert.equal(result.batch.policyDigest, context.policyDigest);
  assert.match(result.batch.policyHistory.at(-1).polishReceiptId, /^assisted-polish-/);
  assert.equal(store.claim(result.job.id).state, 'running');
  await assert.rejects(designDispatch(store, 'assisted_polish', { ...input, requestId: 'polish-fixture-2' }), e => e.code === 'ASSISTED_POLISH_PENDING');
  store.updateJob(result.job.id, { state: 'blocked', errorCode: 'DESIGN_REWORK' });
  await assert.rejects(designDispatch(store, 'assisted_polish', { ...input, requestId: 'polish-fixture-2b' }), e => e.code === 'POLISH_CAP');
  const stale = await fixture(t), staleContext = await designDispatch(stale.store, 'design_context_get', { id: stale.parent.id });
  await assert.rejects(designDispatch(stale.store, 'assisted_polish', { ...input, id: stale.parent.id, siteDigest: 'b'.repeat(64), policyDigest: staleContext.policyDigest, requestId: 'polish-fixture-3' }), e => e.code === 'STALE_PROPOSAL');
});
test('context exposes literal identity-matched catalogue options without writes or raw sources', async t => {
  const { store, parent } = await fixture(t), { designDispatch, DESIGN_OPERATIONS } = await api();
  const before = store.db.prepare('SELECT total_changes() n').get().n;
  const c = await designDispatch(store, 'design_context_get', { id: parent.id });
  assert.equal(DESIGN_OPERATIONS.design_context_get.readOnly, true);
  assert.equal(c.assessment.ready, true, c.assessment.reasons.join('\n'));
  assert(c.availableFacts.some(f => f.text === 'Interior Steam & Shampoo'));
  assert(c.availableFacts.some(f => f.text === 'Deep cleaning of seats and carpets with steam and shampoo.'));
  assert.equal(store.db.prepare('SELECT total_changes() n').get().n, before);
  assert.doesNotMatch(JSON.stringify(c), /\$120|Private reviewer|originalBase64|mediaUrl|\/tmp\/opencode/);
});
test('one isolated child preserves parent, evidence, budgets and exact idempotent replay', async t => {
  const { store, parent, batch } = await fixture(t), { designDispatch, readDesignContent } = await api(), input = await request(store, parent);
  const [a, b] = await Promise.all([designDispatch(store, 'assisted_redesign', input), designDispatch(store, 'assisted_redesign', input)]);
  assert.equal(a.job.id, b.job.id); assert.equal(store.jobs().length, 2);
  assert.deepEqual(store.job(parent.id), parent); assert.deepEqual(getBatch(store, batch.id).usage, batch.usage);
  assert.equal(a.job.retryLimit, 0); assert.equal(a.job.input.parentSiteJobId, parent.id);
  assert.equal(a.job.input.assistedIntake.id, batch.assistedIntake.id);
  assert.equal(readDesignContent(store, a.job).facts[0].id, 'design-fact-1');
  assert.equal(store.claim(a.job.id).state, 'running');
  await assert.rejects(designDispatch(store, 'assisted_redesign', { ...input, feedback: 'Changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(designDispatch(store, 'assisted_redesign', { ...input, requestId: 'another-redesign' }), { code: 'ASSISTED_REVISION_PENDING' });
});
test('unsupported selected text, excess facts and missing authority cannot queue', async t => {
  const { store, parent } = await fixture(t), { designDispatch } = await api(), input = await request(store, parent);
  for (const patch of [{ authorized: false }, { contentFacts: [{ sourceId: 'external-booking-1', text: 'Invented', excerpt: 'Invented' }] }, { contentFacts: Array(13).fill(input.contentFacts[0]) }, { contentFacts: [{ ...input.contentFacts[0], text: 'Different interpretation' }] }]) await assert.rejects(designDispatch(store, 'assisted_redesign', { ...input, ...patch }));
  assert.equal(store.jobs().length, 1);
});
test('wrong booking title never supplies catalogue facts', async t => {
  const { store, parent } = await fixture(t, f => { f.bundle.observations[1].title = 'Another unrelated business'; }), { designDispatch } = await api();
  const c = await designDispatch(store, 'design_context_get', { id: parent.id });
  assert.equal(c.availableFacts.some(f => f.sourceId === 'external-booking-1'), false);
});
test('arbitrary revision IDs and wrong-child receipt reuse cannot establish authority', async t => {
  const { store, parent } = await fixture(t), { designDispatch } = await api(), input = await request(store, parent);
  const raw = { candidateId: parent.input.candidateId, parentSiteJobId: parent.id, parentSiteDigest: parent.outputs.siteDigest, feedback: input.feedback, craftVersion: 2, assistedIntake: parent.input.assistedIntake, assistedRevisionId: 'assisted-revision-forged' };
  assert.throws(() => store.createJob({ campaignId: parent.campaignId, kind: 'site', input: raw }), { code: 'BATCH_ASSISTED_BINDING' });
  const { job } = await designDispatch(store, 'assisted_redesign', input);
  assert.throws(() => store.createJob({ campaignId: parent.campaignId, kind: 'site', input: { ...job.input, feedback: 'Different' } }), { code: 'BATCH_ASSISTED_BINDING' });
});
test('retained parent byte drift blocks both queue and later stages', async t => {
  const { store, parent, batch } = await fixture(t), { designDispatch, readDesignContent } = await api(), input = await request(store, parent);
  const { job } = await designDispatch(store, 'assisted_redesign', input);
  await writeFile(path.join(store.stateRoot, parent.outputs.siteRelative, 'index.html'), 'tampered');
  assert.throws(() => store.claim(job.id), { code: 'BATCH_ASSISTED_BINDING' });
  assert.throws(() => guardBatchJob(store, job), { code: 'BATCH_ASSISTED_BINDING' });
  assert.throws(() => readDesignContent(store, job), { code: 'BATCH_ASSISTED_BINDING' });
  assert.equal(getBatch(store, batch.id).deadlineAt, batch.deadlineAt);
});
test('expired outer deadline and depleted model reserve reject without policy adoption', async t => {
  for(const patch of [b=>({...b,deadlineAt:new Date(Date.now()-1).toISOString()}),b=>({...b,usage:{...b.usage,modelRequests:11}})]){
    const {store,parent,batch}=await fixture(t),{designDispatch}=await api(),input=await request(store,parent);
    const changed=saveBatch(store,patch(batch));
    await assert.rejects(designDispatch(store,'assisted_redesign',input));
    assert.equal(store.jobs().length,1);assert.deepEqual(getBatch(store,batch.id).policyHistory,changed.policyHistory);
  }
});
test('candidate drift, unsupported redirect and absent published destination cannot grant facts or queue', async t => {
  const {store,parent}=await fixture(t),{designDispatch}=await api(),input=await request(store,parent);
  const c=store.candidate(parent.input.candidateId);
  store.db.prepare('UPDATE factory_candidate SET record=? WHERE id=?').run(JSON.stringify({...c,summary:'Changed after intake'}),c.id);
  await assert.rejects(designDispatch(store,'assisted_redesign',input),{code:'BATCH_ASSISTED_BINDING'});
  const {availableDesignFacts,readAssistedEvidence}=await import('../src/assisted-evidence.mjs');
  const value=readAssistedEvidence(store,parent.input.assistedIntake);
  for(const mutate of [v=>{v.evidence.observations[0].links=[];},v=>{v.evidence.observations[1].finalUrl='https://booksy.com/en-us/999999_someone_else';},v=>{v.evidence.observations[1].blocked=true;}]){
    const copy=structuredClone(value);mutate(copy);
    assert.equal(availableDesignFacts(copy).some(f=>f.sourceId==='external-booking-1'),false);
  }
});
test('retained source drift blocks a child at claim and stage without deleting its receipt', async t => {
  const {store,parent,saved}=await fixture(t),{designDispatch,readDesignContent}=await api(),input=await request(store,parent);
  const {job}=await designDispatch(store,'assisted_redesign',input);
  const file=path.join(store.stateRoot,'references','assisted-intake',saved.id,'bundle.json');
  const bytes=await readFile(file),bundle=JSON.parse(bytes);bundle.evidence.observations[1].text+=' Altered after admission';
  await writeFile(file,JSON.stringify(bundle));
  assert.throws(()=>store.claim(job.id),{code:'BATCH_ASSISTED_BINDING'});
  assert.throws(()=>readDesignContent(store,job),{code:'BATCH_ASSISTED_BINDING'});
  assert(store.db.prepare("SELECT id FROM factory_operation WHERE id=? AND kind='assisted_revision'").get(job.input.assistedRevisionId));
  assert.equal(store.job(job.id).state,'queued');
});
test('two history-wide revisions include failed jobs and cannot reset through new request IDs', async t => {
  const {store,parent}=await fixture(t),{designDispatch}=await api(),input=await request(store,parent);
  const first=await designDispatch(store,'assisted_redesign',input);
  store.updateJob(first.job.id,{state:'failed',errorCode:'MODEL_FAILED'});
  const second=await designDispatch(store,'assisted_redesign',{...input,requestId:'redesign-fixture-2'});
  store.updateJob(second.job.id,{state:'cancelled'});
  await assert.rejects(designDispatch(store,'assisted_redesign',{...input,requestId:'redesign-fixture-3'}));
  assert.equal(store.jobs().length,3);assert.equal(store.job(first.job.id).errorCode,'MODEL_FAILED');
});
test('late duplicate identities cannot claim a previously queued redesign', async t => {
  const {store,parent}=await fixture(t),{designDispatch}=await api(),input=await request(store,parent);
  const {job}=await designDispatch(store,'assisted_redesign',input),candidate=store.candidate(parent.input.candidateId);
  const duplicate={...candidate,id:'lead-duplicate-after-admission'};
  store.db.prepare('INSERT INTO factory_candidate VALUES(?,?,?)').run(duplicate.id,duplicate.campaignId,JSON.stringify(duplicate));
  assert.throws(()=>store.claim(job.id));
});
test('review-ready assisted parents also require a host receipt before any direct child insertion', async t => {
  const {store,parent,batch}=await fixture(t);
  const ready=store.updateJob(parent.id,{state:'review_ready',outputs:{...parent.outputs,reviewStatus:'operator_review_required'}});
  const before=store.jobs().length;
  assert.throws(()=>store.createJob({campaignId:ready.campaignId,kind:'site',input:{candidateId:ready.input.candidateId,parentSiteJobId:ready.id,parentSiteDigest:ready.outputs.siteDigest,assistedIntake:batch.assistedIntake,feedback:'Caller tries ordinary direct revision',craftVersion:2}}),{code:'BATCH_ASSISTED_BINDING'});
  assert.equal(store.jobs().length,before);
});
test('review-ready parents with failing technical QA are not eligible', async t => {
  const {store,parent}=await fixture(t),{designDispatch}=await api();
  store.updateJob(parent.id,{state:'review_ready',outputs:{...parent.outputs,qaPass:false,reviewStatus:'operator_review_required'}});
  assert.equal((await designDispatch(store,'design_context_get',{id:parent.id})).assessment.ready,false);
});
test('explicit policy adoption preserves both histories, original proof job, usage and source window', async t => {
  const {store,parent,batch}=await fixture(t),{designDispatch}=await api(),input=await request(store,parent);
  const {assistedProofId,readAssistedEvidence}=await import('../src/assisted-evidence.mjs');
  const proofId=assistedProofId(readAssistedEvidence(store,batch.assistedIntake).scope.authorizationId);
  const before=JSON.parse(store.db.prepare('SELECT record FROM factory_operation WHERE id=?').get(proofId).record);
  saveBatch(store,{...batch,policyDigest:'0'.repeat(64),policyHistory:[{fixture:'retained old policy history'}]});
  await assert.rejects(designDispatch(store,'assisted_redesign',{...input,policyDigest:'f'.repeat(64)}),{code:'BATCH_POLICY'});
  assert.equal(store.jobs().length,1);
  await designDispatch(store,'assisted_redesign',input);
  const after=JSON.parse(store.db.prepare('SELECT record FROM factory_operation WHERE id=?').get(proofId).record),current=getBatch(store,batch.id);
  assert.equal(current.policyHistory[0].fixture,'retained old policy history');
  assert.equal(current.policyHistory[1].previousPolicyDigest,'0'.repeat(64));
  assert.equal(after.policyHistory.at(-1).policyDigest,input.policyDigest);
  assert.deepEqual(after.policyFiles,current.policyFiles);
  assert.equal(after.siteJobId,before.siteJobId);assert.deepEqual(after.scope,before.scope);assert.deepEqual(after.usage,before.usage);
  assert.deepEqual(current.usage,batch.usage);assert.equal(current.createdAt,batch.createdAt);assert.equal(current.deadlineAt,batch.deadlineAt);
});
test('changed batch binding rolls back the receipt and policy adoption atomically', async t => {
  const {store,parent,batch}=await fixture(t),{designDispatch}=await api(),input=await request(store,parent);
  saveBatch(store,{...batch,members:batch.members.map(m=>({...m,evidenceDigest:'0'.repeat(64)}))});
  const before=store.db.prepare("SELECT record FROM factory_operation WHERE kind='assisted_proof'").get().record;
  await assert.rejects(designDispatch(store,'assisted_redesign',input),{code:'BATCH_ASSISTED_BINDING'});
  assert.equal(store.db.prepare("SELECT record FROM factory_operation WHERE kind='assisted_proof'").get().record,before);
  assert.equal(store.db.prepare("SELECT count(*) n FROM factory_operation WHERE kind='assisted_revision'").get().n,0);
  assert.equal(store.jobs().length,1);
});
async function unpackagedParent(store,parent,{register=true,pass=true}={}) {
  const base=workRelative(parent),siteRelative=`${base}/proposal-2/site`,qaRelative=`${base}/qa-2`,siteHashes={'index.html':hash(Buffer.from('<h1>Rejected fixture</h1>'))};
  await mkdir(path.join(store.stateRoot,siteRelative),{recursive:true});
  await writeFile(path.join(store.stateRoot,siteRelative,'index.html'),'<h1>Rejected fixture</h1>');
  await mkdir(path.join(store.stateRoot,qaRelative),{recursive:true});
  const bytes=Buffer.from(JSON.stringify({pass,siteHashes,siteDigest:hash(siteHashes)}));
  await writeFile(path.join(store.stateRoot,qaRelative,'results.json'),bytes);
  if(register)store.artifact({jobId:parent.id,relative:`${qaRelative}/results.json`,kind:'qa',sha256:hash(bytes),bytes:bytes.length});
  return store.updateJob(parent.id,{outputs:{...parent.outputs,siteDigest:null,siteRelative,qaRelative}});
}
test('unpackaged held parent derives exact digest from registered passing QA without backfill', async t => {
  const {store,parent}=await fixture(t),held=await unpackagedParent(store,parent),{designDispatch,readDesignContent}=await api();
  const before=store.db.prepare('SELECT total_changes() n').get().n;
  const c=await designDispatch(store,'design_context_get',{id:held.id});
  assert.equal(c.siteDigest,parent.outputs.siteDigest);assert.equal(c.assessment.ready,true);
  assert.equal(store.db.prepare('SELECT total_changes() n').get().n,before);
  const input=await request(store,held),{job}=await designDispatch(store,'assisted_redesign',input);
  assert.equal(job.input.parentSiteDigest,c.siteDigest);assert.equal(store.claim(job.id).state,'running');
  assert.equal(readDesignContent(store,job).facts.length,input.contentFacts.length);
  assert.deepEqual(store.job(held.id),held);assert.equal(store.job(held.id).outputs.siteDigest,null);
  await writeFile(path.join(store.stateRoot,held.outputs.qaRelative,'results.json'),'changed QA bytes');
  assert.throws(()=>readDesignContent(store,job),{code:'BATCH_ASSISTED_BINDING'});
});
test('missing digest never adopts a blind tree hash, unregistered QA or failed QA', async t => {
  for(const options of [{register:false},{pass:false}]){
    const {store,parent}=await fixture(t),held=await unpackagedParent(store,parent,options),{designDispatch}=await api();
    await assert.rejects(designDispatch(store,'design_context_get',{id:held.id}),{code:'BATCH_ASSISTED_BINDING'});
    assert.equal(store.job(held.id).outputs.siteDigest,null);
  }
});
test('captured Booksy tracking is stripped only for public facts and unknown query remains unsupported', async t => {
  const {store,parent}=await fixture(t),{readAssistedEvidence,availableDesignFacts}=await import('../src/assisted-evidence.mjs');
  const v=readAssistedEvidence(store,parent.input.assistedIntake),o=v.evidence.observations[1],canonical=o.finalUrl;
  o.url='https://juniper.booksy.com/a';o.finalUrl=canonical+'?do=invite&_branch_match_id=123456&utm_medium=profile&_branch_referrer=YWJjZA%3D%3D';
  v.candidate.websiteCheck.linkChecks.find(l=>l.sourceId===o.id).url=o.url;
  v.evidence.observations[0].links=[{url:o.url,text:'Book appointment'}];
  const original=JSON.stringify(v),facts=availableDesignFacts(v).filter(f=>f.sourceId===o.id);
  assert(facts.length>0);assert(facts.every(f=>f.sourceUrl===canonical));assert.equal(JSON.stringify(v),original);
  o.finalUrl+='&redirect=https%3A%2F%2Felsewhere.example';
  assert.equal(availableDesignFacts(v).some(f=>f.sourceId===o.id),false);
});
test('published Facebook booking wrapper unwraps exactly once, not nested or ambiguous wrappers', async t => {
  const {store,parent}=await fixture(t),{readAssistedEvidence,availableDesignFacts}=await import('../src/assisted-evidence.mjs');
  const v=readAssistedEvidence(store,parent.input.assistedIntake),o=v.evidence.observations[1],social=v.evidence.observations[0];
  o.url='https://juniper.booksy.com/a';v.candidate.websiteCheck.linkChecks.find(l=>l.sourceId===o.id).url=o.url;
  const wrapper='https://l.facebook.com/l.php?u='+encodeURIComponent(o.url)+'&h=observed-wrapper-metadata';
  social.links=[{url:wrapper,text:'Book appointment'}];
  assert(availableDesignFacts(v).some(f=>f.sourceId===o.id));
  for(const url of ['https://l.facebook.com/l.php?u='+encodeURIComponent(wrapper),wrapper+'&u='+encodeURIComponent(o.url)]){
    social.links=[{url,text:'Book appointment'}];assert.equal(availableDesignFacts(v).some(f=>f.sourceId===o.id),false);
  }
});
