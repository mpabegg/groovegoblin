import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/feedback.js';
import { buildTimelineData } from '../src/timeline.js';

// Tempos binários exatos: bpm=60 → tick=.25s, compasso=4s.
// O render depende de DOM real e é coberto pelo smoke de integração do app,
// não por mocks de DOM nestes testes node:test.
const BPM = 60;

for (const bars of [1, 2, 4]) {
  test(`buildTimelineData: quatro janelas de ${bars} compasso(s), tempos relativos`, () => {
    const notes = [{ id: 'n1', start: 4, duration: 2 }];
    const windowSeconds = bars * 4;
    const attempts = Array.from({ length: 4 }, (_, index) => ({
      start: index * windowSeconds + 1,
      end: index * windowSeconds + 1.5,
    }));
    const results = evaluate(notes, attempts, BPM, bars);
    const data = buildTimelineData(results, { bpm: BPM, bars });

    assert.equal(data.barSeconds, 4);
    assert.equal(data.bars, bars);
    assert.deepEqual(data.repetitions.map(rep => rep.repetition), [1, 2, 3, 4]);
    for (const repetition of data.repetitions) {
      assert.equal(repetition.windowSeconds, windowSeconds);
      assert.deepEqual(repetition.expected, [{
        start: 1, end: 1.5, noteId: 'n1', missed: false,
        onsetMs: 0, endMs: 0, onset: 'ok', ending: 'ok',
      }]);
      assert.deepEqual(repetition.actual, [{
        start: 1, end: 1.5, extra: false, noteId: 'n1',
        onsetMs: 0, endMs: 0, onset: 'ok', ending: 'ok',
      }]);
      assert.notEqual(repetition.expected[0], repetition.actual[0]);
    }
  });
}

test('buildTimelineData: ataque ok e término antecipado mantêm deltas independentes nos dois lados', () => {
  const results = evaluate(
    [{ id: 'n1', start: 4, duration: 4 }],
    [{ start: 1.0625, end: 1.75 }],
    BPM, 1,
  );
  const data = buildTimelineData(results, { bpm: BPM, bars: 1 });
  const repetition = data.repetitions[0];
  assert.equal(repetition.expected.length, 1);
  assert.equal(repetition.actual.length, 1);
  for (const block of [repetition.expected[0], repetition.actual[0]]) {
    assert.equal(block.noteId, 'n1');
    assert.equal(block.onsetMs, 62.5);
    assert.equal(block.endMs, -250);
    assert.equal(block.onset, 'ok');
    assert.equal(block.ending, 'early');
  }
  assert.equal(repetition.expected[0].start, 1);
  assert.equal(repetition.expected[0].end, 2);
  assert.equal(repetition.actual[0].start, 1.0625);
  assert.equal(repetition.actual[0].end, 1.75);
});

test('buildTimelineData: ataque atrasado não altera término correto', () => {
  const results = evaluate(
    [{ id: 'n1', start: 4, duration: 4 }],
    [{ start: 1.125, end: 2 }],
    BPM, 1,
  );
  const { expected, actual } = buildTimelineData(results, { bpm: BPM, bars: 1 }).repetitions[0];
  for (const block of [expected[0], actual[0]]) {
    assert.equal(block.onsetMs, 125);
    assert.equal(block.endMs, 0);
    assert.equal(block.onset, 'late');
    assert.equal(block.ending, 'ok');
  }
});

test('buildTimelineData: missed fica só na referência, sem delta inventado', () => {
  const results = evaluate([{ id: 'ausente', start: 20, duration: 4 }], [], BPM, 2);
  const data = buildTimelineData(results, { bpm: BPM, bars: 2 });
  for (const repetition of data.repetitions) {
    assert.deepEqual(repetition.expected, [{ start: 5, end: 6, noteId: 'ausente', missed: true }]);
    assert.deepEqual(repetition.actual, []);
  }
});

test('buildTimelineData: extra fica só na execução, na janela atribuída pelo evaluate', () => {
  const results = evaluate([], [{ start: 0.5, end: 0.75 }, { start: 9, end: 9.5 }], BPM, 2);
  const data = buildTimelineData(results, { bpm: BPM, bars: 2 });
  assert.deepEqual(data.repetitions[0].actual, [{ start: 0.5, end: 0.75, extra: true }]);
  assert.deepEqual(data.repetitions[1].actual, [{ start: 1, end: 1.5, extra: true }]);
  for (const repetition of data.repetitions) assert.deepEqual(repetition.expected, []);
  assert.deepEqual(data.repetitions[2].actual, []);
  assert.deepEqual(data.repetitions[3].actual, []);
});

test('buildTimelineData: nota que cruza fronteira interna permanece um bloco contínuo', () => {
  const results = evaluate(
    [{ id: 'atravessa', start: 15, duration: 3 }],
    [{ start: 3.75, end: 4.625 }],
    BPM, 2,
  );
  const first = buildTimelineData(results, { bpm: BPM, bars: 2 }).repetitions[0];
  assert.equal(first.windowSeconds, 8);
  assert.equal(first.expected.length, 1);
  assert.equal(first.actual.length, 1);
  assert.equal(first.expected[0].start, 3.75);
  assert.equal(first.expected[0].end, 4.5);
  assert.equal(first.actual[0].start, 3.75);
  assert.equal(first.actual[0].end, 4.625);
  assert.equal(first.actual[0].endMs, 125);
  assert.equal(first.actual[0].clamped, undefined);
});

test('buildTimelineData: fim exatamente na fronteira interna não é clamp nem divisão', () => {
  const results = evaluate(
    [{ id: 'borda', start: 15, duration: 1 }],
    [{ start: 3.75, end: 4 }],
    BPM, 2,
  );
  const first = buildTimelineData(results, { bpm: BPM, bars: 2 }).repetitions[0];
  assert.equal(first.expected.length, 1);
  assert.equal(first.actual.length, 1);
  assert.equal(first.expected[0].end, 4);
  assert.equal(first.actual[0].end, 4);
  assert.equal(first.actual[0].clamped, undefined);
});

test('buildTimelineData: clamp no fim da frase sinaliza corte e preserva delta original', () => {
  const results = evaluate(
    [{ id: 'fim', start: 31, duration: 1 }],
    [{ start: 7.75, end: 8.5 }],
    BPM, 2,
  );
  const data = buildTimelineData(results, { bpm: BPM, bars: 2 });
  const first = data.repetitions[0];
  assert.equal(first.expected[0].end, 8);
  assert.equal(first.actual[0].start, 7.75);
  assert.equal(first.actual[0].end, 8);
  assert.equal(first.actual[0].clamped, true);
  for (const block of [first.expected[0], first.actual[0]]) {
    assert.equal(block.onsetMs, 0);
    assert.equal(block.endMs, 500);
    assert.equal(block.onset, 'ok');
    assert.equal(block.ending, 'late');
  }
  // Não duplica o prolongamento na repetição seguinte.
  assert.deepEqual(data.repetitions[1].actual, []);
  assert.equal(results.rows[0].actualEnd, 8.5);
});

test('buildTimelineData: extra prolongada sofre clamp; fim exato não sinaliza corte', () => {
  const results = evaluate([], [{ start: 7, end: 9 }, { start: 15, end: 16 }], BPM, 2);
  const data = buildTimelineData(results, { bpm: BPM, bars: 2 });
  assert.deepEqual(data.repetitions[0].actual, [{ start: 7, end: 8, extra: true, clamped: true }]);
  assert.deepEqual(data.repetitions[1].actual, [{ start: 7, end: 8, extra: true }]);
});

test('buildTimelineData: extra após toda a sessão fica na borda da última janela', () => {
  const results = evaluate([], [{ start: 33, end: 34 }], BPM, 2);
  const data = buildTimelineData(results, { bpm: BPM, bars: 2 });
  assert.deepEqual(data.repetitions[3].actual, [{ start: 8, end: 8, extra: true, clamped: true }]);
  assert.ok(data.repetitions.slice(0, 3).every(rep => rep.actual.length === 0));
});

test('buildTimelineData: antecipação através da fronteira da repetição mantém onset negativo', () => {
  const results = evaluate(
    [{ id: 'inicio', start: 0, duration: 1 }],
    [{ start: 7.875, end: 8.25 }],
    BPM, 2,
  );
  const data = buildTimelineData(results, { bpm: BPM, bars: 2 });
  assert.deepEqual(data.repetitions[0].actual, []);
  const actual = data.repetitions[1].actual[0];
  assert.equal(actual.start, -0.125);
  assert.equal(actual.end, 0.25);
  assert.equal(actual.onsetMs, -125);
  assert.equal(actual.onset, 'early');
  assert.equal(actual.clamped, undefined);
});

test('buildTimelineData: tolerâncias são repassadas para todos os BPMs', () => {
  for (const bpm of [40, 60, 100, 120, 240]) {
    const results = evaluate([], [], bpm, 2);
    const data = buildTimelineData(results, { bpm, bars: 2 });
    assert.equal(data.toleranceMs, results.toleranceMs);
    assert.equal(data.matchWindowMs, results.matchWindowMs);
    assert.equal(data.barSeconds, 240 / bpm);
    assert.equal(data.repetitions.length, 4);
    assert.ok(data.repetitions.every(rep => rep.windowSeconds === 2 * data.barSeconds));
  }
});

test('buildTimelineData: não muta resultados/opções e blocos não compartilham objetos', () => {
  const results = evaluate(
    [{ id: 'n1', start: 4, duration: 2 }],
    [{ start: 1, end: 1.5 }],
    BPM, 1,
  );
  const snapshot = structuredClone(results);
  for (const row of results.rows) Object.freeze(row);
  Object.freeze(results.rows);
  Object.freeze(results);
  const options = Object.freeze({ bpm: BPM, bars: 1 });
  const data = buildTimelineData(results, options);
  data.repetitions[0].actual[0].onsetMs = 999;
  data.repetitions[0].actual[0].noteId = 'alterada';
  data.repetitions[1].expected[0].start = 999;
  assert.equal(data.repetitions[0].expected[0].onsetMs, 0);
  assert.equal(data.repetitions[0].expected[0].noteId, 'n1');
  assert.equal(data.repetitions[2].expected[0].start, 1);
  assert.deepEqual(results, snapshot);
  assert.deepEqual(options, { bpm: BPM, bars: 1 });
});
