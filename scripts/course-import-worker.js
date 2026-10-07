// Trabalhador remoto da importação de cursos (roda NO Pi, como root).
//
// O laptop (`scripts/import-courses.js`) manda ESTE arquivo inteiro pelo stdin
// de `ssh <destino> sudo -n -- <node> --input-type=module -`, seguido de uma
// linha que chama `runWorkerMain(payload)`. Por isso este módulo só importa
// `node:*`: no Pi ele não enxerga o checkout, só o próprio texto.
//
// O que ele faz, nesta ordem (modo `apply`):
//   1. pré-checagem SEM escrita nenhuma: ambiente do serviço, health, dono do
//      diretório de dados, pastas de material (confinadas à raiz de material e
//      longe das pastas geridas do diretório de dados, inclusive por link),
//      plano de cópia, limites da pasta de entrada e, por curso, conversão a
//      seco (`dryRun`) no servidor;
//   2. instantâneo normal pela API (POST /api/backups) antes da primeira escrita,
//      copiado para `<dataDir>/import-backups/<rodada>/` (o diário do mesmo dia
//      é substituído por qualquer backup seguinte; a cópia não);
//   3. por curso: conversão com CAS (`expectedRev`) — ou nada, se o documento
//      guardado já é idêntico ao esperado — e, logo depois, as aulas assistidas
//      que o servidor já tinha voltam ao progresso (CAS de novo); cópia plana de
//      TODOS os arquivos comuns para `entrada/<curso>/` (cópia de verdade, nunca
//      link; originais intactos; cópia antiga ligada por link físico ou com
//      dono/modo errado é trocada por cópia nova); POST .../materials/scan;
//      reposição dos vínculos que já existiam antes do scan; relatório
//      GET .../materials.
// No modo `plan` só o passo 1 roda (e o relatório de leitura).
//
// Saída: uma linha JSON por evento no stdout (`{"t":"log"|"progress"|"result"}`).
// Nomes de arquivo, caminhos e ids aparecem aqui — o laptop grava tudo só em
// arquivo privado 0600 e mostra no terminal apenas contagens.

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, statfs, unlink } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

export const WORKER_FORMAT = 'groovegoblin-course-import/1';

const COURSE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const FILE_EXTENSION = /\.([A-Za-z0-9]{1,8})$/;
const ENV_LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const MAX_WALK_DEPTH = 32;
const SHORT_TIMEOUT_MS = 2 * 60 * 1000;
const LONG_TIMEOUT_MS = 60 * 60 * 1000;
const BACKUP_NAME = /^groovegoblin-\d{4}-\d{2}-\d{2}\.ndjson\.gz$/;
const ARCHIVE_SPARE_BYTES = 64 * 1024 * 1024;
// Pasta da cópia independente do instantâneo de cada rodada (fora de backups/,
// que o servidor substitui no mesmo dia e poda).
export const IMPORT_BACKUPS_DIR = 'import-backups';
// Entradas do diretório de dados que o servidor (ou este importador) gere: a
// pasta de material nunca pode ficar dentro delas nem contê-las.
export const MANAGED_DATA_ENTRIES = Object.freeze(['entrada', 'blobs', 'objects', 'docs', 'private', 'backups', 'tmp', IMPORT_BACKUPS_DIR]);
const INVALID_NAME_POLICIES = Object.freeze(['fail', 'skip']);

export class WorkerError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
    this.detail = detail;
  }
}

// ── puros (exportados para os testes) ───────────────────────────────────────

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

// `CHAVE=valor` por linha, `#` comenta, aspas simples/duplas em volta são
// tiradas. Nunca executa nada: é o mesmo formato que o systemd e os scripts de
// deploy aceitam.
export function parseEnvText(text) {
  const values = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = ENV_LINE.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export function extensionOf(name) {
  const match = FILE_EXTENSION.exec(name);
  return match ? match[1].toLowerCase() : '';
}

// Mesmas regras do `validateStoredName` do servidor: o nome guardado na pasta
// de entrada nunca vira caminho nem é recusado pelo scan.
export function isStorableName(name, maxNameBytes) {
  return typeof name === 'string' && name !== '' && name === name.trim() && Buffer.byteLength(name, 'utf8') <= maxNameBytes
    && !CONTROL.test(name) && !name.includes('/') && !name.includes('\\') && !name.startsWith('.') && !name.includes('::');
}

// Sufixo determinístico para um nome que já tem outro conteúdo: dígitos entre
// parênteses derivados do sha256. O casamento por nome do servidor ignora
// sufixo "(N)", então a variante continua casando com o mesmo material.
export function suffixedName(name, sha256) {
  const digits = String(Number.parseInt(sha256.slice(0, 8), 16));
  const match = FILE_EXTENSION.exec(name);
  if (!match) return `${name} (${digits})`;
  return `${name.slice(0, match.index)} (${digits})${match[0]}`;
}

function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Plano da cópia plana de UM curso.
//   sources: [{ rel, name, size, sha256 }] — arquivos aceitos da pasta de material;
//   existing: Map(nome -> { sha256, size }) — arquivos que já estão na pasta de entrada.
// Regras: mesmo nome + mesmo conteúdo entra uma vez; o primeiro conteúdo de um
// nome (na ordem dos caminhos relativos) fica com o nome puro, os outros ganham
// `suffixedName`; nada que já está na pasta é sobrescrito; um conteúdo que já
// está lá (no nome puro ou no sufixado) não é copiado de novo.
export function planFlatten(sources, existing, { maxNameBytes = 240 } = {}) {
  const ordered = [...sources].sort((a, b) => byCodeUnit(a.rel, b.rel));
  const groups = new Map();
  for (const source of ordered) {
    if (!groups.has(source.name)) groups.set(source.name, new Map());
    const contents = groups.get(source.name);
    if (!contents.has(source.sha256)) contents.set(source.sha256, { sha256: source.sha256, size: source.size, sources: [] });
    contents.get(source.sha256).sources.push(source.rel);
  }
  const taken = new Map(existing);
  const copies = [];
  const present = [];
  const collisions = [];
  const rejected = [];
  let collapsed = 0;
  for (const name of [...groups.keys()].sort(byCodeUnit)) {
    const contents = [...groups.get(name).values()];
    const variants = [];
    let suffixed = false;
    for (const [index, content] of contents.entries()) {
      collapsed += content.sources.length - 1;
      const alternate = suffixedName(name, content.sha256);
      let storedAs = null;
      let status;
      if (taken.get(name)?.sha256 === content.sha256) {
        storedAs = name;
        status = 'present';
      } else if (taken.get(alternate)?.sha256 === content.sha256) {
        storedAs = alternate;
        status = 'present';
      } else if (index === 0 && !taken.has(name)) {
        storedAs = name;
        status = 'copy';
      } else if (!taken.has(alternate) && isStorableName(alternate, maxNameBytes)) {
        storedAs = alternate;
        status = 'copy';
      } else {
        status = 'rejected';
      }
      if (storedAs !== name) suffixed = true;
      const entry = { name, storedAs, sha256: content.sha256, size: content.size, sources: content.sources };
      if (status === 'present') present.push(entry);
      else if (status === 'copy') {
        copies.push(entry);
        taken.set(storedAs, { sha256: content.sha256, size: content.size });
      } else rejected.push({ ...entry, reason: 'name-conflict' });
      variants.push({ sha256: content.sha256, storedAs, sources: content.sources });
    }
    if (contents.length > 1 || suffixed) collisions.push({ name, variants });
  }
  return { copies, present, collisions, rejected, collapsed };
}

// Contagens do documento de curso guardado (envelope `groovegoblin-course`).
export function courseDocumentStats(document) {
  const sections = Array.isArray(document?.course?.sections) ? document.course.sections : [];
  const stats = { sections: sections.length, lessons: 0, resources: 0, exercises: 0, recipeExercises: 0, watchedLessons: 0 };
  for (const section of sections) {
    const lessons = Array.isArray(section?.lessons) ? section.lessons : [];
    stats.lessons += lessons.length;
    for (const lesson of lessons) {
      stats.resources += Array.isArray(lesson?.resources) ? lesson.resources.length : 0;
      const exercises = Array.isArray(lesson?.suggestedExercises) ? lesson.suggestedExercises : [];
      stats.exercises += exercises.length;
      stats.recipeExercises += exercises.filter((exercise) => exercise?.recipe !== undefined && exercise?.recipe !== null).length;
    }
  }
  stats.watchedLessons = Array.isArray(document?.progress?.watchedLessonIds) ? document.progress.watchedLessonIds.length : 0;
  return stats;
}

// Aulas assistidas guardadas no envelope (`null` = documento sem progresso).
export function watchedIdsOf(document) {
  if (!document?.progress || typeof document.progress !== 'object') return null;
  return Array.isArray(document.progress.watchedLessonIds) ? document.progress.watchedLessonIds.filter((id) => typeof id === 'string') : [];
}

// Progresso depois da conversão: as aulas que o servidor JÁ marcava como
// assistidas (o app grava aqui) ficam na frente, unidas às que o documento
// convertido traz (progresso histórico do mapa). Só cai a marcação de aula que
// não existe mais no curso: o formato recusa referência quebrada, e o PUT de
// documento não valida. A união é idempotente (mesma entrada, mesma saída),
// então a segunda rodada reconhece o documento como igual.
export function mergeProgress(document, currentWatched) {
  const converted = watchedIdsOf(document);
  if (currentWatched === null && converted === null) return { document, kept: 0, added: 0, dropped: [] };
  const lessonIds = new Set();
  for (const section of Array.isArray(document?.course?.sections) ? document.course.sections : []) {
    for (const lesson of Array.isArray(section?.lessons) ? section.lessons : []) if (typeof lesson?.id === 'string') lessonIds.add(lesson.id);
  }
  const watched = [];
  const seen = new Set();
  const dropped = [];
  for (const id of currentWatched ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (lessonIds.has(id)) watched.push(id);
    else dropped.push(id);
  }
  const kept = watched.length;
  for (const id of converted ?? []) {
    if (seen.has(id) || !lessonIds.has(id)) continue;
    seen.add(id);
    watched.push(id);
  }
  // `progress` é a última chave do envelope canônico: o spread a mantém no lugar.
  return { document: { ...document, progress: { watchedLessonIds: watched } }, kept, added: watched.length - kept, dropped };
}

// Por que um caminho (absoluto, normalizado) não serve como pasta de material,
// ou `null`. Dentro do diretório de dados só vale uma árvore própria do
// usuário: nunca o próprio diretório (nem um ancestral) nem nada sob as
// entradas geridas.
export function materialPathProblem(path, dataDir) {
  if (inside(path, dataDir)) return 'contains-data-dir';
  if (!inside(dataDir, path)) return null;
  const first = relative(dataDir, path).split(sep)[0];
  return MANAGED_DATA_ENTRIES.includes(first) ? 'managed-dir' : null;
}

// Digest estável dos vínculos (ordem das chaves não importa; `addedAt` conta).
export function refsDigest(refs) {
  const sorted = Object.keys(refs ?? {}).sort(byCodeUnit).map((key) => [key, refs[key]]);
  return sha256Hex(JSON.stringify(sorted));
}

function sameRef(a, b) {
  return Boolean(a && b) && a.sha256 === b.sha256 && a.kind === b.kind && a.size === b.size;
}

// Vínculos que existiam ANTES do scan e que o scan trocou. O scan do servidor
// sobrescreve um vínculo quando acha outro arquivo para o mesmo material; aqui
// o que já existia (inclusive vínculo manual) volta, a não ser que o blob dele
// tenha sumido — aí o vínculo novo do scan é o conserto e fica.
export function refsToRestore(before, after, blobPresent) {
  const restore = {};
  const keptScan = [];
  for (const [key, previous] of Object.entries(before ?? {})) {
    if (sameRef(previous, after?.[key])) continue;
    if (!SHA256.test(previous?.sha256 ?? '') || blobPresent(previous.sha256) !== true) {
      keptScan.push(key);
      continue;
    }
    restore[key] = previous;
  }
  return { restore, keptScan };
}

// Limites efetivos da pasta de entrada, na mesma ordem do servidor:
// padrões < `<dataDir>/<limitsFile>` < ambiente do serviço.
export function effectiveLimits(defaults, fileValues, envValues, limitEnv) {
  const limits = { ...defaults };
  const sources = {};
  for (const [key, value] of Object.entries(fileValues ?? {})) {
    if (Object.hasOwn(defaults, key) && Number.isSafeInteger(value) && value > 0) {
      limits[key] = value;
      sources[key] = 'file';
    }
  }
  for (const [key, variable] of Object.entries(limitEnv ?? {})) {
    const raw = envValues?.[variable];
    if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) continue;
    const value = Number(raw);
    if (Object.hasOwn(defaults, key) && Number.isSafeInteger(value) && value > 0) {
      limits[key] = value;
      sources[key] = 'env';
    }
  }
  return { limits, sources };
}

// Avalia o plano contra os limites. `blockers` impedem qualquer escrita (o scan
// do servidor recusaria a pasta inteira); `warnings` só viram "não casado".
// Entradas que não são arquivo comum (`special`) ocupam o nome mas o scan não as conta.
export function checkLimits(plan, existingFiles, limits, extensions) {
  const finalNames = new Map([...existingFiles].filter(([, entry]) => !entry.special));
  for (const copy of plan.copies) finalNames.set(copy.storedAs, { size: copy.size });
  const entries = finalNames.size;
  let bytes = 0;
  for (const { size } of finalNames.values()) bytes += size;
  const blockers = [];
  if (entries > limits.maxEntries) blockers.push({ code: 'too_many_files', entries, limit: limits.maxEntries });
  if (bytes > limits.maxCourseBytes) blockers.push({ code: 'course_too_large', bytes, limit: limits.maxCourseBytes });
  const tooLarge = [];
  const zipTooLarge = [];
  for (const [name, { size }] of finalNames) {
    if (size > limits.maxEntryBytes) tooLarge.push({ name, size });
    else if (extensions.zip.includes(extensionOf(name)) && size > limits.maxZipBytes) zipTooLarge.push({ name, size });
  }
  return { entries, bytes, blockers, tooLarge, zipTooLarge };
}

// ── E/S ──────────────────────────────────────────────────────────────────────

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

// Abre só para leitura, sem seguir link no último componente, e confere pelo
// DESCRITOR (o caminho pode mudar no meio): arquivo comum, o mesmo inode visto
// na listagem e, no Linux, o caminho real ainda dentro de `realRoot` — uma
// subpasta trocada por link no meio da rodada não leva a leitura para fora.
async function openConfined(path, { realRoot = null, identity = null } = {}) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new WorkerError('source_changed', 'O arquivo de origem deixou de ser um arquivo comum.');
    if (identity && (info.dev !== identity.dev || info.ino !== identity.ino)) throw new WorkerError('source_changed', 'O arquivo de origem foi trocado durante a importação.');
    if (realRoot !== null) {
      const actual = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
      if (actual !== null && !inside(realRoot, actual)) throw new WorkerError('material_escape', 'Um arquivo resolveu para fora da pasta esperada (link no caminho).');
    }
    return { handle, info };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function hashFile(path, confine = {}) {
  const { handle } = await openConfined(path, confine);
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

// Lista a pasta de material recursivamente SEM seguir link simbólico e devolve
// TODO arquivo comum para a cópia: extensão fora do que o app abre também entra
// (o scan do servidor relata como não casado). Nada some calado: link, arquivo
// especial, nome que a pasta de entrada não aceita e pasta funda demais ficam
// listados pelo caminho relativo. Com `realRoot`, cada subpasta precisa
// continuar sendo ela mesma (caminho real dentro da raiz real).
export async function scanMaterialFolder(root, { maxNameBytes, extensions = null, realRoot = null, hash = true }) {
  const known = extensions ? new Set([...extensions.pdf, ...extensions.audio, ...extensions.zip]) : null;
  const files = [];
  const skipped = { symlinks: 0, special: 0, invalidName: 0, tooDeep: 0 };
  const skippedPaths = [];
  const invalidNames = [];
  const tooDeep = [];
  let unsupported = 0;
  let total = 0;
  let bytes = 0;
  async function walk(dir, rel, depth) {
    if (depth > MAX_WALK_DEPTH) { skipped.tooDeep += 1; tooDeep.push(rel); return; }
    const names = (await readdir(dir)).sort(byCodeUnit);
    if (realRoot !== null && (await realpath(dir)) !== (rel === '' ? realRoot : join(realRoot, ...rel.split('/')))) {
      throw new WorkerError('material_escape', 'Uma subpasta do material virou link ou mudou de lugar durante a leitura.');
    }
    for (const name of names) {
      const path = join(dir, name);
      const relPath = rel === '' ? name : `${rel}/${name}`;
      const info = await lstat(path);
      if (info.isSymbolicLink()) { skipped.symlinks += 1; skippedPaths.push({ rel: relPath, kind: 'symlink' }); continue; }
      if (info.isDirectory()) { await walk(path, relPath, depth + 1); continue; }
      if (!info.isFile()) { skipped.special += 1; skippedPaths.push({ rel: relPath, kind: 'special' }); continue; }
      total += 1;
      if (!isStorableName(name, maxNameBytes)) { skipped.invalidName += 1; invalidNames.push(relPath); continue; }
      if (known && !known.has(extensionOf(name))) unsupported += 1;
      bytes += info.size;
      files.push({ rel: relPath, path, name, size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino, sha256: hash ? await hashFile(path, { realRoot, identity: info }) : null });
    }
  }
  await walk(root, '', 0);
  return { files, skipped, skippedPaths, invalidNames, tooDeep, unsupported, total, bytes };
}

// O que já está na pasta de entrada do curso. Arquivo comum guarda dono, modo,
// links e inode (para o conserto); qualquer outra coisa só ocupa o nome.
async function listIntakeFolder(dir) {
  const existing = new Map();
  const info = await lstatOrNull(dir);
  if (!info) return { exists: false, existing };
  if (!info.isDirectory()) throw new WorkerError('unsafe_intake_dir', 'A pasta de entrada do curso não é uma pasta comum.');
  for (const name of await readdir(dir)) {
    const stats = await lstatOrNull(join(dir, name));
    if (!stats) continue;
    if (!stats.isFile()) { existing.set(name, { size: 0, sha256: null, special: true }); continue; }
    existing.set(name, { size: stats.size, sha256: null, nlink: stats.nlink, uid: stats.uid, gid: stats.gid, mode: stats.mode & 0o7777, dev: stats.dev, ino: stats.ino });
  }
  return { exists: true, existing };
}

// Cópia de verdade (bytes, nunca link) para um temporário novo: hash conferido
// (se `expectedSha`), dono do serviço e 0600 aplicados pelo descritor do
// temporário. A origem só é aberta para leitura.
async function writeVerifiedCopy(sourcePath, tmpPath, expectedSha, owner, confine = {}) {
  const { handle: source, info } = await openConfined(sourcePath, confine);
  let target = null;
  try {
    target = await open(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += chunk.length;
      await writeAll(target, chunk);
    }
    const sha256 = hash.digest('hex');
    if ((expectedSha !== null && sha256 !== expectedSha) || size !== info.size) throw new WorkerError('source_changed', 'O conteúdo de origem mudou durante a importação.');
    await target.chown(owner.uid, owner.gid);
    await target.chmod(0o600);
    await target.sync();
    await target.close();
    target = null;
    return { sha256, size };
  } catch (error) {
    if (target) await target.close().catch(() => {});
    target = null;
    await unlink(tmpPath).catch(() => {});
    throw error;
  } finally {
    await source.close();
  }
}

// Põe o temporário no nome final. Sem `replace`, o nome precisa estar livre;
// com `replace` ({dev, ino}), só troca se ainda é o mesmo arquivo visto na
// pré-checagem. A troca é só de entrada de diretório: o inode antigo (que pode
// ser o original, por link físico) nunca é alterado.
async function commitCopy(tmpPath, finalPath, replace = null) {
  try {
    const current = await lstatOrNull(finalPath);
    const ok = replace === null ? current === null : Boolean(current?.isFile() && current.dev === replace.dev && current.ino === replace.ino);
    if (!ok) throw new WorkerError('intake_changed', 'A pasta de entrada mudou durante a cópia (nome ocupado ou arquivo trocado).');
    await rename(tmpPath, finalPath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

async function syncDir(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// Dono/modo de uma pasta de verdade pelo descritor (nunca segue link).
async function fixDirOwner(path, owner) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.chown(owner.uid, owner.gid);
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

// Pasta do serviço: criada 0700 com o dono do serviço; se já existe (pasta de
// verdade, nunca link) com outro dono ou sem rwx do dono, é consertada.
async function ensureOwnedDir(path, owner) {
  const info = await lstatOrNull(path);
  if (!info) {
    await mkdir(path, { mode: 0o700 });
    await fixDirOwner(path, owner);
    return 'created';
  }
  if (!info.isDirectory()) throw new WorkerError('unsafe_intake_dir', 'O caminho existe e não é uma pasta comum.');
  if (info.uid === owner.uid && info.gid === owner.gid && (info.mode & 0o700) === 0o700) return 'ok';
  await fixDirOwner(path, owner);
  return 'repaired';
}

// Commit do checkout do serviço no Pi, só para explicar diferença de conversão.
function checkoutCommit(appDir) {
  if (typeof appDir !== 'string' || !isAbsolute(appDir)) return null;
  try {
    return execFileSync('git', ['-c', `safe.directory=${appDir}`, '-C', appDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function serviceOwner(user) {
  const read = (flag) => Number(execFileSync('id', [flag, '--', user], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  let uid;
  let gid;
  try {
    uid = read('-u');
    gid = read('-g');
  } catch {
    throw new WorkerError('service_user_missing', 'O usuário do serviço não existe nesta máquina.');
  }
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw new WorkerError('service_user_missing', 'Não consegui ler uid/gid do usuário do serviço.');
  return { uid, gid };
}

// ── cliente da API em loopback ────────────────────────────────────────────

export function createApiClient({ host, port, basePath, login, origin, requestImpl = httpRequest }) {
  const hostHeader = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  const prefix = `${basePath.endsWith('/') ? basePath : `${basePath}/`}api`;
  function call(method, path, { json, headers = {}, timeoutMs = SHORT_TIMEOUT_MS } = {}) {
    const body = json === undefined ? null : Buffer.from(JSON.stringify(json));
    const finalHeaders = { Host: hostHeader, Accept: 'application/json', ...headers };
    if (login) finalHeaders['Tailscale-User-Login'] = login;
    if (method !== 'GET' && method !== 'HEAD') finalHeaders.Origin = origin;
    if (body) {
      finalHeaders['Content-Type'] = 'application/json';
      finalHeaders['Content-Length'] = String(body.length);
    }
    return new Promise((resolve, reject) => {
      const request = requestImpl({ host, port, method, path: `${prefix}${path}`, headers: finalHeaders, agent: false }, (response) => {
        const parts = [];
        response.on('data', (chunk) => parts.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const buffer = Buffer.concat(parts);
          let parsed = null;
          if (String(response.headers['content-type'] ?? '').startsWith('application/json') && buffer.length > 0) {
            try { parsed = JSON.parse(buffer.toString('utf8')); } catch { parsed = null; }
          }
          resolve({ status: response.statusCode, headers: response.headers, body: buffer, json: parsed });
        });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new WorkerError('api_timeout', `A API não respondeu a tempo (${method} ${path.split('/').slice(0, 2).join('/')}).`)));
      request.on('error', reject);
      request.end(body ?? undefined);
    });
  }
  return {
    get: (path, options) => call('GET', path, options),
    head: (path, options) => call('HEAD', path, options),
    post: (path, options) => call('POST', path, options),
    put: (path, options) => call('PUT', path, options),
  };
}

function apiError(step, response, extra = {}) {
  const code = typeof response.json?.error === 'string' ? response.json.error : `http_${response.status}`;
  return new WorkerError('api_failed', `A API recusou ${step} (${response.status} ${code}).`, { step, status: response.status, apiCode: code, ...extra });
}

async function readDoc(api, collection, id) {
  const response = await api.get(`/docs/${collection}/${id}`);
  if (response.status === 404) return { exists: false, rev: response.json?.rev ?? null, deleted: Boolean(response.json?.deleted), body: null, digest: null, value: null };
  if (response.status !== 200) throw apiError(`GET ${collection}`, response);
  let value = null;
  try { value = JSON.parse(response.body.toString('utf8')); } catch { value = null; }
  return { exists: true, rev: response.headers['x-groove-rev'] ?? null, deleted: false, body: response.body, digest: sha256Hex(response.body), value };
}

async function blobPresence(api, shas) {
  const present = new Map();
  for (const sha of shas) {
    if (!SHA256.test(sha) || present.has(sha)) continue;
    const response = await api.head(`/blobs/${sha}`);
    present.set(sha, response.status === 200);
  }
  return present;
}

async function privateDigest(api, name) {
  const response = await api.head(`/private/${name}`);
  if (response.status !== 200) return null;
  return String(response.headers.etag ?? '').replace(/"/g, '') || null;
}

function summarizeReport(report) {
  const unmatchedByReason = {};
  for (const item of report?.unmatched ?? []) unmatchedByReason[item.reason] = (unmatchedByReason[item.reason] ?? 0) + 1;
  return {
    total: report?.total ?? null,
    available: report?.available ?? null,
    missing: report?.missing?.length ?? null,
    unmatched: report?.unmatched?.length ?? null,
    unmatchedByReason,
    missingBlobs: report?.missingBlobs ?? null,
    refs: report?.refs ?? null,
    files: report?.files ?? null,
    zip: report?.zip ?? null,
    digest: report ? sha256Hex(JSON.stringify({ total: report.total, available: report.available, missing: report.missing, unmatched: report.unmatched })) : null,
  };
}

// ── execução ─────────────────────────────────────────────────────────────────

function validatePayload(payload) {
  if (payload?.format !== WORKER_FORMAT) throw new WorkerError('bad_payload', 'Pacote do laptop em formato desconhecido.');
  if (payload.mode !== 'plan' && payload.mode !== 'apply') throw new WorkerError('bad_payload', 'Modo precisa ser plan ou apply.');
  const remote = payload.remote ?? {};
  if (typeof remote.envFile !== 'string' || !isAbsolute(remote.envFile)) throw new WorkerError('bad_payload', 'Caminho do ambiente do serviço precisa ser absoluto.');
  if (typeof remote.serviceUser !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(remote.serviceUser)) throw new WorkerError('bad_payload', 'Usuário do serviço inválido.');
  if (!Array.isArray(payload.courses) || payload.courses.length === 0) throw new WorkerError('bad_payload', 'Nenhum curso no pacote.');
  const ids = new Set();
  for (const course of payload.courses) {
    if (!COURSE_ID.test(course?.courseId ?? '')) throw new WorkerError('bad_payload', 'Id de curso inválido no pacote.');
    if (ids.has(course.courseId)) throw new WorkerError('bad_payload', 'Curso repetido no pacote.', { courseId: course.courseId });
    ids.add(course.courseId);
    if (typeof course.materialFolder !== 'string' || course.materialFolder === '') throw new WorkerError('bad_payload', 'Pasta de material ausente.', { courseId: course.courseId });
    if (course.map === null || typeof course.map !== 'object' || Array.isArray(course.map)) throw new WorkerError('bad_payload', 'Mapa ausente.', { courseId: course.courseId });
    if (course.catalog !== null && !Array.isArray(course.catalog)) throw new WorkerError('bad_payload', 'Catálogo precisa ser lista ou null.', { courseId: course.courseId });
    if (course.includeProgress !== null && typeof course.includeProgress !== 'boolean') throw new WorkerError('bad_payload', 'includeProgress precisa ser booleano ou null.', { courseId: course.courseId });
    // Os documentos que o laptop gerou, conferidos contra os digests: base do
    // "igual ao esperado" depois da união do progresso.
    for (const [variant, digestKey] of [['withProgress', 'courseDigestWithProgress'], ['withoutProgress', 'courseDigest']]) {
      const document = course.expectedDocuments?.[variant];
      if (document === null || typeof document !== 'object' || Array.isArray(document) || sha256Hex(JSON.stringify(document)) !== course.expected?.[digestKey]) {
        throw new WorkerError('bad_payload', 'Documento esperado ausente ou diferente do digest.', { courseId: course.courseId });
      }
    }
  }
  if (!INVALID_NAME_POLICIES.includes(payload.options?.invalidNames ?? 'fail')) throw new WorkerError('bad_payload', 'invalidNames precisa ser fail ou skip.');
}

const MATERIAL_PROBLEMS = Object.freeze({
  'contains-data-dir': 'A pasta de material não pode ser o diretório de dados nem contê-lo.',
  'managed-dir': 'A pasta de material não pode ficar dentro de uma pasta gerida pelo servidor (entrada, blobs, backups, …).',
});

async function hardlinksProtected() {
  return readFile('/proc/sys/fs/protected_hardlinks', 'utf8').then((text) => text.trim() === '1', () => false);
}

// Pasta de material de um curso: relativa à raiz de material ou absoluta, mas,
// com raiz configurada, sempre dentro dela — no caminho escrito E no caminho
// real (links resolvidos). Pode ficar dentro do diretório de dados numa árvore
// própria (ex.: `<dataDir>/material/`), nunca sob as entradas geridas nem
// sendo o diretório de dados (ou um ancestral). Dentro dele, o dono do
// diretório de dados (o serviço) controla as entradas: só com
// `fs.protected_hardlinks=1` o trabalhador (root) aceita ler dali, para um link
// físico plantado não levar um arquivo do root para a pasta de entrada.
export async function resolveMaterialFolder(remote, folder, dataDir, { realDataDir = null, linksProtected = null } = {}) {
  const refuse = (reason, message) => new WorkerError('material_path_refused', message, { reason });
  const root = typeof remote?.materialRoot === 'string' && remote.materialRoot !== '' ? remote.materialRoot : null;
  if (root !== null && !isAbsolute(root)) throw refuse('root-not-absolute', 'A raiz de material configurada não é um caminho absoluto.');
  if (typeof folder !== 'string' || folder === '' || CONTROL.test(folder)) throw refuse('invalid', 'Pasta de material ausente ou com caractere de controle.');
  if (!isAbsolute(folder) && root === null) throw refuse('no-root', 'Pasta de material relativa sem raiz de material configurada.');
  const path = isAbsolute(folder) ? normalize(folder) : normalize(join(root, folder));
  if (root !== null && !inside(normalize(root), path)) throw refuse('outside-root', 'A pasta de material fica fora da raiz de material configurada.');
  const data = normalize(dataDir);
  const lexical = materialPathProblem(path, data);
  if (lexical) throw refuse(lexical, MATERIAL_PROBLEMS[lexical]);
  let real;
  try {
    real = await realpath(path);
  } catch {
    throw new WorkerError('material_missing', 'A pasta de material do curso não existe.');
  }
  const realData = realDataDir ?? await realpath(data);
  if (root !== null) {
    let realRoot;
    try {
      realRoot = await realpath(root);
    } catch {
      throw new WorkerError('material_missing', 'A raiz de material configurada não existe.');
    }
    if (!inside(realRoot, real)) throw refuse('link-outside-root', 'A pasta de material sai da raiz de material por um link.');
  }
  const resolved = materialPathProblem(real, realData);
  if (resolved) throw refuse(`link-${resolved}`, MATERIAL_PROBLEMS[resolved]);
  const underDataDir = inside(realData, real);
  if (underDataDir && !(linksProtected ?? await hardlinksProtected())) {
    throw refuse('hardlinks-unprotected', 'Pasta de material dentro do diretório de dados exige fs.protected_hardlinks=1 nesta máquina.');
  }
  return { path, real, underDataDir };
}

async function loadServiceEnv(remote, payload) {
  let text;
  try {
    text = await readFile(remote.envFile, 'utf8');
  } catch {
    throw new WorkerError('env_unreadable', 'Não consegui ler o ambiente do serviço.');
  }
  const env = parseEnvText(text);
  const dataDir = env.GROOVE_DATA_DIR || '';
  if (!dataDir || !isAbsolute(dataDir)) throw new WorkerError('env_invalid', 'O ambiente do serviço não tem GROOVE_DATA_DIR absoluto.');
  if (remote.dataDir && normalize(remote.dataDir) !== normalize(dataDir)) throw new WorkerError('data_dir_mismatch', 'O diretório de dados configurado no laptop não é o do serviço.');
  const port = Number(env.PORT || 5173);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new WorkerError('env_invalid', 'PORT inválida no ambiente do serviço.');
  if (remote.servicePort && Number(remote.servicePort) !== port) throw new WorkerError('port_mismatch', 'A porta configurada no laptop não é a do serviço.');
  const host = env.GROOVE_HOST || '127.0.0.1';
  if (remote.serviceHost && remote.serviceHost !== host) throw new WorkerError('host_mismatch', 'O endereço configurado no laptop não é o do serviço.');
  const mode = env.GROOVE_AUTH || 'dev';
  let login = null;
  let origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  if (mode === 'tailscale') {
    login = String(env.GROOVE_ALLOWED_LOGINS ?? '').split(',').map((entry) => entry.trim()).find(Boolean) ?? null;
    if (!login || !env.GROOVE_PUBLIC_ORIGIN) throw new WorkerError('env_invalid', 'Modo tailscale sem login ou sem origem pública no ambiente do serviço.');
    origin = env.GROOVE_PUBLIC_ORIGIN;
  }
  let fileLimits = {};
  let limitsFile = 'absent';
  if (payload.limitsFile) {
    const path = join(dataDir, payload.limitsFile);
    const info = await lstatOrNull(path);
    if (info?.isFile()) {
      try { fileLimits = JSON.parse(await readFile(path, 'utf8')); limitsFile = 'present'; } catch { limitsFile = 'unreadable'; }
    } else if (info) limitsFile = 'not-a-file';
  }
  const { limits, sources } = effectiveLimits(payload.limits, fileLimits, env, payload.limitEnv);
  return { env, dataDir: normalize(dataDir), port, host, mode, login, origin, basePath: env.BASE_PATH || '/', limits, limitSources: sources, limitsFile };
}

async function preflightCourse(context, course, index) {
  const { api, payload, service, owner } = context;
  const { courseId } = course;
  let folder;
  try {
    folder = await resolveMaterialFolder(payload.remote, course.materialFolder, service.dataDir, { realDataDir: service.realDataDir });
  } catch (error) {
    if (error instanceof WorkerError) error.detail = { courseId, ...error.detail };
    throw error;
  }
  const folderInfo = await lstatOrNull(folder.path);
  if (!folderInfo || !folderInfo.isDirectory()) throw new WorkerError('material_missing', 'A pasta de material do curso não existe (ou é link).', { courseId });
  context.emit('progress', { step: 'scan-source', course: index + 1 });
  const source = await scanMaterialFolder(folder.path, { extensions: payload.extensions, maxNameBytes: service.limits.maxNameBytes, realRoot: folder.real });
  const sourceBlockers = [];
  if (source.invalidNames.length > 0 && (payload.options?.invalidNames ?? 'fail') === 'fail') sourceBlockers.push({ code: 'invalid_names', paths: source.invalidNames });
  if (source.tooDeep.length > 0) sourceBlockers.push({ code: 'too_deep', paths: source.tooDeep });
  const intakeDir = join(service.dataDir, 'entrada', courseId);
  const intake = await listIntakeFolder(intakeDir);
  // Só hasheia o que pode colidir: o nome puro e o sufixado de cada conteúdo.
  const candidates = new Set();
  for (const file of source.files) { candidates.add(file.name); candidates.add(suffixedName(file.name, file.sha256)); }
  const existing = new Map();
  for (const [name, entry] of intake.existing) {
    existing.set(name, !entry.special && candidates.has(name) ? { ...entry, sha256: await hashFile(join(intakeDir, name), { identity: entry }) } : entry);
  }
  const plan = planFlatten(source.files, existing, { maxNameBytes: service.limits.maxNameBytes });
  const limits = checkLimits(plan, intake.existing, service.limits, payload.extensions);
  // Cópia antiga com o mesmo conteúdo, mas ligada por link físico (talvez ao
  // original) ou com dono/modo errado: trocada por cópia nova + rename, sem
  // chmod/chown no inode existente. Outros arquivos da pasta só são contados.
  const repairs = [];
  const presentNames = new Set(plan.present.map((entry) => entry.storedAs));
  for (const entry of plan.present) {
    const current = existing.get(entry.storedAs);
    if (!current || current.special) continue; // "presente" por uma cópia desta mesma rodada
    const reasons = [];
    if (current.nlink > 1) reasons.push('hardlink');
    if (current.uid !== owner.uid || current.gid !== owner.gid || current.mode !== 0o600) reasons.push('owner-mode');
    if (reasons.length > 0) repairs.push({ ...entry, reasons, identity: { dev: current.dev, ino: current.ino } });
  }
  const intakeOthers = { hardlinks: 0, ownerMode: 0 };
  for (const [name, entry] of intake.existing) {
    if (entry.special || presentNames.has(name)) continue;
    if (entry.nlink > 1) intakeOthers.hardlinks += 1;
    if (entry.uid !== owner.uid || entry.gid !== owner.gid || entry.mode !== 0o600) intakeOthers.ownerMode += 1;
  }

  const courseDoc = await readDoc(api, 'courses', courseId);
  const attachments = await readDoc(api, 'courseAttachments', courseId);
  const states = await readDoc(api, 'courseStates', courseId);
  const includeProgress = course.includeProgress ?? Boolean(courseDoc.value?.progress);
  const currentWatched = courseDoc.exists ? watchedIdsOf(courseDoc.value) : null;
  const merged = mergeProgress(includeProgress ? course.expectedDocuments.withProgress : course.expectedDocuments.withoutProgress, currentWatched);
  const expectedDigest = sha256Hex(JSON.stringify(merged.document));
  const dry = await api.post('/courses/convert', { json: { map: course.map, catalog: course.catalog, includeProgress, dryRun: true }, timeoutMs: LONG_TIMEOUT_MS });
  if (dry.status !== 200 || dry.json?.ok !== true) throw apiError('convert dryRun', dry, { courseId, problems: dry.json?.problems ?? null });
  if (dry.json.courseId !== courseId) throw new WorkerError('course_id_mismatch', 'O servidor converteu o mapa para outro id de curso.', { courseId, serverCourseId: dry.json.courseId });
  const unchanged = courseDoc.exists && courseDoc.digest === expectedDigest;
  const report = courseDoc.exists ? await api.get(`/courses/${courseId}/materials`) : null;
  return {
    course,
    folder,
    intakeDir,
    intakeExists: intake.exists,
    source,
    sourceBlockers,
    plan,
    limits,
    repairs,
    intakeOthers,
    includeProgress,
    currentWatched,
    progress: { includeProgress, before: currentWatched?.length ?? null, kept: merged.kept, fromMap: merged.added, dropped: merged.dropped, after: watchedIdsOf(merged.document)?.length ?? null },
    expectedDigest,
    dryRun: { counts: dry.json.counts, warnings: dry.json.warnings?.length ?? 0, private: dry.json.private },
    before: {
      course: { exists: courseDoc.exists, rev: courseDoc.rev, digest: courseDoc.digest, hasProgress: Boolean(courseDoc.value?.progress), stats: courseDoc.value ? courseDocumentStats(courseDoc.value) : null },
      attachments: { exists: attachments.exists, rev: attachments.rev, refs: attachments.value?.refs ?? {}, digest: refsDigest(attachments.value?.refs ?? {}) },
      courseStates: { exists: states.exists, rev: states.rev, digest: states.digest },
      report: report?.status === 200 ? summarizeReport(report.json) : null,
    },
    conversion: unchanged ? 'unchanged' : courseDoc.exists ? 'update' : 'create',
  };
}

function sourceSummary(prepared) {
  const { source, plan, limits, repairs } = prepared;
  return {
    folder: prepared.folder.path,
    underDataDir: prepared.folder.underDataDir,
    files: source.total,
    accepted: source.files.length,
    unsupported: source.unsupported,
    bytes: source.bytes,
    skipped: source.skipped,
    skippedPaths: source.skippedPaths,
    invalidNames: source.invalidNames,
    tooDeep: source.tooDeep,
    planned: plan.copies.length,
    present: plan.present.length,
    duplicatesCollapsed: plan.collapsed,
    collisions: plan.collisions,
    rejected: plan.rejected,
    repairs: { hardlinks: repairs.filter((entry) => entry.reasons.includes('hardlink')).length, ownerMode: repairs.filter((entry) => entry.reasons.includes('owner-mode')).length, names: repairs.map((entry) => entry.storedAs) },
    intakeOthers: prepared.intakeOthers,
    limits: { entries: limits.entries, bytes: limits.bytes, blockers: limits.blockers, tooLarge: limits.tooLarge, zipTooLarge: limits.zipTooLarge },
  };
}

// Logo depois da conversão (que grava o progresso histórico do mapa, ou
// nenhum): as aulas que o servidor marcava antes voltam, unidas, com CAS. Se o
// app gravar no meio, a união é refeita sobre o documento fresco.
async function restoreProgress(context, prepared) {
  const { api } = context;
  const { courseId } = prepared.course;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const fresh = await readDoc(api, 'courses', courseId);
    if (!fresh.exists || fresh.value === null) throw new WorkerError('course_vanished', 'O curso sumiu logo depois da conversão.', { courseId });
    const merged = mergeProgress(fresh.value, prepared.currentWatched);
    const summary = { kept: merged.kept, fromMap: merged.added, dropped: merged.dropped.length };
    if (sha256Hex(JSON.stringify(merged.document)) === fresh.digest) return { rev: fresh.rev, written: false, ...summary };
    const response = await api.put(`/docs/courses/${courseId}`, { json: merged.document, headers: { 'If-Match': `"${fresh.rev}"` } });
    if (response.status === 200 || response.status === 201) return { rev: response.headers['x-groove-rev'] ?? null, written: true, ...summary };
    if (response.status !== 412) throw apiError('restore progress', response, { courseId });
  }
  throw new WorkerError('course_busy', 'O curso mudou várias vezes seguidas; as aulas assistidas de antes não foram repostas (estão no instantâneo).', { courseId });
}

async function convertCourse(context, prepared) {
  const { api } = context;
  const { course } = prepared;
  if (prepared.conversion === 'unchanged') return { status: 'unchanged', rev: prepared.before.course.rev, progress: null };
  const json = { map: course.map, catalog: course.catalog, includeProgress: prepared.includeProgress };
  if (prepared.before.course.exists) json.expectedRev = prepared.before.course.rev;
  const response = await api.post('/courses/convert', { json, timeoutMs: LONG_TIMEOUT_MS });
  if (response.status === 409) throw new WorkerError('course_conflict', 'O curso mudou no servidor desde a pré-checagem; nada foi sobrescrito.', { courseId: course.courseId, rev: response.json?.rev ?? null });
  if ((response.status !== 200 && response.status !== 201) || response.json?.saved !== true) throw apiError('convert', response, { courseId: course.courseId });
  let progress;
  try {
    progress = await restoreProgress(context, prepared);
  } catch (error) {
    // A conversão já gravou: as aulas de antes vão no resultado privado (e
    // estão no instantâneo), porque a próxima rodada só enxerga o que ficou.
    const known = error instanceof WorkerError;
    throw new WorkerError(known ? error.code : 'progress_restore_failed', known ? error.message : 'Falha ao repor as aulas assistidas depois da conversão.', { ...(known ? error.detail : {}), courseId: course.courseId, watchedBefore: prepared.currentWatched });
  }
  return { status: response.json.created ? 'created' : 'updated', rev: progress.rev ?? response.json.rev, convertRev: response.json.rev, counts: response.json.counts, warnings: response.json.warnings?.length ?? 0, private: response.json.private, progress };
}

async function copyCourseFiles(context, prepared, index) {
  const { service, owner, runId } = context;
  const entrada = join(service.dataDir, 'entrada');
  const dirs = { entrada: await ensureOwnedDir(entrada, owner), course: await ensureOwnedDir(prepared.intakeDir, owner) };
  const sourceFor = (entry) => prepared.source.files.find((file) => file.rel === entry.sources[0]);
  const confine = (file) => ({ realRoot: prepared.folder.real, identity: file });
  let copied = 0;
  let bytes = 0;
  for (const [position, copy] of prepared.plan.copies.entries()) {
    const source = sourceFor(copy);
    const tmpPath = join(entrada, `.import-${runId}-${index}-${position}.part`);
    await writeVerifiedCopy(source.path, tmpPath, copy.sha256, owner, confine(source));
    await commitCopy(tmpPath, join(prepared.intakeDir, copy.storedAs));
    copied += 1;
    bytes += copy.size;
    if (copied % 25 === 0) context.emit('progress', { step: 'copy', course: index + 1, copied, planned: prepared.plan.copies.length });
  }
  const repaired = { hardlinks: 0, ownerMode: 0 };
  for (const [position, repair] of prepared.repairs.entries()) {
    const source = sourceFor(repair);
    const tmpPath = join(entrada, `.import-${runId}-${index}-r${position}.part`);
    await writeVerifiedCopy(source.path, tmpPath, repair.sha256, owner, confine(source));
    await commitCopy(tmpPath, join(prepared.intakeDir, repair.storedAs), repair.identity);
    if (repair.reasons.includes('hardlink')) repaired.hardlinks += 1;
    if (repair.reasons.includes('owner-mode')) repaired.ownerMode += 1;
  }
  if (copied > 0 || prepared.repairs.length > 0) await syncDir(prepared.intakeDir);
  return { copied, bytes, repaired, dirs };
}

// Cópia independente do instantâneo desta rodada, fora de backups/ (o diário
// do mesmo dia é substituído pelo próximo POST /api/backups — de outra rodada,
// do update.sh, do agendador — e a poda apaga os antigos):
// `<dataDir>/import-backups/<rodada>/<nome>`, dono do serviço, 0600.
async function archiveBackup(context, backup) {
  const { service, owner, runId } = context;
  if (!BACKUP_NAME.test(backup?.name ?? '')) throw new WorkerError('backup_unexpected', 'O instantâneo voltou com um nome inesperado.');
  const sourcePath = join(service.dataDir, 'backups', backup.name);
  const info = await lstatOrNull(sourcePath);
  if (!info?.isFile() || (Number.isSafeInteger(backup.size) && info.size !== backup.size)) throw new WorkerError('backup_unexpected', 'O arquivo do instantâneo não confere com a resposta da API.');
  const disk = await statfs(service.dataDir);
  const free = disk.bavail * disk.bsize;
  if (free < info.size + ARCHIVE_SPARE_BYTES) throw new WorkerError('archive_no_space', 'Sem espaço para a cópia independente do instantâneo; nada foi importado.', { needed: info.size + ARCHIVE_SPARE_BYTES, free });
  const base = join(service.dataDir, IMPORT_BACKUPS_DIR);
  await ensureOwnedDir(base, owner);
  const runDir = join(base, runId);
  try {
    await mkdir(runDir, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new WorkerError('archive_exists', 'Já existe uma cópia de instantâneo para esta rodada.');
    throw error;
  }
  await fixDirOwner(runDir, owner);
  const finalPath = join(runDir, backup.name);
  const copy = await writeVerifiedCopy(sourcePath, join(runDir, `.${backup.name}.part`), null, owner, { realRoot: join(service.realDataDir, 'backups'), identity: info });
  await commitCopy(join(runDir, `.${backup.name}.part`), finalPath);
  await syncDir(runDir);
  await syncDir(base);
  return { path: relative(service.dataDir, finalPath), size: copy.size, sha256: copy.sha256 };
}

async function originalsUnchanged(prepared) {
  let changed = 0;
  for (const file of prepared.source.files) {
    const info = await lstatOrNull(file.path);
    if (!info || !info.isFile() || info.size !== file.size || info.mtimeMs !== file.mtimeMs) changed += 1;
  }
  return changed;
}

async function scanAndPreserve(context, prepared) {
  const { api } = context;
  const { courseId } = prepared.course;
  const before = await readDoc(api, 'courseAttachments', courseId);
  const refsBefore = before.value?.refs ?? {};
  const scan = await api.post(`/courses/${courseId}/materials/scan`, { timeoutMs: LONG_TIMEOUT_MS });
  if (scan.status !== 200) throw apiError('materials scan', scan, { courseId });
  const restored = [];
  let keptScan = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const after = await readDoc(api, 'courseAttachments', courseId);
    const refsAfter = after.value?.refs ?? {};
    const present = await blobPresence(api, Object.values(refsBefore).map((ref) => ref?.sha256));
    const decision = refsToRestore(refsBefore, refsAfter, (sha) => present.get(sha));
    keptScan = decision.keptScan;
    const keys = Object.keys(decision.restore);
    if (keys.length === 0) break;
    const body = { ...(after.value ?? {}), refs: { ...refsAfter, ...decision.restore } };
    const response = await api.put(`/docs/courseAttachments/${courseId}`, { json: body, headers: after.exists ? { 'If-Match': `"${after.rev}"` } : { 'If-None-Match': '*' } });
    if (response.status === 200 || response.status === 201) { restored.push(...keys); break; }
    if (response.status !== 412) throw apiError('restore refs', response, { courseId });
    if (attempt === 3) throw new WorkerError('refs_busy', 'Os vínculos mudaram várias vezes seguidas; vínculos antigos não repostos.', { courseId, pending: keys });
  }
  return { scanReport: summarizeReport(scan.json), restored, keptScan };
}

async function verifyCourse(context, prepared) {
  const { api } = context;
  const { courseId } = prepared.course;
  const courseDoc = await readDoc(api, 'courses', courseId);
  const attachments = await readDoc(api, 'courseAttachments', courseId);
  const states = await readDoc(api, 'courseStates', courseId);
  const report = courseDoc.exists ? await api.get(`/courses/${courseId}/materials`) : null;
  const watched = new Set(watchedIdsOf(courseDoc.value) ?? []);
  const dropped = new Set(prepared.progress.dropped);
  const lost = (prepared.currentWatched ?? []).filter((id) => !dropped.has(id) && !watched.has(id));
  return {
    course: { exists: courseDoc.exists, rev: courseDoc.rev, digest: courseDoc.digest, matchesExpected: courseDoc.digest === prepared.expectedDigest, hasProgress: Boolean(courseDoc.value?.progress), watched: watched.size, watchedLost: lost.length, stats: courseDoc.value ? courseDocumentStats(courseDoc.value) : null },
    attachments: { exists: attachments.exists, rev: attachments.rev, count: Object.keys(attachments.value?.refs ?? {}).length, digest: refsDigest(attachments.value?.refs ?? {}) },
    courseStates: { exists: states.exists, rev: states.rev, digest: states.digest, unchanged: states.rev === prepared.before.courseStates.rev && states.digest === prepared.before.courseStates.digest },
    report: report?.status === 200 ? summarizeReport(report.json) : null,
    missing: report?.status === 200 ? report.json.missing : null,
    unmatched: report?.status === 200 ? report.json.unmatched : null,
  };
}

function describeError(error) {
  if (error instanceof WorkerError) return { code: error.code, message: error.message, ...error.detail };
  return { code: error?.code ?? error?.name ?? 'unexpected', message: 'Erro inesperado no trabalhador remoto.', errno: error?.errno ?? null };
}

// `deps` existe para os testes: `emit` recebe cada evento, `owner` substitui o
// `id -u/-g` e `requestImpl` o http do node.
export async function runWorker(payload, { emit = () => {}, owner = null, requestImpl } = {}) {
  const startedAt = new Date().toISOString();
  const result = { format: WORKER_FORMAT, runId: payload?.runId ?? null, mode: payload?.mode ?? null, startedAt, finishedAt: null, ok: false, error: null, step: 'validate', mutated: false, server: null, limits: null, space: null, backup: null, courses: [] };
  const log = (message, extra = {}) => emit('log', { message, ...extra });
  try {
    validatePayload(payload);
    result.step = 'service';
    const service = await loadServiceEnv(payload.remote, payload);
    result.limits = { effective: service.limits, sources: service.limitSources, file: service.limitsFile };
    const resolvedOwner = owner ?? serviceOwner(payload.remote.serviceUser);
    const dataInfo = await lstatOrNull(service.dataDir);
    if (!dataInfo?.isDirectory()) throw new WorkerError('data_dir_missing', 'O diretório de dados do serviço não existe.');
    if (dataInfo.uid !== resolvedOwner.uid) throw new WorkerError('service_user_mismatch', 'O diretório de dados não é do usuário do serviço configurado.');
    service.realDataDir = await realpath(service.dataDir);
    const api = createApiClient({ host: service.host, port: service.port, basePath: service.basePath, login: service.login, origin: service.origin, requestImpl });
    const health = await api.get('/health');
    if (health.status !== 200 || health.json?.ok !== true) throw apiError('health', health);
    result.server = { apiVersion: health.json.apiVersion, version: health.json.version ?? null, mode: health.json.mode, dataId: health.json.dataId, cursorBefore: health.json.cursor, cursorAfter: null, freeBytes: health.json.storage?.freeBytes ?? null, appCommit: checkoutCommit(payload.remote.appDir) };
    const runId = String(payload.runId ?? '').replace(/[^A-Za-z0-9-]/g, '') || randomBytes(4).toString('hex');
    const context = { api, payload, service, owner: resolvedOwner, runId, emit: (type, data) => emit(type, data) };

    result.step = 'preflight';
    const prepared = [];
    for (const [index, course] of payload.courses.entries()) {
      log('pré-checagem do curso', { course: index + 1, courseId: course.courseId });
      prepared.push(await preflightCourse(context, course, index));
    }
    result.courses = prepared.map((item) => ({
      courseId: item.course.courseId,
      includeProgress: item.includeProgress,
      expected: { ...item.course.expected, mergedDigest: item.expectedDigest },
      progress: item.progress,
      dryRun: item.dryRun,
      before: { ...item.before, attachments: { exists: item.before.attachments.exists, rev: item.before.attachments.rev, count: Object.keys(item.before.attachments.refs).length, digest: item.before.attachments.digest } },
      source: sourceSummary(item),
      conversion: { planned: item.conversion },
    }));
    const sourceProblems = prepared.flatMap((item) => item.sourceBlockers.map((blocker) => ({ courseId: item.course.courseId, ...blocker })));
    const blockers = prepared.flatMap((item) => item.limits.blockers.map((blocker) => ({ courseId: item.course.courseId, ...blocker })));
    const rejected = prepared.flatMap((item) => item.plan.rejected.map((entry) => ({ courseId: item.course.courseId, name: entry.name })));
    if (sourceProblems.length > 0) throw new WorkerError('source_refused', 'Há arquivos na pasta de material que não podem ir para a pasta de entrada (nome inválido ou pasta funda demais); nada foi alterado.', { problems: sourceProblems });
    if (blockers.length > 0) throw new WorkerError('limits_exceeded', 'A pasta de entrada de algum curso passaria dos limites do servidor; nada foi alterado.', { blockers });
    if (rejected.length > 0) throw new WorkerError('name_conflict', 'Algum arquivo não ganhou nome livre na pasta de entrada; nada foi alterado.', { rejected });
    // Espaço para as cópias da pasta de entrada (o instantâneo e a cópia dele
    // são conferidos depois, quando o tamanho é conhecido).
    const copyBytes = prepared.reduce((sum, item) => sum + [...item.plan.copies, ...item.repairs].reduce((total, entry) => total + entry.size, 0), 0);
    const disk = await statfs(service.dataDir);
    result.space = { free: disk.bavail * disk.bsize, copyBytes };
    if (result.space.free < copyBytes + ARCHIVE_SPARE_BYTES) throw new WorkerError('no_space', 'Sem espaço no disco do diretório de dados para as cópias; nada foi alterado.', { ...result.space });
    if (payload.mode === 'plan') {
      result.ok = true;
      result.step = 'done';
      return result;
    }

    result.step = 'backup';
    emit('progress', { step: 'backup' });
    const backup = await api.post('/backups', { timeoutMs: LONG_TIMEOUT_MS });
    if (backup.status !== 201) throw apiError('backup', backup);
    result.backup = { name: backup.json?.name ?? null, date: backup.json?.date ?? null, size: backup.json?.size ?? null, createdAt: backup.json?.createdAt ?? null, archive: null };
    result.step = 'backup-archive';
    result.backup.archive = await archiveBackup(context, backup.json);

    for (const [index, item] of prepared.entries()) {
      const entry = result.courses[index];
      result.step = `course-${index + 1}-convert`;
      emit('progress', { step: 'convert', course: index + 1 });
      result.mutated = result.mutated || item.conversion !== 'unchanged';
      entry.conversion = { planned: item.conversion, ...(await convertCourse(context, item)) };
      result.step = `course-${index + 1}-copy`;
      emit('progress', { step: 'copy', course: index + 1, planned: item.plan.copies.length });
      result.mutated = result.mutated || item.plan.copies.length > 0 || item.repairs.length > 0 || !item.intakeExists;
      entry.copy = await copyCourseFiles(context, item, index);
      entry.copy.originalsChanged = await originalsUnchanged(item);
      result.step = `course-${index + 1}-scan`;
      emit('progress', { step: 'scan', course: index + 1 });
      result.mutated = true;
      entry.scan = await scanAndPreserve(context, item);
      result.step = `course-${index + 1}-verify`;
      entry.after = await verifyCourse(context, item);
      emit('progress', { step: 'course-done', course: index + 1, available: entry.after.report?.available ?? null, total: entry.after.report?.total ?? null });
    }
    const health2 = await api.get('/health');
    if (health2.status === 200) result.server.cursorAfter = health2.json.cursor;
    result.ok = true;
    result.step = 'done';
    return result;
  } catch (error) {
    result.error = { step: result.step, ...describeError(error) };
    return result;
  } finally {
    result.finishedAt = new Date().toISOString();
  }
}

// Ponto de entrada remoto: uma linha JSON por evento, a última é o resultado.
export async function runWorkerMain(payload) {
  const write = (type, data) => process.stdout.write(`${JSON.stringify({ t: type, at: new Date().toISOString(), ...data })}\n`);
  const result = await runWorker(payload, { emit: write });
  write('result', { result });
  return result.ok ? 0 : 1;
}
