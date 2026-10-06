// Tempo real praticado (rodada 4, item 5): matemática de intervalos e dias
// locais, sem DOM e sem armazenamento.
//
// O Percurso soma TEMPO DE PAREDE, não execuções. O treinador, a fila de Hoje
// e o registro avaliado da biblioteca descrevem a MESMA prática; somar cada
// fonte separadamente multiplicaria o mesmo treino por dois ou três. Por isso
// todo total passa por uma UNIÃO de intervalos sobrepostos (ou encostados).
//
// Dias são LOCAIS e vêm do calendário do usuário: um dia pode ter 23, 24 ou
// 25 horas, então nada aqui usa 86400000 ms como "um dia" — as fronteiras são
// obtidas com setDate/setHours, que respeitam o horário de verão.
//
// Intervalo sem início/fim válidos (legado sem intervalo, ISO inválido,
// duração zero) NUNCA ganha duração inventada: fica fora das somas e continua
// visível nas listas de registros.

export const WINDOW_DAYS = 28;
export const DAY_MS = 86400000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Instante em ms a partir de ISO ou de número. Nunca arredonda nem assume
// "agora" para um valor inválido: devolve null.
export function parseInstant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Chave do dia LOCAL no formato AAAA-MM-DD (estável para agrupar e comparar).
export function localDayKey(value) {
  const ms = parseInstant(value);
  if (ms === null) return null;
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// Meia-noite local do dia do instante (respeita DST: não é múltiplo de 24 h).
export function startOfLocalDay(value) {
  const ms = parseInstant(value);
  if (ms === null) return null;
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// Soma dias de CALENDÁRIO preservando o horário local (o dia pode ter 23/25 h).
export function addLocalDays(value, delta) {
  const ms = parseInstant(value);
  if (ms === null) return null;
  const date = new Date(ms);
  date.setDate(date.getDate() + delta);
  return date.getTime();
}

export function nextLocalMidnight(value) {
  const start = startOfLocalDay(value);
  return start === null ? null : addLocalDays(start, 1);
}

// Últimas `count` datas locais, terminando no dia de `now` (inclusive).
export function recentDayKeys(count, now = Date.now()) {
  const size = Number.isInteger(count) && count > 0 ? count : WINDOW_DAYS;
  const today = startOfLocalDay(now);
  if (today === null) return [];
  const keys = [];
  for (let index = size - 1; index >= 0; index -= 1) keys.push(localDayKey(addLocalDays(today, -index)));
  return keys;
}

function instrumentOf(value) {
  return value === 'guitar' || value === 'bass' ? value : null;
}

function sourceOf(value) {
  return value === 'trainer' || value === 'today' || value === 'record' ? value : null;
}

// Normaliza um intervalo de tempo real. Exige intervalo FECHADO e positivo;
// duração é sempre derivada do intervalo, nunca de um campo gravado.
export function normalizeInterval(value) {
  if (!isObject(value)) return null;
  const startMs = parseInstant(value.startMs ?? value.startedAt);
  const endMs = parseInstant(value.endMs ?? value.endedAt);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return {
    id: typeof value.id === 'string' && value.id.length > 0 ? value.id : null,
    exerciseId: typeof value.exerciseId === 'string' && value.exerciseId.length > 0 ? value.exerciseId : null,
    ownerId: typeof value.ownerId === 'string' && value.ownerId.length > 0 ? value.ownerId : null,
    instrument: instrumentOf(value.instrument),
    source: sourceOf(value.source),
    mode: typeof value.mode === 'string' && value.mode.length > 0 ? value.mode : null,
    startMs,
    endMs,
    ms: endMs - startMs,
  };
}

function isNormalized(value) {
  return isObject(value) && typeof value.startMs === 'number' && typeof value.endMs === 'number' && typeof value.ms === 'number';
}

function asInterval(value) {
  return isNormalized(value) ? value : normalizeInterval(value);
}

// Junta registros avaliados da biblioteca e intervalos de activity.list().
// `resolveInstrument(exerciseId)` é injetado: o registro avaliado guarda o dono
// (exerciseId), mas quem sabe o instrumento é a biblioteca. Um registro
// importado pode trazer um ownerId HISTÓRICO de outro contêiner; a resolução
// usa o exerciseId do contêiner atual quando ele existe, para que um exercício
// importado nunca seja lido como outro exercício nem caia em "sem instrumento".
export function buildIntervals({ records = [], activity = [], resolveInstrument = null } = {}) {
  const intervals = [];
  const resolve = typeof resolveInstrument === 'function' ? resolveInstrument : () => null;
  for (const record of Array.isArray(records) ? records : []) {
    if (!isObject(record)) continue;
    const exerciseId = typeof record.exerciseId === 'string' && record.exerciseId.length > 0 ? record.exerciseId : record.ownerId ?? null;
    let instrument = null;
    try { instrument = instrumentOf(resolve(exerciseId)); } catch { instrument = null; }
    const interval = normalizeInterval({
      id: record.id, exerciseId, ownerId: record.ownerId ?? null, instrument,
      source: 'record', mode: record.mode, startedAt: record.startedAt, endedAt: record.endedAt,
    });
    if (interval) intervals.push(interval);
  }
  for (const entry of Array.isArray(activity) ? activity : []) {
    const interval = normalizeInterval(entry);
    if (interval) intervals.push(interval);
  }
  return intervals.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

// União de intervalos: sobrepostos ou encostados viram um único intervalo.
// Cada treino do Hoje pode aparecer como activity(today) + activity(trainer) +
// registro avaliado; sem a união, o mesmo minuto seria contado 3 vezes.
export function unionIntervals(items = []) {
  const valid = [];
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = asInterval(item);
    if (normalized) valid.push(normalized);
  }
  valid.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const spans = [];
  for (const item of valid) {
    const last = spans[spans.length - 1];
    if (last && item.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, item.endMs);
      last.ms = last.endMs - last.startMs;
      last.count += 1;
      if (item.id) last.ids.push(item.id);
      if (item.instrument && !last.instruments.includes(item.instrument)) last.instruments.push(item.instrument);
      if (item.source && !last.sources.includes(item.source)) last.sources.push(item.source);
      continue;
    }
    spans.push({
      startMs: item.startMs,
      endMs: item.endMs,
      ms: item.ms,
      count: 1,
      ids: item.id ? [item.id] : [],
      instruments: item.instrument ? [item.instrument] : [],
      sources: item.source ? [item.source] : [],
    });
  }
  return spans;
}

export function totalMs(items = []) {
  return unionIntervals(items).reduce((sum, span) => sum + span.ms, 0);
}

// Divide um intervalo nas suas datas LOCAIS. Atravessa meia-noite e DST sem
// presumir dias de 24 h: o pedaço de um dia de 23 h tem 23 h.
export function splitByLocalDays(startMs, endMs) {
  const from = parseInstant(startMs);
  const to = parseInstant(endMs);
  const pieces = [];
  if (from === null || to === null || to <= from) return pieces;
  let cursor = from;
  while (cursor < to) {
    const boundary = Math.min(nextLocalMidnight(cursor) ?? to, to);
    pieces.push({ dayKey: localDayKey(cursor), startMs: cursor, endMs: boundary, ms: boundary - cursor });
    cursor = boundary;
  }
  return pieces;
}

// Tempo real por dia local nas últimas `days` datas (inclusive hoje), já com a
// união aplicada: `ms` é tempo de parede distinto, nunca a soma bruta das
// fontes. Dias sem prática aparecem com zero.
export function dailyTotals(items = [], { days = WINDOW_DAYS, now = Date.now() } = {}) {
  const size = Number.isInteger(days) && days > 0 ? days : WINDOW_DAYS;
  const todayStart = startOfLocalDay(now);
  if (todayStart === null) return { days: size, windowStart: null, windowEnd: null, byDay: [], totalMs: 0, practicedDays: 0 };
  const windowStart = addLocalDays(todayStart, -(size - 1));
  const windowEnd = addLocalDays(todayStart, 1);
  const keys = [];
  for (let index = 0; index < size; index += 1) keys.push(localDayKey(addLocalDays(windowStart, index)));
  const totals = new Map(keys.map(key => [key, 0]));
  for (const span of unionIntervals(items)) {
    const start = Math.max(span.startMs, windowStart);
    const end = Math.min(span.endMs, windowEnd);
    if (end <= start) continue;
    for (const piece of splitByLocalDays(start, end)) {
      if (totals.has(piece.dayKey)) totals.set(piece.dayKey, totals.get(piece.dayKey) + piece.ms);
    }
  }
  const byDay = keys.map(dayKey => ({ dayKey, ms: totals.get(dayKey) }));
  const total = byDay.reduce((sum, row) => sum + row.ms, 0);
  return { days: size, windowStart, windowEnd, byDay, totalMs: total, practicedDays: byDay.filter(row => row.ms > 0).length };
}

// Totais por instrumento: cada categoria é unida dentro de si (o mesmo treino
// em duas fontes conta uma vez) e intervalos sem instrumento identificado
// ficam em `unknown`, nunca chutados para guitarra nem para baixo.
export function instrumentTotals(items = [], { from = null, to = null } = {}) {
  const groups = new Map([['guitar', []], ['bass', []], ['unknown', []]]);
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = asInterval(item);
    if (!normalized) continue;
    groups.get(normalized.instrument ?? 'unknown').push(normalized);
  }
  const result = {};
  for (const [key, list] of groups) {
    let ms = 0;
    let spans = 0;
    for (const span of unionIntervals(list)) {
      const start = from === null ? span.startMs : Math.max(span.startMs, from);
      const end = to === null ? span.endMs : Math.min(span.endMs, to);
      if (end > start) { ms += end - start; spans += 1; }
    }
    result[key] = { ms, spans };
  }
  return result;
}

// Quantos intervalos brutos entraram em cada fonte (transparência do painel).
export function sourceCounts(items = []) {
  const counts = { trainer: 0, today: 0, record: 0, unknown: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = asInterval(item);
    if (!normalized) continue;
    counts[normalized.source ?? 'unknown'] += 1;
  }
  return counts;
}

// Registros avaliados da biblioteca com intervalo fechado válido, de todos os
// exercícios. Cada registro recebe o id do CONTÊINER atual (não o ownerId
// histórico de uma importação) para que instrumento/agrupamento sigam o
// exercício onde o registro está guardado. Legado sem startedAt/endedAt fica de
// fora (duração desconhecida).
export function recordIntervals(library) {
  if (!library || typeof library.list !== 'function' || typeof library.records !== 'function') return [];
  const records = [];
  for (const row of library.list()) {
    for (const record of library.records(row.id)) records.push({ ...record, exerciseId: row.id });
  }
  return records;
}
