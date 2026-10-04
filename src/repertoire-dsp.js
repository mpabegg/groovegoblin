// DSP local para o laboratório de repertório (sem dependências, sem rede).
//
// - createFFT: FFT complexa radix-2 iterativa; pares de canais reais compartilham
//   uma única transformada complexa (truque do empacotamento real/imaginário).
// - phaseVocoderStretch: vocoder de fase com travamento de fase por identidade
//   (Laroche & Dolson, 1999). A fase sintética é calculada na soma mono e cada
//   canal mantém sua diferença de fase em relação a ela, preservando a imagem
//   estéreo. Quadros com ataque forte reiniciam a fase para não borrar transientes.
// - wsolaStretch: WSOLA (Verhelst & Roelands, 1993), busca do deslocamento que
//   maximiza a correlação com a continuação natural do quadro anterior.
// - resample: interpolação sinc janelada (Blackman) com filtro anti-aliasing.
// - changeSpeedAndPitch: velocidade e transposição independentes. Esticar por
//   S = P / velocidade e reamostrar por P resulta em duração / velocidade e
//   altura multiplicada por P, sem acoplar uma à outra.
// - separateHarmonicPercussive: HPSS por filtros de mediana sobre o espectrograma
//   (Fitzgerald, 2010) com máscaras suaves, em fluxo (memória limitada ao
//   comprimento do filtro). Produz estimativas harmônica/percussiva, NÃO stems de
//   voz, baixo ou instrumentos.

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 1.5;
export const SEMITONE_LIMIT = 12;
export const CENTS_LIMIT = 50;
export const STRETCH_ALGORITHMS = Object.freeze(['vocoder', 'wsola']);

const TWO_PI = Math.PI * 2;
const PROGRESS_EVERY = 64;

function assertChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0
      || !channels.every(channel => channel instanceof Float32Array)) {
    throw new TypeError('Os canais de áudio devem ser uma lista não vazia de Float32Array.');
  }
  const length = channels[0].length;
  if (!channels.every(channel => channel.length === length)) {
    throw new RangeError('Todos os canais devem ter o mesmo número de amostras.');
  }
  return length;
}

function assertSampleRate(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate < 3000 || sampleRate > 768000) {
    throw new RangeError('A taxa de amostragem deve estar entre 3000 e 768000 Hz.');
  }
}

function reporter(onProgress) {
  return typeof onProgress === 'function' ? onProgress : () => {};
}

function wrapPhase(value) {
  return value - TWO_PI * Math.round(value / TWO_PI);
}

export function createFFT(size) {
  if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
    throw new RangeError('O tamanho da FFT deve ser uma potência de 2.');
  }
  const levels = Math.log2(size);
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let value = i;
    let reversed = 0;
    for (let bit = 0; bit < levels; bit++) {
      reversed = (reversed << 1) | (value & 1);
      value >>= 1;
    }
    reverse[i] = reversed;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos(TWO_PI * i / size);
    sin[i] = Math.sin(TWO_PI * i / size);
  }

  function transform(re, im, inverse) {
    for (let i = 0; i < size; i++) {
      const j = reverse[i];
      if (j > i) {
        let swap = re[i]; re[i] = re[j]; re[j] = swap;
        swap = im[i]; im[i] = im[j]; im[j] = swap;
      }
    }
    for (let length = 2; length <= size; length <<= 1) {
      const half = length >> 1;
      const step = size / length;
      for (let start = 0; start < size; start += length) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k];
          const wi = inverse ? sin[k] : -sin[k];
          const a = start + j;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < size; i++) {
        re[i] /= size;
        im[i] /= size;
      }
    }
  }

  return {
    size,
    forward: (re, im) => transform(re, im, false),
    inverse: (re, im) => transform(re, im, true),
  };
}

// Janela de Hann periódica: somas com sobreposição de 50%/75% são constantes.
export function hannWindow(size) {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / size);
  return window;
}

// ~46 ms em qualquer taxa: 2048 em 44,1/48 kHz, 1024 em 22,05 kHz, 512 em 11,025 kHz.
export function frameSizeFor(sampleRate, seconds = 0.046) {
  assertSampleRate(sampleRate);
  return 2 ** Math.max(8, Math.round(Math.log2(sampleRate * seconds)));
}

export function pitchRatio(semitones = 0, cents = 0) {
  if (!Number.isFinite(semitones) || !Number.isFinite(cents)) {
    throw new RangeError('A transposição deve ser numérica.');
  }
  return 2 ** ((semitones + cents / 100) / 12);
}

export function validateProcessing({ speed = 1, semitones = 0, cents = 0, algorithm = 'vocoder' } = {}) {
  if (!Number.isFinite(speed) || speed < SPEED_MIN || speed > SPEED_MAX) {
    return `A velocidade deve ficar entre ${Math.round(SPEED_MIN * 100)}% e ${Math.round(SPEED_MAX * 100)}%.`;
  }
  if (!Number.isFinite(semitones) || Math.abs(semitones) > SEMITONE_LIMIT || !Number.isInteger(semitones)) {
    return `A transposição deve ser um número inteiro de semitons entre -${SEMITONE_LIMIT} e +${SEMITONE_LIMIT}.`;
  }
  if (!Number.isFinite(cents) || Math.abs(cents) > CENTS_LIMIT) {
    return `O ajuste fino deve ficar entre -${CENTS_LIMIT} e +${CENTS_LIMIT} cents.`;
  }
  if (!STRETCH_ALGORITHMS.includes(algorithm)) return 'Algoritmo de alongamento desconhecido.';
  return null;
}

export function isIdentityProcessing({ speed = 1, semitones = 0, cents = 0 } = {}) {
  return Math.abs(speed - 1) < 1e-9 && semitones === 0 && Math.abs(cents) < 1e-9;
}

export function mixToMono(channels) {
  const length = assertChannels(channels);
  if (channels.length === 1) return channels[0].slice();
  const mono = new Float32Array(length);
  const scale = 1 / channels.length;
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] += channel[i] * scale;
  }
  return mono;
}

function readFrame(channel, start, window, target) {
  const size = window.length;
  const length = channel.length;
  for (let n = 0; n < size; n++) {
    const index = start + n;
    target[n] = index >= 0 && index < length ? channel[index] * window[n] : 0;
  }
}

// Transforma dois canais reais (ou um) com uma FFT complexa e separa os espectros.
function forwardPair(fft, a, b, scratchRe, scratchIm, outA, outB) {
  const size = fft.size;
  for (let n = 0; n < size; n++) {
    scratchRe[n] = a[n];
    scratchIm[n] = b ? b[n] : 0;
  }
  fft.forward(scratchRe, scratchIm);
  const half = size / 2;
  for (let k = 0; k <= half; k++) {
    const mirror = (size - k) % size;
    const zr = scratchRe[k];
    const zi = scratchIm[k];
    const mr = scratchRe[mirror];
    const mi = scratchIm[mirror];
    // A = (Z[k] + conj(Z[N-k])) / 2 ; B = (Z[k] - conj(Z[N-k])) / 2i
    outA.re[k] = (zr + mr) / 2;
    outA.im[k] = (zi - mi) / 2;
    if (outB) {
      outB.re[k] = (zi + mi) / 2;
      outB.im[k] = (mr - zr) / 2;
    }
  }
}

// Inverso de dois espectros hermitianos (bins 0..N/2) com uma IFFT complexa.
function inversePair(fft, specA, specB, scratchRe, scratchIm) {
  const size = fft.size;
  const half = size / 2;
  for (let k = 0; k <= half; k++) {
    const ar = specA.re[k];
    const ai = specA.im[k];
    const br = specB ? specB.re[k] : 0;
    const bi = specB ? specB.im[k] : 0;
    // Y[k] = A[k] + i B[k]
    scratchRe[k] = ar - bi;
    scratchIm[k] = ai + br;
    if (k > 0 && k < half) {
      // Y[N-k] = conj(A[k]) + i conj(B[k])
      scratchRe[size - k] = ar + bi;
      scratchIm[size - k] = -ai + br;
    }
  }
  fft.inverse(scratchRe, scratchIm);
}

function spectrum(bins) {
  return { re: new Float64Array(bins), im: new Float64Array(bins) };
}

function finishOverlapAdd(outputs, norm, floor) {
  for (const output of outputs) {
    for (let i = 0; i < output.length; i++) output[i] /= Math.max(norm[i], floor);
  }
  return outputs;
}

export function phaseVocoderStretch(channels, factor, { sampleRate = 44100, onProgress } = {}) {
  const length = assertChannels(channels);
  assertSampleRate(sampleRate);
  if (!Number.isFinite(factor) || factor < 0.1 || factor > 10) {
    throw new RangeError('O fator de alongamento deve ficar entre 0,1 e 10.');
  }
  const progress = reporter(onProgress);
  if (Math.abs(factor - 1) < 1e-9 || length === 0) {
    progress(1);
    return channels.map(channel => channel.slice());
  }

  const size = frameSizeFor(sampleRate);
  const half = size / 2;
  const bins = half + 1;
  const synthesisHop = size / 4;
  const analysisHop = synthesisHop / factor;
  const outLength = Math.max(1, Math.round(length * factor));
  const frameCount = Math.floor((outLength + half) / synthesisHop) + 1;
  const window = hannWindow(size);
  const fft = createFFT(size);
  const channelCount = channels.length;

  const outputs = channels.map(() => new Float32Array(outLength));
  const norm = new Float32Array(outLength);
  const frameA = new Float64Array(size);
  const frameB = new Float64Array(size);
  const scratchRe = new Float64Array(size);
  const scratchIm = new Float64Array(size);
  const spectra = channels.map(() => spectrum(bins));
  const synthSpectra = channels.map(() => spectrum(bins));
  const monoRe = new Float64Array(bins);
  const monoIm = new Float64Array(bins);
  const magnitude = new Float64Array(bins);
  const phase = new Float64Array(bins);
  const previousPhase = new Float64Array(bins);
  const previousMagnitude = new Float64Array(bins);
  const synthPhase = new Float64Array(bins);
  const peaks = new Int32Array(bins);
  const owner = new Int32Array(bins);

  let previousStart = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const analysisStart = Math.round(frame * analysisHop) - half;
    const hop = frame === 0 ? analysisHop : analysisStart - previousStart;

    for (let c = 0; c < channelCount; c += 2) {
      readFrame(channels[c], analysisStart, window, frameA);
      const paired = c + 1 < channelCount;
      if (paired) readFrame(channels[c + 1], analysisStart, window, frameB);
      forwardPair(fft, frameA, paired ? frameB : null, scratchRe, scratchIm, spectra[c], paired ? spectra[c + 1] : null);
    }
    monoRe.fill(0);
    monoIm.fill(0);
    for (const spec of spectra) {
      for (let k = 0; k < bins; k++) {
        monoRe[k] += spec.re[k] / channelCount;
        monoIm[k] += spec.im[k] / channelCount;
      }
    }
    let total = 0;
    let rise = 0;
    for (let k = 0; k < bins; k++) {
      magnitude[k] = Math.hypot(monoRe[k], monoIm[k]);
      phase[k] = Math.atan2(monoIm[k], monoRe[k]);
      total += magnitude[k];
      rise += Math.max(0, magnitude[k] - previousMagnitude[k]);
    }

    // Ataque: mais da metade da energia espectral é nova -> reinicia a fase.
    const transient = frame > 0 && total > 1e-9 && rise / total > 0.5;
    if (frame === 0 || transient || hop <= 0) {
      synthPhase.set(phase);
    } else {
      let peakCount = 0;
      for (let k = 2; k < bins - 2; k++) {
        const value = magnitude[k];
        if (value > magnitude[k - 1] && value >= magnitude[k + 1]
            && value > magnitude[k - 2] && value >= magnitude[k + 2]) {
          peaks[peakCount++] = k;
        }
      }
      if (peakCount === 0) {
        for (let k = 0; k < bins; k++) {
          const omega = TWO_PI * k / size;
          const deviation = wrapPhase(phase[k] - previousPhase[k] - omega * hop);
          synthPhase[k] += (omega + deviation / hop) * synthesisHop;
        }
      } else {
        // Cada bin pertence ao pico mais próximo (fronteira no ponto médio).
        let current = 0;
        for (let k = 0; k < bins; k++) {
          while (current + 1 < peakCount && Math.abs(peaks[current + 1] - k) <= Math.abs(peaks[current] - k)) current++;
          owner[k] = peaks[current];
        }
        for (let p = 0; p < peakCount; p++) {
          const k = peaks[p];
          const omega = TWO_PI * k / size;
          const deviation = wrapPhase(phase[k] - previousPhase[k] - omega * hop);
          synthPhase[k] += (omega + deviation / hop) * synthesisHop;
        }
        for (let k = 0; k < bins; k++) {
          const peak = owner[k];
          if (peak !== k) synthPhase[k] = synthPhase[peak] + (phase[k] - phase[peak]);
        }
      }
    }
    previousPhase.set(phase);
    previousMagnitude.set(magnitude);
    previousStart = analysisStart;

    for (let c = 0; c < channelCount; c++) {
      const source = spectra[c];
      const target = synthSpectra[c];
      for (let k = 0; k < bins; k++) {
        const re = source.re[k];
        const im = source.im[k];
        const mag = Math.hypot(re, im);
        const outPhase = channelCount === 1 ? synthPhase[k] : synthPhase[k] + (Math.atan2(im, re) - phase[k]);
        target.re[k] = mag * Math.cos(outPhase);
        target.im[k] = mag * Math.sin(outPhase);
      }
      target.im[0] = 0;
      target.im[half] = 0;
    }

    const synthesisStart = frame * synthesisHop - half;
    for (let c = 0; c < channelCount; c += 2) {
      const paired = c + 1 < channelCount;
      inversePair(fft, synthSpectra[c], paired ? synthSpectra[c + 1] : null, scratchRe, scratchIm);
      const outA = outputs[c];
      const outB = paired ? outputs[c + 1] : null;
      for (let n = 0; n < size; n++) {
        const index = synthesisStart + n;
        if (index < 0 || index >= outLength) continue;
        outA[index] += scratchRe[n] * window[n];
        if (outB) outB[index] += scratchIm[n] * window[n];
      }
    }
    for (let n = 0; n < size; n++) {
      const index = synthesisStart + n;
      if (index >= 0 && index < outLength) norm[index] += window[n] * window[n];
    }
    if (frame % PROGRESS_EVERY === 0) progress(frame / frameCount);
  }
  progress(1);
  return finishOverlapAdd(outputs, norm, 0.5);
}

function correlation(mono, reference, candidate, size, stride) {
  let dot = 0;
  let energy = 0;
  const length = mono.length;
  for (let n = 0; n < size; n += stride) {
    const a = reference + n < length ? mono[reference + n] : 0;
    const b = candidate + n < length ? mono[candidate + n] : 0;
    dot += a * b;
    energy += b * b;
  }
  return dot / Math.sqrt(energy + 1e-12);
}

export function wsolaStretch(channels, factor, { sampleRate = 44100, onProgress } = {}) {
  const length = assertChannels(channels);
  assertSampleRate(sampleRate);
  if (!Number.isFinite(factor) || factor < 0.1 || factor > 10) {
    throw new RangeError('O fator de alongamento deve ficar entre 0,1 e 10.');
  }
  const progress = reporter(onProgress);
  if (Math.abs(factor - 1) < 1e-9 || length === 0) {
    progress(1);
    return channels.map(channel => channel.slice());
  }
  const size = 2 * Math.round(sampleRate * 0.02); // quadros de ~40 ms
  const hop = size / 2;
  const tolerance = Math.round(sampleRate * 0.012);
  const window = hannWindow(size);
  const mono = mixToMono(channels);
  const outLength = Math.max(1, Math.round(length * factor));
  const outputs = channels.map(() => new Float32Array(outLength));
  const norm = new Float32Array(outLength);
  const frameCount = Math.ceil(outLength / hop) + 1;
  const lastStart = Math.max(0, length - 1);

  let previous = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const outputStart = frame * hop;
    const nominal = Math.round(outputStart / factor);
    let position = Math.min(nominal, lastStart);
    if (frame > 0) {
      const natural = previous + hop;
      const low = Math.max(0, nominal - tolerance);
      const high = Math.min(lastStart, nominal + tolerance);
      let best = -Infinity;
      for (let candidate = low; candidate <= high; candidate += 4) {
        const score = correlation(mono, natural, candidate, size, 4);
        if (score > best) { best = score; position = candidate; }
      }
      const coarse = position;
      for (let candidate = Math.max(low, coarse - 3); candidate <= Math.min(high, coarse + 3); candidate++) {
        const score = correlation(mono, natural, candidate, size, 2);
        if (score > best) { best = score; position = candidate; }
      }
    }
    for (let c = 0; c < channels.length; c++) {
      const input = channels[c];
      const output = outputs[c];
      for (let n = 0; n < size; n++) {
        const outIndex = outputStart + n;
        if (outIndex >= outLength) break;
        const inIndex = position + n;
        if (inIndex < length) output[outIndex] += input[inIndex] * window[n];
      }
    }
    for (let n = 0; n < size && outputStart + n < outLength; n++) norm[outputStart + n] += window[n];
    previous = position;
    if (frame % PROGRESS_EVERY === 0) progress(frame / frameCount);
  }
  progress(1);
  return finishOverlapAdd(outputs, norm, 1e-4);
}

const SINC_ZEROS = 12;
const SINC_RESOLUTION = 256;
let sincTable = null;

function windowedSinc() {
  if (sincTable) return sincTable;
  const count = SINC_ZEROS * SINC_RESOLUTION + 2;
  sincTable = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const x = i / SINC_RESOLUTION;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const ratio = Math.min(1, x / SINC_ZEROS);
    const blackman = 0.42 + 0.5 * Math.cos(Math.PI * ratio) + 0.08 * Math.cos(2 * Math.PI * ratio);
    sincTable[i] = sinc * blackman;
  }
  return sincTable;
}

// ratio = amostras de entrada consumidas por amostra de saída (>1 encurta e sobe a altura).
export function resample(channels, ratio, { onProgress } = {}) {
  const length = assertChannels(channels);
  if (!Number.isFinite(ratio) || ratio <= 0.05 || ratio > 20) {
    throw new RangeError('A razão de reamostragem deve ficar entre 0,05 e 20.');
  }
  const progress = reporter(onProgress);
  if (Math.abs(ratio - 1) < 1e-12 || length === 0) {
    progress(1);
    return channels.map(channel => channel.slice());
  }
  const table = windowedSinc();
  const cutoff = Math.min(1, 1 / ratio);
  const reach = SINC_ZEROS / cutoff;
  const outLength = Math.max(1, Math.round(length / ratio));
  const outputs = channels.map(() => new Float32Array(outLength));
  const chunk = 65536;
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio;
    const first = Math.max(0, Math.ceil(position - reach));
    const last = Math.min(length - 1, Math.floor(position + reach));
    for (let c = 0; c < channels.length; c++) {
      const input = channels[c];
      let sum = 0;
      for (let j = first; j <= last; j++) {
        const x = Math.abs(position - j) * cutoff * SINC_RESOLUTION;
        const index = Math.floor(x);
        if (index >= table.length - 1) continue;
        const fraction = x - index;
        sum += input[j] * (table[index] + (table[index + 1] - table[index]) * fraction);
      }
      outputs[c][i] = sum * cutoff;
    }
    if (i % chunk === 0) progress(i / outLength);
  }
  progress(1);
  return outputs;
}

export function changeSpeedAndPitch(channels, { sampleRate = 44100, speed = 1, semitones = 0, cents = 0, algorithm = 'vocoder', onProgress } = {}) {
  assertChannels(channels);
  const problem = validateProcessing({ speed, semitones, cents, algorithm });
  if (problem) throw new RangeError(problem);
  const progress = reporter(onProgress);
  if (isIdentityProcessing({ speed, semitones, cents })) {
    progress(1);
    return channels.map(channel => channel.slice());
  }
  const ratio = pitchRatio(semitones, cents);
  const factor = ratio / speed;
  const stretch = algorithm === 'wsola' ? wsolaStretch : phaseVocoderStretch;
  const resampleShare = Math.abs(ratio - 1) < 1e-12 ? 0 : 0.2;
  const stretched = stretch(channels, factor, { sampleRate, onProgress: value => progress(value * (1 - resampleShare)) });
  if (!resampleShare) {
    progress(1);
    return stretched;
  }
  return resample(stretched, ratio, { onProgress: value => progress(1 - resampleShare + value * resampleShare) });
}

function insertionMedian(values, count) {
  for (let i = 1; i < count; i++) {
    const value = values[i];
    let j = i - 1;
    while (j >= 0 && values[j] > value) {
      values[j + 1] = values[j];
      j--;
    }
    values[j + 1] = value;
  }
  return count % 2 ? values[(count - 1) / 2] : (values[count / 2 - 1] + values[count / 2]) / 2;
}

export function separateHarmonicPercussive(channels, { sampleRate = 44100, harmonicKernel = 17, percussiveKernel = 17, power = 2, onProgress } = {}) {
  const length = assertChannels(channels);
  assertSampleRate(sampleRate);
  for (const kernel of [harmonicKernel, percussiveKernel]) {
    if (!Number.isInteger(kernel) || kernel < 3 || kernel > 63 || kernel % 2 === 0) {
      throw new RangeError('Os filtros de mediana devem ter tamanho ímpar entre 3 e 63.');
    }
  }
  const progress = reporter(onProgress);
  const size = frameSizeFor(sampleRate);
  const half = size / 2;
  const bins = half + 1;
  const hop = size / 4;
  const window = hannWindow(size);
  const fft = createFFT(size);
  const channelCount = channels.length;
  const frameCount = Math.floor((length + half) / hop) + 1;
  const reach = (harmonicKernel - 1) / 2;
  const percussiveReach = (percussiveKernel - 1) / 2;
  const ring = Array.from({ length: harmonicKernel }, () => ({
    magnitude: new Float32Array(bins),
    spectra: channels.map(() => spectrum(bins)),
  }));
  const harmonic = channels.map(() => new Float32Array(length));
  const percussive = channels.map(() => new Float32Array(length));
  const norm = new Float32Array(length);
  const frameA = new Float64Array(size);
  const frameB = new Float64Array(size);
  const scratchRe = new Float64Array(size);
  const scratchIm = new Float64Array(size);
  const harmonicSpectrum = spectrum(bins);
  const percussiveSpectrum = spectrum(bins);
  const values = new Float64Array(Math.max(harmonicKernel, percussiveKernel));
  const mask = new Float64Array(bins);
  const harmonicMedian = new Float64Array(bins);

  for (let step = 0; step < frameCount + reach; step++) {
    if (step < frameCount) {
      const slot = ring[step % harmonicKernel];
      const start = step * hop - half;
      for (let c = 0; c < channelCount; c += 2) {
        readFrame(channels[c], start, window, frameA);
        const paired = c + 1 < channelCount;
        if (paired) readFrame(channels[c + 1], start, window, frameB);
        forwardPair(fft, frameA, paired ? frameB : null, scratchRe, scratchIm, slot.spectra[c], paired ? slot.spectra[c + 1] : null);
      }
      for (let k = 0; k < bins; k++) {
        let re = 0;
        let im = 0;
        for (const spec of slot.spectra) { re += spec.re[k]; im += spec.im[k]; }
        slot.magnitude[k] = Math.hypot(re, im) / channelCount;
      }
    }
    const frame = step - reach;
    if (frame < 0) continue;
    const first = Math.max(0, frame - reach);
    const last = Math.min(frameCount - 1, frame + reach);
    for (let k = 0; k < bins; k++) {
      let count = 0;
      for (let f = first; f <= last; f++) values[count++] = ring[f % harmonicKernel].magnitude[k];
      harmonicMedian[k] = insertionMedian(values, count);
    }
    const current = ring[frame % harmonicKernel];
    for (let k = 0; k < bins; k++) {
      let count = 0;
      for (let j = Math.max(0, k - percussiveReach); j <= Math.min(bins - 1, k + percussiveReach); j++) values[count++] = current.magnitude[j];
      const p = insertionMedian(values, count) ** power;
      const h = harmonicMedian[k] ** power;
      mask[k] = h + p > 1e-20 ? h / (h + p) : 0.5;
    }
    const start = frame * hop - half;
    for (let c = 0; c < channelCount; c++) {
      const source = current.spectra[c];
      for (let k = 0; k < bins; k++) {
        harmonicSpectrum.re[k] = source.re[k] * mask[k];
        harmonicSpectrum.im[k] = source.im[k] * mask[k];
        percussiveSpectrum.re[k] = source.re[k] * (1 - mask[k]);
        percussiveSpectrum.im[k] = source.im[k] * (1 - mask[k]);
      }
      inversePair(fft, harmonicSpectrum, percussiveSpectrum, scratchRe, scratchIm);
      const outH = harmonic[c];
      const outP = percussive[c];
      for (let n = 0; n < size; n++) {
        const index = start + n;
        if (index < 0 || index >= length) continue;
        outH[index] += scratchRe[n] * window[n];
        outP[index] += scratchIm[n] * window[n];
      }
    }
    for (let n = 0; n < size; n++) {
      const index = start + n;
      if (index >= 0 && index < length) norm[index] += window[n] * window[n];
    }
    if (frame % PROGRESS_EVERY === 0) progress(frame / frameCount);
  }
  finishOverlapAdd(harmonic, norm, 0.5);
  finishOverlapAdd(percussive, norm, 0.5);
  progress(1);
  return { harmonic, percussive };
}

// Pares (mínimo, máximo) por balde, combinando todos os canais.
export function computePeaks(channels, start, end, buckets) {
  const length = assertChannels(channels);
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(length, Math.ceil(end));
  const count = Math.max(1, Math.floor(buckets));
  const peaks = new Float32Array(count * 2);
  const span = Math.max(0, to - from) / count;
  for (let b = 0; b < count; b++) {
    const first = from + Math.floor(b * span);
    const last = Math.max(first + 1, Math.min(to, from + Math.floor((b + 1) * span)));
    let min = 0;
    let max = 0;
    for (const channel of channels) {
      for (let i = first; i < last && i < length; i++) {
        const value = channel[i];
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    peaks[b * 2] = min;
    peaks[b * 2 + 1] = max;
  }
  return peaks;
}

export function rootMeanSquare(channels, start = 0, end = channels[0]?.length ?? 0) {
  const length = assertChannels(channels);
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(length, Math.ceil(end));
  if (to <= from) return 0;
  let sum = 0;
  for (const channel of channels) {
    for (let i = from; i < to; i++) sum += channel[i] * channel[i];
  }
  return Math.sqrt(sum / ((to - from) * channels.length));
}

// Estimativa conservadora de memória (bytes) de um processamento de velocidade/altura.
export function processingMemoryEstimate({ samples, channels, speed = 1, semitones = 0, cents = 0 }) {
  const ratio = pitchRatio(semitones, cents);
  const stretched = samples * (ratio / speed);
  const output = samples / speed;
  return Math.ceil((samples + stretched + output + samples) * channels * 4);
}
