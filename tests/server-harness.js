// Apoio dos testes do servidor: data dirs temporários, servidor real em porta
// efêmera e requisições HTTP cruas (controle total de Host, Origin e cabeçalhos
// repetidos). Logins e origens são fictícios.

import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { loadConfig } from '../server/config.js';
import { startGrooveServer } from '../server/app.js';

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SERVER_ENTRY = fileURLToPath(new URL('../server.js', import.meta.url));
export const RESTORE_ENTRY = fileURLToPath(new URL('../server/restore.js', import.meta.url));
export const LOGIN = 'usuario@example.org';
export const OTHER_LOGIN = 'outra-pessoa@example.org';
export const PUBLIC_ORIGIN = 'https://groove.exemplo.ts.net';
export const PUBLIC_HOST = 'groove.exemplo.ts.net';

export async function tempDir(t, prefix = 'gg-server-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export function tailscaleEnv(extra = {}) {
  return { GROOVE_AUTH: 'tailscale', GROOVE_ALLOWED_LOGINS: LOGIN, GROOVE_PUBLIC_ORIGIN: PUBLIC_ORIGIN, ...extra };
}

export async function startServer(t, { env = {}, dataDir = null, now, backups = false, convertMap } = {}) {
  const base = { PORT: '0', ...env };
  if (dataDir) base.GROOVE_DATA_DIR = dataDir;
  const config = loadConfig(base, { projectRoot: PROJECT_ROOT });
  const logs = [];
  const running = await startGrooveServer(config, { now, backups, convertMap, log: (line) => logs.push(line) });
  t.after(() => running.close());
  const mode = config.api?.mode ?? 'static';
  return { ...running, config, logs, client: createClient(running.port, mode) };
}

export function send(port, { method = 'GET', path = '/', headers = {}, rawHeaders = null, body = null, chunks = null } = {}) {
  return new Promise((resolve, reject) => {
    const options = { host: '127.0.0.1', port, method, path, agent: false };
    if (rawHeaders) options.headers = rawHeaders;
    else options.headers = headers;
    let answered = false;
    const request = httpRequest(options, (response) => {
      answered = true;
      const parts = [];
      response.on('data', (chunk) => parts.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(parts);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: buffer,
          text: () => buffer.toString('utf8'),
          json: () => JSON.parse(buffer.toString('utf8')),
        });
      });
      response.on('error', reject);
    });
    // Servidor que responde 413 no meio do upload fecha a conexão: o erro de
    // escrita depois da resposta não é falha do teste.
    request.on('error', (error) => { if (!answered) reject(error); });
    if (chunks) {
      (async () => {
        for (const chunk of chunks) {
          if (answered || request.destroyed) return;
          if (!request.write(chunk)) {
            await new Promise((ok) => {
              const done = () => { request.off('drain', done); request.off('close', done); ok(); };
              request.on('drain', done);
              request.on('close', done);
            });
          }
        }
        request.end();
      })().catch(() => {});
    } else {
      request.end(body ?? undefined);
    }
  });
}

// Cliente "do app": Host/Origin corretos para o modo e identidade fictícia boa.
export function createClient(port, mode) {
  const host = mode === 'tailscale' ? PUBLIC_HOST : `127.0.0.1:${port}`;
  const origin = mode === 'tailscale' ? PUBLIC_ORIGIN : `http://127.0.0.1:${port}`;
  const identity = mode === 'tailscale' ? { 'Tailscale-User-Login': LOGIN } : {};
  const call = (method, path, { headers = {}, body = null, json, chunks } = {}) => {
    const write = !['GET', 'HEAD'].includes(method);
    const finalHeaders = { Host: host, ...identity, ...(write ? { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } : {}), ...headers };
    let payload = body;
    if (json !== undefined) {
      payload = Buffer.from(JSON.stringify(json));
      finalHeaders['Content-Type'] ??= 'application/json';
    }
    for (const [key, value] of Object.entries(finalHeaders)) if (value === null) delete finalHeaders[key];
    return send(port, { method, path, headers: finalHeaders, body: payload, chunks });
  };
  return {
    port,
    host,
    origin,
    get: (path, options) => call('GET', path, options),
    head: (path, options) => call('HEAD', path, options),
    put: (path, options) => call('PUT', path, options),
    post: (path, options) => call('POST', path, options),
    del: (path, options) => call('DELETE', path, options),
    create: (collection, id, json) => call('PUT', `/api/docs/${collection}/${id}`, { json, headers: { 'If-None-Match': '*' } }),
    update: (collection, id, rev, json) => call('PUT', `/api/docs/${collection}/${id}`, { json, headers: { 'If-Match': `"${rev}"` } }),
  };
}

// Processo separado (para SIGKILL, recusa de subida e lock entre processos).
export function spawnServer(env) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { PATH: process.env.PATH, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /GrooveGoblin: http:\/\/127\.0\.0\.1:(\d+)\//.exec(stdout);
      if (match) resolve(Number(match[1]));
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => reject(Object.assign(new Error(`servidor saiu (${code}): ${stderr}`), { code, stderr })));
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, ready, exited, output: () => ({ stdout, stderr }) };
}

export function runToExit(args, env, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`processo não terminou: ${stdout} ${stderr}`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Arquivos de backup agora são NDJSON gzip (um registro JSON por linha).
export function ndjsonRecords(buffer) {
  return gunzipSync(buffer)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export function gzipRecords(records) {
  return gzipSync(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

// Monta uma visão navegável do arquivo para as asserções dos testes.
export function readArchiveBuffer(buffer) {
  const records = ndjsonRecords(buffer);
  const collections = {};
  const privateFiles = {};
  const blobs = new Map();
  let header = null;
  let footer = null;
  let active = null;
  for (const record of records) {
    if (record.type === 'header') header = record;
    else if (record.type === 'doc') (collections[record.collection] ??= []).push(record);
    else if (record.type === 'private') privateFiles[record.name] = record;
    else if (record.type === 'blob-start') active = { sha256: record.sha256, size: record.size, chunks: [], bytes: Buffer.alloc(0) };
    else if (record.type === 'blob-chunk') {
      const bytes = Buffer.from(record.data, 'base64');
      active.chunks.push(bytes);
      active.bytes = Buffer.concat([active.bytes, bytes]);
    } else if (record.type === 'blob-end') {
      blobs.set(active.sha256, active);
      active = null;
    } else if (record.type === 'footer') footer = record;
  }
  return { header, footer, records, collections, private: privateFiles, blobs };
}

// Relógio controlável para backups diários.
export function manualClock(startIso) {
  let current = new Date(startIso).getTime();
  const now = () => new Date(current);
  now.advanceDays = (days) => { current += days * 24 * 60 * 60 * 1000; };
  now.set = (iso) => { current = new Date(iso).getTime(); };
  return now;
}
