import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { executeJob } from '../src/worker.mjs';
import { stageProposal, treeHashes } from '../src/proposal.mjs';
import { hash, now } from '../src/contracts.mjs';
import { startServer } from '../src/server.mjs';
import { createRequire } from 'node:module';
import { detailsContract } from './helpers-interaction.mjs';

async function fixture(t, legacyBrief = false) {
  const root = await mkdtemp('/tmp/factory-polish-'), options = { dbPath: path.join(root, 'db.sqlite3'), stateRoot: path.join(root, 'state') };
  await initialize(options); const store = openStore(options); t.after(() => store.close());
  const campaign = store.createCampaign({ name: 'Additional polish fixture', query: 'Synthetic only', area: 'Houston', niche: 'Fixture' });
  const candidate = store.saveCandidate(campaign.id, { name: 'Polish fixture', area: 'Houston', summary: 'Synthetic only', identityMatched: true, active: true, sourceUrls: ['https://fixture.example/'], facts: [{ text: 'Synthetic item', sourceUrl: 'https://fixture.example/' }], websiteCheck: { status: 'no_official_site_found', queries: ['fixture'], checkedAt: now() } });
  const parent = store.createJob({ campaignId: campaign.id, kind: 'site', input: { candidateId: candidate.id } });
  const relative = `jobs/${parent.id}/attempt-0`, attempt = path.join(store.stateRoot, relative), site = path.join(attempt, 'proposal-0/site');
  const design = { thesis: 'Synthetic specific composition', comparisons: ['Not CakeMake print stack', 'Not Cream Burger diner shell', 'Not H-Details card layout'] };
  const proposal = { design, files: ['index', 'offer', 'photos', 'visit', 'contact'].map(name => ({ path: name + '.html', content: `<!doctype html><html><head><title>${name}</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>${name} fixture</h1></main></body></html>` })) };
  await stageProposal(site, proposal); const siteHashes = await treeHashes(site), siteDigest = hash(siteHashes);
  const brief = { design, pageMap: proposal.files.map(f => ({ file: f.path })), signatureInteraction: legacyBrief ? { kind: 'details' } : detailsContract(candidate) };
  for (const [name, value] of [['qualification', candidate], ['media', []], ['proposal', proposal]]) await writeFile(path.join(attempt, `checkpoint-${name}.json`), JSON.stringify({ value, sha256: hash(value) }));
  await writeFile(path.join(attempt, 'creative-brief.json'), JSON.stringify(brief)); await mkdir(path.join(attempt, 'qa-0')); await writeFile(path.join(attempt, 'qa-0/results.json'), JSON.stringify({ pass: true, siteHashes, captures: [] }));
  store.updateJob(parent.id, { state: 'blocked', errorCode: 'DESIGN_REWORK', outputs: { siteRelative: relative + '/proposal-0/site', qaRelative: relative + '/qa-0', siteDigest, qaPass: true, reviewStatus: 'creative_rework_required', creativeRepairs: 1, blockingDefects: ['Keep row numerals together', 'Preserve whole food crop'] } });
  return { store, service: createService(store, { autoRun: false }), parent: store.job(parent.id), proposal, siteHashes };
}
test('explicit additional polish is exact-bound, capped once per business and cannot invent acceptance', async t => {
  const { store, service, parent } = await fixture(t);
  const input = { id: parent.id, siteDigest: parent.outputs.siteDigest, feedback: 'Explicit additional budget for the two synthetic visual corrections.' };
  const polish = await service.dispatch('polish_site', input);
  assert.equal(polish.id, (await service.dispatch('polish_site', input)).id); assert.equal(polish.retryLimit, 0);
  assert.equal(polish.input.polishOf, parent.id); assert.equal(polish.input.candidateId, parent.input.candidateId);
  await assert.rejects(service.dispatch('polish_site', { ...input, feedback: 'A different extra request must not evade the single polish cap.' }), e => e.code === 'POLISH_CAP');
  await assert.rejects(service.dispatch('polish_site', { ...input, siteDigest: '0'.repeat(64) }), e => e.code === 'STALE_REVIEW');
  await assert.rejects(service.dispatch('polish_site', { ...input, humanDecision: 'accept' }), e => e.code === 'INVALID_INPUT');
  assert.deepEqual(store.job(parent.id), parent);
});
test('one polish proposal gets fresh QA and all-page critique, preserving its held parent and stopping on blockers', async t => {
  for (const blocking of [false, true]) {
    const { store, service, parent, proposal, siteHashes } = await fixture(t);
    const job = await service.dispatch('polish_site', { id: parent.id, siteDigest: parent.outputs.siteDigest, feedback: 'One explicit additional synthetic correction pass.' }); let generations = 0;
    const result = await executeJob(store, job.id, {
      generatePolish: async () => { generations++; return { ...proposal, files: proposal.files.map(f => ({ ...f, content: f.content.replace('fixture', 'polished fixture') })) }; },
      checkSite: async ({ siteRoot, outputRoot }) => { await mkdir(outputRoot, { recursive: true }); const q = { pass: true, siteHashes: await treeHashes(siteRoot), issues: [], captures: [], coverage: 'Synthetic fixture only' }; await writeFile(path.join(outputRoot, 'results.json'), JSON.stringify(q)); return q; },
      critique: async () => ({ notes: ['Synthetic fixture critique only'], blockingDefects: blocking ? ['A visual blocker remains'] : [], humanDecision: null }),
    });
    assert.equal(generations, 1); assert.deepEqual(await treeHashes(path.join(store.stateRoot, parent.outputs.siteRelative)), siteHashes); assert.deepEqual(store.job(parent.id), parent);
    if (blocking) { assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'DESIGN_REWORK'); assert.equal(store.artifacts(job.id).some(a => a.kind === 'package'), false); }
    else { assert.equal(result.state, 'review_ready', result.message); assert.equal(result.outputs.additionalPolishPass, 1); assert.equal(result.outputs.humanDecision, null); assert.equal(result.outputs.reviewStatus, 'operator_review_required'); }
  }
});
test('held-site UI requires an explicit extra-budget acknowledgement and queues the same guarded polish operation', async t => {
  const { store, service, parent } = await fixture(t); const app = await startServer(service, { port: 0, previewPort: 0 });
  const require = createRequire(import.meta.url), { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.FACTORY_BROWSER_EXECUTABLE, headless: true }); t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage(); await page.goto(app.url + '/#jobs/' + parent.id); await page.getByRole('region', { name: 'Version review' }).waitFor();
  await page.getByText('Additional correction budget', { exact: true }).click();
  await page.getByLabel('Authorized polish corrections').fill('Synthetic: keep the numerals together and correct the food crop.');
  await page.getByRole('button', { name: 'Request one authorized polish', exact: true }).click();
  assert.equal(store.jobs().filter(j => j.input.polishOf).length, 0);
  await page.getByLabel('I have explicit additional correction-budget authorization').check();
  await page.getByRole('button', { name: 'Request one authorized polish', exact: true }).click();
  await page.getByText('Explicit exact-version revision queued; parent preserved', { exact: true }).first().waitFor();
  assert.equal(store.jobs().filter(j => j.input.polishOf).length, 1); assert.equal(store.job(parent.id).outputs.humanDecision, undefined);
});
test('a legacy polish seed cannot bypass the new-production interaction gate or spend a model call', async t => {
  const { store, service, parent } = await fixture(t, true);
  const job = await service.dispatch('polish_site', { id: parent.id, siteDigest: parent.outputs.siteDigest, feedback: 'Synthetic explicit correction, not authority to bypass current checks' });
  let calls = 0;
  const result = await executeJob(store, job.id, { generatePolish: async () => { calls++; throw new Error('Legacy seed must be held before model generation'); } });
  assert.equal(result.state, 'blocked'); assert.equal(result.errorCode, 'INTERACTION_CONTRACT'); assert.equal(calls, 0);
  assert.deepEqual(store.job(parent.id), parent);
  assert.equal(store.jobs().filter(j => j.input.polishOf).length, 1);
});
