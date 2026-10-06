// Armazenamento durável do servidor: manifesto de commit único + objetos
// imutáveis endereçados por conteúdo.
//
//   <data>/groovegoblin-data.json  marcador (formato + dataId)
//   <data>/server.lock             dono atual (pid + início do processo + boot)
//   <data>/state.json              manifesto: seq, índice de docs e lápides, privados
//   <data>/objects/xx/<sha256>     corpos dos documentos
//   <data>/private/<sha256>        mapa e catálogo privados
//   <data>/blobs/xx/<sha256>       anexos
//   <data>/backups/                snapshots gzip
//   <data>/tmp/                    temporários (esvaziada na subida)
//
// Um commit grava o objeto (fsync) e só depois troca state.json por rename
// atômico. Documento e feed de mudanças moram no MESMO arquivo, então após
// queda o servidor volta ao estado anterior inteiro ou ao novo inteiro. Todas
// as mutações passam por um mutex: If-Match é decidido contra o estado
// commitado, sem corrida entre duas escritas.

import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, statfs, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  DIR_MODE,
  StorageError,
  emptyDir,
  ensureRealDir,
  fsyncDir,
  openExclusive,
  openRead,
  readNoFollow,
  removeQuiet,
  writeDurable,
} from './fsutil.js';

// courseAttachments: um documento por curso com os vínculos material -> blob
// ({ refs: { <chave>: { sha256, size, kind, ... } } }); o blob em si fica em /api/blobs.
export const COLLECTIONS = Object.freeze(['exercises', 'forms', 'courses', 'courseStates', 'courseAttachments', 'todayQueues', 'routines', 'preferences']);
export const PRIVATE_NAMES = Object.freeze(['map', 'catalog']);
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MARKER_FILE = 'groovegoblin-data.json';
const STATE_FILE = 'state.json';
const LOCK_FILE = 'server.lock';
const INIT_PREFIX = '.groovegoblin-init-';
const SUBDIRS = ['objects', 'blobs', 'private', 'backups', 'tmp', 'entrada'];
const MARKER_FORMAT = 'groovegoblin-data';
const STATE_FORMAT = 'groovegoblin-server-state';
const DATA_ID_PATTERN = /^[0-9a-f]{16}$/;
export const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id) && !id.includes('..');
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export class PreconditionError extends Error {
  constructor(current) {
    super('precondition failed');
    this.name = 'PreconditionError';
    this.current = current;
  }
}

class Mutex {
  #tail = Promise.resolve();

  run(task) {
    const result = this.#tail.then(task);
    this.#tail = result.catch(() => {});
    return result;
  }
}

function inside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

async function readOptional(path) {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

// Identidade do processo: pid sozinho é reutilizado depois de um reboot; o
// boot_id e o instante de início (campo 22 de /proc/<pid>/stat) desfazem a dúvida.
async function processStart(pid) {
  const stat = await readOptional(`/proc/${pid}/stat`);
  if (!stat) return null;
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields[19] ?? null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function lockIsStale(content) {
  let owner;
  try {
    owner = JSON.parse(content);
  } catch {
    return true;
  }
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return true;
  const bootId = await readOptional('/proc/sys/kernel/random/boot_id');
  if (bootId && owner.bootId && owner.bootId !== bootId) return true;
  if (!pidAlive(owner.pid)) return true;
  if (owner.start) {
    const start = await processStart(owner.pid);
    if (start && start !== owner.start) return true;
  }
  return false;
}

async function acquireLock(dir) {
  const path = join(dir, LOCK_FILE);
  const content = JSON.stringify({
    pid: process.pid,
    start: await processStart(process.pid),
    bootId: await readOptional('/proc/sys/kernel/random/boot_id'),
    token: randomBytes(8).toString('hex'),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await openExclusive(path);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDir(dir);
      return content;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readNoFollow(path).then((data) => data.toString('utf8'), () => '');
      if (!(await lockIsStale(existing))) {
        throw new StorageError('locked', 'Outro processo do GrooveGoblin está usando este data dir (pare o servidor antes).');
      }
      await removeQuiet(path);
    }
  }
  throw new StorageError('locked', 'Não foi possível obter o lock do data dir.');
}

function emptyState(dataId) {
  return { format: STATE_FORMAT, version: 1, dataId, seq: 0, floor: 0, docs: {}, private: {} };
}

function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.rev !== 'string' || !/^[1-9]\d*$/.test(entry.rev)) return false;
  if (typeof entry.updatedAt !== 'string') return false;
  if (entry.deleted === true) return true;
  return SHA256_PATTERN.test(entry.sha256) && Number.isSafeInteger(entry.size) && entry.size >= 0;
}

function validateState(state, dataId) {
  if (!state || state.format !== STATE_FORMAT || state.version !== 1 || state.dataId !== dataId) return false;
  if (!Number.isSafeInteger(state.seq) || state.seq < 0 || !Number.isSafeInteger(state.floor) || state.floor < 0) return false;
  if (!state.docs || typeof state.docs !== 'object' || !state.private || typeof state.private !== 'object') return false;
  for (const [collection, entries] of Object.entries(state.docs)) {
    if (!COLLECTIONS.includes(collection) || !entries || typeof entries !== 'object') return false;
    for (const [id, entry] of Object.entries(entries)) {
      if (!isValidId(id) || !validEntry(entry) || Number(entry.rev) > state.seq) return false;
    }
  }
  for (const [name, entry] of Object.entries(state.private)) {
    if (!PRIVATE_NAMES.includes(name) || !SHA256_PATTERN.test(entry?.sha256) || !Number.isSafeInteger(entry.size)) return false;
  }
  return true;
}

async function listShardedFiles(root) {
  const files = [];
  for (const shard of await readdir(root, { withFileTypes: true })) {
    if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
    for (const entry of await readdir(join(root, shard.name), { withFileTypes: true })) {
      if (entry.isFile() && SHA256_PATTERN.test(entry.name) && entry.name.startsWith(shard.name)) {
        const info = await lstat(join(root, shard.name, entry.name));
        files.push({ sha256: entry.name, size: info.size });
      }
    }
  }
  return files;
}

// Algum arquivo (em profundidade 2, o bastante para os shards) existe sob este
// caminho? Ausente = vazio.
async function dirHasFiles(path, depth) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && depth > 1 && await dirHasFiles(join(path, entry.name), depth - 1)) return true;
  }
  return false;
}

// Há dados de verdade gravados que o manifesto governa (corpos de documento e
// privados)? Um data dir recém-marcado não tem nenhum. Usado para NÃO
// sintetizar um estado vazio quando state.json sumiu: `init()` apaga como
// órfão todo objeto/privado que o manifesto não referencia, então o manifesto
// ausente com esses diretórios cheios é perda de dados, não um diretório novo.
//
// Blobs NÃO entram na conta: são endereçados pelo conteúdo, não são
// referenciados pelo manifesto (init só os conta) e nenhum caminho de subida os
// apaga. Um data dir que ainda não commitou documento nenhum pode ter estado
// vazio e blobs legitimamente.
async function hasStoredData(dir) {
  for (const name of ['objects', 'private']) {
    if (await dirHasFiles(join(dir, name), 2)) return true;
  }
  return false;
}

export class DataStore {
  #dir;
  #lockContent;
  #state;
  #mutex = new Mutex();
  #now;
  #minFreeBytes;
  #refs = new Map();
  #counters = { docBytes: 0, blobBytes: 0, privateBytes: 0, blobs: 0, missingObjects: 0 };
  #pendingBytes = 0;
  #closed = false;

  constructor(dir, lockContent, state, { now, minFreeBytes }) {
    this.#dir = dir;
    this.#lockContent = lockContent;
    this.#state = state;
    this.#now = now;
    this.#minFreeBytes = minFreeBytes;
  }

  get dataId() { return this.#state.dataId; }
  get seq() { return this.#state.seq; }
  get floor() { return this.#state.floor; }
  get backupsDir() { return join(this.#dir, 'backups'); }
  get tmpDir() { return join(this.#dir, 'tmp'); }
  // Pasta de entrada dos cursos: a ORIGEM dos arquivos que o usuário copia
  // (não entra no instantâneo/restauração — o que o app usa está em blobs/).
  get intakeDir() { return join(this.#dir, 'entrada'); }
  now() { return this.#now(); }

  cursor(seq = this.#state.seq) {
    return `${this.#state.dataId}.${seq}`;
  }

  // Serializa qualquer tarefa com os commits (backup consistente, restauração).
  exclusive(task) {
    return this.#mutex.run(task);
  }

  #objectPath(sha) { return join(this.#dir, 'objects', sha.slice(0, 2), sha); }
  #privatePath(sha) { return join(this.#dir, 'private', sha); }
  #blobPath(sha) { return join(this.#dir, 'blobs', sha.slice(0, 2), sha); }

  async init() {
    const objects = join(this.#dir, 'objects');
    const referenced = new Map();
    for (const entries of Object.values(this.#state.docs)) {
      for (const entry of Object.values(entries)) {
        if (!entry.deleted) referenced.set(entry.sha256, (referenced.get(entry.sha256) ?? 0) + 1);
      }
    }
    this.#refs = referenced;
    const present = new Set();
    for (const file of await listShardedFiles(objects)) {
      if (referenced.has(file.sha256)) {
        present.add(file.sha256);
        this.#counters.docBytes += file.size;
      } else {
        await removeQuiet(this.#objectPath(file.sha256)); // órfão de commit interrompido
      }
    }
    this.#counters.missingObjects = [...referenced.keys()].filter((sha) => !present.has(sha)).length;
    const privateRefs = new Set(Object.values(this.#state.private).map((entry) => entry.sha256));
    for (const entry of await readdir(join(this.#dir, 'private'), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (privateRefs.has(entry.name)) this.#counters.privateBytes += (await lstat(this.#privatePath(entry.name))).size;
      else await removeQuiet(join(this.#dir, 'private', entry.name));
    }
    for (const file of await listShardedFiles(join(this.#dir, 'blobs'))) {
      this.#counters.blobs += 1;
      this.#counters.blobBytes += file.size;
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#mutex.run(async () => {
      const path = join(this.#dir, LOCK_FILE);
      const current = await readNoFollow(path).then((data) => data.toString('utf8'), () => null);
      if (current === this.#lockContent) await removeQuiet(path);
    });
  }

  // ── espaço e contadores ─────────────────────────────────────────────────
  async freeBytes() {
    const info = await statfs(this.#dir);
    return Number(info.bavail) * Number(info.bsize);
  }

  async ensureSpace(bytes) {
    const free = await this.freeBytes();
    if (free - bytes < this.#minFreeBytes) {
      throw new StorageError('insufficient_storage', 'Sem espaço livre suficiente no servidor para esta gravação.');
    }
  }

  // Reserva de espaço para um upload em fluxo (blob): usada quando o tamanho
  // total não é confiável (sem Content-Length, o teto inteiro é reservado). As
  // reservas em voo são contadas, para que dois uploads simultâneos não
  // consumam juntos a reserva de disco. Devolve a função que libera a reserva.
  async reserveSpace(bytes) {
    const free = await this.freeBytes();
    if (free - bytes - this.#pendingBytes < this.#minFreeBytes) {
      throw new StorageError('insufficient_storage', 'Sem espaço livre suficiente no servidor para esta gravação.');
    }
    this.#pendingBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#pendingBytes = Math.max(0, this.#pendingBytes - bytes);
    };
  }

  counts() {
    let docs = 0;
    let tombstones = 0;
    for (const entries of Object.values(this.#state.docs)) {
      for (const entry of Object.values(entries)) {
        if (entry.deleted) tombstones += 1;
        else docs += 1;
      }
    }
    return { ...this.#counters, docs, tombstones };
  }

  privateFlags() {
    return Object.fromEntries(PRIVATE_NAMES.map((name) => [name, Boolean(this.#state.private[name])]));
  }

  // ── commit ──────────────────────────────────────────────────────────────
  async #commit(next) {
    await writeDurable(join(this.#dir, STATE_FILE), JSON.stringify(next), this.tmpDir);
    this.#state = next;
  }

  async #writeShardedFile(path, data) {
    try {
      await lstat(path);
      return false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const shard = join(path, '..');
    if (await ensureRealDir(shard)) await fsyncDir(join(shard, '..'));
    await writeDurable(path, data, this.tmpDir);
    return true;
  }

  #retain(sha) {
    this.#refs.set(sha, (this.#refs.get(sha) ?? 0) + 1);
  }

  async #release(sha, size) {
    const count = (this.#refs.get(sha) ?? 0) - 1;
    if (count > 0) {
      this.#refs.set(sha, count);
      return;
    }
    this.#refs.delete(sha);
    if (await removeQuiet(this.#objectPath(sha))) this.#counters.docBytes -= size;
  }

  // ── documentos ──────────────────────────────────────────────────────────
  entry(collection, id) {
    return this.#state.docs[collection]?.[id] ?? null;
  }

  list(collection) {
    const entries = this.#state.docs[collection] ?? {};
    return Object.keys(entries).sort().filter((id) => !entries[id].deleted).map((id) => ({ id, ...entries[id] }));
  }

  async readDoc(collection, id) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const entry = this.entry(collection, id);
      if (!entry || entry.deleted) return { entry, body: null };
      try {
        return { entry, body: await readNoFollow(this.#objectPath(entry.sha256)) };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // Um commit concorrente trocou o objeto entre a leitura do índice e a do arquivo.
        if (this.entry(collection, id) === entry) throw new StorageError('object_missing', 'O corpo deste documento sumiu do data dir.');
      }
    }
    throw new StorageError('busy', 'Documento mudando rápido demais; tente de novo.');
  }

  #withDoc(collection, id, entry, seq) {
    const state = this.#state;
    return { ...state, seq, docs: { ...state.docs, [collection]: { ...(state.docs[collection] ?? {}), [id]: entry } } };
  }

  // body: Buffer com o JSON canônico. Precondição: { ifMatch: rev } ou { ifNoneMatch: true }.
  putDoc(collection, id, body, { ifMatch = null, ifNoneMatch = false } = {}) {
    return this.#mutex.run(async () => {
      const current = this.entry(collection, id);
      const live = Boolean(current && !current.deleted);
      if (ifNoneMatch ? live : (!live || current.rev !== ifMatch)) throw new PreconditionError(current);
      await this.ensureSpace(body.length * 2 + JSON.stringify(this.#state).length);
      const sha = sha256Hex(body);
      const wrote = await this.#writeShardedFile(this.#objectPath(sha), body);
      const seq = this.#state.seq + 1;
      const entry = { rev: String(seq), sha256: sha, size: body.length, updatedAt: this.#now().toISOString() };
      try {
        await this.#commit(this.#withDoc(collection, id, entry, seq));
      } catch (error) {
        if (wrote && !this.#refs.has(sha)) await removeQuiet(this.#objectPath(sha)).catch(() => {});
        throw error;
      }
      if (wrote) this.#counters.docBytes += body.length;
      this.#retain(sha);
      if (live) await this.#release(current.sha256, current.size);
      return { entry, created: !live };
    });
  }

  deleteDoc(collection, id, { ifMatch }) {
    return this.#mutex.run(async () => {
      const current = this.entry(collection, id);
      if (!current || current.deleted) return { entry: current, deleted: false };
      if (current.rev !== ifMatch) throw new PreconditionError(current);
      const seq = this.#state.seq + 1;
      const entry = { rev: String(seq), deleted: true, updatedAt: this.#now().toISOString() };
      await this.#commit(this.#withDoc(collection, id, entry, seq));
      await this.#release(current.sha256, current.size);
      return { entry, deleted: true };
    });
  }

  changes(since, limit) {
    const all = [];
    for (const [collection, entries] of Object.entries(this.#state.docs)) {
      for (const [id, entry] of Object.entries(entries)) {
        const rev = Number(entry.rev);
        if (rev > since) all.push({ seq: rev, collection, id, entry });
      }
    }
    all.sort((a, b) => a.seq - b.seq);
    return { items: all.slice(0, limit), more: all.length > limit };
  }

  pruneTombstones(maxAgeMs = TOMBSTONE_TTL_MS) {
    return this.#mutex.run(async () => {
      const cutoff = this.#now().getTime() - maxAgeMs;
      let floor = this.#state.floor;
      let pruned = 0;
      const docs = {};
      for (const [collection, entries] of Object.entries(this.#state.docs)) {
        docs[collection] = {};
        for (const [id, entry] of Object.entries(entries)) {
          if (entry.deleted && Date.parse(entry.updatedAt) < cutoff) {
            floor = Math.max(floor, Number(entry.rev));
            pruned += 1;
          } else {
            docs[collection][id] = entry;
          }
        }
      }
      if (pruned > 0) await this.#commit({ ...this.#state, floor, docs });
      return pruned;
    });
  }

  // ── privados ────────────────────────────────────────────────────────────
  async readPrivate(name) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const entry = this.#state.private[name] ?? null;
      if (!entry) return null;
      try {
        return { entry, body: await readNoFollow(this.#privatePath(entry.sha256)) };
      } catch (error) {
        if (error.code !== 'ENOENT' || this.#state.private[name] === entry) throw error;
      }
    }
    throw new StorageError('busy', 'Arquivo privado mudando rápido demais; tente de novo.');
  }

  async #releasePrivate(entry, privateMap) {
    if (!entry || Object.values(privateMap).some((other) => other.sha256 === entry.sha256)) return;
    if (await removeQuiet(this.#privatePath(entry.sha256))) this.#counters.privateBytes -= entry.size;
  }

  putPrivate(name, body) {
    return this.#mutex.run(async () => {
      await this.ensureSpace(body.length);
      const sha = sha256Hex(body);
      const path = this.#privatePath(sha);
      let wrote = false;
      if (!(await lstat(path).then(() => true, () => false))) {
        await writeDurable(path, body, this.tmpDir);
        wrote = true;
      }
      const previous = this.#state.private[name] ?? null;
      const entry = { sha256: sha, size: body.length, updatedAt: this.#now().toISOString() };
      const privateMap = { ...this.#state.private, [name]: entry };
      try {
        await this.#commit({ ...this.#state, private: privateMap });
      } catch (error) {
        if (wrote && !Object.values(this.#state.private).some((other) => other.sha256 === sha)) await removeQuiet(path).catch(() => {});
        throw error;
      }
      if (wrote) this.#counters.privateBytes += body.length;
      await this.#releasePrivate(previous, privateMap);
      return { entry, created: !previous };
    });
  }

  deletePrivate(name) {
    return this.#mutex.run(async () => {
      const previous = this.#state.private[name] ?? null;
      if (!previous) return false;
      const privateMap = { ...this.#state.private };
      delete privateMap[name];
      await this.#commit({ ...this.#state, private: privateMap });
      await this.#releasePrivate(previous, privateMap);
      return true;
    });
  }

  // ── blobs ───────────────────────────────────────────────────────────────
  async openBlob(sha) {
    try {
      const handle = await openRead(this.#blobPath(sha));
      const info = await handle.stat();
      if (!info.isFile()) {
        await handle.close();
        return null;
      }
      return { handle, size: info.size };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ELOOP') return null;
      throw error;
    }
  }

  // O temporário já foi gravado, verificado e sincronizado pelo chamador.
  commitBlob(temporary, sha, size) {
    return this.#mutex.run(async () => {
      const path = this.#blobPath(sha);
      if (await lstat(path).then(() => true, () => false)) {
        await removeQuiet(temporary);
        return { created: false };
      }
      const shard = join(path, '..');
      if (await ensureRealDir(shard)) await fsyncDir(join(shard, '..'));
      await rename(temporary, path);
      await fsyncDir(shard);
      this.#counters.blobs += 1;
      this.#counters.blobBytes += size;
      return { created: true };
    });
  }

  deleteBlob(sha) {
    return this.#mutex.run(async () => {
      const path = this.#blobPath(sha);
      let size;
      try {
        const info = await lstat(path);
        if (!info.isFile()) return false;
        size = info.size;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
      await unlink(path);
      await fsyncDir(join(path, '..'));
      this.#counters.blobs -= 1;
      this.#counters.blobBytes -= size;
      return true;
    });
  }

  // ── snapshot e restauração (chamar dentro de exclusive) ───────────────────
  async snapshotUnlocked() {
    const collections = {};
    for (const collection of COLLECTIONS) {
      const entries = this.#state.docs[collection] ?? {};
      const items = [];
      for (const id of Object.keys(entries).sort()) {
        const entry = entries[id];
        if (entry.deleted) continue;
        const body = await readNoFollow(this.#objectPath(entry.sha256));
        items.push({ id, rev: entry.rev, updatedAt: entry.updatedAt, sha256: entry.sha256, size: entry.size, body: JSON.parse(body.toString('utf8')) });
      }
      if (items.length > 0) collections[collection] = items;
    }
    const privateFiles = {};
    for (const name of PRIVATE_NAMES) {
      const entry = this.#state.private[name];
      if (!entry) continue;
      const body = await readNoFollow(this.#privatePath(entry.sha256));
      privateFiles[name] = { updatedAt: entry.updatedAt, sha256: entry.sha256, body: JSON.parse(body.toString('utf8')) };
    }
    const blobs = (await listShardedFiles(join(this.#dir, 'blobs'))).sort((a, b) => a.sha256.localeCompare(b.sha256));
    return { dataId: this.#state.dataId, seq: this.#state.seq, collections, private: privateFiles, blobs };
  }

  // snapshot já validado: { collections: {c: [{id, body}]}, private: {name: {body}} }.
  // Tudo ganha rev nova (seq só cresce); docs vivos ausentes viram lápides.
  // `stagedBlobs`: [{ sha256, size, path }] já validados (tamanho e sha256) e
  // gravados em tmp/; são renomeados para blobs/ antes do manifesto. Blob que já
  // existe com o MESMO tamanho é idêntico (endereçado por conteúdo) e só descarta
  // o temporário; um arquivo de tamanho diferente é substituído pelo do arquivo
  // (protege contra blob truncado no disco).
  async restoreUnlocked(snapshot, stagedBlobs = []) {
    const updatedAt = this.#now().toISOString();
    let seq = this.#state.seq;
    let installed = 0;
    for (const blob of stagedBlobs) {
      const path = this.#blobPath(blob.sha256);
      const existing = await lstat(path).catch(() => null);
      if (existing?.isFile() && existing.size === blob.size) {
        await removeQuiet(blob.path);
        continue;
      }
      const shard = join(path, '..');
      if (await ensureRealDir(shard)) await fsyncDir(join(shard, '..'));
      await rename(blob.path, path);
      await fsyncDir(shard);
      installed += 1;
    }
    const docs = {};
    const written = [];
    let restored = 0;
    let tombstoned = 0;
    for (const collection of COLLECTIONS) {
      const current = this.#state.docs[collection] ?? {};
      const incoming = new Map((snapshot.collections[collection] ?? []).map((item) => [item.id, item]));
      const next = {};
      for (const [id, entry] of Object.entries(current)) {
        if (incoming.has(id)) continue;
        if (entry.deleted) next[id] = entry;
        else {
          seq += 1;
          next[id] = { rev: String(seq), deleted: true, updatedAt };
          tombstoned += 1;
        }
      }
      for (const [id, item] of incoming) {
        const body = Buffer.from(JSON.stringify(item.body));
        const sha = sha256Hex(body);
        if (await this.#writeShardedFile(this.#objectPath(sha), body)) written.push(sha);
        seq += 1;
        next[id] = { rev: String(seq), sha256: sha, size: body.length, updatedAt };
        restored += 1;
      }
      if (Object.keys(next).length > 0) docs[collection] = next;
    }
    const privateMap = {};
    for (const name of PRIVATE_NAMES) {
      const item = snapshot.private?.[name];
      if (!item) continue;
      const body = Buffer.from(JSON.stringify(item.body));
      const sha = sha256Hex(body);
      const path = this.#privatePath(sha);
      if (!(await lstat(path).then(() => true, () => false))) await writeDurable(path, body, this.tmpDir);
      privateMap[name] = { sha256: sha, size: body.length, updatedAt };
    }
    await this.#commit({ ...this.#state, seq, docs, private: privateMap });
    this.#counters.docBytes = 0;
    this.#counters.privateBytes = 0;
    this.#counters.blobs = 0;
    this.#counters.blobBytes = 0;
    await this.init();
    return { restored, tombstoned, private: Object.keys(privateMap).length, seq, objectsWritten: written.length, blobsInstalled: installed };
  }

  async hasBlob(sha) {
    return lstat(this.#blobPath(sha)).then((info) => info.isFile(), () => false);
  }
}

// realpath do maior prefixo existente + o resto do caminho (que ainda não existe).
async function resolveExisting(path) {
  const absolute = resolve(path);
  const missing = [];
  let current = absolute;
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.push(basename(current));
      current = parent;
    }
  }
}

// Abre (ou inicializa) o data dir. guardRoots: pastas que o data dir não pode
// conter nem estar dentro (repositório, raiz estática).
export async function openStore({ dataDir, guardRoots = [], now = () => new Date(), minFreeBytes = 0 }) {
  if (!isAbsolute(dataDir)) throw new StorageError('unsafe_location', 'O data dir precisa ser um caminho absoluto.');
  const guarded = await Promise.all(guardRoots.map((root) => resolveExisting(root)));
  const refuseInside = (dir) => {
    if (guarded.some((root) => inside(dir, root) || inside(root, dir))) {
      throw new StorageError('unsafe_location', 'O data dir precisa ficar fora do repositório e da pasta estática (e não pode contê-los).');
    }
  };
  // Antes de criar qualquer pasta: o caminho pedido já não pode cair no repositório.
  refuseInside(await resolveExisting(dataDir));
  await mkdir(dataDir, { recursive: true, mode: DIR_MODE });
  const dir = await realpath(dataDir);
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new StorageError('unsafe_location', 'O data dir não é uma pasta.');
  refuseInside(dir);

  let marker = null;
  let entries = await readdir(dir);
  if (!entries.includes(MARKER_FILE)) {
    const leftovers = entries.filter((name) => name.startsWith(INIT_PREFIX));
    if (leftovers.length !== entries.length) {
      throw new StorageError('foreign_dir', 'O data dir já tem arquivos que não são do GrooveGoblin; use uma pasta vazia ou nova.');
    }
    for (const name of leftovers) await removeQuiet(join(dir, name));
    marker = { format: MARKER_FORMAT, version: 1, dataId: randomBytes(8).toString('hex'), createdAt: now().toISOString() };
    const temporary = join(dir, `${INIT_PREFIX}${randomBytes(6).toString('hex')}`);
    const handle = await openExclusive(temporary);
    try {
      await handle.writeFile(`${JSON.stringify(marker)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(dir, MARKER_FILE));
    await fsyncDir(dir);
    entries = await readdir(dir);
  } else {
    try {
      marker = JSON.parse((await readNoFollow(join(dir, MARKER_FILE))).toString('utf8'));
    } catch {
      marker = null;
    }
    if (!marker || marker.format !== MARKER_FORMAT || marker.version !== 1 || !DATA_ID_PATTERN.test(marker.dataId)) {
      throw new StorageError('state_corrupt', 'O marcador do data dir está ilegível; nada foi alterado.');
    }
  }

  // state.json ausente num data dir que TEM dados governados pelo manifesto
  // (objetos/privados): sintetizar um estado vazio apagaria tudo como órfão.
  // Recusa sem mutar. Só um data dir recém-marcado (init interrompido) — ou um
  // que só recebeu blobs, que o manifesto não governa — começa do estado vazio.
  if (!entries.includes(STATE_FILE) && await hasStoredData(dir)) {
    throw new StorageError('state_corrupt', 'O manifesto (state.json) sumiu, mas há documentos ou privados no data dir; nada foi alterado. Restaure um backup.');
  }

  const lockContent = await acquireLock(dir);
  try {
    for (const name of SUBDIRS) await ensureRealDir(join(dir, name));
    await emptyDir(join(dir, 'tmp'));
    let state;
    if (entries.includes(STATE_FILE)) {
      try {
        state = JSON.parse((await readNoFollow(join(dir, STATE_FILE))).toString('utf8'));
      } catch {
        state = null;
      }
      if (!validateState(state, marker.dataId)) {
        throw new StorageError('state_corrupt', 'O manifesto do data dir (state.json) está ilegível ou inconsistente; nada foi alterado. Restaure um backup.');
      }
    } else {
      state = emptyState(marker.dataId);
    }
    await fsyncDir(dir);
    const store = new DataStore(dir, lockContent, state, { now, minFreeBytes });
    await store.init();
    return store;
  } catch (error) {
    const current = await readNoFollow(join(dir, LOCK_FILE)).then((data) => data.toString('utf8'), () => null);
    if (current === lockContent) await removeQuiet(join(dir, LOCK_FILE));
    throw error;
  }
}
