// Apoio dos testes da aula (rodada 5, etapa 6).
//
// Tudo aqui é FICTÍCIO: "Curso de Exemplo", "Módulo 1", "Aula 3" e endereços em
// example.invalid. Nenhum curso, título, arquivo ou conteúdo real entra nos
// testes. O apoio tem três partes:
//  - construtores de documento `groovegoblin-course` v1 válido;
//  - backend em memória com a interface usada pelas lojas (getAll/get/put/
//    writeBatch/delete, com `{ store, id, remove: true }` no lote);
//  - IndexedDB falso fiel a keyPath para exercitar o caminho real do banco de
//    anexos (open/upgrade/transação/put/delete) e um localStorage em memória
//    para a biblioteca de exercícios.

export function lesson(id, overrides = {}) {
  return {
    id,
    title: `Aula ${id}`,
    url: `https://example.invalid/${id}`,
    type: 'aula',
    hasVideo: false,
    resources: [],
    resourceRefs: [],
    suggestedExercises: [],
    ...overrides,
  };
}

export function section(id, lessons, overrides = {}) {
  return { id, title: `Módulo ${id}`, type: 'módulo', lessons, ...overrides };
}

export function courseDocument(overrides = {}) {
  return {
    format: 'groovegoblin-course',
    version: 1,
    course: {
      id: 'curso-exemplo',
      title: 'Curso de Exemplo',
      author: 'Autor de Exemplo',
      instrument: 'bass',
      strings: 4,
      sections: [
        section('modulo-1', [
          lesson('aula-1', {
            resources: [{ id: 'material-1', name: 'Apostila de Exemplo', extension: 'pdf', role: 'apostila' }],
            suggestedExercises: [{ id: 'ex-aula-1', title: 'Exercício de Exemplo', initialBpm: 60, targetBpm: 90, bars: 4 }],
          }),
          lesson('aula-2', { resourceRefs: [{ lessonId: 'aula-1', resourceId: 'material-1' }] }),
          lesson('aula-3', { hasVideo: true, videoSeconds: 361 }),
        ]),
        section('boas-vindas', [lesson('aula-0')], { title: 'Boas-vindas', type: 'boas-vindas' }),
      ],
      ...overrides,
    },
  };
}

export function courseText(document = courseDocument()) {
  return JSON.stringify(document);
}

// Backend em memória com a interface das lojas (curso e anexos).
export function memoryBackend({ failNextWrite = null, keyPaths = { courses: 'id', states: 'courseId' } } = {}) {
  const stores = new Map();
  const storeOf = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  let failures = failNextWrite;
  const maybeFail = () => {
    if (!failures) return;
    const error = failures;
    failures = null;
    throw error;
  };
  const keyOf = (name, value) => value[keyPaths[name] ?? 'id'];
  return {
    written: [],
    keyPaths,
    failNext(error) { failures = error; },
    async getAll(name) { return [...storeOf(name).values()].map(value => structuredClone(value)); },
    async get(name, id) {
      const value = storeOf(name).get(id);
      return value === undefined ? undefined : structuredClone(value);
    },
    async put(name, value) {
      maybeFail();
      storeOf(name).set(keyOf(name, value), structuredClone(value));
      this.written.push(name);
    },
    async writeBatch(entries) {
      maybeFail();
      for (const entry of entries) {
        if (entry.remove) storeOf(entry.store).delete(entry.id);
        else storeOf(entry.store).set(keyOf(entry.store, entry.value), structuredClone(entry.value));
        this.written.push(entry.store);
      }
    },
    async delete(name, id) { storeOf(name).delete(id); },
    raw(name) { return [...storeOf(name).values()]; },
    seed(name, value) { storeOf(name).set(keyOf(name, value), value); },
  };
}

// IndexedDB falso o suficiente para o caminho real do banco de anexos:
// open com onupgradeneeded/onsuccess, createObjectStore, transaction com uma ou
// mais stores, objectStore.get/getAll/put/delete e oncomplete determinístico.
export function fakeIndexedDB() {
  const databases = new Map();

  class Request {
    constructor() {
      this.result = undefined;
      this.error = null;
      this.onsuccess = null;
      this.onerror = null;
    }
    settle(result) {
      queueMicrotask(() => {
        this.result = result;
        this.onsuccess?.();
      });
    }
    fail(error) {
      queueMicrotask(() => {
        this.error = error;
        this.onerror?.();
      });
    }
  }

  class Store {
    constructor(keyPath) {
      this.keyPath = keyPath;
      this.records = new Map();
    }
    keyOf(value) { return value?.[this.keyPath]; }
  }

  class ObjectStore {
    constructor(store) {
      this.store = store;
    }
    get(id) {
      const request = new Request();
      request.settle(this.store.records.get(id));
      return request;
    }
    getAll() {
      const request = new Request();
      request.settle([...this.store.records.values()]);
      return request;
    }
    put(value) {
      const request = new Request();
      const key = this.store.keyOf(value);
      if (key === undefined || key === null) {
        request.fail(new Error('chave ausente'));
        return request;
      }
      this.store.records.set(key, value);
      request.settle(key);
      return request;
    }
    delete(id) {
      const request = new Request();
      this.store.records.delete(id);
      request.settle(undefined);
      return request;
    }
  }

  class Transaction {
    constructor(db, names) {
      this.db = db;
      this.names = Array.isArray(names) ? names : [names];
      this.error = null;
      this.oncomplete = null;
      this.onabort = null;
      this.onerror = null;
      this.aborted = false;
      setTimeout(() => { if (!this.aborted) this.oncomplete?.(); }, 0);
    }
    objectStore(name) {
      if (!this.names.includes(name)) throw new Error(`store inexistente: ${name}`);
      const store = this.db.stores.get(name);
      if (!store) throw new Error(`store inexistente: ${name}`);
      return new ObjectStore(store);
    }
    abort(error) {
      this.aborted = true;
      this.error = error ?? new Error('transação abortada');
      setTimeout(() => this.onabort?.(), 0);
    }
  }

  class Database {
    constructor(name) {
      this.name = name;
      this.version = 0;
      this.stores = new Map();
      this.objectStoreNames = { contains: name => this.stores.has(name) };
      this.onversionchange = null;
      this.closed = false;
    }
    createObjectStore(name, { keyPath } = {}) {
      const store = new Store(keyPath ?? 'id');
      this.stores.set(name, store);
      return store;
    }
    transaction(names) {
      return new Transaction(this, names);
    }
    close() { this.closed = true; }
  }

  return {
    databases,
    open(name, version = 1) {
      const request = new Request();
      const existing = databases.get(name);
      if (existing && existing.version >= version) {
        request.settle(existing);
        return request;
      }
      const db = existing ?? new Database(name);
      db.version = version;
      databases.set(name, db);
      request.result = db;
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

// localStorage em memória, com gravação que pode falhar para exercitar quota.
export function memoryStorage({ fail = false } = {}) {
  const map = new Map();
  let failing = fail;
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem(key, value) {
      if (failing) throw new Error('quota negada');
      map.set(key, String(value));
    },
    removeItem: key => map.delete(key),
    failNext(value = true) { failing = value; },
    raw: () => Object.fromEntries(map),
  };
}
