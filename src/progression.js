import { ticksPerBar, sessionTicks } from './meter.js';

// As 12 classes de altura em cada modo, com grafia tonal (sem duplicar enarmônicos).
const TONICS = {
  major: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'],
  minor: ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'],
};
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NATURAL_PITCHES = [0, 2, 4, 5, 7, 9, 11];
const MODES = {
  major: {
    intervals: [0, 2, 4, 5, 7, 9, 11], qualities: ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7b5'],
    romans: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'viiø'],
    functions: ['tonic', 'subdominant', 'tonic', 'subdominant', 'dominant', 'tonic', 'dominant'],
  },
  minor: {
    intervals: [0, 2, 3, 5, 7, 8, 10], qualities: ['m7', 'm7b5', 'maj7', 'm7', 'm7', 'maj7', '7'],
    romans: ['i', 'iiø', 'III', 'iv', 'v', 'VI', 'VII'],
    functions: ['tonic', 'subdominant', 'tonic', 'subdominant', 'dominant', 'subdominant', 'dominant'],
  },
};

// Qualidades: [semitons, passos de letra] para grafar cada nota do acorde.
export const CHORD_QUALITIES = Object.freeze({
  '': [[0, 0], [4, 2], [7, 4]],
  m: [[0, 0], [3, 2], [7, 4]],
  dim: [[0, 0], [3, 2], [6, 4]],
  aug: [[0, 0], [4, 2], [8, 4]],
  sus2: [[0, 0], [2, 1], [7, 4]],
  sus4: [[0, 0], [5, 3], [7, 4]],
  6: [[0, 0], [4, 2], [7, 4], [9, 5]],
  m6: [[0, 0], [3, 2], [7, 4], [9, 5]],
  maj7: [[0, 0], [4, 2], [7, 4], [11, 6]],
  m7: [[0, 0], [3, 2], [7, 4], [10, 6]],
  7: [[0, 0], [4, 2], [7, 4], [10, 6]],
  m7b5: [[0, 0], [3, 2], [6, 4], [10, 6]],
  dim7: [[0, 0], [3, 2], [6, 4], [9, 6]],
  mMaj7: [[0, 0], [3, 2], [7, 4], [11, 6]],
  '7sus4': [[0, 0], [5, 3], [7, 4], [10, 6]],
  add9: [[0, 0], [4, 2], [7, 4], [14, 1]],
  9: [[0, 0], [4, 2], [7, 4], [10, 6], [14, 1]],
  m9: [[0, 0], [3, 2], [7, 4], [10, 6], [14, 1]],
  maj9: [[0, 0], [4, 2], [7, 4], [11, 6], [14, 1]],
  '7b9': [[0, 0], [4, 2], [7, 4], [10, 6], [13, 1]],
  '7#9': [[0, 0], [4, 2], [7, 4], [10, 6], [15, 1]],
});

const QUALITY_ALIASES = {
  '': '', M: '', maj: '', m: 'm', '-': 'm', min: 'm', dim: 'dim', '°': 'dim', o: 'dim', aug: 'aug', '+': 'aug',
  sus: 'sus4', sus4: 'sus4', sus2: 'sus2', 6: '6', m6: 'm6', '-6': 'm6',
  maj7: 'maj7', M7: 'maj7', '7M': 'maj7', 'Δ': 'maj7', 'Δ7': 'maj7', m7: 'm7', '-7': 'm7', min7: 'm7', 7: '7',
  m7b5: 'm7b5', '-7b5': 'm7b5', 'ø': 'm7b5', 'ø7': 'm7b5', dim7: 'dim7', '°7': 'dim7', o7: 'dim7',
  mMaj7: 'mMaj7', 'm(maj7)': 'mMaj7', 'mM7': 'mMaj7', '-Δ7': 'mMaj7', '7sus4': '7sus4', '7sus': '7sus4',
  add9: 'add9', 9: '9', m9: 'm9', '-9': 'm9', maj9: 'maj9', 'Δ9': 'maj9', '7b9': '7b9', '7#9': '7#9',
};

export const CHORD_FUNCTIONS = Object.freeze(['tonic', 'subdominant', 'dominant', 'other']);
export const CHORD_SOURCES = Object.freeze(['diatonic', 'borrowed', 'secondary', 'custom']);
export const FUNCTION_LABELS = Object.freeze({ tonic: 'Tônica', subdominant: 'Subdominante', dominant: 'Dominante', other: 'Outra' });
export const SOURCE_LABELS = Object.freeze({ diatonic: 'Diatônico', borrowed: 'Empréstimo modal', secondary: 'Dominante secundária', custom: 'Personalizado' });

const CHORD_LOW = 48; // C3: base das vozes fechadas
const VOICE_RANGE = [48, 79];

export const PROGRESSION_KEYS = Object.freeze(Object.entries(TONICS).flatMap(([mode, tonics]) => tonics.map((tonic, pitchClass) => Object.freeze({
  id: `${tonic[0].toLowerCase()}${tonic.slice(1) === '#' ? '-sharp' : tonic.slice(1) === 'b' ? '-flat' : ''}-${mode}`,
  tonic, pitchClass, mode, label: `${tonic} ${mode === 'major' ? 'maior' : 'menor natural'}`,
}))));

export function findKey(keyId) {
  const key = PROGRESSION_KEYS.find(item => item.id === keyId);
  if (!key) throw new TypeError('Escolha uma das 24 tonalidades maiores ou menores naturais.');
  return key;
}

function spell(letterIndex, pitchClass) {
  let accidental = (pitchClass - NATURAL_PITCHES[letterIndex] + 12) % 12;
  if (accidental > 6) accidental -= 12;
  return LETTERS[letterIndex] + (accidental < 0 ? 'b'.repeat(-accidental) : '#'.repeat(accidental));
}

function parseNoteName(name) {
  const match = /^([A-G])(#{1,2}|b{1,2})?$/.exec(name);
  if (!match) return null;
  const letterIndex = LETTERS.indexOf(match[1]);
  const accidental = match[2] ? (match[2][0] === '#' ? match[2].length : -match[2].length) : 0;
  return { letterIndex, pitchClass: (NATURAL_PITCHES[letterIndex] + accidental + 12) % 12 };
}

// Acorde em posição fechada a partir de uma fundamental grafada.
function makeChord({ rootName, quality, roman = '', degree = null, fn = 'other', source = 'custom', bassName = null }) {
  const root = parseNoteName(rootName);
  const rootMidi = CHORD_LOW + root.pitchClass;
  const notes = CHORD_QUALITIES[quality].map(([semitones, steps]) => ({
    name: spell((root.letterIndex + steps) % 7, (root.pitchClass + semitones) % 12),
    midi: rootMidi + semitones,
  }));
  const bass = bassName ? parseNoteName(bassName) : null;
  const chord = {
    symbol: `${rootName}${quality}${bassName ? `/${bassName}` : ''}`,
    roman, quality, degree, root: root.pitchClass, bass: bass ? bass.pitchClass : null,
    function: fn, source, inversion: 0, durationBars: 1, notes,
  };
  if (bass && bass.pitchClass !== root.pitchClass) {
    const tone = notes.findIndex(note => note.midi % 12 === bass.pitchClass);
    if (tone > 0) return invertChord(chord, tone);
    chord.notes = [{ name: bassName, midi: CHORD_LOW - 12 + bass.pitchClass }, ...notes];
  }
  return chord;
}

function keyScale(key) {
  const { intervals } = MODES[key.mode];
  const firstLetter = LETTERS.indexOf(key.tonic[0]);
  return intervals.map((interval, degree) => {
    const letterIndex = (firstLetter + degree) % LETTERS.length;
    const pitchClass = (key.pitchClass + interval) % 12;
    return { name: spell(letterIndex, pitchClass), letterIndex, pitchClass, midi: CHORD_LOW + key.pitchClass + interval };
  });
}

export function getDiatonicChords(keyId) {
  const key = findKey(keyId);
  const { qualities, romans, functions } = MODES[key.mode];
  const scale = keyScale(key);
  return scale.map((root, degree) => ({
    degree: degree + 1, roman: romans[degree], quality: qualities[degree], symbol: root.name + qualities[degree],
    root: root.pitchClass, bass: null, function: functions[degree], source: 'diatonic', inversion: 0, durationBars: 1,
    notes: [0, 2, 4, 6].map(offset => {
      const index = degree + offset;
      const note = scale[index % 7];
      return { name: note.name, midi: note.midi + 12 * Math.floor(index / 7) };
    }),
  }));
}

// Empréstimos do modo paralelo (maior <-> menor) mais usados em música popular.
const BORROWED = {
  major: [
    { offset: 5, letter: 3, quality: 'm7', roman: 'iv', fn: 'subdominant' },
    { offset: 8, letter: 5, quality: 'maj7', roman: '♭VI', fn: 'subdominant' },
    { offset: 10, letter: 6, quality: '7', roman: '♭VII', fn: 'dominant' },
    { offset: 3, letter: 2, quality: 'maj7', roman: '♭III', fn: 'tonic' },
    { offset: 2, letter: 1, quality: 'm7b5', roman: 'iiø', fn: 'subdominant' },
  ],
  minor: [
    { offset: 7, letter: 4, quality: '7', roman: 'V7', fn: 'dominant' },
    { offset: 11, letter: 6, quality: 'dim7', roman: 'vii°7', fn: 'dominant' },
    { offset: 5, letter: 3, quality: '7', roman: 'IV7', fn: 'subdominant' },
    { offset: 2, letter: 1, quality: 'm7', roman: 'ii', fn: 'subdominant' },
    { offset: 0, letter: 0, quality: 'maj7', roman: 'I', fn: 'tonic' },
  ],
};

export function getBorrowedChords(keyId) {
  const key = findKey(keyId);
  const tonicLetter = LETTERS.indexOf(key.tonic[0]);
  return BORROWED[key.mode].map(entry => makeChord({
    rootName: spell((tonicLetter + entry.letter) % 7, (key.pitchClass + entry.offset) % 12),
    quality: entry.quality, roman: entry.roman, fn: entry.fn, source: 'borrowed',
  }));
}

// V7 de cada grau diatônico maior/menor (não do I nem de acordes diminutos).
export function getSecondaryDominants(keyId) {
  const key = findKey(keyId);
  const scale = keyScale(key);
  const { qualities, romans } = MODES[key.mode];
  return scale.flatMap((target, degree) => {
    if (degree === 0 || qualities[degree] === 'm7b5') return [];
    return [makeChord({
      rootName: spell((target.letterIndex + 4) % 7, (target.pitchClass + 7) % 12),
      quality: '7', roman: `V7/${romans[degree]}`, degree: null, fn: 'dominant', source: 'secondary',
    })];
  });
}

// Cifra livre: fundamental, qualidade e baixo opcional (ex.: "Bb7/D", "F#ø", "Ebmaj9").
export function parseChordSymbol(text) {
  if (typeof text !== 'string') throw new TypeError('Digite uma cifra, por exemplo Cmaj7 ou G7/B.');
  const normalized = text.trim().replaceAll('♯', '#').replaceAll('♭', 'b');
  const match = /^([A-G](?:#|b)?)([^/]*)(?:\/([A-G](?:#|b)?))?$/.exec(normalized);
  const quality = match && Object.hasOwn(QUALITY_ALIASES, match[2]) ? QUALITY_ALIASES[match[2]] : undefined;
  if (!match || quality === undefined) {
    throw new TypeError(`Cifra não reconhecida: "${text.trim().slice(0, 24)}". Use, por exemplo, C, Am7, F#ø, Bb7/D.`);
  }
  return makeChord({ rootName: match[1], quality, bassName: match[3] ?? null });
}

// Um baixo de barra estranho ao acorde (ex.: C/D) fica isolado em notes[0].
function hasForeignBass(chord) {
  return chord.bass !== null && chord.bass !== undefined && chord.notes.length > 1
    && chord.notes[0].midi % 12 === chord.bass && !isChordTone(chord, chord.bass);
}

function upperNotes(chord) {
  return hasForeignBass(chord) ? chord.notes.slice(1) : chord.notes;
}

// Tons do acorde (sem baixo de barra estranho ao acorde), em ordem a partir da fundamental.
function chordTones(chord) {
  const foreignBass = hasForeignBass(chord);
  const names = new Map();
  for (const note of foreignBass ? chord.notes.slice(1) : chord.notes) {
    const pc = note.midi % 12;
    if (!names.has(pc)) names.set(pc, note.name);
  }
  const intervals = Object.hasOwn(CHORD_QUALITIES, chord.quality) ? CHORD_QUALITIES[chord.quality] : null;
  const order = pc => intervals
    ? intervals.findIndex(([semitones]) => (chord.root + semitones) % 12 === pc)
    : (pc - chord.root + 12) % 12;
  const tones = [...names.entries()]
    .map(([pc, name]) => ({ pc, name }))
    .sort((a, b) => order(a.pc) - order(b.pc));
  return { tones, foreignBass };
}

function isChordTone(chord, pc) {
  const intervals = Object.hasOwn(CHORD_QUALITIES, chord.quality) ? CHORD_QUALITIES[chord.quality] : null;
  if (!intervals) return true;
  return intervals.some(([semitones]) => (chord.root + semitones) % 12 === pc);
}

function stackFrom(tones, inversion, lowestMidi) {
  const ordered = [...tones.slice(inversion), ...tones.slice(0, inversion)];
  const notes = [];
  let previous = lowestMidi - 1;
  for (const tone of ordered) {
    let midi = previous + 1 + ((tone.pc - (previous + 1)) % 12 + 12) % 12;
    if (notes.length === 0) midi = lowestMidi + ((tone.pc - lowestMidi) % 12 + 12) % 12;
    notes.push({ name: tone.name, midi });
    previous = midi;
  }
  return notes;
}

// Inversão em posição fechada com o baixo a partir de C3 (48..59).
export function invertChord(chord, inversion) {
  const { tones, foreignBass } = chordTones(chord);
  if (!Number.isInteger(inversion) || inversion < 0 || inversion >= tones.length) {
    throw new TypeError(`A inversão deve estar entre 0 e ${tones.length - 1}.`);
  }
  const notes = stackFrom(tones, inversion, CHORD_LOW);
  const bassNote = foreignBass ? [{ name: chord.notes[0].name, midi: CHORD_LOW - 12 + chord.bass }] : [];
  // Uma inversão manual de cifra com baixo de acorde atualiza também o
  // baixo explícito; um pedal estranho ao acorde continua independente.
  const slash = !foreignBass && chord.bass !== null && chord.bass !== undefined;
  const bass = slash ? notes[0].midi % 12 : chord.bass;
  const symbol = slash ? `${chord.symbol.split('/')[0]}/${notes[0].name}` : chord.symbol;
  return { ...chord, symbol, bass, inversion, notes: [...bassNote, ...notes] };
}

function voicingDistance(from, to) {
  const near = (source, targets) => source.reduce((sum, midi) => sum + Math.min(...targets.map(target => Math.abs(target - midi))), 0);
  const a = from.map(note => note.midi);
  const b = to.map(note => note.midi);
  return near(a, b) + near(b, a);
}

// Condução de vozes: mantém o primeiro acorde e escolhe, para cada seguinte,
// a inversão/oitava em posição fechada com menor movimento total, dentro de C3..G5.
export function voiceProgression(chords) {
  if (!Array.isArray(chords)) throw new TypeError('Informe uma lista de acordes.');
  const voiced = [];
  for (const chord of chords) {
    const previous = voiced.at(-1);
    if (!previous) {
      voiced.push({ ...chord, notes: chord.notes.map(note => ({ ...note })) });
      continue;
    }
    const { tones, foreignBass } = chordTones(chord);
    const fixedBass = !foreignBass && chord.bass !== null && chord.bass !== undefined;
    const upper = upperNotes(previous);
    let best = null;
    for (let inversion = 0; inversion < tones.length; inversion += 1) {
      if (fixedBass && tones[inversion].pc !== chord.bass) continue;
      for (let octave = -12; octave <= 12; octave += 12) {
        const notes = stackFrom(tones, inversion, CHORD_LOW + octave);
        if (notes[0].midi < VOICE_RANGE[0] - 5 || notes.at(-1).midi > VOICE_RANGE[1]) continue;
        const distance = voicingDistance(upper, notes);
        if (!best || distance < best.distance) best = { distance, inversion, notes };
      }
    }
    const bassNote = foreignBass ? [{ name: chord.notes[0].name, midi: CHORD_LOW - 12 + chord.bass }] : [];
    voiced.push({ ...chord, inversion: best.inversion, notes: [...bassNote, ...best.notes] });
  }
  return voiced;
}

// Pesos por função harmônica: o gerador caminha T -> S -> D -> T com desvios.
const FUNCTION_STEPS = {
  tonic: [['subdominant', 0.5], ['dominant', 0.3], ['tonic', 0.2]],
  subdominant: [['dominant', 0.6], ['subdominant', 0.2], ['tonic', 0.2]],
  dominant: [['tonic', 0.8], ['dominant', 0.1], ['subdominant', 0.1]],
};
const DEGREE_WEIGHTS = {
  major: { tonic: [[0, 0.6], [5, 0.3], [2, 0.1]], subdominant: [[3, 0.5], [1, 0.5]], dominant: [[4, 0.8], [6, 0.2]] },
  minor: { tonic: [[0, 0.65], [2, 0.35]], subdominant: [[3, 0.5], [1, 0.25], [5, 0.25]], dominant: [[6, 0.4], [4, 0.6]] },
};

function pickWeighted(entries, value) {
  let target = value * entries.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [item, weight] of entries) {
    target -= weight;
    if (target < 0) return item;
  }
  return entries.at(-1)[0];
}

// Progressão orientada por função: começa na tônica e termina em uma função
// que volta à tônica (dominante, ou subdominante para cadência plagal), para
// que o loop resolva. borrowed/secondary (0..1) colorem com empréstimos modais
// e dominantes secundárias. harmonicRhythm = compassos por acorde.
export function generateProgression(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Informe as opções da progressão.');
  }
  const { keyId, random = Math.random, length, borrowed = 0, secondary = 0, harmonicRhythm = 1 } = options;
  const key = findKey(keyId);
  if (typeof random !== 'function') throw new TypeError('A fonte aleatória deve ser uma função.');
  const draw = () => {
    const value = random();
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
      throw new TypeError('A fonte aleatória deve retornar um número entre 0 (inclusive) e 1 (exclusive).');
    }
    return value;
  };
  for (const [name, value] of [['borrowed', borrowed], ['secondary', secondary]]) {
    if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw new TypeError(`A opção ${name} deve estar entre 0 e 1.`);
  }
  if (![0.5, 1, 2].includes(harmonicRhythm)) throw new TypeError('O ritmo harmônico deve ser 0.5, 1 ou 2 compassos por acorde.');
  const count = length === undefined ? 2 + Math.floor(draw() * 4) : length;
  if (!Number.isInteger(count) || count < 2 || count > 16) throw new TypeError('A progressão deve ter de 2 a 16 acordes.');

  const diatonic = getDiatonicChords(keyId);
  const borrowedChords = getBorrowedChords(keyId);
  const secondaries = getSecondaryDominants(keyId);
  const weights = DEGREE_WEIGHTS[key.mode];
  const functions = ['tonic'];
  for (let index = 1; index < count; index += 1) {
    const last = index === count - 1;
    const options = last
      ? (functions[index - 1] === 'dominant' ? [['dominant', 0.6], ['subdominant', 0.4]] : [['dominant', 0.8], ['subdominant', 0.2]])
      : FUNCTION_STEPS[functions[index - 1]];
    functions.push(pickWeighted(options, draw()));
  }
  let previousDegree = null;
  const chords = functions.map((fn, index) => {
    let degree = index === 0 ? 0 : pickWeighted(weights[fn], draw());
    // Evita repetir o mesmo grau em sequência quando a função oferece alternativa.
    if (degree === previousDegree && weights[fn].length > 1) {
      degree = weights[fn].map(([item]) => item).find(item => item !== previousDegree);
    }
    previousDegree = degree;
    let chord = diatonic[degree];
    if (index > 0 && borrowed > 0 && draw() < borrowed) {
      const candidates = borrowedChords.filter(item => item.function === fn);
      if (candidates.length) chord = candidates[Math.floor(draw() * candidates.length)];
    }
    return { ...chord, notes: chord.notes.map(note => ({ ...note })), durationBars: harmonicRhythm };
  });
  if (secondary > 0) {
    for (let index = 1; index < chords.length; index += 1) {
      const target = chords[index];
      const dominant = secondaries.find(item => item.roman === `V7/${target.roman}`);
      if (dominant && index - 1 > 0 && draw() < secondary) {
        chords[index - 1] = { ...dominant, notes: dominant.notes.map(note => ({ ...note })), durationBars: harmonicRhythm };
      }
    }
  }
  return { keyId, chords: voiceProgression(chords), enabled: true };
}

// Linha do tempo harmônica: os acordes se repetem em ciclo até cobrir a sessão.
export function chordTimeline(session) {
  const { progression } = session;
  if (!progression || !progression.enabled || progression.chords.length === 0) return [];
  const barTicks = ticksPerBar(session);
  const total = sessionTicks(session);
  const events = [];
  let cursor = 0;
  while (cursor < total - 1e-6) {
    for (const [index, chord] of progression.chords.entries()) {
      if (cursor >= total - 1e-6) break;
      const duration = chord.durationBars * barTicks;
      events.push({ start: cursor, duration: Math.min(duration, total - cursor), chord, index });
      cursor += duration;
    }
  }
  return events;
}
