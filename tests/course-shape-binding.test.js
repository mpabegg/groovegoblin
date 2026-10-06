import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHAPE_BINDING_KEY, SHAPE_BINDING_LIMIT, createShapeBindingStore, resolveCatalogRecipe, shapeBindingId, sharedShapeBindingStore,
  resetSharedShapeBindingStore, shapeChoicesForLabel,
} from '../src/course-shape-binding.js';
import { catalogRecipeFromEntry, normalizeCatalogRecipe } from '../src/course-catalog.js';
import { generateStudy } from '../src/study-generator.js';

// Fictício: rótulos "Shape 1"/"Shape 2" do curso de exemplo e formas genéricas.

function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
}

function label(overrides = {}) {
  return { label: 'Shape 1', quality: 'major', inversion: 'fundamental', ...overrides };
}

function recipe(overrides = {}) {
  return catalogRecipeFromEntry({
    familia: 'arpejo_triade_forma_unica',
    aula_id: 1,
    qualidade: 'maior',
    inversao: 'fundamental',
    forma: { forma: 'Shape 1' },
    regiao_do_braco: { declarada: { de: 1, ate: 5 } },
    sequencia_de_acordes: { regra: 'ciclo de quartas a partir de C', cifras: ['C', 'F', 'C'] },
    compassos_por_acorde: 2,
    contorno: { padrao: 'T-3-5' },
    ...overrides,
  }).recipe;
}

const MAJOR_SHAPE = {
  id: 'bass4-maior-fundamental',
  label: 'Maior · fundamental',
  quality: 'major',
  degrees: [1, 3, 5],
  notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }],
};
const MINOR_SHAPE = { ...MAJOR_SHAPE, id: 'bass4-menor', label: 'Menor', quality: 'minor' };

// Fachada da loja de formas (A3), como o host injeta na página da aula.
function shapes({ choices = [{ id: MAJOR_SHAPE.id, label: MAJOR_SHAPE.label, generic: true, shape: MAJOR_SHAPE }], resolved = new Map([[MAJOR_SHAPE.id, MAJOR_SHAPE]]) } = {}) {
  return {
    choicesFor: () => choices,
    shape: (id) => resolved.get(id) ?? null,
  };
}

test('a chave do vínculo é rótulo + qualidade + inversão', () => {
  assert.equal(shapeBindingId(label()), JSON.stringify(['Shape 1', 'major', 'fundamental']));
  assert.notEqual(shapeBindingId(label()), shapeBindingId(label({ quality: 'minor' })));
  assert.notEqual(shapeBindingId(label()), shapeBindingId(label({ inversion: '1ª inversão' })));
  assert.equal(shapeBindingId({ quality: 'major' }), null);
});

test('guarda, consulta e esquece a forma escolhida para um rótulo', () => {
  const store = createShapeBindingStore({ storage: storage(), now: () => '2026-01-02T00:00:00.000Z' });
  assert.equal(store.status, 'ready');
  assert.equal(store.shapeFor(label()), null);
  const saved = store.remember(label(), MAJOR_SHAPE.id, { instrument: 'bass4' });
  assert.equal(saved.saved, true);
  assert.equal(saved.boundAt, '2026-01-02T00:00:00.000Z');
  assert.equal(store.shapeFor(label()), MAJOR_SHAPE.id);
  assert.equal(store.shapeFor(label({ quality: 'minor' })), null, 'outra qualidade não reusa a escolha');
  // Trocar a escolha do mesmo rótulo substitui (não duplica).
  store.remember(label(), 'outra-forma');
  assert.equal(store.list().length, 1);
  assert.equal(store.shapeFor(label()), 'outra-forma');
  assert.equal(store.forget(label()), true);
  assert.equal(store.shapeFor(label()), null);
  assert.equal(store.forget(label()), false);
});

test('a memória sobrevive a uma nova instância e vai no documento de backup', () => {
  const disk = storage();
  const first = createShapeBindingStore({ storage: disk });
  first.remember(label(), MAJOR_SHAPE.id);
  const document_ = first.exportDocument();
  assert.equal(document_.version, 1);
  assert.equal(document_.bindings.length, 1);

  const second = createShapeBindingStore({ storage: disk });
  assert.equal(second.shapeFor(label()), MAJOR_SHAPE.id, 'a escolha continua depois de reabrir');

  const empty = createShapeBindingStore({ storage: storage() });
  assert.deepEqual(empty.importDocument(document_), { added: 1, total: 1, available: true });
  assert.equal(empty.shapeFor(label()), MAJOR_SHAPE.id);
  assert.deepEqual(empty.importDocument(document_), { added: 0, total: 1, available: true }, 'reimportar não duplica');
});

test('armazenamento negado ou ilegível não vira sucesso falso', () => {
  const blocked = { getItem: () => null, setItem: () => { throw new Error('cota'); } };
  const store = createShapeBindingStore({ storage: blocked });
  const saved = store.remember(label(), MAJOR_SHAPE.id);
  assert.equal(saved.saved, false);
  assert.equal(store.status, 'blocked');
  assert.match(store.error, /cota/);
  assert.equal(store.shapeFor(label()), MAJOR_SHAPE.id, 'a escolha vale para a geração em curso');

  const corrupt = createShapeBindingStore({ storage: storage({ [SHAPE_BINDING_KEY]: '{isso não é json' }) });
  assert.equal(corrupt.status, 'corrupt');
  assert.equal(corrupt.list().length, 0);

  const none = createShapeBindingStore({ storage: null });
  assert.equal(none.status, 'memory');
  assert.equal(none.remember(label(), MAJOR_SHAPE.id).saved, false);
});

test('o limite de vínculos mantém os mais recentes', () => {
  const store = createShapeBindingStore({ storage: storage() });
  for (let index = 0; index < SHAPE_BINDING_LIMIT + 5; index += 1) store.remember(label({ label: `Shape ${index}` }), `forma-${index}`);
  assert.equal(store.list().length, SHAPE_BINDING_LIMIT);
  assert.equal(store.shapeFor(label({ label: 'Shape 0' })), null);
  assert.equal(store.shapeFor(label({ label: `Shape ${SHAPE_BINDING_LIMIT + 4}` })), `forma-${SHAPE_BINDING_LIMIT + 4}`);
});

test('loja compartilhada é a mesma instância e pode ser reiniciada', () => {
  const disk = storage();
  resetSharedShapeBindingStore();
  const a = sharedShapeBindingStore({ storage: disk });
  const b = sharedShapeBindingStore({ storage: disk });
  assert.equal(a, b);
  resetSharedShapeBindingStore();
  const c = sharedShapeBindingStore({ storage: disk });
  assert.notEqual(a, c);
  resetSharedShapeBindingStore();
});

// ------------------------------------------------------------- resolução

test('sem vínculo, a receita pede a forma em vez de inventar digitação', () => {
  const store = createShapeBindingStore({ storage: storage() });
  const resolved = resolveCatalogRecipe(recipe(), { bindings: store, shapes: shapes() });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'forma-ausente');
  assert.deepEqual(resolved.label, { label: 'Shape 1', quality: 'major', inversion: 'fundamental' });
  assert.equal(resolved.choices.length, 1);
  assert.equal(resolved.choices[0].shape.quality, 'major');
});

test('com vínculo, a receita sai pronta para o gerador (sem o rótulo)', () => {
  const store = createShapeBindingStore({ storage: storage() });
  store.remember(label(), MAJOR_SHAPE.id);
  const resolved = resolveCatalogRecipe(recipe(), { bindings: store, shapes: shapes() });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.shapeId, MAJOR_SHAPE.id);
  assert.equal(resolved.recipe.shape.id, MAJOR_SHAPE.id);
  assert.equal(resolved.recipe.shape.notes.length, 3);
  assert.equal(Object.hasOwn(resolved.recipe, 'shapeLabel'), false);
  // O limite real é o MOTOR: a receita resolvida gera material (o schema do
  // CURSO não tem `shape` — ele é a forma física, não a receita guardada).
  assert.deepEqual(Object.keys(resolved.recipe.figure), ['bars', 'order', 'notes', 'inversions']);
  const out = generateStudy(resolved.recipe);
  // 3 acordes × 2 compassos por acorde, sem compasso final (o catálogo fictício
  // não indica um): a receita resolvida toca os 6 compassos.
  assert.equal(out.actualBars, 6);
  assert.equal(out.chords.length, 3);
  // A receita guardada no documento continua com o rótulo (nada é trocado lá).
  assert.equal(recipe().shapeLabel.label, 'Shape 1');
});

test('vínculo apontando para forma sem posição no instrumento devolve o motivo', () => {
  const store = createShapeBindingStore({ storage: storage() });
  store.remember(label(), 'forma-que-nao-cabe');
  const resolved = resolveCatalogRecipe(recipe(), { bindings: store, shapes: shapes({ resolved: new Map() }) });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'forma-sem-posicao');
  assert.equal(resolved.shapeId, 'forma-que-nao-cabe');
});

test('famílias sem forma fecham a receita direto e a lista de escolhas é filtrada pela qualidade', () => {
  const continuous = catalogRecipeFromEntry({
    familia: 'movimento_continuo_linha_4_notas',
    aula_id: 1,
    qualidade: 'menor',
    sequencia_de_acordes: { regra: 'ciclo de quartas', cifras: ['A', 'D', 'A'] },
    contorno: { padrao: null },
  }).recipe;
  const resolved = resolveCatalogRecipe(continuous, { bindings: createShapeBindingStore({ storage: storage() }), shapes: shapes() });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.recipe.rhythm, 'quarters');
  assert.equal(resolved.shapeId, null);

  const harmony = recipe({ qualidade: 'menor', forma: { forma: 'Shape 2' }, inversao: '1ª inversão' });
  const choices = shapeChoicesForLabel(harmony, { shapes: shapes({ choices: [{ id: MAJOR_SHAPE.id, shape: MAJOR_SHAPE }, { id: MINOR_SHAPE.id, shape: MINOR_SHAPE }] }) });
  assert.deepEqual(choices.map(choice => choice.id), [MINOR_SHAPE.id]);
});

test('sem a loja de formas, a receita de arpejo só pede a escolha (nunca uma forma falsa)', () => {
  const resolved = resolveCatalogRecipe(recipe(), { bindings: null, shapes: null });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'forma-ausente');
  assert.deepEqual(resolved.choices, []);
});
