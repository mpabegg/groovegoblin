// Diagnóstico da entrada (item 7): exportação JSON, amostra explícita de 10 s
// e as associações reais ataque/altura, mais um fixture opcional de WAV real.
// O fixture vive em tests/fixtures/instrument: cada <nome>.wav tem um sidecar
// <nome>.json com { expectedOnsets: [segundos], channel?, toleranceSeconds?,
// sensitivity?, refractory?, instrumentType?, sampleRate? }. Sem arquivos, o
// teste é pulado; com arquivos, o WAV é decodificado e avaliado pelo detector
// real de ataques.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDiagnosticLog, createSampleRecorder, diagnosticReport, encodeSampleWav, SAMPLE_SECONDS, DIAGNOSTIC_ATTACK_LIMIT } from '../src/instrument-diagnostics.js';
import { decodeWav } from '../src/repertoire-formats.js';
import { createOnsetState, detectOnsets } from '../src/instrument-onsets.js';
import { mountPerformanceInput } from '../src/performance-input.js';
import { createSession } from '../src/session.js';
import { INPUT_PREFERENCES_KEY, saveCalibration } from '../src/input-timing.js';
import { harness, audioContext } from './audio-harness.js';

const FIXTURE_DIRECTORY = new URL('./fixtures/instrument/', import.meta.url);

test('diagnostic log associates the strongest real pitch inside the window and stays bounded', () => {
  const log = createDiagnosticLog({ limit: 3, associationSeconds: 0.3 });
  log.pitch({ time: 90, frequency: 55, confidence: 0.9 }); // no attack yet: ignored
  log.attack({ time: Number.NaN }); // not an observed time: ignored
  assert.equal(log.size, 0); assert.equal(log.source, null);
  log.reset('test');
  assert.equal(log.source, 'test');
  log.attack({ time: 100, level: 0.5 });
  log.pitch({ time: 140, frequency: 110, confidence: 0.6 });
  log.pitch({ time: 180, frequency: 110.2, confidence: 0.9 });
  log.pitch({ time: 1400, frequency: 55, confidence: 0.99 }); // far after the window: ignored
  log.attack({ time: 200, level: 0.4 });
  log.pitch({ time: 260, frequency: 220, confidence: 0.95 });
  log.attack({ time: 300, level: 0.3 });
  log.attack({ time: 400, level: 0.2 }); // limit 3 evicts the oldest attack
  assert.equal(log.size, 3);
  assert.deepEqual(log.entries().map(entry => [entry.time, entry.level, entry.estimatedPitch, entry.confidence]), [
    [200, 0.4, 220, 0.95],
    [300, 0.3, null, 0],
    [400, 0.2, null, 0],
  ]);
  log.attack({ time: 500, level: 0.1 });
  log.pitch({ time: 520, frequency: null, confidence: 0.4 }); // unidentified keeps its own confidence
  assert.deepEqual(log.entries().at(-1), { time: 500, level: 0.1, estimatedPitch: null, confidence: 0.4 });
  log.reset();
  assert.deepEqual(log.entries(), []); assert.equal(log.source, null);
  assert.equal(DIAGNOSTIC_ATTACK_LIMIT, 64);
});

test('diagnostic report carries the observed configuration, never audio and never an expected pitch', () => {
  const report = diagnosticReport({
    attacks: [{ time: 1234.5, level: 0.43215, estimatedPitch: 110.004, confidence: 0.91234 }, { time: 2000, level: 0.1, estimatedPitch: null, confidence: 0.42 }],
    source: 'test',
    device: { deviceId: 'a', calibrationDeviceId: 'a', label: 'Interface A' },
    channel: '2', sampleRate: 48000, sensitivity: 1.25, compensation: -71,
    profile: { type: 'bass', strings: 5, tuning: [23, 29, 34, 39, 44], noteNames: 'solfege' },
    generatedAt: '2026-10-05T00:00:00.000Z',
  });
  assert.equal(report.kind, 'groovegoblin-input-diagnostics');
  assert.equal(report.version, 1);
  assert.equal(report.generatedAt, '2026-10-05T00:00:00.000Z');
  assert.equal(report.audio, false);
  assert.equal(report.source, 'test');
  assert.deepEqual(report.device, { deviceId: 'a', calibrationDeviceId: 'a', label: 'Interface A' });
  assert.equal(report.channel, '2');
  assert.equal(report.sampleRate, 48000);
  assert.equal(report.sensitivity, 1.25);
  assert.equal(report.compensation, -71);
  assert.deepEqual(report.profile, { type: 'bass', strings: 5, tuning: [23, 29, 34, 39, 44], noteNames: 'solfege' });
  assert.deepEqual(Object.keys(report.attacks[0]), ['time', 'level', 'estimatedPitch', 'confidence']);
  assert.equal(report.attacks[0].time, 1.2345, 'capture milliseconds are exported as seconds');
  assert.equal(report.attacks[1].estimatedPitch, null);
  assert.equal(JSON.stringify(report).includes('expectedPitch'), false);
  assert.equal(JSON.stringify(report).includes('pcm'), false);
  const empty = diagnosticReport();
  assert.deepEqual(empty.attacks, []);
  assert.equal(empty.device, null); assert.equal(empty.sampleRate, null);
  assert.equal(empty.compensation, null); assert.equal(empty.profile, null); assert.equal(empty.source, null);
});

test('sample WAV is 16-bit mono PCM at the real rate with exactly the recorded frames', () => {
  const data = new Float32Array(1000);
  for (let index = 0; index < data.length; index++) data[index] = Math.sin(2 * Math.PI * 440 * index / 1000) * 0.5;
  const buffer = encodeSampleWav({ data, sampleRate: 1000 });
  const view = new DataView(buffer);
  assert.equal(view.getUint16(20, true), 1, 'PCM inteiro');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 1000, 'taxa real');
  assert.equal(view.getUint16(34, true), 16, '16 bits');
  assert.equal(view.getUint32(40, true), 2000, 'tamanho dos dados');
  const decoded = decodeWav(buffer);
  assert.equal(decoded.sampleRate, 1000);
  assert.equal(decoded.channels.length, 1);
  assert.equal(decoded.channels[0].length, 1000);
  // 16-bit truncation plus the 0x7fff/0x8000 scaling differ by at most two LSBs.
  for (const index of [0, 1, 100, 999]) assert.ok(Math.abs(decoded.channels[0][index] - data[index]) <= 2 / 0x8000);
});

function fakeCapture() {
  const listeners = new Set();
  return {
    active: true,
    subscribeSamples(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    block(samples) { for (const listener of [...listeners]) listener(samples); },
    get listeners() { return listeners.size; },
  };
}

test('sample recorder keeps PCM only after the explicit start and trims exactly ten seconds', () => {
  const capture = fakeCapture();
  const progress = [], finished = [], cancelled = [], errors = [];
  const recorder = createSampleRecorder({ capture, channel: 'sum', sampleRate: 1000,
    onProgress: value => progress.push(value), onFinish: value => finished.push(value), onCancel: () => cancelled.push(true), onError: value => errors.push(value) });
  assert.equal(recorder.targetFrames, 10000);
  capture.block(new Float32Array(3000).fill(0.5));
  assert.deepEqual([progress.length, finished.length, capture.listeners], [0, 0, 0], 'no PCM is retained before the action');
  assert.equal(recorder.start(), true);
  assert.equal(capture.listeners, 1);
  capture.block(new Float32Array(4000).fill(0.25));
  assert.equal(finished.length, 0, 'nine seconds are not enough');
  capture.block(new Float32Array(9000).fill(0.75));
  assert.equal(finished.length, 1);
  const { data, sampleRate, channel, seconds } = finished[0];
  assert.equal(data.length, 10000); assert.equal(sampleRate, 1000); assert.equal(channel, 'sum'); assert.equal(seconds, 10);
  assert.deepEqual([data[0], data[3999], data[4000], data[9999]], [0.25, 0.25, 0.75, 0.75]);
  assert.equal(progress.at(-1).seconds, 10);
  assert.equal(capture.listeners, 0, 'finishing releases the subscription');
  assert.equal(recorder.frames, 0, 'finishing releases the buffers');
  capture.block(new Float32Array(1000).fill(1));
  assert.equal(finished.length, 1, 'nothing is recorded after the explicit action ends');
  assert.deepEqual([cancelled, errors], [[], []]);
});

test('sample recorder cancel and empty capture discard the buffers without any completion', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const capture = fakeCapture();
  const finished = [], cancelled = [], errors = [];
  const recorder = createSampleRecorder({ capture, channel: '1', sampleRate: 1000,
    onFinish: value => finished.push(value), onCancel: () => cancelled.push(true), onError: value => errors.push(value) });
  assert.equal(recorder.start(), true);
  capture.block(new Float32Array(3000));
  assert.equal(recorder.cancel(), true);
  assert.equal(cancelled.length, 1);
  assert.equal(recorder.recording, false);
  assert.equal(recorder.frames, 0, 'cancel drops the retained PCM');
  assert.equal(capture.listeners, 0);
  capture.block(new Float32Array(9000));
  assert.deepEqual([finished.length, errors.length], [0, 0]);
  assert.equal(recorder.cancel(), false, 'cancelling twice changes nothing');
  assert.equal(recorder.start(), true);
  capture.block(new Float32Array(500));
  t.mock.timers.tick(15000);
  assert.equal(errors.length, 1); assert.match(errors[0], /10 s/);
  assert.equal(recorder.frames, 0); assert.equal(capture.listeners, 0);
  capture.active = false;
  assert.equal(recorder.start(), false, 'an inactive capture is never borrowed');
  assert.equal(capture.listeners, 0);
});

// The mounted controller uses the same small DOM double as the other surfaces;
// microphone permission, device identities and Web Audio callbacks stay explicit.
function performanceUI(t, audio, session = trainingSession()) {
  const nodes = new Map();
  class Node {
    constructor(tag) {
      this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.captured = new Set(); this.isConnected = false;
      this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.className = '';
      this.style = { setProperty() {} }; this.classList = { toggle() {}, add() {} };
      this.open = false;
    }
    set id(value) { this._id = value; nodes.set(value, this); } get id() { return this._id; }
    get options() { return this.children; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    appendChild(child) { this.append(child); return child; }
    contains(node) { return !!node && (node === this || this.children.some(child => child.contains?.(node))); }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return descendants;
      if (selector === '[data-idle-only]') return descendants.filter(child => child.dataset.idleOnly !== undefined);
      return descendants.filter(child => ['button', 'input', 'select', 'textarea'].includes(child.tag));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    prepend(...children) { for (const child of children.reverse()) { child.parent = this; this.children.unshift(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    get lastChild() { return this.children.at(-1); }
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    focus() { document.activeElement = this; }
    click() { this.clicked = true; }
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
  doc.anchors = [];
  Object.assign(doc, {
    body: new Node('body'), getElementById: id => nodes.get(id),
    createElement: tag => { const node = new Node(tag); if (tag === 'a') doc.anchors.push(node); return node; },
    createTextNode: text => Object.assign(new Node('#text'), { textContent: text }), querySelector: () => null,
  });
  install('document', doc); install('window', win); install('Element', Node);
  const values = new Map();
  install('localStorage', { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
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
    nodes, win, doc, notices, install, host,
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
function trainingSession(overrides = {}) {
  return createSession({ bpm: 120, bars: 1, training: { countInBars: 0, repetitions: 1, monitor: true }, metronome: { enabled: false }, drums: { enabled: false }, band: { bassEnabled: false }, progression: { enabled: false }, companion: { enabled: false }, ...overrides });
}
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
function recordedDownloads(t) {
  const downloads = [], revoked = [];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = blob => { downloads.push(blob); return `blob:groovegoblin/${downloads.length}`; };
  URL.revokeObjectURL = url => { revoked.push(url); };
  t.after(() => { URL.createObjectURL = create; URL.revokeObjectURL = revoke; });
  return { downloads, revoked };
}
const downloadName = ui => ui.doc.anchors.at(-1).getAttribute('download');

test('explicit Salvar amostra records exactly ten seconds of the selected channel as a local WAV', async t => {
  const h = harness(t), ui = performanceUI(t, h.audio), capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  const files = recordedDownloads(t);
  ui.mount();
  assert.equal(ui.nodes.get('instrument-sample').disabled, true, 'no capture means no recording action');
  ui.choose('performance-entry', 'instrument'); await settleInput();
  const rate = capture.contexts[0].sampleRate;
  assert.equal(ui.nodes.get('instrument-sample').disabled, false);
  assert.equal(ui.nodes.get('instrument-sample-progress').hidden, true);
  capture.pcm(signal(rate, 3, [{ time: 0, frequency: 220, length: 3, sustained: true }]));
  assert.deepEqual([files.downloads.length, ui.doc.anchors.length], [0, 0], 'capture alone never records or downloads');
  ui.nodes.get('instrument-sample').fire('click');
  assert.equal(ui.nodes.get('instrument-sample-cancel').hidden, false);
  assert.equal(ui.nodes.get('instrument-sample-progress').hidden, false);
  assert.equal(capture.worklets[0].settings.pitchEnabled, true, 'the explicit sample borrows the live worklet');
  const ten = signal(rate, SAMPLE_SECONDS, [{ time: 0, frequency: 220, length: SAMPLE_SECONDS, sustained: true, amplitude: 0.5 }]);
  capture.pcm(ten);
  assert.equal(files.downloads.length, 1);
  assert.equal(files.downloads[0].type, 'audio/wav');
  assert.match(downloadName(ui), /^groovegoblin-amostra-10s-canal-sum\.wav$/);
  assert.equal(ui.doc.anchors.at(-1).getAttribute('href'), 'blob:groovegoblin/1');
  const decoded = decodeWav(await files.downloads[0].arrayBuffer());
  assert.equal(decoded.sampleRate, rate);
  assert.equal(decoded.channels.length, 1);
  assert.equal(decoded.channels[0].length, rate * SAMPLE_SECONDS);
  assert.ok(Math.abs(decoded.channels[0][1000] - ten[1000]) < 0.001);
  assert.equal(capture.requests.length, 1, 'never opens a second microphone');
  assert.equal(capture.streams[0].track.stops, 0, 'the practice capture is only borrowed');
  assert.equal(ui.nodes.get('instrument-sample-progress').hidden, true);
  assert.match(ui.nodes.get('instrument-sample-status').textContent, new RegExp(`Amostra de ${SAMPLE_SECONDS} s`));
});

test('cancel discards the sample, releases the buffers and keeps the borrowed capture open', async t => {
  const h = harness(t), ui = performanceUI(t, h.audio), capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  const files = recordedDownloads(t);
  ui.mount(); ui.choose('performance-entry', 'instrument'); await settleInput();
  const rate = capture.contexts[0].sampleRate;
  ui.nodes.get('instrument-sample').fire('click');
  capture.pcm(signal(rate, 2, [{ time: 0, frequency: 220, length: 2, sustained: true }]));
  assert.match(ui.nodes.get('instrument-sample-status').textContent, /Gravando 2[,.]0 s de 10 s/);
  ui.nodes.get('instrument-sample-cancel').fire('click');
  assert.deepEqual([files.downloads.length, ui.doc.anchors.length], [0, 0], 'cancel never builds or downloads a file');
  assert.equal(ui.nodes.get('instrument-sample-progress').hidden, true);
  assert.equal(ui.nodes.get('instrument-sample-cancel').hidden, true);
  assert.match(ui.nodes.get('instrument-sample-status').textContent, /descartada/);
  capture.pcm(signal(rate, 9, [{ time: 0, frequency: 220, length: 9, sustained: true }]));
  assert.equal(files.downloads.length, 0, 'nothing is recorded after the cancel');
  assert.equal(capture.streams[0].track.stops, 0);
  assert.equal(capture.contexts[0].state, 'running');
  assert.equal(ui.nodes.get('instrument-sample').disabled, false);
  assert.equal(ui.surface.instrument, true);
});

for (const loss of ['channel', 'blur', 'hidden', 'ended']) test(`sample ${loss} releases the recording without downloading anything`, async t => {
  const h = harness(t), ui = performanceUI(t, h.audio), capture = captureDevices(ui, h.ctx, [inputDevice('a'), inputDevice('b')]);
  const files = recordedDownloads(t);
  ui.mount(); ui.choose('performance-entry', 'instrument'); await settleInput();
  const rate = capture.contexts[0].sampleRate;
  ui.nodes.get('instrument-sample').fire('click');
  capture.pcm(signal(rate, 4, [{ time: 0, frequency: 220, length: 4, sustained: true }]));
  const deliverLate = capture.worklets[0].port.onmessage;
  const capturedChannel = capture.worklets[0].settings.channel;
  if (loss === 'channel') ui.choose('instrument-channel', '2');
  else if (loss === 'blur') ui.win.fire('blur');
  else if (loss === 'hidden') { ui.doc.hidden = true; ui.doc.fire('visibilitychange'); }
  else capture.streams[0].track.onended();
  await settleInput();
  assert.deepEqual([files.downloads.length, ui.doc.anchors.length], [0, 0]);
  assert.equal(ui.nodes.get('instrument-sample-progress').hidden, true);
  assert.equal(ui.nodes.get('instrument-sample-cancel').hidden, true);
  deliverLate({ data: { type: 'samples', samples: signal(rate, 8, [{ time: 0, frequency: 220, length: 8, sustained: true }]), startFrame: 4 * rate, channel: capturedChannel } });
  assert.equal(files.downloads.length, 0);
  if (loss === 'channel') { assert.equal(capture.streams[0].track.stops, 0); assert.equal(ui.surface.instrument, true); }
  else { assert.equal(capture.streams[0].track.stops, 1); assert.equal(ui.surface.instrument, false); }
});

test('Testar entrada and training export real observed attacks with estimated pitch and no audio', async t => {
  const h = harness(t), ui = performanceUI(t, h.audio), capture = captureDevices(ui, h.ctx, [inputDevice('a')]);
  const files = recordedDownloads(t);
  saveCalibration('a', -33, ui.storage);
  ui.mount(); ui.choose('performance-entry', 'instrument'); await settleInput();
  const rate = capture.contexts[0].sampleRate;
  assert.equal(ui.nodes.get('input-diagnostics-export').disabled, false);
  ui.nodes.get('instrument-test').fire('click');
  assert.equal(capture.worklets[0].settings.pitchEnabled, true, 'the test observation listens to the real pitch stream');
  capture.attack(100);
  assert.equal(capture.worklets[0].settings.pitchEnabled, true);
  capture.pcm(signal(rate, 0.6, [{ time: 0, frequency: 220, length: 0.6, sustained: true, amplitude: 0.5 }]), 0.1 * rate);
  ui.nodes.get('input-diagnostics-export').fire('click');
  assert.equal(files.downloads.length, 1);
  assert.equal(files.downloads[0].type, 'application/json');
  assert.match(downloadName(ui), /^groovegoblin-entrada-diagnostico\.json$/);
  const report = JSON.parse(await files.downloads[0].text());
  assert.equal(report.audio, false);
  assert.equal(report.source, 'test');
  assert.equal(report.sampleRate, rate);
  assert.equal(report.channel, 'sum');
  assert.equal(report.sensitivity, 1);
  assert.equal(report.compensation, -33);
  assert.deepEqual(report.profile, { type: 'guitar', strings: 6, tuning: [40, 45, 50, 55, 59, 64], noteNames: 'letters' });
  assert.deepEqual(report.device, { deviceId: 'a', calibrationDeviceId: 'a', label: 'Interface a' });
  assert.equal(report.attacks.length, 1, 'only the observed attack enters the list');
  const [observed] = report.attacks;
  assert.ok(Math.abs(observed.time - 0.1) < 0.001, `attack at ${observed.time} s`);
  assert.equal(observed.level, 0.5);
  assert.ok(Math.abs(observed.estimatedPitch - 220) < 3, `estimated pitch ${observed.estimatedPitch}`);
  assert.ok(observed.confidence > 0.85, `confidence ${observed.confidence}`);
  assert.deepEqual(Object.keys(observed), ['time', 'level', 'estimatedPitch', 'confidence']);
  assert.equal(JSON.stringify(report).includes('expectedPitch'), false);

  ui.nodes.get('instrument-test').fire('click');
  const snapshot = ui.surface.session(trainingSession());
  await h.audio.playSession(snapshot, { mode: 'train', ...ui.surface.playOptions('train', snapshot) });
  ui.surface.started(snapshot);
  capture.attack(1200);
  capture.pcm(signal(rate, 0.6, [{ time: 0, frequency: 330, length: 0.6, sustained: true, amplitude: 0.5 }]), 1.2 * rate);
  ui.host.stop();
  assert.equal(h.audio.position.mode, 'idle');
  assert.equal(ui.nodes.get('input-diagnostics-export').disabled, false);
  ui.nodes.get('input-diagnostics-export').fire('click');
  const trained = JSON.parse(await files.downloads[1].text());
  assert.equal(trained.source, 'training');
  assert.equal(trained.attacks.length, 1, 'a new training resets the previous test list');
  assert.ok(Math.abs(trained.attacks[0].time - 1.2) < 0.001, `training attack at ${trained.attacks[0].time} s`);
  assert.ok(Math.abs(trained.attacks[0].estimatedPitch - 330) < 3, `training pitch ${trained.attacks[0].estimatedPitch}`);
  assert.ok(trained.attacks[0].confidence > 0.85);
  assert.equal(capture.requests.length, 1);
});


const fixtures = await (async () => {
  try { return (await readdir(fileURLToPath(FIXTURE_DIRECTORY))).filter(name => name.toLowerCase().endsWith('.wav')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
})();

test('supplied real instrument WAVs are decoded and evaluated against their expected onsets', { skip: fixtures.length ? false : 'Nenhuma amostra em tests/fixtures/instrument; teste pulado.' }, async () => {
  for (const name of fixtures) {
    const bytes = await readFile(new URL(name, FIXTURE_DIRECTORY));
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const { sampleRate, channels } = decodeWav(arrayBuffer);
    const sidecar = JSON.parse(await readFile(new URL(name.replace(/\.wav$/i, '.json'), FIXTURE_DIRECTORY), 'utf8'));
    const expected = sidecar.expectedOnsets ?? sidecar.expected ?? [];
    const channel = channels[sidecar.channel ?? 0];
    assert.ok(channel, `${name}: canal ausente`);
    const options = { sensitivity: sidecar.sensitivity ?? 1, refractory: sidecar.refractory ?? 0.05, instrumentType: sidecar.instrumentType ?? 'guitar' };
    let state = createOnsetState(sampleRate);
    const onsets = [];
    for (let offset = 0; offset < channel.length; offset += 128) {
      const result = detectOnsets(state, channel.subarray(offset, offset + 128), options);
      state = result.state;
      for (const event of result.events) onsets.push(event.frame / sampleRate);
    }
    const tolerance = sidecar.toleranceSeconds ?? 0.025;
    assert.equal(onsets.length, expected.length, `${name}: ${onsets.length} ataques detectados, ${expected.length} esperados`);
    expected.forEach((time, index) => assert.ok(Math.abs(onsets[index] - time) <= tolerance, `${name}: ataque ${index} em ${onsets[index].toFixed(3)} s difere de ${time} s além de ${tolerance} s`));
    if (Number.isFinite(sidecar.sampleRate)) assert.equal(sampleRate, sidecar.sampleRate, `${name}: taxa de amostragem`);
  }
});
