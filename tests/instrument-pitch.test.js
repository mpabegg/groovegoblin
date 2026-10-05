import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPitchDetector, detectMonophonicPitch, createPitchStream, pitchReading, MIN_PITCH_FREQUENCY, MAX_PITCH_FREQUENCY } from '../src/instrument-pitch.js';
import { standardInstrumentProfile } from '../src/instrument-profile.js';

function waveform(rate, frequency, { seconds = 0.22, harmonics = [0.4], noise = 0, phase = 0.37, decay = Infinity } = {}) {
  const samples = new Float32Array(Math.ceil(rate * seconds));
  let seed = 83;
  for (let i = 0; i < samples.length; i++) {
    const time = i / rate;
    for (let h = 0; h < harmonics.length; h++) {
      if ((h + 1) * frequency < rate / 2) samples[i] += harmonics[h] * Math.exp(-time / decay) * Math.sin(2 * Math.PI * (h + 1) * frequency * time + phase * (h + 1));
    }
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    samples[i] += noise * (seed / 4294967296 * 2 - 1);
  }
  return samples;
}
function accurate(result, expected, label = '') {
  assert.ok(Number.isFinite(result.frequency) && result.frequency > 0, `${label}: actual identified frequency`);
  const cents = 1200 * Math.log2(result.frequency / expected);
  assert.ok(Math.abs(cents) <= 5, `${label}: ${cents} cents exceeds 5`);
  assert.ok(result.confidence >= 0.85 && result.confidence <= 1);
  assert.ok(Number.isFinite(result.rms) && result.rms > 0);
}
for (const rate of [8000, 44100, 48000, 96000]) {
  test(`pure monophonic pitch covers every semitone B0–E6 within five cents at ${rate} Hz`, () => {
    const detector = createPitchDetector(rate);
    assert.ok(detector.windowSize / rate >= 3 / MIN_PITCH_FREQUENCY, 'bass has at least three cycles');
    for (let midi = 23; midi <= 88; midi++) {
      const frequency = 440 * 2 ** ((midi - 69) / 12);
      const samples = waveform(rate, frequency, { phase: midi * 0.113 });
      const original = samples.slice();
      accurate(detector.detect(samples), frequency, `${rate} / MIDI ${midi}`);
      assert.deepEqual(samples, original, 'pure detector does not mutate PCM');
    }
  });
  test(`fractional periods, strong harmonics and weak noisy fundamentals at ${rate} Hz`, () => {
    const detector = createPitchDetector(rate);
    for (const frequency of [MIN_PITCH_FREQUENCY, 41.2034, 55, 82.4069, 110, 196, 440, 659.255, MAX_PITCH_FREQUENCY]) {
      for (const cents of [-31, 23]) {
        const detuned = frequency * 2 ** (cents / 1200);
        accurate(detector.detect(waveform(rate, detuned, { harmonics: [0.025, 0.32, 0.16, 0.05], noise: 0.005 })), detuned, `weak ${frequency}, ${cents}`);
      }
      accurate(detector.detect(waveform(rate, frequency, { harmonics: [0.025, 0.4, 0.025], noise: 0.003 })), frequency, `even-dominant ${frequency}`);
      accurate(detector.detect(waveform(rate, frequency, { harmonics: [0.3, 0.18, 0.12], noise: 0.002, decay: 0.6 })), frequency, `decay ${frequency}`);
    }
  });
  test(`silence, DC, faint signals and noisy low-confidence input remain unidentified at ${rate} Hz`, () => {
    const detector = createPitchDetector(rate);
    for (const samples of [new Float32Array(detector.windowSize), new Float32Array(detector.windowSize).fill(0.4), waveform(rate, 440, { harmonics: [0.001] }), waveform(rate, 440, { harmonics: [], noise: 0.3 }), waveform(rate, 440, { harmonics: [0.02], noise: 0.4 })]) {
      const result = detector.detect(samples);
      assert.equal(result.frequency, null);
      assert.ok(Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1);
    }
    const short = waveform(rate, 440, { seconds: 0.03 });
    assert.equal(detector.detect(short).frequency, null, 'no pitch certainty before the complete bass-safe window');
  });
}

test('standalone pure API produces an actual detuned frequency without a tuning input', () => {
  const expected = 440 * 2 ** (17 / 1200);
  accurate(detectMonophonicPitch(waveform(48000, expected), 48000), expected);
});

test('streaming scratch reuse preserves source-frame windows and results across irregular blocks', () => {
  const rate = 8000, firstFrame = 1234;
  const samples = waveform(rate, MIN_PITCH_FREQUENCY, { seconds: 0.37, harmonics: [0.05, 0.3, 0.18], noise: 0.002 });
  function collect(sizes) {
    const stream = createPitchStream(rate);
    const results = [];
    let offset = 0, block = 0;
    while (offset < samples.length) {
      const size = Math.min(sizes[block++ % sizes.length], samples.length - offset);
      stream.push(samples.subarray(offset, offset + size), firstFrame + offset, result => results.push(result));
      offset += size;
    }
    for (const result of results) {
      accurate(result, MIN_PITCH_FREQUENCY);
      assert.equal(result.endFrame - result.startFrame, stream.windowSize);
      assert.equal(result.frame, (result.startFrame + result.endFrame) / 2);
    }
    assert.ok(results.length >= 3);
    return results;
  }
  assert.deepEqual(collect([128]), collect([17, 251, 43, 128]));
});

test('stream discontinuities and reset discard prior certainty instead of mixing captures', () => {
  const stream = createPitchStream(8000), readings = [];
  const samples = waveform(8000, 110);
  stream.push(samples, 0, result => readings.push(result));
  assert.ok(readings.length > 0); readings.length = 0;
  stream.push(samples.subarray(0, 200), 9000, result => readings.push(result));
  assert.equal(readings.length, 0);
  stream.reset();
  stream.push(samples.subarray(0, stream.windowSize - 1), 9200, result => readings.push(result));
  assert.equal(readings.length, 0);
});

test('A4 reference consistently changes real note names, actual custom-string targets and cents', () => {
  const bass = standardInstrumentProfile('bass', 5);
  const low = pitchReading(MIN_PITCH_FREQUENCY, bass);
  assert.equal(low.note, 23); assert.equal(low.string, 5); assert.equal(low.target, 23);
  assert.ok(Math.abs(low.targetCents) < 1e-9);
  const custom = { ...bass, tuning: [22, 27, 32, 37, 42], noteNames: 'solfege' };
  const frequency = 442 * 2 ** ((27 - 69) / 12);
  const tuned = pitchReading(frequency, custom, 442);
  assert.equal(tuned.target, 27); assert.equal(tuned.string, 4);
  assert.ok(Math.abs(tuned.targetCents) < 1e-9);
  const at440 = pitchReading(frequency, custom, 440);
  assert.ok(Math.abs(at440.targetCents - 1200 * Math.log2(442 / 440)) < 1e-9);
  assert.equal(pitchReading(440, custom, 429), null);
  assert.equal(pitchReading(null, custom), null);
});

for (const rate of [8000, 44100, 48000, 96000]) test(`actual worklet channel selection feeds ephemeral pitch PCM without audio monitoring at ${rate} Hz`, async t => {
  const originals = new Map();
  function install(name, value) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  t.after(() => { for (const [name, original] of originals) { if (original) Object.defineProperty(globalThis, name, original); else delete globalThis[name]; } });
  let Processor;
  const stream = createPitchStream(rate), readings = [], messages = [];
  install('sampleRate', rate); install('currentFrame', 0);
  install('AudioWorkletProcessor', class {
    constructor() {
      this.port = { onmessage: null, postMessage(message) {
        messages.push(message);
        if (message.type === 'samples') stream.push(message.samples, message.startFrame, pitch => readings.push(pitch));
      } };
    }
  });
  install('registerProcessor', (name, implementation) => { Processor = implementation; });
  await import(`../src/instrument-worklet.js?pitch-test-rate=${rate}`);
  const processor = new Processor({ processorOptions: { channel: '2', pitchEnabled: true } });
  const left = waveform(rate, 110, { seconds: 0.3 }), right = waveform(rate, 440, { seconds: 0.3 });
  function feed(startFrame) {
    for (let i = 0; i < left.length; i += 128) {
      globalThis.currentFrame = startFrame + i;
      const output = new Float32Array(Math.min(128, left.length - i));
      assert.equal(processor.process([[left.subarray(i, i + 128), right.subarray(i, i + 128)]], [[output]]), true);
      assert.ok(output.every(value => value === 0), 'captured audio is never monitored');
    }
  }
  feed(1000);
  assert.ok(readings.length > 0); for (const pitch of readings) accurate(pitch, 440);
  assert.ok(messages.some(message => message.events?.length), 'same processor still reports real attacks');
  assert.ok(messages.filter(message => message.type === 'samples').every(message => message.samples.length <= Math.ceil(rate * 0.02) && message.channel === '2'));
  stream.reset(); readings.length = 0;
  processor.port.onmessage({ data: { type: 'settings', settings: { channel: '1' } } });
  feed(1000 + left.length);
  assert.ok(readings.length > 0); for (const pitch of readings) accurate(pitch, 110);
  const count = messages.length;
  processor.port.onmessage({ data: { type: 'settings', settings: { pitchEnabled: false } } });
  feed(1000 + 2 * left.length);
  assert.ok(messages.slice(count).every(message => message.type !== 'samples'), 'unsubscribed pitch has no PCM traffic');
});
