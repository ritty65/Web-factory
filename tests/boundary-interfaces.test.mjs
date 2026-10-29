import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {initialize,openStore} from '../src/db.mjs';
import {createService,OPERATIONS} from '../src/service.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('boundary setup shares strict catalogs and local status cannot launch sources or seeds',async t=>{
  assert.equal(OPERATIONS.source_boundary_status?.readOnly,true);
  assert.equal(OPERATIONS.source_boundary_prepare?.readOnly,false);
  const root=await mkdtemp('/tmp/factory-boundary-interfaces-'),options={dbPath:path.join(root,'db.sqlite'),stateRoot:path.join(root,'state'),autoRun:false};
  await initialize(options);const store=openStore(options);t.after(()=>{store.close();return rm(root,{recursive:true,force:true});});
  let calls=0;const service=createService(store,{...options,seedCollector:async()=>{calls++;throw Error('Must not collect');}});
  const before=store.db.prepare('SELECT total_changes() n').get().n;
  const status=await service.dispatch('source_boundary_status',{});assert.equal(status.ready,false);
  for(const input of [{requestId:'unauthorized'},{requestId:'unauthorized',authorized:true,timeout:999999},{requestId:'unauthorized',authorized:true,area:'Elsewhere'}])await assert.rejects(service.dispatch('source_boundary_prepare',input),e=>e.code==='INVALID_INPUT');
  assert.equal(store.db.prepare('SELECT total_changes() n').get().n,before);
  const settings={area:'Houston city limits',niche:'Mobile auto detailers, custom bakers and event decorators; photo-rich independent no-site businesses',targetCount:1,candidateLimit:6,maxResearchRounds:2,searchProvider:'firecrawl',maxSearches:16,discoverySearchLimit:6,maxInspections:48,maxImageViews:12,maxModelRequests:16,batchMinutes:90,jobMinutes:45,workflow:'leads_first'};
  await service.dispatch('batch_preset_save',{version:0,requestId:'boundary-setup-fixture',settings,acknowledged:true});
  const afterSetup=store.db.prepare('SELECT total_changes() n').get().n;
  await assert.rejects(service.dispatch('seed_prepare',{presetVersion:1,requestId:'boundary-blocked-seeds',authorized:true}),e=>e.code==='BOUNDARY_NOT_READY');
  assert.equal(calls,0);assert.equal(store.db.prepare('SELECT total_changes() n').get().n,afterSetup);
  assert.equal(store.jobs().length,0);assert.equal(store.campaigns().length,0);
  const client=new Client({name:'boundary-catalog-fixture',version:'1'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['src/mcp.mjs'],env:{PATH:'',FACTORY_DB:options.dbPath,FACTORY_STATE:options.stateRoot,FACTORY_AUTORUN:'0'},stderr:'pipe'}));
    const tools=(await client.listTools()).tools;
    assert.equal(tools.find(v=>v.name==='source_boundary_status')?.annotations.readOnlyHint,true);
    assert.equal(tools.find(v=>v.name==='source_boundary_prepare')?.annotations.readOnlyHint,false);
    assert.equal((await client.callTool({name:'source_boundary_status',arguments:{}})).structuredContent.ready,false);
    assert.equal((await client.callTool({name:'source_boundary_prepare',arguments:{}})).isError,true);
  }finally{await client.close();}
});
