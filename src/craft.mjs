import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { validateProposal, text, hash, fail, safeRelative } from './contracts.mjs';
import { noLinks } from './db.mjs';
import { stageProposal, treeHashes } from './proposal.mjs';
import { staticAudit, staticPreview } from './qa.mjs';
import { settleImages, sweepPage } from './qa-motion.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export async function stageRuntime(root) {
  const files = [
    ['assets/factory-motion.js', '../runtime/motion.js'], ['assets/factory-motion.css', '../runtime/motion.css'],
    ['assets/fonts/BowlbyOneSC-Regular.ttf', '../runtime/fonts/BowlbyOneSC-Regular.ttf'], ['assets/fonts/OFL-Bowlby.txt', '../runtime/fonts/OFL.txt'],
    ['assets/fonts/DMSans-Variable.ttf', '../web/assets/DMSans-Variable.ttf'], ['assets/fonts/OFL-DMSans.txt', '../web/assets/OFL-DMSans.txt'],
  ];
  for (const [name, source] of files) {
    const target = path.join(root, name); await noLinks(target); await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    const bytes = await readFile(new URL(source, import.meta.url));
    try { await writeFile(target, bytes, { flag: 'wx', mode: 0o640 }); }
    catch (e) { if (e.code !== 'EEXIST' || hash(await readFile(target)) !== hash(bytes)) throw e; }
  }
}
export function validateStudies(input) {
  if (!Array.isArray(input?.studies) || input.studies.length !== 3) fail('DESIGN_STUDIES', 'Exactly three materially different visual studies are required');
  const studies = input.studies.map(s => ({ name: text(s.name, 'Study name', 100), ...validateProposal(s, { pageCount: 1 }) }));
  if (new Set(studies.map(s => hash(s.files))).size !== 3) fail('DESIGN_STUDIES', 'Three distinct study file sets are required; recoloring alone still requires actual visual review');
  return studies;
}
export function validateSelection(value) {
  if (!Number.isInteger(value?.selectedDirection) || value.selectedDirection < 0 || value.selectedDirection > 2 || !Array.isArray(value.notes) || !value.notes.length || !Array.isArray(value.blockingDefects)) fail('DESIGN_SELECTION', 'Rendered-direction selection needs an index 0–2 and actual pixel observations');
  return { selectedDirection: value.selectedDirection, notes: value.notes.slice(0, 12).map(n => text(n, 'Selection observation', 1800)), blockingDefects: value.blockingDefects.slice(0, 10).map(n => text(n, 'Selection blocker', 1000)), delegatedSelection: true, humanDecision: null };
}
export async function readCreativeSeed({ store, sourceJobId, parent, feedback, candidate }) {
  const source = store.job(sourceJobId);
  if (source.kind !== 'site' || source.state !== 'blocked' || source.errorCode !== 'DESIGN_STUDY_QA' || source.input.parentSiteJobId !== parent.id || source.input.parentSiteDigest !== parent.outputs.siteDigest || source.input.candidateId !== candidate.id || source.campaignId !== parent.campaignId || source.input.feedback !== feedback) fail('REUSE_BINDING', 'Only held rendered studies for this exact parent, business, facts and unchanged feedback can be reused');
  const root = path.join(store.stateRoot, 'jobs', source.id, `attempt-${source.attempt}`);
  async function saved(name) {
    const file = path.join(root, `checkpoint-${name}.json`); await noLinks(file);
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (!record.sha256 || hash(record.value) !== record.sha256) fail('STALE_STUDIES', 'Held creative checkpoint bytes changed'); return record.value;
  }
  if (hash(await saved('qualification')) !== hash(candidate)) fail('STALE_STUDIES', 'Held study business evidence changed');
  const brief = await saved('brief'), studies = validateStudies({ studies: await saved('directions') });
  if (!brief.design?.thesis || brief.pageMap?.length !== 5 || !brief.motionPlan?.length) fail('STALE_STUDIES', 'Held brief is missing the current creative contract');
  return { brief, studies, sourceJobId: source.id };
}
export async function readDirectionSeed({ store, job, selectionDigest, candidate }) {
  const base = path.join(store.stateRoot, 'jobs', job.id, `attempt-${job.attempt}`);
  async function saved(name) {
    const file = path.join(base, `checkpoint-${name}.json`); await noLinks(file); const record = JSON.parse(await readFile(file, 'utf8'));
    if (hash(record.value) !== record.sha256) fail('STALE_STUDIES', 'Original direction checkpoint changed'); return record.value;
  }
  const selectionFile = path.join(base, 'direction-selection.json'); await noLinks(selectionFile); const bytes = await readFile(selectionFile);
  if (hash(bytes) !== selectionDigest || hash(await saved('qualification')) !== hash(candidate)) fail('STALE_STUDIES', 'The selected study/frozen business no longer matches this repair request');
  const selection = JSON.parse(bytes); validateSelection(selection);
  if (!selection.blockingDefects.length) fail('DIRECTION_REPAIR_INPUT', 'This selection has no recorded blocker to repair');
  return { brief: await saved('brief'), studies: validateStudies({ studies: await saved('directions') }), media: await saved('media'), selection, base };
}
export function reviewImages(qa) {
  const captures = qa.captures || [], pages = [...new Set(captures.filter(c => c.file?.endsWith('.html')).map(c => c.file))];
  if (pages.length !== 5) fail('DESIGN_COVERAGE', 'Creative review needs coverage of all five actual pages, not only the homepage');
  const result = [];
  for (const file of pages) for (const width of [1440, 390]) {
    const capture = captures.find(c => c.file === file && c.viewport?.[0] === width && (c.kind === 'full_page' || !c.kind));
    if (!capture) fail('DESIGN_COVERAGE', 'Missing actual desktop/phone coverage for a page'); result.push(capture);
  }
  const signature = qa.signatureContract;
  if (signature?.version === 1) {
    for (const width of [1280, 390]) {
      const match = c => c.file === signature.page && c.viewport?.[0] === width && c.interactionId === signature.targetId && c.stateId === signature.states?.[1]?.id;
      const settled = captures.find(c => match(c) && c.kind === 'signature-settled');
      if (!settled) fail('DESIGN_COVERAGE', 'Missing declared signature task-state capture on laptop/phone');
      result.push(settled);
      const intermediate = captures.find(c => match(c) && c.kind === 'signature-intermediate');
      if (intermediate) result.push(intermediate);
    }
  }
  for (const width of [1280, 390]) { const c = captures.find(c => c.kind === 'scroll-intermediate' && c.viewport?.[0] === width); if (c) result.push(c); }
  return result;
}
export async function renderStudies({ studies, media, candidate, jobRoot, signal, launchBrowser = () => chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true }) }) {
  studies = validateStudies({ studies }); const output = { studies: [], captures: [], limitations: 'Opening + supporting-section studies only; not complete five-page QA, human selection or acceptance' };
  for (let index = 0; index < studies.length; index++) {
    if (signal?.aborted) fail('CANCELLED', 'Direction rendering cancelled');
    const relative = `directions/study-${index}/site`, siteRoot = path.join(jobRoot, relative);
    await mkdir(path.join(siteRoot, 'assets/photos'), { recursive: true, mode: 0o750 });
    for (const m of media) await copyFile(path.join(jobRoot, safeRelative(m.web_file)), path.join(siteRoot, safeRelative(m.web_file.replace(/^site\//, ''))));
    await stageRuntime(siteRoot); await stageProposal(siteRoot, studies[index], { pageCount: 1 });
    const audit = await staticAudit(siteRoot, { candidate, media, pageCount: 1 });
    const record = { index, name: studies[index].name, relative, siteDigest: hash(await treeHashes(siteRoot)), pass: audit.pass, issues: [...audit.issues], viewports: [] };
    output.studies.push(record); if (!audit.pass) continue;
    const preview = await staticPreview(siteRoot); let browser;
    const abort = () => { if (browser) browser.close().catch(() => {}); }; signal?.addEventListener('abort', abort, { once: true });
    try {
      browser = await launchBrowser(); if (signal?.aborted) fail('CANCELLED', 'Direction browser rendering cancelled');
      for (const [width, height] of [[1280, 720], [390, 844]]) {
        const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', acceptDownloads: false });
        const errors = []; await ctx.route('**/*', r => r.request().url().startsWith(preview.url + '/') && ['GET', 'HEAD'].includes(r.request().method()) ? r.continue() : (errors.push('Blocked non-study request'), r.abort()));
        const page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message.slice(0, 250)));
        page.on('response', r => { if (r.status() >= 400) errors.push('Study resource failed'); });
        await page.goto(preview.url + '/index.html', { timeout: 20000, waitUntil: 'load' }); await settleImages(page); const sweep = await sweepPage(page);
        const metrics = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, h1: document.querySelectorAll('h1').length, images: [...document.images].filter(i => !i.naturalWidth).length }));
        const pass = sweep.pass && !errors.length && !metrics.overflow && metrics.h1 === 1 && !metrics.images;
        record.viewports.push({ viewport: [width, height], pass, metrics, errors }); record.pass &&= pass;
        const capture = `directions/study-${index}-${width}.png`; await page.screenshot({ path: path.join(jobRoot, capture), fullPage: true });
        output.captures.push({ relative: capture, index, viewport: [width, height], name: studies[index].name }); await ctx.close();
      }
    } catch (error) {
      if (signal?.aborted) fail('CANCELLED', 'Direction browser rendering cancelled');
      const details = { name: String(error.name || 'Error').slice(0, 100), message: String(error.message || 'Browser rendering failed').slice(0, 2000), stack: String(error.stack || '').slice(0, 4000) };
      try { await writeFile(path.join(jobRoot, `private-browser-${hash(details).slice(0, 16)}.json`), JSON.stringify(details), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      fail('BROWSER_RENDER', 'Direction browser rendering failed; bounded private diagnostic retained, no visual pass inferred');
    } finally { signal?.removeEventListener('abort', abort); await browser?.close().catch(() => {}); await preview.close(); }
  }
  output.pass = output.studies.every(s => s.pass) && output.captures.length === 6;
  await writeFile(path.join(jobRoot, 'directions/results.json'), JSON.stringify(output, null, 2), { mode: 0o640 }); return output;
}
