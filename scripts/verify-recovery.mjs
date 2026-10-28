/** Actual idle Factory snapshot/new-root drill; no restored code/jobs execute. */
import {mkdir,writeFile} from 'node:fs/promises';
import {openStore} from '../src/db.mjs';
import {createService,configFromEnv} from '../src/service.mjs';
import {hash,now} from '../src/contracts.mjs';
const config=configFromEnv(),store=openStore(config),service=createService(store,{autoRun:false});
const original={businesses:hash(store.businesses()),files:hash(store.libraryFiles()),candidates:hash(store.candidates())};
try{
  const snapshot=await service.dispatch('snapshot_create',{}),drill=await service.dispatch('snapshot_restore_check',{id:snapshot.id});
  const preserved=hash(original)===hash({businesses:hash(store.businesses()),files:hash(store.libraryFiles()),candidates:hash(store.candidates())});
  const report={at:now(),pass:drill.pass&&preserved,coverage:'Actual canonical idle Factory source/SQLite/state snapshot restored to a new private root; no restored jobs/server/scripts executed, canonical database not restored/overwritten',snapshotId:snapshot.id,sourceDigest:snapshot.sourceDigest,files:snapshot.files,bytes:snapshot.bytes,tablesCompared:drill.tablesCompared,artifactReferencesChecked:drill.artifactReferencesChecked,siteReferencesChecked:drill.siteReferencesChecked,staleOrMissingArtifactIds:drill.staleOrMissingArtifactIds,staleOrMissingSiteJobIds:drill.staleOrMissingSiteJobIds,autoRun:false,curatedRowsFilesAndCandidatesPreserved:preserved,externalLibraryFilesIncluded:false,limits:drill.limits};
  const out='/home/ai_dev/04_DELIVERABLES/simulacra-factory-20261021/verification/commercial-pilot-20261022';await mkdir(out,{recursive:true,mode:0o750});
  const target=`${out}/recovery-${report.at.replace(/[:.]/g,'-')}.json`;await writeFile(target,JSON.stringify(report,null,2),{flag:'wx',mode:0o640});console.log(JSON.stringify({...report,report:target},null,2));if(!report.pass)process.exitCode=1;
}finally{store.close();}
