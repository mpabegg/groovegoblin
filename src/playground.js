// Playground do GrooveGoblin: atividades musicais reais — dueto chamado e
// resposta com o duende, masmorra do clique sumido, chefe devorador de espaço,
// erros férteis, alquimia de motivos, passagens (sala do silêncio, espelho
// reverso, portal polirrítmico) e coral dos objetos. Nada de microfone: sons
// vêm de notas geradas/transformadas tocadas pelo host (play/stop/preview).
// Sem surpresas sonoras: todo som começa de um botão explícito, em volume
// moderado configurável. Sementes determinísticas em todos os geradores.

import {
  clamp,
  numOr,
  mulberry32,
  normalizeSeed,
  createEl,
  safeStorage,
  normalizeSession,
  tickSeconds,
  previewPhrase,
  renderTickGrid,
  renderKeepingFocus,
  formatDatePt,
  runId,
} from './practice.js';
import { generateGroove } from './generator.js';
import { patchSession, serializeSession } from './session.js';
import { createEarGames } from './ear-games.js';

// ---------------------------------------------------------------------------
// Estado persistido (chave própria e versionada)
// ---------------------------------------------------------------------------

export const PLAYGROUND_STORAGE_KEY = 'groovegoblin.playground.v1';
export const CAPTURE_LIMIT = 60;

export const CAPTURE_KINDS = Object.freeze([
  'goblin-response',
  'dungeon',
  'boss',
  'silence',
  'engine-attempt',
  'choir',
]);

export function createPlaygroundState() {
  return {
    version: 1,
    effects: { volume: 0.6 },
    captures: [],
    eggs: { portal: false, mirror: false, silence: false },
    cultivatedCount: 0,
  };
}

function validateNotes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(note => note && typeof note === 'object' && Number.isFinite(note.start) && note.start >= 0 && Number.isFinite(note.duration) && note.duration > 0)
    .map((note, index) => ({
      id: typeof note.id === 'string' && note.id ? note.id.slice(0, 80) : `note-${index}`,
      start: note.start,
      duration: Math.max(0.25, note.duration),
      pitch: Number.isFinite(note.pitch) ? Math.round(clamp(note.pitch, 21, 108)) : 69,
      velocity: clamp(numOr(note.velocity, 0.8), 0.05, 1),
    }));
}

function validateAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(attempt => attempt && typeof attempt === 'object' && Number.isFinite(attempt.start) && attempt.start >= 0)
    .map(attempt => ({ start: attempt.start, end: Number.isFinite(attempt.end) && attempt.end >= attempt.start ? attempt.end : null, pitch: Number.isInteger(attempt.pitch) ? clamp(attempt.pitch, 0, 127) : 69 }));
}

export function validateCapture(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, error: 'captura não é um objeto' };
  if (typeof entry.id !== 'string' || !entry.id || entry.id.length > 100) return { ok: false, error: 'id ausente ou inválido' };
  const at = typeof entry.at === 'string' ? Date.parse(entry.at) : Number.isFinite(entry.at) ? entry.at : NaN;
  if (!Number.isFinite(at) || Math.abs(at) > 8640000000000000) return { ok: false, error: 'data ausente ou inválida' };
  if (!CAPTURE_KINDS.includes(entry.kind)) return { ok: false, error: 'tipo de captura inválido' };
  if (typeof entry.label !== 'string' || !entry.label || entry.label.length > 120) return { ok: false, error: 'rótulo ausente' };
  const bpm = numOr(entry.bpm, NaN);
  if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300) return { ok: false, error: 'bpm fora do intervalo 30–300' };
  const notes = validateNotes(entry.notes);
  if (entry.kind === 'goblin-response' || entry.kind === 'dungeon' || entry.kind === 'boss' || entry.kind === 'choir') {
    if (notes.length === 0) return { ok: false, error: 'captura sem notas' };
  }
  const attempts = validateAttempts(entry.attempts);
  if (entry.kind === 'engine-attempt' && attempts.length === 0) return { ok: false, error: 'tentativa do treino sem toques' };
  return {
    ok: true,
    value: {
      id: entry.id,
      at: new Date(at).toISOString(),
      kind: entry.kind,
      label: entry.label,
      notes,
      attempts,
      bpm: Math.round(bpm),
      bars: Number.isInteger(entry.bars) && entry.bars > 0 && entry.bars <= 16 ? entry.bars : 1,
      meter: normalizeSession(entry).meter,
    },
  };
}

export function validatePlaygroundState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'estado não é um objeto' };
  if (value.version !== 1) return { ok: false, error: `versão não suportada: ${String(value.version)}` };
  if (value.captures !== undefined && !Array.isArray(value.captures)) return { ok: false, error: 'capturas não são uma lista' };
  const warnings = [];
  const captures = [];
  if (Array.isArray(value.captures)) {
    for (const entry of value.captures) {
      const validated = validateCapture(entry);
      if (validated.ok) captures.push(validated.value);
      else warnings.push(`Captura ignorada: ${validated.error}.`);
    }
  }
  const eggs = { portal: false, mirror: false, silence: false };
  if (value.eggs && typeof value.eggs === 'object' && !Array.isArray(value.eggs)) {
    for (const key of Object.keys(eggs)) eggs[key] = value.eggs[key] === true;
  }
  return {
    ok: true,
    state: {
      version: 1,
      effects: { volume: clamp(numOr(value?.effects?.volume, 0.6), 0.05, 1) },
      captures: captures.slice(-CAPTURE_LIMIT),
      eggs,
      cultivatedCount: Math.max(0, Math.round(numOr(value.cultivatedCount, 0))),
    },
    warnings,
  };
}

export function loadPlaygroundState(storage = safeStorage()) {
  const warnings = [];
  if (storage.volatile) warnings.push('Armazenamento persistente indisponível: exporte as frases antes de fechar esta página.');
  let recoveryRaw = null;
  let raw = null;
  try {
    raw = storage.getItem(PLAYGROUND_STORAGE_KEY);
    recoveryRaw = storage.getItem(`${PLAYGROUND_STORAGE_KEY}.recovery`);
    if (recoveryRaw !== null) warnings.push('Os dados antigos estão preservados na cópia de recuperação.');
  } catch (error) {
    warnings.push(`Não foi possível ler o armazenamento do playground (${error.message}).`);
    return { state: createPlaygroundState(), warnings, recoveryRaw: null };
  }
  if (raw === null || raw === undefined) return { state: createPlaygroundState(), warnings, recoveryRaw: null };
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnings.push(`Dados do playground corrompidos (${error.message}); começando do zero sem apagar os dados antigos.`);
    return { state: createPlaygroundState(), warnings, recoveryRaw: raw };
  }
  const validated = validatePlaygroundState(parsed);
  if (!validated.ok) {
    warnings.push(`Dados do playground inválidos (${validated.error}); começando do zero sem apagar os dados antigos.`);
    return { state: createPlaygroundState(), warnings, recoveryRaw: raw };
  }
  return { state: validated.state, warnings: [...warnings, ...validated.warnings], recoveryRaw };
}

export function savePlaygroundState(state, storage = safeStorage()) {
  try {
    const existing = storage.getItem(PLAYGROUND_STORAGE_KEY);
    if (existing !== null) {
      let valid = false;
      try { const checked = validatePlaygroundState(JSON.parse(existing)); valid = checked.ok && checked.warnings.length === 0; } catch { /* preserve corrupt bytes */ }
      const backup = storage.getItem(`${PLAYGROUND_STORAGE_KEY}.recovery`);
      if (!valid && backup !== null && backup !== existing) return false;
      if (!valid && storage.getItem(`${PLAYGROUND_STORAGE_KEY}.recovery`) === null) storage.setItem(`${PLAYGROUND_STORAGE_KEY}.recovery`, existing);
    }
    storage.setItem(PLAYGROUND_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function recordCapture(state, capture) {
  const validated = validateCapture(capture);
  if (!validated.ok) return { recorded: false, error: validated.error };
  const entry = validated.value;
  if (state.captures.some(existing => existing.id === entry.id)) return { recorded: false, reason: 'duplicado' };
  state.captures.push(entry);
  if (state.captures.length > CAPTURE_LIMIT) state.captures.splice(0, state.captures.length - CAPTURE_LIMIT);
  return { recorded: true, entry };
}

export function deleteCapture(state, id) {
  const index = state.captures.findIndex(entry => entry.id === id);
  if (index === -1) return false;
  state.captures.splice(index, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Duende: chamado e resposta
// ---------------------------------------------------------------------------

const PENTATONIC_STEPS = [0, 2, 3, 5, 7, 10, 12];

export function goblinCall(options = {}) {
  const seed = normalizeSeed(options.seed, 1);
  const bars = [1, 2, 4].includes(options.bars) ? options.bars : 2;
  const density = ['sparse', 'medium', 'busy'].includes(options.density) ? options.density : 'medium';
  const syncopation = ['straight', 'mixed', 'syncopated'].includes(options.syncopation) ? options.syncopation : 'mixed';
  const lengths = ['short', 'mixed', 'long'].includes(options.lengths) ? options.lengths : 'mixed';
  const groove = generateGroove({ bars, seed, density, syncopation, lengths });
  const random = mulberry32(seed ^ 0x51ed270b);
  let pitch = 69;
  const notes = groove.notes.map((note, index) => {
    if (index > 0) {
      const step = PENTATONIC_STEPS[Math.floor(random() * PENTATONIC_STEPS.length)] - 3;
      pitch = clamp(pitch + step, 57, 81);
    }
    return { id: `goblin-${seed}-${index}`, start: note.start, duration: note.duration, pitch, velocity: 0.85 };
  });
  return { notes, bars, seed };
}

export function ticksFromResponse(responseTicks) {
  return [...(responseTicks instanceof Set ? responseTicks : new Set(responseTicks ?? []))]
    .filter(tick => Number.isFinite(tick) && tick >= 0)
    .sort((a, b) => a - b);
}

export function compareRhythms(referenceNotes, responseTicks, options = {}) {
  const ticksPerBar = numOr(options.ticksPerBar, 16);
  const bars = numOr(options.bars, 1);
  const total = Math.round(ticksPerBar * bars);
  const referenceOnsets = referenceNotes
    .map(note => Math.round(note.start))
    .filter(tick => tick >= 0 && tick < total)
    .sort((a, b) => a - b);
  const response = ticksFromResponse(responseTicks).filter(tick => tick < total);
  const expectedSet = new Set(referenceOnsets);
  const responseSet = new Set(response);
  const matched = response.filter(tick => expectedSet.has(tick));
  const missed = referenceOnsets.filter(tick => !responseSet.has(tick));
  const extra = response.filter(tick => !expectedSet.has(tick));
  const similarity = matched.length / Math.max(expectedSet.size, responseSet.size, 1);
  return { referenceOnsets, response, matched: matched.length, missed, extra, similarity };
}

// ---------------------------------------------------------------------------
// Masmorra do clique sumido
// ---------------------------------------------------------------------------

export function dungeonRooms(options = {}) {
  const seed = normalizeSeed(options.seed, 1);
  const rooms = clamp(Math.round(numOr(options.rooms, 5)), 1, 12);
  const random = mulberry32(seed ^ 0x7a1c3e5f);
  const list = [];
  for (let room = 1; room <= rooms; room += 1) {
    const roomSeed = (seed + room * 7919) % 0x100000000;
    const density = room <= 2 ? 'sparse' : room <= 4 ? 'medium' : 'busy';
    const groove = generateGroove({ bars: 1, seed: roomSeed, density, syncopation: 'mixed', lengths: 'short' });
    const notes = groove.notes.map((note, index) => ({
      id: `dungeon-${seed}-${room}-${index}`,
      start: note.start,
      duration: note.duration,
      pitch: 69,
      velocity: 0.85,
    }));
    const onsets = notes.map(note => Math.round(note.start));
    const hiddenCount = Math.min(onsets.length, Math.min(3, 1 + Math.floor((room - 1) / 2)));
    const shuffled = [...onsets];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const hidden = shuffled.slice(0, hiddenCount).sort((a, b) => a - b);
    list.push({ room, seed: roomSeed, notes, onsets, hidden, bpm: 70 + (room - 1) * 8 });
  }
  return { seed, rooms: list, total: rooms };
}

export function dungeonCheck(room, selectedTicks) {
  const expected = new Set(room.hidden);
  const selected = new Set(ticksFromResponse(selectedTicks));
  const missed = [...expected].filter(tick => !selected.has(tick)).sort((a, b) => a - b);
  const extra = [...selected].filter(tick => !expected.has(tick)).sort((a, b) => a - b);
  return { correct: missed.length === 0 && extra.length === 0, missed, extra };
}

export function dungeonVanishedNotes(room) {
  const hiddenSet = new Set(room.hidden);
  return room.notes.filter(note => !hiddenSet.has(Math.round(note.start)));
}

// ---------------------------------------------------------------------------
// Chefe devorador de espaço
// ---------------------------------------------------------------------------

export function bossAttacks(notes, bars, options = {}) {
  const seed = normalizeSeed(options.seed, 1);
  const ticksPerBar = 16;
  const total = Math.round(numOr(bars, 1)) * ticksPerBar;
  const covered = new Set();
  for (const note of notes) {
    for (let tick = Math.floor(note.start); tick < note.start + note.duration && tick < total; tick += 1) covered.add(tick);
  }
  const gaps = [];
  for (let tick = 0; tick < total; tick += 1) if (!covered.has(tick)) gaps.push(tick);
  const random = mulberry32(seed ^ 0x2f9be3a1);
  // O chefe prefere contra-tempos: pesos maiores fora dos tempos fortes.
  const weighted = gaps.filter(tick => tick % 4 !== 0 || tick >= ticksPerBar);
  const straight = gaps.filter(tick => !weighted.includes(tick));
  const pool = [...weighted, ...straight];
  const count = Math.max(2, Math.min(pool.length, Math.round(pool.length * 0.5) + 1));
  const chosen = new Set();
  const candidates = [...pool];
  for (let i = 0; i < count && candidates.length > 0; i += 1) {
    const index = Math.floor(random() * candidates.length);
    chosen.add(candidates.splice(index, 1)[0]);
  }
  const bossNotes = [...chosen]
    .sort((a, b) => a - b)
    .map((tick, index) => ({ id: `boss-${seed}-${index}`, start: tick, duration: 1, pitch: 45, velocity: 0.95 }));
  return { notes: bossNotes, gaps, attacks: [...chosen].sort((a, b) => a - b), seed };
}

export function bossCheck(boss, selectedTicks) {
  const expected = new Set(boss.attacks);
  const selected = new Set(ticksFromResponse(selectedTicks));
  const missed = [...expected].filter(tick => !selected.has(tick)).sort((a, b) => a - b);
  const extra = [...selected].filter(tick => !expected.has(tick)).sort((a, b) => a - b);
  return { correct: missed.length === 0 && extra.length === 0, missed, extra };
}

// ---------------------------------------------------------------------------
// Erros férteis: tentativas viram frases
// ---------------------------------------------------------------------------

export function attemptsToPhrase(attempts, options = {}) {
  const bpm = clamp(Math.round(numOr(options.bpm, 100)), 30, 300);
  const quantize = options.quantize === 'preserve' ? 'preserve' : 'strict';
  const ticksPerBar = Math.round(numOr(options.ticksPerBar, 16));
  const bars = clamp(Math.round(numOr(options.bars, 2)), 1, 16);
  const total = ticksPerBar * bars;
  const secondsPerTick = tickSeconds(bpm);
  const list = validateAttempts(attempts).sort((a, b) => a.start - b.start);
  const adjusted = [];
  const notes = [];
  for (const attempt of list) {
    let startTick = attempt.start / secondsPerTick;
    const endTick = (attempt.end ?? attempt.start + 0.15) / secondsPerTick;
    if (quantize === 'strict') {
      const rounded = Math.round(startTick);
      if (Math.abs(rounded - startTick) > 0.25) adjusted.push({ from: Math.round(startTick * 100) / 100, to: rounded });
      startTick = rounded;
    }
    const duration = Math.min(Math.max(0.05, endTick - startTick), total - startTick);
    if (startTick < 0 || startTick >= total) continue;
    const previous = notes[notes.length - 1];
    if (previous && startTick - previous.start < 0.05) continue;
    if (previous) previous.duration = Math.min(previous.duration, startTick - previous.start);
    notes.push({ id: `fertile-${notes.length}`, start: startTick, duration, pitch: attempt.pitch, velocity: 0.8 });
  }
  return { notes, adjusted, quantize, bpm, bars };
}

// ---------------------------------------------------------------------------
// Alquimia de motivos
// ---------------------------------------------------------------------------

export const TRANSFORMS = Object.freeze([
  { id: 'scale-up', name: 'Escala rítmica ×2 (notas duas vezes mais longas)' },
  { id: 'scale-down', name: 'Escala rítmica ÷2 (notas pela metade)' },
  { id: 'accent-shift', name: 'Deslocar acentos (rotacionar intensidades)' },
  { id: 'retrograde', name: 'Retrógrado (espelho no tempo)' },
  { id: 'inversion', name: 'Inversão melódica (espelho em altura)' },
  { id: 'reharm', name: 'Rearmonização (encaixar nas notas dos acordes)' },
  { id: 'straighten', name: 'Endireitar (ataques nos tempos fortes)' },
  { id: 'swingify', name: 'Balançar (contratempos atrasados)' },
  { id: 'syncopate', name: 'Sincopar (ataques fora dos tempos)' },
]);

function mergeCollisions(notes) {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const note of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && note.start < previous.start + 0.5) {
      previous.duration = Math.max(previous.duration, note.start + note.duration - previous.start);
      continue;
    }
    merged.push({ ...note });
  }
  return merged;
}

export function transformPhrase(notes, kind, options = {}) {
  if (!Array.isArray(notes)) throw new TypeError('Informe as notas do motivo.');
  if (!TRANSFORMS.some(t => t.id === kind)) throw new TypeError(`Transformação desconhecida: ${kind}`);
  const ticksPerBar = Math.round(numOr(options.ticksPerBar, 16));
  const bars = clamp(Math.round(numOr(options.bars, 1)), 1, 16);
  const ticksPerBeat = Math.round(numOr(options.ticksPerBeat, 4));
  const total = ticksPerBar * bars;
  const source = validateNotes(notes);
  if (source.length === 0) return [];
  let transformed;

  switch (kind) {
    case 'scale-up': {
      const scaled = [];
      for (const note of source) {
        const start = note.start * 2;
        if (start >= total) continue;
        scaled.push({ ...note, start, duration: note.duration * 2 });
      }
      transformed = mergeCollisions(scaled).map(note => ({ ...note, duration: Math.min(note.duration, total - note.start) }));
      break;
    }
    case 'scale-down': {
      transformed = mergeCollisions(source.map(note => ({ ...note, start: note.start / 2, duration: Math.max(0.5, note.duration / 2) })));
      break;
    }
    case 'accent-shift': {
      const velocities = source.map(note => numOr(note.velocity, 0.8));
      const shifted = [...velocities.slice(1), velocities[0]];
      transformed = source.map((note, index) => ({ ...note, velocity: shifted[index] }));
      break;
    }
    case 'retrograde': {
      transformed = source
        .map(note => ({ ...note, start: total - (note.start + note.duration) }))
        .sort((a, b) => a.start - b.start);
      break;
    }
    case 'inversion': {
      const center = options.centerPitch !== undefined ? numOr(options.centerPitch, 69) : source.reduce((sum, note) => sum + note.pitch, 0) / source.length;
      transformed = source.map(note => ({ ...note, pitch: Math.round(clamp(2 * center - note.pitch, 21, 108)) }));
      break;
    }
    case 'reharm': {
      const chordTones = Array.isArray(options.chordTones) ? options.chordTones.filter(tone => Number.isFinite(tone)).map(tone => Math.round(tone)) : [];
      if (chordTones.length === 0) throw new TypeError('Rearmonização requer acordes na sessão (nenhuma nota de acorde disponível).');
      transformed = source.map(note => {
        let best = chordTones[0];
        let bestDistance = Infinity;
        for (const tone of chordTones) {
          for (const octave of [-12, 0, 12]) {
            const candidate = tone + octave;
            const distance = Math.abs(candidate - note.pitch);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = candidate;
            }
          }
        }
        return { ...note, pitch: clamp(best, 21, 108) };
      });
      break;
    }
    case 'straighten': {
      transformed = mergeCollisions(source.map(note => {
        const beat = Math.round(note.start / ticksPerBeat) * ticksPerBeat;
        return { ...note, start: clamp(beat, 0, total - 1) };
      }));
      break;
    }
    case 'swingify': {
      transformed = source.map(note => {
        const offbeat = Math.abs(note.start % ticksPerBeat - ticksPerBeat / 2) < 0.001;
        const shift = offbeat ? ticksPerBeat / 6 : 0;
        return { ...note, start: note.start + shift };
      });
      break;
    }
    case 'syncopate': {
      transformed = mergeCollisions(source.map((note, index) => {
        const onBeat = Math.abs(note.start % ticksPerBeat) < 0.001;
        if (!onBeat || Math.abs(note.start) < 0.001) return { ...note };
        const shift = index % 2 === 0 ? 2 : -1;
        return { ...note, start: Math.max(0, note.start + shift) };
      }));
      break;
    }
    default:
      transformed = source.map(note => ({ ...note }));
      break;
  }
  const result = transformed
    .filter(note => note.start >= 0 && note.start < total)
    .map((note, index) => ({ ...note, id: `alchemy-${kind}-${index}`, duration: Math.min(note.duration, total - note.start) }))
    .sort((a, b) => a.start - b.start);
  for (let index = 0; index + 1 < result.length; index += 1) {
    result[index].duration = Math.min(result[index].duration, result[index + 1].start - result[index].start);
  }
  return result.filter(note => note.duration >= 0.05);
}

// ---------------------------------------------------------------------------
// Passagens: portal polirrítmico
// ---------------------------------------------------------------------------

export function polyrhythmPattern(a, b, options = {}) {
  const first = clamp(Math.round(numOr(a, 3)), 2, 7);
  const second = clamp(Math.round(numOr(b, 2)), 2, 7);
  if (first === second) throw new TypeError('O portal precisa de dois pulsos diferentes.');
  const bars = clamp(Math.round(numOr(options.bars, 1)), 1, 4);
  const ticksPerBar = Math.round(numOr(options.ticksPerBar, 16));
  const notes = [];
  // Pulsos por compasso: a voz A dá `first` pulsos por compasso, a B dá
  // `second`; ticks fracionários permitem divisões exatas (3:2, 4:3, 5:4).
  const stepA = ticksPerBar / first;
  const stepB = ticksPerBar / second;
  for (let k = 0; k < first * bars; k += 1) {
    notes.push({ start: k * stepA, duration: 0.5, pitch: 72, velocity: 0.8 });
  }
  for (let k = 0; k < second * bars; k += 1) {
    notes.push({ start: k * stepB, duration: 0.5, pitch: 60, velocity: 0.8 });
  }
  notes.sort((x, y) => x.start - y.start);
  return { a: first, b: second, bars, notes };
}

// ---------------------------------------------------------------------------
// Coral dos objetos
// ---------------------------------------------------------------------------

export const CHOIR_OBJECTS = Object.freeze([
  { id: 'copo', name: 'Copo (tilintar agudo)', pitch: 89 },
  { id: 'livro', name: 'Livro (toc surdo)', pitch: 52 },
  { id: 'garfo', name: 'Garfo (tinido médio)', pitch: 79 },
  { id: 'tampa', name: 'Tampa de panela (tum grave)', pitch: 45 },
  { id: 'moeda', name: 'Moeda (ting fino)', pitch: 96 },
  { id: 'teclado', name: 'Tecla de computador (clique)', pitch: 74 },
]);

export function choirVoices(objectIds, options = {}) {
  const seed = normalizeSeed(options.seed, 1);
  const bars = clamp(Math.round(numOr(options.bars, 1)), 1, 4);
  const ticksPerBar = Math.round(numOr(options.ticksPerBar, 16));
  const total = ticksPerBar * bars;
  const selected = (Array.isArray(objectIds) ? objectIds : [objectIds])
    .map(id => CHOIR_OBJECTS.find(object => object.id === id))
    .filter(object => object !== undefined);
  if (selected.length === 0) throw new TypeError('Selecione ao menos um objeto para o coral.');
  const random = mulberry32(seed ^ 0x6c0ffee1);
  const voices = [];
  const notes = [];
  for (const object of selected) {
    const onsets = [];
    const count = 2 + Math.floor(random() * 4);
    const used = new Set();
    for (let i = 0; i < count; i += 1) {
      let tick = Math.floor(random() * total);
      let guard = 0;
      while (used.has(tick) && guard < 8) {
        tick = (tick + 1) % total;
        guard += 1;
      }
      used.add(tick);
      onsets.push(tick);
    }
    onsets.sort((x, y) => x - y);
    voices.push({ object, onsets });
    for (const tick of onsets) {
      notes.push({ start: tick, duration: 1, pitch: object.pitch, velocity: 0.7 });
    }
  }
  notes.sort((x, y) => x.start - y.start);
  const numbered = notes.map((note, index) => ({ ...note, id: `choir-${seed}-${index}` }));
  return { objects: selected, voices, notes: numbered, bars, seed };
}

// Resumo honesto do pulso interno na sala do silêncio: intervalos entre
// toques, média, variação e tendência — observação, nunca nota.
export function silenceSummary(attempts, bpm) {
  const taps = validateAttempts(attempts).map(attempt => attempt.start).sort((a, b) => a - b);
  const beatMs = (60 / clamp(Math.round(numOr(bpm, 90)), 30, 300)) * 1000;
  if (taps.length < 2) {
    return { taps: taps.length, intervalsMs: [], meanMs: null, spreadMs: null, beatMs, driftMs: null, text: `Só ${taps.length} toque(s) registrado(s): sem medida de intervalo. Entre de novo e toque em cada pulso.` };
  }
  const intervalsMs = [];
  for (let i = 1; i < taps.length; i += 1) intervalsMs.push(Math.round((taps[i] - taps[i - 1]) * 1000));
  const meanMs = intervalsMs.reduce((sum, value) => sum + value, 0) / intervalsMs.length;
  const spreadMs = Math.max(...intervalsMs) - Math.min(...intervalsMs);
  const driftMs = meanMs - beatMs;
  const tendency = driftMs > 8 ? 'mais lento que o alvo' : driftMs < -8 ? 'mais rápido que o alvo' : 'próximo do alvo';
  return {
    taps: taps.length,
    intervalsMs,
    meanMs,
    spreadMs,
    beatMs,
    driftMs,
    text: `Pulso interno: ${taps.length} toques, ${intervalsMs.length} intervalo(s); média de ${Math.round(meanMs)} ms por pulso (alvo do bpm: ${Math.round(beatMs)} ms); variação de ${Math.round(spreadMs)} ms entre intervalos; tendência ${tendency} (${driftMs >= 0 ? '+' : ''}${Math.round(driftMs)} ms por pulso). Só observação — sem nota.`,
  };
}

// ---------------------------------------------------------------------------
// Montagem do playground
// ---------------------------------------------------------------------------

function requireHost(host) {
  if (!host || typeof host !== 'object') throw new TypeError('O playground requer um host do estúdio.');
  for (const method of ['getSession', 'updateSession', 'play', 'stop', 'notify']) {
    if (typeof host[method] !== 'function') throw new TypeError(`O host do playground precisa do método ${method}.`);
  }
}

function downloadText(name, text, type = 'application/json') {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return false;
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = createEl('a', { href: url, download: name });
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

export function mountPlayground(container, host, options = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para o playground.');
  requireHost(host);
  const storage = options.storage ?? safeStorage();
  const loadInfo = loadPlaygroundState(storage);
  const state = loadInfo.state;
  const session0 = normalizeSession(host.getSession());

  const volume = () => state.effects.volume;
  let goblin = { seed: 1, call: null, response: new Set() };
  let dungeon = { seed: 1, rooms: null, roomIndex: 0, phase: 'idle', marked: new Set(), answered: null, finished: false };
  let boss = { seed: 1, original: null, data: null, marked: new Set(), answered: null };
  let alchemy = { kind: 'retrograde', preview: null };
  let passages = { silence: { phase: 'idle', bpm: session0.bpm, bars: 2, softClicks: false, attempts: [], startAt: 0, beat: 0 }, portal: { a: 3, b: 2 } };
  let choir = { selected: new Set(['copo', 'livro', 'garfo']), seed: 1, last: null };
  let fertile = { selectedId: null, quantize: 'strict', conversion: null };
  let activity = 'duet';
  let passageActivity = 'silence';
  // Jogos de ouvido: realocados do antigo bloco "Prática guiada"; usam o mesmo
  // motor e o estado legado compartilhado (leitura+mutação na mesma passada).
  const earGames = createEarGames(host, { storage });
  const activities = [
    { id: 'duet', name: 'Dueto', render: renderGoblinSection },
    { id: 'dungeon', name: 'Masmorra', render: renderDungeonSection },
    { id: 'boss', name: 'Chefe', render: renderBossSection },
    { id: 'cultivate', name: 'Cultivar capturas', render: renderFertileSection },
    { id: 'alchemy', name: 'Alquimia', render: renderAlchemySection },
    { id: 'passages', name: 'Passagens', render: renderPassagesSection },
    { id: 'choir', name: 'Coral dos objetos', render: renderChoirSection },
    { id: 'ears', name: 'Jogos de ouvido', render: () => earGames.render(rerender) },
  ];
  const timers = new Set();

  const root = createEl('section', { className: 'playground-root', 'aria-label': 'Playground musical' });

  function save() {
    if (!savePlaygroundState(state, storage)) host.notify('Não foi possível salvar os dados do playground localmente.', true);
  }

  function preview(notes, options = {}) {
    return previewPhrase(host, notes, { volume: volume(), ...options });
  }

  function rerender() {
    if (!container.contains(root)) container.appendChild(root);
    renderKeepingFocus(root, renderAll);
  }

  function render() {
    rerender();
    return api;
  }

  function destroy() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    passages.silence.phase = 'idle';
    root.remove();
  }

  function onFinish(attempts, detail) {
    if (!Array.isArray(attempts) || attempts.length === 0) return null;
    const session = detail?.session && typeof detail.session === 'object' ? detail.session : host.getSession();
    const normalized = normalizeSession(session);
    const capture = {
      id: `engine-${runId(attempts, normalized.bpm)}`,
      at: new Date().toISOString(),
      kind: 'engine-attempt',
      label: `Tentativa do treino (${attempts.length} toques, ${normalized.bpm} bpm)`,
      attempts: validateAttempts(attempts),
      notes: [],
      bpm: normalized.bpm,
      bars: Math.min(16, (session.loop.endBar - session.loop.startBar) * session.training.repetitions),
      meter: normalized.meter,
    };
    const recorded = recordCapture(state, capture);
    if (recorded.recorded) {
      save();
      host.notify('Tentativa do treino guardada no playground: cultive-a em Erros férteis quando quiser.');
    }
    rerender();
    return recorded.recorded ? recorded.entry : null;
  }

  // ----- seções ---------------------------------------------------------------

  function renderAll() {
    root.replaceChildren();
    if (loadInfo.warnings.length > 0) {
      const box = createEl('div', { className: 'practice-warnings', role: 'status' });
      for (const warning of loadInfo.warnings) box.appendChild(createEl('p', { text: warning }));
      if (loadInfo.recoveryRaw !== null) {
        const recover = createEl('button', { type: 'button', text: 'Baixar capturas brutas para recuperação' });
        recover.addEventListener('click', () => {
          if (!downloadText('groovegoblin-playground-recuperacao.json', loadInfo.recoveryRaw)) host.notify('Download indisponível; os dados brutos continuam preservados.', true);
        });
        box.appendChild(recover);
      }
      root.appendChild(box);
    }
    const toolbar = createEl('section', { className: 'playground-toolbar', 'aria-label': 'Escolha uma atividade' });
    const chooser = createEl('select', { id: 'playground-activity', 'aria-label': 'Atividade do playground' });
    for (const item of activities) {
      chooser.appendChild(createEl('option', { value: item.id, selected: activity === item.id, text: item.name }));
    }
    chooser.addEventListener('change', () => {
      activity = chooser.value;
      rerender();
    });
    toolbar.appendChild(createEl('label', {}, [createEl('span', { text: 'Explorar: ' }), chooser]));
    toolbar.appendChild(renderEffectsSection());
    root.appendChild(toolbar);
    const current = activities.find(item => item.id === activity).render();
    current.dataset.activity = activity;
    root.appendChild(current);
  }

  function renderEffectsSection() {
    const section = createEl('div', { className: 'playground-effects', 'aria-label': 'Volume e parada' });
    const row = createEl('div', { className: 'practice-inline-controls' });
    const slider = createEl('input', { type: 'range', min: '5', max: '100', value: String(Math.round(volume() * 100)), 'aria-label': 'Volume das prévias do playground' });
    slider.addEventListener('input', () => {
      state.effects.volume = clamp(Number(slider.value) / 100, 0.05, 1);
      save();
    });
    const volumeLabel = createEl('span', { id: 'playground-effects-title', text: `Volume: ${Math.round(volume() * 100)}% ` });
    slider.addEventListener('input', () => { volumeLabel.textContent = `Volume: ${Math.round(volume() * 100)}% `; });
    row.appendChild(createEl('label', {}, [volumeLabel, slider]));
    const stop = createEl('button', { type: 'button', text: 'Parar sons' });
    stop.addEventListener('click', () => {
      host.stop();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      passages.silence.phase = 'idle';
      rerender();
    });
    row.appendChild(stop);
    section.appendChild(row);
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'Escolher uma atividade não toca som.' }));
    return section;
  }

  function seedControl(getSet, label, onCommit) {
    const input = createEl('input', { type: 'number', min: '0', max: '4294967295', value: String(getSet()), 'aria-label': label });
    input.addEventListener('change', () => {
      getSet(normalizeSeed(input.value, getSet()));
      input.value = String(getSet());
    });
    const button = createEl('button', { type: 'button', text: 'Sortear semente' });
    button.addEventListener('click', () => {
      getSet(Math.floor(Math.random() * 0xffffffff));
      input.value = String(getSet());
      onCommit();
    });
    const wrap = createEl('div', { className: 'practice-inline-controls' });
    wrap.appendChild(createEl('label', {}, [createEl('span', { text: 'Semente: ' }), input, button]));
    return createEl('details', { className: 'practice-disclosure playground-seed', dataset: { disclosure: `seed-${label}` } }, [
      createEl('summary', { text: 'Ajustar semente' }),
      wrap,
    ]);
  }

  function renderGoblinSection() {
    const section = createEl('section', { className: 'playground-section', 'aria-labelledby': 'playground-goblin-title' });
    section.appendChild(createEl('h3', { id: 'playground-goblin-title', text: 'Dueto com o duende' }));
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'Ouça o chamado, marque sua resposta e compare os ritmos. Sua resposta é uma escolha criativa.' }));
    const seedRow = seedControl(value => {
      if (value === undefined) return goblin.seed;
      goblin.seed = value;
      return goblin.seed;
    }, 'Semente do chamado do duende', () => {
      goblin.call = null;
      goblin.response = new Set();
      rerender();
    });
    section.appendChild(seedRow);
    if (!goblin.call) {
      const callButton = createEl('button', { type: 'button', className: 'practice-primary', text: 'Chamar o duende' });
      callButton.addEventListener('click', async () => {
        const call = goblinCall({ seed: goblin.seed, bars: 2 });
        goblin.call = call;
        rerender();
        try {
          await preview(call.notes, { bpm: 90 });
        } catch (error) {
          host.notify(error.message, true);
        }
      });
      section.appendChild(callButton);
      return section;
    }
    section.appendChild(createEl('p', { className: 'playground-subtitle', text: 'Chamado do duende:' }));
    section.appendChild(renderTickGrid(goblin.call.notes, goblin.call.bars, 16, { ariaLabel: 'Chamado do duende', ticksPerBeat: 4 }));
    const callControls = createEl('div', { className: 'practice-inline-controls' });
    const replay = createEl('button', { type: 'button', text: 'Ouvir chamado de novo' });
    replay.addEventListener('click', () => preview(goblin.call.notes, { bpm: 90 }).catch(error => host.notify(error.message, true)));
    callControls.appendChild(replay);
    const newCall = createEl('button', { type: 'button', text: 'Novo chamado (mesma semente avança)' });
    newCall.addEventListener('click', () => {
      goblin.seed = (goblin.seed + 1) % 0xffffffff;
      goblin.call = goblinCall({ seed: goblin.seed, bars: 2 });
      goblin.response = new Set();
      rerender();
      preview(goblin.call.notes, { bpm: 90 }).catch(error => host.notify(error.message, true));
    });
    callControls.appendChild(newCall);
    section.appendChild(callControls);

    section.appendChild(createEl('p', { className: 'playground-subtitle', text: 'Sua resposta (marque os ataques):' }));
    section.appendChild(renderTickGrid([], goblin.call.bars, 16, {
      ariaLabel: 'Resposta: marque seus ataques',
      marked: goblin.response,
      ticksPerBeat: 4,
      onToggle: tick => {
        if (goblin.response.has(tick)) goblin.response.delete(tick);
        else goblin.response.add(tick);
        rerender();
      },
    }));
    const responseControls = createEl('div', { className: 'practice-inline-controls' });
    const responseNotes = ticksFromResponse(goblin.response).map((tick, index) => ({ id: `response-${index}`, start: tick, duration: 1, pitch: 69, velocity: 0.8 }));
    const playResponse = createEl('button', { type: 'button', className: 'practice-primary', text: 'Ouvir resposta' });
    playResponse.addEventListener('click', () => {
      if (responseNotes.length === 0) {
        host.notify('Marque ao menos um ataque na grade para responder.');
        return;
      }
      preview(responseNotes, { bpm: 90 }).catch(error => host.notify(error.message, true));
    });
    responseControls.appendChild(playResponse);
    const compare = createEl('button', { type: 'button', text: 'Comparar com o chamado' });
    compare.addEventListener('click', () => {
      const result = compareRhythms(goblin.call.notes, goblin.response, { ticksPerBar: 16, bars: goblin.call.bars });
      const similarity = Math.round(result.similarity * 100);
      host.notify(
        result.matched === 0 && result.response.length === 0
          ? 'Resposta vazia: marque ataques na grade para o dueto.'
          : `Dueto: ${result.matched} ataque(s) em comum, ${result.missed.length} do chamado sem resposta, ${result.extra.length} seu(s) a mais — semelhança ${similarity}%. Cada escolha sua é criativa; nada de nota certa ou errada.`
      );
    });
    responseControls.appendChild(compare);
    const saveCapture = createEl('button', { type: 'button', text: 'Guardar resposta' });
    saveCapture.addEventListener('click', () => {
      if (responseNotes.length === 0) {
        host.notify('Marque ao menos um ataque antes de guardar.');
        return;
      }
      const recorded = recordCapture(state, {
        id: `goblin-${goblin.seed}-${Date.now()}`,
        at: new Date().toISOString(),
        kind: 'goblin-response',
        label: `Resposta ao duende (semente ${goblin.seed}, ${responseNotes.length} ataques)`,
        notes: responseNotes,
        bpm: 90,
        bars: goblin.call.bars,
      });
      if (recorded.recorded) {
        save();
        host.notify('Resposta guardada em capturas (veja Erros férteis).');
        rerender();
      }
    });
    responseControls.appendChild(saveCapture);
    section.appendChild(responseControls);
    return section;
  }

  function renderDungeonSection() {
    const section = createEl('section', { className: 'playground-section', 'aria-labelledby': 'playground-dungeon-title' });
    section.appendChild(createEl('h3', { id: 'playground-dungeon-title', text: 'Masmorra do clique sumido' }));
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'Ouça a frase completa e encontre os cliques que sumiram. Cada sala revela a resposta.' }));
    section.appendChild(seedControl(value => {
      if (value === undefined) return dungeon.seed;
      dungeon.seed = value;
      return dungeon.seed;
    }, 'Semente da masmorra', () => {
      dungeon.rooms = null;
      dungeon.roomIndex = 0;
      dungeon.phase = 'idle';
      dungeon.marked = new Set();
      dungeon.answered = null;
      dungeon.finished = false;
      rerender();
    }));
    if (!dungeon.rooms) {
      const enter = createEl('button', { type: 'button', className: 'practice-primary', text: 'Entrar na masmorra' });
      enter.addEventListener('click', () => {
        dungeon.rooms = dungeonRooms({ seed: dungeon.seed, rooms: 5 }).rooms;
        dungeon.roomIndex = 0;
        dungeon.phase = 'reference';
        dungeon.marked = new Set();
        dungeon.answered = null;
        dungeon.finished = false;
        rerender();
      });
      section.appendChild(enter);
      return section;
    }
    if (dungeon.finished) {
      section.appendChild(createEl('p', { className: 'practice-done', role: 'status', text: 'Masmorra concluída! Todas as salas reveladas — o Portal Polirrítmico te espera em Passagens.' }));
      const restart = createEl('button', { type: 'button', text: 'Nova masmorra (outra semente)' });
      restart.addEventListener('click', () => {
        dungeon.seed = (dungeon.seed + 1) % 0xffffffff;
        dungeon.rooms = null;
        dungeon.finished = false;
        rerender();
      });
      section.appendChild(restart);
      return section;
    }
    const room = dungeon.rooms[dungeon.roomIndex];
    if (!room) return section;
    section.appendChild(createEl('p', { className: 'playground-subtitle', text: `Sala ${room.room} de ${dungeon.rooms.length} — ${room.bpm} bpm, ${room.hidden.length} clique(s) sumido(s).` }));

    if (dungeon.phase === 'reference') {
      section.appendChild(createEl('p', { className: 'practice-hint', text: 'Ouça a referência completa com todos os cliques:' }));
      section.appendChild(renderTickGrid(room.notes, 1, 16, { ariaLabel: 'Referência completa da sala', ticksPerBeat: 4 }));
      const controls = createEl('div', { className: 'practice-inline-controls' });
      const listen = createEl('button', { type: 'button', className: 'practice-primary', text: 'Ouvir referência completa' });
      listen.addEventListener('click', () => preview(room.notes, { bpm: room.bpm }).catch(error => host.notify(error.message, true)));
      controls.appendChild(listen);
      const next = createEl('button', { type: 'button', text: 'Ouvi — esconder clique(s)' });
      next.addEventListener('click', () => {
        dungeon.phase = 'hidden';
        dungeon.marked = new Set();
        dungeon.answered = null;
        rerender();
      });
      controls.appendChild(next);
      section.appendChild(controls);
      return section;
    }

    const vanished = dungeonVanishedNotes(room);
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'Agora o clique sumiu: ouça a versão com buracos e marque onde as notas desapareceram.' }));
    section.appendChild(renderTickGrid(vanished, 1, 16, { ariaLabel: 'Versão com cliques escondidos', ticksPerBeat: 4 }));
    const controls = createEl('div', { className: 'practice-inline-controls' });
    const listenHidden = createEl('button', { type: 'button', className: 'practice-primary', text: 'Ouvir com clique(s) sumido(s)' });
    listenHidden.addEventListener('click', () => preview(vanished, { bpm: room.bpm }).catch(error => host.notify(error.message, true)));
    controls.appendChild(listenHidden);
    const listenFull = createEl('button', { type: 'button', text: 'Ouvir referência completa de novo' });
    listenFull.addEventListener('click', () => preview(room.notes, { bpm: room.bpm }).catch(error => host.notify(error.message, true)));
    controls.appendChild(listenFull);
    section.appendChild(controls);

    section.appendChild(createEl('p', { className: 'playground-subtitle', text: 'Onde o clique sumiu? Marque na grade:' }));
    section.appendChild(renderTickGrid(vanished, 1, 16, {
      ariaLabel: 'Resposta: onde o clique sumiu',
      marked: dungeon.answered ? new Set(room.hidden) : dungeon.marked,
      ticksPerBeat: 4,
      onToggle: dungeon.answered ? null : tick => {
        if (dungeon.marked.has(tick)) dungeon.marked.delete(tick);
        else dungeon.marked.add(tick);
        rerender();
      },
    }));
    const answerControls = createEl('div', { className: 'practice-inline-controls' });
    if (!dungeon.answered) {
      const check = createEl('button', { type: 'button', className: 'practice-primary', text: 'Conferir' });
      check.addEventListener('click', () => {
        dungeon.answered = dungeonCheck(room, [...dungeon.marked]);
        if (dungeon.answered.correct) {
          recordCapture(state, {
            id: `dungeon-${dungeon.seed}-${room.room}`,
            at: new Date().toISOString(),
            kind: 'dungeon',
            label: `Sala ${room.room} da masmorra limpa (${room.hidden.length} clique(s) achado(s), ${room.bpm} bpm)`,
            notes: room.notes,
            bpm: room.bpm,
            bars: 1,
          });
          save();
        }
        rerender();
      });
      answerControls.appendChild(check);
    } else {
      const ok = dungeon.answered.correct;
      section.appendChild(createEl('p', {
        className: 'practice-ear-feedback',
        role: 'status',
        text: ok
          ? `Sala ${room.room} limpa! Você achou todos os cliques sumidos.`
          : `Quase: faltou marcar ${dungeon.answered.missed.length} clique(s) (${dungeon.answered.missed.join(', ') || '—'}) e houve ${dungeon.answered.extra.length} marcação(ões) extra(s). A grade agora mostra onde os cliques sumiram.`,
      }));
      const nextRoom = createEl('button', { type: 'button', className: ok ? 'practice-primary' : '', text: dungeon.roomIndex + 1 >= dungeon.rooms.length ? 'Sala final concluída' : 'Próxima sala' });
      nextRoom.addEventListener('click', () => {
        if (dungeon.roomIndex + 1 >= dungeon.rooms.length) {
          dungeon.finished = true;
          if (!state.eggs.portal) {
            state.eggs.portal = true;
            save();
            host.notify('Você encontrou o Portal Polirrítmico! Ele também fica sempre aberto em Passagens.');
          }
        } else {
          dungeon.roomIndex += 1;
          dungeon.phase = 'reference';
          dungeon.marked = new Set();
          dungeon.answered = null;
        }
        rerender();
      });
      answerControls.appendChild(nextRoom);
      const retry = createEl('button', { type: 'button', text: 'Tentar esta sala de novo' });
      retry.addEventListener('click', () => {
        dungeon.phase = 'reference';
        dungeon.marked = new Set();
        dungeon.answered = null;
        rerender();
      });
      answerControls.appendChild(retry);
    }
    section.appendChild(answerControls);
    return section;
  }

  function renderBossSection() {
    const section = createEl('section', { className: 'playground-section', 'aria-labelledby': 'playground-boss-title' });
    section.appendChild(createEl('h3', { id: 'playground-boss-title', text: 'Chefe devorador de espaço' }));
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'O chefe toca nos silêncios da frase original. Ouça e marque todos os ataques dele; depois confira o mapa.' }));
    section.appendChild(seedControl(value => {
      if (value === undefined) return boss.seed;
      boss.seed = value;
      return boss.seed;
    }, 'Semente do chefe', () => {
      boss.original = null;
      boss.data = null;
      boss.marked = new Set();
      boss.answered = null;
      rerender();
    }));
    if (!boss.original) {
      const summon = createEl('button', { type: 'button', className: 'practice-primary', text: 'Invocar chefe' });
      summon.addEventListener('click', () => {
        const original = goblinCall({ seed: boss.seed, bars: 2, density: 'medium', syncopation: 'mixed', lengths: 'short' });
        boss.original = original;
        boss.data = bossAttacks(original.notes, original.bars, { seed: boss.seed });
        boss.marked = new Set();
        boss.answered = null;
        rerender();
      });
      section.appendChild(summon);
      return section;
    }
    section.appendChild(createEl('p', { className: 'playground-subtitle', text: 'Frase original (os espaços são a comida do chefe):' }));
    section.appendChild(renderTickGrid(boss.original.notes, boss.original.bars, 16, { ariaLabel: 'Frase original', ticksPerBeat: 4 }));
    const controls = createEl('div', { className: 'practice-inline-controls' });
    const listenOriginal = createEl('button', { type: 'button', text: 'Ouvir frase original' });
    listenOriginal.addEventListener('click', () => preview(boss.original.notes, { bpm: 90 }).catch(error => host.notify(error.message, true)));
    controls.appendChild(listenOriginal);
    const listenBoss = createEl('button', { type: 'button', text: 'Ouvir os ataques do chefe' });
    listenBoss.addEventListener('click', () => preview(boss.data.notes, { bpm: 90 }).catch(error => host.notify(error.message, true)));
    controls.appendChild(listenBoss);
    const listenBoth = createEl('button', { type: 'button', text: 'Ouvir original + chefe juntos' });
    listenBoth.addEventListener('click', () => {
      const combined = [...boss.original.notes.map(note => ({ ...note, velocity: 0.7 })), ...boss.data.notes];
      preview(combined, { bpm: 90 }).catch(error => host.notify(error.message, true));
    });
    controls.appendChild(listenBoth);
    section.appendChild(controls);

    section.appendChild(createEl('p', { className: 'playground-subtitle', text: `Marque os ataques do chefe (${boss.data.attacks.length} no total):` }));
    section.appendChild(renderTickGrid(boss.original.notes, boss.original.bars, 16, {
      ariaLabel: 'Resposta: onde o chefe ataca',
      marked: boss.answered ? new Set(boss.data.attacks) : boss.marked,
      ticksPerBeat: 4,
      onToggle: boss.answered ? null : tick => {
        if (boss.marked.has(tick)) boss.marked.delete(tick);
        else boss.marked.add(tick);
        rerender();
      },
    }));
    const answerControls = createEl('div', { className: 'practice-inline-controls' });
    if (!boss.answered) {
      const check = createEl('button', { type: 'button', className: 'practice-primary', text: 'Verificar' });
      check.addEventListener('click', () => {
        boss.answered = bossCheck(boss.data, [...boss.marked]);
        if (boss.answered.correct) {
          recordCapture(state, {
            id: `boss-${boss.seed}-${Date.now()}`,
            at: new Date().toISOString(),
            kind: 'boss',
            label: `Chefe devorado (semente ${boss.seed}, ${boss.data.attacks.length} ataques dele)`,
            notes: boss.data.notes,
            bpm: 90,
            bars: boss.original.bars,
          });
          save();
          if (!state.eggs.mirror) {
            state.eggs.mirror = true;
            save();
            host.notify('Chefe derrotado! O Espelho Reverso se revelou em Passagens (ele também fica sempre disponível lá).');
          }
        }
        rerender();
      });
      answerControls.appendChild(check);
    } else {
      section.appendChild(createEl('p', {
        className: 'practice-ear-feedback',
        role: 'status',
        text: boss.answered.correct
          ? 'Objetivo cumprido: todos os ataques do chefe marcados nos espaços da frase!'
          : `Quase: faltaram ${boss.answered.missed.length} ataque(s) do chefe (${boss.answered.missed.join(', ') || '—'}) e houve ${boss.answered.extra.length} marcação(ões) fora do alvo. A grade agora mostra os ataques reais dele.`,
      }));
      const retry = createEl('button', { type: 'button', text: 'Tentar de novo' });
      retry.addEventListener('click', () => {
        boss.marked = new Set();
        boss.answered = null;
        rerender();
      });
      answerControls.appendChild(retry);
      const applyBoss = createEl('button', { type: 'button', text: 'Aplicar padrão do chefe à sessão' });
      applyBoss.addEventListener('click', () => {
        host.updateSession({ notes: boss.data.notes.map(note => ({ ...note })), bars: boss.original.bars, meter: { beats: 4, unit: 4 }, loop: { startBar: 0, endBar: boss.original.bars } });
        host.notify('Padrão do chefe aplicado como frase da sessão (tom grave do duende devorador).');
      });
      answerControls.appendChild(applyBoss);
    }
    section.appendChild(answerControls);
    return section;
  }

  function renderFertileSection() {
    const section = createEl('section', { className: 'playground-section', 'aria-labelledby': 'playground-fertile-title' });
    section.appendChild(createEl('h3', { id: 'playground-fertile-title', text: 'Erros férteis' }));
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'Transforme uma tentativa ou resposta guardada em frase. Preserve o microtiming ou endireite; ouça, aplique ou exporte.' }));
    if (state.captures.length === 0) {
      section.appendChild(createEl('p', { className: 'practice-hint', text: 'Nenhuma captura ainda: responda ao duende, limpe salas, derrote o chefe ou termine um treino (as tentativas do motor chegam aqui sozinhas).' }));
      return section;
    }
    const list = createEl('ul', { className: 'playground-captures' });
    for (const capture of [...state.captures].reverse()) {
      const item = createEl('li', { className: 'playground-capture' });
      const kindLabel = {
        'goblin-response': 'resposta ao duende',
        dungeon: 'sala da masmorra',
        boss: 'chefão',
        silence: 'sala do silêncio',
        'engine-attempt': 'tentativa do treino',
        choir: 'coral dos objetos',
      }[capture.kind] ?? capture.kind;
      item.appendChild(createEl('span', { className: 'practice-history-at', text: `${formatDatePt(capture.at)} · ${kindLabel}` }));
      item.appendChild(createEl('span', { className: 'practice-history-summary', text: capture.label }));
      const controls = createEl('div', { className: 'practice-inline-controls' });
      const listen = createEl('button', { type: 'button', text: 'Ouvir' });
      listen.addEventListener('click', () => {
        const notes = capture.notes.length > 0
          ? capture.notes
          : attemptsToPhrase(capture.attempts, { bpm: capture.bpm, quantize: 'preserve', bars: capture.bars, ticksPerBar: capture.meter.beats * 16 / capture.meter.unit }).notes;
        if (notes.length === 0) {
          host.notify('Esta captura não tem notas para ouvir.');
          return;
        }
        preview(notes, { bpm: capture.bpm }).catch(error => host.notify(error.message, true));
      });
      controls.appendChild(listen);
      const cultivate = createEl('button', { type: 'button', className: fertile.selectedId === capture.id ? 'practice-primary' : '', text: 'Cultivar' });
      cultivate.addEventListener('click', () => {
        fertile.selectedId = capture.id;
        fertile.quantize = capture.kind === 'engine-attempt' ? 'preserve' : fertile.quantize;
        fertile.conversion = null;
        rerender();
      });
      controls.appendChild(cultivate);
      const remove = createEl('button', { type: 'button', text: 'Apagar' });
      remove.addEventListener('click', () => {
        deleteCapture(state, capture.id);
        if (fertile.selectedId === capture.id) fertile.selectedId = null;
        save();
        rerender();
      });
      controls.appendChild(remove);
      item.appendChild(controls);
      list.appendChild(item);
    }
    section.appendChild(list);

    if (fertile.selectedId) {
      const capture = state.captures.find(entry => entry.id === fertile.selectedId);
      if (capture) {
        const box = createEl('div', { className: 'playground-fertile-panel', role: 'region', 'aria-label': 'Cultivo de erro fértil' });
        box.appendChild(createEl('p', { text: `Cultivando: ${capture.label}` }));
        const controls = createEl('div', { className: 'practice-inline-controls' });
        for (const [value, label] of [['strict', 'Endireitar (quantizar no tick)'], ['preserve', 'Preservar microtiming (ticks fracionários)']]) {
          const button = createEl('button', {
            type: 'button',
            className: `practice-chip${fertile.quantize === value ? ' practice-chip-selected' : ''}`,
            'aria-pressed': fertile.quantize === value ? 'true' : 'false',
            text: label,
          });
          button.addEventListener('click', () => {
            fertile.quantize = value;
            fertile.conversion = null;
            rerender();
          });
          controls.appendChild(button);
        }
        box.appendChild(controls);
        const convertButton = createEl('button', { type: 'button', className: 'practice-primary', text: 'Converter em frase' });
        convertButton.addEventListener('click', () => {
          const source = capture.notes.length > 0
            ? capture.notes.map(note => ({ start: note.start * tickSeconds(capture.bpm), end: (note.start + note.duration) * tickSeconds(capture.bpm), pitch: note.pitch }))
            : capture.attempts;
          const conversion = attemptsToPhrase(source, { bpm: capture.bpm, quantize: fertile.quantize, bars: capture.bars, ticksPerBar: capture.meter.beats * 16 / capture.meter.unit });
          fertile.conversion = { ...conversion, meter: capture.meter, captureId: capture.id };
          rerender();
          if (conversion.adjusted.length > 0) {
            host.notify(`${conversion.adjusted.length} toque(s) ficaram fora da grade e foram atraídos para o tick mais próximo (veja a lista no painel).`);
          }
        });
        box.appendChild(convertButton);
        if (fertile.conversion) {
          const conversion = fertile.conversion;
          box.appendChild(renderTickGrid(conversion.notes, Math.max(1, conversion.bars), conversion.meter.beats * 16 / conversion.meter.unit, { ariaLabel: 'Frase cultivada', ticksPerBeat: 16 / conversion.meter.unit }));
          if (conversion.adjusted.length > 0) {
            const details = createEl('p', { className: 'practice-hint' });
            details.appendChild(document.createTextNode('Toques ajustados para o tick vizinho: '));
            details.appendChild(document.createTextNode(conversion.adjusted.map(adj => `${adj.from}→${adj.to}`).join(', ')));
            box.appendChild(details);
          }
          const conversionControls = createEl('div', { className: 'practice-inline-controls' });
          const previewButton = createEl('button', { type: 'button', text: 'Prévia' });
          previewButton.addEventListener('click', () => preview(conversion.notes, { bpm: conversion.bpm }).catch(error => host.notify(error.message, true)));
          conversionControls.appendChild(previewButton);
          const applyButton = createEl('button', { type: 'button', className: 'practice-primary', text: 'Aplicar à sessão' });
          applyButton.addEventListener('click', () => {
            host.updateSession({ notes: conversion.notes.map(note => ({ ...note })), bars: conversion.bars, bpm: conversion.bpm, meter: conversion.meter, loop: { startBar: 0, endBar: conversion.bars } });
            state.cultivatedCount += 1;
            save();
            host.notify('Frase cultivada aplicada à sessão do estúdio.');
            if (state.cultivatedCount === 3 && !state.eggs.silence) {
              state.eggs.silence = true;
              save();
              host.notify('Três cultivos! A Sala do Silêncio se abriu em Passagens (também sempre disponível lá).');
            }
            rerender();
          });
          conversionControls.appendChild(applyButton);
          const exportButton = createEl('button', { type: 'button', text: 'Exportar (.json)' });
          exportButton.addEventListener('click', () => {
            const payload = patchSession(host.getSession(), { notes: conversion.notes, bpm: conversion.bpm, bars: conversion.bars, meter: conversion.meter, loop: { startBar: 0, endBar: conversion.bars } });
            const ok = downloadText('groovegoblin-frase-cultivada.json', serializeSession(payload));
            if (!ok) host.notify('Exportação indisponível neste ambiente.', true);
          });
          conversionControls.appendChild(exportButton);
          box.appendChild(conversionControls);
        }
        section.appendChild(box);
      }
    }
    return section;
  }

  function renderAlchemySection() {
    const section = createEl('section', { className: 'playground-section', 'aria-labelledby': 'playground-alchemy-title' });
    section.appendChild(createEl('h3', { id: 'playground-alchemy-title', text: 'Alquimia do motivo' }));
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'Escolha uma transformação para a frase da sessão. Confira o resultado antes de ouvir, aplicar ou exportar.' }));
    const session = normalizeSession(host.getSession());
    const select = createEl('select', { 'aria-label': 'Transformação alquímica' });
    for (const transform of TRANSFORMS) {
      const option = createEl('option', { value: transform.id, text: transform.name });
      if (transform.id === alchemy.kind) option.setAttribute('selected', 'selected');
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      alchemy.kind = select.value;
      alchemy.preview = null;
      rerender();
    });
    const row = createEl('div', { className: 'practice-inline-controls' });
    row.appendChild(createEl('label', {}, [createEl('span', { text: 'Transformação: ' }), select]));
    const transformButton = createEl('button', { type: 'button', className: 'practice-primary', text: 'Transmutar' });
    transformButton.addEventListener('click', () => {
      try {
        alchemy.preview = transformPhrase(session.notes, alchemy.kind, {
          ticksPerBar: session.ticksPerBar,
          bars: session.bars,
          ticksPerBeat: session.ticksPerBeat,
          chordTones: session.chordTones,
        });
        rerender();
      } catch (error) {
        alchemy.preview = null;
        rerender();
        host.notify(error.message, true);
      }
    });
    row.appendChild(transformButton);
    section.appendChild(row);
    if (alchemy.preview) {
      section.appendChild(createEl('p', { className: 'playground-subtitle', text: 'Resultado da transmutação:' }));
      section.appendChild(renderTickGrid(alchemy.preview, session.bars, session.ticksPerBar, { ariaLabel: 'Frase transmutada', ticksPerBeat: session.ticksPerBeat }));
      const controls = createEl('div', { className: 'practice-inline-controls' });
      const previewButton = createEl('button', { type: 'button', text: 'Prévia' });
      previewButton.addEventListener('click', () => preview(alchemy.preview, { bpm: session.bpm }).catch(error => host.notify(error.message, true)));
      controls.appendChild(previewButton);
      const applyButton = createEl('button', { type: 'button', className: 'practice-primary', text: 'Aplicar à sessão' });
      applyButton.addEventListener('click', () => {
        host.updateSession({ notes: alchemy.preview.map(note => ({ ...note })) });
        host.notify(`Transmutação aplicada: ${TRANSFORMS.find(t => t.id === alchemy.kind)?.name ?? alchemy.kind}.`);
        alchemy.preview = null;
        rerender();
      });
      controls.appendChild(applyButton);
      const exportButton = createEl('button', { type: 'button', text: 'Exportar (.json)' });
      exportButton.addEventListener('click', () => {
        const payload = patchSession(host.getSession(), { notes: alchemy.preview, bpm: session.bpm, bars: session.bars, meter: session.meter });
        if (!downloadText('groovegoblin-alquimia.json', serializeSession(payload))) host.notify('Exportação indisponível neste ambiente.', true);
      });
      controls.appendChild(exportButton);
      section.appendChild(controls);
    }
    return section;
  }

  function renderPassagesSection() {
    const section = createEl('section', { className: `playground-section${state.eggs.portal || state.eggs.mirror || state.eggs.silence ? ' playground-passages-open' : ''}`, 'aria-labelledby': 'playground-passages-title' });
    section.appendChild(createEl('h3', { id: 'playground-passages-title', text: 'Passagens' }));
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'Explore o pulso interno, a frase ao contrário ou dois ritmos juntos. Todas as passagens estão disponíveis.' }));
    const chooser = createEl('select', { id: 'playground-passage', 'aria-label': 'Passagem musical' });
    for (const [id, label] of [['silence', 'Sala do silêncio'], ['mirror', 'Espelho reverso'], ['portal', 'Portal polirrítmico']]) {
      chooser.appendChild(createEl('option', { value: id, selected: passageActivity === id, text: label }));
    }
    chooser.addEventListener('change', () => { passageActivity = chooser.value; rerender(); });
    section.appendChild(chooser);
    section.appendChild(({ silence: renderSilenceRoom, mirror: renderMirror, portal: renderPortal })[passageActivity](section));
    return section;
  }

  function scheduleSilenceBeats(beats, onBeat, onDone) {
    const room = passages.silence;
    const beatMs = (60 / room.bpm) * 1000;
    let beat = 0;
    const tick = () => {
      if (room.phase === 'idle') return;
      if (beat >= beats) {
        onDone();
        return;
      }
      onBeat(beat);
      beat += 1;
      const timer = setTimeout(tick, beatMs);
      timers.add(timer);
    };
    const start = setTimeout(tick, 0);
    timers.add(start);
  }

  function renderSilenceRoom(section) {
    const room = passages.silence;
    const box = createEl('div', { className: 'playground-passage', 'aria-label': 'Sala do silêncio' });
    box.appendChild(createEl('h4', { text: 'Sala do silêncio' }));
    box.appendChild(createEl('p', { className: 'practice-hint', text: 'Uma sala sem som: conta-se o pulso em silêncio e você toca no seu pulso interno. Nada toca alto de surpresa — o clique suave é opcional e discreto.' }));
    if (room.phase === 'idle') {
      const controls = createEl('div', { className: 'practice-inline-controls' });
      const bpmInput = createEl('input', { type: 'number', min: '30', max: '300', value: String(room.bpm), 'aria-label': 'Bpm da sala do silêncio' });
      bpmInput.addEventListener('change', () => {
        room.bpm = clamp(Math.round(Number(bpmInput.value) || 90), 30, 300);
        bpmInput.value = String(room.bpm);
      });
      controls.appendChild(createEl('label', {}, [createEl('span', { text: 'Bpm: ' }), bpmInput]));
      const barsInput = createEl('input', { type: 'number', min: '1', max: '4', value: String(room.bars), 'aria-label': 'Compassos da sala do silêncio' });
      barsInput.addEventListener('change', () => {
        room.bars = clamp(Math.round(Number(barsInput.value) || 2), 1, 4);
        barsInput.value = String(room.bars);
      });
      controls.appendChild(createEl('label', {}, [createEl('span', { text: 'Compassos: ' }), barsInput]));
      const soft = createEl('input', { type: 'checkbox', 'aria-label': 'Clique suave opcional na sala do silêncio' });
      soft.checked = room.softClicks;
      soft.addEventListener('change', () => {
        room.softClicks = soft.checked;
      });
      controls.appendChild(createEl('label', {}, [soft, createEl('span', { text: 'Clique suave opcional' })]));
      const enter = createEl('button', { type: 'button', className: 'practice-primary', text: 'Entrar no silêncio' });
      enter.addEventListener('click', () => {
        host.stop();
        room.phase = 'active';
        room.attempts = [];
        room.startAt = performance.now();
        room.beat = 0;
        room.summary = null;
        rerender();
        const beats = 4 + room.bars * 4;
        scheduleSilenceBeats(
          beats,
          beat => {
            room.beat = beat + 1;
            if (room.softClicks) {
              preview([{ start: 0, duration: 0.5, pitch: beat < 4 ? 84 : 76, velocity: 0.3 }], { bpm: room.bpm, volume: 0.35 }).catch(error => host.notify(error.message, true));
            }
            rerender();
          },
          () => {
            room.summary = silenceSummary(room.attempts, room.bpm);
            room.phase = room.attempts.length > 1 ? 'summary' : 'idle';
            rerender();
            host.notify(room.attempts.length > 1 ? 'Sala do silêncio encerrada: veja o resumo do seu pulso interno.' : 'Poucos toques para um resumo do pulso interno; entre de novo quando quiser.');
          }
        );
      });
      controls.appendChild(enter);
      const applySilent = createEl('button', { type: 'button', text: 'Aplicar treino silencioso à sessão' });
      applySilent.addEventListener('click', () => {
        const notes = Array.from({ length: room.bars * 4 }, (_, index) => ({ id: `silent-${index}`, start: index * 4, duration: 1, pitch: 69, velocity: 0.8 }));
        host.updateSession({ notes, bars: room.bars, bpm: room.bpm, meter: { beats: 4, unit: 4 }, loop: { startBar: 0, endBar: room.bars }, training: { monitor: false, goal: 'timing' }, metronome: { enabled: false }, companion: { enabled: false }, drums: { enabled: false }, progression: { enabled: false }, band: { bassEnabled: false }, extensions: { practice: { objective: 'inner-pulse', stage: 'Silêncio' } } });
        host.notify('Sessão silenciosa aplicada: referência de pulsos para avaliação, clique e acompanhamento desligados. Use Treinar no estúdio.');
      });
      controls.appendChild(applySilent);
      box.appendChild(controls);
      return box;
    }
    if (room.phase === 'active') {
      const label = createEl('p', { className: 'playground-silence-status', role: 'status' });
      label.appendChild(document.createTextNode(room.beat <= 4 ? `Contagem em silêncio: ${Math.max(0, 5 - room.beat)} pulso(s)…` : `Toque no seu pulso interno: pulso ${room.beat - 4} de ${room.bars * 4}`));
      box.appendChild(label);
      const pad = createEl('button', { type: 'button', className: 'playground-pad', 'aria-label': 'Toque do pulso interno' , text: 'tocar' });
      const registerTap = () => {
        if (room.beat <= 4) return;
        const now = performance.now();
        room.attempts.push({ start: Math.max(0, (now - room.startAt) / 1000 - 4 * 60 / room.bpm), end: null });
        if (room.softClicks) {
          preview([{ start: 0, duration: 0.5, pitch: 76, velocity: 0.25 }], { bpm: room.bpm, volume: 0.3 }).catch(error => host.notify(error.message, true));
        }
      };
      pad.addEventListener('pointerdown', event => {
        event.preventDefault();
        registerTap();
      });
      pad.addEventListener('keydown', event => {
        if (!event.repeat && (event.code === 'Space' || event.code === 'Enter')) {
          event.preventDefault();
          registerTap();
        }
      });
      box.appendChild(pad);
      const exit = createEl('button', { type: 'button', text: 'Sair da sala' });
      exit.addEventListener('click', () => {
        room.phase = 'idle';
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        rerender();
      });
      box.appendChild(exit);
      return box;
    }
    if (room.phase === 'summary' && room.summary) {
      box.appendChild(createEl('p', { className: 'practice-ear-feedback', role: 'status', text: room.summary.text }));
      const summaryControls = createEl('div', { className: 'practice-inline-controls' });
      const saveCapture = createEl('button', { type: 'button', className: 'practice-primary', text: 'Guardar toques como captura' });
      saveCapture.addEventListener('click', () => {
        const conversion = attemptsToPhrase(room.attempts, { bpm: room.bpm, quantize: 'preserve', bars: room.bars, ticksPerBar: 16 });
        const recorded = recordCapture(state, {
          id: `silence-${Date.now()}`,
          at: new Date().toISOString(),
          kind: 'silence',
          label: `Pulso interno na sala do silêncio (${room.attempts.length} toques, ${room.bpm} bpm)`,
          notes: conversion.notes,
          attempts: validateAttempts(room.attempts),
          bpm: room.bpm,
          bars: room.bars,
        });
        if (recorded.recorded) {
          save();
          host.notify('Toques do silêncio guardados em capturas (microtiming preservado).');
          room.phase = 'idle';
          room.summary = null;
          rerender();
        }
      });
      summaryControls.appendChild(saveCapture);
      const exitSummary = createEl('button', { type: 'button', text: 'Sair da sala' });
      exitSummary.addEventListener('click', () => {
        room.phase = 'idle';
        room.summary = null;
        rerender();
      });
      summaryControls.appendChild(exitSummary);
      box.appendChild(summaryControls);
      return box;
    }
    return box;
  }

  function renderMirror() {
    const box = createEl('div', { className: 'playground-passage', 'aria-label': 'Espelho reverso' });
    box.appendChild(createEl('h4', { text: 'Espelho reverso' }));
    box.appendChild(createEl('p', { className: 'practice-hint', text: 'A frase atual da sessão ao contrário, no tempo: ouça o reflexo, aplique se quiser.' }));
    const controls = createEl('div', { className: 'practice-inline-controls' });
    const session = normalizeSession(host.getSession());
    const listen = createEl('button', { type: 'button', text: 'Ouvir o reflexo' });
    listen.addEventListener('click', () => {
      try {
        const mirrored = transformPhrase(session.notes, 'retrograde', { ticksPerBar: session.ticksPerBar, bars: session.bars });
        preview(mirrored, { bpm: session.bpm }).catch(error => host.notify(error.message, true));
      } catch (error) {
        host.notify(error.message, true);
      }
    });
    controls.appendChild(listen);
    const apply = createEl('button', { type: 'button', text: 'Aplicar reflexo à sessão' });
    apply.addEventListener('click', () => {
      try {
        const mirrored = transformPhrase(session.notes, 'retrograde', { ticksPerBar: session.ticksPerBar, bars: session.bars });
        host.updateSession({ notes: mirrored.map(note => ({ ...note })) });
        host.notify('Frase espelhada aplicada à sessão.');
      } catch (error) {
        host.notify(error.message, true);
      }
    });
    controls.appendChild(apply);
    box.appendChild(controls);
    return box;
  }

  function renderPortal(section) {
    const box = createEl('div', { className: 'playground-passage', 'aria-label': 'Portal polirrítmico' });
    box.appendChild(createEl('h4', { text: 'Portal polirrítmico' }));
    box.appendChild(createEl('p', { className: 'practice-hint', text: 'Dois pulsos no mesmo compasso: um de cada altura. Ouça e veja onde eles se encontram.' }));
    const controls = createEl('div', { className: 'practice-inline-controls' });
    for (const [a, b] of [[3, 2], [4, 3], [5, 4]]) {
      const button = createEl('button', {
        type: 'button',
        className: `practice-chip${passages.portal.a === a && passages.portal.b === b ? ' practice-chip-selected' : ''}`,
        'aria-pressed': passages.portal.a === a && passages.portal.b === b ? 'true' : 'false',
        text: `${a}:${b}`,
      });
      button.addEventListener('click', () => {
        passages.portal = { a, b };
        rerender();
      });
      controls.appendChild(button);
    }
    const pattern = polyrhythmPattern(passages.portal.a, passages.portal.b, { bars: 2 });
    const listen = createEl('button', { type: 'button', className: 'practice-primary', text: 'Ouvir portal' });
    listen.addEventListener('click', () => preview(pattern.notes, { bpm: 90 }).catch(error => host.notify(error.message, true)));
    controls.appendChild(listen);
    const apply = createEl('button', { type: 'button', text: 'Aplicar portal à sessão' });
    apply.addEventListener('click', () => {
      const notes = pattern.notes.filter(note => note.pitch === 60).map((note, index) => ({ ...note, id: `portal-${index}` }));
      host.updateSession({ notes, bars: 2, meter: { beats: 4, unit: 4 }, loop: { startBar: 0, endBar: 2 }, companion: { enabled: true, pulses: pattern.a, spanBeats: 4, pitch: 72 } });
      host.notify(`Portal ${pattern.a}:${pattern.b} aplicado: voz grave na frase e voz aguda no companheiro polirrítmico.`);
    });
    controls.appendChild(apply);
    box.appendChild(controls);
    box.appendChild(renderTickGrid(pattern.notes, 2, 16, { ariaLabel: `Portal ${pattern.a}:${pattern.b}`, ticksPerBeat: 4 }));
    return box;
  }

  function renderChoirSection() {
    const section = createEl('section', { className: 'playground-section', 'aria-labelledby': 'playground-choir-title' });
    section.appendChild(createEl('h3', { id: 'playground-choir-title', text: 'Coral dos objetos' }));
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'Escolha objetos para criar vozes e ritmos sintetizados. Ouça o coral e guarde a ideia; nenhum microfone é usado.' }));
    const controls = createEl('div', { className: 'practice-inline-controls' });
    for (const object of CHOIR_OBJECTS) {
      const label = createEl('label', { className: 'practice-stage-toggle' });
      const checkbox = createEl('input', { type: 'checkbox', 'aria-label': `Objeto do coral: ${object.name}` });
      checkbox.checked = choir.selected.has(object.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) choir.selected.add(object.id);
        else choir.selected.delete(object.id);
        choir.last = null;
        rerender();
      });
      label.appendChild(checkbox);
      label.appendChild(createEl('span', { text: object.name }));
      controls.appendChild(label);
    }
    section.appendChild(controls);
    section.appendChild(seedControl(value => {
      if (value === undefined) return choir.seed;
      choir.seed = value;
      return choir.seed;
    }, 'Semente do coral', () => {
      choir.last = null;
      rerender();
    }));
    const choirControls = createEl('div', { className: 'practice-inline-controls' });
    const sing = createEl('button', { type: 'button', className: 'practice-primary', text: 'Ouvir coral' });
    sing.addEventListener('click', () => {
      try {
        const result = choirVoices([...choir.selected], { seed: choir.seed, bars: 2 });
        choir.last = result;
        rerender();
        preview(result.notes, { bpm: 90 }).catch(error => host.notify(error.message, true));
      } catch (error) {
        host.notify(error.message, true);
      }
    });
    choirControls.appendChild(sing);
    if (choir.last) {
      const saveChoir = createEl('button', { type: 'button', text: 'Guardar coral como captura' });
      saveChoir.addEventListener('click', () => {
        const recorded = recordCapture(state, {
          id: `choir-${choir.seed}-${Date.now()}`,
          at: new Date().toISOString(),
          kind: 'choir',
          label: `Coral dos objetos (semente ${choir.seed}, ${choir.last.objects.map(object => object.id).join(', ')})`,
          notes: choir.last.notes,
          bpm: 90,
          bars: choir.last.bars,
        });
        if (recorded.recorded) {
          save();
          host.notify('Coral guardado em capturas.');
          rerender();
        }
      });
      choirControls.appendChild(saveChoir);
      const applyChoir = createEl('button', { type: 'button', text: 'Aplicar ritmo do coral (ataques) à sessão' });
      applyChoir.addEventListener('click', () => {
        const onsets = [...new Set(choir.last.notes.map(note => Math.round(note.start)))].sort((a, b) => a - b);
        const notes = onsets.map((tick, index) => ({ id: `choir-phrase-${index}`, start: tick, duration: 1, pitch: 69, velocity: 0.8 }));
        host.updateSession({ notes, bars: choir.last.bars, meter: { beats: 4, unit: 4 }, loop: { startBar: 0, endBar: choir.last.bars } });
        host.notify('Ritmo do coral (ataques, altura única) aplicado à sessão.');
      });
      choirControls.appendChild(applyChoir);
    }
    section.appendChild(choirControls);
    if (choir.last) {
      section.appendChild(renderTickGrid(choir.last.notes, choir.last.bars, 16, { ariaLabel: 'Padrão do coral', ticksPerBeat: 4 }));
    }
    return section;
  }

  const api = { render, onFinish, destroy };
  return api;
}
