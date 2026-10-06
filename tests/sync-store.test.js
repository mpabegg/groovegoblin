// Estado durável da sincronização: impressão digital canônica, revisões,
// conflitos, cópias de segurança, anexos offline e troca de diretório de dados.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncState, canonicalText, bodyDigest, SYNC_STATE_KEY, SYNC_STATE_RECOVERY_KEY, CONFLICT_LIMIT } from '../src/sync-store.js';
import { createMemoryStorage } from './sync-harness.js';

test('a serialização canônica ignora a ordem das chaves e a impressão digital acompanha', () => {
  assert.equal(canonicalText({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalText({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.notEqual(canonicalText({ a: 1 }), canonicalText({ a: 2 }));
  assert.equal(canonicalText({ a: 1, b: undefined }), canonicalText({ a: 1 }));
  assert.equal(bodyDigest('abc'), bodyDigest('abc'));
  assert.notEqual(bodyDigest('abc'), bodyDigest('abd'));
  assert.match(bodyDigest('abc'), /^[0-9a-f]{16}$/);
});

test('revisão e impressão digital andam juntas por documento', () => {
  const state = createSyncState({ storage: createMemoryStorage() });
  assert.equal(state.revision('exercises', 'a'), null);
  state.markSent('exercises', 'a', '12', 'deadbeefdeadbeef');
  assert.equal(state.revision('exercises', 'a'), '12');
  assert.equal(state.digest('exercises', 'a'), 'deadbeefdeadbeef');
  state.setRevision('exercises', 'a', '13');
  assert.equal(state.revision('exercises', 'a'), '13');
  state.clearRevision('exercises', 'a');
  assert.equal(state.revision('exercises', 'a'), null);
  assert.equal(state.digest('exercises', 'a'), null);
});

test('outro diretório de dados zera cursor, revisões e impressões digitais', () => {
  const storage = createMemoryStorage();
  const state = createSyncState({ storage });
  state.setServer({ dataId: 'aaaa1111aaaa1111' });
  state.markSent('courses', 'curso', '5', 'aaaaaaaabbbbbbbb');
  state.setCursor('aaaa1111aaaa1111.5');
  assert.equal(state.cursor, 'aaaa1111aaaa1111.5');

  state.setServer({ dataId: 'bbbb2222bbbb2222' });
  assert.equal(state.dataId, 'bbbb2222bbbb2222');
  assert.equal(state.cursor, null);
  assert.equal(state.revision('courses', 'curso'), null);

  const reloaded = createSyncState({ storage });
  assert.equal(reloaded.dataId, 'bbbb2222bbbb2222');
});

test('conflitos e cópias de segurança persistem e respeitam o teto sem descartar', () => {
  const storage = createMemoryStorage();
  const state = createSyncState({ storage });
  const added = state.addConflict({ id: 'exercises|a', collection: 'exercises', docId: 'a', localBody: { v: 1 }, serverRev: '9' });
  assert.equal(added.ok, true);
  assert.equal(state.addConflict({ id: 'exercises|a', collection: 'exercises', docId: 'a' }).duplicate, true);
  assert.equal(state.conflicts.length, 1);
  assert.equal(state.recovered.length, 0);
  assert.equal(state.addRecovered({ id: 'x', body: { v: 9 } }).ok, true);
  assert.equal(state.recovered.length, 1);

  const reloaded = createSyncState({ storage });
  assert.equal(reloaded.conflicts.length, 1);
  assert.equal(reloaded.recovered.length, 1);
  assert.equal(reloaded.removeConflict('exercises|a'), true);
  assert.equal(reloaded.conflicts.length, 0);

  for (let index = 0; index < CONFLICT_LIMIT; index += 1) {
    state.addConflict({ id: `exercises|c${index}`, collection: 'exercises', docId: `c${index}` });
  }
  const overflow = state.addConflict({ id: 'exercises|ultimo', collection: 'exercises', docId: 'ultimo' });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, 'full');
  assert.equal(state.conflicts.length, CONFLICT_LIMIT);
});

test('"manter offline" e blobs confirmados são lembrados e validados', () => {
  const storage = createMemoryStorage();
  const state = createSyncState({ storage });
  const sha = 'ab'.repeat(32);
  assert.equal(state.isPinned(sha), false);
  assert.equal(state.pinBlob({ sha256: sha, name: 'apostila.pdf' }), true);
  assert.equal(state.pinBlob({ sha256: sha }), false);
  assert.equal(state.pinBlob({ sha256: 'nao-e-hash' }), false);
  assert.equal(state.isPinned(sha), true);

  assert.equal(state.blobConfirmed(sha), false);
  state.confirmBlob(sha, { size: 10 });
  assert.equal(state.blobConfirmed(sha), true);
  assert.deepEqual(Object.keys(state.confirmedBlobs()), [sha]);

  const reloaded = createSyncState({ storage });
  assert.equal(reloaded.isPinned(sha), true);
  assert.equal(reloaded.blobConfirmed(sha), true);
  assert.equal(reloaded.unpinBlob(sha), true);
  assert.equal(reloaded.forgetBlob(sha), true);
  assert.equal(reloaded.isPinned(sha), false);
});

test('estado ilegível preserva os bytes e recomeça limpo', () => {
  const storage = createMemoryStorage();
  storage.setItem(SYNC_STATE_KEY, 'não é json');
  const state = createSyncState({ storage });
  assert.equal(state.recoveryRaw, 'não é json');
  assert.equal(storage.getItem(SYNC_STATE_RECOVERY_KEY), 'não é json');
  assert.match(state.warning, /preservados/);
  assert.equal(state.cursor, null);
  assert.equal(state.conflicts.length, 0);
  assert.equal(state.firstSyncDone, false);
});

test('primeira sincronização e carimbo de tempo são registrados uma vez', () => {
  const state = createSyncState({ storage: createMemoryStorage() });
  assert.equal(state.firstSyncDone, false);
  assert.equal(state.markFirstSyncDone(), true);
  assert.equal(state.markFirstSyncDone(), false);
  assert.equal(state.lastSyncAt, null);
  state.markSynced('2026-01-02T03:04:05.000Z');
  assert.equal(state.lastSyncAt, '2026-01-02T03:04:05.000Z');
});
