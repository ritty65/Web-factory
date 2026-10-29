// Supported Camofox plugin. No stock package source is patched. All HTTP page
// resources are fulfilled through the app's guarded public transport, so the
// browser never receives provider credentials or chooses a direct network route.
import path from 'node:path';import {pathToFileURL} from 'node:url';
import {timingSafeEqual,createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';

export default async function register(app,ctx){
  const root=process.env.FACTORY_READER_ROOT,token=process.env.FACTORY_CAMOFOX_TOKEN;
  if(!root||!token||token.length<32)throw new Error('Factory reader configuration is incomplete');
  const {publicHttp}=await import(pathToFileURL(path.join(root,'src/public-http.mjs')).href);
  const {publicUrl}=await import(pathToFileURL(path.join(root,'src/contracts.mjs')).href);
  const tabs=new Map();
  const guardDigest=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  const auth=(req,res,next)=>{const value=String(req.headers.authorization||'');const expected='Bearer '+token;if(value.length!==expected.length||!timingSafeEqual(Buffer.from(value),Buffer.from(expected)))return res.status(401).json({error:'READER_AUTH'});next();};
  const fixtureOrigins=new Set(ctx.plugin.settings.fixtureOrigins||[]); // Installer sets [] in production.
  ctx.events.on('browser:launching',({options})=>{
    // All admitted HTTP resources are fulfilled by Node. Any browser request
    // outside that interception must fail at this closed local proxy.
    options.proxy={server:'http://127.0.0.1:9'};
    options.firefoxUserPrefs={...(options.firefoxUserPrefs||{}),'media.peerconnection.enabled':false,'network.dns.disablePrefetch':true,'network.prefetch-next':false,'network.predictor.enabled':false,'network.http.speculative-parallel-limit':0};
  });
  const allowed=value=>{try{const u=new URL(value);if(fixtureOrigins.has(u.origin))return u;return publicUrl(value);}catch{return null;}};
  ctx.events.on('session:creating',({contextOptions})=>{contextOptions.serviceWorkers='block';contextOptions.acceptDownloads=false;contextOptions.ignoreHTTPSErrors=false;});
  ctx.events.on('session:created',async({context})=>{
    let requests=0,totalBytes=0;
    await context.route('**/*',async route=>{
      const req=route.request(),target=allowed(req.url());
      if(!target||req.method()!=='GET'||++requests>160)return route.abort('blockedbyclient');
      try{
        let response;
        if(fixtureOrigins.has(target.origin)){
          const r=await fetch(target,{redirect:'manual',signal:AbortSignal.timeout(10000)});response={status:r.status,bytes:Buffer.from(await r.arrayBuffer()),contentType:r.headers.get('content-type')||'',location:r.headers.get('location')};
        }else response=await publicHttp(target.href,{maxBytes:4*1024*1024,timeout:20000,followRedirects:false});
        totalBytes+=response.bytes.length;if(totalBytes>20*1024*1024)return route.abort('blockedbyclient');
        const headers={'content-type':response.contentType||'application/octet-stream'};
        if(response.location){const next=allowed(new URL(response.location,target).href);if(!next)return route.abort('blockedbyclient');headers.location=next.href;}
        return route.fulfill({status:response.status,headers,body:response.bytes});
      }catch{return route.abort('blockedbyclient');}
    });
    if(typeof context.routeWebSocket==='function')await context.routeWebSocket('**/*',ws=>ws.close());
  });
  const safe=(fn)=>async(req,res)=>{try{await fn(req,res);}catch{res.status(503).json({error:'FACTORY_BROWSER_UNAVAILABLE'});}};
  const find=req=>{const tab=tabs.get(req.params.id);if(!tab||tab.userId!==req.body?.userId)throw Error();return tab;};
  app.get('/factory/health',auth,(_req,res)=>res.json({ok:true,engine:'camoufox',version:'1.18.1',guardDigest,factoryGuard:true,browserRunning:tabs.size>0,browserConnected:tabs.size>0,persistence:false,telemetry:false}));
  app.post('/factory/tabs',auth,safe(async(req,res)=>{
    const {userId,url}=req.body;if(!/^factory-[a-f0-9-]{36}$/.test(userId||'')||!allowed(url)||tabs.size>=2)throw Error();
    const session=await ctx.getSession(userId),page=await session.context.newPage();
    const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});await page.waitForTimeout(300);
    const id=crypto.randomUUID();tabs.set(id,{page,userId,httpStatus:response?.status()??null});res.json({tabId:id,url:page.url()});
  }));
  app.post('/factory/tabs/:id/snapshot',auth,safe(async(req,res)=>{
    const tab=find(req),data=await tab.page.evaluate(()=>({url:location.href,title:document.title,text:document.body?.innerText||'',links:[...document.querySelectorAll('a[href]')].slice(0,120).map(a=>({url:a.href,text:(a.textContent||'').slice(0,200)})),contacts:[...document.querySelectorAll('a[href^="tel:"],a[href^="mailto:"]')].slice(0,30).map(a=>a.getAttribute('href')),dates:[...document.querySelectorAll('time[datetime]')].slice(0,30).map(t=>({value:t.dateTime,text:(t.textContent||'').slice(0,300)}))}));
    data.links=data.links.filter(l=>allowed(l.url));data.truncated=data.text.length>30000;data.text=data.text.slice(0,30000);data.httpStatus=tab.httpStatus;data.blocked=tab.httpStatus!==200;res.json(data);
  }));
  app.post('/factory/tabs/:id/images',auth,safe(async(req,res)=>{
    const tab=find(req),images=await tab.page.evaluate(()=>[...document.images].slice(0,60).map(i=>({url:i.currentSrc||i.src,alt:(i.alt||'').slice(0,300),width:i.naturalWidth,height:i.naturalHeight,caption:(i.closest('figure')?.querySelector('figcaption')?.textContent||'').slice(0,500)})));
    res.json({images:images.filter(i=>allowed(i.url)).slice(0,30)});
  }));
  app.post('/factory/tabs/:id/screenshot',auth,safe(async(req,res)=>{const tab=find(req);const bytes=await tab.page.screenshot({type:'png',fullPage:false});res.json({base64:bytes.toString('base64'),contentType:'image/png'});}));
  app.delete('/factory/sessions/:userId',auth,safe(async(req,res)=>{
    for(const[id,tab]of tabs)if(tab.userId===req.params.userId){await tab.page.close().catch(()=>{});tabs.delete(id);}
    await ctx.destroySession(req.params.userId,{reason:'factory_cleanup'});res.json({closed:true});
  }));
}
