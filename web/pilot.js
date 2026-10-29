/* Operator-only views. Literal DOM; no source/notes become HTML or instructions. */
window.FactoryPilot=(()=>{
  'use strict';
  const ui={salesOffset:0,historyOffset:0,entryOffset:0,caseId:null,tab:'activity'};
  const usd=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
  const money=v=>Math.round(Number(v||0)*100);
  const request=()=>crypto.randomUUID();
  function field(ctx,label,name,attrs={},value=''){
    const e=ctx.node(attrs.multiline?'textarea':'input',{name,...attrs});if('value'in e)e.value=value;
    return ctx.node('label',{},label,e);
  }
  function select(ctx,label,name,options,value){
    const id='pilot-'+request();
    return ctx.node('div',{class:'pilot-field'},ctx.node('label',{for:id},label),ctx.node('select',{id,name},options.map(([v,text])=>ctx.node('option',{value:v,selected:v===value},text))));
  }
  function form(ctx,label,children,submit,onSubmit){
    const send=ctx.node('button',{type:'submit',class:'primary'},submit);
    return ctx.node('form',{'aria-label':label,class:'pilot-form',onsubmit:async e=>{
      e.preventDefault();if(send.disabled)return;const target=e.currentTarget,values=Object.fromEntries(new FormData(target));send.disabled=true;target.setAttribute('aria-busy','true');
      try{await onSubmit(values,e);}catch(error){ctx.announce(error.message||'This entry could not be recorded.',true);}finally{send.disabled=false;target.setAttribute('aria-busy','false');}
    }},children,send);
  }
  function load(ctx,fn){
    const root=ctx.node('div',{class:'pilot-view','aria-busy':'true'},ctx.p('Reading the actual local ledger…','muted'));window.PilotReady=false;
    Promise.resolve().then(()=>fn(root)).catch(e=>{if(root.isConnected)root.replaceChildren(ctx.empty('This workflow needs attention.',e.message||'Refresh the local service and check the pilot migration.'));}).finally(()=>{if(root.isConnected){root.setAttribute('aria-busy','false');window.PilotReady=true;}});
    return root;
  }
  function sales(ctx){return load(ctx,async root=>{
    const {node:n,p,button,op,action,state,link,sectionTop}=ctx;
    const data=await op('sales_status',{offset:ui.salesOffset,limit:20});if(!root.isConnected)return;
    const requested=location.hash.split('/')[1],selected=requested||data.items[0]?.id;
    if(selected!==ui.caseId){ui.caseId=selected;ui.entryOffset=0;}
    const detail=selected?await op('case_get',{id:selected,offset:ui.entryOffset,limit:20}):null;if(!root.isConnected)return;
    const summary=n('section',{class:'commercial-summary','aria-label':'Reported financial summary'},
      p('AIM FOR THREE RETAINED PURCHASES / WEEK','kicker'),n('h2',{},'Recorded money & cost coverage.'),
      p(`${data.money.reportedFullyPaidCases} reported fully paid · ${data.total} cases · ${data.production.uniqueStarts} total production starts`),
      n('dl',{class:'finance-lines'},n('dt',{},'Reported invoices'),n('dd',{},usd(data.money.invoicedCents)),n('dt',{},'Net reported receipts'),n('dd',{},usd(data.money.netReceivedCents)),n('dt',{},'Recorded cash + labor'),n('dd',{},data.costs.records?usd(data.costs.totalCents):'Not recorded'),n('dt',{},'Cost coverage'),n('dd',{},data.costs.coverage.replaceAll('_',' '))),
      p('Invoices are not cash. Deposits are not full sales. Missing costs and unverified retention stay unknown. All failed and unsold production remains in the denominator.','meta'));
    root.replaceChildren(p('Verified paid sales: not connected','meta'));
    const create=form(ctx,'Open an existing business case',[select(ctx,'Existing candidate','candidateId',state.data.candidates.map(c=>[c.id,c.name]))],'Open existing-business case',async values=>{
      const site=state.data.jobs.find(j=>j.kind==='site'&&j.input.candidateId===values.candidateId&&j.state==='review_ready'&&j.outputs.siteDigest);
      const c=await action('case_open',{candidateId:values.candidateId,...(site?{siteJobId:site.id}:{})},'Existing-business case opened. No contact or sale recorded.');if(c){location.hash='sales/'+c.id;ctx.render();}
    });
    if(state.data.candidates.length)root.append(n('details',{class:'pilot-disclosure'},n('summary',{},'Open a case for existing work'),create));
    else root.append(p('No candidate has been imported. Research/build authority is separate; this screen does not invent leads.','inline-message'));
    // The first-case action is visible without an extra disclosure step.
    if(!data.total&&state.data.candidates.length)root.querySelector('details').open=true;
    const list=n('section',{'aria-label':'Next actions',class:'next-actions'},sectionTop('Next actions',`${data.total} CASES / SORTED BY DUE DATE`));
    if(!data.items.length)list.append(ctx.empty('No sales activity invented.','Open an existing-business case, choose a responsible role and schedule the next actual review task.'));
    for(const c of data.items)list.append(n('article',{class:'action-row'},n('div',{},p(c.suppressed?'SUPPRESSED / DO NOT CONTACT':`${c.dueState.toUpperCase()} / ${c.stage.replaceAll('_',' ')}`,'meta'),n('h3',{},c.name),p(c.nextAction),p(`${c.assignee} · ${c.dueAt?ctx.stamp(c.dueAt):'No due date'}`,'meta')),button('Inspect case',()=>{location.hash='sales/'+c.id;ctx.render();},'secondary small')));
    const pagination=n('div',{class:'pilot-pagination'});if(ui.salesOffset)pagination.append(button('Previous cases',()=>{ui.salesOffset=Math.max(0,ui.salesOffset-20);ctx.render();}));if(data.nextOffset!==null)pagination.append(button('More cases',()=>{ui.salesOffset=data.nextOffset;ctx.render();}));list.append(pagination);root.append(list);
    root.append(n('details',{class:'pilot-disclosure'},n('summary',{},'Money, production and cost coverage'),summary));
    if(detail)root.append(caseDetail(ctx,detail));root.append(sensitivity(ctx));
  });}
  function caseDetail(ctx,detail){
    const {node:n,p,button,action,link,state}=ctx,c=detail.case,candidate=state.data.candidates.find(v=>v.id===c.candidateId);
    const root=n('section',{class:'case-detail','aria-label':'Sales case'},ctx.sectionTop(candidate?.name||c.id,'REPORTED WORK / NO AUTOMATIC CONTACT'),p(`Case ${c.id} · version ${c.version}`,'meta'));
    if(c.suppressed)root.append(p('Suppression is active. No new contact or handoff can be prepared.','inline-message'));
    if(c.siteJobId)root.append(link('Inspect exact site and review history ↗','#jobs/'+c.siteJobId,'action-link'),p(`Bound site ${c.siteDigest}`,'site-digest'));
    else root.append(p('No exact proposal bound yet. A review-ready same-business version is required before handoff preparation.','muted'));
    const stageOptions=['researching','building','review','waiting_owner','agreement','delivery','delivered','lost'].map(v=>[v,v.replaceAll('_',' ')]);
    const proposals=state.data.jobs.filter(j=>j.kind==='site'&&j.input.candidateId===c.candidateId&&j.state==='review_ready'&&j.outputs.siteDigest);
    const actionForm=form(ctx,'Next action editor',[
      select(ctx,'Reported stage','stage',stageOptions,c.stage),field(ctx,'Next action','nextAction',{required:true,maxlength:1500},c.nextAction),field(ctx,'Responsible role','assignee',{required:true,maxlength:80},c.assignee),field(ctx,'Due date (UTC)','dueAt',{type:'datetime-local'},c.dueAt?.slice(0,16)||''),field(ctx,'Loss reason (if lost)','lossReason',{maxlength:1500},c.lossReason||''),
      proposals.length?select(ctx,'Exact proposal version','siteJobId',[['','Keep current binding'],...proposals.map(j=>[j.id,j.outputs.siteDigest.slice(0,12)+' · '+j.id])],''):null,
    ],'Save next action',async values=>{await action('case_update',{id:c.id,version:c.version,stage:values.stage,nextAction:values.nextAction,assignee:values.assignee,dueAt:values.dueAt?new Date(values.dueAt+'Z').toISOString():null,...(values.lossReason?{lossReason:values.lossReason}:{}),...(values.siteJobId?{siteJobId:values.siteJobId}:{})},'Next action saved against the current case version.');});
    root.append(actionForm);
    if(c.siteJobId&&!c.suppressed&&c.stage!=='lost')root.append(button('Prepare exact local review packet',async e=>{const r=await action('handoff_prepare',{id:c.id,siteDigest:c.siteDigest},'Exact local packet prepared for operator inspection only. No external link or sending authority.',e);if(r)ctx.announce('Packet ready: use the download below; sending and external review access are still separate.');}),p('This prepares files locally. It does not upload, publish, contact an owner or make a localhost preview externally accessible.','meta'));
    const handoff=detail.handoffs.find(r=>r.siteDigest===c.siteDigest);if(handoff)root.append(link('Download local operator packet ↓','/files/'+handoff.artifactId,'action-link'));
    function tab(name){ui.tab=name;ui.entryOffset=0;ctx.render();}
    root.append(n('div',{class:'case-tabs'},button('Open activity log',()=>tab('activity'),ui.tab==='activity'?'primary small':'secondary small'),button('Open cost ledger',()=>tab('cost'),ui.tab==='cost'?'primary small':'secondary small'),button('Open payment observations',()=>tab('money'),ui.tab==='money'?'primary small':'secondary small')));
    if(ui.tab==='activity'){
      const id=request(),occurredAt=new Date().toISOString();root.append(form(ctx,'Reported activity',[
        select(ctx,'Activity type','kind',['note','contacted','reply','owner_review','agreement','delivery','lost','suppressed'].map(v=>[v,v.replaceAll('_',' ')]),'note'),field(ctx,'Activity note','note',{multiline:true,required:true,maxlength:1500}),field(ctx,'Activity evidence reference','reference',{pattern:'[A-Za-z0-9][A-Za-z0-9:._-]{0,119}',maxlength:120}),
      ],'Record reported activity',values=>action('case_event',{id:c.id,requestId:id,kind:values.kind,note:values.note,...(values.reference?{reference:values.reference}:{}),occurredAt},'Reported activity saved. No external action or approval performed.')));
      root.append(n('ol',{class:'pilot-history'},detail.events.map(e=>n('li',{},p(`${e.kind.replaceAll('_',' ')} · ${ctx.stamp(e.recordedAt)}`,'meta'),p(e.note)))));
    }
    if(ui.tab==='cost'){
      const id=request();root.append(p('Record cash and labor separately. Do not enter a loaded labor invoice and then count those same minutes again. Rejected research can be recorded at campaign level through the shared CLI/MCP.','muted'),form(ctx,'Cost ledger',[
        select(ctx,'Cost stage','stage',['research','media','design','model','qa','sales','delivery','overhead'].map(v=>[v,v]),'research'),field(ctx,'Cash cost (USD)','cash',{type:'number',min:0,max:1000000,step:'.01',required:true},'0'),field(ctx,'Labor minutes','minutes',{type:'number',min:0,max:100000,step:1,required:true},'0'),field(ctx,'Labor rate (USD/hour)','rate',{type:'number',min:0,max:1000000,step:'.01',required:true},'0'),
      ],'Record cost',values=>action('cost_record',{campaignId:c.campaignId,caseId:c.id,requestId:id,stage:values.stage,cashCents:money(values.cash),minutes:Number(values.minutes),hourlyRateCents:money(values.rate)},'Cash and labor observation recorded once.')));
      root.append(n('ul',{class:'pilot-history'},detail.costs.map(v=>n('li',{},p(`${v.stage} · ${usd(v.cashCents+v.laborCents)}`),p(`${v.minutes} min · ${usd(v.hourlyRateCents)}/hour · operator reported`,'meta')))));
    }
    if(ui.tab==='money'){
      const id=request(),occurredAt=new Date().toISOString();root.append(p('Observations only—not a payment processor or verified settled-sales ledger. Use opaque invoice/receipt IDs; never enter bank/card details, secrets or private URLs. Tax is included in the total, not added twice.','muted'),form(ctx,'Payment observations',[
        select(ctx,'Money entry type','kind',[['invoice','Invoice issued'],['receipt','Receipt reported'],['refund','Refund reported']],'invoice'),field(ctx,'Total including tax (USD)','amount',{type:'number',min:'.01',max:1000000,step:'.01',required:true}),field(ctx,'Tax component (USD)','tax',{type:'number',min:0,max:1000000,step:'.01',required:true},'0'),field(ctx,'Invoice or receipt reference','reference',{required:true,pattern:'[A-Za-z0-9][A-Za-z0-9:._-]{0,119}',maxlength:120}),
      ],'Record money observation',values=>action('payment_record',{id:c.id,requestId:id,kind:values.kind,amountCents:money(values.amount),taxCents:money(values.tax),reference:values.reference,occurredAt},'Money observation saved; financial verification remains unknown.')));
      root.append(n('ul',{class:'pilot-history'},detail.payments.map(v=>n('li',{},p(`${v.kind} · ${v.reference}`),p(`${usd(v.amountCents)} total · ${usd(v.taxCents)} tax · not independently verified`,'meta')))));
    }
    const ledger={activity:'events',cost:'costs',money:'payments'}[ui.tab],total={activity:detail.eventTotal,cost:detail.costTotal,money:detail.paymentTotal}[ui.tab];
    root.append(p(`${total} ${ui.tab==='activity'?'activity entries':ui.tab==='cost'?'cost records':'money observations'} · page ${Math.floor(ui.entryOffset/20)+1}`,'meta'));
    const pager=n('div',{class:'pilot-pagination'});if(ui.entryOffset)pager.append(button('Newer ledger entries',()=>{ui.entryOffset=Math.max(0,ui.entryOffset-20);ctx.render();}));if(detail.nextOffsets[ledger]!==null)pager.append(button('Older ledger entries',()=>{ui.entryOffset=detail.nextOffsets[ledger];ctx.render();}));root.append(pager);
    return root;
  }
  function sensitivity(ctx){
    const {node:n,p}=ctx,result=p('Enter your own assumptions. This is not observed conversion or profit.','inline-message');
    return n('details',{class:'pilot-disclosure'},n('summary',{},'Three-sales planning calculator · hypothetical'),form(ctx,'Hypothetical economics',[
      field(ctx,'Assumed selling price (USD)','price',{type:'number',min:1,step:'.01',required:true},'1000'),field(ctx,'Assumed retained conversion (%)','conversion',{type:'number',min:'.1',max:100,step:'.1',required:true}),field(ctx,'Pre-sale cost per start (USD)','build',{type:'number',min:0,step:'.01',required:true}),field(ctx,'Fulfillment cost per sale (USD)','fulfillment',{type:'number',min:0,step:'.01',required:true}),
    ],'Calculate hypothetical workload',async values=>{const starts=Math.ceil(3/(Number(values.conversion)/100)),contribution=3*(money(values.price)-money(values.fulfillment))-starts*money(values.build);result.textContent=`Hypothetical steady state: ${starts} starts for an average of 3 retained purchases; ${usd(contribution)} contribution before fixed overhead. Not a weekly guarantee, probability estimate or measured result.`;}),result);
  }
  function operations(ctx){return load(ctx,async root=>{
    const {node:n,p,button,op,action}=ctx;
    const [status,recovery,history]=await Promise.all([op('pilot_status'),op('snapshot_list'),op('job_history',{offset:ui.historyOffset,limit:20})]);if(!root.isConnected)return;
    root.replaceChildren(n('section',{class:'commercial-summary'},p('LOCAL FOUNDATION / EXTERNAL GATES REMAIN','kicker'),n('h2',{},'Know what is actually ready.'),p('External commercial pilot: blocked','truth-label'),p('The local app can prepare and inspect. It cannot authorize a new cohort, verify a sale or send/publish work for you.','muted')));
    const gates=n('section',{'aria-label':'Pilot readiness',class:'readiness-list'},ctx.sectionTop('Readiness, without the guesswork','EVIDENCE / NEXT ACTION'));
    for(const [i,g] of status.gates.entries())gates.append(n('article',{class:'gate-row'},p(String(i+1).padStart(2,'0'),'gate-number'),n('div',{},n('h3',{},g.id.replaceAll('_',' ')),p(g.next)),ctx.badge(g.status)));
    root.append(gates);
    const known=ctx.state.data.candidates[0];if(known)root.append(n('section',{class:'block'},n('h2',{},'Check the existing research path'),p('A bounded guest-search probe of an already-known business. No discovery/import, paid provider or website-absence inference. One idempotent probe per business/day.','muted'),button('Probe known-business search',e=>action('research_probe',{candidateId:known.id},'Known-business probe queued; source failures remain explicit holds.',e)),p(status.search.probe?`Last observation: ${status.search.probe.status} · ${status.search.probe.errorCode||status.search.probe.provider||'read report'} · ${status.search.probe.at||'date unavailable'}`:'No probe observation recorded. Native unattended discovery remains unverified.','meta')));
    const snaps=n('section',{class:'recovery-section','aria-label':'Recovery tools'},ctx.sectionTop('Versioned recovery','PRIVATE / NO IN-PLACE RESTORE'),p('Snapshots include fixed Factory code, consistent DB and jobs/reference/handoff state. They exclude credentials, node_modules, prior backups and external indexed customer roots. Stop active work first. Keep an independent off-machine backup separately.','muted'),button('Make recovery snapshot',e=>action('snapshot_create',{},'Private idle snapshot captured. Verify a fresh-root restore before relying on it.',e),'primary'));
    if(!recovery.snapshots.length)snaps.append(ctx.empty('No recovery claim without a drill.','Create a snapshot while the queue is idle, then verify it into a new private root.'));
    for(const s of recovery.snapshots)snaps.append(n('article',{class:'snapshot-row'},n('div',{},n('h3',{},`Snapshot ${s.id.slice(-12)}`),p(`${ctx.stamp(s.at)} · ${s.files} files · ${(s.bytes/1048576).toFixed(1)} MiB`,'meta'),p(`Source ${s.sourceDigest.slice(0,16)}`,'meta')),button('Verify new-root restore',async e=>{const r=await action('snapshot_restore_check',{id:s.id},'',e);if(r)ctx.announce(r.pass?'Restore drill passed; automatic work disabled.':'Restore retained, but stale artifact references need attention.',!r.pass);})));
    for(const d of recovery.drills.slice(0,3))snaps.append(p(d.pass?'Restore drill passed · automatic work disabled':'Restore integrity checked, but stale site/artifact references need attention',d.pass?'truth-label':'inline-message'),p(`${ctx.stamp(d.at)} · ${d.tablesCompared} tables · ${d.artifactReferencesChecked} artifacts · ${d.siteReferencesChecked??'not checked in older drill'} sites · ${d.staleOrMissingArtifactIds.length+(d.staleOrMissingSiteJobIds?.length||0)} stale/missing`,'meta'));
    for(const f of recovery.failures.slice(0,2))snaps.append(p(`Retained snapshot failure: ${f.errorCode} · ${ctx.stamp(f.at)}`,'inline-message'));root.append(snaps);
    const historySection=n('section',{class:'history-section','aria-label':'Full job history'},ctx.sectionTop('Full job history',`${history.total} JOBS / PAGE ${Math.floor(ui.historyOffset/20)+1}`));
    for(const j of history.items)historySection.append(n('article',{class:'history-row'},n('div',{},n('h3',{},`${j.kind} / ${j.stage}`),p(j.message),p(j.recoverySuggestion,'meta'),ctx.link('Inspect exact work record ↗','#jobs/'+j.id,'action-link')),ctx.badge(j.state)));
    if(!history.items.length)historySection.append(ctx.empty('No hidden work.','Full SQL history will appear here, including older blocked and completed jobs.'));
    const pager=n('div',{class:'pilot-pagination'});if(ui.historyOffset)pager.append(button('Previous history page',()=>{ui.historyOffset=Math.max(0,ui.historyOffset-20);ctx.render();}));if(history.nextOffset!==null)pager.append(button('Next history page',()=>{ui.historyOffset=history.nextOffset;ctx.render();}));historySection.append(pager);root.append(historySection);
  });}
  return Object.freeze({sales,operations});
})();
