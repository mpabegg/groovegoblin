import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnsetState, detectOnsets, refractorySeconds, selectInputSample } from '../src/instrument-onsets.js';
import { captureFrameTime, contextPerformanceTime, compensatedTime, calibrateInput, detectClickLeak, inputTailSeconds, calibrationCollectionDeadline, CALIBRATION_REFRACTORY_SECONDS, readCalibration, saveCalibration, readInputPreferences, INPUT_PREFERENCES_KEY } from '../src/input-timing.js';
import { instrumentSession, InstrumentInputGate } from '../src/instrument-input.js';
import { resolveInputDevice } from '../src/instrument-capture.js';
import { mountPerformanceInput } from '../src/performance-input.js';
import { createSession, serializeSession } from '../src/session.js';
import { evaluateSession, summarizeFeedback } from '../src/feedback.js';
import { buildTimelineData } from '../src/timeline.js';
import { harness, audioContext, deferred, close } from './audio-harness.js';
import { mountPracticeTracks, practiceVoices } from '../src/practice-tracks.js';
import { createStudioPlayback } from '../src/studio-playback.js';

import { MIN_PITCH_FREQUENCY } from '../src/instrument-pitch.js';
function signal(rate, seconds, notes = [], noise = 0.001) {
  const samples = new Float32Array(Math.ceil(rate * seconds));
  let seed = 42;
  for (let i = 0; i < samples.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    samples[i] = ((seed / 4294967296) * 2 - 1) * noise;
  }
  for (const note of notes) {
    const start = Math.round(note.time * rate);
    const length = Math.round((note.length ?? 0.3) * rate);
    for (let i = 0; i < length && start + i < samples.length; i++) {
      const t = i / rate;
      const rise = note.rise ? Math.min(1, t / note.rise) : 1;
      const release = note.release ? Math.min(1, Math.max(0, (length - i) / rate / note.release)) : 1;
      const envelope = (note.amplitude ?? 0.45) * rise * release * (note.sustained ? 1 : Math.exp(-t / (note.decay ?? 0.05)));
      samples[start + i] += envelope * Math.sin(2 * Math.PI * (note.frequency ?? 440) * t + (note.phase ?? 0));
    }
  }
  return samples;
}
function analyze(samples, rate, options = {}, blockSize = 128) {
  let state = createOnsetState(rate);
  const events = [];
  let block = 0;
  for (let offset = 0; offset < samples.length;) {
    const size = Array.isArray(blockSize) ? blockSize[block++ % blockSize.length] : blockSize;
    const previous = state;
    const snapshot = { ...state };
    const result = detectOnsets(state, samples.subarray(offset, offset + size), options);
    assert.deepEqual(previous, snapshot, 'detector never mutates the supplied state');
    state = result.state; events.push(...result.events);
    offset += size;
  }
  return { state, events };
}
function located(events, expected, rate) {
  assert.equal(events.length, expected.length, 'no missed or extra attacks');
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(events[i].frame / rate - expected[i]) <= 0.01, `attack ${i} differs by more than 10 ms`);
}

for (const rate of [8000, 44100, 48000, 96000]) {
  test(`known decaying instrument attacks with noise are localized within 10 ms at ${rate} Hz`, () => {
    const times = [0.107, 0.381, 0.752, 1.119];
    const samples = signal(rate, 1.6, times.map((time, i) => ({ time, frequency: [82.41, 220, 440, 659.25][i], decay: 0.06, amplitude: [0.3, 0.5, 0.2, 0.6][i] })));
    const result = analyze(samples, rate);
    located(result.events, times, rate);
    assert.deepEqual(analyze(samples, rate, {}, 251).events, result.events, 'timestamps do not depend on block size');
  });
}

test('refractory suppresses attacks less than 50 ms apart and expands to 40% of slower grids', () => {
  const rate = 48000;
  const refractory = refractorySeconds({ bpm: 300, subdivision: 8 });
  close(refractory, 0.05);
  close(refractorySeconds({ bpm: 30, subdivision: 1 }), 0.8);
  close(refractorySeconds({ bpm: 300, subdivision: 8, swing: 0.75 }), 0.05);
  const times = [0.101, 0.134, 0.167, 0.201];
  const samples = signal(rate, 0.5, times.map(time => ({ time, frequency: 523.25, decay: 0.005, length: 0.026 })), 0.0005);
  const expected = [times[0], times[2]];
  located(analyze(samples, rate, { refractory }).events, expected, rate);
  located(analyze(samples, rate, { refractory: 0.001 }).events, expected, rate);
  const slowerTimes = [0.1, 0.6, 1.1];
  const slower = signal(rate, 1.4, slowerTimes.map(time => ({ time, decay: 0.005, length: 0.026 })), 0.0005);
  located(analyze(slower, rate, { refractory: refractorySeconds({ bpm: 30, subdivision: 1 }) }).events, [0.1, 1.1], rate);
});

for (const frequency of [41.2, 82.41, 220, 440, 880]) {
  test(`sustained ${frequency} Hz tone does not create phase-cycle or release attacks`, () => {
    const samples = signal(48000, 2.5, [{ time: 0.123, frequency, sustained: true, length: 1.9 }]);
    for (const sensitivity of [0.5, 1, 2]) located(analyze(samples, 48000, { sensitivity }).events, [0.123], 48000);
  });
}

test('silence and steady low background noise have no false positives', () => {
  for (const amplitude of [0, 0.0005, 0.001, 0.003]) {
    for (const sensitivity of [0.5, 1, 2]) assert.deepEqual(analyze(signal(48000, 1, [], amplitude), 48000, { sensitivity }).events, []);
  }
});
for (const rate of [8000, 44100, 48000, 96000]) {
  for (const frequency of [30.87, 41.2, 55, 98]) {
    test(`bass ${frequency} Hz 15 ms rises, sustained notes, releases and same-pitch reattacks at ${rate} Hz`, () => {
      const times = [0.107, 1.007, 1.907];
      for (const phase of [0, Math.PI / 2, Math.PI]) {
        const samples = signal(rate, 2.8, times.map(time => ({ time, frequency, phase, rise: 0.015, release: 0.07, length: 0.65, sustained: true, amplitude: 0.3 })));
        for (const sensitivity of [0.5, 1, 2]) {
          const options = { instrumentType: 'bass', sensitivity };
          const result = analyze(samples, rate, options);
          located(result.events, times, rate);
          assert.deepEqual(analyze(samples, rate, options, [1, 17, 251, 64, 513]).events, result.events, 'rising candidates survive arbitrary block partitions');
        }
      }
      const held = signal(rate, 2.5, [{ time: 0.123, frequency, rise: 0.015, sustained: true, length: 1.9, release: 0.07 }]);
      located(analyze(held, rate, { instrumentType: 'bass' }, [31, 128, 3, 1000]).events, [0.123], rate);
      assert.deepEqual(analyze(signal(rate, 0.6, [], 0.003), rate, { instrumentType: 'bass', sensitivity: 2 }).events, []);
    });
  }
}

test('bass detector keeps the minimum/grid refractory and reports an observed origin rather than a fixed ramp offset', () => {
  const rate = 48000;
  for (const rise of [0, 0.005, 0.015]) {
    const times = [0.1, 0.14, 0.2, 0.9];
    const samples = signal(rate, 1.2, times.map(time => ({ time, frequency: 98, rise, decay: 0.006, length: 0.025 })), 0);
    const result = analyze(samples, rate, { instrumentType: 'bass', refractory: 0.001 });
    located(result.events, [0.1, 0.2, 0.9], rate);
    assert.ok(result.events[0].frame >= Math.round(times[0] * rate), 'never blindly backdate an abrupt attack');
    located(analyze(samples, rate, { instrumentType: 'bass', refractory: 0.8 }).events, [0.1, 0.9], rate);
  }
});

test('channel 1, channel 2 and mono-safe averaged sum consume actual samples', () => {
  const channels = [Float32Array.of(0.4, -0.2), Float32Array.of(0.2, 0.4)];
  close(selectInputSample(channels, 0, '1'), 0.4, 1e-7);
  close(selectInputSample(channels, 0, '2'), 0.2, 1e-7);
  close(selectInputSample(channels, 0, 'sum'), 0.3, 1e-7);
  close(selectInputSample([channels[0]], 0, 'sum'), 0.4, 1e-7);
  assert.equal(selectInputSample([channels[0]], 0, '2'), 0);
});

test('detected count-in click leakage is diagnosed without claiming source separation', () => {
  const rate = 48000;
  const times = [0.2, 0.7, 1.2, 1.7];
  const events = analyze(signal(rate, 2, times.map(time => ({ time, frequency: 1500, decay: 0.004, length: 0.035 }))), rate).events;
  located(events, times, rate);
  assert.equal(detectClickLeak(times.map(time => time * 1000), events.map(event => event.frame / rate * 1000)).leaking, true);
  assert.equal(detectClickLeak(times.map(time => time * 1000), events.map(event => event.frame / rate * 1000 + 80)).leaking, false);
  assert.equal(detectClickLeak([200, 700, 1200], [202, 702]).leaking, false);
});

test('capture clock subtracts browser latency and residual compensation exactly once', () => {
  const processing = { contextTime: 10, performanceTime: 12000 };
  const output = { contextTime: 4, performanceTime: 12000 };
  const time = captureFrameTime(9.98 * 48000, 48000, processing, 0.017, 23);
  close(time, 11940, 1e-7);
  close(output.contextTime + (time - output.performanceTime) / 1000, 3.94);
  close(contextPerformanceTime(4.5, output), 12500);
  close(compensatedTime(11963, 23), time);
});

test('eight-click calibration discards warm-up, uses median of six and rejects bad evidence', () => {
  const clicks = Array.from({ length: 8 }, (_, i) => 1000 + i * 650);
  const offsets = [140, -120, 20, 24, 22, 23, 25, 23];
  const measured = clicks.map((click, i) => click + offsets[i]);
  const good = calibrateInput(clicks, measured);
  assert.equal(good.ok, true); assert.equal(good.compensationMs, 23); assert.equal(good.spreadMs, 5);
  assert.equal(calibrateInput(clicks, measured.slice(0, 7)).ok, false);
  assert.match(calibrateInput(clicks, [...measured, clicks[4] + 55]).reason, /ambíguo/);
  assert.match(calibrateInput(clicks, clicks.map((click, i) => click + (i % 2 ? 100 : -100))).reason, /Dispersão/);
  assert.equal(calibrateInput(clicks.slice(0, 7), measured).ok, false);
  assert.equal(calibrateInput(clicks, [NaN]).ok, false);
});

test('calibration is independent per device and keyboard, with manual zero/reset and safe keys', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  saveCalibration('interface-a', 23, storage); saveCalibration('interface-b', -12, storage); saveCalibration('keyboard', 7, storage);
  assert.equal(readCalibration('interface-a', storage), 23); assert.equal(readCalibration('interface-b', storage), -12);
  saveCalibration('interface-a', 0, storage); assert.equal(readCalibration('interface-a', storage), 0);
  saveCalibration('interface-a', null, storage); assert.equal(readCalibration('interface-a', storage), null);
  assert.equal(readCalibration('keyboard', storage), 7);
  saveCalibration('__proto__', 31, storage); assert.equal(readCalibration('__proto__', storage), 31);
  assert.throws(() => saveCalibration('bad', 501, storage), /500/);
  storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({ deviceId: 'interface-b', channel: '2', sensitivity: 1.5, mode: 'instrument' }));
  assert.deepEqual(readInputPreferences(storage), { deviceId: 'interface-b', channel: '2', sensitivity: 1.5, lastMode: 'keyboard' });
});

test('input policy changes only the executed snapshot, preserving session format and keyboard preferences', () => {
  const source = createSession({ training: { goal: 'pitch', monitor: true }, extensions: { practice: { objective: 'durations' }, custom: { retained: true } } });
  const before = serializeSession(source);
  const executed = instrumentSession(source, { compensationMs: 23 });
  assert.equal(executed.training.goal, 'timing'); assert.equal(executed.extensions.practice.objective, 'timing');
  assert.equal(executed.extensions.performanceInput.calibrated, true);
  assert.equal(executed.extensions.custom.retained, true);
  assert.equal(serializeSession(source), before); assert.equal(source.training.goal, 'pitch'); assert.equal(source.training.monitor, true);
  const result = evaluateSession(executed, []);
  assert.equal(result.goal, 'timing'); assert.equal(buildTimelineData(result, { session: executed }).attackOnly, true);
  assert.equal(buildTimelineData(evaluateSession(source, []), { session: source }).attackOnly, false);
});

function trainingSession(overrides = {}) {
  return createSession({ bpm: 120, bars: 1, training: { countInBars: 0, repetitions: 1, monitor: true }, metronome: { enabled: false }, drums: { enabled: false }, band: { bassEnabled: false }, progression: { enabled: false }, companion: { enabled: false }, ...overrides });
}

test('synthetic waveform detections become evaluated attempts through the real press/release engine, without monitor notes', async t => {
  let finished;
  const h = harness(t, { onFinish: (attempts, detail) => { finished = { attempts, detail }; } });
  h.ctx.getOutputTimestamp = () => ({ contextTime: h.ctx.currentTime - 0.035, performanceTime: h.ctx.currentTime * 1000 });
  const source = trainingSession({ notes: [0, 4, 8].map((start, i) => ({ id: `n${i}`, start, duration: 1, pitch: 69 })) });
  const executed = instrumentSession(source, { compensationMs: 23 });
  await h.audio.playSession(executed, { mode: 'train', inputTailSeconds: inputTailSeconds({ instrument: true, inputLatencySeconds: 0.017, compensationMs: 23 }) });
  const gate = new InstrumentInputGate(h.audio); t.after(() => gate.reset());
  const relative = [0, 0.5, 1];
  // Processing-domain frames contain declared input delay plus residual delay.
  const frames = analyze(signal(48000, 1.5, relative.map(time => ({ time: 0.06 + time + 0.035 + 0.017 + 0.023 }))), 48000).events;
  located(frames, relative.map(time => 0.135 + time), 48000);
  for (const event of frames) {
    h.advance(event.frame / 48000 + 0.01);
    const raw = captureFrameTime(event.frame, 48000, { contextTime: h.ctx.currentTime, performanceTime: h.ctx.currentTime * 1000 }, 0.017);
    gate.attack(compensatedTime(raw, 23));
  }
  h.advance(2.3);
  assert.ok(finished); assert.equal(finished.attempts.length, 3);
  const results = evaluateSession(finished.detail.session, finished.attempts);
  const summary = summarizeFeedback(results);
  assert.equal(summary.attackOk, 3); assert.equal(summary.extra, 0); assert.equal(summary.missed, 0); assert.equal(summary.goal, 'timing'); assert.equal(summary.pitchChecked, 0);
  for (let i = 0; i < relative.length; i++) close(finished.attempts[i].start, relative[i], 0.01);
  assert.equal(h.ctx.sources.length, 0, 'instrument attacks do not synthesize monitor/reference notes');
});

test('gate closes at the next attack or written duration, while keyboard monitor remains intact', async t => {
  let attempts;
  const h = harness(t, { onFinish: values => { attempts = values; } });
  await h.audio.playSession(trainingSession({ notes: [{ id: 'long', start: 0, duration: 4 }, { id: 'short', start: 4, duration: 1 }] }), { mode: 'train' });
  const gate = new InstrumentInputGate(h.audio); t.after(() => gate.reset());
  h.advance(0.06); gate.attack(60);
  h.advance(0.26); gate.attack(260);
  h.advance(0.86); gate.attack(860);
  h.advance(2.1);
  assert.equal(attempts.length, 3);
  close(attempts[0].end, 0.2); close(attempts[1].end, 0.7); close(attempts[2].end - attempts[2].start, 0.125);
  assert.equal(h.ctx.sources.length, 0);
  await h.audio.playSession(trainingSession(), { mode: 'train' });
  h.advance(2.2); h.audio.press(2200, 69);
  assert.ok(h.ctx.sources.length > 0, 'default keyboard press still monitors its note');
  h.audio.release(2250);
});

test('late capture callback before the musical boundary survives the input-latency tail', async t => {
  let attempts;
  const h = harness(t, { onFinish: values => { attempts = values; } });
  await h.audio.playSession(instrumentSession(trainingSession()), { mode: 'train', inputTailSeconds: 0.12 });
  h.advance(2.09); assert.equal(attempts, undefined); assert.equal(h.audio.position.mode, 'train');
  h.audio.press(2040, null, { monitor: false }); h.audio.release(2060);
  h.advance(2.2);
  assert.equal(attempts.length, 1); close(attempts[0].start, 1.98); close(attempts[0].end, 2);
});

test('calibration schedules eight audible clicks independently of a muted metronome and stop silences them', async t => {
  const h = harness(t);
  h.audio.setMixer({ metronome: { volume: 0, muted: true } });
  await h.audio.prepareInput();
  const clicks = await h.audio.calibrationClicks();
  assert.equal(clicks.length, 8); assert.equal(h.ctx.sources.length, 8);
  close(clicks[0], 500); close(clicks.at(-1), 5050);
  const voiceGain = h.ctx.sources[0].connections[0];
  const bus = voiceGain.connections[0];
  assert.ok(bus.gain.value > 0); assert.equal(bus.connections[0], h.ctx.destination);
  h.audio.stop(); assert.equal(bus.disconnected, true);
  assert.ok(h.ctx.sources.every(source => source.stops.length > 1));
});

test('keyboard applies the same residual compensation to press and release without duplicating output latency', async t => {
  let attempts;
  const h = harness(t, { onFinish: values => { attempts = values; } });
  h.ctx.getOutputTimestamp = () => ({ contextTime: h.ctx.currentTime - 0.04, performanceTime: h.ctx.currentTime * 1000 });
  await h.audio.playSession(trainingSession(), { mode: 'train' });
  h.advance(0.623); h.audio.press(compensatedTime(623, 23), 69);
  h.advance(0.748); h.audio.release(compensatedTime(748, 23));
  h.advance(2.2);
  close(attempts[0].start, 0.5); close(attempts[0].end, 0.625);
});

test('instrument snapshot supplies an attack objective even when the source has no practice extension', () => {
  const source = trainingSession();
  const executed = instrumentSession(source);
  assert.equal(executed.extensions.practice.objective, 'timing');
  assert.equal(executed.extensions.performanceInput.calibrated, false);
  assert.equal(source.extensions.practice, undefined);
});

test('calibration accepts all eight 650 ms clicks independently of a slow training grid', async t => {
  const h = harness(t);
  await h.audio.prepareInput();
  const clicks = await h.audio.calibrationClicks();
  const samples = signal(48000, 5.4, clicks.map(click => ({ time: click / 1000, decay: 0.005, length: 0.035 })));
  const trainingRefractory = refractorySeconds({ bpm: 30, subdivision: 1 });
  assert.equal(trainingRefractory, 0.8);
  assert.ok(analyze(samples, 48000, { refractory: trainingRefractory }).events.length < 8);
  const attacks = analyze(samples, 48000, { refractory: CALIBRATION_REFRACTORY_SECONDS }).events.map(event => event.frame / 48);
  assert.equal(attacks.length, 8);
  const result = calibrateInput(clicks, attacks);
  assert.equal(result.ok, true); assert.ok(Math.abs(result.compensationMs) <= 1);
});

for (const instrument of [false, true]) {
  test(`${instrument ? 'instrument' : 'keyboard'} preserves a final correct attack arriving after positive residual delay`, async t => {
    let attempts;
    const h = harness(t, { onFinish: values => { attempts = values; } });
    const latency = instrument ? 0.03 : 0;
    const compensationMs = 100;
    const tail = inputTailSeconds({ instrument, inputLatencySeconds: latency, compensationMs });
    close(tail, instrument ? 0.17 : 0.14);
    await h.audio.playSession(instrument ? instrumentSession(trainingSession(), { compensationMs }) : trainingSession(), { mode: 'train', inputTailSeconds: tail });
    const raw = 2035 + latency * 1000 + compensationMs;
    h.advance(raw / 1000);
    assert.equal(attempts, undefined); assert.equal(h.audio.position.mode, 'train');
    h.audio.press(compensatedTime(raw - latency * 1000, compensationMs), instrument ? null : 69, { monitor: !instrument });
    h.audio.release(compensatedTime(2060 + compensationMs, compensationMs));
    h.advance(2.4);
    assert.equal(attempts.length, 1); close(attempts[0].start, 1.975); close(attempts[0].end, 2);
    assert.equal(inputTailSeconds({ compensationMs: -100 }), 0);
    assert.equal(inputTailSeconds(), 0, 'uncalibrated keyboard retains its original zero tail');
  });
}

test('default input calibrations follow physical identity rather than the system alias', () => {
  const devices = [
    { deviceId: 'default', groupId: 'usb-a', label: 'Default - Interface A' },
    { deviceId: 'communications', groupId: 'usb-a', label: 'Communications - Interface A' },
    { deviceId: 'physical-a', groupId: 'usb-a', label: 'Interface A' },
    { deviceId: 'physical-b', groupId: 'usb-b', label: 'Interface B' },
  ];
  const a = resolveInputDevice({ deviceId: 'default', groupId: 'usb-a' }, devices);
  assert.equal(a.deviceId, 'physical-a'); assert.equal(a.calibrationDeviceId, 'physical-a');
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  saveCalibration(a.calibrationDeviceId, 23, storage);
  saveCalibration('default', 99, storage); // Legacy alias must not contaminate a physical device.
  const switched = devices.map(device => device.deviceId === 'default' ? { ...device, groupId: 'usb-b', label: 'Default - Interface B' } : device);
  const b = resolveInputDevice({ deviceId: 'default', groupId: 'usb-b' }, switched);
  assert.equal(b.deviceId, 'physical-b'); assert.equal(readCalibration(b.calibrationDeviceId, storage), null);
  assert.equal(readCalibration(a.calibrationDeviceId, storage), 23);
  const groupA = resolveInputDevice({ deviceId: 'default', groupId: 'opaque-a' }, []);
  const groupB = resolveInputDevice({ deviceId: 'default', groupId: 'opaque-b' }, []);
  assert.equal(groupA.calibrationDeviceId, 'group:opaque-a');
  assert.notEqual(groupA.calibrationDeviceId, groupB.calibrationDeviceId);
  assert.equal(resolveInputDevice({ deviceId: 'default' }, []).calibrationDeviceId, null);
  assert.equal(resolveInputDevice({ deviceId: 'physical-b' }, devices).calibrationDeviceId, 'physical-b');
});

test('first calibration waits for a nonzero output clock and does not persist output delay as residual', async t => {
  let attempts;
  const h = harness(t, { onFinish: values => { attempts = values; } });
  h.ctx.getOutputTimestamp = () => h.ctx.currentTime < 0.05
    ? { contextTime: 0, performanceTime: 0 }
    : { contextTime: h.ctx.currentTime - 0.04, performanceTime: h.ctx.currentTime * 1000 };
  await h.audio.prepareInput();
  const pending = h.audio.calibrationClicks();
  assert.equal(h.ctx.sources.length, 0, 'no clicks are scheduled against a startup processing fallback');
  h.advance(0.05);
  const clicks = await pending;
  close(clicks[0], 590);
  const result = calibrateInput(clicks, clicks.map(click => click + 23));
  assert.equal(result.ok, true); assert.equal(result.compensationMs, 23);
  await h.audio.playSession(trainingSession(), { mode: 'train' });
  h.advance(0.673); h.audio.press(compensatedTime(673, result.compensationMs), 69);
  h.audio.release(compensatedTime(773, result.compensationMs));
  h.advance(2.4);
  close(attempts[0].start, 0.5); close(attempts[0].end, 0.6);
});

test('stop cancels pending calibration clock readiness without leaving sources or timers', async t => {
  const h = harness(t);
  h.ctx.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 0 });
  await h.audio.prepareInput();
  const pending = h.audio.calibrationClicks();
  const rejected = assert.rejects(pending, /interrompida/);
  h.audio.stop(); await rejected;
  h.advance(0.1);
  assert.equal(h.ctx.sources.length, 0); assert.equal(h.timeouts.size, 0);
});

test('calibration receives the last sample-frame attack after 300 ms browser input latency', async t => {
  const h = harness(t);
  await h.audio.prepareInput();
  const clicks = await h.audio.calibrationClicks();
  const latency = 0.3;
  const samples = signal(48000, 5.9, clicks.map(click => ({ time: click / 1000 + latency, decay: 0.005, length: 0.035 })));
  const detected = analyze(samples, 48000, { refractory: CALIBRATION_REFRACTORY_SECONDS }).events;
  const attacks = [];
  let result;
  for (const event of detected) setTimeout(() => {
    attacks.push(captureFrameTime(event.frame, 48000, { contextTime: h.ctx.currentTime, performanceTime: h.ctx.currentTime * 1000 }, latency));
  }, event.frame / 48 - performance.now());
  setTimeout(() => { result = calibrateInput(clicks, attacks); }, calibrationCollectionDeadline(clicks.at(-1), latency) - performance.now());
  h.advance((clicks.at(-1) + 240) / 1000);
  assert.equal(result, undefined); assert.ok(attacks.length < 8, 'the last valid attack has not yet arrived');
  h.advance((calibrationCollectionDeadline(clicks.at(-1), latency) + 1) / 1000);
  assert.equal(attacks.length, 8); assert.equal(result.ok, true);
  assert.ok(Math.abs(result.compensationMs) <= 1, 'browser input delay is not counted again as residual');
});

test('count-in leakage uses a fresh output clock after an initially zero startup timestamp', async t => {
  const h = harness(t);
  h.ctx.getOutputTimestamp = () => h.ctx.currentTime < 0.05
    ? { contextTime: 0, performanceTime: 0 }
    : { contextTime: h.ctx.currentTime - 0.04, performanceTime: h.ctx.currentTime * 1000 };
  await h.audio.playSession(trainingSession({ training: { countInBars: 1, repetitions: 1 } }), { mode: 'train' });
  const startup = h.audio.countInClicks;
  h.advance(1.2);
  const sourceTimes = h.ctx.sources.slice(0, 3).map(source => contextPerformanceTime(source.startTime, h.audio.outputClock()));
  assert.equal(sourceTimes.length, 3);
  const events = analyze(signal(48000, 1.4, sourceTimes.map(time => ({ time: time / 1000, frequency: 1500, decay: 0.004, length: 0.035 }))), 48000).events;
  assert.notEqual(startup[0], h.audio.countInClicks[0]);
  assert.equal(detectClickLeak(h.audio.countInClicks, events.map(event => event.frame / 48)).leaking, true);
});

// The mounted controller uses the same small DOM double as the studio surfaces;
// capture permission, device identities and Web Audio callbacks remain explicit.
function performanceUI(t, audio, session = trainingSession()) {
  const nodes = new Map();
  class Node {
    constructor(tag) {
      this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.captured = new Set();
      this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.className = '';
      this.style = { setProperty() {} }; this.classList = { toggle() {} };
      this.open = false;
    }
    set id(value) { this._id = value; nodes.set(value, this); } get id() { return this._id; }
    get options() { return this.children; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    prepend(...children) { for (const child of children.reverse()) { child.parent = this; this.children.unshift(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    get lastChild() { return this.children.at(-1); }
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { if (!this.open) return; this.open = false; this.fire('close'); }
    addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
    fire(type, props = {}) {
      const event = { target: this, button: 0, pointerId: 1, timeStamp: performance.now(), preventDefault() {}, ...props };
      for (const callback of this.listeners[type] ?? []) callback(event);
    }
    closest() { return null; }
    reportValidity() { return true; }
    checkVisibility() { return !this.hidden && (!this.parent || this.parent.checkVisibility()); }
    setPointerCapture(id) { this.captured.add(id); } hasPointerCapture(id) { return this.captured.has(id); } releasePointerCapture(id) { this.captured.delete(id); }
  }
  const originals = new Map();
  function install(name, value) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    originals.set(name, { original, value });
  }
  for (const id of ['train-pad', 'performance-input', 'train', 'train-state', 'input-pitch', 'held-state', 'instrument-profile-tuner']) {
    const node = new Node('div'); node.id = id;
  }
  nodes.get('input-pitch').value = '69';
  const win = new Node('window');
  const doc = new Node('document');
  Object.assign(doc, { body: new Node('body'), getElementById: id => nodes.get(id), createElement: tag => new Node(tag), querySelector: () => null });
  install('document', doc); install('window', win); install('Element', Node);
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  install('localStorage', storage);
  let surface; let stops = 0;
  const notices = [];
  const host = {
    audio, getSession: () => session, isBusy: () => ['train', 'countin'].includes(audio.position.mode), isPreparingTraining: () => false,
    stop() { stops++; audio.stop(); surface?.reset(); },
    notify: message => notices.push(message),
    changed() { nodes.get('train').disabled = false; surface?.render(); },
  };
  t.after(() => {
    try { win.fire('pagehide'); surface?.reset(); }
    finally {
      for (const [name, { original, value }] of [...originals].reverse()) {
        if (Object.getOwnPropertyDescriptor(globalThis, name)?.value !== value) continue;
        if (original) Object.defineProperty(globalThis, name, original); else delete globalThis[name];
      }
    }
  });
  return {
    nodes, win, doc, storage, notices, install, host,
    mount() { surface = mountPerformanceInput(host); return surface; },
    get surface() { return surface; }, get stops() { return stops; },
    choose(id, value) { const node = nodes.get(id); node.value = value; node.fire('change'); },
  };
}

function captureDevices(ui, outputContext, initialDevices) {
  const requests = []; const streams = []; const worklets = []; const contexts = [];
  let devices = initialDevices; let enumeration = null; let denial = null; let enumerations = 0; let permissionRequest = null; let latency = 0;
  const media = {
    async getUserMedia(constraints) {
      requests.push(constraints);
      if (permissionRequest) await permissionRequest.promise;
      const id = constraints.audio.deviceId?.exact;
      const selected = id ? devices.find(device => device.deviceId === id) : devices[0];
      if (denial || !selected) throw Object.assign(new Error('capture rejected'), { name: denial ?? 'OverconstrainedError' });
      const track = { label: selected.label, stops: 0, getSettings: () => ({ deviceId: selected.deviceId, latency }), stop() { this.stops++; } };
      const stream = { track, getTracks: () => [track], getAudioTracks: () => [track] };
      streams.push(stream); return stream;
    },
    async enumerateDevices() { enumerations++; return enumeration ? enumeration.promise : devices; },
    listeners: new Map(),
    addEventListener(type, callback) { this.listeners.set(type, callback); },
    removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); },
  };
  ui.install('navigator', { mediaDevices: media });
  ui.install('AudioContext', class {
    constructor(options) {
      if (!options) return outputContext;
      const ctx = audioContext();
      ctx.audioWorklet = { async addModule() {} };
      ctx.createMediaStreamSource = () => ctx.createGain();
      ctx.close = async () => { ctx.state = 'closed'; };
      contexts.push(ctx); return ctx;
    }
  });
  ui.install('AudioWorkletNode', class {
    constructor(context, name, options) {
      this.settings = { ...options.processorOptions };
      this.port = { onmessage: null, postMessage: message => Object.assign(this.settings, message.settings), close() { this.closed = true; } };
      worklets.push(this);
    }
    connect(node) { return node; }
    disconnect() { this.disconnected = true; }
  });
  return {
    media, requests, streams, worklets, contexts,
    get enumerations() { return enumerations; },
    set devices(value) { devices = value; }, set enumeration(value) { enumeration = value; }, set denial(value) { denial = value; }, set permissionRequest(value) { permissionRequest = value; },
    set latency(value) { latency = value; },
    attack(time) {
      const ctx = contexts.at(-1); ctx.currentTime = performance.now() / 1000;
      worklets.at(-1).port.onmessage({ data: { level: 0.5, channels: 2, events: [{ frame: time / 1000 * ctx.sampleRate, level: 0.5 }] } });
    },
    pcm(samples, startFrame = 0, channel = worklets.at(-1).settings.channel) {
      const ctx = contexts.at(-1); ctx.currentTime = performance.now() / 1000;
      const size = Math.ceil(ctx.sampleRate * 0.02);
      for (let i = 0; i < samples.length; i += size) worklets.at(-1).port.onmessage({ data: { type: 'samples', samples: samples.subarray(i, i + size), startFrame: startFrame + i, channel } });
    },
  };
}
async function settleInput() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
const inputDevice = id => ({ kind: 'audioinput', deviceId: id, groupId: id, label: `Interface ${id}` });

test('missing exact input exposes replacement in Keyboard without capture retries or foreign calibration', async t => {
  const h = harness(t); const ui = performanceUI(t, h.audio);
  const capture = captureDevices(ui, h.ctx, [inputDevice('b')]);
  ui.storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({ deviceId: 'missing', channel: 'sum', sensitivity: 1 }));
  saveCalibration('missing', 99, ui.storage); saveCalibration('b', -100, ui.storage); saveCalibration('keyboard', 12, ui.storage);
  ui.mount();
  assert.equal(capture.requests.length, 0); assert.equal(capture.enumerations, 0, 'startup neither requests permission nor enumerates');
  ui.choose('performance-entry', 'instrument'); await settleInput();
  assert.equal(capture.requests.length, 1); assert.equal(capture.requests[0].audio.deviceId.exact, 'missing');
  assert.equal(ui.surface.instrument, false); assert.equal(ui.nodes.get('performance-entry').value, 'keyboard');
  const chooser = ui.nodes.get('instrument-device');
  assert.equal(chooser.checkVisibility(), true); assert.equal(chooser.disabled, false); assert.equal(chooser.value, '');
  assert.deepEqual(chooser.options.map(option => option.value), ['', 'b']);
  assert.equal(readInputPreferences(ui.storage).deviceId, 'missing', 'do not silently choose the default or replacement');
  assert.equal(Number(ui.nodes.get('input-compensation').value), 12, 'Keyboard uses only its own calibration');
  assert.match(ui.nodes.get('instrument-status').textContent, /Voltamos ao Teclado/);
  ui.choose('instrument-device', 'b'); await settleInput();
  assert.equal(capture.requests.length, 1, 'replacement selection alone never requests capture');
  assert.equal(ui.surface.instrument, false); assert.equal(readInputPreferences(ui.storage).deviceId, 'b');
  ui.choose('performance-entry', 'instrument'); await settleInput();
  assert.equal(capture.requests.length, 2); assert.equal(capture.requests[1].audio.deviceId.exact, 'b');
  assert.equal(ui.surface.instrument, true); assert.equal(ui.surface.preparing, false);
  assert.equal(Number(ui.nodes.get('input-compensation').value), -100, 'only the opened physical device supplies compensation');
});

for (const failure of ['devicechange', 'ended', 'mute']) test(`${failure} stops tracks and transport and offers the surviving device without opening it`, async t => {
  const h = harness(t); const ui = performanceUI(t, h.audio);
  const capture = captureDevices(ui, h.ctx, [inputDevice('a'), inputDevice('b')]);
  ui.storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({ deviceId: 'a' }));
  ui.mount();
  ui.choose('performance-entry', 'instrument'); await settleInput();
  await h.audio.playSession(instrumentSession(trainingSession()), { mode: 'train' });
  h.advance(0.1); capture.attack(100); assert.equal(h.audio.position.held, true);
  capture.devices = [inputDevice('b')];
  if (failure === 'devicechange') await capture.media.listeners.get('devicechange')();
  else capture.streams[0].track[`on${failure}`]();
  await settleInput();
  assert.equal(h.audio.position.mode, 'idle'); assert.equal(h.audio.position.held, false);
  assert.equal(capture.streams[0].track.stops, 1); assert.equal(capture.contexts[0].state, 'closed');
  assert.equal(capture.worklets[0].disconnected, true); assert.equal(capture.worklets[0].port.closed, true);
  assert.equal(capture.media.listeners.has('devicechange'), false);
  assert.equal(ui.surface.instrument, false); assert.equal(capture.requests.length, 1);
  assert.equal(ui.nodes.get('instrument-device').checkVisibility(), true); assert.equal(ui.nodes.get('instrument-device').disabled, false);
  assert.deepEqual(ui.nodes.get('instrument-device').options.map(option => option.value), ['', 'b']);
  ui.choose('instrument-device', 'b'); assert.equal(capture.requests.length, 1);
  ui.choose('performance-entry', 'instrument'); await settleInput();
  assert.equal(capture.requests[1].audio.deviceId.exact, 'b'); assert.equal(ui.surface.instrument, true);
});

for (const cancel of ['keyboard', 'pagehide']) test(`late unavailable-device enumeration cannot overwrite ${cancel} cancellation`, async t => {
  const h = harness(t); const ui = performanceUI(t, h.audio);
  const capture = captureDevices(ui, h.ctx, [inputDevice('b')]); const pending = deferred();
  capture.enumeration = pending;
  ui.storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({ deviceId: 'missing' }));
  ui.mount();
  ui.choose('performance-entry', 'instrument'); await settleInput();
  assert.equal(ui.nodes.get('instrument-device').disabled, true);
  if (cancel === 'keyboard') ui.choose('performance-entry', 'keyboard');
  else ui.win.fire('pagehide');
  const status = ui.nodes.get('instrument-status').textContent;
  pending.resolve([inputDevice('late')]); await settleInput();
  assert.equal(ui.nodes.get('instrument-status').textContent, status);
  assert.equal(ui.nodes.get('instrument-device').checkVisibility(), false);
  assert.ok(!ui.nodes.get('instrument-device').options.some(option => option.value === 'late'));
  assert.equal(ui.surface.preparing, false); assert.equal(capture.requests.length, 1);
});

test('permission denial stays an explicit Keyboard fallback without enumeration or retry', async t => {
  const h = harness(t); const ui = performanceUI(t, h.audio);
  const capture = captureDevices(ui, h.ctx, [inputDevice('a')]); capture.denial = 'NotAllowedError';
  ui.mount(); ui.choose('performance-entry', 'instrument'); await settleInput();
  assert.equal(capture.requests.length, 1); assert.equal(capture.enumerations, 0);
  assert.equal(ui.surface.instrument, false); assert.equal(ui.surface.preparing, false);
  assert.equal(ui.nodes.get('instrument-device').checkVisibility(), false);
  assert.match(ui.nodes.get('instrument-status').textContent, /Permissão de microfone negada.*Voltamos ao Teclado/);
  assert.equal(capture.streams.length, 0); assert.equal(h.audio.position.mode, 'idle');
});

for (const instrument of [false, true]) for (const compensationMs of [-100, 0, 100]) {
  test(`mounted ${instrument ? 'Instrument' : 'Keyboard'} routes ${compensationMs} ms compensation by the evaluated window`, async t => {
    let attempts;
    const h = harness(t, { onFinish: values => { attempts = values; } });
    h.ctx.getOutputTimestamp = () => ({ contextTime: h.ctx.currentTime - 0.04, performanceTime: h.ctx.currentTime * 1000 });
    const session = trainingSession({ training: { countInBars: 1, repetitions: 1, monitor: true }, notes: [{ id: 'first', start: 0, duration: 1, pitch: 69 }] });
    const ui = performanceUI(t, h.audio, session);
    const capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
    saveCalibration(instrument ? 'a' : 'keyboard', compensationMs, ui.storage);
    ui.storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({ deviceId: 'a' }));
    ui.mount();
    if (instrument) { ui.choose('performance-entry', 'instrument'); await settleInput(); }
    await h.audio.playSession(ui.surface.session(session), { mode: 'train', ...ui.surface.playOptions('train') });
    ui.surface.started(session);
    // Use the output-correlated downbeat, not the processing clock's boundary.
    const first = h.audio.countInClicks[0] + 2000;
    const end = first + 2000;
    function attack(corrected) {
      const raw = corrected + compensationMs;
      h.advance(raw / 1000);
      if (instrument) capture.attack(raw);
      else ui.win.fire('keydown', { target: ui.nodes.get('train-pad'), key: ' ', code: 'Space', timeStamp: raw, repeat: false });
    }
    function release(corrected) {
      if (!instrument) ui.win.fire('keyup', { code: 'Space', timeStamp: corrected + compensationMs });
    }
    attack(first - 1); assert.equal(h.audio.position.held, false, 'genuinely pre-count-in attack is not held/evaluated'); release(first - 0.5);
    attack(first);
    assert.equal(h.audio.position.mode, compensationMs < 0 ? 'countin' : 'train');
    assert.equal(h.audio.position.held, true, 'the downbeat is accepted even while the audible clock is count-in');
    release(first + 100);
    h.advance(2.4); assert.equal(h.audio.position.held, false, 'release or written gate cannot leave input held');
    attack(end - 1); assert.equal(h.audio.position.held, true, 'last millisecond inside the evaluated interval remains valid'); release(end);
    attack(end);
    assert.equal(h.audio.position.held, false, 'the exclusive end is not a new attempt'); release(end + 1);
    h.advance(4.5);
    assert.equal(attempts.length, 2); close(attempts[0].start, 0); close(attempts[1].start, 1.999);
    close(attempts[1].end, 2); assert.equal(h.audio.position.held, false);
    // A rejected outside-session event must not leave an OS key or gate stuck.
    await h.audio.playSession(ui.surface.session(session), { mode: 'train', ...ui.surface.playOptions('train') }); ui.surface.started(session);
    const nextDownbeat = h.audio.countInClicks[0] + 2000;
    const nextRaw = nextDownbeat + compensationMs;
    h.advance(nextRaw / 1000);
    if (instrument) capture.attack(nextRaw);
    else ui.win.fire('keydown', { target: ui.nodes.get('train-pad'), key: ' ', code: 'Space', timeStamp: nextRaw, repeat: false });
    assert.equal(h.audio.position.held, true);
    if (!instrument) ui.win.fire('keyup', { code: 'Space', timeStamp: nextRaw + 100 });
    ui.host.stop(); assert.equal(h.audio.position.held, false);
  });
}

test('mounted Instrument retains uncompensated calibration attacks and count-in leakage diagnosis', async t => {
  const h = harness(t); const ui = performanceUI(t, h.audio);
  const capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  ui.storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({ deviceId: 'a' }));
  saveCalibration('a', -100, ui.storage);
  ui.mount();
  ui.choose('performance-entry', 'instrument'); await settleInput();
  ui.nodes.get('input-calibrate').fire('click'); await settleInput();
  assert.equal(ui.surface.calibrating, true);
  const clicks = h.ctx.sources.slice(-8).map(source => source.startTime * 1000);
  for (const click of clicks) { h.advance((click + 23) / 1000); capture.attack(click + 23); }
  h.advance((calibrationCollectionDeadline(clicks.at(-1)) + 1) / 1000);
  assert.equal(ui.surface.calibrating, false); assert.equal(readCalibration('a', ui.storage), 23, 'previous compensation is not applied while collecting calibration');
  const session = trainingSession({ training: { countInBars: 1, repetitions: 1 } });
  await h.audio.playSession(ui.surface.session(session), { mode: 'train', ...ui.surface.playOptions('train') }); ui.surface.started(session);
  for (const click of h.audio.countInClicks.slice(0, 3)) { h.advance(click / 1000); capture.attack(click); assert.equal(h.audio.position.held, false); }
  assert.match(ui.nodes.get('instrument-status').textContent, /Possível vazamento/);
  assert.ok(ui.notices.some(message => /Possível vazamento/.test(message)));
});

function microphonePermission(state = 'granted', pending = null) {
  const listeners = new Map();
  const permission = {
    state, addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  let queries = 0;
  navigator.permissions = { async query(options) {
    assert.deepEqual(options, { name: 'microphone' }); queries++;
    return pending ? pending.promise : permission;
  } };
  return { permission, listeners, get queries() { return queries; }, revoke() { permission.state = 'denied'; listeners.get('change')?.(); } };
}

test('remembered instrument restores only on granted Practice entry; repeated activation preserves the live stream', async t => {
  const h = harness(t); const ui = performanceUI(t, h.audio);
  const capture = captureDevices(ui, h.ctx, [inputDevice('a')]); const permissions = microphonePermission();
  ui.storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({ lastMode: 'instrument', deviceId: 'a' }));
  ui.mount();
  assert.equal(permissions.queries, 0); assert.equal(capture.requests.length, 0); assert.equal(capture.enumerations, 0);
  await ui.surface.activate('tab-studio'); assert.equal(permissions.queries, 0);
  const opening = ui.surface.activate('tab-practice'); const ready = ui.surface.prepareTraining();
  await opening; assert.equal(await ready, true);
  assert.equal(ui.surface.instrument, true); assert.equal(capture.requests.length, 1);
  const source = trainingSession({ extensions: { studio: { instrument: { type: 'bass', strings: 4, tuning: [28, 33, 38, 43], noteNames: 'letters' }, other: { keep: true } }, other: { keep: true } } });
  const executed = ui.surface.session(source);
  assert.deepEqual(executed.extensions.studio, source.extensions.studio); assert.deepEqual(executed.extensions.other, source.extensions.other);
  await h.audio.playSession(executed, { mode: 'train' }); const stops = ui.stops;
  await ui.surface.activate('tab-practice'); ui.nodes.get('instrument-activate').fire('click'); await settleInput();
  assert.equal(capture.requests.length, 1); assert.equal(ui.stops, stops); assert.equal(h.audio.position.mode, 'train');
  assert.equal(capture.streams[0].track.stops, 0);
  await ui.surface.activate('tab-studio');
  assert.equal(capture.streams[0].track.stops, 1); assert.equal(ui.surface.instrument, false);
  assert.equal(readInputPreferences(ui.storage).lastMode, 'instrument');
});

for (const state of ['prompt', 'denied', 'unsupported', 'rejected']) test(`remembered ${state} permission requires explicit activation without automatic capture/enumeration`, async t => {
  const h = harness(t); const ui = performanceUI(t, h.audio);
  const capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  if (state !== 'unsupported') microphonePermission(state);
  if (state === 'rejected') navigator.permissions.query = async () => { throw new TypeError('unsupported permission'); };
  ui.storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({ lastMode: 'instrument' }));
  ui.mount(); await ui.surface.activate('tab-practice');
  assert.equal(capture.requests.length, 0); assert.equal(capture.enumerations, 0);
  assert.equal(ui.nodes.get('instrument-activate').checkVisibility(), true); assert.equal(ui.surface.instrument, false);
  ui.nodes.get('instrument-activate').fire('click'); await settleInput();
  assert.equal(capture.requests.length, 1); assert.equal(ui.surface.instrument, true);
  assert.equal(readInputPreferences(ui.storage).lastMode, 'instrument');
});

test('default/last Keyboard preference never queries permission on Practice entry', async t => {
  const h = harness(t); const ui = performanceUI(t, h.audio);
  const capture = captureDevices(ui, h.ctx, [inputDevice('a')]); const permissions = microphonePermission();
  ui.mount(); await ui.surface.activate('tab-practice');
  assert.equal(permissions.queries, 0); assert.equal(capture.requests.length, 0); assert.equal(capture.enumerations, 0);
  ui.nodes.get('instrument-activate').fire('click'); await settleInput(); ui.choose('performance-entry', 'keyboard');
  assert.equal(readInputPreferences(ui.storage).lastMode, 'keyboard');
  await ui.surface.activate('tab-studio'); await ui.surface.activate('tab-practice');
  assert.equal(permissions.queries, 0); assert.equal(capture.requests.length, 1);
});

function cancelInput(ui, cancellation) {
  if (cancellation === 'leave') ui.surface.activate('tab-studio');
  else if (cancellation === 'blur') ui.win.fire('blur');
  else if (cancellation === 'hidden') { ui.doc.hidden = true; ui.doc.fire('visibilitychange'); }
  else ui.choose('performance-entry', 'keyboard');
}
for (const cancellation of ['leave', 'blur', 'hidden', 'keyboard']) {
  test(`late permission query cannot open capture after ${cancellation}`, async t => {
    const h = harness(t); const ui = performanceUI(t, h.audio);
    const capture = captureDevices(ui, h.ctx, [inputDevice('a')]); const pending = deferred();
    const permissions = microphonePermission('granted', pending);
    ui.storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({ lastMode: 'instrument' }));
    ui.mount(); const opening = ui.surface.activate('tab-practice'); cancelInput(ui, cancellation);
    pending.resolve(permissions.permission); await opening; await settleInput();
    assert.equal(capture.requests.length, 0); assert.equal(capture.enumerations, 0); assert.equal(ui.surface.instrument, false);
    assert.equal(readInputPreferences(ui.storage).lastMode, cancellation === 'keyboard' ? 'keyboard' : 'instrument');
  });
  test(`late granted start is stopped after ${cancellation} without reopening`, async t => {
    const h = harness(t); const ui = performanceUI(t, h.audio);
    const capture = captureDevices(ui, h.ctx, [inputDevice('a')]); const pending = deferred();
    capture.permissionRequest = pending; microphonePermission();
    ui.storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({ lastMode: 'instrument' }));
    ui.mount(); const opening = ui.surface.activate('tab-practice'); await settleInput();
    assert.equal(capture.requests.length, 1); cancelInput(ui, cancellation);
    pending.resolve(); await opening; await settleInput();
    assert.equal(capture.streams[0].track.stops, 1); assert.equal(capture.worklets.length, 0);
    assert.equal(capture.requests.length, 1); assert.equal(ui.surface.instrument, false); assert.equal(ui.surface.preparing, false);
  });
}

test('revoked permission closes capture without replacing remembered intent', async t => {
  const h = harness(t); const ui = performanceUI(t, h.audio);
  const capture = captureDevices(ui, h.ctx, [inputDevice('a')]); const permissions = microphonePermission();
  ui.storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({ lastMode: 'instrument' }));
  ui.mount(); await ui.surface.activate('tab-practice'); permissions.revoke();
  assert.equal(capture.streams[0].track.stops, 1); assert.equal(ui.surface.instrument, false);
  assert.equal(permissions.listeners.size, 0); assert.equal(readInputPreferences(ui.storage).lastMode, 'instrument');
  assert.equal(ui.nodes.get('instrument-activate').checkVisibility(), true);
});

test('configured input is compact; settings, test and privacy remain behind Configurar', async t => {
  const h = harness(t); const ui = performanceUI(t, h.audio);
  const capture = captureDevices(ui, h.ctx, [inputDevice('a')]); saveCalibration('a', -23, ui.storage);
  ui.mount(); ui.nodes.get('instrument-activate').fire('click'); await settleInput();
  assert.equal(ui.nodes.get('input-configuration').hidden, true);
  for (const id of ['instrument-device', 'instrument-test', 'instrument-privacy']) assert.equal(ui.nodes.get(id).checkVisibility(), false);
  assert.equal(ui.nodes.get('instrument-level').checkVisibility(), true);
  assert.match(ui.nodes.get('instrument-summary').textContent, /Instrumento.*Interface a.*Soma.*-23 ms/);
  ui.nodes.get('input-configure').fire('click');
  assert.equal(ui.nodes.get('input-configuration').hidden, false);
  assert.equal(ui.nodes.get('input-configure').attributes['aria-expanded'], 'true');
  assert.equal(ui.nodes.get('instrument-device').checkVisibility(), true);
  ui.choose('instrument-channel', '2');
  assert.match(ui.nodes.get('instrument-summary').textContent, /Canal 2/);
  assert.equal(readInputPreferences(ui.storage).channel, '2');
  ui.nodes.get('input-configure').fire('click');
  assert.equal(ui.nodes.get('input-configuration').hidden, true); assert.equal(capture.requests.length, 1);
});

test('remembered unavailable device opens compact recovery without replacing intent/calibration', async t => {
  const h = harness(t); const ui = performanceUI(t, h.audio);
  const capture = captureDevices(ui, h.ctx, [inputDevice('b')]); microphonePermission();
  ui.storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({ lastMode: 'instrument', deviceId: 'missing' }));
  saveCalibration('missing', 99, ui.storage); saveCalibration('b', -12, ui.storage);
  ui.mount(); await ui.surface.activate('tab-practice'); await settleInput();
  assert.equal(ui.nodes.get('input-configuration').hidden, false); assert.equal(ui.nodes.get('instrument-device').checkVisibility(), true);
  assert.equal(readInputPreferences(ui.storage).lastMode, 'instrument'); assert.equal(readInputPreferences(ui.storage).deviceId, 'missing');
  ui.choose('instrument-device', 'b'); assert.equal(capture.requests.length, 1);
  ui.nodes.get('instrument-activate').fire('click'); await settleInput();
  assert.equal(capture.requests.length, 2); assert.equal(Number(ui.nodes.get('input-compensation').value), -12);
});

test('Practice audible controls operate the real metronome bus without restarting training or changing saved mix', async t => {
  const h = harness(t);
  const session = trainingSession({ metronome: { enabled: true }, companion: { enabled: true, pulses: 3, spanBeats: 4, pitch: 84 } });
  const saved = serializeSession(session); const ui = performanceUI(t, h.audio, session);
  const playback = createStudioPlayback({ getSession: () => session, audio: h.audio, render() {}, notify() {} });
  const tracks = mountPracticeTracks(ui.nodes.get('performance-input'), { getSession: () => session, getMixer: playback.getMixer, toggleAudible: playback.toggleAudible });
  await h.audio.playSession(session, { mode: 'train', mixer: playback.getMixer() });
  const bus = h.ctx.sources[0].connections[0].connections[0]; const clock = [...h.intervals][0];
  const button = ui.nodes.get('practice-audible-metronome');
  assert.equal(button.textContent, 'Metrônomo / polirritmia');
  assert.equal(button.attributes['aria-pressed'], 'true');
  button.fire('click'); assert.equal(bus.gain.events.at(-1).value, 0);
  assert.equal(button.attributes['aria-pressed'], 'false');
  button.fire('click'); assert.equal(bus.gain.events.at(-1).value, 1);
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(h.audio.position.mode, 'train'); assert.equal([...h.intervals][0], clock);
  assert.equal(serializeSession(session), saved);
  assert.equal(ui.nodes.get('practice-audible-phrase'), undefined, 'no change to phrase suppression');
  assert.equal(ui.nodes.get('practice-audible-drums').disabled, true);
  tracks.render();
});

test('actual Practice backing voices respect legacy roles; transient audible toggles compose with saved mute/zero and solos', () => {
  const session = createSession({ drums: { enabled: true }, band: { bassEnabled: true, role: 'bass' }, companion: { enabled: false }, metronome: { enabled: false }, mixer: { drums: { muted: true, volume: 0 }, bass: { muted: false }, chords: { muted: false } } });
  const voices = practiceVoices(session);
  assert.equal(voices.find(voice => voice.channel === 'bass').available, false);
  assert.equal(voices.find(voice => voice.channel === 'drums').available, true);
  assert.equal(voices.find(voice => voice.channel === 'metronome').available, false);
  assert.ok(!voices.some(voice => voice.channel === 'phrase'));
  const saved = serializeSession(session); const calls = [];
  const playback = createStudioPlayback({ getSession: () => session, audio: { setMixer: value => calls.push(value) }, render() {}, notify() {} });
  playback.toggleSolo('bass');
  playback.toggleAudible('drums');
  assert.equal(playback.getMixer().drums.muted, false); assert.equal(playback.getMixer().drums.volume, 1);
  assert.equal(playback.isSolo('drums'), true, 'enabling an excluded voice includes it in the current solo overlay');
  playback.toggleAudible('drums'); assert.equal(playback.getMixer().drums.muted, true);
  playback.toggleSolo('bass'); playback.toggleSolo('drums');
  assert.equal(playback.getMixer().drums.muted, true);
  assert.equal(serializeSession(session), saved); assert.ok(calls.length > 0);
});

test('leaving Practice releases the training preparation barrier before a stale permission query completes', async t => {
  const h = harness(t); const ui = performanceUI(t, h.audio);
  const capture = captureDevices(ui, h.ctx, [inputDevice('a')]); const pending = deferred();
  const permissions = microphonePermission('granted', pending);
  ui.storage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({ lastMode: 'instrument' }));
  ui.mount(); ui.surface.activate('tab-practice');
  const ready = ui.surface.prepareTraining(); await ui.surface.activate('tab-studio');
  assert.equal(await ready, false);
  pending.resolve(permissions.permission); await settleInput();
  assert.equal(capture.requests.length, 0);
});

test('repeated explicit activation while opening neither cancels preparation nor stops/reopens capture', async t => {
  const h = harness(t); const ui = performanceUI(t, h.audio);
  const capture = captureDevices(ui, h.ctx, [inputDevice('a')]); const pending = deferred();
  capture.permissionRequest = pending; ui.mount(); await ui.surface.activate('tab-practice');
  ui.nodes.get('instrument-activate').fire('click'); await settleInput(); const stops = ui.stops;
  let ready = false; const preparation = ui.surface.prepareTraining().then(value => { ready = value; });
  ui.nodes.get('instrument-activate').fire('click'); ui.surface.activate('tab-practice'); await settleInput();
  assert.equal(capture.requests.length, 1); assert.equal(ui.stops, stops); assert.equal(ready, false);
  pending.resolve(); await preparation;
  assert.equal(ready, true); assert.equal(capture.streams[0].track.stops, 0); assert.equal(capture.requests.length, 1);
});

test('Studio profile tuner detects real bass B0/custom strings without changing practice intent or canonical session', async t => {
  const h = harness(t);
  const session = trainingSession({ extensions: { studio: { instrument: { type: 'bass', strings: 5, tuning: [23, 29, 34, 39, 44], noteNames: 'solfege' } } } });
  const ui = performanceUI(t, h.audio, session), capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  const original = serializeSession(session);
  ui.mount();
  assert.equal(capture.requests.length, 0);
  const button = ui.nodes.get('instrument-profile-tuner'); button.focus(); button.fire('click');
  await settleInput();
  assert.equal(capture.requests.length, 1); assert.equal(ui.surface.instrument, false);
  assert.equal(ui.storage.getItem(INPUT_PREFERENCES_KEY), null, 'tuner-only intent is not remembered as Practice Instrument');
  assert.equal(ui.stops, 0, 'opening from Studio never stops unrelated transport');
  const rate = capture.contexts[0].sampleRate;
  capture.pcm(signal(rate, 0.3, [{ time: 0, frequency: MIN_PITCH_FREQUENCY, length: 0.3, sustained: true }]));
  assert.equal(ui.nodes.get('tuner-note').textContent, 'Si0');
  assert.match(ui.nodes.get('tuner-cents').textContent, /0 cents.*corda 5/);
  assert.equal(ui.nodes.get('tuner-needle').hidden, false);
  const current = ui.nodes.get('tuner-strings').children.find(node => node.getAttribute('aria-current') === 'true');
  assert.equal(Number(current.getAttribute('data-string')), 5);
  const reference = ui.nodes.get('tuner-reference'); reference.value = '442'; reference.fire('input');
  assert.match(ui.nodes.get('tuner-cents').textContent, /−?-[78] cents/);
  assert.match(ui.nodes.get('tuner-frequency').textContent, /alvo 31\.01 Hz/);
  assert.equal(serializeSession(session), original);
  ui.nodes.get('tuner-close').fire('click');
  assert.equal(ui.nodes.get('instrument-tuner').open, false);
  assert.equal(capture.streams[0].track.stops, 1); assert.equal(capture.contexts[0].state, 'closed');
  assert.equal(ui.doc.activeElement, button, 'native close restores its trigger focus');
});

test('Practice tuner borrows exactly the existing capture and closing retains Testar entrada and calibration identity', async t => {
  const h = harness(t), ui = performanceUI(t, h.audio), capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  saveCalibration('a', -71, ui.storage); ui.mount();
  ui.choose('performance-entry', 'instrument'); await settleInput();
  const worklet = capture.worklets[0];
  ui.nodes.get('instrument-tuner-open').fire('click'); await settleInput();
  assert.equal(capture.requests.length, 1); assert.equal(capture.worklets[0], worklet);
  capture.pcm(signal(capture.contexts[0].sampleRate, 0.3, [{ time: 0, frequency: 82.4069, length: 0.3, sustained: true }]));
  assert.equal(ui.nodes.get('tuner-note').textContent, 'E2');
  assert.match(ui.nodes.get('tuner-cents').textContent, /corda 6/);
  ui.nodes.get('instrument-tuner').close();
  assert.equal(capture.streams[0].track.stops, 0); assert.equal(ui.surface.instrument, true);
  assert.equal(Number(ui.nodes.get('input-compensation').value), -71);
  assert.equal(ui.nodes.get('instrument-test').disabled, false);
  ui.nodes.get('instrument-test').fire('click'); capture.attack(100);
  assert.equal(ui.nodes.get('instrument-diagnostic').children.length, 1);
  assert.equal(capture.requests.length, 1);
});

test('closing a tuner-only lease before permission resolves stops late tracks without opening an analyzer', async t => {
  const h = harness(t), ui = performanceUI(t, h.audio), capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  const permission = deferred(); capture.permissionRequest = permission;
  ui.mount(); ui.nodes.get('instrument-profile-tuner').fire('click');
  assert.equal(capture.requests.length, 1);
  ui.nodes.get('instrument-tuner-open').fire('click');
  assert.equal(capture.requests.length, 1, 'both triggers refer to the same open modal and permission operation');
  ui.nodes.get('instrument-tuner').close(); permission.resolve(); await settleInput();
  assert.equal(capture.streams.length, 1); assert.equal(capture.streams[0].track.stops, 1);
  assert.equal(capture.worklets.length, 0); assert.equal(capture.contexts.length, 0);
  assert.equal(ui.surface.instrument, false); assert.equal(ui.surface.preparing, false);
});

test('closing while borrowing Practice permission preparation does not cancel the Practice capture', async t => {
  const h = harness(t), ui = performanceUI(t, h.audio), capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  const permission = deferred(); capture.permissionRequest = permission;
  ui.mount(); ui.choose('performance-entry', 'instrument');
  ui.nodes.get('instrument-tuner-open').fire('click');
  assert.equal(capture.requests.length, 1);
  ui.nodes.get('instrument-tuner').close(); permission.resolve(); await settleInput();
  assert.equal(capture.requests.length, 1); assert.equal(capture.streams[0].track.stops, 0);
  assert.equal(ui.surface.instrument, true); assert.equal(ui.surface.preparing, false);
});

for (const loss of ['blur', 'mute', 'ended', 'devicechange']) test(`tuner ${loss} clears certainty and requires an explicit reactivation`, async t => {
  const h = harness(t), ui = performanceUI(t, h.audio), capture = captureDevices(ui, h.ctx, [inputDevice('a'), inputDevice('b')]);
  ui.mount(); ui.nodes.get('instrument-tuner-open').fire('click'); await settleInput();
  capture.pcm(signal(capture.contexts[0].sampleRate, 0.3, [{ time: 0, frequency: 110, length: 0.3, sustained: true }]));
  assert.notEqual(ui.nodes.get('tuner-note').textContent, '—');
  if (loss === 'blur') ui.win.fire('blur');
  else if (loss === 'devicechange') { capture.devices = [inputDevice('b')]; await capture.media.listeners.get('devicechange')(); }
  else capture.streams[0].track[`on${loss}`]();
  await settleInput();
  assert.equal(capture.streams[0].track.stops, 1);
  assert.equal(ui.nodes.get('tuner-note').textContent, '—');
  assert.equal(ui.nodes.get('tuner-needle').hidden, true);
  assert.equal(ui.nodes.get('tuner-activate').hidden, false);
  assert.equal(capture.requests.length, 1);
  ui.nodes.get('instrument-tuner').close();
});

test('tuner denial has actionable recovery and no fake note; retry alone requests permission again', async t => {
  const h = harness(t), ui = performanceUI(t, h.audio), capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  capture.denial = 'NotAllowedError'; ui.mount();
  ui.nodes.get('instrument-profile-tuner').fire('click'); await settleInput();
  assert.match(ui.nodes.get('tuner-status').textContent, /Permissão.*negada.*Configurar/);
  assert.equal(ui.nodes.get('tuner-note').textContent, '—');
  assert.equal(ui.nodes.get('tuner-needle').hidden, true);
  assert.equal(ui.nodes.get('tuner-activate').hidden, false);
  assert.equal(capture.requests.length, 1); assert.equal(capture.enumerations, 0);
  capture.denial = null; ui.nodes.get('tuner-activate').fire('click'); await settleInput();
  assert.equal(capture.requests.length, 2); assert.equal(capture.streams[0].track.stops, 0);
  ui.nodes.get('instrument-tuner').close(); assert.equal(capture.streams[0].track.stops, 1);
});

test('ephemeral captured PCM supplies stable pitch windows, stable attack IDs and uncalibrated input-latency timestamps', async t => {
  const h = harness(t), ui = performanceUI(t, h.audio), capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  capture.latency = 0.03;
  ui.mount(); const pitches = [], attacks = [];
  const unsubscribePitch = ui.surface.subscribePitch(pitch => { if (!pitch.stopped) pitches.push(pitch); });
  const unsubscribeAttack = ui.surface.subscribeAttacks(attack => attacks.push(attack));
  ui.choose('performance-entry', 'instrument'); await settleInput();
  saveCalibration('a', 100, ui.storage);
  const rate = capture.contexts[0].sampleRate;
  capture.pcm(signal(rate, 0.3, [{ time: 0, frequency: 196, length: 0.3, sustained: true }]), 1000);
  assert.ok(pitches.length > 0);
  for (const pitch of pitches) {
    assert.ok(Math.abs(1200 * Math.log2(pitch.frequency / 196)) <= 5);
    assert.equal(pitch.endFrame - pitch.startFrame, Math.ceil(rate * 0.16));
    close(pitch.time, pitch.frame / rate * 1000 - 30);
    close(pitch.startTime, pitch.startFrame / rate * 1000 - 30); close(pitch.endTime, pitch.endFrame / rate * 1000 - 30);
    assert.equal(pitch.deviceId, 'a'); assert.equal(pitch.sampleRate, rate);
  }
  capture.attack(100);
  assert.equal(attacks.length, 1); assert.equal(attacks[0].id, `${attacks[0].captureId}:${attacks[0].frame}`);
  assert.equal(attacks[0].captureId, pitches[0].captureId);
  const count = pitches.length; unsubscribePitch(); unsubscribeAttack();
  capture.pcm(signal(rate, 0.3, [{ time: 0, frequency: 440, length: 0.3, sustained: true }]), 20000);
  assert.equal(pitches.length, count);
});

test('tuner does not feed a keyboard training run; stale and silent PCM remove the needle', async t => {
  const h = harness(t), ui = performanceUI(t, h.audio), capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  ui.mount(); await h.audio.playSession(trainingSession(), { mode: 'train' });
  ui.nodes.get('instrument-profile-tuner').fire('click'); await settleInput();
  capture.attack(100); assert.equal(h.audio.position.held, false);
  const rate = capture.contexts[0].sampleRate;
  capture.pcm(signal(rate, 0.3, [{ time: 0, frequency: 440, length: 0.3, sustained: true }]));
  assert.equal(ui.nodes.get('tuner-note').textContent, 'A4');
  h.advance(0.6); assert.equal(ui.nodes.get('tuner-needle').hidden, true);
  capture.pcm(new Float32Array(Math.ceil(rate * 0.3)), Math.ceil(rate * 0.3));
  assert.equal(ui.nodes.get('tuner-note').textContent, '—'); assert.equal(ui.nodes.get('tuner-needle').hidden, true);
  ui.nodes.get('instrument-tuner').close();
});

test('explicit tuner permission revocation clears the reading, releases its own stream and removes the watcher', async t => {
  const h = harness(t), ui = performanceUI(t, h.audio), capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  const permissions = microphonePermission();
  ui.mount(); assert.equal(permissions.queries, 0);
  ui.nodes.get('instrument-profile-tuner').fire('click'); await settleInput();
  assert.equal(permissions.queries, 1);
  capture.pcm(signal(capture.contexts[0].sampleRate, 0.3, [{ time: 0, frequency: 110, length: 0.3, sustained: true }]));
  permissions.revoke();
  assert.equal(capture.streams[0].track.stops, 1); assert.equal(permissions.listeners.size, 0);
  assert.equal(ui.nodes.get('tuner-note').textContent, '—'); assert.equal(ui.nodes.get('tuner-needle').hidden, true);
  assert.match(ui.nodes.get('tuner-status').textContent, /revogada/);
  assert.equal(ui.nodes.get('tuner-activate').hidden, false); assert.equal(capture.requests.length, 1);
  ui.nodes.get('instrument-tuner').close();
});

test('tuner-only failure never stops or resets a previously active keyboard training press', async t => {
  const h = harness(t), ui = performanceUI(t, h.audio), capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  ui.mount(); await h.audio.playSession(trainingSession(), { mode: 'train' });
  h.advance(0.1); h.audio.press(100, 69);
  assert.equal(h.audio.position.held, true);
  capture.denial = 'NotAllowedError'; ui.nodes.get('instrument-profile-tuner').fire('click'); await settleInput();
  assert.equal(ui.stops, 0); assert.equal(h.audio.position.mode, 'train'); assert.equal(h.audio.position.held, true);
  assert.equal(ui.surface.instrument, false); ui.nodes.get('instrument-tuner').close();
});
