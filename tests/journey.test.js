// Percurso: panorama (união de fontes, dias locais, instrumentos, ranking) e
// preservação do legado (exportar/apagar sem perder registros nem revisões).
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, parseSession, serializeSession } from '../src/session.js';
import { createExerciseLibrary } from '../src/exercise-library.js';
import { createPracticeState, clearHistory, deleteRun, importRuns } from '../src/practice.js';
import { localDayKey, startOfLocalDay } from '../src/history-time.js';
import { journeyOverview, legacyEntryExportPayload, legacyExportPayload, legacyHistoryEntries } from '../src/practice-view.js';
import { memoryStorage } from './storage-fixture.js';

const HOUR = 3600000;
const MINUTE = 60000;

// Perfil de instrumento explícito: a sessão do app sempre traz um, e o
// Percurso NUNCA chuta o instrumento de um registro (sem perfil = sem
// atribuição por categoria).
const GUITAR = { type: 'guitar', strings: 6, tuning: [40, 45, 50, 55, 59, 64], noteNames: 'letters' };

function sessionOf(name, bpm, bars) {
  return createSession({ name, bpm, bars, extensions: { studio: { instrument: { ...GUITAR, tuning: [...GUITAR.tuning] } } } });
}

function fixedClock(startMs) {
  const state = { time: startMs };
  return { now: () => new Date(state.time).toISOString(), advance: ms => { state.time += ms; }, time: () => state.time };
}

let uuidCount = 0;
function openLibrary(storage, session, clock) {
  return createExerciseLibrary({
    storage, parse: parseSession, serialize: serializeSession, currentSession: session,
    now: clock.now, uuid: () => `ex-${++uuidCount}`,
  });
}

test('panorama une activity e registro avaliado sem contar o mesmo treino duas vezes', () => {
  const base = startOfLocalDay(Date.parse('2026-10-20T12:00:00Z')) + 10 * HOUR;
  const clock = fixedClock(base);
  const session = sessionOf('Groove', 120, 4);
  const library = openLibrary(memoryStorage(), session, clock);
  const exerciseId = library.active();
  const context = library.captureRunContext(session);
  clock.advance(10 * MINUTE);
  library.recordRun(context, { bpm: 120, summary: { expected: 32, attackOk: 30, mode: 'strict' }, metric: 0.94 });

  const bassStart = startOfLocalDay(base) - 4 * HOUR;
  const activity = {
    list: () => [
      { id: 'trainer-1', exerciseId, instrument: 'guitar', source: 'trainer', mode: 'evaluated', startedAt: new Date(base).toISOString(), endedAt: new Date(base + 12 * MINUTE).toISOString() },
      { id: 'today-1', exerciseId, instrument: 'guitar', source: 'today', mode: 'practice', startedAt: new Date(base + 5 * MINUTE).toISOString(), endedAt: new Date(base + 15 * MINUTE).toISOString() },
      { id: 'today-bass', exerciseId: 'outro', instrument: 'bass', source: 'today', mode: 'practice', startedAt: new Date(bassStart).toISOString(), endedAt: new Date(bassStart + 30 * MINUTE).toISOString() },
      { id: 'quebrado', exerciseId: 'outro', instrument: 'guitar', source: 'today', mode: 'practice', startedAt: 'nao-e-data', endedAt: 'nao-e-data' },
    ],
  };
  const overview = journeyOverview({ library, activity, now: base + 4 * HOUR, days: 28 });
  assert.equal(overview.intervals, 4, 'intervalo inválido não entra');
  assert.equal(overview.recordsWithInterval, 1);
  assert.equal(overview.days.totalMs, 45 * MINUTE, '15 min unidos + 30 min de baixo');
  assert.equal(overview.days.byDay.at(-1).dayKey, localDayKey(base));
  assert.equal(overview.days.byDay.at(-1).ms, 15 * MINUTE);
  assert.equal(overview.instruments.guitar.ms, 15 * MINUTE);
  assert.equal(overview.instruments.bass.ms, 30 * MINUTE);
  assert.equal(overview.instruments.unknown.ms, 0);
  assert.deepEqual(overview.sources, { trainer: 1, today: 2, record: 1, unknown: 0 });
  assert.equal(overview.ranking.length, 1, 'só o exercício com treino autoral aparece');
  assert.equal(overview.ranking[0].bestBpm, 120);
});

test('panorama funciona só com a biblioteca quando a fila de Hoje ainda não publicou intervalos', () => {
  const base = startOfLocalDay(Date.parse('2026-10-20T12:00:00Z')) + 9 * HOUR;
  const clock = fixedClock(base);
  const session = sessionOf('Escala', 90, 2);
  const library = openLibrary(memoryStorage(), session, clock);
  // Sem armazenamento legado o alvo nasce indefinido: o ranking só mede
  // progresso quando o exercício tem alvo definido.
  library.updateMetadata(library.active(), { targetBPM: 90 });
  const context = library.captureRunContext(session);
  clock.advance(20 * MINUTE);
  library.recordRun(context, { bpm: 90, summary: { expected: 16, attackOk: 16, mode: 'strict' } });
  const overview = journeyOverview({ library, activity: null, now: base + HOUR, days: 28 });
  assert.equal(overview.days.totalMs, 20 * MINUTE);
  assert.equal(overview.instruments.guitar.ms, 20 * MINUTE);
  assert.equal(overview.ranking[0].progress, 1);
});

test('exportação do legado preserva todo registro e volta pela importação', () => {
  const state = createPracticeState();
  state.objective = 'timing';
  state.history = [
    legacyRun('run-1', '2026-10-01T10:00:00.000Z', 'timing'),
    legacyRun('run-2', '2026-10-02T10:00:00.000Z', 'durations'),
    { id: 'run-ear', at: '2026-10-03T10:00:00.000Z', kind: 'ear', objective: 'ear-interval', stage: 'ouvido', bpm: 100, bars: 1, durationSec: 0, notes: [], metrics: { expected: 0, matched: 0, missed: 0, extra: 0, attackOk: 0, endOk: 0, objectiveScore: 0, correct: 1, pitchCorrect: 0, pitchWrong: 0, pitchUnidentified: 0, pitchOctave: 0 }, tempoDelta: 0 },
  ];
  const payload = legacyExportPayload(state, () => '2026-10-06T00:00:00.000Z');
  assert.equal(payload.kind, 'groovegoblin.practice-history');
  assert.equal(payload.objective, 'timing');
  assert.deepEqual(payload.history, state.history, 'todos os campos de todos os registros são exportados');
  const fresh = createPracticeState();
  const result = importRuns(fresh, payload.history);
  assert.deepEqual(result, { added: 3, skipped: 0, duplicates: 0, warnings: [] });
  assert.deepEqual(fresh.history.map(entry => entry.id), state.history.map(entry => entry.id));
  const one = legacyEntryExportPayload(state.history[0]);
  assert.equal(one.kind, 'groovegoblin.practice-history-entry');
  assert.deepEqual(importRuns(createPracticeState(), [one.entry]).added, 1);
});

test('limpeza explícita apaga registros e PRESERVA revisões espaçadas e metadados', () => {
  const state = createPracticeState();
  state.skills = { timing: { ease: 2.5, intervalDays: 3, repetitions: 2, lapses: 0, dueAt: 1, lastAt: 0 } };
  state.history = [legacyRun('run-1', '2026-10-01T10:00:00.000Z', 'timing'), legacyRun('run-2', '2026-10-02T10:00:00.000Z', 'timing')];
  assert.equal(deleteRun(state, 'run-1'), true);
  assert.deepEqual(state.history.map(entry => entry.id), ['run-2']);
  assert.equal(deleteRun(state, 'inexistente'), false);
  const removed = clearHistory(state);
  assert.equal(removed, 1);
  assert.equal(state.history.length, 0);
  assert.equal(state.skills.timing.intervalDays, 3, 'a revisão espaçada continua valendo depois da limpeza');
  assert.equal(typeof legacyExportPayload(state).history.length, 'number');
});

test('lista de anteriores é entregue do mais novo para o mais antigo, sem reordenar por data', () => {
  const state = createPracticeState();
  state.history = [legacyRun('run-1', '2026-10-01T10:00:00.000Z'), legacyRun('run-2', '2026-10-05T10:00:00.000Z')];
  assert.deepEqual(legacyHistoryEntries(state).map(entry => entry.id), ['run-2', 'run-1']);
  assert.deepEqual(legacyHistoryEntries(createPracticeState()), []);
});

function legacyRun(id, at, objective = 'timing') {
  return {
    id, at, kind: 'attempt', objective, stage: 'tocar', bpm: 120, bars: 4, durationSec: 300, notes: [],
    metrics: { expected: 16, matched: 14, missed: 2, extra: 0, attackOk: 14, endOk: 12, objectiveScore: 80, pitchCorrect: 0, pitchWrong: 0, pitchUnidentified: 0, pitchOctave: 0 },
    tempoDelta: 2,
  };
}
