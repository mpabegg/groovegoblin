// Composição do servidor: estático sempre; API só com data dir configurado.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApiHandler } from './api.js';
import { createAuthContext } from './auth.js';
import { scheduleDailyBackups } from './backup.js';
import { staticSecurityHeaders } from './http.js';
import { createStaticHandler } from './static.js';
import { openStore } from './store.js';
import { loadIntakeLimits } from './config.js';

const API_REQUEST_TIMEOUT_MS = 30 * 60 * 1000; // upload de 200 MiB por Wi-Fi lento

function packageVersion(projectRoot) {
  try {
    return JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Sobe o servidor e resolve quando estiver escutando. Opções só para testes e
// ferramentas: now (relógio), log, backups (agenda diária ligada por padrão).
export async function startGrooveServer(config, { now = () => new Date(), log = (line) => console.log(line), backups = true, convertMap } = {}) {
  const projectRoot = resolve(config.projectRoot);
  const api = config.api;
  const store = api
    ? await openStore({ dataDir: api.dataDir, guardRoots: [projectRoot, config.staticRoot], now, minFreeBytes: api.minFreeBytes })
    : null;
  // Depois do openStore: o data dir já foi conferido (fora do repositório, marcado).
  const intakeLimits = api ? await loadIntakeLimits(api.dataDir, api.intakeLimits ?? {}) : null;
  const serveStatic = createStaticHandler({ root: config.staticRoot, projectRoot, basePath: config.basePath, hsts: api?.mode === 'tailscale', apiEnabled: Boolean(api) });
  // Os fallbacks 400/404 do app saem com os MESMOS cabeçalhos de segurança do
  // estático (e HSTS no modo tailscale); nada de CSP duplicada.
  const security = staticSecurityHeaders({ hsts: api?.mode === 'tailscale' });
  let apiHandler = null;

  const server = createServer((request, response) => {
    if (apiHandler && apiHandler.isApiPath(request.url.split('?')[0])) {
      apiHandler.handle(request, response);
      return;
    }
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      response.writeHead(400, security).end();
      return;
    }
    serveStatic(request, response, url).catch(() => {
      if (!response.headersSent) response.writeHead(404, { ...security, 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
    });
  });
  if (api) server.requestTimeout = API_REQUEST_TIMEOUT_MS;

  server.once('listening', () => {
    if (!store) return;
    const { port } = server.address();
    apiHandler = createApiHandler({
      store,
      auth: createAuthContext({ mode: api.mode, port, allowedLogins: api.allowedLogins, publicOrigin: api.publicOrigin }),
      basePath: config.basePath,
      maxBlobBytes: api.maxBlobBytes,
      backupKeep: api.backupKeep,
      intakeLimits,
      mode: api.mode,
      version: packageVersion(projectRoot),
      log,
      convertMap,
    });
  });

  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(config.port, config.host, () => {
        server.removeListener('error', rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    await store?.close();
    throw error;
  }

  const stopBackups = store && backups ? scheduleDailyBackups(store, { keep: api.backupKeep, log }) : () => {};
  const { port } = server.address();
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  let closing = null;
  return {
    server,
    store,
    port,
    origin: `http://${host}:${port}`,
    url: `http://${host}:${port}${config.basePath}`,
    close() {
      closing ??= (async () => {
        stopBackups();
        await new Promise((resolveClose) => {
          server.close(() => resolveClose());
          server.closeAllConnections?.();
        });
        await store?.close();
      })();
      return closing;
    },
  };
}
