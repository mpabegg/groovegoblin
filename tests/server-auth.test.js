import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LOGIN, OTHER_LOGIN, PUBLIC_HOST, PUBLIC_ORIGIN, send, startServer, tailscaleEnv, tempDir } from './server-harness.js';

const SHA = createHash('sha256').update('blob de teste').digest('hex');
// Toda família de rota, inclusive blob, privado e backup.
const READ_PATHS = ['/api/health', '/api/docs', '/api/docs/exercises', '/api/docs/exercises/x', '/api/changes', `/api/blobs/${SHA}`, '/api/private/map', '/api/backups', '/api/backups/latest', '/api/rota-que-nao-existe'];

async function tailscaleServer(t) {
  const dir = await tempDir(t);
  return startServer(t, { dataDir: join(dir, 'dados'), env: tailscaleEnv() });
}

test('tailscale: identidade ausente → 401 em TODA rota da API (sem revelar rotas)', async (t) => {
  const { port } = await tailscaleServer(t);
  for (const path of READ_PATHS) {
    const response = await send(port, { path, headers: { Host: PUBLIC_HOST } });
    assert.equal(response.status, 401, path);
    assert.equal(response.json().error, 'identity_required');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  }
  const write = await send(port, { method: 'PUT', path: `/api/blobs/${SHA}`, headers: { Host: PUBLIC_HOST, Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/octet-stream' }, body: 'blob de teste' });
  assert.equal(write.status, 401);
});

test('tailscale: login errado → 401, login certo → 200, comparação exata e sem repetição', async (t) => {
  const { port, client, logs } = await tailscaleServer(t);
  for (const login of [OTHER_LOGIN, LOGIN.toUpperCase(), `${LOGIN}.evil.example`, `${LOGIN},${OTHER_LOGIN}`]) {
    const response = await send(port, { path: '/api/health', headers: { Host: PUBLIC_HOST, 'Tailscale-User-Login': login } });
    assert.equal(response.status, 401, login);
    assert.equal(response.json().error, 'identity_forbidden');
  }
  const duplicated = await send(port, { path: '/api/health', rawHeaders: ['Host', PUBLIC_HOST, 'Tailscale-User-Login', LOGIN, 'Tailscale-User-Login', LOGIN] });
  assert.equal(duplicated.status, 400);
  assert.equal(duplicated.json().error, 'identity_ambiguous');
  const good = await client.get('/api/health');
  assert.equal(good.status, 200);
  assert.equal(good.json().mode, 'tailscale');
  for (const path of READ_PATHS.slice(0, 5)) assert.equal((await client.get(path)).status === 401, false, path);
  assert.ok(logs.every((line) => !line.includes(LOGIN) && !line.includes(OTHER_LOGIN)), 'logs sem login');
});

test('tailscale: Host fora da origem pública ou loopback → 403', async (t) => {
  const { port } = await tailscaleServer(t);
  const evil = await send(port, { path: '/api/health', headers: { Host: 'rebind.example.org', 'Tailscale-User-Login': LOGIN } });
  assert.equal(evil.status, 403);
  assert.equal(evil.json().error, 'host_forbidden');
  const loopback = await send(port, { path: '/api/health', headers: { Host: `127.0.0.1:${port}`, 'Tailscale-User-Login': LOGIN } });
  assert.equal(loopback.status, 200);
});

test('tailscale: escrita exige Origin pública exata e Sec-Fetch-Site same-origin', async (t) => {
  const { port, client } = await tailscaleServer(t);
  const json = Buffer.from('{"a":1}');
  const base = { Host: PUBLIC_HOST, 'Tailscale-User-Login': LOGIN, 'Content-Type': 'application/json', 'If-None-Match': '*' };
  const attempts = [
    [{}, 'origin_forbidden'],
    [{ Origin: 'https://evil.example.org' }, 'origin_forbidden'],
    [{ Origin: `http://127.0.0.1:${port}` }, 'origin_forbidden'],
    [{ Origin: 'null' }, 'origin_forbidden'],
    [{ Origin: PUBLIC_ORIGIN, 'Sec-Fetch-Site': 'cross-site' }, 'fetch_site_forbidden'],
    [{ Origin: PUBLIC_ORIGIN, 'Sec-Fetch-Site': 'same-site' }, 'fetch_site_forbidden'],
  ];
  for (const [headers, code] of attempts) {
    const response = await send(port, { method: 'PUT', path: '/api/docs/exercises/csrf', headers: { ...base, ...headers }, body: json });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.json().error, code);
  }
  assert.equal((await client.get('/api/docs/exercises/csrf')).status, 404, 'nenhuma tentativa gravou');
  // CLI: sem Sec-Fetch-Site, com Origin explícito.
  const cli = await send(port, { method: 'PUT', path: '/api/docs/exercises/csrf', headers: { ...base, Origin: PUBLIC_ORIGIN }, body: json });
  assert.equal(cli.status, 201);
  for (const [method, path] of [['POST', '/api/backups'], ['DELETE', `/api/blobs/${SHA}`], ['PUT', '/api/private/map'], ['POST', '/api/courses/convert'], ['DELETE', '/api/docs/exercises/csrf']]) {
    const response = await send(port, { method, path, headers: { Host: PUBLIC_HOST, 'Tailscale-User-Login': LOGIN } });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal(response.json().error, 'origin_forbidden');
  }
});

test('dev: loopback sem identidade; Host estranho e cabeçalhos de proxy recusados', async (t) => {
  const dir = await tempDir(t);
  const { port, client } = await startServer(t, { dataDir: join(dir, 'dados') });
  assert.equal((await client.get('/api/health')).status, 200);
  assert.equal((await send(port, { path: '/api/health', headers: { Host: `localhost:${port}` } })).status, 200);
  const rebind = await send(port, { path: '/api/health', headers: { Host: `rebind.example.org:${port}` } });
  assert.equal(rebind.status, 403);
  assert.equal(rebind.json().error, 'host_forbidden');
  assert.equal((await send(port, { path: '/api/health', headers: { Host: PUBLIC_HOST } })).status, 403);
  for (const header of ['Tailscale-User-Login', 'Tailscale-User-Name', 'X-Forwarded-For', 'Forwarded', 'X-Forwarded-Host']) {
    const response = await send(port, { path: '/api/health', headers: { Host: `127.0.0.1:${port}`, [header]: LOGIN } });
    assert.equal(response.status, 403, header);
    assert.equal(response.json().error, 'proxied_request_refused');
  }
  const noOrigin = await send(port, { method: 'PUT', path: '/api/docs/exercises/x', headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'If-None-Match': '*' }, body: '{}' });
  assert.equal(noOrigin.status, 403);
  const otherPort = await send(port, { method: 'PUT', path: '/api/docs/exercises/x', headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port + 1}`, 'Content-Type': 'application/json', 'If-None-Match': '*' }, body: '{}' });
  assert.equal(otherPort.status, 403);
  const ok = await send(port, { method: 'PUT', path: '/api/docs/exercises/x', headers: { Host: `127.0.0.1:${port}`, Origin: `http://localhost:${port}`, 'Content-Type': 'application/json', 'If-None-Match': '*' }, body: '{}' });
  assert.equal(ok.status, 201);
  const health = (await client.get('/api/health')).headers;
  assert.equal(health['strict-transport-security'], undefined);
  assert.equal(health['x-content-type-options'], 'nosniff');
  assert.equal(health['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
  assert.equal(health['cross-origin-resource-policy'], 'same-origin');
});
