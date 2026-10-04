import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDrums, DRUM_INSTRUMENTS } from '../src/drums.js';
import { BAR_OPTIONS, TICKS_PER_BAR } from '../src/model.js';

const phrase = (starts, duration = 1) => starts.map((start, index) => ({ id: `n${index}`, start, duration }));
const lane = (pattern, instrument) => pattern.hits.filter(hit => hit.instrument === instrument);

test('bateria reproduz a semente sem alterar ou compartilhar a frase', () => {
  const notes = Object.freeze(phrase([0, 3, 7, 10, 15, 18, 25]).map(Object.freeze));
  const options = Object.freeze({ notes, bars: 2, seed: 0xffffffff });
  const expected = generateDrums(options);
  const mutated = generateDrums(options);
  mutated.hits[0].velocity = 0;
  mutated.hits.pop();
  assert.deepEqual(generateDrums(options), expected);
  assert.deepEqual(notes, phrase([0, 3, 7, 10, 15, 18, 25]));
});

test('bateria mantém âncoras, backbeats, limites, acentos e espaço em todos os tamanhos', () => {
  for (const bars of BAR_OPTIONS) {
    for (let seed = 0; seed < 64; seed += 1) {
      for (const starts of [[], [3], Array.from({ length: bars * TICKS_PER_BAR }, (_, tick) => tick)]) {
        const pattern = generateDrums({ notes: phrase(starts), bars, seed });
        assert.equal(pattern.bars, bars);
        assert.equal(pattern.seed, seed);
        const keys = pattern.hits.map(hit => `${hit.instrument}:${hit.start}`);
        assert.equal(new Set(keys).size, keys.length);
        for (const hit of pattern.hits) {
          assert.ok(DRUM_INSTRUMENTS.includes(hit.instrument));
          assert.ok(Number.isInteger(hit.start) && hit.start >= 0 && hit.start < bars * TICKS_PER_BAR);
          assert.ok(hit.velocity > 0 && hit.velocity <= 1);
        }
        for (let bar = 0; bar < bars; bar += 1) {
          const offset = bar * TICKS_PER_BAR;
          const kicks = lane(pattern, 'kick').filter(hit => hit.start >= offset && hit.start < offset + TICKS_PER_BAR);
          const hats = lane(pattern, 'hihat').filter(hit => hit.start >= offset && hit.start < offset + TICKS_PER_BAR);
          assert.ok(kicks.some(hit => hit.start === offset));
          assert.ok(kicks.length >= 2 && kicks.length <= 4);
          assert.deepEqual(lane(pattern, 'snare').filter(hit => hit.start >= offset && hit.start < offset + TICKS_PER_BAR).map(hit => hit.start), [offset + 4, offset + 12]);
          assert.ok(hats.length >= 4 && hats.length < TICKS_PER_BAR);
          assert.ok([0, 4, 8, 12].every(tick => hats.some(hit => hit.start === offset + tick)));
          assert.ok(hats.filter(hit => hit.start % 4 !== 0).every(hit => hit.velocity < 0.5));
          if (starts.length > 6) assert.equal(hats.length, 4, 'frase densa deixa mais espaço no chimbal');
        }
      }
    }
  }
});

test('bumbo seleciona ataques da frase sem simplesmente copiar o grid ou evitar coincidências', () => {
  const sparse = generateDrums({ notes: phrase([3]), bars: 1, seed: 42 });
  assert.ok(lane(sparse, 'kick').some(hit => hit.start === 3));
  assert.ok(lane(sparse, 'kick').some(hit => hit.start === 0));
  const dense = generateDrums({ notes: phrase(Array.from({ length: 16 }, (_, tick) => tick)), bars: 1, seed: 42 });
  assert.equal(lane(dense, 'kick').length, 3);
  const noPhrase = generateDrums({ notes: [], bars: 1, seed: 42 });
  assert.notDeepEqual(lane(sparse, 'kick'), lane(noPhrase, 'kick'));
  const seeds = Array.from({ length: 32 }, (_, seed) => JSON.stringify(generateDrums({ notes: phrase([2, 5, 7, 10, 14]), bars: 1, seed }).hits));
  assert.ok(new Set(seeds).size > 8, 'variações mudam a bateria');
  assert.deepEqual(generateDrums({ notes: phrase([0], 8), bars: 1, seed: 42 }), generateDrums({ notes: phrase([0], 1), bars: 1, seed: 42 }), 'sustentar uma nota não cria reataques na bateria');
});

test('bateria rejeita frases e sementes inválidas', () => {
  const base = { notes: phrase([0]), bars: 1, seed: 0 };
  for (const bars of [0, 3, 5, '1', null]) assert.throws(() => generateDrums({ ...base, bars }), TypeError);
  for (const seed of [-1, 0x100000000, 1.5, NaN, '0', null]) assert.throws(() => generateDrums({ ...base, seed }), TypeError);
  for (const notes of [null, {}, phrase([16]), phrase([0, 0])]) assert.throws(() => generateDrums({ ...base, notes }), TypeError);
});
