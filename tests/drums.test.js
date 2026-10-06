import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDrums, DRUM_VOICES } from '../src/drums.js';
import { createSession, STYLES, DENSITIES, ticksPerBar, MAX_BARS } from '../src/session.js';

const phrase = starts => starts.map((start, index) => ({ id: `n${index}`, start, duration: 0.5 }));
const lane = (pattern, instrument) => pattern.hits.filter(hit => hit.instrument === instrument);

test('bateria reproduz semente e frase canônica sem compartilhar objetos', () => {
  const input = createSession({ bars: 2, notes: phrase([0, 3, 7, 10, 15, 18, 25]), drums: { enabled: true, seed: 0xffffffff } });
  const before = structuredClone(input);
  const expected = generateDrums(input);
  const actual = generateDrums(input);
  assert.deepEqual(actual, expected);
  actual.hits[0].velocity = 0;
  actual.hits.pop();
  assert.deepEqual(generateDrums(input), expected);
  assert.deepEqual(input, before);
});

test('cada estilo e densidade preserva vozes, limites e golpes únicos em compassos simples, compostos e irregulares', () => {
  for (const meter of [{ beats: 4, unit: 4 }, { beats: 3, unit: 4 }, { beats: 2, unit: 4 }, { beats: 6, unit: 8 }, { beats: 7, unit: 8 }, { beats: 5, unit: 16 }, { beats: 1, unit: 16 }]) {
    for (const style of STYLES) {
      for (const density of DENSITIES) {
        const session = createSession({ bars: 5, meter, drums: { enabled: true, style, density, seed: 42 } });
        const pattern = generateDrums(session);
        const end = 5 * ticksPerBar(session);
        assert.ok(pattern.hits.length > 0, `${style} ${meter.beats}/${meter.unit}`);
        assert.equal(new Set(pattern.hits.map(hit => `${hit.instrument}:${hit.start.toFixed(6)}`)).size, pattern.hits.length);
        for (const hit of pattern.hits) {
          assert.ok(DRUM_VOICES.includes(hit.instrument));
          assert.ok(Number.isFinite(hit.start) && hit.start >= 0 && hit.start < end);
          assert.ok(hit.velocity >= 0.05 && hit.velocity <= 1);
        }
      }
    }
  }
});

test('complementar apoia ataques selecionados sem copiar toda a frase', () => {
  const session = createSession({ notes: phrase([3]), drums: { seed: 42, style: 'complement' } });
  const sparse = generateDrums(session);
  assert.ok(lane(sparse, 'kick').some(hit => hit.start === 3));
  assert.ok(lane(sparse, 'kick').some(hit => hit.start === 0));
  assert.deepEqual(lane(sparse, 'snare').map(hit => hit.start), [4, 12]);
  const dense = generateDrums(createSession({ notes: phrase(Array.from({ length: 16 }, (_, tick) => tick)), drums: { seed: 42 } }));
  assert.ok(lane(dense, 'kick').length < 16);
  assert.ok(lane(dense, 'hihat').length < 8);
});

test('shuffle conserva tercinas fracionárias; valsa e viradas seguem o compasso e o loop', () => {
  const shuffle = generateDrums(createSession({ drums: { style: 'shuffle', density: 'medium' } }));
  assert.ok(lane(shuffle, 'hihat').some(hit => Math.abs(hit.start - 8 / 3) < 1e-6));
  const waltz = generateDrums(createSession({ meter: { beats: 3, unit: 4 }, drums: { style: 'waltz', density: 'medium' } }));
  assert.deepEqual(lane(waltz, 'kick').map(hit => hit.start), [0]);
  assert.deepEqual(lane(waltz, 'snare').map(hit => hit.start), [4, 8]);
  const loop = createSession({ bars: 4, loop: { startBar: 1, endBar: 3 }, drums: { style: 'pop', density: 'medium' } });
  const filled = generateDrums(loop);
  assert.ok(lane(filled, 'tom').some(hit => hit.start >= 44 && hit.start < 48));
  assert.ok(lane(filled, 'tom').every(hit => hit.start >= 32 && hit.start < 48));
});

test('bateria rejeita sessões inválidas em vez de aceitar antigos objetos de opções', () => {
  const base = createSession();
  for (const input of [null, {}, { notes: [], bars: 1, seed: 0 }, { ...base, bars: MAX_BARS + 1 }, { ...base, notes: phrase([16]) }, { ...base, drums: { ...base.drums, seed: -1 } }, { ...base, drums: { ...base.drums, style: 'unknown' } }]) {
    assert.throws(() => generateDrums(input), TypeError);
  }
});
