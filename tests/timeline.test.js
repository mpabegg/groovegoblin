import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSession } from '../src/feedback.js';
import { buildTimelineData } from '../src/timeline.js';
import { createSession } from '../src/session.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const session = overrides => createSession({ bpm: 60, bars: 2, training: { repetitions: 3, goal: 'duration' }, ...overrides });

test('janelas seguem loop, meter e repetições reais, sem dividir notas nas barras internas', () => {
  const reference = session({ bars: 4, meter: { beats: 7, unit: 8 }, loop: { startBar: 1, endBar: 3 }, notes: [{ id: 'cross', start: 27, duration: 3, pitch: 72 }] });
  const results = evaluateSession(reference, [{ start: 3.25, end: 4, pitch: 72 }, { start: 10.25, end: 11, pitch: 72 }]);
  const data = buildTimelineData(results, { session: reference });
  assert.equal(data.repetitions.length, 3);
  assert.equal(data.bars, 2);
  assert.equal(data.startBar, 1);
  assert.equal(data.barSeconds, 3.5);
  assert.ok(data.repetitions.every(rep => rep.windowSeconds === 7 && rep.expected.length === 1));
  for (const rep of data.repetitions.slice(0, 2)) {
    assert.equal(rep.actual.length, 1);
    assert.equal(rep.actual[0].start, 3.25);
    assert.equal(rep.actual[0].end, 4);
    assert.equal(rep.actual[0].clamped, undefined);
    assert.equal(rep.actual[0].pitch, 72);
    assert.equal(rep.expected[0].pitch, 72);
  }
  assert.equal(data.repetitions[2].expected[0].missed, true);
  assert.equal(data.repetitions[2].actual.length, 0);
});

test('ataques, términos e deltas são copiados independentemente nas duas camadas', () => {
  const reference = session({ notes: [{ id: 'a', start: 4, duration: 4 }] });
  const results = evaluateSession(reference, [{ start: 1.125, end: 2 }]);
  const data = buildTimelineData(results, { session: reference });
  for (const block of [data.repetitions[0].expected[0], data.repetitions[0].actual[0]]) {
    assert.equal(block.onset, 'late');
    assert.equal(block.ending, 'ok');
    assert.equal(block.onsetMs, 125);
    assert.equal(block.endMs, 0);
  }
  assert.notEqual(data.repetitions[0].expected[0], data.repetitions[0].actual[0]);
  const earlyEnd = buildTimelineData(evaluateSession(reference, [{ start: 1.0625, end: 1.75 }]), { session: reference });
  assert.equal(earlyEnd.repetitions[0].actual[0].onset, 'ok');
  assert.equal(earlyEnd.repetitions[0].actual[0].ending, 'early');
});

test('ausências não inventam deltas e extras ficam só na execução', () => {
  const reference = session({ notes: [{ id: 'missing', start: 20, duration: 4 }] });
  const data = buildTimelineData(evaluateSession(reference, [{ start: 0.5, end: 0.75 }, { start: 9, end: 9.5 }]), { session: reference });
  assert.ok(data.repetitions.every(rep => rep.expected[0].missed));
  assert.ok(data.repetitions.every(rep => rep.expected[0].onsetMs === undefined && rep.expected[0].endMs === undefined));
  assert.deepEqual(data.repetitions[0].actual, [{ start: 0.5, end: 0.75, extra: true, pitch: null }]);
  assert.deepEqual(data.repetitions[1].actual, [{ start: 1, end: 1.5, extra: true, pitch: null }]);
});

test('recorte visual no fim mantém desvio real, inclusive extras depois do treino', () => {
  const reference = session({ notes: [{ id: 'end', start: 31, duration: 1 }] });
  const data = buildTimelineData(evaluateSession(reference, [{ start: 7.75, end: 8.5 }, { start: 15, end: 16 }, { start: 25, end: 26 }]), { session: reference });
  const held = data.repetitions[0].actual[0];
  assert.equal(held.end, 8);
  assert.equal(held.clamped, true);
  assert.equal(held.endMs, 500);
  assert.equal(held.ending, 'late');
  assert.equal(data.repetitions[1].actual[0].clamped, undefined);
  assert.deepEqual(data.repetitions[2].actual[0], { start: 8, end: 8, extra: true, pitch: null, clamped: true });
});

test('antecipação cruzando a repetição mantém início negativo e notas de borda não são partidas', () => {
  const reference = session({ notes: [{ id: 'first', start: 0, duration: 1 }, { id: 'bar-end', start: 15, duration: 1 }] });
  const data = buildTimelineData(evaluateSession(reference, [{ start: 7.875, end: 8.25 }, { start: 3.75, end: 4 }]), { session: reference });
  const early = data.repetitions[1].actual[0];
  assert.equal(early.start, -0.125);
  assert.equal(early.end, 0.25);
  assert.equal(early.clamped, undefined);
  assert.equal(early.onsetMs, -125);
  assert.equal(data.repetitions[0].actual[0].end, 4);
  assert.equal(data.repetitions[0].actual[0].clamped, undefined);
});

test('modo estilo preserva os deltas absolutos e relativos que explicam a classificação', () => {
  const reference = session({ notes: [{ id: 'a', start: 4, duration: 2 }], training: { repetitions: 2, evaluation: 'style' } });
  const results = evaluateSession(reference, [{ start: 1.09, end: 1.59 }, { start: 9.09, end: 9.59 }]);
  const data = buildTimelineData(results, { session: reference });
  for (const rep of data.repetitions) {
    for (const block of [rep.expected[0], rep.actual[0]]) {
      close(block.onsetMs, 90);
      close(block.relativeOnsetMs, 0);
      close(block.relativeEndMs, 0);
      assert.equal(block.onset, 'ok');
    }
  }
});

test('modo livre não fabrica referência e mantém desvio, pitch e modo', () => {
  const reference = session({ meter: { beats: 3, unit: 4 }, training: { repetitions: 1, evaluation: 'free' } });
  const results = evaluateSession(reference, [{ start: 0.5, end: 0.6, pitch: 64 }, { start: 1.05, end: 1.2 }]);
  const data = buildTimelineData(results, { session: reference });
  assert.equal(data.mode, 'free');
  assert.equal(data.repetitions[0].windowSeconds, 6);
  assert.deepEqual(data.repetitions[0].expected, []);
  assert.ok(data.repetitions[0].actual.every(block => block.free && !block.extra));
  assert.equal(data.repetitions[0].actual[0].pitch, 64);
  close(data.repetitions[0].actual[1].onsetMs, 50);
});

test('projeção é imutável e usa geometria da sessão quando metadados do resultado estão ausentes', () => {
  const reference = session({ meter: { beats: 7, unit: 8 }, notes: [{ id: 'a', start: 4, duration: 2 }] });
  const results = evaluateSession(reference, [{ start: 1, end: 1.5 }]);
  const before = structuredClone(results);
  const data = buildTimelineData(results, { session: reference });
  data.repetitions[0].actual[0].start = 100;
  data.repetitions[0].expected[0].onsetMs = 999;
  assert.deepEqual(results, before);
  const { barSeconds, repetitionSeconds, loopBars, bpm, ...partial } = results;
  const fallback = buildTimelineData(partial, { session: reference });
  assert.equal(fallback.barSeconds, 3.5);
  assert.equal(fallback.repetitions[0].windowSeconds, 7);
});
