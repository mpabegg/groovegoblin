// Apoio dos testes de sincronização (rodada 6, etapa 7).
//
// O servidor de apoio é HTTP de VERDADE (node:http, porta efêmera, sockets e
// `fetch` reais) e segue o contrato estável da etapa 6: revisão por documento
// em `ETag`/`If-Match`, 412 com a revisão atual, 428 sem pré-condição, feed com
// cursor, blobs endereçados por conteúdo com conferência de hash e `Range`,
// área privada e conversão pelo conversor DO REPOSITÓRIO (nada de conversor
// falso, para o envelope ser exatamente o `groovegoblin-course`).
//
// Com `GROOVE_SYNC_REAL_SERVER=1` e o servidor da etapa 6 presente no repositório
// (`server/app.js`), `tests/sync-real-server.test.js` roda o mesmo fluxo contra
// ele. Sem isso, estes testes ficam determinísticos e offline.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { convertCourseMap } from '../scripts/convert-course-map.js';
import { serializeCourse } from '../src/course-format.js';

export const DATA_ID = '0123456789abcdef';
export const PUBLIC_ORIGIN = 'https://groove.exemplo.ts.net';

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// `localStorage` de mentira, com a mesma semântica de quota/erro.
export function createMemoryStorage({ fail = false } = {}) {
  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) {
      if (fail) throw new Error('quota');
      map.set(key, String(value));
    },
    removeItem(key) { map.delete(key); },
    key(index) { return [...map.keys()][index] ?? null; },
    get length() { return map.size; },
    raw: map,
    setFail(value) { fail = value; },
  };
}

export function createFakeTimers() {
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    setInterval(fn, ms) { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
    clearInterval(handle) { intervals.delete(handle); },
    setTimeout(fn, ms) { const id = nextId++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout(handle) { timeouts.delete(handle); },
    get intervalCount() { return intervals.size; },
    get timeoutCount() { return timeouts.size; },
    runTimeouts() {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const item of pending) item.fn();
    },
    runIntervals() {
      for (const item of [...intervals.values()]) item.fn();
    },
  };
}

function parseJsonBody(chunks) {
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return { value: null, error: 'empty' };
  try { return { value: JSON.parse(text), error: null }; } catch { return { value: null, error: 'invalid' }; }
}

function readRevision(header) {
  if (typeof header !== 'string') return null;
  const text = header.trim().replace(/^W\//, '').replace(/^"/, '').replace(/"$/, '');
  return /^[0-9]+$/.test(text) ? text : null;
}

// Servidor de apoio do contrato. Devolve `{ base, port, close, origin, docs(), seed() }`.
export async function startContractServer({ dataId = DATA_ID, convert = true } = {}) {
  const collections = new Map(); // collection -> Map(id -> { rev, body, updatedAt, deleted })
  const changes = []; // { seq, collection, id, rev, deleted, updatedAt, size }
  const blobs = new Map(); // sha -> Buffer
  const privates = new Map(); // name -> { body, sha256, updatedAt }
  let seq = 0;
  let closed = false;

  function collection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  function record(collectionName, id, body, { deleted = false }) {
    seq += 1;
    const rev = String(seq);
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
    const text = JSON.stringify(body);
    const entry = deleted
      ? { rev, deleted: true, updatedAt, size: 0 }
      : { rev, deleted: false, body, text, updatedAt, size: Buffer.byteLength(text) };
    collection(collectionName).set(id, entry);
    changes.push({ seq, collection: collectionName, id, rev, deleted, updatedAt, size: entry.size });
    return entry;
  }

  function cursor() { return `${dataId}.${seq}`; }

  function json(response, status, payload, headers = {}) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'private, no-store',
      ...headers,
    });
    response.end(body);
  }

  function error(response, status, code, message, extra = {}, headers = {}) {
    json(response, status, { error: code, message, ...extra }, headers);
  }

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      void handle(request, response, Buffer.concat(chunks));
    });
  });

  async function handle(request, response, rawBody) {
    const url = new URL(request.url, `http://127.0.0.1:${server.address()?.port ?? 1}`);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'api') {
      error(response, 404, 'not_found', 'Sem API nesta origem.');
      return;
    }
    const head = segments[1] ?? '';
    const method = request.method ?? 'GET';
    if (head === 'health') {
      const docs = [...collections.values()].reduce((total, map) => total + [...map.values()].filter(entry => !entry.deleted).length, 0);
      const tombstones = [...collections.values()].reduce((total, map) => total + [...map.values()].filter(entry => entry.deleted).length, 0);
      json(response, 200, {
        ok: true, service: 'groovegoblin', apiVersion: 1, version: 'test-1', time: new Date().toISOString(),
        mode: 'dev', dataId, cursor: cursor(),
        storage: {
          usedBytes: [...blobs.values()].reduce((total, buffer) => total + buffer.length, 0),
          freeBytes: 1024 * 1024,
          docs, tombstones, blobs: blobs.size,
        },
      }, { ETag: '"health"' });
      return;
    }
    if (head === 'docs') {
      if (segments.length === 2) {
        if (method !== 'GET' && method !== 'HEAD') { error(response, 405, 'method_not_allowed', 'Método não permitido.', { allow: ['GET', 'HEAD'] }); return; }
        json(response, 200, { collections: [...collections.keys()], cursor: cursor() });
        return;
      }
      const collectionName = segments[2];
      if (segments.length === 3) {
        const items = [];
        for (const [id, entry] of collection(collectionName)) {
          if (entry.deleted) continue;
          items.push({ id, rev: entry.rev, updatedAt: entry.updatedAt, size: entry.size });
        }
        json(response, 200, { collection: collectionName, cursor: cursor(), items });
        return;
      }
      const id = segments[3];
      const store = collection(collectionName);
      const current = store.get(id) ?? null;
      if (method === 'GET' || method === 'HEAD') {
        if (!current) { error(response, 404, 'not_found', 'Documento inexistente.'); return; }
        const ifNoneMatch = readRevision(request.headers['if-none-match']);
        if (ifNoneMatch !== null && ifNoneMatch === current.rev) {
          response.writeHead(304, { ETag: `"${current.rev}"` });
          response.end();
          return;
        }
        if (current.deleted) {
          error(response, 404, 'not_found', 'Documento removido.', { deleted: true, rev: current.rev }, { ETag: `"${current.rev}"` });
          return;
        }
        const body = current.text;
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'private, no-store',
          ETag: `"${current.rev}"`,
          'X-Groove-Rev': current.rev,
        });
        response.end(body);
        return;
      }
      if (method === 'PUT') {
        const ifNoneMatch = request.headers['if-none-match'] ?? null;
        const ifMatch = request.headers['if-match'] ?? null;
        if (ifNoneMatch === null && ifMatch === null) { error(response, 428, 'precondition_required', 'Informe If-Match ou If-None-Match: *.'); return; }
        if (ifNoneMatch !== null && ifMatch !== null) { error(response, 400, 'invalid_precondition', 'Escolha uma pré-condição.'); return; }
        const parsed = parseJsonBody([rawBody]);
        if (parsed.error) { error(response, 400, 'invalid_json', 'Corpo JSON inválido.'); return; }
        if (ifNoneMatch !== null) {
          if (ifNoneMatch !== '*') { error(response, 400, 'invalid_precondition', 'If-None-Match precisa ser *.'); return; }
          if (current && !current.deleted) { error(response, 412, 'precondition_failed', 'Documento já existe.', { current: { rev: current.rev, deleted: false } }, { ETag: `"${current.rev}"` }); return; }
          const entry = record(collectionName, id, parsed.value, { deleted: false });
          json(response, 201, { collection: collectionName, id, rev: entry.rev, deleted: false, updatedAt: entry.updatedAt, size: entry.size, cursor: cursor() }, { ETag: `"${entry.rev}"` });
          return;
        }
        const expected = readRevision(ifMatch);
        if (expected === null) { error(response, 400, 'invalid_precondition', 'If-Match precisa de revisão.'); return; }
        if (!current || current.deleted || current.rev !== expected) {
          error(response, 412, 'precondition_failed', 'Revisão desatualizada.', { current: current ? { rev: current.rev, deleted: current.deleted === true } : null }, current ? { ETag: `"${current.rev}"` } : {});
          return;
        }
        const entry = record(collectionName, id, parsed.value, { deleted: false });
        json(response, 200, { collection: collectionName, id, rev: entry.rev, deleted: false, updatedAt: entry.updatedAt, size: entry.size, cursor: cursor() }, { ETag: `"${entry.rev}"` });
        return;
      }
      if (method === 'DELETE') {
        const expected = readRevision(request.headers['if-match']);
        if (expected === null) { error(response, 428, 'precondition_required', 'Remover exige If-Match.'); return; }
        if (!current || current.deleted || current.rev !== expected) {
          error(response, 412, 'precondition_failed', 'Revisão desatualizada.', { current: current ? { rev: current.rev, deleted: current.deleted === true } : null }, current ? { ETag: `"${current.rev}"` } : {});
          return;
        }
        const entry = record(collectionName, id, null, { deleted: true });
        json(response, 200, { collection: collectionName, id, rev: entry.rev, deleted: true, updatedAt: entry.updatedAt, size: 0, cursor: cursor() }, { ETag: `"${entry.rev}"` });
        return;
      }
      error(response, 405, 'method_not_allowed', 'Método não permitido.');
      return;
    }
    if (head === 'changes') {
      const since = url.searchParams.get('since');
      const limit = Number(url.searchParams.get('limit') ?? 500);
      let start = 0;
      if (since !== null) {
        const [sinceData, sinceSeq] = String(since).split('.');
        if (sinceData !== dataId || !/^[0-9]+$/.test(sinceSeq ?? '')) { error(response, 410, 'cursor_reset', 'Cursor de outro conjunto de dados.'); return; }
        start = Number(sinceSeq);
        if (start > seq) { error(response, 410, 'cursor_reset', 'Cursor à frente do servidor.'); return; }
      }
      // Compactação: só o último estado de cada documento.
      const latest = new Map();
      for (const change of changes) {
        if (change.seq <= start) continue;
        latest.set(`${change.collection}|${change.id}`, change);
      }
      const list = [...latest.values()].sort((a, b) => a.seq - b.seq);
      const page = list.slice(0, Math.max(1, limit));
      const more = list.length > page.length;
      json(response, 200, {
        cursor: `${dataId}.${page.length > 0 ? page[page.length - 1].seq : start}`,
        more,
        changes: page.map(change => ({ collection: change.collection, id: change.id, rev: change.rev, deleted: change.deleted, updatedAt: change.updatedAt, size: change.size })),
      });
      return;
    }
    if (head === 'blobs') {
      const sha = segments[2] ?? '';
      if (!/^[0-9a-f]{64}$/.test(sha)) { error(response, 400, 'invalid_id', 'Hash inválido.'); return; }
      if (method === 'PUT') {
        const actual = sha256Hex(rawBody);
        if (actual !== sha) { error(response, 400, 'hash_mismatch', 'O conteúdo não corresponde ao hash.'); return; }
        const existed = blobs.has(sha);
        blobs.set(sha, rawBody);
        json(response, existed ? 200 : 201, { sha256: sha, size: rawBody.length, created: !existed });
        return;
      }
      if (method === 'HEAD' || method === 'GET') {
        const buffer = blobs.get(sha);
        if (!buffer) { error(response, 404, 'not_found', 'Arquivo inexistente.'); return; }
        const range = request.headers.range ?? null;
        const ifNoneMatch = request.headers['if-none-match'] ?? null;
        if (ifNoneMatch !== null && readRevision(ifNoneMatch) === null && ifNoneMatch.replace(/"/g, '') === sha) {
          response.writeHead(304, { ETag: `"${sha}"` });
          response.end();
          return;
        }
        if (range !== null) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
          if (match) {
            const start = match[1] === '' ? buffer.length - Number(match[2]) : Number(match[1]);
            const end = match[1] === '' || match[2] === '' ? buffer.length - 1 : Number(match[2]);
            if (start <= end && start < buffer.length) {
              const slice = buffer.subarray(start, Math.min(end, buffer.length - 1) + 1);
              response.writeHead(206, {
                'Content-Type': 'application/octet-stream',
                'Accept-Ranges': 'bytes',
                'Content-Range': `bytes ${start}-${start + slice.length - 1}/${buffer.length}`,
                'Content-Length': slice.length,
                ETag: `"${sha}"`,
                'Cache-Control': 'private, no-store',
              });
              response.end(method === 'HEAD' ? undefined : slice);
              return;
            }
            response.writeHead(416, { 'Content-Range': `bytes */${buffer.length}` });
            response.end();
            return;
          }
        }
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': buffer.length,
          'Accept-Ranges': 'bytes',
          ETag: `"${sha}"`,
          'Cache-Control': 'private, no-store',
        });
        response.end(method === 'HEAD' ? undefined : buffer);
        return;
      }
      if (method === 'DELETE') {
        const existed = blobs.delete(sha);
        if (!existed) { error(response, 404, 'not_found', 'Arquivo inexistente.'); return; }
        json(response, 200, { sha256: sha, deleted: true });
        return;
      }
      error(response, 405, 'method_not_allowed', 'Método não permitido.');
      return;
    }
    if (head === 'private') {
      const name = segments[2] ?? '';
      if (method === 'PUT') {
        let value;
        try { value = JSON.parse(rawBody.toString('utf8')); } catch { error(response, 400, 'invalid_json', 'Corpo inválido.'); return; }
        const sha = sha256Hex(rawBody);
        const existed = privates.has(name);
        privates.set(name, { body: value, sha256: sha, updatedAt: new Date().toISOString() });
        json(response, existed ? 200 : 201, { name, size: rawBody.length, sha256: sha, updatedAt: new Date().toISOString() });
        return;
      }
      if (method === 'GET') {
        const entry = privates.get(name);
        if (!entry) { error(response, 404, 'not_found', 'Área privada vazia.'); return; }
        json(response, 200, entry.body, { ETag: `"${entry.sha256}"` });
        return;
      }
      error(response, 405, 'method_not_allowed', 'Método não permitido.');
      return;
    }
    if (head === 'courses' && segments[2] === 'convert' && method === 'POST') {
      if (!convert) { error(response, 404, 'not_found', 'Conversão indisponível.'); return; }
      let body;
      try { body = JSON.parse(rawBody.toString('utf8')); } catch { error(response, 400, 'bad_request', 'Corpo inválido.'); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { error(response, 400, 'bad_request', 'Corpo inválido.'); return; }
      const sources = {};
      const dryRun = body.dryRun === true;
      const map = Object.hasOwn(body, 'map') ? body.map : privates.get('map')?.body;
      if (!map) { error(response, 404, 'private_missing', 'Nenhum mapa enviado nem guardado.'); return; }
      // Fontes espelham o servidor de verdade (etapa 6): mapa enviado no pedido
      // é 'provided' em dryRun e 'stored' quando é gravado; sem mapa no pedido,
      // 'reused' (ou 404 acima quando não há nada guardado).
      sources.map = Object.hasOwn(body, 'map') ? (dryRun ? 'provided' : 'stored') : 'reused';
      if (!dryRun) privates.set('map', { body: map, sha256: sha256Hex(Buffer.from(JSON.stringify(map))), updatedAt: new Date().toISOString() });
      let catalog;
      if (Object.hasOwn(body, 'catalog') && body.catalog !== null) {
        catalog = body.catalog;
        sources.catalog = dryRun ? 'provided' : 'stored';
        if (!dryRun) privates.set('catalog', { body: catalog, sha256: sha256Hex(Buffer.from(JSON.stringify(catalog))), updatedAt: new Date().toISOString() });
      } else if (Object.hasOwn(body, 'catalog')) {
        sources.catalog = 'none';
      } else {
        catalog = privates.get('catalog')?.body;
        sources.catalog = catalog === undefined ? 'none' : 'reused';
      }
      let result;
      try {
        result = convertCourseMap(map, catalog === undefined ? { includeProgress: body.includeProgress === true } : { includeProgress: body.includeProgress === true, catalog });
      } catch (cause) {
        error(response, 422, 'conversion_invalid', 'O conversor não conseguiu ler este mapa.', { problems: [], warnings: [], counts: null, private: sources });
        return;
      }
      const serialized = result.valid ? serializeCourse(result.document) : null;
      if (!serialized?.ok) {
        error(response, 422, 'conversion_invalid', 'A conversão não gerou um curso válido.', { problems: result.problems ?? [], warnings: result.warnings ?? [], counts: result.counts ?? null, private: sources });
        return;
      }
      const courseId = serialized.document.course?.id;
      const store = collection('courses');
      const current = store.get(courseId) ?? null;
      const live = Boolean(current && !current.deleted);
      if (live && body.expectedRev !== current.rev) {
        error(response, 409, 'conflict', 'Já existe um curso com este id.', { courseId, rev: current.rev, counts: result.counts, warnings: result.warnings });
        return;
      }
      const payload = JSON.parse(serialized.text);
      const entry = record('courses', courseId, payload, { deleted: false });
      json(response, 200, { ok: true, saved: true, created: !live, courseId, rev: entry.rev, cursor: cursor(), counts: result.counts, warnings: result.warnings, problems: [], private: sources }, { ETag: `"${entry.rev}"` });
      return;
    }
    error(response, 404, 'not_found', 'Rota desconhecida.');
  }

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    base: `http://127.0.0.1:${port}/`,
    dataId,
    cursor,
    docs(collectionName) { return new Map(collection(collectionName)); },
    seed(collectionName, id, body, options = {}) { return record(collectionName, id, body, options); },
    seedBlob(bytes) { const sha = sha256Hex(bytes); blobs.set(sha, Buffer.from(bytes)); return sha; },
    blobBytes(sha) { return blobs.get(sha) ?? null; },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise(resolve => server.close(resolve));
    },
  };
}

// Biblioteca de exercícios de mentira, com a MESMA superfície que o adaptador
// usa — inclusive os dois métodos propostos na etapa (`applyRemoteEntry`,
// `removeRemoteEntry`), que no app entram pelo patch de `exercise-library.js`.
export function createFakeLibrary(initial = []) {
  const entries = initial.map(entry => JSON.parse(JSON.stringify(entry)));
  const listeners = new Set();
  let counter = initial.length;
  const emit = () => { for (const listener of [...listeners]) listener(); };
  return {
    entries: () => entries.map(entry => JSON.parse(JSON.stringify(entry))),
    get(id) { const found = entries.find(entry => entry.id === id); return found ? JSON.parse(JSON.stringify(found)) : null; },
    list: () => entries.map(entry => ({ id: entry.id })),
    exportLibrary: () => JSON.stringify({ version: 1, kind: 'groovegoblin-exercise-library', activeId: entries[0]?.id ?? null, entries }),
    applyRemoteEntry(entry) {
      const next = JSON.parse(JSON.stringify(entry));
      const index = entries.findIndex(item => item.id === next.id);
      if (index >= 0) entries[index] = next; else entries.push(next);
      emit();
      return JSON.parse(JSON.stringify(next));
    },
    removeRemoteEntry(id) {
      const index = entries.findIndex(entry => entry.id === id);
      if (index < 0) return false;
      if (entries.length <= 1) return false;
      entries.splice(index, 1);
      emit();
      return true;
    },
    add(overrides = {}) {
      counter += 1;
      const entry = {
        id: overrides.id ?? `ex-${counter}`,
        createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
        updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
        session: overrides.session ?? { name: `Exercício ${counter}`, notes: [] },
        metadata: overrides.metadata ?? { name: `Exercício ${counter}`, tags: [], records: [] },
      };
      entries.push(entry);
      emit();
      return entry;
    },
    update(id, patch = {}) {
      const entry = entries.find(item => item.id === id);
      if (!entry) return null;
      if (patch.updatedAt) entry.updatedAt = patch.updatedAt;
      if (patch.session) entry.session = patch.session;
      if (patch.metadata) entry.metadata = { ...entry.metadata, ...patch.metadata };
      emit();
      return entry;
    },
    remove(id) {
      const index = entries.findIndex(entry => entry.id === id);
      if (index < 0) return false;
      entries.splice(index, 1);
      emit();
      return true;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit,
  };
}

// Loja de anexos de mentira: referências + arquivos, com os dois métodos
// propostos na etapa (`adoptRemoteRef`, `dropBlob`).
export function createFakeAttachmentStore() {
  const refs = new Map();
  const files = new Map();
  const listeners = new Set();
  const emit = () => { for (const listener of [...listeners]) listener(); };
  return {
    refs,
    files,
    listAll: () => [...refs.values()].map(ref => ({ ...ref })),
    get(key) { const ref = refs.get(key); return ref ? { ...ref } : null; },
    async getFile(key) {
      const ref = refs.get(key);
      if (!ref) return null;
      const file = files.get(ref.fileId);
      return file ? { ...file, blob: file.blob } : null;
    },
    adoptRemoteRef({ key, sha256, size = null, kind = 'other', name = null, addedAt = null }) {
      const [courseId, lessonId, resourceId] = JSON.parse(key);
      refs.set(key, {
        key, courseId, lessonId, resourceId,
        fileId: `sha256:${sha256}`, name: name ?? 'arquivo', extension: '',
        role: null, source: 'servidor', addedAt: addedAt ?? '2026-01-01T00:00:00.000Z',
        verified: true, warning: null, size, kind,
      });
      emit();
      return true;
    },
    async dropBlob(fileId) {
      if (!files.has(fileId)) return { dropped: false };
      files.delete(fileId);
      emit();
      return { dropped: true };
    },
    async clearCourse(courseId) {
      let removed = 0;
      for (const [key, ref] of [...refs]) {
        if (ref.courseId !== courseId) continue;
        refs.delete(key);
        removed += 1;
      }
      if (removed > 0) emit();
      return { refs: removed };
    },
    putFile({ key, sha256, bytes, kind = 'pdf', name = 'material.pdf' }) {
      const blob = new Blob([bytes]);
      files.set(`sha256:${sha256}`, { id: `sha256:${sha256}`, size: blob.size, kind, name, blob });
      return this.putRef({ key, sha256, kind, name, size: blob.size });
    },
    putRef({ key, sha256, kind = 'pdf', name = 'material.pdf', size = null }) {
      const [courseId, lessonId, resourceId] = JSON.parse(key);
      refs.set(key, {
        key, courseId, lessonId, resourceId, fileId: `sha256:${sha256}`,
        name, extension: '', role: null, source: 'upload', addedAt: '2026-01-01T00:00:00.000Z',
        verified: true, warning: null, size, kind,
      });
      emit();
      return refs.get(key);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit,
  };
}

// Loja de formas de mentira (A3): mesma superfície que o adaptador usa.
export function createFakeShapeStore({ status = 'ready' } = {}) {
  const groups = { bass4: [], bass5: [], guitar6: [] };
  const listeners = new Set();
  let current = status;
  const emit = () => { for (const listener of [...listeners]) listener(); };
  return {
    groups,
    get status() { return current; },
    setStatus(value) { current = value; },
    save(shape, group = 'bass4') {
      const record = { ...shape, id: shape.id ?? `${group}-${groups[group].length + 1}` };
      groups[group].push(record);
      emit();
      return record;
    },
    exportDocument: () => ({ version: 1, instruments: JSON.parse(JSON.stringify(groups)) }),
    importDocument(document) {
      if (current !== 'ready') return { ok: false, added: 0, reused: 0, renamed: 0, errors: [] };
      let added = 0;
      let reused = 0;
      for (const [id, shapes] of Object.entries(document?.instruments ?? {})) {
        if (!groups[id]) continue;
        for (const shape of shapes ?? []) {
          const existing = groups[id].find(item => item.id === shape.id);
          if (existing && JSON.stringify(existing) === JSON.stringify(shape)) { reused += 1; continue; }
          groups[id].push({ ...shape, id: existing ? `${id}-novo` : shape.id });
          added += 1;
        }
      }
      if (added > 0) emit();
      return { ok: true, added, reused, renamed: 0, errors: [] };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

// Loja de vínculos de forma de mentira (A5).
export function createFakeBindingStore({ status = 'ready' } = {}) {
  const bindings = [];
  const listeners = new Set();
  let current = status;
  const emit = () => { for (const listener of [...listeners]) listener(); };
  return {
    get status() { return current; },
    setStatus(value) { current = value; },
    exportDocument: () => ({ version: 1, bindings: bindings.map(binding => ({ ...binding })) }),
    importDocument(document) {
      if (current !== 'ready') return { added: 0, total: bindings.length, available: false };
      let added = 0;
      for (const binding of document?.bindings ?? []) {
        const id = JSON.stringify([binding.label ?? null, binding.quality ?? null, binding.inversion ?? null]);
        if (bindings.some(item => JSON.stringify([item.label ?? null, item.quality ?? null, item.inversion ?? null]) === id)) continue;
        bindings.push({ ...binding });
        added += 1;
      }
      if (added > 0) emit();
      return { added, total: bindings.length, available: true };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

// Porto em memória para cenários controlados (disponibilidade, lista vazia).
export function createMemoryPort({ collection, id = 'doc-1', body = { v: 1 }, available = true } = {}) {
  const docs = new Map([[id, body]]);
  let ready = available;
  const clone = value => JSON.parse(JSON.stringify(value));
  return {
    collection,
    singleton: false,
    docs,
    available: () => ready,
    setAvailable(value) { ready = value; },
    async list() {
      return [...docs.entries()].map(([docId, value]) => ({ id: docId, body: clone(value), updatedAt: null }));
    },
    async get(docId) {
      const value = docs.get(docId);
      return value === undefined ? null : { id: docId, body: clone(value), updatedAt: null };
    },
    async apply({ id: docId, body: value }) {
      docs.set(docId, clone(value));
      return { changed: true, body: clone(value) };
    },
    async remove(docId) { return { changed: docs.delete(docId) }; },
    subscribe() { return () => {}; },
  };
}

// Documento de mentira para exercitar a política de sondagem.
export function fakeDocument(marker) {
  return {
    documentElement: {
      getAttribute(name) {
        if (marker === 'throw') throw new Error('sem acesso');
        return name === 'data-groove-server' ? marker : null;
      },
    },
  };
}

// O servidor da etapa 6, quando estiver no repositório: mesmo fluxo, servidor
// de produção. Ausente → os testes que dependem dele são pulados.
export async function startRealServerIfAvailable({ dataDir, env = {} } = {}) {
  let config;
  let app;
  try {
    config = await import('../server/config.js');
    app = await import('../server/app.js');
  } catch {
    return null;
  }
  const loaded = config.loadConfig({ PORT: '0', GROOVE_DATA_DIR: dataDir, ...env }, { projectRoot: new URL('..', import.meta.url).pathname });
  const running = await app.startGrooveServer(loaded, { log: () => {} });
  return {
    origin: `http://127.0.0.1:${running.port}`,
    base: `http://127.0.0.1:${running.port}/`,
    config: loaded,
    close: () => running.close(),
  };
}
