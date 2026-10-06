// Fila de saída durável: agrupamento por documento, sobrevivência à recarga,
// teto e recuperação de bytes ilegíveis.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncOutbox, OUTBOX_KEY, OUTBOX_RECOVERY_KEY } from '../src/sync-outbox.js';
import { createMemoryStorage } from './sync-harness.js';

test('enfileira, coalesce pelo documento e guarda a pré-condição da primeira divergência', () => {
  const outbox = createSyncOutbox({ storage: createMemoryStorage(), now: () => '2026-01-01T00:00:00.000Z' });
  const first = outbox.enqueue({ kind: 'doc-put', collection: 'exercises', docId: 'a', body: { v: 1 }, baseRev: '7', create: false });
  assert.equal(first.ok, true);
  assert.equal(outbox.count(), 1);

  const second = outbox.enqueue({ kind: 'doc-put', collection: 'exercises', docId: 'a', body: { v: 2 }, baseRev: '9', create: true });
  assert.equal(second.coalesced, true);
  assert.equal(outbox.count(), 1);
  const [op] = outbox.list();
  assert.deepEqual(op.body, { v: 2 });
  assert.equal(op.baseRev, '7');
  assert.equal(op.create, false);
});

test('remoção local pendente vence a edição: a lápide sobe primeiro', () => {
  const outbox = createSyncOutbox({ storage: createMemoryStorage() });
  outbox.enqueue({ kind: 'doc-put', collection: 'exercises', docId: 'a', body: { v: 1 }, baseRev: '3' });
  outbox.enqueue({ kind: 'doc-delete', collection: 'exercises', docId: 'a', baseRev: '3' });
  assert.equal(outbox.count(), 1);
  assert.equal(outbox.list()[0].kind, 'doc-delete');
  assert.equal(outbox.list()[0].baseRev, '3');
});

test('a fila sobrevive à recarga: outra instância vê as mesmas operações', () => {
  const storage = createMemoryStorage();
  const first = createSyncOutbox({ storage });
  first.enqueue({ kind: 'doc-put', collection: 'exercises', docId: 'a', body: { v: 1 }, baseRev: null, create: true });
  first.enqueue({ kind: 'blob-put', sha256: 'a'.repeat(64), size: 3, name: 'la.pdf' });

  const reloaded = createSyncOutbox({ storage });
  assert.equal(reloaded.count(), 2);
  const ids = reloaded.list().map(op => op.id);
  assert.deepEqual(ids, ['exercises|a', `blob-put|${'a'.repeat(64)}`]);
  assert.equal(reloaded.get('exercises|a').create, true);
});

test('a remoção só acontece depois da confirmação, e a falha mantém a operação', () => {
  const storage = createMemoryStorage();
  const outbox = createSyncOutbox({ storage });
  outbox.enqueue({ kind: 'doc-put', collection: 'exercises', docId: 'a', body: { v: 1 }, baseRev: null, create: true });
  const id = 'exercises|a';
  outbox.fail(id, 'sem rede');
  assert.equal(outbox.count(), 1);
  assert.equal(outbox.get(id).attempts, 1);
  assert.equal(outbox.get(id).error, 'sem rede');
  outbox.remove(id);
  assert.equal(outbox.count(), 0);
  assert.equal(createSyncOutbox({ storage }).count(), 0);
});

test('JSON ilegível preserva os bytes originais e não perde o arquivo da chave', () => {
  const storage = createMemoryStorage();
  storage.setItem(OUTBOX_KEY, '{isso não é json');
  const outbox = createSyncOutbox({ storage });
  assert.equal(outbox.count(), 0);
  assert.equal(outbox.recoveryRaw, '{isso não é json');
  assert.equal(storage.getItem(OUTBOX_RECOVERY_KEY), '{isso não é json');
  assert.match(outbox.warning, /preservados/);
});

test('operação inválida é recusada e o teto não descarta o que já estava na fila', () => {
  const outbox = createSyncOutbox({ storage: createMemoryStorage(), limit: 2 });
  assert.equal(outbox.enqueue({ kind: 'doc-put', collection: 'exercises', docId: '', body: {} }).ok, false);
  assert.equal(outbox.enqueue({ kind: 'doc-put', collection: 'exercises', docId: 'a', body: {} }).ok, true);
  assert.equal(outbox.enqueue({ kind: 'doc-put', collection: 'exercises', docId: 'b', body: {} }).ok, true);
  const full = outbox.enqueue({ kind: 'doc-put', collection: 'exercises', docId: 'c', body: {} });
  assert.equal(full.ok, false);
  assert.equal(full.code, 'full');
  assert.equal(outbox.count(), 2);
  assert.match(outbox.warning, /teto/);
});

test('armazenamento que recusa a escrita mantém a fila em memória, com aviso', () => {
  const storage = createMemoryStorage({ fail: true });
  const outbox = createSyncOutbox({ storage });
  const result = outbox.enqueue({ kind: 'doc-put', collection: 'exercises', docId: 'a', body: { v: 1 } });
  assert.equal(result.ok, true);
  assert.equal(outbox.count(), 1);
  assert.equal(outbox.persisted, false);
  assert.match(outbox.warning, /memória/);
});
