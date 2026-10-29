import {Agent,EnvHttpProxyAgent,fetch} from 'undici';
import {resolvePublic} from './network.mjs';
import {publicUrl,fail} from './contracts.mjs';

// Public page/image reader. Credentials and provider headers are never accepted.
// Direct VPS traffic pins validated DNS; managed-cloud traffic retains the
// configured policy proxy and its TLS trust/private-destination enforcement.
export async function publicHttp(value,{signal,maxBytes=1048576,timeout=20000,redirects=2,lookup,followRedirects=true}={}){
  const url=publicUrl(value,{signed:true}),address=await resolvePublic(url,lookup);
  const proxied=!!(process.env.HTTPS_PROXY||process.env.https_proxy||process.env.HTTP_PROXY||process.env.http_proxy);
  const dispatcher=proxied?new EnvHttpProxyAgent():new Agent({connect:{lookup:(_host,options,cb)=>options.all?cb(null,[address]):cb(null,address.address,address.family)}});
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(abort,timeout);
  try{
    const r=await fetch(url,{dispatcher,redirect:'manual',signal:controller.signal,headers:{'user-agent':'Web-Factory-Public-Research/1.0',accept:'text/html,image/*;q=0.8,*/*;q=0.1'}});
    if(r.status>=300&&r.status<400){
      if(!followRedirects){await r.body?.cancel();return {status:r.status,url:url.href,bytes:Buffer.alloc(0),contentType:'text/plain',location:r.headers.get('location')};}
      await r.body?.cancel();if(!redirects||!r.headers.get('location'))fail('PUBLIC_REDIRECT','Public redirect limit reached');
      return publicHttp(new URL(r.headers.get('location'),url).href,{signal,maxBytes,timeout,redirects:redirects-1,lookup,followRedirects});
    }
    const chunks=[];let size=0;
    for await(const chunk of r.body){size+=chunk.length;if(size>maxBytes){controller.abort();fail('PUBLIC_LIMIT','Public response exceeded its size limit');}chunks.push(chunk);}
    return {status:r.status,url:url.href,bytes:Buffer.concat(chunks),contentType:(r.headers.get('content-type')||'').split(';')[0]};
  }catch(e){if(e.code?.startsWith('PUBLIC_'))throw e;const policyDenied=e.cause?.statusCode===403||/proxy.*403|403.*proxy|CONNECT.*403/i.test(String(e.cause?.message||e.message||''));fail(signal?.aborted?'CANCELLED':policyDenied?'PUBLIC_POLICY':controller.signal.aborted?'PUBLIC_TIMEOUT':'PUBLIC_NETWORK','Public source could not be retrieved; no absence or activity conclusion was made');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);await dispatcher.close();}
}
