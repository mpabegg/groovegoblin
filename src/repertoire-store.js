// Persistência local do repertório em IndexedDB: mídia (Blobs originais e WAVs
// renderizados) separada dos metadados para que listar a biblioteca não carregue
// áudio. Registros ilegíveis NÃO são apagados silenciosamente: voltam em
// `corrupt` para a interface oferecer cópia bruta ou remoção explícita.

import { normalizeItem, normalizeExercise, normalizeSetlist } from './repertoire.js';

export const DB_NAME = 'groovegoblin-repertoire';
export const DB_VERSION = 1;
export const STORE_NAMES = Object.freeze(['items', 'media', 'analyses', 'exercises', 'setlists']);
const NORMALIZERS = { items: normalizeItem, exercises: normalizeExercise, setlists: normalizeSetlist };

export class RepertoireStorageError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'RepertoireStorageError';
    this.code = code;
    this.cause = cause;
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1).replace('.', ',')} ${units[unit]}`;
}

export function describeStorageError(error) {
  if (error instanceof RepertoireStorageError) return error;
  const name = error?.name ?? '';
  if (name === 'QuotaExceededError' || /quota/i.test(error?.message ?? '')) {
    return new RepertoireStorageError('quota', 'O espaço de armazenamento local do navegador acabou. Remova itens ou derivados que não usa, ou peça armazenamento persistente, e tente salvar de novo.', error);
  }
  if (name === 'InvalidStateError' || name === 'UnknownError') {
    return new RepertoireStorageError('unavailable', 'O banco local do navegador ficou indisponível (aba privada, limpeza de dados ou erro interno). Os itens desta sessão continuam na memória até fechar a página.', error);
  }
  if (name === 'VersionError') {
    return new RepertoireStorageError('version', 'O banco local foi criado por uma versão mais nova do GrooveGoblin. Atualize a página ou o aplicativo.', error);
  }
  return new RepertoireStorageError('unknown', `Falha ao acessar o armazenamento local: ${error?.message || name || 'erro desconhecido'}.`, error);
}

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(describeStorageError(error));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(describeStorageError(request.error));
    request.onblocked = () => reject(new RepertoireStorageError('blocked', 'Outra aba do GrooveGoblin está bloqueando a atualização do banco local. Feche as outras abas e recarregue.'));
  });
}

function memoryBackend() {
  const stores = Object.fromEntries(STORE_NAMES.map(name => [name, new Map()]));
  return {
    async getAll(store) { return [...stores[store].values()].map(value => structuredClone(value)); },
    async get(store, id) { const value = stores[store].get(id); return value === undefined ? undefined : structuredClone(value); },
    async put(store, value) { stores[store].set(value.id, structuredClone(value)); },
    async delete(store, id) { stores[store].delete(id); },
  };
}

function idbBackend(db) {
  const run = (store, mode, action) => new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(store, mode);
    } catch (error) {
      reject(describeStorageError(error));
      return;
    }
    let result;
    const request = action(transaction.objectStore(store));
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(describeStorageError(transaction.error || request.error));
    transaction.onerror = event => event.preventDefault();
  });
  return {
    getAll: store => run(store, 'readonly', objectStore => objectStore.getAll()),
    get: (store, id) => run(store, 'readonly', objectStore => objectStore.get(id)),
    put: (store, value) => run(store, 'readwrite', objectStore => objectStore.put(value)),
    delete: (store, id) => run(store, 'readwrite', objectStore => objectStore.delete(id)),
  };
}

// Sempre resolve: sem IndexedDB devolve um armazenamento em memória com `persistent: false`
// e a explicação em `error`, para a interface avisar que nada sobreviverá ao recarregar.
export async function openRepertoireStore({ indexedDB = globalThis.indexedDB, storageManager = globalThis.navigator?.storage } = {}) {
  let backend;
  let persistent = false;
  let error = null;
  if (!indexedDB) {
    error = new RepertoireStorageError('unavailable', 'Este navegador não oferece IndexedDB; a biblioteca funciona só nesta aba e será perdida ao fechar.');
    backend = memoryBackend();
  } else {
    try {
      const db = await openDatabase(indexedDB);
      db.onversionchange = () => db.close();
      backend = idbBackend(db);
      persistent = true;
    } catch (cause) {
      error = describeStorageError(cause);
      backend = memoryBackend();
    }
  }

  async function listNormalized(store) {
    const records = await backend.getAll(store);
    const valid = [];
    const corrupt = [];
    for (const raw of records) {
      const normalized = NORMALIZERS[store](raw);
      if (normalized) valid.push(normalized);
      else corrupt.push({ store, id: raw?.id ?? null, raw });
    }
    return { valid, corrupt };
  }

  return {
    persistent,
    error,
    async loadAll() {
      const [items, exercises, setlists] = await Promise.all(['items', 'exercises', 'setlists'].map(listNormalized));
      return {
        items: items.valid.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        exercises: exercises.valid.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        setlists: setlists.valid.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        corrupt: [...items.corrupt, ...exercises.corrupt, ...setlists.corrupt],
      };
    },
    putItem: item => backend.put('items', item),
    putExercise: exercise => backend.put('exercises', exercise),
    putSetlist: setlist => backend.put('setlists', setlist),
    deleteExercise: id => backend.delete('exercises', id),
    deleteSetlist: id => backend.delete('setlists', id),
    deleteCorrupt: (store, id) => backend.delete(store, id),
    async putMedia(id, blob) {
      await backend.put('media', { id, blob });
    },
    async getMedia(id) {
      const record = await backend.get('media', id);
      return record?.blob ?? null;
    },
    async deleteItem(item) {
      await backend.delete('items', item.id);
      await backend.delete('analyses', item.id);
      if (item.media) await backend.delete('media', item.media.id);
    },
    async putAnalysis(id, analysis) {
      await backend.put('analyses', { id, analysis });
    },
    async getAnalysis(id) {
      const record = await backend.get('analyses', id);
      return record?.analysis ?? null;
    },
    async estimate() {
      if (!storageManager?.estimate) return null;
      try {
        const { usage, quota } = await storageManager.estimate();
        const persisted = storageManager.persisted ? await storageManager.persisted() : false;
        return { usage, quota, persisted };
      } catch {
        return null;
      }
    },
    async requestPersistence() {
      if (!storageManager?.persist) return false;
      return storageManager.persist();
    },
  };
}
