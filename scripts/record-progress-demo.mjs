/** Local test-ledger recording only. No model, network-source adapter or canonical DB. */
import {mkdtemp,mkdir,writeFile,readFile,access,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {startServer} from '../src/server.mjs';
import {executeJob} from '../src/worker.mjs';
import {reconcileBatches} from '../src/batches.mjs';
import {reserveBatchUsage} from '../src/batch-budget.mjs';
import {hash,now} from '../src/contracts.mjs';
import {intakeFixture} from '../tests/helpers-batch.mjs';
import {policyIdentity} from '../src/policy.mjs';

const exec=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function sourceIdentity(){
  const policy=(await policyIdentity('production')).digest,files={};
  for(const name of ['web/progress.js','web/batches.js','web/app.js','web/style.css','web/index.html','scripts/record-progress-demo.mjs','tests/helpers-batch.mjs'])files[name]=hash(await readFile(new URL('../'+name,import.meta.url)));
  return {policy,files,digest:hash({policy,files})};
}
const source=await sourceIdentity();
const out='/home/ai_dev/04_DELIVERABLES/simulacra-factory-20261026/screening-progress';
await mkdir(out,{recursive:true,mode:0o750});
const suffix=new Date().toISOString().replace(/[:.]/g,'-'),video=path.join(out,'factory-progress-demo-'+suffix+'.mp4');
try {await access(video);throw new Error('Recording path already exists');} catch(e){if(e.code!=='ENOENT')throw e;}
const encoders=await exec('ffmpeg',['-hide_banner','-encoders'],{timeout:10000,maxBuffer:200000});
if(!encoders.stdout.includes('libx264'))throw new Error('Existing H.264 encoder unavailable; no installation was attempted');
const root=await mkdtemp('/tmp/factory-progress-recording-'),capture=path.join(root,'raw-capture.mp4');
const options={dbPath:path.join(root,'fixture.sqlite3'),stateRoot:path.join(root,'state'),autoRun:false,batchPrerequisites:async()=>({ready:true})};
await initialize(options);const store=openStore(options),service=createService(store,options);
const settings={area:'Houston city limits',niche:'LOCAL TEST DEMO — synthetic workshops',targetCount:1,candidateLimit:3,maxResearchRounds:1,searchProvider:'guest_bing',maxSearches:8,discoverySearchLimit:4,maxInspections:20,maxImageViews:6,maxModelRequests:10,batchMinutes:60,jobMinutes:10,workflow:'leads_first'};
await service.dispatch('batch_preset_save',{version:0,requestId:'recording-fixture-preset',settings,acknowledged:true});
const batch=await service.dispatch('batch_start',{presetVersion:1,requestId:'recording-fixture-start',authorized:true});
// Only the fixture service is mutable; there is no autoRun worker or adapter.
const app=await startServer(service,{port:0,previewPort:0});
const session='factory-video-'+randomUUID(),base=['--session',session,'--executable-path',process.env.FACTORY_BROWSER_EXECUTABLE||'/usr/bin/chromium','--allowed-domains','127.0.0.1,localhost','--json'];
const env={...process.env};delete env.DISPLAY;delete env.WAYLAND_DISPLAY;
const actions=[];let recording=false;
async function browser(args){
  const {stdout}=await exec('agent-browser',[...base,...args],{env,timeout:30000,maxBuffer:1000000});
  const result=JSON.parse(stdout);if(result.success===false)throw new Error('Isolated browser action failed: '+args[0]);
  actions.push({at:now(),action:args[0]});return result;
}
async function label(text){await browser(['eval',`(()=>{let n=document.querySelector('.recording-notice');if(!n){n=document.createElement('div');n.className='recording-notice';document.body.append(n);}n.textContent=${JSON.stringify(text)};})()`]);}
async function refresh(view='start'){
  await browser(['open',app.url+'/#'+view+'/'+batch.id]);
  await browser(['wait','--fn','document.querySelector("#refresh") && !document.querySelector("#refresh").disabled']);
  const readAfter=Date.now();
  await browser(['click','#refresh']);
  await browser(['wait','--fn',view==='leads'?'window.FactoryLeadsReady===true':'window.FactoryBatchReady===true']);
  // A readiness flag from the previous render is insufficient. Observe the new
  // server snapshot actually reaching the DOM before recording the next action.
  await browser(['wait','--fn',`Date.parse(document.querySelector('[data-ledger-progress] .progress-freshness time')?.dateTime)>=${readAfter}`]);
  await browser(['scrollintoview','[data-ledger-progress]']);
}
function specimen(n){
  const f=intakeFixture(n),name=`Synthetic Juniper ${n} workshop`,source=f.observations[0];
  f.candidate.name=name;source.title=name;source.text=name+'. '+source.text;
  f.candidate.summary='Fictional local test data; no real customer or fresh research.';
  f.candidate.websiteCheck={status:'unknown',queries:[],checkedAt:now(),linkChecks:[]};
  f.candidate.media=[];delete f.candidate.activityEvidence;delete f.candidate.pagePurposes;
  return f;
}
async function collected(ctx,specimens){
  const dir=path.join(ctx.jobRoot,'sources');await mkdir(dir,{recursive:true});
  for(const f of specimens)for(const o of f.observations)await writeFile(path.join(dir,o.id+'.json'),JSON.stringify(o));
  return {candidates:specimens.map(f=>f.candidate),live:false,shortfall:'LOCAL TEST DATA: no external search, native model, image acquisition or website build was performed.'};
}
try {
  await browser(['set','viewport','1280','900']);await browser(['open',app.url+'/#start/'+batch.id]);
  await browser(['wait','--fn','window.FactoryBatchReady===true']);
  await label('LOCAL TEST DEMO · Synthetic ledger · No paid research or site build');
  await browser(['scrollintoview','[data-ledger-progress]']);
  await browser(['record','start',capture,'--fps','20']);recording=true;await sleep(2500);
  const jobId=batch.researchJobIds[0];
  const discovery=await executeJob(store,jobId,{discover:async(_,ctx)=>{
    reserveBatchUsage(store,jobId,'searches');await refresh();await label('LOCAL TEST · Search allowance changes only when the test ledger reserves an attempt');
    await sleep(2500);
    reserveBatchUsage(store,jobId,'searches');reserveBatchUsage(store,jobId,'inspections');await refresh();await sleep(2500);
    const good=specimen(1),existing=specimen(2),outside=specimen(3),hub='https://beacons.ai/synthetic-juniper2',site='https://juniper2.example/';
    existing.observations[0].links.push({url:hub,text:'Business links'});
    existing.observations.push({id:'source-demo-hub',url:hub,inspectedAt:now(),blocked:false,text:existing.candidate.name+' test hub',links:[{url:site,text:'Official website'}]},{id:'source-demo-website',url:site,inspectedAt:now(),blocked:false,text:existing.candidate.name+' synthetic official website',links:[]});
    existing.candidate.websiteCheck.linkChecks=[{url:hub,sourceId:'source-demo-hub',status:'unofficial',reason:'Synthetic link hub'},{url:site,sourceId:'source-demo-website',status:'official',reason:'Synthetic identity-matched website'}];
    outside.observations[0].text+=' Based in Katy, Texas. Serving Houston.';
    return collected(ctx,[good,existing,outside]);
  }});
  if(discovery.state!=='review_ready')throw new Error('Local discovery demo stopped; no recorded success is inferred');
  await reconcileBatches(store);await refresh();await label('LOCAL TEST · Three saved prospects; screening is NOT full qualification');await sleep(3000);
  await refresh('leads');await browser(['wait','--fn','document.querySelectorAll("article.lead-row").length===3']);await browser(['scrollintoview','article.lead-row:nth-of-type(2)']);
  await label('LOCAL TEST · Linked official website is excluded before spending the enrichment slot');await sleep(3500);
  await browser(['scrollintoview','article.lead-row:nth-of-type(3)']);await label('LOCAL TEST · Non-Houston base wording stays held; the scope is not broadened');await sleep(3000);
  await browser(['scrollintoview','article.lead-row:first-of-type']);await browser(['click','article.lead-row button.primary:not(:disabled)']);
  await label('LOCAL TEST · Even a screened prospect needs exact selection and full intake');await sleep(3000);
  await browser(['find','role','button','click','--name','Confirm enrichment & make website']);
  await browser(['wait','--text','Enrichment in progress — no website yet.']);
  const enrichment=store.jobs().find(j=>j.input.phase==='enrichment');if(!enrichment)throw new Error('Fixture selection did not create its one enrichment job');
  const enriched=await executeJob(store,enrichment.id,{discover:async(_,ctx)=>{
    reserveBatchUsage(store,enrichment.id,'inspections');await refresh('leads');
    await label('LOCAL TEST · Enrichment remains separate from production; no website exists yet');await sleep(3000);
    return collected(ctx,[specimen(1)]);
  }});
  if(enriched.state!=='review_ready')throw new Error('Local enrichment demo stopped; no recorded success is inferred');
  await reconcileBatches(store);await refresh('leads');await label('LOCAL TEST · Missing full evidence holds production. No fake completion or human acceptance.');await sleep(3500);
  if(store.jobs().some(j=>j.kind==='site'))throw new Error('A fixture site job unexpectedly appeared');
  await service.dispatch('batch_stop',{id:batch.id});await refresh('leads');await sleep(1500);
  await browser(['record','stop']);recording=false;
  // Document-bound callouts disappear during navigation. A separate encoded
  // header labels EVERY frame, including reloads, blank frames and dialogs.
  const font=new URL('../web/assets/DMSans-Variable.ttf',import.meta.url).pathname;
  const watermark='LOCAL TEST DEMO | SYNTHETIC LEDGER | NO LIVE RESEARCH OR SITE BUILD';
  await exec('ffmpeg',['-hide_banner','-loglevel','error','-n','-threads','2','-i',capture,'-vf',`pad=iw:ih+64:0:64:color=0x1d2a22,drawtext=fontfile=${font}:expansion=none:text='${watermark}':fontcolor=white:fontsize=20:x=24:y=20`,'-an','-c:v','libx264','-threads','2','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',video],{timeout:120000,maxBuffer:2000000});
  const metadata=JSON.parse((await exec('ffprobe',['-v','error','-show_entries','format=duration,size:stream=codec_name,codec_type,width,height','-of','json',video],{timeout:10000})).stdout);
  if(metadata.streams.length!==1||metadata.streams[0].codec_type!=='video'||Number(metadata.format.duration)>90)throw new Error('Unexpected recording streams or duration');
  const {stdout:band}=await exec('ffmpeg',['-hide_banner','-loglevel','error','-threads','2','-i',video,'-vf','crop=1280:56:0:4,format=gray','-an','-f','rawvideo','-threads','2','pipe:1'],{encoding:'buffer',timeout:30000,maxBuffer:180000000});
  const frameSize=1280*56,frames=band.length/frameSize;if(!Number.isInteger(frames)||frames<1)throw new Error('Incomplete watermark-frame verification');
  const bright=[];for(let i=0;i<frameSize;i++)if(band[i]>180)bright.push(i);
  if(bright.length<frameSize*.015)throw new Error('Watermark reference has insufficient text contrast');
  let maxError=0,minBrightRetention=1;
  for(let frame=0;frame<frames;frame++){
    const offset=frame*frameSize;let error=0,retained=0;
    for(let i=0;i<frameSize;i+=4)error+=Math.abs(band[offset+i]-band[i]);
    for(const i of bright)if(band[offset+i]>140)retained++;
    maxError=Math.max(maxError,error/(frameSize/4));minBrightRetention=Math.min(minBrightRetention,retained/bright.length);
  }
  if(maxError>2||minBrightRetention<.98)throw new Error('The demo watermark was not stable across every decoded frame');
  await exec('ffmpeg',['-hide_banner','-loglevel','error','-n','-i',video,'-frames:v','1',video+'.first.png'],{timeout:15000,maxBuffer:1000000});
  await exec('ffmpeg',['-hide_banner','-loglevel','error','-n','-i',video,'-vf',`fps=4/${Number(metadata.format.duration)},scale=640:-2,tile=2x2`,'-frames:v','1',video+'.contact-sheet.png'],{timeout:15000,maxBuffer:1000000});
  if((await sourceIdentity()).digest!==source.digest)throw new Error('Source changed during recording; this is not a delivery clip');
  const report={at:now(),video:path.basename(video),bytes:(await stat(video)).size,metadata,source,demoWatermark:{text:watermark,encodedHeader:true,decodedFramesChecked:frames,maxMeanPixelError:maxError,minBrightRetention,passed:true},isolatedHeadlessBrowser:true,displayVariablesRemoved:true,desktopCapture:false,microphone:false,canonicalDbOpened:false,externalSourceCalls:0,nativeModelCalls:0,siteJobs:0,fixtureBatchId:batch.id,fixtureState:(await service.dispatch('batch_get',{id:batch.id})).batch.state,actions};
  await writeFile(video+'.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {
  if(recording)try{await browser(['record','stop']);}catch{/* Preserve any partial task-owned recording. */}
  try{await browser(['close']);}finally{await app.close();store.close();}
}
