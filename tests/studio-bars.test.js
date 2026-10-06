import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, patchSession, validateSession } from '../src/session.js';
import { parseChordSymbol, chordTimeline } from '../src/progression.js';
import { History } from '../src/history.js';
import { clearBar, copyBar, duplicateBar, materializeHarmony, repeatPhraseInNewBars, timelineWidth, musicalDuration } from '../src/studio-bars.js';
import { offerBarIncrease, defaultCopyTarget } from '../src/studio-ruler.js';

const chord = (symbol, startBar, durationBars) => ({ ...parseChordSymbol(symbol), startBar, durationBars });
const apply = (session, operation) => { assert.ok(operation.patch, operation.error); return patchSession(session, operation.patch); };
const harmony = session => chordTimeline(session).map(event => [event.start, event.duration, event.chord.symbol]);

test('repeat into added bars preserves gaps, metadata, fresh IDs and clips final partial cycle', () => {
  const source = createSession({ bars: 2, notes: [{ id: 'a', start: 2, duration: 4, pitch: 60, offsetMs: -12, velocity: 0.3 }, { id: 'b', start: 28, duration: 4, pitch: 67 }] });
  const expanded = patchSession(source, { bars: 5 });
  const repeated = apply(expanded, repeatPhraseInNewBars(expanded, source));
  assert.deepEqual(repeated.notes.map(note => [note.start, note.duration]), [[2, 4], [28, 4], [34, 4], [60, 4], [66, 4]]);
  assert.equal(repeated.notes[2].offsetMs, -12); assert.equal(repeated.notes[2].velocity, 0.3);
  assert.equal(new Set(repeated.notes.map(note => note.id)).size, repeated.notes.length);
  const history = new History(); history.push(source); history.push(expanded); history.push(repeated);
  assert.deepEqual(history.undo(), expanded); assert.deepEqual(history.undo(), source); assert.deepEqual(history.redo(), expanded);
});

test('repeat rejects collisions atomically and clips notes ending beyond a partial final cycle', () => {
  const source = createSession({ bars: 2, notes: [{ id: 'a', start: 14, duration: 8, pitch: 60 }] });
  const expanded = patchSession(source, { bars: 3 });
  assert.deepEqual(apply(expanded, repeatPhraseInNewBars(expanded, source)).notes.map(note => [note.start, note.duration]), [[14, 8], [46, 2]]);
  const occupied = patchSession(expanded, { notes: [...expanded.notes, { id: 'occupied', start: 46, duration: 2, pitch: 62 }] });
  assert.ok(repeatPhraseInNewBars(occupied, source).error); assert.equal(occupied.notes.length, 2);
});

test('clear recuts sustains crossing both boundaries and leaves adjacent attacks untouched', () => {
  const source = createSession({ bars: 4, notes: [{ id: 'long', start: 8, duration: 32, pitch: 60 }, { id: 'boundary', start: 48, duration: 4, pitch: 62 }], progression: { enabled: true, cycleBars: 4, chords: [chord('C', 0.5, 2), chord('G', 3, 1)] } });
  const cleared = apply(source, clearBar(source, 1));
  assert.deepEqual(cleared.notes.map(note => [note.start, note.duration]), [[8, 8], [32, 8], [48, 4]]);
  assert.equal(new Set(cleared.notes.map(note => note.id)).size, 3);
  assert.deepEqual(cleared.progression.chords.map(value => [value.startBar, value.durationBars]), [[0.5, 0.5], [2, 0.5], [3, 1]]);
});

test('clear one repeated occurrence does not clear another or discard cycle gaps', () => {
  const source = createSession({ bars: 4, progression: { enabled: true, cycleBars: 2, chords: [chord('C', 0.5, 0.5), chord('G', 1.5, 0.5)] } });
  const cleared = apply(source, clearBar(source, 2));
  assert.deepEqual(harmony(cleared), [[8, 8, 'C'], [24, 8, 'G'], [56, 8, 'G']]);
  assert.equal(cleared.progression.cycleBars, 4);
});

test('copy clips crossing sustains to the source bar and preserves other bars and disabled harmony', () => {
  const source = createSession({ bars: 4, notes: [{ id: 'cross', start: 12, duration: 8, pitch: 60 }, { id: 'outside', start: 48, duration: 4, pitch: 64 }], progression: { enabled: false, cycleBars: 2, chords: [chord('C', 0, 1)] } });
  const copied = apply(source, copyBar(source, 1, 2));
  assert.deepEqual(copied.notes.map(note => [note.start, note.duration]), [[12, 8], [32, 4], [48, 4]]);
  assert.deepEqual(copied.progression, source.progression);
  assert.equal(copyBar(source, 1, 3).patch, undefined); // Occupied target rejects, not overwrites.
  assert.ok(copyBar(source, 0, 4).error); assert.ok(copyBar(source, 0, 0).error);
});

test('copy includes enabled harmony and rejects harmonic collision without changing the phrase', () => {
  const source = createSession({ bars: 3, notes: [{ id: 'a', start: 0, duration: 4, pitch: 60 }], progression: { enabled: true, cycleBars: 3, chords: [chord('C', 0.25, 0.5), chord('G', 2, 1)] } });
  const copied = apply(source, copyBar(source, 0, 1));
  assert.deepEqual(copied.progression.chords.map(value => [value.startBar, value.durationBars]), [[0.25, 0.5], [1.25, 0.5], [2, 1]]);
  assert.ok(copyBar(source, 0, 2).error); assert.equal(source.notes.length, 1);
});

test('duplicate inserts into a filled session, shifts following notes, loop and form intervals', () => {
  const source = createSession({ bars: 3, notes: [{ id: 'a', start: 2, duration: 4, pitch: 60 }, { id: 'b', start: 16, duration: 4, pitch: 62 }, { id: 'c', start: 36, duration: 4, pitch: 64 }], loop: { startBar: 1, endBar: 3 }, form: { sections: [{ id: 'part', name: 'Parte', startBar: 1, endBar: 3 }, { id: 'opening', name: 'Abertura', startBar: 0, endBar: 1 }] } });
  const duplicated = apply(source, duplicateBar(source, 0));
  assert.equal(duplicated.bars, 4); assert.deepEqual(duplicated.notes.map(note => note.start), [2, 18, 32, 52]);
  assert.deepEqual(duplicated.loop, { startBar: 2, endBar: 4 });
  assert.deepEqual(duplicated.form.sections.map(section => [section.startBar, section.endBar]), [[2, 4], [0, 2]]);
  assert.equal(duplicated.notes.find(note => note.id === 'b').start, 32);
  assert.ok(validateSession(duplicated).ok);
});

test('duplicate preserves sustains across the insertion with split fragments and copied interval', () => {
  const source = createSession({ bars: 3, notes: [{ id: 'long', start: 12, duration: 12, pitch: 60 }], progression: { enabled: true, cycleBars: 3, chords: [chord('C', 0.5, 1.5), chord('G', 2.5, 0.5)] } });
  const duplicated = apply(source, duplicateBar(source, 0));
  assert.deepEqual(duplicated.notes.map(note => [note.start, note.duration]), [[12, 4], [28, 4], [32, 8]]);
  assert.deepEqual(duplicated.progression.chords.map(value => [value.startBar, value.durationBars]), [[0.5, 0.5], [1.5, 0.5], [2, 1], [3.5, 0.5]]);
});

test('duplicate materializes repeats and shifts later harmony without losing silent gaps', () => {
  const source = createSession({ bars: 4, progression: { enabled: true, cycleBars: 2, chords: [chord('C', 0.5, 0.5), chord('G', 1.5, 0.5)] } });
  const duplicated = apply(source, duplicateBar(source, 0));
  assert.equal(duplicated.progression.cycleBars, 5);
  assert.deepEqual(harmony(duplicated), [[8, 8, 'C'], [24, 8, 'C'], [40, 8, 'G'], [56, 8, 'C'], [72, 8, 'G']]);
  assert.ok(duplicateBar(createSession({ bars: 64 }), 0).error);
});

test('materializing ghosts preserves exact rendered harmony including gaps and clipped final chords', () => {
  const source = createSession({ bars: 5, progression: { enabled: true, cycleBars: 2, chords: [chord('C', 0.5, 1), chord('G', 1.75, 0.25)] } });
  const expanded = apply(source, materializeHarmony(source, 2.5));
  assert.deepEqual(harmony(expanded), harmony(source)); assert.equal(expanded.progression.cycleBars, 5);
  assert.ok(materializeHarmony(source, 0).error);
});

test('expansion retains source chords beyond the visible session and rejects schema overflow atomically', () => {
  const source = createSession({ bars: 2, progression: { enabled: true, cycleBars: 4, chords: [chord('C', 0, 0.5), chord('G', 3, 1)] } });
  const cleared = apply(source, clearBar(source, 0));
  assert.deepEqual(cleared.progression.chords.map(value => value.startBar), [3]);
  const many = createSession({ bars: 15, meter: { beats: 8, unit: 8 }, progression: { enabled: true, cycleBars: 0.25, chords: [chord('C', 0, 0.125), chord('G', 0.125, 0.125)] } });
  assert.ok(copyBar(many, 0, 1).error);
  assert.ok(duplicateBar(many, 0).error);
  assert.ok(materializeHarmony(many, 1).error);
});

test('duplicate at the final boundary extends a full loop and preserves disabled harmony data', () => {
  const source = createSession({ bars: 1, notes: [{ id: 'last', start: 14, duration: 2, pitch: 60 }], progression: { enabled: false, cycleBars: 2, chords: [chord('G', 1, 1)] } });
  const duplicated = apply(source, duplicateBar(source, 0));
  assert.equal(duplicated.bars, 2);
  assert.deepEqual(duplicated.loop, { startBar: 0, endBar: 2 });
  assert.deepEqual(duplicated.notes.map(note => [note.start, note.duration]), [[14, 2], [30, 2]]);
  assert.deepEqual(duplicated.progression, source.progression);
});

test('timeline retains twelve pixels per sixteenth and default four bars fit a desktop viewport', () => {
  const short = createSession({ bars: 4 }); const long = createSession({ bars: 16 });
  assert.equal(timelineWidth(1200, short), 1200);
  assert.equal(timelineWidth(1200, long), 4200);
  assert.equal(timelineWidth(1200, long, 2), 8200);
  const dense = createSession({ bars: 4, meter: { beats: 16, unit: 2 } });
  assert.ok((timelineWidth(1200, dense) - 200) / (4 * 128) >= 12);
  assert.equal(musicalDuration(4, short), '1 tempo'); assert.equal(musicalDuration(8, short), '2 tempos'); assert.equal(musicalDuration(16, short), '1 compasso');
  const compound = createSession({ meter: { beats: 6, unit: 8 } });
  assert.equal(musicalDuration(4, compound), '2 tempos'); assert.equal(musicalDuration(12, compound), '1 compasso');
});

test('bar increase offers repetition after native dispatch applies data, with separate history steps', t => {
  const tasks = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { tasks.push({ callback, delay }); return tasks.length; });
  const original = createSession({ bars: 1, notes: [{ id: 'a', start: 2, duration: 4, pitch: 60 }] });
  let session = original; let offered = null;
  const history = new History(); history.push(original);
  const host = {
    getSession: () => session,
    notifyAction: (text, label, action) => { offered = { text, label, action }; },
    notify: text => assert.fail(text),
    updateSession: patch => { session = patchSession(session, patch); history.push(session); },
  };
  offerBarIncrease(host, original, 4); // Ruler listener runs before data-path listener.
  assert.equal(offered, null); assert.equal(tasks[0].delay, 0);
  session = patchSession(session, { bars: 4 }); history.push(session);
  const expanded = session;
  tasks[0].callback();
  assert.equal(offered.text, 'Sessão com 4 compassos');
  assert.equal(offered.label, 'Repetir a frase nos novos compassos');
  offered.action();
  assert.deepEqual(session.notes.map(note => note.start), [2, 18, 34, 50]);
  assert.deepEqual(history.undo(), expanded); assert.deepEqual(history.undo(), original);
  offered = null; session = original;
  offerBarIncrease(host, original, 4);
  tasks.at(-1).callback(); assert.equal(offered, null); // Rejected input has no offer.
  offerBarIncrease(host, original, 4);
  session = patchSession(original, { bars: 3 });
  tasks.at(-1).callback(); assert.equal(offered, null); // A superseding bar change is not announced.
});

test('copy destination always names an existing different bar, including the final and sole bars', () => {
  assert.equal(defaultCopyTarget(4, 0), 1);
  assert.equal(defaultCopyTarget(4, 3), 0);
  assert.equal(defaultCopyTarget(2, 1), 0);
  assert.equal(defaultCopyTarget(1, 0), null);
});
