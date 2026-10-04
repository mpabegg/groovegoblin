// Síntese Web Audio compartilhada por AudioContext (ao vivo) e
// OfflineAudioContext (renderização). Cada função agenda nós em `time` e
// devolve {sources, gain, end}: fontes a parar, o ganho final do envelope
// (para silenciar em stop()) e o instante em que o som termina.
//
// Envelopes de nota: ataque até um pico, decaimento até uma sustentação não
// nula, e soltura até zero no fim NOMINAL (pads/pianos podem soar um pouco
// depois). O pico destaca cada novo ataque mesmo entre notas adjacentes, sem
// inserir pausa nem mover ataques/términos; rampas são limitadas a 1/4 da
// duração para manter a ordem das etapas em notas curtas.
//
// Articulação: staccato encurta (45%), ghost suaviza e encurta, accent
// reforça o pico, legato sobrepõe 30 ms à próxima nota, tenuto mantém tudo.

const DRUM_PEAK_GAINS = Object.freeze({ kick: 0.24, snare: 0.2, hihat: 0.1 });
const CLICK_DURATION_SEC = 0.035;
const noiseBuffers = new WeakMap();

export function midiToFrequency(pitch) {
  return 440 * 2 ** ((pitch - 69) / 12);
}

export function articulate(durationSec, velocity, articulation = 'normal') {
  switch (articulation) {
    case 'staccato': return { gate: durationSec * 0.45, velocity, overlap: 0 };
    case 'ghost': return { gate: durationSec * 0.6, velocity: velocity * 0.4, overlap: 0 };
    case 'accent': return { gate: durationSec, velocity: Math.min(1, velocity * 1.25), overlap: 0 };
    case 'legato': return { gate: durationSec, velocity, overlap: 0.03 };
    default: return { gate: durationSec, velocity, overlap: 0 };
  }
}

// Velocidade 0.8 (padrão) mantém o nível histórico das notas.
function amplitude(velocity) {
  return (Math.max(0, velocity) / 0.8) ** 1.3;
}

function noise(ctx) {
  let buffer = noiseBuffers.get(ctx);
  if (!buffer) {
    const length = Math.floor(ctx.sampleRate * 1.5);
    buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let state = 0x2545f491;
    for (let index = 0; index < length; index += 1) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      data[index] = ((state >>> 0) / 4294967296) * 2 - 1;
    }
    noiseBuffers.set(ctx, buffer);
  }
  return buffer;
}

function osc(ctx, type, frequency, time) {
  const node = ctx.createOscillator();
  node.type = type;
  node.frequency.setValueAtTime(frequency, time);
  return node;
}

function gainNode(ctx, value = 0) {
  const node = ctx.createGain();
  node.gain.value = value;
  return node;
}

function filter(ctx, type, frequency, q = 0.7) {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = q;
  return node;
}

// Envelope ADSR com soltura terminando em `end`.
function adsr(param, time, end, { attack, peak, decay, sustain, release }) {
  const span = end - time;
  const a = Math.min(attack, span / 4);
  const d = Math.min(decay, span / 4);
  const r = Math.min(release, span / 4);
  param.setValueAtTime(0, time);
  param.linearRampToValueAtTime(peak, time + a);
  param.linearRampToValueAtTime(sustain, time + a + d);
  param.setValueAtTime(sustain, end - r);
  param.linearRampToValueAtTime(0, end);
}

// Envelope percussivo: ataque curto, queda exponencial e corte em `end`.
function percussive(param, time, end, { attack = 0.003, peak, tau, release = 0.02 }) {
  const a = Math.min(attack, (end - time) / 4);
  param.setValueAtTime(0, time);
  param.linearRampToValueAtTime(peak, time + a);
  param.setTargetAtTime(0, time + a, tau);
  const r = Math.min(release, (end - time) / 4);
  const releaseAt = Math.max(time + a, end - r);
  param.setValueAtTime(peak * Math.exp(-(releaseAt - time - a) / tau), releaseAt);
  param.linearRampToValueAtTime(0, end);
}

function finish(sources, gain, time, end, destination) {
  gain.connect(destination);
  for (const source of sources) {
    source.start(time);
    source.stop(end + 0.02);
  }
  return { sources, gain, end };
}

const TIMBRES = {
  'soft-lead'(ctx, { time, end, frequency, amp }) {
    const tone = osc(ctx, 'triangle', frequency, time);
    const out = gainNode(ctx);
    adsr(out.gain, time, end, { attack: 0.004, peak: 0.55 * amp, decay: 0.025, sustain: 0.22 * amp, release: 0.015 });
    tone.connect(out);
    return { sources: [tone], out, end };
  },
  pluck(ctx, { time, end, frequency, amp }) {
    const tone = osc(ctx, 'sawtooth', frequency, time);
    const lowpass = filter(ctx, 'lowpass', Math.min(frequency * 8, 12000), 1);
    lowpass.frequency.setValueAtTime(Math.min(frequency * 8, 12000), time);
    lowpass.frequency.setTargetAtTime(frequency * 2, time, 0.08);
    const out = gainNode(ctx);
    percussive(out.gain, time, end, { peak: 0.38 * amp, tau: 0.25, release: 0.03 });
    tone.connect(lowpass).connect(out);
    return { sources: [tone], out, end };
  },
  marimba(ctx, { time, end, frequency, amp }) {
    const out = gainNode(ctx);
    out.gain.setValueAtTime(1, time);
    out.gain.setValueAtTime(1, Math.max(time, end - 0.02));
    out.gain.linearRampToValueAtTime(0, end);
    const sources = [];
    for (const [ratio, level, tau] of [[1, 0.6, 0.35], [4, 0.18, 0.05], [10, 0.05, 0.015]]) {
      const tone = osc(ctx, 'sine', frequency * ratio, time);
      const partial = gainNode(ctx);
      percussive(partial.gain, time, end, { attack: 0.002, peak: level * amp, tau });
      tone.connect(partial).connect(out);
      sources.push(tone);
    }
    return { sources, out, end };
  },
  'electric-piano'(ctx, { time, end, frequency, amp }) {
    const tail = end + 0.12;
    const carrier = osc(ctx, 'sine', frequency, time);
    const modulator = osc(ctx, 'sine', frequency, time);
    const index = gainNode(ctx);
    index.gain.setValueAtTime(frequency * 2.5, time);
    index.gain.setTargetAtTime(frequency * 0.3, time, 0.25);
    modulator.connect(index).connect(carrier.frequency);
    const out = gainNode(ctx);
    out.gain.setValueAtTime(0, time);
    out.gain.linearRampToValueAtTime(0.45 * amp, time + 0.003);
    out.gain.setTargetAtTime(0.18 * amp, time + 0.003, 0.6);
    out.gain.setTargetAtTime(0, end, 0.04);
    out.gain.setValueAtTime(0, tail);
    carrier.connect(out);
    return { sources: [carrier, modulator], out, end: tail };
  },
  organ(ctx, { time, end, frequency, amp }) {
    const out = gainNode(ctx);
    adsr(out.gain, time, end, { attack: 0.008, peak: amp, decay: 0.02, sustain: 0.85 * amp, release: 0.03 });
    const sources = [];
    for (const [ratio, level] of [[1, 0.3], [2, 0.18], [3, 0.1], [4, 0.07]]) {
      const tone = osc(ctx, 'sine', frequency * ratio, time);
      const drawbar = gainNode(ctx, level);
      tone.connect(drawbar).connect(out);
      sources.push(tone);
    }
    return { sources, out, end };
  },
  'square-lead'(ctx, { time, end, frequency, amp }) {
    const tone = osc(ctx, 'square', frequency, time);
    const lowpass = filter(ctx, 'lowpass', 2400, 0.8);
    const out = gainNode(ctx);
    adsr(out.gain, time, end, { attack: 0.005, peak: 0.28 * amp, decay: 0.04, sustain: 0.18 * amp, release: 0.02 });
    tone.connect(lowpass).connect(out);
    return { sources: [tone], out, end };
  },
  woodblock(ctx, { time, end, frequency, amp }) {
    let pitch = frequency;
    while (pitch < 600) pitch *= 2;
    const stop = Math.min(end, time + 0.12);
    const tone = osc(ctx, 'sine', pitch, time);
    const click = ctx.createBufferSource();
    click.buffer = noise(ctx);
    const band = filter(ctx, 'bandpass', pitch * 2, 4);
    const out = gainNode(ctx);
    percussive(out.gain, time, stop, { attack: 0.001, peak: 0.5 * amp, tau: 0.03, release: 0.005 });
    tone.connect(out);
    click.connect(band).connect(out);
    return { sources: [tone, click], out, end: stop };
  },
  pad(ctx, { time, end, frequency, amp }) {
    const tail = end + 0.25;
    const out = gainNode(ctx);
    const attack = Math.min(0.12, (end - time) / 3);
    out.gain.setValueAtTime(0, time);
    out.gain.linearRampToValueAtTime(0.2 * amp, time + attack);
    out.gain.setValueAtTime(0.2 * amp, end);
    out.gain.linearRampToValueAtTime(0, tail);
    const lowpass = filter(ctx, 'lowpass', 1600, 0.7);
    const sources = [-8, 8].map(cents => {
      const tone = osc(ctx, 'sawtooth', frequency * 2 ** (cents / 1200), time);
      tone.connect(lowpass);
      return tone;
    });
    lowpass.connect(out);
    return { sources, out, end: tail };
  },
  'nylon-guitar'(ctx, { time, end, frequency, amp }) {
    const harmonics = 16;
    const real = new Float32Array(harmonics + 1);
    const imag = new Float32Array(harmonics + 1);
    for (let n = 1; n <= harmonics; n += 1) imag[n] = Math.abs(Math.sin(n * Math.PI * 0.18)) / n ** 1.4;
    const tone = ctx.createOscillator();
    tone.setPeriodicWave(ctx.createPeriodicWave(real, imag));
    tone.frequency.setValueAtTime(frequency, time);
    const lowpass = filter(ctx, 'lowpass', frequency * 6, 0.8);
    lowpass.frequency.setValueAtTime(frequency * 6, time);
    lowpass.frequency.setTargetAtTime(frequency * 2, time, 0.3);
    const tail = end + 0.08;
    const out = gainNode(ctx);
    percussive(out.gain, time, tail, { attack: 0.002, peak: 0.42 * amp, tau: 0.8, release: 0.08 });
    tone.connect(lowpass).connect(out);
    return { sources: [tone], out, end: tail };
  },
  'upright-bass'(ctx, { time, end, frequency, amp }) {
    const body = osc(ctx, 'triangle', frequency, time);
    const sub = osc(ctx, 'sine', frequency, time);
    const lowpass = filter(ctx, 'lowpass', 700, 0.9);
    const out = gainNode(ctx);
    const span = end - time;
    out.gain.setValueAtTime(0, time);
    out.gain.linearRampToValueAtTime(0.7 * amp, time + Math.min(0.008, span / 4));
    out.gain.setTargetAtTime(0.35 * amp, time + Math.min(0.008, span / 4), 0.25);
    out.gain.setValueAtTime(0.35 * amp, end - Math.min(0.04, span / 4));
    out.gain.linearRampToValueAtTime(0, end);
    body.connect(lowpass);
    sub.connect(lowpass);
    lowpass.connect(out);
    return { sources: [body, sub], out, end };
  },
  'electric-bass'(ctx, { time, end, frequency, amp }) {
    const saw = osc(ctx, 'sawtooth', frequency, time);
    const sine = osc(ctx, 'sine', frequency, time);
    const sawLevel = gainNode(ctx, 0.35);
    const lowpass = filter(ctx, 'lowpass', 1100, 1);
    const out = gainNode(ctx);
    adsr(out.gain, time, end, { attack: 0.004, peak: 0.6 * amp, decay: 0.08, sustain: 0.4 * amp, release: 0.03 });
    saw.connect(sawLevel).connect(lowpass);
    sine.connect(lowpass);
    lowpass.connect(out);
    return { sources: [saw, sine], out, end };
  },
  'synth-bass'(ctx, { time, end, frequency, amp }) {
    const saw = osc(ctx, 'sawtooth', frequency, time);
    const lowpass = filter(ctx, 'lowpass', frequency * 10, 9);
    lowpass.frequency.setValueAtTime(Math.min(frequency * 10, 8000), time);
    lowpass.frequency.setTargetAtTime(frequency * 1.5, time, 0.06);
    const out = gainNode(ctx);
    adsr(out.gain, time, end, { attack: 0.003, peak: 0.45 * amp, decay: 0.1, sustain: 0.3 * amp, release: 0.025 });
    saw.connect(lowpass).connect(out);
    return { sources: [saw], out, end };
  },
};

export const TIMBRE_IDS = Object.freeze(Object.keys(TIMBRES));

// Nota melódica (ou uma voz de acorde).
export function playTone(ctx, destination, { time, duration, pitch = 69, velocity = 0.8, timbre = 'soft-lead', articulation = 'normal' }) {
  const shaped = articulate(duration, velocity, articulation);
  const end = time + Math.max(0.02, shaped.gate + shaped.overlap);
  const build = Object.hasOwn(TIMBRES, timbre) ? TIMBRES[timbre] : TIMBRES['soft-lead'];
  const voice = build(ctx, { time, end, frequency: midiToFrequency(pitch), amp: amplitude(shaped.velocity) });
  return finish(voice.sources, voice.out, time, voice.end, destination);
}

// Acorde: vozes somadas com ganho reduzido para não saturar o barramento.
export function playChord(ctx, destination, { time, duration, pitches, velocity = 0.5, timbre = 'electric-piano', articulation = 'normal' }) {
  const voices = pitches.map(pitch => playTone(ctx, destination, {
    time, duration, pitch, velocity: velocity / Math.max(1, pitches.length) ** (1 / 1.3), timbre, articulation,
  }));
  return voices;
}

// Clique de metrônomo; acentos com timbre mais agudo.
export function playClick(ctx, destination, { time, accent = 'beat', velocity = 0.7 }) {
  const frequency = accent === 'bar' ? 2200 : accent === 'group' ? 1800 : accent === 'sub' ? 1200 : 1500;
  const peak = accent === 'bar' ? 0.55 : accent === 'sub' ? 0.22 : 0.4 * Math.max(0.6, velocity / 0.7);
  const tone = osc(ctx, 'square', frequency, time);
  const out = gainNode(ctx);
  out.gain.setValueAtTime(0, time);
  out.gain.linearRampToValueAtTime(peak, time + 0.002);
  out.gain.linearRampToValueAtTime(0, time + CLICK_DURATION_SEC);
  tone.connect(out);
  return finish([tone], out, time, time + CLICK_DURATION_SEC, destination);
}

function noiseVoice(ctx, destination, time, { type, frequency, q = 0.7, peak, tau, length }) {
  const source = ctx.createBufferSource();
  source.buffer = noise(ctx);
  const shaped = filter(ctx, type, frequency, q);
  const out = gainNode(ctx);
  percussive(out.gain, time, time + length, { attack: 0.001, peak, tau, release: 0.005 });
  source.connect(shaped).connect(out);
  return finish([source], out, time, time + length, destination);
}

const DRUM_SYNTHS = {
  kick(ctx, destination, time, amp) {
    const tone = osc(ctx, 'sine', 150, time);
    tone.frequency.setTargetAtTime(45, time, 0.04);
    const out = gainNode(ctx);
    percussive(out.gain, time, time + 0.35, { attack: 0.002, peak: 0.6 * amp, tau: 0.09 });
    tone.connect(out);
    return finish([tone], out, time, time + 0.35, destination);
  },
  snare(ctx, destination, time, amp) {
    const body = osc(ctx, 'triangle', 190, time);
    const bodyGain = gainNode(ctx);
    percussive(bodyGain.gain, time, time + 0.15, { attack: 0.001, peak: 0.25 * amp, tau: 0.04 });
    const out = gainNode(ctx, 1);
    body.connect(bodyGain).connect(out);
    const snares = noiseVoice(ctx, out, time, { type: 'highpass', frequency: 1500, peak: 0.35 * amp, tau: 0.05, length: 0.2 });
    out.connect(destination);
    body.start(time);
    body.stop(time + 0.17);
    return { sources: [body, ...snares.sources], gain: out, end: time + 0.2 };
  },
  hihat: (ctx, destination, time, amp) => noiseVoice(ctx, destination, time, { type: 'highpass', frequency: 7000, peak: 0.25 * amp, tau: 0.018, length: 0.08 }),
  openhat: (ctx, destination, time, amp) => noiseVoice(ctx, destination, time, { type: 'highpass', frequency: 6500, peak: 0.22 * amp, tau: 0.12, length: 0.45 }),
  shaker: (ctx, destination, time, amp) => noiseVoice(ctx, destination, time, { type: 'bandpass', frequency: 6000, q: 1.5, peak: 0.2 * amp, tau: 0.025, length: 0.09 }),
  rim(ctx, destination, time, amp) {
    const tone = osc(ctx, 'triangle', 1700, time);
    const out = gainNode(ctx);
    percussive(out.gain, time, time + 0.06, { attack: 0.001, peak: 0.35 * amp, tau: 0.012, release: 0.005 });
    tone.connect(out);
    return finish([tone], out, time, time + 0.06, destination);
  },
  ride(ctx, destination, time, amp) {
    const highpass = filter(ctx, 'highpass', 3000, 0.7);
    const out = gainNode(ctx);
    percussive(out.gain, time, time + 1.2, { attack: 0.001, peak: 0.09 * amp, tau: 0.35 });
    const sources = [2637, 3832, 5207, 6930].map(frequency => {
      const tone = osc(ctx, 'square', frequency, time);
      tone.connect(highpass);
      return tone;
    });
    highpass.connect(out);
    return finish(sources, out, time, time + 1.2, destination);
  },
  tom(ctx, destination, time, amp) {
    const tone = osc(ctx, 'sine', 160, time);
    tone.frequency.setTargetAtTime(105, time, 0.08);
    const out = gainNode(ctx);
    percussive(out.gain, time, time + 0.4, { attack: 0.002, peak: 0.45 * amp, tau: 0.12 });
    tone.connect(out);
    return finish([tone], out, time, time + 0.4, destination);
  },
  triangle(ctx, destination, time, amp) {
    const out = gainNode(ctx);
    percussive(out.gain, time, time + 0.5, { attack: 0.001, peak: 0.08 * amp, tau: 0.15 });
    const sources = [3150, 4870, 7240].map(frequency => {
      const tone = osc(ctx, 'sine', frequency, time);
      tone.connect(out);
      return tone;
    });
    return finish(sources, out, time, time + 0.5, destination);
  },
};

// Golpe de bateria: sample CC0 local quando carregado, síntese caso contrário.
export function playDrum(ctx, destination, { time, instrument, velocity }, samples = null) {
  const sample = samples?.[instrument];
  if (sample) {
    const source = ctx.createBufferSource();
    const out = ctx.createGain();
    source.buffer = sample.buffer;
    out.gain.setValueAtTime(velocity * sample.makeupGain, time);
    source.connect(out).connect(destination);
    source.start(time);
    return { sources: [source], gain: out, end: time + sample.buffer.duration };
  }
  return DRUM_SYNTHS[instrument](ctx, destination, time, velocity);
}

const sampleUrls = Object.freeze({
  kick: new URL('../assets/drums/kick.wav', import.meta.url),
  snare: new URL('../assets/drums/snare.wav', import.meta.url),
  hihat: new URL('../assets/drums/hihat.wav', import.meta.url),
});
let sampleBytes = null;
const decodedSamples = new WeakMap();

// Bytes baixados uma vez; cada contexto decodifica sua cópia. Picos ficam
// abaixo da referência; os samples originais decodificados não são alterados.
export function loadDrumSamples(ctx) {
  if (decodedSamples.has(ctx)) return decodedSamples.get(ctx);
  if (!sampleBytes) {
    sampleBytes = Promise.all(Object.entries(sampleUrls).map(async ([instrument, url]) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${instrument}.wav: HTTP ${response.status}`);
      return [instrument, await response.arrayBuffer()];
    })).catch(error => {
      sampleBytes = null;
      throw new Error(`Falha ao carregar samples de bateria: ${error.message}`);
    });
  }
  const decoding = sampleBytes.then(entries => Promise.all(entries.map(async ([instrument, bytes]) => {
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    let peak = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) peak = Math.max(peak, Math.abs(data[index]));
    }
    return [instrument, { buffer, makeupGain: peak > 0 ? DRUM_PEAK_GAINS[instrument] / peak : 0 }];
  }))).then(Object.fromEntries);
  decodedSamples.set(ctx, decoding);
  decoding.catch(() => decodedSamples.delete(ctx));
  return decoding;
}
