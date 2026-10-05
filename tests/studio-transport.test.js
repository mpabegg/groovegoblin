import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, serializeSession, validateSession } from '../src/session.js';
import { compileBarPlan } from '../src/form.js';
import { rulerLoop, rulerTick, rulerStep, playbackStartTick } from '../src/transport-position.js';
import { createStudioPlayback, effectiveMixer, phrasePreviewSession } from '../src/studio-playback.js';
import { buildRhythmNotation } from '../src/notation.js';
import { notationSystems } from '../src/studio-score.js';
import { midiToFrequency } from '../src/synth.js';
import { harness, deferred, close } from './audio-harness.js';

const note = (id, start, pitch = 60) => ({ id, start, duration: 1, pitch });
const section = (id, startBar, endBar, patch = {}) => ({ id, name: id, kind: 'A', startBar, endBar, repeats: 1, ...patch });

test('ruler loop includes both dragged bars in either direction and clamps outer boundaries', () => {
  const session = createSession({ bars: 4, meter: { beats: 7, unit: 8 }, subdivision: 3 });
  for (const [from, to, expected] of [[0.26, 0.74, [1, 3]], [0.74, 0.26, [1, 3]], [-1, 2, [0, 4]], [1, 1, [3, 4]], [0.5, 0.5, [2, 3]]]) {
    const loop = rulerLoop(session, from, to);
    assert.deepEqual([loop.startBar, loop.endBar], expected);
    assert.equal(validateSession({ ...session, loop }).ok, true);
  }
  close(rulerTick(session, 1), 42 + 40 / 3);
  close(rulerTick(session, 0.25), 14);
  close(rulerStep(session, 14, -1), 40 / 3);
  close(rulerStep(session, 40 / 3, 1), 14);
  assert.equal(rulerTick(session, -1), 0);
  const tiny = createSession({ bars: 1, meter: { beats: 1, unit: 16 }, subdivision: 1 });
  assert.equal(rulerTick(tiny, 1), 0);
});

test('source start resolves inside loop, clamps excluded bars and chooses first occurrence in a real form', () => {
  const session = createSession({ bars: 4, loop: { startBar: 1, endBar: 3 } });
  const plan = compileBarPlan(session);
  assert.equal(playbackStartTick(session, plan, 36), 20);
  assert.equal(playbackStartTick(session, plan, 0), 0);
  assert.equal(playbackStartTick(session, plan, 64), 16);
  const form = createSession({ ...session, form: { enabled: true, loop: false, sections: [section('B', 2, 3, { bpm: 60, meter: { beats: 3, unit: 8 }, repeats: 2 }), section('A', 0, 1)] } });
  const formed = compileBarPlan(form);
  assert.equal(playbackStartTick(form, formed, 36), 4);
  assert.equal(playbackStartTick(form, formed, 4), 36);
  assert.equal(playbackStartTick(form, formed, 20), 0);
});

test('start and seek dispatch target attacks on the existing scheduler, skip past attacks and wrap only at loop end', async t => {
  const h = harness(t);
  const session = createSession({ bars: 4, bpm: 120, loop: { startBar: 1, endBar: 3 }, metronome: { enabled: false }, notes: [note('outside', 0, 55), note('first', 16, 60), note('past', 32, 62), note('start', 36, 64)] });
  await h.audio.playSession(session, { startTick: 36 });
  close(h.ctx.sources[0].startTime, 0.06);
  close(h.ctx.sources[0].frequency.events[0].value, midiToFrequency(64));
  h.advance(0.06); close(h.audio.position.tick, 36);
  h.advance(1.56); close(h.audio.position.tick, 16);
  assert.ok(!h.ctx.sources.some(source => source.frequency.events[0].value === midiToFrequency(55)));
  const previous = [...h.ctx.sources]; const clock = [...h.intervals][0];
  assert.equal(h.audio.seek(32), true);
  assert.equal(h.intervals.size, 1); assert.equal([...h.intervals][0], clock);
  assert.ok(previous.every(source => source.stops.length >= 2));
  const target = h.ctx.sources.at(-1); close(target.startTime, 1.62); close(target.frequency.events[0].value, midiToFrequency(62));
  h.advance(1.62); close(h.audio.position.tick, 32);
  h.advance(2.13);
  assert.ok(h.ctx.sources.some(source => Math.abs(source.startTime - 2.12) < 1e-8 && source.frequency.events[0].value === midiToFrequency(64)));
});

test('seek respects variable form meter/BPM and finite ending without changing saved form', async t => {
  const h = harness(t);
  const session = createSession({ bars: 3, bpm: 120, metronome: { enabled: false }, notes: [note('A', 0, 60), note('B', 32, 64), note('local', 36, 67)], form: { enabled: true, loop: false, sections: [section('A', 0, 1), section('B', 2, 3, { bpm: 60, meter: { beats: 3, unit: 8 } })] } });
  const saved = serializeSession(session);
  await h.audio.playSession(session, { startTick: 36 });
  h.advance(0.06); assert.equal(h.audio.position.sectionId, 'B'); close(h.audio.position.tick, 36);
  close(h.ctx.sources[0].frequency.events[0].value, midiToFrequency(67));
  h.advance(1.184); assert.equal(h.audio.position.mode, 'loop');
  h.advance(1.186); assert.equal(h.audio.position.mode, 'idle');
  assert.equal(serializeSession(session), saved);
});

test('training ignores ephemeral playback start and refuses seek without disturbing count-in or evaluation', async t => {
  const finished = []; const h = harness(t, { onFinish: (...args) => finished.push(args) });
  const session = createSession({ bars: 2, bpm: 300, meter: { beats: 1, unit: 16 }, loop: { startBar: 1, endBar: 2 }, training: { countInBars: 1, repetitions: 1 }, notes: [note('target', 1)] });
  await h.audio.playSession(session, { mode: 'train', startTick: 1 });
  assert.equal(h.audio.position.mode, 'countin'); assert.equal(h.audio.seek(1), false);
  h.advance(0.111); assert.equal(h.audio.position.mode, 'train');
  h.audio.press(120, 60); h.audio.release(150);
  h.advance(0.161); assert.equal(finished.length, 1); assert.equal(finished[0][0].length, 1);
});

test('solo is an immediate mixer overlay and clearing it restores manual mutes and volumes, including edits while soloed', async t => {
  const h = harness(t);
  let session = createSession({ metronome: { enabled: false }, notes: [note('phrase', 0)], mixer: { phrase: { volume: 0.4 }, drums: { muted: true, volume: 0.23 }, bass: { volume: 0.61 }, chords: { volume: 0.37 } } });
  const original = serializeSession(session);
  const state = createStudioPlayback({ getSession: () => session, audio: h.audio, render() {}, notify() {} });
  await h.audio.playSession(session);
  const bus = h.ctx.sources[0].connections[0].connections[0]; const clock = [...h.intervals][0];
  state.toggleSolo('bass'); assert.equal(bus.gain.events.at(-1).value, 0);
  assert.equal(serializeSession(session), original);
  session = createSession({ ...session, mixer: { ...session.mixer, phrase: { volume: 0.17, muted: true }, bass: { volume: 0.52, muted: false } } });
  state.reconcile(); state.toggleSolo('phrase'); state.toggleSolo('bass'); state.toggleSolo('phrase');
  assert.deepEqual(state.getMixer(), session.mixer);
  assert.equal(state.getMixer().drums.muted, true); assert.equal(state.getMixer().bass.muted, false);
  assert.equal(state.getMixer().bass.volume, 0.52); assert.equal(bus.gain.events.at(-1).value, 0);
  assert.equal([...h.intervals][0], clock);
  assert.deepEqual(effectiveMixer(session.mixer, new Set(['bass'])).metronome, session.mixer.metronome);
});

test('phrase listening is audible despite saved mute/zero volume, uses one finite loop and never persists its mix or form', async t => {
  let finishes = 0; const h = harness(t, { onFinish: () => finishes++ });
  const session = createSession({ bars: 2, bpm: 300, meter: { beats: 1, unit: 16 }, loop: { startBar: 1, endBar: 2 }, notes: [note('phrase', 1, 72)], mixer: { phrase: { muted: true, volume: 0 }, drums: { muted: false, volume: 0.3 } }, form: { enabled: true, sections: [section('intro', 0, 1, { kind: 'intro' })] } });
  const saved = serializeSession(session); const snapshot = phrasePreviewSession(session);
  const state = createStudioPlayback({ getSession: () => session, audio: h.audio, render() {}, notify() {} });
  state.setListening(true);
  await h.audio.playSession(snapshot, { once: true, mixer: state.getMixer() });
  const source = h.ctx.sources[0]; close(source.frequency.events[0].value, midiToFrequency(72));
  assert.equal(source.connections[0].connections[0].gain.events.at(-1).value, 1);
  assert.equal(h.intervals.size, 1); h.advance(0.111);
  assert.equal(h.audio.position.mode, 'idle'); assert.equal(h.intervals.size, 0); assert.equal(finishes, 0);
  state.setListening(false);
  assert.deepEqual(state.getMixer(), session.mixer);
  assert.equal(source.connections[0].connections[0].gain.events.at(-1).value, 0);
  assert.equal(serializeSession(session), saved); assert.equal(session.mixer.phrase.muted, true); assert.equal(session.form.enabled, true);
});

test('stopping a pending start with a seek position cannot resurrect another scheduler', async t => {
  const gate = deferred(); const h = harness(t, { resumeGate: gate });
  const request = h.audio.playSession(createSession({ bars: 4 }), { startTick: 32 });
  h.audio.stop(); gate.resolve(); assert.equal(await request, false);
  assert.equal(h.intervals.size, 0); assert.equal(h.audio.position.mode, 'idle');
});

test('four-bar notation systems preserve absolute events and ties across system boundaries', () => {
  const session = createSession({ bars: 9, notes: [{ id: 'held', start: 60, duration: 20, pitch: 60 }, note('last', 128)] });
  const model = buildRhythmNotation(session.notes, session); const systems = notationSystems(model);
  assert.deepEqual(systems.map(system => [system.barOffset, system.bars]), [[0, 4], [4, 4], [8, 1]]);
  assert.deepEqual(systems.flatMap(system => system.measures.flatMap(measure => measure.events)), model.measures.flatMap(measure => measure.events));
  const outgoing = systems[0].measures.at(-1).events.at(-1);
  const incoming = systems[1].measures[0].events[0];
  assert.equal(outgoing.tieToNext, true); assert.equal(incoming.tieFromPrevious, true);
  assert.equal(incoming.noteId, outgoing.noteId); assert.equal(incoming.start, 64);
  assert.deepEqual(systems[1].measures.map(measure => measure.index), [1, 2, 3, 4]);
});
