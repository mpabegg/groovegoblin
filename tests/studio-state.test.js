import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSession, readSessionLibrary, SESSION_LIBRARY_KEY } from '../src/studio-state.js';

const storage = raw => ({ getItem(key) { assert.equal(key, SESSION_LIBRARY_KEY); return raw; } });

test('alteração de escolha preserva objetos irmãos e referência de execução', () => {
  const original = { bpm: 100, meter: { beats: 7, unit: 8 }, mixer: { phrase: { volume: 0.8, muted: false }, bass: { volume: 0.6, muted: true } }, notes: [{ id: 'a', start: 0, duration: 4 }] };
  const before = JSON.stringify(original);
  const changed = mergeSession(original, { meter: { beats: 6 }, mixer: { phrase: { muted: true } } });
  assert.deepEqual(changed.meter, { beats: 6, unit: 8 });
  assert.deepEqual(changed.mixer.phrase, { volume: 0.8, muted: true });
  assert.equal(changed.mixer.bass, original.mixer.bass);
  assert.equal(JSON.stringify(original), before);
});

test('listas de notas/acordes substituem integralmente, não mesclam índices', () => {
  const changed = mergeSession({ notes: [1, 2], progression: { enabled: true, chords: [1, 2, 3] } }, { notes: [], progression: { chords: [4] } });
  assert.deepEqual(changed, { notes: [], progression: { enabled: true, chords: [4] } });
});

test('extensões JSON preservam chaves sem alterar protótipos', () => {
  const patch = JSON.parse('{"extensions":{"__proto__":{"polluted":true},"nullable":{"value":1}}}');
  const changed = mergeSession({ extensions: { nullable: null } }, patch);
  assert.equal(Object.getPrototypeOf(changed.extensions), Object.prototype);
  assert.equal(Object.hasOwn(changed.extensions, '__proto__'), true);
  assert.equal(changed.extensions.polluted, undefined);
  assert.deepEqual(changed.extensions.nullable, { value: 1 });
  assert.equal({}.polluted, undefined);
});

test('biblioteca vazia retorna coleção sem aviso nem recuperação', () => {
  assert.deepEqual(readSessionLibrary(storage(null), JSON.parse), { entries: [], warning: null, recoveryRaw: null });
});

test('biblioteca restaura cada sessão por seu parser canônico', () => {
  const raw = JSON.stringify([{ id: 'one', savedAt: '2026-10-04T12:00:00Z', session: { version: 2, name: '<img src=x>', mixer: { bass: { muted: true } } } }]);
  const calls = [];
  const result = readSessionLibrary(storage(raw), text => { calls.push(text); return JSON.parse(text); });
  assert.equal(calls.length, 1);
  assert.equal(result.entries[0].session.name, '<img src=x>');
  assert.equal(result.entries[0].session.mixer.bass.muted, true);
  assert.equal(result.warning, null);
});

for (const raw of ['{broken', '{}', '[{"id":42}]', '[{"id":"bad","savedAt":"today","session":{}}]']) {
  test(`biblioteca corrompida protege bytes originais: ${raw}`, () => {
    const result = readSessionLibrary(storage(raw), () => { throw new Error('Sessão inválida'); });
    assert.deepEqual(result.entries, []);
    assert.equal(result.recoveryRaw, raw);
    assert.match(result.warning, /originais preservados/);
  });
}

test('negação de armazenamento não impede edição só na memória', () => {
  const result = readSessionLibrary({ getItem() { throw new Error('SecurityError'); } }, JSON.parse);
  assert.deepEqual(result.entries, []);
  assert.equal(result.recoveryRaw, null);
  assert.match(result.warning, /indisponível/);
});
