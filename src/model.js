// Modelo de frase monofônica em qualquer fórmula de compasso.
// Coordenada: 4 ticks = semínima (ticksPerBar = beats * 16 / unit); ticks
// podem ser fracionários para quiálteras. Notas:
// {id, start, duration, pitch (MIDI), velocity (0..1), articulation, offsetMs, string?}
// em intervalo semiaberto [start, start+duration). Adjacência é permitida;
// sobreposição é proibida (a execução por teclado/toque é monofônica).
// offsetMs é microtempo expressivo (antecipa/atrasa a nota sem mudar a grade).
// O "span" das funções é uma sessão (ou {bars, meter}); um número de
// compassos é aceito como atalho legado em 4/4.
// Todas as operacoes de edicao sao imutaveis: em caso de rejeicao retornam o
// MESMO array recebido (mesma referencia); em caso de sucesso retornam um novo
// array (e, quando aplicavel, um novo objeto de nota), nunca mutando a entrada.

import { EPSILON, ticksPerBar, roundTick } from './meter.js';

export const TICKS_PER_BAR = 16; // 4/4, usado apenas pelo atalho legado numérico
export const MIN_BARS = 1;
// Teto de compassos da sessão (v5). 128 compassos cobrem as operações por
// compasso, a partitura em 32 sistemas de 4 e a linha do tempo com rolagem; o
// formato antigo continua idêntico (nenhum documento salvo passa de 16) e o
// limite v5 anterior (64) continua aceito e legível.
export const MAX_BARS = 128;
export const DEFAULT_BARS = 1;
export const MIN_DURATION = 0.05;
export const OFFSET_LIMIT_MS = 80;
export const ARTICULATIONS = Object.freeze(['normal', 'accent', 'ghost', 'staccato', 'tenuto', 'legato']);
export const NOTE_DEFAULTS = Object.freeze({ pitch: 69, velocity: 0.8, articulation: 'normal', offsetMs: 0 });
export const NOTE_KEYS = Object.freeze(['id', 'start', 'duration', 'pitch', 'velocity', 'articulation', 'offsetMs', 'string']);

const FIELD_VALIDATORS = {
  pitch: value => Number.isInteger(value) && value >= 0 && value <= 127,
  velocity: value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
  articulation: value => ARTICULATIONS.includes(value),
  offsetMs: value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= OFFSET_LIMIT_MS,
  string: value => Number.isInteger(value) && value >= 1 && value <= 6,
};

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isValidBars(bars) {
  return Number.isInteger(bars) && bars >= MIN_BARS && bars <= MAX_BARS;
}

// Total de ticks do span, ou NaN quando o span é inválido.
export function spanTicks(span) {
  if (typeof span === 'number') return isValidBars(span) ? span * TICKS_PER_BAR : NaN;
  if (span === null || typeof span !== 'object' || !isValidBars(span.bars)) return NaN;
  const meter = span.meter ?? { beats: 4, unit: 4 };
  if (!meter || !Number.isInteger(meter.beats) || meter.beats < 1 || meter.beats > 16
    || ![2, 4, 8, 16].includes(meter.unit)) return NaN;
  const ticks = span.bars * ticksPerBar(meter);
  return Number.isFinite(ticks) && ticks > 0 ? ticks : NaN;
}

function noteEnd(note) {
  return note.start + note.duration;
}

function overlaps(a, b) {
  // Semiabertos: tocar nas bordas (adjacencia) nao conta como sobreposicao.
  return a.start < noteEnd(b) - EPSILON && b.start < noteEnd(a) - EPSILON;
}

export function isValidNote(note, limit) {
  if (!isFiniteNumber(limit) || limit <= 0) return false;
  if (note === null || typeof note !== 'object' || Array.isArray(note)) return false;
  if (typeof note.id !== 'string' || note.id.length === 0 || note.id.length > 64) return false;
  if (!isFiniteNumber(note.start) || note.start < 0) return false;
  if (!isFiniteNumber(note.duration) || note.duration < MIN_DURATION - EPSILON) return false;
  if (noteEnd(note) > limit + EPSILON) return false;
  for (const [field, validate] of Object.entries(FIELD_VALIDATORS)) {
    if (Object.hasOwn(note, field) && !validate(note[field])) return false;
  }
  return true;
}

export function validPhrase(notes, span = DEFAULT_BARS) {
  const limit = spanTicks(span);
  if (!Array.isArray(notes) || !Number.isFinite(limit)) return false;
  const ids = new Set();
  for (const note of notes) {
    if (!isValidNote(note, limit)) return false;
    if (ids.has(note.id)) return false;
    ids.add(note.id);
  }
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    if (overlaps(sorted[i - 1], sorted[i])) return false;
  }
  return true;
}

// Nota canônica com todos os campos; campos ausentes recebem os padrões.
export function completeNote(note) {
  return {
    id: note.id,
    start: roundTick(note.start),
    duration: roundTick(note.duration),
    pitch: note.pitch ?? NOTE_DEFAULTS.pitch,
    velocity: note.velocity ?? NOTE_DEFAULTS.velocity,
    articulation: note.articulation ?? NOTE_DEFAULTS.articulation,
    offsetMs: note.offsetMs ?? NOTE_DEFAULTS.offsetMs,
    ...(Object.hasOwn(note, 'string') ? { string: note.string } : {}),
  };
}

let idCounter = 0;

export function generateId() {
  idCounter += 1;
  return `n${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function fitsWith(notes, candidate, limit, ignoreId = null) {
  if (!isValidNote(candidate, limit)) return false;
  return !notes.some(n => n.id !== ignoreId && overlaps(n, candidate));
}

export function addNote(notes, start, duration = 1, span = DEFAULT_BARS, fields = {}) {
  const limit = spanTicks(span);
  if (!validPhrase(notes, span) || !Number.isFinite(limit)) return notes;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)
    || Object.keys(fields).some(key => !Object.hasOwn(FIELD_VALIDATORS, key))) return notes;
  const raw = { ...pickFields(fields), id: generateId(), start, duration };
  if (!isValidNote(raw, limit)) return notes;
  const candidate = completeNote(raw);
  if (!fitsWith(notes, candidate, limit)) return notes;
  return [...notes, candidate];
}

export function moveNote(notes, id, start, span = DEFAULT_BARS) {
  return updateNote(notes, id, { start }, span);
}

export function resizeNote(notes, id, duration, span = DEFAULT_BARS) {
  return updateNote(notes, id, { duration }, span);
}

// patch pode conter start, duration, pitch, velocity, articulation, offsetMs, string.
export function updateNote(notes, id, patch, span = DEFAULT_BARS) {
  const limit = spanTicks(span);
  if (!validPhrase(notes, span) || !Number.isFinite(limit)) return notes;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return notes;
  if (Object.keys(patch).some(key => key === 'id' || !NOTE_KEYS.includes(key))) return notes;
  const existing = notes.find(n => n.id === id);
  if (!existing) return notes;
  for (const key of ['start', 'duration']) {
    if (Object.hasOwn(patch, key) && !isFiniteNumber(patch[key])) return notes;
  }
  const candidate = { ...existing, ...patch };
  if (!isValidNote(candidate, limit)) return notes;
  for (const key of ['start', 'duration']) candidate[key] = roundTick(candidate[key]);
  if (!fitsWith(notes, candidate, limit, id)) return notes;
  return notes.map(n => (n.id === id ? candidate : n));
}

export function deleteNote(notes, id) {
  if (!Array.isArray(notes)) return notes;
  if (!notes.some(n => n.id === id)) return notes;
  return notes.filter(n => n.id !== id);
}

function pickFields(fields) {
  const picked = {};
  for (const key of Object.keys(FIELD_VALIDATORS)) {
    if (Object.hasOwn(fields, key)) picked[key] = fields[key];
  }
  return picked;
}
