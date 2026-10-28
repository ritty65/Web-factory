// Fictional integration proof: real services/SQLite/parser/Chromium/ZIPs,
// injected source and AI replies. Never a live-provider or 72-hour soak claim.
import path from 'node:path';import {mkdir,writeFile,cp,readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {autopilotFixture} from '../tests/helpers-studio-autopilot.mjs';import {studioSiteData,siteModelResponse} from '../tests/helpers-studio-site.mjs';
import {autopilotDispatch} from '../src/studio-autopilot.mjs';import {settingsDigest} from '../src/studio-config.mjs';import {record,records} from '../src/studio-state.mjs';
import {executeJob} from '../src/worker.mjs';import {studioSpend} from '../src/studio-budget.mjs';import {startServer} from '../src/server.mjs';import {createService} from '../src/service.mjs';import {hash} from '../src/contracts.mjs';
const output=path.resolve(process.env.FACTORY_PROOF_OUTPUT||'.artifacts/studio-proof-'+Date.now()),cleanup=[];
await mkdir(output,{recursive:true,mode:0o700});
try{
 const f=await autopilotFixture({after:fn=>cleanup.push(fn)},{count:3});let modelData;const routed=[];
 const request=async(url,options)=>{const answer=modelData&&siteModelResponse(url,options,modelData);if(answer){const body=JSON.parse(options.body);routed.push({provider:url.includes('deepseek')?'deepseek':'openrouter',images:Array.isArray(body.messages?.at(-1)?.content),model:body.model});return answer;}return f.request(url,options);};
 const receipts=[];
 for(let day=0;day<3;day++){
  const clock=()=>{const d=new Date(Date.now()+day*86400000);d.setUTCHours(19,0,0,0);return d;};
  const slot=await autopilotDispatch(f.store,day?'studio_autopilot_tick':'studio_autopilot_start',day?{}:{version:0,settingsDigest:settingsDigest(f.store),requestId:'fictional-three-day-proof',authorized:true},{request:f.request,clock});
  if(!slot.queued)throw Error('Expected exactly one simulated daily slot: '+slot.state);
  const discovery=await executeJob(f.store,slot.jobId,{studioRequest:request,observeSource:f.observe});if(discovery.state!=='review_ready')throw Error(discovery.errorCode+': '+discovery.message);
  const site=f.store.jobs().find(j=>j.kind==='site'&&j.state==='queued');if(!site)throw Error('No source-backed proposal queued');
  const proof=record(f.store,site.input.apiConcept.proofId,'studio_concept_proof');modelData=studioSiteData(proof.candidate);
  const result=await executeJob(f.store,site.id,{studioRequest:request});if(result.state!=='review_ready')throw Error(result.errorCode+': '+result.message);
  const qa=JSON.parse(await readFile(path.join(f.store.stateRoot,result.outputs.qaRelative,'results.json'),'utf8')),archive=f.store.getArtifact(result.outputs.archiveId);
  if(!qa.pass||qa.pageChecks.length!==25||hash(await readFile(path.join(f.store.stateRoot,archive.relative)))!==archive.sha256)throw Error('Actual browser/ZIP proof did not match');
  await cp(path.join(f.store.stateRoot,'jobs',site.id),path.join(output,'private-proposal-'+(day+1)),{recursive:true,errorOnExist:true});
  receipts.push({jobId:site.id,assessmentId:site.input.apiConcept.assessmentId,simulatedChicagoDate:site.input.apiConcept.date,qaPass:qa.pass,pageViewportChecks:qa.pageChecks.length,siteDigest:result.outputs.siteDigest,archiveSha256:archive.sha256,humanDecision:result.outputs.humanDecision,photoCount:result.outputs.photoCount});
  process.stdout.write('Fictional proposal '+(day+1)+': real browser checks and exact ZIP passed.\n');
 }
 const app=await startServer(createService(f.store,{autoRun:false,studioRequest:request}),{port:0,previewPort:0}),browser=await chromium.launch({headless:true,executablePath:process.env.FACTORY_BROWSER_EXECUTABLE});
 try{
  const context=await browser.newContext(),page=await context.newPage();
  for(const width of [1440,390])for(const route of ['autopilot','setup']){await page.setViewportSize({width,height:1000});await page.goto(app.url+'/?capture='+route+'-'+width+'#'+route);await page.waitForFunction(route=>route==='setup'?window.FactorySetupReady:window.FactoryAutopilotReady,route);await page.screenshot({path:path.join(output,route+'-'+width+'.png'),fullPage:true});}
 }finally{await browser.close();await app.close();}
 const report={schema:1,at:new Date().toISOString(),verification:'fictional_provider_responses_real_local_pipeline',realProviderCalls:0,actualVpsHours:0,sourceCheckedFixtures:records(f.store,'studio_assessment').filter(a=>a.state==='source_checked').length,proposals:receipts,modelRoutes:routed,spendFixtureMicros:studioSpend(f.store).committedMicros,publicRelease:false,humanAcceptedProposals:0,limits:['Source replies and AI replies were controlled fixtures, not live lead or model-quality evidence.','Three schedule dates were simulated; elapsed runtime is not a 72-hour VPS soak.','Camofox guard has a separate Chromium-backed integration test. Genuine Camoufox launch remains a live prerequisite.','Fictional templates are pipeline fixtures and do not represent promised design quality.']};
 await writeFile(path.join(output,'proof.json'),JSON.stringify(report,null,2),{mode:0o600});process.stdout.write('Private fictional proof saved at '+output+'\n');
}finally{for(const fn of cleanup.reverse())await fn();}
