import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { initialize, openStore } from '../src/db.mjs';
import { hash } from '../src/contracts.mjs';
import { intakeFixture } from './helpers-batch.mjs';

const sharp = createRequire(import.meta.url)('sharp');
export async function assistedFixture() {
  const f = intakeFixture(), at = new Date().toISOString(), start = Date.now() - 60000;
  const sourceId = 'external-profile-1', imageId = 'external-image-1';
  const bytes = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#597a38' } }).jpeg().toBuffer();
  f.candidate.inspectionIds = [sourceId]; f.candidate.media[0] = { ...f.candidate.media[0], sourceId, imageId };
  f.candidate.activityEvidence.sourceId = sourceId;
  f.observations[0] = { ...f.observations[0], id: sourceId, method: 'assisted_external_guest_dom', sourceKind: 'external_observation', captureRef: 'external-capture-profile-1', finalUrl: f.observations[0].url };
  f.observations[0].images[0] = { ...f.observations[0].images[0], id: imageId, width: 640, height: 480, postUrl: f.candidate.media[0].postUrl };
  const booking = 'https://booksy.com/en-us/123456_juniper_other_134588_houston';
  f.observations[0].links.push({ url: booking, text: 'Book appointment' });
  f.observations.push({ id: 'external-booking-1', url: booking, finalUrl: booking, title: f.candidate.name, text: 'Synthetic booking profile, not catalog facts.', inspectedAt: at, blocked: false, method: 'assisted_external_guest_dom', sourceKind: 'external_observation', captureRef: 'external-capture-booking-1', links: [], images: [] });
  f.candidate.inspectionIds.push('external-booking-1');
  f.candidate.websiteCheck.linkChecks.push({ url: booking, sourceId: 'external-booking-1', status: 'official', reason: 'Published business booking destination; not an independent marketing website.' });
  f.searches = f.searches.map((s, i) => ({ ...s, id: `external-search-${i}`, sourceKind: 'external_observation', provider: 'external_operator_capture' }));
  f.imageViews = [{ sourceId, imageId, at, method: 'external_pixel_review', pixelsSha256: hash(bytes), observer: 'AI assistant', notes: 'Viewed synthetic test pixels, not a real business.' }];
  return { requestId: 'save-fixture-1', scope: { authorizationId: 'fixture-authorization-1', startedAt: new Date(start).toISOString(), sourceCutoff: new Date(start + 3600000).toISOString(), deadlineAt: new Date(start + 14400000).toISOString(), limits: { searches: 12, inspections: 24, imageViews: 8, modelRequests: 16 }, authorized: true }, usage: { searches: 12, inspections: 4, imageViews: 1, modelRequests: 0 }, bundle: { version: 1, segment: 'booking_social_no_independent_marketing_site', ...f, assets: [{ imageId, sourceId, originalBase64: bytes.toString('base64'), sha256: hash(bytes), contentType: 'image/jpeg', review: { method: 'external_pixel_review', observer: 'AI assistant', at, notes: 'Viewed synthetic fixture photography pixels.' } }] } };
}
export async function assistedStore(t) {
  const root = await mkdtemp('/tmp/assisted-test-');
  const options = { dbPath: path.join(root, 'test.sqlite3'), stateRoot: path.join(root, 'state') };
  await initialize(options); const store = openStore(options);
  t.after(async () => { store.db.close(); await rm(root, { recursive: true, force: true }); });
  return store;
}
