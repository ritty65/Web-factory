import test from 'node:test';
import assert from 'node:assert/strict';
import {passingStudyEvidence,assertPassingStudySelection} from '../src/production.mjs';
test('failed alternatives are retained but only passing original study indices reach selection',()=>{
 const rendered={pass:false,studies:[{index:0,pass:false},{index:1,pass:true},{index:2,pass:true}],captures:[0,1,2].flatMap(index=>[1280,390].map(width=>({index,viewport:[width,800],relative:`study-${index}-${width}.png`})))};
 const eligible=passingStudyEvidence(rendered);assert.deepEqual(eligible.studies.map(s=>s.index),[1,2]);assert.deepEqual(eligible.captures.map(s=>s.index),[1,1,2,2]);assert.equal(rendered.studies.length,3);assert.equal(eligible.pass,true);
 assert.doesNotThrow(()=>assertPassingStudySelection(eligible,{selectedDirection:2}));assert.throws(()=>assertPassingStudySelection(eligible,{selectedDirection:0}),e=>e.code==='DESIGN_SELECTION');
});
test('no valid alternative or missing desktop/phone evidence still blocks production',()=>{
 for(const value of [{studies:[{index:0,pass:false}],captures:[]},{studies:[{index:1,pass:true}],captures:[{index:1,viewport:[1280,720]}]}])assert.throws(()=>passingStudyEvidence(value),e=>e.code==='DESIGN_STUDY_QA');
});
