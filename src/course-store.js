// Cursos importados na Biblioteca (rodada 5, etapa 5).
//
// Um curso é um documento `groovegoblin-course` v1 validado pelo normalizador
// ESTRITO (course-format.js) e guardado em um IndexedDB próprio — nunca dentro
// da sessão e nunca na biblioteca de exercícios. Estrutura e ESTADO vivem em
// registros separados, para a reimportação do MESMO courseID atualizar a
// estrutura sem perder progresso, anotações nem vínculos: aulas que somem viram
// tombstones acessíveis ("Removidas do curso") e voltam com o estado intacto se
// reaparecerem em um mapa novo.
//
// Sem IndexedDB a loja NÃO finge persistência: `persistent` é false, o motivo
// fica visível e toda escrita é recusada (importar e marcar aula não são
// aceitos "só na memória"). O estado em memória nunca é atualizado antes de a
// gravação confirmar — quota negada mantém os registros anteriores.
//
// NENHUM estado já salvo é cortado em silêncio. O documento de ENTRADA tem
// limite de aulas (course-format.js) e é isso que ele limita: tombstones,
// anotações, vínculos, overrides e histórico de estudo guardados são
// preservados por inteiro, mesmo que reimportações acumulem centenas de aulas
// removidas ou anos de intervalos. Registro ilegível continua recuperável
// (`corrupt()`), nunca é sobrescrito para "corrigir".
//
// As mutações são SERIALIZADAS dentro da instância: cada uma lê o estado
// depois de a escrita anterior confirmar, então duas escritas simultâneas de
// campos diferentes não se sobrescrevem (sem lost update). A memória só muda
// DEPOIS do commit, e uma falha (quota, banco indisponível) rejeita só aquela
// operação — sem retry automático, sem sucesso falso e sem travar as mutações
// seguintes.
//
// Registros (ver local://round5-course-store-api.md):
//
//   courses  { id, importedAt, updatedAt, source, counts, course: <course v1> }
//   states   { courseId, createdAt, updatedAt, activeLessonId, lessons:
//              { [lessonId]: LessonState }, removed: [Tombstone],
//              watch: [WatchInterval] }
//
//   LessonState    { watched, skipped, completionOverride, notes,
//                    linkedExerciseIds, updatedAt }
//   Tombstone      { id, title, type, sectionId, sectionTitle, removedAt, state }
//   WatchInterval  { id, lessonId, startedAt, endedAt, ms }

import { COURSE_FORMAT, COURSE_VERSION, normalizeCourse, parseCourse, serializeCourse, COURSE_LIMITS } from './course-format.js';
import { COMPLETION_OVERRIDES, courseLessons, courseSummary, normalizeLessonState } from './course-progress.js';

export const COURSE_DB_NAME = 'groovegoblin-courses';
export const COURSE_DB_VERSION = 1;
// Chave física de cada armazenamento: o curso é chaveado pelo id do documento e
// o estado pelo courseId — por isso os dois registros são objetos distintos,
// sem duplicar o id do curso dentro do estado.
export const COURSE_STORE_KEY_PATHS = Object.freeze({ courses: 'id', states: 'courseId' });
export const COURSE_STORE_NAMES = Object.freeze(Object.keys(COURSE_STORE_KEY_PATHS));
export const COURSE_SCHEMA_VERSION = 1;

export class CourseStorageError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'CourseStorageError';
    this.code = code;
    this.cause = cause;
  }
}

export function describeCourseStorageError(error) {
  if (error instanceof CourseStorageError) return error;
  const name = error?.name ?? '';
  if (name === 'QuotaExceededError' || /quota/i.test(error?.message ?? '')) {
    return new CourseStorageError('quota', 'O espaço local do navegador acabou. Os cursos e o progresso já salvos continuam intactos; libere espaço removendo um curso antes de importar de novo.', error);
  }
  if (name === 'InvalidStateError' || name === 'UnknownError') {
    return new CourseStorageError('unavailable', 'O banco de cursos do navegador ficou indisponível (aba privada, limpeza de dados ou erro interno). Nada foi gravado.', error);
  }
  if (name === 'VersionError') {
    return new CourseStorageError('version', 'O banco de cursos foi criado por uma versão mais nova do GrooveGoblin. Atualize a página ou o aplicativo.', error);
  }
  return new CourseStorageError('unknown', `Falha ao acessar o armazenamento dos cursos: ${error?.message || name || 'erro desconhecido'}.`, error);
}

export const COURSES_UNAVAILABLE_MESSAGE = 'Este navegador não oferece IndexedDB. Importar cursos está indisponível e nada seria salvo — por isso a loja recusa a gravação.';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

// Dicionário de aulas: as chaves são ids ARBITRÁRIOS do documento/backup
// (`__proto__`, `constructor` e `toString` são ids válidos). Num objeto comum,
// `dict['__proto__'] = valor` cai no ACESSOR do protótipo: o estado some do
// JSON, do structuredClone e da releitura. Por isso toda gravação é uma
// propriedade PRÓPRIA e enumerável (e toda leitura por id passa por entryOf).
function lessonDict(entries = null) {
  const dict = {};
  for (const [id, value] of Object.entries(entries ?? {})) setEntry(dict, id, value);
  return dict;
}

function setEntry(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  return target;
}

// Leitura SEGURA por id arbitrário: só a propriedade PRÓPRIA conta — sem isso,
// uma aula chamada `__proto__` responderia com o protótipo do dicionário.
function entryOf(dict, key) {
  return dict && Object.hasOwn(dict, key) ? dict[key] : undefined;
}

function defaultUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `cur-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isoNow() {
  return new Date().toISOString();
}

function uniqueTexts(values) {
  const list = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (!isText(value) || list.includes(value)) continue;
    list.push(value);
  }
  return list;
}

function normalizeWatch(value) {
  const intervals = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const startedAt = isText(raw?.startedAt) ? raw.startedAt : null;
    const endedAt = isText(raw?.endedAt) ? raw.endedAt : null;
    const start = Date.parse(startedAt ?? '');
    const end = Date.parse(endedAt ?? '');
    if (!isText(raw?.lessonId) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    intervals.push({
      id: isText(raw.id) ? raw.id : `${raw.lessonId}:${startedAt}`,
      lessonId: raw.lessonId,
      startedAt,
      endedAt,
      ms: end - start,
    });
  }
  return intervals;
}

function normalizeTombstone(value) {
  if (!isObject(value) || !isText(value.id)) return null;
  return {
    id: value.id,
    title: isText(value.title) ? value.title : value.id,
    type: isText(value.type) ? value.type : null,
    sectionId: isText(value.sectionId) ? value.sectionId : null,
    sectionTitle: isText(value.sectionTitle) ? value.sectionTitle : null,
    removedAt: isText(value.removedAt) ? value.removedAt : null,
    state: normalizeLessonState(value.state),
  };
}

function coursePreferences(value) {
  const minutes = value?.dailyMinutes;
  return {
    active: value?.active !== false,
    dailyMinutes: Number.isInteger(minutes) && minutes >= COURSE_LIMITS.dailyMinutesMin
      && minutes <= COURSE_LIMITS.dailyMinutesMax ? minutes : null,
  };
}

export function normalizeCourseState(value, courseId) {
  if (!isObject(value)) return null;
  const lessons = lessonDict();
  if (isObject(value.lessons)) {
    for (const [id, raw] of Object.entries(value.lessons)) {
      if (isText(id)) setEntry(lessons, id, normalizeLessonState(raw));
    }
  }
  const removed = (Array.isArray(value.removed) ? value.removed : []).map(normalizeTombstone).filter(Boolean);
  return {
    courseId,
    createdAt: isText(value.createdAt) ? value.createdAt : null,
    updatedAt: isText(value.updatedAt) ? value.updatedAt : null,
    activeLessonId: isText(value.activeLessonId) ? value.activeLessonId : null,
    preferences: coursePreferences(value.preferences),
    lessons,
    // Estado salvo é preservado por inteiro: nem tombstones nem histórico de
    // estudo são cortados aqui (só registro inválido fica de fora).
    removed,
    watch: normalizeWatch(value.watch),
  };
}

export function normalizeCourseRecord(value) {
  if (!isObject(value) || !isText(value.id) || !isObject(value.course) || !Array.isArray(value.course.sections)) return null;
  const lessons = courseLessons(value.course);
  return {
    id: value.id,
    importedAt: isText(value.importedAt) ? value.importedAt : null,
    updatedAt: isText(value.updatedAt) ? value.updatedAt : null,
    source: isText(value.source) ? value.source : null,
    counts: {
      sections: value.course.sections.length,
      lessons: lessons.length,
      resources: lessons.reduce((total, lesson) => total + (lesson.resources?.length ?? 0), 0),
      exercises: lessons.reduce((total, lesson) => total + (lesson.suggestedExercises?.length ?? 0), 0),
    },
    course: clone(value.course),
  };
}

// Reimportação: a estrutura nova entra inteira e o estado antigo é
// redistribuído — aulas que continuam PRESERVAM tudo; aulas que sumiram viram
// tombstones; tombstones que reaparecem VOLTAM com o estado que tinham.
export function mergeCourseState(previousState, previousCourse, nextCourse, { now = isoNow() } = {}) {
  const previous = normalizeCourseState(previousState, nextCourse?.id ?? null)
    ?? { courseId: nextCourse?.id ?? null, createdAt: null, updatedAt: null, activeLessonId: null, lessons: lessonDict(), removed: [], watch: [] };
  const nextLessons = courseLessons(nextCourse);
  const nextIds = new Set(nextLessons.map(lesson => lesson.id));
  const lessons = lessonDict();
  let preserved = 0;
  for (const [id, lessonState] of Object.entries(previous.lessons)) {
    if (!nextIds.has(id)) continue;
    setEntry(lessons, id, { ...lessonState });
    preserved += 1;
  }
  const removed = [];
  const tombstones = new Map(previous.removed.map(entry => [entry.id, entry]));
  let restored = 0;
  for (const tombstone of previous.removed) {
    if (!nextIds.has(tombstone.id)) { removed.push(tombstone); continue; }
    setEntry(lessons, tombstone.id, { ...tombstone.state });
    tombstones.delete(tombstone.id);
    restored += 1;
  }
  // Aulas do curso ANTERIOR que não existem mais: tombstone com snapshot da
  // estrutura em que viviam (mesmo sem nenhum estado gravado, para continuarem
  // acessíveis e poderem voltar completas).
  const previousLessons = new Map(courseLessons(previousCourse).map(lesson => [lesson.id, lesson]));
  let removedOut = 0;
  for (const [id, lesson] of previousLessons) {
    if (nextIds.has(id) || tombstones.has(id)) continue;
    removed.push({
      id,
      title: lesson.title ?? id,
      type: lesson.type ?? null,
      sectionId: lesson.sectionId ?? null,
      sectionTitle: lesson.sectionTitle ?? null,
      removedAt: now,
      state: normalizeLessonState(entryOf(previous.lessons, id)),
    });
    removedOut += 1;
  }
  return {
    state: {
      courseId: nextCourse?.id ?? null,
      createdAt: previous.createdAt ?? now,
      updatedAt: now,
      activeLessonId: nextIds.has(previous.activeLessonId) ? previous.activeLessonId : null,
      preferences: coursePreferences(previous.preferences),
      lessons,
      // TODOS os tombstones ficam guardados: o limite de aulas vale para o
      // documento importado, nunca para o estado que o usuário já construiu.
      removed,
      watch: previous.watch,
    },
    counts: { preserved, restored, removed: removedOut },
  };
}

// ------------------------------------------------------------------ backup
//
// A exportação agregada (etapa 7) precisa do retrato COMPLETO da loja: todos os
// cursos, TODOS os estados (inclusive os órfãos que sobraram de um removeCourse,
// que list()/get() não expõem) e os registros ilegíveis guardados crus. A
// importação valida o retrato INTEIRO antes da primeira gravação, recusa colidir
// com um registro ilegível (nunca sobrescreve o que não consegue ler) e grava
// cada par curso+estado numa transação só.
//
// Política de fusão (documentada em local://round5-backup-api.md):
//  - o curso que JÁ existe mantém a ESTRUTURA atual (o backup não é "Reimportar
//    curso"); a estrutura do backup só serve de catálogo para tombstones;
//  - aula que só existe no backup vira tombstone com snapshot, e progresso de
//    aula que o curso atual não tem também vai para o tombstone;
//  - aula que reaparece (tombstone atual presente na estrutura) volta com o
//    estado guardado;
//  - valores atuais explícitos vencem: `watched`/`skipped` NUNCA desmarcam,
//    `completionOverride` atual não é substituído quando existe;
//  - anotações diferentes não substituem o texto atual: entram como bloco
//    adicional (separador estável, reimportar não duplica);
//  - vínculos, tombstones e intervalos de estudo são UNIÃO sem duplicatas;
//  - `preferences.dailyMinutes` atual (null = "usa o arquivo") cede só quando
//    indefinido; `active` atual vence.

// Separador estável do bloco de anotações importado. Reimportar o mesmo backup
// não duplica o bloco porque o texto recebido é procurado como bloco antes de
// anexar.
export const IMPORTED_NOTES_SEPARATOR = '\n\n— importado de backup —\n';

const LESSON_STATE_KEYS = Object.freeze(['watched', 'skipped', 'completionOverride', 'notes', 'linkedExerciseIds', 'updatedAt']);
const STATE_KEYS = Object.freeze(['courseId', 'createdAt', 'updatedAt', 'activeLessonId', 'preferences', 'lessons', 'removed', 'watch']);
const TOMBSTONE_KEYS = Object.freeze(['id', 'title', 'type', 'sectionId', 'sectionTitle', 'removedAt', 'state']);
const WATCH_KEYS = Object.freeze(['id', 'lessonId', 'startedAt', 'endedAt', 'ms']);
const PREFERENCE_KEYS = Object.freeze(['active', 'dailyMinutes']);
const SNAPSHOT_RECORD_KEYS = Object.freeze(['id', 'importedAt', 'updatedAt', 'source', 'counts', 'course']);

function snapshotIssue(errors, path, code, message) {
  errors.push({ path, code, message });
}

function rejectUnknownKeys(source, allowed, path, errors) {
  for (const key of Object.keys(source)) {
    if (allowed.includes(key)) continue;
    snapshotIssue(errors, path === '' ? key : `${path}.${key}`, 'campo', `Campo desconhecido neste ponto do backup: ${key}.`);
  }
}

function validateOptionalText(value, path, key, errors) {
  if (!Object.hasOwn(value, key) || value[key] === null) return;
  if (!isText(value[key])) snapshotIssue(errors, `${path}.${key}`, 'texto', `${key} deve ser texto ou nulo.`);
}

// Estado de aula ESTRITO: campo desconhecido, tipo errado ou override fora da
// lista reprovam o backup inteiro — nada é truncado em silêncio.
function validateLessonStateShape(value, path, errors) {
  if (!isObject(value)) {
    snapshotIssue(errors, path, 'estado', 'O estado da aula deve ser um objeto.');
    return;
  }
  rejectUnknownKeys(value, LESSON_STATE_KEYS, path, errors);
  for (const key of ['watched', 'skipped']) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') snapshotIssue(errors, `${path}.${key}`, 'booleano', `${key} deve ser booleano.`);
  }
  if (Object.hasOwn(value, 'completionOverride') && !COMPLETION_OVERRIDES.includes(value.completionOverride)) {
    snapshotIssue(errors, `${path}.completionOverride`, 'override', 'Override de conclusão inválido.');
  }
  if (Object.hasOwn(value, 'notes') && typeof value.notes !== 'string') snapshotIssue(errors, `${path}.notes`, 'texto', 'notes deve ser texto.');
  if (Object.hasOwn(value, 'linkedExerciseIds') && (!Array.isArray(value.linkedExerciseIds) || value.linkedExerciseIds.some(id => !isText(id)))) {
    snapshotIssue(errors, `${path}.linkedExerciseIds`, 'vinculos', 'linkedExerciseIds deve ser uma lista de identificadores.');
  }
  validateOptionalText(value, path, 'updatedAt', errors);
}

function validateWatchShape(value, path, errors) {
  if (!Array.isArray(value)) {
    snapshotIssue(errors, path, 'estrutura', 'watch deve ser uma lista de intervalos.');
    return;
  }
  value.forEach((raw, index) => {
    const item = `${path}[${index}]`;
    if (!isObject(raw)) {
      snapshotIssue(errors, item, 'intervalo', 'Cada intervalo de estudo deve ser um objeto.');
      return;
    }
    rejectUnknownKeys(raw, WATCH_KEYS, item, errors);
    if (!isText(raw.lessonId)) snapshotIssue(errors, `${item}.lessonId`, 'aula', 'O intervalo precisa da aula.');
    validateOptionalText(raw, item, 'id', errors);
    const start = Date.parse(isText(raw.startedAt) ? raw.startedAt : '');
    const end = Date.parse(isText(raw.endedAt) ? raw.endedAt : '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      snapshotIssue(errors, item, 'intervalo', 'O intervalo de estudo precisa de início e fim válidos, com fim depois do início.');
    }
    if (raw.ms !== undefined && raw.ms !== null && !Number.isFinite(raw.ms)) snapshotIssue(errors, `${item}.ms`, 'numero', 'ms deve ser numérico.');
  });
}

function validateTombstoneShape(raw, path, errors) {
  if (!isObject(raw)) {
    snapshotIssue(errors, path, 'tombstone', 'Cada aula removida deve ser um objeto.');
    return;
  }
  rejectUnknownKeys(raw, TOMBSTONE_KEYS, path, errors);
  if (!isText(raw.id)) snapshotIssue(errors, `${path}.id`, 'aula', 'A aula removida precisa de id.');
  for (const key of ['title', 'type', 'sectionId', 'sectionTitle', 'removedAt']) validateOptionalText(raw, path, key, errors);
  if (Object.hasOwn(raw, 'state')) validateLessonStateShape(raw.state, `${path}.state`, errors);
}

function validateStateShape(raw, path, errors) {
  if (!isObject(raw)) {
    snapshotIssue(errors, path, 'estado', 'O estado do curso deve ser um objeto.');
    return;
  }
  rejectUnknownKeys(raw, STATE_KEYS, path, errors);
  if (!isText(raw.courseId)) snapshotIssue(errors, `${path}.courseId`, 'curso', 'O estado precisa do identificador do curso.');
  for (const key of ['createdAt', 'updatedAt', 'activeLessonId']) validateOptionalText(raw, path, key, errors);
  if (Object.hasOwn(raw, 'preferences') && raw.preferences !== null) {
    if (!isObject(raw.preferences)) {
      snapshotIssue(errors, `${path}.preferences`, 'preferencias', 'As preferências do curso devem ser um objeto.');
    } else {
      rejectUnknownKeys(raw.preferences, PREFERENCE_KEYS, `${path}.preferences`, errors);
      if (Object.hasOwn(raw.preferences, 'active') && typeof raw.preferences.active !== 'boolean') {
        snapshotIssue(errors, `${path}.preferences.active`, 'booleano', 'active deve ser booleano.');
      }
      const minutes = raw.preferences.dailyMinutes;
      if (Object.hasOwn(raw.preferences, 'dailyMinutes') && minutes !== null
        && (!Number.isInteger(minutes) || minutes < COURSE_LIMITS.dailyMinutesMin || minutes > COURSE_LIMITS.dailyMinutesMax)) {
        snapshotIssue(errors, `${path}.preferences.dailyMinutes`, 'numero', `Minutos por dia devem ficar entre ${COURSE_LIMITS.dailyMinutesMin} e ${COURSE_LIMITS.dailyMinutesMax}.`);
      }
    }
  }
  if (Object.hasOwn(raw, 'lessons')) {
    if (!isObject(raw.lessons)) {
      snapshotIssue(errors, `${path}.lessons`, 'estrutura', 'lessons deve ser um mapa de estado por aula.');
    } else {
      for (const [id, state] of Object.entries(raw.lessons)) {
        if (!isText(id)) snapshotIssue(errors, `${path}.lessons`, 'aula', 'Toda chave de lessons precisa ser um identificador de aula.');
        else validateLessonStateShape(state, `${path}.lessons.${id}`, errors);
      }
    }
  }
  if (Object.hasOwn(raw, 'removed')) {
    if (!Array.isArray(raw.removed)) snapshotIssue(errors, `${path}.removed`, 'estrutura', 'removed deve ser uma lista.');
    else raw.removed.forEach((entry, index) => validateTombstoneShape(entry, `${path}.removed[${index}]`, errors));
  }
  if (Object.hasOwn(raw, 'watch')) validateWatchShape(raw.watch, `${path}.watch`, errors);
}

// Retrato aceito (estrutura + catálogo canônico). Só a ESTRUTURA é validada
// aqui: o merge com o que já existe acontece depois, dentro da fila de escrita.
export function validateSnapshot(snapshot) {
  const errors = [];
  if (!isObject(snapshot)) {
    snapshotIssue(errors, '', 'snapshot', 'O retrato de cursos deve ser um objeto.');
    return { ok: false, errors, records: [], states: [] };
  }
  const rawRecords = Array.isArray(snapshot.records) ? snapshot.records : Array.isArray(snapshot.courses) ? snapshot.courses : null;
  if (!rawRecords) snapshotIssue(errors, 'courses.records', 'estrutura', 'O retrato precisa da lista de cursos.');
  const rawStates = Array.isArray(snapshot.states) ? snapshot.states : [];
  const records = [];
  const seenRecords = new Set();
  for (const [index, raw] of (rawRecords ?? []).entries()) {
    const path = `courses.records[${index}]`;
    if (!isObject(raw)) {
      snapshotIssue(errors, path, 'curso', 'Cada curso do backup deve ser um objeto.');
      continue;
    }
    rejectUnknownKeys(raw, SNAPSHOT_RECORD_KEYS, path, errors);
    if (!isText(raw.id)) {
      snapshotIssue(errors, `${path}.id`, 'curso', 'O curso do backup precisa de id.');
      continue;
    }
    if (seenRecords.has(raw.id)) {
      snapshotIssue(errors, `${path}.id`, 'duplicado', `O curso ${raw.id} aparece mais de uma vez no backup.`);
      continue;
    }
    const rawCourse = raw.course;
    // Aceita o corpo do curso (como o snapshot guarda) e também o documento
    // completo `{ format, version, course }`, sem afrouxar a validação.
    const document_ = isObject(rawCourse) && rawCourse.format === COURSE_FORMAT
      ? rawCourse
      : { format: COURSE_FORMAT, version: COURSE_VERSION, course: rawCourse };
    const normalized = normalizeCourse(document_);
    if (!normalized.ok) {
      for (const issue of normalized.errors ?? []) {
        const detail = typeof issue.path === 'string' ? issue.path.replace(/^course\./, '') : '';
        snapshotIssue(errors, detail ? `${path}.course.${detail}` : `${path}.course`, issue.code, issue.message);
      }
      continue;
    }
    if (normalized.document.course.id !== raw.id) {
      snapshotIssue(errors, `${path}.id`, 'id', 'O identificador do curso não bate com o do documento.');
      continue;
    }
    seenRecords.add(raw.id);
    const course = normalized.document.course;
    const watchedLessonIds = normalized.document.progress?.watchedLessonIds ?? [];
    const record = normalizeCourseRecord({ ...raw, course });
    records.push({ id: raw.id, record, course, watchedLessonIds });
  }
  const seenStates = new Set();
  const states = [];
  for (const [index, raw] of rawStates.entries()) {
    const path = `courses.states[${index}]`;
    validateStateShape(raw, path, errors);
    if (!isObject(raw) || !isText(raw.courseId)) continue;
    if (seenStates.has(raw.courseId)) {
      snapshotIssue(errors, `${path}.courseId`, 'duplicado', `O estado do curso ${raw.courseId} aparece mais de uma vez no backup.`);
      continue;
    }
    seenStates.add(raw.courseId);
    states.push(normalizeCourseState(raw, raw.courseId));
  }
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, COURSE_LIMITS.errors), records: [], states: [] };
  return { ok: true, errors: [], records, states };
}

function lessonMetaOf(course) {
  const meta = new Map();
  if (!course) return meta;
  for (const lesson of courseLessons(course)) {
    meta.set(lesson.id, {
      id: lesson.id,
      title: lesson.title ?? lesson.id,
      type: lesson.type ?? null,
      sectionId: lesson.sectionId ?? null,
      sectionTitle: lesson.sectionTitle ?? null,
    });
  }
  return meta;
}

function mergeNotesText(current, incoming) {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current === incoming) return current;
  if (current.split(IMPORTED_NOTES_SEPARATOR).includes(incoming)) return current;
  return `${current}${IMPORTED_NOTES_SEPARATOR}${incoming}`;
}

// Vínculos de aula: o vínculo ATUAL é preservado COMO ESTÁ (nunca é reescrito
// para uma cópia criada por esta importação) e só ids de ORIGEM que ainda não
// estão atendidos entram, remapeados para o exercício de destino.
//
// Um id de origem que JÁ existe no estado atual conta como atendido: reimportar
// um backup antigo depois de treinar o exercício vinculado não adiciona a cópia
// do backup como um segundo vínculo obrigatório (o que rebaixaria a conclusão
// já alcançada). A cópia continua na biblioteca, preservando o exercício do
// backup, mas não muda o vínculo existente nem impõe uma meta pendente nova.
function mergeLessonLinks(currentIds, incomingIds, remap) {
  const result = uniqueTexts(currentIds);
  for (const id of incomingIds) {
    if (result.includes(id)) continue;          // mesma identidade: já atendido
    const mapped = remap(id);
    if (result.includes(mapped)) continue;      // já aponta para o destino certo
    result.push(mapped);
  }
  return uniqueTexts(result);
}

// Fusão de UM estado de aula. Valores atuais explícitos vencem; anotações
// diferentes viram bloco adicional; vínculos seguem a regra acima.
function mergeLessonStateValues(current, incoming, remap) {
  const base = normalizeLessonState(current);
  const next = normalizeLessonState(incoming);
  return normalizeLessonState({
    watched: base.watched || next.watched,
    skipped: base.skipped || next.skipped,
    completionOverride: base.completionOverride ?? next.completionOverride,
    notes: mergeNotesText(base.notes, next.notes),
    linkedExerciseIds: mergeLessonLinks(base.linkedExerciseIds, next.linkedExerciseIds, remap),
    updatedAt: base.updatedAt ?? next.updatedAt,
  });
}

// Fusão de um estado de curso inteiro com o que já existe.
//
// `structure` decide o que é aula viva (a estrutura ATUAL, quando o curso já
// existe) e `structureMeta` é um catálogo extra (a estrutura do PRÓPRIO backup)
// usado só para dar título/seção ao tombstone de aula que o curso atual não
// tem. Devolve o estado canônico, o que mudou e as contagens para o relatório.
export function mergeSnapshotState(currentState, incomingState, {
  structure = null,
  structureMeta = null,
  watchedLessonIds = [],
  now = isoNow,
  remapExerciseId = null,
} = {}) {
  const remap = id => (typeof remapExerciseId === 'function' ? remapExerciseId(id) ?? id : id);
  const incoming = normalizeCourseState(incomingState, incomingState?.courseId ?? null)
    ?? normalizeCourseState(null, null);
  const current = currentState ? normalizeCourseState(currentState, currentState.courseId ?? null) : null;
  const meta = new Map([...lessonMetaOf(structureMeta), ...lessonMetaOf(structure)]);
  const structureIds = new Set(lessonMetaOf(structure).keys());
  const counts = { lessons: 0, tombstones: 0, resurrected: 0, watched: 0, notes: 0, links: 0, watch: 0 };

  const lessons = lessonDict();
  for (const [id, state] of Object.entries(current?.lessons ?? {})) setEntry(lessons, id, { ...state });
  const removed = (current?.removed ?? []).map(entry => clone(entry));
  const order = [...(current?.watch ?? [])];
  const notesMerged = (before, after) => after !== before;

  const archive = (id, state) => {
    const info = meta.get(id) ?? { title: id, type: null, sectionId: null, sectionTitle: null };
    const existing = removed.find(entry => entry.id === id);
    if (existing) {
      const before = existing.state.notes;
      existing.state = mergeLessonStateValues(existing.state, state, remap);
      if (notesMerged(before, existing.state.notes)) counts.notes += 1;
      return;
    }
    removed.push({
      id,
      title: info.title ?? id,
      type: info.type ?? null,
      sectionId: info.sectionId ?? null,
      sectionTitle: info.sectionTitle ?? null,
      removedAt: now(),
      state: normalizeLessonState(remapState(state, remap)),
    });
    counts.tombstones += 1;
  };

  for (const [id, state] of Object.entries(incoming.lessons)) {
    const target = structure === null || structureIds.has(id);
    if (!target) { archive(id, state); continue; }
    const before = entryOf(lessons, id) ?? normalizeLessonState(null);
    const after = mergeLessonStateValues(before, state, remap);
    if (notesMerged(before.notes, after.notes)) counts.notes += 1;
    if (after.linkedExerciseIds.length !== before.linkedExerciseIds.length) counts.links += 1;
    setEntry(lessons, id, after);
    counts.lessons += 1;
  }
  for (const tombstone of incoming.removed) {
    // SEM remapear antes: a regra de vínculo precisa ver os ids de ORIGEM para
    // reconhecer o que já está atendido no estado atual. O remap acontece na
    // fusão (ou na criação do tombstone, quando não há estado atual).
    const state = tombstone.state;
    const existing = removed.find(entry => entry.id === tombstone.id);
    if (existing) {
      const before = existing.state.notes;
      existing.state = mergeLessonStateValues(existing.state, state, remap);
      if (notesMerged(before, existing.state.notes)) counts.notes += 1;
      continue;
    }
    if (structure !== null && structureIds.has(tombstone.id)) {
      const before = entryOf(lessons, tombstone.id) ?? normalizeLessonState(null);
      setEntry(lessons, tombstone.id, mergeLessonStateValues(before, state, remap));
      counts.resurrected += 1;
      continue;
    }
    removed.push({
      id: tombstone.id,
      title: tombstone.title,
      type: tombstone.type,
      sectionId: tombstone.sectionId,
      sectionTitle: tombstone.sectionTitle,
      removedAt: tombstone.removedAt ?? now(),
      state: normalizeLessonState(remapState(state, remap)),
    });
    counts.tombstones += 1;
  }

  // Progresso do arquivo do curso: só ACRESCENTA "assistida", como na
  // reimportação de texto; aula fora da estrutura vira tombstone com o estado.
  for (const id of watchedLessonIds) {
    if (!isText(id)) continue;
    const existing = entryOf(lessons, id);
    if (existing) {
      if (existing.watched) continue;
      setEntry(lessons, id, normalizeLessonState({ ...existing, watched: true, updatedAt: now() }));
      counts.watched += 1;
      continue;
    }
    if (structure !== null && !structureIds.has(id)) { archive(id, { watched: true }); counts.watched += 1; continue; }
    if (structure === null) { archive(id, { watched: true }); counts.watched += 1; continue; }
    setEntry(lessons, id, normalizeLessonState({ watched: true, updatedAt: now() }));
    counts.watched += 1;
  }

  // Intervalos de estudo: união sem duplicatas (mesmo id ou mesma aula+janela).
  const known = new Set(order.map(interval => interval.id));
  for (const interval of incoming.watch) {
    if (known.has(interval.id)) continue;
    if (order.some(item => item.lessonId === interval.lessonId && item.startedAt === interval.startedAt && item.endedAt === interval.endedAt)) continue;
    known.add(interval.id);
    order.push(interval);
    counts.watch += 1;
  }

  // Aula ativa: a seleção ATUAL é preservada (viva ou já removida); a do
  // backup só vale quando é uma aula VIVA da estrutura que venceu.
  const liveLesson = id => isText(id) && (structure === null || structureIds.has(id));
  const knownLesson = id => liveLesson(id) || (structure !== null && removed.some(entry => entry.id === id));
  const activeLessonId = knownLesson(current?.activeLessonId) ? current.activeLessonId
    : liveLesson(incoming.activeLessonId) ? incoming.activeLessonId : null;
  const preferences = {
    active: current ? current.preferences.active : incoming.preferences.active,
    dailyMinutes: current?.preferences.dailyMinutes ?? incoming.preferences.dailyMinutes,
  };
  const state = normalizeCourseState({
    courseId: incoming.courseId ?? current?.courseId ?? null,
    createdAt: current?.createdAt ?? incoming.createdAt ?? now(),
    updatedAt: current?.updatedAt ?? incoming.updatedAt,
    activeLessonId,
    preferences,
    lessons,
    removed,
    watch: order,
  }, incoming.courseId ?? current?.courseId ?? null);
  const changed = JSON.stringify({ ...state, updatedAt: null }) !== JSON.stringify(current ? { ...current, updatedAt: null } : null);
  if (changed) state.updatedAt = now();
  return { state, counts, changed };
}

function remapState(state, remap) {
  const normalized = normalizeLessonState(state);
  return { ...normalized, linkedExerciseIds: uniqueTexts(normalized.linkedExerciseIds.map(remap)) };
}

// O patch de estado é estrito: campo desconhecido ou tipo errado é erro de
// programação, não é silenciado.
const LESSON_PATCH_KEYS = Object.freeze(['watched', 'skipped', 'completionOverride', 'notes', 'linkedExerciseIds']);

function validateLessonPatch(patch) {
  if (!isObject(patch)) throw new TypeError('Informe um objeto com o estado da aula.');
  for (const [key, value] of Object.entries(patch)) {
    if (!LESSON_PATCH_KEYS.includes(key)) throw new TypeError(`Campo de estado desconhecido: ${key}.`);
    if ((key === 'watched' || key === 'skipped') && typeof value !== 'boolean') throw new TypeError(`${key} deve ser booleano.`);
    if (key === 'notes' && typeof value !== 'string') throw new TypeError('notes deve ser texto.');
    if (key === 'completionOverride' && !COMPLETION_OVERRIDES.includes(value)) throw new RangeError('Override de conclusão inválido.');
    if (key === 'linkedExerciseIds' && (!Array.isArray(value) || value.some(item => !isText(item)))) {
      throw new TypeError('linkedExerciseIds deve ser uma lista de identificadores.');
    }
  }
}

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = factory.open(COURSE_DB_NAME, COURSE_DB_VERSION);
    } catch (error) {
      reject(describeCourseStorageError(error));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of COURSE_STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: COURSE_STORE_KEY_PATHS[name] });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(describeCourseStorageError(request.error));
    request.onblocked = () => reject(new CourseStorageError('blocked', 'Outra aba do GrooveGoblin está bloqueando a atualização do banco de cursos. Feche as outras abas e recarregue.'));
  });
}

function idbBackend(db) {
  const run = (stores, mode, action) => new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(stores, mode);
    } catch (error) {
      reject(describeCourseStorageError(error));
      return;
    }
    let result;
    let failed = false;
    const request = action(name => transaction.objectStore(name), transaction);
    if (request) {
      request.onsuccess = () => { result = request.result; };
      // Uma gravação recusada (quota, chave inválida) rejeita a operação: a
      // loja nunca converte erro de escrita em sucesso.
      request.onerror = () => {
        failed = true;
        reject(describeCourseStorageError(request.error));
      };
    }
    transaction.oncomplete = () => { if (!failed) resolve(result); };
    transaction.onabort = () => { if (!failed) reject(describeCourseStorageError(transaction.error || request?.error)); };
    transaction.onerror = event => event.preventDefault();
  });
  return {
    getAll: store => run(store, 'readonly', objectStore => objectStore(store).getAll()),
    get: (store, id) => run(store, 'readonly', objectStore => objectStore(store).get(id)),
    put: (store, value) => run(store, 'readwrite', objectStore => objectStore(store).put(value)),
    // Um curso e seu estado mudam juntos: uma transação só, para a
    // reimportação não deixar estrutura nova com estado velho.
    writeBatch: entries => run([...new Set(entries.map(entry => entry.store))], 'readwrite', objectStore => {
      let last = null;
      for (const entry of entries) last = objectStore(entry.store).put(entry.value);
      return last;
    }),
    delete: (store, id) => run(store, 'readwrite', objectStore => objectStore(store).delete(id)),
  };
}

export function createCourseStore({ backend, now = isoNow, uuid = defaultUuid, persistent = true, error = null } = {}) {
  const listeners = new Set();
  const courses = new Map();
  const states = new Map();
  // Ids de aula por curso: o estado é esparso (aula sem estado gravado não tem
  // registro), então existência de aula vem sempre da estrutura do curso.
  const lessonIds = new Map();
  const corrupt = [];
  let loaded = false;
  let loading = null;
  let loadWarning = null;
  let warning = null;

  const unavailable = () => error ?? new CourseStorageError('unavailable', COURSES_UNAVAILABLE_MESSAGE);

  function requireWritable() {
    if (!persistent || !backend) throw unavailable();
  }

  function emit() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* um assinante quebrado não derruba a loja */ }
    }
  }

  async function loadAll() {
    const [rawCourses, rawStates] = await Promise.all([backend.getAll('courses'), backend.getAll('states')]);
    for (const raw of rawCourses) {
      const record = normalizeCourseRecord(raw);
      if (record) {
        courses.set(record.id, record);
        lessonIds.set(record.id, new Set(courseLessons(record.course).map(lesson => lesson.id)));
      } else corrupt.push({ store: 'courses', id: raw?.id ?? null, raw });
    }
    for (const raw of rawStates) {
      const courseId = isText(raw?.courseId) ? raw.courseId : raw?.id;
      const state = normalizeCourseState(raw, courseId);
      if (state && isText(courseId)) states.set(courseId, state);
      else corrupt.push({ store: 'states', id: raw?.id ?? null, raw });
    }
    if (corrupt.length > 0) loadWarning = `Há ${corrupt.length} registro(s) de curso ilegíveis preservados; nada foi apagado.`;
    loaded = true;
    emit();
  }

  function ready() {
    if (!persistent || !backend || loaded) return Promise.resolve();
    if (!loading) loading = loadAll().catch(cause => { loading = null; throw describeCourseStorageError(cause); });
    return loading;
  }

  function lessonExists(courseId, lessonId) {
    return lessonIds.get(courseId)?.has(lessonId) === true;
  }

  // Toda mutação confirma que a loja é gravável ANTES de olhar o conteúdo:
  // sem IndexedDB (ou com o banco indisponível) nada é aceito "só na memória".
  async function prepare() {
    requireWritable();
    await ready();
  }

  // Fila de escritas da instância: uma operação só lê o estado depois de a
  // anterior ter confirmado, então NUNCA se clona estado que outra escrita está
  // prestes a substituir — sem lost update. A falha de uma operação não trava
  // as seguintes (a fila sempre segue) e nada é relatado como sucesso antes do
  // commit; não existe retry automático.
  let writes = Promise.resolve();
  function serialize(task) {
    const result = writes.then(task, task);
    writes = result.then(() => {}, () => {});
    return result;
  }

  // Grava o estado novo e SÓ DEPOIS atualiza a memória: gravação negada mantém
  // o estado anterior e o erro sobe para a interface.
  async function commitState(courseId, next) {
    await backend.put('states', clone(next));
    states.set(courseId, next);
    warning = null;
    emit();
  }

  // Mutações de estado gravam ANTES de mexer na memória: gravação negada
  // (quota, banco indisponível) mantém o estado anterior e o erro sobe para a
  // interface — nunca sucesso falso.
  //
  // O mutador recebe o estado JÁ ATUAL e devolve `{ value, state }`: `state` é o
  // estado novo a gravar, ou null quando nada mudou (leitura idempotente, sem
  // escrita). Ao chamador volta `value`.
  async function mutateState(courseId, mutator) {
    await prepare();
    return serialize(async () => {
      const current = states.get(courseId);
      if (!current) return null;
      const outcome = mutator(clone(current));
      if (!outcome) return null;
      if (!outcome.state) return outcome.value ?? null;
      await commitState(courseId, outcome.state);
      return outcome.value ?? null;
    });
  }

  function api() {
    return {
      get persistent() { return persistent && !!backend; },
      get error() { return error ? error.message ?? String(error) : null; },
      get errorCode() { return error?.code ?? null; },
      get warning() { return warning ?? loadWarning; },
      get schemaVersion() { return COURSE_SCHEMA_VERSION; },
      get dbName() { return COURSE_DB_NAME; },
      ready,
      subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('Assinante inválido.');
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      corrupt() { return corrupt.map(entry => clone(entry)); },

      list() {
        return [...courses.values()]
          .map(record => clone(record))
          .sort((a, b) => (a.importedAt ?? '').localeCompare(b.importedAt ?? '') || (a.id ?? '').localeCompare(b.id ?? ''));
      },
      get(id) {
        const record = courses.get(id);
        if (!record) return null;
        return { course: clone(record.course), record: clone(record), state: clone(states.get(id) ?? null) };
      },
      lessonState(courseId, lessonId) {
        return normalizeLessonState(entryOf(states.get(courseId)?.lessons, lessonId));
      },
      // Resumo derivado (progresso, próxima aula, tempo da semana) sem clonar o
      // documento inteiro — a lista e as próximas etapas (aula, Hoje) leem daqui.
      summary(courseId, options = {}) {
        const record = courses.get(courseId);
        if (!record) return null;
        return courseSummary(record.course, states.get(courseId), options);
      },
      // Origem inversa: em quais aulas/cursos um exercício está vinculado. A
      // Biblioteca usa isto para mostrar de onde o exercício veio, sem copiar
      // nome de curso para dentro do exercício.
      originsOf(exerciseId) {
        if (!isText(exerciseId)) return [];
        const origins = [];
        for (const [courseId, state] of states) {
          const record = courses.get(courseId);
          const lessons = record ? new Map(courseLessons(record.course).map(lesson => [lesson.id, lesson])) : new Map();
          for (const [lessonId, lessonState] of Object.entries(state.lessons)) {
            if (!lessonState.linkedExerciseIds.includes(exerciseId)) continue;
            const lesson = lessons.get(lessonId);
            origins.push({
              courseId,
              courseTitle: record?.course?.title ?? courseId,
              lessonId,
              lessonTitle: lesson?.title ?? lessonId,
              sectionId: lesson?.sectionId ?? null,
              sectionTitle: lesson?.sectionTitle ?? null,
              removed: false,
            });
          }
          for (const tombstone of state.removed) {
            if (!tombstone.state.linkedExerciseIds.includes(exerciseId)) continue;
            origins.push({
              courseId,
              courseTitle: record?.course?.title ?? courseId,
              lessonId: tombstone.id,
              lessonTitle: tombstone.title,
              sectionId: tombstone.sectionId,
              sectionTitle: tombstone.sectionTitle,
              removed: true,
            });
          }
        }
        return origins;
      },
      linkedExerciseIds(courseId) {
        const state = states.get(courseId);
        if (!state) return [];
        const ids = new Set();
        for (const lessonState of Object.values(state.lessons)) for (const id of lessonState.linkedExerciseIds) ids.add(id);
        for (const tombstone of state.removed) for (const id of tombstone.state.linkedExerciseIds) ids.add(id);
        return [...ids];
      },

      // Importação ESTRITA: só grava depois de o documento passar pela validação
      // do formato. Nunca lança por arquivo inválido — importar é entrada de
      // usuário; as mensagens trazem o caminho do campo.
      async importText(text, { source = null } = {}) {
        const parsed = parseCourse(text);
        if (!parsed.ok) return { ok: false, code: 'invalid', error: parsed.error, errors: parsed.errors ?? [], truncated: parsed.truncated === true };
        if (!persistent || !backend) return { ok: false, code: 'unavailable', error: unavailable().message, errors: [] };
        try {
          await ready();
        } catch (cause) {
          const described = describeCourseStorageError(cause);
          return { ok: false, code: described.code, error: described.message, errors: [] };
        }
        const course = parsed.document.course;
        // A leitura do estado anterior, a fusão e a gravação rodam na MESMA
        // seção serializada: uma reimportação simultânea a uma marcação de aula
        // não perde a marcação nem grava estado velho por cima do novo.
        return serialize(async () => {
          const previousRecord = courses.get(course.id) ?? null;
          const previousState = states.get(course.id) ?? null;
          const timestamp = now();
          const merged = mergeCourseState(previousState, previousRecord?.course ?? null, course, { now: timestamp });
          const state = merged.state;
          const nextLessonIds = new Set(courseLessons(course).map(lesson => lesson.id));
          // O progresso do arquivo só ACRESCENTA "assistida": reimportar nunca
          // desmarca o que o usuário marcou na interface.
          let watched = 0;
          for (const lessonId of parsed.document.progress?.watchedLessonIds ?? []) {
            if (!nextLessonIds.has(lessonId)) continue;
            const current = normalizeLessonState(entryOf(state.lessons, lessonId));
            if (current.watched) continue;
            setEntry(state.lessons, lessonId, { ...current, watched: true, updatedAt: timestamp });
            watched += 1;
          }
          const counts = {
            sections: course.sections.length,
            lessons: nextLessonIds.size,
            resources: courseLessons(course).reduce((total, lesson) => total + (lesson.resources?.length ?? 0), 0),
            exercises: courseLessons(course).reduce((total, lesson) => total + (lesson.suggestedExercises?.length ?? 0), 0),
          };
          const record = {
            id: course.id,
            importedAt: previousRecord?.importedAt ?? timestamp,
            updatedAt: timestamp,
            source: source ?? previousRecord?.source ?? null,
            counts,
            course,
          };
          try {
            await backend.writeBatch([
              { store: 'courses', value: clone(record) },
              { store: 'states', value: clone(state) },
            ]);
          } catch (cause) {
            const described = describeCourseStorageError(cause);
            return { ok: false, code: described.code, error: described.message, errors: [] };
          }
          courses.set(record.id, record);
          states.set(record.id, state);
          lessonIds.set(record.id, nextLessonIds);
          warning = null;
          emit();
          return {
            ok: true,
            courseId: record.id,
            created: previousRecord === null,
            counts: clone(counts),
            preserved: merged.counts.preserved,
            restored: merged.counts.restored,
            removed: merged.counts.removed,
            watched,
          };
        });
      },
      // Atualiza o estado de uma aula. Devolve o estado novo, ou null quando o
      // curso/aula não existe (tombstones também aceitam estado). A escolha
      // entre aula viva e tombstone é feita DENTRO da seção serializada: a
      // estrutura não muda entre a leitura e a gravação.
      async setLessonState(courseId, lessonId, patch = {}) {
        validateLessonPatch(patch);
        await prepare();
        return mutateState(courseId, next => {
          const target = lessonExists(courseId, lessonId) ? 'lessons'
            : next.removed.some(entry => entry.id === lessonId) ? 'removed' : null;
          if (!target) return null;
          const timestamp = now();
          if (target === 'lessons') {
            const current = entryOf(next.lessons, lessonId) ?? normalizeLessonState(null);
            setEntry(next.lessons, lessonId, normalizeLessonState({ ...current, ...patch, updatedAt: timestamp }));
            return { value: clone(entryOf(next.lessons, lessonId)), state: next };
          }
          const tombstone = next.removed.find(entry => entry.id === lessonId);
          tombstone.state = normalizeLessonState({ ...tombstone.state, ...patch, updatedAt: timestamp });
          return { value: clone(tombstone.state), state: next };
        });
      },
      async setCompletionOverride(courseId, lessonId, override) {
        if (!COMPLETION_OVERRIDES.includes(override)) throw new RangeError('Override de conclusão inválido.');
        return api().setLessonState(courseId, lessonId, { completionOverride: override });
      },
      async linkExercise(courseId, lessonId, exerciseId) {
        if (!isText(exerciseId)) throw new TypeError('Exercício inválido para vincular.');
        await prepare();
        return mutateState(courseId, next => {
          if (!lessonExists(courseId, lessonId)) return null;
          const base = entryOf(next.lessons, lessonId) ?? normalizeLessonState(null);
          // Deduplicação dentro da seção serializada: duas chamadas simultâneas
          // do mesmo vínculo não gravam duas vezes.
          if (base.linkedExerciseIds.includes(exerciseId)) return { value: clone(base), state: null };
          setEntry(next.lessons, lessonId, normalizeLessonState({
            ...base,
            linkedExerciseIds: [...base.linkedExerciseIds, exerciseId],
            updatedAt: now(),
          }));
          return { value: clone(entryOf(next.lessons, lessonId)), state: next };
        });
      },
      async unlinkExercise(courseId, lessonId, exerciseId) {
        await prepare();
        return mutateState(courseId, next => {
          const base = entryOf(next.lessons, lessonId);
          if (!base) return { value: null, state: null };
          if (!base.linkedExerciseIds.includes(exerciseId)) return { value: clone(base), state: null };
          setEntry(next.lessons, lessonId, normalizeLessonState({
            ...base,
            linkedExerciseIds: base.linkedExerciseIds.filter(id => id !== exerciseId),
            updatedAt: now(),
          }));
          return { value: clone(entryOf(next.lessons, lessonId)), state: next };
        });
      },
      async setActiveLesson(courseId, lessonId) {
        await prepare();
        return mutateState(courseId, next => {
          if (!lessonExists(courseId, lessonId)) return null;
          next.activeLessonId = lessonId;
          next.updatedAt = now();
          return { value: clone(next), state: next };
        });
      },
      async setPreferences(courseId, patch) {
        if (!isObject(patch)) throw new TypeError('Preferências do curso inválidas.');
        for (const key of Object.keys(patch)) {
          if (key !== 'active' && key !== 'dailyMinutes') throw new TypeError('Preferência de curso desconhecida.');
        }
        if (Object.hasOwn(patch, 'active') && typeof patch.active !== 'boolean') throw new TypeError('Curso ativo deve ser booleano.');
        if (Object.hasOwn(patch, 'dailyMinutes') && patch.dailyMinutes !== null
          && (!Number.isInteger(patch.dailyMinutes) || patch.dailyMinutes < COURSE_LIMITS.dailyMinutesMin
            || patch.dailyMinutes > COURSE_LIMITS.dailyMinutesMax)) {
          throw new RangeError(`Minutos por dia devem ficar entre ${COURSE_LIMITS.dailyMinutesMin} e ${COURSE_LIMITS.dailyMinutesMax}.`);
        }
        return mutateState(courseId, next => {
          next.preferences = { ...coursePreferences(next.preferences), ...patch };
          next.updatedAt = now();
          return { value: clone(next.preferences), state: next };
        });
      },
      // Marca como ASSISTIDAS a aula pedida e todas as anteriores na ordem do
      // curso (opcionais incluídas), numa transação só, e devolve o undo do que
      // mudou de verdade: `count` é quantas aulas passaram a assistida e `undo`
      // traz o valor ANTERIOR de cada uma (aula já assistida não entra — não há
      // o que desfazer nela). null quando o curso ou a aula não existem.
      async setWatchedThrough(courseId, lessonId) {
        if (!isText(lessonId)) throw new TypeError('Informe até qual aula marcar como assistida.');
        await prepare();
        // Estrutura E estado são lidos na MESMA seção serializada: uma
        // reimportação simultânea não faz o lote marcar aula que já saiu do
        // mapa (nem criar registro de aula inexistente).
        return serialize(async () => {
          const record = courses.get(courseId);
          const current = states.get(courseId);
          if (!record || !current) return null;
          const order = courseLessons(record.course).map(lesson => lesson.id);
          const index = order.indexOf(lessonId);
          if (index === -1) return null;
          const next = clone(current);
          const timestamp = now();
          const undo = [];
          for (const id of order.slice(0, index + 1)) {
            const lessonState = entryOf(next.lessons, id) ?? normalizeLessonState(null);
            if (lessonState.watched) continue;
            undo.push({ lessonId: id, watched: false });
            setEntry(next.lessons, id, normalizeLessonState({ ...lessonState, watched: true, updatedAt: timestamp }));
          }
          // Nada mudou (tudo já estava assistido): nenhuma escrita é feita.
          if (undo.length === 0) return { count: 0, undo };
          await commitState(courseId, next);
          return { count: undo.length, undo };
        });
      },
      // Desfaz um lote de "assistida" restaurando APENAS a flag `watched` das
      // aulas listadas. Anotações, vínculos e overrides escritos depois ficam
      // como estão, e aulas fora da lista não são tocadas. Aula que saiu do
      // mapa entre o lote e o desfazer também é restaurada (no tombstone): o
      // undo não perde a restauração.
      async restoreWatched(courseId, undo) {
        if (!Array.isArray(undo) || undo.some(entry => !isObject(entry) || !isText(entry.lessonId) || typeof entry.watched !== 'boolean')) {
          throw new TypeError('O undo precisa ser a lista { lessonId, watched } devolvida por setWatchedThrough.');
        }
        if (undo.length === 0) return { restored: 0 };
        await prepare();
        return mutateState(courseId, next => {
          const timestamp = now();
          let restored = 0;
          for (const entry of undo) {
            const lessonState = entryOf(next.lessons, entry.lessonId);
            if (lessonState) {
              if (lessonState.watched === entry.watched) continue;
              setEntry(next.lessons, entry.lessonId, normalizeLessonState({ ...lessonState, watched: entry.watched, updatedAt: timestamp }));
              restored += 1;
              continue;
            }
            const tombstone = next.removed.find(item => item.id === entry.lessonId);
            if (!tombstone || tombstone.state.watched === entry.watched) continue;
            tombstone.state = normalizeLessonState({ ...tombstone.state, watched: entry.watched, updatedAt: timestamp });
            restored += 1;
          }
          if (restored === 0) return { value: { restored }, state: null };
          return { value: { restored }, state: next };
        });
      },
      // Intervalos FECHADOS e positivos: fechar a página nunca cobra o tempo
      // parado, e um intervalo inválido não é aceito em silêncio. O histórico
      // salvo NUNCA é podado — intervalo antigo continua guardado (o recorte da
      // semana acontece na LEITURA, em course-progress.js).
      async recordWatch(courseId, lessonId, { startedAt, endedAt } = {}) {
        await prepare();
        const start = Date.parse(startedAt ?? '');
        const end = Date.parse(endedAt ?? '');
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
        return mutateState(courseId, next => {
          if (!lessonExists(courseId, lessonId)) return null;
          const interval = { id: uuid(), lessonId, startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), ms: end - start };
          next.watch = [...next.watch, interval];
          next.updatedAt = now();
          return { value: clone(interval), state: next };
        });
      },
      watchIntervals(courseId) { return clone(states.get(courseId)?.watch ?? []); },
      // Remover um curso apaga SÓ a estrutura: o estado fica guardado, para uma
      // reimportação do mesmo id devolver progresso, notas e vínculos.
      async removeCourse(courseId) {
        requireWritable();
        await ready();
        return serialize(async () => {
          if (!courses.has(courseId)) return false;
          await backend.delete('courses', courseId);
          courses.delete(courseId);
          lessonIds.delete(courseId);
          emit();
          return true;
        });
      },
      // Exportação canônica para reimportar em outro navegador: estrutura +
      // progresso assistido das aulas que ainda existem.
      exportText(courseId) {
        const record = courses.get(courseId);
        if (!record) return { ok: false, error: 'Curso não encontrado.' };
        const state = states.get(courseId);
        const watchedLessonIds = courseLessons(record.course)
          .map(lesson => lesson.id)
          .filter(id => entryOf(state?.lessons, id)?.watched === true);
        const document = { format: 'groovegoblin-course', version: 1, course: clone(record.course) };
        if (watchedLessonIds.length > 0) document.progress = { watchedLessonIds };
        const serialized = serializeCourse(document);
        return serialized.ok ? { ok: true, text: serialized.text } : { ok: false, error: serialized.error };
      },
      // Retrato COMPLETO da loja para o backup agregado: catálogo, TODOS os
      // estados — inclusive os órfãos que sobraram de removeCourse e que
      // list()/get() não expõem — e os registros ilegíveis crus, para o usuário
      // não perdê-los.
      snapshotAll() {
        const records = [...courses.values()]
          .map(record => clone(record))
          .sort((a, b) => (a.importedAt ?? '').localeCompare(b.importedAt ?? '') || a.id.localeCompare(b.id));
        const allStates = [...states.values()]
          .map(state => clone(state))
          .sort((a, b) => (a.courseId ?? '').localeCompare(b.courseId ?? ''));
        return {
          db: COURSE_DB_NAME,
          schemaVersion: COURSE_SCHEMA_VERSION,
          records,
          states: allStates,
          orphans: allStates.filter(state => !courses.has(state.courseId)),
          corrupt: corrupt.map(entry => clone(entry)),
        };
      },
      // Importação de um retrato agregado. Valida TUDO antes da primeira
      // gravação, recusa colidir com registro ilegível (nunca sobrescreve o que
      // está preservado) e grava cada par curso+estado numa transação só. A
      // fusão acontece DENTRO da fila de escrita, relendo o estado atual:
      // reimportar o mesmo retrato não muda nada e uma escrita concorrente não
      // é perdida.
      async importSnapshot(snapshot, { remapExerciseId = null } = {}) {
        const validated = validateSnapshot(snapshot);
        if (!validated.ok) {
          return { ok: false, code: 'invalid', error: 'O retrato de cursos do backup não pôde ser validado; nada foi gravado.', errors: validated.errors, applied: { courses: [], states: [] }, report: null };
        }
        requireWritable();
        try {
          await ready();
        } catch (cause) {
          const described = describeCourseStorageError(cause);
          return { ok: false, code: described.code, error: described.message, errors: [], applied: { courses: [], states: [] }, report: null };
        }
        return serialize(async () => {
          const unreadable = new Set();
          for (const entry of corrupt) {
            if (isText(entry.id)) unreadable.add(entry.id);
            if (isText(entry.raw?.id)) unreadable.add(entry.raw.id);
            if (isText(entry.raw?.courseId)) unreadable.add(entry.raw.courseId);
          }
          const collisions = [...new Set([
            ...validated.records.map(item => item.id),
            ...validated.states.map(item => item.courseId),
          ])].filter(id => unreadable.has(id));
          if (collisions.length > 0) {
            return {
              ok: false,
              code: 'corrupt',
              error: `Há ${collisions.length} registro(s) ilegível(is) guardado(s) com identificador igual ao do backup (${collisions.join(', ')}). Nada foi gravado, para não sobrescrever o que está preservado.`,
              errors: collisions.map(id => ({ path: id, code: 'corrupt', message: 'Identificador colide com um registro ilegível preservado.' })),
              applied: { courses: [], states: [] },
              report: null,
            };
          }
          const timestamp = now();
          const plan = [];
          const report = { added: 0, merged: 0, unchanged: 0, orphans: 0, tombstones: 0, resurrected: 0, watched: 0, notes: 0, links: 0, watch: 0 };
          const stateById = new Map(validated.states.map(item => [item.courseId, item]));
          const recordIds = new Set(validated.records.map(item => item.id));
          for (const { id, record, course, watchedLessonIds } of validated.records) {
            const currentRecord = courses.get(id) ?? null;
            const currentState = states.get(id) ?? null;
            // A estrutura ATUAL vence; a do backup só completa o catálogo dos
            // tombstones (título/seção de aula que o curso atual não tem).
            const merged = mergeSnapshotState(currentState, stateById.get(id) ?? { courseId: id }, {
              structure: currentRecord ? currentRecord.course : course,
              structureMeta: course,
              watchedLessonIds,
              now: () => timestamp,
              remapExerciseId,
            });
            plan.push({ id, record: currentRecord ? null : record, orphan: false, state: merged.state, changed: merged.changed || currentRecord === null, counts: merged.counts });
          }
          for (const state of validated.states) {
            if (recordIds.has(state.courseId)) continue;
            const currentRecord = courses.get(state.courseId) ?? null;
            const merged = mergeSnapshotState(states.get(state.courseId) ?? null, state, {
              structure: currentRecord ? currentRecord.course : null,
              now: () => timestamp,
              remapExerciseId,
            });
            plan.push({ id: state.courseId, record: null, orphan: currentRecord === null, state: merged.state, changed: merged.changed, counts: merged.counts });
          }
          const applied = { courses: [], states: [] };
          for (const item of plan) {
            if (!item.changed) { report.unchanged += 1; continue; }
            const entries = [{ store: 'states', value: clone(item.state) }];
            if (item.record) entries.push({ store: 'courses', value: clone(item.record) });
            try {
              await backend.writeBatch(entries);
            } catch (cause) {
              // Falha no meio: o que já gravou permanece; nada é apagado e
              // nenhuma retentativa automática acontece.
              const described = describeCourseStorageError(cause);
              return { ok: false, code: described.code, error: described.message, errors: [], applied, report };
            }
            states.set(item.id, item.state);
            if (item.record) {
              courses.set(item.id, item.record);
              lessonIds.set(item.id, new Set(courseLessons(item.record.course).map(lesson => lesson.id)));
              applied.courses.push(item.id);
              report.added += 1;
            } else {
              applied.states.push(item.id);
              if (item.orphan) report.orphans += 1; else report.merged += 1;
            }
            report.tombstones += item.counts.tombstones;
            report.resurrected += item.counts.resurrected;
            report.watched += item.counts.watched;
            report.notes += item.counts.notes;
            report.links += item.counts.links;
            report.watch += item.counts.watch;
          }
          if (applied.courses.length > 0 || applied.states.length > 0) { warning = null; emit(); }
          return { ok: true, report, applied };
        });
      },
    };
  }

  return api();
}

// Fábrica usada pelo app: a dependência de IndexedDB é EXPLÍCITA e injetável
// (testes passam a própria fábrica). Sem IndexedDB a loja nasce persistente:
// false, com o motivo em `error`, e recusa toda escrita.
export async function openCourseStore({ indexedDB = globalThis.indexedDB, now = isoNow, uuid = defaultUuid } = {}) {
  if (!indexedDB) {
    return createCourseStore({ persistent: false, error: new CourseStorageError('unavailable', COURSES_UNAVAILABLE_MESSAGE), now, uuid });
  }
  try {
    const db = await openDatabase(indexedDB);
    db.onversionchange = () => db.close();
    return createCourseStore({ backend: idbBackend(db), persistent: true, now, uuid });
  } catch (cause) {
    return createCourseStore({ persistent: false, error: describeCourseStorageError(cause), now, uuid });
  }
}

// Uma única loja por app, já carregada quando a promessa resolve: as origens
// do Estúdio e o Hoje precisam dos dados mesmo antes de abrir a lista de cursos.
let sharedPromise = null;
export function sharedCourseStore(options) {
  if (!sharedPromise) sharedPromise = openCourseStore(options).then(async store => {
    await store.ready();
    return store;
  });
  return sharedPromise;
}
export function resetSharedCourseStore() {
  sharedPromise = null;
}
