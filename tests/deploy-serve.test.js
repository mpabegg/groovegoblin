// Publicação no `tailscale serve` (rodada 6, etapa 9): testes de CONTRATO do
// `deploy/install.sh`.
//
// Regra do contrato: o instalador só pode ADICIONAR a porta HTTPS pedida quando
// ela está livre. Com outro serviço já publicado na 443 (o caso comum de
// convivência no Pi), pedir `--serve-port 8443` tem que publicar a 8443 e deixar
// a 443 exatamente como estava — nunca recusar tudo, nunca substituir, nunca
// remover o que é dos outros.
//
// O `tailscale` aqui é um stub (arquivo temporário): nenhum teste toca a rede
// nem a configuração real de `serve` desta máquina.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// Nome fictício (example.ts.net), igual ao do resto do repositório.
const WEB_HOST = 'maquina.exemplo.ts.net';

// Recorta as funções reais do instalador: nada de lógica duplicada aqui.
function serveFunctions(source = readFileSync(path.join(root, 'deploy/install.sh'), 'utf8')) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith('# Lê o JSON do `serve`'));
  const fn = lines.indexOf('configure_serve() {');
  const end = lines.findIndex((line, i) => i > fn && line === '}');
  assert.ok(start >= 0 && fn > start && end > fn, 'não achei as funções do serve em deploy/install.sh');
  const body = lines.slice(start, end + 1).join('\n');
  assert.match(body, /--bg --https=/, 'configure_serve recortada não parece a de verdade');
  return body;
}

const FAKE_CLI = `// CLI falsa do tailscale: só o que o install.sh usa.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const WEB_HOST = '${WEB_HOST}';
const [base, ...args] = process.argv.slice(2);
const state = base + '/state.json', text = base + '/statetxt', calls = base + '/calls.txt';
const read = () => { try { return JSON.parse(readFileSync(state, 'utf8')); } catch { return {}; } };
if (args[0] === 'status' && args.length === 1) process.exit(0);
if (args[0] === 'serve' && args[1] === 'status') {
  process.stdout.write(readFileSync(args.includes('--json') ? state : text, 'utf8'));
  process.exit(0);
}
if (args[0] !== 'serve') process.exit(1);
let port = null, target = null;
for (const arg of args.slice(1)) {
  if (arg === '--bg' || arg === '--yes') continue;
  if (arg.startsWith('--https=')) { port = arg.slice('--https='.length); continue; }
  target = arg;
}
appendFileSync(calls, port + ' ' + target + '\\n');
const entry = { Handlers: { '/': { Proxy: target } } };
if (process.env.WIPE === '1') writeFileSync(state, JSON.stringify({ TCP: { [port]: { HTTPS: true } }, Web: { [WEB_HOST + ':' + port]: entry } }));
else {
  const cfg = read();
  cfg.TCP = cfg.TCP || {}; cfg.Web = cfg.Web || {};
  cfg.TCP[port] = { HTTPS: true }; cfg.Web[WEB_HOST + ':' + port] = entry;
  writeFileSync(state, JSON.stringify(cfg));
}
`;

const HEAD = `#!/usr/bin/env bash
set -Eeuo pipefail
log() { printf 'LOG: %s\\n' "$*"; }
warn() { printf 'WARN: %s\\n' "$*" >&2; }
die() { printf 'DIE: %s\\n' "$*" >&2; exit 1; }
`;

// Roda configure_serve com a CLI falsa. Devolve { rc, stdout, stderr, calls, state }.
function runServe({ serve, port = 5173 }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'r6-serve-'));
  writeFileSync(path.join(dir, 'fake-tailscale.js'), FAKE_CLI);
  writeFileSync(path.join(dir, 'state.json'), serve.raw ?? JSON.stringify({ TCP: serve.TCP ?? {}, Web: serve.Web ?? {} }));
  writeFileSync(path.join(dir, 'statetxt'), serve.text);
  writeFileSync(path.join(dir, 'calls.txt'), '');
  writeFileSync(path.join(dir, 'run.sh'), [
    '#!/usr/bin/env bash',
    HEAD,
    `T=${dir}`, `NODE_BIN=${process.execPath}`, `SERVE_PORT=${serve.port}`, `PORT=${port}`,
    'tailscale() { "$NODE_BIN" "$T/fake-tailscale.js" "$T" "$@"; }',
    serveFunctions(), 'configure_serve', '',
  ].join('\n'));
  const env = { ...process.env };
  delete env.WIPE;
  if (serve.wipe) env.WIPE = '1';
  let rc = 0, stdout = '', stderr = '';
  try {
    stdout = execFileSync('bash', [path.join(dir, 'run.sh')], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    rc = error.status ?? 1;
    stdout = error.stdout ?? ''; stderr = error.stderr ?? '';
  }
  const raw = readFileSync(path.join(dir, 'state.json'), 'utf8');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* estado ilegível de propósito */ }
  return { rc, stdout, stderr, calls: readFileSync(path.join(dir, 'calls.txt'), 'utf8').trim(), state: parsed, raw };
}

const empty = () => ({ TCP: {}, Web: {}, text: 'No serve config' });
const otherOn443 = (handler = { Proxy: 'http://127.0.0.1:8080' }) => ({
  TCP: { 443: { HTTPS: true } },
  Web: { 'maquina.exemplo.ts.net:443': { Handlers: { '/': handler } } },
  text: 'https://maquina.exemplo.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:8080',
});
const root443 = (state) => state.Web['maquina.exemplo.ts.net:443'].Handlers['/'];

test('sem configuração: publica a porta pedida', () => {
  const out = runServe({ serve: { ...empty(), port: '443' } });
  assert.equal(out.rc, 0, out.stderr);
  assert.deepEqual(out.calls.split('\n'), ['443 http://127.0.0.1:5173']);
  assert.deepEqual(out.state.Web['maquina.exemplo.ts.net:443'].Handlers['/'], { Proxy: 'http://127.0.0.1:5173' });
});

test('outro serviço na 443: --serve-port 8443 ADICIONA a 8443 e preserva a 443', () => {
  const before = otherOn443();
  const out = runServe({ serve: { ...before, port: '8443' } });
  assert.equal(out.rc, 0, out.stderr);
  assert.deepEqual(out.calls.split('\n'), ['8443 http://127.0.0.1:5173'], 'só a porta nova pode ser tocada');
  assert.deepEqual(root443(out.state), { Proxy: 'http://127.0.0.1:8080' }, 'a 443 tem que ficar igual');
  assert.deepEqual(out.state.Web['maquina.exemplo.ts.net:8443'].Handlers['/'], { Proxy: 'http://127.0.0.1:5173' });
  assert.deepEqual(out.state.TCP, { 443: { HTTPS: true }, 8443: { HTTPS: true } });
});

test('handler que não é proxy (pasta servida) na 443 continua intacto', () => {
  const out = runServe({ serve: { ...otherOn443({ Path: '/srv/site' }), port: '8443' } });
  assert.equal(out.rc, 0, out.stderr);
  assert.deepEqual(root443(out.state), { Path: '/srv/site' });
});

test('porta pedida já é de outro serviço: recusa e não publica nada', () => {
  const out = runServe({ serve: { ...otherOn443(), port: '443' } });
  assert.notEqual(out.rc, 0);
  assert.match(out.stderr, /não vou substituí-la/);
  assert.equal(out.calls, '', 'nenhuma publicação pode sair');
  assert.deepEqual(root443(out.state), { Proxy: 'http://127.0.0.1:8080' });
});

test('já publicando o nosso alvo na porta pedida: nada a mudar', () => {
  const mine = { TCP: { 8443: { HTTPS: true } }, Web: { 'maquina.exemplo.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5173' } } } }, text: 'x' };
  const out = runServe({ serve: { ...mine, port: '8443' } });
  assert.equal(out.rc, 0, out.stderr);
  assert.equal(out.calls, '');
  assert.match(out.stdout, /nada a mudar/);
});

test('publicação que apagaria configuração alheia é restaurada e o instalador para', () => {
  const out = runServe({ serve: { ...otherOn443(), port: '8443', wipe: true } });
  assert.notEqual(out.rc, 0);
  assert.match(out.stderr, /restaurando o que sumiu/);
  assert.deepEqual(out.calls.split('\n'), ['8443 http://127.0.0.1:5173', '443 http://127.0.0.1:8080'], 'a 443 tem que voltar');
  assert.deepEqual(root443(out.state), { Proxy: 'http://127.0.0.1:8080' });
});

test('JSON do serve ilegível com configuração existente: não publica às cegas', () => {
  const out = runServe({ serve: { raw: '<não é json>', text: 'https://maquina.exemplo.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:8080', port: '8443' } });
  assert.notEqual(out.rc, 0);
  assert.match(out.stderr, /publicaria às cegas/);
  assert.equal(out.calls, '');
});
