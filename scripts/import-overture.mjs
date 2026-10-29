// Example: node scripts/import-overture.mjs --file /private/houston.parquet
// --release 2026-09-23.1 --licence-notice 'Actual export notice…'
// --attribution-url https://docs.overturemaps.org/attribution/ --use-confirmed
import path from 'node:path';import {fileURLToPath} from 'node:url';import {readFile,lstat} from 'node:fs/promises';import {parseArgs} from 'node:util';
import {runProcess} from '../src/process.mjs';import {hash} from '../src/contracts.mjs';import {openStore} from '../src/db.mjs';import {createService,configFromEnv} from '../src/service.mjs';import {readerEnvironment} from '../src/studio-readers.mjs';
const {values}=parseArgs({options:{file:{type:'string'},release:{type:'string'},'licence-notice':{type:'string'},'attribution-url':{type:'string'},'use-confirmed':{type:'boolean'}}});
if(!values.file||!values['use-confirmed'])throw Error('Select a local Parquet export and confirm its actual licence/use before importing');
const root=fileURLToPath(new URL('..',import.meta.url)),file=path.resolve(values.file),info=await lstat(file);if(!info.isFile()||info.size>256*1024*1024)throw Error('Expected a bounded regular Parquet file');
const result=await runProcess(path.join(root,'.factory-tools/overture/bin/python'),['-I','-B',path.join(root,'tools/overture-runtime/extract.py')],{env:readerEnvironment(),stdin:JSON.stringify({file}),timeout:30000,maxBytes:4*1024*1024});
const store=openStore(configFromEnv());try{const receipt=await createService(store,{autoRun:false}).dispatch('studio_baseline_import',{release:values.release,fileSha256:hash(await readFile(file)),licenceNotice:values['licence-notice'],attributionUrl:values['attribution-url'],useConfirmed:true,rows:JSON.parse(result.stdout).rows});process.stdout.write(JSON.stringify(receipt,null,2)+'\n');}finally{store.close();}
