import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const exec = promisify(execFile), require = createRequire(import.meta.url);
test('installed body-parser matches the lockfile and contains the trailing-compressed-body fix', async () => {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url)));
  const installed = require('body-parser/package.json').version;
  assert.equal(installed, lock.packages['node_modules/body-parser'].version);
  const [major, minor] = installed.split('.').map(Number);
  assert.ok(major > 2 || major === 2 && minor >= 4, 'GHSA-27r3-jxmh-p828 requires body-parser >=2.4.0 on this dependency line');
});

// Bounded loopback-only child processes, adapted from the maintainer regression:
// https://github.com/expressjs/body-parser/compare/v2.3.0...v2.4.0
// Never direct malformed bodies at the operator app or another existing service.
for (const encoding of ['gzip', 'deflate']) test(`dependency survives trailing bytes after a finished ${encoding} frame`, async () => {
  const script = `
    const http=require('node:http'),zlib=require('node:zlib'),assert=require('node:assert/strict');
    const parser=require(${JSON.stringify(require.resolve('body-parser'))}).json();
    const encoding=${JSON.stringify(encoding)},payload=Buffer.from('{"fixture":true}');
    const first=Buffer.concat([encoding==='gzip'?zlib.gzipSync(payload):zlib.deflateSync(payload),Buffer.from([0])]);
    const trailing=Buffer.alloc(1024,encoding==='gzip'?0x58:0);let client;
    const server=http.createServer((req,res)=>parser(req,res,error=>{
      if(error){res.statusCode=error.status||400;res.end('rejected');return;}
      const finish=()=>res.end(JSON.stringify(req.body));
      if(req.readableEnded)finish();else req.once('end',finish);
      client.end(trailing);
    }));
    server.listen(0,'127.0.0.1',()=>{
      client=http.request({host:'127.0.0.1',port:server.address().port,method:'POST',agent:false,headers:{'Content-Type':'application/json','Content-Encoding':encoding,'Content-Length':first.length+trailing.length}},res=>{
        let body='';res.on('data',c=>body+=c);res.on('end',()=>{
          assert.equal(res.statusCode,200);assert.equal(body,payload.toString());
          setTimeout(()=>server.close(()=>console.log(JSON.stringify({pass:true,encoding}))),200);
        });
      });
      client.on('error',error=>{console.error(error.code||'fixture failure');server.close();process.exitCode=1;});
      client.setTimeout(1500,()=>client.destroy(new Error('bounded fixture timeout')));
      client.write(first);
    });
  `;
  const { stdout } = await exec(process.execPath, ['--eval',script], {timeout:5000,maxBuffer:20000});
  assert.deepEqual(JSON.parse(stdout), {pass:true,encoding});
});
