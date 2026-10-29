import {publicResourceKey} from './contracts.mjs';
import {screeningContext} from './screening.mjs';
import {supportedActivity} from './intake.mjs';
import {stablePostUrl} from './evidence-context.mjs';
import {validateMediaSelection} from './media.mjs';
import {normalized} from './batch-store.mjs';

export const acquisitionPolicy=()=>({version:1,reserve:{searches:2,inspections:6,imageViews:3,modelRequests:8},minutes:20,productionModelFloor:6});
const same=(a,b)=>Boolean(publicResourceKey(a)&&publicResourceKey(a)===publicResourceKey(b));
export function assessMaterial(c,evidence={}){
  const {view,identity,facts}=screeningContext(c,evidence),photos=new Set();
  const factCount=new Set(facts.map(f=>normalized(f.excerpt)).filter(Boolean)).size;
  for(const source of identity)for(const image of source.images||[]){
    if(!Number.isFinite(image.width)||!Number.isFinite(image.height)||image.width<300||image.height<200||typeof image.id!=='string')continue;
    const selected=c.media.find(m=>m.sourceId===source.id&&m.imageId===image.id);
    let post=stablePostUrl(image.postUrl,source.url);
    if(!post&&selected){try{validateMediaSelection(view,selected,source);post=stablePostUrl(selected.postUrl,source.url);}catch{/* A selected assertion alone is not evidence. */}}
    if(post&&[source.url,...(source.links||[]).map(l=>l.url)].some(u=>same(u,post)))photos.add(`${source.id}:${image.id}`);
  }
  const datedActivity=supportedActivity(view,identity),gaps=[];
  if(factCount<3)gaps.push('Material check needs three distinct useful fact excerpts on fresh identity-matched sources.');
  if(!datedActivity)gaps.push('Material check needs an actually observed absolute recent activity date; an active flag is not proof.');
  if(!photos.size)gaps.push('Material check needs a useful observed social photograph with an actually observed stable post route.');
  return {version:1,feasible:gaps.length===0,factCount,datedActivity,observedPhotoCount:photos.size,gaps,fullQualification:false,pixelsViewed:false,publicLicence:'unconfirmed'};
}
export function discoveryQueries(settings){
  const categories=String(settings.niche||'').split(/[,;/]|\band\b/i).map(v=>v.replace(/[^\p{L}\p{N} -]/gu,' ').replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,3);
  if(!categories.length)return [];
  const families=['local_listing','instagram','facebook','general'],result=[];
  for(let i=0;i<categories.length*4;i++){
    // Rotate both dimensions so a small allowance still sees different evidence routes.
    const family=families[i%4],category=categories[(i+Math.floor(i/4))%categories.length],base=`Houston Texas ${category}`;
    // Social-order wording is a discovery signal only. It does not imply no site,
    // consent, locality, activity or enough material; the unchanged gates decide.
    const contact=/bak|cakes?/i.test(category)?'"DM to order"':/decor|events?|part(?:y|ies)/i.test(category)?'"DM to book"':/detail/i.test(category)?'"DM" "mobile"':'"DM"';
    const query=family==='instagram'?`site:instagram.com ${base} ${contact}`:family==='facebook'?`site:facebook.com ${base} ${contact}`:family==='local_listing'?`${base} local business directory`:`${base} small business`;
    if(!result.some(v=>v.query===query))result.push({family,query:query.slice(0,300)});
  }
  return result;
}
export function completionCapacity(b){
  if(b.acquisition?.version!==1)return {available:true,gaps:[],remaining:null,reserve:null};
  const reserve=b.acquisition.reserve,remaining={},gaps=[];
  for(const [unit,cap] of Object.entries({searches:'maxSearches',inspections:'maxInspections',imageViews:'maxImageViews',modelRequests:'maxModelRequests'})){
    const left=b.settings[cap]-b.usage[unit];remaining[unit]=Number.isFinite(left)?Math.max(0,left):null;
    if(!Number.isFinite(left)||!Number.isFinite(reserve?.[unit])||left<reserve[unit])gaps.push(`Insufficient remaining ${unit} for selected intake and production; the saved allowance cannot reset.`);
  }
  const minutes=(Date.parse(b.deadlineAt)-Date.now())/60000;
  if(!Number.isFinite(minutes)||minutes<b.acquisition.minutes)gaps.push('Insufficient original batch time remains for selected intake and production.');
  return {available:!gaps.length,gaps,remaining,reserve};
}
export function discoveryAdmission(b){
  const result=completionCapacity(b);if(b.acquisition?.version!==1||!result.available)return result;
  const gaps=['modelRequests','searches','inspections'].filter(unit=>result.remaining[unit]<=result.reserve[unit]).map(unit=>`Another discovery job has no spare ${unit} above the frozen completion reserve; no job was queued.`);
  return {...result,available:!gaps.length,gaps};
}
