// Interface do laboratório de repertório. Exporta mountRepertoire(container, host)
// -> { render(), captureTake(attempts, detail), stop(), destroy() }.
//
// host (fornecido pela UI do estúdio):
//   getSession(), updateSession(patch), replaceSession(session), play(mode), stop(),
//   notify(text, error), preview(notes, options), saveTake(attempts, detail),
//   renderSession(session, { loops, sampleRate, attempts }) -> Promise<AudioBuffer>
//
// Exclusão mútua de transporte: toda reprodução daqui chama host.stop() logo antes
// de soar; a UI chama stop() deste módulo antes de tocar o estúdio. Um contador de
// geração impede que um processamento lento comece a tocar depois de um stop().
//
// Nada é gravado do microfone: takes são renders do arranjo gerado, tentativas de
// teclado/toque renderizadas, misturas e arquivos importados, sempre rotulados.

import {
  ITEM_SOURCES, MARKER_KINDS, SECTION_PRESETS, createItem, normalizeItem, createId, formatTime, parseTime,
  normalizeRegion, createMarker, upsertMarker, removeMarker, sectionList, createExercise, exerciseSchedule,
  recordPractice, regionNotesToSessionPatch, createSetlist, addSetlistEntry, moveSetlistEntry, removeSetlistEntry,
  pruneSetlist, compareOnsets, tapTempo, beatGrid, analysisTempo, itemLabel, DEFAULT_PROCESSING,
} from './repertoire.js';
import { openRepertoireStore, describeStorageError, formatBytes } from './repertoire-store.js';
import { createJobRunner, JobCancelledError } from './repertoire-jobs.js';
import { RepertoirePlayer } from './repertoire-player.js';
import {
  isIdentityProcessing, validateProcessing, processingMemoryEstimate, mixToMono, rootMeanSquare, resample,
  SPEED_MIN, SPEED_MAX, SEMITONE_LIMIT, CENTS_LIMIT,
} from './repertoire-dsp.js';
import { pickOnsets, midiToName, ANALYSIS_SAMPLE_RATE } from './repertoire-analysis.js';
import { encodeWav, decodeWav, sessionToMidi, notesToMidi, parseMidi, midiToSessionPatch, defaultMidiTrack, QUANTIZE_GRIDS } from './repertoire-formats.js';
import { createAssignmentPackage, serializePackage, parsePackage, PACKAGE_EXTENSION, MAX_EMBEDDED_AUDIO_BYTES } from './repertoire-package.js';
import { drawWaveform, timeAtX } from './repertoire-waveform.js';

export const AUDIO_ACCEPT = 'audio/*,.wav,.mp3,.ogg,.oga,.opus,.flac,.m4a,.aac,.webm';
export const MAX_IMPORT_BYTES = 150 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 15 * 60;
export const PROCESS_MEMORY_LIMIT = 320 * 1024 * 1024;
const PROCESSED_CACHE_BYTES = 256 * 1024 * 1024;
const BUFFER_CACHE_ITEMS = 3;
const PREFS_KEY = 'groovegoblin.repertoire.ui.v1';
const TABS = [
  ['markers', 'Marcadores'],
  ['analysis', 'Análise'],
  ['takes', 'Takes e A/B'],
  ['exercises', 'Exercícios'],
  ['setlists', 'Setlists'],
  ['share', 'Exportar e compartilhar'],
];
const QUANTIZE_LABELS = {
  sixteenth: 'Semicolcheia (1/16)',
  'eighth-triplet': 'Tercina de colcheia',
  'sixteenth-triplet': 'Tercina de semicolcheia',
  'thirty-second': 'Fusa (1/32)',
  none: 'Sem quantização',
};
let mountCount = 0;

// append/replaceChildren transformam valores omitidos em texto sem este filtro.
function domChildren(children) {
  return children.flat(Infinity)
    .filter(child => child !== null && child !== undefined && typeof child !== 'boolean')
    .map(child => (typeof child === 'string' || typeof child === 'number' ? String(child) : child));
}

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  let value;
  for (const [key, val] of Object.entries(props ?? {})) {
    if (val === undefined || val === null || val === false) continue;
    if (key === 'value') value = val;
    else if (key === 'class') element.className = val;
    else if (key === 'text') element.textContent = val;
    else if (key === 'for') element.htmlFor = val;
    else if (key.startsWith('on') && typeof val === 'function') element.addEventListener(key.slice(2), val);
    else if (key.startsWith('aria-') || key.startsWith('data-') || key === 'role') element.setAttribute(key, val === true ? 'true' : String(val));
    else if (key === 'list' || key === 'for' || !(key in element)) element.setAttribute(key, val === true ? '' : String(val));
    else element[key] = val;
  }
  element.append(...domChildren(children));
  if (value !== undefined) element.value = value;
  return element;
}

function field(label, control, hint) {
  return h('label', { class: 'rep-field' }, h('span', { text: label }), control, hint ? h('small', { text: hint }) : null);
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function slug(name) {
  const clean = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60);
  return clean || 'groovegoblin';
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = h('a', { href: url, download: filename, hidden: true });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function channelsOf(buffer) {
  return Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
}

function mixChannels(a, b, gainA, gainB) {
  const count = Math.max(a.length, b.length);
  const length = Math.max(a[0].length, b[0].length);
  return Array.from({ length: count }, (_, c) => {
    const left = a[Math.min(c, a.length - 1)];
    const right = b[Math.min(c, b.length - 1)];
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = (left[i] ?? 0) * gainA + (right[i] ?? 0) * gainB;
    return out;
  });
}

function processingText(processing) {
  const parts = [pct(processing.speed)];
  if (processing.semitones || processing.cents) {
    parts.push(`${processing.semitones >= 0 ? '+' : ''}${processing.semitones} st${processing.cents ? ` ${processing.cents >= 0 ? '+' : ''}${processing.cents} cents` : ''}`);
  }
  return parts.join(', ');
}

function loadPrefs() {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) ?? 'null');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function mountRepertoire(container, host) {
  if (!container || typeof container.append !== 'function') throw new TypeError('mountRepertoire precisa de um elemento contêiner.');
  for (const name of ['getSession', 'replaceSession', 'updateSession', 'stop', 'notify', 'renderSession']) {
    if (typeof host?.[name] !== 'function') throw new TypeError(`host.${name} é obrigatório para o Repertório.`);
  }
  const prefix = `rep${++mountCount}`;
  const uid = name => `${prefix}-${name}`;
  const prefs = loadPrefs();
  const state = {
    items: [],
    exercises: [],
    setlists: [],
    corrupt: [],
    unsaved: new Map(),
    missingMedia: new Set(),
    selectedId: typeof prefs.selectedId === 'string' ? prefs.selectedId : null,
    tab: TABS.some(([id]) => id === prefs.tab) ? prefs.tab : 'markers',
    cursor: 0,
    view: { start: 0, end: 1 },
    zoom: 1,
    selection: null,
    show: { grid: true, beats: false, onsets: true, chords: true, notes: true, ...(prefs.show ?? {}) },
    minNoteConfidence: 0.6,
    analyzeRegionOnly: false,
    ab: { a: prefs.ab?.a ?? null, b: prefs.ab?.b ?? null, offset: 0, match: true, active: 'a', result: null },
    setlistId: typeof prefs.setlistId === 'string' ? prefs.setlistId : null,
    setlistPlay: null,
    practice: null,
    playingItemId: null,
    taps: [],
    midi: null,
    pendingPackage: null,
    storageInfo: null,
    loading: true,
    deleteArm: null,
  };
  const buffers = new Map();
  const processedCache = new Map();
  const pendingMedia = new Map();
  const analyses = new Map();
  const jobs = createJobRunner();
  const player = new RepertoirePlayer({ onEnded: handleEnded });
  let store = null;
  let destroyed = false;
  let frame = 0;
  let playGeneration = 0;
  let drag = null;
  let deleteTimer = 0;
  let pendingWork = 0; // importações, renders e gravações ainda em andamento
  const disclosureState = new Map();
  const panelDrafts = new Map();
  let panelContext = '';

  function disclosure(key, label, ...content) {
    return h('details', {
      class: 'rep-disclosure', 'data-disclosure': key, open: disclosureState.get(key) ?? false,
      ontoggle: event => {
        if (event.target.isConnected) disclosureState.set(key, event.target.open);
      },
    }, h('summary', { text: label }), h('div', { class: 'rep-disclosure-content' }, content));
  }
  function identifyControls(scope) {
    const counts = new Map();
    for (const control of scope.querySelectorAll('input, textarea, select, button, summary')) {
      const owner = control.closest('[data-marker], [data-item]')?.dataset;
      const label = control.dataset.draft || control.dataset.focus || control.getAttribute('aria-label')
        || control.closest('label')?.querySelector('span')?.textContent
        || control.closest('label')?.textContent || control.textContent || control.type;
      const base = `${owner?.marker || owner?.item || ''}:${control.tagName}:${label}`;
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      control.dataset.uiKey = `${base}:${count}`;
    }
  }

  function captureUI(scope, context) {
    const drafts = panelDrafts.get(context) ?? new Map();
    panelDrafts.set(context, drafts);
    for (const details of scope.querySelectorAll('[data-disclosure]')) {
      disclosureState.set(details.dataset.disclosure, details.open);
    }
    for (const control of scope.querySelectorAll('input, textarea, select')) {
      if (control.dataset.draft || control.dataset.uiDirty) {
        drafts.set(control.dataset.uiKey, { value: control.value, checked: control.checked, dirty: Boolean(control.dataset.uiDirty) });
      } else {
        drafts.delete(control.dataset.uiKey);
      }
    }
    const active = document.activeElement;
    return scope.contains(active) ? {
      key: active.dataset.uiKey,
      start: active.selectionStart,
      end: active.selectionEnd,
      direction: active.selectionDirection,
    } : null;
  }

  function restoreUI(scope, context, focus) {
    identifyControls(scope);
    const drafts = panelDrafts.get(context);
    for (const control of scope.querySelectorAll('input, textarea, select')) {
      const draft = drafts?.get(control.dataset.uiKey);
      if (!draft) continue;
      if (control.tagName !== 'SELECT' || [...control.options].some(option => option.value === draft.value)) control.value = draft.value;
      if (control.type === 'checkbox' || control.type === 'radio') control.checked = draft.checked;
      if (draft.dirty) control.dataset.uiDirty = 'true';
    }
    if (!focus) return;
    let active = [...scope.querySelectorAll('[data-ui-key]')].find(control => control.dataset.uiKey === focus.key);
    if (!active || active.disabled) active = scope.tabIndex >= 0 ? scope : scope.querySelector('button:not(:disabled), summary');
    if (!active) return;
    active.focus({ preventScroll: true });
    if (focus.start !== null && focus.start !== undefined && typeof active.setSelectionRange === 'function') {
      try { active.setSelectionRange(focus.start, focus.end, focus.direction); } catch { /* Campos numéricos não têm seleção de texto. */ }
    }
  }

  function compactSections(content) {
    return domChildren([content]).map(node => {
      if (!(node instanceof HTMLElement) || !node.matches('.rep-subsection') || node.matches('.rep-package')) return node;
      const heading = node.querySelector('h4');
      if (!heading) return node;
      const label = heading.textContent;
      heading.remove();
      const details = disclosure(`tool:${state.tab}:${label}`, label, ...node.childNodes);
      return details;
    });
  }

  function track(promise) {
    pendingWork++;
    return Promise.resolve(promise).finally(() => { pendingWork--; });
  }

  // ---------- Estrutura ----------
  const storageLine = h('p', { class: 'rep-storage' });
  const persistButton = h('button', { type: 'button', hidden: true, onclick: requestPersistence, text: 'Pedir armazenamento persistente' });
  const statusLine = h('p', { class: 'rep-status', role: 'status', 'aria-live': 'polite' });
  const jobLabel = h('span', { class: 'rep-job-label' });
  const jobProgress = h('progress', { max: 1, value: 0, 'aria-label': 'Progresso do processamento local' });
  const jobBox = h('div', { class: 'rep-job', hidden: true },
    jobLabel, jobProgress, h('button', { type: 'button', onclick: cancelJob, text: 'Cancelar processamento' }));

  const audioInput = h('input', { type: 'file', accept: AUDIO_ACCEPT, multiple: true, class: 'rep-hidden-input', tabindex: '-1', 'aria-hidden': 'true',
    onchange: event => { track(importAudioFiles([...event.target.files])); event.target.value = ''; } });
  const packageInput = h('input', { type: 'file', accept: '.json,application/json', class: 'rep-hidden-input', tabindex: '-1', 'aria-hidden': 'true',
    onchange: event => { const [file] = event.target.files; event.target.value = ''; if (file) importPackageFile(file); } });
  const midiInput = h('input', { type: 'file', accept: '.mid,.midi,audio/midi,audio/x-midi', class: 'rep-hidden-input', tabindex: '-1', 'aria-hidden': 'true',
    onchange: event => { const [file] = event.target.files; event.target.value = ''; if (file) readMidiFile(file); } });
  const relinkInput = h('input', { type: 'file', accept: AUDIO_ACCEPT, class: 'rep-hidden-input', tabindex: '-1', 'aria-hidden': 'true',
    onchange: event => { const [file] = event.target.files; event.target.value = ''; const id = relinkInput.dataset.item; if (file && id) track(relinkMedia(id, file)); } });
  const libraryList = h('div', { class: 'rep-library-list' });
  const corruptBox = h('div', { class: 'rep-corrupt', hidden: true });
  const library = h('aside', { class: 'rep-library', hidden: true, 'aria-label': 'Biblioteca do repertório' },
    h('h3', { text: 'Biblioteca' }),
    h('div', { class: 'rep-import' },
      h('button', { type: 'button', class: 'primary', onclick: () => audioInput.click(), text: 'Importar áudio…' }),
      h('button', { type: 'button', onclick: () => packageInput.click(), text: 'Abrir pacote…' })),
    disclosure('import-help', 'Formatos e limites',
      h('p', { class: 'rep-hint', text: `WAV, MP3, OGG, FLAC e M4A/AAC, conforme o navegador. Até ${formatBytes(MAX_IMPORT_BYTES)} e ${MAX_DURATION_SECONDS / 60} min por arquivo. Você também pode arrastar arquivos para cá.` })),
    libraryList, corruptBox, audioInput, packageInput, midiInput, relinkInput);

  const titleInput = h('input', { type: 'text', class: 'rep-title-input', maxLength: 200, 'aria-label': 'Nome do item selecionado', onchange: event => renameItem(event.target.value) });
  const metaLine = h('p', { class: 'rep-meta' });
  const extraBox = h('div', { class: 'rep-extra' });
  const canvas = h('canvas', { class: 'rep-wave', tabindex: '0', role: 'slider', 'aria-label': 'Forma de onda: cursor de reprodução', 'aria-valuemin': '0', 'aria-valuemax': '0', 'aria-valuenow': '0',
    'aria-describedby': uid('wave-keys') });
  const zoomInput = h('input', { type: 'range', min: 1, max: 64, step: 1, value: 1, oninput: event => setZoom(Number(event.target.value)) });
  const scrollInput = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: 0, oninput: event => scrollTo(Number(event.target.value) / 1000) });
  const positionText = h('output', { class: 'rep-position', 'aria-live': 'off' });
  const playButton = h('button', { type: 'button', class: 'primary', onclick: togglePlay, text: 'Tocar' });
  const stopButton = h('button', { type: 'button', onclick: () => { stop(); rewind(); }, text: 'Parar' });
  const loopInput = h('input', { type: 'checkbox', onchange: event => { updateItem({ loop: event.target.checked }); restartIfPlaying(); } });
  const aInput = h('input', { type: 'text', inputMode: 'decimal', class: 'rep-time', 'aria-label': 'Início do trecho (A)', placeholder: '0:00.0', onchange: () => commitRegionInputs() });
  const bInput = h('input', { type: 'text', inputMode: 'decimal', class: 'rep-time', 'aria-label': 'Fim do trecho (B)', placeholder: '0:00.0', onchange: () => commitRegionInputs() });
  const regionText = h('span', { class: 'rep-hint' });
  const speedRange = h('input', { type: 'range', min: SPEED_MIN * 100, max: SPEED_MAX * 100, step: 1, value: 100, 'aria-label': 'Velocidade (%)',
    oninput: event => { speedNumber.value = event.target.value; }, onchange: event => setProcessing({ speed: Number(event.target.value) / 100 }) });
  const speedNumber = h('input', { type: 'number', min: SPEED_MIN * 100, max: SPEED_MAX * 100, step: 1, value: 100, 'aria-label': 'Velocidade em porcentagem',
    onchange: event => setProcessing({ speed: Number(event.target.value) / 100 }) });
  const semitoneInput = h('input', { type: 'number', min: -SEMITONE_LIMIT, max: SEMITONE_LIMIT, step: 1, value: 0, onchange: event => setProcessing({ semitones: Number(event.target.value) }) });
  const centsInput = h('input', { type: 'number', min: -CENTS_LIMIT, max: CENTS_LIMIT, step: 1, value: 0, onchange: event => setProcessing({ cents: Number(event.target.value) }) });
  const algorithmSelect = h('select', { onchange: event => setProcessing({ algorithm: event.target.value }) },
    h('option', { value: 'vocoder' }, 'Vocoder de fase (mixagens, polifonia)'),
    h('option', { value: 'wsola' }, 'WSOLA (voz, percussão, solo)'));
  const tabButtons = TABS.map(([id, label]) => h('button', { type: 'button', role: 'tab', id: uid(`tab-${id}`), 'aria-controls': uid('panel'), onclick: () => setTab(id) }, label));
  const tabPanel = h('div', { role: 'tabpanel', id: uid('panel'), class: 'rep-panel', tabindex: '0' });

  const itemDetails = disclosure('item-details', 'Sobre este item', extraBox);
  const itemWorkspace = h('div', { class: 'rep-item-workspace', hidden: true },
    h('div', { class: 'rep-lab-head' }, titleInput, metaLine, itemDetails),
    h('div', { class: 'rep-wave-shell' }, canvas),
    h('div', { class: 'rep-row rep-transport' },
      playButton, stopButton,
      h('button', { type: 'button', onclick: () => seek(current()?.region?.start ?? 0), text: 'Voltar ao A' }),
      h('label', { class: 'toggle' }, loopInput, 'Repetir trecho'), positionText),
    h('div', { class: 'rep-row rep-region' },
      field('A', aInput), h('button', { type: 'button', onclick: () => setRegionEdge('start'), text: 'A = cursor' }),
      field('B', bInput), h('button', { type: 'button', onclick: () => setRegionEdge('end'), text: 'B = cursor' }),
      h('button', { type: 'button', onclick: () => setRegion(null), text: 'Limpar trecho' }), regionText),
    disclosure('processing', 'Velocidade e transposição',
      h('fieldset', { class: 'rep-processing' },
        h('legend', { text: 'Velocidade e altura independentes' }),
        h('div', { class: 'rep-row' },
          field('Velocidade', h('span', { class: 'rep-inline' }, speedRange, speedNumber, '%')),
          field('Transposição (semitons)', semitoneInput),
          field('Ajuste fino (cents)', centsInput),
          field('Algoritmo', algorithmSelect),
          h('button', { type: 'button', onclick: () => setProcessing({ ...DEFAULT_PROCESSING, algorithm: current()?.processing.algorithm ?? 'vocoder' }), text: 'Original' })),
        h('p', { class: 'rep-hint', text: 'Processamento local antes de tocar. Velocidade e altura não alteram uma à outra; trechos curtos processam mais rápido.' }))),
    disclosure('wave-view', 'Visualização e atalhos',
      h('div', { class: 'rep-row rep-view-controls' }, field('Zoom', zoomInput), field('Rolagem', scrollInput)),
      h('div', { class: 'rep-row' }, [['grid', 'Grade'], ['beats', 'Pulsos'], ['onsets', 'Ataques'], ['chords', 'Acordes'], ['notes', 'Notas']].map(([key, label]) =>
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', 'data-show': key, checked: state.show[key],
          onchange: event => { state.show[key] = event.target.checked; savePrefs(); draw(); } }), label))),
      h('p', { class: 'rep-hint', id: uid('wave-keys'), text: 'Clique para mover o cursor; arraste para selecionar A–B. Com a onda em foco: ←/→ movem 1 s (Shift: 0,1 s), PageUp/PageDown 10 s, Espaço toca/pausa, A/B marcam o trecho, M comenta, S cria seção, +/− ajustam zoom e X alterna A/B.' }),
      h('p', { class: 'rep-legend' },
        h('span', { class: 'lg-region', text: 'trecho A–B' }), h('span', { class: 'lg-grid', text: 'grade' }),
        h('span', { class: 'lg-beats', text: 'pulsos' }), h('span', { class: 'lg-onsets', text: 'ataques' }),
        h('span', { class: 'lg-comment', text: 'comentários' }), h('span', { class: 'lg-chords', text: 'acordes e notas estimados' }))));
  const emptyWorkspace = h('div', { class: 'rep-empty' },
    h('h3', { text: 'Escolha uma música para praticar' }),
    h('p', { class: 'rep-hint', text: 'Importe um áudio ou abra um pacote. Depois, ouça e escolha um trecho para repetir.' }),
    h('div', { class: 'rep-row' },
      h('button', { type: 'button', class: 'primary', onclick: () => audioInput.click(), text: 'Importar áudio…' }),
      h('button', { type: 'button', onclick: () => packageInput.click(), text: 'Abrir pacote…' })),
    h('p', { class: 'rep-hint', text: 'Sem áudio? Takes, setlists, MIDI e pacotes continuam disponíveis nas ferramentas abaixo.' }),
    disclosure('empty-import-help', 'Formatos e limites',
      h('p', { class: 'rep-hint', text: `WAV, MP3, OGG, FLAC e M4A/AAC, conforme o navegador. Até ${formatBytes(MAX_IMPORT_BYTES)} e ${MAX_DURATION_SECONDS / 60} min por arquivo. Você também pode arrastar arquivos para cá.` })));
  const lab = h('div', { class: 'rep-lab' }, emptyWorkspace, itemWorkspace,
    h('div', { role: 'tablist', class: 'rep-tabs', 'aria-label': 'Ferramentas do repertório', onkeydown: tabKeys }, tabButtons),
    tabPanel);
  const storageDisclosure = disclosure('storage', 'Armazenamento local', storageLine, persistButton);
  storageDisclosure.classList.add('rep-storage-box');
  const root = h('section', { class: 'rep', 'aria-labelledby': uid('title') },
    h('div', { class: 'rep-header' },
      h('div', {}, h('p', { class: 'eyebrow', text: 'REPERTÓRIO LOCAL' }), h('h2', { id: uid('title'), text: 'Pratique com uma música' })),
      storageDisclosure),
    statusLine, jobBox,
    h('div', { class: 'rep-layout' }, library, lab));
  container.replaceChildren(root);
  tabPanel.addEventListener('input', event => {
    if (event.target.matches('input, textarea, select')) event.target.dataset.uiDirty = 'true';
  }, true);
  tabPanel.addEventListener('change', event => {
    if (!event.target.dataset.draft) delete event.target.dataset.uiDirty;
  }, true);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', () => { drag = null; state.selection = null; draw(); });
  canvas.addEventListener('keydown', onCanvasKey);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); root.classList.add('rep-dropping'); } });
  root.addEventListener('dragleave', event => { if (!root.contains(event.relatedTarget)) root.classList.remove('rep-dropping'); });
  root.addEventListener('drop', onDrop);
  root.addEventListener('keydown', event => {
    if (event.key.toLowerCase() === 'x' && player.mode === 'ab' && !isTyping(event.target)) { event.preventDefault(); switchAB(state.ab.active === 'a' ? 'b' : 'a'); }
  });
  const resizeObserver = globalThis.ResizeObserver ? new ResizeObserver(() => draw()) : null;
  resizeObserver?.observe(canvas);

  const storeReady = init();

  // ---------- Utilidades de estado ----------
  function current() {
    return state.items.find(item => item.id === state.selectedId) ?? null;
  }

  function isTyping(target) {
    return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  }

  function setStatus(text, error = false) {
    statusLine.textContent = text;
    statusLine.classList.toggle('error', error);
  }

  function savePrefs() {
    try {
      globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify({ selectedId: state.selectedId, tab: state.tab, show: state.show, ab: { a: state.ab.a, b: state.ab.b }, setlistId: state.setlistId }));
    } catch { /* preferências são opcionais */ }
  }

  function showJob(label, fraction) {
    jobBox.hidden = false;
    jobLabel.textContent = label;
    jobProgress.value = Number.isFinite(fraction) ? clamp(fraction, 0, 1) : 0;
    jobProgress.setAttribute('aria-valuetext', `${label}: ${pct(jobProgress.value)}`);
    refreshBusy();
  }

  function hideJob() {
    jobBox.hidden = true;
    refreshBusy();
  }

  // Botões de tarefa pesada ficam inativos durante um processamento; o estado
  // inicial (ex.: sem trecho) é lembrado para não ser reativado ao terminar.
  function refreshBusy() {
    for (const button of root.querySelectorAll('[data-job]')) {
      if (button.dataset.blocked === undefined) button.dataset.blocked = String(button.disabled);
      button.disabled = jobs.busy || button.dataset.blocked === 'true';
    }
  }

  function cancelJob() {
    if (jobs.cancel()) setStatus('Processamento cancelado. Nada foi salvo dessa tarefa.');
    hideJob();
  }

  async function runJob(type, payload, { transfer = [], label }) {
    showJob(label, 0);
    try {
      return await jobs.run(type, payload, { transfer, label, onProgress: (stage, fraction) => showJob(`${label} — ${stage}`, fraction) });
    } finally {
      hideJob();
    }
  }

  function reportError(error) {
    if (error instanceof JobCancelledError) return;
    setStatus(error?.message || String(error), true);
  }

  async function validated(session) {
    let module;
    try {
      module = await import('./session.js');
    } catch {
      throw new Error('O módulo de sessão do estúdio não está disponível para validar a importação.');
    }
    return module.validateSession(session);
  }

  // A validação canônica é definitiva; aumentar a frase não corrige
  // compasso, progressão ou notas inválidas.
  async function applySessionPatch(patch, warnings = []) {
    const base = host.getSession();
    const session = { ...base, ...patch, name: String(patch.name ?? base.name).slice(0, 80),
      loop: { ...(base.loop ?? {}), startBar: 0, endBar: patch.bars } };
    const result = await validated(session);
    if (!result.ok) throw new Error(`A sessão resultante foi recusada: ${result.error}`);
    host.replaceSession(result.session);
    const message = `Sessão do estúdio atualizada (${result.session.notes.length} notas, ${result.session.bars} compasso(s), ${result.session.bpm} BPM).${warnings.length ? ` Avisos: ${warnings.join(' ')}` : ''}`;
    setStatus(message);
    host.notify(message);
  }

  // ---------- Persistência ----------
  async function init() {
    setStatus('Abrindo a biblioteca local…');
    store = await openRepertoireStore();
    if (destroyed) return;
    try {
      const loaded = await store.loadAll();
      state.items = loaded.items;
      state.exercises = loaded.exercises;
      state.setlists = loaded.setlists.map(setlist => pruneSetlist(setlist, state));
      state.corrupt = loaded.corrupt;
      setStatus(loaded.corrupt.length
        ? `${loaded.corrupt.length} registro(s) danificado(s) não puderam ser lidos; veja a biblioteca.`
        : state.items.length ? `${state.items.length} item(ns) na biblioteca.` : 'Biblioteca vazia: importe um áudio para começar.', loaded.corrupt.length > 0);
    } catch (error) {
      setStatus(describeStorageError(error).message, true);
    }
    state.loading = false;
    if (!state.items.some(item => item.id === state.selectedId)) state.selectedId = state.items.find(item => item.kind === 'reference')?.id ?? state.items[0]?.id ?? null;
    if (!state.setlists.some(setlist => setlist.id === state.setlistId)) state.setlistId = state.setlists[0]?.id ?? null;
    await refreshStorage();
    if (state.selectedId) selectItem(state.selectedId, { force: true });
    else renderAll();
  }

  async function refreshStorage() {
    if (!store) return;
    const info = await store.estimate();
    if (destroyed) return;
    state.storageInfo = info;
    if (!store.persistent) {
      storageDisclosure.querySelector('summary').textContent = 'Armazenamento indisponível';
      storageLine.textContent = store.error?.message ?? 'Armazenamento local indisponível.';
      storageLine.classList.add('error');
      persistButton.hidden = true;
      return;
    }
    storageLine.classList.remove('error');
    storageDisclosure.querySelector('summary').textContent = 'Armazenamento local';
    storageLine.textContent = info
      ? `Armazenamento local: ${formatBytes(info.usage)} de ${formatBytes(info.quota)}${info.persisted ? ' · persistente' : ' · pode ser limpo pelo navegador se faltar espaço'}`
      : 'Armazenamento local ativo (estimativa de uso indisponível).';
    persistButton.hidden = !info || info.persisted || !globalThis.navigator?.storage?.persist;
  }

  async function requestPersistence() {
    const granted = await store?.requestPersistence();
    setStatus(granted ? 'O navegador concedeu armazenamento persistente para o repertório.' : 'O navegador recusou o armazenamento persistente; os dados ainda ficam salvos, mas podem ser limpos se faltar espaço.', !granted);
    refreshStorage();
  }

  function replaceItem(item) {
    const index = state.items.findIndex(entry => entry.id === item.id);
    if (index >= 0) state.items[index] = item;
    else state.items.push(item);
  }

  function saveItem(item, options) {
    return track(writeItem(item, options));
  }

  async function writeItem(item, { media } = {}) {
    replaceItem(item);
    if (!store) await storeReady;
    if (media && item.media) pendingMedia.set(item.media.id, media);
    try {
      if (media && item.media) await store.putMedia(item.media.id, media);
      await store.putItem(item);
      if (item.media) pendingMedia.delete(item.media.id);
      state.unsaved.delete(item.id);
    } catch (error) {
      const problem = describeStorageError(error);
      state.unsaved.set(item.id, problem.message);
      setStatus(`“${item.name}” não foi salvo: ${problem.message}`, true);
      refreshStorage();
    }
    renderLibrary();
  }

  async function saveExercise(exercise) {
    if (!store) await storeReady;
    const index = state.exercises.findIndex(entry => entry.id === exercise.id);
    if (index >= 0) state.exercises[index] = exercise;
    else state.exercises.push(exercise);
    try {
      await store.putExercise(exercise);
    } catch (error) {
      setStatus(`Exercício não salvo: ${describeStorageError(error).message}`, true);
    }
  }

  async function saveSetlist(setlist) {
    if (!store) await storeReady;
    const index = state.setlists.findIndex(entry => entry.id === setlist.id);
    if (index >= 0) state.setlists[index] = setlist;
    else state.setlists.push(setlist);
    try {
      await store.putSetlist(setlist);
    } catch (error) {
      setStatus(`Setlist não salva: ${describeStorageError(error).message}`, true);
    }
  }

  async function saveAnalysis(id, analysis) {
    analyses.set(id, analysis);
    try {
      if (!store) await storeReady;
      await store.putAnalysis(id, analysis);
    } catch (error) {
      setStatus(`A análise ficou só nesta sessão: ${describeStorageError(error).message}`, true);
    }
  }

  function updateItem(patch) {
    const item = current();
    if (!item) return null;
    const next = normalizeItem({ ...item, ...patch });
    saveItem(next);
    refreshLab();
    if (Object.hasOwn(patch, 'region') || Object.hasOwn(patch, 'processing')) refreshDerivedTabs();
    draw();
    return next;
  }

  function cacheBuffer(id, buffer) {
    buffers.delete(id);
    buffers.set(id, buffer);
    while (buffers.size > BUFFER_CACHE_ITEMS) {
      const oldest = buffers.keys().next().value;
      if (oldest === state.selectedId) { buffers.delete(oldest); buffers.set(oldest, buffer); break; }
      buffers.delete(oldest);
    }
  }

  async function decodeBlob(blob, name = '') {
    const bytes = await blob.arrayBuffer();
    try {
      return await player.decode(bytes.slice(0));
    } catch {
      try {
        const { sampleRate, channels } = decodeWav(bytes);
        return player.createBuffer(channels, sampleRate);
      } catch {
        throw new Error(`O navegador não conseguiu decodificar ${name || 'o arquivo'}. Os formatos aceitos dependem do navegador; tente WAV, MP3, OGG ou FLAC.`);
      }
    }
  }

  async function loadBuffer(item) {
    if (buffers.has(item.id)) {
      const buffer = buffers.get(item.id);
      cacheBuffer(item.id, buffer);
      return buffer;
    }
    if (!item.media) {
      state.missingMedia.add(item.id);
      throw new Error(item.renderError
        ? `Este take não tem áudio: ${item.renderError}`
        : 'Este item não tem mídia local. Use “Vincular arquivo…” para conectar o arquivo de áudio original.');
    }
    if (!store) await storeReady;
    const blob = pendingMedia.get(item.media.id) ?? await store.getMedia(item.media.id);
    if (!blob) {
      state.missingMedia.add(item.id);
      renderLibrary();
      throw new Error('A mídia deste item não está no armazenamento local (pode ter sido limpa pelo navegador). Use “Vincular arquivo…” para reconectar o arquivo original.');
    }
    const buffer = await decodeBlob(blob, item.media.fileName || item.name);
    state.missingMedia.delete(item.id);
    cacheBuffer(item.id, buffer);
    return buffer;
  }

  async function loadAnalysis(item) {
    if (analyses.has(item.id)) return analyses.get(item.id);
    let analysis = null;
    try {
      if (!store) await storeReady;
      analysis = await store.getAnalysis(item.id);
    } catch (error) {
      setStatus(`Não foi possível ler a análise salva: ${describeStorageError(error).message}`, true);
    }
    analyses.set(item.id, analysis);
    return analysis;
  }

  // ---------- Biblioteca ----------
  async function importAudioFiles(files) {
    for (const file of files) {
      if (destroyed) return;
      if (/\.(mid|midi)$/i.test(file.name)) { readMidiFile(file); continue; }
      if (/\.json$/i.test(file.name)) { importPackageFile(file); continue; }
      try {
        if (file.size > MAX_IMPORT_BYTES) throw new RangeError(`“${file.name}” tem ${formatBytes(file.size)}; o limite é ${formatBytes(MAX_IMPORT_BYTES)}.`);
        setStatus(`Decodificando “${file.name}”…`);
        const buffer = await decodeBlob(file, file.name);
        if (buffer.duration > MAX_DURATION_SECONDS) throw new RangeError(`“${file.name}” dura ${formatTime(buffer.duration, { precise: false })}; o limite é ${MAX_DURATION_SECONDS / 60} min para manter a memória sob controle.`);
        const item = createItem({
          kind: 'reference', source: 'import', name: file.name.replace(/\.[^.]+$/, ''),
          duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
          media: { id: createId('md'), mimeType: file.type, size: file.size, fileName: file.name },
        });
        cacheBuffer(item.id, buffer);
        await saveItem(item, { media: file });
        setStatus(`“${item.name}” importado (${formatTime(item.duration)}, ${buffer.numberOfChannels === 1 ? 'mono' : `${buffer.numberOfChannels} canais`}).`);
        await selectItem(item.id, { force: true });
      } catch (error) {
        reportError(error);
      }
      refreshStorage();
    }
  }

  async function selectItem(id, { force = false } = {}) {
    if (!force && id === state.selectedId) return;
    if (id !== state.selectedId && player.playing && state.playingItemId !== null) stop();
    state.selectedId = id;
    state.ab.result = null;
    savePrefs();
    const item = current();
    state.cursor = item?.region?.start ?? 0;
    state.zoom = 1;
    state.view = { start: 0, end: item?.duration ?? 1 };
    renderAll();
    if (!item) return;
    const metadataOnly = item.source === 'attempt' && !item.media;
    const results = await Promise.allSettled([metadataOnly ? Promise.resolve(null) : loadBuffer(item), loadAnalysis(item)]);
    if (state.selectedId !== id || destroyed) return;
    if (results[0].status === 'rejected') reportError(results[0].reason);
    renderAll();
  }

  function renameItem(value) {
    const name = value.trim();
    if (!name) { refreshLab(); return; }
    updateItem({ name });
    renderLibrary();
  }

  function armDelete(item) {
    if (state.deleteArm === item.id) {
      state.deleteArm = null;
      clearTimeout(deleteTimer);
      deleteItem(item);
      return;
    }
    state.deleteArm = item.id;
    clearTimeout(deleteTimer);
    deleteTimer = setTimeout(() => { state.deleteArm = null; renderLibrary(); }, 5000);
    renderLibrary();
  }

  async function deleteItem(item) {
    if (state.playingItemId === item.id || state.selectedId === item.id) stop();
    try {
      await store.deleteItem(item);
    } catch (error) {
      setStatus(`Não foi possível excluir: ${describeStorageError(error).message}`, true);
      return;
    }
    state.items = state.items.filter(entry => entry.id !== item.id);
    buffers.delete(item.id);
    analyses.delete(item.id);
    state.unsaved.delete(item.id);
    state.missingMedia.delete(item.id);
    for (const key of [...processedCache.keys()]) if (key.startsWith(`${item.id}|`)) processedCache.delete(key);
    const orphaned = state.exercises.filter(exercise => exercise.itemId === item.id);
    for (const exercise of orphaned) await store.deleteExercise(exercise.id).catch(() => {});
    state.exercises = state.exercises.filter(exercise => exercise.itemId !== item.id);
    for (const setlist of state.setlists) {
      const pruned = pruneSetlist(setlist, state);
      if (pruned !== setlist) await saveSetlist(pruned);
    }
    if (state.ab.a === item.id) state.ab.a = null;
    if (state.ab.b === item.id) state.ab.b = null;
    setStatus(`“${item.name}” excluído${orphaned.length ? ` com ${orphaned.length} exercício(s)` : ''}.`);
    if (state.selectedId === item.id) {
      state.selectedId = null;
      await selectItem(state.items[0]?.id ?? null, { force: true });
    } else renderAll();
    refreshStorage();
  }

  async function relinkMedia(id, file) {
    const item = state.items.find(entry => entry.id === id);
    if (!item) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new RangeError(`O arquivo excede ${formatBytes(MAX_IMPORT_BYTES)}.`);
      setStatus(`Decodificando “${file.name}”…`);
      const buffer = await decodeBlob(file, file.name);
      const drift = Math.abs(buffer.duration - item.duration) / item.duration;
      const next = normalizeItem({
        ...item, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, renderError: undefined,
        media: { id: createId('md'), mimeType: file.type, size: file.size, fileName: file.name },
      });
      cacheBuffer(id, buffer);
      state.missingMedia.delete(id);
      await saveItem(next, { media: file });
      setStatus(drift > 0.02
        ? `Arquivo vinculado, mas a duração difere ${pct(drift)} da original: confira marcadores e trechos.`
        : `Arquivo “${file.name}” vinculado a “${item.name}”.`, drift > 0.02);
      if (state.selectedId === id) renderAll();
    } catch (error) {
      reportError(error);
    }
  }

  function renderLibrary() {
    const focus = captureUI(libraryList, 'library');
    const groups = [['reference', 'Referências'], ['take', 'Takes'], ['derived', 'Derivados']];
    const populated = groups.filter(([kind]) => state.items.some(item => item.kind === kind));
    libraryList.replaceChildren(...populated.map(([kind, title]) => {
      const items = state.items.filter(item => item.kind === kind);
      return h('section', { class: 'rep-group' },
        h('h4', { text: `${title} (${items.length})` }),
        h('ul', { class: 'rep-items' }, items.map(itemRow)));
    }));
    if (state.loading) libraryList.append(h('p', { class: 'rep-hint', text: 'Carregando…' }));
    restoreUI(libraryList, 'library', focus);
    renderCorrupt();
    refreshBusy();
  }

  function itemRow(item) {
    const selected = item.id === state.selectedId;
    const unsaved = state.unsaved.get(item.id);
    const missing = state.missingMedia.has(item.id) || (!item.media && !item.attempts);
    const silentTake = !item.media && item.attempts;
    const armed = state.deleteArm === item.id;
    const exercises = state.exercises.filter(exercise => exercise.itemId === item.id).length;
    return h('li', { class: `rep-item${selected ? ' selected' : ''}`, 'data-item': item.id },
      h('button', { type: 'button', class: 'rep-item-select', 'data-focus': 'select', 'aria-current': selected ? 'true' : null, onclick: () => selectItem(item.id) },
        h('strong', { text: item.name }), h('span', { text: itemLabel(item) })),
      h('div', { class: 'rep-item-actions' },
        unsaved ? h('span', { class: 'rep-badge error', title: unsaved, text: 'não salvo' }) : null,
        unsaved ? h('button', { type: 'button', onclick: () => saveItem(item, { media: item.media ? pendingMedia.get(item.media.id) : undefined }), text: 'Tentar salvar' }) : null,
        missing ? h('span', { class: 'rep-badge warn', text: 'mídia ausente' }) : null,
        missing ? h('button', { type: 'button', onclick: () => { relinkInput.dataset.item = item.id; relinkInput.click(); }, text: 'Vincular arquivo…' }) : null,
        silentTake ? h('span', { class: 'rep-badge warn', title: item.renderError ?? '', text: 'sem áudio' }) : null,
        silentTake ? h('button', { type: 'button', 'data-job': 'true', onclick: () => track(rerenderTake(item)), text: 'Renderizar de novo' }) : null,
        disclosure(`item-actions:${item.id}`, 'Gerenciar',
          h('button', { type: 'button', class: armed ? 'danger' : '', 'data-focus': 'delete', onclick: () => armDelete(item),
            'aria-label': armed ? `Confirmar exclusão de ${item.name}` : `Excluir ${item.name}`,
            text: armed ? `Confirmar exclusão${exercises ? ` (+${exercises} exercício(s))` : ''}` : 'Excluir' }))));
  }

  function renderCorrupt() {
    const focus = captureUI(corruptBox, 'corrupt');
    library.hidden = !state.items.length && !state.corrupt.length;
    root.classList.toggle('rep-empty-library', library.hidden);
    corruptBox.hidden = state.corrupt.length === 0;
    if (!state.corrupt.length) { corruptBox.replaceChildren(); return; }
    corruptBox.replaceChildren(
      h('h4', { text: 'Registros danificados' }),
      h('p', { class: 'rep-hint', text: 'Estes registros não puderam ser lidos e não foram apagados. Baixe uma cópia bruta para recuperação manual ou remova-os.' }),
      h('ul', {}, state.corrupt.map((record, index) => h('li', { 'data-item': `${record.store}:${record.id ?? index}` },
        h('span', { text: `${record.store}: ${record.id ?? 'sem identificador'}` }),
        h('button', { type: 'button', onclick: () => {
          const text = JSON.stringify(record.raw, (key, value) => (value instanceof Blob ? `[Blob ${value.size} bytes]` : value), 2);
          download(new Blob([text ?? 'null'], { type: 'application/json' }), `registro-danificado-${index + 1}.json`);
        }, text: 'Baixar cópia bruta' }),
        h('button', { type: 'button', onclick: async () => {
          try {
            if (record.id !== null) await store.deleteCorrupt(record.store, record.id);
            state.corrupt.splice(state.corrupt.indexOf(record), 1);
            renderCorrupt();
          } catch (error) {
            setStatus(describeStorageError(error).message, true);
          }
        }, text: 'Remover' })))));
    restoreUI(corruptBox, 'corrupt', focus);
  }

  // ---------- Laboratório ----------
  function renderAll() {
    renderLibrary();
    refreshLab();
    renderTabs();
    draw();
  }

  function setValue(input, value) {
    if (document.activeElement !== input) input.value = value;
  }

  function refreshLab() {
    const item = current();
    itemWorkspace.hidden = !item;
    emptyWorkspace.hidden = Boolean(item);
    for (const control of itemWorkspace.querySelectorAll('[data-show]')) control.checked = state.show[control.dataset.show];
    for (const control of [titleInput, playButton, stopButton, loopInput, aInput, bInput, speedRange, speedNumber, semitoneInput, centsInput, algorithmSelect, zoomInput, scrollInput]) {
      control.disabled = !item;
    }
    if (!item) {
      titleInput.value = '';
      metaLine.textContent = state.loading ? 'Carregando biblioteca…' : 'Nenhum item selecionado.';
      extraBox.replaceChildren();
      regionText.textContent = '';
      positionText.textContent = '';
      return;
    }
    setValue(titleInput, item.name);
    playButton.disabled = !item.media;
    const details = [item.source === 'attempt' && !item.media ? 'Tentativa de teclado/toque (sem áudio)' : ITEM_SOURCES[item.source], formatTime(item.duration)];
    metaLine.textContent = details.join(' · ') + (isIdentityProcessing(item.processing) ? '' : ` · ${processingText(item.processing)}`);
    const technical = [];
    if (item.sampleRate) technical.push(`${(item.sampleRate / 1000).toLocaleString('pt-BR')} kHz`);
    if (item.channels) technical.push(item.channels === 1 ? 'mono' : `${item.channels} canais`);
    if (item.media?.size) technical.push(formatBytes(item.media.size));
    const extras = technical.length ? [h('p', { class: 'rep-hint', text: technical.join(' · ') })] : [];
    if (item.source === 'attempt') {
      extras.push(h('p', { class: 'rep-hint', text: `Tentativa real de teclado/toque: ${item.attempts?.length ?? 0} ataque(s) registrados no estúdio${item.session ? `, sessão a ${item.session.bpm} BPM` : ''}. ${item.media ? 'O áudio é um render do arranjo com as tentativas, não uma gravação de microfone.' : 'Somente metadados: nenhum áudio foi renderizado.'}` }));
    }
    if (item.session) {
      extras.push(h('button', { type: 'button', onclick: async () => {
        try {
          const result = await validated(item.session);
          if (!result.ok) throw new Error(`A sessão deste take é inválida: ${result.error}`);
          host.replaceSession(result.session);
          setStatus('Sessão deste take carregada no estúdio.');
        } catch (error) {
          reportError(error);
        }
      }, text: 'Carregar a sessão deste take no estúdio' }));
    }
    if (item.parentId) {
      const parent = state.items.find(entry => entry.id === item.parentId);
      if (parent) extras.push(h('p', { class: 'rep-hint', text: `Derivado de “${parent.name}”.` }));
    }
    const extraFocus = captureUI(extraBox, 'item-details');
    extraBox.replaceChildren(...domChildren(extras));
    restoreUI(extraBox, 'item-details', extraFocus);
    itemDetails.hidden = extras.length === 0;
    loopInput.checked = item.loop;
    setValue(aInput, item.region ? formatTime(item.region.start) : '');
    setValue(bInput, item.region ? formatTime(item.region.end) : '');
    regionText.textContent = item.region ? `Trecho de ${formatTime(item.region.end - item.region.start)}` : 'Sem trecho: toca o item inteiro.';
    setValue(speedRange, Math.round(item.processing.speed * 100));
    setValue(speedNumber, Math.round(item.processing.speed * 100));
    setValue(semitoneInput, item.processing.semitones);
    setValue(centsInput, item.processing.cents);
    setValue(algorithmSelect, item.processing.algorithm);
    setValue(zoomInput, state.zoom);
    refreshTransport();
  }

  function refreshTransport() {
    const playingSingle = player.playing && player.mode === 'single' && state.playingItemId === state.selectedId && !state.setlistPlay;
    playButton.textContent = playingSingle ? 'Pausar' : 'Tocar';
    playButton.setAttribute('aria-pressed', String(playingSingle));
    updatePositionText(player.position());
  }

  function updatePositionText(position) {
    const item = current();
    if (!item) return;
    let text = `${formatTime(state.cursor)} / ${formatTime(item.duration)}`;
    if (position?.kind === 'sequence') text += ` · etapa ${position.step + 1}/${position.steps} a ${pct(position.speed)} · repetição ${position.loop}/${position.loops}`;
    if (position?.kind === 'ab') text = `A/B ${formatTime(position.time)} · ouvindo ${position.active.toUpperCase()}`;
    if (state.setlistPlay) text += ` · setlist ${state.setlistPlay.index + 1}/${state.setlistPlay.total}`;
    positionText.textContent = text;
  }

  function draw() {
    if (destroyed) return;
    const item = current();
    const analysis = item ? analyses.get(item.id) : null;
    drawWaveform(canvas, {
      buffer: item ? buffers.get(item.id) ?? null : null,
      duration: item?.duration ?? 1,
      view: state.view,
      cursor: item ? state.cursor : NaN,
      region: item?.region ?? null,
      selection: state.selection,
      markers: item?.markers ?? [],
      grid: item?.tempo && state.show.grid ? beatGrid(item.tempo, state.view.start, state.view.end, 3000) : [],
      trackedBeats: state.show.beats ? analysis?.beats ?? null : null,
      onsets: state.show.onsets ? analysis?.onsets ?? null : null,
      chords: state.show.chords ? item?.chords ?? [] : [],
      notes: state.show.notes ? analysis?.notes ?? [] : [],
      minConfidence: state.minNoteConfidence,
      placeholder: !item ? 'Importe ou selecione um áudio na biblioteca.' : item.source === 'attempt' && !item.media ? 'Tentativa sem áudio: use “Renderizar de novo”.' : state.missingMedia.has(item.id) || !item.media ? 'Mídia ausente: vincule o arquivo original.' : 'Carregando áudio…',
    });
    canvas.setAttribute('aria-valuemax', String(Math.round((item?.duration ?? 0) * 10) / 10));
    canvas.setAttribute('aria-valuenow', String(Math.round(state.cursor * 10) / 10));
    canvas.setAttribute('aria-valuetext', item ? `${formatTime(state.cursor)} de ${formatTime(item.duration)}${item.region ? `, trecho ${formatTime(item.region.start)} a ${formatTime(item.region.end)}` : ''}` : 'sem item');
  }

  function viewSpan(item = current()) {
    return (item?.duration ?? 1) / state.zoom;
  }

  function setZoom(zoom) {
    const item = current();
    if (!item) return;
    state.zoom = clamp(Math.round(zoom), 1, 64);
    const span = viewSpan(item);
    const start = clamp(state.cursor - span / 2, 0, Math.max(0, item.duration - span));
    state.view = { start, end: start + span };
    setValue(zoomInput, state.zoom);
    syncScroll();
    draw();
  }

  function scrollTo(fraction) {
    const item = current();
    if (!item) return;
    const span = viewSpan(item);
    const start = clamp(fraction, 0, 1) * Math.max(0, item.duration - span);
    state.view = { start, end: start + span };
    draw();
  }

  function syncScroll() {
    const item = current();
    if (!item) return;
    const room = item.duration - viewSpan(item);
    setValue(scrollInput, room > 0 ? Math.round(state.view.start / room * 1000) : 0);
  }

  function keepCursorVisible() {
    const item = current();
    if (!item || state.zoom === 1) return;
    if (state.cursor < state.view.start || state.cursor > state.view.end) {
      const span = viewSpan(item);
      const start = clamp(state.cursor - span * 0.1, 0, Math.max(0, item.duration - span));
      state.view = { start, end: start + span };
      syncScroll();
    }
  }

  function onPointerDown(event) {
    if (!current() || event.button !== 0) return;
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, time: timeAtX(canvas, event.clientX, state.view), moved: false };
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (Math.abs(event.clientX - drag.x) > 4) drag.moved = true;
    if (!drag.moved) return;
    const time = timeAtX(canvas, event.clientX, state.view);
    state.selection = { start: Math.min(drag.time, time), end: Math.max(drag.time, time) };
    draw();
  }

  function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const { moved, time } = drag;
    drag = null;
    const selection = state.selection;
    state.selection = null;
    if (moved && selection) setRegion(selection);
    else seek(time);
  }

  function onWheel(event) {
    const item = current();
    if (!item) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      setZoom(event.deltaY < 0 ? Math.max(state.zoom + 1, state.zoom * 1.25) : Math.min(state.zoom - 1, state.zoom * 0.8));
    } else if (state.zoom > 1 && Math.abs(event.deltaX) + Math.abs(event.deltaY) > 0) {
      event.preventDefault();
      const span = viewSpan(item);
      const delta = (event.deltaX || event.deltaY) / Math.max(1, canvas.clientWidth) * span;
      const start = clamp(state.view.start + delta, 0, Math.max(0, item.duration - span));
      state.view = { start, end: start + span };
      syncScroll();
      draw();
    }
  }

  function onCanvasKey(event) {
    const item = current();
    if (!item) return;
    const key = event.key;
    const step = event.shiftKey ? 0.1 : 1;
    const actions = {
      ArrowLeft: () => seek(state.cursor - step),
      ArrowRight: () => seek(state.cursor + step),
      PageUp: () => seek(state.cursor - 10),
      PageDown: () => seek(state.cursor + 10),
      Home: () => seek(0),
      End: () => seek(item.duration),
      ' ': () => togglePlay(),
      Enter: () => togglePlay(),
      a: () => setRegionEdge('start'),
      b: () => setRegionEdge('end'),
      m: () => addMarkerAtCursor('comment'),
      s: () => addMarkerAtCursor('section'),
      '+': () => setZoom(state.zoom * 2),
      '=': () => setZoom(state.zoom * 2),
      '-': () => setZoom(state.zoom / 2),
      x: () => switchAB(state.ab.active === 'a' ? 'b' : 'a'),
    };
    const action = actions[key] ?? actions[key.toLowerCase()];
    if (!action || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  }

  function seek(time) {
    const item = current();
    if (!item) return;
    state.cursor = clamp(time, 0, item.duration);
    keepCursorVisible();
    draw();
    updatePositionText(null);
    if (player.mode === 'single' && state.playingItemId === item.id && !state.setlistPlay) startPlayback();
  }

  function rewind() {
    const item = current();
    if (item) seek(item.region?.start ?? 0);
  }

  function setRegion(region) {
    const item = current();
    if (!item) return;
    const normalized = region ? normalizeRegion(region, item.duration) : null;
    if (region && !normalized) {
      setStatus('Trecho curto demais (mínimo de 0,05 s).', true);
      draw();
      return;
    }
    updateItem({ region: normalized });
    if (normalized) state.cursor = normalized.start;
    draw();
    restartIfPlaying();
  }

  function setRegionEdge(edge) {
    const item = current();
    if (!item) return;
    const region = item.region ?? { start: 0, end: item.duration };
    setRegion(edge === 'start' ? { start: state.cursor, end: Math.max(region.end, state.cursor + 0.05) } : { start: Math.min(region.start, state.cursor - 0.05), end: state.cursor });
  }

  function commitRegionInputs() {
    const item = current();
    if (!item) return;
    if (!aInput.value.trim() && !bInput.value.trim()) { setRegion(null); return; }
    const start = parseTime(aInput.value || '0');
    const end = parseTime(bInput.value || String(item.duration));
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      setStatus('Use tempos como 83,4 ou 1:23,4.', true);
      refreshLab();
      return;
    }
    setRegion({ start, end });
  }

  function setProcessing(patch) {
    const item = current();
    if (!item) return;
    const processing = { ...item.processing, ...patch };
    const problem = validateProcessing(processing);
    if (problem) {
      setStatus(problem, true);
      refreshLab();
      return;
    }
    updateItem({ processing });
    restartIfPlaying();
  }

  // ---------- Transporte ----------
  function restartIfPlaying() {
    if (player.mode === 'single' && state.playingItemId === state.selectedId && !state.setlistPlay) startPlayback();
  }

  async function togglePlay() {
    if (player.playing && player.mode === 'single' && state.playingItemId === state.selectedId && !state.setlistPlay) {
      const position = player.position();
      if (position) state.cursor = position.time;
      stop();
      return;
    }
    await startPlayback();
  }

  function sliceBuffer(buffer, range) {
    const start = Math.floor(range.start * buffer.sampleRate);
    const end = Math.min(buffer.length, Math.ceil(range.end * buffer.sampleRate));
    return player.createBuffer(channelsOf(buffer).map(channel => channel.slice(start, end)), buffer.sampleRate);
  }

  function processedBytes() {
    let total = 0;
    for (const buffer of processedCache.values()) total += buffer.length * buffer.numberOfChannels * 4;
    return total;
  }

  async function processedBuffer(item, buffer, range, processing, label = '') {
    const key = [item.id, range.start.toFixed(3), range.end.toFixed(3), processing.speed, processing.semitones, processing.cents, processing.algorithm].join('|');
    if (processedCache.has(key)) {
      const cached = processedCache.get(key);
      processedCache.delete(key);
      processedCache.set(key, cached);
      return cached;
    }
    const problem = validateProcessing(processing);
    if (problem) throw new RangeError(problem);
    const startSample = Math.floor(range.start * buffer.sampleRate);
    const endSample = Math.min(buffer.length, Math.ceil(range.end * buffer.sampleRate));
    const estimate = processingMemoryEstimate({ samples: endSample - startSample, channels: buffer.numberOfChannels, ...processing });
    if (estimate > PROCESS_MEMORY_LIMIT) {
      throw new RangeError(`Trecho longo demais para processar com segurança (≈${formatBytes(estimate)} de memória; limite ${formatBytes(PROCESS_MEMORY_LIMIT)}). Selecione um trecho A–B menor.`);
    }
    const channels = channelsOf(buffer).map(channel => channel.slice(startSample, endSample));
    const result = await runJob('process', { channels, sampleRate: buffer.sampleRate, ...processing }, {
      transfer: channels.map(channel => channel.buffer),
      label: `${label ? `${label}: ` : ''}processando ${formatTime(range.end - range.start)} a ${processingText(processing)}`,
    });
    const output = player.createBuffer(result.channels, buffer.sampleRate);
    processedCache.set(key, output);
    while (processedCache.size > 1 && processedBytes() > PROCESSED_CACHE_BYTES) processedCache.delete(processedCache.keys().next().value);
    return output;
  }

  async function prepareSource(item, { fromCursor = true, loop = item.loop, region = item.region, processing = item.processing } = {}) {
    const buffer = await loadBuffer(item);
    const range = region ?? { start: 0, end: buffer.duration };
    const cursor = fromCursor && state.selectedId === item.id ? state.cursor : range.start;
    const inRange = cursor >= range.start && cursor < range.end - 0.02;
    if (isIdentityProcessing(processing)) {
      return { buffer, offset: inRange ? cursor : range.start, loop, loopStart: range.start, loopEnd: range.end, originStart: 0, speed: 1, label: `${item.name} (original)` };
    }
    const processed = await processedBuffer(item, buffer, range, processing);
    return {
      buffer: processed, offset: inRange ? (cursor - range.start) / processing.speed : 0, loop, loopStart: 0, loopEnd: processed.duration,
      originStart: range.start, speed: processing.speed, label: `${item.name} a ${processingText(processing)}`,
    };
  }

  async function startPlayback() {
    const item = current();
    if (!item) return;
    const generation = ++playGeneration;
    player.stop();
    state.setlistPlay = null;
    finishPractice();
    let source;
    try {
      source = await prepareSource(item);
    } catch (error) {
      if (generation === playGeneration) reportError(error);
      refreshTransport();
      return;
    }
    if (generation !== playGeneration || destroyed) return;
    host.stop();
    state.playingItemId = item.id;
    if (await player.playSingle(source)) {
      setStatus(`Tocando ${source.label}${source.loop ? ' em laço' : ''}.`);
      startFrameLoop();
    }
    refreshTransport();
  }

  function startFrameLoop() {
    cancelAnimationFrame(frame);
    const tick = () => {
      const position = player.position();
      if (!position || destroyed) { frame = 0; refreshTransport(); return; }
      if (position.kind === 'ab') {
        if (state.ab.a === state.selectedId) state.cursor = position.a;
      } else if (state.playingItemId === state.selectedId) {
        state.cursor = position.time;
      }
      if (position.kind === 'sequence' && state.practice) state.practice.reached = Math.max(state.practice.reached, position.speed);
      keepCursorVisible();
      draw();
      updatePositionText(position);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  function finishPractice(completed = false) {
    const practice = state.practice;
    state.practice = null;
    if (!practice) return;
    const exercise = state.exercises.find(entry => entry.id === practice.exerciseId);
    if (!exercise || (!completed && practice.reached === 0)) return;
    const reached = completed ? exercise.speedTo : practice.reached;
    saveExercise(recordPractice(exercise, reached)).then(() => { if (state.tab === 'exercises') renderTabs(); });
    setStatus(completed ? `Exercício “${exercise.name}” concluído até ${pct(reached)}.` : `Prática interrompida em ${pct(reached)}; progresso registrado.`);
  }

  function handleEnded(kind) {
    cancelAnimationFrame(frame);
    frame = 0;
    if (kind === 'sequence') finishPractice(true);
    if (state.setlistPlay) {
      const next = state.setlistPlay.index + 1;
      playSetlistEntry(next);
      return;
    }
    state.playingItemId = null;
    refreshTransport();
    draw();
  }

  // Pública: para tudo o que o repertório estiver tocando (a UI chama antes do estúdio tocar).
  function stop() {
    playGeneration++;
    cancelAnimationFrame(frame);
    frame = 0;
    const wasSequence = player.mode === 'sequence';
    player.stop();
    if (wasSequence) finishPractice(false);
    else state.practice = null;
    state.setlistPlay = null;
    state.playingItemId = null;
    if (!destroyed) {
      refreshTransport();
      draw();
    }
  }

  // ---------- Abas ----------
  function setTab(id) {
    state.tab = id;
    savePrefs();
    renderTabs();
  }

  function tabKeys(event) {
    const index = TABS.findIndex(([id]) => id === state.tab);
    const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = (moves[event.key] + TABS.length) % TABS.length;
    setTab(TABS[next][0]);
    tabButtons[next].focus();
  }

  // Atualiza ações derivadas sem perder rascunhos, foco ou divulgações abertas.
  function refreshDerivedTabs() {
    if (['analysis', 'exercises', 'setlists', 'share'].includes(state.tab)) renderTabs();
  }

  function renderTabs() {
    const previousContext = panelContext;
    const focus = captureUI(tabPanel, previousContext);
    panelContext = `${state.tab}:${state.selectedId ?? ''}:${state.tab === 'setlists' ? state.setlistId ?? '' : ''}`;
    tabButtons.forEach((button, index) => {
      const active = TABS[index][0] === state.tab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    tabPanel.setAttribute('aria-labelledby', uid(`tab-${state.tab}`));
    const builders = { markers: markersTab, analysis: analysisTab, takes: takesTab, exercises: exercisesTab, setlists: setlistsTab, share: shareTab };
    tabPanel.replaceChildren(...compactSections(builders[state.tab]()));
    restoreUI(tabPanel, panelContext, previousContext === panelContext ? focus : null);
    refreshBusy();
  }

  function needsItem(text = 'Selecione um item da biblioteca para usar esta ferramenta.') {
    if (!state.items.length && state.tab === 'markers') return null;
    return h('p', { class: 'rep-hint', text });
  }

  // Marcadores e anotações
  function addMarkerAtCursor(kind, { label = '', text = '', ranged = false } = {}) {
    const item = current();
    if (!item) return;
    try {
      const region = ranged ? item.region : null;
      const marker = createMarker({ kind, time: region ? region.start : state.cursor, end: region ? region.end : null, label: label || (kind === 'section' ? nextSectionName(item) : ''), text });
      updateItem({ markers: upsertMarker(item.markers, marker) });
      setStatus(`${MARKER_KINDS[kind]} “${marker.label}” em ${formatTime(marker.time)}.`);
      if (state.tab !== 'markers') setTab('markers');
      else renderTabs();
      tabPanel.querySelector(`[data-marker="${marker.id}"] .rep-marker-label`)?.focus();
    } catch (error) {
      reportError(error);
    }
  }

  function nextSectionName(item) {
    const count = item.markers.filter(marker => marker.kind === 'section').length;
    return SECTION_PRESETS[Math.min(count, SECTION_PRESETS.length - 1)];
  }

  function editMarker(marker, patch) {
    const item = current();
    if (!item) return;
    const next = { ...marker, ...patch };
    if (!Number.isFinite(next.time) || next.time < 0 || next.time > item.duration) {
      setStatus('Tempo de marcador inválido.', true);
      renderTabs();
      return;
    }
    if (next.end !== null && !(next.end > next.time)) next.end = null;
    updateItem({ markers: upsertMarker(item.markers, next) });
    renderTabs();
  }

  function markersTab() {
    const item = current();
    if (!item) return needsItem();
    const kindSelect = h('select', { 'data-draft': 'marker-kind' }, Object.entries(MARKER_KINDS).map(([value, label]) => h('option', { value }, label)));
    const labelInput = h('input', { type: 'text', 'data-draft': 'marker-label', maxLength: 80, list: uid('sections'), placeholder: 'Ex.: Refrão, respiração, entrada do baixo' });
    const textInput = h('textarea', { rows: 2, 'data-draft': 'marker-text', maxLength: 2000, placeholder: 'Comentário opcional' });
    const rangedInput = h('input', { type: 'checkbox', 'data-draft': 'marker-ranged', disabled: !item.region });
    const sections = sectionList(item.markers, item.duration);
    return [
      h('datalist', { id: uid('sections') }, SECTION_PRESETS.map(name => h('option', { value: name }))),
      h('div', { class: 'rep-form' },
        field('Tipo', kindSelect), field('Rótulo', labelInput), field('Comentário', textInput),
        h('label', { class: 'toggle' }, rangedInput, 'Usar o trecho A–B como intervalo'),
        h('button', { type: 'button', class: 'primary', onclick: () => addMarkerAtCursor(kindSelect.value, { label: labelInput.value.trim(), text: textInput.value, ranged: rangedInput.checked }), text: `Adicionar em ${formatTime(state.cursor)}` })),
      item.markers.length ? h('ul', { class: 'rep-marker-list' }, item.markers.map(marker => {
        const section = sections.find(entry => entry.id === marker.id);
        const timeInput = h('input', { type: 'text', class: 'rep-time', value: formatTime(marker.time), 'aria-label': `Tempo de ${marker.label}`, onchange: event => editMarker(marker, { time: parseTime(event.target.value) }) });
        return h('li', { 'data-marker': marker.id, class: `rep-marker kind-${marker.kind}` },
          h('span', { class: 'rep-badge', text: MARKER_KINDS[marker.kind] }),
          timeInput,
          h('input', { type: 'text', class: 'rep-marker-label', maxLength: 80, value: marker.label, 'aria-label': 'Rótulo do marcador', onchange: event => editMarker(marker, { label: event.target.value.trim() || MARKER_KINDS[marker.kind] }) }),
          h('textarea', { rows: 1, maxLength: 2000, value: marker.text, 'aria-label': `Comentário de ${marker.label}`, onchange: event => editMarker(marker, { text: event.target.value }) }),
          h('span', { class: 'rep-hint', text: marker.end ? `até ${formatTime(marker.end)}` : section ? `até ${formatTime(section.end)}` : '' }),
          h('button', { type: 'button', onclick: () => seek(marker.time), text: 'Ir' }),
          marker.end || section ? h('button', { type: 'button', onclick: () => setRegion({ start: marker.time, end: marker.end ?? section.end }), text: 'Selecionar trecho' }) : null,
          h('button', { type: 'button', onclick: () => { updateItem({ markers: removeMarker(item.markers, marker.id) }); renderTabs(); }, 'aria-label': `Remover ${marker.label}`, text: 'Remover' }));
      })) : h('p', { class: 'rep-hint', text: 'Sem marcadores. Seções (S) dividem a música; comentários (M) guardam observações em um ponto ou trecho.' }),
      field('Anotações gerais do item', h('textarea', { rows: 3, maxLength: 4000, value: item.note, onchange: event => updateItem({ note: event.target.value }) })),
    ];
  }

  // Análise
  async function analysisSignal(buffer, range) {
    const duration = range.end - range.start;
    const OfflineContext = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
    if (OfflineContext) {
      const context = new OfflineContext(1, Math.max(1, Math.ceil(duration * ANALYSIS_SAMPLE_RATE)), ANALYSIS_SAMPLE_RATE);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start(0, range.start, duration);
      const rendered = await context.startRendering();
      return { mono: rendered.getChannelData(0).slice(), sampleRate: ANALYSIS_SAMPLE_RATE };
    }
    const start = Math.floor(range.start * buffer.sampleRate);
    const end = Math.ceil(range.end * buffer.sampleRate);
    return { mono: mixToMono(channelsOf(buffer).map(channel => channel.slice(start, end))), sampleRate: buffer.sampleRate };
  }

  function shiftAnalysis(result, offset, range) {
    return {
      ...result,
      range,
      offset,
      analyzedAt: new Date().toISOString(),
      onsets: result.onsets?.map(onset => ({ ...onset, time: onset.time + offset })),
      beats: result.beats?.map(time => time + offset),
      tempo: result.tempo?.map(candidate => ({ ...candidate, offset: candidate.offset + offset })),
      notes: result.notes?.map(note => ({ ...note, start: note.start + offset, end: note.end + offset })),
      chords: result.chords?.map(chord => ({ ...chord, start: chord.start + offset, end: chord.end + offset })),
      pitch: result.pitch ? { ...result.pitch, offset: result.pitch.offset + offset } : undefined,
    };
  }

  async function analyzeItem(item, { range, stages = ['rhythm', 'pitch', 'harmony'], label = 'Analisando' } = {}) {
    const buffer = await loadBuffer(item);
    const span = range ?? { start: 0, end: buffer.duration };
    if (span.end - span.start > MAX_DURATION_SECONDS) throw new RangeError(`A análise aceita até ${MAX_DURATION_SECONDS / 60} min por vez; selecione um trecho.`);
    showJob(`${label}: preparando sinal mono a ${ANALYSIS_SAMPLE_RATE} Hz`, 0);
    const { mono, sampleRate } = await analysisSignal(buffer, span);
    const result = await runJob('analyze', { mono, sampleRate, duration: span.end - span.start, offset: 0, sensitivity: 0.5, stages }, { transfer: [mono.buffer], label: `${label} “${item.name}”` });
    return shiftAnalysis(result, span.start, span);
  }

  async function runAnalysis() {
    const item = current();
    if (!item) return;
    try {
      const analysis = await analyzeItem(item, { range: state.analyzeRegionOnly ? item.region : null });
      await saveAnalysis(item.id, analysis);
      const keepEdited = item.chords.filter(chord => chord.edited && (chord.end <= analysis.range.start || chord.start >= analysis.range.end));
      const chords = [...keepEdited, ...(analysis.chords ?? []).map(chord => ({ ...chord, edited: false }))].sort((a, b) => a.start - b.start);
      const best = analysis.tempo?.[0];
      const tempo = best && (!item.tempo || item.tempo.source === 'analysis')
        ? analysisTempo(best, item.tempo, host.getSession()?.meter)
        : item.tempo;
      updateItem({ chords, tempo });
      setStatus(`Análise concluída: ${analysis.onsets?.length ?? 0} ataques, ${analysis.tempo?.length ?? 0} candidatos de andamento, ${analysis.notes?.length ?? 0} notas e ${analysis.chords?.length ?? 0} segmentos de acorde estimados.`);
      renderTabs();
      draw();
    } catch (error) {
      reportError(error);
      hideJob();
    }
  }

  function setTempo(patch) {
    const item = current();
    if (!item) return;
    const base = item.tempo ?? { bpm: 120, offset: 0, beatsPerBar: 4, beatUnit: 4, source: 'manual', meterSource: 'default' };
    const meterOnly = Object.hasOwn(patch, 'beatsPerBar') || Object.hasOwn(patch, 'beatUnit');
    updateItem({ tempo: { ...base, ...(meterOnly ? { meterSource: 'manual' } : { source: 'manual' }), ...patch } });
    renderTabs();
  }

  async function retrackBeats() {
    const item = current();
    const analysis = item && analyses.get(item.id);
    if (!analysis?.envelope || !item.tempo) return;
    try {
      const envelope = analysis.envelope.slice();
      const { beats } = await runJob('beats', { envelope, envelopeRate: analysis.envelopeRate, bpm: item.tempo.bpm, duration: analysis.duration }, { transfer: [envelope.buffer], label: 'Pulsos' });
      await saveAnalysis(item.id, { ...analysis, beats: beats.map(time => time + analysis.offset) });
      state.show.beats = true;
      setStatus(`${beats.length} pulsos rastreados a partir de ${item.tempo.bpm} BPM.`);
      renderTabs();
      draw();
    } catch (error) {
      reportError(error);
    }
  }

  function repickOnsets(sensitivity) {
    const item = current();
    const analysis = item && analyses.get(item.id);
    if (!analysis?.envelope) return;
    const onsets = pickOnsets(analysis.envelope, analysis.envelopeRate, { sensitivity, duration: analysis.duration }).map(onset => ({ ...onset, time: onset.time + analysis.offset }));
    analyses.set(item.id, { ...analysis, onsets, sensitivity });
    draw();
    return onsets.length;
  }

  function editChord(index, label) {
    const item = current();
    if (!item) return;
    const chords = item.chords.map((chord, position) => (position === index ? { ...chord, label: label.trim().slice(0, 24) || 'N', edited: true } : chord));
    updateItem({ chords });
  }

  async function separateItem() {
    const item = current();
    if (!item) return;
    try {
      const buffer = await loadBuffer(item);
      const range = item.region ?? { start: 0, end: buffer.duration };
      const start = Math.floor(range.start * buffer.sampleRate);
      const end = Math.min(buffer.length, Math.ceil(range.end * buffer.sampleRate));
      const estimate = (end - start) * buffer.numberOfChannels * 4 * 4;
      if (estimate > PROCESS_MEMORY_LIMIT) throw new RangeError(`Trecho longo demais para separar com segurança (≈${formatBytes(estimate)}). Selecione um trecho A–B menor.`);
      const channels = channelsOf(buffer).map(channel => channel.slice(start, end));
      const { harmonic, percussive } = await runJob('hpss', { channels, sampleRate: buffer.sampleRate }, { transfer: channels.map(channel => channel.buffer), label: 'Separação HPSS' });
      const suffix = item.region ? ` ${formatTime(range.start)}–${formatTime(range.end)}` : '';
      await storeRendered({ kind: 'derived', source: 'hpss-harmonic', name: `${item.name}${suffix} · harmônico (estimado)`, channels: harmonic, sampleRate: buffer.sampleRate, parentId: item.id });
      await storeRendered({ kind: 'derived', source: 'hpss-percussive', name: `${item.name}${suffix} · percussivo (estimado)`, channels: percussive, sampleRate: buffer.sampleRate, parentId: item.id });
      setStatus('Separação concluída: duas estimativas (harmônica e percussiva) foram adicionadas aos derivados.');
    } catch (error) {
      reportError(error);
    }
  }

  function analysisTab() {
    const item = current();
    if (!item) return needsItem();
    const analysis = analyses.get(item.id);
    const content = [
      h('p', { class: 'rep-hint', text: 'Estimativas locais: confira de ouvido e corrija.' }),
      h('div', { class: 'rep-row' },
        h('button', { type: 'button', class: 'primary', 'data-job': 'true', onclick: runAnalysis, text: analysis ? 'Analisar de novo' : 'Analisar ritmo, altura e acordes' }),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: state.analyzeRegionOnly, disabled: !item.region, onchange: event => { state.analyzeRegionOnly = event.target.checked; } }), 'Somente o trecho A–B')),
      disclosure('analysis-method', 'Métodos e separação de áudio',
        h('p', { class: 'rep-hint', text: 'Andamento por autocorrelação, pulsos por programação dinâmica, altura predominante por YIN e acordes por croma. São hipóteses, não uma transcrição exata.' }),
        h('button', { type: 'button', 'data-job': 'true', onclick: separateItem, text: 'Separar harmônico/percussivo' }),
        h('p', { class: 'rep-hint', text: 'HPSS gera duas estimativas do trecho A–B (ou do item): sons sustentados e ataques. Não isola voz, baixo ou instrumentos específicos.' })),
    ];
    const tempo = item.tempo;
    const tapButton = h('button', { type: 'button', onclick: () => {
      const now = performance.now();
      if (state.taps.length && now - state.taps[state.taps.length - 1] > 2000) state.taps = [];
      state.taps.push(now);
      const bpm = tapTempo(state.taps);
      tapButton.textContent = bpm ? `Toque (${bpm} BPM)` : `Toque (${state.taps.length})`;
      if (bpm) setTempoQuietly({ bpm, source: 'tap' });
    }, text: 'Toque no pulso' });
    content.push(h('section', { class: 'rep-subsection' },
      h('h4', { text: 'Andamento e grade' }),
      analysis?.tempo?.length ? h('fieldset', { class: 'rep-candidates' },
        h('legend', { text: 'Candidatos de andamento (escolha ou edite)' }),
        analysis.tempo.map((candidate, index) => {
          const relation = index > 0 ? relationTo(candidate.bpm, analysis.tempo[0].bpm) : '';
          return h('label', { class: 'toggle' },
            h('input', { type: 'radio', name: uid('tempo'), checked: tempo && Math.abs(tempo.bpm - candidate.bpm) < 0.05, onchange: () => {
              updateItem({ tempo: analysisTempo(candidate, tempo, host.getSession()?.meter) });
              renderTabs();
            } }),
            `${candidate.bpm.toLocaleString('pt-BR')} BPM — confiança ${pct(candidate.confidence)}${relation}`);
        })) : h('p', { class: 'rep-hint', text: analysis ? 'Nenhum candidato de andamento: o trecho não tem ataques periódicos claros. Defina manualmente ou use o toque.' : 'Analise o item ou defina o andamento manualmente.' }),
      h('div', { class: 'rep-row' },
        field('BPM', h('input', { type: 'number', min: 20, max: 400, step: 0.1, value: tempo?.bpm ?? '', onchange: event => { const bpm = Number(event.target.value); if (bpm >= 20 && bpm <= 400) setTempo({ bpm }); } })),
        field('Primeiro tempo forte (s)', h('input', { type: 'number', step: 0.01, value: tempo ? Math.round(tempo.offset * 1000) / 1000 : '', onchange: event => setTempo({ offset: Number(event.target.value) || 0 }) })),
        field('Tempos por compasso', h('input', { type: 'number', min: 1, max: 16, step: 1, value: tempo?.beatsPerBar ?? 4, onchange: event => { const beats = Math.round(Number(event.target.value)); if (beats >= 1 && beats <= 16) setTempo({ beatsPerBar: beats }); } })),
        field('Unidade do compasso', h('select', { value: tempo?.beatUnit ?? 4, onchange: event => setTempo({ beatUnit: Number(event.target.value) }) },
          [2, 4, 8, 16].map(unit => h('option', { value: unit, text: `/${unit}` })))),
        h('button', { type: 'button', onclick: () => setTempo({ offset: state.cursor }), text: 'Tempo forte = cursor' }),
        tapButton,
        h('button', { type: 'button', 'data-job': 'true', disabled: !analysis?.envelope || !tempo, onclick: retrackBeats, text: 'Reacompanhar pulsos com este BPM' })),
      tempo ? h('p', { class: 'rep-hint', text: `Grade atual: ${tempo.bpm.toLocaleString('pt-BR')} BPM (${{ analysis: 'estimado pela análise', manual: 'manual', tap: 'por toque' }[tempo.source]}), compasso ${tempo.beatsPerBar}/${tempo.beatUnit ?? 4} (${{ studio: 'herdado do estúdio', manual: 'escolhido manualmente', default: 'padrão' }[tempo.meterSource] ?? 'escolhido manualmente'}). A análise não detecta fórmula de compasso; BPM conta semínimas por minuto.` }) : null));

    if (analysis) {
      const range = analysis.range ? `${formatTime(analysis.range.start)}–${formatTime(analysis.range.end)}` : 'item inteiro';
      const sensitivity = h('input', { type: 'range', min: 0, max: 100, step: 1, value: Math.round((analysis.sensitivity ?? 0.5) * 100), 'aria-label': 'Sensibilidade dos ataques' });
      const onsetCount = h('output', { text: `${analysis.onsets?.length ?? 0} ataques` });
      sensitivity.addEventListener('input', () => { onsetCount.textContent = `${repickOnsets(Number(sensitivity.value) / 100) ?? 0} ataques`; });
      sensitivity.addEventListener('change', () => saveAnalysis(item.id, analyses.get(item.id)));
      const notesInRange = (analysis.notes ?? []).filter(note => note.confidence >= state.minNoteConfidence);
      const regionNotes = item.region ? notesInRange.filter(note => note.end > item.region.start && note.start < item.region.end) : notesInRange;
      const confidence = h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round(state.minNoteConfidence * 100), 'aria-label': 'Confiança mínima das notas',
        onchange: event => { state.minNoteConfidence = Number(event.target.value) / 100; renderTabs(); draw(); } });
      content.push(
        h('p', { class: 'rep-hint', text: `Última análise: ${range}, ${new Date(analysis.analyzedAt).toLocaleString('pt-BR')}.` }),
        analysis.warnings?.length ? h('ul', { class: 'rep-warnings' }, analysis.warnings.map(warning => h('li', { text: warning }))) : null,
        h('section', { class: 'rep-subsection' },
          h('h4', { text: 'Ataques' }),
          h('div', { class: 'rep-row' }, field('Sensibilidade', sensitivity), onsetCount)),
        analysis.key?.length ? h('section', { class: 'rep-subsection' },
          h('h4', { text: 'Tonalidade (hipóteses)' }),
          h('p', { text: analysis.key.map(key => `${key.label} (${key.score.toLocaleString('pt-BR')})`).join(' · ') }),
          h('p', { class: 'rep-hint', text: 'Correlação com perfis tonais de Krumhansl-Kessler: valores próximos indicam ambiguidade (ex.: relativa maior/menor).' })) : null,
        chordsSection(item),
        h('section', { class: 'rep-subsection' },
          h('h4', { text: 'Altura predominante (hipóteses monofônicas)' }),
          h('p', { class: 'rep-hint', text: 'O YIN estima uma única altura por instante. Em misturas com vários instrumentos o resultado pode seguir a voz, o baixo ou nenhum dos dois — por isso cada nota mostra confiança.' }),
          h('div', { class: 'rep-row' },
            field('Confiança mínima', confidence),
            h('span', { text: `${regionNotes.length} nota(s) ${item.region ? 'no trecho' : 'no item'}` })),
          regionNotes.length ? h('p', { class: 'rep-note-preview', text: regionNotes.slice(0, 32).map(note => `${midiToName(note.midi)}${note.cents ? `(${note.cents > 0 ? '+' : ''}${note.cents}¢)` : ''}`).join(' ') + (regionNotes.length > 32 ? ' …' : '') }) : null,
          h('div', { class: 'rep-row' },
            h('button', { type: 'button', disabled: !regionNotes.length, onclick: () => exportHypothesesMidi(item, regionNotes), text: 'Baixar hipóteses (MIDI)' }),
            h('button', { type: 'button', disabled: !regionNotes.length || !item.region || !item.tempo, onclick: () => sendRegionToStudio(item, analysis), text: 'Levar notas do trecho para o estúdio' })),
          !item.region || !item.tempo ? h('p', { class: 'rep-hint', text: 'Para levar notas ao estúdio, selecione um trecho A–B e defina o andamento (a grade ancora as notas ao pulso).' }) : null));
    }
    return content;
  }

  function relationTo(bpm, reference) {
    const ratio = bpm / reference;
    for (const [value, text] of [[2, '×2'], [0.5, '½'], [1.5, '×3/2'], [2 / 3, '×2/3'], [3, '×3'], [1 / 3, '⅓']]) {
      if (Math.abs(ratio - value) / value < 0.04) return ` (${text} do primeiro)`;
    }
    return '';
  }

  function setTempoQuietly(patch) {
    const item = current();
    if (!item) return;
    const base = item.tempo ?? { bpm: 120, offset: state.cursor, beatsPerBar: 4, beatUnit: 4, meterSource: 'default' };
    updateItem({ tempo: { ...base, ...patch } });
    draw();
  }

  function chordsSection(item) {
    if (!item.chords.length) return null;
    const visible = item.chords
      .map((chord, index) => ({ chord, index }))
      .filter(({ chord }) => chord.label !== 'N' || chord.edited)
      .filter(({ chord }) => !item.region || (chord.end > item.region.start && chord.start < item.region.end))
      .slice(0, 120);
    return h('section', { class: 'rep-subsection' },
      h('h4', { text: `Acordes estimados ${item.region ? 'no trecho' : ''}` }),
      h('p', { class: 'rep-hint', text: 'Escolha uma alternativa ou digite o acorde ouvido; edições ficam destacadas e entram nos pacotes.' }),
      h('div', { class: 'table-scroll' }, h('table', { class: 'rep-chords' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Tempo' }), h('th', { text: 'Acorde' }), h('th', { text: 'Confiança' }), h('th', { text: '' }))),
        h('tbody', {}, visible.map(({ chord, index }) => {
          const listId = uid(`chord-${index}`);
          return h('tr', { class: chord.edited ? 'edited' : '' },
            h('td', { text: `${formatTime(chord.start)}–${formatTime(chord.end)}` }),
            h('td', {},
              h('input', { type: 'text', maxLength: 24, value: chord.label, list: listId, 'aria-label': `Acorde em ${formatTime(chord.start)}`, onchange: event => editChord(index, event.target.value) }),
              h('datalist', { id: listId }, chord.alternatives.map(alt => h('option', { value: alt.label }, `${alt.label} (${pct(alt.probability)})`)))),
            h('td', { text: chord.edited ? 'editado' : `${pct(chord.confidence)}${chord.alternatives[1] ? ` · alt.: ${chord.alternatives.slice(1, 3).map(alt => alt.label).join(', ')}` : ''}` }),
            h('td', {}, h('button', { type: 'button', onclick: () => setRegion({ start: chord.start, end: chord.end }), text: 'Trecho' })));
        })))),
      item.chords.length > visible.length ? h('p', { class: 'rep-hint', text: 'Lista limitada; selecione um trecho para ver outros acordes.' }) : null);
  }

  function exportHypothesesMidi(item, notes) {
    const origin = item.region?.start ?? 0;
    const bytes = notesToMidi(notes.map(note => ({ ...note, start: note.start - origin, end: note.end - origin })), { bpm: item.tempo?.bpm ?? 120, name: `${item.name} (hipóteses)` });
    download(new Blob([bytes], { type: 'audio/midi' }), `${slug(item.name)}-hipoteses.mid`);
    setStatus(`MIDI com ${notes.length} hipótese(s) de altura baixado${item.tempo ? '' : ' (andamento não definido: 120 BPM usado no arquivo)'}.`);
  }

  async function sendRegionToStudio(item, analysis) {
    try {
      const { patch, warnings } = regionNotesToSessionPatch(analysis.notes, {
        start: item.region.start, end: item.region.end, bpm: item.tempo.bpm, beatOffset: item.tempo.offset, beatsPerBar: item.tempo.beatsPerBar, beatUnit: item.tempo.beatUnit, subdivision: host.getSession().subdivision,
        minConfidence: state.minNoteConfidence, semitones: item.processing.semitones, idPrefix: `rep-${Date.now().toString(36)}`,
      });
      await applySessionPatch({ ...patch, name: `${item.name} ${formatTime(item.region.start)}` }, warnings);
    } catch (error) {
      reportError(error);
    }
  }

  // Takes e comparação A/B
  async function storeRendered({ kind, source, name, channels, sampleRate, parentId = null, extra = {} }) {
    const rate = Math.round(sampleRate);
    const wav = new Blob([encodeWav(channels, rate)], { type: 'audio/wav' });
    const item = createItem({
      kind, source, name, duration: channels[0].length / rate, sampleRate: rate, channels: channels.length, parentId,
      media: { id: createId('md'), mimeType: 'audio/wav', size: wav.size, fileName: `${slug(name)}.wav` }, loop: false, ...extra,
    });
    cacheBuffer(item.id, player.createBuffer(channels, rate));
    await saveItem(item, { media: wav });
    refreshStorage();
    return item;
  }

  async function renderSessionTake({ loops, mix, referenceGain, arrangementGain }) {
    const session = host.getSession();
    try {
      setStatus('Renderizando o arranjo da sessão (offline)…');
      showJob('Renderizando o arranjo da sessão', 0);
      const reference = mix ? current() : null;
      if (mix && !reference) throw new Error('Selecione o item de referência para misturar.');
      const rendered = await host.renderSession(session, { loops, sampleRate: player.sampleRate });
      hideJob();
      let channels = channelsOf(rendered);
      let sampleRate = rendered.sampleRate;
      let source = 'session-render';
      let name = `Arranjo · ${session.name || 'sessão'} · ${session.bpm} BPM`;
      if (reference) {
        const prepared = await prepareSource(reference, { fromCursor: false, loop: false });
        const refBuffer = isIdentityProcessing(reference.processing) ? sliceBuffer(prepared.buffer, reference.region ?? { start: 0, end: prepared.buffer.duration }) : prepared.buffer;
        let arrangement = channels;
        if (Math.abs(refBuffer.sampleRate - sampleRate) > 0.5) arrangement = resample(channels, sampleRate / refBuffer.sampleRate);
        channels = mixChannels(channelsOf(refBuffer), arrangement, referenceGain, arrangementGain);
        sampleRate = refBuffer.sampleRate;
        source = 'mix';
        name = `Mistura · ${reference.name} + arranjo (${session.bpm} BPM)`;
      }
      const item = await storeRendered({ kind: 'take', source, name, channels, sampleRate, parentId: reference?.id ?? null, extra: { session } });
      setStatus(`Take “${item.name}” salvo (${formatTime(item.duration)}).`);
    } catch (error) {
      hideJob();
      reportError(error);
    }
  }

  async function captureTake(attempts, detail = {}) {
    if (!Array.isArray(attempts)) throw new TypeError('captureTake espera a lista de tentativas.');
    await storeReady;
    const session = structuredClone(detail?.session ?? host.getSession());
    // O motor entrega as repetições executadas em detail.repetitions; a sessão é o fallback.
    const declared = Number.isInteger(detail?.repetitions) ? detail.repetitions : session?.training?.repetitions;
    const loops = Number.isInteger(declared) && declared > 0 ? declared : 1;
    const clean = attempts.filter(attempt => attempt && Number.isFinite(attempt.start)).map(attempt => ({ start: attempt.start, end: Number.isFinite(attempt.end) ? attempt.end : null, ...(Number.isFinite(attempt.pitch) ? { pitch: attempt.pitch } : {}) }));
    const name = `Tentativa · ${session?.name || 'sessão'} · ${new Date().toLocaleString('pt-BR')}`;
    const summary = { attempts: clean.length, bpm: session?.bpm, bars: session?.bars, repetitions: loops };
    let item;
    try {
      const rendered = await host.renderSession(session, { loops, attempts: clean });
      item = await storeRendered({ kind: 'take', source: 'attempt', name, channels: channelsOf(rendered), sampleRate: rendered.sampleRate, extra: { attempts: clean, session, summary } });
    } catch (error) {
      const lastEnd = clean.reduce((max, attempt) => Math.max(max, attempt.end ?? attempt.start), 0);
      item = createItem({ kind: 'take', source: 'attempt', name, duration: Math.max(0, lastEnd), loop: false, attempts: clean, session, summary, renderError: error?.message || 'falha ao renderizar' });
      await saveItem(item);
    }
    const message = item.renderError
      ? `Tentativa guardada no Repertório sem áudio (${item.renderError}); use “Renderizar de novo”.`
      : `Tentativa guardada no Repertório como take (${clean.length} ataque(s)).`;
    setStatus(message, Boolean(item.renderError));
    host.notify(message, Boolean(item.renderError));
    if (state.tab === 'takes') renderTabs();
    return item;
  }

  async function rerenderTake(item) {
    if (!item.session) { setStatus('Este take não guarda a sessão necessária para renderizar.', true); return; }
    try {
      showJob('Renderizando a tentativa', 0);
      const rendered = await host.renderSession(item.session, { loops: item.summary?.repetitions ?? 1, attempts: item.attempts ?? [] });
      hideJob();
      const rate = Math.round(rendered.sampleRate);
      const channels = channelsOf(rendered);
      const wav = new Blob([encodeWav(channels, rate)], { type: 'audio/wav' });
      const next = normalizeItem({ ...item, renderError: undefined, duration: rendered.duration, sampleRate: rate, channels: channels.length,
        media: { id: createId('md'), mimeType: 'audio/wav', size: wav.size, fileName: `${slug(item.name)}.wav` } });
      cacheBuffer(item.id, player.createBuffer(channels, rate));
      state.missingMedia.delete(item.id);
      await saveItem(next, { media: wav });
      setStatus(`Áudio do take “${item.name}” renderizado.`);
      if (state.selectedId === item.id) renderAll();
    } catch (error) {
      hideJob();
      reportError(error);
    }
  }

  async function playAB() {
    const a = state.items.find(item => item.id === state.ab.a);
    const b = state.items.find(item => item.id === state.ab.b);
    if (!a || !b) { setStatus('Escolha os itens A e B.', true); return; }
    const generation = ++playGeneration;
    player.stop();
    state.setlistPlay = null;
    try {
      const [bufferA, bufferB] = await Promise.all([loadBuffer(a), loadBuffer(b)]);
      const startA = a.region?.start ?? 0;
      const lengthA = a.region ? a.region.end - a.region.start : bufferA.duration;
      const startB = clamp((b.region?.start ?? 0) + state.ab.offset, 0, Math.max(0, bufferB.duration - 0.1));
      const length = Math.min(lengthA, bufferB.duration - startB);
      if (length < 0.1) throw new RangeError('Os trechos de A e B não se sobrepõem; ajuste o deslocamento ou os trechos.');
      let gainA = 1;
      let gainB = 1;
      if (state.ab.match) {
        const rmsA = rootMeanSquare(channelsOf(bufferA), startA * bufferA.sampleRate, (startA + length) * bufferA.sampleRate);
        const rmsB = rootMeanSquare(channelsOf(bufferB), startB * bufferB.sampleRate, (startB + length) * bufferB.sampleRate);
        if (rmsA > 0 && rmsB > 0) {
          if (rmsA > rmsB) gainA = rmsB / rmsA;
          else gainB = rmsA / rmsB;
        }
      }
      if (generation !== playGeneration || destroyed) return;
      host.stop();
      state.playingItemId = a.id;
      await player.playAB({ a: { buffer: bufferA, start: startA, gain: gainA }, b: { buffer: bufferB, start: startB, gain: gainB }, length, active: state.ab.active });
      setStatus(`A/B sincronizado em laço de ${formatTime(length)}${state.ab.match ? ', volumes igualados por RMS' : ''}. Tecla X alterna.`);
      startFrameLoop();
    } catch (error) {
      if (generation === playGeneration) reportError(error);
    }
    if (state.tab === 'takes') renderTabs();
  }

  function switchAB(which) {
    state.ab.active = which;
    if (player.switchAB(which)) setStatus(`Ouvindo ${which.toUpperCase()}.`);
    for (const button of tabPanel.querySelectorAll('[data-ab]')) button.setAttribute('aria-pressed', String(button.dataset.ab === which));
  }

  async function compareAB() {
    const a = state.items.find(item => item.id === state.ab.a);
    const b = state.items.find(item => item.id === state.ab.b);
    if (!a || !b) { setStatus('Escolha os itens A e B.', true); return; }
    try {
      const [bufferA, bufferB] = await Promise.all([loadBuffer(a), loadBuffer(b)]);
      const startA = a.region?.start ?? 0;
      const lengthA = a.region ? a.region.end - a.region.start : bufferA.duration;
      const startB = clamp((b.region?.start ?? 0) + state.ab.offset, 0, Math.max(0, bufferB.duration - 0.1));
      const length = Math.min(lengthA, bufferB.duration - startB);
      if (length < 0.5) throw new RangeError('Trecho comum curto demais para comparar ataques (mínimo 0,5 s).');
      const resultA = await analyzeItem(a, { range: { start: startA, end: startA + length }, stages: ['rhythm'], label: 'Ataques de A' });
      const resultB = await analyzeItem(b, { range: { start: startB, end: startB + length }, stages: ['rhythm'], label: 'Ataques de B' });
      const comparison = compareOnsets(resultA.onsets.map(onset => onset.time - startA), resultB.onsets.map(onset => onset.time - startB), { tolerance: 0.1 });
      state.ab.result = { ...comparison, length, countA: resultA.onsets.length, countB: resultB.onsets.length };
      renderTabs();
    } catch (error) {
      hideJob();
      reportError(error);
    }
  }

  function takesTab() {
    const playable = state.items.filter(item => item.media);
    const loopsInput = h('input', { type: 'number', 'data-draft': 'take-loops', min: 1, max: 16, step: 1, value: 1 });
    const mixInput = h('input', { type: 'checkbox', 'data-draft': 'take-mix', disabled: !current()?.media });
    const refGain = h('input', { type: 'number', 'data-draft': 'take-reference-gain', min: 0, max: 150, step: 5, value: 100 });
    const arrGain = h('input', { type: 'number', 'data-draft': 'take-arrangement-gain', min: 0, max: 150, step: 5, value: 80 });
    const select = (key, label) => field(label, h('select', { onchange: event => { state.ab[key] = event.target.value || null; state.ab.result = null; savePrefs(); } },
      h('option', { value: '' }, '— escolha —'),
      playable.map(item => h('option', { value: item.id, selected: state.ab[key] === item.id }, `${item.name} (${ITEM_SOURCES[item.source]})`))));
    const result = state.ab.result;
    const ms = value => `${Math.round(value * 1000)} ms`;
    const abPlaying = player.mode === 'ab';
    return [
      h('section', { class: 'rep-subsection' },
        h('h4', { text: 'Renderizar o arranjo gerado' }),
        h('p', { class: 'rep-hint', text: 'Gera um WAV real do arranjo da sessão atual (frase, bateria, acordes, baixo, metrônimo conforme o mixer) pelo motor do estúdio. Opcionalmente mistura com o trecho A–B da referência selecionada, com a velocidade/altura atuais, alinhado no início.' }),
        h('div', { class: 'rep-row' },
          field('Repetições', loopsInput),
          h('label', { class: 'toggle' }, mixInput, 'Misturar com o trecho da referência'),
          field('Referência (%)', refGain), field('Arranjo (%)', arrGain),
          h('button', { type: 'button', class: 'primary', 'data-job': 'true', onclick: () => track(renderSessionTake({
            loops: clamp(Math.round(Number(loopsInput.value) || 1), 1, 16), mix: mixInput.checked,
            referenceGain: clamp(Number(refGain.value) || 0, 0, 150) / 100, arrangementGain: clamp(Number(arrGain.value) || 0, 0, 150) / 100,
          })), text: 'Renderizar take' })),
        h('p', { class: 'rep-hint', text: 'Ao concluir um treino no estúdio, as tentativas de teclado/toque viram takes renderizados aqui automaticamente quando o estúdio as envia.' })),
      h('section', { class: 'rep-subsection' },
        h('h4', { text: 'Comparação A/B sincronizada' }),
        h('p', { class: 'rep-hint', text: 'A e B tocam juntos em laço; alternar troca só o volume, então os dois continuam na mesma posição. O trecho de cada item é o seu A–B salvo (ou o início).' }),
        h('div', { class: 'rep-row' },
          select('a', 'A'), select('b', 'B'),
          field('Deslocamento de B (s)', h('input', { type: 'number', step: 0.01, value: state.ab.offset, onchange: event => { state.ab.offset = Number(event.target.value) || 0; } })),
          h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: state.ab.match, onchange: event => { state.ab.match = event.target.checked; } }), 'Igualar volume (RMS)')),
        h('div', { class: 'rep-row' },
          h('button', { type: 'button', class: 'primary', onclick: playAB, text: 'Tocar A/B' }),
          h('button', { type: 'button', 'data-ab': 'a', 'aria-pressed': String(state.ab.active === 'a'), disabled: !abPlaying, onclick: () => switchAB('a'), text: 'Ouvir A' }),
          h('button', { type: 'button', 'data-ab': 'b', 'aria-pressed': String(state.ab.active === 'b'), disabled: !abPlaying, onclick: () => switchAB('b'), text: 'Ouvir B' }),
          h('button', { type: 'button', onclick: stop, text: 'Parar' }),
          h('button', { type: 'button', 'data-job': 'true', onclick: compareAB, text: 'Comparar ataques' })),
        result ? h('div', { class: 'rep-ab-result' },
          h('p', { text: `${result.matched} ataque(s) emparelhados em ${formatTime(result.length)} (A: ${result.countA}, B: ${result.countB}).` }),
          result.matched ? h('p', { text: `B ${result.meanOffset >= 0 ? 'atrasado' : 'adiantado'} em média ${ms(Math.abs(result.meanOffset))}; desvio absoluto médio de ${ms(result.meanAbsolute)}.` }) : null,
          h('p', { text: `${result.missing} ataque(s) de A sem par em B · ${result.extra} ataque(s) extras em B (janela de ±100 ms).` }),
          h('p', { class: 'rep-hint', text: 'Os ataques são detectados no áudio (fluxo espectral): em mixagens densas, ataques de outros instrumentos também contam.' })) : null),
    ];
  }

  // Exercícios
  async function practiceExercise(exercise) {
    const item = state.items.find(entry => entry.id === exercise.itemId);
    if (!item) { setStatus('O item deste exercício não está mais na biblioteca.', true); return; }
    const generation = ++playGeneration;
    player.stop();
    state.setlistPlay = null;
    state.practice = null;
    try {
      const buffer = await loadBuffer(item);
      const range = { start: exercise.start, end: Math.min(exercise.end, buffer.duration) };
      const schedule = exerciseSchedule(exercise);
      const steps = [];
      for (const [index, step] of schedule.entries()) {
        const processing = { speed: step.speed, semitones: exercise.semitones, cents: exercise.cents, algorithm: exercise.algorithm };
        const stepBuffer = isIdentityProcessing(processing) ? sliceBuffer(buffer, range) : await processedBuffer(item, buffer, range, processing, `Etapa ${index + 1}/${schedule.length}`);
        if (generation !== playGeneration || destroyed) return;
        steps.push({ buffer: stepBuffer, loops: step.loops, originStart: range.start, speed: step.speed, label: `${pct(step.speed)}` });
      }
      host.stop();
      state.practice = { exerciseId: exercise.id, reached: 0 };
      state.playingItemId = item.id;
      if (state.selectedId !== item.id) await selectItem(item.id);
      if (generation !== playGeneration) return;
      await player.playSequence(steps);
      setStatus(`Praticando “${exercise.name}”: ${schedule.map(step => pct(step.speed)).join(' → ')}, ${exercise.loopsPerStep}× cada.`);
      startFrameLoop();
    } catch (error) {
      if (generation === playGeneration) reportError(error);
    }
  }

  async function sendExerciseToStudio(exercise) {
    const item = state.items.find(entry => entry.id === exercise.itemId);
    if (!item?.tempo) { setStatus('Defina o andamento do item (aba Análise) para ancorar as notas.', true); return; }
    try {
      const { patch, warnings } = regionNotesToSessionPatch(exercise.notes, {
        start: exercise.start, end: exercise.end, bpm: item.tempo.bpm, beatOffset: item.tempo.offset, beatsPerBar: item.tempo.beatsPerBar, beatUnit: item.tempo.beatUnit, subdivision: host.getSession().subdivision,
        minConfidence: state.minNoteConfidence, semitones: exercise.semitones, idPrefix: `ex-${Date.now().toString(36)}`,
      });
      await applySessionPatch({ ...patch, name: exercise.name }, warnings);
    } catch (error) {
      reportError(error);
    }
  }

  function exercisesTab() {
    const item = current();
    const nameInput = h('input', { type: 'text', 'data-draft': 'exercise-name', maxLength: 120, placeholder: 'Ex.: Riff do refrão' });
    const objectiveInput = h('textarea', { rows: 2, 'data-draft': 'exercise-objective', maxLength: 2000, placeholder: 'Objetivo: o que observar ao praticar' });
    const fromInput = h('input', { type: 'number', 'data-draft': 'exercise-from', min: 25, max: 150, step: 5, value: 70 });
    const toInput = h('input', { type: 'number', 'data-draft': 'exercise-to', min: 25, max: 150, step: 5, value: 100 });
    const stepInput = h('input', { type: 'number', 'data-draft': 'exercise-step', min: 1, max: 50, step: 1, value: 5 });
    const loopsInput = h('input', { type: 'number', 'data-draft': 'exercise-loops', min: 1, max: 32, step: 1, value: 2 });
    const create = () => {
      try {
        const analysis = analyses.get(item.id);
        const exercise = createExercise(item, item.region, {
          name: nameInput.value.trim(), objective: objectiveInput.value,
          speedFrom: Number(fromInput.value) / 100, speedTo: Number(toInput.value) / 100, speedStep: Number(stepInput.value) / 100,
          loopsPerStep: Math.round(Number(loopsInput.value)), semitones: item.processing.semitones, cents: item.processing.cents, algorithm: item.processing.algorithm,
          notes: analysis?.notes ?? [],
        });
        saveExercise(exercise).then(() => { renderTabs(); renderLibrary(); });
        setStatus(`Exercício “${exercise.name}” criado.`);
      } catch (error) {
        reportError(error);
      }
    };
    return [
      item ? h('section', { class: 'rep-subsection' },
        h('h4', { text: 'Extrair exercício do trecho A–B' }),
        item.region ? h('p', { class: 'rep-hint', text: `Trecho ${formatTime(item.region.start)}–${formatTime(item.region.end)} de “${item.name}”, transposição atual ${processingText({ ...item.processing, speed: 1 }).replace(/^100%,? ?/, '') || 'nenhuma'}. A escada toca o trecho em velocidades crescentes, sem emendas.` })
          : h('p', { class: 'rep-hint', text: 'Selecione um trecho A–B na forma de onda para criar um exercício.' }),
        h('div', { class: 'rep-form' },
          field('Nome', nameInput), field('Objetivo', objectiveInput),
          h('div', { class: 'rep-row' }, field('De (%)', fromInput), field('Até (%)', toInput), field('Passo (%)', stepInput), field('Repetições por etapa', loopsInput)),
          h('button', { type: 'button', class: 'primary', disabled: !item.region, onclick: create, text: 'Criar exercício' }))) : needsItem('Selecione um item para extrair exercícios.'),
      state.exercises.length ? h('ul', { class: 'rep-exercise-list' }, state.exercises.map(exercise => {
        const owner = state.items.find(entry => entry.id === exercise.itemId);
        return h('li', { class: 'rep-exercise' },
          h('div', {},
            h('strong', { text: exercise.name }),
            h('span', { class: 'rep-hint', text: ` ${owner?.name ?? exercise.itemName} · ${formatTime(exercise.start)}–${formatTime(exercise.end)} · ${pct(exercise.speedFrom)} → ${pct(exercise.speedTo)} (passo ${pct(exercise.speedStep)}) × ${exercise.loopsPerStep}${exercise.semitones || exercise.cents ? ` · ${exercise.semitones >= 0 ? '+' : ''}${exercise.semitones} st` : ''}` }),
            exercise.objective ? h('p', { text: exercise.objective }) : null,
            h('p', { class: 'rep-hint', text: exercise.practice.sessions ? `Praticado ${exercise.practice.sessions}× · melhor velocidade ${pct(exercise.practice.bestSpeed)} · último em ${new Date(exercise.practice.lastPracticed).toLocaleDateString('pt-BR')}` : 'Ainda não praticado.' })),
          h('div', { class: 'rep-row' },
            h('button', { type: 'button', class: 'primary', 'data-job': 'true', disabled: !owner, onclick: () => practiceExercise(exercise), text: 'Praticar escada' }),
            h('button', { type: 'button', disabled: !owner, onclick: async () => { await selectItem(exercise.itemId); setRegion({ start: exercise.start, end: exercise.end }); }, text: 'Abrir trecho' }),
            exercise.notes.length ? h('button', { type: 'button', disabled: !owner?.tempo, title: owner?.tempo ? '' : 'Defina o andamento do item', onclick: () => sendExerciseToStudio(exercise), text: `Levar ${exercise.notes.length} nota(s) ao estúdio` }) : null,
            h('button', { type: 'button', onclick: async () => {
              try {
                await store.deleteExercise(exercise.id);
                state.exercises = state.exercises.filter(entry => entry.id !== exercise.id);
                for (const setlist of state.setlists) {
                  const pruned = pruneSetlist(setlist, state);
                  if (pruned !== setlist) await saveSetlist(pruned);
                }
                renderTabs();
              } catch (error) {
                setStatus(describeStorageError(error).message, true);
              }
            }, text: 'Remover' })));
      })) : h('p', { class: 'rep-hint', text: 'Nenhum exercício ainda.' }),
    ];
  }

  // Setlists
  async function playSetlistEntry(index) {
    const setlist = state.setlists.find(entry => entry.id === state.setlistPlay?.id);
    if (!setlist || index >= setlist.entries.length) {
      state.setlistPlay = null;
      state.playingItemId = null;
      setStatus('Setlist concluída.');
      refreshTransport();
      return;
    }
    const entry = setlist.entries[index];
    const generation = ++playGeneration;
    player.stop();
    state.setlistPlay = { id: setlist.id, index, total: setlist.entries.length };
    try {
      if (entry.kind === 'exercise') {
        const exercise = state.exercises.find(item => item.id === entry.id);
        const item = exercise && state.items.find(candidate => candidate.id === exercise.itemId);
        if (!item) throw new Error('Exercício indisponível na setlist.');
        const buffer = await loadBuffer(item);
        const range = { start: exercise.start, end: Math.min(exercise.end, buffer.duration) };
        const steps = [];
        for (const step of exerciseSchedule(exercise)) {
          const processing = { speed: step.speed, semitones: exercise.semitones, cents: exercise.cents, algorithm: exercise.algorithm };
          steps.push({ buffer: isIdentityProcessing(processing) ? sliceBuffer(buffer, range) : await processedBuffer(item, buffer, range, processing, exercise.name), loops: step.loops, originStart: range.start, speed: step.speed });
          if (generation !== playGeneration) return;
        }
        host.stop();
        state.setlistPlay = { id: setlist.id, index, total: setlist.entries.length };
        state.practice = { exerciseId: exercise.id, reached: 0 };
        state.playingItemId = item.id;
        await player.playSequence(steps);
        setStatus(`Setlist “${setlist.name}” ${index + 1}/${setlist.entries.length}: exercício “${exercise.name}”.`);
      } else {
        const item = state.items.find(candidate => candidate.id === entry.id);
        if (!item) throw new Error('Item indisponível na setlist.');
        const source = await prepareSource(item, { fromCursor: false, loop: false });
        if (generation !== playGeneration) return;
        host.stop();
        state.setlistPlay = { id: setlist.id, index, total: setlist.entries.length };
        state.playingItemId = item.id;
        await player.playSingle(source);
        setStatus(`Setlist “${setlist.name}” ${index + 1}/${setlist.entries.length}: ${source.label}.`);
      }
      startFrameLoop();
    } catch (error) {
      if (generation !== playGeneration) return;
      reportError(error);
      state.setlistPlay = { id: setlist.id, index, total: setlist.entries.length };
      playSetlistEntry(index + 1);
    }
  }

  function setlistsTab() {
    const nameInput = h('input', { type: 'text', 'data-draft': 'setlist-name', maxLength: 120, placeholder: 'Ex.: Ensaio de sábado' });
    const setlist = state.setlists.find(entry => entry.id === state.setlistId) ?? null;
    const exerciseSelect = h('select', { 'aria-label': 'Exercício para adicionar', 'data-draft': 'setlist-exercise' }, state.exercises.map(exercise => h('option', { value: exercise.id }, exercise.name)));
    const update = next => saveSetlist(next).then(renderTabs);
    const describe = entry => {
      if (entry.kind === 'exercise') {
        const exercise = state.exercises.find(item => item.id === entry.id);
        return exercise ? `Exercício: ${exercise.name}` : 'Exercício removido';
      }
      const item = state.items.find(candidate => candidate.id === entry.id);
      return item ? `${item.name}${item.region ? ` (${formatTime(item.region.start)}–${formatTime(item.region.end)})` : ''}${isIdentityProcessing(item.processing) ? '' : ` a ${processingText(item.processing)}`}` : 'Item removido';
    };
    return [
      h('div', { class: 'rep-row' },
        field('Nova setlist', nameInput),
        h('button', { type: 'button', onclick: () => {
          try {
            const created = createSetlist(nameInput.value);
            state.setlistId = created.id;
            savePrefs();
            update(created);
          } catch (error) {
            reportError(error);
          }
        }, text: 'Criar' }),
        state.setlists.length ? field('Setlist', h('select', { onchange: event => { state.setlistId = event.target.value; savePrefs(); renderTabs(); } },
          state.setlists.map(entry => h('option', { value: entry.id, selected: entry.id === state.setlistId }, `${entry.name} (${entry.entries.length})`)))) : null),
      setlist ? h('section', { class: 'rep-subsection' },
        h('h4', { text: setlist.name }),
        h('div', { class: 'rep-row' },
          h('button', { type: 'button', disabled: !current(), onclick: () => { try { update(addSetlistEntry(setlist, { kind: 'item', id: current().id })); } catch (error) { reportError(error); } }, text: 'Adicionar item selecionado' }),
          state.exercises.length ? exerciseSelect : null,
          state.exercises.length ? h('button', { type: 'button', onclick: () => { try { update(addSetlistEntry(setlist, { kind: 'exercise', id: exerciseSelect.value })); } catch (error) { reportError(error); } }, text: 'Adicionar exercício' }) : null),
        setlist.entries.length ? h('ol', { class: 'rep-setlist' }, setlist.entries.map((entry, index) => h('li', { class: state.setlistPlay?.id === setlist.id && state.setlistPlay.index === index ? 'playing' : '' },
          h('span', { text: describe(entry) }),
          h('button', { type: 'button', disabled: index === 0, 'aria-label': `Subir ${describe(entry)}`, onclick: () => update(moveSetlistEntry(setlist, index, -1)), text: '↑' }),
          h('button', { type: 'button', disabled: index === setlist.entries.length - 1, 'aria-label': `Descer ${describe(entry)}`, onclick: () => update(moveSetlistEntry(setlist, index, 1)), text: '↓' }),
          h('button', { type: 'button', onclick: () => { state.setlistPlay = { id: setlist.id, index, total: setlist.entries.length }; playSetlistEntry(index); }, text: 'Tocar daqui' }),
          h('button', { type: 'button', 'aria-label': `Remover ${describe(entry)}`, onclick: () => update(removeSetlistEntry(setlist, index)), text: 'Remover' })))) : h('p', { class: 'rep-hint', text: 'Setlist vazia. Itens tocam o seu trecho A–B (ou inteiros) com a velocidade/altura salvas; exercícios tocam a escada.' }),
        h('div', { class: 'rep-row' },
          h('button', { type: 'button', class: 'primary', disabled: !setlist.entries.length, onclick: () => { state.setlistPlay = { id: setlist.id, index: 0, total: setlist.entries.length }; playSetlistEntry(0); }, text: 'Tocar setlist' }),
          h('button', { type: 'button', onclick: stop, text: 'Parar' }),
          h('button', { type: 'button', class: 'danger', onclick: async () => {
            try {
              await store.deleteSetlist(setlist.id);
              state.setlists = state.setlists.filter(entry => entry.id !== setlist.id);
              state.setlistId = state.setlists[0]?.id ?? null;
              savePrefs();
              renderTabs();
            } catch (error) {
              setStatus(describeStorageError(error).message, true);
            }
          }, text: 'Excluir setlist' }))) : h('p', { class: 'rep-hint', text: 'Crie uma setlist para encadear músicas, trechos e exercícios.' }),
    ];
  }

  // Exportar, MIDI e pacotes
  async function exportWav(item, processed) {
    try {
      let buffer;
      let suffix = '';
      if (processed) {
        const source = await prepareSource(item, { fromCursor: false, loop: false });
        buffer = isIdentityProcessing(item.processing) ? sliceBuffer(source.buffer, item.region ?? { start: 0, end: source.buffer.duration }) : source.buffer;
        suffix = `-${Math.round(item.processing.speed * 100)}pct${item.processing.semitones ? `-${item.processing.semitones}st` : ''}${item.region ? '-trecho' : ''}`;
      } else {
        buffer = await loadBuffer(item);
      }
      download(new Blob([encodeWav(channelsOf(buffer), Math.round(buffer.sampleRate))], { type: 'audio/wav' }), `${slug(item.name)}${suffix}.wav`);
      setStatus(`WAV de ${formatTime(buffer.duration)} exportado (16 bits PCM).`);
    } catch (error) {
      reportError(error);
    }
  }

  async function readMidiFile(file) {
    try {
      const parsed = parseMidi(new Uint8Array(await file.arrayBuffer()));
      const trackIndex = defaultMidiTrack(parsed);
      if (trackIndex < 0) throw new Error('O arquivo MIDI não contém notas.');
      state.midi = { parsed, fileName: file.name, trackIndex, quantize: 'sixteenth' };
      setTab('share');
      disclosureState.set('tool:share:MIDI (arquivo Standard MIDI)', true);
      tabPanel.querySelector('[data-disclosure="tool:share:MIDI (arquivo Standard MIDI)"]').open = true;
      setStatus(`MIDI “${file.name}” lido: ${parsed.tracks.length} trilha(s). Escolha a trilha e aplique à sessão.`);
    } catch (error) {
      reportError(error);
    }
  }

  async function applyMidi() {
    const { parsed, trackIndex, quantize, fileName } = state.midi;
    try {
      const { patch, warnings } = midiToSessionPatch(parsed, { trackIndex, quantize, idPrefix: `midi-${Date.now().toString(36)}` });
      if (!patch.name) patch.name = fileName.replace(/\.[^.]+$/, '');
      await applySessionPatch(patch, warnings);
      state.midi = null;
      renderTabs();
    } catch (error) {
      reportError(error);
    }
  }

  async function importPackageFile(file) {
    try {
      const text = await file.text();
      const parsed = parsePackage(text);
      if (!parsed.ok) throw new Error(parsed.error);
      state.pendingPackage = parsed.value;
      setTab('share');
      setStatus(`Pacote “${parsed.value.title}” lido. Revise e escolha o que importar.`);
    } catch (error) {
      reportError(error);
    }
  }

  async function importPackageReference(pkg) {
    const ref = pkg.reference;
    try {
      let buffer = null;
      let media = null;
      let blob = null;
      if (pkg.audio) {
        blob = new Blob([pkg.audio.bytes], { type: pkg.audio.mimeType || 'application/octet-stream' });
        buffer = await decodeBlob(blob, pkg.audio.fileName || ref.name);
        media = { id: createId('md'), mimeType: pkg.audio.mimeType, size: blob.size, fileName: pkg.audio.fileName || ref.fileName };
      }
      const note = [`Tarefa: ${pkg.title}`, pkg.objective ? `Objetivo: ${pkg.objective}` : '', ref.note].filter(Boolean).join('\n');
      const item = createItem({
        kind: 'reference', source: 'package', name: ref.name, duration: buffer?.duration ?? ref.duration,
        sampleRate: buffer?.sampleRate ?? ref.sampleRate, channels: buffer?.numberOfChannels ?? ref.channels, media,
        region: ref.region, markers: ref.markers, tempo: ref.tempo, chords: ref.chords, note,
      });
      if (buffer) cacheBuffer(item.id, buffer);
      else state.missingMedia.add(item.id);
      await saveItem(item, blob ? { media: blob } : {});
      for (const exercise of pkg.exercises) {
        await saveExercise({ ...exercise, id: createId('ex'), itemId: item.id, itemName: item.name });
      }
      setStatus(`Referência “${item.name}” importada com ${item.markers.length} marcador(es) e ${pkg.exercises.length} exercício(s)${buffer ? '' : '; vincule o arquivo de áudio original'}.`, !buffer);
      await selectItem(item.id, { force: true });
    } catch (error) {
      reportError(error);
    }
  }

  async function buildPackageFile(options) {
    const item = options.includeReference ? current() : null;
    let audio = null;
    if (item && options.includeAudio) {
      if (!item.media) throw new Error('O item selecionado não tem mídia para embutir.');
      const blob = pendingMedia.get(item.media.id) ?? await store.getMedia(item.media.id);
      if (!blob) throw new Error('A mídia do item não está no armazenamento local.');
      if (blob.size > MAX_EMBEDDED_AUDIO_BYTES) throw new RangeError(`O áudio tem ${formatBytes(blob.size)}; o limite para embutir é ${formatBytes(MAX_EMBEDDED_AUDIO_BYTES)}.`);
      audio = { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: item.media.mimeType, fileName: item.media.fileName };
    }
    const pkg = createAssignmentPackage({
      title: options.title, objective: options.objective,
      session: options.includeSession ? host.getSession() : null,
      item,
      exercises: item && options.includeExercises ? state.exercises.filter(exercise => exercise.itemId === item.id) : [],
      audio,
    });
    const text = serializePackage(pkg);
    return { text, file: new File([text], `${slug(options.title)}${PACKAGE_EXTENSION}`, { type: 'application/json' }) };
  }

  function shareTab() {
    const item = current();
    const session = host.getSession();
    const content = [];

    if (item?.media) content.push(h('section', { class: 'rep-subsection' },
      h('h4', { text: 'Áudio (WAV)' }),
      h('div', { class: 'rep-row' },
        h('button', { type: 'button', disabled: !item?.media, onclick: () => exportWav(item, false), text: 'Baixar item inteiro (WAV)' }),
        h('button', { type: 'button', 'data-job': 'true', disabled: !item?.media, onclick: () => exportWav(item, true), text: item && !isIdentityProcessing(item.processing) ? `Baixar trecho a ${processingText(item.processing)} (WAV)` : 'Baixar trecho A–B (WAV)' })),
      h('p', { class: 'rep-hint', text: 'Takes e derivados já são WAV; aqui também é possível exportar o trecho com a velocidade/altura escolhidas.' })));

    const midi = state.midi;
    content.push(h('section', { class: 'rep-subsection' },
      h('h4', { text: 'MIDI (arquivo Standard MIDI)' }),
      h('p', { class: 'rep-hint', text: `Sessão atual: ${session?.notes?.length ?? 0} nota(s), ${session?.bpm ?? '?'} BPM, ${session?.meter ? `${session.meter.beats}/${session.meter.unit}` : '4/4'}${session?.progression?.chords?.length ? `, ${session.progression.chords.length} acorde(s)` : ''}. Exporta a frase (canal 1) e os acordes da progressão (canal 2); bateria e baixo gerados pelo motor não são exportados. Somente arquivos — sem MIDI ao vivo.` }),
      h('div', { class: 'rep-row' },
        h('button', { type: 'button', onclick: () => {
          try {
            download(new Blob([sessionToMidi(host.getSession())], { type: 'audio/midi' }), `${slug(session?.name || 'sessao')}.mid`);
            setStatus('MIDI da sessão exportado.');
          } catch (error) {
            reportError(error);
          }
        }, text: 'Baixar MIDI da sessão' }),
        h('button', { type: 'button', onclick: () => midiInput.click(), text: 'Importar MIDI para a sessão…' })),
      midi ? h('div', { class: 'rep-form' },
        h('p', { text: `“${midi.fileName}”: formato ${midi.parsed.format}, ${midi.parsed.tempos[0] ? `${Math.round(midi.parsed.tempos[0].bpm)} BPM` : 'sem andamento (120 BPM)'}, ${midi.parsed.timeSignatures[0] ? `${midi.parsed.timeSignatures[0].beats}/${midi.parsed.timeSignatures[0].unit}` : '4/4'}.` }),
        field('Trilha', h('select', { onchange: event => { midi.trackIndex = Number(event.target.value); } },
          midi.parsed.tracks.map((track, index) => h('option', { value: index, selected: index === midi.trackIndex, disabled: !track.notes.length },
            `${index + 1}. ${track.name || 'sem nome'} — ${track.notes.length} nota(s)${track.channels.includes(9) ? ' (bateria)' : ''}`)))),
        field('Quantização', h('select', { onchange: event => { midi.quantize = event.target.value; } },
          Object.keys(QUANTIZE_GRIDS).map(key => h('option', { value: key, selected: key === midi.quantize }, QUANTIZE_LABELS[key])))),
        h('div', { class: 'rep-row' },
          h('button', { type: 'button', class: 'primary', onclick: applyMidi, text: 'Substituir frase da sessão por esta trilha' }),
          h('button', { type: 'button', onclick: () => { state.midi = null; renderTabs(); }, text: 'Descartar' }))) : null));

    const titleInput = h('input', { type: 'text', 'data-draft': 'package-title', maxLength: 200, value: item ? `Tarefa: ${item.name}` : 'Tarefa de prática' });
    const objectiveInput = h('textarea', { rows: 3, 'data-draft': 'package-objective', maxLength: 5000, placeholder: 'Objetivo para quem recebe: o que praticar, critério de sucesso…' });
    const includeSession = h('input', { type: 'checkbox', 'data-draft': 'package-session', checked: true });
    const includeReference = h('input', { type: 'checkbox', 'data-draft': 'package-reference', checked: Boolean(item), disabled: !item });
    const audioTooBig = !item?.media || item.media.size > MAX_EMBEDDED_AUDIO_BYTES;
    const includeAudio = h('input', { type: 'checkbox', 'data-draft': 'package-audio', disabled: audioTooBig });
    const includeExercises = h('input', { type: 'checkbox', 'data-draft': 'package-exercises', checked: Boolean(item), disabled: !item });
    const options = () => ({ title: titleInput.value, objective: objectiveInput.value, includeSession: includeSession.checked, includeReference: includeReference.checked,
      includeAudio: includeAudio.checked && includeReference.checked, includeExercises: includeExercises.checked && includeReference.checked });
    const canShareFiles = typeof globalThis.navigator?.canShare === 'function' && typeof globalThis.navigator?.share === 'function';
    content.push(h('section', { class: 'rep-subsection' },
      h('h4', { text: 'Pacote de tarefa (arquivo local)' }),
      h('p', { class: 'rep-hint', text: 'Reúne sessão, objetivo, marcadores/comentários/acordes da referência e exercícios num arquivo JSON para enviar como quiser (e-mail, mensageiro, pendrive). Nada passa por servidor do GrooveGoblin.' }),
      h('div', { class: 'rep-form' },
        field('Título', titleInput), field('Objetivo', objectiveInput),
        h('label', { class: 'toggle' }, includeSession, 'Incluir a sessão atual do estúdio'),
        h('label', { class: 'toggle' }, includeReference, item ? `Incluir “${item.name}” como referência (marcadores, comentários, acordes, andamento)` : 'Incluir referência (selecione um item)'),
        h('label', { class: 'toggle' }, includeAudio, item?.media ? `Embutir o áudio (${formatBytes(item.media.size)}${audioTooBig ? `, acima do limite de ${formatBytes(MAX_EMBEDDED_AUDIO_BYTES)}` : ''})` : 'Embutir o áudio (item sem mídia)'),
        h('label', { class: 'toggle' }, includeExercises, 'Incluir os exercícios desta referência'),
        h('div', { class: 'rep-row' },
          h('button', { type: 'button', class: 'primary', onclick: async () => {
            try {
              const { file } = await buildPackageFile(options());
              download(file, file.name);
              setStatus(`Pacote “${file.name}” (${formatBytes(file.size)}) baixado.`);
            } catch (error) {
              reportError(error);
            }
          }, text: 'Baixar pacote' }),
          canShareFiles ? h('button', { type: 'button', onclick: async () => {
            try {
              const { file } = await buildPackageFile(options());
              if (!navigator.canShare({ files: [file] })) throw new Error('Este navegador não compartilha este tipo de arquivo; use “Baixar pacote”.');
              await navigator.share({ files: [file], title: options().title });
              setStatus('Pacote entregue ao compartilhamento do sistema.');
            } catch (error) {
              if (error?.name !== 'AbortError') reportError(error);
            }
          }, text: 'Compartilhar…' }) : null,
          globalThis.navigator?.clipboard?.writeText ? h('button', { type: 'button', onclick: async () => {
            try {
              const chosen = options();
              if (chosen.includeAudio) throw new Error('Para copiar como texto, desmarque “Embutir o áudio”.');
              const { text } = await buildPackageFile(chosen);
              await navigator.clipboard.writeText(text);
              setStatus(`Pacote copiado (${formatBytes(text.length)} de texto).`);
            } catch (error) {
              reportError(error);
            }
          }, text: 'Copiar como texto' }) : null))));

    const pkg = state.pendingPackage;
    if (pkg) {
      content.push(h('section', { class: 'rep-subsection rep-package' },
        h('h4', { text: `Pacote recebido: ${pkg.title}` }),
        pkg.objective ? h('p', { text: pkg.objective }) : null,
        h('ul', {},
          h('li', { text: pkg.session ? 'Contém uma sessão do estúdio.' : 'Sem sessão.' }),
          h('li', { text: pkg.reference ? `Referência “${pkg.reference.name}” (${formatTime(pkg.reference.duration)}), ${pkg.reference.markers.length} marcador(es), ${pkg.reference.chords.length} acorde(s) anotados.` : 'Sem referência.' }),
          h('li', { text: pkg.audio ? `Áudio embutido: ${formatBytes(pkg.audio.bytes.length)}.` : 'Sem áudio embutido: vincule o arquivo original depois de importar.' }),
          h('li', { text: `${pkg.exercises.length} exercício(s).` })),
        h('div', { class: 'rep-row' },
          pkg.reference ? h('button', { type: 'button', class: 'primary', onclick: () => importPackageReference(pkg), text: 'Importar referência e exercícios' }) : null,
          pkg.session ? h('button', { type: 'button', onclick: async () => {
            try {
              const result = await validated(pkg.session);
              if (!result.ok) throw new Error(`A sessão do pacote é inválida: ${result.error}`);
              host.replaceSession(result.session);
              setStatus('Sessão do pacote aplicada ao estúdio.');
              host.notify('Sessão do pacote aplicada ao estúdio.');
            } catch (error) {
              reportError(error);
            }
          }, text: 'Aplicar sessão ao estúdio' }) : null,
          h('button', { type: 'button', onclick: () => { state.pendingPackage = null; renderTabs(); }, text: 'Descartar pacote' }))));
    }
    content.push(h('div', { class: 'rep-row' }, h('button', { type: 'button', onclick: () => packageInput.click(), text: 'Abrir pacote…' })));
    return content;
  }

  function onDrop(event) {
    root.classList.remove('rep-dropping');
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    track(importAudioFiles(files));
  }

  // ---------- API pública ----------
  function render() {
    if (destroyed) return;
    renderLibrary();
    refreshLab();
    if (!(tabPanel.contains(document.activeElement) && isTyping(document.activeElement))) renderTabs();
    draw();
  }

  function destroy() {
    if (destroyed) return;
    stop();
    destroyed = true;
    jobs.dispose();
    resizeObserver?.disconnect();
    clearTimeout(deleteTimer);
    player.close().catch(() => {});
    buffers.clear();
    processedCache.clear();
    container.replaceChildren();
  }

  // Ocupado = algo tocando, processando no worker ou importando/renderizando/gravando.
  // A UI usa para não recarregar (ex.: atualização offline) no meio do trabalho.
  function isBusy() {
    return !destroyed && (player.playing || jobs.busy || pendingWork > 0);
  }

  return {
    render,
    captureTake: (attempts, detail) => track(captureTake(attempts, detail)),
    stop,
    isBusy,
    get isPlaying() { return !destroyed && player.playing; },
    destroy,
  };
}
