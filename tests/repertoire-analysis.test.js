import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSIS_SAMPLE_RATE,
  onsetEnvelope,
  pickOnsets,
  tempoCandidates,
  trackBeats,
  pitchTrack,
  segmentNotes,
  chromagram,
  chordHypotheses,
  estimateKey,
  analyzeAudio,
  midiToName,
  chordLabel,
} from '../src/repertoire-analysis.js';

const RATE = ANALYSIS_SAMPLE_RATE;

function noise(length, seed = 1, amplitude = 0.001) {
  const signal = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    signal[i] = amplitude * (state / 0xffffffff - 0.5);
  }
  return signal;
}

function clickTrack({ bpm = 120, seconds = 12, first = 0.25, rate = RATE } = {}) {
  const signal = noise(Math.round(seconds * rate));
  const times = [];
  for (let t = first; t < seconds - 0.1; t += 60 / bpm) {
    times.push(t);
    const start = Math.round(t * rate);
    for (let i = 0; i < Math.round(0.03 * rate); i++) {
      signal[start + i] += 0.8 * Math.exp(-i / (0.005 * rate)) * Math.sin(2 * Math.PI * 1500 * i / rate);
    }
  }
  return { signal, times };
}

function tones(parts, rate = RATE) {
  const total = parts.reduce((sum, part) => sum + part.seconds, 0);
  const signal = noise(Math.round(total * rate), 7);
  let offset = 0;
  for (const part of parts) {
    const length = Math.round(part.seconds * rate);
    for (const midi of part.midis) {
      const frequency = 440 * 2 ** ((midi - 69) / 12);
      for (let i = 0; i < length; i++) {
        const t = i / rate;
        signal[offset + i] += (0.3 * Math.sin(2 * Math.PI * frequency * t) + 0.12 * Math.sin(4 * Math.PI * frequency * t)) / part.midis.length;
      }
    }
    offset += length;
  }
  return signal;
}

test('analysis: ataques de uma trilha de cliques caem nos tempos certos', () => {
  const { signal, times } = clickTrack();
  const { envelope, frameRate } = onsetEnvelope(signal, RATE);
  const onsets = pickOnsets(envelope, frameRate, { sensitivity: 0.5 });
  assert.ok(Math.abs(onsets.length - times.length) <= 1, `${onsets.length} ataques para ${times.length} cliques`);
  for (const time of times) {
    const nearest = onsets.reduce((best, onset) => (Math.abs(onset.time - time) < Math.abs(best - time) ? onset.time : best), Infinity);
    assert.ok(Math.abs(nearest - time) < 0.03, `clique em ${time}, ataque em ${nearest}`);
  }
  assert.ok(onsets.every(onset => onset.confidence >= 0 && onset.confidence <= 1));
});

test('analysis: andamento de 120 BPM é o primeiro candidato e os pulsos seguem 0,5 s', () => {
  const { signal } = clickTrack({ bpm: 120 });
  const { envelope, frameRate } = onsetEnvelope(signal, RATE);
  const candidates = tempoCandidates(envelope, frameRate);
  assert.ok(candidates.length >= 2);
  assert.ok(Math.abs(candidates[0].bpm - 120) / 120 < 0.02, `primeiro candidato ${candidates[0].bpm}`);
  const total = candidates.reduce((sum, candidate) => sum + candidate.confidence, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(Math.abs(candidates[0].offset - 0.25) < 0.03 || Math.abs(candidates[0].offset - 0.75) < 0.03, `fase ${candidates[0].offset}`);
  const beats = trackBeats(envelope, frameRate, candidates[0].bpm);
  const intervals = beats.slice(1).map((time, index) => time - beats[index]);
  const median = intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
  assert.ok(Math.abs(median - 0.5) < 0.02, `intervalo mediano ${median}`);
});

test('analysis: andamento de 90 BPM também é encontrado entre os candidatos', () => {
  const { signal } = clickTrack({ bpm: 90, seconds: 14 });
  const { envelope, frameRate } = onsetEnvelope(signal, RATE);
  const candidates = tempoCandidates(envelope, frameRate);
  assert.ok(candidates.some(candidate => Math.abs(candidate.bpm - 90) / 90 < 0.02), JSON.stringify(candidates.map(candidate => candidate.bpm)));
});

test('analysis: YIN estima a altura e a segmentação separa duas notas', () => {
  const signal = tones([{ seconds: 0.6, midis: [57] }, { seconds: 0.6, midis: [60] }]);
  const track = pitchTrack(signal, RATE);
  const voiced = Array.from(track.f0).filter((value, index) => value > 0 && track.confidence[index] > 0.8 && index < track.f0.length * 0.4);
  const median = voiced.sort((a, b) => a - b)[Math.floor(voiced.length / 2)];
  assert.ok(Math.abs(median - 220) / 220 < 0.01, `f0 mediano ${median}`);
  const notes = segmentNotes(track);
  assert.deepEqual(notes.map(note => note.midi), [57, 60]);
  assert.ok(Math.abs(notes[0].start) < 0.08, `início ${notes[0].start}`);
  assert.ok(Math.abs(notes[1].start - 0.6) < 0.08, `segunda nota em ${notes[1].start}`);
  assert.ok(notes.every(note => note.confidence > 0.7 && note.confidence <= 1));
  assert.equal(midiToName(57), 'A3');
});

test('analysis: croma reconhece Dó maior seguido de Lá menor, com alternativas', () => {
  const signal = tones([{ seconds: 2, midis: [60, 64, 67] }, { seconds: 2, midis: [57, 60, 64] }]);
  const chroma = chromagram(signal, RATE);
  const chords = chordHypotheses(chroma).filter(chord => chord.label !== 'N');
  assert.deepEqual(chords.map(chord => chord.label), ['C', 'Am']);
  assert.ok(Math.abs(chords[1].start - 2) < 0.4, `troca em ${chords[1].start}`);
  for (const chord of chords) {
    assert.ok(chord.confidence > 0 && chord.confidence <= 1);
    assert.ok(chord.alternatives.length >= 2);
    assert.equal(chord.alternatives[0].label, chord.label);
  }
  assert.equal(chordLabel(9, 'min'), 'Am');
});

test('analysis: tonalidade de uma cadência em Dó maior', () => {
  const signal = tones([
    { seconds: 1, midis: [60, 64, 67] }, { seconds: 1, midis: [65, 69, 72] },
    { seconds: 1, midis: [67, 71, 74] }, { seconds: 1, midis: [60, 64, 67] },
  ]);
  const keys = estimateKey(chromagram(signal, RATE));
  assert.equal(keys[0].label, 'C maior');
  assert.equal(keys.length, 3);
});

test('analysis: analyzeAudio reamostra entradas de 44,1 kHz e informa progresso por etapa', () => {
  const { signal: slow } = clickTrack({ bpm: 120, seconds: 6, rate: 44100 });
  const stages = new Set();
  let last = 0;
  const result = analyzeAudio(slow, 44100, { stages: ['rhythm'], onProgress: ({ stage, fraction }) => { stages.add(stage); assert.ok(fraction >= last - 1e-9); last = fraction; } });
  assert.equal(result.sampleRate, RATE);
  assert.ok(Math.abs(result.duration - 6) < 0.01);
  assert.ok(result.tempo.length > 0);
  assert.ok(result.onsets.length >= 10);
  assert.equal(result.notes, undefined);
  assert.ok(stages.has('Reamostrando') && stages.has('Ataques') && stages.has('Concluído'));
  const short = analyzeAudio(noise(RATE / 2), RATE, { stages: ['rhythm'] });
  assert.ok(short.warnings.some(warning => /menos de 1 s/.test(warning)));
});

test('analysis: coordenadas limitadas à duração de origem, sem segmentos vazios', () => {
  const signal = tones([{ seconds: 4, midis: [60, 64, 67] }]);
  const result = analyzeAudio(signal, RATE);
  assert.equal(result.duration, signal.length / RATE);
  assert.ok(result.chords.length > 0);
  assert.equal(result.chords.at(-1).end, result.duration);
  for (const segment of [...result.chords, ...result.notes]) {
    assert.ok(segment.start >= 0 && segment.end <= result.duration);
    assert.ok(segment.end > segment.start);
  }
  assert.ok(result.onsets.every(onset => onset.time >= 0 && onset.time < result.duration));
  assert.ok(result.beats.every(time => time >= 0 && time < result.duration));
  assert.equal(new Set(result.beats).size, result.beats.length);
});

test('analysis: terminação curta continua válida depois de limitar as bordas', () => {
  const f0 = new Float32Array(10);
  const confidence = new Float32Array(10);
  f0[9] = 440;
  confidence[9] = 1;
  const track = { f0, confidence, frameRate: 10, offset: 0, duration: 0.91 };
  const notes = segmentNotes(track);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].start, 0.9);
  assert.equal(notes[0].end, 0.91);
  assert.deepEqual(segmentNotes({ ...track, duration: 0.9 }), []);
  const chroma = chromagram(tones([{ seconds: 0.03, midis: [60, 64, 67] }]), RATE);
  const chords = chordHypotheses(chroma);
  assert.equal(chords.length, 1);
  assert.equal(chords[0].end, chroma.duration);
  assert.ok(chords[0].end > chords[0].start);
  assert.deepEqual(chordHypotheses(chroma, { duration: 0 }), []);
});

test('analysis: recalcular ataques e pulsos respeita o intervalo de origem', () => {
  const envelope = new Float32Array(20);
  for (const frame of [3, 8, 13, 18]) envelope[frame] = 10;
  const onsets = pickOnsets(envelope, 10, { duration: 1 });
  assert.ok(onsets.length > 0);
  assert.ok(onsets.every(onset => onset.time < 1));
  const beats = trackBeats(envelope, 10, 120, { duration: 1 });
  assert.ok(beats.length > 0);
  assert.ok(beats.every(time => time < 1));
  assert.equal(new Set(beats).size, beats.length);
});

test('analysis: reamostragem não aumenta a duração do intervalo solicitado', () => {
  const signal = new Float32Array(10001);
  const duration = signal.length / 44100;
  const result = analyzeAudio(signal, 44100);
  assert.equal(result.duration, duration);
  assert.ok(result.chords.every(chord => chord.end <= duration && chord.end > chord.start));
  const selected = analyzeAudio(signal, 44100, { duration: duration - 0.001 });
  assert.equal(selected.duration, duration - 0.001);
  assert.ok(selected.chords.every(chord => chord.end <= selected.duration));
});
