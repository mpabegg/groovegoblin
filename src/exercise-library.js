// Biblioteca de exercícios do GrooveGoblin (rodada 4, item 3).
//
// O exercício é o documento canônico sessionv5; a biblioteca guarda esse
// documento intacto ao lado de metadados próprios (nome, etiquetas, alvo,
// anotações e treinos registrados) que NUNCA entram no formato da sessão.
// Cada treino é registrado com dono e horário de início capturados no começo
// da execução, apontando para a sessão executada por impressão digital, sem
// reescrever a sessão autoral.
//
// Chaves físicas:
//  - groovegoblin.exercise-library.v1            loja autoritativa
//  - groovegoblin.exercise-library.v1.backup     estado legado cru, antes da migração
//  - groovegoblin.exercise-library.v1.recovery   bytes crus de uma loja corrompida
// As chaves legadas (groovegoblin.session.v2, groovegoblin:studio-library:v2,
// groovegoblin.v1) são lidas uma vez na migração e preservadas sem alteração.

import { readSessionLibrary, SESSION_LIBRARY_KEY } from './studio-state.js';
import { SESSION_NAME_MAX } from './session.js';

export const LIBRARY_KEY = 'groovegoblin.exercise-library.v1';
export const LIBRARY_BACKUP_KEY = 'groovegoblin.exercise-library.v1.backup';
export const LIBRARY_RECOVERY_KEY = 'groovegoblin.exercise-library.v1.recovery';
export const LEGACY_SESSION_KEY = 'groovegoblin.session.v2';
export const LEGACY_SESSION_RECOVERY_KEY = 'groovegoblin.session.v2.recovery';
export const LEGACY_PHRASE_KEY = 'groovegoblin.v1';
export const LEGACY_PREFERENCES_KEY = 'groovegoblin.preferences.v1';
export const LEGACY_MIXER_KEY = 'groovegoblin.mixer.v1';
export const LIBRARY_VERSION = 1;
// Sufixo da duplicação; o nome base é cortado o bastante para o resultado
// final — já com o sufixo — caber no teto do nome da sessão.
const DUPLICATE_SUFFIX = ' · cópia';

// O nome é válido quando é texto não vazio dentro do teto da sessão. A
// biblioteca rejeita nomes fora do teto ANTES de persistir: um nome acima de
// SESSION_NAME_MAX invalida a sessão e, no próximo carregamento, condenaria a
// loja inteira como corrompida.
function validName(value) {
  if (!isString(value)) return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= SESSION_NAME_MAX;
}

const SORT_KEYS = Object.freeze(['untrained', 'goal', 'name']);
// Todo estado legado lido ou mutado pela migração, capturado cru antes de
// loadSession. Inclui as preferências antigas e a recuperação da sessão, que
// session.js pode ler ou escrever.
const BACKUP_SOURCES = Object.freeze([
  LEGACY_SESSION_KEY, LEGACY_SESSION_RECOVERY_KEY, LEGACY_PHRASE_KEY,
  LEGACY_PREFERENCES_KEY, LEGACY_MIXER_KEY, SESSION_LIBRARY_KEY,
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value) {
  return typeof value === 'string';
}

function isNonEmptyString(value) {
  return isString(value) && value.length > 0;
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function defaultUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `ex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isoNow() {
  return new Date().toISOString();
}

function asTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const tags = [];
  for (const tag of value) {
    if (!isString(tag)) continue;
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    tags.push(trimmed);
  }
  return tags;
}

// Impressão digital do material executado: mesma frase, mesmo alvo, mesma
// configuração de repetições. Comparações e "melhor" nunca misturam
// exercícios, objetivos ou repetições diferentes.
export function referenceFingerprint(session, { goal = null, repetitions = null } = {}) {
  const meter = session?.meter ?? {};
  const loop = session?.loop ?? {};
  const payload = {
    bars: session?.bars ?? null,
    meter: [meter.beats ?? null, meter.unit ?? null],
    subdivision: session?.subdivision ?? null,
    swing: session?.swing ?? null,
    swingUnit: session?.swingUnit ?? null,
    loop: [loop.startBar ?? null, loop.endBar ?? null],
    goal: goal ?? session?.training?.goal ?? null,
    repetitions: repetitions ?? session?.training?.repetitions ?? null,
    notes: (session?.notes ?? []).map(note => [note.start ?? null, note.duration ?? null, note.pitch ?? null]),
  };
  return JSON.stringify(payload);
}

// Assinatura do material (frase, compasso, loop): sem objetivo nem repetições.
// Decide se a execução é o próprio exercício autoral ou um material derivado.
export function materialSignature(session) {
  const meter = session?.meter ?? {};
  const loop = session?.loop ?? {};
  return JSON.stringify({
    bars: session?.bars ?? null,
    meter: [meter.beats ?? null, meter.unit ?? null],
    subdivision: session?.subdivision ?? null,
    swing: session?.swing ?? null,
    swingUnit: session?.swingUnit ?? null,
    loop: [loop.startBar ?? null, loop.endBar ?? null],
    notes: (session?.notes ?? []).map(note => [note.start ?? null, note.duration ?? null, note.pitch ?? null]),
  });
}

// Chave de material: mesma frase, mesmo alvo, mesmas repetições e mesma
// origem (autoral x gerado). Comparações e "melhor" nunca misturam exercícios,
// objetivos, repetições ou material gerado diferente.
export function materialKey(record) {
  return `${record.referenceFingerprint ?? ''}|${record.goal ?? ''}|${record.repetitions ?? ''}|${record.source ?? 'authored'}`;
}

// Chave de comparação: mesmo material e MESMO BPM (a tentativa anterior só é
// comparável no mesmo andamento).
export function comparisonKey(record) {
  return `${materialKey(record)}|${record.bpm ?? ''}`;
}

function instrumentOf(session) {
  const type = session?.extensions?.studio?.instrument?.type;
  return type === 'bass' ? 'bass' : 'guitar';
}

// Alvo opcional (número) ou null: null é "sem alvo definido", nunca um alvo
// implícito herdado do andamento. Migrações legadas ainda passam o BPM da
// sessão explicitamente para preservar o alvo que existia antes.
function defaultMetadata(name, bpm) {
  return { name, tags: [], targetBPM: bpm, notes: '', study: null, courseContent: false, records: [] };
}

function intOr(value, fallback = 0) {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

// Resumo normalizado: denominador e modo explícitos para que o histórico
// nunca divida por um total ambíguo (modo livre tem expected 0 e free > 0).
function normalizeSummary(value) {
  const source = isObject(value) ? value : {};
  return {
    ...clone(source),
    mode: isString(source.mode) ? source.mode : 'strict',
    expected: intOr(source.expected, 0),
    attackOk: intOr(source.attackOk, 0),
    endOk: intOr(source.endOk, 0),
    pitchOk: intOr(source.pitchOk, 0),
    pitchChecked: intOr(source.pitchChecked, 0),
    free: intOr(source.free, 0),
  };
}

function normalizeRecord(value) {
  if (!isObject(value) || !isNonEmptyString(value.id)) return null;
  const record = {
    id: value.id,
    ownerId: isString(value.ownerId) ? value.ownerId : null,
    startedAt: isString(value.startedAt) ? value.startedAt : null,
    endedAt: isString(value.endedAt) ? value.endedAt : null,
    completedAt: isString(value.completedAt) ? value.completedAt : isString(value.endedAt) ? value.endedAt : null,
    durationMs: typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) ? value.durationMs : null,
    date: isString(value.date) ? value.date : isString(value.startedAt) ? value.startedAt : null,
    bpm: finiteOr(value.bpm, null),
    mode: isString(value.mode) ? value.mode : 'train',
    goal: isString(value.goal) ? value.goal : null,
    repetitions: finiteOr(value.repetitions, null),
    source: value.source === 'generated' ? 'generated' : 'authored',
    objective: isString(value.objective) ? value.objective : null,
    referenceFingerprint: isString(value.referenceFingerprint) ? value.referenceFingerprint : '',
    summary: normalizeSummary(value.summary),
    metric: finiteOr(value.metric, null),
    tempoDelta: finiteOr(value.tempoDelta, 0),
  };
  record.materialKey = isString(value.materialKey) ? value.materialKey : materialKey(record);
  record.comparisonKey = isString(value.comparisonKey) ? value.comparisonKey : comparisonKey(record);
  return record;
}

// Bloco `study` da metadata (etapa A4): a receita do estudo vive FORA da
// sessão e viaja com o exercício. Sem receita não existe estudo — nada de
// "estudo pela metade"; campos ausentes/ inválidos são descartados em vez de
// fingir um vínculo. `origin` é o exercício original de uma variação e `group`
// o conjunto de irmãos (as 12 tonalidades), ambos só RÓTULOS: um id que não
// existe mais continua legível pelo nome guardado, sem quebrar a lista.
//
// PRIVACIDADE (B6): um vínculo pode ser marcado `private: true` — o rótulo
// (`name`/`label`) vem de material de curso e NÃO pode sair em exportação
// padrão. `kind` (`exercise`/`course`/`material`) diz de onde o vínculo veio.
// A receita em si é sempre musical (parâmetros), então a política de
// exportação pode remover `origin`/`group` e conservar `recipe` inteiro.
function normalizeLink(value, labelKey) {
  if (!isObject(value) || !isNonEmptyString(value.id)) return null;
  const link = { id: value.id, [labelKey]: isString(value[labelKey]) ? value[labelKey] : '' };
  if (['exercise', 'course', 'material'].includes(value.kind)) link.kind = value.kind;
  if (value.private === true) link.private = true;
  return link;
}

function normalizeStudy(value) {
  if (!isObject(value)) return null;
  const recipe = isObject(value.recipe) ? clone(value.recipe) : null;
  if (recipe === null) return null;
  return {
    version: Number.isInteger(value.version) ? value.version : LIBRARY_VERSION,
    recipe,
    summary: isObject(value.summary) ? clone(value.summary) : null,
    origin: normalizeLink(value.origin, 'name'),
    group: normalizeLink(value.group, 'label'),
  };
}

function normalizeMetadata(value, session) {
  const base = defaultMetadata(validName(session?.name) ? session.name : 'Exercício', session?.bpm ?? null);
  if (!isObject(value)) return base;
  const records = Array.isArray(value.records) ? value.records.map(normalizeRecord).filter(Boolean) : [];
  return {
    name: validName(value.name) ? value.name.trim() : base.name,
    tags: asTags(value.tags),
    // null explícito é preservado; metadado antigo SEM a chave herda o alvo
    // implícito que a migração sempre gravou (o BPM da sessão).
    targetBPM: value.targetBPM === null ? null : finiteOr(value.targetBPM, base.targetBPM),
    notes: isString(value.notes) ? value.notes : '',
    study: normalizeStudy(value.study),
    // Marca de conteúdo de curso (B6): o exercício nasceu de material de curso
    // (sugestão gerada ou vínculo manual) e a exportação padrão/compartilhamento
    // NÃO pode levar o que é de terceiros. Só `true` explícito marca; qualquer
    // outro valor vira `false` (nunca "quase privado").
    courseContent: value.courseContent === true,
    records,
  };
}

// Estatísticas derivadas para a lista. Nunca gravadas: sempre recalculadas.
export function summarize(entry) {
  const session = entry.session;
  const metadata = entry.metadata;
  const records = metadata.records;
  const currentBpm = finiteOr(session.bpm, null);
  const goal = session.training?.goal ?? null;
  const repetitions = session.training?.repetitions ?? null;
  const authoredKey = `${referenceFingerprint(session, { goal, repetitions })}|${goal ?? ''}|${repetitions ?? ''}|authored`;
  const attempts = records.filter(record => record.summary && record.summary.mode !== 'free' && record.summary.expected > 0 && record.materialKey === authoredKey);
  let bestBpm = null;
  let bestAtCurrentBpm = null;
  for (const record of attempts) {
    const ratio = record.summary.attackOk / record.summary.expected;
    if (ratio >= 0.8 && (bestBpm === null || record.bpm > bestBpm)) bestBpm = record.bpm;
    if (record.bpm === currentBpm) {
      const score = typeof record.metric === 'number' ? Math.round(record.metric * 100) : null;
      if (bestAtCurrentBpm === null
        || (score !== null && score > (bestAtCurrentBpm.score ?? -1))
        || (score === null && bestAtCurrentBpm.score === null && ratio > bestAtCurrentBpm.ratio)) {
        bestAtCurrentBpm = { bpm: record.bpm, score, ratio, recordId: record.id };
      }
    }
  }
  const lastTrainedAt = records.length > 0 ? records[records.length - 1].startedAt ?? records[records.length - 1].date ?? null : null;
  const targetBPM = finiteOr(metadata.targetBPM, null);
  const progress = targetBPM !== null && bestBpm !== null ? Math.max(0, Math.min(1, bestBpm / targetBPM)) : 0;
  return {
    id: entry.id,
    name: metadata.name,
    instrument: instrumentOf(session),
    tags: metadata.tags.slice(),
    bars: finiteOr(session.bars, null),
    bpm: currentBpm,
    targetBPM,
    lastTrainedAt,
    bestBpm,
    bestAtCurrentBpm,
    progress,
    recordsCount: records.length,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    // Vínculos do estudo (A4) só para a lista: a receita completa continua em
    // metadata.study.recipe, fora do resumo.
    study: metadata.study ? { origin: metadata.study.origin, group: metadata.study.group } : null,
  };
}

// Distância até o alvo para a ordenação "BPM alvo". Sem alvo definido não há
// distância: o exercício vai para o fim e nunca herda o andamento como alvo.
function goalDistance(row) {
  const target = finiteOr(row?.targetBPM, null);
  if (target === null) return null;
  return target - finiteOr(row?.bestBpm ?? row?.bpm, 0);
}

function sortSummaries(rows, sort) {
  const key = SORT_KEYS.includes(sort) ? sort : 'untrained';
  const copy = rows.slice();
  if (key === 'name') {
    copy.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  } else if (key === 'goal') {
    copy.sort((a, b) => {
      const da = goalDistance(a), db = goalDistance(b);
      if (da === null || db === null) {
        if (da === db) return (a.name ?? '').localeCompare(b.name ?? '', 'pt-BR');
        return da === null ? 1 : -1;
      }
      if (db !== da) return db - da;
      return (a.name ?? '').localeCompare(b.name ?? '', 'pt-BR');
    });
  } else {
    copy.sort((a, b) => {
      const ta = a.lastTrainedAt ? Date.parse(a.lastTrainedAt) : -Infinity;
      const tb = b.lastTrainedAt ? Date.parse(b.lastTrainedAt) : -Infinity;
      if (ta !== tb) return ta - tb;
      return (a.name ?? '').localeCompare(b.name ?? '', 'pt-BR');
    });
  }
  return copy;
}

function filterSummaries(rows, filter = {}) {
  const instrument = filter.instrument ?? 'all';
  const tag = filter.tag ?? 'all';
  const query = (filter.query ?? '').trim().toLocaleLowerCase('pt-BR');
  return rows.filter(row => {
    if (instrument !== 'all' && row.instrument !== instrument) return false;
    if (tag !== 'all' && !row.tags.includes(tag)) return false;
    if (query && !row.name.toLocaleLowerCase('pt-BR').includes(query)) return false;
    return true;
  });
}

// Cópia crua do estado legado, ANTES de qualquer loadSession/mutação. Grava uma
// única vez na chave própria; nunca sobrescreve um backup existente.
export function captureLegacyBackup(storage, now = isoNow) {
  const target = storage ?? globalThis.localStorage;
  let existing;
  try { existing = target.getItem(LIBRARY_BACKUP_KEY); } catch { return { created: false, raw: null, reason: 'unavailable' }; }
  if (existing !== null) return { created: false, raw: existing, reason: 'exists' };
  const keys = {};
  let hasAny = false;
  for (const key of BACKUP_SOURCES) {
    let raw = null;
    try { raw = target.getItem(key); } catch { return { created: false, raw: null, reason: 'unavailable' }; }
    if (raw !== null) hasAny = true;
    keys[key] = raw;
  }
  if (!hasAny) return { created: false, raw: null, reason: 'empty' };
  const snapshot = JSON.stringify({ version: LIBRARY_VERSION, kind: 'groovegoblin-exercise-backup', capturedAt: now(), keys });
  try { target.setItem(LIBRARY_BACKUP_KEY, snapshot); } catch { return { created: false, raw: null, reason: 'quota' }; }
  return { created: true, raw: snapshot, reason: 'created' };
}

function validateStore(value) {
  if (!isObject(value) || !Array.isArray(value.entries)) throw new Error('Formato inválido');
  const ids = new Set();
  const entries = value.entries.map(entry => {
    if (!isObject(entry) || !isNonEmptyString(entry.id) || !isObject(entry.session) || ids.has(entry.id)) throw new Error('Exercício inválido');
    ids.add(entry.id);
    return entry;
  });
  const activeId = isNonEmptyString(value.activeId) && ids.has(value.activeId) ? value.activeId : entries[0]?.id ?? null;
  return { version: LIBRARY_VERSION, activeId, entries };
}

// Monta a loja inicial a partir do estado legado: sessão atual + sessões
// guardadas antigas, removendo duplicatas idênticas (mesma sessão canônica).
function migrateFromLegacy({ currentSession, parse, serialize, storage, uuid, now }) {
  const entries = [];
  const seen = new Set();
  const warnings = [];
  function add(session, { id = null, createdAt = null, metadata = null } = {}) {
    const canonical = serialize(session);
    if (seen.has(canonical)) return null;
    seen.add(canonical);
    const entry = {
      id: id && isNonEmptyString(id) ? id : uuid(),
      createdAt: createdAt ?? now(),
      updatedAt: createdAt ?? now(),
      session: clone(session),
      metadata: metadata ?? defaultMetadata(session.name ?? 'Exercício', session.bpm ?? null),
    };
    entries.push(entry);
    return entry;
  }
  let currentTarget = null;
  try {
    if (storage.getItem(LEGACY_SESSION_KEY) !== null || storage.getItem(LEGACY_PHRASE_KEY) !== null) {
      currentTarget = currentSession.bpm ?? null;
    }
  } catch {
    warnings.push('Não foi possível consultar a sessão antiga; o alvo inicial ficou indefinido.');
  }
  const current = add(currentSession, { metadata: defaultMetadata(currentSession.name ?? 'Exercício', currentTarget) });
  const legacy = readSessionLibrary(storage, parse);
  if (legacy.warning) warnings.push(legacy.warning);
  for (const item of legacy.entries) add(item.session, { id: item.id, createdAt: item.savedAt });
  return { store: { version: LIBRARY_VERSION, activeId: current?.id ?? entries[0]?.id ?? null, entries }, warnings, legacyRecoveryRaw: legacy.recoveryRaw };
}

export function createExerciseLibrary({
  storage, parse, serialize, currentSession, now = isoNow, uuid = defaultUuid,
} = {}) {
  const target = storage ?? globalThis.localStorage;
  const listeners = new Set();
  let state = { version: LIBRARY_VERSION, activeId: null, entries: [] };
  let status = 'ready';
  let loadWarning = null;
  let writeWarning = null;
  let lastSaved = false;
  let recoveryRaw = null;
  let backupRaw = null;
  let lastDeleted = null;
  let corruptPreserved = false;
  const warnings = [];

  try { backupRaw = target.getItem(LIBRARY_BACKUP_KEY); } catch { /* Ajuda mostra apenas o que existe. */ }

  function emit() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* Um assinante quebrado não derruba a biblioteca. */ }
    }
  }

  function find(id) {
    return state.entries.find(entry => entry.id === id) ?? null;
  }

  // Persiste sem nunca perder dados: quota negada mantém o estado em memória.
  function persist() {
    if (status === 'corrupt') { lastSaved = false; return false; }
    try {
      target.setItem(LIBRARY_KEY, JSON.stringify(state));
      writeWarning = null;
      lastSaved = true;
      return true;
    } catch {
      writeWarning = 'Biblioteca não pôde ser salva neste navegador. Exporte os exercícios; o trabalho continua na memória.';
      lastSaved = false;
      return false;
    }
  }

  function load() {
    let raw = null;
    try { raw = target.getItem(LIBRARY_KEY); } catch {
      status = 'unavailable';
      loadWarning = 'Biblioteca indisponível neste navegador; exporte seus exercícios.';
      return;
    }
    if (raw === null) {
      const migrated = migrateFromLegacy({ currentSession, parse, serialize, storage: target, uuid, now });
      state = migrated.store;
      for (const item of migrated.warnings) warnings.push(item);
      if (migrated.legacyRecoveryRaw !== null) {
        loadWarning = migrated.warnings[0] ?? 'Biblioteca antiga corrompida: originais preservados; baixe-os em Ajuda antes de substituir.';
      }
      persist();
      return;
    }
    try {
      state = validateStore(JSON.parse(raw));
      state.entries = state.entries.map(entry => {
        const session = parse(JSON.stringify(entry.session));
        return {
          id: entry.id,
          createdAt: isString(entry.createdAt) ? entry.createdAt : now(),
          updatedAt: isString(entry.updatedAt) ? entry.updatedAt : now(),
          session,
          metadata: normalizeMetadata(entry.metadata, session),
        };
      });
    } catch {
      // Nunca sobrescreve bytes corrompidos: ficam recuperáveis até ação
      // explícita do usuário, e só depois de um backup integral confirmado.
      status = 'corrupt';
      recoveryRaw = raw;
      const migrated = migrateFromLegacy({ currentSession, parse, serialize, storage: target, uuid, now });
      state = migrated.store;
      for (const item of migrated.warnings) warnings.push(item);
      loadWarning = 'Biblioteca corrompida: originais preservados em recuperação. Baixe o backup em Ajuda antes de recuperar.';
      try {
        if (target.getItem(LIBRARY_RECOVERY_KEY) === null) target.setItem(LIBRARY_RECOVERY_KEY, raw);
        corruptPreserved = target.getItem(LIBRARY_RECOVERY_KEY) !== null;
      } catch { corruptPreserved = false; }
    }
  }

  function requireEntry(id) {
    const entry = find(id);
    if (!entry) throw new RangeError('Exercício não encontrado na biblioteca.');
    return entry;
  }

  load();

  // Chave de CONTEÚDO COMPLETO do exercício: sessão canônica + metadados +
  // histórico. O dono de cada treino e os carimbos de entrada ficam FORA da
  // chave (um backup reimportado depois de o exercício ser retreinado não vira
  // cópia sem fim; a cópia criada uma vez passa a casar). Metadados diferentes
  // com a mesma sessão são exercícios DIFERENTES de propósito.
  function fullContentKey(session, metadata) {
    const meta = isObject(metadata) ? metadata : {};
    const records = Array.isArray(meta.records) ? meta.records : [];
    const study = isObject(meta.study) && isObject(meta.study.recipe) ? meta.study : null;
    return JSON.stringify({
      session: serialize(session),
      name: isString(meta.name) ? meta.name : null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      targetBPM: meta.targetBPM === undefined ? null : meta.targetBPM,
      notes: isString(meta.notes) ? meta.notes : '',
      // A marca de conteúdo de curso entra na chave: um exercício marcado e um
      // sem marca não são o MESMO documento (a marca decide o que pode sair em
      // exportação/compartilhamento) — a importação não funde os dois.
      courseContent: meta.courseContent === true,
      // A receita do estudo define o exercício: duas sessões iguais com
      // receitas diferentes são exercícios diferentes. O VÍNCULO com o
      // original entra só como presença (`linked`), nunca pelo id: o id é
      // remapeado na importação e um backup reimportado não pode virar cópia
      // sem fim. `group` é um rótulo criado uma vez pela interface, estável
      // entre exportar e importar.
      ...(study ? { study: { version: study.version ?? null, recipe: study.recipe, group: study.group?.id ?? null, linked: study.origin !== null && study.origin !== undefined } } : {}),
      records: records.map(record => {
        const { ownerId, ...rest } = isObject(record) ? record : {};
        return rest;
      }),
    });
  }

  function api() {
    return {
      get status() { return status; },
      get warning() { return writeWarning ?? loadWarning; },
      get saved() { return lastSaved; },
      get warnings() { return warnings.slice(); },
      get recoveryRaw() { return recoveryRaw; },
      get backupRaw() { return backupRaw; },
      get key() { return LIBRARY_KEY; },
      get backupKey() { return LIBRARY_BACKUP_KEY; },
      size() { return state.entries.length; },
      active() { return state.activeId; },
      activeEntry() { return state.activeId ? clone(find(state.activeId)) : null; },
      get(id) {
        const entry = find(id);
        return entry ? clone(entry) : null;
      },
      records(id) { return find(id)?.metadata.records.map(clone) ?? []; },
      // Entradas COMPLETAS (sessão + metadados) para a sincronização: a lista
      // pública devolve resumos, e o documento remoto precisa do exercício
      // inteiro. Nada é sanitizado aqui — o payload de sincronização é o
      // snapshot autenticado do próprio usuário (etapa 8: cru, sempre).
      entries() { return state.entries.map(clone); },
      // Aplicação de documento remoto (etapa 7): o id de origem é PRESERVADO.
      // Reimportar por conteúdo criaria uma cópia nova, e a cópia voltaria como
      // um segundo exercício no outro navegador. Nada é apagado; sessão e
      // metadados passam pela mesma validação da casa (a marca
      // `metadata.courseContent` é preservada como veio).
      applyRemoteEntry(entry) {
        if (status === 'corrupt') throw new Error('Biblioteca corrompida; baixe os originais em Ajuda antes de sincronizar.');
        if (!isObject(entry) || !isNonEmptyString(entry.id)) throw new TypeError('Documento remoto sem identificador.');
        const session = parse(JSON.stringify(entry.session));
        const next = {
          id: entry.id,
          createdAt: isString(entry.createdAt) ? entry.createdAt : now(),
          updatedAt: isString(entry.updatedAt) ? entry.updatedAt : now(),
          session,
          metadata: normalizeMetadata(entry.metadata, session),
        };
        const index = state.entries.findIndex(candidate => candidate.id === next.id);
        if (index >= 0) state.entries[index] = next; else state.entries.push(next);
        if (!state.activeId) state.activeId = next.id;
        persist();
        emit();
        return clone(next);
      },
      // Lápide remota: remove o exercício, mas NUNCA deixa a biblioteca vazia
      // (a última entrada é protegida, como em deleteUndo).
      removeRemoteEntry(id) {
        if (status === 'corrupt') return false;
        if (state.entries.length <= 1) return false;
        const index = state.entries.findIndex(entry => entry.id === id);
        if (index < 0) return false;
        state.entries.splice(index, 1);
        if (state.activeId === id) state.activeId = state.entries[Math.min(index, state.entries.length - 1)]?.id ?? null;
        persist();
        emit();
        return true;
      },
      // Limpeza EXPLÍCITA do histórico de treinos: sem id, limpa todos os
      // exercícios; com id, só o exercício indicado. Exercício, nome,
      // etiquetas, alvo e anotações são preservados; nenhum chamador
      // automático existe (só a confirmação deliberada da interface).
      clearRecords(id = null) {
        const targets = id === null || id === undefined ? state.entries : [requireEntry(id)];
        let removed = 0;
        for (const entry of targets) {
          removed += entry.metadata.records.length;
          entry.metadata.records = [];
          entry.updatedAt = now();
        }
        if (targets.length === 0) return { removed: 0, exercises: 0, saved: true };
        const saved = persist();
        emit();
        return { removed, exercises: targets.length, saved };
      },
      tags() {
        const tags = new Set();
        for (const entry of state.entries) for (const tag of entry.metadata.tags) tags.add(tag);
        return [...tags].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      },
      list({ filter = {}, sort = 'untrained' } = {}) {
        return sortSummaries(filterSummaries(state.entries.map(summarize), filter), sort);
      },
      select(id) {
        const entry = find(id);
        if (!entry) return null;
        if (state.activeId !== id) { state.activeId = id; persist(); emit(); }
        return clone(entry);
      },
      // Novo exercício: a sessão vem do chamador (createStudioSession no app);
      // NUNCA clona a sessão atual — isso é responsabilidade de duplicate().
      new({ session: provided, metadata } = {}) {
        if (!isObject(provided)) throw new TypeError('Novo exercício precisa de uma sessão.');
        const session = parse(serialize(provided));
        const entry = {
          id: uuid(),
          createdAt: now(),
          updatedAt: now(),
          session: clone(session),
          // Exercício novo começa SEM alvo (null) — o cartão convida a definir
          // um em vez de sugerir o andamento atual como alvo.
          metadata: normalizeMetadata({ ...metadata, targetBPM: metadata?.targetBPM ?? null }, session),
        };
        state.entries.push(entry);
        state.activeId = entry.id;
        persist();
        emit();
        return clone(entry);
      },
      // Duplicar apenas copia; o chamador decide se abre a cópia (openExercise).
      duplicate(id) {
        const source = find(id);
        if (!source) return null;
        const session = clone(source.session);
        // Reserva o espaço do sufixo dentro do teto: base + sufixo ≤ 80.
        const base = (source.metadata.name || session.name || 'Exercício').trim() || 'Exercício';
        session.name = `${base.slice(0, SESSION_NAME_MAX - DUPLICATE_SUFFIX.length).trimEnd()}${DUPLICATE_SUFFIX}`;
        const entry = {
          id: uuid(),
          createdAt: now(),
          updatedAt: now(),
          session,
          metadata: { ...clone(source.metadata), name: session.name, records: [] },
        };
        state.entries.push(entry);
        persist();
        emit();
        return clone(entry);
      },
      updateMetadata(id, patch = {}) {
        const entry = requireEntry(id);
        if (isObject(patch) && Object.hasOwn(patch, 'name')) {
          // O nome vive na sessão canônica: validar aqui evita gravar um
          // documento inválido e condenar a loja inteira no próximo carregamento.
          if (!validName(patch.name)) {
            throw new RangeError(`O nome do exercício deve ser um texto de até ${SESSION_NAME_MAX} caracteres.`);
          }
        }
        const next = normalizeMetadata({ ...entry.metadata, ...patch }, entry.session);
        entry.metadata = next;
        entry.session.name = next.name;
        entry.updatedAt = now();
        persist();
        emit();
        return clone(entry);
      },
      autosave(session, id = state.activeId) {
        const entry = find(id);
        if (!entry) return null;
        const next = clone(session);
        // O campo Nome do Estúdio é o mesmo nome do exercício. Um nome fora do
        // teto nunca é gravado (nem truncado em silêncio): mantém o último nome
        // válido, e metadata.name/session.name continuam idênticos.
        if (validName(next.name)) { next.name = next.name.trim(); entry.metadata.name = next.name; }
        else next.name = entry.metadata.name;
        entry.session = next;
        persist();
        emit();
        return clone(entry);
      },
      deleteUndo(id) {
        // A biblioteca nunca fica vazia: ela guarda o exercício ativo.
        if (state.entries.length <= 1) return null;
        const index = state.entries.findIndex(entry => entry.id === id);
        if (index < 0) throw new RangeError('Exercício não encontrado na biblioteca.');
        lastDeleted = { entry: state.entries[index], index };
        state.entries.splice(index, 1);
        if (state.activeId === id) state.activeId = state.entries[Math.min(index, state.entries.length - 1)]?.id ?? null;
        persist();
        emit();
        return clone(lastDeleted.entry);
      },
      undoDelete() {
        if (!lastDeleted) return null;
        const { entry, index } = lastDeleted;
        lastDeleted = null;
        if (find(entry.id)) return null;
        state.entries.splice(Math.min(index, state.entries.length), 0, entry);
        persist();
        emit();
        return clone(entry);
      },
      canUndoDelete() { return lastDeleted !== null; },
      // Recuperação explícita da loja nova: só depois de o estado cru estar
      // preservado (recuperação própria ou backup integral). Nunca apaga
      // bytes legados nem a recuperação.
      replaceCorrupt() {
        if (status !== 'corrupt') return false;
        if (!corruptPreserved && backupRaw === null) {
          writeWarning = 'Backup integral ausente; baixe os originais em Ajuda antes de recuperar.';
          return false;
        }
        try { target.setItem(LIBRARY_KEY, JSON.stringify(state)); }
        catch { writeWarning = 'Não foi possível recuperar a biblioteca: armazenamento negado.'; return false; }
        status = 'ready';
        recoveryRaw = null;
        loadWarning = null;
        writeWarning = null;
        persist();
        emit();
        return true;
      },
      subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('Assinante inválido.');
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      exportExercise(id) {
        const entry = requireEntry(id);
        return JSON.stringify({
          version: LIBRARY_VERSION, kind: 'groovegoblin-exercise', exportedAt: now(),
          exercise: { id: entry.id, createdAt: entry.createdAt, updatedAt: entry.updatedAt, metadata: clone(entry.metadata), session: clone(entry.session) },
        });
      },
      exportLibrary() {
        return JSON.stringify({
          version: LIBRARY_VERSION, kind: 'groovegoblin-exercise-library', exportedAt: now(),
          activeId: state.activeId, entries: state.entries.map(clone),
        });
      },
      // Mescla sem sobrescrever: sessões idênticas já presentes são ignoradas.
      importExercise(text) {
        const payload = JSON.parse(text);
        const candidates = [];
        if (isObject(payload) && payload.kind === 'groovegoblin-exercise' && isObject(payload.exercise)) {
          candidates.push({ session: payload.exercise.session, metadata: payload.exercise.metadata });
        } else if (isObject(payload) && isObject(payload.entry) && isObject(payload.entry.session)) {
          candidates.push({ session: payload.entry.session, metadata: payload.entry.metadata });
        } else {
          candidates.push({ session: payload, metadata: null });
        }
        return mergeCandidates(candidates);
      },
      importLibrary(text) {
        const payload = JSON.parse(text);
        const list = Array.isArray(payload) ? payload : Array.isArray(payload?.entries) ? payload.entries : null;
        if (!list) throw new Error('Arquivo de biblioteca inválido.');
        return mergeCandidates(list.map(entry => ({ session: entry?.session, metadata: entry?.metadata })));
      },
      // Importação AGREGADA (etapa 7): preserva o exercício INTEIRO — sessão,
      // metadados, anotações e histórico. Deduplica pelo CONTEÚDO COMPLETO
      // (sessão canônica + metadados, ignorando o dono dos treinos e os
      // carimbos de entrada): reimportar o mesmo backup cai no mesmo exercício,
      // e sessão igual com metadados diferentes vira OUTRO exercício,
      // preservando os dois. Devolve o mapa origem→destino para a importação
      // remapear os vínculos (vivos e tombstones) das aulas.
      importEntries(entries, { activeId = null } = {}) {
        if (status === 'corrupt') throw new Error('Biblioteca corrompida; baixe os originais em Ajuda antes de importar.');
        if (!Array.isArray(entries)) throw new TypeError('A importação precisa da lista de exercícios.');
        // Validação TOTAL antes de qualquer mudança: sessão canônica e nome
        // dentro do teto. Entrada inválida rejeita a importação inteira.
        const prepared = [];
        entries.forEach((raw, index) => {
          if (!isObject(raw) || !isObject(raw.session)) throw new Error(`Importação incompatível: o exercício ${index + 1} do backup não traz uma sessão. Nada foi alterado.`);
          let session;
          try { session = parse(JSON.stringify(raw.session)); }
          catch { throw new Error(`Importação incompatível: a sessão do exercício ${index + 1} não é válida. Nada foi alterado.`); }
          if (isObject(raw.metadata) && Object.hasOwn(raw.metadata, 'name') && !validName(raw.metadata.name)) {
            throw new Error(`Importação incompatível: o nome do exercício ${index + 1} deve ter até ${SESSION_NAME_MAX} caracteres. Nada foi alterado.`);
          }
          prepared.push({ sourceId: isNonEmptyString(raw.id) ? raw.id : `exercicio-${index + 1}`, session, metadata: raw.metadata ?? null });
        });
        const known = new Map();
        for (const entry of state.entries) known.set(fullContentKey(entry.session, entry.metadata), entry.id);
        const next = state.entries.slice();
        // Mapa origem→destino SEM protótipo: os ids de origem vêm do backup e
        // podem ser `__proto__`, `constructor` ou `toString` — num objeto comum
        // esses nomes responderiam com o protótipo em vez do destino.
        const map = Object.create(null);
        const created = [];
        const linked = [];
        for (const item of prepared) {
          const candidate = {
            id: uuid(),
            createdAt: now(),
            updatedAt: now(),
            session: clone(item.session),
            metadata: normalizeMetadata(item.metadata, item.session),
          };
          const key = fullContentKey(candidate.session, candidate.metadata);
          // O `known` é a fotografia da biblioteca ANTES do arquivo: a
          // importação nunca apaga um exercício do backup, então duas entradas
          // de conteúdo igual NO MESMO arquivo entram as duas (o usuário as
          // criou, a biblioteca as aceita). Reimportar o mesmo backup continua
          // não duplicando nada, porque aí as duas já existem.
          const existing = known.get(key);
          if (existing) { map[item.sourceId] = existing; continue; }
          // O dono dos treinos passa a ser o id DESTE exercício: nenhum
          // registro fica apontando para o exercício de origem.
          candidate.metadata.records = candidate.metadata.records.map(record => ({ ...record, ownerId: candidate.id }));
          next.push(candidate);
          map[item.sourceId] = candidate.id;
          created.push({ sourceId: item.sourceId, id: candidate.id });
          if (candidate.metadata.study?.origin) linked.push(candidate);
        }
        // Vínculo de variação: o original apontado pelo backup é REMAPEADO para
        // o exercício desta biblioteca quando ele veio no mesmo arquivo. Um
        // vínculo que aponta para fora (ou para si mesmo) fica sem id, com o
        // nome guardado — nenhum exercício passa a apontar para o id errado.
        for (const candidate of linked) {
          const target = map[candidate.metadata.study.origin.id];
          if (target === undefined) continue;
          const origin = target === candidate.id ? null : { ...candidate.metadata.study.origin, id: target };
          candidate.metadata.study = { ...candidate.metadata.study, origin };
        }
        const added = next.length - state.entries.length;
        const mappedActive = isNonEmptyString(activeId) ? map[activeId] ?? null : null;
        // Preserva a seleção atual quando ela existe e continua na biblioteca;
        // só adota o ativo do backup quando o atual não existe mais.
        const nextActive = state.activeId && next.some(entry => entry.id === state.activeId)
          ? state.activeId
          : mappedActive ?? next[0]?.id ?? null;
        if (added > 0 || nextActive !== state.activeId) {
          // GRAVA antes de mexer na memória: quota/armazenamento negado não cria
          // registro fantasma nem perde o que já estava salvo.
          const document = { version: LIBRARY_VERSION, activeId: nextActive, entries: next };
          try { target.setItem(LIBRARY_KEY, JSON.stringify(document)); }
          catch { throw new Error('Não foi possível salvar a importação: o armazenamento do navegador recusou (espaço). A biblioteca ficou como estava.'); }
          state = document;
          lastSaved = true;
          writeWarning = null;
          emit();
        }
        return { added, reused: prepared.length - added, activeId: nextActive, map, created };
      },
      captureRunContext,
      recordRun,
    };
  }

  // Importação estrita de sessão (legado abre normalmente via parse) e sem
  // sobrescrita: duplicatas canônicas são puladas, nunca mescladas por índice.
  // Uma candidata incompatível rejeita a importação inteira: nada é truncado em
  // silêncio e nada é gravado (nem sobrescrito) — a loja fica como estava.
  function mergeCandidates(candidates) {
    if (status === 'corrupt') throw new Error('Biblioteca corrompida; baixe os originais em Ajuda antes de importar.');
    const prepared = candidates.map(candidate => {
      let session;
      try { session = parse(JSON.stringify(candidate?.session)); }
      catch { throw new Error('Importação incompatível: a sessão não é válida. Nada foi alterado.'); }
      if (isObject(candidate?.metadata) && Object.hasOwn(candidate.metadata, 'name') && !validName(candidate.metadata.name)) {
        throw new Error(`Importação incompatível: o nome do exercício deve ter até ${SESSION_NAME_MAX} caracteres. Nada foi alterado.`);
      }
      return { session, metadata: candidate?.metadata };
    });
    const seen = new Set(state.entries.map(entry => serialize(entry.session)));
    let added = 0;
    let skipped = 0;
    for (const { session, metadata: raw } of prepared) {
      const canonical = serialize(session);
      if (seen.has(canonical)) { skipped += 1; continue; }
      seen.add(canonical);
      state.entries.push({
        id: uuid(), createdAt: now(), updatedAt: now(), session: clone(session), metadata: normalizeMetadata(raw, session),
      });
      added += 1;
    }
    if (added > 0) { persist(); emit(); }
    return { added, skipped };
  }

  // Contexto capturado no INÍCIO da execução: dono ativo, horário real de
  // início e impressão digital do material executado. Nada aqui é reavaliado
  // ao terminar; o dono nunca muda depois.
  function captureRunContext(session, { source = null, objective = null } = {}) {
    const goal = session?.training?.goal ?? null;
    const repetitions = session?.training?.repetitions ?? null;
    const ownerId = state.activeId;
    const owner = ownerId ? find(ownerId) : null;
    // Autoral x gerado: a execução é o próprio exercício quando o material
    // bate com a sessão autoral; caso contrário é material derivado.
    const resolvedSource = source === 'authored' || source === 'generated' ? source
      : owner && materialSignature(owner.session) === materialSignature(session) ? 'authored' : 'generated';
    return {
      ownerId,
      startedAt: now(),
      source: resolvedSource,
      objective,
      goal,
      repetitions,
      bpm: finiteOr(session?.bpm, null),
      referenceFingerprint: referenceFingerprint(session, { goal, repetitions }),
      session: clone(session),
    };
  }

  // Registra um treino avaliado no exercício dono, sem tocar na sessão autoral.
  function recordRun(context, detail = {}) {
    if (!context || !context.ownerId) return null;
    const entry = find(context.ownerId);
    if (!entry) return null;
    const endedAt = now();
    const started = Date.parse(context.startedAt);
    const ended = Date.parse(endedAt);
    const durationMs = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null;
    const summary = isObject(detail.summary) ? detail.summary : isObject(detail.results?.summary) ? detail.results.summary : {};
    const record = normalizeRecord({
      id: uuid(),
      ownerId: context.ownerId,
      startedAt: context.startedAt,
      endedAt,
      completedAt: endedAt,
      durationMs,
      date: context.startedAt,
      bpm: finiteOr(detail.bpm, context.bpm),
      mode: detail.mode ?? 'train',
      goal: detail.goal ?? context.goal,
      repetitions: finiteOr(detail.repetitions, context.repetitions),
      source: context.source,
      objective: context.objective,
      referenceFingerprint: context.referenceFingerprint,
      summary,
      metric: finiteOr(detail.metric, null),
      tempoDelta: finiteOr(detail.tempoDelta, 0),
    });
    entry.metadata.records.push(record);
    entry.updatedAt = endedAt;
    persist();
    emit();
    return clone(record);
  }

  return api();
}
