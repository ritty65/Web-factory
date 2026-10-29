import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readIntakeEvidence} from '../src/intake.mjs';
import {assertResearchChecked} from '../src/research-check.mjs';
import {assertScoutWorkflow} from '../src/scout.mjs';
import {executeJob} from '../src/worker.mjs';
import {reconcileBatches} from '../src/batches.mjs';
import {hash,workRelative} from '../src/contracts.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {getBatch} from '../src/batch-store.mjs';
import {candidateInput} from '../src/contracts.mjs';
import {acquisitionFixture,draftFixture} from './helpers-acquisition.mjs';

test('actual stdio source MCP exposes host scout, binds a planned receipt and material feedback across restart without a model or network',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),requestId='a'.repeat(64);
  const script=`
    import {mock} from 'node:test';import {writeFile} from 'node:fs/promises';import path from 'node:path';
    import {hash,now} from ${JSON.stringify(new URL('../src/contracts.mjs',import.meta.url).href)};
    const module=${JSON.stringify(new URL('../src/search.mjs',import.meta.url).href)},actual=await import(module);
    mock.module(module,{namedExports:{...actual,searchPublic:async(query,{directory,provider,intent})=>{
      const result={provider,intent,query,status:'completed',at:now(),results:[{url:'https://www.instagram.com/synthetic/',title:'Houston Texas Synthetic workshops'}]};
      await writeFile(path.join(directory,'search-'+hash({query,intent}).slice(0,16)+'.json'),JSON.stringify(result));return result;
    }}});
    await import(${JSON.stringify(new URL('../src/sources-mcp.mjs',import.meta.url).href)});
  `;
  async function connect(){
    const client=new Client({name:'synthetic-scout-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['--experimental-test-module-mocks','--input-type=module','--eval',script],env:{FACTORY_DB:f.options.dbPath,FACTORY_STATE:f.options.stateRoot,FACTORY_SOURCE_JOB:f.job.id,FACTORY_SOURCES:f.directory,FACTORY_RESEARCH_REQUEST:requestId,FACTORY_RESEARCH_LIMIT:'3'},stderr:'pipe'});
    transport.stderr?.on('data',()=>{});await client.connect(transport);return client;
  }
  let client=await connect();try{
    assert.ok((await client.listTools()).tools.some(v=>v.name==='scout'));
    const denied=await client.callTool({name:'search',arguments:{query:'Unplanned discovery query',provider:'firecrawl',intent:'discover'}});assert.equal(denied.isError,true);
    assert.equal(getBatch(f.store,f.b.id).usage.searches,0);
    const query=await client.callTool({name:'scout',arguments:{output:{candidates:[]}}});assert.equal(query.structuredContent.status,'searched');
    const step=await client.callTool({name:'scout',arguments:{output:d.output}});assert.equal(step.structuredContent.status,'ready_to_finalize');
    const checked=await client.callTool({name:'check_research',arguments:{output:d.output}});assert.equal(checked.structuredContent.valid,true);
    assert.equal(checked.structuredContent.feedback[0].material.feasible,true);
    await assertResearchChecked({directory:f.directory,requestId,candidateLimit:3,output:d.output});
  }finally{await client.close();}
  client=await connect();try{
    const again=await client.callTool({name:'scout',arguments:{output:d.output}});assert.equal(again.structuredContent.status,'ready_to_finalize');
    assert.equal(getBatch(f.store,f.b.id).usage.searches,1);assert.equal(getBatch(f.store,f.b.id).usage.inspections,0);
    assertScoutWorkflow(f.store,f.job.id,d.output.candidates.map(candidateInput),await readIntakeEvidence(f.directory));
    const bad=await client.callTool({name:'scout',arguments:{output:{candidates:[{name:'bad'}]}}});assert.equal(bad.isError,true);
    const dropped=await client.callTool({name:'check_research',arguments:{output:{candidates:[]}}});assert.equal(dropped.structuredContent.valid,false,'A scoped data check must expose dropped registered identities before finalization');
    assert.equal(f.store.candidates().length,0);
  }finally{await client.close();}
});
test('actual source MCP can re-read a rendered-only observed hub after exact selection, but cannot render an unobserved hub route',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),c=d.output.candidates[0],root=d.evidence.observations[0],hub='https://linktr.ee/juniper';
  root.links.push({url:hub,text:'Business bio'});await writeFile(path.join(f.directory,root.id+'.json'),JSON.stringify(root));
  delete c.pagePurposes;c.websiteCheck={status:'unknown',queries:[],checkedAt:new Date().toISOString(),linkChecks:[]};
  const script=`
    import {mock} from 'node:test';import {writeFile} from 'node:fs/promises';import path from 'node:path';
    import {hash,now} from ${JSON.stringify(new URL('../src/contracts.mjs',import.meta.url).href)};
    const browserModule=${JSON.stringify(new URL('../src/browser.mjs',import.meta.url).href)},browser=await import(browserModule),root=${JSON.stringify(root)},hub=${JSON.stringify(hub)};
    mock.module(browserModule,{namedExports:{...browser,inspectSource:async(url,{directory,linked=false})=>{
      const profile=url===root.url,o=profile?structuredClone(root):{url,title:'Synthetic hub',text:'LOCAL SYNTHETIC HUB: reader-only fixture',links:[],images:[]};
      o.id='source-'+hash({url,directory}).slice(0,20);o.inspectedAt=now();o.blocked=!profile&&!linked;o.method=linked?'fresh_guest_rendered_dom':profile?'fresh_guest_rendered_dom':'static_https_no_script';o.finalUrl=url;o.captures=[];
      await writeFile(path.join(directory,o.id+'.json'),JSON.stringify(o));return o;
    }}});
    const searchModule=${JSON.stringify(new URL('../src/search.mjs',import.meta.url).href)},search=await import(searchModule);
    mock.module(searchModule,{namedExports:{...search,searchPublic:async(query,{directory,provider,intent})=>{
      const r={query,provider,intent,status:'completed',at:now(),results:[{url:root.url,title:'Houston Synthetic workshops'}]};await writeFile(path.join(directory,'search-'+hash({query,intent}).slice(0,16)+'.json'),JSON.stringify(r));return r;
    }}});await import(${JSON.stringify(new URL('../src/sources-mcp.mjs',import.meta.url).href)});
  `;
  async function connect(job,directory,limit){
    const client=new Client({name:'synthetic-fresh-linked-reader',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['--experimental-test-module-mocks','--input-type=module','--eval',script],env:{FACTORY_DB:f.options.dbPath,FACTORY_STATE:f.options.stateRoot,FACTORY_SOURCE_JOB:job.id,FACTORY_SOURCES:directory,FACTORY_RESEARCH_REQUEST:hash(job.id),FACTORY_RESEARCH_LIMIT:String(limit)},stderr:'ignore'});await client.connect(transport);return client;
  }
  let client=await connect(f.job,f.directory,3);try{
    await client.callTool({name:'scout',arguments:{output:{candidates:[]}}});
    const observed=await client.callTool({name:'scout',arguments:{output:d.output}});assert.equal(observed.structuredContent.observation.blocked,false);
    c.websiteCheck.linkChecks=[{url:hub,sourceId:observed.structuredContent.observation.id,status:'official',reason:'Synthetic observed hub, not independent website'}];
    const done=await client.callTool({name:'scout',arguments:{output:d.output}});assert.equal(done.structuredContent.status,'ready_to_finalize');
  }finally{await client.close();}
  const discovery=await executeJob(f.store,f.job.id,{discover:async()=>({candidates:[c],live:false})});assert.equal(discovery.state,'review_ready',discovery.message);await reconcileBatches(f.store);
  const candidate=f.store.candidate(discovery.outputs.candidateIds[0]),selected=await f.service.dispatch('batch_build_selected',{id:f.b.id,candidateId:candidate.id,evidenceDigest:hash(candidate),requestId:'fresh-linked-read',authorized:true});
  const directory=path.join(f.store.stateRoot,workRelative(selected.job),'sources');await mkdir(directory,{recursive:true});
  client=await connect(selected.job,directory,1);try{
    assert.equal((await client.listTools()).tools.some(v=>v.name==='scout'),false);
    await client.callTool({name:'inspect',arguments:{url:root.url}});
    const fresh=await client.callTool({name:'inspect',arguments:{url:hub}});assert.equal(fresh.structuredContent.blocked,false);assert.equal(fresh.structuredContent.method,'fresh_guest_rendered_dom');
    assert.equal(getBatch(f.store,f.b.id).usage.inspections,3);
    const unobserved=await client.callTool({name:'inspect',arguments:{url:'https://linktr.ee/unobserved'}});assert.equal(unobserved.structuredContent.blocked,true);assert.equal(unobserved.structuredContent.method,'static_https_no_script');
  }finally{await client.close();}
});
test('terminal geography holds register without I/O and receive actionable scope feedback within the same two checker slots',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),root=d.evidence.observations[0],line='Based in Katy, Texas. Serving Houston.';
  root.text+=' '+line;d.output.candidates[0].facts.push({text:line,excerpt:line,sourceUrl:root.url});await writeFile(path.join(f.directory,root.id+'.json'),JSON.stringify(root));
  const client=new Client({name:'terminal-registration-only',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('src/sources-mcp.mjs')],env:{FACTORY_DB:f.options.dbPath,FACTORY_STATE:f.options.stateRoot,FACTORY_SOURCE_JOB:f.job.id,FACTORY_SOURCES:f.directory,FACTORY_RESEARCH_REQUEST:'d'.repeat(64),FACTORY_RESEARCH_LIMIT:'3'},stderr:'ignore'});
  try{
    await client.connect(transport);
    const early=await client.callTool({name:'check_research',arguments:{output:d.output}});assert.equal(early.structuredContent.valid,false);assert.match(early.structuredContent.issues[0].message,/sources.scout/);
    const registered=await client.callTool({name:'scout',arguments:{output:d.output}});assert.equal(registered.structuredContent.status,'cohort_needs_evidence');assert.equal(registered.structuredContent.feedback[0].screening.geography,'conflict');
    const final=await client.callTool({name:'check_research',arguments:{output:d.output}});assert.equal(final.structuredContent.valid,true);assert.equal(final.structuredContent.check,2);assert.equal(final.structuredContent.feedback[0].intakeReady,false);
    assert.deepEqual(getBatch(f.store,f.b.id).usage,{modelRequests:0,searches:0,inspections:0,imageViews:0});assert.equal(f.store.candidates().length,0);
  }finally{await client.close();}
});

test('actual source MCP carries a candidate listing search through inspected corroboration without qualifying it',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),c=d.output.candidates[0],root=d.evidence.observations[0];
  const line='Repairs upholstered chairs by appointment.',old=c.facts[0].excerpt;
  c.facts[0]={text:line,excerpt:line,sourceUrl:root.url};root.text=root.text.replace(old,line);
  Object.assign(root,{method:'fresh_guest_rendered_dom',evidenceContextVersion:1,finalUrl:root.url});
  c.websiteCheck.status='unknown';c.websiteCheck.queries=[];
  await writeFile(path.join(f.directory,root.id+'.json'),JSON.stringify(root));
  const url='https://www.yelp.com/biz/juniper-1-upholstery-houston',requestId='e'.repeat(64);
  const script=`
    import {mock} from 'node:test';import {writeFile} from 'node:fs/promises';import path from 'node:path';
    import {hash,now} from ${JSON.stringify(new URL('../src/contracts.mjs',import.meta.url).href)};
    const searchModule=${JSON.stringify(new URL('../src/search.mjs',import.meta.url).href)},search=await import(searchModule),url=${JSON.stringify(url)};
    mock.module(searchModule,{namedExports:{...search,searchPublic:async(query,{directory,provider,intent})=>{
      const r={query,provider,intent,status:'completed',at:now(),results:[{url,title:'Juniper 1 Upholstery - Houston, TX - Yelp'}]};
      await writeFile(path.join(directory,'search-'+hash(query).slice(0,16)+'.json'),JSON.stringify(r));return r;
    }}});
    const browserModule=${JSON.stringify(new URL('../src/browser.mjs',import.meta.url).href)},browser=await import(browserModule);
    mock.module(browserModule,{namedExports:{...browser,inspectSource:async(requested,{directory})=>{
      if(requested!==url)throw new Error('Unexpected synthetic inspection');
      const o={id:'source-'+hash(requested).slice(0,20),url:requested,finalUrl:requested,title:'Juniper 1 Upholstery - Houston, TX - Yelp',text:'Juniper 1 Upholstery 123 Main Street, Houston, TX 77002',inspectedAt:now(),blocked:false,method:'static_https_no_script',links:[{url:${JSON.stringify(root.url)},text:'Instagram'}],images:[],captures:[]};
      await writeFile(path.join(directory,o.id+'.json'),JSON.stringify(o));return o;
    }}});await import(${JSON.stringify(new URL('../src/sources-mcp.mjs',import.meta.url).href)});
  `;
  const client=new Client({name:'synthetic-listing-handoff',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['--experimental-test-module-mocks','--input-type=module','--eval',script],env:{FACTORY_DB:f.options.dbPath,FACTORY_STATE:f.options.stateRoot,FACTORY_SOURCE_JOB:f.job.id,FACTORY_SOURCES:f.directory,FACTORY_RESEARCH_REQUEST:requestId,FACTORY_RESEARCH_LIMIT:'3'},stderr:'ignore'});
  try{
    await client.connect(transport);
    assert.equal((await client.callTool({name:'scout',arguments:{output:{candidates:[]}}})).structuredContent.status,'searched');
    const targeted=(await client.callTool({name:'scout',arguments:{output:d.output}})).structuredContent;
    assert.equal(targeted.question.purpose,'candidate_listing');assert.equal(targeted.search.results[0].url,url);
    assert.equal(targeted.feedback[0].screening.geography,'unknown');
    const listing=(await client.callTool({name:'inspect',arguments:{url}})).structuredContent;
    c.inspectionIds.push(listing.id);c.sourceUrls.push(url);c.facts.push({text:'Located at 123 Main Street, Houston, TX 77002.',excerpt:'123 Main Street, Houston, TX 77002',sourceUrl:url});
    const done=(await client.callTool({name:'scout',arguments:{output:d.output}})).structuredContent;
    assert.equal(done.status,'ready_to_finalize');assert.equal(done.feedback[0].screening.geography,'supported');assert.equal(done.fullQualification,false);
    const checked=(await client.callTool({name:'check_research',arguments:{output:d.output}})).structuredContent;
    assert.equal(checked.valid,true);assert.equal(checked.feedback[0].intakeReady,false);assert.equal(c.websiteCheck.status,'unknown');
    assert.deepEqual(getBatch(f.store,f.b.id).usage,{modelRequests:0,searches:2,inspections:1,imageViews:0});
    assertScoutWorkflow(f.store,f.job.id,d.output.candidates.map(candidateInput),await readIntakeEvidence(f.directory));
  }finally{await client.close();}
});
