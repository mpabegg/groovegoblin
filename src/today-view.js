// Interface da sessão de hoje (rodada 4, item 4 — etapa 5).
//
// Dois pontos de montagem:
//  - painel da Biblioteca: botão "Montar sessão de hoje" + construtor da fila
//    (sugestão, adicionar, remover, reordenar, duração por item, total),
//    rotinas nomeadas e o resumo da última sessão.
//  - painel Treinar: tira discreta com o tempo restante, Próximo e Encerrar.
//
// Nenhum HTML não confiável é interpretado: cada nó é criado por createEl.

import { createEl, renderKeepingFocus } from './practice.js';
import { createTodayStore, suggestQueue, queueTotalMs, DEFAULT_ITEM_MINUTES, MIN_ITEM_MINUTES, MAX_ITEM_MINUTES, SUGGESTION_LIMIT } from './today-store.js';
import { createTodaySession } from './today-session.js';

const INSTRUMENT_LABELS = Object.freeze({ guitar: 'Guitarra', bass: 'Baixo' });

// Um controlador atende à Biblioteca e à tira; todos os modos usam o transporte do host.
export function mountToday(panelContainer, trainerContainer, host) {
  const { library, notify, download, activateTab } = host;
  const store = createTodayStore();
  let panel, trainer;
  const session = createTodaySession({
    store, library, notify,
    getActivity: () => host.activity,
    openItem: (id, { start = false } = {}) => {
      if (!host.openExercise(id, { train: start })) return false;
      activateTab('tab-practice');
      return true;
    },
    getOwner: () => library.active(),
    isExecuting: host.isBusy,
    stopExecution: host.stopExecution,
    onEvent: () => { panel?.render(); trainer?.render(); },
  });
  panel = mountTodayPanel(panelContainer, { store, session, library, notify, download, activateTab });
  trainer = mountTodayTrainer(trainerContainer, { session, library, notify });
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

function bpmText(item) {
  const from = item.bpm?.from ?? null;
  const to = item.bpm?.to ?? null;
  if (from === null && to === null) return 'BPM não registrado';
  if (from === null || to === null || from === to) return `${from ?? to} BPM`;
  const delta = to - from;
  return `${from} → ${to} BPM (${delta > 0 ? '+' : ''}${delta})`;
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

  const root = createEl('section', { className: 'today-root', 'aria-label': 'Sessão de hoje' });
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

  function rowsById() {
    return new Map(library.list({ sort: 'name' }).map(row => [row.id, row]));
  }

  function renderHeader(rows) {
    const items = store.items();
    const total = queueTotalMs(items);
    const button = createEl('button', { id: 'today-build', type: 'button', 'aria-expanded': String(view.open), text: view.open ? 'Fechar montagem' : 'Montar sessão de hoje' });
    button.addEventListener('click', () => {
      view.open = !view.open;
      render();
      if (view.open) root.querySelector('#today-build')?.focus({ preventScroll: true });
    });
    const status = items.length === 0
      ? 'Nenhuma fila montada ainda.'
      : `Fila de hoje: ${items.length} item(ns) · meta ${formatMinutes(total)} · sugestão usa os mais antigos sem treino.`;
    const missing = items.filter(item => !rows.has(item.exerciseId)).length;
    const header = createEl('div', { className: 'today-header' }, [
      button,
      createEl('p', { className: 'today-status muted', role: 'status', text: status }),
    ]);
    if (missing > 0) header.append(createEl('p', { className: 'today-status', role: 'status', text: `${missing} item(ns) apontam para exercícios que não estão mais na biblioteca.` }));
    return header;
  }

  function renderItem(item, index, count, rows, activeExerciseId) {
    const row = rows.get(item.exerciseId) ?? null;
    const name = row?.name ?? 'Exercício não encontrado';
    const meta = row
      ? `${INSTRUMENT_LABELS[row.instrument] ?? row.instrument ?? '—'} · ${Number.isFinite(row.targetBPM) ? `${row.bpm ?? '—'} → ${row.targetBPM} BPM` : `${row.bpm ?? '—'} BPM · definir alvo`}`
      : 'Remova este item ou adicione o exercício de volta à biblioteca.';
    const duration = createEl('input', {
      type: 'number', min: String(MIN_ITEM_MINUTES), max: String(MAX_ITEM_MINUTES), step: '1',
      value: String(item.durationMin), 'aria-label': `Duração de ${name} em minutos`, dataset: { item: item.id },
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
    const li = createEl('li', { className: item.exerciseId === activeExerciseId && activeExerciseId !== null ? 'today-item today-item-active' : 'today-item', dataset: { item: item.id } }, [
      createEl('div', { className: 'today-item-main' }, [
        createEl('h3', { text: name }),
        createEl('p', { className: 'today-item-meta muted', text: meta }),
      ]),
      createEl('label', { className: 'today-item-duration' }, [createEl('span', { text: 'Duração (min)' }), duration]),
      createEl('div', { className: 'today-item-actions' }, [up, down, remove]),
    ]);
    return li;
  }

  function renderBuilder(rows) {
    const builder = createEl('div', { className: 'today-builder' });
    const items = store.items();
    const list = createEl('ol', { className: 'today-list' });
    const activeExerciseId = session.snapshot().item?.exerciseId ?? null;
    items.forEach((item, index) => list.append(renderItem(item, index, items.length, rows, activeExerciseId)));
    if (items.length === 0) builder.append(createEl('p', { className: 'today-empty muted', text: 'A fila está vazia. Use a sugestão ou adicione exercícios da biblioteca.' }));
    else builder.append(list);
    builder.append(createEl('p', { className: 'today-total muted', role: 'status', text: `Total: ${formatMinutes(queueTotalMs(items))} em ${items.length} item(ns). Padrão de ${DEFAULT_ITEM_MINUTES} min por item.` }));

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
      host.activateTab?.('tab-practice');
      notify('Sessão de hoje começou. O timer fica no painel Treinar.');
      view.open = false;
      render();
    });
    builder.append(createEl('div', { className: 'today-start-row' }, [start, createEl('p', { className: 'today-note muted', text: 'Começar abre o exercício no painel Treinar com o tempo restante, Próximo e Encerrar.' })]));
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
    if (store.status === 'corrupt') {
      const bar = createEl('div', { className: 'today-recovery' }, [
        createEl('span', { text: 'A fila guardada está corrompida. Os bytes originais ficam preservados; baixe-os antes de recuperar.' }),
      ]);
      if (store.recoveryRaw !== null) {
        const raw = createEl('button', { type: 'button', text: 'Baixar fila corrompida' });
        raw.addEventListener('click', () => download(store.recoveryRaw, 'groovegoblin-fila-corrompida.json'));
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
    return box;
  }

  function renderSummary() {
    const summary = store.summary() ?? session.snapshot().summary;
    if (!summary) return null;
    const block = createEl('div', { className: 'today-summary' });
    block.append(createEl('h3', { text: 'Última sessão de hoje' }));
    block.append(createEl('p', { className: 'muted', text: `${new Date(summary.finishedAt).toLocaleString('pt-BR')} · ${formatMinutes(summary.totalElapsedMs)} praticados de ${formatMinutes(summary.plannedMs)} planejados.` }));
    const list = createEl('ul', { className: 'today-summary-list' });
    const practiced = summary.items.filter(item => item.practiced);
    if (practiced.length === 0) block.append(createEl('p', { className: 'today-empty muted', text: 'Nenhum item foi praticado nesta sessão.' }));
    else {
      for (const item of practiced) {
        list.append(createEl('li', {}, [
          createEl('span', { className: 'today-summary-name', text: item.name }),
          createEl('span', { className: 'muted', text: `${formatClock(item.elapsedMs)} praticados de ${formatMinutes(item.plannedMs)}` }),
          createEl('span', { className: 'muted', text: bpmText(item) }),
        ]));
      }
      block.append(list);
    }
    const skipped = summary.items.filter(item => !item.practiced).length;
    if (skipped > 0) block.append(createEl('p', { className: 'muted', text: `${skipped} item(ns) não praticados.` }));
    return block;
  }

  function renderAll() {
    root.replaceChildren();
    const rows = rowsById();
    root.append(renderHeader(rows), renderWarnings());
    if (view.open) {
      root.append(renderBuilder(rows));
      const summary = renderSummary();
      if (summary) root.append(summary);
      const state = session.snapshot();
      const journalNote = [];
      if (state.journal.status && state.journal.status !== 'ready') journalNote.push(state.journal.warning ?? `Diário de prática em estado “${state.journal.status}”.`);
      if (state.journal.problem) journalNote.push(state.journal.problem);
      if (!state.journal.present) journalNote.push('Diário de prática compartilhado não está ligado nesta base; o tempo continua guardado na própria fila.');
      for (const note of journalNote) root.append(createEl('p', { className: 'today-warning', role: 'alert', text: note }));
    }
  }

  // Enquanto o painel está oculto não vale reconstruir a lista (a biblioteca
  // emite a cada autosave); a troca de aba re-renderiza via observador.
  function render() {
    if (root.closest('[hidden]')) return;
    renderKeepingFocus(root, renderAll);
  }

  const unsubscribeStore = store.subscribe(render);
  const unsubscribeLibrary = typeof library.subscribe === 'function' ? library.subscribe(render) : null;
  const panel = document.getElementById('panel-library');
  const observer = new MutationObserver(() => { if (panel && !panel.hidden) render(); });
  if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  render();
  return {
    render,
    destroy() {
      unsubscribeStore?.(); unsubscribeLibrary?.();
      observer.disconnect();
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
  let timer = setInterval(tick, 1000);

  function notify(text, error = false) { host.notify(text, error); }

  function renderAll() {
    const state = session.snapshot();
    root.replaceChildren();
    root.hidden = !state.active && !state.summary;
    if (root.hidden) return;
    if (state.active) root.append(renderRunning(state));
    if (!state.active && state.summary) root.append(renderFinished(state));
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
    block.append(createEl('p', { className: 'muted', text: `${formatMinutes(summary.totalElapsedMs)} praticados em ${summary.items.filter(item => item.practiced).length} item(ns) de ${summary.items.length}.` }));
    const list = createEl('ul', { className: 'today-summary-list' });
    for (const item of summary.items.filter(candidate => candidate.practiced)) {
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

  // O relógio da sessão também avisa quando a meta zera; o tick não toca áudio.
  function tick() {
    if (!session.snapshot().active) return;
    session.tick();
    render();
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
      clearInterval(timer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
      root.remove();
    },
  };
}
