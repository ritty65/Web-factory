/* Literal DOM construction: source/model/business text never becomes HTML. */
const $ = s => document.querySelector(s);
const state = { data: null, session: null, selectedJob: null, filter: '', query: '', kind: 'site', reviewDevice: 1440, reviewPage: 'index', drafts: {}, doctor: null, refreshing: false };
const views = { jobs: ['RESEARCH. CRAFT. REVIEW.', 'Production desk', 'From a real business to a considered website. With the evidence attached.'], businesses: ['THE BUSINESS, BEFORE THE BUILD.', 'People & places', 'Existing work and newly researched candidates. Facts, unknowns and real sources stay together.'], references: ['PRINCIPLES, NOT TEMPLATES.', 'A reference shelf', 'Your work, inspected in the browser. Reuse the craft, never just recolor the composition.'], assets: ['REAL SUBJECTS. LOCAL FILES.', 'The asset room', 'Business-posted photographs, original provenance and private-preview use. No hotlinks, no invented portfolios.'], integrations: ['CONNECTED, OR HONESTLY NOT.', 'Behind the desk', 'One local backend for this app, the CLI and OpenCode. Dependencies stay visible.'] };
views.setup=['','Setup & API keys','Private connections, tested capabilities and one shared allowance.'];
views.autopilot=['','Automatic drafts','Source-backed private proposals with spending and review controls.'];
views.intake=['','Business intake','A practical brief, your photographs, and one private proposal.'];
views.opportunities=['','Lead workspace','Source-backed pointers, explicit evidence and clear next actions.'];
views.sales=['BUILD THE WORK. EARN THE BUSINESS.','Sales desk','The next actual action, the complete costs, and reported outcomes. No invented pipeline.'];
views.operations=['CONTROLLED. RECOVERABLE. HONEST.','Operations','Know the blockers. Inspect the history. Restore into a new root before you trust the backup.'];
views.start=['','Find your next website customer','Find leads, choose one business, then review its private website.'];
views.inbox=['','Your websites','Open the real work. A preview is not an accepted or published website.'];
views.leads=['','Choose a business','A short list for full checks before design. Uncertain results stay separate.'];
views.review=['','Your website','Review the design and try the actual interactions before deciding.'];
function node(tag, attrs = {}, ...children) { const n = document.createElement(tag); for (const [key, value] of Object.entries(attrs)) { if (value === null || value === undefined || value === false) continue; if (key === 'class') n.className = value; else if (key.startsWith('on') && typeof value === 'function') n.addEventListener(key.slice(2), value); else n.setAttribute(key, String(value)); } for (const c of children.flat(Infinity)) { if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c))); } return n; }
const p = (text, className = '') => node('p', { class: className }, text);
const button = (text, action, className = 'secondary small') => node('button', { type: 'button', class: className, onclick: action }, text);
const badge = value => node('span', { class: `state ${['blocked', 'failed', 'running', 'review_ready', 'cancelled'].includes(value) ? value : ''}` }, value);
const stamp = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not yet observed';
const excerpt = (value, max = 240) => value.length > max ? value.slice(0, max).replace(/\s+\S*$/, '') + '…' : value;
function link(text, href, className = '') { try { const u = new URL(href, location.origin); if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === '127.0.0.1') || u.username || u.password) throw new Error(); return node('a', { href: u.href, ...(u.origin !== location.origin ? { target: '_blank', rel: 'noopener noreferrer' } : {}), class: className }, text); } catch { return node('span', {}, text); } }
function announce(text, error = false) { $('#notice').textContent = text; $('#notice').setAttribute('role', error ? 'alert' : 'status'); clearTimeout(announce.timer); announce.timer = setTimeout(() => { $('#notice').textContent = ''; }, error ? 12000 : 6000); }
let sessionRefresh = null;
async function renewSession(rejectedCsrf) {
  // A late rejection of an older token can reuse another operation's renewal.
  if (rejectedCsrf && state.session?.csrf !== rejectedCsrf) return state.session;
  if (!sessionRefresh) sessionRefresh = (async () => {
    const response = await fetch('/api/session', { cache: 'no-store' });
    if (!response.ok) throw new Error('Local session unavailable');
    const session = await response.json();
    let preview;
    try { preview = new URL(session?.previewOrigin); } catch { /* invalid session below */ }
    const localPreview=preview?.protocol==='http:'&&preview.hostname==='127.0.0.1';
    const hostedPreview=location.protocol==='https:'&&preview?.protocol==='https:'&&preview.origin!==location.origin&&!preview.username&&!preview.password;
    if (typeof session?.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(session.csrf) || !preview || !(localPreview||hostedPreview) || preview.origin !== session.previewOrigin) throw new Error('Invalid local session response');
    state.session = session;
    return session;
  })().finally(() => { sessionRefresh = null; });
  return sessionRefresh;
}
async function op(operation, input = {}, source) {
  if (source) source.disabled = true;
  try {
    const body = JSON.stringify({ operation, input });
    if (!state.session) await renewSession();
    for (let attempt = 0; attempt < 2; attempt++) {
      const csrf = state.session.csrf;
      const response = await fetch('/api/op', { method: 'POST', headers: { 'content-type': 'application/json', 'x-factory-csrf': csrf }, body });
      const data = await response.json();
      // Only this explicit server guard rejects BEFORE dispatch. Network loss,
      // other 403s and post-commit failures must never replay a mutation here.
      if (attempt === 0 && response.status === 403 && data.error === 'CSRF') { await renewSession(csrf); continue; }
      if (!response.ok) { const error = new Error(data.message || 'Operation could not be completed'); error.code = data.error || null; throw error; }
      return data;
    }
  } catch (e) { announce(e.message, true); throw e; }
  finally { if (source) source.disabled = false; }
}
async function action(operation, input, message, event) { try { const result = await op(operation, input, event?.currentTarget); if (message) announce(message); await refresh(); return result; } catch { return null; } }
function sectionTop(title, meta) { return node('div', { class: 'section-top' }, node('h2', {}, title), node('span', { class: 'meta' }, meta || '')); }
function empty(title, message) { return node('div', { class: 'empty' }, node('strong', {}, title), message); }
function fileLink(artifact, label) { return link(label || artifact.label, `/files/${artifact.id}`, 'action-link'); }
function libraryPhoto(business) { const roots = Object.values(business.folders || {}); return state.data.libraryFiles.find(f => f.kind === 'photo' && roots.includes(f.root)); }
function jobName(job) { const lead = state.data.candidates.find(c => c.id === job.input.candidateId || c.id === job.input.recheckCandidateId); const ref = state.data.references.find(r => r.id === job.input.referenceId); const campaign = state.data.campaigns.find(c => c.id === job.campaignId); return lead?.name || ref?.name || campaign?.name || (job.kind === 'vault' ? 'Preview Vault connection' : job.kind); }
async function inspectJob(job,route='jobs') { try { const result = await op('job_get', { id: job.id }); state.selectedJob = result; location.hash = `${route}/${job.id}`; render(); const target = result.job.kind === 'site' && result.job.outputs.siteRelative ? $('#review-workspace') : $('#job-detail'); target?.focus({ preventScroll: true }); if (target?.id === 'review-workspace') target.scrollIntoView({ block: 'start', behavior: 'instant' }); } catch { /* announced */ } }
function renderJobs() {
  const data = state.data, root = node('div');
  root.append(node('div', { class: 'status-strip' }, node('span', {}, node('b', {}, data.jobs.filter(j => j.state === 'running').length), 'working'), node('span', {}, node('b', {}, data.jobs.filter(j => j.state === 'queued').length), 'queued'), node('span', {}, node('b', {}, data.jobs.filter(j => j.kind === 'site' && j.state === 'review_ready').length), 'proposals for review'), node('span', {}, node('b', {}, data.jobs.filter(j => ['blocked', 'failed'].includes(j.state)).length), 'need attention')));
  const queue = node('section', { class: 'queue', 'aria-label': 'Production queue' });
  queue.append(sectionTop('The queue', 'PERSISTED / RESUMABLE'));
  const search = node('input', { class: 'search', type: 'search', placeholder: 'Find a job or business', 'aria-label': 'Search jobs', value: state.query, oninput: e => { state.query = e.target.value; updateJobList(); } });
  const filter = node('select', { 'aria-label': 'Job status', onchange: e => { state.filter = e.target.value; updateJobList(); } }, [['', 'All states'], ['running', 'Working'], ['queued', 'Queued'], ['blocked', 'Needs attention'], ['review_ready', 'Review ready'], ['cancelled', 'Cancelled']].map(([value, title]) => node('option', { value, selected: state.filter === value }, title)));
  const tabs = node('div', { class: 'queue-tabs', 'aria-label': 'Job type' }, [['site', 'Website proposals'], ['evidence', 'Research & sources']].map(([kind, label]) => node('button', { type: 'button', 'aria-pressed': state.kind === kind, onclick: () => { state.kind = kind; render(); } }, `${label} · ${data.jobs.filter(j => (j.kind === 'site') === (kind === 'site')).length}`)));
  const list = node('div', { class: 'job-list', id: 'job-list' }); queue.append(tabs, node('div', { class: 'toolbar' }, search, filter), list);
  function updateJobList() { const jobs = data.jobs.filter(j => (j.kind === 'site') === (state.kind === 'site') && (!state.filter || (state.filter === 'blocked' ? ['blocked', 'failed'].includes(j.state) : j.state === state.filter)) && `${jobName(j)} ${j.message} ${j.kind}`.toLowerCase().includes(state.query.toLowerCase())); list.replaceChildren(...(jobs.length ? jobs.map(job => node('article', { class: 'job-row' }, node('div', {}, p(`${job.input.polishOf ? 'SITE POLISH' : job.input.parentSiteJobId ? 'SITE REVISION' : job.kind.toUpperCase()} / ${job.stage}`, 'meta'), node('h3', {}, jobName(job)), p(job.message)), badge(job.state), node('div', { class: 'job-bottom' }, node('span', { class: 'meta' }, `${stamp(job.updatedAt)} · attempt ${job.attempt + 1}`), button('Inspect job', () => inspectJob(job), 'text-button')))) : [empty('A clean workbench.', state.query || state.filter ? 'No jobs match this view. Change the search or status.' : state.kind === 'site' ? 'Completed website proposals appear here, separate from source checks. Research a qualified lead before requesting a build.' : 'Research and source observations are evidence, not completed websites.')])); }
  updateJobList();
  const bench = state.selectedJob ? renderJobDetail(state.selectedJob) : renderBench();
  if (state.selectedJob?.job.kind === 'site' && state.selectedJob.job.outputs.siteRelative) root.append(renderReviewWorkspace(state.selectedJob));
  root.append(node('div', { class: 'desk-grid' }, queue, bench));
  const campaigns = node('section', { class: 'campaign-list' }, sectionTop('Campaigns', `${data.campaigns.length} bounded run${data.campaigns.length === 1 ? '' : 's'}`));
  for (const c of data.campaigns) campaigns.append(node('article', { class: 'campaign-row' }, node('div', {}, node('h3', {}, c.name), p(`${c.area} / ${c.niche}`, 'muted'), p(`${c.candidateLimit} candidates maximum · ${c.buildLimit} private build${c.buildLimit === 1 ? '' : 's'} · ${c.concurrency} at once · ${c.deadlineMinutes} min · ${c.autoBuild ? 'automatic qualified builds' : 'review leads before building'}`, 'meta')), button('Research leads', e => { state.kind = 'evidence'; return action('discover', { campaignId: c.id }, 'Research queued. Watch the persisted stage history.', e); })));
  if (!data.campaigns.length) campaigns.append(p('Start small: one geography, one niche, one well-considered private canary.', 'muted'));
  root.append(campaigns); return root;
}
function renderBench() {
  const latest = state.data.jobs.find(j => j.kind === 'site' && j.outputs.siteRelative);
  const photo = latest && captureFor(latest, state.data.siteCaptures || [], 'index', 1440);
  return node('aside', { class: 'bench', 'aria-label': 'On the bench' }, p('ON THE BENCH', 'kicker'), node('h2', {}, latest ? jobName(latest) : 'Built to be reviewed.'), photo ? node('img', { src: `/files/${photo.id}`, alt: 'Latest actual proposal capture', loading: 'lazy' }) : null, latest ? badge(latest.outputs.reviewStatus || latest.state) : null, p(latest ? excerpt(latest.outputs.brief || latest.message) : 'The brief, photographs, actual QA and exact ZIP travel with the work. A technical pass never becomes a human verdict.'), latest ? button('Review latest site', () => inspectJob(latest), 'primary') : link('Inspect your reference shelf ↗', '#references', 'action-link'), latest ? link('Open isolated proposal ↗', `${state.session.previewOrigin}/site/${latest.id}/index.html`, 'action-link') : null, p('Next: inspect desktop, phone and interaction. Human acceptance remains pending; nothing is published.', 'meta'));
}
function captureFor(job, artifacts, file = 'index', width = 1440) {
  const root = job.outputs.qaRelative || `jobs/${job.id}/attempt-${job.attempt}/qa-${(job.outputs.proposalVersions || 1) - 1}`;
  return artifacts.find(a => a.kind === 'site_capture' && a.relative === `${root}/${file}-first-${width}.png`) || artifacts.find(a => a.kind === 'site_capture' && a.relative === `${root}/${file}-${width}.png`);
}
// Retain the exact submitted intent across rerenders and ambiguous network loss.
// A second explicit click can replay it; never mint a replacement after dispatch.
const studyContinuationIntents = new Map();
async function continuePassingStudy(job, artifact, event) {
  const source = event.currentTarget, key = `${job.id}:${artifact.sha256}`;
  if (source.disabled) return;
  source.disabled = true;
  try {
    const overview = await op('batch_status', { limit: 20 });
    if (!/^[a-f0-9]{64}$/.test(overview.currentPolicyDigest || '')) throw new Error('Current production policy unavailable. No continuation submitted.');
    if (!studyContinuationIntents.has(key)) studyContinuationIntents.set(key, {
      id: job.id, renderDigest: artifact.sha256, policyDigest: overview.currentPolicyDigest,
      requestId: `study-continue-${crypto.randomUUID()}`, authorized: true,
    });
    const result = await action('study_continue', studyContinuationIntents.get(key), null, event);
    if (result) announce(result.replayed ? 'Existing study continuation retrieved. Inspect the saved job for its current state. Nothing has been accepted or published.' : 'Study continuation queued. This is not a finished or accepted website.');
  } catch (e) { announce(e.message, true); }
  finally { source.disabled = false; }
}
function renderJobDetail(record) {
  const job = state.data.jobs.find(j => j.id === record.job.id) || record.job;
  const studyArtifact = job.kind === 'site' && job.state === 'blocked' && job.errorCode === 'DESIGN_STUDY_QA' && job.stage === 'directions-render' && job.attempt === 0 && !job.directionRepair && !job.studyContinuation && !job.input.parentSiteJobId && !job.input.polishOf && !job.input.reuseStudyJobId
    ? record.artifacts.find(a => a.kind === 'directions' && a.relative === `jobs/${job.id}/attempt-0/directions/results.json` && /^[a-f0-9]{64}$/.test(a.sha256 || '')) : null;
  const detail = node('aside', { id: 'job-detail', tabindex: '-1', class: 'bench', 'aria-label': 'Job detail' }, node('div', { class: 'section-top' }, p('WORK RECORD', 'kicker'), button('Close detail', () => { state.selectedJob = null; location.hash = 'jobs'; render(); }, 'text-button')), badge(job.state), p(job.kind.toUpperCase(), 'stage-label'), node('h3', {}, jobName(job)), p(job.message));
  if (job.kind === 'site') detail.append(node('div', { class: 'progress-track' }, ['brief', 'directions', 'selection', 'proposal', 'qa', 'critique', 'package'].map(s => node('span', { class: job.stage.startsWith(s) ? 'active' : '' }, s))));
  const capture = captureFor(job, record.artifacts); if (capture) detail.append(node('img', { src: `/files/${capture.id}`, alt: 'Current exact-version rendered homepage capture' }));
  if (job.outputs.siteRelative) detail.append(link('Open isolated private proposal ↗', `${state.session.previewOrigin}/site/${job.id}/index.html`, 'secondary'));
  if (job.outputs.shortfall) detail.append(p(job.outputs.shortfall, 'inline-message'));
  if (job.outputs.archiveId) detail.append(link('Download exact review ZIP ↓', `/files/${job.outputs.archiveId}`, 'primary'));
  if (['queued', 'running'].includes(job.state)) detail.append(button('Cancel job', e => action('job_cancel', { id: job.id }, 'Job cancelled. Existing artifacts are retained.', e)));
  if (!studyArtifact && ['failed', 'blocked', 'cancelled'].includes(job.state) && job.attempt < job.retryLimit) detail.append(button('Retry job', e => action('job_retry', { id: job.id }, 'One bounded retry queued.', e)));
  if (studyArtifact) detail.append(button('Continue with a passing design', e => continuePassingStudy(job, studyArtifact, e), 'primary'), p('Failed alternatives stay rejected. Only passing desktop/phone designs can be selected. Uses the same job, original deadline and remaining allowance.', 'meta'));
  if (job.state === 'blocked' && job.errorCode === 'DESIGN_SELECTION' && !job.directionRepair) {
    const selection = record.artifacts.find(a => a.kind === 'selection');
    if (selection) detail.append(button('Repair selected direction', e => action('direction_repair', { id: job.id, selectionDigest: selection.sha256 }, 'The existing single creative budget is assigned to direction repair. Old studies stay preserved.', e), 'primary'), p('Uses the same job and deadline, not another revision allowance. Fresh rendering and selection must pass before the full build.', 'meta'));
  }
  if (['failed', 'blocked', 'cancelled'].includes(job.state) && job.attempt >= job.retryLimit) detail.append(p(studyArtifact ? 'No general retry. The specific study continuation remains subject to backend evidence, deadline and allowance checks.' : 'Retry ceiling reached. Inspect the failure before requesting any new work.', 'meta'));
  detail.append(node('ul', { class: 'events' }, record.events.slice(-8).map(event => node('li', {}, node('time', { datetime: event.at }, stamp(event.at)), event.message))));
  const files = record.artifacts.filter(a => ['qa', 'brief', 'manifest', 'package', 'selection', 'critique', 'directions'].includes(a.kind)); if (files.length) detail.append(node('div', { class: 'files' }, files.map(a => fileLink(a))));
  return detail;
}
function reviewCheckpoint(job) {
  const slot = node('div', { 'data-review-checkpoint-loading': '', class: 'files' });
  (async () => {
    try {
      const overview = await op('batch_status', { limit: 20 });
      // Resolve by the saved campaign, never by a parent site's or latest run's ID.
      const summary = overview.items.find(b => b.campaignId === job.campaignId && ['awaiting_first_review', 'held'].includes(b.state) && !b.checkpoint);
      if (!summary || !slot.isConnected) return;
      const detail = await op('batch_get', { id: summary.id }), b = detail.batch;
      if (!slot.isConnected) return;
      const item = detail.items.find(item => item.candidate.id === b.firstCandidateId);
      const first = detail.jobs.filter(j => j.kind === 'site' && j.input.candidateId === b.firstCandidateId && j.state === 'review_ready').at(-1);
      const changesHeld = item?.disposition === 'needs_changes' && (item.dispositionSiteJobId === job.id || !job.input.parentSiteJobId);
      if (b.campaignId !== job.campaignId || !['awaiting_first_review', 'held'].includes(b.state) || b.checkpoint || item?.job?.id !== job.id || first?.id !== job.id || job.input.candidateId !== b.firstCandidateId) return;
      if (first.outputs.siteDigest !== job.outputs.siteDigest || detail.currentPolicyDigest !== b.policyDigest) {
        slot.append(p('Run review is held: the exact site digest or production policy changed. Refresh and inspect the saved run before reviewing again. No checkpoint or automatic retry was submitted.', 'inline-message')); return;
      }
      if (!(Date.now() < Date.parse(b.deadlineAt)) || !item.ready || item.suppressed || item.disposition === 'not_a_fit' || changesHeld || job.state !== 'review_ready' || job.outputs.qaPass !== true || first.outputs.qaPass !== true || job.outputs.reviewStatus !== 'operator_review_required' || first.outputs.reviewStatus !== 'operator_review_required' || !job.outputs.siteDigest) return;
      slot.append(link('Return to run review', '#start/' + b.id + '/checkpoint', 'secondary'), p('After reviewing this exact website, finish the existing human checkpoint in its run. Feedback is not acceptance or publication.', 'meta'));
    } catch (e) {
      if (slot.isConnected) slot.append(p('Run review could not be checked: ' + e.message + '. Refresh to read the saved run; no checkpoint or retry was submitted.', 'inline-message'));
    } finally { slot.removeAttribute('data-review-checkpoint-loading'); }
  })();
  return slot;
}
// One in-memory intent per exact parent. Dashboard/device rerenders and uncertain
// responses must never replace a dispatched request with a new identity.
const designWorkbenchDrafts = new Map();
function canOpenDesignWorkbench(job) {
  return job.kind === 'site' && job.outputs.qaPass === true && job.outputs.siteRelative && (/^[a-f0-9]{64}$/.test(job.outputs.siteDigest || '') || !job.outputs.siteDigest && job.outputs.qaRelative) && !job.input.assistedRevisionId && !job.outputs.assistedRevisionId && !job.assistedRevisionId &&
    (job.state === 'blocked' && job.outputs.reviewStatus === 'creative_rework_required' || job.state === 'review_ready' && job.outputs.reviewStatus === 'operator_review_required');
}
function renderDesignWorkbench(job) {
  const key = `${job.id}:${job.outputs.siteDigest || job.outputs.qaRelative}`;
  if (!designWorkbenchDrafts.has(key)) designWorkbenchDrafts.set(key, { open: false, context: null, feedback: '', selected: new Set(), authorized: false, intent: null, pending: false, message: '' });
  const draft = designWorkbenchDrafts.get(key), root = node('section', { 'data-design-workbench': '', class: 'version-notes', style: 'min-width:0;overflow-wrap:anywhere' });
  const draw = () => {
    root.replaceChildren(node('h3', {}, 'Improve this site'), p('Create a separate private version from feedback and retained source material. The rejected site and its history stay preserved. This is not acceptance or publication.', 'muted'));
    if (!draft.open) {
      root.append(button(job.state === 'blocked' ? 'Redesign from feedback' : 'Improve this site', () => readContext(true), 'primary'));
      return;
    }
    root.append(link(job.state === 'blocked' ? 'Open rejected parent private preview ↗' : 'Open parent private preview ↗', `${state.session.previewOrigin}/site/${job.id}/index.html`, 'action-link'));
    const refreshButton = button('Refresh saved context', () => readContext(false));
    refreshButton.disabled = draft.pending;
    root.append(p('Only saved observations are read here. Opening or refreshing this panel does not research, generate, or change source truth.', 'meta'), refreshButton);
    if (draft.message) root.append(node('p', { class: 'inline-message', role: 'status', 'aria-live': 'polite' }, draft.message));
    const context = draft.context;
    if (!context) return;
    // A held pre-package parent may not yet have outputs.siteDigest. Only the
    // host may derive/verify its exact bytes from the registered passing QA.
    const exact = context.id === job.id && /^[a-f0-9]{64}$/.test(context.siteDigest || '') && (!job.outputs.siteDigest || context.siteDigest === job.outputs.siteDigest) && /^[a-f0-9]{64}$/.test(context.policyDigest || '');
    const ready = context.assessment?.ready === true && exact && (!draft.intent || draft.intent.policyDigest === context.policyDigest);
    if (exact) root.append(p('Host-verified parent version', 'meta'), node('code', { class: 'site-digest' }, context.siteDigest));
    const labels = { modelCalls: 'Model calls', modelRequests: 'Native production launches', nativeLaunches: 'Native launches', modelCallLimit: 'Model call limit', minutes: 'Remaining clock (minutes)', deadlineAt: 'Original batch deadline', batchDeadlineAt: 'Original batch deadline', remainingMs: 'Remaining clock (ms)', wallClockMs: 'Clock (ms)' };
    const values = (title, data) => {
      const rows = Object.entries(data || {}).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value));
      return node('div', {}, node('h4', {}, title), rows.length ? node('dl', {}, rows.flatMap(([name, value]) => [node('dt', {}, labels[name] || name.replace(/([A-Z])/g, ' $1').replaceAll('_', ' ')), node('dd', {}, value)])) : p('Not reported by the saved context.', 'meta'));
    };
    root.append(values('Saved scope & original deadline', context.scope), values('Already used', context.usage), values('Remaining limits', context.remaining), p(`Revisions already recorded: ${context.revisionCount ?? 'not reported'}. No allowance or deadline is reset.`, 'meta'));
    if (!ready) root.append(p('Revision held. The host has not cleared this exact version and policy for redesign.', 'inline-message'));
    if (context.assessment?.reasons?.length) root.append(node('ul', { class: 'facts' }, context.assessment.reasons.map(reason => node('li', {}, reason))));
    const limitations = Array.isArray(context.limitations) ? context.limitations : context.limitations ? [context.limitations] : [];
    if (limitations.length) root.append(node('div', {}, node('h4', {}, 'Known limitations'), node('ul', { class: 'facts' }, limitations.map(text => node('li', {}, text)))));
    const locked = Boolean(draft.intent) || draft.pending;
    const feedback = node('textarea', { id: `design-feedback-${job.id}`, 'aria-label': 'What should change?', required: true, minlength: 8, maxlength: 3000, disabled: locked, style: 'width:100%;max-width:100%;box-sizing:border-box', oninput: e => { draft.feedback = e.target.value; updateSubmit(); } });
    feedback.value = draft.feedback;
    const choices = node('fieldset', { style: 'min-width:0;max-width:100%;box-sizing:border-box' }, node('legend', {}, 'Supporting factual content'), p('Choose only the captured facts useful to this revision. Unchecked means not selected. A selection does not verify source truth, prices, ownership or qualifications.', 'meta'));
    for (const [index, fact] of (context.availableFacts || []).entries()) {
      const identity = JSON.stringify([fact.sourceId, fact.excerpt, fact.text]);
      const check = node('input', { id: `design-fact-${job.id}-${index}`, type: 'checkbox', checked: draft.selected.has(identity), disabled: locked, onchange: e => { e.target.checked ? draft.selected.add(identity) : draft.selected.delete(identity); } });
      choices.append(node('div', { class: 'version-notes' }, node('label', { for: check.id }, check, fact.text), node('blockquote', {}, fact.excerpt), p(`Captured source: ${fact.sourceId}`, 'meta'), link('Read source attribution ↗', fact.sourceUrl, 'action-link')));
    }
    if (!context.availableFacts?.length) choices.append(p('No supported content options were returned. No facts or photos have been invented.', 'meta'));
    const authorization = node('input', { id: `design-authorize-${job.id}`, type: 'checkbox', checked: draft.authorized, disabled: locked, required: true, onchange: e => { draft.authorized = e.target.checked; updateSubmit(); } });
    const submit = node('button', { type: 'submit', class: 'primary' }, draft.intent ? 'Retry same revision request' : 'Generate private revision');
    function updateSubmit() { submit.disabled = draft.pending || !ready || !draft.authorized || draft.feedback.trim().length < 8; }
    const form = node('form', { class: 'review-feedback', onsubmit: async event => {
      event.preventDefault();
      if (submit.disabled || draft.pending || !ready || !form.reportValidity()) return;
      if (!draft.intent) draft.intent = {
        id: job.id, siteDigest: context.siteDigest, policyDigest: context.policyDigest, requestId: `assisted-redesign-${crypto.randomUUID()}`, authorized: true, feedback: draft.feedback,
        contentFacts: (context.availableFacts || []).filter(fact => draft.selected.has(JSON.stringify([fact.sourceId, fact.excerpt, fact.text]))).map(({ sourceId, excerpt, text }) => ({ sourceId, excerpt, text })),
      };
      draft.pending = true; draft.message = 'Submitting the explicit private revision request…'; draw();
      try {
        const result = await op('assisted_redesign', draft.intent);
        if (!result?.job?.id) throw new Error('The response did not identify a saved revision.');
        draft.message = ['queued', 'running'].includes(result.job.state) ? 'Generating a private revision. The parent remains preserved; human review is still pending.' : 'Saved revision retrieved. Inspect its actual state; nothing has been accepted or published.';
        announce(draft.message); state.kind = 'site'; state.filter = ''; state.query = '';
        await refresh(); await inspectJob(result.job);
      } catch (error) {
        draft.message = `Response uncertain or request held: ${error.message}. No automatic retry. The submitted feedback and choices are locked; refresh saved context to inspect status, or explicitly retry the identical request. Never create a replacement request while this outcome is unresolved.`;
      } finally { draft.pending = false; if (draft.root.isConnected) { draft.draw(); draft.root.querySelector('button[type=submit]:not(:disabled)')?.focus(); } }
    } }, node('label', { for: feedback.id }, 'What should change?'), feedback, choices, node('label', { for: authorization.id, class: 'budget-acknowledgement' }, authorization, 'Authorize one private revision within the saved remaining limits'), p('Authorization is for one private revision only, not a human verdict, owner approval, publication or a quality guarantee.', 'meta'), submit);
    updateSubmit(); root.append(form);
  };
  async function readContext(focus) {
    if (draft.pending) return;
    draft.open = true; draft.pending = true; draft.message = 'Reading retained design context…'; draw();
    try {
      draft.context = await op('design_context_get', { id: job.id });
      draft.message = draft.intent ? 'Saved context refreshed. The previously submitted intent is preserved; any retry uses the identical request.' : '';
    } catch (error) { draft.context = null; draft.message = `Saved context unavailable: ${error.message}. No revision submitted.`; }
    finally { draft.pending = false; if (draft.root.isConnected) { draft.draw(); (focus ? draft.root.querySelector('textarea') : draft.root.querySelector('button'))?.focus(); } }
  }
  draft.root = root; draft.draw = draw;
  draw(); return root;
}
function renderReviewWorkspace(record,{simple=false}={}) {
  // job_get is the exact record just read for this version. An older dashboard
  // snapshot must not overwrite its state/digest when opening or switching views.
  const job = record.job;
  const pages = [...new Set(record.artifacts.filter(a => a.kind === 'site_capture').map(a => a.relative.split('/').pop()).filter(name => /^(?!.*(?:dialog|scroll))[a-z0-9][a-z0-9_-]*-(?:first-)?(?:1440|390)\.png$/i.test(name)).map(name => name.replace(/-(?:first-)?(?:1440|390)\.png$/, '')))];
  if (!pages.includes(state.reviewPage)) state.reviewPage = pages.includes('index') ? 'index' : pages[0] || 'index';
  const root = node('section', { id: 'review-workspace', tabindex: '-1', class: 'review-workspace'+(simple?' simple-review':''), 'aria-label': 'Version review' }, simple?node('h2',{},jobName(job)):sectionTop('Review the exact work', job.input.parentSiteJobId ? 'ISOLATED REVISION / PARENT PRESERVED' : 'PRIVATE PROPOSAL'));
  const gates=node('div', { class: 'review-gates' }, p(`Technical: ${job.outputs.qaPass === true ? 'passed in the recorded environment' : 'pending or needs repair'}`), p(`Creative: ${job.outputs.reviewStatus || 'in progress'}`), p(record.operatorReview?'Operator reported: '+record.operatorReview.verdict.replaceAll('_',' ')+' · public release: false':'Human verdict: pending · public release: false'));
  const exact=[gates,job.outputs.siteDigest?p('Exact current site digest','meta'):null,job.outputs.siteDigest?node('code',{class:'site-digest'},job.outputs.siteDigest):null];
  if(simple)root.append(p(job.state==='review_ready'&&job.outputs.reviewStatus==='operator_review_required'?'Ready for your review. Nothing has been accepted or published.':'Work in progress or held. This is not a finished website.','truth-label'),
    node('div',{class:'files review-open'},link('Open interactive website',`${state.session.previewOrigin}/site/${job.id}/${state.reviewPage}.html`,'primary'),job.state==='review_ready'&&job.outputs.qaPass===true&&job.outputs.archiveId?link('Download website ZIP','/files/'+job.outputs.archiveId,'secondary'):null),
    p('Desktop and Phone below show recorded QA screenshots. Open the interactive website to try its navigation and controls.','muted'),node('details',{},node('summary',{},'Version & check details'),exact,link('Technical work record','#jobs/'+job.id,'action-link')));
  else root.append(...exact.filter(Boolean));
  if(job.outputs.effectsPlan){
    const labels={'magnetic':'Magnetic buttons','sticky-stack':'Sticky service cards','split-text':'Split-text reveals','clip-reveal':'Image/section reveals','drag-gallery':'Draggable gallery','split-chars':'Character typography','image-trail':'Project image trails','distortion':'Responsive image distortion','scroll-scene':'Layered scroll scene'};
    const plan=job.outputs.effectsPlan,checks=job.outputs.effectsChecks||[],passed=checks.filter(c=>c.pass).length;
    const shelf=node('details',{class:'block'},node('summary',{},'Effects & browser checks'),p(job.outputs.effectsVerification==='local_browser_checked'?`${passed}/${checks.length} page/viewport effect checks passed in local Chromium.`:'Effect checks are pending or held.','meta'),p(job.outputs.modelVerification==='live_api'?'Model calls used the live provider transport. Your design verdict is still required.':'Model verification is injected or unverified. This is not proof of live AI quality.','meta'),node('ul',{class:'facts'},plan.effects.map(e=>node('li',{},node('strong',{},labels[e.type]||e.type),' · '+e.page,p(e.purpose),p('Fallback: '+e.fallback,'meta')))),p('Three to five distinct families. Phone, touch and reduced-motion behavior may be simpler. Real booking, forms and payment systems need separate integrations.','meta'));
    const effectCaptures=record.artifacts.filter(a=>a.kind==='site_capture'&&a.relative.startsWith(job.outputs.qaRelative+'/')&&/-effect-/.test(a.relative));
    if(effectCaptures.length)shelf.append(node('div',{class:'files'},effectCaptures.map(a=>fileLink(a,'View '+a.relative.split('/').pop().replace('.png','')+' capture'))));
    const failed=checks.flatMap(c=>c.checks.filter(v=>!v.pass).map(v=>c.file+' '+c.viewport[0]+'px: '+v.name));if(failed.length)shelf.append(node('ul',{},failed.map(f=>node('li',{},f))));
    root.append(shelf);
  }
  if(job.outputs.creativeIntent)root.append(node('details',{class:'block'},node('summary',{},'Design direction & reference evidence'),node('dl',{},Object.entries(job.outputs.creativeIntent).flatMap(([k,v])=>[node('dt',{},k.replace(/([A-Z])/g,' $1')),node('dd',{},v)])),p('Reference packet: '+job.outputs.referenceDigest,'meta'),p(job.outputs.designEvidence?'Homepage and full-page AI comparisons are retained. Your exact-version verdict is still required.':'Creative review is pending or held.','meta')));
  const device=width=>{state.reviewDevice=width;render();document.querySelector('#review-workspace .review-controls [aria-pressed=true]')?.focus({preventScroll:true});};
  const desktop=button('Desktop', () => device(1440), state.reviewDevice === 1440 ? 'primary small' : 'secondary small'),phone=button('Phone', () => device(390), state.reviewDevice === 390 ? 'primary small' : 'secondary small');
  desktop.setAttribute('aria-pressed',String(state.reviewDevice===1440));phone.setAttribute('aria-pressed',String(state.reviewDevice===390));
  const controls = node('div', { class: 'review-controls' }, desktop,phone);
  if (pages.length) controls.append(node('label', {}, 'Page ', node('select', { 'aria-label': 'Review page', onchange: e => { state.reviewPage = e.target.value; render(); document.querySelector('#review-workspace [aria-label="Review page"]')?.focus({preventScroll:true}); } }, pages.map(name => node('option', { value: name, selected: state.reviewPage === name }, name)))));
  root.append(controls);
  const comparison = node('div', { class: `version-comparison ${state.reviewDevice === 390 ? 'phone-comparison' : ''}` });
  for (const [version, label] of [[record.comparison, 'Previous exact version'], [record, 'Current proposal']]) {
    if (!version || simple && version!==record) continue;
    const v = version.job, image = captureFor(v, version.artifacts, state.reviewPage, state.reviewDevice), figure = node('figure', {}, node('figcaption', {}, node('strong', {}, label), node('code', {}, v.outputs.siteDigest?.slice(0, 12) || 'Not frozen')));
    if (image) figure.append(node('a', { href: `/files/${image.id}`, target: '_blank', rel: 'noopener' }, node('img', { src: `/files/${image.id}`, alt: `${label} · ${state.reviewPage} · ${state.reviewDevice}px actual pixels`, loading: 'lazy' })));
    else figure.append(p('No matching capture for this page/device yet.', 'empty'));
    if (v.outputs.siteRelative) figure.append(link('Explore this version ↗', `${state.session.previewOrigin}/site/${v.id}/${state.reviewPage}.html`, 'action-link'));
    if (v.id !== job.id) figure.append(node('br'), link('Inspect parent work record ↗', `#jobs/${v.id}`, 'action-link'));
    comparison.append(figure);
  }
  root.append(comparison);
  const directionRecord = job.input.polishOf && record.comparison ? record.comparison : record;
  const studyPrefix = directionRecord.job.outputs.studyRoots?.[0]?.replace(/study-0\/site$/, '');
  const studies = directionRecord.artifacts.filter(a => a.kind === 'direction_capture' && (!studyPrefix || a.relative.startsWith(studyPrefix)));
  if (studies.length) root.append(node('details', { class: 'study-shelf' }, node('summary', {}, 'The three rendered directions'), directionRecord !== record ? p('Retained from the parent visual world. The focused polish did not regenerate these studies.', 'meta') : null, node('div', { class: 'study-grid' }, studies.filter(a => /study-[0-2]-1280\.png$/.test(a.relative)).map(a => node('figure', {}, node('img', { src: `/files/${a.id}`, alt: a.label, loading: 'lazy' }), node('figcaption', {}, a.label), fileLink(a, 'Open actual study capture ↗'), node('br'), link('Explore study ↗', `${state.session.previewOrigin}/study/${directionRecord.job.id}/${a.relative.match(/study-([0-2])-1280/)[1]}/index.html`, 'action-link'))))));
  if (job.outputs.critiqueNotes?.length) root.append(node('details', {}, node('summary', {}, 'Actual-pixel AI critique · not human acceptance'), node('ul', { class: 'facts' }, job.outputs.critiqueNotes.map(note => node('li', {}, note)))));
  if (job.outputs.blockingDefects?.length) root.append(node('div', { class: 'review-blockers' }, node('h3', {}, 'Visual changes required'), node('ul', { class: 'facts' }, job.outputs.blockingDefects.map(note => node('li', {}, note)))));
  const notes = record.events.filter(e => e.type === 'review.note');
  if (notes.length) root.append(node('div', { class: 'version-notes' }, node('h3', {}, 'Notes on this exact version'), notes.map(e => node('blockquote', {}, p(e.detail.note), node('small', {}, `${stamp(e.at)} · supplied feedback, not an acceptance record`)))));
  if (canOpenDesignWorkbench(job)) root.append(renderDesignWorkbench(job));
  if (job.state === 'review_ready' && job.outputs.reviewStatus === 'operator_review_required' && job.outputs.siteDigest) {
    const textarea = node('textarea', { id: `feedback-${job.id}`, required: true, minlength: 8, maxlength: 3000, oninput: e => { state.drafts[job.id] = e.target.value; } }); textarea.value = state.drafts[job.id] || '';
    const form = node('form', { class: 'review-feedback', onsubmit: async e => { e.preventDefault(); const result = await action('review_note', { id: job.id, siteDigest: job.outputs.siteDigest, note: textarea.value }, 'Exact-version note saved. No acceptance recorded.', { currentTarget: e.target.querySelector('[type=submit]') }); if (result) { state.drafts[job.id] = textarea.value; if(simple)document.querySelector('#review-workspace .review-feedback [type=submit]')?.focus({preventScroll:true}); } } }, node('label', { for: textarea.id }, 'Revision feedback'), p('What should change in composition, imagery, content or interaction? Notes stay bound to this digest. Requesting a revision creates new isolated bytes; it does not replace this site.', 'muted'), textarea, node('div', { class: 'files' }, node('button', { type: 'submit', class: 'secondary' }, 'Save version note'), button('Request isolated revision', async e => {
      if (!form.reportValidity()) return;
      const next = await action('revise_site', { id: job.id, siteDigest: job.outputs.siteDigest, feedback: textarea.value }, 'One explicit isolated revision queued. Previous version preserved.', e);
      if (next) { state.kind = 'site'; state.filter = ''; state.query = ''; await inspectJob(next); }
    }, 'primary')), p('Two requested revision jobs maximum per business, including stopped work. No automatic acceptance, outreach or publication.', 'meta'));
    if(simple||job.input.ownerIntake||job.input.apiConcept){form.querySelector('button[type=button]')?.remove();form.querySelector('p.muted').textContent='Tell us what should change. Saving feedback does not rebuild, accept or publish this website.';form.querySelector('p.meta').textContent=job.input.ownerIntake||job.input.apiConcept?'To make a new version, prepare and confirm a revised brief in Business intake. Prior site bytes remain unchanged.':'Feedback stays attached to this exact version. Any further build needs separate authority.';}
    root.append(form);
    if(job.input.apiConcept||job.input.modelSelection?.startsWith('api/')){
      if(record.operatorReview)root.append(node('blockquote',{},p('Your verdict: '+record.operatorReview.verdict.replaceAll('_',' ')),p(record.operatorReview.note),p('Operator declaration · '+stamp(record.operatorReview.at)+' · '+record.operatorReview.scope,'meta')));
      const verdict=node('select',{name:'verdict','aria-label':'Private concept verdict'},node('option',{value:'changes_requested'},'Request changes'),node('option',{value:'accepted'},'Accept this private concept'));
      const review=node('form',{class:'review-feedback'},node('h3',{},'Your review of this exact version'),p('Record your own design verdict after trying the site. Customer acceptance, photo rights and publication remain separate.','meta'),verdict,node('label',{},'Reason for your verdict',node('textarea',{name:'note',required:true,minlength:8,maxlength:3000})),node('label',{class:'check-label'},node('input',{type:'checkbox',name:'desktop',required:true}),'I reviewed the actual desktop site and interactions'),node('label',{class:'check-label'},node('input',{type:'checkbox',name:'phone',required:true}),'I reviewed the actual phone site and interactions'),node('button',{type:'submit',class:'primary'},'Record my exact-version verdict'));
      let intent=null;review.addEventListener('submit',async e=>{e.preventDefault();if(!review.reportValidity())return;const values=new FormData(review),fields={jobId:job.id,siteDigest:job.outputs.siteDigest,verdict:values.get('verdict'),note:values.get('note'),desktopReviewed:true,phoneReviewed:true,operatorAttestation:true};const signature=JSON.stringify(fields);if(!intent||intent.signature!==signature)intent={signature,input:{...fields,requestId:'review-'+crypto.randomUUID()}};const result=await action('studio_review_record',intent.input,'Exact-version operator declaration recorded. Nothing published.',{currentTarget:review.querySelector('[type=submit]')});if(result){state.selectedJob=await op('job_get',{id:job.id});render();}});root.append(review);
    }
  }
  if (!simple && job.state === 'blocked' && job.outputs.qaPass === true && job.outputs.reviewStatus === 'creative_rework_required') {
    const spent = job.input.polishOf || state.data.jobs.some(j => j.input.polishOf && j.input.candidateId === job.input.candidateId);
    if (spent) root.append(p('The separately authorized additional polish allowance already has a job. No automatic further budget or acceptance is available.', 'inline-message'));
    else root.append(renderPolishRequest(job));
  }
  if (simple) root.append(reviewCheckpoint(job));
  return root;
}
function renderSimpleReview(){
  const id=location.hash.split('/')[1],record=state.selectedJob;
  window.FactoryReviewReady=Boolean(record&&record.job.id===id&&record.job.kind==='site');
  if(!window.FactoryReviewReady)return empty('Reading the saved website.','Choose a website from Your websites. Opening this page creates no work.');
  if(!record.job.outputs.siteRelative)return empty('The website is not ready yet.','Research or design is still incomplete. Inspect the saved run for its reason.');
  return renderReviewWorkspace(record,{simple:true});
}
function renderPolishRequest(job) {
  const textarea = node('textarea', { id: `polish-${job.id}`, required: true, minlength: 8, maxlength: 3000 });
  const form = node('form', { class: 'review-feedback', onsubmit: async e => {
    e.preventDefault(); const next = await action('polish_site', { id: job.id, siteDigest: job.outputs.siteDigest, feedback: textarea.value }, 'One explicitly additional polish queued; old version and original repair budgets preserved.', { currentTarget: e.target.querySelector('[type=submit]') });
    if (next) { state.kind = 'site'; state.filter = ''; state.query = ''; await inspectJob(next); }
  } }, node('label', { for: textarea.id }, 'Authorized polish corrections'), p('Only after explicit additional task-budget authorization. This is one new focused proposal, with no automatic retry or repair loop. The acknowledgement is not a human signature, visual acceptance or publication authority.', 'muted'), textarea, node('label', { class: 'budget-acknowledgement' }, node('input', { type: 'checkbox', required: true }), 'I have explicit additional correction-budget authorization'), node('button', { type: 'submit', class: 'primary' }, 'Request one authorized polish'));
  return node('details', {}, node('summary', {}, 'Additional correction budget'), form);
}
function renderBusinesses() {
  const root = node('div'), grid = node('div', { class: 'work-grid' });
  root.append(sectionTop('The existing library', `${state.data.businesses.length} curated businesses / ${state.data.indexedFileCount} indexed files`));
  for (const b of state.data.businesses) {
    const photo = libraryPhoto(b), dl = node('dl'); for (const [key, value] of Object.entries(b.states || {})) dl.append(node('dt', {}, key.replaceAll('_', ' ')), node('dd', {}, value));
    const packages = state.data.libraryFiles.filter(f => f.kind === 'package' && Object.values(b.folders || {}).includes(f.root) && f.metadata.current_package);
    const c = node('article', { class: 'business-entry' }, photo ? node('img', { class: 'business-photo', src: `/library-files/${photo.id}`, alt: `${b.name} · business-posted private-preview image`, loading: 'lazy' }) : null, p(`${b.category || 'EXISTING WORK'} / ${b.area || ''}`, 'meta'), node('h2', {}, b.name), badge(b.design_status || 'indexed'), p(b.summary), dl, node('div', { class: 'source-links' }, (b.contacts || []).filter(v => v.url).map(v => link(v.label + ' ↗', v.url))));
    if (b.preview_url) c.append(link('Open existing private concept ↗', b.preview_url, 'secondary small'));
    const additionalVersions = state.data.jobs.filter(j => j.kind === 'site' && j.outputs.curatedBusinessId === b.id && j.outputs.handoffRoot !== b.folders.concept && j.outputs.siteDigest);
    if (additionalVersions.length) c.append(node('div', { class: 'files' }, additionalVersions.map(j => link(`Additional proposal ${j.outputs.siteDigest.slice(0, 12)} · review pending ↗`, `${state.session.previewOrigin}/site/${j.id}/index.html`))));
    if (packages.length) c.append(node('div', { class: 'files' }, packages.map(f => link(f.root === b.folders.concept ? 'Preserved concept ZIP ↓' : `Review ZIP ${f.root.split('/').pop()} ↓`, `/library-files/${f.id}`))));
    const facts = node('details', {}, node('summary', {}, 'Sources, unknowns & folders'), node('ul', { class: 'facts' }, (b.unknowns || []).map(v => node('li', {}, typeof v === 'string' ? v : JSON.stringify(v)))), node('dl', {}, Object.entries(b.folders || {}).flatMap(([key, value]) => [node('dt', {}, key), node('dd', {}, value)]))); c.append(facts); grid.append(c);
  }
  root.append(grid, node('div', { class: 'block' }, sectionTop('Researched candidates', `${state.data.candidates.length} observations — not automatically buyers`)));
  if (!state.data.candidates.length) root.append(empty('Research comes first.', 'New campaign results will appear here with their actual sources, qualification findings and unresolved questions.'));
  for (const c of state.data.candidates) {
    const facts = node('details', {}, node('summary', {}, 'Claim ledger & unresolved questions'), node('ul', { class: 'facts' }, c.facts.map(f => node('li', {}, f.text, node('br'), link('Source ↗', f.sourceUrl)))), node('ul', { class: 'facts' }, c.unknowns.map(v => node('li', {}, v))));
    root.append(node('article', { class: 'business-entry' }, p(`${c.origin} / ${c.area}`, 'meta'), node('h2', {}, c.name), badge(c.assessment.state), p(c.summary), p(c.assessment.reason, 'muted'), node('div', { class: 'source-links' }, c.sourceUrls.map((url, i) => link(`Source ${i + 1} ↗`, url))), facts, c.assessment.state === 'qualified' ? button('Prepare private proposal', e => action('build_site', { candidateId: c.id }, 'Private proposal queued. QA and human visual review remain separate.', e), 'primary') : c.assessment.state === 'blocked' ? button('Recheck held evidence', e => action('candidate_recheck', { id: c.id }, 'Bounded evidence follow-up queued; no new cohort.', e)) : p('Excluded from this no-site cohort.', 'meta')));
  }
  return root;
}
function renderReferences() {
  const grid = node('div', { class: 'reference-grid' });
  for (const r of state.data.references) {
    const capture = r.captures.find(c => c.viewport?.[0] === 1440)?.artifact;
    const image = node('div', { class: 'reference-image' }, capture ? node('img', { src: `/files/${capture.id}`, alt: `${r.name} · actual desktop reference capture`, loading: 'lazy' }) : node('div', { class: 'placeholder' }, r.name, node('br'), 'Awaiting capture.'));
    grid.append(node('article', { class: 'reference-entry' }, image, node('div', { class: 'reference-heading' }, node('h2', {}, r.name), badge(r.status)), p(r.principles), p(stamp(r.inspectedAt), 'meta'), node('div', { class: 'files' }, link('Visit reference ↗', r.url), button('Inspect reference', e => action('reference_audit', { referenceId: r.id, requestId: crypto.randomUUID() }, 'Guest-browser reference audit queued.', e), 'text-button')), r.captures.length ? node('div', { class: 'files' }, r.captures.filter(c => c.artifact).map(c => fileLink(c.artifact, `${c.viewport[0]}px capture ↓`))) : null));
  } return grid;
}
function renderAssets() {
  const root = node('div'), grid = node('div', { class: 'photo-grid' });
  const seen = new Set();
  const assets = [...state.data.libraryFiles.filter(f => f.kind === 'photo').map(f => ({ ...f, route: `/library-files/${f.id}`, meta: f.metadata })), ...state.data.assets.map(f => ({ ...f, route: `/files/${f.id}`, meta: {} }))].filter(f => { if (seen.has(f.sha256)) return false; seen.add(f.sha256); return true; });
  root.append(sectionTop('The actual photographs', `${assets.length} local web derivatives`));
  for (const f of assets) grid.append(node('article', { class: 'photo-entry' }, node('img', { src: f.route, alt: f.meta.role || f.label, loading: 'lazy' }), node('h3', {}, f.meta.account || f.label), p(f.meta.use_status || 'operator_authorized_private_preview'), p('Rightsholder permission: unconfirmed · public release: false'), link('Open local image ↗', f.route), f.meta.post_url ? link('Public post ↗', f.meta.post_url) : null));
  if (!assets.length) root.append(empty('No borrowed atmosphere.', 'When a job prepares actual identity-matched public photographs, their local derivatives and retained sources appear here. Originals remain outside the site export.'));
  root.append(grid, node('div', { class: 'block' }, p('Private concepts use the operator-authorized public business-photo practice. A public post is not a rightsholder licence. Signed CDN URLs and private source staging never enter this console or the website ZIP.', 'muted'))); return root;
}
function renderIntegrations() {
  const root = node('div'), vault = state.data.vault.find(v => v.id === 'connection');
  const row = (number, name, message, actions, extra) => node('section', { class: 'integration' }, node('span', { class: 'number', 'aria-hidden': 'true' }, number), node('div', {}, node('h2', {}, name), p(message), extra), node('div', { class: 'actions' }, actions));
  root.append(row('01', 'Shared local ledger', 'The existing library stays in place. Factory adds jobs, events, raw research and artifact bindings beside it, without overwriting your original business decisions.', link('Open existing library ↗', 'http://127.0.0.1:8774/', 'secondary small'), p(`${state.data.businesses.length} curated businesses · ${state.data.indexedFileCount} indexed file references`, 'meta')));
  root.append(row('02', 'Native OpenCode · CLI · MCP', 'Native V2 is the model worker, not the retired Fast bridge. The proposer cannot use host tools. Public research has separate bounded source tools. CLI and MCP queue the same operations as the browser.', button('Run runtime checks', async e => { try { state.doctor = await op('doctor', {}, e.currentTarget); render(); } catch { /* announced */ } }), node('div', {}, node('pre', {}, 'bin/factory status\nbin/factory doctor\nbin/factory help\n\nMCP: node src/mcp.mjs\nProject: simulacra-factory/opencode.json'), state.doctor ? node('ul', { class: 'connection-checks' }, state.doctor.checks.map(c => node('li', {}, node('strong', {}, c.name), node('span', {}, c.status)))) : p('Use runtime checks to inspect actual current prerequisites. A configured model/provider is not automatically live-verified.', 'meta'))));
  root.append(row('03', 'Preview Vault', 'Your existing hosted Vault is the destination, not a replacement invented by this app. This connection only checks public availability and imports a sanitized operator inventory. It never guesses a password, uploads, publishes or claims a private count.', [button('Check Vault status', e => action('vault_check', {}, 'Read-only Vault check queued. No login attempted.', e)), button('Import Vault inventory', () => { $('#vault-import').hidden = false; $('#vault-json').focus(); })], node('div', {}, badge(vault?.status || 'not_checked'), p(vault?.observedAt ? `Observed ${stamp(vault.observedAt)} · inventory not synchronized` : 'Authenticated live inventory has not been inspected.', 'meta'))));
  const form = node('form', { id: 'vault-import', class: 'form-panel', hidden: true, onsubmit: async e => { e.preventDefault(); try { const data = JSON.parse($('#vault-json').value); await op('vault_import', data); announce('Operator inventory imported. It is not labelled live-synchronized.'); await refresh(); } catch (error) { announce(error.message || 'Invalid inventory JSON', true); } } }, node('h2', {}, 'Import a sanitized inventory'), p('Use public /p/slug links only. No passwords, tokens, signed review URLs or customer-private information.', 'muted'), node('label', { for: 'vault-json' }, 'Sanitized inventory JSON'), node('textarea', { id: 'vault-json', required: true, maxlength: '100000', placeholder: '{"previews":[{"name":"Business","slug":"example","url":"https://simulacraproductions.net/p/example","status":"unknown"}]}' }), node('div', { class: 'form-footer' }, button('Cancel import', () => { $('#vault-import').hidden = true; }), node('button', { class: 'primary', type: 'submit' }, 'Import inventory')));
  root.append(form);
  const imported = state.data.vault.filter(v => v.origin === 'operator_import');
  if (imported.length) root.append(node('section', { class: 'block' }, sectionTop('Operator-imported Vault entries', 'NOT LIVE SYNCHRONIZED'), imported.map(v => node('article', { class: 'campaign-row' }, node('div', {}, node('h3', {}, v.name), p(`${v.status} · imported ${stamp(v.observedAt)}`, 'meta')), link('Open preview ↗', v.url, 'secondary small')))));
  root.append(row('04', 'Public sources & media', 'Fresh guest-browser inspections, real observed image IDs, bounded downloads and metadata-stripped local derivatives. Source blocks are visible holds. Instagram/Facebook rights remain private-preview only.', null, p('Optional Firecrawl provider: not required by the native research route. No new paid service is enabled by this build.', 'meta')));
  return root;
}
function render() {
  if (!state.data) return;
  const [route] = location.hash.slice(1).split('/'), view = views[route] ? route : 'start';
   $('#new-campaign').hidden = ['start','leads','inbox','review','sales','operations','intake','opportunities','setup','autopilot'].includes(view);
   if (!['start','leads','inbox','review','intake','opportunities','setup','autopilot'].includes(view)) $('#advanced-nav').open = true;
  $('#main').dataset.view = view;
  const [eyebrow, title, subtitle] = views[view]; $('#eyebrow').textContent = eyebrow; $('#title').replaceChildren(document.createTextNode(title), node('span', {}, '.')); $('#subtitle').textContent = subtitle; $('#crumb').textContent = view.toUpperCase();
  document.title = `Simulacra Factory · ${title}`;
  document.querySelectorAll('nav[aria-label="Factory"] a').forEach(a => { if (a.hash === '#' + (view==='review'?'inbox':view)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const context={node,p,button,badge,link,op,action,state,render,refresh,stamp,announce,empty,sectionTop};
   const renderers = { setup:()=>window.FactorySetup.setup(context), autopilot:()=>window.FactorySetup.autopilot(context), intake:()=>window.FactoryStudio.intake(context), opportunities:()=>window.FactoryStudio.leads(context), review:renderSimpleReview, leads:()=>window.FactoryBatches.leads(context), start:()=>window.FactoryBatches.home(context), inbox:()=>window.FactoryBatches.inbox(context), jobs: renderJobs, businesses: renderBusinesses, references: renderReferences, assets: renderAssets, integrations: renderIntegrations, sales:()=>window.FactoryPilot.sales(context), operations:()=>window.FactoryPilot.operations(context) };
  const rendered=renderers[view]();
  if(view==='start')rendered.prepend(node('section',{class:'block studio-start'},node('h2',{},'Start with one real business'),p('Use a simple supplied-content brief, or inspect unverified lead pointers before choosing a business. These paths start nothing until you explicitly ask.'),node('div',{class:'files'},link('Prepare a business brief','#intake','primary'),link('Open the lead workspace','#opportunities','secondary'))));
  $('#content').replaceChildren(rendered); $('#content').setAttribute('aria-busy', 'false'); $('#freshness').textContent = `Ledger read ${stamp(state.data.at)}`; window.FactoryReady = true;
}
async function refresh() {
  if (state.refreshing) return false;
  state.refreshing = true;
  const content=$('#content'),control=$('#refresh');
  // Native inert prevents typing into a form that a pending read will replace.
  // https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/inert
  content.inert=true;content.setAttribute('aria-busy','true');control.disabled=true;control.textContent='Refreshing…';
  try {
    if(!state.session)await renewSession();
    const response=await fetch('/api/status');if(!response.ok)throw new Error('Local ledger unavailable');state.data=await response.json();
    if(state.selectedJob)state.selectedJob=await op('job_get',{id:state.selectedJob.job.id});render();return true;
  } catch(e){window.FactoryProgress?.disconnected();announce(e.message,true);return false;}
  finally{state.refreshing=false;content.inert=false;content.setAttribute('aria-busy','false');control.disabled=false;control.textContent='Refresh ↻';}
}
$('#new-campaign').addEventListener('click', () => { $('#campaign-panel').hidden = false; $('#campaign-form [name="name"]').focus(); });
$('#close-campaign').addEventListener('click', () => { $('#campaign-panel').hidden = true; $('#new-campaign').focus(); });
$('#refresh').addEventListener('click', async () => { announce('Reading the current local ledger…'); if(await refresh())announce('Ledger refreshed from SQLite.'); });
$('#campaign-form').addEventListener('submit', async e => { e.preventDefault(); const values = Object.fromEntries(new FormData(e.target)); for (const key of ['candidateLimit', 'buildLimit', 'concurrency', 'deadlineMinutes']) values[key] = Number(values[key]); values.autoBuild = values.autoBuild === 'on'; values.retryLimit = 1; try { await op('campaign_create', values, e.target.querySelector('[type="submit"]')); $('#campaign-panel').hidden = true; location.hash = 'jobs'; await refresh(); announce('Bounded private campaign created. Choose Research leads to start.'); } catch { /* announced without losing entered values */ } });
window.addEventListener('hashchange', async () => {
  const [route, jobId] = location.hash.slice(1).split('/');
  if (['jobs','review'].includes(route) && jobId && state.data && state.selectedJob?.job.id !== jobId) {
    await inspectJob({id:jobId},route); return;
  }
  if (route === 'jobs' && !jobId) state.selectedJob = null;
  render();
});
(async () => { try { if(!await refresh())return; const [route,jobId] = location.hash.slice(1).split('/'); if (['jobs','review'].includes(route)&&jobId) await inspectJob({id:jobId},route); } catch (e) { announce(e.message, true); } })();
// Background refresh only while work is active and no user is typing/choosing data.
setInterval(() => { if (document.hidden || !state.data || window.FactorySetupDirty || window.FactoryBatchBusy || document.querySelector('dialog[open]') || $('#campaign-panel').hidden === false || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.querySelector('.batch-view details[open] form')) return; if (state.data.jobs.some(j => ['queued', 'running'].includes(j.state)) || window.FactoryBatchHasActive) refresh(); }, 4000);
