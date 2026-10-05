import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { parseChordSymbol } from '../src/progression.js';
import { buildRhythmNotation, rhythmNotationLayout, notationTickX } from '../src/notation.js';
import { notationSystems, scoreChordSegments, suggestedStroke } from '../src/studio-score.js';
import { getInstrumentClef, standardInstrumentProfile } from '../src/instrument-profile.js';
import { resolveTabPosition } from '../src/tablature.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const chord = (symbol, startBar, durationBars) => ({ ...parseChordSymbol(symbol), startBar, durationBars });
const notation = session => buildRhythmNotation(session.notes, session);

test('four-bar systems cap long scores without changing absolute musical events', () => {
  for (const bars of [1, 4, 8, 9, 12, 16]) {
    const session = createSession({ bars, notes: [{ id: 'held', start: 0, duration: bars * 16, pitch: 52, string: 4 }] });
    const model = notation(session), systems = notationSystems(model);
    assert.ok(systems.every(system => system.bars <= 4));
    assert.equal(systems.length, Math.ceil(bars / 4));
    assert.deepEqual(systems.flatMap(system => system.measures.flatMap(measure => measure.events)), model.measures.flatMap(measure => measure.events));
    const profile = standardInstrumentProfile();
    for (const system of systems) {
      const geometry = rhythmNotationLayout(system, { compact: true });
      for (const layout of geometry.layouts) {
        for (const { event, x } of layout.events) {
          assert.equal(event.string, 4);
          assert.deepEqual(resolveTabPosition(event, profile), { string: 4, fret: 2, playable: true, explicit: true });
          close(notationTickX(system, geometry, event.start), x);
          assert.ok(x >= layout.left && x < layout.left + layout.width);
        }
      }
    }
    for (const system of systems.slice(1)) assert.equal(system.measures[0].events[0].tieFromPrevious, true);
  }
});

test('glyph-spaced coordinates anchor actual attacks and interpolate within sustained pieces', () => {
  const session = createSession({ notes: [
    { id: 'short', start: 0, duration: 0.5, pitch: 52 },
    { id: 'next', start: 0.5, duration: 1.5, pitch: 53 },
    { id: 'held', start: 2, duration: 6, pitch: 55 },
  ] });
  const model = notation(session), geometry = rhythmNotationLayout(model, { compact: true });
  const events = geometry.layouts[0].events;
  for (const { event, x } of events) close(notationTickX(model, geometry, event.start), x);
  const a = events[0], b = events[1];
  close(notationTickX(model, geometry, 0.25), (a.x + b.x) / 2);
  assert.notEqual(b.x - a.x, 0.5 * 12, 'minimum spacing is not tick-percent positioning');
  let previous = -Infinity;
  for (let tick = 0; tick <= 16; tick += 0.125) {
    const x = notationTickX(model, geometry, tick);
    assert.ok(x >= previous); previous = x;
    assert.ok(x >= geometry.layouts[0].left && x <= geometry.right);
  }
});

test('whole-bar rests keep centred glyphs but continuous temporal coordinates', () => {
  const session = createSession({ bars: 4 }), model = notation(session);
  const geometry = rhythmNotationLayout(model, { compact: true });
  const layout = geometry.layouts[0];
  close(layout.events[0].x, layout.left + layout.width / 2);
  close(notationTickX(model, geometry, 0), layout.left + 24);
  close(notationTickX(model, geometry, 8), layout.left + 24 + (layout.width - 24) / 2);
  assert.ok(notationTickX(model, geometry, 0.001) > notationTickX(model, geometry, 0));
});

test('the instrument clef references the octave-below guitar and bass registers', () => {
  assert.deepEqual(getInstrumentClef(standardInstrumentProfile()), { sign: 'G', line: 2, octaveChange: -1 });
  for (const strings of [4, 5]) assert.deepEqual(getInstrumentClef(standardInstrumentProfile('bass', strings)), { sign: 'F', line: 4, octaveChange: -1 });
});

test('chords split per bar, repeat their real cycle and preserve harmonic gaps and spelling', () => {
  const session = createSession({ bars: 8, extensions: { studio: { instrument: { ...standardInstrumentProfile(), noteNames: 'solfege' } } }, progression: {
    enabled: true, cycleBars: 3, chords: [chord('C', 0.25, 1.25), chord('G7', 2, 0.5)],
  } });
  const systems = notationSystems(notation(session));
  const segments = systems.flatMap(system => scoreChordSegments(session, system));
  assert.deepEqual(segments.map(segment => [segment.start, segment.end, segment.symbol]), [
    [4, 16, 'C'], [16, 24, 'C'], [32, 40, 'G7'],
    [52, 64, 'C'], [64, 72, 'C'], [80, 88, 'G7'],
    [100, 112, 'C'], [112, 120, 'C'],
  ]);
  assert.equal(segments[1].continued, true);
  assert.equal(segments[4].continued, true, 'continuation crosses a four-bar system');
  for (const system of systems) {
    const geometry = rhythmNotationLayout(system, { compact: true });
    for (const segment of scoreChordSegments(session, system)) {
      const x = notationTickX(system, geometry, segment.start);
      assert.ok(x >= geometry.layouts[0].left && x < geometry.right);
    }
  }
});

test('stroke suggestions follow beat and subdivision, not tied reattacks', () => {
  const session = createSession({ subdivision: 2 });
  const event = start => ({ kind: 'note', start, articulation: 'normal', tieFromPrevious: false });
  assert.deepEqual([0, 2, 4, 6].map(start => suggestedStroke(event(start), session)), ['down', 'up', 'down', 'up']);
  assert.equal(suggestedStroke({ ...event(4), tieFromPrevious: true }, session), null);
  assert.equal(suggestedStroke({ ...event(0), kind: 'rest' }, session), null);
  const sixteenths = createSession({ subdivision: 4 });
  assert.deepEqual([0, 1, 2, 3].map(start => suggestedStroke(event(start), sixteenths)), ['down', 'up', 'down', 'up']);
});

test('the same assigned string uses actual tuning after splitting, without changing pitch', () => {
  const profile = { ...standardInstrumentProfile(), tuning: [38, 45, 50, 55, 59, 64] };
  const session = createSession({ bars: 8, notes: [{ id: 'drop', start: 60, duration: 12, pitch: 40, string: 6 }], extensions: { studio: { instrument: profile, phraseView: 'tab' } } });
  const pieces = notationSystems(notation(session)).flatMap(system => system.measures.flatMap(measure => measure.events)).filter(event => event.kind === 'note');
  assert.ok(pieces.length >= 2);
  assert.ok(pieces.some(event => event.tieFromPrevious));
  for (const piece of pieces) {
    assert.equal(piece.pitch, 40);
    assert.deepEqual(resolveTabPosition(piece, profile), { string: 6, fret: 2, playable: true, explicit: true });
  }
});
