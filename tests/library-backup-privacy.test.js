// Barreiras contra compartilhamento acidental no backup agregado (B6).
//
// Teste de CONSUMIDOR do envelope: monta a biblioteca de exercícios, a loja de
// cursos e a loja de anexos REAIS com backends em memória e confere que o
// backup PADRÃO não leva nenhum marcador de curso (nem no nome do arquivo, nem
// em ids, notas, cifras, seções, vínculos, estados, anexos ou bytes ilegíveis)
// enquanto o opt-in privado explícito preserva tudo.
//
// Tudo fictício: "Curso de Exemplo", "Aula aula-1", example.invalid. O marcador
// SEGREDO só existe aqui e nunca deve sair no arquivo público.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, parseSession, serializeSession } from '../src/session.js';
import { createExerciseLibrary } from '../src/exercise-library.js';
import { createCourseStore } from '../src/course-store.js';
import {
  buildBackup, serializeBackup, importBackup, validateBackup, summarizeBackup,
  describeImportResult, backupFileName,
} from '../src/library-backup.js';
import { courseText, memoryBackend } from './course-fixtures.js';
import { memoryStorage } from './storage-fixture.js';
import { createFingeringShapeStore } from '../src/fingering-shapes.js';
import { createShapeBindingStore } from '../src/course-shape-binding.js';

const SECRET = 'SEGREDO';
const PUBLIC_NAME = 'Estudo musical';
// Rótulo FICTÍCIO do catálogo (é assim que o catálogo pago referencia a forma).
const CATALOG_LABEL = Object.freeze({ label: 'Shape 1', quality: 'major', inversion: 'fundamental' });

let createAttachmentStore = null;
try { ({ createAttachmentStore } = await import('../src/course-attachments.js')); } catch { /* etapa 6 ausente */ }
const attachmentTests = createAttachmentStore === null ? { skip: 'módulo da etapa 6 ausente neste worktree' } : {};

// ---------------------------------------------------------------- fixtures

function clock(start = Date.UTC(2026, 9, 6, 9, 0, 0)) {
  let ticks = 0;
  return () => new Date(start + (ticks++) * 1000).toISOString();
}

let counter = 0;
function nextUuid() { counter += 1; return `pv-${counter}`; }

const COURSE_KEYS = Object.freeze({ courses: 'id', states: 'courseId' });
const ATTACHMENT_KEYS = Object.freeze({ files: 'id', refs: 'key' });

function openLibrary(storage) {
  return createExerciseLibrary({
    storage, parse: parseSession, serialize: serializeSession,
    currentSession: createSession({ name: 'Sessão base', bars: 4, bpm: 80, notes: [{ id: 'n1', start: 0, duration: 4, pitch: 52, string: 4 }] }),
    now: clock(), uuid: nextUuid,
  });
}

function memoryAttachmentBackend() {
  const stores = { files: new Map(), refs: new Map() };
  return {
    async getAll(store) { return [...stores[store].values()].map(value => structuredClone(value)); },
    async get(store, id) { const value = stores[store].get(id); return value === undefined ? undefined : structuredClone(value); },
    async put(store, value) { stores[store].set(value[ATTACHMENT_KEYS[store]], structuredClone(value)); },
    async writeBatch(entries) {
      for (const entry of entries) {
        if (entry.remove) stores[entry.store].delete(entry.id);
        else stores[entry.store].set(entry.value[ATTACHMENT_KEYS[entry.store]], structuredClone(entry.value));
      }
    },
    async delete(store, id) { stores[store].delete(id); },
  };
}

// A biblioteca NASCE com a sessão do Estúdio como primeiro exercício salvo (é o
// que a migração da rodada 5 sempre fez): ela entra no retrato e, sem loja de
// cursos confiável, também é redigida por precaução.
function baseSession() {
  return createSession({ name: 'Sessão base', bars: 4, bpm: 80, notes: [{ id: 'n1', start: 0, duration: 4, pitch: 52, string: 4 }] });
}

// Sessão AUTORAL, sem nada de curso: deve continuar saindo inteira no público.
function authoredSession() {
  return createSession({
    name: 'Exercício Livre', bars: 2, bpm: 84,
    notes: [{ id: 'livre-1', start: 0, duration: 4, pitch: 52, string: 4 }],
  });
}

// Sessão com texto de curso em TODOS os campos livres: nome, ids de nota,
// nome de seção, cifra e extensões.
function courseTaintedSession() {
  return createSession({
    name: SECRET, bars: 2, bpm: 96,
    notes: [{ id: SECRET, start: 0, duration: 4, pitch: 36, string: 3 }],
    progression: {
      enabled: true, cycleBars: 2,
      chords: [{ symbol: SECRET, quality: SECRET, roman: SECRET, root: 0, startBar: 0, durationBars: 2, notes: [{ midi: 48, name: SECRET }, { midi: 52, name: SECRET }, { midi: 55, name: SECRET }] }],
    },
    form: { enabled: true, loop: false, sections: [{ id: SECRET, name: SECRET, kind: 'A', startBar: 0, endBar: 2, repeats: 1 }] },
    extensions: { privateCourse: SECRET },
  });
}

// Sessão de um exercício LEGADO: ligado a uma aula na loja, mas SEM o marcador
// pegajoso `courseContent` (como os vínculos criados antes desta etapa).
function legacySession() {
  return createSession({ name: 'Exercício Antigo', bars: 2, bpm: 72, notes: [{ id: 'antigo-1', start: 0, duration: 4, pitch: 55, string: 3 }] });
}

// Um mundo completo: três exercícios (autoral, marcado, legado), um curso com
// estado/anotações, um anexo e, opcionalmente, um registro cru ilegível.
async function world({ withAttachments = false, corruptCourse = false } = {}) {
  const library = openLibrary(memoryStorage());
  const backend = memoryBackend();
  if (corruptCourse) backend.seed('courses', { id: 'curso-sumido', lixo: SECRET });
  const store = createCourseStore({ backend, now: clock(), uuid: nextUuid });
  await store.ready();
  await store.importText(courseText());
  await store.setLessonState('curso-exemplo', 'aula-2', { notes: `${SECRET} anotação da aula`, watched: true });
  await store.setPreferences('curso-exemplo', { active: false, dailyMinutes: 20 });

  const authored = library.new({ session: authoredSession() });
  const sticky = library.new({ session: courseTaintedSession() });
  library.updateMetadata(sticky.id, { courseContent: true, notes: SECRET, tags: [SECRET] });
  const legacy = library.new({ session: legacySession() });
  await store.linkExercise('curso-exemplo', 'aula-1', legacy.id);

  let attachments = null;
  if (createAttachmentStore) {
    attachments = createAttachmentStore({ backend: memoryAttachmentBackend(), now: clock(), uuid: nextUuid });
    if (withAttachments) {
      await attachments.put({
        courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1',
        name: `${SECRET}-apostila.pdf`, extension: 'pdf', role: 'apostila', source: 'upload',
        blob: new Blob([new TextEncoder().encode(`%PDF-1.4 ${SECRET} apostila`)], { type: 'application/pdf' }),
      });
    }
  }
  return { library, store, attachments, backend, authored, sticky, legacy };
}

// Notas musicais comparáveis: passa pelo parser canônico e tira só o id (que é
// justamente o campo que a redação troca). `serializeSession` devolve o ENVELOPE
// do formato de sessão — as notas vivem em `.session`.
function musicalNotes(session) {
  return JSON.parse(serializeSession(session)).session.notes.map(({ id, ...note }) => note);
}

function allNotes(document_) {
  return document_.exercises.entries.map(entry => musicalNotes(entry.session)).flat();
}

function namesOf(document_) {
  return document_.exercises.entries.map(entry => entry.metadata.name);
}

const FORBIDDEN = [SECRET, 'Curso de Exemplo', 'Autor de Exemplo', 'Aula aula-1', 'curso-exemplo', 'aula-1', 'apostila', 'lixo'];

function assertNoCourseMarkers(text) {
  for (const marker of FORBIDDEN) {
    assert.equal(text.includes(marker), false, `o backup público não pode conter "${marker}"`);
  }
}

// ------------------------------------------------------------------- testes

test('privacidade: o backup PADRÃO não leva nenhum marcador de curso e toca as mesmas notas', async () => {
  const source = await world({ withAttachments: true });
  const built = await buildBackup({ library: source.library, store: source.store, attachments: source.attachments, now: clock() });
  assert.equal(built.ok, true);
  const document_ = built.document;
  const text = serializeBackup(document_);

  // Formato continua o mesmo, versão 1, legível.
  assert.equal(document_.kind, 'groovegoblin-library-backup');
  assert.equal(document_.version, 1);
  assert.equal(validateBackup(document_).ok, true);
  assert.equal(document_.privacy.courseContent, 'omitted');

  // Catálogo, estados, vínculos, anexos e bytes ilegíveis: tudo fora.
  assert.equal(document_.courses.omitted, true);
  assert.deepEqual(document_.courses.records, []);
  assert.deepEqual(document_.courses.states, []);
  assert.deepEqual(document_.courses.corrupt, []);
  assert.equal(document_.attachments.included, false);
  assert.equal(document_.attachments.document, null);
  assert.equal(built.summary.coursesOmitted, true);
  assert.equal(built.summary.courseContent, 'omitted');

  assertNoCourseMarkers(text);
  // Nem no nome do arquivo, nem no id ativo (que é remapeado junto).
  const filename = backupFileName(() => '2026-10-06T12:00:00.000Z');
  assert.doesNotMatch(filename, /PRIVADO/);
  assert.doesNotMatch(filename, /SEGREDO|curso|aula/i);
  assert.equal([source.authored.id, source.sticky.id, source.legacy.id].includes(document_.exercises.activeId), false);

  // O exercício AUTORAL continua reconhecível; os dois de curso saem genéricos.
  const names = namesOf(document_);
  assert.equal(names.includes('Exercício Livre'), true);
  assert.equal(names.filter(name => name === PUBLIC_NAME).length, 2);

  // A MÚSICA é a mesma: notas, cordas, casas e cifras (sem os nomes livres).
  // A ordem é a de criação: a sessão base da biblioteca vem primeiro.
  assert.deepEqual(allNotes(document_), [
    ...musicalNotes(baseSession()),
    ...musicalNotes(authoredSession()),
    ...musicalNotes(courseTaintedSession()),
    ...musicalNotes(legacySession()),
  ]);
  const chord = document_.exercises.entries.find(entry => entry.session.progression.chords.length > 0).session.progression.chords[0];
  assert.deepEqual(chord.notes.map(note => note.midi), [48, 52, 55]);
  assert.equal(chord.root, 0);
  assert.equal(chord.symbol.includes(SECRET), false);

  // E o arquivo público REIMPORTA: os exercícios entram, os cursos não existem.
  const dest = openLibrary(memoryStorage());
  const result = await importBackup(text, { library: dest });
  assert.equal(result.ok, true);
  assert.equal(result.applied.exercises.added, 3);
  // Sem cursos no arquivo, a fase de cursos fica no resumo zerado (a mesma
  // convenção do resto do módulo) — nunca uma falha por loja ausente.
  assert.deepEqual(result.applied.courses, { added: 0, merged: 0, unchanged: 0, orphans: 0, tombstones: 0, resurrected: 0, watched: 0, notes: 0, links: 0, watch: 0 });
  // Omissão por opção é dita na importação, não confundida com loja que falhou.
  assert.equal(result.courseContent, 'omitted');
  assert.match(describeImportResult(result), /Arquivo público/);
  const restored = dest.list().find(row => row.name === 'Exercício Livre');
  assert.ok(restored);
  assert.deepEqual(musicalNotes(dest.get(restored.id).session), musicalNotes(authoredSession()));
});

test('privacidade: vínculo LEGADO é redigido pela loja real, sem o marcador pegajoso', async () => {
  const source = await world();
  // O vínculo existe na loja e o exercício NÃO tem o marcador pegajoso.
  assert.equal(source.library.get(source.legacy.id).metadata.courseContent, false);
  assert.equal(source.store.originsOf(source.legacy.id).length, 1);

  const built = await buildBackup({ library: source.library, store: source.store, now: clock() });
  const names = namesOf(built.document);
  assert.equal(names.filter(name => name === PUBLIC_NAME).length, 2);   // o marcado + o legado
  assert.equal(names.includes('Exercício Antigo'), false);
  assertNoCourseMarkers(serializeBackup(built.document));

  // Exportar NÃO marca o exercício de origem (nenhuma mutação).
  assert.equal(source.library.get(source.legacy.id).metadata.courseContent, false);
  assert.equal(source.library.get(source.legacy.id).metadata.name, 'Exercício Antigo');
});

test('privacidade: loja desconhecida ou ilegível redige por precaução (nunca "sem conteúdo de curso")', async () => {
  const source = await world();

  // Sem loja informada não há como provar que um vínculo legado é público: a
  // sessão base da biblioteca também é redigida (quatro exercícios no total).
  const withoutStore = await buildBackup({ library: source.library, now: clock() });
  assert.equal(withoutStore.document.courses.available, false);
  assert.equal(withoutStore.document.courses.omitted, true);
  assert.deepEqual(namesOf(withoutStore.document), [PUBLIC_NAME, PUBLIC_NAME, PUBLIC_NAME, PUBLIC_NAME]);

  // Loja com registro cru ilegível: as origens não são confiáveis ⇒ idem.
  const corrupt = await world({ corruptCourse: true });
  assert.equal(corrupt.store.corrupt().length, 1);
  const built = await buildBackup({ library: corrupt.library, store: corrupt.store, now: clock() });
  assert.deepEqual(namesOf(built.document), [PUBLIC_NAME, PUBLIC_NAME, PUBLIC_NAME, PUBLIC_NAME]);
  assertNoCourseMarkers(serializeBackup(built.document));

  // Loja que falha ao responder as origens também é desconhecida.
  const throwing = { persistent: true, error: null, corrupt: () => [], originsOf: () => { throw new Error('loja travada'); }, ready: async () => {}, snapshotAll: () => ({ records: [], states: [], orphans: [], corrupt: [] }) };
  const thrown = await buildBackup({ library: corrupt.library, store: throwing, now: clock() });
  assert.deepEqual(namesOf(thrown.document), [PUBLIC_NAME, PUBLIC_NAME, PUBLIC_NAME, PUBLIC_NAME]);
});

test('privacidade: a decisão espera o `ready` da loja de cursos', async () => {
  const source = await world();
  let ready = false;
  const lateStore = {
    persistent: true, error: null, corrupt: () => [],
    originsOf: id => (ready ? [{ courseId: 'curso-exemplo', lessonId: 'aula-1' }] : []),
    ready: async () => { await new Promise(resolve => setImmediate(resolve)); ready = true; },
    snapshotAll: () => ({ records: [], states: [], orphans: [], corrupt: [] }),
  };
  const built = await buildBackup({ library: source.library, store: lateStore, now: clock() });
  assert.equal(ready, true);
  // Sem esperar o ready, o vínculo legado passaria por público.
  assert.equal(namesOf(built.document).includes('Exercício Antigo'), false);
});

test('privacidade: opt-in privado explícito preserva metadados, estados e anexos', { ...attachmentTests }, async () => {
  const source = await world({ withAttachments: true, corruptCourse: true });
  const built = await buildBackup({
    library: source.library, store: source.store, attachments: source.attachments,
    includeCourseContent: true, includeAttachments: true, now: clock(),
  });
  assert.equal(built.ok, true);
  const document_ = built.document;
  const text = serializeBackup(document_);
  assert.equal(document_.privacy.courseContent, 'included');
  assert.equal(document_.courses.omitted, false);

  // Nada foi redigido: curso, aula, anotações, vínculos, marcador pegajoso,
  // anexo (nome e bytes) e o registro cru ilegível continuam no arquivo.
  assert.equal(text.includes(SECRET), true);
  assert.equal(text.includes('Curso de Exemplo'), true);
  assert.equal(document_.courses.records.length, 1);
  assert.equal(document_.courses.states[0].lessons['aula-2'].notes, `${SECRET} anotação da aula`);
  assert.deepEqual(document_.courses.states[0].lessons['aula-1'].linkedExerciseIds, [source.legacy.id]);
  assert.equal(document_.courses.corrupt[0].raw.lixo, SECRET);
  assert.equal(document_.attachments.included, true);
  assert.equal(document_.attachments.document.files[0].name, `${SECRET}-apostila.pdf`);
  assert.equal(document_.exercises.entries.find(entry => entry.id === source.sticky.id).metadata.notes, SECRET);
  assert.equal(validateBackup(document_).ok, true);

  // Nome de arquivo marcado: impossível confundir com o público.
  assert.match(backupFileName(() => '2026-10-06T12:00:00.000Z', { includeCourseContent: true }), /PRIVADO/);

  // Ida e volta: estado do curso, vínculo remapeado, anotações e bytes.
  const dest = await world({ withAttachments: false });
  const result = await importBackup(text, { library: dest.library, store: dest.store, attachments: dest.attachments });
  assert.equal(result.ok, true);
  assert.equal(result.applied.courses.merged + result.applied.courses.added + result.applied.courses.unchanged > 0, true);
  assert.equal(dest.store.get('curso-exemplo').state.lessons['aula-2'].notes.includes(`${SECRET} anotação da aula`), true);
  assert.deepEqual(dest.store.get('curso-exemplo').state.preferences, { active: false, dailyMinutes: 20 });
  const remapped = dest.store.get('curso-exemplo').state.lessons['aula-1'].linkedExerciseIds;
  assert.equal(remapped.length, 1);
  assert.equal(dest.library.get(remapped[0]).metadata.notes, '');
  assert.equal(dest.store.snapshotAll().corrupt.length, 0);
  const original = await source.attachments.getBlob(source.attachments.listByCourse('curso-exemplo')[0].key);
  const restored = await dest.attachments.getBlob(source.attachments.listByCourse('curso-exemplo')[0].key);
  assert.ok(restored);
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), new Uint8Array(await original.arrayBuffer()));
});

test('privacidade: o backup privado preserva formas e vínculos rótulo→forma do catálogo', async () => {
  const source = await world();
  const shapes = createFingeringShapeStore({ storage: memoryStorage(), uuid: nextUuid });
  shapes.save({
    label: 'Maior · fundamental', quality: 'major', degrees: [1, 3, 5],
    notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }],
  }, { type: 'bass', strings: 4 });
  const shapeId = shapes.group('bass4')[0].id;
  const bindings = createShapeBindingStore({ storage: memoryStorage(), now: clock() });
  bindings.remember(CATALOG_LABEL, shapeId, { instrument: 'bass4' });

  const built = await buildBackup({ library: source.library, store: source.store, shapes, bindings, includeCourseContent: true, now: clock() });
  assert.equal(built.ok, true);
  assert.equal(built.document.shapes.instruments.bass4.length, 1);
  assert.equal(built.document.shapeBindings.bindings.length, 1);
  assert.equal(built.summary.bindings, 1);
  assert.equal(serializeBackup(built.document).includes(CATALOG_LABEL.label), true);
  assert.equal(validateBackup(built.document).ok, true);

  const targetShapes = createFingeringShapeStore({ storage: memoryStorage(), uuid: nextUuid });
  const targetBindings = createShapeBindingStore({ storage: memoryStorage(), now: clock() });
  // O retrato privado traz cursos: a importação precisa da loja de cursos no
  // destino (sem ela a fase de cursos seria PARCIAL, como manda o contrato).
  const targetStore = createCourseStore({ backend: memoryBackend(), now: clock(), uuid: nextUuid });
  await targetStore.ready();
  const result = await importBackup(serializeBackup(built.document), { library: openLibrary(memoryStorage()), store: targetStore, shapes: targetShapes, bindings: targetBindings });
  assert.equal(result.ok, true);
  assert.equal(targetShapes.group('bass4').length, 1);
  assert.equal(targetBindings.list().length, 1);
  assert.equal(targetBindings.shapeFor(CATALOG_LABEL), shapeId);
});

test('privacidade: vínculos rótulo→forma do catálogo só saem no backup privado', async () => {
  const source = await world();
  const bindings = createShapeBindingStore({ storage: memoryStorage(), now: clock() });
  bindings.remember(CATALOG_LABEL, 'forma-exemplo-1', { instrument: 'bass4' });

  const public_ = await buildBackup({ library: source.library, store: source.store, bindings, now: clock() });
  assert.equal(public_.ok, true);
  assert.equal(public_.document.shapeBindings.omitted, true);
  assert.equal(public_.document.shapeBindings.available, false);
  assert.deepEqual(public_.document.shapeBindings.bindings, []);
  assert.equal(public_.summary.bindingsOmitted, true);
  assert.equal(public_.summary.bindings, 0);
  assert.equal(serializeBackup(public_.document).includes(CATALOG_LABEL.label), false);
  assert.equal(validateBackup(public_.document).ok, true);

  // O arquivo público continua importável: os vínculos não existem nele.
  const target = createShapeBindingStore({ storage: memoryStorage(), now: clock() });
  const imported = await importBackup(serializeBackup(public_.document), { library: openLibrary(memoryStorage()), bindings: target });
  assert.equal(imported.ok, true);
  assert.equal(imported.applied.bindings, null);
  assert.equal(target.list().length, 0);

  const private_ = await buildBackup({ library: source.library, store: source.store, bindings, includeCourseContent: true, now: clock() });
  assert.equal(private_.document.shapeBindings.omitted, false);
  assert.equal(private_.document.shapeBindings.bindings[0].label, CATALOG_LABEL.label);
});

test('privacidade: anexos exigem as DUAS opções (privado e o opt-in de anexos)', { ...attachmentTests }, async () => {
  const source = await world({ withAttachments: true });
  const refused = await buildBackup({ library: source.library, store: source.store, attachments: source.attachments, includeAttachments: true, now: clock() });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'private-required');
  assert.equal(refused.store, 'attachments');
  assert.equal(refused.document, null);
  assert.equal(refused.summary, null);
  assert.match(refused.error, /conteúdo privado de cursos/);

  // Com o opt-in privado, mas SEM o opt-in de anexos, o arquivo sai sem bytes.
  const noBytes = await buildBackup({ library: source.library, store: source.store, attachments: source.attachments, includeCourseContent: true, now: clock() });
  assert.equal(noBytes.ok, true);
  assert.equal(noBytes.document.attachments.included, false);
  assert.equal(serializeBackup(noBytes.document).includes('dataBase64'), false);
});

test('privacidade: exportar não muta a biblioteca nem os cursos', async () => {
  const source = await world();
  const entriesBefore = JSON.parse(source.library.exportLibrary({ includeCourseContent: true })).entries;
  const coursesBefore = JSON.stringify(source.store.snapshotAll());

  const public_ = await buildBackup({ library: source.library, store: source.store, now: clock() });
  const private_ = await buildBackup({ library: source.library, store: source.store, includeCourseContent: true, now: clock() });

  assert.deepEqual(JSON.parse(source.library.exportLibrary({ includeCourseContent: true })).entries, entriesBefore);
  assert.equal(JSON.stringify(source.store.snapshotAll()), coursesBefore);
  assert.equal(public_.ok && private_.ok, true);
  // O público redige; o privado é o retrato fiel.
  assert.equal(namesOf(private_.document).includes('Exercício Antigo'), true);
  assert.equal(namesOf(public_.document).includes('Exercício Antigo'), false);
  assert.equal(summarizeBackup(private_.document).courseContent, 'included');
  assert.equal(summarizeBackup(public_.document).courseContent, 'omitted');
});
