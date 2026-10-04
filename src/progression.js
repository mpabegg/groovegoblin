// As 12 classes de altura em cada modo, com grafia tonal (sem duplicar enarmônicos).
const TONICS = {
  major: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'],
  minor: ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'],
};
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NATURAL_PITCHES = [0, 2, 4, 5, 7, 9, 11];
const MODES = {
  major: { intervals: [0, 2, 4, 5, 7, 9, 11], qualities: ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7b5'], romans: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'viiø'] },
  minor: { intervals: [0, 2, 3, 5, 7, 8, 10], qualities: ['m7', 'm7b5', 'maj7', 'm7', 'm7', 'maj7', '7'], romans: ['i', 'iiø', 'III', 'iv', 'v', 'VI', 'VII'] },
};

export const PROGRESSION_KEYS = Object.freeze(Object.entries(TONICS).flatMap(([mode, tonics]) => tonics.map((tonic, pitchClass) => Object.freeze({
  id: `${tonic[0].toLowerCase()}${tonic.slice(1) === '#' ? '-sharp' : tonic.slice(1) === 'b' ? '-flat' : ''}-${mode}`,
  tonic, pitchClass, mode, label: `${tonic} ${mode === 'major' ? 'maior' : 'menor natural'}`,
}))));

function findKey(keyId) {
  const key = PROGRESSION_KEYS.find(item => item.id === keyId);
  if (!key) throw new TypeError('Escolha uma das 24 tonalidades maiores ou menores naturais.');
  return key;
}

export function getDiatonicChords(keyId) {
  const key = findKey(keyId);
  const { intervals, qualities, romans } = MODES[key.mode];
  const firstLetter = LETTERS.indexOf(key.tonic[0]);
  const scale = intervals.map((interval, degree) => {
    const letterIndex = (firstLetter + degree) % LETTERS.length;
    const pitchClass = (key.pitchClass + interval) % 12;
    let accidental = (pitchClass - NATURAL_PITCHES[letterIndex] + 12) % 12;
    if (accidental > 6) accidental -= 12;
    const name = LETTERS[letterIndex] + (accidental < 0 ? 'b'.repeat(-accidental) : '#'.repeat(accidental));
    return { name, midi: 48 + key.pitchClass + interval };
  });
  return scale.map((root, degree) => ({
    degree: degree + 1, roman: romans[degree], quality: qualities[degree], symbol: root.name + qualities[degree],
    notes: [0, 2, 4, 6].map(offset => {
      const index = degree + offset;
      const note = scale[index % 7];
      return { name: note.name, midi: note.midi + 12 * Math.floor(index / 7) };
    }),
  }));
}

// Cada sorteio é independente: repetições (inclusive acordes vizinhos iguais) são válidas.
// A fonte injetável permite testar os limites sem semente ou estado persistido na UI.
export function generateProgression(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Informe as opções da progressão.');
  }
  const { keyId, random = Math.random } = options;
  const diatonic = getDiatonicChords(keyId);
  if (typeof random !== 'function') throw new TypeError('A fonte aleatória deve ser uma função.');
  const draw = count => {
    const value = random();
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
      throw new TypeError('A fonte aleatória deve retornar um número entre 0 (inclusive) e 1 (exclusive).');
    }
    return Math.floor(value * count);
  };
  const length = 2 + draw(4);
  const chords = Array.from({ length }, () => {
    const chord = diatonic[draw(7)];
    return { ...chord, notes: chord.notes.map(note => ({ ...note })) };
  });
  return { keyId, chords };
}
