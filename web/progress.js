/* Read-only visual evidence. Timers update freshness labels, never work counters. */
window.FactoryProgress = (() => {
  'use strict';
  const labels={pending:'Not reached',queued:'Queued',running:'Working',waiting:'Waiting for you',done:'Recorded',blocked:'Held',stopped:'Stopped'};
  const expanded=new Map();
  function clocks() {
    for(const root of document.querySelectorAll('[data-ledger-progress]')) {
      const sinceRead=Math.max(0,performance.now()-Number(root.dataset.received)),age=Math.max(0,Number(root.dataset.activityAge)+sinceRead);
      const offline=root.dataset.connection==='offline',paused=document.hidden||sinceRead>12000,quiet=root.dataset.hasActivity!=='true'||age>45000;
      root.dataset.running=String(root.dataset.workerRunning==='true'&&!offline&&!paused&&!quiet);
      const status=root.querySelector('.progress-work-status');
      const text=offline?'Connection lost — showing saved progress.':paused&&root.dataset.active==='true'?'Updates paused — showing last saved progress.':quiet&&root.dataset.workerRunning==='true'?'No recent worker activity — completion is unknown.':root.dataset.status;
      if(status.textContent!==text)status.textContent=text;
      root.querySelector('.progress-age').textContent=root.dataset.hasActivity==='true'?`Last recorded activity ${Math.floor(age/1000)}s ago`:'No recorded worker activity yet';
    }
  }
  function disconnected() {for(const root of document.querySelectorAll('[data-ledger-progress]'))root.dataset.connection='offline';clocks();}
  function create(ctx,detail,{compact=false}={}) {
    const {node:n,p}=ctx,b=detail.batch,value=detail.progress;
    if(!value)return p('Progress evidence unavailable. Refresh the saved ledger.','inline-message');
    const status=b.outcome?.kind==='no_selectable_prospect'?'No selectable business — inspect retained results.':b.state==='held'?'Held — inspect the evidence before continuing.':b.state==='stopped'?'Stopped — retained work, no automatic restart.':b.state==='awaiting_selection'?'Waiting for your selection.':b.state==='awaiting_first_review'?'Waiting for your review — no acceptance recorded.':b.state==='complete'?'Run ended — inspect the retained outcome.':value.running?'Worker active — awaiting the next saved result.':'Queued — no worker activity confirmed yet.';
    const root=n('section',{class:'ledger-progress',role:'region','aria-label':'Evidence-backed progress','data-ledger-progress':'true','data-connection':'online','data-received':performance.now(),'data-activity-age':Math.max(0,Date.parse(value.snapshotAt)-Date.parse(value.lastActivityAt||value.snapshotAt)),'data-has-activity':Boolean(value.lastActivityAt),'data-worker-running':value.running,'data-active':b.state==='active','data-status':status},
      n('div',{class:'progress-heading'},n('h3',{},'What is happening'),n('span',{class:'progress-status-line'},n('span',{class:'work-indicator','aria-hidden':'true'}),n('span',{class:'progress-work-status',role:'status','aria-live':'polite'},status))),
      n('ol',{class:'ledger-stages','aria-label':'Recorded workflow milestones'},value.stages.map(s=>n('li',{'data-stage':s.id,'data-state':s.state,'aria-current':['running','queued','waiting'].includes(s.state)?'step':null},n('span',{class:'milestone-mark','aria-hidden':'true'},s.state==='done'?'✓':['blocked','stopped'].includes(s.state)?'!':'•'),n('span',{},s.label,n('small',{},labels[s.state]||'Unknown'))))),
      p(`${value.counts.saved} saved · ${value.counts.screened} early-screened · ${value.counts.eligibleForEnrichment} clear for enrichment · ${value.counts.sitesReady} sites ready`,'progress-results'),
      n('div',{class:'progress-allowances'},n('h4',{},'Attempts used, not completion'),n('div',{class:'allowance-grid'},[['searches','maxSearches','Search'],['inspections','maxInspections','Page inspection'],['imageViews','maxImageViews','Image view'],['modelRequests','maxModelRequests','Native launch']].map(([unit,cap,label])=>{
        const max=Number(b.settings[cap]),used=Number(b.usage[unit]);
        return n('div',{class:'allowance'},n('div',{},n('span',{},label),n('span',{},`${used} / ${max}`)),n('progress',{'aria-label':label+' attempts used',max,value:Math.min(max,Math.max(0,used))}));
      })),p('Failed attempts consume allowance too. These bars are not a success score, cost or time estimate.','meta')),
      value.activity.length?n('ul',{class:'progress-activity','aria-label':'Latest retained activity'},value.activity.slice(-3).reverse().map(a=>n('li',{},n('time',{datetime:a.at},ctx.stamp(a.at)),a.label))):p('The next worker event will appear here.','meta'),
      n('p',{class:'progress-freshness'},n('span',{class:'progress-age'}),n('span',{},'Ledger snapshot ',n('time',{datetime:value.snapshotAt},ctx.stamp(value.snapshotAt)))));
    if(compact){
      root.classList.add('progress-compact');
      const more=n('details',{class:'progress-more',open:expanded.get(b.id)===true,ontoggle:e=>{if(e.currentTarget.isConnected)expanded.set(b.id,e.currentTarget.open);}},n('summary',{},'Progress & usage'));
      const content=[...root.children].slice(1,-1);more.append(...content);root.insertBefore(more,root.lastElementChild);
    }
    queueMicrotask(clocks);return root;
  }
  setInterval(clocks,1000);document.addEventListener('visibilitychange',clocks);window.addEventListener('offline',disconnected);
  return {create,disconnected};
})();
