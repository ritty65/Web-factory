import { spawn } from 'node:child_process';
import { fail, FactoryError } from './contracts.mjs';

// Argument arrays, no shell; a detached process group is owned only for this call.
export function runProcess(command, args, { cwd, env = process.env, signal, timeout = 60000, maxBytes = 2 * 1024 * 1024, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new FactoryError('CANCELLED', 'Operation aborted'));
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, failure = null, escalation;
    const stop = error => {
      if (failure) return;
      failure = error;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already closed */ }
      escalation = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already closed */ } }, 1500);
      escalation.unref();
    };
    const abort = () => stop(signal?.reason instanceof FactoryError ? signal.reason : new FactoryError('CANCELLED', 'Operation aborted or cancelled'));
    const timer = setTimeout(() => stop(new FactoryError('DEADLINE', 'Worker deadline exceeded')), timeout); timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { bytes += data.length; if (bytes > maxBytes) stop(new FactoryError('OUTPUT_LIMIT', 'Worker output limit exceeded')); else stdout += data; });
    child.stderr.on('data', data => { bytes += data.length; if (bytes > maxBytes) stop(new FactoryError('OUTPUT_LIMIT', 'Worker output limit exceeded')); else stderr += data; });
    child.once('error', e => { failure ||= new FactoryError('PROCESS_START', `Required executable unavailable: ${command.includes('/') ? command.split('/').pop() : command}`); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) { const error = new FactoryError('PROCESS_FAILED', `Worker exited with code ${code}; its private diagnostics were not exported`, { exitCode: code }); error.privateDiagnostics = { stdout, stderr }; reject(error); }
      else resolve({ stdout, stderr, code });
    });
    child.stdin.on('error', () => {}); if (stdin !== null) child.stdin.end(stdin); else child.stdin.end();
  });
}
export function parseModelJson(raw) {
  const value = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { const result = JSON.parse(value); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; } catch { fail('MODEL_JSON', 'Model response must be one complete JSON object, without prose or truncated files'); }
}
