import test from 'node:test';
import assert from 'node:assert/strict';
import {progressSnapshot} from '../src/progress.mjs';
import {now} from '../src/contracts.mjs';
test('only actual scout lifecycle events appear as honest progress, not arbitrary messages or success claims',()=>{
  const at=now(),store={events:()=>[{type:'scout.task_started',at,seq:1,message:'Untrusted raw target text'},{type:'scout.task_completed',at,seq:2},{type:'scout.task_blocked',at,seq:3},{type:'operator.note',at,seq:4,message:'Fake progress'}]};
  const b={state:'active',phase:'discovery',settings:{workflow:'leads_first'},acquisition:{version:1},deadlineAt:new Date(Date.now()+60000).toISOString(),members:[]};
  const p=progressSnapshot(store,b,[{id:'job-progress',kind:'discovery',state:'running',input:{phase:'discovery'}}]);
  assert.equal(p.activity.length,3);assert.match(p.activity[0].label,/Evidence scout/);assert.equal(JSON.stringify(p).includes('Untrusted raw target text'),false);
});
