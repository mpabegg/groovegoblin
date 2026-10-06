// Testes do banco de anexos da aula (rodada 5, etapa 6).
//
// Tudo fictício: arquivos inventados (um PDF falso válido, um "áudio", uma
// página HTML) e endereços em example.invalid. Os testes cobrem o que o
// consumidor vê: guardar, listar por curso/aula, ler o blob, remover e liberar
// espaço, contar bytes de arquivos compartilhados UMA vez, recusar gravação sem
// IndexedDB/quota sem mentir, conferir o CONTEÚDO do arquivo antes de tratá-lo
// como PDF/áudio, exportar/importar estruturado sem perder ou sobrescrever nada
// e o caminho REAL de IndexedDB (fake fiel a keyPath) — inclusive reabrindo a
// loja como se a página tivesse recarregado offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_FORMAT, ATTACHMENT_KINDS, ATTACHMENT_DB_NAME, AttachmentStorageError, attachmentRefKey, base64ToBlob, blobToBase64,
  createAttachmentStore, describeAttachmentStorageError, formatAttachmentSize, openAttachmentStore, parseAttachmentRefKey,
  resetSharedAttachmentStore, sharedAttachmentStore, sniffAttachmentKind,
} from '../src/course-attachments.js';
import { fakeIndexedDB, memoryBackend } from './course-lesson-fixtures.js';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');
const HTML_BYTES = new TextEncoder().encode('<!DOCTYPE html><html><body>oi</body></html>');
const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const WAV_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20]);

function pdfBlob(text = 'documento de exemplo') {
  const bytes = new TextEncoder().encode(`%PDF-1.7\n% ${text}\n%%EOF\n`);
  return new Blob([bytes], { type: 'application/pdf' });
}

function attachmentStore(options = {}) {
  const backend = options.backend ?? memoryBackend({ keyPaths: { files: 'id', refs: 'key' } });
  let counter = 0;
  const store = createAttachmentStore({
    backend,
    now: () => '2026-01-02T03:04:05.000Z',
    uuid: () => `att-${(counter += 1)}`,
    digest: options.digest === undefined ? globalThis.crypto?.subtle ?? null : options.digest,
    ...options.create,
  });
  return { store, backend };
}

function quotaError() {
  const error = new Error('espaço insuficiente');
  error.name = 'QuotaExceededError';
  return error;
}

test('anexos: guardar, listar por curso/aula, ler o blob e contar bytes uma vez', async () => {
  const { store } = attachmentStore();
  await store.ready();
  const key = attachmentRefKey('curso-exemplo', 'aula-1', 'material-1');
  const result = await store.put({
    courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1',
    name: 'Apostila de Exemplo.pdf', role: 'apostila', blob: pdfBlob(),
  });
  assert.equal(result.key, key);
  assert.equal(result.kind, ATTACHMENT_KINDS.pdf);
  assert.equal(result.verified, true);
  assert.equal(result.warning, null);
  assert.equal(result.reusedFile, false);
  assert.equal(parseAttachmentRefKey(key).resourceId, 'material-1');

  const listed = store.list('curso-exemplo', 'aula-1');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'Apostila de Exemplo.pdf');
  assert.equal(listed[0].role, 'apostila');
  assert.equal(listed[0].kind, 'pdf');
  assert.equal(listed[0].size, pdfBlob().size);
  assert.equal(store.has(key), true);
  assert.deepEqual(store.list('curso-exemplo', 'aula-2'), []);
  assert.deepEqual(store.list('outro-curso', 'aula-1'), []);

  const blob = await store.getBlob(key);
  assert.equal(blob.size, pdfBlob().size);
  assert.equal(new TextDecoder().decode((await blob.arrayBuffer()).slice(0, 5)), '%PDF-');

  const totals = store.totals('curso-exemplo');
  assert.equal(totals.files, 1);
  assert.equal(totals.refs, 1);
  assert.equal(totals.bytes, pdfBlob().size);
  assert.equal(totals.byKind.pdf.files, 1);
  assert.equal(store.totals('outro-curso').bytes, 0);
});

test('anexos: mesmo arquivo em duas aulas ocupa bytes uma vez e só sai quando a última ref some', async () => {
  const { store, backend } = attachmentStore();
  await store.ready();
  const blob = pdfBlob('material compartilhado');
  const first = await store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'Compartilhado.pdf', blob });
  const second = await store.put({ courseId: 'curso-exemplo', lessonId: 'aula-2', resourceId: 'material-1', name: 'Compartilhado.pdf', blob });
  assert.equal(second.fileId, first.fileId);
  assert.equal(second.reusedFile, true);

  let totals = store.totals('curso-exemplo');
  assert.equal(totals.files, 1);
  assert.equal(totals.refs, 2);
  assert.equal(totals.bytes, blob.size);

  const removed = await store.remove(first.key);
  assert.equal(removed.removed, true);
  assert.equal(removed.fileDeleted, false);
  assert.equal(removed.freedBytes, 0);
  assert.equal(removed.shared, true);
  assert.equal(store.has(first.key), false);
  assert.equal(store.has(second.key), true);
  totals = store.totals('curso-exemplo');
  assert.equal(totals.bytes, blob.size);

  const last = await store.remove(second.key);
  assert.equal(last.fileDeleted, true);
  assert.equal(last.freedBytes, blob.size);
  totals = store.totals('curso-exemplo');
  assert.equal(totals.files, 0);
  assert.equal(totals.refs, 0);
  assert.equal(totals.bytes, 0);
  assert.equal(await store.getBlob(second.key), null);
  assert.equal(backend.raw('files').length, 0);
});

test('anexos: substituir o arquivo da mesma referência troca o blob e libera o antigo', async () => {
  const { store } = attachmentStore();
  await store.ready();
  const ref = { courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'Material.pdf' };
  const small = await store.put({ ...ref, blob: pdfBlob('curto') });
  const bigger = await store.put({ ...ref, blob: pdfBlob('conteúdo bem mais longo deste documento de exemplo') });
  assert.notEqual(bigger.fileId, small.fileId);
  assert.equal(bigger.replaced, true);
  assert.equal(bigger.freedBytes, pdfBlob('curto').size);
  const totals = store.totals('curso-exemplo');
  assert.equal(totals.refs, 1);
  assert.equal(totals.bytes, pdfBlob('conteúdo bem mais longo deste documento de exemplo').size);
  const blob = await store.getBlob(bigger.key);
  assert.equal(blob.size, pdfBlob('conteúdo bem mais longo deste documento de exemplo').size);
});

test('anexos: PDF só é PDF pelo conteúdo; extensão que mente vira aviso e nunca documento', async () => {
  const pdf = await sniffAttachmentKind(new Blob([PDF_BYTES]), 'pdf');
  assert.equal(pdf.kind, 'pdf');
  assert.equal(pdf.verified, true);
  assert.equal(pdf.warning, null);

  const htmlAsPdf = await sniffAttachmentKind(new Blob([HTML_BYTES]), 'pdf');
  assert.equal(htmlAsPdf.kind, 'other');
  assert.equal(htmlAsPdf.verified, false);
  assert.match(htmlAsPdf.warning, /página web/);

  const htmlAsAudio = await sniffAttachmentKind(new Blob([HTML_BYTES]), 'mp3');
  assert.equal(htmlAsAudio.kind, 'other');
  assert.match(htmlAsAudio.warning, /página web/);

  const html = await sniffAttachmentKind(new Blob([HTML_BYTES]), 'html');
  assert.equal(html.kind, 'other');
  assert.match(html.warning, /baixado/);

  const mp3 = await sniffAttachmentKind(new Blob([MP3_BYTES]), 'mp3');
  assert.equal(mp3.kind, 'audio');
  assert.equal(mp3.verified, true);

  const wav = await sniffAttachmentKind(new Blob([WAV_BYTES]), 'wav');
  assert.equal(wav.kind, 'audio');
  assert.equal(wav.verified, true);

  const unknownAudio = await sniffAttachmentKind(new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]), 'mp3');
  assert.equal(unknownAudio.kind, 'audio');
  assert.equal(unknownAudio.verified, false);
  assert.match(unknownAudio.warning, /não foi possível confirmar/i);

  const zipAsPdf = await sniffAttachmentKind(new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])]), 'pdf');
  assert.equal(zipAsPdf.kind, 'other');
  assert.match(zipAsPdf.warning, /compactado/);
});

test('anexos: gravar o material de um PDF enganoso guarda aviso honesto em vez de mentir o tipo', async () => {
  const { store } = attachmentStore();
  await store.ready();
  const result = await store.put({
    courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1',
    name: 'Disfarçado.pdf', extension: 'pdf', blob: new Blob([HTML_BYTES], { type: 'application/pdf' }),
  });
  assert.equal(result.kind, 'other');
  assert.equal(result.verified, false);
  assert.match(result.warning, /extensão \.pdf/);
  const listed = store.list('curso-exemplo', 'aula-1');
  assert.equal(listed[0].kind, 'other');
  assert.match(listed[0].warning, /não será aberto como PDF/);
});

test('anexos: quota negada rejeita a gravação com erro honesto e não altera registros', async () => {
  const { store, backend } = attachmentStore();
  await store.ready();
  await store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'Primeiro.pdf', blob: pdfBlob('primeiro') });
  const before = store.totals('curso-exemplo');
  backend.failNext(quotaError());
  await assert.rejects(
    () => store.put({ courseId: 'curso-exemplo', lessonId: 'aula-2', resourceId: 'material-2', name: 'Segundo.pdf', blob: pdfBlob('segundo') }),
    error => error instanceof AttachmentStorageError && error.code === 'quota' && /espaço local/i.test(error.message),
  );
  assert.deepEqual(store.totals('curso-exemplo'), before);
  assert.equal(store.has(attachmentRefKey('curso-exemplo', 'aula-2', 'material-2')), false);
  const described = describeAttachmentStorageError(quotaError());
  assert.equal(described.code, 'quota');
  assert.match(described.message, /Nada foi gravado|continuam intactos/);
});

test('anexos: sem IndexedDB a loja recusa escrita e diz o motivo (nada de salva falsa)', async () => {
  const store = createAttachmentStore({
    persistent: false,
    error: new AttachmentStorageError('unavailable', 'IndexedDB indisponível para anexos.'),
  });
  assert.equal(store.persistent, false);
  assert.equal(store.errorCode, 'unavailable');
  await assert.rejects(
    () => store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'Qualquer.pdf', blob: pdfBlob() }),
    error => error instanceof AttachmentStorageError && error.code === 'unavailable',
  );
  await assert.rejects(() => store.remove('qualquer'), error => error.code === 'unavailable');
  assert.equal(await store.getBlob('qualquer'), null);
  assert.deepEqual(store.totals(), { files: 0, refs: 0, bytes: 0, byKind: { pdf: { files: 0, bytes: 0 }, audio: { files: 0, bytes: 0 }, other: { files: 0, bytes: 0 } } });

  const opened = await openAttachmentStore({ indexedDB: null });
  assert.equal(opened.persistent, false);
  assert.equal(opened.errorCode, 'unavailable');
});

test('anexos: arquivo vazio ou envio sem arquivo são recusados antes de gravar', async () => {
  const { store } = attachmentStore();
  await store.ready();
  await assert.rejects(
    () => store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'Nada.pdf', blob: new Blob([]) }),
    error => error instanceof AttachmentStorageError && error.code === 'empty',
  );
  await assert.rejects(
    () => store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'Nome.pdf' }),
    error => error instanceof TypeError,
  );
  assert.equal(store.totals('curso-exemplo').refs, 0);
});

test('anexos: exportar e importar estruturado preserva o que já existe e conta bytes uma vez', async () => {
  const source = attachmentStore();
  await source.store.ready();
  const pdf = pdfBlob('material para backup');
  await source.store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'Backup.pdf', role: 'apostila', blob: pdf });
  await source.store.put({ courseId: 'curso-exemplo', lessonId: 'aula-2', resourceId: 'material-1', name: 'Backup.pdf', blob: pdf });

  const light = await source.store.exportStructured({ courseId: 'curso-exemplo', includeBlobs: false });
  assert.equal(light.ok, true);
  assert.equal(light.document.includeBlobs, false);
  assert.equal(light.document.files.length, 1);
  assert.equal(light.document.files[0].dataBase64, undefined);
  assert.equal(light.document.files[0].size, pdf.size);
  assert.equal(light.document.refs.length, 2);

  const full = await source.store.exportStructured({ courseId: 'curso-exemplo', includeBlobs: true });
  assert.equal(typeof full.document.files[0].dataBase64, 'string');
  assert.equal(full.document.totals.bytes, pdf.size);
  const restored = base64ToBlob(full.document.files[0].dataBase64, 'application/pdf');
  assert.equal(restored.size, pdf.size);
  assert.equal(await blobToBase64(restored), full.document.files[0].dataBase64);

  const target = attachmentStore();
  await target.store.ready();
  const imported = await target.store.importStructured(full.document);
  assert.equal(imported.ok, true);
  assert.equal(imported.addedFiles, 1);
  assert.equal(imported.addedRefs, 2);
  assert.equal(target.store.totals('curso-exemplo').bytes, pdf.size);
  assert.equal(target.store.totals('curso-exemplo').refs, 2);
  const key = attachmentRefKey('curso-exemplo', 'aula-1', 'material-1');
  assert.equal((await target.store.getBlob(key)).size, pdf.size);

  const again = await target.store.importStructured(full.document);
  assert.equal(again.ok, true);
  assert.equal(again.addedFiles, 0);
  assert.equal(again.addedRefs, 0);
  assert.equal(again.reusedFiles, 0, 'nenhuma referência nova: nada é reescrito');
  assert.equal(again.skippedRefs, 2);
  assert.equal(target.store.totals('curso-exemplo').bytes, pdf.size);
  assert.equal(target.backend.raw('files').length, 1, 'importar de novo não cria arquivo nenhum');

  const rejected = await target.store.importStructured({ format: 'outra-coisa' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid');
});

test('anexos: importar só grava arquivos que as referências novas realmente usam', async () => {
  const source = attachmentStore();
  await source.store.ready();
  const original = pdfBlob('arquivo A');
  await source.store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'A.pdf', blob: original });
  const backup = await source.store.exportStructured({ courseId: 'curso-exemplo', includeBlobs: true });

  // O destino já tem a MESMA referência apontando para outro arquivo: importar
  // não pode gravar o arquivo do backup sem referência (bytes invisíveis).
  const target = attachmentStore();
  await target.store.ready();
  await target.store.put({
    courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'B.pdf',
    blob: new Blob([new TextEncoder().encode('%PDF-1.7\n% arquivo B bem maior que o outro\n%%EOF\n')], { type: 'application/pdf' }),
  });
  const before = target.store.totals('curso-exemplo');

  const imported = await target.store.importStructured(backup.document);
  assert.equal(imported.ok, true);
  assert.equal(imported.addedFiles, 0, 'nenhum arquivo novo foi gravado');
  assert.equal(imported.addedRefs, 0, 'a referência existente foi preservada');
  assert.equal(imported.skippedRefs, 1);
  assert.deepEqual(target.store.totals('curso-exemplo'), before, 'espaço contado não mudou');
  assert.equal(target.backend.raw('files').length, 1, 'um só arquivo no banco');
  const kept = target.store.get(attachmentRefKey('curso-exemplo', 'aula-1', 'material-1'));
  assert.equal(kept.name, 'B.pdf', 'o arquivo do usuário continua no lugar');

  // Referência cujo arquivo não veio no backup é ignorada, sem gravar nada.
  const emptyFiles = { ...backup.document, refs: [{ ...backup.document.refs[0], key: JSON.stringify(['curso-exemplo', 'aula-9', 'material-9']) }] };
  const noFile = await target.store.importStructured({ ...emptyFiles, files: [] });
  assert.equal(noFile.ok, true);
  assert.equal(noFile.addedRefs, 0);
  assert.equal(noFile.skippedRefs, 1);
  assert.equal(target.backend.raw('files').length, 1);
});

test('anexos: PDF é PDF pelo conteúdo, mesmo sem extensão ou com extensão errada', async () => {
  const noExtension = await sniffAttachmentKind(new Blob([PDF_BYTES]), '');
  assert.deepEqual([noExtension.kind, noExtension.verified], ['pdf', true]);
  const wrongExtension = await sniffAttachmentKind(new Blob([PDF_BYTES]), 'txt');
  assert.deepEqual([wrongExtension.kind, wrongExtension.verified], ['pdf', true]);
  const audioExtension = await sniffAttachmentKind(new Blob([PDF_BYTES]), 'mp3');
  assert.deepEqual([audioExtension.kind, audioExtension.verified], ['pdf', true]);
});

test('anexos: prepareImport valida tudo e não grava nada; commit aplica o plano', async () => {
  const source = attachmentStore();
  await source.store.ready();
  const pdf = pdfBlob('material do plano');
  await source.store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'Plano.pdf', blob: pdf });
  const backup = await source.store.exportStructured({ courseId: 'curso-exemplo', includeBlobs: true });

  const target = attachmentStore();
  await target.store.ready();
  const prepared = await target.store.prepareImport(backup.document);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.errors.length, 0);
  assert.equal(prepared.plan.files.length, 1);
  assert.equal(prepared.plan.files[0].present, false);
  assert.equal(prepared.plan.files[0].action, 'add');
  assert.equal(prepared.plan.refs[0].status, 'new');
  assert.equal(prepared.plan.refs[0].action, 'add');
  assert.equal(prepared.plan.addRefs.length, 1);
  assert.equal(prepared.plan.addFiles.length, 1);
  assert.deepEqual(prepared.plan.totals, { files: 1, refs: 1, reusedFiles: 0, skipped: 0, bytes: pdf.size });
  // Pré-voo é leitura pura.
  assert.deepEqual(target.store.totals('curso-exemplo'), { files: 0, refs: 0, bytes: 0, byKind: { pdf: { files: 0, bytes: 0 }, audio: { files: 0, bytes: 0 }, other: { files: 0, bytes: 0 } } });
  assert.equal(target.backend.raw('files').length, 0);

  const committed = await target.store.commitPrepared(prepared.prepared);
  assert.equal(committed.ok, true);
  assert.deepEqual([committed.addedFiles, committed.addedRefs, committed.changed, committed.skipped], [1, 1, false, 0]);
  assert.equal(committed.bytes, pdf.size);
  assert.equal(target.store.totals('curso-exemplo').bytes, pdf.size);
  assert.equal((await target.store.getBlob(attachmentRefKey('curso-exemplo', 'aula-1', 'material-1'))).size, pdf.size);

  // Segundo commit do mesmo prepared: nada é reescrito (nenhum órfão).
  const again = await target.store.commitPrepared(prepared.prepared);
  assert.equal(again.ok, true);
  assert.deepEqual([again.addedFiles, again.addedRefs, again.changed], [0, 0, true]);
  assert.equal(target.backend.raw('files').length, 1);
  assert.equal(target.store.totals('curso-exemplo').bytes, pdf.size);

  // Sem prepare, o commit recusa.
  assert.equal((await target.store.commitPrepared(null)).ok, false);
});

test('anexos: commit reavalia o estado e nunca sobrescreve o que apareceu no meio', async () => {
  const source = attachmentStore();
  await source.store.ready();
  await source.store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'A.pdf', blob: pdfBlob('arquivo do backup') });
  const backup = await source.store.exportStructured({ courseId: 'curso-exemplo', includeBlobs: true });

  const target = attachmentStore();
  await target.store.ready();
  const prepared = await target.store.prepareImport(backup.document);
  assert.equal(prepared.plan.addRefs.length, 1);

  // Enquanto o plano esperava, o usuário anexou outro arquivo NA MESMA referência.
  const replacement = await target.store.put({
    courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'B.pdf',
    blob: new Blob([new TextEncoder().encode('%PDF-1.7\n% B\n%%EOF\n')], { type: 'application/pdf' }),
  });
  const committed = await target.store.commitPrepared(prepared.prepared);
  assert.equal(committed.ok, true);
  assert.equal(committed.addedRefs, 0);
  assert.equal(committed.changed, true, 'avisou que o estado mudou');
  assert.equal(committed.skipped, 1);
  assert.equal(committed.addedFiles, 0, 'nenhum arquivo órfão foi gravado');
  assert.equal(target.store.get(attachmentRefKey('curso-exemplo', 'aula-1', 'material-1')).name, 'B.pdf');
  assert.equal(target.backend.raw('files').length, 1, 'só o arquivo do usuário');

  // Referência com arquivo já existente é reusada, sem decodificar de novo.
  const other = attachmentStore();
  await other.store.ready();
  await other.store.put({ courseId: 'curso-exemplo', lessonId: 'aula-2', resourceId: 'material-2', name: 'C.pdf', blob: pdfBlob('arquivo do backup') });
  const again = await other.store.prepareImport(backup.document);
  assert.equal(again.plan.addFiles.length, 0);
  assert.equal(again.plan.addRefs.length, 1);
  assert.equal(again.plan.reusedFiles, 1);
  const applied = await other.store.commitPrepared(again.prepared);
  assert.deepEqual([applied.addedFiles, applied.addedRefs, applied.reusedFiles], [0, 1, 1]);
  assert.equal(other.store.totals('curso-exemplo').bytes, pdfBlob('arquivo do backup').size);
});

test('anexos: prepareImport aponta conflito de referência e entrada inválida', async () => {
  const store = attachmentStore().store;
  await store.ready();
  const first = await store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'A.pdf', blob: pdfBlob('primeiro') });
  const second = await store.put({ courseId: 'curso-exemplo', lessonId: 'aula-2', resourceId: 'material-2', name: 'B.pdf', blob: pdfBlob('segundo') });
  const key = attachmentRefKey('curso-exemplo', 'aula-1', 'material-1');
  const document = {
    format: ATTACHMENT_FORMAT,
    version: 1,
    files: [
      { id: second.fileId, size: second.size, mime: 'application/pdf', name: 'B.pdf', extension: 'pdf' },
      { id: 'sem-blob', size: 10, mime: 'application/pdf', name: 'X.pdf', extension: 'pdf' },
    ],
    refs: [
      { key, courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', fileId: second.fileId, name: 'A.pdf', extension: 'pdf' },
      { key: JSON.stringify(['curso-exemplo', 'aula-9', 'material-9']), courseId: 'curso-exemplo', lessonId: 'aula-9', resourceId: 'material-9', fileId: 'sem-blob', name: 'X.pdf', extension: 'pdf' },
      { key: 'chave-invalida', fileId: 'x' },
    ],
  };
  const prepared = await store.prepareImport(document, { includeBlobs: false });
  assert.equal(prepared.ok, true);
  const byKey = new Map(prepared.plan.refs.map(ref => [ref.key, ref]));
  assert.equal(byKey.get(key).status, 'conflict', 'referência existente com outro arquivo é conflito');
  assert.equal(byKey.get(key).storedFileId, first.fileId);
  assert.equal(byKey.get('chave-invalida').status, 'invalid');
  assert.equal(byKey.get(JSON.stringify(['curso-exemplo', 'aula-9', 'material-9'])).status, 'blob-missing');
  assert.equal(prepared.plan.addRefs.length, 0, 'nada novo para gravar');
  assert.equal(prepared.plan.files.find(file => file.id === second.fileId).present, true);
  assert.equal(prepared.errors.length, 1, 'envelope de catálogo: só a entrada inválida é erro');
  const withBlobs = await store.prepareImport(document, { includeBlobs: true });
  assert.equal(withBlobs.ok, true);
  assert.equal(withBlobs.errors.length, 2, 'pedindo bytes, a falta deles também é erro');
  const committed = await store.commitPrepared(prepared.prepared);
  assert.equal(committed.ok, true);
  assert.equal(committed.addedRefs, 0);
  assert.equal(committed.addedFiles, 0);
  assert.equal(committed.skipped, 3);
});

test('anexos: escritas concorrentes na mesma referência ficam serializadas e sem órfão', async () => {
  const { store, backend } = attachmentStore();
  await store.ready();
  const first = pdfBlob('primeiro envio');
  const second = pdfBlob('segundo envio, bem maior que o primeiro');
  const [a, b] = await Promise.all([
    store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'A.pdf', blob: first }),
    store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'B.pdf', blob: second }),
  ]);
  assert.notEqual(a.fileId, b.fileId);
  const ref = store.get(attachmentRefKey('curso-exemplo', 'aula-1', 'material-1'));
  assert.equal(ref.name, 'B.pdf', 'a última escrita na fila vence');
  assert.equal(backend.raw('files').length, 1, 'o arquivo substituído foi liberado (sem órfão)');
  assert.equal(store.totals('curso-exemplo').bytes, second.size);
});

test('anexos: limpeza de um curso é explícita, libera só arquivos sem outra referência', async () => {
  const { store } = attachmentStore();
  await store.ready();
  const shared = pdfBlob('compartilhado entre cursos');
  await store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'Compartilhado.pdf', blob: shared });
  await store.put({ courseId: 'outro-curso', lessonId: 'aula-9', resourceId: 'material-9', name: 'Compartilhado.pdf', blob: shared });
  const only = await store.put({ courseId: 'curso-exemplo', lessonId: 'aula-2', resourceId: 'material-2', name: 'Só daqui.pdf', blob: pdfBlob('só deste curso') });
  assert.equal(store.totals('curso-exemplo').refs, 2);

  const cleared = await store.clearCourse('curso-exemplo');
  assert.equal(cleared.refs, 2);
  assert.equal(cleared.freedBytes, pdfBlob('só deste curso').size);
  assert.equal(store.totals('curso-exemplo').refs, 0);
  assert.equal(store.totals().refs, 1);
  assert.equal(store.has(only.key), false);
  assert.equal(store.totals().bytes, shared.size);
});

test('anexos: caminho real de IndexedDB grava, relê offline e remove liberando espaço', async () => {
  const factory = fakeIndexedDB();
  const store = await openAttachmentStore({ indexedDB: factory, uuid: () => 'att-local' });
  assert.equal(store.persistent, true);
  assert.equal(store.dbName, ATTACHMENT_DB_NAME);
  await store.ready();

  const blob = pdfBlob('guardado no banco de anexos');
  await store.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'Apostila.pdf', blob });
  assert.equal(store.totals('curso-exemplo').bytes, blob.size);
  assert.equal(factory.databases.get(ATTACHMENT_DB_NAME).stores.has('files'), true);
  assert.equal(factory.databases.get(ATTACHMENT_DB_NAME).stores.has('refs'), true);
  assert.equal(factory.databases.get(ATTACHMENT_DB_NAME).stores.get('refs').keyPath, 'key');

  // Recarregar a página abre a MESMA base: o anexo continua lá, sem rede.
  const reopened = await openAttachmentStore({ indexedDB: factory, uuid: () => 'att-local-2' });
  await reopened.ready();
  const key = attachmentRefKey('curso-exemplo', 'aula-1', 'material-1');
  const listed = reopened.list('curso-exemplo', 'aula-1');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'Apostila.pdf');
  assert.equal((await reopened.getBlob(key)).size, blob.size);

  const removed = await reopened.remove(key);
  assert.equal(removed.removed, true);
  assert.equal(removed.fileDeleted, true);
  assert.equal(removed.freedBytes, blob.size);
  assert.equal(reopened.totals('curso-exemplo').bytes, 0);
});

test('anexos: loja compartilhada informa arquivos e espaço antes de abrir uma aula', async t => {
  resetSharedAttachmentStore();
  t.after(resetSharedAttachmentStore);
  const factory = fakeIndexedDB();
  const first = await openAttachmentStore({ indexedDB: factory });
  const blob = pdfBlob('Anexo de Exemplo');
  await first.put({ courseId: 'curso-exemplo', lessonId: 'aula-1', resourceId: 'material-1', name: 'Apostila.pdf', blob });

  const restored = await sharedAttachmentStore({ indexedDB: factory });
  assert.equal(restored.totals().bytes, blob.size);
  assert.deepEqual(restored.list('curso-exemplo', 'aula-1').map(ref => ref.name), ['Apostila.pdf']);
  const key = attachmentRefKey('curso-exemplo', 'aula-1', 'material-1');
  assert.equal(await (await restored.getBlob(key)).text(), await blob.text());
});

test('anexos: rótulo de tamanho é legível em pt-BR', () => {
  assert.equal(formatAttachmentSize(0), '0 B');
  assert.equal(formatAttachmentSize(512), '512 B');
  assert.equal(formatAttachmentSize(2048), '2,00 kB');
  assert.equal(formatAttachmentSize(1024 * 1024 * 3.5), '3,50 MB');
  assert.equal(formatAttachmentSize(1024 * 1024 * 1024 * 2), '2,00 GB');
});
