import {readFile} from 'node:fs/promises';
import {safeRelative, fail} from './contracts.mjs';
import {fictionalBusiness, premiumExample, exampleIllustrations, illustrationMedia} from './premium-examples.mjs';

// Fixed authored examples on the isolated preview origin. Never reads state,
// credentials or user-selected paths, never calls a provider or queues work.
const demos=new Map();
const hostAssets={
  'assets/factory-motion.js':'../runtime/motion.js','assets/factory-motion.css':'../runtime/motion.css',
  'assets/factory-effects.js':'../runtime/effects.js','assets/factory-effects.css':'../runtime/effects.css',
  'assets/fonts/DMSans-Variable.ttf':'../web/assets/DMSans-Variable.ttf',
  'assets/fonts/OFL-DMSans.txt':'../web/assets/OFL-DMSans.txt',
};
export async function premiumDemoAsset(rawPath){
  const match=/^\/demo\/([0-2])\/(.*)$/.exec(rawPath);
  if(!match)fail('NOT_FOUND','Fictional demo not found');
  const index=Number(match[1]),relative=safeRelative(decodeURIComponent(match[2])||'index.html');
  if(hostAssets[relative])return{relative,bytes:await readFile(new URL(hostAssets[relative],import.meta.url))};
  if(!demos.has(index)){
    const media=index===2?illustrationMedia():[];
    const example=premiumExample(fictionalBusiness(index),{variant:index,media});
    demos.set(index,new Map([...example.files,...(index===2?exampleIllustrations():[])].map(f=>[f.path,Buffer.from(f.content)])));
  }
  const bytes=demos.get(index).get(relative);if(!bytes)fail('NOT_FOUND','Fictional demo file not found');
  return{relative,bytes};
}
