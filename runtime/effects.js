/* Host-owned progressive effects. No content waits for JS or a scroll gate. */
(() => {
  'use strict';
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const desktop = window.matchMedia?.('(min-width: 1024px) and (hover: hover) and (pointer: fine)');
  const fine = window.matchMedia?.('(hover: hover) and (pointer: fine)');
  const roots = [...document.querySelectorAll('[data-effect]')].slice(0, 20);
  const animations = new Set(), seen = new WeakSet(), stacks = [], magnets = [], galleries = [];
  const supported = !!reduce && typeof Element.prototype.animate === 'function';
  let frame = 0;
  const moving = () => supported && !reduce.matches && !document.hidden;
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  function animate(element, frames, delay = 0) {
    if (!moving()) return;
    const a = element.animate(frames, {duration: 600, delay, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'none', id: 'factory-effect-entry'});
    animations.add(a);
    const done = () => animations.delete(a);
    a.addEventListener('finish', done, {once: true}); a.addEventListener('cancel', done, {once: true});
  }
  function enter(root) {
    if (seen.has(root)) return;
    seen.add(root);
    if (root.dataset.effect === 'clip-reveal') animate(root, [{clipPath: 'inset(0 0 38% 0)', transform: 'translateY(12px)'}, {clipPath: 'inset(0 0 0% 0)', transform: 'none'}]);
    if (root.dataset.effect === 'split-text') [...root.querySelectorAll('[data-effect-word]')].forEach((word, i) => animate(word, [{transform: 'translateY(12px) rotate(2deg)', opacity: .55}, {transform: 'none', opacity: 1}], Math.min(i * 24, 144)));
  }
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { enter(e.target); observer.unobserve(e.target); }
  }, {threshold: .08}) : null;

  function stackFrame() {
    frame = 0;
    for (const {root, cards} of stacks) {
      const fits = cards.every(c => c.getBoundingClientRect().height + cards.length * 12 + 40 < innerHeight);
      const enabled = moving() && desktop?.matches && fits && !root.matches(':focus-within');
      root.toggleAttribute('data-effects-stack', !!enabled);
      const top = root.getBoundingClientRect().top;
      cards.forEach((card, i) => {
        if (enabled) {
          const p = clamp((20 - top - i * Math.max(100, card.offsetHeight)) / Math.max(100, card.offsetHeight), 0, 1);
          card.style.transform = `scale(${(1 - p * .04).toFixed(4)})`;
        } else card.style.removeProperty('transform');
      });
    }
  }
  function schedule() { if (stacks.length && !frame) frame = requestAnimationFrame(stackFrame); }
  function stop() {
    for (const a of animations) a.cancel(); animations.clear();
    for (const label of magnets) label.style.removeProperty('transform');
    for (const gallery of galleries) gallery.stop();
    if (frame) cancelAnimationFrame(frame); frame = 0;
    for (const {root, cards} of stacks) { root.removeAttribute('data-effects-stack'); cards.forEach(c => c.style.removeProperty('transform')); }
  }
  for (const root of roots) {
    const type = root.dataset.effect;
    if (type === 'magnetic') {
      const label = [...root.children].find(c => c.hasAttribute('data-effect-label'));
      if (!label || !root.matches('button,a[href]')) continue;
      magnets.push(label);
      root.addEventListener('pointermove', event => {
        if (!moving() || !fine?.matches || event.pointerType === 'touch') return;
        const r = root.getBoundingClientRect();
        label.style.transform = `translate(${clamp((event.clientX - r.left - r.width / 2) * .12, -6, 6)}px,${clamp((event.clientY - r.top - r.height / 2) * .12, -6, 6)}px)`;
      });
      for (const event of ['pointerleave', 'pointercancel', 'blur', 'focus']) root.addEventListener(event, () => label.style.removeProperty('transform'));
    } else if (type === 'split-text') {
      if (!root.matches('h1,h2,h3,h4,h5,h6') || root.children.length) continue;
      const text = root.textContent;
      // Same text, spaces and wrapping. No duplicate announcement to screen readers.
      root.setAttribute('aria-label', text);
      root.replaceChildren(...text.split(/(\s+)/).filter(Boolean).map(part => {
        if (/^\s+$/.test(part)) return document.createTextNode(part);
        const span = document.createElement('span'); span.setAttribute('data-effect-word', ''); span.setAttribute('aria-hidden', 'true'); span.textContent = part; return span;
      }));
      if (observer) observer.observe(root);
    } else if (type === 'clip-reveal') {
      if (observer) observer.observe(root);
    } else if (type === 'sticky-stack') {
      const cards = [...root.children].filter(c => c.hasAttribute('data-effect-card'));
      if (cards.length < 3) continue;
      cards.forEach((c, i) => c.style.setProperty('--effect-index', i)); stacks.push({root, cards});
      root.addEventListener('focusin', () => { stackFrame(); document.activeElement?.scrollIntoView?.({block:'nearest'}); });
      root.addEventListener('focusout', schedule);
    } else if (type === 'drag-gallery') {
      const track = root.querySelector('[data-effect-track]'), prev = root.querySelector('[data-effect-prev]'), next = root.querySelector('[data-effect-next]');
      if (!track || !prev || !next) continue;
      let drag = null, inertia = 0, suppressClick = false;
      const stopInertia = () => { if (inertia) cancelAnimationFrame(inertia); inertia = 0; if (!drag) track.removeAttribute('data-effects-dragging'); };
      const stopDrag = () => { if (drag && track.hasPointerCapture?.(drag.id)) track.releasePointerCapture(drag.id); drag = null; if (!inertia) track.removeAttribute('data-effects-dragging'); };
      const stopGallery = () => { stopInertia(); stopDrag(); suppressClick = false; };
      galleries.push({stop: stopGallery});
      const move = delta => { stopInertia(); track.scrollBy({left: delta, behavior: 'auto'}); };
      prev.addEventListener('click', () => move(-track.clientWidth * .8));
      next.addEventListener('click', () => move(track.clientWidth * .8));
      track.addEventListener('keydown', e => {
        if (e.target !== track || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault(); stopInertia();
        if (e.key === 'Home' || e.key === 'End') track.scrollLeft = e.key === 'Home' ? 0 : track.scrollWidth;
        else move((e.key === 'ArrowLeft' ? -1 : 1) * track.clientWidth * .8);
      });
      track.addEventListener('pointerdown', e => {
        stopInertia(); suppressClick = false;
        // Native touch scrolling remains responsible for vertical gesture arbitration.
        if (e.pointerType !== 'mouse' || e.button !== 0 || e.target.closest('button,input,select,textarea')) return;
        drag = {id: e.pointerId, x: e.clientX, start: e.clientX, left: track.scrollLeft, at: performance.now(), velocity: 0, moved: false};
      });
      track.addEventListener('pointermove', e => {
        if (!drag || drag.id !== e.pointerId) return;
        if (!drag.moved && Math.abs(e.clientX - drag.start) < 6) return;
        drag.moved = true; suppressClick = true;
        track.setPointerCapture?.(e.pointerId); track.setAttribute('data-effects-dragging', '');
        const now = performance.now(); drag.velocity = clamp((drag.x - e.clientX) / Math.max(8, now - drag.at), -1.6, 1.6);
        track.scrollLeft = drag.left + drag.start - e.clientX; drag.x = e.clientX; drag.at = now;
        e.preventDefault();
      });
      track.addEventListener('pointerup', e => {
        if (!drag || drag.id !== e.pointerId) return;
        const velocity = performance.now() - drag.at < 100 ? drag.velocity : 0, moved = drag.moved;
        stopDrag();
        if (!moved || !moving() || Math.abs(velocity) < .05) return;
        track.setAttribute('data-effects-dragging', '');
        const start = performance.now(); let previous = start, speed = velocity;
        const tick = now => {
          inertia = 0; if (!moving() || now - start > 600 || Math.abs(speed) < .03) { track.removeAttribute('data-effects-dragging'); return; }
          const dt = Math.min(32, now - previous), before = track.scrollLeft;
          track.scrollLeft += speed * dt; speed *= Math.pow(.90, dt / 16); previous = now;
          if (Math.abs(track.scrollLeft - before) > .1) inertia = requestAnimationFrame(tick); else track.removeAttribute('data-effects-dragging');
        };
        inertia = requestAnimationFrame(tick);
      });
      track.addEventListener('click', e => { if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; } }, true);
      track.addEventListener('pointercancel', stopGallery);
      track.addEventListener('lostpointercapture', stopDrag);
      track.addEventListener('dragstart', e => e.preventDefault());
      track.addEventListener('wheel', stopInertia, {passive: true});
      root.setAttribute('data-effects-ready', '');
    } else continue;
    root.dataset.effectsReady = '';
  }
  for (const query of [reduce, desktop, fine]) {
    const changed = () => { stop(); schedule(); };
    if (query?.addEventListener) query.addEventListener('change', changed); else query?.addListener(changed);
  }
  document.addEventListener('visibilitychange', () => { stop(); if (!document.hidden) schedule(); });
  for (const name of ['blur', 'pagehide']) window.addEventListener(name, stop);
  window.addEventListener('scroll', schedule, {passive: true});
  window.addEventListener('resize', () => { for (const g of galleries) g.stop(); schedule(); }, {passive: true});
  if (typeof ResizeObserver === 'function') { const sizes = new ResizeObserver(schedule); for (const s of stacks) sizes.observe(s.root); }
  schedule();
})();
