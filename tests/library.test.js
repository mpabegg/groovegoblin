import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROOVES, loadGroove } from '../src/library.js';
import { TICKS_PER_BAR, validPhrase } from '../src/model.js';

for (const groove of GROOVES) {
  test(`library: ${groove.id} carrega uma frase ordenada, monofônica e editável`, () => {
    const state = loadGroove(groove.id);
    assert.ok(Number.isInteger(state.bpm) && state.bpm >= 40 && state.bpm <= 240);
    assert.equal(validPhrase(state.notes, state.bars), true);
    assert.equal(new Set(state.notes.map((note) => note.id)).size, state.notes.length);
    for (let index = 0; index < state.notes.length; index += 1) {
      const note = state.notes[index];
      assert.ok(typeof note.id === 'string' && note.id.length > 0);
      assert.ok(Number.isInteger(note.start) && note.start >= 0);
      assert.ok(Number.isInteger(note.duration) && note.duration >= 1);
      assert.ok(note.start + note.duration <= state.bars * TICKS_PER_BAR);
      if (index > 0) {
        const previous = state.notes[index - 1];
        assert.ok(previous.start + previous.duration <= note.start);
      }
    }
  });

  test(`library: editar ${groove.id} não altera biblioteca nem outros carregamentos`, () => {
    const libraryBefore = structuredClone(groove);
    const edited = loadGroove(groove.id);
    const independent = loadGroove(groove.id);
    const independentBefore = structuredClone(independent);

    // Objetos de nota, array e campos do estado precisam ser editáveis.
    edited.notes[0].start = 1;
    edited.notes[0].duration = 1;
    edited.notes[0].id = 'id-editado';
    edited.notes.pop();
    edited.bpm = 80;
    edited.bars = 4;

    assert.deepEqual(groove, libraryBefore);
    assert.deepEqual(independent, independentBefore);
    assert.deepEqual(loadGroove(groove.id), independentBefore);
  });
}


test('library: cada opção tem ID próprio e produz um ritmo distinto', () => {
  assert.equal(new Set(GROOVES.map((groove) => groove.id)).size, GROOVES.length);
  const rhythms = GROOVES.map((groove) => {
    const state = loadGroove(groove.id);
    return JSON.stringify({ bars: state.bars, starts: state.notes.map((note) => note.start) });
  });
  assert.equal(new Set(rhythms).size, GROOVES.length);
});

test('library: IDs desconhecidos nunca substituem a frase por um fallback', () => {
  for (const id of ['inexistente', '', 'toString', undefined, null, 0, {}, Symbol('groove')]) {
    assert.throws(() => loadGroove(id), RangeError);
  }
});

test('library: pulso adjacente mantém quatro ataques e termina no limite do compasso', () => {
  const state = loadGroove('quarter-pulse');
  assert.equal(state.notes.length, 4);
  for (let index = 1; index < state.notes.length; index += 1) {
    const previous = state.notes[index - 1];
    assert.equal(previous.start + previous.duration, state.notes[index].start);
    assert.notEqual(previous.id, state.notes[index].id);
  }
  const last = state.notes.at(-1);
  assert.equal(last.start + last.duration, TICKS_PER_BAR);
  assert.equal(validPhrase(state.notes, state.bars), true);
});

test('library: tresillo traduz o agrupamento 3+3+2 em colcheias, não tercinas', () => {
  // Notação observada: semínima pontuada, colcheia, pausa de semínima,
  // semínima. Ataques em 1, 2-e, 4; a duração editorial é independente.
  // https://pulse.berklee.edu/content/public/pub_unit_assets/lessons/clave/Bamboula.jpg
  const state = loadGroove('tresillo');
  const starts = state.notes.map((note) => note.start);
  assert.deepEqual(starts, [0, 6, 12]);
  const eighthNoteIntervals = starts.map((start, index) => {
    const next = starts[index + 1] ?? TICKS_PER_BAR;
    return (next - start) / 2;
  });
  assert.deepEqual(eighthNoteIntervals, [3, 3, 2]);
});

test('library: cinquillo mantém os cinco ataques e as duas síncopes da notação', () => {
  // https://pulse.berklee.edu/content/public/pub_unit_assets/lessons/clave/Cinquillo.jpg
  // Semínima, duas colcheias, pausa de colcheia, duas colcheias, pausa.
  const state = loadGroove('cinquillo');
  const beats = state.notes.map((note) => 1 + note.start / 4);
  assert.deepEqual(beats, [1, 2, 2.5, 3.5, 4]);
});

test('library: son clave preserva as posições internas ao inverter seus lados', () => {
  // https://pulse.berklee.edu/?id=4&lesson=14 mostra ambos os sentidos:
  // lado de três: 1, 2-e, 4; lado de dois: 2, 3.
  const threeTwo = loadGroove('son-clave-3-2');
  const twoThree = loadGroove('son-clave-2-3');
  const beatsByBar = (state) => Array.from({ length: state.bars }, (_, bar) => (
    state.notes
      .filter((note) => Math.floor(note.start / TICKS_PER_BAR) === bar)
      .map((note) => 1 + (note.start % TICKS_PER_BAR) / 4)
  ));
  assert.deepEqual(beatsByBar(threeTwo), [[1, 2.5, 4], [2, 3]]);
  assert.deepEqual(beatsByBar(twoThree), [[2, 3], [1, 2.5, 4]]);
  assert.ok(twoThree.notes[0].start > 0, 'a direção 2–3 começa com silêncio');
});
