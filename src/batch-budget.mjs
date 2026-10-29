import { AsyncLocalStorage } from 'node:async_hooks';
import { batchForCampaign, guardBatchJob, saveBatch } from './batch-store.mjs';
import { fail, publicUrl, publicResourceKey, workRelative,hash,now } from './contracts.mjs';
import path from 'node:path';
import { transaction } from './sales.mjs';
import {completionCapacity} from './acquisition.mjs';

const context = new AsyncLocalStorage();
const caps = { modelRequests: 'maxModelRequests', searches: 'maxSearches', inspections: 'maxInspections', imageViews: 'maxImageViews' };
export function withJobBudget(store, jobId, fn) { return context.run({ store, jobId }, fn); }
export function jobBudgetContext() { return context.getStore(); }
export function sourceJobPolicy(store, jobId, directory) {
  const job = store.job(jobId), batch = batchForCampaign(store, job.campaignId);
  if (!batch || job.kind !== 'discovery' || path.resolve(directory) !== path.join(store.stateRoot, workRelative(job), 'sources')) fail('BATCH_SOURCE_BINDING', 'Source tools must bind the host-selected discovery job and exact source directory.');
  const exactAttempt=current=>{if(current.attempt!==job.attempt)fail('BATCH_SOURCE_BINDING','This source server belongs to an earlier job attempt; no work or result may cross attempts.');};
  return {
    provider: batch.settings.searchProvider,
    researchContext() {
      const current=store.job(jobId);guardBatchJob(store,current,{claiming:true});
      exactAttempt(current);
      if(!['queued','running'].includes(current.state))fail('BATCH_STOPPED','Owned research is no longer active.');
      const candidateLimit=current.input.candidateLimit??store.campaign(current.campaignId).candidateLimit;
      if(!Number.isInteger(candidateLimit)||candidateLimit<1||candidateLimit>batch.settings.candidateLimit)fail('BATCH_SOURCE_BINDING','Research checker cannot widen the original candidate cap.');
       return {candidateLimit,settings:batch.settings,...(batch.acquisition?{acquisition:batch.acquisition}: {})};
    },
    reserve(unit, { provider, url, planned=false,onReserved } = {}) {
      if (provider && provider !== batch.settings.searchProvider) fail('SOURCE_POLICY', 'Only the saved research provider is permitted.');
      if (url) { const u = publicUrl(url); if (/^(?:maps\.|places\.)?(?:google\.[a-z.]+)$/.test(u.hostname.replace(/^www\./, '')) || /(^|\.)(goo\.gl|maps\.app\.goo\.gl|googleapis\.com)$/.test(u.hostname)) fail('SOURCE_POLICY', 'Google Maps/Places collection is not part of the saved public-web/social reader.'); }
      const scoutDiscovery=batch.acquisition?.version===1&&job.input.phase==='discovery';
      if(scoutDiscovery&&unit==='searches'&&!planned)fail('SOURCE_SCOUT_REQUIRED','New discovery searches use sources.scout with a host-planned query; no attempt was made.');
      return reserveBatchUsage(store, jobId, unit,({batch:current,job:owned})=>{
        exactAttempt(owned);
        if(scoutDiscovery&&unit==='inspections'&&url){
          const id=`source-attempt-${hash({batchId:current.id,url:publicResourceKey(url)}).slice(0,24)}`;
          if(store.db.prepare('SELECT 1 FROM factory_operation WHERE id=?').get(id))fail('SOURCE_ALREADY_ATTEMPTED','This observed route was already attempted in discovery; no retry or charge.');
          if(store.db.prepare("SELECT count(*) n FROM factory_operation WHERE kind='source_attempt' AND json_extract(record,'$.jobId')=?").get(jobId).n>=24)fail('SOURCE_INSPECTION_CAP','The original job page-attempt cap is exhausted.');
          const record={id,kind:'source_attempt',batchId:current.id,jobId,attempt:owned.attempt,url:publicUrl(url).href,at:now(),status:'attempt_reserved_not_success'};
          store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?)').run(id,'source_attempt',JSON.stringify(record));
        }
        onReserved?.({batch:current,job:owned});
      });
    },
  };
}
// Attempts are reserved BEFORE network/model work. Failure and process death do
// not refund a unit. This bounds calls, never dollars or tokens.
export function reserveBatchUsage(store, jobId, unit,onReserved) {
  if (!Object.hasOwn(caps, unit)) fail('BATCH_BUDGET', 'Unknown usage unit');
  return transaction(store, () => {
    const job = store.job(jobId), b = batchForCampaign(store, job.campaignId); if (!b) return null;
    guardBatchJob(store, job, { claiming: true });
    if (!['queued', 'running'].includes(job.state)) fail('BATCH_STOPPED', 'Owned work is no longer active.');
    const discovery = b.settings.workflow === 'leads_first' && job.input.phase === 'discovery';
    if (discovery && unit === 'imageViews') fail('BATCH_DISCOVERY_BUDGET', 'Image work is reserved for explicitly selected enrichment.');
    if (discovery && unit === 'searches' && b.discoveryUsage.searches >= b.settings.discoverySearchLimit) fail('BATCH_DISCOVERY_BUDGET', 'Discovery search allocation exhausted; remaining total capacity is reserved for selected enrichment.');
     if (b.usage[unit] >= b.settings[caps[unit]]) fail('BATCH_BUDGET', `The saved ${unit} allowance is exhausted. Completed work and failed attempts are retained.`);
     if(b.acquisition?.version===1){
       if(discovery&&(!completionCapacity(b).available||b.settings[caps[unit]]-b.usage[unit]-1<b.acquisition.reserve[unit]))fail('BATCH_COMPLETION_BUDGET','Discovery must preserve the frozen selected-intake/production capacity; no attempt was made.');
       if(job.input.phase==='enrichment'&&unit==='modelRequests'&&b.settings.maxModelRequests-b.usage.modelRequests-1<b.acquisition.productionModelFloor)fail('BATCH_COMPLETION_BUDGET','Enrichment must preserve the frozen native-launch capacity for production; no attempt was made.');
     }
    const next = saveBatch(store, { ...b, usage: { ...b.usage, [unit]: b.usage[unit] + 1 }, ...(discovery && unit === 'searches' ? { discoveryUsage: { ...b.discoveryUsage, searches: b.discoveryUsage.searches + 1 } } : {}) });
     store.event(jobId, 'batch.usage_reserved', 'Bounded attempt reserved; not a billing observation', { batchId: b.id, unit, used: next.usage[unit], cap: b.settings[caps[unit]] });
     onReserved?.({batch:next,job});
    return { batchId: b.id, unit, used: next.usage[unit], cap: b.settings[caps[unit]], ...(discovery ? { discoveryUsed: next.discoveryUsage.searches, discoveryCap: b.settings.discoverySearchLimit, discoveryRemaining: Math.max(0, b.settings.discoverySearchLimit - next.discoveryUsage.searches) } : {}) };
  });
}
