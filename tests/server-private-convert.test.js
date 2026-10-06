import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertCourseMap } from '../scripts/convert-course-map.js';
import { serializeCourse } from '../src/course-format.js';
import { startServer, tempDir } from './server-harness.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/course/${name}`, import.meta.url), 'utf8'));
const CATALOG = [{ id: 'exercicio-ficticio-1', origem_tipo: 'workbook', familia: 'arpejo_triade_forma_unica', aula_id: 1 }];

async function server(t) {
  const dir = await tempDir(t);
  return startServer(t, { dataDir: join(dir, 'dados') });
}

test('privados: PUT/GET/DELETE só map e catalog, download anexo e sem cache', async (t) => {
  const { client } = await server(t);
  assert.deepEqual((await client.get('/api/health')).json().private, { map: false, catalog: false });
  const map = fixture('map-example.json');
  const put = await client.put('/api/private/map', { json: map });
  assert.equal(put.status, 201);
  assert.match(put.json().sha256, /^[0-9a-f]{64}$/);
  assert.equal((await client.put('/api/private/map', { json: map })).status, 200);
  const read = await client.get('/api/private/map');
  assert.deepEqual(read.json(), map);
  assert.equal(read.headers['content-disposition'], 'attachment; filename="groovegoblin-private-map.json"');
  assert.equal(read.headers['cache-control'], 'private, no-store');
  assert.equal((await client.put('/api/private/catalog', { json: CATALOG })).status, 201, 'catálogo pode ser lista');
  assert.deepEqual((await client.get('/api/health')).json().private, { map: true, catalog: true });
  assert.equal((await client.get('/api/private/outro')).status, 404);
  assert.equal((await client.put('/api/private/outro', { json: {} })).status, 404);
  assert.equal((await client.put('/api/private/map', { body: 'x', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await client.del('/api/private/catalog')).status, 200);
  assert.equal((await client.get('/api/private/catalog')).status, 404);
  assert.equal((await client.del('/api/private/catalog')).status, 404);
  const storage = (await client.get('/api/health')).json().storage;
  assert.equal(storage.privateBytes, Buffer.from(JSON.stringify(map)).length, 'catálogo apagado liberou espaço');
});

test('convert: usa o conversor do repositório, guarda o mapa privado e salva o curso', async (t) => {
  const { client } = await server(t);
  const map = fixture('map-example.json');
  const response = await client.post('/api/courses/convert', { json: { map } });
  assert.equal(response.status, 201);
  const body = response.json();
  const expected = convertCourseMap(map, { includeProgress: false });
  const canonical = serializeCourse(expected.document).document;
  assert.equal(body.ok, true);
  assert.equal(body.saved, true);
  assert.equal(body.created, true);
  assert.equal(body.courseId, canonical.course.id);
  assert.deepEqual(body.counts, expected.counts);
  assert.deepEqual(body.warnings, expected.warnings);
  assert.deepEqual(body.private, { map: 'stored', catalog: 'none' });
  for (const warning of body.warnings) assert.deepEqual(Object.keys(warning).sort(), ['code', 'message', 'path']);

  const saved = await client.get(`/api/docs/courses/${body.courseId}`);
  assert.deepEqual(saved.json(), canonical, 'mesmo documento que o conversor gera');
  assert.equal(saved.headers.etag, `"${body.rev}"`);
  assert.deepEqual((await client.get('/api/private/map')).json(), map);
  const change = (await client.get('/api/changes')).json().changes.find((item) => item.collection === 'courses');
  assert.equal(change.rev, body.rev);

  const conflict = await client.post('/api/courses/convert', { json: { map } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json().rev, body.rev);
  const stale = await client.post('/api/courses/convert', { json: { expectedRev: String(Number(body.rev) + 99) } });
  assert.equal(stale.status, 409);
  const reused = await client.post('/api/courses/convert', { json: { expectedRev: body.rev, includeProgress: true } });
  assert.equal(reused.status, 200);
  assert.equal(reused.json().private.map, 'reused');
  assert.ok(Number(reused.json().rev) > Number(body.rev));
  assert.ok((await client.get(`/api/docs/courses/${body.courseId}`)).json().progress, 'includeProgress repassado');
});

test('convert: catálogo é guardado e repassado; null converte sem catálogo', async (t) => {
  const { client } = await server(t);
  const map = fixture('map-example.json');
  const first = await client.post('/api/courses/convert', { json: { map, catalog: CATALOG, dryRun: true } });
  assert.equal(first.status, 200);
  assert.equal(first.json().saved, false);
  assert.deepEqual(first.json().private, { map: 'provided', catalog: 'provided' });
  assert.deepEqual((await client.get('/api/health')).json().private, { map: false, catalog: false }, 'dryRun não guarda nada');
  assert.equal((await client.get('/api/docs/courses')).json().items.length, 0);

  const stored = await client.post('/api/courses/convert', { json: { map, catalog: CATALOG } });
  assert.equal(stored.status, 201);
  assert.deepEqual(stored.json().private, { map: 'stored', catalog: 'stored' });
  assert.deepEqual((await client.get('/api/private/catalog')).json(), CATALOG);
  const rev = stored.json().rev;
  const reuse = await client.post('/api/courses/convert', { json: { expectedRev: rev } });
  assert.deepEqual(reuse.json().private, { map: 'reused', catalog: 'reused' });
  const none = await client.post('/api/courses/convert', { json: { expectedRev: reuse.json().rev, catalog: null } });
  assert.deepEqual(none.json().private, { map: 'reused', catalog: 'none' });
  assert.equal((await client.get('/api/private/catalog')).status, 200, 'null não apaga o catálogo guardado');
});

test('convert: mapa incompatível → 422 sem curso; pedido malformado → 400; sem mapa → 404', async (t) => {
  const { client } = await server(t);
  const missing = await client.post('/api/courses/convert', { json: {} });
  assert.equal(missing.status, 404);
  assert.equal(missing.json().error, 'private_missing');
  const six = await client.post('/api/courses/convert', { json: { map: fixture('map-six-strings.json') } });
  assert.equal(six.status, 422);
  assert.equal(six.json().error, 'conversion_invalid');
  assert.ok(six.json().problems.length > 0);
  assert.ok(six.json().problems.every((problem) => typeof problem.path === 'string'));
  assert.equal((await client.get('/api/docs/courses')).json().items.length, 0, 'nada em courses');
  assert.equal((await client.get('/api/private/map')).status, 200, 'entrada privada guardada para reconverter depois');
  for (const json of [{ map: [] }, { map: null }, { map: {}, extra: 1 }, { map: {}, dryRun: 'sim' }, { map: {}, expectedRev: 3 }]) {
    assert.equal((await client.post('/api/courses/convert', { json })).status, 400, JSON.stringify(json));
  }
  assert.equal((await client.post('/api/courses/convert', { body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await client.get('/api/courses/convert')).status, 405);
});

test('convert: a assinatura convertCourseMap(map, { includeProgress, catalog }) chega ao conversor real', async (t) => {
  const dir = await tempDir(t);
  const calls = [];
  const recording = (map, options) => {
    calls.push({ map, options });
    return convertCourseMap(map, options);
  };
  const { client } = await startServer(t, { dataDir: join(dir, 'dados'), convertMap: recording });
  const map = fixture('map-example.json');
  await client.post('/api/courses/convert', { json: { map, catalog: CATALOG, includeProgress: true } });
  assert.deepEqual(calls[0].map, map);
  assert.deepEqual(calls[0].options, { includeProgress: true, catalog: CATALOG });
  await client.post('/api/courses/convert', { json: { catalog: null, dryRun: true } });
  assert.deepEqual(calls[1].options, { includeProgress: false }, 'sem catálogo a chave nem vai');
  await client.post('/api/courses/convert', { json: { dryRun: true } });
  assert.deepEqual(calls[2].options.catalog, CATALOG, 'catálogo guardado é reaproveitado');
});

test('convert: map/catalog acima de 16 MiB → 413 sem tocar no privado anterior', async (t) => {
  const { client } = await server(t);
  const map = fixture('map-example.json');
  assert.equal((await client.put('/api/private/map', { json: map })).status, 201);
  const before = await client.get('/api/private/map');

  // Mapa grande demais: o teto do registro (16 MiB) não é o do envelope (32 MiB).
  const hugeMap = { curso: { titulo: 'x'.repeat(17 * 1024 * 1024) } };
  const oversizeMap = await client.post('/api/courses/convert', { json: { map: hugeMap } });
  assert.equal(oversizeMap.status, 413);
  assert.equal(oversizeMap.json().error, 'payload_too_large');
  const afterMap = await client.get('/api/private/map');
  assert.deepEqual(afterMap.json(), map, 'mapa privado anterior intacto');
  assert.equal(afterMap.headers.etag, before.headers.etag, 'o privado anterior não foi regravado');
  assert.equal((await client.get('/api/docs/courses')).json().items.length, 0, 'nada em courses');

  // Catálogo grande demais não pode gravar o mapa que veio no MESMO pedido.
  const catalogOversize = await client.post('/api/courses/convert', {
    json: { map: { outro: { titulo: 'pequeno' } }, catalog: ['y'.repeat(16 * 1024 * 1024 + 64)] },
  });
  assert.equal(catalogOversize.status, 413);
  assert.deepEqual((await client.get('/api/private/map')).json(), map, 'o mapa do pedido recusado não foi gravado');
  assert.equal((await client.get('/api/private/catalog')).status, 404);
});
