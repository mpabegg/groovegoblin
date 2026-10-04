import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROGRESSION_KEYS, CHORD_QUALITIES, getDiatonicChords, getBorrowedChords, getSecondaryDominants, parseChordSymbol, invertChord, voiceProgression, generateProgression, chordTimeline } from '../src/progression.js';
import { seededRandom } from '../src/random.js';
import { createSession } from '../src/session.js';

const SCALES = {
  major: ['C D E F G A B', 'Db Eb F Gb Ab Bb C', 'D E F# G A B C#', 'Eb F G Ab Bb C D', 'E F# G# A B C# D#', 'F G A Bb C D E', 'F# G# A# B C# D# E#', 'G A B C D E F#', 'Ab Bb C Db Eb F G', 'A B C# D E F# G#', 'Bb C D Eb F G A', 'B C# D# E F# G# A#'],
  minor: ['C D Eb F G Ab Bb', 'C# D# E F# G# A B', 'D E F G A Bb C', 'Eb F Gb Ab Bb Cb Db', 'E F# G A B C D', 'F G Ab Bb C Db Eb', 'F# G# A B C# D E', 'G A Bb C D Eb F', 'G# A# B C# D# E F#', 'A B C D E F G', 'Bb C Db Eb F Gb Ab', 'B C# D E F# G A'],
};
const SCALE_INTERVALS = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const QUALITIES = { major: ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7b5'], minor: ['m7', 'm7b5', 'maj7', 'm7', 'm7', 'maj7', '7'] };
const CHORD_INTERVALS = { maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], '7': [0, 4, 7, 10], m7b5: [0, 3, 6, 10] };
const ROMANS = { major: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'viiø'], minor: ['i', 'iiø', 'III', 'iv', 'v', 'VI', 'VII'] };


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

test('geração reproduzível caminha por funções e resolve a volta para a tônica', () => {
  for (const key of PROGRESSION_KEYS) {
    for (const length of [2, 3, 5, 16]) {
      const generate = () => generateProgression({ keyId: key.id, length, random: seededRandom(42), harmonicRhythm: 2 });
      const result = generate();
      assert.deepEqual(generate(), result);
      assert.equal(result.chords.length, length);
      assert.equal(result.chords[0].degree, 1);
      assert.equal(result.chords[0].function, 'tonic');
      assert.ok(['dominant', 'subdominant'].includes(result.chords.at(-1).function));
      assert.ok(result.chords.every(chord => chord.durationBars === 2));
      assert.ok(result.chords.every(chord => chord.notes.every((note, index) => index === 0 || note.midi > chord.notes[index - 1].midi)));
      assert.equal(createSession({ progression: result }).progression.chords.length, length);
      result.chords[0].notes[0].midi = -1;
      assert.ok(generate().chords[0].notes[0].midi >= 0);
    }
  }
  assert.equal(generateProgression({ keyId: 'c-major', random: () => 0 }).chords.length, 2);
  assert.equal(generateProgression({ keyId: 'c-major', random: () => 1 - Number.EPSILON }).chords.length, 5);
});

test('empréstimos e dominantes secundárias conservam grafia, função e destino', () => {
  const borrowed = getBorrowedChords('c-major');
  assert.deepEqual(borrowed.map(chord => chord.symbol), ['Fm7', 'Abmaj7', 'Bb7', 'Ebmaj7', 'Dm7b5']);
  assert.ok(borrowed.every(chord => chord.source === 'borrowed'));
  const secondary = getSecondaryDominants('c-major');
  assert.deepEqual(secondary.map(chord => chord.symbol), ['A7', 'B7', 'C7', 'D7', 'E7']);
  assert.deepEqual(secondary.map(chord => chord.roman), ['V7/ii', 'V7/iii', 'V7/IV', 'V7/V', 'V7/vi']);
  assert.ok(secondary.every(chord => chord.function === 'dominant' && chord.source === 'secondary'));
  const colored = generateProgression({ keyId: 'c-major', length: 8, borrowed: 1, secondary: 1, random: seededRandom(7) });
  assert.ok(colored.chords.some(chord => chord.source === 'borrowed'));
  assert.equal(colored.chords[0].function, 'tonic');
  assert.ok(createSession({ progression: colored }));
});

test('cifras livres reconhecem tríades, extensões, aliases e baixos de barra', () => {
  for (const quality of Object.keys(CHORD_QUALITIES)) {
    const chord = parseChordSymbol(`Bb${quality}`);
    assert.deepEqual(chord.notes.map(note => note.midi), CHORD_QUALITIES[quality].map(([interval]) => 58 + interval));
  }
  assert.equal(parseChordSymbol(' F♯ø ').symbol, 'F#m7b5');
  assert.deepEqual(parseChordSymbol('G7/B').notes.map(note => note.name), ['B', 'D', 'F', 'G']);
  assert.equal(parseChordSymbol('G7/B').inversion, 1);
  assert.deepEqual(parseChordSymbol('C/D').notes.map(note => note.midi), [38, 48, 52, 55]);
  for (const text of [null, '', 'H7', 'Cunknown', 'Cconstructor', 'CtoString', 'C/G/H']) assert.throws(() => parseChordSymbol(text), TypeError);
});

test('inversões manuais preservam tons, extensões, metadados e baixo explícito coerente', () => {
  const chord = { ...parseChordSymbol('Cmaj9'), durationBars: 2, function: 'tonic' };
  assert.deepEqual(invertChord(chord, 1).notes.map(note => note.name), ['E', 'G', 'B', 'D', 'C']);
  assert.equal(invertChord(chord, 1).durationBars, 2);
  assert.equal(invertChord(chord, 1).function, 'tonic');
  const slash = invertChord(parseChordSymbol('G7/B'), 2);
  assert.equal(slash.symbol, 'G7/D');
  assert.equal(slash.bass, 2);
  assert.equal(slash.notes[0].midi % 12, 2);
  const foreign = invertChord(parseChordSymbol('C/D'), 1);
  assert.equal(foreign.symbol, 'C/D');
  assert.equal(foreign.notes[0].midi, 38);
  assert.deepEqual(foreign.notes.slice(1).map(note => note.name), ['E', 'G', 'C']);
  for (const inversion of [-1, 3, 1.5, '1']) assert.throws(() => invertChord(parseChordSymbol('C/D'), inversion), TypeError);
  assert.equal(chord.notes[0].name, 'C');
});

test('condução de vozes mantém baixos de barra e clones, sem mudar classes de altura', () => {
  const chords = ['Cmaj7', 'G7/B', 'C/D', 'Fmaj9'].map(parseChordSymbol);
  const before = structuredClone(chords);
  const result = voiceProgression(chords);
  assert.deepEqual(chords, before);
  assert.notEqual(result[0].notes[0], chords[0].notes[0]);
  assert.equal(result[1].notes[0].midi % 12, 11);
  assert.equal(result[1].inversion, 1);
  assert.equal(result[2].notes[0].midi, 38);
  for (let index = 0; index < chords.length; index += 1) {
    assert.deepEqual(result[index].notes.map(note => note.midi % 12).sort((a, b) => a - b), chords[index].notes.map(note => note.midi % 12).sort((a, b) => a - b));
  }
});

test('linha harmônica usa duração real do compasso, cicla e recorta apenas o final', () => {
  const chords = [{ ...parseChordSymbol('C'), durationBars: 2 / 7 }, { ...parseChordSymbol('G7'), durationBars: 3 / 7 }];
  const session = createSession({ bars: 2, meter: { beats: 7, unit: 8 }, progression: { enabled: true, chords } });
  const events = chordTimeline(session);
  assert.deepEqual(events.map(event => [event.start, event.duration, event.index]), [[0, 4, 0], [4, 6, 1], [10, 4, 0], [14, 6, 1], [20, 4, 0], [24, 4, 1]]);
  assert.deepEqual(chordTimeline(createSession()), []);
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
    assert.throws(() => generateProgression({ keyId: 'c-major', length: 3, random: () => value }), TypeError);
  }
});

test('controles harmônicos inválidos são rejeitados, incluindo contagem e probabilidades', () => {
  for (const patch of [{ length: 1 }, { length: 17 }, { length: 2.5 }, { borrowed: -0.1 }, { borrowed: NaN }, { secondary: 2 }, { harmonicRhythm: 0.25 }]) {
    assert.throws(() => generateProgression({ keyId: 'c-major', random: seededRandom(1), ...patch }), TypeError);
  }
});
