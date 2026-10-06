import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage } from './storage-fixture.js';
import {
  createTodayStore, suggestQueue, queueTotalMs, itemTargetMs,
  TODAY_KEY, TODAY_RECOVERY_KEY, ROUTINES_KEY, ROUTINES_RECOVERY_KEY,
  LEGACY_TODAY_KEY, LEGACY_TODAY_BACKUP_KEY, LEGACY_TODAY_RECOVERY_KEY,
  LEGACY_ROUTINES_KEY, LEGACY_ROUTINES_BACKUP_KEY,
  DEFAULT_ITEM_MINUTES, MAX_ITEM_MINUTES, MAX_LESSON_MINUTES,
} from '../src/today-store.js';

function clockNow() {
  let time = Date.UTC(2026, 9, 6, 9, 0, 0);
  return () => (time += 1000);
}

let idCount = 0;
function nextUuid() { return `it-${++idCount}`; }

function open(storage) {
  return createTodayStore({ storage, now: clockNow(), uuid: nextUuid });
}

function row(id, extra = {}) {
  return {
    id, name: `Exercício ${id}`, instrument: 'guitar', bars: 2, bpm: 90, targetBPM: 120,
    bestBpm: null, lastTrainedAt: null, createdAt: '2026-01-01T00:00:00.000Z', ...extra,
  };
}

// ----- sugestão --------------------------------------------------------------

test('sugere antes os mais antigos sem treino e depois os mais longe do alvo', () => {
  const rows = [
    row('treinado-longe', { lastTrainedAt: '2026-09-01T00:00:00.000Z', bestBpm: 90, targetBPM: 200 }),
    row('novo', { createdAt: '2026-09-30T00:00:00.000Z' }),
    row('antigo', { createdAt: '2026-02-01T00:00:00.000Z' }),
    row('treinado-perto', { lastTrainedAt: '2026-09-20T00:00:00.000Z', bestBpm: 118, targetBPM: 120 }),
  ];
  assert.deepEqual(suggestQueue(rows).map(item => item.exerciseId), ['antigo', 'novo', 'treinado-longe', 'treinado-perto']);
  assert.equal(suggestQueue(rows)[0].durationMin, DEFAULT_ITEM_MINUTES);
});

test('sugestão desempata pelo alvo mais distante e nunca inventa itens sem id', () => {
  const rows = [
    row('a', { createdAt: '2026-02-01T00:00:00.000Z', bestBpm: 100, targetBPM: 110 }),
    row('b', { createdAt: '2026-02-01T00:00:00.000Z', bestBpm: 100, targetBPM: 180 }),
    row('sem-id', { id: undefined }),
  ];
  assert.deepEqual(suggestQueue(rows).map(item => item.exerciseId), ['b', 'a']);
  assert.deepEqual(suggestQueue(null), []);
});

// ----- fila -----------------------------------------------------------------

test('fila aceita itens repetidos, preserva a ordem e soma a meta', () => {
  const store = open(memoryStorage());
  store.setItems([
    { exerciseId: 'a', durationMin: 5 },
    { exerciseId: 'b', durationMin: 10 },
    { exerciseId: 'a', durationMin: 3 },
  ]);
  const items = store.items();
  assert.deepEqual(items.map(item => item.exerciseId), ['a', 'b', 'a']);
  assert.equal(new Set(items.map(item => item.id)).size, 3);
  assert.equal(queueTotalMs(items), (5 + 10 + 3) * 60000);
  assert.equal(store.totalMs(), 18 * 60000);
});

test('adicionar, reordenar, remover e duração por item respeitam limites', () => {
  const store = open(memoryStorage());
  store.addItem({ exerciseId: 'a' });
  store.addItem({ exerciseId: 'b', durationMin: 7 });
  store.addItem({ exerciseId: 'a' });
  const [first, second, third] = store.items();
  assert.equal(second.durationMin, 7);
  store.moveItem(third.id, -2);
  assert.deepEqual(store.items().map(item => item.exerciseId), ['a', 'a', 'b']);
  store.moveItem(first.id, -1);
  assert.deepEqual(store.items().map(item => item.exerciseId), ['a', 'a', 'b'], 'não passa do topo');
  store.setItemDuration(second.id, 500);
  assert.equal(store.items().find(item => item.id === second.id).durationMin, MAX_ITEM_MINUTES);
  store.setItemDuration(second.id, 0);
  assert.equal(store.items().find(item => item.id === second.id).durationMin, 1);
  assert.equal(itemTargetMs({ durationMin: 2 }), 120000);
  store.removeItem(second.id);
  assert.equal(store.items().length, 2);
  assert.throws(() => store.addItem({ exerciseId: '' }), TypeError);
});

test('fila e resumo sobrevivem à recarga, sem intervalo aberto', () => {
  const storage = memoryStorage();
  const first = open(storage);
  first.setItems([{ exerciseId: 'a', durationMin: 4 }]);
  const saved = first.session();
  assert.equal(saved, null);
  first.saveSession({
    id: 's1', queueId: first.queue().id, createdAt: '2026-10-06T09:00:00.000Z', activeIndex: 0,
    // Um estado com intervalo aberto NUNCA deve ser aceito como está: a loja
    // ignora campos vivos; retomar é sempre explícito.
    running: true, live: { startedAtMs: 1 },
    items: [{ id: 'i1', exerciseId: 'a', durationMin: 4, elapsedMs: 61000, practiced: true, name: 'A', instrument: 'guitar', startBpm: 90, endBpm: null, startedAt: '2026-10-06T09:00:00.000Z', finishedAt: null }],
    announced: ['i1'],
  });
  first.saveSummary({
    finishedAt: '2026-10-06T09:10:00.000Z', totalElapsedMs: 61000, plannedMs: 300000,
    items: [{ exerciseId: 'a', name: 'A', instrument: 'guitar', elapsedMs: 61000, plannedMs: 300000, bpm: { from: 90, to: 96 } }],
  });
  const second = open(storage);
  assert.deepEqual(second.items().map(item => item.exerciseId), ['a']);
  const session = second.session();
  assert.equal(session.items[0].elapsedMs, 61000);
  assert.equal(session.items[0].startBpm, 90);
  assert.equal('running' in session, false);
  assert.equal('live' in session, false);
  assert.deepEqual(session.announced, ['i1']);
  assert.equal(second.summary().items[0].bpm.to, 96);
});

test('BPM ausente continua ausente depois de gravar e recarregar', () => {
  const storage = memoryStorage();
  const first = open(storage);
  first.setItems([{ exerciseId: 'a', durationMin: 5 }]);
  first.saveSession({
    id: 's1', queueId: null, createdAt: '2026-10-06T09:00:00.000Z', activeIndex: 0, announced: [],
    items: [{ id: 'i1', exerciseId: 'a', durationMin: 5, elapsedMs: 0, practiced: false, name: 'A', instrument: 'guitar', startBpm: null, endBpm: null, startedAt: null, finishedAt: null }],
  });
  const restored = open(storage).session();
  assert.equal(restored.items[0].startBpm, null, 'null nunca vira 0');
  assert.equal(restored.items[0].endBpm, null);
  const summary = open(storage);
  summary.saveSummary({
    finishedAt: '2026-10-06T09:10:00.000Z', totalElapsedMs: 0, plannedMs: 300000,
    items: [{ exerciseId: 'a', name: 'A', instrument: 'guitar', elapsedMs: 0, plannedMs: 300000, bpm: { from: null, to: 0 } }],
  });
  assert.deepEqual(open(storage).summary().items[0].bpm, { from: null, to: 0 });
  assert.equal(open(storage).summary().items[0].practiced, false, 'item sem tempo fechado não conta como praticado');
});

// ----- corrupção / quota ------------------------------------------------------

test('fila corrompida fica preservada e só recupera sob ação explícita', () => {
  const storage = memoryStorage(new Map([[TODAY_KEY, '{"version":2,"queue":']]));
  const store = open(storage);
  assert.equal(store.status, 'corrupt');
  assert.equal(store.recoveryRaw, '{"version":2,"queue":');
  assert.equal(storage.getItem(TODAY_KEY), '{"version":2,"queue":', 'bytes originais intactos');
  assert.equal(storage.getItem(TODAY_RECOVERY_KEY), '{"version":2,"queue":');
  assert.equal(store.corruptOriginKey, TODAY_KEY);
  assert.throws(() => store.setItems([{ exerciseId: 'a' }]));
  assert.equal(store.replaceCorrupt(), true);
  assert.equal(store.status, 'ready');
  store.addItem({ exerciseId: 'a' });
  assert.equal(JSON.parse(storage.getItem(TODAY_KEY)).queue.items.length, 1);
  assert.equal(storage.getItem(TODAY_RECOVERY_KEY), '{"version":2,"queue":', 'recuperação preservada');
});

test('quota negada não apaga a fila anterior nem o estado em memória', () => {
  const storage = memoryStorage();
  const first = open(storage);
  first.setItems([{ exerciseId: 'a' }]);
  const before = storage.getItem(TODAY_KEY);
  const failing = memoryStorage(new Map([...storage._map]));
  failing.setItem = () => { throw new Error('QuotaExceededError'); };
  const store = open(failing);
  store.addItem({ exerciseId: 'b' });
  assert.equal(store.items().length, 2, 'trabalho continua na memória');
  assert.equal(store.saved, false);
  // Quota negada não é corrupção: a loja segue utilizável em memória.
  assert.equal(store.status, 'ready');
  assert.equal(failing.getItem(TODAY_KEY), before, 'bytes anteriores intactos');
  // Recuperação futura: com espaço de novo, o estado acumulado é gravado.
  failing.setItem = (key, value) => { failing._map.set(key, String(value)); };
  store.addItem({ exerciseId: 'c' });
  assert.equal(store.saved, true);
  assert.equal(store.warning, null);
  assert.deepEqual(JSON.parse(failing.getItem(TODAY_KEY)).queue.items.map(item => item.exerciseId), ['a', 'b', 'c']);
});

test('rotinas nomeadas recriam a fila em um clique e não duplicam por nome', () => {
  const storage = memoryStorage();
  const first = open(storage);
  first.setItems([{ exerciseId: 'a', durationMin: 6 }, { exerciseId: 'a', durationMin: 2 }]);
  const routine = first.saveRoutine('Pesado', first.items());
  assert.equal(routine.name, 'Pesado');
  first.setItems([{ exerciseId: 'b' }]);
  first.saveRoutine('Pesado', first.items());
  assert.equal(first.routines().length, 1, 'mesmo nome atualiza a rotina');
  assert.deepEqual(first.routines()[0].items.map(item => item.exerciseId), ['b']);
  const second = open(storage);
  const queue = second.applyRoutine(second.routines()[0].id);
  assert.deepEqual(queue.items.map(item => item.exerciseId), ['b']);
  assert.equal(second.routines()[0].items[0].durationMin, 5);
  assert.throws(() => second.saveRoutine('   ', []));
  assert.equal(second.deleteRoutine(second.routines()[0].id), true);
  assert.equal(second.routines().length, 0);
  assert.equal(open(storage).routines().length, 0);
});

test('rotinas corrompidas são preservadas separadamente da fila', () => {
  const storage = memoryStorage(new Map([[ROUTINES_KEY, 'nada-de-json']]));
  const store = open(storage);
  assert.equal(store.routinesRecoveryRaw, 'nada-de-json');
  assert.ok(store.routinesWarning, 'aviso de rotinas corrompidas visível para o consumidor');
  assert.equal(storage.getItem(ROUTINES_RECOVERY_KEY), 'nada-de-json');
  assert.equal(store.addItem({ exerciseId: 'a' }).items.length, 1, 'a fila continua utilizável');
  assert.equal(store.saveRoutine('x', []), null);
});

test('sugestão põe sem alvo no fim e nunca usa o próprio andamento como alvo', () => {
  const rows = [
    row('com-alvo-perto', { lastTrainedAt: '2026-09-20T00:00:00.000Z', bestBpm: 118, targetBPM: 120 }),
    row('sem-alvo', { lastTrainedAt: '2026-09-20T00:00:00.000Z', bpm: 300, bestBpm: 90, targetBPM: null }),
    row('com-alvo-longe', { lastTrainedAt: '2026-09-20T00:00:00.000Z', bestBpm: 90, targetBPM: 200 }),
  ];
  assert.deepEqual(suggestQueue(rows).map(item => item.exerciseId), ['com-alvo-longe', 'com-alvo-perto', 'sem-alvo']);
});

// ----- formato v2: migração v1 e itens de aula (etapa 7) ----------------------

const V1_JOURNAL = JSON.stringify({
  version: 1,
  queue: {
    id: 'q1',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:05:00.000Z',
    items: [{ id: 'i1', exerciseId: 'a', durationMin: 6 }, { id: 'i2', exerciseId: 'b', durationMin: 4 }],
  },
  session: {
    id: 's1',
    queueId: 'q1',
    createdAt: '2026-09-01T09:06:00.000Z',
    activeIndex: 1,
    announced: ['i1'],
    items: [
      {
        id: 'i1', exerciseId: 'a', durationMin: 6, elapsedMs: 90000, practiced: true, name: 'A',
        instrument: 'guitar', startBpm: 90, endBpm: 96,
        startedAt: '2026-09-01T09:06:00.000Z', finishedAt: '2026-09-01T09:07:30.000Z',
      },
      {
        id: 'i2', exerciseId: 'b', durationMin: 4, elapsedMs: 0, practiced: false, name: 'B',
        instrument: 'bass', startBpm: null, endBpm: null, startedAt: null, finishedAt: null,
      },
    ],
  },
  summary: {
    finishedAt: '2026-09-01T09:10:00.000Z',
    totalElapsedMs: 90000,
    plannedMs: 600000,
    items: [{ exerciseId: 'a', name: 'A', instrument: 'guitar', elapsedMs: 90000, plannedMs: 360000, bpm: { from: 90, to: 96 } }],
  },
  updatedAt: '2026-09-01T09:10:00.000Z',
});

const V1_ROUTINES = JSON.stringify({
  version: 1,
  routines: [{
    id: 'r1', name: 'Rotina', createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:00:00.000Z',
    items: [{ id: 'x1', exerciseId: 'a', durationMin: 5 }],
  }],
});

test('fila e rotinas v1 migram para v2 preservando os bytes originais', () => {
  const storage = memoryStorage(new Map([[LEGACY_TODAY_KEY, V1_JOURNAL], [LEGACY_ROUTINES_KEY, V1_ROUTINES]]));
  const store = open(storage);
  assert.equal(store.migrated.journal, true);
  assert.equal(store.migrated.routines, true);
  assert.equal(store.migrated.pending, false);
  assert.deepEqual(store.items().map(item => [item.kind, item.exerciseId, item.courseId, item.lessonId, item.durationMin]),
    [['exercise', 'a', null, null, 6], ['exercise', 'b', null, null, 4]]);
  const session = store.session();
  assert.equal(session.activeIndex, 1);
  assert.equal(session.items[0].kind, 'exercise');
  assert.equal(session.items[0].elapsedMs, 90000);
  assert.equal(session.items[0].startBpm, 90);
  assert.equal(session.items[0].endBpm, 96);
  assert.deepEqual(session.announced, ['i1']);
  assert.equal(store.summary().items[0].kind, 'exercise');
  assert.equal(store.summary().items[0].study, false);
  assert.deepEqual(store.summary().items[0].bpm, { from: 90, to: 96 });
  assert.equal(store.routines()[0].name, 'Rotina');
  assert.equal(store.routines()[0].items[0].kind, 'exercise');
  // Bytes originais intactos, cópia feita ANTES da migração e v2 gravado.
  assert.equal(storage.getItem(LEGACY_TODAY_KEY), V1_JOURNAL);
  assert.equal(storage.getItem(LEGACY_TODAY_BACKUP_KEY), V1_JOURNAL);
  assert.equal(storage.getItem(LEGACY_ROUTINES_KEY), V1_ROUTINES);
  assert.equal(storage.getItem(LEGACY_ROUTINES_BACKUP_KEY), V1_ROUTINES);
  assert.equal(JSON.parse(storage.getItem(TODAY_KEY)).version, 2);
  assert.equal(JSON.parse(storage.getItem(ROUTINES_KEY)).version, 2);
  // Reabrir prefere o v2 e não toca nos bytes antigos.
  const again = open(storage);
  assert.equal(again.migrated.journal, false);
  assert.equal(again.migrated.routines, false);
  assert.equal(again.items().length, 2);
  assert.equal(again.routines().length, 1);
  assert.equal(storage.getItem(LEGACY_TODAY_KEY), V1_JOURNAL);
  assert.equal(storage.getItem(LEGACY_TODAY_BACKUP_KEY), V1_JOURNAL);
});

test('migração com quota negada mantém o v1 intacto e conclui depois', () => {
  const storage = memoryStorage(new Map([[LEGACY_TODAY_KEY, V1_JOURNAL]]));
  const failing = memoryStorage(new Map([...storage._map]));
  const set = failing.setItem;
  failing.setItem = (key, value) => {
    if (key === TODAY_KEY) throw new Error('QuotaExceededError');
    return set(key, value);
  };
  const store = open(failing);
  assert.equal(store.items().length, 2, 'a fila antiga continua utilizável');
  assert.equal(store.migrated.journal, true);
  assert.equal(store.migrated.pending, true);
  assert.ok(store.warning, 'aviso visível de migração pendente');
  assert.equal(failing.getItem(LEGACY_TODAY_KEY), V1_JOURNAL);
  assert.equal(failing.getItem(LEGACY_TODAY_BACKUP_KEY), V1_JOURNAL);
  assert.equal(failing.getItem(TODAY_KEY), null);
  // Com espaço de novo, a próxima abertura grava o v2 e o v1 continua de pé.
  const ok = memoryStorage(new Map([...failing._map]));
  const reopened = open(ok);
  assert.equal(reopened.migrated.journal, true);
  assert.equal(reopened.migrated.pending, false);
  assert.equal(JSON.parse(ok.getItem(TODAY_KEY)).version, 2);
  assert.equal(ok.getItem(LEGACY_TODAY_KEY), V1_JOURNAL);
});

test('fila v1 corrompida não é sobrescrita e a recuperação grava só o v2', () => {
  const raw = '{"version":1,"queue":';
  const storage = memoryStorage(new Map([[LEGACY_TODAY_KEY, raw]]));
  const store = open(storage);
  assert.equal(store.status, 'corrupt');
  assert.equal(store.corruptOriginKey, LEGACY_TODAY_KEY);
  assert.equal(store.recoveryRaw, raw);
  assert.equal(storage.getItem(LEGACY_TODAY_KEY), raw);
  assert.equal(storage.getItem(LEGACY_TODAY_BACKUP_KEY), raw, 'cópia feita antes de tentar migrar');
  assert.equal(storage.getItem(LEGACY_TODAY_RECOVERY_KEY), raw);
  assert.throws(() => store.setItems([{ exerciseId: 'a' }]));
  assert.equal(store.replaceCorrupt(), true);
  assert.equal(storage.getItem(LEGACY_TODAY_KEY), raw, 'o v1 nunca é sobrescrito para “corrigir”');
  assert.equal(storage.getItem(LEGACY_TODAY_BACKUP_KEY), raw);
  assert.equal(JSON.parse(storage.getItem(TODAY_KEY)).version, 2);
  assert.equal(store.migrated.journal, false);
});

test('itens de aula guardam curso/aula e a estimativa não é cortada em 180', () => {
  const storage = memoryStorage();
  const store = open(storage);
  store.setItems([
    { kind: 'lesson', courseId: 'c1', lessonId: 'l1', name: 'Aula 3', durationMin: 6 },
    { exerciseId: 'a', durationMin: 5, courseId: 'c1', lessonId: 'l1' },
    { kind: 'lesson', courseId: 'c1', lessonId: 'l2', name: 'Aula 4', durationMin: 700 },
  ]);
  const items = store.items();
  assert.deepEqual(items.map(item => item.kind), ['lesson', 'exercise', 'lesson']);
  assert.equal(items[0].exerciseId, null, 'aula nunca inventa exerciseId');
  assert.equal(items[0].courseId, 'c1');
  assert.equal(items[0].lessonId, 'l1');
  assert.equal(items[0].durationMin, 6);
  assert.equal(items[2].durationMin, 700, 'estimativa de aula acima do teto de prática é preservada');
  assert.equal(items[1].courseId, 'c1', 'exercício vinculado guarda a origem do curso');
  store.setItemDuration(items[1].id, 999);
  assert.equal(store.items()[1].durationMin, MAX_ITEM_MINUTES);
  store.setItemDuration(items[2].id, 5000);
  assert.equal(store.items()[2].durationMin, MAX_LESSON_MINUTES);
  assert.throws(() => store.setItems([{ kind: 'lesson', courseId: 'c1' }]), TypeError);
  assert.throws(() => store.addLessonItem({ courseId: 'c1' }), TypeError);
  assert.equal(store.addLessonItem({ courseId: 'c1', lessonId: 'l3', name: 'Aula 5', durationMin: 8 }).items.length, 4);
  const routine = store.saveRoutine('Com aula', store.items());
  assert.equal(routine.items[0].kind, 'lesson');
  const reopened = open(storage);
  const reapplied = reopened.applyRoutine(reopened.routines()[0].id);
  assert.deepEqual(reapplied.items.map(item => item.kind), ['lesson', 'exercise', 'lesson', 'lesson']);
  assert.equal(reapplied.items[0].courseId, 'c1');
  assert.equal(reapplied.items[0].lessonId, 'l1');
  assert.notEqual(reapplied.items[0].id, items[0].id, 'ids novos na recriação');
});

test('sessão e resumo com aula não guardam BPM nem intervalo vivo', () => {
  const storage = memoryStorage();
  const first = open(storage);
  first.saveSession({
    id: 's1', queueId: null, createdAt: '2026-10-06T09:00:00.000Z', activeIndex: 0, announced: [],
    items: [{
      id: 'i1', kind: 'lesson', courseId: 'c1', lessonId: 'l1', name: 'Aula 3', durationMin: 6,
      elapsedMs: 45000, practiced: true, startBpm: 120, endBpm: 130, running: true, live: { startedAtMs: 5 },
      startedAt: '2026-10-06T09:00:00.000Z', finishedAt: null,
    }],
  });
  first.saveSummary({
    finishedAt: '2026-10-06T09:10:00.000Z', totalElapsedMs: 45000, plannedMs: 360000,
    items: [{ kind: 'lesson', courseId: 'c1', lessonId: 'l1', name: 'Aula 3', elapsedMs: 45000, plannedMs: 360000, bpm: { from: 100, to: 110 } }],
  });
  const session = open(storage).session();
  assert.equal(session.items[0].kind, 'lesson');
  assert.equal(session.items[0].courseId, 'c1');
  assert.equal(session.items[0].exerciseId, null);
  assert.equal(session.items[0].elapsedMs, 45000, 'tempo de estudo fechado sobrevive');
  assert.equal(session.items[0].startBpm, null, 'aula nunca guarda BPM');
  assert.equal(session.items[0].endBpm, null);
  assert.equal('running' in session, false);
  assert.equal('live' in session, false);
  const summary = open(storage).summary();
  assert.equal(summary.items[0].study, true);
  assert.equal(summary.items[0].practiced, true);
  assert.deepEqual(summary.items[0].bpm, { from: null, to: null });
  assert.equal(summary.items[0].name, 'Aula 3');
});

// ------------------------- tempo para assistir (etapa 5/A6)

test('hoje: o tempo indicado para assistir é guardado e limitado à faixa útil', () => {
  const storage = memoryStorage();
  const store = open(storage);
  assert.equal(store.assistMinutes(), null, 'ausente significa "usa o padrão"');
  assert.equal(store.setAssistMinutes(30), 30);
  assert.equal(store.assistMinutes(), 30);
  // Sobrevive a uma reabertura (fica no diário da fila, fora da sessão).
  const reopened = open(storage);
  assert.equal(reopened.assistMinutes(), 30);
  assert.equal(reopened.items().length, 0, 'guardar o tempo não cria fila');
  // Faixa: o valor fora dela é trazido para dentro, nunca guardado impossível.
  assert.equal(store.setAssistMinutes(0), 1);
  assert.equal(store.setAssistMinutes(99999), 1440);
  assert.equal(store.setAssistMinutes('20'), 20);
  assert.equal(store.setAssistMinutes(null), null);
  assert.equal(store.setAssistMinutes('muito'), null);
  const parsed = JSON.parse(storage.getItem(TODAY_KEY));
  assert.equal(parsed.version, 2);
  assert.equal(parsed.assistMinutes, null);
});
