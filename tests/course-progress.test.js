import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referenceFingerprint, materialKey } from '../src/exercise-library.js';
import {
  LESSON_STATUS, courseLessons, lessonStateOf, authoredReachedTarget, lessonStatus, lessonCompletion,
  lessonPending, linkStatus, nextLesson, courseSummary, unionWatchMs, weekRange, videoMinutes, normalizeLessonState,
} from '../src/course-progress.js';
import { courseDocument, lesson, section } from './course-fixtures.js';

const SESSION = {
  name: 'Exercício de Exemplo',
  bpm: 80,
  bars: 4,
  meter: { beats: 4, unit: 4 },
  subdivision: 1,
  swing: 0,
  swingUnit: 2,
  loop: { startBar: 0, endBar: 4 },
  notes: [],
  training: { goal: 'attack', repetitions: 1 },
};

function record(ratio, { bpm = 100, source = 'authored', metric = ratio, session = SESSION } = {}) {
  const goal = session.training.goal;
  const repetitions = session.training.repetitions;
  const base = {
    id: `r-${ratio}-${bpm}-${source}`,
    ownerId: 'ex-1',
    source,
    goal,
    repetitions,
    bpm,
    referenceFingerprint: referenceFingerprint(session, { goal, repetitions }),
    summary: { mode: 'strict', expected: 10, attackOk: Math.round(ratio * 10), endOk: 10, pitchOk: 0, pitchChecked: 0, free: 0 },
  };
  return { ...base, metric, materialKey: materialKey(base) };
}

// Ids reservados são ids válidos do formato: o dicionário de estado precisa
// guardá-los como entradas PRÓPRIAS (e nunca ler o Object.prototype no lugar).
const RESERVED_LESSON_IDS = ['__proto__', 'constructor', 'toString'];

function dictionaryOf(entries) {
  const dictionary = Object.create(null);
  for (const [key, value] of entries) {
    Object.defineProperty(dictionary, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return dictionary;
}

function entry({ id = 'ex-1', targetBPM = 100, records = [], session = SESSION } = {}) {
  return { id, session, metadata: { name: 'Exercício de Exemplo', tags: [], targetBPM, notes: '', records } };
}

function resolver(entries) {
  const map = new Map(entries.map(item => [item.id, item]));
  return id => map.get(id) ?? null;
}

const state = (overrides = {}) => normalizeLessonState(overrides);

test('progresso: alvo exige execução autoral, BPM no alvo e 90% de acertos', () => {
  assert.equal(authoredReachedTarget(entry({ records: [record(0.9)] }), 100), true);
  assert.equal(authoredReachedTarget(entry({ records: [record(0.89)] }), 100), false);
  assert.equal(authoredReachedTarget(entry({ records: [record(0.95, { bpm: 90 })] }), 100), false);
  assert.equal(authoredReachedTarget(entry({ records: [record(0.99, { source: 'generated' })] }), 100), false);
  // Sem métrica, a razão de ataques decide; com métrica, ela manda.
  assert.equal(authoredReachedTarget(entry({ records: [record(0.5, { metric: null })] }), 100), false);
  assert.equal(authoredReachedTarget(entry({ records: [record(0.5, { metric: 0.95 })] }), 100), true);
  assert.equal(authoredReachedTarget(entry({ records: [record(0.92, { metric: null })] }), 100), true);
  assert.equal(authoredReachedTarget(entry({ records: [record(0.5)] }), null), false);
  assert.equal(authoredReachedTarget(null, 100), false);
});

test('progresso: estado de aula normalizado e vínculo classificado', () => {
  const normalized = normalizeLessonState({ watched: 'sim', completionOverride: 'qualquer', linkedExerciseIds: ['a', 'a', '', 5] });
  assert.deepEqual(normalized, { watched: false, skipped: false, completionOverride: null, notes: '', linkedExerciseIds: ['a'], updatedAt: null });
  assert.equal(lessonStateOf({}, 'aula-1').watched, false);
  assert.equal(lessonStateOf({ lessons: { 'aula-1': { watched: true } } }, 'aula-1').watched, true);

  assert.deepEqual(linkStatus(null, 'sumiu'), { id: 'sumiu', exists: false, trained: false, hasTarget: false, targetBpm: null, reached: false });
  assert.equal(linkStatus(entry(), 'ex-1').hasTarget, true);
  assert.equal(linkStatus(entry({ targetBPM: null }), 'ex-1').hasTarget, false);
  assert.equal(linkStatus(entry({ records: [record(0.5)] }), 'ex-1').trained, true);
});

test('progresso: status deriva de assistida, prática e conclusão', () => {
  const none = [];
  assert.equal(lessonStatus(state(), none, { hasSuggestions: false }), LESSON_STATUS.notStarted);
  assert.equal(lessonStatus(state({ watched: true }), none, { hasSuggestions: true }), LESSON_STATUS.watched);
  assert.equal(lessonStatus(state({ watched: true }), none, { hasSuggestions: false }), LESSON_STATUS.done);
  assert.equal(lessonStatus(state({ watched: true, skipped: true }), none, { hasSuggestions: false }), LESSON_STATUS.done);
  assert.equal(lessonStatus(state(), none, { watchMs: 60000 }), LESSON_STATUS.practicing);
  const trained = [linkStatus(entry({ records: [record(0.5)] }), 'ex-1')];
  assert.equal(lessonStatus(state(), trained, { hasSuggestions: true }), LESSON_STATUS.practicing);
  assert.equal(lessonStatus(state({ watched: true }), trained, { hasSuggestions: true }), LESSON_STATUS.practicing);
  const reached = [linkStatus(entry({ records: [record(0.95)] }), 'ex-1')];
  assert.equal(lessonStatus(state({ watched: true }), reached, { hasSuggestions: true }), LESSON_STATUS.done);
});

test('progresso: conclusão automática exige TODOS os vínculos no alvo', () => {
  const both = [linkStatus(entry({ id: 'ex-1', records: [record(0.95)] }), 'ex-1'), linkStatus(entry({ id: 'ex-2', records: [record(0.9)] }), 'ex-2')];
  assert.deepEqual(lessonCompletion(state({ watched: true }), both, { hasSuggestions: true }), { completed: true, automatic: true, override: null });
  const half = [both[0], linkStatus(entry({ id: 'ex-2', records: [record(0.88)] }), 'ex-2')];
  assert.equal(lessonCompletion(state({ watched: true }), half, { hasSuggestions: true }).completed, false);
  assert.equal(lessonCompletion(state(), both, { hasSuggestions: true }).completed, false);
  assert.equal(lessonCompletion(state({ watched: true }), [], { hasSuggestions: true }).completed, false);
  assert.equal(lessonCompletion(state({ watched: true }), [], { hasSuggestions: false }).completed, true);
});

test('progresso: alvo nulo, exercício ausente e desvínculo explícito', () => {
  const noTarget = [linkStatus(entry({ targetBPM: null, records: [record(0.99)] }), 'ex-1')];
  assert.equal(lessonCompletion(state({ watched: true }), noTarget, { hasSuggestions: true }).completed, false);
  assert.deepEqual(lessonPending(state({ watched: true }), noTarget, { hasSuggestions: true }), ['exercise-without-target']);

  const missing = [linkStatus(null, 'ex-apagado')];
  assert.equal(lessonCompletion(state({ watched: true }), missing, { hasSuggestions: true }).completed, false);
  assert.deepEqual(lessonPending(state({ watched: true }), missing, { hasSuggestions: true }), ['exercise-missing']);
  // Depois do desvínculo explícito, a aula sem sugestões conclui por assistida.
  assert.equal(lessonCompletion(state({ watched: true }), [], { hasSuggestions: false }).completed, true);
  assert.deepEqual(lessonPending(state({ watched: true }), [], { hasSuggestions: true }), ['no-linked-exercise']);
  assert.deepEqual(lessonPending(state(), [], { hasSuggestions: false }), ['not-watched']);
});

test('progresso: override conclui e reabrir bloqueia até retomar', () => {
  const reached = [linkStatus(entry({ records: [record(0.95)] }), 'ex-1')];
  assert.equal(lessonCompletion(state({ completionOverride: 'complete' }), [], { hasSuggestions: true }).completed, true);
  const reopened = state({ watched: true, completionOverride: 'reopened' });
  assert.deepEqual(lessonCompletion(reopened, reached, { hasSuggestions: true }), { completed: false, automatic: false, override: 'reopened' });
  assert.equal(lessonStatus(reopened, reached, { hasSuggestions: true }), LESSON_STATUS.practicing);
  assert.ok(lessonPending(reopened, reached, { hasSuggestions: true }).includes('reopened'));
  // Retomar é explícito: com o override limpo, a conclusão automática volta.
  const resumed = state({ watched: true, completionOverride: null });
  assert.equal(lessonCompletion(resumed, reached, { hasSuggestions: true }).completed, true);
});

test('progresso: próxima aula prioriza obrigatórias e não bloqueia em opcionais', () => {
  const course = courseDocument().course;
  const empty = { lessons: {}, removed: [], watch: [] };
  assert.equal(nextLesson(course, empty).lesson.id, 'aula-1');
  assert.equal(nextLesson(course, empty).optional, false);

  const onlyAula1Done = { lessons: { 'aula-1': { watched: true, completionOverride: 'complete' } }, removed: [], watch: [] };
  assert.equal(nextLesson(course, onlyAula1Done).lesson.id, 'aula-2');

  // Pular a aula 2 leva para a 3 sem esconder a opcional do fim.
  const skipped = { lessons: { 'aula-1': { completionOverride: 'complete' }, 'aula-2': { skipped: true } }, removed: [], watch: [] };
  assert.equal(nextLesson(course, skipped).lesson.id, 'aula-3');

  // Aula com sugestões e nenhum vínculo NÃO conclui só por estar assistida.
  const watchedWithSuggestions = { lessons: { 'aula-1': { watched: true } }, removed: [], watch: [] };
  assert.equal(nextLesson(course, watchedWithSuggestions).lesson.id, 'aula-1');

  const requiredDone = { lessons: { 'aula-1': { completionOverride: 'complete' }, 'aula-2': { watched: true }, 'aula-3': { watched: true } }, removed: [], watch: [] };
  const optional = nextLesson(course, requiredDone);
  assert.equal(optional.lesson.id, 'aula-0');
  assert.equal(optional.optional, true);

  const allDone = { ...requiredDone, lessons: { ...requiredDone.lessons, 'aula-0': { watched: true } } };
  assert.equal(nextLesson(course, allDone), null);
});

test('progresso: resumo separa denominador obrigatório e opcional', () => {
  const course = courseDocument().course;
  const summary = courseSummary(course, { lessons: { 'aula-1': { completionOverride: 'complete' } }, removed: [], watch: [] }, {});
  assert.equal(summary.total, 4);
  assert.equal(summary.requiredTotal, 3);
  assert.equal(summary.optionalTotal, 1);
  assert.equal(summary.done, 1);
  assert.equal(summary.doneRequired, 1);
  assert.equal(summary.doneOptional, 0);
  assert.equal(summary.next.lesson.id, 'aula-2');
});

test('progresso: tempo de estudo une sobreposições e corta na semana', () => {
  const events = [
    { lessonId: 'aula-1', startedAt: '2026-10-05T10:00:00.000Z', endedAt: '2026-10-05T10:30:00.000Z' },
    { lessonId: 'aula-1', startedAt: '2026-10-05T10:15:00.000Z', endedAt: '2026-10-05T10:45:00.000Z' },
    { lessonId: 'aula-2', startedAt: '2026-10-06T09:00:00.000Z', endedAt: '2026-10-06T09:10:00.000Z' },
    { lessonId: 'aula-2', startedAt: '2026-10-06T10:00:00.000Z', endedAt: '2026-10-06T10:05:00.000Z' },
    { lessonId: 'aula-2', startedAt: '2026-10-20T10:00:00.000Z', endedAt: '2026-10-20T11:00:00.000Z' },
  ];
  assert.equal(unionWatchMs(events, Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 30)), 45 * 60000 + 10 * 60000 + 5 * 60000 + 60 * 60000);
  const [start, end] = weekRange(Date.UTC(2026, 9, 7, 12, 0, 0));
  assert.equal(unionWatchMs(events, start, end), 45 * 60000 + 15 * 60000);
  assert.equal(unionWatchMs([{ lessonId: 'a', startedAt: 'nada', endedAt: 'nada' }], 0, Date.now()), 0);

  const course = courseDocument().course;
  const summary = courseSummary(course, {
    lessons: {},
    removed: [],
    watch: [
      { lessonId: 'aula-1', startedAt: '2026-10-05T10:00:00.000Z', endedAt: '2026-10-05T10:30:00.000Z' },
      { lessonId: 'aula-1', startedAt: '2026-10-05T10:10:00.000Z', endedAt: '2026-10-05T10:20:00.000Z' },
    ],
  }, { now: Date.UTC(2026, 9, 7, 12, 0, 0) });
  assert.equal(summary.weekMs, 30 * 60000);
  assert.equal(summary.watchMs, 30 * 60000);
});

test('progresso: duração de aula arredonda para cima e não inventa número', () => {
  assert.equal(videoMinutes(361), 7);
  assert.equal(videoMinutes(60), 1);
  assert.equal(videoMinutes(0), null);
  assert.equal(videoMinutes(null), null);
  assert.equal(videoMinutes(undefined), null);
});

test('progresso: 200 aulas em ordem preservam próxima aula e contagens', () => {
  const lessons = Array.from({ length: 200 }, (unused, index) => lesson(`aula-${index + 1}`));
  const course = courseDocument({ sections: [section('modulo-1', lessons), section('boas-vindas', [lesson('aula-0')], { title: 'Boas-vindas', type: 'boas-vindas' })] }).course;
  assert.equal(courseLessons(course).length, 201);
  const watched = { lessons: Object.fromEntries(lessons.slice(0, 150).map(item => [item.id, { watched: true }])), removed: [], watch: [] };
  const summary = courseSummary(course, watched, {});
  assert.equal(summary.requiredTotal, 200);
  assert.equal(summary.optionalTotal, 1);
  assert.equal(summary.done, 150);
  assert.equal(summary.doneRequired, 150);
  assert.equal(summary.doneOptional, 0);
  assert.equal(summary.next.lesson.id, 'aula-151');
  assert.equal(summary.next.optional, false);

  // Aula removida do curso não entra na próxima nem nas contagens.
  const withTombstone = { ...watched, removed: [{ id: 'aula-151', title: 'Aula removida', state: normalizeLessonState({ watched: true }) }] };
  const reduced = courseDocument({ sections: [section('modulo-1', lessons.slice(0, 150).concat(lessons.slice(151)))] }).course;
  assert.equal(courseLessons(reduced).length, 199);
  assert.equal(courseSummary(reduced, withTombstone, {}).next.lesson.id, 'aula-152');
});

test('progresso: id de aula reservado não herda o protótipo e entra como entrada própria', () => {
  const document = courseDocument({
    sections: [
      section('modulo-1', RESERVED_LESSON_IDS.map(id => lesson(id))),
      section('boas-vindas', [lesson('aula-0')], { type: 'boas-vindas' }),
    ],
  });
  assert.deepEqual(courseLessons(document.course).map(item => item.id), [...RESERVED_LESSON_IDS, 'aula-0']);

  // Sem registro gravado, nenhum id reservado herda nada do Object.prototype.
  for (const id of RESERVED_LESSON_IDS) {
    assert.equal(lessonStateOf({ lessons: Object.create(null) }, id).watched, false);
    assert.equal(lessonStateOf({ lessons: {} }, id).watched, false);
    assert.equal(lessonStateOf({}, id).watched, false);
  }

  const lessons = dictionaryOf([['__proto__', { watched: true }], ['constructor', { watched: true }]]);
  const summary = courseSummary(document.course, { lessons, removed: [], watch: [] }, {});
  assert.equal(summary.total, 4);
  assert.equal(summary.done, 2);
  assert.equal(summary.doneRequired, 2);
  assert.equal(summary.optionalTotal, 1);
  // A obrigatória reservada é a próxima; assistida e sem sugestões, conclui e
  // passa a vez para a seguinte — as opcionais continuam intactas.
  assert.equal(nextLesson(document.course, { lessons }).lesson.id, 'toString');
  assert.equal(summary.next.lesson.id, 'toString');
  assert.equal(summary.rows.find(row => row.lesson.id === '__proto__').status, LESSON_STATUS.done);
  assert.equal(summary.rows.find(row => row.lesson.id === 'constructor').status, LESSON_STATUS.done);
  assert.equal(summary.rows.find(row => row.lesson.id === 'toString').status, LESSON_STATUS.notStarted);
  assert.equal(summary.rows.find(row => row.lesson.id === 'aula-0').status, LESSON_STATUS.notStarted);
  // Só o vínculo PRÓPRIO conta: o estado do id reservado vem do dicionário.
  assert.equal(lessonStateOf({ lessons }, 'constructor').watched, true);
  assert.equal(lessonStateOf({ lessons }, '__proto__').watched, true);
});
