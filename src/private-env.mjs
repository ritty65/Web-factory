import { lstatSync } from 'node:fs';
import { resolve, parse, join, relative } from 'node:path';

import { fileURLToPath } from 'node:url';
const DEFAULT_STATE = fileURLToPath(new URL('../.factory-state', import.meta.url));
const MAX_ENV_BYTES = 65536;

// Selection matches bin/factory: explicit overrides must never inherit canonical credentials.
export function loadPrivateEnvironment() {
  const state = Object.hasOwn(process.env, 'FACTORY_STATE') ? process.env.FACTORY_STATE
    : Object.hasOwn(process.env, 'FACTORY_DB') ? '' : DEFAULT_STATE;
  if (!state) return;
  const file = resolve(state, 'credentials', 'firecrawl.env');
  try {
    const root = parse(file).root;
    let current = root;
    const parts = relative(root, file).split('/');
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      let stat;
      try { stat = lstatSync(current); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (stat.isSymbolicLink()) throw new Error();
      if (i < parts.length - 1) {
        if (!stat.isDirectory()) throw new Error();
      } else if (!stat.isFile() || stat.size > MAX_ENV_BYTES || !(stat.mode & 0o400)) {
        throw new Error();
      }
    }
    // Node's native dotenv implementation preserves variables already in process.env.
    process.loadEnvFile(file);
  } catch {
    throw new Error('Factory private environment could not be loaded');
  }
}
