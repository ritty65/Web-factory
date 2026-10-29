#!/usr/bin/env node
import { initialize, openStore } from './db.mjs';
import { createService, configFromEnv, OPERATIONS } from './service.mjs';
const command = process.argv[2] || 'help';
const config = configFromEnv();
try {
  if (command === 'help' || command === '--help') {
    console.log(JSON.stringify({ usage: 'bin/factory <init|open|serve|work|operation> [JSON object]', operations: Object.fromEntries(Object.entries(OPERATIONS).map(([name, op]) => [name, { readOnly: op.readOnly, description: op.description }])), scope: 'local private proposals only; no acceptance/outreach/deployment' }, null, 2));
  } else if (command === 'init') {
    await initialize(config); console.log(JSON.stringify({ initialized: true, note: 'Additive Factory schema; original library records preserved; backup retained.' }));
  } else {
    const store = openStore(config), service = createService(store, config);
    if (command === 'open') {
      const { openFactory } = await import('./startup.mjs'); const opened = await openFactory(service);
      service.wakeOwnedWork();
      console.log(JSON.stringify({ app: opened.url, isolatedPreview: opened.previewUrl, reused: opened.reused, automaticBatchStart: false }));
      if (opened.reused) store.close();
      else for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await opened.server.close(); store.close(); process.exit(0); });
    } else if (command === 'serve') {
      const { startServer } = await import('./server.mjs');
      const server = await startServer(service);
      service.wakeOwnedWork();
      console.log(JSON.stringify({ app: server.url, isolatedPreview: server.previewUrl }));
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); store.close(); process.exit(0); });
    } else if (command === 'work') {
      const { work } = await import('./worker.mjs'); await work(store); store.close();
    } else {
      const input = process.argv[3] ? JSON.parse(process.argv[3]) : {};
      console.log(JSON.stringify(await service.dispatch(command, input), null, 2)); store.close();
    }
  }
} catch (e) { console.error(JSON.stringify({ error: e.code || 'FAILED', message: e.code ? e.message : 'Command failed; verify input and local setup' })); process.exitCode = 1; }
