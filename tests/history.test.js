import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../src/history.js';
import { createSession, patchSession } from '../src/session.js';
import { parseChordSymbol } from '../src/progression.js';

const session = (bpm = 100) => createSession({ bpm, bars: 3, meter: { beats: 7, unit: 8 }, subdivision: 3, notes: [{ id: 'a', start: 4 / 3, duration: 8 / 3, pitch: 60 }] });

test('undo/redo percorrem sessões completas, sem clonar os retornos', () => {
  const history = new History();
  assert.equal(history.current, null);
  assert.equal(history.undo(), null);
  assert.equal(history.redo(), null);
  const states = [session(), session(120), session(140)];
  for (const state of states) history.push(state);
  const middle = history.undo();
  assert.deepEqual(middle, states[1]);
  const first = history.undo();
  assert.deepEqual(first, states[0]);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, true);
  assert.equal(history.undo(), null);
  assert.equal(history.redo(), middle);
  assert.deepEqual(history.redo(), states[2]);
  assert.equal(history.redo(), null);
  assert.equal(history.undo(), middle);
  assert.equal(history.undo(), first);
});

test('igualdade estrutural preserva redo, inclusive objetos de extensão reordenados', () => {
  const history = new History();
  const a = createSession({ extensions: { repertoire: { title: 'Peça', markers: [1, 2] }, practice: { goal: 'pulse' } } });
  history.push(a);
  history.push(patchSession(a, { bpm: 120 }));
  const stored = history.undo();
  history.push({ ...a, extensions: { practice: { goal: 'pulse' }, repertoire: { markers: [1, 2], title: 'Peça' } } });
  assert.equal(history.current, stored);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, true);
  history.push(patchSession(a, { name: 'Outra sessão' }));
  assert.equal(history.canRedo, false);
  assert.equal(history.redo(), null);
  assert.equal(history.undo(), stored);
});

test('cada campo musical, loop, treino, mixer e metadados viajam no snapshot', () => {
  const history = new History();
  const initial = session();
  const edits = [
    { name: 'Estudo' }, { bpm: 130 }, { bars: 4 }, { meter: { beats: 5, unit: 4 } },
    { subdivision: 5 }, { swing: 1 / 3, swingUnit: 'sixteenth' },
    { notes: [{ ...initial.notes[0], pitch: 72, velocity: 0.4, articulation: 'ghost', offsetMs: -20 }] },
    { progression: { enabled: true, chords: [{ ...parseChordSymbol('G7/B'), startBar: 0 }], cycleBars: 1 } },
    { drums: { enabled: true, style: 'funk', density: 'busy', seed: 42 } },
    { band: { bassEnabled: true, role: 'harmony', mode: 'follow' } },
    { loop: { startBar: 1, endBar: 3 } },
    { training: { repetitions: 7, countInBars: 2, goal: 'pitch', evaluation: 'style', monitor: false } },
    { metronome: { pattern: 'offbeats', silentBars: 2 } },
    { companion: { enabled: true, pulses: 5, spanBeats: 3 } },
    { generator: { seed: 123, lengths: 'long' } },
    { timbres: { phrase: 'marimba' } }, { mixer: { bass: { volume: 0.25, muted: true } } },
    { form: { enabled: true, loop: false, sections: [{ id: 'A', name: 'Tema', kind: 'A', startBar: 0, endBar: 3, repeats: 2, bpm: 90, meter: { beats: 3, unit: 4 }, density: 'sparse' }] } },
    { extensions: { annotations: [{ text: 'Acentuar', tick: 4 / 3 }] } },
  ];
  const states = [initial];
  history.push(initial);
  for (const edit of edits) {
    states.push(patchSession(states.at(-1), edit));
    history.push(states.at(-1));
  }
  for (let index = states.length - 2; index >= 0; index -= 1) assert.deepEqual(history.undo(), states[index]);
  for (let index = 1; index < states.length; index += 1) assert.deepEqual(history.redo(), states[index]);
});

test('snapshots são cópias profundas congeladas, inclusive acordes e extensões', () => {
  const input = createSession({ progression: { chords: [parseChordSymbol('Cmaj7')], enabled: true }, extensions: { tags: ['estudo'] } });
  const expected = structuredClone(input);
  const history = new History();
  history.push(input);
  input.progression.chords[0].notes[0].midi = 90;
  input.extensions.tags.push('alterado');
  input.mixer.bass.volume = 0;
  assert.deepEqual(history.current, expected);
  assert.throws(() => { history.current.progression.chords[0].notes[0].midi = 30; }, TypeError);
  assert.throws(() => history.current.extensions.tags.push('x'), TypeError);
  assert.throws(() => { history.current.mixer.bass.muted = true; }, TypeError);
});

test('ordem de notas é uma edição; estados inválidos não destroem redo', () => {
  const a = createSession({ notes: [{ id: 'a', start: 0, duration: 1 }, { id: 'b', start: 2, duration: 1 }] });
  const history = new History();
  history.push(a);
  history.push({ ...a, notes: [...a.notes].reverse() });
  assert.deepEqual(history.undo(), a);
  for (const invalid of [null, undefined, false, [], {}, { ...a, bpm: 301 }, { ...a, bars: 65 }, { ...a, notes: [{ id: 'a', start: 15, duration: 2 }] }, { ...a, notes: [a.notes[0], { ...a.notes[1], start: 0.5 }] }]) {
    assert.throws(() => history.push(invalid), TypeError);
    assert.equal(history.canRedo, true);
  }
});

test('limite conta o atual, descarta antigos e funciona depois de branching', () => {
  const history = new History(3);
  for (const bpm of [80, 90, 100, 110, 120]) history.push(session(bpm));
  assert.equal(history.undo().bpm, 110);
  assert.equal(history.undo().bpm, 100);
  assert.equal(history.undo(), null);
  assert.equal(history.redo().bpm, 110);
  history.push(session(130));
  assert.equal(history.redo(), null);
  assert.equal(history.undo().bpm, 110);
  assert.equal(history.undo().bpm, 100);
  assert.equal(history.undo(), null);
  const single = new History(1);
  single.push(session()); single.push(session(120));
  assert.equal(single.undo(), null);
  assert.equal(single.redo(), null);
  const standard = new History();
  for (let bpm = 40; bpm <= 140; bpm += 1) standard.push(session(bpm));
  for (let bpm = 139; bpm >= 41; bpm -= 1) assert.equal(standard.undo().bpm, bpm);
  assert.equal(standard.undo(), null);
  for (const limit of [0, -1, 1.5, NaN, Infinity, '3', null]) assert.throws(() => new History(limit), TypeError);
});
