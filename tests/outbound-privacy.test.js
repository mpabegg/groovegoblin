// Saídas que PODEM carregar conteúdo privado de curso: fila crua do Hoje,
// histórico do exercício e mapa do curso.
//
// Teste de CONSUMIDOR das telas REAIS (Hoje, Cursos, histórico) com DOM duplo e
// produtores REAIS: o curso fictício passa por `assistCoursePlan`, a fila passa
// pela loja da fila (migração v1 → v2), o exercício nasce de
// `buildSuggestedExercise` e os treinos são registrados pela própria biblioteca.
// Cada fonte é um caminho distinto; nada é eco de mock e os bytes crus saem
// IDÊNTICOS ao que está guardado.
//
// Tudo fictício: "Curso de Exemplo", "Aula aula-1", example.invalid. O canário
// AULA-CANARIO-SEGREDO é só um texto de teste.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeRoot, El, document as fakeDocument } from './course-lesson-dom.js';
import { memoryStorage } from './storage-fixture.js';
import { courseDocument, courseText, lesson, memoryBackend, section } from './course-fixtures.js';
import { createSession, parseSession, serializeSession } from '../src/session.js';
import { createExerciseLibrary, LIBRARY_KEY } from '../src/exercise-library.js';
import { createCourseStore } from '../src/course-store.js';
import { assistCoursePlan } from '../src/today-courses.js';
import { createTodayStore, LEGACY_TODAY_BACKUP_KEY, LEGACY_TODAY_KEY, TODAY_KEY, resetSharedTodayStore } from '../src/today-store.js';
import { mountToday } from '../src/today-view.js';
import { mountLibrary } from '../src/library-view.js';
import { mountCourses } from '../src/course-view.js';
import { mountExerciseHistory } from '../src/exercise-history.js';
import { buildSuggestedExercise } from '../src/course-lesson.js';
import { COURSE_EXPORT_NOTICE, PUBLIC_EXERCISE_NAME } from '../src/course-privacy.js';
import { PRIVATE_CONFIRM_ACCEPT, PRIVATE_CONFIRM_CANCEL } from '../src/private-download.js';
import { PRIVATE_FILENAME_MARK } from '../src/library-backup.js';
import { mountSyncStatus } from '../src/sync-status.js';
import { createServerClient } from '../src/server-client.js';
import { createSyncOutbox } from '../src/sync-outbox.js';
import { createSyncState } from '../src/sync-store.js';
import { createSyncEngine } from '../src/sync-engine.js';
import { createExerciseAdapter } from '../src/sync-adapters.js';
import { createMemoryStorage, createFakeTimers, startContractServer } from './sync-harness.js';

const CANARY = 'AULA-CANARIO-SEGREDO';

function clock(start = Date.UTC(2026, 9, 6, 9, 0, 0)) {
  let ticks = 0;
  return () => new Date(start + (ticks++) * 1000).toISOString();
}

let idCount = 0;
function nextUuid() { return `op-${++idCount}`; }

// DOM duplo das telas da aula + os globais que as telas reais usam (relógio de
// parede, observador de aba, armazenamento de sessão).
function installScreen() {
  const release = installDom();
  // A loja de Hoje é ÚNICA por app (a sincronização compartilha a mesma
  // instância): cada caso precisa da sua, senão o status/bytes do caso
  // anterior vazam para o seguinte.
  resetSharedTodayStore();
  const previous = { window: globalThis.window, localStorage: globalThis.localStorage, MutationObserver: globalThis.MutationObserver };
  globalThis.window = globalThis;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  fakeDocument.getElementById ??= id => fakeDocument.documentElement.descendants().find(node => node.id === id) ?? null;
  fakeDocument.createElementNS ??= (namespace, tag) => new El(tag);
  return () => {
    release();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
}

function buttons(root) { return root.querySelectorAll('button'); }
function withDataset(root, key, value) { return buttons(root).find(node => node.dataset[key] === value) ?? null; }
function withText(root, text) { return buttons(root).find(node => node.textContent === text) ?? null; }

// O diálogo de confirmação é o que traz as duas respostas explícitas; buscar
// pelos rótulos evita confundir com diálogos vizinhos do mesmo documento.
function confirmationIn(root) {
  return root.querySelectorAll('dialog').find(node => withText(node, PRIVATE_CONFIRM_ACCEPT) !== null) ?? null;
}

async function settle() { await new Promise(resolve => setTimeout(resolve, 0)); }

// Produtor REAL da fila: curso fictício → plano de "assistir" → item de aula
// (o nome do item é o título da aula) → loja da fila grava o diário.
function queueWithLessonTitle() {
  const course = { ...courseDocument().course, sections: [section('modulo-1', [lesson('aula-1', { title: CANARY })])] };
  const plan = assistCoursePlan({ courses: [{ course, state: { preferences: { active: true } } }], minutes: 60 });
  const item = plan.items.find(candidate => candidate.kind === 'lesson') ?? null;
  assert.ok(item, 'o plano de "assistir" produz uma aula');
  const storage = memoryStorage();
  const store = createTodayStore({ storage, now: clock(), uuid: nextUuid });
  store.addLessonItem({ courseId: item.courseId, lessonId: item.lessonId, name: item.name, durationMin: item.durationMin });
  return { item, raw: storage.getItem(TODAY_KEY) };
}

function openLibrary() {
  return createExerciseLibrary({
    storage: memoryStorage(), parse: parseSession, serialize: serializeSession,
    currentSession: createSession({ name: 'Sessão base', bars: 4, bpm: 80 }),
    now: clock(), uuid: nextUuid,
  });
}

test('fila antiga (v1) e cópia da migração só saem PRIVADAS, confirmadas e byte a byte', async () => {
  const release = installScreen();
  try {
    const { item, raw: journalRaw } = queueWithLessonTitle();
    assert.equal(item.name, CANARY);
    assert.ok(journalRaw.includes(CANARY), 'a fila guardada carrega o título da aula');
    const backupRaw = JSON.stringify({
      ...JSON.parse(journalRaw),
      queue: { items: [{ courseId: 'curso-exemplo', lessonId: 'aula-1', name: `${CANARY}-ANTIGO`, durationMin: 5 }] },
    });
    assert.notEqual(backupRaw, journalRaw);

    const storage = memoryStorage();
    storage.setItem(LEGACY_TODAY_KEY, journalRaw);
    storage.setItem(LEGACY_TODAY_BACKUP_KEY, backupRaw);
    globalThis.localStorage = storage;

    const panel = makeRoot();
    const downloads = [];
    const today = mountToday(panel, makeRoot(), {
      library: openLibrary(), notify: () => {},
      download: (text, filename) => downloads.push({ text, filename }),
      courseStore: { list: () => [], get: () => null, recordWatch: () => null },
      openExercise: () => true, activateTab: () => {}, openLesson: () => true,
      stopExecution: () => {}, isBusy: () => false,
    });
    try {
      assert.equal(today.store.migrated.journal, true);
      assert.equal(today.store.legacyRaw, journalRaw);
      assert.equal(today.store.legacyBackupRaw, backupRaw);

      const legacy = withDataset(panel, 'raw', 'legacy');
      const backup = withDataset(panel, 'raw', 'legacy-backup');
      assert.ok(legacy, 'a fila antiga fica baixável');
      assert.ok(backup, 'a cópia da migração fica baixável');
      const dialog = confirmationIn(panel);
      assert.ok(dialog, 'a recuperação crua exige confirmação nativa');

      // 1) cancelar: nenhum arquivo, nenhuma mutação dos bytes.
      legacy.click();
      assert.deepEqual(downloads, [], 'nada é baixado antes da decisão');
      withText(dialog, PRIVATE_CONFIRM_CANCEL).click();
      await settle();
      assert.deepEqual(downloads, [], 'cancelar não gera arquivo');
      assert.equal(today.store.legacyRaw, journalRaw, 'os bytes originais continuam intactos');

      // 2) confirmar: MESMOS bytes, nome marcado.
      legacy.click();
      withText(dialog, PRIVATE_CONFIRM_ACCEPT).click();
      await settle();
      assert.equal(downloads.length, 1);
      assert.equal(downloads[0].filename, `groovegoblin-fila-v1-${PRIVATE_FILENAME_MARK}.json`);
      assert.equal(downloads[0].text, journalRaw);

      // 3) a cópia da migração é OUTRA fonte: mesmo tratamento, outros bytes.
      backup.click();
      assert.equal(downloads.length, 1, 'a segunda fonte também espera a decisão');
      withText(dialog, PRIVATE_CONFIRM_ACCEPT).click();
      await settle();
      assert.equal(downloads.length, 2);
      assert.equal(downloads[1].filename, `groovegoblin-fila-v1-backup-${PRIVATE_FILENAME_MARK}.json`);
      assert.equal(downloads[1].text, backupRaw);
    } finally { today.destroy(); }
  } finally { release(); }
});

test('fila corrompida: os bytes crus saem PRIVADOS e só depois da confirmação', async () => {
  const release = installScreen();
  try {
    const { raw: journalRaw } = queueWithLessonTitle();
    const corruptRaw = `${journalRaw}${journalRaw}`;
    const storage = memoryStorage();
    storage.setItem(TODAY_KEY, corruptRaw);
    globalThis.localStorage = storage;

    const panel = makeRoot();
    const downloads = [];
    const today = mountToday(panel, makeRoot(), {
      library: openLibrary(), notify: () => {},
      download: (text, filename) => downloads.push({ text, filename }),
      courseStore: { list: () => [], get: () => null, recordWatch: () => null },
      openExercise: () => true, activateTab: () => {}, openLesson: () => true,
      stopExecution: () => {}, isBusy: () => false,
    });
    try {
      assert.equal(today.store.status, 'corrupt');
      assert.equal(today.store.recoveryRaw, corruptRaw);
      assert.ok(corruptRaw.includes(CANARY));

      const button = withDataset(panel, 'raw', 'corrupt');
      assert.ok(button);
      const dialog = confirmationIn(panel);
      assert.ok(dialog);

      button.click();
      assert.deepEqual(downloads, []);
      withText(dialog, PRIVATE_CONFIRM_CANCEL).click();
      await settle();
      assert.deepEqual(downloads, [], 'cancelar não gera arquivo');
      assert.equal(today.store.recoveryRaw, corruptRaw, 'os bytes corrompidos continuam preservados');

      button.click();
      withText(dialog, PRIVATE_CONFIRM_ACCEPT).click();
      await settle();
      assert.equal(downloads.length, 1);
      assert.equal(downloads[0].filename, `groovegoblin-fila-corrompida-${PRIVATE_FILENAME_MARK}.json`);
      assert.equal(downloads[0].text, corruptRaw);
    } finally { today.destroy(); }
  } finally { release(); }
});

test('biblioteca corrompida: os bytes crus saem PRIVADOS e só depois da confirmação', async () => {
  const release = installScreen();
  try {
    // Bytes REAIS de uma biblioteca com exercício de aula, depois corrompidos:
    // é exatamente o arquivo que o usuário precisa guardar para recuperar.
    const built = buildSuggestedExercise({ suggestion: { title: CANARY, initialBpm: 90, targetBpm: 140 } });
    const original = memoryStorage();
    const producer = createExerciseLibrary({
      storage: original, parse: parseSession, serialize: serializeSession,
      currentSession: built.session, now: clock(), uuid: nextUuid,
    });
    producer.new({ session: built.session, metadata: built.metadata });
    const corruptRaw = `${original.getItem(LIBRARY_KEY)}{`;
    assert.ok(corruptRaw.includes(CANARY), 'os bytes guardados carregam o título da aula');

    const storage = memoryStorage();
    storage.setItem(LIBRARY_KEY, corruptRaw);
    globalThis.localStorage = storage;
    const library = createExerciseLibrary({
      storage, parse: parseSession, serialize: serializeSession,
      currentSession: createSession({ name: 'Sessão base', bars: 4, bpm: 80 }), now: clock(), uuid: nextUuid,
    });
    assert.equal(library.status, 'corrupt');
    assert.equal(library.recoveryRaw, corruptRaw);

    const container = makeRoot();
    const downloads = [];
    const view = mountLibrary(container, {
      library, notify: () => {},
      download: (text, filename) => downloads.push({ text, filename }),
      openExercise: () => true, newExercise: () => null, duplicateExercise: () => null,
      deleteExercise: () => null, undoDeleteExercise: () => null, updateExerciseMetadata: () => null,
    });
    try {
      const button = withDataset(container, 'raw', 'library');
      assert.ok(button, 'a barra de recuperação fica baixável');
      const dialog = confirmationIn(fakeDocument.body);
      assert.ok(dialog, 'os bytes crus da biblioteca exigem confirmação nativa');

      button.click();
      assert.deepEqual(downloads, [], 'nada é baixado antes da decisão');
      withText(dialog, PRIVATE_CONFIRM_CANCEL).click();
      await settle();
      assert.deepEqual(downloads, [], 'cancelar não gera arquivo');
      assert.equal(library.recoveryRaw, corruptRaw, 'os bytes corrompidos continuam preservados');

      button.click();
      withText(dialog, PRIVATE_CONFIRM_ACCEPT).click();
      await settle();
      assert.equal(downloads.length, 1);
      assert.equal(downloads[0].filename, `groovegoblin-biblioteca-corrompida-${PRIVATE_FILENAME_MARK}.json`);
      assert.equal(downloads[0].text, corruptRaw, 'os bytes originais saem intactos');
    } finally { view.destroy(); }
  } finally { release(); }
});

test('exportar curso é arquivo PRIVADO explícito: confirmação nativa e documento completo', async () => {
  const release = installScreen();
  try {
    const store = createCourseStore({ backend: memoryBackend(), now: clock(), uuid: nextUuid });
    await store.ready();
    const document_ = courseDocument();
    const imported = await store.importText(courseText(document_));
    assert.equal(imported.ok, true);

    const container = makeRoot();
    const downloads = [];
    const view = mountCourses(container, {
      store, library: null, notify: () => {},
      download: (text, filename) => downloads.push({ text, filename }),
    });
    await settle();
    try {
      const exportButton = withDataset(container, 'action', 'export');
      assert.ok(exportButton, 'o card do curso tem a ação de exportar');
      exportButton.click();
      assert.deepEqual(downloads, [], 'nenhum arquivo antes da confirmação explícita');
      const dialog = confirmationIn(fakeDocument.body);
      assert.ok(dialog, 'exportar curso exige confirmação nativa (o arquivo é privado por natureza)');

      withText(dialog, PRIVATE_CONFIRM_CANCEL).click();
      await settle();
      assert.deepEqual(downloads, []);

      exportButton.click();
      withText(dialog, PRIVATE_CONFIRM_ACCEPT).click();
      await settle();
      assert.equal(downloads.length, 1);
      assert.equal(downloads[0].filename, `groovegoblin-curso-${PRIVATE_FILENAME_MARK}.json`);
      const exported = store.exportText(document_.course.id);
      assert.equal(exported.ok, true);
      assert.equal(downloads[0].text, exported.text, 'o documento do curso sai completo, apenas marcado');
      assert.ok(downloads[0].text.includes('Curso de Exemplo'));
    } finally { view.destroy(); }
  } finally { release(); }
});

test('histórico de exercício de curso: arquivo genérico, sem título de aula e com os treinos reais', async () => {
  const release = installScreen();
  try {
    const built = buildSuggestedExercise({ suggestion: { title: CANARY, initialBpm: 90, targetBpm: 140 } });
    assert.equal(built.metadata.courseContent, true);

    const library = openLibrary();
    const created = library.new({ session: built.session, metadata: built.metadata });
    const context = library.captureRunContext(built.session, { source: 'authored' });
    library.recordRun(context, { bpm: 96, mode: 'train', summary: { attackOk: 8, expected: 10 } });
    const records = library.records(created.id);
    assert.equal(records.length, 1);
    assert.ok(library.get(created.id).metadata.courseContent, 'o exercício da aula nasce marcado');

    const container = makeRoot();
    const downloads = [];
    const notices = [];
    const view = mountExerciseHistory(container, {
      library, exerciseId: created.id,
      notify: (text, error = false) => notices.push({ text, error }),
      download: (text, filename) => downloads.push({ text, filename }),
      clearRecords: () => null,
    });
    try {
      const exportButton = withDataset(container, 'action', 'export-history');
      assert.ok(exportButton);
      assert.equal(confirmationIn(container), null, 'o histórico redigido não pede confirmação');
      exportButton.click();
      assert.equal(downloads.length, 1);
      assert.equal(downloads[0].filename, 'estudo-musical-historico.json');
      const payload = JSON.parse(downloads[0].text);
      assert.equal(payload.exercise.name, PUBLIC_EXERCISE_NAME);
      assert.deepEqual(payload.records, records, 'datas, BPM, aproveitamento e duração dos treinos reais saem inteiros');
      assert.equal(downloads[0].text.includes(CANARY), false, 'nenhum título de aula no arquivo');
      assert.ok(notices.some(item => item.text === COURSE_EXPORT_NOTICE && item.error === false));
    } finally { view.destroy(); }
  } finally { release(); }
});

test('cópias cruas de conflito da sincronização só saem PRIVADAS, confirmadas e byte a byte', async () => {
  const release = installScreen();
  const server = await startContractServer();
  try {
    // Produtor REAL: biblioteca real + adaptador real + motor real + servidor de
    // contrato real. A divergência nasce de um PUT condicional recusado (412).
    const library = openLibrary();
    const created = library.new({
      session: createSession({ name: CANARY, bars: 4, bpm: 80, notes: [{ id: 'n1', start: 0, duration: 4, pitch: 36, string: 3 }] }),
      metadata: { name: CANARY, notes: CANARY },
    });
    library.updateMetadata(created.id, { courseContent: true });

    const storage = createMemoryStorage();
    const outbox = createSyncOutbox({ storage });
    const state = createSyncState({ storage });
    const client = createServerClient({ base: server.base, requestOrigin: server.origin });
    const engine = createSyncEngine({
      client, ports: [createExerciseAdapter(library)], outbox, state,
      shouldProbe: () => true, timers: createFakeTimers(),
      // Relógio fixo: a comparação byte a byte da cópia não pode depender do
      // instante do teste.
      now: () => '2026-01-01T00:00:00.000Z',
    });
    try {
      assert.equal((await engine.probe()).ok, true);
      await engine.sendAll();
      assert.ok(state.revision('exercises', created.id), 'o documento subiu');

      // OUTRO navegador, versão ANTIGA (sem a marca) muda o mesmo documento.
      const local = library.get(created.id);
      const remote = {
        id: created.id, createdAt: local.createdAt, updatedAt: '2026-02-02T00:00:00.000Z',
        session: { ...local.session, bpm: 95 },
        metadata: { name: CANARY, tags: [], targetBPM: null, notes: CANARY, records: [], courseContent: false },
      };
      const pushed = await client.putDoc('exercises', created.id, remote, { rev: state.revision('exercises', created.id) });
      assert.equal(pushed.ok, true, 'o outro navegador gravou a versão antiga');

      // Edição local depois: o PUT condicional é recusado e o conflito guarda os
      // DOIS lados do documento (a cópia crua pode carregar o curso inteiro).
      library.updateMetadata(created.id, { notes: `${CANARY}-LOCAL` });
      const synced = await engine.syncNow();
      assert.ok(synced.conflicts >= 1, 'o conflito é registrado');
      assert.equal(engine.conflicts().length, 1);
      // B6 na aplicação remota: o documento antigo NÃO rebaixa a marca local.
      assert.equal(library.get(created.id).metadata.courseContent, true, 'a marca sobrevive ao conflito');
      assert.equal(library.exportLibrary().includes(CANARY), false, 'o retrato público continua limpo');

      const payload = engine.exportRecovered();
      assert.ok(payload.includes(CANARY), 'a cópia crua carrega o material privado inteiro (recuperação não é redigida)');

      const help = makeRoot();
      const downloads = [];
      const status = mountSyncStatus({
        engine, helpContainer: help, document: fakeDocument, notify: () => {},
        download: (text, filename) => downloads.push({ text, filename }),
      });
      try {
        const button = withText(help, 'Baixar cópias guardadas');
        assert.ok(button && button.hidden === false, 'há cópia guardada para baixar');
        const dialog = confirmationIn(help);
        assert.ok(dialog, 'a cópia crua exige confirmação nativa');

        // 1) cancelar: nenhum arquivo e os bytes intactos.
        button.click();
        assert.deepEqual(downloads, [], 'nada é baixado antes da decisão');
        withText(dialog, PRIVATE_CONFIRM_CANCEL).click();
        await settle();
        assert.deepEqual(downloads, [], 'cancelar não gera arquivo');
        assert.equal(engine.exportRecovered(), payload, 'os bytes da cópia continuam idênticos');

        // 2) confirmar: MESMOS bytes, nome marcado.
        button.click();
        withText(dialog, PRIVATE_CONFIRM_ACCEPT).click();
        await settle();
        assert.equal(downloads.length, 1);
        assert.equal(downloads[0].filename, `groovegoblin-sincronizacao-copias-${PRIVATE_FILENAME_MARK}.json`);
        assert.equal(downloads[0].text, payload, 'os bytes crus saem idênticos ao que está guardado');
      } finally { status.destroy(); }
    } finally { engine.stop(); }
  } finally {
    server.close();
    release();
  }
});
