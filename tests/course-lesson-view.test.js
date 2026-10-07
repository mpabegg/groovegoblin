// Regressões de tela da aula (rodada 5, etapa 6) — consumidor.
//
// Cobrem os defeitos encontrados na revisão da etapa: rascunho de anotações que
// sumia quando a gravação falhava (ou quando o host chamava show na mesma aula),
// show antigo que reabria contagem/marcação depois de hide(), anotações não
// gravadas ao esconder a página, texto igual em outra aula limpo por gravação
// antiga, contagem de tempo obrigatória (agora opt-in) e aula removida expondo
// um Desvincular que a loja recusa. Também cobrem as etiquetas de origem
// compactas.
//
// Tudo fictício: “Curso de Exemplo”, “Aula 3”, example.invalid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCourseStore } from '../src/course-store.js';
import { attachmentRefKey, createAttachmentStore } from '../src/course-attachments.js';
import { mountCourseLesson } from '../src/course-lesson.js';
import { exerciseOriginBadges, mountExerciseOrigins } from '../src/course-lesson-origins.js';
import { createServerClient } from '../src/server-client.js';
import { createSyncEngine } from '../src/sync-engine.js';
import { createSyncOutbox } from '../src/sync-outbox.js';
import { createSyncState } from '../src/sync-store.js';
import { createAttachmentAdapter } from '../src/sync-adapters.js';
import { makeRoot, installDom, dispatchWindow, document as fakeDocument, makeEvent } from './course-lesson-dom.js';
import { courseDocument, lesson, memoryBackend, section } from './course-lesson-fixtures.js';
import { startContractServer, createMemoryStorage, createFakeTimers, sha256Hex } from './sync-harness.js';

const NOW = () => '2026-01-02T03:04:05.000Z';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// IndexedDB indisponível: a aula só usa a loja de anexos para METADADOS aqui.
function idleAttachments() {
  return {
    persistent: true,
    error: null,
    ready: () => Promise.resolve(),
    subscribe: () => () => {},
    list: () => [],
    listByCourse: () => [],
    get: () => null,
    has: () => false,
    totals: () => ({ files: 0, refs: 0, bytes: 0 }),
  };
}

async function setup({ backend = null, attachments = null, host = {}, document: courseDoc = null } = {}) {
  const release = installDom();
  const store = createCourseStore({ backend: backend ?? memoryBackend(), now: NOW, uuid: (() => { let n = 0; return () => `estado-${(n += 1)}`; })() });
  await store.ready();
  const imported = await store.importText(JSON.stringify(courseDoc ?? courseDocument()), { source: 'teste' });
  assert.equal(imported.ok, true, imported.error);
  const notifications = [];
  const container = makeRoot();
  fakeDocument.body = container;
  const lessonView = mountCourseLesson(container, {
    store,
    attachments: attachments ?? idleAttachments(),
    library: null,
    notify: (text, error = false) => notifications.push({ text, error: !!error }),
    openExercise: () => {},
    onOpenLesson: (courseId, lessonId) => { void lessonView.show(courseId, lessonId); },
    ...host,
  });
  return {
    store,
    courseId: imported.courseId,
    container,
    lesson: lessonView,
    notifications,
    cleanup() { lessonView.destroy(); release(); },
  };
}

const textarea = container => container.querySelector('#lesson-notes');
const type = (container, value) => {
  const node = textarea(container);
  node.value = value;
  node.dispatchEvent(makeEvent('input'));
  return node.value;
};

test('aula: falha na gravação preserva o texto e ele volta ao reabrir a aula', async t => {
  const backend = memoryBackend();
  const context = await setup({ backend });
  t.after(() => context.cleanup());
  const { store, courseId, container, lesson, notifications } = context;

  await lesson.show(courseId, 'aula-1');
  type(container, 'texto que precisa sobreviver');
  const failure = new Error('quota cheia'); failure.name = 'QuotaExceededError';
  backend.failNext(failure);
  await lesson.show(courseId, 'aula-3');
  await sleep(30);
  assert.equal(store.lessonState(courseId, 'aula-1').notes, '', 'a gravação falhou');
  assert.ok(notifications.some(item => item.error && /anotações/i.test(item.text)), 'avisou o erro');

  await lesson.show(courseId, 'aula-1');
  assert.equal(textarea(container).value, 'texto que precisa sobreviver', 'o rascunho voltou acessível');
  // Agora a gravação funciona: o texto é confirmado na loja.
  type(container, 'texto que precisa sobreviver');
  await sleep(900);
  assert.equal(store.lessonState(courseId, 'aula-1').notes, 'texto que precisa sobreviver');
});

test('aula: show na MESMA aula não descarta o rascunho pendente', async t => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { store, courseId, container, lesson } = context;
  await lesson.show(courseId, 'aula-1');
  type(container, 'digitado agora');
  await lesson.show(courseId, 'aula-1');
  assert.equal(textarea(container).value, 'digitado agora');
  await sleep(900);
  assert.equal(store.lessonState(courseId, 'aula-1').notes, 'digitado agora');
  assert.equal(textarea(container).value, 'digitado agora');
});

test('aula: esconder a página grava o rascunho pendente na hora', async t => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { store, courseId, container, lesson } = context;
  await lesson.show(courseId, 'aula-1');
  type(container, 'salvar ao esconder');
  fakeDocument.triggerVisibility(true);
  await sleep(60);
  assert.equal(store.lessonState(courseId, 'aula-1').notes, 'salvar ao esconder', 'a visibilidade não perde o texto');
  fakeDocument.triggerVisibility(false);
  await lesson.show(courseId, 'aula-2');
  type(container, 'salvar ao fechar');
  dispatchWindow('pagehide');
  await sleep(60);
  assert.equal(store.lessonState(courseId, 'aula-2').notes, 'salvar ao fechar', 'pagehide não perde o texto');
});

test('aula: gravação antiga não limpa o texto igual digitado em outra aula', async t => {
  const inner = memoryBackend();
  let hold = false;
  let releaseHold = null;
  const backend = {
    getAll: name => inner.getAll(name),
    get: (name, id) => inner.get(name, id),
    delete: (name, id) => inner.delete(name, id),
    writeBatch: entries => inner.writeBatch(entries),
    holdNextStatePut() { hold = true; },
    release() { releaseHold?.(); releaseHold = null; },
    async put(name, value) {
      if (hold && name === 'states') { hold = false; await new Promise(resolve => { releaseHold = resolve; }); }
      return inner.put(name, value);
    },
  };
  const context = await setup({ backend });
  t.after(() => context.cleanup());
  const { store, courseId, container, lesson } = context;

  await lesson.show(courseId, 'aula-1');
  type(container, 'mesmo texto');
  backend.holdNextStatePut();
  const switching = lesson.show(courseId, 'aula-3');
  await sleep(20);
  assert.equal(lesson.lessonId, 'aula-3', 'a visão já mudou de aula');
  type(container, 'mesmo texto');            // ainda na tela antiga, mas na aula nova
  backend.release();
  await switching;
  await sleep(900);
  assert.equal(store.lessonState(courseId, 'aula-3').notes, 'mesmo texto', 'a aula nova guardou o texto');
  assert.equal(textarea(container).value, 'mesmo texto', 'e ele continua na tela');
});

test('aula: contagem de tempo é opt-in (desligada por padrão) e fecha ao esconder', async t => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { store, courseId, container, lesson } = context;
  await lesson.show(courseId, 'aula-1');
  const toggle = container.querySelector('#lesson-time');
  assert.equal(toggle.checked, false, 'desligada por padrão');
  assert.match(container.querySelector('#lesson-status').textContent, /contagem de tempo desligada/);
  await sleep(1100);
  lesson.hide();
  await sleep(30);
  assert.deepEqual(store.watchIntervals(courseId), [], 'nada é contado sem opt-in');

  await lesson.show(courseId, 'aula-1');
  container.querySelector('#lesson-time').checked = true;
  container.querySelector('#lesson-time').dispatchEvent(makeEvent('change'));
  assert.equal(container.querySelector('#lesson-time').checked, true);
  await sleep(1100);
  fakeDocument.triggerVisibility(true);
  await sleep(60);
  const intervals = store.watchIntervals(courseId);
  assert.equal(intervals.length, 1, 'o intervalo opt-in foi fechado ao esconder');
  assert.equal(intervals[0].lessonId, 'aula-1');
  assert.ok(intervals[0].ms >= 1000);
});

test('aula: hide durante show pendente não marca aula ativa nem reabre contagem', async t => {
  let resolveReady = null;
  const attachments = {
    ...idleAttachments(),
    ready: () => new Promise(resolve => { resolveReady = resolve; }),
  };
  const context = await setup({ attachments });
  t.after(() => context.cleanup());
  const { store, courseId, lesson } = context;

  const pendingShow = lesson.show(courseId, 'aula-1');
  lesson.hide();
  resolveReady();
  await pendingShow;
  assert.equal(store.get(courseId).state.activeLessonId, null, 'nenhuma aula ativa depois de hide');
  await sleep(1100);
  lesson.destroy();
  await sleep(30);
  assert.deepEqual(store.watchIntervals(courseId), [], 'nenhum intervalo criado após hide');
});

test('aula: aula removida não oferece Desvincular (ação que a loja recusaria)', async t => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { store, courseId, container, lesson: lessonView } = context;

  await store.linkExercise(courseId, 'aula-2', 'exercicio-ficticio');
  await lessonView.show(courseId, 'aula-2');
  assert.equal(container.querySelectorAll('[data-action="unlink"]').length, 1, 'aula viva tem desvincular');

  const trimmed = courseDocument();
  trimmed.course.sections[0].lessons = [lesson('aula-1'), lesson('aula-3')];
  const reimported = await store.importText(JSON.stringify(trimmed), { source: 'teste' });
  assert.equal(reimported.ok, true, reimported.error);
  await lessonView.show(courseId, 'aula-2');
  assert.equal(container.querySelector('.lesson-head').dataset.mode, 'removed');
  assert.equal(container.querySelectorAll('[data-action="unlink"]').length, 0, 'aula removida não tem desvincular');
  assert.equal(container.querySelectorAll('[data-action="open-exercise"]').length, 1, 'abrir no Estúdio continua');
  assert.match(container.querySelector('.lesson-link-meta').textContent, /aula removida/);
});

test('origem: sem origem nada é montado; uma vira um botão; várias ficam em um details', async t => {
  const release = installDom();
  const store = createCourseStore({ backend: memoryBackend(), now: NOW, uuid: () => 'estado' });
  await store.ready();
  const imported = await store.importText(JSON.stringify(courseDocument()), { source: 'teste' });
  const courseId = imported.courseId;
  const opened = [];
  const container = makeRoot();
  const origins = mountExerciseOrigins(container, { store, exerciseId: null, onOpenLesson: (c, l) => opened.push({ c, l }) });
  t.after(() => { origins.destroy(); release(); });
  const controls = root => [...root.descendants()].filter(node => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(node.tagName) && !node.hidden).length;

  assert.equal(container.querySelectorAll('.course-origin').length, 0, 'sem origem, sem linha extra');
  assert.equal(container.querySelector('.course-origin-root').hidden, true);
  assert.equal(controls(container), 0);

  await store.linkExercise(courseId, 'aula-1', 'exercicio-ficticio');
  origins.setExercise('exercicio-ficticio');
  assert.equal(container.querySelectorAll('.course-origin').length, 1, 'uma origem = um botão');
  assert.equal(container.querySelector('.course-origin-more'), null);
  assert.equal(controls(container), 1);
  assert.match(container.querySelector('.course-origin').textContent, /Curso de Exemplo/);
  assert.match(container.querySelector('.course-origin').textContent, /Aula aula-1/);
  container.querySelector('.course-origin').click();
  assert.deepEqual(opened, [{ c: courseId, l: 'aula-1' }], 'o botão abre a aula');

  await store.linkExercise(courseId, 'aula-2', 'exercicio-ficticio');
  origins.render();
  const details = container.querySelector('.course-origin-more');
  assert.ok(details, 'duas origens ficam em um details');
  assert.match(details.querySelector('summary').textContent, /Origem \(2 aulas\)/);
  assert.equal(details.open, false);
  assert.equal(controls(container), 1, 'em repouso, dois ou mais continuam sendo UM controle');
  // As etiquetas (com rótulo completo) só são montadas quando o details abre.
  details.open = true;
  details.dispatchEvent(makeEvent('toggle'));
  assert.equal(details.querySelectorAll('.course-origin').length, 2);
  assert.equal(details.querySelectorAll('.course-origin-item').length, 2);
  assert.match(details.querySelector('.course-origin').textContent, /Curso de Exemplo · Módulo modulo-1 · Aula aula-1/);
  assert.equal(container.querySelectorAll('[role="listitem"]').length, 0, 'sem role listitem em botões');
  details.querySelector('.course-origin').click();
  assert.deepEqual(opened.slice(-1), [{ c: courseId, l: 'aula-1' }]);
});

test('origem: a factory direto (Biblioteca) também devolve UM controle no repouso', async t => {
  const release = installDom();
  const store = createCourseStore({ backend: memoryBackend(), now: NOW, uuid: () => 'estado' });
  await store.ready();
  await store.importText(JSON.stringify(courseDocument()), { source: 'teste' });
  await store.linkExercise('curso-exemplo', 'aula-1', 'exercicio-ficticio');
  await store.linkExercise('curso-exemplo', 'aula-2', 'exercicio-ficticio');
  t.after(() => release());

  const container = makeRoot();
  const opened = [];
  const nodes = exerciseOriginBadges(store.originsOf('exercicio-ficticio'), { onOpenLesson: (c, l) => opened.push({ c, l }) });
  assert.equal(nodes.length, 1, 'a factory devolve UM nó para duas origens');
  assert.equal(nodes[0].tagName, 'DETAILS');
  for (const node of nodes) container.append(node);
  const controls = [...container.descendants()].filter(node => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(node.tagName));
  assert.equal(controls.length, 1, 'um único controle no repouso, sem controller');

  const single = exerciseOriginBadges(store.originsOf('exercicio-ficticio').slice(0, 1), { onOpenLesson: (c, l) => opened.push({ c, l }) });
  assert.equal(single.length, 1);
  assert.equal(single[0].tagName, 'BUTTON');
  single[0].click();
  assert.deepEqual(opened, [{ c: 'curso-exemplo', l: 'aula-1' }]);

  assert.deepEqual(exerciseOriginBadges([], { onOpenLesson: () => {} }), [], 'sem origem não devolve nó');
});

test('origem: aula removida do curso continua abrindo a versão arquivada', async t => {
  const release = installDom();
  const store = createCourseStore({ backend: memoryBackend(), now: NOW, uuid: () => 'estado' });
  await store.ready();
  await store.importText(JSON.stringify(courseDocument()), { source: 'teste' });
  await store.linkExercise('curso-exemplo', 'aula-2', 'exercicio-ficticio');
  const trimmed = courseDocument();
  trimmed.course.sections[0].lessons = [lesson('aula-1'), lesson('aula-3')];
  const reimported = await store.importText(JSON.stringify(trimmed), { source: 'teste' });
  assert.equal(reimported.ok, true, reimported.error);

  const opened = [];
  const container = makeRoot();
  const origins = mountExerciseOrigins(container, { store, exerciseId: 'exercicio-ficticio', onOpenLesson: (c, l) => opened.push({ c, l }) });
  t.after(() => { origins.destroy(); release(); });

  const badge = container.querySelector('.course-origin');
  assert.ok(badge, 'a origem removida continua visível');
  assert.equal(badge.disabled, false);
  assert.match(badge.textContent, /aula removida do curso/);
  assert.match(badge.title, /aula removida do curso/);
  badge.click();
  assert.deepEqual(opened, [{ c: 'curso-exemplo', l: 'aula-2' }]);
});

test('origem: "Ver na apostila" do exercício gerado abre o painel no material guardado (página incluída)', async t => {
  const release = installDom();
  const store = createCourseStore({ backend: memoryBackend(), now: NOW, uuid: () => 'estado' });
  await store.ready();
  // Aula com DOIS PDFs: o exercício guardou o SEGUNDO, na página 3.
  const document = courseDocument();
  document.course.sections[0].lessons[0].resources = [
    { id: 'material-1', name: 'Apostila Primeira.pdf', extension: 'pdf', role: 'apostila' },
    { id: 'material-2', name: 'Apostila Segunda.pdf', extension: 'pdf', role: 'apostila' },
  ];
  const imported = await store.importText(JSON.stringify(document), { source: 'teste' });
  assert.equal(imported.ok, true, imported.error);
  const courseId = imported.courseId;
  const library = fakeLibrary();
  library.register({
    id: 'exercicio-gerado',
    metadata: {
      name: 'Estudo de Exemplo',
      study: {
        version: 1,
        recipe: { version: 1, family: 'arpejo_triade_forma_unica' },
        origin: { id: 'aula-1', name: 'Aula aula-1', kind: 'course', private: true,
          material: { name: 'Apostila Segunda.pdf', lessonId: 'aula-1', resourceId: 'material-2', page: 3 } },
      },
    },
  });
  await store.linkExercise(courseId, 'aula-1', 'exercicio-gerado');

  const sha = 'a'.repeat(64);
  const refKey = attachmentRefKey(courseId, 'aula-1', 'material-2');
  const opened = [];
  const content = {
    available: () => true,
    loadRefs: async () => ({}),
    refFor: (id, refKey) => ({ sha256: sha, size: 2048, kind: 'pdf', name: 'Apostila Segunda.pdf', refKey }),
  };
  const panel = { open: target => { opened.push(target); return true; } };
  const container = makeRoot();
  const origins = mountExerciseOrigins(container, {
    store, library, exerciseId: 'exercicio-gerado', onOpenLesson: () => {}, content, panel, notify: () => {},
  });
  t.after(() => { origins.destroy(); release(); });

  const ver = container.querySelector('.course-origin-material');
  assert.ok(ver, 'a ação aparece com servidor');
  assert.equal(ver.textContent, 'Ver na apostila (página 3)');
  assert.equal(ver.dataset.refKey, refKey);
  ver.click();
  await sleep(10);
  assert.deepEqual(opened, [{ sha256: sha, kind: 'pdf', name: 'Apostila Segunda.pdf', size: 2048, page: 3, refKey }]);

  // Sem servidor (ou sem painel) a ação NÃO aparece: nada finge funcionar.
  const offline = makeRoot();
  const withoutServer = mountExerciseOrigins(offline, { store, library, exerciseId: 'exercicio-gerado', onOpenLesson: () => {} });
  t.after(() => withoutServer.destroy());
  assert.equal(offline.querySelector('.course-origin-material'), null);
  assert.equal(offline.querySelector('.course-origin').textContent.includes('Aula aula-1'), true, 'a origem continua lá');
});

test('origem: "Ver na apostila" abre da CÓPIA GUARDADA quando o servidor não tem a referência', async t => {
  const release = installDom();
  const store = createCourseStore({ backend: memoryBackend(), now: NOW, uuid: () => 'estado' });
  await store.ready();
  const document = courseDocument();
  document.course.sections[0].lessons[0].resources = [
    { id: 'material-1', name: 'Apostila Primeira.pdf', extension: 'pdf', role: 'apostila' },
    { id: 'material-2', name: 'Apostila Segunda.pdf', extension: 'pdf', role: 'apostila' },
  ];
  const imported = await store.importText(JSON.stringify(document), { source: 'teste' });
  assert.equal(imported.ok, true, imported.error);
  const courseId = imported.courseId;
  const library = fakeLibrary();
  library.register({
    id: 'exercicio-gerado',
    metadata: {
      name: 'Estudo de Exemplo',
      study: {
        version: 1,
        recipe: { version: 1, family: 'arpejo_triade_forma_unica' },
        origin: { id: 'aula-1', name: 'Aula aula-1', kind: 'course', private: true,
          material: { name: 'Apostila Segunda.pdf', lessonId: 'aula-1', resourceId: 'material-2', page: 3 } },
      },
    },
  });
  await store.linkExercise(courseId, 'aula-1', 'exercicio-gerado');

  // Cópia GUARDADA neste navegador (restaurada de um backup), SEM referência no
  // servidor para esse material — o caso real em que a ação dizia "não está no
  // servidor" e descartava um arquivo que está aqui.
  const refKey = attachmentRefKey(courseId, 'aula-1', 'material-2');
  const attachments = createAttachmentStore({ backend: memoryBackend({ keyPaths: { files: 'id', refs: 'key' } }), now: NOW, uuid: () => 'anexo' });
  await attachments.ready();
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3]);
  await attachments.put({ courseId, lessonId: 'aula-1', resourceId: 'material-2', name: 'Apostila Segunda.pdf', blob: new Blob([pdfBytes], { type: 'application/pdf' }) });
  const storedSha = attachments.get(refKey).fileId.slice('sha256:'.length);
  assert.equal(storedSha, sha256Hex(pdfBytes), 'a cópia local tem o hash do conteúdo');

  const messages = [];
  const opened = [];
  const content = { available: () => true, loadRefs: async () => ({}), refFor: () => null };
  const panel = { open: target => { opened.push(target); return true; } };
  const container = makeRoot();
  const origins = mountExerciseOrigins(container, {
    store, library, exerciseId: 'exercicio-gerado', onOpenLesson: () => {},
    content, panel, notify: text => messages.push(text), attachments,
  });
  t.after(() => { origins.destroy(); release(); });

  const ver = container.querySelector('.course-origin-material');
  assert.ok(ver, 'a ação aparece com servidor');
  ver.click();
  await sleep(20);
  assert.equal(opened.length, 1, 'o painel abriu');
  const target = opened[0];
  assert.equal(target.refKey, refKey);
  assert.equal(target.page, 3);
  assert.equal(target.name, 'Apostila Segunda.pdf');
  assert.equal(target.sha256, storedSha);
  assert.ok(target.localBlob instanceof Blob, 'abriu dos BYTES LOCAIS, não do servidor');
  assert.equal(await target.localBlob.arrayBuffer().then(buffer => sha256Hex(new Uint8Array(buffer))), storedSha, 'os bytes são os da cópia guardada');
  assert.deepEqual(messages, [], 'não declara indisponível um arquivo que está aqui');

  // Sem cópia local E sem referência no servidor, aí sim o aviso honesto.
  const emptyAttachments = createAttachmentStore({ backend: memoryBackend({ keyPaths: { files: 'id', refs: 'key' } }), now: NOW, uuid: () => 'anexo' });
  await emptyAttachments.ready();
  const messages2 = [];
  const opened2 = [];
  const container2 = makeRoot();
  const origins2 = mountExerciseOrigins(container2, {
    store, library, exerciseId: 'exercicio-gerado', onOpenLesson: () => {},
    content, panel: { open: target => { opened2.push(target); return true; } }, notify: text => messages2.push(text), attachments: emptyAttachments,
  });
  t.after(() => { origins2.destroy(); });
  container2.querySelector('.course-origin-material').click();
  await sleep(20);
  assert.equal(opened2.length, 0, 'sem cópia e sem servidor, nada abre');
  assert.equal(messages2.length, 1, 'avisa uma vez');
  assert.match(messages2[0], /não está no servidor/, 'o aviso é o mesmo de antes');
});

test('aula: anexo de PDF real sem extensão no mapa abre em nova aba (magia do conteúdo)', async t => {
  const backend = memoryBackend({ keyPaths: { files: 'id', refs: 'key' } });
  const attachments = createAttachmentStore({ backend, now: NOW, uuid: () => 'anexo' });
  await attachments.ready();
  const context = await setup({ attachments });
  t.after(() => context.cleanup());
  const { store, courseId, container, lesson } = context;

  // Material do curso sem extensão declarada, com PDF de verdade anexado.
  const documentText = courseDocument();
  documentText.course.sections[0].lessons[0].resources = [{ id: 'material-1', name: 'Apostila de Exemplo', role: 'apostila' }];
  const reimported = await store.importText(JSON.stringify(documentText), { source: 'teste' });
  assert.equal(reimported.ok, true, reimported.error);
  const refKey = JSON.stringify(['curso-exemplo', 'aula-1', 'material-1']);
  await attachments.put({
    courseId, lessonId: 'aula-1', resourceId: 'material-1', name: 'Apostila.pdf',
    blob: new Blob([new TextEncoder().encode('%PDF-1.7\n%%EOF\n')], { type: 'application/pdf' }),
  });

  await lesson.show(courseId, 'aula-1');
  const open = container.querySelector('#lesson-material-open-0');
  assert.ok(open, 'PDF confirmado mostra a ação de abrir');
  assert.equal(container.querySelector('#lesson-material-download-0'), null);
  const calls = [];
  const previousOpen = globalThis.open;
  globalThis.open = (url, target, features) => { calls.push({ url, target, features }); return null; };
  t.after(() => { globalThis.open = previousOpen; });
  open.click();
  await sleep(30);
  assert.equal(calls.length, 1, 'abriu o PDF em nova aba');
  assert.equal(calls[0].target, '_blank');
  assert.equal(calls[0].features, 'noopener,noreferrer');
  assert.equal(attachments.get(refKey).kind, 'pdf');
});

test('aula: ações secundárias do material e ajustes da sugestão só montam ao abrir', async t => {
  const backend = memoryBackend({ keyPaths: { files: 'id', refs: 'key' } });
  const attachments = createAttachmentStore({ backend, now: NOW, uuid: () => 'anexo' });
  await attachments.ready();
  const context = await setup({ attachments });
  t.after(() => context.cleanup());
  const { courseId, container, lesson } = context;

  await attachments.put({
    courseId, lessonId: 'aula-1', resourceId: 'material-1', name: 'Apostila.pdf',
    blob: new Blob([new TextEncoder().encode('%PDF-1.7\n%%EOF\n')], { type: 'application/pdf' }),
  });
  await lesson.show(courseId, 'aula-1');

  const materialMore = [...container.querySelectorAll('.lesson-item-more')]
    .find(node => /Mais ações do material/.test(node.querySelector('summary').textContent));
  assert.ok(materialMore, 'material com arquivo tem o grupo de ações secundárias');
  assert.equal(materialMore.querySelectorAll('button').length, 0, 'nada montado no repouso');
  assert.equal(container.querySelector('#lesson-material-remove-0'), null);
  materialMore.open = true;
  materialMore.dispatchEvent(makeEvent('toggle'));
  assert.ok(materialMore.querySelector('#lesson-material-remove-0'), 'Remover anexo aparece ao abrir');
  assert.ok(materialMore.querySelector('#lesson-material-upload-0'), 'Trocar arquivo aparece ao abrir');

  const suggestionMore = [...container.querySelectorAll('.lesson-item-more')]
    .find(node => /Ajustar BPM/.test(node.querySelector('summary').textContent));
  assert.ok(suggestionMore, 'sugestão agrupa os ajustes');
  assert.equal(suggestionMore.querySelectorAll('input').length, 0, 'campos não existem no repouso');
  suggestionMore.open = true;
  suggestionMore.dispatchEvent(makeEvent('toggle'));
  assert.equal(suggestionMore.querySelectorAll('input').length, 3);
  const barsField = suggestionMore.querySelector('#lesson-suggestion-bars-0');
  assert.equal(barsField.value, '4');
  barsField.value = '6';
  barsField.dispatchEvent(makeEvent('input'));
  assert.equal(lesson.lessonId, 'aula-1');
});

test('aula: áudio sem assinatura conhecida ainda tenta o player, com aviso honesto', async t => {
  const backend = memoryBackend({ keyPaths: { files: 'id', refs: 'key' } });
  const attachments = createAttachmentStore({ backend, now: NOW, uuid: () => 'anexo' });
  await attachments.ready();
  const context = await setup({ attachments });
  t.after(() => context.cleanup());
  const { courseId, container, lesson } = context;

  const stored = await attachments.put({
    courseId, lessonId: 'aula-1', resourceId: 'material-1', name: 'Faixa.mp3',
    extension: 'mp3',
    blob: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])], { type: 'audio/mpeg' }),
  });
  assert.equal(stored.kind, 'audio');
  assert.equal(stored.verified, false, 'formato não confirmado');

  await lesson.show(courseId, 'aula-1');
  const audio = container.querySelector('.lesson-audio');
  assert.ok(audio, 'o player nativo é oferecido mesmo sem assinatura');
  assert.equal(audio.hasAttribute('loop'), true);
  assert.equal(audio.hasAttribute('controls'), true);
  assert.match(container.querySelector('.lesson-audio-note').textContent, /formato não confirmado/);
  assert.match(container.querySelector('.lesson-material-warning').textContent, /não foi possível confirmar/i);
  assert.equal(container.querySelector('#lesson-material-download-0'), null);
});

test('aula: HTML renomeado de áudio não vira player e segue baixável', async t => {
  const backend = memoryBackend({ keyPaths: { files: 'id', refs: 'key' } });
  const attachments = createAttachmentStore({ backend, now: NOW, uuid: () => 'anexo' });
  await attachments.ready();
  const context = await setup({ attachments });
  t.after(() => context.cleanup());
  const { store, courseId, container, lesson } = context;

  const html = new TextEncoder().encode('<!DOCTYPE html><html><body>oi</body></html>');
  const stored = await attachments.put({
    courseId, lessonId: 'aula-1', resourceId: 'material-1', name: 'Faixa.mp3',
    extension: 'mp3', blob: new Blob([html], { type: 'audio/mpeg' }),
  });
  assert.equal(stored.kind, 'other');
  assert.equal(stored.verified, false);

  await lesson.show(courseId, 'aula-1');
  assert.equal(container.querySelector('.lesson-audio'), null, 'HTML nunca vira player');
  assert.ok(container.querySelector('#lesson-material-download-0'), 'continua baixável');
  assert.match(container.querySelector('.lesson-material-warning').textContent, /áudio/);
});

// ------------------------------- "Gerar" a partir da receita do catálogo (A6)

// Curso fictício com um exercício sugerido DE RECEITA (forma única) e outro sem
// receita, para os dois caminhos da página da aula.
function recipeDocument() {
  return {
    format: 'groovegoblin-course',
    version: 2,
    privacy: 'private',
    course: {
      id: 'curso-exemplo',
      title: 'Curso de Exemplo',
      instrument: 'bass',
      strings: 4,
      sections: [
        section('modulo-1', [
          lesson('aula-1', {
            resources: [{ id: 'material-1', name: 'Apostila de Exemplo', extension: 'pdf', role: 'apostila' }],
            suggestedExercises: [
              {
                id: 'cat-1',
                title: 'Exercício com receita',
                strings: 4,
                pdfPage: 12,
                trackNames: [],
                practiceMode: 'com metrônomo',
                catalogId: 'cat-1',
                recipe: {
                  version: 1,
                  family: 'arpejo_triade_forma_unica',
                  profile: { type: 'bass', strings: 4 },
                  progression: { kind: 'quartas', start: 'C', direction: 'ascendente', quality: 'major', chords: [], length: null, spelling: 'auto' },
                  region: { from: 1, to: 5, open: false, strings: null },
                  bars: null,
                  rhythm: 'arpejo',
                  figure: { bars: 2, degrees: [1, 3, 5], order: null, notes: null, inversions: null },
                  voltas: 1,
                  final: 'tonica',
                  shapeLabel: { label: 'Shape 1', quality: 'major', inversion: 'fundamental' },
                },
              },
              { id: 'sem-receita', title: 'Exercício sem receita' },
            ],
          }),
        ]),
      ],
    },
  };
}

const SHAPE = {
  id: 'bass4-maior-fundamental',
  label: 'Maior · fundamental',
  quality: 'major',
  degrees: [1, 3, 5],
  notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }],
};

function fakeLibrary() {
  const entries = new Map();
  let counter = 0;
  const updates = [];
  return {
    saved: true,
    updates,
    entries,
    list: () => [...entries.values()].map(entry => ({ id: entry.id, name: entry.metadata.name, instrument: 'bass', bpm: entry.session.bpm })),
    size: () => entries.size,
    get: id => entries.get(id) ?? null,
    subscribe: () => () => {},
    new({ session, metadata }) {
      counter += 1;
      const id = `exercicio-${counter}`;
      const entry = { id, session, metadata };
      entries.set(id, entry);
      return entry;
    },
    updateMetadata(id, patch) {
      const entry = entries.get(id);
      if (!entry) return null;
      updates.push({ id, patch });
      entry.metadata = { ...entry.metadata, ...patch };
      return entry;
    },
    // Registro usado pelo fake do Estúdio de estudo (o de verdade cria pela
    // biblioteca): a loja precisa conhecer o exercício para `updateMetadata`.
    register(entry) {
      entries.set(entry.id, { id: entry.id, session: { bpm: 100 }, metadata: { ...entry.metadata } });
      return entry;
    },
  };
}

function fakeStudies(library = null) {
  const created = [];
  return {
    created,
    openCalls: [],
    create(recipe, options = {}) {
      created.push({ recipe, options });
      const entry = { id: `estudo-${created.length}`, metadata: { name: 'Estudo de Exemplo' } };
      // O Estúdio de estudo de verdade cria pela BIBLIOTECA: sem registrar, a
      // marca de conteúdo de curso (`updateMetadata`) não teria onde cair e o
      // teste passaria sem exercitar nada.
      library?.register?.(entry);
      return entry;
    },
    open(options) { this.openCalls.push(options); },
  };
}

function boundBindings(shapeId = SHAPE.id) {
  const map = new Map();
  return {
    shapeFor: label => (label?.label === 'Shape 1' && label?.quality === 'major' ? shapeId : null),
    remember: (label, id) => { map.set(label.label, id); return { saved: true }; },
    list: () => [...map.entries()],
  };
}

const shapeAccess = { choicesFor: () => [{ id: SHAPE.id, label: SHAPE.label, generic: true, shape: SHAPE }], shape: id => (id === SHAPE.id ? SHAPE : null) };

test('aula: "Gerar" cria o exercício com notas, vincula, marca a sugestão e tira a fonte do compartilhamento', async t => {
  const library = fakeLibrary();
  const studies = fakeStudies(library);
  const context = await setup({ host: { library, studies, shapes: shapeAccess, bindings: boundBindings() }, document: recipeDocument() });
  t.after(() => context.cleanup());
  const { store, courseId, container, lesson, notifications } = context;

  await lesson.show(courseId, 'aula-1');
  const generate = [...container.querySelectorAll('button')].find(node => /^Gerar$/.test(node.textContent));
  assert.ok(generate, 'a sugestão com receita ganha "Gerar"');
  assert.equal(generate.disabled, false);
  generate.click();
  await sleep(20);

  assert.equal(studies.created.length, 1, 'o Estúdio de estudo criou o exercício');
  const { recipe, options } = studies.created[0];
  assert.equal(recipe.family, 'arpejo_triade_forma_unica');
  assert.equal(recipe.shape.id, SHAPE.id, 'a forma lembrada entra na receita');
  assert.equal(Object.hasOwn(recipe, 'shapeLabel'), false, 'o rótulo do curso não vai para o gerador');
  assert.equal(options.open, false, 'a geração não tira o usuário da aula');
  assert.deepEqual(options.origin, {
    id: 'aula-1', name: 'Aula aula-1', kind: 'course', private: true,
    // Material exato do catálogo (etapa 8): o exercício guarda o arquivo e a
    // página para reabrir a MESMA apostila depois, sem depender da aula de hoje.
    material: { name: 'Apostila de Exemplo', lessonId: 'aula-1', resourceId: 'material-1', page: 12 },
  });
  assert.equal(options.bpm, undefined);
  // Vinculado à aula e lembrado como sugestão gerada.
  const state = store.lessonState(courseId, 'aula-1');
  assert.deepEqual(state.linkedExerciseIds, ['estudo-1']);
  assert.deepEqual(state.generatedSuggestionIds, ['cat-1']);
  // Marca de conteúdo de curso (nada de material de terceiros sai em link).
  assert.deepEqual(library.updates, [{ id: 'estudo-1', patch: { courseContent: true } }]);
  assert.ok(notifications.some(item => /gerado com notas/.test(item.text)));
  // A sugestão sem receita continua no caminho do Estúdio, com os ajustes.
  assert.ok([...container.querySelectorAll('button')].some(node => node.textContent === 'Criar no Estúdio'));
  assert.ok(container.querySelector('#lesson-suggestions-generate-all') === null, 'nada pendente: sem "Gerar todos"');
});

test('aula: "Gerar todos" cria as sugestões de receita ainda não geradas', async t => {
  const library = fakeLibrary();
  const studies = fakeStudies(library);
  const context = await setup({ host: { library, studies, shapes: shapeAccess, bindings: boundBindings() }, document: recipeDocument() });
  t.after(() => context.cleanup());
  const { store, courseId, container, lesson } = context;
  await lesson.show(courseId, 'aula-1');
  const all = container.querySelector('#lesson-suggestions-generate-all');
  assert.ok(all, '"Gerar todos" aparece com as sugestões pendentes');
  assert.match(all.textContent, /Gerar todos \(1\)/);
  all.click();
  await sleep(20);
  assert.equal(studies.created.length, 1);
  assert.deepEqual(store.lessonState(courseId, 'aula-1').generatedSuggestionIds, ['cat-1']);
  // Reabrir a aula não oferece de novo (a sugestão foi lembrada).
  await lesson.show(courseId, 'aula-1');
  assert.equal(container.querySelector('#lesson-suggestions-generate-all'), null);
  const again = [...container.querySelectorAll('button')].find(node => /Gerar de novo/.test(node.textContent));
  assert.ok(again, 'a sugestão gerada continua acessível para gerar de novo');
});

test('aula: forma não lembrada não gera nada sem escolha (nada é inventado)', async t => {
  const library = fakeLibrary();
  const studies = fakeStudies(library);
  const context = await setup({ host: { library, studies, shapes: shapeAccess, bindings: { shapeFor: () => null, remember: () => ({ saved: true }) } }, document: recipeDocument() });
  t.after(() => context.cleanup());
  const { store, courseId, container, lesson, notifications } = context;
  await lesson.show(courseId, 'aula-1');
  const generate = [...container.querySelectorAll('button')].find(node => /^Gerar$/.test(node.textContent));
  generate.click();
  await sleep(20);
  assert.equal(studies.created.length, 0, 'sem forma escolhida o exercício não é inventado');
  assert.deepEqual(store.lessonState(courseId, 'aula-1').linkedExerciseIds, []);
  assert.deepEqual(store.lessonState(courseId, 'aula-1').generatedSuggestionIds, []);
});

test('aula: sem o Estúdio de estudo ligado, "Gerar" avisa em vez de fingir', async t => {
  const library = fakeLibrary();
  const context = await setup({ host: { library }, document: recipeDocument() });
  t.after(() => context.cleanup());
  const { container, lesson, courseId, notifications } = context;
  await lesson.show(courseId, 'aula-1');
  const generate = [...container.querySelectorAll('button')].find(node => /^Gerar$/.test(node.textContent));
  assert.equal(generate.disabled, true);
  const all = container.querySelector('#lesson-suggestions-generate-all');
  all.click();
  await sleep(20);
  assert.ok(notifications.some(item => item.error && /Estúdio de estudo/.test(item.text)));
});

test('aula: sem vínculo a sugestão NÃO é lembrada como gerada (nada de mentira no estado)', async t => {
  const library = fakeLibrary();
  const studies = fakeStudies(library);
  const context = await setup({ host: { library, studies, shapes: shapeAccess, bindings: boundBindings() }, document: recipeDocument() });
  t.after(() => context.cleanup());
  const { store, courseId, container, lesson, notifications } = context;
  await lesson.show(courseId, 'aula-1');
  // A aula "sumiu" entre abrir a página e gerar: a loja recusa o vínculo.
  store.linkExercise = async () => null;
  const generate = [...container.querySelectorAll('button')].find(node => /^Gerar$/.test(node.textContent));
  generate.click();
  await sleep(20);
  assert.equal(studies.created.length, 1, 'o exercício é criado na biblioteca');
  assert.deepEqual(store.lessonState(courseId, 'aula-1').linkedExerciseIds, [], 'nada foi vinculado');
  assert.deepEqual(store.lessonState(courseId, 'aula-1').generatedSuggestionIds, [], 'nada é marcado como gerado');
  assert.ok(notifications.some(item => /não foi vinculado nem marcado como gerado/.test(item.text)));
  // A sugestão continua pendente: "Gerar todos" volta a oferecê-la.
  await lesson.show(courseId, 'aula-1');
  assert.ok(container.querySelector('#lesson-suggestions-generate-all'), 'a sugestão pendente continua na oferta');
});

test('aula: exercício vinculado à mão também é marcado como conteúdo de curso', async t => {
  const library = fakeLibrary();
  library.register({ id: 'biblioteca-1', metadata: { name: 'Exercício da biblioteca' } });
  const context = await setup({ host: { library }, document: recipeDocument() });
  t.after(() => context.cleanup());
  const { store, courseId, container, lesson } = context;
  await lesson.show(courseId, 'aula-1');
  const select = container.querySelector('#lesson-link-select');
  select.value = 'biblioteca-1';
  select.dispatchEvent(makeEvent('change'));
  container.querySelector('#lesson-link-add').click();
  await sleep(20);
  assert.deepEqual(store.lessonState(courseId, 'aula-1').linkedExerciseIds, ['biblioteca-1']);
  // O vínculo manual marca o exercício: nome da aula e vínculo não saem em
  // link/exportação de conteúdo de curso.
  assert.deepEqual(library.updates, [{ id: 'biblioteca-1', patch: { courseContent: true } }]);
});

test('aula: a receita do catálogo aparece resumida e o material abre pela página', async t => {
  const library = fakeLibrary();
  const material = [];
  const context = await setup({
    host: { library, studies: fakeStudies(library), shapes: shapeAccess, bindings: boundBindings(), openMaterial: options => { material.push(options); return true; } },
    document: recipeDocument(),
  });
  t.after(() => context.cleanup());
  const { container, lesson, courseId } = context;
  await lesson.show(courseId, 'aula-1');
  const summary = container.querySelector('.lesson-suggestion-recipe');
  assert.match(summary.textContent, /Arpejo de tríade, forma única/);
  assert.match(summary.textContent, /ciclo de quartas desde C/);
  assert.match(summary.textContent, /forma “Shape 1”/);
  assert.match(container.querySelector('.lesson-suggestion-meta').textContent, /prática: com metrônomo/);

  const button = [...container.querySelectorAll('button')].find(node => /Ver na apostila/.test(node.textContent));
  assert.ok(button);
  button.click();
  await sleep(10);
  assert.deepEqual(material.map(option => [option.courseId, option.lessonId, option.resourceId, option.page, option.name]), [
    [courseId, 'aula-1', 'material-1', 12, 'Apostila de Exemplo'],
  ]);
});

test('aula: dois PDFs sem fonte explícita viram escolha honesta (sem "o primeiro" e sem página)', async t => {
  const library = fakeLibrary();
  const material = [];
  const document = recipeDocument();
  document.course.sections[0].lessons[0].resources = [
    { id: 'material-1', name: 'Apostila Primeira.pdf', extension: 'pdf', role: 'apostila' },
    { id: 'material-2', name: 'Apostila Segunda.pdf', extension: 'pdf', role: 'apostila' },
  ];
  const context = await setup({
    host: { library, studies: fakeStudies(library), shapes: shapeAccess, bindings: boundBindings(), openMaterial: options => { material.push(options); return true; } },
    document,
  });
  t.after(() => context.cleanup());
  const { container, lesson, courseId } = context;
  await lesson.show(courseId, 'aula-1');

  assert.equal([...container.querySelectorAll('button')].some(node => /^Ver na apostila \(página/.test(node.textContent)), false,
    'não afirma a página de um material que o catálogo não indicou');
  const picker = container.querySelector('.lesson-suggestion-material-more');
  assert.ok(picker, 'a escolha fica em um details');
  assert.equal(picker.querySelectorAll('button').length, 2, 'as duas apostilas da aula aparecem');
  const texts = [...picker.querySelectorAll('button')].map(node => node.textContent);
  assert.deepEqual(texts.sort(), ['Apostila Primeira.pdf', 'Apostila Segunda.pdf']);
  for (const node of picker.querySelectorAll('button')) node.click();
  await sleep(10);
  assert.deepEqual(material.map(option => [option.resourceId, option.page]).sort(), [['material-1', null], ['material-2', null]],
    'abre o material escolhido, sem afirmar página');
});

test('aula: a linha do exercício vinculado abre o MESMO material guardado, na MESMA página', async t => {
  const library = fakeLibrary();
  library.register({
    id: 'exercicio-gerado',
    metadata: {
      name: 'Estudo de Exemplo',
      study: {
        version: 1,
        recipe: { version: 1, family: 'arpejo_triade_forma_unica' },
        origin: { id: 'aula-1', name: 'Aula aula-1', kind: 'course', private: true,
          material: { name: 'Apostila Segunda.pdf', lessonId: 'aula-1', resourceId: 'material-2', page: 3 } },
      },
    },
  });
  const document = courseDocument();
  document.course.sections[0].lessons[0].resources = [
    { id: 'material-1', name: 'Apostila Primeira.pdf', extension: 'pdf', role: 'apostila' },
    { id: 'material-2', name: 'Apostila Segunda.pdf', extension: 'pdf', role: 'apostila' },
  ];
  const sha = 'b'.repeat(64);
  const opened = [];
  const content = {
    available: () => true,
    loadRefs: async () => ({}),
    refFor: (courseId, refKey) => (refKey === attachmentRefKey(courseId, 'aula-1', 'material-2')
      ? { sha256: sha, size: 1024, kind: 'pdf', name: 'Apostila Segunda.pdf', refKey }
      : null),
  };
  const context = await setup({
    host: { library, content, panel: { open: target => { opened.push(target); return true; } } },
    document,
  });
  t.after(() => context.cleanup());
  const { store, container, lesson, courseId } = context;
  await store.linkExercise(courseId, 'aula-1', 'exercicio-gerado');
  await lesson.show(courseId, 'aula-1');

  const row = [...container.querySelectorAll('.lesson-link')].find(item => /Estudo de Exemplo/.test(item.textContent));
  assert.ok(row, 'a linha do exercício vinculado aparece');
  const ver = row.querySelector('[data-action="open-apostila"]');
  assert.ok(ver, 'a linha tem "Ver na apostila" no servidor');
  ver.click();
  await sleep(10);
  assert.deepEqual(opened, [{ sha256: sha, kind: 'pdf', name: 'Apostila Segunda.pdf', size: 1024, page: 3 }],
    'abre o material guardado na página 3, não a primeira apostila');
});

// ── "manter offline" do material do servidor (rodada 6 · B4) ────────────────
// A cópia offline é escolha do usuário; liberá-la NÃO pode apagar o material:
// a referência do curso (nome, tipo, tamanho e vínculo) é do servidor, e o
// documento de sincronização do curso é o conjunto de referências — apagar a
// referência aqui apagaria o material para todos os navegadores no próximo
// envio. O teste usa a loja de anexos REAL e o motor REAL contra o servidor de
// contrato, pelo caminho do consumidor (clique nos botões da linha).
test('liberar a cópia offline preserva a referência do material e não apaga nada no servidor', async t => {
  const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');
  const sha = sha256Hex(PDF_BYTES);
  const backend = memoryBackend({ keyPaths: { files: 'id', refs: 'key' } });
  const attachments = createAttachmentStore({
    backend, now: NOW, uuid: (() => { let n = 0; return () => `att-${(n += 1)}`; })(), digest: globalThis.crypto.subtle,
  });
  await attachments.ready();

  const server = await startContractServer();
  t.after(() => server.close());
  const storage = createMemoryStorage();
  const state = createSyncState({ storage });
  const engine = createSyncEngine({
    client: createServerClient({ base: server.base, requestOrigin: server.origin }),
    ports: [createAttachmentAdapter(attachments)],
    outbox: createSyncOutbox({ storage }), state,
    shouldProbe: () => true, timers: createFakeTimers(),
  });
  t.after(() => engine.stop());

  const courseId = 'curso-exemplo';
  const refKey = attachmentRefKey(courseId, 'aula-1', 'material-1');
  const serverRef = { sha256: sha, size: PDF_BYTES.length, kind: 'pdf', name: 'Apostila de Exemplo.pdf', addedAt: NOW() };
  server.seedBlob(PDF_BYTES);
  server.seed('courseAttachments', courseId, { refs: { [refKey]: { ...serverRef } } });
  await engine.start();
  assert.equal(attachments.get(refKey)?.present, false, 'a referência do servidor entra sem bytes');

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, blob: async () => new Blob([PDF_BYTES], { type: 'application/pdf' }) });
  t.after(() => { if (previousFetch === undefined) delete globalThis.fetch; else globalThis.fetch = previousFetch; });

  const content = {
    available: () => true,
    start: () => Promise.resolve('ready'),
    loadRefs: async () => ({ [refKey]: { ...serverRef } }),
    refFor: (id, key) => (key === refKey ? { ...serverRef } : null),
    blobUrl: value => `https://example.invalid/api/blobs/${value}`,
  };
  const pins = {
    available: () => true,
    has: value => engine.pinned().some(entry => entry.sha256 === value),
    pin: (value, meta) => engine.pinAttachment(value, meta),
    unpin: value => engine.unpinAttachment(value),
  };
  const context = await setup({ attachments, host: { content, pins } });
  t.after(() => context.cleanup());
  const { container, lesson } = context;
  await lesson.show(courseId, 'aula-1');

  const keep = container.querySelector('#lesson-material-keep-0');
  assert.ok(keep, 'a linha do material do servidor tem "Manter offline"');
  keep.click();
  await sleep(30);
  const stored = attachments.get(refKey);
  assert.equal(stored.present, true, 'os bytes vieram para o navegador');
  assert.equal(await attachments.getBlob(refKey).then(blob => blob.size), PDF_BYTES.length);
  assert.equal(engine.pinned().length, 1, 'a marca de "manter offline" entrou');

  // Liberar com a rede cortada: sem lista de vínculos lida nesta página.
  content.refFor = () => null;
  const more = container.querySelector('.lesson-item-more');
  more.open = true;
  more.dispatchEvent(makeEvent('toggle'));
  const release = container.querySelector('#lesson-material-release-0');
  assert.ok(release, 'a cópia guardada tem "Deixar de manter offline"');
  release.click();
  await sleep(30);

  const after = attachments.get(refKey);
  assert.ok(after, 'a referência do material continua (nada é apagado)');
  assert.equal(after.name, 'Apostila de Exemplo.pdf', 'o nome continua');
  assert.equal(after.kind, 'pdf', 'o tipo continua');
  assert.equal(after.size, PDF_BYTES.length, 'o tamanho continua');
  assert.equal(after.source, 'servidor', 'a referência continua sendo do servidor');
  assert.equal(after.present, false, 'os bytes locais saíram');
  assert.equal(await attachments.getBlob(refKey), null, 'não há mais cópia local');
  assert.equal(engine.pinned().length, 0, 'a marca de "manter offline" saiu');
  assert.deepEqual((await createAttachmentAdapter(attachments).list())[0].body, { refs: { [refKey]: { ...serverRef } } },
    'o documento de sincronização do curso não mudou');

  // A linha volta a ser a do SERVIDOR: "Manter offline" de novo, sem ação local.
  assert.ok(container.querySelector('#lesson-material-keep-0'), 'a linha do servidor voltou');
  assert.equal(container.querySelector('[data-action="open-pdf"]'), null, 'não oferece abrir um arquivo que não está aqui');

  await engine.sendAll();
  const pushed = server.docs('courseAttachments').get(courseId).body;
  assert.equal(pushed.refs[refKey]?.sha256, sha, 'o envio não apaga a referência do servidor');
  assert.equal(pushed.refs[refKey]?.name, 'Apostila de Exemplo.pdf');
  assert.equal(pushed.refs[refKey]?.kind, 'pdf');
});
