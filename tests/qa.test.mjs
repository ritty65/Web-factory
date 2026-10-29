import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { staticAudit, checkSite } from '../src/qa.mjs';
import { imageReadyScript } from '../src/browser.mjs';
import { createRequire } from 'node:module';

export async function fixtureSite() {
  const root = await mkdtemp('/tmp/factory-qa-');
  const pages = ['index', 'services', 'work', 'about', 'contact'];
  for (const name of pages) await writeFile(path.join(root, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} · Fixture workshop</title><link rel="stylesheet" href="style.css"></head><body><a href="#main">Skip to content</a><header><nav aria-label="Primary">${pages.map(p => `<a href="${p}.html" ${p === name ? 'aria-current="page"' : ''}>${p}</a>`).join('')}</nav></header><main id="main"><h1>Fixture workshop ${name}</h1><p>Useful supplied business evidence, not invented claims.</p><details><summary>How to enquire</summary><p>Prepare your questions before contacting the business.</p></details><a href="https://www.instagram.com/fixture/">Ask the workshop</a></main><footer>Independent private website concept. Not the official website.</footer></body></html>`);
  await writeFile(path.join(root, 'style.css'), 'body{font:20px/1.5 sans-serif;color:#171a17;background:#f7f6ed;margin:0;padding:24px}nav{display:flex;flex-wrap:wrap;gap:20px}a{color:#23451b;display:inline-block;padding:8px}main{max-width:760px;margin:32px auto}a:focus-visible,summary:focus-visible{outline:3px solid #285b16}summary{cursor:pointer;padding:12px}');
  return root;
}
const candidate = { sourceUrls: ['https://www.instagram.com/fixture/'], contacts: { instagram: 'https://www.instagram.com/fixture/' } };
test('static audit rejects remote/root resources, unsupported runtime and forged contacts', async () => {
  const root = await fixtureSite();
  assert.equal((await staticAudit(root, { candidate, media: [] })).pass, true);
  await writeFile(path.join(root, 'bad.js'), 'fetch("https://evil.example/steal")');
  assert.equal((await staticAudit(root, { candidate, media: [] })).pass, false);
  await writeFile(path.join(root, 'contact.html'), '<html><head><title>Bad</title></head><body><h1>Bad</h1><a href="tel:1234567890">Call</a><img src="/missing.jpg"></body></html>');
  const result = await staticAudit(root, { candidate, media: [] });
  assert.ok(result.issues.some(v => v.code === 'CONTACT_MISMATCH'));
  assert.ok(result.issues.some(v => v.code === 'NONPORTABLE_REFERENCE'));
});
test('approved photo and fact permalinks are allowed without admitting unrelated external destinations', async () => {
  const { readFile } = await import('node:fs/promises'); const root = await fixtureSite();
  const photoPost = 'https://www.instagram.com/fixture/p/EXACTPHOTO/';
  const factSource = 'https://www.facebook.com/fixture/photos/12345/';
  const target = path.join(root, 'index.html'); const original = await readFile(target, 'utf8');
  await writeFile(target, original.replace('</main>', `<a href="${photoPost}">Actual business photo</a><a href="${factSource}">Fact source</a></main>`));
  const result = await staticAudit(root, { candidate: { ...candidate, facts: [{ sourceUrl: factSource }] }, media: [{ post_url: photoPost, account: candidate.contacts.instagram }] });
  assert.equal(result.pass, true, JSON.stringify(result.issues));
  await writeFile(target, original.replace('</main>', '<a href="https://unrelated.example/">Not approved</a></main>'));
  assert.ok((await staticAudit(root, { candidate })).issues.some(i => i.code === 'UNVERIFIED_EXTERNAL_LINK'));
});
test('actual isolated Chromium QA verifies five pages at five widths, default Axe, details and no-JS', async () => {
  const root = await fixtureSite(); const output = await mkdtemp('/tmp/factory-qa-evidence-');
  const report = await checkSite({ siteRoot: root, outputRoot: output, candidate, media: [], interaction: { kind: 'details' } });
  assert.equal(report.pass, true, JSON.stringify(report.issues));
  assert.equal(report.pageChecks.length, 25);
  assert.equal(report.axe.length, 5);
  assert.ok(report.interactions.some(v => v.name === 'native_disclosure' && v.pass));
  assert.ok(report.noJavaScript.pass);
  assert.equal(report.siteHashes['index.html'].length, 64);
  assert.equal(report.signatureCoverage, 'legacy_kind_only');
  assert.equal(report.signatureContract, null);
});
test('synthetic strong-contract five-page golden site proves normal/reduced touch task and captures', async () => {
  const { readFile, mkdir } = await import('node:fs/promises'); const { hash } = await import('../src/contracts.mjs'); const { reviewImages } = await import('../src/craft.mjs');
  const root = await fixtureSite(), output = await mkdtemp('/tmp/factory-contract-golden-');
  await mkdir(path.join(root, 'assets/photos'), { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(root, 'assets/photos/one.png'), png);
  const facts = [{ id: 'fact-1', text: 'Inspect supplied examples.' }, { id: 'fact-2', text: 'Prepare questions before enquiring.' }];
  const interaction = { version: 1, kind: 'filter', description: 'Explore supplied synthetic workshop examples', page: 'work.html', targetId: 'examples',
    states: [{ id: 'all', controlId: 'show-all', outputIds: ['one', 'two'] }, { id: 'first', controlId: 'show-first', outputIds: ['one'] }],
    outputs: [{ id: 'one', text: facts[0].text, factIds: ['fact-1'], photo: 'assets/photos/one.png' }, { id: 'two', text: facts[1].text, factIds: ['fact-2'] }],
    fallback: 'Both supplied examples stay visible without JS.', accessibility: 'Native buttons with exclusive pressed state and keyboard/touch activation.', reducedMotion: 'Immediate state replacement.' };
  const target = path.join(root, 'work.html');
  await writeFile(target, (await readFile(target, 'utf8')).replace('</main>', `<section id="examples" aria-label="Synthetic examples"><button hidden type="button" id="show-all" data-filter aria-pressed="true">All examples</button><button hidden type="button" id="show-first" data-filter aria-pressed="false">First example</button><article id="one"><img src="assets/photos/one.png" width="40" height="40" alt="Synthetic fixture pixel"><p>${facts[0].text}</p></article><article id="two"><p>${facts[1].text}</p></article></section><section aria-label="Supported process"><details><summary>Inspect examples</summary><p>${facts[0].text}</p></details><details><summary>Prepare questions</summary><p>${facts[1].text}</p></details></section></main><script defer src="interaction.js"></script>`));
  await writeFile(path.join(root, 'interaction.js'), `for(const button of document.querySelectorAll('[data-filter]')){button.hidden=false;button.addEventListener('click',()=>{for(const b of document.querySelectorAll('[data-filter]'))b.setAttribute('aria-pressed',String(b===button));document.getElementById('two').hidden=button.id==='show-first';});}`);
  const report = await checkSite({ siteRoot: root, outputRoot: output, candidate: { ...candidate, facts }, media: [{ web_file: 'site/assets/photos/one.png', web_sha256: hash(png) }], interaction });
  assert.equal(report.pass, true, JSON.stringify(report.issues));
  assert.equal(report.pageChecks.length, 25); assert.equal(report.signatureCoverage, 'declared_contract_v1');
  assert.equal(report.interactions.filter(i => i.name === 'signature_contract').length, 4);
  assert.equal(report.captures.filter(c => c.kind === 'signature-settled').length, 2);
  assert.equal(report.noJavaScript.pages.find(p => p.file === 'work.html').signature.pass, true);
  assert.ok(reviewImages(report).length <= 16);
  console.log(`Synthetic five-page contract QA and captures: ${output}`);
});
test('reference captures cannot hang indefinitely on lazy or blocked image decode', async () => {
  const require = createRequire(import.meta.url); const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/pending.jpg', () => {});
    await page.setContent('<img src="https://pending.example/pending.jpg"><div style="height:4000px"></div><img loading="lazy" src="https://pending.example/lazy.jpg">', { waitUntil: 'domcontentloaded' });
    assert.equal(await page.evaluate(imageReadyScript), true);
  } finally { await browser.close(); }
});
test('a broken signature gallery on a non-home page cannot hide behind a homepage-only interaction pass', async () => {
  const root = await fixtureSite(); const output = await mkdtemp('/tmp/factory-gallery-qa-');
  const target = path.join(root, 'work.html'); const { readFile } = await import('node:fs/promises');
  await writeFile(target, (await readFile(target, 'utf8')).replace('</main>', '<button type="button" data-gallery-open>View photo detail</button><dialog aria-label="Photo detail"><button type="button">Close</button></dialog></main>'));
  const result = await checkSite({ siteRoot: root, outputRoot: output, candidate, media: [], interaction: { kind: 'gallery' } });
  assert.equal(result.pass, false);assert.ok(result.issues.some(i => i.code === 'INTERACTION' && i.name === 'photo_dialog'));
});
test('lazy, delayed and broken image waits are bounded rather than awaiting every decode forever', async () => {
  const { settleImages } = await import('../src/qa-motion.mjs');
  const require = createRequire(import.meta.url); const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage(); await page.route('**/pending.jpg', () => {});
    await page.setContent('<h1>Immediate</h1><img width="100" height="100" src="https://fixture.example/pending.jpg"><div style="height:5000px"></div><img loading="lazy" width="100" height="100" src="https://fixture.example/lazy.jpg">', { waitUntil: 'domcontentloaded' });
    const started = Date.now(), result = await settleImages(page, { timeout: 150 });
    assert.ok(Date.now() - started < 1500); assert.equal(result.timedOut, true);
    assert.equal(await page.locator('h1').isVisible(), true);
  } finally { await browser.close(); }
});
test('first-screen loading policy detects unsized/lazy hero media and offscreen primary action', async () => {
  const { inspectFirstScreen } = await import('../src/qa-motion.mjs');
  const require = createRequire(import.meta.url); const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent('<h1>Fixture</h1><img src="bad.jpg" loading="lazy" style="display:block;width:100px;height:100px" alt="Fixture"><div style="height:1000px"></div><a data-primary-action href="#main">Ask</a>');
    const result = await inspectFirstScreen(page);
    assert.equal(result.sized, false); assert.equal(result.eagerFirstScreen, false); assert.equal(result.primaryVisible, false);
    await page.setContent('<h1>Fixture</h1><a data-primary-action href="#main">Ask</a><img width="100" height="100" src="bad.jpg" alt="Fixture">');
    const fixed = await inspectFirstScreen(page);
    assert.equal(fixed.sized, true); assert.equal(fixed.eagerFirstScreen, true); assert.equal(fixed.primaryVisible, true);
    await page.setContent('<main><a data-primary-action href="#main">Ask</a><img width="100" height="100" fetchpriority="high" loading="eager" src="hero.jpg" alt="Hero"><img width="100" height="100" loading="lazy" src="support.jpg" alt="Supporting image"></main>');
    const supporting = await inspectFirstScreen(page);
    assert.equal(supporting.eagerFirstScreen, true, 'a visible native-lazy supporting image is not a lazy critical hero');
    assert.equal(supporting.visibleLazyImages, 1);
  } finally { await browser.close(); }
});
