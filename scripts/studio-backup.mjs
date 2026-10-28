// Local private backup; encrypted off-server storage remains an operator task.
import path from 'node:path';import {rm,lstat} from 'node:fs/promises';
import {openStore,noLinks} from '../src/db.mjs';import {createService,configFromEnv} from '../src/service.mjs';
const store=openStore(configFromEnv());try{
  const service=createService(store,{autoRun:false});await service.dispatch('studio_data_purge',{});
  if(store.db.prepare("SELECT 1 FROM factory_job WHERE state IN ('queued','running') LIMIT 1").get()){process.stdout.write('Backup deferred: owned work is active.\n');}
  else{
    const snap=await service.dispatch('snapshot_create',{}),drill=await service.dispatch('snapshot_restore_check',{id:snap.id});if(!drill.pass)throw Error('Private restore drill failed');
    // Retain seven successful local snapshots. Fixed namespaces only; a failed
    // or unrecognized directory is never selected for deletion by this script.
    const list=(await service.dispatch('snapshot_list',{})).snapshots.filter(s=>s.id!==snap.id).sort((a,b)=>b.at.localeCompare(a.at));
    for(const old of list.slice(6))if(old.relative==='releases/'+old.id&&/^snapshot-[a-f0-9]{32}$/.test(old.id)){
      const target=path.join(store.stateRoot,old.relative);await noLinks(target);try{if((await lstat(target)).isDirectory())await rm(target,{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
      store.db.prepare("DELETE FROM factory_operation WHERE id=? AND kind='snapshot'").run(old.id);
    }
    // The disposable drill copies include private source/media. Delete only
    // this verified, newly created drill; keep its metadata receipt.
    if(drill.restoreRoot.startsWith(path.join(store.stateRoot,'restores')+path.sep)){await noLinks(drill.restoreRoot);await rm(drill.restoreRoot,{recursive:true});}
    process.stdout.write(JSON.stringify({snapshotId:snap.id,restoreCheckPassed:drill.pass,localOnly:true})+'\n');
  }
}finally{store.close();}
