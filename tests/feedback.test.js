import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSession, evaluate, summarizeFeedback, suggestTempo } from '../src/feedback.js';
import { createSession } from '../src/session.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const basic = (overrides = {}) => createSession({ bpm: 60, notes: [{ id: 'a', start: 4, duration: 2, pitch: 60 }], training: { goal: 'duration' }, ...overrides });
const played = (shift = 0, endShift = shift) => [0, 4, 8, 12].map(offset => ({ start: 1 + offset + shift, end: 1.5 + offset + endShift, pitch: 60 }));

test('execução perfeita casa ataques, términos, alturas e repetições contínuas', () => {
  const session = basic();
  const result = evaluateSession(session, played());
  assert.equal(result.rows.length, 4);
  assert.ok(result.rows.every(row => row.kind === 'matched' && row.onset === 'ok' && row.ending === 'ok' && row.pitchOk));
  assert.deepEqual(result.rows.map(row => row.repetition), [1, 2, 3, 4]);
  close(result.toleranceMs, 62.5);
  close(result.matchWindowMs, 125);
  assert.deepEqual(result.stats.onset, { count: 4, meanMs: 0, medianMs: 0, sdMs: 0, meanAbsMs: 0 });
  const summary = summarizeFeedback(result);
  assert.deepEqual([summary.expected, summary.matched, summary.missed, summary.extra, summary.attackOk, summary.endOk, summary.pitchChecked, summary.pitchOk], [4, 4, 0, 0, 4, 4, 4, 4]);
});

test('ataque e término têm classificações independentes e limites inclusivos', () => {
  for (const [onset, ending, expectedOnset, expectedEnd] of [[0, 0.1, 'ok', 'late'], [0.1, 0, 'late', 'ok'], [-0.1, 0.1, 'early', 'late'], [-0.0625, 0.0625, 'ok', 'ok']]) {
    const result = evaluateSession(basic(), played(onset, ending));
    assert.ok(result.rows.every(row => row.onset === expectedOnset && row.ending === expectedEnd));
  }
  const shifted = evaluateSession(basic(), played(0.09));
  assert.ok(shifted.rows.every(row => row.onset === 'late' && row.ending === 'late'));
  const summary = summarizeFeedback(evaluateSession(basic(), played(0, 0.1)));
  assert.equal(summary.attackOk, 4);
  assert.equal(summary.endOk, 0);
});

test('omissões e extras são distintos, mesmo fora de todas as repetições', () => {
  const omitted = evaluateSession(basic(), []);
  assert.ok(omitted.rows.every(row => row.kind === 'missed'));
  assert.equal(summarizeFeedback(omitted).missed, 4);
  const outside = evaluateSession(basic(), [{ start: 1.2, end: 1.7 }, { start: 20, end: 21 }]);
  assert.equal(outside.rows.filter(row => row.kind === 'missed').length, 4);
  assert.equal(outside.rows.filter(row => row.kind === 'extra').length, 2);
  assert.equal(outside.rows.at(-1).repetition, 4);
  const empty = evaluateSession(createSession({ bpm: 60 }), [{ start: 0.5, end: 0.6 }]);
  assert.equal(empty.rows[0].kind, 'extra');
  assert.equal(empty.stats.onset.meanMs, null);
  assert.equal(summarizeFeedback(empty).expected, 0);
});

test('casamento atravessa barras e emendas sem fundir ataques adjacentes', () => {
  const session = createSession({ bpm: 60, notes: [{ id: 'first', start: 0, duration: 1 }, { id: 'last', start: 15, duration: 1 }], training: { repetitions: 2 } });
  const result = evaluateSession(session, [{ start: 3.75, end: 4.5 }, { start: 3.9375, end: 4.25 }]);
  const rows = result.rows.filter(row => row.kind === 'matched');
  assert.deepEqual(rows.map(row => [row.noteId, row.repetition]), [['last', 1], ['first', 2]]);
  assert.equal(rows[0].onset, 'ok');
  assert.equal(rows[0].ending, 'late');
  assert.equal(rows[1].onset, 'ok');
  const twoBars = createSession({ bpm: 60, bars: 2, notes: [{ id: 'second-bar', start: 20, duration: 4 }], training: { repetitions: 3 } });
  const actual = [5, 13, 21].map(start => ({ start, end: start + 1 }));
  assert.deepEqual(evaluateSession(twoBars, actual).rows.map(row => row.repetition), [1, 2, 3]);
});

test('loop selecionado, meter, swing e offset expressivo definem os dois extremos esperados', () => {
  const session = createSession({ bpm: 60, bars: 3, meter: { beats: 7, unit: 8 }, subdivision: 3, swing: 1 / 3, loop: { startBar: 1, endBar: 3 }, training: { repetitions: 2 }, notes: [
    { id: 'outside', start: 0, duration: 1 }, { id: 'swung', start: 16, duration: 2, pitch: 72, offsetMs: 40 }, { id: 'clipped', start: 40, duration: 2, offsetMs: -30 },
  ] });
  const start = 2 / 3 + 0.04;
  const result = evaluateSession(session, [{ start, end: 1.04, pitch: 72 }, { start: start + 7, end: 8.04, pitch: 71 }, { start: 6.47, end: 6.97 }]);
  assert.equal(result.repetitionSeconds, 7);
  assert.equal(result.barSeconds, 3.5);
  assert.equal(result.loopBars, 2);
  assert.equal(result.startBar, 1);
  assert.ok(result.rows.every(row => row.noteId !== 'outside'));
  const swung = result.rows.filter(row => row.noteId === 'swung');
  close(swung[0].expectedStart, start);
  close(swung[0].expectedEnd, 1.04);
  assert.equal(swung[0].pitchOk, true);
  assert.equal(swung[1].pitchOk, false);
  assert.ok(swung.every(row => row.onset === 'ok' && row.ending === 'ok'));
  const clipped = result.rows.find(row => row.noteId === 'clipped' && row.repetition === 1);
  close(clipped.expectedEnd, 6.97);
});

test('microtempo cruzando a emenda não produz janela negativa nem quebra a ordem dos eventos', () => {
  const session = createSession({ bpm: 300, meter: { beats: 1, unit: 16 }, subdivision: 8, training: { repetitions: 3 }, notes: [{ id: 'early', start: 0, duration: 0.1, offsetMs: -80 }, { id: 'late', start: 0.9, duration: 0.1, offsetMs: 80 }] });
  const expected = [-0.08, -0.03, 0.02].map(start => ({ start, end: start + 0.005 }));
  const result = evaluateSession(session, expected);
  assert.ok(result.matchWindowMs >= 0);
  assert.equal(result.rows.filter(row => row.kind === 'matched').length, 3);
  assert.deepEqual(result.rows.filter(row => row.kind === 'matched').map(row => row.repetition), [1, 2, 3]);
});

test('estilo relata deslocamento pessoal, mas classifica consistência relativa sem apagar desvios absolutos', () => {
  const session = basic({ training: { evaluation: 'style', goal: 'duration' } });
  const result = evaluateSession(session, played(0.09));
  assert.ok(result.rows.every(row => row.onset === 'ok' && row.ending === 'ok'));
  close(result.stats.feelMs, 90);
  assert.ok(result.rows.every(row => Math.abs(row.onsetMs - 90) < 1e-6 && Math.abs(row.relativeOnsetMs) < 1e-6));
  const changing = evaluateSession(session, [0, 4, 8, 12].map((offset, index) => ({ start: 1 + offset + index * 0.02, end: 1.5 + offset })));
  close(changing.stats.driftMsPerRepetition, 20);
});

test('modo livre usa grade de cada barra e swing, sem omissões ou pontuação estética', () => {
  const session = createSession({ bpm: 60, bars: 4, meter: { beats: 7, unit: 8 }, subdivision: 3, swing: 1 / 3, loop: { startBar: 1, endBar: 4 }, training: { evaluation: 'free', repetitions: 2 } });
  const attacks = [0, 3.5, 7, 10.5, 14, 4 / 9];
  const result = evaluateSession(session, attacks.map(start => ({ start, end: start + 0.1, pitch: 64 })));
  assert.ok(result.rows.every(row => row.kind === 'free' && row.onset === 'ok'));
  const atNextBar = result.rows.find(row => row.actualStart === 3.5);
  assert.equal(atNextBar.nearestTick, 28);
  assert.ok(result.rows.every(row => Math.abs(row.deviationMs) < 1e-6));
  const summary = summarizeFeedback(result);
  assert.equal(summary.expected, 0);
  assert.equal(summary.free, attacks.length);
  assert.equal(summary.attackOk, attacks.length);
  assert.equal(summary.pitchOk, null);
});

test('altura ausente não inventa acerto e altura errada não muda o casamento temporal', () => {
  const result = evaluateSession(basic({ training: { goal: 'pitch', repetitions: 3 } }), [{ start: 1, end: 1.5, pitch: 61 }, { start: 5, end: 5.5 }, { start: 9, end: 9.5, pitch: 60 }]);
  assert.ok(result.rows.every(row => row.kind === 'matched'));
  assert.deepEqual(result.rows.map(row => row.pitchOk), [false, null, true]);
  const summary = summarizeFeedback(result);
  assert.equal(summary.pitchChecked, 2);
  assert.equal(summary.pitchOk, 1);
});

test('avaliação rejeita tentativas e parâmetros inválidos sem mutar a entrada', () => {
  const session = basic();
  const attempts = played();
  const before = structuredClone(attempts);
  evaluateSession(session, attempts);
  assert.deepEqual(attempts, before);
  for (const attempts of [null, {}, [null], [{}], [{ start: NaN }], [{ start: 0, end: Infinity }], [{ start: 1, end: 0 }], [{ start: 0, pitch: 128 }], [{ start: 0, pitch: 60.5 }]]) assert.throws(() => evaluateSession(session, attempts), TypeError);
  for (const options of [{ repetitions: 0 }, { repetitions: 65 }, { repetitions: 1.5 }, { goal: 'taste' }, { mode: 'unknown' }]) assert.throws(() => evaluateSession(session, [], options), TypeError);
});

test('sugestão de andamento usa evidências e respeita limites da sessão', () => {
  const session = basic({ training: { tempoStep: 4 } });
  assert.equal(suggestTempo(session, summarizeFeedback(evaluateSession(session, played()))).bpm, 64);
  assert.equal(suggestTempo(session, summarizeFeedback(evaluateSession(session, []))).bpm, 56);
  assert.equal(suggestTempo(createSession({ bpm: 300 }), { expected: 1, matched: 1, attackOk: 1, extra: 0 }).bpm, 300);
  assert.equal(suggestTempo(createSession({ bpm: 30 }), { expected: 1, matched: 0, attackOk: 0, extra: 0 }).bpm, 30);
  assert.equal(suggestTempo(session, { mode: 'free', free: 0 }).bpm, 60);
});

test('é possível avaliar uma frase explícita com opções musicais sem sessão de transporte', () => {
  const notes = [{ id: 'a', start: 14, duration: 2 }];
  const result = evaluate(notes, [{ start: 3.5, end: 4 }], 60, 2, { meter: { beats: 7, unit: 8 }, repetitions: 1 });
  assert.equal(result.rows[0].kind, 'matched');
  assert.equal(result.repetitionSeconds, 7);
});
