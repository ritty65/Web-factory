import { fail, text, safeRelative } from './contracts.mjs';

const kinds = new Set(['gallery', 'filter', 'details', 'planning']);
const invalid = message => fail('INTERACTION_CONTRACT', `Signature interaction: ${message}`);
const object = (value, fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) invalid('unsupported object or field');
};
const domId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)) invalid('invalid bounded DOM ID');
  return value;
};
const list = (value, min, max) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid('invalid bounded state/output list');
  return value;
};
const unique = values => { if (new Set(values).size !== values.length) invalid('duplicate state/output/control IDs'); return values; };

// Model data names bounded DOM IDs, never selectors, expressions or test programs.
export function validateInteraction(value, { candidate, media = [], pages, legacy = false } = {}) {
  if (!value || !kinds.has(value.kind)) invalid('unknown kind');
  if (legacy && value.version === undefined && Object.keys(value).every(k => ['kind', 'description'].includes(k))) {
    if (value.kind === 'planning') invalid('legacy planning has no verified process contract');
    return { kind: value.kind, coverage: 'legacy_kind_only' };
  }
  object(value, ['version', 'kind', 'description', 'page', 'targetId', 'states', 'outputs', 'fallback', 'accessibility', 'reducedMotion', 'motionTargetId']);
  if (value.version !== 1) invalid('version 1 is required');
  const page = safeRelative(value.page);
  if (!/^[a-zA-Z0-9_-]+\.html$/.test(page) || (pages && !pages.includes(page))) invalid('page must name a declared root HTML page');
  const facts = new Set((candidate?.facts || []).map(f => f.id));
  const photos = new Set(media.map(m => m.web_file?.replace(/^site\//, '')));
  const outputs = list(value.outputs, 1, 12).map(output => {
    object(output, ['id', 'text', 'factIds', 'photo']);
    const factIds = unique(list(output.factIds, 1, 12).map(id => {
      if (typeof id !== 'string' || !facts.has(id)) invalid('output references an unknown fact'); return id;
    }));
    const result = { id: domId(output.id), text: text(output.text, 'Interaction output text', 500), factIds };
    if (value.kind === 'planning' && (factIds.length !== 1 || result.text !== candidate?.facts?.find(f => f.id === factIds[0])?.text)) invalid('process output must reproduce one supplied factual step exactly, not create a quote/booking/submission result');
    if (output.photo !== undefined) {
      const photo = safeRelative(output.photo);
      if (!photos.has(photo)) invalid('output photo must match frozen media'); result.photo = photo;
    }
    if (value.kind === 'gallery' && !result.photo) invalid('gallery output needs an actual frozen photo');
    return result;
  });
  const outputIds = unique(outputs.map(o => o.id));
  const states = list(value.states, 2, 6).map(state => {
    object(state, ['id', 'controlId', 'outputIds']);
    const ids = unique(list(state.outputIds, value.kind === 'details' ? 0 : 1, 12).map(domId));
    if (ids.some(id => !outputIds.includes(id))) invalid('state references an unknown output');
    if (['gallery', 'planning'].includes(value.kind) && ids.length !== 1) invalid('photo/process states expose exactly one output');
    return { id: domId(state.id), controlId: domId(state.controlId), outputIds: ids };
  });
  unique(states.map(s => s.id));
  // Details open/closed states deliberately share the same native summary.
  if (value.kind !== 'details') unique(states.map(s => s.controlId));
  else if (new Set(states.map(s => s.controlId)).size !== 1 || states.length !== 2 || !states.some(s => !s.outputIds.length) || !states.some(s => s.outputIds.length === outputs.length)) invalid('details needs open/closed states on one summary');
  if (outputIds.some(id => !states.some(s => s.outputIds.includes(id)))) invalid('every output must belong to a supported state');
  if (value.kind === 'filter' && (states[0].outputIds.length !== outputs.length || outputIds.some(id => !states[0].outputIds.includes(id)))) invalid('first filter state must reset to all outputs');
  if (new Set(states.map(s => JSON.stringify([...s.outputIds].sort()))).size < 2) invalid('states need meaningfully different output membership');
  const targetId = domId(value.targetId);
  unique([targetId, ...outputIds, ...new Set(states.map(s => s.controlId))]);
  return { version: 1, kind: value.kind, description: text(value.description, 'Interaction purpose', 600), page, targetId, states, outputs,
    fallback: text(value.fallback, 'Interaction fallback', 600), accessibility: text(value.accessibility, 'Interaction accessibility', 600), reducedMotion: text(value.reducedMotion, 'Interaction reduced motion', 600),
    ...(value.motionTargetId !== undefined ? { motionTargetId: domId(value.motionTargetId) } : {}) };
}

export const interactionPrompt = `The signatureInteraction MUST be a version-1 host-testable data contract, not test code or selectors:
{"version":1,"kind":"gallery|filter|details|planning","description":"business-specific useful task","page":"actual declared root page.html","targetId":"unique-root-id","states":[{"id":"all","controlId":"native-control-id","outputIds":["output-one","output-two"]},{"id":"first","controlId":"another-control-id","outputIds":["output-one"]}],"outputs":[{"id":"output-one","text":"exact visible output/caption","factIds":["fact-1"],"photo":"optional frozen assets/photos/file.webp"},{"id":"output-two","text":"exact visible output/caption","factIds":["fact-1"]}],"fallback":"actual useful no-JS content","accessibility":"keyboard and touch equivalent","reducedMotion":"same output, immediate replacement","motionTargetId":"optional actual supporting data-reveal DOM ID"}.
Use 2–6 states and 1–12 outputs; IDs are literal unique DOM IDs, never CSS selectors. Every output binds real supplied fact IDs; photos, if present, bind supplied local files. No other fields. Output text is exact rendered text, not HTML. The target contains controls and output wrappers (including dialog). Only declared outputs participate in membership checks. Filter/planning use native buttons with exclusive aria-pressed; first filter state restores ALL outputs. Planning ONLY explores documented local factual process steps, one output per state: each process output has exactly one factId and text exactly equal to that supplied fact's text. NO quote, booking, availability, submission or invented recommendation. If supplied facts do not support meaningful process steps, choose another kind. Gallery has one real photo/caption per state, unique trigger IDs with data-gallery-open, a native dialog within the root and explicit button data-gallery-close; closing restores trigger focus. Output wrapper textContent equals the caption (image alt is separate). Details uses one native summary control ID for exactly two states: closed [] and open [all output IDs]. No-JS keeps all filter/process outputs visible, and gallery photos/captions inline or as visible local photo links with exact caption labels. Hide enhancement-only controls until handlers exist. Optional motionTargetId is an actual supporting data-reveal element on this page, never primary text/action. Design finite photo/state transitions for the business, immediate static alternatives, rapid replacement and correct final state; do not impose a layout or effects quota.`;
