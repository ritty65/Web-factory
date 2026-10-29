import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

function run(mode){
  const script=`
    import {mock}from'node:test';import {mkdtemp,mkdir,writeFile,readFile}from'node:fs/promises';import path from'node:path';
    await import(${JSON.stringify(new URL('../src/db.mjs',import.meta.url).href)});
    const {hash}=await import(${JSON.stringify(new URL('../src/contracts.mjs',import.meta.url).href)});
    const mode=${JSON.stringify(mode)},root=await mkdtemp('/tmp/assisted-production-'),source=path.join(root,'source'),target=path.join(root,'target');
    const original=Buffer.from('Synthetic already-validated original'),web=Buffer.from('Synthetic already-validated derivative');
    const media=[{original_file:'media/originals/photo-1.jpg',web_file:'site/assets/photos/photo-1.webp',original_sha256:hash(original),web_sha256:hash(web),role:'supporting',use_status:'operator_authorized_private_preview',public_release:false}];
    for(const [relative,bytes]of [[media[0].original_file,original],[media[0].web_file,web]]){await mkdir(path.dirname(path.join(source,relative)),{recursive:true});await writeFile(path.join(source,relative),bytes);}
    let validations=0,reads=0,legacyQueries=0,sourceAdapterCalls=0,stages=0;
    const binding={id:'assisted-fixture',bundleDigest:'a'.repeat(64),evidenceDigest:'b'.repeat(64)},batch={id:'batch-assisted-fixture',assistedIntake:binding};
    mock.module(${JSON.stringify(new URL('../src/assisted-evidence.mjs',import.meta.url).href)},{namedExports:{
      assertAssistedBinding:()=>{validations++;if(mode==='tampered')throw Object.assign(Error('Tampered supplied evidence'),{code:'ASSISTED_BINDING'});},
      readAssistedEvidence:()=>{reads++;return {root:source,media,assessment:{ready:true}};}
    }});
    const {produceSite}=await import(${JSON.stringify(new URL('../src/production.mjs',import.meta.url).href)});
    const candidate={id:'lead-assisted-fixture',campaignId:'camp-assisted-fixture',name:'Synthetic Detailer',identityMatched:true,active:true,sourceUrls:['https://www.instagram.com/synthetic/'],facts:[{sourceUrl:'https://www.instagram.com/synthetic/'}],websiteCheck:{status:'no_official_site_found',queries:['Synthetic exact website'],checkedAt:new Date().toISOString()}};
    const store={stateRoot:root,candidate:()=>candidate,references:()=>[],db:{prepare:sql=>({get:()=>{if(sql.includes('factory_operation'))return {record:JSON.stringify(batch)};legacyQueries++;throw Object.assign(Error('Native discovery lookup is forbidden'),{code:'LEGACY_SOURCE_LOOKUP'});}})}};
    let stopped;
    try{await produceSite({store,job:{id:'job-assisted-fixture',campaignId:candidate.campaignId,input:{candidateId:candidate.id,...(mode==='held-parent'?{parentSiteJobId:'job-held-parent',parentSiteDigest:'c'.repeat(64)}:{})}},campaign:{model:'openai/gpt-6.1-sol-fast'},jobRoot:target,jobRelative:'jobs/fixture/attempt-0',signal:new AbortController().signal,register:async()=>{},stage:async(name,fn)=>{stages++;if(mode==='held-parent'&&name==='qualification')return candidate;return fn();},adapters:{prepareMedia:async()=>{sourceAdapterCalls++;throw Error('Unexpected source download');},makeBrief:async()=>{throw Object.assign(Error('Stop after tested media seam'),{code:'AFTER_ASSISTED_MEDIA'});}}});}catch(e){stopped=e.code||e.message;}
    let copied=false;try{copied=hash(await readFile(path.join(target,media[0].web_file)))===media[0].web_sha256;}catch{}
    console.log(JSON.stringify({stopped,validations,reads,legacyQueries,sourceAdapterCalls,stages,copied}));`;
  const child=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','--eval',script],{encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout.trim().split('\n').at(-1));
}
test('assisted production copies exact validated local media without fabricating a discovery job or downloading',()=>{
  const result=run('valid');assert.equal(result.stopped,'AFTER_ASSISTED_MEDIA');assert.ok(result.validations>=1);assert.ok(result.reads>=1);assert.equal(result.copied,true);assert.equal(result.legacyQueries,0);assert.equal(result.sourceAdapterCalls,0);
});
test('assisted source binding is checked before any qualification or media checkpoint can be reused',()=>{
  const result=run('tampered');assert.equal(result.stopped,'ASSISTED_BINDING');assert.equal(result.stages,0);assert.equal(result.copied,false);assert.equal(result.legacyQueries,0);assert.equal(result.sourceAdapterCalls,0);
});
test('an exact assisted revision reuses its validated retained media even when the held parent has no package',()=>{
  const result=run('held-parent');assert.equal(result.stopped,'AFTER_ASSISTED_MEDIA');assert.equal(result.copied,true);assert.equal(result.legacyQueries,0);assert.equal(result.sourceAdapterCalls,0);
});
