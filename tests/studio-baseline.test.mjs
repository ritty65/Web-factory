import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {writeFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
import {apiFixture} from './helpers-studio.mjs';import {runProcess} from '../src/process.mjs';import {baselineMatches} from '../src/studio-baseline.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),python=path.join(root,'.factory-tools/overture/bin/python');
const record={id:'overture-fictional',name:'Fictional Oakline Detailing',categories:{primary:'car_detailing'},sources:[{dataset:'fictional-test-source',record_id:'fixture-1'}],longitude:-95.4,latitude:29.8,phones:['7135550101'],websites:[]};
const payload=rows=>({release:'2026-09-23.1',fileSha256:'b'.repeat(64),licenceNotice:'Fictional test export; this is not a real Overture permission statement.',attributionUrl:'https://docs.overturemaps.org/attribution/',useConfirmed:true,rows});
test('Overture baseline retains source/notice, replays exact imports and never qualifies the source pointer',async t=>{
 const {store,service}=await apiFixture(t);const first=await service.dispatch('studio_baseline_import',payload([record])),again=await service.dispatch('studio_baseline_import',payload([record]));assert.equal(first.advisoryOnly,true);assert.equal(again.replayed,true);
 const matches=baselineMatches(store,{data:{name:record.name,phone:'+17135550101'}});assert.equal(matches.length,1);assert.equal(matches[0].phoneMatch,true);assert.equal(matches[0].qualification,'unverified');assert.equal(store.candidates().length,0);
 await assert.rejects(service.dispatch('studio_baseline_import',payload([{...record,latitude:40}])),e=>e.code==='INVALID_INPUT');await assert.rejects(service.dispatch('studio_baseline_import',payload([record,record])),e=>e.code==='BASELINE_DUPLICATE');
});
test('real pinned DuckDB reads bounded local Houston Parquet without network extensions',async t=>{
 const {root:temp}=await apiFixture(t),file=path.join(temp,'fictional.parquet'),rows=path.join(temp,'rows.json');await writeFile(rows,JSON.stringify([{id:record.id,names:{primary:record.name},categories:record.categories,sources:record.sources,bbox:{xmin:-95.4,xmax:-95.39,ymin:29.8,ymax:29.81},phones:record.phones,websites:[]} ]));
 const script='import duckdb,sys; c=duckdb.connect();c.read_json(sys.argv[1]).write_parquet(sys.argv[2])';await runProcess(python,['-I','-B','-c',script,rows,file],{timeout:15000,maxBytes:4096});
 const result=await runProcess(python,['-I','-B',path.join(root,'tools/overture-runtime/extract.py')],{stdin:JSON.stringify({file}),timeout:15000,maxBytes:100000});const data=JSON.parse(result.stdout);assert.equal(data.rows.length,1);assert.equal(data.rows[0].name,record.name);assert.equal(data.rows[0].sources[0].record_id,'fixture-1');
 await assert.rejects(runProcess(python,['-I','-B',path.join(root,'tools/overture-runtime/extract.py')],{stdin:JSON.stringify({file:'https://example.com/private.parquet'}),timeout:10000,maxBytes:4096}));
});
