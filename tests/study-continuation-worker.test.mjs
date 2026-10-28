import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistedFixture, assistedStore } from './helpers-assisted.mjs';
import { assistedDispatch } from '../src/assisted.mjs';
import { studyContinuation } from '../src/study-continuation.mjs';
import { policyIdentity } from '../src/policy.mjs';
import { hash, workRelative } from '../src/contracts.mjs';
import { getBatch, saveBatch } from '../src/batch-store.mjs';

const modes=['valid','missing-receipt','wrong-job','wrong-input','wrong-attempt','wrong-deadline','wrong-render','current-policy-drift','forged-job-policy','mid-prefix-tamper','mid-suppression'];
if (!process.env.STUDY_WORKER_FIXTURE_MODE) {
  for (const mode of modes) test(`actual worker continuation ${mode}`, () => {
    const env={...process.env,STUDY_WORKER_FIXTURE_MODE:mode};delete env.NODE_TEST_CONTEXT;
    const child=spawnSync(process.execPath,['--experimental-test-module-mocks','--test',fileURLToPath(import.meta.url)],{env,encoding:'utf8',timeout:20000});
    assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
    assert.match(child.stdout,/tests 1/);
  });
} else test('actual worker cached-prefix boundary with synthetic external evidence only', async t => {
  const mode=process.env.STUDY_WORKER_FIXTURE_MODE, store=await assistedStore(t), f=await assistedFixture();
  f.usage.modelRequests=2;
  const saved=await assistedDispatch(store,'assisted_save',f), policy=await policyIdentity('production');
  const {job,batch}=await assistedDispatch(store,'assisted_build',{id:saved.id,bundleDigest:saved.bundleDigest,evidenceDigest:saved.evidenceDigest,policyDigest:policy.digest,requestId:'build-worker-fixture',authorized:true});
  const root=path.join(store.stateRoot,workRelative(job)), oldPolicy='d'.repeat(64);
  await mkdir(path.join(root,'directions'),{recursive:true});
  const rendered={pass:false,studies:[],captures:[]};
  for(let index=0;index<3;index++){
    const relative=`directions/study-${index}/site`,html=`Synthetic worker study ${index}`;
    await mkdir(path.join(root,relative),{recursive:true});await writeFile(path.join(root,relative,'index.html'),html);
    rendered.studies.push({index,relative,siteDigest:hash({'index.html':hash(html)}),pass:index<2,viewports:index<2?[1280,390].map(w=>({viewport:[w,720],pass:true})):[]});
    if(index<2)for(const w of [1280,390]){
      const relative=`directions/study-${index}-${w}.png`,bytes=Buffer.from(`Synthetic capture ${index}/${w}`);
      await writeFile(path.join(root,relative),bytes);rendered.captures.push({index,relative,viewport:[w,720]});
      store.artifact({jobId:job.id,relative:`${workRelative(job)}/${relative}`,sha256:hash(bytes)});
    }
  }
  const stages={qualification:store.candidate(job.input.candidateId),media:[],brief:{synthetic:true},directions:[0,1,2],'directions-render':rendered}, before={};
  let dependency=hash({dependency:hash({jobId:job.id,input:job.input,attempt:job.attempt,campaign:store.campaign(job.campaignId)}),policy:oldPolicy});
  for(const [name,value]of Object.entries(stages)){
    const bytes=Buffer.from(JSON.stringify({dependency,value,sha256:hash(value)}));
    await writeFile(path.join(root,`checkpoint-${name}.json`),bytes);before[name]=bytes;dependency=hash(value);
  }
  const renderBytes=Buffer.from(JSON.stringify(rendered));await writeFile(path.join(root,'directions/results.json'),renderBytes);
  store.artifact({jobId:job.id,relative:`${workRelative(job)}/directions/results.json`,sha256:hash(renderBytes)});
  store.updateJob(job.id,{state:'blocked',stage:'directions-render',errorCode:'DESIGN_STUDY_QA',deadlineAt:new Date(Date.now()+3600000).toISOString()});
  saveBatch(store,{...batch,state:'held',policyDigest:oldPolicy});
  const continued=await studyContinuation(store,{id:job.id,renderDigest:hash(renderBytes),policyDigest:policy.digest,requestId:'continue-worker-fixture',authorized:true});
  const receiptId=continued.job.studyContinuation.receiptId;
  let receipt=JSON.parse(store.db.prepare('SELECT record FROM factory_operation WHERE id=?').get(receiptId).record);
  if(mode==='missing-receipt')store.db.prepare('DELETE FROM factory_operation WHERE id=?').run(receiptId);
  if(mode==='wrong-job')receipt.jobId='job-foreign-fixture';
  if(mode==='wrong-input')store.updateJob(job.id,{input:{...job.input,feedback:'Replaced caller input'}});
  if(mode==='forged-job-policy')store.updateJob(job.id,{studyContinuation:{...continued.job.studyContinuation,originalPolicyDigest:'e'.repeat(64)}});
  if(mode==='wrong-attempt')receipt.failedJob.attempt=1;
  if(mode==='wrong-deadline')receipt.failedJob.deadlineAt=new Date(Date.now()+60000).toISOString();
  if(mode==='wrong-render')receipt.renderDigest='0'.repeat(64);
  if(mode==='current-policy-drift')receipt.policyDigest='0'.repeat(64);
  if(mode!=='missing-receipt')store.db.prepare('UPDATE factory_operation SET record=? WHERE id=?').run(JSON.stringify(receipt),receiptId);
  let prefixRegenerated=0,selections=0;
  // Only the production boundary is substituted. executeJob, its stage/cache
  // implementation, SQLite claim, batch guards and all assisted hashes are real.
  mock.module(new URL('../src/production.mjs',import.meta.url).href,{namedExports:{produceSite:async({stage})=>{
    for(const name of Object.keys(stages)){
      await stage(name,async()=>{prefixRegenerated++;throw Error('Cached prefix regenerated');});
      if(name==='qualification'&&mode==='mid-prefix-tamper'){
        before.brief=Buffer.concat([before.brief,Buffer.from(' ')]);
        await writeFile(path.join(root,'checkpoint-brief.json'),before.brief);
      }
      if(name==='qualification'&&mode==='mid-suppression')store.db.prepare('INSERT INTO factory_sales_case VALUES(?,?,?)').run('case-mid-suppressed',job.input.candidateId,JSON.stringify({suppressed:true}));
    }
    return stage('selection',async()=>{selections++;throw Object.assign(Error('Synthetic new selection reached; no model/source call'),{code:'TEST_SELECTION_REACHED'});});
  }}});
  const {executeJob}=await import('../src/worker.mjs');
  const result=await executeJob(store,job.id);
  assert.equal(result.errorCode,mode==='valid'?'TEST_SELECTION_REACHED':mode==='mid-suppression'?'BATCH_SUPPRESSED':'STUDY_CONTINUATION_BINDING');
  assert.equal(prefixRegenerated,0);assert.equal(selections,mode==='valid'?1:0);
  assert.deepEqual(getBatch(store,batch.id).usage,f.usage);
  assert.equal(result.attempt,0);assert.equal(result.deadlineAt,continued.job.deadlineAt);
  for(const name of Object.keys(stages))assert.deepEqual(await readFile(path.join(root,`checkpoint-${name}.json`)),before[name]);
  if(mode==='valid')assert.deepEqual(store.events(job.id).filter(e=>e.type==='stage.resumed').map(e=>e.message),Object.keys(stages).map(name=>`Reused completed ${name} checkpoint`));
});
