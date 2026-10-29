// Exposes only authenticated Factory plugin operations, never the stock browser
// admin/cookie/eval endpoints. The upstream service binds loopback on 9378.
import http from 'node:http';import {timingSafeEqual} from 'node:crypto';
const token=process.env.FACTORY_CAMOFOX_TOKEN;
if(!token||token.length<32)throw new Error('FACTORY_CAMOFOX_TOKEN is required');
const server=http.createServer(async(req,res)=>{
  const auth=String(req.headers.authorization||''),expected='Bearer '+token;
  if(auth.length!==expected.length||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected))){res.writeHead(401);res.end('{"error":"READER_AUTH"}');return;}
  const route=req.url;
  if(route==='/openapi.json'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({openapi:'3.0.0',info:{title:'camofox-browser',version:'1.18.1'},factoryGuard:true}));return;}
  if(!/^\/(?:health|tabs(?:\/[a-zA-Z0-9_-]+(?:\/(?:snapshot|images|screenshot))?)?|sessions\/[a-zA-Z0-9_-]+)$/.test(route)||!['GET','POST','DELETE'].includes(req.method)){res.writeHead(404);res.end();return;}
  let size=0;const chunks=[];
  for await(const c of req){size+=c.length;if(size>8192){res.writeHead(413);res.end();return;}chunks.push(c);}
  const upstream=http.request({hostname:'127.0.0.1',port:9378,path:'/factory'+route,method:req.method,headers:{authorization:expected,'content-type':'application/json'}},r=>{
    let bytes=0;res.writeHead(r.statusCode,{'content-type':'application/json','cache-control':'no-store'});
    r.on('data',c=>{bytes+=c.length;if(bytes>8*1024*1024)upstream.destroy();else res.write(c);});r.on('end',()=>res.end());r.on('error',()=>res.destroy());
  });upstream.setTimeout(45000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end('{"error":"READER_UNAVAILABLE"}');});upstream.end(Buffer.concat(chunks));
});
server.listen(9377,'127.0.0.1');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
