import { generateBass } from './band.js';
import { completeNote, validPhrase } from './model.js';
import { EPSILON, ticksPerBar } from './meter.js';
import { getInstrumentProfile, standardInstrumentProfile } from './instrument-profile.js';
import { instrumentChangePatch } from './studio-instrument.js';
import { mergeSession } from './studio-state.js';
import { validateSession, STYLES, DENSITIES } from './session.js';

// Inverse of meter.performTick, including straight incomplete pairs in odd meters.
// Transform both endpoints: offsets alone would change sustain lengths and depend on BPM.
export function unperformTick(session, tick) {
  if (!session.swing) return tick;
  const measure = ticksPerBar(session);
  const bar = Math.floor((tick + EPSILON) / measure);
  const local = tick - bar * measure;
  const period = session.swingUnit === 'sixteenth' ? 2 : 4;
  const base = Math.floor((local + EPSILON) / period) * period;
  if (base + period > measure + EPSILON) return tick;
  const half = period / 2;
  const x = local - base;
  const split = half * (1 + session.swing);
  return bar * measure + base + (x < split ? x / (1 + session.swing) : half + (x - split) / (1 - session.swing));
}

export function playablePitch(pitch, profile) {
  return profile.tuning.some(open => pitch >= open && pitch <= Math.min(127, open + 24));
}

// New material only: nearest playable octave, lower pitch wins a tie. Never change pitch class.
export function foldGeneratedPitch(pitch, profile) {
  let best = null;
  for (let candidate = pitch % 12; candidate <= 127; candidate += 12) {
    if (playablePitch(candidate, profile) && (best === null || Math.abs(candidate - pitch) < Math.abs(best - pitch))) best = candidate;
  }
  if (best === null) throw new RangeError('Esta afinação não oferece uma oitava tocável da nota gerada entre as casas 0 e 24. Nenhuma nota foi removida.');
  return best;
}

export function bassOverlapCount(source) {
  return source.filter((note, index) => source[index + 1] && note.start + note.duration > source[index + 1].start + EPSILON).length;
}

export function bassPhraseNotes(session, source = generateBass(session), { fold = false, profile = getInstrumentProfile(session) } = {}) {
  const straightBass = ['shuffle', 'jazz'].includes(session.band.style);
  const notes = source.map((note, index) => {
    // The legacy accompaniment may overlap (jazz ornaments). Adapt only the editable copy.
    const end = Math.min(note.start + note.duration, source[index + 1]?.start ?? Infinity);
    const start = straightBass ? unperformTick(session, note.start) : note.start;
    const finish = straightBass ? unperformTick(session, end) : end;
    return completeNote({ ...note, id: `bass-study-${index}`, start, duration: finish - start,
      pitch: fold ? foldGeneratedPitch(note.pitch, profile) : note.pitch });
  });
  if (!validPhrase(notes, session)) throw new RangeError('A linha de baixo não cabe numa frase monofônica válida. A frase original foi preservada.');
  return notes;
}

function checkedPatch(session, patch) {
  const checked = validateSession(mergeSession(session, patch));
  if (!checked.ok) throw new RangeError(`Linha não aplicada: ${checked.error}`);
  return patch;
}

export function generatedBassPhrasePatch(session, { style = session.band.style, density = session.band.density } = {}) {
  if (!STYLES.includes(style) || !DENSITIES.includes(density)) throw new TypeError('Escolha um estilo e uma densidade de baixo válidos.');
  const profile = getInstrumentProfile(session);
  if (profile.type !== 'bass') throw new TypeError('Gerar linha de baixo requer o perfil Baixo.');
  const sourceSession = { ...session, band: { ...session.band, style, density } };
  const notes = bassPhraseNotes(sourceSession, generateBass(sourceSession), { fold: true, profile });
  return checkedPatch(session, { notes });
}

export function studyBassLinePatch(session) {
  const previous = getInstrumentProfile(session);
  const profile = previous.type === 'bass' ? previous : { ...standardInstrumentProfile('bass'), noteNames: previous.noteNames };
  const patch = instrumentChangePatch(session, profile, 'keep');
  patch.notes = bassPhraseNotes(session, generateBass(session), { profile });
  patch.band = { ...patch.band, bassEnabled: false };
  patch.timbres = { ...patch.timbres, phrase: session.timbres.bass };
  return checkedPatch(session, patch);
}

export function bassStudyNotice(patch, profile, copied = false, shortened = 0) {
  const outside = patch.notes.filter(note => !playablePitch(note.pitch, profile)).length;
  return `${copied ? 'Linha real de baixo copiada; perfil Baixo e acompanhamento de baixo desligado' : 'Linha de baixo gerada na frase; oitavas ajustadas somente quando necessário às cordas atuais (casas 0–24)'}. ${outside ? `${outside} notas fora do alcance foram mantidas sem transposição. ` : ''}${shortened ? `${shortened} sustentações sobrepostas encurtadas até o próximo ataque para manter a frase monofônica. ` : ''}Ataques e swing preservados, sem aplicar swing duas vezes no shuffle/jazz.`;
}

// Exposed for degree recipes: notes with explicit rhythmic swing already encode their performed timing.
export function encodePerformedNote(session, note) {
  const start = unperformTick(session, note.start);
  return { ...note, start, duration: unperformTick(session, note.start + note.duration) - start };
}
