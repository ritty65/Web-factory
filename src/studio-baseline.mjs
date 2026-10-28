import {z} from 'zod';import {hash,now,fail} from './contracts.mjs';
import {record,records,saveRecord,atomic} from './studio-state.mjs';
import {normalizeWords} from './lead-screening.mjs';import {normalizePhone} from './lead-workspace.mjs';
const row=z.object({id:z.string().min(1).max(200),name:z.string().min(2).max(200),categories:z.unknown(),sources:z.array(z.record(z.string(),z.unknown())).min(1).max(20),longitude:z.number().min(-95.90).max(-95.00),latitude:z.number().min(29.45).max(30.15),phones:z.array(z.string().max(100)).max(20),websites:z.array(z.string().max(1800)).max(20)}).strict();
const schema=z.object({release:z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/),fileSha256:z.string().regex(/^[a-f0-9]{64}$/),licenceNotice:z.string().min(15).max(3000),attributionUrl:z.url().startsWith('https://').max(1800),useConfirmed:z.literal(true),rows:z.array(row).max(1000)}).strict();
export const STUDIO_BASELINE_OPERATIONS={
  studio_baseline_import:{description:'Import a bounded, explicitly licensed local Overture export as advisory pointers only. Does not qualify businesses or authorize builds.',schema,readOnly:false},
  studio_baseline_status:{description:'Read open-data release and provenance status without external requests.',schema:z.object({}).strict(),readOnly:true},
};
export function baselineDispatch(store,name,input){
  if(name==='studio_baseline_status'){const imports=records(store,'studio_baseline_import');return {imports:imports.map(({rows,...r})=>r),records:records(store,'studio_baseline').length,advisoryOnly:true,liveFeedVerified:false};}
  if(name!=='studio_baseline_import')fail('UNKNOWN_OPERATION','Unsupported baseline operation');
  const value=schema.parse(input),id='baseline-import-'+hash(value).slice(0,24),prior=record(store,id,'studio_baseline_import');if(prior)return {...prior,replayed:true};
  return atomic(store,()=>{
    const identities=new Set();for(const r of value.rows){if(identities.has(r.id))fail('BASELINE_DUPLICATE','Duplicate Overture identity in the same export');identities.add(r.id);}
    for(const r of value.rows)saveRecord(store,'baseline-'+hash(r.id).slice(0,24),'studio_baseline',{...r,release:value.release,licenceNotice:value.licenceNotice,attributionUrl:value.attributionUrl,fileSha256:value.fileSha256,importedAt:now(),qualification:'unverified'});
    return saveRecord(store,id,'studio_baseline_import',{id,release:value.release,count:value.rows.length,fileSha256:value.fileSha256,licenceNotice:value.licenceNotice,attributionUrl:value.attributionUrl,at:now(),advisoryOnly:true});
  });
}
export function baselineMatches(store,pointer){
  const phone=value=>{try{return normalizePhone(value);}catch{return null;}};
  return records(store,'studio_baseline').filter(r=>normalizeWords(r.name)===normalizeWords(pointer.data.name)).slice(0,5).map(r=>({id:r.id,release:r.release,licenceNotice:r.licenceNotice,attributionUrl:r.attributionUrl,sources:r.sources,nameMatch:true,phoneMatch:!!pointer.data.phone&&r.phones.some(p=>phone(p)===pointer.data.phone),independentWebsites:r.websites,qualification:'unverified'}));
}
