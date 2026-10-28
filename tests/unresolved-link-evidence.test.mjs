import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateInput, assessEvidence, id } from '../src/contracts.mjs';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { createService } from '../src/service.mjs';
import { assessIntake } from '../src/intake.mjs';
import { intakeFixture } from './helpers-batch.mjs';

const link = { url: 'https://outbound.example/booking', sourceId: null, status: 'unresolved', reason: 'No inspection observation is available.' };

for (const omitted of [false, true]) {
  test(`unknown website evidence preserves an unresolved link with ${omitted ? 'omitted' : 'null'} source ID`, () => {
    const f = intakeFixture(), finding = { ...link };
    if (omitted) delete finding.sourceId;
    f.candidate.websiteCheck.status = 'unknown';
    f.candidate.websiteCheck.linkChecks = [finding];
    const c = candidateInput(f.candidate);
    assert.deepEqual(c.websiteCheck.linkChecks, [link]);
    assert.equal(c.websiteCheck.status, 'unknown');
    assert.equal(c.assessment.state, 'blocked');
    const gate = assessIntake(c, f);
    assert.equal(gate.ready, false);
    assert.ok(gate.reasons.some(reason => reason.includes('Website absence is unresolved')));
  });
}

for (const status of ['official', 'unofficial', 'not_business', 'invalid', undefined]) {
  for (const omitted of [false, true]) {
    test(`${String(status)} link status cannot admit a ${omitted ? 'missing' : 'null'} source ID`, () => {
      const f = intakeFixture(), finding = { ...link, status };
      if (omitted) delete finding.sourceId;
      f.candidate.websiteCheck.linkChecks = [finding];
      assert.throws(() => candidateInput(f.candidate), { code: 'INVALID_ID' });
    });
  }
}

test('unresolved links still reject invalid provided IDs and global IDs remain strict', () => {
  for (const sourceId of ['', 'INVALID ID', 42, false]) {
    const f = intakeFixture();
    f.candidate.websiteCheck.linkChecks = [{ ...link, sourceId }];
    assert.throws(() => candidateInput(f.candidate), { code: 'INVALID_ID' });
  }
  for (const value of [null, undefined]) assert.throws(() => id(value), { code: 'INVALID_ID' });
});

test('nullable unresolved evidence does not weaken link URL or reason validation', () => {
  for (const [change, code] of [[{ url: 'http://outbound.example/' }, 'UNSAFE_URL'], [{ reason: '' }, 'INVALID_INPUT']]) {
    const f = intakeFixture();
    f.candidate.websiteCheck.linkChecks = [{ ...link, ...change }];
    assert.throws(() => candidateInput(f.candidate), { code });
  }
});

test('otherwise ready no-site intake is held by an observed outbound link with unresolved null evidence', () => {
  const f = intakeFixture();
  const baseline = assessIntake(candidateInput(f.candidate), f);
  assert.equal(baseline.ready, true, baseline.reasons.join('\n'));
  f.observations[0].links.push({ url: link.url, text: 'Booking website' });
  f.candidate.websiteCheck.linkChecks = [{ ...link }];
  const c = candidateInput(f.candidate), gate = assessIntake(c, f);
  assert.equal(c.assessment.state, 'blocked');
  assert.deepEqual(c.websiteCheck.linkChecks, [link]);
  assert.equal(gate.ready, false);
  assert.ok(gate.reasons.includes(c.assessment.reason));
  assert.ok(gate.reasons.includes('A possible outbound official/builder/booking site remains uninspected or unresolved.'));
  assert.equal(gate.humanDecision, null);
});

test('shared qualification blocks unresolved and missing-inspection links while preserving status precedence and legacy absence', () => {
  const f = intakeFixture(), base = candidateInput(f.candidate);
  assert.equal(assessEvidence(base).state, 'qualified');
  delete base.websiteCheck.linkChecks;
  assert.equal(assessEvidence(base).state, 'qualified');
  for (const finding of [link, { ...link, sourceId: 'source-valid' }, { ...link, status: 'unofficial' }, { ...link, status: 'not_business', sourceId: undefined }]) {
    const c = { ...base, websiteCheck: { ...base.websiteCheck, linkChecks: [finding] } };
    assert.equal(assessEvidence(c).state, 'blocked');
    assert.match(assessEvidence(c).reason, /outbound.*unresolved|inspection/i);
    assert.equal(assessEvidence({ ...c, websiteCheck: { ...c.websiteCheck, status: 'official_site_found' } }).state, 'excluded');
    assert.equal(assessEvidence({ ...c, websiteCheck: { ...c.websiteCheck, status: 'unknown' } }).state, 'blocked');
  }
  f.candidate.websiteCheck.linkChecks = [{ ...link, status: 'invalid', sourceId: 'source-valid' }];
  const normalized = candidateInput(f.candidate);
  assert.equal(normalized.websiteCheck.linkChecks[0].status, 'unresolved');
  assert.equal(normalized.assessment.state, 'blocked');
});

test('legacy service import retains unresolved evidence but build rejects qualification without creating jobs', async () => {
  const root = await mkdtemp('/tmp/factory-unresolved-qualification-');
  const options = { dbPath: path.join(root, 'library.sqlite3'), stateRoot: path.join(root, 'state'), autoRun: false };
  await initialize(options);
  const store = openStore(options), service = createService(store, options);
  try {
    const campaign = await service.dispatch('campaign_create', { name: 'Synthetic qualification regression', area: 'Houston', niche: 'Synthetic workshop', query: 'Synthetic evidence only' });
    const f = intakeFixture();
    f.candidate.websiteCheck.linkChecks = [{ ...link }];
    const imported = await service.dispatch('candidates_import', { campaignId: campaign.id, candidates: [f.candidate] });
    const c = imported.candidates[0];
    assert.deepEqual(c.websiteCheck.linkChecks, [link]);
    await assert.rejects(service.dispatch('build_site', { candidateId: c.id }), { code: 'QUALIFICATION' });
    assert.equal(c.assessment.state, 'blocked');
    assert.equal(store.db.prepare('SELECT count(*) AS total FROM factory_job').get().total, 0);
  } finally { store.close(); }
});
