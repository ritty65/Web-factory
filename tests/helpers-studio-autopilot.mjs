import {apiFixture,canaryRequest,response} from './helpers-studio.mjs';
import {leadEvidence} from './helpers-studio-lead.mjs';
import {testProvider} from '../src/studio-providers.mjs';
import {saveRecord} from '../src/studio-state.mjs';
import {hash} from '../src/contracts.mjs';

export async function autopilotFixture(t,{count=12,requestFailure=null,sharedPhones=false}={}){
  const calls=[];
  const sourceFor=name=>{
    const index=Number(name.match(/Studio (\d+)/)?.[1]||0),phone=sharedPhones?'+17135550101':'+1713555'+String(100+index).padStart(4,'0');const e=leadEvidence(name,phone);e.observations[0].url=e.observations[0].finalUrl='https://www.facebook.com/'+encodeURIComponent(name);e.observations[1].url=e.observations[1].finalUrl='https://www.yelp.com/biz/'+encodeURIComponent(name);
    for(const o of e.observations)o.id='observation-'+hash(o.url).slice(0,24);
    e.extraction.identity.observationId=e.observations[0].id;e.extraction.location.observationId=e.observations[0].id;for(const f of e.extraction.services)f.observationId=e.observations[0].id;e.extraction.contact.observationId=e.observations[1].id;e.extraction.activity.observationId=e.observations[1].id;e.extraction.media=[];
    return e;
  };
  const request=async(url,options)=>{
    calls.push({url,body:options.body?JSON.parse(options.body):null});const body=JSON.parse(options.body||'{}');
    if(requestFailure&&body.pageSize===20)return response({},requestFailure);
    if(url.includes('places.googleapis.com')&&body.pageSize===20)return response({places:Array.from({length:count},(_,i)=>({id:'fictional-place-'+i,displayName:{text:'Fictional Studio '+i+' Detailing'},formattedAddress:'Houston, Texas',nationalPhoneNumber:sharedPhones?'7135550101':'713555'+String(100+i).padStart(4,'0'),googleMapsUri:'https://maps.google.com/?cid=fictional-'+i,businessStatus:'OPERATIONAL'}))});
    if(url.includes('firecrawl')&&body.query?.startsWith('"')){
      const name=body.query.match(/^"([^"]+)"/)[1],e=sourceFor(name);return response({success:true,data:{web:e.observations.map(o=>({url:o.url,title:name,description:'Houston, Texas published services and contact'}))}});
    }
    const prompt=body.messages?.at(-1)?.content;
    if(typeof prompt==='string'&&prompt.startsWith('Extract literal source-backed data')){
      const business=JSON.parse(prompt.split('Business: ')[1].split(' Observations: ')[0]),e=sourceFor(business.name);return response({id:'fixture-extraction',model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(e.extraction)}}],usage:{prompt_tokens:100,completion_tokens:100}});
    }
    return canaryRequest(url,options);
  };
  const f=await apiFixture(t,request);
  // Each synthetic business gets a distinct number; source/Google correlation
  // is generated below. A shared-number fixture would correctly hold everyone.
  for(const provider of ['deepseek','openrouter','google','apollo','firecrawl'])await testProvider(f.store,{provider,requestId:'autopilot-ready-'+provider},{request});
  saveRecord(f.store,'studio-reader-check','studio_reader_check',{state:'passed',capabilities:{scrapling:true,camofox:true},at:new Date().toISOString(),verification:'injected_transport'});
  const observe=async(_store,url)=>{
    const name=decodeURIComponent(new URL(url).pathname.split('/').at(-1)),e=sourceFor(name);return e.observations.find(o=>o.url===url);
  };
  return {...f,calls,observe,sourceFor};
}
