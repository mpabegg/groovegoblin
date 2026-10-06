import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCourseStore, mergeCourseState, normalizeCourseState, openCourseStore, sharedCourseStore, resetSharedCourseStore } from '../src/course-store.js';
import { courseDocument, courseText, lesson, section, memoryBackend, fakeIndexedDB } from './course-fixtures.js';

function clock() {
  let ticks = 0;
  return () => new Date(Date.UTC(2026, 9, 5, 12, 0, ticks++)).toISOString();
}

let idCount = 0;
function nextUuid() { return `id-${++idCount}`; }

async function open(options = {}) {
  const backend = options.backend ?? memoryBackend();
  const store = createCourseStore({ backend, now: options.now ?? clock(), uuid: nextUuid, ...options.rest });
  await store.ready();
  return { store, backend };
}

const COURSE = 'curso-exemplo';

test('curso: importação válida grava registro e estado separado', async () => {
  const { store } = await open();
  const result = await store.importText(courseText());
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.courseId, COURSE);
  assert.deepEqual(result.counts, { sections: 2, lessons: 4, resources: 0, exercises: 1 });
  const records = store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].course.title, 'Curso de Exemplo');
  assert.equal(records[0].counts.lessons, 4);
  const found = store.get(COURSE);
  assert.equal(found.record.counts.sections, 2);
  assert.deepEqual(found.state.lessons, {});
  // Estado esparso: aula sem estado gravado devolve o padrão, não um registro.
  assert.deepEqual(store.lessonState(COURSE, 'aula-1'), {
    watched: false, skipped: false, completionOverride: null, notes: '', linkedExerciseIds: [], updatedAt: null,
  });
  assert.equal(store.lessonState(COURSE, 'aula-inexistente').watched, false);
});

test('curso: importação inválida traz o caminho do campo e não grava nada', async () => {
  const { store, backend } = await open();
  await store.importText(courseText());

  const broken = await store.importText('{ isso não é json');
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'invalid');
  assert.ok(broken.error.length > 0);

  const wrongStrings = await store.importText(courseText(courseDocument({ strings: 6 })));
  assert.equal(wrongStrings.ok, false);
  assert.ok(wrongStrings.errors.some(error => error.path === 'course.strings'));

  const unknownField = await store.importText(courseText(courseDocument({ desconhecido: 1 })));
  assert.equal(unknownField.ok, false);
  assert.ok(unknownField.errors.some(error => error.path === 'course.desconhecido'));

  const brokenRef = await store.importText(courseText(courseDocument({
    sections: [section('modulo-1', [lesson('aula-1', { resourceRefs: [{ lessonId: 'aula-9', resourceId: 'r1' }] })])],
  })));
  assert.equal(brokenRef.ok, false);
  assert.ok(brokenRef.errors.some(error => error.path.endsWith('resourceRefs[0].lessonId')));

  // A loja continua exatamente como estava: 1 curso, sem estados extras.
  assert.deepEqual(store.list().map(record => record.id), [COURSE]);
  assert.equal(backend.raw('courses').length, 1);
  assert.equal(backend.raw('states').length, 1);
});

test('curso: reimportar o mesmo id preserva estado, cria tombstone e restaura', async () => {
  const { store } = await open();
  await store.importText(courseText());
  await store.setLessonState(COURSE, 'aula-1', { watched: true, notes: 'anotação de exemplo' });
  await store.linkExercise(COURSE, 'aula-1', 'ex-vinculado');
  await store.setLessonState(COURSE, 'aula-3', { watched: true });

  const withoutAula3 = courseDocument({
    sections: [
      section('modulo-1', [lesson('aula-1', { suggestedExercises: [{ id: 'ex-aula-1', title: 'Exercício da Aula 1' }] }), lesson('aula-2'), lesson('aula-4')]),
      section('boas-vindas', [lesson('aula-0')], { title: 'Boas-vindas', type: 'boas-vindas' }),
    ],
  });
  const result = await store.importText(courseText(withoutAula3));
  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.preserved, 1);
  assert.equal(result.removed, 1);
  const afterRemoval = store.get(COURSE);
  assert.equal(afterRemoval.state.lessons['aula-1'].watched, true);
  assert.equal(afterRemoval.state.lessons['aula-1'].notes, 'anotação de exemplo');
  assert.deepEqual(afterRemoval.state.lessons['aula-1'].linkedExerciseIds, ['ex-vinculado']);
  assert.equal(afterRemoval.state.lessons['aula-3'], undefined);
  const tombstone = afterRemoval.state.removed.find(entry => entry.id === 'aula-3');
  assert.equal(tombstone.state.watched, true);
  assert.equal(tombstone.sectionId, 'modulo-1');
  assert.equal(tombstone.type, 'aula');
  assert.equal(afterRemoval.record.counts.lessons, 4);

  // A aula removida continua alcançável para desvincular/editar.
  const patched = await store.setLessonState(COURSE, 'aula-3', { notes: 'guardado no tombstone' });
  assert.equal(patched.notes, 'guardado no tombstone');

  const withAula3Back = await store.importText(courseText());
  assert.equal(withAula3Back.restored, 1);
  // A aula-4, que só existia no mapa intermediário, sai para o grupo próprio.
  assert.equal(withAula3Back.removed, 1);
  const restored = store.get(COURSE);
  assert.equal(restored.state.lessons['aula-3'].watched, true);
  assert.equal(restored.state.lessons['aula-3'].notes, 'guardado no tombstone');
  assert.deepEqual(restored.state.removed.map(entry => entry.id), ['aula-4']);
});

test('curso: progresso do arquivo marca assistida e reimportar não desmarca', async () => {
  const { store } = await open();
  const withProgress = courseDocument();
  withProgress.progress = { watchedLessonIds: ['aula-2', 'aula-3'] };
  const result = await store.importText(courseText(withProgress));
  assert.equal(result.ok, true);
  assert.equal(result.watched, 2);
  assert.equal(store.lessonState(COURSE, 'aula-2').watched, true);

  await store.importText(courseText());
  assert.equal(store.lessonState(COURSE, 'aula-2').watched, true);
  assert.equal(store.lessonState(COURSE, 'aula-3').watched, true);
});

test('curso: estado de aula é estrito e aula desconhecida não vira registro', async () => {
  const { store } = await open();
  await store.importText(courseText());
  await assert.rejects(() => store.setLessonState(COURSE, 'aula-1', { campo: 1 }), TypeError);
  await assert.rejects(() => store.setLessonState(COURSE, 'aula-1', { watched: 'sim' }), TypeError);
  await assert.rejects(() => store.setLessonState(COURSE, 'aula-1', { completionOverride: 'talvez' }), RangeError);
  assert.equal(await store.setLessonState(COURSE, 'aula-inexistente', { watched: true }), null);
  assert.equal(await store.setLessonState('curso-inexistente', 'aula-1', { watched: true }), null);

  // Aula sem estado gravado aceita o primeiro patch e continua esparsa.
  const updated = await store.setLessonState(COURSE, 'aula-2', { watched: true });
  assert.equal(updated.watched, true);
  assert.deepEqual(Object.keys(store.get(COURSE).state.lessons), ['aula-2']);
  const overridden = await store.setCompletionOverride(COURSE, 'aula-2', 'complete');
  assert.equal(overridden.completionOverride, 'complete');
  assert.equal(store.lessonState(COURSE, 'aula-2').completionOverride, 'complete');
  await assert.rejects(() => store.setCompletionOverride(COURSE, 'aula-2', 'pronto'), RangeError);
});

test('curso: vínculos deduplicam e a origem inversa aponta curso e aula', async () => {
  const { store } = await open();
  await store.importText(courseText());
  await store.linkExercise(COURSE, 'aula-1', 'ex-1');
  await store.linkExercise(COURSE, 'aula-1', 'ex-1');
  await store.linkExercise(COURSE, 'aula-2', 'ex-1');
  assert.deepEqual(store.lessonState(COURSE, 'aula-1').linkedExerciseIds, ['ex-1']);
  assert.equal(await store.linkExercise(COURSE, 'aula-inexistente', 'ex-1'), null);
  await assert.rejects(() => store.linkExercise(COURSE, 'aula-1', ''), TypeError);

  const origins = store.originsOf('ex-1');
  assert.deepEqual(origins.map(origin => [origin.courseId, origin.lessonId, origin.removed]), [
    [COURSE, 'aula-1', false],
    [COURSE, 'aula-2', false],
  ]);
  assert.equal(origins[0].courseTitle, 'Curso de Exemplo');
  assert.deepEqual(store.linkedExerciseIds(COURSE), ['ex-1']);

  await store.setLessonState(COURSE, 'aula-2', { watched: true });
  await store.unlinkExercise(COURSE, 'aula-2', 'ex-1');
  assert.deepEqual(store.lessonState(COURSE, 'aula-2').linkedExerciseIds, []);
  assert.deepEqual(store.originsOf('ex-1').map(origin => origin.lessonId), ['aula-1']);
  assert.deepEqual(store.originsOf('ex-inexistente'), []);
});

test('curso: vínculo de aula removida continua na origem inversa como removido', async () => {
  const { store } = await open();
  await store.importText(courseText());
  await store.linkExercise(COURSE, 'aula-3', 'ex-3');
  await store.importText(courseText(courseDocument({ sections: [section('modulo-1', [lesson('aula-1'), lesson('aula-2')])] })));
  const origins = store.originsOf('ex-3');
  assert.equal(origins.length, 1);
  assert.equal(origins[0].removed, true);
  assert.equal(origins[0].lessonId, 'aula-3');
});

test('curso: intervalos de estudo exigem fim depois do começo e somam união', async () => {
  const now = Date.UTC(2026, 9, 7, 18, 0, 0);
  const { store } = await open();
  await store.importText(courseText());
  assert.equal(await store.recordWatch(COURSE, 'aula-1', { startedAt: '2026-10-07T18:00:00.000Z', endedAt: '2026-10-07T17:00:00.000Z' }), null);
  assert.equal(await store.recordWatch(COURSE, 'aula-1', { startedAt: 'nada', endedAt: '2026-10-07T18:00:00.000Z' }), null);
  assert.equal(await store.recordWatch(COURSE, 'aula-inexistente', { startedAt: '2026-10-07T17:00:00.000Z', endedAt: '2026-10-07T18:00:00.000Z' }), null);
  assert.deepEqual(store.watchIntervals(COURSE), []);

  await store.recordWatch(COURSE, 'aula-1', { startedAt: '2026-10-07T17:00:00.000Z', endedAt: '2026-10-07T17:30:00.000Z' });
  await store.recordWatch(COURSE, 'aula-1', { startedAt: '2026-10-07T17:15:00.000Z', endedAt: '2026-10-07T17:45:00.000Z' });
  assert.equal(store.watchIntervals(COURSE).length, 2);
  const summary = store.summary(COURSE, { now });
  assert.equal(summary.weekMs, 45 * 60000);
  assert.equal(summary.watchMs, 45 * 60000);
  assert.equal(summary.rows.find(row => row.lesson.id === 'aula-1').watchMs, 45 * 60000);
});

test('curso: quota negada não vira sucesso falso e mantém o estado anterior', async () => {
  const quota = new Error('sem espaço');
  quota.name = 'QuotaExceededError';
  const { store, backend } = await open();
  backend.failNext(quota);
  const refused = await store.importText(courseText());
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'quota');
  assert.deepEqual(store.list(), []);

  const ok = await store.importText(courseText());
  assert.equal(ok.ok, true);
  await store.setLessonState(COURSE, 'aula-1', { watched: true });
  backend.failNext(quota);
  await assert.rejects(() => store.setLessonState(COURSE, 'aula-1', { notes: 'não deve gravar' }));
  assert.equal(store.lessonState(COURSE, 'aula-1').watched, true);
  assert.equal(store.lessonState(COURSE, 'aula-1').notes, '');
});

test('curso: sem IndexedDB a loja recusa escrever em vez de fingir memória', async () => {
  const store = await openCourseStore({ indexedDB: undefined, now: clock(), uuid: nextUuid });
  assert.equal(store.persistent, false);
  assert.equal(store.errorCode, 'unavailable');
  assert.ok(store.error.length > 0);
  const refused = await store.importText(courseText());
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'unavailable');
  assert.deepEqual(store.list(), []);
  await assert.rejects(() => store.setLessonState(COURSE, 'aula-1', { watched: true }), { name: 'CourseStorageError', code: 'unavailable' });
  await assert.rejects(() => store.recordWatch(COURSE, 'aula-1', { startedAt: 'a', endedAt: 'b' }), { code: 'unavailable' });
  await assert.rejects(() => store.removeCourse(COURSE), { code: 'unavailable' });
});

test('curso: com IndexedDB disponível, curso e estado sobrevivem a uma nova abertura', async () => {
  const factory = fakeIndexedDB();
  const now = clock();
  const first = await openCourseStore({ indexedDB: factory, now, uuid: nextUuid });
  await first.ready();
  assert.equal(first.persistent, true);
  assert.equal((await first.importText(courseText())).ok, true);
  await first.setLessonState(COURSE, 'aula-1', { watched: true, notes: 'exemplo' });

  const second = await openCourseStore({ indexedDB: factory, now, uuid: nextUuid });
  await second.ready();
  assert.deepEqual(second.list().map(record => record.id), [COURSE]);
  assert.equal(second.lessonState(COURSE, 'aula-1').watched, true);
  assert.equal(second.lessonState(COURSE, 'aula-1').notes, 'exemplo');
  assert.equal(second.summary(COURSE, {}).done, 0);
});

test('curso: origens e progresso já estão disponíveis ao obter a loja compartilhada', async t => {
  resetSharedCourseStore();
  t.after(resetSharedCourseStore);
  const factory = fakeIndexedDB();
  const first = await openCourseStore({ indexedDB: factory, now: clock(), uuid: nextUuid });
  await first.importText(courseText());
  await first.setLessonState(COURSE, 'aula-1', { watched: true, notes: 'Anotação de Exemplo' });
  await first.linkExercise(COURSE, 'aula-1', 'exercicio-exemplo');

  // O consumidor do Estúdio não abre a página de cursos nem chama ready().
  const restored = await sharedCourseStore({ indexedDB: factory });
  assert.deepEqual(restored.originsOf('exercicio-exemplo').map(origin => [origin.courseId, origin.lessonId]), [[COURSE, 'aula-1']]);
  assert.equal(restored.lessonState(COURSE, 'aula-1').watched, true);
  assert.equal(restored.lessonState(COURSE, 'aula-1').notes, 'Anotação de Exemplo');
});

test('curso: remover apaga só a estrutura e reimportar devolve o estado guardado', async () => {
  const { store } = await open();
  await store.importText(courseText());
  await store.setLessonState(COURSE, 'aula-2', { watched: true, notes: 'guardado' });
  assert.equal(await store.removeCourse(COURSE), true);
  assert.deepEqual(store.list(), []);
  assert.equal(await store.removeCourse(COURSE), false);
  await store.importText(courseText());
  assert.equal(store.lessonState(COURSE, 'aula-2').watched, true);
  assert.equal(store.lessonState(COURSE, 'aula-2').notes, 'guardado');
});

test('curso: exportar e reimportar em outra loja devolve estrutura e progresso', async () => {
  const { store } = await open();
  await store.importText(courseText());
  await store.setLessonState(COURSE, 'aula-2', { watched: true });
  const exported = store.exportText(COURSE);
  assert.equal(exported.ok, true);
  assert.equal(store.exportText('curso-inexistente').ok, false);

  const { store: other } = await open();
  const result = await other.importText(exported.text);
  assert.equal(result.ok, true);
  assert.equal(result.watched, 1);
  const original = store.get(COURSE).course;
  const copy = other.get(COURSE).course;
  assert.deepEqual(copy.sections, original.sections);
  assert.equal(other.lessonState(COURSE, 'aula-2').watched, true);
});

test('curso: registros ilegíveis ficam preservados e fora da lista', async () => {
  const backend = memoryBackend();
  backend.seed('courses', { id: 'curso-quebrado' });
  backend.seed('states', 'não é objeto');
  const store = createCourseStore({ backend, now: clock(), uuid: nextUuid });
  await store.ready();
  await store.importText(courseText());
  assert.deepEqual(store.list().map(record => record.id), [COURSE]);
  const corrupt = store.corrupt();
  assert.equal(corrupt.length, 2);
  assert.deepEqual(corrupt.map(entry => entry.store).sort(), ['courses', 'states']);
  assert.ok(store.warning.length > 0);
});

test('curso: 200 aulas entram, saem para tombstone e voltam sem perder estado', async () => {
  const many = count => Array.from({ length: count }, (unused, index) => lesson(`aula-${index + 1}`));
  const full = courseDocument({ sections: [section('modulo-1', many(200))] });
  full.progress = { watchedLessonIds: many(200).map(item => item.id) };
  const { store } = await open();
  const imported = await store.importText(courseText(full));
  assert.equal(imported.ok, true);
  assert.equal(imported.counts.lessons, 200);
  assert.equal(imported.watched, 200);

  const reduced = courseDocument({ sections: [section('modulo-1', many(120))] });
  const second = await store.importText(courseText(reduced));
  assert.equal(second.preserved, 120);
  assert.equal(second.removed, 80);
  const state = store.get(COURSE).state;
  assert.equal(state.removed.length, 80);
  assert.ok(state.removed.every(entry => entry.state.watched === true));
  assert.equal(Object.keys(state.lessons).length, 120);

  const back = await store.importText(courseText(full));
  assert.equal(back.restored, 80);
  assert.equal(store.get(COURSE).state.removed.length, 0);
  assert.equal(store.lessonState(COURSE, 'aula-200').watched, true);
});

test('curso: reimportações acumulam mais de 200 removidas sem perder estado', async () => {
  // O limite de 200 aulas vale para o DOCUMENTO importado (course-format.js);
  // o estado já salvo não pode ser cortado quando a soma de reimportações passa
  // disso — senão notas, vínculos e progresso das mais antigas sumiriam.
  const round = prefix => courseDocument({
    sections: [section('modulo-1', Array.from({ length: 150 }, (unused, index) => lesson(`${prefix}-${index + 1}`)))],
  });
  const backend = memoryBackend();
  const { store } = await open({ backend });
  assert.equal((await store.importText(courseText(round('a')))).ok, true);
  await store.setLessonState(COURSE, 'a-7', { notes: 'anotação guardada' });
  await store.linkExercise(COURSE, 'a-7', 'ex-a-7');
  await store.setLessonState(COURSE, 'a-8', { watched: true });

  assert.equal((await store.importText(courseText(round('b')))).removed, 150);
  assert.equal((await store.importText(courseText(round('c')))).removed, 150);

  const state = store.get(COURSE).state;
  assert.equal(state.removed.length, 300);
  const kept = state.removed.find(entry => entry.id === 'a-7');
  assert.equal(kept.state.notes, 'anotação guardada');
  assert.deepEqual(kept.state.linkedExerciseIds, ['ex-a-7']);
  assert.equal(state.removed.find(entry => entry.id === 'a-8').state.watched, true);
  // Gravado e recarregado por inteiro, e uma mutação seguinte não reescreve o
  // estado cortado (era assim que o corte virava perda definitiva no banco).
  assert.equal(backend.raw('states')[0].removed.length, 300);
  const { store: reloaded } = await open({ backend });
  assert.equal(reloaded.get(COURSE).state.removed.length, 300);
  await reloaded.setLessonState(COURSE, 'c-1', { watched: true });
  assert.equal(backend.raw('states')[0].removed.length, 300);
  assert.equal(backend.raw('states')[0].removed.find(entry => entry.id === 'a-7').state.notes, 'anotação guardada');
});

test('curso: histórico de estudo salvo não é descartado por idade nem por quantidade', async () => {
  const old = (id, startedAt, endedAt) => ({ id, lessonId: 'aula-1', startedAt, endedAt, ms: Date.parse(endedAt) - Date.parse(startedAt) });
  const backend = memoryBackend();
  const seeded = [
    old('antigo-1', '2020-01-01T10:00:00.000Z', '2020-01-01T10:30:00.000Z'),
    old('antigo-2', '2019-06-01T10:00:00.000Z', '2019-06-01T10:15:00.000Z'),
  ];
  const recent = Array.from({ length: 4098 }, (unused, index) => {
    const startedAt = new Date(Date.UTC(2026, 9, 7, 17, index % 55)).toISOString();
    return old(`recente-${index}`, startedAt, new Date(Date.parse(startedAt) + 60000).toISOString());
  });
  backend.seed('courses', {
    id: COURSE,
    importedAt: '2026-10-05T12:00:00.000Z',
    updatedAt: '2026-10-05T12:00:00.000Z',
    source: null,
    counts: { sections: 1, lessons: 1, resources: 0, exercises: 0 },
    course: courseDocument({ sections: [section('modulo-1', [lesson('aula-1')])] }).course,
  });
  backend.seed('states', {
    courseId: COURSE,
    createdAt: '2026-10-05T12:00:00.000Z',
    updatedAt: '2026-10-05T12:00:00.000Z',
    activeLessonId: null,
    lessons: {},
    removed: [],
    watch: [...seeded, ...recent],
  });

  const { store } = await open({ backend });
  assert.equal(store.watchIntervals(COURSE).length, 4100);
  await store.recordWatch(COURSE, 'aula-1', { startedAt: '2026-10-07T18:00:00.000Z', endedAt: '2026-10-07T18:45:00.000Z' });
  const kept = store.watchIntervals(COURSE);
  assert.equal(kept.length, 4101);
  assert.equal(kept[0].id, 'antigo-1');
  assert.equal(kept[1].id, 'antigo-2');
  assert.equal(kept.at(-1).ms, 45 * 60000);
  assert.equal(backend.raw('states')[0].watch.length, 4101);
  const { store: reloaded } = await open({ backend });
  assert.equal(reloaded.watchIntervals(COURSE).length, 4101);
  assert.deepEqual(reloaded.watchIntervals(COURSE).slice(0, 2).map(interval => interval.id), ['antigo-1', 'antigo-2']);
});

test('curso: escritas simultâneas de campos diferentes não se perdem', async () => {
  const { store } = await open();
  await store.importText(courseText());

  // Mesma aula, campos diferentes: a segunda escrita não pode gravar por cima
  // do estado que a primeira acabou de confirmar.
  await Promise.all([
    store.setLessonState(COURSE, 'aula-1', { watched: true }),
    store.setLessonState(COURSE, 'aula-1', { notes: 'anotação simultânea' }),
  ]);
  const aula1 = store.lessonState(COURSE, 'aula-1');
  assert.equal(aula1.watched, true);
  assert.equal(aula1.notes, 'anotação simultânea');

  await Promise.all([
    store.setLessonState(COURSE, 'aula-2', { watched: true }),
    store.linkExercise(COURSE, 'aula-2', 'ex-simultaneo'),
    store.setCompletionOverride(COURSE, 'aula-2', 'complete'),
    store.recordWatch(COURSE, 'aula-2', { startedAt: '2026-10-07T17:00:00.000Z', endedAt: '2026-10-07T17:30:00.000Z' }),
  ]);
  const aula2 = store.lessonState(COURSE, 'aula-2');
  assert.equal(aula2.watched, true);
  assert.deepEqual(aula2.linkedExerciseIds, ['ex-simultaneo']);
  assert.equal(aula2.completionOverride, 'complete');
  assert.equal(store.watchIntervals(COURSE).length, 1);
  assert.equal(store.summary(COURSE, {}).rows.find(row => row.lesson.id === 'aula-2').watchMs, 30 * 60000);

  // Aulas diferentes ao mesmo tempo: nenhuma pode desaparecer.
  await Promise.all([
    store.setLessonState(COURSE, 'aula-3', { watched: true }),
    store.setLessonState(COURSE, 'aula-0', { skipped: true }),
  ]);
  assert.equal(store.lessonState(COURSE, 'aula-3').watched, true);
  assert.equal(store.lessonState(COURSE, 'aula-0').skipped, true);
});

test('curso: reimportação simultânea a uma marcação de aula não perde a marcação', async () => {
  const { store, backend } = await open();
  await store.importText(courseText());
  const reduced = courseDocument({ sections: [section('modulo-1', [lesson('aula-1')])] });
  await Promise.all([
    store.importText(courseText(reduced)),
    store.setLessonState(COURSE, 'aula-1', { notes: 'corrida com reimportação' }),
  ]);
  assert.equal(store.lessonState(COURSE, 'aula-1').notes, 'corrida com reimportação');
  assert.equal(store.get(COURSE).state.removed.length, 3);
  assert.equal(backend.raw('states')[0].lessons['aula-1'].notes, 'corrida com reimportação');
});

test('curso: lote simultâneo a uma reimportação não cria estado de aula fora do mapa', async () => {
  const { store, backend } = await open();
  await store.importText(courseText());
  const reduced = courseDocument({ sections: [section('modulo-1', [lesson('aula-1')])] });
  const [, bulk] = await Promise.all([
    store.importText(courseText(reduced)),
    store.setWatchedThrough(COURSE, 'aula-3'),
  ]);
  // O lote lê estrutura e estado na MESMA seção serializada, então a ordem da
  // corrida muda o que ele consegue marcar — nunca deixa registro de aula que
  // já saiu do mapa. Se a reimportação vence, a aula pedida não existe mais e o
  // lote devolve null sem gravar nada.
  const state = store.get(COURSE).state;
  assert.deepEqual(Object.keys(state.lessons).filter(id => id !== 'aula-1'), []);
  assert.deepEqual(Object.keys(backend.raw('states')[0].lessons).filter(id => id !== 'aula-1'), []);
  if (bulk === null) assert.deepEqual(Object.keys(state.lessons), []);
  else {
    assert.equal(bulk.count, 3);
    assert.deepEqual(Object.keys(state.lessons), ['aula-1']);
  }
  assert.deepEqual(state.removed.map(entry => entry.id), ['aula-2', 'aula-3', 'aula-0']);
  await store.setWatchedThrough(COURSE, 'aula-1');
  assert.equal(store.lessonState(COURSE, 'aula-1').watched, true);
});

test('curso: falha de gravação mantém o estado e não trava as próximas mutações', async () => {
  const quota = new Error('sem espaço');
  quota.name = 'QuotaExceededError';
  const { store, backend } = await open();
  await store.importText(courseText());
  await store.setLessonState(COURSE, 'aula-1', { watched: true });

  backend.failNext(quota);
  await assert.rejects(() => store.setLessonState(COURSE, 'aula-1', { notes: 'não deve entrar' }), { name: 'QuotaExceededError' });
  assert.equal(store.lessonState(COURSE, 'aula-1').notes, '');
  assert.equal(backend.raw('states')[0].lessons['aula-1'].notes, '');

  // A fila segue: as próximas mutações (inclusive simultâneas) gravam de fato.
  const [noted] = await Promise.all([
    store.setLessonState(COURSE, 'aula-1', { notes: 'depois da falha' }),
    store.setLessonState(COURSE, 'aula-2', { watched: true }),
  ]);
  assert.equal(noted.notes, 'depois da falha');
  assert.equal(store.lessonState(COURSE, 'aula-2').watched, true);
  assert.equal(backend.raw('states')[0].lessons['aula-1'].notes, 'depois da falha');
  assert.equal(backend.raw('states')[0].lessons['aula-2'].watched, true);
});

test('curso: marcar assistidas até uma aula inclui a própria e o undo desfaz só o que mudou', async () => {
  const { store } = await open();
  await store.importText(courseText());
  await store.setLessonState(COURSE, 'aula-1', { watched: true, notes: 'anotação anterior' });

  const bulk = await store.setWatchedThrough(COURSE, 'aula-2');
  assert.equal(bulk.count, 1);
  assert.deepEqual(bulk.undo, [{ lessonId: 'aula-2', watched: false }]);
  assert.equal(store.lessonState(COURSE, 'aula-2').watched, true);
  assert.equal(store.lessonState(COURSE, 'aula-3').watched, false);
  assert.equal(await store.setWatchedThrough(COURSE, 'aula-inexistente'), null);
  assert.equal(await store.setWatchedThrough('curso-inexistente', 'aula-1'), null);
  await assert.rejects(() => store.setWatchedThrough(COURSE, ''), TypeError);

  // Escritas POSTERIORES ao lote não podem ser apagadas pelo undo.
  await store.setLessonState(COURSE, 'aula-2', { notes: 'escrita depois do lote' });
  await store.linkExercise(COURSE, 'aula-2', 'ex-depois');
  await store.setCompletionOverride(COURSE, 'aula-2', 'complete');
  assert.deepEqual(await store.restoreWatched(COURSE, bulk.undo), { restored: 1 });
  const restored = store.lessonState(COURSE, 'aula-2');
  assert.equal(restored.watched, false);
  assert.equal(restored.notes, 'escrita depois do lote');
  assert.deepEqual(restored.linkedExerciseIds, ['ex-depois']);
  assert.equal(restored.completionOverride, 'complete');
  assert.equal(store.lessonState(COURSE, 'aula-1').watched, true);
  // Desfazer de novo (ou com lista vazia) não muda nada.
  assert.deepEqual(await store.restoreWatched(COURSE, bulk.undo), { restored: 0 });
  assert.deepEqual(await store.restoreWatched(COURSE, []), { restored: 0 });
  await assert.rejects(() => store.restoreWatched(COURSE, [{ lessonId: 'aula-1' }]), TypeError);
  await assert.rejects(() => store.restoreWatched(COURSE, 'nada'), TypeError);
  // Lote já assistido não grava nada e devolve undo vazio.
  const again = await store.setWatchedThrough(COURSE, 'aula-1');
  assert.equal(again.count, 0);
  assert.deepEqual(again.undo, []);
});

test('curso: undo do lote restaura aula que saiu do mapa em uma reimportação', async () => {
  const { store, backend } = await open();
  await store.importText(courseText());
  const bulk = await store.setWatchedThrough(COURSE, 'aula-3');
  assert.equal(bulk.count, 3);
  assert.deepEqual(bulk.undo.map(entry => entry.lessonId), ['aula-1', 'aula-2', 'aula-3']);

  await store.importText(courseText(courseDocument({ sections: [section('modulo-1', [lesson('aula-1')])] })));
  assert.deepEqual(store.get(COURSE).state.removed.map(entry => entry.id).sort(), ['aula-0', 'aula-2', 'aula-3']);
  await store.setLessonState(COURSE, 'aula-3', { notes: 'anotação no tombstone' });

  assert.deepEqual(await store.restoreWatched(COURSE, bulk.undo), { restored: 3 });
  const state = store.get(COURSE).state;
  assert.equal(state.lessons['aula-1'].watched, false);
  const tombstone = state.removed.find(entry => entry.id === 'aula-3');
  assert.equal(tombstone.state.watched, false);
  assert.equal(tombstone.state.notes, 'anotação no tombstone');
  const stored = backend.raw('states')[0];
  assert.equal(stored.lessons['aula-1'].watched, false);
  assert.equal(stored.removed.find(entry => entry.id === 'aula-3').state.watched, false);
});

test('curso: concorrência e tombstones acumulados também no caminho do IndexedDB', async () => {
  const factory = fakeIndexedDB();
  const now = clock();
  const first = await openCourseStore({ indexedDB: factory, now, uuid: nextUuid });
  await first.ready();
  assert.equal((await first.importText(courseText())).ok, true);
  await Promise.all([
    first.setLessonState(COURSE, 'aula-1', { watched: true }),
    first.setLessonState(COURSE, 'aula-2', { notes: 'concorrente no IndexedDB' }),
  ]);

  const round = prefix => courseDocument({
    sections: [section('modulo-1', Array.from({ length: 90 }, (unused, index) => lesson(`${prefix}-${index + 1}`)))],
  });
  for (const prefix of ['x', 'y', 'z', 'w']) assert.equal((await first.importText(courseText(round(prefix)))).ok, true);

  const second = await openCourseStore({ indexedDB: factory, now, uuid: nextUuid });
  await second.ready();
  // As duas escritas concorrentes sobreviveram: elas acompanharam as aulas que
  // saíram do mapa, guardadas no tombstone (não há registro vivo fora do mapa).
  const state = second.get(COURSE).state;
  const tombstone = id => state.removed.find(entry => entry.id === id);
  assert.equal(tombstone('aula-1').state.watched, true);
  assert.equal(tombstone('aula-2').state.notes, 'concorrente no IndexedDB');
  assert.equal(Object.hasOwn(state.lessons, 'aula-1'), false);
  assert.equal(state.removed.length, 274);
  assert.equal(state.removed[0].id, 'aula-1');
  assert.equal(state.removed[0].state.watched, true);
});

// Ids reservados ("__proto__", "constructor", "toString") são ids VÁLIDOS do
// formato. Eles precisam virar entradas PRÓPRIAS do dicionário de estado:
// `lessons[id] = …` cairia no setter herdado do Object.prototype, o registro
// sumiria sem erro e um recarregamento perderia o progresso.
const RESERVED_IDS = ['__proto__', 'constructor', 'toString'];

function reservedCourseText() {
  return courseText(courseDocument({
    sections: [section('modulo-1', [...RESERVED_IDS.map(id => lesson(id)), lesson('aula-4')])],
  }));
}

test('curso: id reservado vira entrada própria e sobrevive a reabrir o banco', async () => {
  const factory = fakeIndexedDB();
  const now = clock();
  const first = await openCourseStore({ indexedDB: factory, now, uuid: nextUuid });
  await first.ready();
  const imported = await first.importText(reservedCourseText());
  assert.equal(imported.ok, true, imported.error);

  for (const id of RESERVED_IDS) {
    await first.setLessonState(COURSE, id, { watched: true, notes: `anotação de ${id}` });
    await first.linkExercise(COURSE, id, `ex-${id}`);
    assert.equal(first.lessonState(COURSE, id).watched, true);
    assert.equal(first.lessonState(COURSE, id).notes, `anotação de ${id}`);
    assert.deepEqual(first.lessonState(COURSE, id).linkedExerciseIds, [`ex-${id}`]);
  }
  const state = first.get(COURSE).state;
  assert.deepEqual(Object.keys(state.lessons).sort(), [...RESERVED_IDS].sort());
  for (const id of RESERVED_IDS) {
    assert.equal(Object.hasOwn(state.lessons, id), true, `${id} precisa ser entrada própria`);
    const roundtrip = JSON.parse(JSON.stringify(state.lessons));
    assert.equal(roundtrip[id].watched, true);
    assert.equal(roundtrip[id].notes, `anotação de ${id}`);
  }
  // Estado continua esparso: aula sem registro não ganhou entrada.
  assert.equal(Object.hasOwn(state.lessons, 'aula-4'), false);

  // Desvincular no id reservado não estoura nem apaga o resto do estado.
  assert.deepEqual((await first.unlinkExercise(COURSE, '__proto__', 'ex-__proto__')).linkedExerciseIds, []);
  assert.equal(first.lessonState(COURSE, '__proto__').notes, 'anotação de __proto__');

  // Reabrir o MESMO banco: nada foi perdido nem herdado do protótipo.
  const second = await openCourseStore({ indexedDB: factory, now, uuid: nextUuid });
  await second.ready();
  for (const id of RESERVED_IDS) {
    assert.equal(second.lessonState(COURSE, id).watched, true);
    assert.equal(second.lessonState(COURSE, id).notes, `anotação de ${id}`);
  }
  assert.deepEqual(second.linkedExerciseIds(COURSE).sort(), ['ex-constructor', 'ex-toString']);
  assert.equal(second.originsOf('ex-constructor').length, 1);
  assert.equal(second.originsOf('ex-constructor')[0].lessonId, 'constructor');
  const rows = second.summary(COURSE, {}).rows;
  assert.equal(rows.find(row => row.lesson.id === '__proto__').status, 'done');
  assert.equal(rows.find(row => row.lesson.id === 'constructor').status, 'watched');
  assert.equal(rows.find(row => row.lesson.id === 'aula-4').status, 'not-started');
});

test('curso: normalização e fusão guardam id reservado como entrada própria', async () => {
  // Dicionário cru com ids reservados: só a entrada PRÓPRIA vale.
  const raw = JSON.parse('{"__proto__":{"watched":true,"notes":"nota reservada"},"constructor":{"skipped":true}}');
  const normalized = normalizeCourseState({ lessons: raw }, COURSE);
  assert.equal(Object.hasOwn(normalized.lessons, '__proto__'), true);
  assert.equal(normalized.lessons['__proto__'].watched, true);
  assert.equal(normalized.lessons['__proto__'].notes, 'nota reservada');
  assert.equal(normalized.lessons['constructor'].skipped, true);

  const nextCourse = courseDocument({
    sections: [section('modulo-1', RESERVED_IDS.map(id => lesson(id)))],
  }).course;
  const merged = mergeCourseState(
    { lessons: raw, removed: [{ id: 'toString', title: 'Aula reservada', state: { watched: true } }] },
    courseDocument().course,
    nextCourse,
    { now: '2026-10-05T12:00:00.000Z' },
  );
  assert.equal(merged.counts.preserved, 2);
  assert.equal(merged.counts.restored, 1);
  assert.deepEqual(Object.keys(merged.state.lessons).sort(), [...RESERVED_IDS].sort());
  assert.equal(Object.hasOwn(merged.state.lessons, '__proto__'), true);
  assert.equal(merged.state.lessons['__proto__'].notes, 'nota reservada');
  assert.equal(merged.state.lessons['toString'].watched, true);
  assert.deepEqual(merged.state.removed.map(entry => entry.id).sort(), ['aula-0', 'aula-1', 'aula-2', 'aula-3']);
});

test('curso: lote assistida e undo funcionam com id reservado e tombstone', async () => {
  const { store, backend } = await open();
  await store.importText(reservedCourseText());
  const bulk = await store.setWatchedThrough(COURSE, 'constructor');
  assert.equal(bulk.count, 2);
  assert.deepEqual(bulk.undo.map(entry => entry.lessonId), ['__proto__', 'constructor']);
  assert.equal(store.lessonState(COURSE, '__proto__').watched, true);
  assert.equal(JSON.parse(JSON.stringify(store.get(COURSE).state.lessons))['__proto__'].watched, true);

  // A aula reservada sai do mapa: vira tombstone com o estado e o undo restaura.
  await store.importText(courseText(courseDocument({
    sections: [section('modulo-1', [lesson('constructor'), lesson('toString'), lesson('aula-4')])],
  })));
  assert.deepEqual(store.get(COURSE).state.removed.map(entry => entry.id), ['__proto__']);
  assert.deepEqual(await store.restoreWatched(COURSE, bulk.undo), { restored: 2 });
  assert.equal(store.lessonState(COURSE, 'constructor').watched, false);
  const tombstone = store.get(COURSE).state.removed.find(entry => entry.id === '__proto__');
  assert.equal(tombstone.state.watched, false);
  assert.equal(backend.raw('states')[0].removed.find(entry => entry.id === '__proto__').state.watched, false);
});
