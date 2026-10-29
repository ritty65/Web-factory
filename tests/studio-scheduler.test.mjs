import test from 'node:test';import assert from 'node:assert/strict';import {setTimeout as delay} from 'node:timers/promises';
import {apiFixture} from './helpers-studio.mjs';import {createService} from '../src/service.mjs';import {startServer} from '../src/server.mjs';
test('the persistent server picks up externally queued owned jobs without running paid discovery at startup',async t=>{
 const {store}=await apiFixture(t),service=createService(store,{autoRun:true}),app=await startServer(service,{port:0,previewPort:0});t.after(()=>app.close());assert.equal(store.jobs().length,0);
 const campaign=store.createCampaign({name:'External queue fixture',query:'fixture',area:'Houston',niche:'Fixture'}),job=store.createJob({campaignId:campaign.id,kind:'site',input:{apiConcept:{proofId:'api-proof-forged',digest:'0'.repeat(64)},modelSelection:'api/deepseek-first'}});
 for(let n=0;n<100&&!['blocked','failed'].includes(store.job(job.id).state);n++)await delay(100);
 assert.equal(store.job(job.id).state,'blocked');assert.equal(store.job(job.id).errorCode,'API_CONCEPT_BINDING');assert.equal(store.db.prepare("SELECT count(*) n FROM factory_operation WHERE kind='studio_spend'").get().n,0);
});
