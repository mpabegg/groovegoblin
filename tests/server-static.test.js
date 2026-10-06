import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { publicRelativePath } from '../server/static.js';
import { createAssetManifest } from '../scripts/asset-manifest.js';
import { send, startServer, tailscaleEnv, tempDir } from './server-harness.js';

// Pedido HTTP cru, para exercitar alvos que o cliente Node não monta.
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(data));
  });
}

function parseHeaders(raw) {
  const [statusLine, ...lines] = raw.split('\r\n');
  const headers = new Map();
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index > 0) headers.set(line.slice(0, index).toLowerCase(), line.slice(index + 1).trim());
  }
  return { statusLine, headers };
}

test('allowlist pública: só o que o build publica', () => {
  assert.equal(publicRelativePath('/'), 'index.html');
  assert.equal(publicRelativePath(''), 'index.html');
  assert.equal(publicRelativePath('/src/main.js'), 'src/main.js');
  assert.equal(publicRelativePath('/assets/drums/x.wav'), 'assets/drums/x.wav');
  for (const file of ['index.html', 'guide.html', 'README.md', 'manifest.webmanifest', 'icon.svg', 'sw.js', 'offline-assets.json']) {
    assert.equal(publicRelativePath(`/${file}`), file);
  }
  for (const blocked of [
    '/local/curso.json', '/server/app.js', '/tests/server-harness.js', '/scripts/build.js', '/evidence/rodada-5.md',
    '/deploy/x', '/dist/index.html', '/package.json', '/server.js', '/audio-smoke.wav', '/.git/config', '/.gitignore',
    '/src/.hidden.js', '/src/../package.json', '/src/%2e%2e/package.json', '/src%2fmain.js', '/src/%252e%252e/x',
    '/src/a%5cb', '/src/a%00b', '/src//main.js', '/src/', '/src', '/assets/',
  ]) {
    assert.equal(publicRelativePath(blocked), null, blocked);
  }
});

test('static-only (sem configuração): app servido, API inexistente, privados bloqueados', async (t) => {
  const { port, config } = await startServer(t);
  assert.equal(config.api, null);
  const index = await send(port, { path: '/' });
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal(index.headers['referrer-policy'], 'no-referrer');
  assert.match(index.headers['content-security-policy'], /default-src 'self'/);
  assert.match(index.headers['content-security-policy'], /object-src 'none'/);
  assert.equal(index.headers['strict-transport-security'], undefined, 'sem HSTS em http loopback');
  assert.equal(index.headers['cache-control'], 'no-cache');
  assert.equal((await send(port, { path: '/src/main.js' })).status, 200);
  const worker = await send(port, { path: '/sw.js' });
  assert.ok(!worker.text().includes('__GROOVE_REVISION__'), 'revisão injetada no sw.js');
  const manifest = await send(port, { path: '/offline-assets.json' });
  assert.equal(manifest.status, 200);
  assert.ok(Array.isArray(manifest.json().files));
  for (const path of ['/api/health', '/api/docs/exercises/x', '/local/x.json', '/server/app.js', '/tests/server-harness.js', '/package.json', '/.git/HEAD', '/scripts/build.js', '/src/%2e%2e/package.json', '/%2e%2e/%2e%2e/etc/passwd']) {
    const response = await send(port, { path });
    assert.equal(response.status, 404, path);
  }
  assert.equal((await send(port, { method: 'POST', path: '/' })).status, 405);
  assert.equal((await send(port, { method: 'PUT', path: '/api/docs/exercises/x' })).status, 405, 'sem API, PUT continua 405 como antes');
  assert.equal((await send(port, { method: 'HEAD', path: '/index.html' })).body.length, 0);
});

test('API ligada: a lista offline descreve os bytes entregues (o SRI do worker fecha)', async (t) => {
  const root = await tempDir(t, 'gg-static-');
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<html lang="pt-BR" data-groove-server="off"></html>');
  await writeFile(join(root, 'guide.html'), 'guia');
  await writeFile(join(root, 'README.md'), 'leiame');
  await writeFile(join(root, 'manifest.webmanifest'), '{}');
  await writeFile(join(root, 'icon.svg'), '<svg/>');
  await writeFile(join(root, 'src', 'main.js'), 'export {};');
  await writeFile(join(root, 'assets', 'drums.txt'), 'x');
  const digest = buffer => `sha256-${createHash('sha256').update(buffer).digest('base64')}`;
  // O mesmo que o build faz: a lista antes de o sw.js receber a revisão.
  await writeFile(join(root, 'sw.js'), 'const REVISION = "__GROOVE_REVISION__";\nself.addEventListener("install", () => {});');
  const built = await createAssetManifest(root);
  await writeFile(join(root, 'sw.js'), `const REVISION = '${built.version}';\nself.addEventListener('install', () => {});`);
  await writeFile(join(root, 'offline-assets.json'), JSON.stringify(built));

  // Modo de implantação: dist como raiz estática, API ligada pelo data dir.
  const deployed = await startServer(t, { dataDir: await tempDir(t), env: { STATIC_ROOT: root, ...tailscaleEnv() } });
  const index = await send(deployed.port, { path: '/' });
  assert.match(index.text(), /data-groove-server="on"/, 'servidor com API troca o marcador');
  const manifest = (await send(deployed.port, { path: '/offline-assets.json' })).json();
  assert.equal(manifest.version, built.version, 'a revisão publicada é a que o sw.js embute');
  assert.match((await send(deployed.port, { path: '/sw.js' })).text(), new RegExp(`REVISION = '${built.version}'`));
  for (const file of manifest.files) {
    const response = await send(deployed.port, { path: `/${file}` });
    assert.equal(response.status, 200, file);
    assert.equal(manifest.integrity[file], digest(response.body), `${file}: integridade contra os bytes entregues`);
  }

  // Modo de desenvolvimento: a raiz é o projeto, e a revisão sai no sw.js.
  const dev = await startServer(t, { dataDir: await tempDir(t), env: tailscaleEnv() });
  const page = await send(dev.port, { path: '/' });
  assert.match(page.text(), /data-groove-server="on"/);
  const devManifest = (await send(dev.port, { path: '/offline-assets.json' })).json();
  assert.equal(devManifest.integrity['index.html'], digest(page.body));
  assert.match((await send(dev.port, { path: '/sw.js' })).text(), new RegExp(`REVISION = '${devManifest.version}'`));
});

test('BASE_PATH do preview: redireciona, serve sob a base e 404 fora dela', async (t) => {
  const { port } = await startServer(t, { env: { BASE_PATH: '/groovegoblin/' } });
  const redirect = await send(port, { path: '/groovegoblin?x=1' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/groovegoblin/?x=1');
  assert.equal((await send(port, { path: '/groovegoblin/' })).status, 200);
  assert.equal((await send(port, { path: '/groovegoblin/src/main.js' })).status, 200);
  assert.equal((await send(port, { path: '/' })).status, 404);
  assert.equal((await send(port, { path: '/groovegoblin/local/x' })).status, 404);
  assert.equal((await send(port, { path: '/groovegoblin/package.json' })).status, 404);
});

test('symlink dentro de uma pasta pública não vaza arquivo de fora da raiz', async (t) => {
  const dir = await tempDir(t);
  const root = join(dir, 'site');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>t</title>');
  await writeFile(join(root, 'src', 'ok.js'), 'export {}');
  await writeFile(join(dir, 'segredo.txt'), 'nao pode sair');
  await symlink(join(dir, 'segredo.txt'), join(root, 'src', 'vaza.js'));
  await symlink(dir, join(root, 'assets'));
  const { port } = await startServer(t, { env: { STATIC_ROOT: root } });
  assert.equal((await send(port, { path: '/src/ok.js' })).status, 200);
  const leaked = await send(port, { path: '/src/vaza.js' });
  assert.equal(leaked.status, 404);
  assert.ok(!leaked.text().includes('nao pode sair'));
  assert.equal((await send(port, { path: '/assets/segredo.txt' })).status, 404);
});

test('com API: estático igual, API sob a base e HSTS só no modo tailscale', async (t) => {
  const dir = await tempDir(t);
  const dev = await startServer(t, { dataDir: join(dir, 'dev'), env: { BASE_PATH: '/groovegoblin/' } });
  assert.equal((await send(dev.port, { path: '/groovegoblin/' })).status, 200);
  assert.equal((await dev.client.get('/groovegoblin/api/health')).status, 200);
  assert.equal((await dev.client.get('/api/health')).status, 404, 'API fica sob BASE_PATH');
  assert.equal((await send(dev.port, { path: '/groovegoblin/local/x' })).status, 404);
  const ts = await startServer(t, { dataDir: join(dir, 'ts'), env: tailscaleEnv() });
  const page = await send(ts.port, { path: '/' });
  assert.equal(page.status, 200);
  assert.equal(page.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal((await ts.client.get('/api/health')).headers['strict-transport-security'], 'max-age=31536000');
});

test('fallback 400 do app (alvo de pedido inválido) sai com os cabeçalhos de segurança, inclusive HSTS no tailscale', async (t) => {
  const dir = await tempDir(t);
  const dev = await startServer(t);
  const rawDev = await rawRequest(dev.port, 'GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  const dev400 = parseHeaders(rawDev);
  assert.match(dev400.statusLine, /^HTTP\/1\.1 400/);
  assert.equal(dev400.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(dev400.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(dev400.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(dev400.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.match(dev400.headers.get('content-security-policy') ?? '', /default-src 'self'/, 'mesma CSP do estático, sem duplicar');
  assert.equal(dev400.headers.get('strict-transport-security'), undefined, 'sem HSTS em http loopback');

  const ts = await startServer(t, { dataDir: join(dir, 'ts'), env: tailscaleEnv() });
  const rawTs = await rawRequest(ts.port, 'GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  const ts400 = parseHeaders(rawTs);
  assert.match(ts400.statusLine, /^HTTP\/1\.1 400/);
  assert.equal(ts400.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ts400.headers.get('strict-transport-security'), 'max-age=31536000', 'HSTS no modo tailscale');
});
