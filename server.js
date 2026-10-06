import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ConfigError, loadConfig } from './server/config.js';
import { startGrooveServer } from './server/app.js';
import { StorageError } from './server/fsutil.js';

// Sem GROOVE_DATA_DIR: só estático, como sempre. Com ele: API (ver server/config.js).
const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));

let config;
let running;
try {
  config = loadConfig(process.env, { projectRoot });
  running = await startGrooveServer(config);
} catch (error) {
  if (error instanceof ConfigError || error instanceof StorageError) console.error(`GrooveGoblin não subiu: ${error.message}`);
  else console.error(error.message);
  process.exit(1);
}

const api = config.api ? ` · API ${config.api.mode}${config.api.mode === 'tailscale' ? ` (${config.api.allowedLogins.length} login(s) permitido(s))` : ''}` : '';
console.log(`GrooveGoblin: ${running.url}${api}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    running.close().then(() => process.exit(0), () => process.exit(1));
  });
}
