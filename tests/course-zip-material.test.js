// PDF de DENTRO do pacote (rodada 6, etapa 8 / B4b) — consumidor.
//
// A regressão que importa: o mapa traz SÓ o pacote ZIP como material e o
// catálogo declara o PDF de dentro dele (`fontes[].arquivo_interno`) na página 3.
// O conversor tem de criar o recurso de apóstila desse PDF (sem ele, o membro do
// ZIP não casa material nenhum), ligar o exercício e a aula a esse recurso,
// guardar a página — e a pasta de entrada real tem de casar o membro do pacote
// com o MESMO material, sem trabalho manual arquivo por arquivo.
//
// Também cobrem: o mesmo PDF citado por duas aulas vira UM material canônico com
// dois vínculos (não uma cópia por citação), a reconversão é determinística, o
// material exclusivo de 6 cordas continua descartado, o arquivo externo nunca
// vira apóstila por conta própria e o nome do arquivo de curso não sai na
// exportação pública (o retrato privado leva).
//
// Tudo fictício: “Curso de Pacote”, “Pacote de Exemplo.zip”, “Apostila
// Segunda.pdf”, example.invalid. Nenhum arquivo de curso real entra aqui.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createIntakeService, INTAKE_LIMITS, REFS_COLLECTION } from '../server/intake.js';
import { courseMaterialIndex } from '../server/matching.js';
import { buildZip, buildPdf } from './server-zip-fixtures.js';
import { convertCourseMap } from '../scripts/convert-course-map.js';
import { createCourseStore } from '../src/course-store.js';
import { createExerciseLibrary } from '../src/exercise-library.js';
import { createSession, parseSession, serializeSession } from '../src/session.js';
import { courseLessons } from '../src/course-progress.js';
import { courseOrigin, suggestionMaterialTarget } from '../src/course-lesson.js';
import { exerciseMaterialTargets, suggestionMaterialChoices } from '../src/course-lesson-origins.js';
import { createStudyController } from '../src/study-controller.js';
import { resolveCatalogRecipe } from '../src/course-shape-binding.js';
import { shareableExercise, shareableLibrary } from '../src/course-privacy.js';
import { memoryBackend } from './course-fixtures.js';
import { memoryStorage } from './storage-fixture.js';

const COURSE_ID = 'curso-de-pacote';
const ZIP_NAME = 'Pacote de Exemplo.zip';
const INNER = 'Apostila Segunda.pdf';
const PAGE = 3;
const INNER_BYTES = buildPdf('apostila de dentro do pacote');
const ZIP_BYTES = buildZip([
  { name: INNER, data: INNER_BYTES, method: 'deflate' },
  { name: 'leia-me.txt', data: 'texto', method: 'store' },
]);

const SHAPE = {
  id: 'bass4-maior-fundamental',
  label: 'Maior · fundamental',
  quality: 'major',
  degrees: [1, 3, 5],
  notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }],
};
const shapeAccess = { choicesFor: () => [{ id: SHAPE.id, label: SHAPE.label, generic: true, shape: SHAPE }], shape: id => (id === SHAPE.id ? SHAPE : null) };
const boundBindings = {
  shapeFor: label => (label?.label === 'Shape 1' && label?.quality === 'major' ? SHAPE.id : null),
  remember: () => ({ saved: true }),
  list: () => [],
};

function sha(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------- fixtures

// Mapa com SÓ o pacote: o PDF citado pelo catálogo não está declarado em lugar
// nenhum — é o arquivo de dentro do ZIP.
function mapDocument({ lessons = 1 } = {}) {
  const aulas = [];
  for (let index = 1; index <= lessons; index += 1) {
    aulas.push({
      id: index,
      titulo: `Aula ${index}`,
      tipo_de_aula: 'Prática',
      anexos: [{ nome: ZIP_NAME, extensao: 'zip', papel: 'pacote de exercícios', cordas: 4 }],
      backing_tracks: null,
      exercicios: null,
      meu_progresso: null,
    });
  }
  return {
    curso: { id: COURSE_ID, titulo: 'Curso de Pacote', instrumento: { nome: 'baixo', cordas: 4 } },
    modulos: [{ ordem: 1, titulo: 'Módulo 1', aulas }],
  };
}

function catalogEntry(overrides = {}) {
  return {
    id: 'cat-pacote-1',
    origem_tipo: 'workbook',
    familia: 'arpejo_triade_forma_unica',
    aula_id: 1,
    nome_do_exercicio: 'Exercício do Pacote',
    pagina_do_pdf: PAGE,
    fontes: [{ arquivo: ZIP_NAME, arquivo_interno: INNER, pagina_fisica: PAGE, pagina_impressa: PAGE, nota: null }],
    qualidade: 'maior',
    inversao: 'fundamental',
    forma: { forma: 'Shape 1', dedilhado_no_texto: 'descrição fictícia' },
    regiao_do_braco: { declarada: { de: 1, ate: 5 }, observada_na_tab: null },
    sequencia_de_acordes: { regra: 'ciclo de quartas a partir de C', cifras: ['C', 'F', 'Bb', 'Eb'] },
    compassos_por_acorde: 2,
    total_de_compassos: 8,
    andamento_escrito: '♩ = 80',
    modo_de_pratica: 'com metrônomo',
    faixas_indicadas: [],
    figura_ritmica: { padrao_codigo: 'q q h', muda: false, variantes: [], compasso_final: 'w' },
    contorno: { padrao: 'T-3-5', varia: false, variantes: [] },
    igual_a: null,
    semelhante_a: null,
    comparacao_4_cordas: null,
    ...overrides,
  };
}

function converted({ lessons = 1, catalog = [catalogEntry()] } = {}) {
  const result = convertCourseMap(mapDocument({ lessons }), { catalog });
  assert.equal(result.valid, true, JSON.stringify(result.problems));
  return result;
}

function lessonOf(course, lessonId = '1') {
  return courseLessons(course).find(item => item.id === lessonId) ?? null;
}

function resourceNamed(lesson, name) {
  return lesson.resources.find(resource => resource.name === name) ?? null;
}

// -------------------------------------------------- conversor: o PDF criado

test('conversor: o PDF de dentro do pacote vira material de apóstila, com a página do catálogo', () => {
  const result = converted();
  const lesson = lessonOf(result.document.course);
  // O pacote do mapa continua lá; o PDF de dentro virou material consumível.
  assert.deepEqual(lesson.resources.map(resource => resource.name), [ZIP_NAME, INNER]);
  const pdf = resourceNamed(lesson, INNER);
  assert.equal(pdf.extension, 'pdf');
  assert.equal(pdf.role, 'apostila');
  assert.equal(pdf.strings, null, 'a corda fica indefinida: o material vale para 4 e 5');
  assert.equal(pdf.id, 'apostila-segunda-pdf', 'o id é o nome normalizado, como nos anexos');
  assert.equal(result.counts.catalog.materials, 1);
  assert.equal(result.counts.resources, 2, 'o pacote do mapa + o PDF criado');

  const suggestion = lesson.suggestedExercises[0];
  assert.equal(suggestion.pdfPage, PAGE);
  assert.deepEqual(suggestion.material.names, [INNER, ZIP_NAME], 'o PDF de dentro vem primeiro');
  assert.equal(suggestion.material.lessonId, '1');
  assert.equal(suggestion.material.resourceId, pdf.id, 'a dica é o recurso do PDF, não o pacote');
  assert.deepEqual(lesson.resourceRefs, [{ lessonId: '1', resourceId: pdf.id }]);
  assert.equal(result.counts.catalog.refs, 1);
  // `arquivo_interno` é campo do schema: nada de "campo ignorado".
  assert.equal(result.warnings.some(warning => warning.code === 'catalogo-campo-ignorado'), false);
});

test('conversor: só o pacote citado (sem PDF interno) não inventa material', () => {
  const result = converted({ catalog: [catalogEntry({ fontes: [{ arquivo: ZIP_NAME, pagina_fisica: PAGE }] })] });
  const lesson = lessonOf(result.document.course);
  assert.equal(result.counts.catalog.materials, 0);
  assert.equal(result.counts.resources, 1);
  assert.deepEqual(lesson.resources.map(resource => resource.name), [ZIP_NAME]);
  const suggestion = lesson.suggestedExercises[0];
  assert.deepEqual(suggestion.material.names, [ZIP_NAME]);
  // O pacote JÁ é material do mapa e o vínculo é com ele; o painel não o trata
  // como apóstila (só PDF abre), então nada de página afirmada.
  assert.equal(suggestion.material.resourceId, resourceNamed(lesson, ZIP_NAME).id);
});

test('conversor: material exclusivo de 6 cordas não é criado (descarte dos anexos)', () => {
  const catalog = [catalogEntry({ fontes: [{ arquivo: ZIP_NAME, arquivo_interno: 'Apostila 6 cordas.pdf' }] })];
  const result = converted({ catalog });
  assert.equal(result.counts.catalog.materials, 0);
  assert.equal(result.counts.resources, 1);
  assert.equal(result.counts.discarded, 1);
  assert.ok(result.warnings.some(warning => warning.code === 'cordas-6'));
  const lesson = lessonOf(result.document.course);
  const suggestion = lesson.suggestedExercises[0];
  // O arquivo de dentro é de 6 cordas: não entra no curso. O que resta é o
  // pacote do mapa — o arquivo externo citado —, e o pacote não vira apóstila
  // (só PDF abre), então nenhuma página é afirmada.
  assert.equal(suggestion.material.resourceId, resourceNamed(lesson, ZIP_NAME).id);
  const { choices, explicit } = suggestionMaterialChoices(result.document.course, lesson, suggestion);
  assert.equal(explicit, true);
  assert.deepEqual(choices, [], 'nenhum PDF para abrir: nada de material inventado');
});

test('conversor: o mesmo PDF citado por duas aulas vira UM material canônico com vínculos', () => {
  const catalog = [
    catalogEntry(),
    catalogEntry({ id: 'cat-pacote-2', aula_id: 2, nome_do_exercicio: 'Exercício da Outra Aula' }),
  ];
  const result = converted({ lessons: 2, catalog });
  const first = lessonOf(result.document.course, '1');
  const second = lessonOf(result.document.course, '2');
  assert.equal(result.counts.catalog.materials, 1, 'um recurso só para o mesmo arquivo');
  assert.equal(result.counts.resources, 3, 'dois pacotes do mapa + um PDF');
  assert.equal(resourceNamed(second, INNER), null, 'a segunda aula não ganha cópia');
  const pdf = resourceNamed(first, INNER);
  // Os dois exercícios apontam para o MESMO recurso (o da primeira aula) e a
  // segunda aula ganha o vínculo, não uma cópia.
  assert.equal(second.suggestedExercises[0].material.resourceId, pdf.id);
  assert.equal(second.suggestedExercises[0].material.lessonId, '1');
  assert.deepEqual(second.resourceRefs, [{ lessonId: '1', resourceId: pdf.id }]);
  assert.equal(result.counts.catalog.refs, 2);
});

test('conversor: reconverter dá o mesmo documento byte a byte', () => {
  const first = converted();
  const second = converted();
  assert.equal(JSON.stringify(first.document), JSON.stringify(second.document));
  assert.deepEqual(first.counts, second.counts);
});

// ------------------------------------------------- pasta de entrada (servidor)

function createFakeStore(document, tmp) {
  const key = (collection, id) => `${collection}\u0000${id}`;
  const docs = new Map();
  const blobs = new Map();
  let seq = 1;
  docs.set(key('courses', COURSE_ID), { rev: '1', body: Buffer.from(JSON.stringify(document)) });
  return {
    blobs,
    tmpDir: tmp,
    async readDoc(collection, id) {
      const entry = docs.get(key(collection, id));
      if (!entry || entry.deleted) return { entry: entry ?? null, body: null };
      return { entry: { rev: entry.rev, size: entry.body.length, deleted: false }, body: entry.body };
    },
    async putDoc(collection, id, body, { ifMatch = null, ifNoneMatch = false } = {}) {
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
      const data = await readFile(temporary);
      assert.equal(data.length, size, 'o blob é gravado com o tamanho declarado');
      assert.equal(sha(data), value, 'o blob é gravado no endereço do conteúdo');
      blobs.set(value, data);
      await unlink(temporary).catch(() => {});
      return { created: true };
    },
    async ensureSpace() {},
    refsDoc() {
      const entry = docs.get(key(REFS_COLLECTION, COURSE_ID));
      return entry ? JSON.parse(entry.body.toString('utf8')).refs : null;
    },
  };
}

async function setup(document) {
  const dataDir = await mkdtemp(join(tmpdir(), 'groove-zip-material-'));
  await mkdir(join(dataDir, 'tmp'), { recursive: true });
  const store = createFakeStore(document, join(dataDir, 'tmp'));
  const intake = createIntakeService({
    store,
    root: join(dataDir, 'entrada'),
    limits: INTAKE_LIMITS,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  });
  return {
    dataDir,
    store,
    intake,
    async put(name, bytes) {
      await mkdir(join(dataDir, 'entrada', COURSE_ID), { recursive: true });
      await writeFile(join(dataDir, 'entrada', COURSE_ID, name), bytes);
    },
    async cleanup() { await rm(dataDir, { recursive: true, force: true }); },
  };
}

test('pasta de entrada: o membro do pacote casa o material criado pelo catálogo', async (t) => {
  const document = converted().document;
  const lesson = lessonOf(document.course);
  const pdf = resourceNamed(lesson, INNER);
  const zip = resourceNamed(lesson, ZIP_NAME);

  // Índice puro do servidor: o membro do ZIP casa o recurso por NOME.
  const index = courseMaterialIndex(document, COURSE_ID);
  const matches = index.match(INNER);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].resourceId, pdf.id);
  const pdfRef = matches[0].refKey;

  const context = await setup(document);
  t.after(() => context.cleanup());
  await context.put(ZIP_NAME, ZIP_BYTES);
  const report = await context.intake.scan(COURSE_ID);

  assert.equal(report.zip.archives, 1);
  assert.equal(report.zip.pdfMembers, 1);
  assert.equal(report.unmatched.length, 0, 'o membro do pacote casa material');
  assert.deepEqual(report.missing, [], 'nem o pacote nem o PDF criado ficam "faltando"');
  assert.equal(report.available, 2, 'o PDF de dentro e o próprio pacote');

  const refs = context.store.refsDoc();
  assert.equal(refs[pdfRef].kind, 'pdf');
  assert.equal(refs[pdfRef].size, INNER_BYTES.length);
  assert.equal(refs[pdfRef].sha256, sha(INNER_BYTES), 'é o BYTES do membro, não o do pacote');
  const zipRef = JSON.stringify([COURSE_ID, lesson.id, zip.id]);
  assert.equal(refs[zipRef].kind, 'other');
  assert.equal(refs[zipRef].sha256, sha(ZIP_BYTES));
  // O blob do PDF guardado é o do membro descompactado.
  assert.equal(context.store.blobs.get(sha(INNER_BYTES)).length, INNER_BYTES.length);
});

// ----------------------------------------- geração + recarga da biblioteca

function makeLibrary() {
  let counter = 0;
  return createExerciseLibrary({
    storage: memoryStorage(),
    parse: parseSession,
    serialize: serializeSession,
    currentSession: createSession({ name: 'Sessão base', bars: 4, bpm: 80 }),
    uuid: () => `ex-${(counter += 1)}`,
    now: () => '2026-01-02T03:04:05.000Z',
  });
}

test('geração e recarga: o exercício guarda o PDF de dentro do pacote na página 3', async () => {
  const document = converted().document;
  const store = createCourseStore({ backend: memoryBackend() });
  await store.ready();
  const imported = await store.importText(JSON.stringify(document), { source: 'teste' });
  assert.equal(imported.ok, true, imported.error);
  const found = store.get(imported.courseId);
  const lesson = lessonOf(found.course);
  const suggestion = lesson.suggestedExercises[0];

  // A página da aula mostra UM material explícito: o PDF de dentro, com a página.
  const { choices, explicit } = suggestionMaterialChoices(found.course, lesson, suggestion);
  assert.equal(explicit, true);
  assert.equal(choices.length, 1);
  assert.equal(choices[0].name, INNER);
  assert.equal(choices[0].page, PAGE);
  const material = suggestionMaterialTarget(found.course, lesson, suggestion);
  assert.equal(material.resourceId, choices[0].resourceId);

  const resolved = resolveCatalogRecipe(suggestion.recipe, { bindings: boundBindings, shapes: shapeAccess, profile: suggestion.recipe.profile });
  assert.equal(resolved.ok, true, resolved.error);
  const library = makeLibrary();
  const studies = createStudyController({ library, getInstrument: () => null, notify: () => {}, bpm: 80 });
  const entry = studies.create(resolved.recipe, { origin: courseOrigin(lesson, material), bpm: suggestion.initialBpm ?? undefined, open: false });
  assert.ok(entry, 'o exercício foi criado');
  studies.destroy();
  assert.equal(await store.linkExercise(imported.courseId, lesson.id, entry.id) !== null, true);

  // A recarga da biblioteca (normalização/serialização) preserva material e página.
  const reloaded = library.get(entry.id);
  assert.deepEqual(reloaded.metadata.study.origin.material, {
    name: INNER, lessonId: lesson.id, resourceId: material.resourceId, page: PAGE,
  });
  const targets = exerciseMaterialTargets(store, entry.id, { library });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, INNER);
  assert.equal(targets[0].page, PAGE);
  assert.equal(targets[0].extension, 'pdf');

  // Público não leva o nome do arquivo de curso; o retrato privado leva.
  assert.equal(JSON.stringify(shareableExercise(library.get(entry.id))).includes(INNER), false);
  const publicText = library.exportLibrary();
  assert.equal(publicText.includes(INNER), false);
  assert.equal(JSON.stringify(shareableLibrary(JSON.parse(publicText))).includes(INNER), false);
  assert.equal(library.exportLibrary({ includeCourseContent: true }).includes(INNER), true);
});
