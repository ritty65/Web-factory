import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {salesFixture} from './helpers-commercial.mjs';
import {stageProposal,treeHashes} from '../src/proposal.mjs';
import {packageReview} from '../src/package.mjs';
import {hash,now} from '../src/contracts.mjs';
import {executeJob} from '../src/worker.mjs';

export async function boundFixture(t){
  const f=await salesFixture(t),{store,campaign,lead,service}=f;const job=store.createJob({campaignId:campaign.id,kind:'site',input:{candidateId:lead.id}});
  const rel=`jobs/${job.id}/attempt-0`,base=path.join(store.stateRoot,rel),site=path.join(base,'proposal-0/site');
  const design={thesis:'Synthetic',comparisons:['A','B','C']};
  await stageProposal(site,{design,files:['index','offer','photos','visit','contact'].map(name=>({path:name+'.html',content:`<!doctype html><html><head><title>${name}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>${name} fixture</h1></main></body></html>`}))});
  const qa={pass:true,siteHashes:await treeHashes(site),issues:[],coverage:'Synthetic fixture only'};await mkdir(path.join(base,'qa-0'));await writeFile(path.join(base,'qa-0/results.json'),JSON.stringify(qa));
  const pack=await packageReview({siteRoot:site,outputRoot:path.join(base,'package'),candidate:lead,media:[],qa,design});
  const critiqueRelative=rel+'/visual-review.json',critiqueBytes=Buffer.from(JSON.stringify({siteDigest:pack.siteDigest,blockingDefects:[],humanDecision:null,reviewer:'Synthetic fixture only'}));await writeFile(path.join(base,'visual-review.json'),critiqueBytes);
  store.artifact({jobId:job.id,relative:critiqueRelative,kind:'critique',sha256:hash(critiqueBytes),bytes:critiqueBytes.length});
  const manifestBytes=await readFile(path.join(base,'package/manifest.json')),manifest=store.artifact({jobId:job.id,relative:rel+'/package/manifest.json',kind:'manifest',sha256:hash(manifestBytes),bytes:manifestBytes.length});
  store.updateJob(job.id,{state:'review_ready',outputs:{siteRelative:rel+'/proposal-0/site',siteDigest:pack.siteDigest,manifestId:manifest.id,qaRelative:rel+'/qa-0',packageRelative:rel+'/package',qaPass:true,critiqueRelative,craftVersion:2,reviewStatus:'operator_review_required',humanDecision:null,blockingDefects:[]}});
  const c=await service.dispatch('case_open',{candidateId:lead.id,siteJobId:job.id});return {...f,job:store.job(job.id),case:c,base};
}
test('handoff preparation binds exact archive and facts but never creates external-access or contact authority',async t=>{
  const f=await boundFixture(t),{service,case:c,job,store}=f;
  const other=store.saveCandidate(f.campaign.id,{...f.lead,name:'Different synthetic business'});
  await assert.rejects(service.dispatch('case_open',{candidateId:other.id,siteJobId:job.id}),e=>e.code==='CASE_SITE');
  const a=await service.dispatch('handoff_prepare',{id:c.id,siteDigest:job.outputs.siteDigest});
  const b=await service.dispatch('handoff_prepare',{id:c.id,siteDigest:job.outputs.siteDigest});assert.equal(a.id,b.id);assert.equal(a.intent,'operator_inspection_only');assert.equal(a.externalReviewUrl,null);assert.equal(a.contactAuthorized,false);
  const {bytes}=await service.artifact(a.artifactId);assert.equal(hash(bytes),a.sha256);
  const status=await service.dispatch('pilot_status',{});assert.equal(status.externalPilotReady,false);assert.equal(status.authority.outreach,'separate_approval_required');assert.equal(status.search.mode,'unverified','A generic fixture import does not certify the assisted live research route');
  await assert.rejects(service.dispatch('handoff_prepare',{id:c.id,siteDigest:'0'.repeat(64)}),e=>e.code==='STALE_REVIEW');
  await writeFile(path.join(store.stateRoot,job.outputs.siteRelative,'index.html'),'changed');
  await assert.rejects(service.dispatch('handoff_prepare',{id:c.id,siteDigest:job.outputs.siteDigest}),e=>e.code==='STALE_PROPOSAL');
});
test('suppressed/lost cases or real creative blockers cannot produce a handoff packet',async t=>{
  const {service,case:c,job,store}=await boundFixture(t);
  store.updateJob(job.id,{outputs:{...job.outputs,blockingDefects:['Actual fixture blocker']}});
  await assert.rejects(service.dispatch('handoff_prepare',{id:c.id,siteDigest:job.outputs.siteDigest}),e=>e.code==='HANDOFF_REVIEW');
  store.updateJob(job.id,{outputs:job.outputs});await service.dispatch('case_event',{id:c.id,requestId:'suppress-pilot-001',kind:'suppressed',note:'Fixture only',occurredAt:now()});
  await assert.rejects(service.dispatch('handoff_prepare',{id:c.id,siteDigest:job.outputs.siteDigest}),e=>e.code==='SUPPRESSED');
});
test('known-candidate search probes are bounded, idempotent and never import candidates or infer website absence',async t=>{
  const {service,lead,store}=await salesFixture(t);
  const job=await service.dispatch('research_probe',{candidateId:lead.id});assert.equal(job.id,(await service.dispatch('research_probe',{candidateId:lead.id})).id);
  const result=await executeJob(store,job.id,{searchProbe:async()=>({provider:'fixture',status:'completed',query:'Fixture exact match',results:[{url:'https://fixture.example/',title:'Synthetic fixture only'}],at:now()})});
  assert.equal(result.state,'review_ready');assert.equal(store.candidates().length,1);
  const status=await service.dispatch('pilot_status',{});assert.equal(status.search.probe.websiteAbsenceEstablished,false);assert.equal(status.search.probe.discoveryCertified,false);
  await assert.rejects(service.dispatch('research_probe',{candidateId:'lead-missing'}),e=>e.code==='NOT_FOUND');
});
test('handoff rejects changed QA metadata even when its site hash map still matches',async t=>{
  const {service,case:c,job,base}=await boundFixture(t),target=path.join(base,'qa-0/results.json');
  const qa=JSON.parse(await readFile(target,'utf8'));await writeFile(target,JSON.stringify({...qa,coverage:'Changed report is not the packaged QA'}));
  await assert.rejects(service.dispatch('handoff_prepare',{id:c.id,siteDigest:job.outputs.siteDigest}),e=>e.code==='STALE_PACKAGE');
});
test('handoff requires actual bound all-page critique, not only a passing output flag',async t=>{
  const {service,case:c,job,store,base}=await boundFixture(t);
  store.updateJob(job.id,{outputs:{...job.outputs,craftVersion:2,critiqueRelative:'jobs/'+job.id+'/attempt-0/missing-review.json'}});
  await assert.rejects(service.dispatch('handoff_prepare',{id:c.id,siteDigest:job.outputs.siteDigest}),e=>e.code==='HANDOFF_REVIEW');
});
test('failed stages retain measured elapsed time without inventing provider charges',async t=>{
  const {service,store,lead}=await salesFixture(t),j=await service.dispatch('research_probe',{candidateId:lead.id});
  await executeJob(store,j.id,{searchProbe:async()=>{throw Object.assign(new Error('Synthetic unavailable provider'),{code:'SEARCH_UNAVAILABLE'});}});
  const event=store.events(j.id).find(e=>e.type==='stage.failed');assert.ok(event);assert.ok(Number.isInteger(event.detail.elapsedMs));assert.equal(event.detail.providerCharge,'unknown_not_inferred_from_time');
  assert.equal(store.job(j.id).state,'blocked');
});
test('handoff rejects modified standalone provenance instead of trusting an unchanged archive checksum alone',async t=>{
  const {service,case:c,job,base}=await boundFixture(t),target=path.join(base,'package/manifest.json');
  const manifest=JSON.parse(await readFile(target,'utf8'));await writeFile(target,JSON.stringify({...manifest,media:[{sourceUrl:'https://unrelated.example/'}]}));
  await assert.rejects(service.dispatch('handoff_prepare',{id:c.id,siteDigest:job.outputs.siteDigest}),e=>e.code==='STALE_PACKAGE');
});
test('a concurrent opt-out during packet preparation wins before any handoff is registered',async t=>{
  const {service,case:c,job,store}=await boundFixture(t),preparing=service.dispatch('handoff_prepare',{id:c.id,siteDigest:job.outputs.siteDigest});
  await service.dispatch('case_event',{id:c.id,requestId:'concurrent-optout',kind:'suppressed',note:'Synthetic concurrent opt-out',occurredAt:now()});
  await assert.rejects(preparing,e=>e.code==='SUPPRESSED');assert.equal(store.db.prepare("SELECT count(*) n FROM factory_operation WHERE kind='handoff'").get().n,0);
});
test('checkpoint resumption preserves the measured duration without recounting completed adapter work',async t=>{
  const {service,store,lead}=await salesFixture(t),j=await service.dispatch('research_probe',{candidateId:lead.id});let calls=0;
  const adapters={searchProbe:async()=>{calls++;return {provider:'fixture',status:'completed',results:[],at:now()};}};
  await executeJob(store,j.id,adapters);
  const before=await readFile(path.join(store.stateRoot,`jobs/${j.id}/attempt-0/checkpoint-probe.json`));
  // Simulate recovery after a durable checkpoint but before terminal-state promotion.
  store.updateJob(j.id,{state:'queued',ownerPid:null});await executeJob(store,j.id,adapters);
  assert.equal(calls,1);assert.equal(hash(await readFile(path.join(store.stateRoot,`jobs/${j.id}/attempt-0/checkpoint-probe.json`))),hash(before));
  assert.equal(store.events(j.id).filter(e=>e.type==='stage.completed').length,1);assert.equal(store.events(j.id).filter(e=>e.type==='stage.resumed').length,1);
});
