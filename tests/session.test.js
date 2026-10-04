import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, validateSession, loadSession, saveSession, serializeSession, parseSession, encodeSessionLink, decodeSessionLink } from '../src/session.js';
import { parseChordSymbol } from '../src/progression.js';

function storage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return { entries, getItem(key) { return entries.get(key) ?? null; }, setItem(key, value) { entries.set(key, value); } };
}
const key = 'groovegoblin.session.v2';

test('complete canonical session preserves fractional notes, mixer and real form on every exchange path', () => {
  const session = createSession({ bars: 2, meter: { beats: 7, unit: 8 }, notes: [{ id: 'tuplet', start: 4 / 3, duration: 8 / 3, pitch: 61, velocity: 0.3, offsetMs: -12, articulation: 'ghost' }], mixer: { bass: { volume: 0.6, muted: true } }, form: { enabled: true, loop: false, sections: [{ id: 'b', name: 'Ponte', kind: 'B', startBar: 1, endBar: 2, repeats: 3, bpm: 150, meter: { beats: 5, unit: 16 }, density: 'busy' }] } });
  assert.deepEqual(parseSession(serializeSession(session)), session);
  assert.deepEqual(decodeSessionLink(encodeSessionLink(session)), session);
  const db = storage(); assert.equal(saveSession(session, db), true);
  assert.deepEqual(loadSession(db).session, session);
});

test('old session documents acquire the disabled canonical form, not invented sections', () => {
  const session = createSession(); delete session.form;
  const loaded = loadSession(storage({ [key]: JSON.stringify(session) }));
  assert.deepEqual(loaded.session.form, { enabled: false, loop: true, sections: [] });
  assert.equal(loaded.recoveryRaw, null);
});

test('invalid saved document preserves exact original and recovery copy without overwriting', () => {
  for (const raw of ['{bad', JSON.stringify({ ...createSession(), bpm: 999 }), JSON.stringify({ ...createSession(), unknown: true })]) {
    const db = storage({ [key]: raw }); const result = loadSession(db);
    assert.equal(result.recoveryRaw, raw); assert.equal(db.getItem(key), raw);
    assert.equal(db.getItem(`${key}.recovery`), raw); assert.ok(result.warnings.length > 0);
    assert.deepEqual(result.session, createSession());
  }
});

test('storage denial and quota failure are explicit nonthrowing outcomes, including the global getter', t => {
  const unavailable = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  assert.equal(loadSession(unavailable).storageAvailable, false);
  assert.equal(saveSession(createSession(), unavailable), false);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; });
  assert.equal(loadSession().storageAvailable, false); assert.equal(saveSession(createSession()), false);
});

test('invalid sessions never write and failed recovery backup does not lose corrupt raw data', () => {
  const db = storage(); assert.equal(saveSession({ ...createSession(), bars: 0 }, db), false); assert.equal(db.entries.size, 0);
  const raw = '{broken'; const result = loadSession({ getItem() { return raw; }, setItem() { throw new Error('quota'); } });
  assert.equal(result.recoveryRaw, raw); assert.ok(result.warnings.length);
});

test('legacy phrase/preferences/mixer migrate only in absence of the new session', () => {
  const legacy = { notes: [{ id: 'a', start: 0, duration: 4 }], bars: 2, bpm: 140 };
  const mixer = Object.fromEntries(['phrase', 'metronome', 'drums', 'chords'].map(channel => [channel, { volume: 0.4, muted: channel === 'drums' }]));
  const db = storage({ 'groovegoblin.v1': JSON.stringify(legacy), 'groovegoblin.preferences.v1': JSON.stringify({ metronome: false, density: 'busy', seed: 23 }), 'groovegoblin.mixer.v1': JSON.stringify(mixer) });
  const result = loadSession(db);
  assert.equal(result.session.bars, 2); assert.equal(result.session.notes[0].pitch, 69);
  assert.equal(result.session.metronome.enabled, false); assert.equal(result.session.generator.seed, 23);
  assert.equal(result.session.mixer.drums.muted, true); assert.equal(result.session.mixer.bass.volume, 1);
  assert.equal(db.getItem('groovegoblin.v1'), JSON.stringify(legacy));
  saveSession(createSession({ bpm: 200 }), db); assert.equal(loadSession(db).session.bpm, 200);
});

test('corrupt legacy phrase remains available for recovery', () => {
  const raw = '{invalid'; const db = storage({ 'groovegoblin.v1': raw }); const result = loadSession(db);
  assert.equal(result.recoveryRaw, raw); assert.equal(db.getItem('groovegoblin.v1'), raw); assert.ok(result.warnings.length);
});

test('chord inversions count unique actual upper tones, excluding a foreign slash bass', () => {
  for (const symbol of ['C', 'C/D', 'C/E']) {
    const chord = parseChordSymbol(symbol);
    const valid = createSession({ progression: { chords: [chord] } });
    assert.equal(validateSession({ ...valid, progression: { ...valid.progression, chords: [{ ...chord, inversion: 3 }] } }).ok, false);
  }
});
