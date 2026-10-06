import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError, DEFAULT_MAX_BLOB_BYTES, loadConfig } from '../server/config.js';
import { LOGIN, PROJECT_ROOT, PUBLIC_ORIGIN, SERVER_ENTRY, runToExit, spawnServer, tailscaleEnv, tempDir } from './server-harness.js';

const load = (env) => loadConfig(env, { projectRoot: PROJECT_ROOT });

test('sem GROOVE_DATA_DIR o servidor é só estático, como antes', () => {
  const config = load({});
  assert.equal(config.api, null);
  assert.equal(config.port, 5173);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.basePath, '/');
  assert.equal(load({ BASE_PATH: 'groovegoblin' }).basePath, '/groovegoblin/');
});

test('variáveis de API sem data dir recusam em vez de ligar algo pela metade', () => {
  for (const name of ['GROOVE_AUTH', 'GROOVE_ALLOWED_LOGINS', 'GROOVE_PUBLIC_ORIGIN', 'GROOVE_MAX_BLOB_BYTES']) {
    assert.throws(() => load({ [name]: 'x' }), ConfigError, name);
  }
});

test('data dir configurado liga a API em dev com limites padrão', () => {
  const config = load({ GROOVE_DATA_DIR: '/srv/groove-teste' });
  assert.equal(config.api.mode, 'dev');
  assert.equal(config.api.maxBlobBytes, DEFAULT_MAX_BLOB_BYTES);
  assert.equal(config.api.backupKeep, 14);
  assert.deepEqual(config.api.allowedLogins, []);
});

test('tailscale exige lista não vazia, origem https canônica e bind 127.0.0.1', () => {
  const base = { GROOVE_DATA_DIR: '/srv/groove-teste', ...tailscaleEnv() };
  const ok = load(base);
  assert.equal(ok.api.mode, 'tailscale');
  assert.deepEqual(ok.api.allowedLogins, [LOGIN]);
  assert.deepEqual(ok.api.publicOrigin, { origin: PUBLIC_ORIGIN, host: 'groove.exemplo.ts.net' });
  for (const [label, patch] of [
    ['lista ausente', { GROOVE_ALLOWED_LOGINS: undefined }],
    ['lista vazia', { GROOVE_ALLOWED_LOGINS: ' , ,' }],
    ['login com espaço', { GROOVE_ALLOWED_LOGINS: 'a b@example.org' }],
    ['origem ausente', { GROOVE_PUBLIC_ORIGIN: undefined }],
    ['origem http', { GROOVE_PUBLIC_ORIGIN: 'http://groove.exemplo.ts.net' }],
    ['origem com caminho', { GROOVE_PUBLIC_ORIGIN: 'https://groove.exemplo.ts.net/app' }],
    ['origem não canônica', { GROOVE_PUBLIC_ORIGIN: 'https://Groove.Exemplo.ts.net:443' }],
    ['bind externo', { GROOVE_HOST: '0.0.0.0' }],
    ['bind ipv6', { GROOVE_HOST: '::1' }],
    ['bind de rede', { GROOVE_HOST: '192.0.2.10' }],
  ]) {
    assert.throws(() => load({ ...base, ...patch }), ConfigError, label);
  }
});

test('dev só loopback e sem variáveis exclusivas do tailscale', () => {
  assert.equal(load({ GROOVE_DATA_DIR: '/srv/g', GROOVE_HOST: '::1' }).host, '::1');
  assert.throws(() => load({ GROOVE_DATA_DIR: '/srv/g', GROOVE_HOST: '0.0.0.0' }), ConfigError);
  assert.throws(() => load({ GROOVE_HOST: '0.0.0.0' }), ConfigError);
  assert.throws(() => load({ GROOVE_DATA_DIR: '/srv/g', GROOVE_ALLOWED_LOGINS: LOGIN }), ConfigError);
  assert.throws(() => load({ GROOVE_DATA_DIR: '/srv/g', GROOVE_PUBLIC_ORIGIN: PUBLIC_ORIGIN }), ConfigError);
  assert.throws(() => load({ GROOVE_DATA_DIR: 'relativo/dados' }), ConfigError);
  assert.throws(() => load({ GROOVE_DATA_DIR: '/srv/g', GROOVE_AUTH: 'nenhum' }), ConfigError);
  assert.throws(() => load({ GROOVE_DATA_DIR: '/srv/g', GROOVE_MAX_BLOB_BYTES: '12abc' }), ConfigError);
  assert.throws(() => load({ GROOVE_DATA_DIR: '/srv/g', GROOVE_BACKUP_KEEP: '0' }), ConfigError);
});

test('subida recusada de verdade: sai com 1 sem citar caminho nem login', async (t) => {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const cases = [
    { GROOVE_DATA_DIR: dataDir, GROOVE_AUTH: 'tailscale', GROOVE_PUBLIC_ORIGIN: PUBLIC_ORIGIN },
    { GROOVE_DATA_DIR: dataDir, ...tailscaleEnv({ GROOVE_HOST: '0.0.0.0' }) },
    { GROOVE_DATA_DIR: dataDir, GROOVE_HOST: '0.0.0.0' },
    { GROOVE_AUTH: 'tailscale', GROOVE_ALLOWED_LOGINS: LOGIN },
  ];
  for (const env of cases) {
    const result = await runToExit([SERVER_ENTRY], env);
    assert.equal(result.code, 1, JSON.stringify(Object.keys(env)));
    assert.match(result.stderr, /GrooveGoblin não subiu/);
    assert.ok(!result.stderr.includes(dir), 'mensagem não cita o caminho');
    assert.ok(!result.stderr.includes(LOGIN), 'mensagem não cita o login');
  }
  assert.deepEqual(await readdir(dir), [], 'nenhuma recusa criou o data dir');
});

test('data dir dentro do repositório é recusado antes de criar qualquer pasta', async () => {
  const inside = join(PROJECT_ROOT, 'gg-dados-nao-deve-existir', 'sub');
  const result = await runToExit([SERVER_ENTRY], { GROOVE_DATA_DIR: inside });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fora do repositório/);
  assert.ok(!(await readdir(PROJECT_ROOT)).includes('gg-dados-nao-deve-existir'));
  const parent = await runToExit([SERVER_ENTRY], { GROOVE_DATA_DIR: join(PROJECT_ROOT, '..') });
  assert.equal(parent.code, 1, 'data dir que contém o repositório também é recusado');
});

test('pasta com arquivos alheios não vira data dir', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'anotacoes.txt'), 'qualquer coisa');
  const result = await runToExit([SERVER_ENTRY], { GROOVE_DATA_DIR: dir });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /não são do GrooveGoblin/);
  assert.deepEqual(await readdir(dir), ['anotacoes.txt']);
});

test('dois processos no mesmo data dir: o segundo é recusado pelo lock', async (t) => {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  await mkdir(dataDir);
  const first = spawnServer({ GROOVE_DATA_DIR: dataDir });
  t.after(() => first.child.kill('SIGKILL'));
  await first.ready;
  const second = await runToExit([SERVER_ENTRY], { GROOVE_DATA_DIR: dataDir });
  assert.equal(second.code, 1);
  assert.match(second.stderr, /Outro processo/);
  first.child.kill('SIGTERM');
  assert.equal((await first.exited).code, 0);
  const third = spawnServer({ GROOVE_DATA_DIR: dataDir });
  t.after(() => third.child.kill('SIGKILL'));
  assert.ok(await third.ready, 'lock liberado no SIGTERM permite subir de novo');
});
