// Modelo de frase ritmica quantizada (4/4, TICKS_PER_BAR semicolcheias por compasso).
// Frases tem 1, 2 ou 4 compassos (BAR_OPTIONS): total de ticks = bars * TICKS_PER_BAR.
// Notas: {id: string, start: integer, duration: integer}, intervalo semiaberto
// [start, start+duration). Adjacencia (fim de uma == inicio da outra) e permitida
// pois intervalos semiabertos nao se tocam logicamente. Sobreposicao e proibida.
// Todas as operacoes de edicao sao imutaveis: em caso de rejeicao retornam o
// MESMO array recebido (mesma referencia); em caso de sucesso retornam um novo
// array (e, quando aplicavel, um novo objeto de nota), nunca mutando a entrada.

export const TICKS_PER_BAR = 16;
export const BAR_OPTIONS = [1, 2, 4];
export const DEFAULT_BARS = 1;

const STORAGE_KEY = 'groovegoblin.v1';
const BPM_MIN = 40;
const BPM_MAX = 240;
const DEFAULT_BPM = 100;

function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function isValidBars(bars) {
  return BAR_OPTIONS.includes(bars);
}

function totalTicks(bars) {
  return TICKS_PER_BAR * bars;
}

function noteEnd(note) {
  return note.start + note.duration;
}

function overlaps(a, b) {
  // Semiabertos: tocar nas bordas (adjacencia) nao conta como sobreposicao.
  return a.start < noteEnd(b) && b.start < noteEnd(a);
}

function isValidNoteShape(note, limit) {
  return (
    note !== null &&
    typeof note === 'object' &&
    typeof note.id === 'string' &&
    note.id.length > 0 &&
    isInt(note.start) &&
    note.start >= 0 &&
    isInt(note.duration) &&
    note.duration >= 1 &&
    noteEnd(note) <= limit
  );
}

export function validPhrase(notes, bars = DEFAULT_BARS) {
  if (!Array.isArray(notes) || !isValidBars(bars)) return false;
  const limit = totalTicks(bars);
  const ids = new Set();
  for (const note of notes) {
    if (!isValidNoteShape(note, limit)) return false;
    if (ids.has(note.id)) return false;
    ids.add(note.id);
  }
  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      if (overlaps(notes[i], notes[j])) return false;
    }
  }
  return true;
}

let idCounter = 0;

function generateId() {
  idCounter += 1;
  return `n${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function addNote(notes, start, duration = 1, bars = DEFAULT_BARS) {
  if (!Array.isArray(notes) || !isValidBars(bars)) return notes;
  if (!isInt(start) || start < 0) return notes;
  if (!isInt(duration) || duration < 1) return notes;
  const candidate = { id: generateId(), start, duration };
  if (noteEnd(candidate) > totalTicks(bars)) return notes;
  if (notes.some((n) => overlaps(n, candidate))) return notes;
  return [...notes, candidate];
}

export function moveNote(notes, id, start, bars = DEFAULT_BARS) {
  if (!Array.isArray(notes) || !isValidBars(bars)) return notes;
  const existing = notes.find((n) => n.id === id);
  if (!existing) return notes;
  if (!isInt(start) || start < 0) return notes;
  const candidate = { id, start, duration: existing.duration };
  if (noteEnd(candidate) > totalTicks(bars)) return notes;
  if (notes.some((n) => n.id !== id && overlaps(n, candidate))) return notes;
  return notes.map((n) => (n.id === id ? candidate : n));
}

export function resizeNote(notes, id, duration, bars = DEFAULT_BARS) {
  if (!Array.isArray(notes) || !isValidBars(bars)) return notes;
  const existing = notes.find((n) => n.id === id);
  if (!existing) return notes;
  if (!isInt(duration) || duration < 1) return notes;
  const candidate = { id, start: existing.start, duration };
  if (noteEnd(candidate) > totalTicks(bars)) return notes;
  if (notes.some((n) => n.id !== id && overlaps(n, candidate))) return notes;
  return notes.map((n) => (n.id === id ? candidate : n));
}

export function deleteNote(notes, id) {
  if (!Array.isArray(notes)) return notes;
  if (!notes.some((n) => n.id === id)) return notes;
  return notes.filter((n) => n.id !== id);
}

function isValidBpm(bpm) {
  return isInt(bpm) && bpm >= BPM_MIN && bpm <= BPM_MAX;
}

export function loadState(storage) {
  let raw;
  try {
    storage ??= globalThis.localStorage;
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return {
      notes: [],
      bpm: DEFAULT_BPM,
      bars: DEFAULT_BARS,
      warning: 'Nao foi possivel acessar o armazenamento local; usando padroes.',
    };
  }

  if (raw == null) {
    return { notes: [], bpm: DEFAULT_BPM, bars: DEFAULT_BARS, warning: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { notes: [], bpm: DEFAULT_BPM, bars: DEFAULT_BARS, warning: 'Dados salvos corrompidos; usando padroes.' };
  }

  const warnings = [];

  // Estados salvos antes do suporte a multiplos compassos nao trazem "bars":
  // frases de um compasso continuam validas, então o padrao e retrocompativel.
  const bars = isValidBars(parsed.bars) ? parsed.bars : DEFAULT_BARS;

  let notes = [];
  if (validPhrase(parsed.notes, bars)) {
    notes = parsed.notes;
  } else {
    warnings.push('Frase salva invalida; usando frase vazia.');
  }

  let bpm = DEFAULT_BPM;
  if (isValidBpm(parsed.bpm)) {
    bpm = parsed.bpm;
  } else {
    warnings.push('BPM salvo invalido; usando 100.');
  }

  return { notes, bpm, bars, warning: warnings.length > 0 ? warnings.join(' ') : null };
}

export function saveState(notes, bpm, bars, storage) {
  if (!validPhrase(notes, bars) || !isValidBpm(bpm)) return false;
  try {
    storage ??= globalThis.localStorage;
    storage.setItem(STORAGE_KEY, JSON.stringify({ notes, bpm, bars }));
    return true;
  } catch {
    return false;
  }
}
