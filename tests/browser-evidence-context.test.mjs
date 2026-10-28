import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function captured(options = {}) {
  const script = `
    import {mock} from 'node:test';import {mkdtemp} from 'node:fs/promises';import vm from 'node:vm';
    const options=${JSON.stringify(options)};
    const profile=options.profile||'https://www.instagram.com/juniper1/',post=profile.includes('facebook.com')?profile+'posts/123':'https://www.instagram.com/juniper1/p/abc123/';
    const directory=await mkdtemp('/tmp/factory-context-reader-');
    mock.module(${JSON.stringify(new URL('../src/network.mjs', import.meta.url).href)},{namedExports:{resolvePublic:async()=>({address:'93.184.216.34',family:4}),safeFetch:async()=>{throw new Error('No network');}}});
    mock.module(${JSON.stringify(new URL('../src/process.mjs', import.meta.url).href)},{namedExports:{runProcess:async(_,args)=>{
      if(!args.includes('eval'))return {stdout:JSON.stringify({success:true,data:{}})};
      const legalLinks=options.missingLegal?[]:(options.legalLinks||['https://www.instagram.com/legal/privacy/','https://www.instagram.com/legal/terms/']);
      const legalFooter={querySelector:s=>legalLinks.some(href=>href.includes(s.includes('privacy')?'/legal/privacy':'/legal/terms'))?{}:null,querySelectorAll:()=>legalLinks.map(href=>({href}))};
      const link=(url,text,footer=false)=>({href:url,innerText:text,closest:s=>s==='article'&&options.insideArticle?{}:s==='footer'&&footer?legalFooter:null});
      const images=[{naturalWidth:800,naturalHeight:600,currentSrc:'https://scontent.cdninstagram.com/fixture.jpg?signature=private',alt:'Photo by Juniper on July 06, 2026.',closest:()=>({href:post})},
        {naturalWidth:800,naturalHeight:600,currentSrc:'https://scontent.cdninstagram.com/avatar.jpg',alt:'Avatar',closest:()=>({href:profile})}];
      const document={title:'Synthetic public profile',body:{innerText:'Synthetic public profile text. '.repeat(20)},querySelectorAll:s=>s==='a[href]'?[link(post,'Post'),link('https://muse.ai/','Muse',true),link('https://business.example/','Our website')]:[],images};
      const result=vm.runInNewContext(args.at(-1),{document,location:{href:profile},URL});return {stdout:JSON.stringify({success:true,data:{result}})};
    }}});
    const {inspectSource,publicObservation}=await import(${JSON.stringify(new URL('../src/browser.mjs', import.meta.url).href)});
    const raw=await inspectSource(profile,{directory});console.log(JSON.stringify({raw,public:publicObservation(raw)}));
  `;
  const { stdout } = await exec(process.execPath, ['--experimental-test-module-mocks','--input-type=module','--eval',script], {timeout:15000});
  return JSON.parse(stdout);
}

test('actual extraction preserves image-to-post relationships without promoting an avatar/profile or exporting CDN URLs', async () => {
  const result = await captured();
  assert.equal(result.raw.evidenceContextVersion, 1);
  assert.equal(result.public.evidenceContextVersion, 1);
  assert.equal(result.public.images[0].postUrl, 'https://www.instagram.com/juniper1/p/abc123/');
  assert.equal(result.public.images[1].postUrl, undefined);
  assert.equal(JSON.stringify(result.public).includes('signature=private'), false);
});
test('actual extraction distinguishes verified structural platform footer from business links', async () => {
  const { public: result } = await captured();
  assert.equal(result.links[1].region, 'platform_footer');
  assert.equal(result.links[2].region, undefined);
});

test('an arbitrary footer or a post/article footer is never promoted to global platform navigation', async () => {
  for (const options of [{missingLegal:true},{insideArticle:true}]) {
    const {public: result} = await captured(options);
    assert.equal(result.links[1].region, undefined);
    assert.equal(result.links[2].region, undefined);
  }
});

test('footer legal proof requires exact same-platform origins/routes, never foreign or query-string lookalikes', async () => {
  for (const legalLinks of [
    ['https://business.example/legal/privacy/','https://business.example/legal/terms/'],
    ['https://www.instagram.com/?next=/legal/privacy','https://www.instagram.com/?next=/legal/terms'],
    ['https://www.instagram.com.evil.example/legal/privacy/','https://www.instagram.com.evil.example/legal/terms/'],
    ['https://www.facebook.com/privacy/policy/','https://www.facebook.com/legal/terms/'],
  ]) {
    const {public: result} = await captured({legalLinks});
    assert.equal(result.links[1].region,undefined,JSON.stringify(legalLinks));
  }
  const {public: valid} = await captured({profile:'https://www.facebook.com/juniper1/',legalLinks:['https://www.facebook.com/privacy/policy/','https://www.facebook.com/legal/terms/']});
  assert.equal(valid.links[1].region,'platform_footer');
});
