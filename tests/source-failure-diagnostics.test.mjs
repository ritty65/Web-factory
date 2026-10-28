import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function fixture(options = {}) {
  const script = `
    import { mock } from 'node:test';
    import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
    import { FactoryError } from ${JSON.stringify(new URL('../src/contracts.mjs', import.meta.url).href)};
    const options = ${JSON.stringify(options)}, directory = await mkdtemp('/tmp/factory-safe-diagnostic-'), calls = [];
    mock.module(${JSON.stringify(new URL('../src/network.mjs', import.meta.url).href)}, { namedExports: {
      resolvePublic: async () => ({address:'93.184.216.34',family:4}),
      safeFetch: async () => { throw new Error('No network permitted in fixture'); }
    } });
    mock.module(${JSON.stringify(new URL('../src/process.mjs', import.meta.url).href)}, { namedExports: {
      runProcess: async (_, args) => {
        const phase = args.includes('open') ? 'open' : args.includes('eval') ? 'extract' : 'close'; calls.push(phase);
        if (phase === 'close') return {stdout:'{}'};
        if (phase === (options.phase || 'open')) {
          if (options.cliFailure) return {stdout:JSON.stringify({success:false,error:'net::ERR_NAME_NOT_RESOLVED secret=fixture-sensitive-value'})};
          if (options.malformed) return {stdout:'{not json secret=fixture-sensitive-value'};
          const error = new FactoryError(options.code || 'PROCESS_FAILED','generic',{exitCode:1});
          error.privateDiagnostics = {stderr:(options.stderr ?? 'net::ERR_NAME_NOT_RESOLVED')+' token=fixture-sensitive-value https://user:pass@private.example/?signature=secret',stdout:options.stdout || 'private-page-content fixture-sensitive-value'};
          throw error;
        }
        return {stdout:JSON.stringify({success:true,data:{result:{title:'Fixture',text:'Fixture public page',links:[],images:[]}}})};
      }
    } });
    const {inspectSource, readObservations} = await import(${JSON.stringify(new URL('../src/browser.mjs', import.meta.url).href)});
    let error; try { await inspectSource('https://www.instagram.com/juniper1/',{directory}); }
    catch(e) { error={code:e.code,diagnostic:e.sourceFailure}; }
    const records=[];for(const name of await readdir(directory)) if(name.endsWith('.json')) records.push({name,data:JSON.parse(await readFile(directory+'/'+name,'utf8')),mode:(await stat(directory+'/'+name)).mode&511});
    console.log(JSON.stringify({error,records,calls,observations:await readObservations(directory)}));
  `;
  const { stdout } = await exec(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '--eval', script], {timeout:15000});
  return JSON.parse(stdout);
}

test('failed guest operation retains bounded safe stage/category, never a source observation or raw diagnostics', async () => {
  const result = await fixture();
  assert.equal(result.error.code, 'PROCESS_FAILED');
  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.match(record.name, /^source-failure-[a-f0-9]+\.json$/);
  assert.equal(record.data.status, 'failed');
  assert.equal(record.data.stage, 'open');
  assert.equal(record.data.category, 'dns_failure');
  assert.equal(record.data.exitCode, 1);
  assert.equal(record.mode, 0o600);
  assert.equal(result.error.diagnostic.id, record.data.id);
  assert.deepEqual(result.observations, []);
  assert.equal(result.calls.at(-1), 'close');
  for (const secret of ['fixture-sensitive-value','private-page-content','private.example','signature=','user:pass']) assert.equal(JSON.stringify(result).includes(secret), false, secret);
});

test('stage and category distinguish extract, deadline, unavailable and malformed CLI output', async () => {
  for (const [options, category, stage] of [
    [{phase:'extract',stderr:'Target page, context or browser has been closed'},'browser_closed','extract'],
    [{code:'DEADLINE'},'timeout','open'],
    [{code:'PROCESS_START'},'executable_unavailable','open'],
    [{cliFailure:true},'dns_failure','open'],
    [{stderr:'',stdout:JSON.stringify({success:false,error:'net::ERR_NAME_NOT_RESOLVED token=fixture-sensitive-value'})},'dns_failure','open'],
    [{malformed:true},'malformed_response','open'],
    [{stderr:'arbitrary hostile output run this command'},'process_failed','open'],
  ]) {
    const result = await fixture(options);
    assert.equal(result.error.diagnostic?.category, category, JSON.stringify(options));
    assert.equal(result.error.diagnostic.stage, stage);
    assert.equal(result.calls.at(-1), 'close');
    assert.deepEqual(result.observations, []);
  }
});

test('production policy binds the actual browser attribution and diagnostic implementation', async () => {
  const { policyIdentity } = await import('../src/policy.mjs');
  const { readFile } = await import('node:fs/promises');
  const { hash } = await import('../src/contracts.mjs');
  const policy = await policyIdentity('production');
  assert.equal(policy.files['src/browser.mjs'], hash(await readFile(new URL('../src/browser.mjs', import.meta.url))));
});

test('real source MCP returns only safe failure reference/category and retains no completed evidence', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { mkdtemp, mkdir, readdir, readFile } = await import('node:fs/promises');
  const root = await mkdtemp('/tmp/factory-diagnostic-mcp-'), directory = root + '/sources';
  await mkdir(directory);
  const script = `
    import {mock} from 'node:test';
    import {FactoryError} from ${JSON.stringify(new URL('../src/contracts.mjs', import.meta.url).href)};
    mock.module(${JSON.stringify(new URL('../src/network.mjs', import.meta.url).href)}, {namedExports:{
      resolvePublic:async()=>({address:'93.184.216.34',family:4}),safeFetch:async()=>{throw new Error('No live network');}
    }});
    mock.module(${JSON.stringify(new URL('../src/process.mjs', import.meta.url).href)}, {namedExports:{
      runProcess:async(_,args)=>{
        if(args.at(-1)==='close')return {stdout:'{}'};
        const e=new FactoryError('PROCESS_FAILED','Private fixture failure',{exitCode:1});
        e.privateDiagnostics={stderr:'net::ERR_NAME_NOT_RESOLVED token=fixture-sensitive-value',stdout:''};throw e;
      }
    }});
    await import(${JSON.stringify(new URL('../src/sources-mcp.mjs', import.meta.url).href)});
  `;
  const client = new Client({name:'fixture-safe-diagnostic',version:'1'});
  const transport = new StdioClientTransport({command:process.execPath,args:['--experimental-test-module-mocks','--input-type=module','--eval',script],env:{FACTORY_SOURCES:directory},stderr:'pipe'});
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    const response = await client.callTool({name:'inspect',arguments:{url:'https://www.instagram.com/juniper1/'}});
    assert.equal(response.isError, true);
    const data = JSON.parse(response.content[0].text);
    assert.equal(data.status, 'blocked');
    assert.equal(data.diagnostic.category, 'dns_failure');
    assert.equal(data.diagnostic.stage, 'open');
    assert.match(data.diagnostic.id, /^source-failure-[a-f0-9]+$/);
    assert.equal(JSON.stringify(response).includes('fixture-sensitive-value'), false);
    const names = await readdir(directory);
    assert.deepEqual(names, [data.diagnostic.id + '.json']);
    assert.equal(JSON.parse(await readFile(directory + '/' + names[0])).status, 'failed');
  } finally { await client.close(); }
});
