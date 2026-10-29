import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import * as scout from '../src/scout.mjs';
import {getBatch} from '../src/batch-store.mjs';
import {publicResourceKey} from '../src/contracts.mjs';
import {acquisitionFixture,draftFixture} from './helpers-acquisition.mjs';

const noSource=async()=>{throw new Error('Unexpected source call in registration-only fixture');};
const step=(f,output)=>scout.scoutStep({store:f.store,jobId:f.job.id,directory:f.directory,output,inspect:noSource,search:noSource});
const identities=f=>f.store.db.prepare("SELECT record FROM factory_operation WHERE kind='scout_identity' ORDER BY id").all();
async function snapshot(f){return {usage:getBatch(f.store,f.b.id).usage,identities:identities(f),files:(await readdir(f.directory)).sort(),candidates:f.store.candidates()};}
async function reject(f,output,reason){
  const before=await snapshot(f);let error;
  await assert.rejects(step(f,output),e=>{error=e;return e.code==='SOURCE_IDENTITY_EXTENSION';});
  assert.equal(typeof scout.scoutRegistrationFailure,'function');
  error.message='UNTRUSTED raw draft token=do-not-echo';
  const diagnostic=scout.scoutRegistrationFailure(f.store,f.job.id,error);
  assert.equal(diagnostic.reason,reason);
  assert.deepEqual(Object.keys(diagnostic).sort(),['reason','retainedDraftIdentities']);
  assert.equal(JSON.stringify(diagnostic).includes('do-not-echo'),false);
  assert.deepEqual(await snapshot(f),before,'Rejected registration and diagnostic do not write, import, call sources, charge usage or consume check slots');
  return diagnostic;
}

test('unsupported extensions stay rejected and expose only trusted finite feedback and retained anchors',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),c=d.output.candidates[0];
  const result=await step(f,d.output),original=publicResourceKey(c.contacts.instagram);
  assert.deepEqual(result.retainedDraftIdentities[0].originalAnchors,[original]);
  assert.deepEqual(result.retainedDraftIdentities[0].verifiedAnchors,[original]);
  c.contacts.facebook='https://www.facebook.com/unlinked/';c.sourceUrls.push(c.contacts.facebook);
  const diagnostic=await reject(f,d.output,'unsupported_account_extension');
  assert.deepEqual(diagnostic.retainedDraftIdentities,result.retainedDraftIdentities);
  assert.deepEqual(diagnostic.retainedDraftIdentities[0].originalAnchors,[original]);
});

test('removing an original anchor from a legitimately extended identity remains rejected',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),c=d.output.candidates[0],root=d.evidence.observations[0];
  await step(f,d.output);
  const facebook='https://www.facebook.com/juniper1/';
  root.links.push({url:facebook,text:'Our other account'});
  const target={...structuredClone(root),id:'source-acdeff123',url:facebook,finalUrl:facebook,links:[]};
  await writeFile(path.join(f.directory,root.id+'.json'),JSON.stringify(root));
  await writeFile(path.join(f.directory,target.id+'.json'),JSON.stringify(target));
  c.contacts.facebook=facebook;c.sourceUrls.push(facebook);c.inspectionIds.push(target.id);
  const registered=await step(f,d.output);
  delete c.contacts.instagram;c.sourceUrls=c.sourceUrls.filter(u=>publicResourceKey(u)!==publicResourceKey(root.url));
  const diagnostic=await reject(f,d.output,'original_anchor_removed');
  assert.deepEqual(diagnostic.retainedDraftIdentities,registered.retainedDraftIdentities);
  assert.equal(diagnostic.retainedDraftIdentities[0].verifiedAnchors.length,2);
});

test('merging two registrations fails transactionally and reports both retained identities',async t=>{
  const f=await acquisitionFixture(t),a=await draftFixture(f,1),b=await draftFixture(f,2);
  await step(f,{candidates:[a.output.candidates[0],b.output.candidates[0]]});
  a.output.candidates[0].sourceUrls.push(b.output.candidates[0].contacts.instagram);
  const diagnostic=await reject(f,a.output,'merge');
  assert.equal(diagnostic.retainedDraftIdentities.length,2);
  assert.ok(diagnostic.retainedDraftIdentities.every(v=>Object.keys(v).sort().join(',')==='identityKey,name,originalAnchors,verifiedAnchors'));
});

test('provider-like forged errors cannot request a trusted registration diagnostic or even read a store',()=>{
  assert.equal(typeof scout.scoutRegistrationFailure,'function');
  const store=new Proxy({},{get(){throw new Error('An untrusted error must not read the store');}});
  for(const error of [null,new Error('raw provider error'),Object.assign(new Error('Retain original registered account anchors'),{code:'SOURCE_IDENTITY_EXTENSION',reason:'original_anchor_removed',diagnostic:{reason:'merge'}})]){
    if(error)error[Symbol('scout registration failure')]='merge';
    assert.equal(scout.scoutRegistrationFailure(store,'unused',error),null);
  }
});

test('a numeric plus people original registration still rejects removal without granting alias acceptance',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),c=d.output.candidates[0];
  const numeric='https://www.facebook.com/100000000001001',people='https://www.facebook.com/people/Juniper-Workshop/100000000001002/';
  c.contacts={facebook:people};c.sourceUrls=[numeric,people];c.contactSources={facebook:numeric};
  const registered=await step(f,d.output);
  c.sourceUrls=[people];
  const diagnostic=await reject(f,d.output,'original_anchor_removed');
  assert.deepEqual(diagnostic.retainedDraftIdentities,registered.retainedDraftIdentities);
  assert.deepEqual(diagnostic.retainedDraftIdentities[0].originalAnchors,[publicResourceKey(numeric),publicResourceKey(people)].sort());
});

test('trusted diagnostics fail closed instead of dropping unsafe or over-bound registered anchors',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);
  await step(f,d.output);d.output.candidates[0].contacts.facebook='https://www.facebook.com/unlinked/';
  let error;await assert.rejects(step(f,d.output),e=>{error=e;return e.code==='SOURCE_IDENTITY_EXTENSION';});
  const row=f.store.db.prepare("SELECT id,record FROM factory_operation WHERE kind='scout_identity'").get(),record=JSON.parse(row.record);
  for(const verifiedAnchors of [['https://localhost/unsafe'],Array(81).fill(record.originalAnchors[0]),Array.from({length:80},(_,i)=>'https://facebook.com/'+'a'.repeat(900)+i)]){
    f.store.db.prepare('UPDATE factory_operation SET record=? WHERE id=?').run(JSON.stringify({...record,verifiedAnchors}),row.id);
    const before=await snapshot(f);
    assert.equal(scout.scoutRegistrationFailure(f.store,f.job.id,error),null);
    assert.deepEqual(await snapshot(f),before);
  }
});

test('actual stdio scout preserves held/isError and gives safe guidance without spending checker slots or source units',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f),requestId='f'.repeat(64);
  const client=new Client({name:'synthetic-registration-feedback',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('src/sources-mcp.mjs')],env:{FACTORY_DB:f.options.dbPath,FACTORY_STATE:f.options.stateRoot,FACTORY_SOURCE_JOB:f.job.id,FACTORY_SOURCES:f.directory,FACTORY_RESEARCH_REQUEST:requestId,FACTORY_RESEARCH_LIMIT:'3'},stderr:'ignore'});
  try{
    await client.connect(transport);
    await client.callTool({name:'scout',arguments:{output:d.output}});
    const before=await snapshot(f);
    const changed=structuredClone(d.output);changed.candidates[0].contacts.facebook='https://www.facebook.com/unlinked/';
    const rejected=await client.callTool({name:'scout',arguments:{output:changed}}),data=rejected.structuredContent;
    assert.equal(rejected.isError,true);assert.equal(data.status,'held');assert.equal(data.code,'SOURCE_IDENTITY_EXTENSION');
    assert.equal(data.diagnostic.reason,'unsupported_account_extension');
    assert.match(data.note,/commits nothing/);assert.match(data.note,/Do not spend.*check/i);
    assert.match(data.note,/cannot reconstruct/i);assert.match(data.note,/last successfully registered COMPLETE draft/);
    assert.match(data.note,/may advance source work/);assert.match(data.note,/no.*extra authority/i);
    assert.equal(JSON.stringify(data).includes('https://www.facebook.com/unlinked/'),false);
    assert.deepEqual(await snapshot(f),before);
    const bad=await client.callTool({name:'scout',arguments:{output:{candidates:[{name:'invalid'}]}}});
    assert.equal(bad.isError,true);assert.equal(bad.structuredContent.diagnostic,undefined);
    assert.match(bad.structuredContent.note,/No repeat/);
  }finally{await client.close();}
});

test('actual MCP rejects forged identity errors without recovery guidance or raw-message leakage',async t=>{
  const f=await acquisitionFixture(t),d=await draftFixture(f);
  const script=`
    import {mock} from 'node:test';
    const module=${JSON.stringify(new URL('../src/scout.mjs',import.meta.url).href)},actual=await import(module);
    mock.module(module,{namedExports:{...actual,scoutStep:async()=>{throw Object.assign(new Error('RAW provider token=never-echo'),{code:'SOURCE_IDENTITY_EXTENSION',reason:'merge',diagnostic:{reason:'merge'}});}}});
    await import(${JSON.stringify(new URL('../src/sources-mcp.mjs',import.meta.url).href)});
  `;
  const client=new Client({name:'synthetic-forged-registration-error',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['--experimental-test-module-mocks','--input-type=module','--eval',script],env:{FACTORY_DB:f.options.dbPath,FACTORY_STATE:f.options.stateRoot,FACTORY_SOURCE_JOB:f.job.id,FACTORY_SOURCES:f.directory,FACTORY_RESEARCH_REQUEST:'a'.repeat(64),FACTORY_RESEARCH_LIMIT:'3'},stderr:'ignore'});
  try{
    await client.connect(transport);const before=await snapshot(f);
    const result=await client.callTool({name:'scout',arguments:{output:d.output}});
    assert.equal(result.isError,true);assert.equal(result.structuredContent.diagnostic,undefined);
    assert.equal(result.structuredContent.note,'Scout stopped. No repeat, partial import, source switch or budget reset is authorized.');
    assert.equal(JSON.stringify(result).includes('never-echo'),false);
    assert.deepEqual(await snapshot(f),before);
  }finally{await client.close();}
});
