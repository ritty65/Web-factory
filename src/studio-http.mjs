import {EnvHttpProxyAgent,fetch} from 'undici';
import {fail,publicUrl} from './contracts.mjs';
import {resolvePublic} from './network.mjs';

const endpoints=new Map([
  ['https://api.deepseek.com/v1/chat/completions','POST'],['https://api.deepseek.com/models','GET'],
  ['https://openrouter.ai/api/v1/chat/completions','POST'],['https://openrouter.ai/api/v1/models','GET'],
  ['https://api.openai.com/v1/responses','POST'],['https://api.openai.com/v1/models','GET'],
  ['https://places.googleapis.com/v1/places:searchText','POST'],
  ['https://api.apollo.io/api/v1/organizations/enrich','GET'],['https://api.apollo.io/api/v1/mixed_people/api_search','POST'],['https://api.apollo.io/api/v1/people/match','POST'],
  ['https://api.apollo.io/api/v1/mixed_companies/search','POST'],
  ['https://api.firecrawl.dev/v2/search','POST'],['https://api.firecrawl.dev/v2/scrape','POST'],
]);
export async function studioHttp(value,{method='POST',headers={},body,signal,timeout=120000,maxBytes=3*1024*1024,registeredEndpoint=null}={}){
  const url=publicUrl(value),base=url.origin+url.pathname;
  const googleDetail=method==='GET'&&/^https:\/\/places\.googleapis\.com\/v1\/places\/[A-Za-z0-9_-]{1,200}$/.test(base);
  if(endpoints.get(base)!==method&&!googleDetail){
    if(!registeredEndpoint||url.href!==registeredEndpoint||method!=='POST')fail('PROVIDER_DESTINATION','Only a registered provider endpoint can receive this request');
    await resolvePublic(url);
  }
  if(url.search&&base!=='https://api.apollo.io/api/v1/organizations/enrich')fail('PROVIDER_DESTINATION','Unexpected provider query parameters');
  if(body&&Buffer.byteLength(body)>20*1024*1024)fail('PROVIDER_LIMIT','Provider input exceeds its request limit');
  const dispatcher=new EnvHttpProxyAgent(),controller=new AbortController();
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(abort,Math.min(600000,timeout));
  try{
    const response=await fetch(url,{method,headers:{'content-type':'application/json',...headers},body:method==='GET'?undefined:body,signal:controller.signal,redirect:'manual',dispatcher});
    let size=0;const chunks=[];
    for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes){controller.abort();fail('PROVIDER_LIMIT','Provider response exceeded its byte limit');}chunks.push(chunk);}
    return {status:response.status,bytes:Buffer.concat(chunks),contentType:response.headers.get('content-type')?.split(';')[0],requestId:response.headers.get('x-request-id')?.slice(0,200)||null};
  }catch(error){
    if(error.code==='PROVIDER_LIMIT')throw error;
    const e=Object.assign(new Error('Provider connection failed. Check network access, timeout and account settings; credentials were not exported.'),{code:signal?.aborted?'CANCELLED':controller.signal.aborted?'PROVIDER_TIMEOUT':'PROVIDER_NETWORK',uncertain:true});throw e;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);await dispatcher.close();}
}
export function providerJson(response){
  if(response.status!==200){const code=response.status===401?'PROVIDER_AUTH':response.status===403?'PROVIDER_ACCESS':response.status===429?'PROVIDER_RATE_LIMIT':'PROVIDER_HTTP';throw Object.assign(new Error('Provider rejected the request. Check API access, quota and enabled features.'),{code,noCharge:[401,403].includes(response.status)});}
  try{const data=JSON.parse(response.bytes.toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data)||data.error)fail('PROVIDER_SCHEMA','Provider returned an unsupported response');return data;}catch(error){if(error.code)throw error;fail('PROVIDER_SCHEMA','Provider returned malformed JSON');}
}
