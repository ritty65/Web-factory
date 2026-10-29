// Explicit manual-proof route: never labels hand-authored files as AI generation.
import path from 'node:path';import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {checkSite} from '../src/qa.mjs';import {packageReview} from '../src/package.mjs';
const file=process.argv[2];if(!file)throw Error('Usage: node scripts/check-private-concept.mjs /absolute/private/case.json');
const input=JSON.parse(await readFile(file,'utf8')),base=path.dirname(path.resolve(file));
const siteRoot=path.resolve(base,input.siteRoot),outputRoot=path.resolve(base,input.outputRoot);
await mkdir(outputRoot,{recursive:true,mode:0o700});
const qa=await checkSite({siteRoot,outputRoot:path.join(outputRoot,'qa'),candidate:input.candidate,media:input.media,effectsPlan:input.effectsPlan,interaction:input.interaction});
let pack=null;if(qa.pass)pack=await packageReview({siteRoot,outputRoot:path.join(outputRoot,'package'),candidate:input.candidate,media:input.media,qa,design:input.design,effectsPlan:input.effectsPlan,designEvidence:{creationMethod:'manually_authored_private_proof',automaticAiGeneration:false,sourceProof:input.sourceProof,humanDecision:null}});
const result={creationMethod:'manually_authored_private_proof',automaticAiGeneration:false,qaPass:qa.pass,pageChecks:qa.pageChecks.length,effectsChecks:qa.effectsChecks?.length,issues:qa.issues,archive:pack?.archive||null,siteDigest:pack?.siteDigest||qa.siteDigest,publicRelease:false,humanDecision:null};
await writeFile(path.join(outputRoot,'proof-result.json'),JSON.stringify(result,null,2),{mode:0o600});process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!qa.pass)process.exitCode=1;
