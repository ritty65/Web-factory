import {now} from './contracts.mjs';
import {memberEvidenceCurrent,suppressionFor} from './batch-store.mjs';

const stageNames={research:'Research',brief:'Creative brief',directions:'Design directions',selection:'Direction selection',proposal:'Page generation',qa:'Browser QA',critique:'Visual critique',package:'Review package'};
const units={searches:'Search attempt reserved',inspections:'Page inspection attempt reserved',imageViews:'Image-view attempt reserved',modelRequests:'Native worker launch reserved'};
export function progressSnapshot(store,b,jobs) {
  const legacyScreening=b.members.length>0&&!b.members.some(m=>m.prospect?.screening?.version===1);
  const phases=b.settings.workflow==='leads_first'?[['discovery',legacyScreening?'Get leads':'Get leads & screen'],['selection','Choose one'],['enrichment','Enrich evidence'],['production','Make & check'],['first_site_review','Your review']]:[['research','Find & qualify'],['production','Make & check'],['first_site_review','Your review']];
  const stages=phases.map(([id,label])=>({id,label,state:'pending'})),set=(id,state)=>{const s=stages.find(s=>s.id===id);if(s)s.state=state;};
  const discovery=jobs.filter(j=>j.kind==='discovery'&&j.input.phase!=='enrichment'),enrichment=jobs.find(j=>j.input.phase==='enrichment');
  const sites=jobs.filter(j=>j.kind==='site'),site=sites.at(-1),researchId=phases[0][0];
  const stopped=['held','stopped','complete'].includes(b.state)||Date.now()>=Date.parse(b.deadlineAt);
  const stateFor=job=>stopped?b.state==='held'?'blocked':'stopped':['failed','blocked','cancelled','review_ready'].includes(job?.state)?'blocked':job?.state==='running'?'running':'queued';
  if(discovery.length)set(researchId,discovery.every(j=>j.state==='review_ready')&&b.phase!==researchId?'done':stateFor(discovery.at(-1)));
  if(b.state==='awaiting_selection')set('selection',b.counts?.selectable===0?'blocked':'waiting');
  if(b.selection){set('selection','done');if(enrichment)set('enrichment',b.members.find(m=>m.candidateId===b.selection.candidateId)?.ready?'done':stateFor(enrichment));}
  const member=site&&b.members.find(m=>m.candidateId===site.input.candidateId),candidate=member&&store.candidate(member.candidateId);
  const reviewReady=site?.state==='review_ready'&&site.outputs.qaPass===true&&site.outputs.reviewStatus==='operator_review_required'&&Boolean(site.outputs.siteDigest)&&Boolean(member)&&!['needs_changes','not_a_fit'].includes(member.disposition)&&memberEvidenceCurrent(member,candidate)&&!suppressionFor(store,candidate);
  if(site)set('production',reviewReady?'done':stateFor(site));
  if(reviewReady)set('first_site_review',b.checkpoint?'done':'waiting');
  const activity=[];
  for(const job of jobs)for(const event of store.events(job.id)) {
    let label=null;
    if(event.type==='batch.usage_reserved')label=units[event.detail?.unit]||null;
    else if(event.type==='job.created')label='Job queued';
    else if(event.type==='job.started')label='Worker started';
    else if(event.type==='job.completed')label='Job result retained';
     else if(event.type==='job.stopped'||event.type==='job.cancelled')label='Job stopped; work retained';
     else if(event.type==='scout.task_started')label='Evidence scout question started';
     else if(event.type==='scout.task_completed')label='Evidence scout observation retained';
     else if(event.type==='scout.task_blocked')label='Evidence scout source held; attempt retained';
    else if(['stage.started','stage.completed','stage.failed'].includes(event.type)) {
      const name=String(event.message||'').replace(/^(Starting|Completed|Stopped) /,'').replace(/-\d+$/,'');
      if(stageNames[name])label=`${stageNames[name]} ${event.type==='stage.completed'?'checkpoint saved':event.type==='stage.failed'?'stopped':'started'}`;
    }
    if(label&&Number.isFinite(Date.parse(event.at))&&Date.parse(event.at)<=Date.now()+300000)activity.push({jobId:job.id,seq:event.seq,at:event.at,label});
  }
  activity.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.seq-b.seq);
  const lastActivityAt=activity.at(-1)?.at||null;
  return {snapshotAt:now(),stages,running:!stopped&&b.state==='active'&&jobs.some(j=>j.state==='running'),lastActivityAt,activity:activity.slice(-6),
     counts:{saved:b.members.length,screened:b.members.filter(m=>m.prospect?.screening?.version===1).length,eligibleForEnrichment:b.members.filter(m=>m.prospect?.screening?.status==='clear_for_enrichment'&&(b.acquisition?.version!==1||m.prospect?.material?.feasible)).length,sitesReady:reviewReady?1:0},
    limitations:['Milestones describe recorded evidence, not elapsed-work percentages or human acceptance','Usage bars count reserved attempts including failures, never successful work or dollars']};
}
