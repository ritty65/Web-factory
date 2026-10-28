import test from 'node:test';
import assert from 'node:assert/strict';
import {assistedDispatch} from '../src/assisted.mjs';
import {assistedFixture,assistedStore} from './helpers-assisted.mjs';

test('external searches can retain an honest observation window with a conservative freshness timestamp',async t=>{
  const store=await assistedStore(t),input=await assistedFixture();
  for(const s of input.bundle.searches){s.timePrecision='session_window_lower_bound';s.observedWithin={from:input.scope.startedAt,to:s.at};s.at=s.observedWithin.from;}
  const saved=await assistedDispatch(store,'assisted_save',input);assert.equal(saved.assessment.ready,true);
});
test('external search windows cannot invent precise time, renew freshness or escape source limits',async t=>{
  for(const change of [s=>delete s.observedWithin,s=>{s.at=new Date(Date.parse(s.observedWithin.from)+1000).toISOString();},s=>{s.observedWithin.to='2100-01-01T00:00:00.000Z';},s=>{s.observedWithin.to='2000-01-01T00:00:00.000Z';},s=>delete s.timePrecision]){
    const store=await assistedStore(t),input=await assistedFixture();
    for(const s of input.bundle.searches){s.timePrecision='session_window_lower_bound';s.observedWithin={from:input.scope.startedAt,to:s.at};s.at=s.observedWithin.from;change(s);}
    await assert.rejects(assistedDispatch(store,'assisted_save',input),e=>['ASSISTED_CAPTURE_TIME','INVALID_INPUT'].includes(e.code));
    assert.equal(store.db.prepare("SELECT count(*) n FROM factory_operation WHERE kind='assisted_bundle'").get().n,0);
  }
});
