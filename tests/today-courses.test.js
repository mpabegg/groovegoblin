import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ASSIST_MINUTES, DEFAULT_COURSE_MINUTES, MAX_ASSIST_MINUTES, MIN_ASSIST_MINUTES,
  assistBudgetMin, assistCoursePlan, courseBudgetMin, practiceCoursePlan,
} from '../src/today-courses.js';
import { referenceFingerprint } from '../src/exercise-library.js';

// Fixtures 100% fictícias (Curso de Exemplo, example.invalid).
//
// A sessão de hoje tem DUAS partes independentes (rodada 6, etapa 5):
//  - PRATICAR: exercícios das aulas já assistidas ainda abaixo do alvo, do mais
//    antigo para o mais novo, mais os avulsos na folga; o orçamento do curso
//    vale aqui;
//  - ASSISTIR: as próximas aulas que couberem no tempo indicado.

function lesson(id, title, extra = {}) {
  return { id, title, url: `https://example.invalid/${id}`, type: 'video', hasVideo: true, videoSeconds: 300, ...extra };
}

function section(id, title, lessons, type = 'módulo') {
  return { id, title, type, lessons };
}

function course(id, { dailyMinutes = 20, sections = [] } = {}) {
  return {
    id,
    title: `Curso ${id}`,
    author: 'Exemplo',
    url: 'https://example.invalid/curso',
    instrument: 'baixo',
    strings: 4,
    language: 'pt-BR',
    dailyMinutes,
    sections,
  };
}

function state(extra = {}) {
  return {
    courseId: extra.courseId ?? null,
    activeLessonId: null,
    lessons: {},
    removed: [],
    watch: [],
    preferences: { active: true, dailyMinutes: null },
    ...extra,
  };
}

function lessonState(extra = {}) {
  return { watched: false, skipped: false, completionOverride: null, notes: '', linkedExerciseIds: [], generatedSuggestionIds: [], ...extra };
}

// Execução AUTORAL que atingiu o alvo (mesma regra de course-progress).
function reached(id, targetBpm) {
  const session = {
    bars: 4,
    meter: { beats: 4, unit: 4 },
    subdivision: 1,
    swing: 0,
    swingUnit: 'eighth',
    loop: { startBar: 0, endBar: 1 },
    training: { goal: 'tight', repetitions: 3 },
    notes: [],
  };
  const materialKey = `${referenceFingerprint(session, { goal: 'tight', repetitions: 3 })}|tight|3|authored`;
  return {
    id,
    metadata: { targetBPM: targetBpm, records: [{ source: 'authored', materialKey, bpm: targetBpm, summary: { expected: 8, attackOk: 8 } }] },
    session,
  };
}

function pending(id, targetBpm = 120) {
  return { id, metadata: { targetBPM: targetBpm, records: [] }, session: {} };
}

function looseRow(id, createdAt) {
  return { id, name: `Exercício ${id}`, instrument: 'guitar', bpm: 90, targetBPM: 120, bestBpm: null, lastTrainedAt: null, createdAt };
}

function resolveFrom(map) {
  return id => map.get(id) ?? null;
}

// Dois cursos com UMA aula assistida cada (e um exercício pendente em cada uma),
// mais uma segunda aula assistida com um exercício já no alvo.
function twoCourseFixture() {
  const make = id => {
    const doc = course(id, {
      sections: [section(`${id}s1`, 'Módulo 1', [
        lesson(`${id}L1`, `Aula 1 ${id}`),
        lesson(`${id}L2`, `Aula 2 ${id}`),
      ])],
    });
    const st = state({
      courseId: id,
      lessons: {
        [`${id}L1`]: lessonState({ watched: true, linkedExerciseIds: [`${id}a1`] }),
        [`${id}L2`]: lessonState({ watched: true, linkedExerciseIds: [`${id}a2`] }),
      },
    });
    return { course: doc, state: st };
  };
  const exercises = new Map([
    ['Aa1', pending('Aa1')], ['Aa2', reached('Aa2', 100)],
    ['Ba1', pending('Ba1')], ['Ba2', pending('Ba2')],
  ]);
  return {
    courses: [make('A'), make('B')],
    rows: [looseRow('L1', '2026-01-01T00:00:00.000Z'), looseRow('L2', '2026-01-02T00:00:00.000Z'), looseRow('L3', '2026-01-03T00:00:00.000Z')],
    resolveExercise: resolveFrom(exercises),
    exercises,
  };
}

test('praticar: aulas assistidas na ordem do curso, alternando cursos, com avulsos na folga', () => {
  const fixture = twoCourseFixture();
  const plan = practiceCoursePlan({ ...fixture });
  assert.equal(plan.source, 'courses');
  assert.equal(plan.budgetMin, 40);
  // Aa1 e Ba1/Ba2 são os pendentes (Aa2 já atingiu o alvo); a folga recebe os avulsos.
  assert.deepEqual(plan.items.map(item => item.exerciseId), ['Aa1', 'Ba1', 'Ba2', 'L1', 'L2', 'L3']);
  assert.equal(plan.usedMin, 15);
  assert.equal(plan.loose, 3);
  assert.equal(plan.deferred, 0);
  assert.deepEqual(plan.items[0], { kind: 'exercise', exerciseId: 'Aa1', courseId: 'A', lessonId: 'AL1', name: null, durationMin: 5 });
  assert.deepEqual(plan.courses.map(entry => [entry.courseId, entry.count, entry.usedMin]), [['A', 1, 5], ['B', 2, 10]]);
});

test('praticar: nunca inclui exercício de aula NÃO assistida', () => {
  const doc = course('A', {
    sections: [section('As1', 'Módulo 1', [lesson('AL1', 'Aula 1'), lesson('AL2', 'Aula 2')])],
  });
  const st = state({
    courseId: 'A',
    lessons: {
      AL1: lessonState({ watched: true, linkedExerciseIds: ['a1'] }),
      AL2: lessonState({ watched: false, linkedExerciseIds: ['a2'] }),
    },
  });
  const plan = practiceCoursePlan({
    courses: [{ course: doc, state: st }],
    rows: [],
    resolveExercise: resolveFrom(new Map([['a1', pending('a1')], ['a2', pending('a2')]])),
  });
  assert.deepEqual(plan.items.map(item => item.exerciseId), ['a1']);
  // Assistir é a outra parte: a próxima aula não assistida aparece lá.
  const assist = assistCoursePlan({ courses: [{ course: doc, state: st }], minutes: 60 });
  assert.deepEqual(assist.items.map(item => item.lessonId), ['AL2']);
});

test('praticar: sugestões de receita ainda não geradas são oferecidas junto da aula', () => {
  const doc = course('A', {
    sections: [section('As1', 'Módulo 1', [
      lesson('AL1', 'Aula 1', {
        suggestedExercises: [
          { id: 'sug-1', title: 'Sugestão com receita', recipe: { family: 'movimento_continuo_linha_4_notas' } },
          { id: 'sug-2', title: 'Sugestão sem receita' },
        ],
      }),
      lesson('AL2', 'Aula 2', {
        suggestedExercises: [{ id: 'sug-3', title: 'Sugestão já gerada', recipe: { family: 'movimento_continuo_linha_4_notas' } }],
      }),
    ])],
  });
  const st = state({
    courseId: 'A',
    lessons: {
      AL1: lessonState({ watched: true, linkedExerciseIds: ['a1'] }),
      AL2: lessonState({ watched: false, generatedSuggestionIds: ['sug-3'], linkedExerciseIds: ['a3'] }),
    },
  });
  const plan = practiceCoursePlan({
    courses: [{ course: doc, state: st }],
    rows: [],
    resolveExercise: resolveFrom(new Map([['a1', pending('a1')]])),
  });
  assert.equal(plan.offerGenerate, 1);
  assert.deepEqual(plan.pendingSuggestions, [{
    courseId: 'A', courseTitle: 'Curso A', lessonId: 'AL1', lessonTitle: 'Aula 1', count: 1, suggestionIds: ['sug-1'],
  }]);
  // Aula não assistida: nem prática nem oferta de gerar (a sugestão já gerada
  // não conta de qualquer forma).
  assert.equal(plan.pendingSuggestions.some(entry => entry.lessonId === 'AL2'), false);
});

test('praticar: vínculo para exercício que sumiu é pendência, não item de prática', () => {
  const doc = course('A', { sections: [section('As1', 'Módulo 1', [lesson('AL1', 'Aula 1')])] });
  const st = state({ courseId: 'A', lessons: { AL1: lessonState({ watched: true, linkedExerciseIds: ['sumiu', 'ficou'] }) } });
  const plan = practiceCoursePlan({
    courses: [{ course: doc, state: st }],
    rows: [],
    resolveExercise: resolveFrom(new Map([['ficou', pending('ficou')]])),
  });
  assert.deepEqual(plan.items.map(item => item.exerciseId), ['ficou']);
  assert.equal(plan.deferred, 1);
  assert.deepEqual(plan.deferredItems.map(entry => [entry.name, entry.reason]), [['sumiu', 'exercise-missing']]);
});

test('praticar: sem curso ativo volta à sugestão avulsa de sempre', () => {
  const fixture = twoCourseFixture();
  const off = fixture.courses.map(entry => ({ course: entry.course, state: state({ courseId: entry.course.id, preferences: { active: false, dailyMinutes: null } }) }));
  const plan = practiceCoursePlan({ courses: off, rows: fixture.rows, resolveExercise: fixture.resolveExercise });
  assert.equal(plan.source, 'loose');
  assert.deepEqual(plan.items.map(item => item.exerciseId), ['L1', 'L2', 'L3']);
  assert.deepEqual(plan.courses, []);
  assert.equal(plan.pendingSuggestions.length, 0);
});

test('praticar: orçamento do curso limita o plano e o excedente é reportado com o motivo', () => {
  const doc = course('A', {
    dailyMinutes: 10,
    sections: [section('As1', 'Módulo 1', [lesson('AL1', 'Aula 1'), lesson('AL2', 'Aula 2')])],
  });
  const st = state({
    courseId: 'A',
    lessons: {
      AL1: lessonState({ watched: true, linkedExerciseIds: ['a1', 'a2'] }),
      AL2: lessonState({ watched: true, linkedExerciseIds: ['a3'] }),
    },
  });
  const plan = practiceCoursePlan({
    courses: [{ course: doc, state: st }],
    rows: [],
    resolveExercise: resolveFrom(new Map([['a1', pending('a1')], ['a2', pending('a2')], ['a3', pending('a3')]])),
  });
  assert.equal(plan.budgetMin, 10);
  assert.deepEqual(plan.items.map(item => item.exerciseId), ['a1', 'a2']);
  assert.equal(plan.deferred, 1);
  assert.deepEqual(plan.deferredItems.map(entry => [entry.name, entry.reason, entry.durationMin]), [['a3', 'budget', 5]]);
  // O valor do arquivo é o padrão; a edição no curso vence.
  assert.equal(courseBudgetMin(doc, st), 10);
  assert.equal(courseBudgetMin(doc, state({ preferences: { active: true, dailyMinutes: 15 } })), 15);
  assert.equal(courseBudgetMin(course('X', { dailyMinutes: null }), state()), DEFAULT_COURSE_MINUTES);
});

test('praticar: exercício compartilhado por dois cursos entra uma vez só', () => {
  const make = id => course(id, { sections: [section(`${id}s1`, 'Módulo 1', [lesson(`${id}L1`, `Aula ${id}`)])] });
  const courses = ['A', 'B'].map(id => ({
    course: make(id),
    state: state({ courseId: id, lessons: { [`${id}L1`]: lessonState({ watched: true, linkedExerciseIds: ['compartilhado'] }) } }),
  }));
  const plan = practiceCoursePlan({ courses, rows: [], resolveExercise: resolveFrom(new Map([['compartilhado', pending('compartilhado')]])) });
  assert.deepEqual(plan.items.map(item => item.exerciseId), ['compartilhado']);
  assert.equal(plan.duplicated, 1);
});

test('assistir: as aulas cabem no tempo indicado, obrigatórias antes das opcionais', () => {
  const doc = course('A', {
    sections: [
      section('s1', 'Módulo 1', [lesson('L1', 'Aula 1'), lesson('L2', 'Aula 2')]),
      section('s2', 'Seminário', [lesson('L3', 'Seminário 1'), lesson('L4', 'Seminário 2')], 'seminário'),
    ],
  });
  const st = state({ courseId: 'A', lessons: { L1: lessonState({ watched: true }) } });
  // Cada aula tem 5 minutos de vídeo: em 10 minutos cabem duas.
  const plan = assistCoursePlan({ courses: [{ course: doc, state: st }], minutes: 10 });
  assert.equal(plan.source, 'courses');
  assert.equal(plan.minutes, 10);
  assert.deepEqual(plan.items.map(item => item.lessonId), ['L2', 'L3']);
  assert.equal(plan.usedMin, 10);
  assert.deepEqual(plan.items.map(item => [item.kind, item.courseId, item.durationMin, item.optional]), [
    ['lesson', 'A', 5, false],
    ['lesson', 'A', 5, true],
  ]);
  assert.equal(plan.deferred, 1);
  assert.deepEqual(plan.deferredItems.map(entry => [entry.name, entry.reason]), [['Seminário 2', 'budget']]);
  assert.deepEqual(plan.courses.map(entry => [entry.courseId, entry.count, entry.usedMin, entry.next?.lessonId ?? null]), [['A', 2, 10, 'L4']]);
});

test('assistir: sem curso ativo ou sem aula pendente o plano fica vazio', () => {
  const doc = course('A', { sections: [section('s1', 'Módulo 1', [lesson('L1', 'Aula 1')])] });
  const watched = state({ courseId: 'A', lessons: { L1: lessonState({ watched: true }) } });
  const empty = assistCoursePlan({ courses: [{ course: doc, state: watched }], minutes: 30 });
  assert.equal(empty.source, 'courses');
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.deferredItems, []);
  const off = assistCoursePlan({ courses: [{ course: doc, state: state({ courseId: 'A', preferences: { active: false, dailyMinutes: null } }) }], minutes: 30 });
  assert.equal(off.source, 'none');
  assert.deepEqual(off.items, []);
});

test('assistir: o tempo indicado é limitado à faixa útil e o padrão vale sem indicação', () => {
  assert.equal(assistBudgetMin(null), DEFAULT_ASSIST_MINUTES);
  assert.equal(assistBudgetMin(30), 30);
  assert.equal(assistBudgetMin(0), MIN_ASSIST_MINUTES);
  assert.equal(assistBudgetMin(99999), MAX_ASSIST_MINUTES);
  assert.equal(assistBudgetMin(12.5), DEFAULT_ASSIST_MINUTES);
});

test('assistir hoje três aulas põe os exercícios delas na prática de amanhã', () => {
  const doc = course('A', {
    sections: [section('s1', 'Módulo 1', [lesson('L1', 'Aula 1'), lesson('L2', 'Aula 2'), lesson('L3', 'Aula 3'), lesson('L4', 'Aula 4')])],
  });
  const before = state({ courseId: 'A' });
  // Hoje: nada assistido → nada de prática, e as três primeiras aulas no plano de assistir.
  const morning = practiceCoursePlan({ courses: [{ course: doc, state: before }], rows: [], resolveExercise: resolveFrom(new Map([['a1', pending('a1')], ['a2', pending('a2')], ['a3', pending('a3')]])) });
  assert.deepEqual(morning.items, []);
  const watching = assistCoursePlan({ courses: [{ course: doc, state: before }], minutes: 15 });
  assert.deepEqual(watching.items.map(item => item.lessonId), ['L1', 'L2', 'L3']);

  // As três foram assistidas (a marcação acontece na aula) e cada uma tem um
  // exercício vinculado ainda abaixo do alvo.
  const after = state({
    courseId: 'A',
    lessons: {
      L1: lessonState({ watched: true, linkedExerciseIds: ['a1'] }),
      L2: lessonState({ watched: true, linkedExerciseIds: ['a2'] }),
      L3: lessonState({ watched: true, linkedExerciseIds: ['a3'] }),
    },
  });
  const tomorrow = practiceCoursePlan({
    courses: [{ course: doc, state: after }],
    rows: [],
    resolveExercise: resolveFrom(new Map([['a1', pending('a1')], ['a2', pending('a2')], ['a3', pending('a3')]])),
  });
  assert.deepEqual(tomorrow.items.map(item => item.exerciseId), ['a1', 'a2', 'a3'], 'da aula mais antiga para a mais nova');
  assert.equal(tomorrow.deferred, 0);
  // O plano de assistir continua de onde parou, sem repetir o que já foi visto.
  const nextDay = assistCoursePlan({ courses: [{ course: doc, state: after }], minutes: 30 });
  assert.deepEqual(nextDay.items.map(item => item.lessonId), ['L4']);
});
