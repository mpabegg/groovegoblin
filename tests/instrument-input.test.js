import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnsetState, detectOnsets, refractorySeconds, selectInputSample } from '../src/instrument-onsets.js';
import { captureFrameTime, contextPerformanceTime, compensatedTime, calibrateInput, detectClickLeak, inputTailSeconds, calibrationCollectionDeadline, CALIBRATION_REFRACTORY_SECONDS, readCalibration, saveCalibration, readInputPreferences, INPUT_PREFERENCES_KEY } from '../src/input-timing.js';
import { instrumentSession, InstrumentInputGate } from '../src/instrument-input.js';
import { resolveInputDevice } from '../src/instrument-capture.js';
import { createSession, serializeSession } from '../src/session.js';
import { evaluateSession, summarizeFeedback } from '../src/feedback.js';
import { buildTimelineData } from '../src/timeline.js';
import { harness, close } from './audio-harness.js';

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
      const envelope = (note.amplitude ?? 0.45) * (note.sustained ? 1 : Math.exp(-t / (note.decay ?? 0.05)));
      samples[start + i] += envelope * Math.sin(2 * Math.PI * (note.frequency ?? 440) * t);
    }
  }
  return samples;
}
function analyze(samples, rate, options = {}, blockSize = 128) {
  let state = createOnsetState(rate);
  const events = [];
  for (let offset = 0; offset < samples.length; offset += blockSize) {
    const previous = state;
    const snapshot = { ...state };
    const result = detectOnsets(state, samples.subarray(offset, offset + blockSize), options);
    assert.deepEqual(previous, snapshot, 'detector never mutates the supplied state');
    state = result.state; events.push(...result.events);
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
  assert.deepEqual(readInputPreferences(storage), { deviceId: 'interface-b', channel: '2', sensitivity: 1.5 });
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
