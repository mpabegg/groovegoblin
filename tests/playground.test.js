import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYGROUND_STORAGE_KEY,
  CAPTURE_KINDS,
  createPlaygroundState,
  validatePlaygroundState,
  validateCapture,
  loadPlaygroundState,
  savePlaygroundState,
  recordCapture,
  deleteCapture,
  goblinCall,
  compareRhythms,
  ticksFromResponse,
  dungeonRooms,
  dungeonCheck,
  dungeonVanishedNotes,
  bossAttacks,
  bossCheck,
  attemptsToPhrase,
  silenceSummary,
  transformPhrase,
  TRANSFORMS,
  polyrhythmPattern,
  choirVoices,
  CHOIR_OBJECTS,
} from '../src/playground.js';
import { memoryStorage } from './storage-fixture.js';
import { createSession, validateSession } from '../src/session.js';

// ---------------------------------------------------------------------------
// Duende
// ---------------------------------------------------------------------------

test('goblinCall: determinístico, com contorno melódico dentro da faixa', () => {
  const a = goblinCall({ seed: 5, bars: 2 });
  const b = goblinCall({ seed: 5, bars: 2 });
  assert.deepEqual(a, b);
  assert.equal(a.bars, 2);
  assert.ok(a.notes.length > 0);
  assert.ok(a.notes.every(note => note.pitch >= 57 && note.pitch <= 81));
  const seeds = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(seed => JSON.stringify(goblinCall({ seed }).notes.map(n => n.start))));
  assert.ok(seeds.size > 4, 'sementes diferentes chamam ritmos diferentes');
});

test('compareRhythms: métrica honesta de acertos, faltas e sobras', () => {
  const reference = [{ start: 0, duration: 1 }, { start: 4, duration: 1 }, { start: 8, duration: 1 }];
  const result = compareRhythms(reference, new Set([0, 4, 10]), { bars: 1 });
  assert.equal(result.matched, 2);
  assert.deepEqual(result.missed, [8]);
  assert.deepEqual(result.extra, [10]);
  assert.ok(Math.abs(result.similarity - 2 / 3) < 1e-9);
  const vazio = compareRhythms([], new Set());
  assert.equal(vazio.similarity, 0);
  assert.deepEqual(ticksFromResponse([3, 1, 2]), [1, 2, 3]);
  assert.deepEqual(ticksFromResponse(new Set([-1, 5])), [5]);
});

// ---------------------------------------------------------------------------
// Masmorra
// ---------------------------------------------------------------------------

test('dungeonRooms: salas determinísticas com cliques escondidos reais', () => {
  const { rooms, total } = dungeonRooms({ seed: 13, rooms: 5 });
  assert.equal(total, 5);
  assert.deepEqual(dungeonRooms({ seed: 13, rooms: 5 }).rooms, rooms);
  rooms.forEach((room, index) => {
    const onsets = new Set(room.onsets);
    assert.ok(room.hidden.every(tick => onsets.has(tick)), 'cliques escondidos são ataques reais da sala');
    assert.ok(room.hidden.length <= 3);
    assert.equal(room.bpm, 70 + index * 8);
    const check = dungeonCheck(room, room.hidden);
    assert.equal(check.correct, true);
  });
  assert.ok(rooms[rooms.length - 1].hidden.length >= rooms[0].hidden.length, 'dificuldade cresce com a sala');
  const vanished = dungeonVanishedNotes(rooms[0]);
  const hiddenSet = new Set(rooms[0].hidden);
  assert.ok(vanished.every(note => !hiddenSet.has(Math.round(note.start))));
  assert.equal(vanished.length, rooms[0].notes.length - rooms[0].hidden.length);
});

// ---------------------------------------------------------------------------
// Chefe
// ---------------------------------------------------------------------------

test('bossAttacks: os ataques caem exatamente nos espaços da frase original', () => {
  const original = [
    { id: 'a', start: 0, duration: 4, pitch: 69, velocity: 0.8 },
    { id: 'b', start: 6, duration: 2, pitch: 69, velocity: 0.8 },
    { id: 'c', start: 12, duration: 4, pitch: 69, velocity: 0.8 },
  ];
  const boss = bossAttacks(original, 1, { seed: 9 });
  assert.deepEqual(bossAttacks(original, 1, { seed: 9 }), boss);
  const covered = new Set();
  for (const note of original) for (let tick = note.start; tick < note.start + note.duration; tick += 1) covered.add(tick);
  assert.ok(boss.attacks.every(tick => !covered.has(tick)), 'chefe ataca só nos silêncios da original');
  assert.ok(boss.attacks.length >= 2);
  assert.ok(boss.gaps.includes(4));
  const check = bossCheck(boss, boss.attacks);
  assert.equal(check.correct, true);
  const wrong = bossCheck(boss, [boss.attacks[0], 15]);
  assert.equal(wrong.correct, false);
  assert.ok(wrong.missed.length + wrong.extra.length > 0);
});

// ---------------------------------------------------------------------------
// Erros férteis
// ---------------------------------------------------------------------------

test('attemptsToPhrase: quantização estrita e preservação de microtiming', () => {
  const bpm = 120; // 1 tick = 125 ms
  const attempts = [
    { start: 0.01, end: 0.12 },
    { start: 0.26, end: 0.35 }, // perto do tick 2 (0.25) — atraído no estrito, preservado no fracionário
    { start: 0.9, end: 1.0 },
  ];
  const strict = attemptsToPhrase(attempts, { bpm, quantize: 'strict', bars: 2 });
  assert.ok(strict.notes.every(note => Number.isInteger(note.start)));
  assert.equal(strict.notes[1].start, 2);
  assert.equal(strict.adjusted.length, 0);

  const preserve = attemptsToPhrase(attempts, { bpm, quantize: 'preserve', bars: 2 });
  assert.ok(Math.abs(preserve.notes[1].start - 0.26 / 0.125) < 1e-9);
  assert.equal(preserve.adjusted.length, 0);

  // toques quase simultâneos viram um único ataque
  const merged = attemptsToPhrase([{ start: 1.0, end: 1.1 }, { start: 1.05, end: 1.2 }], { bpm, quantize: 'strict', bars: 1 });
  assert.equal(merged.notes.length, 1);
});

test('silenceSummary: observações do pulso interno sem nota', () => {
  const bpm = 60; // alvo de 1000 ms por pulso
  const taps = [{ start: 0 }, { start: 1.02 }, { start: 2.04 }, { start: 3.06 }];
  const summary = silenceSummary(taps, bpm);
  assert.equal(summary.taps, 4);
  assert.ok(Math.abs(summary.meanMs - 1020) < 1);
  assert.equal(summary.spreadMs, 0);
  assert.ok(summary.driftMs > 0);
  const curto = silenceSummary([{ start: 0 }], bpm);
  assert.equal(curto.meanMs, null);
  assert.equal(curto.taps, 1);
});

// ---------------------------------------------------------------------------
// Alquimia
// ---------------------------------------------------------------------------

const MOTIVE = [
  { id: 'm1', start: 0, duration: 2, pitch: 72, velocity: 0.9 },
  { id: 'm2', start: 4, duration: 2, pitch: 71, velocity: 0.5 },
  { id: 'm3', start: 8, duration: 4, pitch: 69, velocity: 0.7 },
];

test('transformPhrase: cada transformação muda exatamente o que promete', () => {
  const retro = transformPhrase(MOTIVE, 'retrograde', { bars: 1, ticksPerBar: 16 });
  assert.deepEqual(retro.map(note => note.start + note.duration), [8, 12, 16]);
  assert.equal(retro[0].pitch, 69);

  const inv = transformPhrase(MOTIVE, 'inversion', { bars: 1, ticksPerBar: 16, centerPitch: 69 });
  assert.deepEqual(inv.map(note => note.pitch), [66, 67, 69]);

  const up = transformPhrase(MOTIVE, 'scale-up', { bars: 1, ticksPerBar: 16 });
  assert.deepEqual(up.map(note => note.start), [0, 8]);

  const down = transformPhrase(MOTIVE, 'scale-down', { bars: 1, ticksPerBar: 16 });
  assert.deepEqual(down.map(note => note.start), [0, 2, 4]);

  const accents = transformPhrase(MOTIVE, 'accent-shift', { bars: 1, ticksPerBar: 16 });
  assert.deepEqual(accents.map(note => note.velocity), [0.5, 0.7, 0.9]);

  const reharm = transformPhrase(MOTIVE, 'reharm', { bars: 1, ticksPerBar: 16, chordTones: [60, 64, 67] });
  assert.ok(reharm.every(note => [60, 64, 67, 72, 76, 79].includes(note.pitch)));
  assert.throws(() => transformPhrase(MOTIVE, 'reharm', { bars: 1, ticksPerBar: 16 }), /acordes/);

  const straight = transformPhrase([{ id: 'x', start: 3, duration: 1, pitch: 69, velocity: 0.8 }, { id: 'y', start: 5, duration: 1, pitch: 69, velocity: 0.8 }], 'straighten', { bars: 1, ticksPerBar: 16, ticksPerBeat: 4 });
  assert.deepEqual(straight.map(note => note.start), [4]);

  const swing = transformPhrase([{ id: 'x', start: 2, duration: 1, pitch: 69, velocity: 0.8 }, { id: 'y', start: 4, duration: 1, pitch: 69, velocity: 0.8 }], 'swingify', { bars: 1, ticksPerBar: 16, ticksPerBeat: 4 });
  assert.deepEqual(swing.map(note => note.start), [2 + 4 / 6, 4]);

  const sync = transformPhrase(MOTIVE, 'syncopate', { bars: 1, ticksPerBar: 16, ticksPerBeat: 4 });
  assert.ok(sync.some(note => note.start % 4 !== 0));

  for (const transform of TRANSFORMS) {
    const result = transformPhrase(MOTIVE, transform.id, { bars: 1, ticksPerBar: 16, chordTones: [60, 64, 67] });
    assert.ok(result.every(note => note.start >= 0 && note.start < 16));
    assert.ok(result.every(note => note.id.startsWith('alchemy-')));
  }
  assert.throws(() => transformPhrase(MOTIVE, 'fake'), /Transformação desconhecida/);
  assert.deepEqual(transformPhrase([], 'retrograde', { bars: 1, ticksPerBar: 16 }), []);
});

// ---------------------------------------------------------------------------
// Portal e coral
// ---------------------------------------------------------------------------

test('polyrhythmPattern: dois pulsos com alturas distintas', () => {
  const pattern = polyrhythmPattern(3, 2, { bars: 1 });
  assert.deepEqual(polyrhythmPattern(3, 2, { bars: 1 }), pattern);
  const a = pattern.notes.filter(note => note.pitch === 72);
  const b = pattern.notes.filter(note => note.pitch === 60);
  assert.equal(a.length, 3);
  assert.equal(b.length, 2);
  assert.ok(Math.abs(a[1].start - 16 / 3) < 1e-9, 'ticks fracionários permitem o 3 exato');
  assert.throws(() => polyrhythmPattern(3, 3), /diferentes/);
});

test('choirVoices: vozes determinísticas por objeto, sem microfone', () => {
  const result = choirVoices(['copo', 'livro'], { seed: 4, bars: 1 });
  assert.deepEqual(choirVoices(['copo', 'livro'], { seed: 4, bars: 1 }), result);
  assert.equal(result.objects.length, 2);
  const copo = CHOIR_OBJECTS.find(object => object.id === 'copo');
  const livro = CHOIR_OBJECTS.find(object => object.id === 'livro');
  assert.ok(result.notes.filter(note => note.pitch === copo.pitch).length >= 2);
  assert.ok(result.notes.filter(note => note.pitch === livro.pitch).length >= 2);
  assert.ok(result.notes.every(note => note.id.startsWith('choir-')));
  assert.throws(() => choirVoices([]), /ao menos um objeto/);
});

// ---------------------------------------------------------------------------
// Armazenamento do playground
// ---------------------------------------------------------------------------

test('playground storage: capturas validadas, corrompidos preservados, dedupe', () => {
  const storage = memoryStorage();
  const state = createPlaygroundState();
  const capture = {
    id: 'cap-1',
    at: '2026-03-01T10:00:00Z',
    kind: 'goblin-response',
    label: 'Resposta ao duende',
    notes: [{ id: 'r1', start: 0, duration: 1, pitch: 69, velocity: 0.8 }],
    bpm: 90,
    bars: 2,
  };
  assert.equal(recordCapture(state, capture).recorded, true);
  assert.equal(recordCapture(state, capture).recorded, false, 'capturas deduplicam por id');
  assert.equal(savePlaygroundState(state, storage), true);
  const loaded = loadPlaygroundState(storage);
  assert.equal(loaded.state.captures.length, 1);
  assert.equal(loaded.recoveryRaw, null);

  storage.setItem(PLAYGROUND_STORAGE_KEY, ']]corrompido[[');
  const corrupt = loadPlaygroundState(storage);
  assert.equal(corrupt.state.captures.length, 0);
  assert.equal(corrupt.recoveryRaw, ']]corrompido[[');
  assert.equal(savePlaygroundState(corrupt.state, storage), true);
  assert.equal(storage.getItem(`${PLAYGROUND_STORAGE_KEY}.recovery`), ']]corrompido[[');

  assert.equal(validateCapture({ ...capture, kind: 'inventado' }).ok, false);
  assert.equal(validateCapture({ ...capture, notes: [] }).ok, false, 'resposta sem notas é inválida');
  assert.ok(CAPTURE_KINDS.includes('engine-attempt'));

  const engineAttempt = {
    id: 'engine-1',
    at: '2026-03-02T10:00:00Z',
    kind: 'engine-attempt',
    label: 'Tentativa do treino (3 toques, 100 bpm)',
    notes: [],
    attempts: [{ start: 0.1, end: 0.4 }, { start: 1.2, end: 1.5 }, { start: 2.4, end: 2.7 }],
    bpm: 100,
    bars: 1,
  };
  assert.equal(validateCapture(engineAttempt).ok, true);
  assert.equal(deleteCapture(state, 'cap-1'), true);
  assert.equal(deleteCapture(state, 'cap-1'), false);

  const state2 = validatePlaygroundState({ version: 1, captures: [capture, { id: 'x' }], eggs: { portal: 'sim' }, effects: { volume: 3 } }).state;
  assert.equal(state2.captures.length, 1);
  assert.equal(state2.eggs.portal, false);
  assert.equal(state2.effects.volume, 1);
});

test('cultivation clips held notes and retains pitch without overlapping attacks', () => {
  const result = attemptsToPhrase([{ start: 0, end: 9, pitch: 72 }, { start: 0.5, end: 99, pitch: 60 }], { bpm: 120, bars: 1, quantize: 'preserve' });
  assert.deepEqual(result.notes.map(note => note.pitch), [72, 60]);
  assert.equal(result.notes[0].start + result.notes[0].duration, result.notes[1].start);
  assert.equal(result.notes[1].start + result.notes[1].duration, 16);
  assert.equal(validateSession(createSession({ notes: result.notes, bars: 1 })).ok, true);
});

test('all alchemy outputs satisfy the real Engine phrase contract', () => {
  for (const transform of TRANSFORMS) {
    const notes = transformPhrase(MOTIVE, transform.id, { bars: 1, chordTones: [60, 64, 67] });
    assert.equal(validateSession(createSession({ bars: 1, notes })).ok, true);
  }
});

