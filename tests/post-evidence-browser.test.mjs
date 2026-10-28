import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {postEvidenceScript,normalizePostEvidence} from '../src/post-evidence.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const url='https://www.instagram.com/juniper1/p/Post123/';
const html=`<!doctype html><html><head><link rel="canonical" href="https://www.instagram.com/p/Post123/"></head><body>
<article><header><a href="/juniper1/">juniper1</a></header><ul><li><a href="/juniper1/">juniper1</a><h1>We repair chairs in Houston.<br>New restoration shared 2026-10-20.<br><a href="https://workshop.example/">Our work</a></h1></li>
<li><a href="/stranger/">stranger</a><p>Based in Katy. Use <a href="https://unrelated.example/">this comment site</a>.</p></li></ul>
<a href="/p/Post123/"><time datetime="2026-10-20T10:00:00.000Z">1 week ago</time></a></article></body></html>`;
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,args:['--disable-dev-shm-usage']});});
after(async()=>{await browser?.close();});
async function observe(document=html,route=url){
  const context=await browser.newContext();let requests=0;
  await context.route('**/*',r=>{requests++;return r.request().isNavigationRequest()&&r.request().url()===route?r.fulfill({status:200,contentType:'text/html',body:document}):r.abort();});
  try{
    const page=await context.newPage();await page.goto(route);const raw=await page.evaluate(postEvidenceScript);
    const body=await page.evaluate(()=>({text:document.body.innerText,links:[...document.querySelectorAll('a[href]')].map(a=>({url:a.href,text:a.innerText.slice(0,120)}))}));
    const observation={url:route,finalUrl:route,method:'fresh_guest_rendered_dom',evidenceContextVersion:1,blocked:false,...body};
    assert.equal(requests,1,'Every fixture request is intercepted locally; no external network is permitted.');
    return {raw,normalized:normalizePostEvidence(observation,raw)};
  }finally{await context.close();}
}
test('real DOM extractor isolates caption/author/permalink and excludes comments from the versioned context',async()=>{
  const {raw,normalized}=await observe();assert.equal(raw.proof,'instagram_article_caption_v1');assert.equal(raw.authorUrl,'https://www.instagram.com/juniper1/');
  assert.match(raw.caption,/repair chairs in Houston/);assert.doesNotMatch(raw.caption,/Katy|stranger|1 week ago/);
  assert.deepEqual(raw.links,[{url:'https://workshop.example/',text:'Our work'}]);assert.deepEqual(normalized.postEvidence,raw);
});
for(const [name,change,issue] of [
  ['missing canonical',s=>s.replace(/<link[^>]+>/,''),'canonical_mismatch'],
  ['different canonical post',s=>s.replace('href="https://www.instagram.com/p/Post123/"','href="https://www.instagram.com/p/Other123/"'),'canonical_mismatch'],
  ['two visible articles',s=>s.replace('</body>','<article>Another visible post</article></body>'),'ambiguous_article'],
  ['two captions',s=>s.replace('</ul>','<li><a href="/juniper1/">juniper1</a><h1>Second possible caption</h1></li></ul>'),'ambiguous_caption'],
  ['hidden caption',s=>s.replace('<h1>','<h1 hidden>'),'ambiguous_caption'],
  ['invisible caption ancestor',s=>s.replace('<ul>','<ul style="opacity:0">'),'ambiguous_caption'],
  ['header author conflict',s=>s.replace('<header><a href="/juniper1/">','<header><a href="/stranger/">'),'author_mismatch'],
  ['two local authors',s=>s.replace('<h1>','<a href="/stranger/">stranger</a><h1>'),'ambiguous_author'],
  ['mislabeled local author',s=>s.replace('<li><a href="/juniper1/">juniper1','<li><a href="/juniper1/">stranger'),'ambiguous_author'],
  ['other post time',s=>s.replace('href="/p/Post123/"','href="/p/Other123/"'),'permalink_mismatch'],
  ['missing absolute permalink',s=>s.replace(/<time[\s\S]*?<\/time>/,''),'permalink_mismatch'],
  ['two conflicting date nodes',s=>s.replace('</article>','<a href="/p/Post123/"><time datetime="2026-10-21T10:00:00.000Z">Another date</time></a></article>'),'permalink_mismatch'],
  ['invalid calendar date',s=>s.replace('datetime="2026-10-20T10:00:00.000Z"','datetime="2026-02-30T10:00:00.000Z"'),'permalink_mismatch'],
  ['query-bearing canonical',s=>s.replace('instagram.com/p/Post123/"','instagram.com/p/Post123/?igsh=unknown"'),'canonical_mismatch'],
  ['caption with no local author',s=>s.replace('<li><a href="/juniper1/">juniper1</a>','<li>'),'ambiguous_author'],
])test(`real DOM fails closed: ${name}`,async()=>{
  const r=await observe(change(html));assert.equal(r.normalized.postEvidence,undefined);assert.equal(r.normalized.postEvidenceIssue,issue);
});
test('a scoped URL cannot override the observed author',async()=>{
  const r=await observe(html,'https://www.instagram.com/stranger/p/Post123/');assert.equal(r.normalized.postEvidenceIssue,'author_mismatch');
});
test('the adapter does nothing on a profile; it does not relabel a bio or feed as a caption',async()=>{
  const r=await observe(html,'https://www.instagram.com/juniper1/');assert.equal(r.raw,null);assert.deepEqual(r.normalized,{});
});
test('ordinary inspectSource wiring retains real DOM context and exposes only the validated public form',async()=>{
  const script=`
    import {mock} from 'node:test';import {mkdtemp} from 'node:fs/promises';import {createRequire} from 'node:module';
    const require=createRequire(import.meta.url),{chromium}=require('playwright');
    const browser=await chromium.launch({headless:true,executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,args:['--disable-dev-shm-usage']}),page=await browser.newPage();
    await page.route('**/*',r=>r.request().url()===${JSON.stringify(url)}?r.fulfill({status:200,contentType:'text/html',body:${JSON.stringify(html)}}):r.abort());await page.goto(${JSON.stringify(url)});
    mock.module(${JSON.stringify(new URL('../src/network.mjs',import.meta.url).href)},{namedExports:{resolvePublic:async()=>({address:'93.184.216.34',family:4}),safeFetch:async()=>{throw new Error('No network permitted');}}});
    mock.module(${JSON.stringify(new URL('../src/process.mjs',import.meta.url).href)},{namedExports:{runProcess:async(_,args)=>({stdout:JSON.stringify({success:true,data:args.includes('eval')?{result:await page.evaluate(args.at(-1))}:{}})})}});
    try{const {inspectSource,publicObservation}=await import(${JSON.stringify(new URL('../src/browser.mjs',import.meta.url).href)}),directory=await mkdtemp('/tmp/factory-authored-reader-'),o=await inspectSource(${JSON.stringify(url)},{directory});console.log(JSON.stringify({private:o,public:publicObservation(o)}));}finally{await browser.close();}
  `;
  const {stdout}=await promisify(execFile)(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',script],{timeout:30000,maxBuffer:400000});
  const result=JSON.parse(stdout.trim());assert.equal(result.private.postEvidenceVersion,1);assert.deepEqual(result.public.postEvidence,result.private.postEvidence);
  assert.equal(result.public.postEvidence.proof,'instagram_article_caption_v1');assert.equal(result.public.postEvidenceIssue,undefined);
});
