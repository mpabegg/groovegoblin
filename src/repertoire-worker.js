// Worker de módulo: todo DSP/análise pesado roda aqui para não congelar a UI.
// Cancelamento = o cliente encerra (terminate) este worker; nada fica pela metade
// no armazenamento porque o resultado só é persistido pela página após 'result'.

import { changeSpeedAndPitch, separateHarmonicPercussive } from './repertoire-dsp.js';
import { analyzeAudio, trackBeats } from './repertoire-analysis.js';

const handlers = {
  process({ channels, sampleRate, speed, semitones, cents, algorithm }, progress) {
    const output = changeSpeedAndPitch(channels, {
      sampleRate, speed, semitones, cents, algorithm,
      onProgress: fraction => progress('Alterando velocidade e altura', fraction),
    });
    return { result: { channels: output }, transfer: output.map(channel => channel.buffer) };
  },
  hpss({ channels, sampleRate }, progress) {
    const { harmonic, percussive } = separateHarmonicPercussive(channels, {
      sampleRate,
      onProgress: fraction => progress('Separando harmônico/percussivo', fraction),
    });
    return { result: { harmonic, percussive }, transfer: [...harmonic, ...percussive].map(channel => channel.buffer) };
  },
  analyze({ mono, sampleRate, offset, sensitivity, stages }, progress) {
    const result = analyzeAudio(mono, sampleRate, {
      offset, sensitivity, stages,
      onProgress: ({ stage, fraction }) => progress(stage, fraction),
    });
    const transfer = [result.envelope, result.pitch?.f0, result.pitch?.confidence].filter(Boolean).map(array => array.buffer);
    return { result, transfer };
  },
  beats({ envelope, envelopeRate, bpm }, progress) {
    progress('Reacompanhando pulsos', 0);
    return { result: { beats: trackBeats(envelope, envelopeRate, bpm) }, transfer: [] };
  },
};

self.onmessage = event => {
  const { id, type, payload } = event.data ?? {};
  const handler = handlers[type];
  if (!handler) {
    self.postMessage({ id, type: 'error', message: `Tarefa desconhecida: ${type}` });
    return;
  }
  let last = 0;
  const progress = (stage, fraction) => {
    const now = Date.now();
    if (fraction < 1 && now - last < 100) return;
    last = now;
    self.postMessage({ id, type: 'progress', stage, fraction });
  };
  try {
    const { result, transfer } = handler(payload, progress);
    self.postMessage({ id, type: 'result', result }, transfer);
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error?.message || String(error) });
  }
};
