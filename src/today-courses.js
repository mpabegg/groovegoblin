// Planejamento diário: um orçamento por curso, alternância entre cursos e
// exercícios avulsos somente na folga. Estimativas não são tempo praticado.
//
// Ordem por curso (etapa 7, contrato do integrador):
//  1. a aula corrente (a aberta explicitamente, senão a "próxima aula" do
//     modelo) — com "Assistir" antes dos exercícios dela;
//  2. os exercícios vinculados dessa aula ainda sem alvo alcançado;
//  3. as pendências de prática das aulas ANTERIORES ainda incompletas (só
//     acontece quando a aula corrente foi escolhida à frente delas).
// Os cursos ATIVOS se alternam um item por vez (round-robin), mantendo a ordem
// de cada curso. Exercício já usado por outro curso não entra de novo. O
// orçamento diário (arquivo do curso, editável na interface) é só de
// PLANEJAMENTO: limita a soma das estimativas do plano, a estimativa da aula
// nunca é cortada para caber e o que ficou de fora é reportado com o motivo.
// O cronômetro de estudo é opcional e NUNCA bloqueia a proposta de aula/replano
// (tempo já assistido não consome nem trava o orçamento). Sem curso ativo, o
// comportamento anterior (sugestão avulsa) continua valendo.

import { courseLessons, lessonStateOf, lessonLinks, lessonCompletion, nextLesson, videoMinutes } from './course-progress.js';
import { DEFAULT_ITEM_MINUTES, SUGGESTION_LIMIT, suggestQueue } from './today-store.js';
import { COURSE_LIMITS } from './course-format.js';

export const DEFAULT_COURSE_MINUTES = 20;
export const DEFAULT_LESSON_MINUTES = 5;

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

// Orçamento do curso: a edição do usuário (preferências guardadas no estado)
// vence o valor do arquivo; nada fora dos limites entra.
export function courseBudgetMin(course, state) {
  const edited = state?.preferences?.dailyMinutes;
  const value = Number.isInteger(edited) ? edited : course?.dailyMinutes;
  return Number.isInteger(value) && value >= COURSE_LIMITS.dailyMinutesMin && value <= COURSE_LIMITS.dailyMinutesMax
    ? value
    : DEFAULT_COURSE_MINUTES;
}

function estimatedMinutes(lesson) {
  return videoMinutes(lesson?.videoSeconds) ?? DEFAULT_LESSON_MINUTES;
}

function completed(lesson, state, resolveExercise) {
  const saved = lessonStateOf(state, lesson.id);
  return saved.skipped || lessonCompletion(saved, lessonLinks(saved, resolveExercise), {
    hasSuggestions: (lesson.suggestedExercises?.length ?? 0) > 0,
  }).completed;
}

function courseTitle(course) {
  return isText(course?.title) ? course.title : isText(course?.id) ? course.id : 'Curso';
}

export function courseCandidates(course, state, resolveExercise) {
  const lessons = courseLessons(course);
  // Uma aula obrigatória aberta explicitamente pode estar adiante das
  // pendências antigas. Visitar um seminário não o põe à frente das aulas
  // obrigatórias: ele só assume o plano quando elas já estiverem concluídas.
  const suggested = nextLesson(course, state, { resolveExercise })?.lesson;
  const selected = lessons.find(lesson => lesson.id === state?.activeLessonId
    && !completed(lesson, state, resolveExercise)
    && (!lesson.optional || suggested?.optional));
  const next = selected ?? suggested;
  if (!next) return [];
  const items = [];
  const saved = lessonStateOf(state, next.id);
  if (!saved.watched) {
    items.push({ kind: 'lesson', courseId: course.id, lessonId: next.id, exerciseId: null,
      name: next.title ?? next.id, durationMin: estimatedMinutes(next) });
  }
  function addPractice(lesson) {
    for (const link of lessonLinks(lessonStateOf(state, lesson.id), resolveExercise)) {
      if (link.exists && !link.reached) items.push({ kind: 'exercise', exerciseId: link.id,
        courseId: course.id, lessonId: lesson.id, name: null, durationMin: DEFAULT_ITEM_MINUTES });
    }
  }
  addPractice(next);
  const before = lessons.findIndex(lesson => lesson.id === next.id);
  for (const lesson of lessons.slice(0, before)) {
    if (!completed(lesson, state, resolveExercise)) addPractice(lesson);
  }
  return items;
}

export function suggestCourseQueue({ courses = [], rows = [], resolveExercise = () => null } = {}) {
  const list = (Array.isArray(courses) ? courses : []).filter(value => value?.course);
  const active = list.filter(value => value.state?.preferences?.active !== false);
  if (active.length === 0) {
    const items = suggestQueue(rows).slice(0, SUGGESTION_LIMIT);
    return {
      source: 'loose',
      items,
      courses: [],
      budgetMin: items.reduce((sum, item) => sum + item.durationMin, 0),
      usedMin: items.reduce((sum, item) => sum + item.durationMin, 0),
      deferred: 0,
      deferredItems: [],
      duplicated: 0,
    };
  }
  const linked = new Set();
  for (const { state } of list) {
    for (const saved of Object.values(state?.lessons ?? {})) {
      for (const id of saved.linkedExerciseIds ?? []) linked.add(id);
    }
    for (const removed of state?.removed ?? []) {
      for (const id of removed.state?.linkedExerciseIds ?? []) linked.add(id);
    }
  }
  const usedExercises = new Set();
  let deferred = 0;
  let duplicated = 0;
  const deferredItems = [];
  const plans = active.map(({ course, state }) => {
    const budgetMin = courseBudgetMin(course, state);
    const title = courseTitle(course);
    const items = [];
    let usedMin = 0;
    const candidates = courseCandidates(course, state, resolveExercise);
    let blocked = false;
    for (const candidate of candidates) {
      if (blocked) {
        deferred += 1;
        deferredItems.push({
          courseId: course.id, courseTitle: title, kind: candidate.kind,
          name: candidate.name ?? candidate.exerciseId ?? candidate.lessonId ?? '',
          durationMin: candidate.durationMin, reason: 'budget',
        });
        continue;
      }
      if (candidate.exerciseId && usedExercises.has(candidate.exerciseId)) {
        duplicated += 1;
        continue;
      }
      if (usedMin + candidate.durationMin > budgetMin) {
        // Nada de cortar a estimativa: o item (e o que vinha depois dele na
        // ordem de prioridade) fica para depois, com o motivo.
        blocked = true;
        deferred += 1;
        deferredItems.push({
          courseId: course.id, courseTitle: title, kind: candidate.kind,
          name: candidate.name ?? candidate.exerciseId ?? candidate.lessonId ?? '',
          durationMin: candidate.durationMin, reason: 'budget',
        });
        continue;
      }
      usedMin += candidate.durationMin;
      items.push(candidate);
      if (candidate.exerciseId) usedExercises.add(candidate.exerciseId);
    }
    return {
      courseId: course.id, title, budgetMin, usedMin, items,
      count: items.length,
      deferred: deferredItems.filter(entry => entry.courseId === course.id).length,
    };
  });
  const items = [];
  const longest = Math.max(0, ...plans.map(plan => plan.items.length));
  for (let index = 0; index < longest; index += 1) {
    for (const plan of plans) if (plan.items[index]) items.push(plan.items[index]);
  }
  const budgetMin = plans.reduce((sum, plan) => sum + plan.budgetMin, 0);
  let remaining = budgetMin - plans.reduce((sum, plan) => sum + plan.usedMin, 0);
  let loose = 0;
  for (const candidate of suggestQueue(rows)) {
    if (linked.has(candidate.exerciseId) || usedExercises.has(candidate.exerciseId)) continue;
    if (candidate.durationMin > remaining) break;
    items.push(candidate);
    usedExercises.add(candidate.exerciseId);
    remaining -= candidate.durationMin;
    loose += 1;
  }
  return {
    source: 'courses',
    items,
    courses: plans.map(({ items: planned, ...summary }) => summary),
    budgetMin,
    usedMin: plans.reduce((sum, plan) => sum + plan.usedMin, 0),
    deferred,
    deferredItems,
    duplicated,
    loose,
  };
}
