// Resumo derivado do resultado: veredito, frases contextuais (tendência,
// consistência, alturas, calibração), aproveitamento por compasso, trecho mais
// fraco, ações de andamento, marcas dos extras e a identidade de comparação.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { resultSummary, noteResults, modalStatus, rowStatus, barAccuracy, worstBar, weakRange,
  attackMarks, comparisonKey, comparisonEntry, createComparisonMemory, exerciseFingerprint } from '../src/result-summary.js';

const session = (overrides = {}) => createSession({
  bars: 4, bpm: 100, notes: [
    { id: 'a', start: 0, duration: 4, pitch: 52 },
    { id: 'b', start: 4, duration: 4, pitch: 53 },
    { id: 'c', start: 16, duration: 4, pitch: 54 },
    { id: 'd', start: 32, duration: 4, pitch: 55 },
  ], ...overrides,
});

const matched = (noteId, repetition, onsetMs, status = 'ok') => ({ kind: 'matched', noteId, repetition, onsetMs, endMs: 0, onset: status, ending: 'ok', pitchOk: null });
const missed = (noteId, repetition) => ({ kind: 'missed', noteId, repetition });
const extra = (repetition, actualStart) => ({ kind: 'extra', repetition, actualStart, actualEnd: actualStart + 0.07 });
const freeRow = (repetition, nearestTick, deviationMs, onset = 'ok') => ({ kind: 'free', repetition, nearestTick, deviationMs, onsetMs: deviationMs, actualStart: nearestTick * 0.15, actualEnd: nearestTick * 0.15 + 0.07, onset });
const results = (rows, overrides = {}) => ({ rows, toleranceMs: 40, mode: 'strict', goal: 'timing', repetitions: 2, bpm: 100, startBar: 0, loopBars: 4, instrument: false, stats: null, ...overrides });
const fragment = (summary, kind) => summary.fragments.find(item => item.kind === kind) ?? null;

test('veredito conta ataques no tempo e frases trazem o desvio mediano com sinal', () => {
  const rows = [matched('a', 1, 30), matched('a', 2, 30), matched('b', 1, 30), matched('b', 2, 30), missed('c', 1), missed('c', 2), matched('d', 1, 30), matched('d', 2, 30)];
  const summary = resultSummary(results(rows), session());
  assert.deepEqual(summary.verdict, { kind: 'attacks', ok: 6, expected: 8 });
  assert.equal(summary.ratio, 0.75);
  assert.equal(summary.tendencyMs, 30);
  assert.equal(summary.medianMs, 30);
  assert.equal(fragment(summary, 'tendency').kind, 'tendency');
  assert.equal(fragment(summary, 'tendency').valueMs, 30);
});

test('tendência só aparece com desvio relevante e mais de um ataque casado', () => {
  assert.equal(fragment(resultSummary(results([matched('a', 1, 3), matched('b', 1, 4)]), session()), 'tendency'), null);
  assert.equal(fragment(resultSummary(results([matched('a', 1, 30)]), session()), 'tendency'), null);
  const early = resultSummary(results([matched('a', 1, -20, 'early'), matched('b', 1, -24, 'early')]), session());
  assert.equal(early.tendencyMs, -22);
  assert.equal(fragment(early, 'tendency').valueMs, -22);
});

test('consistência usa a dispersão dos ataques casados contra a tolerância', () => {
  const regular = resultSummary(results([matched('a', 1, 10), matched('b', 1, 12), matched('c', 1, 11)]), session());
  assert.equal(regular.consistency, 'regular');
  assert.equal(fragment(regular, 'consistency').value, 'regular');
  assert.ok(fragment(regular, 'consistency').spreadMs <= 20, `spread ${fragment(regular, 'consistency').spreadMs}`);
  const irregular = resultSummary(results([matched('a', 1, -60, 'early'), matched('b', 1, 0), matched('c', 1, 60, 'late')]), session());
  assert.equal(irregular.consistency, 'irregular');
  assert.equal(fragment(irregular, 'consistency').value, 'irregular');
  assert.ok(fragment(irregular, 'consistency').spreadMs > 20, `spread ${fragment(irregular, 'consistency').spreadMs}`);
  assert.equal(resultSummary(results([matched('a', 1, 0), matched('b', 1, 5)]), session()).consistency, null);
});

test('alturas erradas, calibração ausente e o limite de três frases', () => {
  const rows = [matched('a', 1, 30, 'ok'), matched('b', 1, 30, 'ok'), matched('c', 1, 30, 'ok'), matched('d', 1, 30, 'ok')];
  rows[0].pitchStatus = 'wrong'; rows[1].pitchStatus = 'wrong';
  const plain = resultSummary(results(rows, { goal: 'pitch' }), session());
  assert.equal(plain.pitchWrong, 2);
  assert.equal(fragment(plain, 'pitch').kind, 'pitch');
  assert.equal(fragment(plain, 'pitch').count, 2);
  assert.equal(fragment(plain, 'calibration'), null);

  const uncalibrated = createSession({ ...session(), extensions: { performanceInput: { mode: 'keyboard', calibrated: false } } });
  const withCalibration = resultSummary(results(rows, { goal: 'pitch' }), uncalibrated);
  assert.equal(withCalibration.uncalibrated, true);
  assert.equal(fragment(withCalibration, 'calibration').action, 'calibrate');
  assert.equal(withCalibration.fragments.length, 3);
  assert.deepEqual(withCalibration.fragments.map(item => item.kind), ['tendency', 'pitch', 'calibration']);
});

test('aproveitamento por compasso, pior compasso e trecho fraco com vizinho', () => {
  const isolated = barAccuracy(results([matched('a', 1, 0), matched('b', 1, 0), matched('c', 1, 60, 'late'), matched('d', 1, 0)]), session());
  assert.deepEqual(isolated.map(entry => [entry.bar, entry.ok, entry.total, entry.ratio]), [[0, 2, 2, 1], [1, 0, 1, 0], [2, 1, 1, 1], [3, 0, 0, null]]);
  assert.equal(worstBar(isolated).bar, 1);
  assert.deepEqual(weakRange(isolated), { startBar: 1, endBar: 2 });
  const withNeighbour = barAccuracy(results([matched('a', 1, 0), matched('b', 1, 60, 'late'), matched('c', 1, 60, 'late'), matched('d', 1, 0)]), session());
  assert.deepEqual(withNeighbour.map(entry => entry.ratio), [0.5, 0, 1, null]);
  assert.deepEqual(weakRange(withNeighbour), { startBar: 0, endBar: 2 });
  assert.equal(weakRange([{ bar: 0, ok: 1, total: 1, ratio: 1 }]), null);
  const oneBarLoop = barAccuracy(results([matched('a', 1, 60, 'late')], { loopBars: 1 }), session());
  assert.equal(weakRange(oneBarLoop), null);
  assert.deepEqual(barAccuracy(results([matched('a', 2, 0)]), session(), 2).map(entry => entry.total), [1, 0, 0, 0]);
});

test('ações de andamento respeitam o piso, o teto e o corte de 90%', () => {
  const perfect = resultSummary(results([matched('a', 1, 0), matched('b', 1, 0), matched('c', 1, 0), matched('d', 1, 0)]), session());
  assert.equal(perfect.actions.faster, 104);
  assert.equal(perfect.actions.slower, 90);
  assert.equal(perfect.actions.loop, null);
  assert.equal(perfect.actions.retry, true);
  const weak = resultSummary(results([matched('a', 1, 0), missed('b', 1), matched('c', 1, 0), matched('d', 1, 0)]), session());
  assert.equal(weak.ratio, 0.75);
  assert.equal(weak.actions.faster, null);
  assert.equal(weak.actions.slower, 90);
  assert.deepEqual(weak.actions.loop, { startBar: 0, endBar: 1 });
  assert.equal(resultSummary(results([matched('a', 1, 0)], { bpm: 30 }), session()).actions.slower, null);
  assert.equal(resultSummary(results([matched('a', 1, 0)], { bpm: 298 }), session()).actions.faster, null);
  const free = resultSummary(results([...Array.from({ length: 9 }, () => freeRow(1, 4, 0)), freeRow(1, 8, 60, 'late')], { mode: 'free', repetitions: 1 }), session());
  assert.deepEqual(free.verdict, { kind: 'free', ok: 9, count: 10 });
  assert.equal(free.actions.faster, 104);
  assert.equal(free.weak, null);
});

test('estado por nota usa a moda e desempata pela gravidade', () => {
  const rows = [
    matched('a', 1, 0), matched('a', 2, 60, 'late'),
    matched('b', 1, 0), matched('b', 2, 10),
    missed('c', 1), matched('c', 2, 0),
    matched('d', 1, -60, 'early'), matched('d', 2, -20, 'early'),
  ];
  const outcomes = noteResults(results(rows));
  assert.equal(outcomes.get('a').status, 'late');
  assert.equal(outcomes.get('b').status, 'ok');
  assert.equal(outcomes.get('c').status, 'missed');
  assert.equal(outcomes.get('d').status, 'early');
  assert.equal(outcomes.get('a').rows.length, 2);
  assert.equal(noteResults(results(rows), 1).get('c').status, 'missed');
  assert.equal(noteResults(results(rows), 2).get('c').status, 'ok');
  assert.equal(noteResults(results(rows), 2).get('b').rows.length, 1);
  assert.equal(modalStatus(['early', 'late'], [-60, 60]), 'late');
  assert.equal(modalStatus(['early', 'late'], [-60, -20]), 'early');
  assert.equal(modalStatus([]), null);
  assert.equal(rowStatus({ kind: 'extra' }, results([])), null);
  assert.equal(rowStatus({ kind: 'matched', onset: 'ok', pitchStatus: 'wrong' }, results([], { goal: 'pitch' })), 'wrong');
  assert.equal(rowStatus({ kind: 'matched', onset: 'ok', pitchStatus: 'wrong' }, results([], { goal: 'timing' })), 'ok');
  assert.equal(rowStatus({ kind: 'matched', onset: 'ok', pitchOk: false }, results([], { goal: 'pitch' })), 'wrong');
  assert.equal(rowStatus({ kind: 'matched', onset: 'ok', pitchStatus: 'octave' }, results([], { goal: 'pitch' })), 'wrong');
  assert.equal(rowStatus({ kind: 'matched', onset: 'late', pitchStatus: 'octave' }, results([], { goal: 'pitch' })), 'wrong');
  assert.equal(rowStatus({ kind: 'matched', onset: 'late', pitchStatus: 'unidentified' }, results([], { goal: 'pitch' })), 'late');
  const octaveRows = [{ ...matched('a', 1, 0), pitchStatus: 'octave', pitchOk: false }, matched('b', 1, 0)];
  const octave = resultSummary(results(octaveRows, { goal: 'pitch' }), session());
  assert.equal(octave.pitchWrong, 1);
  assert.equal(noteResults(results(octaveRows, { goal: 'pitch' })).get('a').status, 'wrong');
  assert.deepEqual(barAccuracy(results(octaveRows, { goal: 'pitch' }), session()).map(entry => entry.ratio), [0.5, null, null, null]);
});

test('marcas trazem extras e ataques livres para a passagem única da partitura', () => {
  const rows = [extra(1, 3.36), extra(2, 9.6 + 3.36), freeRow(1, 12, 20)];
  const marks = attackMarks(results([rows[0], rows[1]]), session());
  assert.equal(marks.length, 1);
  assert.equal(marks[0].status, 'extra');
  assert.ok(Math.abs(marks[0].tick - 22.4) < 1e-9, `tick ${marks[0].tick}`);
  assert.deepEqual(marks[0].rows.map(row => row.repetition), [1, 2]);
  assert.deepEqual(attackMarks(results([rows[0], rows[1]]), session(), 1)[0].rows.map(row => row.repetition), [1]);
  const free = attackMarks(results([rows[2]], { mode: 'free', repetitions: 1 }), session());
  assert.deepEqual(free.map(mark => [mark.status, mark.tick]), [['free', 12]]);
  assert.deepEqual(attackMarks(results([matched('a', 1, 0), missed('b', 1)]), session()), []);
});

test('identidade de comparação exige mesmo material, trecho, andamento, repetições, modo e objetivo', () => {
  const base = session();
  const rows = [matched('a', 1, 0)];
  const key = comparisonKey(base, results(rows));
  assert.equal(key, comparisonKey(session(), results([matched('a', 1, 20)])));
  assert.notEqual(key, comparisonKey(base, results(rows, { bpm: 90 })));
  assert.notEqual(key, comparisonKey(base, results(rows, { repetitions: 1 })));
  assert.notEqual(key, comparisonKey(base, results(rows, { mode: 'style' })));
  assert.notEqual(key, comparisonKey(base, results(rows, { goal: 'pitch' })));
  assert.notEqual(key, comparisonKey(base, results(rows, { startBar: 1, loopBars: 3 })));
  assert.notEqual(key, comparisonKey(base, results(rows), 'exercise'));
  assert.notEqual(key, comparisonKey(session({ notes: [{ id: 'z', start: 0, duration: 16, pitch: 60 }] }), results(rows)));
  const fingerprint = exerciseFingerprint(base);
  assert.equal(fingerprint, exerciseFingerprint({ ...base, bpm: 140, loop: { startBar: 1, endBar: 3 } }));
  assert.notEqual(fingerprint, exerciseFingerprint({ ...base, subdivision: 8 }));
});

test('memória de comparação devolve a tentativa anterior da mesma chave', () => {
  const memory = createComparisonMemory(2);
  const summary = resultSummary(results([matched('a', 1, 0), missed('b', 1)]), session());
  const entry = comparisonEntry(summary);
  assert.deepEqual(entry, { kind: 'attacks', ok: 1, expected: 2 });
  assert.equal(memory.previous('k'), null);
  memory.record('k', entry);
  assert.deepEqual(memory.previous('k'), { key: 'k', ...entry });
  memory.record('other', { kind: 'attacks', ok: 0, expected: 2 });
  memory.record('k', { kind: 'attacks', ok: 2, expected: 2 });
  assert.equal(memory.previous('k').ok, 2);
  assert.equal(memory.previous('missing'), null);
  assert.equal(memory.size, 2);
});
