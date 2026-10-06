import { ticksPerBar, MAX_BARS, validateSession } from './session.js';
import { generateId } from './model.js';
import { chordTimeline } from './progression.js';

const EPSILON = 1e-8;
const cloneChord = chord => ({ ...chord, notes: chord.notes.map(note => ({ ...note })) });

// A single explicit cycle is required to edit one occurrence without editing its repeats.
// Retain source data beyond the visible session as well as all existing silent gaps.
export function expandedHarmony(session) {
  const cycleBars = Math.max(session.bars, session.progression.cycleBars);
  const events = chordTimeline({ ...session, bars: cycleBars });
  const measure = ticksPerBar(session);
  return { ...session.progression, cycleBars, chords: events.map(event => ({ ...cloneChord(event.chord), startBar: event.start / measure, durationBars: event.duration / measure })) };
}

function result(session, patch) {
  const checked = validateSession({ ...session, ...patch });
  return checked.ok ? { patch } : { error: `Alteração cancelada: ${checked.error} Nenhum dado foi apagado.` };
}
function validBar(session, bar) { return Number.isInteger(bar) && bar >= 0 && bar < session.bars; }
function overlaps(start, duration, from, to) { return start < to - EPSILON && start + duration > from + EPSILON; }

export function materializeHarmony(session, fromBar) {
  if (!session.progression.enabled || fromBar < session.progression.cycleBars - EPSILON || fromBar >= session.bars) return { error: 'Escolha uma repetição automática dentro da sessão.' };
  return result(session, { progression: expandedHarmony(session) });
}

// Clear only the intersecting interval; a sustain keeps both outside fragments.
export function clearBar(session, bar) {
  if (!validBar(session, bar)) return { error: 'Compasso fora da sessão.' };
  const measure = ticksPerBar(session); const from = bar * measure; const to = from + measure;
  const notes = session.notes.flatMap(note => {
    if (!overlaps(note.start, note.duration, from, to)) return [note];
    const parts = [];
    if (note.start < from) parts.push({ ...note, duration: from - note.start });
    if (note.start + note.duration > to) parts.push({ ...note, id: parts.length ? generateId() : note.id, start: to, duration: note.start + note.duration - to });
    return parts;
  });
  const patch = { notes };
  if (session.progression.enabled) {
    const progression = expandedHarmony(session);
    progression.chords = progression.chords.flatMap(chord => {
      if (!overlaps(chord.startBar, chord.durationBars, bar, bar + 1)) return [chord];
      const parts = [];
      if (chord.startBar < bar) parts.push({ ...cloneChord(chord), durationBars: bar - chord.startBar });
      if (chord.startBar + chord.durationBars > bar + 1) parts.push({ ...cloneChord(chord), startBar: bar + 1, durationBars: chord.startBar + chord.durationBars - bar - 1 });
      return parts;
    });
    patch.progression = progression;
  }
  return result(session, patch);
}

// Copy is additive, never replacement. Occupied collisions reject the whole operation.
export function copyBar(session, source, target) {
  if (!validBar(session, source) || !validBar(session, target) || source === target) return { error: 'Escolha outro compasso dentro da sessão.' };
  const measure = ticksPerBar(session); const from = source * measure; const to = from + measure;
  const notes = session.notes.filter(note => overlaps(note.start, note.duration, from, to)).map(note => {
    const start = Math.max(from, note.start); const end = Math.min(to, note.start + note.duration);
    return { ...note, id: generateId(), start: target * measure + start - from, duration: end - start };
  });
  const patch = { notes: [...session.notes, ...notes].sort((a, b) => a.start - b.start) };
  if (session.progression.enabled) {
    const progression = expandedHarmony(session);
    const added = progression.chords.filter(chord => overlaps(chord.startBar, chord.durationBars, source, source + 1)).map(chord => {
      const start = Math.max(source, chord.startBar); const end = Math.min(source + 1, chord.startBar + chord.durationBars);
      return { ...cloneChord(chord), startBar: target + start - source, durationBars: end - start };
    });
    progression.chords = [...progression.chords, ...added].sort((a, b) => a.startBar - b.startBar);
    patch.progression = progression;
  }
  const checked = result(session, patch);
  return checked.error ? { error: `Não foi possível copiar: o destino tem dados sobrepostos ou o limite de 512 notas / 64 acordes foi atingido. Nenhum dado foi apagado.` } : checked;
}

export function duplicateBar(session, source) {
  if (!validBar(session, source)) return { error: 'Compasso fora da sessão.' };
  if (session.bars >= MAX_BARS) return { error: `Limite de ${MAX_BARS} compassos. Use Copiar para em outro compasso livre; nenhum dado foi apagado.` };
  const insertion = source + 1; const measure = ticksPerBar(session); const boundary = insertion * measure;
  const shifted = session.notes.flatMap(note => {
    if (note.start >= boundary - EPSILON) return [{ ...note, start: note.start + measure }];
    if (note.start + note.duration <= boundary + EPSILON) return [note];
    return [{ ...note, duration: boundary - note.start }, { ...note, id: generateId(), start: boundary + measure, duration: note.start + note.duration - boundary }];
  });
  const added = session.notes.filter(note => overlaps(note.start, note.duration, source * measure, boundary)).map(note => {
    const start = Math.max(source * measure, note.start);
    return { ...note, id: generateId(), start: boundary + start - source * measure, duration: Math.min(boundary, note.start + note.duration) - start };
  });
  const shiftRange = range => ({ ...range, startBar: range.startBar >= insertion ? range.startBar + 1 : range.startBar, endBar: range.endBar >= insertion ? range.endBar + 1 : range.endBar });
  const patch = {
    bars: session.bars + 1, notes: [...shifted, ...added].sort((a, b) => a.start - b.start),
    loop: shiftRange(session.loop), form: { ...session.form, sections: session.form.sections.map(shiftRange) },
  };
  if (session.drums.edits.length) patch.drums = {
    ...session.drums,
    edits: session.drums.edits.map(edit => edit.start >= boundary ? { ...edit, start: edit.start + measure } : { ...edit }),
  };
  if (session.progression.enabled) {
    const progression = expandedHarmony(session);
    const copied = progression.chords.filter(chord => overlaps(chord.startBar, chord.durationBars, source, insertion)).map(chord => {
      const start = Math.max(source, chord.startBar);
      return { ...cloneChord(chord), startBar: insertion + start - source, durationBars: Math.min(insertion, chord.startBar + chord.durationBars) - start };
    });
    const moved = progression.chords.flatMap(chord => {
      if (chord.startBar >= insertion - EPSILON) return [{ ...chord, startBar: chord.startBar + 1 }];
      if (chord.startBar + chord.durationBars <= insertion + EPSILON) return [chord];
      return [{ ...cloneChord(chord), durationBars: insertion - chord.startBar }, { ...cloneChord(chord), startBar: insertion + 1, durationBars: chord.startBar + chord.durationBars - insertion }];
    });
    patch.progression = { ...progression, cycleBars: progression.cycleBars + 1, chords: [...moved, ...copied].sort((a, b) => a.startBar - b.startBar) };
  }
  return result(session, patch);
}

export function repeatPhraseInNewBars(session, sourceSession) {
  if (session.bars <= sourceSession.bars || ticksPerBar(session) !== ticksPerBar(sourceSession)) return { error: 'O tamanho da frase de origem mudou; aumente os compassos novamente.' };
  const cycle = sourceSession.bars * ticksPerBar(sourceSession); const total = session.bars * ticksPerBar(session);
  const added = [];
  for (let start = cycle; start < total - EPSILON; start += cycle) {
    for (const note of sourceSession.notes) {
      const position = start + note.start;
      if (position < total - EPSILON) added.push({ ...note, id: generateId(), start: position, duration: Math.min(note.duration, total - position) });
    }
  }
  return result(session, { notes: [...session.notes, ...added].sort((a, b) => a.start - b.start) });
}

export function timelineWidth(viewport, session, visibleBars = 4) {
  const available = Math.max(0, viewport - 200);
  const perBar = Math.max(44, available / visibleBars, ticksPerBar(session) * 12);
  return 200 + Math.max(available, perBar * session.bars);
}

export function musicalDuration(ticks, session) {
  const beats = ticks / (16 / session.meter.unit);
  if (Math.abs(ticks - ticksPerBar(session)) < EPSILON) return '1 compasso';
  const value = Math.round(beats * 1000) / 1000;
  return `${value} ${Math.abs(beats - 1) < EPSILON ? 'tempo' : 'tempos'}`;
}
