// A second-source search can find contradictions and research tasks. Search
// snippets never prove website absence, current operations or contact consent.
import { z } from 'zod';
import { hash, now, fail } from './contracts.mjs';
import { transaction } from './sales.mjs';
import { providerHttp } from './provider-http.mjs';
import { firecrawlSearch } from './search.mjs';
import { normalizeWords, websiteSurface, latestSource } from './lead-screening.mjs';

const key = z.string().regex(/^[a-z0-9][a-z0-9-]{7,95}$/);
const operation = (description, schema, readOnly = false) => ({ description, schema, readOnly });
export const LEAD_RESEARCH_OPERATIONS = {
  leads_research: operation('Explicit one-request secondary-source check of an exact pointer version. Search matches are clues, never qualification.', z.object({ id: key, version: z.number().int().min(0), requestId: key, authorized: z.literal(true), termsReviewed: z.literal(true) }).strict()),
  leads_research_status: operation('Read secondary-source configuration and consumed daily request attempts.', z.object({}).strict(), true),
  leads_research_resolve: operation('Acknowledge an exact stranded search as uncertain; keeps consumed quota and never retries.', z.object({ id: key, startedAt: z.string().datetime({offset:true}), acknowledged: z.literal(true) }).strict()),
};
const get = (store, id, kind) => { const r = store.db.prepare('SELECT record FROM factory_operation WHERE id=? AND kind=?').get(id, kind); return r ? JSON.parse(r.record) : null; };
const runs = store => store.db.prepare("SELECT record FROM factory_operation WHERE kind='lead_research_run' ORDER BY rowid DESC").all().map(r => JSON.parse(r.record));
const put = (store, id, kind, value) => { const r = store.db.prepare('INSERT INTO factory_operation VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record WHERE factory_operation.kind=excluded.kind').run(id, kind, JSON.stringify(value)); if (!r.changes) fail('STATE_NAMESPACE', 'Record identity belongs to another operation type'); };
export function researchStatus(store) {
  const all = runs(store), recent = all.filter(r => Date.now() - Date.parse(r.startedAt) < 86400000);
  return { provider: 'firecrawl', configured: !!process.env.FIRECRAWL_API_KEY, attemptsLast24h: recent.length, attemptLimit: 3,
    unresolved: all.filter(r => r.state === 'requesting').map(r => ({id:r.id,startedAt:r.startedAt})),
    providerResponseProven: all.some(r => r.state === 'completed' && r.transport === 'live_api'), limitations: 'At most three secondary searches per rolling 24h, five results each. No automatic retries. Search results do not prove business facts or absence.' };
}
export function analyzeSearch(lead, results) {
  const source = latestSource(lead.sources), name = normalizeWords(source.name), area = normalizeWords(source.area), phone = source.phone?.replace(/\D/g, '');
  const matches = results.map(r => {
    const text = normalizeWords(r.title + ' ' + r.description);
    const identity = name.length >= 4 && (' ' + text + ' ').includes(' ' + name + ' ');
    const phoneMatch = !!phone && phone.length >= 8 && (r.title + ' ' + r.description).replace(/\D/g, '').includes(phone.replace(/^1(?=\d{10}$)/, ''));
    const areaMatch = area.length >= 3 && text.includes(area);
    return {...r,identityMatch:identity,phoneMatch,areaMatch,surface:websiteSurface(r.url)};
  });
  const possibleWebsiteUrls = matches.filter(r => r.identityMatch && r.surface === 'independent_listed').map(r => r.url);
  const corroboratingHosts = [...new Set(matches.filter(r => r.identityMatch && r.phoneMatch).map(r => new URL(r.url).hostname))];
  return {matches,possibleWebsiteUrls,corroboratingHosts,websiteAbsenceProven:false,contactReachabilityProven:false,
    result: possibleWebsiteUrls.length ? 'possible_independent_site' : matches.some(r => r.identityMatch) ? 'identity_clues_only' : 'inconclusive',
    nextAction: possibleWebsiteUrls.length ? 'Inspect these possible sites and verify ownership before selecting the no-site lane.' : 'No absence conclusion is possible. Verify identity, activity, contact and website status independently.'};
}
export async function leadResearchDispatch(store, name, input, {request = providerHttp} = {}) {
  if (name === 'leads_research_status') return researchStatus(store);
  if (name === 'leads_research_resolve') return transaction(store, () => {
    const r = get(store,input.id,'lead_research_run');
    if (!r || r.startedAt !== input.startedAt) fail('STALE_EVIDENCE','Match the exact stranded research receipt');
    if (r.state !== 'requesting') return r;
    if (Date.now()-Date.parse(r.startedAt)<120000) fail('SOURCE_ACTIVE','Wait at least two minutes before resolving a stranded search');
    const result = {...r,state:'uncertain',completedAt:now(),errorCode:'RESEARCH_UNCERTAIN'};
    put(store,r.id,'lead_research_run',result); return result;
  });
  const id = 'lead-search-' + hash(input.requestId).slice(0,24), inputDigest = hash(input);
  const cached = get(store,id,'lead_research_run');
  if (cached) { if(cached.inputDigest!==inputDigest)fail('IDEMPOTENCY_CONFLICT','Search request already has different input'); return {...cached,replayed:true}; }
  const lead = get(store,input.id,'workspace_lead');
  if (!lead) fail('NOT_FOUND','Lead not found');
  if (lead.version !== input.version) fail('STALE_EVIDENCE','Lead changed; reload before searching');
  if (lead.suppression || lead.identityConflict || lead.providerHold) fail('RESEARCH_HELD','Suppressed or conflicting identities cannot start automated research');
  const source = latestSource(lead.sources), sourceAge = Date.now()-Date.parse(source?.observedAt);
  if (!Number.isFinite(sourceAge) || sourceAge < -300000 || sourceAge >= 7*86400000) fail('STALE_EVIDENCE','Refresh the source pointer before research');
  if (!process.env.FIRECRAWL_API_KEY) fail('RESEARCH_CONFIGURATION','Add FIRECRAWL_API_KEY securely; no secondary request was made');
  const sourceDigest = hash(source), previous = lead.research;
  if (previous?.sourceDigest === sourceDigest && Date.now()-Date.parse(previous.observedAt)<7*86400000) return {state:'cached',replayed:true,research:previous};
  transaction(store, () => {
    const status = researchStatus(store);
    if (status.unresolved.length) fail('RESEARCH_UNCERTAIN','A secondary-source attempt has no final receipt; inspect it before further work');
    if (status.attemptsLast24h >= status.attemptLimit) fail('RESEARCH_BUDGET','Daily secondary-source attempt limit reached');
    put(store,id,'lead_research_run',{id,inputDigest,leadId:lead.id,leadVersion:lead.version,sourceDigest,state:'requesting',transport:request===providerHttp?'live_api':'injected_transport',startedAt:now(),usage:{requests:1,charge:'unknown'}});
  });
  try {
    // Bounded literal query, never model instructions or executable source text.
    const query = (JSON.stringify(source.name.slice(0,140))+' '+source.area.slice(0,95)+' official website phone').slice(0,300);
    const response = await firecrawlSearch(query,{request});
    const research = {provider:'firecrawl',sourceDigest,observedAt:now(),transport:request===providerHttp?'live_api':'injected_transport',...analyzeSearch(lead,response.results)};
    return transaction(store, () => {
      const current = get(store,lead.id,'workspace_lead');
      const attach = current?.version===lead.version && !current.suppression;
      if(attach)put(store,lead.id,'workspace_lead',{...current,research,...(research.possibleWebsiteUrls.length?{websiteResearchHold:{at:now(),urls:research.possibleWebsiteUrls}}:{}),version:current.version+1,updatedAt:now()});
      const result = {...get(store,id,'lead_research_run'),state:attach?'completed':'stale_result',completedAt:now(),creditsUsed:response.creditsUsed,research};
      put(store,id,'lead_research_run',result); return result;
    });
  } catch(e) {
    const result = {...get(store,id,'lead_research_run'),state:'failed',completedAt:now(),errorCode:/^(PROVIDER_|SEARCH_)/.test(e.code||'')?e.code:'RESEARCH_FAILED',message:'Secondary search failed. No automatic retry; prior data and consumed request retained.'};
    put(store,id,'lead_research_run',result); return result;
  }
}
