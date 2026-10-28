import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {initialize,openStore} from '../src/db.mjs';
import {createService,OPERATIONS} from '../src/service.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {spawnSync} from 'node:child_process';

test('seed source operations share strict CLI/MCP/service gates without starting work',async t=>{
  assert.equal(OPERATIONS.seed_prepare?.readOnly,false);
  assert.equal(OPERATIONS.seed_get?.readOnly,true);
  const root=await mkdtemp('/tmp/factory-seed-interfaces-');
  const options={dbPath:path.join(root,'db.sqlite3'),stateRoot:path.join(root,'state'),autoRun:false};
  await initialize(options);const store=openStore(options);
  t.after(()=>{store.close();return rm(root,{recursive:true,force:true});});
  const service=createService(store,options);
  const before=store.db.prepare('SELECT total_changes() n').get().n;
  for(const input of [{presetVersion:0,requestId:'unapproved'},{presetVersion:0,requestId:'unapproved',authorized:true,url:'https://example.com/'},{presetVersion:0,requestId:'unapproved',authorized:true,limit:100}])
    await assert.rejects(service.dispatch('seed_prepare',input),e=>e.code==='INVALID_INPUT');
  await assert.rejects(service.dispatch('seed_get',{id:'seed-nonexistent'}));
  assert.equal(store.db.prepare('SELECT total_changes() n').get().n,before);
  const env={PATH:'',FACTORY_DB:options.dbPath,FACTORY_STATE:options.stateRoot,FACTORY_AUTORUN:'0'};
  const cli=spawnSync(process.execPath,['src/cli.mjs','seed_prepare','{}'],{env,timeout:10000,encoding:'utf8'});
  assert.equal(cli.status,1);
  assert.match(String(cli.stderr||cli.message),/INVALID_INPUT|Unsupported|unexpected/i);
  const client=new Client({name:'seed-interface-fixture',version:'1'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['src/mcp.mjs'],env,stderr:'pipe'}));
    const tools=(await client.listTools()).tools;
    for(const [name,readOnly] of [['seed_prepare',false],['seed_get',true]]){
      const tool=tools.find(v=>v.name===name);assert.ok(tool,name);
      assert.equal(tool.annotations.readOnlyHint,readOnly);
      assert.equal(tool.inputSchema.additionalProperties,false);
    }
    assert.equal((await client.callTool({name:'seed_prepare',arguments:{}})).isError,true);
  }finally{await client.close();}
  assert.equal(store.jobs().length,0);assert.equal(store.campaigns().length,0);
});
