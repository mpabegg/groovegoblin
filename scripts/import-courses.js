#!/usr/bin/env node
// Importação de cursos no Pi, disparada do laptop.
//
//   node scripts/import-courses.js --manifest local/course-import.json          # plano, sem escrita
//   node scripts/import-courses.js --manifest local/course-import.json --apply  # importa
//
// O laptop lê o manifesto PRIVADO (fora do repositório), converte cada mapa com
// o conversor deste checkout só para calcular ids, contagens e digests, e manda
// para o Pi, pelo stdin de `ssh … sudo -n -- <node> --input-type=module -`, o
// texto de `scripts/course-import-worker.js` + o pacote (mapa, catálogo e
// manifesto resolvido). Quem escreve é o trabalhador remoto, sempre pela API do
// serviço em loopback (instantâneo, conversão com CAS, scan) — exceto a cópia
// plana dos arquivos para `entrada/<curso>/`, que é feita como root com o dono
// do serviço.
//
// Saída: um log bruto (stdout/stderr do ssh e do trabalhador, inclusive falha de
// ssh) e um resultado JSON, os dois só em arquivo 0600 na pasta privada. O
// terminal mostra apenas contagens e números de ordem — nunca host, caminho,
// login, id ou nome de arquivo.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { convertCourseMap } from './convert-course-map.js';
import { serializeCourse } from '../src/course-format.js';
import { AUDIO_EXTENSIONS, PDF_EXTENSIONS, ZIP_EXTENSIONS } from '../server/matching.js';
import * as intakeModule from '../server/intake.js';
import * as configModule from '../server/config.js';
import { WORKER_FORMAT, courseDocumentStats, parseEnvText, sha256Hex } from './course-import-worker.js';

export const MANIFEST_FORMAT = 'groovegoblin-course-import-manifest/1';
export const RESULT_FORMAT = 'groovegoblin-course-import-result/1';
export const DEFAULT_ENV_FILE = '/etc/groovegoblin/groove.env';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_PATH = join(PROJECT_ROOT, 'scripts', 'course-import-worker.js');
const DEFAULT_MANIFEST = join(PROJECT_ROOT, 'local', 'course-import.json');
const DEFAULT_OUTPUT_DIR = join(PROJECT_ROOT, 'local', 'private');

export class ImportConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportConfigError';
  }
}

// Campos remotos e de onde cada um pode vir. Prioridade: `remote` do manifesto
// > resultado do deploy > deploy.env. Duas fontes com valores diferentes (sem
// o manifesto decidir) é erro: melhor parar do que escolher um Pi errado.
const DEPLOY_ENV_KEYS = Object.freeze({
  SSH_TARGET: 'sshTarget',
  SSH_HOST_KEY_ALIAS: 'sshHostKeyAlias',
  NODE_BIN: 'nodeBin',
  ENV_FILE: 'envFile',
  APP_DIR: 'appDir',
  DATA_DIR: 'dataDir',
  SERVICE_USER: 'serviceUser',
  SERVICE_HOST: 'serviceHost',
  SERVICE_PORT: 'servicePort',
  MATERIAL_DIR: 'materialRoot',
});
const DEPLOYMENT_RESULT_KEYS = Object.freeze({
  nodeBin: 'nodeBin',
  envFile: 'envFile',
  appDir: 'appDir',
  dataDir: 'dataDir',
  serviceUser: 'serviceUser',
  appPort: 'servicePort',
  materialDir: 'materialRoot',
});
const REMOTE_FIELDS = Object.freeze(['sshTarget', 'sshHostKeyAlias', 'nodeBin', 'envFile', 'appDir', 'dataDir', 'serviceUser', 'serviceHost', 'servicePort', 'materialRoot']);
const ABSOLUTE_FIELDS = Object.freeze(['nodeBin', 'envFile', 'appDir', 'dataDir', 'materialRoot']);
const SAFE_PATH = /^\/[^\u0000-\u001f\u007f]*$/;

function pick(source, keys) {
  const values = {};
  for (const [from, to] of Object.entries(keys)) {
    const value = source?.[from];
    if (value !== undefined && value !== null && String(value).trim() !== '') values[to] = String(value).trim();
  }
  return values;
}

// Junta as fontes e valida. Mensagens citam só o NOME do campo, nunca o valor.
export function resolveRemoteConfig({ manifestRemote = {}, deploymentResult = null, deployEnv = null }) {
  const fromResult = pick(deploymentResult, DEPLOYMENT_RESULT_KEYS);
  const fromEnv = pick(deployEnv, DEPLOY_ENV_KEYS);
  const fromManifest = pick(manifestRemote, Object.fromEntries(REMOTE_FIELDS.map((field) => [field, field])));
  for (const key of Object.keys(manifestRemote ?? {})) {
    if (!REMOTE_FIELDS.includes(key)) throw new ImportConfigError(`Campo desconhecido em remote: ${key}.`);
  }
  const remote = {};
  for (const field of REMOTE_FIELDS) {
    if (fromManifest[field] !== undefined) { remote[field] = fromManifest[field]; continue; }
    const a = fromResult[field];
    const b = fromEnv[field];
    if (a !== undefined && b !== undefined && a !== b) {
      throw new ImportConfigError(`O resultado do deploy e o deploy.env discordam em ${field}; decida em remote.${field} no manifesto.`);
    }
    if (a !== undefined || b !== undefined) remote[field] = a ?? b;
  }
  remote.envFile ??= DEFAULT_ENV_FILE;
  if (!remote.sshTarget) throw new ImportConfigError('Falta o destino ssh (remote.sshTarget ou SSH_TARGET no deploy.env).');
  if (!/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._:-]+$/.test(remote.sshTarget) || remote.sshTarget.startsWith('-')) throw new ImportConfigError('Destino ssh com caracteres não aceitos.');
  if (remote.sshHostKeyAlias !== undefined && !/^[A-Za-z0-9._:-]+$/.test(remote.sshHostKeyAlias)) throw new ImportConfigError('Apelido de chave do host com caracteres não aceitos.');
  if (!remote.nodeBin) throw new ImportConfigError('Falta o caminho do node no Pi (remote.nodeBin ou NODE_BIN).');
  if (!remote.serviceUser) throw new ImportConfigError('Falta o usuário do serviço (remote.serviceUser ou SERVICE_USER).');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(remote.serviceUser)) throw new ImportConfigError('Usuário do serviço com caracteres não aceitos.');
  for (const field of ABSOLUTE_FIELDS) {
    if (remote[field] !== undefined && (!isAbsolute(remote[field]) || !SAFE_PATH.test(remote[field]))) throw new ImportConfigError(`${field} precisa ser um caminho absoluto sem caractere de controle.`);
  }
  if (remote.servicePort !== undefined) {
    if (!/^[1-9]\d{0,4}$/.test(remote.servicePort) || Number(remote.servicePort) > 65535) throw new ImportConfigError('servicePort inválida.');
    remote.servicePort = Number(remote.servicePort);
  }
  return remote;
}

// Arquivo privado: nada de leitura por grupo/outros (o manifesto e o deploy.env
// citam host e caminhos do Pi).
async function readPrivateText(path, label) {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new ImportConfigError(`Não consegui ler ${label}.`);
  }
  if (!info.isFile()) throw new ImportConfigError(`${label} não é um arquivo comum.`);
  if ((info.mode & 0o077) !== 0) throw new ImportConfigError(`${label} pode ser lido por outros usuários; rode chmod 600 nele.`);
  return readFile(path, 'utf8');
}

async function readJsonFile(path, label) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ImportConfigError(`Não consegui ler ${label}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportConfigError(`${label} não é JSON válido.`);
  }
}

// Converte localmente só para saber o que o servidor deve guardar: id, contagens
// e o digest do corpo canônico (`JSON.stringify` do documento serializado), com
// e sem progresso — o trabalhador escolhe conforme o que já está no servidor.
export function prepareCourse({ map, catalog, materialFolder, includeProgress = null, courseId = null }, ordinal) {
  const label = `curso ${ordinal}`;
  if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new ImportConfigError(`${label}: o mapa precisa ser um objeto JSON.`);
  if (catalog !== null && !Array.isArray(catalog)) throw new ImportConfigError(`${label}: o catálogo precisa ser uma lista JSON (ou null).`);
  if (includeProgress !== null && typeof includeProgress !== 'boolean') throw new ImportConfigError(`${label}: includeProgress precisa ser true, false ou null.`);
  if (typeof materialFolder !== 'string' || materialFolder.trim() === '' || /[\u0000-\u001f\u007f]/.test(materialFolder)) throw new ImportConfigError(`${label}: materialFolder ausente ou inválida.`);
  const variants = {};
  for (const withProgress of [false, true]) {
    const converted = convertCourseMap(map, catalog === null ? { includeProgress: withProgress } : { includeProgress: withProgress, catalog });
    const serialized = converted.valid ? serializeCourse(converted.document) : null;
    if (!serialized?.ok) throw new ImportConfigError(`${label}: o conversor deste checkout não gerou um curso válido (${(converted.problems ?? serialized?.errors ?? []).length} problema(s)).`);
    variants[withProgress ? 'withProgress' : 'withoutProgress'] = { document: serialized.document, counts: converted.counts, warnings: converted.warnings.length };
  }
  const id = variants.withoutProgress.document.course?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new ImportConfigError(`${label}: o curso convertido não tem um id aceito pelo servidor.`);
  if (courseId !== null && courseId !== id) throw new ImportConfigError(`${label}: o courseId do manifesto não é o id que o mapa gera.`);
  return {
    courseId: id,
    materialFolder,
    includeProgress,
    map,
    catalog,
    expected: {
      courseDigest: sha256Hex(JSON.stringify(variants.withoutProgress.document)),
      courseDigestWithProgress: sha256Hex(JSON.stringify(variants.withProgress.document)),
      mapDigest: sha256Hex(JSON.stringify(map)),
      catalogDigest: catalog === null ? null : sha256Hex(JSON.stringify(catalog)),
    },
    // O trabalhador une o progresso que o servidor já tem a estes documentos
    // para saber o que deve ficar guardado (não vão para o resultado).
    expectedDocuments: { withProgress: variants.withProgress.document, withoutProgress: variants.withoutProgress.document },
    local: {
      counts: variants.withoutProgress.counts,
      warnings: variants.withoutProgress.warnings,
      stats: courseDocumentStats(variants.withoutProgress.document),
      statsWithProgress: courseDocumentStats(variants.withProgress.document),
    },
  };
}

// Limites padrão + nomes das variáveis de ambiente, lidos do próprio servidor
// deste checkout (o trabalhador aplica arquivo/ambiente do Pi por cima).
export function intakeLimitSources() {
  return {
    limits: { ...intakeModule.INTAKE_LIMITS },
    limitsFile: intakeModule.INTAKE_LIMITS_FILE ?? null,
    limitEnv: { ...(configModule.INTAKE_LIMIT_ENV ?? {}) },
  };
}

export function buildPayload({ runId, mode, remote, courses, options = {} }) {
  const { limits, limitsFile, limitEnv } = intakeLimitSources();
  return {
    format: WORKER_FORMAT,
    runId,
    mode,
    remote: {
      envFile: remote.envFile,
      dataDir: remote.dataDir ?? null,
      serviceUser: remote.serviceUser,
      serviceHost: remote.serviceHost ?? null,
      servicePort: remote.servicePort ?? null,
      materialRoot: remote.materialRoot ?? null,
      appDir: remote.appDir ?? null,
    },
    limits,
    limitsFile,
    limitEnv,
    options: { invalidNames: options.invalidNames ?? 'fail' },
    extensions: { pdf: [...PDF_EXTENSIONS], audio: [...AUDIO_EXTENSIONS], zip: [...ZIP_EXTENSIONS] },
    courses: courses.map(({ courseId, materialFolder, includeProgress, map, catalog, expected, expectedDocuments }) => ({ courseId, materialFolder, includeProgress, map, catalog, expected, expectedDocuments })),
  };
}

// Texto que vai pelo stdin: o módulo do trabalhador + a chamada com o pacote
// como literal de string JSON (sem interpolar nada como código).
export async function buildRemoteProgram(payload, { workerSource = null } = {}) {
  const source = workerSource ?? await readFile(WORKER_PATH, 'utf8');
  return `${source}\nprocess.exitCode = await runWorkerMain(JSON.parse(${JSON.stringify(JSON.stringify(payload))}));\n`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildSshArgs(remote) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8'];
  if (remote.sshHostKeyAlias) args.push('-o', `HostKeyAlias=${remote.sshHostKeyAlias}`);
  args.push('--', remote.sshTarget, `sudo -n -- ${shellQuote(remote.nodeBin)} --input-type=module -`);
  return args;
}

function makeRunId(now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

// A pasta de saída nunca pode cair num lugar versionado do checkout.
export function checkOutputDir(dir) {
  const rel = relative(PROJECT_ROOT, dir);
  const insideRepo = rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  if (insideRepo && !(rel === 'local' || rel.startsWith(`local${sep}`))) throw new ImportConfigError('A pasta de saída fica dentro do checkout fora de local/; escolha uma pasta privada.');
  return dir;
}

async function openPrivateFile(path) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  await chmod(path, 0o600);
  return handle;
}

async function writePrivateJson(path, value) {
  const handle = await openPrivateFile(path);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

function localCommit() {
  try {
    return execFileSync('git', ['-C', PROJECT_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Lê manifesto + fontes de configuração e prepara os cursos. Sem rede.
export async function loadManifest(manifestPath) {
  const manifestText = await readPrivateText(manifestPath, 'o manifesto');
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new ImportConfigError('O manifesto não é JSON válido.');
  }
  if (manifest?.format !== MANIFEST_FORMAT) throw new ImportConfigError(`O manifesto precisa de "format": "${MANIFEST_FORMAT}".`);
  const base = dirname(manifestPath);
  const at = (path) => resolve(base, path);
  const deployEnv = manifest.deployEnv ? parseEnvText(await readPrivateText(at(manifest.deployEnv), 'o deploy.env')) : null;
  let deploymentResult = null;
  if (manifest.deploymentResult) {
    const text = await readPrivateText(at(manifest.deploymentResult), 'o resultado do deploy');
    try {
      deploymentResult = JSON.parse(text);
    } catch {
      throw new ImportConfigError('O resultado do deploy não é JSON válido.');
    }
  }
  const remote = resolveRemoteConfig({ manifestRemote: manifest.remote ?? {}, deploymentResult, deployEnv });
  const invalidNames = manifest.invalidNames ?? 'fail';
  if (invalidNames !== 'fail' && invalidNames !== 'skip') throw new ImportConfigError('invalidNames precisa ser "fail" ou "skip".');
  if (!Array.isArray(manifest.courses) || manifest.courses.length === 0) throw new ImportConfigError('O manifesto não lista nenhum curso.');
  const courses = [];
  const seen = new Set();
  for (const [index, entry] of manifest.courses.entries()) {
    const ordinal = index + 1;
    if (typeof entry?.map !== 'string') throw new ImportConfigError(`curso ${ordinal}: falta o caminho do mapa.`);
    if (!Object.hasOwn(entry, 'catalog') || (entry.catalog !== null && typeof entry.catalog !== 'string')) throw new ImportConfigError(`curso ${ordinal}: informe "catalog" (caminho ou null, explícito).`);
    const map = await readJsonFile(at(entry.map), `o mapa do curso ${ordinal}`);
    const catalog = entry.catalog === null ? null : await readJsonFile(at(entry.catalog), `o catálogo do curso ${ordinal}`);
    const prepared = prepareCourse({ map, catalog, materialFolder: entry.materialFolder, includeProgress: entry.includeProgress ?? null, courseId: entry.courseId ?? null }, ordinal);
    if (seen.has(prepared.courseId)) throw new ImportConfigError(`curso ${ordinal}: o mesmo curso aparece duas vezes no manifesto.`);
    seen.add(prepared.courseId);
    if (!isAbsolute(prepared.materialFolder) && !remote.materialRoot) throw new ImportConfigError(`curso ${ordinal}: materialFolder relativa precisa de remote.materialRoot (ou MATERIAL_DIR).`);
    // A conferência completa (dados, pastas geridas, links) é feita no Pi; aqui só
    // o que dá para saber sem conectar: nunca fora da raiz de material.
    if (remote.materialRoot) {
      const rel = posix.relative(remote.materialRoot, posix.resolve(remote.materialRoot, prepared.materialFolder));
      if (rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) throw new ImportConfigError(`curso ${ordinal}: materialFolder fica fora de remote.materialRoot.`);
    }
    courses.push(prepared);
  }
  const outputDir = checkOutputDir(manifest.outputDir ? at(manifest.outputDir) : DEFAULT_OUTPUT_DIR);
  return { manifest, remote, courses, outputDir, options: { invalidNames }, manifestDigest: sha256Hex(manifestText) };
}

// ── terminal: só contagens ────────────────────────────────────────────────

const STEP_LABELS = { 'scan-source': 'lendo a pasta de material', backup: 'instantâneo de segurança (e cópia independente)', convert: 'conversão', copy: 'cópia para a pasta de entrada', scan: 'scan e vínculos', 'course-done': 'curso concluído' };

export function progressLine(event, total) {
  const label = STEP_LABELS[event.step] ?? 'etapa';
  const prefix = event.course ? `curso ${event.course}/${total}: ` : '';
  const extra = [];
  if (Number.isInteger(event.copied)) extra.push(`${event.copied}/${event.planned} copiados`);
  else if (Number.isInteger(event.planned)) extra.push(`${event.planned} a copiar`);
  if (Number.isInteger(event.available) && Number.isInteger(event.total)) extra.push(`${event.available}/${event.total} materiais`);
  return `… ${prefix}${label}${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

function count(value) {
  return Number.isFinite(value) ? String(value) : '?';
}

export function summaryLines(result) {
  const lines = [];
  const remote = result.remote;
  const total = result.local?.courses?.length ?? 0;
  if (!remote) return lines;
  if (remote.backup) lines.push(`instantâneo de segurança: criado (${count(remote.backup.size)} bytes) · cópia independente: ${remote.backup.archive ? `guardada (${count(remote.backup.archive.size)} bytes)` : 'NÃO guardada'}`);
  else if (remote.mode === 'apply') lines.push('instantâneo de segurança: não criado');
  if (remote.server) lines.push(`checkout do Pi igual ao local: ${result.local?.commit && remote.server.appCommit ? (remote.server.appCommit === result.local.commit ? 'sim' : 'não') : 'desconhecido'}`);
  const limits = remote.limits?.effective;
  if (limits) {
    const adjusted = Object.keys(remote.limits.sources ?? {}).length;
    lines.push(`limites da pasta de entrada no Pi: ${count(limits.maxEntries)} arquivos · ZIP até ${count(Math.floor(limits.maxZipBytes / 1048576))} MiB · ${count(limits.maxZipPdfMembers)} PDFs de ZIP · ${adjusted} ajuste(s) além do padrão`);
  }
  if (remote.error?.code === 'source_refused') {
    for (const problem of remote.error.problems ?? []) {
      const index = (remote.courses ?? []).findIndex((course) => course.courseId === problem.courseId);
      lines.push(`curso ${index + 1}/${total}: ${problem.code === 'invalid_names' ? 'nomes que a pasta de entrada não aceita' : 'pastas fundas demais'}: ${count(problem.paths?.length)} (lista no resultado)`);
    }
  }
  if (remote.error?.code === 'material_path_refused') lines.push(`pasta de material recusada (${remote.error.reason ?? '?'})`);
  for (const [index, course] of (remote.courses ?? []).entries()) {
    const n = `curso ${index + 1}/${total}`;
    const source = course.source ?? {};
    const stats = course.after?.course?.stats ?? course.before?.course?.stats ?? result.local?.courses?.[index]?.stats ?? {};
    const report = course.after?.report ?? course.before?.report ?? null;
    const conversion = course.conversion?.status ?? `prevista ${course.conversion?.planned ?? '?'}`;
    lines.push(`${n}: conversão ${conversion} · seções ${count(stats.sections)} · aulas ${count(stats.lessons)} · exercícios ${count(stats.exercises)} (com receita ${count(stats.recipeExercises)})`);
    const progress = course.progress;
    if (progress && progress.before !== null) lines.push(`${n}: aulas assistidas no servidor ${count(progress.before)} → mantidas ${count(progress.kept)} · do mapa ${count(progress.fromMap)} · descartadas (aula não existe mais) ${count(progress.dropped?.length)}${course.after?.course?.watchedLost ? ` · PERDIDAS ${count(course.after.course.watchedLost)}` : ''}`);
    lines.push(`${n}: arquivos de origem ${count(source.files)} (copiáveis ${count(source.accepted)}, fora dos formatos do app ${count(source.unsupported)}, duplicados iguais ${count(source.duplicatesCollapsed)}, colisões de nome ${count(source.collisions?.length)})`);
    lines.push(`${n}: não copiados — links ${count(source.skipped?.symlinks)} · especiais ${count(source.skipped?.special)} · nome inválido ${count(source.skipped?.invalidName)} · fundos demais ${count(source.skipped?.tooDeep)}`);
    if (course.copy) lines.push(`${n}: copiados ${count(course.copy.copied)} · já presentes ${count(source.present)} · trocados por cópia nova: link físico ${count(course.copy.repaired?.hardlinks)}, dono/modo ${count(course.copy.repaired?.ownerMode)} · originais alterados ${count(course.copy.originalsChanged)}`);
    else lines.push(`${n}: a copiar ${count(source.planned)} · já presentes ${count(source.present)} · a trocar por cópia nova: link físico ${count(source.repairs?.hardlinks)}, dono/modo ${count(source.repairs?.ownerMode)} · ZIP acima do limite ${count(source.limits?.zipTooLarge?.length)} · bloqueios ${count(source.limits?.blockers?.length)}`);
    if (source.intakeOthers && (source.intakeOthers.hardlinks > 0 || source.intakeOthers.ownerMode > 0)) lines.push(`${n}: outros arquivos da pasta de entrada (não tocados): link físico ${count(source.intakeOthers.hardlinks)} · dono/modo diferente ${count(source.intakeOthers.ownerMode)}`);
    if (report) lines.push(`${n}: materiais ${count(report.available)}/${count(report.total)} disponíveis · faltando ${count(report.missing)} · não casados ${count(report.unmatched)}${course.after ? '' : ' (antes da importação)'}`);
    if (course.scan) lines.push(`${n}: vínculos anteriores repostos ${count(course.scan.restored?.length)} · estado do curso intacto: ${course.after?.courseStates?.unchanged ? 'sim' : 'NÃO'}`);
    if (course.after?.course && course.after.course.matchesExpected === false) lines.push(`${n}: atenção — o documento no servidor não é o que este checkout gera (checkout do Pi diferente?)`);
  }
  return lines;
}

// ── execução ─────────────────────────────────────────────────────────────────

// `spawnImpl`/`print`/`now` existem para os testes; o resto é o caminho real.
export async function runImport({ manifestPath = DEFAULT_MANIFEST, mode = 'plan', spawnImpl = spawn, print = (line) => console.log(line), now = () => new Date(), workerSource = null } = {}) {
  let loaded;
  try {
    loaded = await loadManifest(resolve(manifestPath));
  } catch (error) {
    if (error instanceof ImportConfigError) {
      print(`Configuração recusada: ${error.message}`);
      return { exitCode: 2, resultPath: null, logPath: null, result: null };
    }
    throw error;
  }
  const { remote, courses, outputDir, options } = loaded;
  const runId = makeRunId(now());
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const logPath = join(outputDir, `course-import-${runId}.log`);
  const resultPath = join(outputDir, `course-import-${runId}.json`);
  const payload = buildPayload({ runId, mode, remote, courses, options });
  const program = await buildRemoteProgram(payload, { workerSource });
  const result = {
    format: RESULT_FORMAT,
    runId,
    mode,
    startedAt: now().toISOString(),
    finishedAt: null,
    ok: false,
    local: {
      commit: localCommit(),
      manifestDigest: loaded.manifestDigest,
      programDigest: sha256Hex(program),
      remote,
      courses: courses.map((course) => ({ courseId: course.courseId, materialFolder: course.materialFolder, includeProgress: course.includeProgress, expected: course.expected, ...course.local })),
    },
    ssh: null,
    remote: null,
    error: null,
  };

  const log = await openPrivateFile(logPath);
  // Escritas em fila: eventos chegam de vários fluxos e a ordem do log importa.
  let queue = Promise.resolve();
  const write = (prefix, text) => {
    queue = queue.then(() => log.write(`${new Date().toISOString()} ${prefix} ${text}\n`)).catch(() => {});
    return queue;
  };
  print(`${mode === 'apply' ? 'Importação' : 'Plano (nada é alterado)'}: ${courses.length} curso(s); log e resultado só em arquivos privados.`);
  try {
    await write('[local]', JSON.stringify({ runId, mode, courses: courses.length, commit: result.local.commit, programBytes: program.length }));
    const outcome = await new Promise((resolveOutcome) => {
      let child;
      try {
        child = spawnImpl('ssh', buildSshArgs(remote), { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        resolveOutcome({ code: null, signal: null, spawnError: error?.code ?? 'spawn_failed' });
        return;
      }
      let pending = '';
      let finished = false;
      const handleLine = (line) => {
        if (line === '') return;
        write('[out]', line);
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event?.t === 'progress') print(progressLine(event, courses.length));
        else if (event?.t === 'result') result.remote = event.result;
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        pending += chunk;
        let index;
        while ((index = pending.indexOf('\n')) >= 0) {
          handleLine(pending.slice(0, index));
          pending = pending.slice(index + 1);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { for (const line of chunk.split('\n')) if (line !== '') write('[err]', line); });
      child.stdin.on('error', (error) => write('[local]', `stdin: ${error.code ?? error.message}`));
      child.on('error', (error) => {
        if (finished) return;
        finished = true;
        resolveOutcome({ code: null, signal: null, spawnError: error?.code ?? 'spawn_failed' });
      });
      child.on('close', (code, signal) => {
        if (finished) return;
        finished = true;
        if (pending !== '') handleLine(pending);
        resolveOutcome({ code, signal, spawnError: null });
      });
      child.stdin.end(program);
    });
    result.ssh = { exitCode: outcome.code, signal: outcome.signal, spawnError: outcome.spawnError };
    await write('[local]', `ssh terminou: ${JSON.stringify(result.ssh)}`);
    if (!result.remote) {
      result.error = { code: outcome.spawnError ? 'ssh_unavailable' : outcome.code === 255 ? 'ssh_failed' : 'remote_failed', exitCode: outcome.code, signal: outcome.signal };
    } else if (!result.remote.ok) {
      result.error = result.remote.error;
    }
    result.ok = Boolean(result.remote?.ok) && outcome.code === 0;
  } finally {
    result.finishedAt = now().toISOString();
    await queue;
    await log.close();
    await writePrivateJson(resultPath, result);
  }

  for (const line of summaryLines(result)) print(line);
  if (result.ok) print(mode === 'apply' ? 'Importação concluída.' : 'Plano pronto; rode de novo com --apply para importar.');
  else if (!result.remote) print(`Falha antes do resultado remoto (${result.error.code}, código ${result.ssh?.exitCode ?? 'n/d'}); detalhes só no log privado.`);
  else print(`Falha no Pi na etapa ${result.remote.error?.step ?? '?'} (${result.remote.error?.code ?? '?'}); ${result.remote.mutated ? `houve escrita antes da falha (o instantâneo foi feito antes${result.remote.backup?.archive ? ', com cópia independente em import-backups/' : ''})` : 'nada foi alterado'}.`);
  print(`Resultado: ${resultPath}`);
  print(`Log: ${logPath}`);
  return { exitCode: result.ok ? 0 : 1, resultPath, logPath, result };
}

const USAGE = [
  'Uso: node scripts/import-courses.js [--manifest CAMINHO] [--apply]',
  '',
  '  --manifest CAMINHO  manifesto privado (padrão: local/course-import.json)',
  '  --apply             importa de verdade; sem ele só roda a pré-checagem (plano)',
  '  --help              esta ajuda',
].join('\n');

export function parseArgs(argv) {
  const args = { manifestPath: DEFAULT_MANIFEST, mode: 'plan', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.mode = 'apply';
    else if (arg === '--plan') args.mode = 'plan';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--manifest') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) return { error: 'A opção --manifest precisa de um caminho.' };
      args.manifestPath = next;
      index += 1;
    } else if (arg.startsWith('--manifest=')) args.manifestPath = arg.slice('--manifest='.length);
    else return { error: `Opção desconhecida: ${arg}` };
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const { exitCode } = await runImport({ manifestPath: args.manifestPath, mode: args.mode });
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Sem mensagem crua: erros do node citam caminhos absolutos.
    console.error(`Erro inesperado (${error?.code ?? error?.name ?? 'desconhecido'}).`);
    process.exitCode = 1;
  });
}
