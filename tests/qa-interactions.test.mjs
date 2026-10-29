import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { checkInteraction, checkInteractionFallback } from '../src/qa-interactions.mjs';
import { staticPreview } from '../src/qa.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
function contract(kind = 'filter') {
  return { version: 1, kind, description: 'Synthetic supported examples', page: 'work.html', targetId: 'examples',
    states: [{ id: 'all', controlId: 'show-all', outputIds: ['one', 'two'] }, { id: 'first', controlId: 'show-first', outputIds: ['one'] }],
    outputs: [{ id: 'one', text: 'First supplied example', factIds: ['fact-1'] }, { id: 'two', text: 'Second supplied example', factIds: ['fact-1'] }],
    fallback: 'All examples remain available.', accessibility: 'Keyboard and touch buttons.', reducedMotion: 'Immediate output.' };
}

const controls = '<button id="show-all" aria-pressed="true">All</button><button id="show-first" aria-pressed="false">First</button>';
const content = '<article id="one">First supplied example</article><article id="two">Second supplied example</article>';
const script = `for (const button of document.querySelectorAll('button')) button.addEventListener('click', () => { for(const b of document.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b===button)); document.getElementById('two').hidden=button.id==='show-first'; });`;
async function browserPage(t, html, options = {}) {
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(options); await context.route('**/*', route => route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(1500); await page.setContent(html); return page;
}
test('filter proves visible membership, exclusive selection, keyboard and rapid reset', async t => {
  const page = await browserPage(t, `<section id="examples">${controls}${content}</section><script>${script}</script>`);
  assert.equal((await checkInteraction(page, contract())).pass, true);
  await page.evaluate(() => { document.getElementById('two').hidden = false; document.getElementById('two').removeAttribute('id'); });
  assert.equal((await checkInteraction(page, contract())).pass, false);
});
test('aria-only filter, wrong text, missing target and inert planning fail honestly', async t => {
  const page = await browserPage(t, `<section id="examples">${controls}${content}</section><script>${script.replace("document.getElementById('two').hidden=button.id==='show-first';", '')}</script>`);
  assert.equal((await checkInteraction(page, contract())).pass, false);
  await page.setContent(`<section id="examples">${controls}${content}</section><script>${script}</script>`);
  await page.locator('#one').evaluate(e => e.textContent = 'Wrong output');
  assert.equal((await checkInteraction(page, contract())).pass, false);
  assert.equal((await checkInteraction(page, { ...contract(), targetId: 'absent' })).pass, false);
  await page.setContent(`<section id="examples">${controls}${content}</section>`);
  assert.equal((await checkInteraction(page, contract('planning'))).pass, false);
});
test('no-JS fallback requires actual outputs, not just a visible page heading', async t => {
  const page = await browserPage(t, `<h1>Available</h1><section id="examples">${content}</section>`, { javaScriptEnabled: false });
  assert.equal((await checkInteractionFallback(page, contract())).pass, true);
  await page.locator('#examples').evaluate(e => { const button = document.createElement('button'); button.id = 'show-all'; button.textContent = 'Inert filter'; e.append(button); });
  assert.equal((await checkInteractionFallback(page, contract())).pass, false);
  await page.locator('#show-all').evaluate(e => e.remove());
  await page.locator('#two').evaluate(e => e.hidden = true);
  assert.equal((await checkInteractionFallback(page, contract())).pass, false);
});
test('transparent output or ancestor cannot claim a visible normal or no-JS result', async t => {
  const html = `<section id="examples">${controls}<div id="output-wrapper">${content}</div></section><script>${script}</script>`;
  const page = await browserPage(t, html);
  assert.equal((await checkInteraction(page, contract())).pass, true);
  for (const id of ['one', 'output-wrapper']) {
    await page.setContent(html); await page.locator('#' + id).evaluate(e => e.style.opacity = '0');
    assert.equal((await checkInteraction(page, contract())).pass, false, id);
    await page.setContent(`<section id="examples"><div id="output-wrapper">${content}</div></section>`);
    await page.locator('#' + id).evaluate(e => e.style.opacity = '0');
    assert.equal((await checkInteractionFallback(page, contract())).pass, false, 'fallback ' + id);
  }
});
test('native disclosure supports keyboard cycles and already-open no-JS content', async t => {
  const value = contract('details'); value.states = [{ id: 'closed', controlId: 'summary', outputIds: [] }, { id: 'open', controlId: 'summary', outputIds: ['one', 'two'] }];
  const page = await browserPage(t, `<section id="examples"><details open><summary id="summary">Supported explanation</summary>${content}</details></section>`);
  assert.equal((await checkInteraction(page, value)).pass, true);
  await page.locator('details').evaluate(e => e.open = true);
  assert.equal((await checkInteractionFallback(page, value)).pass, true);
});
test('factual local process selection has supported output and a real static fallback', async t => {
  const value = contract('planning'); value.states[0].outputIds = ['two'];
  const processScript = `for(const button of document.querySelectorAll('button'))button.addEventListener('click',()=>{for(const b of document.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b===button));document.getElementById('one').hidden=button.id==='show-all';document.getElementById('two').hidden=button.id==='show-first';});`;
  const page = await browserPage(t, `<section id="examples">${controls}${content}</section><script>${processScript}</script>`);
  assert.equal((await checkInteraction(page, value)).pass, true);
});
test('synthetic phone/laptop normal and reduced task-state evidence is retained', async t => {
  const root = await mkdtemp('/tmp/factory-signature-synthetic-');
  const finite = script.replace("document.getElementById('two').hidden=button.id==='show-first';", "document.getElementById('two').hidden=button.id==='show-first';if(!matchMedia('(prefers-reduced-motion:reduce)').matches)document.getElementById('one').animate([{transform:'translateY(6px)',opacity:.8},{transform:'none',opacity:1}],{duration:180});");
  const page = await browserPage(t, `<h1>Synthetic filter fixture — not customer work</h1><section id="examples">${controls}${content}</section><script>${finite}</script>`);
  const captures = [];
  for (const width of [1280, 390]) for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 }); await page.emulateMedia({ reducedMotion });
    const result = await checkInteraction(page, contract(), async (kind, stateId) => {
      const file = `${root}/${width}-${reducedMotion}-${kind}.png`; await page.screenshot({ path: file }); captures.push({ file, stateId });
    }); assert.equal(result.pass, true, JSON.stringify(result));
  }
  await writeFile(`${root}/evidence.json`, JSON.stringify({ synthetic: true, captures }, null, 2));
  assert.equal(captures.length, 6, 'normal intermediate+settled and reduced settled, on both widths');
  console.log(`Synthetic signature captures: ${root}`);
});
test('a gallery may use a real exact-photo link as its native control and no-JS fallback', async t => {
  const root = await mkdtemp('/tmp/factory-photo-link-synthetic-'); await mkdir(`${root}/assets/photos`, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
  for (const name of ['one', 'two']) await writeFile(`${root}/assets/photos/${name}.png`, png);
  const value = contract('gallery');
  value.states = [{ id: 'one', controlId: 'open-one', outputIds: ['one'] }, { id: 'two', controlId: 'open-two', outputIds: ['two'] }];
  value.outputs.forEach(o => o.photo = `assets/photos/${o.id}.png`);
  await writeFile(`${root}/work.html`, `<!doctype html><h1>Synthetic linked photo details</h1><section id="examples"><a id="open-one" data-gallery-open="one" href="assets/photos/one.png">Inspect first photograph</a><a id="open-two" data-gallery-open="two" href="assets/photos/two.png">Inspect second photograph</a>${value.outputs.map(o => `<figure id="${o.id}"><img src="${o.photo}" width="100" height="100" alt="Synthetic pixel"><figcaption>${o.text}</figcaption></figure>`).join('')}<dialog aria-label="Photo detail"><button data-gallery-close>Close</button><div id="slot"></div></dialog></section><script src="gallery.js"></script>`);
  await writeFile(`${root}/gallery.js`, `const dialog=document.querySelector('dialog'),slot=document.getElementById('slot');let trigger,selected;for(const link of document.querySelectorAll('[data-gallery-open]')){link.addEventListener('click',event=>{event.preventDefault();trigger=link;selected=document.getElementById(link.getAttribute('data-gallery-open'));for(const figure of document.querySelectorAll('figure'))figure.hidden=figure!==selected;slot.appendChild(selected);dialog.showModal();});}const close=()=>{if(dialog.open)dialog.close();};document.querySelector('[data-gallery-close]').addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('close',()=>{for(const figure of document.querySelectorAll('figure')){figure.hidden=false;document.getElementById('examples').appendChild(figure);}trigger.focus();});`);
  const preview = await staticPreview(root); t.after(() => preview.close());
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true }); t.after(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.route('**/*', r => r.request().url().startsWith(preview.url + '/') ? r.continue() : r.abort());
  const page = await ctx.newPage(); page.setDefaultTimeout(1200); await page.goto(`${preview.url}/work.html`);
  assert.equal((await checkInteraction(page, value)).pass, true);
  await page.locator('#open-one').evaluate(e => { e.href = 'assets/photos/two.png'; });
  assert.equal((await checkInteraction(page, value)).pass, false, 'wrong photo link');
  await page.goto(`${preview.url}/work.html`);
  await page.locator('#open-two').evaluate(e => { e.removeAttribute('data-gallery-open'); });
  assert.equal((await checkInteraction(page, value)).pass, false, 'link without declared output');
  await ctx.close();
  const nojs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  await nojs.route('**/*', r => r.request().url().startsWith(preview.url + '/') ? r.continue() : r.abort());
  const staticPage = await nojs.newPage(); await staticPage.goto(`${preview.url}/work.html`);
  assert.equal((await checkInteractionFallback(staticPage, value)).pass, true);
  await staticPage.locator('#open-one').evaluate(e => { e.href = 'assets/photos/two.png'; });
  assert.equal((await checkInteractionFallback(staticPage, value)).pass, false, 'wrong no-JS photo link');
  await nojs.close();
});
test('genuine clicked-photo identity, caption, two dismissal paths, touch and rapid replacement', async t => {
  const root = await mkdtemp('/tmp/factory-photo-synthetic-'); await mkdir(`${root}/assets/photos`, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
  for (const name of ['one', 'two']) await writeFile(`${root}/assets/photos/${name}.png`, png);
  const value = contract('gallery'); value.states[0].outputIds = ['two'];
  value.outputs.forEach(o => o.photo = `assets/photos/${o.id}.png`);
  await writeFile(`${root}/work.html`, `<!doctype html><h1>Synthetic photo details</h1><section id="examples"><button id="show-all" data-gallery-open hidden>Second</button><button id="show-first" data-gallery-open hidden>First</button><a href="assets/photos/one.png">First supplied example</a><a href="assets/photos/two.png">Second supplied example</a><dialog aria-label="Photo detail"><button data-gallery-close>Close</button>${value.outputs.map(o => `<figure id="${o.id}" hidden><img src="${o.photo}" width="100" height="100" alt="Synthetic pixel"><figcaption>${o.text}</figcaption></figure>`).join('')}</dialog></section><script src="gallery.js"></script>`);
  await writeFile(`${root}/gallery.js`, `const dialog=document.querySelector('dialog');let trigger;for(const button of document.querySelectorAll('[data-gallery-open]')){button.hidden=false;button.addEventListener('click',()=>{trigger=button;for(const figure of document.querySelectorAll('figure'))figure.hidden=figure.id!==(button.id==='show-first'?'one':'two');dialog.showModal();});}document.querySelector('[data-gallery-close]').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>trigger.focus());`);
  const preview = await staticPreview(root); t.after(() => preview.close());
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true }); t.after(() => browser.close());
  for (const hasTouch of [false, true]) {
    const ctx = await browser.newContext({ hasTouch, viewport: { width: hasTouch ? 390 : 1280, height: hasTouch ? 844 : 720 } });
    await ctx.route('**/*', r => r.request().url().startsWith(preview.url + '/') ? r.continue() : r.abort());
    const page = await ctx.newPage(); page.setDefaultTimeout(1200); await page.goto(`${preview.url}/work.html`);
    const result = await checkInteraction(page, value);
    assert.equal(result.pass, true, JSON.stringify(result));
    assert.ok(result.checks.some(c => c.name === 'rapid_A_B_A_reset'));
    for (const bad of ['wrong-photo', 'wrong-caption', 'empty-photo', 'missing-close', 'lost-focus', 'lost-focus-frame', 'missing-close-event', 'transparent-photo']) {
      await page.goto(`${preview.url}/work.html`);
      await page.evaluate(bad => {
        if (bad === 'wrong-photo') document.querySelector('#two img').src = 'assets/photos/one.png';
        if (bad === 'wrong-caption') document.querySelector('#two figcaption').textContent = 'Unrelated photo';
        if (bad === 'empty-photo') document.querySelector('#two img').remove();
        if (bad === 'transparent-photo') document.querySelector('#two img').style.opacity = '0';
        if (bad === 'missing-close') document.querySelector('[data-gallery-close]').remove();
        if (bad === 'lost-focus') document.querySelector('dialog').addEventListener('close', () => document.activeElement.blur());
        if (bad === 'lost-focus-frame') document.querySelector('dialog').addEventListener('close', () => requestAnimationFrame(() => document.activeElement.blur()));
        if (bad === 'missing-close-event') document.querySelector('[data-gallery-close]').addEventListener('click', event => {
          event.stopImmediatePropagation();
          document.querySelector('dialog').removeAttribute('open');
          document.getElementById('show-all').focus();
        }, { capture: true });
      }, bad);
      const rejected = await checkInteraction(page, value);
      assert.equal(rejected.pass, false, bad);
      if (bad === 'missing-close-event') assert.match(rejected.note, /close event\/frame did not settle within the bounded wait/);
    }
    await ctx.close();
  }
  const nojs = await browser.newContext({ javaScriptEnabled: false });
  await nojs.route('**/*', r => r.request().url().startsWith(preview.url + '/') ? r.continue() : r.abort());
  const page = await nojs.newPage(); await page.goto(`${preview.url}/work.html`);
  assert.equal((await checkInteractionFallback(page, value)).pass, true); await nojs.close();
});

test('native dialog restores focus before close handlers and their next-frame focus loss', async t => {
  const page = await browserPage(t, '<button id="trigger">Photo</button><dialog><button>Close</button></dialog>');
  const evidence = await page.evaluate(async () => {
    const trigger = document.getElementById('trigger');
    const dialog = document.querySelector('dialog');
    trigger.focus(); dialog.showModal();
    const order = [];
    const closed = new Promise(resolve => dialog.addEventListener('close', () => {
      order.push('close');
      requestAnimationFrame(() => {
        document.activeElement.blur(); order.push('frame');
        resolve(document.activeElement === trigger);
      });
    }, { once: true }));
    dialog.close();
    const immediate = { focused: document.activeElement === trigger, order: [...order], open: dialog.open };
    return { immediate, settledFocus: await closed, order };
  });
  assert.deepEqual(evidence, { immediate: { focused: true, order: [], open: false }, settledFocus: false, order: ['close', 'frame'] });
});
