import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeWav,
  decodeWav,
  sessionToMidi,
  notesToMidi,
  parseMidi,
  midiToSessionPatch,
  defaultMidiTrack,
  MIDI_PPQ,
} from '../src/repertoire-formats.js';

function session(overrides = {}) {
  return {
    name: 'Exercício ç',
    bpm: 96,
    meter: { beats: 3, unit: 4 },
    notes: [
      { id: 'a', start: 0, duration: 2, pitch: 60, velocity: 0.8 },
      { id: 'b', start: 2, duration: 4, pitch: 64, velocity: 0.5 },
      { id: 'c', start: 6, duration: 6, pitch: 67 },
    ],
    progression: { enabled: true, chords: [{ symbol: 'Cmaj7', notes: [{ midi: 48 }, { midi: 52 }, { midi: 55 }, { midi: 59 }], durationBars: 1 }] },
    ...overrides,
  };
}

test('formats: WAV 16 bits ida e volta preserva taxa, canais e amostras', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
  const right = new Float32Array([0.1, -0.1, 0.2, -0.2, 0, 2]);
  const buffer = encodeWav([left, right], 48000);
  const view = new DataView(buffer);
  assert.equal(buffer.byteLength, 44 + left.length * 4);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48000);
  const decoded = decodeWav(buffer);
  assert.equal(decoded.sampleRate, 48000);
  assert.equal(decoded.channels.length, 2);
  left.forEach((value, index) => assert.ok(Math.abs(decoded.channels[0][index] - value) < 1 / 16384));
  assert.ok(Math.abs(decoded.channels[1][5] - 1) < 1 / 16384, 'valores acima de 1 são limitados');
});

test('formats: WAV flutuante de 32 bits é exato e entradas inválidas são recusadas', () => {
  const channel = new Float32Array([0.123, -0.456, 0.789]);
  const decoded = decodeWav(encodeWav([channel], 44100, { bitDepth: 32 }));
  assert.deepEqual(Array.from(decoded.channels[0]), Array.from(channel));
  assert.throws(() => encodeWav([], 44100), TypeError);
  assert.throws(() => encodeWav([channel], 44100.5), RangeError);
  assert.throws(() => decodeWav(new ArrayBuffer(60)), /RIFF/);
});

test('formats: sessão -> MIDI -> sessão preserva notas, andamento, fórmula e acordes', () => {
  const bytes = sessionToMidi(session());
  const parsed = parseMidi(bytes);
  assert.equal(parsed.format, 1);
  assert.equal(parsed.ppq, MIDI_PPQ);
  assert.equal(parsed.tracks.length, 3);
  assert.equal(parsed.tracks[1].name, 'Frase');
  assert.equal(parsed.tracks[2].notes.length, 4);
  assert.ok(Math.abs(parsed.tempos[0].bpm - 96) < 0.01);
  assert.deepEqual(parsed.timeSignatures[0], { tick: 0, beats: 3, unit: 4 });
  assert.equal(defaultMidiTrack(parsed), 1);
  const { patch, warnings } = midiToSessionPatch(parsed, { idPrefix: 't' });
  assert.equal(patch.bpm, 96);
  assert.deepEqual(patch.meter, { beats: 3, unit: 4 });
  assert.equal(patch.bars, 1);
  assert.equal(patch.name, 'Frase');
  assert.deepEqual(patch.notes.map(note => [note.id, note.start, note.duration, note.pitch]), [['t-1', 0, 2, 60], ['t-2', 2, 4, 64], ['t-3', 6, 6, 67]]);
  assert.ok(Math.abs(patch.notes[0].velocity - 0.8) < 0.01);
  assert.ok(warnings.some(warning => /uma trilha/.test(warning)));
});

test('formats: progressão desativada não é exportada', () => {
  const parsed = parseMidi(sessionToMidi(session({ progression: { enabled: false, chords: session().progression.chords } })));
  assert.equal(parsed.tracks.length, 2);
});

test('formats: leitura aceita running status e note-on com velocidade zero', () => {
  const track = [0x00, 0x90, 60, 100, 0x60, 60, 0, 0x00, 64, 90, 0x60, 0x80, 64, 0, 0x00, 0xff, 0x2f, 0x00];
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length, ...track,
  ]);
  const parsed = parseMidi(bytes);
  assert.deepEqual(parsed.tracks[0].notes.map(note => [note.tick, note.durationTicks, note.pitch]), [[0, 96, 60], [96, 96, 64]]);
  const { patch } = midiToSessionPatch(parsed);
  assert.equal(patch.bpm, 120, 'sem evento de andamento usa 120 BPM');
  assert.deepEqual(patch.notes.map(note => [note.start, note.duration]), [[0, 4], [4, 4]]);
});

test('formats: notas sobrepostas viram linha superior com aviso; tercinas quantizam', () => {
  const notes = [
    { start: 0, duration: 8, pitch: 60 },
    { start: 0, duration: 4, pitch: 67 },
    { start: 4, duration: 4, pitch: 62 },
    { start: 8, duration: 4 / 3, pitch: 64 },
    { start: 8 + 4 / 3, duration: 4 / 3, pitch: 65 },
  ];
  const parsed = parseMidi(sessionToMidi({ name: 'x', bpm: 100, meter: { beats: 4, unit: 4 }, notes }, { includeChords: false }));
  const { patch, warnings } = midiToSessionPatch(parsed, { quantize: 'eighth-triplet' });
  assert.deepEqual(patch.notes.map(note => note.pitch), [67, 62, 64, 65]);
  assert.ok(warnings.some(warning => /linha superior/.test(warning)));
  assert.ok(Math.abs(patch.notes[3].start - (8 + 4 / 3)) < 1e-6);
  assert.ok(Math.abs(patch.notes[3].duration - 4 / 3) < 1e-6);
});

test('formats: hipóteses de altura em segundos viram MIDI no andamento escolhido', () => {
  const parsed = parseMidi(notesToMidi([{ start: 0, end: 0.5, midi: 57, confidence: 0.9 }, { start: 0.5, end: 1, midi: 60, confidence: 0.5 }], { bpm: 120 }));
  const notes = parsed.tracks[1].notes;
  assert.deepEqual(notes.map(note => [note.tick, note.durationTicks, note.pitch]), [[0, 480, 57], [480, 480, 60]]);
});

test('formats: arquivos que não são SMF suportados geram erros legíveis', () => {
  assert.throws(() => parseMidi(new Uint8Array(20)), /MThd/);
  const smpte = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0xe7, 0x28]);
  assert.throws(() => parseMidi(smpte), /SMPTE/);
  const format2 = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 2, 0, 1, 0, 96]);
  assert.throws(() => parseMidi(format2), /formato 0 ou 1/);
  const truncated = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 40, 0]);
  assert.throws(() => parseMidi(truncated), /truncada/);
});
