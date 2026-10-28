/* Saved operator workflow. Literal DOM, no keys or automatic sends. */
window.FactoryBatches = (() => {
  'use strict';
  const ui = { offset: 0, noteOffset: 0, noteBatch: null, setupOpen: false, drafts: {}, requests: {}, readiness: null, camofox: null, busy: false, filter: 'all', startError: null, expanded: {} };
  const openStates = ['active', 'awaiting_selection', 'awaiting_first_review', 'held'];
  const labels = { active: 'In progress', awaiting_first_review: 'Your first-site review', held: 'Needs attention', complete: 'Finished within limits', stopped: 'Stopped', review_ready: 'Ready for your review', queued: 'Waiting to start', running: 'Working', blocked: 'Needs attention', failed: 'Failed — work retained', waiting_to_build: 'Waiting to build', not_a_fit: 'Not a fit', suppressed: 'Do not contact' };
  labels.not_built = 'Not built within this batch'; labels.needs_changes = 'Changes requested — held';
  labels.awaiting_selection = 'Choose one saved lead';
  function outcome(b, jobs = []) {
    if (b.outcome) return b.outcome;
    if (!['complete', 'held'].includes(b.state)) return null;
    if (!b.counts.researched && !b.counts.initialAttempts && b.usage.modelRequests > 0 && !b.usage.searches && !b.usage.inspections && !b.usage.imageViews) return { kind: 'research_not_run', title: 'Research did not run', explanation: 'A model launch was recorded, but no search, page inspection or image-view attempts were observed. No businesses or websites were produced.', nextStep: 'Integration needs repair; do not start another batch.' };
    if (jobs.some(j => j.id !== b.recoveredLaunchParentJobId && j.kind === 'discovery' && ['failed', 'blocked', 'cancelled'].includes(j.state))) return { kind: 'research_stopped', title: 'Research stopped', explanation: 'Research stopped on a source or model failure. Results and usage are retained; no automatic retry.' };
    if (b.state === 'complete' && b.counts.shortfall) return { kind: b.counts.researched ? 'shortfall' : 'no_business_qualified', title: b.counts.researched ? 'Batch ended with a shortfall' : 'No business qualified', explanation: 'The target was not reached. Held or failed work is retained, not counted as a finished site.' };
    return null;
  }
  const batchLabel = (b, jobs) => outcome(b, jobs)?.title || labels[b.state];
  const isHistorical = (overview, b) => Boolean(b && overview.items[0] && overview.items[0].id !== b.id);
  const outcomeNextStep = (result, historical) => historical && result?.kind === 'research_not_run' ? 'This earlier attempt did not run research. History and usage are retained. See the latest attempt for its current progress.' : result?.nextStep;
  function historyNotice(ctx, overview, b) {
    const active = overview.items.find(item => openStates.includes(item.state));
    if (active && b?.id !== active.id) return ctx.node('aside', { class: 'batch-scope', 'aria-label': 'Current open batch' }, ctx.node('h2', {}, 'Another batch is open.'), ctx.p(`${labels[active.state]} · ${active.settings.niche}. The historical record below does not stop or replace that run.`), ctx.link('Open current batch', '#start/' + active.id, 'primary'));
    if (!active && isHistorical(overview, b)) return ctx.node('aside', { class: 'batch-scope', 'aria-label': 'Historical batch view' }, ctx.node('h2', {}, 'You are viewing an earlier attempt.'), ctx.p('History and usage are retained. A newer attempt is saved; open it to inspect its outcome and current progress.'), ctx.link('Open latest attempt', '#start/' + overview.items[0].id, 'primary'));
    return null;
  }
  function technical(ctx, detail) {
    return ctx.node('details', { class: 'batch-usage' }, ctx.node('summary', {}, 'Technical details'),
      detail.batch.message ? ctx.p(detail.batch.message) : null, detail.batch.lastShortfall ? ctx.p(detail.batch.lastShortfall) : null,
      detail.acquisition?ctx.p(`Evidence scout: ${detail.acquisition.counts.completed} source outcomes retained · ${detail.acquisition.counts.blocked} held · ${detail.acquisition.counts.claimed} in flight or interrupted. These are observations, not qualified businesses.`, 'meta'):null,
      detail.jobs.map(j => ctx.p(`${j.kind} · ${j.state}${j.errorCode ? ' · ' + j.errorCode : ''}${j.message ? ' — ' + j.message : ''}`, 'meta')));
  }
  function leadDecision(item) {
    if (item.suppressed) return 'Suppressed business — do not contact or build.';
    if (item.duplicate) return 'Existing identity match requires review.';
    if (item.websiteStatus === 'independent_official_site') return 'Official website observed — excluded from no-site production.';
    return item.buildUnsupported || item.screening?.reasons?.[0] || item.reasons?.[0] || item.missingEvidence?.[0] || 'Evidence is unknown; full fresh checks are still required.';
  }
  function terminalOutcome(detail) {
    const b = detail.batch;
    if (!['stopped', 'complete', 'held'].includes(b.state)) return null;
    const official = detail.items.filter(item => item.prospect?.websiteStatus === 'independent_official_site');
    const failed = detail.jobs.find(j => j.id !== b.recoveredLaunchParentJobId && j.kind === 'discovery' && ['failed', 'blocked', 'cancelled'].includes(j.state));
    if (official.length && !b.counts.ready) return { title: 'Official website found — excluded.', reason: `${official.map(item => item.candidate.name).join(', ')}: official website observed and excluded from no-site production. This exclusion is not a software failure.` };
    if (failed && !b.counts.researched) {
      const sourceAccessBlocked = failed.errorCode === 'SOURCE_BLOCKED';
      return { title: 'The last search stopped before saving any businesses.', shortTitle: sourceAccessBlocked ? 'Source access blocked — evidence unknown.' : failed.state === 'blocked' ? 'Research held before import.' : 'Research failed before import.', reason: failed.errorCode === 'INVALID_CONTACT_SOURCE' ? 'A research response did not match the required data format. No website was made.' : sourceAccessBlocked ? 'Source access was blocked. The missing evidence remains unknown, not proof of no website. No website was made.' : 'Research stopped before saving businesses. The actual code and message are retained; the cause is not diagnosed here. No website was made.', job: failed };
    }
    if (!b.counts.ready && detail.items.length) return { title: 'No business is ready to choose.', shortTitle: 'Saved evidence needs verification.', reason: leadDecision(detail.items[0].prospect || { reasons: detail.items[0].reasons }) };
    return { title: batchLabel(b, detail.jobs), reason: outcome(b, detail.jobs)?.explanation || (b.counts.ready ? 'Saved websites are available for your review, not accepted or published.' : 'No completed website from this run. Inspect the retained record; missing evidence remains unknown.') };
  }
  function savedOutcome(ctx, detail, root) {
    const result = terminalOutcome(detail); if (!result) return null;
    const { node: n, p, link, button } = ctx, b = detail.batch;
    return n('section', { class: 'simple-outcome', 'aria-label': 'Saved run outcome' },
      p(`${b.counts.researched} saved ${b.counts.researched === 1 ? 'prospect' : 'prospects'} · ${b.counts.selectable ?? 'unknown'} selectable · ${b.counts.ready} sites ready`, 'truth-label'),
      n('h2', {}, result.title), p(result.reason), result.job ? p(`Retained ${result.job.state}: ${result.job.errorCode || 'no error code recorded'}${result.job.message ? ' — ' + result.job.message : ''}`, 'meta') : null,
      p(`${b.settings.workflow === 'leads_first' ? b.discoveryUsage?.searches ?? 'Unknown' : b.usage.searches} of ${b.settings.discoverySearchLimit ?? b.settings.maxSearches} ${b.settings.workflow === 'leads_first' ? 'discovery searches' : 'total searches'} used${b.settings.workflow === 'leads_first' ? ` · ${b.usage.searches}/${b.settings.maxSearches} total searches` : ''}. Unused allowances do not authorize another attempt.`, 'meta'),
      p('Inspect the saved evidence or review preferences. A new paid run requires separate explicit authorization; opening settings starts nothing.', 'meta'),
      n('div', { class: 'files' }, link('Inspect saved results', '#leads/' + b.id, 'secondary'), result.job ? link('Inspect retained research', '#jobs/' + result.job.id, 'action-link') : null,
        button('Review search settings', () => { ui.expanded.settings = true; ui.setupOpen = true; const settings = root.querySelector('.search-settings'), setup = root.querySelector('.batch-setup'); settings.open = true; setup.open = true; setup.querySelector('[name=niche]').focus(); setup.scrollIntoView({ block: 'start', behavior: 'instant' }); }, 'secondary')));
  }
  function disclosure(ctx, key, title, children, open = false, className = '') {
    return ctx.node('details', { class: className, open: ui.expanded[key] ?? open, ontoggle: e => { if (e.currentTarget.isConnected) ui.expanded[key] = e.currentTarget.open; } }, ctx.node('summary', {}, title), children);
  }
  function requestFor(key, payload) {
    const json = JSON.stringify(payload); if (ui.requests[key]?.json !== json) ui.requests[key] = { json, id: crypto.randomUUID() };
    return ui.requests[key].id;
  }
  function load(ctx, fn) {
    const root = ctx.node('div', { class: 'batch-view', 'aria-busy': 'true' }, ctx.p('Reading your saved work…', 'muted')); window.FactoryBatchReady = false;
    Promise.resolve().then(() => fn(root)).catch(e => { if (root.isConnected) root.replaceChildren(ctx.empty('Could not read this workflow.', e.message)); }).finally(() => { if (root.isConnected) { root.setAttribute('aria-busy', 'false'); window.FactoryBatchReady = true; } });
    return root;
  }
  async function mutate(ctx, operation, input, source, success, onError = null) {
    if (ui.busy) return null; ui.busy = true; window.FactoryBatchBusy = true;
    try { const value = await ctx.op(operation, input, source); ctx.announce(success); return value; }
    catch (e) { onError?.(e); return null; }
    finally { ui.busy = false; window.FactoryBatchBusy = false; }
  }
  function select(ctx, label, name, options, value) {
    const id = 'batch-' + name;
    return ctx.node('div', { class: 'pilot-field' }, ctx.node('label', { for: id }, label), ctx.node('select', { id, name }, options.map(([v, text]) => ctx.node('option', { value: v, selected: value === v }, text))));
  }
  function scope(ctx, settings, title) {
    return ctx.node('section', { class: 'batch-scope', 'aria-label': title }, ctx.node('h3', {}, title),
      ctx.p(`${settings.area} · ${settings.niche} · ${settings.searchProvider === 'firecrawl' ? 'Firecrawl' : 'Guest public search'} · up to ${settings.targetCount} private sites`),
      ctx.p(`${settings.batchMinutes} minutes including review · ${settings.targetCount} initial build attempts · ${settings.maxResearchRounds} research rounds · ${settings.maxSearches} search / ${settings.maxInspections} page / ${settings.maxImageViews} image-view attempts · ${settings.maxModelRequests} native worker launches · ${settings.candidateLimit} candidates · ${settings.jobMinutes} minutes per job. Attempt limits, not a dollar cap.`, 'meta'));
  }
  // This state is deliberately separate from discovery/setup. Loading a file
  // neither asserts qualification nor dispatches source/model work.
  const assisted = { loaded: null, saved: null, saveAuthorized: false, buildAuthorized: false, saveIntent: null, buildIntent: null, error: '', loading: 0 };
  const assistedCounters = ['searches', 'inspections', 'imageViews', 'modelRequests'];
  function validateAssisted(value) {
    const object = v => v && typeof v === 'object' && !Array.isArray(v);
    const text = v => typeof v === 'string' && v.trim().length > 0;
    const date = v => text(v) && Number.isFinite(Date.parse(v));
    const s = value?.scope, b = value?.bundle;
    if (!object(value) || !object(s) || !object(b) || !object(value.usage) || !object(s.limits) ||
      !text(s.authorizationId) || !date(s.startedAt) || !date(s.sourceCutoff) || !date(s.deadlineAt) || typeof s.authorized !== 'boolean' ||
      Date.parse(s.startedAt) > Date.parse(s.sourceCutoff) || Date.parse(s.sourceCutoff) > Date.parse(s.deadlineAt) ||
      assistedCounters.some(k => !Number.isSafeInteger(s.limits[k]) || s.limits[k] < 0 || !Number.isSafeInteger(value.usage[k]) || value.usage[k] < 0 || value.usage[k] > s.limits[k]) ||
      (value.requestId !== undefined && !text(value.requestId)) || b.version !== 1 || b.segment !== 'booking_social_no_independent_marketing_site' ||
      !object(b.candidate) || !text(b.candidate.name) || !text(b.candidate.area) || !Array.isArray(b.candidate.facts) || b.candidate.facts.some(f => !object(f) || !text(f.text)) ||
      !Array.isArray(b.candidate.sourceUrls) || b.candidate.sourceUrls.some(u => typeof u !== 'string') ||
      ['observations', 'searches', 'imageViews', 'assets'].some(k => !Array.isArray(b[k]))) throw new Error('Prepared evidence is missing or has malformed contract fields. Load a complete evidence file.');
    let bytes = 0;
    for (const a of b.assets) {
      if (!object(a) || !text(a.imageId) || !text(a.sourceId) || !/^[a-f0-9]{64}$/i.test(a.sha256 || '') ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(a.contentType) || typeof a.originalBase64 !== 'string' || !a.originalBase64.length ||
        a.originalBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.originalBase64) ||
        !object(a.review) || a.review.method !== 'external_pixel_review' || !text(a.review.observer) || !date(a.review.at) || !text(a.review.notes)) throw new Error('Prepared photos need bounded JPEG, PNG or WEBP base64, hashes and external pixel-review metadata.');
      const raw = atob(a.originalBase64);
      if (btoa(raw) !== a.originalBase64 || !(a.contentType === 'image/png' ? raw.startsWith('\x89PNG\r\n\x1a\n') : a.contentType === 'image/jpeg' ? raw.startsWith('\xff\xd8\xff') : raw.startsWith('RIFF') && raw.slice(8, 12) === 'WEBP')) throw new Error('Prepared photo bytes do not match their declared image format.');
      bytes += raw.length;
      if (bytes > 8 * 1024 * 1024) throw new Error('Prepared photos exceed the 8 MiB aggregate limit.');
    }
    return value;
  }
  function assistedSource(ctx, url) {
    try {
      const u = new URL(url);
      // Signed CDN/media locators and arbitrary schemes are not public citations.
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || /(?:cdn|fbcdn|scontent)/i.test(u.hostname)) return null;
      return ctx.link('Source · ' + u.hostname, u.href, 'action-link');
    } catch { return null; }
  }
  function assistedScope(ctx, value) {
    const s = value.scope, usage = value.usage;
    if (!s || !usage) return ctx.p('Saved scope or usage missing — production held.', 'inline-message');
    return ctx.node('div', { class: 'batch-scope' }, ctx.p(`Original start: ${s.startedAt} · source cutoff: ${s.sourceCutoff} · original deadline: ${s.deadlineAt}`, 'meta'),
      ctx.p('Current externally reported usage / saved caps: ' + assistedCounters.map(k => `${k}: ${usage[k] ?? 'unknown'}/${s.limits?.[k] ?? 'unknown'}`).join(' · '), 'meta'),
      ctx.p('Time and consumed attempts are not reset. Import is not automatic discovery; saving starts no source or model work.', 'meta'));
  }
  function assistedPanel(ctx, overview) {
    const { node: n, p, button } = ctx;
    const panel = disclosure(ctx, 'assisted', 'Assisted business intake', [], false, 'assisted-intake batch-readiness');
    // Existing classes supply layout; explicit min-width keeps the native file
    // picker and literal long business text within a narrow phone viewport.
    panel.style.minWidth = '0'; panel.style.overflowWrap = 'anywhere';
    const content = n('div', {}); panel.append(content);
    function draw() {
      const loaded = assisted.loaded, saved = assisted.saved;
      const error = p(assisted.error, 'inline-message assisted-error'); error.id = 'assisted-evidence-error'; error.setAttribute('role', 'alert'); error.hidden = !assisted.error;
      const file = n('input', { id: 'assisted-evidence-file', type: 'file', accept: '.json,application/json', 'aria-describedby': 'assisted-evidence-help assisted-evidence-error', 'aria-invalid': assisted.error && !loaded ? 'true' : null, disabled: ui.busy, onchange: async e => {
        if (ui.busy) return;
        const selected = e.currentTarget.files?.[0], generation = ++assisted.loading;
        assisted.loaded = null; assisted.saved = null; assisted.saveIntent = null; assisted.buildIntent = null; assisted.saveAuthorized = false; assisted.buildAuthorized = false; assisted.error = '';
        if (!selected) { draw(); return; }
        try {
          if (selected.size > 1024 * 1024) throw new Error('Prepared evidence must be no larger than 1 MiB.');
          const data = await selected.text();
          let value; try { value = JSON.parse(data); } catch { throw new Error('Invalid JSON. Load a prepared evidence JSON file.'); }
          validateAssisted(value);
          if (generation !== assisted.loading) return;
          // Content-derived fallback survives reloading the same prepared file
          // after a lost response without storing private photo bytes in storage.
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
          if (generation !== assisted.loading) return;
          assisted.loaded = value;
          assisted.saveIntent = { ...value, requestId: value.requestId || 'assisted-save-' + [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('') };
        } catch (e) { if (generation !== assisted.loading) return; assisted.error = e.message; ctx.announce(e.message, true); }
        draw();
      } });
      file.style.maxWidth = '100%'; file.style.minWidth = '0'; file.style.width = '100%';
      const saveAck = n('input', { type: 'checkbox', checked: assisted.saveAuthorized, disabled: !loaded || Boolean(saved) || ui.busy, onchange: e => { assisted.saveAuthorized = e.currentTarget.checked; update(); } });
      const save = button('Save supplied evidence', async e => {
        if (!assisted.loaded || !assisted.saveAuthorized || assisted.saved || ui.busy) return;
        const intent = { ...assisted.saveIntent, scope: { ...assisted.saveIntent.scope, authorized: true } };
        const pending = mutate(ctx, 'assisted_save', intent, e.currentTarget, 'Evidence saved. No website started.', () => { assisted.error = 'Save response not confirmed. No automatic retry. An explicit Save reuses this exact request.'; });
        draw(); const result = await pending;
        if (result) { assisted.saved = result; assisted.error = ''; assisted.saveAuthorized = false; }
        draw();
      }, 'secondary');
      content.replaceChildren(n('p', { id: 'assisted-evidence-help' }, 'An AI or operator prepares a captured facts/photos evidence file (up to 1 MiB). This is an assisted import, not automatic business discovery. Loading stays local; Save and Build are separate explicit actions.'),
        p('Imported / externally observed evidence—not native verification or owner confirmation.', 'truth-label'),
        n('label', { for: file.id }, 'Load prepared business evidence (.json)'), file, error);
      const candidate = saved?.candidate || loaded?.bundle.candidate;
      if (candidate) content.append(n('h3', {}, candidate.name), p(typeof candidate.area === 'string' ? candidate.area : ''),
        n('ul', {}, (candidate.facts || []).filter(f => typeof f.text === 'string').map(f => n('li', {}, f.text))),
        p(`${candidate.sourceUrls?.length ?? 0} supplied source references · ${loaded?.bundle.assets.length ?? 0} locally loaded photos. References are supplied evidence, not verified receipts.`, 'meta'),
        n('div', { class: 'files' }, (candidate.sourceUrls || []).map(u => assistedSource(ctx, u))));
      if (loaded) {
        const photos = n('div', { class: 'files', 'aria-label': 'Prepared local photographs' }, loaded.bundle.assets.map((a, i) => n('img', { src: `data:${a.contentType};base64,${a.originalBase64}`, alt: `Supplied business photograph ${i + 1} · externally reviewed`, width: 120, height: 90, loading: 'lazy', style: 'max-width:100%;object-fit:cover' })));
        content.append(photos, assistedScope(ctx, saved || loaded));
      }
      content.append(n('label', { class: 'budget-acknowledgement' }, saveAck, 'I authorize saving this supplied evidence'), save);
      let build, buildAck;
      const eligible = () => saved?.assessment?.ready === true && typeof saved.id === 'string' && saved.id.length > 0 &&
        /^[a-f0-9]{64}$/i.test(saved.bundleDigest || '') && /^[a-f0-9]{64}$/i.test(saved.evidenceDigest || '') && /^[a-f0-9]{64}$/i.test(overview.currentPolicyDigest || '') &&
        (saved.claimedBatchId === null || saved.claimedBatchId === undefined) && Date.parse(saved.scope?.deadlineAt) > Date.now() &&
        (!assisted.buildIntent || (assisted.buildIntent.id === saved.id && assisted.buildIntent.bundleDigest === saved.bundleDigest && assisted.buildIntent.evidenceDigest === saved.evidenceDigest && assisted.buildIntent.policyDigest === overview.currentPolicyDigest));
      if (saved) {
        buildAck = n('input', { type: 'checkbox', checked: assisted.buildAuthorized, onchange: e => { assisted.buildAuthorized = e.currentTarget.checked; update(); } });
        build = button('Build one private proposal', async e => {
          if (!eligible() || !assisted.buildAuthorized || ui.busy) { update(); return; }
          // Stable for the same saved proof even if the page is reloaded after
          // response loss. A changed policy cannot turn that replay into a new ID.
          assisted.buildIntent ||= { id: saved.id, bundleDigest: saved.bundleDigest, evidenceDigest: saved.evidenceDigest, policyDigest: overview.currentPolicyDigest, requestId: 'assisted-build-' + saved.bundleDigest.slice(0, 32) + saved.evidenceDigest.slice(0, 32), authorized: true };
          const pending = mutate(ctx, 'assisted_build', assisted.buildIntent, e.currentTarget, 'Private proposal queued. Review is still required.', () => { assisted.error = 'Build response not confirmed. No automatic retry or replacement. An explicit Build reuses this exact request.'; });
          draw(); const result = await pending;
          if (result?.batch?.id) { assisted.saved = { ...saved, claimedBatchId: result.batch.id }; assisted.buildAuthorized = false; assisted.error = ''; location.hash = 'start/' + result.batch.id; await ctx.refresh(); }
          else draw();
        }, 'primary');
        content.append(p(saved.assessment?.ready === true ? 'Booking/social presence—no independent marketing website found' : 'Held — imported evidence needs attention', 'truth-label'),
          n('ul', {}, (saved.assessment?.reasons || []).map(reason => n('li', {}, typeof reason === 'string' ? reason : 'Saved evidence requires review.'))),
          !eligible() ? p('Build unavailable: inspect the saved assessment, claim, original deadline and current policy. Missing proof is a hold, not permission to reset or replace.', 'meta') : null,
          n('label', { class: 'budget-acknowledgement' }, buildAck, 'Authorize one private proposal within saved limits'),
          p('This authorizes one private proposal only—not human acceptance, contact or publication.', 'meta'), build,
          button('Refresh saved assessment', async e => {
            if (ui.busy) return;
            try { const result = await ctx.op('assisted_get', { id: saved.id }, e.currentTarget); assisted.saved = result; assisted.buildAuthorized = false; assisted.error = ''; }
            catch { assisted.error = 'Could not refresh saved evidence. No automatic retry.'; }
            draw();
          }));
        const remaining = Date.parse(saved.scope?.deadlineAt) - Date.now();
        if (remaining > 0 && remaining < 2147483647) setTimeout(() => { if (content.isConnected) update(); }, remaining + 1);
      }
      function update() { save.disabled = !loaded || !assisted.saveAuthorized || Boolean(saved) || ui.busy; if (build) { build.disabled = !eligible() || !assisted.buildAuthorized || ui.busy; buildAck.disabled = ui.busy; } }
      update();
    }
    draw(); return panel;
  }
  function setup(ctx, preset, hasBatch = false) {
    const { node: n, p } = ctx, values = ui.drafts.setup || preset.settings;
    const number = (label, name, min, max) => n('label', {}, label, n('input', { name, type: 'number', required: true, min, max, value: values[name] }));
    const detail = n('details', { class: 'batch-setup', open: !preset.adopted || ui.setupOpen, ontoggle: e => { ui.setupOpen = e.currentTarget.open; } }, n('summary', {}, preset.adopted ? hasBatch ? 'Edit setup for the next run' : 'Edit setup & limits' : 'One-time setup — choose your scope'));
    const dirty = p(ui.drafts.setup ? 'Unsaved setup edits' : 'Changes stay here until you save. Saving starts nothing.', 'batch-draft meta');
    const form = n('form', { class: 'pilot-form batch-setup-form', 'aria-label': 'Saved Houston setup', oninput: () => { ui.drafts.setup = Object.fromEntries(new FormData(form)); dirty.textContent = 'Unsaved setup edits'; }, onsubmit: async e => {
      e.preventDefault(); if (ui.busy) return;
      const values = Object.fromEntries(new FormData(form)); delete values.acknowledged;
      for (const field of ['targetCount', 'candidateLimit', 'maxResearchRounds', 'maxSearches', 'maxInspections', 'maxImageViews', 'maxModelRequests', 'batchMinutes', 'jobMinutes']) values[field] = Number(values[field]);
      if (values.workflow === 'leads_first') {
        values.discoverySearchLimit = Number(values.discoverySearchLimit);
        if (values.targetCount !== 1 || values.discoverySearchLimit < 1 || values.discoverySearchLimit >= values.maxSearches) { ctx.announce('Two-step setup needs one site and a discovery share smaller than total searches.', true); return; }
      } else { delete values.workflow; delete values.discoverySearchLimit; }
      const payload = { version: preset.version, settings: values, acknowledged: true }; form.inert = true;
      const saved = await mutate(ctx, 'batch_preset_save', { ...payload, requestId: requestFor('setup', payload) }, form.querySelector('[type=submit]'), 'Saved setup. Nothing has started.'); form.inert = false;
      if (saved) { delete ui.drafts.setup; delete ui.requests.setup; ui.setupOpen = false; ui.expanded.settings=false; ui.readiness = null; await ctx.refresh(); }
    } },
    select(ctx, 'Houston area', 'area', [['Houston city limits', 'Houston city limits'], ['Houston metro area', 'Houston metro area']], values.area),
    n('label', {}, 'Business categories', n('input', { name: 'niche', required: true, maxlength: 100, value: values.niche, placeholder: 'e.g. independent upholstery workshops' })),
    select(ctx, 'Permitted search reader', 'searchProvider', [['guest_bing', 'Guest public search · access may be limited'], ['firecrawl', 'Firecrawl · requires existing configured access']], values.searchProvider), number('Private site target (up to 10)', 'targetCount', 1, 10));
    form.append(select(ctx, 'Workflow', 'workflow', [['automatic', 'Legacy automatic · qualify and build'], ['leads_first', 'Two-step · Get leads, then choose one']], values.workflow || 'automatic'),
      n('div', { class: 'batch-full' }, number('Discovery search allocation', 'discoverySearchLimit', 1, 59), p('Two-step only: fewer than total search attempts. Enrichment uses the remainder of the same total and original deadline. One initial site in this release.', 'meta'), p('Photo-rich category ideas: independent florists, ceramic studios, furniture restoration or cake decorators. These are examples, not an automatic change to your scope.', 'meta')),
      dirty, n('details', { class: 'batch-limits' }, n('summary', {}, 'Review the saved attempt limits'), p('Failed requests consume units. No automatic retries, provider switching or parallel site builds. These are not dollar caps.', 'muted'),
      n('div', { class: 'form-grid' }, number('Candidate allowance', 'candidateLimit', 1, 40), number('Research rounds', 'maxResearchRounds', 1, 10), number('Search-reader attempts', 'maxSearches', 1, 60), number('Page-reader attempts', 'maxInspections', 1, 120), number('Image-view attempts', 'maxImageViews', 1, 60), number('Native worker launches', 'maxModelRequests', 1, 100), number('Batch time allowance (minutes)', 'batchMinutes', 30, 720), number('Time per job (minutes)', 'jobMinutes', 2, 60))),
      p('Review source terms and collection/storage permission for your use. Accessible public web/business-social evidence only; no Maps bulk collection, stealth/login bypass or authenticated profiles. Selecting Firecrawl does not connect an account.', 'batch-full meta'),
      n('label', { class: 'budget-acknowledgement batch-full' }, n('input', { type: 'checkbox', name: 'acknowledged', required: true }), 'I reviewed this scope, permitted public sources and attempt limits.'),
      p('One research launch permits up to 36 agent steps, not one provider completion. These bounds do not measure tokens or dollars. Saving does not start a live run; starting is a separate private-run action.', 'batch-full meta'), n('button', { class: 'secondary', type: 'submit' }, 'Save one-time setup'));
    const allocation = form.querySelector('[name=discoverySearchLimit]'); allocation.value = values.discoverySearchLimit || Math.max(1, Math.floor(Number(values.maxSearches) / 2));
    allocation.required = (values.workflow === 'leads_first');
    form.querySelector('[name=workflow]').addEventListener('change', e => { allocation.required = e.target.value === 'leads_first'; if (allocation.required) form.querySelector('[name=targetCount]').value = '1'; ui.drafts.setup = Object.fromEntries(new FormData(form)); });
    detail.append(form); return detail;
  }
  function checkpoint(ctx, b, first) {
    const { node: n, p, link } = ctx, key = 'checkpoint-' + b.id, single=b.settings.targetCount===1;
    const textarea = n('textarea', { id: 'first-site-note', required: true, maxlength: 1500, oninput: e => { ui.drafts[key] = e.target.value; } }); textarea.value = ui.drafts[key] || '';
    const form = n('form', { class: 'batch-checkpoint', 'aria-label': 'First-site checkpoint', onsubmit: async e => {
      e.preventDefault(); const payload = { id: b.id, siteJobId: first.id, siteDigest: first.outputs.siteDigest, note: textarea.value, reviewed: true };
      const result = await mutate(ctx, 'batch_continue', payload, form.querySelector('[type=submit]'), 'Checkpoint saved. No artifact acceptance recorded.'); if (result) await ctx.refresh();
    } }, n('h3', { id: 'batch-checkpoint-heading', tabindex: '-1' }, single?'Finish this one-site review.':'One real review before the rest.'), p(single?'After inspecting the actual website, record your review to finish this run. This does not accept, publish or authorize another website.':'Judge the actual desktop/phone work and business-specific design. This permits remaining capped production, not artifact acceptance.'),
      link('Open exact desktop / phone review ↗', '#jobs/' + first.id, 'action-link'), n('code', { class: 'site-digest' }, first.outputs.siteDigest), n('label', { for: textarea.id }, 'First-site review note'), textarea,
      n('label', { class: 'budget-acknowledgement' }, n('input', { type: 'checkbox', required: true }), single?'I reviewed this exact website and want to finish this run.':'I reviewed this exact site and have authorization to build the remainder.'), n('button', { class: 'primary', type: 'submit' }, single?'Finish this run':'Continue the remaining batch'));
    return form;
  }
  function batchProgress(ctx, detail, historical = false) {
    const { node: n, p, button, link } = ctx, b = detail.batch;
    const result = outcome(b, detail.jobs);
    const first = ['awaiting_first_review', 'held'].includes(b.state) && !b.checkpoint ? detail.jobs.filter(j => j.kind === 'site' && j.input.candidateId === b.firstCandidateId && j.state === 'review_ready').at(-1) : null;
    const root = n('section', { class: 'batch-progress', 'aria-label': 'Current batch' }, historical ? p('Historical attempt', 'kicker') : null, n('h2', {}, batchLabel(b, detail.jobs)), p(result?.explanation || (b.state === 'active' ? b.phase === 'production' ? 'Designing and testing the selected business’s website.' : b.phase === 'enrichment' ? 'Checking the selected business before design.' : 'Looking for businesses and checking their public sources.' : b.state === 'awaiting_selection' ? 'Choose one business for full checks before design.' : b.state === 'held' ? 'This run needs attention. No replacement will be chosen automatically.' : b.counts.ready ? 'Your private website is ready to inspect.' : 'No completed website from this run. Saved results are still available.')), outcomeNextStep(result, historical) ? p(outcomeNextStep(result, historical), 'inline-message') : null,
      n('div', { class: 'files batch-next-action' }, first ? link('Review website', '#review/' + first.id, 'primary') : b.state === 'awaiting_selection' && result?.kind !== 'no_selectable_prospect' ? link('Choose a business', '#leads/' + b.id, 'primary') : link(b.state === 'held' && result?.kind !== 'no_selectable_prospect' ? 'See what needs attention' : 'View saved results', '#leads/' + b.id, 'secondary'),
        openStates.includes(b.state) ? button('Stop this batch', async e => { const result = await mutate(ctx, 'batch_stop', { id: b.id }, e.currentTarget, 'Batch stopped. All work is retained.'); if (result) await ctx.refresh(); }, 'text-button') : null),
      window.FactoryProgress.create(ctx,detail,{compact:true}));
    root.append(disclosure(ctx, 'run-'+b.id, 'Run details', [
      p(`${b.counts.researched} researched · ${b.counts.initialAttempts} initial build attempts · ${b.counts.ready} sites ready for review`, 'meta'),
      p(`Time allowance ends ${ctx.stamp(b.deadlineAt)}. Review pause is included; expired work does not auto-resume.`, 'meta'),
      p(detail.costs.coverage === 'not_recorded' ? 'Costs: not recorded — this does not mean production was free.' : `Reported costs: $${(detail.costs.reportedTotalCents / 100).toFixed(2)} · partial operator reporting, not complete unit economics.`, 'meta'),
      technical(ctx,detail), scope(ctx,b.settings,'Frozen for this batch'),
      n('details', {class:'batch-usage'}, n('summary',{},'Usage & retained work'),p(`Search ${b.usage.searches}/${b.settings.maxSearches} · pages ${b.usage.inspections}/${b.settings.maxInspections} · image views ${b.usage.imageViews}/${b.settings.maxImageViews} · Native worker launches ${b.usage.modelRequests}/${b.settings.maxModelRequests}`),p('Reserved attempts are not billing. Actual cash/labor coverage remains in Sales; missing costs are unknown.','meta'),detail.jobs.map(j=>link(`${j.kind} · ${labels[j.state]||j.state} · inspect retained record ↗`,'#jobs/'+j.id,'action-link')))
    ]));
    if (first) {
      const item = detail.items.find(item => item.candidate.id === b.firstCandidateId);
      const correctionNeeded = item?.disposition === 'needs_changes' && item.dispositionSiteJobId === first.id;
      const excluded = item && (!item.ready || item.suppressed || item.disposition === 'not_a_fit');
      if (correctionNeeded || excluded) root.append(n('section', { class: 'batch-checkpoint' }, n('h3', { id: 'batch-checkpoint-heading', tabindex: '-1' }, 'Continuation needs attention.'),
        p(correctionNeeded ? 'Changes were requested on this exact version. Inspect the feedback and request a bounded correction in the exact-site review desk. Only a newer completed correction can be reviewed for continuation.' : 'First-business qualification or disposition is held. Inspect the retained evidence and feedback; reviewing this version cannot clear the hold.'),
        link('Inspect exact-site review & feedback ↗', '#jobs/' + first.id, 'action-link')));
      else root.append(b.settings.targetCount===1?disclosure(ctx,'finish-'+b.id,'Finish review',[checkpoint(ctx,b,first)],location.hash.split('/')[2]==='checkpoint'):checkpoint(ctx,b,first));
    }
    return root;
  }
  function home(ctx) { return load(ctx, async root => {
    const { node: n, p, button, link } = ctx, overview = await ctx.op('batch_status', { limit: 20 }); if (!root.isConnected) return;
    const requested = location.hash.split('/')[1], selected = requested || overview.items.find(b => openStates.includes(b.state))?.id || overview.items[0]?.id;
    const detail = selected ? await ctx.op('batch_get', { id: selected }) : null; if (!root.isConnected) return;
    const active = overview.items.find(b => openStates.includes(b.state)), preset = overview.preset;
    window.FactoryBatchHasActive = Boolean(active?.state === 'active');
    const startError = p(ui.startError || '', 'inline-message batch-start-error'); startError.hidden = !ui.startError;
    const start = button(preset.settings.workflow === 'leads_first' ? 'Find leads' : `Find & build up to ${preset.settings.targetCount} Houston websites`, async e => {
      let intent; try { intent = JSON.parse(sessionStorage.getItem('factory-batch-intent')); } catch { /* new session */ }
      if (!intent) { intent = { presetVersion: preset.version, requestId: crypto.randomUUID(), authorized: true }; sessionStorage.setItem('factory-batch-intent', JSON.stringify(intent)); }
      let refreshRejectedSetup = false;
      const result = await mutate(ctx, 'batch_start', intent, e.currentTarget, 'Saved batch started. Nothing is sent or published.', error => {
        // Only definitive pre-commit rejections may discard an intent. A network
        // error/503 after commit must retain the exact original replay payload.
        if (['BATCH_SETUP', 'STALE_PRESET', 'BATCH_READINESS', 'BATCH_ACTIVE', 'INVALID_INPUT'].includes(error.code)) { sessionStorage.removeItem('factory-batch-intent'); ui.startError = error.message; }
        else ui.startError = 'The start response was not confirmed. Retry checks the same saved request; it does not start a second run.';
        refreshRejectedSetup = error.code === 'STALE_PRESET' || error.code === 'BATCH_ACTIVE';
      });
      if (result) { ui.startError = null; sessionStorage.removeItem('factory-batch-intent'); location.hash = 'start/' + result.id; await ctx.refresh(); }
      else if (refreshRejectedSetup) await ctx.refresh();
      else { startError.textContent = ui.startError; startError.hidden = false; }
    }, 'primary batch-start'); start.disabled = !preset.adopted || Boolean(active);
    const choose = button('Choose your setup', () => { const setup = root.querySelector('.batch-setup'); setup.open = true; setup.querySelector('[name=niche]').focus(); setup.scrollIntoView({ block: 'start', behavior: 'instant' }); }, 'primary batch-start');
    root.replaceChildren();
     const notice = historyNotice(ctx, overview, detail?.batch); if (notice) root.append(notice);
     if (detail?.batch.seedCohort) {
       const seed = detail.batch.seedCohort;
        const release = typeof seed.version === 'string' ? seed.version : seed.version?.release || 'Recorded source version';
        const admission = seed.version?.discovery?.admissionSummary;
       root.append(n('section', { class: 'batch-scope', 'aria-label': 'Discovery seed source' },
         n('h2', {}, 'Open-data discovery · unverified seeds'),
         p(`${seed.provider || 'Recorded open-data source'} · ${release || 'See retained source version'} · ${seed.items?.length ?? 'Unknown'} seed records`, 'meta'),
          p('Seeds identify businesses to investigate; they are not qualification or website-absence evidence. Fresh identity, location, activity, website and media checks still apply.'),
          seed.version?.discovery?.mode === 'houston_local_radius_v1' ? p('Approximate local discovery only; Houston city eligibility remains unknown.', 'meta') : null,
          admission ? p(`${admission.sampled} sampled · ${admission.admitted} retained · ${admission.quarantined} quarantined. Retained records are still unverified; quarantined records cannot be selected.`, 'meta') : null,
         disclosure(ctx, 'seed-source-' + detail.batch.id, 'Recorded source attribution', [
           p(typeof seed.attribution === 'string' ? seed.attribution : JSON.stringify(seed.attribution || []), 'meta'),
           p(`Receipt ${seed.id} · ${seed.digest}`, 'meta')])));
     }
    if (!active && detail) root.append(savedOutcome(ctx, detail, root));
    if (detail && active?.id === detail.batch.id) root.append(batchProgress(ctx, detail, isHistorical(overview, detail.batch)));
    if (!active && outcome(detail?.batch || { state: 'active' }, detail?.jobs)?.kind !== 'research_not_run') root.append(n('section', { class: 'batch-launch batch-launch-compact', 'aria-label': 'Start a private Houston batch' },
      n('div', { class: 'batch-launch-copy' }, n('h2', {}, preset.adopted ? 'Your next private run.' : 'Start with your scope.'), !preset.adopted ? choose : start,
        startError,
        p(!preset.adopted ? 'Choose your scope once below. This preset has not been adopted.' : active ? 'Your existing batch is below. Finish or stop it before another run.' : `${preset.settings.area} · ${preset.settings.niche}`, 'meta'),
          p('Private concepts only. Nothing is sent or published.', 'batch-quiet'),
          disclosure(ctx,'start-limits','Search limits',[scope(ctx,preset.settings,'Approved limits for the next run')]))));
    const entry = n('section', { class: 'lead-entry' }, n('h2', {}, 'Find leads, then choose one'), p('Use the guided workflow instead of automatic batch building.'), button('Use two-step setup', () => { ui.drafts.setup = { ...(ui.drafts.setup || preset.settings), workflow: 'leads_first', targetCount: 1, discoverySearchLimit: Math.max(1, Math.floor(Number((ui.drafts.setup || preset.settings).maxSearches) / 2)) }; ui.setupOpen = true; ui.expanded.settings=true; ctx.render(); }, 'secondary'));
    // Terminal history must not bury the next workflow. Keep open-run actions
    // primary, and retain any explicitly requested historical-context notice.
    if (preset.settings.workflow !== 'leads_first') root.append(entry);
    if (detail && active?.id !== detail.batch.id) root.append(disclosure(ctx,'previous-'+detail.batch.id,'Previous run: '+(terminalOutcome(detail)?.title || batchLabel(detail.batch,detail.jobs)),[batchProgress(ctx,detail,isHistorical(overview,detail.batch))],Boolean(requested),'previous-run'));
     root.append(assistedPanel(ctx, overview));
     root.append(disclosure(ctx,'settings','Search settings',[
      preset.adopted ? scope(ctx,preset.settings,detail?'Saved preferences for the next run':'Saved setup') : null,
      setup(ctx, preset, Boolean(detail)), n('section', { class: 'batch-readiness' }, n('h2', {}, 'Local prerequisites only'), p('Checks installed tools and local configuration only. Does not test model sign-in, live search, public-page access or business supply. Nothing starts.', 'muted'),
      button('Check local readiness', async e => { try { ui.readiness = await ctx.op('batch_readiness', {}, e.currentTarget); ctx.render(); } catch { /* announced */ } }),
      ui.readiness ? n('div', { class: 'batch-readiness-result' }, p(ui.readiness.ready ? 'Local prerequisites available for a bounded attempt — not live-verified.' : 'A required local prerequisite or selected-source configuration needs attention. Nothing has started.', 'truth-label'),
        ui.readiness.model ? p(`Factory model: ${ui.readiness.model} · explicit route, not a model sign-in or live intake test.`, 'meta') : null,
        ui.readiness.boundary ? p(ui.readiness.boundary.ready ? `Houston boundary: Ready for recorded release ${ui.readiness.boundary.recordedRelease}. This local check does not verify the latest upstream release or business supply.` : 'Houston boundary: Not ready. Exact native boundary setup needs separate explicit authorization before open-data seed discovery. This local check does not warm sources.', 'meta') : null,
        ui.readiness.selectedSource ? p(ui.readiness.selectedSource === 'guest_bing' ? 'Guest public Bing: selected; live search not tested.' : ui.readiness.sourceStatus === 'needs_configuration' ? 'Firecrawl: selected; configuration needed.' : 'Firecrawl: configuration present; authentication and live search not tested.', 'meta') : null,
        n('ul', {}, (ui.readiness.checks || []).map(c => n('li', {}, `${c.name}: ${c.name === 'preview_vault' ? 'optional; not checked by this action' : c.name === 'firecrawl' && ui.readiness.selectedSource !== 'firecrawl' ? 'optional; not selected' : c.status}`)))) : null,
        p('Guest search respects blocks. Firecrawl needs existing configured access. Scrapling and Google Maps collection are not connected. Open-data seeds, when explicitly prepared and bound to a run, are unverified discovery pointers only. External owner-review delivery still needs a separately authorized supported route.', 'meta')),
      n('section', {class:'batch-readiness','aria-label':'Optional Camofox diagnostics'},n('h2',{},'Optional Camofox service'),
        p('Operator-triggered local diagnostics only. No tab, login, browser launch or reader switch. Persistence and network-isolation review is still required before using Camofox as a guest reader.','meta'),
        button('Check optional Camofox',async e=>{try{ui.camofox=await ctx.op('camofox_status',{enabled:true},e.currentTarget);ctx.render();}catch{/* announced; no automatic retry */}}),
        ui.camofox ? p(ui.camofox.serviceReachable ? `Camofox: service reachable; browser not launch-tested. Browser ${ui.camofox.browserRunning?'running':'stopped'}${ui.camofox.version?` · API ${ui.camofox.version}`:''}. Reader not enabled.` : 'Camofox: service unavailable or disabled. The selected research reader is unchanged.','truth-label') : null)
    ],!preset.adopted||ui.setupOpen,'search-settings'));
    if (location.hash.split('/')[2] === 'checkpoint') { const heading = root.querySelector('#batch-checkpoint-heading'); heading?.focus(); heading?.scrollIntoView({ block: 'start' }); }
  }); }
  function reviewNote(ctx, b, c, item) {
    const n = ctx.node, key = 'note-' + b.id + '-' + c.id, id = 'inbox-note-' + c.id;
    const dirty = ctx.p(ui.drafts[key] ? 'Unsaved review note' : 'Saving a note does not change or accept the site.', 'batch-draft meta');
    const textarea = n('textarea', { id, required: true, maxlength: 1500 }); textarea.value = ui.drafts[key]?.note ?? '';
    const form = n('form', { class: 'batch-note-form', onsubmit: async e => {
      e.preventDefault(); const payload = { id: b.id, candidateId: c.id, disposition: form.querySelector('select').value, note: textarea.value };
      const result = await mutate(ctx, 'batch_item_note', { ...payload, requestId: requestFor(key, payload) }, form.querySelector('[type=submit]'), 'Review note saved. No site changed or accepted.'); if (result) { delete ui.drafts[key]; await ctx.refresh(); }
    }, oninput: () => { ui.drafts[key] = { note: textarea.value, disposition: form.querySelector('select').value }; dirty.textContent = 'Unsaved review note'; } }, n('label', { for: id }, 'Review note for ' + c.name), textarea, select(ctx, 'Review disposition for ' + c.name, 'disposition-' + c.id, [['note', 'Note only'], ['needs_changes', 'Needs changes — hold automatic work'], ['not_a_fit', 'Not a fit — retain, do not rebuild']], ui.drafts[key]?.disposition ?? item.disposition ?? 'note'), dirty, n('button', { type: 'submit', class: 'secondary small' }, 'Save review note'));
    return n('details', { class: 'batch-contact' }, n('summary', {}, 'Review note & disposition'), item.note ? ctx.p(item.note) : null, form);
  }
  function itemCard(ctx, b, item) {
    const { node: n, p, link } = ctx, c = item.candidate, j = item.job;
    return n('article', { class: 'batch-item' }, item.capture ? n('a', { href: '#jobs/' + j.id, class: 'batch-capture' }, n('img', { src: '/files/' + item.capture.id, alt: `${c.name} · actual desktop proposal capture`, loading: 'lazy' })) : n('div', { class: 'batch-capture-placeholder' }, p(j ? 'Work retained.\nPreview evidence is not ready.' : 'Research before design.', 'muted')),
      n('div', { class: 'batch-item-content' }, p(labels[item.status] || item.status, 'kicker'), n('h2', {}, c.name), p(c.summary), p(item.whyFit, 'meta'),
        item.note ? p(`Saved disposition: ${item.disposition === 'needs_changes' ? 'Needs changes — hold automatic work' : item.disposition === 'not_a_fit' ? 'Not a fit — retain, do not rebuild' : 'Note only'}`, 'batch-note-saved') : null,
        item.note ? p(item.note, 'batch-saved-note meta') : null,
        ui.drafts['note-' + b.id + '-' + c.id] ? p('Draft edits retained — not saved', 'batch-note-marker meta') : null,
        j?.outputs.siteRelative ? n('div', { class: 'files' }, link('Review website', '#review/'+j.id, 'primary'), link('Open interactive website', `${ctx.state.session.previewOrigin}/site/${j.id}/index.html`, 'action-link')) : null,
        item.reasons?.length ? n('ul', { class: 'batch-reasons' }, item.reasons.map(reason => n('li', {}, reason))) : null, j && ['failed', 'blocked', 'cancelled'].includes(j.state) ? p(j.message, 'inline-message') : null,
        b.exports[j?.id]?.status === 'held' ? p('Saved proposal; library export needs attention. Inspect the retained job.', 'inline-message') : null,
        n('details', { class: 'batch-contact' }, n('summary', {}, 'Public contact & unsent draft'), p(item.contact.nextAction), item.contact.options.map(o => n('div', { class: 'contact-option' }, n('strong', {}, o.channel), p(o.value), link('Published business source ↗', o.sourceUrl, 'action-link'))), item.contact.draft ? n('div', {}, p('Unsent draft · no owner link attached', 'kicker'), n('blockquote', {}, item.contact.draft)) : null,
          p('No sending permission or externally accessible owner-review link exists here. Never send localhost. A public phone does not authorize cold SMS.', 'meta')),
        n('details', { class: 'batch-contact' }, n('summary', {}, 'Sources & unresolved facts'), n('ul', {}, c.facts.map(f => n('li', {}, f.text, ' ', link('Source ↗', f.sourceUrl)))), n('ul', {}, c.unknowns.map(v => n('li', {}, v)))), reviewNote(ctx, b, c, item)));
  }
  function inbox(ctx) { return load(ctx, async root => {
    const { node: n, p, link, button } = ctx, overview = await ctx.op('batch_status', { offset: ui.offset, limit: 20 }); if (!root.isConnected) return;
    const currentOverview = ui.offset ? await ctx.op('batch_status', { offset: 0, limit: 20 }) : overview; if (!root.isConnected) return;
    const selected = location.hash.split('/')[1] || overview.items[0]?.id;
    if (selected !== ui.noteBatch) { ui.noteBatch = selected; ui.noteOffset = 0; ui.filter = 'all'; }
    const detail = selected ? await ctx.op('batch_get', { id: selected, offset: ui.noteOffset, limit: 20 }) : null; if (!root.isConnected) return;
    window.FactoryBatchHasActive = currentOverview.items.some(b => b.state === 'active');
    if(!location.hash.split('/')[1]){
      const sites=ctx.state.data.jobs.filter(j=>j.kind==='site'&&j.outputs.siteRelative),latest=new Map();
      for(const j of sites)if(!latest.has(j.input.candidateId))latest.set(j.input.candidateId,j);
      const card=j=>{
        const name=ctx.state.data.candidates.find(c=>c.id===j.input.candidateId)?.name||'Saved private website';
        const capture=ctx.state.data.siteCaptures?.find(a=>a.relative===`${j.outputs.qaRelative}/index-first-1440.png`||a.relative===`${j.outputs.qaRelative}/index-1440.png`);
        return n('article',{class:'website-card'},capture?link(n('img',{src:'/files/'+capture.id,alt:name+' · recorded website preview',loading:'lazy'}),'#review/'+j.id):null,
          n('div',{},n('h2',{},name),p(j.state==='review_ready'&&j.outputs.reviewStatus==='operator_review_required'?'Ready for your review':'Needs attention — not a finished website','meta'),link('Review website','#review/'+j.id,'primary')));
      };
      root.replaceChildren(p('Private concepts only. Review is not acceptance or publication.','muted'));
      if(latest.size)root.append(n('div',{class:'website-shelf'},[...latest.values()].map(card)));
      else root.append(ctx.empty('No completed websites yet.','Find leads and choose one business. A site appears here after design starts.'),link('Find leads','#start','primary'));
      if(detail)root.append(disclosure(ctx,'website-results','Latest search results',[p(`${detail.batch.counts.researched} saved businesses; ${detail.batch.counts.ready} websites ready from this run.`),link('View retained results','#inbox/'+detail.batch.id,'action-link')]));
      const older=sites.filter(j=>latest.get(j.input.candidateId)?.id!==j.id);
      if(older.length)root.append(disclosure(ctx,'website-versions','Previous versions ('+older.length+')',older.map(card)));
      return;
    }
    root.replaceChildren(p('Every result keeps its sources, version and next step. Ready for review is not accepted, sent or sold.', 'batch-inbox-intro'));
    const notice = historyNotice(ctx, currentOverview, detail?.batch); if (notice) root.prepend(notice);
    if (!detail) { root.append(ctx.empty('No batch to review yet.', 'Finished concepts and held research appear here after a saved run. Opening this screen generates nothing.'), link('Start with one-time setup ↗', '#start', 'primary'), link('Open preserved proposals ↗', '#jobs', 'action-link')); return; }
    const checkpointPending = ['awaiting_first_review', 'held'].includes(detail.batch.state) && !detail.batch.checkpoint && detail.jobs.some(j => j.kind === 'site' && j.input.candidateId === detail.batch.firstCandidateId && j.state === 'review_ready');
    root.append(n('div', { class: 'batch-inbox-heading' }, n('div', {}, n('h2', {}, batchLabel(detail.batch, detail.jobs)), p(`${detail.batch.counts.ready} sites ready · ${detail.batch.counts.researched} businesses researched · ${detail.batch.counts.shortfall} short of target`, 'meta')), link(checkpointPending ? 'Review first site & continuation checkpoint ↗' : 'Batch progress & controls ↗', '#start/' + detail.batch.id + (checkpointPending ? '/checkpoint' : ''), 'secondary small')),
      n('details', { class: 'batch-history batch-picker' }, n('summary', {}, `Choose a saved batch · ${ctx.stamp(detail.batch.createdAt)} · ${detail.batch.settings.niche}`), overview.items.map(b => link(`${ctx.stamp(b.createdAt)} · ${batchLabel(b)} · ${b.settings.niche} ↗`, '#inbox/' + b.id, 'action-link')), ui.offset ? button('Newer batches', () => { ui.offset = Math.max(0, ui.offset - 20); ctx.render(); }) : null, overview.nextOffset !== null ? button('Older batches', () => { ui.offset = overview.nextOffset; ctx.render(); }) : null));
    const result = outcome(detail.batch, detail.jobs);
    if (result) root.append(p(result.explanation), outcomeNextStep(result, isHistorical(currentOverview, detail.batch)) ? p(outcomeNextStep(result, isHistorical(currentOverview, detail.batch)), 'inline-message') : null, technical(ctx, detail));
    if (!detail.items.length && !result) root.append(ctx.empty('Research is not a finished website.', 'The first sourced business or hold will appear here. See progress for the running stage.'));
    const attention = item => ['held', 'blocked', 'failed', 'cancelled', 'needs_changes', 'not_a_fit', 'suppressed'].includes(item.status) || Boolean(item.reasons?.length) || detail.batch.exports[item.job?.id]?.status === 'held';
    const ready = item => item.status === 'review_ready' && !attention(item);
    const filter = value => { ui.filter = value; ui.focusFilter = true; ctx.render(); };
    if (detail.items.length) root.append(n('div', { class: 'batch-filters', role: 'group', 'aria-label': 'Filter review inbox' }, [['all', 'All', detail.items.length], ['ready', 'Ready to review', detail.items.filter(ready).length], ['attention', 'Needs attention', detail.items.filter(attention).length]].map(([value, label, count]) => n('button', { type: 'button', class: 'secondary small', 'aria-pressed': ui.filter === value ? 'true' : 'false', onclick: () => filter(value) }, `${label} (${count})`))));
    const items = detail.items.filter(item => ui.filter === 'all' || (ui.filter === 'ready' ? ready(item) : attention(item)));
    if (detail.items.length && !items.length) root.append(ctx.empty('No results in this filter.', 'All retained results are still available.'), button('Show all results', () => filter('all'), 'secondary'));
    for (const item of items) root.append(itemCard(ctx, detail.batch, item));
    if (detail.noteHistory.total) root.append(n('section', { class: 'batch-history', 'aria-label': 'Batch review notes' }, ctx.sectionTop('Supplied review notes', `${detail.noteHistory.total} RETAINED / NOT ACCEPTANCE`),
      n('ul', { class: 'pilot-history' }, detail.noteHistory.items.map(note => n('li', {}, p(note.note), p(`${ctx.stamp(note.at)} · ${note.disposition.replaceAll('_', ' ')}`, 'meta')))),
      ui.noteOffset ? button('Newer review notes', () => { ui.noteOffset = Math.max(0, ui.noteOffset - 20); ctx.render(); }) : null,
       detail.noteHistory.nextOffset !== null ? button('Older review notes', () => { ui.noteOffset = detail.noteHistory.nextOffset; ctx.render(); }) : null));
    if (ui.focusFilter) { ui.focusFilter = false; root.querySelector('.batch-filters [aria-pressed=true]')?.focus({ preventScroll: true }); }
  }); }
  const leadUI = { offset: 0, state: '', scope: null, confirmation: null, error: null };
  function storedSelection() { try { return JSON.parse(sessionStorage.getItem('factory-lead-selection')); } catch { return null; } }
  // INVALID_INPUT is the service's pre-dispatch schema guard. The other
  // codes are batch_build_selected guards before any selection/job/receipt write
  // in its transaction (src/batches.mjs). Never extend this to generic HTTP or
  // unknown errors, or IDEMPOTENCY_CONFLICT: those cannot establish no commit.
  const selectionNotStarted = new Set(['INVALID_INPUT', 'STALE_EVIDENCE', 'BATCH_POLICY', 'BATCH_DEADLINE', 'BATCH_SELECTION', 'BATCH_SCREENING', 'BATCH_BUDGET','BATCH_COMPLETION_BUDGET']);
  function sources(ctx) {
    const n = ctx.node;
    return n('details', { class: 'lead-capabilities' }, n('summary', {}, 'Source capabilities'), n('dl', {},
      n('dt', {}, 'Firecrawl search'), n('dd', {}, 'Configured adapter only; requires local readiness. Not authentication proof, a page connector or a media connector.'),
      n('dt', {}, 'Public Facebook / Instagram · guest search'), n('dd', {}, 'Limited public evidence. Blocks stay holds; no login bypass.'),
      n('dt', {}, 'Maps/Places · Booksy bulk · licensed providers'), n('dd', {}, 'Not connected.'),
      n('dt', {}, 'External owner-review delivery'), n('dd', {}, 'Not connected. No sending, publication or owner link.')));
  }
  async function submitSelection(ctx, intent, control) {
    if (ui.busy) return;
    // Persist the full immutable operation intent before dispatch. Never store credentials.
    sessionStorage.setItem('factory-lead-selection', JSON.stringify(intent));
    const result = await mutate(ctx, 'batch_build_selected', intent, control, 'Selected business saved. Enrichment comes before production.', e => {
      if (selectionNotStarted.has(e.code)) {
        sessionStorage.removeItem('factory-lead-selection');
        leadUI.error = `Selection did not start: ${e.message}. Reading the current saved evidence and run limits. Only an eligible lead can be confirmed again explicitly; expired, stopped or already selected runs remain unavailable.`;
      } else leadUI.error = `Selection response not confirmed: ${e.message}. Check the same saved request; do not select a different business. Stale evidence, expired time or held work needs inspection, not a new attempt.`;
    });
    if (result) { sessionStorage.removeItem('factory-lead-selection'); leadUI.confirmation = null; leadUI.error = null; location.hash = 'leads/' + intent.id; }
    await ctx.refresh(); // Exact replay returns an old receipt; batch_get below reads current state.
  }
  function confirmation(ctx, item, b) {
    const { node: n, p, button } = ctx;
    const intent = { id: b.id, candidateId: item.candidateId, evidenceDigest: item.evidenceDigest, requestId: crypto.randomUUID(), authorized: true };
    const dialog = n('dialog', { class: 'lead-confirm', 'aria-labelledby': 'lead-confirm-title', onclose: () => { leadUI.confirmation = null; dialog.remove(); } },
      n('h2', { id: 'lead-confirm-title' }, 'Make a website for ' + item.name + '?'),
       p('We first check this business’s identity, existing website, current activity, facts and photographs. Design starts only if those checks pass. Missing evidence stops this business; another will not be substituted.'),
      p(`Remaining attempts: ${Math.max(0, b.settings.maxSearches - b.usage.searches)} searches · ${Math.max(0, b.settings.maxInspections - b.usage.inspections)} page reads · ${Math.max(0, b.settings.maxImageViews - b.usage.imageViews)} image views · ${Math.max(0, b.settings.maxModelRequests - b.usage.modelRequests)} native launches.`),
      p(`Original deadline: ${ctx.stamp(b.deadlineAt)}. Selection does not reset time or usage. One business only; no replacement after a hold.`),
       n('div', { class: 'files' }, button('Cancel', () => dialog.close()), button('Check business & create website', async e => { await submitSelection(ctx, intent, e.currentTarget); dialog.close(); }, 'primary')));
    document.body.append(dialog); dialog.showModal();
  }
  function leads(ctx) {
    window.FactoryLeadsReady = false;
    return load(ctx, async root => {
      const { node: n, p, link, button } = ctx;
      const overview=await ctx.op('batch_status',{limit:20});
      const batchId=location.hash.split('/')[1]||overview.items.find(b=>openStates.includes(b.state))?.id||overview.items[0]?.id||null;
      if (leadUI.scope !== batchId) { leadUI.scope = batchId; leadUI.offset = 0; }
      const result = await ctx.op('lead_list', { offset: leadUI.offset, limit: 20, ...(batchId ? { batchId } : {}), ...(leadUI.state ? { state: leadUI.state } : {}) });
      const detail = batchId ? await ctx.op('batch_get', { id: batchId }) : null;
      if (!root.isConnected) return;
      window.FactoryBatchHasActive = detail?.batch.state === 'active';
      const pending = storedSelection();
      root.replaceChildren();
      if (pending) root.append(n('aside', { class: 'lead-pending', 'aria-label': 'Unconfirmed selection' }, p(leadUI.error || 'Selection response not confirmed. The exact saved request is retained. No automatic retry and no different business selection.'), button('Check same selection request', e => submitSelection(ctx, pending, e.currentTarget), 'primary'), link('Inspect selected run ↗', '#start/' + pending.id, 'action-link')));
      else if (leadUI.error) root.append(n('aside', { class: 'lead-pending', role: 'status', 'aria-label': 'Selection did not start' }, p(leadUI.error)));
      if (detail) {
        const b = detail.batch;
        const site=detail.items.find(item=>item.job?.outputs.siteRelative)?.job;
        const result=outcome(b,detail.jobs), retained=terminalOutcome(detail);
        root.append(n('section', { class: 'lead-run-summary', 'aria-label': 'Lead run progress' }, n('h2', {}, result?.kind==='no_selectable_prospect'?result.title:retained?.shortTitle || retained?.title || (['held', 'stopped', 'complete'].includes(b.state) ? labels[b.state] : b.phase === 'enrichment' ? 'Checking this business — no website yet.' : b.phase === 'production' ? 'Designing and testing your website.' : labels[b.state] || b.state)),
          p(result?.explanation||(['stopped','complete'].includes(b.state)?'This run has ended. No selection or automatic restart is available.':b.state==='held'?'Work is held. Inspect the saved reason before any further action.':b.selection?'One business selected. The website is not finished until design and checks pass.':'Choose one business below. Full business and photo checks come before design.')),
          site?link('Review website','#review/'+site.id,'primary'):null,
          link('Run details & controls', '#start/' + b.id, 'action-link')),window.FactoryProgress.create(ctx,detail,{compact:true}));
      }
      const shortlist=n('section',{class:'lead-shortlist','aria-label':'Business shortlist'}),others=[];
      const selectedId=detail?.batch.selection?.candidateId;
      if(!result.items.some(item=>item.canSelect||item.id===selectedId)){
        shortlist.append(ctx.empty(detail?.batch.state==='active'?'Checking for suitable businesses.':'No business is ready to choose.',detail?.batch.state==='active'?'Saved results appear when the current checks finish.':'No completed website is promised. Uncertain and excluded results are retained below.'));
        if(!detail)shortlist.append(link('Find leads','#start','primary'));
      }
      root.append(shortlist);
      for (const item of result.items) {
        const label = item.suppressed ? 'Suppressed' : item.duplicate ? 'Duplicate — held' : ({ strong: 'Promising', held: 'Needs verification / source limited', excluded: 'Excluded / existing site', booking_only: 'Booking only', ready: 'Build evidence ready' })[item.state];
        const make = button('Make this website', async () => {
          const current = await ctx.op('batch_get', { id: item.batchId });
          confirmation(ctx, item, current.batch);
        }, 'primary');
        make.disabled = !item.canSelect || Boolean(pending);
        const sourceLink = (label, url, literal = false) => {
          const unavailable = () => p(`${label}: ${String(url || 'unavailable').split(/[?#]/)[0].slice(0, 300)} (not a safe public page link).`, 'meta');
          try {
            const u = new URL(url), host = u.hostname.toLowerCase();
            if (/(^|\.)(fbcdn\.net|cdninstagram\.com)$/.test(host) || /\.(?:jpe?g|png|webp|gif|mp4)$/i.test(u.pathname)) return p(label + ': media destination withheld; no raw media URL shown.', 'meta');
            if (u.username || u.password) return p(label + ': credential-bearing destination withheld.', 'meta');
            const accountQuery = /(^|\.)(facebook\.com)$/.test(host) && u.pathname === '/profile.php' && /^\?id=\d+$/.test(u.search);
            const localeQuery = /(^|\.)(instagram\.com)$/.test(host) && /^\/[A-Za-z0-9._-]+\/?$/.test(u.pathname) && /^\?hl=[a-z]{2}(?:-[A-Z]{2})?$/.test(u.search);
            if (!['https:', 'http:'].includes(u.protocol) || u.hash || (u.search && !accountQuery && !localeQuery) || !host.includes('.') || /(^|\.)(localhost|local|internal)$/.test(host) || /^[\d.]+$/.test(host) || host.includes(':')) return unavailable();
            const anchor = link(label + ' · ' + host + ' ↗', u.href, 'action-link');
            return literal ? n('div', {}, anchor, p(u.href, 'meta')) : anchor;
          } catch { return p(label + ': source unavailable (not a safe public page link).', 'meta'); }
        };
        const savedCandidate = detail?.items.find(saved => saved.candidate.id === item.candidateId)?.candidate;
        const check = savedCandidate?.websiteCheck;
        const officialDestinations = item.websiteStatus === 'independent_official_site' ? [...new Set([check?.status === 'official_site_found' ? check.url : null, ...(check?.linkChecks || []).filter(check => check.status === 'official').map(check => check.url)].filter(Boolean))] : [];
        const savedFacts = (savedCandidate?.facts || []).slice(0, 5);
        const furtherEvidence=[
          n('h3', {}, 'Website'), p(item.websiteStatus === 'independent_official_site' ? 'Observed: independent official website. Excluded from no-site production.' : item.websiteStatus === 'no_official_site_found' ? 'No official site found in the saved checks; not proof that none exists.' : item.websiteStatus === 'booking_only' ? 'Observed: booking destination only. This production route is unsupported.' : 'Unknown: website absence is not established. Blocked or unresolved destinations stay unknown.'),
          item.websiteStatus === 'independent_official_site' ? n('div', {}, p('Recorded website-check destinations — not a new fetch.', 'meta'), officialDestinations.length ? officialDestinations.map(url => sourceLink('Recorded official destination', url, true)) : p('Recorded official destination unavailable.', 'meta')) : null,
          n('h3', {}, 'Location'), n('div',{class:'lead-screening',role:'group','aria-label':'Early screening'},p(item.screening?`Saved location/service-area check: ${item.screening.geography}. Early screening: ${item.screening.status.replaceAll('_',' ')}.`:'Unknown: no current host-bound location screening recorded. Old evidence has not been silently requalified.','meta')),
          n('h3', {}, 'Recorded facts'), savedFacts.length ? n('ul', { class: 'lead-facts' }, savedFacts.map(fact => n('li', {}, p(fact.text), sourceLink('Recorded fact source', fact.sourceUrl)))) : p('Saved facts unavailable; no claims added.', 'meta'),
          n('h3', {}, 'Activity & photos'), p(item.material ? `${item.material.datedActivity ? 'Observed: dated activity evidence retained' : 'Unknown: qualifying dated activity not established'} · ${item.material.observedPhotoCount} observed photo routes. Actual image review is ${item.material.pixelsViewed ? 'recorded' : 'not established by this material check'}.` : 'Unknown: activity and material feasibility not established by a saved material check.'),
          p(`Photographs: ${item.photoEvidence.selected} selected · ${item.photoEvidence.status.replaceAll('_',' ')}. Public licence: unconfirmed.`, 'meta'),
          n('h3', {}, 'Retained reasons'), n('ul', { class: 'lead-reasons' }, [...new Set([...(item.screening?.reasons || []), ...item.reasons, ...item.missingEvidence])].map(reason => n('li', {}, reason))),
          n('h3', {}, 'Sources & public contacts'), p(`Last evidence observation: ${ctx.stamp(item.lastCheckedAt)}. Valid until: ${ctx.stamp(item.evidenceValidUntil)}.`, 'meta'),
          item.sources.map(s => n('div', {}, sourceLink('Observed source', s.url), p(`Observed ${ctx.stamp(s.checkedAt)}`, 'meta'))),
          item.contacts.length ? item.contacts.map(c => n('div', {}, p(`${c.channel}: ${c.value}`), sourceLink('Contact source', c.sourceUrl), p(`${ctx.stamp(c.observedAt)} · ${c.authority}`, 'meta'))) : p('Unknown: no sourced public contact recorded.'),
          item.bookingDestinations.map(url => sourceLink('Observed booking destination', url)),
          item.researchJobId ? link('Research history ↗', '#jobs/' + item.researchJobId, 'action-link') : null];
        const chosen=item.id===selectedId;
        const card=n('article',{class:'lead-row'},n('div',{},p(chosen?'Selected business':item.canSelect?'Ready for full checks':label,'lead-label'),n('h2',{},item.name),p(`${item.area} · ${item.category||'Category not recorded'}`,'meta'),
          p(item.canSelect?'Public business evidence passed early screening. We still need to verify the full facts and photographs before design.':leadDecision(item),'lead-decision'),
          chosen?p('This is the only business selected for this run. Missing evidence holds it; another business will not replace it.','meta'):null,
          disclosure(ctx,'lead-'+item.id,'Evidence: Website / Location / Activity & photos',furtherEvidence)),
          n('div',{class:'lead-row-actions'},item.canSelect?make:null));
        if(item.canSelect||chosen)shortlist.append(card);else others.push(card);
      }
      root.append(disclosure(ctx,'other-'+batchId,'Other results ('+others.length+')',[
        p('Held, excluded and earlier evidence stays here. These are not build-ready businesses.','meta'),
        n('div', { class: 'batch-filters', role: 'group', 'aria-label': 'Filter leads' }, [['', 'All leads'], ['strong', 'Promising'], ['held', 'Needs verification'], ['excluded', 'Excluded / existing site'], ['booking_only', 'Booking only'], ['ready', 'Build evidence ready']].map(([value, label]) => n('button', { type: 'button', class: 'secondary small', 'aria-pressed': leadUI.state === value, onclick: () => { leadUI.state = value; leadUI.offset = 0; leadUI.focusFilter = true; ui.expanded['other-'+batchId]=true; ctx.render(); } }, label))),others,
        !result.items.length?ctx.empty('No saved leads in this view.','Opening this screen creates no work.'):null
      ],Boolean(leadUI.state),'other-results'),
      n('div', { class: 'files' }, leadUI.offset ? button('Previous leads', () => { leadUI.offset = Math.max(0, leadUI.offset - 20); ctx.render(); }) : null, result.nextOffset !== null ? button('More leads', () => { leadUI.offset = result.nextOffset; ctx.render(); }) : null), sources(ctx));
      if (leadUI.focusFilter) { leadUI.focusFilter = false; root.querySelector('.batch-filters [aria-pressed=true]')?.focus({ preventScroll: true }); }
      window.FactoryLeadsReady = true;
    });
  }
  return { home, inbox, leads };
})();
