import { GrooveAudio, renderSession } from './audio.js';
import { loadSession, validateSession, serializeSession, parseSession, encodeSessionLink, decodeSessionLink, drumEditStructureError, ticksPerBar as barTicks, METRONOME_PATTERNS, ARTICULATIONS } from './session.js';
import { evaluateSession, summarizeFeedback } from './feedback.js';
import { getDiatonicChords, invertChord } from './progression.js';
import { mountPractice } from './practice-trainer.js';
import { createPracticeActivity } from './practice-activity.js';
import { mountPlayground } from './playground.js';
import { mountJourney } from './practice-view.js';
import { mountRepertoire } from './repertoire-view.js';
import { setupOffline } from './offline.js';
import { mountTour } from './tour.js';
import { mergeSession } from './studio-state.js';
import { captureLegacyBackup, createExerciseLibrary } from './exercise-library.js';
import { mountLibrary } from './library-view.js';
import { History } from './history.js';
import { playbackEditPolicy } from './studio-editing.js';
import { EVALUATION_MODES, EVALUATION_MODE_LABELS, GOALS, GOAL_LABELS } from './session.js';
import { mountStudioPatterns } from './studio-patterns.js';
import { mountStudio } from './studio.js';
import { mountStudioTransport } from './studio-transport.js';
import { mountStudioTimeline } from './studio-timeline.js';
import { mountStudioInspector } from './studio-inspector.js';
import { mountStudioNotices } from './studio-notices.js';
import { mountStudioForm } from './studio-form.js';
import { createStudioPlayback, phrasePreviewSession } from './studio-playback.js';
import { mountPerformanceInput } from './performance-input.js';
import { withStudioChoices, createStudioSession, initialStudioSession } from './studio-session.js';
import { mountStudioInstrument } from './studio-instrument.js';
import { mountPracticeTracks } from './practice-tracks.js';
import { mountTrainingResult } from './training-result.js';
import { quietTakeNotices } from './take-notices.js';
import { mountToday } from './today-view.js';

const $ = id => document.getElementById(id);
// Origem declarada do material da execução. O controlador real (treinador)
// marca extensions.practice.source: uma frase do estúdio é autoral; o material
// gerado e aplicado à sessão continua sendo gerado. Sem marca, a biblioteca
// decide pela impressão digital do material.
function declaredRunSource(session) {
  const value = session?.extensions?.practice?.source;
  return value === 'generated' ? 'generated' : value === 'session' ? 'authored' : null;
}
// Estado legado cru é preservado ANTES de qualquer leitura/migração.
captureLegacyBackup();
const restored = loadSession();
let session = withStudioChoices(initialStudioSession(restored));
let recoveryRaw = restored.recoveryRaw;
let sessionSaved = false;
let selected = null;
// Material transitório mostrado pela partitura do Treinar (fonte gerada).
let sourceSnapshot = null;
// One editor selection, with a primary item and an optional same-lane group.
function noteSelection() { return selected?.kind === 'note' ? selected.id : null; }
function chordSelection() { return selected?.kind === 'chord' ? selected.index : null; }
function setNoteSelection(id) { selected = id === null ? null : { kind: 'note', id, ids: [id] }; }
function setChordSelection(index) { selected = index === null ? null : { kind: 'chord', index, indices: [index] }; }
let performanceInput;
let practiceTracks;
let trainingResult;
let generation = 0;
let pending = null;
let sharedSession = null;
let lastMode = 'idle';
let runContext = null;
let executionSession = null;
let exercisePlayback = false;
let executionMode = null;
let repertoire;
let practice;
let playground;
let journey;
let lastRepertoireBusy = false;
const history = new History();
// Uma única instância do diário de tempo real por app: Hoje, treinador e
// Percurso compartilham o mesmo estado (nunca três instâncias divergentes).
const activity = createPracticeActivity();
const library = createExerciseLibrary({ parse: parseSession, serialize: serializeSession, currentSession: session });
let activeExerciseId = library.active(); session = withStudioChoices(library.activeEntry()?.session ?? session);
const notices = mountStudioNotices({ isBusy: () => false, canUndo: () => history.canUndo, current: () => history.current, undo: () => travelHistory('undo') });
const audio = new GrooveAudio({ onState: () => renderControls(), onFinish: (attempts, detail) => {
  performanceInput?.reset();
  const focus = $('tab-practice').getAttribute('aria-selected') === 'true'
    && (document.activeElement === $('train-pad') || document.activeElement === document.body);
  const reference = detail.session, results = detail.results ?? evaluateSession(reference, attempts);
  const finished = { ...detail, session: reference, results };
  trainingResult.finished({ session: reference, results, focus });
  const practiceResult = practice?.onFinish(attempts, finished);
  if (runContext) library.recordRun(runContext, {
    bpm: reference.bpm, mode: 'train', goal: reference.training.goal, repetitions: reference.training.repetitions,
    summary: practiceResult?.summary ?? summarizeFeedback(results), metric: practiceResult?.metric ?? null, tempoDelta: practiceResult?.adapt?.bpmDelta ?? 0 });
  runContext = null;
  // A gravação continua, sem confirmação automática sobre o resultado.
  takeNotices.around(() => playground?.onFinish(attempts, finished));
  journey?.render();
  void saveTake(attempts, finished).catch(error => message(`Treino concluído; não foi possível guardar a tomada: ${error.message}`, true));
  $('train-state').textContent = 'Treino concluído. Veja seu resultado e repita quando quiser.';
  renderControls();
} });
const takeNotices = quietTakeNotices(message);
const playback = createStudioPlayback({ getSession: () => session, getPlaybackSession: () => exercisePlayback && executionSession ? executionSession : session, audio, render: renderControls, notify: message, isPending: () => pending !== null });

function message(text, error = false) { notices.show(text, { error }); }
function busy() { return pending !== null || audio.position.mode !== 'idle' || !!performanceInput?.calibrating || !!performanceInput?.preparing; }
function persist() {
  library.autosave(session);
  sessionSaved = library.saved;
  $('saved').textContent = sessionSaved ? 'Exercício salvo na biblioteca' : 'Só na memória · exporte para guardar';
}
function updateSession(patch, { notice = null, structural = false, drumDecision = false } = {}) {
  const next = mergeSession(session, patch);
  const error = drumEditStructureError(session, next);
  if (error) { message(error, true); renderControls(); return false; }
  if (studioTimeline.requestDrumChange(patch, { notice, structural, drumDecision })) return false;
  const policy = playbackEditPolicy(session, next, { mode: audio.position.mode === 'countin' && executionMode === 'loop' ? 'loop' : audio.position.mode, pending: pending !== null, exercise: exercisePlayback, structural });
  const applied = replaceSession(next, { stopPlayback: policy.stop, notice: [policy.reason, notice].filter(Boolean).join(' ') || null, resetEmpty: false });
  if (applied && policy.live) { audio.updateSession(session); playback.applyMixer(); }
  return applied;
}
function replaceSession(value, { record = true, stopPlayback = true, notice = 'Sessão substituída.', resetEmpty = true } = {}) {
  const checked = validateSession(withStudioChoices(value));
  if (!checked.ok) { message(`Alteração rejeitada: ${checked.error}`, true); renderControls(); return false; }
  if (stopPlayback) {
    if (busy() && !notice?.includes('interrompido') && !notice?.includes('Reprodução parada')) notice = `Reprodução parada para substituir a sessão. ${notice ?? ''}`.trim();
    stop();
  }
  session = checked.session;
  const previousEntry = history.current;
  if (record) history.push(session);
  if (resetEmpty) inspector.resetEmpty();
  if (history.current !== previousEntry || !record) notices.changed(history.current, notice);
  if ((selected?.kind === 'note' && !session.notes.some(note => note.id === selected.id))
    || (selected?.kind === 'chord' && !session.progression.chords[selected.index])) selected = null;
  playback.reconcile();
  if (selected?.kind === 'note') {
    selected.ids = (selected.ids ?? [selected.id]).filter(id => session.notes.some(note => note.id === id));
    if (!selected.ids.length) selected = null; else selected.id = selected.ids.includes(selected.id) ? selected.id : selected.ids[0];
  }
  persist();
  renderAll();
  notices.render();
  return true;
}
function renderAll() {
  renderControls(); studioTimeline.render(); studioForm.render(); trainingResult?.render();
  practice?.render(); playground?.render(); journey?.render(); repertoire?.render();
}
function stop(reason) {
  ++generation;
  pending = null;
  const wasDragging = studioTimeline.cancelDrag();
  audio.stop();
  playback.setListening(false);
  executionSession = null;
  exercisePlayback = false;
  executionMode = null;
  runContext = null;
  performanceInput?.reset();
  if (wasDragging) studioTimeline.renderNotes();
  renderControls();
  if (reason) message(reason);
}
async function begin(mode = 'loop', practiceSession = null, { listen = false } = {}) {
  if (mode === 'train' && performanceInput.calibrating) {
    message('Encerre a calibração antes de iniciar outro treino.', true);
    return false;
  }
  repertoire?.stop();
  stop();
  const request = ++generation;
  if (mode === 'train') {
    studio.activate($('tab-practice'));
    trainingResult.began(practiceSession);
    if (!practiceSession) practice.useSession();
  }
  pending = 'play';
  executionMode = mode;
  renderControls();
  const inputReady = mode !== 'train' || await performanceInput.prepareTraining();
  if (request !== generation) return false;
  if (!inputReady) { stop(); return false; }
  const source = structuredClone(listen ? phrasePreviewSession(sourceSnapshot ?? session) : practiceSession ?? session);
  const snapshot = !listen && mode === 'train' ? performanceInput.session(source) : source;
  playback.setListening(listen);
  executionSession = snapshot;
  exercisePlayback = practiceSession !== null || listen;
  runContext = mode === 'train' ? library.captureRunContext(executionSession, { source: declaredRunSource(executionSession), objective: executionSession.extensions?.practice?.objective ?? null }) : null;
  try {
    await audio.playSession(snapshot, {
      mode, startTick: mode === 'train' || practiceSession || listen ? null : playback.getStartTick(),
      once: listen, mixer: playback.getMixer(snapshot),
      ...playback.getPlayOptions(mode),
      ...performanceInput.playOptions(mode, snapshot),
    });
    if (request !== generation) return;
    if (mode === 'train') performanceInput.started(snapshot);
    if (mode === 'train') {
      $('train-pad').focus({ preventScroll: true });
      $('train-pad').scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    if (mode === 'train') message(performanceInput.instruction());
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
async function saveTake(attempts, detail) { return takeNotices.capture(() => repertoire.captureTake(attempts, detail)); }
const host = {
  getSession: () => structuredClone(session), updateSession, replaceSession, play: begin, stop, notify: message, preview, saveTake, renderSession,
  isBusy: busy, isInstrumentInput: () => !!performanceInput?.instrument, openExerciseHistory,
  activity, activeExerciseId: () => library.active(),
  clearResult: () => trainingResult?.clear(),
  // A referência transitória muda a partitura do treinador, não o exercício.
  getSourceSession: () => sourceSnapshot,
  setSourceSnapshot(value) {
    const next = value && typeof value === 'object' ? structuredClone(value) : null;
    if (next === sourceSnapshot) return;
    sourceSnapshot = next;
    renderAll();
  },
};

const studio = mountStudio({ onActivate: id => {
  notices.close();
  if (id !== 'tab-repertoire') repertoire?.stop();
  void performanceInput?.activate(id);
  if (id === 'tab-library') libraryView.render();
  renderControls();
} });
const transport = mountStudioTransport({
  playback,
  getState: () => ({
    active: busy() || !!repertoire?.isBusy(), locked: false,
    training: audio.session && executionMode === 'train' && (['countin', 'train'].includes(audio.position.mode) || pending === 'play'),
    canUndo: history.canUndo, canRedo: history.canRedo,
  }),
  play: () => void begin().catch(() => {}),
  stop: () => { if (practice) practice.cancel(); else stop(); repertoire?.stop(); renderControls(); },
  travelHistory, removeSelected, deselect: deselectEditor,
});
const inspector = mountStudioInspector({ getSession: () => session, getSelection: () => selected, isBusy: () => false, commitNote, notify: message });
const studioTimeline = mountStudioTimeline($('studio-editor'), {
  getSession: () => session, getExecutionSession: () => executionSession, getSourceSession: () => sourceSnapshot, isBusy: () => false, updateSession,
  seek: tick => playback.seek(tick), getStartTick: playback.getStartTick,
  isSolo: playback.isSolo, toggleSolo: playback.toggleSolo,
  getSelection: noteSelection, setSelection: setNoteSelection,
  getChordSelection: chordSelection, setChordSelection,
  getEditorSelection: () => selected, setEditorSelection: value => { selected = value; },
  selectionChanged: () => { renderControls(); studioTimeline.renderSelection(); }, commitNote, notify: message, notifyAction: (text, actionLabel, action) => notices.show(text, { current: history.current, actionLabel, action }),
  auditionNotes: notes => { if (!busy() && !repertoire?.isBusy()) void audio.audition(notes, { bpm: session.bpm, timbre: session.timbres.phrase }).catch(error => message(`Prévia indisponível: ${error.message}`, true)); },
  auditionChord: chord => { if (!busy() && !repertoire?.isBusy()) void audio.audition(chord.notes.map(note => ({ pitch: note.midi, velocity: 0.65 })), { bpm: session.bpm, timbre: session.timbres.chords, channel: 'chords' }).catch(error => message(`Prévia indisponível: ${error.message}`, true)); },
});
const studioForm = mountStudioForm({ getSession: () => session, isBusy: () => false, updateSession, notify: message });
const instrument = mountStudioInstrument({ getSession: () => session, updateSession, notify: message });
function deselectEditor() {
  if (!selected) return;
  const lane = selected.kind === 'note' ? $('grid') : $('chord-lane');
  lane.focus({ preventScroll: true });
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

const numericPaths = new Set(['bpm', 'bars', 'meter.beats', 'meter.unit', 'subdivision', 'swing', 'extensions.studio.generator.seed', 'drums.seed', 'metronome.audibleBars', 'metronome.silentBars', 'training.countInBars', 'training.repetitions', 'companion.pulses', 'companion.spanBeats']);
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
    const notice = path === 'drums.style' ? `Bateria: estilo ${input.selectedOptions[0].textContent}.` : path === 'drums.density' ? `Bateria: densidade ${input.selectedOptions[0].textContent}.` : path === 'drums.seed' ? `Bateria: semente ${value}.` : path === 'progression.keyId' ? `Tom: ${input.selectedOptions[0].textContent}; acordes diatônicos atualizados.` : null;
    updateSession(patch, { notice });
  });
}

function renderControls() {
  const locked = busy();
  for (const input of document.querySelectorAll('[data-path]')) {
    const value = getPath(session, input.dataset.path);
    if (input.type === 'checkbox') input.checked = !!value; else input.value = value ?? '';
    input.disabled = false;
  }
  $('input-pitch').value = session.extensions.studio.inputPitch;
  $('minimal').checked = !!session.extensions.studio.performanceFocus;
  document.body.classList.toggle('performance-focus', $('minimal').checked);
  const reference = sourceSnapshot ?? session;
  const listening = playback.isListening() && locked;
  $('listen-phrase').setAttribute('aria-pressed', String(listening));
  $('listen-phrase').disabled = listening || pending !== null || !reference.notes.some(note => note.start < reference.loop.endBar * barTicks(reference) && note.start + note.duration > reference.loop.startBar * barTicks(reference));
  $('practice-session-title').textContent = session.name;
  $('session-badge').textContent = `${session.meter.beats}/${session.meter.unit} · ${session.bars} comp. · loop ${session.loop.startBar + 1}–${session.loop.endBar}`;
  transport.render();
  $('train').disabled = pending !== null || ($('train').dataset.reference !== 'true' && reference.training.evaluation !== 'free' && !reference.notes.some(note => note.start >= reference.loop.startBar * barTicks(reference) && note.start < reference.loop.endBar * barTicks(reference)));
  $('train-pad').disabled = !audio.position.training;
  $('clear').disabled = session.notes.length === 0;
  for (const id of ['generate', 'variation', 'load-groove', 'generate-drums', 'generate-progression', 'new-session', 'duplicate-session', 'apply-share']) $(id).disabled = false;
  $('load-groove').disabled ||= !$('groove-library').value;
  $('apply-share').disabled ||= !sharedSession;
  inspector.render();
  instrument.render();
  studioTimeline.renderControls();
  studioForm.renderControls();
  practice?.setBusy(locked);
  notices.render();
  performanceInput?.render();
  practiceTracks?.render();
  for (const input of document.querySelectorAll('#panel-studio button, #panel-studio input, #panel-studio select, #phrase-tools-dialog button, #phrase-tools-dialog input, #phrase-tools-dialog select')) {
    if (input.closest('#form-panel') || input.id.startsWith('note-') || ['undo', 'redo', 'fit-progression'].includes(input.id)) continue;
    if (!input.disabled) {
      if (Object.hasOwn(input.dataset, 'enabledTitle')) { input.title = input.dataset.enabledTitle; delete input.dataset.enabledTitle; }
      continue;
    }
    input.dataset.enabledTitle ??= input.title;
    input.title = locked ? 'Pare a reprodução antes de fazer esta alteração' : input.id === 'clear' || input.id === 'transpose-phrase' ? 'A frase está vazia; escreva ou carregue notas primeiro' : input.title || 'Selecione um item para usar esta ação';
  }
}

function commitNote(patch) { return studioTimeline.commitNote(patch); }
const phraseDialog = $('phrase-tools-dialog');
let phraseDialogFocus = null;
function openPhraseTools(focusId = 'groove-library') {
  phraseDialogFocus = document.activeElement;
  $('meter-options').open = false;
  phraseDialog.showModal(); $(focusId).focus();
}
$('open-pattern').addEventListener('click', () => openPhraseTools());
$('open-phrase-tools').addEventListener('click', () => openPhraseTools('density'));
$('phrase-tools-close').addEventListener('click', () => phraseDialog.close());
phraseDialog.addEventListener('close', () => { phraseDialogFocus?.focus({ preventScroll: true }); phraseDialogFocus = null; });
function removeSelected() {
  if (selected?.kind === 'chord') studioTimeline.removeChord();
  else studioTimeline.removeNotes();
}
$('delete').addEventListener('click', removeSelected);
$('clear').addEventListener('click', () => updateSession({ notes: [] }, { notice: 'Frase limpa.' }));
$('transpose-phrase').addEventListener('click', () => {
  const input = $('transpose-semitones');
  if (input.value === '' || !input.checkValidity()) { message('Informe uma transposição inteira entre −24 e +24 semitons.', true); return; }
  const shift = Number(input.value);
  if (updateSession({ notes: session.notes.map(note => ({ ...note, pitch: note.pitch + shift })) })) message(`Frase transposta em ${shift > 0 ? '+' : ''}${shift} semitons.`);
});
function travelHistory(direction) {
  const value = history[direction](); if (!value) return;
  const policy = playbackEditPolicy(session, value, { mode: audio.position.mode, pending: pending !== null, exercise: exercisePlayback });
  if (replaceSession(value, { record: false, stopPlayback: policy.stop, notice: policy.reason }) && policy.live) { audio.updateSession(session); playback.applyMixer(); }
}
$('train').addEventListener('click', () => practice.useSession({ train: true }));
$('listen-phrase').addEventListener('click', () => {
  practice.cancel(); void begin('loop', null, { listen: true }).catch(() => {});
});

// Input/capture owns press/release; the host remains the single transport.
performanceInput = mountPerformanceInput({
  audio, getSession: () => session, isBusy: busy, stop, notify: message,
  isPreparingTraining: () => pending === 'play' && executionMode === 'train',
  changed: renderAll,
});
trainingResult = mountTrainingResult({
  getSession: () => session, updateSession, isBusy: () => pending !== null || !!performanceInput.calibrating,
  retry: () => practice.useSession({ train: true }), train: snapshot => practice.startSnapshot(snapshot),
  resultNote: value => performanceInput.resultNote(value),
});
practiceTracks = mountPracticeTracks($('practice-audible-mount'), {
  getSession: () => executionSession ?? session, getMixer: playback.getMixer, toggleAudible: playback.toggleAudible,
});
window.addEventListener('blur', () => { if (busy()) stop('Sessão interrompida ao perder o foco.'); repertoire.stop(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); repertoire.stop(); } });

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
// Único caminho de troca de exercício: mantém session/history em sincronia com
// a biblioteca e nunca recorre (o autosave não chama isto).
function syncActive() {
  const entry = library.activeEntry();
  if (!entry) return null;
  if (entry.id !== activeExerciseId) {
    activeExerciseId = entry.id; history.reset(entry.session);
    replaceSession(entry.session, { record: false, notice: `Exercício “${entry.metadata.name}” aberto.` });
  } else if (session.name !== entry.metadata.name) { session = mergeSession(session, { name: entry.metadata.name }); persist(); }
  return entry;
}
function openExercise(id, { train = false } = {}) {
  if (!library.select(id)) return false; syncActive();
  if (train) { studio.activate($('tab-practice')); practice.useSession({ train: true }); }
  else studio.activate($('tab-studio'));
  return true;
}
// Caminho único do histórico por exercício (biblioteca e treinador). Sem
// argumento usa o exercício ativo; nunca cria vínculo com outro exercício.
function openExerciseHistory(id) {
  const target = typeof id === 'string' && id.length > 0 ? id : library.active();
  if (!target || !library.get(target)) { message('Escolha um exercício para ver o histórico.', true); return null; }
  studio.activate($('tab-library'));
  return libraryView.openHistory(target);
}
const libraryView = mountLibrary($('library-mount'), {
  library, openExercise, notify: message, download, openExerciseHistory,
  clearExerciseRecords: id => library.clearRecords(id),
  newExercise: () => { library.new({ session: createStudioSession() }); return syncActive(); },
  duplicateExercise: id => { const copy = library.duplicate(id); if (copy) openExercise(copy.id); return copy; },
  deleteExercise: id => { const removed = library.deleteUndo(id); if (!removed) message('A biblioteca precisa de ao menos um exercício.'); syncActive(); return removed; },
  undoDeleteExercise: () => { const restored = library.undoDelete(); syncActive(); return restored; },
  updateExerciseMetadata: (id, patch) => { const entry = library.updateMetadata(id, patch); syncActive(); return entry; },
});
mountToday($('today-mount'), $('today-trainer-mount'), {
  ...host, library, download, openExercise,
  activateTab: id => studio.activate($(id)),
  stopExecution: reason => { practice?.cancel(); stop(reason); },
});
$('new-session').addEventListener('click', () => openExercise(library.new({ session: createStudioSession() }).id));
$('duplicate-session').addEventListener('click', () => { const active = library.active(); if (active) openExercise(library.duplicate(active).id); else message('Não há exercício para duplicar.'); });
for (const [id, raw, name] of [['download-library-backup', library.backupRaw, 'groovegoblin-backup-legado.json'], ['download-library-recovery', library.recoveryRaw, 'groovegoblin-biblioteca-corrompida.json']]) { $(id).hidden = raw === null; $(id).addEventListener('click', () => download(raw, name)); }

function frame() {
  const position = audio.position;
  if (position.mode === 'idle' && pending === null && playback.isListening()) playback.setListening(false);
  const playing = executionSession ?? session;
  studioForm.frame(position);
  if (position.mode !== lastMode) { lastMode = position.mode; renderControls(); }
  const repertoireBusy = repertoire.isBusy();
  if (repertoireBusy !== lastRepertoireBusy) { lastRepertoireBusy = repertoireBusy; renderControls(); }
  // A parada global usa o mesmo botão do transporte, inclusive na preparação.
  transport.render();
  studioTimeline.position(position, { hidden: exercisePlayback });
  performanceInput.frame(position, playing);
  transport.position({ position, pending, ticksPerBar: barTicks(playing), repetitions: playing.training.repetitions, startTick: playback.getStartTick(), beatTicks: 16 / playing.meter.unit, listening: playback.isListening() });
  requestAnimationFrame(frame);
}
repertoire = mountRepertoire($('repertoire-mount'), { ...host, notify: takeNotices.notify });
practice = mountPractice($('practice-mount'), host, { activity });
playground = mountPlayground($('playground-mount'), { ...host, notify: takeNotices.notify });
journey = mountJourney($('journey-mount'), { ...host, library });
setupOffline({ isBusy: () => busy() || repertoire.isBusy(), canReload: () => sessionSaved, notify: message });
history.push(session); playback.applyMixer(); renderAll();
mountStudioPatterns({ getSession: () => session, isBusy: () => false, updateSession, notify: message, renderControls });
studio.activate($(library.size() > 1 ? 'tab-library' : 'tab-studio'));
$('recovery').hidden = recoveryRaw === null; persist();
if (restored.warnings?.length) message(restored.warnings.join(' '), true);
if (library.warnings.length) message(library.warnings.join(' '), true);
previewShare(); requestAnimationFrame(frame);
mountTour($('tour-open'), {
  activateTab: id => studio.activate($(id)),
  isBusy: () => busy() || repertoire.isBusy(),
  notify: message,
});
