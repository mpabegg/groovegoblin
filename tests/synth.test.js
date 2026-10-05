import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMBRE_IDS, playTone, playChord, playClick, playDrum, articulate, midiToFrequency } from '../src/synth.js';
import { audioContext, close } from './audio-harness.js';

test('every available timbre creates finite real sources with a bounded release', () => {
  for (const timbre of TIMBRE_IDS) {
    const ctx = audioContext();
    const voice = playTone(ctx, ctx.destination, { time: 1, duration: 0.05, pitch: 60, velocity: 0.8, timbre });
    assert.ok(voice.sources.length > 0, timbre);
    assert.ok(voice.end >= 1 && voice.end <= 1.35, timbre);
    for (const source of voice.sources) { assert.equal(source.startTime, 1); assert.ok(source.stops.at(-1) >= voice.end); }
    for (const event of voice.gain.gain.events) assert.ok(Number.isFinite(event.time) && Number.isFinite(event.value), timbre);
  }
});

test('articulation changes gate and velocity without replacing pitches', () => {
  assert.deepEqual(articulate(1, 0.8, 'staccato'), { gate: 0.45, velocity: 0.8, overlap: 0 });
  close(articulate(1, 0.8, 'ghost').velocity, 0.32);
  assert.equal(articulate(1, 1, 'accent').velocity, 1);
  assert.equal(articulate(1, 0.8, 'legato').overlap, 0.03);
  close(midiToFrequency(69), 440); close(midiToFrequency(81), 880);
});

test('chord voice count does not inflate the summed peak envelope', () => {
  const ctx = audioContext();
  const peak = voice => Math.max(...voice.gain.gain.events.map(event => event.value));
  const one = playTone(ctx, ctx.destination, { time: 0, duration: 1, pitch: 60, velocity: 0.8, timbre: 'soft-lead' });
  for (const pitches of [[60, 64, 67], [48, 55, 60, 64, 67, 71, 74, 77]]) {
    const voices = playChord(ctx, ctx.destination, { time: 0, duration: 1, pitches, velocity: 0.8, timbre: 'soft-lead' });
    close(voices.reduce((sum, voice) => sum + peak(voice), 0), peak(one));
  }
});

test('every drum voice synthesizes without network samples and click accents have different pitch', () => {
  const ctx = audioContext();
  for (const instrument of ['kick', 'snare', 'hihat', 'openhat', 'rim', 'ride', 'shaker', 'tom', 'triangle']) {
    const voice = playDrum(ctx, ctx.destination, { time: 0.2, instrument, velocity: 0.5 });
    assert.ok(voice.sources.length > 0); assert.ok(voice.end > 0.2);
  }
  const downbeat = playClick(ctx, ctx.destination, { time: 1, accent: 'bar' });
  const beat = playClick(ctx, ctx.destination, { time: 1, accent: 'beat' });
  assert.notEqual(downbeat.sources[0].frequency.events[0].value, beat.sources[0].frequency.events[0].value);
});

test('clean and muted guitars are distinct real builders, not fallback synth aliases', () => {
  const voices = new Map();
  for (const timbre of ['soft-lead', 'nylon-guitar', 'clean-guitar', 'muted-guitar']) {
    assert.ok(TIMBRE_IDS.includes(timbre));
    const ctx = audioContext();
    const voice = playTone(ctx, ctx.destination, { time: 1, duration: 1, pitch: 52, timbre });
    voices.set(timbre, { ctx, voice });
    assert.ok(voice.sources.every(source => source.startTime === 1 && source.connections.length > 0));
    assert.ok(voice.gain.connections.includes(ctx.destination));
  }
  const clean = voices.get('clean-guitar'); const muted = voices.get('muted-guitar');
  assert.deepEqual(clean.voice.sources.map(source => source.type), ['sawtooth', 'triangle']);
  assert.deepEqual(muted.voice.sources.map(source => source.type), ['triangle', 'sine']);
  close(clean.voice.end, 2.06); close(muted.voice.end, 1.18);
  close(clean.voice.sources[0].frequency.events[0].value, midiToFrequency(52));
  close(muted.voice.sources[0].frequency.events[0].value, midiToFrequency(52));
  const decay = voice => voice.gain.gain.events.find(event => event.kind === 'target').constant;
  close(decay(clean.voice), 0.95); close(decay(muted.voice), 0.045);
  assert.notEqual(decay(clean.voice), decay(voices.get('nylon-guitar').voice));
  assert.notDeepEqual(clean.voice.gain.gain.events, voices.get('soft-lead').voice.gain.gain.events);
  assert.notDeepEqual(muted.voice.gain.gain.events, clean.voice.gain.gain.events);
});
