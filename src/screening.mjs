import {publicUrl, publicResourceKey} from './contracts.mjs';
import {identityObservations, supportedFact, profileAnchors,listingObservations,listingLocation,candidateDestinations} from './intake.mjs';
export {isBookingUrl,isLinkHubUrl} from './destinations.mjs';

const same = (a,b) => Boolean(publicResourceKey(a) && publicResourceKey(a) === publicResourceKey(b));
const fresh = value => Number.isFinite(Date.parse(value)) && Date.now()-Date.parse(value)<=7*86400000 && Date.parse(value)<=Date.now()+300000;
const host = value => publicUrl(value).hostname.replace(/^www\./,'');

function serviceLocation(c,fact,identity){
  // A narrow literal service description/location label is not a city in the name,
  // hashtag, review quote or model paraphrase. Exact source/identity binding is
  // checked before this helper; existing outside-base conflicts still win.
  if(fact.evidenceRef)return false;
  const name=c.name.trim().toLowerCase().replace(/[.!]$/,'');
  return fact.excerpt.split(/\r?\n/).some(line=>{
    line=line.trim();if(name.includes(line.toLowerCase().replace(/[.!]$/,'')))return false;
    const positive=/^houston\s+(?:(?:event(?: and party)?|party|mobile(?: auto)?|auto|custom|cake)\s+)?(?:planners?|decorators?|detailers?|bakers?)\s+(?:for|speciali[sz]ing in|offering)\s+[\p{L}\p{N}][^.!?\n]{1,100}[.!]?$/iu.test(line)||/^📍\s*houston\s*\|\s*(?:tx|texas)[.!]?$/iu.test(line)||/^(?:we come to you[.!]\s+)?we service the entire houston area[.!]?$/iu.test(line);
    // Do not let a model cut "Not a", a request or quote marks off a literal
    // substring. The retained complete source line must itself say this.
    return positive&&identity.some(o=>(same(o.url,fact.sourceUrl)||same(o.finalUrl,fact.sourceUrl))&&String(o.text||'').split(/\r?\n/).some(observed=>observed.trim()===line));
  });
}

// Cheap, source-bound disqualifiers before selection, NOT no-site qualification.
// Follow only already inspected hub destinations; this pure function cannot spend.
export function screeningContext(c,evidence={}){
  const observations=evidence.observations||[], bound=observations.filter(o=>c.inspectionIds.includes(o.id)&&!o.blocked&&fresh(o.inspectedAt));
  // A source-only original can be screened from its actually observed profile.
  // This temporary matching view never publishes a contact or modifies c.
  const anchors=profileAnchors(c),view={...c,contacts:{...c.contacts}};
  if(!['instagram','facebook'].some(k=>anchors.includes(publicResourceKey(c.contacts?.[k]))))for(const anchor of anchors){const platform=host(anchor).replace(/^m\./,'');if(platform==='instagram.com')view.contacts.instagram=anchor;if(platform==='facebook.com')view.contacts.facebook=anchor;}
   const identity=identityObservations(view,bound),listings=listingObservations(view,bound,identity);
   const facts=c.facts.filter(f=>supportedFact(view,f,identity)||listingLocation(view,f,listings));
   return {view,bound,identity,listings,facts};
}
export function assessScreening(c, evidence = {}, settings = {}) {
   const observations=evidence.observations||[],{view,bound,identity,listings,facts}=screeningContext(c,evidence);
  const located=facts.some(f=>listingLocation(view,f,listings)||identity.some(o=>same(o.url,f.sourceUrl)||same(o.finalUrl,f.sourceUrl))&&(/\b(?:in|serves?|serving|based in|located in|based out of)\s+(?:the\s+)?houston\b|\bhouston\s*,?\s*(?:tx|texas)\b|\bhouston[-–—]based\b/i.test(f.excerpt)||serviceLocation(c,f,identity)));
  const conflict=settings.area!=='Houston metro area' && identity.some(o=>{
    const text=String(o.text||'');
    const explicit=[...text.matchAll(/\b(?:based|located)\s+(?:in|out of)\s+([A-Za-z][A-Za-z '-]{1,60})/gi)].some(m=>!/^houston\b/i.test(m[1].trim()));
    const placeBased=[...text.matchAll(/\b([A-Za-z]+(?: [A-Za-z]+){0,2})[-–—]based\b/gi)].some(m=>!/(?:\bhouston(?: (?:tx|texas))?|\b(?:home|family|faith|service|appointment|community|commission|project|evidence))$/i.test(m[1]));
    return explicit||placeBased;
  });
  const geography=conflict?'conflict':located?'supported':'unknown';
  const reasons=[];if(!identity.length)reasons.push('Early screening needs a fresh identity-matched public source.');
  if(geography!=='supported')reasons.push(conflict?'Observed base/location conflicts with the saved Houston city scope; do not silently broaden it.':'Early screening needs an observed Houston location/service-area claim, not a Houston business name alone.');
   const graph=candidateDestinations(view,observations,bound,identity,listings);
   const official=graph.status==='official',booking=graph.status==='booking_only',unresolved=graph.unresolved.length,checked=graph.checked;
  if(unresolved)reasons.push('A possible outbound business/builder/link-in-bio destination remains uninspected or unresolved in early screening.');
  if(official)reasons.push('An inspected linked official website excludes this no-site prospect before enrichment.');
  if(booking)reasons.push('An inspected booking destination belongs to the separately unsupported booking segment.');
  return {version:1,status:official?'excluded':booking?'booking_only':reasons.length?'needs_verification':'clear_for_enrichment',geography,checkedDestinations:checked,unresolvedDestinations:unresolved,reasons,fullQualification:false,
    limitations:['Observed Houston service-area wording is not an exact city-boundary/geocoding certificate','Screening does not establish website absence, activity, useful pages, media rights or a finished site']};
}
