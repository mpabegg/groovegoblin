// Fluxo real contra o servidor da etapa 6 (B1–B3), quando ele estiver no
// repositório. Fica DESLIGADO por padrão porque a etapa 7 não depende dele para
// passar: o harness dos outros testes já sobe um servidor HTTP de verdade que
// segue o mesmo contrato.
//
// Uso (depois do merge da etapa 6):
//   GROOVE_SYNC_REAL_SERVER=1 node --test tests/sync-real-server.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerClient } from '../src/server-client.js';
import { startRealServerIfAvailable } from './sync-harness.js';

const ENABLED = process.env.GROOVE_SYNC_REAL_SERVER === '1';

test('fluxo real: revisão por documento, feed, blobs por conteúdo e conversão', {
  skip: ENABLED ? false : 'defina GROOVE_SYNC_REAL_SERVER=1 com o servidor da etapa 6 no repositório',
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gg-sync-real-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = await startRealServerIfAvailable({ dataDir });
  if (!server) {
    t.skip('server/app.js não está neste repositório');
    return;
  }
  t.after(() => server.close());
  const client = createServerClient({ base: server.base, requestOrigin: server.origin });

  const probed = await client.probe();
  assert.equal(probed.ok, true);
  assert.equal(probed.health.service, 'groovegoblin');

  const created = await client.putDoc('exercises', 'ex-1', { id: 'ex-1', v: 1 }, { create: true });
  assert.equal(created.ok, true);
  assert.equal(created.status, 201);
  assert.equal(created.created, true);

  const updated = await client.putDoc('exercises', 'ex-1', { id: 'ex-1', v: 2 }, { rev: created.rev });
  assert.equal(updated.ok, true);

  // A revisão da criação agora está velha: o servidor recusa e devolve a atual.
  const stale = await client.putDoc('exercises', 'ex-1', { id: 'ex-1', v: 3 }, { rev: created.rev });
  assert.equal(stale.status, 412);
  assert.equal(typeof stale.conflict.rev, 'string');

  const read = await client.getDoc('exercises', 'ex-1');
  assert.equal(read.ok, true);
  assert.equal(read.body.v, 2);
  const unchanged = await client.getDoc('exercises', 'ex-1', { rev: read.rev });
  assert.equal(unchanged.notModified, true);

  const feed = await client.changes({ limit: 100 });
  assert.equal(feed.ok, true);
  assert.ok(feed.changes.some(change => change.collection === 'exercises' && change.id === 'ex-1'));

  const bytes = new Uint8Array([21, 22, 23, 24]);
  const digested = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const sha = [...new Uint8Array(digested)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const stored = await client.putBlob(sha, bytes);
  assert.equal(stored.ok, true);
  const readBack = await client.readBlob(sha);
  assert.equal(readBack.ok, true);
  assert.deepEqual([...readBack.bytes], [...bytes]);

  const map = JSON.parse(await readFile(new URL('./fixtures/course/map-example.json', import.meta.url), 'utf8'));
  const converted = await client.convert({ map });
  assert.equal(converted.ok, true);
  assert.equal(converted.saved, true);
  const document_ = await client.getDoc('courses', converted.courseId);
  assert.equal(document_.body.format, 'groovegoblin-course');

  const removed = await client.deleteBlob(sha);
  assert.equal(removed.ok, true);
});
