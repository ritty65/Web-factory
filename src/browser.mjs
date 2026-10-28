import { mkdir, writeFile, readdir, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { publicUrl, hash, now, fail, FactoryError } from './contracts.mjs';
import { runProcess } from './process.mjs';
import { resolvePublic, safeFetch } from './network.mjs';
import { noLinks } from './db.mjs';
import { stablePostUrl } from './evidence-context.mjs';
import {postEvidenceScript,normalizePostEvidence,requiresPostEvidence,postCaptionContent,instagramResource,postFormatDiagnosticsScript,normalizePostFormatDiagnostics} from './post-evidence.mjs';

const extraction = diagnostics => `JSON.stringify((()=>{
  const pageHost=new URL(location.href).hostname;
  const platform=pageHost.startsWith('www.')?pageHost.slice(4):pageHost.startsWith('m.')?pageHost.slice(2):pageHost;
  const legal=(node,kind)=>{
    try {
      const u=new URL(node.href),route=u.pathname.endsWith('/')?u.pathname.slice(0,-1):u.pathname;
      if(u.username||u.password||u.search)return false;
      if(platform==='instagram.com'&&['https://instagram.com','https://www.instagram.com','https://m.instagram.com'].includes(u.origin))return route===(kind==='privacy'?'/legal/privacy':'/legal/terms');
      if(platform==='facebook.com'&&['https://facebook.com','https://www.facebook.com','https://m.facebook.com'].includes(u.origin))return (kind==='privacy'?['/privacy/policy','/privacy/explanation']:['/legal/terms','/terms.php']).includes(route);
      return false;
    } catch {return false;}
  };
  return {title:document.title,finalUrl:location.href,postEvidence:${postEvidenceScript},${diagnostics?`postFormatDiagnostics:${postFormatDiagnosticsScript},`:''}text:document.body.innerText.slice(0,20000),links:Array.from(document.querySelectorAll('a[href]')).map(a=>{
    const footer=a.closest('footer'),anchors=footer&&!a.closest('article')?Array.from(footer.querySelectorAll('a[href]')):[];
    const platformFooter=anchors.some(n=>legal(n,'privacy'))&&anchors.some(n=>legal(n,'terms'));
    return {text:a.innerText.slice(0,120),url:a.href,...(platformFooter?{region:'platform_footer'}:{})};
  }).filter(a=>a.url.startsWith('https:')).slice(0,160),images:Array.from(document.images).filter(i=>i.naturalWidth>=300&&i.naturalHeight>=200).slice(0,35).map(i=>({mediaUrl:i.currentSrc||i.src,alt:i.alt.slice(0,300),width:i.naturalWidth,height:i.naturalHeight,postUrl:i.closest('a[href]')?.href||null}))};
})())`;
const searchExtraction = `JSON.stringify({title:document.title,finalUrl:location.href,searchQuery:document.querySelector('#sb_form_q')?.value??null,text:(document.querySelector('#b_results')?.textContent||document.body.innerText).slice(0,18000),links:[],images:[],searchResults:Array.from(document.querySelectorAll('#b_results .b_algo')).slice(0,8).map(e=>({title:e.querySelector('h2 a')?.textContent||'',url:e.querySelector('h2 a')?.href||'',description:e.querySelector('.b_caption p')?.textContent||''}))})`;
export const imageReadyScript = `Promise.race([Promise.all(Array.from(document.images).filter(i=>{const r=i.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight}).map(i=>i.decode().catch(()=>{}))),new Promise(resolve=>setTimeout(resolve,2000))]).then(()=>true)`;
const REFERENCE_HOSTS = new Set(['grupodigma.com','www.grupodigma.com','shroomtopia.shop','www.shroomtopia.shop','simulacraproductions.net','www.simulacraproductions.net','danzicastudio.com','www.danzicastudio.com','titosdetailinghtx.com','www.titosdetailinghtx.com','intownconstructions.com','www.intownconstructions.com','rollou.com','www.rollou.com']);
const LINKED_HOSTS=new Map();
for(const h of ['linktr.ee','beacons.ai','bio.site','lnk.bio','campsite.bio','hoo.be'])for(const name of [h,'www.'+h])LINKED_HOSTS.set(name,[h,'www.'+h]);
const threads=['threads.net','www.threads.net','threads.com','www.threads.com'];for(const h of threads)LINKED_HOSTS.set(h,threads);
export function sourceMode(value,{linked=false}={}) { const url = publicUrl(value); return linked&&LINKED_HOSTS.has(url.hostname)||/(^|\.)(instagram\.com|facebook\.com)$/.test(url.hostname) || REFERENCE_HOSTS.has(url.hostname) || url.hostname === 'www.bing.com' ? 'guest_browser' : 'static_https_no_script'; }
function plainHtml(html) { return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, m => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[m]).replace(/\s+/g, ' ').trim(); }
function cliResult(raw) {
  const parsed = JSON.parse(raw);
  if (parsed.success === false) {
    const error = new FactoryError('BROWSER_FAILED', 'Guest browser operation failed');
    // Memory only; never serialize raw executable/target text into a receipt.
    error.privateDiagnostics = { stderr: typeof parsed.error === 'string' ? parsed.error.slice(0, 10000) : '' };
    throw error;
  }
  return parsed.data?.result ?? parsed.data ?? parsed;
}
function failureCategory(error) {
  if (error.code === 'DEADLINE') return 'timeout';
  if (error.code === 'CANCELLED') return 'cancelled';
  if (error.code === 'OUTPUT_LIMIT') return 'output_limit';
  if (error.code === 'PROCESS_START') return 'executable_unavailable';
  if (error instanceof SyntaxError || error.code === 'BROWSER_DATA') return 'malformed_response';
  let raw = typeof error.privateDiagnostics?.stderr === 'string' ? error.privateDiagnostics.stderr.slice(0, 10000) : '';
  try {
    // Some CLI failures are JSON on stdout even when the process exits nonzero.
    const output = error.privateDiagnostics?.stdout;
    const parsed = typeof output === 'string' && output.length <= 400000 ? JSON.parse(output) : null;
    if (parsed?.success === false && typeof parsed.error === 'string') raw += '\n' + parsed.error.slice(0, 10000);
  } catch { /* Unstructured stdout is never copied into a diagnostic receipt. */ }
  if (/ERR_NAME_NOT_RESOLVED|EAI_AGAIN|ENOTFOUND/.test(raw)) return 'dns_failure';
  if (/ERR_(?:CONNECTION_)?TIMED_OUT|TimeoutError|Navigation timeout/i.test(raw)) return 'timeout';
  if (/Target (?:page, context or browser|closed)|browser has been closed/i.test(raw)) return 'browser_closed';
  if (/ERR_BLOCKED_BY_CLIENT|ERR_ACCESS_DENIED|403 Forbidden/i.test(raw)) return 'access_restricted';
  return 'process_failed';
}
function searchMetadata(requested, data) {
  let finalUrl = null, searchQuery = null;
  const query = publicUrl(requested).searchParams.get('q');
  try {
    const final = publicUrl(data.finalUrl);
    if (final.origin === 'https://www.bing.com' && final.pathname === '/search' && final.searchParams.getAll('q').length === 1 && final.searchParams.get('q') === query) {
      // Keep only the validated public query, not arbitrary redirect parameters.
      finalUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    }
  } catch { /* Missing/unsafe committed location is unresolved evidence. */ }
  if (typeof query === 'string' && typeof data.searchQuery === 'string' && data.searchQuery.length <= 600 && data.searchQuery.trim() === query.trim()) searchQuery = data.searchQuery;
  return { finalUrl, searchQuery, searchMismatch: !finalUrl || searchQuery === null };
}
export async function inspectSource(urlValue, { directory, signal, capture = false, relatedUrls = [],linked=false,postFormatDiagnostics=false } = {}) {
  const url = publicUrl(urlValue);if(postFormatDiagnostics&&!instagramResource(url.href,'post'))fail('SOURCE_DIAGNOSTIC','Private format diagnostics require a supported Instagram post URL.');
  await resolvePublic(url); await noLinks(directory); await mkdir(directory, { recursive: true, mode: 0o700 });
  if (sourceMode(url.href,{linked}) === 'static_https_no_script') {
    // Unknown agent-supplied domains use pinned HTTPS only: no target JS, browser
    // DNS rebinding, private-network subresources or privileged browser profile.
    const response = await safeFetch(url.href, { signal, maxBytes: 1024 * 1024 });
    const html = response.bytes.toString('utf8'), body = plainHtml(html).slice(0, 20000);
    const record = { id: `source-${hash(url.href + now()).slice(0, 20)}`, url: url.href, finalUrl: response.url, title: plainHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url.hostname).slice(0, 300), text: body, inspectedAt: now(), blocked: response.status !== 200 || body.length < 80, method: 'static_https_no_script', links: [], images: [], captures: [], httpStatus: response.status, limitations: 'Unknown sites are fetched as bounded public HTML without scripts. JS-only/login pages are unresolved, never absence evidence.' };
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) { if (record.links.length >= 120) break; try { const link = publicUrl(new URL((m[1] || m[2]).replace(/&amp;/g, '&'), response.url).href); record.links.push({ url: link.href, text: plainHtml(m[3]).slice(0, 120) }); } catch { /* unsafe/non-web URL */ } }
    await writeFile(path.join(directory, record.id + '.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 }); return record;
  }
  const session = `factory-source-${hash(url.href + now()).slice(0, 16)}`;
  const sourceId = `source-${hash(session).slice(0, 20)}`;
  const social = /(^|\.)(instagram\.com|facebook\.com)$/.test(url.hostname);
  const linkedHosts=linked?LINKED_HOSTS.get(url.hostname):null;
  let redirectDomain = '';
  if(!linkedHosts)for (const value of relatedUrls.slice(0, 3)) { const related = publicUrl(value); await resolvePublic(related); redirectDomain += `,${related.hostname}`; }
  if (!social&&!linkedHosts) { try { const response = await safeFetch(url.href, { signal, maxBytes: 1024 * 1024, timeout: 12000 }); const final = publicUrl(response.url); if (final.hostname !== url.hostname && REFERENCE_HOSTS.has(final.hostname)) redirectDomain += `,${final.hostname}`; } catch { /* Browser may still render; a fetch failure is not absence evidence. */ } }
  // Installed agent-browser core contract: allowed-domains constrains navigation,
  // subresources, worker traffic and WebRTC before scripts run. Browser-level only,
  // never an OS firewall. Fixed platforms are opt-in; arbitrary sites stay pinned.
  const domains = linkedHosts ? linkedHosts.join(',')+(threads.includes(url.hostname)?',*.fbcdn.net,*.cdninstagram.com':'') : social ? 'instagram.com,*.instagram.com,facebook.com,*.facebook.com,*.fbcdn.net,*.cdninstagram.com' : `${url.hostname},*.${url.hostname.replace(/^www\./, '')},fonts.googleapis.com,fonts.gstatic.com${redirectDomain}`;
  const base = ['--session', session, '--executable-path', process.env.FACTORY_BROWSER_EXECUTABLE || '/usr/bin/chromium', '--allowed-domains', domains, '--json'];
  const run = async args => (await runProcess('agent-browser', [...base, ...args], { signal, timeout: 40000, maxBytes: 400000 })).stdout;
  let data, stage = 'open';
  try {
    cliResult(await run(['open', url.href]));
    const isSearch = url.hostname === 'www.bing.com' && url.pathname === '/search';
    if (isSearch) { stage = 'wait'; cliResult(await run(['wait', '--fn', "document.querySelectorAll('#b_results .b_algo').length>0"])); }
    stage = 'extract';
    const result = cliResult(await run(['eval', isSearch ? searchExtraction : extraction(postFormatDiagnostics)])); data = typeof result === 'string' ? JSON.parse(result) : result;
    if (!data || typeof data.text !== 'string') fail('BROWSER_DATA', 'Guest browser did not return usable public page evidence');
    let committed;try{if(!isSearch&&data.finalUrl)committed=publicUrl(data.finalUrl);}catch{fail('BROWSER_DATA','Guest reader committed URL is not a safe public URL.');}
    if(linkedHosts&&(!committed||!linkedHosts.includes(committed.hostname)))fail('BROWSER_DATA','Linked guest reader left its fixed platform boundary; source remains unresolved.');
    const text = data.text,postContext=data.postEvidence,formatContext=data.postFormatDiagnostics;
    const metadata = isSearch ? searchMetadata(url.href, data) : {};
    const blocked = Boolean(metadata.searchMismatch) || /(?:unusual traffic|verify (?:you are|you're) human|complete the security check|log in to continue|you must log in|this content isn.t available|content not available|page isn.t available|sorry, this page isn.t available)/i.test(text) && text.length < 1800;
    data = { id: sourceId, url: url.href,...(!isSearch&&committed?{finalUrl:committed.href}:{}), title: String(data.title).slice(0, 300), text, inspectedAt: now(), blocked, method: isSearch ? 'fresh_guest_search_dom_text' : 'fresh_guest_rendered_dom', ...(!isSearch ? { evidenceContextVersion: 1 } : {}), ...(isSearch ? { ...metadata, searchResults: data.searchResults || [], ...(metadata.searchMismatch ? { limitations: 'BROWSER_SEARCH_MISMATCH: committed search location or rendered query is missing or mismatched; source unknown, never absence evidence.' } : {}) } : {}), links: (data.links || []).filter(v => { try { publicUrl(v.url); return true; } catch { return false; } }), images: (data.images || []).slice(0, 35).map((img, i) => ({ id: `image-${hash(sourceId + i).slice(0, 20)}`, mediaUrl: img.mediaUrl, alt: String(img.alt || '').slice(0, 300), width: img.width, height: img.height, ...(stablePostUrl(img.postUrl, url.href) ? { postUrl: stablePostUrl(img.postUrl, url.href) } : {}) })), captures: [] };
    Object.assign(data,normalizePostEvidence(data,postContext));
    if(postFormatDiagnostics)data.postFormatDiagnostics=normalizePostFormatDiagnostics(formatContext);
    if (capture) {
      stage = 'capture';
      for (const [label, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
        await run(['set', 'viewport', String(width), String(height)]);
        await run(['eval', imageReadyScript]);
        const name = `${sourceId}-${label}.png`; await run(['screenshot', path.join(directory, name)]); data.captures.push({ relative: name, viewport: [width, height] });
      }
    }
  } catch (error) {
    const code = ['PROCESS_FAILED', 'PROCESS_START', 'DEADLINE', 'CANCELLED', 'OUTPUT_LIMIT', 'BROWSER_FAILED', 'BROWSER_DATA'].includes(error.code) ? error.code : 'SOURCE_FAILED';
    const diagnostic = { id: `source-failure-${hash(session).slice(0, 20)}`, status: 'failed', at: now(), url: url.href, code, stage, category: failureCategory(error),
      ...(Number.isInteger(error.details?.exitCode) && Math.abs(error.details.exitCode) <= 255 ? { exitCode: error.details.exitCode } : {}) };
    try {
      await writeFile(path.join(directory, `${diagnostic.id}.json`), JSON.stringify(diagnostic), { flag: 'wx', mode: 0o600 });
      error.sourceFailure = { id: diagnostic.id, code, stage, category: diagnostic.category };
    } catch { /* Preserve original failure; do not claim a receipt was retained. */ }
    throw error;
  } finally { try { await runProcess('agent-browser', ['--session', session, 'close'], { timeout: 15000, maxBytes: 4000 }); } catch { /* only this task-owned guest session */ } }
  await writeFile(path.join(directory, `${sourceId}.json`), JSON.stringify(data), { flag: 'wx', mode: 0o600 });
  return data;
}
export function publicObservation(observation) {
  let finalUrl;try{if(observation.finalUrl&&observation.method!=='fresh_guest_search_dom_text')finalUrl=publicUrl(observation.finalUrl).href;}catch{/* Unsafe final metadata is omitted, never exported or used as proof. */}
  const postContext=normalizePostEvidence(observation,observation.postEvidenceVersion===1&&!observation.postEvidenceIssue?observation.postEvidence:{issue:observation.postEvidenceIssue||'missing_context'});
  if(requiresPostEvidence(observation.url))observation={...observation,...(postContext.postEvidence?postCaptionContent(observation,postContext.postEvidence):{text:'',links:[],images:[]}),title:postContext.postEvidence?'Instagram authored-caption observation':'Instagram post evidence unknown',captures:[]};
  return { id: observation.id, url: observation.url,...(finalUrl?{finalUrl}:{}), title: observation.title, text: observation.text, inspectedAt: observation.inspectedAt, blocked: observation.blocked, method: observation.method, ...(observation.evidenceContextVersion === 1 ? { evidenceContextVersion: 1 } : {}),...postContext, ...(observation.method === 'fresh_guest_search_dom_text' ? { ...searchMetadata(observation.url, observation), ...(observation.limitations ? { limitations: observation.limitations } : {}) } : {}), links: observation.links, images: observation.images.map(({ id, alt, width, height, postUrl }) => ({ id, alt, width, height, ...(stablePostUrl(postUrl, observation.url) ? { postUrl: stablePostUrl(postUrl, observation.url) } : {}) })), captures: observation.captures };
}
export async function readObservations(directory) {
  await noLinks(directory);
  let files; try { files = await readdir(directory); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const observations = [];
  for (const name of files.filter(v => /^source-[a-f0-9]+\.json$/.test(v)).slice(0, 60)) { const target = path.join(directory, name); await noLinks(target); const bytes = await readFile(target); if (bytes.length > 500000) fail('SOURCE_LIMIT', 'Source observation too large'); observations.push(JSON.parse(bytes)); }
  return observations;
}
