import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage } from './storage-fixture.js';
import {
  createTodayStore, suggestQueue, queueTotalMs, itemTargetMs,
  TODAY_KEY, TODAY_RECOVERY_KEY, ROUTINES_KEY, ROUTINES_RECOVERY_KEY,
  DEFAULT_ITEM_MINUTES, MAX_ITEM_MINUTES,
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
  const storage = memoryStorage(new Map([[TODAY_KEY, '{"version":1,"queue":']]));
  const store = open(storage);
  assert.equal(store.status, 'corrupt');
  assert.equal(store.recoveryRaw, '{"version":1,"queue":');
  assert.equal(storage.getItem(TODAY_KEY), '{"version":1,"queue":', 'bytes originais intactos');
  assert.equal(storage.getItem(TODAY_RECOVERY_KEY), '{"version":1,"queue":');
  assert.throws(() => store.setItems([{ exerciseId: 'a' }]));
  assert.equal(store.replaceCorrupt(), true);
  assert.equal(store.status, 'ready');
  store.addItem({ exerciseId: 'a' });
  assert.equal(JSON.parse(storage.getItem(TODAY_KEY)).queue.items.length, 1);
  assert.equal(storage.getItem(TODAY_RECOVERY_KEY), '{"version":1,"queue":', 'recuperação preservada');
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
