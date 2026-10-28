/* Native mechanisms, not a customer-site template. Content is NEVER hidden pending JS.
 * https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API
 * https://developer.mozilla.org/en-US/docs/Web/API/Element/animate
 * Use a dedicated wrapper for data-scroll-depth; do not override its transform.
 */
(() => {
  'use strict';
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const phone = window.matchMedia?.('(max-width: 767px), (pointer: coarse)');
  const active = new Map(), seen = new WeakSet();
  const depths = [...document.querySelectorAll('[data-scroll-depth]')].slice(0, 16);
  const supported = Boolean(reduce && typeof IntersectionObserver === 'function' && typeof Element.prototype.animate === 'function');
  const ease = 'cubic-bezier(.16,1,.3,1)';
  let pending = 0;

  function enter(element, { kind = element?.dataset.reveal || 'rise', duration = 640, delay = 0 } = {}) {
    if (!element || !supported || reduce.matches || document.hidden) return null;
    active.get(element)?.cancel();
    const frames = kind === 'wipe'
      ? [{ clipPath: 'inset(0 0 18% 0)', transform: 'translateY(18px)', opacity: .7 }, { clipPath: 'inset(0 0 0% 0)', transform: 'none', opacity: 1 }]
      : kind === 'settle'
        ? [{ transform: 'translateY(24px) rotate(2deg) scale(.98)', opacity: .75 }, { transform: 'none', opacity: 1 }]
        : [{ transform: 'translateY(20px)', opacity: .55 }, { transform: 'none', opacity: 1 }];
    const animation = element.animate(frames, { duration: Math.max(180, Math.min(800, duration)), delay: Math.max(0, Math.min(180, delay)), easing: ease, fill: 'none', id: 'factory-entry' });
    element.dataset.motionState = 'running'; active.set(element, animation);
    for (const name of ['finish', 'cancel']) animation.addEventListener(name, () => {
      if (active.get(element) === animation) { active.delete(element); element.dataset.motionState = 'settled'; }
    }, { once: true });
    return animation;
  }
  function cancel() {
    for (const [element, animation] of active) { animation.cancel(); element.dataset.motionState = 'settled'; }
    active.clear();
    if (pending) cancelAnimationFrame(pending); pending = 0;
    for (const element of depths) element.style.removeProperty('transform');
  }
  function depthFrame() {
    pending = 0;
    if (!supported || reduce.matches || phone?.matches || document.hidden) {
      for (const element of depths) element.style.removeProperty('transform'); return;
    }
    const positions = depths.map(element => ({ element, rect: element.getBoundingClientRect() }));
    for (const { element, rect } of positions) {
      if (rect.bottom < -40 || rect.top > innerHeight + 40) continue;
      const distance = Math.max(0, Math.min(24, Number(element.dataset.scrollDepth) || 16));
      const progress = Math.max(-1, Math.min(1, (innerHeight / 2 - (rect.top + rect.height / 2)) / innerHeight));
      element.style.transform = `translate3d(0,${(progress * distance).toFixed(2)}px,0)`;
    }
  }
  function schedule() { if (!pending) pending = requestAnimationFrame(depthFrame); }
  const preferenceChanged = () => { cancel(); if (!reduce?.matches) schedule(); };
  for (const query of [reduce, phone]) {
    if (query?.addEventListener) query.addEventListener('change', preferenceChanged);
    else query?.addListener(preferenceChanged);
  }
  document.addEventListener('visibilitychange', () => { cancel(); if (!document.hidden) schedule(); });
  window.addEventListener('pagehide', cancel);
  window.SiteMotion = Object.freeze({ enter, cancel, version: 2 });
  if (!supported) return;

  const observer = new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting || seen.has(target)) continue;
      seen.add(target); observer.unobserve(target);
      if (reduce.matches) { target.dataset.motionState = 'settled'; continue; }
      enter(target, { delay: Number(target.dataset.revealDelay) || 0 });
    }
  }, { threshold: .08 });
  for (const element of document.querySelectorAll('[data-reveal]')) observer.observe(element);
  if (depths.length) {
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true }); schedule();
  }
})();
