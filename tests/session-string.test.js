import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSession, validateSession, patchSession, serializeSession, parseSession, encodeSessionLink, decodeSessionLink, loadSession, saveSession } from '../src/session.js';
import { addNote, completeNote, updateNote } from '../src/model.js';
import { prepareArrangement } from '../src/arrangement.js';
import { readSessionLibrary, SESSION_LIBRARY_KEY } from '../src/studio-state.js';
import { History } from '../src/history.js';
import { normalizeSession } from '../src/practice.js';
import { buildRhythmNotation } from '../src/notation.js';
import { standardInstrumentProfile } from '../src/instrument-profile.js';

const store = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
const envelope = session => ({ format: 'groovegoblin-session', version: session.version, session });
const rawLink = session => '#session=' + Buffer.from(JSON.stringify(session)).toString('base64url');
const events = session => {
  const clock = prepareArrangement(session);
  return Array.from({ length: session.bars }, (_, bar) => clock.barEvents(bar, { barIndex: bar }));
};
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/session-v2-arrangements.json', import.meta.url), 'utf8'));
function positioned(fixture, version = 4) {
  const old = structuredClone(fixture.session); old.version = version;
  if (version >= 3) {
    let cursor = 0;
    old.progression.chords = old.progression.chords.map(chord => { const next = { ...chord, startBar: cursor }; cursor += chord.durationBars; return next; });
    old.progression.cycleBars = cursor || old.bars;
  }
  if (version >= 4) old.drums.edits = [];
  return old;
}
function entries(session) {
  const db = store({ 'groovegoblin.session.v2': JSON.stringify(session), [SESSION_LIBRARY_KEY]: JSON.stringify([{ id: 'saved', savedAt: '2026-10-05T00:00:00Z', session: envelope(session) }]) });
  const history = new History(); history.push(session); history.push({ ...validateSession(session).session, bpm: 121 });
  return [validateSession(session).session, createSession(session), parseSession(JSON.stringify(session)), parseSession(JSON.stringify(envelope(session))), parseSession(serializeSession(session)), decodeSessionLink(rawLink(session)), decodeSessionLink(encodeSessionLink(session)), loadSession(db).session, readSessionLibrary(db, parseSession).entries[0].session, history.undo()];
}

for (const fixture of fixtures) {
  test(`v4 ${fixture.name}: every canonical entry retains recorded sounding events and absent strings`, () => {
    const old = positioned(fixture); const before = structuredClone(old);
    for (const migrated of entries(old)) {
      assert.equal(migrated.version, 5);
      assert.deepEqual(events(migrated), fixture.events);
      assert.deepEqual(migrated.notes, old.notes);
      assert.ok(migrated.notes.every(note => !Object.hasOwn(note, 'string')));
      assert.deepEqual(migrated.drums.edits, []);
    }
    assert.deepEqual(old, before);
  });
}

test('v4 sparse drum differences migrate unchanged alongside low/high expressive notes and all saved sound choices', () => {
  const source = createSession({ bars: 2, notes: [{ id: 'low', start: 0, duration: 2, pitch: 12, velocity: 0.3, offsetMs: -12, articulation: 'ghost' }, { id: 'high', start: 4, duration: 4, pitch: 120 }],
    timbres: { phrase: 'soft-lead' }, band: { role: 'harmony', bassEnabled: true, style: 'pop' }, mixer: { phrase: { volume: 0.4, muted: false }, bass: { volume: 0.7, muted: false } },
    metronome: { enabled: false }, drums: { enabled: true, style: 'pop', density: 'sparse', seed: 42, edits: [{ voice: 'kick', start: 3, velocity: 0.63 }, { voice: 'snare', start: 4, velocity: null }, { voice: 'hihat', start: 8, velocity: 0.17 }] } });
  const old = { ...source, version: 4 }; const expectedEvents = events(source);
  const bar = expectedEvents[0];
  assert.ok(bar.some(event => event.channel === 'drums' && event.instrument === 'kick' && event.tick === 3 && event.velocity === 0.63));
  assert.ok(!bar.some(event => event.channel === 'drums' && event.instrument === 'snare' && event.tick === 4));
  assert.ok(bar.some(event => event.channel === 'drums' && event.instrument === 'hihat' && event.tick === 8 && event.velocity === 0.17));
  assert.deepEqual(bar.filter(event => event.channel === 'phrase').map(event => [event.pitch, event.duration, event.timbre, event.offsetMs]), [[12, 2, 'soft-lead', -12], [120, 4, 'soft-lead', 0]]);
  for (const migrated of entries(old)) {
    assert.deepEqual(migrated, source); assert.deepEqual(migrated.drums.edits, old.drums.edits); assert.deepEqual(events(migrated), expectedEvents);
  }
  const db = store(); assert.equal(saveSession(old, db), true); assert.deepEqual(loadSession(db).session, source);
});

test('v5 string metadata roundtrips generic bounds without changing sound or inventing absent assignments', () => {
  const source = createSession({ bars: 2, notes: [{ id: 'assigned', start: 0, duration: 18, pitch: 60, string: 6 }, { id: 'missing', start: 20, duration: 2, pitch: 127 }], extensions: { studio: { instrument: standardInstrumentProfile('bass', 4), phraseView: 'tab' } } });
  for (const restored of entries(source)) assert.deepEqual(restored, source);
  const without = patchSession(source, { notes: source.notes.map(({ string, ...note }) => note) });
  assert.deepEqual(events(source), events(without));
  assert.equal(normalizeSession(source).notes[0].string, 6);
  assert.equal(Object.hasOwn(normalizeSession(source).notes[1], 'string'), false);
  const split = buildRhythmNotation(source.notes, source).measures.flatMap(measure => measure.events).filter(event => event.noteId === 'assigned');
  assert.ok(split.length > 1); assert.ok(split.every(event => event.string === 6));
  const db = store(); assert.equal(saveSession(source, db), true); assert.deepEqual(loadSession(db).session, source);
});

test('v1/v2/v3/v4 cannot smuggle note.string through raw, envelope, link, library, save or history', () => {
  const legacy = { format: 'groovegoblin-phrase', version: 1, bpm: 100, bars: 1, notes: [{ id: 'a', start: 0, duration: 2, string: 1 }] };
  assert.throws(() => parseSession(JSON.stringify(legacy)), TypeError);
  assert.throws(() => decodeSessionLink('#phrase=' + encodeURIComponent(JSON.stringify(legacy))), TypeError);
  for (const version of [2, 3, 4]) {
    const old = positioned(fixtures[0], version); old.notes[0].string = 1;
    assert.equal(validateSession(old).ok, false); assert.throws(() => createSession(old), TypeError);
    assert.throws(() => parseSession(JSON.stringify(old)), TypeError); assert.throws(() => parseSession(JSON.stringify(envelope(old))), TypeError);
    assert.throws(() => decodeSessionLink(rawLink(old)), TypeError); assert.throws(() => serializeSession(old), TypeError);
    assert.equal(saveSession(old, store()), false); assert.throws(() => new History().push(old), TypeError);
    const text = JSON.stringify(old); assert.equal(loadSession(store({ 'groovegoblin.session.v2': text })).recoveryRaw, text);
    const raw = JSON.stringify([{ id: 'invalid', savedAt: '2026-10-05T00:00:00Z', session: envelope(old) }]);
    const library = readSessionLibrary(store({ [SESSION_LIBRARY_KEY]: raw }), parseSession);
    assert.deepEqual(library.entries, []); assert.equal(library.recoveryRaw, raw);
  }
});

test('optional string is strict in creation, completion, editing and parsing, never part of defaults', () => {
  const session = createSession({ notes: [{ id: 'a', start: 0, duration: 2 }] });
  assert.equal(Object.hasOwn(completeNote(session.notes[0]), 'string'), false);
  assert.equal(addNote([], 0, 2, session, { pitch: 60, string: 3 })[0].string, 3);
  for (const string of [null, undefined, 0, 7, -1, 1.5, '3', NaN]) {
    assert.equal(validateSession({ ...session, notes: [{ ...session.notes[0], string }] }).ok, false);
    assert.equal(addNote(session.notes, 4, 2, session, { string }), session.notes);
    assert.equal(updateNote(session.notes, 'a', { string }, session), session.notes);
  }
  assert.equal(updateNote(session.notes, 'a', { string: 6 }, session)[0].string, 6);
  assert.equal(validateSession({ ...session, extensions: { studio: { phraseView: 'score' } } }).ok, false);
});
