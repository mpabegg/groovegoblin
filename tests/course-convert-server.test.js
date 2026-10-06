// "Converter no servidor" na vista Cursos: arquivos privados vão para o
// servidor, o curso volta pelo envelope canônico e entra na loja pelo caminho de
// reimportação; conflito de id exige confirmação e erro do conversor é mostrado.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerConvert, formatConvertSummary } from '../src/course-convert-server.js';

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.hidden = false;
    this.textContent = '';
    this.className = '';
    this.disabled = false;
    this.files = [];
    this.checked = false;
  }

  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  insertBefore(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, target: this }); }
  click() { this.dispatch('click'); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
}

const doc = { createElement: tag => new El(tag), createTextNode: text => ({ textContent: text }) };
const fileOf = value => ({ text: async () => JSON.stringify(value) });

const ENVELOPE = { format: 'groovegoblin-course', version: 1, course: { id: 'curso-exemplo', title: 'Curso de Exemplo', strings: 4 } };

function harness({ convertResults = [] } = {}) {
  const calls = { convert: [], imported: [] };
  const queue = [...convertResults];
  const client = {
    async convert(options) {
      calls.convert.push(options);
      const next = queue.shift() ?? { ok: true, status: 200, saved: true, created: true, courseId: 'curso-exemplo', rev: '3', counts: { sections: 2, lessons: 3, exercises: 1 }, warnings: [] };
      return next;
    },
    async getDoc(collection, id) {
      calls.getDoc = [collection, id];
      return { ok: true, notModified: false, rev: '3', body: ENVELOPE, deleted: false };
    },
  };
  const store = {
    async importText(text, options) {
      calls.imported.push({ text, source: options?.source });
      return { ok: true, created: true, counts: { sections: 2, lessons: 3, exercises: 1 } };
    },
  };
  const notifications = [];
  const converted = [];
  const view = createServerConvert({
    client, store, document: doc,
    notify: (...args) => notifications.push(args),
    onConverted: result => converted.push(result),
  });
  const panel = view.nodes[0].children[1];
  const [mapLabel, catalogLabel, progressLabel, , convertButton, updateButton, status] = panel.children;
  return {
    view, calls, notifications, converted, panel, convertButton, updateButton, status,
    mapInput: mapLabel.children[0],
    catalogInput: catalogLabel.children[0],
    progress: progressLabel.children[0],
    run: options => view.run(options),
  };
}

test('a conversão envia mapa e catálogo, lê o documento canônico e importa pela reimportação', async () => {
  const ui = harness();
  ui.mapInput.files = [fileOf({ curso: { id: 'curso-exemplo' }, modulos: [] })];
  ui.catalogInput.files = [fileOf([{ id: 'ex-1' }])];
  ui.progress.checked = true;

  await ui.run();

  assert.equal(ui.calls.convert.length, 1);
  assert.deepEqual(ui.calls.convert[0].map, { curso: { id: 'curso-exemplo' }, modulos: [] });
  assert.deepEqual(ui.calls.convert[0].catalog, [{ id: 'ex-1' }]);
  assert.equal(ui.calls.convert[0].includeProgress, true);
  assert.equal(ui.calls.imported.length, 1);
  assert.equal(ui.calls.imported[0].source, 'servidor');
  assert.deepEqual(JSON.parse(ui.calls.imported[0].text), ENVELOPE);
  assert.match(ui.status.textContent, /2 seção\(ões\), 3 aula\(s\), 1 exercício\(s\)/);
  assert.equal(ui.converted.length, 1);
  assert.deepEqual(ui.notifications.at(-1), ['Curso convertido no servidor e adicionado à biblioteca — curso-exemplo.']);
});

test('sem o arquivo do mapa, nada é enviado', async () => {
  const ui = harness();
  await ui.run();
  assert.equal(ui.calls.convert.length, 0);
  assert.match(ui.status.textContent, /Escolha o arquivo do mapa/);
  assert.equal(ui.view.nodes[0].className, 'courses-server-import');
});

test('mapa que não é JSON é recusado antes de qualquer envio', async () => {
  const ui = harness();
  ui.mapInput.files = [{ text: async () => 'não é json' }];
  await ui.run();
  assert.equal(ui.calls.convert.length, 0);
  assert.match(ui.status.textContent, /JSON válido/);
});

test('curso já existente pede confirmação e só então atualiza com expectedRev', async () => {
  const ui = harness({
    convertResults: [
      { ok: false, status: 409, code: 'conflict', message: 'Já existe.', courseId: 'curso-exemplo', rev: '9', counts: null, warnings: [] },
      { ok: true, status: 200, saved: true, created: false, courseId: 'curso-exemplo', rev: '10', counts: { sections: 1, lessons: 1, exercises: 0 }, warnings: [] },
    ],
  });
  ui.mapInput.files = [fileOf({ curso: { id: 'curso-exemplo' } })];

  await ui.run();
  assert.equal(ui.updateButton.hidden, false);
  assert.match(ui.status.textContent, /Já existe um curso com este id/);

  await ui.run({ expectedRev: '9' });
  assert.equal(ui.calls.convert.at(-1).expectedRev, '9');
  assert.equal(ui.calls.imported.length, 1);
  assert.equal(ui.updateButton.hidden, true);
});

test('mapa recusado pelo conversor mostra os problemas e não importa nada', async () => {
  const ui = harness({
    convertResults: [{
      ok: false, status: 422, code: 'conversion_invalid', message: 'O conversor não conseguiu ler este mapa.',
      problems: [{ path: 'modulos[0].aulas[0].id', message: 'id inválido' }],
      warnings: [{ path: 'modulos', code: 'campo', message: 'campo não reconhecido' }],
    }],
  });
  ui.mapInput.files = [fileOf({ modulos: [] })];
  await ui.run();
  assert.equal(ui.calls.imported.length, 0);
  assert.match(ui.status.textContent, /recusou este mapa/);
  assert.ok(ui.panel.children.some(node => /id inválido/.test(node.textContent ?? '')));
  assert.ok(ui.panel.children.some(node => /campo não reconhecido/.test(node.textContent ?? '')));
});

test('o resumo conta seções, aulas, exercícios e avisos', () => {
  assert.equal(
    formatConvertSummary({ counts: { sections: 22, lessons: 169, exercises: 24 }, warnings: [{}, {}] }),
    'Curso convertido no servidor: 22 seção(ões), 169 aula(s), 24 exercício(s) · 2 aviso(s) do conversor.',
  );
  assert.equal(formatConvertSummary({ counts: null, warnings: [] }), 'Curso convertido no servidor: sem contagens.');
});
