import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
async function fixture(mode){
  const root=await mkdtemp('/tmp/factory-final-check-'),bin=path.join(root,'bin'),jobRoot=path.join(root,'job');await mkdir(bin);await mkdir(path.join(jobRoot,'sources'),{recursive:true});
  await writeFile(path.join(jobRoot,'sources/search-aabbcc.json'),JSON.stringify({provider:'firecrawl',status:'completed',intent:'verify',query:'Synthetic',results:[{url:'https://business.example/',title:'Synthetic business'}]}));
  await writeFile(path.join(bin,'opencode'),`#!${process.execPath}
(async()=>{
 const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(path.join(root,'launches'))},'one\\n');
 const output={candidates:[],shortfall:'Synthetic only; zero real sources or models'};
 if(${JSON.stringify(mode)}!=='missing'){
  const {checkResearchOutput}=await import(${JSON.stringify(new URL('../src/research-check.mjs',import.meta.url).href)});
  const first=structuredClone(output);if(${JSON.stringify(mode)}==='corrected')first.extra='unsupported';
  await checkResearchOutput({directory:process.env.FACTORY_SOURCES,requestId:process.env.FACTORY_RESEARCH_REQUEST,candidateLimit:Number(process.env.FACTORY_RESEARCH_LIMIT),output:first});
  if(${JSON.stringify(mode)}==='corrected')await checkResearchOutput({directory:process.env.FACTORY_SOURCES,requestId:process.env.FACTORY_RESEARCH_REQUEST,candidateLimit:Number(process.env.FACTORY_RESEARCH_LIMIT),output});
 }
 if(${JSON.stringify(mode)}==='changed')output.shortfall+=' unchecked change';
 console.log(JSON.stringify({type:'text',sessionID:'fixture-only',part:{text:JSON.stringify(output)}}));
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});`,{mode:0o700});
  const script=`import {discover} from ${JSON.stringify(new URL('../src/research.mjs',import.meta.url).href)};try{const result=await discover({candidateLimit:3,area:'Houston',niche:'Synthetic only',deadlineMinutes:2},{jobRoot:${JSON.stringify(jobRoot)},batch:{settings:{searchProvider:'firecrawl',workflow:'leads_first'},phase:'discovery',seen:[]}});console.log(JSON.stringify({result}));}catch(e){console.log(JSON.stringify({errorCode:e.code}));}`;
  const result=JSON.parse((await exec(process.execPath,['--input-type=module','--eval',script],{env:{PATH:bin,HOME:root},timeout:15000})).stdout);
  return {root,jobRoot,result,launches:(await readFile(path.join(root,'launches'),'utf8')).trim().split('\n').length};
}
test('final native text without a successful same-request check fails before adoption, with no second launch',async()=>{
  const f=await fixture('missing');assert.equal(f.result.errorCode,'RESEARCH_CHECK_MISSING');assert.equal(f.result.result,undefined);assert.equal(f.launches,1);
});
test('changing final text after its successful tool check fails exact content binding',async()=>{
  const f=await fixture('changed');assert.equal(f.result.errorCode,'RESEARCH_CHECK_MISMATCH');assert.equal(f.launches,1);
});
test('one correction inside the original native request returns checked honest shortfall without a new launch',async()=>{
  const f=await fixture('corrected');assert.equal(f.result.errorCode,undefined);assert.deepEqual(f.result.result.candidates,[]);assert.equal(f.launches,1);assert.match(f.result.result.researchSubmission.requestId,/^[a-f0-9]{64}$/);
});
