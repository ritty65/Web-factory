import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {executeJob} from '../src/worker.mjs';
import {reconcileBatches} from '../src/batches.mjs';
import {hash,workRelative} from '../src/contracts.mjs';
import {intakeFixture} from './helpers-batch.mjs';

test('registered synthetic seeds cross real source MCP then explicit selection and fresh intake to one site queue',async t=>{
  const root=await mkdtemp('/tmp/factory-seed-worker-');
  const evidence=intakeFixture(71),profile=evidence.observations[0].url;
  const options={dbPath:path.join(root,'fixture.sqlite'),stateRoot:path.join(root,'state'),autoRun:false,batchPrerequisites:async()=>({ready:true}),boundaryPreflight:()=>({release:'synthetic-release',divisionId:'fictional-division'}),seedCollector:async()=>({provider:'placeroot',retrievedAt:new Date().toISOString(),version:'synthetic-release',attribution:['Fictional source only'],limitations:['No real data'],items:[{id:'fictional-gers-worker',name:evidence.candidate.name,location:{city:'Houston'},categories:['bakery'],urls:[profile],provenance:{dataset:'fictional',license:'CC0-1.0'}}]})};
  await initialize(options);const store=openStore(options);t.after(()=>store.close());const service=createService(store,options);
  const settings={area:'Houston city limits',niche:'Mobile auto detailers, custom bakers and event decorators; photo-rich independent no-site businesses',targetCount:1,candidateLimit:6,maxResearchRounds:2,searchProvider:'firecrawl',maxSearches:16,discoverySearchLimit:6,maxInspections:48,maxImageViews:12,maxModelRequests:16,batchMinutes:90,jobMinutes:45,workflow:'leads_first'};
  await service.dispatch('batch_preset_save',{version:0,requestId:'seed-worker-setup',settings,acknowledged:true});
  const receipt=await service.dispatch('seed_prepare',{presetVersion:1,requestId:'seed-worker-cohort',authorized:true});
  const b=await service.dispatch('batch_start',{presetVersion:1,requestId:'seed-worker-start',authorized:true,seedReceipt:{id:receipt.id,digest:receipt.digest}});
  const job=store.job(b.researchJobIds[0]),directory=path.join(store.stateRoot,workRelative(job),'sources');await mkdir(directory,{recursive:true});
  // Fictional observation adapters in a REAL stdio MCP child; no external network/model.
  const script=`
    import {mock} from 'node:test';import {writeFile} from 'node:fs/promises';import path from 'node:path';
    import {hash,now} from ${JSON.stringify(new URL('../src/contracts.mjs',import.meta.url).href)};
    const s=${JSON.stringify(new URL('../src/search.mjs',import.meta.url).href)},search=await import(s);
    mock.module(s,{namedExports:{...search,searchPublic:async(query,{directory,provider,intent})=>{const r={query,provider,intent,status:'completed',at:now(),results:[{url:${JSON.stringify(profile)},title:${JSON.stringify(evidence.candidate.name+' Houston')}}]};await writeFile(path.join(directory,'search-'+hash({query,intent}).slice(0,16)+'.json'),JSON.stringify(r));return r;}}});
    const b=${JSON.stringify(new URL('../src/browser.mjs',import.meta.url).href)},browser=await import(b);
    mock.module(b,{namedExports:{...browser,inspectSource:async(url,{directory})=>{if(url!==${JSON.stringify(profile)})throw Error('Unexpected fictional route');const o=${JSON.stringify(evidence.observations[0])};o.inspectedAt=now();await writeFile(path.join(directory,o.id+'.json'),JSON.stringify(o));return o;}}});
    await import(${JSON.stringify(new URL('../src/sources-mcp.mjs',import.meta.url).href)});`;
  const client=new Client({name:'seed-worker-fixture',version:'1'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['--experimental-test-module-mocks','--input-type=module','--eval',script],env:{FACTORY_DB:options.dbPath,FACTORY_STATE:options.stateRoot,FACTORY_SOURCE_JOB:job.id,FACTORY_SOURCES:directory,FACTORY_RESEARCH_REQUEST:'e'.repeat(64),FACTORY_RESEARCH_LIMIT:'3'},stderr:'pipe'}));
    const first=await client.callTool({name:'scout',arguments:{output:{candidates:[]}}});assert.equal(first.structuredContent.status,'searched');
    assert.match(first.structuredContent.search.query, /Juniper 71 Upholstery/);
    const inspected=await client.callTool({name:'scout',arguments:{output:{candidates:[]}}});assert.equal(inspected.structuredContent.observation.url,profile);
    const output={candidates:[evidence.candidate],shortfall:'Synthetic transport integration only'};
    await client.callTool({name:'scout',arguments:{output}});
    const checked=await client.callTool({name:'check_research',arguments:{output}});assert.equal(checked.structuredContent.valid,true);
  }finally{await client.close();}
  const discover=async(_,context)=>{
    const dir=path.join(context.jobRoot,'sources');await mkdir(dir,{recursive:true});
    for(const o of evidence.observations)await writeFile(path.join(dir,o.id+'.json'),JSON.stringify({...o,inspectedAt:new Date().toISOString()}));
    for(const s of evidence.searches)await writeFile(path.join(dir,'search-'+hash(s.query).slice(0,16)+'.json'),JSON.stringify(s));
    for(const v of evidence.imageViews)await writeFile(path.join(dir,'image-view-'+hash(v).slice(0,16)+'.json'),JSON.stringify(v));
    return{candidates:[evidence.candidate],live:false,shortfall:'Synthetic worker adapter only; no actual business or site'};
  };
  const discovered=await executeJob(store,job.id,{discover});assert.equal(discovered.state,'review_ready',discovered.message);await reconcileBatches(store);
  let detail=await service.dispatch('batch_get',{id:b.id});assert.equal(detail.batch.state,'awaiting_selection');assert.equal(store.jobs().filter(j=>j.kind==='site').length,0);
  const item=detail.items[0];const selected=await service.dispatch('batch_build_selected',{id:b.id,candidateId:item.candidateId,evidenceDigest:item.evidenceDigest,requestId:'seed-worker-select',authorized:true});
  const enriched=await executeJob(store,selected.job.id,{discover});assert.equal(enriched.state,'review_ready',enriched.message);await reconcileBatches(store);
  const sites=store.jobs().filter(j=>j.kind==='site');assert.equal(sites.length,1);assert.equal(sites[0].input.candidateId,item.candidateId);assert.equal(sites[0].state,'queued');
  detail=await service.dispatch('batch_get',{id:b.id});assert.equal(detail.batch.seedCohort.digest,receipt.digest);assert.equal(detail.batch.checkpoint,null);
  assert.equal(detail.authority.humanDecision,null);assert.equal(detail.authority.publicRelease,false);assert.equal(detail.authority.contactAuthorized,false);
});
