import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PORTABLE_FORMAT,
  PORTABLE_VERSION,
  serializePhrase,
  parsePhrase,
} from '../src/portable.js';

function phraseDocument(overrides = {}) {
  return {
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    bpm: 100,
    bars: 1,
    notes: [{ id: 'nota-original', start: 0, duration: 4 }],
    ...overrides,
  };
}

function assertRejected(text) {
  let result;
  assert.doesNotThrow(() => { result = parsePhrase(text); });
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
  // Nenhum campo de estado pode vazar, mesmo que parte do documento seja válida.
  assert.deepEqual(Object.keys(result).sort(), ['error', 'ok']);
}

test('portable: constantes identificam o formato e a versão públicos', () => {
  assert.equal(PORTABLE_FORMAT, 'groovegoblin-phrase');
  assert.equal(PORTABLE_VERSION, 1);
});

for (const bars of [1, 2, 4]) {
  test(`portable: round-trip preserva estado e IDs em ${bars} compasso(s)`, () => {
    const state = {
      bpm: 123,
      bars,
      // Ordem não cronológica é preservada; a última nota termina no limite.
      notes: [
        { id: 'fim-ç', start: bars * 16 - 2, duration: 2 },
        { id: 'começo', start: 0, duration: 3 },
        { id: 'adjacente', start: 3, duration: 5 },
      ],
    };
    const snapshot = structuredClone(state);
    const text = serializePhrase(state);
    const expectedDocument = {
      format: PORTABLE_FORMAT,
      version: PORTABLE_VERSION,
      bpm: state.bpm,
      bars: state.bars,
      notes: state.notes,
    };
    assert.equal(text, JSON.stringify(expectedDocument, null, 2));
    assert.deepEqual(parsePhrase(text), { ok: true, ...state });
    assert.deepEqual(state, snapshot);
  });
}

test('portable: exportação aceita estado congelado sem mutá-lo', () => {
  const state = Object.freeze({
    bpm: 100,
    bars: 2,
    notes: Object.freeze([
      Object.freeze({ id: 'cruza-compasso', start: 14, duration: 4 }),
    ]),
  });
  assert.deepEqual(parsePhrase(serializePhrase(state)), { ok: true, ...state });
});

test('portable: bars ausente importa como um compasso e mantém IDs', () => {
  const document = phraseDocument();
  delete document.bars;
  assert.deepEqual(parsePhrase(JSON.stringify(document)), {
    ok: true,
    notes: document.notes,
    bpm: document.bpm,
    bars: 1,
  });
  document.notes = [{ id: 'fora', start: 16, duration: 1 }];
  assertRejected(JSON.stringify(document));
});

for (const bpm of [40, 240]) {
  test(`portable: aceita BPM no limite ${bpm} e frase vazia`, () => {
    const state = { bpm, bars: 1, notes: [] };
    assert.deepEqual(parsePhrase(serializePhrase(state)), { ok: true, ...state });
  });
}

test('portable: parse rejeita JSON corrompido sem lançar nem expor erro técnico', () => {
  for (const text of ['', '{', '{"notes":', '{"format": "x",}', 'undefined']) {
    assertRejected(text);
    assert.equal(parsePhrase(text).error,
      'Não foi possível ler o arquivo: o JSON é inválido.');
  }
});

test('portable: parse rejeita qualquer entrada que não seja string', () => {
  for (const value of [undefined, null, 1, true, {}, [], new String('{}'), Symbol('json'), 1n]) {
    assertRejected(value);
  }
});

test('portable: parse rejeita JSON que não seja objeto de frase', () => {
  for (const value of [null, false, 1, 'texto', [], [phraseDocument()]]) {
    assertRejected(JSON.stringify(value));
  }
});

const invalidDocuments = [
  ['format errado', { format: 'outro-formato' }],
  ['format não textual', { format: 1 }],
  ['version desconhecida', { version: 2 }],
  ['version fracionária', { version: 1.5 }],
  ['version textual', { version: '1' }],
  ['version nula', { version: null }],
  ['BPM abaixo do limite', { bpm: 39 }],
  ['BPM acima do limite', { bpm: 241 }],
  ['BPM fracionário', { bpm: 100.5 }],
  ['BPM textual', { bpm: '100' }],
  ['BPM nulo', { bpm: null }],
  ['bars 3', { bars: 3 }],
  ['bars zero', { bars: 0 }],
  ['bars fracionário', { bars: 1.5 }],
  ['bars textual', { bars: '1' }],
  ['bars nulo', { bars: null }],
  ['chave desconhecida no topo', { unexpected: true }],
  ['chave de protótipo no topo', { ['__proto__']: {} }],
  ['notes não é array', { notes: {} }],
  ['notes nulo', { notes: null }],
  ['nota nula', { notes: [null] }],
  ['nota não é objeto', { notes: [1] }],
  ['nota com chave extra', { notes: [{ id: 'a', start: 0, duration: 1, velocity: 99 }] }],
  ['nota com chave de protótipo', { notes: [{ id: 'a', start: 0, duration: 1, ['__proto__']: {} }] }],
  ['nota sem id', { notes: [{ start: 0, duration: 1 }] }],
  ['id vazio', { notes: [{ id: '', start: 0, duration: 1 }] }],
  ['id não textual', { notes: [{ id: 1, start: 0, duration: 1 }] }],
  ['nota sem start', { notes: [{ id: 'a', duration: 1 }] }],
  ['start negativo', { notes: [{ id: 'a', start: -1, duration: 1 }] }],
  ['start fracionário', { notes: [{ id: 'a', start: 0.5, duration: 1 }] }],
  ['start textual', { notes: [{ id: 'a', start: '0', duration: 1 }] }],
  ['nota sem duration', { notes: [{ id: 'a', start: 0 }] }],
  ['duration zero', { notes: [{ id: 'a', start: 0, duration: 0 }] }],
  ['duration negativa', { notes: [{ id: 'a', start: 0, duration: -1 }] }],
  ['duration fracionária', { notes: [{ id: 'a', start: 0, duration: 1.5 }] }],
  ['duration textual', { notes: [{ id: 'a', start: 0, duration: '1' }] }],
  ['notas sobrepostas', { notes: [
    { id: 'a', start: 0, duration: 4 },
    { id: 'b', start: 3, duration: 2 },
  ] }],
  ['ids duplicados', { notes: [
    { id: 'a', start: 0, duration: 4 },
    { id: 'a', start: 4, duration: 2 },
  ] }],
  ['fim além de um compasso', { notes: [{ id: 'a', start: 15, duration: 2 }] }],
  ['fim além de dois compassos', { bars: 2, notes: [{ id: 'a', start: 31, duration: 2 }] }],
  ['fim além de quatro compassos', { bars: 4, notes: [{ id: 'a', start: 63, duration: 2 }] }],
  ['nota válida seguida de inválida (atômico)', { notes: [
    { id: 'válida', start: 0, duration: 2 },
    { id: 'inválida', start: 15, duration: 2 },
  ] }],
];

for (const [description, overrides] of invalidDocuments) {
  test(`portable: parse rejeita ${description} sem estado parcial`, () => {
    assertRejected(JSON.stringify(phraseDocument(overrides)));
  });
}

for (const key of ['format', 'version', 'bpm', 'notes']) {
  test(`portable: parse rejeita ausência do campo obrigatório ${key}`, () => {
    const document = phraseDocument();
    delete document[key];
    assertRejected(JSON.stringify(document));
  });
}

test('portable: serialize rejeita estados inválidos com TypeError em português', () => {
  const states = [
    undefined, null, [], 'frase', {},
    { bpm: 100, notes: [] },
    ...[39, 241, 100.5, '100', NaN, Infinity].map((bpm) => ({ bpm, bars: 1, notes: [] })),
    ...[0, 3, 1.5, '1', null].map((bars) => ({ bpm: 100, bars, notes: [] })),
    { bpm: 100, bars: 1, notes: null },
    { bpm: 100, bars: 1, notes: [{ id: 'a', start: 15, duration: 2 }] },
    { bpm: 100, bars: 2, notes: [{ id: 'a', start: 31, duration: 2 }] },
    { bpm: 100, bars: 1, notes: [
      { id: 'a', start: 0, duration: 4 },
      { id: 'b', start: 3, duration: 2 },
    ] },
    { bpm: 100, bars: 1, notes: [{ id: 'a', start: 0, duration: 1, extra: true }] },
  ];
  for (const state of states) {
    assert.throws(() => serializePhrase(state), {
      name: 'TypeError',
      message: /A frase deve conter notas válidas/,
    });
  }
});
