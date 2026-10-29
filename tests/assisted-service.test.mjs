import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {OPERATIONS} from '../src/service.mjs';

test('assisted intake uses the shared strict catalog; only explicit build kicks the ordinary worker',()=>{
  assert.equal(OPERATIONS.assisted_save?.readOnly,false);assert.equal(OPERATIONS.assisted_get?.readOnly,true);assert.equal(OPERATIONS.assisted_build?.readOnly,false);
  const script=`
    import {mock}from'node:test';import childProcess from'node:child_process';import{syncBuiltinESMExports}from'node:module';import{EventEmitter}from'node:events';
    await import(${JSON.stringify(new URL('../src/db.mjs',import.meta.url).href)});
    const url=${JSON.stringify(new URL('../src/assisted.mjs',import.meta.url).href)},actual=await import(url);let calls=0,kicks=0;
    mock.module(url,{namedExports:{...actual,assistedDispatch:async()=>{calls++;return{batch:{id:'batch-assisted-fixture'},job:{id:'job-assisted-fixture'}};}}});
    mock.method(childProcess,'spawn',()=>{kicks++;const child=new EventEmitter();child.unref=()=>{};return child;});syncBuiltinESMExports();
    const {createService}=await import(${JSON.stringify(new URL('../src/service.mjs',import.meta.url).href)}),service=createService({dbPath:'/tmp/assisted-service-unused.sqlite',stateRoot:'/tmp/assisted-service-unused'},{autoRun:true});
    const input={id:'assisted-fixture',bundleDigest:'a'.repeat(64),evidenceDigest:'b'.repeat(64),policyDigest:'c'.repeat(64),requestId:'fixture-explicit-assisted-build',authorized:true};
    await service.dispatch('assisted_get',{id:input.id});if(kicks!==0)throw Error('Read started work');await service.dispatch('assisted_build',input);
    let strict=false;try{await service.dispatch('assisted_build',{...input,resetDeadline:true});}catch(e){strict=e.code==='INVALID_INPUT';}
    console.log(JSON.stringify({calls,kicks,strict}));`;
  const child=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','--eval',script],{encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)),{calls:2,kicks:1,strict:true});
});
