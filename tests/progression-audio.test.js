import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { compileBarPlan } from '../src/form.js';
import { parseChordSymbol } from '../src/progression.js';
import { renderSession } from '../src/audio.js';
import { midiToFrequency } from '../src/synth.js';
import { harness, audioContext, close } from './audio-harness.js';

const song = () => createSession({ bars: 2, bpm: 120, meter: { beats: 7, unit: 8 },
  progression: { enabled: true, chords: [parseChordSymbol('Cmaj7'), parseChordSymbol('G7')] },
  band: { style: 'pop', density: 'sparse' }, metronome: { enabled: false }, timbres: { chords: 'pluck' },
});

test('canonical session schedules actual voiced chord pitches on the shared clock', async t => {
  const h = harness(t); const session = song(); const plan = compileBarPlan(session);
  await h.audio.playSession(session); h.advance(plan.duration - 0.01);
  const expected = plan.bars.flatMap(bar => bar.events().filter(event => event.kind === 'chord').flatMap(event => event.pitches.map(pitch => ({ frequency: midiToFrequency(pitch), time: 0.06 + bar.start + event.tick * bar.secPerTick }))));
  const beforeLoop = h.ctx.sources.filter(source => source.startTime < 0.06 + plan.duration - 1e-8);
  assert.equal(beforeLoop.length, expected.length);
  for (const event of expected) assert.ok(beforeLoop.some(source => Math.abs(source.startTime - event.time) < 1e-8 && Math.abs(source.frequency.events[0].value - event.frequency) < 1e-8));
  h.advance(plan.duration + 0.06);
  assert.equal(h.audio.position.bar, 1);
  h.audio.stop(); assert.equal(h.intervals.size, 0);
});

test('offline and live harmonic voices agree including fractional-meter timing', async t => {
  const h = harness(t); const session = song(); const duration = compileBarPlan(session).duration;
  await h.audio.playSession(session); h.advance(duration - 0.11);
  const live = h.ctx.sources.filter(source => source.startTime < duration + 0.06).map(source => [source.startTime - 0.06, source.frequency.events[0].value]);
  const offline = await renderSession(session, { loops: 1, contextFactory: audioContext, tailSeconds: 0 });
  const rendered = offline.context.sources.map(source => [source.startTime, source.frequency.events[0].value]);
  assert.equal(live.length, rendered.length);
  live.forEach((event, i) => { close(event[0], rendered[i][0]); close(event[1], rendered[i][1]); });
});

test('switching whole session stops all old voices and preserves only one scheduler', async t => {
  const h = harness(t); await h.audio.playSession(song()); const old = [...h.ctx.sources];
  await h.audio.playSession(createSession({ notes: [{ id: 'a', start: 0, duration: 1 }], metronome: { enabled: false } }));
  assert.equal(h.intervals.size, 1); assert.equal(h.audio.position.mode, 'loop');
  assert.ok(old.every(source => source.stops.length >= 2));
  h.audio.stop(); assert.equal(h.intervals.size, 0);
});

test('harmony role removes backing chords without silencing other enabled parts', () => {
  const session = createSession({ ...song(), band: { ...song().band, role: 'harmony', bassEnabled: true }, notes: [{ id: 'a', start: 0, duration: 1 }] });
  const events = compileBarPlan(session).bars[0].events();
  assert.equal(events.some(event => event.channel === 'chords'), false);
  assert.ok(events.some(event => event.channel === 'bass'));
  assert.ok(events.some(event => event.channel === 'phrase'));
});
