import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openStore } from '../server/store.js';
import { createClient, spawnServer, startServer, tempDir } from './server-harness.js';

const sha = (data) => createHash('sha256').update(data).digest('hex');

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

// Caminho relativo -> bytes, para provar que nada mudou.
async function snapshotTree(root) {
  const files = new Map();
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${relative}/`);
      else if (entry.isFile()) files.set(relative, await readFile(join(dir, entry.name)));
    }
  };
  try {
    await walk(root, '');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return files;
}

test('SIGKILL no meio de escritas: tudo confirmado sobrevive, doc e feed consistentes, lock retomado', async (t) => {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const first = spawnServer({ GROOVE_DATA_DIR: dataDir });
  t.after(() => first.child.kill('SIGKILL'));
  const client = createClient(await first.ready, 'dev');
  const acked = new Map();
  let stop = false;
  const worker = async (index) => {
    const id = `w-${index}`;
    let rev = null;
    for (let step = 0; !stop; step += 1) {
      const body = { worker: index, step, padding: 'x'.repeat(2000) };
      try {
        const response = rev === null ? await client.create('exercises', id, body) : await client.update('exercises', id, rev, body);
        if (response.status !== 200 && response.status !== 201) break;
        rev = response.json().rev;
        acked.set(id, { rev, body });
      } catch {
        break; // conexão cortada pelo SIGKILL
      }
    }
  };
  const slowBlob = randomBytes(8 * 1024 * 1024);
  const blobUpload = client.put(`/api/blobs/${sha(slowBlob)}`, {
    chunks: Array.from({ length: 128 }, (_, index) => slowBlob.subarray(index * 65536, (index + 1) * 65536)),
    headers: { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' },
  }).catch(() => null);
  const workers = Array.from({ length: 6 }, (_, index) => worker(index));
  await new Promise((resolve) => setTimeout(resolve, 400));
  first.child.kill('SIGKILL');
  stop = true;
  await Promise.all(workers);
  await blobUpload;
  assert.equal((await first.exited).signal, 'SIGKILL');
  assert.ok(acked.size > 0 && [...acked.values()].some((item) => Number(item.rev) > 6), 'houve escrita de verdade antes da queda');

  const second = spawnServer({ GROOVE_DATA_DIR: dataDir });
  t.after(() => second.child.kill('SIGKILL'));
  const after = createClient(await second.ready, 'dev');
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), [], 'temporários limpos na subida');
  for (const [id, item] of acked) {
    const read = await after.get(`/api/docs/exercises/${id}`);
    assert.equal(read.status, 200, id);
    const rev = Number(read.headers.etag.slice(1, -1));
    assert.ok(rev >= Number(item.rev), 'nada confirmado se perdeu');
    if (rev === Number(item.rev)) assert.deepEqual(read.json(), item.body);
  }
  const feed = (await after.get('/api/changes?limit=1000')).json();
  const revs = feed.changes.map((change) => Number(change.rev));
  assert.deepEqual(revs, [...new Set(revs)].sort((a, b) => a - b));
  for (const change of feed.changes) {
    const read = await after.get(`/api/docs/${change.collection}/${change.id}`);
    assert.equal(read.headers.etag, `"${change.rev}"`, 'feed e documento apontam o mesmo commit');
    assert.equal(typeof read.json().worker, 'number');
  }
  const health = (await after.get('/api/health')).json();
  assert.equal(health.storage.missingObjects, 0);
  assert.equal(health.cursor, feed.cursor);
  const blob = await after.head(`/api/blobs/${sha(slowBlob)}`);
  assert.ok(blob.status === 404 || blob.headers['content-length'] === String(slowBlob.length), 'blob inteiro ou ausente, nunca parcial');
  second.child.kill('SIGTERM');
  await second.exited;
});

test('sobras de queda (objeto órfão, temporário, privado órfão, lock de processo morto) são limpas', async (t) => {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const first = await startServer(t, { dataDir });
  const created = (await first.client.create('forms', 'f', { a: 1 })).json();
  await first.close();

  const orphan = Buffer.from('{"orfao":true}');
  await mkdir(join(dataDir, 'objects', sha(orphan).slice(0, 2)), { recursive: true });
  await writeFile(join(dataDir, 'objects', sha(orphan).slice(0, 2), sha(orphan)), orphan);
  await writeFile(join(dataDir, 'private', sha(orphan)), orphan);
  await writeFile(join(dataDir, 'tmp', 'write-123-abc'), 'pela metade');
  await writeFile(join(dataDir, 'server.lock'), JSON.stringify({ pid: await deadPid(), start: '1', bootId: null }));

  const second = await startServer(t, { dataDir });
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), []);
  await assert.rejects(readFile(join(dataDir, 'objects', sha(orphan).slice(0, 2), sha(orphan))), { code: 'ENOENT' });
  await assert.rejects(readFile(join(dataDir, 'private', sha(orphan))), { code: 'ENOENT' });
  const read = await second.client.get('/api/docs/forms/f');
  assert.deepEqual(read.json(), { a: 1 });
  assert.equal(read.headers.etag, `"${created.rev}"`);
});

test('state.json ausente com dados no disco: recusa subir sem apagar objetos, privados nem blobs', async (t) => {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const first = await startServer(t, { dataDir });
  await first.client.create('forms', 'f', { a: 1 });
  const blob = randomBytes(2048);
  await first.client.put(`/api/blobs/${sha(blob)}`, { body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
  await first.client.put('/api/private/map', { json: { curso: { titulo: 'Curso Exemplo' } } });
  await first.close();

  const before = {
    objects: await snapshotTree(join(dataDir, 'objects')),
    private: await snapshotTree(join(dataDir, 'private')),
    blobs: await snapshotTree(join(dataDir, 'blobs')),
  };
  assert.ok(before.objects.size >= 1 && before.private.size === 1 && before.blobs.size === 1, 'há dados de verdade no disco');

  await rm(join(dataDir, 'state.json'));
  await assert.rejects(openStore({ dataDir }), { code: 'state_corrupt' }, 'state.json ausente com dados recusa subir');
  await assert.rejects(readFile(join(dataDir, 'state.json')), { code: 'ENOENT' }, 'nenhum state.json vazio foi sintetizado');
  assert.deepEqual(await snapshotTree(join(dataDir, 'objects')), before.objects, 'objetos byte a byte idênticos');
  assert.deepEqual(await snapshotTree(join(dataDir, 'private')), before.private, 'privados byte a byte idênticos');
  assert.deepEqual(await snapshotTree(join(dataDir, 'blobs')), before.blobs, 'blobs byte a byte idênticos');
  await assert.rejects(readFile(join(dataDir, 'server.lock')), { code: 'ENOENT' }, 'lock não foi criado na recusa');
});

test('state.json ausente com SÓ blobs no disco: sobe com estado vazio e não apaga blob nenhum', async (t) => {
  // Blobs não são governados pelo manifesto (o init só os conta) e nenhum
  // caminho de subida os apaga: um data dir que só recebeu blobs ainda não
  // commitou documento nenhum e NÃO é corrupção. O manifesto ausente com
  // objetos/privados é que é perda de dados (teste acima).
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const first = await startServer(t, { dataDir });
  const blob = randomBytes(1024);
  await first.client.put(`/api/blobs/${sha(blob)}`, { body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
  await first.close();

  const beforeBlobs = await snapshotTree(join(dataDir, 'blobs'));
  assert.equal(beforeBlobs.size, 1, 'há um blob de verdade no disco');
  assert.equal(await readdir(join(dataDir, 'objects')).then((items) => items.length), 0);
  await assert.rejects(readFile(join(dataDir, 'state.json')), { code: 'ENOENT' }, 'o manifesto nunca foi escrito');

  const reopened = await openStore({ dataDir });
  assert.equal(reopened.counts().blobs, 1, 'o blob continua contado');
  assert.deepEqual(await snapshotTree(join(dataDir, 'blobs')), beforeBlobs, 'blob byte a byte idêntico');
  await reopened.close();

  const restarted = await startServer(t, { dataDir });
  const back = await restarted.client.get(`/api/blobs/${sha(blob)}`);
  assert.equal(back.status, 200, 'o blob continua servível depois da reabertura');
  assert.ok(back.body.equals(blob));
});

test('state.json ilegível ou inconsistente: recusa subir e não reescreve nada', async (t) => {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const first = await startServer(t, { dataDir });
  await first.client.create('forms', 'f', { a: 1 });
  await first.close();
  const statePath = join(dataDir, 'state.json');
  const good = await readFile(statePath, 'utf8');
  for (const broken of [good.slice(0, 20), JSON.stringify({ ...JSON.parse(good), seq: 0 }), JSON.stringify({ ...JSON.parse(good), dataId: 'f'.repeat(16) })]) {
    await writeFile(statePath, broken);
    await assert.rejects(openStore({ dataDir }), { code: 'state_corrupt' });
    assert.equal(await readFile(statePath, 'utf8'), broken, 'arquivo intacto para perícia');
    await assert.rejects(readFile(join(dataDir, 'server.lock')), { code: 'ENOENT' }, 'lock liberado na recusa');
  }
  await writeFile(statePath, good);
  const store = await openStore({ dataDir });
  assert.equal(store.entry('forms', 'f').rev, '1');
  await store.close();
});

test('subpasta interna trocada por symlink é recusada; init interrompido é retomado', async (t) => {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const store = await openStore({ dataDir });
  await store.close();
  await rename(join(dataDir, 'objects'), join(dir, 'objetos-fora'));
  await symlink(join(dir, 'objetos-fora'), join(dataDir, 'objects'));
  await assert.rejects(openStore({ dataDir }), { code: 'unsafe_layout' });

  const fresh = join(dir, 'novo');
  await mkdir(fresh);
  await writeFile(join(fresh, '.groovegoblin-init-abc123'), 'marcador pela metade');
  const resumed = await openStore({ dataDir: fresh });
  assert.match(resumed.dataId, /^[0-9a-f]{16}$/);
  await resumed.close();
  assert.ok(!(await readdir(fresh)).some((name) => name.startsWith('.groovegoblin-init-')));
});
