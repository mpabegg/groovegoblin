import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { compileBarPlan } from '../src/form.js';
import { parseChordSymbol } from '../src/progression.js';
import { midiToFrequency } from '../src/synth.js';
import { harness, deferred, close } from './audio-harness.js';

const phrase = () => createSession({ bpm: 120, metronome: { enabled: false }, notes: [{ id: 'a', start: 0, duration: 1, pitch: 60 }, { id: 'b', start: 8, duration: 1, pitch: 62 }] });
test('loop consumer applies live create/move/resize/delete/intensity and undo snapshots beyond the dispatched horizon', async t => {
  const h = harness(t); const original = phrase(); await h.audio.playSession(original); h.advance(0.3);
  const position = h.audio.position.tick; const scheduled = h.ctx.sources[0];
  const edited = createSession({ ...original, notes: [{ ...original.notes[0], start: 4, duration: 2, velocity: 0.3 }, { id: 'new', start: 12, duration: 2, pitch: 72 }] });
  h.audio.updateSession(edited); close(h.audio.position.tick, position); assert.equal(h.intervals.size, 1); assert.equal(scheduled.stops.length, 1);
  h.advance(1.6);
  for (const [tick, pitch] of [[4, 60], [12, 72]]) assert.ok(h.ctx.sources.some(source => Math.abs(source.startTime - (0.06 + tick * 0.125)) < 1e-8 && Math.abs(source.frequency.events[0].value - midiToFrequency(pitch)) < 1e-8));
  assert.ok(!h.ctx.sources.some(source => Math.abs(source.startTime - 1.06) < 1e-8));
  h.audio.updateSession(original); h.advance(3.1);
  assert.ok(h.ctx.sources.some(source => Math.abs(source.startTime - 3.06) < 1e-8 && Math.abs(source.frequency.events[0].value - midiToFrequency(62)) < 1e-8));
  assert.equal(h.audio.position.mode, 'loop'); assert.equal(h.intervals.size, 1);
});
test('live chord and key replacement schedules the actual new voices without resetting the loop', async t => {
  const h = harness(t);
  const original = createSession({ bars: 2, bpm: 120, progression: { enabled: true, cycleBars: 2, chords: [{ ...parseChordSymbol('C'), startBar: 0, durationBars: 1 }, { ...parseChordSymbol('G7'), startBar: 1, durationBars: 1 }] }, band: { style: 'pop', density: 'sparse' }, metronome: { enabled: false }, timbres: { chords: 'pluck' } });
  await h.audio.playSession(original); h.advance(0.3); const position = h.audio.position.tick;
  const edited = createSession({ ...original, progression: { ...original.progression, keyId: 'g-major', chords: [{ ...parseChordSymbol('Dm7'), startBar: 0, durationBars: 0.5 }, { ...parseChordSymbol('A7'), startBar: 1, durationBars: 1 }] } });
  h.audio.updateSession(edited); close(h.audio.position.tick, position); h.advance(3.95);
  const expected = compileBarPlan(edited).bars.flatMap(bar => bar.events().filter(event => event.kind === 'chord').flatMap(event => event.pitches.map(pitch => ({ time: 0.06 + bar.start + event.tick * bar.secPerTick, frequency: midiToFrequency(pitch) })))).filter(event => event.time > 0.4 && event.time < 4);
  assert.ok(expected.length); for (const event of expected) assert.ok(h.ctx.sources.some(source => Math.abs(source.startTime - event.time) < 1e-8 && Math.abs(source.frequency.events[0].value - event.frequency) < 1e-8));
  assert.equal(h.audio.position.mode, 'loop'); assert.equal(h.intervals.size, 1);
});
test('live drum variation is consumed by the existing scheduler and not only redrawn', async t => {
  const h = harness(t);
  const original = createSession({ bpm: 120, drums: { enabled: true, style: 'pop', density: 'busy', seed: 1 }, metronome: { enabled: false } });
  await h.audio.playSession(original); h.advance(0.3); const position = h.audio.position.tick;
  const edited = createSession({ ...original, drums: { ...original.drums, seed: 938 } });
  h.audio.updateSession(edited); close(h.audio.position.tick, position); h.advance(1.95);
  const expected = compileBarPlan(edited).bars[0].events().filter(event => event.kind === 'drum').map(event => ({ instrument: ['kick', 'snare', 'hihat'].indexOf(event.instrument), time: 0.06 + event.tick * 0.125 + (event.offsetMs ?? 0) / 1000 })).filter(event => event.time > 0.4 && event.time < 1.95);
  assert.ok(expected.length);
  for (const event of expected) assert.ok(h.ctx.sources.some(source => source.type === 'buffer' && source.buffer.instrument === event.instrument && Math.abs(source.startTime - event.time) < 1e-8));
  assert.equal(h.audio.position.mode, 'loop'); assert.equal(h.intervals.size, 1);
});
test('editor audition voices real chords briefly while keeping the idle session and transport untouched', async t => {
  const states = []; const h = harness(t, { onState: state => states.push(state) }); const original = phrase(); h.audio.updateSession(original); const saved = h.audio.session;
  const chord = parseChordSymbol('Dm7'); assert.equal(await h.audio.audition(chord.notes.map(note => ({ pitch: note.midi })), { channel: 'chords', timbre: 'pluck' }), true);
  assert.equal(h.audio.position.mode, 'idle'); assert.equal(h.audio.session, saved); assert.equal(h.intervals.size, 0); assert.equal(states.length, 0);
  for (const note of chord.notes) assert.ok(h.ctx.sources.some(source => Math.abs(source.frequency.events[0].value - midiToFrequency(note.midi)) < 1e-8));
  assert.ok(h.ctx.sources.every(source => source.stops[0] < 1));
  await h.audio.playSession(original); const count = h.ctx.sources.length; const loop = h.audio.session;
  assert.equal(await h.audio.audition([{ pitch: 80 }]), false); assert.equal(h.ctx.sources.length, count); assert.equal(h.audio.session, loop); assert.equal(h.audio.position.mode, 'loop');
});
test('audition cannot resurrect after stop or race a pending training start', async t => {
  const gate = deferred(); const h = harness(t, { resumeGate: gate }); const audition = h.audio.audition([{ pitch: 69 }]);
  const train = h.audio.playSession(phrase(), { mode: 'train' }); gate.resolve();
  assert.equal(await audition, false); await train;
  const saved = h.audio.session; const count = h.ctx.sources.length;
  assert.equal(await h.audio.audition([{ pitch: 80 }]), false); assert.equal(h.audio.session, saved); assert.equal(h.ctx.sources.length, count); assert.equal(h.audio.position.mode, 'countin');
});
