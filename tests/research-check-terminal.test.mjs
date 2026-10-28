import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {checkResearchOutput,assertResearchChecked,RESEARCH_CHECK_RULES} from '../src/research-check.mjs';

async function fixture(){
  const root=await mkdtemp('/tmp/factory-check-terminal-'),directory=path.join(root,'sources');await mkdir(directory);
  return {directory,requestId:'f'.repeat(64),candidateLimit:3};
}
const output=()=>({candidates:[],shortfall:'Synthetic held output only; no qualification.'});
const invalid=()=>({...output(),unsupported:true});

test('invalid first check permits only the remaining correction; invalid second check terminates without changing slots or receipts',async()=>{
  const f=await fixture(),bad=invalid(),before=JSON.stringify(bad);
  const first=await checkResearchOutput({...f,output:bad});
  assert.equal(first.nextAction,'correct_within_remaining_check');assert.equal(first.terminal,false);assert.equal(first.checksRemaining,1);
  const second=await checkResearchOutput({...f,output:bad});
  assert.equal(second.nextAction,'stop_no_valid_submission');assert.equal(second.terminal,true);assert.equal(second.checksRemaining,0);
  assert.match(second.note,/No successful current check/);assert.match(second.note,/Do not emit unchecked amended final JSON/);
  assert.match(second.note,/claim success/);assert.match(second.note,/request another slot/);assert.match(second.note,/retry/);
  assert.doesNotMatch(second.note,/Correct malformed fields once/);
  assert.equal(second.fullQualification,false);assert.equal(second.humanAcceptance,false);assert.equal(JSON.stringify(bad),before);
  await assert.rejects(checkResearchOutput({...f,output:output()}),{code:'RESEARCH_CHECK_CAP'});
  await assert.rejects(assertResearchChecked({...f,output:output()}),{code:'RESEARCH_CHECK_MISSING'});
  const files=await readdir(f.directory);assert.equal(files.length,2);
  for(const name of files){
    const receipt=JSON.parse(await readFile(path.join(f.directory,name),'utf8'));
    assert.equal(receipt.version,1);assert.equal(receipt.valid,false);assert.equal(receipt.payloadDigest,null);assert.deepEqual(receipt.output,bad);
    assert.equal(Object.hasOwn(receipt,'nextAction'),false);assert.equal(Object.hasOwn(receipt,'terminal'),false);
  }
});

test('valid second check permits exact finalization, not a terminal failure or another correction',async()=>{
  const f=await fixture(),good=output();await checkResearchOutput({...f,output:invalid()});
  const second=await checkResearchOutput({...f,output:good});
  assert.equal(second.valid,true);assert.equal(second.check,2);assert.equal(second.checksRemaining,0);
  assert.equal(second.nextAction,'finalize_exact_checked_output');assert.equal(second.terminal,false);
  assert.match(second.note,/Return exactly/);assert.doesNotMatch(second.note,/Correct malformed fields once/);
  await assertResearchChecked({...f,output:good});
  await assert.rejects(assertResearchChecked({...f,output:{...good,shortfall:'Unchecked edit'}}),{code:'RESEARCH_CHECK_MISMATCH'});
  await assert.rejects(checkResearchOutput({...f,output:good}),{code:'RESEARCH_CHECK_CAP'});
});

test('invalid last check explicitly stops even after an earlier success; rules forbid unchecked JSON recovery',async()=>{
  const f=await fixture(),good=output(),first=await checkResearchOutput({...f,output:good});
  assert.equal(first.nextAction,'finalize_exact_checked_output');assert.equal(first.terminal,false);
  const last=await checkResearchOutput({...f,output:invalid()});
  assert.equal(last.nextAction,'stop_no_valid_submission');assert.equal(last.terminal,true);
  await assert.rejects(assertResearchChecked({...f,output:good}),{code:'RESEARCH_CHECK_MISSING'});
  assert.match(RESEARCH_CHECK_RULES,/If the last check is invalid and no checks remain/);
  assert.match(RESEARCH_CHECK_RULES,/unchecked amended final JSON/);
});
