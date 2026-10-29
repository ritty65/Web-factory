import {publicUrl,publicResourceKey} from './contracts.mjs';
import {freshEvidence} from './destinations.mjs';

// Self-contained so exactly the same route grammar runs in the fixed DOM script.
// The optional account prefix is a constraint, never authorship evidence.
export function instagramResource(value,kind){
  try{
    if(typeof value!=='string'||value.length>1200||/[\s\\]/.test(value))return null;
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!['instagram.com','www.instagram.com','m.instagram.com'].includes(u.hostname))return null;
    const route=u.pathname.replace(/\/$/,''),post=route.match(/^\/(?:([A-Za-z0-9._-]+)\/)?(p|reel)\/([A-Za-z0-9_-]+)$/);
    if(post&&kind!=='profile')return {kind:'post',key:`instagram.com/${post[2]}/${post[3]}`,account:post[1]?.toLowerCase()||null,url:`https://www.instagram.com/${post[1]?post[1].toLowerCase()+'/':''}${post[2]}/${post[3]}/`};
    const profile=route.match(/^\/([A-Za-z0-9._-]+)$/),reserved=/^(about|accounts|business|explore|groups|help|legal|login|p|photo|photos|policies|privacy|reel|reels|search|share|stories)$/i;
    if(profile&&!reserved.test(profile[1])&&kind!=='post')return {kind:'profile',key:`instagram.com/${profile[1].toLowerCase()}`,account:profile[1].toLowerCase(),url:`https://www.instagram.com/${profile[1].toLowerCase()}/`};
  }catch{/* Unsupported public resource: no alias or author inference. */}
  return null;
}
export function requiresPostEvidence(value){
  // Unsupported/encoded routes must never fall back to media-based authorship.
  // Ordinary profile paths keep their existing rules, including tracked URLs.
  try{const u=new URL(value);return (u.hostname==='instagram.com'||u.hostname.endsWith('.instagram.com'))&&!instagramResource(u.origin+u.pathname,'profile');}catch{return false;}
}

export function extractPostEvidence(parse){
  const current=parse(location.href,'post');if(!current)return null;
  const issue=issue=>({issue});
  const visible=node=>{
    if(!node||!node.getClientRects().length)return false;
    for(let n=node;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(n.hidden||n.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0||s.contentVisibility==='hidden')return false;}
    return true;
  };
  const canonicals=Array.from(document.querySelectorAll('link[rel~="canonical"]'));
  const canonical=canonicals.length===1&&parse(canonicals[0].href,'post');
  if(!canonical||canonical.key!==current.key)return issue('canonical_mismatch');
  const articles=Array.from(document.querySelectorAll('article')).filter(visible);
  if(articles.length!==1)return issue('ambiguous_article');
  const article=articles[0],headings=Array.from(article.querySelectorAll('h1')).filter(visible);
  if(headings.length!==1)return issue('ambiguous_caption');
  const heading=headings[0],row=heading.closest('li')||heading.parentElement;
  if(!row||row===article||row.querySelectorAll('li').length)return issue('ambiguous_caption');
  const authors=Array.from(row.querySelectorAll('a[href]')).filter(a=>!heading.contains(a)&&visible(a)).map(a=>({node:a,profile:parse(a.href,'profile')})).filter(v=>v.profile);
  if(new Set(authors.map(v=>v.profile.key)).size!==1||!authors.some(v=>v.node.innerText.trim().replace(/^@/,'').toLowerCase()===v.profile.account))return issue('ambiguous_author');
  const author=authors[0].profile;
  if([current,canonical].some(v=>v.account&&v.account!==author.account))return issue('author_mismatch');
  const headers=Array.from(article.querySelectorAll('header a[href]')).filter(visible).map(a=>parse(a.href,'profile')).filter(Boolean);
  if(headers.some(p=>p.key!==author.key))return issue('author_mismatch');
  const times=Array.from(article.querySelectorAll('time[datetime]')).filter(visible);
  const absoluteDate=d=>{
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(d)||!Number.isFinite(Date.parse(d)))return false;
    const calendar=new Date(d.slice(0,10)+'T00:00:00.000Z');return Number.isFinite(+calendar)&&calendar.toISOString().slice(0,10)===d.slice(0,10);
  };
  if(!times.length||times.some(n=>{const p=parse(n.closest('a[href]')?.href,'post');return !p||p.key!==current.key||p.account&&p.account!==author.account||!absoluteDate(n.getAttribute('datetime'));}))return issue('permalink_mismatch');
  if(new Set(times.map(n=>n.getAttribute('datetime'))).size!==1)return issue('permalink_mismatch');
  const caption=heading.innerText.trim();if(!caption||caption.length>10000)return issue('invalid_caption');
  const links=Array.from(heading.querySelectorAll('a[href]')).filter(visible).map(a=>({url:a.href,text:a.innerText.slice(0,120)}));
  if(links.length>40)return issue('invalid_caption');
  return {proof:'instagram_article_caption_v1',postUrl:current.url,canonicalUrl:canonical.url,authorUrl:author.url,caption,links};
}
export const postEvidenceScript=`(${extractPostEvidence.toString()})(${instagramResource.toString()})`;

// Opt-in operator diagnostics only. This is a bounded structural map, not
// attribution evidence: no page text, raw URLs, image URLs or HTML are emitted.
export function extractPostFormatDiagnostics(parse){
  const current=parse(location.href,'post'),visible=node=>{
    if(!node||!node.getClientRects().length)return false;
    for(let n=node;n&&n.nodeType===1;n=n.parentElement){const s=getComputedStyle(n);if(n.hidden||n.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0||s.contentVisibility==='hidden')return false;}
    return true;
  };
  const limit=n=>Math.min(n,10000),known=new Set(['html','body','main','article','section','div','span','ul','ol','li','header','footer','a','h1','h2','h3','h4','h5','h6','time','p','nav','aside','button']);
  const nodePath=node=>{
    const path=[];let n=node;
    while(n&&n.nodeType===1&&path.length<48){const tag=n.tagName.toLowerCase(),index=n.parentElement?Array.prototype.indexOf.call(n.parentElement.children,n):0;path.unshift(`${known.has(tag)?tag:'other'}:${Math.min(Math.max(index,0),9999)}`);n=n.parentElement;}
    return {path,pathTruncated:Boolean(n&&n.nodeType===1)};
  };
  const canonicals=Array.from(document.querySelectorAll('link[rel~="canonical"]'));
  const canonical=canonicals.slice(0,12).map(node=>{
    let hasQuery=false,hasHash=false,pathPost=null;try{const u=new URL(node.href);hasQuery=Boolean(u.search);hasHash=Boolean(u.hash);pathPost=parse(u.origin+u.pathname,'post');}catch{/* Invalid is an unknown candidate. */}
    const post=parse(node.href,'post');return {kind:post?'post':'other',samePost:Boolean(post&&current&&post.key===current.key),samePostPath:Boolean(pathPost&&current&&pathPost.key===current.key),hasQuery,hasHash};
  });
  const articles=Array.from(document.querySelectorAll('article')),roleArticles=Array.from(document.querySelectorAll('[role="article"]'));
  const relevant=Array.from(document.querySelectorAll('main,article,[role="main"],[role="article"],[role="dialog"],[role="heading"],h1,h2,h3,h4,h5,h6,time,a[href]'));
  const nodes=relevant.slice(0,120).map(node=>{
    const tag=node.tagName.toLowerCase(),role=node.getAttribute('role'),profile=tag==='a'?parse(node.href,'profile'):null,post=tag==='a'?parse(node.href,'post'):tag==='time'?parse(node.closest('a[href]')?.href,'post'):null;
    const account=profile?.account||post?.account||null,safeAccount=account&&account.length<=64?account:null;
    const kind=tag==='a'?(profile?'profile':post?'post':'other_link'):tag==='time'?'time':/^h[1-6]$/.test(tag)||role==='heading'?'heading':tag==='article'?'article':role==='article'?'role_article':tag==='main'||role==='main'?'main':'dialog';
    return {kind,visible:visible(node),...nodePath(node),samePost:Boolean(post&&current&&post.key===current.key),account:safeAccount,labelMatchesAccount:Boolean(profile&&safeAccount&&node.innerText.trim().replace(/^@/,'').toLowerCase()===safeAccount),absoluteDateShape:tag==='time'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(node.getAttribute('datetime')||'')};
  });
  const postTimes=Array.from(document.querySelectorAll('time[datetime]')).filter(visible).filter(node=>{
    const post=parse(node.closest('a[href]')?.href,'post');return post&&current&&post.key===current.key;
  }).map(node=>node.getAttribute('datetime')).filter(Boolean);
  const textCandidates=Array.from(document.querySelectorAll('p,[dir="auto"]'));
  const textNodes=textCandidates.slice(0,80).map(node=>({
    visible:visible(node),...nodePath(node),textLength:limit((node.textContent||'').trim().length),
    directTextLength:limit(Array.from(node.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent||'').join('').trim().length),
    profileCount:limit(new Set(Array.from(node.querySelectorAll('a[href]')).filter(visible).map(a=>parse(a.href,'profile')?.key).filter(Boolean)).size),
    matchingPostTime:Array.from(node.querySelectorAll('time[datetime]')).filter(visible).some(n=>postTimes.includes(n.getAttribute('datetime')))
  }));
  const roles=new Set(['article','heading','main','dialog','region','list','listitem','figure','group','complementary','navigation','button','link','none','presentation']);
  const semanticCandidates=Array.from(document.querySelectorAll('[role],[aria-label],[aria-labelledby],[data-testid]'));
  const semanticNodes=semanticCandidates.slice(0,120).map(node=>{
    const rawRole=node.getAttribute('role')||'',label=node.getAttribute('aria-label')||'',testId=node.getAttribute('data-testid')||'';
    const attributesTruncated=[rawRole,label,testId].some(v=>v.length>1200),role=rawRole.slice(0,1200).toLowerCase(),words=(label.slice(0,1200)+' '+testId.slice(0,1200)).toLowerCase().match(/[a-z]+/g)||[];
    const markers=[];if(words.includes('caption'))markers.push('caption');if(words.some(w=>w==='comment'||w==='comments'))markers.push('comment');if(words.some(w=>w==='reply'||w==='replies'))markers.push('reply');if(words.includes('description'))markers.push('description');
    return {visible:visible(node),...nodePath(node),role:roles.has(role)?role:'other',markers,hasLabel:node.hasAttribute('aria-label'),hasLabelledBy:node.hasAttribute('aria-labelledby'),hasTestId:node.hasAttribute('data-testid'),attributesTruncated};
  });
  const meta=Array.from(document.querySelectorAll('meta'));
  const metaCount=key=>limit(meta.filter(n=>(n.getAttribute('property')||n.getAttribute('name')||'').toLowerCase()===key).length);
  const scripts=Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  const jsonLd=[],allowedTypes=new Set(['SocialMediaPosting','VideoObject','ImageObject','BlogPosting','Article','Person','Organization','WebPage']);
  let invalid=0,truncated=scripts.length>3;
  for(const script of scripts.slice(0,3)){
    const body=script.textContent||'';if(body.length>160000){invalid++;continue;}
    let parsed;try{parsed=JSON.parse(body);}catch{invalid++;continue;}
    const root=Array.isArray(parsed)?parsed:parsed&&typeof parsed==='object'&&Array.isArray(parsed['@graph'])?[parsed,...parsed['@graph']]:[parsed];
    if(root.length>16)truncated=true;
    for(const obj of root.slice(0,16)){
      if(!obj||typeof obj!=='object'||Array.isArray(obj))continue;
      const inputTypes=Array.isArray(obj['@type'])?obj['@type']:[obj['@type']];
      if(inputTypes.length>16)truncated=true;
      const types=[...new Set(inputTypes.slice(0,16).filter(v=>typeof v==='string').map(v=>v.startsWith('https://schema.org/')?v.slice(19):v).filter(v=>allowedTypes.has(v)))];
      if(!types.length&&!['url','@id','author','caption','description','articleBody'].some(k=>typeof obj[k]==='string'||obj[k]&&typeof obj[k]==='object'))continue;
      if(jsonLd.length>=16){truncated=true;break;}
      const main=obj.mainEntityOfPage,postRefs=[obj.url,obj['@id'],typeof main==='string'?main:main?.url,typeof main==='object'?main?.['@id']:null].map(v=>parse(v,'post')).filter(Boolean);
      const inputAuthors=Array.isArray(obj.author)?obj.author:[obj.author];if(inputAuthors.length>8)truncated=true;
      const authors=inputAuthors.slice(0,8),authorRefs=[];
      for(const author of authors){
        if(Array.isArray(author?.sameAs)&&author.sameAs.length>8)truncated=true;
        const refs=typeof author==='string'?[author]:author&&typeof author==='object'?[author.url,author['@id'],...(Array.isArray(author.sameAs)?author.sameAs.slice(0,8):[author.sameAs])]:[];
        for(const ref of refs){const profile=parse(ref,'profile');if(profile)authorRefs.push(profile);}
      }
      const length=k=>typeof obj[k]==='string'?limit(obj[k].length):0;
      jsonLd.push({types,postMatches:Boolean(current&&postRefs.some(p=>p.key===current.key)),postConflict:Boolean(current&&postRefs.some(p=>p.key!==current.key)),authorProfile:authorRefs.length>0,authorMatchesAccount:Boolean(current?.account&&authorRefs.some(a=>a.account===current.account)),authorMatchesVisible:authorRefs.some(a=>nodes.some(n=>n.kind==='profile'&&n.visible&&n.account===a.account)),captionLength:length('caption'),descriptionLength:length('description'),articleBodyLength:length('articleBody')});
    }
  }
  const metadata={ogDescriptionCount:metaCount('og:description'),descriptionCount:metaCount('description'),ogTitleCount:metaCount('og:title'),jsonLdScriptCount:limit(scripts.length),jsonLdInvalidCount:limit(invalid),jsonLdTruncated:truncated,jsonLd};
  return {version:2,currentPost:Boolean(current),readyState:['loading','interactive','complete'].includes(document.readyState)?document.readyState:'unknown',canonicalCount:limit(canonicals.length),canonical,articles:{total:limit(articles.length),visible:limit(articles.filter(visible).length)},roleArticles:{total:limit(roleArticles.length),visible:limit(roleArticles.filter(visible).length)},nodes,nodesTruncated:relevant.length>120,textNodes,textNodesTruncated:textCandidates.length>80,semanticNodes,semanticNodesTruncated:semanticCandidates.length>120,metadata};
}
export const postFormatDiagnosticsScript=`(${extractPostFormatDiagnostics.toString()})(${instagramResource.toString()})`;

// The rendered page is untrusted. Do not persist a page-controlled value outside
// this exact structural schema, even in the private source directory.
export function normalizePostFormatDiagnostics(raw){
  const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
  const count=n=>Number.isInteger(n)&&n>=0&&n<=10000;
  const bool=v=>typeof v==='boolean',tags='html|body|main|article|section|div|span|ul|ol|li|header|footer|a|h1|h2|h3|h4|h5|h6|time|p|nav|aside|button|other';
  const segment=new RegExp(`^(?:${tags}):(?:0|[1-9]\\d{0,3})$`),kinds=new Set(['main','article','role_article','dialog','heading','profile','post','other_link','time']);
  const roles=new Set(['article','heading','main','dialog','region','list','listitem','figure','group','complementary','navigation','button','link','none','presentation','other']),markers=new Set(['caption','comment','reply','description']),types=new Set(['SocialMediaPosting','VideoObject','ImageObject','BlogPosting','Article','Person','Organization','WebPage']);
  const validPath=n=>bool(n.visible)&&Array.isArray(n.path)&&n.path.length<=48&&n.path.every(s=>typeof s==='string'&&segment.test(s))&&bool(n.pathTruncated);
  const valid=exact(raw,['version','currentPost','readyState','canonicalCount','canonical','articles','roleArticles','nodes','nodesTruncated','textNodes','textNodesTruncated','semanticNodes','semanticNodesTruncated','metadata'])&&raw.version===2&&bool(raw.currentPost)&&['loading','interactive','complete','unknown'].includes(raw.readyState)&&count(raw.canonicalCount)&&
    Array.isArray(raw.canonical)&&raw.canonical.length<=12&&raw.canonical.length<=raw.canonicalCount&&raw.canonical.every(c=>exact(c,['kind','samePost','samePostPath','hasQuery','hasHash'])&&['post','other'].includes(c.kind)&&bool(c.samePost)&&bool(c.samePostPath)&&bool(c.hasQuery)&&bool(c.hasHash))&&
    exact(raw.articles,['total','visible'])&&count(raw.articles.total)&&count(raw.articles.visible)&&raw.articles.visible<=raw.articles.total&&
    exact(raw.roleArticles,['total','visible'])&&count(raw.roleArticles.total)&&count(raw.roleArticles.visible)&&raw.roleArticles.visible<=raw.roleArticles.total&&
    Array.isArray(raw.nodes)&&raw.nodes.length<=120&&bool(raw.nodesTruncated)&&raw.nodes.every(n=>exact(n,['kind','visible','path','pathTruncated','samePost','account','labelMatchesAccount','absoluteDateShape'])&&kinds.has(n.kind)&&validPath(n)&&bool(n.samePost)&&(n.account===null||typeof n.account==='string'&&/^[a-z0-9._-]{1,64}$/.test(n.account))&&bool(n.labelMatchesAccount)&&bool(n.absoluteDateShape))&&
    Array.isArray(raw.textNodes)&&raw.textNodes.length<=80&&bool(raw.textNodesTruncated)&&raw.textNodes.every(n=>exact(n,['visible','path','pathTruncated','textLength','directTextLength','profileCount','matchingPostTime'])&&validPath(n)&&count(n.textLength)&&count(n.directTextLength)&&count(n.profileCount)&&bool(n.matchingPostTime))&&
    Array.isArray(raw.semanticNodes)&&raw.semanticNodes.length<=120&&bool(raw.semanticNodesTruncated)&&raw.semanticNodes.every(n=>exact(n,['visible','path','pathTruncated','role','markers','hasLabel','hasLabelledBy','hasTestId','attributesTruncated'])&&validPath(n)&&roles.has(n.role)&&Array.isArray(n.markers)&&n.markers.length<=4&&new Set(n.markers).size===n.markers.length&&n.markers.every(m=>markers.has(m))&&bool(n.hasLabel)&&bool(n.hasLabelledBy)&&bool(n.hasTestId)&&bool(n.attributesTruncated))&&
    exact(raw.metadata,['ogDescriptionCount','descriptionCount','ogTitleCount','jsonLdScriptCount','jsonLdInvalidCount','jsonLdTruncated','jsonLd'])&&count(raw.metadata.ogDescriptionCount)&&count(raw.metadata.descriptionCount)&&count(raw.metadata.ogTitleCount)&&count(raw.metadata.jsonLdScriptCount)&&count(raw.metadata.jsonLdInvalidCount)&&raw.metadata.jsonLdInvalidCount<=raw.metadata.jsonLdScriptCount&&bool(raw.metadata.jsonLdTruncated)&&Array.isArray(raw.metadata.jsonLd)&&raw.metadata.jsonLd.length<=16&&raw.metadata.jsonLd.every(n=>exact(n,['types','postMatches','postConflict','authorProfile','authorMatchesAccount','authorMatchesVisible','captionLength','descriptionLength','articleBodyLength'])&&Array.isArray(n.types)&&n.types.length<=8&&new Set(n.types).size===n.types.length&&n.types.every(t=>types.has(t))&&bool(n.postMatches)&&bool(n.postConflict)&&bool(n.authorProfile)&&bool(n.authorMatchesAccount)&&bool(n.authorMatchesVisible)&&count(n.captionLength)&&count(n.descriptionLength)&&count(n.articleBodyLength));
  if(!valid)throw Object.assign(new Error('Invalid private post-format diagnostic structure'),{code:'BROWSER_DATA'});
  return raw;
}

const issues=new Set(['missing_context','canonical_mismatch','ambiguous_article','ambiguous_caption','ambiguous_author','author_mismatch','permalink_mismatch','invalid_caption','invalid_context']);
const same=(a,b)=>Boolean(publicResourceKey(a)&&publicResourceKey(a)===publicResourceKey(b));
const exactKeys=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&[Object.prototype,null].includes(Object.getPrototypeOf(o))&&Object.keys(o).length===keys.length&&Object.keys(o).every(k=>keys.includes(k));
export function normalizePostEvidence(o,raw){
  if(!requiresPostEvidence(o.url))return {};
  const failure=postEvidenceIssue=>({postEvidenceVersion:1,postEvidenceIssue});
  if(!raw)return failure('missing_context');
  if(exactKeys(raw,['issue']))return failure(issues.has(raw.issue)?raw.issue:'invalid_context');
  if(o.method!=='fresh_guest_rendered_dom'||o.evidenceContextVersion!==1||o.blocked||!exactKeys(raw,['proof','postUrl','canonicalUrl','authorUrl','caption','links'])||raw.proof!=='instagram_article_caption_v1')return failure('invalid_context');
  const requested=instagramResource(o.url,'post'),committed=instagramResource(o.finalUrl,'post'),post=instagramResource(raw.postUrl,'post'),canonical=instagramResource(raw.canonicalUrl,'post'),author=instagramResource(raw.authorUrl,'profile');
  if(!requested||!committed||!post||!canonical||[committed,post,canonical].some(p=>p.key!==requested.key))return failure('permalink_mismatch');
  if(!author||[requested,committed,post,canonical].some(p=>p.account&&p.account!==author.account))return failure('author_mismatch');
  if(typeof raw.caption!=='string'||!raw.caption.trim()||raw.caption!==raw.caption.trim()||raw.caption.length>10000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw.caption)||!o.text?.includes(raw.caption))return failure('invalid_caption');
  const observed=o.links||[];
  if(!observed.some(l=>instagramResource(l.url,'post')?.key===post.key)||!observed.some(l=>instagramResource(l.url,'profile')?.key===author.key&&String(l.text||'').trim().replace(/^@/,'').toLowerCase()===author.account))return failure('invalid_context');
  if(!Array.isArray(raw.links)||raw.links.length>40)return failure('invalid_context');
  const links=[];
  for(const l of raw.links){
    if(!exactKeys(l,['url','text'])||typeof l.text!=='string'||l.text.length>120)return failure('invalid_context');
    let url;try{url=publicUrl(l.url).href;}catch{return failure('invalid_context');}
    if(!observed.some(v=>same(v.url,url)&&v.text===l.text))return failure('invalid_context');
    links.push({url,text:l.text});
  }
  return {postEvidenceVersion:1,postEvidence:{proof:raw.proof,postUrl:post.url,canonicalUrl:canonical.url,authorUrl:author.url,caption:raw.caption,links}};
}

// verifiedProfiles is supplied by intake's existing candidate/name/source binding.
// This function still checks the fresh DOM, original-profile redirect and link join.
export function attributedPostContent(o,verifiedProfiles){
  if(!freshEvidence(o.inspectedAt)||o.postEvidenceVersion!==1||o.postEvidenceIssue)return null;
  const normalized=normalizePostEvidence(o,o.postEvidence),proof=normalized.postEvidence;if(!proof)return null;
  const author=instagramResource(proof.authorUrl,'profile'),post=instagramResource(proof.postUrl,'post');
  const original=verifiedProfiles.some(p=>!p.blocked&&freshEvidence(p.inspectedAt)&&p.method==='fresh_guest_rendered_dom'&&p.evidenceContextVersion===1&&
    instagramResource(p.url,'profile')?.key===author.key&&instagramResource(p.finalUrl,'profile')?.key===author.key&&
    (p.links||[]).some(l=>{const route=instagramResource(l.url,'post');return route?.key===post.key&&(!route.account||route.account===author.account);}));
  if(!original)return null;
  return {...o,...normalized,...postCaptionContent(o,proof)};
}

// Structural caption projection is also the only public post-reader content.
// Business attribution additionally requires the original-profile join above.
export function postCaptionContent(o,proof){
  const author=instagramResource(proof.authorUrl,'profile'),post=instagramResource(proof.postUrl,'post');
  return {text:proof.caption,links:[...proof.links,{url:proof.authorUrl,text:author.account},{url:proof.postUrl,text:'Observed post permalink'}],images:(o.images||[]).filter(i=>{const route=instagramResource(i.postUrl,'post');return route?.key===post.key&&(!route.account||route.account===author.account);})};
}
