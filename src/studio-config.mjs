import {z} from 'zod';
import path from 'node:path';
import {mkdir,open,readFile,lstat,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {hash,now,fail,publicUrl} from './contracts.mjs';
import {noLinks} from './db.mjs';
import {record,saveRecord,atomic} from './studio-state.mjs';
import {configureBudget,studioSpend,acknowledgeSpend} from './studio-budget.mjs';

export const PROVIDERS={
  deepseek:{label:'DeepSeek',env:'FACTORY_DEEPSEEK_KEY',endpoint:'https://api.deepseek.com/v1/chat/completions',protocol:'chat',model:'deepseek-chat'},
  openrouter:{label:'OpenRouter',env:'FACTORY_OPENROUTER_KEY',endpoint:'https://openrouter.ai/api/v1/chat/completions',protocol:'chat',model:'openai/gpt-4.1'},
  openai:{label:'OpenAI',env:'FACTORY_OPENAI_KEY',endpoint:'https://api.openai.com/v1/responses',protocol:'responses',model:'gpt-4.1'},
  google:{label:'Google Places',env:'FACTORY_GOOGLE_PLACES_KEY',endpoint:'https://places.googleapis.com/v1/places:searchText'},
  apollo:{label:'Apollo',env:'FACTORY_APOLLO_KEY',endpoint:'https://api.apollo.io/api/v1/organizations/enrich'},
  firecrawl:{label:'Firecrawl',env:'FIRECRAWL_API_KEY',endpoint:'https://api.firecrawl.dev/v2/search'},
};
const id=z.string().regex(/^(deepseek|openrouter|openai|google|apollo|firecrawl|custom-[a-z0-9-]{2,40})$/);
const stamp=z.string().datetime({offset:true});
const link=z.string().max(1800).refine(s=>{try{publicUrl(s);return true;}catch{return false;}});
export const rateCard=z.object({inputUsdPerMillion:z.number().min(0).max(1000).default(0),outputUsdPerMillion:z.number().min(0).max(1000).default(0),maxRequestUsd:z.number().min(0).max(100).default(0),freeRequests:z.number().int().min(0).max(300).default(0),verifiedAt:stamp,referenceUrl:link}).strict();
const provider=z.object({enabled:z.boolean().default(true),model:z.union([z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,150}$/),z.literal('')]).default(''),endpoint:link.optional(),price:rateCard.nullable().default(null)}).strict();
export const studioSettings=z.object({
  version:z.literal(1).default(1),providers:z.record(id,provider),
  roles:z.object({research:id,design:id,code:id,repair:id,vision:id}).strict(),
  city:z.literal('Houston, Texas').default('Houston, Texas'),niche:z.string().trim().min(2).max(100).default('mobile detailing'),
  areas:z.array(z.string().trim().min(2).max(150)).min(1).max(12).default(['Houston, Texas']),
  budgetCents:z.number().int().min(100).max(10000).default(10000),feesCents:z.number().int().min(0).max(10000).default(0),
  permissions:z.object({googleUse:z.boolean(),apolloUse:z.boolean(),firecrawlUse:z.boolean(),privatePublicPhotos:z.boolean()}).strict(),
  googleRetentionHours:z.number().int().min(1).max(720).default(24),
}).strict().superRefine((value,ctx)=>{
  for(const [name,p]of Object.entries(value.providers)){
    if((PROVIDERS[name]?.protocol||name.startsWith('custom-'))&&!p.model)ctx.addIssue({code:'custom',path:['providers',name,'model'],message:'Choose an explicit AI model'});
    if(name.startsWith('custom-')&&!p.endpoint)ctx.addIssue({code:'custom',path:['providers',name,'endpoint'],message:'A registered public HTTPS endpoint is required'});
    if(PROVIDERS[name]&&p.endpoint&&p.endpoint!==PROVIDERS[name].endpoint)ctx.addIssue({code:'custom',path:['providers',name,'endpoint'],message:'Built-in destinations cannot be changed'});
  }
  for(const[role,name]of Object.entries(value.roles))if(!value.providers[name]?.enabled||PROVIDERS[name]&&!PROVIDERS[name].protocol)ctx.addIssue({code:'custom',path:['roles',role],message:'Choose an enabled AI provider'});
});
export function defaultSettings(){
  return {version:1,providers:Object.fromEntries(Object.entries(PROVIDERS).map(([key,p])=>[key,{enabled:true,model:p.model||'',price:null}])),
    roles:{research:'deepseek',design:'deepseek',code:'deepseek',repair:'deepseek',vision:'openrouter'},city:'Houston, Texas',niche:'mobile detailing',areas:['Houston, Texas'],budgetCents:10000,feesCents:0,
    permissions:{googleUse:false,apolloUse:false,firecrawlUse:false,privatePublicPhotos:true},googleRetentionHours:24};
}
export const settingsRecord=store=>record(store,'studio-settings','studio_settings');
export function settings(store){return settingsRecord(store)?.data||defaultSettings();}
export function settingsDigest(store){return hash(settings(store));}
function vaultPath(store,ref){if(!/^[a-f0-9-]{36}$/.test(ref))fail('CREDENTIAL_PATH','Invalid private credential reference');return path.join(store.stateRoot,'credentials','providers',ref+'.key');}
export async function credential(store,providerId){
  const ref=settingsRecord(store)?.credentialRefs?.[providerId];
  if(ref){const file=vaultPath(store,ref);await noLinks(file);const s=await lstat(file);if(!s.isFile()||s.nlink!==1||(s.mode&0o077)||s.size>8192)fail('CREDENTIAL_PERMISSIONS','Private credential file must be a single mode-0600 regular file');return (await readFile(file,'utf8'));}
  return process.env[PROVIDERS[providerId]?.env]||'';
}
export async function credentialConfigured(store,providerId){try{return !!(await credential(store,providerId));}catch{return false;}}
export function priceFor(store,providerId){
  const price=settings(store).providers[providerId]?.price;
  if(!price||Date.now()-Date.parse(price.verifiedAt)>30*86400000||Date.parse(price.verifiedAt)>Date.now()+300000)fail('PRICE_UNVERIFIED','Confirm current account-specific pricing and its source before paid work');
  if(!price.inputUsdPerMillion&&!price.outputUsdPerMillion&&!price.maxRequestUsd&&!price.freeRequests)fail('PRICE_UNVERIFIED','A zero-priced profile needs an explicit bounded free-request allowance');
  return price;
}
export function flatUpperMicros(store,providerId){return Math.ceil(priceFor(store,providerId).maxRequestUsd*1e6);}
export async function studioStatus(store){
  const saved=settingsRecord(store),data=settings(store),connections=[];
  for(const [name,p]of Object.entries(data.providers)){
    const check=record(store,'provider-check-'+name,'studio_provider_check');
    const configured=await credentialConfigured(store,name);
    connections.push({id:name,label:PROVIDERS[name]?.label||name,configured,enabled:p.enabled,model:p.model,
      priced:!!p.price&&!!(p.price.inputUsdPerMillion||p.price.outputUsdPerMillion||p.price.maxRequestUsd||p.price.freeRequests)&&Number.isFinite(Date.parse(p.price.verifiedAt))&&Date.parse(p.price.verifiedAt)<=Date.now()+300000&&Date.now()-Date.parse(p.price.verifiedAt)<30*86400000,
      check:check&&check.settingsDigest===settingsDigest(store)&&check.credentialVersion===(saved?.credentialRefs?.[name]||'environment')?check:null});
  }
  return {version:saved?.version||0,data,connections,spending:studioSpend(store),keysReturned:false,
    limitations:['Pricing and source-use confirmations are operator declarations, not an account-contract audit.','API connectivity is separate from real lead yield and website quality.']};
}
export async function saveSettings(store,input){
  if(store.jobs().some(j=>['queued','running'].includes(j.state)&&!j.input.studioAutopilot&&!j.input.apiConcept&&!j.input.modelSelection?.startsWith('api/')))fail('LEGACY_WORK_ACTIVE','Stop or finish legacy queued/running work before changing this workspace to the shared API profile');
  const data=studioSettings.parse(input.data),created=[];const refs={...(settingsRecord(store)?.credentialRefs||{})};
  try{
    // Immutable credential versions: a failed/stale config save cannot change the
    // key used by the existing profile. Values never enter SQLite or JSON output.
    for(const [name,value]of Object.entries(input.credentials||{})){
      if(!data.providers[name])fail('PROVIDER_CONFIG','Credential provider is absent from the saved profile');
      if(!/^[\x21-\x7e]{4,8192}$/.test(value))fail('CREDENTIAL_INPUT','Enter a nonempty printable API key without whitespace');
      const ref=randomUUID(),file=vaultPath(store,ref);await noLinks(file);await mkdir(path.dirname(file),{recursive:true,mode:0o700});
      const handle=await open(file,'wx',0o600);try{await handle.writeFile(value);}finally{await handle.close();}created.push(file);refs[name]=ref;
    }
    return atomic(store,()=>{const prior=settingsRecord(store);if((prior?.version||0)!==input.version)fail('STALE_EVIDENCE','Settings changed; reload before saving');configureBudget(store,{limitCents:data.budgetCents,feesCents:data.feesCents});
      saveRecord(store,'studio-settings','studio_settings',{version:input.version+1,data,credentialRefs:refs,savedAt:now()});return {version:input.version+1,keysSaved:Object.keys(input.credentials||{}),settingsDigest:hash(data)};
    });
  }catch(error){await Promise.all(created.map(file=>unlink(file).catch(()=>{})));throw error;}
}
const op=(description,schema,readOnly=false)=>({description,schema,readOnly});
export const STUDIO_SETUP_OPERATIONS={
  studio_settings_get:op('Read settings, credential presence, tested capabilities and budget. Never returns key values.',z.object({}).strict(),true),
  studio_settings_save:op('Save exact-version non-secret settings and immutable private credentials. No external calls.',z.object({version:z.number().int().min(0),data:studioSettings,credentials:z.record(id,z.string().max(8192)).default({})}).strict()),
  studio_spend_get:op('Read global pilot spending and unresolved attempts without provider calls.',z.object({}).strict(),true),
  studio_spend_acknowledge:op('Acknowledge an exact stranded call; retains its entire reserved cost and never retries it.',z.object({id:z.string().regex(/^spend-[a-f0-9]{32}$/),startedAt:stamp,acknowledged:z.literal(true)}).strict()),
  studio_restore_reconcile:op('Reconcile an exact restore hold against operator-checked total lifetime provider spending. Paused automation still needs explicit resume.',z.object({snapshotId:z.string().regex(/^snapshot-[a-f0-9]{32}$/),restoredAt:stamp,totalLifetimeCents:z.number().int().min(0).max(10000),accountTotalsChecked:z.literal(true)}).strict()),
  studio_provider_test:op('Explicit bounded paid-capable integration test. Saves actual capabilities, never a real lead-quality certification.',z.object({provider:id,requestId:z.string().regex(/^[a-z0-9][a-z0-9-]{7,95}$/),authorized:z.literal(true)}).strict()),
};
export async function setupDispatch(store,name,input,options={}){
  if(name==='studio_settings_get')return studioStatus(store);
  if(name==='studio_settings_save')return saveSettings(store,input);
  if(name==='studio_spend_get')return studioSpend(store);
  if(name==='studio_spend_acknowledge')return acknowledgeSpend(store,input);
  if(name==='studio_restore_reconcile')return (await import('./studio-recovery.mjs')).reconcileStudioRestore(store,input);
  if(name==='studio_provider_test')return (await import('./studio-providers.mjs')).testProvider(store,input,options);
  fail('UNKNOWN_OPERATION','Unsupported setup operation');
}
