import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fail, FactoryError } from './contracts.mjs';

// Each research attempt owns its server and exact source-job environment. Never
// attach to a shared service: its already-started MCP cannot inherit this job.
export async function withResearcherServer({ cwd, env, signal, timeout = 600000 }, run) {
  const started = Date.now(), deadline = started + timeout;
  const unavailable = () => fail('SOURCE_WORKFLOW_UNAVAILABLE', 'The private source workflow could not become or remain available.');
  if (signal?.aborted) fail('CANCELLED', 'Research cancelled.');
  if (!Number.isFinite(timeout) || timeout <= 0) unavailable();
  const controller = new AbortController();
  let child, closed = false, stopped = false, closePromise, timer;
  let rejectInterrupted;
  const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
  const cancel = () => {
    controller.abort();
    rejectInterrupted(new FactoryError('CANCELLED', 'Research cancelled.'));
  };
  // Observe immediately, even if cancellation occurs during port reservation.
  interrupted.catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  timer = setTimeout(() => {
    controller.abort();
    rejectInterrupted(new FactoryError('SOURCE_WORKFLOW_UNAVAILABLE', 'The private source workflow exceeded its bounded deadline.'));
  }, timeout);
  try {
    const reserve = http.createServer();
    const port = await Promise.race([new Promise((resolve, reject) => {
      reserve.once('error', reject);
      reserve.listen(0, '127.0.0.1', () => {
        const port = reserve.address().port;
        reserve.close(error => error ? reject(error) : resolve(port));
      });
    }), interrupted]).catch(() => { if (signal?.aborted) fail('CANCELLED', 'Research cancelled.'); unavailable(); });
    if (controller.signal.aborted) unavailable();
    const privateEnv = { ...env, OPENCODE_PASSWORD: randomBytes(32).toString('base64url') };
    const url = `http://127.0.0.1:${port}`;
    const authorization = 'Basic ' + Buffer.from('opencode:' + privateEnv.OPENCODE_PASSWORD).toString('base64');
    child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
      { cwd, env: privateEnv, detached: true, stdio: 'ignore' });
    closePromise = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
    const childStopped = () => {
      stopped = true;
      rejectInterrupted(new FactoryError('SOURCE_WORKFLOW_UNAVAILABLE', 'The private source workflow stopped unexpectedly.'));
    };
    child.once('error', childStopped); child.once('exit', childStopped);
    const startupDeadline = Math.min(deadline, started + 20000);
    const operation = async () => {
      while (!controller.signal.aborted && !stopped && Date.now() < startupDeadline) {
        let state;
        try {
          const response = await fetch(url + '/api/mcp', { headers: { authorization },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.min(1000, startupDeadline - Date.now())))]) });
          if (response.ok) state = (await response.json()).data?.find(row => row.name === 'sources')?.status?.status;
        } catch { /* Listener and catalog initialize asynchronously; retry only within startup bound. */ }
        if (stopped || controller.signal.aborted) break;
        if (state === 'connected') {
          if (Date.now() >= startupDeadline) unavailable();
          return run({ url, env: privateEnv, signal: controller.signal, timeout: Math.max(1, deadline - Date.now()) });
        }
        if (state && state !== 'pending') unavailable();
        await delay(Math.min(100, Math.max(1, startupDeadline - Date.now())), undefined, { signal: controller.signal });
      }
      unavailable();
    };
    return await Promise.race([operation(), interrupted]);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort();
    if (child?.pid) {
      const groupAlive = () => {
        try { process.kill(-child.pid, 0); return true; } catch (e) { if (e.code !== 'ESRCH') throw e; return false; }
      };
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      const grace = Date.now() + 2000;
      while ((!closed || groupAlive()) && Date.now() < grace) await delay(25);
      if (!closed || groupAlive()) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
        await Promise.race([closePromise, delay(2000)]);
        if (!closed) unavailable();
      }
    } else if (closePromise) await closePromise;
  }
}
