import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { renderSession } from '../src/audio.js';
import { harness, audioContext, deferred, close } from './audio-harness.js';

const note = { id: 'n', start: 0, duration: 1, pitch: 69 };
const session = patch => createSession({ notes: [note], metronome: { enabled: false }, ...patch });
const section = (id, patch = {}) => ({ id, name: id, kind: 'A', startBar: 0, endBar: 1, repeats: 1, bpm: null, meter: null, density: null, ...patch });

test('playSession shares source position and actual section BPM/meter boundaries', async t => {
  const h = harness(t);
  await h.audio.playSession(session({ bpm: 120, form: { enabled: true, loop: false, sections: [section('A'), section('B', { bpm: 60, meter: { beats: 3, unit: 8 } })] } }));
  h.advance(2.059);
  assert.equal(h.audio.position.sectionId, 'A');
  h.advance(2.06);
  assert.equal(h.audio.position.sectionId, 'B');
  assert.equal(h.audio.position.bpm, 60);
  assert.deepEqual(h.audio.position.meter, { beats: 3, unit: 8 });
  close(h.audio.position.tick, 0);
  h.advance(2.81);
  close(h.audio.position.tick, 8);
  h.advance(3.56);
  assert.equal(h.audio.position.mode, 'idle');
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
  assert.ok(h.ctx.sources.every(source => source.stops.length > 0));
});

test('form loop cycles, repeats and one-shot have different transport endings', async t => {
  const h = harness(t);
  await h.audio.playSession(session({ bpm: 300, meter: { beats: 1, unit: 16 }, form: { enabled: true, loop: true, sections: [section('A', { repeats: 2 })] } }));
  h.advance(0.161);
  assert.equal(h.audio.position.mode, 'loop');
  assert.equal(h.audio.position.repetition, 2);
  assert.equal(h.audio.position.sectionRepeat, 1);
  assert.equal(h.ctx.sources.length, 5); // scheduler includes its 100 ms lookahead
  h.audio.stop();
  assert.equal(h.intervals.size, 0);
});

test('stop invalidates suspended start and preview and returns false on cancellation', async t => {
  const gate = deferred(); const h = harness(t, { resumeGate: gate });
  const start = h.audio.playSession(session()); h.audio.stop(); gate.resolve();
  assert.equal(await start, false);
  assert.equal(h.ctx.sources.length, 0);
  const preview = h.audio.preview([note]); h.audio.stop();
  assert.equal(await preview, false);
  assert.equal(h.audio.position.mode, 'idle');
});

test('latest play wins an earlier pending resume without leaked oscillators', async t => {
  const gate = deferred(); const h = harness(t, { resumeGate: gate });
  const old = h.audio.playSession(session({ bpm: 40 }));
  const latest = h.audio.playSession(session({ bpm: 200 }));
  gate.resolve();
  assert.equal(await old, false); assert.equal(await latest, true);
  assert.equal(h.audio.position.bpm, 200);
  assert.equal(h.ctx.sources.length, 1);
});

test('stop during sample loading never resurrects the transport', async t => {
  const gate = deferred(); const h = harness(t, { loadGate: gate });
  const start = h.audio.playSession(session({ drums: { enabled: true } }));
  h.audio.stop(); gate.resolve();
  assert.equal(await start, false); assert.equal(h.ctx.sources.length, 0);
  assert.equal(h.intervals.size, 0);
});

test('preview returns true only after audible end, then subsequent previews still cancel', async t => {
  const h = harness(t); let done = false;
  const preview = h.audio.preview([note], { bpm: 120 }).then(value => { done = value; return value; });
  h.advance(0.18); assert.equal(done, false);
  h.advance(0.3); assert.equal(await preview, true);
  const first = h.audio.preview([note]); const second = h.audio.preview([note]);
  assert.equal(await first, false); h.audio.stop(); assert.equal(await second, false);
});

test('fractional meters count in denominator beats, finish repetitions and freeze executed session', async t => {
  let finished; const h = harness(t, { onFinish: (attempts, detail) => { finished = { attempts, detail }; } });
  const original = session({ bpm: 120, meter: { beats: 3, unit: 16 }, training: { countInBars: 1, repetitions: 2 }, form: { enabled: true, sections: [section('unused', { bpm: 30 })] } });
  await h.audio.playSession(original, { mode: 'train' });
  assert.equal(h.audio.position.mode, 'countin');
  h.advance(0.2); assert.equal(h.audio.position.beat, 2);
  h.advance(0.435); assert.equal(h.audio.position.mode, 'train');
  h.audio.press(450, 60); h.audio.release(500);
  h.audio.updateSession({ ...original, bpm: 200, notes: [] });
  h.advance(1.185);
  assert.equal(h.audio.position.mode, 'idle');
  close(finished.attempts[0].start, 0.015);
  close(finished.attempts[0].end, 0.065);
  assert.equal(finished.detail.session.bpm, 120);
  assert.deepEqual(finished.detail.session.notes, original.notes);
  assert.ok(Object.isFrozen(finished.detail.session.notes));
});

test('press before audible start is ignored instead of becoming a negative training attempt', async t => {
  let attempts; const h = harness(t, { onFinish: value => { attempts = value; } });
  await h.audio.playSession(session({ bpm: 300, meter: { beats: 3, unit: 16 }, training: { countInBars: 0, repetitions: 1, monitor: false } }), { mode: 'train' });
  h.audio.press(0); h.advance(0.08); h.audio.release(80);
  h.audio.press(100, 64); h.audio.release(130);
  h.advance(0.21);
  assert.equal(attempts.length, 1); close(attempts[0].start, 0.04); close(attempts[0].end, 0.07);
});

test('fresh output timestamp determines training input and held attempt closes at exact finish', async t => {
  let attempts; const h = harness(t, { onFinish: value => { attempts = value; } });
  await h.audio.playSession(session({ bpm: 300, meter: { beats: 3, unit: 16 }, training: { countInBars: 0, repetitions: 1 } }), { mode: 'train' });
  h.ctx.getOutputTimestamp = () => ({ contextTime: h.ctx.currentTime - 0.04, performanceTime: h.ctx.currentTime * 1000 });
  h.advance(0.15); h.audio.press(150, 64);
  h.advance(0.23); assert.equal(attempts, undefined);
  h.advance(0.26); close(attempts[0].start, 0.05); close(attempts[0].end, 0.15);
});

test('mixer changes ramp the existing bus without restarting or creating voices', async t => {
  const h = harness(t); await h.audio.playSession(session());
  const source = h.ctx.sources[0]; const envelope = source.connections[0]; const bus = envelope.connections[0];
  const count = h.ctx.sources.length;
  h.audio.setMixer({ phrase: { volume: 0.4, muted: true } });
  assert.equal(bus.gain.events.at(-1).value, 0);
  assert.equal(h.ctx.sources.length, count); assert.equal(h.audio.position.mode, 'loop');
});

test('live tempo reanchors the playing fraction and rebuilds unscheduled notes', async t => {
  const h = harness(t); const original = session({ bpm: 120, notes: [note, { ...note, id: 'next', start: 8 }] });
  await h.audio.playSession(original); h.advance(0.56);
  close(h.audio.position.tick, 4);
  h.audio.updateSession({ ...original, bpm: 60 });
  close(h.audio.position.tick, 4);
  h.advance(1.56); close(h.audio.position.tick, 8);
  assert.ok(h.ctx.sources.some(source => Math.abs(source.startTime - 1.56) < 1e-8));
});

test('offline form duration and event times follow the identical compiled section clock', async () => {
  const rendered = await renderSession(session({ bpm: 120, form: { enabled: true, loop: false, sections: [section('A'), section('B', { bpm: 60, meter: { beats: 3, unit: 8 } })] } }), { loops: 2, tailSeconds: 0, sampleRate: 8000, contextFactory: audioContext });
  close(rendered.duration, 7);
  assert.deepEqual(rendered.context.sources.map(source => source.startTime), [0, 2, 3.5, 5.5]);
});

test('offline attempt takes ignore form and default to executed training repetition count', async () => {
  const rendered = await renderSession(session({ bpm: 120, meter: { beats: 3, unit: 16 }, training: { repetitions: 2, countInBars: 1 }, form: { enabled: true, sections: [section('slow', { bpm: 30, repeats: 16 })] } }), {
    attempts: [{ start: 0.1, end: 0.2, pitch: 72 }], tailSeconds: 0, sampleRate: 8000, contextFactory: audioContext,
  });
  close(rendered.duration, 1.125);
  assert.equal(rendered.context.sources.length, 4); // three count-in clicks + actual note
  close(rendered.context.sources.at(-1).startTime, 0.475);
});

test('offline rejects invalid render settings and malformed attempted performances', async () => {
  for (const options of [{ loops: 0 }, { sampleRate: 0 }, { tailSeconds: -1 }, { attempts: [{ start: -0.1, end: 1 }] }, { attempts: [{ start: 0, end: null }] }]) {
    await assert.rejects(renderSession(session(), { ...options, contextFactory: audioContext }), TypeError);
  }
});

test('master transfer remains linear at quiet levels and bounds simultaneous-channel peaks', async t => {
  const h = harness(t); await h.audio.playSession(session());
  const curve = h.ctx.nodes.find(node => node.type === 'waveshaper').curve;
  assert.ok(Math.max(...curve) <= 0.951); assert.ok(Math.min(...curve) >= -0.951);
  close(curve[2048], 0); close(curve[2304], 0.5);
});

test('preview cancelled during resume resolves false without ever scheduling sound', async t => {
  const gate = deferred(); const h = harness(t, { resumeGate: gate });
  const pending = h.audio.preview([note]);
  h.audio.stop(); gate.resolve();
  assert.equal(await pending, false); assert.equal(h.ctx.sources.length, 0);
});

test('preview completion waits for the audible clock, not only rendering time', async t => {
  const h = harness(t);
  h.ctx.getOutputTimestamp = () => ({ contextTime: Math.max(0, h.ctx.currentTime - 0.1), performanceTime: h.ctx.currentTime * 1000 });
  let completed = false;
  const pending = h.audio.preview([note], { bpm: 120 }).then(value => { completed = value; return value; });
  h.advance(0.25); await Promise.resolve();
  assert.equal(completed, false);
  h.advance(0.35); assert.equal(await pending, true);
});

test('stale output timestamps fall back to a fresh clock pair rather than recording negative attempts', async t => {
  let attempts; const h = harness(t, { onFinish: value => { attempts = value; } });
  await h.audio.playSession(session({ bpm: 120, training: { countInBars: 0, repetitions: 1, monitor: false } }), { mode: 'train' });
  h.ctx.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 1 });
  h.advance(0.5); h.audio.press(500); h.audio.release(620);
  h.advance(2.06);
  close(attempts[0].start, 0.44); close(attempts[0].end, 0.56);
});

test('root-loop anticipations cross later seams unchanged in realtime and offline', async t => {
  const h = harness(t);
  const expressive = session({ bpm: 120, notes: [{ ...note, offsetMs: -80 }] });
  await h.audio.playSession(expressive);
  h.advance(2);
  assert.ok(h.ctx.sources.some(source => Math.abs(source.startTime - 1.98) < 1e-8));
  const rendered = await renderSession(expressive, { loops: 2, tailSeconds: 0, contextFactory: audioContext });
  assert.equal(rendered.context.sources.length, 2);
  close(rendered.context.sources[0].startTime, 0);
  close(rendered.context.sources[1].startTime, 1.92);
});
