// Cursos na Biblioteca (rodada 5, etapa 5).
//
// A biblioteca de exercícios ganha o alternador Exercícios/Cursos (montado em
// library-view.js); este módulo cuida da lista de cursos, da importação por
// arquivo JSON e da página do curso. Nada de HTML não confiável é
// interpretado: cada nó é criado por createEl, e o único link externo é um
// <a target="_blank" rel="noopener noreferrer"> — o app nunca busca nem
// embute o conteúdo de terceiros.
//
// A lista mostra título, autor, progresso com denominadores obrigatório e
// opcional SEPARADOS, próxima aula, tempo de estudo da semana e Continuar. A
// página do curso mostra as seções em <details> (a da próxima aula já aberta),
// cada aula com tipo, título, duração, estado e número de exercícios, mais
// filtros por tipo/estado e navegação por teclado na lista.

import { createEl, renderKeepingFocus } from './practice.js';
import { sharedCourseMaterials } from './course-content.js';
import { LESSON_STATUS, lessonPending, videoMinutes } from './course-progress.js';
import { mountPrivateDownload } from './private-download.js';

const STATUS_LABELS = Object.freeze({
  [LESSON_STATUS.notStarted]: 'Não iniciada',
  [LESSON_STATUS.watched]: 'Assistida',
  [LESSON_STATUS.practicing]: 'Praticando',
  [LESSON_STATUS.done]: 'Concluída',
});
const STATUS_ORDER = Object.freeze([LESSON_STATUS.notStarted, LESSON_STATUS.watched, LESSON_STATUS.practicing, LESSON_STATUS.done]);
const PENDING_LABELS = Object.freeze({
  reopened: 'conclusão reaberta: retome quando quiser',
  'not-watched': 'assista à aula',
  'no-linked-exercise': 'crie ou vincule um exercício sugerido',
  'exercise-missing': 'exercício vinculado não está mais na biblioteca',
  'exercise-without-target': 'exercício vinculado sem alvo definido',
  'exercise-below-target': 'exercício vinculado ainda não atingiu o alvo',
});
const ERROR_LIST_MAX = 8;

function minutesLabel(minutes) {
  return minutes === 1 ? '1 min' : `${minutes} min`;
}

export function studyTimeLabel(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'sem tempo registrado';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'menos de 1 min';
  if (minutes < 60) return minutesLabel(minutes);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')} min`;
}

export function durationLabel(lesson) {
  const minutes = videoMinutes(lesson?.videoSeconds);
  if (minutes !== null) return minutesLabel(minutes);
  return lesson?.hasVideo ? 'duração não informada' : 'sem vídeo';
}

function progressText(summary) {
  return `${summary.done} de ${summary.total} aulas concluídas · ${summary.doneRequired} de ${summary.requiredTotal} obrigatórias · ${summary.doneOptional} de ${summary.optionalTotal} opcionais`;
}

function nextText(summary) {
  if (!summary.next) return summary.total > 0 ? 'Todas as aulas concluídas ou puladas.' : 'Este curso não tem aulas.';
  const { lesson, optional } = summary.next;
  return `Próxima: ${lesson.title}${lesson.sectionTitle ? ` · ${lesson.sectionTitle}` : ''}${optional ? ' (opcional)' : ''}`;
}

export function mountCourses(container, host) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para os cursos.');
  const store = host?.store;
  if (!store || typeof store.list !== 'function') throw new TypeError('Loja de cursos ausente.');
  const library = host?.library ?? null;
  const notify = (text, error = false) => host.notify?.(text, error);
  const resolveExercise = id => (library && typeof library.get === 'function' ? library.get(id) : null);

  const root = createEl('section', { className: 'courses-root', 'aria-label': 'Cursos' });
  container.appendChild(root);
  // "Exportar curso" NUNCA é um arquivo público: leva catálogo, títulos, autor,
  // URLs e a lista de aulas. Nome PRIVADO + confirmação nativa; cancelar não
  // gera arquivo nenhum.
  const privateFiles = mountPrivateDownload(document.body ?? container, { download: host.download, notify });
  const view = { courseId: null, query: '', type: 'all', status: 'all', open: new Set() };
  // Remoção em dois passos, confirmada no próprio painel: um clique só nunca
  // apaga a estrutura, e nenhum diálogo nativo trava a página.
  let removing = null;
  let loadError = null;
  let loadPending = true;
  const summaryOf = (id, now = Date.now()) => store.summary(id, { resolveExercise, now });

  function panelFocus(selector) {
    const node = root.querySelector(selector);
    node?.focus?.({ preventScroll: false });
    return node;
  }

  // ---------------------------------------------------------------- importação
  function errorPanel(result) {
    const box = createEl('div', { className: 'courses-error', role: 'alert' });
    box.append(createEl('p', { text: `Importação recusada: ${result.error}. Nada foi alterado.` }));
    const errors = Array.isArray(result.errors) ? result.errors.slice(0, ERROR_LIST_MAX) : [];
    if (errors.length > 0) {
      const list = createEl('ul', { className: 'courses-error-list' });
      for (const error of errors) list.append(createEl('li', { text: `${error.path || 'documento'} — ${error.message}` }));
      box.append(list);
      if (result.errors.length > errors.length || result.truncated) {
        box.append(createEl('p', { className: 'muted', text: `Mais ${Math.max(0, result.errors.length - errors.length)} erro(s) no arquivo.` }));
      }
    }
    return box;
  }

  async function importFile(file) {
    if (!store.persistent) { render(); notify(store.error ?? 'Armazenamento de cursos indisponível.', true); return; }
    let text;
    try {
      text = await file.text();
    } catch (error) {
      notify(`Não foi possível ler o arquivo: ${error.message}.`, true);
      return;
    }
    const result = await store.importText(text, { source: 'arquivo' });
    if (!result.ok) {
      loadError = result;
      render();
      notify(result.code === 'invalid' ? `Importação recusada: ${result.error}` : (result.error ?? 'Importação recusada.'), true);
      return;
    }
    loadError = null;
    const counts = result.counts;
    // A reimportação pode reconhecer a MESMA aula por URL mesmo com id novo
    // (o conversor passou a usar o id numérico do mapa): as referências de
    // anexo seguem a aula, para nenhum arquivo ficar órfão de página.
    const remap = await remapAttachments(result);
    const detail = result.created
      ? `${counts.sections} seção(ões), ${counts.lessons} aula(s), ${counts.exercises} exercício(s) sugerido(s).`
      : `estrutura atualizada: ${result.preserved} aula(s) com estado preservado, ${result.restored} restaurada(s), ${result.removed} removida(s) para o grupo próprio.`;
    const moved = result.moved > 0
      ? ` ${result.moved} aula(s) reconhecida(s) pela URL com id novo${remap > 0 ? ` (${remap} anexo(s) realinhado(s))` : ''}.`
      : '';
    render();
    notify(`Curso importado — ${detail}${moved}`);
  }

  // Alinha as referências de anexo (curso, aula, material) com os ids NOVOS das
  // aulas reconhecidas pela URL. Sem loja de anexos ou sem mudança de id, nada
  // acontece; se a gravação falhar, o motivo aparece e o curso importado fica.
  async function remapAttachments(result) {
    const attachments = host?.attachments ?? null;
    const aliases = Array.isArray(result.aliases) ? result.aliases : [];
    if (aliases.length === 0 || !attachments || typeof attachments.remapLessonRefs !== 'function') return 0;
    try {
      const remapped = await attachments.remapLessonRefs(result.courseId, aliases);
      return remapped?.moved ?? 0;
    } catch (error) {
      notify(`O curso foi importado, mas não foi possível realinhar os anexos das aulas renomeadas: ${error.message}`, true);
      return 0;
    }
  }

  function importControls() {
    const button = createEl('button', { id: 'courses-import', type: 'button', className: 'primary', text: 'Importar curso' });
    const input = createEl('input', { id: 'courses-import-file', type: 'file', accept: '.json,application/json', hidden: true, 'aria-label': 'Arquivo de curso em JSON' });
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) void importFile(file);
    });
    button.disabled = !store.persistent || loadPending;
    // Com servidor, a mesma área aceita converter no servidor (mapa + catálogo
    // direto para a área privada). Sem servidor, `host.serverImport` não existe
    // e nada aparece.
    const serverNodes = typeof host?.serverImport === 'function' ? host.serverImport() : [];
    return [button, input, ...serverNodes];
  }

  // -------------------------------------------------------------- lista de cursos
  async function runRemoval(courseId, title) {
    try {
      const removed = await store.removeCourse(courseId);
      removing = null;
      if (!removed) { notify('Curso não encontrado.', true); render(); return; }
      if (view.courseId === courseId) view.courseId = null;
      render();
      notify(`Curso “${title}” removido; o progresso continua guardado.`);
    } catch (error) {
      notify(`Não foi possível remover: ${error.message}`, true);
    }
  }

  function removalConfirm(courseId, title) {
    const box = createEl('div', { className: 'course-remove-confirm' });
    const confirmButton = createEl('button', { type: 'button', className: 'primary', text: 'Confirmar remoção' });
    confirmButton.addEventListener('click', () => void runRemoval(courseId, title));
    const cancelButton = createEl('button', { type: 'button', text: 'Cancelar' });
    cancelButton.addEventListener('click', () => { removing = null; render(); });
    box.append(createEl('p', { className: 'muted', text: `Remover “${title}” da biblioteca? O progresso, as anotações e os vínculos ficam guardados.` }), confirmButton, cancelButton);
    return box;
  }

  function courseCard(record, now) {
    const summary = summaryOf(record.id, now);
    const percent = summary?.total ? Math.round((summary.done / summary.total) * 100) : 0;
    const item = createEl('li', { className: 'course-card', dataset: { courseId: record.id } });
    const main = createEl('div', { className: 'course-card-main' }, [
      createEl('h3', { text: record.course.title }),
      createEl('p', { className: 'course-meta muted', text: [`${record.course.author ?? 'autor não informado'}`, `${record.course.strings} cordas`, `${record.counts.sections} seção(ões)`, `${record.counts.lessons} aula(s)`].join(' · ') }),
      createEl('p', { className: 'course-progress-text', text: summary ? progressText(summary) : 'Progresso indisponível.' }),
      createEl('div', { className: 'library-progress', role: 'img', 'aria-label': `Progresso do curso: ${percent}%` }, [createEl('span', { style: `width: ${percent}%` })]),
      createEl('p', { className: 'course-next', text: summary ? nextText(summary) : '' }),
      createEl('p', { className: 'course-week muted', text: `Tempo de estudo esta semana: ${studyTimeLabel(summary?.weekMs ?? 0)}` }),
    ]);
    const actions = createEl('div', { className: 'course-card-actions' });
    const start = createEl('button', { type: 'button', className: 'primary', dataset: { action: 'continue' }, text: 'Continuar' });
    start.addEventListener('click', () => {
      // Continuar vai direto à próxima aula pendente do modelo; sem próxima,
      // abre a página do curso.
      const next = summary?.next?.lesson ?? null;
      if (next && host.onOpenLesson) host.onOpenLesson(record.id, next.id);
      else openCourse(record.id);
    });
    const menu = createEl('details', { className: 'library-menu' });
    const content = createEl('div', { className: 'library-menu-content' });
    const openButton = createEl('button', { type: 'button', dataset: { action: 'open' }, text: 'Abrir curso' });
    openButton.addEventListener('click', () => openCourse(record.id));
    const exportButton = createEl('button', { type: 'button', dataset: { action: 'export' }, text: 'Exportar curso' });
    exportButton.addEventListener('click', () => {
      const result = store.exportText(record.id);
      if (!result.ok) { notify(result.error, true); return; }
      if (!host.download) { notify('Download indisponível neste navegador.', true); return; }
      void privateFiles.download(result.text, 'groovegoblin-curso.json');
    });
    const removeButton = createEl('button', { type: 'button', dataset: { action: 'remove' }, text: 'Remover da biblioteca' });
    removeButton.addEventListener('click', () => { removing = record.id; render(); });
    content.append(openButton, exportButton, removing === record.id ? removalConfirm(record.id, record.course.title) : removeButton);
    menu.append(createEl('summary', { text: 'Mais ações' }), content);
    menu.open = removing === record.id;
    actions.append(start, menu);
    item.append(main, actions);
    return item;
  }

  function renderList() {
    const now = Date.now();
    const records = store.list();
    root.append(createEl('p', { className: 'courses-summary muted', role: 'status', text: records.length === 0
      ? 'Nenhum curso importado ainda.'
      : `${records.length} curso(s) na biblioteca · progresso guardado a cada marcação.` }));
    const toolbar = createEl('div', { className: 'courses-toolbar' }, importControls());
    root.append(toolbar);
    if (!store.persistent) {
      root.append(createEl('p', { className: 'courses-error', role: 'alert', text: store.error ?? 'Armazenamento de cursos indisponível: nada pode ser importado ou salvo.' }));
    } else if (loadError) {
      root.append(errorPanel(loadError));
    }
    if (store.warning) root.append(createEl('p', { className: 'courses-warning', role: 'alert', text: store.warning }));
    if (records.length === 0) {
      root.append(createEl('p', { className: 'courses-empty muted', text: 'Importe um arquivo JSON no formato groovegoblin-course para acompanhar aulas, progresso e exercícios do curso aqui.' }));
      return;
    }
    const list = createEl('ul', { className: 'course-list' });
    for (const record of records) list.append(courseCard(record, now));
    root.append(list);
  }

  // -------------------------------------------------------------- página do curso
  function applyFilters(rows) {
    const query = view.query.trim().toLocaleLowerCase('pt-BR');
    return rows.filter(row => {
      if (view.type !== 'all' && (row.lesson.type ?? 'aula') !== view.type) return false;
      if (view.status !== 'all' && row.status !== view.status) return false;
      if (query && !`${row.lesson.title} ${row.lesson.sectionTitle ?? ''}`.toLocaleLowerCase('pt-BR').includes(query)) return false;
      return true;
    });
  }

  function lessonPendingText(row) {
    if (row.status === LESSON_STATUS.done) return row.lessonState.completionOverride === 'complete' ? 'Concluída por você.' : '';
    const reasons = lessonPending(row.lessonState, row.links, { hasSuggestions: row.hasSuggestions }).map(reason => PENDING_LABELS[reason] ?? reason);
    const label = reasons.length > 0 ? `Pendente: ${reasons.join('; ')}.` : 'Pendente.';
    return row.watchMs > 0 ? `${label} Tempo registrado: ${studyTimeLabel(row.watchMs)}.` : label;
  }

  function lessonNode(row, index) {
    const { lesson } = row;
    const statusLabel = STATUS_LABELS[row.status] ?? row.status;
    const exercises = lesson.suggestedExercises?.length ?? 0;
    const links = row.links.length;
    const summary = [
      `${lesson.type ?? 'aula'} · ${durationLabel(lesson)}`,
      exercises > 0 ? `${exercises} exercício(s) sugerido(s)` : 'sem exercício sugerido',
      links > 0 ? `${links} vinculado(s)` : null,
    ].filter(Boolean).join(' · ');
    const pending = lessonPendingText(row);
    const button = createEl('button', {
      type: 'button',
      className: 'course-lesson',
      dataset: { lessonId: lesson.id, status: row.status, lessonIndex: index },
      tabindex: '-1',
      'aria-label': `Abrir a aula ${lesson.title}`,
    }, [
      createEl('span', { className: 'course-lesson-type', text: lesson.type ?? 'aula' }),
      createEl('span', { className: 'course-lesson-title', text: lesson.title }),
      createEl('span', { className: 'course-lesson-summary muted', text: summary }),
      createEl('span', { className: `course-lesson-status course-status-${row.status}`, text: statusLabel }),
    ]);
    if (row.isNext) button.dataset.next = 'true';
    if (pending) button.append(createEl('span', { className: 'course-lesson-pending muted', text: pending }));
    // A aula abre a PÁGINA da aula dentro do app: o endereço do site fica lá,
    // como link externo em nova aba, e o app nunca busca nada sozinho.
    button.addEventListener('click', () => host.onOpenLesson?.(view.courseId, lesson.id));
    return button;
  }

  function sectionNode(section, rows, isNextSection, forceOpen = false) {
    const done = rows.filter(row => row.status === LESSON_STATUS.done).length;
    const details = createEl('details', { className: 'course-section', dataset: { sectionId: section.id } });
    const flags = [section.type ?? 'módulo', `${done}/${rows.length} concluída(s)`];
    if (section.week !== null && section.week !== undefined) flags.push(`semana ${section.week}`);
    const head = createEl('span', { className: 'course-section-head' }, [
      createEl('span', { className: 'course-section-title', text: section.title }),
      createEl('span', { className: 'course-section-flags muted', text: flags.join(' · ') }),
    ]);
    details.append(createEl('summary', {}, [head]));
    if (section.summary) details.append(createEl('p', { className: 'course-section-summary muted', text: section.summary }));
    if (section.objective) details.append(createEl('p', { className: 'course-section-summary muted', text: `Objetivo: ${section.objective}` }));
    if (section.prerequisites?.length) details.append(createEl('p', { className: 'course-section-summary muted', text: `Pré-requisitos: ${section.prerequisites.join(', ')}` }));
    // A lista de aulas só é montada quando a seção abre: 200 aulas em dez
    // seções fechadas ficam leves, e a seção que interessa já vem aberta.
    const list = createEl('ul', { className: 'course-lesson-list' });
    const fill = () => {
      if (list.dataset.filled === 'true') return;
      list.dataset.filled = 'true';
      rows.forEach((row, index) => list.append(createEl('li', { className: 'course-lesson-item' }, [lessonNode(row, index)])));
    };
    details.append(list);
    // Um filtro ativo abre as seções com resultado: a busca mostra a aula
    // encontrada sem exigir mais um clique (e sem gastar controle nenhum).
    details.open = isNextSection || forceOpen || view.open.has(section.id);
    details.addEventListener('toggle', () => {
      if (details.open) { view.open.add(section.id); fill(); } else view.open.delete(section.id);
    });
    if (details.open) fill();
    return details;
  }

  function removedNode(summary) {
    const details = createEl('details', { className: 'course-removed' });
    details.append(createEl('summary', { text: `Removidas do curso (${summary.removed.length})` }));
    details.append(createEl('p', { className: 'course-removed-note muted', text: 'Aulas que saíram do mapa em uma reimportação. O estado delas fica guardado, elas não contam no progresso e voltam completas se o mapa trouxer a aula de novo. Toque para abrir a versão guardada, com anotações, vínculos e anexos.' }));
    const list = createEl('ul', { className: 'course-lesson-list' });
    for (const tombstone of summary.removed) {
      const links = tombstone.state.linkedExerciseIds.length;
      const watchNote = tombstone.state.notes ? ' · anotações guardadas' : '';
      const button = createEl('button', {
        type: 'button',
        className: 'course-lesson',
        dataset: { lessonId: tombstone.id, status: 'removed', removed: tombstone.id },
        tabindex: '-1',
        'aria-label': `Abrir a aula removida ${tombstone.title}`,
      }, [
        createEl('span', { className: 'course-lesson-type', text: tombstone.type ?? 'aula' }),
        createEl('span', { className: 'course-lesson-title', text: tombstone.title }),
        createEl('span', { className: 'course-lesson-summary muted', text: `${tombstone.sectionTitle ?? 'seção não informada'}${tombstone.state.watched ? ' · assistida' : ''}${links > 0 ? ` · ${links} vínculo(s)` : ''}${watchNote}` }),
        createEl('span', { className: 'course-lesson-status course-status-not-started', text: 'Removida' }),
      ]);
      // Removida também abre: a página mostra a versão arquivada (leitura).
      button.addEventListener('click', () => host.onOpenLesson?.(view.courseId, tombstone.id));
      list.append(createEl('li', { className: 'course-lesson-item' }, [button]));
    }
    details.append(list);
    return details;
  }

  function filters(sectionTypes, summary) {
    const bar = createEl('div', { className: 'course-filters' });
    const search = createEl('label', { className: 'library-field' }, [
      createEl('span', { text: 'Buscar aula' }),
      createEl('input', { id: 'course-search', type: 'search', value: view.query, placeholder: 'Título da aula ou seção', 'aria-label': 'Buscar aula por título' }),
    ]);
    const searchInput = search.querySelector('input');
    searchInput.addEventListener('input', event => {
      view.query = event.target.value;
      render();
      const next = panelFocus('#course-search');
      next?.setSelectionRange?.(view.query.length, view.query.length);
    });
    const type = createEl('select', { id: 'course-type', 'aria-label': 'Filtrar por tipo de aula' });
    type.append(createEl('option', { value: 'all', text: 'Todos os tipos' }));
    for (const value of sectionTypes) type.append(createEl('option', { value, text: value }));
    type.value = sectionTypes.includes(view.type) ? view.type : 'all';
    view.type = type.value;
    type.addEventListener('change', () => { view.type = type.value; render(); });
    const status = createEl('select', { id: 'course-status', 'aria-label': 'Filtrar por estado da aula' });
    status.append(createEl('option', { value: 'all', text: 'Todos os estados' }));
    for (const value of STATUS_ORDER) status.append(createEl('option', { value, text: `${STATUS_LABELS[value]} (${summary.rows.filter(row => row.status === value).length})` }));
    status.value = view.status;
    status.addEventListener('change', () => { view.status = status.value; render(); });
    const remove = createEl('button', { id: 'course-remove', type: 'button', text: 'Remover curso' });
    remove.addEventListener('click', () => { removing = view.courseId; render(); });
    bar.append(search, createEl('label', { className: 'library-field' }, [createEl('span', { text: 'Tipo' }), type]),
      createEl('label', { className: 'library-field' }, [createEl('span', { text: 'Estado' }), status]));
    if (removing === view.courseId) {
      const record = store.get(view.courseId)?.record;
      bar.append(removalConfirm(view.courseId, record?.course?.title ?? 'este curso'));
    } else bar.append(remove);
    return bar;
  }

  function renderCourse() {
    const found = store.get(view.courseId);
    if (!found) { view.courseId = null; renderList(); return; }
    const summary = summaryOf(view.courseId);
    const percent = summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
    // A página do curso é limitada pelo espaço da janela: a lista de aulas rola
    // por dentro, então 200 aulas não esticam a página do app.
    const page = createEl('div', { className: 'course-page' });
    const back = createEl('button', { id: 'course-back', type: 'button', text: 'Voltar para cursos' });
    back.addEventListener('click', () => { view.courseId = null; render(); panelFocus('#courses-import'); });
    const head = createEl('header', { className: 'course-page-head' }, [
      back,
      createEl('h2', { text: found.course.title }),
      createEl('p', { className: 'course-meta muted', text: [`${found.course.author ?? 'autor não informado'}`, `${found.course.strings} cordas`, found.course.language ?? 'idioma não informado'].join(' · ') }),
      createEl('p', { className: 'course-progress-text', text: progressText(summary) }),
      createEl('div', { className: 'library-progress', role: 'img', 'aria-label': `Progresso do curso: ${percent}%` }, [createEl('span', { style: `width: ${percent}%` })]),
      createEl('p', { className: 'course-next', text: nextText(summary) }),
      createEl('p', { className: 'course-week muted', text: `Tempo de estudo esta semana: ${studyTimeLabel(summary.weekMs)}` }),
    ]);
    if (found.course.url) {
      head.append(createEl('p', { className: 'course-meta' }, [createEl('a', { href: found.course.url, target: '_blank', rel: 'noopener noreferrer', text: 'Página do curso (abre em nova aba) ☍' })]));
    }
    page.append(head);
    // Material do curso no servidor: nada aparece sem servidor; com servidor, o
    // relatório da pasta de entrada (disponíveis/faltantes/não casados), o envio
    // por arrastar e o vínculo manual. Uma instância por curso.
    const materials = sharedCourseMaterials({ content: host?.content ?? null, courseId: view.courseId, notify });
    if (materials) page.append(materials);

    const types = [...new Set(summary.rows.map(row => row.lesson.type ?? 'aula'))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    page.append(filters(types, summary));
    const visible = applyFilters(summary.rows);
    const filtering = view.query.trim() !== '' || view.type !== 'all' || view.status !== 'all';
    const removedNote = summary.removed.length > 0 ? ` · ${summary.removed.length} removida(s) do curso no fim da lista` : '';
    page.append(createEl('p', { className: 'course-filter-summary muted', role: 'status', text: `Mostrando ${visible.length} de ${summary.rows.length} aulas${removedNote}.` }));

    const nextLessonId = summary.next?.lesson?.id ?? null;
    const sections = createEl('div', { className: 'course-sections' });
    let renderedSections = 0;
    for (const section of found.course.sections) {
      const rows = visible
        .filter(row => row.lesson.sectionId === section.id)
        .map(row => (row.lesson.id === nextLessonId ? { ...row, isNext: true } : row));
      const all = summary.rows.filter(row => row.lesson.sectionId === section.id);
      if (rows.length === 0 && filtering) continue;
      if (all.length === 0) continue;
      sections.append(sectionNode(section, rows, rows.some(row => row.isNext), filtering && rows.length > 0));
      renderedSections += 1;
    }
    if (renderedSections === 0) sections.append(createEl('p', { className: 'courses-empty muted', text: 'Nenhuma aula corresponde aos filtros.' }));
    // O grupo de removidas fica DENTRO da área que rola por dentro: abrir o
    // grupo não estica a página do app, mesmo com centenas de tombstones.
    if (summary.removed.length > 0) sections.append(removedNode(summary));
    page.append(sections);
    root.append(page);
  }

  // Navegação por teclado na lista de aulas: um único ponto de tabulação e
  // setas/Home/End entre as aulas visíveis (200 aulas continuam navegáveis).
  function focusLesson(offset = 0, absolute = null) {
    const rows = [...root.querySelectorAll('[data-lesson-id]')].filter(node => !node.closest('[hidden]') && node.offsetParent !== null);
    if (rows.length === 0) return;
    const current = rows.indexOf(document.activeElement);
    const target = absolute === null
      ? (current < 0 ? 0 : current) + offset
      : absolute;
    const index = Math.max(0, Math.min(rows.length - 1, target));
    for (const node of rows) node.tabIndex = -1;
    rows[index].tabIndex = 0;
    rows[index].focus();
  }

  root.addEventListener('keydown', event => {
    if (!event.target.closest?.('[data-lesson-id]')) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); focusLesson(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusLesson(-1); }
    else if (event.key === 'Home') { event.preventDefault(); focusLesson(0, 0); }
    else if (event.key === 'End') { event.preventDefault(); focusLesson(0, Infinity); }
  });

  // Um único ponto de tabulação para a lista inteira: só a primeira aula
  // visível recebe tabindex 0 (a menos que o foco já esteja em uma aula).
  function syncLessonTabStops() {
    const rows = [...root.querySelectorAll('[data-lesson-id]')].filter(node => node.offsetParent !== null);
    if (rows.length === 0) return;
    const focused = rows.find(node => node === document.activeElement) ?? rows[0];
    for (const node of rows) node.tabIndex = -1;
    focused.tabIndex = 0;
  }

  function render() {
    if (root.closest('[hidden]')) return;
    renderKeepingFocus(root, () => {
      root.replaceChildren();
      if (loadPending) {
        root.append(createEl('p', { className: 'courses-summary muted', role: 'status', text: 'Carregando cursos…' }));
        return;
      }
      if (view.courseId) renderCourse();
      else renderList();
      syncLessonTabStops();
    });
  }

  function openCourse(courseId) {
    view.courseId = courseId;
    const summary = summaryOf(courseId);
    view.open.clear();
    if (summary?.next) view.open.add(summary.next.lesson.sectionId);
    render();
    const next = root.querySelector('[data-next="true"]');
    if (next) { next.tabIndex = 0; next.focus({ preventScroll: false }); next.scrollIntoView({ block: 'center' }); }
    else root.querySelector('#course-back')?.focus();
  }

  const unsubscribe = store.subscribe(render);
  void store.ready().then(() => { loadPending = false; render(); }).catch(error => {
    loadPending = false;
    loadError = { error: error.message ?? String(error), errors: [] };
    render();
  });

  return {
    render,
    openCourse,
    destroy() {
      unsubscribe?.();
      privateFiles.destroy();
      root.remove();
    },
  };
}
