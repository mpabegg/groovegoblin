// Análise local de áudio importado: todas as saídas são HIPÓTESES com confiança.
//
// - onsetEnvelope / pickOnsets: fluxo espectral com compressão logarítmica e
//   limiar adaptativo (média local + desvio), sensibilidade ajustável depois.
// - tempoCandidates: autocorrelação do envelope de ataques reforçada pelo dobro
//   do período e ponderada por um prior log-gaussiano centrado em 120 BPM
//   (Ellis, 2007). Retorna vários candidatos (inclusive metade/dobro).
// - trackBeats: rastreamento de pulsos por programação dinâmica (Ellis, 2007),
//   que acompanha pequenas variações de andamento de gravações reais.
// - pitchTrack / segmentNotes: YIN (de Cheveigné & Kawahara, 2002) com correlação
//   via FFT; altura PREDOMINANTE monofônica. Em misturas polifônicas é instável,
//   por isso cada nota carrega confiança e estabilidade.
// - chromagram / chordHypotheses: croma por STFT, correspondência com modelos de
//   tríades e tétrades e suavização de Viterbi; cada segmento traz alternativas.
// - estimateKey: correlação com perfis de Krumhansl-Kessler.

import { createFFT, hannWindow, resample } from './repertoire-dsp.js';

export const ANALYSIS_SAMPLE_RATE = 11025;
export const ANALYSIS_VERSION = 1;
export const PITCH_NAMES = Object.freeze(['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']);
export const CHORD_QUALITIES = Object.freeze([
  Object.freeze({ id: 'maj', suffix: '', intervals: [0, 4, 7] }),
  Object.freeze({ id: 'min', suffix: 'm', intervals: [0, 3, 7] }),
  Object.freeze({ id: '7', suffix: '7', intervals: [0, 4, 7, 10] }),
  Object.freeze({ id: 'maj7', suffix: 'maj7', intervals: [0, 4, 7, 11] }),
  Object.freeze({ id: 'm7', suffix: 'm7', intervals: [0, 3, 7, 10] }),
  Object.freeze({ id: 'dim', suffix: 'dim', intervals: [0, 3, 6] }),
]);
export const NO_CHORD = 'N';

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function reporter(onProgress) {
  return typeof onProgress === 'function' ? onProgress : () => {};
}

function assertMono(mono, sampleRate) {
  if (!(mono instanceof Float32Array)) throw new TypeError('A análise espera um sinal mono Float32Array.');
  if (!Number.isFinite(sampleRate) || sampleRate < 3000) throw new RangeError('Taxa de amostragem inválida para análise.');
}

function mean(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return values.length ? sum / values.length : 0;
}

function standardDeviation(values, average = mean(values)) {
  let sum = 0;
  for (const value of values) sum += (value - average) ** 2;
  return values.length ? Math.sqrt(sum / values.length) : 0;
}

export function midiToName(midi) {
  const rounded = Math.round(midi);
  return `${PITCH_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

export function chordLabel(root, qualityId) {
  if (root === null || qualityId === NO_CHORD) return NO_CHORD;
  const quality = CHORD_QUALITIES.find(item => item.id === qualityId);
  return `${PITCH_NAMES[root]}${quality ? quality.suffix : ''}`;
}

// Fluxo espectral: um valor por quadro, alinhado ao centro do quadro.
export function onsetEnvelope(mono, sampleRate, { onProgress } = {}) {
  assertMono(mono, sampleRate);
  const progress = reporter(onProgress);
  const size = 2 ** Math.max(8, Math.round(Math.log2(sampleRate * 0.046)));
  const hop = size / 4;
  const bins = size / 2 + 1;
  const fft = createFFT(size);
  const window = hannWindow(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const previous = new Float64Array(bins);
  const frameCount = Math.max(1, Math.ceil(mono.length / hop));
  const envelope = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * hop - size / 2;
    for (let n = 0; n < size; n++) {
      const index = start + n;
      re[n] = index >= 0 && index < mono.length ? mono[index] * window[n] : 0;
      im[n] = 0;
    }
    fft.forward(re, im);
    let flux = 0;
    for (let k = 1; k < bins; k++) {
      const value = Math.log1p(100 * Math.hypot(re[k], im[k]));
      if (frame > 0) flux += Math.max(0, value - previous[k]);
      previous[k] = value;
    }
    envelope[frame] = flux;
    if (frame % 512 === 0) progress(frame / frameCount);
  }
  progress(1);
  return { envelope, frameRate: sampleRate / hop };
}

// sensitivity 0..1: valores maiores aceitam ataques mais fracos.
export function pickOnsets(envelope, frameRate, { sensitivity = 0.5, minInterval = 0.05 } = {}) {
  if (!(envelope instanceof Float32Array) || !(frameRate > 0)) return [];
  const level = Math.min(1, Math.max(0, sensitivity));
  const average = mean(envelope);
  const deviation = standardDeviation(envelope, average) || 1e-9;
  const localReach = Math.max(1, Math.round(frameRate * 0.1));
  const peakReach = Math.max(1, Math.round(frameRate * 0.03));
  const gap = Math.max(1, Math.round(frameRate * minInterval));
  const delta = (1.6 - 1.4 * level) * deviation;
  const prefix = new Float64Array(envelope.length + 1);
  for (let i = 0; i < envelope.length; i++) prefix[i + 1] = prefix[i] + envelope[i];
  const onsets = [];
  let last = -Infinity;
  for (let i = 0; i < envelope.length; i++) {
    const value = envelope[i];
    const from = Math.max(0, i - localReach);
    const to = Math.min(envelope.length, i + localReach + 1);
    const threshold = (prefix[to] - prefix[from]) / (to - from) + delta;
    if (value <= threshold) continue;
    let isPeak = true;
    for (let j = Math.max(0, i - peakReach); j <= Math.min(envelope.length - 1, i + peakReach); j++) {
      if (envelope[j] > value || (envelope[j] === value && j < i)) { isPeak = false; break; }
    }
    if (!isPeak || i - last < gap) continue;
    onsets.push({
      time: i / frameRate,
      strength: value / (average + deviation * 3),
      confidence: Math.min(1, Math.max(0, 1 - Math.exp(-(value - threshold) / deviation))),
    });
    last = i;
  }
  return onsets;
}

function autocorrelation(signal, maxLag) {
  const centered = new Float64Array(signal.length);
  const average = mean(signal);
  for (let i = 0; i < signal.length; i++) centered[i] = Math.max(0, signal[i] - average);
  const acf = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag && lag < centered.length; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < centered.length; i++) sum += centered[i] * centered[i + lag];
    acf[lag] = sum / (centered.length - lag);
  }
  return acf;
}

export function tempoCandidates(envelope, frameRate, { minBpm = 40, maxBpm = 240, count = 5 } = {}) {
  if (!(envelope instanceof Float32Array) || envelope.length < 8 || !(frameRate > 0)) return [];
  const minLag = Math.max(2, Math.floor(60 * frameRate / maxBpm));
  const maxLag = Math.ceil(60 * frameRate / minBpm);
  const acf = autocorrelation(envelope, Math.min(envelope.length - 1, maxLag * 2 + 2));
  const score = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1 && lag < acf.length; lag++) {
    const bpm = 60 * frameRate / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const double = 2 * lag < acf.length ? acf[2 * lag] : 0;
    score[lag] = Math.max(0, acf[lag] + 0.5 * double) * prior;
  }
  const peaks = [];
  for (let lag = minLag + 1; lag <= maxLag && lag + 1 < score.length; lag++) {
    if (score[lag] <= 0 || score[lag] < score[lag - 1] || score[lag] < score[lag + 1]) continue;
    const a = score[lag - 1];
    const b = score[lag];
    const c = score[lag + 1];
    const denominator = a - 2 * b + c;
    const shift = denominator !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denominator)) : 0;
    peaks.push({ lag: lag + shift, score: b - 0.25 * (a - c) * shift });
  }
  peaks.sort((x, y) => y.score - x.score);
  const chosen = [];
  for (const peak of peaks) {
    const bpm = 60 * frameRate / peak.lag;
    if (bpm < minBpm || bpm > maxBpm) continue;
    if (chosen.some(item => Math.abs(item.bpm - bpm) / bpm < 0.03)) continue;
    chosen.push({ bpm, score: peak.score, period: peak.lag / frameRate });
    if (chosen.length >= count) break;
  }
  const total = chosen.reduce((sum, item) => sum + item.score, 0) || 1;
  return chosen.map(item => ({
    bpm: Math.round(item.bpm * 10) / 10,
    period: item.period,
    confidence: item.score / total,
    offset: beatPhase(envelope, frameRate, item.bpm),
  }));
}

// Deslocamento (s) do primeiro pulso que maximiza a energia de ataques na grade.
export function beatPhase(envelope, frameRate, bpm) {
  const period = 60 * frameRate / bpm;
  if (!(period > 1)) return 0;
  let best = -Infinity;
  let bestPhase = 0;
  const steps = Math.max(1, Math.round(period));
  for (let step = 0; step < steps; step++) {
    const phase = step * period / steps;
    let sum = 0;
    for (let position = phase; position < envelope.length; position += period) {
      const index = Math.floor(position);
      const fraction = position - index;
      const next = index + 1 < envelope.length ? envelope[index + 1] : 0;
      sum += envelope[index] * (1 - fraction) + next * fraction;
    }
    if (sum > best) { best = sum; bestPhase = phase; }
  }
  return bestPhase / frameRate;
}

export function trackBeats(envelope, frameRate, bpm, { tightness = 100 } = {}) {
  if (!(envelope instanceof Float32Array) || envelope.length < 4 || !(bpm > 0)) return [];
  const period = 60 * frameRate / bpm;
  if (!(period >= 2)) return [];
  const deviation = standardDeviation(envelope) || 1;
  // Suavização gaussiana curta deixa a pontuação local tolerante a ±period/16.
  const sigma = Math.max(1, period / 32);
  const radius = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-0.5 * ((i - radius) / sigma) ** 2));
  const local = new Float64Array(envelope.length);
  for (let i = 0; i < envelope.length; i++) {
    let sum = 0;
    for (let j = -radius; j <= radius; j++) {
      const index = i + j;
      if (index >= 0 && index < envelope.length) sum += envelope[index] * kernel[j + radius];
    }
    local[i] = sum / deviation;
  }
  const cumulative = new Float64Array(envelope.length);
  const backlink = new Int32Array(envelope.length).fill(-1);
  for (let t = 0; t < envelope.length; t++) {
    const from = Math.round(t - 2 * period);
    const to = Math.round(t - period / 2);
    let best = -Infinity;
    let link = -1;
    for (let tau = Math.max(0, from); tau <= to; tau++) {
      const penalty = -tightness * Math.log((t - tau) / period) ** 2;
      const value = cumulative[tau] + penalty;
      if (value > best) { best = value; link = tau; }
    }
    cumulative[t] = local[t] + (link >= 0 ? best : 0);
    backlink[t] = link;
  }
  let end = envelope.length - 1;
  let bestEnd = -Infinity;
  for (let t = Math.max(0, Math.floor(envelope.length - period)); t < envelope.length; t++) {
    if (cumulative[t] > bestEnd) { bestEnd = cumulative[t]; end = t; }
  }
  const beats = [];
  for (let t = end; t >= 0; t = backlink[t]) beats.push(t / frameRate);
  return beats.reverse();
}

export function pitchTrack(mono, sampleRate, { minHz = 55, maxHz = 1000, hopSeconds = 0.0232, onProgress } = {}) {
  assertMono(mono, sampleRate);
  const progress = reporter(onProgress);
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.ceil(sampleRate / minHz);
  const windowLength = 2 ** Math.ceil(Math.log2(tauMax * 2));
  const size = 2 ** Math.ceil(Math.log2(windowLength + tauMax + 1));
  const hop = Math.max(1, Math.round(sampleRate * hopSeconds));
  const fft = createFFT(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const difference = new Float64Array(tauMax + 1);
  const normalized = new Float64Array(tauMax + 1);
  const squares = new Float64Array(windowLength + tauMax + 2);
  const frameCount = Math.max(0, Math.floor((mono.length - windowLength - tauMax) / hop) + 1);
  const f0 = new Float32Array(frameCount);
  const confidence = new Float32Array(frameCount);
  const energy = new Float32Array(frameCount);
  let globalSquares = 0;
  for (const value of mono) globalSquares += value * value;
  const gate = 0.1 * Math.sqrt(globalSquares / Math.max(1, mono.length));

  for (let frame = 0; frame < frameCount; frame++) {
    if (frame % 256 === 0) progress(frame / frameCount);
    const start = frame * hop;
    const span = windowLength + tauMax;
    // Correlação cruzada r(τ) = Σ_{j<W} x_j x_{j+τ}: a parte real recebe o trecho longo,
    // a imaginária a janela curta; separamos os dois espectros e multiplicamos.
    for (let n = 0; n < size; n++) {
      re[n] = n < span ? mono[start + n] : 0;
      im[n] = n < windowLength ? mono[start + n] : 0;
    }
    squares[0] = 0;
    for (let n = 0; n < span; n++) squares[n + 1] = squares[n] + re[n] * re[n];
    const rms = Math.sqrt(squares[windowLength] / windowLength);
    energy[frame] = rms;
    if (rms < gate || rms === 0) continue;
    fft.forward(re, im);
    for (let k = 0; k <= size / 2; k++) {
      const mirror = (size - k) % size;
      const ar = (re[k] + re[mirror]) / 2;
      const ai = (im[k] - im[mirror]) / 2;
      const br = (im[k] + im[mirror]) / 2;
      const bi = (re[mirror] - re[k]) / 2;
      // A · conj(B)
      const pr = ar * br + ai * bi;
      const pi = ai * br - ar * bi;
      re[k] = pr;
      im[k] = pi;
      if (k > 0 && k < size / 2) { re[size - k] = pr; im[size - k] = -pi; }
    }
    fft.inverse(re, im);
    const e0 = squares[windowLength];
    let running = 0;
    normalized[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      const eTau = squares[tau + windowLength] - squares[tau];
      difference[tau] = Math.max(0, e0 + eTau - 2 * re[tau]);
      running += difference[tau];
      normalized[tau] = running > 0 ? difference[tau] * tau / running : 1;
    }
    let tau = -1;
    for (let candidate = tauMin; candidate <= tauMax; candidate++) {
      if (normalized[candidate] < 0.15) {
        while (candidate + 1 <= tauMax && normalized[candidate + 1] < normalized[candidate]) candidate++;
        tau = candidate;
        break;
      }
    }
    if (tau < 0) {
      let best = Infinity;
      for (let candidate = tauMin; candidate <= tauMax; candidate++) {
        if (normalized[candidate] < best) { best = normalized[candidate]; tau = candidate; }
      }
    }
    let refined = tau;
    if (tau > tauMin && tau < tauMax) {
      const a = normalized[tau - 1];
      const b = normalized[tau];
      const c = normalized[tau + 1];
      const denominator = a - 2 * b + c;
      if (denominator > 0) refined = tau + 0.5 * (a - c) / denominator;
    }
    f0[frame] = sampleRate / refined;
    confidence[frame] = Math.max(0, Math.min(1, 1 - normalized[tau]));
  }
  progress(1);
  return { f0, confidence, energy, frameRate: sampleRate / hop, offset: windowLength / 2 / sampleRate };
}

export function segmentNotes(track, { minConfidence = 0.75, minDuration = 0.07 } = {}) {
  const { f0, confidence, frameRate, offset = 0 } = track;
  const midi = new Float64Array(f0.length).fill(NaN);
  for (let i = 0; i < f0.length; i++) {
    if (f0[i] > 0 && confidence[i] >= minConfidence) midi[i] = 69 + 12 * Math.log2(f0[i] / 440);
  }
  // Mediana de 5 quadros remove saltos isolados de oitava.
  const smoothed = new Float64Array(midi.length).fill(NaN);
  for (let i = 0; i < midi.length; i++) {
    if (Number.isNaN(midi[i])) continue;
    const window = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(midi.length - 1, i + 2); j++) if (!Number.isNaN(midi[j])) window.push(midi[j]);
    window.sort((a, b) => a - b);
    smoothed[i] = window[Math.floor(window.length / 2)];
  }
  const notes = [];
  let start = -1;
  const close = end => {
    if (start < 0) return;
    const values = [];
    let confidenceSum = 0;
    for (let i = start; i < end; i++) { values.push(smoothed[i]); confidenceSum += confidence[i]; }
    values.sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    const rounded = Math.round(median);
    const stable = values.filter(value => Math.abs(value - rounded) <= 0.5).length / values.length;
    const duration = (end - start) / frameRate;
    if (duration >= minDuration) {
      notes.push({
        start: start / frameRate + offset,
        end: end / frameRate + offset,
        midi: rounded,
        cents: Math.round((median - rounded) * 100),
        confidence: Math.round(confidenceSum / (end - start) * stable * 1000) / 1000,
      });
    }
    start = -1;
  };
  for (let i = 0; i < smoothed.length; i++) {
    if (Number.isNaN(smoothed[i])) { close(i); continue; }
    if (start < 0) { start = i; continue; }
    if (Math.abs(smoothed[i] - Math.round(smoothed[start])) > 0.6 && Math.abs(smoothed[i] - smoothed[i - 1]) > 0.4) {
      close(i);
      start = i;
    }
  }
  close(smoothed.length);
  return notes;
}

export function chromagram(mono, sampleRate, { minHz = 55, maxHz = 2100, onProgress } = {}) {
  assertMono(mono, sampleRate);
  const progress = reporter(onProgress);
  const size = 2 ** Math.max(9, Math.round(Math.log2(sampleRate * 0.37)));
  const hop = size / 4;
  const fft = createFFT(size);
  const window = hannWindow(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const mapping = [];
  for (let k = 1; k <= size / 2; k++) {
    const frequency = k * sampleRate / size;
    if (frequency < minHz || frequency > maxHz) continue;
    const midi = 69 + 12 * Math.log2(frequency / 440);
    const nearest = Math.round(midi);
    const weight = Math.max(0, 1 - 2 * Math.abs(midi - nearest));
    if (weight > 0) mapping.push({ bin: k, pitchClass: ((nearest % 12) + 12) % 12, weight });
  }
  const frameCount = Math.max(1, Math.ceil(mono.length / hop));
  const frames = new Float32Array(frameCount * 12);
  const energy = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * hop - size / 2;
    for (let n = 0; n < size; n++) {
      const index = start + n;
      re[n] = index >= 0 && index < mono.length ? mono[index] * window[n] : 0;
      im[n] = 0;
    }
    fft.forward(re, im);
    let total = 0;
    for (const { bin, pitchClass, weight } of mapping) {
      const value = Math.sqrt(Math.hypot(re[bin], im[bin])) * weight;
      frames[frame * 12 + pitchClass] += value;
      total += value;
    }
    energy[frame] = total;
    if (frame % 128 === 0) progress(frame / frameCount);
  }
  progress(1);
  return { frames, energy, frameRate: sampleRate / hop, frameCount };
}

function chordTemplates() {
  const templates = [];
  for (let root = 0; root < 12; root++) {
    for (const quality of CHORD_QUALITIES) {
      const vector = new Float64Array(12);
      quality.intervals.forEach((interval, index) => { vector[(root + interval) % 12] = index === 0 ? 1.2 : index === 3 ? 0.8 : 1; });
      let norm = 0;
      for (const value of vector) norm += value * value;
      norm = Math.sqrt(norm);
      for (let i = 0; i < 12; i++) vector[i] /= norm;
      templates.push({ root, quality: quality.id, label: chordLabel(root, quality.id), vector });
    }
  }
  return templates;
}

export function chordHypotheses(chroma, { switchPenalty = 3, sharpness = 12, minDuration = 0.35 } = {}) {
  const { frames, energy, frameRate, frameCount } = chroma;
  if (!frameCount) return [];
  const templates = chordTemplates();
  const states = templates.length + 1; // último estado = sem acorde
  const sortedEnergy = Array.from(energy).sort((a, b) => a - b);
  const loud = sortedEnergy[Math.floor(sortedEnergy.length * 0.95)] || 1;
  const similarity = new Float32Array(frameCount * states);
  for (let frame = 0; frame < frameCount; frame++) {
    let norm = 0;
    for (let i = 0; i < 12; i++) norm += frames[frame * 12 + i] ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let s = 0; s < templates.length; s++) {
      let dot = 0;
      for (let i = 0; i < 12; i++) dot += (frames[frame * 12 + i] / norm) * templates[s].vector[i];
      similarity[frame * states + s] = dot;
    }
    similarity[frame * states + templates.length] = energy[frame] < loud * 0.05 ? 1 : 0.55;
  }
  // Viterbi com penalidade fixa de troca: segmentos estáveis, sem tremulação.
  const score = new Float64Array(states);
  const next = new Float64Array(states);
  const back = new Uint8Array(frameCount * states);
  for (let s = 0; s < states; s++) score[s] = sharpness * similarity[s];
  for (let frame = 1; frame < frameCount; frame++) {
    let best = 0;
    for (let s = 1; s < states; s++) if (score[s] > score[best]) best = s;
    for (let s = 0; s < states; s++) {
      const stay = score[s];
      const move = score[best] - switchPenalty;
      if (stay >= move) { next[s] = stay; back[frame * states + s] = s; } else { next[s] = move; back[frame * states + s] = best; }
      next[s] += sharpness * similarity[frame * states + s];
    }
    score.set(next);
  }
  const path = new Uint8Array(frameCount);
  let state = 0;
  for (let s = 1; s < states; s++) if (score[s] > score[state]) state = s;
  for (let frame = frameCount - 1; frame >= 0; frame--) {
    path[frame] = state;
    state = back[frame * states + state];
  }
  const segments = [];
  let start = 0;
  for (let frame = 1; frame <= frameCount; frame++) {
    if (frame < frameCount && path[frame] === path[start]) continue;
    segments.push({ startFrame: start, endFrame: frame, state: path[start] });
    start = frame;
  }
  // Funde segmentos curtos ao vizinho anterior (ou seguinte, se for o primeiro).
  const merged = [];
  for (const segment of segments) {
    const duration = (segment.endFrame - segment.startFrame) / frameRate;
    if (duration < minDuration && merged.length) merged[merged.length - 1].endFrame = segment.endFrame;
    else if (duration < minDuration && !merged.length) merged.push({ ...segment });
    else if (merged.length && merged[merged.length - 1].state === segment.state) merged[merged.length - 1].endFrame = segment.endFrame;
    else merged.push({ ...segment });
  }
  if (merged.length > 1 && (merged[0].endFrame - merged[0].startFrame) / frameRate < minDuration) {
    merged[1].startFrame = merged[0].startFrame;
    merged.shift();
  }
  return merged.map(segment => {
    const averages = new Float64Array(states);
    for (let frame = segment.startFrame; frame < segment.endFrame; frame++) {
      for (let s = 0; s < states; s++) averages[s] += similarity[frame * states + s];
    }
    const length = segment.endFrame - segment.startFrame;
    const ranked = Array.from(averages, (value, s) => ({ s, value: value / length })).sort((a, b) => b.value - a.value);
    const exps = ranked.map(item => Math.exp(sharpness * (item.value - ranked[0].value)));
    const total = exps.reduce((sum, value) => sum + value, 0);
    const describe = s => s === templates.length
      ? { label: NO_CHORD, root: null, quality: NO_CHORD }
      : { label: templates[s].label, root: templates[s].root, quality: templates[s].quality };
    const chosen = describe(segment.state);
    const chosenIndex = ranked.findIndex(item => item.s === segment.state);
    return {
      start: segment.startFrame / frameRate,
      end: segment.endFrame / frameRate,
      ...chosen,
      confidence: Math.round(exps[chosenIndex] / total * 1000) / 1000,
      alternatives: ranked.slice(0, 4).map((item, index) => ({ ...describe(item.s), probability: Math.round(exps[index] / total * 1000) / 1000 })),
    };
  });
}

function pearson(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let numerator = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    numerator += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? numerator / Math.sqrt(da * db) : 0;
}

export function estimateKey(chroma, { count = 3 } = {}) {
  const profile = new Float64Array(12);
  for (let frame = 0; frame < chroma.frameCount; frame++) {
    for (let i = 0; i < 12; i++) profile[i] += chroma.frames[frame * 12 + i];
  }
  const keys = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, template] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]]) {
      const rotated = Array.from({ length: 12 }, (_, i) => template[(i - tonic + 12) % 12]);
      keys.push({ tonic, mode, label: `${PITCH_NAMES[tonic]} ${mode === 'major' ? 'maior' : 'menor'}`, score: pearson(profile, rotated) });
    }
  }
  return keys.sort((a, b) => b.score - a.score).slice(0, count).map(key => ({ ...key, score: Math.round(key.score * 1000) / 1000 }));
}

// Análise completa. `stages` limita o trabalho (ex.: só 'rhythm' para comparar takes).
export function analyzeAudio(input, sampleRate, { offset = 0, sensitivity = 0.5, stages = ['rhythm', 'pitch', 'harmony'], onProgress } = {}) {
  assertMono(input, sampleRate);
  const progress = reporter(onProgress);
  let mono = input;
  let rate = sampleRate;
  const warnings = [];
  if (sampleRate > ANALYSIS_SAMPLE_RATE * 1.5) {
    [mono] = resample([input], sampleRate / ANALYSIS_SAMPLE_RATE, { onProgress: value => progress({ stage: 'Reamostrando', fraction: value * 0.1 }) });
    rate = sampleRate / (sampleRate / ANALYSIS_SAMPLE_RATE);
  }
  const duration = mono.length / rate;
  if (duration < 1) warnings.push('Trecho com menos de 1 s: as estimativas de andamento e acordes são pouco confiáveis.');
  const result = { version: ANALYSIS_VERSION, offset, duration, sampleRate: rate, sensitivity, warnings };
  const span = (from, to, stage) => value => progress({ stage, fraction: from + (to - from) * value });

  if (stages.includes('rhythm')) {
    const { envelope, frameRate } = onsetEnvelope(mono, rate, { onProgress: span(0.1, 0.25, 'Ataques') });
    result.envelope = envelope;
    result.envelopeRate = frameRate;
    result.onsets = pickOnsets(envelope, frameRate, { sensitivity });
    progress({ stage: 'Andamento', fraction: 0.27 });
    result.tempo = tempoCandidates(envelope, frameRate);
    progress({ stage: 'Pulsos', fraction: 0.3 });
    result.beats = result.tempo.length ? trackBeats(envelope, frameRate, result.tempo[0].bpm) : [];
    if (!result.tempo.length) warnings.push('Nenhuma periodicidade clara de ataques foi encontrada.');
  }
  if (stages.includes('pitch')) {
    const track = pitchTrack(mono, rate, { onProgress: span(0.32, 0.72, 'Altura') });
    result.pitch = { frameRate: track.frameRate, offset: track.offset, f0: track.f0, confidence: track.confidence };
    result.notes = segmentNotes(track, { minConfidence: 0.6 });
  }
  if (stages.includes('harmony')) {
    const chroma = chromagram(mono, rate, { onProgress: span(0.72, 0.95, 'Acordes') });
    result.chords = chordHypotheses(chroma);
    result.key = estimateKey(chroma);
  }
  progress({ stage: 'Concluído', fraction: 1 });
  return result;
}
