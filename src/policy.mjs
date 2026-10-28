import { readFile } from 'node:fs/promises';
import { hash, fail } from './contracts.mjs';

// Fixed source inventory, never a caller-selected filesystem root.
export async function policyIdentity(scope) {
  if (!['qa', 'production'].includes(scope)) fail('POLICY_SCOPE', 'Unknown host policy scope');
  const names = ['src/policy.mjs', 'src/qa.mjs', 'src/qa-motion.mjs', 'src/qa-interactions.mjs', 'src/interaction-contract.mjs', 'src/creative.mjs', 'src/model.mjs', 'src/researcher-server.mjs', 'src/contracts.mjs', 'src/proposal.mjs', 'src/server.mjs', 'runtime/motion.js', 'runtime/motion.css'];
  if (scope === 'production') names.push('src/production.mjs', 'src/polish.mjs', 'src/creative.mjs', 'src/craft.mjs', 'src/model.mjs', 'src/media.mjs', 'src/package.mjs', 'src/intake.mjs', 'src/research.mjs', 'src/search.mjs', 'src/sources-mcp.mjs', 'src/batch-store.mjs', 'src/batch-budget.mjs', 'workers/batch-researcher/opencode.json', 'runtime/fonts/BowlbyOneSC-Regular.ttf', 'runtime/fonts/OFL.txt', 'web/assets/DMSans-Variable.ttf', 'web/assets/OFL-DMSans.txt');
  if (scope === 'production') names.push('src/batches.mjs', 'src/db.mjs', 'src/worker.mjs', 'src/promotion.mjs', 'src/prospects.mjs', 'src/private-env.mjs', 'src/mcp.mjs', 'src/browser.mjs', 'src/evidence-context.mjs', 'src/screening.mjs', 'src/progress.mjs', 'src/research-check.mjs');
  if (scope === 'production') names.push('src/destinations.mjs','src/acquisition.mjs','src/scout.mjs','src/post-evidence.mjs','src/service.mjs');
  if (scope === 'production') names.push('src/seeds.mjs','src/seed-source.mjs','src/seed-capture.mjs','tools/placeroot-runtime/server.py','tools/placeroot-runtime/requirements.lock','tools/placeroot-runtime/runtime-manifest.json');
  if (scope === 'production') names.push('src/boundaries.mjs','src/boundary-source.mjs','tools/placeroot-runtime/boundary.py');
  if (scope === 'production') names.push('src/camofox.mjs');
  if (scope === 'production') names.push('src/assisted.mjs','src/assisted-evidence.mjs');
  if (scope === 'production') names.push('src/study-continuation.mjs');
  if (scope === 'production') names.push('src/assisted-redesign.mjs');
  const files = Object.fromEntries(await Promise.all([...new Set(names)].sort().map(async name => [name, hash(await readFile(new URL('../' + name, import.meta.url)))])));
  return { scope, digest: hash(files), files };
}

async function observePolicies() {
  const observedAt = new Date().toISOString();
  const [production, qa] = await Promise.all([policyIdentity('production'), policyIdentity('qa')]);
  return { observedAt, production, qa };
}

// Eager module-initialization observation, never a lazy first-inspection baseline.
// Keep legacy policyIdentity calls usable even if this optional observation fails.
const startupObserved = await observePolicies().catch(() => null);

export async function inspectionIdentity() {
  if (!startupObserved) fail('POLICY_INSPECTION_UNAVAILABLE', 'Startup policy observation unavailable; restart from a complete source tree before inspection');
  let currentDisk;
  try { currentDisk = await observePolicies(); }
  catch { fail('POLICY_INSPECTION_UNAVAILABLE', 'Current disk policy observation unavailable; inspect the source tree before proceeding'); }
  return {
    startupObserved: structuredClone(startupObserved),
    currentDisk,
    restartRequired: ['production', 'qa'].some(scope => startupObserved[scope].digest !== currentDisk[scope].digest),
    limitations: [
      'Startup-observed filesystem hashes are not loaded-module byte attestation; they do not prove which bytes Node executed.',
      'Policy reads are not atomic; concurrent edits can produce mixed observations. Reinspect a stable tree and restart when required.',
      'A matching identity covers only the fixed policy inventories, not every source file, dependency, process or service.',
      'Inspection does not verify live sources, models, site quality or human acceptance, grant run authority, or adopt policy into historical runs.',
    ],
  };
}
