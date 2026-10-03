import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, summarizeFeedback } from '../src/feedback.js';

// bpm=60 -> tickSeconds=0.25s (valores exatos em binario, evita ruido de
// ponto flutuante nas asserções). barSeconds = 16*0.25 = 4s.
// matchWindowMs = 125, toleranceMs = 62.5 (ver comentario de feedback.js).
const BPM = 60;

test('evaluate: execucao perfeita das 4 repeticoes produz apenas matched com onset/ending ok', () => {
  const notes = [
    { id: 'n1', start: 0, duration: 1 },
    { id: 'n2', start: 4, duration: 2 },
    { id: 'n3', start: 8, duration: 4 },
    { id: 'n4', start: 14, duration: 2 },
  ];
  const barSeconds = 4;
  const attempts = [];
  for (let rep = 0; rep < 4; rep += 1) {
    for (const note of notes) {
      attempts.push({
        start: rep * barSeconds + note.start * 0.25,
        end: rep * barSeconds + (note.start + note.duration) * 0.25,
      });
    }
  }

  const { rows } = evaluate(notes, attempts, BPM);
  assert.equal(rows.length, 16);
  for (const row of rows) {
    assert.equal(row.kind, 'matched');
    assert.equal(row.onset, 'ok');
    assert.equal(row.ending, 'ok');
    assert.equal(row.onsetMs, 0);
    assert.equal(row.endMs, 0);
  }
  assert.deepEqual(rows.map((r) => r.repetition), [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
});

test('evaluate: onset ok e ending atrasado sao classificados de forma independente', () => {
  const notes = [{ id: 'n1', start: 4, duration: 2 }]; // esperado rep1: start=1.0, end=1.5
  const attempts = [{ start: 1.0, end: 1.6 }]; // end 100ms tarde (> tolerance 62.5, <= window 125)
  const { rows } = evaluate(notes, attempts, BPM);
  const first = rows[0];
  assert.equal(first.kind, 'matched');
  assert.equal(first.onset, 'ok');
  assert.equal(first.onsetMs, 0);
  assert.equal(first.ending, 'late');
  assert.ok(Math.abs(first.endMs - 100) < 1e-9);
});

test('evaluate: onset atrasado e ending ok sao classificados de forma independente (vice-versa)', () => {
  const notes = [{ id: 'n1', start: 4, duration: 2 }]; // esperado rep1: start=1.0, end=1.5
  const attempts = [{ start: 1.1, end: 1.5 }]; // onset 100ms tarde, end exato
  const { rows } = evaluate(notes, attempts, BPM);
  const first = rows[0];
  assert.equal(first.kind, 'matched');
  assert.equal(first.onset, 'late');
  assert.ok(Math.abs(first.onsetMs - 100) < 1e-9);
  assert.equal(first.ending, 'ok');
  assert.equal(first.endMs, 0);
});

test('evaluate: duracao correta nao "corrige" uma nota deslocada (onset e ending refletem o deslocamento)', () => {
  // Nota dura 3 ticks = 0.75s. Tentativa inteira deslocada +90ms (duracao
  // preservada: actualEnd-actualStart === expectedEnd-expectedStart), mas
  // isso NAO deve produzir onset/ending 'ok' so porque a duracao bateu.
  const notes = [{ id: 'n1', start: 0, duration: 3 }]; // esperado rep1: start=0, end=0.75
  const shiftSeconds = 0.09; // 90ms: > tolerance(62.5), <= window(125)
  const attempts = [{ start: 0 + shiftSeconds, end: 0.75 + shiftSeconds }];
  const { rows } = evaluate(notes, attempts, BPM);
  const first = rows[0];
  assert.equal(first.kind, 'matched');
  assert.equal(first.onset, 'late');
  assert.equal(first.ending, 'late');
  assert.ok(Math.abs(first.onsetMs - 90) < 1e-9);
  assert.ok(Math.abs(first.endMs - 90) < 1e-9);
});

test('evaluate: notas omitidas (sem tentativas) geram missed para as 4 repeticoes', () => {
  const notes = [{ id: 'n1', start: 0, duration: 1 }];
  const { rows } = evaluate(notes, [], BPM);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.kind, 'missed');
    assert.equal(row.noteId, 'n1');
    assert.equal(row.actualStart, undefined);
  }
  assert.deepEqual(rows.map((r) => r.repetition), [1, 2, 3, 4]);
});

test('evaluate: tentativas sem frase esperada geram extra com repeticao estimada pelo tempo absoluto', () => {
  const { rows } = evaluate([], [{ start: 0.5, end: 0.6 }], BPM);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'extra');
  assert.equal(rows[0].repetition, 1);
  assert.equal(rows[0].actualStart, 0.5);
  assert.equal(rows[0].noteId, undefined);
});

test('evaluate: omitida seguida de extra isolada, matching ordenado conservador nao confunde as duas', () => {
  const notes = [{ id: 'n1', start: 0, duration: 1 }]; // onsets esperados: 0, 4, 8, 12
  const attempts = [
    { start: 0, end: 0.25 }, // casa com rep1 exatamente
    { start: 1.9, end: 2.0 }, // isolada, longe de rep2 (esperado 4s) -> extra
  ];
  const { rows } = evaluate(notes, attempts, BPM);
  assert.deepEqual(rows.map((r) => r.kind), ['matched', 'extra', 'missed', 'missed', 'missed']);
  assert.equal(rows[0].repetition, 1);
  assert.equal(rows[1].repetition, 1);
  assert.equal(rows[1].actualStart, 1.9);
  assert.deepEqual(rows.slice(2).map((r) => r.repetition), [2, 3, 4]);
});

test('evaluate: matching cross-bar, notas adjacentes entre o fim de um compasso e o inicio do proximo', () => {
  // n2 no tick0, n1 no tick15 (end=16, toca a borda do compasso). O onset de
  // n1/rep1 (3.75s) e o onset de n2/rep2 (4.0s) distam apenas 1 tick (250ms),
  // cruzando a fronteira de compasso; o matching continuo deve atribuir cada
  // tentativa a repeticao/nota corretas sem confundir os dois lados da borda.
  const notes = [
    { id: 'n2', start: 0, duration: 1 },
    { id: 'n1', start: 15, duration: 1 },
  ];
  const barSeconds = 4;
  const attempts = [];
  for (let rep = 0; rep < 2; rep += 1) {
    attempts.push({ start: rep * barSeconds + 0, end: rep * barSeconds + 0.25 });
    attempts.push({ start: rep * barSeconds + 3.75, end: rep * barSeconds + 4.0 });
  }

  const { rows } = evaluate(notes, attempts, BPM);
  const firstFour = rows.slice(0, 4);
  assert.deepEqual(firstFour.map((r) => r.kind), ['matched', 'matched', 'matched', 'matched']);
  assert.deepEqual(firstFour.map((r) => r.noteId), ['n2', 'n1', 'n2', 'n1']);
  assert.deepEqual(firstFour.map((r) => r.repetition), [1, 1, 2, 2]);
  for (const row of firstFour) {
    assert.equal(row.onset, 'ok');
    assert.equal(row.ending, 'ok');
  }
  assert.deepEqual(rows.slice(4).map(r => [r.kind, r.noteId, r.repetition]),
    [['missed', 'n2', 3], ['missed', 'n1', 3], ['missed', 'n2', 4], ['missed', 'n1', 4]]);
});

test('limites inclusivos classificam ataque e término separadamente', () => {
  const notes = [{id: 'a', start: 4, duration: 2}];
  const {rows} = evaluate(notes, [
    {start: 1 - 0.0625, end: 1.5 + 0.0625},
    {start: 5 - 0.125, end: 5.5},
    {start: 9 + 0.125, end: 9.5 - 0.125},
  ], BPM);
  assert.deepEqual(rows.slice(0, 3).map(r => [r.kind, r.onset, r.ending]),
    [['matched', 'ok', 'ok'], ['matched', 'early', 'ok'], ['matched', 'late', 'early']]);
});

test('deslocamento fora da janela produz omitida e extra, nunca correta pela duração', () => {
  const notes = [{id: 'a', start: 4, duration: 3}];
  const {rows} = evaluate(notes, [{start: 1.2, end: 1.95}], BPM);
  assert.deepEqual(rows.map(r => [r.kind, r.repetition]),
    [['missed', 1], ['extra', 1], ['missed', 2], ['missed', 3], ['missed', 4]]);
  assert.equal(rows[1].actualStart, 1.2);
  assert.equal(rows[1].actualEnd, 1.95);
});

test('nota mantida através da emenda não substitui o ataque do próximo compasso', () => {
  const notes = [{id: 'first', start: 0, duration: 1}, {id: 'last', start: 15, duration: 1}];
  const {rows} = evaluate(notes, [{start: 3.75, end: 4.5}], BPM);
  const held = rows.find(r => r.kind === 'matched');
  assert.equal(held.noteId, 'last');
  assert.equal(held.repetition, 1);
  assert.equal(held.onset, 'ok');
  assert.equal(held.ending, 'late');
  assert.equal(held.endMs, 500);
  assert.equal(rows.find(r => r.noteId === 'first' && r.repetition === 2).kind, 'missed');
});

test('evaluate: frase de 2 compassos repete a cada 8 s e casa notas do segundo compasso', () => {
  // barSeconds=4; com bars=2 cada repetição dura 8 s. Nota no tick 20 (5.0 s)
  // aparece nas repetições 1..4 em 5.0, 13.0, 21.0 e 29.0 s.
  const notes = [{id: 'a', start: 20, duration: 4}];
  const attempts = [];
  for (let rep = 0; rep < 4; rep += 1) {
    attempts.push({start: 5.0 + rep * 8, end: 6.0 + rep * 8});
  }
  const {rows} = evaluate(notes, attempts, BPM, 2);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.kind, 'matched');
    assert.equal(row.onset, 'ok');
    assert.equal(row.ending, 'ok');
  }
  assert.deepEqual(rows.map(r => r.expectedStart), [5.0, 13.0, 21.0, 29.0]);
});

test('evaluate: com bars=2, tentativa além da primeira repetição casa com a segunda, não vira extra', () => {
  const notes = [{id: 'a', start: 0, duration: 4}];
  const {rows} = evaluate(notes, [{start: 8.0, end: 9.0}], BPM, 2);
  const matched = rows.find(r => r.kind === 'matched');
  assert.equal(matched.repetition, 2);
  assert.equal(matched.onset, 'ok');
  assert.equal(rows.filter(r => r.kind === 'extra').length, 0);
});

test('summarizeFeedback: execução exata conta todos os ataques e términos corretos', () => {
  const notes = [{id: 'a', start: 4, duration: 2}];
  const attempts = [0, 4, 8, 12].map(offset => ({start: 1 + offset, end: 1.5 + offset}));
  const summary = summarizeFeedback(evaluate(notes, attempts, BPM));
  assert.deepEqual({...summary, advice: []}, {
    expected: 4, matched: 4, missed: 0, extra: 0, attackOk: 4, endOk: 4, advice: [],
  });
});

test('summarizeFeedback: ataque correto e término errado têm contagens independentes', () => {
  const notes = [{id: 'a', start: 4, duration: 2}];
  const attempts = [0, 4, 8, 12].map(offset => ({start: 1 + offset, end: 1.625 + offset}));
  const summary = summarizeFeedback(evaluate(notes, attempts, BPM));
  assert.equal(summary.expected, 4);
  assert.equal(summary.matched, 4);
  assert.equal(summary.attackOk, 4);
  assert.equal(summary.endOk, 0);
});

test('summarizeFeedback: ataque errado e término correto têm contagens independentes', () => {
  const notes = [{id: 'a', start: 4, duration: 2}];
  const attempts = [0, 4, 8, 12].map(offset => ({start: 1.125 + offset, end: 1.5 + offset}));
  const summary = summarizeFeedback(evaluate(notes, attempts, BPM));
  assert.equal(summary.expected, 4);
  assert.equal(summary.matched, 4);
  assert.equal(summary.attackOk, 0);
  assert.equal(summary.endOk, 4);
});

test('summarizeFeedback: sem tentativas conta todas as notas esperadas como missed', () => {
  const summary = summarizeFeedback(evaluate([{id: 'a', start: 0, duration: 1}], [], BPM));
  assert.deepEqual({...summary, advice: []}, {
    expected: 4, matched: 0, missed: 4, extra: 0, attackOk: 0, endOk: 0, advice: [],
  });
});

test('summarizeFeedback: extras e notas sem correspondência não contam como acertos', () => {
  const notes = [{id: 'a', start: 0, duration: 1}];
  const summary = summarizeFeedback(evaluate(notes, [
    {start: 0, end: 0.25},
    {start: 4.25, end: 4.5},
  ], BPM));
  assert.deepEqual({...summary, advice: []}, {
    expected: 4, matched: 1, missed: 3, extra: 1, attackOk: 1, endOk: 1, advice: [],
  });
});

test('summarizeFeedback: referência vazia não conta notas esperadas ou acertos', () => {
  for (const attempts of [[], [{start: 0.5, end: 0.75}]]) {
    const summary = summarizeFeedback(evaluate([], attempts, BPM));
    assert.deepEqual({...summary, advice: []}, {
      expected: 0, matched: 0, missed: 0, extra: attempts.length, attackOk: 0, endOk: 0, advice: [],
    });
  }
});

test('summarizeFeedback: erros de ataque e término coexistem com extra e missed', () => {
  const notes = [{id: 'a', start: 4, duration: 2}];
  const summary = summarizeFeedback(evaluate(notes, [
    {start: 1.125, end: 1.625},
    {start: 3, end: 3.5},
  ], BPM));
  assert.deepEqual({...summary, advice: []}, {
    expected: 4, matched: 1, missed: 3, extra: 1, attackOk: 0, endOk: 0, advice: [],
  });
});

test('summarizeFeedback: limites inclusivos de tolerância contam ataques e términos corretos', () => {
  const notes = [{id: 'a', start: 4, duration: 2}];
  const summary = summarizeFeedback(evaluate(notes, [
    {start: 1 - 0.0625, end: 1.5 + 0.0625},
    {start: 5 + 0.0625, end: 5.5 - 0.0625},
    {start: 9 - 0.125, end: 9.5 + 0.125},
    {start: 13 + 0.125, end: 13.5 - 0.125},
  ], BPM));
  assert.deepEqual({...summary, advice: []}, {
    expected: 4, matched: 4, missed: 0, extra: 0, attackOk: 2, endOk: 2, advice: [],
  });
});
