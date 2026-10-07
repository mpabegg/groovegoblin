// Interface da sessão de hoje (rodada 4, item 4 — etapa 5; cursos na etapa 7).
//
// Dois pontos de montagem:
//  - painel da Biblioteca: cursos ATIVOS com orçamento diário editável, o
//    plano do dia (aula "Assistir" + exercícios vinculados + avulsos na folga),
//    o construtor da fila (adicionar, remover, reordenar, duração, total),
//    rotinas nomeadas, a tira de ESTUDO da aula e o resumo da última sessão;
//  - painel Treinar: tira discreta com o tempo restante, Próximo e Encerrar —
//    só quando o item ativo é um EXERCÍCIO.
//
// Um único relógio (o de mountToday) chama session.tick() e redesenha as duas
// tiras: nunca existem dois intervalos contando o mesmo item. Nenhum HTML não
// confiável é interpretado: cada nó é criado por createEl.

import { createEl, renderKeepingFocus } from './practice.js';
import {
  sharedTodayStore, suggestQueue, queueTotalMs, itemKind, itemMinutes,
  DEFAULT_ITEM_MINUTES, MIN_ITEM_MINUTES, MAX_ITEM_MINUTES, MAX_LESSON_MINUTES,
  SUGGESTION_LIMIT, ITEM_KIND_LESSON,
} from './today-store.js';
import { createTodaySession } from './today-session.js';
import { courseLessons, courseSummary, videoMinutes } from './course-progress.js';
import { sharedCourseStore } from './course-store.js';
import { assistCoursePlan, practiceCoursePlan, DEFAULT_COURSE_MINUTES, DEFAULT_ASSIST_MINUTES } from './today-courses.js';
import { COURSE_LIMITS } from './course-format.js';
import { mountPrivateDownload } from './private-download.js';

const INSTRUMENT_LABELS = Object.freeze({ guitar: 'Guitarra', bass: 'Baixo' });

// Um controlador atende à Biblioteca e à tira; todos os modos usam o transporte do host.
export function mountToday(panelContainer, trainerContainer, host) {
  const { library, notify } = host;
  // MESMA instância que a sincronização usa (natureza única do Hoje): duas
  // instâncias gravariam a mesma chave e uma memória ficaria velha.
  const store = sharedTodayStore();
  // A loja de cursos vem do host quando ele já a tem; senão é a instância
  // única do app. Falha de carregamento é avisada e o Hoje volta ao
  // comportamento anterior (fila de exercícios), sem backend fingido.
  let courseStore = host.courseStore ?? null;
  const coursesReady = Promise.resolve(host.courseStore ?? sharedCourseStore())
    .then(value => { courseStore = value; return value; })
    .catch(error => {
      notify(`Cursos indisponíveis na sessão de hoje (${error?.message ?? error ?? 'erro'}).`, true);
      return null;
    });
  let panel, trainer;
  const session = createTodaySession({
    store, library, notify,
    getActivity: () => host.activity,
    // Exercício: abre no Estúdio/Treinar, exatamente como antes.
    openItem: (id, { start = false } = {}) => {
      if (!host.openExercise(id, { train: start })) return false;
      host.activateTab?.('tab-practice');
      return true;
    },
    // Aula: abre a PÁGINA DA AULA na Biblioteca e nunca o Treinar.
    openLesson: (item, { start = false } = {}) => {
      if (typeof host.openLesson !== 'function') {
        notify('Abrir aulas ainda não está ligado nesta tela.', true);
        return false;
      }
      try {
        Promise.resolve(host.openLesson(item.courseId, item.lessonId, { start }))
          .catch(error => notify(`Não foi possível abrir a aula: ${error?.message ?? error}`, true));
      } catch (error) {
        notify(`Não foi possível abrir a aula: ${error.message}`, true);
        return false;
      }
      host.activateTab?.('tab-library');
      return true;
    },
    lessonExists: (courseId, lessonId) => {
      if (!courseStore || typeof courseStore.get !== 'function') return true;
      const entry = courseStore.get(courseId);
      return !!entry && courseLessons(entry.course).some(lesson => lesson.id === lessonId);
    },
    recordWatch: (courseId, lessonId, interval) => {
      if (!courseStore || typeof courseStore.recordWatch !== 'function') return null;
      return courseStore.recordWatch(courseId, lessonId, interval);
    },
    getOwner: () => library.active(),
    isExecuting: host.isBusy,
    stopExecution: host.stopExecution,
    onEvent: name => {
      // O intervalo abaixo atualiza só os relógios. Reconstruir a montagem a
      // cada segundo apagaria edições ainda não confirmadas dos orçamentos.
      if (name === 'tick') return;
      panel?.render(); trainer?.render();
    },
  });
  const courseAccess = { get store() { return courseStore; }, ready: coursesReady };
  panel = mountTodayPanel(panelContainer, { store, session, library, notify, download: host.download, activateTab: host.activateTab, openExercise: host.openExercise, openLesson: host.openLesson, courseAccess });
  trainer = mountTodayTrainer(trainerContainer, { session, library, notify });

  // RELÓGIO ÚNICO: um intervalo só, que avança a sessão e redesenha as tiras.
  const timer = setInterval(() => {
    if (!session.snapshot().active) return;
    session.tick();
    panel?.tick();
    trainer?.render();
  }, 1000);

  return {
    store,
    session,
    panel,
    trainer,
    // API para o host: o Hoje devolve os pontos de montagem e o controlador,
    // sem o main precisar crescer.
    render() { panel?.render(); trainer?.render(); },
    destroy() {
      clearInterval(timer);
      panel?.destroy();
      trainer?.destroy();
      session.destroy();
    },
  };
}

function requireHost(host, names) {
  if (!host || typeof host !== 'object') throw new TypeError('A sessão de hoje requer um host.');
  for (const name of names) {
    if (typeof host[name] !== 'function') throw new TypeError(`Sessão de hoje: host.${name} ausente.`);
  }
}

export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatMinutes(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// Rótulo curto de duração de um item (estimativa): aula usa a estimativa da
// aula, exercício usa os minutos do item.
function itemDurationLabel(item) {
  return `${itemMinutes(item)} min`;
}

function bpmText(item) {
  const from = item.bpm?.from ?? null;
  const to = item.bpm?.to ?? null;
  if (from === null && to === null) return 'BPM não registrado';
  if (from === null || to === null || from === to) return `${from ?? to} BPM`;
  const delta = to - from;
  return `${from} → ${to} BPM (${delta > 0 ? '+' : ''}${delta})`;
}

// Fonte do item na fila: exercício avulso, exercício de aula ou aula.
function courseLabel(courseStore, courseId, lessonId) {
  if (!courseStore || !courseId || typeof courseStore.get !== 'function') return null;
  const entry = courseStore.get(courseId);
  if (!entry) return null;
  const lesson = lessonId ? courseLessons(entry.course).find(candidate => candidate.id === lessonId) ?? null : null;
  const title = entry.course?.title ?? courseId;
  return lesson ? `${title} · ${lesson.title ?? lessonId}` : title;
}

// ----- painel da Biblioteca --------------------------------------------------

export function mountTodayPanel(container, host) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para a sessão de hoje.');
  requireHost(host, ['notify']);
  const store = host.store;
  const session = host.session;
  const library = host.library;
  if (!store || typeof store.items !== 'function') throw new TypeError('Sessão de hoje: loja da fila ausente.');
  if (!session || typeof session.start !== 'function') throw new TypeError('Sessão de hoje: controlador ausente.');
  if (!library || typeof library.list !== 'function') throw new TypeError('Sessão de hoje: biblioteca ausente.');

  const courseAccess = host.courseAccess ?? { get store() { return null; }, ready: Promise.resolve(null) };
  const root = createEl('section', { className: 'today-root', 'aria-label': 'Sessão de hoje' });
  // A tira de estudo vive num nó próprio, criado uma vez: o relógio de 1 s
  // redesenha só ela, sem reconstruir o construtor (que tem campos de texto).
  const stripHost = createEl('div', { className: 'today-lesson-run' });
  container.appendChild(root);
  const view = { open: false, routineName: '' };

  function notify(text, error = false) { host.notify(text, error); }

  // Toda mutação da fila avisa quando é recusada (loja corrompida, item
  // ausente): nada falha em silêncio.
  function mutate(action) {
    try { return action(); }
    catch (error) { notify(error.message, true); return null; }
  }

  function download(text, filename) {
    if (typeof host.download === 'function') host.download(text, filename);
    else notify('Download indisponível neste navegador.', true);
  }

  // As três cópias CRUAS da fila (v1, cópia da migração e recuperação) podem
  // carregar curso/lição e título de aula: nome PRIVADO + confirmação nativa.
  // Cancelar não gera arquivo; os bytes originais saem intactos.
  const privateFiles = mountPrivateDownload(container, { download, notify });

  function rowsById() {
    return new Map(library.list({ sort: 'name' }).map(row => [row.id, row]));
  }

  function courseStoreOf() {
    const storeRef = courseAccess.store;
    return storeRef && typeof storeRef.list === 'function' ? storeRef : null;
  }

  function courseSnapshots() {
    const storeRef = courseStoreOf();
    if (!storeRef) return [];
    return storeRef.list().map(record => {
      const entry = storeRef.get(record.id);
      return entry ? { course: entry.course, state: entry.state } : null;
    }).filter(Boolean);
  }

  function resolveExercise() {
    return id => library.get(id);
  }

  function openLesson(item) {
    if (typeof host.openLesson !== 'function') { notify('Abrir aulas ainda não está ligado nesta tela.', true); return; }
    try {
      Promise.resolve(host.openLesson(item.courseId, item.lessonId))
        .catch(error => notify(`Não foi possível abrir a aula: ${error?.message ?? error}`, true));
    } catch (error) { notify(`Não foi possível abrir a aula: ${error.message}`, true); return; }
    host.activateTab?.('tab-library');
  }

  function renderHeader() {
    const items = store.items();
    const total = queueTotalMs(items);
    const button = createEl('button', { id: 'today-build', type: 'button', 'aria-expanded': String(view.open), text: view.open ? 'Fechar montagem' : 'Montar sessão de hoje' });
    button.addEventListener('click', () => {
      view.open = !view.open;
      render();
      // Abrir a montagem é navegação explícita: o cabeçalho do Hoje vai ao topo
      // da janela e a montagem segue abaixo, rolando com o documento.
      if (view.open) {
        root.querySelector('#today-build')?.focus({ preventScroll: true });
        root.scrollIntoView?.({ block: 'start' });
      }
    });
    const lessons = items.filter(item => itemKind(item) === ITEM_KIND_LESSON).length;
    const courses = courseSnapshots().length;
    const parts = [];
    if (items.length === 0) parts.push('Nenhuma fila montada ainda.');
    else parts.push(`Fila de hoje: ${items.length} item(ns)${lessons > 0 ? ` (${lessons} de aula)` : ''} · meta ${formatMinutes(total)}.`);
    if (courses > 0) parts.push(`${courses} curso(s) importado(s); o orçamento diário fica dentro da montagem.`);
    const header = createEl('div', { className: 'today-header' }, [
      button,
      createEl('p', { className: 'today-status muted', role: 'status', text: parts.join(' ') }),
    ]);
    const rows = rowsById();
    const orphan = items.filter(item => itemKind(item) !== ITEM_KIND_LESSON && !rows.has(item.exerciseId)).length;
    if (orphan > 0) header.append(createEl('p', { className: 'today-status', role: 'status', text: `${orphan} item(ns) apontam para exercícios que não estão mais na biblioteca.` }));
    if (items.length > 0) header.append(createEl('p', { className: 'today-status muted', role: 'status', text: 'A ordem é a da fila; a aula abre na Biblioteca e o exercício no Treinar.' }));
    return header;
  }

  // ----- cursos ---------------------------------------------------------------

  function renderCourses() {
    const storeRef = courseStoreOf();
    const block = createEl('section', { className: 'today-courses', 'aria-label': 'Cursos de hoje' });
    block.append(createEl('h3', { text: 'Cursos de hoje' }));
    if (!storeRef) {
      block.append(createEl('p', { className: 'today-empty muted', text: 'Cursos ainda não carregados nesta tela; a fila avulsa continua funcionando.' }));
      return block;
    }
    const records = storeRef.list();
    if (records.length === 0) {
      block.append(createEl('p', { className: 'today-empty muted', text: 'Nenhum curso importado. Importe um curso na Biblioteca (modo Cursos) para o plano do dia.' }));
      return block;
    }
    block.append(createEl('p', { className: 'today-note muted', text: 'Orçamento diário (minutos de plano por curso), guardado no curso. O valor do arquivo é o padrão; a edição daqui vence.' }));
    const list = createEl('ul', { className: 'today-course-list' });
    records.forEach((record, index) => {
      const entry = storeRef.get(record.id);
      if (!entry) return;
      const { course, state } = entry;
      const summary = courseSummary(course, state, { resolveExercise: resolveExercise() });
      const active = state?.preferences?.active !== false;
      const fileMinutes = Number.isInteger(course.dailyMinutes) ? course.dailyMinutes : DEFAULT_COURSE_MINUTES;
      const savedMinutes = state?.preferences?.dailyMinutes;
      const activeBox = createEl('input', { type: 'checkbox', id: `today-course-active-${index}`, checked: active });
      activeBox.addEventListener('change', () => {
        Promise.resolve(storeRef.setPreferences(record.id, { active: activeBox.checked }))
          .then(() => render())
          .catch(error => { notify(`Não foi possível salvar o curso ativo: ${error?.message ?? error}`, true); render(); });
      });
      const budget = createEl('input', {
        type: 'number', id: `today-course-budget-${index}`, min: String(COURSE_LIMITS.dailyMinutesMin),
        max: String(COURSE_LIMITS.dailyMinutesMax), step: '1',
        value: Number.isInteger(savedMinutes) ? String(savedMinutes) : '',
        placeholder: String(fileMinutes),
        'aria-label': `Minutos por dia de ${course.title ?? record.id}`,
      });
      const applyBudget = () => {
        const raw = budget.value.trim();
        const value = raw === '' ? null : Number(raw);
        if (value !== null && (!Number.isInteger(value) || value < COURSE_LIMITS.dailyMinutesMin || value > COURSE_LIMITS.dailyMinutesMax)) {
          notify(`Minutos por dia devem ficar entre ${COURSE_LIMITS.dailyMinutesMin} e ${COURSE_LIMITS.dailyMinutesMax}.`, true);
          render();
          return;
        }
        Promise.resolve(storeRef.setPreferences(record.id, { dailyMinutes: value }))
          .then(() => render())
          .catch(error => { notify(`Não foi possível salvar o orçamento: ${error?.message ?? error}`, true); render(); });
      };
      budget.addEventListener('change', applyBudget);
      const next = summary.next?.lesson ?? null;
      const meta = [
        `${summary.doneRequired}/${summary.requiredTotal} obrigatórias`,
        summary.optionalTotal > 0 ? `${summary.doneOptional}/${summary.optionalTotal} opcionais` : null,
        summary.weekMs > 0 ? `${formatMinutes(summary.weekMs)} nesta semana` : null,
      ].filter(Boolean).join(' · ');
      const nextText = next
        ? `Próxima: ${next.title ?? next.id} · ${videoMinutes(next.videoSeconds) ?? '—'} min`
        : 'Sem aulas pendentes';
      list.append(createEl('li', { className: active ? 'today-course' : 'today-course today-course-off', dataset: { course: record.id } }, [
        createEl('label', { className: 'today-course-active' }, [activeBox, createEl('span', { text: 'Ativo' })]),
        createEl('div', { className: 'today-course-main' }, [
          createEl('h4', { text: course.title ?? record.id }),
          createEl('p', { className: 'today-course-meta muted', text: `${nextText} · ${meta}` }),
        ]),
        createEl('label', { className: 'today-field' }, [
          createEl('span', { text: `Plano/dia (min, padrão ${fileMinutes})` }),
          budget,
        ]),
      ]));
    });
    block.append(list);
    appendPractice(block);
    appendAssist(block);
    return block;
  }

  // O estado da fila é uma lista só: a prática SUBSTITUI a fila (é o plano do
  // dia) e assistir ACRESCENTA as aulas (as duas partes são independentes e
  // assistir não consome o orçamento de prática).
  function planStatus(text) {
    return createEl('p', { className: 'today-status', role: 'status', text });
  }

  function formatPlanMinutes(minutes) {
    return formatMinutes(Math.max(0, minutes) * 60000);
  }

  // ----- praticar -------------------------------------------------------------

  function appendPractice(block) {
    const section = createEl('section', { id: 'today-practice', className: 'today-part today-practice', 'aria-label': 'Praticar' });
    section.append(createEl('h4', { text: 'Praticar' }));
    const snapshots = courseSnapshots();
    const plan = practiceCoursePlan({ courses: snapshots, rows: library.list(), resolveExercise: resolveExercise() });
    if (snapshots.filter(entry => entry.state?.preferences?.active !== false).length === 0) {
      section.append(planStatus(plan.items.length > 0
        ? `Sem curso ativo: ${plan.items.length} exercício(s) avulso(s) na sugestão de sempre.`
        : 'Sem curso ativo e sem sugestão avulsa: monte a fila abaixo.'));
    } else {
      const parts = [`${plan.items.length} item(ns)`, `≈ ${formatPlanMinutes(plan.usedMin)} de ${formatPlanMinutes(plan.budgetMin)} orçados`];
      if (plan.loose > 0) parts.push(`${plan.loose} avulso(s) na folga`);
      if (plan.deferred > 0) parts.push(`${plan.deferred} fora desta vez`);
      section.append(planStatus(`Exercícios das aulas assistidas ainda abaixo do alvo, do mais antigo para o mais novo: ${parts.join(' · ')}.`));
    }
    if (plan.items.length > 0) {
      const items = createEl('ol', { className: 'today-plan-list' });
      const rows = rowsById();
      for (const item of plan.items) {
        const row = item.exerciseId ? rows.get(item.exerciseId) ?? null : null;
        items.append(createEl('li', {
          className: 'today-plan-item',
          text: `${row?.name ?? item.exerciseId ?? 'exercício'} (${item.durationMin} min)`,
        }));
      }
      section.append(items);
    }
    if (plan.pendingSuggestions.length > 0) {
      section.append(createEl('p', {
        className: 'today-note',
        text: `${plan.offerGenerate} exercício(s) sugerido(s) de aulas assistidas ainda não gerado(s): gerar aumenta a prática de hoje e dos próximos dias.`,
      }));
      const offers = createEl('ul', { className: 'today-plan-offers' });
      for (const entry of plan.pendingSuggestions.slice(0, 6)) {
        const button = createEl('button', {
          type: 'button',
          dataset: { action: 'generate-suggestions', lesson: entry.lessonId },
          text: `Gerar os ${entry.count} sugeridos de “${entry.lessonTitle}”`,
        });
        button.disabled = typeof host.openLesson !== 'function';
        button.title = button.disabled
          ? 'Abrir aulas ainda não está ligado nesta tela.'
          : 'Abre a página da aula, onde “Gerar todos” cria os exercícios com notas e já os vincula.';
        button.addEventListener('click', () => openLesson({ courseId: entry.courseId, lessonId: entry.lessonId }));
        offers.append(createEl('li', { className: 'today-plan-offer' }, [button]));
      }
      section.append(offers);
    }
    for (const entry of plan.deferredItems.slice(0, 4)) {
      section.append(createEl('p', {
        className: 'today-note',
        text: entry.reason === 'exercise-missing'
          ? `Pendência de “${entry.courseTitle}”: o exercício vinculado não está mais na biblioteca (desvincule ou recrie na aula).`
          : `Ficou para depois: ${entry.name} (${entry.durationMin} min) não cabe no orçamento de ${formatPlanMinutes(plan.courses.find(course => course.courseId === entry.courseId)?.budgetMin ?? 0)} de “${entry.courseTitle}”.`,
      }));
    }
    if (plan.duplicated > 0) {
      section.append(createEl('p', { className: 'today-note muted', text: `${plan.duplicated} exercício(s) compartilhado(s) entre cursos entraram uma vez só.` }));
    }
    const apply = createEl('button', { id: 'today-practice-apply', type: 'button', className: 'primary', text: 'Usar a prática na fila' });
    apply.disabled = plan.items.length === 0 || plan.source === 'loose';
    apply.title = plan.source === 'loose'
      ? 'Sem curso ativo: use a sugestão avulsa abaixo.'
      : 'A fila passa a ser exatamente a lista de prática (substitui o que estiver na fila).';
    apply.addEventListener('click', () => {
      if (mutate(() => store.setItems(plan.items))) {
        notify(`Fila de hoje: ${plan.items.length} item(ns) de prática${plan.deferred > 0 ? `; ${plan.deferred} ficaram para depois` : ''}.`);
      }
      render();
    });
    section.append(createEl('div', { className: 'today-actions' }, [apply]));
    block.append(section);
  }

  // ----- assistir (recolhido por padrão) --------------------------------------

  function appendAssist(block) {
    const details = createEl('details', { id: 'today-watch', className: 'today-part today-watch', dataset: { disclosure: 'today-watch' } });
    details.append(createEl('summary', { text: 'Assistir (opcional)' }));
    const body = createEl('div', { className: 'today-watch-body' });
    const snapshots = courseSnapshots();
    const saved = typeof store.assistMinutes === 'function' ? store.assistMinutes() : null;
    const minutes = Number.isInteger(saved) ? saved : DEFAULT_ASSIST_MINUTES;
    const plan = assistCoursePlan({ courses: snapshots, minutes });
    body.append(createEl('p', { className: 'today-note muted', text: 'As próximas aulas do curso, quantas couberem no tempo que você indicar. Assistir várias de uma vez só aumenta a fila de prática dos dias seguintes; nada é marcado como assistido aqui — isso acontece na aula.' }));
    const field = createEl('input', {
      id: 'today-watch-minutes', type: 'number', min: '5', max: '600', step: '5',
      value: String(minutes), 'aria-label': 'Minutos disponíveis para assistir hoje',
    });
    field.addEventListener('change', () => {
      const value = Number(field.value);
      if (!Number.isInteger(value) || value < 5 || value > 600) {
        notify('O tempo para assistir precisa ficar entre 5 e 600 minutos.', true);
        render();
        return;
      }
      if (mutate(() => store.setAssistMinutes(value)) !== null) notify(`Tempo para assistir hoje: ${value} min.`);
      render();
    });
    body.append(createEl('label', { className: 'today-field' }, [createEl('span', { text: 'Tempo para assistir hoje (min)' }), field]));
    body.append(planStatus(plan.items.length > 0
      ? `${plan.items.length} aula(s) cabem em ${formatPlanMinutes(plan.minutes)} (${plan.usedMin} min estimados).`
      : (snapshots.length === 0 ? 'Nenhum curso importado: não há aulas para assistir.' : 'Nenhuma aula pendente cabe neste tempo.')));
    if (plan.items.length > 0) {
      const items = createEl('ol', { className: 'today-plan-list' });
      for (const item of plan.items) {
        items.append(createEl('li', { className: 'today-plan-item', text: `Assistir: ${item.name} (${item.durationMin} min${item.optional ? ', opcional' : ''})` }));
      }
      body.append(items);
    }
    if (plan.deferred > 0) {
      body.append(createEl('p', { className: 'today-note', text: `${plan.deferred} aula(s) ficaram para depois com este tempo.` }));
    }
    const action = createEl('button', { id: 'today-watch-apply', type: 'button', text: 'Acrescentar as aulas à fila' });
    action.disabled = plan.items.length === 0;
    action.title = 'As aulas entram no fim da fila atual; a prática que já está na fila continua.';
    action.addEventListener('click', () => {
      let added = 0;
      for (const item of plan.items) {
        if (mutate(() => store.addLessonItem({ courseId: item.courseId, lessonId: item.lessonId, name: item.name, durationMin: item.durationMin }))) added += 1;
      }
      notify(added > 0 ? `${added} aula(s) de assistir na fila.` : 'Nenhuma aula foi acrescentada.');
      render();
    });
    body.append(createEl('div', { className: 'today-actions' }, [action]));
    details.append(body);
    block.append(details);
  }

  // ----- fila -----------------------------------------------------------------

  function renderItem(item, index, count, rows, activeItemId) {
    const lesson = itemKind(item) === ITEM_KIND_LESSON;
    const row = lesson ? null : rows.get(item.exerciseId) ?? null;
    const name = lesson ? (item.name ?? item.lessonId) : row?.name ?? 'Exercício não encontrado';
    const origin = courseLabel(courseStoreOf(), item.courseId, item.lessonId);
    const metaParts = [];
    if (lesson) {
      metaParts.push(origin ?? 'Aula');
      metaParts.push(itemDurationLabel(item) + ' de aula');
    } else if (row) {
      metaParts.push(`${INSTRUMENT_LABELS[row.instrument] ?? row.instrument ?? '—'} · ${Number.isFinite(row.targetBPM) ? `${row.bpm ?? '—'} → ${row.targetBPM} BPM` : `${row.bpm ?? '—'} BPM · definir alvo`}`);
      if (origin) metaParts.push(origin);
    } else {
      metaParts.push('Remova este item ou adicione o exercício de volta à biblioteca.');
    }
    const max = lesson ? MAX_LESSON_MINUTES : MAX_ITEM_MINUTES;
    const duration = createEl('input', {
      type: 'number', min: String(MIN_ITEM_MINUTES), max: String(max), step: '1',
      value: String(itemMinutes(item)), 'aria-label': `Duração de ${name} em minutos`, dataset: { item: item.id },
    });
    duration.addEventListener('change', () => {
      mutate(() => store.setItemDuration(item.id, Number(duration.value)));
      render();
    });
    const up = createEl('button', { type: 'button', text: '↑', title: 'Subir', 'aria-label': `Subir ${name}` });
    up.disabled = index === 0;
    up.addEventListener('click', () => { mutate(() => store.moveItem(item.id, -1)); render(); });
    const down = createEl('button', { type: 'button', text: '↓', title: 'Descer', 'aria-label': `Descer ${name}` });
    down.disabled = index === count - 1;
    down.addEventListener('click', () => { mutate(() => store.moveItem(item.id, 1)); render(); });
    const remove = createEl('button', { type: 'button', text: 'Remover', 'aria-label': `Remover ${name} da fila` });
    remove.addEventListener('click', () => { mutate(() => store.removeItem(item.id)); render(); });
    const title = lesson
      ? createEl('h3', { className: 'today-item-lesson', text: `Assistir: ${name}` })
      : createEl('h3', { text: name });
    const actions = [];
    if (lesson) {
      const open = createEl('button', { type: 'button', text: 'Abrir aula', dataset: { lesson: item.lessonId } });
      open.disabled = typeof host.openLesson !== 'function';
      open.title = open.disabled ? 'Abrir aulas ainda não está ligado nesta tela.' : 'Abre a página da aula na Biblioteca (sem contar tempo)';
      open.addEventListener('click', () => openLesson(item));
      actions.push(open);
    }
    actions.push(up, down, remove);
    return createEl('li', {
      className: item.id === activeItemId ? 'today-item today-item-active' : 'today-item',
      dataset: { item: item.id, kind: itemKind(item) },
    }, [
      createEl('div', { className: 'today-item-main' }, [
        title,
        createEl('p', { className: 'today-item-meta muted', text: metaParts.join(' · ') }),
      ]),
      createEl('label', { className: 'today-item-duration' }, [createEl('span', { text: lesson ? 'Estimativa (min)' : 'Duração (min)' }), duration]),
      createEl('div', { className: 'today-item-actions' }, actions),
    ]);
  }

  function renderBuilder(rows) {
    const builder = createEl('div', { className: 'today-builder' });
    const items = store.items();
    builder.append(renderCourses());
    const list = createEl('ol', { className: 'today-list' });
    const activeItemId = session.snapshot().item?.id ?? null;
    items.forEach((item, index) => list.append(renderItem(item, index, items.length, rows, activeItemId)));
    if (items.length === 0) builder.append(createEl('p', { className: 'today-empty muted', text: 'A fila está vazia. Use o plano dos cursos, a sugestão da biblioteca ou adicione exercícios.' }));
    else builder.append(list);
    builder.append(createEl('p', { className: 'today-total muted', role: 'status', text: `Total: ${formatMinutes(queueTotalMs(items))} em ${items.length} item(ns). Padrão de ${DEFAULT_ITEM_MINUTES} min por exercício.` }));

    const picker = createEl('select', { id: 'today-add-exercise', 'aria-label': 'Exercício para adicionar à fila' });
    for (const row of rows.values()) picker.append(createEl('option', { value: row.id, text: `${row.name} · ${INSTRUMENT_LABELS[row.instrument] ?? row.instrument ?? '—'} · ${row.bpm ?? '—'} BPM` }));
    const add = createEl('button', { id: 'today-add', type: 'button', text: 'Adicionar' });
    add.disabled = rows.size === 0;
    add.addEventListener('click', () => {
      if (!picker.value) return;
      mutate(() => store.addItem({ exerciseId: picker.value }));
      render();
    });
    const suggest = createEl('button', { id: 'today-suggest', type: 'button', text: 'Sugerir fila', title: 'Mais antigos sem treino, depois os mais longe do alvo' });
    suggest.addEventListener('click', () => {
      const ordered = suggestQueue(library.list());
      const chosen = ordered.slice(0, SUGGESTION_LIMIT);
      if (!mutate(() => store.setItems(chosen))) { render(); return; }
      const remaining = ordered.length - chosen.length;
      notify(`Fila sugerida com ${chosen.length} item(ns)${remaining > 0 ? `; ${remaining} ficaram fora desta sessão (ordem completa preservada)` : ''}.`);
      render();
    });
    const clear = createEl('button', { id: 'today-clear', type: 'button', text: 'Limpar fila' });
    clear.disabled = items.length === 0;
    clear.addEventListener('click', () => { mutate(() => store.setItems([])); render(); });
    builder.append(createEl('div', { className: 'today-add-row' }, [
      createEl('label', { className: 'today-field' }, [createEl('span', { text: 'Adicionar exercício' }), picker]),
      add,
    ]));
    builder.append(createEl('div', { className: 'today-actions' }, [suggest, clear]));

    const routineName = createEl('input', { id: 'today-routine-name', type: 'text', value: view.routineName, maxlength: '80', placeholder: 'Nome da rotina', 'aria-label': 'Nome da rotina' });
    routineName.addEventListener('input', () => { view.routineName = routineName.value; });
    const saveRoutine = createEl('button', { id: 'today-save-routine', type: 'button', text: 'Salvar rotina' });
    saveRoutine.disabled = items.length === 0;
    saveRoutine.addEventListener('click', () => {
      try {
        const routine = store.saveRoutine(routineName.value, items);
        notify(`Rotina “${routine.name}” salva com ${routine.items.length} item(ns). Recrie a fila em um clique.`);
        view.routineName = '';
      } catch (error) { notify(error.message, true); }
      render();
    });
    builder.append(createEl('div', { className: 'today-actions' }, [createEl('label', { className: 'today-field' }, [createEl('span', { text: 'Rotina nomeada' }), routineName]), saveRoutine]));
    builder.append(renderRoutines());

    const start = createEl('button', { id: 'today-start', type: 'button', className: 'primary', text: 'Começar' });
    start.disabled = items.length === 0;
    start.addEventListener('click', () => {
      const created = session.start();
      if (!created) return;
      const first = session.snapshot();
      notify(first.lesson
        ? 'Sessão de hoje começou pela aula. Ela abre na Biblioteca; o tempo só conta se você pedir.'
        : 'Sessão de hoje começou. O timer fica no painel Treinar.');
      view.open = false;
      render();
    });
    builder.append(createEl('div', { className: 'today-start-row' }, [start, createEl('p', { className: 'today-note muted', text: 'Começar abre a aula na Biblioteca ou o exercício no Treinar, conforme o item. Aula não conta tempo sozinha.' })]));
    return builder;
  }

  function renderRoutines() {
    const block = createEl('div', { className: 'today-routines' });
    const routines = store.routines();
    block.append(createEl('h3', { text: 'Rotinas salvas' }));
    if (routines.length === 0) {
      block.append(createEl('p', { className: 'today-empty muted', text: 'Nenhuma rotina salva ainda. Monte a fila e salve com um nome.' }));
      return block;
    }
    const list = createEl('ul', { className: 'today-routine-list' });
    for (const routine of routines) {
      const apply = createEl('button', { type: 'button', text: 'Recriar fila', dataset: { routine: routine.id } });
      apply.addEventListener('click', () => {
        try {
          const queue = store.applyRoutine(routine.id);
          notify(`Rotina “${routine.name}” recriada: ${queue.items.length} item(ns) · ${formatMinutes(queueTotalMs(queue.items))}.`);
        } catch (error) { notify(error.message, true); }
        render();
      });
      const remove = createEl('button', { type: 'button', text: 'Excluir' });
      remove.addEventListener('click', () => { store.deleteRoutine(routine.id); notify(`Rotina “${routine.name}” excluída.`); render(); });
      list.append(createEl('li', {}, [
        createEl('span', { className: 'today-routine-name', text: routine.name }),
        createEl('span', { className: 'today-routine-meta muted', text: `${routine.items.length} item(ns) · ${formatMinutes(queueTotalMs(routine.items))}` }),
        createEl('span', { className: 'today-routine-actions' }, [apply, remove]),
      ]));
    }
    block.append(list);
    return block;
  }

  function renderWarnings() {
    const box = createEl('div', { className: 'today-warnings' });
    const warning = store.warning;
    if (warning) box.append(createEl('p', { className: 'today-warning', role: 'alert', text: warning }));
    if (store.routinesWarning) box.append(createEl('p', { className: 'today-warning', role: 'alert', text: store.routinesWarning }));
    if (store.migrated.journal || store.migrated.routines) {
      const bar = createEl('div', { className: 'today-recovery' }, [
        createEl('span', { text: 'A fila/rotinas antigas foram lidas no formato novo. Os bytes originais continuam guardados como backup.' }),
      ]);
      if (store.legacyRaw !== null) {
        const raw = createEl('button', { type: 'button', dataset: { raw: 'legacy' }, text: 'Baixar fila antiga (v1)' });
        raw.addEventListener('click', () => { void privateFiles.download(store.legacyRaw, 'groovegoblin-fila-v1.json'); });
        bar.append(raw);
      }
      if (store.legacyBackupRaw !== null && store.legacyBackupRaw !== store.legacyRaw) {
        const raw = createEl('button', { type: 'button', dataset: { raw: 'legacy-backup' }, text: 'Baixar cópia da migração' });
        raw.addEventListener('click', () => { void privateFiles.download(store.legacyBackupRaw, 'groovegoblin-fila-v1-backup.json'); });
        bar.append(raw);
      }
      box.append(bar);
    }
    if (store.status === 'corrupt') {
      const bar = createEl('div', { className: 'today-recovery' }, [
        createEl('span', { text: `A fila guardada está corrompida (${store.corruptOriginKey}). Os bytes originais ficam preservados; baixe-os antes de recuperar.` }),
      ]);
      if (store.recoveryRaw !== null) {
        const raw = createEl('button', { type: 'button', dataset: { raw: 'corrupt' }, text: 'Baixar fila corrompida' });
        raw.addEventListener('click', () => { void privateFiles.download(store.recoveryRaw, 'groovegoblin-fila-corrompida.json'); });
        bar.append(raw);
      }
      const recover = createEl('button', { type: 'button', text: 'Recuperar fila' });
      recover.addEventListener('click', () => {
        if (store.replaceCorrupt()) notify('Fila de hoje recuperada a partir do estado limpo.');
        else notify(store.warning ?? 'Recuperação indisponível.', true);
        render();
      });
      bar.append(recover);
      box.append(bar);
    }
    const state = session.snapshot();
    const watchProblem = state.watch?.warning;
    if (watchProblem) box.append(createEl('p', { className: 'today-warning', role: 'alert', text: watchProblem }));
    return box;
  }

  function summaryLine(item) {
    if (item.study) return `${formatClock(item.elapsedMs)} de estudo de ~${formatMinutes(item.plannedMs)}`;
    return `${formatClock(item.elapsedMs)} praticados de ${formatMinutes(item.plannedMs)}`;
  }

  function renderSummary() {
    const summary = store.summary() ?? session.snapshot().summary;
    if (!summary) return null;
    const block = createEl('div', { className: 'today-summary' });
    block.append(createEl('h3', { text: 'Última sessão de hoje' }));
    const studyMs = summary.items.filter(item => item.study).reduce((total, item) => total + item.elapsedMs, 0);
    const parts = [`${new Date(summary.finishedAt).toLocaleString('pt-BR')} · ${formatMinutes(summary.totalElapsedMs)} de tempo fechado de ${formatMinutes(summary.plannedMs)} planejados.`];
    if (studyMs > 0) parts.push(`${formatMinutes(studyMs)} de estudo de aula.`);
    block.append(createEl('p', { className: 'muted', text: parts.join(' ') }));
    const list = createEl('ul', { className: 'today-summary-list' });
    const done = summary.items.filter(item => item.practiced);
    if (done.length === 0) block.append(createEl('p', { className: 'today-empty muted', text: 'Nenhum item foi praticado ou estudado nesta sessão.' }));
    else {
      for (const item of done) {
        list.append(createEl('li', { dataset: { kind: item.study ? ITEM_KIND_LESSON : 'exercise' } }, [
          createEl('span', { className: 'today-summary-name', text: item.name }),
          createEl('span', { className: 'muted', text: summaryLine(item) }),
          createEl('span', { className: 'muted', text: item.study ? 'Estudo (sem BPM)' : bpmText(item) }),
        ]));
      }
      block.append(list);
    }
    const skipped = summary.items.filter(item => !item.practiced).length;
    if (skipped > 0) block.append(createEl('p', { className: 'muted', text: `${skipped} item(ns) não praticados nem estudados.` }));
    return block;
  }

  function studyClock(state) {
    return `${formatClock(state.elapsedMs)} de estudo (est. ${formatMinutes(state.targetMs)})`;
  }

  // Tira de ESTUDO da aula: fica na Biblioteca (onde a aula vive), só aparece
  // com uma aula ativa e NUNCA cobra tempo nem conta para zero.
  function renderStrip() {
    stripHost.replaceChildren();
    const state = session.snapshot();
    const visible = state.active && state.lesson;
    stripHost.hidden = !visible;
    if (!visible) return;
    const running = state.studyRunning;
    const toggle = createEl('button', { id: 'today-study-toggle', type: 'button', text: running ? 'Parar de contar' : 'Contar tempo' });
    toggle.addEventListener('click', () => {
      if (running) session.stopStudy('manual'); else session.startStudy('manual');
      render();
    });
    const next = createEl('button', { id: 'today-lesson-next', type: 'button', text: 'Próximo' });
    next.addEventListener('click', () => {
      const result = session.next();
      if (result.completed) notify('Fim da fila: sessão de hoje encerrada.');
      render();
    });
    const finish = createEl('button', { id: 'today-lesson-finish', type: 'button', text: 'Encerrar' });
    finish.addEventListener('click', () => { session.finish('manual'); render(); });
    const status = running
      ? 'Contando o tempo de estudo (intervalo fechado ao parar).'
      : 'Sem contagem automática: a aula não cobra tempo nem avisa meta.';
    stripHost.append(createEl('div', { className: 'today-run-row' }, [
      createEl('span', { className: 'today-run-position', text: `Item ${state.index + 1} de ${state.count}` }),
      createEl('strong', { className: 'today-run-name', text: state.name ?? 'Aula' }),
      createEl('span', { className: 'today-run-timer', role: 'timer', text: studyClock(state) }),
      createEl('span', { className: 'today-run-status muted', role: 'status', text: status }),
      createEl('div', { className: 'today-run-actions' }, [toggle, next, finish]),
    ]));
  }

  function renderAll() {
    root.replaceChildren();
    const rows = rowsById();
    root.append(stripHost, renderHeader(), renderWarnings());
    if (view.open) {
      // A divulgação do Hoje (montagem + resumo + avisos) rola com o documento;
      // o repouso da Biblioteca continua com um controle só.
      const disclosure = createEl('div', { className: 'today-disclosure' });
      disclosure.append(renderBuilder(rows));
      const summary = renderSummary();
      if (summary) disclosure.append(summary);
      const state = session.snapshot();
      const journalNote = [];
      if (state.kind !== ITEM_KIND_LESSON) {
        if (state.journal.status && state.journal.status !== 'ready') journalNote.push(state.journal.warning ?? `Diário de prática em estado “${state.journal.status}”.`);
        if (state.journal.problem) journalNote.push(state.journal.problem);
      }
      for (const note of journalNote) disclosure.append(createEl('p', { className: 'today-warning', role: 'alert', text: note }));
      root.append(disclosure);
    }
    renderStrip();
  }

  // Enquanto o painel está oculto não vale reconstruir a lista (a biblioteca
  // emite a cada autosave); a troca de aba re-renderiza via observador.
  function render() {
    if (root.closest('[hidden]')) return;
    renderKeepingFocus(root, renderAll);
  }

  // Atualiza só o texto: botões permanecem no DOM, inclusive com foco ou com
  // o ponteiro pressionado. O construtor e seus campos não são reconstruídos.
  function tick() {
    if (root.closest('[hidden]')) return;
    const clock = stripHost.querySelector('.today-run-timer');
    if (!clock) return;
    const text = studyClock(session.snapshot());
    if (clock.textContent !== text) clock.textContent = text;
  }

  const unsubscribeStore = store.subscribe(render);
  const unsubscribeLibrary = typeof library.subscribe === 'function' ? library.subscribe(render) : null;
  let unsubscribeCourses = null;
  Promise.resolve(courseAccess.ready)
    .then(storeRef => { if (storeRef?.subscribe) unsubscribeCourses = storeRef.subscribe(() => { render(); }); })
    .catch(() => {});
  const panel = document.getElementById('panel-library');
  const observer = new MutationObserver(() => {
    if (!panel) return;
    // Sair da Biblioteca fecha o cronômetro de estudo da aula (nada de cobrar
    // tempo fora da tela); voltar não religa sozinho.
    if (panel.hidden) session.stopStudy('tab');
    else render();
  });
  if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  render();
  return {
    render,
    tick,
    destroy() {
      unsubscribeStore?.(); unsubscribeLibrary?.(); unsubscribeCourses?.();
      observer.disconnect();
      privateFiles.destroy();
      root.remove();
    },
  };
}

// ----- tira do painel Treinar -------------------------------------------------

export function mountTodayTrainer(container, host) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para a sessão de hoje no Treinar.');
  requireHost(host, ['notify']);
  const session = host.session;
  const library = host.library;
  if (!session || typeof session.snapshot !== 'function') throw new TypeError('Sessão de hoje: controlador ausente.');

  const root = createEl('section', { className: 'today-run', 'aria-label': 'Sessão de hoje em andamento', hidden: true });
  container.appendChild(root);

  function notify(text, error = false) { host.notify(text, error); }

  // A tira do Treinar é do EXERCÍCIO: aula ativa não mostra restos do Treinar.
  function summaryIsExercise(summary) {
    return !!summary && summary.items.some(item => !item.study);
  }

  function renderAll() {
    const state = session.snapshot();
    root.replaceChildren();
    const showRunning = state.active && state.kind !== ITEM_KIND_LESSON;
    const showFinished = !state.active && summaryIsExercise(state.summary);
    root.hidden = !showRunning && !showFinished;
    if (root.hidden) return;
    if (showRunning) root.append(renderRunning(state));
    else root.append(renderFinished(state));
  }

  function renderRunning(state) {
    const item = state.item ?? {};
    const remaining = state.remainingMs;
    const overtime = state.overtimeMs;
    const progress = state.targetMs > 0 ? Math.min(1, state.elapsedMs / state.targetMs) : 0;
    const statusText = !state.running
      ? state.reason === 'selection' ? 'Pausado: você saiu para outro exercício. Use Retomar.' : 'Pausado. Use Retomar para continuar contando.'
      : overtime ? 'Meta atingida. Nada é interrompido; vá para o próximo quando quiser.'
        : 'Contando o tempo deste item.';
    const bar = createEl('div', { className: 'today-run-bar', role: 'img', 'aria-label': `Tempo do item: ${Math.round(progress * 100)}%` }, [createEl('span', { style: `width: ${(progress * 100).toFixed(1)}%` })]);
    const toggle = createEl('button', { id: 'today-toggle', type: 'button', text: state.running ? 'Pausar' : 'Retomar' });
    toggle.addEventListener('click', () => { if (state.running) session.pause('manual'); else session.resume('manual'); render(); });
    const next = createEl('button', { id: 'today-next', type: 'button', text: 'Próximo', title: 'Encerra o treino atual e seleciona o próximo item da fila' });
    next.addEventListener('click', () => {
      const result = session.next();
      if (result.completed) notify('Fim da fila: sessão de hoje encerrada.');
      render();
    });
    const finish = createEl('button', { id: 'today-finish', type: 'button', text: 'Encerrar' });
    finish.addEventListener('click', () => { session.finish('manual'); render(); });
    const row = createEl('div', { className: 'today-run-row' }, [
      createEl('span', { className: 'today-run-position', text: `Item ${state.index + 1} de ${state.count}` }),
      createEl('strong', { className: 'today-run-name', text: item.name ?? item.exerciseId ?? 'Exercício' }),
      createEl('span', { className: 'today-run-timer', role: 'timer', text: overtime ? `+${formatClock(overtime)}` : `${formatClock(remaining)} restantes` }),
      bar,
      createEl('span', { className: 'today-run-status muted', role: 'status', text: statusText }),
      createEl('div', { className: 'today-run-actions' }, [toggle, next, finish]),
    ]);
    const problem = state.journal.problem
      ?? (state.journal.status && state.journal.status !== 'ready' ? state.journal.warning : null);
    if (!problem) return row;
    return createEl('div', {}, [row, createEl('p', { className: 'today-run-warning', role: 'alert', text: problem })]);
  }

  function renderFinished(state) {
    const summary = state.summary;
    const block = createEl('div', { className: 'today-run-summary' });
    block.append(createEl('h3', { text: 'Sessão de hoje encerrada' }));
    const shown = summary.items.filter(item => !item.study);
    block.append(createEl('p', { className: 'muted', text: `${formatMinutes(summary.totalElapsedMs)} de tempo fechado em ${summary.items.filter(item => item.practiced).length} item(ns) de ${summary.items.length}.` }));
    const list = createEl('ul', { className: 'today-summary-list' });
    for (const item of shown.filter(candidate => candidate.practiced)) {
      list.append(createEl('li', {}, [
        createEl('span', { className: 'today-summary-name', text: item.name }),
        createEl('span', { className: 'muted', text: formatClock(item.elapsedMs) }),
        createEl('span', { className: 'muted', text: bpmText(item) }),
      ]));
    }
    if (list.childNodes.length > 0) block.append(list);
    const dismiss = createEl('button', { type: 'button', text: 'Dispensar resumo' });
    dismiss.addEventListener('click', () => { session.dismissSummary(); render(); });
    block.append(dismiss);
    return block;
  }

  function render() {
    renderKeepingFocus(root, renderAll);
  }

  // Visibilidade: nada de cobrar tempo escondido. Ao voltar, se o usuário
  // estava contando, o relógio volta sem exigir cliques.
  function onHidden() { if (document.hidden) session.suspend('hidden'); else session.wake('visible'); }
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onPageHide);
  function onPageHide() { session.pause('pagehide'); }

  // Aba do Treinar: fora dela o item não está sendo praticado.
  const panel = document.getElementById('panel-practice') ?? container.parentElement;
  const observer = new MutationObserver(() => {
    if (!panel || panel.hidden) session.suspend('tab');
    else session.wake('tab');
  });
  if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  if (typeof library?.subscribe === 'function') {
    library.subscribe(() => { session.ownerChanged(library.active?.() ?? null); });
  }

  render();
  return {
    render,
    destroy() {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
      root.remove();
    },
  };
}
