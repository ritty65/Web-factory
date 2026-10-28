import {premiumExample, EXAMPLE_PAGES} from '../src/premium-examples.mjs';
export const sitePages=EXAMPLE_PAGES;
export function studioSiteData(candidate, options={}) { return premiumExample(candidate, options); }
export function siteModelResponse(url,options,data){
  const body=JSON.parse(options.body||'{}');const content=body.messages?.at(-1)?.content;const prompt=Array.isArray(content)?content.find(v=>v.type==='text')?.text||'':content||body.input?.[0]?.content?.find(v=>v.type==='input_text')?.text||'';
  let output;
  if(prompt.includes('Inspect the attached photos in manifest order'))output={descriptions:Array.from({length:Array.isArray(content)?content.filter(v=>v.type==='image_url'||v.type==='input_image').length:1},()=> 'A controlled fictional fixture image, not evidence of real client work.')};
  else if(prompt.includes('Create a specific creative brief'))output=data.brief;
  else if(prompt.includes('Create THREE complete REAL browser-renderable'))output={studies:data.studies};
  else if(prompt.includes('Compare the ACTUAL attached rendered images'))output={selectedDirection:data.brief.selectedDirection,notes:['Fictional upstream selection, not actual creative acceptance'],blockingDefects:[]};
  else if(prompt.includes('Return the COMPLETE private static site'))output={files:data.files,design:data.design};
  else if(prompt.includes('Compare every page text'))output={checkedPages:sitePages.map(p=>p+'.html'),unsupportedClaims:[]};
  else if(prompt.includes('Inspect ALL attached ACTUAL page captures'))output={reviewer:'Fixture upstream visual check',notes:['Fictional review response; technical rendering is real'],blockingDefects:[],limitations:['Not a real model review'],humanDecision:null};
  else return null;
  return {status:200,bytes:Buffer.from(JSON.stringify({id:'fixture-model-response',model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:100}}))};
}
