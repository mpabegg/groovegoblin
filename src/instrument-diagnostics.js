// Item 7 — diagnóstico da entrada. Duas ações explícitas sobre a MESMA captura
// que o Treinar já mantém aberta: um JSON com a configuração realmente
// observada e a lista de ataques capturados, e uma única amostra de 10 s do
// canal escolhido. O PCM só existe em memória enquanto essa ação está em
// curso; nada é enviado, nada é guardado no navegador e nenhum segundo
// microfone é aberto. A altura registrada é a estimada pelo detector real,
// nunca a esperada pela partitura.
import { encodeWav } from './wav.js';

export const SAMPLE_SECONDS = 10;
export const SAMPLE_TIMEOUT_SECONDS = SAMPLE_SECONDS + 5;
export const DIAGNOSTIC_ATTACK_LIMIT = 64;
export const PITCH_ASSOCIATION_SECONDS = 0.3;
export const DIAGNOSTIC_REPORT_KIND = 'groovegoblin-input-diagnostics';
export const DIAGNOSTIC_REPORT_VERSION = 1;

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

// Bounded, ephemeral observation log. Each attack keeps the strongest real
// pitch estimate the capture published in the short window that follows it;
// unidentified windows stay null with their own measured confidence.
export function createDiagnosticLog({ limit = DIAGNOSTIC_ATTACK_LIMIT, associationSeconds = PITCH_ASSOCIATION_SECONDS } = {}) {
  let entries = [];
  let source = null;
  return {
    get source() { return source; },
    get size() { return entries.length; },
    reset(next = null) { entries = []; source = next; },
    attack(event) {
      if (!Number.isFinite(event?.time)) return;
      entries.push({ time: event.time, level: Number.isFinite(event.level) ? event.level : 0, estimatedPitch: null, confidence: 0 });
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    pitch(event) {
      const last = entries[entries.length - 1];
      if (!last || !Number.isFinite(event?.time)) return;
      const delta = (event.time - last.time) / 1000;
      if (delta < -0.02 || delta > associationSeconds) return;
      const confidence = Number.isFinite(event.confidence) ? event.confidence : 0;
      if (last.estimatedPitch !== null && confidence <= last.confidence) return;
      last.estimatedPitch = Number.isFinite(event.frequency) && event.frequency > 0 ? event.frequency : null;
      last.confidence = confidence;
    },
    entries: () => entries.map(entry => ({ ...entry })),
  };
}

// Serialisable report: observed configuration plus attacks, never audio and
// never an expected pitch. `audio: false` is explicit so the file states what
// it is not.
export function diagnosticReport({ attacks = [], source = null, device = null, channel = 'sum', sampleRate = null,
  sensitivity = 1, compensation = null, profile = null, generatedAt = new Date().toISOString() } = {}) {
  return {
    kind: DIAGNOSTIC_REPORT_KIND,
    version: DIAGNOSTIC_REPORT_VERSION,
    generatedAt,
    source,
    audio: false,
    device: device ? { deviceId: device.deviceId ?? '', calibrationDeviceId: device.calibrationDeviceId ?? null, label: device.label ?? '' } : null,
    channel,
    sampleRate: Number.isFinite(sampleRate) ? sampleRate : null,
    sensitivity: Number.isFinite(sensitivity) ? sensitivity : 1,
    compensation: Number.isFinite(compensation) ? compensation : null,
    profile: profile ? { type: profile.type, strings: profile.strings, tuning: [...profile.tuning], noteNames: profile.noteNames } : null,
    units: { time: 'seconds', level: '0–1 RMS', estimatedPitch: 'Hz', confidence: '0–1' },
    attacks: attacks.map(entry => ({
      time: round(Number.isFinite(entry.time) ? entry.time / 1000 : 0, 4),
      level: round(Number.isFinite(entry.level) ? entry.level : 0, 4),
      estimatedPitch: Number.isFinite(entry.estimatedPitch) ? round(entry.estimatedPitch, 2) : null,
      confidence: round(Number.isFinite(entry.confidence) ? entry.confidence : 0, 4),
    })),
  };
}

// One channel of 16-bit PCM WAV from exactly the recorded frames.
export function encodeSampleWav({ data, sampleRate }) {
  return encodeWav({ numberOfChannels: 1, sampleRate, length: data.length, getChannelData: () => data });
}

// Explicit, bounded PCM recorder that borrows the live capture: it never opens
// a microphone, never keeps audio outside the action and never extends it.
// The owner cancels it on cancel/blur/hidden/disconnect/channel change, which
// drops the buffers; the capture itself is only ever released by its owner.
export function createSampleRecorder({ capture, channel, sampleRate, seconds = SAMPLE_SECONDS,
  timeoutSeconds = SAMPLE_TIMEOUT_SECONDS, onProgress = () => {}, onFinish, onCancel = () => {}, onError = () => {} }) {
  const targetFrames = Math.max(1, Math.round(sampleRate * seconds));
  let chunks = [];
  let frames = 0;
  let recording = false;
  let unsubscribe = null;
  let timer = null;
  const release = () => {
    chunks = []; frames = 0;
    unsubscribe?.(); unsubscribe = null;
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };
  const fail = message => {
    if (!recording) return;
    recording = false; release();
    onError(message);
  };
  function finish() {
    const data = new Float32Array(targetFrames);
    let offset = 0;
    for (const chunk of chunks) {
      if (offset >= targetFrames) break;
      const size = Math.min(chunk.length, targetFrames - offset);
      data.set(chunk.subarray(0, size), offset);
      offset += size;
    }
    recording = false; release();
    onFinish({ data, sampleRate, channel, seconds: data.length / sampleRate });
  }
  function block(samples) {
    if (!recording || !samples?.length) return;
    chunks.push(samples);
    frames += samples.length;
    onProgress({ seconds: Math.min(seconds, frames / sampleRate), total: seconds });
    if (frames >= targetFrames) finish();
  }
  return {
    get recording() { return recording; },
    get frames() { return frames; },
    get targetFrames() { return targetFrames; },
    start() {
      if (recording || !capture.active) return false;
      recording = true; chunks = []; frames = 0;
      onProgress({ seconds: 0, total: seconds });
      unsubscribe = capture.subscribeSamples(block);
      timer = setTimeout(() => fail('A entrada não entregou 10 s de áudio; a amostra foi descartada.'), timeoutSeconds * 1000);
      return true;
    },
    cancel() {
      if (!recording) return false;
      recording = false; release();
      onCancel();
      return true;
    },
  };
}
