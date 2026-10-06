// Histórico por exercício: separação autoral x gerado, aproveitamento, duração
// real (nunca inventada) e exportação integral. Sem DOM e sem asserções de
// aparência: só derivação determinística a partir dos registros salvos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { materialKey, referenceFingerprint } from '../src/exercise-library.js';
import {
  accuracyPoints,
  authoredMaterialKey,
  bpmPoints,
  exerciseProgress,
  formatDuration,
  historyExportPayload,
  historySummary,
  progressRanking,
  recordDuration,
  runRows,
} from '../src/exercise-history.js';

function sessionA() {
  return createSession({ name: 'Arpejos', bpm: 120, bars: 4 });
}

function generatedKeyFor(session) {
  return materialKey({
    referenceFingerprint: referenceFingerprint(session, { goal: null, repetitions: null }),
    goal: null,
    repetitions: null,
    source: 'generated',
  });
}

let counter = 0;
function record(patch = {}) {
  counter += 1;
  return {
    id: patch.id ?? `r-${counter}`,
    ownerId: 'ex-1',
    startedAt: patch.startedAt ?? null,
    endedAt: patch.endedAt ?? null,
    durationMs: patch.durationMs ?? null,
    // `bpm: null` é um registro SEM BPM (não pode virar 0 nem ganhar um valor
    // padrão): por isso a presença do campo decide, não o `??`.
    bpm: Object.hasOwn(patch, 'bpm') ? patch.bpm : 120,
    mode: patch.mode ?? 'train',
    source: patch.source ?? 'authored',
    goal: null,
    repetitions: null,
    referenceFingerprint: '',
    materialKey: patch.materialKey ?? '',
    metric: patch.metric ?? null,
    summary: {
      mode: 'strict', expected: 32, attackOk: 32, endOk: 0, pitchOk: 0, pitchChecked: 0, free: 0,
      ...(patch.summary ?? {}),
    },
  };
}

function entryOf(records, { targetBPM = null } = {}) {
  const session = sessionA();
  return {
    id: 'ex-1',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    session,
    metadata: { name: session.name, tags: [], targetBPM: targetBPM ?? session.bpm, notes: '', records },
  };
}

test('material gerado nunca avança o melhor BPM nem o alvo autoral', () => {
  const session = sessionA();
  const key = authoredMaterialKey(session);
  const generated = generatedKeyFor(session);
  const records = [
    record({ id: 'a1', bpm: 120, materialKey: key, startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:10:00.000Z' }),
    record({ id: 'g1', bpm: 200, source: 'generated', materialKey: generated, startedAt: '2026-10-01T11:00:00.000Z', endedAt: '2026-10-01T11:10:00.000Z' }),
  ];
  const progress = exerciseProgress(entryOf(records));
  assert.equal(progress.attempts, 1);
  assert.equal(progress.generated, 1);
  assert.equal(progress.bestBpm, 120);
  assert.equal(progress.firstBpm, 120);
  assert.equal(progress.bpmGain, 0);
  assert.equal(progress.progress, 1);

  const onlyGenerated = exerciseProgress(entryOf([
    record({ bpm: 240, source: 'generated', materialKey: generated, startedAt: '2026-10-02T10:00:00.000Z', endedAt: '2026-10-02T10:10:00.000Z' }),
  ]));
  assert.equal(onlyGenerated.bestBpm, null, 'gerado não cria melhor BPM autoral');
  assert.equal(onlyGenerated.progress, 0);
  assert.equal(onlyGenerated.attempts, 0);
});

test('só a tentativa autoral com 80% ou mais vira melhor BPM; modo livre não conta', () => {
  const session = sessionA();
  const key = authoredMaterialKey(session);
  const records = [
    record({ id: 'baixo', bpm: 120, materialKey: key, summary: { expected: 32, attackOk: 20 } }),
    record({ id: 'bom', bpm: 124, materialKey: key, summary: { expected: 32, attackOk: 30 } }),
    record({ id: 'livre', bpm: 180, materialKey: key, mode: 'free', summary: { mode: 'free', expected: 0, attackOk: 0, free: 42 } }),
  ];
  const progress = exerciseProgress(entryOf(records));
  assert.equal(progress.attempts, 2, 'modo livre não tem denominador e não é tentativa autoral');
  assert.equal(progress.bestBpm, 124);
  assert.equal(progress.firstBpm, 120);
  assert.equal(progress.bpmGain, 4);
  const points = accuracyPoints(records);
  assert.equal(points.find(point => point.id === 'livre').percent, null);
  assert.equal(points.find(point => point.id === 'bom').percent, 94);
  assert.equal(points.find(point => point.id === 'baixo').percent, 63);
});

test('progressRanking usa progresso no alvo e ignora exercício sem treino autoral', () => {
  const session = sessionA();
  const key = authoredMaterialKey(session);
  const generated = generatedKeyFor(session);
  const cheio = entryOf([record({ bpm: 100, materialKey: key, startedAt: '2026-10-01T10:00:00.000Z' })], { targetBPM: 100 });
  const quase = entryOf([record({ bpm: 150, materialKey: key, startedAt: '2026-10-02T10:00:00.000Z' })], { targetBPM: 200 });
  const soGerado = entryOf([record({ bpm: 220, source: 'generated', materialKey: generated, startedAt: '2026-10-03T10:00:00.000Z' })], { targetBPM: 100 });
  const ranking = progressRanking([quase, soGerado, cheio], { limit: 8 });
  assert.deepEqual(ranking.map(row => row.id), ['ex-1', 'ex-1']);
  assert.deepEqual(ranking.map(row => row.progress), [1, 0.75]);
  assert.equal(ranking.length, 2, 'exercício sem execução autoral não entra no ranking');
  assert.equal(progressRanking([quase, cheio], { limit: 1 }).length, 1);
});

test('percentual vem da nota objetiva quando existe e da fração de ataques quando não', () => {
  const points = accuracyPoints([
    record({ id: 'nota', metric: 0.875, startedAt: '2026-10-01T10:00:00.000Z' }),
    record({ id: 'ataques', summary: { expected: 32, attackOk: 24 }, startedAt: '2026-10-02T10:00:00.000Z' }),
    record({ id: 'livre', mode: 'free', summary: { mode: 'free', expected: 0, free: 9 }, startedAt: '2026-10-03T10:00:00.000Z' }),
    record({ id: 'alta', metric: 1.4, startedAt: '2026-10-04T10:00:00.000Z' }),
  ]);
  assert.deepEqual(points.map(point => point.percent), [88, 75, null, 100]);
  assert.deepEqual(points.map(point => point.id), ['nota', 'ataques', 'livre', 'alta'], 'ordem cronológica');
  assert.equal(points[0].atMs, Date.parse('2026-10-01T10:00:00.000Z'));
});

test('duração sai do intervalo fechado; sem intervalo fica desconhecida', () => {
  assert.equal(recordDuration({ startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:05:00.000Z', durationMs: 999999 }), 300000);
  assert.equal(recordDuration({ startedAt: 'nao-e-data', endedAt: null, durationMs: 600000 }), 600000);
  assert.equal(recordDuration({ startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T09:00:00.000Z', durationMs: null }), null);
  assert.equal(recordDuration({}), null);
  assert.equal(formatDuration(0), null);
  assert.equal(formatDuration(45000), '45 s');
  assert.equal(formatDuration(150000), '2 min 30 s');
  assert.equal(formatDuration(3600000), '1 h 0 min');
});

test('linha de treino nunca inventa duração e mantém o registro visível', () => {
  const rows = runRows([
    record({ id: 'antigo', startedAt: null, endedAt: null, durationMs: null, bpm: 96 }),
    record({ id: 'recente', startedAt: '2026-10-05T10:00:00.000Z', endedAt: '2026-10-05T10:20:00.000Z', bpm: 132, metric: 0.5 }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'recente', 'mais recente primeiro');
  assert.equal(rows[0].durationText, '20 min');
  assert.equal(rows[0].percent, 50);
  assert.equal(rows[1].id, 'antigo');
  assert.equal(rows[1].durationText, null);
  assert.equal(rows[1].at, null);
  assert.equal(rows[1].accuracyText, '100%');
});

test('resumo separa fontes e só soma duração conhecida', () => {
  const session = sessionA();
  const key = authoredMaterialKey(session);
  const generated = generatedKeyFor(session);
  const records = [
    record({ id: 'a1', bpm: 100, materialKey: key, startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:10:00.000Z' }),
    record({ id: 'a2', bpm: 130, materialKey: key, startedAt: '2026-10-02T10:00:00.000Z', endedAt: '2026-10-02T10:20:00.000Z' }),
    record({ id: 'g1', bpm: 200, source: 'generated', materialKey: generated, startedAt: null, endedAt: null }),
  ];
  const summary = historySummary(records, session, { targetBPM: 150 });
  assert.equal(summary.total, 3);
  assert.equal(summary.authored, 2);
  assert.equal(summary.generated, 1);
  assert.equal(summary.knownDurationMs, 30 * 60000);
  assert.equal(summary.unknownDuration, 1);
  assert.equal(summary.bestBpm, 130);
  assert.equal(summary.targetBPM, 150);
  assert.equal(summary.lastAt, Date.parse('2026-10-02T10:00:00.000Z'));
});

test('pontos de BPM marcam a fonte e ignoram registro sem BPM', () => {
  const session = sessionA();
  const key = authoredMaterialKey(session);
  const generated = generatedKeyFor(session);
  const points = bpmPoints([
    record({ id: 'a', bpm: 120, materialKey: key, startedAt: '2026-10-01T10:00:00.000Z' }),
    record({ id: 'g', bpm: 200, source: 'generated', materialKey: generated, startedAt: '2026-10-02T10:00:00.000Z' }),
    record({ id: 'sem', bpm: null, materialKey: key, startedAt: '2026-10-03T10:00:00.000Z' }),
  ], session);
  assert.deepEqual(points.map(point => [point.id, point.authored, point.source]), [
    ['a', true, 'authored'],
    ['g', false, 'generated'],
  ]);
});

test('exportação do histórico preserva todos os campos de todos os registros', () => {
  const session = sessionA();
  const key = authoredMaterialKey(session);
  const records = [
    record({ id: 'a1', bpm: 120, materialKey: key, metric: 0.9, startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:10:00.000Z' }),
    record({ id: 'a2', bpm: 124, materialKey: key, metric: 0.4, startedAt: '2026-10-02T10:00:00.000Z', endedAt: '2026-10-02T10:10:00.000Z' }),
  ];
  const payload = JSON.parse(historyExportPayload(entryOf(records), { now: () => '2026-10-06T12:00:00.000Z' }));
  assert.equal(payload.kind, 'groovegoblin-exercise-history');
  assert.equal(payload.exportedAt, '2026-10-06T12:00:00.000Z');
  assert.equal(payload.exercise.name, 'Arpejos');
  assert.equal(payload.exercise.targetBPM, 120);
  assert.deepEqual(payload.records, records);
});
