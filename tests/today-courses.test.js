import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestCourseQueue, courseCandidates, courseBudgetMin, DEFAULT_COURSE_MINUTES } from '../src/today-courses.js';
import { referenceFingerprint } from '../src/exercise-library.js';

// Fixtures 100% fictícias (Curso de Exemplo, example.invalid).

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
  return { watched: false, skipped: false, completionOverride: null, notes: '', linkedExerciseIds: [], ...extra };
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

// Rótulo do item: aula é identificada pela aula (sem exerciseId), exercício
// pelo próprio id (items de exercício carregam também a aula de origem).
const labels = items => items.map(item => item.kind === 'lesson' ? `lesson:${item.lessonId}` : item.exerciseId);

function resolveFrom(map) {
  return id => map.get(id) ?? null;
}

// Dois cursos: a aula corrente é a SEGUNDA (escolhida explicitamente), com um
// exercício pendente nela e outro na primeira aula (assistida, alvo não
// alcançado) — o caso de "pendências anteriores".
function twoCourseFixture() {
  const make = id => {
    const doc = course(id, {
      sections: [section(`${id}s1`, 'Módulo 1', [lesson(`${id}L1`, `Aula 1 ${id}`), lesson(`${id}L2`, `Aula 2 ${id}`)])],
    });
    const st = state({
      courseId: id,
      activeLessonId: `${id}L2`,
      lessons: {
        [`${id}L1`]: lessonState({ watched: true, linkedExerciseIds: [`${id}a1`] }),
        [`${id}L2`]: lessonState({ linkedExerciseIds: [`${id}a2`] }),
      },
    });
    return { course: doc, state: st };
  };
  const exercises = new Map([
    ['Aa1', pending('Aa1')], ['Aa2', pending('Aa2')],
    ['Ba1', pending('Ba1')], ['Ba2', pending('Ba2')],
  ]);
  return {
    courses: [make('A'), make('B')],
    rows: [looseRow('L1', '2026-01-01T00:00:00.000Z'), looseRow('L2', '2026-01-02T00:00:00.000Z'), looseRow('L3', '2026-01-03T00:00:00.000Z')],
    resolveExercise: resolveFrom(exercises),
    exercises,
  };
}

test('orçamento por curso, round-robin e avulsos só na folga', () => {
  const fixture = twoCourseFixture();
  const plan = suggestCourseQueue({ ...fixture });
  assert.equal(plan.source, 'courses');
  assert.equal(plan.budgetMin, 40);
  assert.equal(plan.usedMin, 30);
  assert.deepEqual(plan.items.map(item => item.kind), ['lesson', 'lesson', 'exercise', 'exercise', 'exercise', 'exercise', 'exercise', 'exercise']);
  assert.deepEqual(labels(plan.items), ['lesson:AL2', 'lesson:BL2', 'Aa2', 'Ba2', 'Aa1', 'Ba1', 'L1', 'L2']);
  // A aula vem ANTES dos exercícios dela; a pendência anterior vem depois.
  assert.equal(plan.items[0].name, 'Aula 2 A');
  assert.equal(plan.items[0].durationMin, 5);
  assert.equal(plan.items[0].exerciseId, null, 'aula nunca inventa exerciseId');
  assert.equal(plan.items[2].courseId, 'A');
  assert.equal(plan.items[2].lessonId, 'AL2');
  assert.equal(plan.items[4].lessonId, 'AL1', 'pendência da aula anterior');
  assert.equal(plan.loose, 2, 'a folga de 10 min cabe dois avulsos de 5');
  assert.deepEqual(plan.items.slice(6).map(item => item.exerciseId), ['L1', 'L2']);
  assert.deepEqual(plan.courses.map(entry => [entry.courseId, entry.budgetMin, entry.usedMin, entry.count]), [['A', 20, 15, 3], ['B', 20, 15, 3]]);
});

test('edição do usuário vence o orçamento do arquivo', () => {
  const { courses, rows, resolveExercise } = twoCourseFixture();
  courses[0].state.preferences = { active: true, dailyMinutes: 10 };
  const plan = suggestCourseQueue({ courses, rows, resolveExercise });
  assert.equal(plan.courses[0].budgetMin, 10);
  assert.equal(plan.courses[0].usedMin, 10);
  assert.deepEqual(labels(plan.items.filter(item => item.courseId === 'A')), ['lesson:AL2', 'Aa2']);
  const deferred = plan.deferredItems.filter(entry => entry.courseId === 'A');
  assert.deepEqual(deferred.map(entry => [entry.name, entry.reason]), [['Aa1', 'budget']]);
  assert.equal(courseBudgetMin(courses[0].course, courses[0].state), 10);
  assert.equal(courseBudgetMin(courses[0].course, state({ preferences: { active: true, dailyMinutes: null } })), 20);
  assert.equal(courseBudgetMin(course('x', { dailyMinutes: null }), state()), DEFAULT_COURSE_MINUTES);
});

test('aula maior que o orçamento não é cortada: fica para depois com motivo', () => {
  const doc = course('A', {
    sections: [section('s1', 'Módulo 1', [lesson('L1', 'Aula longa', { videoSeconds: 25 * 60 })])],
  });
  const plan = suggestCourseQueue({
    courses: [{ course: doc, state: state({ courseId: 'A' }) }],
    rows: [], resolveExercise: () => null,
  });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.deferred, 1);
  assert.deepEqual(plan.deferredItems.map(entry => [entry.kind, entry.name, entry.durationMin, entry.reason]), [['lesson', 'Aula longa', 25, 'budget']]);
  assert.equal(plan.courses[0].budgetMin, 20);

  // Orçamento de 600 min continua permitido; estimativa acima do teto de
  // prática (180) não é cortada para caber.
  const long = course('B', { dailyMinutes: 600, sections: [section('s1', 'Módulo 1', [lesson('L1', 'Aula de 500', { videoSeconds: 500 * 60 })])] });
  const big = suggestCourseQueue({ courses: [{ course: long, state: state({ courseId: 'B' }) }], rows: [], resolveExercise: () => null });
  assert.equal(big.items.length, 1);
  assert.equal(big.items[0].durationMin, 500);
  assert.equal(big.courses[0].budgetMin, 600);

  const huge = course('C', { dailyMinutes: 600, sections: [section('s1', 'Módulo 1', [lesson('L1', 'Aula de 610', { videoSeconds: 610 * 60 })])] });
  const over = suggestCourseQueue({ courses: [{ course: huge, state: state({ courseId: 'C' }) }], rows: [], resolveExercise: () => null });
  assert.equal(over.items.length, 0);
  assert.equal(over.deferredItems[0].durationMin, 610, 'estimativa preservada, nunca truncada');
});

test('exercício com alvo alcançado sai do plano e a aula concluída não volta', () => {
  const doc = course('A', {
    sections: [section('s1', 'Módulo 1', [lesson('L1', 'Aula 1'), lesson('L2', 'Aula 2')])],
  });
  const stateValue = state({
    courseId: 'A',
    lessons: {
      L1: lessonState({ watched: true, linkedExerciseIds: ['rx'] }),
      L2: lessonState({ linkedExerciseIds: ['p2'] }),
    },
  });
  const exercises = new Map([['rx', reached('rx', 120)], ['p2', pending('p2')]]);
  const plan = suggestCourseQueue({
    courses: [{ course: doc, state: stateValue }], rows: [], resolveExercise: resolveFrom(exercises),
  });
  assert.deepEqual(labels(plan.items), ['lesson:L2', 'p2']);
  assert.equal(plan.items.some(item => item.exerciseId === 'rx'), false, 'alvo alcançado não é pedido de novo');
  assert.equal(plan.courses[0].count, 2);

  // Sem activeLessonId: a aula cumprida (assistida + alvo alcançado) sai da
  // ordem e a próxima aula do modelo assume, sem repetir 'rx'.
  const done = suggestCourseQueue({
    courses: [{
      course: doc,
      state: state({
        courseId: 'A',
        lessons: { L1: lessonState({ watched: true, linkedExerciseIds: ['rx'] }), L2: lessonState({ linkedExerciseIds: ['p2'] }) },
      }),
    }],
    rows: [], resolveExercise: resolveFrom(exercises),
  });
  assert.deepEqual(labels(done.items), ['lesson:L2', 'p2']);
  assert.equal(done.items.some(item => item.exerciseId === 'rx'), false, 'aula concluída não volta para a fila');
});

test('exercício compartilhado entre cursos entra uma vez só', () => {
  const makeDoc = id => course(id, { sections: [section('s1', 'Módulo 1', [lesson(`${id}L1`, `Aula ${id}`)])] });
  const courses = ['A', 'B'].map(id => ({
    course: makeDoc(id),
    state: state({ courseId: id, lessons: { [`${id}L1`]: lessonState({ linkedExerciseIds: ['shared'] }) } }),
  }));
  const plan = suggestCourseQueue({
    courses, rows: [], resolveExercise: resolveFrom(new Map([['shared', pending('shared')]])),
  });
  assert.equal(plan.items.filter(item => item.exerciseId === 'shared').length, 1);
  assert.equal(plan.duplicated, 1);
  assert.deepEqual(labels(plan.items), ['lesson:AL1', 'lesson:BL1', 'shared']);
});

test('curso inativo sai do plano; sem curso ativo vale o comportamento anterior', () => {
  const { courses, rows, resolveExercise } = twoCourseFixture();
  courses[1].state.preferences = { active: false, dailyMinutes: null };
  const onlyA = suggestCourseQueue({ courses, rows, resolveExercise });
  assert.equal(onlyA.source, 'courses');
  assert.equal(onlyA.items.some(item => item.courseId === 'B'), false);
  assert.equal(onlyA.budgetMin, 20);
  // O avulso vinculado ao curso inativo continua fora da folga (vínculo existe).
  assert.equal(onlyA.items.some(item => item.exerciseId === 'Ba1'), false);
  assert.deepEqual(onlyA.courses.map(entry => entry.courseId), ['A']);

  courses[0].state.preferences = { active: false, dailyMinutes: null };
  const none = suggestCourseQueue({ courses, rows, resolveExercise });
  assert.equal(none.source, 'loose');
  assert.deepEqual(none.courses, []);
  assert.equal(none.items.length, 3, 'sugestão avulsa de sempre (todos os avulsos aqui)');
  assert.deepEqual(none.items.map(item => item.exerciseId), ['L1', 'L2', 'L3']);
  assert.equal(none.items[0].kind, 'exercise');
  assert.equal(none.items[0].courseId, null);

  const empty = suggestCourseQueue({ courses: [], rows: [], resolveExercise: () => null });
  assert.equal(empty.source, 'loose');
  assert.deepEqual(empty.items, []);
});

test('tempo assistido não bloqueia nem consome o orçamento (o orçamento é de planejamento)', () => {
  const make = () => {
    const doc = course('A', { sections: [section('s1', 'Módulo 1', [lesson('L1', 'Aula 1'), lesson('L2', 'Aula 2')])] });
    return {
      course: doc,
      state: state({
        courseId: 'A',
        activeLessonId: 'L2',
        lessons: { L1: lessonState({ watched: true, linkedExerciseIds: ['a1'] }), L2: lessonState({ linkedExerciseIds: ['a2'] }) },
      }),
    };
  };
  const resolve = resolveFrom(new Map([['a1', pending('a1')], ['a2', pending('a2')]]));

  // Mesmo com o curso já bem além do orçamento hoje, a proposta continua a
  // mesma: o cronômetro opcional de estudo não trava o replanejamento.
  const over = make();
  over.state.watch = [
    { id: 'w1', lessonId: 'L1', startedAt: '2026-10-06T10:00:00.000Z', endedAt: '2026-10-06T10:25:00.000Z', ms: 25 * 60000 },
    { id: 'w2', lessonId: 'L2', startedAt: '2026-10-06T11:00:00.000Z', endedAt: '2026-10-06T11:40:00.000Z', ms: 40 * 60000 },
  ];
  const plan = suggestCourseQueue({ courses: [over], rows: [], resolveExercise: resolve });
  assert.equal(plan.courses[0].budgetMin, 20);
  assert.equal(plan.courses[0].usedMin, 15);
  assert.equal(plan.deferred, 0);
  assert.equal(plan.courses[0].reason, undefined);
  assert.deepEqual(labels(plan.items), ['lesson:L2', 'a2', 'a1']);
  assert.equal('studiedMin' in plan, false);

  // Sem tempo nenhum o plano é idêntico.
  const fresh = suggestCourseQueue({ courses: [make()], rows: [], resolveExercise: resolve });
  assert.deepEqual(labels(fresh.items), labels(plan.items));
  assert.equal(fresh.courses[0].usedMin, plan.courses[0].usedMin);
});

test('aula de seção opcional entra no plano com a estimativa padrão sem vídeo', () => {
  const doc = course('A', {
    sections: [section('s1', 'Seminário de exemplo', [lesson('L1', 'Boas-vindas', { videoSeconds: null, hasVideo: false })], 'seminário')],
  });
  // Aula opcional pendente entra, com a estimativa padrão quando não há vídeo.
  const items = courseCandidates(doc, state({ courseId: 'A' }), () => null);
  assert.deepEqual(items, [{ kind: 'lesson', courseId: 'A', lessonId: 'L1', exerciseId: null, name: 'Boas-vindas', durationMin: 5 }]);
});

test('visitar seminário longo não bloqueia aula obrigatória no orçamento', () => {
  const doc = course('A', {
    dailyMinutes: 20,
    sections: [
      section('s1', 'Seminário de exemplo', [lesson('optional', 'Aula opcional', { videoSeconds: 3300 })], 'seminário'),
      section('s2', 'Módulo 1', [lesson('required', 'Aula obrigatória', { videoSeconds: 360 })]),
    ],
  });
  const saved = state({ courseId: 'A', activeLessonId: 'optional' });
  const plan = suggestCourseQueue({ courses: [{ course: doc, state: saved }] });
  assert.deepEqual(labels(plan.items), ['lesson:required']);
  assert.equal(plan.usedMin, 6);
  assert.equal(plan.deferred, 0);

  saved.lessons.required = lessonState({ watched: true });
  saved.preferences.dailyMinutes = 60;
  const afterRequired = suggestCourseQueue({ courses: [{ course: doc, state: saved }] });
  assert.deepEqual(labels(afterRequired.items), ['lesson:optional']);
  assert.equal(afterRequired.usedMin, 55);
});
