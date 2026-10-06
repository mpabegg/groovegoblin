// Adaptadores entre lojas locais e coleções do servidor: um documento por
// exercício/curso/estado, envelope canônico do curso, fila e rotinas, anexos
// com referência remota sem bytes e a lista explícita do que NÃO sincroniza.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExerciseAdapter, createCourseAdapter, createCourseStateAdapter, createAttachmentAdapter,
  createTodayQueueAdapter, createRoutinesAdapter, buildSyncPorts, createSha256, localFileSha,
  createShapesAdapter, createShapeBindingsAdapter, createPreferencesAdapter,
  EXCLUDED_LOCAL_KEYS, UNUSED_COLLECTIONS, SYNC_COLLECTIONS, SHAPES_DOC_ID, BINDINGS_DOC_ID, PREFERENCE_SECTIONS,
} from '../src/sync-adapters.js';
import { createFakeLibrary, createFakeAttachmentStore, createFakeShapeStore, createFakeBindingStore, createMemoryStorage, sha256Hex } from './sync-harness.js';

function createFakeCourseStore() {
  const courses = new Map();
  const states = new Map();
  const listeners = new Set();
  return {
    seed(id, course) {
      courses.set(id, { id, course, importedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', counts: { sections: 1, lessons: 1, exercises: 0 } });
    },
    seedState(state) { states.set(state.courseId, state); },
    list() { return [...courses.values()].map(record => ({ id: record.id, updatedAt: record.updatedAt })); },
    exportText(id) {
      const record = courses.get(id);
      if (!record) return { ok: false, error: 'Curso não encontrado.' };
      return { ok: true, text: JSON.stringify({ format: 'groovegoblin-course', version: 1, course: record.course }) };
    },
    async importText(text) {
      const document_ = JSON.parse(text);
      const id = document_.course.id;
      const created = !courses.has(id);
      courses.set(id, { id, course: document_.course, importedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z', counts: { sections: 1, lessons: 1, exercises: 0 } });
      return { ok: true, created, preserved: 0, restored: 0, removed: 0, counts: { sections: 1, lessons: 1, exercises: 0 } };
    },
    async removeCourse(id) { return courses.delete(id); },
    snapshotAll() {
      return { records: [...courses.values()], states: [...states.values()], orphans: [], corrupt: [] };
    },
    async importSnapshot(snapshot) {
      for (const state of snapshot.states ?? []) states.set(state.courseId, state);
      return { ok: true, report: {}, applied: { courses: [], states: (snapshot.states ?? []).map(state => state.courseId) } };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    has: id => courses.has(id),
    stateOf: id => states.get(id) ?? null,
  };
}

function createFakeToday({ queueId = 'q-1', queueCreatedAt = '2026-01-01T00:00:00.000Z' } = {}) {
  let queue = null;
  const routines = [];
  return {
    seedQueue(items) { queue = { id: queueId, createdAt: queueCreatedAt, updatedAt: queueCreatedAt, items }; },
    seedRoutine(routine) { routines.push({ ...routine }); },
    queue() { return queue ? JSON.parse(JSON.stringify(queue)) : null; },
    setItems(items) {
      queue = { id: queue?.id ?? queueId, createdAt: queue?.createdAt ?? queueCreatedAt, updatedAt: '2026-03-03T00:00:00.000Z', items: JSON.parse(JSON.stringify(items)) };
      return queue;
    },
    routines() { return JSON.parse(JSON.stringify(routines)); },
    saveRoutine(name, items) {
      const found = routines.find(routine => routine.name === name);
      if (found) { found.items = JSON.parse(JSON.stringify(items)); found.updatedAt = '2026-03-04T00:00:00.000Z'; return found; }
      const created = { id: `r-${routines.length + 1}`, name, createdAt: '2026-03-04T00:00:00.000Z', updatedAt: '2026-03-04T00:00:00.000Z', items: JSON.parse(JSON.stringify(items)) };
      routines.push(created);
      return created;
    },
    subscribe() { return () => {}; },
  };
}

test('um documento por exercício, com o id do exercício como id do documento', async () => {
  const library = createFakeLibrary();
  library.add({ id: 'ex-1', session: { name: 'Um', notes: [] }, metadata: { name: 'Um' } });
  const port = createExerciseAdapter(library);

  const documents = await port.list();
  assert.equal(documents.length, 1);
  assert.equal(documents[0].id, 'ex-1');
  assert.equal(documents[0].body.id, 'ex-1');
  assert.equal(documents[0].body.session.name, 'Um');
  assert.equal(documents[0].updatedAt, '2026-01-01T00:00:00.000Z');

  const applied = await port.apply({ id: 'ex-2', body: { id: 'ex-2', createdAt: 'c', updatedAt: 'u', session: { name: 'Do servidor', notes: [] }, metadata: { name: 'Do servidor' } } });
  assert.equal(applied.changed, true);
  assert.equal(applied.body.session.name, 'Do servidor');
  assert.equal(library.get('ex-2').id, 'ex-2');

  const removed = await port.remove('ex-2');
  assert.equal(removed.changed, true);
  const protectedLast = await port.remove('ex-1');
  assert.equal(protectedLast.changed, false);
  assert.equal(protectedLast.skipped, 'protected');
});

test('sem os métodos de sincronização, o adaptador se declara sem suporte', () => {
  const library = { get: () => null, list: () => [], exportLibrary: () => JSON.stringify({ entries: [] }) };
  const port = createExerciseAdapter(library);
  assert.equal(port.supported, false);
  assert.match(port.unsupportedReason, /patch da etapa 7/);
});

test('o corpo do curso é o envelope groovegoblin-course e aplicar é reimportar', async () => {
  const store = createFakeCourseStore();
  store.seed('curso-1', { id: 'curso-1', title: 'Curso de Exemplo', strings: 4 });
  const port = createCourseAdapter(store);

  const documents = await port.list();
  assert.equal(documents[0].id, 'curso-1');
  assert.equal(documents[0].body.format, 'groovegoblin-course');
  assert.equal(documents[0].body.version, 1);
  assert.equal(documents[0].body.course.id, 'curso-1');
  assert.equal(documents[0].body.progress, undefined);

  const applied = await port.apply({ id: 'curso-1', body: { format: 'groovegoblin-course', version: 1, course: { id: 'curso-1', title: 'Curso atualizado', strings: 4 } } });
  assert.equal(applied.changed, true);
  assert.equal(applied.body.course.title, 'Curso atualizado');

  const rejected = await port.apply({ id: 'curso-2', body: { format: 'groovegoblin-course', version: 1, course: { id: 'curso-1' } } });
  assert.equal(rejected.changed, false);
  assert.equal(rejected.skipped, 'invalid');

  assert.equal((await port.remove('curso-1')).changed, true);
  assert.equal(store.has('curso-1'), false);
});

test('o estado do curso viaja separado e nunca é apagado por lápide remota', async () => {
  const store = createFakeCourseStore();
  store.seedState({ courseId: 'curso-1', createdAt: 'c', updatedAt: 'u', activeLessonId: 'aula-1', preferences: { active: true, dailyMinutes: null }, lessons: {}, removed: [], watch: [] });
  const port = createCourseStateAdapter(store);

  const documents = await port.list();
  assert.equal(documents.length, 1);
  assert.equal(documents[0].id, 'curso-1');
  assert.equal(documents[0].body.activeLessonId, 'aula-1');

  const applied = await port.apply({ id: 'curso-1', body: { courseId: 'curso-1', createdAt: 'c', updatedAt: 'u2', activeLessonId: 'aula-2', preferences: { active: true, dailyMinutes: null }, lessons: {}, removed: [], watch: [] } });
  assert.equal(applied.changed, true);
  assert.equal(store.stateOf('curso-1').activeLessonId, 'aula-2');
  assert.equal((await port.remove('curso-1')).changed, false);
});

test('fila do dia é um documento só e as rotinas são a união por nome', async () => {
  const today = createFakeToday();
  today.seedQueue([{ id: 'i-1', kind: 'exercise', exerciseId: 'ex-1', durationMin: 5 }]);
  const queuePort = createTodayQueueAdapter(today);
  assert.equal(queuePort.singleton, true);
  assert.equal(queuePort.documentId, 'default');
  const queueDocs = await queuePort.list();
  assert.equal(queueDocs[0].id, 'default');
  assert.equal(queueDocs[0].body.items.length, 1);
  assert.deepEqual(Object.keys(queueDocs[0].body), ['version', 'items'], 'o documento é o conteúdo da fila: id e carimbos são do navegador');

  const appliedQueue = await queuePort.apply({ id: 'default', body: { version: 2, items: [{ id: 'i-2', kind: 'lesson', courseId: 'curso-1', lessonId: 'aula-1', durationMin: 30 }] } });
  assert.equal(appliedQueue.changed, true);
  assert.equal(today.queue().items[0].lessonId, 'aula-1');

  today.seedRoutine({ id: 'r-1', name: 'Aquecimento', createdAt: 'c', updatedAt: 'u', items: [{ id: 'i-1', kind: 'exercise', exerciseId: 'ex-1', durationMin: 5 }] });
  const routinesPort = createRoutinesAdapter(today);
  const routinesDocs = await routinesPort.list();
  assert.equal(routinesDocs[0].id, 'all');
  assert.equal(routinesDocs[0].body.routines.length, 1);
  assert.deepEqual(Object.keys(routinesDocs[0].body.routines[0]), ['name', 'items'], 'nome + itens: id e carimbos são de cada navegador');

  const appliedRoutines = await routinesPort.apply({ body: { version: 2, routines: [{ id: 'outro-id', name: 'Aquecimento', items: [{ id: 'i-9', kind: 'exercise', exerciseId: 'ex-9', durationMin: 10 }] }] } });
  assert.equal(appliedRoutines.changed, true);
  assert.equal(today.routines().length, 1, 'o nome é a identidade: não duplica');
  assert.equal(today.routines()[0].items[0].exerciseId, 'ex-9');
});

test('anexos: referência com sha256 do conteúdo e adoção remota sem bytes', async () => {
  const attachments = createFakeAttachmentStore();
  const bytes = new Uint8Array([3, 1, 4, 1, 5]);
  const sha = sha256Hex(bytes);
  const key = JSON.stringify(['curso-1', 'aula-1', 'res-1']);
  attachments.putFile({ key, sha256: sha, bytes });
  const port = createAttachmentAdapter(attachments);

  const documents = await port.list();
  assert.equal(documents[0].id, 'curso-1');
  const ref = documents[0].body.refs[key];
  assert.equal(ref.sha256, sha);
  assert.equal(ref.size, 5);
  assert.equal(ref.kind, 'pdf');
  assert.deepEqual(Object.keys(documents[0].body), ['refs'], 'o documento tem só `refs`, como combinado com o intake do servidor');

  const remoteKey = JSON.stringify(['curso-1', 'aula-2', 'res-2']);
  const applied = await port.apply({ id: 'curso-1', body: { refs: { [remoteKey]: { sha256: 'a'.repeat(64), size: 9, kind: 'audio', name: 'faixa.mp3', addedAt: 'x' } } } });
  assert.equal(applied.changed, true);
  assert.equal(attachments.get(remoteKey).fileId, `sha256:${'a'.repeat(64)}`);
  assert.equal(attachments.files.size, 1, 'referência remota não baixa bytes');
  const relisted = await port.list();
  assert.equal(relisted[0].body.refs[remoteKey].kind, 'audio', 'o tipo do material remoto fica na referência');
  assert.equal(relisted[0].body.refs[remoteKey].size, 9);

  const local = port.blobs.localIds();
  assert.equal(local.length, 2);
  const released = await port.blobs.release([sha], { confirmed: new Set([sha]), pinned: new Set() });
  assert.equal(released.released, 1);
  assert.equal(attachments.files.has(`sha256:${sha}`), false);
  assert.equal(attachments.get(key).fileId, `sha256:${sha}`, 'a referência continua apontando para o hash');

  // Regressão: liberar os bytes NÃO pode mudar o documento sincronizado (se
  // mudasse, o pull de outro navegador perderia nome, tamanho e tipo).
  const afterRelease = await port.list();
  assert.deepEqual(afterRelease[0].body.refs[key], ref);

  const kept = await port.blobs.release([sha], { confirmed: new Set(), pinned: new Set() });
  assert.equal(kept.released, 0, 'sem confirmação, os bytes não saem');
});

test('anexo com os mesmos bytes adota os campos do servidor e o documento não sobe de novo', async () => {
  // Regressão: com os mesmos bytes dos dois lados, o `addedAt` local ficava
  // diferente do que estava no servidor e o documento subia a cada ciclo.
  const attachments = createFakeAttachmentStore();
  const bytes = new Uint8Array([4, 2, 0]);
  const sha = sha256Hex(bytes);
  const key = JSON.stringify(['curso-1', 'aula-1', 'res-1']);
  attachments.putFile({ key, sha256: sha, bytes, name: 'antigo.pdf' });
  const port = createAttachmentAdapter(attachments);

  const remote = { refs: { [key]: { sha256: sha, size: 3, kind: 'pdf', name: 'novo.pdf', addedAt: '2026-02-02T00:00:00.000Z' } } };
  const applied = await port.apply({ id: 'curso-1', body: remote });
  assert.equal(applied.changed, true);
  const after = (await port.list())[0].body;
  assert.deepEqual(after, remote, 'os campos do documento convergem para os do servidor');
  assert.equal(attachments.files.size, 1, 'os bytes locais continuam aqui: nada é baixado nem liberado');

  const again = await port.apply({ id: 'curso-1', body: remote });
  assert.equal(again.changed, false, 'aplicar de novo não muda mais nada');
  assert.deepEqual((await port.list())[0].body, remote);
});

test('sem sha no identificador local, o adaptador calcula o hash do conteúdo', async () => {
  const attachments = createFakeAttachmentStore();
  const bytes = new Uint8Array([9, 8, 7]);
  const sha = sha256Hex(bytes);
  const key = JSON.stringify(['curso-1', 'aula-1', 'res-1']);
  attachments.refs.set(key, {
    key, courseId: 'curso-1', lessonId: 'aula-1', resourceId: 'res-1',
    fileId: 'local:sem-hash', name: 'material.pdf', extension: 'pdf', role: null,
    source: 'upload', addedAt: 'x', verified: true, warning: null,
  });
  attachments.files.set('local:sem-hash', { id: 'local:sem-hash', size: bytes.length, kind: 'pdf', name: 'material.pdf', blob: new Blob([bytes]) });

  const port = createAttachmentAdapter(attachments);
  const documents = await port.list();
  assert.equal(documents[0].body.refs[key].sha256, sha);
  assert.equal(localFileSha('sha256:abc'), null);
  assert.equal(await createSha256()(bytes), sha);
});

test('a lista do que não sincroniza é explícita e o servidor não recebe coleção repetida', () => {
  const keys = EXCLUDED_LOCAL_KEYS.map(entry => entry.key);
  for (const key of ['groovegoblin.input.v1', 'groovegoblin.input-calibration.v1', 'groovegoblin.studio.track-layout.v1', 'groovegoblin.repertoire.ui.v1']) {
    assert.ok(keys.includes(key), `${key} precisa estar fora da sincronização`);
  }
  // O que ficou de fora por ser de outra etapa/conteúdo, não por esquecimento.
  assert.ok(keys.includes('groovegoblin.session.v2'));
  assert.ok(keys.includes('groovegoblin.playground.v1'));
  assert.equal(Object.keys(UNUSED_COLLECTIONS).length, 0, 'nenhuma coleção do servidor fica sem uso nesta etapa');

  const library = createFakeLibrary();
  const ports = buildSyncPorts({ library });
  assert.deepEqual(ports.map(port => port.collection), [SYNC_COLLECTIONS.exercises]);
  assert.throws(() => buildSyncPorts({ library, extras: [createExerciseAdapter(library)] }), /repetida/);

  const extras = [{ collection: 'forms', async list() { return []; }, async get() { return null; }, async apply() { return { changed: false }; }, async remove() { return { changed: false }; }, subscribe() { return () => {}; } }];
  assert.deepEqual(buildSyncPorts({ library, extras }).map(port => port.collection), ['exercises', 'forms']);
});

test('formas: o documento é o exportDocument da loja e aplicar é união', async () => {
  const shapes = createFakeShapeStore();
  const shape = { id: 'bass4-1', label: 'Maior · fundamental · Forma 1', quality: 'major', degrees: [1, 3, 5], notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }] };
  shapes.save(shape);
  const port = createShapesAdapter(shapes);

  assert.equal(port.documentId, SHAPES_DOC_ID);
  assert.equal(port.owns(SHAPES_DOC_ID), true);
  assert.equal(port.owns(BINDINGS_DOC_ID), false);
  assert.equal(port.available(), true);
  const documents = await port.list();
  assert.equal(documents.length, 1);
  assert.deepEqual(Object.keys(documents[0].body).sort(), ['instruments', 'version']);
  assert.equal(documents[0].body.instruments.bass4[0].id, 'bass4-1');

  const remote = { id: 'bass4-2', label: 'Menor · fundamental · Forma 1', quality: 'minor', degrees: [1, 3, 5], notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 3, degree: 3 }] };
  const applied = await port.apply({ id: SHAPES_DOC_ID, body: { version: 1, instruments: { bass4: [remote] } } });
  assert.equal(applied.changed, true);
  assert.deepEqual(shapes.groups.bass4.map(item => item.id), ['bass4-1', 'bass4-2']);

  // Reaplicar o mesmo documento não muda nada (união idempotente).
  const again = await port.apply({ id: SHAPES_DOC_ID, body: { version: 1, instruments: { bass4: [remote] } } });
  assert.equal(again.changed, false);
  assert.equal(shapes.groups.bass4.length, 2);

  // Lápide remota não apaga as formas do usuário.
  assert.deepEqual(await port.remove(SHAPES_DOC_ID), { changed: false, skipped: 'protected' });
  assert.equal(shapes.groups.bass4.length, 2);

  // Loja ilegível: fora da lista e recusa aplicar.
  shapes.setStatus('corrupt');
  assert.equal(port.available(), false);
  assert.deepEqual(await port.list(), []);
  assert.equal((await port.apply({ id: SHAPES_DOC_ID, body: { version: 1, instruments: {} } })).skipped, 'unavailable');
});

test('vínculos de forma: documento próprio na MESMA coleção, união que respeita a escolha local', async () => {
  const bindings = createFakeBindingStore();
  bindings.importDocument({ version: 1, bindings: [{ label: 'Shape 1', quality: 'maior', inversion: 'fundamental', shapeId: 'bass4-1' }] });
  const port = createShapeBindingsAdapter(bindings);

  assert.equal(port.collection, SYNC_COLLECTIONS.forms);
  assert.equal(port.documentId, BINDINGS_DOC_ID);
  assert.equal(port.owns(BINDINGS_DOC_ID), true);
  const documents = await port.list();
  assert.deepEqual(Object.keys(documents[0].body).sort(), ['bindings', 'version']);

  const applied = await port.apply({
    id: BINDINGS_DOC_ID,
    body: { version: 1, bindings: [{ label: 'Shape 2', quality: 'menor', inversion: 'fundamental', shapeId: 'bass4-9' }] },
  });
  assert.equal(applied.changed, true);
  const exported = bindings.exportDocument();
  assert.deepEqual(exported.bindings.map(binding => binding.label), ['Shape 1', 'Shape 2']);

  // O vínculo que já existia no navegador não é trocado pelo do servidor.
  await port.apply({ id: BINDINGS_DOC_ID, body: { version: 1, bindings: [{ label: 'Shape 1', quality: 'maior', inversion: 'fundamental', shapeId: 'outra-forma' }] } });
  assert.equal(bindings.exportDocument().bindings[0].shapeId, 'bass4-1');
});

test('formas e vínculos convivem na coleção `forms` sem disputar documento', () => {
  const shapes = createFakeShapeStore();
  const bindings = createFakeBindingStore();
  const ports = buildSyncPorts({ shapes, bindings });
  assert.deepEqual(ports.map(port => port.collection), [SYNC_COLLECTIONS.forms, SYNC_COLLECTIONS.forms]);
  assert.deepEqual(ports.map(port => port.documentId), [SHAPES_DOC_ID, BINDINGS_DOC_ID]);
  assert.throws(() => buildSyncPorts({ shapes, bindings, extras: [createShapesAdapter(shapes)] }), /Documento repetido/);
});

test('preferências: allowlist explícito de campos, nunca o armazenamento inteiro', async () => {
  const storage = createMemoryStorage();
  storage.setItem('groovegoblin.practice.v1', JSON.stringify({
    version: 1,
    objective: 'timing',
    routine: { stages: ['listen', 'imitate'], listenRepetitions: 2, memorizeSilentBars: 2, adaptiveTempo: true },
    skills: { timing: 3 },
    history: [{ id: 'h-1' }],
    extra: 'fica',
  }));
  storage.setItem('groovegoblin.transport', JSON.stringify({ countInBars: 1, accelerator: { enabled: true }, mixer: 'fica' }));
  storage.setItem('groovegoblin.input.v1', JSON.stringify({ deviceId: 'aparelho' }));
  storage.setItem('groovegoblin.studio.track-layout.v1', JSON.stringify({ rows: 3 }));

  const port = createPreferencesAdapter({ storage });
  assert.equal(port.collection, SYNC_COLLECTIONS.preferences);
  assert.equal(port.available(), true);
  assert.deepEqual(PREFERENCE_SECTIONS.map(section => section.id), ['practice', 'transport']);

  const documents = await port.list();
  assert.equal(documents.length, 1);
  assert.deepEqual(documents[0].body, {
    version: 1,
    practice: { objective: 'timing', routine: { stages: ['listen', 'imitate'], listenRepetitions: 2, memorizeSilentBars: 2, adaptiveTempo: true } },
    transport: { countInBars: 1, accelerator: { enabled: true } },
  }, 'histórico, habilidades, mixer, dispositivo e layout ficam de fora');

  const applied = await port.apply({
    id: 'default',
    body: {
      version: 1,
      practice: { objective: 'pitch', routine: { stages: ['listen'], listenRepetitions: 3, memorizeSilentBars: 1, adaptiveTempo: false }, skills: { timing: 99 } },
      transport: { countInBars: 2, accelerator: { enabled: false }, mixer: 'não escreve' },
      machine: { deviceId: 'não escreve' },
    },
  });
  assert.equal(applied.changed, true);
  const practice = JSON.parse(storage.getItem('groovegoblin.practice.v1'));
  assert.equal(practice.objective, 'pitch');
  assert.equal(practice.routine.listenRepetitions, 3);
  assert.deepEqual(practice.skills, { timing: 3 }, 'o campo fora do allowlist não é escrito');
  assert.deepEqual(practice.history, [{ id: 'h-1' }]);
  assert.equal(practice.extra, 'fica');
  const transport = JSON.parse(storage.getItem('groovegoblin.transport'));
  assert.equal(transport.countInBars, 2);
  assert.equal(transport.mixer, 'fica', 'campo fora do allowlist preservado');
  assert.deepEqual(JSON.parse(storage.getItem('groovegoblin.input.v1')), { deviceId: 'aparelho' });
  assert.deepEqual(JSON.parse(storage.getItem('groovegoblin.studio.track-layout.v1')), { rows: 3 });

  // JSON ilegível não é sobrescrito.
  storage.setItem('groovegoblin.transport', '{quebrado');
  const refused = await port.apply({ id: 'default', body: { version: 1, transport: { countInBars: 9 } } });
  assert.equal(refused.changed, false);
  assert.equal(storage.getItem('groovegoblin.transport'), '{quebrado');
});

test('o documento do outro navegador não muda os nossos bytes: id e carimbos não viajam', async () => {
  // O que faz um documento subir para sempre é o MESMO conteúdo virar bytes
  // diferentes em cada navegador. Aqui os dois lados têm conteúdo idêntico e
  // identidade/carimbos próprios: depois de aplicar o documento do outro, os
  // bytes têm de ser os mesmos dos dois lados.
  const a = createFakeToday({ queueId: 'q-a', queueCreatedAt: '2026-01-01T00:00:00.000Z' });
  const b = createFakeToday({ queueId: 'q-b', queueCreatedAt: '2026-02-02T00:00:00.000Z' });
  a.seedQueue([{ id: 'i-1', kind: 'exercise', exerciseId: 'ex-1', durationMin: 12 }]);
  a.seedRoutine({ id: 'r-a', name: 'Aquecimento', createdAt: 'c-a', updatedAt: 'u-a', items: [{ id: 'i-1', kind: 'exercise', exerciseId: 'ex-1', durationMin: 12 }] });
  b.seedQueue([{ id: 'i-1', kind: 'exercise', exerciseId: 'ex-1', durationMin: 12 }]);
  b.seedRoutine({ id: 'r-b', name: 'Aquecimento', createdAt: 'c-b', updatedAt: 'u-b', items: [{ id: 'i-1', kind: 'exercise', exerciseId: 'ex-1', durationMin: 12 }] });

  const queueA = createTodayQueueAdapter(a);
  const queueB = createTodayQueueAdapter(b);
  const routinesA = createRoutinesAdapter(a);
  const routinesB = createRoutinesAdapter(b);

  const queueBodyA = (await queueA.list())[0].body;
  const queueBodyB = (await queueB.list())[0].body;
  assert.deepEqual(queueBodyA, queueBodyB, 'fila igual → bytes iguais (id/carimbos ficam de fora)');
  const routinesBodyA = (await routinesA.list())[0].body;
  const routinesBodyB = (await routinesB.list())[0].body;
  assert.deepEqual(routinesBodyA, routinesBodyB, 'rotina igual → bytes iguais (nome + itens)');

  // Aplicar o do outro lado não muda os nossos bytes (é o que impede o
  // documento de subir a cada ciclo).
  await queueB.apply({ id: 'default', body: queueBodyA });
  await routinesB.apply({ body: routinesBodyA });
  assert.deepEqual((await queueB.list())[0].body, queueBodyA);
  assert.deepEqual((await routinesB.list())[0].body, routinesBodyA);

  // Estado do curso: createdAt/updatedAt (do estado e de cada aula) são de cada
  // navegador; o progresso é o mesmo.
  const storeA = createFakeCourseStore();
  const storeB = createFakeCourseStore();
  const state = (createdAt, updatedAt, lessonUpdatedAt) => ({
    courseId: 'curso-1', createdAt, updatedAt, activeLessonId: 'aula-1',
    preferences: { active: true, dailyMinutes: null },
    lessons: { 'aula-1': { watched: true, skipped: false, completionOverride: null, notes: 'oi', linkedExerciseIds: [], generatedSuggestionIds: [], updatedAt: lessonUpdatedAt } },
    removed: [], watch: [],
  });
  storeA.seedState(state('c-a', 'u-a', 'l-a'));
  storeB.seedState(state('c-b', 'u-b', 'l-b'));
  const stateA = createCourseStateAdapter(storeA);
  const stateB = createCourseStateAdapter(storeB);
  const stateBodyA = (await stateA.list())[0].body;
  const stateBodyB = (await stateB.list())[0].body;
  assert.deepEqual(stateBodyA, stateBodyB, 'progresso igual → bytes iguais');
  assert.equal(stateBodyA.lessons['aula-1'].notes, 'oi', 'o progresso continua no documento');
  await stateB.apply({ id: 'curso-1', body: stateBodyA });
  assert.deepEqual((await stateB.list())[0].body, stateBodyA);
});

test('preferências sem armazenamento legível não se declaram disponíveis', async () => {
  const broken = { getItem() { throw new Error('sem acesso'); }, setItem() {} };
  const port = createPreferencesAdapter({ storage: broken });
  assert.equal(port.available(), false);
  assert.deepEqual(await port.list(), []);
  assert.equal((await port.apply({ id: 'default', body: { version: 1, transport: { countInBars: 1 } } })).skipped, 'unavailable');
});

