import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRandom, deriveSeed } from '../src/random.js';

test('fluxos uint32 são reproduzíveis e independentes, incluindo zero e bit de sinal', () => {
  const signatures = [];
  for (const seed of [0, 1, 42, 0x7fffffff, 0x80000000, 0xffffffff]) {
    const first = seededRandom(seed);
    const second = seededRandom(seed);
    const values = Array.from({ length: 32 }, () => first());
    seededRandom(seed + 1)();
    assert.deepEqual(Array.from({ length: 32 }, () => second()), values);
    assert.ok(values.every(value => Number.isFinite(value) && value >= 0 && value < 1));
    signatures.push(JSON.stringify(values));
  }
  assert.equal(new Set(signatures).size, signatures.length);
});

test('derivação por parte e compasso não depende da ordem de chamadas', () => {
  const seeds = [0, 42, 0xffffffff].flatMap(seed => [1, 2, 3].flatMap(part => [0, 1, 16].map(bar => ({ seed, part, bar, derived: deriveSeed(seed, part, bar) }))));
  for (const item of [...seeds].reverse()) {
    assert.equal(deriveSeed(item.seed, item.part, item.bar), item.derived);
    assert.ok(Number.isInteger(item.derived) && item.derived >= 0 && item.derived <= 0xffffffff);
  }
  assert.equal(new Set(seeds.map(item => item.derived)).size, seeds.length);
});
