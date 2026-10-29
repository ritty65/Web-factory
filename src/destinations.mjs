import {publicUrl,publicResourceKey} from './contracts.mjs';

export const freshEvidence = value => Number.isFinite(Date.parse(value)) && Date.now()-Date.parse(value)<=7*86400000 && Date.parse(value)<=Date.now()+300000;
const same=(a,b)=>Boolean(publicResourceKey(a)&&publicResourceKey(a)===publicResourceKey(b));
const host=value=>publicUrl(value).hostname.replace(/^www\./,'');
export function isBookingUrl(value){try{const h=host(value);return ['booksy.com','fresha.com','square.site','squareup.com','acuityscheduling.com','setmore.com','vagaro.com','schedulicity.com'].some(d=>h===d||h.endsWith('.'+d));}catch{return false;}}
export function isLinkHubUrl(value){try{const u=publicUrl(value),h=host(value);return ['linktr.ee','beacons.ai','bio.site','lnk.bio','campsite.bio','hoo.be'].includes(h)||['threads.com','threads.net'].includes(h)&&/^\/@[A-Za-z0-9._-]+\/?$/.test(u.pathname);}catch{return false;}}

// Pure assessment only. A route never creates an observation or a qualification.
// The existing first-party target enumerator is supplied to avoid an intake cycle.
export function assessDestinations({roots,observations,linkChecks=[],targetsForSource}){
  const unresolved=[],destinations=[],visited=new Set();let checked=0,official=false,booking=false;
  const gap=(target,source,reason,observation)=>unresolved.push({url:target.url||null,alias:target.alias||null,sourceId:source.id,reason,...(observation?{observationId:observation.id}: {})});
  function walk(source,depth=0,chain=new Set([publicResourceKey(source.url),publicResourceKey(source.finalUrl)].filter(Boolean))){
    for(const target of targetsForSource(source)){
      if(!target.url){gap(target,source,'ambiguous');continue;}
      const key=publicResourceKey(target.url);if(!key){gap({url:null},source,'ambiguous');continue;}
      if(depth&&[source.url,source.finalUrl].some(u=>same(u,target.url)))continue;
      if(chain.has(key)){gap(target,source,'cycle');continue;}
      if(visited.has(key))continue;
      visited.add(key);if(visited.size>40){gap(target,source,'limit');break;}
      const findings=linkChecks.filter(v=>same(v.url,target.url)||same(v.url,target.alias));
      const proofs=findings.flatMap(f=>observations.filter(o=>o.id===f.sourceId&&(same(o.url,target.url)||same(o.finalUrl,target.url))).map(o=>({finding:f,observation:o})));
      const usable=proofs.filter(p=>!p.observation.blocked&&freshEvidence(p.observation.inspectedAt)&&['official','unofficial','not_business'].includes(p.finding.status));
      if(!usable.length){
        const observed=observations.find(o=>same(o.url,target.url)||same(o.finalUrl,target.url));
        gap(target,source,observed?.blocked?'blocked':observed&&!freshEvidence(observed.inspectedAt)?'stale':observed?'unclassified':'missing_inspection',observed);continue;
      }
      // A positive official finding cannot be hidden by an earlier unofficial one.
      const proof=usable.find(p=>p.finding.status==='official')||usable[0],o=proof.observation,destination=o.finalUrl||target.url;
      checked++;
      if(isBookingUrl(destination)){booking=true;destinations.push({url:target.url,finalUrl:destination,sourceId:o.id,kind:'booking'});continue;}
      if(isLinkHubUrl(destination)){
        destinations.push({url:target.url,finalUrl:destination,sourceId:o.id,kind:'hub'});
        const finalKey=publicResourceKey(destination);
        if(finalKey!==key&&chain.has(finalKey)){gap(target,source,'cycle',o);continue;}
        if(depth>=2){gap(target,source,'depth',o);continue;}
        walk(o,depth+1,new Set([...chain,key,finalKey]));continue;
      }
      const kind=proof.finding.status==='official'?'official':proof.finding.status;
      if(kind==='official')official=true;
      destinations.push({url:target.url,finalUrl:destination,sourceId:o.id,kind});
    }
  }
  for(const root of roots)walk(root);
  return {status:official?'official':booking?'booking_only':unresolved.length?'unresolved':'clear',checked,unresolved,destinations};
}
