import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validPhrase, isValidNote, spanTicks, addNote, moveNote, resizeNote, updateNote, deleteNote, completeNote, MIN_DURATION } from '../src/model.js';
import { createSession } from '../src/session.js';

const span = createSession({ bars: 3, meter: { beats: 7, unit: 8 }, subdivision: 3 });
const note = (id, start, duration, fields = {}) => completeNote({ id, start, duration, ...fields });

test('frases fracionárias respeitam compasso, monofonia, adjacência e identidade', () => {
  const notes = [note('a', 0, 4 / 3), note('b', 4 / 3, 8 / 3), note('fim', 40, 2)];
  assert.equal(spanTicks(span), 42);
  assert.equal(validPhrase(notes, span), true);
  assert.equal(validPhrase([...notes, note('fora', 42, 1)], span), false);
  assert.equal(validPhrase([note('a', 0, 2), note('b', 1.5, 2)], span), false);
  assert.equal(validPhrase([note('a', 0, 1), note('a', 2, 1)], span), false);
  assert.equal(validPhrase([], span), true);
  assert.equal(validPhrase([note('sustentada', 13, 16)], span), true);
});

test('todos os tamanhos canônicos e denominadores têm limites reais', () => {
  for (let bars = 1; bars <= 16; bars += 1) {
    for (const unit of [2, 4, 8, 16]) {
      const session = createSession({ bars, meter: { beats: 5, unit } });
      const end = bars * 80 / unit;
      assert.equal(validPhrase([note('fim', end - 0.5, 0.5)], session), true);
      assert.equal(validPhrase([note('fora', end - 0.5, 0.75)], session), false);
    }
  }
  for (const invalid of [null, {}, { bars: 0 }, { bars: 17 }, { bars: 1, meter: { beats: -4, unit: -4 } }, { bars: 1, meter: { beats: 17, unit: 4 } }, { bars: 1, meter: { beats: 4, unit: 3 } }]) {
    assert.equal(validPhrase([], invalid), false);
    const original = [];
    assert.equal(addNote(original, 0, 1, invalid), original);
  }
});

test('adição completa altura, dinâmica e articulação sem mutar a entrada', () => {
  const original = Object.freeze([]);
  const added = addNote(original, 4 / 3, 8 / 3, span, { pitch: 60, velocity: 0.3, articulation: 'ghost', offsetMs: -25 });
  assert.notEqual(added, original);
  assert.deepEqual(added[0], { id: added[0].id, start: 1.333333333, duration: 2.666666667, pitch: 60, velocity: 0.3, articulation: 'ghost', offsetMs: -25 });
  assert.equal(addNote(original, 0, 1, span)[0].pitch, 69);
  const adjacent = addNote(added, 4, 1, span);
  assert.equal(adjacent.length, 2);
  assert.notEqual(adjacent[0].id, adjacent[1].id);
  assert.equal(addNote(adjacent, 3, 2, span), adjacent);
});

test('edições rejeitam valores inválidos em vez de corrigir null ou arredondar negativos', () => {
  const original = [note('a', 0, 1)];
  for (const fields of [null, [], { pitch: null }, { pitch: 60.5 }, { pitch: 128 }, { velocity: null }, { velocity: 1.01 }, { velocity: NaN }, { articulation: null }, { articulation: 'unknown' }, { offsetMs: null }, { offsetMs: 81 }, { unexpected: 1 }]) {
    assert.equal(addNote(original, 2, 1, span, fields), original);
  }
  for (const [start, duration] of [[-1e-10, 1], [NaN, 1], [Infinity, 1], [2, 0], [2, MIN_DURATION / 2], [2, Infinity], [42, 1]]) {
    assert.equal(addNote(original, start, duration, span), original);
  }
  for (const patch of [null, [], { id: 'new' }, { unknown: true }, { start: -1e-10 }, { duration: 0 }, { pitch: null }, { velocity: Infinity }]) {
    assert.equal(updateNote(original, 'a', patch, span), original);
  }
  for (const limit of [undefined, NaN, Infinity, 0, -1]) assert.equal(isValidNote(original[0], limit), false);
});

test('movimento, duração e expressão preservam os outros campos e notas congeladas', () => {
  const first = Object.freeze(note('a', 0, 4 / 3, { pitch: 72, articulation: 'accent' }));
  const second = Object.freeze(note('b', 8, 2));
  const original = Object.freeze([first, second]);
  const moved = moveNote(original, 'a', 16 / 3, span);
  assert.equal(moved[0].start, 5.333333333);
  assert.equal(moved[0].duration, first.duration);
  assert.equal(moved[0].pitch, 72);
  assert.equal(moved[1], second);
  const resized = resizeNote(moved, 'a', 8 / 3, span);
  assert.equal(resized[0].duration, 2.666666667);
  assert.equal(validPhrase(resized, span), true);
  assert.equal(resizeNote(resized, 'a', 3, span), resized);
  assert.equal(moveNote(original, 'a', 8, span), original);
  assert.equal(moveNote(original, 'missing', 2, span), original);
  const expressive = updateNote(original, 'a', { velocity: 0.2, offsetMs: 45, articulation: 'staccato' }, span);
  assert.equal(expressive[0].pitch, 72);
  assert.equal(expressive[0].offsetMs, 45);
  assert.equal(first.velocity, 0.8);
  assert.deepEqual(deleteNote(original, 'a'), [second]);
  assert.equal(deleteNote(original, 'missing'), original);
});

test('edição nunca propaga uma frase já inválida', () => {
  for (const notes of [[null], [note('a', 0, 3), note('b', 2, 2)], [note('fora', 43, 1)]]) {
    assert.equal(addNote(notes, 10, 1, span), notes);
    assert.equal(updateNote(notes, 'a', { start: 4 }, span), notes);
  }
});
