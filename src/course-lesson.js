// Página da aula (rodada 5, etapa 6).
//
// A aula é o lugar onde o material do curso encontra o exercício do usuário:
// link externo (nunca buscado nem embutido pelo app), marcação de assistida,
// resumo/instrução de prática, materiais com anexo do próprio computador,
// anotações pessoais, exercícios sugeridos (criados no Estúdio como exercício
// NOVO, canônico e com notas vazias) e exercícios vinculados com a regra de
// conclusão do modelo puro de progresso.
//
// Regras que este módulo respeita:
//  - nada de conteúdo de terceiros: o único link externo é
//    `<a target="_blank" rel="noopener noreferrer">`;
//  - nada de gravação só na memória: sem IndexedDB os controles de escrita
//    ficam desligados e o motivo aparece na tela;
//  - anotações nunca se perdem: o rascunho fica no módulo, o texto é salvo ao
//    digitar (com atraso), ao sair e ao trocar de aula, e um erro de gravação
//    mantém o texto visível com aviso honesto;
//  - PDF só abre em nova aba depois de o CONTEÚDO ser conferido (cabeçalho
//    `%PDF-`), com o tipo forçado; HTML renomeado vira download, nunca página;
//  - áudio toca da cópia salva no navegador, com loop, funcionando offline;
//  - URL de blob é revogada ao trocar de aula, remover e fechar — nunca antes
//    de o PDF abrir;
//  - tempo de estudo entra como intervalos FECHADOS e positivos na loja de
//    cursos (nunca como exercício fantasma no histórico de prática);
//  - a aula aberta é registrada em `setActiveLesson`, e a conclusão vem do
//    modelo puro: assistida + TODOS os vínculos no alvo, override explícito
//    para "Concluir mesmo assim"/"Reabrir" e "Retomar conclusão automática".

import { createEl, renderKeepingFocus } from './practice.js';
import { createSession, BPM_MIN, BPM_MAX, MAX_BARS, MIN_BARS, SESSION_NAME_MAX } from './session.js';
import { withStudioChoices } from './studio-session.js';
import { standardInstrumentProfile, instrumentInputPitch } from './instrument-profile.js';
import {
  LESSON_STATUS, courseLessons, lessonCompletion, lessonLinks, lessonPending, normalizeLessonState, videoMinutes,
} from './course-progress.js';
import {
  ATTACHMENT_KINDS, attachmentRefKey, attachmentKindLabel, extensionOfName, formatAttachmentSize,
  sniffAttachmentKind,
} from './course-attachments.js';

export const BASS_STRINGS = Object.freeze([4, 5]);

export const STATUS_LABELS = Object.freeze({
  [LESSON_STATUS.notStarted]: 'Não iniciada',
  [LESSON_STATUS.watched]: 'Assistida',
  [LESSON_STATUS.practicing]: 'Praticando',
  [LESSON_STATUS.done]: 'Concluída',
});

export const PENDING_LABELS = Object.freeze({
  reopened: 'conclusão reaberta: use “Retomar conclusão automática” quando quiser voltar a concluir',
  'not-watched': 'assistida ainda não marcada',
  'no-linked-exercise': 'crie ou vincule um exercício sugerido',
  'exercise-missing': 'exercício vinculado não está mais na biblioteca',
  'exercise-without-target': 'exercício vinculado sem alvo definido',
  'exercise-below-target': 'exercício vinculado ainda não atingiu o alvo',
});

export const INSTRUMENT_LABELS = Object.freeze({ guitar: 'Guitarra', bass: 'Baixo' });
export const NOTES_SAVE_DELAY_MS = 600;
export const WATCH_MIN_MS = 1000;
export const NOTES_STATUS_LABELS = Object.freeze({
  pendente: 'alterações não salvas',
  salvando: 'salvando…',
  salvo: 'anotações salvas',
  erro: 'não foi possível salvar agora — o texto continua aqui',
  vazio: '',
});

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ------------------------------------------------------------------ puro

// Alvo digitado: vazio é SEM alvo (null) — nunca um alvo implícito herdado.
export function parseOptionalBpm(text, { min = BPM_MIN, max = BPM_MAX } = {}) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { ok: true, value: null };
  if (!/^\d{1,4}$/.test(raw)) return { ok: false, error: 'O alvo precisa ser um número inteiro de BPM; use vazio para deixar sem alvo.' };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return { ok: false, error: `O alvo precisa ficar entre ${min} e ${max} BPM; use vazio para deixar sem alvo.` };
  return { ok: true, value };
}

// Cordas do exercício novo: sugestão da aula → curso → preferência do usuário
// (se for baixo de 4/5) → 4. NUNCA 6: só baixo de 4 ou 5 cordas existe aqui.
export function instrumentStringsFor({ suggestion = null, lesson = null, course = null, preference = null } = {}) {
  void lesson;
  for (const candidate of [suggestion?.strings, course?.strings]) {
    if (BASS_STRINGS.includes(candidate)) return candidate;
  }
  if (preference?.type === 'bass' && BASS_STRINGS.includes(preference.strings)) return preference.strings;
  return 4;
}

export function suggestedBars({ suggestion = null, bars = null } = {}) {
  const raw = Number.isFinite(bars) ? bars : suggestion?.bars;
  if (!Number.isFinite(raw)) return clamp(4, MIN_BARS, MAX_BARS);
  return clamp(Math.round(raw), MIN_BARS, MAX_BARS);
}

// Exercício NOVO e canônico a partir de uma sugestão da aula: baixo de 4/5
// cordas, nome/BPM inicial/compassos da sugestão (ajustáveis), alvo nulo ou
// número e NOTAS VAZIAS — o app nunca gera frase sozinho nem copia arquivo do
// curso para dentro do exercício.
//
// `bpm`, `bars`, `name` e `targetBpm` só valem quando informados: `undefined`
// significa "use a sugestão", e `targetBpm: null` significa, de propósito,
// "sem alvo" (é o que a interface manda quando o campo do alvo fica vazio).
export function buildSuggestedExercise({
  suggestion = {}, lesson = null, course = null, preference = null,
  bpm = null, targetBpm, bars = null, name = null,
} = {}) {
  const strings = instrumentStringsFor({ suggestion, lesson, course, preference });
  const profile = standardInstrumentProfile('bass', strings);
  const chosenBars = suggestedBars({ suggestion, bars });
  const rawBpm = Number.isFinite(bpm) ? bpm : suggestion?.initialBpm;
  const chosenBpm = clamp(Math.round(Number.isFinite(rawBpm) ? rawBpm : 60), BPM_MIN, BPM_MAX);
  const chosenName = String(name ?? suggestion?.title ?? 'Exercício da aula').trim().slice(0, SESSION_NAME_MAX) || 'Exercício da aula';
  const rawTarget = targetBpm === undefined ? suggestion?.targetBpm : targetBpm;
  const target = Number.isFinite(rawTarget) ? clamp(Math.round(rawTarget), BPM_MIN, BPM_MAX) : null;
  const session = withStudioChoices(createSession({
    name: chosenName,
    bpm: chosenBpm,
    bars: chosenBars,
    loop: { startBar: 0, endBar: chosenBars },
    progression: { cycleBars: chosenBars },
    timbres: { phrase: 'electric-bass' },
    extensions: { studio: { instrument: profile, inputPitch: instrumentInputPitch(profile) } },
  }));
  return {
    session,
    metadata: { name: chosenName, targetBPM: target, tags: [] },
    strings,
    bars: chosenBars,
    bpm: chosenBpm,
    targetBpm: target,
  };
}

// Materiais da aula: os próprios e as referências a material de OUTRA aula.
// Cada linha carrega a chave composta do anexo — a mesma chave que a loja de
// anexos usa, então a interface nunca inventa onde o arquivo mora.
export function lessonMaterialRows(course, lesson, localRefs = []) {
  const rows = [];
  const seen = new Set();
  const push = row => {
    if (!row?.refKey || seen.has(row.refKey)) return;
    seen.add(row.refKey);
    rows.push(row);
  };
  for (const resource of lesson?.resources ?? []) {
    push({
      refKey: attachmentRefKey(course.id, lesson.id, resource.id),
      resourceId: resource.id,
      ownerLessonId: lesson.id,
      ownerLessonTitle: lesson.title,
      ownerSectionTitle: lesson.sectionTitle ?? null,
      name: resource.name,
      extension: resource.extension ?? '',
      role: resource.role ?? null,
      strings: resource.strings ?? null,
      bpm: resource.bpm ?? null,
      crossLesson: false,
      missing: false,
    });
  }
  const lessons = new Map(courseLessons(course).map(item => [item.id, item]));
  for (const ref of lesson?.resourceRefs ?? []) {
    const owner = lessons.get(ref.lessonId) ?? null;
    const resource = (owner?.resources ?? []).find(item => item.id === ref.resourceId) ?? null;
    push({
      refKey: attachmentRefKey(course.id, ref.lessonId, ref.resourceId),
      resourceId: ref.resourceId,
      ownerLessonId: ref.lessonId,
      ownerLessonTitle: owner?.title ?? null,
      ownerSectionTitle: owner?.sectionTitle ?? null,
      name: resource?.name ?? null,
      extension: resource?.extension ?? '',
      role: resource?.role ?? null,
      strings: resource?.strings ?? null,
      bpm: resource?.bpm ?? null,
      crossLesson: ref.lessonId !== lesson.id,
      missing: resource === null,
    });
  }
  // A reimportação pode retirar apenas o material, mantendo a aula. A cópia
  // local continua acessível aqui, com a chave original, até remoção explícita.
  for (const ref of localRefs) {
    if (ref.courseId !== course.id || ref.lessonId !== lesson.id) continue;
    push({
      refKey: ref.key,
      resourceId: ref.resourceId,
      ownerLessonId: lesson.id,
      ownerLessonTitle: lesson.title,
      ownerSectionTitle: lesson.sectionTitle ?? null,
      name: ref.name,
      extension: ref.extension ?? '',
      role: ref.role ?? null,
      strings: null,
      bpm: null,
      crossLesson: false,
      missing: true,
    });
  }
  return rows;
}

// Anexos que continuam guardados mas já não têm material correspondente no mapa
// (aula removida ou recurso que saiu do curso). O pai pode mostrá-los no grupo
// "Removidas do curso": nada é apagado sozinho nem na reimportação.
export function orphanAttachmentRefs(course, refs) {
  const lessons = new Map(courseLessons(course).map(item => [item.id, item]));
  return (Array.isArray(refs) ? refs : []).filter(ref => {
    const lesson = lessons.get(ref.lessonId);
    if (!lesson) return true;
    return !(lesson.resources ?? []).some(resource => resource.id === ref.resourceId);
  });
}

// Leitura completa da aula: estrutura, estado, vínculos, conclusão e pendências.
// Nada é gravado aqui; tudo vem do modelo puro de progresso.
export function lessonOutcome(store, courseId, lessonId, { resolveExercise = null, now = Date.now() } = {}) {
  const found = store.get(courseId);
  if (!found) return null;
  const summary = store.summary(courseId, { resolveExercise, now });
  const row = summary?.rows?.find(item => item.lesson.id === lessonId) ?? null;
  const tombstone = (found.state?.removed ?? []).find(item => item.id === lessonId) ?? null;
  const lessonState = row ? row.lessonState : normalizeLessonState(tombstone?.state);
  const links = row ? row.links : lessonLinks(lessonState, resolveExercise);
  const hasSuggestions = (row?.lesson.suggestedExercises?.length ?? 0) > 0;
  return {
    course: found.course,
    record: found.record,
    state: found.state,
    lesson: row?.lesson ?? null,
    removed: tombstone,
    lessonState,
    links,
    hasSuggestions,
    watchMs: row?.watchMs ?? 0,
    status: row?.status ?? null,
    weekMs: summary?.weekMs ?? 0,
    completion: lessonCompletion(lessonState, links, { hasSuggestions }),
    pending: lessonPending(lessonState, links, { hasSuggestions }),
    next: summary?.next ?? null,
  };
}

// "Marcar assistidas até aqui": o lote é da loja de cursos — uma transação só,
// marca a aula pedida e todas as anteriores na ordem do curso e devolve o
// `undo` com o valor ANTERIOR de `watched` de cada aula que mudou.
export function watchThrough(store, courseId, upToLessonId) {
  return store.setWatchedThrough(courseId, upToLessonId);
}

// Desfazer APENAS `watched`, sem tocar em notas, vínculos ou overrides que
// tenham mudado depois da marcação em lote (inclusive em aula que virou
// tombstone no meio do caminho — quem restaura é a loja).
export function restoreWatched(store, courseId, undo) {
  return store.restoreWatched(courseId, undo);
}

export function durationLabel(lesson) {
  const minutes = videoMinutes(lesson?.videoSeconds);
  if (minutes !== null) return minutes === 1 ? '1 min' : `${minutes} min`;
  return lesson?.hasVideo ? 'duração não informada' : 'sem vídeo';
}

export function studyTimeLabel(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'sem tempo registrado';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'menos de 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')} min`;
}

// ------------------------------------------------------------------ interface

export function mountCourseLesson(container, host) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para a aula.');
  const store = host?.store;
  if (!store || typeof store.get !== 'function') throw new TypeError('Loja de cursos ausente na aula.');
  const attachments = host?.attachments ?? null;
  const library = host?.library ?? null;
  const notify = (text, error = false) => host.notify?.(text, error);
  const openExercise = typeof host.openExercise === 'function' ? host.openExercise : null;
  const onBack = typeof host.onBack === 'function' ? host.onBack : null;
  const onOpenLesson = typeof host.onOpenLesson === 'function' ? host.onOpenLesson : null;
  const preference = host?.instrumentPreference ?? null;
  const resolveExercise = id => (library && typeof library.get === 'function' ? library.get(id) : null);

  const root = createEl('section', { id: 'course-lesson-page', className: 'lesson-root', 'aria-label': 'Aula do curso' });
  root.hidden = true;
  container.appendChild(root);

  const view = {
    courseId: null,
    lessonId: null,
    forms: new Map(),
    linkExisting: '',
    undo: null,
    undoCourseId: null,
  };
  // Rascunho de anotações por (curso, aula): o texto digitado vive AQUI até a
  // gravação confirmar. Uma escrita antiga só limpa a PRÓPRIA versão, uma falha
  // preserva o texto (que volta ao reabrir a aula) e navegar não descarta nada.
  const drafts = new Map();
  // Contagem de tempo é OPT-IN e por aula, desligada por padrão.
  const timeOptIn = new Set();
  let lifecycle = 0;               // token: hide() e show() novo invalidam continuações
  let watch = null;
  let notesTimer = null;
  let notesStatusNode = null;
  let suppressRender = false;
  let storeLoaded = false;
  const objectUrls = new Map();
  const listeners = [];

  const writable = () => store.persistent === true;
  const attachmentsReady = () => attachments && typeof attachments.list === 'function';

  function listen(target, type, handler) {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  }

  function clearListeners() {
    while (listeners.length > 0) listeners.pop()();
  }

  // ------------------------------------------------------------ URLs de blob
  function urlFor(refKey, kind, blob) {
    const key = `${refKey}|${kind}`;
    if (objectUrls.has(key)) return objectUrls.get(key);
    if (typeof URL?.createObjectURL !== 'function') return null;
    const url = URL.createObjectURL(blob);
    objectUrls.set(key, url);
    return url;
  }

  function revokeRef(refKey) {
    for (const [key, url] of [...objectUrls]) {
      if (key !== refKey && !key.startsWith(`${refKey}|`)) continue;
      URL.revokeObjectURL?.(url);
      objectUrls.delete(key);
    }
  }

  function revokeAll() {
    for (const url of objectUrls.values()) URL.revokeObjectURL?.(url);
    objectUrls.clear();
  }

  // ---------------------------------------------------------------- rascunhos
  const DRAFT_MAX = 40;
  const pairKey = (courseId, lessonId) => `${courseId}\u0000${lessonId}`;

  function draftFor(courseId, lessonId, storedNotes = '') {
    const key = pairKey(courseId, lessonId);
    let draft = drafts.get(key) ?? null;
    if (!draft) {
      draft = { key, text: storedNotes, storedNotes, dirty: false, status: storedNotes ? 'salvo' : 'vazio', version: 0 };
      drafts.set(key, draft);
    } else if (!draft.dirty) {
      // Sem alteração local o rascunho acompanha a loja (reimportação, outra aba).
      draft.text = storedNotes;
      draft.storedNotes = storedNotes;
    }
    if (drafts.size > DRAFT_MAX) {
      for (const [otherKey, other] of drafts) {
        if (drafts.size <= DRAFT_MAX) break;
        if (!other.dirty && otherKey !== key) drafts.delete(otherKey);
      }
    }
    return draft;
  }

  function currentDraftKey() {
    return view.courseId && view.lessonId ? pairKey(view.courseId, view.lessonId) : null;
  }

  function setNotesStatus(status, key = currentDraftKey()) {
    const draft = key ? drafts.get(key) : null;
    if (draft) draft.status = status;
    if (key && key === currentDraftKey() && notesStatusNode) notesStatusNode.textContent = NOTES_STATUS_LABELS[status] ?? '';
  }

  function scheduleNotesSave() {
    if (notesTimer !== null) globalThis.clearTimeout(notesTimer);
    notesTimer = globalThis.setTimeout(() => {
      notesTimer = null;
      const key = currentDraftKey();
      if (key) void saveDraftByKey(key);
    }, NOTES_SAVE_DELAY_MS);
  }

  // Grava o rascunho de (curso, aula). NUNCA apaga o texto: em erro ele fica
  // guardado e reaparece quando a aula for reaberta.
  async function saveDraftByKey(key) {
    const draft = drafts.get(key);
    if (!draft || !draft.dirty) return true;
    const [courseId, lessonId] = key.split('\u0000');
    const value = draft.text;
    const version = draft.version + 1;
    draft.version = version;
    setNotesStatus('salvando', key);
    try {
      suppressRender = true;
      const next = await store.setLessonState(courseId, lessonId, { notes: value });
      suppressRender = false;
      if (!next) {
        setNotesStatus('erro', key);
        notify('Esta aula não está mais no curso; o texto das anotações continua guardado aqui.', true);
        return false;
      }
      draft.storedNotes = value;
      // Uma escrita ANTIGA só limpa a PRÓPRIA versão: se o texto mudou (na mesma
      // aula ou em outra) no meio do caminho, este resultado não toca no rascunho.
      if (draft.version === version && draft.text === value) {
        draft.dirty = false;
        setNotesStatus('salvo', key);
      }
      return true;
    } catch (error) {
      suppressRender = false;
      draft.dirty = true;
      setNotesStatus('erro', key);
      notify(`Não foi possível salvar as anotações: ${error.message}. O texto continua guardado e volta quando você reabrir a aula.`, true);
      return false;
    }
  }

  function storedNotesOf(courseId, lessonId) {
    const outcome = lessonOutcome(store, courseId, lessonId, { resolveExercise });
    return outcome?.lessonState?.notes ?? '';
  }

  function flushNotes() {
    if (notesTimer !== null) { globalThis.clearTimeout(notesTimer); notesTimer = null; }
    const key = currentDraftKey();
    return key ? saveDraftByKey(key) : Promise.resolve(true);
  }

  // --------------------------------------------------------- tempo de estudo
  // Nada conta por padrão: a contagem é escolha explícita e POR AULA
  // (“Contar tempo nesta aula”). O app NUNCA conta o tempo no site externo —
  // assistir no site de terceiros não marca assistida nem soma estudo.
  function timeCounting(courseId = view.courseId, lessonId = view.lessonId) {
    return !!courseId && !!lessonId && timeOptIn.has(pairKey(courseId, lessonId));
  }

  function startWatch() {
    if (!view.courseId || !view.lessonId || root.hidden) return;
    if (!timeCounting()) return;
    if (document.hidden === true) return;
    if (watch && watch.courseId === view.courseId && watch.lessonId === view.lessonId) return;
    watch = { courseId: view.courseId, lessonId: view.lessonId, startedAt: Date.now() };
  }

  function closeWatch() {
    const current = watch;
    watch = null;
    if (!current) return;
    const endedAt = Date.now();
    if (endedAt - current.startedAt < WATCH_MIN_MS) return;
    if (!writable()) return;
    void store.recordWatch(current.courseId, current.lessonId, {
      startedAt: new Date(current.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
    }).catch(error => notify(`Não foi possível registrar o tempo de estudo: ${error.message}`, true));
  }

  function setTimeCounting(value) {
    const key = currentDraftKey();
    if (!key) return;
    if (value) { timeOptIn.add(key); startWatch(); } else { timeOptIn.delete(key); closeWatch(); }
    render();
  }

  // Esconder a página fecha o intervalo e tenta gravar o rascunho na hora. A
  // gravação é melhor esforço: se o navegador suspender o IndexedDB, o texto
  // continua guardado aqui e volta quando a aula for reaberta — sem promessa de
  // garantia que a API não oferece.
  function onVisibility() {
    if (document.hidden === true) { void flushNotes(); closeWatch(); }
    else startWatch();
  }

  function attachLifecycle() {
    listen(document, 'visibilitychange', onVisibility);
    listen(globalThis, 'pagehide', () => { void flushNotes(); closeWatch(); });
  }

  // ------------------------------------------------------------- ações da aula
  async function patch(patchValue, message) {
    if (!writable()) { notify(store.error ?? 'Armazenamento de cursos indisponível: nada será salvo.', true); return null; }
    try {
      const next = await store.setLessonState(view.courseId, view.lessonId, patchValue);
      if (!next) { notify('Esta aula não está mais no curso.', true); return null; }
      if (message) notify(message);
      return next;
    } catch (error) {
      notify(`Não foi possível salvar a aula: ${error.message}`, true);
      return null;
    }
  }

  async function toggleWatched(value) {
    const next = await patch({ watched: value === true });
    if (next && value === true && next.completionOverride === 'reopened') {
      notify('Conclusão reaberta: use “Retomar conclusão automática” para a aula voltar a concluir sozinha.');
    }
    render();
  }

  async function setOverride(override) {
    if (!writable()) { notify(store.error ?? 'Armazenamento de cursos indisponível: nada será salvo.', true); return; }
    try {
      const next = await store.setCompletionOverride(view.courseId, view.lessonId, override);
      if (!next) { notify('Esta aula não está mais no curso.', true); return; }
      notify(override === 'complete' ? 'Aula concluída por você, independentemente dos exercícios.'
        : override === 'reopened' ? 'Aula reaberta: a conclusão automática fica bloqueada até você retomar.'
          : 'Conclusão automática retomada: a aula conclui sozinha quando cumprir as condições.');
    } catch (error) {
      notify(`Não foi possível mudar a conclusão: ${error.message}`, true);
    }
    render();
  }

  async function markThrough() {
    if (!writable()) { notify(store.error ?? 'Armazenamento de cursos indisponível: nada será salvo.', true); return; }
    try {
      const result = await watchThrough(store, view.courseId, view.lessonId);
      if (!result) {
        notify('Esta aula não está mais no curso.', true);
      } else {
        const undo = Array.isArray(result.undo) ? result.undo : [];
        view.undo = undo.length > 0 ? undo : null;
        view.undoCourseId = view.courseId;
        notify(undo.length > 0
          ? `${undo.length} aula(s) marcada(s) como assistida(s) até esta. Dá para desfazer.`
          : 'Nenhuma aula nova para marcar até aqui.');
      }
    } catch (error) {
      notify(`Não foi possível marcar as aulas: ${error.message}`, true);
    }
    render();
  }

  async function undoMarkThrough() {
    const undo = view.undo;
    if (!undo || undo.length === 0) return;
    try {
      const result = await restoreWatched(store, view.courseId, undo);
      view.undo = null;
      view.undoCourseId = null;
      notify(`Marcação desfeita em ${result?.restored ?? undo.length} aula(s).`);
    } catch (error) {
      notify(`Não foi possível desfazer: ${error.message}`, true);
    }
    render();
  }

  async function linkExercise(exerciseId) {
    if (!isText(exerciseId)) { notify('Escolha um exercício para vincular.', true); return; }
    if (!writable()) { notify(store.error ?? 'Armazenamento de cursos indisponível: nada será salvo.', true); return; }
    try {
      const next = await store.linkExercise(view.courseId, view.lessonId, exerciseId);
      if (!next) { notify('Esta aula não está mais no curso.', true); return; }
      view.linkExisting = '';
      const name = library?.get?.(exerciseId)?.metadata?.name ?? 'exercício';
      notify(`“${name}” vinculado a esta aula. A conclusão passa a exigir o alvo dele.`);
    } catch (error) {
      notify(`Não foi possível vincular: ${error.message}`, true);
    }
    render();
  }

  async function unlinkExercise(exerciseId) {
    if (!writable()) { notify(store.error ?? 'Armazenamento de cursos indisponível: nada será salvo.', true); return; }
    try {
      const next = await store.unlinkExercise(view.courseId, view.lessonId, exerciseId);
      if (!next) { notify('Esta aula não está mais no curso.', true); return; }
      notify('Exercício desvinculado desta aula.');
    } catch (error) {
      notify(`Não foi possível desvincular: ${error.message}`, true);
    }
    render();
  }

  async function createFromSuggestion(suggestion, form) {
    if (!library || typeof library.new !== 'function') { notify('A biblioteca de exercícios está indisponível nesta página.', true); return; }
    if (!writable()) { notify(store.error ?? 'Armazenamento de cursos indisponível: nada será salvo.', true); return; }
    const rawBpm = String(form?.bpm ?? '').trim();
    if (rawBpm === '') { notify('Informe o BPM inicial do exercício novo.', true); return; }
    const bpm = parseOptionalBpm(rawBpm);
    if (!bpm.ok || bpm.value === null) { notify(bpm.ok ? 'Informe o BPM inicial do exercício novo.' : bpm.error, true); return; }
    const target = parseOptionalBpm(form?.target ?? '');
    if (!target.ok) { notify(target.error, true); return; }
    const rawBars = String(form?.bars ?? '').trim();
    const barsValue = rawBars === '' ? null : Number(rawBars);
    if (barsValue !== null && (!Number.isInteger(barsValue) || barsValue < MIN_BARS || barsValue > MAX_BARS)) {
      notify(`Os compassos precisam ser um inteiro de ${MIN_BARS} a ${MAX_BARS}.`, true);
      return;
    }
    try {
      const found = store.get(view.courseId);
      const draft = buildSuggestedExercise({
        suggestion,
        lesson: courseLessons(found.course).find(item => item.id === view.lessonId) ?? null,
        course: found.course,
        preference,
        bpm: bpm.value,
        targetBpm: target.value,
        bars: barsValue,
        name: null,
      });
      const entry = library.new({ session: draft.session, metadata: draft.metadata });
      if (!entry) { notify('A biblioteca não aceitou o novo exercício.', true); return; }
      let linked = false;
      try {
        linked = (await store.linkExercise(view.courseId, view.lessonId, entry.id)) !== null;
      } catch (error) {
        notify(`O exercício foi criado, mas não foi possível vinculá-lo à aula: ${error.message}`, true);
      }
      if (library.saved === false) {
        notify('O exercício foi criado, mas este navegador não conseguiu salvar a biblioteca. O trabalho continua na memória — exporte-o em Ajuda antes de recarregar.', true);
      } else {
        notify(`Exercício “${draft.metadata.name}” criado com ${draft.strings} cordas${draft.targetBpm === null ? ' e sem alvo definido' : ` e alvo em ${draft.targetBpm} BPM`}${linked ? ', vinculado a esta aula' : ''}.`);
      }
      if (openExercise) openExercise(entry.id, { train: false });
    } catch (error) {
      notify(`Não foi possível criar o exercício: ${error.message}`, true);
    }
    render();
  }

  // ------------------------------------------------------------- anexos
  async function uploadAttachment(row, file) {
    if (!attachmentsReady()) { notify('O armazenamento de anexos não está disponível nesta página.', true); return; }
    if (!file) return;
    try {
      const result = await attachments.put({
        courseId: view.courseId,
        lessonId: row.ownerLessonId,
        resourceId: row.resourceId,
        name: file.name,
        extension: extensionOfName(file.name),
        role: row.role,
        blob: file,
        source: 'upload',
      });
      revokeRef(row.refKey);
      const size = formatAttachmentSize(result.size);
      if (result.warning) notify(`${result.warning} Arquivo guardado (${size}).`, true);
      else notify(`Arquivo de “${row.name ?? 'material'}” guardado neste navegador (${size}) e disponível offline.`);
    } catch (error) {
      notify(`Não foi possível guardar o arquivo: ${error.message}`, true);
    }
    render();
  }

  async function removeAttachment(row) {
    if (!attachmentsReady()) return;
    try {
      const result = await attachments.remove(row.refKey);
      revokeRef(row.refKey);
      if (!result.removed) { notify('Este material não tinha arquivo guardado.', true); return; }
      notify(result.fileDeleted
        ? `Anexo removido; ${formatAttachmentSize(result.freedBytes)} liberados.`
        : 'Anexo removido desta aula; o arquivo continua guardado porque outra aula usa o mesmo material.');
    } catch (error) {
      notify(`Não foi possível remover o anexo: ${error.message}`, true);
    }
    render();
  }

  // PDF: confere o CONTEÚDO antes de abrir, força o tipo do blob e só então
  // abre em nova aba — nunca executa HTML renomeado, nunca revoga antes. O
  // arquivo salvo manda: a extensão usada é a do PRÓPRIO arquivo (a extensão do
  // mapa do curso pode faltar ou estar errada), e o conteúdo decide por si.
  async function openPdf(row, attachment = null) {
    if (!attachmentsReady()) return;
    try {
      const blob = await attachments.getBlob(row.refKey);
      if (!blob) { notify('O arquivo deste material não está mais guardado neste navegador.', true); return; }
      const sniffed = await sniffAttachmentKind(blob, attachment?.extension ?? '');
      if (sniffed.kind !== ATTACHMENT_KINDS.pdf) {
        notify(sniffed.warning ?? 'Este arquivo não é um PDF válido; ele não será aberto como documento.', true);
        return;
      }
      const safe = new Blob([blob], { type: 'application/pdf' });
      const url = urlFor(row.refKey, 'pdf', safe);
      if (!url || typeof globalThis.open !== 'function') { notify('Este navegador não permite abrir o PDF em nova aba.', true); return; }
      globalThis.open(url, '_blank', 'noopener,noreferrer');
      notify('PDF aberto em nova aba a partir da cópia salva neste navegador (funciona offline).');
    } catch (error) {
      notify(`Não foi possível abrir o PDF: ${error.message}`, true);
    }
  }

  async function downloadAttachment(row, attachment = null) {
    if (!attachmentsReady()) return;
    try {
      const blob = await attachments.getBlob(row.refKey);
      if (!blob) { notify('O arquivo deste material não está mais guardado neste navegador.', true); return; }
      const sniffed = await sniffAttachmentKind(blob, attachment?.extension ?? '');
      // O download usa um blob sem tipo executável: mesmo um HTML renomeado
      // sai como arquivo, nunca como página renderizada.
      const unsafe = sniffed.mime.startsWith('text/') || sniffed.mime === 'image/svg+xml'
        || sniffed.kind === ATTACHMENT_KINDS.other && /html|svg|xml/i.test(blob.type ?? '');
      const safe = new Blob([blob], { type: unsafe ? 'application/octet-stream' : sniffed.mime });
      const url = urlFor(row.refKey, 'download', safe);
      if (!url) { notify('Este navegador não permite baixar o arquivo.', true); return; }
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = row.name ?? 'material';
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      notify(`Download de “${row.name ?? 'material'}” iniciado a partir da cópia salva.`);
    } catch (error) {
      notify(`Não foi possível baixar o arquivo: ${error.message}`, true);
    }
  }

  // ------------------------------------------------------------------ render
  function withUploader(row, index, label = 'Enviar arquivo') {
    const input = createEl('input', {
      id: `lesson-material-file-${index}`,
      type: 'file',
      hidden: true,
      'aria-label': `Escolher arquivo para ${row.name ?? 'material'}`,
    });
    const button = createEl('button', {
      id: `lesson-material-upload-${index}`,
      type: 'button',
      dataset: { action: 'upload', resourceId: row.resourceId },
      text: label,
    });
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) void uploadAttachment(row, file);
    });
    return [button, input];
  }

  // Ações secundárias do material/sugestão ficam agrupadas em um <details> por
  // item, com o conteúdo montado SÓ quando abre (mesmo padrão das listas de
  // aula do curso): o repouso da página não vira parede de botões/campos e nada
  // fica escondido — teclado e leitor de tela seguem o controle nativo.
  function itemMore(summaryText, build, disclosureKey) {
    const details = createEl('details', { className: 'lesson-item-more', dataset: { disclosure: disclosureKey } });
    details.append(createEl('summary', { text: summaryText }));
    let filled = false;
    const fill = () => {
      if (filled) return;
      filled = true;
      for (const node of build()) details.append(node);
    };
    details.addEventListener('toggle', () => { if (details.open) fill(); });
    return details;
  }

  function materialNode(row, index) {
    const attachment = attachmentsReady() ? attachments.get(row.refKey) : null;
    const item = createEl('li', {
      className: 'lesson-material',
      dataset: { resourceId: row.resourceId, refKey: row.refKey, crossLesson: String(row.crossLesson) },
    });
    const where = [];
    if (row.role) where.push(row.role);
    if (row.crossLesson) where.push(row.ownerLessonTitle ? `material de “${row.ownerLessonTitle}”` : 'material de outra aula');
    if (row.bpm) where.push(`${row.bpm} BPM`);
    if (row.strings) where.push(`${row.strings} cordas`);
    if (attachment) where.push(formatAttachmentSize(attachment.size), attachmentKindLabel(attachment.kind));
    const name = row.name ?? `material ${row.resourceId}`;
    item.append(createEl('span', { className: 'lesson-material-name', text: name }));
    if (row.extension) item.append(createEl('span', { className: 'lesson-material-ext muted', text: `.${row.extension}` }));
    item.append(createEl('span', { className: 'lesson-material-meta muted', text: where.join(' · ') }));
    if (row.missing) item.append(createEl('span', { className: 'lesson-material-missing muted', text: 'este material não está mais no mapa do curso; o arquivo guardado continua acessível' }));
    const actions = createEl('span', { className: 'lesson-material-actions' });
    if (!attachment) {
      actions.append(createEl('span', { className: 'lesson-material-none muted', text: attachmentsReady() ? 'sem arquivo aqui' : 'anexos indisponíveis neste navegador' }));
      if (attachmentsReady() && writable() && !row.missing) actions.append(...withUploader(row, index));
    } else {
      // O tipo salvo vem do CONTEÚDO conferido no envio: PDF e áudio aparecem
      // pela ação principal; o resto (e o que não pôde ser confirmado) baixa.
      if (attachment.kind === ATTACHMENT_KINDS.pdf) {
        const open = createEl('button', {
          id: `lesson-material-open-${index}`, type: 'button', className: 'primary',
          dataset: { action: 'open-pdf', refKey: row.refKey }, text: 'Abrir PDF em nova aba',
        });
        open.addEventListener('click', () => void openPdf(row, attachment));
        actions.append(open);
      }
      if (attachment.kind === ATTACHMENT_KINDS.audio) {
        const audio = createEl('audio', {
          className: 'lesson-audio',
          controls: true,
          loop: true,
          preload: 'metadata',
          'aria-label': `Ouvir ${name} em repetição`,
          dataset: { refKey: row.refKey },
        });
        const url = ensureAudioUrl(row, audio);
        if (url) audio.src = url;
        actions.append(audio);
        actions.append(createEl('span', {
          className: 'lesson-audio-note muted',
          text: attachment.verified === false
            ? 'formato não confirmado: se não tocar, envie o arquivo em outro formato'
            : 'toca em repetição, direto do arquivo salvo (offline)',
        }));
      }
      if (attachment.kind === ATTACHMENT_KINDS.other) {
        const download = createEl('button', {
          id: `lesson-material-download-${index}`, type: 'button', dataset: { action: 'download', refKey: row.refKey }, text: 'Baixar arquivo',
        });
        download.addEventListener('click', () => void downloadAttachment(row, attachment));
        actions.append(download);
      }
      // Trocar/Remover ficam agrupados e são montados quando o grupo abre: o
      // envio substitui a referência e o arquivo antigo só sai do banco se
      // ninguém mais usar.
      actions.append(itemMore('Mais ações do material', () => {
        const remove = createEl('button', {
          id: `lesson-material-remove-${index}`, type: 'button',
          dataset: { action: 'remove', refKey: row.refKey }, text: 'Remover anexo',
        });
        remove.disabled = !writable() || !attachmentsReady();
        remove.addEventListener('click', () => void removeAttachment(row));
        const more = [remove];
        if (attachmentsReady() && writable() && !row.missing) more.push(...withUploader(row, index, 'Trocar arquivo'));
        return more;
      }, `lesson-material-more-${index}`));
      if (attachment.warning) item.append(createEl('span', { className: 'lesson-material-warning', role: 'alert', text: attachment.warning }));
    }
    item.append(actions);
    return item;
  }

  // O áudio precisa do blob no src; a busca é assíncrona, então a URL entra
  // quando chega — a URL é reaproveitada entre re-renders e revogada ao trocar
  // de aula/remover.
  function ensureAudioUrl(row, audio) {
    if (attachmentsReady() && attachments.has(row.refKey)) {
      const cached = objectUrls.get(`${row.refKey}|audio`);
      if (cached) return cached;
      void attachments.getBlob(row.refKey).then(blob => {
        if (!blob || !audio.isConnected) return;
        audio.src = urlFor(row.refKey, 'audio', blob) ?? '';
      }).catch(() => { /* sem arquivo: o player fica vazio, sem mentira */ });
    }
    return null;
  }

  function notesGroup(outcome) {
    const draft = draftFor(view.courseId, view.lessonId, outcome.lessonState.notes);
    const details = createEl('details', { id: 'lesson-notes-group', className: 'lesson-group', dataset: { disclosure: 'lesson-notes' } });
    const flag = draft.dirty ? 'alterações não salvas' : draft.text ? 'salvas' : 'vazio';
    details.append(createEl('summary', { text: `Anotações pessoais (${flag})` }));
    const body = createEl('div', { className: 'lesson-group-body' });
    const textarea = createEl('textarea', {
      id: 'lesson-notes',
      className: 'lesson-notes',
      rows: '4',
      'aria-label': 'Anotações pessoais desta aula',
      placeholder: 'O que você quer lembrar desta aula?',
    });
    textarea.value = draft.text;
    const editable = writable() && outcome.lesson !== null;
    textarea.disabled = !editable;
    if (editable) {
      textarea.addEventListener('input', () => {
        // A aula atual é lida na hora do evento: um redesenho antigo na tela
        // nunca grava o texto na aula errada nem perde a referência do salvo.
        const current = draftFor(view.courseId, view.lessonId, storedNotesOf(view.courseId, view.lessonId));
        current.text = textarea.value;
        current.dirty = current.text !== current.storedNotes;
        setNotesStatus(current.dirty ? 'pendente' : 'salvo');
        if (current.dirty) scheduleNotesSave();
      });
      textarea.addEventListener('blur', () => { void flushNotes(); });
    }
    notesStatusNode = createEl('p', { id: 'lesson-notes-status', className: 'lesson-notes-status muted', role: 'status' });
    notesStatusNode.textContent = NOTES_STATUS_LABELS[editable ? draft.status : 'vazio'];
    body.append(textarea, notesStatusNode, createEl('p', {
      className: 'lesson-hint muted',
      text: editable
        ? 'O texto é salvo neste navegador enquanto você digita e fica fora do exercício; se a gravação falhar, ele continua aqui e volta ao reabrir a aula.'
        : 'As anotações desta aula ficam guardadas, mas não podem ser editadas agora.',
    }));
    details.append(body);
    return details;
  }

  function materialGroup(outcome) {
    const localRefs = attachmentsReady() ? attachments.list(view.courseId, view.lessonId) : [];
    const rows = outcome.lesson ? lessonMaterialRows(outcome.course, outcome.lesson, localRefs) : [];
    const details = createEl('details', { id: 'lesson-materials-group', className: 'lesson-group', dataset: { disclosure: 'lesson-materials' } });
    details.append(createEl('summary', { text: `Materiais (${rows.length})` }));
    const body = createEl('div', { className: 'lesson-group-body' });
    const totals = attachmentsReady() ? attachments.totals(view.courseId) : { files: 0, refs: 0, bytes: 0 };
    body.append(createEl('p', {
      id: 'lesson-materials-space', className: 'lesson-space muted', role: 'status',
      text: attachmentsReady()
        ? `Anexos guardados neste navegador: ${totals.files} arquivo(s), ${formatAttachmentSize(totals.bytes)}. Eles abrem offline e só saem quando você remover.`
        : (attachments?.error ?? 'O armazenamento de anexos não está disponível: nenhum arquivo pode ser enviado ou aberto.'),
    }));
    if (rows.length === 0) {
      body.append(createEl('p', { className: 'lesson-empty muted', text: 'Esta aula não tem material no mapa do curso.' }));
      details.append(body);
      return details;
    }
    const list = createEl('ul', { id: 'lesson-materials-list', className: 'lesson-material-list' });
    rows.forEach((row, index) => list.append(materialNode(row, index)));
    body.append(list);
    details.append(body);
    return details;
  }

  function suggestionNode(suggestion, index) {
    const item = createEl('li', { id: `lesson-suggestion-${index}`, className: 'lesson-suggestion', dataset: { suggestionId: suggestion.id } });
    item.append(createEl('span', { className: 'lesson-suggestion-title', text: suggestion.title }));
    if (suggestion.description) item.append(createEl('span', { className: 'lesson-suggestion-desc muted', text: suggestion.description }));
    const bits = [];
    if (suggestion.initialBpm) bits.push(`${suggestion.initialBpm} BPM inicial`);
    if (suggestion.targetBpm) bits.push(`alvo ${suggestion.targetBpm} BPM`);
    else bits.push('sem alvo sugerido');
    if (suggestion.bars) bits.push(`${suggestion.bars} compassos`);
    if (suggestion.strings) bits.push(`${suggestion.strings} cordas`);
    if (suggestion.pdfPage) bits.push(`página ${suggestion.pdfPage} do material`);
    if ((suggestion.trackNames ?? []).length > 0) bits.push(`faixas: ${suggestion.trackNames.join(', ')}`);
    item.append(createEl('span', { className: 'lesson-suggestion-meta muted', text: bits.join(' · ') }));
    const form = view.forms.get(suggestion.id) ?? {
      bpm: suggestion.initialBpm ? String(suggestion.initialBpm) : '',
      target: suggestion.targetBpm ? String(suggestion.targetBpm) : '',
      bars: String(suggestedBars({ suggestion })),
    };
    view.forms.set(suggestion.id, form);
    const fields = createEl('div', { className: 'lesson-suggestion-fields' });
    const field = (label, key, inputId, max) => {
      const input = createEl('input', {
        id: inputId, type: 'number', min: key === 'bars' ? String(MIN_BARS) : String(BPM_MIN),
        max: key === 'bars' ? String(MAX_BARS) : String(BPM_MAX), step: '1', value: form[key],
        'aria-label': `${label} do exercício novo`,
      });
      input.addEventListener('input', () => {
        const entry = view.forms.get(suggestion.id) ?? { ...form };
        entry[key] = input.value;
        view.forms.set(suggestion.id, entry);
      });
      return createEl('label', { className: 'lesson-field' }, [createEl('span', { text: label }), input]);
    };
    fields.append(field('BPM inicial', 'bpm', `lesson-suggestion-bpm-${index}`), field('Alvo (vazio = sem alvo)', 'target', `lesson-suggestion-target-${index}`), field('Compassos', 'bars', `lesson-suggestion-bars-${index}`));
    const create = createEl('button', {
      id: `lesson-suggestion-create-${index}`, type: 'button', className: 'primary',
      dataset: { action: 'create', suggestionId: suggestion.id },
      text: 'Criar no Estúdio',
    });
    create.disabled = !writable() || !library || typeof library.new !== 'function';
    create.addEventListener('click', () => void createFromSuggestion(suggestion, view.forms.get(suggestion.id) ?? form));
    // Os ajustes ficam agrupados: a sugestão mostra a ação principal e quem
    // quiser mexe em BPM/alvo/compassos sem virar parede de campos.
    item.append(createEl('span', { className: 'lesson-suggestion-actions' }, [
      create,
      itemMore('Ajustar BPM, alvo e compassos', () => [fields], `lesson-suggestion-adjust-${index}`),
    ]));
    item.append(createEl('span', { className: 'lesson-hint muted', text: 'Gera um exercício novo, com notas vazias, já vinculado a esta aula.' }));
    return item;
  }

  function suggestionGroup(outcome) {
    const suggestions = outcome.lesson?.suggestedExercises ?? [];
    const details = createEl('details', { id: 'lesson-suggestions-group', className: 'lesson-group', dataset: { disclosure: 'lesson-suggestions' } });
    details.append(createEl('summary', { text: `Exercícios sugeridos (${suggestions.length})` }));
    const body = createEl('div', { className: 'lesson-group-body' });
    if (suggestions.length === 0) {
      body.append(createEl('p', { className: 'lesson-empty muted', text: 'Este curso não sugere exercício para esta aula.' }));
      details.append(body);
      return details;
    }
    body.append(createEl('p', { className: 'lesson-hint muted', text: 'Criar aqui NÃO copia nada do curso: monta um exercício novo, vazio, com o perfil e o andamento sugeridos. Ajuste BPM, alvo e compassos antes de criar.' }));
    const list = createEl('ul', { className: 'lesson-suggestion-list' });
    suggestions.forEach((suggestion, index) => list.append(suggestionNode(suggestion, index)));
    body.append(list);
    details.append(body);
    return details;
  }

  // `editable: false` (aula removida do curso) mantém a leitura do vínculo e do
  // estado do exercício, sem oferecer uma ação que a loja não aceita.
  function linkNode(link, { editable = true } = {}) {
    const entry = link.exists ? resolveExercise(link.id) : null;
    const name = entry?.metadata?.name ?? `exercício ${link.id}`;
    const instrument = entry?.session?.extensions?.studio?.instrument?.type ?? null;
    const item = createEl('li', { className: 'lesson-link', dataset: { exerciseId: link.id } });
    item.append(createEl('span', { className: 'lesson-link-name', text: name }));
    const bits = [];
    if (instrument) bits.push(INSTRUMENT_LABELS[instrument] ?? instrument);
    if (!link.exists) bits.push('não está mais na biblioteca');
    else if (!link.hasTarget) bits.push('sem alvo definido');
    else bits.push(`alvo ${link.targetBpm} BPM`);
    if (link.exists) bits.push(link.trained ? (link.reached ? 'alvo atingido' : 'ainda abaixo do alvo') : 'nunca treinado');
    if (!editable) bits.push('vínculo guardado (aula removida)');
    item.append(createEl('span', { className: 'lesson-link-meta muted', text: bits.join(' · ') }));
    const actions = createEl('span', { className: 'lesson-link-actions' });
    const open = createEl('button', { type: 'button', dataset: { action: 'open-exercise', exerciseId: link.id }, text: 'Abrir no Estúdio' });
    open.disabled = !openExercise;
    open.addEventListener('click', () => openExercise?.(link.id, { train: false }));
    actions.append(open);
    if (editable) {
      const unlink = createEl('button', { type: 'button', dataset: { action: 'unlink', exerciseId: link.id }, text: 'Desvincular' });
      unlink.disabled = !writable();
      unlink.addEventListener('click', () => void unlinkExercise(link.id));
      actions.append(unlink);
    }
    item.append(actions);
    return item;
  }

  function linkGroup(outcome) {
    const details = createEl('details', { id: 'lesson-links-group', className: 'lesson-group', dataset: { disclosure: 'lesson-links' } });
    details.append(createEl('summary', { text: `Exercícios vinculados (${outcome.links.length})` }));
    const body = createEl('div', { className: 'lesson-group-body' });
    body.append(createEl('p', {
      className: 'lesson-rule muted',
      text: 'A aula conclui sozinha quando ela está assistida E todos os exercícios vinculados atingem o próprio alvo (BPM do alvo com pelo menos 90% de acertos na execução autoral). Exercício sem alvo não satisfaz; material gerado nunca conta.',
    }));
    if (outcome.links.length === 0) {
      body.append(createEl('p', { className: 'lesson-empty muted', text: outcome.hasSuggestions
        ? 'Nenhum exercício vinculado ainda: enquanto isso a aula fica pendente, mesmo assistida.'
        : 'Esta aula não tem exercício sugerido nem vinculado: basta marcar como assistida para concluir.' }));
    } else {
      const list = createEl('ul', { id: 'lesson-link-list', className: 'lesson-link-list' });
      for (const link of outcome.links) list.append(linkNode(link));
      body.append(list);
    }
    if (library && typeof library.list === 'function') {
      const select = createEl('select', { id: 'lesson-link-select', 'aria-label': 'Exercício da biblioteca para vincular a esta aula' });
      select.append(createEl('option', { value: '', text: 'Escolha um exercício da biblioteca…' }));
      for (const row of library.list()) {
        select.append(createEl('option', { value: row.id, text: `${row.name} (${INSTRUMENT_LABELS[row.instrument] ?? row.instrument})` }));
      }
      select.value = view.linkExisting;
      select.disabled = !writable() || library.size?.() === 0;
      select.addEventListener('change', () => { view.linkExisting = select.value; });
      const add = createEl('button', { id: 'lesson-link-add', type: 'button', text: 'Vincular à aula' });
      add.disabled = !writable();
      add.addEventListener('click', () => void linkExercise(view.linkExisting));
      body.append(createEl('div', { className: 'lesson-link-add' }, [
        createEl('label', { className: 'lesson-field' }, [createEl('span', { text: 'Vincular exercício existente' }), select]),
        add,
      ]));
      body.append(createEl('p', { className: 'lesson-hint muted', text: 'O vínculo vale além da sessão: ele fica guardado no curso e a origem do exercício aparece na Biblioteca e no Estúdio.' }));
    }
    details.append(body);
    return details;
  }

  function headerNode(outcome) {
    const { lesson, lessonState } = outcome;
    const head = createEl('header', { className: 'lesson-head', dataset: { mode: outcome.removed ? 'removed' : 'lesson' } });
    const back = createEl('button', { id: 'lesson-back', type: 'button', text: 'Voltar para o curso' });
    back.addEventListener('click', () => { if (onBack) onBack(view.courseId, view.lessonId); else hide(); });
    head.append(back);
    head.append(createEl('h2', { id: 'lesson-title', text: lesson?.title ?? outcome.removed?.title ?? 'Aula' }));
    const meta = [lesson?.sectionTitle ?? outcome.removed?.sectionTitle ?? null, lesson?.type ?? outcome.removed?.type ?? null, lesson ? durationLabel(lesson) : null]
      .filter(value => isText(value));
    head.append(createEl('p', { id: 'lesson-meta', className: 'lesson-meta muted', text: meta.join(' · ') }));
    if (lesson?.url) {
      const link = createEl('a', {
        id: 'lesson-site', className: 'lesson-site', href: lesson.url, target: '_blank', rel: 'noopener noreferrer',
        text: 'Abrir a aula no site (nova aba) ☍',
      });
      head.append(createEl('p', { className: 'lesson-site-row' }, [link, createEl('span', { className: 'sr-only', text: 'O aplicativo não baixa nem embute o conteúdo do site.' })]));
    }
    if (outcome.removed) {
      head.append(createEl('p', {
        id: 'lesson-status', className: 'lesson-status', role: 'status',
        text: 'Aula removida do curso — o estado, as anotações, os vínculos e os anexos continuam guardados.',
      }));
      return head;
    }
    const counting = timeCounting();
    head.append(createEl('p', {
      id: 'lesson-status', className: 'lesson-status', role: 'status',
      text: `${STATUS_LABELS[outcome.status] ?? outcome.status}${outcome.completion.completed ? (outcome.completion.override === 'complete' ? ' (concluída por você)' : '') : ''} · ${counting ? (watch ? 'contando tempo agora' : 'contagem de tempo ligada') : 'contagem de tempo desligada'} · tempo registrado: ${studyTimeLabel(outcome.watchMs)}`,
    }));
    if (outcome.pending.length > 0) {
      head.append(createEl('p', {
        id: 'lesson-pending', className: 'lesson-pending muted',
        text: `Pendente: ${outcome.pending.map(reason => PENDING_LABELS[reason] ?? reason).join('; ')}.`,
      }));
    }
    const actions = createEl('div', { className: 'lesson-actions' });
    const watched = createEl('input', { id: 'lesson-watched', type: 'checkbox' });
    watched.checked = lessonState.watched === true;
    watched.disabled = !writable();
    watched.addEventListener('change', () => void toggleWatched(watched.checked));
    actions.append(createEl('label', { className: 'lesson-check' }, [watched, createEl('span', { text: 'Assistida' })]));
    // Tempo de estudo é escolha explícita e por aula: desligado por padrão, e o
    // app nunca conta o tempo assistido no site externo.
    const time = createEl('input', {
      id: 'lesson-time',
      type: 'checkbox',
      'aria-describedby': 'lesson-time-hint',
    });
    time.checked = counting;
    time.disabled = !writable();
    time.addEventListener('change', () => setTimeCounting(time.checked));
    actions.append(createEl('label', {
      className: 'lesson-check',
      title: 'Nada é contado automaticamente; assistir no site externo não soma tempo nem marca como assistida.',
    }, [time, createEl('span', { text: 'Contar tempo nesta aula' })]));
    actions.append(createEl('span', {
      id: 'lesson-time-hint', className: 'lesson-hint muted',
      text: 'contagem opcional; o app não conta o tempo passado no site externo',
    }));
    if (outcome.lesson?.optional) {
      const skipped = createEl('input', { id: 'lesson-skip', type: 'checkbox' });
      skipped.checked = lessonState.skipped === true;
      skipped.disabled = !writable();
      skipped.addEventListener('change', () => void patch({ skipped: skipped.checked }, skipped.checked ? 'Aula pulada: ela não bloqueia a próxima.' : 'Aula de volta à fila.').then(() => render()));
      actions.append(createEl('label', { className: 'lesson-check', title: 'Aula de seminário/boas-vindas: pular não bloqueia a próxima', }, [skipped, createEl('span', { text: 'Pular (opcional)' })]));
    }
    const through = createEl('button', { id: 'lesson-watch-upto', type: 'button', text: 'Marcar assistidas até aqui' });
    through.disabled = !writable();
    through.addEventListener('click', () => void markThrough());
    actions.append(through);
    if (view.undo && view.undoCourseId === view.courseId) {
      const undo = createEl('button', { id: 'lesson-watch-undo', type: 'button', text: `Desfazer marcação em lote (${view.undo.length})` });
      undo.addEventListener('click', () => void undoMarkThrough());
      actions.append(undo);
    }
    const complete = createEl('button', { id: 'lesson-complete', type: 'button', text: 'Concluir mesmo assim' });
    complete.disabled = !writable();
    complete.addEventListener('click', () => void setOverride('complete'));
    const reopen = createEl('button', { id: 'lesson-reopen', type: 'button', text: 'Reabrir' });
    reopen.disabled = !writable();
    reopen.addEventListener('click', () => void setOverride('reopened'));
    actions.append(complete, reopen);
    if (lessonState.completionOverride !== null) {
      const resume = createEl('button', { id: 'lesson-resume', type: 'button', text: 'Retomar conclusão automática' });
      resume.disabled = !writable();
      resume.addEventListener('click', () => void setOverride(null));
      actions.append(resume);
    }
    const lessons = courseLessons(outcome.course);
    const position = lessons.findIndex(item => item.id === view.lessonId);
    const following = position >= 0 && position + 1 < lessons.length ? lessons[position + 1] : null;
    if (following) {
      const button = createEl('button', { id: 'lesson-next', type: 'button', className: 'primary', text: `Próxima aula: ${following.title}` });
      button.addEventListener('click', () => openLesson(following.id));
      actions.append(button);
    }
    // A "próxima" do modelo é a aula obrigatória ainda não concluída (opcionais
    // não bloqueiam): quando ela não é a aula seguinte na ordem, o usuário vê
    // as duas opções em vez de uma só.
    const pending = outcome.next && outcome.next.lesson.id !== view.lessonId && outcome.next.lesson.id !== following?.id
      ? outcome.next
      : null;
    if (pending) {
      const button = createEl('button', {
        id: 'lesson-next-pending', type: 'button',
        text: `Ir para a pendente: ${pending.lesson.title}${pending.optional ? ' (opcional)' : ''}`,
        title: 'Próxima aula ainda não concluída na ordem do curso; seminários e boas-vindas não bloqueiam.',
      });
      button.addEventListener('click', () => openLesson(pending.lesson.id));
      actions.append(button);
    }
    head.append(actions);
    if (!writable()) head.append(createEl('p', { className: 'lesson-warning', role: 'alert', text: store.error ?? 'Armazenamento de cursos indisponível: esta página só mostra o que já está carregado.' }));
    return head;
  }

  function buildPage() {
    notesStatusNode = null;
    const found = store.get(view.courseId);
    if (!found) {
      if (!storeLoaded) {
        root.append(createEl('p', { className: 'lesson-empty', role: 'status', text: 'Carregando a aula…' }));
        return;
      }
      root.append(createEl('p', { className: 'lesson-empty', role: 'status', text: 'Curso não encontrado na biblioteca.' }));
      const back = createEl('button', { id: 'lesson-back', type: 'button', text: 'Voltar para o curso' });
      back.addEventListener('click', () => { if (onBack) onBack(null, null); else hide(); });
      root.append(back);
      return;
    }
    const outcome = lessonOutcome(store, view.courseId, view.lessonId, { resolveExercise });
    if (!outcome.lesson && !outcome.removed) {
      root.append(createEl('p', { className: 'lesson-empty', role: 'status', text: 'Aula não encontrada neste curso (pode ter sido removida em uma reimportação).' }));
      const back = createEl('button', { id: 'lesson-back', type: 'button', text: 'Voltar para o curso' });
      back.addEventListener('click', () => { if (onBack) onBack(view.courseId, null); else hide(); });
      root.append(back);
      return;
    }
    root.append(headerNode(outcome));
    if (outcome.lesson?.summary) {
      root.append(createEl('p', { id: 'lesson-summary', className: 'lesson-summary', text: outcome.lesson.summary }));
    }
    if (outcome.lesson?.practiceInstruction) {
      root.append(createEl('p', { id: 'lesson-instruction', className: 'lesson-instruction', text: `Como praticar: ${outcome.lesson.practiceInstruction}` }));
    }
    const body = createEl('div', { className: 'lesson-body' });
    if (outcome.removed && outcome.lesson === null) {
      body.append(removedBody(outcome));
    } else {
      body.append(materialGroup(outcome), notesGroup(outcome), suggestionGroup(outcome), linkGroup(outcome));
    }
    root.append(body);
  }

  // Aula removida do mapa: nada de editar estado, mas tudo continua acessível —
  // inclusive os anexos, que nunca são apagados por reimportação.
  function removedBody(outcome) {
    const box = createEl('div', { className: 'lesson-removed-body' });
    const state = outcome.lessonState;
    const bits = [];
    if (state.watched) bits.push('assistida');
    if (state.skipped) bits.push('pulada');
    if (state.completionOverride) bits.push(`conclusão: ${state.completionOverride === 'complete' ? 'concluída por você' : 'reaberta'}`);
    if (state.notes) bits.push('com anotações guardadas');
    if (state.linkedExerciseIds.length > 0) bits.push(`${state.linkedExerciseIds.length} vínculo(s)`);
    box.append(createEl('p', { className: 'lesson-removed-flags muted', text: bits.length > 0 ? bits.join(' · ') : 'sem estado guardado' }));
    if (state.notes) box.append(createEl('pre', { className: 'lesson-removed-notes', text: state.notes }));
    if (state.linkedExerciseIds.length > 0) {
      const list = createEl('ul', { className: 'lesson-link-list' });
      for (const link of outcome.links) list.append(linkNode(link, { editable: false }));
      box.append(createEl('h3', { text: 'Exercícios vinculados guardados' }), list);
    }
    const refs = attachmentsReady() ? attachments.list(view.courseId, view.lessonId) : [];
    box.append(createEl('h3', { text: `Anexos guardados (${refs.length})` }));
    if (!attachmentsReady()) {
      box.append(createEl('p', { className: 'lesson-empty muted', text: attachments?.error ?? 'Anexos indisponíveis neste navegador.' }));
    } else if (refs.length === 0) {
      box.append(createEl('p', { className: 'lesson-empty muted', text: 'Nenhum arquivo guardado para esta aula removida.' }));
    } else {
      const list = createEl('ul', { id: 'lesson-materials-list', className: 'lesson-material-list' });
      refs.forEach((ref, index) => {
        list.append(materialNode({
          refKey: ref.key, resourceId: ref.resourceId, ownerLessonId: ref.lessonId, ownerLessonTitle: null,
          ownerSectionTitle: null, name: ref.contentName ?? ref.name, extension: ref.extension, role: ref.role,
          strings: null, bpm: null, crossLesson: false, missing: true,
        }, index));
      });
      box.append(list);
    }
    return box;
  }

  function render() {
    if (root.hidden) return;
    if (suppressRender) return;
    const active = document.activeElement;
    const notesFocus = active?.id === 'lesson-notes' ? { start: active.selectionStart, end: active.selectionEnd } : null;
    renderKeepingFocus(root, () => {
      root.replaceChildren();
      buildPage();
    });
    if (notesFocus) {
      const textarea = root.querySelector('#lesson-notes');
      if (textarea && textarea.isConnected) {
        textarea.focus({ preventScroll: true });
        try { textarea.setSelectionRange(notesFocus.start ?? null, notesFocus.end ?? null); } catch { /* seleção indisponível */ }
      }
    }
  }

  function openLesson(lessonId) {
    if (onOpenLesson) { onOpenLesson(view.courseId, lessonId); return; }
    void show(view.courseId, lessonId);
  }

  async function show(courseId, lessonId) {
    if (view.courseId !== courseId) {
      view.undo = null;
      view.undoCourseId = null;
    }
    // Grava o rascunho da aula que está saindo (mesmo voltando para a MESMA
    // aula, o que já estava digitado é confirmado antes de redesenhar).
    void flushNotes();
    await closeAndStart(courseId, lessonId);
  }

  async function closeAndStart(courseId, lessonId) {
    // Token de ciclo de vida: hide()/destroy() e um show() mais novo incrementam
    // `lifecycle`, então uma continuação antiga (depois de um await) não
    // reabre contagem de tempo nem marca aula ativa que já não está na tela.
    const token = (lifecycle += 1);
    closeWatch();
    revokeAll();
    view.courseId = courseId;
    view.lessonId = lessonId;
    view.forms.clear();
    view.linkExisting = '';
    root.hidden = false;
    clearListeners();
    attachLifecycle();
    render();
    try { await store.ready(); storeLoaded = true; } catch (error) { notify(error.message ?? String(error), true); }
    if (token !== lifecycle) return;
    if (attachmentsReady()) { try { await attachments.ready(); } catch (error) { notify(error.message ?? String(error), true); } }
    if (token !== lifecycle) return;
    const found = store.get(courseId);
    const live = found ? courseLessons(found.course).some(item => item.id === lessonId) : false;
    if (live) {
      startWatch();
      if (writable()) {
        try { await store.setActiveLesson(courseId, lessonId); } catch (error) { notify(`Não foi possível registrar a aula aberta: ${error.message}`, true); }
      }
    }
    if (token !== lifecycle) return;
    render();
  }

  function hide() {
    lifecycle += 1;
    void flushNotes();
    closeWatch();
    revokeAll();
    clearListeners();
    root.hidden = true;
  }

  function destroy() {
    lifecycle += 1;
    void flushNotes();
    closeWatch();
    revokeAll();
    clearListeners();
    unsubscribe?.();
    unsubscribeLibrary?.();
    root.remove();
  }

  const unsubscribe = store.subscribe(() => render());
  // A biblioteca também muda por fora da aula (treino no Estúdio, alvo novo,
  // exercício removido): a lista de vínculos e o estado da aula precisam
  // refletir isso sem a página ser reaberta.
  const unsubscribeLibrary = library && typeof library.subscribe === 'function'
    ? library.subscribe(() => render())
    : null;
  void store.ready().then(() => { storeLoaded = true; render(); }).catch(error => notify(error.message ?? String(error), true));
  if (attachmentsReady()) void attachments.ready().catch(error => notify(error.message ?? String(error), true));

  return { show, hide, destroy, render, get courseId() { return view.courseId; }, get lessonId() { return view.lessonId; } };
}
