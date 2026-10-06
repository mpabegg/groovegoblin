// Vínculo do rótulo de forma do catálogo com a forma de dedilhado (rodada 6,
// etapa 5 — A5/A6).
//
// O catálogo real referencia a forma pelo RÓTULO ("Shape 1" da qualidade e da
// inversão tais) e não traz a digitação. Quando o usuário escolhe a forma
// correspondente — no painel Braço ou entre as que já tem —, o app LEMBRA a
// escolha para as próximas aulas com o mesmo rótulo. Este módulo é essa
// memória: um armazenamento pequeno, por rótulo, FORA da sessão v5 e fora do
// documento do curso (como as formas do A3, mora na biblioteca do navegador e
// entra na cópia de segurança pelo documento estruturado).
//
// Regras:
//  - nada é inventado: o vínculo guarda só o ID da forma escolhida; quem sabe
//    transformar id em forma é a loja de formas (A3), injetada pelo host;
//  - o vínculo é POR RÓTULO (rótulo + qualidade + inversão), então a mesma
//    forma escolhida para "Shape 1 · maior · fundamental" não é reusada em
//    "Shape 1 · menor · 1ª inversão";
//  - gravação negada não vira sucesso falso: `status` diz o que aconteceu e a
//    escolha continua valendo só para a geração em curso.

import { generatorRecipe } from './course-catalog.js';

export const SHAPE_BINDING_KEY = 'groovegoblin-study-shape-bindings';
export const SHAPE_BINDING_VERSION = 1;
export const SHAPE_BINDING_LIMIT = 200;

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isoNow() {
  return new Date().toISOString();
}

// Chave do vínculo: rótulo + qualidade + inversão, em JSON (rótulo pode conter
// qualquer texto).
export function shapeBindingId(value) {
  if (!isText(value?.label)) return null;
  return JSON.stringify([value.label.trim(), value.quality ?? null, value.inversion ?? null]);
}

function normalizeBinding(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = shapeBindingId(value);
  if (id === null || !isText(value.shapeId)) return null;
  return {
    id,
    label: value.label.trim(),
    quality: isText(value.quality) ? value.quality : null,
    inversion: isText(value.inversion) ? value.inversion : null,
    shapeId: value.shapeId,
    instrument: isText(value.instrument) ? value.instrument : null,
    boundAt: isText(value.boundAt) ? value.boundAt : null,
  };
}

export function normalizeShapeBindings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const list = [];
  for (const raw of Array.isArray(value.bindings) ? value.bindings : []) {
    const binding = normalizeBinding(raw);
    if (binding === null || list.some(item => item.id === binding.id)) continue;
    list.push(binding);
  }
  return list;
}

function validateDocument(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('O documento de vínculos de forma deve ser um objeto.');
  }
  if (value.version !== SHAPE_BINDING_VERSION) throw new TypeError('A versão do documento de vínculos de forma não é compatível.');
  return normalizeShapeBindings(value);
}

// Fábrica. `storage` é injetável (testes usam um mapa de mentira); sem
// armazenamento a loja nasce em memória e diz isso (`status: 'memory'`).
export function createShapeBindingStore({ storage = globalThis.localStorage, now = isoNow } = {}) {
  const listeners = new Set();
  let bindings = [];
  let status = 'ready';
  let error = null;
  let warning = null;

  function emit() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* um assinante quebrado não derruba a loja */ }
    }
  }

  function read() {
    if (!storage || typeof storage.getItem !== 'function') {
      status = 'memory';
      error = 'Este navegador não guarda os vínculos de forma: a escolha vale só enquanto a página estiver aberta.';
      return;
    }
    let raw = null;
    try {
      raw = storage.getItem(SHAPE_BINDING_KEY);
    } catch (cause) {
      status = 'unavailable';
      error = `Não foi possível ler os vínculos de forma: ${cause?.message ?? cause}`;
      return;
    }
    if (raw === null || raw === undefined || raw === '') { status = 'ready'; error = null; return; }
    try {
      bindings = validateDocument(JSON.parse(raw));
      status = 'ready';
      error = null;
    } catch (cause) {
      // Bytes ilegíveis ficam preservados: nada é sobrescrito para "corrigir".
      status = 'corrupt';
      error = `Os vínculos de forma guardados estão ilegíveis (${cause?.message ?? cause}); eles não serão sobrescritos.`;
      bindings = [];
    }
  }

  function persist() {
    if (status === 'corrupt') return false;
    if (!storage || typeof storage.setItem !== 'function') { status = 'memory'; return false; }
    try {
      storage.setItem(SHAPE_BINDING_KEY, JSON.stringify({ version: SHAPE_BINDING_VERSION, bindings }));
      warning = null;
      return true;
    } catch (cause) {
      status = 'blocked';
      error = `Não foi possível guardar os vínculos de forma: ${cause?.message ?? cause}`;
      return false;
    }
  }

  read();

  const api = {
    get status() { return status; },
    get error() { return error; },
    get warning() { return warning; },
    get key() { return SHAPE_BINDING_KEY; },
    get version() { return SHAPE_BINDING_VERSION; },

    list() { return bindings.map(binding => clone(binding)); },
    get(id) {
      const key = typeof id === 'string' ? id : shapeBindingId(id);
      const found = bindings.find(binding => binding.id === key) ?? null;
      return found ? clone(found) : null;
    },

    // A forma escolhida para o rótulo da receita (ou null).
    shapeFor(value) {
      const key = shapeBindingId(value);
      if (key === null) return null;
      return bindings.find(binding => binding.id === key)?.shapeId ?? null;
    },

    // Lembra (ou troca) a forma de um rótulo. Devolve o vínculo gravado ou null
    // quando o rótulo não pôde ser lido; `saved` diz se ficou no armazenamento.
    remember(value, shapeId, { instrument = null } = {}) {
      const key = shapeBindingId(value);
      if (key === null || !isText(shapeId)) return null;
      const binding = {
        id: key,
        label: value.label.trim(),
        quality: isText(value.quality) ? value.quality : null,
        inversion: isText(value.inversion) ? value.inversion : null,
        shapeId,
        instrument: isText(instrument) ? instrument : null,
        boundAt: now(),
      };
      const index = bindings.findIndex(item => item.id === key);
      if (index >= 0) bindings[index] = binding;
      else bindings.unshift(binding);
      if (bindings.length > SHAPE_BINDING_LIMIT) bindings = bindings.slice(0, SHAPE_BINDING_LIMIT);
      const saved = persist();
      emit();
      return { ...clone(binding), saved };
    },

    forget(label) {
      const key = shapeBindingId(typeof label === 'string' ? { label } : label);
      const before = bindings.length;
      bindings = key === null ? bindings : bindings.filter(binding => binding.id !== key);
      if (bindings.length === before) return false;
      persist();
      emit();
      return true;
    },

    exportDocument() {
      return { version: SHAPE_BINDING_VERSION, bindings: bindings.map(binding => clone(binding)) };
    },

    // Importação em UNIÃO: um vínculo já existente no navegador não é trocado
    // pelo do arquivo (o daqui é a escolha atual do usuário); rótulos novos
    // entram. Devolve quantos entraram.
    importDocument(document) {
      const incoming = validateDocument(document);
      let added = 0;
      for (const binding of incoming) {
        if (bindings.some(item => item.id === binding.id)) continue;
        bindings.push(binding);
        added += 1;
      }
      if (added > 0) { persist(); emit(); }
      return { added, total: bindings.length, available: true };
    },

    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Assinante inválido.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return api;
}

// ------------------------------------------------ resolução da receita
//
// A receita do catálogo só vira material depois que a forma do rótulo é
// escolhida. `resolveCatalogRecipe` faz essa costura:
//   - família de arpejo com rótulo: procura o vínculo e pede a forma à loja de
//     formas (A3, injetada). Sem vínculo, devolve `forma-ausente` e as opções
//     de mesma qualidade, para a interface pedir a escolha;
//   - demais famílias: a receita fecha sem forma.
// Nunca inventa digitação nem troca a qualidade: uma forma incompatível ou sem
// posição no instrumento vira um motivo explícito.

function catalogRecipeShapeLabel(recipe) {
  return recipe !== null && typeof recipe === 'object' && recipe.shapeLabel !== null
    && typeof recipe.shapeLabel === 'object' ? recipe.shapeLabel : null;
}

export function shapeChoicesForLabel(recipe, { shapes = null, profile = null } = {}) {
  const label = catalogRecipeShapeLabel(recipe);
  if (label === null || shapes === null || typeof shapes.choicesFor !== 'function') return [];
  let choices = [];
  try { choices = shapes.choicesFor(profile) ?? []; } catch { return []; }
  return (Array.isArray(choices) ? choices : []).filter(choice => (choice?.shape?.quality ?? null) === label.quality);
}

export function resolveCatalogRecipe(recipe, { bindings = null, shapes = null, profile = null } = {}) {
  const label = catalogRecipeShapeLabel(recipe);
  if (label === null) {
    return { ok: true, recipe: generatorRecipe(recipe), shapeId: null, label: null };
  }
  const shapeId = bindings !== null && typeof bindings.shapeFor === 'function' ? bindings.shapeFor(label) : null;
  const choices = shapeChoicesForLabel(recipe, { shapes, profile });
  if (shapeId !== null && shapes !== null && typeof shapes.shape === 'function') {
    let shape = null;
    try { shape = shapes.shape(shapeId, profile); } catch { shape = null; }
    if (shape !== null) {
      try {
        return { ok: true, recipe: generatorRecipe(recipe, { shape }), shapeId, label };
      } catch (error) {
        return { ok: false, reason: 'forma-incompativel', error: error.message, label, shapeId, choices };
      }
    }
    return { ok: false, reason: 'forma-sem-posicao', label, shapeId, choices };
  }
  return { ok: false, reason: 'forma-ausente', label, choices };
}

// Uma única loja por app (como a de formas do A3): o mesmo vínculo vale para a
// aula, o gerador e o "Gerar todos".
let sharedStore = null;
export function sharedShapeBindingStore(options) {
  if (!sharedStore) sharedStore = createShapeBindingStore(options);
  return sharedStore;
}
export function resetSharedShapeBindingStore() {
  sharedStore = null;
}
