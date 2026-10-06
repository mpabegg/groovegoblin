// Fila de saída durável da sincronização (etapa 7 · B4).
//
// Toda alteração local vira uma operação nesta fila ANTES de tentar o
// servidor. A fila é gravada em `localStorage` a cada mudança, então recarregar
// a página no meio de um envio não perde nada: o que não foi confirmado
// continua na fila e sobe na volta da rede.
//
// Chave determinística por documento: `doc-put|exercises|<id>`. Duas
// alterações do mesmo documento viram UMA operação — o corpo mais novo, com a
// MESMA pré-condição (a revisão em que a divergência começou), que é o que
// torna o 412 do servidor significativo.

export const OUTBOX_KEY = 'groovegoblin.sync.outbox.v1';
export const OUTBOX_RECOVERY_KEY = `${OUTBOX_KEY}.recovery`;
export const OUTBOX_VERSION = 1;
export const OUTBOX_KINDS = Object.freeze(['doc-put', 'doc-delete', 'blob-put']);
export const OUTBOX_LIMIT = 500;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

// Chave determinística: um documento (ou um blob) tem UMA operação pendente,
// independentemente de ser envio ou remoção. É isso que faz "editar e depois
// apagar" não virar duas escritas na rede.
export function outboxKey(op) {
  if (op.kind === 'blob-put') return isText(op.sha256) ? `blob-put|${op.sha256}` : null;
  if (!isText(op.collection) || !isText(op.docId)) return null;
  return `${op.collection}|${op.docId}`;
}

function normalizeOp(raw) {
  if (!isObject(raw) || !OUTBOX_KINDS.includes(raw.kind)) return null;
  if (!isText(raw.id)) return null;
  const op = {
    id: raw.id,
    kind: raw.kind,
    collection: isText(raw.collection) ? raw.collection : null,
    docId: isText(raw.docId) ? raw.docId : null,
    sha256: isText(raw.sha256) ? raw.sha256 : null,
    size: Number.isFinite(raw.size) ? raw.size : null,
    name: isText(raw.name) ? raw.name : null,
    body: raw.body === undefined ? null : raw.body,
    baseRev: isText(raw.baseRev) ? raw.baseRev : null,
    create: raw.create === true,
    createdAt: isText(raw.createdAt) ? raw.createdAt : null,
    attempts: Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    error: isText(raw.error) ? raw.error : null,
  };
  if (op.id !== outboxKey(op)) return null;
  if (op.kind !== 'blob-put' && op.body === null && op.kind === 'doc-put') return null;
  if (op.kind === 'blob-put' && !/^[0-9a-f]{64}$/.test(op.sha256 ?? '')) return null;
  return op;
}

export function createSyncOutbox({
  storage = globalThis.localStorage,
  now = () => new Date().toISOString(),
  limit = OUTBOX_LIMIT,
} = {}) {
  const listeners = new Set();
  const ops = new Map();
  let loadWarning = null;
  let writeWarning = null;
  let limitWarning = null;
  let recovery = null;
  let persisted = true;

  function emit() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* um assinante quebrado não derruba a fila */ }
    }
  }

  function read(key) {
    try { return storage?.getItem(key) ?? null; } catch { return null; }
  }

  function write(key, value) {
    try {
      storage?.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function load() {
    const raw = read(OUTBOX_KEY);
    if (raw === null) return;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {
      // Bytes originais ficam recuperáveis: a fila nunca é sobrescrita por
      // causa de um JSON ilegível.
      recovery = raw;
      write(OUTBOX_RECOVERY_KEY, raw);
      loadWarning = 'A fila de sincronização guardada estava ilegível; os bytes originais ficaram preservados.';
      return;
    }
    const list = Array.isArray(parsed?.ops) ? parsed.ops : [];
    for (const item of list) {
      const op = normalizeOp(item);
      if (!op) {
        if (recovery === null) {
          recovery = raw;
          write(OUTBOX_RECOVERY_KEY, raw);
          loadWarning = 'Havia operações inválidas na fila de sincronização; os bytes originais ficaram preservados.';
        }
        continue;
      }
      ops.set(op.id, op);
    }
  }

  function persist() {
    const document = { version: OUTBOX_VERSION, ops: [...ops.values()] };
    const ok = write(OUTBOX_KEY, JSON.stringify(document));
    persisted = ok;
    writeWarning = ok ? null : 'A fila de sincronização não pôde ser gravada neste navegador; as alterações continuam na memória.';
    return ok;
  }

  load();

  function commit() {
    persist();
    emit();
  }

  return {
    get key() { return OUTBOX_KEY; },
    get warning() { return writeWarning ?? limitWarning ?? loadWarning; },
    get recoveryRaw() { return recovery; },
    get persisted() { return persisted; },
    get storageKey() { return OUTBOX_KEY; },
    count() { return ops.size; },
    list() { return [...ops.values()].map(op => ({ ...op })); },
    pending() { return ops.size > 0; },
    has(id) { return ops.has(id); },
    get(id) { return ops.has(id) ? { ...ops.get(id) } : null; },

    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Assinante inválido.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // Enfileira (ou atualiza) uma operação. Devolve `{ ok, id, coalesced }` ou
    // `{ ok:false, code:'full' }` quando a fila passa do teto — nunca descarta
    // uma operação antiga para caber a nova.
    enqueue(operation) {
      const op = normalizeOp({
        createdAt: now(),
        attempts: 0,
        error: null,
        create: false,
        baseRev: null,
        ...operation,
        id: outboxKey(operation),
      });
      if (!op) return { ok: false, code: 'invalid', id: null, coalesced: false };
      const previous = ops.get(op.id);
      if (previous) {
        // A pré-condição (revisão de partida) é a da PRIMEIRA divergência; o
        // corpo é o mais novo. Isso mantém o 412 honesto.
        //
        // Vale também quando um envio chega depois de uma remoção pendente: a
        // revisão guardada continua sendo a última que o servidor confirmou, e
        // é contra ela que o PUT precisa casar. Se a lápide já tiver subido, o
        // servidor responde 412 e a ressurreição vira conflito explícito (com
        // cópia) em vez de perdida.
        ops.set(op.id, {
          ...op,
          baseRev: previous.baseRev,
          create: previous.create,
          createdAt: previous.createdAt ?? op.createdAt,
          attempts: 0,
          error: null,
        });
        commit();
        return { ok: true, id: op.id, coalesced: true };
      }
      if (ops.size >= limit) {
        limitWarning = `A fila de sincronização chegou ao teto de ${limit} operações; nada foi descartado, mas novas alterações esperam a fila esvaziar.`;
        emit();
        return { ok: false, code: 'full', id: op.id, coalesced: false };
      }
      ops.set(op.id, op);
      commit();
      return { ok: true, id: op.id, coalesced: false };
    },

    // Falha de envio: registra a tentativa e a mensagem, mantendo a operação.
    fail(id, message) {
      const op = ops.get(id);
      if (!op) return false;
      ops.set(id, { ...op, attempts: op.attempts + 1, error: message ?? 'Falha ao enviar.' });
      commit();
      return true;
    },

    remove(id) {
      if (!ops.delete(id)) return false;
      commit();
      return true;
    },

    clear() {
      ops.clear();
      commit();
      return true;
    },
  };
}
