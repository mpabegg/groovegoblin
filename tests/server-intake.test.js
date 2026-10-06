// Pasta de entrada do curso e vínculos (rodada 6, etapa 8 / B4b) — consumidor.
//
// Loja falsa com a mesma interface usada pelo serviço (readDoc/putDoc/entry/
// hasBlob/commitBlob/ensureSpace/tmpDir) e diretório de dados de teste em
// /tmp. O blob store falso guarda os BYTES, para o teste conferir dedup por
// conteúdo e presença de blob. Tudo fictício: "Curso de Exemplo", "Aula 1",
// "Apostila de Exemplo".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createIntakeService, INTAKE_LIMITS, IntakeError, REFS_COLLECTION } from '../server/intake.js';
import { buildZip, buildPdf, UNIX_DIRECTORY, UNIX_SYMLINK } from './server-zip-fixtures.js';

const COURSE_ID = 'curso-exemplo';
const PDF_BYTES = buildPdf('apostila de exemplo');
const FAIXA_BYTES = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00faixa de exemplo', 'latin1');

function sha(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function courseDocument() {
  return {
    format: 'groovegoblin-course',
    version: 2,
    course: {
      id: COURSE_ID,
      title: 'Curso de Exemplo',
      strings: 4,
      sections: [{
        id: 'modulo-1',
        title: 'Módulo 1',
        type: 'módulo',
        lessons: [
          {
            id: 'aula-1',
            title: 'Aula 1',
            type: 'aula',
            resources: [
              { id: 'material-1', name: 'Apostila de Exemplo.pdf', extension: 'pdf', role: 'apostila' },
              { id: 'material-2', name: 'Faixa de Exemplo', extension: 'mp3', role: 'faixa' },
            ],
            resourceRefs: [],
            suggestedExercises: [],
          },
          {
            id: 'aula-2',
            title: 'Aula 2',
            type: 'aula',
            resources: [{ id: 'material-3', name: 'Pacote de Exemplo.zip', extension: 'zip', role: 'pacote de exercícios' }],
            resourceRefs: [{ lessonId: 'aula-1', resourceId: 'material-1' }],
            suggestedExercises: [],
          },
        ],
      }],
    },
  };
}

function createFakeStore(dataDir) {
  const key = (collection, id) => `${collection}\u0000${id}`;
  const docs = new Map();
  const blobs = new Map();
  let seq = 0;
  let failures = 0;
  let sealed = false;
  const store = {
    tmpDir: join(dataDir, 'tmp'),
    blobs,
    docs,
    async readDoc(collection, id) {
      const entry = docs.get(key(collection, id));
      if (!entry || entry.deleted) return { entry: entry ?? null, body: null };
      return { entry: { rev: entry.rev, size: entry.body.length, deleted: false }, body: entry.body };
    },
    async putDoc(collection, id, body, { ifMatch = null, ifNoneMatch = false } = {}) {
      if (sealed) throw new Error('uma leitura não pode gravar documento');
      if (failures > 0) {
        failures -= 1;
        const conflict = new Error('revisão velha');
        conflict.name = 'PreconditionError';
        conflict.current = docs.get(key(collection, id)) ?? null;
        throw conflict;
      }
      const current = docs.get(key(collection, id));
      const conflict = ifNoneMatch ? current !== undefined : (current === undefined || current.rev !== ifMatch);
      if (conflict) {
        const error = new Error('revisão velha');
        error.name = 'PreconditionError';
        error.current = current ?? null;
        throw error;
      }
      seq += 1;
      const entry = { rev: String(seq), body: Buffer.from(body) };
      docs.set(key(collection, id), entry);
      return { entry, created: current === undefined };
    },
    async hasBlob(value) {
      return blobs.has(value);
    },
    async commitBlob(temporary, value, size) {
      if (sealed) throw new Error('uma leitura não pode gravar blob');
      if (blobs.has(value)) {
        await unlink(temporary).catch(() => {});
        return { created: false };
      }
      const data = await readFile(temporary);
      assert.equal(data.length, size, 'o blob é gravado com o tamanho declarado');
      assert.equal(sha(data), value, 'o blob é gravado no endereço do conteúdo');
      blobs.set(value, data);
      await unlink(temporary).catch(() => {});
      return { created: true };
    },
    async ensureSpace() {},
    failNextPut() { failures += 1; },
    sealWrites() { sealed = true; },
    unsealWrites() { sealed = false; },
    seed(collection, id, value) {
      seq += 1;
      docs.set(key(collection, id), { rev: String(seq), body: Buffer.from(JSON.stringify(value)) });
    },
    refsDoc() {
      const entry = docs.get(key(REFS_COLLECTION, COURSE_ID));
      return entry ? JSON.parse(entry.body.toString('utf8')).refs : null;
    },
  };
  store.seed('courses', COURSE_ID, courseDocument());
  return store;
}

async function setup({ limits = INTAKE_LIMITS } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'groove-intake-'));
  await mkdir(join(dataDir, 'tmp'), { recursive: true });
  const store = createFakeStore(dataDir);
  const intake = createIntakeService({ store, root: join(dataDir, 'entrada'), limits, now: () => new Date('2026-01-02T03:04:05.000Z') });
  return {
    dataDir,
    store,
    intake,
    entrada: join(dataDir, 'entrada', COURSE_ID),
    async put(name, bytes) {
      await mkdir(join(dataDir, 'entrada', COURSE_ID), { recursive: true });
      await writeFile(join(dataDir, 'entrada', COURSE_ID, name), bytes);
    },
    async cleanup() { await rm(dataDir, { recursive: true, force: true }); },
  };
}

test('intake: casa pelo nome (caixa, espaço e "(1)"), dedupa por conteúdo e relata faltantes', async (t) => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { intake, store } = context;
  await context.put('apostila de exemplo (1).pdf', PDF_BYTES);
  await context.put('FAIXA DE EXEMPLO.MP3', FAIXA_BYTES);
  await context.put('anotacoes.txt', Buffer.from('nada a ver', 'utf8'));
  await context.put('Extra 6 cordas.pdf', buildPdf('seis'));

  const report = await intake.scan(COURSE_ID);
  assert.equal(report.total, 3);
  assert.equal(report.available, 2);
  assert.equal(report.missingBlobs, 0);
  assert.deepEqual(report.missing.map((material) => material.name), ['Pacote de Exemplo.zip']);
  assert.deepEqual(
    report.unmatched.map((entry) => [entry.name, entry.reason]).sort((a, b) => a[0].localeCompare(b[0], 'en')),
    [['anotacoes.txt', 'unsupported'], ['Extra 6 cordas.pdf', 'six-strings']],
  );
  assert.equal(report.files.scanned, 4);
  assert.equal(report.files.sixStrings, 1);

  const refs = store.refsDoc();
  const apostilaRef = JSON.stringify([COURSE_ID, 'aula-1', 'material-1']);
  const faixaRef = JSON.stringify([COURSE_ID, 'aula-1', 'material-2']);
  assert.equal(refs[apostilaRef].sha256, sha(PDF_BYTES));
  assert.equal(refs[apostilaRef].kind, 'pdf');
  assert.equal(refs[apostilaRef].size, PDF_BYTES.length);
  assert.equal(refs[faixaRef].sha256, sha(FAIXA_BYTES));
  assert.equal(refs[faixaRef].kind, 'audio');
  assert.equal(Object.keys(refs).length, 2);
  assert.deepEqual([...store.blobs.keys()].sort(), [sha(PDF_BYTES), sha(FAIXA_BYTES)].sort());

  // O mesmo material citado em outra aula é o MESMO arquivo: um blob só.
  await context.put('Apostila de Exemplo.pdf', PDF_BYTES);
  const again = await intake.report(COURSE_ID);
  assert.equal(again.available, 2);
  assert.equal(store.blobs.size, 2);

  // Blob apagado no servidor (limpeza manual): o relatório fica honesto.
  store.blobs.delete(sha(FAIXA_BYTES));
  const broken = await intake.report(COURSE_ID);
  assert.equal(broken.available, 1);
  assert.equal(broken.missingBlobs, 1);
  assert.equal(broken.missing.length, 2);
});

test('intake: o relatório é somente leitura; quem importa e grava é o scan', async (t) => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { intake, store } = context;
  await context.put('Apostila de Exemplo.pdf', PDF_BYTES);

  // Com a loja selada, qualquer escrita (putDoc/commitBlob) explode: é assim que
  // o teste prova que uma LEITURA não grava.
  store.sealWrites();
  const report = await intake.report(COURSE_ID);
  assert.equal(report.total, 3);
  assert.equal(report.available, 0, 'sem importar, nada está disponível');
  assert.equal(report.files.scanned, 1);
  assert.deepEqual(report.missing.map((material) => material.name), ['Apostila de Exemplo.pdf', 'Faixa de Exemplo', 'Pacote de Exemplo.zip']);
  assert.deepEqual(report.unmatched, [], 'o arquivo casa com um material; só não foi importado ainda');
  assert.equal(store.refsDoc(), null, 'a leitura não grava vínculos');
  assert.equal(store.blobs.size, 0, 'a leitura não grava blobs');

  store.unsealWrites();
  const imported = await intake.scan(COURSE_ID);
  assert.equal(imported.available, 1);
  assert.equal(store.blobs.size, 1);
  assert.equal(store.refsDoc()[JSON.stringify([COURSE_ID, 'aula-1', 'material-1'])].sha256, sha(PDF_BYTES));

  // Depois de importar, a leitura vê o mesmo estado, ainda sem gravar nada.
  store.sealWrites();
  const depois = await intake.report(COURSE_ID);
  assert.equal(depois.available, 1);
});

test('intake: leitura sem a pasta de entrada não cria nada e relata zero', async (t) => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { intake } = context;
  const report = await intake.report(COURSE_ID);
  assert.equal(report.available, 0);
  assert.deepEqual(report.files, { files: 0, scanned: 0, skipped: 0, sixStrings: 0, unsupported: 0, bytes: 0 });
  assert.deepEqual(report.unmatched, []);
  assert.deepEqual(await readdir(join(context.dataDir, 'entrada')).catch(() => []), [], 'a leitura não criou a pasta');
});

test('intake: ZIP de PDFs é aberto membro a membro e o pacote casa com o material do pacote', async (t) => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { intake, store } = context;
  const zipBytes = buildZip([
    { name: 'Apostila de Exemplo.pdf', data: PDF_BYTES, method: 'deflate' },
    { name: 'Não Existe.pdf', data: buildPdf('sem material') },
    { name: 'leia-me.txt', data: 'texto' },
    { name: 'Pasta/', data: '', mode: UNIX_DIRECTORY },
  ]);
  await context.put('Pacote de Exemplo.zip', zipBytes);

  const report = await intake.scan(COURSE_ID);
  assert.equal(report.zip.archives, 1);
  assert.equal(report.zip.entries, 4);
  assert.equal(report.zip.pdfMembers, 2);
  assert.equal(report.available, 2, 'a apostila de dentro do pacote e o próprio pacote');
  assert.deepEqual(report.missing.map((material) => material.name), ['Faixa de Exemplo']);
  assert.deepEqual(report.unmatched.map((entry) => [entry.name, entry.reason]), [['Não Existe.pdf', 'no-material']]);
  assert.equal(report.unmatched[0].insideZip, 'Pacote de Exemplo.zip');
  assert.equal(report.unmatched[0].id, 'Pacote de Exemplo.zip::Não Existe.pdf');

  const refs = store.refsDoc();
  assert.equal(refs[JSON.stringify([COURSE_ID, 'aula-1', 'material-1'])].sha256, sha(PDF_BYTES));
  const pacote = refs[JSON.stringify([COURSE_ID, 'aula-2', 'material-3'])];
  assert.equal(pacote.sha256, sha(zipBytes));
  assert.equal(pacote.kind, 'other');
  assert.equal(pacote.name, 'Pacote de Exemplo.zip');
  assert.equal(store.blobs.get(pacote.sha256).length, zipBytes.length);
});

test('intake: ZIP com travessia, link simbólico, cifra ou corte não casa nada e é relatado', async (t) => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { intake } = context;
  await context.put('Travessia.zip', buildZip([{ name: '../Apostila de Exemplo.pdf', data: PDF_BYTES }]));
  await context.put('Atalho.zip', buildZip([{ name: 'Apostila de Exemplo.pdf', data: PDF_BYTES, mode: UNIX_SYMLINK }]));
  await context.put('Cifrado.zip', buildZip([{ name: 'Apostila de Exemplo.pdf', data: PDF_BYTES, encrypted: true }]));
  const cortado = buildZip([{ name: 'Apostila de Exemplo.pdf', data: PDF_BYTES }]);
  await context.put('Cortado.zip', cortado.subarray(0, 40));
  await context.put('NaoZip.zip', Buffer.from('não é zip nenhum'.repeat(4), 'utf8'));

  const report = await intake.report(COURSE_ID);
  assert.equal(report.available, 0);
  const reasons = Object.fromEntries(report.unmatched.map((entry) => [entry.name, [entry.reason, entry.detail]]));
  assert.deepEqual(reasons['Travessia.zip'], ['invalid', 'bad-name']);
  assert.deepEqual(reasons['Atalho.zip'], ['invalid', 'symlink']);
  assert.deepEqual(reasons['Cifrado.zip'], ['invalid', 'encrypted']);
  assert.deepEqual(reasons['Cortado.zip'], ['invalid', 'not-zip']);
  assert.deepEqual(reasons['NaoZip.zip'], ['invalid', 'not-zip']);
});

test('intake: orçamento cumulativo de PDFs dos pacotes barra o curso inteiro', async (t) => {
  const context = await setup({ limits: { ...INTAKE_LIMITS, maxZipPdfMembers: 1 } });
  t.after(() => context.cleanup());
  const { intake } = context;
  await context.put('Pacote de Exemplo.zip', buildZip([
    { name: 'Apostila de Exemplo.pdf', data: PDF_BYTES },
    { name: 'Outro de Exemplo.pdf', data: buildPdf('outro') },
  ]));
  await assert.rejects(intake.scan(COURSE_ID), (error) => {
    assert.ok(error instanceof IntakeError);
    assert.equal(error.code, 'limit_exceeded');
    return true;
  });
});

test('intake: vínculo manual guarda o arquivo, dedupa e é idempotente', async (t) => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { intake, store } = context;
  await context.put('Apostila de Exemplo.pdf', PDF_BYTES);
  await context.put('Apostila Extra.pdf', buildPdf('extra'));

  const first = await intake.scan(COURSE_ID);
  assert.equal(first.available, 1);
  const alvo = JSON.stringify([COURSE_ID, 'aula-2', 'material-3']);

  const bound = await intake.bind(COURSE_ID, { refKey: alvo, id: 'Apostila Extra.pdf' });
  assert.equal(bound.ok, true);
  assert.equal(bound.unchanged, false);
  assert.equal(bound.ref.sha256, sha(buildPdf('extra')));
  assert.equal(bound.report.available, 2);

  const repeat = await intake.bind(COURSE_ID, { refKey: alvo, id: 'Apostila Extra.pdf' });
  assert.equal(repeat.unchanged, true);
  assert.equal(store.blobs.size, 2, 'vincular de novo não grava outro blob nem outro vínculo');

  await assert.rejects(intake.bind(COURSE_ID, { refKey: JSON.stringify([COURSE_ID, 'aula-9', 'material-9']), id: 'Apostila Extra.pdf' }), (error) => error.code === 'invalid_ref');
  await assert.rejects(intake.bind(COURSE_ID, { refKey: alvo, id: 'Não Existe.pdf' }), (error) => error.code === 'file_missing');
  await context.put('Extra 6 cordas.pdf', buildPdf('seis'));
  await assert.rejects(intake.bind(COURSE_ID, { refKey: alvo, id: 'Extra 6 cordas.pdf' }), (error) => error.code === 'six_strings');
  await context.put('anotacoes.txt', 'texto');
  await assert.rejects(intake.bind(COURSE_ID, { refKey: alvo, id: 'anotacoes.txt' }), (error) => error.code === 'unsupported_file');
});

test('intake: vínculo manual aceita um PDF de dentro do pacote', async (t) => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { intake, store } = context;
  await context.put('Pacote de Exemplo.zip', buildZip([
    { name: 'Apostila de Exemplo.pdf', data: PDF_BYTES },
    { name: 'Escondida.pdf', data: buildPdf('escondida') },
  ]));

  const report = await intake.report(COURSE_ID);
  const escondida = report.unmatched.find((entry) => entry.name === 'Escondida.pdf');
  assert.equal(escondida.id, 'Pacote de Exemplo.zip::Escondida.pdf');

  const alvo = JSON.stringify([COURSE_ID, 'aula-1', 'material-2']);
  const bound = await intake.bind(COURSE_ID, { refKey: alvo, id: escondida.id });
  assert.equal(bound.ref.sha256, sha(buildPdf('escondida')));
  assert.equal(bound.ref.name, 'Escondida.pdf');
  assert.equal(store.blobs.has(bound.ref.sha256), true);
});

test('intake: upload entra por rename, casa na hora e recusa o que a pasta não aceita', async (t) => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { intake, store, dataDir } = context;

  const terreno = join(dataDir, 'envio-1.tmp');
  await writeFile(terreno, PDF_BYTES);
  const sent = await intake.upload(COURSE_ID, { name: 'Apostila de Exemplo.pdf', path: terreno });
  assert.equal(sent.ok, true);
  assert.equal(sent.stored.matched.length, 1);
  assert.equal(sent.stored.unmatched, false);
  assert.equal(sent.report.available, 1);
  assert.deepEqual(await readFile(join(context.entrada, 'Apostila de Exemplo.pdf')), PDF_BYTES);

  // Mesmo conteúdo, outro nome: um blob só (dedup por conteúdo).
  const segundo = join(dataDir, 'envio-2.tmp');
  await writeFile(segundo, PDF_BYTES);
  await intake.upload(COURSE_ID, { name: 'Apostila de Exemplo (1).pdf', path: segundo });
  assert.equal(store.blobs.size, 1);

  for (const [name, code] of [['anotacoes.txt', 'unsupported_file'], ['Extra 6 cordas.pdf', 'six_strings'], ['../escapa.pdf', 'invalid_filename']]) {
    const caminho = join(dataDir, `envio-${code}.tmp`);
    await writeFile(caminho, Buffer.from('x'));
    await assert.rejects(intake.upload(COURSE_ID, { name, path: caminho }), (error) => {
      assert.ok(error instanceof IntakeError, `${name}: ${error?.message}`);
      assert.equal(error.code, code);
      return true;
    });
  }
});

test('intake: curso fora do servidor e pasta com nome inválido são recusados', async (t) => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { intake } = context;
  await assert.rejects(intake.report('curso-que-nao-existe'), (error) => error.code === 'not_found');
  await assert.rejects(intake.report('../etc'), (error) => error.code === 'invalid_course_id');
  await assert.rejects(intake.upload(COURSE_ID, { name: 'ok.pdf', path: '/caminho/que/nao/existe.pdf' }), (error) => error.code === 'invalid_filename');
});

test('intake: escrita de vínculos re-tenta quando o cliente gravou no meio (412)', async (t) => {
  const context = await setup();
  t.after(() => context.cleanup());
  const { intake, store } = context;
  await context.put('apostila de exemplo.pdf', PDF_BYTES);
  store.failNextPut();
  const report = await intake.scan(COURSE_ID);
  assert.equal(report.available, 1);
  assert.equal(store.refsDoc()[JSON.stringify([COURSE_ID, 'aula-1', 'material-1'])].sha256, sha(PDF_BYTES));
});

test('intake: arquivo grande demais e pasta acima do teto de arquivos', async (t) => {
  const context = await setup({ limits: { ...INTAKE_LIMITS, maxEntryBytes: 32, maxEntries: 2 } });
  t.after(() => context.cleanup());
  const { intake } = context;
  await context.put('Apostila de Exemplo.pdf', PDF_BYTES);
  const report = await intake.report(COURSE_ID);
  assert.deepEqual(report.unmatched.map((entry) => [entry.name, entry.reason]), [['Apostila de Exemplo.pdf', 'too-large']]);
  assert.equal(report.available, 0);

  await context.put('b.pdf', buildPdf());
  await context.put('c.pdf', buildPdf());
  await assert.rejects(intake.report(COURSE_ID), (error) => error.code === 'too_many_files');
});
