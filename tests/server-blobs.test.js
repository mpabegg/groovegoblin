import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRange, sniffBlob } from '../server/blobs.js';
import { startServer, tempDir } from './server-harness.js';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const OCTET = { 'Content-Type': 'application/octet-stream' };

function wav(size) {
  const data = randomBytes(size);
  data.write('RIFF', 0, 'ascii');
  data.write('WAVE', 8, 'ascii');
  return data;
}

async function blobServer(t, env = {}) {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  return { ...(await startServer(t, { dataDir, env })), dataDir };
}

test('parseRange: uma faixa, sufixo, aberta, insatisfazível e ignoradas', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=95-500', 100), { start: 95, end: 99 });
  assert.deepEqual(parseRange('bytes=100-', 100), { unsatisfiable: true });
  assert.deepEqual(parseRange('bytes=-0', 100), { unsatisfiable: true });
  assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  assert.equal(parseRange('bytes=9-1', 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
  assert.equal(parseRange(undefined, 100), null);
});

test('sniff: tipo pelo conteúdo; HTML/SVG/texto nunca viram documento executável', () => {
  assert.equal(sniffBlob(Buffer.from('%PDF-1.7\n')).type, 'application/pdf');
  assert.equal(sniffBlob(Buffer.from('ID3\x04')).type, 'audio/mpeg');
  assert.equal(sniffBlob(Buffer.from('OggS\0')).type, 'audio/ogg');
  assert.equal(sniffBlob(Buffer.from('fLaC')).type, 'audio/flac');
  assert.equal(sniffBlob(Buffer.from('\0\0\0\x20ftypM4A ')).type, 'audio/mp4');
  assert.equal(sniffBlob(Buffer.from('PK\x03\x04')).inline, false);
  for (const text of ['<!doctype html><script>', '<svg xmlns="x">', '<?xml ?>', 'texto qualquer']) {
    const kind = sniffBlob(Buffer.from(text));
    assert.equal(kind.type, 'application/octet-stream', text);
    assert.equal(kind.inline, false);
  }
});

test('blob: PUT verificado, GET byte a byte, HEAD, Range 206/416, If-Range, 304', async (t) => {
  const { client } = await blobServer(t);
  const data = wav(300 * 1024 + 7);
  const hash = sha(data);
  const put = await client.put(`/api/blobs/${hash}`, { body: data, headers: OCTET });
  assert.equal(put.status, 201);
  assert.deepEqual(put.json(), { sha256: hash, size: data.length, type: 'audio/wav', created: true });
  const again = await client.put(`/api/blobs/${hash}`, { body: data, headers: OCTET });
  assert.equal(again.status, 200);
  assert.equal(again.json().created, false);

  const full = await client.get(`/api/blobs/${hash}`);
  assert.equal(full.status, 200);
  assert.ok(full.body.equals(data), 'bytes idênticos');
  assert.equal(full.headers['content-type'], 'audio/wav');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers.etag, `"${hash}"`);
  assert.equal(full.headers['cache-control'], 'private, no-store');
  assert.equal(full.headers['x-content-type-options'], 'nosniff');
  assert.equal(full.headers['content-disposition'], `inline; filename="${hash.slice(0, 12)}.wav"`);
  assert.match(full.headers['content-security-policy'], /media-src 'self'/);

  const head = await client.head(`/api/blobs/${hash}`);
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], String(data.length));
  assert.equal(head.body.length, 0);

  for (const [range, start, end] of [['bytes=0-99', 0, 99], ['bytes=1000-', 1000, data.length - 1], ['bytes=-77', data.length - 77, data.length - 1], ['bytes=5-5', 5, 5]]) {
    const part = await client.get(`/api/blobs/${hash}`, { headers: { Range: range } });
    assert.equal(part.status, 206, range);
    assert.equal(part.headers['content-range'], `bytes ${start}-${end}/${data.length}`);
    assert.ok(part.body.equals(data.subarray(start, end + 1)), range);
  }
  const unsatisfiable = await client.get(`/api/blobs/${hash}`, { headers: { Range: `bytes=${data.length}-` } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers['content-range'], `bytes */${data.length}`);
  assert.equal((await client.get(`/api/blobs/${hash}`, { headers: { Range: 'bytes=0-1,4-5' } })).status, 200);
  assert.equal((await client.get(`/api/blobs/${hash}`, { headers: { Range: 'bytes=0-9', 'If-Range': '"outro"' } })).status, 200);
  assert.equal((await client.get(`/api/blobs/${hash}`, { headers: { Range: 'bytes=0-9', 'If-Range': `"${hash}"` } })).status, 206);
  assert.equal((await client.get(`/api/blobs/${hash}`, { headers: { 'If-None-Match': `"${hash}"` } })).status, 304);
});

test('blob: hash errado, tipo errado, endereço inválido e excesso de tamanho', async (t) => {
  const { client, dataDir } = await blobServer(t, { GROOVE_MAX_BLOB_BYTES: String(1024 * 1024) });
  const data = randomBytes(1000);
  const mismatch = await client.put(`/api/blobs/${sha(Buffer.from('outro'))}`, { body: data, headers: OCTET });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json().error, 'hash_mismatch');
  assert.equal((await client.get(`/api/blobs/${sha(Buffer.from('outro'))}`)).status, 404);
  assert.equal((await client.put(`/api/blobs/${sha(data)}`, { body: data, headers: { 'Content-Type': 'audio/wav' } })).status, 415);
  assert.equal((await client.put(`/api/blobs/${sha(data)}`, { body: data })).status, 415);
  for (const bad of [sha(data).toUpperCase(), sha(data).slice(1), `${sha(data)}0`, 'nao-hex']) {
    assert.equal((await client.get(`/api/blobs/${bad}`)).status, 400, bad);
  }
  const big = randomBytes(1024 * 1024 + 1);
  const declared = await client.put(`/api/blobs/${sha(big)}`, { body: big, headers: OCTET });
  assert.equal(declared.status, 413);
  const streamed = await client.put(`/api/blobs/${sha(big)}`, {
    chunks: Array.from({ length: 20 }, (_, index) => big.subarray(index * 65536, (index + 1) * 65536)).concat([big.subarray(20 * 65536)]),
    headers: { ...OCTET, 'Transfer-Encoding': 'chunked' },
  });
  assert.equal(streamed.status, 413);
  assert.equal((await client.get(`/api/blobs/${sha(big)}`)).status, 404);
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), [], 'nenhum temporário sobra');
  const exact = randomBytes(1024 * 1024);
  assert.equal((await client.put(`/api/blobs/${sha(exact)}`, { body: exact, headers: OCTET })).status, 201, 'no limite exato passa');
});

test('blob: HTML disfarçado sai como download sandbox; PDF inline para o painel', async (t) => {
  const { client } = await blobServer(t);
  const html = Buffer.from('<!doctype html><script>alert(1)</script>');
  await client.put(`/api/blobs/${sha(html)}`, { body: html, headers: OCTET });
  const evil = await client.get(`/api/blobs/${sha(html)}`);
  assert.equal(evil.headers['content-type'], 'application/octet-stream');
  assert.match(evil.headers['content-disposition'], /^attachment; filename="[0-9a-f]{12}\.bin"$/);
  assert.match(evil.headers['content-security-policy'], /sandbox/);
  const pdf = Buffer.from('%PDF-1.4\n% teste\n');
  await client.put(`/api/blobs/${sha(pdf)}`, { body: pdf, headers: OCTET });
  const doc = await client.get(`/api/blobs/${sha(pdf)}`);
  assert.equal(doc.headers['content-type'], 'application/pdf');
  assert.match(doc.headers['content-disposition'], /^inline; filename="[0-9a-f]{12}\.pdf"$/);
  assert.match(doc.headers['content-security-policy'], /frame-ancestors 'self'/);
  const empty = Buffer.alloc(0);
  assert.equal((await client.put(`/api/blobs/${sha(empty)}`, { body: empty, headers: OCTET })).status, 201);
  const zero = await client.get(`/api/blobs/${sha(empty)}`);
  assert.equal(zero.status, 200);
  assert.equal(zero.body.length, 0);
});

test('blob: DELETE, contadores usados/livres e symlink plantado nunca é servido', async (t) => {
  const { client, dataDir } = await blobServer(t);
  const before = (await client.get('/api/health')).json().storage;
  assert.equal(before.blobs, 0);
  assert.ok(before.freeBytes > 0);
  const data = randomBytes(5000);
  await client.put(`/api/blobs/${sha(data)}`, { body: data, headers: OCTET });
  const during = (await client.get('/api/health')).json().storage;
  assert.equal(during.blobs, 1);
  assert.equal(during.blobBytes, 5000);
  assert.ok(during.usedBytes >= 5000);
  const removed = await client.del(`/api/blobs/${sha(data)}`);
  assert.equal(removed.status, 200);
  assert.equal((await client.get(`/api/blobs/${sha(data)}`)).status, 404);
  assert.equal((await client.del(`/api/blobs/${sha(data)}`)).status, 404);
  const after = (await client.get('/api/health')).json().storage;
  assert.equal(after.blobs, 0);
  assert.equal(after.blobBytes, 0);

  const secret = join(dataDir, '..', 'fora.txt');
  await writeFile(secret, 'segredo fora do data dir');
  const fake = sha(Buffer.from('segredo fora do data dir'));
  await mkdir(join(dataDir, 'blobs', fake.slice(0, 2)), { recursive: true });
  await symlink(secret, join(dataDir, 'blobs', fake.slice(0, 2), fake));
  const leak = await client.get(`/api/blobs/${fake}`);
  assert.equal(leak.status, 404);
  assert.ok(!leak.text().includes('segredo'));
});

test('blob: sem espaço livre acima da reserva → 507 sem gravar', async (t) => {
  const { client, dataDir } = await blobServer(t, { GROOVE_MIN_FREE_BYTES: String(1024 * 1024 * 1024 * 1024) });
  const data = randomBytes(100);
  const response = await client.put(`/api/blobs/${sha(data)}`, { body: data, headers: OCTET });
  assert.equal(response.status, 507);
  assert.equal(response.json().error, 'insufficient_storage');
  assert.equal((await client.create('exercises', 'x', { a: 1 })).status, 507);
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), []);
});

test('blob: upload sem Content-Length (chunked) também respeita a reserva → 507 sem gravar', async (t) => {
  const { client, dataDir } = await blobServer(t, { GROOVE_MIN_FREE_BYTES: String(1024 * 1024 * 1024 * 1024) });
  const data = randomBytes(4096);
  const response = await client.put(`/api/blobs/${sha(data)}`, {
    chunks: [data.subarray(0, 2048), data.subarray(2048)],
    headers: { ...OCTET, 'Transfer-Encoding': 'chunked' },
  });
  assert.equal(response.status, 507, 'sem Content-Length a reserva é o teto inteiro do blob');
  assert.equal(response.json().error, 'insufficient_storage');
  assert.equal((await client.get(`/api/blobs/${sha(data)}`)).status, 404);
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), [], 'nenhum temporário sobra');
  assert.equal((await client.get('/api/health')).json().storage.blobs, 0);
});
