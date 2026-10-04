import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrooveAudio } from '../src/audio.js';
import { generateDrums } from '../src/drums.js';

const notes = [{ id: 'reference', start: 0, duration: 4 }];
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function harness(t, { loadGate = null, resumeGate = null, samplePeaks = [0.141, 0.079, 0.052] } = {}) {
  const requests = [];
  const intervals = new Set();
  const oscillators = [];
  const samples = [];
  const decodedBuffers = [];
  let fail = false;
  const parameter = () => {
    let initialValue = 0;
    const events = [];
    const at = time => {
      let value = initialValue;
      let previousTime = 0;
      for (const event of events) {
        if (time < event.time) {
          if (event.kind === 'ramp') {
            return value + (event.value - value) * (time - previousTime) / (event.time - previousTime);
          }
          break;
        }
        value = event.value;
        previousTime = event.time;
      }
      return value;
    };
    const cancel = time => {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].time >= time) events.splice(index, 1);
      }
    };
    return {
      get value() { return at(ctx.currentTime); },
      set value(value) { initialValue = value; events.length = 0; },
      at,
      setValueAtTime(value, time) { events.push({ kind: 'set', value, time }); },
      linearRampToValueAtTime(value, time) { events.push({ kind: 'ramp', value, time }); },
      cancelScheduledValues: cancel,
      cancelAndHoldAtTime(time) {
        const value = at(time);
        cancel(time);
        events.push({ kind: 'set', value, time });
      },
    };
  };
  const node = () => ({
    connections: [], stops: [],
    connect(target) { this.connections.push(target); return target; },
    disconnect() {},
    start(time) { this.startTime = time; },
    stop(time) { this.stops.push(time); },
  });
  const ctx = {
    currentTime: 0,
    state: resumeGate ? 'suspended' : 'running',
    destination: {},
    async resume() { if (resumeGate) await resumeGate.promise; this.state = 'running'; },
    createGain() { return { ...node(), gain: parameter() }; },
    createOscillator() { const osc = { ...node(), frequency: parameter() }; oscillators.push(osc); return osc; },
    createBufferSource() { const source = node(); samples.push(source); return source; },
    async decodeAudioData(data) {
      const instrument = new Uint8Array(data)[0];
      const peak = samplePeaks[instrument];
      const channels = [new Float32Array([0, peak / 2]), new Float32Array([-peak, 0])];
      const buffer = {
        instrument, duration: 0.2, numberOfChannels: channels.length, channels, channelReads: 0,
        getChannelData(channel) { this.channelReads += 1; return channels[channel]; },
      };
      decodedBuffers.push(buffer);
      return buffer;
    },
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class { constructor() { return ctx; } } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'AudioContext', descriptor);
    else delete globalThis.AudioContext;
  });
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url.href);
    if (loadGate) await loadGate.promise;
    const instrument = ['kick', 'snare', 'hihat'].findIndex(name => url.pathname.endsWith(`/${name}.wav`));
    return { ok: !fail, status: fail ? 404 : 200, async arrayBuffer() { return new Uint8Array([instrument]).buffer; } };
  });
  t.mock.method(globalThis, 'setInterval', callback => { intervals.add(callback); return callback; });
  t.mock.method(globalThis, 'clearInterval', callback => { intervals.delete(callback); });
  t.mock.method(globalThis, 'setTimeout', callback => callback);
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const audio = new GrooveAudio();
  t.after(() => audio.stop());
  // Evaluate audible gain along any path, not a particular mixer topology.
  const downstreamGain = (source, time) => {
    if (source === ctx.destination) return 1;
    const gain = source.gain ? source.gain.at(time) : 1;
    return gain * source.connections.reduce((sum, target) => sum + downstreamGain(target, time), 0);
  };
  return {
    audio, ctx, samples, oscillators, requests, intervals, decodedBuffers,
    downstreamGain,
    fail(value) { fail = value; },
    advance(time) { ctx.currentTime = time; for (const callback of [...intervals]) callback(); },
  };
}

function assertTime(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test('samples e notas compartilham início, BPM e loop de 1, 2 e 4 compassos', async t => {
  const h = harness(t);
  for (const bars of [1, 2, 4]) {
    for (const bpm of [40, 120, 240]) {
      h.ctx.currentTime = 0;
      const firstSample = h.samples.length;
      const firstNote = h.oscillators.length;
      const pattern = generateDrums({ notes, bars, seed: 42 });
      await h.audio.play(notes, bpm, false, bars, { hits: pattern.hits, enabled: true });
      const tickSeconds = 60 / bpm / 4;
      h.advance(bars * 16 * tickSeconds + 0.01);
      const scheduled = h.samples.slice(firstSample);
      for (const hit of pattern.hits) {
        assert.ok(scheduled.some(source => source.buffer.instrument === ['kick', 'snare', 'hihat'].indexOf(hit.instrument) && Math.abs(source.startTime - (0.06 + hit.start * tickSeconds)) < 1e-9));
      }
      const kickStarts = scheduled.filter(source => source.buffer.instrument === 0).map(source => source.startTime);
      assertTime(kickStarts[0], 0.06);
      assertTime(kickStarts.at(-1), 0.06 + bars * 16 * tickSeconds);
      const reference = h.oscillators.slice(firstNote);
      assert.equal(reference.length, 2);
      assertTime(reference[0].startTime, kickStarts[0]);
      assertTime(reference[1].startTime, kickStarts.at(-1));
      assert.ok(reference.every(source => h.downstreamGain(source, source.startTime + 0.01) > 0), 'referência segue audível');
      h.audio.stop();
    }
  }
  assert.equal(h.requests.length, 3, 'buffers são reutilizados');
  for (const name of ['kick', 'snare', 'hihat']) assert.ok(h.requests.some(url => url.endsWith(`/assets/drums/${name}.wav`)));
});

test('desligar bateria silencia até samples já agendados sem parar frase ou relógio', async t => {
  const h = harness(t);
  const pattern = generateDrums({ notes, bars: 1, seed: 42 });
  await h.audio.play(notes, 120, false, 1, { hits: pattern.hits, enabled: true });
  const scheduledSample = h.samples[0];
  const sampleGain = h.downstreamGain(scheduledSample, 0.06);
  assert.ok(sampleGain > 0);
  h.ctx.currentTime = 0.07;
  await h.audio.setDrumsEnabled(false);
  assertTime(h.downstreamGain(scheduledSample, 0.07), sampleGain);
  assertTime(h.downstreamGain(scheduledSample, 0.075), sampleGain / 2);
  assertTime(h.downstreamGain(scheduledSample, 0.08), 0);
  assert.equal(h.audio.position.mode, 'play');
  assert.ok(h.downstreamGain(h.oscillators[0], 0.08) > 0, 'referência não é silenciada');
  const sampleCount = h.samples.length;
  h.advance(2.01);
  assert.equal(h.samples.length, sampleCount);
  assert.equal(h.oscillators.length, 2, 'frase continua no próximo loop');
  assertTime(h.oscillators[1].startTime, 2.06);
  await h.audio.setDrumsEnabled(true);
  assertTime(h.downstreamGain(scheduledSample, 2.01), 0);
  assertTime(h.downstreamGain(scheduledSample, 2.015), sampleGain / 2);
  assertTime(h.downstreamGain(scheduledSample, 2.02), sampleGain);
  h.advance(4.01);
  assert.ok(h.samples.length > sampleCount);
  assertTime(h.oscillators[2].startTime, 4.06);
});

test('Stop durante carregamento nunca ressuscita Play nem agenda áudio', async t => {
  const gate = deferred();
  const h = harness(t, { loadGate: gate });
  const pending = h.audio.play(notes, 120, false, 1, { hits: generateDrums({ notes, bars: 1, seed: 0 }).hits, enabled: true });
  assert.equal(h.requests.length, 3);
  h.audio.stop();
  gate.resolve();
  await pending;
  assert.equal(h.audio.position.mode, 'idle');
  assert.equal(h.intervals.size, 0);
  assert.equal(h.samples.length, 0);
  assert.equal(h.oscillators.length, 0);
});

test('Play posterior vence carregamento e resume antigos sem perder seu loop', async t => {
  const loadGate = deferred();
  const resumeGate = deferred();
  const h = harness(t, { loadGate, resumeGate });
  const oldPlay = h.audio.play(notes, 40, false, 4, { hits: generateDrums({ notes, bars: 4, seed: 0 }).hits, enabled: true });
  const newPlay = h.audio.play(notes, 120, false, 1);
  resumeGate.resolve();
  await newPlay;
  loadGate.resolve();
  await oldPlay;
  assert.equal(h.audio.position.mode, 'play');
  assert.equal(h.intervals.size, 1);
  assert.equal(h.samples.length, 0);
  h.advance(2.01);
  assert.equal(h.oscillators.length, 2);
  assertTime(h.oscillators[1].startTime, 2.06);
});

test('falha de carga é explícita, não inicia playback parcial e permite tentar novamente', async t => {
  const h = harness(t);
  const pattern = generateDrums({ notes, bars: 1, seed: 0 });
  h.fail(true);
  await assert.rejects(h.audio.play(notes, 120, false, 1, { hits: pattern.hits, enabled: true }), /Falha ao carregar samples.*HTTP 404/);
  assert.equal(h.audio.position.mode, 'idle');
  assert.equal(h.samples.length, 0);
  assert.equal(h.oscillators.length, 0);
  h.fail(false);
  await h.audio.play(notes, 120, false, 1, { hits: pattern.hits, enabled: true });
  assert.equal(h.audio.position.mode, 'play');
  assert.equal(h.requests.length, 6);
  assert.ok(h.samples.length > 0);
});

test('falha ao ativar bateria ao vivo não interrompe o grid', async t => {
  const h = harness(t);
  await h.audio.play(notes, 120, false, 1, { hits: generateDrums({ notes, bars: 1, seed: 0 }).hits });
  h.fail(true);
  await assert.rejects(h.audio.setDrumsEnabled(true), /Falha ao carregar samples/);
  assert.equal(h.audio.position.mode, 'play');
  h.advance(2.01);
  assert.equal(h.oscillators.length, 2);
  assert.equal(h.samples.length, 0);
  h.fail(false);
  await h.audio.setDrumsEnabled(true);
  h.advance(4.01);
  assert.ok(h.samples.length > 0);
});

test('desativar ou parar enquanto a ativação carrega invalida a continuação', async t => {
  const gate = deferred();
  const h = harness(t, { loadGate: gate });
  await h.audio.play(notes, 120, false, 1, { hits: generateDrums({ notes, bars: 1, seed: 0 }).hits });
  const activating = h.audio.setDrumsEnabled(true);
  await h.audio.setDrumsEnabled(false);
  gate.resolve();
  assert.equal(await activating, false);
  h.advance(2.01);
  assert.equal(h.audio.position.mode, 'play');
  assert.equal(h.samples.length, 0);
  assert.equal(h.oscillators.length, 2);
  const enabling = h.audio.setDrumsEnabled(true);
  h.audio.stop();
  assert.equal(await enabling, false);
  assert.equal(h.audio.position.mode, 'idle');
});

test('treino usa somente metrônomo, sem buscar samples ou tocar a frase', async t => {
  const h = harness(t);
  await h.audio.train(notes, 120, 2);
  await h.audio.setDrumsEnabled(true);
  h.advance(2.01);
  assert.equal(h.requests.length, 0);
  assert.equal(h.samples.length, 0);
  assert.ok(h.oscillators.length > 0);
  assert.equal(h.oscillators.length, 5, 'cliques da entrada e primeiro tempo do treino, sem notas extras');
});

test('erro de decodificação é relatado e nenhum buffer parcial é usado', async t => {
  const h = harness(t);
  h.ctx.decodeAudioData = async () => { throw new Error('WAV inválido'); };
  await assert.rejects(h.audio.play(notes, 120, false, 1, { hits: generateDrums({ notes, bars: 1, seed: 0 }).hits, enabled: true }), /Falha ao carregar samples.*WAV inválido/);
  assert.equal(h.audio.position.mode, 'idle');
  assert.equal(h.samples.length, 0);
  assert.equal(h.oscillators.length, 0);
});

test('ganho compensa o pico de todos os canais uma vez sem alterar PCM original', async t => {
  const peaks = [0.141, 0.079, 0.052];
  const targets = [0.24, 0.2, 0.1];
  const h = harness(t, { samplePeaks: peaks });
  const pattern = generateDrums({ notes, bars: 1, seed: 42 });
  await h.audio.play(notes, 120, false, 1, { hits: pattern.hits, enabled: true });
  h.advance(2.01);
  for (const hit of pattern.hits) {
    const instrument = ['kick', 'snare', 'hihat'].indexOf(hit.instrument);
    const time = 0.06 + hit.start * 0.125;
    const source = h.samples.find(source => source.buffer.instrument === instrument && Math.abs(source.startTime - time) < 1e-9);
    const actualPeak = Math.abs(source.buffer.channels[1][0]);
    assertTime(actualPeak * h.downstreamGain(source, time + 0.01), targets[instrument] * hit.velocity);
  }
  for (const buffer of h.decodedBuffers) {
    assert.equal(buffer.channelReads, 2, 'pico medido apenas uma vez por canal');
    assert.deepEqual(buffer.channels, [
      new Float32Array([0, peaks[buffer.instrument] / 2]),
      new Float32Array([-peaks[buffer.instrument], 0]),
    ], 'dados decodificados não são normalizados in-place');
  }
  h.audio.stop();
  await h.audio.play(notes, 120, false, 1, { hits: pattern.hits, enabled: true });
  assert.equal(h.decodedBuffers.length, 3);
  assert.ok(h.decodedBuffers.every(buffer => buffer.channelReads === 2), 'replay não mede os buffers novamente');
});

test('parar durante fade de reativação cancela o ganho futuro sem reviver bateria', async t => {
  const h = harness(t);
  await h.audio.play(notes, 120, false, 1, { hits: generateDrums({ notes, bars: 1, seed: 0 }).hits, enabled: true });
  const source = h.samples[0];
  h.ctx.currentTime = 0.07;
  await h.audio.setDrumsEnabled(false);
  h.ctx.currentTime = 0.08;
  await h.audio.setDrumsEnabled(true);
  h.ctx.currentTime = 0.085;
  const beforeStop = h.downstreamGain(source, 0.085);
  assert.ok(beforeStop > 0);
  h.audio.stop();
  assertTime(h.downstreamGain(source, 0.085), beforeStop);
  const fading = h.downstreamGain(source, 0.09);
  assert.ok(fading > 0 && fading < beforeStop);
  assertTime(h.downstreamGain(source, 0.095), 0);
  assertTime(h.downstreamGain(source, 0.2), 0);
  assert.equal(h.audio.position.mode, 'idle');
  assert.equal(h.intervals.size, 0);
});

test('buffer silencioso não produz ganho infinito', async t => {
  const h = harness(t, { samplePeaks: [0, 0, 0] });
  await h.audio.play(notes, 120, false, 1, { hits: generateDrums({ notes, bars: 1, seed: 0 }).hits, enabled: true });
  assert.ok(h.samples.length > 0);
  assert.ok(h.samples.every(source => h.downstreamGain(source, source.startTime + 0.01) === 0));
});
