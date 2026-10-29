import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {createRequire} from 'node:module';import path from 'node:path';import {chromium} from 'playwright';import sharp from 'sharp';
import register from '../tools/camofox-runtime/factory-plugin.mjs';

test('Factory Camofox plugin performs real rendered text/image extraction with fresh sessions and blocked private subrequests',async t=>{
  // Chromium exercises the owned Playwright plugin contract. This deliberately
  // does not claim that the unavailable Camoufox binary was downloaded/launched.
  const require=createRequire(path.resolve('.factory-tools/camofox/package.json')),express=require('express');
  const prior={root:process.env.FACTORY_READER_ROOT,token:process.env.FACTORY_CAMOFOX_TOKEN};process.env.FACTORY_READER_ROOT=process.cwd();process.env.FACTORY_CAMOFOX_TOKEN='f'.repeat(64);
  let secretRequests=0;const secret=http.createServer((_req,res)=>{secretRequests++;res.end('private');});await new Promise(r=>secret.listen(0,'127.0.0.1',r));
  const image=await sharp({create:{width:600,height:400,channels:3,background:'#294b36'}}).jpeg().toBuffer();
  const fixture=http.createServer((req,res)=>{
    if(req.url==='/work.jpg'){res.writeHead(200,{'content-type':'image/jpeg'});res.end(image);return;}
    res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><html><title>Fictional rendered source</title><body><h1>Fictional Studio</h1><main id="result"></main><img src="/work.jpg" width="600" height="400" alt="Fictional work"><script>document.getElementById('result').textContent='Rendered contact information. '+document.cookie;if(location.pathname==='/one')document.cookie='other-business=one';fetch('http://127.0.0.1:${secret.address().port}/private').catch(()=>{});</script></body></html>`);
  });await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+fixture.address().port;
  const browser=await chromium.launch({executablePath:process.env.FACTORY_BROWSER_EXECUTABLE,headless:true,proxy:{server:'http://127.0.0.1:9'}}),sessions=new Map(),listeners=new Map();
  const events={on:(event,fn)=>listeners.set(event,[...(listeners.get(event)||[]),fn])};const emit=async(event,value)=>{for(const fn of listeners.get(event)||[])await fn(value);};
  const ctx={events,plugin:{settings:{fixtureOrigins:[origin]}},getSession:async(userId)=>{const options={};await emit('session:creating',{contextOptions:options});const context=await browser.newContext(options);sessions.set(userId,context);await emit('session:created',{context});return{context};},destroySession:async userId=>{await sessions.get(userId)?.close();sessions.delete(userId);}};
  const app=express();app.use(express.json({limit:'8kb'}));await register(app,ctx);const options={};await emit('browser:launching',{options});assert.equal(options.proxy.server,'http://127.0.0.1:9');assert.equal(options.firefoxUserPrefs['media.peerconnection.enabled'],false);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{for(const c of sessions.values())await c.close();await browser.close();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>fixture.close(r)),new Promise(r=>secret.close(r))]);for(const[name,value]of [['FACTORY_READER_ROOT',prior.root],['FACTORY_CAMOFOX_TOKEN',prior.token]])if(value===undefined)delete process.env[name];else process.env[name]=value;});
  const endpoint='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(endpoint+'/factory/health')).status,401);
  const call=async(route,body,method='POST')=>{const r=await fetch(endpoint+'/factory'+route,{method,headers:{authorization:'Bearer '+'f'.repeat(64),'content-type':'application/json'},...(method==='GET'||method==='DELETE'?{}:{body:JSON.stringify(body)})});return{status:r.status,data:await r.json()};};
  const first='factory-00000000-0000-4000-8000-000000000001',second='factory-00000000-0000-4000-8000-000000000002';
  const a=await call('/tabs',{userId:first,url:origin+'/one'});assert.equal(a.status,200);const snapshot=await call('/tabs/'+a.data.tabId+'/snapshot',{userId:first});assert.match(snapshot.data.text,/Rendered contact information/);assert.equal(snapshot.data.url,origin+'/one');
  const images=await call('/tabs/'+a.data.tabId+'/images',{userId:first});assert.equal(images.data.images[0].width,600);assert.equal(images.data.images[0].height,400);
  assert.equal((await call('/tabs/'+a.data.tabId+'/snapshot',{userId:second})).status,503);
  const b=await call('/tabs',{userId:second,url:origin+'/two'});const fresh=await call('/tabs/'+b.data.tabId+'/snapshot',{userId:second});assert.doesNotMatch(fresh.data.text,/other-business=one/);assert.equal(secretRequests,0);
  await call('/sessions/'+first,null,'DELETE');await call('/sessions/'+second,null,'DELETE');assert.equal(sessions.size,0);
});
