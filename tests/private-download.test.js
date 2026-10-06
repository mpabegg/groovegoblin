// Convenção de saída de arquivo PRIVADO (nome marcado + confirmação nativa).
//
// Teste de CONSUMIDOR do helper compartilhado: o DOM duplo é o mesmo das telas
// da aula, o download é capturado pelo chamador e os bytes de entrada são
// strings reais de recuperação. Nada aqui faz rede.
//
// Tudo fictício: "Curso de Exemplo", "Aula aula-1", example.invalid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeRoot } from './course-lesson-dom.js';
import {
  PRIVATE_CONFIRM_ACCEPT, PRIVATE_CONFIRM_CANCEL, mountPrivateDownload, privateFileName,
} from '../src/private-download.js';
import { PRIVATE_FILENAME_MARK } from '../src/library-backup.js';

const CANARY = 'AULA-SEGREDO-CANARIO';

function buttonByText(root, text) {
  const button = root.querySelectorAll('button').find(node => node.textContent === text);
  assert.ok(button, `botão “${text}” precisa existir no diálogo`);
  return button;
}

// Bytes crus de recuperação com título de aula fictício: o conteúdo é o que
// NÃO dá para redigir, e é justamente por isso que ele sai marcado.
function rawDump(tag) {
  return JSON.stringify({
    version: 1,
    queue: { items: [{ courseId: 'curso-exemplo', lessonId: 'aula-1', name: `${CANARY}-${tag}`, durationMin: 10 }] },
  });
}

test('privateFileName marca PRIVADO antes da extensão e não inventa extensão', () => {
  assert.equal(privateFileName('groovegoblin-fila-v1.json'), `groovegoblin-fila-v1-${PRIVATE_FILENAME_MARK}.json`);
  assert.equal(privateFileName('groovegoblin-originais.json'), `groovegoblin-originais-${PRIVATE_FILENAME_MARK}.json`);
  assert.equal(privateFileName('sem-extensao'), `sem-extensao-${PRIVATE_FILENAME_MARK}`);
  assert.equal(privateFileName('a.b.json'), `a.b-${PRIVATE_FILENAME_MARK}.json`);
  assert.equal(privateFileName(''), `${PRIVATE_FILENAME_MARK}`);
});

test('cancelar a confirmação não gera arquivo nenhum e avisa o usuário', async () => {
  const release = installDom();
  try {
    const container = makeRoot();
    const downloads = [];
    const notices = [];
    const files = mountPrivateDownload(container, {
      download: (text, filename) => downloads.push({ text, filename }),
      notify: (text, error) => notices.push({ text, error }),
    });
    const pending = files.download(rawDump('cancelado'), 'groovegoblin-fila-v1.json');
    assert.equal(downloads.length, 0, 'nada é escrito antes da decisão');
    buttonByText(files.dialog, PRIVATE_CONFIRM_CANCEL).click();
    assert.equal(await pending, false);
    assert.deepEqual(downloads, [], 'cancelar nunca gera arquivo');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].error, false);
    files.destroy();
  } finally { release(); }
});

test('confirmar escreve os MESMOS bytes com o nome marcado, um arquivo por confirmação', async () => {
  const release = installDom();
  try {
    const container = makeRoot();
    const downloads = [];
    const files = mountPrivateDownload(container, { download: (text, filename) => downloads.push({ text, filename }) });
    const raw = rawDump('confirmado');
    assert.ok(raw.includes(CANARY), 'o dado de entrada é o bytes cru com o título da aula');
    const pending = files.download(raw, 'groovegoblin-fila-corrompida.json');
    buttonByText(files.dialog, PRIVATE_CONFIRM_ACCEPT).click();
    assert.equal(await pending, true);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].text, raw, 'os bytes crus de recuperação saem intactos');
    assert.equal(downloads[0].filename, `groovegoblin-fila-corrompida-${PRIVATE_FILENAME_MARK}.json`);
    files.destroy();
  } finally { release(); }
});

test('destruir o controlador com uma confirmação aberta equivale a cancelar', async () => {
  const release = installDom();
  try {
    const container = makeRoot();
    const downloads = [];
    const files = mountPrivateDownload(container, { download: (text, filename) => downloads.push({ text, filename }) });
    const pending = files.download(rawDump('abandonado'), 'groovegoblin-biblioteca-corrompida.json');
    files.destroy();
    assert.equal(await pending, false);
    assert.deepEqual(downloads, []);
    assert.equal(container.querySelectorAll('dialog').length, 0, 'o diálogo sai do documento com a tela');
  } finally { release(); }
});

test('o diálogo é nativo (um <dialog> com confirmação e cancelamento explícitos)', () => {
  const release = installDom();
  try {
    const container = makeRoot();
    const files = mountPrivateDownload(container, { download: () => {} });
    const dialogs = container.querySelectorAll('dialog');
    assert.equal(dialogs.length, 1);
    const texts = dialogs[0].querySelectorAll('button').map(node => node.textContent);
    assert.deepEqual(texts, [PRIVATE_CONFIRM_CANCEL, PRIVATE_CONFIRM_ACCEPT]);
    assert.equal(dialogs[0].hasAttribute('open'), false, 'o aviso nasce fechado');
    files.destroy();
  } finally { release(); }
});
