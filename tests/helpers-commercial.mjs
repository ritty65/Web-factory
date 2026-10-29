import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {now} from '../src/contracts.mjs';
export async function salesFixture(t){
  const root=await mkdtemp('/tmp/factory-commercial-'),options={dbPath:path.join(root,'db.sqlite3'),stateRoot:path.join(root,'state')};
  await initialize(options);const store=openStore(options);t.after(()=>store.close());
  const campaign=store.createCampaign({name:'Synthetic commercial fixture',area:'Houston',niche:'Fixture',query:'Fixture only',buildLimit:1});
  const lead=store.saveCandidate(campaign.id,{name:'Fixture public business',area:'Houston',summary:'Synthetic only',identityMatched:true,active:true,sourceUrls:['https://fixture.example/'],facts:[{text:'Fixture work',sourceUrl:'https://fixture.example/'}],websiteCheck:{status:'no_official_site_found',queries:['fixture'],checkedAt:now()}});
  return {root,options,store,service:createService(store,{autoRun:false}),campaign,lead};
}
