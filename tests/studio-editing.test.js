import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { parseChordSymbol } from '../src/progression.js';
import { editNotes, pasteNotes, editChords, playbackEditPolicy, rememberedDuration, rememberDuration, DURATION_KEY } from '../src/studio-editing.js';
import { History } from '../src/history.js';

const session = () => createSession({ bars: 2, notes: [{ id: 'a', start: 0, duration: 2, pitch: 60 }, { id: 'b', start: 2, duration: 2, pitch: 62 }, { id: 'c', start: 12, duration: 2, pitch: 64 }] });
test('grouped adjacent moves validate the final monophonic phrase, atomically', () => {
  const source = session();
  const moved = editNotes(source.notes, ['a', 'b'], note => ({ start: note.start + 2 }), source);
  assert.deepEqual(moved.map(note => note.start), [2, 4, 12]);
  assert.equal(source.notes[0].start, 0);
  assert.equal(editNotes(source.notes, ['a', 'b'], note => ({ start: note.start + 10 }), source), source.notes);
  assert.equal(editNotes(source.notes, ['a', 'b'], note => ({ start: note.start - 1 }), source), source.notes);
  assert.equal(editNotes(source.notes, ['a', 'b'], { duration: 3 }, source), source.notes);
});
test('multi intensity and delete each occupy one undo step', () => {
  const source = session(); const history = new History(); history.push(source);
  const notes = editNotes(source.notes, ['a', 'b'], { velocity: 0.35 }, source);
  history.push({ ...source, notes });
  assert.deepEqual(notes.map(note => note.velocity), [0.35, 0.35, 0.8]);
  const deleted = { ...source, notes: notes.filter(note => !['a', 'b'].includes(note.id)) }; history.push(deleted);
  assert.deepEqual(history.undo().notes, notes); assert.deepEqual(history.undo().notes, source.notes); assert.deepEqual(history.redo().notes, notes);
});
test('copy/paste and duplication preserve gaps, metadata, adjacency and fresh identities', () => {
  const source = session(); const copied = [source.notes[0], { ...source.notes[1], start: 4, offsetMs: -12 }];
  const pasted = pasteNotes(source.notes, copied, 6, source);
  assert.ok(pasted); assert.equal(new Set(pasted.notes.map(note => note.id)).size, pasted.notes.length);
  assert.deepEqual(pasted.notes.filter(note => pasted.ids.includes(note.id)).map(note => [note.start, note.offsetMs]), [[6, 0], [10, -12]]);
  assert.equal(pasteNotes(source.notes, copied, 11, source), null);
  assert.equal(pasteNotes(source.notes, copied, 29, source), null);
  assert.equal(pasteNotes(source.notes, [], 6, source), null);
});
test('multi harmony moves preserve silent gaps and reject cycle crossings/collisions', () => {
  const progression = { cycleBars: 4, chords: [{ ...parseChordSymbol('C'), startBar: 0, durationBars: 0.5 }, { ...parseChordSymbol('G7'), startBar: 1, durationBars: 0.5 }, { ...parseChordSymbol('F'), startBar: 3, durationBars: 1 }] };
  const moved = editChords(progression, [0, 1], chord => ({ startBar: chord.startBar + 0.5 }), 4);
  assert.deepEqual(moved.chords.map(chord => chord.startBar), [0.5, 1.5, 3]); assert.deepEqual(moved.indices, [0, 1]);
  assert.equal(editChords(progression, [0, 1], chord => ({ startBar: chord.startBar + 2 }), 4), null);
  assert.equal(editChords(progression, [2], { durationBars: 1.25 }, 4), null);
});
test('live policy admits notes, harmony, drums, key and same-structure history but stops structural changes and training reference edits with reasons', () => {
  const source = session();
  for (const patch of [{ notes: [] }, { drums: { ...source.drums, seed: 12 } }, { progression: { ...source.progression, keyId: 'g-major' } }]) {
    const policy = playbackEditPolicy(source, { ...source, ...patch }, { mode: 'loop' }); assert.equal(policy.live, true); assert.equal(policy.stop, false);
  }
  for (const patch of [{ bars: 4 }, { meter: { beats: 3, unit: 4 } }, { subdivision: 2 }, { form: { ...source.form, enabled: true } }]) {
    const policy = playbackEditPolicy(source, { ...source, ...patch }, { mode: 'loop' }); assert.equal(policy.stop, true); assert.ok(policy.reason);
  }
  assert.equal(playbackEditPolicy(source, { ...source, notes: [] }, { mode: 'loop', structural: true }).stop, true);
  const training = playbackEditPolicy(source, { ...source, notes: [] }, { mode: 'train' }); assert.equal(training.stop, true); assert.match(training.reason, /referência/);
});
test('active duration defaults to an eighth and survives unavailable storage', () => {
  const values = new Map(); const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(rememberedDuration(storage), 2); rememberDuration(6, storage); assert.equal(values.get(DURATION_KEY), '6'); assert.equal(rememberedDuration(storage), 6);
  assert.equal(rememberedDuration({ getItem() { throw Error('unavailable'); } }), 2);
  assert.doesNotThrow(() => rememberDuration(2, { setItem() { throw Error('unavailable'); } }));
});
