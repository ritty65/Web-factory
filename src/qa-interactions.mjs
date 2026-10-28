// Host-owned adapters. Untrusted contracts supply validated IDs and expected data only.
const byId = (page, id) => page.locator(`[id="${id}"]`);
const normalized = value => value.replace(/\s+/g, ' ').trim();
async function uniqueVisible(locator) {
  if (await locator.count() !== 1 || !await locator.isVisible()) return false;
  // Playwright layout visibility deliberately includes opacity:0. Required task
  // output must also be painted through its complete ancestor chain.
  return locator.evaluate(element => {
    for (let e = element; e; e = e.parentElement) {
      const style = getComputedStyle(e);
      if (Number(style.opacity) <= 0 || style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return false;
    }
    return true;
  });
}
async function outputMatches(page, output) {
  const node = byId(page, output.id);
  if (!await uniqueVisible(node) || normalized(await node.textContent()) !== normalized(output.text)) return false;
  if (output.photo) {
    const image = node.locator('img');
    if (!await uniqueVisible(image)) return false;
    return image.evaluate((img, photo) => img.complete && img.naturalWidth > 0 && new URL(img.currentSrc || img.src).href === new URL(photo, document.baseURI).href, output.photo);
  }
  return true;
}
// A gallery trigger may be a real link to the exact declared photograph. That is
// a genuine native no-JS destination, not an inert enhancement-only control.
async function galleryPhotoControl(control, contract) {
  if (contract.kind !== 'gallery') return false;
  return control.evaluate((element, { targetId, outputIds }) => {
    if (element.tagName !== 'A') return false;
    const root = document.getElementById(targetId);
    const outputId = element.getAttribute('data-gallery-open');
    if (!root?.contains(element) || !outputIds.includes(outputId)) return false;
    const output = document.getElementById(outputId);
    const image = output && root.contains(output) ? output.querySelector('img') : null;
    if (!image) return false;
    return new URL(element.href, document.baseURI).href === new URL(image.currentSrc || image.src, document.baseURI).href;
  }, { targetId: contract.targetId, outputIds: contract.outputs.filter(output => output.photo).map(output => output.id) });
}
async function membership(page, contract, state) {
  for (const output of contract.outputs) {
    const node = byId(page, output.id);
    if (await node.count() !== 1 || !await byId(page, contract.targetId).evaluate((root, id) => root.contains(document.getElementById(id)), output.id)) return false;
    if (state.outputIds.includes(output.id)) { if (!await outputMatches(page, output)) return false; }
    else if (await node.isVisible()) return false;
  }
  if (['filter', 'planning'].includes(contract.kind)) {
    for (const s of contract.states) if (await byId(page, s.controlId).getAttribute('aria-pressed') !== String(s.controlId === state.controlId)) return false;
  }
  return true;
}
async function settled(page, root) {
  // Finite animations only; no unbounded wait on ambient/looping target content.
  // Re-check after waiting because a scroll-triggered reveal can start after the
  // first animation snapshot and would otherwise race the completion check.
  const complete = await root.evaluate(async e => {
    const deadline = performance.now() + 1000;
    for (;;) {
      const running = e.getAnimations({ subtree: true }).filter(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity);
      if (!running.length) return true;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      let timer;
      await Promise.race([Promise.all(running.map(a => a.finished.catch(() => {}))), new Promise(resolve => { timer = setTimeout(resolve, Math.min(remaining, 250)); })]);
      clearTimeout(timer);
    }
  });
  if (!complete) throw new Error('Signature finite transition did not settle within the bounded task-state wait');
}
export async function checkInteraction(page, contract, capture = async () => {}) {
  const result = { name: 'signature_contract', contractVersion: 1, kind: contract.kind, targetId: contract.targetId, pass: false, checks: [] };
  try {
    const root = byId(page, contract.targetId);
    if (!await uniqueVisible(root)) throw new Error('Declared target missing, duplicate or invisible');
    for (const state of contract.states) {
      const control = byId(page, state.controlId);
      if (!await uniqueVisible(control)) throw new Error('Declared native control missing or outside target');
      const native = await control.evaluate((e, id) => document.getElementById(id)?.contains(e) && (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY'), contract.targetId);
      if (!(native || await galleryPhotoControl(control, contract))) throw new Error('Declared native control missing or outside target');
    }
    const activate = async (state, mode = 'click', shouldCapture = false) => {
      const control = byId(page, state.controlId);
      if (contract.kind === 'details') {
        const open = await control.evaluate(e => e.parentElement.tagName === 'DETAILS' ? e.parentElement.open : null);
        if (open === null) throw new Error('Declared details control is not a native summary');
        if (open === Boolean(state.outputIds.length)) {
          if (mode !== 'keyboard') return;
          // Exercise keyboard toggling even when the pointer left the desired state.
          await control.focus(); await page.keyboard.press('Enter');
        }
      }
      if (mode === 'keyboard') { await control.focus(); await page.keyboard.press('Enter'); }
      else if (mode === 'touch') await control.tap();
      else await control.click();
      if (shouldCapture && await root.evaluate(e => e.getAnimations({ subtree: true }).some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity))) await capture('signature-intermediate', state.id);
      await settled(page, root);
      if (!await membership(page, contract, state)) throw new Error(`Incorrect visible output/selection for ${state.id}`);
      if (shouldCapture) await capture('signature-settled', state.id);
    };
    const closeGallery = async (state, explicit) => {
      const dialog = root.locator('dialog[open]');
      if (await dialog.count() !== 1) throw new Error('Expected one native photo dialog');
      const close = dialog.locator('button[data-gallery-close]');
      if (explicit && !await uniqueVisible(close)) throw new Error('Missing explicit photo close button');
      // Native focus restoration precedes the queued close event:
      // https://html.spec.whatwg.org/multipage/interactive-elements.html#close-the-dialog
      // Arm and acknowledge before dismissal; never wait for/repair correct focus.
      const observer = await dialog.evaluateHandle(element => {
        let resolve, timer, frame, done = false;
        const promise = new Promise(r => { resolve = r; });
        const finish = value => {
          if (done) return;
          done = true;
          clearTimeout(timer); cancelAnimationFrame(frame);
          element.removeEventListener('close', onClose);
          resolve(value);
        };
        const onClose = () => {
          // A second frame also covers first-frame work queued by page close
          // handlers, regardless of listener/animation-frame callback ordering.
          frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => finish(true));
          });
        };
        element.addEventListener('close', onClose, { once: true });
        timer = setTimeout(() => finish(false), 1000);
        return { promise, cancel: () => finish(false) };
      });
      try {
        if (explicit) await close.click();
        else await page.keyboard.press('Escape');
        if (!await observer.evaluate(value => value.promise)) throw new Error('Photo dismissal close event/frame did not settle within the bounded wait');
        if (await root.locator('dialog[open]').count() || !await byId(page, state.controlId).evaluate(e => document.activeElement === e)) throw new Error('Photo dismissal must restore trigger focus');
      } finally {
        try { await observer.evaluate(value => value.cancel()); } finally { await observer.dispose(); }
      }
    };
    const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
    for (const [index, state] of contract.states.entries()) {
      await activate(state, touch ? 'touch' : 'click', index === 1);
      if (contract.kind === 'gallery') await closeGallery(state, true);
      await activate(state, 'keyboard');
      if (contract.kind === 'gallery') await closeGallery(state, false);
      result.checks.push({ stateId: state.id, pointer: touch ? 'touch' : 'click', keyboard: true, pass: true });
    }
    if (contract.kind !== 'gallery' && contract.kind !== 'details') {
      // Dispatch real successive activations without awaiting each animation.
      for (const state of [contract.states[0], contract.states[1], contract.states[0]]) await byId(page, state.controlId).click();
      await settled(page, root);
      if (!await membership(page, contract, contract.states[0])) throw new Error('Rapid A-B-A/reset produced stale output');
      result.checks.push({ name: 'rapid_A_B_A_reset', pass: true });
    }
    if (contract.kind === 'gallery') {
      // Modal photos must be dismissed before another trigger can be reached.
      const sequence = [contract.states[0], contract.states[1], contract.states[0]];
      for (const [index, state] of sequence.entries()) {
        await byId(page, state.controlId).click();
        if (index === sequence.length - 1) {
          await settled(page, root);
          if (!await membership(page, contract, state)) throw new Error('Rapid photo A-B-A produced stale output');
        }
        await closeGallery(state, false);
      }
      result.checks.push({ name: 'rapid_A_B_A_reset', pass: true, note: 'Successive modal replacement with Escape, no intermediate animation waits' });
    }
    result.pass = true;
  } catch (error) { result.note = String(error.message).slice(0, 500); }
  return result;
}

export async function checkInteractionFallback(page, contract) {
  const result = { name: 'signature_no_js', pass: false, targetId: contract.targetId };
  try {
    const root = byId(page, contract.targetId);
    if (!await uniqueVisible(root)) return result;
    if (contract.kind !== 'details') {
      for (const id of new Set(contract.states.map(s => s.controlId))) {
        const control = byId(page, id);
        if (await control.count() && await control.isVisible() && !await galleryPhotoControl(control, contract)) return { ...result, note: 'Enhancement-only controls must not be inert in the no-JS fallback' };
      }
    }
    if (contract.kind === 'details') {
      const summary = byId(page, contract.states[0].controlId);
      if (!await summary.evaluate(e => e.parentElement.open)) await summary.click(); // Native disclosure still works without JS.
    }
    for (const output of contract.outputs) {
      const contained = await root.evaluate((e, id) => e.contains(document.getElementById(id)), output.id);
      if (contained && await outputMatches(page, output)) continue;
      if (contract.kind !== 'gallery' || !output.photo) return result;
      const links = root.locator('a[href]'); let linked = false;
      for (let i = 0; i < await links.count(); i++) {
        const link = links.nth(i);
        if (await uniqueVisible(link) && normalized(await link.textContent()) === normalized(output.text) && await link.evaluate((a, photo) => a.href === new URL(photo, document.baseURI).href, output.photo)) linked = true;
      }
      if (!linked) return result;
    }
    result.pass = true;
  } catch (error) { result.note = String(error.message).slice(0, 500); }
  return result;
}
