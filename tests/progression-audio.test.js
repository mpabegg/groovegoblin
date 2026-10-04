import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrooveAudio } from '../src/audio.js';
import { generateProgression } from '../src/progression.js';

// Grafo Web Audio de teste: relógio e scheduler controlados, sem timers reais
// nem dispositivo de áudio. O smoke no navegador cobre a saída Web Audio real.
function audioFixture(t, { suspended = false } = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  let scheduler = null;
  const intervals = new Set();
  let nextInterval = 0;
  const resumes = [];
  class Parameter {
    value = 0;
    events = [];
    setValueAtTime(value, time) { this.events.push({ kind: 'set', value, time }); }
    linearRampToValueAtTime(value, time) { this.events.push({ kind: 'ramp', value, time }); }
    cancelScheduledValues(time) { this.events.push({ kind: 'cancel', time }); }
  }
  class Gain {
    gain = new Parameter();
    connect(node) { return node; }
    disconnect() {}
  }
  class Oscillator {
    frequency = new Parameter();
    stops = [];
    connect(node) { this.gain = node; return node; }
    disconnect() {}
    start(time) { this.startTime = time; }
    stop(time) { this.stops.push(time); }
  }
  class Context {
    currentTime = 0;
    state = suspended ? 'suspended' : 'running';
    destination = {};
    oscillators = [];
    createGain() { return new Gain(); }
    createOscillator() { const node = new Oscillator(); this.oscillators.push(node); return node; }
    getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: performance.now() }; }
    resume() { return new Promise(resolve => { resumes.push(() => { this.state = 'running'; resolve(); }); }); }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: Context });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'AudioContext', original);
    else delete globalThis.AudioContext;
  });
  t.mock.method(globalThis, 'setInterval', callback => {
    scheduler = callback;
    const id = ++nextInterval;
    intervals.add(id);
    return id;
  });
  t.mock.method(globalThis, 'clearInterval', id => intervals.delete(id));
  const audio = new GrooveAudio();
  t.after(() => audio.stop());
  return {
    audio, intervals,
    tick(time) { audio.context.currentTime = time; scheduler(); },
    resume() { resumes.shift()(); },
  };
}

const hz = midi => 440 * 2 ** ((midi - 69) / 12);

test('loop de cinco tétrades agenda quatro frequências simultâneas por compasso e repete a sequência', async t => {
  const fixture = audioFixture(t);
  const { audio } = fixture;
  let draw = 0;
  const progression = generateProgression({ keyId: 'c-major', random: () => draw++ === 0 ? 0.99 : ((draw - 2) + 0.5) / 7 });
  await audio.playProgression(progression, 120);
  assert.equal(audio.position.mode, 'progression');
  assert.equal(fixture.intervals.size, 1);
  for (let index = 0; index < 5; index += 1) {
    fixture.tick(0.061 + index * 2);
    assert.equal(audio.position.bar, index + 1);
    assert.equal(audio.context.oscillators.length, (index + 1) * 4);
    const voices = audio.context.oscillators.slice(index * 4, index * 4 + 4);
    assert.deepEqual(voices.map(node => node.frequency.events[0].value), progression.chords[index].notes.map(note => hz(note.midi)));
    assert.ok(voices.every(node => node.startTime === voices[0].startTime));
    for (const voice of voices) {
      assert.ok(voice.gain.gain.events.some(event => event.kind === 'ramp' && event.value === 0.55 / 4));
      const end = voice.gain.gain.events.at(-1);
      assert.equal(end.value, 0);
      assert.ok(Math.abs(end.time - voice.startTime - 2) < 1e-10);
    }
  }
  fixture.tick(10.061);
  assert.equal(audio.position.bar, 1);
  assert.equal(audio.context.oscillators.length, 24);
  assert.deepEqual(audio.context.oscillators.slice(20).map(node => node.frequency.events[0].value), progression.chords[0].notes.map(note => hz(note.midi)));
  const nodes = [...audio.context.oscillators];
  audio.stop();
  assert.equal(audio.position.mode, 'idle');
  assert.equal(fixture.intervals.size, 0);
  assert.ok(nodes.every(node => node.stops.length === 2));
  assert.ok(nodes.every(node => node.gain.gain.events.some(event => event.kind === 'cancel')));
});

test('trocar progressão ou iniciar ritmo/treino cancela o grafo anterior e mantém um único scheduler', async t => {
  const fixture = audioFixture(t);
  const { audio } = fixture;
  const first = generateProgression({ keyId: 'c-major', random: () => 0 });
  const second = generateProgression({ keyId: 'b-minor', random: () => 0 });
  await audio.playProgression(first, 120);
  const firstNodes = [...audio.context.oscillators];
  await audio.playProgression(second, 120);
  assert.equal(fixture.intervals.size, 1);
  assert.ok(firstNodes.every(node => node.stops.length === 2));
  assert.deepEqual(audio.context.oscillators.slice(4).map(node => node.frequency.events[0].value), second.chords[0].notes.map(note => hz(note.midi)));
  const secondNodes = audio.context.oscillators.slice(4);
  await audio.play([{ id: 'rhythm', start: 0, duration: 4 }], 120, false);
  assert.equal(audio.position.mode, 'play');
  assert.equal(fixture.intervals.size, 1);
  assert.ok(secondNodes.every(node => node.stops.length === 2));
  const rhythm = audio.context.oscillators.at(-1);
  assert.equal(rhythm.frequency.events[0].value, 440);
  assert.ok(rhythm.gain.gain.events.some(event => event.value === 0.55));
  await audio.playProgression(first, 120);
  assert.equal(rhythm.stops.length, 2);
  const progressionNodes = audio.context.oscillators.slice(-4);
  t.mock.method(globalThis, 'setTimeout', () => 1);
  t.mock.method(globalThis, 'clearTimeout', () => {});
  await audio.train([{ id: 'rhythm', start: 0, duration: 4 }], 120);
  assert.equal(audio.position.mode, 'countin');
  assert.equal(fixture.intervals.size, 1);
  assert.ok(progressionNodes.every(node => node.stops.length === 2));
  assert.equal(audio.context.oscillators.at(-1).type, 'square');
});

test('parar durante resume não deixa osciladores ou scheduler antigos iniciarem', async t => {
  const fixture = audioFixture(t, { suspended: true });
  const { audio } = fixture;
  const progression = generateProgression({ keyId: 'a-minor', random: () => 0 });
  const pending = audio.playProgression(progression, 120);
  audio.stop();
  fixture.resume();
  await pending;
  assert.equal(audio.position.mode, 'idle');
  assert.equal(audio.context.oscillators.length, 0);
  assert.equal(fixture.intervals.size, 0);
  await audio.playProgression(progression, 120);
  assert.equal(audio.position.mode, 'progression');
  assert.equal(audio.context.oscillators.length, 4);
  assert.equal(fixture.intervals.size, 1);
});

test('trocar tonalidade durante resume invalida a continuação anterior', async t => {
  const fixture = audioFixture(t, { suspended: true });
  const { audio } = fixture;
  const first = generateProgression({ keyId: 'c-major', random: () => 0 });
  const second = generateProgression({ keyId: 'f-sharp-minor', random: () => 0 });
  const oldStart = audio.playProgression(first, 120);
  const newStart = audio.playProgression(second, 120);
  fixture.resume();
  await oldStart;
  assert.equal(audio.context.oscillators.length, 0);
  assert.equal(fixture.intervals.size, 0);
  fixture.resume();
  await newStart;
  assert.equal(audio.position.mode, 'progression');
  assert.equal(fixture.intervals.size, 1);
  assert.deepEqual(audio.context.oscillators.map(node => node.frequency.events[0].value), second.chords[0].notes.map(note => hz(note.midi)));
});
