import { GrooveAudio, renderSession } from './audio.js';
import { createSession, loadSession, saveSession, validateSession, serializeSession, parseSession, encodeSessionLink, decodeSessionLink, drumEditStructureError, ticksPerBar as barTicks, METRONOME_PATTERNS, ARTICULATIONS } from './session.js';
import { evaluateSession, summarizeFeedback } from './feedback.js';
import { buildTimelineData, renderTimeline } from './timeline.js';
import { getDiatonicChords, invertChord } from './progression.js';
import { mountPractice } from './practice.js';
import { mountPlayground } from './playground.js';
import { mountJourney } from './practice-view.js';
import { mountRepertoire } from './repertoire-view.js';
import { setupOffline } from './offline.js';
import { mountTour } from './tour.js';
import { mergeSession, readSessionLibrary, SESSION_LIBRARY_KEY } from './studio-state.js';
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

const $ = id => document.getElementById(id);
const restored = loadSession();
let session = withStudioChoices(initialStudioSession(restored));
let recoveryRaw = restored.recoveryRaw;
let sessionSaved = false;
let selected = null;
// One editor selection, with a primary item and an optional same-lane group.
function noteSelection() { return selected?.kind === 'note' ? selected.id : null; }
function chordSelection() { return selected?.kind === 'chord' ? selected.index : null; }
function setNoteSelection(id) { selected = id === null ? null : { kind: 'note', id, ids: [id] }; }
function setChordSelection(index) { selected = index === null ? null : { kind: 'chord', index, indices: [index] }; }
let performanceInput;
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
const notices = mountStudioNotices({ isBusy: () => false, canUndo: () => history.canUndo, current: () => history.current, undo: () => travelHistory('undo') });
const audio = new GrooveAudio({ onState: () => renderControls(), onFinish: (attempts, detail) => {
  performanceInput?.reset();
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
const playback = createStudioPlayback({ getSession: () => session, audio, render: renderControls, notify: message, isPending: () => pending !== null });

function message(text, error = false) { notices.show(text, { error }); }
function busy() { return pending !== null || audio.position.mode !== 'idle' || !!performanceInput?.calibrating || !!performanceInput?.preparing; }
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
function updateSession(patch, { notice = null, structural = false, drumDecision = false } = {}) {
  const next = mergeSession(session, patch);
  const error = drumEditStructureError(session, next);
  if (error) { message(error, true); renderControls(); return false; }
  if (studioTimeline.requestDrumChange(patch, { notice, structural, drumDecision })) return false;
  const policy = playbackEditPolicy(session, next, { mode: audio.position.mode, pending: pending !== null, exercise: exercisePlayback, structural });
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
  renderControls(); studioTimeline.render(); studioForm.render(); renderFeedback();
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
  performanceInput?.reset();
  if (wasDragging) studioTimeline.renderNotes();
  renderControls();
  if (reason) message(reason);
}
async function begin(mode = 'loop', practiceSession = null, { listen = false } = {}) {
  if (mode === 'train' && (performanceInput.preparing || performanceInput.calibrating)) {
    message('Aguarde a preparação da entrada ou encerre a calibração antes de iniciar outro treino.', true);
    return false;
  }
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
  const source = structuredClone(listen ? phrasePreviewSession(session) : practiceSession ?? session);
  const snapshot = !listen && mode === 'train' ? performanceInput.session(source) : source;
  playback.setListening(listen);
  executionSession = snapshot;
  exercisePlayback = practiceSession !== null || listen;
  if (mode === 'train') { results = null; reference = null; renderFeedback(); }
  try {
    await audio.playSession(snapshot, {
      mode, startTick: mode === 'train' || practiceSession || listen ? null : playback.getStartTick(),
      once: listen, mixer: practiceSession ? snapshot.mixer : playback.getMixer(),
      ...performanceInput.playOptions(mode),
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
async function saveTake(attempts, detail) { return repertoire.captureTake(attempts, detail); }
const host = {
  getSession: () => structuredClone(session), updateSession, replaceSession, play: begin, stop, notify: message, preview, saveTake, renderSession,
  isBusy: busy, isInstrumentInput: () => !!performanceInput?.instrument,
};

const studio = mountStudio({ onActivate: id => {
  notices.close();
  if (id !== 'tab-repertoire') repertoire?.stop();
  renderControls();
} });
const transport = mountStudioTransport({
  getState: () => ({
    active: busy() || !!repertoire?.isBusy(), locked: false,
    training: ['countin', 'train'].includes(audio.position.mode) || (pending === 'play' && executionMode === 'train'),
    canUndo: history.canUndo, canRedo: history.canRedo,
  }),
  play: () => void begin().catch(() => {}),
  stop: () => { if (practice) practice.cancel(); else stop(); repertoire?.stop(); renderControls(); },
  travelHistory, removeSelected, deselect: deselectEditor,
});
const inspector = mountStudioInspector({ getSession: () => session, getSelection: () => selected, isBusy: () => false, commitNote, notify: message });
const studioTimeline = mountStudioTimeline($('studio-editor'), {
  getSession: () => session, isBusy: () => false, updateSession,
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
  const listening = playback.isListening() && locked;
  $('listen-phrase').setAttribute('aria-pressed', String(listening));
  $('listen-phrase').disabled = listening || pending !== null || !session.notes.some(note => note.start < session.loop.endBar * barTicks(session) && note.start + note.duration > session.loop.startBar * barTicks(session));
  $('practice-session-title').textContent = session.name;
  $('session-badge').textContent = `${session.meter.beats}/${session.meter.unit} · ${session.bars} comp. · loop ${session.loop.startBar + 1}–${session.loop.endBar}`;
  transport.render();
  $('train').disabled = pending !== null || (session.training.evaluation !== 'free' && !session.notes.some(note => note.start >= session.loop.startBar * barTicks(session) && note.start < session.loop.endBar * barTicks(session)));
  $('train-pad').disabled = !['countin', 'train'].includes(audio.position.mode);
  $('clear').disabled = session.notes.length === 0;
  for (const id of ['generate', 'variation', 'load-groove', 'generate-drums', 'generate-progression', 'new-session', 'duplicate-session', 'save-session', 'restore-session', 'delete-session', 'replace-recovery', 'replace-library-recovery', 'apply-share']) $(id).disabled = false;
  $('load-groove').disabled ||= !$('groove-library').value;
  $('restore-session').disabled ||= !$('session-library').value;
  $('delete-session').disabled ||= !$('session-library').value;
  $('apply-share').disabled ||= !sharedSession;
  inspector.render();
  studioTimeline.renderControls();
  studioForm.renderControls();
  practice?.setBusy(locked);
  notices.render();
  performanceInput?.render();
  for (const input of document.querySelectorAll('#panel-studio button, #panel-studio input, #panel-studio select, #phrase-tools-dialog button, #phrase-tools-dialog input, #phrase-tools-dialog select')) {
    if (input.closest('#form-panel') || input.id.startsWith('note-') || ['undo', 'redo', 'fit-progression'].includes(input.id)) continue;
    if (!input.disabled) {
      if (Object.hasOwn(input.dataset, 'enabledTitle')) { input.title = input.dataset.enabledTitle; delete input.dataset.enabledTitle; }
      continue;
    }
    input.dataset.enabledTitle ??= input.title;
    input.title = locked ? 'Pare a reprodução antes de fazer esta alteração' : input.id === 'clear' || input.id === 'transpose-phrase' ? 'A frase está vazia; escreva ou carregue notas primeiro' : ['restore-session', 'delete-session'].includes(input.id) ? 'Escolha uma sessão guardada primeiro' : input.title || 'Selecione um item para usar esta ação';
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
$('replace-recovery').addEventListener('click', () => {
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
  replaceSession(createStudioSession(), { notice: 'Nova sessão de quatro compassos criada.' });
});
$('duplicate-session').addEventListener('click', () => {
  const copy = mergeSession(session, { name: `${session.name.slice(0, 112)} · cópia` });
  const item = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), session: copy };
  if (writeLibrary([...library.entries, item]) && replaceSession(copy, { notice: 'Cópia guardada na biblioteca e aberta.' })) {
    $('session-library').value = item.id; renderControls();
  }
});
$('save-session').addEventListener('click', () => {
  const item = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), session: structuredClone(session) };
  if (writeLibrary([...library.entries, item])) { $('session-library').value = item.id; renderControls(); message('Sessão completa guardada na biblioteca.'); }
});
$('session-library').addEventListener('change', renderControls);
$('restore-session').addEventListener('click', () => { const item = library.entries.find(entry => entry.id === $('session-library').value); if (item) replaceSession(item.session, { notice: 'Sessão guardada aberta.' }); });
$('delete-session').addEventListener('click', () => writeLibrary(library.entries.filter(entry => entry.id !== $('session-library').value)));
$('download-library-recovery').addEventListener('click', () => { if (library.recoveryRaw !== null) download(library.recoveryRaw, 'groovegoblin-biblioteca-original.json'); });
$('replace-library-recovery').addEventListener('click', () => {
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
  const attackOnly = reference.extensions?.performanceInput?.mode === 'instrument';
  const heading = document.createElement('p');
  heading.className = 'timing-counts';
  const counts = summary.mode === 'free'
    ? `${summary.free} ataque(s) observado(s) · execução livre, sem acertos ou erros`
    : `Ataques: ${summary.attackOk}/${summary.expected} · ${attackOnly ? 'términos e alturas não avaliados' : `términos: ${summary.endOk}/${summary.expected}${summary.pitchChecked > 0 ? ` · alturas: ${summary.pitchOk}/${summary.pitchChecked}` : ' · alturas não avaliadas'}`} · ${summary.mode === 'style' ? 'estilo expressivo' : 'avaliação estrita'}`;
  heading.textContent = `${counts} · referência ${reference.bpm} BPM, ${reference.meter.beats}/${reference.meter.unit}.`;
  $('feedback').append(heading);
  const inputNote = performanceInput.resultNote(reference);
  if (inputNote) $('feedback').append(Object.assign(document.createElement('p'), { className: 'tool-hint muted', textContent: inputNote }));
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
      if (attackOnly && type === 'end') { cell.textContent = 'Não avaliado'; line.append(cell); continue; }
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
repertoire = mountRepertoire($('repertoire-mount'), host);
practice = mountPractice($('practice-mount'), host);
playground = mountPlayground($('playground-mount'), host);
journey = mountJourney($('journey-mount'), host);
setupOffline({ isBusy: () => busy() || repertoire.isBusy(), canReload: () => sessionSaved, notify: message });
history.push(session); playback.applyMixer(); renderLibrary(); renderAll();
mountStudioPatterns({ getSession: () => session, isBusy: () => false, updateSession, notify: message, renderControls });
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
