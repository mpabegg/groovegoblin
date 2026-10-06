// Diálogo de backup da Biblioteca (rodada 5, etapa 7): teste de CONSUMIDOR.
//
// Monta o módulo real com um DOM duplo mínimo (createElement/createTextNode,
// atributos, filhos, eventos e `<dialog>`), como o teste do resultado faz. O
// download é capturado pelo host; leitura de arquivo entra por um File falso.
// Tudo fictício: "Curso de Exemplo", example.invalid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, parseSession, serializeSession } from '../src/session.js';
import { createExerciseLibrary } from '../src/exercise-library.js';
import { createCourseStore, CourseStorageError } from '../src/course-store.js';
import { buildBackup, serializeBackup } from '../src/library-backup.js';
import { mountLibraryBackup } from '../src/library-backup-view.js';

let createAttachmentStore = null;
try { ({ createAttachmentStore } = await import('../src/course-attachments.js')); } catch { /* etapa 6 ausente */ }

// ---------------------------------------------------------------- DOM duplo

class FakeElement {
  constructor(tag, document_) {
    this.tag = tag;
    this.ownerDocument = document_;
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.className = '';
    this._text = '';
    this.id = '';
    this.type = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.files = null;
  }

  get textContent() {
    if (this._text) return this._text;
    return this.children.map(child => child.textContent ?? child.text ?? '').join('');
  }

  set textContent(value) {
    this._text = value ? String(value) : '';
    if (!value) this.children = [];
  }

  setAttribute(key, value) {
    const text = String(value);
    this.attrs[key] = text;
    if (key === 'id') this.id = text;
    else if (key === 'value') this.value = text;
    else if (key === 'type') this.type = text;
    else if (key === 'hidden') this.hidden = true;
    else if (key === 'disabled') this.disabled = true;
    else if (key === 'checked') this.checked = true;
  }

  getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null; }
  removeAttribute(key) { delete this.attrs[key]; }

  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren() { this.children = []; this.textContent = ''; }
  removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; }
  remove() { this.parentNode?.removeChild(this); }
  get firstChild() { return this.children[0] ?? null; }

  querySelector(selector) {
    for (const child of this.children) {
      if (selector.startsWith('#') && child.id === selector.slice(1)) return child;
      if (selector === child.tag) return child;
      const found = child.querySelector?.(selector);
      if (found) return found;
    }
    return null;
  }

  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  dispatch(type, extra = {}) {
    for (const listener of [...(this.listeners[type] ?? [])]) listener({ target: this, ...extra });
  }
  click() { this.dispatch('click'); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function createDom() {
  const document_ = {
    body: null,
    createElement: tag => new FakeElement(tag, document_),
    createTextNode: text => ({ text: String(text), nodeType: 3 }),
    defaultView: null,
  };
  document_.body = new FakeElement('body', document_);
  return document_;
}

// ---------------------------------------------------------------- fixtures

function clock() {
  let ticks = 0;
  return () => new Date(Date.UTC(2026, 9, 5, 12, 0, ticks++)).toISOString();
}
let ids = 0;
function nextUuid() { ids += 1; return `vid-${ids}`; }

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

const COURSE_KEYS = Object.freeze({ courses: 'id', states: 'courseId' });
const ATTACHMENT_KEYS = Object.freeze({ files: 'id', refs: 'key' });

function memoryBackend(keyPaths) {
  const stores = {};
  for (const name of Object.keys(keyPaths)) stores[name] = new Map();
  return {
    async getAll(store) { return [...stores[store].values()].map(value => structuredClone(value)); },
    async get(store, id) { const value = stores[store].get(id); return value === undefined ? undefined : structuredClone(value); },
    async put(store, value) { stores[store].set(value[keyPaths[store]], structuredClone(value)); },
    async writeBatch(entries) {
      for (const entry of entries) {
        if (entry.remove) stores[entry.store].delete(entry.id);
        else stores[entry.store].set(entry.value[keyPaths[entry.store]], structuredClone(entry.value));
      }
    },
    async delete(store, id) { stores[store].delete(id); },
    raw: store => [...stores[store].values()],
  };
}

function lesson(id) {
  return { id, title: `Aula ${id}`, url: `https://example.invalid/${id}`, type: 'aula', hasVideo: false, resources: [], resourceRefs: [], suggestedExercises: [] };
}
const COURSE_DOC = {
  format: 'groovegoblin-course', version: 1,
  course: {
    id: 'curso-exemplo', title: 'Curso de Exemplo', author: 'Autor de Exemplo', instrument: 'bass', strings: 4,
    sections: [{ id: 'modulo-1', title: 'Módulo 1', type: 'módulo', lessons: [lesson('aula-1'), lesson('aula-2')] }],
  },
};
const BASE = () => createSession({ name: 'Sessão base', bars: 4, bpm: 80, notes: [{ id: 'n1', start: 0, duration: 4, pitch: 52, string: 4 }] });

async function setup({ withAttachments = false, withCourse = true } = {}) {
  const document_ = createDom();
  const container = document_.createElement('section');
  const downloads = [];
  const messages = [];
  const library = createExerciseLibrary({
    storage: memoryStorage(), parse: parseSession, serialize: serializeSession,
    currentSession: BASE(), now: clock(), uuid: nextUuid,
  });
  const store = createCourseStore({ backend: memoryBackend(COURSE_KEYS), now: clock(), uuid: nextUuid });
  await store.ready();
  if (withCourse) await store.importText(JSON.stringify(COURSE_DOC));
  let attachments = null;
  if (createAttachmentStore) {
    attachments = createAttachmentStore({ backend: memoryBackend(ATTACHMENT_KEYS), now: clock(), uuid: nextUuid });
    if (withAttachments) {
      await attachments.put({
        courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'apostila.pdf', extension: 'pdf',
        source: 'upload', blob: new Blob([new TextEncoder().encode('%PDF-1.4 apostila fictícia')], { type: 'application/pdf' }),
      });
    }
  }
  const view = mountLibraryBackup(container, {
    library, store, attachments, now: clock(),
    download: (text, filename) => downloads.push({ text, filename }),
    notify: (text, error = false) => messages.push({ text, error }),
  });
  return { document_, container, view, library, store, attachments, downloads, messages };
}

const file = text => ({ text: async () => text });

// ------------------------------------------------------------------- testes

test('view: montagem exige contêiner e biblioteca', () => {
  const document_ = createDom();
  assert.throws(() => mountLibraryBackup(null, {}), /contêiner DOM/);
  assert.throws(() => mountLibraryBackup(document_.createElement('section'), {}), /Biblioteca de exercícios ausente/);
});

test('view: exportação abre o diálogo nativo e baixa o envelope sem anexos por padrão', async () => {
  const world = await setup();
  assert.equal(world.document_.body.children.length, 1);          // o diálogo mora no body
  assert.equal(world.view.dialog.id, 'library-backup-dialog');
  world.view.openExport();
  assert.equal(world.view.dialog.open, true);
  assert.equal(world.view.title.textContent, 'Exportar biblioteca');
  assert.equal(world.view.dialog.querySelector('#backup-include-attachments').checked, false);
  const summary = world.view.dialog.querySelector('#backup-export-summary');
  assert.match(summary.textContent, /1 exercício\(s\)/);
  assert.match(summary.textContent, /1 curso\(s\)/);

  world.view.dialog.querySelector('#backup-export-confirm').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(world.downloads.length, 1);
  const document_ = JSON.parse(world.downloads[0].text);
  assert.equal(document_.kind, 'groovegoblin-library-backup');
  assert.equal(document_.attachments.included, false);
  assert.equal(JSON.stringify(document_).includes('dataBase64'), false);
  assert.match(world.view.status.textContent, /sem anexos/);
  assert.match(world.downloads[0].filename, /^groovegoblin-backup-.*\.json$/);
});

test('view: opt-in de anexos mostra quantidade/tamanho e inclui os bytes', { skip: createAttachmentStore === null ? 'módulo da etapa 6 ausente' : false }, async () => {
  const world = await setup({ withAttachments: true });
  world.view.openExport();
  const checkbox = world.view.dialog.querySelector('#backup-include-attachments');
  const size = world.view.dialog.querySelector('#backup-attachments-size');
  assert.match(size.textContent, /1 arquivo\(s\)/);
  assert.equal(checkbox.disabled, false);
  checkbox.checked = true;
  world.view.dialog.querySelector('#backup-export-confirm').click();
  await new Promise(resolve => setImmediate(resolve));
  const document_ = JSON.parse(world.downloads[0].text);
  assert.equal(document_.attachments.included, true);
  assert.equal(document_.attachments.document.files[0].dataBase64.length > 0, true);
  assert.match(world.view.status.textContent, /com anexos/);
});

test('view: importação válida mostra a prévia, só habilita depois de conferir e aplica', async () => {
  const source = await setup();
  await source.view.exportLibrary();
  const text = source.downloads[0].text;

  const dest = await setup({ withCourse: false });
  dest.view.openImport();
  assert.equal(dest.view.dialog.open, true);
  assert.equal(dest.view.dialog.querySelector('#backup-import-confirm').disabled, true);
  const input = dest.view.dialog.querySelector('#backup-import-file');
  input.files = [file(text)];
  input.dispatch('change');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(dest.view.dialog.querySelector('#backup-import-preview').textContent, /1 exercício\(s\)/);
  assert.equal(dest.view.dialog.querySelector('#backup-import-confirm').disabled, false);

  dest.view.dialog.querySelector('#backup-import-confirm').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(dest.view.status.textContent, /Importação concluída/);
  assert.equal(dest.library.size(), 1);
  assert.equal(dest.store.list().length, 1);
  assert.equal(dest.messages.at(-1).error, false);
});

test('view: JSON inválido e envelope quebrado deixam a importação travada e nada muda', async () => {
  const world = await setup({ withCourse: false });
  world.view.openImport();
  assert.deepEqual(world.view.review('{ não é json'), { ok: false, kind: 'invalid' });
  assert.equal(world.view.dialog.querySelector('#backup-import-confirm').disabled, true);
  const before = world.library.size();

  const broken = { kind: 'groovegoblin-library-backup', version: 1, exercises: { entries: [] }, courses: { records: [], states: [{ courseId: 'x', lessons: { a: { watched: 'sim' } } }] } };
  assert.deepEqual(world.view.review(JSON.stringify(broken)), { ok: false, kind: 'aggregate' });
  assert.equal(world.view.dialog.querySelector('#backup-import-confirm').disabled, true);
  assert.equal(world.view.dialog.querySelector('#backup-import-errors').hidden, false);
  assert.equal(world.library.size(), before);
  assert.equal(world.store.list().length, 0);
});

test('view: backup legado entra pelo caminho antigo (só exercícios)', async () => {
  const source = await setup();
  const legacy = source.library.exportLibrary();
  const dest = await setup({ withCourse: false });
  dest.view.openImport();
  assert.equal(dest.view.review(legacy).kind, 'legacy-library');
  assert.equal(dest.view.dialog.querySelector('#backup-import-confirm').disabled, false);
  const result = await dest.view.importText(legacy);
  assert.equal(result.ok, true);
  assert.equal(result.legacy, 'legacy-library');
  assert.match(dest.view.status.textContent, /Importação concluída/);
});

test('view: anexo malformado recusa inteiro e o diálogo continua utilizável', { skip: createAttachmentStore === null ? 'módulo da etapa 6 ausente' : false }, async () => {
  const source = await setup({ withAttachments: true });
  const built = await buildBackup({ library: source.library, store: source.store, attachments: source.attachments, includeAttachments: true });
  built.document.attachments.document.files[0].dataBase64 = '%%%não é base64%%%';
  const dest = await setup({ withCourse: false });
  dest.view.openImport();
  assert.equal(dest.view.review(serializeBackup(built.document)).kind, 'aggregate');
  const result = await dest.view.importText(serializeBackup(built.document));
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'attachments');
  assert.match(dest.view.status.textContent, /rejeitada/);
  assert.equal(dest.view.status.getAttribute('data-error'), 'true');
  assert.equal(dest.library.size(), 1);
  assert.equal(dest.store.list().length, 0);
  assert.equal(dest.messages.at(-1).error, true);
});

test('view: exportação recusa com motivo visível quando a loja não está lida', async () => {
  const document_ = createDom();
  const container = document_.createElement('section');
  const downloads = [];
  const messages = [];
  const library = createExerciseLibrary({
    storage: memoryStorage(), parse: parseSession, serialize: serializeSession,
    currentSession: BASE(), now: clock(), uuid: nextUuid,
  });
  const store = createCourseStore({ persistent: false, error: new CourseStorageError('unavailable', 'sem IndexedDB para cursos') });
  const view = mountLibraryBackup(container, {
    library, store, now: clock(),
    download: (text, filename) => downloads.push({ text, filename }),
    notify: (text, error = false) => messages.push({ text, error }),
  });
  view.openExport();
  assert.equal(view.dialog.querySelector('#backup-export-confirm').disabled, true);
  assert.match(view.dialog.querySelector('#backup-export-summary').textContent, /IndexedDB/);
  await view.exportLibrary();
  assert.equal(downloads.length, 0);
  const result = await view.exportLibrary();
  assert.equal(result.ok, false);
  assert.equal(result.store, 'courses');
  assert.match(view.status.textContent, /Exportação não concluída/);
  assert.equal(view.status.getAttribute('data-error'), 'true');
  assert.equal(messages.at(-1).error, true);
});

test('view: destroy tira o diálogo do documento', async () => {
  const world = await setup();
  world.view.destroy();
  assert.equal(world.document_.body.children.length, 0);
});
