import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COURSE_FORMAT,
  COURSE_LIMITS,
  COURSE_VERSION,
  normalizeCourse,
  parseCourse,
  serializeCourse,
} from '../src/course-format.js';

// Fixtures são inteiramente fictícias (Curso de Exemplo, example.invalid).
function readFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/course/${name}`, import.meta.url), 'utf8'));
}

function lesson(overrides = {}) {
  return {
    id: 'aula-1',
    title: 'Aula 1',
    type: 'aula',
    hasVideo: false,
    resources: [],
    resourceRefs: [],
    suggestedExercises: [],
    ...overrides,
  };
}

// Documento com apenas os campos obrigatórios: os opcionais viram padrões.
function minimalDocument() {
  return {
    format: COURSE_FORMAT,
    version: COURSE_VERSION,
    course: {
      id: 'curso-teste',
      title: 'Curso de Teste',
      instrument: 'bass',
      strings: 4,
      sections: [{ id: 'secao-1', title: 'Módulo 1', type: 'módulo', lessons: [lesson()] }],
    },
  };
}

function errorAt(result, path) {
  return result.errors.find((error) => error.path === path);
}

test('normaliza o curso fictício convertido sem mutar a entrada', () => {
  const document = readFixture('course-example-normalized.json');
  const before = structuredClone(document);
  const result = normalizeCourse(document);
  assert.equal(result.ok, true);
  assert.deepEqual(result.document, document);
  assert.deepEqual(document, before);
  assert.equal(result.document.course.strings, 4);
  assert.equal(result.document.course.sections.length, 3);
  assert.equal(Object.hasOwn(result.document, 'progress'), false);
});

test('preenche todos os opcionais ausentes com nulos, listas e falso', () => {
  const result = normalizeCourse(minimalDocument());
  assert.equal(result.ok, true);
  const course = result.document.course;
  assert.equal(course.author, null);
  assert.equal(course.url, null);
  assert.equal(course.language, null);
  assert.equal(course.dailyMinutes, null);
  assert.equal(course.summary, null);
  const section = course.sections[0];
  assert.equal(section.week, null);
  assert.equal(section.summary, null);
  assert.equal(section.objective, null);
  assert.deepEqual(section.prerequisites, []);
  const first = section.lessons[0];
  assert.equal(first.url, null);
  assert.equal(first.videoSeconds, null);
  assert.equal(first.summary, null);
  assert.equal(first.practiceInstruction, null);
  assert.equal(first.key, null);
  assert.equal(first.chordFormula, null);
  assert.equal(first.tuning, null);
  assert.deepEqual(first.techniques, []);
  assert.equal(first.initialBpm, null);
  assert.equal(first.targetBpm, null);
  assert.deepEqual(first.resources, []);
  assert.deepEqual(first.resourceRefs, []);
  assert.deepEqual(first.suggestedExercises, []);
  assert.deepEqual(Object.keys(first), [
    'id', 'title', 'url', 'type', 'videoSeconds', 'hasVideo', 'summary', 'practiceInstruction',
    'key', 'chordFormula', 'tuning', 'techniques', 'initialBpm', 'targetBpm',
    'resources', 'resourceRefs', 'suggestedExercises',
  ]);
});

test('normaliza o formato livre de curso sem depender de sessão', () => {
  const document = readFixture('course-irregular-normalized.json');
  const result = normalizeCourse(document);
  assert.equal(result.ok, true);
  assert.deepEqual(result.document, document);
});

test('recusa campo desconhecido com caminho de campo', () => {
  const document = minimalDocument();
  document.extra = 1;
  document.course.week = 3;
  document.course.sections[0].lessons[0].desconhecido = true;
  const result = normalizeCourse(document);
  assert.equal(result.ok, false);
  assert.equal(errorAt(result, 'extra').code, 'campo-desconhecido');
  assert.equal(errorAt(result, 'course.week').code, 'campo-desconhecido');
  assert.equal(errorAt(result, 'course.sections[0].lessons[0].desconhecido').code, 'campo-desconhecido');
  assert.match(result.error, /extra/);
});

test('recusa tipos e faixas erradas com caminho de campo', () => {
  const document = minimalDocument();
  document.course.title = 42;
  document.course.dailyMinutes = 0;
  document.course.strings = '4';
  document.course.instrument = 'guitar';
  document.course.sections[0].type = 'ideia';
  const first = document.course.sections[0].lessons[0];
  first.hasVideo = 'sim';
  first.url = 'ftp://example.invalid/x';
  first.type = 'x'.repeat(COURSE_LIMITS.label + 1);
  first.initialBpm = '80 BPM';
  first.suggestedExercises = [{
    id: 'exercicio-1',
    title: 'Exercício 1',
    bars: COURSE_LIMITS.barsMax + 1,
    strings: 6,
    trackNames: 'não é lista',
  }];
  const result = normalizeCourse(document);
  assert.equal(result.ok, false);
  assert.equal(errorAt(result, 'course.title').code, 'texto');
  assert.equal(errorAt(result, 'course.dailyMinutes').code, 'numero');
  assert.equal(errorAt(result, 'course.strings').code, 'cordas');
  assert.equal(errorAt(result, 'course.instrument').code, 'instrumento');
  assert.equal(errorAt(result, 'course.sections[0].type').code, 'valor');
  assert.equal(errorAt(result, 'course.sections[0].lessons[0].hasVideo').code, 'booleano');
  assert.equal(errorAt(result, 'course.sections[0].lessons[0].url').code, 'url');
  assert.equal(errorAt(result, 'course.sections[0].lessons[0].type').code, 'texto');
  assert.equal(errorAt(result, 'course.sections[0].lessons[0].initialBpm').code, 'numero');
  assert.equal(errorAt(result, 'course.sections[0].lessons[0].suggestedExercises[0].bars').code, 'numero');
  assert.equal(errorAt(result, 'course.sections[0].lessons[0].suggestedExercises[0].trackNames').code, 'lista');
});

test('recusa material de 6 cordas no curso, no recurso e no exercício', () => {
  const document = minimalDocument();
  document.course.strings = 6;
  const first = document.course.sections[0].lessons[0];
  first.resources = [{ id: 'recurso-1', name: 'material.pdf', extension: 'pdf', role: 'apostila', strings: 6 }];
  first.suggestedExercises = [{ id: 'exercicio-1', title: 'Exercício 1', strings: 6 }];
  const result = normalizeCourse(document);
  assert.equal(result.ok, false);
  assert.equal(errorAt(result, 'course.strings').code, 'cordas');
  assert.equal(errorAt(result, 'course.sections[0].lessons[0].resources[0].strings').code, 'cordas');
  assert.equal(errorAt(result, 'course.sections[0].lessons[0].suggestedExercises[0].strings').code, 'cordas');
});

test('recusa limite de lista e identificadores repetidos', () => {
  const document = minimalDocument();
  document.course.sections = [
    { id: 'secao-1', title: 'Módulo 1', type: 'módulo', lessons: [lesson(), lesson()] },
    { id: 'secao-1', title: 'Módulo 2', type: 'módulo', lessons: [] },
  ];
  document.progress = { watchedLessonIds: ['aula-1', 'aula-1'] };
  const result = normalizeCourse(document);
  assert.equal(result.ok, false);
  assert.equal(errorAt(result, 'course.sections[0].lessons[1].id').code, 'id-repetido');
  assert.equal(errorAt(result, 'course.sections[1].id').code, 'id-repetido');
  assert.equal(errorAt(result, 'progress.watchedLessonIds[1]').code, 'id-repetido');

  const long = minimalDocument();
  long.course.sections = Array.from({ length: COURSE_LIMITS.sections + 1 }, (_, index) => ({
    id: `secao-${index}`,
    title: `Módulo ${index}`,
    type: 'módulo',
    lessons: [],
  }));
  assert.equal(errorAt(normalizeCourse(long), 'course.sections').code, 'limite');
});

test('recusa referência quebrada de recurso e de progresso', () => {
  const document = minimalDocument();
  const first = document.course.sections[0].lessons[0];
  first.resourceRefs = [{ lessonId: 'aula-9', resourceId: 'recurso-9' }, { lessonId: 'aula-1', resourceId: 'recurso-9' }];
  document.progress = { watchedLessonIds: ['aula-9'] };
  const result = normalizeCourse(document);
  assert.equal(result.ok, false);
  assert.equal(errorAt(result, 'course.sections[0].lessons[0].resourceRefs[0].lessonId').code, 'referencia-quebrada');
  assert.equal(errorAt(result, 'course.sections[0].lessons[0].resourceRefs[1].resourceId').code, 'referencia-quebrada');
  assert.equal(errorAt(result, 'progress.watchedLessonIds[0]').code, 'referencia-quebrada');
});

test('aceita referência de recurso entre aulas do mesmo módulo', () => {
  const document = minimalDocument();
  const section = document.course.sections[0];
  section.lessons = [
    lesson({
      id: 'aula-1',
      resources: [{ id: 'recurso-1', name: 'faixa.mp3', extension: 'mp3', role: 'faixa', bpm: 80, strings: 4 }],
    }),
    lesson({ id: 'aula-2', resourceRefs: [{ lessonId: 'aula-1', resourceId: 'recurso-1' }] }),
  ];
  const result = normalizeCourse(document);
  assert.equal(result.ok, true);
  assert.deepEqual(result.document.course.sections[0].lessons[1].resourceRefs, [{ lessonId: 'aula-1', resourceId: 'recurso-1' }]);
});

test('recusa aula com duração de vídeo sem marcar o vídeo', () => {
  const document = minimalDocument();
  document.course.sections[0].lessons[0].videoSeconds = 5;
  const result = normalizeCourse(document);
  assert.equal(result.ok, false);
  assert.equal(errorAt(result, 'course.sections[0].lessons[0].videoSeconds').code, 'video');
});

test('progresso é opcional e sai do documento quando não existe', () => {
  const absent = normalizeCourse(minimalDocument());
  assert.equal(Object.hasOwn(absent.document, 'progress'), false);

  const withProgress = minimalDocument();
  withProgress.progress = { watchedLessonIds: ['aula-1'] };
  const included = normalizeCourse(withProgress);
  assert.equal(included.ok, true);
  assert.deepEqual(included.document.progress, { watchedLessonIds: ['aula-1'] });

  const nullProgress = minimalDocument();
  nullProgress.progress = null;
  assert.equal(Object.hasOwn(normalizeCourse(nullProgress).document, 'progress'), false);

  const wrongShape = minimalDocument();
  wrongShape.progress = [];
  assert.equal(errorAt(normalizeCourse(wrongShape), 'progress').code, 'objeto');
});

test('a leitura é estrita mas não expõe detalhes do parser JSON', () => {
  const broken = parseCourse('{ "format": ');
  assert.equal(broken.ok, false);
  assert.equal(broken.error, 'Não foi possível ler o arquivo: o JSON é inválido.');
  assert.doesNotMatch(broken.error, /position|token|Unexpected|JSON\.parse/i);

  const empty = parseCourse('');
  assert.equal(empty.ok, false);
  assert.equal(empty.errors[0].code, 'json');

  const notText = parseCourse(null);
  assert.equal(notText.ok, false);
  assert.equal(notText.errors[0].code, 'texto');

  const notObject = normalizeCourse(undefined);
  assert.equal(notObject.ok, false);
  assert.equal(notObject.errors[0].code, 'documento');
});

test('serializar e reler preserva o documento canônico', () => {
  const document = minimalDocument();
  const first = serializeCourse(document);
  assert.equal(first.ok, true);
  assert.equal(first.text.endsWith('\n'), true);
  const reread = parseCourse(first.text);
  assert.equal(reread.ok, true);
  assert.deepEqual(reread.document, first.document);
  assert.equal(serializeCourse(reread.document).text, first.text);
  assert.equal(serializeCourse({ format: 'outro' }).ok, false);
});

test('limita a quantidade de erros devolvidos', () => {
  const document = minimalDocument();
  for (let index = 0; index < COURSE_LIMITS.errors + 5; index += 1) document[`campo_${index}`] = index;
  const result = normalizeCourse(document);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, COURSE_LIMITS.errors);
  assert.equal(result.truncated, true);
});
