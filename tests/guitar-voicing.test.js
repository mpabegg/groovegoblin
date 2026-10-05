import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChordSymbol } from '../src/progression.js';
import { generateGuitarVoicing, guitarFingering } from '../src/guitar-voicing.js';

const examples = [
  ['C', [0, 4, 7]], ['G', [7, 11, 2]], ['D', [2, 6, 9]],
  ['Am', [9, 0, 4]], ['Em', [4, 7, 11]], ['F', [5, 9, 0]], ['B7', [11, 3, 6, 9]],
];
function assertPlayable(result, tuning, pitchClasses, bass = null) {
  assert.ok(result, `Expected ${pitchClasses} in ${tuning}`);
  assert.equal(result.frets.length, tuning.length);
  assert.ok(result.frets.every(fret => Number.isInteger(fret) && fret >= -1 && fret <= 5));
  const sounding = result.pitches.filter(pitch => pitch !== null);
  assert.ok(sounding.length >= 3 && sounding.length <= 6);
  const actual = [...new Set(sounding.map(pitch => pitch % 12))].sort((a, b) => a - b);
  assert.deepEqual(actual, [...new Set(pitchClasses)].sort((a, b) => a - b));
  result.frets.forEach((fret, index) => assert.equal(result.pitches[index], fret < 0 ? null : tuning[index] + fret));
  const pressed = result.frets.filter(fret => fret > 0);
  if (pressed.length) assert.ok(Math.max(...pressed) - Math.min(...pressed) < 4);
  let fingers = pressed.length;
  if (result.barre) {
    const { fret, from, to } = result.barre;
    assert.ok(from < to && fret > 0);
    assert.equal(result.frets[from], fret); assert.equal(result.frets[to], fret);
    assert.ok(result.frets.slice(from, to + 1).every(value => value >= fret));
    fingers -= result.frets.slice(from, to + 1).filter(value => value === fret).length - 1;
  }
  assert.equal(result.fingers, fingers);
  assert.ok(fingers <= 4);
  const first = result.frets.findIndex(fret => fret >= 0); const last = result.frets.findLastIndex(fret => fret >= 0);
  assert.ok(result.frets.slice(first, last + 1).every(fret => fret >= 0));
  if (bass !== null) assert.equal(sounding[0] % 12, bass);
}

test('all seven requested chords are generated with complete real tones in standard and custom Drop D tuning', () => {
  for (const tuning of [[40, 45, 50, 55, 59, 64], [38, 45, 50, 55, 59, 64]]) {
    for (const [symbol, tones] of examples) {
      const chord = parseChordSymbol(symbol); const before = structuredClone(chord);
      const result = generateGuitarVoicing(chord, tuning);
      assertPlayable(result, tuning, tones);
      assert.deepEqual(chord, before);
      assert.deepEqual(generateGuitarVoicing(chord, tuning), result);
    }
  }
});

test('semitone-down tuning uses sounding pitches, not copied standard fingerings', () => {
  const tuning = [39, 44, 49, 54, 58, 63];
  for (const [symbol, tones] of examples) assertPlayable(generateGuitarVoicing(parseChordSymbol(symbol), tuning), tuning, tones);
});

test('suspended/altered chords and slash bass retain essential pitches, not invented thirds', () => {
  const tuning = [40, 45, 50, 55, 59, 64];
  for (const [symbol, tones, bass] of [['Dsus2', [2, 4, 9], null], ['Asus4', [9, 2, 4], null], ['Dm7b5', [2, 5, 8, 0], null], ['C/E', [0, 4, 7], 4]]) {
    assertPlayable(generateGuitarVoicing(parseChordSymbol(symbol), tuning), tuning, tones, bass);
  }
});

test('barre accounting rejects impossible reaches and open-string obstruction', () => {
  assert.equal(guitarFingering([1, 5, -1, -1, -1, -1]), null);
  assert.equal(guitarFingering([1, 2, 3, 4, 0, 1]), null);
  assert.deepEqual(guitarFingering([1, 3, 3, 2, 1, 1]), { fingers: 4, barre: { fret: 1, from: 0, to: 5 } });
  assert.equal(guitarFingering([0, 0, 0, 0, 0, 0]).fingers, 0);
});

test('unavailable chord tones omit the diagram instead of substituting a familiar shape', () => {
  assert.equal(generateGuitarVoicing(parseChordSymbol('C'), [24, 36, 48, 60, 72, 84]), null);
  assert.equal(generateGuitarVoicing(parseChordSymbol('C'), [28, 33, 38, 43]), null);
  assert.throws(() => generateGuitarVoicing(parseChordSymbol('C'), [40, 45, 50, 55, 59, 64], { maxFret: 6 }), RangeError);
});
