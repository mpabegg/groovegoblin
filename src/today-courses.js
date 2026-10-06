// Planejamento diário em DUAS PARTES INDEPENDENTES (rodada 6, etapa 5 — A6).
//
//  - PRATICAR: exercícios das aulas JÁ ASSISTIDAS que ainda não chegaram ao
//    alvo, do mais antigo para o mais novo, mais os exercícios avulsos na
//    folga. Aula assistida com exercícios sugeridos de receita ainda não
//    gerados aparece com a oferta de gerá-los (é o que alimenta a prática de
//    hoje e dos próximos dias). O orçamento diário do CURSO vale aqui.
//  - ASSISTIR: as próximas aulas do curso, quantas couberem no tempo que o
//    usuário indicar. Assistir várias de uma vez só aumenta a fila de prática
//    dos dias seguintes — e nada é marcado como assistido pelo app: assistir
//    acontece no site do curso.
//
// As duas partes não se estorvam: assistir não consome o orçamento de prática e
// ficar sem tempo de assistir não tira nada da prática. Estimativas não são
// tempo praticado. Exercício já usado por outro curso entra uma vez só; o que
// não couber é reportado com o motivo, nunca cortado em silêncio.
//
// `assistLessons` já respeita o modelo puro: obrigatórias primeiro, opcionais
// depois (seminário e boas-vindas não bloqueiam), pulando o que já foi assistido
// ou marcado como pulado.

import { assistLessons, practiceLessons } from './course-progress.js';
import { DEFAULT_ITEM_MINUTES, SUGGESTION_LIMIT, suggestQueue } from './today-store.js';
import { COURSE_LIMITS } from './course-format.js';

export const DEFAULT_COURSE_MINUTES = 20;
export const DEFAULT_LESSON_MINUTES = 5;
export const DEFAULT_ASSIST_MINUTES = 20;
export const MIN_ASSIST_MINUTES = 5;
export const MAX_ASSIST_MINUTES = 600;

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

// Tempo que o usuário indicou para assistir hoje: um inteiro dentro da faixa;
// fora disso vale o padrão (a interface nunca oferece um valor impossível).
export function assistBudgetMin(value) {
  if (!Number.isInteger(value)) return DEFAULT_ASSIST_MINUTES;
  if (value < MIN_ASSIST_MINUTES) return MIN_ASSIST_MINUTES;
  if (value > MAX_ASSIST_MINUTES) return MAX_ASSIST_MINUTES;
  return value;
}

function estimatedMinutes(lesson) {
  const seconds = lesson?.videoSeconds;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : DEFAULT_LESSON_MINUTES;
}

function courseTitle(course) {
  return isText(course?.title) ? course.title : isText(course?.id) ? course.id : 'Curso';
}

function activeCourses(list) {
  return (Array.isArray(list) ? list : []).filter(value => value?.course).filter(value => value.state?.preferences?.active !== false);
}

function linkedExerciseIds(list) {
  const linked = new Set();
  for (const { state } of list) {
    for (const saved of Object.values(state?.lessons ?? {})) {
      for (const id of saved.linkedExerciseIds ?? []) linked.add(id);
    }
    for (const removed of state?.removed ?? []) {
      for (const id of removed.state?.linkedExerciseIds ?? []) linked.add(id);
    }
  }
  return linked;
}

// ----------------------------------------------------------------- PRATICAR

// Plano de prática: um item por exercício vinculado ainda abaixo do alvo, das
// aulas assistidas mais antigas para as mais novas, mais os avulsos na folga.
export function practiceCoursePlan({ courses = [], rows = [], resolveExercise = () => null } = {}) {
  const list = (Array.isArray(courses) ? courses : []).filter(value => value?.course);
  const active = activeCourses(list);
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
      loose: 0,
      pendingSuggestions: [],
      offerGenerate: 0,
    };
  }
  const linked = linkedExerciseIds(list);
  const usedExercises = new Set();
  let duplicated = 0;
  const deferredItems = [];
  const pendingSuggestions = [];
  const plans = active.map(({ course, state }) => {
    const budgetMin = courseBudgetMin(course, state);
    const title = courseTitle(course);
    const items = [];
    let usedMin = 0;
    let blocked = false;
    let deferred = 0;
    const defer = (name, durationMin, reason) => {
      deferred += 1;
      deferredItems.push({ courseId: course.id, courseTitle: title, kind: 'exercise', name, durationMin, reason });
    };
    // Aulas assistidas ainda em aberto, na ordem do curso (mais antiga primeiro).
    for (const row of practiceLessons(course, state, { resolveExercise })) {
      const suggestionIds = row.suggestions.map(item => item.suggestion.id);
      if (suggestionIds.length > 0) {
        pendingSuggestions.push({
          courseId: course.id,
          courseTitle: title,
          lessonId: row.lesson.id,
          lessonTitle: row.lesson.title ?? row.lesson.id,
          count: suggestionIds.length,
          suggestionIds,
        });
      }
      for (const link of row.links) {
        const name = resolveExercise(link.id)?.metadata?.name ?? link.id;
        if (!link.exists) {
          // Exercício vinculado que sumiu da biblioteca: é pendência da aula,
          // não um item de prática — o desvínculo é explícito.
          defer(name, DEFAULT_ITEM_MINUTES, 'exercise-missing');
          continue;
        }
        if (link.reached) continue;
        if (usedExercises.has(link.id)) { duplicated += 1; continue; }
        if (blocked || usedMin + DEFAULT_ITEM_MINUTES > budgetMin) {
          blocked = true;
          defer(name, DEFAULT_ITEM_MINUTES, 'budget');
          continue;
        }
        usedMin += DEFAULT_ITEM_MINUTES;
        usedExercises.add(link.id);
        items.push({
          kind: 'exercise',
          exerciseId: link.id,
          courseId: course.id,
          lessonId: row.lesson.id,
          name: null,
          durationMin: DEFAULT_ITEM_MINUTES,
        });
      }
    }
    return { courseId: course.id, title, budgetMin, usedMin, items, count: items.length, deferred };
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
  const deferred = deferredItems.length;
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
    pendingSuggestions,
    offerGenerate: pendingSuggestions.reduce((sum, entry) => sum + entry.count, 0),
  };
}

// ----------------------------------------------------------------- ASSISTIR

// Plano de assistir: as próximas aulas do curso, quantas couberem no tempo
// indicado. Os cursos ativos se alternam um item por vez, como na prática.
export function assistCoursePlan({ courses = [], minutes = DEFAULT_ASSIST_MINUTES } = {}) {
  const budget = assistBudgetMin(minutes);
  const active = activeCourses(courses);
  const plans = active.map(({ course, state }) => ({
    courseId: course.id,
    title: courseTitle(course),
    candidates: assistLessons(course, state).map(row => ({
      kind: 'lesson',
      courseId: course.id,
      lessonId: row.lesson.id,
      name: row.lesson.title ?? row.lesson.id,
      durationMin: estimatedMinutes(row.lesson),
      optional: row.lesson.optional === true,
    })),
    // Primeira aula que NÃO coube no tempo indicado: é a "próxima" do curso.
    blocked: null,
  }));
  const items = [];
  const deferredItems = [];
  let usedMin = 0;
  const cursor = plans.map(() => 0);
  let keepGoing = true;
  while (keepGoing) {
    keepGoing = false;
    plans.forEach((plan, planIndex) => {
      const candidate = plan.candidates[cursor[planIndex]];
      if (!candidate) return;
      if (usedMin + candidate.durationMin > budget) {
        // Nada de cortar a estimativa: a aula (e as seguintes) fica para
        // depois, com o motivo. O cursor vai para o fim (o aviso não se repete
        // a cada volta) e `blocked` guarda a próxima aula do curso.
        plan.blocked ??= candidate;
        plan.candidates.slice(cursor[planIndex]).forEach(rest => deferredItems.push({
          courseId: plan.courseId, courseTitle: plan.title, kind: 'lesson', name: rest.name, durationMin: rest.durationMin, reason: 'budget',
        }));
        cursor[planIndex] = plan.candidates.length;
        return;
      }
      keepGoing = true;
      usedMin += candidate.durationMin;
      items.push(candidate);
      cursor[planIndex] += 1;
    });
  }
  return {
    source: active.length === 0 ? 'none' : 'courses',
    minutes: budget,
    items,
    courses: plans.map((plan, index) => ({
      courseId: plan.courseId,
      title: plan.title,
      count: items.filter(item => item.courseId === plan.courseId).length,
      usedMin: items.filter(item => item.courseId === plan.courseId).reduce((sum, item) => sum + item.durationMin, 0),
      next: plan.blocked ?? plan.candidates[cursor[index]] ?? null,
    })),
    usedMin,
    deferred: deferredItems.length,
    deferredItems,
  };
}
