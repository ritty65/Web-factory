import { hash, publicResourceKey, publicUrl } from './contracts.mjs';
import { assessIntake, profileAnchors, identityObservations } from './intake.mjs';
import { relevantSearchEvidence } from './search.mjs';
import { normalized, parseRecord, memberEvidenceCurrent, suppressionFor, existingEntity, getBatch } from './batch-store.mjs';
import {assessScreening,screeningContext,isBookingUrl,isLinkHubUrl} from './screening.mjs';
import {assessMaterial,completionCapacity} from './acquisition.mjs';

const fresh = value => Number.isFinite(Date.parse(value)) && Date.now() - Date.parse(value) <= 7 * 86400000 && Date.parse(value) <= Date.now() + 300000;
// Only stable public page URLs are returned. Never expose source image/CDN URLs.
function safeLink(value) {
  try {
    const u=publicUrl(value),host=u.hostname.replace(/^(www|m)\./,'');
    if (/(^|\.)(fbcdn\.net|cdninstagram\.com)$/.test(u.hostname) || /\.(jpg|png|webp|jpeg)$/i.test(u.pathname)) return null;
    if (u.search) {
      const keys=[...u.searchParams.keys()];
      const locale=host==='instagram.com' && /^\/[A-Za-z0-9._-]+\/?$/.test(u.pathname) && keys.length===1 && keys[0]==='hl' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(u.searchParams.get('hl'));
      const account=host==='facebook.com' && u.pathname==='/profile.php' && keys.length===1 && keys[0]==='id' && /^\d+$/.test(u.searchParams.get('id'));
      if (!locale && !account) return null;
    }
    return u.href;
  } catch { return null; }
}
const same = (a, b) => Boolean(publicResourceKey(a) && publicResourceKey(a) === publicResourceKey(b));
const booking = isBookingUrl;
export function assessProspect(c, evidence = {}, settings = {}) {
  const full = assessIntake(c, evidence), observations = evidence.observations || [];
  const bound = observations.filter(o => c.inspectionIds.includes(o.id) && !o.blocked && fresh(o.inspectedAt));
  const identity = identityObservations(c, bound);
  const facts = screeningContext(c,evidence).facts;
  const queries = [...new Set(c.websiteCheck.queries.map(normalized))];
  const verifiedSearches = queries.length >= 2 && queries.every(q => (evidence.searches || []).some(s => s.status === 'completed' && s.intent === 'verify' && fresh(s.at) && normalized(s.query) === q && relevantSearchEvidence(`"${c.name}"`, s.results || [])));
  const links = identity.flatMap(o => o.links || []);
  const bookingDestinations = [...new Set(links.map(l => safeLink(l.url)).filter(u => u && booking(u) && c.websiteCheck.linkChecks?.some(v => same(v.url, u) && observations.some(o => o.id === v.sourceId && !o.blocked && fresh(o.inspectedAt) && (same(o.url, u) || same(o.finalUrl, u))))))];
  const unresolved = full.reasons.some(r => /outbound|website searches/.test(r));
  const independent = (c.websiteCheck.linkChecks || []).some(v => v.status === 'official' && observations.some(o => o.id === v.sourceId && !o.blocked && fresh(o.inspectedAt) && (same(o.url, v.url) || same(o.finalUrl, v.url)) && !booking(o.finalUrl || v.url) && !isLinkHubUrl(o.finalUrl || v.url)));
  const linkSupport = (c.websiteCheck.linkChecks || []).map(v => observations.find(o => o.id === v.sourceId && (same(o.url, v.url) || same(o.finalUrl, v.url))));
  const missingLinkSupport = linkSupport.some(o => !o || o.blocked || !fresh(o.inspectedAt));
  const screening = assessScreening(c,evidence,settings);
  const websiteStatus = independent || screening.status === 'excluded' ? 'independent_official_site' : bookingDestinations.length || screening.status === 'booking_only' ? 'booking_only' : c.websiteCheck.status === 'official_site_found' && bound.some(o => (same(o.url, c.websiteCheck.url) || same(o.finalUrl, c.websiteCheck.url)) && !booking(o.finalUrl || c.websiteCheck.url) && !isLinkHubUrl(o.finalUrl || c.websiteCheck.url)) ? 'independent_official_site' : screening.status === 'clear_for_enrichment' && c.websiteCheck.status === 'no_official_site_found' && identity.length && verifiedSearches && !unresolved && !missingLinkSupport && fresh(c.websiteCheck.checkedAt) ? 'no_official_site_found' : 'unknown';
  const positive = Boolean(identity.length && facts.some(f => /\bhouston\b/.test(normalized(f.excerpt))) && full.contacts.length);
  const expiryBounds = [c.websiteCheck.checkedAt, ...bound.map(o => o.inspectedAt), ...(evidence.searches || []).filter(s => s.status === 'completed' && s.intent === 'verify' && fresh(s.at)).map(s => s.at), ...(evidence.imageViews || []).filter(v => fresh(v.at)).map(v => v.at)].filter(v => Number.isFinite(Date.parse(v))).map(v => Date.parse(v) + 7 * 86400000);
  for (const o of linkSupport) if (o && Number.isFinite(Date.parse(o.inspectedAt))) expiryBounds.push(Date.parse(o.inspectedAt) + 7 * 86400000);
  if (c.activityEvidence?.date && Number.isFinite(Date.parse(c.activityEvidence.date))) expiryBounds.push(Date.parse(c.activityEvidence.date) + 180 * 86400000);
  const evidenceValidUntil = !missingLinkSupport && (identity.length || screening.status === 'clear_for_enrichment') && expiryBounds.length ? new Date(Math.min(...expiryBounds)).toISOString() : null;
  return { evidenceDigest: hash(c), evidenceValidUntil, state: websiteStatus === 'booking_only' ? 'booking_only' : websiteStatus === 'independent_official_site' ? 'excluded' : screening.status !== 'clear_for_enrichment' ? 'held' : full.ready && !missingLinkSupport ? 'ready' : positive && websiteStatus === 'no_official_site_found' ? 'strong' : 'held',
    screening, material:assessMaterial(c,evidence), websiteStatus, bookingDestinations, buildUnsupported: websiteStatus === 'booking_only' ? 'Booking-platform-only production is not supported by the current no-site qualification policy.' : null,
    identityObserved: Boolean(identity.length), factsObserved: facts.length, contacts: full.contacts.filter(c => safeLink(c.sourceUrl) && (!['instagram', 'facebook'].includes(c.channel) || safeLink(c.value))),
    sources: identity.map(o => ({ id: o.id, url: safeLink(o.url), checkedAt: o.inspectedAt })).filter(o => o.url),
    lastCheckedAt: identity.map(o => o.inspectedAt).sort().at(-1) || null, missingEvidence: full.reasons,
    photoEvidence: { selected: c.media.length, status: full.ready ? 'bound_private_preview_only' : 'not_build_verified', publicLicence: 'unconfirmed' } };
}
export const SOURCE_MATRIX = [
  { id: 'firecrawl', status: 'configured_adapter_requires_run_readiness', coverage: 'Public web search only, up to five results; page inspection uses the separate page reader, not this adapter. No media acquisition or yield guarantee.' },
  { id: 'guest_bing', status: 'limited', coverage: 'Guest public search; relevance/source failures remain holds' },
  { id: 'facebook_instagram', status: 'limited', coverage: 'Normal guest public inspection and observed business-posted media; no login bypass or public licence' },
  ...['google_maps', 'booksy_bulk', 'licensed_data_provider'].map(id => ({ id, status: 'not_connected', coverage: 'No collection adapter authorized' })),
];
export function prospectItem(store, b, m) {
  const c = store.candidate(m.candidateId), current = m.evidenceDigest === hash(c), suppressed = Boolean(suppressionFor(store, c)), duplicate = Boolean(existingEntity(store, c));
  const p = current && m.prospect?.evidenceDigest === hash(c) ? m.prospect : { state: 'held', websiteStatus: 'unknown', sources: [], contacts: [], missingEvidence: ['Current host-bound prospect evidence is missing.'], bookingDestinations: [], buildUnsupported: null, lastCheckedAt: null, photoEvidence: { selected: 0, status: 'not_build_verified', publicLicence: 'unconfirmed' } };
  const historicalExclusion = b.settings.workflow !== 'leads_first' && current && !m.prospect && c.assessment?.state === 'excluded' && c.websiteCheck?.status === 'official_site_found';
  const excluded = historicalExclusion || suppressed || duplicate || m.disposition === 'not_a_fit' || p.websiteStatus === 'independent_official_site';
  const needsChanges = m.disposition === 'needs_changes';
  const expired = !Number.isFinite(Date.parse(p.evidenceValidUntil)) || Date.now() >= Date.parse(p.evidenceValidUntil);
  const expiredPositive = expired && ['strong', 'ready'].includes(p.state);
  const anchored = profileAnchors(c).length > 0;
   const capacity=completionCapacity(b),materialAvailable=b.acquisition?.version!==1||p.material?.version===1&&p.material.feasible===true;
   const allowanceAvailable = capacity.available && [['searches','maxSearches'],['inspections','maxInspections'],['imageViews','maxImageViews'],['modelRequests','maxModelRequests']].every(([unit,cap]) => Number.isFinite(b.usage?.[unit]) && b.usage[unit] < b.settings[cap]);
  return { ...p, id: c.id, candidateId: c.id, batchId: b.id, campaignId: b.campaignId, name: c.name, area: c.area, category: b.settings.niche,
    evidenceDigest: hash(c), state: excluded ? 'excluded' : needsChanges || expiredPositive || p.state === 'ready' && !memberEvidenceCurrent(m, c) ? 'held' : p.state,
    websiteStatus: expired && p.websiteStatus === 'no_official_site_found' ? 'unknown' : p.websiteStatus,
    ready: !needsChanges && !expired && p.state === 'ready' && Boolean(p.sources.length) && !excluded && !p.buildUnsupported && memberEvidenceCurrent(m, c), suppressed, duplicate,
     reasons: [...(m.reasons || []), ...(!anchored ? ['No original valid public social profile anchor; inspect saved source evidence before selection.'] : []), ...(!materialAvailable?(p.material?.gaps||['Material check has no current host-bound feasibility receipt.']):[]),...capacity.gaps, ...(b.settings.workflow === 'leads_first' && !allowanceAvailable ? ['A saved total allowance is exhausted or unavailable; selection cannot reset it.'] : []), ...(historicalExclusion ? ['Recorded historical official-site finding; not freshly verified.'] : []), ...(needsChanges ? ['Supplied needs-changes feedback holds this prospect.'] : []), ...(expiredPositive ? ['Host-bound source/search evidence expired; refresh before a positive prospect claim.'] : []), ...(suppressed ? ['Suppressed business.'] : []), ...(duplicate ? ['Existing identity match requires review.'] : [])],
     canSelect: anchored && materialAvailable && allowanceAvailable && p.screening?.version === 1 && p.screening.status === 'clear_for_enrichment' && !expired && b.settings.workflow === 'leads_first' && b.state === 'awaiting_selection' && !b.selection && current && !excluded && !expiredPositive && !p.buildUnsupported && !['not_a_fit', 'needs_changes'].includes(m.disposition) && Date.now() < Date.parse(b.deadlineAt),
    researchJobId: m.researchJobId, selected: b.selection?.candidateId === c.id, historyCount: m.history?.length || 0 };
}
export function leadList(store, { batchId, candidateId, state, offset = 0, limit = 30 } = {}) {
  const batches = batchId ? [getBatch(store, batchId)] : store.db.prepare("SELECT record FROM factory_operation WHERE kind='batch' ORDER BY rowid DESC").all().map(parseRecord);
  const all = batches.flatMap(b => b.members.filter(m => !candidateId || m.candidateId === candidateId).map(m => prospectItem(store, b, m))).filter(p => !state || p.state === state);
  return { items: all.slice(offset, offset + limit), total: all.length, offset, limit, nextOffset: offset + limit < all.length ? offset + limit : null, sources: SOURCE_MATRIX, readOnly: true };
}
