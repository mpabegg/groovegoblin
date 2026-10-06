// A3 — Formas de dedilhado (rodada 6): testes de consumidor.
//
// Exercitam os módulos REAIS (validação contra a afinação, loja em localStorage,
// editor no painel Braço e a passagem para o gerador A2) com um DOM duplo
// mínimo, como o teste do backup. Tudo fictício: nenhuma forma vem de curso;
// nada aqui busca a rede.
//
// O deslocamento do molde entre conjuntos de cordas (a forma de 4 cordas que
// passa a começar na corda Si do baixo 5) é conferido pelo posicionador do A2:
// se ele ainda não oferecer o deslocamento, o teste aparece como PULADO (nunca
// como sucesso) e as demais invariantes continuam valendo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standardInstrumentProfile } from '../src/instrument-profile.js';
import { applyShape, generateStudy, normalizeRecipe } from '../src/study-generator.js';
import {
  FINGERING_SHAPES_KEY, SHAPE_LABEL_MAX, SHAPE_MAX_NOTES, applicableTo, checkShape,
  createFingeringShapeStore, degreeInterval, genericShapes, isGenericShape, normalizeShape, shapeInstrumentId,
  shapeOverlay, toGeneratorShape, validateShapeDocument,
} from '../src/fingering-shapes.js';
import { shapeChoicesForRecipe, shapeForRecipe } from '../src/fingering-shapes-controller.js';
import { mountFingeringShapes } from '../src/fingering-shapes-view.js';

const BASS4 = standardInstrumentProfile('bass', 4);
const BASS5 = standardInstrumentProfile('bass', 5);
const GUITAR6 = standardInstrumentProfile('guitar', 6);

// ---------------------------------------------------------------- fixtures

function memoryStorage() {
  const map = new Map();
  let failWrites = false;
  let failReads = false;
  return {
    raw: map,
    getItem(key) { if (failReads) throw new Error('armazenamento bloqueado'); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { if (failWrites) { const error = new Error('sem espaço'); error.name = 'QuotaExceededError'; throw error; } map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    failWrites(value) { failWrites = value; },
    failReads(value) { failReads = value; },
  };
}

let counter = 0;
const uuid = () => `f${(counter += 1)}`;

// Molde maior escrito no baixo de 4 cordas (corda 4 casa 3 = tônica).
const MAJOR_NOTES = [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }];
const MAJOR = { label: 'Maior · fundamental', quality: 'major', degrees: [1, 3, 5], notes: MAJOR_NOTES.map(note => ({ ...note })) };
const shapeOf = value => ({ ...value, notes: value.notes.map(note => ({ ...note })) });

// ------------------------------------------------------------ DOM duplo

function matchesCompound(element, selector) {
  const trimmed = String(selector).trim();
  if (trimmed === '' || trimmed === '*') return true;
  const tokens = trimmed.match(/^[a-zA-Z][\w-]*|\[[^\]]+\]|#[^.[\]]+|\.\w[\w-]*/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('#')) { if (element.id !== token.slice(1)) return false; }
    else if (token.startsWith('.')) { if (!element.classes.has(token.slice(1))) return false; }
    else if (token.startsWith('[')) {
      const inner = token.slice(1, -1);
      const eq = inner.indexOf('=');
      const name = (eq === -1 ? inner : inner.slice(0, eq)).trim();
      const camel = name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const actual = element.dataset[camel] !== undefined ? String(element.dataset[camel]) : element.getAttribute(name);
      if (eq === -1) { if (actual === null || actual === undefined) return false; }
      else if (actual !== inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '')) return false;
    } else if (element.tag !== token) return false;
  }
  return true;
}

function matches(element, selector) {
  return String(selector).split(',').some(part => matchesCompound(element, part));
}

// Como no DOM real, texto passado a `append`/`prepend`/`replaceChildren` vira nó
// de texto (nunca uma string pendurada na árvore).
function toNode(owner, value) {
  return typeof value === 'string' ? owner.ownerDocument.createTextNode(value) : value;
}

class FakeElement {
  constructor(tag, document_) {
    this.tag = tag;
    this.ownerDocument = document_;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.dataset = {};
    this.classes = new Set();
    this.listeners = {};
    this._text = '';
    this.id = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.title = '';
  }

  get classList() {
    const self = this;
    return {
      add: (...names) => { for (const name of names) self.classes.add(name); },
      remove: (...names) => { for (const name of names) self.classes.delete(name); },
      toggle: (name, force) => { if (force === undefined ? !self.classes.has(name) : force) self.classes.add(name); else self.classes.delete(name); },
      contains: name => self.classes.has(name),
    };
  }

  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(String(value ?? '').split(/\s+/).filter(Boolean)); }

  get textContent() { return this._text || this.children.map(child => child.textContent ?? '').join(''); }
  set textContent(value) { this._text = value ? String(value) : ''; if (!value) this.children = []; }

  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === 'id') this.id = String(value);
    else if (key === 'value') this.value = String(value);
    else if (key === 'type') this.type = String(value);
    else if (key === 'hidden') this.hidden = true;
    else if (key === 'disabled') this.disabled = true;
  }

  getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null; }
  removeAttribute(key) { delete this.attrs[key]; if (key === 'hidden') this.hidden = false; }

  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  // Como no DOM real: `append`/`prepend` aceitam texto e guardam um nó de texto.
  append(...nodes) { for (const node of nodes) this.appendChild(toNode(this, node)); }
  prepend(...nodes) { for (const node of [...nodes].reverse()) { const child = toNode(this, node); child.parentNode = this; this.children.unshift(child); } }
  replaceChildren(...nodes) { this.children = []; this._text = ''; for (const node of nodes) this.appendChild(toNode(this, node)); }
  removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; }
  remove() { this.parentNode?.removeChild(this); }
  get firstChild() { return this.children[0] ?? null; }
  closest(selector) { let node = this; while (node) { if (matches(node, selector)) return node; node = node.parentNode; } return null; }

  querySelectorAll(selector) {
    const found = [];
    const walk = node => {
      for (const child of node.children) {
        // Nós de texto não casam seletor nem têm filhos: só elementos entram na
        // busca, como no DOM real (`children` é só de elementos).
        if (!(child instanceof FakeElement)) continue;
        if (matches(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  dispatch(type, extra = {}) {
    for (const listener of [...(this.listeners[type] ?? [])]) listener({ target: this, preventDefault() {}, ...extra });
  }
  click() { this.dispatch('click'); }
}

function createDom() {
  const document_ = {
    body: null,
    createElement: tag => new FakeElement(tag, document_),
    createTextNode: text => ({ text: String(text), textContent: String(text) }),
    defaultView: null,
  };
  document_.body = new FakeElement('body', document_);
  return document_;
}

function createTable(document_, cells) {
  const table = document_.createElement('table');
  const body = document_.createElement('tbody');
  table.appendChild(body);
  for (const [string, fret] of cells) {
    const cell = document_.createElement('td');
    cell.dataset.string = String(string);
    cell.dataset.fret = String(fret);
    body.appendChild(cell);
  }
  return table;
}

function cellAt(table, string, fret) {
  return table.querySelector(`td[data-string="${string}"][data-fret="${fret}"]`);
}

// ----------------------------------------------------------- genéricas

test('genéricas: exatamente maior, menor e oitava, válidas em baixo 4/5 e guitarra', () => {
  for (const profile of [BASS4, BASS5, GUITAR6]) {
    const shapes = genericShapes(profile);
    assert.equal(shapes.length, 3);
    assert.deepEqual(shapes.map(shape => shape.id), ['generica-maior', 'generica-menor', 'generica-oitava']);
    for (const shape of shapes) {
      const report = checkShape(toGeneratorShape(shape), { profile });
      assert.equal(report.ok, true, `${shape.id} em ${shapeInstrumentId(profile)}: ${report.errors[0]?.message}`);
      assert.equal(shape.generic, true);
      assert.equal(isGenericShape(shape), true);
      assert.deepEqual([...shape.degrees].sort(), [...new Set(shape.notes.map(note => note.degree))].sort());
      assert.ok(['major', 'minor'].includes(shape.quality));
    }
  }
  // A guitarra acrescenta as duas cordas graves: o mesmo molde entra em 6–5–4.
  assert.deepEqual(genericShapes(GUITAR6)[0].notes.map(note => [note.string, note.fret, note.degree]), [[6, 3, 1], [5, 2, 3], [5, 5, 5]]);
  assert.deepEqual(genericShapes(BASS4)[0].notes.map(note => [note.string, note.fret, note.degree]), MAJOR_NOTES.map(note => [note.string, note.fret, note.degree]));
});

test('genéricas: nenhuma é gravada na loja', () => {
  const storage = memoryStorage();
  const store = createFingeringShapeStore({ storage, uuid });
  store.save(shapeOf(MAJOR), BASS4);
  assert.equal(JSON.stringify(JSON.parse(storage.getItem(FINGERING_SHAPES_KEY))).includes('generica-'), false);
  assert.equal(JSON.stringify(JSON.parse(storage.getItem(FINGERING_SHAPES_KEY))).includes('genérica'), false);
});

// ----------------------------------------------------------- validação

test('validação: o grau declarado é conferido contra a afinação', () => {
  assert.equal(checkShape(shapeOf(MAJOR), { profile: BASS4 }).ok, true);
  const wrongThird = { ...shapeOf(MAJOR), notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 3, degree: 3 }, { string: 3, fret: 5, degree: 5 }] };
  const report = checkShape(wrongThird, { profile: BASS4 });
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].code, 'intervalo');
  assert.throws(() => normalizeShape(wrongThird, { profile: BASS4 }), TypeError);
  // A numeração de cordas é estável: o mesmo molde vale no baixo 5.
  assert.equal(checkShape(shapeOf(MAJOR), { profile: BASS5 }).ok, true);
  // E na guitarra, quando o molde é deslocado duas cordas.
  const guitar = { ...shapeOf(MAJOR), notes: MAJOR_NOTES.map(note => ({ ...note, string: note.string + 2 })) };
  assert.equal(checkShape(guitar, { profile: GUITAR6 }).ok, true);
  // A qualidade muda o intervalo esperado: a terça menor tem 3 semitons.
  const minor = { label: 'Menor', quality: 'minor', degrees: [1, 3, 5], notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 1, degree: 3 }, { string: 3, fret: 5, degree: 5 }] };
  assert.equal(checkShape(minor, { profile: BASS4 }).ok, true);
  assert.equal(degreeInterval('minor', 3), 3);
  assert.equal(degreeInterval('major', 3), 4);
  assert.equal(degreeInterval('major', 8), 12);
});

test('validação: corda, casa, duplicada, raiz, nome, graus e limites', () => {
  const bad = (overrides) => checkShape({ ...shapeOf(MAJOR), ...overrides }, { profile: BASS4 });
  assert.equal(bad({ notes: [{ string: 5, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }] }).errors[0].code, 'corda');
  assert.equal(bad({ notes: [{ string: 4, fret: 25, degree: 1 }, { string: 3, fret: 2, degree: 3 }] }).errors[0].code, 'casa');
  assert.equal(bad({ notes: [{ string: 4, fret: 3, degree: 1 }, { string: 4, fret: 3, degree: 3 }] }).errors[0].code, 'duplicada');
  assert.equal(bad({ notes: [{ string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }] }).errors[0].code, 'ancora');
  assert.equal(bad({ label: '   ' }).errors[0].code, 'nome');
  assert.equal(bad({ label: 'x'.repeat(SHAPE_LABEL_MAX + 1) }).errors[0].code, 'nome');
  assert.equal(bad({ quality: 'sus4' }).errors[0].code, 'qualidade');
  assert.equal(bad({ degrees: [1, 3, 5], extra: true }).errors[0].code, 'campo');
  // Um grau marcado sem nota é recusado: os graus são o conjunto exato das notas.
  assert.equal(bad({ degrees: [1, 3, 5, 7] }).errors[0].code, 'graus');
  // Uma nota com grau fora da lista também.
  assert.equal(bad({ degrees: [1, 3] }).errors[0].code, 'graus');
  // Uma nota só não é forma; acima do teto também não.
  assert.equal(bad({ notes: [{ string: 4, fret: 3, degree: 1 }], degrees: [1] }).errors[0].code, 'sem-notas');
  const crowded = { label: 'Cheia', quality: 'major', degrees: [1, 3, 5], notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }, { string: 2, fret: 2, degree: 5 }, { string: 2, fret: 5, degree: 1 }, { string: 1, fret: 2, degree: 5 }, { string: 1, fret: 5, degree: 1 }] };
  assert.equal(checkShape(crowded, { profile: BASS4 }).errors[0].code, 'limite-notas');
  assert.equal(SHAPE_MAX_NOTES, 6);
});

test('validação: a oitava da tônica (grau 8) vale como raiz e a ordem é preservada', () => {
  // Corda 2 (Ré) casa 5 = Sol2, a oitava da tônica Sol1; a terça é o Si1 (corda
  // 3 casa 2), exatamente 4 semitons acima de Sol1.
  const octaveRoot = { label: 'Oitava acima', quality: 'major', degrees: [8, 3], notes: [{ string: 2, fret: 5, degree: 8 }, { string: 3, fret: 2, degree: 3 }] };
  const report = checkShape(octaveRoot, { profile: BASS4 });
  assert.equal(report.ok, true, report.errors[0]?.message);
  assert.equal(report.anchor.degree, 8);
  assert.equal(report.tonicPitch, 38 + 5 - 12);   // Ré2 (=38) + 5 casas - 12 = Sol1 (31)
  const normalized = normalizeShape(octaveRoot, { profile: BASS4 });
  assert.deepEqual([...normalized.degrees], [8, 3]);   // a ordem escolhida é a da figura
  // A mesma forma com a terça um semitom abaixo: Lá♯1 dista 3 semitons de Sol1.
  const wrong = { ...octaveRoot, notes: [{ string: 2, fret: 5, degree: 8 }, { string: 3, fret: 1, degree: 3 }] };
  assert.equal(checkShape(wrong, { profile: BASS4 }).errors[0].code, 'intervalo');
});

test('validação: documento conferido inteiro antes de entrar', () => {
  const document_ = { version: 1, instruments: { bass4: [shapeOf(MAJOR)] } };
  const frozen = validateShapeDocument(document_);
  assert.equal(frozen.instruments.bass4.length, 1);
  assert.equal(Object.isFrozen(frozen.instruments.bass4[0]), true);
  assert.throws(() => validateShapeDocument({ version: 2, instruments: {} }), /Versão/);
  assert.throws(() => validateShapeDocument({ version: 1, instruments: { bass6: [] } }), /Instrumento desconhecido/);
  assert.throws(() => validateShapeDocument({ version: 1, instruments: {} , extra: 1 }), /Campo desconhecido/);
  assert.throws(() => validateShapeDocument({ version: 1, instruments: { bass4: [shapeOf(MAJOR), shapeOf(MAJOR)] } }), /duas vezes/);
});

// --------------------------------------------------------------- loja

test('loja: guarda fora da sessão, por instrumento e cordas, com exportação', () => {
  const storage = memoryStorage();
  const store = createFingeringShapeStore({ storage, uuid });
  assert.equal(store.status, 'ready');
  assert.equal(storage.getItem(FINGERING_SHAPES_KEY), null);   // nada é gravado antes de existir forma
  const saved = store.save(shapeOf(MAJOR), BASS4);
  assert.match(saved.id, /^bass4-/);
  const document_ = JSON.parse(storage.getItem(FINGERING_SHAPES_KEY));
  assert.deepEqual(Object.keys(document_), ['version', 'instruments']);
  assert.equal(document_.version, 1);
  assert.equal(document_.instruments.bass4.length, 1);
  // A forma guardada é exatamente o schema que o A2 aceita: nada de sessão.
  assert.deepEqual(Object.keys(document_.instruments.bass4[0]), ['id', 'label', 'quality', 'degrees', 'notes']);
  assert.equal(JSON.stringify(document_).includes('extensions'), false);
  assert.deepEqual(store.exportDocument().instruments.bass4[0].notes, MAJOR_NOTES);
  // Atualizar mantém o identificador; gravar de novo com o mesmo id substitui.
  const updated = store.save({ ...shapeOf(MAJOR), id: saved.id, label: 'Minha maior' }, BASS4);
  assert.equal(updated.id, saved.id);
  assert.equal(store.group('bass4').length, 1);
  assert.equal(store.group('bass4')[0].label, 'Minha maior');
  // Excluir limpa o grupo inteiro do documento.
  assert.equal(store.remove(saved.id, BASS4), true);
  assert.equal(store.remove(saved.id, BASS4), false);
  assert.equal(JSON.parse(storage.getItem(FINGERING_SHAPES_KEY)).instruments.bass4, undefined);
});

test('loja: lista é por instrumento e a forma de 4 cordas reaparece no baixo 5', () => {
  const store = createFingeringShapeStore({ storage: memoryStorage(), uuid });
  const saved = store.save(shapeOf(MAJOR), BASS4);
  const list4 = store.list(BASS4);
  const list5 = store.list(BASS5);
  assert.deepEqual(list4.map(record => record.generic), [true, true, true, false]);
  const mine = list5.find(record => record.id === saved.id);
  assert.equal(mine.instrument, 'bass4');
  assert.equal(mine.reused, true);
  assert.equal(mine.applicable, true);
  assert.equal(list4.find(record => record.id === saved.id).reused, false);
  // O gerador posiciona o MESMO molde no baixo 5 preservando os intervalos.
  const placement = shapeOverlay(toGeneratorShape(mine), BASS5, 0, { from: 0, to: 12, open: true });
  assert.equal(placement.positions.length, 3);
  assert.equal(placement.positions[0].degree, 1);
  assert.equal(placement.positions[0].pitch % 12, 0);
  assert.deepEqual(placement.positions.map(note => note.pitch - placement.positions[0].pitch), [0, 4, 7]);
  assert.ok(placement.positions.every(note => note.string >= 1 && note.string <= 5 && note.fret >= 0 && note.fret <= 24));
});

test('loja: a forma escrita no baixo 5 usa a corda Si', () => {
  const store = createFingeringShapeStore({ storage: memoryStorage(), uuid });
  const siShape = { label: 'Oitava na Si', quality: 'major', degrees: [1, 5, 8], notes: [{ string: 5, fret: 3, degree: 1 }, { string: 4, fret: 5, degree: 5 }, { string: 3, fret: 5, degree: 8 }] };
  const saved = store.save(shapeOf(siShape), BASS5);
  const record = store.list(BASS5).find(item => item.id === saved.id);
  assert.equal(checkShape(toGeneratorShape(record), { profile: BASS5 }).ok, true);
  assert.equal(applicableTo(record, BASS5), true);
  // No baixo 5 a tônica Si cai na corda grave: corda 5, casa 0.
  const five = shapeOverlay(toGeneratorShape(record), BASS5, 11, { from: 0, to: 12, open: true });
  assert.equal(five.positions[0].string, 5);
  assert.equal(five.positions[0].pitch % 12, 11);
  assert.deepEqual(five.positions.map(note => note.pitch - five.positions[0].pitch), [0, 7, 12]);
  // No baixo de 4 a forma não tem posição própria: ou o A2 a desloca para um
  // conjunto de cordas que existe (intervalos preservados), ou não há posição.
  const four = shapeOverlay(toGeneratorShape(record), BASS4, 11, { from: 0, to: 12, open: true });
  if (four.positions !== null) {
    assert.ok(four.positions.every(note => note.string >= 1 && note.string <= 4), 'nenhuma corda inexistente');
    assert.deepEqual(four.positions.map(note => note.pitch - four.positions[0].pitch), [0, 7, 12]);
  }
  assert.equal(store.list(BASS4).find(item => item.id === saved.id).instrument, 'bass5');
});

test('loja: deslocamento para a corda Si quando couber (A2)', { skip: stringShiftSupported() ? false : 'o posicionador do A2 ainda não desloca o molde entre conjuntos de cordas' }, () => {
  const placement = shapeOverlay(toGeneratorShape(genericShapes(BASS5)[0]), BASS5, 4, { from: 4, to: 7, open: true });
  assert.ok(placement.positions !== null);
  assert.ok(placement.positions.some(note => note.string === 5), 'a forma de 4 cordas começa na corda Si quando a posição é melhor');
  assert.equal(placement.stringShift, 1);
  assert.deepEqual(placement.positions.map(note => note.pitch - placement.positions[0].pitch), [0, 4, 7]);
});

function stringShiftSupported() {
  try {
    const placed = applyShape(BASS5, toGeneratorShape(genericShapes(BASS5)[0]), { root: 4, notes: [] }, { from: 0, to: 24, open: true, strings: null });
    return (placed?.stringShift ?? 0) !== 0 || (placed?.positions ?? []).some(note => note.string === 5);
  } catch { return false; }
}

test('loja: importação une sem duplicar e renomeia o conflito de conteúdo', () => {
  const store = createFingeringShapeStore({ storage: memoryStorage(), uuid });
  const saved = store.save(shapeOf(MAJOR), BASS4);
  // Reimportar o próprio documento é idempotente.
  const again = store.importDocument(store.exportDocument());
  assert.deepEqual({ added: again.added, reused: again.reused, renamed: again.renamed }, { added: 0, reused: 1, renamed: 0 });
  // Mesmo id com conteúdo diferente entra como forma NOVA (nada é sobrescrito).
  const conflicting = { version: 1, instruments: { bass4: [{ ...shapeOf(MAJOR), id: saved.id, label: 'Outra' }] } };
  const merged = store.importDocument(conflicting);
  assert.deepEqual({ added: merged.added, reused: merged.reused, renamed: merged.renamed }, { added: 0, reused: 0, renamed: 1 });
  assert.equal(store.group('bass4').length, 2);
  assert.equal(store.group('bass4')[0].label, MAJOR.label);
  // Forma inválida é recusada com o motivo, sem derrubar o resto do documento.
  const broken = { version: 1, instruments: { bass4: [{ ...shapeOf(MAJOR), quality: 'sus4' }] } };
  const report = store.importDocument(broken);
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].code, 'forma');
  // Grupo desconhecido também é dito, e nada é gravado por ele.
  const unknownGroup = store.importDocument({ version: 1, instruments: { bass6: [] } });
  assert.equal(unknownGroup.ok, false);
  assert.equal(unknownGroup.errors[0].code, 'instrumento');
  assert.equal(store.group('bass4').length, 2);
});

test('loja: bytes ilegíveis são preservados e a gravação fica bloqueada', () => {
  const storage = memoryStorage();
  storage.raw.set(FINGERING_SHAPES_KEY, '{ nem é json');
  const store = createFingeringShapeStore({ storage, uuid });
  assert.equal(store.status, 'corrupt');
  assert.equal(store.recoveryRaw, '{ nem é json');
  assert.match(store.warning, /ilegíveis/);
  // Nenhuma mutação acontece em memória nem no disco antes da ação explícita.
  assert.throws(() => store.save(shapeOf(MAJOR), BASS4), /ilegíveis/);
  assert.equal(store.importDocument({ version: 1, instruments: { bass4: [shapeOf(MAJOR)] } }).ok, false);
  assert.equal(store.remove('qualquer', BASS4), false);
  assert.equal(storage.getItem(FINGERING_SHAPES_KEY), '{ nem é json');   // nunca sobrescreve
  assert.equal(store.list(BASS4).length, 3);                             // genéricas continuam disponíveis
  assert.equal(store.discardCorrupt(), true);
  assert.equal(store.status, 'ready');
  assert.equal(JSON.parse(storage.getItem(FINGERING_SHAPES_KEY)).instruments.bass4, undefined);
  assert.equal(store.save(shapeOf(MAJOR), BASS4).label, MAJOR.label);
});

test('loja: sem armazenamento trabalha em memória e avisa', () => {
  const store = createFingeringShapeStore({ storage: null, uuid });
  assert.equal(store.status, 'unavailable');
  assert.match(store.warning, /nesta visita/);
  const saved = store.save(shapeOf(MAJOR), BASS4);
  assert.equal(store.list(BASS4).some(record => record.id === saved.id), true);
  const quotaStorage = memoryStorage();
  quotaStorage.failWrites(true);
  const quota = createFingeringShapeStore({ storage: quotaStorage, uuid });
  quota.save(shapeOf(MAJOR), BASS4);
  assert.equal(quota.persistent, false);
  assert.match(quota.warning, /sem espaço/);
  assert.equal(quota.list(BASS4).length, 4);   // 3 genéricas + a do usuário, em memória
});

// ------------------------------------------------- gerador (A2) e receita

test('receita: a forma da loja entra em recipe.shape e gera notas', () => {
  const store = createFingeringShapeStore({ storage: memoryStorage(), uuid });
  const shape = shapeChoicesForRecipe(BASS4, { store })[0];
  assert.equal(shape.generic, true);
  const recipe = normalizeRecipe({
    version: 1,
    family: 'arpejo_triade_forma_unica',
    profile: { type: 'bass', strings: 4 },
    progression: { kind: 'lista', chords: ['C'], quality: 'major' },
    bars: 1,
    shape: shape.shape,
  });
  assert.deepEqual(recipe.shape.notes.map(note => [note.string, note.fret, note.degree]), [[4, 3, 1], [3, 2, 3], [3, 5, 5]]);
  const result = generateStudy(recipe);
  assert.ok(result.notes.length >= 3, 'o estudo gerado tem as notas da forma');
  assert.deepEqual([...new Set(result.notes.map(note => note.degree))].sort((a, b) => a - b), [1, 3, 5]);
  assert.ok(result.notes.every(note => Number.isInteger(note.string) && Number.isInteger(note.fret)));
  assert.deepEqual(result.positions.length, result.notes.length);
  // O mesmo molde, salvo pelo usuário, chega pela loja e não vaza marcações da interface.
  const saved = store.save(shapeOf(MAJOR), BASS4);
  const fromStore = shapeForRecipe(saved.id, BASS4, { store });
  assert.deepEqual(Object.keys(fromStore).sort(), ['degrees', 'id', 'label', 'notes', 'quality']);
  assert.equal(fromStore.notes.length, 3);
  assert.throws(() => shapeForRecipe('nao-existe', BASS4, { store }), RangeError);
});

// -------------------------------------------------------------- editor

test('editor: cria a forma clicando as notas, valida os graus e salva', () => {
  const document_ = createDom();
  const panel = document_.createElement('section');
  const table = createTable(document_, [[4, 0], [4, 3], [3, 1], [3, 2], [3, 5], [3, 6], [2, 5], [2, 7]]);
  const storage = memoryStorage();
  const store = createFingeringShapeStore({ storage, uuid });
  let repaints = 0;
  const view = mountFingeringShapes(panel, { store, table, repaint: () => { repaints += 1; } });
  view.render(BASS4);

  // A genérica maior já vem selecionada e o editor informa a referência.
  assert.equal(view.selected().id, 'generica-maior');
  assert.match(view.message().text, /Referência: G1/);
  const before = repaints;

  // Nova forma: nome sugerido, edição ligada e nenhuma nota.
  panel.querySelector('#shape-new').click();
  assert.equal(view.selected().notes.length, 0);
  assert.match(panel.querySelector('#shape-name').value, /fundamental/);
  assert.equal(view.message().error, false);

  // Primeira nota é a tônica; uma nota sozinha ainda não é forma.
  table.dispatch('click', { target: cellAt(table, 4, 3) });
  assert.deepEqual(view.selected().notes, [{ string: 4, fret: 3, degree: 1 }]);
  assert.equal(view.message().error, true);
  assert.equal(panel.querySelector('#shape-save').disabled, true);

  // Terça maior confere (4 semitons); a casa 6 tem 8 semitons e é recusada com motivo.
  table.dispatch('click', { target: cellAt(table, 3, 2) });
  assert.deepEqual(view.selected().notes.map(note => note.degree), [1, 3]);
  table.dispatch('click', { target: cellAt(table, 3, 6) });
  assert.equal(view.selected().notes.length, 2);
  assert.match(view.message().text, /8 semitom/);
  assert.equal(view.message().error, true);

  // Quinta fecha a tríade e a forma passa a valer.
  table.dispatch('click', { target: cellAt(table, 3, 5) });
  assert.deepEqual(view.selected().notes.map(note => note.degree), [1, 3, 5]);
  assert.equal(view.message().error, false);
  assert.equal(panel.querySelector('#shape-save').disabled, false);

  // Nome + salvar: a forma entra na loja, no grupo do instrumento.
  const name = panel.querySelector('#shape-name');
  name.value = 'Maior · fundamental · Forma 1';
  name.dispatch('input');
  panel.querySelector('#shape-save').click();
  assert.equal(store.group('bass4').length, 1);
  assert.equal(store.group('bass4')[0].label, 'Maior · fundamental · Forma 1');
  assert.match(view.message().text, /salva em Baixo 4 cordas/);
  assert.ok(repaints > before);
});

test('editor: destaca a forma sobre o acorde atual e não sobrescreve genérica', () => {
  const document_ = createDom();
  const panel = document_.createElement('section');
  const table = createTable(document_, [[4, 3], [3, 2], [3, 5], [2, 5], [1, 2]]);
  const store = createFingeringShapeStore({ storage: memoryStorage(), uuid });
  const view = mountFingeringShapes(panel, { store, table, repaint: () => {} });
  view.render(BASS4);

  // Sol (7) é a fundamental do próprio molde escrito: as notas caem nas casas 3/2/5.
  view.decorate(table, { profile: BASS4, root: 7, from: 0, to: 12 });
  assert.equal(cellAt(table, 4, 3).dataset.shapeDegree, '1');
  assert.equal(cellAt(table, 3, 2).dataset.shapeDegree, '3');
  assert.equal(cellAt(table, 3, 5).dataset.shapeDegree, '5');
  assert.equal(cellAt(table, 4, 3).classes.has('fretboard-shape-anchor'), true);
  assert.equal(cellAt(table, 2, 5).dataset.shapeDegree, undefined);
  assert.equal(table.dataset.shapeEditing, 'false');
  assert.match(panel.querySelector('#shape-overlay-status').textContent, /em G \(fundamental do acorde atual\)/);

  // Dó (0) exige deslocamento: o destaque sai da faixa visível e é dito.
  view.decorate(table, { profile: BASS4, root: 0, from: 0, to: 12 });
  assert.match(panel.querySelector('#shape-overlay-status').textContent, /fora desta faixa/);

  // Editar a genérica cria uma cópia do usuário: o grau 8 só entra depois de
  // acrescentado (e o clique na oitava explica exatamente isso).
  panel.querySelector('#shape-edit').click();
  view.decorate(table, { profile: BASS4, root: 7, from: 0, to: 12 });
  assert.equal(table.dataset.shapeEditing, 'true');
  assert.match(panel.querySelector('#shape-overlay-status').textContent, /na posição escrita/);
  table.dispatch('click', { target: cellAt(table, 2, 5) });
  assert.match(view.message().text, /grau 8/);
  assert.equal(view.selected().id, 'generica-maior');   // o clique recusado não muda nada
  assert.equal(view.selected().notes.length, 3);
  const addSelect = panel.querySelector('#shape-degree-add');
  addSelect.value = '8';
  panel.querySelector('#shape-degree-add-button').click();
  assert.deepEqual(view.selected().degrees, [1, 3, 5, 8]);
  table.dispatch('click', { target: cellAt(table, 2, 5) });
  assert.equal(view.selected().id, null);                // agora a genérica virou cópia sua
  assert.match(view.selected().label, /\(minha\)/);
  assert.deepEqual(view.selected().notes.map(note => note.degree), [1, 3, 5, 8]);
  assert.equal(view.message().error, false);
  // A ordem dos graus é reordenável (é a ordem da figura).
  const order = panel.querySelector('#shape-degree-order');
  const down = order.querySelectorAll('button')[1];
  down.click();
  assert.deepEqual(view.selected().degrees, [3, 1, 5, 8]);
  assert.equal(view.selected().degrees.includes(1), true);
  // Salvar a cópia não toca na genérica: a loja ganha uma forma própria.
  const name = panel.querySelector('#shape-name');
  name.value = 'Minha oitava';
  name.dispatch('input');
  panel.querySelector('#shape-save').click();
  assert.equal(store.group('bass4').length, 1);
  assert.equal(store.group('bass4')[0].label, 'Minha oitava');
  assert.equal(panel.querySelector('#shape-select').querySelectorAll('option')[0].value, 'generica-maior');
});

test('editor: avisa o que não cabe e permite descartar a recuperação', () => {
  const document_ = createDom();
  const panel = document_.createElement('section');
  const table = createTable(document_, [[4, 3], [3, 2], [3, 5]]);
  const storage = memoryStorage();
  storage.raw.set(FINGERING_SHAPES_KEY, 'não é json');
  const store = createFingeringShapeStore({ storage, uuid });
  const view = mountFingeringShapes(panel, { store, table, repaint: () => {} });
  view.render(BASS4);
  const recovery = panel.querySelector('#shape-recovery');
  assert.equal(recovery.hidden, false);
  assert.match(recovery.textContent, /ilegíveis/);
  recovery.querySelectorAll('button')[1].click();
  assert.equal(store.status, 'ready');
  assert.equal(panel.querySelector('#shape-recovery').hidden, true);
  // Montagem sem loja é recusada de forma explícita.
  assert.throws(() => mountFingeringShapes(document_.createElement('section'), { table }), /Loja de formas/);
  view.destroy();
  assert.equal(panel.querySelector('#fingering-shapes'), null);
});
