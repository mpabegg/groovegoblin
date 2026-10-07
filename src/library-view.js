// Painel da Biblioteca de exercícios (rodada 4, item 3).
//
// A lista mostra metadados do exercício e o que o treino registrou: último
// treino relativo, melhor resultado no BPM atual e progresso em direção ao
// alvo. Toda ação de dados passa pelo controlador da biblioteca; o painel
// apenas lê, filtra, ordena e pede. Nenhum HTML não confiável é interpretado.

import { createEl, renderKeepingFocus } from './practice.js';
import { SESSION_NAME_MAX } from './session.js';
import { mountExerciseHistory } from './exercise-history.js';
import { mountCourseWorkspace } from './course-workspace.js';
import { sharedCourseStore } from './course-store.js';
import { sharedAttachmentStore } from './course-attachments.js';
import { mountLibraryBackup } from './library-backup-view.js';
import { createCourseContentClient } from './course-content.js';
import { sharedMaterialPanel } from './material-panel.js';
// As formas de dedilhado (A3) vivem fora da sessão e entram na cópia de
// segurança: a MESMA instância usada pelo painel Braço.
import { fingeringShapeStore, shapeChoicesForRecipe, shapeForRecipe } from './fingering-shapes-controller.js';
import { sharedShapeBindingStore } from './course-shape-binding.js';
import { exerciseMaterialActions, exerciseOriginBadges, mountExerciseOrigins } from './course-lesson-origins.js';
import { createStudyController } from './study-controller.js';
import { bindCoursePrivacy, COURSE_EXPORT_NOTICE, isCourseContent } from './course-privacy.js';
import { mountPrivateDownload } from './private-download.js';
import { appPins } from './app-services.js';

const INSTRUMENTS = Object.freeze([['all', 'Todos'], ['guitar', 'Guitarra'], ['bass', 'Baixo']]);
const SORTS = Object.freeze([
  ['untrained', 'Mais tempo sem treinar'],
  ['goal', 'Mais longe do alvo'],
  ['name', 'Nome (A–Z)'],
]);
const INSTRUMENT_LABELS = Object.freeze({ guitar: 'Guitarra', bass: 'Baixo' });
// A lista em repouso mostra poucas linhas por página: o número de controles
// fica estável, sem esconder nenhuma ação.
const LIST_PAGE_SIZE = 2;

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
  // A loja de cursos (IndexedDB próprio) e o banco de anexos são montados UMA
  // vez por app e compartilhados: a lista de exercícios mostra a origem mesmo
  // sem ninguém ter visitado Cursos, e a aula lê a mesma conexão. Sem
  // IndexedDB a loja nasce `persistent:false` e nada finge ser salvo.
  let courseStore = null;
  const courseStorePromise = sharedCourseStore().then(store => { courseStore = store; return store; });
  const disposePrivacy = bindCoursePrivacy(library, courseStorePromise);
  const attachmentsPromise = sharedAttachmentStore();
  const originsOf = exerciseId => (courseStore ? courseStore.originsOf(exerciseId) : []);
  void courseStorePromise.catch(() => {});
  // A loja carrega depois do primeiro desenho: redesenha quando ela chega, para
  // a origem e a apostila do exercício aparecerem sem visitar Cursos antes.
  void courseStorePromise.then(() => renderAll()).catch(() => {});
  // Alternador Exercícios/Cursos dentro da MESMA aba da Biblioteca: os quatro
  // destinos principais do app não mudam, e os cursos ficam ao lado dos
  // exercícios sem virar uma aba própria. A escolha é um seletor único — dois
  // botões ocupariam um controle a mais na página em repouso sem acrescentar
  // nada (o limite da Biblioteca vale para a página inteira, não só a lista).
  const coursesMount = createEl('div', { id: 'courses-mount', hidden: true });
  const modeSelect = createEl('select', { id: 'library-mode', 'aria-label': 'Conteúdo da biblioteca' });
  fillSelect(modeSelect, [['exercises', 'Exercícios'], ['courses', 'Cursos']]);
  modeSelect.value = 'exercises';
  modeSelect.addEventListener('change', () => setMode(modeSelect.value));
  const switchBar = createEl('div', { className: 'library-switch' }, [
    createEl('label', { className: 'library-field' }, [createEl('span', { text: 'Conteúdo' }), modeSelect]),
  ]);
  let mode = 'exercises';
  let coursesView = null;
  let coursesOpening = null;
  // Conteúdo de curso no servidor: sonda quieta; ao ficar pronto, a página de
  // cursos se redesenha para mostrar a pasta de entrada e os materiais.
  const content = createCourseContentClient({ onChange: () => coursesView?.render() });
  void content.start();
  // O painel do material é UM só para o app: a página da aula o monta no host
  // do workspace e a origem do exercício (Estúdio/Biblioteca) abre a apostila
  // nele. `panelFor()` é preguiçoso de propósito — a instância nasce na
  // primeira chamada, quando o body já existe.
  const panelFor = () => sharedMaterialPanel({ content });
  function setMode(next) {
    mode = next;
    modeSelect.value = next;
    root.hidden = next !== 'exercises';
    coursesMount.hidden = next !== 'courses';
    if (next === 'courses') void openCourses();
    else render();
  }
  // Montagem única da loja + anexos + workspace (cursos e aula): uma promessa
  // só evita abrir duas conexões se o usuário trocar de modo rápido. Sem
  // IndexedDB o próprio workspace avisa e recusa salvar.
  function openCourses() {
    if (coursesOpening) return coursesOpening;
    coursesMount.replaceChildren(createEl('p', { className: 'courses-summary muted', role: 'status', text: 'Carregando cursos…' }));
    coursesOpening = (async () => {
      try {
        const store = await courseStorePromise;
        const attachments = await attachmentsPromise;
        if (coursesView) return coursesView;
        coursesMount.replaceChildren();
        coursesView = mountCourseWorkspace(coursesMount, {
          store,
          attachments,
          library,
          notify: host.notify,
          download: host.download,
          openExercise: (id, options) => openExercise(id, options),
          instrumentPreference: typeof host.getInstrument === 'function' ? host.getInstrument() : null,
          // Aula e sugestão (etapa 5): o MESMO controlador de estudo da
          // Biblioteca cria o exercício da aula já com notas, e as formas/
          // vínculos são as lojas compartilhadas do painel Braço. Os ganchos de
          // abertura (Braço, material, conversão no servidor) vêm do main
          // quando existem — sem eles a página avisa em vez de fingir.
          studies,
          shapes: {
            choicesFor: (profile) => shapeChoicesForRecipe(profile),
            shape: (id, profile) => shapeForRecipe(id, profile),
          },
          bindings: sharedShapeBindingStore(),
          // Conteúdo do curso no servidor (etapa 8): o cliente da API de
          // materiais e o painel lateral único do app (apostila embutida e
          // faixa com Range). Sem servidor, os dois ficam inertes e a página
          // mostra só os anexos manuais de sempre.
          content,
          panel: sharedMaterialPanel({ content }),
          openFretboard: typeof host.openFretboard === 'function' ? host.openFretboard : undefined,
          openMaterial: typeof host.openMaterial === 'function' ? host.openMaterial : undefined,
          serverImport: typeof host.serverImport === 'function' ? host.serverImport : undefined,
          // "Manter offline" (B4): o usuário escolhe guardar os bytes do
          // material do servidor no navegador; a marca vai para o motor de
          // sincronização e a cópia fica na loja de anexos de sempre (sem
          // segunda cópia e sem baixar nada enquanto o servidor transmite).
          pins: appPins(),
        });
        return coursesView;
      } catch (error) {
        coursesMount.replaceChildren(createEl('p', { className: 'courses-error', role: 'alert', text: `Não foi possível abrir a loja de cursos: ${error.message}` }));
        return null;
      }
    })();
    return coursesOpening;
  }
  // Backup agregado (biblioteca + cursos + anexos) no MESMO diálogo do menu
  // Arquivo: montado UMA vez, na primeira vez que o usuário pede exportar ou
  // importar. As lojas compartilhadas já vêm daqui; se alguma não carregar, o
  // diálogo abre mesmo assim com ela ausente (“não conferidos”/recusa honesta)
  // em vez de fingir um backup completo. Nada é montado no repouso.
  let backupDialog = null;
  let backupOpening = null;
  async function backupDialogFor() {
    if (backupDialog) return backupDialog;
    if (!backupOpening) {
      backupOpening = (async () => {
        try {
          const store = await courseStorePromise.catch(() => null);
          const attachments = await attachmentsPromise.catch(() => null);
          backupDialog = mountLibraryBackup(document.body, {
            library, store, attachments, notify, download,
            shapes: fingeringShapeStore(),
            // Vínculos rótulo→forma do catálogo (A5): a MESMA loja única do app
            // que a página da aula usa, para o backup privado levá-los.
            bindings: sharedShapeBindingStore(),
          });
          return backupDialog;
        } finally {
          backupOpening = null;   // a promessa em voo deixa de existir; o diálogo fica
        }
      })();
    }
    try { return await backupOpening; }
    catch (error) {
      notify(`Não foi possível abrir o backup da biblioteca: ${error.message}`, true);
      return null;
    }
  }
  async function openBackup(mode) {
    const dialog = await backupDialogFor();
    if (!dialog) return;
    if (mode === 'import') dialog.openImport(); else dialog.openExport();
  }
  // Abrir uma aula (da origem do exercício, do Hoje ou de qualquer outra tela):
  // vai para Cursos, garante o workspace montado e abre a página da aula.
  async function openLesson(courseId, lessonId) {
    setMode('courses');
    host.activateLibrary?.();
    const workspace = await openCourses();
    if (!workspace) return false;
    return workspace.openLesson(courseId, lessonId);
  }
  // Origem do exercício no Estúdio: UM ponto só, na linha do inspetor, sem
  // assinatura por card. Monta quando a loja compartilhada entrega (o
  // controller escuta a loja por dentro e troca de exercício com o ativo).
  let studioOrigins = null;
  void courseStorePromise.then(store => {
    if (studioOrigins) return;
    const slot = document.getElementById('studio-course-origin');
    if (!slot) return;
    studioOrigins = mountExerciseOrigins(slot, {
      store,
      exerciseId: library.active(),
      onOpenLesson: (courseId, lessonId) => { void openLesson(courseId, lessonId); },
      library,
      content,
      panel: panelFor(),
      notify,
      attachments: attachmentsPromise,
    });
  }).catch(() => { /* sem loja de cursos: sem linha de origem, sem mentira */ });
  container.append(switchBar, root, coursesMount);

  // O histórico do exercício abre em um diálogo nativo (Esc e foco vêm do
  // navegador) e lê apenas a biblioteca; mora no body para sobreviver às
  // reconstruções da lista.
  const historyDialog = createEl('dialog', { id: 'library-history-dialog', className: 'history-dialog', 'aria-label': 'Histórico do exercício' });
  const historyBody = createEl('div', { className: 'history-dialog-body' });
  historyDialog.appendChild(historyBody);
  (document.body ?? container).appendChild(historyDialog);
  // Bytes crus da biblioteca (legado/recuperação) podem carregar nome de
  // exercício e origem de aula: nome PRIVADO + confirmação nativa; cancelar não
  // gera arquivo e os bytes originais saem intactos.
  const privateFiles = mountPrivateDownload(document.body ?? container, { download, notify });
  let historyView = null;
  const view = { instrument: 'all', tag: 'all', query: '', sort: 'untrained', page: 1 };
  let undo = null;
  let editing = null;

  function notify(text, error = false) { host.notify?.(text, error); }
  const updateMetadata = (id, patch) => host.updateExerciseMetadata(id, patch);
  // Estúdio de estudo (item A4): a Biblioteca é a entrada. A tela nasce só
  // quando o usuário abre (nada de DOM no repouso) e a criação passa pela mesma
  // loja e pelo mesmo caminho de abertura do main. O perfil do instrumento vem
  // do host quando ele existe e, sem ele, do instrumento da SESSÃO do exercício
  // ativo — nunca de um valor fixo (o baixo de 5 cordas do perfil precisa valer).
  const studies = createStudyController({
    library,
    openExercise: (id, options) => openExercise(id, options),
    getInstrument: typeof host.getInstrument === 'function'
      ? host.getInstrument
      : () => library.get(library.active())?.session?.extensions?.studio?.instrument ?? null,
    notify,
  });

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
    // Item A4: botão "Novo estudo" na Biblioteca (o diálogo traz presets, prévia
    // ao vivo e avisos com ação). É UM controle a mais em repouso.
    const study = createEl('button', { id: 'library-new-study', type: 'button', text: 'Novo estudo' });
    study.addEventListener('click', () => studies.open());
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
    exportAll.addEventListener('click', () => { void openBackup('export'); });
    const importButton = createEl('button', { id: 'library-import', type: 'button', text: 'Importar' });
    importButton.addEventListener('click', () => { void openBackup('import'); });
    // Exportar/Importar ficam no grupo “Arquivo”: continuam a um clique e a
    // barra em repouso não gasta dois controles permanentes com eles. A
    // importação (agregado, legado ou sessão) vive no diálogo — nada de um
    // segundo campo de arquivo com validação paralela.
    const files = createEl('details', { className: 'library-menu library-files', dataset: { disclosure: 'library-files' } });
    files.append(createEl('summary', { text: 'Arquivo' }), createEl('div', { className: 'library-menu-content' }, [exportAll, importButton]));
    bar.append(add, study, search, createEl('label', { className: 'library-field' }, [createEl('span', { text: 'Instrumento' }), instrument]),
      createEl('label', { className: 'library-field' }, [createEl('span', { text: 'Etiqueta' }), tag]),
      createEl('label', { className: 'library-field' }, [createEl('span', { text: 'Ordenar' }), sort]),
      files);
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
      : field === 'targetBPM' ? String(entry.metadata.targetBPM ?? '')
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
        // "Gerar variação" (A4): reabre o diálogo preenchido pela receita do
        // exercício. O controlador do estudo já avisa quando não há receita.
        case 'variation': studies.openVariation(entry.id); break;
        case 'rename': editing = { id: entry.id, field: 'name' }; render(); break;
        case 'tags': editing = { id: entry.id, field: 'tags' }; render(); break;
        case 'target': editing = { id: entry.id, field: 'targetBPM' }; render(); break;
        case 'notes': editing = { id: entry.id, field: 'notes' }; render(); break;
        case 'export': {
          const text = library.exportExercise(entry.id);
          download(text, `${slugify(JSON.parse(text).exercise.metadata.name)}.json`);
          if (isCourseContent({ entry, session: entry.session })) notify(COURSE_EXPORT_NOTICE);
          break;
        }
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
    const hasTarget = Number.isFinite(row.targetBPM);
    const goalText = hasTarget ? `${row.bpm ?? '—'} → ${row.targetBPM} BPM` : `${row.bpm ?? '—'} BPM · definir alvo`;
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
      createEl('p', { className: 'library-meta', text: `${INSTRUMENT_LABELS[row.instrument] ?? row.instrument} · ${row.bars ?? '—'} compasso(s) · ${goalText}${active ? ' · exercício ativo' : ''}` }),
      createEl('p', { className: 'library-tags' }, row.tags.length ? row.tags.map(tag => createEl('span', { className: 'library-tag', text: tag })) : [createEl('span', { className: 'muted', text: 'Sem etiquetas' })]),
      createEl('p', { className: 'library-stats muted', text: stats.join(' · ') }),
      // Vínculos do estudo (A4): variação e grupo das 12 tonalidades. Só
      // rótulos musicais/privados que já vivem na metadata do exercício.
      ...(row.study?.origin || row.study?.group ? [createEl('p', { className: 'library-study-links muted' }, [
        row.study.origin ? createEl('span', { className: 'library-study-link', text: `Variação de “${row.study.origin.name}”` }) : null,
        row.study.group ? createEl('span', { className: 'library-study-group', text: row.study.group.label }) : null,
      ])] : []),
      createEl('div', { className: 'library-progress', role: 'img', 'aria-label': hasTarget ? `Progresso em direção ao alvo: ${progress}%` : 'Sem alvo definido' }, [createEl('span', { style: `width: ${hasTarget ? progress : 0}%` })]),
    ]);
    // Treinar continua direto; Editar (e o resto) vive em Mais ações, e a
    // origem do exercício no curso entra como UM controle — com origem, o card
    // gasta os mesmos três controles de antes.
    const actions = createEl('div', { className: 'library-actions' }, [
      actionButton('Treinar', 'train', entry),
      ...exerciseOriginBadges(originsOf(row.id), {
        onOpenLesson: (courseId, lessonId) => { void openLesson(courseId, lessonId); },
      }),
      // "Ver na apostila" do exercício gerado: o MESMO painel, no material
      // exato que o exercício guardou. Sem servidor não devolve nó nenhum.
      ...exerciseMaterialActions(courseStore, row.id, {
        library, content, panel: panelFor(), notify, attachments: attachmentsPromise,
      }),
      (() => {
        const menu = createEl('details', { className: 'library-menu' });
        menu.append(createEl('summary', { text: 'Mais ações' }), createEl('div', { className: 'library-menu-content' }, [
          actionButton('Editar', 'edit', entry),
          // Só exercícios COM receita de estudo podem gerar variação.
          ...(entry.metadata.study?.recipe ? [actionButton('Gerar variação', 'variation', entry)] : []),
          actionButton('Duplicar', 'duplicate', entry),
          actionButton('Renomear', 'rename', entry),
          actionButton('Etiquetas', 'tags', entry),
          actionButton(hasTarget ? 'Alvo de BPM' : 'Definir alvo', 'target', entry),
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
    const all = rows();
    const total = library.size();
    // Paginação curta: muitos exercícios não multiplicam controles em repouso.
    // O seletor de página só aparece quando existe mais de uma página.
    const pages = Math.max(1, Math.ceil(all.length / LIST_PAGE_SIZE));
    if (editing?.id) {
      const index = all.findIndex(row => row.id === editing.id);
      if (index >= 0) view.page = Math.floor(index / LIST_PAGE_SIZE) + 1;
    }
    view.page = Math.min(pages, Math.max(1, view.page));
    const list = all.slice((view.page - 1) * LIST_PAGE_SIZE, view.page * LIST_PAGE_SIZE);
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
        const downloadButton = createEl('button', { type: 'button', dataset: { raw: 'library' }, text: 'Baixar bytes corrompidos' });
        downloadButton.addEventListener('click', () => { void privateFiles.download(library.recoveryRaw, 'groovegoblin-biblioteca-corrompida.json'); });
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
    if (pages > 1) root.append(renderPager(all.length, pages));
  }

  // Seletor de página (um controle): aparece só com mais de uma página, e a
  // lista visível nunca passa de LIST_PAGE_SIZE itens.
  function renderPager(filtered, pages) {
    const bar = createEl('div', { className: 'library-pager' });
    const first = (view.page - 1) * LIST_PAGE_SIZE + 1;
    const last = Math.min(filtered, view.page * LIST_PAGE_SIZE);
    const select = createEl('select', { id: 'library-page', 'aria-label': 'Página da lista de exercícios' });
    for (let page = 1; page <= pages; page += 1) select.append(createEl('option', { value: String(page), text: `Página ${page} de ${pages}` }));
    select.value = String(view.page);
    select.addEventListener('change', () => { view.page = Number(select.value) || 1; render(); });
    bar.append(createEl('span', { className: 'muted', text: `Mostrando ${first}–${last} de ${filtered} exercício(s) no filtro.` }), select);
    return bar;
  }

  // Enquanto o painel está oculto não vale reconstruir a lista; o main chama
  // render() ao ativar a aba. No modo Cursos quem redesenha é a lista de cursos.
  function render() {
    // A linha de origem do Estúdio acompanha o exercício ativo mesmo com a
    // Biblioteca escondida (é no Estúdio que ela aparece).
    studioOrigins?.setExercise(library.active());
    if (mode === 'courses') { coursesView?.render(); return; }
    if (root.closest('[hidden]')) return;
    renderKeepingFocus(root, renderAll);
  }

  const unsubscribe = library.subscribe(render);
  render();
  return {
    render,
    openHistory,
    openLesson,
    destroy() {
      unsubscribe?.();
      studies.destroy();
      disposePrivacy();
      studioOrigins?.destroy();
      historyView?.destroy();
      privateFiles.destroy();
      historyDialog.remove();
      backupDialog?.destroy();
      backupDialog = null;
      coursesView?.destroy();
      switchBar.remove();
      coursesMount.remove();
      root.remove();
    },
  };
}
