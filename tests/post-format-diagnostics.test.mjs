import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {postFormatDiagnosticsScript,normalizePostFormatDiagnostics} from '../src/post-evidence.mjs';
import {publicObservation} from '../src/browser.mjs';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {executeJob} from '../src/worker.mjs';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';

const require=createRequire(import.meta.url),{chromium}=require('playwright');
const url='https://www.instagram.com/juniper1/p/Post123/';
const html=`<!doctype html><html><head><link rel="canonical" href="https://www.instagram.com/p/Post123/"></head><body>
<main><article><header><a href="/juniper1/">juniper1</a></header><ul><li><a href="/juniper1/">juniper1</a><h1>PRIVATE-CAPTION-FIXTURE <a href="https://outside.example/?secret=PRIVATE-URL-FIXTURE">site</a></h1></li>
<li><a href="/stranger/">stranger</a><p>PRIVATE-COMMENT-FIXTURE</p></li></ul><a href="/p/Post123/"><time datetime="2026-10-20T10:00:00.000Z">one week</time></a></article>
<article hidden><h1>Hidden heading</h1></article></main></body></html>`;
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,args:['--disable-dev-shm-usage']});});
after(async()=>{await browser?.close();});
async function observe(document=html){
  const context=await browser.newContext();let requests=0;
  await context.route('**/*',r=>{requests++;return r.request().isNavigationRequest()&&r.request().url()===url?r.fulfill({status:200,contentType:'text/html',body:document}):r.abort();});
  try{const page=await context.newPage();await page.goto(url);const result=await page.evaluate(postFormatDiagnosticsScript);assert.equal(requests,1);return result;}finally{await context.close();}
}
test('private structural diagnostics distinguish visible articles, canonical candidates and author/post relationships',async()=>{
  const d=await observe();assert.equal(d.version,2);assert.equal(d.currentPost,true);
  assert.equal(d.canonicalCount,1);assert.equal(d.canonical[0].samePost,true);
  assert.deepEqual(d.articles,{total:2,visible:1});
  assert.ok(d.nodes.some(n=>n.kind==='profile'&&n.account==='juniper1'&&n.labelMatchesAccount&&n.visible));
  assert.ok(d.nodes.some(n=>n.kind==='post'&&n.samePost&&n.visible));
  assert.ok(d.nodes.some(n=>n.kind==='heading'&&n.visible&&n.path.length));
  assert.ok(d.nodes.some(n=>n.kind==='time'&&n.samePost&&n.absoluteDateShape));
  assert.ok(!JSON.stringify(d).includes('PRIVATE-'));
});
test('missing canonical, no article and bounded excess nodes are represented without page text or raw URLs',async()=>{
  const d=await observe(`<!doctype html><html><body><main>${'<a href="/p/Post123/">PRIVATE-EXCESS</a>'.repeat(250)}</main></body></html>`);
  assert.equal(d.canonicalCount,0);assert.deepEqual(d.articles,{total:0,visible:0});
  assert.ok(d.nodes.length<=120);assert.equal(d.nodesTruncated,true);assert.ok(!JSON.stringify(d).includes('PRIVATE-'));
  assert.ok(!JSON.stringify(d).includes('https://'));
});
test('diagnostics distinguish ARIA article/heading layouts, text regions and a query-bearing same-post canonical without accepting it',async()=>{
  const d=await observe(`<!doctype html><html><head><link rel="canonical" href="https://www.instagram.com/p/Post123/?tracking=opaque"></head><body><main><div role="article"><a href="/juniper1/">juniper1</a><div role="heading"><span dir="auto">PRIVATE-CAPTION-WITHOUT-H1</span></div></div></main></body></html>`);
  assert.equal(d.readyState,'complete');assert.deepEqual(d.roleArticles,{total:1,visible:1});assert.equal(d.articles.total,0);
  assert.equal(d.canonical[0].samePost,false);assert.equal(d.canonical[0].samePostPath,true);assert.equal(d.canonical[0].hasQuery,true);
  assert.ok(d.nodes.some(n=>n.kind==='role_article'&&n.visible));assert.ok(d.nodes.some(n=>n.kind==='heading'&&n.visible));
  assert.ok(d.textNodes.some(n=>n.visible&&n.textLength>0&&n.path.length));assert.ok(!JSON.stringify(d).includes('PRIVATE-'));
});
test('deep post structures preserve ancestry up to a bounded depth and report further truncation',async()=>{
  const document=depth=>`<!doctype html><html><body><main>${'<div>'.repeat(depth)}<h1>PRIVATE-CAPTION</h1>${'</div>'.repeat(depth)}</main></body></html>`;
  const normal=await observe(document(32)),deep=await observe(document(70));
  const heading=normal.nodes.find(n=>n.kind==='heading'),truncated=deep.nodes.find(n=>n.kind==='heading');
  assert.equal(heading.pathTruncated,false);assert.ok(heading.path.length>32);assert.equal(heading.path[0],'html:0');
  assert.equal(truncated.pathTruncated,true);assert.equal(truncated.path.length,48);
  assert.deepEqual(normalizePostFormatDiagnostics(normal),normal);assert.deepEqual(normalizePostFormatDiagnostics(deep),deep);
  assert.ok(!JSON.stringify([normal,deep]).includes('PRIVATE-'));
});
test('semantic diagnostics distinguish caption/comment markers and structured post metadata without recording their text',async()=>{
  const data=JSON.stringify({'@type':'SocialMediaPosting',url:'https://www.instagram.com/p/Post123/',author:{url:'https://www.instagram.com/juniper1/'},caption:'PRIVATE-JSON-CAPTION',description:'PRIVATE-JSON-DESCRIPTION'});
  const d=await observe(`<!doctype html><html><head><link rel="canonical" href="https://www.instagram.com/p/Post123/"><meta property="og:description" content="PRIVATE-META-DESCRIPTION"><script type="application/ld+json">${data}</script></head><body><main><section role="region" aria-label="Caption"><span dir="auto"><a href="/juniper1/">juniper1</a><time datetime="2026-10-20T10:00:00.000Z">time</time>PRIVATE-CAPTION</span></section><section role="region" aria-label="Comments"><div data-testid="post-comment"><span dir="auto"><a href="/juniper1/">juniper1</a>PRIVATE-OWNER-COMMENT</span></div></section><a href="/p/Post123/"><time datetime="2026-10-20T10:00:00.000Z">time</time></a></main></body></html>`);
  assert.equal(d.version,2);assert.ok(d.semanticNodes.some(n=>n.markers.includes('caption')));assert.ok(d.semanticNodes.some(n=>n.markers.includes('comment')));
  assert.equal(d.metadata.ogDescriptionCount,1);assert.equal(d.metadata.jsonLdScriptCount,1);assert.equal(d.metadata.jsonLd.length,1);
  assert.deepEqual(d.metadata.jsonLd[0],{types:['SocialMediaPosting'],postMatches:true,postConflict:false,authorProfile:true,authorMatchesAccount:true,authorMatchesVisible:true,captionLength:20,descriptionLength:24,articleBodyLength:0});
  assert.ok(d.textNodes.some(n=>n.profileCount===1&&n.matchingPostTime));assert.ok(d.textNodes.some(n=>n.profileCount===1&&!n.matchingPostTime));
  assert.deepEqual(normalizePostFormatDiagnostics(d),d);assert.ok(!JSON.stringify(d).includes('PRIVATE-'));assert.ok(!JSON.stringify(d).includes('https://'));
});
test('unrelated, malformed and missing structured metadata are unknown rather than matching post or authorship',async()=>{
  const other=JSON.stringify({'@type':'SocialMediaPosting',url:'https://www.instagram.com/p/Other123/',author:{url:'https://www.instagram.com/stranger/'},caption:'PRIVATE-OTHER'});
  const d=await observe(`<!doctype html><html><head><script type="application/ld+json">${other}</script><script type="application/ld+json">{not-json</script></head><body><main><span dir="auto">PRIVATE-UNLABELLED</span></main></body></html>`);
  assert.equal(d.metadata.jsonLdScriptCount,2);assert.equal(d.metadata.jsonLdInvalidCount,1);assert.equal(d.metadata.ogDescriptionCount,0);
  assert.equal(d.metadata.jsonLd[0].postMatches,false);assert.equal(d.metadata.jsonLd[0].postConflict,true);assert.equal(d.metadata.jsonLd[0].authorMatchesAccount,false);assert.equal(d.metadata.jsonLd[0].authorMatchesVisible,false);
  assert.ok(!d.semanticNodes.some(n=>n.markers.includes('caption')));assert.ok(!JSON.stringify(d).includes('PRIVATE-'));assert.deepEqual(normalizePostFormatDiagnostics(d),d);
});
test('structured metadata reports conflicting post IDs and refuses unrelated or query-bearing author URLs',async()=>{
  const data=JSON.stringify({'@type':['SocialMediaPosting','PRIVATE-UNTRUSTED-TYPE'],url:'https://www.instagram.com/p/Post123/','@id':'https://www.instagram.com/p/Other123/',author:{url:'https://www.instagram.com/juniper1/?tracking=PRIVATE'},description:'PRIVATE-DETAIL'});
  const d=await observe(`<!doctype html><html><head><script type="application/ld+json">${data}</script></head><body><main><a href="/juniper1/">juniper1</a></main></body></html>`),item=d.metadata.jsonLd[0];
  assert.deepEqual(item.types,['SocialMediaPosting']);assert.equal(item.postMatches,true);assert.equal(item.postConflict,true);
  assert.equal(item.authorProfile,false);assert.equal(item.authorMatchesAccount,false);assert.equal(item.authorMatchesVisible,false);
  assert.ok(!JSON.stringify(d).includes('PRIVATE-'));assert.deepEqual(normalizePostFormatDiagnostics(d),d);
});
test('too many or oversized structured data scripts remain explicitly incomplete and bounded',async()=>{
  const huge='x'.repeat(160001),document=`<!doctype html><html><head><script type="application/ld+json">${huge}</script>${'<script type="application/ld+json">{}</script>'.repeat(4)}</head><body><main>PRIVATE</main></body></html>`;
  const d=await observe(document);assert.equal(d.metadata.jsonLdScriptCount,5);assert.equal(d.metadata.jsonLdInvalidCount,1);assert.equal(d.metadata.jsonLdTruncated,true);
  assert.ok(d.metadata.jsonLd.length<=16);assert.ok(!JSON.stringify(d).includes('PRIVATE'));assert.deepEqual(normalizePostFormatDiagnostics(d),d);
});
test('overlong semantic attributes and truncated structured authors are reported as incomplete',async()=>{
  const data=JSON.stringify({'@type':'SocialMediaPosting',url:'https://www.instagram.com/p/Post123/',author:Array.from({length:9},()=>({url:'https://www.instagram.com/juniper1/'}))});
  const d=await observe(`<!doctype html><html><head><script type="application/ld+json">${data}</script></head><body><main><div aria-label="${'x'.repeat(1201)} caption">PRIVATE</div></main></body></html>`);
  assert.equal(d.metadata.jsonLdTruncated,true);assert.ok(d.semanticNodes.some(n=>n.attributesTruncated));
  assert.ok(!d.semanticNodes.some(n=>n.markers.includes('caption')));assert.ok(!JSON.stringify(d).includes('PRIVATE'));assert.deepEqual(normalizePostFormatDiagnostics(d),d);
});
test('semantic markers and structured data are bounded and reject page-controlled additions',async()=>{
  const d=await observe(`<!doctype html><html><body><main>${'<div aria-label="PRIVATE-comment-label" data-testid="PRIVATE-TEST">PRIVATE</div>'.repeat(180)}</main></body></html>`);
  assert.equal(d.semanticNodes.length,120);assert.equal(d.semanticNodesTruncated,true);
  assert.ok(!JSON.stringify(d).includes('PRIVATE'));assert.throws(()=>normalizePostFormatDiagnostics({...d,metadata:{...d.metadata,body:'PRIVATE'}}),/diagnostic/i);
  assert.throws(()=>normalizePostFormatDiagnostics({...d,semanticNodes:[...d.semanticNodes,{...d.semanticNodes[0],markers:['PRIVATE']}] }),/diagnostic/i);
});
test('diagnostic details do not enter public source output or turn an unknown caption into proof',()=>{
  const o={id:'source-fixture',url,finalUrl:url,title:'private',text:'PRIVATE-BODY',inspectedAt:new Date().toISOString(),blocked:false,method:'fresh_guest_rendered_dom',evidenceContextVersion:1,postEvidenceVersion:1,postEvidenceIssue:'ambiguous_article',links:[],images:[],captures:[],postFormatDiagnostics:{version:1,private:'PRIVATE-DIAGNOSTIC'}};
  const result=publicObservation(o);assert.equal(result.text,'');assert.equal(result.postEvidenceIssue,'ambiguous_article');
  assert.equal(result.postFormatDiagnostics,undefined);assert.ok(!JSON.stringify(result).includes('PRIVATE-'));
});
test('untrusted diagnostic values and unknown fields fail before persistence',async()=>{
  const d=await observe();assert.deepEqual(normalizePostFormatDiagnostics(d),d);
  for(const bad of [null,{...d,caption:'PRIVATE-CAPTION'}, {...d,nodes:[...d.nodes,{...d.nodes[0],path:['script:99999']}]}, {...d,nodes:[...d.nodes,{...d.nodes[0],account:'https://private.example/?signature=secret'}]}, {...d,canonicalCount:-1}, {...d,nodes:Array(121).fill(d.nodes[0])}]){
    assert.throws(()=>normalizePostFormatDiagnostics(bad),/diagnostic/i);
  }
});
test('production policy binds the diagnostic request and all reader/worker implementation seams',async()=>{
  const {policyIdentity}=await import('../src/policy.mjs'),{readFile}=await import('node:fs/promises'),{hash}=await import('../src/contracts.mjs');
  const policy=await policyIdentity('production');for(const name of ['src/service.mjs','src/worker.mjs','src/browser.mjs','src/post-evidence.mjs'])assert.equal(policy.files[name],hash(await readFile(new URL('../'+name,import.meta.url))),name);
});
test('source jobs opt in explicitly, reject non-post diagnostics and pass the flag through the existing worker only',async()=>{
  const root=await mkdtemp('/tmp/factory-format-service-'),options={dbPath:path.join(root,'db.sqlite3'),stateRoot:path.join(root,'state'),autoRun:false};
  await initialize(options);const store=openStore(options),service=createService(store,options);
  try{
    const campaign=await service.dispatch('campaign_create',{name:'Fixture',query:'Fixture',area:'Houston',niche:'Fixture',autoBuild:false});
    await assert.rejects(service.dispatch('source_inspect',{campaignId:campaign.id,url:'https://www.instagram.com/juniper1/',postFormatDiagnostics:true}),/post|diagnostic/i);
    await assert.rejects(service.dispatch('source_inspect',{campaignId:campaign.id,url:'https://www.instagram.com/p/Post123/?x=1',postFormatDiagnostics:true}),/post|diagnostic/i);
    const job=await service.dispatch('source_inspect',{campaignId:campaign.id,url,postFormatDiagnostics:true});assert.equal(job.input.postFormatDiagnostics,true);
    let seen;await executeJob(store,job.id,{inspectSource:async(u,opts)=>{seen=opts.postFormatDiagnostics;return {id:'source-fixture',url:u,finalUrl:u,title:'private',text:'PRIVATE-BODY',inspectedAt:new Date().toISOString(),blocked:false,method:'fresh_guest_rendered_dom',evidenceContextVersion:1,postEvidenceVersion:1,postEvidenceIssue:'ambiguous_article',links:[],images:[],captures:[],postFormatDiagnostics:{version:1,private:'PRIVATE-DIAGNOSTIC'}};}});
    assert.equal(seen,true);const saved=store.job(job.id);assert.equal(saved.state,'review_ready');assert.equal(saved.outputs.observation.postFormatDiagnostics,undefined);assert.ok(!JSON.stringify(saved.outputs).includes('PRIVATE-'));
    const ordinary=await service.dispatch('source_inspect',{campaignId:campaign.id,url});assert.equal(ordinary.input.postFormatDiagnostics,undefined);
  }finally{store.close();}
});
test('fresh ordinary MCP accepts the bounded diagnostic option without starting fixture jobs',async()=>{
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const root=await mkdtemp('/tmp/factory-format-mcp-'),options={dbPath:path.join(root,'db.sqlite3'),stateRoot:path.join(root,'state')};await initialize(options);
  const client=new Client({name:'format-fixture',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['src/mcp.mjs'],env:{...process.env,FACTORY_DB:options.dbPath,FACTORY_STATE:options.stateRoot,FACTORY_AUTORUN:'0'},stderr:'pipe'});transport.stderr?.on('data',()=>{});
  try{
    await client.connect(transport);const c=await client.callTool({name:'campaign_create',arguments:{name:'Fixture',query:'Fixture',area:'Houston',niche:'Fixture',autoBuild:false}});
    assert.ok(c.structuredContent?.id);const r=await client.callTool({name:'source_inspect',arguments:{campaignId:c.structuredContent.id,url,postFormatDiagnostics:true}});
    assert.equal(r.isError,undefined);assert.equal(r.structuredContent?.input.postFormatDiagnostics,true);assert.equal(r.structuredContent?.state,'queued');
    const bad=await client.callTool({name:'source_inspect',arguments:{campaignId:c.structuredContent.id,url:'https://www.instagram.com/juniper1/',postFormatDiagnostics:true}});assert.equal(bad.isError,true);
  }finally{await client.close();}
});
test('ordinary reader persists diagnostics only when opted in and keeps them out of public output',async()=>{
  const script=`
    import {mock} from 'node:test';import {mkdtemp,readFile} from 'node:fs/promises';import {createRequire} from 'node:module';
    const require=createRequire(import.meta.url),{chromium}=require('playwright');
    const browser=await chromium.launch({headless:true,executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,args:['--disable-dev-shm-usage']}),page=await browser.newPage();
    await page.route('**/*',r=>r.request().url()===${JSON.stringify(url)}?r.fulfill({status:200,contentType:'text/html',body:${JSON.stringify(html)}}):r.abort());await page.goto(${JSON.stringify(url)});
    mock.module(${JSON.stringify(new URL('../src/network.mjs',import.meta.url).href)},{namedExports:{resolvePublic:async()=>({address:'93.184.216.34',family:4}),safeFetch:async()=>{throw new Error('No network permitted');}}});
    mock.module(${JSON.stringify(new URL('../src/process.mjs',import.meta.url).href)},{namedExports:{runProcess:async(_,args)=>({stdout:JSON.stringify({success:true,data:args.includes('eval')?{result:await page.evaluate(args.at(-1))}:{}})})}});
    try{const {inspectSource,publicObservation}=await import(${JSON.stringify(new URL('../src/browser.mjs',import.meta.url).href)}),directory=await mkdtemp('/tmp/factory-format-reader-');
      const raw=await inspectSource(${JSON.stringify(url)},{directory,postFormatDiagnostics:true}),stored=JSON.parse(await readFile(directory+'/'+raw.id+'.json','utf8'));
      const normal=await inspectSource(${JSON.stringify(url)},{directory});console.log(JSON.stringify({privateReport:raw.postFormatDiagnostics,stored:stored.postFormatDiagnostics,public:publicObservation(raw),normal:normal.postFormatDiagnostics||null}));
    }finally{await browser.close();}
  `;
  const {stdout}=await promisify(execFile)(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',script],{timeout:30000,maxBuffer:400000});
  const result=JSON.parse(stdout.trim());assert.equal(result.privateReport.version,2);assert.deepEqual(result.stored,result.privateReport);assert.equal(result.normal,null);
  assert.equal(result.public.postFormatDiagnostics,undefined);assert.ok(!JSON.stringify(result.public).includes('PRIVATE-COMMENT-FIXTURE'));
});
