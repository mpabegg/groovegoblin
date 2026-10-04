// Relógio e grafo Web Audio determinísticos para contratos de agendamento.
// O áudio real é verificado no navegador; este auxiliar inspeciona parâmetros.
import { GrooveAudio } from '../src/audio.js';

export const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export function audioContext({ length = 44100, sampleRate = 44100 } = {}) {
  const nodes = []; const sources = [];
  const parameter = value => ({
    value, events: [],
    setValueAtTime(value, time) { this.events.push({ kind: 'set', value, time }); },
    linearRampToValueAtTime(value, time) { this.events.push({ kind: 'ramp', value, time }); },
    setTargetAtTime(value, time, constant) { this.events.push({ kind: 'target', value, time, constant }); },
    cancelScheduledValues(time) { this.events = this.events.filter(event => event.time < time); },
    cancelAndHoldAtTime(time) { this.cancelScheduledValues(time); },
  });
  const node = type => {
    const value = { type, connections: [], connect(destination) { this.connections.push(destination); return destination; }, disconnect() { this.disconnected = true; } };
    nodes.push(value); return value;
  };
  const source = type => {
    const value = { ...node(type), frequency: parameter(440), detune: parameter(0), stops: [],
      start(time) { this.startTime = time; }, stop(time) { this.stops.push(time); }, setPeriodicWave(wave) { this.wave = wave; } };
    sources.push(value); return value;
  };
  const ctx = {
    currentTime: 0, state: 'running', sampleRate, length, nodes, sources, destination: node('destination'),
    createGain() { return { ...node('gain'), gain: parameter(1) }; },
    createOscillator() { return source('oscillator'); },
    createBufferSource() { return source('buffer'); },
    createBiquadFilter() { return { ...node('filter'), frequency: parameter(1000), Q: parameter(1) }; },
    createDynamicsCompressor() { return { ...node('compressor'), ...Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(key => [key, parameter(0)])) }; },
    createWaveShaper() { return node('waveshaper'); },
    createPeriodicWave(real, imag) { return { real, imag }; },
    createBuffer(channels, length, rate) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { numberOfChannels: channels, length, duration: length / rate, sampleRate: rate, getChannelData(channel) { return data[channel]; } }; },
    async decodeAudioData(data) { const buffer = this.createBuffer(1, 128, sampleRate); buffer.getChannelData(0)[0] = 0.1; buffer.instrument = new Uint8Array(data)[0]; return buffer; },
    async resume() { this.state = 'running'; },
    async startRendering() { return { context: ctx, length, sampleRate, numberOfChannels: 2, duration: length / sampleRate }; },
  };
  return ctx;
}
export function harness(t, { resumeGate = null, loadGate = null, onFinish = () => {}, onState = () => {} } = {}) {
  const ctx = audioContext(); const intervals = new Set(); const timeouts = new Map(); const requests = [];
  if (resumeGate) { ctx.state = 'suspended'; ctx.resume = async () => { await resumeGate.promise; ctx.state = 'running'; }; }
  t.mock.method(performance, 'now', () => ctx.currentTime * 1000);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class { constructor() { return ctx; } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'AudioContext', original); else delete globalThis.AudioContext; });
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url.href); if (loadGate) await loadGate.promise;
    return { ok: true, arrayBuffer: async () => new Uint8Array([['kick', 'snare', 'hihat'].findIndex(name => url.pathname.endsWith(`/${name}.wav`))]).buffer };
  });
  t.mock.method(globalThis, 'setInterval', callback => { intervals.add(callback); return callback; });
  t.mock.method(globalThis, 'clearInterval', callback => intervals.delete(callback));
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { timeouts.set(callback, ctx.currentTime + delay / 1000); return callback; });
  t.mock.method(globalThis, 'clearTimeout', callback => timeouts.delete(callback));
  const audio = new GrooveAudio({ onFinish, onState }); t.after(() => audio.stop());
  function tick(time) {
    ctx.currentTime = time;
    for (const callback of [...intervals]) callback();
    for (const [callback, due] of [...timeouts]) if (due <= time + 1e-9) { timeouts.delete(callback); callback(); }
  }
  return { ctx, audio, intervals, timeouts, requests, tick,
    advance(time) { while (ctx.currentTime + 0.02 < time) tick(ctx.currentTime + 0.02); tick(time); },
  };
}
export function close(actual, expected, epsilon = 1e-8) {
  if (Math.abs(actual - expected) > epsilon) throw new Error(`${actual} != ${expected}`);
}
