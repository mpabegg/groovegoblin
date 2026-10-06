// Formato de curso "groovegoblin-course" v1.
//
// Curso, progresso e vínculos ficam fora da sessão de estudo: aqui mora somente
// o catálogo (seções, aulas, materiais e sugestões de exercício). O conversor de
// mapas externos (scripts/convert-course-map.js) é tolerante e monta documentos
// deste formato; este módulo é a porta estrita usada pelo app para aceitar ou
// recusar um documento, apontando o caminho de cada campo reprovado.
//
// Regras do app respeitadas aqui: somente baixo de 4 ou 5 cordas, nenhum
// material de 6 cordas, nenhuma busca de rede e nenhum conteúdo de terceiros
// embutido. Avisos e erros citam apenas o caminho do campo, nunca valores do
// documento original (títulos, nomes de arquivo ou endereços).

export const COURSE_FORMAT = 'groovegoblin-course';
export const COURSE_VERSION = 1;

export const SECTION_TYPES = Object.freeze(['módulo', 'seminário', 'boas-vindas', 'outro']);
export const RESOURCE_ROLES = Object.freeze(['apostila', 'faixa', 'pacote de exercícios', 'outro']);
export const BASS_STRINGS = Object.freeze([4, 5]);

// Limites do documento: listas curtas o bastante para caber na Biblioteca e
// folgadas o bastante para um curso longo (200 aulas).
export const COURSE_LIMITS = Object.freeze({
  sections: 64,
  lessons: 200,
  lessonsPerSection: 200,
  resources: 64,
  exercises: 64,
  resourceRefs: 128,
  trackNames: 32,
  prerequisites: 16,
  techniques: 16,
  errors: 100,
  chars: 8 * 1024 * 1024,
  id: 128,
  title: 200,
  name: 160,
  label: 40,
  url: 2048,
  language: 35,
  extension: 8,
  shortText: 80,
  mediumText: 120,
  summary: 2000,
  bpmMin: 30,
  bpmMax: 300,
  barsMin: 1,
  barsMax: 64,
  dailyMinutesMin: 1,
  dailyMinutesMax: 600,
  videoSecondsMax: 86400,
  weekMin: 1,
  weekMax: 52,
  pdfPageMin: 1,
  pdfPageMax: 9999,
});

const BPM_RANGE = Object.freeze({ min: COURSE_LIMITS.bpmMin, max: COURSE_LIMITS.bpmMax });
const BARS_RANGE = Object.freeze({ min: COURSE_LIMITS.barsMin, max: COURSE_LIMITS.barsMax });
const BARS_PER_CHORD_RANGE = Object.freeze({ min: 1, max: 2 });
const WEEK_RANGE = Object.freeze({ min: COURSE_LIMITS.weekMin, max: COURSE_LIMITS.weekMax });
const VIDEO_RANGE = Object.freeze({ min: 0, max: COURSE_LIMITS.videoSecondsMax });
const DAILY_MINUTES_RANGE = Object.freeze({ min: COURSE_LIMITS.dailyMinutesMin, max: COURSE_LIMITS.dailyMinutesMax });
const PDF_PAGE_RANGE = Object.freeze({ min: COURSE_LIMITS.pdfPageMin, max: COURSE_LIMITS.pdfPageMax });

const DOCUMENT_KEYS = ['format', 'version', 'course', 'progress'];
const COURSE_KEYS = ['id', 'title', 'author', 'url', 'instrument', 'strings', 'language', 'dailyMinutes', 'summary', 'sections'];
const SECTION_KEYS = ['id', 'title', 'type', 'week', 'summary', 'objective', 'prerequisites', 'lessons'];
const LESSON_KEYS = [
  'id', 'title', 'url', 'type', 'videoSeconds', 'hasVideo', 'summary', 'practiceInstruction',
  'key', 'chordFormula', 'tuning', 'techniques', 'initialBpm', 'targetBpm',
  'resources', 'resourceRefs', 'suggestedExercises',
];
const RESOURCE_KEYS = ['id', 'name', 'extension', 'role', 'bpm', 'barsPerChord', 'style', 'extended', 'strings'];
const REF_KEYS = ['lessonId', 'resourceId'];
const EXERCISE_KEYS = ['id', 'title', 'description', 'initialBpm', 'targetBpm', 'bars', 'trackNames', 'pdfPage', 'strings'];
const PROGRESS_KEYS = ['watchedLessonIds'];

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathKey(path, key) {
  return path === '' ? key : `${path}.${key}`;
}

function isText(value, max) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max && !CONTROL_CHARS.test(value);
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > COURSE_LIMITS.url) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function createIssues() {
  return { errors: [], full: false };
}

function note(issues, path, code, message) {
  if (issues.errors.length >= COURSE_LIMITS.errors) {
    issues.full = true;
    return;
  }
  issues.errors.push({ path, code, message });
}

function failure(issues) {
  const errors = issues.errors.length > 0
    ? issues.errors
    : [{ path: '', code: 'documento', message: 'O documento do curso é inválido.' }];
  const first = errors[0];
  return {
    ok: false,
    error: first.path === '' ? first.message : `${first.message} (${first.path})`,
    errors,
    truncated: issues.full,
  };
}

function readKeys(value, allowed, path, issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) note(issues, pathKey(path, key), 'campo-desconhecido', 'Campo não previsto no formato do curso.');
  }
}

function reqText(source, key, path, max, issues) {
  const field = pathKey(path, key);
  if (!Object.hasOwn(source, key)) {
    note(issues, field, 'campo-obrigatorio', 'Campo obrigatório ausente.');
    return null;
  }
  return optText(source, key, path, max, issues);
}

function optText(source, key, path, max, issues) {
  if (!Object.hasOwn(source, key) || source[key] === null) return null;
  const field = pathKey(path, key);
  const value = source[key];
  if (!isText(value, max)) {
    note(issues, field, 'texto', `Esperado texto não vazio de até ${max} caracteres.`);
    return null;
  }
  return value.trim();
}

function reqBoolean(source, key, path, issues) {
  const field = pathKey(path, key);
  if (!Object.hasOwn(source, key)) {
    note(issues, field, 'campo-obrigatorio', 'Campo obrigatório ausente.');
    return null;
  }
  if (typeof source[key] !== 'boolean') {
    note(issues, field, 'booleano', 'Esperado verdadeiro ou falso.');
    return null;
  }
  return source[key];
}

function optBoolean(source, key, path, fallback, issues) {
  if (!Object.hasOwn(source, key) || source[key] === null) return fallback;
  if (typeof source[key] !== 'boolean') {
    note(issues, pathKey(path, key), 'booleano', 'Esperado verdadeiro ou falso.');
    return fallback;
  }
  return source[key];
}

function optInteger(source, key, path, range, issues, code = 'numero') {
  if (!Object.hasOwn(source, key) || source[key] === null) return null;
  const value = source[key];
  const field = pathKey(path, key);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    note(issues, field, code, `Esperado número inteiro entre ${range.min} e ${range.max}, ou nulo.`);
    return null;
  }
  return value;
}

// Só baixo de 4 ou 5 cordas entra no app; 6 cordas é reprovado com o caminho.
function optStrings(source, key, path, issues) {
  if (!Object.hasOwn(source, key) || source[key] === null) return null;
  const field = pathKey(path, key);
  if (!BASS_STRINGS.includes(source[key])) {
    note(issues, field, 'cordas', 'Este formato aceita somente baixo de 4 ou 5 cordas.');
    return null;
  }
  return source[key];
}

function optUrl(source, key, path, issues) {
  if (!Object.hasOwn(source, key) || source[key] === null) return null;
  const field = pathKey(path, key);
  if (!isHttpUrl(source[key])) {
    note(issues, field, 'url', 'Esperado um endereço http(s) ou nulo.');
    return null;
  }
  return source[key].trim();
}

function optExtension(source, key, path, issues) {
  if (!Object.hasOwn(source, key) || source[key] === null) return null;
  const field = pathKey(path, key);
  const value = source[key];
  if (typeof value !== 'string' || !/^[a-z0-9]{1,8}$/.test(value)) {
    note(issues, field, 'extensao', 'Esperada extensão de arquivo em minúsculas, de até 8 caracteres.');
    return null;
  }
  return value;
}

function readEnum(source, key, path, allowed, issues) {
  const field = pathKey(path, key);
  if (!Object.hasOwn(source, key)) {
    note(issues, field, 'campo-obrigatorio', 'Campo obrigatório ausente.');
    return null;
  }
  if (!allowed.includes(source[key])) {
    note(issues, field, 'valor', `Esperado um destes valores: ${allowed.join(', ')}.`);
    return null;
  }
  return source[key];
}

function reqList(source, key, path, limit, issues) {
  const field = pathKey(path, key);
  if (!Object.hasOwn(source, key)) {
    note(issues, field, 'campo-obrigatorio', 'Campo obrigatório ausente.');
    return [];
  }
  const value = source[key];
  if (!Array.isArray(value)) {
    note(issues, field, 'lista', 'Esperado uma lista.');
    return [];
  }
  if (value.length > limit) note(issues, field, 'limite', `A lista aceita no máximo ${limit} itens.`);
  return value.slice(0, limit);
}

function optList(source, key, path, limit, issues) {
  if (!Object.hasOwn(source, key) || source[key] === null) return [];
  return reqList(source, key, path, limit, issues);
}

function readTextList(source, key, path, { limit, max }, issues) {
  const field = pathKey(path, key);
  return optList(source, key, path, limit, issues).flatMap((item, index) => {
    if (typeof item !== 'string' || !isText(item, max)) {
      note(issues, `${field}[${index}]`, 'texto', `Esperado texto não vazio de até ${max} caracteres.`);
      return [];
    }
    return [item.trim()];
  });
}

function normalizeCourseBody(value, issues) {
  const path = 'course';
  const course = {
    id: null,
    title: null,
    author: null,
    url: null,
    instrument: 'bass',
    strings: null,
    language: null,
    dailyMinutes: null,
    summary: null,
    sections: [],
  };
  if (!isObject(value)) {
    note(issues, path, 'objeto', 'O curso deve ser um objeto.');
    return course;
  }
  readKeys(value, COURSE_KEYS, path, issues);
  course.id = reqText(value, 'id', path, COURSE_LIMITS.id, issues);
  course.title = reqText(value, 'title', path, COURSE_LIMITS.title, issues);
  course.author = optText(value, 'author', path, COURSE_LIMITS.title, issues);
  course.url = optUrl(value, 'url', path, issues);
  course.language = optText(value, 'language', path, COURSE_LIMITS.language, issues);
  course.dailyMinutes = optInteger(value, 'dailyMinutes', path, DAILY_MINUTES_RANGE, issues);
  course.summary = optText(value, 'summary', path, COURSE_LIMITS.summary, issues);
  if (!Object.hasOwn(value, 'instrument') || value.instrument === null) {
    note(issues, `${path}.instrument`, 'campo-obrigatorio', 'Campo obrigatório ausente.');
  } else if (value.instrument !== 'bass') {
    note(issues, `${path}.instrument`, 'instrumento', 'Este formato aceita somente baixo ("bass").');
  }
  course.strings = optStrings(value, 'strings', path, issues);
  if (course.strings === null && (value.strings === undefined || value.strings === null)) {
    note(issues, `${path}.strings`, 'campo-obrigatorio', 'Campo obrigatório ausente.');
  }
  course.sections = reqList(value, 'sections', path, COURSE_LIMITS.sections, issues)
    .map((section, index) => normalizeSection(section, `${path}.sections[${index}]`, issues));
  return course;
}

function normalizeSection(value, path, issues) {
  const section = {
    id: null,
    title: null,
    type: null,
    week: null,
    summary: null,
    objective: null,
    prerequisites: [],
    lessons: [],
  };
  if (!isObject(value)) {
    note(issues, path, 'objeto', 'A seção deve ser um objeto.');
    return section;
  }
  readKeys(value, SECTION_KEYS, path, issues);
  section.id = reqText(value, 'id', path, COURSE_LIMITS.id, issues);
  section.title = reqText(value, 'title', path, COURSE_LIMITS.title, issues);
  section.type = readEnum(value, 'type', path, SECTION_TYPES, issues);
  section.week = optInteger(value, 'week', path, WEEK_RANGE, issues);
  section.summary = optText(value, 'summary', path, COURSE_LIMITS.summary, issues);
  section.objective = optText(value, 'objective', path, COURSE_LIMITS.summary, issues);
  section.prerequisites = readTextList(value, 'prerequisites', path, { limit: COURSE_LIMITS.prerequisites, max: COURSE_LIMITS.mediumText }, issues);
  section.lessons = reqList(value, 'lessons', path, COURSE_LIMITS.lessonsPerSection, issues)
    .map((lesson, index) => normalizeLesson(lesson, `${path}.lessons[${index}]`, issues));
  return section;
}

function normalizeLesson(value, path, issues) {
  const lesson = {
    id: null,
    title: null,
    url: null,
    type: null,
    videoSeconds: null,
    hasVideo: null,
    summary: null,
    practiceInstruction: null,
    key: null,
    chordFormula: null,
    tuning: null,
    techniques: [],
    initialBpm: null,
    targetBpm: null,
    resources: [],
    resourceRefs: [],
    suggestedExercises: [],
  };
  if (!isObject(value)) {
    note(issues, path, 'objeto', 'A aula deve ser um objeto.');
    return lesson;
  }
  readKeys(value, LESSON_KEYS, path, issues);
  lesson.id = reqText(value, 'id', path, COURSE_LIMITS.id, issues);
  lesson.title = reqText(value, 'title', path, COURSE_LIMITS.title, issues);
  lesson.url = optUrl(value, 'url', path, issues);
  lesson.type = reqText(value, 'type', path, COURSE_LIMITS.label, issues);
  lesson.videoSeconds = optInteger(value, 'videoSeconds', path, VIDEO_RANGE, issues);
  lesson.hasVideo = reqBoolean(value, 'hasVideo', path, issues);
  lesson.summary = optText(value, 'summary', path, COURSE_LIMITS.summary, issues);
  lesson.practiceInstruction = optText(value, 'practiceInstruction', path, COURSE_LIMITS.summary, issues);
  lesson.key = optText(value, 'key', path, COURSE_LIMITS.shortText, issues);
  lesson.chordFormula = optText(value, 'chordFormula', path, COURSE_LIMITS.shortText, issues);
  lesson.tuning = optText(value, 'tuning', path, COURSE_LIMITS.shortText, issues);
  lesson.techniques = readTextList(value, 'techniques', path, { limit: COURSE_LIMITS.techniques, max: COURSE_LIMITS.shortText }, issues);
  lesson.initialBpm = optInteger(value, 'initialBpm', path, BPM_RANGE, issues);
  lesson.targetBpm = optInteger(value, 'targetBpm', path, BPM_RANGE, issues);
  if (lesson.hasVideo === false && lesson.videoSeconds !== null) {
    note(issues, `${path}.videoSeconds`, 'video', 'Uma aula com duração de vídeo deve indicar hasVideo verdadeiro.');
  }
  lesson.resources = reqList(value, 'resources', path, COURSE_LIMITS.resources, issues)
    .map((resource, index) => normalizeResource(resource, `${path}.resources[${index}]`, issues));
  lesson.resourceRefs = reqList(value, 'resourceRefs', path, COURSE_LIMITS.resourceRefs, issues)
    .map((ref, index) => normalizeRef(ref, `${path}.resourceRefs[${index}]`, issues));
  lesson.suggestedExercises = reqList(value, 'suggestedExercises', path, COURSE_LIMITS.exercises, issues)
    .map((exercise, index) => normalizeExercise(exercise, `${path}.suggestedExercises[${index}]`, issues));
  return lesson;
}

function normalizeResource(value, path, issues) {
  const resource = {
    id: null,
    name: null,
    extension: null,
    role: null,
    bpm: null,
    barsPerChord: null,
    style: null,
    extended: false,
    strings: null,
  };
  if (!isObject(value)) {
    note(issues, path, 'objeto', 'O recurso deve ser um objeto.');
    return resource;
  }
  readKeys(value, RESOURCE_KEYS, path, issues);
  resource.id = reqText(value, 'id', path, COURSE_LIMITS.id, issues);
  resource.name = reqText(value, 'name', path, COURSE_LIMITS.name, issues);
  resource.extension = optExtension(value, 'extension', path, issues);
  resource.role = readEnum(value, 'role', path, RESOURCE_ROLES, issues);
  resource.bpm = optInteger(value, 'bpm', path, BPM_RANGE, issues);
  resource.barsPerChord = optInteger(value, 'barsPerChord', path, BARS_PER_CHORD_RANGE, issues);
  resource.style = optText(value, 'style', path, COURSE_LIMITS.name, issues);
  resource.extended = optBoolean(value, 'extended', path, false, issues);
  resource.strings = optStrings(value, 'strings', path, issues);
  return resource;
}

function normalizeRef(value, path, issues) {
  const ref = { lessonId: null, resourceId: null };
  if (!isObject(value)) {
    note(issues, path, 'objeto', 'A referência de recurso deve ser um objeto.');
    return ref;
  }
  readKeys(value, REF_KEYS, path, issues);
  ref.lessonId = reqText(value, 'lessonId', path, COURSE_LIMITS.id, issues);
  ref.resourceId = reqText(value, 'resourceId', path, COURSE_LIMITS.id, issues);
  return ref;
}

function normalizeExercise(value, path, issues) {
  const exercise = {
    id: null,
    title: null,
    description: null,
    initialBpm: null,
    targetBpm: null,
    bars: null,
    trackNames: [],
    pdfPage: null,
    strings: null,
  };
  if (!isObject(value)) {
    note(issues, path, 'objeto', 'A sugestão de exercício deve ser um objeto.');
    return exercise;
  }
  readKeys(value, EXERCISE_KEYS, path, issues);
  exercise.id = reqText(value, 'id', path, COURSE_LIMITS.id, issues);
  exercise.title = reqText(value, 'title', path, COURSE_LIMITS.title, issues);
  exercise.description = optText(value, 'description', path, COURSE_LIMITS.summary, issues);
  exercise.initialBpm = optInteger(value, 'initialBpm', path, BPM_RANGE, issues);
  exercise.targetBpm = optInteger(value, 'targetBpm', path, BPM_RANGE, issues);
  exercise.bars = optInteger(value, 'bars', path, BARS_RANGE, issues);
  exercise.trackNames = readTextList(value, 'trackNames', path, { limit: COURSE_LIMITS.trackNames, max: COURSE_LIMITS.name }, issues);
  exercise.pdfPage = optInteger(value, 'pdfPage', path, PDF_PAGE_RANGE, issues);
  exercise.strings = optStrings(value, 'strings', path, issues);
  return exercise;
}

function normalizeProgress(value, issues) {
  const progress = { watchedLessonIds: [] };
  if (value === undefined || value === null) return progress;
  const path = 'progress';
  if (!isObject(value)) {
    note(issues, path, 'objeto', 'O progresso deve ser um objeto.');
    return progress;
  }
  readKeys(value, PROGRESS_KEYS, path, issues);
  if (!Object.hasOwn(value, 'watchedLessonIds') || value.watchedLessonIds === null) return progress;
  const ids = optList(value, 'watchedLessonIds', path, COURSE_LIMITS.lessons, issues);
  progress.watchedLessonIds = ids.flatMap((id, index) => {
    if (typeof id !== 'string' || id.trim() === '' || id.length > COURSE_LIMITS.id) {
      note(issues, `${path}.watchedLessonIds[${index}]`, 'texto', 'Esperado um identificador de aula.');
      return [];
    }
    return [id];
  });
  return progress;
}

function lessonsOf(course) {
  const entries = [];
  for (const [sectionIndex, section] of course.sections.entries()) {
    for (const [lessonIndex, lesson] of section.lessons.entries()) {
      entries.push({ lesson, path: `course.sections[${sectionIndex}].lessons[${lessonIndex}]` });
    }
  }
  return entries;
}

// Unicidade e referências são verificadas depois da leitura: assim uma aula
// pode apontar para o recurso de outra aula (material do mesmo módulo).
function checkReferences(document, progress, issues) {
  const { course } = document;
  const entries = lessonsOf(course);
  if (entries.length > COURSE_LIMITS.lessons) {
    note(issues, 'course.sections', 'limite', `O curso aceita no máximo ${COURSE_LIMITS.lessons} aulas.`);
  }
  const sectionIds = new Set();
  const lessonsById = new Map();
  for (const { lesson, path } of entries) {
    if (lesson.id === null) continue;
    if (lessonsById.has(lesson.id)) note(issues, `${path}.id`, 'id-repetido', 'Identificador de aula repetido no curso.');
    else lessonsById.set(lesson.id, lesson);
  }
  for (const [sectionIndex, section] of course.sections.entries()) {
    const sectionPath = `course.sections[${sectionIndex}]`;
    if (section.id !== null) {
      if (sectionIds.has(section.id)) note(issues, `${sectionPath}.id`, 'id-repetido', 'Identificador de seção repetido no curso.');
      else sectionIds.add(section.id);
    }
    for (const [lessonIndex, lesson] of section.lessons.entries()) {
      const lessonPath = `${sectionPath}.lessons[${lessonIndex}]`;
      const resourceIds = new Set();
      for (const [resourceIndex, resource] of lesson.resources.entries()) {
        if (resource.id === null) continue;
        if (resourceIds.has(resource.id)) note(issues, `${lessonPath}.resources[${resourceIndex}].id`, 'id-repetido', 'Identificador de recurso repetido na aula.');
        else resourceIds.add(resource.id);
      }
      const exerciseIds = new Set();
      for (const [exerciseIndex, exercise] of lesson.suggestedExercises.entries()) {
        if (exercise.id === null) continue;
        if (exerciseIds.has(exercise.id)) note(issues, `${lessonPath}.suggestedExercises[${exerciseIndex}].id`, 'id-repetido', 'Identificador de exercício repetido na aula.');
        else exerciseIds.add(exercise.id);
      }
      const seenRefs = new Set();
      for (const [refIndex, ref] of lesson.resourceRefs.entries()) {
        const refPath = `${lessonPath}.resourceRefs[${refIndex}]`;
        if (ref.lessonId !== null && ref.resourceId !== null) {
          const pair = `${ref.lessonId}\u0000${ref.resourceId}`;
          if (seenRefs.has(pair)) note(issues, refPath, 'referencia-repetida', 'Referência de recurso repetida na aula.');
          seenRefs.add(pair);
        }
        if (ref.lessonId === null || ref.resourceId === null) continue;
        const target = lessonsById.get(ref.lessonId);
        if (target === undefined) {
          note(issues, `${refPath}.lessonId`, 'referencia-quebrada', 'A referência aponta para uma aula que não existe no curso.');
        } else if (!target.resources.some((resource) => resource.id === ref.resourceId)) {
          note(issues, `${refPath}.resourceId`, 'referencia-quebrada', 'A referência aponta para um recurso que não existe na aula indicada.');
        }
      }
    }
  }
  const watched = new Set();
  for (const [index, id] of progress.watchedLessonIds.entries()) {
    if (watched.has(id)) note(issues, `progress.watchedLessonIds[${index}]`, 'id-repetido', 'Aula repetida nas marcações de progresso.');
    watched.add(id);
    if (!lessonsById.has(id)) note(issues, `progress.watchedLessonIds[${index}]`, 'referencia-quebrada', 'A marcação aponta para uma aula que não existe no curso.');
  }
}

// Valida e canoniza um documento de curso. Devolve uma cópia nova (nunca muta
// a entrada) com todos os campos documentados preenchidos: o que era opcional
// vira nulo, lista vazia ou falso. Erros trazem caminho de campo.
export function normalizeCourse(value) {
  const issues = createIssues();
  if (!isObject(value)) {
    note(issues, '', 'documento', 'O documento do curso deve ser um objeto.');
    return failure(issues);
  }
  readKeys(value, DOCUMENT_KEYS, '', issues);
  if (value.format !== COURSE_FORMAT) note(issues, 'format', 'formato', 'O documento não está no formato de curso do GrooveGoblin.');
  if (value.version !== COURSE_VERSION) note(issues, 'version', 'versao', 'A versão do documento de curso não é compatível.');
  const course = normalizeCourseBody(value.course, issues);
  const progress = normalizeProgress(value.progress, issues);
  const document = { format: COURSE_FORMAT, version: COURSE_VERSION, course };
  // O progresso é opcional no formato: só entra no documento canônico quando o
  // documento de origem o traz. É o que mantém "sem progresso" significando
  // "nenhuma aula assistida" em vez de "progresso desconhecido".
  if (Object.hasOwn(value, 'progress') && value.progress !== null) document.progress = progress;
  checkReferences(document, progress, issues);
  if (issues.errors.length > 0) return failure(issues);
  return { ok: true, document };
}

// Lê o texto JSON de um curso. Erros de sintaxe não expõem detalhes internos do
// parser: a mensagem é a mesma para qualquer JSON malformado.
export function parseCourse(text) {
  if (typeof text !== 'string') {
    return failure(withNote('', 'texto', 'O conteúdo do curso deve ser um texto JSON.'));
  }
  if (text.length > COURSE_LIMITS.chars) {
    return failure(withNote('', 'limite', 'O arquivo do curso é grande demais.'));
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return failure(withNote('', 'json', 'Não foi possível ler o arquivo: o JSON é inválido.'));
  }
  return normalizeCourse(value);
}

function withNote(path, code, message) {
  const issues = createIssues();
  note(issues, path, code, message);
  return issues;
}

// Documento canônico em JSON (2 espaços, quebra de linha final) ou os erros de
// validação. Não grava nada: quem decide onde salvar é o chamador.
export function serializeCourse(document) {
  const normalized = normalizeCourse(document);
  if (!normalized.ok) return { ok: false, error: normalized.error, errors: normalized.errors, truncated: normalized.truncated };
  return { ok: true, document: normalized.document, text: `${JSON.stringify(normalized.document, null, 2)}\n` };
}
