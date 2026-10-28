import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { treeHashes } from './proposal.mjs';
import { fail, hash, now, safeRelative, SITE_EXTENSIONS } from './contracts.mjs';
import { noLinks } from './db.mjs';
import { MIME } from './server.mjs';
import { observePerformance, settleImages, sweepPage, sampleScrollMotion, inspectFirstScreen } from './qa-motion.mjs';
import { validateInteraction } from './interaction-contract.mjs';
import { checkInteraction, checkInteractionFallback } from './qa-interactions.mjs';
import {PREMIUM_PROFILE, validateEffectsPlan, effectsDigest} from './effects-contract.mjs';
import {observeEffectFrames, checkEffects, checkEffectsFallback} from './qa-effects.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
export const VIEWPORTS = [[1440, 900], [1280, 720], [768, 1024], [390, 844], [320, 740]];

export async function staticAudit(siteRoot, { candidate, media = [], pageCount = 5 } = {}) {
  const files = await treeHashes(siteRoot), issues = []; let total = 0, js = 0, css = 0;
  const issue = (code, file, detail) => issues.push({ code, file, detail });
  const allowedLinks = new Set([...(candidate?.sourceUrls || []), ...(candidate?.facts || []).map(f => f.sourceUrl), ...media.flatMap(m => [m.post_url, m.account]), ...Object.values(candidate?.contacts || {})].filter(v => typeof v === 'string' && /^https:/.test(v)));
  const checkReference = (value, file, resource = false) => {
    value = value.trim().replace(/&amp;/g, '&');
    if (!value || value === '#') return issue('EMPTY_REFERENCE', file, value || '(empty)');
    if (value.startsWith('tel:')) { if (value.slice(4).replace(/\D/g, '') !== String(candidate?.contacts?.phone || '').replace(/\D/g, '') || !candidate?.contacts?.phone) issue('CONTACT_MISMATCH', file, 'Telephone does not match published evidence'); return; }
    if (value.startsWith('mailto:')) { if (value.slice(7).split('?')[0].toLowerCase() !== String(candidate?.contacts?.email || '').toLowerCase() || !candidate?.contacts?.email) issue('CONTACT_MISMATCH', file, 'Email does not match published evidence'); return; }
    if (/^https:\/\//.test(value)) { if (resource || !allowedLinks.has(value)) issue(resource ? 'REMOTE_RESOURCE' : 'UNVERIFIED_EXTERNAL_LINK', file, 'External destination is not an approved business source'); return; }
    if (value.startsWith('/') || /^(?:[a-z]+:|\\)/i.test(value)) { issue('NONPORTABLE_REFERENCE', file, 'Root/absolute/protocol references are not portable'); return; }
    const [withoutFragment] = value.split('#'); const [pathname] = withoutFragment.split('?');
    if (!pathname) return;
    try { const normalized = path.posix.join(path.posix.dirname(file), decodeURIComponent(pathname)); safeRelative(normalized); if (!files[normalized]) issue('MISSING_REFERENCE', file, normalized); } catch { issue('UNSAFE_REFERENCE', file, 'Reference escapes the proposal tree'); }
  };
  for (const [file, digest] of Object.entries(files)) {
    const ext = path.extname(file); const bytes = await readFile(path.join(siteRoot, file)); total += bytes.length;
    if (!SITE_EXTENSIONS.has(ext)) issue('UNSUPPORTED_FILE', file, 'Unsupported static file');
    if (ext === '.js') js += bytes.length; if (ext === '.css') css += bytes.length;
    if (['.html', '.css', '.js', '.svg'].includes(ext)) {
      const content = bytes.toString();
      if (/<base\b|http-equiv\s*=|<iframe\b|<object\b|<embed\b|<form[^>]+action\s*=\s*["']?(?:https?:|\/\/)|\bon[a-z]+\s*=/i.test(content)) issue('UNSUPPORTED_RUNTIME', file, 'Unsafe/unsupported embedding, handler, base, refresh or remote form');
      if (/\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon\s*\(|serviceWorker|eval\s*\(|new\s+Function\b|import\s*\(|document\.cookie)/.test(content)) issue('UNSUPPORTED_RUNTIME', file, 'Networking, generated code and credential access are not supported');
      if (/\b(?:signature|access_token|api_key|client_secret)\s*[=:]/i.test(content) || /\/home\/ai_dev|\/tmp\/opencode/.test(content)) issue('PRIVATE_DATA', file, 'Private staging/path/credential marker must not enter a site');
      if (ext === '.html') {
        if (!/<title[^>]*>[^<]+<\/title>/i.test(content) || !/<meta[^>]+name=["']viewport["']/i.test(content)) issue('DOCUMENT_META', file, 'A title and viewport are required');
        for (const m of content.matchAll(/\b(src|href|poster|action)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) checkReference(m[2] ?? m[3], file, m[1].toLowerCase() !== 'href' || /\.(?:css|js|woff2?|ttf)(?:[?#]|$)/i.test(m[2] ?? m[3]));
        for (const m of content.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) for (const item of (m[1] ?? m[2]).split(',')) checkReference(item.trim().split(/\s+/)[0], file, true);
      }
      for (const m of content.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi)) checkReference(m[1], file, true);
      if (/@import\b/i.test(content)) issue('CSS_IMPORT', file, 'CSS imports are not supported');
    }
    if (/\.(webp|jpe?g|png)$/i.test(file) && !media.some(m => m.web_file.replace(/^site\//, '') === file && m.web_sha256 === digest)) issue('UNTRACKED_IMAGE', file, 'Raster imagery must match the intended-use manifest');
  }
  if (Object.keys(files).filter(f => f.endsWith('.html')).length !== pageCount || !files['index.html']) issue('PAGE_COUNT', '', `Exactly ${pageCount} useful page(s) including index.html required`);
  if (total > 2 * 1024 * 1024 || js > 50 * 1024 || css > 50 * 1024) issue('SITE_BUDGET', '', '2MiB/50KiB JS/50KiB CSS budget exceeded');
  return { pass: issues.length === 0, issues, siteHashes: files, bytes: { total, js, css } };
}
export async function staticPreview(siteRoot) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; frame-src 'none'");
    try {
      if (req.headers.host !== `127.0.0.1:${server.address().port}` || !['GET', 'HEAD'].includes(req.method)) throw new Error();
      const relative = safeRelative(decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.slice(1)) || 'index.html');
      const target = path.join(siteRoot, relative); await noLinks(target); const info = await stat(target);
      if (!info.isFile() || info.size > 2 * 1024 * 1024 || !MIME[path.extname(relative)]) throw new Error();
      res.setHeader('content-type', MIME[path.extname(relative)]); res.end(req.method === 'HEAD' ? undefined : await readFile(target));
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) };
}

// Browser route interception and blocked service workers follow official APIs:
// https://playwright.dev/docs/api/class-browsercontext#browser-context-route
// Default Axe rules: https://playwright.dev/docs/accessibility-testing
export async function checkSite({ siteRoot, outputRoot, candidate, media = [], signal, interaction = null, effectsPlan = null }) {
  const audit = await staticAudit(siteRoot, { candidate, media });
  if(effectsPlan) {
    effectsPlan=validateEffectsPlan(effectsPlan,{candidate,media,pages:Object.keys(audit.siteHashes).filter(f=>f.endsWith('.html'))});
    for(const ext of ['js','css']) {
      const file='assets/factory-effects.'+ext;
      if(audit.siteHashes[file]!==hash(await readFile(new URL('../runtime/effects.'+ext,import.meta.url))))audit.issues.push({code:'EFFECTS_RUNTIME',file,detail:'Premium builds require the exact protected host runtime'});
    }
    for(const file of Object.keys(audit.siteHashes).filter(f=>f.endsWith('.html'))) {
      const html=await readFile(path.join(siteRoot,file),'utf8');
      if(!/<script\b[^>]*\bdefer\b[^>]*\bsrc=["']assets\/factory-effects\.js["'][^>]*>/i.test(html)&&!/<script\b[^>]*\bsrc=["']assets\/factory-effects\.js["'][^>]*\bdefer\b[^>]*>/i.test(html))audit.issues.push({code:'EFFECTS_RUNTIME',file,detail:'Every premium page must load the deferred effect runtime'});
      if(!/<link\b[^>]*\bhref=["']assets\/factory-effects\.css["'][^>]*>/i.test(html))audit.issues.push({code:'EFFECTS_RUNTIME',file,detail:'Every premium page must load the effect stylesheet'});
    }
    audit.pass=!audit.issues.length;
  }
  const signature = interaction ? validateInteraction(interaction, { candidate, media, pages: Object.keys(audit.siteHashes).filter(f => f.endsWith('.html')), legacy: true }) : null;
  await noLinks(outputRoot); await mkdir(outputRoot, { recursive: true, mode: 0o750 });
  const report = { at: now(), policy: 'craft-2', pass: false, siteHashes: audit.siteHashes, siteDigest: hash(audit.siteHashes), staticAudit: audit, issues: [...audit.issues], pageChecks: [], axe: [], interactions: [], captures: [], performance: [], scroll: [], coverage: 'Actual isolated Chromium; 5 pages × 5 widths, default installed Axe, all-page keyboard/gallery/filter/disclosure, normal/fast/reverse scroll, intermediate captures, live finite/infinite reduced-motion, API-absent/no-JS, landscape and 200% root-text checks. Local loading/CLS/LCP/long-task samples are lab observations, not field CWV, certified fps, other engines, physical devices, full WCAG or human acceptance.' };
  report.signatureCoverage = signature?.version === 1 ? 'declared_contract_v1' : signature?.coverage || 'not_declared';
  report.signatureContract = signature?.version === 1 ? signature : null;
  if(effectsPlan)Object.assign(report,{designProfile:PREMIUM_PROFILE,effectsPlan,effectsDigest:effectsDigest(effectsPlan),effectsChecks:[]});
  if (!audit.pass) { await writeFile(path.join(outputRoot, 'results.json'), JSON.stringify(report, null, 2)); return report; }
  const preview = await staticPreview(siteRoot), browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true });
  const external = [], errors = [], resources = [];
  const abort = () => browser.close().catch(() => {}); signal?.addEventListener('abort', abort, { once: true });
  const pages = Object.keys(audit.siteHashes).filter(f => f.endsWith('.html'));
  report.loading = [];
  async function context(options = {}) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, ...options });
    await ctx.addInitScript(observePerformance);
    if(effectsPlan)await ctx.addInitScript(observeEffectFrames);
    await ctx.route('**/*', async route => { const u = route.request().url(); if (u.startsWith(preview.url + '/') && ['GET', 'HEAD'].includes(route.request().method())) return route.continue(); external.push({ type: route.request().resourceType(), note: 'Blocked non-site request' }); return route.abort(); });
    ctx.on('page', page => { page.on('pageerror', e => errors.push(e.message.slice(0, 300))); page.on('response', r => { if (r.status() >= 400) resources.push({ status: r.status(), file: new URL(r.url()).pathname }); }); page.on('dialog', dialog => dialog.dismiss()); });
    return ctx;
  }
  const settled = page => settleImages(page);
  try {
    const ctx = await context(); const page = await ctx.newPage(); page.setDefaultTimeout(5000);
    for (const [width, height] of VIEWPORTS) {
      await page.setViewportSize({ width, height });
      for (const file of pages) {
        if (signal?.aborted) fail('CANCELLED', 'QA cancelled');
        await page.goto(`${preview.url}/${file}`, { waitUntil: 'load', timeout: 20000 }); await settled(page);
        const loading = await inspectFirstScreen(page); report.loading.push({ file, viewport: [width, height], ...loading });
        if (audit.siteHashes['assets/factory-motion.js'] && (!loading.sized || !loading.eagerFirstScreen || !loading.primaryVisible)) report.issues.push({ code: 'FIRST_SCREEN', file, viewport: [width, height], sized: loading.sized, eagerFirstScreen: loading.eagerFirstScreen, primaryVisible: loading.primaryVisible });
        if (width === 1440 || width === 390) {
          const relative = `${file.replace('.html', '')}-first-${width}.png`;
          await page.screenshot({ path: path.join(outputRoot, relative) }); report.captures.push({ relative, file, viewport: [width, height], kind: 'first_screen' });
          report.performance.push({ file, viewport: [width, height], ...await page.evaluate(() => ({ ...window.__factoryPerformance, sampleWindowMs: performance.now() - (window.__factoryPerformance?.start || 0), resources: performance.getEntriesByType('resource').length })), note: 'Fresh local Chromium navigation; no throttling, field/INP or physical-device claim. CLS is a sampled sum, not a session-window field metric.' });
        }
        const sweep = await sweepPage(page); report.scroll.push({ file, viewport: [width, height], ...sweep });
        if (!sweep.pass) report.issues.push({ code: 'SCROLL_MEDIA', file, viewport: [width, height], ...sweep });
        if(effectsPlan) {
          const checks=await checkEffects(page,effectsPlan,{file,width,candidate,capture:async effect=>{
            if(width!==1280&&width!==390)return;
            const relative=`${file.replace('.html','')}-effect-${effect.targetId}-${width}.png`;
            await page.screenshot({path:path.join(outputRoot,relative)});
            report.captures.push({relative,file,viewport:[width,height],kind:'effect-state',effectType:effect.type,targetId:effect.targetId});
          }});
          report.effectsChecks.push({file,viewport:[width,height],pass:checks.every(c=>c.pass),checks});
          if(checks.some(c=>!c.pass))report.issues.push({code:'EFFECTS_BEHAVIOR',file,viewport:[width,height],failures:checks.filter(c=>!c.pass)});
          // Effect probes scroll/focus/reduce the page. Restore it before layout captures.
          await page.evaluate(()=>window.scrollTo(0,0));
        }
        const metrics = await page.evaluate(() => ({ title: document.title, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, main: document.querySelectorAll('main').length, h1: document.querySelectorAll('h1').length, current: document.querySelectorAll('nav [aria-current="page"]').length, brokenImages: Array.from(document.images).filter(i => !i.naturalWidth).length, deadFragments: Array.from(document.querySelectorAll('a[href^="#"]')).filter(a => a.hash.length > 1 && !document.getElementById(decodeURIComponent(a.hash.slice(1)))).length }));
        const pass = metrics.scrollWidth <= width + 1 && metrics.main === 1 && metrics.h1 === 1 && metrics.current >= 1 && !metrics.brokenImages && !metrics.deadFragments;
        report.pageChecks.push({ file, viewport: [width, height], pass, metrics }); if (!pass) report.issues.push({ code: 'PAGE_LAYOUT', file, viewport: [width, height], metrics });
        if (width === 1440 || width === 390) { const name = `${file.replace('.html', '')}-${width}.png`; await page.screenshot({ path: path.join(outputRoot, name), fullPage: true }); report.captures.push({ relative: name, file, viewport: [width, height], kind: 'full_page' }); }
        if (width === 1440) { const axe = await new AxeBuilder({ page }).analyze(); report.axe.push({ file, violations: axe.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })), incomplete: axe.incomplete.map(v => ({ id: v.id, nodes: v.nodes.length })) }); if (axe.violations.length) report.issues.push({ code: 'AXE', file, violations: axe.violations.map(v => v.id) }); }
      }
    }
    // Every important page, not just index: galleries/FAQs normally live inside.
    for (const file of pages) {
      for (const [width, height] of [[1280, 720], [390, 844]]) {
        await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.setViewportSize({ width, height }); await page.goto(`${preview.url}/${file}`); await settled(page);
        const requireObserved = signature?.version === 1 && file === signature.page && Boolean(signature.motionTargetId);
        const motion = await sampleScrollMotion(page, async kind => {
          const relative = `${file.replace('.html', '')}-${kind}-${width}.png`; await page.screenshot({ path: path.join(outputRoot, relative) }); report.captures.push({ relative, file, viewport: [width, height], kind });
        }, { targetId: requireObserved ? signature.motionTargetId : null, requireObserved });
        report.interactions.push({ file, viewport: [width, height], name: 'scroll_motion_fallback', pass: motion.liveReduced.pass && motion.visibleFallback && motion.reducedDepthReset !== false && (!requireObserved || motion.motionObservation?.pass === true), evidence: motion });
      }
      if (signature?.version === 1 && file === signature.page) {
        for (const [width, height] of [[1280, 720], [390, 844]]) {
          const taskContext = await context({ viewport: { width, height }, hasTouch: width === 390 });
          try {
            const taskPage = await taskContext.newPage(); taskPage.setDefaultTimeout(5000);
            for (const reducedMotion of ['no-preference', 'reduce']) {
              await taskPage.emulateMedia({ reducedMotion }); await taskPage.goto(`${preview.url}/${file}`); await settled(taskPage);
              // Chromium paints a transient UA tap highlight on touch activation. It is
              // capture-process evidence, not page content; suppress it only in this
              // signature-capture context so settled frames are not misread as a defect.
              await taskPage.addStyleTag({ content: '*{-webkit-tap-highlight-color:transparent!important}' });
              const result = await checkInteraction(taskPage, signature, async (kind, stateId) => {
                if (reducedMotion !== 'no-preference') return;
                const relative = `${file.replace('.html', '')}-${kind}-${width}.png`;
                await taskPage.screenshot({ path: path.join(outputRoot, relative) });
                report.captures.push({ relative, file, viewport: [width, height], kind, stateId, interactionId: signature.targetId });
              });
              report.interactions.push({ file, viewport: [width, height], reducedMotion, ...result });
            }
          } finally { await taskContext.close(); }
        }
      }
      await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.setViewportSize({ width: 1280, height: 720 }); await page.goto(`${preview.url}/${file}`); await settled(page);
      await page.keyboard.press('Tab'); const focus = await page.evaluate(() => document.activeElement?.tagName); report.interactions.push({ file, name: 'keyboard_focus', pass: focus === 'A' || focus === 'BUTTON' });
      const disclosure = page.locator('details summary').first();
      if (await disclosure.count()) { const initial = await disclosure.evaluate(e => e.parentElement.open); await disclosure.focus(); await page.keyboard.press('Enter'); const changed = await disclosure.evaluate(e => e.parentElement.open); await page.keyboard.press('Enter'); report.interactions.push({ file, name: 'native_disclosure', pass: changed !== initial && await disclosure.evaluate(e => e.parentElement.open) === initial }); }
      const galleries = page.locator('[data-gallery-open]');
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
        for (let i = 0; i < Math.min(await galleries.count(), 6); i++) {
          await galleries.nth(i).click(); const dialog = page.locator('dialog[open]'); const opened = await dialog.count() === 1;
          let imageUsable = false;
          if (opened) { await settled(page); imageUsable = await dialog.evaluate(d => Array.from(d.querySelectorAll('img')).every(i => i.naturalWidth > 0)); const name = `${file.replace('.html', '')}-dialog-${i}-${width}.png`; await page.screenshot({ path: path.join(outputRoot, name) }); report.captures.push({ relative: name, file, viewport: [width, width === 390 ? 844 : 720] }); }
          await page.keyboard.press('Escape'); report.interactions.push({ file, viewport: width, name: 'photo_dialog', pass: opened && imageUsable && await page.locator('dialog[open]').count() === 0 });
        }
      }
      const filters = page.locator('[data-filter]');
      if (await filters.count() > 1) { await filters.nth(1).click(); const active = await filters.nth(1).getAttribute('aria-pressed'); await filters.first().click(); report.interactions.push({ file, name: 'content_filter', pass: active === 'true' && await filters.first().getAttribute('aria-pressed') === 'true' }); }
      await page.setViewportSize({ width: 1280, height: 720 }); await page.reload(); await settled(page);
      const infinite = await page.evaluate(() => document.getAnimations().filter(a => a.effect?.getTiming().iterations === Infinity).length);
      if (infinite) {
        const toggle = page.locator('[data-motion-toggle]').first(), target = page.locator('[data-ambient]').first();
        if (!await toggle.count() || !await target.count()) report.interactions.push({ file, name: 'automatic_motion_pause', pass: false, note: 'Infinite motion requires a first-screen explicit control and an observed decorated target' });
        else { const box = await toggle.boundingBox(), sample = () => target.evaluate(e => getComputedStyle(e).transform); const a = await sample(); await page.waitForTimeout(300); const b = await sample(); await toggle.click(); const c = await sample(); await page.waitForTimeout(300); const d = await sample(); report.interactions.push({ file, name: 'automatic_motion_pause', pass: a !== b && c === d && box.y + box.height <= 720 }); }
      }
      await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForTimeout(100);
      const activeMotion = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).length); report.interactions.push({ file, name: 'live_reduced_motion', pass: activeMotion === 0 });
      await page.setViewportSize({ width: 844, height: 390 }); await page.reload(); await settled(page); report.interactions.push({ file, name: 'landscape_reflow', pass: await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1) });
      await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      report.interactions.push({ file, name: 'large_root_text', pass: await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), note: '200% root text size; not a complete browser-zoom/assistive-technology audit' });
      await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));
    }
    const required = { gallery: 'photo_dialog', details: 'native_disclosure', filter: 'content_filter' }[signature?.version === 1 ? null : signature?.kind];
    if (required && !report.interactions.some(i => i.name === required)) report.issues.push({ code: 'SIGNATURE_UNTESTED', expected: required });
    await ctx.close();
    const nojs = await context({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } }); const p = await nojs.newPage();
    const nojsPages = []; for (const file of pages) { await p.goto(`${preview.url}/${file}`); const task = signature?.version === 1 && file === signature.page ? await checkInteractionFallback(p, signature) : null; nojsPages.push({ file, ...(task ? { signature: task } : {}), pass: task?.pass !== false && await p.locator('main h1').isVisible() && await p.locator('a[href]').count() >= 5 && await p.locator('[data-reveal]').evaluateAll(es => es.every(e => Number(getComputedStyle(e).opacity) > 0 && getComputedStyle(e).visibility !== 'hidden')) }); }
    if(effectsPlan)for(const entry of nojsPages){await p.goto(`${preview.url}/${entry.file}`);entry.effects=await checkEffectsFallback(p,effectsPlan,entry.file);entry.pass&&=entry.effects.pass;}
    report.noJavaScript = { pass: nojsPages.every(v => v.pass), pages: nojsPages, note: 'All five pages: primary content/navigation without JS. Still not full manual accessibility certification.' }; await nojs.close();
    const fallback = await context({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }); await fallback.addInitScript(() => { window.IntersectionObserver = undefined; Element.prototype.animate = undefined; });
    const fp = await fallback.newPage(); const fallbackPages = [];
    for (const file of pages) { await fp.goto(`${preview.url}/${file}`); const task = signature?.version === 1 && file === signature.page ? await checkInteraction(fp, signature) : null; fallbackPages.push({ file, ...(task ? { signature: task } : {}), pass: task?.pass !== false && await fp.locator('main h1').isVisible() && await fp.locator('[data-reveal]').evaluateAll(es => es.every(e => Number(getComputedStyle(e).opacity) > 0 && getComputedStyle(e).visibility !== 'hidden')) }); }
    if(effectsPlan)for(const entry of fallbackPages){await fp.goto(`${preview.url}/${entry.file}`);entry.effects=await checkEffectsFallback(fp,effectsPlan,entry.file);entry.pass&&=entry.effects.pass;}
    report.apiFallback = { pass: fallbackPages.every(p => p.pass), pages: fallbackPages }; await fallback.close();
    report.errors = errors; report.blockedExternalRequests = external; report.failedResources = resources;
    if (errors.length || external.length || resources.length) report.issues.push({ code: 'RUNTIME', errors, external, resources });
    for (const item of report.interactions) if (!item.pass) report.issues.push({ code: 'INTERACTION', name: item.name });
    if (!report.noJavaScript.pass) report.issues.push({ code: 'NO_JS' });
    if (!report.apiFallback.pass) report.issues.push({ code: 'API_FALLBACK' });
    report.pass = report.issues.length === 0;
  } finally { signal?.removeEventListener('abort', abort); await browser.close(); await preview.close(); }
  if (hash(await treeHashes(siteRoot)) !== report.siteDigest) fail('STALE_QA', 'Site bytes changed during QA');
  await writeFile(path.join(outputRoot, 'results.json'), JSON.stringify(report, null, 2), { mode: 0o640 }); return report;
}
