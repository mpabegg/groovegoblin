// Modelo derivado dos cursos (rodada 5, etapa 5).
//
// Tudo aqui é PURO e recalculado a cada leitura: nada de progresso é gravado
// como verdade. O estado persistido por aula é mínimo — assistida, pulada,
// override de conclusão, anotações e vínculos — e o resto (status, conclusão,
// próxima aula, tempo de estudo) sai destas funções, para a interface e as
// próximas etapas nunca divergirem da mesma regra.
//
// Regras de conclusão automática (combinadas com o integrador):
//  - a aula precisa estar ASSISTIDA;
//  - com exercícios vinculados, TODOS precisam ter atingido o PRÓPRIO alvo:
//    BPM >= alvo com >= 90% de acertos em execução AUTORAL (material gerado
//    nunca promove alvo);
//  - exercício sem alvo definido NÃO satisfaz (não existe alvo alcançado);
//  - vínculo cujo exercício sumiu da biblioteca continua sendo pendência — a
//    lição não passa a "sem exercício" sozinha: o desvínculo é explícito;
//  - aula sem NENHUM exercício (nem vinculado, nem sugerido) conclui só por ser
//    assistida; aula com sugestões e nenhum vínculo fica pendente;
//  - override "complete" conclui mesmo assim; override "reopened" bloqueia a
//    conclusão automática até o usuário pedir para retomar (override null),
//    mesmo que as condições já estejam cumpridas.

import { referenceFingerprint } from './exercise-library.js';

export const LESSON_STATUS = Object.freeze({
  notStarted: 'not-started',
  watched: 'watched',
  practicing: 'practicing',
  done: 'done',
});
export const LESSON_STATUS_IDS = Object.freeze(Object.values(LESSON_STATUS));
export const COMPLETION_OVERRIDES = Object.freeze([null, 'complete', 'reopened']);
// Seções opcionais não bloqueiam a próxima aula obrigatória.
export const OPTIONAL_SECTION_TYPES = Object.freeze(['seminário', 'boas-vindas']);
export const COMPLETION_THRESHOLD = 0.9;
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

export function isOptionalSection(section) {
  return OPTIONAL_SECTION_TYPES.includes(section?.type);
}

// Estado de aula normalizado. Aulas sem estado gravado devolvem o padrão —
// o estado é esparso de propósito (200 aulas não precisam de 200 registros).
export function normalizeLessonState(value) {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const override = COMPLETION_OVERRIDES.includes(source.completionOverride) ? source.completionOverride : null;
  const linked = [];
  for (const id of Array.isArray(source.linkedExerciseIds) ? source.linkedExerciseIds : []) {
    if (!isText(id) || linked.includes(id)) continue;
    linked.push(id);
  }
  const generated = [];
  for (const id of Array.isArray(source.generatedSuggestionIds) ? source.generatedSuggestionIds : []) {
    if (!isText(id) || generated.includes(id)) continue;
    generated.push(id);
  }
  return {
    watched: source.watched === true,
    skipped: source.skipped === true,
    completionOverride: override,
    notes: typeof source.notes === 'string' ? source.notes : '',
    linkedExerciseIds: linked,
    generatedSuggestionIds: generated,
    updatedAt: isText(source.updatedAt) ? source.updatedAt : null,
  };
}

export function lessonStateOf(state, lessonId) {
  // Só a entrada PRÓPRIA do dicionário vale: sem isso um id como "__proto__"
  // devolveria o Object.prototype herdado no lugar do estado gravado.
  const lessons = state?.lessons;
  const raw = lessons !== null && typeof lessons === 'object' && Object.hasOwn(lessons, lessonId) ? lessons[lessonId] : undefined;
  return normalizeLessonState(raw);
}

// Aulas em ordem de leitura, cada uma com a seção de origem. A ordem do
// documento é a ordem do curso; nada é reordenado por heurística.
export function courseLessons(course) {
  const lessons = [];
  const sections = Array.isArray(course?.sections) ? course.sections : [];
  sections.forEach((section, sectionIndex) => {
    const items = Array.isArray(section?.lessons) ? section.lessons : [];
    items.forEach((lesson, lessonIndex) => {
      lessons.push({
        ...lesson,
        sectionId: section.id ?? null,
        sectionTitle: section.title ?? null,
        sectionType: section.type ?? null,
        sectionIndex,
        lessonIndex,
        optional: isOptionalSection(section),
      });
    });
  });
  return lessons;
}

// Execução AUTORAL que atingiu o alvo: mesmo material do exercício canônico
// (impressão digital + objetivo + repetições), BPM igual ou acima do alvo e
// >= 90% de acertos. A biblioteca já registra `source` no começo da execução.
export function authoredReachedTarget(entry, targetBpm, { threshold = COMPLETION_THRESHOLD } = {}) {
  if (!entry || !Number.isFinite(targetBpm)) return false;
  const records = Array.isArray(entry.metadata?.records) ? entry.metadata.records : [];
  const session = entry.session;
  const goal = session?.training?.goal ?? null;
  const repetitions = session?.training?.repetitions ?? null;
  const authoredKey = `${referenceFingerprint(session, { goal, repetitions })}|${goal ?? ''}|${repetitions ?? ''}|authored`;
  return records.some(record => {
    if (record?.source !== 'authored') return false;
    if (record.materialKey !== authoredKey) return false;
    const summary = record.summary ?? {};
    if (summary.mode === 'free' || !(Number(summary.expected) > 0)) return false;
    if (!(Number(record.bpm) >= targetBpm)) return false;
    const ratio = Number.isFinite(record.metric) ? record.metric : Number(summary.attackOk) / Number(summary.expected);
    return Number.isFinite(ratio) && ratio >= threshold;
  });
}

// Situação de um vínculo: exercício existente? treinado? tem alvo? atingiu?
export function linkStatus(entry, id) {
  if (!entry) return { id, exists: false, trained: false, hasTarget: false, targetBpm: null, reached: false };
  const targetBpm = Number.isFinite(entry.metadata?.targetBPM) ? entry.metadata.targetBPM : null;
  const records = Array.isArray(entry.metadata?.records) ? entry.metadata.records : [];
  return {
    id,
    exists: true,
    trained: records.length > 0,
    hasTarget: targetBpm !== null,
    targetBpm,
    reached: targetBpm !== null && authoredReachedTarget(entry, targetBpm),
  };
}

export function lessonLinks(lessonState, resolveExercise = null) {
  return (lessonState?.linkedExerciseIds ?? []).map(id => linkStatus(resolveExercise ? resolveExercise(id) : null, id));
}

export function lessonCompletion(lessonState, links = [], { hasSuggestions = false } = {}) {
  const override = lessonState?.completionOverride ?? null;
  if (override === 'complete') return { completed: true, automatic: false, override };
  if (override === 'reopened') return { completed: false, automatic: false, override };
  const satisfied = links.length > 0
    ? links.every(link => link.reached)
    : !hasSuggestions;
  const automatic = lessonState?.watched === true && satisfied;
  return { completed: automatic, automatic, override: null };
}

// Motivos de pendência, em ids estáveis (o texto fica com a interface).
export function lessonPending(lessonState, links = [], { hasSuggestions = false } = {}) {
  const reasons = [];
  if (lessonState?.completionOverride === 'reopened') reasons.push('reopened');
  if (lessonState?.watched !== true) reasons.push('not-watched');
  if (links.length === 0) {
    if (hasSuggestions) reasons.push('no-linked-exercise');
  } else {
    for (const link of links) {
      if (!link.exists) reasons.push('exercise-missing');
      else if (!link.hasTarget) reasons.push('exercise-without-target');
      else if (!link.reached) reasons.push('exercise-below-target');
    }
  }
  return [...new Set(reasons)];
}

export function lessonStatus(lessonState, links = [], { watchMs = 0, hasSuggestions = false } = {}) {
  if (lessonCompletion(lessonState, links, { hasSuggestions }).completed) return LESSON_STATUS.done;
  if (links.some(link => link.trained) || watchMs > 0) return LESSON_STATUS.practicing;
  if (lessonState?.watched === true) return LESSON_STATUS.watched;
  return LESSON_STATUS.notStarted;
}

function lessonRow(lesson, state, resolveExercise) {
  const lessonState = lessonStateOf(state, lesson.id);
  const links = lessonLinks(lessonState, resolveExercise);
  return { lesson, lessonState, links, hasSuggestions: (lesson.suggestedExercises?.length ?? 0) > 0 };
}

// Próxima aula: primeiro as obrigatórias na ordem do curso, depois as opcionais.
// Aulas puladas não bloqueiam nem são reapresentadas, e aulas removidas do
// curso não existem mais aqui (ficam no grupo próprio).
export function nextLesson(course, state, { resolveExercise = null } = {}) {
  const rows = courseLessons(course).map(lesson => lessonRow(lesson, state, resolveExercise));
  for (const optional of [false, true]) {
    const found = rows.find(row => row.lesson.optional === optional
      && !row.lessonState.skipped
      && lessonStatus(row.lessonState, row.links, { hasSuggestions: row.hasSuggestions }) !== LESSON_STATUS.done);
    if (found) {
      return {
        lesson: found.lesson,
        status: lessonStatus(found.lessonState, found.links, { hasSuggestions: found.hasSuggestions }),
        optional,
      };
    }
  }
  return null;
}

function unionSpans(spans) {
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = null;
  for (const [start, end] of spans) {
    if (cursor === null || start > cursor) { total += end - start; cursor = end; }
    else if (end > cursor) { total += end - cursor; cursor = end; }
  }
  return total;
}

// Tempo por aula também é UNIÃO: dois intervalos sobrepostos da mesma aula
// contam uma vez só, nunca duas.
export function groupWatchMs(intervals) {
  const spansByLesson = new Map();
  for (const interval of Array.isArray(intervals) ? intervals : []) {
    const start = Date.parse(interval?.startedAt);
    const end = Date.parse(interval?.endedAt);
    if (!isText(interval?.lessonId) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (!spansByLesson.has(interval.lessonId)) spansByLesson.set(interval.lessonId, []);
    spansByLesson.get(interval.lessonId).push([start, end]);
  }
  const totals = new Map();
  for (const [lessonId, spans] of spansByLesson) totals.set(lessonId, unionSpans(spans));
  return totals;
}

// Segunda-feira 00:00 local até o mesmo horário sete dias depois.
export function weekRange(now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  const day = (date.getDay() + 6) % 7;
  const start = date.getTime() - day * DAY_MS;
  return [start, start + WEEK_MS];
}

// Intervalos sobrepostos contam UMA vez: tempo de estudo é união, nunca soma
// bruta de intervalos repetidos.
export function unionWatchMs(intervals, fromMs, toMs) {
  const spans = [];
  for (const interval of Array.isArray(intervals) ? intervals : []) {
    const start = Date.parse(interval?.startedAt);
    const end = Date.parse(interval?.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const clippedStart = Math.max(start, fromMs);
    const clippedEnd = Math.min(end, toMs);
    if (clippedEnd > clippedStart) spans.push([clippedStart, clippedEnd]);
  }
  return unionSpans(spans);
}

// Estimativa de duração da aula: minutos arredondados para cima; sem vídeo, a
// estimativa é desconhecida (null) — a interface diz isso, não inventa número.
export function videoMinutes(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : null;
}

// Resumo completo do curso: contagens obrigatórias e opcionais SEPARADAS (para
// o progresso nunca ficar preso abaixo de 100% por causa de seminário).
export function courseSummary(course, state, { resolveExercise = null, now = Date.now } = {}) {
  const watchByLesson = groupWatchMs(state?.watch);
  const rows = courseLessons(course).map(lesson => {
    const row = lessonRow(lesson, state, resolveExercise);
    const watchMs = watchByLesson.get(lesson.id) ?? 0;
    return { ...row, watchMs, status: lessonStatus(row.lessonState, row.links, { watchMs, hasSuggestions: row.hasSuggestions }) };
  });
  const required = rows.filter(row => !row.lesson.optional);
  const optional = rows.filter(row => row.lesson.optional);
  const done = rows.filter(row => row.status === LESSON_STATUS.done).length;
  const [weekStart, weekEnd] = weekRange(now);
  return {
    rows,
    total: rows.length,
    requiredTotal: required.length,
    optionalTotal: optional.length,
    done,
    doneRequired: required.filter(row => row.status === LESSON_STATUS.done).length,
    doneOptional: optional.filter(row => row.status === LESSON_STATUS.done).length,
    weekMs: unionWatchMs(state?.watch, weekStart, weekEnd),
    watchMs: rows.reduce((total, row) => total + row.watchMs, 0),
    next: nextLesson(course, state, { resolveExercise }),
    removed: Array.isArray(state?.removed) ? state.removed.map(entry => ({ ...entry })) : [],
  };
}

// ---------------------------------------------- prática e assistir (A6)
//
// A sessão de hoje é feita de duas partes INDEPENDENTES:
//
//  - PRATICAR: exercícios das aulas JÁ ASSISTIDAS que ainda não chegaram ao
//    alvo, do mais antigo (antes no curso) para o mais novo, mais os exercícios
//    avulsos na folga. Uma aula assistida com exercícios sugeridos de receita
//    ainda não gerados oferece gerá-los (é o que alimenta a prática de hoje e
//    dos próximos dias).
//  - ASSISTIR: as próximas aulas do curso, quantas couberem no tempo que o
//    usuário indicar. Assistir várias de uma vez só aumenta a fila de prática
//    dos dias seguintes; nada é marcado como assistido automaticamente.
//
// `generatedSuggestionIds` é estado GRAVADO por aula: a sugestão gerada é
// lembrada pelo id, nunca por heurística sobre nomes.

// Sugestões de exercício de uma aula, com o que já foi gerado.
export function lessonSuggestions(lesson, lessonState) {
  const generated = new Set(normalizeLessonState(lessonState).generatedSuggestionIds);
  return (Array.isArray(lesson?.suggestedExercises) ? lesson.suggestedExercises : []).map(suggestion => ({
    suggestion,
    generatable: suggestion.recipe !== null && suggestion.recipe !== undefined,
    generated: generated.has(suggestion.id),
  }));
}

// Sugestões GERÁVEIS (com receita) que ainda não viraram exercício.
export function pendingSuggestions(lesson, lessonState) {
  return lessonSuggestions(lesson, lessonState).filter(item => item.generatable && !item.generated);
}

// Aulas ASSISTIDAS cuja prática ainda está em aberto, na ordem do curso (a mais
// antiga primeiro). Aula concluída sai da lista: a conclusão já exige todos os
// vínculos no alvo.
export function practiceLessons(course, state, { resolveExercise = null } = {}) {
  const result = [];
  courseLessons(course).forEach((lesson, position) => {
    const lessonState = lessonStateOf(state, lesson.id);
    if (lessonState.watched !== true) return;
    const links = lessonLinks(lessonState, resolveExercise);
    const hasSuggestions = (lesson.suggestedExercises?.length ?? 0) > 0;
    if (lessonCompletion(lessonState, links, { hasSuggestions }).completed) return;
    result.push({
      lesson,
      position,
      lessonState,
      links,
      pending: links.filter(link => !link.reached),
      suggestions: pendingSuggestions(lesson, lessonState),
    });
  });
  return result;
}

// Próximas aulas para ASSISTIR: primeiro as obrigatórias na ordem do curso,
// depois as opcionais (seminário e boas-vindas não bloqueiam), pulando as
// marcadas como puladas e as já assistidas.
export function assistLessons(course, state) {
  const rows = courseLessons(course).map((lesson, position) => ({ lesson, position, lessonState: lessonStateOf(state, lesson.id) }));
  const pending = rows.filter(row => row.lessonState.watched !== true && row.lessonState.skipped !== true);
  return [...pending.filter(row => !row.lesson.optional), ...pending.filter(row => row.lesson.optional)];
}

// Tempo de estudo por aula (união de intervalos sobrepostos).
export function lessonWatchByLesson(intervals) {
  return groupWatchMs(intervals);
}
