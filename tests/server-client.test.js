// Cliente da API do servidor (etapa 7): contrato de revisão, feed, blobs,
// área privada, conversão, modo local quieto e teto de tempo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createServerClient } from '../src/server-client.js';
import { startContractServer, sha256Hex } from './sync-harness.js';

const fixture = name => readFile(new URL(`./fixtures/course/${name}`, import.meta.url), 'utf8');

async function withServer(t, options = {}) {
  const server = await startContractServer(options);
  t.after(() => server.close());
  const client = createServerClient({ base: server.base, requestOrigin: server.origin });
  return { server, client };
}

async function rawServer(t, status, body = '') {
  const server = createServer((request, response) => {
    response.writeHead(status, { 'Content-Type': 'text/plain' });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/`;
}

test('health responde ok e identifica o GrooveGoblin', async t => {
  const { client } = await withServer(t);
  const probed = await client.probe();
  assert.equal(probed.ok, true);
  assert.equal(probed.health.service, 'groovegoblin');
  assert.equal(probed.health.ok, true);
  assert.equal(typeof probed.health.dataId, 'string');
  assert.equal(probed.health.storage.docs, 0);
});

test('404 e 401 significam, respectivamente, modo local e identidade recusada', async t => {
  const missing = createServerClient({ base: await rawServer(t, 404, 'nope') });
  const local = await missing.probe();
  assert.equal(local.ok, false);
  assert.equal(local.mode, 'local');

  const denied = createServerClient({ base: await rawServer(t, 401, '{"error":"identity_required","message":"sem identidade"}') });
  const identity = await denied.probe();
  assert.equal(identity.ok, false);
  assert.equal(identity.mode, 'identity');
});

test('servidor mudo devolve timeout sem lançar', async t => {
  const base = `http://127.0.0.1:${await new Promise(resolve => {
    const server = createServer(() => { /* nunca responde */ });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    t.after(() => server.close());
  })}/`;
  const client = createServerClient({ base, timeoutMs: 40 });
  const result = await client.probe();
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'local');
  assert.equal(result.code, 'timeout');
});

test('escrita exige pré-condição e criação usa If-None-Match: *', async t => {
  const { client } = await withServer(t);
  const missing = await client.putDoc('exercises', 'ex-1', { id: 'ex-1' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'precondition_required');

  const created = await client.putDoc('exercises', 'ex-1', { id: 'ex-1', v: 1 }, { create: true });
  assert.equal(created.ok, true);
  assert.equal(created.status, 201);
  assert.equal(created.created, true);
  assert.match(created.rev, /^[0-9]+$/);

  const again = await client.putDoc('exercises', 'ex-1', { id: 'ex-1', v: 2 }, { create: true });
  assert.equal(again.ok, false);
  assert.equal(again.status, 412);
  assert.equal(again.conflict.rev, created.rev);
});

test('revisão velha devolve 412 com a revisão atual e a leitura condicional devolve 304', async t => {
  const { client } = await withServer(t);
  const first = await client.putDoc('exercises', 'ex-2', { id: 'ex-2', v: 1 }, { create: true });
  const update = await client.putDoc('exercises', 'ex-2', { id: 'ex-2', v: 2 }, { rev: first.rev });
  assert.equal(update.ok, true);
  assert.notEqual(update.rev, first.rev);

  const stale = await client.putDoc('exercises', 'ex-2', { id: 'ex-2', v: 3 }, { rev: first.rev });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'precondition_failed');
  assert.equal(stale.conflict.rev, update.rev);
  assert.equal(stale.conflict.deleted, false);

  const current = await client.getDoc('exercises', 'ex-2', { rev: update.rev });
  assert.equal(current.ok, true);
  assert.equal(current.notModified, true);

  const read = await client.getDoc('exercises', 'ex-2');
  assert.equal(read.ok, true);
  assert.deepEqual(read.body, { id: 'ex-2', v: 2 });
  assert.equal(read.rev, update.rev);
});

test('lápide é lida como removida, com revisão', async t => {
  const { client } = await withServer(t);
  const created = await client.putDoc('exercises', 'ex-3', { id: 'ex-3' }, { create: true });
  const removed = await client.deleteDoc('exercises', 'ex-3', { rev: created.rev });
  assert.equal(removed.ok, true);
  assert.equal(removed.deleted, true);

  const read = await client.getDoc('exercises', 'ex-3');
  assert.equal(read.ok, false);
  assert.equal(read.deleted, true);
  assert.equal(read.rev, removed.rev);
});

test('feed pagina com cursor e recusa cursor de outro conjunto de dados', async t => {
  const { client } = await withServer(t);
  await client.putDoc('exercises', 'a', { id: 'a' }, { create: true });
  await client.putDoc('exercises', 'b', { id: 'b' }, { create: true });
  const firstPage = await client.changes({ limit: 1 });
  assert.equal(firstPage.ok, true);
  assert.equal(firstPage.changes.length, 1);
  assert.equal(firstPage.more, true);
  assert.match(firstPage.cursor, /^0123456789abcdef\.[0-9]+$/);

  const second = await client.changes({ since: firstPage.cursor, limit: 10 });
  assert.equal(second.ok, true);
  assert.equal(second.changes.length, 1);
  assert.equal(second.more, false);

  const reset = await client.changes({ since: 'ffffffffffffffff.9' });
  assert.equal(reset.ok, false);
  assert.equal(reset.status, 410);
  assert.equal(reset.code, 'cursor_reset');
});

test('blobs são endereçados por conteúdo: hash conferido, leitura byte a byte e remoção', async t => {
  const { client } = await withServer(t);
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const realSha = sha256Hex(bytes);
  const otherSha = sha256Hex(new Uint8Array([9, 9, 9]));

  const wrong = await client.putBlob(otherSha, bytes);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'hash_mismatch');

  const created = await client.putBlob(realSha, bytes);
  assert.equal(created.ok, true);
  assert.equal(created.created, true);

  const head = await client.headBlob(realSha);
  assert.equal(head.ok, true);
  assert.equal(head.exists, true);
  assert.equal(head.size, bytes.length);

  const read = await client.readBlob(realSha);
  assert.equal(read.ok, true);
  assert.deepEqual([...read.bytes], [...bytes]);

  const removed = await client.deleteBlob(realSha);
  assert.equal(removed.ok, true);
  const gone = await client.headBlob(realSha);
  assert.equal(gone.exists, false);
  assert.match(client.blobUrl(realSha), new RegExp(`/api/blobs/${realSha}$`));
});

test('área privada guarda e devolve o mesmo objeto', async t => {
  const { client } = await withServer(t);
  const map = { curso: { id: 'curso-exemplo' }, modulos: [] };
  const stored = await client.putPrivate('map', map);
  assert.equal(stored.ok, true);
  assert.equal(typeof stored.sha256, 'string');
  const read = await client.getPrivate('map');
  assert.equal(read.ok, true);
  assert.deepEqual(read.body, map);
  const missing = await client.getPrivate('catalog');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'not_found');
});

test('conversão no servidor grava o envelope groovegoblin-course e o cliente o lê de volta', async t => {
  const { client } = await withServer(t);
  const map = JSON.parse(await fixture('map-example.json'));
  const result = await client.convert({ map });
  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.equal(typeof result.courseId, 'string');
  assert.equal(result.private.map, 'stored');

  const document = await client.getDoc('courses', result.courseId);
  assert.equal(document.ok, true);
  assert.equal(document.body.format, 'groovegoblin-course');
  assert.equal(document.body.course.id, result.courseId);
  assert.equal(document.rev, result.rev);

  const conflict = await client.convert({ map });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.courseId, result.courseId);

  const confirmed = await client.convert({ map, expectedRev: conflict.rev });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.created, false);
});

test('modo offline corta a escrita antes de tocar a rede', async t => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('não deveria sair'); };
  const client = createServerClient({ base: 'http://127.0.0.1:1/', fetch: fetchImpl, online: () => false });
  const result = await client.putDoc('exercises', 'x', { id: 'x' }, { create: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'offline');
  assert.equal(result.offline, true);
  assert.equal(calls, 0);
});
