// Resultado realmente montado: executa o treino (avaliação real do feedback),
// monta a tela com mountResult e confere no DOM as camadas do resultado —
// cifras, pauta rítmica e Tab —, as marcas por nota (cores, sinais, tooltip de
// hover) e a faixa por compasso. Sem reimplementar o renderizador: o mesmo
// renderPracticeScore/notation/tablature é exercitado via DOM duplo mínimo.
//
// O caso central é uma sessão com a vista Ritmo escolhida (padrão do Estúdio):
// o resultado anotado AINDA precisa trazer a tablatura, senão o resultado fica
// sem a camada que o usuário vê ao conferir a execução.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { parseChordSymbol } from '../src/progression.js';
import { evaluateSession } from '../src/feedback.js';
import { mountResult, RESULT_SYMBOLS } from '../src/result-view.js';

// ----- DOM duplo mínimo (createElement/NS, atributos, classes, seletores) ----

function classesOf(node) {
  if (!node._classes) node._classes = new Set();
  return node._classes;
}

function matchesPart(node, part, scope) {
  let rest = part.trim();
  let direct = false;
  if (rest.startsWith(':scope > ')) { direct = true; rest = rest.slice(':scope > '.length); }
  const parsed = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|#[\w-]+|\[[^\]]+\])*)$/.exec(rest);
  if (!parsed) return false;
  const [, tag, tail] = parsed;
  if (direct && node.parent !== scope) return false;
  if (tag && node.tag !== tag) return false;
  for (const token of tail.match(/\.[\w-]+|#[\w-]+|\[[^\]]+\]/g) ?? []) {
    if (token.startsWith('.')) { if (!classesOf(node).has(token.slice(1))) return false; }
    else if (token.startsWith('#')) { if (node.id !== token.slice(1)) return false; }
    else {
      const inner = token.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq === -1) { if (node.attributes[inner] === undefined && node.dataset[inner] === undefined) return false; }
      else {
        const name = inner.slice(0, eq);
        const value = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
        const camel = name.startsWith('data-') ? name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) : name;
        if (String(node.attributes[name] ?? node.dataset[camel]) !== value) return false;
      }
    }
  }
  return true;
}

function createDom() {
  const ids = new Map();
  class Node {
    constructor(tag) {
      this.tag = tag; this.children = []; this.parent = null; this.attributes = {}; this.dataset = {}; this.listeners = {};
      this._classes = new Set(); this.text = ''; this.hidden = false; this.disabled = false; this.open = false;
      this.title = ''; this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    }
    get ownerDocument() { return document_; }
    get isConnected() { return true; }
    set id(value) { this._id = value; ids.set(value, this); }
    get id() { return this._id; }
    get className() { return [...classesOf(this)].join(' '); }
    set className(value) { classesOf(this).clear(); for (const name of String(value).split(/\s+/).filter(Boolean)) classesOf(this).add(name); this.attributes.class = this.className; }
    get classList() {
      return {
        add: (...names) => { for (const name of names) classesOf(this).add(name); this.attributes.class = this.className; },
        remove: (...names) => { for (const name of names) classesOf(this).delete(name); this.attributes.class = this.className; },
        toggle: (name, force) => { const on = force ?? !classesOf(this).has(name); if (on) classesOf(this).add(name); else classesOf(this).delete(name); this.attributes.class = this.className; return on; },
        contains: name => classesOf(this).has(name),
      };
    }
    get textContent() { return this.text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
    set textContent(value) { this.children = []; this.text = String(value); }
    append(...children) {
      for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        if (typeof child === 'string' || typeof child === 'number') { this.children.push(String(child)); continue; }
        child.parent = this; this.children.push(child);
      }
    }
    appendChild(child) { this.append(child); return child; }
    prepend(...children) { this.children.unshift(...children.filter(child => child !== null && child !== undefined)); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    replaceWith(node) { const index = this.parent.children.indexOf(this); this.parent.children.splice(index, 1, node); node.parent = this.parent; }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    setAttribute(name, value) {
      if (name === 'class') { classesOf(this).clear(); for (const part of String(value).split(/\s+/).filter(Boolean)) classesOf(this).add(part); this.attributes.class = this.className; return; }
      this.attributes[name] = String(value);
      // data-* também aparece em dataset, como no DOM real.
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    *walk() { for (const child of this.children) { if (typeof child === 'string') continue; yield child; yield* child.walk(); } }
    querySelectorAll(selector) { return [...this.walk()].filter(node => selector.split(',').some(part => matchesPart(node, part, node.parent))); }
    querySelector(selector) { return [...this.walk()].find(node => selector.split(',').some(part => matchesPart(node, part, this))) ?? null; }
    contains(node) { return node === this || [...this.walk()].includes(node); }
    closest(selector) { let node = this; while (node) { if (matchesPart(node, selector, node.parent)) return node; node = node.parent; } return null; }
    focus() { document_.activeElement = this; }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== listener); }
    getBoundingClientRect() { return { x: 0, y: 0, width: 1000, height: 160, top: 0, left: 0, right: 1000, bottom: 160 }; }
  }
  const document_ = {
    activeElement: null,
    createElement: tag => new Node(tag),
    createElementNS: (namespace, tag) => { const node = new Node(tag); node.namespace = namespace; return node; },
    getElementById: id => ids.get(id) ?? null,
    querySelector: () => null,
    addEventListener() {},
  };
  return { document: document_, Node, ids };
}

// ----- sessão fictícia executada ---------------------------------------------

const chord = (symbol, startBar, durationBars) => ({ ...parseChordSymbol(symbol), startBar, durationBars });

function session(rhythmView = true) {
  return createSession({
    name: 'Prova do resultado', bars: 4, bpm: 60,
    notes: [
      { id: 'a', start: 0, duration: 4, pitch: 52, string: 4 },
      { id: 'b', start: 4, duration: 4, pitch: 55, string: 3 },
      { id: 'c', start: 8, duration: 4, pitch: 59, string: 2 },
      { id: 'd', start: 12, duration: 4, pitch: 61, string: 2 },
    ],
    loop: { startBar: 0, endBar: 1 },
    training: { goal: 'timing', repetitions: 1, countInBars: 0 },
    progression: { enabled: true, cycleBars: 4, chords: [chord('C', 0, 2), chord('G7', 2, 2)] },
    ...(rhythmView ? {} : { extensions: { studio: { phraseView: 'tab' } } }),
  });
}

// Execução real: 'a' no tempo, 'b' atrasada, 'd' omitida, ataque extra depois.
const attempts = [{ start: 0, end: 0.5 }, { start: 1.08, end: 1.5 }, { start: 2.5, end: 2.7 }];

function mountAnnotated(session_) {
  const { document } = createDom();
  const container = document.createElement('section');
  const view = mountResult(container, { getSession: () => session_, isBusy: () => false });
  const results = evaluateSession(session_, attempts);
  view.show({ session: session_, results });
  return { container, view, results };
}

const byNote = (container, noteId) => [...container.querySelectorAll('.rhythm-note')].filter(node => node.dataset.noteId === noteId);
const tabByNote = (container, noteId) => [...container.querySelectorAll('.score-tab-note')].filter(node => node.dataset.noteId === noteId);

test('resultado montado de sessão na vista Ritmo ainda traz cifras e Tab anotados', () => {
  const session_ = session(true);
  assert.equal(session_.extensions?.studio?.phraseView ?? 'rhythm', 'rhythm');
  const { container, view, results } = mountAnnotated(session_);

  assert.equal(container.hidden, false, 'o resultado aparece');
  assert.equal(view.model.session, session_);
  assert.equal(container.querySelectorAll('.practice-score-system').length, 1);
  // Cifras: a camada harmônica continua vindo do mesmo renderizador.
  assert.deepEqual(container.querySelectorAll('.score-chord').map(node => node.textContent), ['C', 'C', 'G7', 'G7']);
  // Tab: derivada das MESMAS notas, mesmo com a vista Ritmo na sessão.
  assert.equal(container.querySelectorAll('.score-tab-note').length, 4);
  assert.equal(container.querySelectorAll('.rhythm-note').length, 4);
  assert.deepEqual(container.querySelectorAll('.score-tab-note').map(node => [node.dataset.noteId, node.dataset.fret, node.dataset.string]), [
    ['a', '2', '4'], ['b', '0', '3'], ['c', '0', '2'], ['d', '2', '2'],
  ]);

  // Marcas por nota: estado real da execução em cada nota, nas DUAS camadas.
  const expected = [['a', 'ok'], ['b', 'late'], ['c', 'missed'], ['d', 'missed']];
  for (const [noteId, status] of expected) {
    for (const node of [...byNote(container, noteId), ...tabByNote(container, noteId)]) {
      assert.ok(node.classList.contains(`result-${status}`), `${noteId} sem classe result-${status}`);
      assert.equal(node.dataset.result, status);
    }
    const title = byNote(container, noteId)[0].querySelector(':scope > title');
    assert.match(title.textContent, /Resultado: /, 'hover por nota mostra o resultado');
    assert.ok(title.textContent.includes(RESULT_SYMBOLS[status]), 'sinal do resultado no tooltip');
  }
  // Sinal desenhado na pauta por nota e marca do ataque extra (linha tracejada).
  assert.equal(container.querySelectorAll('.result-symbol').length, 4);
  const extra = container.querySelectorAll('.result-mark');
  assert.equal(extra.length, 1);
  assert.ok(extra[0].classList.contains('result-extra'));
  // Faixa por compasso: uma célula por compasso do sistema, pior marcado e as
  // células fora do loop vazias.
  const bars = container.querySelectorAll('.result-bar');
  assert.equal(bars.length, 4);
  assert.equal(bars.filter(node => node.classList.contains('result-bar-worst')).length, 1);
  assert.equal(bars.filter(node => node.classList.contains('result-bar-empty')).length, 3);
  assert.equal(bars.filter(node => !node.classList.contains('result-bar-empty'))[0].title, 'Compasso 1: 1 de 4 ataques no tempo · o mais fraco');
  assert.equal(results.rows.filter(row => row.kind === 'extra').length, 1, 'execução real usada no teste');
});

test('resultado de sessão na vista Tab mantém as mesmas camadas e marcas', () => {
  const session_ = session(false);
  const { container } = mountAnnotated(session_);
  assert.deepEqual(container.querySelectorAll('.score-chord').map(node => node.textContent), ['C', 'C', 'G7', 'G7']);
  assert.equal(container.querySelectorAll('.score-tab-note').length, 4);
  assert.equal(container.querySelectorAll('.rhythm-note').length, 4);
  assert.equal(container.querySelectorAll('.result-mark').length, 1);
  assert.equal(container.querySelectorAll('.result-bar').length, 4);
  assert.deepEqual(byNote(container, 'b')[0].dataset.result, 'late');
});

test('resultado sem acordes executados não inventa cifras, mas mantém pauta e Tab', () => {
  const plain = createSession({
    name: 'Sem harmonia', bars: 1, bpm: 60,
    notes: [{ id: 'a', start: 0, duration: 4, pitch: 52, string: 4 }, { id: 'b', start: 4, duration: 4, pitch: 55, string: 3 }],
    loop: { startBar: 0, endBar: 1 }, training: { goal: 'timing', repetitions: 1, countInBars: 0 },
  });
  const { container } = mountAnnotated(plain);
  assert.equal(container.querySelectorAll('.score-chord').length, 0);
  assert.equal(container.querySelectorAll('.score-tab-note').length, 2);
  assert.equal(container.querySelectorAll('.rhythm-note').length, 2);
});
