import test from 'node:test';
import assert from 'node:assert/strict';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {sourceMode} from '../src/browser.mjs';

test('only exact known hubs and Threads opt into linked guest rendering; legacy and arbitrary-host behavior stays unchanged',()=>{
  for(const host of ['linktr.ee','www.linktr.ee','beacons.ai','bio.site','lnk.bio','campsite.bio','hoo.be','threads.net','www.threads.com']){
    assert.equal(sourceMode(`https://${host}/juniper`),'static_https_no_script');
    assert.equal(sourceMode(`https://${host}/juniper`,{linked:true}),'guest_browser');
  }
  for(const host of ['attacker.example','threads.net.attacker.example','untrusted.linktr.ee','beacons.ai.attacker.example'])assert.equal(sourceMode(`https://${host}/juniper`,{linked:true}),'static_https_no_script');
});
async function rendered(finalUrl){
  const script=`
    import {mock} from 'node:test';import {mkdtemp} from 'node:fs/promises';
    mock.module(${JSON.stringify(new URL('../src/network.mjs',import.meta.url).href)},{namedExports:{resolvePublic:async()=>({address:'93.184.216.34',family:4}),safeFetch:async()=>{throw new Error('No live network');}}});
    const calls=[];mock.module(${JSON.stringify(new URL('../src/process.mjs',import.meta.url).href)},{namedExports:{runProcess:async(_,args)=>{
      calls.push(args);if(args.includes('eval'))return {stdout:JSON.stringify({success:true,data:{result:{title:'Synthetic hub',text:'Synthetic observed hub',finalUrl:${JSON.stringify(finalUrl)},links:[],images:[]}}})};
      return {stdout:JSON.stringify({success:true})};
    }}});
    const {inspectSource,publicObservation}=await import(${JSON.stringify(new URL('../src/browser.mjs',import.meta.url).href)});
    let observation,error;try{observation=publicObservation(await inspectSource('https://linktr.ee/juniper',{directory:await mkdtemp('/tmp/linked-reader-'),linked:true,relatedUrls:['https://attacker.example/']}));}catch(e){error=e.code;}
    console.log(JSON.stringify({observation,error,calls}));
  `;
  const result=await promisify(execFile)(process.execPath,['--experimental-test-module-mocks','--input-type=module','--eval',script],{timeout:15000});return JSON.parse(result.stdout);
}
test('linked renderer uses a fixed allowlist, ignores caller domain widening and retains a safe committed URL',async()=>{
  const r=await rendered('https://linktr.ee/juniper');assert.equal(r.error,undefined);assert.equal(r.observation.finalUrl,'https://linktr.ee/juniper');
  assert.equal(r.observation.method,'fresh_guest_rendered_dom');
  const args=r.calls.find(a=>a.includes('open')),hosts=args[args.indexOf('--allowed-domains')+1];
  assert.equal(hosts,'linktr.ee,www.linktr.ee');assert.equal(JSON.stringify(r.calls).includes('attacker.example'),false);assert.equal(r.calls.at(-1).at(-1),'close');
});
test('an unexpected committed linked host is rejected, not presented as inspected evidence',async()=>{
  const r=await rendered('https://attacker.example/juniper');assert.equal(r.observation,undefined);assert.equal(r.error,'BROWSER_DATA');assert.equal(r.calls.at(-1).at(-1),'close');
});
