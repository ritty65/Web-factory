import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {executeJob} from '../src/worker.mjs';
import {batchSettings,intakeFixture} from './helpers-batch.mjs';
import {hash} from '../src/contracts.mjs';
const exec=promisify(execFile);

test('ordinary service/native-launcher/MCP path reaches exact selection, full intake and one site queue with fixture-only model/source data',async()=>{
  const root=await mkdtemp('/tmp/factory-check-flow-'),bin=path.join(root,'bin');await mkdir(bin);
   const moduleUrl=name=>new URL('../'+name,import.meta.url).href;
   const sourceScript=`import {mock} from 'node:test';import {writeFile} from 'node:fs/promises';import path from 'node:path';
     import {hash,now} from ${JSON.stringify(moduleUrl('src/contracts.mjs'))};
     const module=${JSON.stringify(moduleUrl('src/search.mjs'))},actual=await import(module);
     mock.module(module,{namedExports:{...actual,searchPublic:async(query,{directory,provider,intent})=>{
       const result={query,provider,intent,status:'completed',at:now(),results:[{url:'https://fixture.example/',title:'Houston Synthetic independent workshops'}]};
       await writeFile(path.join(directory,'search-'+hash({query,intent}).slice(0,16)+'.json'),JSON.stringify(result));return result;
     }}});await import(${JSON.stringify(moduleUrl('src/sources-mcp.mjs'))});`;
  await writeFile(path.join(bin,'opencode'),`#!${process.execPath}
const args=process.argv.slice(2),http=require('node:http'),fs=require('node:fs');
if(args[0]==='serve'){
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{name:'sources',status:{status:'connected'}}]}));});
 server.listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1');process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
}else{(async()=>{
 const {Client}=await import(${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))});
 const {StdioClientTransport}=await import(${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js'))});
 const output=JSON.parse(fs.readFileSync(process.env.FACTORY_SOURCES+'/fixture-output.json','utf8'));
 const client=new Client({name:'synthetic-native-model',version:'1.0.0'});
 try{
   await client.connect(new StdioClientTransport({command:${JSON.stringify(process.execPath)},args:['--experimental-test-module-mocks','--input-type=module','--eval',${JSON.stringify(sourceScript)}],env:process.env,stderr:'ignore'}));
   if((await client.listTools()).tools.some(t=>t.name==='scout')){
     const searched=await client.callTool({name:'scout',arguments:{output:{candidates:[]}}});if(searched.structuredContent.status!=='searched')throw new Error('Synthetic planned search failed');
     const scouted=await client.callTool({name:'scout',arguments:{output}});if(scouted.structuredContent.status!=='ready_to_finalize')throw new Error('Synthetic material/source scout failed');
   }
  const bad=structuredClone(output);bad.candidates[0].contactSources.website=bad.candidates[0].sourceUrls[0];
  const first=await client.callTool({name:'check_research',arguments:{output:bad}});if(first.structuredContent.valid!==false)throw new Error('Malformed field passed');
  const second=await client.callTool({name:'check_research',arguments:{output}});if(second.structuredContent.valid!==true)throw new Error(JSON.stringify(second));
  fs.appendFileSync(${JSON.stringify(path.join(root,'native-fixture-launches'))},JSON.stringify({model:args[args.indexOf('--model')+1],firstValid:false,secondValid:true,requestId:process.env.FACTORY_RESEARCH_REQUEST})+'\\n');
  console.log(JSON.stringify({type:'tool_use',part:{tool:'sources_check_research',state:{status:'completed'}}}));
  console.log(JSON.stringify({type:'text',sessionID:'synthetic-native-only',part:{text:JSON.stringify(output)}}));
 }finally{await client.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});}
`,{mode:0o700});
  const script=`
import assert from 'node:assert/strict';import path from 'node:path';import {mkdir,writeFile} from 'node:fs/promises';
import {initialize,openStore} from ${JSON.stringify(moduleUrl('src/db.mjs'))};import {createService} from ${JSON.stringify(moduleUrl('src/service.mjs'))};
import {executeJob} from ${JSON.stringify(moduleUrl('src/worker.mjs'))};import {reconcileBatches} from ${JSON.stringify(moduleUrl('src/batches.mjs'))};
import {discover} from ${JSON.stringify(moduleUrl('src/research.mjs'))};import {hash} from ${JSON.stringify(moduleUrl('src/contracts.mjs'))};
import {intakeFixture,batchSettings} from ${JSON.stringify(new URL('./helpers-batch.mjs',import.meta.url).href)};
const options={dbPath:${JSON.stringify(path.join(root,'fixture.sqlite3'))},stateRoot:${JSON.stringify(path.join(root,'state'))},autoRun:false,batchPrerequisites:async()=>({ready:true})};
await initialize(options);const store=openStore(options),service=createService(store,options);
try{
 await service.dispatch('batch_preset_save',{version:0,requestId:'full-check-setup1',acknowledged:true,settings:{...batchSettings,workflow:'leads_first',targetCount:1,candidateLimit:3,maxResearchRounds:1,discoverySearchLimit:6}});
 const batch=await service.dispatch('batch_start',{presetVersion:1,requestId:'full-check-start1',authorized:true});
 const adapter=async(campaign,ctx)=>{
  const f=intakeFixture(41),directory=path.join(ctx.jobRoot,'sources');await mkdir(directory,{recursive:true});
   if(!ctx.recheck){delete f.candidate.pagePurposes;f.candidate.websiteCheck={status:'unknown',queries:[],checkedAt:new Date().toISOString()};}
  for(const o of f.observations)await writeFile(path.join(directory,o.id+'.json'),JSON.stringify(o));
  for(const s of f.searches)await writeFile(path.join(directory,'search-'+hash(s.query).slice(0,16)+'.json'),JSON.stringify({...s,provider:'guest_bing'}));
  if(ctx.recheck)for(const v of f.imageViews)await writeFile(path.join(directory,'image-view-'+hash(v).slice(0,16)+'.json'),JSON.stringify(v));
  await writeFile(path.join(directory,'fixture-output.json'),JSON.stringify({candidates:[f.candidate],shortfall:'SYNTHETIC TEST DATA ONLY; no real business or production model.'}));
  return discover(campaign,ctx);
 };
 const first=await executeJob(store,batch.researchJobIds[0],{discover:adapter});assert.equal(first.state,'review_ready',first.message);await reconcileBatches(store);
 const list=await service.dispatch('lead_list',{batchId:batch.id});assert.equal(list.items.length,1);assert.equal(list.items[0].canSelect,true);assert.equal(list.items[0].ready,false);assert.equal(store.jobs().filter(j=>j.kind==='site').length,0);
 const selected=await service.dispatch('batch_build_selected',{id:batch.id,candidateId:list.items[0].id,evidenceDigest:list.items[0].evidenceDigest,requestId:'full-check-select1',authorized:true});
 const enriched=await executeJob(store,selected.job.id,{discover:adapter});assert.equal(enriched.state,'review_ready',enriched.message);assert.equal(enriched.outputs.intake[0].ready,true,enriched.outputs.intake[0].reasons.join('; '));await reconcileBatches(store);
 const sites=store.jobs().filter(j=>j.kind==='site');assert.equal(sites.length,1);assert.equal(sites[0].input.candidateId,list.items[0].id);assert.equal(store.candidate(list.items[0].id).states.humanAcceptance,'pending');
   const detail=await service.dispatch('batch_get',{id:batch.id});assert.equal(detail.batch.usage.modelRequests,2);assert.equal(detail.batch.checkpoint,null);assert.deepEqual(detail.batch.usage,{modelRequests:2,searches:1,inspections:0,imageViews:0});
 await service.dispatch('batch_stop',{id:batch.id});assert.equal(store.job(sites[0].id).state,'cancelled');
 console.log(JSON.stringify({temporaryFixtureRoot:${JSON.stringify(root)},savedProspects:1,fullIntakeReady:1,siteQueueCount:1,nativeFixtureInvocations:2,realModelCalls:0,realSourceCalls:0,generatedSites:0,acceptance:null,finalState:'stopped'}));
}finally{store.close();}
`;
  const {stdout}=await exec(process.execPath,['--input-type=module','--eval',script],{env:{PATH:bin,HOME:root},timeout:25000});
  const result=JSON.parse(stdout);assert.equal(result.siteQueueCount,1);assert.equal(result.realModelCalls,0);
  const launches=(await readFile(path.join(root,'native-fixture-launches'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(launches.length,2);assert.ok(launches.every(l=>l.model==='openai/gpt-6.1-sol-fast'&&!l.firstValid&&l.secondValid));
  console.log('Checked full workflow fixture evidence: '+root);
});

test('cached native stage with adequate sources but no checked submission still cannot import on a resumed worker',async t=>{
  const root=await mkdtemp('/tmp/factory-check-resume-'),options={dbPath:path.join(root,'fixture.sqlite3'),stateRoot:path.join(root,'state'),autoRun:false,batchPrerequisites:async()=>({ready:true})};await initialize(options);const store=openStore(options);t.after(()=>store.close());const service=createService(store,options);
  await service.dispatch('batch_preset_save',{version:0,requestId:'check-resume-setup',settings:batchSettings,acknowledged:true});const b=await service.dispatch('batch_start',{presetVersion:1,requestId:'check-resume-start',authorized:true}),job=store.job(b.researchJobIds[0]);
  const first=await executeJob(store,job.id,{discover:async(_,ctx)=>{
    const f=intakeFixture(),directory=path.join(ctx.jobRoot,'sources');await mkdir(directory,{recursive:true});
    for(const o of f.observations)await writeFile(path.join(directory,o.id+'.json'),JSON.stringify(o));
    for(const s of f.searches)await writeFile(path.join(directory,'search-'+hash(s.query).slice(0,16)+'.json'),JSON.stringify({...s,provider:'guest_bing'}));
    return {candidates:[f.candidate],live:true,shortfall:'Synthetic cached native claim without a submission receipt'};
  }});assert.equal(first.errorCode,'RESEARCH_CHECK_MISSING');assert.equal(store.candidates().length,0);
  store.updateJob(job.id,{state:'queued',ownerPid:null});const resumed=await executeJob(store,job.id,{discover:()=>{throw new Error('The retained stage must be used, not a new source/model call');}});
  assert.equal(resumed.errorCode,'RESEARCH_CHECK_MISSING');assert.equal(store.candidates().length,0);assert.equal(store.jobs().length,1);assert.ok(store.events(job.id).some(e=>e.type==='stage.resumed'));
});
