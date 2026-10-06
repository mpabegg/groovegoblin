// DOM mínimo para os testes de tela da aula (rodada 5, etapa 6).
//
// O shim existe só para exercitar `mountCourseLesson` de verdade: criação de
// nós, atributos/data-*, `<details open>`, foco, eventos (click/input/change/
// visibilitychange/pagehide) e os seletores que a página e o
// `renderKeepingFocus` usam. Nada aqui faz rede, timers ou IndexedDB — quem
// fornece isso é o teste.

function kebab(text) {
  return String(text).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

function camel(text) {
  return String(text).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function tokensOf(part) {
  return part.match(/[a-zA-Z][\w-]*|#[\w-]+|\.[\w-]+|\[[^\]]+\]|:not\([^)]*\)/g) ?? [];
}

export function matches(el, selector) {
  return String(selector).split(',').some(part => matchesCompound(el, part.trim()));
}

function matchesCompound(el, part) {
  const trimmed = part.trim();
  if (trimmed === '' || trimmed === '*') return true;
  for (const token of tokensOf(trimmed)) {
    if (token.startsWith('#')) {
      if (el.id !== token.slice(1)) return false;
    } else if (token.startsWith('.')) {
      if (!el.classes.has(token.slice(1))) return false;
    } else if (token.startsWith('[attr') || token.startsWith('[')) {
      const inner = token.slice(1, -1).trim();
      const eq = inner.indexOf('=');
      if (eq === -1) {
        if (!el.hasAttribute(inner)) return false;
      } else {
        const name = inner.slice(0, eq).trim();
        const value = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (String(el.getAttribute(name) ?? '') !== value) return false;
      }
    } else if (token.startsWith(':not(')) {
      if (matchesCompound(el, token.slice(5, -1))) return false;
    } else if (el.tagName !== token.toUpperCase()) {
      return false;
    }
  }
  return true;
}

export function makeEvent(type, props = {}) {
  return { type, target: null, currentTarget: null, preventDefault() {}, stopPropagation() {}, ...props };
}

export class El {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.classes = new Set();
    this._text = '';
    this._value = undefined;
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.src = '';
    this.type = '';
    this.files = null;
    this.dataset = new Proxy({}, {
      get: (_, key) => this.attrs.get(`data-${kebab(String(key))}`),
      set: (_, key, value) => { this.attrs.set(`data-${kebab(String(key))}`, String(value)); return true; },
      has: (_, key) => this.attrs.has(`data-${kebab(String(key))}`),
      deleteProperty: (_, key) => { this.attrs.delete(`data-${kebab(String(key))}`); return true; },
      ownKeys: () => [...this.attrs.keys()].filter(key => key.startsWith('data-')).map(key => camel(key.slice(5))),
      getOwnPropertyDescriptor: (_, key) => ({
        configurable: true,
        enumerable: true,
        value: this.attrs.get(`data-${kebab(String(key))}`),
      }),
    });
  }

  get id() { return this.attrs.get('id') ?? ''; }
  set id(value) { this.attrs.set('id', String(value)); }
  // Acesso refletido dos atributos que o app lê (o DOM real faz o mesmo).
  get title() { return this.attrs.get('title') ?? ''; }
  set title(value) { this.attrs.set('title', String(value)); }
  get href() { return this.attrs.get('href') ?? ''; }
  set href(value) { this.attrs.set('href', String(value)); }
  get rel() { return this.attrs.get('rel') ?? ''; }
  set rel(value) { this.attrs.set('rel', String(value)); }
  get target() { return this.attrs.get('target') ?? ''; }
  set target(value) { this.attrs.set('target', String(value)); }
  get download() { return this.attrs.get('download') ?? ''; }
  set download(value) { this.attrs.set('download', String(value)); }
  get placeholder() { return this.attrs.get('placeholder') ?? ''; }
  set placeholder(value) { this.attrs.set('placeholder', String(value)); }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get classList() {
    const classes = this.classes;
    return {
      add: (...names) => { for (const name of names) classes.add(name); },
      remove: (...names) => { for (const name of names) classes.delete(name); },
      contains: name => classes.has(name),
      toggle: name => (classes.has(name) ? (classes.delete(name), false) : (classes.add(name), true)),
    };
  }
  get textContent() { return `${this._text}${this.children.map(child => child.textContent ?? '').join('')}`; }
  set textContent(value) { this._text = String(value); this.children = []; }
  // `value` reflete o atributo (como no DOM real) até alguém atribuir direto.
  get value() { return this._value === undefined ? (this.attrs.get('value') ?? '') : this._value; }
  set value(next) { this._value = String(next ?? ''); }
  get open() { return this.attrs.has('open'); }
  set open(value) { if (value) this.attrs.set('open', ''); else this.attrs.delete('open'); }
  get isConnected() { let node = this; while (node) { if (node.__document) return true; node = node.parentNode; } return false; }

  setAttribute(name, value) {
    const key = String(name);
    if (key === 'class') { this.className = String(value); return; }
    if (key === 'hidden') { this.hidden = true; this.attrs.set('hidden', String(value)); return; }
    if (key === 'disabled') { this.disabled = true; this.attrs.set('disabled', String(value)); return; }
    if (key === 'type') this.type = String(value);
    this.attrs.set(key, String(value));
  }
  getAttribute(name) {
    const key = String(name);
    if (key === 'class') return this.className;
    if (key === 'hidden') return this.hidden ? this.attrs.get('hidden') ?? '' : null;
    if (key === 'disabled') return this.disabled ? this.attrs.get('disabled') ?? '' : null;
    return this.attrs.has(key) ? this.attrs.get(key) : null;
  }
  hasAttribute(name) {
    const key = String(name);
    if (key === 'class') return this.classes.size > 0;
    if (key === 'hidden') return this.hidden;
    if (key === 'disabled') return this.disabled;
    return this.attrs.has(key);
  }
  removeAttribute(name) { this.attrs.delete(String(name)); }

  appendChild(child) {
    if (child === null || child === undefined) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  prepend(...nodes) { for (const node of [...nodes].reverse()) { node.parentNode = this; this.children.unshift(node); } }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  contains(node) { let current = node; while (current) { if (current === this) return true; current = current.parentNode; } return false; }
  closest(selector) { let node = this; while (node) { if (matches(node, selector)) return node; node = node.parentNode; } return null; }
  descendants() {
    const out = [];
    const walk = node => { for (const child of node.children) { if (child.tagName) out.push(child); walk(child); } };
    walk(this);
    return out;
  }
  querySelectorAll(selector) { return this.descendants().filter(node => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter(item => item !== handler));
  }
  dispatchEvent(event) {
    const detail = event && event.type ? event : makeEvent(String(event));
    detail.target = detail.target ?? this;
    detail.currentTarget = this;
    let node = this;
    while (node) {
      for (const handler of [...(node.listeners.get(detail.type) ?? [])]) handler.call(node, detail);
      node = node.parentNode;
    }
    return true;
  }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = null; this.dispatchEvent(makeEvent('blur')); }
  setSelectionRange(start, end) { this.selectionStart = start ?? 0; this.selectionEnd = end ?? 0; }
  click() { this.dispatchEvent(makeEvent('click')); }
}

class TextNode {
  constructor(text) { this.textContent = String(text); this.parentNode = null; }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; } }
}

const globalListeners = new Map();

export const document = {
  activeElement: null,
  hidden: false,
  listeners: new Map(),
  createElement: tag => new El(tag),
  createTextNode: text => new TextNode(text),
  addEventListener(type, handler) {
    if (!document.listeners.has(type)) document.listeners.set(type, []);
    document.listeners.get(type).push(handler);
  },
  removeEventListener(type, handler) {
    const list = document.listeners.get(type) ?? [];
    document.listeners.set(type, list.filter(item => item !== handler));
  },
  dispatchEvent(event) {
    for (const handler of [...(document.listeners.get(event.type) ?? [])]) handler(event);
    return true;
  },
  triggerVisibility(hidden) {
    document.hidden = hidden;
    return document.dispatchEvent(makeEvent('visibilitychange'));
  },
};
document.body = new El('body');
document.body.__document = true;
document.body.parentNode = null;
document.documentElement = new El('html');
document.documentElement.appendChild(document.body);
document.documentElement.__document = true;

// globalThis.addEventListener não existe no Node: o shim registra os eventos de
// janela (pagehide) para o teste poder disparar.
export function installDom() {
  const previous = { document: globalThis.document, addEventListener: globalThis.addEventListener, removeEventListener: globalThis.removeEventListener, Event: globalThis.Event };
  globalThis.document = document;
  globalThis.Event = class Event {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  };
  globalThis.addEventListener = (type, handler) => {
    if (!globalListeners.has(type)) globalListeners.set(type, []);
    globalListeners.get(type).push(handler);
  };
  globalThis.removeEventListener = (type, handler) => {
    const list = globalListeners.get(type) ?? [];
    globalListeners.set(type, list.filter(item => item !== handler));
  };
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    globalListeners.clear();
    document.listeners.clear();
    document.activeElement = null;
    document.hidden = false;
  };
}

export function dispatchWindow(type, event = makeEvent(type)) {
  for (const handler of [...(globalListeners.get(type) ?? [])]) handler(event);
  return true;
}

export function makeRoot() {
  const root = new El('div');
  root.__document = true;
  return root;
}
