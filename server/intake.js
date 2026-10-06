// Pasta de entrada do curso e casamento com os materiais (rodada 6, etapa 8 / B4b).
//
// Cada curso tem `<dataDir>/entrada/<courseId>/`. O usuário copia para lá (scp,
// pasta de rede) ou envia pela página do curso (arrastar vários arquivos de uma
// vez = várias chamadas de upload). O servidor:
//  1. lista a pasta (só arquivos comuns; link simbólico é pulado),
//  2. casa cada arquivo com os materiais do curso PELO NOME (tolerante),
//  3. grava os bytes no blob store existente (endereçado por sha256, dedup por
//     conteúdo: um material citado em várias aulas é guardado UMA vez),
//  4. escreve os vínculos em `courseAttachments/<courseId>` com CAS (a escrita do
//     cliente nunca é atropelada; 412 re-tenta com o corpo fresco),
//  5. devolve o relatório: disponíveis, faltantes e arquivos que não casaram,
//     com o vínculo manual.
//
// Duas portas, de propósito: `scan()` IMPORTA (grava refs e blobs) e `report()`
// só LÊ (lista, casa e relata sem tocar no disco). Quem atende GET é `report()`,
// para uma consulta de leitura não virar escrita fora do check de origem/CSRF.
//
// Nada aqui imprime nome de arquivo, caminho, sha ou login. O nome do arquivo é
// conteúdo de curso: vai só na resposta autenticada, nunca em log/estático/feed.
//
// Dependências de propósito: só node nativo + `./zip.js` e `./matching.js`
// (módulos puros). O `store` entra por injeção e é usado por uma interface
// pequena (readDoc, putDoc, entry, hasBlob, commitBlob, ensureSpace, tmpDir).

import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyFileName, courseMaterialIndex, extensionOf, FILE_KINDS, isPdfName, isZipName, memberId, parseMemberId } from './matching.js';
import { createZipBudget, readZipMembers, ZipError, ZIP_LIMITS } from './zip.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const COURSES_COLLECTION = 'courses';
export const REFS_COLLECTION = 'courseAttachments';
export const REFS_FORMAT = 'groovegoblin-course-content';

export const INTAKE_LIMITS = Object.freeze({
  maxEntries: 300,                       // arquivos na pasta entrada do curso
  maxEntryBytes: 200 * MIB,              // por arquivo (acompanha o teto de blob)
  maxZipBytes: 64 * MIB,                 // pacote que cabe na memória para abrir
  maxCourseBytes: 3 * GIB,               // soma dos arquivos da pasta
  maxZipPdfMembers: 60,                  // PDFs extraídos, cumulativo no curso
  maxZipPdfBytes: 256 * MIB,             // bytes extraídos, cumulativo no curso
  maxNameBytes: 240,
});

const COURSE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MEMBER_SEPARATOR = '::';

export class IntakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
  }
}

// Status HTTP de cada código, para a cola fina do `api.js` não repetir a tabela.
export function intakeHttpStatus(code) {
  return {
    not_found: 404,
    file_missing: 404,
    invalid_course_id: 400,
    invalid_filename: 400,
    filename_required: 400,
    invalid_ref: 400,
    unsupported_file: 400,
    six_strings: 400,
    too_large: 413,
    too_many_files: 400,
    limit_exceeded: 507,
    unsafe_dir: 500,
    state_corrupt: 500,
    busy: 503,
  }[code] ?? 500;
}

export function isIntakeError(error) {
  return error instanceof IntakeError || error?.name === 'IntakeError';
}

// O nome guardado nunca vira caminho: sem separador, sem barra invertida, sem
// caractere de controle, sem ponto inicial, sem o separador de membro de ZIP.
export function validateStoredName(value, limits = INTAKE_LIMITS) {
  if (typeof value !== 'string' || value === '') throw new IntakeError('filename_required', 'O envio precisa do nome do arquivo.');
  if (value !== value.trim()) throw new IntakeError('invalid_filename', 'O nome do arquivo começa ou termina com espaço.');
  if (Buffer.byteLength(value, 'utf8') > limits.maxNameBytes) throw new IntakeError('invalid_filename', 'O nome do arquivo é longo demais.');
  if (CONTROL.test(value)) throw new IntakeError('invalid_filename', 'O nome do arquivo tem caractere de controle.');
  if (value.includes('/') || value.includes('\\')) throw new IntakeError('invalid_filename', 'O nome do arquivo não pode ter barra.');
  if (value === '.' || value === '..' || value.startsWith('.')) throw new IntakeError('invalid_filename', 'O nome do arquivo não pode começar com ponto.');
  if (value.includes(MEMBER_SEPARATOR)) throw new IntakeError('invalid_filename', 'O nome do arquivo não pode ter "::".');
  return value;
}

export function safeCourseId(value) {
  if (typeof value !== 'string' || !COURSE_ID.test(value) || value === '.' || value === '..') {
    throw new IntakeError('invalid_course_id', 'Identificador de curso inválido.');
  }
  return value;
}

// `lstat` NUNCA seguindo link simbólico (a pasta de entrada é do usuário, mas o
// conteúdo é casado por nome e hasheado: um link apontando para fora do
// diretório não pode ser lido). `throwIfNoEntry: false` não é honrado por
// `lstat` (só por `stat`), então o "não existe" vira null aqui — sem isso um
// arquivo ausente derrubava a rota com ENOENT cru, com o caminho absoluto na
// mensagem, em vez de 404 `file_missing`.
async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function hashHandle(handle) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

function isPrecondition(error) {
  return error?.name === 'PreconditionError' || Object.hasOwn(error ?? {}, 'current');
}

function refsFrom(body) {
  if (!body) return {};
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new IntakeError('state_corrupt', 'Os vínculos deste curso estão ilegíveis no servidor; nada foi alterado.');
  }
  const refs = parsed?.refs;
  if (refs === undefined || refs === null) return {};
  if (typeof refs !== 'object' || Array.isArray(refs)) throw new IntakeError('state_corrupt', 'Os vínculos deste curso estão ilegíveis no servidor; nada foi alterado.');
  return refs;
}

export function createIntakeService({ store, root, limits = INTAKE_LIMITS, now = () => new Date() }) {
  if (!store || typeof store.readDoc !== 'function' || typeof store.putDoc !== 'function' || typeof store.hasBlob !== 'function' || typeof store.commitBlob !== 'function') {
    throw new TypeError('intake: a loja do servidor é obrigatória.');
  }
  if (typeof root !== 'string' || !root.startsWith('/')) throw new TypeError('intake: a raiz da pasta de entrada precisa ser absoluta.');
  const hashes = new Map();

  function tmpDir() {
    if (typeof store.tmpDir === 'string' && store.tmpDir.startsWith('/')) return store.tmpDir;
    throw new IntakeError('unsafe_dir', 'A pasta temporária do servidor não está disponível.');
  }

  // Com `create: false` nada é criado no disco: o relatório de leitura (GET)
  // precisa listar uma pasta que pode nem existir ainda.
  async function dirFor(courseId, { create = true } = {}) {
    const id = safeCourseId(courseId);
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const dir = join(root, id);
    const info = await lstatOrNull(dir);
    if (!info) {
      if (!create) return null;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    }
    if (!info.isDirectory()) throw new IntakeError('unsafe_dir', 'A pasta de entrada deste curso não é uma pasta comum.');
    return dir;
  }

  async function hashFile(path) {
    const info = await lstatOrNull(path);
    if (!info || !info.isFile()) throw new IntakeError('file_missing', 'O arquivo não está mais na pasta de entrada.');
    const cached = hashes.get(`${path}|${info.size}|${info.mtimeMs}`);
    if (cached !== undefined) return { sha256: cached, size: info.size };
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const sha256 = await hashHandle(handle);
      hashes.set(`${path}|${info.size}|${info.mtimeMs}`, sha256);
      if (hashes.size > 4096) hashes.clear();
      return { sha256, size: info.size };
    } finally {
      await handle.close();
    }
  }

  async function readWholeFile(path, maxBytes) {
    const info = await lstatOrNull(path);
    if (!info || !info.isFile()) throw new IntakeError('file_missing', 'O arquivo não está mais na pasta de entrada.');
    if (info.size > maxBytes) throw new IntakeError('too_large', 'O arquivo é grande demais para ser aberto como pacote.');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.allocUnsafe(info.size);
      let position = 0;
      while (position < info.size) {
        const { bytesRead } = await handle.read(buffer, position, info.size - position, position);
        if (bytesRead === 0) break;
        position += bytesRead;
      }
      return buffer.subarray(0, position);
    } finally {
      await handle.close();
    }
  }

  // Grava bytes no blob store existente. Nunca sobrescreve: o endereço é o hash.
  async function commitBytes(data, sha256) {
    if (await store.hasBlob(sha256)) return false;
    await store.ensureSpace(data.length);
    const temporary = join(tmpDir(), `intake-${randomBytes(8).toString('hex')}`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await store.commitBlob(temporary, sha256, data.length);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return true;
  }

  async function commitFile(path, sha256, size) {
    if (await store.hasBlob(sha256)) return false;
    await store.ensureSpace(size);
    const temporary = join(tmpDir(), `intake-${randomBytes(8).toString('hex')}`);
    await copyFile(path, temporary);
    try {
      await store.commitBlob(temporary, sha256, size);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return true;
  }

  async function loadCourse(courseId) {
    const id = safeCourseId(courseId);
    const { entry, body } = await store.readDoc(COURSES_COLLECTION, id);
    if (!entry || entry.deleted || !body) throw new IntakeError('not_found', 'Este curso não está no servidor.');
    let document;
    try {
      document = JSON.parse(body.toString('utf8'));
    } catch {
      throw new IntakeError('state_corrupt', 'O documento deste curso está ilegível no servidor.');
    }
    return courseMaterialIndex(document, id);
  }

  async function readRefs(courseId) {
    const { entry, body } = await store.readDoc(REFS_COLLECTION, courseId);
    if (!entry || entry.deleted || !body) return { entry: entry ?? null, refs: {} };
    return { entry, refs: refsFrom(body) };
  }

  // Read-modify-write com CAS: o corpo fresco é relido a cada tentativa, então
  // uma escrita do cliente no meio do caminho nunca é perdida.
  async function writeRefs(courseId, patch) {
    const keys = Object.keys(patch);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await readRefs(courseId);
      let changed = false;
      for (const key of keys) {
        const next = patch[key];
        const previous = current.refs[key];
        if (previous && previous.sha256 === next.sha256 && previous.kind === next.kind && previous.size === next.size) continue;
        current.refs[key] = next;
        changed = true;
      }
      if (!changed) return current.refs;
      const alive = current.entry && !current.entry.deleted;
      const body = Buffer.from(JSON.stringify({ refs: current.refs }));
      try {
        await store.putDoc(REFS_COLLECTION, courseId, body, alive ? { ifMatch: current.entry.rev } : { ifNoneMatch: true });
        return current.refs;
      } catch (error) {
        if (!isPrecondition(error)) throw error;
      }
    }
    throw new IntakeError('busy', 'Não foi possível gravar os vínculos agora; tente de novo.');
  }

  // Shape acordado com a etapa 7 (R6Sync): o mesmo do anexo local do cliente.
  function refEntry(sha256, size, kind, name) {
    return { sha256, size, kind, name, addedAt: now().toISOString() };
  }

  function unmatchedEntry(id, name, size, reason, insideZip = null, detail = null) {
    return { id, name, extension: extensionOf(name), size, reason, insideZip, detail };
  }

  async function indexFolder(courseId, index, budget, { apply = true } = {}) {
    const dir = await dirFor(courseId, { create: apply });
    const stats = { files: 0, scanned: 0, skipped: 0, sixStrings: 0, unsupported: 0, bytes: 0 };
    const zipStats = { archives: 0, entries: 0, pdfMembers: 0, bytes: 0 };
    const unmatched = [];
    const discovered = {};
    const matched = {};
    if (!dir) return { stats, zipStats, unmatched, discovered, matched };
    const names = (await readdir(dir, { withFileTypes: true }))
      .filter((item) => item.isFile())
      .map((item) => item.name)
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    stats.files = names.length;
    if (names.length > limits.maxEntries) throw new IntakeError('too_many_files', `Esta pasta de entrada passa de ${limits.maxEntries} arquivos.`);
    for (const name of names) {
      const path = join(dir, name);
      const info = await lstatOrNull(path);
      if (!info || !info.isFile()) { stats.skipped += 1; continue; }
      stats.scanned += 1;
      stats.bytes += info.size;
      if (stats.bytes > limits.maxCourseBytes) throw new IntakeError('limit_exceeded', 'A pasta de entrada deste curso passa do tamanho aceito.');
      let stored;
      try {
        stored = validateStoredName(name, limits);
      } catch {
        unmatched.push(unmatchedEntry(name, name, info.size, 'invalid'));
        continue;
      }
      if (info.size > limits.maxEntryBytes) { unmatched.push(unmatchedEntry(stored, stored, info.size, 'too-large')); continue; }
      const kind = classifyFileName(stored);
      if (kind === FILE_KINDS.sixStrings) { stats.sixStrings += 1; unmatched.push(unmatchedEntry(stored, stored, info.size, 'six-strings')); continue; }
      if (kind === FILE_KINDS.invalid) { unmatched.push(unmatchedEntry(stored, stored, info.size, 'invalid')); continue; }
      if (kind === FILE_KINDS.zip) {
        zipStats.archives += 1;
        await indexZip(index, stored, path, info.size, { zipStats, unmatched, discovered, matched, budget, apply });
        continue;
      }
      if (kind !== FILE_KINDS.pdf && kind !== FILE_KINDS.audio) { stats.unsupported += 1; unmatched.push(unmatchedEntry(stored, stored, info.size, 'unsupported')); continue; }
      const matches = index.match(stored);
      if (matches.length === 0) { unmatched.push(unmatchedEntry(stored, stored, info.size, 'no-material')); continue; }
      matched[stored] = matches.map((material) => material.refKey);
      if (!apply) continue; // leitura: nada de hash, nada de blob
      const { sha256 } = await hashFile(path);
      await commitFile(path, sha256, info.size);
      for (const material of matches) discovered[material.refKey] = refEntry(sha256, info.size, kind, stored);
    }
    return { stats, zipStats, unmatched, discovered, matched };
  }

  async function indexZip(index, zipName, path, size, { zipStats, unmatched, discovered, matched, budget, apply = true }) {
    let buffer;
    try {
      buffer = await readWholeFile(path, limits.maxZipBytes);
    } catch (error) {
      if (isIntakeError(error) && error.code === 'too_large') { unmatched.push(unmatchedEntry(zipName, zipName, size, 'too-large')); return; }
      throw error;
    }
    let result;
    try {
      result = await readZipMembers(buffer, { limits: ZIP_LIMITS, budget, accept: isPdfName });
    } catch (error) {
      if (error instanceof ZipError) {
        if (error.code === 'budget') throw error;
        unmatched.push(unmatchedEntry(zipName, zipName, size, 'invalid', null, error.code));
        return;
      }
      throw error;
    }
    zipStats.entries += result.entries;
    // O pacote em si também é material do curso ("pacote de exercícios"): fica
    // guardado como arquivo para download, e os PDFs de dentro casam um a um.
    const packageMatches = index.match(zipName).filter((material) => material.role === 'pacote de exercícios');
    if (packageMatches.length > 0) {
      matched[zipName] = packageMatches.map((material) => material.refKey);
      if (apply) {
        const hashed = await hashFile(path);
        await commitFile(path, hashed.sha256, size);
        for (const material of packageMatches) discovered[material.refKey] = refEntry(hashed.sha256, size, 'other', zipName);
      }
    }
    let bound = packageMatches.length;
    for (const member of result.members) {
      const id = memberId(zipName, member.name);
      if (member.invalid || !member.data) { unmatched.push(unmatchedEntry(id, member.name, 0, 'invalid', zipName, 'not-pdf')); continue; }
      zipStats.pdfMembers += 1;
      zipStats.bytes += member.data.length;
      const matches = index.match(member.name);
      if (matches.length === 0) { unmatched.push(unmatchedEntry(id, member.name, member.data.length, 'no-material', zipName)); continue; }
      matched[id] = matches.map((material) => material.refKey);
      bound += 1;
      if (!apply) continue; // leitura: nada de hash, nada de blob
      const sha256 = createHash('sha256').update(member.data).digest('hex');
      await commitBytes(member.data, sha256);
      for (const material of matches) discovered[material.refKey] = refEntry(sha256, member.data.length, 'pdf', member.name);
    }
    if (bound === 0) unmatched.push(unmatchedEntry(zipName, zipName, size, 'no-material', null, 'zip'));
  }

  async function buildReport(courseId, index, refs, scan) {
    const stored = new Set(Object.values(refs).map((ref) => ref?.sha256).filter((sha) => typeof sha === 'string' && SHA256.test(sha)));
    const present = new Map();
    for (const sha of stored) present.set(sha, await store.hasBlob(sha));
    const missing = [];
    let available = 0;
    let missingBlobs = 0;
    let refCount = 0;
    const keys = new Set(index.list.map((material) => material.refKey));
    for (const material of index.list) {
      const ref = refs[material.refKey];
      const healthy = ref && SHA256.test(ref.sha256 ?? '') && present.get(ref.sha256) === true;
      if (healthy) available += 1;
      else {
        missing.push({ refKey: material.refKey, lessonId: material.lessonId, resourceId: material.resourceId, name: material.name, role: material.role, extension: material.extension });
        if (ref) missingBlobs += 1;
      }
    }
    for (const key of Object.keys(refs)) if (keys.has(key)) refCount += 1;
    return {
      courseId,
      format: REFS_FORMAT,
      total: index.total,
      available,
      refs: refCount,
      missingBlobs,
      missing,
      unmatched: scan.unmatched,
      files: scan.stats,
      zip: scan.zipStats,
    };
  }

  async function runScan(courseId, { apply = true } = {}) {
    const index = await loadCourse(courseId);
    const budget = createZipBudget({ maxFiles: limits.maxZipPdfMembers, maxBytes: limits.maxZipPdfBytes });
    let scan;
    try {
      scan = await indexFolder(courseId, index, budget, { apply });
    } catch (error) {
      if (error instanceof ZipError && error.code === 'budget') throw new IntakeError('limit_exceeded', 'Os pacotes deste curso já passaram do número de PDFs aceito.');
      throw error;
    }
    // A leitura usa os vínculos que JÁ estão no servidor: uma consulta GET não
    // grava vínculo nenhum. Quem importa (e grava) é o POST.
    const refs = apply ? await writeRefs(courseId, scan.discovered) : (await readRefs(courseId)).refs;
    const report = await buildReport(courseId, index, refs, scan);
    return { index, refs, scan, report };
  }

  function validateUploadKind(name, kind) {
    if (kind === FILE_KINDS.sixStrings) throw new IntakeError('six_strings', 'Este arquivo é de 6 cordas; o app toca baixo de 4 ou 5.');
    if (kind === FILE_KINDS.invalid || kind === FILE_KINDS.other) throw new IntakeError('unsupported_file', 'Só PDF, áudio do curso e ZIP de PDFs entram na pasta de entrada.');
    return kind;
  }

  async function moveInto(source, target) {
    try {
      await rename(source, target);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await copyFile(source, target);
      await unlink(source).catch(() => {});
    }
  }

  async function resolveFile(courseId, id) {
    const dir = await dirFor(courseId);
    const member = parseMemberId(id);
    if (member) {
      const zipName = validateStoredName(member.zipName, limits);
      if (!isZipName(zipName) || classifyFileName(zipName) !== FILE_KINDS.zip) throw new IntakeError('unsupported_file', 'O pacote indicado não é um ZIP aceito.');
      const path = join(dir, zipName);
      const info = await lstatOrNull(path);
      if (!info || !info.isFile()) throw new IntakeError('file_missing', 'O arquivo não está mais na pasta de entrada.');
      const buffer = await readWholeFile(path, limits.maxZipBytes);
      let result;
      try {
        result = await readZipMembers(buffer, { limits: ZIP_LIMITS, budget: null, accept: (name) => name === member.memberName });
      } catch (error) {
        if (error instanceof ZipError) throw new IntakeError('unsupported_file', 'O pacote não pôde ser lido para vincular este PDF.');
        throw error;
      }
      const found = result.members.find((item) => item.name === member.memberName && item.data);
      if (!found) throw new IntakeError('file_missing', 'Este PDF não está mais dentro do pacote.');
      return { path: null, data: found.data, size: found.data.length, kind: 'pdf', displayName: member.memberName };
    }
    const name = validateStoredName(id, limits);
    const kind = classifyFileName(name);
    if (kind === FILE_KINDS.sixStrings) throw new IntakeError('six_strings', 'Este arquivo é de 6 cordas; o app toca baixo de 4 ou 5.');
    if (kind !== FILE_KINDS.pdf && kind !== FILE_KINDS.audio) throw new IntakeError('unsupported_file', 'Só PDF ou áudio do curso podem ser vinculados a um material.');
    const path = join(dir, name);
    const info = await lstatOrNull(path);
    if (!info || !info.isFile()) throw new IntakeError('file_missing', 'O arquivo não está mais na pasta de entrada.');
    if (info.size > limits.maxEntryBytes) throw new IntakeError('too_large', 'O arquivo passa do tamanho aceito.');
    return { path, data: null, size: info.size, kind, displayName: name };
  }

  // Somente leitura: lista a pasta, casa por nome e relata, sem gravar vínculo
  // nem blob (é o que o GET usa; nada aqui toca no disco).
  async function report(courseId) {
    return (await runScan(safeCourseId(courseId), { apply: false })).report;
  }

  // Importa de verdade: grava os vínculos que faltam e os blobs que ainda não
  // existem, e devolve o mesmo relatório. É a única porta que casa a pasta com
  // os materiais (POST, atrás do check de origem/CSRF).
  async function scan(courseId) {
    return (await runScan(safeCourseId(courseId), { apply: true })).report;
  }

  // O upload chega como arquivo temporário já recebido e sincronizado pelo
  // chamador; vira arquivo da pasta de entrada por rename atômico.
  async function upload(courseId, { name, path }) {
    const id = safeCourseId(courseId);
    await loadCourse(id);
    const stored = validateStoredName(name, limits);
    const kind = validateUploadKind(stored, classifyFileName(stored));
    const info = await lstatOrNull(path);
    if (!info || !info.isFile()) throw new IntakeError('invalid_filename', 'O envio não chegou como um arquivo.');
    if (info.size > limits.maxEntryBytes) throw new IntakeError('too_large', 'O arquivo passa do tamanho aceito.');
    await store.ensureSpace(info.size);
    const dir = await dirFor(id);
    await moveInto(path, join(dir, stored));
    hashes.clear();
    const outcome = await runScan(id);
    return {
      ok: true,
      stored: {
        id: stored,
        name: stored,
        size: info.size,
        kind,
        matched: outcome.scan.matched[stored] ?? [],
        unmatched: outcome.scan.matched[stored] === undefined,
      },
      report: outcome.report,
    };
  }

  // Vínculo manual: o usuário escolhe um arquivo que não casou (ou um membro de
  // ZIP) e o material correspondente. O arquivo é hasheado e vai para o blob
  // store antes de o vínculo ser escrito.
  async function bind(courseId, { refKey, id }) {
    const course = safeCourseId(courseId);
    if (typeof refKey !== 'string' || refKey === '') throw new IntakeError('invalid_ref', 'Escolha o material a vincular.');
    if (typeof id !== 'string' || id === '') throw new IntakeError('file_missing', 'Escolha o arquivo a vincular.');
    const index = await loadCourse(course);
    const material = index.byRefKey(refKey);
    if (!material) throw new IntakeError('invalid_ref', 'Este vínculo não é um material deste curso.');
    const resolved = await resolveFile(course, id);
    let sha256;
    if (resolved.data) {
      sha256 = createHash('sha256').update(resolved.data).digest('hex');
      await commitBytes(resolved.data, sha256);
    } else {
      const hashed = await hashFile(resolved.path);
      sha256 = hashed.sha256;
      await commitFile(resolved.path, sha256, resolved.size);
    }
    const current = await readRefs(course);
    const previous = current.refs[refKey];
    if (previous && previous.sha256 === sha256) {
      return { ok: true, unchanged: true, ref: previous, report: (await report(course)) };
    }
    const refs = await writeRefs(course, { [refKey]: refEntry(sha256, resolved.size, resolved.kind, resolved.displayName) });
    return { ok: true, unchanged: false, ref: refs[refKey], report: await report(course) };
  }

  return { report, scan, upload, bind, dirFor, limits: Object.freeze({ ...limits }) };
}
