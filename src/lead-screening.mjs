// Deterministic triage of dated observations. This never invents verification,
// website absence, buying intent, contact consent or permission to build.
import { z } from 'zod';
import { hash } from './contracts.mjs';

const phrase = z.string().trim().min(2).max(100).refine(s => /[\p{L}\p{N}]/u.test(s));
export const leadTarget = z.object({
  name: phrase,
  areaTerms: z.array(phrase).min(1).max(30),
  serviceTerms: z.array(phrase).min(1).max(30),
  excludeTerms: z.array(phrase).max(30).default([]),
  lane: z.literal('no_independent_site'),
}).strict();
export const normalizeWords = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const latestSource = sources => sources.reduce((latest,s) => !latest || Date.parse(s.observedAt) >= Date.parse(latest.observedAt) ? s : latest, null);
const includesPhrase = (value, terms) => terms.some(term => (' ' + normalizeWords(value) + ' ').includes(' ' + normalizeWords(term) + ' '));
const age = (value, time) => time - Date.parse(value);
const current = (value, time) => Number.isFinite(age(value, time)) && age(value, time) >= -300000 && age(value, time) < 7 * 86400000;
const social = ['facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'x.com'];
const booking = ['booksy.com', 'square.site', 'squareup.com', 'setmore.com', 'acuityscheduling.com', 'calendly.com', 'fresha.com', 'glossgenius.com'];
const directory = ['google.com', 'google.co.uk', 'yelp.com', 'linktr.ee'];
const family = (host, list) => list.some(d => host === d || host.endsWith('.' + d));
export function websiteSurface(value) {
  if (!value) return 'not_listed';
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) return 'unknown';
    const h = u.hostname.toLowerCase();
    return family(h, social) ? 'social' : family(h, booking) ? 'booking' : family(h, directory) ? 'directory' : 'independent_listed';
  } catch { return 'unknown'; }
}
export function screenLead(lead, target, time = Date.now()) {
  const reasons = [], tasks = [], exclusions = [];
  const recent = lead.sources.filter(s => current(s.observedAt, time));
  const source = latestSource(recent);
  const surfaces = [...new Set(recent.map(s => websiteSurface(s.website)).filter(s => s !== 'not_listed'))];
  const surface = surfaces.includes('independent_listed') ? 'independent_listed' : surfaces[0] || 'not_listed';
  let score = 0;
  if (lead.suppression) exclusions.push('Locally suppressed; do not contact.');
  if (!recent.length) tasks.push('Refresh discovery data: no observation is less than seven days old.');
  else { score += 10; reasons.push('A discovery source was retrieved within seven days. Retrieval is not a business activity date.'); }
  if (lead.identityConflict) tasks.push('Resolve conflicting business identity or contact data.');
  if (lead.providerHold) tasks.push('Recheck the provider operating-status conflict.');
  const researchCurrent = source && lead.research?.sourceDigest === hash(source) && current(lead.research.observedAt,time);
  const researchHold = !!lead.websiteResearchHold;
  if(researchHold)tasks.push('Secondary search found a possible independent website. Verify ownership before using the no-site lane.');
  if(lead.research && !researchCurrent)tasks.push('Secondary-source research is outdated for this discovery observation.');
  if (!target) tasks.push('Save the target area and service before ranking leads.');
  let area = 'unknown', service = 'unknown';
  if (target && source) {
    // A changed address must not pass on an older matching observation.
    area = includesPhrase(source.area, target.areaTerms) ? 'match' : 'unknown';
    if (area === 'match') { score += 20; reasons.push('Listing address matches a configured target area.'); }
    else tasks.push('Confirm the service area; the latest listing address does not match the target.');
    const description = [source.name, ...(source.providerEvidence?.types || []), source.providerEvidence?.primaryType || ''].join(' ');
    if (includesPhrase(description, target.excludeTerms)) exclusions.push('Listing matches an explicitly excluded service term.');
    if (includesPhrase(description, target.serviceTerms)) { service = 'match'; score += 20; reasons.push('Listing name/category matches a configured service term.'); }
    else tasks.push('Confirm the actual services; brand names and broad categories are insufficient.');
  }
  const providerOperational = source?.provider === 'google_places' && source.providerEvidence?.businessStatus === 'OPERATIONAL';
  if (providerOperational) { score += 10; reasons.push('The latest provider observation reports OPERATIONAL; independently check recent activity.'); }
  else tasks.push('Find dated evidence that the business still operates.');
  const phoneListed = !!source?.phone;
  if (phoneListed) { score += 10; reasons.push('A normalized business phone is listed; ownership and reachability remain untested.'); }
  else tasks.push('Find and verify a published business contact.');
  if (surface === 'independent_listed') exclusions.push('A source lists an independent website. Exclude from the no-independent-site lane; assess redesign separately.');
  else if (['social', 'booking'].includes(surface)) { score += 15; reasons.push(`Source lists a ${surface} page, which may be worth researching.`); tasks.push('Check for an independent site using another source; a social/booking page does not prove website absence.'); }
  else tasks.push('Website is unknown. Independently search before claiming there is no site.');
  const gates = ['identity', 'location', 'activity', 'websiteNeed', 'contact', 'content'];
  const reviewComplete = gates.every(n => lead.gates?.[n]?.status === 'pass' && current(lead.gates[n].checkedAt, time));
  if (!reviewComplete) tasks.push('Complete the six dated evidence checks before selecting a business for a proposal.');
  if (reviewComplete) score += 15;
  const blocked = exclusions.length || !recent.length || lead.identityConflict || lead.providerHold || researchHold || !target;
  const state = exclusions.length ? 'excluded' : reviewComplete && !blocked && area === 'match' && service === 'match' ? 'reviewed_shortlist' : !blocked && area === 'match' && service === 'match' && phoneListed ? 'research_first' : 'needs_evidence';
  return { state, priority: blocked ? 0 : score, area, service, website: surface, reasons, tasks, exclusions,
    method: 'deterministic_review_priority_v1', scoreMeaning: 'Research priority, not buying probability or automatic qualification.',
    buildAuthorized: false, outreachAuthorized: false, websiteAbsenceProven: false };
}

export function leadHealth(leads, runs, schedule, target, time = Date.now()) {
  const counts = { total: leads.length, research_first: 0, reviewed_shortlist: 0, needs_evidence: 0, excluded: 0, stale: 0, suppressed: 0, conflicts: 0 };
  for (const lead of leads) {
    counts[screenLead(lead, target, time).state]++;
    if (!lead.sources.some(s => current(s.observedAt, time))) counts.stale++;
    if (lead.suppression) counts.suppressed++;
    if (lead.identityConflict || lead.providerHold) counts.conflicts++;
  }
  const last = runs.slice(0, 10).map(r => ({ id: r.id, state: r.state, startedAt: r.startedAt, completedAt: r.completedAt || null,
    query: r.query || null, area: r.area || null, transport: r.transport || 'unrecorded', newCount: r.newCount ?? null,
    refreshedCount: r.refreshedCount ?? null, returnedCount: r.returnedCount ?? null, heldCount: r.quarantined?.length ?? null, errorCode: r.errorCode || null }));
  const alerts = [];
  if (!target) alerts.push('Target rules are not configured.');
  if (!runs.some(r => r.state === 'completed' && r.transport === 'live_api')) alerts.push('No successful live provider response has been recorded.');
  if (!schedule?.enabled) alerts.push(schedule?.pauseReason ? 'Daily discovery paused: ' + schedule.pauseReason : 'Daily discovery is disabled.');
  if (counts.stale) alerts.push(`${counts.stale} pointer(s) need a source refresh.`);
  const latest = runs[0];
  if (latest && latest.state !== 'completed') alerts.push('Latest source attempt did not complete. Inspect the error before resuming.');
  const latestDay = schedule?.lastCompletedAt;
  if (schedule?.enabled && (!latestDay || age(latestDay, time) > 36 * 3600000) && age(schedule.savedAt, time) > 36 * 3600000) alerts.push('No completed daily run for over 36 hours. Check the VPS timer and provider.');
  return { counts, alerts, recentRuns: last, automation: { enabled: !!schedule?.enabled, pauseReason: schedule?.pauseReason || null, lastCompletedAt: latestDay || null },
    providerResponseProven: runs.some(r => r.state === 'completed' && r.transport === 'live_api'),
    sustainedLeadQualityProven: false, costPerQualifiedLead: null, limitations: 'Listing facts and review declarations are not authenticated business activity, contact deliverability, buying intent or source-use permission.' };
}
