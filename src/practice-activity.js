// Tempo de prática real, medido por INTERVALOS FECHADOS. Cada consumidor
// (treinador, Hoje) abre um intervalo quando o som começa de verdade e o fecha
// em finish/stop/pausa/borrar a página; o armazenamento não conhece "sessão
// aberta" e nunca inventa duração a partir do último ataque observado.
//
// Uma instância única por app (createPracticeActivity) é passada no host, para
// que Hoje, Percurso e o treinador leiam e escrevam o mesmo estado.
//
// Contrato do registro: { id, exerciseId, instrument, startedAt, endedAt,
// durationMs, source, mode }. startedAt/endedAt são ISO; durationMs é DERIVADO
// do intervalo fechado (ou null quando o intervalo não é válido). Idempotência
// por id: repetir um encerramento não duplica o treino.
//
// Corrupção e cota NUNCA autorizam perder ou sobrescrever os bytes originais:
// com a loja corrompida (JSON inválido, registro inválido, duplicata
// conflitante) os novos intervalos ficam só em memória, com aviso, até uma
// recuperação ou limpeza EXPLÍCITA do consumidor. flush()/pagehide nunca
// transforma corrupção em loja vazia.

export const PRACTICE_ACTIVITY_KEY = 'groovegoblin.practice-activity.v1';
export const PRACTICE_ACTIVITY_RECOVERY_KEY = `${PRACTICE_ACTIVITY_KEY}.recovery`;
export const ACTIVITY_VERSION = 1;
export const ACTIVITY_INSTRUMENTS = Object.freeze(['guitar', 'bass']);
export const ACTIVITY_SOURCES = Object.freeze(['trainer', 'today']);
const MAX_TEXT = 120;
const MAX_EPOCH = 8640000000000000;

const memory = new Map();

// Armazenamento tolerante: sem localStorage (ou com acesso bloqueado) a
// atividade continua em memória nesta página, com aviso explícito. O acesso ao
// globalThis.localStorage fica DENTRO do try: um getter que lança SecurityError
// não pode impedir o app de abrir.
export function activityStorage(candidate) {
  try {
    const value = candidate === undefined ? globalThis.localStorage : candidate;
    if (value && typeof value.getItem === 'function' && typeof value.setItem === 'function') return value;
  } catch {
    // acesso bloqueado: usar memória volátil
  }
  return {
    volatile: true,
    getItem: key => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: key => memory.delete(key),
  };
}

function text(value, max = MAX_TEXT) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

// Instante ISO válido. Números fora do intervalo representável por Date são
// rejeitados antes de qualquer toISOString (que lançaria RangeError).
function instant(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_EPOCH) return null;
    return new Date(value).toISOString();
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// Intervalo fechado válido: início e fim reais, fim nunca antes do início.
// Qualquer outro caso é rejeitado — nunca "corrigido" com um palpite.
export function normalizeActivityInterval({ startedAt, endedAt } = {}) {
  const start = instant(startedAt);
  const end = instant(endedAt);
  if (!start || !end) return null;
  const durationMs = Date.parse(end) - Date.parse(start);
  if (durationMs < 0) return null;
  return { startedAt: start, endedAt: end, durationMs };
}

export function normalizeActivityRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = text(value.id, 80);
  const source = ACTIVITY_SOURCES.includes(value.source) ? value.source : null;
  const instrument = ACTIVITY_INSTRUMENTS.includes(value.instrument) ? value.instrument : null;
  const mode = text(value.mode, 32);
  const interval = normalizeActivityInterval(value);
  // exerciseId ausente é aceito (null); exerciseId presente e inválido é
  // rejeitado — nunca trocado em silêncio por null.
  const rawExercise = value.exerciseId;
  const exerciseId = rawExercise === undefined || rawExercise === null ? null : text(rawExercise, MAX_TEXT);
  if (rawExercise !== undefined && rawExercise !== null && exerciseId === null) return null;
  if (!id || !source || !instrument || !mode || !interval) return null;
  return { id, exerciseId, instrument, source, mode, ...interval };
}

function clone(record) {
  return { ...record };
}

function same(record, other) {
  return record.id === other.id && record.exerciseId === other.exerciseId && record.instrument === other.instrument
    && record.source === other.source && record.mode === other.mode
    && record.startedAt === other.startedAt && record.endedAt === other.endedAt;
}

function defaultUuid() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    // segue para o gerador local
  }
  return `act-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
}

// Loja íntegra: registros válidos e sem conflito. Um só registro inválido (ou
// duplicata com conteúdo diferente) marca o documento inteiro como corrompido:
// ler continua possível, escrever exige recuperação/limpeza explícita.
function validateStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'estado não é um objeto', records: [] };
  if (value.version !== ACTIVITY_VERSION) return { ok: false, error: `versão não suportada: ${String(value.version)}`, records: [] };
  if (value.records !== undefined && !Array.isArray(value.records)) return { ok: false, error: 'registros não são uma lista', records: [] };
  const records = [];
  let error = null;
  for (const item of Array.isArray(value.records) ? value.records : []) {
    const record = normalizeActivityRecord(item);
    if (!record) { error ??= 'registro de prática inválido'; continue; }
    const existing = records.find(entry => entry.id === record.id);
    if (existing && !same(existing, record)) { error ??= 'registro duplicado conflitante'; continue; }
    if (!existing) records.push(record);
  }
  return { ok: error === null, error, records };
}

// now é aceito pelo contrato da fábrica para os consumidores passarem o seu
// relógio; nenhum instante do registro é derivado dele (o intervalo fechado do
// chamador é a única fonte de tempo).
export function createPracticeActivity({ storage, now = Date.now, uuid = defaultUuid } = {}) {
  void now;
  const target = activityStorage(storage);
  let status = 'ready';
  let warning = null;
  let recoveryRaw = null;
  let records = [];

  function read() {
    let raw = null;
    try {
      raw = target.getItem(PRACTICE_ACTIVITY_KEY);
    } catch (error) {
      status = 'unavailable';
      warning = `Não foi possível ler o tempo de prática (${error?.message ?? error}).`;
      return;
    }
    if (raw === null || raw === undefined) return;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      status = 'corrupt';
      recoveryRaw = raw;
      warning = 'Tempo de prática corrompido; os bytes antigos ficam preservados e nada é sobrescrito até uma recuperação explícita.';
      return;
    }
    const checked = validateStore(parsed);
    if (!checked.ok) {
      status = 'corrupt';
      recoveryRaw = raw;
      records = checked.records;
      warning = `Tempo de prática inválido (${checked.error}); os bytes antigos ficam preservados e nada é sobrescrito até uma recuperação explícita.`;
      return;
    }
    records = checked.records;
  }

  read();

  // explicit=true só em recuperação/limpeza pedidas pelo consumidor. Enquanto a
  // loja está corrompida, escrever preservaria os bytes originais e descartaria
  // os registros inválidos: por isso a gravação fica bloqueada e os intervalos
  // novos seguem em memória. Falha de cota mantém tudo em memória e avisa.
  function persist(explicit = false) {
    if (status === 'corrupt' && !explicit) return false;
    const payload = JSON.stringify({ version: ACTIVITY_VERSION, records });
    try {
      if (recoveryRaw !== null && target.getItem(PRACTICE_ACTIVITY_RECOVERY_KEY) === null) {
        target.setItem(PRACTICE_ACTIVITY_RECOVERY_KEY, recoveryRaw);
      }
      target.setItem(PRACTICE_ACTIVITY_KEY, payload);
      if (status === 'quota' || status === 'corrupt') status = 'ready';
      return true;
    } catch (error) {
      status = 'quota';
      warning = `Tempo de prática não foi gravado no navegador (${error?.name ?? 'erro'}); os registros seguem nesta página.`;
      return false;
    }
  }

  const listeners = new Set();
  function emit() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* assinante com erro não interrompe a gravação */ }
    }
  }

  function sorted() {
    return [...records].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id));
  }

  return {
    get status() { return status; },
    get warning() { return warning; },
    get recoveryRaw() { return recoveryRaw; },
    get volatile() { return target.volatile === true; },
    get key() { return PRACTICE_ACTIVITY_KEY; },
    get recoveryKey() { return PRACTICE_ACTIVITY_RECOVERY_KEY; },
    size() { return records.length; },
    // Idempotente por id: o mesmo encerramento repetido (pagehide + stop) não
    // duplica o intervalo; devolve o registro já existente.
    append(entry = {}) {
      const rawId = entry?.id;
      const id = rawId === undefined || rawId === null ? uuid() : text(rawId, 80);
      if (!id) {
        warning = 'Intervalo de prática ignorado: o id informado é inválido.';
        return null;
      }
      const record = normalizeActivityRecord({ ...entry, id });
      if (!record) {
        warning = 'Intervalo de prática ignorado: início e fim precisam ser reais, o fim não pode vir antes do início e exerciseId/instrumento/source precisam ser válidos.';
        return null;
      }
      const existing = records.find(item => item.id === record.id);
      if (existing) return same(existing, record) ? clone(existing) : null;
      records.push(record);
      persist();
      emit();
      return clone(record);
    },
    list() { return sorted().map(clone); },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Assinante inválido.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Encerramento explícito: reescreve o que já está em memória (o consumidor
    // fecha o intervalo antes de chamar isto). Não destrava corrupção.
    flush() { return persist(false); },
    // Limpeza pedida pelo usuário: preserva os bytes corrompidos na chave de
    // recuperação antes de gravar uma loja vazia. Os bytes antigos continuam
    // disponíveis em recoveryRaw/recoveryKey.
    clear() {
      records = [];
      persist(true);
      emit();
      return true;
    },
    // Recuperação explícita: mantém os registros válidos que já estão em memória
    // e volta a gravar, com os bytes originais preservados.
    recover() {
      const saved = persist(true);
      emit();
      return saved;
    },
  };
}
