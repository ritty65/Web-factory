import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import {premiumExample} from '../src/premium-examples.mjs';
import {hash} from '../src/contracts.mjs';
import {DESIGN_REFERENCE_SEEDS} from '../src/design-references.mjs';
import {CINEMATIC_PROFILE} from '../src/site-profile.mjs';

export const cinematicTags='<link rel="stylesheet" href="assets/factory-cinematic.css"><script defer src="assets/factory-gsap.js"></script><script defer src="assets/factory-scrolltrigger.js"></script><script defer src="assets/factory-lenis.js"></script><script defer src="assets/factory-cinematic.js"></script>';
export function directorExample(candidate){
 const e=premiumExample(candidate);e.brief.effectsPlan.profile=CINEMATIC_PROFILE;
 for(const effect of e.brief.effectsPlan.effects)if(effect.type==='split-text')effect.type='split-chars';
 for(const f of [...e.files,...e.studies.flatMap(s=>s.files)])if(f.path.endsWith('.html'))f.content=f.content.replace('data-effect="split-text"','data-effect="split-chars"').replace('</head>',cinematicTags+'</head>');
 e.brief.creativeIntent=Object.fromEntries(['businessInsight','openingConcept','typography','imageTreatment','sectionRhythm','signatureScene'].map(k=>[k,'Explicit fictional '+k+' observation, not creative acceptance.']));
 const home=e.files.filter(f=>!f.path.endsWith('.html')||f.path==='index.html').map(f=>({...f,content:f.path==='index.html'?f.content.replace(/href="(?:services|about|faq|contact)\.html"/g,'href="index.html"'):f.content}));
 e.homepage={design:e.design,files:home};e.additions={files:e.files.filter(f=>f.path.endsWith('.html')&&f.path!=='index.html')};return e;
}
export async function referenceFixtures(store){
 for(const [index,seed]of DESIGN_REFERENCE_SEEDS.slice(0,2).entries()){
  const captures=[];
  for(let i=0;i<2;i++){
   const relative=`reference-fixtures/${seed.id}-${i}.png`,file=path.join(store.stateRoot,relative);
   const bytes=await sharp({create:{width:1440,height:900,channels:3,background:index?'#b08964':'#283d4d'}}).composite([{input:Buffer.from('<svg width="1440" height="900"><rect x="100" y="100" width="700" height="400" fill="#eee"/></svg>')}]).png().toBuffer();
   await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);
   const artifact=store.artifact({relative,kind:'reference_capture',bytes:bytes.length,sha256:hash(bytes)});
   captures.push({relative,kind:i?'desktop-scroll':'desktop-opening',viewport:[1440,900],visuallyNonempty:true,contentReady:true,sha256:hash(bytes),artifact});
  }
  store.saveReference({...seed,status:'inspected',inspectedAt:new Date().toISOString(),captures,observation:'Owned fictional reference fixture; no real external design inspection.'});
 }
}
export function creativeReview(manifest,verdict='pass'){
 return{verdict,criteria:Object.fromEntries(['identity','composition','typography','imagery','businessFit','motionPurpose','mobile'].map(k=>[k,{status:verdict,observation:'Injected fictional review finding for '+k+', not live visual judgment.',captureRefs:[manifest[0]?.captureId||'0']} ])),blockingDefects:verdict==='hold'?['Injected fictional creative blocker, not a model observation.']:[],notes:['Injected review; only the browser execution is real.']};
}
export function directorResponse(url,options,e,{hold=false,calls=[]}={}){
 const body=JSON.parse(options.body||'{}'),content=body.messages?.at(-1)?.content,prompt=Array.isArray(content)?content.find(v=>v.type==='text')?.text||'':content||'';
 const task=prompt.match(/DIRECTOR_[A-Z]+/)?.[0];if(!task)return null;calls.push({task,body});let output;
 if(task==='DIRECTOR_BRIEF')output=e.brief;
 else if(task==='DIRECTOR_STUDIES')output={studies:e.studies};
 else if(task==='DIRECTOR_SELECT')output={selectedDirection:0,notes:['Injected fictional direction selection.'],blockingDefects:[]};
 else if(task==='DIRECTOR_HOMEPAGE')output=e.homepage;
 else if(task==='DIRECTOR_EXPANSION')output=e.additions;
 else if(task==='DIRECTOR_FACTS')output={checkedPages:e.files.filter(f=>f.path.endsWith('.html')).map(f=>f.path),unsupportedClaims:[]};
 else if(task==='DIRECTOR_REVIEW')output=creativeReview([{captureId:'0'}],hold?'hold':'pass');
 else throw Error('Unhandled director fixture task: '+task);
 return{status:200,bytes:Buffer.from(JSON.stringify({id:'fictional-director-response',model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:100}}))};
}
