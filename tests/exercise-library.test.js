import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, parseSession, serializeSession, SESSION_NAME_MAX } from '../src/session.js';
import {
  captureLegacyBackup, createExerciseLibrary, summarize, materialKey,
  LIBRARY_KEY, LIBRARY_BACKUP_KEY, LIBRARY_RECOVERY_KEY,
  LEGACY_SESSION_KEY, LEGACY_SESSION_RECOVERY_KEY, LEGACY_PHRASE_KEY,
  LEGACY_PREFERENCES_KEY, LEGACY_MIXER_KEY,
} from '../src/exercise-library.js';
import { SESSION_LIBRARY_KEY } from '../src/studio-state.js';
import { History } from '../src/history.js';
import { memoryStorage } from './storage-fixture.js';

function clockNow() {
  let time = Date.UTC(2026, 0, 1, 12, 0, 0);
  return () => new Date(time += 1000).toISOString();
}

let idCount = 0;
function nextUuid() { return `ex-${++idCount}`; }

function open(storage, currentSession) {
  return createExerciseLibrary({
    storage, parse: parseSession, serialize: serializeSession,
    currentSession, now: clockNow(), uuid: nextUuid,
  });
}

function legacyEntry(id, savedAt, session) {
  return { id, savedAt, session };
}

// ----- backup ----------------------------------------------------------------

test('backup captura todo o estado legado cru, uma única vez, sem sobrescrever', () => {
  const storage = memoryStorage(new Map([
    [LEGACY_SESSION_KEY, '{"version":2,"raw":"sessao"}'],
    [LEGACY_SESSION_RECOVERY_KEY, '{"corrompido":true}'],
    [LEGACY_PHRASE_KEY, '{"v1":true}'],
    [LEGACY_PREFERENCES_KEY, '{"tom":"C"}'],
    [LEGACY_MIXER_KEY, '{"phrase":{"volume":1}}'],
    [SESSION_LIBRARY_KEY, '[{"id":"a"}]'],
  ]));
  const first = captureLegacyBackup(storage);
  assert.equal(first.created, true);
  const snapshot = JSON.parse(first.raw);
  assert.equal(snapshot.kind, 'groovegoblin-exercise-backup');
  assert.equal(snapshot.keys[LEGACY_SESSION_KEY], '{"version":2,"raw":"sessao"}');
  assert.equal(snapshot.keys[LEGACY_SESSION_RECOVERY_KEY], '{"corrompido":true}');
  assert.equal(snapshot.keys[LEGACY_PHRASE_KEY], '{"v1":true}');
  assert.equal(snapshot.keys[LEGACY_PREFERENCES_KEY], '{"tom":"C"}');
  assert.equal(snapshot.keys[LEGACY_MIXER_KEY], '{"phrase":{"volume":1}}');
  assert.equal(snapshot.keys[SESSION_LIBRARY_KEY], '[{"id":"a"}]');
  // Legado permanece intacto.
  assert.equal(storage.getItem(LEGACY_SESSION_KEY), '{"version":2,"raw":"sessao"}');
  // Segunda chamada não reescreve o backup já existente.
  storage.setItem(LEGACY_SESSION_KEY, '{"version":2,"raw":"alterado"}');
  const second = captureLegacyBackup(storage);
  assert.equal(second.created, false);
  assert.equal(second.reason, 'exists');
  assert.equal(second.raw, first.raw);
});

test('backup vazio não cria chave', () => {
  const storage = memoryStorage();
  const result = captureLegacyBackup(storage);
  assert.equal(result.created, false);
  assert.equal(result.reason, 'empty');
  assert.equal(storage.getItem(LIBRARY_BACKUP_KEY), null);
});

// ----- migração e deduplicação ----------------------------------------------

test('migra sessão atual + sessões antigas deduplicando sessões idênticas', () => {
  const current = createSession({ name: 'Atual', bpm: 100, bars: 4 });
  const other = createSession({ name: 'Antiga B', bpm: 90, bars: 2 });
  const third = createSession({ name: 'Antiga C', bpm: 80, bars: 1 });
  const storage = memoryStorage(new Map([
    [SESSION_LIBRARY_KEY, JSON.stringify([
      legacyEntry('old-a', '2026-01-01T00:00:00.000Z', current), // duplicata da atual
      legacyEntry('old-b', '2026-01-02T00:00:00.000Z', other),
      legacyEntry('old-c', '2026-01-03T00:00:00.000Z', third),
    ])],
  ]));
  const library = open(storage, current);
  assert.equal(library.size(), 3);
  assert.equal(library.warning, null);
  const rows = library.list();
  assert.deepEqual(rows.map(row => row.name).sort(), ['Antiga B', 'Antiga C', 'Atual']);
  // O exercício ativo é a sessão atual; a duplicata não criou entrada nova.
  assert.equal(library.get(library.active()).metadata.name, 'Atual');
  // Legado nunca é alterado.
  assert.match(storage.getItem(SESSION_LIBRARY_KEY), /old-a/);
  // A loja nova é canônica e persistida.
  const stored = JSON.parse(storage.getItem(LIBRARY_KEY));
  assert.equal(stored.entries.length, 3);
  assert.equal(stored.activeId, library.active());
});

test('biblioteca antiga corrompida preserva bytes e avisa sem perder a sessão atual', () => {
  const current = createSession({ name: 'Atual', bpm: 100 });
  const raw = '[{"id":42}]';
  const storage = memoryStorage(new Map([[SESSION_LIBRARY_KEY, raw]]));
  const library = open(storage, current);
  assert.equal(library.size(), 1);
  assert.match(library.warning, /corrompida|preservados/i);
  assert.equal(storage.getItem(SESSION_LIBRARY_KEY), raw);
});

// ----- corrupção e quota -----------------------------------------------------

test('loja nova corrompida nunca é sobrescrita e recupera só após backup preservado', () => {
  const current = createSession({ name: 'Atual', bpm: 100 });
  const corrupt = '{nao é json';
  const storage = memoryStorage(new Map([[LIBRARY_KEY, corrupt]]));
  const library = open(storage, current);
  assert.equal(library.status, 'corrupt');
  assert.equal(library.recoveryRaw, corrupt);
  assert.equal(storage.getItem(LIBRARY_KEY), corrupt);
  assert.equal(storage.getItem(LIBRARY_RECOVERY_KEY), corrupt);
  // Estado em memória foi reconstruído a partir do legado, mas nada é gravado.
  assert.equal(library.size(), 1);
  library.autosave(createSession({ name: 'Editado', bpm: 110 }));
  assert.equal(library.saved, false);
  assert.equal(storage.getItem(LIBRARY_KEY), corrupt);
  // Recuperação explícita grava a loja nova, mantendo os bytes corrompidos.
  assert.equal(library.replaceCorrupt(), true);
  assert.equal(library.status, 'ready');
  const stored = JSON.parse(storage.getItem(LIBRARY_KEY));
  assert.equal(stored.entries.length, 1);
  assert.equal(stored.entries[0].metadata.name, 'Editado');
  assert.equal(storage.getItem(LIBRARY_RECOVERY_KEY), corrupt);
});

test('quota negada mantém o trabalho na memória e nunca perde dados', () => {
  const current = createSession({ name: 'Atual', bpm: 100 });
  const storage = memoryStorage();
  const realSet = storage.setItem;
  storage.setItem = (key, value) => { if (key === LIBRARY_KEY) throw new Error('QuotaExceededError'); realSet(key, value); };
  const library = open(storage, current);
  assert.equal(library.status, 'ready');
  assert.equal(library.saved, false);
  assert.match(library.warning, /memória|salva/i);
  assert.equal(storage.getItem(LIBRARY_KEY), null);
  library.autosave(createSession({ name: 'Editado', bpm: 115 }));
  assert.equal(library.get(library.active()).metadata.name, 'Editado');
  assert.equal(library.get(library.active()).session.bpm, 115);
});

// ----- ida e volta / sem sobrescrita ----------------------------------------

test('exporta e importa um exercício com metadados, alvo e treinos sem sobrescrever', () => {
  const session = createSession({ name: 'Escala', bpm: 100, bars: 2 });
  const source = open(memoryStorage(), session);
  const id = source.active();
  source.updateMetadata(id, { name: 'Escala maior', tags: ['escala', 'aquecimento'], targetBPM: 140, notes: 'Subir por graus' });
  const context = source.captureRunContext(source.get(id).session, { source: 'authored', objective: 'timing' });
  source.recordRun(context, { bpm: 100, mode: 'train', goal: 'timing', repetitions: 2, summary: { mode: 'strict', expected: 16, attackOk: 15, endOk: 14, pitchOk: 0, pitchChecked: 0, free: 0 }, metric: 0.9375, tempoDelta: 0 });
  const exported = source.exportExercise(id);

  const target = open(memoryStorage(), createSession({ name: 'Outra', bpm: 90 }));
  const first = target.importExercise(exported);
  assert.deepEqual(first, { added: 1, skipped: 0 });
  const imported = target.list().find(row => row.name === 'Escala maior');
  assert.ok(imported);
  assert.deepEqual(target.get(imported.id).metadata.tags, ['escala', 'aquecimento']);
  assert.equal(target.get(imported.id).metadata.targetBPM, 140);
  assert.equal(target.get(imported.id).metadata.notes, 'Subir por graus');
  assert.equal(target.get(imported.id).metadata.records.length, 1);
  assert.equal(target.get(imported.id).metadata.records[0].summary.expected, 16);
  // Reimportar não sobrescreve nem duplica.
  const again = target.importExercise(exported);
  assert.deepEqual(again, { added: 0, skipped: 1 });
  assert.equal(target.list().filter(row => row.name === 'Escala maior').length, 1);
});

test('importa documento de sessão legado (v2) como novo exercício', () => {
  const legacy = serializeSession(createSession({ name: 'Legado', bpm: 88, bars: 2 }));
  const target = open(memoryStorage(), createSession({ name: 'Base', bpm: 100 }));
  const result = target.importExercise(legacy);
  assert.deepEqual(result, { added: 1, skipped: 0 });
  assert.ok(target.list().some(row => row.name === 'Legado'));
});

test('importa biblioteca inteira mesclando sem sobrescrever', () => {
  const a = open(memoryStorage(), createSession({ name: 'A', bpm: 100 }));
  a.duplicate(a.active());
  const b = open(memoryStorage(), createSession({ name: 'B', bpm: 100 }));
  const result = b.importLibrary(a.exportLibrary());
  assert.equal(result.added, 2);
  assert.equal(b.size(), 3);
  const repeat = b.importLibrary(a.exportLibrary());
  assert.deepEqual(repeat, { added: 0, skipped: 2 });
});

// ----- dono e início capturados no começo -----------------------------------

test('treino registra no dono capturado no início, não no ativo ao terminar', () => {
  const library = open(memoryStorage(), createSession({ name: 'Primeiro', bpm: 100 }));
  const firstId = library.active();
  const before = JSON.stringify(library.get(firstId).session);
  const context = library.captureRunContext(library.get(firstId).session, { source: 'authored', objective: 'timing' });
  const second = library.duplicate(firstId); // duplicar não troca o ativo
  assert.equal(library.active(), firstId);
  library.select(second.id); // o usuário troca de exercício antes de concluir
  const record = library.recordRun(context, { bpm: 100, mode: 'train', goal: 'timing', repetitions: 1, summary: { mode: 'strict', expected: 8, attackOk: 8, endOk: 8, pitchOk: 0, pitchChecked: 0, free: 0 }, metric: 1 });
  assert.equal(record.ownerId, firstId);
  assert.equal(library.records(firstId).length, 1);
  assert.equal(library.records(second.id).length, 0);
  // A sessão autoral nunca é reescrita pelo registro.
  assert.equal(JSON.stringify(library.get(firstId).session), before);
  // Início e fim reais ficam gravados, não deduzidos do último ataque.
  assert.ok(Date.parse(record.startedAt) < Date.parse(record.completedAt));
  assert.ok(record.durationMs > 0);
});

test('modo livre não entra no melhor resultado e mantém denominador explícito', () => {
  const library = open(memoryStorage(), createSession({ name: 'Livre', bpm: 100 }));
  const id = library.active();
  const context = library.captureRunContext(library.get(id).session, { source: 'generated', objective: 'timing' });
  library.recordRun(context, { bpm: 100, mode: 'train', goal: 'timing', repetitions: 1, summary: { mode: 'free', expected: 0, attackOk: 3, endOk: 0, pitchOk: 0, pitchChecked: 0, free: 3 } });
  const record = library.records(id)[0];
  assert.equal(record.summary.expected, 0);
  assert.equal(record.summary.free, 3);
  assert.equal(record.source, 'generated');
  assert.equal(summarize(library.get(id)).bestAtCurrentBpm, null);
});

test('fonte detectada pelo material: o próprio exercício é autoral, derivado é gerado', () => {
  const session = createSession({ name: 'Base', bpm: 100, bars: 1 });
  const library = open(memoryStorage(), session);
  const id = library.active();
  const same = library.captureRunContext(library.get(id).session, { objective: 'timing' });
  assert.equal(same.source, 'authored');
  const derived = library.captureRunContext(createSession({ name: 'Base', bpm: 100, bars: 2 }), { objective: 'timing' });
  assert.equal(derived.source, 'generated');
  assert.equal(derived.ownerId, id);
});

test('melhor por BPM não mistura material gerado diferente do autoral', () => {
  const session = createSession({ name: 'Base', bpm: 100, bars: 1 });
  const library = open(memoryStorage(), session);
  const id = library.active();
  const goal = session.training.goal;
  const repetitions = session.training.repetitions;
  const authored = library.captureRunContext(library.get(id).session, { source: 'authored', objective: 'timing' });
  library.recordRun(authored, { bpm: 100, mode: 'train', goal, repetitions, summary: { mode: 'strict', expected: 4, attackOk: 4, endOk: 4, pitchOk: 0, pitchChecked: 0, free: 0 }, metric: 1 });
  const generatedSession = createSession({ name: 'Gerado', bpm: 100, bars: 1 });
  const generated = library.captureRunContext(generatedSession, { source: 'generated', objective: 'timing' });
  library.recordRun(generated, { bpm: 140, mode: 'train', goal, repetitions, summary: { mode: 'strict', expected: 4, attackOk: 4, endOk: 4, pitchOk: 0, pitchChecked: 0, free: 0 }, metric: 1 });
  const rows = library.list();
  // O melhor BPM autoral é 100; o gerado a 140 não conta para o alvo autoral.
  assert.equal(rows[0].bestBpm, 100);
  assert.equal(rows[0].bestAtCurrentBpm.score, 100);
  assert.notEqual(materialKey(library.records(id)[0]), materialKey(library.records(id)[1]));
});

// ----- metadados, exclusão e ordenação --------------------------------------

test('renomear sincroniza o nome da sessão e o alvo é editável', () => {
  const library = open(memoryStorage(), createSession({ name: 'Nome', bpm: 100 }));
  const id = library.active();
  library.updateMetadata(id, { name: 'Novo nome', targetBPM: 160 });
  assert.equal(library.get(id).metadata.name, 'Novo nome');
  assert.equal(library.get(id).session.name, 'Novo nome');
  assert.equal(library.get(id).metadata.targetBPM, 160);
});

test('excluir guarda desfazer e restaura na mesma posição', () => {
  const library = open(memoryStorage(), createSession({ name: 'A', bpm: 100 }));
  library.duplicate(library.active());
  const [first, second] = library.list({ sort: 'name' }).map(row => row.id);
  library.deleteUndo(second);
  assert.equal(library.size(), 1);
  assert.equal(library.canUndoDelete(), true);
  const restored = library.undoDelete();
  assert.equal(restored.id, second);
  assert.deepEqual(library.list({ sort: 'name' }).map(row => row.id), [first, second]);
  assert.equal(library.canUndoDelete(), false);
});

test('filtros por instrumento, etiqueta e nome, e ordenação por treino', () => {
  const library = open(memoryStorage(), createSession({ name: 'Base', bpm: 100 }));
  const base = library.active();
  library.updateMetadata(base, { tags: ['escala'] });
  const bass = library.duplicate(base);
  library.updateMetadata(bass.id, { name: 'Baixo', tags: ['groove'] });
  const bassSession = library.get(bass.id).session;
  bassSession.extensions = { studio: { instrument: { type: 'bass' } } };
  library.autosave(bassSession, bass.id);
  library.select(bass.id);
  const groove = library.captureRunContext(library.get(bass.id).session, { source: 'authored', objective: 'timing' });
  library.recordRun(groove, { bpm: 100, mode: 'train', goal: 'timing', repetitions: 1, summary: { mode: 'strict', expected: 4, attackOk: 4, endOk: 4, pitchOk: 0, pitchChecked: 0, free: 0 }, metric: 1 });
  library.select(base);

  assert.deepEqual(library.list({ filter: { instrument: 'bass' } }).map(row => row.name), ['Baixo']);
  assert.deepEqual(library.list({ filter: { tag: 'escala' } }).map(row => row.name), ['Base']);
  assert.deepEqual(library.list({ filter: { query: 'baix' } }).map(row => row.name), ['Baixo']);
  // Mais tempo sem treinar vem primeiro: o nunca treinado antes do treinado.
  assert.equal(library.list({ sort: 'untrained' })[0].name, 'Base');
  assert.equal(library.list({ sort: 'name' })[0].name, 'Baixo');
  assert.ok(library.list({ sort: 'goal' }).length === 2);
});

test('reset escopa o desfazer por exercício', () => {
  const history = new History();
  const a = createSession({ name: 'A', bpm: 100 });
  const b = createSession({ name: 'B', bpm: 90 });
  history.push(a);
  history.push(createSession({ name: 'A editada', bpm: 105 }));
  assert.equal(history.canUndo, true);
  history.reset(b);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.current.name, 'B');
});

test('assinatura recebe mudanças e é cancelável', () => {
  const library = open(memoryStorage(), createSession({ name: 'A', bpm: 100 }));
  let calls = 0;
  const unsubscribe = library.subscribe(() => { calls += 1; });
  library.duplicate(library.active());
  assert.equal(calls, 1);
  unsubscribe();
  library.duplicate(library.active());
  assert.equal(calls, 1);
});

test('novo exercício exige sessão e nunca clona a sessão atual', () => {
  const library = open(memoryStorage(), createSession({ name: 'Atual', bpm: 120, bars: 4 }));
  assert.throws(() => library.new({}), /sessão/);
  const fresh = library.new({ session: createSession({ name: 'Novo', bpm: 90, bars: 1 }) });
  assert.equal(fresh.session.name, 'Novo');
  assert.equal(fresh.session.bpm, 90);
  assert.equal(fresh.metadata.records.length, 0);
  assert.equal(library.active(), fresh.id);
});

test('duplicar não troca o exercício ativo por conta própria', () => {
  const library = open(memoryStorage(), createSession({ name: 'Ativo', bpm: 100 }));
  const firstId = library.active();
  const copy = library.duplicate(firstId);
  assert.notEqual(copy.id, firstId);
  assert.equal(library.active(), firstId);
  assert.equal(library.get(copy.id).metadata.name, 'Ativo · cópia');
  assert.equal(library.get(copy.id).metadata.records.length, 0);
});

test('excluir o exercício ativo move o ativo para outro exercício', () => {
  const library = open(memoryStorage(), createSession({ name: 'A', bpm: 100 }));
  const firstId = library.active();
  const copy = library.duplicate(firstId);
  library.deleteUndo(firstId);
  assert.equal(library.active(), copy.id);
  assert.equal(library.size(), 1);
});

// ----- teto do nome (sessionv5) ---------------------------------------------

test('o teto do nome da biblioteca é o mesmo da sessão canônica', () => {
  assert.equal(SESSION_NAME_MAX, 80);
  const session = createSession({ name: 'ok' });
  assert.equal(parseSession(JSON.stringify({ ...session, name: 'x'.repeat(SESSION_NAME_MAX) })).name.length, SESSION_NAME_MAX);
  assert.throws(() => parseSession(JSON.stringify({ ...session, name: 'x'.repeat(SESSION_NAME_MAX + 1) })), /80 caracteres/);
});

test('renomear acima do teto é rejeitado antes de gravar e a loja recarrega inteira', () => {
  const storage = memoryStorage();
  const library = open(storage, createSession({ name: 'Curto', bpm: 100 }));
  const id = library.active();
  const bytes = storage.getItem(LIBRARY_KEY);
  assert.throws(() => library.updateMetadata(id, { name: 'x'.repeat(SESSION_NAME_MAX + 1) }), /80 caracteres/);
  // Nada mudou: nem na memória, nem nos bytes gravados.
  assert.equal(library.get(id).metadata.name, 'Curto');
  assert.equal(library.get(id).session.name, 'Curto');
  assert.equal(storage.getItem(LIBRARY_KEY), bytes);
  // O limite exato continua aceito e a loja recarrega sem virar corrompida.
  library.updateMetadata(id, { name: 'x'.repeat(SESSION_NAME_MAX) });
  assert.equal(library.get(id).metadata.name.length, SESSION_NAME_MAX);
  assert.equal(library.get(id).session.name.length, SESSION_NAME_MAX);
  const reopened = open(storage, createSession({ name: 'Outra' }));
  assert.equal(reopened.status, 'ready');
  assert.equal(reopened.get(id).metadata.name.length, SESSION_NAME_MAX);
  assert.equal(reopened.get(id).session.name.length, SESSION_NAME_MAX);
});

test('duplicar reserva o espaço do sufixo e a cópia recarrega válida', () => {
  const storage = memoryStorage();
  const library = open(storage, createSession({ name: 'Curto', bpm: 100 }));
  const id = library.active();
  const original = JSON.stringify(library.get(id).session);
  library.updateMetadata(id, { name: 'x'.repeat(SESSION_NAME_MAX) });
  const before = JSON.stringify(library.get(id).session);
  const copy = library.duplicate(id);
  assert.match(copy.session.name, /· cópia$/);
  assert.ok(copy.session.name.length <= SESSION_NAME_MAX);
  assert.equal(copy.metadata.name, copy.session.name);
  // O original nunca é alterado pela duplicação.
  assert.equal(JSON.stringify(library.get(id).session), before);
  assert.notEqual(before, original);
  const reopened = open(storage, createSession({ name: 'Outra' }));
  assert.equal(reopened.status, 'ready');
  assert.equal(reopened.size(), 2);
  assert.equal(reopened.list().filter(row => /· cópia$/.test(row.name)).length, 1);
});

test('importar nome fora do teto rejeita tudo e não sobrescreve nada', () => {
  const library = open(memoryStorage(), createSession({ name: 'Base', bpm: 100 }));
  const id = library.active();
  const session = library.get(id).session;
  const before = JSON.stringify(library.get(id));
  // Metadados com nome fora do teto: a sessão é válida, mas o nome não.
  const envelope = JSON.stringify({ kind: 'groovegoblin-exercise', exercise: { session, metadata: { name: 'x'.repeat(SESSION_NAME_MAX + 1) } } });
  assert.throws(() => library.importExercise(envelope), /80 caracteres/);
  // Sessão com nome fora do teto também rejeita a importação inteira.
  assert.throws(() => library.importExercise(JSON.stringify({ ...session, name: 'y'.repeat(SESSION_NAME_MAX + 1) })), /incompatível/);
  assert.equal(library.size(), 1);
  assert.equal(JSON.stringify(library.get(id)), before);
});

test('não permite excluir o último exercício nem operar id inexistente', () => {
  const library = open(memoryStorage(), createSession({ name: 'Único', bpm: 100 }));
  const id = library.active();
  assert.equal(library.deleteUndo(id), null);
  assert.equal(library.size(), 1);
  assert.equal(library.active(), id);
  assert.equal(library.duplicate('nao-existe'), null);
  assert.equal(library.select('nao-existe'), null);
  assert.equal(library.active(), id);
});


test('histórico acima de 200 treinos permanece integral ao salvar, recarregar e importar', () => {
  const storage = memoryStorage();
  const session = createSession({ name: 'Histórico longo', bpm: 100 });
  const library = open(storage, session);
  const id = library.active();
  const expected = Array.from({ length: 201 }, () => library.recordRun(
    library.captureRunContext(session, { source: 'authored', objective: 'timing' }),
    { summary: { mode: 'strict', expected: 4, attackOk: 4 }, metric: 1 },
  ));
  assert.deepEqual(library.get(id).metadata.records, expected);
  const reloaded = open(storage, session);
  assert.deepEqual(reloaded.get(id).metadata.records, expected);
  const target = open(memoryStorage(), createSession({ name: 'Outro exercício', bpm: 80 }));
  target.importExercise(reloaded.exportExercise(id));
  const imported = target.list().find(row => row.name === session.name);
  assert.deepEqual(target.get(imported.id).metadata.records, expected);
});

// ----- limpeza explícita de histórico (clearRecords) -------------------------

function recordOne(library, session) {
  return library.recordRun(
    library.captureRunContext(session, { source: 'authored', objective: 'timing' }),
    { summary: { mode: 'strict', expected: 4, attackOk: 4 }, metric: 0.9 },
  );
}

function quotaStorage(initial) {
  const map = new Map(initial);
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: key => map.delete(key),
    _map: map,
  };
}

test('clearRecords apaga os treinos do exercício e preserva exercício, nome, etiquetas e alvo', () => {
  const storage = memoryStorage();
  const session = createSession({ name: 'Alvo', bpm: 100 });
  const library = open(storage, session);
  const id = library.active();
  library.updateMetadata(id, { tags: ['escala'], targetBPM: 140, notes: 'dedilhar devagar' });
  recordOne(library, session);
  recordOne(library, session);
  const copy = library.duplicate(id);
  const sessionBefore = JSON.stringify(library.get(id).session);
  assert.equal(library.records(id).length, 2);

  const result = library.clearRecords(id);
  assert.deepEqual(result, { removed: 2, exercises: 1, saved: true });
  assert.deepEqual(library.records(id), []);
  const entry = library.get(id);
  assert.equal(entry.metadata.name, 'Alvo');
  assert.deepEqual(entry.metadata.tags, ['escala']);
  assert.equal(entry.metadata.targetBPM, 140);
  assert.equal(entry.metadata.notes, 'dedilhar devagar');
  assert.equal(JSON.stringify(entry.session), sessionBefore, 'a sessão autoral não é tocada');
  assert.deepEqual(library.records(copy.id), [], 'a limpeza não atingiu o outro exercício');
  assert.equal(library.size(), 2, 'nenhum exercício é removido');

  const reopened = open(storage, session);
  assert.deepEqual(reopened.records(id), [], 'a limpeza foi persistida');
  assert.equal(reopened.list().find(row => row.id === id).recordsCount, 0);
  assert.throws(() => library.clearRecords('nao-existe'), RangeError);
});

test('clearRecords sem id limpa todos os exercícios e mantém cada metadado', () => {
  const storage = memoryStorage();
  const session = createSession({ name: 'Um', bpm: 100 });
  const library = open(storage, session);
  const first = library.active();
  const second = library.duplicate(first);
  recordOne(library, session);
  library.select(second.id);
  recordOne(library, session);
  assert.equal(library.records(first).length, 1);
  assert.equal(library.records(second.id).length, 1);

  const result = library.clearRecords();
  assert.deepEqual(result, { removed: 2, exercises: 2, saved: true });
  assert.deepEqual(library.records(first), []);
  assert.deepEqual(library.records(second.id), []);
  assert.equal(library.get(first).metadata.name, 'Um');
  assert.ok(library.get(second.id).metadata.name.length > 0);
});

test('quota negada na limpeza não perde nem sobrescreve o histórico guardado', () => {
  const good = memoryStorage();
  const session = createSession({ name: 'Quota', bpm: 100 });
  const library = open(good, session);
  const id = library.active();
  recordOne(library, session);
  const bytes = good.getItem(LIBRARY_KEY);
  const limited = quotaStorage([[LIBRARY_KEY, bytes]]);

  const second = open(limited, session);
  const result = second.clearRecords(id);
  assert.equal(result.saved, false, 'sem armazenamento a limpeza não é gravada');
  assert.deepEqual(second.records(id), [], 'a intenção fica visível na memória');
  assert.equal(limited.getItem(LIBRARY_KEY), bytes, 'os bytes guardados continuam intactos');
});

test('biblioteca corrompida: limpeza explícita não sobrescreve os bytes originais', () => {
  const corrupt = '{nao é json';
  const storage = memoryStorage(new Map([[LIBRARY_KEY, corrupt]]));
  const session = createSession({ name: 'Corrompida', bpm: 100 });
  const library = open(storage, session);
  assert.equal(library.status, 'corrupt');
  const result = library.clearRecords();
  assert.equal(result.saved, false);
  assert.equal(storage.getItem(LIBRARY_KEY), corrupt, 'os originais permanecem recuperáveis');
  assert.equal(storage.getItem(LIBRARY_RECOVERY_KEY), corrupt);
});

// ----- alvo opcional (null = sem alvo definido) ------------------------------

test('exercício novo começa sem alvo; definir e limpar o alvo é preservado', () => {
  const library = open(memoryStorage(), createSession({ name: 'Atual', bpm: 100 }));
  const fresh = library.new({ session: createSession({ name: 'Sem alvo', bpm: 96, bars: 2 }) });
  assert.equal(fresh.metadata.targetBPM, null, 'o alvo não nasce herdado do andamento');
  const row = library.list().find(item => item.id === fresh.id);
  assert.equal(row.targetBPM, null);
  assert.equal(row.progress, 0, 'sem alvo não há progresso inventado');
  library.updateMetadata(fresh.id, { targetBPM: 120 });
  assert.equal(library.get(fresh.id).metadata.targetBPM, 120);
  library.updateMetadata(fresh.id, { targetBPM: null });
  assert.equal(library.get(fresh.id).metadata.targetBPM, null);
});

test('metadados parciais de um exercício novo não criam um alvo implícito', () => {
  const library = open(memoryStorage(), createSession({ name: 'Atual', bpm: 100 }));
  const fresh = library.new({
    session: createSession({ name: 'Exercício', bpm: 96 }),
    metadata: { name: 'Nome próprio', notes: 'Anotação pessoal' },
  });
  assert.equal(fresh.metadata.targetBPM, null);
  assert.equal(fresh.metadata.name, 'Nome próprio');
  assert.equal(fresh.metadata.notes, 'Anotação pessoal');
});

test('instalação nova não inventa alvo, mas a sessão legada conserva o andamento-alvo', () => {
  const session = createSession({ name: 'Exercício inicial', bpm: 120 });
  const fresh = open(memoryStorage(), session);
  assert.equal(fresh.activeEntry().metadata.targetBPM, null);
  const raw = serializeSession(session);
  const storage = memoryStorage(new Map([[LEGACY_SESSION_KEY, raw]]));
  const legacy = open(storage, session);
  assert.equal(legacy.activeEntry().metadata.targetBPM, 120);
  assert.equal(storage.getItem(LEGACY_SESSION_KEY), raw);
});

test('ordenação por alvo ignora quem não tem alvo, sem herdar o andamento', () => {
  const library = open(memoryStorage(), createSession({ name: 'Base', bpm: 100 }));
  const base = library.active();
  library.updateMetadata(base, { name: 'Com alvo', targetBPM: 150 });
  library.new({ session: createSession({ name: 'Sem alvo', bpm: 90, bars: 1 }) });
  const longe = library.new({ session: createSession({ name: 'Alvo longe', bpm: 90, bars: 1 }) });
  library.updateMetadata(longe.id, { targetBPM: 300 });
  assert.deepEqual(library.list({ sort: 'goal' }).map(row => row.name), ['Alvo longe', 'Com alvo', 'Sem alvo']);
});

test('exportar e importar preserva alvo definido e alvo ausente, sozinho e em biblioteca', () => {
  const source = open(memoryStorage(), createSession({ name: 'Com alvo', bpm: 100, bars: 2 }));
  source.updateMetadata(source.active(), { targetBPM: 160 });
  source.new({ session: createSession({ name: 'Sem alvo', bpm: 90, bars: 1 }) });

  const target = open(memoryStorage(), createSession({ name: 'Outra', bpm: 90 }));
  for (const row of source.list()) target.importExercise(source.exportExercise(row.id));
  assert.equal(target.list().find(row => row.name === 'Com alvo').targetBPM, 160);
  assert.equal(target.list().find(row => row.name === 'Sem alvo').targetBPM, null);

  const bundle = open(memoryStorage(), createSession({ name: 'Outra', bpm: 90 }));
  bundle.importLibrary(source.exportLibrary());
  assert.equal(bundle.list().find(row => row.name === 'Com alvo').targetBPM, 160);
  assert.equal(bundle.list().find(row => row.name === 'Sem alvo').targetBPM, null);
});

test('metadado legado sem a chave do alvo herda o andamento; o null explícito permanece', () => {
  const session = createSession({ name: 'Legado', bpm: 132, bars: 1 });
  const raw = JSON.stringify({
    version: 1,
    activeId: 'legado-1',
    entries: [{
      id: 'legado-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      session: JSON.parse(serializeSession(session)),
      metadata: { name: 'Legado', tags: [], notes: '', records: [] },
    }],
  });
  const legacy = open(memoryStorage(new Map([[LIBRARY_KEY, raw]])), session);
  assert.equal(legacy.get('legado-1').metadata.targetBPM, 132, 'alvo antigo preservado');

  const explicit = JSON.stringify({
    version: 1,
    activeId: 'legado-1',
    entries: [{
      id: 'legado-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      session: JSON.parse(serializeSession(session)),
      metadata: { name: 'Legado', tags: [], targetBPM: null, notes: '', records: [] },
    }],
  });
  const semAlvo = open(memoryStorage(new Map([[LIBRARY_KEY, explicit]])), session);
  assert.equal(semAlvo.get('legado-1').metadata.targetBPM, null, 'null explícito nunca vira andamento');
});

// ----- estudo (A4): receita, vínculo de variação e grupo ---------------------

// Receita mínima no schema do gerador (A2); a biblioteca guarda o objeto
// íntegro sem interpretar música.
const studyRecipe = (start = 'C') => ({
  version: 1, family: 'arpejo_triade_forma_unica',
  progression: { kind: 'quartas', start, direction: 'ascendente', quality: 'major', chords: [], length: null, spelling: 'auto' },
  bars: null, region: { from: 1, to: 12, open: false, strings: null },
  figure: { degrees: [1, 3, 5], inversions: 3, notes: 4, order: 'sobe', bars: 2 },
  rhythm: 'arpejo', voltas: 1, final: 'acorde',
});
const studyMetadata = (start = 'C', extra = {}) => ({
  name: `Estudo ${start}`, tags: ['estudo'],
  study: { version: 1, recipe: studyRecipe(start), summary: { noteCount: 36 }, origin: null, group: null, ...extra },
});

test('a receita do estudo vive fora da sessão e o vínculo/grupo sobrevivem à reabertura', () => {
  const storage = memoryStorage();
  const library = open(storage, createSession({ name: 'Base', bpm: 100 }));
  const entry = library.new({
    session: createSession({ name: 'Estudo C' }),
    metadata: studyMetadata('C', {
      origin: { id: 'origem-1', name: 'Estudo antes' },
      group: { id: 'g1', label: 'Ciclo de quartas em 12 tonalidades' },
    }),
  });
  const stored = library.get(entry.id);
  assert.equal(stored.metadata.study.recipe.progression.start, 'C');
  assert.deepEqual(stored.metadata.study.origin, { id: 'origem-1', name: 'Estudo antes' });
  assert.deepEqual(stored.metadata.study.group, { id: 'g1', label: 'Ciclo de quartas em 12 tonalidades' });
  assert.deepEqual(stored.metadata.study.summary, { noteCount: 36 });
  // A sessão não ganha nada: a receita é metadata, não extensão da sessão.
  assert.equal(stored.session.extensions.studio, undefined);
  assert.equal(serializeSession(stored.session).includes('arpejo_triade_forma_unica'), false);
  // O resumo da lista expõe só os vínculos (a receita continua em metadata).
  const row = summarize(stored);
  assert.deepEqual(row.study.origin, { id: 'origem-1', name: 'Estudo antes' });
  assert.deepEqual(row.study.group, { id: 'g1', label: 'Ciclo de quartas em 12 tonalidades' });
  assert.equal(Object.hasOwn(row, 'recipe'), false);
  // Nada é compartilhado por referência: o que voltou do get é uma cópia.
  stored.metadata.study.recipe.progression.start = 'G';
  stored.metadata.study.origin.id = 'outro';
  assert.equal(library.get(entry.id).metadata.study.recipe.progression.start, 'C');
  assert.equal(library.get(entry.id).metadata.study.origin.id, 'origem-1');
  // Reabrir a loja preserva o bloco inteiro.
  const reloaded = open(storage, createSession({ name: 'Base' }));
  assert.deepEqual(reloaded.get(entry.id).metadata.study, library.get(entry.id).metadata.study);
});

test('bloco de estudo inválido ou sem receita não vira estudo pela metade', () => {
  const library = open(memoryStorage(), createSession({ name: 'Base' }));
  const cases = [
    'texto', 42, ['a'], null,
    { origin: { id: 'x', name: 'Sem receita' } },
    { recipe: 'não é objeto' },
    { recipe: { family: 'x' }, origin: 'não é link', group: 7 },
  ];
  for (const study of cases) {
    const entry = library.new({ session: createSession({ name: `Caso ${Math.random()}` }), metadata: { name: 'Caso', study } });
    const saved = library.get(entry.id).metadata.study;
    if (saved === null) continue;
    assert.equal(typeof saved.recipe, 'object', `receita inválida aceita: ${JSON.stringify(study)}`);
    assert.equal(saved.origin, null, 'link inválido descartado');
    assert.equal(saved.group, null, 'grupo inválido descartado');
  }
  // Sem receita o estudo é null (nada de metade do vínculo).
  assert.equal(library.get(library.new({ session: createSession({ name: 'Só link' }), metadata: { name: 'Só link', study: { origin: { id: 'x' } } } }).id).metadata.study, null);
});

test('marca de conteúdo de curso sobrevive a criar, marcar, exportar e importar', () => {
  const library = open(memoryStorage(), createSession({ name: 'Base' }));
  const entry = library.new({ session: createSession({ name: 'Da aula' }) });
  assert.equal(library.get(entry.id).metadata.courseContent, false, 'exercício comum não nasce marcado');
  library.updateMetadata(entry.id, { courseContent: true });
  assert.equal(library.get(entry.id).metadata.courseContent, true, 'a marca persiste na loja');
  // A marca é PEGAJOSA (B6): um valor que não marca não apaga a marca que já
  // existe — o vínculo de curso não pode ser "desmarcado" por uma edição.
  library.updateMetadata(entry.id, { courseContent: 'sim' });
  assert.equal(library.get(entry.id).metadata.courseContent, true, 'a marca existente não é apagada');
  // Num exercício comum, valor que não é `true` não cria marca nenhuma.
  const plain = library.new({ session: createSession({ name: 'Sem marca' }) });
  library.updateMetadata(plain.id, { courseContent: 'sim' });
  assert.equal(library.get(plain.id).metadata.courseContent, false, 'só `true` marca: nada de quase privado');
  library.updateMetadata(entry.id, { courseContent: true });
  // A exportação PADRÃO de um exercício de curso sai genérica (B6): o nome não
  // vaza e o exercício importado é público.
  const other = open(memoryStorage(), createSession({ name: 'Outra' }));
  other.importExercise(library.exportExercise(entry.id));
  const publicRow = other.list().find(candidate => candidate.name === 'Estudo musical');
  assert.ok(publicRow, 'a exportação padrão redige o nome do exercício de curso');
  assert.equal(other.get(publicRow.id).metadata.courseContent, false);
  // O retrato privado (opt-in explícito) é que leva a marca e o nome.
  const raw = open(memoryStorage(), createSession({ name: 'Terceira' }));
  raw.importEntries(JSON.parse(library.exportLibrary({ includeCourseContent: true })).entries);
  const row = raw.list().find(candidate => candidate.name === 'Da aula');
  assert.equal(raw.get(row.id).metadata.courseContent, true, 'a marca viaja no retrato privado');
});

test('receitas diferentes com a mesma sessão são exercícios diferentes; a mesma receita deduplica', () => {
  const session = createSession({ name: 'Igual', bpm: 100 });
  const source = open(memoryStorage(), session);
  source.new({ session, metadata: studyMetadata('C') });
  source.new({ session, metadata: studyMetadata('G') });
  source.new({ session, metadata: studyMetadata('C') });
  assert.equal(source.size(), 4, 'exercício atual + duas receitas + a repetida');
  const bundle = JSON.parse(source.exportLibrary());
  const target = open(memoryStorage(), createSession({ name: 'Outra' }));
  const first = target.importEntries(bundle.entries);
  assert.equal(first.added, 4);
  const repeat = target.importEntries(JSON.parse(source.exportLibrary()).entries);
  assert.equal(repeat.added, 0, 'reimportar o mesmo backup não duplica (a receita entra na chave de conteúdo)');
  const starts = target.list().map(row => target.get(row.id).metadata.study?.recipe.progression.start).filter(Boolean).sort();
  assert.deepEqual(starts, ['C', 'C', 'G'], 'as duas receitas "C" continuam separadas da "G"');
});

test('importação do backup remapeia o vínculo da variação para o original desta biblioteca', () => {
  const session = createSession({ name: 'Base', bpm: 100 });
  const source = open(memoryStorage(), session);
  const original = source.new({ session: createSession({ name: 'Estudo C' }), metadata: studyMetadata('C', { group: { id: 'g1', label: 'Quartas em 12 tonalidades' } }) });
  const variation = source.new({
    session: createSession({ name: 'Estudo G' }),
    metadata: studyMetadata('G', {
      origin: { id: original.id, name: 'Estudo C' },
      group: { id: 'g1', label: 'Quartas em 12 tonalidades' },
    }),
  });
  const externo = source.new({
    session: createSession({ name: 'Estudo F#' }),
    metadata: studyMetadata('F#', { origin: { id: 'de-outra-biblioteca', name: 'De fora' } }),
  });
  const target = open(memoryStorage(), createSession({ name: 'Outra' }));
  const result = target.importEntries(JSON.parse(source.exportLibrary()).entries);
  assert.equal(result.added, 4);
  assert.notEqual(result.map[original.id], original.id);
  const importedOriginal = target.get(result.map[original.id]);
  const importedVariation = target.get(result.map[variation.id]);
  assert.deepEqual(importedVariation.metadata.study.origin, { id: importedOriginal.id, name: 'Estudo C' });
  assert.equal(importedVariation.metadata.study.origin.id !== original.id, true, 'o id de origem é o DESTA biblioteca');
  assert.deepEqual(importedVariation.metadata.study.group, importedOriginal.metadata.study.group, 'o grupo é o mesmo rótulo');
  assert.deepEqual(importedOriginal.metadata.study.origin, null);
  // Vínculo para fora do arquivo não aponta para ninguém: continua rótulo.
  const importedExterno = target.get(result.map[externo.id]);
  assert.deepEqual(importedExterno.metadata.study.origin, { id: 'de-outra-biblioteca', name: 'De fora' });
  // Importar de novo não cria nada e não mexe nos vínculos já remapeados.
  assert.equal(target.importEntries(JSON.parse(source.exportLibrary()).entries).added, 0);
  assert.deepEqual(target.get(result.map[variation.id]).metadata.study.origin, { id: importedOriginal.id, name: 'Estudo C' });
});

test('autosave, renomear e duplicar preservam a receita do estudo', () => {
  const library = open(memoryStorage(), createSession({ name: 'Base' }));
  const entry = library.new({ session: createSession({ name: 'Estudo C' }), metadata: studyMetadata('C') });
  const recipe = library.get(entry.id).metadata.study.recipe;
  library.autosave({ ...library.get(entry.id).session, bpm: 120, notes: [] }, entry.id);
  assert.deepEqual(library.get(entry.id).metadata.study.recipe, recipe);
  library.updateMetadata(entry.id, { name: 'Outro nome' });
  assert.deepEqual(library.get(entry.id).metadata.study.recipe, recipe);
  library.updateMetadata(entry.id, { study: null });
  assert.equal(library.get(entry.id).metadata.study, null, 'dá para largar a receita explicitamente');
  const copy = library.duplicate(entry.id);
  assert.equal(copy.metadata.study, null);
  // A exportação de UM exercício leva o bloco inteiro.
  const back = library.new({ session: createSession({ name: 'Estudo G' }), metadata: studyMetadata('G') });
  const exported = JSON.parse(library.exportExercise(back.id));
  const other = open(memoryStorage(), createSession({ name: 'Outra' }));
  other.importExercise(JSON.stringify(exported));
  const imported = other.list().find(row => row.name === 'Estudo G');
  assert.equal(other.get(imported.id).metadata.study.recipe.progression.start, 'G');
});

test('vínculo de curso é marcado como privado e sobrevive a exportar/importar', () => {
  const library = open(memoryStorage(), createSession({ name: 'Base' }));
  const entry = library.new({
    session: createSession({ name: 'Estudo F#' }),
    metadata: studyMetadata('F#', {
      origin: { id: 'aula-7', name: 'Título privado', kind: 'course', private: true },
      group: { id: 'g-aula', label: 'Rótulo privado', private: true },
    }),
  });
  const study = library.get(entry.id).metadata.study;
  assert.deepEqual(study.origin, { id: 'aula-7', name: 'Título privado', kind: 'course', private: true });
  assert.deepEqual(study.group, { id: 'g-aula', label: 'Rótulo privado', private: true });
  // A exportação PADRÃO do exercício (B6/etapa 8) sai SEM o bloco `study`
  // inteiro: a receita pode carregar texto livre (nome/id de forma, resumo,
  // campos importados), então o público não leva vínculo, grupo nem receita. A
  // música que o exercício toca continua na sessão.
  const exported = library.exportExercise(entry.id);
  assert.equal(exported.includes('Título privado'), false, 'o título da aula não sai');
  assert.equal(exported.includes('aula-7'), false, 'o id da aula não sai');
  assert.equal(exported.includes('Rótulo privado'), false, 'o rótulo do catálogo não sai');
  const other = open(memoryStorage(), createSession({ name: 'Outra' }));
  other.importExercise(exported);
  const row = other.list().find(candidate => candidate.name === 'Estudo musical');
  assert.ok(row, 'o exercício sai com nome genérico');
  assert.equal(other.get(row.id).metadata.study, null, 'nada do bloco study sai no público');
  assert.deepEqual(
    other.get(row.id).session.notes.map(note => [note.pitch, note.start, note.duration, note.string]),
    entry.session.notes.map(note => [note.pitch, note.start, note.duration, note.string]),
  );
  // A loja de origem continua intacta: exportar não muta o exercício.
  assert.equal(library.get(entry.id).metadata.study.origin.private, true);
  assert.equal(library.get(entry.id).metadata.name, 'Estudo F#');
  // O retrato PRIVADO explícito é quem leva o bloco inteiro.
  const raw = JSON.parse(library.exportLibrary({ includeCourseContent: true }));
  assert.equal(raw.entries.find(candidate => candidate.id === entry.id).metadata.study.origin.private, true);
  assert.equal(raw.entries.find(candidate => candidate.id === entry.id).metadata.study.recipe.family, 'arpejo_triade_forma_unica');
});
