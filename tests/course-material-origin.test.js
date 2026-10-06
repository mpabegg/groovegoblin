// Material exato do exercício gerado (rodada 6, etapa 8 / B4b) — consumidor.
//
// A regressão que importa: uma aula com DOIS PDFs diferentes e um catálogo que
// aponta o SEGUNDO na página 3. O caminho inteiro é exercitado — conversor do
// mapa com catálogo → geração pelo Estúdio de estudo → recarga da biblioteca
// (normalização/serialização) → resolução contra a loja de cursos — e o alvo
// tem de ser o SEGUNDO PDF na página 3, nunca "o primeiro PDF" nem página nula.
//
// Também cobrem: ids de aula trocados na reimportação (o NOME manda), o único
// PDF inequívoco de exercício antigo (sem afirmar página), a honestidade com
// dois PDFs sem fonte explícita, e o canário de privacidade (nome do arquivo de
// curso não sai na exportação pública e CONTINUA no retrato privado).
//
// Tudo fictício: “Curso de Teste”, “Apostila Primeira.pdf”, example.invalid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, parseSession, serializeSession } from '../src/session.js';
import { createExerciseLibrary } from '../src/exercise-library.js';
import { createCourseStore } from '../src/course-store.js';
import { convertCourseMap } from '../scripts/convert-course-map.js';
import { courseLessons } from '../src/course-progress.js';
import { courseOrigin, suggestionMaterialTarget } from '../src/course-lesson.js';
import { exerciseMaterialTargets, suggestionMaterialChoices } from '../src/course-lesson-origins.js';
import { createStudyController } from '../src/study-controller.js';
import { resolveCatalogRecipe } from '../src/course-shape-binding.js';
import { shareableExercise, shareableLibrary } from '../src/course-privacy.js';
import { buildBackup } from '../src/library-backup.js';
import { memoryBackend } from './course-fixtures.js';
import { memoryStorage } from './storage-fixture.js';

const COURSE_ID = 'curso-de-teste';
const LESSON_ID = '1';
const FIRST = 'Apostila Primeira.pdf';
const SECOND = 'Apostila Segunda.pdf';
const PAGE = 3;

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

// ---------------------------------------------------------------- fixtures

// Mapa com DOIS PDFs na MESMA aula: o catálogo aponta o segundo.
function mapDocument({ lessonId = 1, extra = null } = {}) {
  const lesson = {
    id: lessonId,
    titulo: 'Aula 1',
    tipo_de_aula: 'Prática',
    anexos: [
      { nome: FIRST, extensao: 'pdf', papel: 'apostila', cordas: 4 },
      { nome: SECOND, extensao: 'pdf', papel: 'apostila', cordas: 4 },
      ...(extra === null ? [] : [extra]),
    ],
    backing_tracks: null,
    exercicios: null,
    meu_progresso: null,
  };
  return {
    curso: { id: COURSE_ID, titulo: 'Curso de Teste', instrumento: { nome: 'baixo', cordas: 4 } },
    modulos: [{ ordem: 1, titulo: 'Módulo 1', aulas: [lesson] }],
  };
}

function catalogDocument({ file = SECOND, page = PAGE } = {}) {
  return [{
    id: 'cat-1',
    origem_tipo: 'workbook',
    familia: 'arpejo_triade_forma_unica',
    aula_id: 1,
    nome_do_exercicio: 'Exercício Um',
    pagina_do_pdf: page,
    fontes: [{ arquivo: file, pagina_fisica: page, pagina_impressa: page, nota: null }],
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
  }];
}

function lessonOf(course, lessonId = LESSON_ID) {
  return courseLessons(course).find(item => item.id === lessonId) ?? null;
}

function suggestionOf(course, lessonId = LESSON_ID) {
  return lessonOf(course, lessonId)?.suggestedExercises?.[0] ?? null;
}

// Curso convertido (mapa + catálogo), já canônico pelo formato.
function converted({ lessonId = 1, file = SECOND, page = PAGE } = {}) {
  const result = convertCourseMap(mapDocument({ lessonId }), { catalog: catalogDocument({ file, page }) });
  assert.equal(result.valid, true, JSON.stringify(result.problems));
  return result.document;
}

// ------------------------------------------------------------------ lojas

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

async function importCourse(store, document) {
  const imported = await store.importText(JSON.stringify(document), { source: 'teste' });
  assert.equal(imported.ok, true, imported.error);
  return imported.courseId;
}

// Geração pelo Estúdio de estudo REAL: a receita do catálogo é resolvida (forma
// lembrada) e o exercício nasce pela biblioteca, com o vínculo de origem.
function generate(store, library, courseId, { lessonId = LESSON_ID, suggestion = null } = {}) {
  const found = store.get(courseId);
  const lesson = lessonOf(found.course, lessonId);
  const target = suggestion ?? suggestionOf(found.course, lessonId);
  const material = suggestionMaterialTarget(found.course, lesson, target);
  const resolved = resolveCatalogRecipe(target.recipe, { bindings: boundBindings, shapes: shapeAccess, profile: target.recipe.profile });
  assert.equal(resolved.ok, true, resolved.error);
  const studies = createStudyController({ library, getInstrument: () => null, notify: () => {}, bpm: 80 });
  const entry = studies.create(resolved.recipe, { origin: courseOrigin(lesson, material), bpm: target.initialBpm ?? undefined, open: false });
  assert.ok(entry, 'o exercício foi criado');
  studies.destroy();
  return { entry, material };
}

// -------------------------------------------------- conversor: identidade

test('conversor: o catálogo aponta o SEGUNDO PDF e a sugestão guarda o nome e a dica', () => {
  const document = converted();
  const suggestion = suggestionOf(document.course);
  assert.equal(suggestion.pdfPage, PAGE);
  assert.deepEqual(suggestion.material.names, [SECOND]);
  assert.equal(suggestion.material.lessonId, LESSON_ID);
  const resource = lessonOf(document.course).resources.find(item => item.id === suggestion.material.resourceId);
  assert.equal(resource.name, SECOND, 'a dica é o recurso do SEGUNDO PDF, não do primeiro');
  // O primeiro PDF continua no mapa: nada foi removido para "acertar".
  assert.deepEqual(lessonOf(document.course).resources.map(item => item.name), [FIRST, SECOND]);
});

test('conversor: sem fonte citada o material fica indefinido (não escolhe o primeiro PDF)', () => {
  const catalog = catalogDocument();
  delete catalog[0].fontes;
  const result = convertCourseMap(mapDocument(), { catalog });
  assert.equal(result.valid, true);
  assert.equal(suggestionOf(result.document.course).material, null);
});

// ----------------------------------------------- resolução: segundo + 3

test('resolução: dois PDFs na aula, catálogo aponta o segundo na página 3 → segundo + 3', async () => {
  const document = converted();
  const lesson = lessonOf(document.course);
  const suggestion = suggestionOf(document.course);
  const { choices, explicit } = suggestionMaterialChoices(document.course, lesson, suggestion);
  assert.equal(explicit, true);
  assert.equal(choices.length, 1);
  assert.equal(choices[0].name, SECOND);
  assert.equal(choices[0].page, PAGE);
  assert.equal(suggestionMaterialTarget(document.course, lesson, suggestion).resourceId, choices[0].resourceId);

  // Caminho inteiro: loja de cursos + biblioteca + geração + recarga.
  const store = createCourseStore({ backend: memoryBackend() });
  await store.ready();
  const courseId = await importCourse(store, document);
  const library = makeLibrary();
  const { entry } = generate(store, library, courseId);
  assert.equal(await store.linkExercise(courseId, LESSON_ID, entry.id) !== null, true);

  const reloaded = library.get(entry.id);
  assert.deepEqual(reloaded.metadata.study.origin.material, {
    name: SECOND, lessonId: LESSON_ID, resourceId: suggestion.material.resourceId, page: PAGE,
  });
  const targets = exerciseMaterialTargets(store, entry.id, { library });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, SECOND, 'o SEGUNDO PDF, não o primeiro');
  assert.equal(targets[0].page, PAGE);
  assert.equal(targets[0].lessonId, LESSON_ID);
});

test('resolução: ids de aula/recurso de ontem não vencem o NOME no mapa atual', async () => {
  const store = createCourseStore({ backend: memoryBackend() });
  await store.ready();
  // A reimportação trocou os ids: aula '2' e recurso renomeado, mesmos NOMES.
  const courseId = await importCourse(store, converted({ lessonId: 2 }));
  const found = store.get(courseId);
  const second = lessonOf(found.course, '2').resources.find(item => item.name === SECOND);
  const first = lessonOf(found.course, '2').resources.find(item => item.name === FIRST);
  const library = makeLibrary();
  const entry = library.new({
    session: createSession({ name: 'Estudo', bars: 4, bpm: 80 }),
    metadata: {
      name: 'Estudo',
      study: {
        version: 1,
        recipe: { version: 1, family: 'arpejo_triade_forma_unica' },
        // Ids VELHOS (de antes da reimportação) e o id do recurso ERRADO.
        origin: { id: 'aula-1', name: 'Aula 1', kind: 'course', private: true,
          material: { name: SECOND, lessonId: '1', resourceId: first.id, page: PAGE } },
      },
    },
  });
  await store.linkExercise(courseId, '2', entry.id);
  const targets = exerciseMaterialTargets(store, entry.id, { library });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, SECOND, 'o nome manda; o id velho do primeiro PDF não');
  assert.equal(targets[0].lessonId, '2', 'a aula é a de HOJE');
  assert.equal(targets[0].resourceId, second.id);
  assert.equal(targets[0].page, PAGE);
});

test('resolução: exercício antigo sem material só abre com UM PDF inequívoco e sem afirmar página', async () => {
  const store = createCourseStore({ backend: memoryBackend() });
  await store.ready();
  const library = makeLibrary();
  // Dois PDFs e nenhum material guardado: nada é adivinhado.
  const courseId = await importCourse(store, converted());
  const ambiguous = library.new({
    session: createSession({ name: 'Estudo', bars: 4, bpm: 80 }),
    metadata: { name: 'Estudo', study: { version: 1, recipe: { version: 1, family: 'x' },
      origin: { id: LESSON_ID, name: 'Aula 1', kind: 'course', private: true } } },
  });
  await store.linkExercise(courseId, LESSON_ID, ambiguous.id);
  assert.deepEqual(exerciseMaterialTargets(store, ambiguous.id, { library }), []);

  // Um único PDF na aula: abre, sem afirmar página nenhuma.
  const single = converted();
  single.course.sections[0].lessons[0].resources = single.course.sections[0].lessons[0].resources
    .filter(resource => resource.name !== FIRST);
  const singleStore = createCourseStore({ backend: memoryBackend() });
  await singleStore.ready();
  const singleId = await importCourse(singleStore, single);
  const only = library.new({
    session: createSession({ name: 'Estudo', bars: 4, bpm: 80 }),
    metadata: { name: 'Estudo', study: { version: 1, recipe: { version: 1, family: 'x' },
      origin: { id: LESSON_ID, name: 'Aula 1', kind: 'course', private: true } } },
  });
  await singleStore.linkExercise(singleId, LESSON_ID, only.id);
  const targets = exerciseMaterialTargets(singleStore, only.id, { library });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, SECOND);
  assert.equal(targets[0].page, null, 'sem material guardado a página não é afirmada');
});

test('resolução: dois PDFs sem fonte explícita viram opções e nenhuma afirma página', () => {
  const document = converted();
  const lesson = lessonOf(document.course);
  const suggestion = { ...suggestionOf(document.course), material: null };
  const { choices, explicit } = suggestionMaterialChoices(document.course, lesson, suggestion);
  assert.equal(explicit, false);
  assert.deepEqual(choices.map(choice => choice.name).sort(), [FIRST, SECOND].sort());
  for (const choice of choices) assert.equal(choice.page, null, 'nenhum dos dois é "o citado": sem página');
});

test('resolução: a variação herda o material do exercício original (ancestralidade)', async () => {
  const store = createCourseStore({ backend: memoryBackend() });
  await store.ready();
  const courseId = await importCourse(store, converted());
  const library = makeLibrary();
  const { entry } = generate(store, library, courseId);
  await store.linkExercise(courseId, LESSON_ID, entry.id);

  // Variação: sem vínculo de aula próprio, aponta para o exercício original.
  const variation = library.new({
    session: createSession({ name: 'Variação', bars: 4, bpm: 80 }),
    metadata: {
      name: 'Variação',
      study: {
        version: 1,
        recipe: { version: 1, family: 'arpejo_triade_forma_unica' },
        origin: { id: entry.id, name: library.get(entry.id).metadata.name },
      },
    },
  });
  assert.deepEqual(store.originsOf(variation.id), [], 'a variação não está vinculada a aula');
  const targets = exerciseMaterialTargets(store, variation.id, { library });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, SECOND);
  assert.equal(targets[0].page, PAGE);

  // Ciclo de rótulos (a→b→a) não trava a resolução.
  library.updateMetadata(variation.id, { study: { ...library.get(variation.id).metadata.study, origin: { id: variation.id, name: 'ela mesma' } } });
  assert.deepEqual(exerciseMaterialTargets(store, variation.id, { library }), []);
});

// ------------------------------------------------------------- privacidade

test('privacidade: o nome do arquivo de curso não sai no público e continua no retrato privado', async () => {
  const store = createCourseStore({ backend: memoryBackend() });
  await store.ready();
  const courseId = await importCourse(store, converted());
  const library = makeLibrary();
  const { entry } = generate(store, library, courseId);
  await store.linkExercise(courseId, LESSON_ID, entry.id);

  const publicText = library.exportLibrary();
  assert.equal(publicText.includes(SECOND), false, 'exportação padrão não leva o nome do material');
  assert.equal(publicText.includes('Apostila'), false);
  const safe = shareableExercise(library.get(entry.id));
  assert.equal(JSON.stringify(safe).includes(SECOND), false);
  assert.equal(Object.hasOwn(safe.metadata, 'study'), false, 'o bloco study inteiro fica fora');
  const safeLibrary = shareableLibrary(JSON.parse(publicText));
  assert.equal(JSON.stringify(safeLibrary).includes(SECOND), false);

  // O retrato privado explícito é quem leva o vínculo, material incluído.
  const privateText = library.exportLibrary({ includeCourseContent: true });
  assert.equal(privateText.includes(SECOND), true);
  const privateBackup = await buildBackup({ library, store, includeCourseContent: true });
  assert.equal(JSON.stringify(privateBackup).includes(SECOND), true, 'o backup privado preserva o material');
  const publicBackup = await buildBackup({ library, store });
  assert.equal(JSON.stringify(publicBackup).includes(SECOND), false, 'o backup padrão não leva material de curso');
});
