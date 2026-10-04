import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROGRESSION_KEYS, getDiatonicChords, generateProgression } from '../src/progression.js';

const SCALES = {
  major: ['C D E F G A B', 'Db Eb F Gb Ab Bb C', 'D E F# G A B C#', 'Eb F G Ab Bb C D', 'E F# G# A B C# D#', 'F G A Bb C D E', 'F# G# A# B C# D# E#', 'G A B C D E F#', 'Ab Bb C Db Eb F G', 'A B C# D E F# G#', 'Bb C D Eb F G A', 'B C# D# E F# G# A#'],
  minor: ['C D Eb F G Ab Bb', 'C# D# E F# G# A B', 'D E F G A Bb C', 'Eb F Gb Ab Bb Cb Db', 'E F# G A B C D', 'F G Ab Bb C Db Eb', 'F# G# A B C# D E', 'G A Bb C D Eb F', 'G# A# B C# D# E F#', 'A B C D E F G', 'Bb C Db Eb F Gb Ab', 'B C# D E F# G A'],
};
const SCALE_INTERVALS = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const QUALITIES = { major: ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7b5'], minor: ['m7', 'm7b5', 'maj7', 'm7', 'm7', 'maj7', '7'] };
const CHORD_INTERVALS = { maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], '7': [0, 4, 7, 10], m7b5: [0, 3, 6, 10] };
const ROMANS = { major: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'viiø'], minor: ['i', 'iiø', 'III', 'iv', 'v', 'VI', 'VII'] };

function sequence(values) {
  let cursor = 0;
  return () => {
    assert.ok(cursor < values.length, 'não consome sorteios extras');
    return values[cursor++];
  };
}

test('24 tonalidades: 12 classes de altura por modo, sem enarmônicos duplicados', () => {
  assert.equal(PROGRESSION_KEYS.length, 24);
  assert.equal(new Set(PROGRESSION_KEYS.map(key => key.id)).size, 24);
  assert.ok(Object.isFrozen(PROGRESSION_KEYS));
  for (const mode of ['major', 'minor']) {
    const keys = PROGRESSION_KEYS.filter(key => key.mode === mode);
    assert.deepEqual(keys.map(key => key.pitchClass), Array.from({ length: 12 }, (_, index) => index));
    for (const key of keys) {
      assert.ok(Object.isFrozen(key));
      assert.ok(key.label.includes(mode === 'major' ? 'maior' : 'menor natural'));
    }
  }
});

test('cada tonalidade tem sete tétrades diatônicas com grafia, qualidade e quatro alturas corretas', () => {
  for (const key of PROGRESSION_KEYS) {
    const scale = SCALES[key.mode][key.pitchClass].split(' ');
    const chords = getDiatonicChords(key.id);
    assert.equal(chords.length, 7, key.id);
    for (const [degree, chord] of chords.entries()) {
      assert.equal(chord.degree, degree + 1, key.id);
      assert.equal(chord.quality, QUALITIES[key.mode][degree], key.id);
      assert.equal(chord.roman, ROMANS[key.mode][degree], key.id);
      assert.equal(chord.symbol, scale[degree] + chord.quality, key.id);
      assert.equal(chord.notes.length, 4, key.id);
      assert.deepEqual(chord.notes.map(note => note.name), [0, 2, 4, 6].map(offset => scale[(degree + offset) % 7]), key.id);
      const root = 48 + key.pitchClass + SCALE_INTERVALS[key.mode][degree];
      assert.deepEqual(chord.notes.map(note => note.midi), CHORD_INTERVALS[chord.quality].map(interval => root + interval), key.id);
      assert.equal(new Set(chord.notes.map(note => note.midi % 12)).size, 4, key.id);
      for (const note of chord.notes) {
        assert.ok(Number.isInteger(note.midi) && note.midi >= 48 && note.midi <= 81, key.id);
        assert.ok(SCALE_INTERVALS[key.mode].includes((note.midi - key.pitchClass + 12) % 12), key.id);
      }
    }
  }
});

test('sorteios reproduzíveis em todas as tonalidades, todos os comprimentos e todos os graus', () => {
  for (const key of PROGRESSION_KEYS) {
    const diatonic = getDiatonicChords(key.id);
    for (let length = 2; length <= 5; length += 1) {
      for (let first = 0; first < 7; first += 1) {
        const degrees = Array.from({ length }, (_, index) => (first + index) % 7);
        const draws = [(length - 2) / 4, ...degrees.map(degree => (degree + 0.5) / 7)];
        const options = Object.freeze({ keyId: key.id, random: sequence(draws) });
        const result = generateProgression(options);
        assert.equal(result.keyId, key.id);
        assert.equal(result.chords.length, length);
        assert.deepEqual(result.chords, degrees.map(degree => diatonic[degree]));
        assert.deepEqual(generateProgression({ keyId: key.id, random: sequence(draws) }), result);
      }
    }
  }
});

test('limites inclusivos/exclusivos do sorteio de 2–5 acordes e 1–7 graus', () => {
  const maximum = 1 - Number.EPSILON;
  for (const [value, expected] of [[0, 2], [0.25 - Number.EPSILON, 2], [0.25, 3], [0.5 - Number.EPSILON, 3], [0.5, 4], [0.75 - Number.EPSILON, 4], [0.75, 5], [maximum, 5]]) {
    const result = generateProgression({ keyId: 'c-major', random: sequence([value, ...Array(expected).fill(maximum)]) });
    assert.equal(result.chords.length, expected);
    assert.ok(result.chords.every(chord => chord.degree === 7));
  }
  for (let degree = 0; degree < 7; degree += 1) {
    const lower = degree / 7;
    const upper = (degree + 1) / 7 - Number.EPSILON;
    const result = generateProgression({ keyId: 'a-minor', random: sequence([0, lower, upper]) });
    assert.deepEqual(result.chords.map(chord => chord.degree), [degree + 1, degree + 1]);
  }
});

test('repetições são permitidas, sem compartilhar objetos entre acordes ou gerações', () => {
  const result = generateProgression({ keyId: 'c-major', random: () => 0 });
  assert.deepEqual(result.chords.map(chord => chord.symbol), ['Cmaj7', 'Cmaj7']);
  assert.notEqual(result.chords[0], result.chords[1]);
  assert.notEqual(result.chords[0].notes[0], result.chords[1].notes[0]);
  result.chords[0].notes[0].midi = -1;
  result.chords[0].symbol = 'alterado';
  assert.equal(result.chords[1].notes[0].midi, 48);
  assert.equal(generateProgression({ keyId: 'c-major', random: () => 0 }).chords[0].symbol, 'Cmaj7');
  const chords = getDiatonicChords('c-major');
  chords[0].notes[0].name = 'alterado';
  assert.equal(getDiatonicChords('c-major')[0].notes[0].name, 'C');
});

test('opções, tonalidades e saídas aleatórias inválidas são rejeitadas sem coerção', () => {
  for (const options of [undefined, null, false, 1, '', [], () => {}, {}]) {
    assert.throws(() => generateProgression(options), TypeError);
  }
  for (const keyId of [undefined, null, false, 0, '', 'C-major', 'c-harmonic-minor', 'constructor', new String('c-major')]) {
    assert.throws(() => getDiatonicChords(keyId), TypeError);
    assert.throws(() => generateProgression({ keyId, random: () => 0 }), TypeError);
  }
  for (const random of [null, false, 0, 'random', {}, []]) {
    assert.throws(() => generateProgression({ keyId: 'c-major', random }), TypeError);
  }
  for (const value of [-1, -Number.EPSILON, 1, 2, NaN, Infinity, -Infinity, '0', null, undefined, false, 0n, new Number(0)]) {
    assert.throws(() => generateProgression({ keyId: 'c-major', random: () => value }), TypeError);
    assert.throws(() => generateProgression({ keyId: 'c-major', random: sequence([0, 0, value]) }), TypeError);
  }
});
