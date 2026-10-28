import {detailsContract} from './helpers-interaction.mjs';
export const sitePages=['index','services','about','faq','contact'];
export function studioSiteData(candidate){
  const design={thesis:'Fictional photo-free local service concept',comparisons:['Type-led opening','Simple native disclosure','Direct contact action'],interaction:'Source-backed disclosure'};
  const css='body{font:18px/1.5 sans-serif;background:#f5f4e9;color:#182d23;margin:0;padding:16px}header,main,footer{max-width:960px;margin:0 auto}nav{display:flex;flex-wrap:wrap;gap:8px}a{display:inline-block;color:#173f28;padding:12px;min-height:24px}main{padding:20px 0}h1{font-size:clamp(28px,5vw,58px);line-height:1.1;overflow-wrap:anywhere}p{max-width:65ch}a:focus-visible,summary:focus-visible{outline:3px solid #145b3d;outline-offset:3px}summary{cursor:pointer;padding:12px}.primary{background:#183f2a;color:white;border-radius:4px}footer{font-size:14px;padding-top:24px}details{margin-top:24px}';
  const phone=candidate.contacts.phone||'+17135550101';
  const html=(page,study=false,index=0)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${page} · ${candidate.name}</title><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="assets/factory-motion.css"><script defer src="assets/factory-motion.js"></script></head><body><a href="#main">Skip to content</a><header><nav aria-label="Primary">${study?'<a href="#support">Services</a>':sitePages.map(p=>`<a href="${p}.html" ${p===page?'aria-current="page"':''}>${p}</a>`).join('')}</nav></header><main id="main"><h1 data-reveal="rise">${study?['Care at your doorstep','A clearer kind of clean','Your car, considered'][index]:candidate.name+' '+page}</h1><p>${candidate.area}</p><a class="primary" data-primary-action href="tel:${phone}">Call the business</a><section id="support"><h2>Published services</h2>${candidate.facts.map(f=>`<p>${f.text}</p>`).join('')}</section>${page==='index'?`<details id="fixture-details"><summary id="fixture-summary">What should I know?</summary><p id="fixture-output">${candidate.facts[0].text}</p></details>`:''}</main><footer>Independent private concept for a fictional test business. Not an official website.</footer></body></html>`;
  const files=sitePages.map(p=>({path:p+'.html',content:html(p)})).concat({path:'style.css',content:css});
  const studies=['A','B','C'].map((name,i)=>({name,design,files:[{path:'index.html',content:html('index',true,i)},{path:'style.css',content:css+`body{border-top:${i+1}px solid #183f2a}`}]}));
  const brief={audience:'Fixture customers only',primaryAction:'Call the published business phone',directions:['A','B','C'].map(name=>({name,thesis:'Fictional study '+name,desktop:'Source-backed type composition',phone:'Visible phone action'})),selectedDirection:0,selectionReason:'Fixture provisional direction',pageMap:sitePages.map(p=>({file:p+'.html',purpose:p,allowedFacts:candidate.facts.map(f=>f.id)})),design,signatureInteraction:detailsContract(candidate),motionPlan:[{target:'headline',purpose:'Progressive visible-content reveal'}],imageRoles:[],excludedClaims:['No invented portfolio']};
  return {design,files,studies,brief};
}
export function siteModelResponse(url,options,data){
  const body=JSON.parse(options.body||'{}');const content=body.messages?.at(-1)?.content;const prompt=Array.isArray(content)?content.find(v=>v.type==='text')?.text||'':content||body.input?.[0]?.content?.find(v=>v.type==='input_text')?.text||'';
  let output;
  if(prompt.includes('Inspect the attached photos in manifest order'))output={descriptions:['A solid green fictional fixture image, not a client portfolio photograph.']};
  else if(prompt.includes('Create a specific creative brief'))output=data.brief;
  else if(prompt.includes('Create THREE complete REAL browser-renderable'))output={studies:data.studies};
  else if(prompt.includes('Compare the ACTUAL attached rendered images'))output={selectedDirection:0,notes:['Fictional upstream selection, not actual creative acceptance'],blockingDefects:[]};
  else if(prompt.includes('Return the COMPLETE private static site'))output={files:data.files,design:data.design};
  else if(prompt.includes('Compare every page text'))output={checkedPages:sitePages.map(p=>p+'.html'),unsupportedClaims:[]};
  else if(prompt.includes('Inspect ALL attached ACTUAL page captures'))output={reviewer:'Fixture upstream visual check',notes:['Fictional review response; technical rendering is real'],blockingDefects:[],limitations:['Not a real model review'],humanDecision:null};
  else return null;
  return {status:200,bytes:Buffer.from(JSON.stringify({id:'fixture-model-response',model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:100}}))};
}
