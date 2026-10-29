import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {workRelative,hash} from '../src/contracts.mjs';
import {batchSettings,intakeFixture} from './helpers-batch.mjs';
import {assertResearchChecked} from '../src/research-check.mjs';
import {getBatch,saveBatch} from '../src/batch-store.mjs';

async function fixture(t){
  const root=await mkdtemp('/tmp/factory-check-mcp-'),options={dbPath:path.join(root,'fixture.sqlite3'),stateRoot:path.join(root,'state'),autoRun:false,batchPrerequisites:async()=>({ready:true})};
  await initialize(options);const store=openStore(options),service=createService(store,options);t.after(()=>store.close());
  await service.dispatch('batch_preset_save',{version:0,requestId:'check-mcp-setup1',settings:{...batchSettings,workflow:'leads_first',targetCount:1,candidateLimit:3,maxResearchRounds:1,discoverySearchLimit:6},acknowledged:true});
   const b=await service.dispatch('batch_start',{presetVersion:1,requestId:'check-mcp-start1',authorized:true});
   // This test isolates the historical data-only checker contract. The new scoped
   // checker and real scout registration are covered in scout-mcp.test.mjs.
   const historical=getBatch(store,b.id);delete historical.acquisition;saveBatch(store,historical);
   const job=store.claim(b.researchJobIds[0]);
  const directory=path.join(store.stateRoot,workRelative(job),'sources');await mkdir(directory,{recursive:true});
  const requestId='c'.repeat(64),env={PATH:path.dirname(process.execPath),HOME:root,FACTORY_SOURCES:directory,FACTORY_DB:store.dbPath,FACTORY_STATE:store.stateRoot,FACTORY_SOURCE_JOB:job.id,FACTORY_RESEARCH_REQUEST:requestId,FACTORY_RESEARCH_LIMIT:'3'};
  async function connect(extra={}){
    const client=new Client({name:'fixture-research-check',version:'1.0.0'}),transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('src/sources-mcp.mjs')],env:{...env,...extra},stderr:'ignore'});
    await client.connect(transport);t.after(()=>client.close());return client;
  }
  return {store,service,b,job,directory,requestId,connect};
}
test('actual stdio tool catches malformed data, permits one same-request correction, and never spends or imports',async t=>{
  const f=await fixture(t),client=await f.connect(),tools=(await client.listTools()).tools;
  assert.equal(tools.filter(x=>x.name==='check_research').length,1);
  const output={candidates:[intakeFixture().candidate],shortfall:'Synthetic only'},bad=structuredClone(output);bad.candidates[0].contactSources.website=bad.candidates[0].sourceUrls[0];
  const before=hash(f.store.db.prepare('SELECT * FROM factory_operation ORDER BY id').all());
  const first=await client.callTool({name:'check_research',arguments:{output:bad}});assert.equal(first.structuredContent.valid,false);assert.equal(first.structuredContent.checksRemaining,1);
  const second=await client.callTool({name:'check_research',arguments:{output}});assert.equal(second.structuredContent.valid,true);assert.equal(second.structuredContent.feedback[0].intakeReady,false);
  await assertResearchChecked({...f,candidateLimit:3,output});
  assert.equal(f.store.candidates().length,0);assert.equal(f.store.jobs().length,1);assert.equal(hash(f.store.db.prepare('SELECT * FROM factory_operation ORDER BY id').all()),before);
  await client.close();const reconnected=await f.connect();const third=await reconnected.callTool({name:'check_research',arguments:{output}});assert.equal(third.isError,true);assert.match(JSON.stringify(third),/RESEARCH_CHECK_CAP/);
  assert.equal((await readdir(f.directory)).length,2,'MCP restart cannot reset the two-check cap or create source evidence');
  await f.service.dispatch('batch_stop',{id:f.b.id});const stopped=await reconnected.callTool({name:'check_research',arguments:{output}});assert.equal(stopped.isError,true);assert.match(JSON.stringify(stopped),/BATCH_STOPPED/);
  assert.equal((await readdir(f.directory)).length,2);assert.deepEqual(getBatch(f.store,f.b.id).usage,{modelRequests:0,searches:0,inspections:0,imageViews:0});
});
test('native checker cannot widen its host job candidate limit through an environment override',async t=>{
  const f=await fixture(t);await assert.rejects(f.connect({FACTORY_RESEARCH_LIMIT:'40'}));assert.equal(f.store.candidates().length,0);assert.equal((await readdir(f.directory)).length,0);
});
