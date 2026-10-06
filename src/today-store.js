// Sessão de hoje: fila, rotinas nomeadas e resumo persistidos à parte da
// sessão musical (rodada 4, item 4 — etapa 5).
//
// Chaves físicas próprias, nunca dentro de sessionv5:
//  - groovegoblin.today.v1            fila ativa + estado da execução + resumo
//  - groovegoblin.today.v1.recovery   bytes crus de uma fila corrompida
//  - groovegoblin.today.routines.v1   rotinas nomeadas
//  - groovegoblin.today.routines.v1.recovery
//
// A fila guarda só referências (exerciseId + duração por item): o material
// continua sendo o exercício canônico da biblioteca. O estado da execução
// guarda o tempo já praticado de cada item em milissegundos somados a partir de
// intervalos FECHADOS; por isso fechar/reabrir nunca cobra a noite parada.
// Corrupção e quota não autorizam sobrescrever os bytes originais: uma loja
// corrompida fica preservada na chave de recuperação até ação explícita.

export const TODAY_KEY = 'groovegoblin.today.v1';
export const TODAY_RECOVERY_KEY = 'groovegoblin.today.v1.recovery';
export const ROUTINES_KEY = 'groovegoblin.today.routines.v1';
export const ROUTINES_RECOVERY_KEY = 'groovegoblin.today.routines.v1.recovery';
export const TODAY_VERSION = 1;
export const DEFAULT_ITEM_MINUTES = 5;
export const MIN_ITEM_MINUTES = 1;
export const MAX_ITEM_MINUTES = 180;
// Sugestão padrão de uma sessão diária; a ordenação completa continua exposta
// por suggestQueue() para quem quiser a lista inteira.
export const SUGGESTION_LIMIT = 6;
export const SESSION_NAME_MAX = 80;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function defaultUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `today-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function intOr(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

// BPM ausente nunca vira 0; um zero explícito continua zero.
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function minutesOr(value, fallback = DEFAULT_ITEM_MINUTES) {
  const minutes = intOr(value, fallback);
  if (minutes < MIN_ITEM_MINUTES) return MIN_ITEM_MINUTES;
  if (minutes > MAX_ITEM_MINUTES) return MAX_ITEM_MINUTES;
  return minutes;
}

export function itemTargetMs(item) {
  return minutesOr(item?.durationMin) * 60000;
}

// Ordenação sugerida: primeiro os mais antigos SEM treino (exercícios nunca
// treinados, do mais antigo criado para o mais novo), depois os que estão mais
// longe do alvo. Sem alvo definido não há distância: o item vai para o fim e
// nunca usa o próprio andamento como alvo. Nunca mistura instrumentos à força:
// quem quiser filtra depois.
export function suggestQueue(rows = []) {
  const distance = row => {
    const target = numberOrNull(row?.targetBPM);
    if (target === null) return null;
    return Math.max(0, target - intOr(row?.bestBpm ?? row?.bpm, 0));
  };
  const untrainedOrder = row => {
    const created = Date.parse(row?.createdAt ?? '');
    return Number.isFinite(created) ? created : 0;
  };
  const trainedOrder = row => {
    const trained = Date.parse(row?.lastTrainedAt ?? '');
    return Number.isFinite(trained) ? trained : 0;
  };
  const ordered = (Array.isArray(rows) ? rows : []).filter(row => isNonEmptyString(row?.id)).slice();
  ordered.sort((a, b) => {
    const untrainedA = !a.lastTrainedAt;
    const untrainedB = !b.lastTrainedAt;
    if (untrainedA !== untrainedB) return untrainedA ? -1 : 1;
    const timeA = untrainedA ? untrainedOrder(a) : trainedOrder(a);
    const timeB = untrainedA ? untrainedOrder(b) : trainedOrder(b);
    if (timeA !== timeB) return timeA - timeB;
    const distanceA = distance(a);
    const distanceB = distance(b);
    if (distanceA !== distanceB) {
      if (distanceA === null) return 1;
      if (distanceB === null) return -1;
      return distanceB - distanceA;
    }
    return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'pt-BR');
  });
  return ordered.map(row => ({ exerciseId: row.id, durationMin: DEFAULT_ITEM_MINUTES }));
}

export function queueTotalMs(items = []) {
  return (Array.isArray(items) ? items : []).reduce((total, item) => total + itemTargetMs(item), 0);
}

function normalizeItem(value, uuid) {
  if (!isObject(value)) throw new TypeError('Item da fila inválido.');
  if (!isNonEmptyString(value.exerciseId)) throw new TypeError('Item da fila sem exercício.');
  return {
    id: isNonEmptyString(value.id) ? value.id : uuid(),
    exerciseId: value.exerciseId,
    durationMin: minutesOr(value.durationMin),
  };
}

function normalizeItems(value, uuid) {
  const list = Array.isArray(value) ? value : [];
  return list.map(item => normalizeItem(item, uuid));
}

function normalizeSessionItem(value, uuid) {
  const item = normalizeItem(value, uuid);
  return {
    ...item,
    name: isNonEmptyString(value.name) ? value.name : null,
    instrument: value.instrument === 'bass' || value.instrument === 'guitar' ? value.instrument : null,
    elapsedMs: Math.max(0, intOr(value.elapsedMs, 0)),
    startBpm: numberOrNull(value.startBpm),
    endBpm: numberOrNull(value.endBpm),
    startedAt: isNonEmptyString(value.startedAt) ? value.startedAt : null,
    finishedAt: isNonEmptyString(value.finishedAt) ? value.finishedAt : null,
    practiced: value.practiced === true,
  };
}

// O estado da execução SEMPRE volta pausado: "running" não existe na loja —
// retomar é um ato explícito, e nenhum intervalo aberto atravessa a recarga.
export function normalizeSessionState(value, uuid) {
  if (!isObject(value)) throw new TypeError('Estado da sessão de hoje inválido.');
  const items = (Array.isArray(value.items) ? value.items : []).map(item => normalizeSessionItem(item, uuid));
  if (items.length === 0) throw new TypeError('Sessão de hoje sem itens.');
  const index = Math.min(Math.max(0, intOr(value.activeIndex, 0)), items.length - 1);
  return {
    id: isNonEmptyString(value.id) ? value.id : uuid(),
    queueId: isNonEmptyString(value.queueId) ? value.queueId : null,
    items,
    activeIndex: index,
    createdAt: isNonEmptyString(value.createdAt) ? value.createdAt : new Date().toISOString(),
    announced: (Array.isArray(value.announced) ? value.announced : []).filter(isNonEmptyString),
  };
}

function normalizeBpmChange(value) {
  return { from: numberOrNull(value?.from), to: numberOrNull(value?.to) };
}

export function normalizeSummary(value) {
  if (!isObject(value)) throw new TypeError('Resumo da sessão de hoje inválido.');
  const items = (Array.isArray(value.items) ? value.items : []).map(item => {
    const elapsedMs = Math.max(0, intOr(item?.elapsedMs, 0));
    return {
      exerciseId: isNonEmptyString(item?.exerciseId) ? item.exerciseId : null,
      name: isNonEmptyString(item?.name) ? item.name : 'Exercício',
      instrument: item?.instrument === 'bass' || item?.instrument === 'guitar' ? item.instrument : null,
      elapsedMs,
      // "Praticado" é derivado do tempo real fechado: nunca um rótulo solto.
      practiced: elapsedMs > 0,
      plannedMs: Math.max(0, intOr(item?.plannedMs, 0)),
      bpm: normalizeBpmChange(item?.bpm),
    };
  });
  return {
    finishedAt: isNonEmptyString(value.finishedAt) ? value.finishedAt : new Date().toISOString(),
    totalElapsedMs: Math.max(0, intOr(value.totalElapsedMs, items.reduce((total, item) => total + item.elapsedMs, 0))),
    plannedMs: Math.max(0, intOr(value.plannedMs, queueTotalMs(items))),
    items,
  };
}

function validateJournal(value, uuid) {
  if (!isObject(value) || value.version !== TODAY_VERSION) throw new TypeError('Fila de hoje inválida.');
  const queue = value.queue === null || value.queue === undefined ? null : {
    id: isNonEmptyString(value.queue.id) ? value.queue.id : uuid(),
    createdAt: isNonEmptyString(value.queue.createdAt) ? value.queue.createdAt : new Date().toISOString(),
    updatedAt: isNonEmptyString(value.queue.updatedAt) ? value.queue.updatedAt : new Date().toISOString(),
    items: normalizeItems(value.queue.items, uuid),
  };
  return {
    version: TODAY_VERSION,
    queue,
    session: value.session === null || value.session === undefined ? null : normalizeSessionState(value.session, uuid),
    summary: value.summary === null || value.summary === undefined ? null : normalizeSummary(value.summary),
    updatedAt: isNonEmptyString(value.updatedAt) ? value.updatedAt : new Date().toISOString(),
  };
}

function validateRoutines(value, uuid) {
  if (!isObject(value) || value.version !== TODAY_VERSION) throw new TypeError('Rotinas de hoje inválidas.');
  const routines = (Array.isArray(value.routines) ? value.routines : []).map(routine => {
    if (!isObject(routine) || !isNonEmptyString(routine.name)) throw new TypeError('Rotina sem nome.');
    return {
      id: isNonEmptyString(routine.id) ? routine.id : uuid(),
      name: routine.name.slice(0, SESSION_NAME_MAX),
      createdAt: isNonEmptyString(routine.createdAt) ? routine.createdAt : new Date().toISOString(),
      updatedAt: isNonEmptyString(routine.updatedAt) ? routine.updatedAt : new Date().toISOString(),
      items: normalizeItems(routine.items, uuid),
    };
  });
  return { version: TODAY_VERSION, routines };
}

export function createTodayStore({ storage = globalThis.localStorage, now = Date.now, uuid = defaultUuid } = {}) {
  const target = storage ?? globalThis.localStorage;
  const listeners = new Set();
  const iso = () => new Date(now()).toISOString();
  let journal = { version: TODAY_VERSION, queue: null, session: null, summary: null, updatedAt: iso() };
  let routines = { version: TODAY_VERSION, routines: [] };
  let status = 'ready';
  let loadWarning = null;
  let writeWarning = null;
  let lastSaved = false;
  let recoveryRaw = null;
  let corruptPreserved = false;
  let routinesStatus = 'ready';
  let routinesRecoveryRaw = null;
  let routinesCorruptPreserved = false;
  let routinesWarning = null;

  function emit() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* Um assinante quebrado não derruba a fila. */ }
    }
  }

  function read(key) {
    try { return target?.getItem(key) ?? null; }
    catch { return null; }
  }

  function write(key, value) {
    try {
      target.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  // Quota negada mantém o estado em memória e NUNCA apaga os bytes anteriores.
  function persistJournal() {
    if (status === 'corrupt') { lastSaved = false; return false; }
    journal.updatedAt = iso();
    const ok = write(TODAY_KEY, JSON.stringify(journal));
    lastSaved = ok;
    writeWarning = ok ? null : 'A fila de hoje não pôde ser salva neste navegador. Ela continua na memória; libere espaço e tente de novo.';
    return ok;
  }

  function persistRoutines() {
    if (routinesStatus === 'corrupt') return false;
    const ok = write(ROUTINES_KEY, JSON.stringify(routines));
    routinesWarning = ok ? null : 'As rotinas de hoje não puderam ser salvas neste navegador. Elas continuam na memória.';
    return ok;
  }

  function loadJournal() {
    const raw = read(TODAY_KEY);
    if (raw === null) return;
    try {
      journal = validateJournal(JSON.parse(raw), uuid);
    } catch {
      status = 'corrupt';
      recoveryRaw = raw;
      journal = { version: TODAY_VERSION, queue: null, session: null, summary: null, updatedAt: iso() };
      loadWarning = 'A fila de hoje guardada está corrompida. Os bytes originais ficam preservados; baixe-os antes de recuperar.';
      if (read(TODAY_RECOVERY_KEY) === null) write(TODAY_RECOVERY_KEY, raw);
      corruptPreserved = read(TODAY_RECOVERY_KEY) !== null;
    }
  }

  function loadRoutines() {
    const raw = read(ROUTINES_KEY);
    if (raw === null) return;
    try {
      routines = validateRoutines(JSON.parse(raw), uuid);
    } catch {
      routinesStatus = 'corrupt';
      routinesRecoveryRaw = raw;
      routines = { version: TODAY_VERSION, routines: [] };
      routinesWarning = 'As rotinas de hoje guardadas estão corrompidas. Os bytes originais ficam preservados.';
      if (read(ROUTINES_RECOVERY_KEY) === null) write(ROUTINES_RECOVERY_KEY, raw);
      routinesCorruptPreserved = read(ROUTINES_RECOVERY_KEY) !== null;
    }
  }

  loadJournal();
  loadRoutines();

  function requireWritable() {
    if (status === 'corrupt') throw new Error('A fila de hoje está corrompida; baixe os bytes originais antes de usar.');
  }

  function api() {
    return {
      get status() { return status; },
      get saved() { return lastSaved; },
      get warning() { return writeWarning ?? loadWarning; },
      get routinesWarning() { return routinesWarning; },
      get recoveryRaw() { return recoveryRaw; },
      get routinesRecoveryRaw() { return routinesRecoveryRaw; },
      get key() { return TODAY_KEY; },
      get recoveryKey() { return TODAY_RECOVERY_KEY; },
      get routinesKey() { return ROUTINES_KEY; },
      get routinesRecoveryKey() { return ROUTINES_RECOVERY_KEY; },

      queue() { return journal.queue ? clone(journal.queue) : null; },
      items() { return journal.queue ? clone(journal.queue.items) : []; },
      totalMs() { return queueTotalMs(journal.queue?.items ?? []); },
      // Substitui a fila inteira; itens repetidos do mesmo exercício são
      // permitidos e a ordem é a do usuário.
      setItems(items) {
        requireWritable();
        const normalized = normalizeItems(items, uuid);
        journal.queue = {
          id: journal.queue?.id ?? uuid(),
          createdAt: journal.queue?.createdAt ?? iso(),
          updatedAt: iso(),
          items: normalized,
        };
        persistJournal();
        emit();
        return clone(journal.queue);
      },
      addItem({ exerciseId, durationMin = DEFAULT_ITEM_MINUTES } = {}) {
        requireWritable();
        if (!isNonEmptyString(exerciseId)) throw new TypeError('Escolha um exercício para adicionar.');
        const items = journal.queue?.items?.slice() ?? [];
        items.push({ id: uuid(), exerciseId, durationMin: minutesOr(durationMin) });
        return api().setItems(items);
      },
      removeItem(itemId) {
        requireWritable();
        const items = (journal.queue?.items ?? []).filter(item => item.id !== itemId);
        return api().setItems(items);
      },
      moveItem(itemId, offset) {
        requireWritable();
        const items = journal.queue?.items?.slice() ?? [];
        const index = items.findIndex(item => item.id === itemId);
        if (index < 0) throw new RangeError('Item não encontrado na fila.');
        const next = index + intOr(offset, 0);
        if (next < 0 || next >= items.length) return clone(journal.queue);
        const [item] = items.splice(index, 1);
        items.splice(next, 0, item);
        return api().setItems(items);
      },
      setItemDuration(itemId, durationMin) {
        requireWritable();
        const items = journal.queue?.items?.slice() ?? [];
        const item = items.find(candidate => candidate.id === itemId);
        if (!item) throw new RangeError('Item não encontrado na fila.');
        item.durationMin = minutesOr(durationMin);
        return api().setItems(items);
      },

      session() { return journal.session ? clone(journal.session) : null; },
      saveSession(session) {
        if (status === 'corrupt') return false;
        journal.session = session === null || session === undefined ? null : normalizeSessionState(session, uuid);
        return persistJournal();
      },
      summary() { return journal.summary ? clone(journal.summary) : null; },
      saveSummary(summary) {
        if (status === 'corrupt') return false;
        journal.summary = summary === null || summary === undefined ? null : normalizeSummary(summary);
        return persistJournal();
      },

      routines() { return clone(routines.routines); },
      // Salvar com um nome existente atualiza a rotina: recriar a fila é um
      // clique, sem duplicar entradas homônimas.
      saveRoutine(name, items) {
        if (routinesStatus === 'corrupt') return null;
        const trimmed = String(name ?? '').trim().slice(0, SESSION_NAME_MAX);
        if (!trimmed) throw new TypeError('Dê um nome à rotina.');
        const normalized = normalizeItems(items, uuid);
        const existing = routines.routines.find(routine => routine.name === trimmed);
        if (existing) {
          existing.items = normalized;
          existing.updatedAt = iso();
          persistRoutines();
          emit();
          return clone(existing);
        }
        const routine = { id: uuid(), name: trimmed, createdAt: iso(), updatedAt: iso(), items: normalized };
        routines.routines.push(routine);
        persistRoutines();
        emit();
        return clone(routine);
      },
      deleteRoutine(id) {
        if (routinesStatus === 'corrupt') return false;
        const index = routines.routines.findIndex(routine => routine.id === id);
        if (index < 0) return false;
        routines.routines.splice(index, 1);
        persistRoutines();
        emit();
        return true;
      },
      routine(id) { return clone(routines.routines.find(routine => routine.id === id) ?? null); },
      // Recriação em um clique: a fila passa a ser exatamente a rotina, com
      // ids de item novos.
      applyRoutine(id) {
        const routine = routines.routines.find(candidate => candidate.id === id);
        if (!routine) throw new RangeError('Rotina não encontrada.');
        return api().setItems(routine.items.map(item => ({ exerciseId: item.exerciseId, durationMin: item.durationMin })));
      },

      replaceCorrupt() {
        if (status !== 'corrupt') return false;
        if (!corruptPreserved) {
          writeWarning = 'Bytes originais não preservados; baixe a fila corrompida antes de recuperar.';
          return false;
        }
        if (!write(TODAY_KEY, JSON.stringify(journal))) {
          writeWarning = 'Não foi possível recuperar a fila de hoje: armazenamento negado.';
          return false;
        }
        status = 'ready';
        recoveryRaw = null;
        loadWarning = null;
        writeWarning = null;
        persistJournal();
        emit();
        return true;
      },
      replaceRoutinesCorrupt() {
        if (routinesStatus !== 'corrupt') return false;
        if (!routinesCorruptPreserved) {
          routinesWarning = 'Bytes originais não preservados; baixe as rotinas corrompidas antes de recuperar.';
          return false;
        }
        if (!write(ROUTINES_KEY, JSON.stringify(routines))) {
          routinesWarning = 'Não foi possível recuperar as rotinas: armazenamento negado.';
          return false;
        }
        routinesStatus = 'ready';
        routinesRecoveryRaw = null;
        routinesWarning = null;
        persistRoutines();
        emit();
        return true;
      },
      subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('Assinante inválido.');
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  return api();
}
