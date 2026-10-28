// Queue only. The persistent app service owns execution and restart recovery.
import {openStore} from '../src/db.mjs';import {createService,configFromEnv} from '../src/service.mjs';
const store=openStore(configFromEnv());try{const service=createService(store,{autoRun:false});await service.dispatch('studio_data_purge',{});const result=await service.dispatch('studio_autopilot_tick',{});process.stdout.write(JSON.stringify({queued:result.queued,state:result.state||'queued',jobId:result.jobId||null})+'\n');}finally{store.close();}
