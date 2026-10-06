// Fronteiras de dados e transição do treinador único: as seis combinações
// fonte×modo, o avanço de etapas, a sugestão de andamento (nunca automática) e
// a gravação compartilhada do estado legado. Sem DOM, redação ou mocks de
// encaminhamento.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRAINER_MODES, TRAINER_SOURCES, advanceStage, trainerRun } from '../src/practice-trainer.js';
import { tempoSuggestion } from '../src/result-summary.js';
import {
  createPracticeState,
  loadPracticeState,
  recordRun,
  recordSkillReview,
  updatePracticeState,
  PRACTICE_STORAGE_KEY,
} from '../src/practice.js';
import { memoryStorage } from './storage-fixture.js';

test('as seis combinações fonte×modo descrevem exatamente o que o Engine executa', () => {
  assert.deepEqual(TRAINER_SOURCES.map(item => item.id), ['session', 'generated']);
  assert.deepEqual(TRAINER_MODES.map(item => item.id), ['evaluated', 'together', 'routine']);
  const combos = [];
  for (const source of TRAINER_SOURCES) {
    for (const mode of TRAINER_MODES) combos.push(trainerRun(source.id, mode.id));
  }
  assert.equal(combos.length, 6);
  assert.deepEqual(combos[0], { material: 'session', evaluated: true, together: false, routine: false, loops: false, evaluatedStage: true });
  assert.deepEqual(combos[1], { material: 'session', evaluated: false, together: true, routine: false, loops: true, evaluatedStage: false });
  assert.deepEqual(combos[2], { material: 'session', evaluated: false, together: false, routine: true, loops: true, evaluatedStage: true });
  assert.deepEqual(combos[3], { material: 'generated', evaluated: true, together: false, routine: false, loops: false, evaluatedStage: true });
  assert.deepEqual(combos[4], { material: 'generated', evaluated: false, together: true, routine: false, loops: true, evaluatedStage: false });
  assert.deepEqual(combos[5], { material: 'generated', evaluated: false, together: false, routine: true, loops: true, evaluatedStage: true });
  assert.throws(() => trainerRun('imported', 'evaluated'), RangeError);
  assert.throws(() => trainerRun('session', 'freeform'), RangeError);
});

test('avanço de etapa: última etapa conclui, lista vazia já nasce concluída, índices inválidos não escapam', () => {
  assert.deepEqual(advanceStage(2, 0), { index: 1, done: false });
  assert.deepEqual(advanceStage(2, 1), { index: 2, done: true });
  assert.deepEqual(advanceStage(1, 0), { index: 1, done: true });
  assert.deepEqual(advanceStage(0, 0), { index: 0, done: true });
  assert.deepEqual(advanceStage(3, 9), { index: 3, done: true });
  assert.deepEqual(advanceStage(3, -4), { index: 1, done: false });
  assert.deepEqual(advanceStage(Number.NaN, Number.NaN), { index: 0, done: true });
});

test('sugestão de andamento: ≥90% sugere +4, <70% sugere −4, o resto mantém, e nada é aplicado', () => {
  const evaluated = ratio => ({ ratio, verdict: { kind: 'attacks', ok: 1, expected: 1 } });
  assert.deepEqual(tempoSuggestion(evaluated(0.9), 120), { direction: 'up', delta: 4, bpm: 124, ratio: 0.9 });
  assert.deepEqual(tempoSuggestion(evaluated(1), 120), { direction: 'up', delta: 4, bpm: 124, ratio: 1 });
  assert.deepEqual(tempoSuggestion(evaluated(0.69), 120), { direction: 'down', delta: -4, bpm: 116, ratio: 0.69 });
  // A zona de prática (70%–89%) mantém o andamento.
  assert.equal(tempoSuggestion(evaluated(0.7), 120), null, 'a zona de prática mantém o andamento');
  assert.equal(tempoSuggestion(evaluated(0.8), 120), null);
  assert.equal(tempoSuggestion(evaluated(0.89), 120), null);
  // Execução livre e trecho sem notas esperadas não recebem sugestão.
  assert.equal(tempoSuggestion({ ratio: 1, verdict: { kind: 'free', ok: 3, count: 3 } }, 120), null);
  assert.equal(tempoSuggestion({ ratio: null, verdict: { kind: 'empty', ok: 0, expected: 0 } }, 120), null);
  // Bem abaixo de 70% a sugestão continua sendo descer 4 BPM.
  assert.deepEqual(tempoSuggestion(evaluated(0.5), 120), { direction: 'down', delta: -4, bpm: 116, ratio: 0.5 });
  // Limites do andamento não inventam uma sugestão impossível.
  assert.equal(tempoSuggestion(evaluated(0.95), 300), null);
  assert.equal(tempoSuggestion(evaluated(0.5), 30), null);
  assert.equal(tempoSuggestion(evaluated(0.5), 33).bpm, 30);
  assert.equal(tempoSuggestion(evaluated(0.99), 297).bpm, 300);
  assert.equal(tempoSuggestion(evaluated(0.4), 32).bpm, 30);
  assert.equal(tempoSuggestion(evaluated(0.99), Number.NaN), null);
});

test('revisão espaçada avança por objetivo sem registrar treino', () => {
  const state = createPracticeState();
  assert.equal(recordSkillReview(state, 'improviso-livre', 0.95, 1000), null, 'objetivo inexistente não cria revisão');
  const first = recordSkillReview(state, 'timing', 0.95, 1000);
  assert.equal(first.repetitions, 1);
  assert.equal(first.intervalDays, 1);
  const second = recordSkillReview(state, 'timing', 0.0, 2000);
  assert.equal(second.repetitions, 0, 'desempenho fraco reinicia o intervalo');
  assert.equal(second.lapses, 1);
  assert.equal(state.history.length, 0, 'agendar revisão não escreve histórico');
});

test('updatePracticeState grava a leitura fresca: um consumidor não ressuscita o snapshot do outro', () => {
  const storage = memoryStorage();
  const first = updatePracticeState(storage, state => { state.objective = 'durations'; return state.objective; });
  assert.equal(first.saved, true);
  assert.equal(first.value, 'durations');
  // Consumidor B (jogos de ouvido) grava um registro depois do snapshot de A.
  const ear = { id: 'ear-1', at: new Date().toISOString(), kind: 'ear', objective: 'ear-interval', stage: 'ouvido', bpm: 90, bars: 1, metrics: { expected: 1, matched: 1, attackOk: 1, endOk: 1, objectiveScore: 100, correct: 1 } };
  updatePracticeState(storage, state => recordRun(state, ear));
  // A grava de novo sem ver o registro de B, mas a leitura fresca o preserva.
  updatePracticeState(storage, state => { state.routine.memorizeSilentBars = 3; });
  const fresh = loadPracticeState(storage).state;
  assert.equal(fresh.history.length, 1);
  assert.equal(fresh.history[0].id, 'ear-1');
  assert.equal(fresh.routine.memorizeSilentBars, 3);
  assert.equal(fresh.objective, 'durations');
});

test('estado legado corrompido: bytes originais preservados na recuperação antes de qualquer gravação', () => {
  const raw = '{corrompido';
  const storage = memoryStorage(new Map([[PRACTICE_STORAGE_KEY, raw]]));
  const result = updatePracticeState(storage, state => { state.routine.memorizeSilentBars = 5; });
  assert.equal(result.saved, true);
  assert.equal(storage.getItem(`${PRACTICE_STORAGE_KEY}.recovery`), raw, 'bytes originais preservados antes de gravar');
  assert.equal(loadPracticeState(storage).state.routine.memorizeSilentBars, 5);
  const info = loadPracticeState(memoryStorage(new Map([[PRACTICE_STORAGE_KEY, raw]])));
  assert.equal(info.recoveryRaw, raw);
  assert.ok(info.warnings.some(text => /corrompid/i.test(text)));
  assert.ok(result.warnings.some(text => /corrompid/i.test(text)), 'o aviso chega ao consumidor');
});

test('mutação que lança não deixa o estado legado meio gravado', () => {
  const storage = memoryStorage();
  updatePracticeState(storage, state => { state.objective = 'rests'; });
  const before = storage.getItem(PRACTICE_STORAGE_KEY);
  const result = updatePracticeState(storage, () => { throw new Error('falha do consumidor'); });
  assert.equal(result.saved, false);
  assert.ok(result.error instanceof Error);
  assert.equal(storage.getItem(PRACTICE_STORAGE_KEY), before);
});
