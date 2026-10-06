// Backup agregado da biblioteca (rodada 5, etapa 7): testes de CONSUMIDOR.
//
// Exercitam os módulos reais (biblioteca de exercícios, loja de cursos, loja de
// anexos e o envelope agregado) com backends em memória, como os testes das
// etapas 5/6. Tudo fictício: "Curso de Exemplo", "Aula 1", example.invalid.
//
// A loja de anexos é da etapa 6 (worktree das aulas). Ela é carregada em tempo
// de execução: no worktree integrado os testes de anexo rodam; se o módulo
// ainda não estiver presente, eles aparecem como PULADOS (nunca como sucesso).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, parseSession, serializeSession } from '../src/session.js';
import { createExerciseLibrary } from '../src/exercise-library.js';
import { createCourseStore, CourseStorageError, IMPORTED_NOTES_SEPARATOR } from '../src/course-store.js';
import {
  buildBackup, serializeBackup, importBackup, validateBackup, summarizeBackup,
  describeImportResult, backupAttachmentSummary, formatByteSize, recognizeBackup, backupFileName,
} from '../src/library-backup.js';

let createAttachmentStore = null;
try { ({ createAttachmentStore } = await import('../src/course-attachments.js')); } catch { /* etapa 6 ausente */ }
const attachmentTests = createAttachmentStore === null ? { skip: 'módulo da etapa 6 ausente neste worktree' } : {};

// ------------------------------------------------------------------ fixtures

function clock(start = Date.UTC(2026, 9, 5, 12, 0, 0)) {
  let ticks = 0;
  return () => new Date(start + (ticks++) * 1000).toISOString();
}

let counter = 0;
function nextUuid() { counter += 1; return `id-${counter}`; }

function memoryStorage() {
  const map = new Map();
  let failing = false;
  return {
    raw: map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem(key, value) {
      if (failing) { const error = new Error('quota do navegador'); error.name = 'QuotaExceededError'; throw error; }
      map.set(key, String(value));
    },
    removeItem(key) { map.delete(key); },
    failWrites() { failing = true; },
  };
}

const COURSE_KEYS = Object.freeze({ courses: 'id', states: 'courseId' });
const ATTACHMENT_KEYS = Object.freeze({ files: 'id', refs: 'key' });

// Backend em memória com a MESMA interface dos backends IndexedDB reais
// (getAll/get/put/writeBatch/delete), com a chave certa por armazenamento.
function memoryBackend(keyPaths, { failNextWrite = null } = {}) {
  const stores = {};
  for (const name of Object.keys(keyPaths)) stores[name] = new Map();
  let pending = failNextWrite === null ? null : { remaining: 0, error: failNextWrite };
  const maybeFail = () => {
    if (!pending) return;
    if (pending.remaining > 0) { pending.remaining -= 1; return; }
    const { error } = pending;
    pending = null;
    throw error;
  };
  return {
    failNext(error) { pending = { remaining: 0, error }; },
    // Falha a N-ésima escrita seguinte (0 = a próxima), para exercitar o meio
    // de uma importação com vários cursos.
    failAfterWrites(count, error) { pending = { remaining: count, error }; },
    async getAll(store) { return [...stores[store].values()].map(value => structuredClone(value)); },
    async get(store, id) {
      const value = stores[store].get(id);
      return value === undefined ? undefined : structuredClone(value);
    },
    async put(store, value) {
      maybeFail();
      stores[store].set(value[keyPaths[store]], structuredClone(value));
    },
    // `{ store, value }` grava e `{ store, id, remove: true }` apaga, como o
    // backend real; tudo numa "transação" só.
    async writeBatch(entries) {
      maybeFail();
      for (const entry of entries) {
        if (entry.remove) stores[entry.store].delete(entry.id);
        else stores[entry.store].set(entry.value[keyPaths[entry.store]], structuredClone(entry.value));
      }
    },
    async delete(store, id) { stores[store].delete(id); },
    raw(store) { return [...stores[store].values()]; },
    seed(store, value) { stores[store].set(value[keyPaths[store]], value); },
  };
}

function lesson(id, overrides = {}) {
  return {
    id,
    title: `Aula ${id}`,
    url: `https://example.invalid/${id}`,
    type: 'aula',
    hasVideo: false,
    resources: [],
    resourceRefs: [],
    suggestedExercises: [],
    ...overrides,
  };
}

function courseDocument(overrides = {}) {
  return {
    format: 'groovegoblin-course',
    version: 1,
    course: {
      id: 'curso-exemplo',
      title: 'Curso de Exemplo',
      author: 'Autor de Exemplo',
      instrument: 'bass',
      strings: 4,
      sections: [
        { id: 'modulo-1', title: 'Módulo 1', type: 'módulo', lessons: [lesson('aula-1'), lesson('aula-2')] },
        { id: 'boas-vindas', title: 'Boas-vindas', type: 'boas-vindas', lessons: [lesson('aula-0')] },
      ],
      ...overrides,
    },
  };
}

const BASE_SESSION = () => createSession({ name: 'Sessão base', bars: 4, bpm: 80, notes: [{ id: 'n1', start: 0, duration: 4, pitch: 52, string: 4 }] });
const SESSION_A = () => createSession({ name: 'Exercício A', bars: 4, bpm: 80, notes: [{ id: 'a1', start: 0, duration: 4, pitch: 52, string: 4 }] });
const SESSION_B = () => createSession({ name: 'Exercício B', bars: 2, bpm: 90, notes: [{ id: 'b1', start: 0, duration: 2, pitch: 55, string: 3 }] });

function openLibrary(storage, currentSession = BASE_SESSION(), now = clock(), uuid = nextUuid) {
  return createExerciseLibrary({ storage, parse: parseSession, serialize: serializeSession, currentSession, now, uuid });
}

async function openCourses(backend, now = clock(), uuid = nextUuid) {
  const store = createCourseStore({ backend, now, uuid });
  await store.ready();
  return store;
}

function openAttachments(backend, now = clock(), uuid = nextUuid) {
  return createAttachmentStore({
    backend,
    now,
    uuid,
    digest: { digest: (algorithm, buffer) => globalThis.crypto.subtle.digest(algorithm, buffer) },
  });
}

// Exercício AUTORAL que atingiu o alvo (>= 90% dos ataques no BPM do alvo).
function trainToTarget(library, session, { bpm, targetBPM }) {
  const entry = library.new({ session });
  const context = library.captureRunContext(session, { source: 'authored' });
  library.recordRun(context, { bpm, summary: { mode: 'strict', expected: 10, attackOk: 9, endOk: 9, pitchOk: 9, pitchChecked: 10, free: 0 } });
  library.updateMetadata(entry.id, { targetBPM });
  return entry;
}

async function sourceWorld({ withAttachments = false, backend = memoryBackend(COURSE_KEYS), attachmentBackend = memoryBackend(ATTACHMENT_KEYS) } = {}) {
  const storage = memoryStorage();
  const library = openLibrary(storage);
  const store = await openCourses(backend);
  const attachments = createAttachmentStore === null ? null : openAttachments(attachmentBackend);
  const a = trainToTarget(library, SESSION_A(), { bpm: 90, targetBPM: 90 });
  const b = library.new({ session: SESSION_B() });
  library.updateMetadata(b.id, { targetBPM: 100, tags: ['dedilhado'], notes: 'anotação do exercício' });

  await store.importText(JSON.stringify(courseDocument()));
  await store.linkExercise('curso-exemplo', 'aula-1', a.id);
  await store.linkExercise('curso-exemplo', 'aula-1', b.id);
  await store.setLessonState('curso-exemplo', 'aula-1', { watched: true });
  await store.setLessonState('curso-exemplo', 'aula-2', { notes: 'anotação da aula 2', completionOverride: 'complete' });
  await store.setPreferences('curso-exemplo', { active: false, dailyMinutes: 25 });
  await store.recordWatch('curso-exemplo', 'aula-1', { startedAt: '2026-10-05T12:00:00.000Z', endedAt: '2026-10-05T12:10:00.000Z' });
  // Estado ÓRFÃO: um segundo curso é importado e removido; o progresso fica.
  const second = courseDocument({ id: 'curso-orfao', title: 'Curso Órfão' });
  await store.importText(JSON.stringify(second));
  await store.setLessonState('curso-orfao', 'aula-1', { watched: true, notes: 'progresso órfão' });
  await store.removeCourse('curso-orfao');

  if (withAttachments) {
    await attachments.put({
      courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'apostila.pdf', extension: 'pdf',
      role: 'apostila', source: 'upload', blob: new Blob([new TextEncoder().encode('%PDF-1.4 apostila de exemplo')], { type: 'application/pdf' }),
    });
    // Mesmo arquivo em outra aula: bytes contam UMA vez.
    await attachments.put({
      courseId: 'curso-exemplo', lessonId: 'aula-2', resourceId: 'material-2', name: 'apostila.pdf', extension: 'pdf',
      role: 'apostila', source: 'upload', blob: new Blob([new TextEncoder().encode('%PDF-1.4 apostila de exemplo')], { type: 'application/pdf' }),
    });
  }
  return { storage, library, store, attachments, attachmentsBackend: attachmentBackend, a, b, backend };
}

async function destinationWorld({ backend = memoryBackend(COURSE_KEYS), attachmentBackend = memoryBackend(ATTACHMENT_KEYS), session = BASE_SESSION() } = {}) {
  const storage = memoryStorage();
  const library = openLibrary(storage, session);
  const store = await openCourses(backend);
  const attachments = createAttachmentStore === null ? null : openAttachments(attachmentBackend);
  return { storage, library, store, attachments, backend, attachmentBackend };
}

// Mundo MÍNIMO: um curso de UMA aula, com um exercício vinculado e treinado no
// alvo (a aula fica concluída). Serve para o caso "reimportar o mesmo backup
// depois de treinar".
async function trainedWorld() {
  const library = openLibrary(memoryStorage());
  const store = await openCourses(memoryBackend(COURSE_KEYS));
  await store.importText(JSON.stringify(courseDocument({
    sections: [{ id: 'modulo-1', title: 'Módulo 1', type: 'módulo', lessons: [lesson('aula-1')] }],
  })));
  const entry = trainToTarget(library, SESSION_A(), { bpm: 90, targetBPM: 90 });
  await store.linkExercise('curso-exemplo', 'aula-1', entry.id);
  await store.setLessonState('curso-exemplo', 'aula-1', { watched: true });
  return { library, store, entry };
}

// ------------------------------------------------------------------- testes

test('backup: envelope do retrato traz catálogo, estados, órfãos e exercícios', async () => {
  const world = await sourceWorld();
  const built = await buildBackup({ library: world.library, store: world.store, attachments: world.attachments });
  assert.equal(built.ok, true);
  assert.equal(built.document.kind, 'groovegoblin-library-backup');
  assert.equal(built.document.version, 1);
  assert.equal(built.document.exercises.entries.length, world.library.size());
  assert.deepEqual(built.document.courses.records.map(record => record.id), ['curso-exemplo']);
  assert.deepEqual(built.document.courses.states.map(state => state.courseId), ['curso-exemplo', 'curso-orfao']);
  assert.deepEqual(built.document.courses.orphans, ['curso-orfao']);
  assert.equal(built.document.attachments.included, false);
  assert.equal(built.document.attachments.document, null);
  assert.equal(built.summary.orphans, 1);
  assert.equal(validateBackup(built.document).ok, true);
  // Órfão carrega o ESTADO, não só o id.
  assert.equal(built.document.courses.states.find(state => state.courseId === 'curso-orfao').lessons['aula-1'].notes, 'progresso órfão');
  assert.ok(serializeBackup(built.document).endsWith('\n'));
});

test('backup: rodada completa preserva estado, vínculos remapeados e conclusão 90% autoral', async () => {
  const source = await sourceWorld();
  const built = await buildBackup({ library: source.library, store: source.store, attachments: source.attachments });
  const text = serializeBackup(built.document);

  const dest = await destinationWorld();
  const activeBefore = dest.library.active();
  const result = await importBackup(text, { library: dest.library, store: dest.store, attachments: dest.attachments });
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(result.applied.exercises.added, 2);
  assert.equal(dest.library.size(), 3);

  // Vínculos remapeados para os ids DESTINO.
  const stateA = dest.store.get('curso-exemplo').state.lessons['aula-1'];
  const mapA = result.map[source.a.id];
  const mapB = result.map[source.b.id];
  assert.ok(mapA && mapB);
  assert.notEqual(mapA, source.a.id);
  assert.deepEqual(stateA.linkedExerciseIds, [mapA, mapB]);
  // Progresso, override, preferências e intervalos preservados.
  assert.equal(stateA.watched, true);
  assert.equal(dest.store.get('curso-exemplo').state.lessons['aula-2'].notes, 'anotação da aula 2');
  assert.equal(dest.store.get('curso-exemplo').state.lessons['aula-2'].completionOverride, 'complete');
  assert.deepEqual(dest.store.get('curso-exemplo').state.preferences, { active: false, dailyMinutes: 25 });
  assert.equal(dest.store.watchIntervals('curso-exemplo').length, 1);
  // Órfão restaurado com estado.
  assert.deepEqual(dest.store.snapshotAll().orphans.map(state => state.courseId), ['curso-orfao']);
  assert.equal(dest.store.snapshotAll().orphans[0].lessons['aula-1'].notes, 'progresso órfão');

  // A Conclusão da aula 1 vem do modelo puro: assistida + TODOS os vínculos no
  // alvo. Só o exercício A foi treinado até o alvo; o B ainda não — pendente.
  const summary = dest.store.summary('curso-exemplo', { resolveExercise: id => dest.library.get(id) });
  assert.notEqual(summary.rows.find(row => row.lesson.id === 'aula-1').status, 'done');
  assert.equal(summary.rows.find(row => row.lesson.id === 'aula-2').status, 'done');

  // O histórico veio inteiro e com dono REMAPEADO.
  const entryA = dest.library.get(mapA);
  assert.equal(entryA.metadata.records.length, 1);
  assert.equal(entryA.metadata.records[0].ownerId, mapA);
  assert.equal(entryA.metadata.targetBPM, 90);
  assert.equal(entryA.metadata.records[0].summary.attackOk, 9);
  // A sessão autoral chega byte a byte igual: a importação não reescreve frase.
  assert.equal(serializeSession(entryA.session), serializeSession(source.library.get(source.a.id).session));
  // A seleção atual da biblioteca de destino é preservada (não pula para o backup).
  assert.equal(dest.library.active(), activeBefore);
  const entryB = dest.library.get(mapB);
  assert.deepEqual(entryB.metadata.tags, ['dedilhado']);
  assert.equal(entryB.metadata.notes, 'anotação do exercício');
  assert.equal(entryB.metadata.targetBPM, 100);

  // Reimportar o MESMO arquivo é idempotente: nada cresce, nada duplica.
  const again = await importBackup(text, { library: dest.library, store: dest.store, attachments: dest.attachments });
  assert.equal(again.ok, true);
  assert.equal(again.applied.exercises.added, 0);
  assert.equal(again.applied.exercises.reused, 3);   // base (idêntico) + A + B
  assert.equal(dest.library.size(), 3);
  assert.equal(dest.store.watchIntervals('curso-exemplo').length, 1);
  assert.deepEqual(dest.store.get('curso-exemplo').state.lessons['aula-1'].linkedExerciseIds, [mapA, mapB]);

  // O vínculo remapeado aponta para o exercício certo: treinar o B até o alvo
  // na cópia conclui a aula 1 (sucesso autoral >= 90% no BPM do alvo).
  dest.library.select(mapB);
  const entryB0 = dest.library.get(mapB);
  const context = dest.library.captureRunContext(entryB0.session, { source: 'authored' });
  dest.library.recordRun(context, { bpm: 100, summary: { mode: 'strict', expected: 10, attackOk: 10, endOk: 10, pitchOk: 10, pitchChecked: 10, free: 0 } });
  const promoted = dest.store.summary('curso-exemplo', { resolveExercise: id => dest.library.get(id) });
  assert.equal(promoted.rows.find(row => row.lesson.id === 'aula-1').status, 'done');
});

test('backup: dedup é do exercício COMPLETO (sessão + metadados + histórico)', async () => {
  const source = await sourceWorld();
  const built = await buildBackup({ library: source.library, store: source.store });
  const dest = await destinationWorld();

  // Mesma sessão do exercício A, mas metadados diferentes: vira OUTRO exercício.
  const entries = built.document.exercises.entries.map(entry => structuredClone(entry));
  const copyOfA = structuredClone(entries.find(entry => entry.metadata.name === 'Exercício A'));
  copyOfA.id = 'origem-clone';
  copyOfA.metadata.targetBPM = 120;
  copyOfA.createdAt = '2026-01-01T00:00:00.000Z';
  copyOfA.updatedAt = '2026-01-01T00:00:00.000Z';
  entries.push(copyOfA);
  const payload = { ...built.document, exercises: { ...built.document.exercises, entries } };

  const result = await importBackup(payload, { library: dest.library, store: dest.store });
  assert.equal(result.ok, true);
  assert.equal(result.applied.exercises.added, 3);   // A + B + o clone divergente (o base casa e é reusado)
  assert.notEqual(result.map['origem-clone'], result.map[source.a.id]);
  // Os DOIS exercícios ficam preservados, cada um com o seu alvo.
  assert.equal(dest.library.get(result.map[source.a.id]).metadata.targetBPM, 90);
  assert.equal(dest.library.get(result.map['origem-clone']).metadata.targetBPM, 120);

  // Mesmo conteúdo com dono/carimbo diferentes casa e NÃO vira cópia nova.
  const againEntries = entries.map(entry => ({ ...structuredClone(entry), createdAt: '2027-02-02T00:00:00.000Z' }));
  const again = await importBackup({ ...payload, exercises: { ...payload.exercises, entries: againEntries } }, { library: dest.library, store: dest.store });
  assert.equal(again.applied.exercises.added, 0);
  assert.equal(dest.library.size(), 4);
});

test('backup: curso existente mantém a estrutura ATUAL, arquiva removidas e une estado', async () => {
  const backend = memoryBackend(COURSE_KEYS);
  const store = await openCourses(backend);
  await store.importText(JSON.stringify(courseDocument()));
  await store.setLessonState('curso-exemplo', 'aula-1', { watched: true, notes: 'texto atual', completionOverride: 'reopened' });
  await store.linkExercise('curso-exemplo', 'aula-1', 'ex-atual');
  await store.setPreferences('curso-exemplo', { active: false, dailyMinutes: 30 });
  await store.recordWatch('curso-exemplo', 'aula-1', { startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:05:00.000Z' });

  // Backup do MESMO id com estrutura DIFERENTE (sem aula-2, com aula-9) e estado
  // conflitante + progresso da aula removida.
  const incomingDoc = courseDocument({
    sections: [{ id: 'modulo-1', title: 'Módulo 1', type: 'módulo', lessons: [lesson('aula-1'), lesson('aula-9')] }],
  });
  const backupRecord = {
    id: 'curso-exemplo', importedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', source: 'backup',
    counts: {}, course: incomingDoc.course,
  };
  const backupState = {
    courseId: 'curso-exemplo', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    activeLessonId: 'aula-9',
    preferences: { active: true, dailyMinutes: 5 },
    lessons: {
      'aula-1': { watched: false, notes: 'texto do backup', linkedExerciseIds: ['ex-backup', 'ex-atual'] },
      'aula-9': { watched: true, notes: 'aula nova do backup' },
    },
    removed: [{ id: 'aula-antiga', title: 'Aula antiga', type: 'aula', sectionId: 'modulo-1', sectionTitle: 'Módulo 1', removedAt: '2026-01-01T00:00:00.000Z', state: { watched: true, linkedExerciseIds: [] } }],
    watch: [
      { id: 'w-dup', lessonId: 'aula-2', startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:05:00.000Z' },
      { id: 'w-novo', lessonId: 'aula-1', startedAt: '2026-09-01T10:00:00.000Z', endedAt: '2026-09-01T10:05:00.000Z' },
    ],
  };

  const result = await store.importSnapshot({ records: [backupRecord], states: [backupState] });
  assert.equal(result.ok, true);
  assert.equal(result.report.added, 0);
  assert.equal(result.report.merged, 1);

  const after = store.get('curso-exemplo');
  // Estrutura ATUAL vence: aula-2 continua uma aula VIVA e aula-9 não entra no mapa.
  assert.deepEqual(store.list().map(record => record.id), ['curso-exemplo']);
  assert.equal(store.summary('curso-exemplo').rows.some(row => row.lesson.id === 'aula-9'), false);
  assert.equal(store.summary('curso-exemplo').rows.some(row => row.lesson.id === 'aula-2'), true);
  // aula-9 (só no backup) fica acessível como removida, com o estado recebido.
  const tombstone9 = after.state.removed.find(entry => entry.id === 'aula-9');
  assert.ok(tombstone9);
  assert.equal(tombstone9.state.watched, true);
  assert.equal(tombstone9.state.notes, 'aula nova do backup');
  // Conflito: o valor ATUAL explícito vence; anotações diferentes viram bloco.
  assert.equal(after.state.lessons['aula-1'].watched, true);
  assert.equal(after.state.lessons['aula-1'].completionOverride, 'reopened');
  assert.equal(after.state.lessons['aula-1'].notes, `texto atual${IMPORTED_NOTES_SEPARATOR}texto do backup`);
  assert.deepEqual(after.state.lessons['aula-1'].linkedExerciseIds, ['ex-atual', 'ex-backup']);
  assert.deepEqual(after.state.preferences, { active: false, dailyMinutes: 30 });
  // Nada estava selecionado no curso atual, e a seleção do backup (aula-9) não
  // é aula viva da estrutura que venceu: não vira a aula ativa.
  assert.equal(after.state.activeLessonId, null);
  // Watch: união sem duplicata (o intervalo repetido em aula-2 não entra duas vezes).
  assert.equal(after.state.watch.length, 3);   // o do curso atual + w-dup + w-novo
  assert.equal(after.state.watch.some(interval => interval.id === 'w-dup'), true);
  assert.equal(after.state.watch.some(interval => interval.id === 'w-novo'), true);
  assert.equal(after.state.watch.filter(interval => interval.lessonId === 'aula-2').length, 1);
  assert.equal(after.state.watch.some(interval => interval.lessonId === 'aula-2' && interval.id === 'id-dup'), false);

  // Reimportar o mesmo retrato não muda mais nada.
  const again = await store.importSnapshot({ records: [backupRecord], states: [backupState] });
  assert.equal(again.ok, true);
  assert.equal(again.report.unchanged, 1);
  assert.equal(store.get('curso-exemplo').state.lessons['aula-1'].notes, `texto atual${IMPORTED_NOTES_SEPARATOR}texto do backup`);
});

test('backup: retrato recusado por inteiro quando colide com registro ilegível', async () => {
  const backend = memoryBackend(COURSE_KEYS);
  backend.seed('courses', { id: 'curso-exemplo', lixo: true });   // registro cru ilegível
  const store = await openCourses(backend);
  assert.equal(store.corrupt().length, 1);

  const good = JSON.parse(JSON.stringify(courseDocument()));
  const result = await store.importSnapshot({
    records: [{ id: 'curso-exemplo', course: good.course }],
    states: [{ courseId: 'curso-exemplo', lessons: { 'aula-1': { watched: true } } }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'corrupt');
  assert.deepEqual(result.applied, { courses: [], states: [] });
  // O registro ilegível continua intocado e nenhum estado novo foi gravado.
  assert.deepEqual(backend.raw('courses'), [{ id: 'curso-exemplo', lixo: true }]);
  assert.deepEqual(backend.raw('states'), []);
});

test('backup: estado inválido reprova o retrato inteiro sem gravar nada', async () => {
  const backend = memoryBackend(COURSE_KEYS);
  const store = await openCourses(backend);
  const doc = JSON.parse(JSON.stringify(courseDocument()));
  const bad = await store.importSnapshot({
    records: [{ id: 'curso-exemplo', course: doc.course }],
    states: [{ courseId: 'curso-exemplo', lessons: { 'aula-1': { watched: 'sim' } } }],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'invalid');
  assert.ok(bad.errors.some(error => error.path.endsWith('lessons.aula-1.watched')));
  assert.equal(backend.raw('courses').length, 0);
  assert.equal(backend.raw('states').length, 0);

  const unknown = await store.importSnapshot({
    records: [{ id: 'curso-exemplo', course: { ...doc.course, desconhecido: 1 } }],
    states: [],
  });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some(error => error.path.endsWith('course.desconhecido')));
  assert.equal(backend.raw('courses').length, 0);
});

test('backup: quota nos cursos preserva os exercícios já importados e o que existia', async () => {
  const source = await sourceWorld();
  const text = serializeBackup((await buildBackup({ library: source.library, store: source.store })).document);
  const backend = memoryBackend(COURSE_KEYS);
  const store = await openCourses(backend);
  await store.importText(JSON.stringify(courseDocument({ id: 'curso-exemplo', title: 'Curso Atual' })));
  const dest = await destinationWorld({ backend });

  const quota = new Error('sem espaço'); quota.name = 'QuotaExceededError';
  backend.failNext(quota);
  const result = await importBackup(text, { library: dest.library, store: dest.store });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.phase, 'courses');
  assert.equal(result.applied.exercises.added, 2);          // exercícios já entraram
  assert.equal(dest.library.size(), 3);
  // O curso que já existia continua com a estrutura ATUAL e o progresso dele.
  assert.equal(dest.store.get('curso-exemplo').record.course.title, 'Curso Atual');
  assert.equal(backend.raw('courses').length, 1);
  assert.match(describeImportResult(result), /PARCIAL/);
});

test('backup: quota nos exercícios não cria registro fantasma', async () => {
  const source = await sourceWorld();
  const text = serializeBackup((await buildBackup({ library: source.library, store: source.store })).document);
  const dest = await destinationWorld();
  const before = dest.library.size();
  const rawBefore = dest.storage.getItem(dest.library.key);
  dest.storage.failWrites();
  const result = await importBackup(text, { library: dest.library, store: dest.store });
  assert.equal(result.ok, false);
  assert.equal(result.partial, false);
  assert.equal(result.phase, 'exercises');
  assert.equal(dest.library.size(), before);
  assert.equal(dest.storage.getItem(dest.library.key), rawBefore);
  assert.equal(dest.store.list().length, 0);
  assert.match(describeImportResult(result), /rejeitada/);
});

test('backup: sessão inválida no backup é recusada sem alterar nada (nada de sessão fantasma)', async () => {
  const source = await sourceWorld();
  const document = (await buildBackup({ library: source.library, store: source.store })).document;
  // Campo desconhecido na nota: o parser canônico recusa a sessão.
  document.exercises.entries[1].session.notes[0].desconhecido = 1;
  const dest = await destinationWorld();
  const result = await importBackup(document, { library: dest.library, store: dest.store });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'exercises');
  assert.equal(result.applied, null);
  assert.equal(dest.library.size(), 1);          // só o exercício base do destino
  assert.equal(dest.store.list().length, 0);
});

test('backup: importação LEGADA continua pelo contrato antigo (só exercícios)', async () => {
  const source = await sourceWorld();
  const legacy = source.library.exportLibrary();
  const dest = await destinationWorld();
  const result = await importBackup(legacy, { library: dest.library, store: dest.store });
  assert.equal(result.ok, true);
  assert.equal(result.legacy, 'legacy-library');
  assert.equal(result.applied.exercises.added, 2);
  assert.equal(dest.store.list().length, 0);

  // O contrato ANTIGO de importExercise não mudou: dedup só por sessão.
  const single = source.library.exportExercise(source.a.id);
  const again = dest.library.importExercise(single);
  assert.deepEqual(again, { added: 0, skipped: 1 });
  const twice = dest.library.importExercise(source.library.exportExercise(source.b.id));
  assert.deepEqual(twice, { added: 0, skipped: 1 });
});

test('backup: envelope inválido é rejeitado com o caminho do campo', async () => {
  const dest = await destinationWorld();
  const broken = { kind: 'groovegoblin-library-backup', version: 99, exercises: { entries: [] }, courses: { records: [], states: [] } };
  const result = await importBackup(broken, { library: dest.library, store: dest.store });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'validate');
  assert.ok(result.errors.some(error => error.path === 'version'));

  const badRefs = { ...broken, version: 1, courses: { records: [], states: [{ courseId: 'curso-exemplo', lessons: { 'aula-1': { watched: 1 } } }] } };
  const second = await importBackup(badRefs, { library: dest.library, store: dest.store });
  assert.equal(second.ok, false);
  assert.ok(second.errors.some(error => error.path.includes('watched')));
  assert.equal(dest.library.size(), 1);
  // Curso de 6 cordas NUNCA entra por backup (e nada é gravado).
  const sixStrings = {
    kind: 'groovegoblin-library-backup', version: 1, exercises: { entries: [] },
    courses: { records: [{ id: 'curso-exemplo', course: { ...courseDocument().course, strings: 6 } }], states: [] },
  };
  const third = await importBackup(sixStrings, { library: dest.library, store: dest.store });
  assert.equal(third.ok, false);
  assert.equal(third.phase, 'validate');
  assert.ok(third.errors.some(error => error.path.endsWith('course.strings')));
  assert.equal(dest.store.list().length, 0);
  assert.equal(recognizeBackup({ kind: 'desconhecido' }).kind, 'invalid');
  assert.equal(recognizeBackup({ bars: 4 }).kind, 'legacy-session');
});

test('backup: mudança concorrente entre o prepare e a aplicação não é sobrescrita', { skip: createAttachmentStore === null ? 'módulo da etapa 6 ausente' : false }, async () => {
  const source = await sourceWorld({ withAttachments: true });
  const document = (await buildBackup({ library: source.library, store: source.store, attachments: source.attachments, includeAttachments: true })).document;
  const text = serializeBackup(document);
  const dest = await destinationWorld();

  // A "outra aba" mexe nos cursos e na biblioteca no meio do preflight dos
  // anexos: o commit precisa recombinar com o estado atual, não sobrescrever.
  const originalPrepare = dest.attachments.prepareImport.bind(dest.attachments);
  dest.attachments.prepareImport = async doc => {
    const prepared = await originalPrepare(doc);
    await dest.store.importText(JSON.stringify(courseDocument({ id: 'curso-exemplo', title: 'Editado agora' })));
    await dest.store.setLessonState('curso-exemplo', 'aula-1', { watched: true, notes: 'escrito durante a importação' });
    dest.library.new({ session: createSession({ name: 'Concorrente', bars: 2, bpm: 60, notes: [{ id: 'c1', start: 0, duration: 2, pitch: 52, string: 4 }] }) });
    return prepared;
  };
  const beforeSize = dest.library.size();
  const result = await importBackup(text, { library: dest.library, store: dest.store, attachments: dest.attachments });
  assert.equal(result.ok, true);
  const state = dest.store.get('curso-exemplo').state.lessons['aula-1'];
  assert.equal(state.notes.includes('escrito durante a importação'), true);
  assert.equal(state.watched, true);
  assert.equal(dest.library.size(), beforeSize + 3);   // o concorrente + os 2 do backup
  assert.equal(dest.library.list().some(row => row.name === 'Concorrente'), true);
  assert.equal(dest.store.get('curso-exemplo').record.course.title, 'Editado agora');
});

test('anexos: padrão sem anexos, opt-in com bytes iguais e um arquivo compartilhado', { ...attachmentTests }, async () => {
  const source = await sourceWorld({ withAttachments: true });
  assert.equal(source.attachments.totals().files, 1);         // um único arquivo para duas aulas
  assert.equal(source.attachments.totals().refs, 2);

  const lean = await buildBackup({ library: source.library, store: source.store, attachments: source.attachments });
  const leanText = serializeBackup(lean.document);
  assert.equal(lean.document.attachments.included, false);
  assert.equal(leanText.includes('dataBase64'), false);
  assert.equal(lean.summary.attachments.files, 1);            // tamanho explícito mesmo sem bytes

  const full = await buildBackup({ library: source.library, store: source.store, attachments: source.attachments, includeAttachments: true });
  const fullText = serializeBackup(full.document);
  assert.equal(full.document.attachments.included, true);
  assert.ok(fullText.includes('dataBase64'));

  const dest = await destinationWorld();
  const result = await importBackup(fullText, { library: dest.library, store: dest.store, attachments: dest.attachments });
  assert.equal(result.ok, true);
  assert.equal(result.attachments.addedFiles, 1);
  assert.equal(result.attachments.addedRefs, 2);
  assert.equal(dest.attachments.totals().files, 1);

  // Bytes IDÊNTICOS ao original.
  for (const ref of source.attachments.listByCourse('curso-exemplo')) {
    const original = await source.attachments.getBlob(ref.key);
    const restored = await dest.attachments.getBlob(ref.key);
    assert.ok(restored);
    assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), new Uint8Array(await original.arrayBuffer()));
  }
  // Reimportar não sobrescreve nem duplica.
  const again = await importBackup(fullText, { library: dest.library, store: dest.store, attachments: dest.attachments });
  assert.equal(again.ok, true);
  assert.equal(again.attachments.addedRefs, 0);
  assert.equal(dest.attachments.totals().refs, 2);
});

test('anexos: entrada malformada atrasada não adiciona exercícios nem cursos', { ...attachmentTests }, async () => {
  const source = await sourceWorld({ withAttachments: true });
  const document = (await buildBackup({ library: source.library, store: source.store, attachments: source.attachments, includeAttachments: true })).document;
  document.attachments.document.files[0].dataBase64 = '%%%isto não é base64%%%';
  const dest = await destinationWorld();
  const before = dest.library.size();
  const result = await importBackup(document, { library: dest.library, store: dest.store, attachments: dest.attachments });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'attachments');
  assert.equal(result.partial, false);
  assert.equal(result.applied, null);
  assert.equal(dest.library.size(), before);
  assert.equal(dest.store.list().length, 0);
  assert.equal(dest.store.snapshotAll().states.length, 0);
  assert.equal(dest.attachments.totals().files, 0);
  assert.ok(result.errors.length > 0);

  // Sem a loja de anexos, um backup COM anexos é recusado inteiro (nada de
  // gravar exercícios/cursos antes de saber dos anexos).
  const noStore = await destinationWorld();
  const refused = await importBackup(document, { library: noStore.library, store: noStore.store, attachments: null });
  assert.equal(refused.ok, false);
  assert.equal(refused.phase, 'attachments');
  assert.equal(noStore.library.size(), 1);
  assert.equal(noStore.store.list().length, 0);
});

test('anexos: falha de quota preserva cursos, exercícios e anexos já existentes', { ...attachmentTests }, async () => {
  const source = await sourceWorld({ withAttachments: true });
  const text = serializeBackup((await buildBackup({ library: source.library, store: source.store, attachments: source.attachments, includeAttachments: true })).document);
  const dest = await destinationWorld();
  await dest.attachments.put({
    courseId: 'curso-existente', lessonId: 'aula-1', resourceId: 'material-1', name: 'existente.pdf', extension: 'pdf',
    source: 'upload', blob: new Blob([new TextEncoder().encode('%PDF-1.4 existente')], { type: 'application/pdf' }),
  });
  const quota = new Error('sem espaço'); quota.name = 'QuotaExceededError';
  dest.attachmentBackend.failNext(quota);
  const result = await importBackup(text, { library: dest.library, store: dest.store, attachments: dest.attachments });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.phase, 'attachments');
  assert.equal(result.applied.exercises.added, 2);
  assert.equal(result.applied.courses.added, 1);
  assert.equal(dest.attachments.listByCourse('curso-existente').length, 1);
  assert.equal(dest.attachments.totals().files, 1);
  assert.match(describeImportResult(result), /PARCIAL/);
});

test('backup: ids especiais (__proto__, constructor, toString) não somem nem viram protótipo', async () => {
  const backend = memoryBackend(COURSE_KEYS);
  const store = await openCourses(backend);
  const doc = courseDocument({
    sections: [{ id: 'modulo-1', title: 'Módulo 1', type: 'módulo', lessons: [lesson('__proto__'), lesson('constructor'), lesson('toString')] }],
  });
  assert.equal((await store.importText(JSON.stringify(doc))).ok, true);
  await store.setLessonState('curso-exemplo', '__proto__', { watched: true, notes: 'estado especial' });
  await store.setLessonState('curso-exemplo', 'constructor', { watched: true });
  await store.linkExercise('curso-exemplo', '__proto__', '__proto__');

  // Reabrir a loja do MESMO banco: o estado não pode ter sumido no JSON.
  const reopened = await openCourses(backend);
  assert.equal(reopened.lessonState('curso-exemplo', '__proto__').notes, 'estado especial');
  assert.deepEqual(reopened.lessonState('curso-exemplo', '__proto__').linkedExerciseIds, ['__proto__']);
  assert.equal(reopened.lessonState('curso-exemplo', 'constructor').watched, true);
  // O que foi PARAR no banco tem a chave como propriedade própria de verdade.
  const persisted = JSON.parse(JSON.stringify(backend.raw('states')[0]));
  assert.equal(Object.hasOwn(persisted.lessons, '__proto__'), true);
  assert.equal(persisted.lessons.__proto__.notes, 'estado especial');
  assert.equal(Object.hasOwn(persisted.lessons, 'constructor'), true);
  assert.equal(persisted.lessons['toString'].watched, undefined);

  const library = openLibrary(memoryStorage());
  const built = await buildBackup({ library, store: reopened });
  const entries = built.document.exercises.entries;
  entries[entries.length - 1].id = '__proto__';   // exercício com id especial no backup
  const dest = await destinationWorld();
  const result = await importBackup(serializeBackup(built.document), { library: dest.library, store: dest.store });
  assert.equal(result.ok, true);
  assert.equal(typeof result.map['__proto__'], 'string');
  assert.equal(result.map.constructor, undefined);
  const state = dest.store.get('curso-exemplo').state;
  assert.deepEqual(state.lessons['__proto__'].linkedExerciseIds, [result.map['__proto__']]);
  assert.equal(state.lessons['constructor'].watched, true);
  assert.equal(Object.hasOwn(state.lessons, 'toString'), false);   // sem estado: não herda nada
  // E o estado sobrevive a uma releitura do banco destino.
  const after = await openCourses(dest.backend);
  assert.equal(after.lessonState('curso-exemplo', '__proto__').notes, 'estado especial');
  assert.deepEqual(after.lessonState('curso-exemplo', '__proto__').linkedExerciseIds, [result.map['__proto__']]);
});

test('backup: resumo, nomes e rótulos são estáveis', async () => {
  assert.equal(formatByteSize(0), '0 B');
  assert.equal(formatByteSize(2048), '2 KB');
  assert.equal(formatByteSize(3 * 1024 * 1024), '3 MB');
  assert.equal(backupAttachmentSummary({ files: 1, refs: 2, bytes: 512 }).label, '1 arquivo (512 B)');
  // Totais desconhecidos (loja não informada) NÃO viram "0 arquivo".
  assert.deepEqual(backupAttachmentSummary(null), { available: false, files: 0, refs: 0, bytes: 0, label: 'anexos não conferidos' });
  const source = await sourceWorld();
  const built = await buildBackup({ library: source.library, store: source.store });
  const summary = summarizeBackup(built.document);
  assert.equal(summary.courses, 1);
  assert.equal(summary.states, 2);
  assert.equal(summary.orphans, 1);
  assert.equal(summary.coursesAvailable, true);
  assert.equal(built.document.courses.available, true);
  assert.match(backupFileName(() => '2026-10-06T12:00:00.000Z'), /^groovegoblin-backup-2026-10-06T12-00-00-000Z\.json$/);
  assert.equal(describeImportResult(null), 'Importação não executada.');
  const dest = await destinationWorld();
  const ok = await importBackup(serializeBackup(built.document), { library: dest.library, store: dest.store });
  assert.match(describeImportResult(ok), /Importação concluída/);
});

test('backup: exportação agregada RECUSA quando a biblioteca ou uma loja não estão lidas', async () => {
  const world = await sourceWorld();

  // Biblioteca corrompida/indisponível: os bytes preservados se baixam em Ajuda.
  const corrupt = await buildBackup({ library: { exportLibrary: world.library.exportLibrary, status: 'corrupt' }, store: world.store });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.code, 'corrupt');
  assert.equal(corrupt.store, 'library');
  assert.equal(corrupt.document, null);
  assert.match(corrupt.error, /Ajuda/);

  const unavailableLibrary = await buildBackup({ library: { exportLibrary: world.library.exportLibrary, status: 'unavailable' }, store: world.store });
  assert.equal(unavailableLibrary.ok, false);
  assert.equal(unavailableLibrary.code, 'unavailable');
  assert.equal(unavailableLibrary.store, 'library');

  // Loja de cursos entregue e NÃO persistente: os cursos continuam no disco,
  // então nada de arquivo com "0 curso".
  const noIdb = createCourseStore({ persistent: false, error: new CourseStorageError('unavailable', 'sem IndexedDB para cursos') });
  assert.equal(noIdb.snapshotAll().records.length, 0);
  const refusedStore = await buildBackup({ library: world.library, store: noIdb, attachments: world.attachments });
  assert.equal(refusedStore.ok, false);
  assert.equal(refusedStore.code, 'unavailable');
  assert.equal(refusedStore.store, 'courses');
  assert.match(refusedStore.error, /sem IndexedDB para cursos/);

  // Mesma regra para a loja de anexos.
  if (createAttachmentStore) {
    const { AttachmentStorageError } = await import('../src/course-attachments.js');
    const noAttachmentIdb = createAttachmentStore({ persistent: false, error: new AttachmentStorageError('unavailable', 'sem IndexedDB para anexos') });
    const refusedAttachments = await buildBackup({ library: world.library, store: world.store, attachments: noAttachmentIdb });
    assert.equal(refusedAttachments.ok, false);
    assert.equal(refusedAttachments.store, 'attachments');
    assert.match(refusedAttachments.error, /sem IndexedDB para anexos/);
  }

  // Sem loja informada (API opcional) o envelope é EXPLÍCITO: não conferido.
  const explicit = await buildBackup({ library: world.library });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.document.courses.available, false);
  assert.equal(explicit.summary.coursesAvailable, false);
  assert.equal(explicit.summary.attachments.available, false);
  assert.equal(explicit.summary.attachments.label, 'anexos não conferidos');
});

test('backup: reimportar o MESMO arquivo depois de treinar não rebaixa a conclusão nem troca o vínculo', async () => {
  const world = await trainedWorld();
  const before = world.store.summary('curso-exemplo', { resolveExercise: id => world.library.get(id) });
  assert.equal(before.rows[0].status, 'done');
  const linkBefore = world.store.get('curso-exemplo').state.lessons['aula-1'].linkedExerciseIds;
  assert.deepEqual(linkBefore, [world.entry.id]);
  const text = serializeBackup((await buildBackup({ library: world.library, store: world.store })).document);

  // O exercício vinculado é treinado de novo (o conteúdo dele muda) e o arquivo
  // ANTIGO é reimportado: a cópia do backup entra na biblioteca, mas o vínculo
  // atual (o exercício vivo) e a conclusão ficam como estão.
  const context = world.library.captureRunContext(world.library.get(world.entry.id).session, { source: 'authored' });
  world.library.recordRun(context, { bpm: 95, summary: { mode: 'strict', expected: 10, attackOk: 10, endOk: 10, pitchOk: 10, pitchChecked: 10, free: 0 } });
  const result = await importBackup(text, { library: world.library, store: world.store });
  assert.equal(result.ok, true);
  assert.equal(result.applied.exercises.added, 1);            // a cópia do exercício do arquivo
  assert.deepEqual(world.store.get('curso-exemplo').state.lessons['aula-1'].linkedExerciseIds, linkBefore);
  const after = world.store.summary('curso-exemplo', { resolveExercise: id => world.library.get(id) });
  assert.equal(after.rows[0].status, 'done');

  // A MESMA regra no tombstone: aula que saiu do mapa mantém o vínculo atual.
  const world2 = await trainedWorld();
  await world2.store.importText(JSON.stringify(courseDocument({ sections: [{ id: 'modulo-1', title: 'Módulo 1', type: 'módulo', lessons: [lesson('aula-2')] }] })));
  const tombstoneBefore = world2.store.get('curso-exemplo').state.removed.find(entry => entry.id === 'aula-1');
  assert.deepEqual(tombstoneBefore.state.linkedExerciseIds, [world2.entry.id]);
  const text2 = serializeBackup((await buildBackup({ library: world2.library, store: world2.store })).document);
  const context2 = world2.library.captureRunContext(world2.library.get(world2.entry.id).session, { source: 'authored' });
  world2.library.recordRun(context2, { bpm: 95, summary: { mode: 'strict', expected: 10, attackOk: 10, endOk: 10, pitchOk: 10, pitchChecked: 10, free: 0 } });
  const result2 = await importBackup(text2, { library: world2.library, store: world2.store });
  assert.equal(result2.ok, true);
  const tombstoneAfter = world2.store.get('curso-exemplo').state.removed.find(entry => entry.id === 'aula-1');
  assert.deepEqual(tombstoneAfter.state.linkedExerciseIds, [world2.entry.id]);
});

test('backup: aviso parcial conta os cursos que JÁ entraram antes da falha', async () => {
  const backend = memoryBackend(COURSE_KEYS);
  const store = await openCourses(backend);
  await store.importText(JSON.stringify(courseDocument({ id: 'curso-a', title: 'Curso A' })));
  await store.importText(JSON.stringify(courseDocument({ id: 'curso-b', title: 'Curso B' })));
  const text = serializeBackup((await buildBackup({ library: openLibrary(memoryStorage()), store })).document);

  const destBackend = memoryBackend(COURSE_KEYS);
  const dest = await destinationWorld({ backend: destBackend });
  const quota = new Error('sem espaço'); quota.name = 'QuotaExceededError';
  destBackend.failAfterWrites(1, quota);                       // o 2º curso falha
  const result = await importBackup(text, { library: dest.library, store: dest.store });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.phase, 'courses');
  assert.equal(result.report.added, 1);
  assert.equal(result.applied.courses.added, 1);
  assert.match(describeImportResult(result), /1 curso\(s\) novo\(s\)/);
  assert.deepEqual(destBackend.raw('courses').map(record => record.id), ['curso-a']);
});

test('backup: backup sem cursos não vira PARCIAL e dados reais sem loja não viram sucesso', async () => {
  const world = await sourceWorld();
  const parsed = JSON.parse(serializeBackup((await buildBackup({ library: world.library, store: world.store })).document));
  const noIdb = createCourseStore({ persistent: false, error: new CourseStorageError('unavailable', 'sem IndexedDB') });

  // Envelope sem NENHUM curso/estado: a fase de cursos é pulada e o resultado é
  // limpo (nada de "parcial" por a loja existir e não ser gravável).
  const emptyCourses = { ...parsed, courses: { available: false, records: [], states: [], orphans: [], corrupt: [] } };
  const dest = await destinationWorld();
  const clean = await importBackup(emptyCourses, { library: dest.library, store: noIdb });
  assert.equal(clean.ok, true);
  assert.equal(clean.partial, false);
  assert.equal(clean.applied.exercises.added, 2);
  assert.deepEqual(clean.applied.courses, { added: 0, merged: 0, unchanged: 0, orphans: 0, tombstones: 0, resurrected: 0, watched: 0, notes: 0, links: 0, watch: 0 });

  // Cursos de verdade SEM loja: os exercícios entram, os cursos não — parcial
  // honesto, com o que entrou contado.
  const noStore = await destinationWorld();
  const refused = await importBackup(parsed, { library: noStore.library, store: null });
  assert.equal(refused.ok, false);
  assert.equal(refused.phase, 'courses');
  assert.equal(refused.partial, true);
  assert.equal(refused.applied.exercises.added, 2);
  assert.equal(refused.errors[0].code, 'indisponivel');
  assert.match(describeImportResult(refused), /2 exercício\(s\), 0 curso\(s\) novo\(s\)/);

  // Loja NÃO persistente com cursos de verdade: mesma recusa parcial precisa.
  const nonPersistent = await destinationWorld();
  const refusedNoIdb = await importBackup(parsed, { library: nonPersistent.library, store: noIdb });
  assert.equal(refusedNoIdb.ok, false);
  assert.equal(refusedNoIdb.phase, 'courses');
  assert.equal(refusedNoIdb.errors[0].code, 'indisponivel');
});

test('backup: recuperação crua do arquivo é avisada e NUNCA gravada', async () => {
  const source = await sourceWorld();
  const document_ = (await buildBackup({ library: source.library, store: source.store })).document;
  document_.courses.corrupt = [{ store: 'courses', id: 'curso-sumido', raw: { id: 'curso-sumido', lixo: true } }];
  const dest = await destinationWorld();
  const result = await importBackup(document_, { library: dest.library, store: dest.store });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /não foram gravados/);
  assert.equal(dest.store.corrupt().length, 0);
  assert.equal(dest.store.list().length, 1);
  assert.match(describeImportResult(result), /1 aviso\(s\) registrados/);
});
