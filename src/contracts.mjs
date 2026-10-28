import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';

export class FactoryError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export const fail = (code, message, details) => { throw new FactoryError(code, message, details); };
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const now = () => new Date().toISOString();
export function text(value, label, max = 500, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail('INVALID_INPUT', `${label} must contain ${min}–${max} characters`);
  return value.trim();
}
export function id(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,95}$/.test(value)) fail('INVALID_ID', 'Invalid stable ID');
  return value;
}
export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\\\u0000-\u001f:%?#]/.test(value) || path.posix.isAbsolute(value) || value.split('/').some(p => !p || p.startsWith('.')) || path.posix.normalize(value) !== value) fail('UNSAFE_PATH', 'Only normalized non-hidden relative paths are allowed');
  return value;
}
export function workRelative(job) {
  id(job.id);
  if (!Number.isInteger(job.attempt) || job.attempt < 0 || job.attempt > 1) fail('JOB_ATTEMPT', 'Unsupported bounded attempt');
  return `jobs/${job.id}/attempt-${job.attempt}${job.directionRepair ? '/direction-repair' : ''}`;
}
export function publicUrl(value, { signed = false } = {}) {
  let url;
  try { url = new URL(value); } catch { fail('UNSAFE_URL', 'A valid public HTTPS URL is required'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || isIP(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|test|onion)$/.test(host) || /[\u0000-\u0020\\]/.test(value)) fail('UNSAFE_URL', 'Only public HTTPS domain URLs without credentials are allowed');
  if (!signed && [...url.searchParams.keys()].some(key => /token|signature|password|secret|^key$|^sig$|^auth$/i.test(key))) fail('UNSAFE_URL', 'Signed/credential URLs cannot enter public metadata');
  url.hash = '';
  return url;
}
// Compare observed public resources without erasing account, post or page IDs.
// Invalid/credential URLs never produce an identity; no navigation is performed.
export function publicResourceKey(value) {
  try {
    const url = publicUrl(value);
    const facebook = /(^|\.)facebook\.com$/.test(url.hostname);
    url.hostname = url.hostname.replace(/^(www|m)\./, '');
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid$|gclid$)/i.test(key) || facebook && /^(?:mibextid$|__cft__(?:\[\d+\])?$|__tn__$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.origin + url.pathname.replace(/\/+$/, '') + url.search;
  } catch { return null; }
}
export function campaignInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', 'Campaign input must be an object');
  const result = { name: text(input.name, 'Campaign name', 100), query: text(input.query, 'Research query', 300), area: text(input.area, 'Area', 100), niche: text(input.niche, 'Niche', 100) };
  for (const [key, fallback, min, max] of [['candidateLimit', 10, 1, 100], ['buildLimit', 1, 1, 10], ['concurrency', 1, 1, 2], ['retryLimit', 1, 0, 1], ['deadlineMinutes', 30, 2, 60]]) {
    const n = input[key] ?? fallback;
    if (!Number.isInteger(n) || n < min || n > max) fail('INVALID_BUDGET', `${key} must be an integer from ${min} to ${max}`);
    result[key] = n;
  }
  if (result.buildLimit > result.candidateLimit) fail('INVALID_BUDGET', 'Build cap cannot exceed the candidate cap');
  result.autoBuild = input.autoBuild === true;
  result.model = input.model ? text(input.model, 'Model', 150) : null;
  return result;
}
export function assessEvidence(candidate) {
  const check = candidate.websiteCheck;
  if (check?.status === 'official_site_found') return { state: 'excluded', reason: 'A functioning official site was found; this is not a no-site lead.' };
  if (check?.status !== 'no_official_site_found') return { state: 'blocked', reason: 'Website absence is unresolved; failed/conflicting checks are not evidence of absence.' };
  if (check.linkChecks?.some(link => link.status === 'unresolved' || !link.sourceId)) return { state: 'blocked', reason: 'A possible outbound site remains unresolved or lacks an inspection source.' };
  if (!candidate.identityMatched || !candidate.active) return { state: 'blocked', reason: 'Business identity or activity needs evidence.' };
  if (!candidate.sourceUrls?.length || !candidate.facts?.length || !check.queries?.length) return { state: 'blocked', reason: 'Sources, facts and documented website queries are required.' };
  if (!Number.isFinite(Date.parse(check.checkedAt)) || Date.now() - Date.parse(check.checkedAt) > 7 * 86400000 || Date.parse(check.checkedAt) > Date.now() + 300000) return { state: 'blocked', reason: 'Website checks are stale or invalid.' };
  try { for (const url of candidate.sourceUrls) publicUrl(url); for (const fact of candidate.facts) publicUrl(fact.sourceUrl); } catch { return { state: 'blocked', reason: 'A source URL is unsafe or missing.' }; }
  return { state: 'qualified', reason: 'Documented no-official-site finding supports a private design proposal; not owner confirmation.' };
}
export const CONTACT_CHANNELS = Object.freeze(['phone', 'email', 'address', 'instagram', 'facebook']);
export const WEBSITE_STATUSES = Object.freeze(['no_official_site_found', 'official_site_found', 'unknown', 'failed', 'conflict']);
export const LINK_STATUSES = Object.freeze(['unofficial', 'not_business', 'official', 'unresolved']);
function contactError(label, message) { fail('INVALID_CONTACT_SOURCE', `${label}: ${message}`); }
function contactUrl(value, label) {
  if (typeof value !== 'string' || value.length > 1200) contactError(label, 'expected a public URL string (at most 1200 characters)');
  try { return publicUrl(value).href; } catch { contactError(label, 'expected a safe unsigned public HTTPS URL'); }
}
function contactMap(value, label, keys = CONTACT_CHANNELS) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) contactError(label, 'expected a bounded object');
  if (Object.keys(value).some(k => !keys.includes(k))) contactError(label, 'unknown fields are not allowed');
  return value;
}
function contactProof(value, label) {
  contactMap(value, label, ['sourceUrl', 'inspectionId', 'excerpt']);
  const sourceUrl = contactUrl(value.sourceUrl, `${label}.sourceUrl`);
  let inspectionId, excerpt;
  try { inspectionId = id(value.inspectionId); } catch { contactError(`${label}.inspectionId`, 'expected a stable observation ID'); }
  try { excerpt = text(value.excerpt, `${label}.excerpt`, 1000); } catch { contactError(`${label}.excerpt`, 'expected 1–1000 characters of literal observed text'); }
  return { sourceUrl, inspectionId, excerpt };
}
function normalizeContactSources(input, result) {
  if (input.contactSources !== undefined) {
    const sources = contactMap(input.contactSources, 'contactSources'); result.contactSources = {};
    for (const [channel, value] of Object.entries(sources)) {
      const label = `contactSources.${channel}`;
      if (typeof value === 'string') result.contactSources[channel] = contactUrl(value, label);
      else {
        const proof = contactProof(value, label);
        result.contactSources[channel] = proof.sourceUrl;
        (result.contactSourceEvidence ||= {})[channel] = proof;
      }
    }
  }
  if (input.contactSourceEvidence !== undefined) {
    const evidence = contactMap(input.contactSourceEvidence, 'contactSourceEvidence');
    for (const [channel, value] of Object.entries(evidence)) {
      const label = `contactSourceEvidence.${channel}`, proof = contactProof(value, label), prior = result.contactSourceEvidence?.[channel];
      if (result.contactSources?.[channel] !== proof.sourceUrl || prior && (prior.inspectionId !== proof.inspectionId || prior.excerpt !== proof.excerpt || prior.sourceUrl !== proof.sourceUrl)) contactError(label, 'conflicting or missing contactSources binding');
      (result.contactSourceEvidence ||= {})[channel] = proof;
    }
  }
}
function evidenceRef(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key => !['kind', 'sourceId', 'imageId', 'postUrl'].includes(key)) || value.kind !== 'image_alt') throw new Error();
    return { kind: 'image_alt', sourceId: id(value.sourceId), imageId: id(value.imageId), postUrl: publicUrl(value.postUrl).href };
  } catch { fail('INVALID_EVIDENCE_REF', 'evidenceRef requires only kind=image_alt, actual sourceId/imageId and a safe observed postUrl'); }
}
export function candidateInput(input) {
  const result = { name: text(input.name, 'Business name', 150), area: text(input.area, 'Business area', 150), summary: text(input.summary, 'Summary', 1800), identityMatched: input.identityMatched === true, active: input.active === true };
  result.sourceUrls = [...new Set((input.sourceUrls || []).slice(0, 20).map(u => publicUrl(u).href))];
  result.facts = (input.facts || []).slice(0, 30).map((f, i) => ({ id: `fact-${i + 1}`, text: text(f.text, 'Sourced fact', 1000), sourceUrl: publicUrl(f.sourceUrl).href, ...(f.excerpt ? { excerpt: text(f.excerpt, 'Observed fact excerpt', 1000) } : {}), ...(f.evidenceRef !== undefined ? { evidenceRef: evidenceRef(f.evidenceRef) } : {}) }));
  result.contacts = {};
  for (const key of CONTACT_CHANNELS) if (input.contacts?.[key]) result.contacts[key] = key === 'instagram' || key === 'facebook' ? publicUrl(input.contacts[key]).href : text(input.contacts[key], key, 200);
  normalizeContactSources(input, result);
  result.websiteCheck = { status: WEBSITE_STATUSES.includes(input.websiteCheck?.status) ? input.websiteCheck.status : 'unknown', queries: (input.websiteCheck?.queries || []).slice(0, 10).map(q => text(q, 'Website query', 300)), checkedAt: input.websiteCheck?.checkedAt || now(), ...(input.websiteCheck?.url ? { url: publicUrl(input.websiteCheck.url).href } : {}) };
  if (input.websiteCheck?.linkChecks) result.websiteCheck.linkChecks = input.websiteCheck.linkChecks.slice(0, 25).map(v => ({ url: publicUrl(v.url).href, sourceId: v.status === 'unresolved' && v.sourceId == null ? null : id(v.sourceId), status: LINK_STATUSES.includes(v.status) ? v.status : 'unresolved', reason: text(v.reason, 'Link finding', 1000) }));
  if (input.pagePurposes) result.pagePurposes = input.pagePurposes.slice(0, 5).map(v => ({ purpose: text(v.purpose, 'Page purpose', 300), factIds: (v.factIds || []).slice(0, 30).map(id) }));
  if (input.activityEvidence) {
    result.activityEvidence = { sourceId: id(input.activityEvidence.sourceId), excerpt: text(input.activityEvidence.excerpt, 'Activity excerpt', 1000), dateText: text(input.activityEvidence.dateText, 'Observed date text', 100), date: text(input.activityEvidence.date, 'Activity date', 40), ...(input.activityEvidence.evidenceRef !== undefined ? { evidenceRef: evidenceRef(input.activityEvidence.evidenceRef) } : {}) };
    if (result.activityEvidence.evidenceRef && result.activityEvidence.sourceId !== result.activityEvidence.evidenceRef.sourceId) fail('INVALID_EVIDENCE_REF', 'Activity and image evidence must bind the same actual source ID');
  }
  result.unknowns = (input.unknowns || []).slice(0, 20).map(v => text(v, 'Unknown', 1000));
  result.inspectionIds = (input.inspectionIds || []).slice(0, 15).map(id);
  result.observationJobIds = (input.observationJobIds || []).slice(0, 15).map(id);
  result.media = (input.media || []).slice(0, 6).map(v => ({ sourceId: id(v.sourceId), imageId: id(v.imageId), account: publicUrl(v.account).href, postUrl: publicUrl(v.postUrl).href, businessPosted: v.businessPosted === true, alt: text(v.alt, 'Image description', 1200).slice(0, 300), role: text(v.role || 'supporting', 'Image role', 100), credit: text(v.credit || 'Creator not separately identified', 'Image credit', 300), postedAt: v.postedAt ? text(v.postedAt, 'Posted date', 100) : null }));
  result.assessment = assessEvidence(result);
  result.states = { humanAcceptance: 'pending', ownerAcceptance: 'unconfirmed', imageRights: 'private_preview_only', outreach: 'not_authorized', payment: 'not_recorded' };
  return result;
}
export const candidateKey = data => `lead-${hash({ name: data.name.toLowerCase(), area: data.area.toLowerCase(), social: data.contacts.instagram || data.contacts.facebook || null }).slice(0, 20)}`;
export const SITE_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.svg', '.webp', '.jpg', '.jpeg', '.png', '.ttf', '.woff2', '.txt', '.ico']);
export function validateProposal(input, { pageCount = 5 } = {}) {
  if (![1, 5].includes(pageCount)) fail('INVALID_PROPOSAL', 'Only host-owned one-page studies or five-page proposals are supported');
  if (!input || !Array.isArray(input.files) || input.files.length < pageCount || input.files.length > 35) fail('INVALID_PROPOSAL', 'A proposal needs complete useful HTML pages and bounded static files');
  const names = new Set(); let total = 0, js = 0, css = 0;
  const files = input.files.map(file => {
    const name = safeRelative(file.path);
    if (/^assets\/(?:factory-motion\.(?:js|css)|fonts\/)/.test(name)) fail('RESERVED_ASSET', 'Reserved host runtime/font assets cannot be replaced by model output');
    if (!['.html', '.css', '.js', '.svg', '.txt'].includes(path.posix.extname(name)) || names.has(name.toLowerCase())) fail('INVALID_PROPOSAL', 'Duplicate or unsupported model file');
    names.add(name.toLowerCase());
    const content = text(file.content, 'Static file', 240000);
    const bytes = Buffer.byteLength(content); total += bytes;
    if (name.endsWith('.js')) js += bytes;
    if (name.endsWith('.css')) css += bytes;
    if (/\b(?:src|poster)\s*=\s*["'](?:https?:)?\/\/|@import\s*|url\(\s*["']?(?:https?:)?\/\/|<base\b|<meta[^>]+http-equiv\s*=/i.test(content)) fail('REMOTE_RUNTIME', 'Remote runtime resources/base/meta refresh are not allowed in proposals');
    return { path: name, content };
  });
  if (!names.has('index.html') || files.filter(f => f.path.endsWith('.html')).length !== pageCount || total > 2 * 1024 * 1024 || js > 50 * 1024 || css > 50 * 1024) fail('PROPOSAL_BUDGET', 'Proposal page/file budgets exceeded');
  const design = input.design || {};
  if (typeof design.thesis !== 'string' || !Array.isArray(design.comparisons) || design.comparisons.length < 3) fail('DESIGN_REQUIRED', 'A specific design thesis and three non-color comparisons are required');
  return { files, design: { thesis: text(design.thesis, 'Visual thesis', 2500), comparisons: design.comparisons.slice(0, 6).map(v => text(v, 'Design comparison', 1000)), interaction: typeof design.interaction === 'string' ? text(design.interaction, 'Interaction plan', 2500) : 'Inspect actual page controls and motion before acceptance.' } };
}
