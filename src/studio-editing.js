import { validPhrase, generateId } from './model.js';

export const DURATION_KEY = 'groovegoblin:studio-note-duration:v1';
export const NOTE_FIGURES = [[1, '𝅘𝅥𝅯', 'Semicolcheia'], [2, '♪', 'Colcheia'], [4, '♩', 'Semínima'], [8, '𝅗𝅥', 'Mínima'], [16, '𝅝', 'Semibreve'], [3, '♪·', 'Colcheia pontuada'], [6, '♩·', 'Semínima pontuada'], [12, '𝅗𝅥·', 'Mínima pontuada'], [4 / 3, 'Tercina', 'Tercina de colcheia'], [4 / 5, 'Quintina', 'Quintina'], [4 / 7, 'Septina', 'Septina']];

export function rememberedDuration(storage = globalThis.localStorage) {
  try { const ticks = Number(storage.getItem(DURATION_KEY)); return ticks > 0 && Number.isFinite(ticks) && ticks <= 256 ? ticks : 2; } catch { return 2; }
}
export function rememberDuration(ticks, storage = globalThis.localStorage) {
  try { storage.setItem(DURATION_KEY, String(ticks)); } catch { /* Editing remains usable without storage. */ }
}

// Validate the final group, not intermediate moves: adjacent selected notes can move together.
export function editNotes(notes, ids, patch, session) {
  const chosen = new Set(ids);
  let changed = false;
  const next = notes.map(note => {
    if (!chosen.has(note.id)) return note;
    const fields = typeof patch === 'function' ? patch(note) : patch;
    if (Object.entries(fields).every(([key, value]) => note[key] === value)) return note;
    changed = true; return { ...note, ...fields };
  });
  return changed && validPhrase(next, session) ? next : notes;
}
export function pasteNotes(notes, copied, tick, session) {
  if (!copied.length || notes.length + copied.length > 512) return null;
  const start = Math.min(...copied.map(note => note.start));
  const added = copied.map(note => ({ ...note, id: generateId(), start: tick + note.start - start }));
  const next = [...notes, ...added].sort((a, b) => a.start - b.start);
  return validPhrase(next, session) ? { notes: next, ids: added.map(note => note.id) } : null;
}
export function editChords(progression, indices, patch, beats) {
  const chosen = new Set(indices);
  const entries = progression.chords.map((chord, index) => ({ chord: chosen.has(index) ? { ...chord, ...(typeof patch === 'function' ? patch(chord) : patch) } : chord, chosen: chosen.has(index) }));
  entries.sort((a, b) => a.chord.startBar - b.chord.startBar);
  if (entries.some(({ chord }, index) => chord.startBar < -1e-8 || chord.durationBars < 1 / beats - 1e-8 || chord.startBar + chord.durationBars > progression.cycleBars + 1e-8 || (index && entries[index - 1].chord.startBar + entries[index - 1].chord.durationBars > chord.startBar + 1e-8))) return null;
  return { chords: entries.map(entry => entry.chord), indices: entries.flatMap((entry, index) => entry.chosen ? [index] : []) };
}
export function playbackEditPolicy(previous, next, { mode = 'idle', pending = false, exercise = false, structural = false } = {}) {
  const changed = key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]);
  const structure = structural || ['bars', 'meter', 'subdivision', 'loop', 'form'].some(changed);
  const active = pending || mode !== 'idle';
  const training = exercise || ['train', 'countin'].includes(mode);
  const trainingChange = training && ['notes', 'progression', 'bpm', 'swing', 'swingUnit', 'training'].some(changed);
  const live = active && !pending && !exercise && !structure && !trainingChange && ['loop', 'train', 'countin'].includes(mode);
  const reason = active && !live ? training ? 'Treino interrompido para aplicar a alteração; a referência executada foi preservada.' : 'Reprodução parada para aplicar a mudança de estrutura ou substituir a frase.' : null;
  return { live, stop: active && !live, reason };
}
