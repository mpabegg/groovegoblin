import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OBJECTIVES,
  VARIANT_DIMENSIONS,
  generateExercise,
  partialVariant,
  evaluationFromDetail,
  objectiveMetric,
  adaptTempo,
  nextReview,
  createSkill,
  performanceQuality,
  reviewQueue,
  createPracticeState,
  validatePracticeState,
  validateRunEntry,
  loadPracticeState,
  savePracticeState,
  recordRun,
  runId,
  importRuns,
  deleteRun,
  clearHistory,
  deleteObjectiveData,
  practiceTotals,
  objectiveProgress,
  PRACTICE_STORAGE_KEY,
  generateIntervalQuestion,
  generateChordFunctionQuestion,
  generateRhythmQuestion,
  checkRhythmAnswer,
  INTERVALS,
  CHORD_FUNCTIONS,
} from '../src/practice.js';
import { memoryStorage } from './storage-fixture.js';
import { createSession, validateSession } from '../src/session.js';
import { evaluateSession } from '../src/feedback.js';


function makeSummary(overrides = {}) {
  return { expected: 4, matched: 4, missed: 0, extra: 0, attackOk: 4, endOk: 4, advice: [], ...overrides };
}

function makeAttemptRun(objective = 'timing', metrics = {}) {
  return {
    id: `run-test-${objective}`,
    at: new Date('2026-01-05T12:00:00Z').toISOString(),
    kind: 'attempt',
    objective,
    stage: 'Imitar',
    bpm: 100,
    bars: 1,
    durationSec: 12,
    notes: [{ id: 'n1', start: 0, duration: 4, pitch: 69, velocity: 0.8 }],
    metrics: { expected: 4, matched: 3, missed: 1, extra: 0, attackOk: 3, endOk: 3, objectiveScore: 75, ...metrics },
    tempoDelta: 0,
  };
}

// ---------------------------------------------------------------------------
// Exercícios e variações parciais
// ---------------------------------------------------------------------------

test('generateExercise: determinístico por semente e perfil por objetivo', () => {
  const a = generateExercise({ objective: 'timing', seed: 7, bars: 2 });
  const b = generateExercise({ objective: 'timing', seed: 7, bars: 2 });
  assert.deepEqual(a, b);
  assert.equal(a.bars, 2);
  assert.ok(a.notes.length > 0);
  assert.ok(a.notes.every(note => Number.isFinite(note.pitch) && note.velocity > 0 && note.velocity <= 1));

  const rests = generateExercise({ objective: 'rests', seed: 7, bars: 2 });
  assert.equal(rests.density, 'sparse');
  assert.equal(rests.lengths, 'long');

  const innerPulse = generateExercise({ objective: 'inner-pulse', seed: 3, bars: 1 });
  assert.equal(innerPulse.metronome.silentBars, 2);

  const accents = generateExercise({ objective: 'accents', seed: 3, bars: 1 });
  assert.ok(accents.notes.some(note => note.velocity >= 0.9), 'objetivo de acentos marca notas fortes');
  assert.ok(accents.notes.some(note => note.velocity <= 0.6), 'objetivo de acentos marca notas leves');

  const sync = generateExercise({ objective: 'syncopation', seed: 3, bars: 1 });
  assert.equal(sync.syncopation, 'syncopated');
  assert.ok(sync.notes.some(note => note.start % 4 !== 0), 'síncope produz ataques fora dos tempos fortes');

  const leveled = generateExercise({ objective: 'timing', seed: 3, bars: 1, level: 2 });
  assert.equal(leveled.density, 'busy');
});

test('generateExercise: fonte da sessão reaproveita notas e bpm atuais', () => {
  const session = {
    notes: [{ id: 's1', start: 0, duration: 4, pitch: 72, velocity: 0.5 }],
    bpm: 128,
    bars: 1,
    meter: { beats: 4, unit: 4 },
  };
  const exercise = generateExercise({ objective: 'timing', seed: 11, source: 'session', session });
  assert.equal(exercise.source, 'session');
  assert.equal(exercise.bpm, 128);
  assert.deepEqual(exercise.notes.map(note => note.start), [0]);
  assert.equal(exercise.notes[0].pitch, 72);
});

test('partialVariant: varia exatamente uma dimensão e preserva as demais', () => {
  const base = generateExercise({ objective: 'timing', seed: 42, bars: 1 });
  const attacks = partialVariant(base, 'attacks');
  assert.notEqual(attacks.density, base.density);
  assert.ok(attacks.notes.length > base.notes.length);
  assert.equal(attacks.lengths, base.lengths);
  assert.equal(attacks.syncopation, base.syncopation);

  const durations = partialVariant(base, 'durations');
  assert.equal(durations.density, base.density);
  assert.notEqual(durations.lengths, base.lengths);
  assert.deepEqual(durations.notes.map(note => note.start), base.notes.map(note => note.start));
  assert.notDeepEqual(durations.notes.map(note => note.duration), base.notes.map(note => note.duration));

  const tempo = partialVariant(base, 'tempo');
  assert.equal(tempo.bpm, base.bpm + 8);
  assert.deepEqual(tempo.notes.map(n => n.start), base.notes.map(n => n.start));
  const tempoDown = partialVariant(base, 'tempo', { direction: 'down' });
  assert.equal(tempoDown.bpm, base.bpm - 8);

  const accents = partialVariant(base, 'accents');
  const baseStrong = base.notes.filter(n => n.velocity >= 0.9).map(n => n.start);
  const newStrong = accents.notes.filter(n => n.velocity >= 0.9).map(n => n.start);
  assert.notDeepEqual(newStrong, baseStrong, 'variação de acentos desloca as notas fortes');

  const pitch = partialVariant(base, 'pitch');
  assert.notDeepEqual(pitch.notes.map(n => n.pitch), base.notes.map(n => n.pitch));

  for (const dimension of VARIANT_DIMENSIONS) {
    const variant = partialVariant(base, dimension.id);
    assert.equal(variant.changed, dimension.id);
    assert.equal(variant.parentSeed, base.seed);
    assert.equal(variant.objective, base.objective);
  }
  assert.throws(() => partialVariant(base, 'inexistente'), /Dimensão desconhecida/);
});

test('partialVariant: com frase da sessão, variações diretas continuam musicais', () => {
  const session = {
    notes: [
      { id: 'a', start: 0, duration: 4, pitch: 69, velocity: 0.8 },
      { id: 'b', start: 4, duration: 4, pitch: 71, velocity: 0.8 },
      { id: 'c', start: 8, duration: 4, pitch: 72, velocity: 0.8 },
      { id: 'd', start: 12, duration: 4, pitch: 74, velocity: 0.8 },
    ],
    bpm: 90,
    bars: 1,
    meter: { beats: 4, unit: 4 },
  };
  const base = generateExercise({ objective: 'timing', seed: 1, source: 'session', session });
  const thinner = partialVariant(base, 'attacks');
  assert.ok(thinner.notes.length < base.notes.length);
  const lower = partialVariant(base, 'pitch');
  assert.deepEqual(lower.notes.map(note => note.pitch), base.notes.map(note => note.pitch - 5));
  const faster = partialVariant(base, 'tempo');
  assert.equal(faster.bpm, 98);
});

// ---------------------------------------------------------------------------
// Avaliação e adaptação de tempo
// ---------------------------------------------------------------------------

test('evaluation uses frozen Engine results and treats silence as missed notes', () => {
  const session = createSession({ bars: 1, bpm: 120, notes: [{ id: 'n', start: 0, duration: 4 }], training: { repetitions: 2 } });
  const attempts = [{ start: 0, end: 0.5 }, { start: 2, end: 2.5 }];
  const results = evaluateSession(session, attempts);
  const evaluation = evaluationFromDetail({ session, results }, [], createSession());
  assert.equal(evaluation.summary.expected, 2);
  assert.equal(evaluation.summary.matched, 2);
  const silence = evaluationFromDetail({ session }, [], session);
  assert.equal(silence.summary.matched, 0);
  assert.equal(silence.summary.missed, 2);
  assert.equal(objectiveMetric('rests', { ...silence, notes: session.notes }), 0);
});

test('objectiveMetric: uma métrica por objetivo, sem nota única', () => {
  const notes = [
    { id: 'on', start: 0, duration: 2, pitch: 69, velocity: 0.95 },
    { id: 'off', start: 2, duration: 1, pitch: 69, velocity: 0.5 },
  ];
  const rows = [
    { kind: 'matched', noteId: 'on', onset: 'ok' },
    { kind: 'matched', noteId: 'off', onset: 'early' },
    { kind: 'extra' },
  ];
  const summary = makeSummary({ expected: 2, matched: 2, missed: 0, extra: 1, attackOk: 1, endOk: 2 });
  assert.equal(objectiveMetric('timing', { rows, summary, notes }), 0.5);
  assert.equal(objectiveMetric('durations', { rows, summary, notes }), 1);
  assert.equal(objectiveMetric('rests', { rows, summary, notes }), 0.5);
  // acentos: só a nota forte conta (1 esperada, 1 ok)
  assert.equal(objectiveMetric('accents', { rows, summary, notes }), 1);
  // síncope: só a nota fora do tempo forte conta (1 esperada, 0 ok)
  assert.equal(objectiveMetric('syncopation', { rows, summary, notes }), 0);
  const pulseRows = [
    { kind: 'matched', onset: 'ok', repetition: 1 },
    { kind: 'matched', onset: 'ok', repetition: 2 },
  ];
  assert.ok(objectiveMetric('inner-pulse', { rows: pulseRows, summary, notes }) > 0);
});

test('adaptTempo: critérios claros e observáveis, sem nota estética', () => {
  const sobe = adaptTempo(100, makeSummary(), { tempoStep: 4 });
  assert.equal(sobe.bpmDelta, 4);
  assert.equal(sobe.nextBpm, 104);
  assert.equal(sobe.zone, 'desafio');

  const desce = adaptTempo(100, makeSummary({ expected: 10, matched: 5, attackOk: 4 }), { tempoStep: 4 });
  assert.equal(desce.bpmDelta, -4);
  assert.equal(desce.zone, 'conforto');

  const mantem = adaptTempo(100, makeSummary({ expected: 10, matched: 8, attackOk: 8 }), { tempoStep: 4 });
  assert.equal(mantem.bpmDelta, 0);
  assert.equal(mantem.zone, 'prática');

  const teto = adaptTempo(300, makeSummary(), { tempoStep: 4 });
  assert.equal(teto.nextBpm, 300);
  assert.equal(adaptTempo(298, makeSummary(), { tempoStep: 4 }).bpmDelta, 2);
  assert.equal(adaptTempo(100, makeSummary({ expected: 0, matched: 0, attackOk: 0 })).nextBpm, 100);

});

// ---------------------------------------------------------------------------
// Revisão espaçada
// ---------------------------------------------------------------------------

test('nextReview: intervalo cresce com qualidade e reinicia sem punição dramática', () => {
  const now = Date.parse('2026-02-01T10:00:00Z');
  const first = nextReview(createSkill(now), 5, now);
  assert.equal(first.repetitions, 1);
  assert.equal(first.intervalDays, 1);
  assert.equal(first.dueAt, now + 86400000);

  const second = nextReview(first, 4, first.dueAt);
  assert.equal(second.repetitions, 2);
  assert.equal(second.intervalDays, 3);

  const third = nextReview(second, 4, second.dueAt);
  assert.equal(third.repetitions, 3);
  assert.ok(third.intervalDays >= 6, 'intervalo dobra aproximadamente pela facilidade');

  const lapse = nextReview(third, 1, third.dueAt);
  assert.equal(lapse.repetitions, 0);
  assert.equal(lapse.lapses, 1);
  assert.equal(lapse.intervalDays, 1);
  assert.equal(performanceQuality(0.92), 5);
  assert.equal(performanceQuality(0.5), 3);
  assert.equal(performanceQuality(0.1), 1);
});

test('reviewQueue: objetivos sem dados ficam devidos e a fila é estável', () => {
  const skills = { timing: { ease: 2.5, intervalDays: 30, repetitions: 5, lapses: 0, dueAt: Date.now() + 30 * 86400000, lastAt: Date.now() } };
  const queue = reviewQueue(skills);
  assert.equal(queue.at(-1).objective.id, 'timing');
  assert.equal(queue.at(-1).due, false);
  assert.ok(queue.slice(0, -1).every(entry => entry.due));
  assert.equal(queue.length, OBJECTIVES.length);
});

// ---------------------------------------------------------------------------
// Estado persistido
// ---------------------------------------------------------------------------

test('validação e persistência: ida e volta, corrompidos preservados, entradas saneadas', () => {
  const storage = memoryStorage();
  const state = createPracticeState();
  state.objective = 'rests';
  const run = makeAttemptRun('rests');
  assert.equal(recordRun(state, run).recorded, true);
  assert.equal(recordRun(state, run).recorded, false, 'registro é idempotente por id');

  assert.equal(savePracticeState(state, storage), true);
  const loaded = loadPracticeState(storage);
  assert.equal(loaded.state.objective, 'rests');
  assert.equal(loaded.state.history.length, 1);
  assert.equal(loaded.recoveryRaw, null);
  assert.ok(loaded.state.skills.rests, 'skill do objetivo atualizada pela tentativa');

  storage.setItem(PRACTICE_STORAGE_KEY, '{isto não é json');
  const corrupt = loadPracticeState(storage);
  assert.equal(corrupt.state.history.length, 0);
  assert.equal(corrupt.recoveryRaw, '{isto não é json');
  assert.ok(corrupt.warnings.length > 0);
  assert.equal(savePracticeState(corrupt.state, storage), true);
  assert.equal(storage.getItem(`${PRACTICE_STORAGE_KEY}.recovery`), '{isto não é json');

  storage.setItem(PRACTICE_STORAGE_KEY, JSON.stringify({ version: 99 }));
  const invalid = loadPracticeState(storage);
  assert.equal(invalid.recoveryRaw, JSON.stringify({ version: 99 }));

  const saneado = validatePracticeState({
    version: 1,
    objective: 'timing',
    routine: { stages: ['listen', 'fake-stage', 'imitate'] },
    history: [makeAttemptRun('timing'), makeAttemptRun('bogus-objective'), { nope: true }],
  });
  assert.equal(saneado.ok, true);
  assert.equal(saneado.state.routine.stages.length, 2);
  assert.equal(saneado.state.history.length, 1);
  assert.ok(saneado.warnings.length >= 1);

  assert.equal(validateRunEntry({ id: 'x', at: 'não-data', kind: 'attempt', objective: 'timing', bpm: 100 }).ok, false);
  assert.equal(validateRunEntry({ id: 'x', at: '2026-01-01T00:00:00Z', kind: 'attempt', objective: 'fantasia', bpm: 100 }).ok, false);
  assert.equal(validatePracticeState({ version: 1, history: 'corrompido' }).ok, false);
  assert.equal(validateRunEntry({ ...makeAttemptRun(), at: 1e20 }).ok, false);
  assert.equal(validateRunEntry({ id: 'x', at: '2026-01-01T00:00:00Z', kind: 'ear', objective: 'ear-interval', bpm: 100, metrics: { correct: 1 } }).ok, true);
});

test('importRuns robusto: ignora inválidos, deduplica, ordena e não corrompe', () => {
  const state = createPracticeState();
  recordRun(state, makeAttemptRun('timing'));
  const result = importRuns(state, [
    makeAttemptRun('timing'),
    { ...makeAttemptRun('syncopation', { objectiveScore: 60 }), id: 'run-novo-1' },
    { id: 'quebrado', at: 'amanhã', kind: 'attempt', objective: 'timing', bpm: 100 },
    null,
  ]);
  assert.equal(result.added, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.skipped, 2);
  assert.equal(state.history.length, 2);
  const arraySolto = importRuns(state, []);
  assert.equal(arraySolto.added, 0);
  assert.equal(importRuns(state, 'não-array').warnings.length, 1);
});

test('exclusões: individual, por objetivo e total, com totais derivados', () => {
  const state = createPracticeState();
  recordRun(state, makeAttemptRun('timing'));
  recordRun(state, { ...makeAttemptRun('syncopation'), id: 'run-2' });
  recordRun(state, { ...makeAttemptRun('syncopation'), id: 'run-3', at: '2026-01-06T12:00:00Z' });
  recordRun(state, {
    id: 'creative-1', at: '2026-01-07T12:00:00Z', kind: 'creative', objective: 'timing', stage: 'Improvisar',
    bpm: 100, bars: 1, durationSec: 30, notes: [], metrics: { expected: 0, matched: 0, missed: 0, extra: 0, attackOk: 0, endOk: 0, objectiveScore: 0 }, tempoDelta: 0,
  });
  assert.equal(deleteRun(state, 'run-2'), true);
  assert.equal(deleteRun(state, 'run-2'), false);
  const totals = practiceTotals(state);
  assert.equal(totals.runs, 3);
  assert.equal(totals.attemptRuns, 2);
  assert.equal(totals.creativeRuns, 1);
  assert.equal(totals.totalSeconds, 54);

  const progress = objectiveProgress(state, 'syncopation');
  assert.equal(progress.runs, 1);
  assert.equal(progress.bestScore, 75);

  const removed = deleteObjectiveData(state, 'syncopation');
  assert.equal(removed.historyRemoved, 1);
  assert.equal(removed.skillRemoved, true);
  assert.equal(clearHistory(state), 2);
  assert.equal(state.history.length, 0);
});

// ---------------------------------------------------------------------------
// Jogos de ouvido
// ---------------------------------------------------------------------------

test('jogos de ouvido: questões determinísticas com resposta e distratores', () => {
  const a = generateIntervalQuestion(9);
  const b = generateIntervalQuestion(9);
  assert.deepEqual(a, b);
  assert.equal(a.options.length, 4);
  assert.ok(a.options.includes(a.answer));
  assert.equal(a.referenceNotes[1].pitch, a.root + a.interval.semitones);
  assert.ok(a.togetherNotes.every(note => note.start === 0), 'ouvir junto toca as duas simultâneas');
  const interval = INTERVALS.find(item => item.name === a.answer);
  assert.equal(a.answer, interval.name);

  const chord = generateChordFunctionQuestion(4);
  assert.deepEqual(chord, generateChordFunctionQuestion(4));
  assert.equal(chord.options.length, CHORD_FUNCTIONS.length);
  assert.ok(chord.options.includes(chord.answer));
  assert.equal(chord.referenceNotes.length, 6);

  const rhythm = generateRhythmQuestion(21);
  assert.deepEqual(chord.referenceNotes.slice(3).map(note => note.pitch), chord.target.semitones.map(offset => chord.root + offset));
  assert.deepEqual(rhythm, generateRhythmQuestion(21));
  assert.ok(rhythm.onsets.length > 0);
  const exact = checkRhythmAnswer(rhythm, rhythm.onsets);
  assert.equal(exact.correct, true);
  const quase = checkRhythmAnswer(rhythm, rhythm.onsets.slice(0, -1));
  assert.equal(quase.correct, false);
  assert.equal(quase.missed.length, 1);
  const extraTick = Array.from({ length: 16 }, (_, tick) => tick).find(tick => !rhythm.onsets.includes(tick));
  const extra = checkRhythmAnswer(rhythm, [...rhythm.onsets, extraTick]);
  assert.deepEqual(extra.extra, [extraTick]);
});

test('execution identity deduplicates delivery, not independent identical performances', () => {
  const attempts = [{ start: 0.1, end: 0.5 }, { start: 2.4, end: 2.8 }];
  assert.equal(runId(attempts, 100), runId(attempts, 100));
  assert.notEqual(runId(attempts, 100), runId(attempts.map(note => ({ ...note })), 100));
});

test('generated exercises and one-dimension variants are valid Engine phrases', () => {
  for (const objective of OBJECTIVES) {
    const exercise = generateExercise({ objective: objective.id, seed: 42, bars: 2 });
    for (const candidate of [exercise, ...VARIANT_DIMENSIONS.map(dimension => partialVariant(exercise, dimension.id))]) {
      assert.equal(validateSession(createSession({ notes: candidate.notes, bars: candidate.bars, meter: candidate.meter })).ok, true);
    }
  }
});

