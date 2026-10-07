// Leitura estrita do ambiente. Sem GROOVE_DATA_DIR o servidor continua só
// estático (o comportamento de sempre, usado pela regressão e pelo e2e). Com ele
// a API liga, em modo dev (loopback, sem identidade) ou tailscale (identidade
// exata do Serve, só atrás de 127.0.0.1). Qualquer combinação ambígua recusa a
// subida: mensagens nunca citam caminhos, logins nem hosts reais.

import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { INTAKE_LIMITS_FILE, resolveIntakeLimits } from './intake.js';

export const DEFAULT_PORT = 5173;
export const DEFAULT_MAX_BLOB_BYTES = 200 * 1024 * 1024;
export const DEFAULT_MIN_FREE_BYTES = 128 * 1024 * 1024;
export const DEFAULT_BACKUP_KEEP = 14;
const MIB = 1024 * 1024;
const LOOPBACK_HOSTS = { dev: ['127.0.0.1', '::1'], tailscale: ['127.0.0.1'], static: ['127.0.0.1', '::1'] };
const LOGIN_PATTERN = /^[\x21-\x2b\x2d-\x7e]{1,254}$/; // ASCII visível, sem vírgula nem espaço
// Ajustes dos limites da pasta de entrada por curso (bounds em server/intake.js).
export const INTAKE_LIMIT_ENV = Object.freeze({
  maxEntries: 'GROOVE_INTAKE_MAX_ENTRIES',
  maxZipBytes: 'GROOVE_INTAKE_MAX_ZIP_BYTES',
  maxZipPdfMembers: 'GROOVE_INTAKE_MAX_ZIP_PDF_MEMBERS',
  maxZipPdfBytes: 'GROOVE_INTAKE_MAX_ZIP_PDF_BYTES',
  maxCourseBytes: 'GROOVE_INTAKE_MAX_COURSE_BYTES',
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function normalizeBasePath(path) {
  const normalized = `/${String(path).split('/').filter(Boolean).join('/')}/`;
  return normalized === '//' ? '/' : normalized;
}

function readInteger(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,13}$/.test(raw)) throw new ConfigError(`${name} precisa ser um inteiro.`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${name} fora do intervalo permitido (${min}..${max}).`);
  return value;
}

function readPublicOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('GROOVE_PUBLIC_ORIGIN não é uma URL válida.');
  }
  if (url.protocol !== 'https:') throw new ConfigError('GROOVE_PUBLIC_ORIGIN precisa ser https://.');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new ConfigError('GROOVE_PUBLIC_ORIGIN precisa ser só a origem (https://host[:porta]), sem caminho, consulta ou credenciais.');
  }
  if (raw.replace(/\/$/, '') !== url.origin) throw new ConfigError('GROOVE_PUBLIC_ORIGIN precisa estar na forma canônica (minúsculas, sem porta padrão).');
  return { origin: url.origin, host: url.host };
}

function readLogins(raw) {
  const logins = String(raw ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (logins.length === 0) throw new ConfigError('GROOVE_AUTH=tailscale exige GROOVE_ALLOWED_LOGINS com pelo menos um login.');
  for (const login of logins) {
    if (!LOGIN_PATTERN.test(login)) throw new ConfigError('GROOVE_ALLOWED_LOGINS contém um login com caracteres inválidos.');
  }
  return [...new Set(logins)];
}

// Devolve a configuração completa ou lança ConfigError.
export function loadConfig(env, { projectRoot }) {
  const port = readInteger(env, 'PORT', DEFAULT_PORT, 0, 65535);
  const staticRoot = resolve(projectRoot, env.STATIC_ROOT || '.');
  const basePath = normalizeBasePath(env.BASE_PATH || '/');
  const host = env.GROOVE_HOST || '127.0.0.1';
  const dataDir = env.GROOVE_DATA_DIR || '';
  const apiOnlyVars = ['GROOVE_AUTH', 'GROOVE_ALLOWED_LOGINS', 'GROOVE_PUBLIC_ORIGIN', 'GROOVE_MAX_BLOB_BYTES', 'GROOVE_MIN_FREE_BYTES', 'GROOVE_BACKUP_KEEP', ...Object.values(INTAKE_LIMIT_ENV)];

  if (!dataDir) {
    const stray = apiOnlyVars.filter((name) => env[name] !== undefined && env[name] !== '');
    if (stray.length > 0) throw new ConfigError(`${stray.join(', ')} só vale com GROOVE_DATA_DIR; sem data dir o servidor é só estático.`);
    if (!LOOPBACK_HOSTS.static.includes(host)) throw new ConfigError('GROOVE_HOST precisa ser loopback (127.0.0.1 ou ::1).');
    return { port, host, staticRoot, basePath, projectRoot, api: null };
  }

  if (!isAbsolute(dataDir)) throw new ConfigError('GROOVE_DATA_DIR precisa ser um caminho absoluto.');
  const mode = env.GROOVE_AUTH || 'dev';
  if (mode !== 'dev' && mode !== 'tailscale') throw new ConfigError('GROOVE_AUTH precisa ser dev ou tailscale.');
  if (!LOOPBACK_HOSTS[mode].includes(host)) {
    throw new ConfigError(mode === 'tailscale'
      ? 'No modo tailscale o servidor só escuta em 127.0.0.1: o cabeçalho de identidade só é confiável atrás do Serve local.'
      : 'No modo dev o servidor só escuta em loopback (127.0.0.1 ou ::1).');
  }
  let allowedLogins = [];
  let publicOrigin = null;
  if (mode === 'tailscale') {
    allowedLogins = readLogins(env.GROOVE_ALLOWED_LOGINS);
    if (!env.GROOVE_PUBLIC_ORIGIN) throw new ConfigError('GROOVE_AUTH=tailscale exige GROOVE_PUBLIC_ORIGIN (https://…).');
    publicOrigin = readPublicOrigin(env.GROOVE_PUBLIC_ORIGIN);
  } else {
    if (env.GROOVE_ALLOWED_LOGINS) throw new ConfigError('GROOVE_ALLOWED_LOGINS só vale com GROOVE_AUTH=tailscale.');
    if (env.GROOVE_PUBLIC_ORIGIN) throw new ConfigError('GROOVE_PUBLIC_ORIGIN só vale com GROOVE_AUTH=tailscale.');
  }
  // Só o que veio do ambiente; padrões, `<dataDir>/intake-limits.json` e os
  // intervalos de cada chave são aplicados na subida (server/app.js).
  const intakeLimits = {};
  for (const [key, name] of Object.entries(INTAKE_LIMIT_ENV)) {
    const value = readInteger(env, name, null, 1, Number.MAX_SAFE_INTEGER);
    if (value !== null) intakeLimits[key] = value;
  }
  try {
    resolveIntakeLimits(intakeLimits);
  } catch (error) {
    throw new ConfigError(error.message.replace(/^max\w+/, (key) => INTAKE_LIMIT_ENV[key] ?? key));
  }
  return {
    port,
    host,
    staticRoot,
    basePath,
    projectRoot,
    api: {
      dataDir: resolve(dataDir),
      mode,
      allowedLogins,
      publicOrigin,
      maxBlobBytes: readInteger(env, 'GROOVE_MAX_BLOB_BYTES', DEFAULT_MAX_BLOB_BYTES, MIB, 4096 * MIB),
      minFreeBytes: readInteger(env, 'GROOVE_MIN_FREE_BYTES', DEFAULT_MIN_FREE_BYTES, 0, 1024 * 1024 * MIB),
      backupKeep: readInteger(env, 'GROOVE_BACKUP_KEEP', DEFAULT_BACKUP_KEEP, 1, 60),
      intakeLimits,
    },
  };
}

// Limites efetivos da pasta de entrada: padrões < `<dataDir>/intake-limits.json`
// < ambiente. O arquivo é opcional, lido uma vez na subida, nunca link
// simbólico; JSON ilegível, chave desconhecida ou valor fora do intervalo
// recusam a subida sem citar caminho.
export async function loadIntakeLimits(dataDir, envOverrides = {}) {
  const path = join(dataDir, INTAKE_LIMITS_FILE);
  let fromFile = {};
  let info = null;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new ConfigError(`${INTAKE_LIMITS_FILE} não pôde ser lido.`);
  }
  if (info) {
    if (!info.isFile() || info.size > 4096) throw new ConfigError(`${INTAKE_LIMITS_FILE} precisa ser um arquivo comum pequeno (sem link simbólico).`);
    try {
      fromFile = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new ConfigError(`${INTAKE_LIMITS_FILE} não é um JSON válido.`);
    }
  }
  try {
    resolveIntakeLimits(fromFile);
  } catch (error) {
    throw new ConfigError(`${INTAKE_LIMITS_FILE}: ${error.message}`);
  }
  // O ambiente já foi conferido em loadConfig; a soma só troca valores válidos.
  return resolveIntakeLimits({ ...fromFile, ...envOverrides });
}
