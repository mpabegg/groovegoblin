import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSession, validateSession, patchSession, loadSession, saveSession, serializeSession, parseSession, encodeSessionLink, decodeSessionLink, SESSION_VERSION } from '../src/session.js';
import { parseChordSymbol, chordTimeline } from '../src/progression.js';
import { generateBass, generateComping } from '../src/band.js';
import { prepareArrangement } from '../src/arrangement.js';
import { readSessionLibrary, SESSION_LIBRARY_KEY } from '../src/studio-state.js';
import { History } from '../src/history.js';
import { sessionToMidi, parseMidi, MIDI_PPQ } from '../src/repertoire-formats.js';
import { compileBarPlan } from '../src/form.js';
import { renderSession } from '../src/audio.js';
import { audioContext } from './audio-harness.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/session-v2-arrangements.json', import.meta.url), 'utf8'));
const storageKey = 'groovegoblin.session.v2';
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const envelope = session => ({ format: 'groovegoblin-session', version: session.version, session });
const oldLink = session => '#session=' + Buffer.from(JSON.stringify(session)).toString('base64url');
const chord = (symbol, startBar, durationBars = 1) => ({ ...parseChordSymbol(symbol), startBar, durationBars });
const gaps = (overrides = {}) => createSession({
  bars: 4, progression: { enabled: true, cycleBars: 2, chords: [chord('C', 0.25, 0.5), chord('G7', 1.25, 0.5)] },
  band: { bassEnabled: true, style: 'pop', density: 'busy' }, metronome: { enabled: false }, ...overrides,
});

for (const fixture of fixtures) {
  test(`v2 ${fixture.name}: all input paths migrate and preserve musical fields`, () => {
    const old = fixture.session;
    const before = structuredClone(old);
    const checked = validateSession(old);
    assert.equal(checked.ok, true);
    const expected = checked.session;
    assert.equal(expected.version, 3);
    let cursor = 0;
    for (const [index, oldChord] of old.progression.chords.entries()) {
      assert.deepEqual(expected.progression.chords[index], { ...oldChord, startBar: cursor });
      cursor += oldChord.durationBars;
    }
    assert.equal(expected.progression.cycleBars, cursor);
    const withoutPositions = structuredClone(expected);
    withoutPositions.version = 2;
    delete withoutPositions.progression.cycleBars;
    for (const item of withoutPositions.progression.chords) delete item.startBar;
    assert.deepEqual(withoutPositions, old);
    assert.deepEqual(parseSession(JSON.stringify(old)), expected);
    assert.deepEqual(parseSession(JSON.stringify(envelope(old))), expected);
    assert.deepEqual(decodeSessionLink(oldLink(old)), expected);
    const raw = JSON.stringify(old);
    const db = storage({ [storageKey]: raw });
    const loaded = loadSession(db);
    assert.deepEqual(loaded.session, expected);
    assert.equal(loaded.recoveryRaw, null);
    assert.equal(db.getItem(storageKey), raw);
    assert.equal(saveSession(old, db), true);
    assert.equal(JSON.parse(db.getItem(storageKey)).version, 3);
    assert.deepEqual(parseSession(serializeSession(old)), expected);
    assert.equal(JSON.parse(serializeSession(old)).version, 3);
    assert.deepEqual(decodeSessionLink(encodeSessionLink(old)), expected);
    const libraryRaw = JSON.stringify([
      { id: 'old', savedAt: '2026-10-04T12:00:00Z', session: envelope(old) },
      { id: 'raw', savedAt: '2026-10-04T12:00:00Z', session: old },
    ]);
    const library = readSessionLibrary(storage({ [SESSION_LIBRARY_KEY]: libraryRaw }), parseSession);
    assert.deepEqual(library.entries[0].session, expected);
    assert.deepEqual(library.entries[1].session, expected);
    assert.equal(library.recoveryRaw, null);
    const history = new History();
    history.push(old);
    history.push(patchSession(expected, { bpm: 120 }));
    assert.deepEqual(history.undo(), expected);
    assert.equal(history.redo().version, 3);
    assert.deepEqual(old, before);
  });

  test(`v2 ${fixture.name}: every prepared bar retains the exact original events`, () => {
    const session = validateSession(fixture.session).session;
    const arrangement = prepareArrangement(session);
    const events = Array.from({ length: session.bars }, (_, bar) => arrangement.barEvents(bar, { barIndex: bar }));
    assert.deepEqual(events, fixture.events);
  });
}

for (const length of [3, 64]) {
  test(`v2 migration retains accumulated duration tolerance for ${length} chords after v3 persistence`, () => {
    const durationBars = 1.0000001;
    const old = { version: 2, progression: { enabled: true, chords: Array.from({ length }, () => ({
      symbol: 'C', notes: [{ name: 'C', midi: 48 }], durationBars,
    })) } };
    const result = validateSession(old);
    assert.equal(result.ok, true);
    const migrated = result.session;
    let cursor = 0;
    for (const item of migrated.progression.chords) {
      assert.equal(item.startBar, cursor);
      assert.equal(item.durationBars, durationBars);
      cursor += durationBars;
    }
    assert.equal(migrated.progression.cycleBars, cursor);
    const db = storage();
    assert.equal(saveSession(migrated, db), true);
    assert.equal(JSON.parse(db.getItem(storageKey)).version, 3);
    assert.deepEqual(loadSession(db).session, migrated);
    assert.deepEqual(validateSession(migrated).session, migrated);
    assert.deepEqual(parseSession(serializeSession(migrated)), migrated);
    assert.deepEqual(decodeSessionLink(encodeSessionLink(migrated)), migrated);
    const invalidDuration = { ...migrated, progression: { ...migrated.progression,
      chords: [{ ...migrated.progression.chords[0], durationBars: 1.0000003 }] } };
    assert.equal(validateSession(invalidDuration).ok, false);
    const overlap = { ...migrated, progression: { ...migrated.progression,
      chords: [migrated.progression.chords[0], { ...migrated.progression.chords[1], startBar: 0.999996 }] } };
    assert.equal(validateSession(overlap).ok, false);
  });
}

test('missing v2 fields retain defaults, including disabled/empty cycles, without accepting new v3 fields', () => {
  const minimal = { version: 2, bars: 3 };
  assert.deepEqual(validateSession(minimal).session, createSession({ bars: 3 }));
  const old = { version: 2, bars: 2, progression: { enabled: false, chords: [parseChordSymbol('C'), parseChordSymbol('G7')] } };
  const migrated = validateSession(old).session;
  assert.equal(migrated.progression.enabled, false);
  assert.deepEqual(migrated.progression.chords.map(item => item.startBar), [0, 1]);
  assert.equal(migrated.progression.cycleBars, 2);
  assert.deepEqual(chordTimeline(migrated), []);
  for (const invalid of [
    { ...minimal, progression: { cycleBars: 2 } },
    { ...old, progression: { ...old.progression, chords: [{ ...old.progression.chords[0], startBar: 0 }] } },
    { ...minimal, unknown: true },
    { ...minimal, bpm: 301 },
  ]) {
    assert.equal(validateSession(invalid).ok, false);
    const raw = JSON.stringify(invalid);
    const db = storage({ [storageKey]: raw });
    assert.equal(loadSession(db).recoveryRaw, raw);
    assert.equal(db.getItem(storageKey + '.recovery'), raw);
    assert.equal(db.getItem(storageKey), raw);
  }
});

test('versions and envelope versions are authoritative on every entry point', () => {
  assert.equal(SESSION_VERSION, 3);
  const session = gaps();
  for (const version of [undefined, null, 0, 1, 4, '3']) {
    const invalid = { ...session, version };
    assert.equal(validateSession(invalid).ok, false);
    assert.throws(() => parseSession(JSON.stringify(invalid)), TypeError);
    assert.throws(() => decodeSessionLink(oldLink(invalid)), TypeError);
    assert.equal(saveSession(invalid, storage()), false);
  }
  for (const version of [2, 4]) assert.throws(() => parseSession(JSON.stringify({ ...envelope(session), version })), TypeError);
  const old = fixtures[0].session;
  assert.throws(() => parseSession(JSON.stringify({ ...envelope(old), version: 3 })), TypeError);
  const raw = JSON.stringify([{ id: 'mismatched', savedAt: '2026-10-04T12:00:00Z', session: { ...envelope(old), version: 3 } }]);
  const db = storage({ [SESSION_LIBRARY_KEY]: raw });
  const library = readSessionLibrary(db, parseSession);
  assert.deepEqual(library.entries, []);
  assert.equal(library.recoveryRaw, raw);
  assert.equal(db.getItem(SESSION_LIBRARY_KEY), raw);
});

test('v3 validation rejects invalid grids, order, overlap and bounds without concealing or correcting them', () => {
  const session = gaps();
  const invalidProgressions = [
    ...[0, -1, 1025, Infinity, NaN, '2', 2.1, null].map(cycleBars => ({ ...session.progression, cycleBars })),
    ...[-0.25, 0.1, 1025, Infinity, null, '0'].map(startBar => ({ ...session.progression, chords: [{ ...session.progression.chords[0], startBar }] })),
    { ...session.progression, chords: [chord('C', 0, 1), chord('G', 0.5, 1)] },
    { ...session.progression, chords: [...session.progression.chords].reverse() },
    { ...session.progression, chords: [chord('C', 1.75, 0.5)] },
    { ...session.progression, chords: [chord('C', 0, 0.1)] },
    { ...session.progression, chords: [parseChordSymbol('C'), parseChordSymbol('G')] },
  ];
  for (const progression of invalidProgressions) {
    const before = structuredClone(progression);
    assert.equal(validateSession({ ...session, progression }).ok, false);
    assert.deepEqual(progression, before);
  }
  assert.equal(validateSession({ ...session, progression: { ...session.progression, chords: [chord('C', 0, 1), chord('G', 1, 1)] } }).ok, true);
  assert.equal(createSession({ bars: 4 }).progression.cycleBars, 4);
  assert.deepEqual(chordTimeline(createSession({ progression: { enabled: true, cycleBars: 8, chords: [] } })), []);
});

test('legacy full 1024-bar cycles are not clamped or dropped and bars edits retain the cycle', () => {
  const old = { version: 2, bars: 1, progression: { enabled: true, chords: Array.from({ length: 64 }, () => ({ ...parseChordSymbol('C'), durationBars: 16 })) } };
  const result = validateSession(old);
  assert.equal(result.ok, true);
  assert.equal(result.session.progression.cycleBars, 1024);
  assert.equal(result.session.progression.chords.at(-1).startBar, 1008);
  assert.equal(chordTimeline(result.session).length, 1);
  const located = createSession({ progression: { enabled: true, cycleBars: 4, chords: [chord('C', 2)] } });
  assert.deepEqual(chordTimeline(located), []);
  const expanded = patchSession(located, { bars: 4 });
  assert.deepEqual(expanded.progression, located.progression);
  assert.equal(chordTimeline(expanded)[0].start, 32);
  assert.deepEqual(patchSession(expanded, { bars: 1 }).progression, located.progression);
  const fractional = createSession({ meter: { beats: 7, unit: 8 }, progression: { enabled: true, cycleBars: 4 / 7, chords: [chord('C', 2 / 7, 2 / 7)] } });
  assert.throws(() => patchSession(fractional, { meter: { beats: 4, unit: 4 } }), TypeError);
});

test('timeline repeats leading, middle and trailing pauses, clips intervals and preserves source indices', () => {
  assert.deepEqual(chordTimeline(gaps()).map(event => [event.start, event.duration, event.index]), [[4, 8, 0], [20, 8, 1], [36, 8, 0], [52, 8, 1]]);
  const session = gaps({ bars: 3, progression: { enabled: true, cycleBars: 2, chords: [chord('C', 0.75, 0.75), chord('G', 1.75, 0.25)] } });
  assert.deepEqual(chordTimeline(session).map(event => [event.start, event.duration, event.index]), [[12, 12, 0], [28, 4, 1], [44, 4, 0]]);
});

test('bass and comping are silent in explicit gaps and all sustain ends stay within their chord interval', () => {
  const session = gaps();
  const intervals = chordTimeline(session);
  for (const generated of [generateBass(session), generateComping(session)]) {
    assert.ok(generated.length > 0);
    for (const note of generated) {
      const interval = intervals.find(event => note.start >= event.start && note.start < event.start + event.duration);
      assert.ok(interval, `attack in a gap at ${note.start}`);
      assert.ok(note.start + note.duration <= interval.start + interval.duration + 1e-6);
    }
  }
  const invisible = createSession({ band: { bassEnabled: true }, progression: { enabled: true, cycleBars: 4, chords: [chord('C', 2)] } });
  assert.deepEqual(generateBass(invisible), []);
  assert.deepEqual(generateComping(invisible), []);
  const arrangement = prepareArrangement(invisible);
  assert.ok(arrangement.barEvents(0).every(event => !['bass', 'chords'].includes(event.channel)));
  for (const progression of [{ ...invisible.progression, enabled: false }, { ...invisible.progression, chords: [] }]) {
    assert.ok(generateBass({ ...invisible, progression }).length > 0);
    assert.deepEqual(generateComping({ ...invisible, progression }), []);
  }
});

test('follow replies never fill a middle gap or sustain into one, even on a later repeated cycle', () => {
  const session = gaps({ band: { mode: 'follow', bassEnabled: true, style: 'complement', density: 'medium' } });
  const arrangement = prepareArrangement(session);
  const activity = { previous: [], earlier: [4, 11, 12, 15] };
  for (const bar of [0, 2]) {
    const answers = arrangement.barEvents(bar, { activity }).filter(event => event.channel === 'chords');
    assert.deepEqual(answers.map(event => [event.tick, event.duration]), [[4, 2], [11, 1]]);
    assert.ok(answers.every(event => event.tick + event.duration <= 12));
  }
  const continuous = createSession({ bars: 2, progression: { enabled: true, cycleBars: 2, chords: [chord('C', 0), chord('G', 1)] }, band: { mode: 'follow', style: 'complement' }, metronome: { enabled: false } });
  const events = prepareArrangement(continuous).barEvents(0, { activity: { previous: [], earlier: [15] } });
  assert.deepEqual(events.filter(event => event.channel === 'chords').map(event => [event.tick, event.duration]), [[15, 1]]);
});

test('a bass attack just before a gap is not lengthened across the pause by the minimum note duration', () => {
  const session = gaps({ notes: [{ id: 'late', start: 11.9, duration: 0.1 }], band: { bassEnabled: true, style: 'complement', density: 'busy' } });
  const note = generateBass(session).find(event => event.start === 11.9);
  assert.ok(note);
  assert.ok(Math.abs(note.duration - 0.1) < 1e-6);
  assert.ok(note.start + note.duration <= 12);
});

test('MIDI exports explicit intervals across the full session, with gaps, repetitions and final clipping', () => {
  const session = gaps({ bars: 3, progression: { enabled: true, cycleBars: 2, chords: [chord('C', 0.75, 0.75), chord('G', 1.75, 0.25)] } });
  const parsed = parseMidi(sessionToMidi(session));
  const notes = parsed.tracks.find(track => track.name === 'Acordes').notes;
  const actual = notes.map(note => [note.tick, note.durationTicks, note.pitch]).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  const expected = chordTimeline(session).flatMap(event => event.chord.notes.map(note => [event.start * MIDI_PPQ / 4, event.duration * MIDI_PPQ / 4, note.midi])).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  assert.deepEqual(actual, expected);
  // The final SMF End-of-Track delta retains the explicit trailing quarter-bar
  // pause after the last note: 4 session ticks = one MIDI quarter (480 ticks).
  assert.deepEqual(Array.from(sessionToMidi(gaps()).slice(-5)), [0x83, 0x60, 0xff, 0x2f, 0x00]);
  assert.equal(parseMidi(sessionToMidi(session, { includeChords: false })).tracks.length, 2);
  const invisible = createSession({ progression: { enabled: true, cycleBars: 4, chords: [chord('C', 2)] } });
  assert.equal(parseMidi(sessionToMidi(invisible)).tracks.length, 2);
});

test('steady and follow harmony and bass carry a hard audible boundary to the compiled plan', () => {
  for (const mode of ['steady', 'follow']) {
    const session = createSession({ bpm: 100, progression: { enabled: true, cycleBars: 1, chords: [chord('C', 0.25, 0.5)] },
      band: { mode, bassEnabled: true, style: 'pop', density: 'busy' }, timbres: { chords: 'pad' }, metronome: { enabled: false } });
    const options = mode === 'follow' ? { activity: { previous: [], earlier: [11] } } : {};
    const arranged = prepareArrangement(session).barEvents(0, options);
    for (const channel of ['chords', 'bass']) {
      const events = arranged.filter(event => event.channel === channel);
      assert.ok(events.length > 0);
      assert.ok(events.every(event => event.stopTick === 12));
    }
    const bar = compileBarPlan(session).bars[0];
    for (const event of bar.events(options)) {
      assert.equal(event.stopTick, 12);
      assert.ok(Math.abs(event.tick * bar.secPerTick + event.maxSeconds - 1.8) < 1e-8);
    }
    if (mode === 'follow') {
      const answer = bar.events(options).find(event => event.channel === 'chords');
      assert.equal(answer.tick, 11);
      assert.ok(Math.abs(answer.maxSeconds - 0.15) < 1e-8);
    }
  }
});

test('the hard pause boundary follows section BPM/meter conversion and is minimized with the section edge', () => {
  const section = { id: 'a', kind: 'A', startBar: 0, endBar: 1, repeats: 1, bpm: 60, meter: { beats: 3, unit: 8 } };
  const session = createSession({ bpm: 100, progression: { enabled: true, cycleBars: 1, chords: [chord('C', 0.25, 0.5)] },
    band: { bassEnabled: true, style: 'pop', density: 'busy' }, metronome: { enabled: false }, form: { enabled: true, sections: [section] } });
  const bar = compileBarPlan(session).bars[0];
  assert.equal(bar.ticks, 6);
  assert.equal(bar.secPerTick, 0.25);
  assert.ok(bar.events().length > 0);
  for (const event of bar.events()) {
    assert.equal(event.stopTick, 4.5);
    assert.ok(Math.abs(event.tick * bar.secPerTick + event.maxSeconds - 1.125) < 1e-8);
  }
  const longer = createSession({ bars: 2, bpm: 100, progression: { enabled: true, cycleBars: 2, chords: [chord('C', 0, 1.75)] },
    band: { style: 'complement' }, metronome: { enabled: false }, form: { enabled: true, sections: [section] } });
  const clipped = compileBarPlan(longer).bars[0];
  assert.ok(clipped.events().length > 0);
  for (const event of clipped.events()) {
    assert.equal(event.stopTick, 10.5);
    assert.ok(Math.abs(event.tick * clipped.secPerTick + event.maxSeconds - clipped.duration) < 1e-8);
  }
});

test('contiguous chords share their next pause boundary across bars; fully continuous v2 keeps its original tails', () => {
  const session = createSession({ bars: 2, progression: { enabled: true, cycleBars: 2, chords: [chord('C', 0), chord('G', 1, 0.5)] },
    band: { style: 'complement' }, metronome: { enabled: false } });
  const arrangement = prepareArrangement(session);
  assert.equal(arrangement.barEvents(0)[0].stopTick, 24);
  assert.equal(arrangement.barEvents(1)[0].stopTick, 8);
  for (const fixture of fixtures) {
    const continuous = validateSession(fixture.session).session;
    const plan = compileBarPlan(continuous);
    for (const bar of plan.bars) {
      for (const event of bar.events()) {
        if (event.channel !== 'chords' && event.channel !== 'bass') continue;
        assert.equal(Object.hasOwn(event, 'stopTick'), false);
        assert.equal(event.maxSeconds, Infinity);
      }
    }
  }
});

test('offline dispatch hard-stops pad and piano sources at the explicit pause rather than their timbre tail', async () => {
  for (const timbre of ['pad', 'electric-piano']) {
    const session = createSession({ bpm: 100, progression: { enabled: true, cycleBars: 1, chords: [chord('C', 0.25, 0.5)] },
      band: { style: 'complement' }, timbres: { chords: timbre }, metronome: { enabled: false } });
    const rendered = await renderSession(session, { sampleRate: 8000, tailSeconds: 0, contextFactory: audioContext });
    assert.ok(rendered.context.sources.length > 0);
    for (const source of rendered.context.sources) assert.ok(Math.abs(source.stops.at(-1) - 1.8) < 1e-8);
  }
});

test('offline follow responses inherit the hard pause boundary for every chord voice', async () => {
  const session = createSession({ bars: 3, bpm: 100, training: { countInBars: 0 },
    progression: { enabled: true, cycleBars: 1, chords: [chord('C', 0.25, 0.5)] },
    band: { mode: 'follow', style: 'complement' }, timbres: { chords: 'pad' }, metronome: { enabled: false } });
  const rendered = await renderSession(session, { loops: 1, countIn: false, attempts: [{ start: 1.65, end: 1.7, pitch: 60 }],
    sampleRate: 8000, tailSeconds: 0, contextFactory: audioContext });
  const responses = rendered.context.sources.filter(source => source.startTime > 4.8);
  assert.ok(responses.length > 0);
  for (const source of responses) {
    assert.ok(Math.abs(source.startTime - 6.45) < 1e-8);
    assert.ok(Math.abs(source.stops.at(-1) - 6.6) < 1e-8);
  }
});

test('a source-loop leading pause hard-stops voices clipped from a longer harmonic cycle at the loop seam', () => {
  const session = createSession({ progression: { enabled: true, cycleBars: 2, chords: [chord('C', 0.25, 1.5)] },
    band: { style: 'complement' }, metronome: { enabled: false } });
  const events = prepareArrangement(session).barEvents(0);
  assert.ok(events.length > 0);
  assert.ok(events.every(event => event.stopTick === 16));
  const bar = compileBarPlan(session).bars[0];
  for (const event of bar.events()) assert.ok(Math.abs(event.tick * bar.secPerTick + event.maxSeconds - bar.duration) < 1e-8);
});
