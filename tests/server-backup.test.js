import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDailyBackup, readArchive, writeArchive, BACKUP_FORMAT, BACKUP_VERSION, BLOB_CHUNK_BYTES, MAX_LINE_BYTES, MAX_RECORD_BYTES, RECORD_OVERHEAD_BYTES } from '../server/backup.js';
import { restoreBackup } from '../server/restore.js';
import {
  RESTORE_ENTRY,
  createClient,
  gzipRecords,
  manualClock,
  readArchiveBuffer,
  runToExit,
  spawnServer,
  startServer,
  tempDir,
} from './server-harness.js';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const putBlob = (client, bytes) => client.put(`/api/blobs/${sha(bytes)}`, { body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
const docOf = (archive, collection, id) => (archive.collections[collection] ?? []).find((item) => item.id === id);
const recordOf = (records, type) => records.find((record) => record.type === type);
const clone = (records) => records.map((record) => structuredClone(record));

test('backup: o escritor nunca emite linha que o leitor recusa (teto de linha coerente)', async (t) => {
  assert.equal(MAX_LINE_BYTES, MAX_RECORD_BYTES + RECORD_OVERHEAD_BYTES, 'o teto de linha é o teto do registro MAIS a folga');
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const { store, close } = await startServer(t, { dataDir });
  const createdAt = new Date().toISOString();
  const base = { dataId: store.dataId, seq: 1, createdAt, private: {}, blobs: [] };

  // Corpo EXATAMENTE no teto do registro (16 MiB): a folga de metadados cabe na
  // linha, então o leitor aceita o que o escritor produziu.
  const overhead = Buffer.byteLength(JSON.stringify({ blob: '' }));
  const body = { blob: 'x'.repeat(MAX_RECORD_BYTES - overhead) };
  const canonical = Buffer.from(JSON.stringify(body));
  assert.equal(canonical.length, MAX_RECORD_BYTES, 'corpo no teto exato do registro');
  const item = { id: 'no-teto', rev: '1', updatedAt: createdAt, sha256: sha(canonical), size: canonical.length, body };
  const written = await writeArchive(store, 'groovegoblin-2020-01-01.ndjson.gz', { ...base, collections: { exercises: [item] } });
  const read = await readArchive(join(dataDir, 'backups', written.name));
  assert.equal(read.collections.exercises[0].sha256, sha(canonical), 'ida e volta no teto do registro');
  assert.equal(read.collections.exercises[0].body.blob.length, body.blob.length);

  // Corpo acima do teto de linha: o escritor FALHA em vez de gravar um arquivo
  // que o readArchive recusaria; nada sobra em tmp/ nem vira arquivo em backups/.
  const tooBig = { blob: 'y'.repeat(MAX_LINE_BYTES) };
  const bigItem = { id: 'grande', rev: '1', updatedAt: createdAt, sha256: 'a'.repeat(64), size: 1, body: tooBig };
  await assert.rejects(
    writeArchive(store, 'groovegoblin-2020-01-02.ndjson.gz', { ...base, collections: { exercises: [bigItem] } }),
    (error) => error.code === 'backup_invalid',
  );
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), [], 'sem temporário depois da recusa');
  assert.ok(!(await readdir(join(dataDir, 'backups'))).includes('groovegoblin-2020-01-02.ndjson.gz'), 'nenhum arquivo inválido gravado');

  // O leitor recusa a MESMA linha grande demais: os dois lados têm o mesmo teto.
  const poisoned = join(dir, 'envenenado.ndjson.gz');
  await writeFile(poisoned, gzipRecords([
    { type: 'header', format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt, dataId: store.dataId, seq: 0 },
    { type: 'private', name: 'map', updatedAt: createdAt, sha256: 'b'.repeat(64), size: 1, body: { blob: 'z'.repeat(MAX_LINE_BYTES) } },
    { type: 'footer', docs: 0, private: 1, blobs: 0, blobBytes: 0 },
  ]));
  await assert.rejects(readArchive(poisoned), (error) => error.code === 'backup_invalid');
  await close();
});

test('backup diário: arquivo autocontido NDJSON, um por dia UTC, 14 mantidos, latest e por data', async (t) => {
  const dir = await tempDir(t);
  const now = manualClock('2026-09-01T10:00:00Z');
  const { client, store } = await startServer(t, { dataDir: join(dir, 'dados'), now });
  let rev = (await client.create('exercises', 'diario', { day: 0 })).json().rev;
  const blob = randomBytes(1500);
  await putBlob(client, blob);
  for (let day = 1; day <= 16; day += 1) {
    rev = (await client.update('exercises', 'diario', rev, { day })).json().rev;
    const made = await ensureDailyBackup(store, { keep: 14 });
    assert.ok(made, `dia ${day} criou`);
    assert.match(made.name, /^groovegoblin-\d{4}-\d{2}-\d{2}\.ndjson\.gz$/);
    assert.equal(await ensureDailyBackup(store, { keep: 14 }), null, 'segundo no mesmo dia não cria');
    now.advanceDays(1);
  }
  const list = (await client.get('/api/backups')).json();
  assert.equal(list.keep, 14);
  assert.equal(list.backups.length, 14);
  assert.equal(list.backups[0].date, '2026-09-16');
  assert.equal(list.backups[0].name, 'groovegoblin-2026-09-16.ndjson.gz');
  assert.equal(list.backups.at(-1).date, '2026-09-03', 'os dois mais antigos saíram');

  const latest = await client.get('/api/backups/latest');
  assert.equal(latest.status, 200);
  assert.equal(latest.headers['content-type'], 'application/gzip');
  assert.equal(latest.headers['content-disposition'], 'attachment; filename="groovegoblin-backup-2026-09-16.ndjson.gz"');
  assert.equal(latest.headers['cache-control'], 'private, no-store');
  const alias = await client.get('/api/backup');
  assert.equal(alias.status, 200, 'GET /api/backup (nome do pedido original) = o mais recente');
  assert.ok(alias.body.equals(latest.body));

  const archive = readArchiveBuffer(latest.body);
  assert.equal(archive.header.format, BACKUP_FORMAT);
  assert.equal(archive.header.version, BACKUP_VERSION);
  assert.deepEqual(docOf(archive, 'exercises', 'diario').body, { day: 16 });
  assert.equal(archive.footer.docs, 1);
  assert.equal(archive.footer.blobs, 1);
  assert.ok(archive.blobs.get(sha(blob)).bytes.equals(blob), 'bytes do blob dentro do backup');

  const older = readArchiveBuffer((await client.get('/api/backups/2026-09-05')).body);
  assert.deepEqual(docOf(older, 'exercises', 'diario').body, { day: 5 });
  assert.equal((await client.get('/api/backups/2026-09-01')).status, 404);
  assert.equal((await client.get('/api/backups/2026-9-1')).status, 404);
  assert.equal((await client.get('/api/backups/..%2fstate.json')).status, 400);
  assert.equal((await client.head('/api/backups/latest')).body.length, 0);
  const health = (await client.get('/api/health')).json();
  assert.deepEqual(health.backups, { count: 14, latest: '2026-09-16' });
  assert.ok(health.storage.backupBytes > 0);
});

test('backup captura docs, privados, bytes de blob e só isso, consistente com escritas em paralelo', async (t) => {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const { client } = await startServer(t, { dataDir });
  await client.put('/api/private/map', { json: { curso: { titulo: 'Curso Exemplo' } } });
  const blob = randomBytes(2048);
  await putBlob(client, blob);
  // Pasta de entrada da etapa 8 é staging: nada dela pode entrar no backup.
  await mkdir(join(dataDir, 'entrada'), { recursive: true });
  await writeFile(join(dataDir, 'entrada', 'bruto.bin'), randomBytes(4096));
  const writes = Array.from({ length: 40 }, (_, index) => client.create('exercises', `e-${index}`, { index }));
  const results = await Promise.all([...writes, client.post('/api/backups')]);
  const made = results.at(-1);
  assert.equal(made.status, 201);
  assert.match(made.json().name, /^groovegoblin-\d{4}-\d{2}-\d{2}\.ndjson\.gz$/);

  const latest = await client.get('/api/backups/latest');
  const archive = readArchiveBuffer(latest.body);
  const items = archive.collections.exercises ?? [];
  const ids = items.map((item) => item.id);
  const maxRev = Math.max(0, ...items.map((item) => Number(item.rev)));
  assert.equal(archive.header.seq, maxRev, 'seq do snapshot = última revisão capturada (estado de um instante)');
  for (const item of items) assert.equal(item.sha256, sha(JSON.stringify(item.body)));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(archive.private.map.body, { curso: { titulo: 'Curso Exemplo' } });
  assert.equal(archive.footer.blobs, 1);
  assert.ok(archive.blobs.get(sha(blob)).bytes.equals(blob));
  assert.deepEqual([...new Set(archive.records.map((r) => r.type))].sort(), [
    'blob-chunk', 'blob-end', 'blob-start', 'doc', 'footer', 'header', 'private',
  ], 'o arquivo só tem registros do formato');
  const raw = JSON.stringify(archive.records);
  assert.ok(!raw.includes('entrada'), 'arquivos de entrada (staging) não entram no backup');
  assert.ok(latest.body.length < 128 * 1024, 'backup não copiou os 4 KiB de entrada nem recursão de backups');
});

test('restauração real: repõe documentos, privados e os bytes exatos dos blobs; o resto é preservado', async (t) => {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const first = await startServer(t, { dataDir });
  const { client } = first;
  const kept = (await client.create('exercises', 'mantido', { v: 'backup' })).json();
  const estado = (await client.create('courseStates', 'estado', { watched: ['a'] })).json();
  await client.put('/api/private/catalog', { json: [{ id: 'x' }] });
  const pdf = Buffer.from(`%PDF-1.7 arquivo fictício\n${'x'.repeat(3000)}`);
  const audio = randomBytes(2 * BLOB_CHUNK_BYTES + 4321);
  await putBlob(client, pdf);
  await putBlob(client, audio);
  assert.equal((await client.post('/api/backups')).status, 201);
  const cursorAtBackup = (await client.get('/api/changes')).json().cursor;

  const downloaded = readArchiveBuffer((await client.get('/api/backups/latest')).body);
  const chunks = downloaded.blobs.get(sha(audio)).chunks;
  assert.equal(chunks.length, 3, 'blob grande sai em vários pedaços');
  assert.equal(chunks[0].length, BLOB_CHUNK_BYTES);
  assert.equal(chunks[1].length, BLOB_CHUNK_BYTES);
  assert.equal(chunks[2].length, 4321);
  assert.ok(downloaded.blobs.get(sha(audio)).bytes.equals(audio));
  assert.ok(recordOf(downloaded.records, 'blob-chunk').data.length <= Math.ceil(BLOB_CHUNK_BYTES / 3) * 4 + 4, 'pedaço em base64 é limitado');

  // Depois do backup: documento muda, outro é apagado, um terceiro nasce,
  // privado some e os dois blobs do backup são apagados.
  await client.update('exercises', 'mantido', kept.rev, { v: 'depois do backup' });
  await client.del('/api/docs/courseStates/estado', { headers: { 'If-Match': `"${estado.rev}"` } });
  await client.create('forms', 'criado-depois', { v: 1 });
  await client.del('/api/private/catalog');
  assert.equal((await client.del(`/api/blobs/${sha(pdf)}`)).status, 200);
  assert.equal((await client.del(`/api/blobs/${sha(audio)}`)).status, 200);
  const blobAfter = randomBytes(900);
  await putBlob(client, blobAfter);
  assert.equal((await client.get(`/api/blobs/${sha(audio)}`)).status, 404);
  const cursorBefore = (await client.get('/api/changes')).json().cursor;
  await first.close();

  const dry = await restoreBackup({ dataDir, latest: true });
  assert.equal(dry.applied, false);
  assert.equal(dry.docs, 2);
  assert.equal(dry.private, 1);
  assert.equal(dry.blobs, 2);
  assert.equal(dry.blobBytes, pdf.length + audio.length);
  assert.equal(dry.sameDataset, true);
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), [], 'dry-run não deixa temporários');

  const applied = await restoreBackup({ dataDir, latest: true, apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.restored, 2);
  assert.equal(applied.blobsInstalled, 2);
  assert.equal(applied.tombstoned, 1, 'documento criado depois do backup vira lápide');
  assert.match(applied.safetyBackup, /^pre-restore-\d{8}T\d{6}Z\.ndjson\.gz$/);
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), []);

  const safetyArchive = readArchiveBuffer(await readFile(join(dataDir, 'backups', applied.safetyBackup)));
  assert.equal(safetyArchive.header.version, BACKUP_VERSION);
  assert.deepEqual(docOf(safetyArchive, 'exercises', 'mantido').body, { v: 'depois do backup' }, 'snapshot pre-restore guarda o estado que seria perdido');
  assert.deepEqual([...safetyArchive.blobs.keys()], [sha(blobAfter)], 'pre-restore contém os blobs vivos imediatamente antes da restauração');
  assert.ok(safetyArchive.blobs.get(sha(blobAfter)).bytes.equals(blobAfter));

  const second = await startServer(t, { dataDir });
  assert.deepEqual((await second.client.get('/api/docs/exercises/mantido')).json(), { v: 'backup' });
  assert.deepEqual((await second.client.get('/api/docs/courseStates/estado')).json(), { watched: ['a'] });
  assert.deepEqual((await second.client.get('/api/private/catalog')).json(), [{ id: 'x' }]);
  const pdfBack = await second.client.get(`/api/blobs/${sha(pdf)}`);
  assert.equal(pdfBack.status, 200);
  assert.ok(pdfBack.body.equals(pdf), 'bytes do PDF idênticos');
  const audioBack = await second.client.get(`/api/blobs/${sha(audio)}`);
  assert.equal(audioBack.status, 200);
  assert.equal(sha(audioBack.body), sha(audio), 'bytes do áudio idênticos (multi-pedaço)');
  assert.equal((await second.client.get('/api/docs/forms/criado-depois')).json().deleted, true, 'lápide pelo feed');
  assert.equal((await second.client.get(`/api/blobs/${sha(blobAfter)}`)).status, 200, 'blob vivo fora do backup é preservado');
  const changes = (await second.client.get(`/api/changes?since=${cursorBefore}`)).json().changes;
  assert.deepEqual(changes.map((change) => `${change.collection}/${change.id}/${change.deleted}`).sort(), [
    'courseStates/estado/false', 'exercises/mantido/false', 'forms/criado-depois/true',
  ], 'clientes recebem a restauração pelo feed');
  assert.ok(changes.every((change) => Number(change.rev) > Number(cursorBefore.split('.')[1])), 'revs novas, nunca reaproveitadas');
  assert.equal((await second.client.get(`/api/changes?since=${cursorAtBackup}`)).status, 200, 'cursores antigos seguem válidos');
  const health = (await second.client.get('/api/health')).json();
  assert.equal(health.storage.docs, 2);
  assert.equal(health.storage.tombstones, 1);
  assert.equal(health.storage.blobs, 3, 'os dois do backup de volta + o que ficou');
  assert.equal(health.storage.missingObjects, 0);
});

test('restauração independente num data dir vazio reproduz documentos, privados e blobs', async (t) => {
  const dir = await tempDir(t);
  const source = join(dir, 'origem');
  const target = join(dir, 'novo');
  const first = await startServer(t, { dataDir: source });
  await first.client.create('exercises', 'levado', { v: 'portátil' });
  await first.client.put('/api/private/map', { json: { curso: { titulo: 'Curso Exemplo' } } });
  const blob = randomBytes(70_000);
  await putBlob(first.client, blob);
  assert.equal((await first.client.post('/api/backups')).status, 201);
  const buffer = (await first.client.get('/api/backups/latest')).body;
  await first.close();

  const file = join(dir, 'copia.ndjson.gz');
  await writeFile(file, buffer);
  const report = await restoreBackup({ dataDir: target, backupFile: file, apply: true });
  assert.equal(report.applied, true);
  assert.equal(report.sameDataset, false, 'data dir novo tem outro dataId');
  assert.equal(report.docs, 1);
  assert.equal(report.private, 1);
  assert.equal(report.blobsInstalled, 1);

  const second = await startServer(t, { dataDir: target });
  assert.deepEqual((await second.client.get('/api/docs/exercises/levado')).json(), { v: 'portátil' });
  assert.deepEqual((await second.client.get('/api/private/map')).json(), { curso: { titulo: 'Curso Exemplo' } });
  const back = await second.client.get(`/api/blobs/${sha(blob)}`);
  assert.equal(back.status, 200);
  assert.ok(back.body.equals(blob));
  assert.equal((await second.client.get('/api/health')).json().storage.blobs, 1);
});

test('restauração recusa arquivo truncado, adulterado ou incompleto sem tocar no estado vivo', async (t) => {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const { client, close } = await startServer(t, { dataDir });
  await client.create('exercises', 'a', { v: 1 });
  await putBlob(client, randomBytes(64));
  await client.post('/api/backups');
  const valid = readArchiveBuffer((await client.get('/api/backups/latest')).body);
  await close();
  const state = await readFile(join(dataDir, 'state.json'));

  const variants = [
    ['sem rodapé', () => clone(valid.records).filter((record) => record.type !== 'footer')],
    ['registro depois do rodapé', () => [...clone(valid.records), { type: 'footer', docs: 0, private: 0, blobs: 0, blobBytes: 0 }]],
    ['id repetido', () => { const out = clone(valid.records); out.push(structuredClone(recordOf(out, 'doc'))); return out; }],
    ['corpo adulterado', () => { const out = clone(valid.records); recordOf(out, 'doc').body = { v: 2 }; return out; }],
    ['coleção desconhecida', () => { const out = clone(valid.records); recordOf(out, 'doc').collection = 'music'; return out; }],
    ['registro desconhecido', () => { const out = clone(valid.records); out.splice(1, 0, { type: 'extra' }); return out; }],
    ['contagens do rodapé erradas', () => { const out = clone(valid.records); recordOf(out, 'footer').docs += 1; return out; }],
    ['blob adulterado', () => {
      const out = clone(valid.records);
      const chunk = recordOf(out, 'blob-chunk');
      const bytes = Buffer.from(chunk.data, 'base64');
      bytes[0] ^= 0xff;
      chunk.data = bytes.toString('base64');
      return out;
    }],
    ['blob truncado', () => clone(valid.records).filter((record) => record.type !== 'blob-end')],
    ['tamanho de blob mentido', () => {
      const out = clone(valid.records);
      recordOf(out, 'blob-start').size += 1;
      recordOf(out, 'blob-end').size += 1;
      return out;
    }],
  ];
  for (const [label, make] of variants) {
    const file = join(dir, `variante-${label.replace(/[^\w]+/g, '-')}.ndjson.gz`);
    await writeFile(file, gzipRecords(make()));
    await assert.rejects(restoreBackup({ dataDir, backupFile: file, apply: true }), (error) => error.code === 'backup_invalid', label);
    assert.ok((await readFile(join(dataDir, 'state.json'))).equals(state), `${label}: state.json intacto`);
    assert.equal((await readdir(join(dataDir, 'backups'))).filter((name) => name.startsWith('pre-restore')).length, 0, `${label}: sem snapshot pre-restore`);
    assert.deepEqual(await readdir(join(dataDir, 'tmp')), [], `${label}: sem temporários`);
  }

  const whole = gzipRecords(valid.records);
  const truncated = join(dir, 'truncado.ndjson.gz');
  await writeFile(truncated, whole.subarray(0, whole.length - 8));
  const notGzip = join(dir, 'nao-gzip.ndjson.gz');
  await writeFile(notGzip, 'isto não é gzip');
  const foreign = join(dir, 'outro-formato.ndjson.gz');
  await writeFile(foreign, gzipRecords([{ type: 'header', format: 'outra-coisa', version: 1, createdAt: 'x', dataId: '0'.repeat(16), seq: 0 }, { type: 'footer', docs: 0, private: 0, blobs: 0, blobBytes: 0 }]));
  for (const file of [truncated, notGzip, foreign, join(dir, 'nao-existe.ndjson.gz')]) {
    const result = await runToExit([RESTORE_ENTRY, '--data-dir', dataDir, '--backup', file, '--yes'], {});
    assert.equal(result.code, 1, file);
    assert.match(result.stderr, /Restauração recusada/);
    assert.ok(!result.stderr.includes(dir), 'erro sem caminho');
  }
  assert.ok((await readFile(join(dataDir, 'state.json'))).equals(state), 'state.json intacto depois do CLI');

  const usage = await runToExit([RESTORE_ENTRY, '--data-dir', 'relativo'], {});
  assert.equal(usage.code, 2);
  const dry = await runToExit([RESTORE_ENTRY, '--data-dir', dataDir, '--latest'], {});
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /1 documentos · 0 privados · 1 blobs \(64 bytes\)/);
  assert.match(dry.stdout, /Nada foi alterado/);
  assert.ok(!dry.stdout.includes(dataDir), 'saída só com contagens');
  const report = await restoreBackup({ dataDir, latest: true });
  assert.equal(report.applied, false);
  assert.equal(report.docs, 1);
  assert.equal(report.blobs, 1);
});

test('restauração pelo CLI: recusa com o servidor rodando e aplica com --yes', async (t) => {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const first = spawnServer({ GROOVE_DATA_DIR: dataDir });
  t.after(() => first.child.kill('SIGKILL'));
  const client = createClient(await first.ready, 'dev');
  const made = (await client.create('exercises', 'cli', { v: 'antes' })).json();
  await client.put('/api/private/map', { json: { curso: { titulo: 'Curso Exemplo' } } });
  const blob = randomBytes(5000);
  await putBlob(client, blob);
  assert.equal((await client.post('/api/backups')).status, 201);
  await client.update('exercises', 'cli', made.rev, { v: 'depois' });
  assert.equal((await client.del(`/api/blobs/${sha(blob)}`)).status, 200, 'blob apagado depois do backup');
  assert.equal((await client.get(`/api/blobs/${sha(blob)}`)).status, 404);

  const locked = await runToExit([RESTORE_ENTRY, '--data-dir', dataDir, '--latest', '--yes'], {});
  assert.equal(locked.code, 1);
  assert.match(locked.stderr, /Outro processo/);
  first.child.kill('SIGTERM');
  await first.exited;

  const applied = await runToExit([RESTORE_ENTRY, '--data-dir', dataDir, '--latest', '--yes'], {});
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /Restaurado: 1 documentos · 1 blobs repostos · 0 apagados/);
  for (const secret of ['cli', 'antes', 'depois', dataDir]) assert.ok(!applied.stdout.includes(secret), 'saída só com contagens');

  const second = spawnServer({ GROOVE_DATA_DIR: dataDir });
  t.after(() => second.child.kill('SIGKILL'));
  const after = createClient(await second.ready, 'dev');
  assert.deepEqual((await after.get('/api/docs/exercises/cli')).json(), { v: 'antes' });
  assert.ok((await after.get(`/api/blobs/${sha(blob)}`)).body.equals(blob));
  second.child.kill('SIGTERM');
  await second.exited;
});

test('restauração trata blobs já no disco: idêntico não é reescrito, truncado é corrigido', async (t) => {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const first = await startServer(t, { dataDir });
  const blob = randomBytes(4096);
  await putBlob(first.client, blob);
  assert.equal((await first.client.post('/api/backups')).status, 201);
  await first.close();

  const same = await restoreBackup({ dataDir, latest: true, apply: true });
  assert.equal(same.blobsInstalled, 0, 'blob idêntico já no disco não é reescrito');
  assert.deepEqual(await readdir(join(dataDir, 'tmp')), []);

  const path = join(dataDir, 'blobs', sha(blob).slice(0, 2), sha(blob));
  await writeFile(path, blob.subarray(0, 10));
  const fixed = await restoreBackup({ dataDir, latest: true, apply: true });
  assert.equal(fixed.blobsInstalled, 1, 'blob truncado no disco é substituído pelo do arquivo');
  const restarted = await startServer(t, { dataDir });
  const back = await restarted.client.get(`/api/blobs/${sha(blob)}`);
  assert.equal(back.status, 200);
  assert.equal(sha(back.body), sha(blob), 'bytes corretos depois do conserto');
});

test('lápides com mais de 180 dias saem no backup diário e cursores anteriores expiram', async (t) => {
  const dir = await tempDir(t);
  const now = manualClock('2026-01-01T12:00:00Z');
  const { client, store } = await startServer(t, { dataDir: join(dir, 'dados'), now });
  const old = (await client.create('forms', 'antigo', { v: 1 })).json();
  const cursorBefore = (await client.get('/api/changes')).json().cursor;
  await client.del('/api/docs/forms/antigo', { headers: { 'If-Match': `"${old.rev}"` } });
  await client.create('forms', 'vivo', { v: 2 });
  now.advanceDays(181);
  await ensureDailyBackup(store, { keep: 14 });
  assert.equal((await client.get('/api/health')).json().storage.tombstones, 0);
  const expired = await client.get(`/api/changes?since=${cursorBefore}`);
  assert.equal(expired.status, 410);
  assert.equal(expired.json().error, 'cursor_expired');
  const full = (await client.get('/api/changes')).json();
  assert.deepEqual(full.changes.map((change) => change.id), ['vivo'], 'ressincronizar do zero funciona');
  assert.equal((await client.get(`/api/changes?since=${full.cursor}`)).status, 200);
});
