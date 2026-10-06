import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { send, startServer, tempDir } from './server-harness.js';

async function devServer(t, extra = {}) {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const running = await startServer(t, { dataDir, ...extra });
  return { ...running, dataDir, dir };
}

test('documento: criar, ler com ETag, 304, atualizar com If-Match, apagar em lápide e recriar', async (t) => {
  const { client } = await devServer(t);
  const created = await client.create('exercises', 'ex-1', { name: 'Arpejo', bars: 4 });
  assert.equal(created.status, 201);
  const { rev } = created.json();
  assert.equal(created.headers.etag, `"${rev}"`);

  const read = await client.get('/api/docs/exercises/ex-1');
  assert.equal(read.status, 200);
  assert.deepEqual(read.json(), { name: 'Arpejo', bars: 4 });
  assert.equal(read.headers.etag, `"${rev}"`);
  assert.equal(read.headers['cache-control'], 'private, no-store');
  assert.equal((await client.get('/api/docs/exercises/ex-1', { headers: { 'If-None-Match': `"${rev}"` } })).status, 304);
  const head = await client.head('/api/docs/exercises/ex-1');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);

  const updated = await client.update('exercises', 'ex-1', rev, { name: 'Arpejo', bars: 8 });
  assert.equal(updated.status, 200);
  const rev2 = updated.json().rev;
  assert.ok(Number(rev2) > Number(rev));

  const stale = await client.update('exercises', 'ex-1', rev, { name: 'velho' });
  assert.equal(stale.status, 412);
  assert.deepEqual(stale.json().current, { rev: rev2, deleted: false });
  assert.equal(stale.headers.etag, `"${rev2}"`);
  assert.equal((await client.create('exercises', 'ex-1', { x: 1 })).status, 412, 'If-None-Match * sobre doc vivo');
  assert.deepEqual((await client.get('/api/docs/exercises/ex-1')).json(), { name: 'Arpejo', bars: 8 });

  assert.equal((await client.put('/api/docs/exercises/ex-1', { json: {} })).status, 428);
  assert.equal((await client.put('/api/docs/exercises/ex-1', { json: {}, headers: { 'If-Match': `"${rev2}"`, 'If-None-Match': '*' } })).status, 400);
  assert.equal((await client.put('/api/docs/exercises/ex-1', { json: {}, headers: { 'If-Match': rev2 } })).status, 400, 'If-Match sem aspas');
  assert.equal((await client.put('/api/docs/exercises/ex-1', { json: {}, headers: { 'If-Match': '*' } })).status, 400);
  assert.equal((await client.del('/api/docs/exercises/ex-1')).status, 428);
  assert.equal((await client.del('/api/docs/exercises/ex-1', { headers: { 'If-Match': `"${rev}"` } })).status, 412);

  const removed = await client.del('/api/docs/exercises/ex-1', { headers: { 'If-Match': `"${rev2}"` } });
  assert.equal(removed.status, 200);
  assert.equal(removed.json().deleted, true);
  const gone = await client.get('/api/docs/exercises/ex-1');
  assert.equal(gone.status, 404);
  assert.equal(gone.json().deleted, true);
  assert.equal((await client.del('/api/docs/exercises/ex-1', { headers: { 'If-Match': `"${removed.json().rev}"` } })).status, 404);
  assert.equal((await client.update('exercises', 'ex-1', removed.json().rev, { a: 1 })).status, 412, 'lápide não aceita If-Match');
  const again = await client.create('exercises', 'ex-1', { name: 'de novo' });
  assert.equal(again.status, 201);
  assert.ok(Number(again.json().rev) > Number(removed.json().rev), 'rev nunca reaproveitada');
  assert.equal((await client.get('/api/docs/exercises/nunca-existiu')).status, 404);
});

test('coleções fixas e listagem só de vivos', async (t) => {
  const { client } = await devServer(t);
  const list = (await client.get('/api/docs')).json();
  assert.deepEqual(list.collections, ['exercises', 'forms', 'courses', 'courseStates', 'courseAttachments', 'todayQueues', 'routines', 'preferences']);
  for (const collection of list.collections) assert.equal((await client.create(collection, 'a', { c: collection })).status, 201, collection);
  const b = await client.create('forms', 'b', { x: 1 });
  await client.del('/api/docs/forms/b', { headers: { 'If-Match': `"${b.json().rev}"` } });
  const forms = (await client.get('/api/docs/forms')).json();
  assert.deepEqual(forms.items.map((item) => item.id), ['a']);
  assert.equal((await client.get('/api/docs/music')).status, 404);
  assert.equal((await client.create('music', 'a', {})).status, 404);
  assert.equal((await client.post('/api/docs/exercises/a', { json: {} })).status, 405);
  assert.equal((await client.post('/api/docs/exercises/a', { json: {} })).headers.allow, 'GET, HEAD, PUT, DELETE');
});

test('caminhos e ids estritos: codificado, travessia, duplicado e barra final → 400', async (t) => {
  const { client } = await devServer(t);
  for (const path of [
    '/api/docs/exercises/a%2Fb', '/api/docs/exercises/%2e%2e', '/api/docs/%65xercises/a', '/api/docs/exercises/a/',
    '/api//docs/exercises/a', '/api/docs/./exercises', '/api/docs/exercises/..', '/api/docs/exercises/a\\b', '/api/health/',
    '/api/docs/exercises/a%252e',
  ]) {
    const response = await client.get(path);
    assert.equal(response.status, 400, path);
    assert.equal(response.json().error, 'invalid_path', path);
  }
  for (const id of ['a..b', '-a', '.a', 'x'.repeat(129), '_a']) {
    const response = await client.get(`/api/docs/exercises/${id}`);
    assert.equal(response.status, 400, id);
    assert.equal(response.json().error, 'invalid_id');
  }
  assert.equal((await client.create('exercises', 'x'.repeat(128), {})).status, 201);
  assert.equal((await client.get('/api/changes?since=a&since=b')).json().error, 'invalid_query');
  assert.equal((await client.get('/api/changes?cursor=1')).status, 400);
  assert.equal((await client.get('/api/health?x=1')).status, 400);
});

test('corpo JSON: tipo, UTF-8, raiz objeto e tamanho limitados', async (t) => {
  const { client, port } = await devServer(t);
  const headers = { 'If-None-Match': '*' };
  assert.equal((await client.put('/api/docs/exercises/t', { body: '{}', headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await client.put('/api/docs/exercises/t', { body: '{}', headers })).status, 415, 'sem Content-Type');
  assert.equal((await client.put('/api/docs/exercises/t', { body: '{}', headers: { ...headers, 'Content-Type': 'application/json; charset=latin1' } })).status, 415);
  assert.equal((await client.put('/api/docs/exercises/t', { body: '{}', headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } })).status, 201);
  for (const body of ['{"a":', '[1,2]', 'null', '"texto"', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])]) {
    const response = await client.put('/api/docs/exercises/u', { body, headers: { ...headers, 'Content-Type': 'application/json' } });
    assert.equal(response.status, 400, String(body));
    assert.equal(response.json().error, 'invalid_json');
  }
  const big = Buffer.from(JSON.stringify({ blob: 'x'.repeat(4 * 1024 * 1024) }));
  const declared = await client.put('/api/docs/exercises/big', { body: big, headers: { ...headers, 'Content-Type': 'application/json' } });
  assert.equal(declared.status, 413);
  assert.equal(declared.json().error, 'payload_too_large');
  const chunked = await client.put('/api/docs/exercises/big', {
    chunks: Array.from({ length: 80 }, () => Buffer.alloc(64 * 1024, 0x20)),
    headers: { ...headers, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
  });
  assert.equal(chunked.status, 413, 'stream sem Content-Length também é cortado');
  assert.equal((await client.get('/api/docs/exercises/big')).status, 404);
  const course = await client.create('courses', 'curso', { blob: 'x'.repeat(5 * 1024 * 1024) });
  assert.equal(course.status, 201, 'cursos têm teto maior');
  const deep = '['.repeat(200000) + ']'.repeat(200000);
  const nested = await send(port, { method: 'PUT', path: '/api/docs/exercises/deep', headers: { Host: client.host, Origin: client.origin, 'Content-Type': 'application/json', 'If-None-Match': '*' }, body: `{"a":${deep}}` });
  assert.equal(nested.status, 400);
  assert.equal((await client.get('/api/health')).status, 200, 'servidor segue vivo');
});

test('corrida: várias escritas com a mesma revisão → exatamente uma vence', async (t) => {
  const { client } = await devServer(t);
  const base = (await client.create('routines', 'r', { v: 0 })).json().rev;
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => client.update('routines', 'r', base, { v: index + 1 })));
  const winners = results.filter((response) => response.status === 200);
  assert.equal(winners.length, 1);
  assert.equal(results.filter((response) => response.status === 412).length, 23);
  const final = await client.get('/api/docs/routines/r');
  assert.equal(final.headers.etag, `"${winners[0].json().rev}"`);
  const creates = await Promise.all(Array.from({ length: 12 }, (_, index) => client.create('routines', 'novo', { v: index })));
  assert.equal(creates.filter((response) => response.status === 201).length, 1);
  assert.equal(creates.filter((response) => response.status === 412).length, 11);
  const many = await Promise.all(Array.from({ length: 30 }, (_, index) => client.create('exercises', `p-${index}`, { index })));
  const revs = many.map((response) => Number(response.json().rev));
  assert.equal(new Set(revs).size, 30, 'revs únicas mesmo em paralelo');
});

test('changes: cursor, paginação, lápides, cursor de outro dataset e malformado', async (t) => {
  const { client, store } = await devServer(t);
  const empty = (await client.get('/api/changes')).json();
  assert.deepEqual(empty.changes, []);
  assert.equal(empty.cursor, `${store.dataId}.0`);
  const revs = {};
  for (const id of ['a', 'b', 'c', 'd', 'e']) revs[id] = (await client.create('exercises', id, { id })).json().rev;
  await client.update('exercises', 'a', revs.a, { id: 'a', v: 2 });
  await client.del('/api/docs/exercises/b', { headers: { 'If-Match': `"${revs.b}"` } });
  const seen = [];
  let cursor = empty.cursor;
  for (let page = 0; page < 10; page += 1) {
    const body = (await client.get(`/api/changes?since=${cursor}&limit=2`)).json();
    seen.push(...body.changes);
    cursor = body.cursor;
    if (!body.more) break;
  }
  assert.deepEqual(seen.map((change) => change.id), ['c', 'd', 'e', 'a', 'b']);
  assert.equal(seen.at(-1).deleted, true);
  const ordered = seen.map((change) => Number(change.rev));
  assert.deepEqual(ordered, [...ordered].sort((x, y) => x - y));
  assert.equal(cursor, `${store.dataId}.${store.seq}`);
  assert.deepEqual((await client.get(`/api/changes?since=${cursor}`)).json().changes, []);
  const fromStart = (await client.get('/api/changes')).json().changes;
  assert.equal(fromStart.length, 5, 'compactado: último estado de cada doc');

  const other = await client.get(`/api/changes?since=${'0'.repeat(16)}.1`);
  assert.equal(other.status, 410);
  assert.equal(other.json().error, 'cursor_reset');
  assert.equal((await client.get(`/api/changes?since=${store.dataId}.${store.seq + 5}`)).json().error, 'cursor_reset');
  for (const bad of ['abc', `${store.dataId}.-1`, `${store.dataId}.01`, `${store.dataId}`]) {
    assert.equal((await client.get(`/api/changes?since=${bad}`)).json().error, 'invalid_cursor', bad);
  }
  for (const limit of ['0', '1001', 'x', '-1']) assert.equal((await client.get(`/api/changes?limit=${limit}`)).status, 400, limit);
});

test('reinício: documentos, revisões, lápides e cursor persistem', async (t) => {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const first = await startServer(t, { dataDir });
  const a = (await first.client.create('preferences', 'geral', { tema: 'escuro' })).json();
  const b = (await first.client.create('todayQueues', 'hoje', { itens: [1, 2] })).json();
  await first.client.del('/api/docs/todayQueues/hoje', { headers: { 'If-Match': `"${b.rev}"` } });
  const cursor = (await first.client.get('/api/changes')).json().cursor;
  const dataId = first.store.dataId;
  await first.close();

  const second = await startServer(t, { dataDir });
  assert.equal(second.store.dataId, dataId);
  const read = await second.client.get('/api/docs/preferences/geral');
  assert.deepEqual(read.json(), { tema: 'escuro' });
  assert.equal(read.headers.etag, `"${a.rev}"`);
  assert.equal((await second.client.get('/api/docs/todayQueues/hoje')).json().deleted, true);
  assert.deepEqual((await second.client.get(`/api/changes?since=${cursor}`)).json().changes, []);
  const next = (await second.client.create('forms', 'f', {})).json();
  assert.ok(Number(next.rev) > Number(cursor.split('.')[1]));
});

test('logs: só método, rota-modelo, status e duração — sem ids', async (t) => {
  const { client, logs } = await devServer(t);
  await client.create('courses', 'curso-com-titulo-privado', { a: 1 });
  await client.get('/api/docs/courses/curso-com-titulo-privado');
  assert.ok(logs.some((line) => /^api PUT \/api\/docs\/courses\/:id 201 \d+ms$/.test(line)));
  assert.ok(logs.every((line) => !line.includes('titulo-privado')));
});

test('X-Groove-Rev: consistente no doc (GET/304/PUT/DELETE/412); listas e feed trazem a rev por registro', async (t) => {
  const { client } = await devServer(t);
  const created = await client.create('exercises', 'rev-1', { a: 1 });
  const rev = created.json().rev;
  assert.equal(created.headers['x-groove-rev'], rev, 'criação');
  assert.equal((await client.get('/api/docs/exercises/rev-1')).headers['x-groove-rev'], rev, 'leitura');
  const notModified = await client.get('/api/docs/exercises/rev-1', { headers: { 'If-None-Match': `"${rev}"` } });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers['x-groove-rev'], rev, '304');
  const updated = await client.update('exercises', 'rev-1', rev, { a: 2 });
  const rev2 = updated.json().rev;
  assert.equal(updated.headers['x-groove-rev'], rev2, 'atualização');
  const stale = await client.update('exercises', 'rev-1', rev, { a: 3 });
  assert.equal(stale.status, 412);
  assert.equal(stale.headers['x-groove-rev'], rev2, 'conflito 412');
  const removed = await client.del('/api/docs/exercises/rev-1', { headers: { 'If-Match': `"${rev2}"` } });
  assert.equal(removed.headers['x-groove-rev'], removed.json().rev, 'remoção');
  const gone = await client.get('/api/docs/exercises/rev-1');
  assert.equal(gone.status, 404);
  assert.equal(gone.headers['x-groove-rev'], removed.json().rev, 'lápide');
  const again = await client.del('/api/docs/exercises/rev-1', { headers: { 'If-Match': `"${removed.json().rev}"` } });
  assert.equal(again.status, 404);
  assert.equal(again.headers['x-groove-rev'], removed.json().rev, 'lápide na remoção');

  // Listas e feed NÃO têm rev singular no cabeçalho: cada registro carrega a sua.
  const list = await client.get('/api/docs/exercises');
  assert.equal(list.headers['x-groove-rev'], undefined, 'lista sem cabeçalho singular');
  assert.equal(list.headers.etag, undefined);
  const feed = await client.get('/api/changes');
  assert.equal(feed.headers['x-groove-rev'], undefined, 'feed sem cabeçalho singular');
  assert.ok(feed.json().changes.every((change) => typeof change.rev === 'string'));
});
