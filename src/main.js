import { GrooveAudio, renderSession } from './audio.js';
import { createSession, loadSession, saveSession, validateSession, serializeSession, parseSession, encodeSessionLink, decodeSessionLink, ticksPerBar as barTicks, DENSITIES, METRONOME_PATTERNS, ARTICULATIONS } from './session.js';
import { evaluateSession, summarizeFeedback } from './feedback.js';
import { buildTimelineData, renderTimeline } from './timeline.js';
import { GROOVES, loadGroove } from './library.js';
import { getDiatonicChords, invertChord } from './progression.js';
import { mountPractice } from './practice.js';
import { mountPlayground } from './playground.js';
import { mountJourney } from './practice-view.js';
import { mountRepertoire } from './repertoire-view.js';
import { setupOffline } from './offline.js';
import { mountTour } from './tour.js';
import { mergeSession, readSessionLibrary, SESSION_LIBRARY_KEY } from './studio-state.js';
import { History } from './history.js';
import { updateNote, deleteNote } from './model.js';
import { FORM_KINDS, FORM_LABELS, FORM_DESCRIPTIONS } from './form.js';
import { EVALUATION_MODES, EVALUATION_MODE_LABELS, GOALS, GOAL_LABELS } from './session.js';
import { generateGroove } from './generator.js';
import { mountStudio } from './studio.js';
import { mountStudioTransport } from './studio-transport.js';
import { mountStudioTimeline } from './studio-timeline.js';
import { mountStudioInspector } from './studio-inspector.js';
import { mountStudioNotices } from './studio-notices.js';
import { fitHarmony } from './studio-harmony.js';

const $ = id => document.getElementById(id);
const restored = loadSession();
let session = withStudioChoices(initialStudioSession(restored));
let recoveryRaw = restored.recoveryRaw;
let sessionSaved = false;
let selected = null;
// Exactly one editor selection; indices refer to canonical progression.chords.
function noteSelection() { return selected?.kind === 'note' ? selected.id : null; }
function chordSelection() { return selected?.kind === 'chord' ? selected.index : null; }
function setNoteSelection(id) { selected = id === null ? null : { kind: 'note', id }; }
function setChordSelection(index) { selected = index === null ? null : { kind: 'chord', index }; }
let activeInput = null;
let generation = 0;
let pending = null;
let sharedSession = null;
let results = null;
let reference = null;
let lastMode = 'idle';
let executionSession = null;
let exercisePlayback = false;
let executionMode = null;
let repertoire;
let practice;
let playground;
let journey;
let lastRepertoireBusy = false;
const history = new History();
const library = readSessionLibrary(undefined, parseSession);
const notices = mountStudioNotices({ isBusy: busy, canUndo: () => history.canUndo, current: () => history.current, undo: () => travelHistory('undo') });
const audio = new GrooveAudio({ onState: () => renderControls(), onFinish: (attempts, detail) => {
  clearInput();
  const focusResult = $('tab-practice').getAttribute('aria-selected') === 'true'
    && (document.activeElement === $('train-pad') || document.activeElement === document.body);
  reference = detail.session;
  results = detail.results ?? evaluateSession(reference, attempts);
  renderFeedback();
  practice?.onFinish(attempts, { ...detail, session: reference, results });
  playground?.onFinish(attempts, { ...detail, session: reference, results });
  journey?.render();
  void saveTake(attempts, { ...detail, session: reference, results }).catch(error => message(`Treino concluído; não foi possível guardar a tomada: ${error.message}`, true));
  $('train-state').textContent = 'Treino concluído. Veja seu resultado e repita quando quiser.';
  renderControls();
  if (focusResult) {
    const summary = $('practice-results') ?? $('feedback-detail').querySelector('summary');
    summary.focus({ preventScroll: true });
    summary.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
} });

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}
function busy() { return pending !== null || audio.position.mode !== 'idle'; }
function persist() {
  sessionSaved = recoveryRaw === null && saveSession(session);
  $('saved').textContent = recoveryRaw !== null ? 'Só na memória · originais protegidos'
    : sessionSaved ? 'Sessão salva neste navegador' : 'Só na memória · exporte para guardar';
}
function withStudioChoices(value) {
  const studio = value.extensions?.studio ?? {};
  return mergeSession(value, { extensions: { studio: {
    ...studio,
    generator: { seed: 0, density: 'medium', syncopation: 'mixed', lengths: 'mixed', ...studio.generator },
    inputPitch: studio.inputPitch ?? 69,
    performanceFocus: studio.performanceFocus ?? false,
    progressionFunction: studio.progressionFunction ?? 'cadence',
  } } });
}
function createStudioSession() {
  return createSession({ bars: 4, loop: { startBar: 0, endBar: 4 }, progression: { cycleBars: 4 } });
}
function initialStudioSession(restored) {
  try {
    if (restored.recoveryRaw === null && !localStorage.getItem('groovegoblin.session.v2') && !localStorage.getItem('groovegoblin.v1')) {
      return mergeSession(restored.session, { bars: 4, loop: { startBar: 0, endBar: 4 }, progression: { cycleBars: 4 } });
    }
  } catch { /* Preserve loadSession's recovery and storage-unavailable behavior. */ }
  return restored.session;
}
function liveChoice(key) {
  return ['mixer', 'metronome', 'band', 'drums', 'timbres'].includes(key) || (key === 'bpm' && audio.position.mode === 'loop');
}
function updateSession(patch, { notice = null } = {}) {
  const live = !exercisePlayback && pending === null && audio.position.mode !== 'idle' && Object.keys(patch).every(liveChoice);
  const applied = replaceSession(mergeSession(session, patch), { stopPlayback: !live, notice, resetEmpty: false });
  if (applied && live) audio.updateSession(session);
  return applied;
}
function replaceSession(value, { record = true, stopPlayback = true, notice = 'Sessão substituída.', resetEmpty = true } = {}) {
  const checked = validateSession(withStudioChoices(value));
  if (!checked.ok) { message(`Alteração rejeitada: ${checked.error}`, true); renderControls(); return false; }
  if (stopPlayback) stop();
  session = checked.session;
  const previousEntry = history.current;
  if (record) history.push(session);
  if (resetEmpty) inspector.resetEmpty();
  if (history.current !== previousEntry) notices.changed(history.current, record ? notice : null);
  if ((selected?.kind === 'note' && !session.notes.some(note => note.id === selected.id))
    || (selected?.kind === 'chord' && !session.progression.chords[selected.index])) selected = null;
  audio.setMixer(session.mixer);
  persist();
  renderAll();
  notices.render();
  return true;
}
function renderAll() {
  renderControls(); studioTimeline.render(); renderForm(); renderFeedback();
  practice?.render(); playground?.render(); journey?.render(); repertoire?.render();
}
function stop(reason) {
  ++generation;
  pending = null;
  const wasDragging = studioTimeline.cancelDrag();
  audio.stop();
  audio.setMixer(session.mixer);
  executionSession = null;
  exercisePlayback = false;
  executionMode = null;
  clearInput();
  if (wasDragging) studioTimeline.renderNotes();
  renderControls();
  if (reason) message(reason);
}
async function begin(mode = 'loop', practiceSession = null) {
  repertoire?.stop();
  stop();
  const request = ++generation;
  if (mode === 'train') {
    studio.activate($('tab-practice'));
    if (!practiceSession) practice.useSession();
  }
  pending = 'play';
  executionMode = mode;
  renderControls();
  const snapshot = structuredClone(practiceSession ?? session);
  executionSession = snapshot;
  exercisePlayback = practiceSession !== null;
  if (mode === 'train') { results = null; reference = null; renderFeedback(); }
  try {
    await audio.playSession(snapshot, { mode });
    if (request !== generation) return;
    if (mode === 'train') {
      $('train-pad').focus({ preventScroll: true });
      $('train-pad').scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    message(mode === 'train' ? 'Depois da contagem, toque com Espaço ou na área de toque. Não usamos microfone.' : snapshot.form.enabled ? 'Forma musical em reprodução.' : 'Acompanhamento em loop.');
  } catch (error) {
    if (request === generation) { audio.stop(); message(`Não foi possível iniciar: ${error.message}`, true); }
    throw error;
  } finally {
    if (request === generation) { pending = null; renderControls(); }
  }
}
async function preview(notes, options = {}) {
  repertoire?.stop();
  stop();
  const request = ++generation;
  pending = 'preview'; renderControls();
  try {
    const completed = await audio.preview(notes, options);
    return request === generation ? completed : false;
  }
  finally { if (request === generation) { pending = null; renderControls(); } }
}
async function saveTake(attempts, detail) { return repertoire.captureTake(attempts, detail); }
const host = {
  getSession: () => structuredClone(session), updateSession, replaceSession, play: begin, stop, notify: message, preview, saveTake, renderSession,
  isBusy: busy,
};

const studio = mountStudio({ onActivate: id => {
  if (id !== 'tab-repertoire') repertoire?.stop();
  renderControls();
} });
const transport = mountStudioTransport({
  getState: () => ({
    active: busy() || !!repertoire?.isBusy(), locked: busy(),
    training: ['countin', 'train'].includes(audio.position.mode) || (pending === 'play' && executionMode === 'train'),
    canUndo: history.canUndo, canRedo: history.canRedo,
  }),
  play: () => void begin().catch(() => {}),
  stop: () => { if (practice) practice.cancel(); else stop(); repertoire?.stop(); renderControls(); message('Som interrompido.'); },
  travelHistory, removeSelected, deselect: deselectEditor,
});
const inspector = mountStudioInspector({ getSession: () => session, getSelection: () => selected, isBusy: busy, commitNote, notify: message });
const studioTimeline = mountStudioTimeline($('studio-editor'), {
  getSession: () => session, isBusy: busy, updateSession,
  getSelection: noteSelection, setSelection: setNoteSelection,
  getChordSelection: chordSelection, setChordSelection,
  getEditorSelection: () => selected, setEditorSelection: value => { selected = value; },
  selectionChanged: () => { renderControls(); studioTimeline.renderSelection(); }, commitNote, notify: message,
});
function deselectEditor() {
  if (!selected) return;
  const lane = selected.kind === 'note' ? $('grid') : $('chord-lane');
  if (lane.contains(document.activeElement)) lane.focus({ preventScroll: true });
  selected = null;
  renderControls(); studioTimeline.renderSelection();
}
for (const id of ['bass-lane', 'drum-lanes', 'beat-labels']) $(id).addEventListener('click', deselectEditor);
$('minimal').addEventListener('change', event => {
  session = mergeSession(session, { extensions: { studio: { performanceFocus: event.target.checked } } });
  document.body.classList.toggle('performance-focus', event.target.checked); persist();
  notices.changed(null);
});
function fillOptions(select, values, labels) {
  select.replaceChildren();
  for (const value of values) {
    const option = document.createElement('option'); option.value = value; option.textContent = labels[value] ?? value; select.append(option);
  }
}
const densityLabels = { sparse: 'Poucas notas', medium: 'Média', busy: 'Muitas notas' };
const metroLabels = { quarters: 'Semínimas', backbeat: 'Backbeat · 2 e 4', offbeats: 'Contratempos', subdivisions: 'Subdivisões da grade', downbeats: 'Início de compasso' };
const articulationLabels = { normal: 'Normal', accent: 'Acento', ghost: 'Fantasma', staccato: 'Staccato', tenuto: 'Tenuto', legato: 'Legato' };
fillOptions($('training-evaluation'), EVALUATION_MODES, EVALUATION_MODE_LABELS);
fillOptions($('training-goal'), GOALS, GOAL_LABELS);
fillOptions($('metro-pattern'), METRONOME_PATTERNS, metroLabels);
fillOptions($('note-articulation'), ARTICULATIONS, articulationLabels);
for (const input of document.querySelectorAll('[data-path^="generator."]')) input.dataset.path = `extensions.studio.${input.dataset.path}`;
$('progression-function').dataset.path = 'extensions.studio.progressionFunction';
$('input-pitch').addEventListener('change', event => {
  if (event.target.value === '' || !event.target.checkValidity()) { event.target.value = session.extensions.studio.inputPitch; message('Escolha uma altura MIDI entre 21 e 108.', true); return; }
  session = mergeSession(session, { extensions: { studio: { inputPitch: Number(event.target.value) } } });
  persist();
  notices.changed(null);
});

const numericPaths = new Set(['bpm', 'bars', 'meter.beats', 'meter.unit', 'subdivision', 'swing', 'loop.endBar', 'extensions.studio.generator.seed', 'drums.seed', 'metronome.audibleBars', 'metronome.silentBars', 'training.countInBars', 'training.repetitions', 'companion.pulses', 'companion.spanBeats']);
const getPath = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
function pathPatch(path, value) { return path.split('.').reverse().reduce((patch, key) => ({ [key]: patch }), value); }
for (const input of document.querySelectorAll('[data-path]')) {
  input.addEventListener('change', () => {
    if (!input.checkValidity()) { message('Valor fora dos limites permitidos. Confira o campo e tente novamente.', true); renderControls(); return; }
    const path = input.dataset.path;
    const value = input.type === 'checkbox' ? input.checked : numericPaths.has(path) ? Number(input.value) : input.value;
    let patch = pathPatch(path, value);
    if (path === 'bars') {
      patch = mergeSession(patch, { loop: { endBar: value, startBar: Math.min(session.loop.startBar, value - 1) } });
      if (!session.progression.chords.length) patch.progression = { ...session.progression, cycleBars: value };
    }
    if (path === 'progression.keyId') {
      const chords = getDiatonicChords(value);
      patch.progression.cycleBars = session.progression.cycleBars;
      patch.progression.chords = session.progression.chords.map(chord => chord.source !== 'diatonic' ? chord : invertChord({ ...chords[(chord.degree ?? 1) - 1], startBar: chord.startBar, durationBars: chord.durationBars }, chord.inversion));
    }
    const notice = ['drums.style', 'drums.density', 'drums.seed'].includes(path) ? 'Padrão da bateria substituído.' : path === 'progression.keyId' ? 'Tom e acordes diatônicos atualizados.' : null;
    updateSession(patch, { notice });
  });
}
$('loop-start').addEventListener('change', event => updateSession({ loop: { startBar: Number(event.target.value) - 1 } }));

function renderControls() {
  const locked = busy();
  for (const input of document.querySelectorAll('[data-path]')) {
    const value = getPath(session, input.dataset.path);
    if (input.type === 'checkbox') input.checked = !!value; else input.value = value ?? '';
    input.disabled = locked && !(pending === null && liveChoice(input.dataset.path.split('.')[0]));
  }
  $('input-pitch').value = session.extensions.studio.inputPitch;
  $('minimal').checked = !!session.extensions.studio.performanceFocus;
  document.body.classList.toggle('performance-focus', $('minimal').checked);
  $('loop-start').value = session.loop.startBar + 1;
  $('loop-start').max = session.bars;
  $('loop-end').max = session.bars;
  $('loop-start').disabled = locked;
  $('practice-session-title').textContent = session.name;
  $('session-badge').textContent = `${session.meter.beats}/${session.meter.unit} · ${session.bars} comp. · loop ${session.loop.startBar + 1}–${session.loop.endBar}`;
  transport.render();
  $('train').disabled = pending !== null || (session.training.evaluation !== 'free' && !session.notes.some(note => note.start >= session.loop.startBar * barTicks(session) && note.start < session.loop.endBar * barTicks(session)));
  $('train-pad').disabled = !['countin', 'train'].includes(audio.position.mode);
  $('clear').disabled = locked || session.notes.length === 0;
  for (const id of ['generate', 'variation', 'load-groove', 'generate-drums', 'generate-progression', 'new-session', 'duplicate-session', 'save-session', 'restore-session', 'delete-session', 'replace-recovery', 'replace-library-recovery', 'apply-share']) $(id).disabled = locked;
  $('load-groove').disabled ||= !$('groove-library').value;
  $('restore-session').disabled ||= !$('session-library').value;
  $('delete-session').disabled ||= !$('session-library').value;
  $('apply-share').disabled ||= !sharedSession;
  inspector.render();
  studioTimeline.renderControls();
  $('add-section').disabled = locked || session.form.sections.length >= 32;
  for (const input of document.querySelectorAll('#form-sections input, #form-sections select, #form-sections button')) input.disabled = locked || input.dataset.boundary === 'true';
  practice?.setBusy(locked);
  notices.render();
  for (const input of document.querySelectorAll('#panel-studio button, #panel-studio input, #panel-studio select, #phrase-tools-dialog button, #phrase-tools-dialog input, #phrase-tools-dialog select')) {
    if (input.id.startsWith('note-') || ['undo', 'redo', 'fit-progression'].includes(input.id)) continue;
    if (!input.disabled) {
      if (Object.hasOwn(input.dataset, 'enabledTitle')) { input.title = input.dataset.enabledTitle; delete input.dataset.enabledTitle; }
      continue;
    }
    input.dataset.enabledTitle ??= input.title;
    input.title = locked ? 'Pare a reprodução antes de fazer esta alteração' : input.id === 'clear' || input.id === 'transpose-phrase' ? 'A frase está vazia; escreva ou carregue notas primeiro' : ['restore-session', 'delete-session'].includes(input.id) ? 'Escolha uma sessão guardada primeiro' : input.id === 'add-section' ? 'A forma já tem o limite de 32 seções' : input.dataset.boundary === 'true' ? 'A seção já está no limite desta direção' : input.title || 'Selecione um item para usar esta ação';
  }
}

function renderForm() {
  const list = $('form-sections');
  list.replaceChildren();
  const change = (index, patch) => {
    const applied = updateSession({ form: { sections: session.form.sections.map((section, i) => i === index ? { ...section, ...patch } : section) } });
    if (!applied) renderForm();
  };
  for (const [index, section] of session.form.sections.entries()) {
    const row = document.createElement('li'); row.dataset.sectionId = section.id;
    const fields = document.createElement('div'); fields.className = 'tool-row';
    const field = (text, control) => {
      const label = document.createElement('label'); label.append(document.createTextNode(text), control); fields.append(label); return control;
    };
    const text = document.createElement('input'); text.value = section.name; text.maxLength = 80;
    text.addEventListener('change', () => change(index, { name: text.value })); field('Nome', text);
    const kind = document.createElement('select'); fillOptions(kind, FORM_KINDS, FORM_LABELS); kind.value = section.kind;
    kind.addEventListener('change', () => change(index, { kind: kind.value })); field('Tipo e papel', kind);
    const number = (label, value, min, max, apply, optional = false) => {
      const input = document.createElement('input'); input.type = 'number'; input.min = min; input.max = max; input.step = 1;
      input.value = value ?? ''; input.required = !optional; if (optional) input.placeholder = 'Herdar';
      input.addEventListener('change', () => {
        if (!input.reportValidity()) return;
        apply(input.value === '' ? null : Number(input.value));
      });
      return field(label, input);
    };
    number('Fonte: primeiro compasso', section.startBar + 1, 1, session.bars, value => change(index, { startBar: value - 1 }));
    number('Fonte: último compasso', section.endBar, 1, session.bars, value => change(index, { endBar: value }));
    number('Repetições', section.repeats, 1, 16, value => change(index, { repeats: value }));
    number('BPM (semínimas)', section.bpm, 30, 300, value => change(index, { bpm: value }), true);
    number('Tempos (vazio = herdar)', section.meter?.beats, 1, 16, value => change(index, { meter: value === null ? null : { beats: value, unit: section.meter?.unit ?? session.meter.unit } }), true);
    const unit = document.createElement('select'); fillOptions(unit, ['', 2, 4, 8, 16], { '': 'Herdar', 2: '/2', 4: '/4', 8: '/8', 16: '/16' }); unit.value = section.meter?.unit ?? '';
    unit.addEventListener('change', () => change(index, { meter: unit.value === '' ? null : { beats: section.meter?.beats ?? session.meter.beats, unit: Number(unit.value) } })); field('Unidade', unit);
    const density = document.createElement('select'); fillOptions(density, ['', ...DENSITIES], { '': 'Herdar', ...densityLabels }); density.value = section.density ?? '';
    density.addEventListener('change', () => change(index, { density: density.value || null })); field('Densidade da banda', density);
    const button = (label, action, boundary = false) => {
      const button = document.createElement('button'); button.textContent = label; button.type = 'button'; button.dataset.boundary = String(boundary);
      button.disabled = busy() || boundary; button.addEventListener('click', action); fields.append(button);
    };
    const move = delta => {
      const sections = [...session.form.sections]; [sections[index], sections[index + delta]] = [sections[index + delta], sections[index]];
      updateSession({ form: { sections } });
      const moved = [...list.children].find(item => item.dataset.sectionId === section.id);
      moved?.querySelector('input')?.focus();
    };
    button('Mover acima', () => move(-1), index === 0);
    button('Mover abaixo', () => move(1), index === session.form.sections.length - 1);
    button('Excluir seção', () => {
      const sections = session.form.sections.filter((_, i) => i !== index);
      updateSession({ form: { sections, enabled: session.form.enabled && sections.length > 0 } });
    });
    const description = document.createElement('p'); description.className = 'tool-hint muted'; description.textContent = FORM_DESCRIPTIONS[section.kind];
    row.append(fields, description); list.append(row);
  }
  for (const control of list.querySelectorAll('input, select')) control.disabled = busy();
}
$('add-section').addEventListener('click', () => {
  const section = { id: crypto.randomUUID(), name: `Seção ${session.form.sections.length + 1}`, kind: 'A', startBar: session.loop.startBar, endBar: session.loop.endBar, repeats: 1, bpm: null, meter: null, density: null };
  updateSession({ form: { sections: [...session.form.sections, section] } });
});
function commitNote(patch) {
  if (busy() || !noteSelection()) return;
  const notes = updateNote(session.notes, noteSelection(), patch, session);
  if (notes === session.notes) { message('Sem sobreposição e sem ultrapassar o fim da frase.', true); renderControls(); return; }
  updateSession({ notes });
}
const phraseDialog = $('phrase-tools-dialog');
let phraseDialogFocus = null;
function openPhraseTools(focusId = 'groove-library') {
  if (busy()) return;
  phraseDialogFocus = document.activeElement;
  $('phrase-options').open = false;
  phraseDialog.showModal(); $(focusId).focus();
}
$('open-pattern').addEventListener('click', () => openPhraseTools());
$('open-phrase-tools').addEventListener('click', () => openPhraseTools('density'));
$('phrase-tools-close').addEventListener('click', () => phraseDialog.close());
phraseDialog.addEventListener('close', () => { phraseDialogFocus?.focus({ preventScroll: true }); phraseDialogFocus = null; });
function removeSelected() {
  if (busy()) return;
  if (selected?.kind === 'chord') studioTimeline.removeChord();
  else if (noteSelection()) updateSession({ notes: deleteNote(session.notes, noteSelection()) });
}
$('delete').addEventListener('click', removeSelected);
$('clear').addEventListener('click', () => { if (!busy()) updateSession({ notes: [] }, { notice: 'Frase limpa.' }); });
$('transpose-phrase').addEventListener('click', () => {
  if (busy()) return;
  const input = $('transpose-semitones');
  if (input.value === '' || !input.checkValidity()) { message('Informe uma transposição inteira entre −24 e +24 semitons.', true); return; }
  const shift = Number(input.value);
  if (updateSession({ notes: session.notes.map(note => ({ ...note, pitch: note.pitch + shift })) })) message(`Frase transposta em ${shift > 0 ? '+' : ''}${shift} semitons.`);
});
function travelHistory(direction) {
  if (busy()) return;
  const value = history[direction](); if (value) replaceSession(value, { record: false });
}
$('train').addEventListener('click', () => practice.useSession({ train: true }));

// Entradas de treino usam o relógio do evento, nunca um segundo transporte.
function clearInput() {
  const input = activeInput; activeInput = null;
  if (input?.source === 'pointer' && $('train-pad').hasPointerCapture(input.id)) $('train-pad').releasePointerCapture(input.id);
}
$('train-pad').addEventListener('pointerdown', event => {
  if (event.button !== 0 || activeInput || !['countin', 'train'].includes(audio.position.mode)) return;
  event.preventDefault(); activeInput = { source: 'pointer', id: event.pointerId };
  $('train-pad').setPointerCapture(event.pointerId); audio.press(event.timeStamp, Number($('input-pitch').value));
});
$('train-pad').addEventListener('pointerup', event => {
  if (activeInput?.source !== 'pointer' || activeInput.id !== event.pointerId) return;
  audio.release(event.timeStamp); clearInput();
});
for (const type of ['pointercancel', 'lostpointercapture']) $('train-pad').addEventListener(type, event => {
  if (activeInput?.source === 'pointer' && activeInput.id === event.pointerId) stop('Toque cancelado; recomece o treino.');
});
window.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.key === 'Escape' || document.querySelector('dialog[open], [role=dialog][aria-modal=true]')) return;
  const editing = event.target instanceof Element && (event.target.isContentEditable || !!event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable=false])'));
  if (editing) return;
  if (event.code === 'Space' && pending === 'play' && executionMode === 'train') { event.preventDefault(); return; }
  if ((event.code === 'Space' || (event.code === 'Enter' && event.target === $('train-pad'))) && ['countin', 'train'].includes(audio.position.mode)) {
    event.preventDefault(); if (!event.repeat && !activeInput) { activeInput = { source: 'keyboard', id: event.code }; audio.press(event.timeStamp, Number($('input-pitch').value)); } return;
  }
});
window.addEventListener('keyup', event => {
  if (activeInput?.source !== 'keyboard' || activeInput.id !== event.code) return;
  event.preventDefault(); audio.release(event.timeStamp); clearInput();
});
window.addEventListener('blur', () => { if (busy()) stop('Sessão interrompida ao perder o foco.'); repertoire.stop(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); repertoire.stop(); } });

for (const groove of GROOVES) {
  for (const id of ['groove-library', 'empty-pattern']) {
    const option = document.createElement('option'); option.value = groove.id; option.textContent = groove.name; $(id).append(option);
  }
}
function describePattern(value) {
  const groove = GROOVES.find(item => item.id === value);
  $('groove-library').value = $('empty-pattern').value = value;
  $('groove-description').textContent = $('empty-pattern-description').textContent = groove?.description ?? '';
  $('groove-details').replaceChildren();
  if (groove) {
    const detail = document.createElement('p'); detail.textContent = groove.durationNote; $('groove-details').append(detail);
    for (const source of groove.sources) { const link = document.createElement('a'); link.href = source.url; link.textContent = source.title; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('groove-details').append(link); }
  }
  renderControls();
}
for (const id of ['groove-library', 'empty-pattern']) $(id).addEventListener('change', event => describePattern(event.target.value));
function loadPattern() {
  if (busy()) return;
  const groove = loadGroove($('groove-library').value);
  if (updateSession({ ...groove, loop: { startBar: 0, endBar: groove.bars } }, { notice: 'Padrão carregado na frase. Acordes preservados.' })) phraseDialog.close();
}
$('load-groove').addEventListener('click', loadPattern);
$('start-pattern').addEventListener('click', loadPattern);
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
function generate(variation) {
  if (busy()) return;
  const options = { ...session.extensions.studio.generator, seed: variation ? newSeed() : Number($('seed').value) };
  try {
    const generated = generateGroove({ ...options, bars: session.bars, meter: session.meter, subdivision: session.subdivision });
    if (updateSession({ notes: generated.notes, extensions: { studio: { generator: options } } }, { notice: 'Frase gerada.' })) phraseDialog.close();
  }
  catch (error) { message(error.message, true); }
}
$('generate').addEventListener('click', () => generate(false)); $('variation').addEventListener('click', () => generate(true));
$('generate-phrase').addEventListener('click', () => generate(true));
$('empty-generate').addEventListener('click', () => generate(true));
function startBand(full) {
  if (busy()) return;
  const patch = { drums: { enabled: true, style: 'pop', density: 'medium', seed: 1 }, band: { bassEnabled: true, style: 'pop', density: 'medium', role: 'solo', mode: 'steady' }, mixer: { drums: { muted: false }, bass: { muted: false } } };
  if (full) {
    patch.progression = { enabled: true };
    patch.mixer.chords = { muted: false };
    if (!session.progression.chords.length) patch.progression = { enabled: true, cycleBars: session.bars, chords: fitHarmony([1, 4, 5, 1].map(degree => getDiatonicChords(session.progression.keyId)[degree - 1]), session) };
  }
  updateSession(patch, { notice: full ? 'Banda completa ligada. Progressão existente preservada; acordes padrão criados apenas se estava vazia.' : 'Bateria e baixo ligados no estilo Pop. Frase e acordes preservados.' });
}
$('start-band').addEventListener('click', () => startBand(false));
$('start-full-band').addEventListener('click', () => startBand(true));



function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export').addEventListener('click', () => download(serializeSession(session), 'groovegoblin-sessao.json'));
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  stop(); repertoire.stop(); const request = ++generation; pending = 'import'; renderControls();
  try {
    const text = await file.text(); if (request !== generation) return;
    const imported = parseSession(text); if (request !== generation) return;
    pending = null;
    replaceSession(imported, { notice: 'Sessão inteira importada.' });
  } catch (error) { if (request === generation) message(`Importação rejeitada: ${error.message}. Sessão preservada.`, true); }
  finally { if (request === generation) { pending = null; renderControls(); } }
});
$('share').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}${location.search}${encodeSessionLink(session)}`;
  $('share-url').value = url; $('share-output').hidden = false; $('share-url').focus(); $('share-url').select();
  try { await navigator.clipboard.writeText(url); message('Link da sessão copiado, sem servidor.'); }
  catch { message('Copie o link selecionado.'); }
});
function previewShare() {
  sharedSession = null; $('share-preview').hidden = true;
  if (!location.hash) return;
  try { sharedSession = decodeSessionLink(location.hash); $('share-description').textContent = `${sharedSession.name} · ${sharedSession.bpm} BPM · ${sharedSession.bars} compassos · ${sharedSession.meter.beats}/${sharedSession.meter.unit}`; $('share-preview').hidden = false; }
  catch (error) { message(`Link inválido: ${error.message}. Sua sessão foi preservada.`, true); }
  renderControls();
}
function dismissShare() { sharedSession = null; $('share-preview').hidden = true; window.history.replaceState(null, '', `${location.pathname}${location.search}`); renderControls(); }
$('apply-share').addEventListener('click', () => { if (sharedSession && replaceSession(sharedSession, { notice: 'Sessão recebida aplicada.' })) dismissShare(); });
$('dismiss-share').addEventListener('click', dismissShare); window.addEventListener('hashchange', previewShare);
$('download-recovery').addEventListener('click', () => { if (recoveryRaw !== null) download(recoveryRaw, 'groovegoblin-originais.json'); });
$('replace-recovery').addEventListener('click', () => {
  if (busy()) return;
  if (!saveSession(session)) { message('Armazenamento indisponível; originais preservados.', true); return; }
  recoveryRaw = null; $('recovery').hidden = true; persist();
});
function renderLibrary() {
  const previous = $('session-library').value; $('session-library').replaceChildren();
  const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Escolha uma sessão'; $('session-library').append(empty);
  for (const item of library.entries) { const option = document.createElement('option'); option.value = item.id; option.textContent = `${item.session.name} · ${item.session.bpm} BPM · ${new Date(item.savedAt).toLocaleDateString('pt-BR')}`; $('session-library').append(option); }
  $('session-library').value = previous;
  $('library-status').textContent = library.warning ?? `${library.entries.length} sessões guardadas neste navegador.`;
  $('library-recovery').hidden = library.recoveryRaw === null;
}
function writeLibrary(entries) {
  if (library.recoveryRaw !== null) { message(library.warning, true); return false; }
  try { localStorage.setItem(SESSION_LIBRARY_KEY, JSON.stringify(entries)); library.entries = entries; library.warning = null; renderLibrary(); renderControls(); return true; }
  catch { message('Biblioteca não pôde ser salva. Exporte a sessão.', true); return false; }
}
$('new-session').addEventListener('click', () => {
  if (!busy()) replaceSession(createStudioSession(), { notice: 'Nova sessão de quatro compassos criada.' });
});
$('duplicate-session').addEventListener('click', () => {
  if (busy()) return;
  const copy = mergeSession(session, { name: `${session.name.slice(0, 112)} · cópia` });
  const item = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), session: copy };
  if (writeLibrary([...library.entries, item]) && replaceSession(copy, { notice: 'Cópia guardada na biblioteca e aberta.' })) {
    $('session-library').value = item.id; renderControls();
  }
});
$('save-session').addEventListener('click', () => {
  if (busy()) return;
  const item = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), session: structuredClone(session) };
  if (writeLibrary([...library.entries, item])) { $('session-library').value = item.id; renderControls(); message('Sessão completa guardada na biblioteca.'); }
});
$('session-library').addEventListener('change', renderControls);
$('restore-session').addEventListener('click', () => { const item = library.entries.find(entry => entry.id === $('session-library').value); if (item && !busy()) replaceSession(item.session, { notice: 'Sessão guardada aberta.' }); });
$('delete-session').addEventListener('click', () => writeLibrary(library.entries.filter(entry => entry.id !== $('session-library').value)));
$('download-library-recovery').addEventListener('click', () => { if (library.recoveryRaw !== null) download(library.recoveryRaw, 'groovegoblin-biblioteca-original.json'); });
$('replace-library-recovery').addEventListener('click', () => {
  if (busy()) return;
  const original = library.recoveryRaw; library.recoveryRaw = null;
  if (!writeLibrary([{ id: crypto.randomUUID(), savedAt: new Date().toISOString(), session: structuredClone(session) }])) library.recoveryRaw = original;
  renderLibrary();
});

function renderFeedback() {
  $('feedback').replaceChildren(); $('timeline').replaceChildren();
  $('feedback-detail').hidden = !results;
  if (results) $('feedback-detail').open = true;
  if (!results) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Conclua um treino para comparar cada ataque e término, notas omitidas e extras.'; $('feedback').append(p); return; }
  renderTimeline($('timeline'), buildTimelineData(results, { session: reference }));
  const summary = summarizeFeedback(results);
  const heading = document.createElement('p');
  heading.className = 'timing-counts';
  const counts = summary.mode === 'free'
    ? `${summary.free} ataque(s) observado(s) · execução livre, sem acertos ou erros`
    : `Ataques: ${summary.attackOk}/${summary.expected} · términos: ${summary.endOk}/${summary.expected}${summary.pitchChecked > 0 ? ` · alturas: ${summary.pitchOk}/${summary.pitchChecked}` : ' · alturas não avaliadas'} · ${summary.mode === 'style' ? 'estilo expressivo' : 'avaliação estrita'}`;
  heading.textContent = `${counts} · referência ${reference.bpm} BPM, ${reference.meter.beats}/${reference.meter.unit}.`;
  $('feedback').append(heading);
  const tolerance = document.createElement('p'); tolerance.className = 'tool-hint muted';
  tolerance.textContent = summary.mode === 'free'
    ? 'Os desvios indicam distância à subdivisão mais próxima, não erros de interpretação. Valores negativos = antes; positivos = depois.'
    : `Tolerância: ±${Math.round(results.toleranceMs)} ms. Negativo = antes; positivo = depois. Feedback baseado na sessão executada, mesmo após editar o arranjo.`;
  $('feedback').append(tolerance);
  for (const text of summary.advice) { const p = document.createElement('p'); p.textContent = text; $('feedback').append(p); }
  const scroll = document.createElement('div'); scroll.className = 'table-scroll'; const table = document.createElement('table');
  const head = document.createElement('thead'); const tr = document.createElement('tr');
  for (const label of ['Repetição / nota', 'Ataque', 'Término']) { const th = document.createElement('th'); th.textContent = label; tr.append(th); }
  head.append(tr); table.append(head); const body = document.createElement('tbody');
  for (const [index, row] of results.rows.entries()) {
    const line = document.createElement('tr'); const label = document.createElement('td'); label.textContent = `${row.repetition ?? 1} · ${row.kind === 'extra' ? 'Extra' : row.kind === 'missed' ? 'Omitida' : `Nota ${index + 1}`}`; line.append(label);
    for (const type of ['onset', 'end']) {
      const cell = document.createElement('td');
      if (row.kind === 'matched') { const ms = Math.round(type === 'onset' ? row.onsetMs : row.endMs); cell.textContent = `${ms > 0 ? '+' : ''}${ms} ms`; cell.className = Math.abs(ms) <= results.toleranceMs ? 'ok' : 'error-timing'; }
      else if (row.kind === 'free') {
        const ms = Math.round(row.onsetMs);
        cell.textContent = type === 'onset'
          ? `${row.actualStart.toFixed(3)} s · ${ms > 0 ? '+' : ''}${ms} ms da grade`
          : `${Math.round((row.actualEnd - row.actualStart) * 1000)} ms sustentados`;
        cell.className = 'free-observation';
      }
      else { cell.textContent = row.kind === 'missed' ? 'Omitida' : type === 'onset' ? 'Ataque extra' : `${Math.round((row.actualEnd - row.actualStart) * 1000)} ms`; cell.className = row.kind === 'missed' ? 'missing' : 'extra'; }
      line.append(cell);
    }
    body.append(line);
  }
  table.append(body); scroll.append(table); $('feedback').append(scroll);
}
function frame() {
  const position = audio.position;
  const playing = executionSession ?? session;
  const formPosition = position.sectionId && position.mode === 'loop'
    ? `${position.sectionName} · repetição ${position.sectionRepeat} · fonte ${position.bar} · ${position.bpm} BPM · ${position.meter.beats}/${position.meter.unit}`
    : position.mode === 'train' || position.mode === 'countin' ? 'Treino no loop da fonte (forma não executada).'
      : session.form.enabled ? 'Forma pronta; reproduza para acompanhar as seções.' : 'Forma desativada: reprodução do loop da fonte.';
  if ($('form-position').textContent !== formPosition) $('form-position').textContent = formPosition;
  for (const row of $('form-sections').children) {
    const active = position.mode === 'loop' && row.dataset.sectionId === position.sectionId;
    if (active) row.setAttribute('aria-current', 'step'); else row.removeAttribute('aria-current');
  }
  if (position.mode !== lastMode) { lastMode = position.mode; renderControls(); }
  const repertoireBusy = repertoire.isBusy();
  if (repertoireBusy !== lastRepertoireBusy) { lastRepertoireBusy = repertoireBusy; renderControls(); }
  // A parada global usa o mesmo botão do transporte, inclusive na preparação.
  transport.render();
  studioTimeline.position(position, { hidden: exercisePlayback });
  $('train-pad').classList.toggle('active', ['countin', 'train'].includes(position.mode)); $('train-pad').classList.toggle('held', !!position.held);
  $('held-state').textContent = position.held ? 'PRESSIONADA · nota em curso' : 'ESPAÇO ou toque · pressionar / soltar';
  transport.position({ position, pending, ticksPerBar: barTicks(playing), repetitions: playing.training.repetitions });
  if (position.mode === 'countin') $('train-state').textContent = 'Espere a contagem de entrada. Depois, toque o ritmo.';
  if (position.mode === 'train') $('train-state').textContent = `Repetição ${position.repetition}/${playing.training.repetitions} · pressione no início de cada nota e solte no final.`;
  requestAnimationFrame(frame);
}
repertoire = mountRepertoire($('repertoire-mount'), host);
practice = mountPractice($('practice-mount'), host);
playground = mountPlayground($('playground-mount'), host);
journey = mountJourney($('journey-mount'), host);
setupOffline({ isBusy: () => busy() || repertoire.isBusy(), canReload: () => sessionSaved, notify: message });
history.push(session); audio.setMixer(session.mixer); renderLibrary(); renderAll();
describePattern(GROOVES[0].id);
studio.activate($('tab-studio'));
$('recovery').hidden = recoveryRaw === null; persist();
if (restored.warnings?.length) message(restored.warnings.join(' '), true);
if (library.warning) $('library-status').textContent = library.warning;
previewShare(); requestAnimationFrame(frame);
mountTour($('tour-open'), {
  activateTab: id => studio.activate($(id)),
  isBusy: () => busy() || repertoire.isBusy(),
  notify: message,
});
