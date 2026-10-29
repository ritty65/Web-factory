import path from 'node:path';import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import http from 'node:http';import {randomUUID} from 'node:crypto';
import {publicUrl,hash,now,fail} from './contracts.mjs';
import {resolvePublic} from './network.mjs';import {publicHttp} from './public-http.mjs';
import {runProcess} from './process.mjs';import {noLinks} from './db.mjs';
import {integrationJson} from './studio-providers.mjs';
import {studioHttp} from './studio-http.mjs';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
export function readerEnvironment(){
  return {PATH:process.env.PATH||'/usr/bin:/bin',LANG:'C.UTF-8',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'};
}
export async function extractHtml(url,html,{signal,runner=runProcess}={}){
  publicUrl(url);if(Buffer.byteLength(html)>900000)fail('SOURCE_LIMIT','Source HTML exceeds the extraction limit');
  const binary=process.env.FACTORY_SCRAPLING_PYTHON||path.join(ROOT,'.factory-tools/scrapling/bin/python');
  const result=await runner(binary,['-I','-B',path.join(ROOT,'tools/scrapling-runtime/extract.py')],{cwd:ROOT,env:readerEnvironment(),signal,timeout:15000,maxBytes:1048576,stdin:JSON.stringify({url,html})});
  let data;try{data=JSON.parse(result.stdout);}catch{fail('SCRAPLING_SCHEMA','Scrapling returned invalid JSON');}
  if(typeof data.text!=='string'||!Array.isArray(data.links)||!Array.isArray(data.images)||data.text.length>30000)fail('SCRAPLING_SCHEMA','Scrapling returned an unsupported observation');
  return data;
}
export async function scraplingStatus({runner=runProcess}={}){
  try{const binary=process.env.FACTORY_SCRAPLING_PYTHON||path.join(ROOT,'.factory-tools/scrapling/bin/python');const result=await runner(binary,['-I','-B',path.join(ROOT,'tools/scrapling-runtime/extract.py'),'--version'],{env:readerEnvironment(),timeout:10000,maxBytes:4096});const data=JSON.parse(result.stdout);return {ready:data.package==='scrapling'&&data.version==='0.5',version:data.version||null,method:'installed_library_version',liveExtractionProven:false};}
  catch{return {ready:false,version:null,method:'unavailable',liveExtractionProven:false};}
}
export function camofoxRequest(endpoint,{method='GET',body,signal,token=process.env.FACTORY_CAMOFOX_TOKEN,maxBytes=1048576}={}){
  // The trusted broker has a fixed loopback endpoint, never a caller-selected URL.
  if(!/^\/(?:health|openapi\.json|tabs(?:\/[a-zA-Z0-9_-]+(?:\/(?:snapshot|images|links|screenshot))?)?|sessions\/[a-zA-Z0-9_-]+)$/.test(endpoint))fail('CAMOFOX_PATH','Unsupported browser broker operation');
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:9377,path:endpoint,method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},signal},res=>{
      let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)req.destroy(Object.assign(new Error('Browser output exceeded its limit'),{code:'CAMOFOX_LIMIT'}));else chunks.push(chunk);});
      res.on('end',()=>{try{if(res.statusCode!==200)fail('CAMOFOX_HTTP','Browser broker rejected the operation');resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch(e){reject(e);}});res.on('error',reject);
    });req.setTimeout(30000,()=>req.destroy(Object.assign(new Error('Browser request timed out'),{code:'CAMOFOX_TIMEOUT'})));req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
  });
}
export async function inspectRendered(value,{signal,request=camofoxRequest,resolve=resolvePublic}={}){
  const url=publicUrl(value);await resolve(url);
  const userId='factory-'+randomUUID(),sessionKey='source-'+randomUUID();let tab;
  try{
    tab=await request('/tabs',{method:'POST',body:{userId,sessionKey,url:url.href},signal});
    const id=tab.tabId||tab.id;if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(id))fail('CAMOFOX_SCHEMA','Browser did not return a bounded tab identity');
    // The owned broker normalizes committed location, text, links and images.
    const snapshot=await request('/tabs/'+id+'/snapshot',{method:'POST',body:{userId},signal});
    const images=await request('/tabs/'+id+'/images',{method:'POST',body:{userId,limit:30},signal});
    const final=publicUrl(snapshot.url);await resolve(final);
    if(typeof snapshot.text!=='string'||!Array.isArray(snapshot.links)||!Array.isArray(images.images))fail('CAMOFOX_SCHEMA','Browser extraction is incomplete; no successful observation was inferred');
    return {url:url.href,finalUrl:final.href,title:String(snapshot.title||'').slice(0,300),text:snapshot.text.slice(0,30000),links:snapshot.links.slice(0,120),images:images.images.slice(0,30),contacts:snapshot.contacts||[],dates:snapshot.dates||[],structured:[],truncated:!!snapshot.truncated,blocked:!!snapshot.blocked,method:'camofox_fresh_guest',httpStatus:snapshot.httpStatus??null};
  }finally{await request('/sessions/'+userId,{method:'DELETE'}).catch(()=>{});}
}
export async function inspectPublicSource(store,value,{requestId,signal,request=studioHttp,fetchPage=publicHttp,render=inspectRendered,parse=extractHtml,directory=null}={}){
  const url=publicUrl(value);let observation,staticFailure;
  try{
    const response=await fetchPage(url.href,{signal,maxBytes:900000});
    if([401,403,429].includes(response.status))return {id:'observation-'+hash({url:url.href,requestId}).slice(0,24),url:url.href,finalUrl:response.url,title:'',text:'',links:[],images:[],contacts:[],dates:[],structured:[],blocked:true,truncated:false,method:'public_access_restricted',httpStatus:response.status,inspectedAt:now()};
    if(response.status!==200||!['text/html','application/xhtml+xml'].includes(response.contentType))fail('SOURCE_ACCESS','Public source is not a readable HTML page');
    const parsed=await parse(response.url,response.bytes.toString('utf8'),{signal});
    observation={...parsed,url:url.href,finalUrl:response.url,method:'scrapling_static',httpStatus:response.status,blocked:false};
  }catch(error){staticFailure=error.code||'SOURCE_UNAVAILABLE';}
  const restricted=observation&&/log in to continue|verify you are human|access denied|complete the security check/i.test(observation.text)&&observation.text.length<1800;
  if(restricted)return {...observation,id:'observation-'+hash({url:url.href,at:now()}).slice(0,24),inspectedAt:now(),blocked:true,reason:'access_restricted'};
  if(!observation||observation.text.length<120){
    // Policy/private-DNS denials cannot be bypassed through another reader.
    if(/PRIVATE|DESTINATION|DNS|PUBLIC_URL|PUBLIC_POLICY/.test(staticFailure||''))fail(staticFailure,'Source destination was rejected by the public-network policy');
    try{observation=await render(url.href,{signal});}catch(error){if(signal?.aborted)throw error;}
  }
  if(!observation||observation.text.length<120){
    const result=await integrationJson(store,{provider:'firecrawl',endpoint:'https://api.firecrawl.dev/v2/scrape',body:{url:url.href,formats:['markdown','html'],onlyMainContent:true},requestId:requestId+'-managed',purpose:'source:managed-extraction',signal,request});
    const data=result.data.data;
    if(result.data.success!==true||typeof data?.markdown!=='string')fail('SOURCE_SCHEMA','Managed extraction returned unsupported content');
    let parsed={links:[],images:[],contacts:[],dates:[],structured:[]};if(typeof data.html==='string'&&Buffer.byteLength(data.html)<=900000)parsed=await parse(url.href,data.html,{signal});
    const final=publicUrl(data.metadata?.sourceURL||url.href);await resolvePublic(final);
    observation={...parsed,url:url.href,finalUrl:final.href,title:String(data.metadata?.title||parsed.title||'').slice(0,300),text:data.markdown.slice(0,30000),truncated:data.markdown.length>30000,blocked:false,method:'firecrawl_managed',transport:result.transport,httpStatus:data.metadata?.statusCode??null};
  }
  if(/log in to continue|verify you are human|access denied|complete the security check/i.test(observation.text)&&observation.text.length<1800)observation.blocked=true;
  const result={...observation,id:'observation-'+hash({url:url.href,at:now(),requestId}).slice(0,24),inspectedAt:now(),authScope:'fresh_guest',contentDigest:hash(observation)};
  if(directory){await noLinks(directory);await mkdir(directory,{recursive:true,mode:0o700});await writeFile(path.join(directory,result.id+'.json'),JSON.stringify(result),{flag:'wx',mode:0o600});}
  return result;
}
