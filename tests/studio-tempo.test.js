import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, serializeSession } from '../src/session.js';
import { acceleratedBarPlan, createTapTempo } from '../src/transport-tempo.js';
import { minimapViewport } from '../src/studio-minimap.js';
import { midiToFrequency } from '../src/synth.js';
import { harness, close, deferred } from './audio-harness.js';

const phrase = options => createSession({ bpm: 120, metronome: { enabled: false }, notes: [{ id: 'a', start: 0, duration: 1, pitch: 60 }], ...options });
const attacks = h => h.ctx.sources.filter(source => source.frequency.events.some(event => Math.abs(event.value - midiToFrequency(60)) < 1e-8)).map(source => source.startTime);

for (const bars of [0, 1, 2]) test(`normal count-in ${bars} bars uses written 3/8 beats before phrase`, async t => {
  const h = harness(t); const session = phrase({ meter: { beats: 3, unit: 8 } });
  await h.audio.playSession(session, { countInBars: bars });
  assert.equal(h.audio.position.mode, bars ? 'countin' : 'loop');
  h.advance(0.06 + bars * 0.75 + 0.01);
  close(attacks(h)[0], 0.06 + bars * 0.75);
  assert.equal(h.audio.position.mode, 'loop');
  if (bars) {
    const clicks = h.ctx.sources.filter(source => source.type === 'square' && source.frequency.events.some(event => [1500, 1800, 2200].includes(event.value)));
    assert.equal(clicks.length, bars * 3);
    for (const [beat, click] of clicks.entries()) {
      close(click.startTime, 0.06 + beat * 0.25);
      assert.equal(click.frequency.events[0].value, beat % 3 === 0 ? 2200 : 1500);
    }
  }
});
test('stop cancels count-in and an unresolved audio preparation', async t => {
  const gate = deferred(); const h = harness(t, { resumeGate: gate });
  const started = h.audio.playSession(phrase(), { countInBars: 2 }); h.audio.stop(); gate.resolve();
  assert.equal(await started, false); assert.equal(h.audio.position.mode, 'idle'); assert.equal(h.intervals.size, 0);
  await h.audio.playSession(phrase(), { countInBars: 2 }); h.advance(0.4); h.audio.stop(); h.advance(8);
  assert.equal(attacks(h).length, 0); assert.equal(h.intervals.size, 0);
});
test('normal count-in preserves a selected mid-bar source start', async t => {
  const h = harness(t); const session = phrase({ notes: [{ id: 'a', start: 8, duration: 1, pitch: 60 }] });
  await h.audio.playSession(session, { startTick: 8, countInBars: 1 }); h.advance(2.08);
  close(attacks(h)[0], 2.06); close(h.audio.position.tick, 8.16);
});
test('training keeps its own count-in, without normal entry or accelerator duplication', async t => {
  const h = harness(t); const session = phrase({ training: { countInBars: 1, repetitions: 2 } });
  await h.audio.playSession(session, { mode: 'train', countInBars: 2, accelerator: { enabled: true, increment: 10, loops: 1, cap: 150 } });
  h.advance(2.061); assert.equal(h.audio.position.mode, 'train'); assert.equal(h.audio.position.countInBars, 1); assert.equal(h.audio.position.bpm, 120);
});
test('accelerator clocks three exact loop seams, caps and resets without changing canonical export', async t => {
  const h = harness(t); const session = phrase(); const saved = serializeSession(session);
  await h.audio.playSession(session, { accelerator: { enabled: true, increment: 10, loops: 1, cap: 140 } });
  const starts = [0.06, 2.06, 2.06 + 240 / 130, 2.06 + 240 / 130 + 240 / 140];
  h.advance(starts[3] + 0.01);
  starts.forEach((time, index) => close(attacks(h)[index], time));
  assert.equal(h.audio.position.bpm, 140); assert.equal(h.audio.position.acceleration.nextIn, null);
  assert.equal(serializeSession(session), saved); assert.equal(h.audio.session.bpm, 120);
  h.audio.stop(); assert.equal(h.audio.position.bpm, 120);
  await h.audio.playSession(session); assert.equal(h.audio.position.bpm, 120);
});
test('accelerator M whole loops and live manual BPM reanchor preserve source position', async t => {
  const h = harness(t); const session = phrase();
  await h.audio.playSession(session, { accelerator: { enabled: true, increment: 10, loops: 2, cap: 150 } });
  h.advance(3); assert.equal(h.audio.position.bpm, 120);
  h.advance(4.1); assert.equal(h.audio.position.bpm, 130);
  const tick = h.audio.position.tick; h.audio.updateSession({ ...session, bpm: 100 });
  close(h.audio.position.tick, tick); assert.equal(h.audio.position.bpm, 100); assert.equal(h.intervals.size, 1);
});
test('accelerated form keeps explicit section meter and BPM on a shared invertible plan', () => {
  const session = phrase({ bars: 2, form: { enabled: true, loop: true, sections: [{ id: 'a', startBar: 0, endBar: 1, bpm: 100, meter: { beats: 3, unit: 8 } }, { id: 'b', startBar: 1, endBar: 2, bpm: 140 }] } });
  const plan = acceleratedBarPlan(session, { enabled: true, increment: 10, loops: 1, cap: 150 });
  for (let bar = 0; bar < 12; bar++) {
    close(plan.locate(plan.timeAt(bar)).index, bar);
    assert.equal(plan.at(bar).bpm, Math.min(150, (bar % 2 ? 140 : 100) + Math.min(3, Math.floor(bar / 2)) * 10));
  }
});
test('Tap averages at least three intervals, excludes an outlier and resets a long gap', () => {
  const tap = createTapTempo(); assert.equal(tap(0), null); assert.equal(tap(500), null); assert.equal(tap(1000), null);
  assert.equal(tap(1500), 120); assert.equal(tap(2250), 120); assert.equal(tap(2750), 120);
  assert.equal(tap(6000), null); assert.equal(tap(6500), null); assert.equal(tap(7000), null); assert.equal(tap(7500), 120);
});
test('minimap viewport excludes sticky headers and tracks horizontal scrolling', () => {
  assert.deepEqual(minimapViewport(0, 1000, 1000), { start: 0, end: 1, overflow: false });
  assert.deepEqual(minimapViewport(800, 1000, 3400), { start: 0.25, end: 0.5, overflow: true });
  assert.deepEqual(minimapViewport(2400, 1000, 3400), { start: 0.75, end: 1, overflow: true });
});

test('all backing and phrase voices dispatch on the same accelerating loop plan', async t => {
  const { parseChordSymbol } = await import('../src/progression.js');
  const h = harness(t);
  const session = phrase({ metronome: { enabled: true }, drums: { enabled: true, style: 'pop', density: 'medium' },
    progression: { enabled: true, cycleBars: 1, chords: [{ ...parseChordSymbol('C'), startBar: 0, durationBars: 1 }] },
    band: { bassEnabled: true, style: 'pop', density: 'medium' } });
  const accelerator = { enabled: true, increment: 10, loops: 1, cap: 140 };
  const plan = acceleratedBarPlan(session, accelerator);
  await h.audio.playSession(session, { accelerator });
  h.advance(0.06 + plan.timeAt(3) - 0.12);
  const channels = new Set();
  for (let bar = 0; bar < 3; bar++) {
    for (const event of plan.at(bar).events({ barIndex: bar })) {
      const time = 0.06 + plan.timeAt(bar) + event.tick * plan.at(bar).secPerTick + (event.offsetMs ?? 0) / 1000;
      if (time < 0.06 || time >= h.ctx.currentTime) continue;
      channels.add(event.channel);
      const atTime = h.ctx.sources.filter(source => Math.abs(source.startTime - time) < 1e-8);
      if (event.kind === 'drum') assert.ok(atTime.some(source => source.type === 'buffer'), `${event.channel} at ${time}`);
      else if (event.kind === 'note' || event.kind === 'chord') {
        for (const pitch of event.pitches ?? [event.pitch]) assert.ok(atTime.some(source => source.frequency.events.some(value => Math.abs(value.value - midiToFrequency(pitch)) < 1e-8)), `${event.channel} ${pitch} at ${time}`);
      } else assert.ok(atTime.length, `${event.channel} at ${time}`);
    }
  }
  assert.deepEqual([...channels].sort(), ['bass', 'chords', 'drums', 'metronome', 'phrase']);
  assert.equal(h.intervals.size, 1);
});

test('phrase-only listening gets an audible entry and finishes one source pass', async t => {
  const { phrasePreviewSession } = await import('../src/studio-playback.js');
  const h = harness(t); const session = phrasePreviewSession(phrase());
  await h.audio.playSession(session, { once: true, countInBars: 1 });
  assert.equal(h.audio.position.mode, 'countin'); assert.equal(h.audio.position.training, false);
  const click = h.ctx.sources.find(source => source.type === 'square' && source.frequency.events[0]?.value === 2200);
  assert.ok(click);
  close(click.startTime, 0.06);
  // The entry has a separate metronome bus; phrase-preview's saved mute cannot silence it.
  const reachesAudibleBus = node => node.connections?.some(next => next.gain?.value === 0.65 || reachesAudibleBus(next));
  assert.ok(reachesAudibleBus(click));
  h.advance(2.08); close(attacks(h)[0], 2.06);
  h.advance(4.08); assert.equal(h.audio.position.mode, 'idle'); assert.equal(h.intervals.size, 0);
});
test('a partial first pass is not a completed accelerator loop', async t => {
  const h = harness(t); const session = phrase({ bars: 2, notes: [{ id: 'a', start: 16, duration: 1, pitch: 60 }] });
  await h.audio.playSession(session, { startTick: 16, accelerator: { enabled: true, increment: 10, loops: 1, cap: 140 } });
  h.advance(2.08); assert.equal(h.audio.position.bpm, 120);
  h.advance(6.08); assert.equal(h.audio.position.bpm, 130);
});
