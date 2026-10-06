// Sounding MIDI, low → high. Conventional string 1 is the highest string.
const STANDARD = Object.freeze({
  guitar: Object.freeze([40, 45, 50, 55, 59, 64]),
  bass4: Object.freeze([28, 33, 38, 43]),
  bass5: Object.freeze([23, 28, 33, 38, 43]),
});
const LETTERS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const SOLFEGE = ['Dó', 'Dó♯', 'Ré', 'Ré♯', 'Mi', 'Fá', 'Fá♯', 'Sol', 'Sol♯', 'Lá', 'Lá♯', 'Si'];
// Grafia bemol, para tonalidades/ciclos que pedem bemóis (ex.: ciclo de quartas) sem duplicar enarmônicos.
const LETTERS_FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const SOLFEGE_FLAT = ['Dó', 'Ré♭', 'Ré', 'Mi♭', 'Mi', 'Fá', 'Sol♭', 'Sol', 'Lá♭', 'Lá', 'Si♭', 'Si'];
const FIELDS = ['type', 'strings', 'tuning', 'noteNames'];

export function standardInstrumentProfile(type = 'guitar', strings = type === 'bass' ? 4 : 6) {
  const tuning = STANDARD[type === 'guitar' ? 'guitar' : `bass${strings}`];
  if (!tuning || !['guitar', 'bass'].includes(type) || (type === 'guitar' && strings !== 6)) throw new TypeError('Instrumento ou número de cordas inválido.');
  return { type, strings, tuning: [...tuning], noteNames: 'letters' };
}

export function normalizeInstrumentProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !FIELDS.includes(key))
    || FIELDS.some(key => !Object.hasOwn(value, key))) throw new TypeError('O perfil do instrumento deve conter tipo, cordas, afinação e nomes das notas.');
  const { type, strings, tuning, noteNames } = value;
  if (!['guitar', 'bass'].includes(type) || (type === 'guitar' ? strings !== 6 : ![4, 5].includes(strings))) throw new TypeError('Guitarra usa 6 cordas; baixo usa 4 ou 5.');
  if (!Array.isArray(tuning) || tuning.length !== strings || tuning.some((pitch, index) => !Number.isInteger(pitch) || pitch < 0 || pitch > 127 || (index > 0 && pitch <= tuning[index - 1]))) throw new TypeError('A afinação deve conter uma altura MIDI por corda, da mais grave à mais aguda, em ordem crescente (0–127).');
  if (!['letters', 'solfege'].includes(noteNames)) throw new TypeError('Escolha nomes C D E ou Dó Ré Mi.');
  return { type, strings, tuning: [...tuning], noteNames };
}

export function getInstrumentProfile(session) {
  const value = session?.extensions?.studio?.instrument;
  return value === undefined ? standardInstrumentProfile() : normalizeInstrumentProfile(value);
}

export function formatInstrumentNote(pitch, profile, { octave = true, flats = false } = {}) {
  const names = profile?.noteNames === 'solfege'
    ? (flats ? SOLFEGE_FLAT : SOLFEGE)
    : (flats ? LETTERS_FLAT : LETTERS);
  return `${names[((pitch % 12) + 12) % 12]}${octave ? Math.floor(pitch / 12) - 1 : ''}`;
}

// Named-note input also accepts flats and Portuguese spelling; octaves are required.
export function parseInstrumentNote(text) {
  const match = String(text).trim().match(/^(C|D|E|F|G|A|B|Dó|Do|Ré|Re|Mi|Fá|Fa|Sol|Lá|La|Si)([#♯b♭]?)(-?\d+)$/i);
  if (!match) throw new TypeError('Use uma nota com oitava, por exemplo E2, Dó♯2 ou Si♭1.');
  const roots = { c: 0, dó: 0, do: 0, d: 2, ré: 2, re: 2, e: 4, mi: 4, f: 5, fá: 5, fa: 5, g: 7, sol: 7, a: 9, lá: 9, la: 9, b: 11, si: 11 };
  const accidental = ['#', '♯'].includes(match[2]) ? 1 : ['b', '♭'].includes(match[2]) ? -1 : 0;
  const pitch = (Number(match[3]) + 1) * 12 + roots[match[1].toLowerCase()] + accidental;
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) throw new RangeError('Nota fora do intervalo MIDI 0–127.');
  return pitch;
}

export function instrumentTuning(profile, preset = 'standard') {
  const tuning = standardInstrumentProfile(profile.type, profile.strings).tuning;
  if (preset === 'half-down') return tuning.map(pitch => pitch - 1);
  if (preset === 'drop-d') { tuning[profile.type === 'bass' && profile.strings === 5 ? 1 : 0] -= 2; return tuning; }
  if (preset !== 'standard') throw new TypeError('Afinação desconhecida.');
  return tuning;
}

export function instrumentInputPitch(profile) { return profile.type === 'bass' ? 28 : 52; }

export function getInstrumentClef(profile) {
  return profile.type === 'bass' ? { sign: 'F', line: 4, octaveChange: -1 } : { sign: 'G', line: 2, octaveChange: -1 };
}
