import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess, parseModelJson } from './process.mjs';
import { hash, fail, now } from './contracts.mjs';
import { noLinks } from './db.mjs';
import { jobBudgetContext, reserveBatchUsage } from './batch-budget.mjs';
import { batchForCampaign } from './batch-store.mjs';
import { withResearcherServer } from './researcher-server.mjs';

// Native CLI --model selects provider/model; never inherit the global default.
// Contract: https://opencode.ai/v2/docs/cli/ and installed `opencode run --help`.
export const DEFAULT_FACTORY_MODEL = 'openai/gpt-6.1-sol-fast';

export async function modelRequestIdentity({ role, prompt, model, files = [] }) {
  model ||= DEFAULT_FACTORY_MODEL;
  if (files.length > 16) fail('MODEL_IMAGE_CAP', 'At most 16 actual review inputs per bounded model request');
  let total = 0; const inputs = [];
  for (const file of files) {
    await noLinks(file); const info = await stat(file); total += info.size;
    if (!info.isFile() || info.size > 8 * 1024 * 1024 || total > 32 * 1024 * 1024) fail('MODEL_IMAGE_CAP', 'Review files exceed the 8MiB individual / 32MiB total attachment bound');
    inputs.push({ file, sha256: hash(await readFile(file)) });
  }
  return hash({ role, prompt, model, inputs });
}

export async function requestModel({ role, prompt, directory, model, signal, sourcesDirectory, researchLimit = null, files = [], timeout = 600000 }) {
  if (!['proposer', 'researcher'].includes(role)) fail('MODEL_ROLE', 'Unsupported bounded model role');
  model ||= DEFAULT_FACTORY_MODEL;
  const requestId = await modelRequestIdentity({ role, prompt, model, files });
  const cache = path.join(directory, `model-${requestId}.json`); await noLinks(cache);
  try { const saved = JSON.parse(await readFile(cache, 'utf8')); if (saved.requestId !== requestId) fail('MODEL_CACHE', 'Model cache identity mismatch'); return saved; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const budget = jobBudgetContext(), batch = budget && batchForCampaign(budget.store, budget.store.job(budget.jobId).campaignId);
  const cwd = fileURLToPath(new URL(`../workers/${role === 'researcher' && batch ? 'batch-researcher' : role}/`, import.meta.url));
  const args = ['run', '--standalone', '--agent', `factory-${role}`, '--format', 'json', '--title', `Factory ${role} ${requestId.slice(0, 8)}`];
  args.push('--model', model);
   if (files.length > 16) fail('MODEL_IMAGE_CAP', 'At most 16 actual review inputs per bounded model request');
   for (const file of files) { await noLinks(file); args.push('--file', file); }
  args.push(prompt);
  const started = Date.now();
  if (batch) reserveBatchUsage(budget.store, budget.jobId, 'modelRequests');
  if(researchLimit!==null&&(!Number.isInteger(researchLimit)||researchLimit<1||researchLimit>100))fail('RESEARCH_SCHEMA','Invalid host research candidate limit.');
  const env = { ...process.env, PWD: cwd, FACTORY_RESEARCH_REQUEST:researchLimit===null?'':requestId, FACTORY_RESEARCH_LIMIT:researchLimit===null?'':String(researchLimit), ...(sourcesDirectory ? { FACTORY_SOURCES: sourcesDirectory } : {}), ...(batch && sourcesDirectory ? { FACTORY_DB: budget.store.dbPath, FACTORY_STATE: budget.store.stateRoot, FACTORY_SOURCE_JOB: budget.jobId } : {}) };
  const launch = ({ url, env: launchEnv = env, signal: launchSignal = signal, timeout: remaining = timeout } = {}) => runProcess('opencode', url ? ['run', '--server', url, ...args.slice(2)] : args, { cwd, env: launchEnv, signal: launchSignal, timeout: remaining, maxBytes: 3 * 1024 * 1024 });
  // Batch source tools need their exact job environment connected BEFORE the
  // model's first turn. Standalone startup exposed an empty tool set in live runs.
  const result = role === 'researcher' && batch
    ? await withResearcherServer({ cwd, env, signal, timeout }, launch)
    : await launch();
  const events = result.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  if (events.some(e => e.type === 'error')) fail('MODEL_FAILED', 'Native model returned an error; no fabricated output was substituted');
  const texts = events.filter(e => e.type === 'text').map(e => e.part?.text || '').filter(Boolean);
  const output = parseModelJson(texts.at(-1) || '');
  const toolEvents = events.filter(e => e.type === 'tool_use').map(e => ({ tool: e.part?.tool, status: e.part?.state?.status }));
  const saved = { requestId, role, sessionId: events.find(e => e.sessionID)?.sessionID || null, modelSelection: model, at: now(), elapsedMs: Date.now() - started, toolEvents, output };
  await writeFile(cache, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
  return saved;
}
