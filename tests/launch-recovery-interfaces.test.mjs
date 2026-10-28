import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {OPERATIONS} from '../src/service.mjs';

test('same-run launch recovery shares the strict catalog and kicks only the normal worker after successful dispatch',()=>{
  assert.equal(OPERATIONS.batch_recover_launch?.readOnly,false);
  const source=`
    import {mock} from 'node:test';import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {EventEmitter}from'node:events';
    await import(${JSON.stringify(new URL('../src/db.mjs',import.meta.url).href)});
    const url=${JSON.stringify(new URL('../src/batches.mjs',import.meta.url).href)},batches=await import(url);let dispatches=0,kicks=0;
    mock.module(url,{namedExports:{...batches,batchDispatch:async()=>{dispatches++;return{batch:{id:'batch-fixture'},job:{id:'job-fixture'}};}}});
    mock.method(childProcess,'spawn',()=>{kicks++;const child=new EventEmitter();child.unref=()=>{};return child;});syncBuiltinESMExports();
    const{createService}=await import(${JSON.stringify(new URL('../src/service.mjs',import.meta.url).href)});
    const service=createService({dbPath:'/tmp/fake-recovery-fixture.sqlite',stateRoot:'/tmp/fake-recovery-fixture'},{autoRun:true});
    const input={id:'batch-fixture',failedJobId:'job-fixture',policyDigest:'a'.repeat(64),requestId:'fixture-launch-recovery',authorized:true};
    const result=await service.dispatch('batch_recover_launch',input);let strict=false;try{await service.dispatch('batch_recover_launch',{...input,resetDeadline:true});}catch(e){strict=e.code==='INVALID_INPUT';}
    console.log(JSON.stringify({dispatches,kicks,strict,childReturned:result.job.id==='job-fixture'}));`;
  const child=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','--eval',source],{encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)),{dispatches:1,kicks:1,strict:true,childReturned:true});
});
