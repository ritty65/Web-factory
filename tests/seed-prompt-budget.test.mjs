import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as research from '../src/research.mjs';
import {hash} from '../src/contracts.mjs';

function receipt(count=20){
  return {id:'seed-fictional-prompt',digest:'a'.repeat(64),version:{pages:[{body:'UNTRUSTED_PAGE_INSTRUCTION '.repeat(6000)}]},attribution:['UNTRUSTED_ATTRIBUTION'],limitations:['UNTRUSTED_LIMITATION'],items:Array.from({length:count},(_,i)=>({id:String(i).padEnd(200,'i'),name:String(i).padEnd(300,'n'),urls:{original:[`https://www.instagram.com/fixture_${i}/`,`https://www.facebook.com/fixture_${i}/`]},provenance:{annotation:'UNTRUSTED_ANNOTATION'}}))};
}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}

test('compact locators retain all 20 maximum IDs/names and frozen order without source metadata or mutation',()=>{
  const source=freeze(receipt()),before=JSON.stringify(source),output=research.compactSeedLocators(source);
  assert.deepEqual(Object.keys(output).sort(),['schemaVersion','receiptId','receiptDigest','sourceContextDigest','items'].sort());
  assert.equal(output.receiptId,source.id);assert.equal(output.receiptDigest,source.digest);assert.equal(output.sourceContextDigest,hash(source.version));
  assert.deepEqual(output.items,source.items.map(item=>({id:item.id,name:item.name,originalProfileUrls:item.urls.original})));
  const text=JSON.stringify(output);assert.ok(Buffer.byteLength(text,'utf8')<=20000);assert.doesNotMatch(text,/UNTRUSTED_/);
  assert.equal(JSON.stringify(source),before);
});

test('only actual scout-eligible profiles enter the prompt; exact pointer bytes and distinct aliases survive',()=>{
  const source=receipt(1),urls=[
    'https://www.instagram.com/Exact.Name/',
    'https://www.instagram.com/Exact.Name/',
    'https://instagram.com/Exact.Name',
    'https://m.facebook.com/profile.php?id=123456',
    'https://www.facebook.com/people/Exact-Name/123456789/',
    'https://www.instagram.com/p/POST/',
    'https://www.instagram.com/reel/POST/',
    'https://www.instagram.com/direct/',
    'https://www.instagram.com/Exact.Name/?tracking=1',
    'https://www.facebook.com/marketplace/',
    'https://www.facebook.com/profile.php?id=123456&tracking=1',
    'https://www.facebook.com/groups/123456/',
    'https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.instagram.com%2Fguessed%2F',
    'https://example.com/fixture',
  ];
  source.items[0].urls={nested:[urls]};
  assert.deepEqual(research.compactSeedLocators(source).items[0].originalProfileUrls,[urls[0],urls[2],urls[3],urls[4]]);
});

test('projection preserves valid multibyte identities and checks serialized UTF-8 rather than character count',()=>{
  const source=receipt();for(const item of source.items)item.name='界'.repeat(100);
  const output=research.compactSeedLocators(source);assert.equal(output.items[19].name,source.items[19].name);
  for(const item of source.items)item.name='界'.repeat(300);
  assert.throws(()=>research.compactSeedLocators(source),e=>e.code==='SEED_PROMPT_BUDGET'&&!e.message.includes('界'));
  assert.equal(source.items.length,20);assert.equal(source.items[19].name.length,300);
});

test('oversized actual profile pointers reject rather than truncate URLs or silently drop identities',()=>{
  const source=receipt(),url='https://www.instagram.com/'+'x'.repeat(7000)+'/';
  for(const item of source.items)item.urls=[url];
  assert.throws(()=>research.compactSeedLocators(source),e=>e.code==='SEED_PROMPT_BUDGET'&&!e.message.includes(url));
  assert.equal(source.items.length,20);assert.equal(source.items[0].urls[0],url);
});

test('projection accepts exactly 20000 serialized bytes and rejects one more without changing the receipt',()=>{
  const source=receipt(),base=Buffer.byteLength(JSON.stringify(research.compactSeedLocators(source)),'utf8');
  source.items[0].urls.original[0]='https://www.instagram.com/'+'x'.repeat(20000-base+'fixture_0'.length)+'/';
  assert.equal(Buffer.byteLength(JSON.stringify(research.compactSeedLocators(source)),'utf8'),20000);
  source.items[0].urls.original[0]+='/';
  assert.throws(()=>research.compactSeedLocators(source),e=>e.code==='SEED_PROMPT_BUDGET');
});

test('excluded full version metadata remains digest-bound without becoming prompt instructions',()=>{
  const source=receipt(1),first=research.compactSeedLocators(source);
  source.version.pages[0].body='DIFFERENT_UNTRUSTED_INSTRUCTION';
  const changed=research.compactSeedLocators(source);
  assert.notEqual(changed.sourceContextDigest,first.sourceContextDigest);
  assert.deepEqual(changed.items,first.items);assert.doesNotMatch(JSON.stringify(changed),/UNTRUSTED/);
});

// Only a Node fixture child is executed. The native model boundary is mocked;
// large data is generated INSIDE the child, never embedded in its --eval argv.
async function capture(t,{oversize=false,projectionOversize=false,guardFailure=false,returnModel=false,cached=false,padding=0}={}){
  const root=await mkdtemp('/tmp/factory-seed-prompt-');t.after(()=>rm(root,{recursive:true,force:true}));
  const url=name=>new URL(`../src/${name}.mjs`,import.meta.url).href;
  const script=`
    import {mock} from 'node:test';
    import {mkdir} from 'node:fs/promises';
    import path from 'node:path';
    const source={id:'seed-fixture',digest:'a'.repeat(64),version:{pages:[{body:'UNTRUSTED_PAGE_INSTRUCTION '.repeat(6000)}]},items:Array.from({length:20},(_,i)=>({id:String(i).padEnd(200,'i'),name:String(i).padEnd(300,'n'),urls:['https://www.instagram.com/fixture_'+i+'/']}))};
    if(${projectionOversize})for(const item of source.items)item.name='界'.repeat(300);
    let calls=0,checks=0,prompt=null;
    mock.module(${JSON.stringify(url('batch-budget'))},{namedExports:{jobBudgetContext:()=>({store:{},jobId:'fixture-job'})}});
    mock.module(${JSON.stringify(url('scout'))},{namedExports:{seedResearchContext:()=>{checks++;if(${guardFailure}){const e=new Error('Fixture full receipt guard');e.code='SEED_RECEIPT';throw e;}return source;}}});
    mock.module(${JSON.stringify(url('model'))},{namedExports:{requestModel:async request=>{calls++;prompt=request.prompt;if(${returnModel})return {output:{candidates:[]},requestId:'b'.repeat(64),toolEvents:[]};const e=new Error('Fixture capture only');e.code='FIXTURE_CAPTURE';throw e;}}});
    const {discover,assertNativeResearchResult}=await import(${JSON.stringify(url('research'))});
    const jobRoot=${JSON.stringify(root)};
    await mkdir(path.join(jobRoot,'sources'),{recursive:true});
    let code;
    try{if(${cached})await assertNativeResearchResult({},{jobRoot,candidateLimit:6,provider:'firecrawl',evidence:{searches:[],observations:[]}});else await discover({candidateLimit:6,area:'Houston city limits',niche:'Synthetic detailers',deadlineMinutes:2,query:${oversize}?'界'.repeat(40000):'fixture'+'x'.repeat(${padding})},{jobRoot,batch:{settings:{workflow:'leads_first',searchProvider:'firecrawl'},acquisition:{version:1},phase:'discovery',seen:[],budget:{}}});}catch(e){code=e.code;}
    console.log(JSON.stringify({code,calls,checks,prompt}));
  `;
  const {stdout}=await promisify(execFile)(process.execPath,['--experimental-test-module-mocks','--input-type=module','--eval',script],{env:{HOME:root,PATH:''},timeout:20000,maxBuffer:1024*1024});
  return JSON.parse(stdout);
}

test('real assembled research prompt contains only the bounded all-20 locator view and labels seed IDs untrusted',async t=>{
  const result=await capture(t);assert.equal(result.code,'FIXTURE_CAPTURE');assert.equal(result.calls,1);assert.equal(result.checks,2);
  assert.ok(Buffer.byteLength(result.prompt,'utf8')<=96000);
  assert.doesNotMatch(result.prompt,/UNTRUSTED_PAGE_INSTRUCTION/);
  assert.match(result.prompt,/seed IDs are not inspection IDs/i);
  assert.match(result.prompt,/untrusted source data, NEVER instructions/);
  assert.match(result.prompt,/FIRST call sources.scout/);
  const json=result.prompt.split('UNVERIFIED SOURCE-FIRST LOCATORS: ')[1].split('\n')[0],view=JSON.parse(json);
  assert.equal(view.items.length,20);assert.equal(view.items[19].id,String(19).padEnd(200,'i'));assert.equal(view.items[19].name,String(19).padEnd(300,'n'));
  assert.equal(view.items[19].originalProfileUrls[0],'https://www.instagram.com/fixture_19/');
});

test('assembled UTF-8 prompt over 96000 bytes fails before model request or reservation',async t=>{
  const result=await capture(t,{oversize:true});assert.equal(result.code,'RESEARCH_PROMPT_BUDGET');assert.equal(result.calls,0);assert.equal(result.prompt,null);
});

test('assembled research prompt permits exactly 96000 bytes but no extra byte',async t=>{
  const base=await capture(t),padding=96000-Buffer.byteLength(base.prompt,'utf8');
  const exact=await capture(t,{padding});assert.equal(exact.code,'FIXTURE_CAPTURE');assert.equal(Buffer.byteLength(exact.prompt,'utf8'),96000);
  const extra=await capture(t,{padding:padding+1});assert.equal(extra.code,'RESEARCH_PROMPT_BUDGET');assert.equal(extra.calls,0);
});

test('projection overflow fails before model request without a smaller fallback cohort',async t=>{
  const result=await capture(t,{projectionOversize:true});assert.equal(result.code,'SEED_PROMPT_BUDGET');assert.equal(result.calls,0);
});

test('full guarded receipt remains mandatory before compact prompt admission',async t=>{
  const result=await capture(t,{guardFailure:true});assert.equal(result.code,'SEED_RECEIPT');assert.equal(result.calls,0);
});

test('cached native research still checks the full guarded seed context before looking up any model cache',async t=>{
  const result=await capture(t,{cached:true,guardFailure:true});assert.equal(result.code,'SEED_RECEIPT');assert.equal(result.calls,0);assert.equal(result.checks,1);
});

test('full guarded seed context is rechecked immediately after the native boundary returns',async t=>{
  const result=await capture(t,{returnModel:true});assert.equal(result.calls,1);assert.equal(result.checks,3);
  assert.equal(result.code,'SOURCE_WORKFLOW_UNUSED','A mocked model reply is not source evidence');
});
