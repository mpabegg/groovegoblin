// Motor de sincronização: detecção quieta, primeira conexão, envio em segundo
// plano, conflito com cópia, offline durável, recarga no meio do envio, lápide,
// porto sem suporte e anexos com liberação de bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerClient } from '../src/server-client.js';
import { createSyncOutbox } from '../src/sync-outbox.js';
import { createSyncState } from '../src/sync-store.js';
import { createSyncEngine, serverMarkerSays } from '../src/sync-engine.js';
import {
  createExerciseAdapter, createAttachmentAdapter, createShapesAdapter, createShapeBindingsAdapter,
  createTodayQueueAdapter, createRoutinesAdapter, createCourseAdapter, createCourseStateAdapter,
} from '../src/sync-adapters.js';
import { createTodayStore } from '../src/today-store.js';
import { createCourseStore } from '../src/course-store.js';
import { courseDocument, memoryBackend } from './course-fixtures.js';
import { RECOVERED_LIMIT } from '../src/sync-store.js';
import {
  startContractServer, createMemoryStorage, createFakeTimers, createFakeLibrary, createFakeAttachmentStore,
  createFakeShapeStore, createFakeBindingStore, createMemoryPort, fakeDocument, sha256Hex,
} from './sync-harness.js';

function exerciseBody(id, name, updatedAt = '2026-01-01T00:00:00.000Z') {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    session: { name, notes: [] },
    metadata: { name, tags: [], records: [] },
  };
}

async function makeEngine(t, { ports, serverOptions = {}, engineOptions = {}, clientFactory = null } = {}) {
  const server = await startContractServer(serverOptions);
  t.after(() => server.close());
  const storage = createMemoryStorage();
  const outbox = createSyncOutbox({ storage });
  const state = createSyncState({ storage });
  const realClient = createServerClient({ base: server.base, requestOrigin: server.origin });
  const client = clientFactory ? clientFactory(realClient) : realClient;
  const engine = createSyncEngine({
    client, ports, outbox, state,
    shouldProbe: () => true,
    timers: createFakeTimers(),
    ...engineOptions,
  });
  t.after(() => engine.stop());
  return { server, storage, outbox, state, engine, client, realClient };
}

// Cliente com "rede cortada": toda chamada devolve falha de rede, como o
// navegador faz quando o cabo cai — nada de exceção subindo.
function controllables(realClient) {
  const flags = { offline: false };
  const offlineResult = { ok: false, status: 0, code: 'network', message: 'Sem conexão.', offline: true };
  const wrap = name => (...args) => (flags.offline ? offlineResult : realClient[name](...args));
  return {
    flags,
    probe: () => (flags.offline ? { ok: false, mode: 'offline', code: 'offline', message: 'Sem conexão.' } : realClient.probe()),
    getDoc: wrap('getDoc'),
    putDoc: wrap('putDoc'),
    deleteDoc: wrap('deleteDoc'),
    changes: wrap('changes'),
    listDocs: wrap('listDocs'),
    headBlob: wrap('headBlob'),
    putBlob: wrap('putBlob'),
    deleteBlob: wrap('deleteBlob'),
    blobUrl: realClient.blobUrl,
  };
}

test('sem servidor não há requisição, nem aviso, e a linha continua honesta', async t => {
  let calls = 0;
  const server = await startContractServer();
  t.after(() => server.close());
  const client = createServerClient({
    base: server.base,
    fetch: async (...args) => { calls += 1; return fetch(...args); },
  });
  const library = createFakeLibrary();
  library.add();
  const engine = createSyncEngine({
    client,
    ports: [createExerciseAdapter(library)],
    outbox: createSyncOutbox({ storage: createMemoryStorage() }),
    state: createSyncState({ storage: createMemoryStorage() }),
    shouldProbe: () => false,
    timers: createFakeTimers(),
  });
  t.after(() => engine.stop());
  const snapshot = await engine.start();
  assert.equal(snapshot.mode, 'local');
  assert.deepEqual(snapshot.warnings, []);
  assert.equal(snapshot.pending, 0);
  assert.equal(calls, 0);
});

test('a sondagem segue o marcador do servidor e a evidência de sync anterior, nunca o endereço', async t => {
  const server = await startContractServer();
  t.after(() => server.close());
  let calls = 0;
  const client = createServerClient({
    base: server.base,
    fetch: async (...args) => { calls += 1; return fetch(...args); },
  });
  const make = (marker, storage = createMemoryStorage()) => createSyncEngine({
    client, ports: [],
    outbox: createSyncOutbox({ storage }),
    state: createSyncState({ storage }),
    document: fakeDocument(marker),
    timers: createFakeTimers(),
  });

  // Sem marcador (site estático, ou build anterior): nenhuma requisição.
  const plain = make(null);
  t.after(() => plain.stop());
  assert.equal((await plain.probe()).ok, false);
  assert.equal(calls, 0);
  // Marcador do servidor ('off'): idem.
  const off = make('off');
  t.after(() => off.stop());
  assert.equal((await off.probe()).ok, false);
  assert.equal(calls, 0);
  // Marcador ligado (a página veio do servidor com a API): sonda na abertura.
  const on = make('on');
  t.after(() => on.stop());
  const probed = await on.probe();
  assert.equal(probed.ok, true);
  assert.equal(calls, 1);
  // Já sincronizamos nesta origem: evidência guardada, sonda sem marcador.
  const storage = createMemoryStorage();
  const remembered = createSyncState({ storage });
  remembered.setServer({ dataId: 'aaaa1111aaaa1111', cursor: 'aaaa1111aaaa1111.1' });
  const previous = make(null, storage);
  t.after(() => previous.stop());
  assert.equal((await previous.probe()).ok, true);
  assert.equal(calls, 2);
});

test('marcador ausente, vazio, inválido ou inacessível nunca liga a sondagem', () => {
  assert.equal(serverMarkerSays(fakeDocument('on')), true);
  assert.equal(serverMarkerSays(fakeDocument('OFF')), false);
  assert.equal(serverMarkerSays(fakeDocument(null)), null);
  assert.equal(serverMarkerSays(fakeDocument('')), null);
  assert.equal(serverMarkerSays(fakeDocument('talvez')), false);
  assert.equal(serverMarkerSays(fakeDocument('throw')), null);
  assert.equal(serverMarkerSays(null), null);
});

test('apagar o ÚLTIMO documento de uma loja boa sobe como lápide', async t => {
  const port = createMemoryPort({ collection: 'exercises', id: 'unico', body: { v: 1 } });
  const { server, engine, state } = await makeEngine(t, { ports: [port] });
  await engine.start();
  await engine.syncNow();
  assert.equal(server.docs('exercises').get('unico').deleted, false);

  // A loja continua DISPONÍVEL e agora está vazia: isso é remoção, não falha.
  port.docs.clear();
  await engine.syncNow();

  assert.equal(server.docs('exercises').get('unico').deleted, true);
  assert.equal(state.revision('exercises', 'unico'), null);
  assert.equal(engine.snapshot().pending, 0);
});

test('loja indisponível fica de fora inteira: nem envia, nem apaga, e diz por quê', async t => {
  const port = createMemoryPort({ collection: 'exercises', id: 'unico', body: { v: 1 } });
  const { server, engine, state } = await makeEngine(t, { ports: [port] });
  await engine.start();
  await engine.syncNow();

  port.setAvailable(false);
  port.docs.clear();
  await engine.syncNow();

  assert.equal(server.docs('exercises').get('unico').deleted, false, 'loja ilegível não apaga o servidor');
  assert.equal(state.revision('exercises', 'unico'), server.docs('exercises').get('unico').rev);
  assert.deepEqual(engine.snapshot().degraded, ['exercises']);
  assert.ok(engine.snapshot().warnings.some(text => /não puderam ser lidos agora/.test(text)));

  // Voltando a ficar disponível e vazia, a lápide sobe.
  port.setAvailable(true);
  await engine.syncNow();
  assert.equal(server.docs('exercises').get('unico').deleted, true);
  assert.deepEqual(engine.snapshot().degraded, []);
});

test('formas e vínculos sincronizam pelos dois documentos da coleção `forms`', async t => {
  const shapes = createFakeShapeStore();
  const shape = { id: 'bass4-1', label: 'Maior · fundamental · Forma 1', quality: 'major', degrees: [1, 3, 5], notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }] };
  shapes.save(shape);
  const bindings = createFakeBindingStore();
  bindings.importDocument({ version: 1, bindings: [{ label: 'Shape 1', quality: 'maior', inversion: 'fundamental', shapeId: 'bass4-1' }] });

  const { server, engine } = await makeEngine(t, { ports: [createShapesAdapter(shapes), createShapeBindingsAdapter(bindings)] });
  await engine.start();
  await engine.syncNow();

  assert.deepEqual([...server.docs('forms').keys()].sort(), ['bindings', 'shapes']);
  assert.equal(server.docs('forms').get('shapes').body.instruments.bass4[0].id, 'bass4-1');
  assert.equal(server.docs('forms').get('bindings').body.bindings[0].shapeId, 'bass4-1');
  assert.equal(engine.snapshot().pending, 0);
  assert.equal(engine.snapshot().conflicts, 0);
});

test('varredura normal não apaga o documento vizinho da MESMA coleção (`forms`)', async t => {
  // Regressão: depois de os dois documentos de `forms` já terem revisão
  // guardada, a varredura de remoção de um porto apagava o documento do outro
  // (o vizinho não aparece na listagem dele e não estava em `seen`).
  const shapes = createFakeShapeStore();
  shapes.save({ id: 'bass4-1', label: 'Maior · fundamental · Forma 1', quality: 'major', degrees: [1, 3, 5], notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }] });
  const bindings = createFakeBindingStore();
  bindings.importDocument({ version: 1, bindings: [{ label: 'Shape 1', quality: 'maior', inversion: 'fundamental', shapeId: 'bass4-1' }] });

  const { server, engine } = await makeEngine(t, { ports: [createShapesAdapter(shapes), createShapeBindingsAdapter(bindings)] });
  await engine.start();
  await engine.syncNow();
  assert.deepEqual([...server.docs('forms').keys()].sort(), ['bindings', 'shapes']);

  // Ciclo normal (varredura → envio → trazer → varredura): nada pode ser
  // apagado só porque o outro porto não lista este documento.
  const summary = await engine.syncNow();
  assert.equal(summary.removed, 0);
  assert.deepEqual([...server.docs('forms').keys()].sort(), ['bindings', 'shapes']);
  assert.equal(server.docs('forms').get('shapes').deleted ?? false, false, 'as formas continuam no servidor');
  assert.equal(server.docs('forms').get('bindings').deleted ?? false, false, 'os vínculos continuam no servidor');
  assert.equal(engine.snapshot().pending, 0);
  assert.equal(engine.snapshot().conflicts, 0);
});

test('formas do servidor entram em UNIÃO e a união volta para o servidor', async t => {
  const shapes = createFakeShapeStore();
  shapes.save({ id: 'bass4-local', label: 'Menor · fundamental · Forma 1', quality: 'minor', degrees: [1, 3, 5], notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 3, degree: 3 }] });
  const other = { id: 'bass4-outro', label: 'Maior · 1ª inversão · Forma 1', quality: 'major', degrees: [3, 5, 1], notes: [{ string: 4, fret: 3, degree: 3 }, { string: 3, fret: 2, degree: 5 }] };

  const { server, engine } = await makeEngine(t, { ports: [createShapesAdapter(shapes)] });
  server.seed('forms', 'shapes', { version: 1, instruments: { bass4: [other] } });

  await engine.start();

  const saved = server.docs('forms').get('shapes').body;
  assert.deepEqual(saved.instruments.bass4.map(item => item.id).sort(), ['bass4-local', 'bass4-outro']);
  assert.equal(shapes.groups.bass4.length, 2);
  assert.equal(engine.snapshot().pending, 0);
  assert.equal(engine.snapshot().conflicts, 0);
});

test('outra vez: formas e vínculos não se atropelam quando uma das lojas está ilegível', async t => {
  const shapes = createFakeShapeStore();
  shapes.save({ id: 'bass4-1', label: 'Maior · fundamental · Forma 1', quality: 'major', degrees: [1, 3, 5], notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }] });
  const bindings = createFakeBindingStore();
  bindings.setStatus('corrupt');
  bindings.importDocument({ version: 1, bindings: [{ label: 'Shape 1', quality: 'maior', inversion: 'fundamental', shapeId: 'bass4-1' }] });

  const { server, engine } = await makeEngine(t, { ports: [createShapesAdapter(shapes), createShapeBindingsAdapter(bindings)] });
  await engine.start();
  await engine.syncNow();

  assert.deepEqual([...server.docs('forms').keys()], ['shapes'], 'os vínculos ilegíveis não vão para o servidor');
  assert.deepEqual(engine.snapshot().degraded, ['forms (bindings)']);
  assert.equal(server.docs('forms').get('shapes').body.instruments.bass4.length, 1);
});

test('primeira conexão com servidor vazio envia tudo sozinha, sem escolha', async t => {
  const library = createFakeLibrary();
  library.add({ id: 'ex-1', session: { name: 'Um', notes: [] }, metadata: { name: 'Um' } });
  library.add({ id: 'ex-2', session: { name: 'Dois', notes: [] }, metadata: { name: 'Dois' } });
  const { server, state, engine, outbox } = await makeEngine(t, { ports: [createExerciseAdapter(library)] });

  const started = await engine.start();
  assert.equal(started.mode, 'connected');
  assert.equal(state.firstSyncDone, true);
  assert.equal(outbox.count(), 0);
  assert.deepEqual([...server.docs('exercises').keys()].sort(), ['ex-1', 'ex-2']);
  assert.equal(server.docs('exercises').get('ex-1').body.session.name, 'Um');
});

test('primeira conexão interrompida não conta como feita e mescla no ciclo seguinte', async t => {
  const library = createFakeLibrary();
  library.add({ id: 'local-1', session: { name: 'Só aqui', notes: [] }, metadata: { name: 'Só aqui' } });
  let cut = null;
  const { server, state, engine } = await makeEngine(t, {
    ports: [createExerciseAdapter(library)],
    clientFactory: real => (cut = controllables(real)),
  });
  server.seed('exercises', 'server-1', exerciseBody('server-1', 'Só no servidor'));
  assert.equal((await engine.probe()).ok, true);
  cut.flags.offline = true;
  await engine.syncNow();
  assert.equal(state.firstSyncDone, false);
  assert.equal(server.docs('exercises').has('local-1'), false);

  cut.flags.offline = false;
  await engine.syncNow();
  assert.equal(state.firstSyncDone, true);
  assert.equal(library.get('server-1').session.name, 'Só no servidor');
  assert.equal(server.docs('exercises').get('local-1').body.session.name, 'Só aqui');
});

test('dois navegadores convergem: fila e rotinas não sobem de novo a cada ciclo', async t => {
  // Regressão: o documento carregava id e carimbos de tempo de CADA navegador e
  // a fusão reescrevia os locais, então o mesmo conteúdo virava bytes
  // diferentes nas duas máquinas e os documentos subiam para sempre (uma
  // revisão nova a cada ciclo, sem nenhuma mudança de conteúdo).
  const server = await startContractServer();
  t.after(() => server.close());
  let tick = Date.parse('2026-05-01T10:00:00.000Z');
  const device = label => {
    let seq = 0;
    const storage = createMemoryStorage();
    const today = createTodayStore({ storage, now: () => (tick += 1000), uuid: () => `${label}-${++seq}` });
    const outbox = createSyncOutbox({ storage });
    const state = createSyncState({ storage });
    const client = createServerClient({ base: server.base, requestOrigin: server.origin });
    const engine = createSyncEngine({
      client,
      ports: [createTodayQueueAdapter(today), createRoutinesAdapter(today)],
      outbox, state, shouldProbe: () => true, timers: createFakeTimers(),
    });
    t.after(() => engine.stop());
    return { today, engine };
  };
  const a = device('a');
  const b = device('b');
  a.today.addItem({ exerciseId: 'ex-1', durationMin: 12, name: 'Sessão sem título' });
  a.today.saveRoutine('Rotina sincronizada', a.today.items());

  await a.engine.start();
  await b.engine.start();

  const revisions = () => ['todayQueues', 'routines']
    .map(collection => [...server.docs(collection).entries()].map(([id, doc]) => `${id}:${doc.rev}${doc.deleted ? ' (lápide)' : ''}`).join(','))
    .join(' | ');

  await a.engine.syncNow();
  await b.engine.syncNow();
  const settled = revisions();
  for (let round = 0; round < 3; round += 1) {
    await a.engine.syncNow();
    await b.engine.syncNow();
  }
  assert.equal(revisions(), settled, 'o mesmo conteúdo não pode gerar revisão nova');
  assert.equal(a.engine.snapshot().pending, 0);
  assert.equal(b.engine.snapshot().pending, 0);
  assert.deepEqual(b.today.items().map(item => item.exerciseId), ['ex-1'], 'a fila chegou inteira no segundo navegador');
  assert.deepEqual(b.today.routines().map(routine => routine.name), ['Rotina sincronizada']);
  assert.equal(server.docs('todayQueues').get('default').body.items.length, 1, 'a fila é o conteúdo, não o envelope do navegador');
});

test('trazer o servidor para uma loja vazia preserva o id do documento', async t => {
  const library = createFakeLibrary();
  const { server, engine } = await makeEngine(t, { ports: [createExerciseAdapter(library)] });
  server.seed('exercises', 'ex-9', exerciseBody('ex-9', 'Do servidor'));

  const snapshot = await engine.start();
  assert.equal(snapshot.mode, 'connected');
  const entry = library.get('ex-9');
  assert.equal(entry.session.name, 'Do servidor');
  assert.equal(engine.snapshot().pending, 0);
});

test('os dois lados têm dados: a mesclagem não apaga nada e converge', async t => {
  const library = createFakeLibrary();
  library.add({ id: 'local-1', session: { name: 'Só aqui', notes: [] }, metadata: { name: 'Só aqui' } });
  const { server, engine, state } = await makeEngine(t, { ports: [createExerciseAdapter(library)] });
  server.seed('exercises', 'server-1', exerciseBody('server-1', 'Só no servidor'));

  await engine.start();
  assert.equal(engine.snapshot().summary.kind, 'merge');
  assert.equal(library.get('server-1').session.name, 'Só no servidor');
  assert.equal(server.docs('exercises').get('local-1').body.session.name, 'Só aqui');
  assert.equal(library.get('local-1').session.name, 'Só aqui');
  assert.equal(state.firstSyncDone, true);
  assert.equal(engine.snapshot().conflicts, 0);
  assert.equal(engine.snapshot().pending, 0);
});

test('alteração local sobe em segundo plano, sem repetir o documento', async t => {
  const library = createFakeLibrary();
  library.add({ id: 'ex-1', session: { name: 'Um', notes: [] }, metadata: { name: 'Um' } });
  const { server, engine, outbox } = await makeEngine(t, { ports: [createExerciseAdapter(library)] });
  await engine.start();
  await engine.syncNow();

  library.update('ex-1', { updatedAt: '2026-03-03T00:00:00.000Z', session: { name: 'Um editado', notes: [] } });
  engine.refreshLocalChanges();
  await engine.syncNow();

  assert.equal(server.docs('exercises').get('ex-1').body.session.name, 'Um editado');
  assert.equal(outbox.count(), 0);
  assert.equal(engine.snapshot().conflicts, 0);
  assert.equal(engine.snapshot().pending, 0);
});

test('revisão velha vira cópia em conflito: o servidor fica e a cópia local nunca se perde', async t => {
  const library = createFakeLibrary();
  library.add({ id: 'ex-1', session: { name: 'Original', notes: [] }, metadata: { name: 'Original' } });
  const { server, engine, state } = await makeEngine(t, { ports: [createExerciseAdapter(library)] });
  await engine.start();
  await engine.syncNow();

  // Os dois lados mudam: o servidor pelo outro navegador, o local pelo editor.
  server.seed('exercises', 'ex-1', exerciseBody('ex-1', 'Do servidor', '2026-04-04T00:00:00.000Z'));
  library.update('ex-1', { updatedAt: '2026-04-05T00:00:00.000Z', session: { name: 'Minha edição', notes: [] } });

  const synced = await engine.syncNow();
  assert.equal(synced.conflicts, 1);
  assert.equal(state.conflicts.length, 1);
  const conflict = state.conflicts[0];
  assert.equal(conflict.id, 'exercises|ex-1');
  assert.equal(conflict.localBody.session.name, 'Minha edição');
  assert.equal(conflict.serverBody.session.name, 'Do servidor');
  assert.equal(library.get('ex-1').session.name, 'Do servidor');

  // "Ficar com esta": a cópia do servidor é guardada antes de qualquer escrita.
  const resolved = await engine.resolveConflict(conflict.id, 'mine');
  assert.equal(resolved.side, 'mine');
  assert.equal(state.conflicts.length, 0);
  assert.equal(state.recovered.length, 1);
  assert.equal(state.recovered[0].side, 'server');
  assert.equal(state.recovered[0].body.session.name, 'Do servidor');
  assert.equal(server.docs('exercises').get('ex-1').body.session.name, 'Minha edição');
  assert.equal(library.get('ex-1').session.name, 'Minha edição');
});

test('"ficar com a outra" guarda a versão local e mantém a do servidor', async t => {
  const library = createFakeLibrary();
  library.add({ id: 'ex-1', session: { name: 'Original', notes: [] }, metadata: { name: 'Original' } });
  const { server, engine, state } = await makeEngine(t, { ports: [createExerciseAdapter(library)] });
  await engine.start();
  await engine.syncNow();
  server.seed('exercises', 'ex-1', exerciseBody('ex-1', 'Do servidor', '2026-05-05T00:00:00.000Z'));
  library.update('ex-1', { updatedAt: '2026-05-06T00:00:00.000Z', session: { name: 'Minha edição', notes: [] } });
  await engine.syncNow();
  const conflict = state.conflicts[0];

  const resolved = await engine.resolveConflict(conflict.id, 'server');
  assert.equal(resolved.side, 'server');
  assert.equal(state.conflicts.length, 0);
  assert.equal(state.recovered.at(-1).side, 'local');
  assert.equal(state.recovered.at(-1).body.session.name, 'Minha edição');
  assert.equal(library.get('ex-1').session.name, 'Do servidor');
  assert.match(engine.exportRecovered(), /Minha edição/);
});

test('rede cortada de verdade: fila guarda, recarregar não perde e a volta envia', async t => {
  const library = createFakeLibrary();
  library.add({ id: 'ex-1', session: { name: 'Um', notes: [] }, metadata: { name: 'Um' } });
  let controls = null;
  const { server, engine, outbox, storage } = await makeEngine(t, {
    ports: [createExerciseAdapter(library)],
    clientFactory: realClient => {
      controls = controllables(realClient);
      return controls;
    },
  });
  await engine.start();
  await engine.syncNow();
  assert.equal(server.docs('exercises').get('ex-1').body.session.name, 'Um');

  controls.flags.offline = true;
  library.update('ex-1', { updatedAt: '2026-06-06T00:00:00.000Z', session: { name: 'Escrito sem rede', notes: [] } });
  const offlineSync = await engine.syncNow();
  assert.equal(offlineSync.sent, 0);
  assert.equal(outbox.count(), 1);
  assert.equal(engine.snapshot().mode, 'offline');
  assert.equal(server.docs('exercises').get('ex-1').body.session.name, 'Um');

  // Recarga: outra fila e outro motor sobre o mesmo armazenamento.
  const reloadedOutbox = createSyncOutbox({ storage });
  assert.equal(reloadedOutbox.count(), 1);
  const reloadedState = createSyncState({ storage });
  const reloadedEngine = createSyncEngine({
    client: controls, ports: [createExerciseAdapter(library)], outbox: reloadedOutbox, state: reloadedState,
    location: undefined, shouldProbe: () => true, timers: createFakeTimers(),
  });
  t.after(() => reloadedEngine.stop());
  controls.flags.offline = false;
  await reloadedEngine.syncNow();
  assert.equal(server.docs('exercises').get('ex-1').body.session.name, 'Escrito sem rede');
  assert.equal(reloadedOutbox.count(), 0);
  assert.equal(reloadedEngine.snapshot().conflicts, 0);
  assert.equal(reloadedEngine.snapshot().mode, 'connected');
});

test('envio já aplicado no servidor (resposta perdida) não vira conflito', async t => {
  const library = createFakeLibrary();
  library.add({ id: 'ex-1', session: { name: 'Um', notes: [] }, metadata: { name: 'Um' } });
  const { server, engine, outbox, state } = await makeEngine(t, { ports: [createExerciseAdapter(library)] });
  await engine.start();
  await engine.syncNow();
  const body = server.docs('exercises').get('ex-1').body;

  // A fila ainda tem a criação que o servidor já recebeu.
  outbox.enqueue({ kind: 'doc-put', collection: 'exercises', docId: 'ex-1', body, baseRev: null, create: true });
  const flushed = await engine.flush();
  assert.equal(flushed.ok, true);
  assert.equal(state.conflicts.length, 0);
  assert.equal(outbox.count(), 0);
  assert.equal(state.revision('exercises', 'ex-1'), server.docs('exercises').get('ex-1').rev);
});

test('remoção local sobe como lápide e o documento some do servidor', async t => {
  const library = createFakeLibrary();
  library.add({ id: 'ex-1', session: { name: 'Um', notes: [] }, metadata: { name: 'Um' } });
  library.add({ id: 'ex-2', session: { name: 'Dois', notes: [] }, metadata: { name: 'Dois' } });
  const { server, engine, state } = await makeEngine(t, { ports: [createExerciseAdapter(library)] });
  await engine.start();
  await engine.syncNow();

  library.remove('ex-1');
  await engine.syncNow();

  assert.equal(server.docs('exercises').get('ex-1').deleted, true);
  assert.equal(state.revision('exercises', 'ex-1'), null);
  assert.equal(server.docs('exercises').get('ex-2').deleted, false);
  assert.equal(engine.snapshot().conflicts, 0);
});

test('lápide do servidor remove localmente, sem apagar o último exercício', async t => {
  const library = createFakeLibrary();
  library.add({ id: 'ex-1', session: { name: 'Um', notes: [] }, metadata: { name: 'Um' } });
  library.add({ id: 'ex-2', session: { name: 'Dois', notes: [] }, metadata: { name: 'Dois' } });
  const { server, engine } = await makeEngine(t, { ports: [createExerciseAdapter(library)] });
  await engine.start();
  await engine.syncNow();

  server.seed('exercises', 'ex-1', null, { deleted: true });
  await engine.pull();

  assert.equal(library.get('ex-1'), null);
  assert.deepEqual(library.entries().map(entry => entry.id), ['ex-2']);
  assert.equal(engine.snapshot().pending, 0);
  assert.equal(engine.snapshot().conflicts, 0);
});

test('porto sem suporte fica de fora inteiro, com aviso, e nada é enviado', async t => {
  const port = {
    collection: 'forms',
    supported: false,
    unsupportedReason: 'As formas entram quando o módulo existir.',
    async list() { return [{ id: 'f-1', body: { id: 'f-1' }, updatedAt: null }]; },
    async get() { return null; },
    async apply() { return { changed: false, body: null, skipped: 'unsupported' }; },
    async remove() { return { changed: false, skipped: 'unsupported' }; },
    subscribe() { return () => {}; },
  };
  const { server, engine } = await makeEngine(t, { ports: [port] });
  await engine.start();
  await engine.syncNow();
  assert.equal(server.docs('forms').size, 0);
  assert.ok(engine.snapshot().warnings.some(text => /formas/i.test(text)));
});

test('anexos: bytes sobem pelo hash, só são liberados depois de confirmados e nunca quando marcados offline', async t => {
  const attachments = createFakeAttachmentStore();
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const sha = sha256Hex(bytes);
  const key = JSON.stringify(['curso-1', 'aula-1', 'res-1']);
  attachments.putFile({ key, sha256: sha, bytes });

  const { server, engine, state } = await makeEngine(t, { ports: [createAttachmentAdapter(attachments)] });
  await engine.start();
  await engine.syncNow();

  const refsDoc = server.docs('courseAttachments').get('curso-1').body;
  assert.equal(refsDoc.refs[key].sha256, sha);
  assert.equal(refsDoc.refs[key].kind, 'pdf');
  assert.notEqual(server.blobBytes(sha), null);
  assert.equal(state.blobConfirmed(sha), true);
  assert.equal(attachments.files.size, 0, 'bytes liberados depois da confirmação');
  assert.equal(attachments.refs.size, 1, 'a referência continua');

  // Um material novo marcado "manter offline" continua no navegador.
  const extra = new Uint8Array([9, 9, 9, 9]);
  const extraSha = sha256Hex(extra);
  const extraKey = JSON.stringify(['curso-1', 'aula-2', 'res-2']);
  attachments.putFile({ key: extraKey, sha256: extraSha, bytes: extra, name: 'faixa.mp3', kind: 'audio' });
  engine.pinAttachment(extraSha, { name: 'faixa.mp3' });
  await engine.syncNow();

  assert.equal(state.blobConfirmed(extraSha), true);
  assert.equal(attachments.files.has(`sha256:${extraSha}`), true, 'marcado offline fica');
  assert.equal(server.docs('courseAttachments').get('curso-1').body.refs[extraKey].sha256, extraSha);
  assert.equal(engine.snapshot().pinned, 1);
});

test('referência remota entra sem bytes e o material passa a vir do servidor', async t => {
  const attachments = createFakeAttachmentStore();
  const { server, engine } = await makeEngine(t, { ports: [createAttachmentAdapter(attachments)] });
  const key = JSON.stringify(['curso-1', 'aula-1', 'res-1']);
  const sha = sha256Hex(new Uint8Array([4, 4, 4]));
  server.seedBlob(new Uint8Array([4, 4, 4]));
  server.seed('courseAttachments', 'curso-1', { refs: { [key]: { sha256: sha, size: 3, kind: 'pdf', name: 'apostila.pdf', addedAt: '2026-01-01T00:00:00.000Z' } } });

  await engine.start();
  assert.equal(attachments.get(key).fileId, `sha256:${sha}`);
  assert.equal(attachments.files.size, 0, 'nada é baixado sem o usuário pedir');
  assert.equal(engine.snapshot().pending, 0, 'o documento trazido do servidor não gera envio de volta');
  assert.equal(engine.snapshot().conflicts, 0);
});

test('primeira conexão sem clique: cursos do servidor chegam, dados locais sobem e o original local fica guardado', async t => {
  const library = createFakeLibrary();
  library.add({ id: 'local-1', session: { name: 'Só aqui', notes: [] }, metadata: { name: 'Só aqui' } });
  const store = createCourseStore({ backend: memoryBackend() });
  await store.ready();
  await store.importText(JSON.stringify(courseDocument()), { source: 'teste' });
  await store.setLessonState('curso-exemplo', 'aula-1', { watched: true, notes: 'anotação local' });
  const { server, state, engine } = await makeEngine(t, {
    ports: [createExerciseAdapter(library), createCourseAdapter(store), createCourseStateAdapter(store)],
  });
  // Estado criado em outro navegador para o MESMO curso.
  const other = createCourseStore({ backend: memoryBackend() });
  await other.ready();
  const revised = courseDocument({ title: 'Curso de Exemplo (revisto)' });
  await other.importText(JSON.stringify(revised), { source: 'teste' });
  await other.setLessonState('curso-exemplo', 'aula-2', { watched: true });
  server.seed('courses', 'curso-exemplo', revised);
  server.seed('courseStates', 'curso-exemplo', (await createCourseStateAdapter(other).get('curso-exemplo')).body);
  for (const id of ['curso-b', 'curso-c', 'curso-d']) server.seed('courses', id, courseDocument({ id, title: `Curso ${id}` }));
  server.seed('exercises', 'server-1', exerciseBody('server-1', 'Só no servidor'));

  await engine.start();
  assert.deepEqual(store.list().map(record => record.id).sort(), ['curso-b', 'curso-c', 'curso-d', 'curso-exemplo']);
  assert.equal(store.lessonState('curso-exemplo', 'aula-1').notes, 'anotação local', 'a anotação local fica');
  assert.equal(store.lessonState('curso-exemplo', 'aula-1').watched, true);
  assert.equal(store.lessonState('curso-exemplo', 'aula-2').watched, true, 'o progresso do servidor entra em união');
  const copies = state.recovered.filter(entry => entry.docId === 'curso-exemplo' && entry.side === 'local');
  assert.ok(copies.some(entry => entry.collection === 'courseStates' && entry.body.lessons['aula-1'].notes === 'anotação local'), 'o original local ficou baixável');
  assert.equal(library.get('server-1').session.name, 'Só no servidor');
  assert.equal(server.docs('exercises').get('local-1').body.session.name, 'Só aqui');
  assert.equal(server.docs('courseStates').get('curso-exemplo').body.lessons['aula-1'].notes, 'anotação local', 'a união subiu');
  assert.equal(state.firstSyncDone, true);

  // Curso novo depois: o ciclo periódico normal traz.
  server.seed('courses', 'curso-e', courseDocument({ id: 'curso-e', title: 'Curso E' }));
  await engine.syncNow();
  assert.ok(store.list().some(record => record.id === 'curso-e'));
});

test('sem espaço para a cópia local, a primeira mesclagem para sem sobrescrever nada', async t => {
  const port = createMemoryPort({ collection: 'preferences', id: 'default', body: { v: 'local' } });
  const { server, state, engine, outbox } = await makeEngine(t, { ports: [port] });
  server.seed('preferences', 'default', { v: 'servidor' });
  for (let index = 0; index < RECOVERED_LIMIT; index += 1) {
    state.addRecovered({ id: `antiga-${index}`, collection: 'exercises', docId: `x-${index}`, side: 'local', body: { index }, rev: null, deleted: false });
  }
  const serverRev = server.docs('preferences').get('default').rev;

  await engine.start();
  assert.deepEqual(port.docs.get('default'), { v: 'local' }, 'o original local não foi sobrescrito');
  assert.deepEqual(server.docs('preferences').get('default').body, { v: 'servidor' });
  assert.equal(server.docs('preferences').get('default').rev, serverRev, 'nada subiu');
  assert.equal(state.firstSyncDone, false);
  assert.equal(state.cursor, null);
  assert.equal(state.revision('preferences', 'default'), null);
  assert.equal(outbox.count(), 0);
  assert.ok(engine.snapshot().warnings.length > 0, 'o aviso de cópias cheias aparece');

  state.clearRecovered();
  await engine.syncNow();
  assert.equal(state.firstSyncDone, true);
  assert.ok(state.recovered.some(entry => entry.docId === 'default' && entry.side === 'local' && entry.body.v === 'local'), 'o original local ficou baixável');
  assert.equal(engine.snapshot().pending, 0);
});
