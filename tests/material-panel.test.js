// Painel do material do curso embutido (rodada 6, etapa 8 / B4b) — consumidor.
//
// O PDF abre num iframe da MESMA origem, já na página pedida; a faixa toca num
// player nativo apontando para o blob autenticado; o painel fecha com Esc e com
// o botão, e nunca abre com endereço que não venha do sha256 conferido.
//
// Tudo fictício: exemplo.invalid e sha256 inventado.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apostilaButtonNode, materialPanelUrl, mountMaterialPanel, resetSharedMaterialPanel, serverMaterialNodes, sharedMaterialPanel } from '../src/material-panel.js';
import { installDom, makeEvent, makeRoot } from './course-lesson-dom.js';

const SHA = 'c'.repeat(64);
const BASE = 'https://groove.exemplo.ts.net/';

function contentStub() {
  return { blobUrl: (sha) => (typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha) ? `${BASE}api/blobs/${sha}` : null) };
}

test('painel: apostila abre na página pedida dentro da própria origem', (t) => {
  const release = installDom();
  const root = makeRoot();
  t.after(() => release());
  const panel = mountMaterialPanel(root, { content: contentStub() });

  assert.equal(panel.isOpen, false);
  assert.equal(panel.open({ sha256: SHA, kind: 'pdf', name: 'Apostila de Exemplo.pdf', page: 12, size: 2048 }), true);
  assert.equal(panel.isOpen, true);
  const frame = root.querySelector('#material-panel-frame');
  assert.equal(frame.src, `${BASE}api/blobs/${SHA}#page=12`);
  assert.equal(frame.getAttribute('title'), 'Apostila: Apostila de Exemplo.pdf');
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.match(root.querySelector('.material-panel-meta').textContent, /apostila · 2 KB · página 12/);
  assert.match(root.querySelector('.material-panel-note').textContent, /página 12/);
  assert.equal(panel.current.page, 12);
  assert.equal(panel.current.sha256, SHA);
  panel.destroy();
});

test('painel: sem página válida não inventa parâmetro e endereço só vem do sha conferido', (t) => {
  const release = installDom();
  const root = makeRoot();
  t.after(() => release());
  const content = contentStub();
  const panel = mountMaterialPanel(root, { content });

  assert.equal(materialPanelUrl(content, SHA), `${BASE}api/blobs/${SHA}`);
  assert.equal(materialPanelUrl(content, 'xyz'), null);
  assert.equal(materialPanelUrl(content, null), null);
  assert.equal(materialPanelUrl(null, SHA), null);

  panel.open({ sha256: SHA, kind: 'pdf', name: 'Apostila', page: 0 });
  assert.equal(root.querySelector('#material-panel-frame').src, `${BASE}api/blobs/${SHA}`);
  assert.equal(panel.current.page, null);

  assert.equal(panel.open({ sha256: 'nao-e-sha', kind: 'pdf' }), false);
  assert.equal(panel.open(null), false);
  assert.equal(panel.current.sha256, SHA, 'abertura recusada não troca o material atual');
  panel.destroy();
});

test('painel: a faixa toca no player nativo, apontando para o blob do servidor', (t) => {
  const release = installDom();
  const root = makeRoot();
  t.after(() => release());
  const panel = mountMaterialPanel(root, { content: contentStub() });
  panel.open({ sha256: SHA, kind: 'audio', name: 'Faixa de Exemplo', size: 1024 * 1024 });
  const audio = root.querySelector('#material-panel-audio');
  assert.equal(audio.src, `${BASE}api/blobs/${SHA}`);
  assert.equal(audio.getAttribute('controls'), 'true');
  assert.equal(audio.getAttribute('loop'), 'true');
  assert.equal(audio.getAttribute('preload'), 'metadata');
  assert.match(root.querySelector('.material-panel-meta').textContent, /faixa · 1.0 MB/);
  assert.match(root.querySelector('.material-panel-note').textContent, /em repetição/);
  panel.destroy();
});

test('painel: fechar limpa o conteúdo e Esc fecha pelo teclado', (t) => {
  const release = installDom();
  const root = makeRoot();
  t.after(() => release());
  const panel = mountMaterialPanel(root, { content: contentStub() });
  panel.open({ sha256: SHA, kind: 'pdf', name: 'Apostila de Exemplo.pdf', page: 3 });
  const frame = root.querySelector('#material-panel-frame');
  panel.close();
  assert.equal(panel.isOpen, false);
  assert.equal(panel.current, null);
  assert.equal(frame.src, '', 'o iframe é esvaziado ao fechar');
  assert.equal(root.querySelector('#material-panel-frame'), null);
  assert.equal(panel.close(), false, 'fechar duas vezes não é erro');

  panel.open({ sha256: SHA, kind: 'audio', name: 'Faixa' });
  panel.element.dispatchEvent(makeEvent('keydown', { key: 'Escape' }));
  assert.equal(panel.isOpen, false);
  panel.destroy();
});

test('painel: arquivo que não é PDF nem áudio só oferece download do servidor', (t) => {
  const release = installDom();
  const root = makeRoot();
  t.after(() => release());
  const panel = mountMaterialPanel(root, { content: contentStub() });
  panel.open({ sha256: SHA, kind: 'other', name: 'Pacote de Exemplo.zip', size: 4096 });
  const link = root.querySelector('.material-panel-download');
  assert.equal(link.href, `${BASE}api/blobs/${SHA}`);
  assert.equal(link.getAttribute('download'), 'Pacote de Exemplo.zip');
  assert.equal(root.querySelector('iframe'), null);
  assert.equal(root.querySelector('audio'), null);
  panel.destroy();
});

test('painel: sem cópia no servidor não há nó nenhum para a aula', (t) => {
  const release = installDom();
  const root = makeRoot();
  t.after(() => release());
  const panel = mountMaterialPanel(root, { content: contentStub() });
  assert.deepEqual(serverMaterialNodes({ panel, ref: null }), []);
  assert.deepEqual(serverMaterialNodes({ panel, ref: { sha256: 'nao-e-sha' } }), []);
  assert.equal(apostilaButtonNode({ panel, ref: null }), null);
  assert.equal(apostilaButtonNode({ panel, ref: { sha256: SHA, kind: 'audio' } }), null);
  panel.destroy();
});

test('painel: os nós da aula abrem a apostila e tocam a faixa do servidor', (t) => {
  const release = installDom();
  const root = makeRoot();
  t.after(() => release());
  const panel = mountMaterialPanel(root, { content: contentStub() });

  const apostila = { sha256: SHA, kind: 'pdf', name: 'Apostila de Exemplo.pdf', size: 100, refKey: 'ref-1' };
  const [button] = serverMaterialNodes({ panel, ref: apostila, index: 0, page: 12, name: 'Apostila de Exemplo.pdf' });
  assert.equal(button.textContent, 'Abrir na apostila (página 12)');
  button.click();
  assert.equal(panel.current.page, 12);
  assert.equal(panel.current.sha256, SHA);

  const faixa = { sha256: SHA, kind: 'audio', name: 'Faixa de Exemplo', size: 10, refKey: 'ref-2' };
  const nodes = serverMaterialNodes({ panel, ref: faixa, index: 1 });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].tagName, 'AUDIO');
  assert.equal(nodes[0].src, `${BASE}api/blobs/${SHA}`);
  assert.match(nodes[1].textContent, /Range/);

  const verNaApostila = apostilaButtonNode({ panel, ref: apostila, index: 3, page: 30 });
  assert.equal(verNaApostila.textContent, 'Ver na apostila');
  panel.close();
  verNaApostila.click();
  assert.equal(panel.current.page, 30);
  panel.destroy();
});

test('painel: uma instância só para o app inteiro', (t) => {
  const release = installDom();
  const root = makeRoot();
  t.after(() => { resetSharedMaterialPanel(); release(); });
  const content = contentStub();
  const first = sharedMaterialPanel({ content, container: root });
  assert.ok(first);
  assert.equal(sharedMaterialPanel({ content, container: root }), first, 'a segunda chamada reusa o painel');
  assert.equal(first.content, content);
  first.open({ sha256: SHA, kind: 'pdf', name: 'Apostila' });
  assert.equal(first.isOpen, true);
  resetSharedMaterialPanel();
  const noBody = sharedMaterialPanel({ content, container: root });
  assert.ok(noBody);
  assert.equal(noBody.element.parentNode, root, 'o painel é pendurado no contêiner informado');
  assert.equal(noBody.content, content);
});
