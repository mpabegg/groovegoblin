import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getInstrumentProfile, standardInstrumentProfile, normalizeInstrumentProfile, formatInstrumentNote, parseInstrumentNote, instrumentTuning, getInstrumentClef } from '../src/instrument-profile.js';
import { createSession, SESSION_VERSION, TIMBRES, validateSession, serializeSession, parseSession, encodeSessionLink, decodeSessionLink, loadSession, saveSession } from '../src/session.js';
import { withStudioChoices, createStudioSession, initialStudioSession, readInstrumentPreference, saveInstrumentPreference, INSTRUMENT_PREFERENCE_KEY } from '../src/studio-session.js';
import { instrumentChangePatch } from '../src/studio-instrument.js';
import { mergeSession, readSessionLibrary, SESSION_LIBRARY_KEY } from '../src/studio-state.js';
import { History } from '../src/history.js';
import { prepareArrangement } from '../src/arrangement.js';
import { parseChordSymbol } from '../src/progression.js';

const SESSION_KEY = 'groovegoblin.session.v2';
function storage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return { entries, getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}
const note = (pitch, start = 0) => ({ id: `note-${start}`, start, duration: 2, pitch, velocity: 0.6, articulation: 'ghost', offsetMs: -8 });
const events = session => Array.from({ length: session.bars }, (_, bar) => prepareArrangement(session).barEvents(bar));

 test('effective legacy profile is guitar/letters without canonical insertion or sound changes', () => {
  const session = createSession({ notes: [note(69)], band: { role: 'harmony', bassEnabled: true }, drums: { enabled: true }, timbres: { phrase: 'marimba', bass: 'synth-bass' }, mixer: { phrase: { volume: 0.3, muted: true } } });
  const bytes = JSON.stringify(session);
  assert.deepEqual(getInstrumentProfile(session), standardInstrumentProfile());
  assert.equal(JSON.stringify(session), bytes);
  const paths = [parseSession(serializeSession(session)), decodeSessionLink(encodeSessionLink(session)), loadSession(storage({ [SESSION_KEY]: bytes })).session, withStudioChoices(session)];
  for (const value of paths) {
    assert.equal(value.extensions.studio?.instrument, undefined);
    assert.deepEqual(value.notes, session.notes); assert.deepEqual(value.timbres, session.timbres);
    assert.deepEqual(value.band, session.band); assert.deepEqual(value.mixer, session.mixer);
    assert.deepEqual(events(value), events(session));
  }
 });

 test('v4 profile survives file, link, storage, library and undo/redo with unrelated extensions', () => {
  assert.equal(SESSION_VERSION, 4);
  const instrument = { ...standardInstrumentProfile('bass', 5), tuning: [23, 26, 33, 38, 43], noteNames: 'solfege' };
  const session = createSession({ notes: [note(28)], timbres: { phrase: 'electric-bass' }, extensions: { studio: { instrument, inputPitch: 28, generator: { seed: 12 } }, external: { keep: true } } });
  const db = storage(); assert.equal(saveSession(session, db), true);
  for (const value of [parseSession(serializeSession(session)), decodeSessionLink(encodeSessionLink(session)), loadSession(db).session]) assert.deepEqual(value, session);
  db.setItem(SESSION_LIBRARY_KEY, JSON.stringify([{ id: 'saved', savedAt: new Date(0).toISOString(), session }]));
  assert.deepEqual(readSessionLibrary(db, parseSession).entries[0].session, session);
  const history = new History(); history.push(session);
  const next = createSession(mergeSession(session, instrumentChangePatch(session, { ...instrument, noteNames: 'letters' })));
  history.push(next); assert.deepEqual(history.undo(), session); assert.deepEqual(history.redo(), next);
 });

 test('malformed reserved profiles reject entire sessions rather than silently falling back', () => {
  const valid = standardInstrumentProfile();
  for (const instrument of [null, {}, { ...valid, type: 'piano' }, { ...valid, strings: 4 }, { ...valid, noteNames: 'other' }, { ...valid, extra: true }, { ...valid, tuning: [40, 45] }, { ...valid, tuning: [40, 45, 50, 55, 59, 128] }, { ...valid, tuning: [40, 45, 50, 55, 59, 59] }, { ...valid, tuning: [40.5, 45, 50, 55, 59, 64] }]) {
    assert.throws(() => normalizeInstrumentProfile(instrument));
    const session = { ...createSession(), extensions: { studio: { instrument } } };
    assert.equal(validateSession(session).ok, false);
    assert.throws(() => parseSession(JSON.stringify(session)));
    const db = storage({ [SESSION_KEY]: JSON.stringify(session) });
    assert.equal(loadSession(db).recoveryRaw, JSON.stringify(session));
  }
 });

 test('profile preference applies only to explicit Nova and truly fresh storage', () => {
  const profile = { ...standardInstrumentProfile('bass', 5), noteNames: 'solfege' };
  const db = storage(); assert.equal(saveInstrumentPreference(profile, db), true);
  const fresh = initialStudioSession(loadSession(db), db);
  assert.deepEqual(getInstrumentProfile(fresh), profile); assert.equal(fresh.timbres.phrase, 'electric-bass'); assert.equal(fresh.extensions.studio.inputPitch, 28);
  assert.equal(fresh.band.bassEnabled, false); assert.equal(fresh.drums.enabled, false); assert.equal(fresh.progression.enabled, false);
  const guitar = createStudioSession(storage()); assert.equal(guitar.timbres.phrase, 'clean-guitar'); assert.equal(guitar.extensions.studio.inputPitch, 52); assert.equal(guitar.band.bassEnabled, false); assert.equal(guitar.notes.length, 0);
  const legacy = createSession({ timbres: { phrase: 'organ' }, notes: [note(69)] });
  db.setItem(SESSION_KEY, JSON.stringify(legacy)); assert.deepEqual(initialStudioSession(loadSession(db), db), legacy);
  db.setItem(SESSION_KEY, '{broken'); const recovery = loadSession(db); assert.equal(initialStudioSession(recovery, db), recovery.session);
  const old = storage({ [INSTRUMENT_PREFERENCE_KEY]: JSON.stringify(profile), 'groovegoblin.v1': JSON.stringify({ bars: 1, bpm: 120, notes: [{ id: 'a', start: 0, duration: 4 }] }) });
  const migrated = loadSession(old); assert.equal(initialStudioSession(migrated, old), migrated.session); assert.equal(migrated.session.timbres.phrase, 'soft-lead');
 });

 test('preference corruption, denied access and quota do not corrupt canonical session handling', t => {
  const broken = storage({ [INSTRUMENT_PREFERENCE_KEY]: '{broken' });
  assert.deepEqual(readInstrumentPreference(broken), standardInstrumentProfile());
  const unavailable = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.deepEqual(readInstrumentPreference(unavailable), standardInstrumentProfile()); assert.equal(saveInstrumentPreference(standardInstrumentProfile(), unavailable), false);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; });
  assert.deepEqual(readInstrumentPreference(), standardInstrumentProfile()); assert.equal(saveInstrumentPreference(standardInstrumentProfile()), false);
  const restored = loadSession(); assert.equal(initialStudioSession(restored), restored.session);
 });

 test('explicit type changes transpose by whole octaves once and validate all notes atomically', () => {
  const source = createSession({ notes: [note(52), note(59, 4)], progression: { chords: [parseChordSymbol('C')] }, timbres: { phrase: 'marimba' }, band: { role: 'drums', bassEnabled: true }, mixer: { phrase: { volume: 0.4, muted: true } }, extensions: { other: { retain: true } } });
  const bytes = JSON.stringify(source);
  assert.equal(instrumentChangePatch(source, standardInstrumentProfile('bass'), 'cancel'), null); assert.equal(JSON.stringify(source), bytes);
  const bass = createSession(mergeSession(source, instrumentChangePatch(source, standardInstrumentProfile('bass'), 'transpose')));
  assert.deepEqual(bass.notes.map(item => item.pitch), [28, 35]); assert.deepEqual(bass.notes.map(item => ({ ...item, pitch: item.pitch + 24 })), source.notes);
  assert.equal(bass.timbres.phrase, 'electric-bass'); assert.equal(bass.extensions.studio.inputPitch, 28); assert.equal(bass.band.bassEnabled, false); assert.equal(bass.band.role, 'drums');
  assert.deepEqual(bass.mixer, source.mixer); assert.deepEqual(bass.progression, source.progression); assert.deepEqual(bass.extensions.other, source.extensions.other);
  const kept = createSession(mergeSession(source, instrumentChangePatch(source, standardInstrumentProfile('bass'), 'keep'))); assert.deepEqual(kept.notes, source.notes);
  const guitar = createSession(mergeSession(bass, instrumentChangePatch(bass, standardInstrumentProfile(), 'transpose'))); assert.deepEqual(guitar.notes, source.notes); assert.equal(guitar.timbres.phrase, 'clean-guitar'); assert.equal(guitar.band.bassEnabled, true);
  for (const [type, pitches] of [['bass', [52, 10]], ['guitar', [28, 120]]]) {
    const session = createSession({ notes: pitches.map((pitch, index) => note(pitch, index * 4)), extensions: { studio: { instrument: standardInstrumentProfile(type === 'bass' ? 'guitar' : 'bass') } } });
    const original = JSON.stringify(session); assert.throws(() => instrumentChangePatch(session, standardInstrumentProfile(type), 'transpose')); assert.equal(JSON.stringify(session), original);
  }
 });

 test('strings, tuning and note names preserve custom phrase timbre, mix and harmonic spelling', () => {
  const session = createSession({ notes: [note(28)], timbres: { phrase: 'synth-bass' }, mixer: { phrase: { volume: 0.25, muted: true } }, progression: { chords: [parseChordSymbol('C/E')] }, extensions: { studio: { instrument: standardInstrumentProfile('bass') } } });
  const profile = { ...standardInstrumentProfile('bass', 5), tuning: [23, 26, 33, 38, 43], noteNames: 'solfege' };
  const next = createSession(mergeSession(session, instrumentChangePatch(session, profile)));
  assert.deepEqual(next.timbres, session.timbres); assert.deepEqual(next.mixer, session.mixer); assert.deepEqual(next.notes, session.notes); assert.deepEqual(next.progression, session.progression);
  assert.deepEqual(events(next), events(session));
  for (const timbre of ['nylon-guitar', 'clean-guitar', 'muted-guitar', 'upright-bass', 'electric-bass', 'synth-bass']) { assert.ok(TIMBRES.phrase.includes(timbre)); assert.equal(createSession({ timbres: { phrase: timbre } }).timbres.phrase, timbre); }
 });

 test('named tuning, octave labels and renderer clefs use the actual profile', () => {
  const guitar = standardInstrumentProfile(); const bass4 = standardInstrumentProfile('bass'); const bass5 = standardInstrumentProfile('bass', 5);
  assert.deepEqual(instrumentTuning(guitar, 'drop-d'), [38, 45, 50, 55, 59, 64]); assert.deepEqual(instrumentTuning(bass4, 'drop-d'), [26, 33, 38, 43]); assert.deepEqual(instrumentTuning(bass5, 'drop-d'), [23, 26, 33, 38, 43]);
  assert.deepEqual(instrumentTuning(guitar, 'half-down'), [39, 44, 49, 54, 58, 63]);
  for (const [pitch, letters, solfege] of [[23, 'B0', 'Si0'], [28, 'E1', 'Mi1'], [52, 'E3', 'Mi3'], [61, 'C♯4', 'Dó♯4']]) {
    assert.equal(formatInstrumentNote(pitch, guitar), letters); assert.equal(formatInstrumentNote(pitch, { ...guitar, noteNames: 'solfege' }), solfege);
    assert.equal(parseInstrumentNote(letters), pitch); assert.equal(parseInstrumentNote(solfege), pitch);
  }
  assert.equal(formatInstrumentNote(61, guitar, { octave: false }), 'C♯'); assert.equal(parseInstrumentNote('Si♭1'), 34); assert.throws(() => parseInstrumentNote('E')); assert.throws(() => parseInstrumentNote('C20'));
  assert.deepEqual(getInstrumentClef(guitar), { sign: 'G', line: 2, octaveChange: -1 }); assert.deepEqual(getInstrumentClef(bass5), { sign: 'F', line: 4, octaveChange: -1 });
 });
