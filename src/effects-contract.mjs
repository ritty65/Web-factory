import {fail, hash} from './contracts.mjs';
import {CINEMATIC_PROFILE,CINEMATIC_EFFECTS,SITE_PROFILES} from './site-profile.mjs';

export const PREMIUM_PROFILE = 'premium-practical-v1';
export const EFFECT_TYPES = Object.freeze(['magnetic', 'sticky-stack', 'split-text', 'clip-reveal', 'drag-gallery']);
const identifier = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
const invalid = message => fail('EFFECTS_PLAN', message);
const prose = value => typeof value === 'string' && value.trim().length >= 8 && value.length <= 600;
const unique = values => new Set(values).size === values.length;

// Data only: no caller-selected selectors, JavaScript, timings or test programs.
export function validateEffectsPlan(input, {candidate, media = [], pages = []} = {}) {
  if (!input || input.version !== 1 || !SITE_PROFILES.includes(input.profile) || Object.keys(input).some(k => !['version', 'profile', 'effects'].includes(k))) invalid('A supported version-1 quality profile is required');
  if (!Array.isArray(input.effects) || input.effects.length < 3 || input.effects.length > 20) invalid('Declare 3–20 instances from the five tested effect families');
  const facts = new Set((candidate?.facts || []).map(f => f.id));
  const photos = new Set(media.map(m => m.web_file.replace(/^site\//, '')));
  const targets = new Set();
  const effects = input.effects.map(e => {
    if (!e || Object.keys(e).some(k => !['type', 'page', 'targetId', 'purpose', 'fallback', 'factIds', 'mediaFiles'].includes(k))) invalid('Effect fields must be literal supported data');
    const allowed=input.profile===CINEMATIC_PROFILE?[...EFFECT_TYPES,...CINEMATIC_EFFECTS]:EFFECT_TYPES;
    if (!allowed.includes(e.type) || !pages.includes(e.page) || !identifier.test(e.targetId || '') || !prose(e.purpose) || !prose(e.fallback)) invalid('Each effect needs a supported type, page, element ID, purpose and fallback');
    const key = e.page + ':' + e.targetId;
    if (targets.has(key)) invalid('An element may own only one declared effect');
    targets.add(key);
    const factIds = e.factIds ?? [], mediaFiles = e.mediaFiles ?? [];
    if (!Array.isArray(factIds) || factIds.length > 20 || !unique(factIds) || factIds.some(id => !facts.has(id))) invalid('Effect facts must reference the frozen business facts');
    if (!Array.isArray(mediaFiles) || mediaFiles.length > 12 || !unique(mediaFiles) || mediaFiles.some(file => !photos.has(file))) invalid('Effect photos must reference the approved local media');
    if (e.type === 'sticky-stack' && factIds.length < 3) invalid('A sticky stack needs at least three supporting facts');
    if (e.type === 'drag-gallery' && mediaFiles.length < 3) invalid('A gallery needs at least three approved distinct photos');
    if (e.type === 'drag-gallery' && new Set(mediaFiles.map(file=>media.find(m=>m.web_file.replace(/^site\//,'')===file)?.web_sha256 || file)).size < 3) invalid('Copied photo bytes cannot count as three distinct gallery images');
    if(e.type==='image-trail'&&mediaFiles.length<3)invalid('An image trail needs three approved images');
    if(e.type==='distortion'&&mediaFiles.length!==1)invalid('Image distortion needs one approved image');
    return {type: e.type, page: e.page, targetId: e.targetId, purpose: e.purpose.trim(), fallback: e.fallback.trim(), factIds, mediaFiles};
  });
  if (new Set(effects.map(e => e.type)).size < 3 || new Set(effects.filter(e => e.page === 'index.html').map(e => e.type)).size < 3) invalid('Use at least three distinct families on the homepage, not repeated instances of one effect');
  if(input.profile===CINEMATIC_PROFILE&&new Set(effects.map(e=>e.type)).size>5)invalid('Choose at most five distinct families for one coherent visual system');
  if(input.profile===CINEMATIC_PROFILE&&!effects.some(e=>e.page==='index.html'&&CINEMATIC_EFFECTS.includes(e.type)))invalid('A cinematic homepage needs a deliberate advanced interaction, not only the basic pack');
  return {version: 1, profile: input.profile, effects};
}

export const effectsDigest = plan => hash(plan);

export const effectsPrompt = `PREMIUM PROFILE premium-practical-v1 (supersedes the legacy motion/effects-quota paragraphs below):
Return effectsPlan in the brief: {"version":1,"profile":"premium-practical-v1","effects":[{"type":"magnetic|sticky-stack|split-text|clip-reveal|drag-gallery","page":"index.html","targetId":"literal-unique-id","purpose":"business-specific reason","fallback":"visible usable static behavior","factIds":[],"mediaFiles":[]}]}. Use 3–5 DISTINCT families on index.html and across the site, not a quota per inner page. At most 20 instances total. Do not fabricate photos, services or portfolio work to meet a count; magnetic + split-text + clip-reveal works without photographs. Pages/IDs must match the final source. Keep the useful signatureInteraction contract too.
Protected local assets assets/factory-effects.js and assets/factory-effects.css are supplied on premium builds: include a stylesheet link and deferred external script on EVERY page, after the motion runtime. Never return these files. Use exactly the declared data-effect=TYPE on each target ID. Do not implement or override these mechanics with your own handlers/CSS transforms or combine data-reveal/data-scroll-depth on an effect target/descendant. Supporting style/layout belongs to the design. Natural scrolling only; no Lenis/GSAP/WebGL/network/CDN.
magnetic: real button or link, stationary >=44px hit area, exactly one direct child span data-effect-label containing its normal visible label. Host moves only that label <=6px on a fine pointer; never the click target or nav. Ordinary stationary focus/touch/reduced-motion behavior. Avoid using data-tactile on this target.
sticky-stack: section/container with >=3 direct children data-effect-card and >=3 frozen factIds; cards contain those real services/facts. Use a dedicated inner wrapper for other styling. Host stacks only on desktop >=1024px/fine pointer when cards fit; normal readable list elsewhere. No fixed heights/overflow/transform/sticky overrides on the stack or its cards.
split-text: short heading with plain text only, no nested HTML. Host splits WORDS once while preserving its accessible name. No manual splitting, opacity gates, hidden text or motion-dependent layout.
clip-reveal: dedicated visible wrapper for a photo, original abstract graphic or supporting section. Host supplies a finite wipe; no competing CSS animation/transform/clip-path.
drag-gallery: container with a labelled focusable [data-effect-track] (tabindex=0, role=region, aria-label) containing >=3 approved distinct images, and real <button type=button data-effect-prev> / data-effect-next with accessible names. Each image uses a different declared mediaFiles path, dimensions, truthful alt and normal image loading rules. Style children as flex:none width:min(78vw,420px); track width:100%; images max-width:100%. Host owns drag/inertia/navigation/arrow keys. Retain native overflow scrolling without JS, hide navigation buttons until the host adds data-effects-ready to this container. No loop/autoplay, fake client imagery or required dragging. If the signature interaction is a photo dialog, its opening controls remain links with a usable no-JS destination and use separate IDs; don't add competing track drag handlers.
All content visible without JS; responsive reflow, reduced motion, keyboard and touch are mandatory. Make three truly different art directions (composition, typography, geometry, service hierarchy); animation is an enhancement, not the design. Choose effects for the business instead of random decoration. Respect the existing total 2MiB / 50KiB JS / 50KiB CSS budget INCLUDING both host runtimes.`;
