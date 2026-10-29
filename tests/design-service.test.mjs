import test from 'node:test';
import assert from 'node:assert/strict';
import{OPERATIONS}from'../src/service.mjs';
test('normal design workbench operations are strict and distinguish reading from explicit generation',()=>{
 assert.equal(OPERATIONS.design_context_get?.readOnly,true);assert.equal(OPERATIONS.assisted_redesign?.readOnly,false);
 assert.equal(OPERATIONS.design_context_get.schema.safeParse({id:'job-fixture'}).success,true);
 const input={id:'job-fixture',siteDigest:'a'.repeat(64),policyDigest:'b'.repeat(64),requestId:'explicit-redesign-fixture',authorized:true,feedback:'Make the service pages useful and distinct.',contentFacts:[]};
 assert.equal(OPERATIONS.assisted_redesign.schema.safeParse(input).success,true);
 for(const bad of [{...input,resetBudget:true},{...input,authorized:false},{...input,contentFacts:[{sourceId:'source-fixture',excerpt:'Observed',text:'Observed',fakeNativeReceipt:true}]}])assert.equal(OPERATIONS.assisted_redesign.schema.safeParse(bad).success,false);
});
