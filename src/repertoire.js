// Modelo puro do laboratório de repertório: itens (referências importadas, takes
// e derivados), marcadores, trechos A–B, exercícios, setlists e comparação.
// Sem DOM e sem armazenamento: a visão (repertoire-view.js) monta a interface e
// repertoire-store.js persiste. Tempos de áudio em segundos; notas da sessão em
// ticks (4 ticks = semínima).

export { mountRepertoire } from './repertoire-view.js';

export const ITEM_KINDS = Object.freeze(['reference', 'take', 'derived']);
export const ITEM_SOURCES = Object.freeze({
  import: 'Arquivo importado',
  package: 'Referência de pacote',
  'session-render': 'Render do arranjo gerado',
  attempt: 'Tentativa de teclado/toque (renderizada)',
  mix: 'Mistura: referência + arranjo gerado',
  'hpss-harmonic': 'Estimativa harmônica (HPSS)',
  'hpss-percussive': 'Estimativa percussiva (HPSS)',
  processed: 'Trecho com velocidade/altura alteradas',
});
export const MARKER_KINDS = Object.freeze({ section: 'Seção', comment: 'Comentário', reference: 'Referência' });
export const SECTION_PRESETS = Object.freeze(['Intro', 'Verso', 'Pré-refrão', 'Refrão', 'Ponte', 'Solo', 'Final']);
export const MIN_REGION_SECONDS = 0.05;
export const MAX_MARKERS = 500;
export const DEFAULT_PROCESSING = Object.freeze({ speed: 1, semitones: 0, cents: 0, algorithm: 'vocoder' });

const TICKS_PER_QUARTER = 4;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function text(value, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function createId(prefix = 'rep') {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

export function formatTime(seconds, { precise = true } = {}) {
  if (!Number.isFinite(seconds)) return '--:--';
  const sign = seconds < 0 ? '-' : '';
  const value = Math.abs(seconds);
  const minutes = Math.floor(value / 60);
  const rest = value - minutes * 60;
  const secondsText = precise ? rest.toFixed(1).padStart(4, '0') : String(Math.floor(rest)).padStart(2, '0');
  return `${sign}${minutes}:${secondsText}`;
}

// Aceita "83.4", "83,4", "1:23.4" ou "1:23,4".
export function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const clean = value.trim().replace(',', '.');
  const match = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(clean);
  if (!match) return NaN;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = Number(match[2]);
  if (match[1] && seconds >= 60) return NaN;
  return minutes * 60 + seconds;
}

export function normalizeRegion(region, duration) {
  if (!isObject(region) || !Number.isFinite(duration) || duration <= 0) return null;
  const a = clamp(finite(region.start, NaN), 0, duration);
  const b = clamp(finite(region.end, NaN), 0, duration);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  return end - start >= MIN_REGION_SECONDS ? { start, end } : null;
}

export function createMarker({ kind = 'comment', time = 0, end = null, label = '', text: body = '' } = {}) {
  if (!Object.hasOwn(MARKER_KINDS, kind)) throw new RangeError('Tipo de marcador desconhecido.');
  if (!Number.isFinite(time) || time < 0) throw new RangeError('O marcador precisa de um tempo válido.');
  const finish = Number.isFinite(end) && end > time ? end : null;
  return { id: createId('mk'), kind, time, end: finish, label: text(label, 80) || MARKER_KINDS[kind], text: text(body, 2000) };
}

export function normalizeMarker(raw, duration = Infinity) {
  if (!isObject(raw) || !Object.hasOwn(MARKER_KINDS, raw.kind) || !Number.isFinite(raw.time) || raw.time < 0) return null;
  if (raw.time > duration + 1e-6) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : createId('mk'),
    kind: raw.kind,
    time: raw.time,
    end: Number.isFinite(raw.end) && raw.end > raw.time ? Math.min(raw.end, duration) : null,
    label: text(raw.label, 80) || MARKER_KINDS[raw.kind],
    text: text(raw.text, 2000),
  };
}

export function upsertMarker(markers, marker) {
  const list = markers.filter(item => item.id !== marker.id);
  if (list.length >= MAX_MARKERS) throw new RangeError(`Limite de ${MAX_MARKERS} marcadores por item.`);
  return [...list, marker].sort((a, b) => a.time - b.time);
}

export function removeMarker(markers, id) {
  return markers.filter(item => item.id !== id);
}

// Uma seção vai do seu marcador até o próximo marcador de seção (ou o fim).
export function sectionList(markers, duration) {
  const sections = markers.filter(item => item.kind === 'section').sort((a, b) => a.time - b.time);
  return sections.map((section, index) => ({
    ...section,
    end: section.end ?? (index + 1 < sections.length ? sections[index + 1].time : duration),
  }));
}

export function sectionAt(markers, duration, time) {
  return sectionList(markers, duration).find(section => time >= section.time && time < section.end) ?? null;
}

export function speedLadder(from, to, step) {
  if (![from, to, step].every(Number.isFinite) || from <= 0 || to <= 0 || step <= 0) {
    throw new RangeError('A escada de velocidade precisa de valores positivos.');
  }
  const direction = to >= from ? 1 : -1;
  const steps = [];
  for (let value = from; direction > 0 ? value < to - 1e-9 : value > to + 1e-9; value += direction * step) {
    steps.push(Math.round(value * 1000) / 1000);
    if (steps.length > 40) throw new RangeError('A escada de velocidade teria mais de 40 etapas; aumente o passo.');
  }
  steps.push(Math.round(to * 1000) / 1000);
  return steps;
}

export function createExercise(item, region, { name = '', objective = '', speedFrom = 0.7, speedTo = 1, speedStep = 0.05, loopsPerStep = 2, semitones = 0, cents = 0, algorithm = 'vocoder', notes = [] } = {}) {
  if (!isObject(item) || typeof item.id !== 'string') throw new TypeError('Escolha um item para extrair o exercício.');
  const bounds = normalizeRegion(region, item.duration);
  if (!bounds) throw new RangeError('Selecione um trecho A–B válido antes de criar o exercício.');
  if (!Number.isInteger(loopsPerStep) || loopsPerStep < 1 || loopsPerStep > 32) throw new RangeError('Repetições por etapa: de 1 a 32.');
  const ladder = speedLadder(speedFrom, speedTo, speedStep);
  if (ladder.some(speed => speed < 0.25 || speed > 1.5)) throw new RangeError('As velocidades devem ficar entre 25% e 150%.');
  return {
    id: createId('ex'),
    name: text(name, 120) || `${item.name} · ${formatTime(bounds.start)}–${formatTime(bounds.end)}`,
    objective: text(objective, 2000),
    itemId: item.id,
    itemName: item.name,
    start: bounds.start,
    end: bounds.end,
    speedFrom,
    speedTo,
    speedStep,
    loopsPerStep,
    semitones,
    cents,
    algorithm,
    notes: notes
      .filter(note => note.end > bounds.start && note.start < bounds.end)
      .map(note => ({ start: note.start, end: note.end, midi: note.midi, confidence: note.confidence })),
    createdAt: new Date().toISOString(),
    practice: { sessions: 0, bestSpeed: 0, lastPracticed: null },
  };
}

export function exerciseSchedule(exercise) {
  return speedLadder(exercise.speedFrom, exercise.speedTo, exercise.speedStep).map(speed => ({ speed, loops: exercise.loopsPerStep }));
}

export function recordPractice(exercise, reachedSpeed) {
  return {
    ...exercise,
    practice: {
      sessions: (exercise.practice?.sessions ?? 0) + 1,
      bestSpeed: Math.max(exercise.practice?.bestSpeed ?? 0, reachedSpeed),
      lastPracticed: new Date().toISOString(),
    },
  };
}

// Converte hipóteses de altura (segundos) do trecho em notas de sessão, ancoradas
// no pulso da grade de andamento mais próximo do início do trecho.
export function regionNotesToSessionPatch(notes, { start, end, bpm, beatOffset = 0, beatsPerBar = 4, minConfidence = 0.5, semitones = 0, idPrefix = 'rep' }) {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 400) throw new RangeError('Defina um andamento entre 20 e 400 BPM antes de extrair notas.');
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 16) throw new RangeError('Tempos por compasso: de 1 a 16.');
  const period = 60 / bpm;
  const anchor = beatOffset + Math.round((start - beatOffset) / period) * period;
  const secondsPerTick = period / TICKS_PER_QUARTER;
  const warnings = [];
  const accepted = notes
    .filter(note => note.end > start && note.start < end && note.confidence >= minConfidence)
    .map(note => ({
      start: Math.round((Math.max(note.start, start) - anchor) / secondsPerTick),
      end: Math.round((Math.min(note.end, end) - anchor) / secondsPerTick),
      pitch: clamp(note.midi + semitones, 0, 127),
      velocity: Math.round((0.5 + 0.4 * note.confidence) * 1000) / 1000,
    }))
    .filter(note => note.start >= 0 && note.end > note.start)
    .sort((a, b) => a.start - b.start);
  const monophonic = [];
  for (const note of accepted) {
    const previous = monophonic[monophonic.length - 1];
    if (previous && note.start < previous.end) {
      if (note.start <= previous.start) continue;
      previous.end = note.start;
    }
    monophonic.push({ ...note });
  }
  const skipped = notes.filter(note => note.end > start && note.start < end).length - monophonic.length;
  if (skipped > 0) warnings.push(`${skipped} hipótese(s) foram descartadas (baixa confiança, sobreposição ou fora da grade).`);
  if (!monophonic.length) throw new RangeError('Nenhuma hipótese de altura confiável neste trecho; reduza a confiança mínima ou escolha outro trecho.');
  const ticksPerBar = beatsPerBar * TICKS_PER_QUARTER;
  const lastEnd = monophonic.reduce((max, note) => Math.max(max, note.end), 0);
  return {
    patch: {
      bpm: Math.round(bpm),
      meter: { beats: beatsPerBar, unit: 4 },
      bars: Math.max(1, Math.ceil(lastEnd / ticksPerBar)),
      notes: monophonic.map((note, index) => ({ id: `${idPrefix}-${index + 1}`, start: note.start, duration: note.end - note.start, pitch: note.pitch, velocity: note.velocity })),
    },
    warnings,
  };
}

export function createSetlist(name) {
  const title = text(name, 120).trim();
  if (!title) throw new RangeError('Dê um nome à setlist.');
  return { id: createId('set'), name: title, entries: [], createdAt: new Date().toISOString() };
}

export function addSetlistEntry(setlist, entry) {
  if (!isObject(entry) || !['item', 'exercise'].includes(entry.kind) || typeof entry.id !== 'string') throw new TypeError('Entrada de setlist inválida.');
  if (setlist.entries.length >= 200) throw new RangeError('A setlist já tem 200 entradas.');
  return { ...setlist, entries: [...setlist.entries, { kind: entry.kind, id: entry.id, key: createId('se') }] };
}

export function moveSetlistEntry(setlist, index, delta) {
  const target = index + delta;
  if (index < 0 || index >= setlist.entries.length || target < 0 || target >= setlist.entries.length) return setlist;
  const entries = setlist.entries.slice();
  const [entry] = entries.splice(index, 1);
  entries.splice(target, 0, entry);
  return { ...setlist, entries };
}

export function removeSetlistEntry(setlist, index) {
  return { ...setlist, entries: setlist.entries.filter((_, position) => position !== index) };
}

export function pruneSetlist(setlist, { items, exercises }) {
  const itemIds = new Set(items.map(item => item.id));
  const exerciseIds = new Set(exercises.map(exercise => exercise.id));
  const entries = setlist.entries.filter(entry => (entry.kind === 'item' ? itemIds : exerciseIds).has(entry.id));
  return entries.length === setlist.entries.length ? setlist : { ...setlist, entries };
}

// Emparelha ataques de B com ataques de A (ordem temporal, janela de tolerância).
export function compareOnsets(a, b, { tolerance = 0.1, offset = 0 } = {}) {
  const left = a.map(value => (typeof value === 'number' ? value : value.time)).sort((x, y) => x - y);
  const right = b.map(value => (typeof value === 'number' ? value : value.time) - offset).sort((x, y) => x - y);
  const pairs = [];
  let j = 0;
  const used = new Set();
  for (const time of left) {
    while (j < right.length && right[j] < time - tolerance) j++;
    let best = -1;
    for (let k = j; k < right.length && right[k] <= time + tolerance; k++) {
      if (used.has(k)) continue;
      if (best < 0 || Math.abs(right[k] - time) < Math.abs(right[best] - time)) best = k;
    }
    if (best >= 0) {
      used.add(best);
      pairs.push({ a: time, b: right[best], delta: right[best] - time });
    }
  }
  const deltas = pairs.map(pair => pair.delta);
  const meanOffset = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0;
  const meanAbsolute = deltas.length ? deltas.reduce((sum, value) => sum + Math.abs(value), 0) / deltas.length : 0;
  return {
    pairs,
    matched: pairs.length,
    missing: left.length - pairs.length,
    extra: right.length - pairs.length,
    meanOffset,
    meanAbsolute,
  };
}

// Mediana dos intervalos dos últimos toques; ignora pausas longas (> 2 s).
export function tapTempo(taps) {
  const recent = taps.slice(-9);
  const intervals = [];
  for (let i = 1; i < recent.length; i++) {
    const interval = (recent[i] - recent[i - 1]) / 1000;
    if (interval > 0.15 && interval < 2) intervals.push(interval);
  }
  if (intervals.length < 2) return null;
  intervals.sort((a, b) => a - b);
  return Math.round(600 / intervals[Math.floor(intervals.length / 2)]) / 10;
}

export function beatGrid(tempo, from, to, limit = 4000) {
  if (!isObject(tempo) || !(tempo.bpm > 0)) return [];
  const period = 60 / tempo.bpm;
  const beats = [];
  const first = Math.ceil((from - tempo.offset) / period);
  for (let index = first; ; index++) {
    const time = tempo.offset + index * period;
    if (time > to || beats.length >= limit) break;
    if (time >= from) beats.push({ time, downbeat: ((index % tempo.beatsPerBar) + tempo.beatsPerBar) % tempo.beatsPerBar === 0, bar: Math.floor(index / tempo.beatsPerBar) + 1 });
  }
  return beats;
}

function normalizeProcessing(raw) {
  const value = isObject(raw) ? raw : {};
  return {
    speed: clamp(finite(value.speed, 1), 0.25, 1.5),
    semitones: clamp(Math.round(finite(value.semitones, 0)), -12, 12),
    cents: clamp(Math.round(finite(value.cents, 0)), -50, 50),
    algorithm: value.algorithm === 'wsola' ? 'wsola' : 'vocoder',
  };
}

function normalizeTempo(raw) {
  if (!isObject(raw) || !(raw.bpm >= 20 && raw.bpm <= 400)) return null;
  return {
    bpm: raw.bpm,
    offset: finite(raw.offset, 0),
    beatsPerBar: Number.isInteger(raw.beatsPerBar) && raw.beatsPerBar >= 1 && raw.beatsPerBar <= 16 ? raw.beatsPerBar : 4,
    source: ['analysis', 'manual', 'tap'].includes(raw.source) ? raw.source : 'manual',
  };
}

function normalizeChords(raw, duration) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(chord => isObject(chord) && Number.isFinite(chord.start) && Number.isFinite(chord.end) && chord.end > chord.start && chord.start <= duration)
    .slice(0, 5000)
    .map(chord => ({
      start: chord.start,
      end: chord.end,
      label: text(chord.label, 24) || 'N',
      confidence: clamp(finite(chord.confidence, 0), 0, 1),
      alternatives: Array.isArray(chord.alternatives)
        ? chord.alternatives.filter(isObject).slice(0, 6).map(alt => ({ label: text(alt.label, 24), probability: clamp(finite(alt.probability, 0), 0, 1) }))
        : [],
      edited: chord.edited === true,
    }));
}

export function createItem({ kind = 'reference', source = 'import', name, duration, sampleRate, channels, media = null, ...rest }) {
  return normalizeItem({
    id: createId('it'),
    kind,
    source,
    name,
    duration,
    sampleRate,
    channels,
    media,
    createdAt: new Date().toISOString(),
    ...rest,
  });
}

// Validação de registros persistidos/importados: devolve null para registros
// irrecuperáveis (a visão os lista como danificados em vez de descartá-los).
export function normalizeItem(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  if (!ITEM_KINDS.includes(raw.kind) || !Object.hasOwn(ITEM_SOURCES, raw.source)) return null;
  if (!Number.isFinite(raw.duration) || raw.duration <= 0 || raw.duration > 6 * 3600) return null;
  const duration = raw.duration;
  const media = isObject(raw.media) && typeof raw.media.id === 'string'
    ? { id: raw.media.id, mimeType: text(raw.media.mimeType, 100), size: finite(raw.media.size, 0), fileName: text(raw.media.fileName, 200) }
    : null;
  const item = {
    id: raw.id,
    kind: raw.kind,
    source: raw.source,
    name: text(raw.name, 200) || 'Sem nome',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    duration,
    sampleRate: Number.isFinite(raw.sampleRate) && raw.sampleRate > 0 ? raw.sampleRate : 0,
    channels: Number.isInteger(raw.channels) && raw.channels > 0 ? raw.channels : 0,
    media,
    region: normalizeRegion(raw.region, duration),
    loop: raw.loop !== false,
    processing: normalizeProcessing(raw.processing),
    markers: Array.isArray(raw.markers) ? raw.markers.map(marker => normalizeMarker(marker, duration)).filter(Boolean).slice(0, MAX_MARKERS) : [],
    tempo: normalizeTempo(raw.tempo),
    chords: normalizeChords(raw.chords, duration),
    note: text(raw.note, 4000),
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
  };
  if (Array.isArray(raw.attempts)) {
    item.attempts = raw.attempts
      .filter(attempt => isObject(attempt) && Number.isFinite(attempt.start))
      .slice(0, 10000)
      .map(attempt => ({ start: attempt.start, end: Number.isFinite(attempt.end) ? attempt.end : null, ...(Number.isFinite(attempt.pitch) ? { pitch: attempt.pitch } : {}) }));
  }
  if (isObject(raw.session)) item.session = raw.session;
  if (isObject(raw.summary)) item.summary = raw.summary;
  if (typeof raw.renderError === 'string') item.renderError = raw.renderError.slice(0, 500);
  return item;
}

export function normalizeExercise(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.itemId !== 'string') return null;
  if (!Number.isFinite(raw.start) || !Number.isFinite(raw.end) || raw.end - raw.start < MIN_REGION_SECONDS) return null;
  try {
    speedLadder(raw.speedFrom, raw.speedTo, raw.speedStep);
  } catch {
    return null;
  }
  const processing = normalizeProcessing(raw);
  return {
    id: raw.id,
    name: text(raw.name, 120) || 'Exercício',
    objective: text(raw.objective, 2000),
    itemId: raw.itemId,
    itemName: text(raw.itemName, 200),
    start: raw.start,
    end: raw.end,
    speedFrom: raw.speedFrom,
    speedTo: raw.speedTo,
    speedStep: raw.speedStep,
    loopsPerStep: Number.isInteger(raw.loopsPerStep) ? clamp(raw.loopsPerStep, 1, 32) : 2,
    semitones: processing.semitones,
    cents: processing.cents,
    algorithm: processing.algorithm,
    notes: Array.isArray(raw.notes) ? raw.notes.filter(note => isObject(note) && Number.isFinite(note.start) && Number.isFinite(note.end) && Number.isFinite(note.midi)).slice(0, 5000) : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    practice: {
      sessions: Number.isInteger(raw.practice?.sessions) ? raw.practice.sessions : 0,
      bestSpeed: finite(raw.practice?.bestSpeed, 0),
      lastPracticed: typeof raw.practice?.lastPracticed === 'string' ? raw.practice.lastPracticed : null,
    },
  };
}

export function normalizeSetlist(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !Array.isArray(raw.entries)) return null;
  return {
    id: raw.id,
    name: text(raw.name, 120) || 'Setlist',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    entries: raw.entries
      .filter(entry => isObject(entry) && ['item', 'exercise'].includes(entry.kind) && typeof entry.id === 'string')
      .slice(0, 200)
      .map(entry => ({ kind: entry.kind, id: entry.id, key: typeof entry.key === 'string' ? entry.key : createId('se') })),
  };
}

export function itemLabel(item) {
  return `${ITEM_SOURCES[item.source] ?? 'Item'} · ${formatTime(item.duration, { precise: false })}`;
}
