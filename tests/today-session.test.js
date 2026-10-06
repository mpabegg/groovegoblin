import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage } from './storage-fixture.js';
import { createTodayStore } from '../src/today-store.js';
import { createTodaySession } from '../src/today-session.js';

function fakeClock(start = Date.UTC(2026, 9, 6, 9, 0, 0)) {
  let time = start;
  return { now: () => time, at: value => { time = value; return time; }, advance: ms => (time += ms) };
}

// Histórico compartilhado mínimo, fiel ao contrato publicado (idempotente por
// id). Não é o módulo do treinador: só observa o que a fila entrega.
function fakeActivity() {
  const records = new Map();
  return {
    append(record) {
      if (!record?.id || records.has(record.id)) return records.get(record.id) ?? null;
      if (!record.endedAt || !record.startedAt || Date.parse(record.endedAt) < Date.parse(record.startedAt)) return null;
      const stored = { ...record, durationMs: Date.parse(record.endedAt) - Date.parse(record.startedAt) };
      records.set(record.id, stored);
      return stored;
    },
    list: () => [...records.values()],
    subscribe: () => () => {},
    clear: () => records.clear(),
    size: () => records.size,
    records,
  };
}

let idCount = 0;
const uuid = () => `u-${++idCount}`;

// O contador de aulas do curso é assíncrono (promessa): o teste espera a
// microtarefa antes de conferir o que foi gravado.
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture({ exercises = ['a', 'b', 'c'], durations = null, activity = null, libraryBpm = {} } = {}) {
  const clock = fakeClock();
  const storage = memoryStorage();
  const store = createTodayStore({ storage, now: clock.now, uuid });
  store.setItems(exercises.map((id, index) => ({ exerciseId: id, durationMin: durations?.[index] ?? 5 })));
  const opened = [];
  const stopped = [];
  const notices = [];
  const rows = new Map(exercises.map(id => [id, {
    id, name: `Exercício ${id}`, instrument: id === 'b' ? 'bass' : 'guitar', bpm: libraryBpm[id] ?? 90,
    targetBPM: 120, bestBpm: null, lastTrainedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
  }]));
  let owner = null;
  const library = {
    list: () => [...rows.values()],
    get: id => (rows.has(id) ? { id, metadata: { name: rows.get(id).name }, session: { bpm: rows.get(id).bpm } } : null),
    active: () => owner,
    subscribe: () => () => {},
    remove: id => rows.delete(id),
    setName: (id, name) => { rows.get(id).name = name; },
    setBpm: (id, bpm) => { rows.get(id).bpm = bpm; },
  };
  let executing = false;
  const session = createTodaySession({
    store, library, now: clock.now, uuid,
    getActivity: () => activity,
    notify: (text, error) => notices.push({ text, error }),
    openItem: (id, options) => { opened.push({ id, ...options }); return rows.has(id); },
    getOwner: () => owner,
    isExecuting: () => executing,
    stopExecution: reason => stopped.push(reason),
  });
  return {
    clock, storage, store, session, opened, stopped, notices, library, activity,
    setExecuting: value => { executing = value; },
    setOwner: value => { owner = value; },
  };
}

// ----- início e atribuição ----------------------------------------------------

test('começar congela nome, instrumento e BPM do início e abre o primeiro item', () => {
  const { session, opened, clock } = fixture({ libraryBpm: { a: 88 } });
  const created = session.start();
  assert.equal(created.activeIndex, 0);
  assert.deepEqual(opened, [{ id: 'a', start: true }]);
  assert.equal(created.items[0].name, 'Exercício a');
  assert.equal(created.items[0].instrument, 'guitar');
  assert.equal(created.items[0].startBpm, 88);
  assert.equal(created.items[1].instrument, 'bass');
  const state = session.snapshot();
  assert.equal(state.running, true);
  assert.equal(state.remainingMs, 300000);
  clock.advance(61000);
  assert.equal(session.snapshot().elapsedMs, 61000);
  assert.equal(session.snapshot().remainingMs, 239000);
});

test('fechar e reabrir volta pausado e nunca cobra a noite parada', () => {
  const { session, store, clock, activity } = fixture({ activity: fakeActivity() });
  session.start();
  clock.advance(120000);
  session.pause('manual');
  assert.equal(session.snapshot().elapsedMs, 120000);
  assert.equal(session.snapshot().running, false);
  // Simula reabrir o app: novo controlador sobre a MESMA loja.
  clock.advance(10 * 3600 * 1000);
  const reopened = createTodaySession({
    store, now: clock.now, uuid, getActivity: () => activity, notify: () => {},
  });
  const state = reopened.snapshot();
  assert.equal(state.running, false);
  assert.equal(state.paused, true);
  assert.equal(state.reason, 'restored');
  assert.equal(state.elapsedMs, 120000, 'a noite fechada não entra');
  reopened.resume('manual');
  clock.advance(30000);
  assert.equal(reopened.snapshot().elapsedMs, 150000);
  assert.equal(activity.list().length, 1);
  assert.equal(activity.list()[0].durationMs, 120000);
});

test('esconder a aba não cobra tempo escondido e voltar retoma sem clique', () => {
  const { session, activity, clock } = fixture({ activity: fakeActivity() });
  session.start();
  clock.advance(45000);
  session.suspend('hidden');
  assert.equal(session.snapshot().suspended, true);
  clock.advance(3 * 3600 * 1000);
  assert.equal(session.snapshot().elapsedMs, 45000);
  session.wake('visible');
  clock.advance(15000);
  const state = session.snapshot();
  assert.equal(state.elapsedMs, 60000);
  assert.equal(state.running, true);
  assert.equal(activity.list().length, 1, 'intervalo escondido fechado uma única vez');
});

test('pausar/encerrar repetido e pagehide depois de visibilitychange não duplicam', () => {
  const activity = fakeActivity();
  const { session, clock } = fixture({ activity });
  session.start();
  clock.advance(20000);
  session.pause('manual');
  session.pause('manual');
  session.pause('pagehide');
  assert.equal(session.snapshot().elapsedMs, 20000);
  assert.equal(activity.list().length, 1);
  assert.equal(activity.size(), 1);
  // Novo item: suspeita + pagehide com um intervalo aberto.
  session.resume('manual');
  clock.advance(10000);
  session.suspend('hidden');
  session.pause('pagehide');
  assert.equal(session.snapshot().elapsedMs, 30000);
  assert.equal(activity.list().length, 2);
  const ids = activity.list().map(record => record.id);
  assert.equal(new Set(ids).size, 2);
  for (const record of activity.list()) {
    assert.equal(record.source, 'today');
    assert.equal(record.mode, 'practice');
    assert.equal(record.exerciseId, 'a');
    assert.ok(['guitar', 'bass'].includes(record.instrument));
    assert.ok(record.id.length > 0 && record.id.length <= 80, 'id cabe no limite do diário');
    assert.ok(Number.isFinite(Date.parse(record.startedAt)));
    assert.ok(Number.isFinite(Date.parse(record.endedAt)));
  }
});

test('sem histórico compartilhado o tempo continua contado e o estado avisa', () => {
  const { session, clock } = fixture();
  session.start();
  clock.advance(30000);
  session.pause('manual');
  assert.equal(session.snapshot().elapsedMs, 30000);
  assert.equal(session.snapshot().activityMissing, true);
  assert.equal(session.snapshot().journal.present, false);
  assert.ok(session.snapshot().journal.problem, 'problema de diário visível para o consumidor');
});

test('intervalo recusado pelo diário nunca é perdido em silêncio', () => {
  const rejecting = { append: () => null, warning: 'registro inválido', status: 'corrupt', list: () => [] };
  const { session, clock, notices } = fixture({ activity: rejecting });
  session.start();
  clock.advance(12000);
  session.pause('manual');
  const state = session.snapshot();
  assert.equal(state.elapsedMs, 12000, 'o tempo continua na fila');
  assert.ok(state.journal.problem, 'recusa do diário visível para o consumidor');
  assert.equal(state.journal.status, 'corrupt');
  assert.equal(notices.length, 0, 'a falha é visível no painel, não em toast a cada intervalo');
  const throwing = { append: () => { throw new Error('cota'); }, status: 'quota', warning: null };
  const second = fixture({ activity: throwing });
  second.session.start();
  second.clock.advance(5000);
  second.session.pause('manual');
  assert.ok(second.session.snapshot().journal.problem, 'falha do diário visível para o consumidor');
  assert.equal(second.session.snapshot().elapsedMs, 5000);
});

// ----- meta zerada -----------------------------------------------------------

test('meta zerada avisa uma vez, espera e nunca troca de item nem interrompe o treino', () => {
  let executing = true;
  const activity = fakeActivity();
  const clock = fakeClock();
  const storage = memoryStorage();
  const store = createTodayStore({ storage, now: clock.now, uuid });
  store.setItems([{ exerciseId: 'a', durationMin: 1 }, { exerciseId: 'b', durationMin: 1 }]);
  const stopped = [];
  const notices = [];
  const events = [];
  const library = {
    list: () => [{ id: 'a', name: 'A', instrument: 'guitar', bpm: 90, targetBPM: 120, bestBpm: null, lastTrainedAt: null, createdAt: '2026-01-01T00:00:00.000Z' }],
    get: () => ({ metadata: { name: 'A' }, session: { bpm: 90 } }),
  };
  const session = createTodaySession({
    store, library, now: clock.now, uuid, getActivity: () => activity,
    notify: (text, error) => notices.push({ text, error }),
    openItem: () => true,
    isExecuting: () => executing,
    stopExecution: reason => stopped.push(reason),
    onEvent: name => events.push(name),
  });
  session.start();
  clock.advance(60000);
  session.tick();
  assert.equal(notices.length, 1, 'avisa a meta zerada uma vez');
  const state = session.snapshot();
  assert.equal(state.index, 0, 'continua no mesmo item');
  assert.equal(state.running, true, 'não pausa sozinho');
  assert.equal(state.remainingMs, 0);
  assert.equal(stopped.length, 0, 'não interrompe o take avaliado');
  assert.equal(events.includes('target-reached'), true);
  clock.advance(30000);
  session.tick();
  assert.equal(notices.length, 1, 'avisa uma vez por item');
  assert.equal(session.snapshot().overtimeMs, 30000, 'tempo real pode passar da meta até Próximo/Encerrar');
});

test('meta zerada sobrevive à recarga sem reavisar', () => {
  const { session, store, clock, notices } = fixture({ durations: [1, 5] });
  session.start();
  clock.advance(60000);
  session.tick();
  assert.equal(notices.length, 1);
  session.pause('manual');
  const reopened = createTodaySession({ store, now: clock.now, uuid, notify: text => notices.push({ text }), getActivity: () => null });
  reopened.resume('manual');
  clock.advance(1000);
  reopened.tick();
  assert.equal(notices.length, 1, 'o aviso não se repete depois de recarregar');
});

// ----- próximo / encerrar -----------------------------------------------------

test('próximo encerra o treino em curso com segurança antes de selecionar o seguinte', () => {
  const { session, clock, opened, stopped, activity, setExecuting } = fixture({ activity: fakeActivity() });
  session.start();
  clock.advance(90000);
  setExecuting(true);
  const result = session.next();
  assert.equal(result.completed, false);
  assert.equal(stopped.length, 1);
  assert.deepEqual(opened, [{ id: 'a', start: true }, { id: 'b', start: false }]);
  const state = session.snapshot();
  assert.equal(state.index, 1);
  assert.equal(state.running, true);
  assert.equal(state.elapsedMs, 0, 'o próximo item começa do zero');
  assert.equal(state.totalElapsedMs, 90000);
  assert.equal(activity.list().length, 1);
  assert.equal(activity.list()[0].durationMs, 90000);
});

test('próximo grava o fim do item na loja real e o resumo conserva a mudança de BPM', () => {
  const { session, store, storage, clock, library } = fixture({ exercises: ['a', 'b'], durations: [1, 1] });
  session.start();
  clock.advance(60000);
  library.setBpm('a', 96);
  const result = session.next();
  assert.equal(result.completed, false);
  const saved = store.session();
  assert.equal(saved.items[0].elapsedMs, 60000);
  assert.equal(saved.items[0].startBpm, 90);
  assert.equal(saved.items[0].endBpm, 96, 'BPM final precisa sobreviver ao fechamento do intervalo');
  assert.ok(saved.items[0].finishedAt, 'horário de fim precisa sobreviver ao fechamento do intervalo');
  assert.equal(saved.items[0].practiced, true);
  assert.equal(saved.activeIndex, 1);
  clock.advance(30000);
  const summary = session.finish('manual');
  assert.deepEqual(summary.items[0].bpm, { from: 90, to: 96 });
  assert.equal(summary.items[0].elapsedMs, 60000);
  assert.equal(summary.items[0].practiced, true);
  // Recarga real da loja: o resumo guardado conserva a mudança do item anterior.
  const reopened = createTodayStore({ storage, now: clock.now, uuid });
  assert.deepEqual(reopened.summary().items[0].bpm, { from: 90, to: 96 });
  assert.equal(reopened.summary().items[0].elapsedMs, 60000);
  assert.equal(reopened.summary().items[0].practiced, true);
  assert.equal(reopened.session(), null);
});

test('itens repetidos na fila contam separado e o item final completa com resumo', () => {
  const { session, clock, activity, store } = fixture({ exercises: ['a', 'b', 'a'], activity: fakeActivity() });
  session.start();
  clock.advance(30000);
  session.next();
  clock.advance(20000);
  session.next();
  clock.advance(40000);
  const result = session.next();
  assert.equal(result.completed, true);
  const summary = result.summary;
  assert.deepEqual(summary.items.map(item => item.exerciseId), ['a', 'b', 'a']);
  assert.deepEqual(summary.items.map(item => item.elapsedMs), [30000, 20000, 40000]);
  assert.deepEqual(summary.items.map(item => item.practiced), [true, true, true]);
  assert.equal(summary.totalElapsedMs, 90000);
  assert.equal(summary.plannedMs, 900000);
  assert.equal(session.snapshot().active, false);
  assert.equal(store.session(), null, 'fila segue montada, sessão encerrada');
  assert.equal(store.summary().totalElapsedMs, 90000);
  assert.equal(activity.list().length, 3);
  assert.equal(activity.list()[1].exerciseId, 'b');
  assert.equal(activity.list()[1].instrument, 'bass');
});

test('encerrar no meio finaliza o item atual e lista o que não foi praticado', () => {
  const { session, clock, stopped, library, store } = fixture();
  session.start();
  clock.advance(45000);
  library.setBpm('a', 96);
  const summary = session.finish('manual');
  assert.equal(summary.items[0].elapsedMs, 45000);
  assert.deepEqual(summary.items[0].bpm, { from: 90, to: 96 });
  assert.equal(summary.items[1].practiced, false);
  assert.equal(summary.items[1].bpm.from, null);
  assert.equal(summary.totalElapsedMs, 45000);
  assert.equal(store.summary().items[0].bpm.to, 96);
  assert.equal(session.snapshot().summary.totalElapsedMs, 45000);
  session.dismissSummary();
  assert.equal(session.snapshot().summary, null);
  assert.equal(store.summary(), null);
  assert.equal(stopped.length, 0, 'sem treino em curso, nada é parado');
});

test('próximo pula exercícios que saíram da biblioteca', () => {
  const { session, clock, opened, notices, library } = fixture({ exercises: ['a', 'b', 'c'] });
  session.start();
  clock.advance(10000);
  library.remove('b');
  session.next();
  assert.equal(session.snapshot().item.exerciseId, 'c');
  assert.equal(session.snapshot().index, 2);
  assert.deepEqual(opened, [{ id: 'a', start: true }, { id: 'b', start: false }, { id: 'c', start: false }], 'tenta abrir o removido e segue para o próximo existente');
  assert.equal(notices.length, 1, 'item pulado é avisado');
  assert.equal(notices[0].error, true, 'aviso de item pulado é de erro');
});

test('todos os itens removidos encerram a sessão sem inventar tempo', () => {
  const { session, library, notices, opened } = fixture({ exercises: ['a', 'b'] });
  library.remove('a');
  library.remove('b');
  const created = session.start();
  assert.equal(created, null);
  assert.equal(session.snapshot().active, false);
  assert.equal(session.snapshot().summary.totalElapsedMs, 0);
  assert.equal(opened.length, 2);
  assert.equal(notices.length, 2, 'cada item sem exercício é avisado');
  assert.equal(notices.every(notice => notice.error === true), true, 'avisos são de erro');
});

test('selecionar outro exercício pausa a atribuição e só retomar volta', () => {
  const { session, clock, activity, setOwner, opened } = fixture({ activity: fakeActivity() });
  setOwner('a');
  session.start();
  clock.advance(40000);
  setOwner('outro');
  session.ownerChanged('outro');
  const paused = session.snapshot();
  assert.equal(paused.running, false);
  assert.equal(paused.reason, 'selection');
  clock.advance(60000);
  assert.equal(session.snapshot().elapsedMs, 40000, 'não cobra tempo do dono errado');
  setOwner('a');
  session.ownerChanged('a');
  assert.equal(session.snapshot().running, false, 'voltar ao item não retoma sozinho');
  session.resume('manual');
  clock.advance(5000);
  assert.equal(session.snapshot().elapsedMs, 45000);
  assert.equal(activity.list().length, 1);
  assert.deepEqual(opened, [{ id: 'a', start: true }], 'retomar com o dono certo não reabre nada');
});

test('voltar para a aba com outro exercício ativo não retoma a atribuição', () => {
  const { session, clock, setOwner, opened, notices } = fixture();
  setOwner('a');
  session.start();
  clock.advance(20000);
  // Saída para a Biblioteca/Estúdio: suspende; dono muda enquanto está fora.
  session.suspend('tab');
  setOwner('b');
  assert.equal(session.wake('tab'), null, 'não volta a contar para o item errado');
  assert.equal(session.snapshot().running, false);
  assert.equal(session.snapshot().reason, 'selection');
  clock.advance(30000);
  assert.equal(session.snapshot().elapsedMs, 20000);
  // Retomar explícito reabre o item certo e só então conta.
  session.resume('manual');
  assert.deepEqual(opened.at(-1), { id: 'a', start: false }, 'retomar traz o exercício do item de volta');
  clock.advance(4000);
  assert.equal(session.snapshot().elapsedMs, 24000);
  assert.equal(notices.length, 0);
});

test('tick pausa sozinho quando o dono do tempo muda no meio do item', () => {
  const { session, clock, setOwner } = fixture();
  setOwner('a');
  session.start();
  clock.advance(15000);
  setOwner('c');
  session.tick();
  const state = session.snapshot();
  assert.equal(state.running, false);
  assert.equal(state.reason, 'selection');
  clock.advance(5000);
  assert.equal(session.snapshot().elapsedMs, 15000);
});

test('retomar com o exercício do item removido avisa e não volta a contar', () => {
  const { session, clock, setOwner, library, notices } = fixture({ exercises: ['a', 'b'] });
  setOwner('a');
  session.start();
  clock.advance(10000);
  session.suspend('tab');
  setOwner('b');
  library.remove('a');
  assert.equal(session.resume('manual'), null);
  assert.equal(session.snapshot().running, false);
  assert.equal(notices.length, 1, 'recusa de retomada é avisada');
  assert.equal(notices[0].error, true, 'aviso de recusa é de erro');
  assert.equal(session.snapshot().elapsedMs, 10000);
});

test('começar sem fila avisa e não cria sessão; retomar nunca fica negativo', () => {
  const store = createTodayStore({ storage: memoryStorage(), now: () => Date.UTC(2026, 9, 6, 9), uuid });
  const notices = [];
  const session = createTodaySession({ store, now: () => Date.UTC(2026, 9, 6, 9), uuid, notify: (text, error) => notices.push({ text, error }), getActivity: () => null });
  assert.equal(session.start(), null);
  assert.equal(notices[0].error, true);
  assert.equal(session.snapshot().active, false);
  assert.equal(session.tick().remainingMs, 0);
  assert.equal(session.next().completed, false);
  assert.equal(session.finish(), null);
});

// ----- itens de aula (etapa 7) -----------------------------------------------

function lessonFixture({ items, present = () => true, recordWatch = null, activity = fakeActivity() } = {}) {
  const clock = fakeClock();
  const storage = memoryStorage();
  const store = createTodayStore({ storage, now: clock.now, uuid });
  store.setItems(items);
  const opened = [];
  const lessons = [];
  const notices = [];
  const watches = [];
  const rows = new Map([['a', {
    id: 'a', name: 'Exercício a', instrument: 'guitar', bpm: 90, targetBPM: 120,
    bestBpm: null, lastTrainedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
  }]]);
  const library = {
    list: () => [...rows.values()],
    get: id => (rows.has(id) ? { id, metadata: { name: rows.get(id).name }, session: { bpm: rows.get(id).bpm } } : null),
    active: () => null,
    subscribe: () => () => {},
  };
  const watch = recordWatch ?? ((courseId, lessonId, interval) => { watches.push({ courseId, lessonId, ...interval }); return { ok: true }; });
  const session = createTodaySession({
    store, library, now: clock.now, uuid,
    getActivity: () => activity,
    notify: (text, error) => notices.push({ text, error }),
    openItem: (id, options) => { opened.push({ id, ...options }); return rows.has(id); },
    openLesson: (item, options) => { lessons.push({ courseId: item.courseId, lessonId: item.lessonId, ...options }); return true; },
    lessonExists: (courseId, lessonId) => present(courseId, lessonId),
    recordWatch: watch,
  });
  return { clock, store, session, opened, lessons, notices, watches, library, activity };
}

const lessonItem = (courseId, lessonId, name, durationMin = 6) => ({ kind: 'lesson', courseId, lessonId, name, durationMin });

test('item de aula abre a página da aula, não liga relógio e não avisa meta zero', () => {
  const { session, lessons, opened, notices, clock, activity } = lessonFixture({ items: [lessonItem('c1', 'l1', 'Aula 3')] });
  session.start();
  assert.deepEqual(lessons, [{ courseId: 'c1', lessonId: 'l1', start: true }], 'abre a aula (Biblioteca), nunca o exercício');
  assert.deepEqual(opened, []);
  let state = session.snapshot();
  assert.equal(state.lesson, true);
  assert.equal(state.kind, 'lesson');
  assert.equal(state.running, false, 'aula não liga o relógio sozinha');
  assert.equal(state.paused, true);
  assert.equal(state.elapsedMs, 0);
  assert.equal(state.item.exerciseId, null, 'nenhum exerciseId inventado');
  assert.equal(state.targetMs, 360000, 'a estimativa da aula continua visível');
  clock.advance(10 * 60 * 1000);
  state = session.tick();
  assert.equal(state.elapsedMs, 0, 'tempo parado na aula não conta');
  assert.equal(state.remainingMs, 0, 'aula não tem contagem regressiva');
  assert.equal(state.overtimeMs, 0);
  assert.equal(notices.length, 0, 'nenhum aviso de meta atingida');
  assert.equal(activity.list().length, 0, 'nenhum exercício fantasma no diário');
  assert.equal(clock.now(), Date.UTC(2026, 9, 6, 9, 10, 0));
});

test('“Contar tempo” fecha intervalo positivo no curso e nunca no diário de prática', async () => {
  const { session, clock, watches, activity, store } = lessonFixture({ items: [lessonItem('c1', 'l1', 'Aula 3')] });
  session.start();
  assert.equal(session.startStudy('manual').items[0].kind, 'lesson');
  const startedAt = Date.parse(session.snapshot().item.startedAt);
  assert.ok(Number.isFinite(startedAt), 'o estudo marca o início do item');
  clock.advance(90000);
  assert.equal(session.tick().studyRunning, true);
  assert.equal(session.tick().elapsedMs, 90000);
  const state = session.snapshot();
  session.stopStudy('manual');
  await flushPromises();
  assert.equal(watches.length, 1, 'um intervalo FECHADO para o curso');
  assert.equal(watches[0].courseId, 'c1');
  assert.equal(watches[0].lessonId, 'l1');
  assert.equal(Date.parse(watches[0].endedAt) - Date.parse(watches[0].startedAt), 90000);
  assert.deepEqual(Object.keys(watches[0]).sort(), ['courseId', 'endedAt', 'lessonId', 'startedAt']);
  assert.equal(activity.list().length, 0, 'o tempo de estudo nunca vira exercício no diário');
  const after = session.snapshot();
  assert.equal(after.studyRunning, false);
  assert.equal(after.elapsedMs, 90000, 'o tempo estudado fica no item');
  assert.equal(store.session().items[0].elapsedMs, 90000);
  assert.equal(store.session().items[0].practiced, true);
  assert.equal(state.studyRunning, true);
  // Parar de novo não grava um segundo intervalo.
  session.stopStudy('manual');
  await flushPromises();
  assert.equal(watches.length, 1);
});

test('aula → exercício → aula navega e cada item abre no destino certo', () => {
  const { session, clock, lessons, opened, activity, store } = lessonFixture({
    items: [lessonItem('c1', 'l1', 'Aula 1'), { exerciseId: 'a', durationMin: 5 }, lessonItem('c1', 'l2', 'Aula 2')],
  });
  session.start();
  assert.deepEqual(lessons, [{ courseId: 'c1', lessonId: 'l1', start: true }]);
  assert.equal(session.snapshot().lesson, true);
  assert.equal(session.next().completed, false);
  assert.deepEqual(opened, [{ id: 'a', start: false }], 'o exercício abre no Treinar');
  assert.equal(session.snapshot().kind, 'exercise');
  assert.equal(session.snapshot().running, true, 'exercício conta o tempo como sempre');
  clock.advance(30000);
  clock.advance(0);
  assert.equal(session.next().completed, false);
  assert.deepEqual(lessons, [{ courseId: 'c1', lessonId: 'l1', start: true }, { courseId: 'c1', lessonId: 'l2', start: false }]);
  assert.equal(session.snapshot().lesson, true);
  assert.equal(session.snapshot().running, false, 'a aula seguinte não liga relógio');
  assert.equal(activity.list().length, 1, 'só o exercício entrou no diário');
  assert.equal(activity.list()[0].exerciseId, 'a');
  clock.advance(60000);
  assert.equal(session.tick().elapsedMs, 0);
  const summary = session.finish('manual');
  assert.deepEqual(summary.items.map(item => item.kind), ['lesson', 'exercise', 'lesson']);
  assert.deepEqual(summary.items.map(item => item.study), [true, false, true]);
  assert.deepEqual(summary.items[0].bpm, { from: null, to: null }, 'aula nunca ganha BPM');
  assert.equal(summary.items[1].elapsedMs, 30000);
  assert.equal(summary.items[1].practiced, true);
  assert.equal(summary.items[0].practiced, false, 'aula sem cronômetro não conta como estudada');
  assert.equal(summary.totalElapsedMs, 30000);
  assert.equal(store.session(), null);
  assert.deepEqual(store.summary().items.map(item => item.study), [true, false, true]);
});

test('recarga com aula ativa volta pausada e o estudo aberto não atravessa', async () => {
  const { session, store, clock, watches } = lessonFixture({ items: [lessonItem('c1', 'l1', 'Aula 3')] });
  session.start();
  session.startStudy('manual');
  clock.advance(60000);
  assert.equal(watches.length, 0, 'intervalo aberto não foi gravado');
  clock.advance(10 * 3600 * 1000);
  const reopened = createTodaySession({
    store, now: clock.now, uuid, notify: () => {}, getActivity: () => null,
    recordWatch: (courseId, lessonId, interval) => { watches.push({ courseId, lessonId, ...interval }); return { ok: true }; },
  });
  const state = reopened.snapshot();
  assert.equal(state.lesson, true);
  assert.equal(state.studyRunning, false, 'volta pausado');
  assert.equal(state.reason, 'restored');
  assert.equal(state.elapsedMs, 0, 'a noite fechada nunca entra');
  reopened.startStudy('manual');
  clock.advance(30000);
  assert.equal(reopened.stopStudy('manual').items[0].elapsedMs, 30000);
  await flushPromises();
  assert.equal(watches.length, 1);
});

test('falha do contador de aulas fica visível e nunca gera rejeição não tratada', async () => {
  const rejecting = lessonFixture({
    items: [lessonItem('c1', 'l1', 'Aula 3')],
    recordWatch: () => Promise.reject(new Error('sem espaço')),
  });
  rejecting.session.start();
  rejecting.session.startStudy();
  rejecting.clock.advance(5000);
  rejecting.session.stopStudy();
  await flushPromises();
  const state = rejecting.session.snapshot();
  assert.match(state.watch.warning, /sem espaço/);
  assert.equal(state.watch.pending, 0);
  assert.equal(rejecting.session.snapshot().elapsedMs, 5000, 'o tempo continua na fila');
  assert.equal(rejecting.activity.list().length, 0);

  const refusing = lessonFixture({ items: [lessonItem('c1', 'l1', 'Aula 3')], recordWatch: () => null });
  refusing.session.start();
  refusing.session.startStudy();
  refusing.clock.advance(5000);
  refusing.session.stopStudy();
  await flushPromises();
  assert.ok(refusing.session.snapshot().watch.warning, 'recusa do contador é visível');

  const missing = lessonFixture({ items: [lessonItem('c1', 'l1', 'Aula 3')] });
  missing.session.start();
  missing.session.startStudy();
  missing.clock.advance(5000);
  missing.session.stopStudy();
  await flushPromises();
  assert.equal(missing.watches.length, 1);
  assert.equal(missing.session.snapshot().watch.warning, null);
});

test('aula que saiu do curso é pulada sem inventar tempo', () => {
  const { session, notices, lessons } = lessonFixture({
    items: [lessonItem('c1', 'l1', 'Aula antiga'), lessonItem('c1', 'l2', 'Aula viva')],
    present: (courseId, lessonId) => lessonId === 'l2',
  });
  session.start();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].error, true);
  assert.deepEqual(lessons, [{ courseId: 'c1', lessonId: 'l2', start: false }]);
  const state = session.snapshot();
  assert.equal(state.index, 1);
  assert.equal(state.item.lessonId, 'l2');
  assert.equal(state.elapsedMs, 0);
});

test('sair da Biblioteca fecha o cronômetro da aula e voltar não religa sozinho', async () => {
  const { session, clock, watches } = lessonFixture({ items: [lessonItem('c1', 'l1', 'Aula 3')] });
  session.start();
  session.startStudy('manual');
  clock.advance(20000);
  session.suspend('tab');
  await flushPromises();
  assert.equal(session.snapshot().studyRunning, false);
  assert.equal(session.snapshot().elapsedMs, 20000);
  assert.equal(watches.length, 1);
  assert.equal(session.wake('tab'), null, 'contar tempo é sempre explícito');
  clock.advance(60000);
  assert.equal(session.snapshot().elapsedMs, 20000);
  assert.equal(watches.length, 1);
});
