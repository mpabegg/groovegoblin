// Snapshots do data dir num único arquivo autocontido: cabeçalho, corpos dos
// documentos, privados (mapa/catálogo) e os BYTES de cada blob, em gzip de
// NDJSON lido/escrito em fluxo — memória limitada mesmo com blobs de centenas
// de MiB e muitos blobs. Formato (uma linha JSON por registro, nesta ordem):
//
//   {"type":"header",format,version,createdAt,dataId,seq}
//   {"type":"doc",collection,id,rev,updatedAt,sha256,size,body}
//   {"type":"private",name,updatedAt,sha256,size,body}
//   {"type":"blob-start",sha256,size}
//   {"type":"blob-chunk",data}                         // base64, <= 1 MiB crus
//   {"type":"blob-end",sha256,size}
//   {"type":"footer",docs,private,blobs,blobBytes}     // último registro
//
// Nada mais entra no arquivo: nem backups antigos, nem lock, nem tmp/, nem a
// pasta de entrada de arquivos do curso (staging): só objects/ + private/ +
// blobs/ referenciados pelo estado.
//
// Consistência: os METADADOS (estado + lista de blobs com tamanho) são
// capturados dentro do mutex dos commits; os bytes dos blobs são lidos fora do
// mutex. Se um blob sumir no meio (apagado por uma escrita concorrente), a
// captura inteira é refeita; se ainda assim não fechar, falha sem gravar nada —
// nunca sai um backup parcial que pareça bom.
//
// Leitura/validação: `readArchive` percorre o fluxo e só devolve depois de
// conferir cabeçalho, ids repetidos, hashes dos corpos, tamanho e sha256 de
// CADA blob (lendo os pedaços em ordem, com teto por pedaço) e o rodapé com as
// contagens. Sem rodapé, truncado, hash errado ou blob repetido → recusa.

import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { StorageError, commitRename, openExclusive, openRead, removeQuiet, tempName } from './fsutil.js';
import { COLLECTIONS, PRIVATE_NAMES, SHA256_PATTERN, isValidId, sha256Hex } from './store.js';

export const BACKUP_FORMAT = 'groovegoblin-server-backup';
export const BACKUP_VERSION = 2;
export const BACKUP_EXTENSION = 'ndjson.gz';
export const DAILY_PATTERN = /^groovegoblin-(\d{4}-\d{2}-\d{2})\.ndjson\.gz$/;
export const PRE_RESTORE_PATTERN = /^pre-restore-(\d{8}T\d{6}Z)\.ndjson\.gz$/;
export const BLOB_CHUNK_BYTES = 1024 * 1024;
// Teto de um corpo gravável de documento (curso) ou arquivo privado — o MESMO
// número de LIMITS.course/LIMITS.private em api.js. O teto de linha do arquivo
// é derivado dele MAIS a folga de metadados (campos + JSON do registro), para o
// escritor nunca emitir uma linha que o readArchive recuse. Um corpo maior que
// isso não é gravável pelas rotas (ver o 413 do convert e dos PUT), então o
// arquivo continua legível por construção.
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;
export const RECORD_OVERHEAD_BYTES = 512;
export const MAX_LINE_BYTES = MAX_RECORD_BYTES + RECORD_OVERHEAD_BYTES;
export const MAX_RACE_ATTEMPTS = 3;
const DATA_ID_PATTERN = /^[0-9a-f]{16}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HOUR_MS = 60 * 60 * 1000;

export function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

export function dailyName(date) {
  return `groovegoblin-${date}.${BACKUP_EXTENSION}`;
}

export function downloadName(date) {
  return `groovegoblin-backup-${date}.${BACKUP_EXTENSION}`;
}

export function preRestoreName(date) {
  return `pre-restore-${date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.${BACKUP_EXTENSION}`;
}

function invalid(message) {
  return new StorageError('backup_invalid', message);
}

function raced() {
  return new StorageError('backup_raced', 'Um blob mudou durante a cópia de segurança.');
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

function line(record) {
  const json = JSON.stringify(record);
  // O leitor recusa qualquer linha acima de MAX_LINE_BYTES: nunca gravar um
  // arquivo que ele mesmo rejeitaria (melhor falhar o backup que produzi-lo).
  if (Buffer.byteLength(json) > MAX_LINE_BYTES) {
    throw new StorageError('backup_invalid', 'Um registro do backup passaria do teto de linha; gravação recusada.');
  }
  return `${json}\n`;
}

export async function listBackups(store) {
  const backups = [];
  for (const entry of await readdir(store.backupsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = DAILY_PATTERN.exec(entry.name);
    if (!match) continue;
    const info = await lstat(join(store.backupsDir, entry.name));
    backups.push({ name: entry.name, date: match[1], size: info.size, createdAt: info.mtime.toISOString() });
  }
  return backups.sort((a, b) => b.date.localeCompare(a.date));
}

export async function backupBytes(store) {
  let total = 0;
  for (const entry of await readdir(store.backupsDir, { withFileTypes: true })) {
    if (entry.isFile() && (DAILY_PATTERN.test(entry.name) || PRE_RESTORE_PATTERN.test(entry.name))) {
      total += (await lstat(join(store.backupsDir, entry.name))).size;
    }
  }
  return total;
}

// Metadados de um instante, sob o mutex dos commits. NÃO inclui bytes de blob.
export async function captureSnapshot(store) {
  return store.exclusive(async () => {
    const snapshot = await store.snapshotUnlocked();
    return { ...snapshot, createdAt: store.now().toISOString() };
  });
}

// Teto conservador do arquivo descompactado (os pedaços viram base64: 4/3).
function archiveRawBytes(snapshot) {
  let total = 4096;
  for (const items of Object.values(snapshot.collections)) {
    for (const item of items) total += Buffer.byteLength(JSON.stringify(item.body)) + RECORD_OVERHEAD_BYTES;
  }
  for (const item of Object.values(snapshot.private)) {
    total += Buffer.byteLength(JSON.stringify(item.body)) + RECORD_OVERHEAD_BYTES;
  }
  for (const blob of snapshot.blobs) total += Math.ceil((blob.size * 4) / 3) + RECORD_OVERHEAD_BYTES;
  return total;
}

// Registros do arquivo, em ordem, com o fluxo de leitura dos blobs.
async function* archiveRecords(store, snapshot) {
  yield line({
    type: 'header',
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: snapshot.createdAt,
    dataId: snapshot.dataId,
    seq: snapshot.seq,
  });
  let docs = 0;
  let privateFiles = 0;
  let blobs = 0;
  let blobBytes = 0;
  for (const collection of COLLECTIONS) {
    for (const item of snapshot.collections[collection] ?? []) {
      docs += 1;
      yield line({
        type: 'doc',
        collection,
        id: item.id,
        rev: item.rev,
        updatedAt: item.updatedAt,
        sha256: item.sha256,
        size: item.size,
        body: item.body,
      });
    }
  }
  for (const name of PRIVATE_NAMES) {
    const item = snapshot.private[name];
    if (!item) continue;
    privateFiles += 1;
    yield line({ type: 'private', name, updatedAt: item.updatedAt, sha256: item.sha256, size: item.size, body: item.body });
  }
  const chunk = Buffer.allocUnsafe(BLOB_CHUNK_BYTES);
  for (const blob of snapshot.blobs) {
    const opened = await store.openBlob(blob.sha256);
    if (!opened) throw raced();
    try {
      if (opened.size !== blob.size) throw raced();
      blobs += 1;
      blobBytes += blob.size;
      yield line({ type: 'blob-start', sha256: blob.sha256, size: blob.size });
      let position = 0;
      for (;;) {
        const { bytesRead } = await opened.handle.read(chunk, 0, BLOB_CHUNK_BYTES, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        yield line({ type: 'blob-chunk', data: chunk.subarray(0, bytesRead).toString('base64') });
      }
      if (position !== blob.size) throw raced();
      yield line({ type: 'blob-end', sha256: blob.sha256, size: blob.size });
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }
  yield line({ type: 'footer', docs, private: privateFiles, blobs, blobBytes });
}

// Grava o arquivo completo por rename atômico em backups/ (nome só gerado aqui).
export async function writeArchive(store, name, snapshot) {
  await store.ensureSpace(Math.ceil(archiveRawBytes(snapshot) * 1.02) + 65536);
  const temporary = join(store.tmpDir, tempName('backup'));
  const handle = await openExclusive(temporary);
  try {
    await pipeline(
      Readable.from(archiveRecords(store, snapshot)),
      createGzip({ level: 6 }),
      handle.createWriteStream({ flush: true }),
    );
  } catch (error) {
    await handle.close().catch(() => {});
    await removeQuiet(temporary).catch(() => {});
    throw error;
  }
  const check = await openRead(temporary);
  try {
    await check.sync();
  } finally {
    await check.close();
  }
  const target = join(store.backupsDir, name);
  await commitRename(temporary, target);
  return { name, size: (await lstat(target)).size, createdAt: snapshot.createdAt, seq: snapshot.seq };
}

export async function pruneBackups(store, keep) {
  const backups = await listBackups(store);
  let removed = 0;
  for (const old of backups.slice(keep)) {
    if (await removeQuiet(join(store.backupsDir, old.name))) removed += 1;
  }
  return removed;
}

// Cria (ou substitui) o snapshot do dia corrente em UTC e poda os antigos.
export async function createDailyBackup(store, { keep }) {
  await store.pruneTombstones();
  let lastRace = null;
  for (let attempt = 1; attempt <= MAX_RACE_ATTEMPTS; attempt += 1) {
    const snapshot = await captureSnapshot(store);
    const date = utcDate(new Date(snapshot.createdAt));
    try {
      const written = await writeArchive(store, dailyName(date), snapshot);
      return { ...written, date, pruned: await pruneBackups(store, keep) };
    } catch (error) {
      if (error.code !== 'backup_raced') throw error;
      lastRace = error;
    }
  }
  throw lastRace;
}

export async function ensureDailyBackup(store, { keep }) {
  const today = utcDate(store.now());
  const backups = await listBackups(store);
  if (backups.some((backup) => backup.date === today)) return null;
  return createDailyBackup(store, { keep });
}

// Snapshot de segurança ANTES de qualquer mutação: chamar com o mutex tomado
// (a restauração roda com o servidor parado, então não há corrida).
export async function writePreRestoreBackupUnlocked(store) {
  const snapshot = await store.snapshotUnlocked();
  const createdAt = store.now().toISOString();
  return writeArchive(store, preRestoreName(new Date(createdAt)), { ...snapshot, createdAt });
}

// Agenda: confere na subida e de hora em hora; nunca segura o processo vivo.
export function scheduleDailyBackups(store, { keep, log }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const made = await ensureDailyBackup(store, { keep });
      if (made) log(`backup diário criado (${made.pruned} antigos removidos)`);
    } catch (error) {
      log(`backup diário falhou: ${error.code ?? 'erro'}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 1000);
  const timer = setInterval(tick, HOUR_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// Lê o arquivo como fluxo: o gzip é descompactado linha a linha, com teto por
// linha e sem acumular os bytes dos blobs em memória. Com `stageDir`, os bytes
// de cada blob vão para um temporário ali (consumido pela restauração).
async function* archiveLines(path) {
  const handle = await openRead(path);
  const gunzip = createGunzip();
  pipeline(handle.createReadStream({ autoClose: true }), gunzip).catch(() => {});
  let buffer = Buffer.alloc(0);
  try {
    for await (const chunk of gunzip) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      let index = buffer.indexOf(0x0a);
      while (index !== -1) {
        const text = buffer.subarray(0, index);
        if (text.length > MAX_LINE_BYTES) throw invalid('O backup tem uma linha grande demais.');
        buffer = buffer.subarray(index + 1);
        if (text.length > 0) yield text;
        index = buffer.indexOf(0x0a);
      }
      if (buffer.length > MAX_LINE_BYTES) throw invalid('O backup tem uma linha grande demais.');
    }
    if (buffer.length > 0) throw invalid('O backup termina no meio de uma linha (arquivo truncado).');
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw invalid('O backup não é um gzip válido ou está truncado.');
  } finally {
    await handle.close().catch(() => {});
  }
}

// Valida o arquivo inteiro e devolve o conteúdo utilizável.
export async function readArchive(path, { stageDir = null } = {}) {
  let header = null;
  let footerSeen = false;
  let active = null;
  const collections = {};
  const privateFiles = {};
  const blobs = [];
  const seenDocs = new Set();
  const seenPrivate = new Set();
  const seenBlobs = new Set();
  const staged = [];
  let docs = 0;
  let privateCount = 0;
  let blobCount = 0;
  let blobBytes = 0;
  const fail = (message) => {
    throw invalid(message);
  };
  try {
    for await (const text of archiveLines(path)) {
      let record;
      try {
        record = JSON.parse(text.toString('utf8'));
      } catch {
        fail('O backup tem uma linha que não é JSON.');
      }
      if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.type !== 'string') {
        fail('O backup tem um registro inválido.');
      }
      if (footerSeen) fail('O backup tem registros depois do rodapé.');
      if (record.type === 'header') {
        if (header) fail('O backup tem mais de um cabeçalho.');
        if (active) fail('O backup abre um blob e não o fecha.');
        if (record.format !== BACKUP_FORMAT || record.version !== BACKUP_VERSION) fail('Arquivo não é um backup do servidor GrooveGoblin.');
        if (!DATA_ID_PATTERN.test(record.dataId) || !Number.isSafeInteger(record.seq) || record.seq < 0 || typeof record.createdAt !== 'string') {
          fail('O cabeçalho do backup está inválido.');
        }
        header = { createdAt: record.createdAt, dataId: record.dataId, seq: record.seq };
        continue;
      }
      if (!header) fail('O backup não começa pelo cabeçalho.');
      if (record.type === 'doc') {
        if (!COLLECTIONS.includes(record.collection) || !isValidId(record.id)) fail('O backup tem um documento inválido.');
        const key = `${record.collection}\u0000${record.id}`;
        if (seenDocs.has(key)) fail('O backup tem um documento repetido.');
        seenDocs.add(key);
        if (!record.body || typeof record.body !== 'object' || Array.isArray(record.body)) fail('O backup tem um documento sem corpo de objeto.');
        const canonical = Buffer.from(JSON.stringify(record.body));
        const digest = sha256Hex(canonical);
        if (record.sha256 !== undefined && record.sha256 !== digest) fail('O backup tem um documento corrompido (hash não confere).');
        if (record.size !== undefined && record.size !== canonical.length) fail('O backup tem um documento corrompido (tamanho não confere).');
        (collections[record.collection] ??= []).push({
          id: record.id,
          rev: typeof record.rev === 'string' ? record.rev : null,
          updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
          sha256: digest,
          body: record.body,
        });
        docs += 1;
        continue;
      }
      if (record.type === 'private') {
        if (!PRIVATE_NAMES.includes(record.name)) fail('O backup tem um arquivo privado desconhecido.');
        if (seenPrivate.has(record.name)) fail('O backup tem um arquivo privado repetido.');
        seenPrivate.add(record.name);
        if (!Object.hasOwn(record, 'body')) fail('O backup tem um arquivo privado sem corpo.');
        const canonical = Buffer.from(JSON.stringify(record.body));
        const digest = sha256Hex(canonical);
        if (record.sha256 !== undefined && record.sha256 !== digest) fail('O backup tem um arquivo privado corrompido.');
        if (record.size !== undefined && record.size !== canonical.length) fail('O backup tem um arquivo privado corrompido (tamanho não confere).');
        privateFiles[record.name] = { updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null, sha256: digest, body: record.body };
        privateCount += 1;
        continue;
      }
      if (record.type === 'blob-start') {
        if (active) fail('O backup abre um blob dentro de outro.');
        if (!SHA256_PATTERN.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 0) fail('O backup tem um blob inválido.');
        if (seenBlobs.has(record.sha256)) fail('O backup tem um blob repetido.');
        seenBlobs.add(record.sha256);
        blobCount += 1;
        blobBytes += record.size;
        let handle = null;
        let stagedPath = null;
        if (stageDir) {
          stagedPath = join(stageDir, tempName('stage'));
          handle = await openExclusive(stagedPath);
          staged.push(stagedPath);
        }
        active = { sha256: record.sha256, size: record.size, handle, stagedPath, hash: createHash('sha256'), received: 0 };
        continue;
      }
      if (record.type === 'blob-chunk') {
        if (!active) fail('O backup tem um pedaço de blob fora de um blob.');
        if (typeof record.data !== 'string' || !BASE64_PATTERN.test(record.data)) fail('O backup tem um pedaço de blob inválido.');
        const bytes = Buffer.from(record.data, 'base64');
        if (bytes.length > BLOB_CHUNK_BYTES || bytes.toString('base64') !== record.data) fail('O backup tem um pedaço de blob inválido.');
        active.received += bytes.length;
        if (active.received > active.size) fail('O backup tem um blob maior que o tamanho declarado.');
        active.hash.update(bytes);
        if (active.handle) await writeAll(active.handle, bytes);
        continue;
      }
      if (record.type === 'blob-end') {
        if (!active) fail('O backup fecha um blob que não abriu.');
        if (record.sha256 !== active.sha256 || record.size !== active.size) fail('O fim de um blob não confere com o começo.');
        if (active.received !== active.size) fail('O backup tem um blob truncado.');
        if (active.hash.digest('hex') !== active.sha256) fail('O backup tem um blob corrompido (hash não confere).');
        if (active.handle) {
          await active.handle.sync();
          await active.handle.close();
        }
        blobs.push({ sha256: active.sha256, size: active.size, path: active.stagedPath });
        active = null;
        continue;
      }
      if (record.type === 'footer') {
        if (active) fail('O backup deixa um blob aberto no rodapé.');
        const counts = [record.docs, record.private, record.blobs, record.blobBytes];
        if (counts.some((value) => !Number.isSafeInteger(value) || value < 0)) fail('O rodapé do backup está inválido.');
        if (record.docs !== docs || record.private !== privateCount || record.blobs !== blobCount || record.blobBytes !== blobBytes) {
          fail('O backup está incompleto (as contagens do rodapé não conferem).');
        }
        footerSeen = true;
        continue;
      }
      fail('O backup tem um registro desconhecido.');
    }
    if (!header) fail('O arquivo não é um backup do GrooveGoblin.');
    if (!footerSeen) fail('O backup está incompleto: falta o rodapé.');
  } catch (error) {
    if (active?.handle) await active.handle.close().catch(() => {});
    for (const file of staged) await removeQuiet(file).catch(() => {});
    throw error;
  }
  return {
    createdAt: header.createdAt,
    dataId: header.dataId,
    seq: header.seq,
    collections,
    private: privateFiles,
    blobs,
    counts: { docs, private: privateCount, blobs: blobCount, blobBytes },
  };
}
