import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateGroove, generatePolyrhythm } from '../src/generator.js';
import { TICKS_PER_BAR, validPhrase } from '../src/model.js';
import { createSession, ticksPerBar } from '../src/session.js';
const BAR_COUNTS = [1, 2, 3, 4, 8, 16];

const BASE = { bars: 2, seed: 42, density: 'medium', syncopation: 'mixed', lengths: 'mixed' };
const ATTACK_COUNTS = { sparse: 2, medium: 4, busy: 8 };
const STYLES = ['straight', 'mixed', 'syncopated'];
const LENGTH_CHOICES = { short: [1], mixed: [1, 2, 3, 4, 6, 8], long: [4, 6, 8, 12, 16] };
const SEEDS = [...Array.from({ length: 96 }, (_, seed) => seed), 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
const onsets = ({ notes }) => notes.map(({ start }) => start);

function hasRest(notes, end) {
  return notes[0].start > 0 || notes.some((note, index) => {
    const next = notes[index + 1]?.start ?? end;
    return note.start + note.duration < next;
  });
}

test('generateGroove: reproduz notas e IDs a partir de uint32, sem estado compartilhado', () => {
  for (const seed of SEEDS) {
    const options = Object.freeze({ ...BASE, seed });
    const expected = generateGroove(options);
    const actual = generateGroove(options);
    assert.deepEqual(actual, expected);
    assert.equal(new Set(actual.notes.map(({ id }) => id)).size, actual.notes.length);
    assert.ok(actual.notes.every(({ id }) => typeof id === 'string' && id.length > 0));

    actual.notes[0].duration = 1000;
    actual.notes.splice(1, 1);
    generateGroove({ ...BASE, seed: (seed + 1) >>> 0 });
    assert.deepEqual(generateGroove(options), expected);
  }
  const patterns = new Set(SEEDS.map((seed) => JSON.stringify(onsets(generateGroove({ ...BASE, seed })))));
  assert.ok(patterns.size > SEEDS.length / 2, 'sementes diferentes produzem ritmos diferentes');
});

test('generateGroove: todas as combinações preservam densidade por compasso, limites e monofonia', () => {
  const observed = Object.fromEntries(Object.keys(LENGTH_CHOICES).map((lengths) => [lengths, {
    sustained: false, rest: false, adjacency: false, crossBar: false,
  }]));
  const lastTicks = new Set();
  const phraseEndings = new Set();
  for (const bars of BAR_COUNTS) {
    const end = bars * TICKS_PER_BAR;
    for (const [density, count] of Object.entries(ATTACK_COUNTS)) {
      for (const syncopation of STYLES) {
        for (const [lengths, choices] of Object.entries(LENGTH_CHOICES)) {
          for (const seed of SEEDS) {
            const options = { bars, seed, density, syncopation, lengths };
            const { notes } = generateGroove(options);
            const context = JSON.stringify(options);
            assert.ok(validPhrase(notes, bars), context);
            assert.equal(notes.length, bars * count, context);
            for (let bar = 0; bar < bars; bar += 1) {
              assert.equal(notes.filter(({ start }) => Math.floor(start / TICKS_PER_BAR) === bar).length, count, context);
            }
            for (let index = 0; index < notes.length; index += 1) {
              const note = notes[index];
              const next = notes[index + 1]?.start ?? end;
              assert.ok(Number.isInteger(note.start) && note.start >= 0 && note.start < end, context);
              assert.ok(Number.isInteger(note.duration) && note.duration >= 1, context);
              assert.ok(note.start + note.duration <= next, context);
              assert.ok(choices.some((choice) => Math.min(choice, next - note.start) === note.duration), context);
              if (index > 0) assert.ok(notes[index - 1].start < note.start, context);
              if (lengths === 'short') assert.equal(note.duration, 1, context);
              if (note.duration > 1) observed[lengths].sustained = true;
              if (notes[index + 1] && note.start + note.duration === next) observed[lengths].adjacency = true;
              if (Math.floor(note.start / TICKS_PER_BAR) !== Math.floor((note.start + note.duration - 1) / TICKS_PER_BAR)) {
                observed[lengths].crossBar = true;
              }
              if (note.start === end - 1) {
                assert.equal(note.duration, 1, context);
                lastTicks.add(`${bars}:${lengths}`);
              }
              if (note.start + note.duration === end) phraseEndings.add(`${bars}:${lengths}`);
            }
            if (hasRest(notes, end)) observed[lengths].rest = true;
          }
        }
      }
    }
  }
  assert.equal(observed.short.sustained, false);
  assert.equal(observed.short.crossBar, false);
  for (const lengths of Object.keys(LENGTH_CHOICES)) {
    assert.ok(observed[lengths].rest, `${lengths} permite pausas reais`);
    assert.ok(observed[lengths].adjacency, `${lengths} preserva notas adjacentes distintas`);
    for (const bars of BAR_COUNTS) {
      assert.ok(lastTicks.has(`${bars}:${lengths}`), `último tick presente: ${bars}/${lengths}`);
      assert.ok(phraseEndings.has(`${bars}:${lengths}`), `fim exato presente: ${bars}/${lengths}`);
    }
  }
  for (const lengths of ['mixed', 'long']) {
    assert.ok(observed[lengths].sustained, `${lengths} inclui durações maiores que 1`);
    assert.ok(observed[lengths].crossBar, `${lengths} permite sustentar através da barra`);
  }
});

test('generateGroove: pesos favorecem pulsos ou síncopes sem excluir ticks nem concentrar ataques no início', () => {
  const counts = {};
  for (const syncopation of STYLES) {
    const histogram = Array(TICKS_PER_BAR).fill(0);
    for (let seed = 0; seed < 256; seed += 1) {
      const { notes } = generateGroove({ ...BASE, bars: 1, seed, density: 'sparse', syncopation, lengths: 'short' });
      for (const { start } of notes) histogram[start] += 1;
    }
    assert.ok(histogram.every((count) => count > 0), `${syncopation}: todos os ticks elegíveis`);
    const quarter = histogram.filter((_, tick) => tick % 4 === 0).reduce((sum, count) => sum + count, 0);
    const eighthOffbeat = histogram.filter((_, tick) => tick % 4 === 2).reduce((sum, count) => sum + count, 0);
    const sixteenthOffbeat = histogram.filter((_, tick) => tick % 2 === 1).reduce((sum, count) => sum + count, 0);
    counts[syncopation] = { quarter, eighthOffbeat, sixteenthOffbeat };
    assert.ok(histogram.slice(8).some((count) => count > 0));
  }
  assert.ok(counts.straight.quarter > counts.mixed.quarter);
  assert.ok(counts.mixed.quarter > counts.syncopated.quarter);
  // Grupos têm 4, 4 e 8 ticks: comparar médias por tick, nao totais brutos.
  assert.ok(counts.straight.quarter > counts.straight.eighthOffbeat);
  assert.ok(counts.straight.eighthOffbeat / 4 > counts.straight.sixteenthOffbeat / 8);
  assert.ok(counts.syncopated.eighthOffbeat > counts.syncopated.quarter);
  assert.ok(counts.syncopated.sixteenthOffbeat / 8 > counts.syncopated.quarter / 4);
});

test('generateGroove: controles mudam o resultado e comprimentos preservam os ataques', () => {
  let mixedSustain = false;
  let longSustain = false;
  let longerThanMixed = false;
  let styleDifference = false;
  for (const seed of SEEDS) {
    const short = generateGroove({ ...BASE, seed, density: 'sparse', lengths: 'short' });
    const mixed = generateGroove({ ...BASE, seed, density: 'sparse', lengths: 'mixed' });
    const long = generateGroove({ ...BASE, seed, density: 'sparse', lengths: 'long' });
    assert.deepEqual(onsets(short), onsets(mixed));
    assert.deepEqual(onsets(mixed), onsets(long));
    for (let index = 0; index < mixed.notes.length; index += 1) {
      assert.ok(long.notes[index].duration >= mixed.notes[index].duration);
      if (mixed.notes[index].duration > 1) mixedSustain = true;
      if (long.notes[index].duration > 1) longSustain = true;
      if (long.notes[index].duration > mixed.notes[index].duration) longerThanMixed = true;
    }
    const straight = generateGroove({ ...BASE, seed, syncopation: 'straight' });
    const syncopated = generateGroove({ ...BASE, seed, syncopation: 'syncopated' });
    if (JSON.stringify(onsets(straight)) !== JSON.stringify(onsets(syncopated))) styleDifference = true;
    const sparse = generateGroove({ ...BASE, seed, density: 'sparse' });
    const busy = generateGroove({ ...BASE, seed, density: 'busy' });
    assert.equal(sparse.notes.length, 4);
    assert.equal(busy.notes.length, 16);
  }
  assert.ok(mixedSustain && longSustain && longerThanMixed && styleDifference);
});

test('generateGroove: opções inválidas rejeitadas com TypeError, sem coerção ou fallback', () => {
  for (const options of [undefined, null, false, 1, 'opções', [], {}, () => {}]) {
    assert.throws(() => generateGroove(options), TypeError);
  }
  const invalid = {
    bars: [undefined, null, 0, -1, 65, 1.5, '1', NaN, Infinity, new Number(1)],
    seed: [undefined, null, false, -1, 0x100000000, 1.5, '42', NaN, Infinity, -Infinity, 42n, new Number(42)],
    density: [undefined, null, false, 2, 'Sparse', '', 'constructor', 'toString', new String('medium')],
    syncopation: [undefined, null, false, 1, 'Straight', '', 'constructor', new String('mixed')],
    lengths: [undefined, null, false, 1, 'Long', '', 'constructor', 'toString', new String('long')],
  };
  for (const [field, values] of Object.entries(invalid)) {
    for (const value of values) assert.throws(() => generateGroove({ ...BASE, [field]: value }), TypeError);
    const missing = { ...BASE };
    delete missing[field];
    assert.throws(() => generateGroove(missing), TypeError);
  }
});

test('geração em compassos e subdivisões reais produz notas canônicas fracionárias válidas', () => {
  for (const meter of [{ beats: 3, unit: 4 }, { beats: 7, unit: 8 }, { beats: 12, unit: 8 }, { beats: 1, unit: 16 }, { beats: 16, unit: 2 }]) {
    for (const subdivision of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const density of ['sparse', 'medium', 'busy']) {
        const options = { ...BASE, bars: 3, meter, subdivision, density, keyId: 'f-sharp-minor' };
        const generated = generateGroove(options);
        const session = createSession({ notes: generated.notes, bars: generated.bars, meter, subdivision, generator: { seed: generated.seed } });
        assert.ok(validPhrase(session.notes, session));
        const slots = Math.ceil(ticksPerBar(session) / (4 / subdivision) - 1e-6);
        const count = Math.max(1, Math.min(slots, Math.round(ATTACK_COUNTS[density] * ticksPerBar(session) / 16)));
        assert.equal(generated.notes.length, 3 * count);
        assert.ok(generated.notes.every(note => [0, 2, 3, 5, 7, 8, 10].includes((note.pitch - 6 + 12) % 12)));
        assert.deepEqual(generateGroove(options), generated);
        for (const note of generated.notes) {
          const local = note.start % ticksPerBar(session);
          assert.ok(Math.abs(local / (4 / subdivision) - Math.round(local / (4 / subdivision))) < 1e-6);
        }
      }
    }
  }
});

test('altura e acentos não alteram ataques/durações; polirritmia mantém ciclo através das barras', () => {
  const plain = generateGroove({ ...BASE, subdivision: 3, accents: false });
  const melodic = generateGroove({ ...BASE, subdivision: 3, accents: true, keyId: 'c-major' });
  const geometry = generated => generated.notes.map(({ start, duration }) => ({ start, duration }));
  assert.deepEqual(geometry(plain), geometry(melodic));
  assert.ok(plain.notes.every(note => note.pitch === 69 && note.articulation === 'normal'));
  const meter = { beats: 3, unit: 4 };
  const notes = generatePolyrhythm({ bars: 3, meter, pulses: 3, spanBeats: 4, pitch: 60 });
  assert.ok(validPhrase(notes, { bars: 3, meter }));
  assert.deepEqual(notes.slice(0, 4).map(note => note.start), [0, 5.333333333, 10.666666667, 16]);
  assert.equal(notes.at(-1).start + notes.at(-1).duration, 36);
  assert.ok(notes.every(note => note.pitch === 60));
  for (const options of [{ pulses: 1 }, { spanBeats: 0 }, { pitch: 128 }, { meter: { beats: 7, unit: 3 } }]) {
    assert.throws(() => generatePolyrhythm(options), TypeError);
  }
});
