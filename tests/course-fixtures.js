// Apoio dos testes de curso (rodada 5, etapa 5).
//
// Tudo aqui é FICTÍCIO: "Curso de Exemplo", "Módulo 1", "Aula 3" e endereços
// em example.invalid. Nenhum curso, título ou arquivo real entra nos testes.
//
// Inclui três utilitários:
//  - construtores de documento `groovegoblin-course` v1 válido;
//  - um backend em memória com a MESMA interface do backend IndexedDB da loja
//    (getAll/get/put/writeBatch/delete), para os testes de comportamento;
//  - uma fábrica mínima de IndexedDB falso, para exercitar de verdade o caminho
//    openDatabase/idbBackend/transação da loja.

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
          lesson('aula-1', { suggestedExercises: [{ id: 'ex-aula-1', title: 'Exercício da Aula 1' }] }),
          lesson('aula-2'),
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

// Backend em memória: mesma interface usada pela loja sobre IndexedDB.
export function memoryBackend({ failNextWrite = null } = {}) {
  const stores = { courses: new Map(), states: new Map() };
  let failures = failNextWrite;
  const maybeFail = () => {
    if (!failures) return;
    const error = failures;
    failures = null;
    throw error;
  };
  return {
    written: [],
    failNext(error) { failures = error; },
    async getAll(store) { return [...stores[store].values()].map(value => structuredClone(value)); },
    async get(store, id) {
      const value = stores[store].get(id);
      return value === undefined ? undefined : structuredClone(value);
    },
    async put(store, value) {
      maybeFail();
      stores[store].set(value.id, structuredClone(value));
      this.written.push(store);
    },
    async writeBatch(entries) {
      maybeFail();
      for (const entry of entries) {
        stores[entry.store].set(entry.value.id, structuredClone(entry.value));
        this.written.push(entry.store);
      }
    },
    async delete(store, id) { stores[store].delete(id); },
    raw(store) { return [...stores[store].values()]; },
    seed(store, value) { stores[store].set(value.id, value); },
  };
}

// IndexedDB falso o suficiente para o caminho real da loja: open com
// onupgradeneeded/onsuccess, createObjectStore, transaction (uma ou mais
// stores), objectStore.get/getAll/put/delete e oncomplete determinístico.
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
  class Transaction {
    constructor(db, names) {
      this.db = db;
      this.oncomplete = null;
      this.onabort = null;
      this.onerror = null;
      this.names = names;
      setTimeout(() => this.oncomplete?.(), 0);
    }
    objectStore(name) {
      if (!this.names.includes(name)) throw new Error(`store inexistente: ${name}`);
      return new ObjectStore(this.db.stores.get(name));
    }
  }
  class ObjectStore {
    constructor(entry) { this.entry = entry; }
    // A chave sai do keyPath do armazenamento, como no IndexedDB real: um
    // registro sem a chave falha em vez de entrar num mapa qualquer.
    keyOf(value) {
      const key = value?.[this.entry.keyPath];
      if (key === undefined || key === null) throw new Error("Failed to execute 'put': Evaluating the object store's key path did not yield a value.");
      return key;
    }
    put(value) {
      const request = new Request();
      try {
        const key = this.keyOf(value);
        this.entry.map.set(key, structuredClone(value));
        request.settle(key);
      } catch (error) {
        request.fail(error);
      }
      return request;
    }
    get(id) {
      const request = new Request();
      const value = this.entry.map.get(id);
      request.settle(value === undefined ? undefined : structuredClone(value));
      return request;
    }
    getAll() {
      const request = new Request();
      request.settle([...this.entry.map.values()].map(value => structuredClone(value)));
      return request;
    }
    delete(id) {
      const request = new Request();
      this.entry.map.delete(id);
      request.settle(true);
      return request;
    }
  }
  class Database {
    constructor(name) {
      this.name = name;
      this.stores = new Map();
      this.objectStoreNames = { contains: store => this.stores.has(store) };
    }
    createObjectStore(name, options = {}) { this.stores.set(name, { keyPath: options.keyPath ?? 'id', map: new Map() }); }
    transaction(names) {
      return new Transaction(this, Array.isArray(names) ? names : [names]);
    }
    close() {}
  }
  return {
    open(name) {
      const request = new Request();
      request.result = databases.get(name) ?? new Database(name);
      setTimeout(() => {
        const fresh = !databases.has(name);
        databases.set(name, request.result);
        if (fresh) request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
    databases,
  };
}
