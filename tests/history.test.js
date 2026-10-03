import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../src/history.js';

function phrase(bpm = 100, bars = 1) {
  return {
    notes: [{ id: 'a', start: 0, duration: 4 }],
    bpm,
    bars,
  };
}

test('History: canUndo e canRedo refletem todos os movimentos e limites', () => {
  const history = new History();
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo(), null);
  assert.equal(history.redo(), null);

  const a = phrase();
  const b = phrase(120);
  history.push(a);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo(), null);

  history.push(b);
  assert.equal(history.canUndo, true);
  assert.equal(history.canRedo, false);
  assert.equal(history.redo(), null);
  assert.deepEqual(history.undo(), a);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, true);
  assert.equal(history.undo(), null);
  assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo(), b);
  assert.equal(history.canUndo, true);
  assert.equal(history.canRedo, false);
});

test('History: push depois de undo remove toda a cauda de redo', () => {
  const history = new History();
  const a = phrase(80);
  const b = phrase(100);
  const c = phrase(120);
  const branch = phrase(140, 2);
  history.push(a);
  history.push(b);
  history.push(c);
  assert.deepEqual(history.undo(), b);
  assert.deepEqual(history.undo(), a);
  assert.equal(history.canRedo, true);

  history.push(branch);
  assert.equal(history.canRedo, false);
  assert.equal(history.redo(), null);
  assert.deepEqual(history.undo(), a);
  assert.equal(history.undo(), null);
  assert.deepEqual(history.redo(), branch);
  assert.equal(history.redo(), null);
});

test('History: igualdade estrutural é no-op e preserva o redo', () => {
  const history = new History();
  const a = phrase();
  const b = phrase(120);
  history.push(a);
  history.push({ bars: 1, bpm: 100, notes: [{ duration: 4, start: 0, id: 'a' }] });
  assert.equal(history.canUndo, false);

  history.push(b);
  const storedA = history.undo();
  history.push(phrase());
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, true);
  const storedB = history.redo();
  assert.deepEqual(storedB, b);
  assert.equal(history.undo(), storedA);
  assert.equal(history.redo(), storedB);
});

test('History: alterações em notas, BPM e compassos criam snapshots distintos', () => {
  const history = new History();
  const a = phrase();
  const moved = { ...phrase(), notes: [{ id: 'a', start: 1, duration: 4 }] };
  const resized = { ...phrase(), notes: [{ id: 'a', start: 1, duration: 5 }] };
  const renamed = { ...phrase(), notes: [{ id: 'b', start: 1, duration: 5 }] };
  const tempo = { ...renamed, bpm: 101 };
  const longer = { ...tempo, bars: 2 };
  const empty = { notes: [], bpm: 101, bars: 2 };
  const states = [a, moved, resized, renamed, tempo, longer, empty];
  for (const state of states) history.push(state);
  for (let index = states.length - 2; index >= 0; index -= 1) {
    assert.deepEqual(history.undo(), states[index]);
  }
  assert.equal(history.undo(), null);
});

test('History: a ordem das notas faz parte da igualdade estrutural', () => {
  const history = new History();
  const a = { notes: [{ id: 'a', start: 0, duration: 4 }, { id: 'b', start: 4, duration: 4 }], bpm: 100, bars: 1 };
  history.push(a);
  history.push({ ...a, notes: [...a.notes].reverse() });
  assert.deepEqual(history.undo(), a);
});

test('History: limite descarta o snapshot mais antigo, incluindo após branching', () => {
  const history = new History(3);
  const states = [80, 90, 100, 110, 120].map(bpm => phrase(bpm));
  for (const state of states) history.push(state);
  assert.deepEqual(history.undo(), states[3]);
  assert.deepEqual(history.undo(), states[2]);
  assert.equal(history.canUndo, false);
  assert.equal(history.undo(), null);
  assert.deepEqual(history.redo(), states[3]);

  const branch = phrase(130);
  history.push(branch);
  assert.equal(history.redo(), null);
  assert.deepEqual(history.undo(), states[3]);
  assert.deepEqual(history.undo(), states[2]);
  assert.equal(history.undo(), null);
});

test('History: limite de um snapshot nunca permite undo ou redo', () => {
  const history = new History(1);
  history.push(phrase());
  history.push(phrase(120));
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo(), null);
  assert.equal(history.redo(), null);
});

test('History: o limite padrão guarda cem snapshots', () => {
  const history = new History();
  for (let bpm = 40; bpm <= 140; bpm += 1) history.push(phrase(bpm));
  for (let bpm = 139; bpm >= 41; bpm -= 1) assert.equal(history.undo().bpm, bpm);
  assert.equal(history.undo(), null);
});

test('History: snapshots são cópias profundas imutáveis, sem reclone no retorno', () => {
  const history = new History();
  const input = phrase();
  const expected = phrase();
  history.push(input);
  input.notes[0].id = 'alterada';
  input.notes[0].start = 5;
  input.notes[0].duration = 2;
  input.notes.push({ id: 'nova', start: 8, duration: 1 });
  input.bpm = 200;
  input.bars = 4;
  history.push(phrase(120));

  const stored = history.undo();
  assert.deepEqual(stored, expected);
  assert.notEqual(stored, input);
  assert.notEqual(stored.notes, input.notes);
  assert.notEqual(stored.notes[0], input.notes[0]);
  assert.equal(Object.isFrozen(stored), true);
  assert.equal(Object.isFrozen(stored.notes), true);
  assert.equal(Object.isFrozen(stored.notes[0]), true);
  assert.throws(() => { stored.bpm = 180; }, TypeError);
  assert.throws(() => { stored.notes[0].start = 3; }, TypeError);
  assert.throws(() => { stored.notes.push({ id: 'x', start: 8, duration: 1 }); }, TypeError);
  history.redo();
  assert.equal(history.undo(), stored);
  assert.deepEqual(stored, expected);
});

test('History: rejeita estados inválidos com TypeError sem destruir redo', () => {
  const history = new History();
  history.push(phrase());
  history.push(phrase(120));
  history.undo();
  const invalid = [
    null, undefined, false, 'frase', [], {},
    { ...phrase(), notes: null },
    { ...phrase(), notes: [{ id: 'a', start: 0, duration: 4 }, { id: 'b', start: 3, duration: 4 }] },
    { ...phrase(), notes: [{ id: 'a', start: 0, duration: 1 }, { id: 'a', start: 4, duration: 1 }] },
    { ...phrase(), notes: [{ id: 'a', start: 15, duration: 2 }] },
    ...[39, 241, 100.5, NaN, Infinity, '100'].map(bpm => ({ ...phrase(), bpm })),
    ...[0, 3, 8, 1.5, '1', undefined].map(bars => ({ ...phrase(), bars })),
  ];
  for (const state of invalid) {
    assert.throws(() => history.push(state), TypeError);
    assert.equal(history.canUndo, false);
    assert.equal(history.canRedo, true);
  }
  assert.deepEqual(history.redo(), phrase(120));
});

test('History: aceita os limites de BPM e frases de um, dois e quatro compassos', () => {
  const history = new History();
  for (const bars of [1, 2, 4]) {
    for (const bpm of [40, 240]) {
      history.push({ notes: [{ id: 'fim', start: bars * 16 - 1, duration: 1 }], bpm, bars });
    }
  }
  assert.equal(history.undo().bars, 4);
  assert.equal(history.undo().bars, 2);
});

test('History: rejeita limites que não sejam inteiros positivos', () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity, '3', null]) {
    assert.throws(() => new History(limit), TypeError);
  }
});
