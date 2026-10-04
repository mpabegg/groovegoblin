import { GrooveAudio, renderSession } from './audio.js';
import { loadSession, saveSession, validateSession, serializeSession, parseSession, encodeSessionLink, decodeSessionLink, ticksPerBar as barTicks, sessionTicks as totalTicks, STYLES, DENSITIES, METRONOME_PATTERNS, ARTICULATIONS, TIMBRES, TIMBRE_LABELS } from './session.js';
import { evaluateSession, summarizeFeedback } from './feedback.js';
import { buildTimelineData, renderTimeline } from './timeline.js';
import { GROOVES, loadGroove } from './library.js';
import { buildRhythmNotation, renderRhythmNotation } from './notation.js';
import { PROGRESSION_KEYS, getDiatonicChords, getBorrowedChords, getSecondaryDominants, parseChordSymbol, generateProgression, invertChord, chordTimeline } from './progression.js';
import { mountPractice } from './practice.js';
import { mountPlayground } from './playground.js';
import { mountJourney } from './practice-view.js';
import { mountRepertoire } from './repertoire-view.js';
import { setupOffline } from './offline.js';
import { mergeSession, readSessionLibrary, SESSION_LIBRARY_KEY } from './studio-state.js';
import { History } from './history.js';
import { addNote, updateNote, deleteNote, quantizeTick as snapTick } from './model.js';
import { generateGroove } from './generator.js';
import { generateDrums, DRUM_VOICES } from './drums.js';

const $ = id => document.getElementById(id);
const restored = loadSession();
let session = withStudioChoices(restored.session);
let recoveryRaw = restored.recoveryRaw;
let selected = null;
let drag = null;
let activeInput = null;
let generation = 0;
let pending = null;
let sharedSession = null;
let results = null;
let reference = null;
let lastMode = 'idle';
let repertoire;
let practice;
let playground;
let journey;
let chordMarkers = [];
let activeChordIndex = -1;
let lastRepertoireBusy = false;
const history = new History();
const library = readSessionLibrary(undefined, parseSession);
const audio = new GrooveAudio({ onState: () => renderControls(), onFinish: (attempts, detail) => {
  clearInput();
  reference = detail.session;
  results = detail.results ?? evaluateSession(reference, attempts);
  renderFeedback();
  practice?.onFinish(attempts, { ...detail, session: reference, results });
  playground?.onFinish(attempts, { ...detail, session: reference, results });
  journey?.render();
  void saveTake(attempts, { ...detail, session: reference, results }).catch(error => message(`Treino concluído; não foi possível guardar a tomada: ${error.message}`, true));
  $('train-state').textContent = 'Treino concluído. Compare ataques e términos; a tomada usa a sessão executada.';
  renderControls();
} });

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}
function busy() { return pending !== null || audio.position.mode !== 'idle'; }
function persist() {
  $('saved').textContent = recoveryRaw !== null ? 'Só na memória · originais protegidos'
    : saveSession(session) ? 'Sessão salva neste navegador' : 'Só na memória · exporte para guardar';
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
function liveChoice(key) {
  return ['mixer', 'metronome', 'band', 'drums', 'timbres'].includes(key) || (key === 'bpm' && audio.position.mode === 'loop');
}
function updateSession(patch) {
  const live = pending === null && audio.position.mode !== 'idle' && Object.keys(patch).every(liveChoice);
  const applied = replaceSession(mergeSession(session, patch), { stopPlayback: !live });
  if (applied && live) audio.updateSession(session);
  return applied;
}
function replaceSession(value, { record = true, stopPlayback = true } = {}) {
  const checked = validateSession(withStudioChoices(value));
  if (!checked.ok) { message(`Alteração rejeitada: ${checked.error}`, true); renderControls(); return false; }
  if (stopPlayback) stop();
  session = checked.session;
  if (record) history.push(session);
  if (!session.notes.some(note => note.id === selected)) selected = null;
  audio.setMixer(session.mixer);
  persist();
  renderAll();
  return true;
}
function renderAll() {
  renderControls(); renderGrid(); renderDrums(); renderNotes(); renderProgression(); renderFeedback();
  practice?.render(); playground?.render(); journey?.render(); repertoire?.render();
}
function cancelDrag() {
  const previous = drag;
  drag = null;
  if (previous && $('grid').hasPointerCapture(previous.pointer)) $('grid').releasePointerCapture(previous.pointer);
}
function stop(reason) {
  ++generation;
  pending = null;
  const wasDragging = drag !== null;
  cancelDrag();
  audio.stop();
  clearInput();
  if (wasDragging) renderNotes();
  renderControls();
  if (reason) message(reason);
}
async function begin(mode = 'loop') {
  repertoire?.stop();
  stop();
  const request = ++generation;
  pending = 'play';
  renderControls();
  const snapshot = structuredClone(session);
  if (mode === 'train') { results = null; reference = null; renderFeedback(); }
  try {
    await audio.playSession(snapshot, { mode });
    if (request !== generation) return;
    message(mode === 'train' ? 'Treino iniciado: pressione no ataque e solte no término.' : 'Arranjo completo no mesmo loop.');
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
  try { await audio.preview(notes, options); }
  finally { if (request === generation) { pending = null; renderControls(); } }
}
async function saveTake(attempts, detail) { return repertoire.captureTake(attempts, detail); }
const host = { getSession: () => structuredClone(session), updateSession, replaceSession, play: begin, stop, notify: message, preview, saveTake, renderSession };

// Uma única intenção na ordem de tabulação; setas navegam entre abas.
const tabs = [...document.querySelectorAll('[role=tab]')];
function activateTab(tab) {
  for (const item of tabs) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1;
    $(item.getAttribute('aria-controls')).hidden = !active;
  }
  if (tab.id !== 'tab-repertoire') repertoire.stop();
}
for (const tab of tabs) {
  tab.addEventListener('click', () => activateTab(tab));
  tab.addEventListener('keydown', event => {
    const index = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : null;
    if (next === null) return;
    event.preventDefault(); activateTab(tabs[next]); tabs[next].focus();
  });
}
$('minimal').addEventListener('change', event => {
  session = mergeSession(session, { extensions: { studio: { performanceFocus: event.target.checked } } });
  document.body.classList.toggle('performance-focus', event.target.checked); persist();
});
function fillOptions(select, values, labels) {
  select.replaceChildren();
  for (const value of values) {
    const option = document.createElement('option'); option.value = value; option.textContent = labels[value] ?? value; select.append(option);
  }
}
const styleLabels = { complement: 'Complementar', pop: 'Pop', rock: 'Rock', funk: 'Funk', shuffle: 'Shuffle', jazz: 'Jazz', bossa: 'Bossa nova', samba: 'Samba', baiao: 'Baião', reggae: 'Reggae', waltz: 'Valsa' };
const densityLabels = { sparse: 'Poucas notas', medium: 'Média', busy: 'Muitas notas' };
const metroLabels = { quarters: 'Semínimas', backbeat: 'Backbeat · 2 e 4', offbeats: 'Contratempos', subdivisions: 'Subdivisões da grade', downbeats: 'Início de compasso' };
const articulationLabels = { normal: 'Normal', accent: 'Acento', ghost: 'Fantasma', staccato: 'Staccato', tenuto: 'Tenuto', legato: 'Legato' };
for (const id of ['drum-style', 'bass-style']) fillOptions($(id), STYLES, styleLabels);
for (const id of ['drum-density', 'bass-density']) fillOptions($(id), DENSITIES, densityLabels);
fillOptions($('metro-pattern'), METRONOME_PATTERNS, metroLabels);
fillOptions($('note-articulation'), ARTICULATIONS, articulationLabels);
for (const [channel, labelText] of Object.entries({ phrase: 'Timbre da frase', chords: 'Timbre da harmonia', bass: 'Timbre do baixo' })) {
  const label = document.createElement('label'); label.textContent = labelText;
  const select = document.createElement('select'); select.dataset.path = `timbres.${channel}`;
  fillOptions(select, TIMBRES[channel], TIMBRE_LABELS); label.append(select); $('synth-controls').append(label);
}
const monitorLabel = document.createElement('label'); monitorLabel.className = 'toggle';
const monitor = document.createElement('input'); monitor.type = 'checkbox'; monitor.dataset.path = 'training.monitor';
monitorLabel.append(monitor, document.createTextNode('Ouvir teclado/toque no treino')); $('synth-controls').append(monitorLabel);
for (const input of document.querySelectorAll('[data-path^="generator."]')) input.dataset.path = `extensions.studio.${input.dataset.path}`;
$('progression-function').dataset.path = 'extensions.studio.progressionFunction';
$('input-pitch').addEventListener('change', event => {
  if (event.target.value === '' || !event.target.checkValidity()) { event.target.value = session.extensions.studio.inputPitch; message('Escolha uma altura MIDI entre 21 e 108.', true); return; }
  session = mergeSession(session, { extensions: { studio: { inputPitch: Number(event.target.value) } } });
  persist();
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
    if (path === 'bars') patch = mergeSession(patch, { loop: { endBar: value, startBar: Math.min(session.loop.startBar, value - 1) } });
    if (path === 'progression.keyId') {
      const chords = getDiatonicChords(value);
      patch.progression.chords = session.progression.chords.map(chord => chord.source !== 'diatonic' ? chord : invertChord({ ...chords[(chord.degree ?? 1) - 1], durationBars: chord.durationBars }, chord.inversion));
    }
    updateSession(patch);
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
  $('session-title').textContent = session.name;
  $('session-badge').textContent = `${session.meter.beats}/${session.meter.unit} · ${session.bars} comp. · loop ${session.loop.startBar + 1}–${session.loop.endBar}`;
  $('play').disabled = pending !== null;
  $('train').disabled = pending !== null || !session.notes.some(note => note.start >= session.loop.startBar * barTicks(session) && note.start < session.loop.endBar * barTicks(session));
  $('stop').disabled = !locked && !repertoire?.isBusy();
  $('train-pad').disabled = !['countin', 'train'].includes(audio.position.mode);
  $('undo').disabled = locked || !history.canUndo;
  $('redo').disabled = locked || !history.canRedo;
  $('clear').disabled = locked || session.notes.length === 0;
  for (const id of ['generate', 'variation', 'load-groove', 'generate-drums', 'generate-progression', 'add-chord', 'save-session', 'restore-session', 'delete-session', 'replace-recovery', 'apply-share']) $(id).disabled = locked;
  $('load-groove').disabled ||= !$('groove-library').value;
  $('restore-session').disabled ||= !$('session-library').value;
  $('delete-session').disabled ||= !$('session-library').value;
  $('apply-share').disabled ||= !sharedSession;
  const note = session.notes.find(item => item.id === selected);
  $('selection-text').textContent = note ? `Nota selecionada · MIDI ${note.pitch} · ${format(note.duration)} ticks` : 'Clique para criar; selecione uma nota para editar.';
  for (const field of ['start', 'duration', 'pitch', 'velocity', 'articulation', 'offsetMs']) {
    const input = $(`note-${field}`); input.value = note?.[field] ?? ''; input.disabled = locked || !note;
  }
  $('note-start').max = $('note-duration').max = totalTicks(session);
  $('transpose-semitones').disabled = locked;
  $('transpose-phrase').disabled = locked || !session.notes.length;
  $('note-start').step = $('note-duration').step = 4 / session.subdivision;
  $('note-duration').min = 0;
  $('delete').disabled = locked || !note;
  for (const preset of $('presets').children) preset.disabled = locked || !note;
  for (const input of document.querySelectorAll('.chord-editor input, .chord-editor select, .chord-editor button')) input.disabled = locked;
  for (const input of document.querySelectorAll('.cell, .note')) input.disabled = locked;
  renderMixer();
}
function format(number) { return String(Math.round(number * 1000) / 1000); }
function renderGrid() {
  const total = totalTicks(session);
  const measure = barTicks(session);
  const step = 4 / session.subdivision;
  const ticks = [];
  for (let bar = 0; bar < session.bars; bar++) for (let tick = 0; tick < measure - 1e-8; tick += step) ticks.push(bar * measure + tick);
  document.querySelector('.grid-shell').style.minWidth = `${Math.max(560, ticks.length * 28)}px`;
  $('cells').replaceChildren(); $('cells').style.display = 'block';
  for (let index = 0; index < ticks.length; index++) {
    const tick = ticks[index];
    const cell = document.createElement('button'); cell.type = 'button'; cell.className = 'cell'; cell.dataset.tick = tick;
    cell.style.left = `${tick / total * 100}%`; cell.style.width = `${((ticks[index + 1] ?? total) - tick) / total * 100}%`;
    cell.setAttribute('aria-label', `Criar nota: compasso ${Math.floor(tick / measure) + 1}, tick ${format(tick % measure)}`);
    cell.disabled = busy();
    cell.addEventListener('click', () => {
      if (busy()) return;
      const notes = addNote(session.notes, tick, Math.min(4 / session.subdivision, totalTicks(session) - tick), session, { pitch: Number($('input-pitch').value), velocity: 0.8, articulation: 'normal' });
      if (notes === session.notes) { message('Posição ocupada ou duração ultrapassa a frase.', true); return; }
      selected = notes.find(note => !session.notes.some(previous => previous.id === note.id)).id;
      updateSession({ notes });
      $('notes').querySelector(`[data-id="${CSS.escape(selected)}"]`)?.focus({ preventScroll: true });
    });
    $('cells').append(cell);
  }
  $('marks').replaceChildren();
  for (const tick of [...ticks, total]) {
    const mark = document.createElement('span');
    const inBar = tick / measure;
    const inBeat = tick / (16 / session.meter.unit);
    mark.className = `mark ${Math.abs(inBar - Math.round(inBar)) < 1e-8 ? 'bar-mark' : Math.abs(inBeat - Math.round(inBeat)) < 1e-8 ? 'beat-mark' : ''}`;
    mark.style.left = `${tick / total * 100}%`; $('marks').append(mark);
  }
  $('beat-labels').replaceChildren(); $('subdivision-labels').replaceChildren();
  for (let bar = 0; bar < session.bars; bar++) for (let beat = 0; beat < session.meter.beats; beat++) {
    const label = document.createElement('span'); label.textContent = beat === 0 ? `${bar + 1} · 1` : String(beat + 1);
    label.style.left = `${(bar * measure + beat * 16 / session.meter.unit) / total * 100}%`; $('beat-labels').append(label);
  }
}
function renderDrums() {
  const names = { kick: 'Bumbo', snare: 'Caixa', hihat: 'Chimbal', openhat: 'Chimbal aberto', rim: 'Aro', ride: 'Prato de condução', shaker: 'Ganzá', tom: 'Tom', triangle: 'Triângulo' };
  const pattern = generateDrums(session);
  const total = totalTicks(session);
  const rows = $('drum-rows');
  rows.replaceChildren();
  $('drum-lanes').classList.toggle('drums-off', !session.drums.enabled || session.band.role === 'drums');
  for (const voice of DRUM_VOICES) {
    const hits = pattern.hits.filter(hit => hit.instrument === voice);
    if (!hits.length && !['kick', 'snare', 'hihat'].includes(voice)) continue;
    const row = document.createElement('div');
    row.className = `drum-line drum-${voice}`;
    const label = document.createElement('div');
    label.className = 'drum-label';
    label.textContent = `${names[voice] ?? voice} · ${hits.length} ataques`;
    const lane = document.createElement('div');
    lane.className = 'drum-steps';
    lane.setAttribute('role', 'img');
    lane.setAttribute('aria-label', `${names[voice] ?? voice}: ataques nos ticks ${hits.map(hit => format(hit.start)).join(', ') || 'nenhum'}. Padrão de referência da banda.`);
    for (const hit of hits) {
      const mark = document.createElement('span');
      mark.className = 'drum-hit';
      mark.style.left = `${hit.start / total * 100}%`;
      mark.style.opacity = String(Math.max(0.25, hit.velocity));
      mark.title = `${names[voice] ?? voice} · tick ${format(hit.start)} · intensidade ${Math.round(hit.velocity * 100)}%`;
      mark.setAttribute('aria-hidden', 'true');
      lane.append(mark);
    }
    row.append(label, lane);
    rows.append(row);
  }
}
function renderNotes(previewNotes = session.notes) {
  const focusedId = document.activeElement?.closest('.note')?.dataset.id;
  $('notes').replaceChildren();
  const total = totalTicks(session);
  for (const note of [...previewNotes].sort((a, b) => a.start - b.start)) {
    const block = document.createElement('button'); block.type = 'button'; block.className = `note${selected === note.id ? ' selected' : ''}`; block.dataset.id = note.id;
    block.style.left = `calc(${note.start / total * 100}% + 2px)`; block.style.width = `calc(${note.duration / total * 100}% - 4px)`;
    block.disabled = busy(); block.setAttribute('aria-pressed', String(note.id === selected));
    block.setAttribute('aria-label', `Nota MIDI ${note.pitch}: início ${format(note.start)}, duração ${format(note.duration)} ticks, velocidade ${format(note.velocity)}, ${note.articulation}`);
    block.textContent = `${format(note.duration)}t · ${note.pitch}`;
    const handle = document.createElement('span'); handle.className = 'handle'; handle.setAttribute('aria-hidden', 'true'); block.append(handle);
    block.addEventListener('click', () => { if (!busy()) { selected = note.id; renderNotes(); } });
    $('notes').append(block);
  }
  renderRhythmNotation($('rhythm-score'), buildRhythmNotation(previewNotes, session));
  if (focusedId) $('notes').querySelector(`[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
  renderControls();
}
function commitNote(patch) {
  if (busy() || !selected) return;
  const notes = updateNote(session.notes, selected, patch, session);
  if (notes === session.notes) { message('Sem sobreposição e sem ultrapassar o fim da frase.', true); renderControls(); return; }
  updateSession({ notes });
}
$('grid').addEventListener('pointerdown', event => {
  const block = event.target.closest('.note');
  if (!block || busy() || event.button !== 0) return;
  event.preventDefault();
  const note = session.notes.find(item => item.id === block.dataset.id);
  selected = note.id; drag = { id: note.id, x: event.clientX, start: note.start, duration: note.duration, resize: !!event.target.closest('.handle'), original: session, next: session.notes, pointer: event.pointerId };
  $('grid').setPointerCapture(event.pointerId); renderNotes();
});
$('grid').addEventListener('pointermove', event => {
  if (!drag || drag.pointer !== event.pointerId || busy()) return;
  const delta = snapTick((event.clientX - drag.x) / $('grid').getBoundingClientRect().width * totalTicks(session), session.subdivision);
  const notes = updateNote(drag.original.notes, drag.id, drag.resize ? { duration: drag.duration + delta } : { start: drag.start + delta }, drag.original);
  drag.next = notes; renderNotes(notes);
});
$('grid').addEventListener('pointerup', event => {
  if (!drag || drag.pointer !== event.pointerId) return;
  const notes = drag.next; cancelDrag(); if (!busy()) updateSession({ notes });
});
$('grid').addEventListener('pointercancel', () => { cancelDrag(); renderNotes(); });
$('grid').addEventListener('lostpointercapture', event => {
  if (drag?.pointer === event.pointerId) { cancelDrag(); renderNotes(); }
});
for (const field of ['start', 'duration', 'pitch', 'velocity', 'articulation', 'offsetMs']) $(`note-${field}`).addEventListener('change', event => commitNote({ [field]: field === 'articulation' ? event.target.value : Number(event.target.value) }));
for (const [ticks, label] of [[1, '1/16'], [2, '1/8'], [3, '1/8.'], [4, '1/4'], [6, '1/4.'], [8, '1/2'], [12, '1/2.'], [16, '1/1'], [4 / 3, 'Tercina'], [4 / 5, 'Quintina'], [4 / 7, 'Septina']]) {
  const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'preset'; chip.textContent = label;
  chip.addEventListener('click', () => commitNote({ duration: ticks })); $('presets').append(chip);
}
function removeSelected() { if (!busy() && selected) updateSession({ notes: deleteNote(session.notes, selected) }); }
$('delete').addEventListener('click', removeSelected);
$('clear').addEventListener('click', () => { if (!busy()) updateSession({ notes: [] }); });
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
$('undo').addEventListener('click', () => travelHistory('undo')); $('redo').addEventListener('click', () => travelHistory('redo'));
$('play').addEventListener('click', () => void begin().catch(() => {}));
$('train').addEventListener('click', () => void begin('train').catch(() => {}));
$('stop').addEventListener('click', () => { stop('Sessão parada.'); repertoire.stop(); });

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
  const editing = event.target instanceof Element && !!event.target.closest('input, textarea, select, [contenteditable=true]');
  if (event.key === 'Escape') { stop('Sessão interrompida.'); repertoire.stop(); return; }
  if (editing) return;
  if ((event.code === 'Space' || (event.code === 'Enter' && event.target === $('train-pad'))) && ['countin', 'train'].includes(audio.position.mode)) {
    event.preventDefault(); if (!event.repeat && !activeInput) { activeInput = { source: 'keyboard', id: event.code }; audio.press(event.timeStamp, Number($('input-pitch').value)); } return;
  }
  if (!event.target.closest?.('#studio-editor')) return;
  if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); travelHistory(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo'); return; }
  if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); removeSelected(); return; }
  if (busy() || !selected) return;
  const note = session.notes.find(item => item.id === selected);
  const step = event.shiftKey ? 4 : 4 / session.subdivision;
  const patch = event.key === 'ArrowLeft' ? { start: note.start - step } : event.key === 'ArrowRight' ? { start: note.start + step } : event.key === 'ArrowDown' ? { duration: note.duration - step } : event.key === 'ArrowUp' ? { duration: note.duration + step } : !event.ctrlKey && !event.metaKey && !event.altKey && ['1', '2', '3', '4', '6', '8'].includes(event.key) ? { duration: Number(event.key) } : null;
  if (patch) { event.preventDefault(); commitNote(patch); }
});
window.addEventListener('keyup', event => {
  if (activeInput?.source !== 'keyboard' || activeInput.id !== event.code) return;
  event.preventDefault(); audio.release(event.timeStamp); clearInput();
});
window.addEventListener('blur', () => { if (busy()) stop('Sessão interrompida ao perder o foco.'); repertoire.stop(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); repertoire.stop(); } });

for (const groove of GROOVES) {
  const option = document.createElement('option'); option.value = groove.id; option.textContent = groove.name; $('groove-library').append(option);
}
$('groove-library').addEventListener('change', () => {
  const groove = GROOVES.find(item => item.id === $('groove-library').value);
  $('groove-description').replaceChildren();
  if (groove) {
    for (const text of [groove.description, groove.durationNote]) { const p = document.createElement('p'); p.textContent = text; $('groove-description').append(p); }
    for (const source of groove.sources) { const link = document.createElement('a'); link.href = source.url; link.textContent = source.title; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('groove-description').append(link); }
  }
  renderControls();
});
$('load-groove').addEventListener('click', () => {
  const groove = loadGroove($('groove-library').value);
  updateSession({ ...groove, loop: { startBar: 0, endBar: groove.bars } });
});
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
function generate(variation) {
  if (busy()) return;
  const options = { ...session.extensions.studio.generator, seed: variation ? newSeed() : Number($('seed').value) };
  try {
    const generated = generateGroove({ ...options, bars: session.bars, meter: session.meter, subdivision: session.subdivision });
    updateSession({ notes: generated.notes, extensions: { studio: { generator: options } } });
    message(`Groove gerado com semente ${options.seed}.`);
  }
  catch (error) { message(error.message, true); }
}
$('generate').addEventListener('click', () => generate(false)); $('variation').addEventListener('click', () => generate(true));
$('generate-drums').addEventListener('click', () => updateSession({ drums: { enabled: true, seed: newSeed() } }));

for (const key of PROGRESSION_KEYS) { const option = document.createElement('option'); option.value = key.id; option.textContent = key.label; $('progression-key').append(option); }
function renderProgression() {
  chordMarkers = chordTimeline(session);
  activeChordIndex = -1;
  const choices = [...getDiatonicChords(session.progression.keyId), ...getBorrowedChords(session.progression.keyId), ...getSecondaryDominants(session.progression.keyId)];
  $('progression-chords').replaceChildren();
  let bar = 0;
  session.progression.chords.forEach((chord, index) => {
    const item = document.createElement('li'); item.className = 'progression-chord chord-editor';
    const title = document.createElement('strong'); title.textContent = chord.symbol;
    const where = document.createElement('span'); where.textContent = `Compasso ${format(bar + 1)} · ${chord.roman} · ${chord.notes.map(note => note.name).join(' · ')}`;
    bar += chord.durationBars;
    const select = document.createElement('select'); select.setAttribute('aria-label', `Acorde ${index + 1}`);
    const custom = document.createElement('option'); custom.value = 'custom'; custom.textContent = 'Símbolo manual'; select.append(custom);
    for (const [position, choice] of choices.entries()) { const option = document.createElement('option'); option.value = position; option.textContent = `${choice.roman} · ${choice.symbol} · ${choice.source === 'borrowed' ? 'empréstimo' : choice.source === 'secondary' ? 'dominante secundária' : 'diatônico'}`; select.append(option); }
    const matching = choices.findIndex(choice => choice.symbol === chord.symbol);
    select.value = matching < 0 ? 'custom' : String(matching);
    select.addEventListener('change', () => { if (select.value !== 'custom') replaceChord(index, { ...choices[Number(select.value)], durationBars: chord.durationBars, inversion: 0 }); });
    const symbol = document.createElement('input'); symbol.type = 'text'; symbol.value = chord.symbol; symbol.maxLength = 30; symbol.setAttribute('aria-label', `Símbolo manual do acorde ${index + 1}`);
    symbol.addEventListener('change', () => {
      try { replaceChord(index, { ...parseChordSymbol(symbol.value), durationBars: chord.durationBars }); }
      catch (error) { message(error.message, true); symbol.value = chord.symbol; }
    });
    const duration = document.createElement('input'); duration.type = 'number'; duration.min = '0.25'; duration.max = '16'; duration.step = '0.25'; duration.value = chord.durationBars; duration.setAttribute('aria-label', `Duração do acorde ${index + 1} em compassos`);
    duration.addEventListener('change', () => replaceChord(index, { ...chord, durationBars: Number(duration.value) }));
    const inversion = document.createElement('select'); inversion.setAttribute('aria-label', `Inversão do acorde ${index + 1}`);
    for (let value = 0; value < 4; value++) { const option = document.createElement('option'); option.value = value; option.textContent = value === 0 ? 'Fundamental' : `${value}ª inversão`; inversion.append(option); }
    inversion.value = chord.inversion ?? 0;
    inversion.addEventListener('change', () => replaceChord(index, invertChord(chord, Number(inversion.value))));
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remover'; remove.addEventListener('click', () => updateSession({ progression: { chords: session.progression.chords.filter((_, position) => position !== index) } }));
    item.append(where, title, select, symbol, duration, inversion, remove); $('progression-chords').append(item);
  });
  $('progression-status').textContent = `${session.progression.chords.length} acordes · ciclo harmônico de ${format(bar)} compassos dentro do arranjo.`;
  renderControls();
}
function replaceChord(index, chord) { updateSession({ progression: { chords: session.progression.chords.map((value, position) => position === index ? chord : value) } }); }
$('add-chord').addEventListener('click', () => updateSession({ progression: { chords: [...session.progression.chords, { ...getDiatonicChords(session.progression.keyId)[0], durationBars: 1, inversion: 0 }] } }));
$('generate-progression').addEventListener('click', () => {
  const keyId = session.progression.keyId;
  const mode = $('progression-function').value;
  const diatonic = getDiatonicChords(keyId);
  const degrees = mode === 'cadence' ? [1, 4, 5, 1] : [1, 6, 2, 5];
  const base = mode === 'random' ? generateProgression({ keyId }).chords : degrees.map(degree => diatonic[degree - 1]);
  const chords = base.map(chord => ({ ...chord, durationBars: session.bars / base.length, inversion: 0 }));
  updateSession({ progression: { enabled: true, chords } });
});

const channelNames = { phrase: 'Frase', metronome: 'Metrônomo', drums: 'Bateria', chords: 'Harmonia', bass: 'Baixo' };
for (const [channel, label] of Object.entries(channelNames)) {
  const field = document.createElement('fieldset'); field.className = 'mixer-channel';
  const legend = document.createElement('legend'); legend.textContent = label;
  const volume = document.createElement('input'); volume.type = 'range'; volume.min = '0'; volume.max = '100'; volume.id = `mixer-${channel}-volume`; volume.setAttribute('aria-label', `Volume: ${label}`);
  const output = document.createElement('output'); output.id = `mixer-${channel}-value`;
  const muteLabel = document.createElement('label'); muteLabel.className = 'toggle';
  const mute = document.createElement('input'); mute.type = 'checkbox'; mute.id = `mixer-${channel}-muted`; muteLabel.append(mute, document.createTextNode('Silenciar'));
  const change = () => {
    session = mergeSession(session, { mixer: { [channel]: { volume: Number(volume.value) / 100, muted: mute.checked } } });
    audio.setMixer(session.mixer); persist(); renderMixer();
  };
  volume.addEventListener('input', change); mute.addEventListener('change', change);
  field.append(legend, output, volume, muteLabel); $('mixer-channels').append(field);
}
function renderMixer() {
  for (const channel of Object.keys(channelNames)) {
    const value = session.mixer[channel];
    const volume = $(`mixer-${channel}-volume`); if (!volume || !value) continue;
    volume.value = Math.round(value.volume * 100); volume.setAttribute('aria-valuetext', `${volume.value}%`);
    $(`mixer-${channel}-value`).textContent = `${volume.value}%`; $(`mixer-${channel}-muted`).checked = value.muted;
    volume.closest('fieldset').classList.toggle('is-muted', value.muted);
  }
  $('mixer-status').textContent = 'Mixer incluído na sessão e no link.';
}

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
    if (replaceSession(imported)) message('Sessão inteira importada. Desfazer recupera a anterior.');
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
$('apply-share').addEventListener('click', () => { if (sharedSession && replaceSession(sharedSession)) { dismissShare(); message('Sessão recebida aplicada.'); } });
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
$('save-session').addEventListener('click', () => {
  const item = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), session: structuredClone(session) };
  if (writeLibrary([...library.entries, item])) { $('session-library').value = item.id; renderControls(); message('Sessão completa guardada na biblioteca.'); }
});
$('session-library').addEventListener('change', renderControls);
$('restore-session').addEventListener('click', () => { const item = library.entries.find(entry => entry.id === $('session-library').value); if (item) replaceSession(item.session); });
$('delete-session').addEventListener('click', () => writeLibrary(library.entries.filter(entry => entry.id !== $('session-library').value)));
$('download-library-recovery').addEventListener('click', () => { if (library.recoveryRaw !== null) download(library.recoveryRaw, 'groovegoblin-biblioteca-original.json'); });
$('replace-library-recovery').addEventListener('click', () => {
  const original = library.recoveryRaw; library.recoveryRaw = null;
  if (!writeLibrary([{ id: crypto.randomUUID(), savedAt: new Date().toISOString(), session: structuredClone(session) }])) library.recoveryRaw = original;
  renderLibrary();
});

function renderFeedback() {
  $('feedback').replaceChildren(); $('timeline').replaceChildren();
  if (!results) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Conclua um treino para comparar cada ataque e término, notas omitidas e extras.'; $('feedback').append(p); return; }
  renderTimeline($('timeline'), buildTimelineData(results, { session: reference }));
  const summary = summarizeFeedback(results);
  const heading = document.createElement('p'); heading.className = 'timing-counts'; heading.textContent = `Ataques: ${summary.attackOk}/${summary.expected} · términos: ${summary.endOk}/${summary.expected} · alturas: ${summary.pitchOk}/${summary.expected} · ${summary.mode === 'free' ? 'execução livre' : summary.mode === 'style' ? 'estilo expressivo' : 'avaliação estrita'} · referência ${reference.bpm} BPM, ${reference.meter.beats}/${reference.meter.unit}.`;
  $('feedback').append(heading);
  const tolerance = document.createElement('p'); tolerance.className = 'tool-hint muted'; tolerance.textContent = `Tolerância: ±${Math.round(results.toleranceMs)} ms. Negativo = antes; positivo = depois. Feedback baseado na sessão executada, mesmo após editar o arranjo.`; $('feedback').append(tolerance);
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
      else { cell.textContent = row.kind === 'missed' ? 'Omitida' : type === 'onset' ? 'Ataque extra' : `${Math.round((row.actualEnd - row.actualStart) * 1000)} ms`; cell.className = row.kind === 'missed' ? 'missing' : 'extra'; }
      line.append(cell);
    }
    body.append(line);
  }
  table.append(body); scroll.append(table); $('feedback').append(scroll);
}
function frame() {
  const position = audio.position;
  if (position.mode !== lastMode) { lastMode = position.mode; renderControls(); }
  const repertoireBusy = repertoire.isBusy();
  if (repertoireBusy !== lastRepertoireBusy) { lastRepertoireBusy = repertoireBusy; renderControls(); }
  $('playhead').hidden = position.mode === 'idle' || position.mode === 'countin';
  $('playhead').style.left = `${Math.max(0, Math.min(totalTicks(session), position.tick ?? 0)) / totalTicks(session) * 100}%`;
  if ($('studio-editor').open && ['loop', 'train'].includes(position.mode)) {
    const scroll = document.querySelector('.grid-scroll');
    const x = (position.tick ?? 0) / totalTicks(session) * $('grid').clientWidth;
    if (x < scroll.scrollLeft + 16 || x > scroll.scrollLeft + scroll.clientWidth - 32) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 3);
  }
  const marker = position.mode === 'idle' || position.mode === 'countin' ? -1 : chordMarkers.findIndex(item => position.tick >= item.start && position.tick < item.start + item.duration);
  const chordIndex = marker < 0 || !session.progression.enabled ? -1 : marker % session.progression.chords.length;
  if (chordIndex !== activeChordIndex) {
    activeChordIndex = chordIndex;
    Array.from($('progression-chords').children).forEach((item, index) => {
      item.classList.toggle('current', index === chordIndex);
      if (index === chordIndex) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    });
  }
  $('train-pad').classList.toggle('active', ['countin', 'train'].includes(position.mode)); $('train-pad').classList.toggle('held', !!position.held);
  $('held-state').textContent = position.held ? 'PRESSIONADA · nota em curso' : 'ESPAÇO ou toque · pressionar / soltar';
  $('position-text').textContent = position.mode === 'idle' ? pending ? 'Preparando…' : 'Pronto' : `${position.mode === 'countin' ? 'Entrada' : position.mode === 'train' ? 'Treino' : 'Loop'} · compasso ${position.bar ?? Math.floor((position.tick ?? 0) / barTicks(session)) + 1} · tempo ${position.beat ?? 1}${position.mode === 'train' ? ` · ${position.repetition}/${session.training.repetitions}` : ''}`;
  if (position.mode === 'countin') $('train-state').textContent = 'Contagem de entrada. Prepare-se para tocar.';
  if (position.mode === 'train') $('train-state').textContent = `Repetição ${position.repetition}/${session.training.repetitions} · pressione e solte nos limites das notas.`;
  requestAnimationFrame(frame);
}
repertoire = mountRepertoire($('repertoire-mount'), host);
practice = mountPractice($('practice-mount'), host);
playground = mountPlayground($('playground-mount'), host);
journey = mountJourney($('journey-mount'), host);
setupOffline({ isBusy: () => busy() || repertoire.isBusy(), notify: message });
history.push(session); audio.setMixer(session.mixer); renderLibrary(); renderAll();
$('recovery').hidden = recoveryRaw === null; persist();
if (restored.warnings?.length) message(restored.warnings.join(' '), true);
if (library.warning) $('library-status').textContent = library.warning;
previewShare(); requestAnimationFrame(frame);
