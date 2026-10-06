// Testes da aula do curso (rodada 5, etapa 6).
//
// Consumidor: o que a aula promete à interface — exercício NOVO e canônico com
// perfil baixo 4/5, notas vazias e alvo nulo/número; vínculo fora da sessão;
// dois exercícios vinculados exigindo alvo; override explícito de conclusão
// (Concluir mesmo assim / Reabrir / Retomar); lote de assistidas com desfazer
// EXATO pelo batch da loja; materiais da aula e de outra aula; e anexos que
// sobrevivem à reimportação com a aula removida.
//
// Tudo fictício: "Curso de Exemplo", "Aula 3", example.invalid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExerciseLibrary } from '../src/exercise-library.js';
import { createCourseStore, CourseStorageError } from '../src/course-store.js';
import { createSession, parseSession, serializeSession, MAX_BARS, MIN_BARS } from '../src/session.js';
import { withStudioChoices } from '../src/studio-session.js';
import { standardInstrumentProfile, instrumentInputPitch } from '../src/instrument-profile.js';
import { createAttachmentStore, attachmentRefKey } from '../src/course-attachments.js';
import {
  buildSuggestedExercise, instrumentStringsFor, lessonMaterialRows, lessonOutcome, orphanAttachmentRefs,
  parseOptionalBpm, restoreWatched, suggestedBars, watchThrough,
} from '../src/course-lesson.js';
import { courseDocument, lesson, memoryBackend, memoryStorage } from './course-lesson-fixtures.js';

const NOW = () => '2026-01-02T03:04:05.000Z';

function counter(prefix) {
  let value = 0;
  return () => `${prefix}-${(value += 1)}`;
}

function courseStore() {
  return createCourseStore({ backend: memoryBackend(), now: NOW, uuid: counter('estado') });
}

async function importCourse(store, document = courseDocument()) {
  const result = await store.importText(JSON.stringify(document), { source: 'teste' });
  assert.equal(result.ok, true, result.error);
  return result.courseId;
}

function bassSession(name = 'Exercício base') {
  const profile = standardInstrumentProfile('bass', 4);
  return withStudioChoices(createSession({
    name,
    bars: 4,
    loop: { startBar: 0, endBar: 4 },
    progression: { cycleBars: 4 },
    timbres: { phrase: 'electric-bass' },
    extensions: { studio: { instrument: profile, inputPitch: instrumentInputPitch(profile) } },
  }));
}

function makeLibrary() {
  return createExerciseLibrary({
    storage: memoryStorage(),
    parse: parseSession,
    serialize: serializeSession,
    currentSession: bassSession('Sessão inicial'),
    now: NOW,
    uuid: counter('ex'),
  });
}

function strictSummary(expected = 8, ok = expected) {
  return { mode: 'strict', expected, attackOk: ok, endOk: ok, pitchOk: 0, pitchChecked: 0, free: 0 };
}

// Registra uma execução AUTORAL no alvo para o exercício informado. O dono do
// registro é o exercício selecionado — igual ao app, onde a execução começa
// com o exercício ativo.
function recordRun(library, id, { bpm, ratio = 1, source = 'authored' }) {
  const entry = library.select(id) ?? library.get(id);
  const expected = 8;
  const context = library.captureRunContext(entry.session, { source });
  return library.recordRun(context, {
    bpm,
    metric: ratio,
    summary: strictSummary(expected, Math.round(expected * ratio)),
  });
}

function suggestionOf(document, lessonId, index = 0) {
  return document.course.sections
    .flatMap(section => section.lessons)
    .find(item => item.id === lessonId)
    .suggestedExercises[index];
}

test('aula: alvo digitado aceita vazio (sem alvo) e recusa o que não é BPM', () => {
  assert.deepEqual(parseOptionalBpm(''), { ok: true, value: null });
  assert.deepEqual(parseOptionalBpm('   '), { ok: true, value: null });
  assert.deepEqual(parseOptionalBpm('90'), { ok: true, value: 90 });
  assert.equal(parseOptionalBpm('80.5').ok, false);
  assert.equal(parseOptionalBpm('abc').ok, false);
  assert.equal(parseOptionalBpm('10').ok, false);
  assert.equal(parseOptionalBpm('400').ok, false);
});

test('aula: exercício novo nasce baixo 4/5, com notas vazias e alvo nulo ou número', () => {
  const document = courseDocument();
  const course = document.course;
  const suggestion = suggestionOf(document, 'aula-1');

  const draft = buildSuggestedExercise({ suggestion, course });
  assert.equal(draft.session.extensions.studio.instrument.type, 'bass');
  assert.equal(draft.session.extensions.studio.instrument.strings, 4);
  assert.equal(draft.session.extensions.studio.instrument.tuning.length, 4);
  assert.deepEqual(draft.session.notes, []);
  assert.equal(draft.session.name, 'Exercício de Exemplo');
  assert.equal(draft.session.bpm, 60);
  assert.equal(draft.session.bars, 4);
  assert.equal(draft.session.loop.endBar, 4);
  assert.equal(draft.metadata.targetBPM, 90);
  assert.deepEqual(draft.metadata.tags, []);

  // Cordas vêm da sugestão; sem sugestão, do curso — nunca de uma guitarra.
  assert.equal(instrumentStringsFor({ suggestion: { strings: 5 }, course }), 5);
  assert.equal(buildSuggestedExercise({ suggestion: { strings: 5, title: 'Cinco cordas' }, course }).session.extensions.studio.instrument.strings, 5);
  const fiveStringCourse = buildSuggestedExercise({ suggestion: { title: 'Sem sugestão de cordas' }, course: { strings: 5 } });
  assert.equal(fiveStringCourse.session.extensions.studio.instrument.strings, 5);
  const guitarPreference = { type: 'guitar', strings: 6, tuning: [], noteNames: 'letters' };
  assert.equal(buildSuggestedExercise({ suggestion: { title: 'Preferência de guitarra' }, course: null, preference: guitarPreference }).session.extensions.studio.instrument.strings, 4);

  // Ajustes da interface valem: BPM, alvo nulo e compassos.
  const tuned = buildSuggestedExercise({ suggestion, course, bpm: 72, targetBpm: null, bars: 8 });
  assert.equal(tuned.session.bpm, 72);
  assert.equal(tuned.session.bars, 8);
  assert.equal(tuned.session.loop.endBar, 8);
  assert.equal(tuned.metadata.targetBPM, null);
  assert.equal(tuned.targetBpm, null);

  // Compassos respeitam o teto do formato de sessão (64 hoje; 16 enquanto o
  // teto antigo valer) e o piso.
  assert.equal(suggestedBars({ suggestion: { bars: 64 } }), Math.min(64, MAX_BARS));
  assert.equal(suggestedBars({ suggestion: { bars: 0 } }), MIN_BARS);
  assert.equal(buildSuggestedExercise({ suggestion, course, bars: 64 }).session.bars, Math.min(64, MAX_BARS));
});

test('aula: criar pela sugestão, vincular fora da sessão e concluir só com o alvo atingido', async () => {
  const store = courseStore();
  const courseId = await importCourse(store);
  const library = makeLibrary();
  const document = courseDocument();
  const course = store.get(courseId).course;
  const suggestion = suggestionOf(document, 'aula-1');
  const draft = buildSuggestedExercise({ suggestion, course });

  const entry = library.new({ session: draft.session, metadata: draft.metadata });
  assert.deepEqual(entry.session.notes, []);
  assert.equal(entry.metadata.targetBPM, 90);
  assert.equal(library.saved, true);
  assert.equal(library.get(entry.id).session.extensions.studio.instrument.strings, 4);

  const linked = await store.linkExercise(courseId, 'aula-1', entry.id);
  assert.deepEqual(linked.linkedExerciseIds, [entry.id]);

  const resolve = id => library.get(id);
  let outcome = lessonOutcome(store, courseId, 'aula-1', { resolveExercise: resolve });
  assert.equal(outcome.links.length, 1);
  assert.equal(outcome.links[0].exists, true);
  assert.equal(outcome.links[0].hasTarget, true);
  assert.equal(outcome.completion.completed, false);
  assert.deepEqual(outcome.pending, ['not-watched', 'exercise-below-target']);
  assert.equal(outcome.status, 'not-started');

  await store.setLessonState(courseId, 'aula-1', { watched: true });
  outcome = lessonOutcome(store, courseId, 'aula-1', { resolveExercise: resolve });
  assert.deepEqual(outcome.pending, ['exercise-below-target']);
  assert.equal(outcome.completion.completed, false);
  assert.equal(outcome.status, 'watched');

  recordRun(library, entry.id, { bpm: 92 });
  outcome = lessonOutcome(store, courseId, 'aula-1', { resolveExercise: resolve });
  assert.equal(outcome.links[0].reached, true);
  assert.equal(outcome.completion.completed, true);
  assert.equal(outcome.completion.automatic, true);
  assert.deepEqual(outcome.pending, []);
  assert.equal(outcome.status, 'done');
});

test('aula: exercício criado sem alvo nunca satisfaz a conclusão', async () => {
  const store = courseStore();
  const courseId = await importCourse(store);
  const library = makeLibrary();
  const course = store.get(courseId).course;
  const draft = buildSuggestedExercise({ suggestion: { title: 'Sem alvo' }, course, targetBpm: null });
  assert.equal(draft.metadata.targetBPM, null);

  const entry = library.new({ session: draft.session, metadata: draft.metadata });
  assert.equal(entry.metadata.targetBPM, null);
  await store.linkExercise(courseId, 'aula-3', entry.id);
  await store.setLessonState(courseId, 'aula-3', { watched: true });
  // Mesmo treinando no alvo que o usuário tivesse em mente, sem alvo gravado
  // não existe alvo atingido.
  recordRun(library, entry.id, { bpm: 120 });
  const outcome = lessonOutcome(store, courseId, 'aula-3', { resolveExercise: id => library.get(id) });
  assert.equal(outcome.links[0].hasTarget, false);
  assert.equal(outcome.links[0].reached, false);
  assert.deepEqual(outcome.pending, ['exercise-without-target']);
  assert.equal(outcome.completion.completed, false);
  assert.equal(outcome.status, 'practicing');
});

test('aula: dois exercícios vinculados exigem os dois alvos, com override de conclusão explícito', async () => {
  const store = courseStore();
  const courseId = await importCourse(store);
  const library = makeLibrary();
  const course = store.get(courseId).course;

  const first = library.new({ session: buildSuggestedExercise({ suggestion: { title: 'Sugestão A' }, course }).session, metadata: { name: 'Sugestão A', targetBPM: 90 } });
  // Execuções que NÃO valem: material gerado e andamento abaixo do alvo.
  recordRun(library, first.id, { bpm: 95, source: 'generated' });
  recordRun(library, first.id, { bpm: 88 });
  const second = library.new({ session: buildSuggestedExercise({ suggestion: { title: 'Sugestão B' }, course }).session, metadata: { name: 'Sugestão B', targetBPM: 80 } });
  recordRun(library, second.id, { bpm: 84 });

  await store.linkExercise(courseId, 'aula-2', first.id);
  await store.linkExercise(courseId, 'aula-2', second.id);
  await store.setLessonState(courseId, 'aula-2', { watched: true });

  const resolve = id => library.get(id);
  let outcome = lessonOutcome(store, courseId, 'aula-2', { resolveExercise: resolve });
  assert.equal(outcome.links.length, 2);
  assert.equal(outcome.links[0].reached, false);
  assert.equal(outcome.links[1].reached, true);
  assert.equal(outcome.completion.completed, false);
  assert.deepEqual(outcome.pending, ['exercise-below-target']);
  assert.equal(outcome.status, 'practicing');

  recordRun(library, first.id, { bpm: 91 });
  outcome = lessonOutcome(store, courseId, 'aula-2', { resolveExercise: resolve });
  assert.equal(outcome.links[0].reached, true);
  assert.equal(outcome.completion.completed, true);
  assert.equal(outcome.status, 'done');

  await store.setCompletionOverride(courseId, 'aula-2', 'reopened');
  outcome = lessonOutcome(store, courseId, 'aula-2', { resolveExercise: resolve });
  assert.equal(outcome.completion.completed, false);
  assert.equal(outcome.completion.automatic, false);
  assert.deepEqual(outcome.pending, ['reopened']);

  await store.setCompletionOverride(courseId, 'aula-2', 'complete');
  outcome = lessonOutcome(store, courseId, 'aula-2', { resolveExercise: resolve });
  assert.equal(outcome.completion.completed, true);
  assert.equal(outcome.completion.automatic, false);
  assert.equal(outcome.completion.override, 'complete');

  await store.setCompletionOverride(courseId, 'aula-2', null);
  outcome = lessonOutcome(store, courseId, 'aula-2', { resolveExercise: resolve });
  assert.equal(outcome.completion.completed, true);
  assert.equal(outcome.completion.automatic, true);

  // Vínculo cujo exercício saiu da biblioteca continua pendência até desvincular.
  await store.linkExercise(courseId, 'aula-2', 'exercicio-que-nao-existe');
  outcome = lessonOutcome(store, courseId, 'aula-2', { resolveExercise: resolve });
  assert.equal(outcome.completion.completed, false);
  assert.deepEqual(outcome.pending, ['exercise-missing']);
  await store.unlinkExercise(courseId, 'aula-2', 'exercicio-que-nao-existe');
  outcome = lessonOutcome(store, courseId, 'aula-2', { resolveExercise: resolve });
  assert.equal(outcome.completion.completed, true);
});

test('aula: lote de assistidas até aqui desfaz só o watched e preserva o que veio depois', async () => {
  const store = courseStore();
  const courseId = await importCourse(store);
  const library = makeLibrary();
  const entry = library.new({ session: bassSession('Exercício do lote'), metadata: { name: 'Exercício do lote', targetBPM: null } });

  const batch = await watchThrough(store, courseId, 'aula-2');
  assert.equal(batch.count, 2);
  assert.deepEqual(batch.undo, [
    { lessonId: 'aula-1', watched: false },
    { lessonId: 'aula-2', watched: false },
  ]);
  assert.equal(store.lessonState(courseId, 'aula-1').watched, true);
  assert.equal(store.lessonState(courseId, 'aula-2').watched, true);
  assert.equal(store.lessonState(courseId, 'aula-3').watched, false);
  assert.equal(store.lessonState(courseId, 'aula-0').watched, false);

  await store.setLessonState(courseId, 'aula-1', { notes: 'anotação escrita depois do lote' });
  await store.setCompletionOverride(courseId, 'aula-1', 'reopened');
  await store.linkExercise(courseId, 'aula-1', entry.id);

  const restored = await restoreWatched(store, courseId, batch.undo);
  assert.equal(restored.restored, 2);
  const first = store.lessonState(courseId, 'aula-1');
  assert.equal(first.watched, false);
  assert.equal(first.notes, 'anotação escrita depois do lote');
  assert.equal(first.completionOverride, 'reopened');
  assert.deepEqual(first.linkedExerciseIds, [entry.id]);
  assert.equal(store.lessonState(courseId, 'aula-2').watched, false);

  const second = await watchThrough(store, courseId, 'aula-3');
  assert.equal(second.count, 3);
  const none = await watchThrough(store, courseId, 'aula-3');
  assert.deepEqual(none, { count: 0, undo: [] });
  assert.equal(await watchThrough(store, courseId, 'aula-inexistente'), null);
});

test('aula: desfazer o lote também vale para aula que virou removida na reimportação', async () => {
  const store = courseStore();
  const courseId = await importCourse(store);
  const batch = await watchThrough(store, courseId, 'aula-2');
  assert.equal(batch.count, 2);

  const trimmed = courseDocument();
  trimmed.course.sections[0].lessons = [lesson('aula-1'), lesson('aula-3')];
  const reimported = await store.importText(JSON.stringify(trimmed), { source: 'teste' });
  assert.equal(reimported.ok, true, reimported.error);
  assert.equal(reimported.removed, 1);
  const tombstone = store.get(courseId).state.removed.find(item => item.id === 'aula-2');
  assert.equal(tombstone.state.watched, true);

  const restored = await restoreWatched(store, courseId, batch.undo);
  assert.equal(restored.restored, 2);
  assert.equal(store.get(courseId).state.removed.find(item => item.id === 'aula-2').state.watched, false);
  assert.equal(store.lessonState(courseId, 'aula-1').watched, false);
});

test('aula: materiais próprios e de outra aula saem do mapa com a chave composta do anexo', async () => {
  const store = courseStore();
  const courseId = await importCourse(store);
  const found = store.get(courseId);
  const lessons = found.course.sections.flatMap(section => section.lessons);

  const own = lessonMaterialRows(found.course, lessons.find(item => item.id === 'aula-1'));
  assert.equal(own.length, 1);
  assert.equal(own[0].resourceId, 'material-1');
  assert.equal(own[0].crossLesson, false);
  assert.equal(own[0].missing, false);
  assert.equal(own[0].refKey, attachmentRefKey(courseId, 'aula-1', 'material-1'));

  const referenced = lessonMaterialRows(found.course, lessons.find(item => item.id === 'aula-2'));
  assert.equal(referenced.length, 1);
  assert.equal(referenced[0].crossLesson, true);
  assert.equal(referenced[0].name, 'Apostila de Exemplo');
  assert.equal(referenced[0].ownerLessonTitle, 'Aula aula-1');
  assert.equal(referenced[0].refKey, attachmentRefKey(courseId, 'aula-1', 'material-1'));
  assert.equal(referenced[0].missing, false);

  // Referência pendurada (estrutura editada à mão/legado) continua listada,
  // marcada, sem prometer material que não existe: o formato estrito recusa
  // esse caso na importação, então ele só chega aqui por estado já guardado.
  const dangling = {
    id: 'curso-exemplo',
    sections: [{
      id: 'modulo-1',
      title: 'Módulo 1',
      type: 'módulo',
      lessons: [
        lesson('aula-1'),
        lesson('aula-2', { resourceRefs: [{ lessonId: 'aula-1', resourceId: 'material-apagado' }] }),
      ],
    }],
  };
  const danglingRows = lessonMaterialRows(dangling, dangling.sections[0].lessons[1]);
  assert.equal(danglingRows.length, 1);
  assert.equal(danglingRows[0].missing, true);
  assert.equal(danglingRows[0].name, null);
  assert.equal(danglingRows[0].refKey, attachmentRefKey(courseId, 'aula-1', 'material-apagado'));
  assert.equal(orphanAttachmentRefs(dangling, [{ lessonId: 'aula-1', resourceId: 'material-apagado' }]).length, 1);
});

test('aula: anexo de aula removida na reimportação continua guardado e é reportado como órfão', async t => {
  const store = courseStore();
  const courseId = await importCourse(store);
  const attachments = createAttachmentStore({ backend: memoryBackend({ keyPaths: { files: 'id', refs: 'key' } }), now: NOW, uuid: counter('anexo') });
  await attachments.ready();
  const blob = new Blob([new TextEncoder().encode('%PDF-1.7\n%%EOF\n')], { type: 'application/pdf' });
  await attachments.put({ courseId, lessonId: 'aula-2', resourceId: 'material-1', name: 'Referência.pdf', blob });

  const trimmed = courseDocument();
  trimmed.course.sections[0].lessons = [lesson('aula-1'), lesson('aula-3')];
  const reimported = await store.importText(JSON.stringify(trimmed), { source: 'teste' });
  assert.equal(reimported.ok, true, reimported.error);

  const refs = attachments.listByCourse(courseId);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].present, true);
  assert.equal((await attachments.getBlob(refs[0].key)).size, blob.size);

  const orphans = orphanAttachmentRefs(store.get(courseId).course, refs);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].lessonId, 'aula-2');
  assert.equal(orphans[0].resourceId, 'material-1');

  // Material que ainda existe no mapa não é órfão.
  assert.deepEqual(orphanAttachmentRefs(courseDocument().course, [{
    ...refs[0], lessonId: 'aula-1', resourceId: 'material-1',
  }]), []);
});

test('aula: retirar só o material preserva a linha que abre o anexo local', async () => {
  const store = courseStore();
  const document = courseDocument();
  const courseId = await importCourse(store, document);
  const attachments = createAttachmentStore({ backend: memoryBackend({ keyPaths: { files: 'id', refs: 'key' } }), now: NOW, uuid: counter('anexo') });
  await attachments.ready();
  const contents = '%PDF-1.7\n% Material de Exemplo\n%%EOF\n';
  const saved = await attachments.put({
    courseId, lessonId: 'aula-1', resourceId: 'material-1',
    name: 'Material de Exemplo.pdf', blob: new Blob([contents], { type: 'application/pdf' }),
  });
  const changed = structuredClone(document);
  for (const section of changed.course.sections) {
    for (const item of section.lessons) {
      if (item.id === 'aula-1') item.resources = [];
      item.resourceRefs = item.resourceRefs.filter(ref => ref.lessonId !== 'aula-1' || ref.resourceId !== 'material-1');
    }
  }
  await importCourse(store, changed);
  const course = store.get(courseId).course;
  const current = course.sections[0].lessons.find(item => item.id === 'aula-1');
  const rows = lessonMaterialRows(course, current, attachments.list(courseId, current.id));
  const retained = rows.find(row => row.resourceId === 'material-1');
  assert.equal(retained.refKey, saved.key);
  assert.equal(retained.missing, true);
  assert.equal(retained.crossLesson, false);
  assert.equal(await (await attachments.getBlob(retained.refKey)).text(), contents);
});

test('aula: sem IndexedDB a aula não finge gravação', async () => {
  const store = createCourseStore({ persistent: false, error: new CourseStorageError('unavailable', 'IndexedDB ausente para cursos.') });
  assert.equal(store.persistent, false);
  assert.equal(lessonOutcome(store, 'curso-exemplo', 'aula-1'), null);
  await assert.rejects(
    () => watchThrough(store, 'curso-exemplo', 'aula-1'),
    error => error instanceof CourseStorageError && error.code === 'unavailable',
  );
  await assert.rejects(
    () => restoreWatched(store, 'curso-exemplo', [{ lessonId: 'aula-1', watched: false }]),
    error => error.code === 'unavailable',
  );
});
