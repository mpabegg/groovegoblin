// Montagem da sincronização: sem servidor a linha fica honesta e nenhuma
// requisição sai; módulos de outras etapas que ainda não estão no repositório
// ficam de fora AVISANDO (nada é omitido em silêncio e nenhum substituto entra
// no lugar).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installSync } from '../src/sync-wire.js';
import { createMemoryStorage, createFakeLibrary } from './sync-harness.js';

async function importable(path) {
  try {
    await import(path);
    return true;
  } catch {
    return false;
  }
}

test('montagem sem servidor: modo local, fila vazia e aviso explícito do que faltar', async t => {
  const messages = [];
  const library = createFakeLibrary();
  library.add();
  const sync = await installSync({
    library,
    storage: createMemoryStorage(),
    location: null,
    document: null,
    start: false,
    notify: (text, error = false) => messages.push({ text, error }),
  });
  t.after(() => sync.destroy());
  await sync.engine.probe();

  const snapshot = sync.engine.snapshot();
  assert.equal(snapshot.mode, 'local');
  assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.conflicts, 0);
  assert.equal(sync.convert, null, 'sem DOM não há painel de conversão');

  for (const message of messages) {
    assert.match(message.text, /fora da sincronização: .*\.js/);
    assert.equal(message.error, true);
  }
  const todayModule = await import('../src/today-store.js').catch(() => null);
  const present = {
    today: typeof todayModule?.sharedTodayStore === 'function',
    shapes: await importable('../src/fingering-shapes.js'),
    bindings: await importable('../src/course-shape-binding.js'),
  };
  const has = pattern => snapshot.warnings.some(text => pattern.test(text));
  assert.equal(has(/Fila do dia e rotinas fora da sincronização/), !present.today);
  assert.equal(has(/Formas fora da sincronização/), !present.shapes);
  assert.equal(has(/Vínculos de forma fora da sincronização/), !present.bindings);

  // As coleções que dependem das lojas compartilhadas continuam registradas.
  const collections = new Set(sync.ports.map(port => port.collection));
  for (const expected of ['courses', 'courseStates', 'courseAttachments', 'preferences']) {
    assert.ok(collections.has(expected), `${expected} precisa estar registrada`);
  }
});
