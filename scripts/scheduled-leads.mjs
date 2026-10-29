// Intended for a private service-user timer. No schedule is enabled by default.
// Each due date has a durable one-use slot; ambiguous work is never auto-retried.
import {openStore} from '../src/db.mjs';
import {configFromEnv,createService} from '../src/service.mjs';
const store=openStore(configFromEnv());
try{const result=await createService(store,{autoRun:false}).dispatch('leads_schedule_tick',{});console.log(JSON.stringify({state:result.state,called:result.called,date:result.date||null,errorCode:result.errorCode||null}));if(['failed','held','uncertain','needs_configuration'].includes(result.state))process.exitCode=1;}finally{store.close();}
