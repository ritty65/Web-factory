import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assessEvidence, publicUrl, publicResourceKey, hash } from './contracts.mjs';
import { readObservations } from './browser.mjs';
import { relevantSearchEvidence } from './search.mjs';
import { validateMediaSelection } from './media.mjs';
import { normalized } from './batch-store.mjs';
import { noLinks } from './db.mjs';
import { observedImageText, observedDate } from './evidence-context.mjs';
import {assessDestinations} from './destinations.mjs';
import {attributedPostContent,requiresPostEvidence} from './post-evidence.mjs';

export async function readIntakeEvidence(directory) {
  const observations = await readObservations(directory), searches = [], imageViews = [];
  let names; try { names = await readdir(directory); } catch (e) { if (e.code === 'ENOENT') return { observations, searches, imageViews }; throw e; }
  for (const name of names.filter(n => /^(search-[a-f0-9]+|image-view-[a-f0-9]+)\.json$/.test(n)).slice(0, 100)) {
    const file = path.join(directory, name); await noLinks(file); const bytes = await readFile(file);
    if (bytes.length > 1000000) continue;
    const record = JSON.parse(bytes); (name.startsWith('search-') ? searches : imageViews).push(record);
  }
  return { observations, searches, imageViews };
}
const canonical = publicResourceKey;
function facebookPeopleProfile(value) {
  try {
    const u=publicUrl(value),host=u.hostname.replace(/^(www|m)\./,''),route=u.pathname.replace(/\/+$/,'');
    return host==='facebook.com' && !u.search && /^\/people\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/\d{6,20}$/.test(route);
  } catch { return false; }
}
const committedProfile = o => !facebookPeopleProfile(o.url) || Boolean(canonical(o.finalUrl) && canonical(o.finalUrl) === canonical(o.url));
function socialProfile(value, channel) {
  try {
    const u = publicUrl(value), host = u.hostname.replace(/^(www|m)\./, ''), route = u.pathname.replace(/\/+$/, '');
    if (host !== `${channel}.com`) return false;
    if (channel === 'facebook' && route === '/profile.php') return u.searchParams.getAll('id').length === 1 && /^\d+$/.test(u.searchParams.get('id'));
    if (channel === 'facebook' && facebookPeopleProfile(value)) return true;
    return /^\/[A-Za-z0-9._-]+$/.test(route) && !/^\/(about|accounts|business|explore|groups|help|legal|login|p|photo|photos|policies|privacy|reel|reels|search|share|stories)$/i.test(route);
  } catch { return false; }
}
export function profileAnchors(candidate) {
  const contacts = ['instagram', 'facebook'].filter(channel => socialProfile(candidate.contacts?.[channel], channel)).map(channel => canonical(candidate.contacts[channel]));
  const sources = contacts.length ? contacts : (candidate.sourceUrls || []).filter(url => ['instagram', 'facebook'].some(channel => socialProfile(url, channel))).map(canonical);
  return [...new Set(sources)].filter(Boolean).slice(0, 40);
}
function verifiedProfile(c, url, evidence) {
  return ['instagram', 'facebook'].some(channel => socialProfile(url, channel) && canonical(url) === canonical(c.contacts[channel])) && evidence.some(o =>
    c.inspectionIds.includes(o.id) && !o.blocked && fresh(o.inspectedAt) && canonical(o.url) === canonical(url) && committedProfile(o) && o.text?.length >= 250 &&
    relevantSearchEvidence(`"${c.name}"`, [{ url: o.url, title: o.title, description: o.text }]));
}
function firstParty(c, o, evidence) {
  if(requiresPostEvidence(o.url))return Boolean(postContent(c,o,evidence));
  if (['instagram', 'facebook'].some(channel => socialProfile(c.contacts[channel], channel) && canonical(c.contacts[channel]) === canonical(o.url))) return committedProfile(o);
  if(socialProfile(o.url,'instagram'))return false;
  if(c.media.some(m => canonical(m.postUrl) === canonical(o.url)))return true;
  if (!verifiedProfile(c, c.contacts.facebook, evidence)) return false;
  const profile = publicUrl(c.contacts.facebook), page = canonical(o.url), base = canonical(profile.href);
  // No query-profile alias inference or arbitrary same-prefix ownership.
  if (!/^\/[A-Za-z0-9._-]+\/?$/.test(profile.pathname) || profile.pathname.replace(/\/$/, '') === '/profile.php') return false;
  return ['about', 'about_contact_and_basic_info', 'about_places', 'about_profile_transparency', 'about_details'].some(route => page === `${base}/${route}`) &&
    evidence.some(p => canonical(p.url) === base && c.inspectionIds.includes(p.id) && !p.blocked && fresh(p.inspectedAt) && p.text?.length >= 250 &&
      relevantSearchEvidence(`"${c.name}"`, [{ url: p.url, title: p.title, description: p.text }]) && (p.links || []).some(link => canonical(link.url) === page));
}
const redirector = host => host === 'l.facebook.com' || host === 'l.instagram.com';
const platformRoots = new Map([
  ['https://about.meta.com', 'meta'], ['https://www.meta.ai', 'meta ai'],
  ['https://www.threads.com', 'threads'], ['https://www.threads.net', 'threads'],
]);
function threadsNavigation(source,target,link){
  if(source.blocked||source.evidenceContextVersion!==1||source.method!=='fresh_guest_rendered_dom'||!fresh(source.inspectedAt))return false;
  const hosts=new Set(['threads.com','www.threads.com','threads.net','www.threads.net']);
  const tracking=u=>!u.search||[...u.searchParams.keys()].every(k=>k==='xmt')&&u.searchParams.getAll('xmt').length===1&&/^[A-Za-z0-9_-]{1,256}$/.test(u.searchParams.get('xmt'));
  let requested,committed;try{requested=publicUrl(source.url);committed=publicUrl(source.finalUrl||source.url);}catch{return false;}
  const route=u=>u.pathname.replace(/\/$/,'');
  if(!hosts.has(requested.hostname)||!hosts.has(committed.hostname)||!/^\/@[A-Za-z0-9._-]+$/.test(route(requested))||route(requested)!==route(committed)||requested.hostname.replace(/^www\./,'')!==committed.hostname.replace(/^www\./,'')||!tracking(requested)||!tracking(committed))return false;
  if(target.hostname===committed.hostname){
    const p=route(target);
    if(p===''&&!target.search&&['home','threads'].includes(String(link.text||'').trim().toLowerCase()))return true;
    if(p==='/search'&&!target.search)return true;
    if(p==='/login'&&(!target.search||[...target.searchParams.keys()].length===1&&target.searchParams.getAll('show_choice_screen').length===1&&target.searchParams.get('show_choice_screen')==='false'))return true;
    if(p==='/login'&&[...target.searchParams.keys()].length===2&&target.searchParams.getAll('interaction_source').length===1&&target.searchParams.getAll('show_choice_screen').length===1&&target.searchParams.get('show_choice_screen')==='false'&&
      [['FOLLOW','follow'],['OTHER','mention']].some(([kind,label])=>target.searchParams.get('interaction_source')===kind&&String(link.text||'').trim().toLowerCase()===label))return true;
    if(['','/replies','/media','/reposts'].some(suffix=>p===route(committed)+suffix)&&tracking(target))return true;
    if(p.startsWith(route(committed)+'/post/')&&/^\/post\/[A-Za-z0-9_-]{11}(?:\/media)?$/.test(p.slice(route(committed).length))&&tracking(target))return true;
  }
  // Only the actually observed standard legal wrapper, never arbitrary redirects.
  if(target.hostname!=='l.threads.com'||target.pathname!=='/'||String(link.text||'').trim().toLowerCase()!=='privacy policy'||![...target.searchParams.keys()].every(k=>['u','e'].includes(k))||target.searchParams.getAll('u').length!==1||target.searchParams.getAll('e').length>1)return false;
  if(target.searchParams.has('e')&&!/^[A-Za-z0-9_-]{1,1024}$/.test(target.searchParams.get('e')))return false;
  try{const legal=publicUrl(target.searchParams.get('u'));return ['www.facebook.com','facebook.com','m.facebook.com'].includes(legal.hostname)&&route(legal)==='/privacy/policy'&&!legal.search;}catch{return false;}
}
function platformNavigation(source, target, link) {
  // Exact public platform roots with their standard labels, not a host-wide
  // exemption. Profiles, wrappers, custom paths and query destinations still
  // need actual inspection. Unfamiliar footer links remain unresolved.
  return threadsNavigation(source,target,link)||/^(www\.|m\.)?(instagram|facebook)\.com$/.test(publicUrl(source.url).hostname) &&
    (source.evidenceContextVersion === 1 && source.method === 'fresh_guest_rendered_dom' && link.region === 'platform_footer' ||
      target.pathname === '/' && !target.search && platformRoots.get(target.origin) === String(link.text || '').trim().toLowerCase());
}
function wrapperTarget(value) {
  try {
    const u = publicUrl(value);
    if (!(u.hostname === 'l.facebook.com' && u.pathname === '/l.php' || u.hostname === 'l.instagram.com' && u.pathname === '/')) return null;
    const targets = u.searchParams.getAll('u');
    if (targets.length !== 1) return null;
    const target = publicUrl(targets[0]); // Decode once; never recursively unwrap.
    return redirector(target.hostname) ? null : target.href;
  } catch { return null; }
}
function socialTarget(value) {
  try {
    let u = publicUrl(value);
    if (redirector(u.hostname)) {
      const target = wrapperTarget(value); if (!target) return null;
      u = publicUrl(target);
    }
    return ['instagram.com', 'facebook.com'].includes(u.hostname.replace(/^(www|m)\./, '')) ? u.href : null;
  } catch { return null; }
}
export {socialTarget as observedSocialTarget};
function websiteMentionText(c, source) {
  const text=String(source.text||'');
  if(source.evidenceContextVersion!==1||source.method!=='fresh_guest_rendered_dom'||!socialProfile(source.url,'instagram')||
    !profileAnchors(c).includes(canonical(source.url))||source.finalUrl&&canonical(source.finalUrl)!==canonical(source.url))return text;
  const handle=publicUrl(source.url).pathname.split('/')[1].toLowerCase(),lines=text.split(/\r?\n/).map(line=>line.trim());
  const header=lines.findIndex((line,i)=>line.toLowerCase()===handle&&/^\d[\d,.]*\s*[kmb]? followers$/i.test(lines[i+1]||'')&&
    /^\d[\d,.]*\s*[kmb]? following$/i.test(lines[i+2]||'')&&lines.slice(0,i).every(v=>['','Log In','Sign Up'].includes(v)));
  if(header<0)return text;
  // Only the exact profile header and standard account UI sentences, never an
  // arbitrary mention in a bio. Actual hrefs are handled independently below.
  const ui=new Set([`show more posts from ${handle}`,`see photos, videos and more from ${handle}`,`sign up and never miss a post from ${handle}.`]);
  return lines.filter((line,i)=>i!==header&&!ui.has(line.toLowerCase())).join('\n');
}
// Enumerate possible website destinations, never fetch or treat a URL as proof.
// Keep platform attribution identical for intake and early acquisition screening.
export function potentialWebsiteTargets(c, source, bound, { includeText = false } = {}) {
  if(requiresPostEvidence(source.url)){source=postContent(c,source,bound);if(!source)return [{url:null,alias:null}];}
  const links = [...(source.links || [])], ambiguous = [];
  if (includeText) for (const raw of websiteMentionText(c,source).match(/(?:https:\/\/|www\.)[^\s<>"']+|(?<![\p{L}\p{N}._@-])(?:[\p{L}\p{N}-]+\.)+(?:[\p{L}]{2,63}|xn--[\p{L}\p{N}-]{2,59})(?:\/[^\s<>"']*)?(?![\p{L}\p{N}-])/giu) || []) {
    const value=raw.replace(/[).,;:!?]+$/, '');
    try { const url = publicUrl(/^https:/i.test(value) ? value : 'https://' + value).href;
      if (!links.some(link => canonical(link.url) === canonical(url))) links.push({url, text:''});
    } catch { ambiguous.push({url:null,alias:null}); /* Unsafe/ambiguous mention holds without exporting its raw value. */ }
  }
  const targets = new Map();
  for (const link of links) {
    let u; try { u = publicUrl(link.url); } catch {
      try { if (redirector(new URL(link.url).hostname)) targets.set(link.url, {url:null, alias:null}); } catch { /* Not a public destination. */ }
      continue;
    }
    const wrapped = redirector(u.hostname), target = wrapped ? wrapperTarget(link.url) : u.href;
    if (!target) { targets.set(u.href, {url:null, alias:u.href}); continue; }
    if (!wrapped && platformNavigation(source, u, link)) continue;
    if (!wrapped && /(^|\.)(instagram|facebook)\.com$/.test(u.hostname)) continue;
    if (wrapped && socialTarget(link.url) && verifiedProfile(c, target, bound)) continue;
    if(!targets.has(canonical(target)))targets.set(canonical(target), {url:target, alias:u.href});
  }
  return [...targets.values(),...ambiguous];
}
const fresh = value => Number.isFinite(Date.parse(value)) && Date.now() - Date.parse(value) <= 7 * 86400000 && Date.parse(value) <= Date.now() + 300000;
function identitySource(candidate, observation, bound) {
  if(requiresPostEvidence(observation.url))return Boolean(postContent(candidate,observation,bound));
  return firstParty(candidate, observation, bound) && observation.text?.length >= 250 &&
    relevantSearchEvidence(`"${candidate.name}"`, [{url:observation.url,title:observation.title,description:observation.text}]);
}
function postContent(c,o,bound){return attributedPostContent(o,bound.filter(p=>verifiedProfile(c,p.url,bound)));}
export function identityObservations(candidate, bound) { return bound.filter(o => identitySource(candidate, o, bound)).map(o=>requiresPostEvidence(o.url)?postContent(candidate,o,bound):o); }

// A single-business directory page is corroborating evidence, never first-party
// authorship or evidence that a website does not exist. Require an exact title
// and an observed account link or phone shared with a freshly inspected profile.
function listingHost(value) {
  try { return ['yelp.com','yellowpages.com','bbb.org','chamberofcommerce.com'].includes(publicUrl(value).hostname.replace(/^www\./,'')); }
  catch { return false; }
}
function listingRoute(value) {
  try {
    const u=publicUrl(value),h=u.hostname.replace(/^www\./,''),p=u.pathname.replace(/\/+$/,'');
    return !u.search && (h==='yelp.com' && /^\/biz\/[^/]+$/i.test(p) ||
      h==='yellowpages.com' && /^\/[^/]+\/mip\/[^/]+$/i.test(p) ||
      h==='bbb.org' && /^\/us\/[^/]+\/[^/]+\/profile\/[^/]+\/[^/]+$/i.test(p) ||
      h==='chamberofcommerce.com' && /^\/business-directory\/[^/]+\/[^/]+\/[^/]+\/[^/]+$/i.test(p));
  } catch { return false; }
}
function observedPhones(value) {
  return [...String(value||'').matchAll(/(?<!\d)(?:\+?1[\s.()-]*)?(?:\(\d{3}\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4}(?!\d)/g)].map(m=>m[0].replace(/\D/g,'').slice(-10));
}
const escaped = value => String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const houstonAddress = String.raw`\d{1,6}\s+[^,\n]{3,100},?\s+Houston\s*,?\s*(?:TX|Texas)\s+\d{5}(?:-\d{4})?`;
function listingBody(candidate,source) {
  const body=String(source.text||''),at=body.toLowerCase().indexOf(candidate.name.toLowerCase());
  return at<0?'':body.slice(at,at+1200);
}
export function listingObservations(candidate,bound,identity=identityObservations(candidate,bound)) {
  const profiles=identity.filter(o=>['instagram','facebook'].some(channel=>socialProfile(o.url,channel)) &&
    o.method==='fresh_guest_rendered_dom' && o.evidenceContextVersion===1 && (!o.finalUrl || canonical(o.url)===canonical(o.finalUrl)));
  if(!profiles.length)return [];
  const phones=new Set(profiles.flatMap(o=>observedPhones(o.text)));
  return bound.filter(o=>{
    if(!candidate.inspectionIds.includes(o.id)||o.blocked||!fresh(o.inspectedAt)||o.method!=='static_https_no_script'||
      !listingRoute(o.url)||!o.finalUrl||canonical(o.url)!==canonical(o.finalUrl))return false;
    const title=String(o.title||'').split(/\s+[-|–—]\s+|\s*:\s*/)[0];
    if(normalized(title)!==normalized(candidate.name))return false;
    const body=listingBody(candidate,o);if(!body)return false;
    // A phone anywhere in a flattened HTML page may belong to an advertisement.
    // Accept it only in the contiguous named-business/address/phone block.
    const namedPhone=new RegExp(`(?:^|\\s)${escaped(candidate.name)}\\s+(?:(?:Address|Location)\\s*:\\s*)?${houstonAddress}\\s+(?:Phone|Telephone)\\s*:?\\s*((?:\\+?1[\\s.()-]*)?(?:\\(\\d{3}\\)|\\d{3})[\\s.-]*\\d{3}[\\s.-]*\\d{4})(?!\\d)`,'i').exec(body);
    return Boolean(namedPhone&&observedPhones(namedPhone[1]).some(p=>phones.has(p))) || (o.links||[]).some(link=>profiles.some(p=>canonical(link.url)===canonical(p.url)));
  });
}
export function listingLocation(candidate,fact,listings) {
  if(fact.evidenceRef||typeof fact.excerpt!=='string'||!new RegExp(`^${houstonAddress}$`,'i').test(fact.excerpt.trim()))return false;
  const allowed=[fact.excerpt,`Address: ${fact.excerpt}`,`Located at ${fact.excerpt}`,`${candidate.name} is located at ${fact.excerpt}`];
  if(!allowed.some(text=>normalized(text)===normalized(fact.text)))return false;
  return listings.some(o=>{
    if(canonical(o.url)!==canonical(fact.sourceUrl)&&canonical(o.finalUrl)!==canonical(fact.sourceUrl))return false;
    const body=listingBody(candidate,o),heading=new RegExp(`(?:^|\\s)${escaped(candidate.name)}\\s+(?:(?:Address|Location)\\s*:\\s*)?$`,'i');
    let at=-1;while((at=body.indexOf(fact.excerpt,at+1))>=0){if(heading.test(body.slice(0,at)))return true;}
    return false;
  });
}
function listingWebsiteTargets(source) {
  const result=[];
  for(const link of source.links||[]) {
    try {
      const u=publicUrl(link.url),sourceHost=publicUrl(source.url).hostname.replace(/^www\./,''),host=u.hostname.replace(/^www\./,'');
      const labelled=/\b(?:website|web\s+site|visit\s+site)\b/i.test(String(link.text||''));
      const sameSite=host===sourceHost||host.endsWith('.'+sourceHost);
      const social=/(^|\.)(instagram|facebook)\.com$/.test(host);
      // Directory-wide outside links may be unrelated ads. Hold/classify them,
      // rather than silently treating an unlabeled business destination as absent.
      if(labelled||host==='yelp.com'&&u.pathname==='/biz_redir'||!sameSite&&!social)result.push({url:u.href,alias:u.href});
    } catch { result.push({url:null,alias:null}); }
  }
  return result;
}
// Assisted route classification establishes only a published third-party presence,
// never readable page content, first-party authorship or absence of a custom site.
export function assistedPresenceTarget(target, observations, linkChecks) {
  if (!target.url) return false;
  let u; try { u=publicUrl(target.url); } catch { return false; }
  const host=u.hostname.replace(/^www\./,''),route=u.pathname.replace(/\/$/,'');
  const shareTracking=[...u.searchParams].every(([k,v])=>['_r','_t'].includes(k)&&u.searchParams.getAll(k).length===1&&/^[A-Za-z0-9._-]{1,100}$/.test(v));
  const tiktok=host==='tiktok.com' && /^\/@[A-Za-z0-9._-]{1,64}$/.test(route) && shareTracking;
  const googleBusinessRoute=value=>{
    const h=value.hostname.replace(/^www\./,'');
    if([...value.searchParams].some(([k,v])=>/^(url|u|redirect|redirect_uri|dest|destination)$/i.test(k)||/(?:https?:|\/\/)/i.test(v)))return false;
    if(h==='maps.google.com'&&value.pathname==='/')return true;
    if(h!=='google.com')return false;
    if(/^\/maps(?:\/|$)/.test(value.pathname))return true;
    if(value.pathname!=='/search'||value.searchParams.getAll('kgmid').length!==1||!/^\/g\/[A-Za-z0-9_]{1,100}$/.test(value.searchParams.get('kgmid')))return false;
    return [...value.searchParams].every(([k,v])=>['kgmid','q','hl','authuser','sca_esv','shem','shndl','source','kgs','utm_source','sei'].includes(k)&&value.searchParams.getAll(k).length===1&&v.length<=300&&!/(?:https?:|\/\/|\\)/i.test(v));
  };
  const googleQuery=[...u.searchParams].every(([key,value])=>['cid','q','ftid','hl','g_ep','entry','review','place_id','api','query','query_place_id'].includes(key)&&!/(?:https?:|\/\/)/i.test(value));
  const reviews=host==='google.com' && /^\/maps(?:\/|$)/.test(u.pathname) || host==='maps.google.com' && u.pathname==='/' ||
    host==='g.page' && /^\/r\/[A-Za-z0-9_-]+\/review\/?$/.test(u.pathname) || host==='maps.app.goo.gl' && /^\/[A-Za-z0-9]+\/?$/.test(u.pathname) || host==='share.google'&&/^\/[A-Za-z0-9]{6,64}$/.test(u.pathname)&&!u.search;
  if(!tiktok&&!(reviews&&googleQuery))return false;
  return linkChecks.some(f=>canonical(f.url)===canonical(target.url)&&f.status==='unofficial'&&observations.some(o=>
    o.id===f.sourceId&&o.method==='assisted_external_guest_dom'&&o.sourceKind==='external_observation'&&fresh(o.inspectedAt)&&canonical(o.url)===canonical(target.url)&&
    (()=>{
      try {
        const final=publicUrl(o.finalUrl||o.url),h=final.hostname.replace(/^www\./,'');
        if(tiktok)return canonical(final.href)===canonical(target.url);
        if(!['google.com','maps.google.com'].includes(h)||!(googleBusinessRoute(final)||final.pathname==='/'||/^\/sorry\//.test(final.pathname)))return false;
        if([...final.searchParams.keys()].some(k=>/^(url|u|redirect|redirect_uri|dest|destination)$/i.test(k)))return false;
        const continuations=final.searchParams.getAll('continue');
        if(continuations.length>1)return false;
        if(continuations.length&&!googleBusinessRoute(publicUrl(continuations[0])))return false;
        return true;
      }catch{return false;}
    })()));
}
export function candidateDestinations(candidate,observations,bound,identity,listings,policy={}) {
  const listingIds=new Set(listings.map(o=>o.id));
  return assessDestinations({roots:[...identity,...listings],observations,linkChecks:candidate.websiteCheck.linkChecks,
    targetsForSource:o=>(listingIds.has(o.id)?listingWebsiteTargets(o):potentialWebsiteTargets(candidate,o,bound,{includeText:true})).filter(target=>
      policy.segment!=='booking_social_no_independent_marketing_site'||!assistedPresenceTarget(target,observations,candidate.websiteCheck.linkChecks||[]))});
}

export function supportedFact(candidate, fact, bound) {
  if (!fact.excerpt) return false;
  return bound.map(o=>requiresPostEvidence(o.url)?postContent(candidate,o,bound):o).filter(Boolean).some(o => [canonical(o.url), canonical(o.finalUrl)].includes(canonical(fact.sourceUrl)) &&
    (fact.evidenceRef ? identitySource(candidate, o, bound) && observedImageText(fact.evidenceRef, o)?.includes(fact.excerpt) : o.text?.includes(fact.excerpt)));
}
export function supportedActivity(c,identity){
  const activity=c.activityEvidence,observed=activity&&identity.find(o=>o.id===activity.sourceId),source=observed&&requiresPostEvidence(observed.url)?postContent(c,observed,identity):observed;
  const value=source&&(activity.evidenceRef?observedImageText(activity.evidenceRef,source):source.text);
  return Boolean(source&&activity.excerpt&&value?.includes(activity.excerpt)&&activity.excerpt.includes(activity.dateText)&&observedDate(activity.dateText)&&observedDate(activity.dateText)===activity.date&&Date.now()-Date.parse(activity.date)<=180*86400000&&Date.parse(activity.date)<=Date.now()+300000);
}

// Bind model interpretations to actual host observations. These checks establish
// evidence coverage, not owner confirmation, documentary authenticity or taste.
export function assessIntake(c, { observations = [], searches = [], imageViews = [] } = {}, policy = {}) {
  const reasons = [], contacts = [], assessment = assessEvidence(c);
  if (assessment.state !== 'qualified') reasons.push(assessment.reason);
  const bound = observations.filter(o => c.inspectionIds.includes(o.id) && !o.blocked && fresh(o.inspectedAt));
  const identity = identityObservations(c, bound),listings=listingObservations(c,bound,identity);
  const content=bound.map(o=>requiresPostEvidence(o.url)?postContent(c,o,bound):o).filter(Boolean);
  if (!identity.length) reasons.push('No fresh identity-matched first-party page is bound to this candidate.');
  if (!/\bhouston\b/.test(normalized(c.area)) || !c.facts.some(f => /\bhouston\b/.test(normalized(f.text)) && /\bhouston\b/.test(normalized(f.excerpt)) && (identity.some(o => canonical(o.url) === canonical(f.sourceUrl) && o.text.includes(f.excerpt))||listingLocation(c,f,listings)))) reasons.push('Houston location/service-area evidence needs an inspected first-party source or an identity-matched directory street address. Do not broaden geography to fill the batch.');
  const queries = [...new Set(c.websiteCheck.queries.map(normalized))];
  if (queries.length < 2 || !queries.every(query => searches.some(s => s.status === 'completed' && s.intent === 'verify' && normalized(s.query) === query && fresh(s.at) && relevantSearchEvidence(`"${c.name}"`, s.results || [])))) reasons.push('Two distinct actual exact-business website searches with relevant results are required; snippets alone do not establish absence.');
  // Preserve existing bound-source matching for other source types. Known
  // directory hosts, however, may supply facts only after the listing join.
  const factSources=bound.filter(o=>!listingHost(o.url));
  if (c.facts.length < 3 || c.facts.some(f => !supportedFact(c, f, factSources)&&!listingLocation(c,f,listings))) reasons.push('At least three useful facts with excerpts from actually inspected sources are required.');
  const purposes = c.pagePurposes || [];
  if (purposes.length !== 5 || new Set(purposes.map(p => normalized(p.purpose))).size !== 5 || purposes.some(p => !p.factIds.length || p.factIds.some(id => !c.facts.some(f => f.id === id)))) reasons.push('Five distinct useful page purposes must bind actual fact IDs; no filler page plan.');
  if (!supportedActivity(c,identity)) reasons.push('Recent activity needs a dated excerpt on an inspected first-party page, not a boolean assertion.');
  // Supplied proof is an assertion even when its channel has no published value.
  // Validate every entry, not only the four routable contact channels below.
  for (const [channel, proof] of Object.entries(c.contactSourceEvidence || {})) {
    const sourceUrl = c.contactSources?.[channel];
    const source = content.find(o => o.id === proof.inspectionId && canonical(o.url) === canonical(sourceUrl));
    const supported = source && identitySource(c, source, bound) && canonical(proof.sourceUrl) === canonical(sourceUrl) &&
      typeof proof.excerpt === 'string' && proof.excerpt.length > 0 && source.text?.includes(proof.excerpt);
    const address = c.contacts.address;
    const addressSupported = channel !== 'address' || !address || typeof source?.text === 'string' &&
      source.text.replace(/\s+/g, ' ').includes(address.replace(/\s+/g, ' '));
    if (!supported || !addressSupported) reasons.push(`The supplied ${channel} contact proof does not have matching actual first-party evidence.`);
  }
  for (const [channel, value] of Object.entries(c.contacts).filter(([k]) => ['email', 'phone', 'instagram', 'facebook'].includes(k))) {
    const sourceUrl = c.contactSources?.[channel], proof = c.contactSourceEvidence?.[channel];
    const source = content.find(o => canonical(o.url) === canonical(sourceUrl) && (!proof || o.id === proof.inspectionId));
    let supported = Boolean(source && identitySource(c, source, bound) && (!proof ||
      canonical(proof.sourceUrl) === canonical(sourceUrl) && typeof proof.excerpt === 'string' && proof.excerpt.length > 0 && source.text?.includes(proof.excerpt)));
    if (channel === 'phone') supported &&= String(value).replace(/\D/g, '').length >= 10 && String(source?.text).replace(/\D/g, '').includes(String(value).replace(/\D/g, ''));
    else if (channel === 'email') supported &&= /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) && String(source?.text).toLowerCase().includes(value.toLowerCase());
    else supported &&= socialProfile(value, channel) && (canonical(value) === canonical(source?.url) ||
      verifiedProfile(c, value, bound) && (source.links || []).some(link => canonical(socialTarget(link.url)) === canonical(value)));
    if (!supported) reasons.push(`The published ${channel} contact does not have matching actual first-party evidence.`);
    else contacts.push({ channel, value, sourceUrl, observedAt: source.inspectedAt, authority: 'public_business_route_not_contact_permission' });
  }
  if (!contacts.length) reasons.push('A sourced public business contact route is required; never guess an email or owner.');
  if (!c.media.length) reasons.push('Useful observed business-posted photography is missing.');
  for (const m of c.media) {
    const o = bound.find(o => o.id === m.sourceId);
    try {
      validateMediaSelection(c, m, o);
      if (canonical(m.postUrl) === canonical(m.account) || ![o.url, ...(o.links || []).map(l => l.url)].some(u => canonical(u) === canonical(m.postUrl))) throw new Error('Unobserved permalink');
      if (!imageViews.some(v => v.sourceId === m.sourceId && v.imageId === m.imageId && fresh(v.at) && /^[a-f0-9]{64}$/.test(v.pixelsSha256))) throw new Error('Unviewed pixels');
    } catch { reasons.push('Selected photography needs matching source/image IDs, an observed stable post link and an actual image-view receipt.'); }
  }
  const destinations=candidateDestinations(c,observations,bound,identity,listings,policy);
  const assistedBooking=policy.segment==='booking_social_no_independent_marketing_site'&&destinations.status==='booking_only'&&!destinations.unresolved.length;
  if(destinations.status!=='clear'&&!assistedBooking)reasons.push(destinations.status==='official'?'A possible outbound official site was inspected and is a functioning website; this no-site prospect is excluded.':destinations.status==='booking_only'&&!destinations.unresolved.length?'An inspected booking destination is separately unsupported.':'A possible outbound official/builder/booking site remains uninspected or unresolved.');
  return { ready: reasons.length === 0, reasons: [...new Set(reasons)], contacts, evidenceDigest: hash(c), humanDecision: null,
    limitations: ['Identity/activity/content are model interpretations anchored to actual observations, not owner confirmation', 'No universal proof of website absence or public image licence'] };
}
