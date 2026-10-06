// Cola da etapa 8 (B4b) sobre o api.js REAL da etapa 6: as rotas de material do
// curso no servidor de verdade, com data dir de teste, curso fictício e arquivos
// fictícios ("Curso de Exemplo", "Apostila de Exemplo.pdf", example.invalid).
//
// Três defeitos da revisão de segurança viram teste de regressão AQUI, no
// caminho HTTP, e não só no serviço: reserva de disco no upload sem
// Content-Length (chunked), GET somente leitura e POST .../scan atrás do check
// de Origin/Sec-Fetch-Site.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPdf, buildZip } from './server-zip-fixtures.js';
import { attachmentRefKey } from '../src/course-attachments.js';
import { startServer, tempDir } from './server-harness.js';

const COURSE_ID = 'curso-exemplo';
const OCTET = { 'Content-Type': 'application/octet-stream' };
const APOSTILA = 'Apostila de Exemplo.pdf';
const FAIXA = 'faixa de exemplo (1).MP3';
const EXTRA = 'material extra.pdf';
const PDF_BYTES = buildPdf('apostila de exemplo');

// Curso fictício com dois materiais distintos na mesma aula: a apostila (PDF) e
// a faixa (áudio). Nada aqui vem de curso real.
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
        lessons: [{
          id: 'aula-1',
          title: 'Aula 1',
          type: 'aula',
          resources: [
            { id: 'material-1', name: 'Apostila de Exemplo.pdf', extension: 'pdf', role: 'apostila' },
            { id: 'material-2', name: 'Faixa de Exemplo', extension: 'mp3', role: 'faixa' },
          ],
          resourceRefs: [],
          suggestedExercises: [],
        }],
      }],
    },
  };
}

async function materialServer(t, env = {}) {
  const dir = await tempDir(t);
  const dataDir = join(dir, 'dados');
  const running = await startServer(t, { dataDir, env });
  return { ...running, dataDir };
}

async function seedEntrada(dataDir, names) {
  const dir = join(dataDir, 'entrada', COURSE_ID);
  await mkdir(dir, { recursive: true });
  for (const name of names) await writeFile(join(dir, name), name === APOSTILA || name === EXTRA ? PDF_BYTES : Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00faixa de exemplo', 'latin1'));
  return dir;
}

test('materiais: o GET é somente leitura e o POST .../scan é quem importa e grava', async (t) => {
  const { client, dataDir } = await materialServer(t);
  assert.equal((await client.create('courses', COURSE_ID, courseDocument())).status, 201);
  await seedEntrada(dataDir, [APOSTILA, FAIXA, EXTRA]);

  // LEITURA: casa por nome (caixa, espaço e sufixo "(1)") e relata, sem gravar
  // vínculo nem blob.
  const read = await client.get(`/api/courses/${COURSE_ID}/materials`);
  assert.equal(read.status, 200);
  const report = read.json();
  assert.equal(report.total, 2, 'dois materiais distintos no curso');
  assert.equal(report.available, 0, 'nada importado ainda');
  assert.equal(report.refs, 0);
  assert.equal(report.files.scanned, 3);
  assert.equal(report.files.unsupported, 0);
  assert.deepEqual(report.missing.map((row) => row.name).sort(), ['Apostila de Exemplo.pdf', 'Faixa de Exemplo']);
  assert.equal(report.unmatched.length, 1, 'o PDF que não casa com material nenhum é relatado');
  assert.equal(report.unmatched[0].id, EXTRA);
  assert.equal(report.unmatched[0].reason, 'no-material');
  assert.deepEqual((await client.get('/api/docs/courseAttachments')).json().items, [], 'nenhum vínculo gravado');
  assert.equal((await client.get('/api/health')).json().storage.blobs, 0, 'nenhum blob gravado');

  // ESCRITA explícita: importa, dedupa por conteúdo e grava os vínculos.
  const scan = await client.post(`/api/courses/${COURSE_ID}/materials/scan`);
  assert.equal(scan.status, 200);
  assert.equal(scan.json().available, 2);
  assert.equal(scan.json().refs, 2);
  assert.equal(scan.json().missing.length, 0);
  const stored = (await client.get('/api/docs/courseAttachments')).json().items;
  assert.equal(stored.length, 1, 'um documento de vínculos por curso');
  assert.equal((await client.get('/api/health')).json().storage.blobs, 2, 'um blob por arquivo casado');

  // Depois de importado, o GET continua somente leitura e reflete o gravado.
  const again = await client.get(`/api/courses/${COURSE_ID}/materials`);
  assert.equal(again.status, 200);
  assert.equal(again.json().available, 2);
  assert.equal((await client.get('/api/health')).json().storage.blobs, 2);
});

test('materiais: leitura sem a pasta de entrada não cria pasta e relata zero arquivos', async (t) => {
  const { client, dataDir } = await materialServer(t);
  assert.equal((await client.create('courses', COURSE_ID, courseDocument())).status, 201);
  const read = await client.get(`/api/courses/${COURSE_ID}/materials`);
  assert.equal(read.status, 200);
  assert.equal(read.json().total, 2);
  assert.equal(read.json().available, 0);
  assert.equal(read.json().files.scanned, 0);
  assert.equal(read.json().missing.length, 2);
  assert.deepEqual(await readdir(join(dataDir, 'entrada')), [], 'nenhuma pasta de curso criada pela leitura');
});

test('materiais: upload sem Content-Length (chunked) respeita a reserva de disco → 507 sem gravar', async (t) => {
  // O curso é criado com o servidor normal (a reserva gigante do segundo
  // servidor barraria até o documento do curso): o mesmo data dir é reaberto com
  // GROOVE_MIN_FREE_BYTES alto, para a recusa vir da RESERVA do upload — sem ela
  // o handler chegaria ao intake e responderia 404 (curso ausente), não 507.
  const first = await materialServer(t);
  assert.equal((await first.client.create('courses', COURSE_ID, courseDocument())).status, 201);
  await first.close();
  const second = await startServer(t, { dataDir: first.dataDir, env: { GROOVE_MIN_FREE_BYTES: String(1024 * 1024 * 1024 * 1024) } });
  const data = Buffer.concat([PDF_BYTES, Buffer.alloc(2048, 7)]);
  const response = await second.client.post(`/api/courses/${COURSE_ID}/materials`, {
    chunks: [data.subarray(0, 1024), data.subarray(1024)],
    headers: {
      ...OCTET,
      'Transfer-Encoding': 'chunked',
      'X-Groove-Filename': encodeURIComponent('Apostila de Exemplo.pdf'),
    },
  });
  assert.equal(response.status, 507, 'sem Content-Length a reserva é o teto inteiro do blob');
  assert.equal(response.json().error, 'insufficient_storage');
  assert.deepEqual(await readdir(join(first.dataDir, 'tmp')), [], 'nenhum temporário sobra');
  assert.deepEqual(await readdir(join(first.dataDir, 'entrada')), [], 'nada sobra na pasta de entrada');
  assert.equal((await second.client.get('/api/health')).json().storage.blobs, 0);
});

test('materiais: o POST .../scan exige a origem do app; o GET não', async (t) => {
  const { client, dataDir } = await materialServer(t);
  assert.equal((await client.create('courses', COURSE_ID, courseDocument())).status, 201);
  await seedEntrada(dataDir, [APOSTILA]);

  const noOrigin = await client.post(`/api/courses/${COURSE_ID}/materials/scan`, { headers: { Origin: null } });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.json().error, 'origin_forbidden');
  const crossSite = await client.post(`/api/courses/${COURSE_ID}/materials/scan`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.json().error, 'fetch_site_forbidden');
  assert.deepEqual((await client.get('/api/docs/courseAttachments')).json().items, [], 'nada foi importado pelas recusas');

  // Um GET cross-site não dispara importação nenhuma (e continua respondendo o
  // relatório: leitura não tem CSRF a proteger).
  const read = await client.get(`/api/courses/${COURSE_ID}/materials`, { headers: { Origin: 'https://outro.example.invalid' } });
  assert.equal(read.status, 200);
  assert.equal(read.json().available, 0);
  assert.deepEqual((await client.get('/api/docs/courseAttachments')).json().items, []);

  const scan = await client.post(`/api/courses/${COURSE_ID}/materials/scan`);
  assert.equal(scan.status, 200);
  assert.equal(scan.json().available, 1);
});

// Curso fictício com um pacote de exercícios (ZIP) e um material sem arquivo na
// pasta: exercita o ZIP membro a membro e o vínculo manual pelo relatório.
function courseWithPackage() {
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
        lessons: [{
          id: 'aula-1',
          title: 'Aula 1',
          type: 'aula',
          resources: [
            { id: 'material-1', name: 'Apostila de Exemplo.pdf', extension: 'pdf', role: 'apostila' },
            { id: 'material-2', name: 'Faixa de Exemplo', extension: 'mp3', role: 'faixa' },
            { id: 'material-3', name: 'Pacote de Exemplo.zip', extension: 'zip', role: 'pacote de exercícios' },
            { id: 'material-4', name: 'Apostila de Exemplo 2.pdf', extension: 'pdf', role: 'apostila' },
            { id: 'material-5', name: 'Apostila Sem Arquivo.pdf', extension: 'pdf', role: 'apostila' },
          ],
          resourceRefs: [],
          suggestedExercises: [],
        }],
      }],
    },
  };
}

test('materiais: pacote ZIP, faixa, variações de nome e vínculo manual pelo relatório', async (t) => {
  const { client, dataDir } = await materialServer(t);
  assert.equal((await client.create('courses', COURSE_ID, courseWithPackage())).status, 201);
  const dir = join(dataDir, 'entrada', COURSE_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'Apostila de Exemplo.pdf'), PDF_BYTES);
  await writeFile(join(dir, 'faixa de exemplo (1).MP3'), Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00faixa de exemplo', 'latin1'));
  await writeFile(join(dir, 'Pacote de Exemplo.zip'), buildZip([
    { name: 'APOSTILA DE EXEMPLO 2.PDF', data: buildPdf('segunda apostila de exemplo'), method: 'deflate' },
  ]));
  await writeFile(join(dir, 'nao casado.pdf'), buildPdf('arquivo que não casa com nada'));

  const scan = await client.post(`/api/courses/${COURSE_ID}/materials/scan`);
  assert.equal(scan.status, 200);
  const report = scan.json();
  assert.equal(report.total, 5);
  assert.equal(report.available, 4, 'apostila, faixa, pacote e o PDF de dentro do pacote');
  assert.equal(report.zip.archives, 1);
  assert.equal(report.zip.pdfMembers, 1);
  assert.deepEqual(report.missing.map((row) => row.name), ['Apostila Sem Arquivo.pdf']);
  assert.deepEqual(report.unmatched.map((row) => row.id), ['nao casado.pdf']);
  assert.equal(report.unmatched[0].reason, 'no-material');

  // Vínculo manual: o arquivo que não casou vira o material que faltava.
  const refKey = attachmentRefKey(COURSE_ID, 'aula-1', 'material-5');
  const bound = await client.post(`/api/courses/${COURSE_ID}/materials/bind`, { json: { refKey, id: 'nao casado.pdf' } });
  assert.equal(bound.status, 200);
  assert.equal(bound.json().report.available, 5);
  assert.equal(bound.json().ref.kind, 'pdf');
  const read = await client.get(`/api/courses/${COURSE_ID}/materials`);
  assert.equal(read.json().available, 5);
  assert.equal(read.json().missing.length, 0);
});

test('materiais: upload com a origem do app casa na hora e dedupa por conteúdo', async (t) => {
  const { client } = await materialServer(t);
  assert.equal((await client.create('courses', COURSE_ID, courseDocument())).status, 201);
  const headers = { ...OCTET, 'X-Groove-Filename': encodeURIComponent(APOSTILA) };
  const first = await client.post(`/api/courses/${COURSE_ID}/materials`, { body: PDF_BYTES, headers });
  assert.equal(first.status, 201);
  assert.equal(first.json().stored.matched.length, 1, 'casa com o material do curso');
  assert.equal(first.json().stored.unmatched, false);
  assert.equal(first.json().report.available, 1);
  const again = await client.post(`/api/courses/${COURSE_ID}/materials`, { body: PDF_BYTES, headers });
  assert.equal(again.status, 201);
  assert.equal((await client.get('/api/health')).json().storage.blobs, 1, 'o mesmo conteúdo é guardado uma vez só');
});
