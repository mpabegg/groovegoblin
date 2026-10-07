// Rotas /api/*. Ordem fixa por chamada: caminho cru estrito → autenticação →
// rota → método → consulta → corpo. Nada de rota é revelado antes de autenticar.

import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { convertCourseMap } from '../scripts/convert-course-map.js';
import { serializeCourse } from '../src/course-format.js';
import { authenticate } from './auth.js';
import { blobCsp, blobDisposition, parseRange, receiveBlob, sniffBlob, SNIFF_BYTES } from './blobs.js';
import { backupBytes, createDailyBackup, dailyName, downloadName, listBackups, MAX_RECORD_BYTES } from './backup.js';
import { StorageError, openRead, removeQuiet } from './fsutil.js';
import { HttpError, apiHeaders, readJson, requireContentType, sendError, sendJson } from './http.js';
import { INTAKE_LIMITS, createIntakeService, intakeHttpStatus, isIntakeError } from './intake.js';
import { COLLECTIONS, PRIVATE_NAMES, PreconditionError, SHA256_PATTERN, isValidId } from './store.js';

export const API_VERSION = 1;
const MIB = 1024 * 1024;
export const LIMITS = Object.freeze({ doc: 4 * MIB, course: MAX_RECORD_BYTES, private: MAX_RECORD_BYTES, convert: 32 * MIB, changes: 1000, changesDefault: 500 });
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const REV = /^[1-9]\d{0,15}$/;
const IF_MATCH = /^"([1-9]\d{0,15})"$/;
const CURSOR = /^([0-9a-f]{16})\.(0|[1-9]\d{0,15})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONVERT_KEYS = new Set(['map', 'catalog', 'includeProgress', 'dryRun', 'expectedRev']);

function notFound() {
  return new HttpError(404, 'not_found', 'Recurso não encontrado.');
}

function methodNotAllowed(allowed) {
  return new HttpError(405, 'method_not_allowed', 'Método não permitido nesta rota.', {}, { Allow: allowed.join(', ') });
}

// Caminho cru, antes de qualquer decodificação ou normalização da URL.
function parseApiPath(rawPath, prefix) {
  const rest = rawPath.slice(prefix.length);
  if (rest === '') return [];
  if (!rest.startsWith('/') || rest.endsWith('/') || rest.includes('//') || /[%\\]/.test(rest)) return null;
  const segments = rest.slice(1).split('/');
  if (segments.some((segment) => !SEGMENT.test(segment) || segment === '.' || segment === '..')) return null;
  return segments;
}

function parseQuery(rawQuery, allowed) {
  const params = new URLSearchParams(rawQuery);
  const values = {};
  for (const [key, value] of params) {
    if (!allowed.includes(key) || Object.hasOwn(values, key)) throw new HttpError(400, 'invalid_query', 'Parâmetro de consulta desconhecido ou repetido.');
    values[key] = value;
  }
  return values;
}

function canonicalJson(value) {
  try {
    return Buffer.from(JSON.stringify(value));
  } catch {
    throw new HttpError(400, 'invalid_json', 'JSON aninhado demais.');
  }
}

function etag(value) {
  return `"${value}"`;
}

function conditionMatches(header, tag) {
  if (header === undefined) return false;
  return header.split(',').map((item) => item.trim()).some((item) => item === '*' || item === tag || item === `W/${tag}`);
}

function docSummary(collection, id, entry) {
  return { collection, id, rev: entry.rev, deleted: Boolean(entry.deleted), updatedAt: entry.updatedAt, size: entry.deleted ? 0 : entry.size };
}

function preconditionFailed(error) {
  const current = error.current;
  return new HttpError(412, 'precondition_failed', 'O documento mudou no servidor (revisão diferente da enviada).', {
    current: current ? { rev: current.rev, deleted: Boolean(current.deleted) } : null,
  }, current ? { ETag: etag(current.rev), 'X-Groove-Rev': current.rev } : {});
}

// convertMap: o conversor do repositório; parâmetro só para os testes poderem
// observar o que chega a ele (nunca um parser alternativo).
export function createApiHandler({ store, auth, basePath, maxBlobBytes, backupKeep, mode, version, log, convertMap = convertCourseMap, intakeLimits = INTAKE_LIMITS }) {
  const prefix = `${basePath}api`;
  const context = { hsts: mode === 'tailscale' };

  // Preguiçoso de propósito: se a pasta de entrada não estiver disponível, só as
  // rotas de material falham — o resto da API continua de pé.
  let intake = null;
  function intakeService() {
    if (intake === null) intake = createIntakeService({ store, root: store.intakeDir, limits: intakeLimits, now: () => store.now() });
    return intake;
  }

  // ── rotas ────────────────────────────────────────────────────────────────
  async function health(request, response) {
    const counts = store.counts();
    const backups = await listBackups(store);
    const backupTotal = await backupBytes(store);
    const freeBytes = await store.freeBytes();
    sendJson(response, context, 200, {
      ok: true,
      service: 'groovegoblin',
      apiVersion: API_VERSION,
      version,
      time: store.now().toISOString(),
      mode,
      dataId: store.dataId,
      cursor: store.cursor(),
      storage: {
        usedBytes: counts.docBytes + counts.blobBytes + counts.privateBytes + backupTotal,
        freeBytes,
        docBytes: counts.docBytes,
        blobBytes: counts.blobBytes,
        privateBytes: counts.privateBytes,
        backupBytes: backupTotal,
        docs: counts.docs,
        tombstones: counts.tombstones,
        blobs: counts.blobs,
        maxBlobBytes,
        missingObjects: counts.missingObjects,
      },
      backups: { count: backups.length, latest: backups[0]?.date ?? null },
      private: store.privateFlags(),
    });
  }

  async function getDoc(request, response, collection, id) {
    const { entry, body } = await store.readDoc(collection, id);
    if (!entry) throw notFound();
    if (entry.deleted) throw new HttpError(404, 'not_found', 'Documento apagado.', { deleted: true, rev: entry.rev }, { ETag: etag(entry.rev), 'X-Groove-Rev': entry.rev });
    const tag = etag(entry.rev);
    if (conditionMatches(request.headers['if-none-match'], tag)) {
      response.writeHead(304, apiHeaders(context, { ETag: tag, 'X-Groove-Rev': entry.rev }));
      response.end();
      return;
    }
    response.writeHead(200, apiHeaders(context, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      ETag: tag,
      'X-Groove-Rev': entry.rev,
    }));
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  function readPrecondition(request, { allowCreate }) {
    const ifMatch = request.headers['if-match'];
    const ifNoneMatch = request.headers['if-none-match'];
    if (ifMatch !== undefined && ifNoneMatch !== undefined) throw new HttpError(400, 'invalid_precondition', 'Use If-Match OU If-None-Match, não os dois.');
    if (ifMatch !== undefined) {
      const match = IF_MATCH.exec(ifMatch);
      if (!match) throw new HttpError(400, 'invalid_precondition', 'If-Match precisa ser uma revisão entre aspas, ex.: "12".');
      return { ifMatch: match[1] };
    }
    if (ifNoneMatch !== undefined && allowCreate) {
      if (ifNoneMatch !== '*') throw new HttpError(400, 'invalid_precondition', 'Para criar use If-None-Match: *.');
      return { ifNoneMatch: true };
    }
    throw new HttpError(428, 'precondition_required', allowCreate
      ? 'Envie If-Match: "<rev>" para atualizar ou If-None-Match: * para criar.'
      : 'Envie If-Match: "<rev>" para apagar.');
  }

  async function putDoc(request, response, collection, id) {
    const precondition = readPrecondition(request, { allowCreate: true });
    const value = await readJson(request, collection === 'courses' ? LIMITS.course : LIMITS.doc);
    const body = canonicalJson(value);
    let result;
    try {
      result = await store.putDoc(collection, id, body, precondition);
    } catch (error) {
      if (error instanceof PreconditionError) throw preconditionFailed(error);
      throw error;
    }
    sendJson(response, context, result.created ? 201 : 200, { ...docSummary(collection, id, result.entry), cursor: store.cursor() }, { ETag: etag(result.entry.rev), 'X-Groove-Rev': result.entry.rev });
  }

  async function deleteDoc(request, response, collection, id) {
    const { ifMatch } = readPrecondition(request, { allowCreate: false });
    let result;
    try {
      result = await store.deleteDoc(collection, id, { ifMatch });
    } catch (error) {
      if (error instanceof PreconditionError) throw preconditionFailed(error);
      throw error;
    }
    if (!result.deleted) {
      if (result.entry?.deleted) throw new HttpError(404, 'not_found', 'Documento já apagado.', { deleted: true, rev: result.entry.rev }, { ETag: etag(result.entry.rev), 'X-Groove-Rev': result.entry.rev });
      throw notFound();
    }
    sendJson(response, context, 200, { ...docSummary(collection, id, result.entry), cursor: store.cursor() }, { ETag: etag(result.entry.rev), 'X-Groove-Rev': result.entry.rev });
  }

  function changes(request, response, query) {
    let since = 0;
    if (query.since !== undefined) {
      const match = CURSOR.exec(query.since);
      if (!match) throw new HttpError(400, 'invalid_cursor', 'Cursor inválido.');
      if (match[1] !== store.dataId || Number(match[2]) > store.seq) {
        throw new HttpError(410, 'cursor_reset', 'Este cursor é de outro conjunto de dados; sincronize tudo de novo (sem since).');
      }
      since = Number(match[2]);
      if (since > 0 && since < store.floor) throw new HttpError(410, 'cursor_expired', 'Cursor antigo demais (lápides já podadas); sincronize tudo de novo.');
    }
    let limit = LIMITS.changesDefault;
    if (query.limit !== undefined) {
      if (!/^[1-9]\d{0,3}$/.test(query.limit) || Number(query.limit) > LIMITS.changes) throw new HttpError(400, 'invalid_query', `limit precisa estar entre 1 e ${LIMITS.changes}.`);
      limit = Number(query.limit);
    }
    const { items, more } = store.changes(since, limit);
    const cursor = more ? store.cursor(items.at(-1).seq) : store.cursor();
    sendJson(response, context, 200, { cursor, more, changes: items.map((item) => docSummary(item.collection, item.id, item.entry)) });
  }

  async function putBlob(request, response, sha) {
    requireContentType(request, 'application/octet-stream');
    if (await store.hasBlob(sha)) {
      const declared = request.headers['content-length'];
      sendJson(response, context, 200, { sha256: sha, created: false }, request.complete || declared === '0' ? {} : { Connection: 'close' });
      return;
    }
    // O 413 (declarado) e a reserva de disco acontecem dentro de receiveBlob:
    // sem Content-Length (chunked) a reserva é o TETO INTEIRO do blob, e as
    // reservas em voo são contadas, para nunca gravar por cima da reserva.
    const received = await receiveBlob(request, {
      tmpDir: store.tmpDir,
      maxBytes: maxBlobBytes,
      reserveSpace: (bytes) => store.reserveSpace(bytes),
    });
    if (received.sha256 !== sha) {
      await removeQuiet(received.path);
      throw new HttpError(400, 'hash_mismatch', 'O conteúdo enviado não tem o sha256 do endereço.');
    }
    const { created } = await store.commitBlob(received.path, sha, received.size);
    sendJson(response, context, created ? 201 : 200, { sha256: sha, size: received.size, type: received.kind.type, created });
  }

  async function getBlob(request, response, sha) {
    const opened = await store.openBlob(sha);
    if (!opened) throw notFound();
    const { handle, size } = opened;
    let handed = false;
    try {
      const head = Buffer.alloc(Math.min(SNIFF_BYTES, size));
      if (head.length > 0) await handle.read(head, 0, head.length, 0);
      const kind = sniffBlob(head);
      const tag = etag(sha);
      const headers = apiHeaders(context, {
        'Content-Type': kind.type,
        'Content-Disposition': blobDisposition(sha, kind),
        'Content-Security-Policy': blobCsp(kind),
        'Accept-Ranges': 'bytes',
        ETag: tag,
      });
      if (conditionMatches(request.headers['if-none-match'], tag)) {
        response.writeHead(304, headers);
        response.end();
        return;
      }
      const ifRange = request.headers['if-range'];
      const range = ifRange === undefined || ifRange === tag ? parseRange(request.headers.range, size) : null;
      if (range?.unsatisfiable) {
        response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' });
        response.end();
        return;
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      const length = size === 0 ? 0 : end - start + 1;
      response.writeHead(range ? 206 : 200, {
        ...headers,
        'Content-Length': String(length),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      });
      if (request.method === 'HEAD' || length === 0) {
        response.end();
        return;
      }
      handed = true;
      const stream = handle.createReadStream({ start, end, autoClose: true });
      await pipeline(stream, response).catch(() => {});
    } finally {
      if (!handed) await handle.close().catch(() => {});
    }
  }

  async function deleteBlob(request, response, sha) {
    if (!(await store.deleteBlob(sha))) throw notFound();
    sendJson(response, context, 200, { sha256: sha, deleted: true });
  }

  async function getPrivate(request, response, name) {
    const stored = await store.readPrivate(name);
    if (!stored) throw notFound();
    response.writeHead(200, apiHeaders(context, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(stored.body.length),
      'Content-Disposition': `attachment; filename="groovegoblin-private-${name}.json"`,
      ETag: etag(stored.entry.sha256),
    }));
    response.end(request.method === 'HEAD' ? undefined : stored.body);
  }

  async function putPrivate(request, response, name) {
    const value = await readJson(request, LIMITS.private, { object: false });
    const { entry, created } = await store.putPrivate(name, canonicalJson(value));
    sendJson(response, context, created ? 201 : 200, { name, size: entry.size, sha256: entry.sha256, updatedAt: entry.updatedAt });
  }

  async function deletePrivate(request, response, name) {
    if (!(await store.deletePrivate(name))) throw notFound();
    sendJson(response, context, 200, { name, deleted: true });
  }

  async function storedJson(name) {
    const stored = await store.readPrivate(name);
    return stored ? JSON.parse(stored.body.toString('utf8')) : undefined;
  }

  async function convert(request, response) {
    const body = await readJson(request, LIMITS.convert);
    for (const key of Object.keys(body)) {
      if (!CONVERT_KEYS.has(key)) throw new HttpError(400, 'bad_request', 'Campo desconhecido no pedido de conversão.', { field: key });
    }
    const includeProgress = body.includeProgress ?? false;
    const dryRun = body.dryRun ?? false;
    if (typeof includeProgress !== 'boolean' || typeof dryRun !== 'boolean') throw new HttpError(400, 'bad_request', 'includeProgress e dryRun precisam ser booleanos.');
    if (body.expectedRev !== undefined && (typeof body.expectedRev !== 'string' || !REV.test(body.expectedRev))) {
      throw new HttpError(400, 'bad_request', 'expectedRev precisa ser uma revisão (texto com dígitos).');
    }
    const hasMap = Object.hasOwn(body, 'map');
    if (hasMap && (body.map === null || typeof body.map !== 'object' || Array.isArray(body.map))) throw new HttpError(400, 'bad_request', 'map precisa ser o objeto JSON do mapa.');
    const hasCatalog = Object.hasOwn(body, 'catalog') && body.catalog !== null;
    // Teto individual (16 MiB) de map/catalog ANTES de qualquer gravação
    // privada: um pedido grande demais não pode envenenar o privado guardado
    // (nem o arquivo de backup) — o teto do envelope (32 MiB) não é o do registro.
    const mapBody = hasMap ? canonicalJson(body.map) : null;
    if (mapBody && mapBody.length > LIMITS.private) {
      throw new HttpError(413, 'payload_too_large', `O mapa passa do teto de ${LIMITS.private} bytes do arquivo privado.`, { limit: LIMITS.private });
    }
    const catalogBody = hasCatalog ? canonicalJson(body.catalog) : null;
    if (catalogBody && catalogBody.length > LIMITS.private) {
      throw new HttpError(413, 'payload_too_large', `O catálogo passa do teto de ${LIMITS.private} bytes do arquivo privado.`, { limit: LIMITS.private });
    }
    const sources = {};

    let map = body.map;
    if (hasMap) {
      if (!dryRun) await store.putPrivate('map', mapBody);
      sources.map = dryRun ? 'provided' : 'stored';
    } else {
      map = await storedJson('map');
      if (map === undefined) throw new HttpError(404, 'private_missing', 'Nenhum mapa enviado nem guardado no servidor.');
      sources.map = 'reused';
    }
    let catalog;
    if (hasCatalog) {
      catalog = body.catalog;
      if (!dryRun) await store.putPrivate('catalog', catalogBody);
      sources.catalog = dryRun ? 'provided' : 'stored';
    } else if (!Object.hasOwn(body, 'catalog')) {
      catalog = await storedJson('catalog');
      sources.catalog = catalog === undefined ? 'none' : 'reused';
    } else {
      sources.catalog = 'none';
    }

    let result;
    try {
      result = convertMap(map, catalog === undefined ? { includeProgress } : { includeProgress, catalog });
    } catch {
      throw new HttpError(422, 'conversion_invalid', 'O conversor não conseguiu ler este mapa.', { problems: [], warnings: [], private: sources });
    }
    const serialized = result.valid ? serializeCourse(result.document) : null;
    if (!serialized?.ok) {
      throw new HttpError(422, 'conversion_invalid', 'A conversão não gerou um curso válido; nada foi gravado em courses.', {
        problems: result.valid ? (serialized?.errors ?? []) : result.problems, warnings: result.warnings, counts: result.counts, private: sources,
      });
    }
    const courseId = serialized.document.course?.id;
    if (!isValidId(courseId)) {
      throw new HttpError(422, 'conversion_invalid', 'O curso convertido tem um id que o servidor não aceita.', { problems: [{ path: 'course.id', message: 'id inválido' }], warnings: result.warnings, counts: result.counts, private: sources });
    }
    // Teto do documento de curso (o mesmo dos PUT em courses), antes de gravar:
    // defesa em profundidade (o serializeCourse já limita o texto a 8 MiB).
    const courseBody = canonicalJson(serialized.document);
    if (courseBody.length > LIMITS.course) {
      throw new HttpError(413, 'payload_too_large', `O curso convertido passa do teto de ${LIMITS.course} bytes.`, { limit: LIMITS.course });
    }
    const summary = { counts: result.counts, warnings: result.warnings, problems: [], private: sources, courseId };
    if (dryRun) {
      sendJson(response, context, 200, { ok: true, saved: false, created: false, rev: null, ...summary });
      return;
    }
    const current = store.entry('courses', courseId);
    const live = Boolean(current && !current.deleted);
    if (live && body.expectedRev !== current.rev) {
      throw new HttpError(409, 'conflict', 'Já existe um curso com este id; confirme enviando expectedRev com a revisão atual.', { courseId, rev: current.rev, ...summary }, { 'X-Groove-Rev': current.rev });
    }
    let saved;
    try {
      saved = await store.putDoc('courses', courseId, courseBody, live ? { ifMatch: body.expectedRev } : { ifNoneMatch: true });
    } catch (error) {
      if (!(error instanceof PreconditionError)) throw error;
      const rev = error.current?.rev ?? null;
      throw new HttpError(409, 'conflict', 'O curso mudou durante a conversão; confira e tente de novo.', { courseId, rev, ...summary }, rev ? { 'X-Groove-Rev': rev } : {});
    }
    sendJson(response, context, saved.created ? 201 : 200, { ok: true, saved: true, created: saved.created, rev: saved.entry.rev, cursor: store.cursor(), ...summary }, { ETag: etag(saved.entry.rev), 'X-Groove-Rev': saved.entry.rev });
  }

  function intakeFailure(error) {
    return isIntakeError(error) ? new HttpError(intakeHttpStatus(error.code), error.code, error.message) : null;
  }

  // GET/HEAD: LEITURA. `report` não grava vínculo nem blob (nem cria a pasta):
  // quem importa é o POST .../materials/scan. Um GET não pode escrever fora do
  // check de Origin/Sec-Fetch-Site, que só cobre métodos de escrita.
  async function getMaterials(request, response, courseId) {
    try {
      sendJson(response, context, 200, { ...(await intakeService().report(courseId)), cursor: store.cursor() });
    } catch (error) {
      throw intakeFailure(error) ?? error;
    }
  }

  async function postMaterial(request, response, courseId) {
    requireContentType(request, 'application/octet-stream');
    const header = request.headers['x-groove-filename'];
    if (header === undefined) throw new HttpError(400, 'filename_required', 'Envie o nome do arquivo no cabeçalho X-Groove-Filename.');
    if (typeof header !== 'string' || header.includes(',')) throw new HttpError(400, 'invalid_filename', 'Nome de arquivo ambíguo.');
    let name;
    try {
      name = decodeURIComponent(header);
    } catch {
      throw new HttpError(400, 'invalid_filename', 'Nome de arquivo inválido.');
    }
    // Sem `store.ensureSpace(declared)`: o teto declarado (413) e a reserva de
    // disco ficam DENTRO do receiveBlob, como no PUT de blob — inclusive sem
    // Content-Length (chunked), quando a reserva é o teto inteiro do blob.
    const received = await receiveBlob(request, {
      tmpDir: store.tmpDir,
      maxBytes: maxBlobBytes,
      reserveSpace: (bytes) => store.reserveSpace(bytes),
    });
    try {
      const result = await intakeService().upload(courseId, { name, path: received.path });
      sendJson(response, context, 201, { ...result, cursor: store.cursor() });
    } catch (error) {
      await removeQuiet(received.path);
      throw intakeFailure(error) ?? error;
    }
  }

  // POST: IMPORTA. Casa a pasta de entrada com os materiais e grava os vínculos e
  // blobs que faltam; devolve o mesmo relatório do GET. É o único caminho que
  // importa arquivos copiados para `entrada/` fora do upload/bind.
  async function postMaterialScan(request, response, courseId) {
    try {
      sendJson(response, context, 200, { ...(await intakeService().scan(courseId)), cursor: store.cursor() });
    } catch (error) {
      throw intakeFailure(error) ?? error;
    }
  }

  async function postMaterialBind(request, response, courseId) {
    const value = await readJson(request, LIMITS.doc);
    if (!value || typeof value.refKey !== 'string' || typeof value.id !== 'string' || Object.keys(value).some((key) => key !== 'refKey' && key !== 'id')) {
      throw new HttpError(400, 'bad_request', 'Envie somente { refKey, id } para vincular.');
    }
    try {
      sendJson(response, context, 200, { ...(await intakeService().bind(courseId, { refKey: value.refKey, id: value.id })), cursor: store.cursor() });
    } catch (error) {
      throw intakeFailure(error) ?? error;
    }
  }

  async function sendBackupFile(request, response, name, date) {
    let handle;
    try {
      handle = await openRead(join(store.backupsDir, name));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ELOOP') throw notFound();
      throw error;
    }
    let handed = false;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw notFound();
      response.writeHead(200, apiHeaders(context, {
        'Content-Type': 'application/gzip',
        'Content-Length': String(info.size),
        'Content-Disposition': `attachment; filename="${downloadName(date)}"`,
      }));
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      handed = true;
      await pipeline(handle.createReadStream({ autoClose: true }), response).catch(() => {});
    } finally {
      if (!handed) await handle.close().catch(() => {});
    }
  }

  async function backups(request, response, segments) {
    if (segments.length === 1) {
      if (request.method === 'POST') {
        const made = await createDailyBackup(store, { keep: backupKeep });
        sendJson(response, context, 201, { name: made.name, date: made.date, size: made.size, createdAt: made.createdAt, pruned: made.pruned });
        return;
      }
      sendJson(response, context, 200, { keep: backupKeep, backups: await listBackups(store) });
      return;
    }
    const which = segments[1];
    if (which === 'latest') {
      const [newest] = await listBackups(store);
      if (!newest) throw notFound();
      await sendBackupFile(request, response, newest.name, newest.date);
      return;
    }
    await sendBackupFile(request, response, dailyName(which), which);
  }

  // ── despacho ─────────────────────────────────────────────────────────────
  // Devolve [modelo da rota para log, métodos, executor, consultas aceitas].
  function route(segments) {
    const [head, second, third] = segments;
    const n = segments.length;
    if (head === 'health' && n === 1) return ['/api/health', ['GET', 'HEAD'], health];
    if (head === 'docs') {
      if (n === 1) return ['/api/docs', ['GET', 'HEAD'], (q, s) => sendJson(s, context, 200, { collections: COLLECTIONS, cursor: store.cursor() })];
      if (!COLLECTIONS.includes(second)) return null;
      if (n === 2) {
        return [`/api/docs/${second}`, ['GET', 'HEAD'], (q, s) => sendJson(s, context, 200, {
          collection: second, cursor: store.cursor(), items: store.list(second).map((item) => ({ id: item.id, rev: item.rev, updatedAt: item.updatedAt, size: item.size })),
        })];
      }
      if (n === 3) {
        if (!isValidId(third)) throw new HttpError(400, 'invalid_id', 'Id de documento inválido.');
        const handlers = { GET: getDoc, HEAD: getDoc, PUT: putDoc, DELETE: deleteDoc };
        return [`/api/docs/${second}/:id`, Object.keys(handlers), (q, s, r) => handlers[r.method](r, s, second, third)];
      }
      return null;
    }
    if (head === 'changes' && n === 1) return ['/api/changes', ['GET', 'HEAD'], (q, s, r) => changes(r, s, q), ['since', 'limit']];
    if (head === 'blobs' && n === 2) {
      if (!SHA256_PATTERN.test(second)) throw new HttpError(400, 'invalid_id', 'Endereço de blob precisa ser sha256 em hexadecimal minúsculo.');
      const handlers = { GET: getBlob, HEAD: getBlob, PUT: putBlob, DELETE: deleteBlob };
      return ['/api/blobs/:sha256', Object.keys(handlers), (q, s, r) => handlers[r.method](r, s, second)];
    }
    if (head === 'private' && n === 2) {
      if (!PRIVATE_NAMES.includes(second)) return null;
      const handlers = { GET: getPrivate, HEAD: getPrivate, PUT: putPrivate, DELETE: deletePrivate };
      return [`/api/private/${second}`, Object.keys(handlers), (q, s, r) => handlers[r.method](r, s, second)];
    }
    if (head === 'courses' && second === 'convert' && n === 2) return ['/api/courses/convert', ['POST'], (q, s, r) => convert(r, s)];
    if (head === 'courses' && n >= 3 && third === 'materials') {
      if (!isValidId(second)) throw new HttpError(400, 'invalid_id', 'Id de curso inválido.');
      if (n === 3) {
        const handlers = { GET: (q, s, r) => getMaterials(r, s, second), HEAD: (q, s, r) => getMaterials(r, s, second), POST: (q, s, r) => postMaterial(r, s, second) };
        return ['/api/courses/:id/materials', ['GET', 'HEAD', 'POST'], (q, s, r) => handlers[r.method](q, s, r)];
      }
      if (n === 4 && segments[3] === 'scan') return ['/api/courses/:id/materials/scan', ['POST'], (q, s, r) => postMaterialScan(r, s, second)];
      if (n === 4 && segments[3] === 'bind') return ['/api/courses/:id/materials/bind', ['POST'], (q, s, r) => postMaterialBind(r, s, second)];
      return null;
    }
    if (head === 'backup' && n === 1) return ['/api/backup', ['GET', 'HEAD'], (q, s, r) => backups(r, s, ['backups', 'latest'])];
    if (head === 'backups') {
      if (n === 1) return ['/api/backups', ['GET', 'HEAD', 'POST'], (q, s, r) => backups(r, s, segments)];
      if (n === 2 && (second === 'latest' || DATE.test(second))) return [`/api/backups/${second === 'latest' ? 'latest' : ':date'}`, ['GET', 'HEAD'], (q, s, r) => backups(r, s, segments)];
    }
    return null;
  }

  function describe(error) {
    if (error instanceof HttpError) return error;
    if (error instanceof PreconditionError) return preconditionFailed(error);
    if (error?.code === 'insufficient_storage' || error?.code === 'ENOSPC') return new HttpError(507, 'insufficient_storage', 'Sem espaço livre no servidor.');
    if (error instanceof StorageError) return new HttpError(500, error.code, error.message);
    return new HttpError(500, 'internal_error', 'Erro interno do servidor.');
  }

  function isApiPath(rawPath) {
    return rawPath === prefix || rawPath.startsWith(`${prefix}/`);
  }

  async function handle(request, response) {
    const started = process.hrtime.bigint();
    const [rawPath, ...rest] = request.url.split('?');
    let template = '/api/*';
    response.once('finish', () => {
      const ms = Number((process.hrtime.bigint() - started) / 1000000n);
      log(`api ${request.method} ${template} ${response.statusCode} ${ms}ms`);
    });
    try {
      const segments = parseApiPath(rawPath, prefix);
      if (segments === null) throw new HttpError(400, 'invalid_path', 'Caminho de API inválido.');
      authenticate(request, auth);
      const matched = segments.length === 0 ? null : route(segments);
      if (!matched) throw notFound();
      const [name, methods, run, queryKeys = []] = matched;
      template = name;
      if (!methods.includes(request.method)) throw methodNotAllowed(methods);
      const query = parseQuery(rest.join('?'), queryKeys);
      await run(query, response, request);
    } catch (caught) {
      const error = describe(caught);
      // Só código e classe do erro: mensagens do Node citam caminhos absolutos.
      if (error.status >= 500) log(`api erro ${error.code} (${caught?.code ?? caught?.name ?? 'desconhecido'})`);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendError(response, context, error);
    }
  }

  return { handle, isApiPath };
}
