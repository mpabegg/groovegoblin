import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFFT,
  phaseVocoderStretch,
  wsolaStretch,
  resample,
  changeSpeedAndPitch,
  separateHarmonicPercussive,
  validateProcessing,
  isIdentityProcessing,
  pitchRatio,
  computePeaks,
  rootMeanSquare,
  mixToMono,
  processingMemoryEstimate,
} from '../src/repertoire-dsp.js';

const RATE = 44100;

function sine(frequency, seconds, { rate = RATE, amplitude = 0.5 } = {}) {
  const signal = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < signal.length; i++) signal[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / rate);
  return signal;
}

// Frequência pelo número de cruzamentos ascendentes por zero no miolo do sinal.
function zeroCrossingFrequency(signal, rate = RATE) {
  const from = Math.floor(signal.length * 0.15);
  const to = Math.floor(signal.length * 0.85);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if (signal[i - 1] < 0 && signal[i] >= 0) crossings++;
  return crossings / ((to - from) / rate);
}

function energy(signal) {
  let sum = 0;
  for (const value of signal) sum += value * value;
  return sum;
}

test('dsp: FFT seguida da inversa reconstrói o sinal e localiza a senoide no bin certo', () => {
  const size = 1024;
  const fft = createFFT(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const original = new Float64Array(size);
  for (let i = 0; i < size; i++) original[i] = re[i] = Math.sin(2 * Math.PI * 37 * i / size) + 0.25 * Math.cos(2 * Math.PI * 5 * i / size);
  fft.forward(re, im);
  let peak = 0;
  for (let k = 1; k < size / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[peak], im[peak])) peak = k;
  assert.equal(peak, 37);
  fft.inverse(re, im);
  for (let i = 0; i < size; i++) {
    assert.ok(Math.abs(re[i] - original[i]) < 1e-9);
    assert.ok(Math.abs(im[i]) < 1e-9);
  }
  assert.throws(() => createFFT(1000), RangeError);
});

test('dsp: vocoder de fase alonga a duração sem mudar a altura', () => {
  const input = sine(440, 1);
  const [output] = phaseVocoderStretch([input], 1.5, { sampleRate: RATE });
  assert.equal(output.length, Math.round(input.length * 1.5));
  const frequency = zeroCrossingFrequency(output);
  assert.ok(Math.abs(frequency - 440) / 440 < 0.01, `frequência ${frequency}`);
  const ratio = rootMeanSquare([output]) / rootMeanSquare([input]);
  assert.ok(ratio > 0.85 && ratio < 1.15, `nível relativo ${ratio}`);
});

test('dsp: WSOLA comprime a duração sem mudar a altura', () => {
  const input = sine(330, 1);
  const [output] = wsolaStretch([input], 0.8, { sampleRate: RATE });
  assert.equal(output.length, Math.round(input.length * 0.8));
  const frequency = zeroCrossingFrequency(output);
  assert.ok(Math.abs(frequency - 330) / 330 < 0.01, `frequência ${frequency}`);
});

test('dsp: reamostragem por 2 dobra a frequência e reduz a duração pela metade', () => {
  const input = sine(440, 0.5);
  const [output] = resample([input], 2);
  assert.equal(output.length, Math.round(input.length / 2));
  const frequency = zeroCrossingFrequency(output);
  assert.ok(Math.abs(frequency - 880) / 880 < 0.01, `frequência ${frequency}`);
});

for (const algorithm of ['vocoder', 'wsola']) {
  test(`dsp: velocidade e transposição são independentes (${algorithm})`, () => {
    const input = sine(440, 1);
    const speed = 0.75;
    const output = changeSpeedAndPitch([input], { sampleRate: RATE, speed, semitones: 3, cents: 0, algorithm });
    const expectedLength = input.length / speed;
    assert.ok(Math.abs(output[0].length - expectedLength) / expectedLength < 0.01, `duração ${output[0].length}`);
    const expected = 440 * pitchRatio(3);
    const frequency = zeroCrossingFrequency(output[0]);
    assert.ok(Math.abs(frequency - expected) / expected < 0.015, `frequência ${frequency} (esperado ${expected})`);

    const sameSpeed = changeSpeedAndPitch([input], { sampleRate: RATE, speed: 1, semitones: -5, algorithm });
    assert.ok(Math.abs(sameSpeed[0].length - input.length) / input.length < 0.01);
    const lower = 440 * pitchRatio(-5);
    assert.ok(Math.abs(zeroCrossingFrequency(sameSpeed[0]) - lower) / lower < 0.015);
  });
}

test('dsp: o processamento estéreo preserva a diferença de nível entre canais', () => {
  const left = sine(500, 0.6);
  const right = left.map(value => value * 0.5);
  const [outLeft, outRight] = changeSpeedAndPitch([left, right], { sampleRate: RATE, speed: 0.8, semitones: 2 });
  assert.equal(outLeft.length, outRight.length);
  const ratio = rootMeanSquare([outRight]) / rootMeanSquare([outLeft]);
  assert.ok(Math.abs(ratio - 0.5) < 0.03, `razão ${ratio}`);
});

test('dsp: processamento identidade devolve cópias sem tocar na entrada', () => {
  const input = sine(220, 0.1);
  const output = changeSpeedAndPitch([input], { sampleRate: RATE });
  assert.notEqual(output[0], input);
  assert.deepEqual(Array.from(output[0]), Array.from(input));
  assert.equal(isIdentityProcessing({ speed: 1, semitones: 0, cents: 0 }), true);
  assert.equal(isIdentityProcessing({ speed: 1, semitones: 0, cents: 5 }), false);
});

test('dsp: limites de velocidade/transposição são validados com mensagens', () => {
  assert.equal(validateProcessing({ speed: 1, semitones: 0, cents: 0, algorithm: 'vocoder' }), null);
  assert.match(validateProcessing({ speed: 0.1 }), /velocidade/);
  assert.match(validateProcessing({ speed: 1, semitones: 13 }), /semitons/);
  assert.match(validateProcessing({ speed: 1, semitones: 1.5 }), /inteiro/);
  assert.match(validateProcessing({ speed: 1, cents: 80 }), /cents/);
  assert.match(validateProcessing({ speed: 1, algorithm: 'magia' }), /Algoritmo/);
  assert.throws(() => changeSpeedAndPitch([sine(220, 0.1)], { speed: 3 }), RangeError);
  assert.throws(() => changeSpeedAndPitch([new Float32Array(4), new Float32Array(5)], { speed: 0.9 }), RangeError);
});

test('dsp: HPSS envia senoide sustentada ao harmônico e cliques ao percussivo', () => {
  const rate = 22050;
  const tone = sine(440, 2, { rate });
  const harmonicSplit = separateHarmonicPercussive([tone], { sampleRate: rate });
  const toneShare = energy(harmonicSplit.harmonic[0]) / (energy(harmonicSplit.harmonic[0]) + energy(harmonicSplit.percussive[0]));
  assert.ok(toneShare > 0.9, `parte harmônica da senoide ${toneShare}`);

  const clicks = new Float32Array(rate * 2);
  for (let t = 0.1; t < 2; t += 0.25) clicks[Math.round(t * rate)] = 1;
  const percussiveSplit = separateHarmonicPercussive([clicks], { sampleRate: rate });
  const clickShare = energy(percussiveSplit.percussive[0]) / (energy(percussiveSplit.harmonic[0]) + energy(percussiveSplit.percussive[0]));
  assert.ok(clickShare > 0.7, `parte percussiva dos cliques ${clickShare}`);

  // Máscaras suaves complementares: harmônico + percussivo ≈ original.
  const mix = tone.map((value, index) => value + clicks[index]);
  const { harmonic, percussive } = separateHarmonicPercussive([mix], { sampleRate: rate });
  let error = 0;
  for (let i = 2048; i < mix.length - 2048; i++) error = Math.max(error, Math.abs(harmonic[0][i] + percussive[0][i] - mix[i]));
  assert.ok(error < 1e-3, `erro de reconstrução ${error}`);
});

test('dsp: picos, RMS, mixagem mono e estimativa de memória', () => {
  const channel = new Float32Array([0, 0.5, -0.25, 1, -1, 0.1, 0, 0]);
  const peaks = computePeaks([channel], 0, 8, 2);
  assert.deepEqual(Array.from(peaks), [-0.25, 1, -1, 0.10000000149011612]);
  assert.ok(Math.abs(rootMeanSquare([new Float32Array([1, -1, 1, -1])]) - 1) < 1e-9);
  assert.deepEqual(Array.from(mixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])])), [0.5, 0.5]);
  assert.ok(processingMemoryEstimate({ samples: 44100, channels: 2, speed: 0.5 }) > processingMemoryEstimate({ samples: 44100, channels: 2, speed: 1 }));
});
