import { inspectSource } from './browser.mjs';
import { now } from './contracts.mjs';
export const REFERENCE_SEEDS = [
  { id: 'digma', name: 'DIGMA', url: 'https://grupodigma.com/', principles: 'Bold typographic scale, substantial image-led sections and clear service hierarchy. Borrow craft, not the same composition.' },
  { id: 'shroomtopia', name: 'Shroomtopia', url: 'https://shroomtopia.shop/', principles: 'Subject-specific retail identity and contrasting product atmosphere. Earlier inspected logo image was broken; do not copy that defect or unverified product claims.' },
  { id: 'agency', name: 'Simulacra Productions', url: 'https://simulacraproductions.net/', principles: 'The operator’s own agency identity and private-preview offer; not an automatic design for every business.' },
  { id: 'portfolio', name: 'Simulacra portfolio', url: 'https://simulacraproductions.net/portfolio/', principles: 'An index of reference work, not authorization to reuse customer media or inspect private revisions.' },
  { id: 'danzica', name: 'Danzica Studio', url: 'https://danzicastudio.com/', principles: 'Expressive editorial type, distinctive image silhouettes and clear phone actions; automatic poster movement needs pause/reduced-motion treatment in new proposals.' },
  { id: 'titos', name: 'Tito’s Mobile Auto Detailing', url: 'https://titosdetailinghtx.com/', principles: 'Automotive photography, forceful display type and immediate phone actions. Do not transfer its claims, pricing or bookings to another lead.' },
  { id: 'intown', name: 'Intown Construction', url: 'https://intownconstructions.com/', principles: 'Real-work photographic emphasis, editorial service hierarchy and phone action rail. Its experience claims belong only to that business.' },
  { id: 'rollou', name: 'Rollou', url: 'https://rollou.com/', principles: 'Bare and www served an under-development placeholder during the reference audit. Intended aesthetic unavailable; do not invent observations.' },
];
export function seedReferences(store) { for (const seed of REFERENCE_SEEDS) if (!store.references().some(v => v.id === seed.id)) store.saveReference({ ...seed, status: 'awaiting_fresh_capture', observation: 'Earlier conversation inspection; fresh evidence has not yet been imported into Factory', captures: [] }); }
export async function auditReference(referenceId, { jobRoot, signal } = {}) {
  const seed = REFERENCE_SEEDS.find(v => v.id === referenceId);
  if (!seed) throw new Error('Reference not selected by operator');
  const observation = await inspectSource(seed.url, { directory: jobRoot + '/sources', signal, capture: true });
  return { ...seed, inspectedAt: now(), status: /under development/i.test(observation.title + observation.text) ? 'design_unavailable' : observation.blocked ? 'access_blocked' : 'inspected', title: observation.title, sourceId: observation.id, captures: observation.captures.map(v => ({ ...v, relative: 'sources/' + v.relative })), observation: observation.blocked ? 'Guest page access blocked. No intended design conclusion.' : observation.text.slice(0, 700), limitations: 'Guest Chromium only. Captures and DOM are not a complete interaction or hosting-account inventory audit.' };
}
