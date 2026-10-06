// Estado durável da sincronização (etapa 7 · B4).
//
// Guarda o que o servidor não pode guardar por nós:
// - o cursor do feed `changes` e a revisão conhecida de cada documento;
// - a impressão digital do último corpo enviado (para detectar alteração local
//   sem comparar arquivos inteiros);
// - as cópias em conflito e as cópias de segurança feitas ao escolher um lado;
// - os anexos marcados "manter offline".
//
// Nada aqui toca em sessão, curso ou biblioteca: nenhum formato existente muda.

export const SYNC_STATE_KEY = 'groovegoblin.sync.v1';
export const SYNC_STATE_RECOVERY_KEY = `${SYNC_STATE_KEY}.recovery`;
export const SYNC_STATE_VERSION = 1;
export const CONFLICT_LIMIT = 50;
export const RECOVERED_LIMIT = 50;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function docKey(collection, id) {
  return `${collection}|${id}`;
}

// Impressão digital barata e determinística (dois hashes de 32 bits), só para
// responder "mudou ou não". Colisão custaria um envio a menos, nunca um dado.
export function bodyDigest(text) {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    fnv = Math.imul(fnv ^ code, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) + code) >>> 0;
  }
  return `${fnv.toString(16).padStart(8, '0')}${djb.toString(16).padStart(8, '0')}`;
}

// Serialização canônica: mesma entrada, mesma saída — sem isso a comparação de
// impressões digitais acusaria mudança a cada varredura.
export function canonicalText(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`;
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalText(value[key])}`).join(',')}}`;
}

export function createSyncState({
  storage = globalThis.localStorage,
  now = () => new Date().toISOString(),
} = {}) {
  const listeners = new Set();
  let loadWarning = null;
  let writeWarning = null;
  let recovery = null;
  let state = {
    version: SYNC_STATE_VERSION,
    dataId: null,
    cursor: null,
    lastSyncAt: null,
    firstSyncDone: false,
    revisions: {},
    digests: {},
    conflicts: [],
    recovered: [],
    pinned: [],
    blobs: {},
  };

  function emit() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* um assinante quebrado não derruba o estado */ }
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

  function sanitize(raw, key) {
    if (!isObject(raw)) return null;
    return {
      version: SYNC_STATE_VERSION,
      dataId: isText(raw.dataId) ? raw.dataId : null,
      cursor: isText(raw.cursor) ? raw.cursor : null,
      lastSyncAt: isText(raw.lastSyncAt) ? raw.lastSyncAt : null,
      firstSyncDone: raw.firstSyncDone === true,
      revisions: isObject(raw.revisions) ? raw.revisions : {},
      digests: isObject(raw.digests) ? raw.digests : {},
      conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.filter(entry => isObject(entry) && isText(entry.id)) : [],
      recovered: Array.isArray(raw.recovered) ? raw.recovered.filter(entry => isObject(entry) && isText(entry.id)) : [],
      pinned: Array.isArray(raw.pinned) ? raw.pinned.filter(entry => isObject(entry) && /^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) : [],
      blobs: isObject(raw.blobs) ? raw.blobs : {},
      __key: key,
    };
  }

  function load() {
    const raw = read(SYNC_STATE_KEY);
    if (raw === null) return;
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
      recovery = raw;
      write(SYNC_STATE_RECOVERY_KEY, raw);
      loadWarning = 'O estado de sincronização guardado estava ilegível; os bytes originais ficaram preservados e a sincronização recomeça.';
      return;
    }
    const clean = sanitize(parsed, SYNC_STATE_KEY);
    if (!clean) {
      recovery = raw;
      write(SYNC_STATE_RECOVERY_KEY, raw);
      loadWarning = 'O estado de sincronização guardado não pôde ser lido; os bytes originais ficaram preservados.';
      return;
    }
    delete clean.__key;
    state = clean;
  }

  function persist() {
    const ok = write(SYNC_STATE_KEY, JSON.stringify(state));
    writeWarning = ok ? null : 'O estado de sincronização não pôde ser gravado neste navegador; a sincronização continua na memória.';
    return ok;
  }

  load();

  function commit() {
    persist();
    emit();
  }

  return {
    get key() { return SYNC_STATE_KEY; },
    get warning() { return writeWarning ?? loadWarning; },
    get recoveryRaw() { return recovery; },
    get dataId() { return state.dataId; },
    get cursor() { return state.cursor; },
    get lastSyncAt() { return state.lastSyncAt; },
    get firstSyncDone() { return state.firstSyncDone; },
    get revisions() { return { ...state.revisions }; },
    get conflicts() { return state.conflicts.map(clone); },
    get recovered() { return state.recovered.map(clone); },
    get pinned() { return state.pinned.map(clone); },

    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Assinante inválido.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // Marcador da instalação do servidor: `dataId` diferente significa outro
    // diretório de dados (outro Pi, outra pasta) — o cursor antigo não vale.
    setServer({ dataId = null, cursor = null } = {}) {
      let changed = false;
      if (isText(dataId) && state.dataId !== dataId) {
        state.dataId = dataId;
        state.cursor = null;
        state.revisions = {};
        state.digests = {};
        changed = true;
      }
      if (isText(cursor) && state.cursor !== cursor) { state.cursor = cursor; changed = true; }
      if (changed) commit();
      return changed;
    },

    setCursor(cursor) {
      if (!isText(cursor) || state.cursor === cursor) return false;
      state.cursor = cursor;
      commit();
      return true;
    },

    // Volta ao início do feed (410): o próximo `changes` vem sem `since`.
    resetCursor() {
      state.cursor = null;
      commit();
    },

    markSynced(at = now()) {
      state.lastSyncAt = isText(at) ? at : now();
      commit();
      return state.lastSyncAt;
    },

    markFirstSyncDone() {
      if (state.firstSyncDone) return false;
      state.firstSyncDone = true;
      commit();
      return true;
    },

    revision(collection, id) { return state.revisions[docKey(collection, id)] ?? null; },

    setRevision(collection, id, rev) {
      if (!isText(rev)) return false;
      state.revisions[docKey(collection, id)] = rev;
      commit();
      return true;
    },

    clearRevision(collection, id) {
      if (!Object.hasOwn(state.revisions, docKey(collection, id))) return false;
      delete state.revisions[docKey(collection, id)];
      delete state.digests[docKey(collection, id)];
      commit();
      return true;
    },

    digest(collection, id) { return state.digests[docKey(collection, id)] ?? null; },

    // Registra revisão e impressão digital juntas: elas descrevem o mesmo
    // instante (o corpo que o servidor confirmou).
    markSent(collection, id, rev, digest) {
      const key = docKey(collection, id);
      if (isText(rev)) state.revisions[key] = rev;
      if (isText(digest)) state.digests[key] = digest;
      commit();
    },

    // ---------------------------------------------------------------- conflito
    // Guarda a cópia local que o servidor recusou. Nunca descarta: no teto,
    // avisa e mantém o que já estava guardado; se o mesmo documento conflitar de
    // novo, a entrada é ATUALIZADA com o corpo local mais recente (uma cópia por
    // documento, sempre a mais nova).
    addConflict(entry) {
      if (!isObject(entry) || !isText(entry.id)) return { ok: false, code: 'invalid' };
      const existing = state.conflicts.find(item => item.id === entry.id);
      if (existing) {
        const next = { ...existing, ...clone(entry), at: isText(entry.at) ? entry.at : now() };
        state.conflicts[state.conflicts.indexOf(existing)] = next;
        commit();
        return { ok: true, duplicate: true };
      }
      if (state.conflicts.length >= CONFLICT_LIMIT) {
        loadWarning = `Há ${CONFLICT_LIMIT} cópias em conflito guardadas; resolva as antigas para liberar espaço (nada foi descartado).`;
        emit();
        return { ok: false, code: 'full' };
      }
      state.conflicts.push({ ...clone(entry), at: isText(entry.at) ? entry.at : now() });
      commit();
      return { ok: true, duplicate: false };
    },

    removeConflict(id) {
      const index = state.conflicts.findIndex(entry => entry.id === id);
      if (index < 0) return false;
      state.conflicts.splice(index, 1);
      commit();
      return true;
    },

    // Cópia de segurança feita ao escolher um lado ("ficar com esta"/"ficar com
    // a outra"): a versão descartada do lado escolhido continua baixável.
    addRecovered(entry) {
      if (!isObject(entry)) return { ok: false, code: 'invalid' };
      if (state.recovered.length >= RECOVERED_LIMIT) {
        loadWarning = `Há ${RECOVERED_LIMIT} cópias de segurança da sincronização guardadas; baixe e limpe as antigas (nada foi descartado).`;
        emit();
        return { ok: false, code: 'full' };
      }
      const record = { ...clone(entry), id: isText(entry.id) ? entry.id : `${now()}-${state.recovered.length}`, at: isText(entry.at) ? entry.at : now() };
      state.recovered.push(record);
      commit();
      return { ok: true, id: record.id };
    },

    clearRecovered() {
      if (state.recovered.length === 0) return false;
      state.recovered = [];
      commit();
      return true;
    },

    // ------------------------------------------------------- anexos offline
    // Blobs já confirmados no servidor: enquanto não estiverem aqui, os bytes
    // locais nunca são liberados (a única regra que evita perda de arquivo).
    blobConfirmed(sha256) { return isObject(state.blobs[sha256]); },

    confirmedBlobs() { return { ...state.blobs }; },

    confirmBlob(sha256, { size = null } = {}) {
      if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) return false;
      if (state.blobs[sha256]) return false;
      state.blobs[sha256] = { size, at: now() };
      commit();
      return true;
    },

    forgetBlob(sha256) {
      if (!state.blobs[sha256]) return false;
      delete state.blobs[sha256];
      commit();
      return true;
    },

    isPinned(sha256) { return state.pinned.some(entry => entry.sha256 === sha256); },

    pinBlob({ sha256, name = null, size = null }) {
      if (!/^[0-9a-f]{64}$/.test(sha256 ?? '') || state.pinned.some(entry => entry.sha256 === sha256)) return false;
      state.pinned.push({ sha256, name, size, at: now() });
      commit();
      return true;
    },

    unpinBlob(sha256) {
      const index = state.pinned.findIndex(entry => entry.sha256 === sha256);
      if (index < 0) return false;
      state.pinned.splice(index, 1);
      commit();
      return true;
    },

    reset() {
      state = {
        version: SYNC_STATE_VERSION,
        dataId: null,
        cursor: null,
        lastSyncAt: null,
        firstSyncDone: false,
        revisions: {},
        digests: {},
        conflicts: [],
        recovered: [],
        pinned: [],
        blobs: {},
      };
      commit();
      return true;
    },
  };
}
