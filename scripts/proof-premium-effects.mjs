// Authored examples, real Chromium and ZIP checks. Zero model/provider calls.
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fictionalBusiness,premiumExample,exampleIllustrations,illustrationMedia} from '../src/premium-examples.mjs';
import {PREMIUM_PROFILE} from '../src/effects-contract.mjs';
import {stageRuntime} from '../src/craft.mjs';
import {stageProposal} from '../src/proposal.mjs';
import {checkSite} from '../src/qa.mjs';
import {packageReview} from '../src/package.mjs';
import {hash} from '../src/contracts.mjs';
const output=path.resolve(process.env.FACTORY_EFFECTS_PROOF_OUTPUT||'.artifacts/premium-effects-'+Date.now());
await mkdir(output,{recursive:true,mode:0o700});
const report={at:new Date().toISOString(),verification:'authored_fictional_examples_actual_chromium',realProviderCalls:0,humanAcceptances:0,publicRelease:false,examples:[],limitations:['These are authored examples and original illustrations, not actual AI designs or customer work.','Chromium lab tests are not physical-device, field-performance or live-provider acceptance.']};
for(let variant=0;variant<3;variant++){
  const candidate=fictionalBusiness(variant),media=variant===2?illustrationMedia():[],example=premiumExample(candidate,{variant,media}),root=path.join(output,'example-'+variant),siteRoot=path.join(root,'site');
  await stageRuntime(siteRoot,{designProfile:PREMIUM_PROFILE});
  await stageProposal(siteRoot,{design:example.design,files:[...example.files,...(variant===2?exampleIllustrations():[])]});
  const qa=await checkSite({siteRoot,outputRoot:path.join(root,'qa'),candidate,media,interaction:example.brief.signatureInteraction,effectsPlan:example.brief.effectsPlan});
  if(!qa.pass){process.stderr.write(JSON.stringify(qa.issues,null,2)+'\n');throw Error('Example '+variant+' failed; inspect '+root);}
  const pack=await packageReview({siteRoot,outputRoot:path.join(root,'package'),candidate,media,qa,design:example.design,effectsPlan:example.brief.effectsPlan});
  if(hash(await readFile(path.join(root,'package',pack.archive)))!==pack.sha256)throw Error('Archive hash mismatch');
  report.examples.push({variant,name:candidate.name,effectFamilies:[...new Set(example.brief.effectsPlan.effects.map(e=>e.type))],pageViewportChecks:qa.pageChecks.length,effectViewportChecks:qa.effectsChecks.length,siteDigest:pack.siteDigest,archiveSha256:pack.sha256,qaPass:qa.pass});
  process.stdout.write('Authored example '+variant+': '+report.examples.at(-1).effectFamilies.length+' families; actual browser and exact ZIP passed.\n');
}
await writeFile(path.join(output,'proof.json'),JSON.stringify(report,null,2),{mode:0o600});
process.stdout.write('Private effect proof: '+output+'\n');
