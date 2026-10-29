// Real public-browser run through the same guarded service/worker used by the UI.
import path from 'node:path';
import {initialize,openStore} from '../src/db.mjs';
import {createService} from '../src/service.mjs';
import {executeJob} from '../src/worker.mjs';
import {DESIGN_REFERENCE_SEEDS} from '../src/design-references.mjs';
const root=path.resolve(process.env.FACTORY_STATE||'.factory-state');
const options={stateRoot:root,dbPath:process.env.FACTORY_DB||path.join(root,'factory.sqlite3')};await initialize(options);const store=openStore(options);
const requested=process.argv.slice(2);if(requested.some(id=>!DESIGN_REFERENCE_SEEDS.some(r=>r.id===id)))throw Error('Only registered reference IDs are supported');
try{const service=createService(store,{autoRun:false});for(const seed of DESIGN_REFERENCE_SEEDS.filter(r=>!requested.length||requested.includes(r.id))){const job=await service.dispatch('reference_audit',{referenceId:seed.id,requestId:'inspect-'+seed.id+'-'+Date.now()});const result=await executeJob(store,job.id);const reference=store.references().find(r=>r.id===seed.id);process.stdout.write(JSON.stringify({reference:seed.name,jobId:job.id,jobState:result.state,status:reference?.status,httpStatus:reference?.httpStatus,usableCaptures:reference?.captures?.filter(c=>c.visuallyNonempty&&c.contentReady).length||0,scriptErrors:reference?.scriptErrors?.length||0})+'\n');}}
finally{store.close();}
