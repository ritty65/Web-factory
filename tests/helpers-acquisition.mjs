import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {workRelative} from '../src/contracts.mjs';
import {intakeFixture} from './helpers-batch.mjs';

export async function acquisitionFixture(t,overrides={}){
  const root=await mkdtemp('/tmp/factory-acquisition-'),options={dbPath:path.join(root,'db.sqlite'),stateRoot:path.join(root,'state'),autoRun:false,batchPrerequisites:async()=>({ready:true})};
  await initialize(options);const store=openStore(options);t.after(()=>store.close());const service=createService(store,options);
  const settings={area:'Houston city limits',niche:'Synthetic workshops',targetCount:1,candidateLimit:3,maxResearchRounds:1,searchProvider:'firecrawl',maxSearches:16,discoverySearchLimit:6,maxInspections:12,maxImageViews:6,maxModelRequests:16,batchMinutes:60,jobMinutes:30,workflow:'leads_first',...overrides};
  await service.dispatch('batch_preset_save',{version:0,requestId:'acquire-setup',settings,acknowledged:true});
  const b=await service.dispatch('batch_start',{presetVersion:1,requestId:'acquire-start',authorized:true}),job=store.jobs()[0];
  const directory=path.join(store.stateRoot,workRelative(job),'sources');await mkdir(directory,{recursive:true});
  return {root,options,store,service,b,job,settings,directory};
}
export async function draftFixture(f,n=1){
  const evidence=intakeFixture(n);
  for(const o of evidence.observations)await writeFile(path.join(f.directory,o.id+'.json'),JSON.stringify(o));
  return {evidence,output:{candidates:[evidence.candidate],shortfall:'Synthetic offline fixture only'}};
}
