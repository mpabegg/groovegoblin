import { getInstrumentProfile } from './instrument-profile.js';

export const MAX_TAB_FRET = 24;
export const TAB_DIGIT_WINDOW_MS = 600;
export const phraseView = session => session?.extensions?.studio?.phraseView === 'tab' ? 'tab' : 'rhythm';
const physicalString = (string, profile) => Number.isInteger(string) && string >= 1 && string <= profile.strings;
export const stringPitch = (profile, string) => physicalString(string, profile) ? profile.tuning[profile.strings - string] : null;
export const validTabFret = fret => Number.isInteger(fret) && fret >= 0 && fret <= MAX_TAB_FRET;

// MIDI is the source of truth. Missing assignments are derived, never persisted on load.
// Prefer an authored playable position, then the smallest fret (higher string breaks ties).
export function resolveTabPosition(note, profile) {
  const assigned = stringPitch(profile, note.string);
  if (assigned !== null && validTabFret(note.pitch - assigned)) return { string: note.string, fret: note.pitch - assigned, playable: true, explicit: true };
  let best = null;
  for (let string = 1; string <= profile.strings; string += 1) {
    const fret = note.pitch - stringPitch(profile, string);
    if (validTabFret(fret) && (!best || fret < best.fret)) best = { string, fret, playable: true, explicit: false };
  }
  if (best) return best;
  const string = physicalString(note.string, profile) ? note.string : 1;
  return { string, fret: note.pitch - stringPitch(profile, string), playable: false, explicit: physicalString(note.string, profile) };
}

// Return a complete group plan or null: impossible string moves must not partially edit.
export function tabStringPatches(notes, ids, delta, profile) {
  const patches = new Map(); const chosen = new Set(ids);
  for (const note of notes) {
    if (!chosen.has(note.id)) continue;
    const string = resolveTabPosition(note, profile).string + delta;
    const open = stringPitch(profile, string);
    if (open === null || !validTabFret(note.pitch - open)) return null;
    patches.set(note.id, { string });
  }
  return patches;
}

export function tabFretPatches(notes, ids, fret, profile) {
  if (!validTabFret(fret)) return null;
  const patches = new Map(); const chosen = new Set(ids);
  for (const note of notes) {
    if (!chosen.has(note.id)) continue;
    const string = resolveTabPosition(note, profile).string;
    const pitch = stringPitch(profile, string) + fret;
    if (pitch > 127) return null;
    patches.set(note.id, { string, pitch });
  }
  return patches;
}

export function octaveToFitPatch(note, profile) {
  if (resolveTabPosition(note, profile).playable) return {};
  for (let distance = 1; distance <= 10; distance += 1) {
    for (const octaves of [-distance, distance]) {
      const pitch = note.pitch + octaves * 12;
      if (pitch < 0 || pitch > 127) continue;
      const position = resolveTabPosition({ ...note, pitch }, profile);
      if (position.playable) return { pitch, ...(Object.hasOwn(note, 'string') ? { string: position.string } : {}) };
    }
  }
  return {};
}

// Scope includes the focused selection; a new note/view/selection breaks a digit pair.
export function tabDigit(previous, digit, time, scope) {
  const pair = previous && previous.scope === scope && time - previous.time <= TAB_DIGIT_WINDOW_MS && time >= previous.time
    ? previous.fret * 10 + digit : -1;
  const combined = previous?.fret >= 1 && previous.fret <= 2 && validTabFret(pair);
  const fret = combined ? pair : digit;
  return { fret, time, scope, paired: !!combined };
}

export function tabStringAtPointer(grid, clientY, profile) {
  const box = grid.getBoundingClientRect();
  return Math.max(1, Math.min(profile.strings, Math.floor((clientY - box.top) / box.height * profile.strings) + 1));
}

export function mountPhraseView(host) {
  const select = document.getElementById('phrase-view');
  select.addEventListener('change', () => host.updateSession({ extensions: { studio: { phraseView: select.value } } }));
  return () => {
    const session = host.getSession(); const profile = getInstrumentProfile(session);
    select.value = phraseView(session);
    const grid = document.getElementById('grid'); grid.classList.toggle('tab-view', select.value === 'tab');
    grid.style.setProperty('--tab-strings', profile.strings);
    const track = document.getElementById('track-phrase'); track.classList.toggle('phrase-tab', select.value === 'tab');
    track.style.setProperty('--tab-strings', profile.strings);
    const lines = document.getElementById('tab-strings'); lines.replaceChildren();
    if (select.value !== 'tab') return;
    for (let string = 1; string <= profile.strings; string += 1) {
      const line = document.createElement('span'); line.className = 'tab-string'; line.dataset.string = string;
      line.style.top = `${(string - 0.5) / profile.strings * 100}%`; lines.append(line);
    }
  };
}
