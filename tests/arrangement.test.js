import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { prepareArrangement } from '../src/arrangement.js';
import { parseChordSymbol } from '../src/progression.js';
import { close } from './audio-harness.js';

test('fractional-meter count-in and audible/silent click cycles use denominator beats', () => {
  const session = createSession({ bars: 2, meter: { beats: 3, unit: 16 }, metronome: { audibleBars: 1, silentBars: 1 } });
  const arrangement = prepareArrangement(session);
  assert.deepEqual(arrangement.countInEvents().map(event => event.tick), [0, 1, 2]);
  assert.deepEqual(arrangement.barEvents(0).map(event => event.tick), [0, 1, 2]);
  assert.deepEqual(arrangement.barEvents(1, { barIndex: 1 }), []);
  assert.deepEqual(arrangement.barEvents(0, { barIndex: 2 }).map(event => event.tick), [0, 1, 2]);
});

test('polymetric companion cycles cross barlines rather than restarting each bar', () => {
  const session = createSession({ bars: 3, metronome: { enabled: false }, companion: { enabled: true, pulses: 3, spanBeats: 3 } });
  const arrangement = prepareArrangement(session);
  const bar1 = arrangement.barEvents(0, { barIndex: 0 });
  const bar2 = arrangement.barEvents(1, { barIndex: 1 });
  assert.deepEqual(bar1.map(event => event.tick), [0, 4, 8, 12]);
  assert.deepEqual(bar2.map(event => event.tick), [0, 4, 8, 12]);
  assert.equal(bar1[0].velocity, 0.8); assert.equal(bar2[0].velocity, 0.6);
  assert.equal(bar2[2].velocity, 0.8, 'next cycle starts at absolute tick 24');
});

test('polyrhythmic companion distributes noninteger subdivisions exactly', () => {
  const session = createSession({ meter: { beats: 7, unit: 8 }, companion: { enabled: true, pulses: 3, spanBeats: 7 }, metronome: { enabled: false } });
  const events = prepareArrangement(session).barEvents(0);
  assert.equal(events.length, 3); close(events[1].tick, 14 / 3); close(events[2].tick, 28 / 3);
});

test('phrase swing transforms endpoints while preserving articulation and microtime', () => {
  const session = createSession({ swing: 1 / 3, notes: [{ id: 'a', start: 2, duration: 2, pitch: 63, offsetMs: -12, articulation: 'staccato' }], metronome: { enabled: false } });
  const [event] = prepareArrangement(session).barEvents(0);
  close(event.tick, 8 / 3); close(event.duration, 4 / 3);
  assert.equal(event.pitch, 63); assert.equal(event.offsetMs, -12); assert.equal(event.articulation, 'staccato');
});

test('loop source range clips sustained notes at the selected final bar', () => {
  const session = createSession({ bars: 3, loop: { startBar: 1, endBar: 2 }, notes: [{ id: 'before', start: 0, duration: 4 }, { id: 'long', start: 20, duration: 16 }], metronome: { enabled: false } });
  const arrangement = prepareArrangement(session);
  assert.deepEqual(arrangement.barEvents(0), []);
  const [event] = arrangement.barEvents(1); close(event.tick, 4); close(event.duration, 12);
});

test('follow reacts only to real supplied activity and answers inside tiny bars', () => {
  const session = createSession({ meter: { beats: 3, unit: 16 }, band: { mode: 'follow', bassEnabled: true }, drums: { enabled: true, style: 'pop' }, progression: { enabled: true, chords: [parseChordSymbol('C')] }, metronome: { enabled: false } });
  const arrangement = prepareArrangement(session);
  const steady = arrangement.barEvents(0);
  assert.deepEqual(arrangement.barEvents(0, { activity: { previous: [], earlier: [] } }), steady);
  const space = arrangement.barEvents(0, { activity: { previous: [0.5], earlier: [] } });
  assert.ok(space.filter(event => event.channel === 'chords').every(event => event.changes));
  const answer = arrangement.barEvents(0, { activity: { previous: [], earlier: [0.5, 1.25] } });
  assert.ok(answer.every(event => event.tick >= 0 && event.tick < 3));
  assert.deepEqual(answer.filter(event => event.channel === 'chords').map(event => event.tick), [0.5, 1.25]);
});
