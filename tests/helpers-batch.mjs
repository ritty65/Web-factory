import { now } from '../src/contracts.mjs';

export const batchSettings = { area: 'Houston city limits', niche: 'Synthetic independent workshops', targetCount: 3, candidateLimit: 12, maxResearchRounds: 4, searchProvider: 'guest_bing', maxSearches: 24, maxInspections: 48, maxImageViews: 24, maxModelRequests: 30, batchMinutes: 360, jobMinutes: 30 };
export function intakeFixture(n = 1) {
  const name = `Juniper ${n} Upholstery`, profile = `https://www.instagram.com/juniper${n}/`, post = `https://www.instagram.com/p/juniper${n}/`;
  const facts = ['Repairs upholstered chairs in Houston.', 'Offers fabric selection consultations.', 'Shares completed chair restoration examples.'];
  const date = now().slice(0, 10), sourceId = `source-${String(n).padStart(20, 'a')}`, imageId = `image-${String(n).padStart(20, 'b')}`;
  const candidate = { name, area: 'Houston', summary: facts.join(' '), identityMatched: true, active: true, sourceUrls: [profile, post],
    facts: facts.map(text => ({ text, sourceUrl: profile, excerpt: text })), contacts: { instagram: profile }, contactSources: { instagram: profile },
    websiteCheck: { status: 'no_official_site_found', queries: [`"${name}" Houston official website`, `"${name}" chair repair website`], checkedAt: now(), linkChecks: [] },
    inspectionIds: [sourceId], media: [{ sourceId, imageId, account: profile, postUrl: post, businessPosted: true, alt: 'Synthetic chair fixture, not a real business photo', role: 'hero', credit: 'Synthetic test only' }],
    pagePurposes: ['Orientation', 'Chair repair', 'Fabric consultation', 'Restoration examples', 'Contact the workshop'].map(purpose => ({ purpose, factIds: ['fact-1', 'fact-2', 'fact-3'] })),
    activityEvidence: { sourceId, excerpt: `New restoration shared ${date}`, dateText: date, date }, unknowns: ['Synthetic test only; no real business is represented'] };
  const observation = { id: sourceId, url: profile, title: name, text: `${name}. Houston. ${facts.join(' ')} New restoration shared ${date}. ${'Synthetic public workshop evidence. '.repeat(6)}`, inspectedAt: now(), blocked: false,
    links: [{ url: post, text: 'Restoration example' }], images: [{ id: imageId, width: 800, height: 600, mediaUrl: 'https://scontent.cdninstagram.com/fixture.jpg' }] };
  const searches = candidate.websiteCheck.queries.map(query => ({ status: 'completed', intent: 'verify', query, at: now(), results: [{ title: name, url: profile, description: 'Houston upholstery workshop social profile' }] }));
  const imageViews = [{ sourceId, imageId, at: now(), pixelsSha256: '1'.repeat(64) }];
  return { candidate, observations: [observation], searches, imageViews };
}
