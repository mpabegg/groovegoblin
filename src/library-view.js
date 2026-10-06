// Painel da Biblioteca de exercícios (rodada 4, item 3).
//
// A lista mostra metadados do exercício e o que o treino registrou: último
// treino relativo, melhor resultado no BPM atual e progresso em direção ao
// alvo. Toda ação de dados passa pelo controlador da biblioteca; o painel
// apenas lê, filtra, ordena e pede. Nenhum HTML não confiável é interpretado.

import { createEl, renderKeepingFocus } from './practice.js';
import { SESSION_NAME_MAX } from './session.js';
import { mountExerciseHistory } from './exercise-history.js';

const INSTRUMENTS = Object.freeze([['all', 'Todos'], ['guitar', 'Guitarra'], ['bass', 'Baixo']]);
const SORTS = Object.freeze([
  ['untrained', 'Mais tempo sem treinar'],
  ['goal', 'Mais longe do alvo'],
  ['name', 'Nome (A–Z)'],
]);
const INSTRUMENT_LABELS = Object.freeze({ guitar: 'Guitarra', bass: 'Baixo' });

function relativeFromNow(iso, now = Date.now()) {
  if (!iso) return 'nunca treinado';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '—';
  const diff = Math.max(0, now - time);
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'agora há pouco';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `há ${days} dia${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30);
  return `há ${months} ${months === 1 ? 'mês' : 'meses'}`;
}

function slugify(text) {
  return (text || 'exercicio').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'exercicio';
}

function fillSelect(select, options) {
  select.replaceChildren();
  for (const [value, label] of options) select.appendChild(createEl('option', { value, text: label }));
}

export function mountLibrary(container, host) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para a biblioteca.');
  const library = host?.library;
  if (!library || typeof library.list !== 'function') throw new TypeError('Biblioteca de exercícios ausente.');
  // Toda transição de exercício passa pelo main, para manter session/history
  // em sincronia com a loja autoritativa.
  for (const name of ['openExercise', 'newExercise', 'duplicateExercise', 'deleteExercise', 'undoDeleteExercise', 'updateExerciseMetadata']) {
    if (typeof host?.[name] !== 'function') throw new TypeError(`Biblioteca: host.${name} ausente.`);
  }

  const root = createEl('section', { className: 'library-root', 'aria-label': 'Biblioteca de exercícios' });
  container.appendChild(root);
  // O histórico do exercício abre em um diálogo nativo (Esc e foco vêm do
  // navegador) e lê apenas a biblioteca; mora no body para sobreviver às
  // reconstruções da lista.
  const historyDialog = createEl('dialog', { id: 'library-history-dialog', className: 'history-dialog', 'aria-label': 'Histórico do exercício' });
  const historyBody = createEl('div', { className: 'history-dialog-body' });
  historyDialog.appendChild(historyBody);
  (document.body ?? container).appendChild(historyDialog);
  let historyView = null;
  const view = { instrument: 'all', tag: 'all', query: '', sort: 'untrained' };
  let undo = null;
  let editing = null;

  function notify(text, error = false) { host.notify?.(text, error); }
  const updateMetadata = (id, patch) => host.updateExerciseMetadata(id, patch);

  function rows() {
    return library.list({ filter: { instrument: view.instrument, tag: view.tag, query: view.query }, sort: view.sort });
  }

  function openExercise(id, options) {
    try { host.openExercise?.(id, options ?? {}); }
    catch (error) { notify(error.message, true); }
  }

  function download(text, filename) {
    if (host.download) host.download(text, filename);
    else notify('Download indisponível neste navegador.', true);
  }

  // Abre o histórico do exercício (por padrão, o ativo). Limpeza explícita
  // passa por host.clearExerciseRecords, que preserva exercício e metadados.
  function openHistory(id = null) {
    const targetId = typeof id === 'string' && id.length > 0 ? id : library.active();
    if (!targetId || !library.get(targetId)) { notify('Escolha um exercício para ver o histórico.', true); return null; }
    historyView?.destroy();
    historyView = mountExerciseHistory(historyBody, {
      library,
      exerciseId: targetId,
      notify,
      download,
      clearRecords: candidate => (typeof host.clearExerciseRecords === 'function' ? host.clearExerciseRecords(candidate) : null),
      close: () => historyDialog.close(),
    });
    if (!historyDialog.open) historyDialog.showModal();
    return historyView;
  }

  historyDialog.addEventListener('close', () => { historyView?.destroy(); historyView = null; });

  function renderToolbar() {
    const bar = createEl('header', { className: 'library-toolbar' });
    const add = createEl('button', { id: 'library-new', type: 'button', className: 'primary', text: 'Novo exercício' });
    add.addEventListener('click', () => {
      const entry = host.newExercise();
      editing = { id: entry.id, field: 'name' };
      notify('Novo exercício criado na biblioteca. O anterior continua guardado.');
      render();
    });
    const search = createEl('label', { className: 'library-field' }, [
      createEl('span', { text: 'Buscar' }),
      createEl('input', { id: 'library-search', type: 'search', value: view.query, placeholder: 'Nome do exercício', 'aria-label': 'Buscar exercício por nome' }),
    ]);
    const searchInput = search.querySelector('input');
    searchInput.addEventListener('input', event => {
      view.query = event.target.value;
      const caret = [searchInput.selectionStart, searchInput.selectionEnd];
      render();
      const next = root.querySelector('#library-search');
      if (next?.setSelectionRange) { next.focus(); next.setSelectionRange(caret[0], caret[1]); }
    });
    const instrument = createEl('select', { id: 'library-instrument', 'aria-label': 'Filtrar por instrumento' });
    fillSelect(instrument, INSTRUMENTS);
    instrument.value = view.instrument;
    instrument.addEventListener('change', () => { view.instrument = instrument.value; render(); });
    const tag = createEl('select', { id: 'library-tag', 'aria-label': 'Filtrar por etiqueta' });
    const tags = library.tags();
    fillSelect(tag, [['all', 'Todas as etiquetas'], ...tags.map(name => [name, name])]);
    tag.value = tags.includes(view.tag) ? view.tag : 'all';
    view.tag = tag.value;
    tag.addEventListener('change', () => { view.tag = tag.value; render(); });
    const sort = createEl('select', { id: 'library-sort', 'aria-label': 'Ordenar exercícios' });
    fillSelect(sort, SORTS);
    sort.value = view.sort;
    sort.addEventListener('change', () => { view.sort = sort.value; render(); });
    const exportAll = createEl('button', { id: 'library-export', type: 'button', text: 'Exportar biblioteca' });
    exportAll.addEventListener('click', () => download(library.exportLibrary(), 'groovegoblin-biblioteca.json'));
    const importButton = createEl('button', { id: 'library-import', type: 'button', text: 'Importar' });
    const importFile = createEl('input', { id: 'library-import-file', type: 'file', accept: '.json,application/json', hidden: true });
    importButton.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        const result = payload?.kind === 'groovegoblin-exercise-library' ? library.importLibrary(text) : library.importExercise(text);
        notify(`Importação concluída: ${result.added} exercício(s) adicionado(s), ${result.skipped} já presente(s) sem sobrescrever.`);
      } catch (error) {
        notify(`Importação rejeitada: ${error.message}`, true);
      }
      render();
    });
    bar.append(add, search, createEl('label', { className: 'library-field' }, [createEl('span', { text: 'Instrumento' }), instrument]),
      createEl('label', { className: 'library-field' }, [createEl('span', { text: 'Etiqueta' }), tag]),
      createEl('label', { className: 'library-field' }, [createEl('span', { text: 'Ordenar' }), sort]),
      exportAll, importButton, importFile);
    return bar;
  }

  function renderUndo() {
    const bar = createEl('div', { className: 'library-undo', role: 'status', hidden: !undo });
    if (!undo) return bar;
    bar.append(
      createEl('span', { text: `Exercício “${undo.entry.metadata.name}” excluído.` }),
      (() => {
        const button = createEl('button', { id: 'library-undo', type: 'button', text: 'Desfazer exclusão' });
        button.addEventListener('click', () => {
          const restored = host.undoDeleteExercise();
          undo = null;
          if (restored) notify(`Exercício “${restored.metadata.name}” restaurado.`);
          render();
        });
        return button;
      })(),
    );
    return bar;
  }

  function renderEditor(entry) {
    const form = createEl('form', { className: 'library-editor' });
    const field = editing.field;
    const label = { name: 'Nome', tags: 'Etiquetas (separadas por vírgula)', targetBPM: 'BPM alvo', notes: 'Anotações' }[field];
    const value = field === 'tags' ? entry.metadata.tags.join(', ')
      : field === 'targetBPM' ? String(entry.metadata.targetBPM ?? entry.session.bpm ?? '')
        : field === 'notes' ? entry.metadata.notes : entry.metadata.name;
    const input = field === 'notes'
      ? createEl('textarea', { name: 'value', rows: '3', 'aria-label': label }, value)
      : createEl('input', { name: 'value', type: field === 'targetBPM' ? 'number' : 'text', min: field === 'targetBPM' ? '30' : null, max: field === 'targetBPM' ? '300' : null, maxlength: field === 'name' ? String(SESSION_NAME_MAX) : null, value, 'aria-label': label });
    form.append(createEl('label', { text: label }), input);
    const save = createEl('button', { type: 'submit', text: 'Salvar' });
    const cancel = createEl('button', { type: 'button', text: 'Cancelar' });
    cancel.addEventListener('click', () => { editing = null; render(); });
    form.append(createEl('div', { className: 'library-editor-actions' }, [save, cancel]));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const raw = input.value;
      try {
        if (field === 'tags') updateMetadata(entry.id, { tags: raw.split(',') });
        else if (field === 'targetBPM') {
          const bpm = Number(raw);
          if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300) { notify('Informe um BPM alvo entre 30 e 300.', true); return; }
          updateMetadata(entry.id, { targetBPM: bpm });
        } else if (field === 'notes') updateMetadata(entry.id, { notes: raw });
        else {
          const name = raw.trim();
          if (!name) { notify('O nome não pode ficar vazio.', true); return; }
          updateMetadata(entry.id, { name });
        }
        editing = null;
        notify('Exercício atualizado.');
      } catch (error) { notify(error.message, true); }
      render();
    });
    return form;
  }

  function actionButton(label, action, entry) {
    const button = createEl('button', { type: 'button', dataset: { action }, text: label });
    button.addEventListener('click', () => {
      switch (action) {
        case 'train': openExercise(entry.id, { train: true }); break;
        case 'edit': openExercise(entry.id, { train: false }); break;
        case 'duplicate': host.duplicateExercise(entry.id); notify('Exercício duplicado; a cópia virou o exercício ativo.'); render(); break;
        case 'rename': editing = { id: entry.id, field: 'name' }; render(); break;
        case 'tags': editing = { id: entry.id, field: 'tags' }; render(); break;
        case 'target': editing = { id: entry.id, field: 'targetBPM' }; render(); break;
        case 'notes': editing = { id: entry.id, field: 'notes' }; render(); break;
        case 'export': download(library.exportExercise(entry.id), `${slugify(entry.metadata.name)}.json`); break;
        case 'history': openHistory(entry.id); break;
        case 'delete': {
          const removed = host.deleteExercise(entry.id);
          if (removed) { undo = { entry: removed }; notify(`Exercício “${removed.metadata.name}” excluído. Use “Desfazer exclusão” se foi engano.`); }
          render();
          break;
        }
        default: break;
      }
    });
    return button;
  }

  function renderItem(row) {
    const entry = library.get(row.id);
    const active = library.active() === row.id;
    const item = createEl('li', { className: `library-item${active ? ' library-item-active' : ''}`, dataset: { id: row.id } });
    const target = row.targetBPM ?? row.bpm ?? '—';
    const best = row.bestAtCurrentBpm;
    const stats = [
      `Último treino: ${relativeFromNow(row.lastTrainedAt)}`,
      best === null ? 'Melhor neste BPM: —'
        : best.score !== null ? `Melhor neste BPM: ${best.score}%`
          : `Melhor neste BPM: ${Math.round(best.ratio * 100)}% dos ataques`,
      row.bestBpm === null ? 'Melhor BPM: —' : `Melhor BPM: ${row.bestBpm}`,
    ];
    const progress = Math.round((row.progress ?? 0) * 100);
    const main = createEl('div', { className: 'library-item-main' }, [
      createEl('h3', { text: row.name }),
      createEl('p', { className: 'library-meta', text: `${INSTRUMENT_LABELS[row.instrument] ?? row.instrument} · ${row.bars ?? '—'} compasso(s) · ${row.bpm ?? '—'} → ${target} BPM${active ? ' · exercício ativo' : ''}` }),
      createEl('p', { className: 'library-tags' }, row.tags.length ? row.tags.map(tag => createEl('span', { className: 'library-tag', text: tag })) : [createEl('span', { className: 'muted', text: 'Sem etiquetas' })]),
      createEl('p', { className: 'library-stats muted', text: stats.join(' · ') }),
      createEl('div', { className: 'library-progress', role: 'img', 'aria-label': `Progresso em direção ao alvo: ${progress}%` }, [createEl('span', { style: `width: ${progress}%` })]),
    ]);
    const actions = createEl('div', { className: 'library-actions' }, [
      actionButton('Treinar', 'train', entry),
      actionButton('Editar', 'edit', entry),
      (() => {
        const menu = createEl('details', { className: 'library-menu' });
        menu.append(createEl('summary', { text: 'Mais ações' }), createEl('div', { className: 'library-menu-content' }, [
          actionButton('Duplicar', 'duplicate', entry),
          actionButton('Renomear', 'rename', entry),
          actionButton('Etiquetas', 'tags', entry),
          actionButton('Alvo de BPM', 'target', entry),
          actionButton('Anotações', 'notes', entry),
          actionButton(row.recordsCount > 0 ? `Histórico (${row.recordsCount})` : 'Histórico', 'history', entry),
          actionButton('Exportar', 'export', entry),
          actionButton('Excluir', 'delete', entry),
        ]));
        return menu;
      })(),
    ]);
    item.append(main, actions);
    if (editing?.id === row.id) item.append(renderEditor(entry));
    return item;
  }

  function renderAll() {
    root.replaceChildren();
    const list = rows();
    const total = library.size();
    root.append(
      renderToolbar(),
      createEl('p', { id: 'library-summary', className: 'library-summary muted', role: 'status', text: `${total} exercício(s) na biblioteca · ${list.length} exibido(s). Cada treino é salvo automaticamente aqui.` }),
      renderUndo(),
    );
    if (library.warning) root.append(createEl('p', { className: 'library-warning', role: 'alert', text: library.warning }));
    if (library.status === 'corrupt') {
      const bar = createEl('div', { className: 'library-recovery' });
      bar.append(createEl('span', { text: 'A biblioteca guardada está corrompida. Os bytes originais ficam preservados; recupere só depois de baixar o backup em Ajuda.' }));
      if (library.recoveryRaw !== null) {
        const downloadButton = createEl('button', { type: 'button', text: 'Baixar bytes corrompidos' });
        downloadButton.addEventListener('click', () => download(library.recoveryRaw, 'groovegoblin-biblioteca-corrompida.json'));
        bar.append(downloadButton);
      }
      const recover = createEl('button', { type: 'button', text: 'Recuperar biblioteca' });
      recover.addEventListener('click', () => {
        if (library.replaceCorrupt()) notify('Biblioteca recuperada a partir do estado migrado.');
        else notify(library.warning ?? 'Recuperação indisponível.', true);
        render();
      });
      bar.append(recover);
      root.append(bar);
    }
    const container_ = createEl('ul', { className: 'library-list' });
    for (const row of list) container_.append(renderItem(row));
    root.append(container_);
    if (list.length === 0) root.append(createEl('p', { className: 'library-empty muted', text: 'Nenhum exercício corresponde aos filtros.' }));
  }

  // Enquanto o painel está oculto não vale reconstruir a lista; o main chama
  // render() ao ativar a aba.
  function render() {
    if (root.closest('[hidden]')) return;
    renderKeepingFocus(root, renderAll);
  }

  const unsubscribe = library.subscribe(render);
  render();
  return {
    render,
    openHistory,
    destroy() {
      unsubscribe?.();
      historyView?.destroy();
      historyDialog.remove();
      root.remove();
    },
  };
}
