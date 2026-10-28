import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {acquisitionPolicy} from '../src/acquisition.mjs';

test('the actual new-mode native prompt uses host scouting and complete material shapes, not social-only search or discovery image views',async()=>{
  const root=await mkdtemp('/tmp/factory-scout-prompt-'),bin=path.join(root,'bin'),sources=path.join(root,'job/sources'),capture=path.join(root,'argv.json');
  await mkdir(bin);await mkdir(sources,{recursive:true});
  await writeFile(path.join(sources,'search-acde123.json'),JSON.stringify({provider:'firecrawl',intent:'discover',status:'completed',query:'Houston Synthetic workshops',at:new Date().toISOString(),results:[{url:'https://fixture.example/',title:'Houston Synthetic workshops'}]}));
  await writeFile(path.join(bin,'opencode'),`#!${process.execPath}
    (async()=>{const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));const output={candidates:[],shortfall:'Isolated prompt fixture only'};
    const {checkResearchOutput}=await import(${JSON.stringify(new URL('../src/research-check.mjs',import.meta.url).href)});await checkResearchOutput({directory:process.env.FACTORY_SOURCES,requestId:process.env.FACTORY_RESEARCH_REQUEST,candidateLimit:Number(process.env.FACTORY_RESEARCH_LIMIT),output});
    console.log(JSON.stringify({type:'text',sessionID:'fixture',part:{text:JSON.stringify(output)}}));})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});`,{mode:0o700});
  const script=`import {discover} from ${JSON.stringify(new URL('../src/research.mjs',import.meta.url).href)};await discover({candidateLimit:3,area:'Houston city limits',niche:'Synthetic workshops',deadlineMinutes:2},{jobRoot:${JSON.stringify(path.dirname(sources))},batch:{settings:{workflow:'leads_first',searchProvider:'firecrawl'},acquisition:${JSON.stringify(acquisitionPolicy())},phase:'discovery',seen:[],budget:{}}});`;
  await promisify(execFile)(process.execPath,['--input-type=module','--eval',script],{env:{PATH:bin,HOME:root},timeout:20000});
  const args=JSON.parse(await readFile(capture,'utf8')),prompt=args.at(-1);
  assert.equal(args[args.indexOf('--model')+1],'openai/gpt-6.1-sol-fast');assert.match(prompt,/EVIDENCE-FIRST DISCOVERY v1/);
  assert.match(prompt,/FIRST call sources.scout/);assert.match(prompt,/Retain EVERY registered draft identity/);assert.match(prompt,/Do NOT call sources.image/);
  assert.match(prompt,/candidate_listing/);assert.match(prompt,/at most four candidate-listing searches/i);assert.match(prompt,/snippets only locate possible listings/i);
  assert.match(prompt,/Optional activityEvidence is/);assert.match(prompt,/Optional media entries are/);assert.doesNotMatch(prompt,/Prioritize social-first category\/city queries/);
  assert.match(prompt,/question\.purpose is search_result/);assert.match(prompt,/already inspected discovery locator/);
  assert.match(prompt,/Do not inspect that same route again/);assert.match(prompt,/three route inspections per receipt and four per job/);
   assert.match(prompt,/never derive a profile from a post/);assert.match(prompt,/observed potential independent website before secondary social/i);
   assert.match(prompt,/After a scout registration error, do not spend a check on that rejected or edited draft/);
   assert.match(prompt,/Retain the last successfully registered complete draft and ALL original account anchors/);
   assert.match(prompt,/Registration feedback does not authorize another source attempt/);
});
