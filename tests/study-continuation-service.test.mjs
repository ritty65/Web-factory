import test from 'node:test';
import assert from 'node:assert/strict';
import {OPERATIONS}from'../src/service.mjs';
test('the shared service exposes explicit strict study continuation, not a general retry',()=>{
 const op=OPERATIONS.study_continue;assert.equal(op?.readOnly,false);const value={id:'job-study-fixture',renderDigest:'a'.repeat(64),policyDigest:'b'.repeat(64),requestId:'explicit-study-fixture',authorized:true};assert.equal(op.schema.safeParse(value).success,true);for(const bad of [{...value,authorized:false},{...value,resetDeadline:true},{...value,renderDigest:'wrong'}])assert.equal(op.schema.safeParse(bad).success,false);
});
