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

import { parseCourse, serializeCourse } from './course-format.js';
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

// Dicionário por id: QUALQUER id válido — inclusive "__proto__", "constructor"
// ou "toString" — precisa virar uma entrada PRÓPRIA e enumerável. Atribuir
// `dictionary[id] = …` não serve: para "__proto__" a atribuição cai no setter
// herdado do Object.prototype, o registro some sem erro nenhum e um
// recarregamento perde o estado. `defineProperty` grava a propriedade própria
// sem consultar o protótipo (o clone do IndexedDB também a preserva).
function setEntry(dictionary, key, value) {
  Object.defineProperty(dictionary, key, { value, enumerable: true, configurable: true, writable: true });
  return value;
}

// Leitura de dicionário por id: só a entrada PRÓPRIA vale. Sem isso, um id como
// "__proto__" devolveria o próprio Object.prototype (herdado) no lugar do
// registro.
function entryOf(dictionary, key) {
  if (dictionary === null || typeof dictionary !== 'object') return undefined;
  return Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
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

export function normalizeCourseState(value, courseId) {
  if (!isObject(value)) return null;
  const lessons = {};
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
    ?? { courseId: nextCourse?.id ?? null, createdAt: null, updatedAt: null, activeLessonId: null, lessons: {}, removed: [], watch: [] };
  const nextLessons = courseLessons(nextCourse);
  const nextIds = new Set(nextLessons.map(lesson => lesson.id));
  const lessons = {};
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
      lessons,
      // TODOS os tombstones ficam guardados: o limite de aulas vale para o
      // documento importado, nunca para o estado que o usuário já construiu.
      removed,
      watch: previous.watch,
    },
    counts: { preserved, restored, removed: removedOut },
  };
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
            const current = normalizeLessonState(entryOf(next.lessons, lessonId));
            const updated = normalizeLessonState({ ...current, ...patch, updatedAt: timestamp });
            setEntry(next.lessons, lessonId, updated);
            return { value: clone(updated), state: next };
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
          const base = normalizeLessonState(entryOf(next.lessons, lessonId));
          // Deduplicação dentro da seção serializada: duas chamadas simultâneas
          // do mesmo vínculo não gravam duas vezes.
          if (base.linkedExerciseIds.includes(exerciseId)) return { value: clone(base), state: null };
          const updated = normalizeLessonState({
            ...base,
            linkedExerciseIds: [...base.linkedExerciseIds, exerciseId],
            updatedAt: now(),
          });
          setEntry(next.lessons, lessonId, updated);
          return { value: clone(updated), state: next };
        });
      },
      async unlinkExercise(courseId, lessonId, exerciseId) {
        await prepare();
        return mutateState(courseId, next => {
          const base = entryOf(next.lessons, lessonId);
          if (!base) return { value: null, state: null };
          if (!base.linkedExerciseIds.includes(exerciseId)) return { value: clone(base), state: null };
          const updated = normalizeLessonState({
            ...base,
            linkedExerciseIds: base.linkedExerciseIds.filter(id => id !== exerciseId),
            updatedAt: now(),
          });
          setEntry(next.lessons, lessonId, updated);
          return { value: clone(updated), state: next };
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
            const lessonState = normalizeLessonState(entryOf(next.lessons, id));
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

// Uma única loja por app: a Biblioteca monta os cursos e as próximas etapas
// (aula, Hoje, backup) leem a mesma conexão em vez de abrir outra.
let sharedPromise = null;
export function sharedCourseStore(options) {
  if (!sharedPromise) sharedPromise = openCourseStore(options);
  return sharedPromise;
}
export function resetSharedCourseStore() {
  sharedPromise = null;
}
