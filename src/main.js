import { GrooveAudio, renderSession } from './audio.js';
import { createSession, loadSession, saveSession, validateSession, serializeSession, parseSession, encodeSessionLink, decodeSessionLink, ticksPerBar as barTicks, sessionTicks as totalTicks, DENSITIES, METRONOME_PATTERNS, ARTICULATIONS } from './session.js';
import { evaluateSession, summarizeFeedback } from './feedback.js';
import { buildTimelineData, renderTimeline } from './timeline.js';
import { GROOVES, loadGroove } from './library.js';
import { PROGRESSION_KEYS, CHORD_QUALITIES, getDiatonicChords, getBorrowedChords, getSecondaryDominants, parseChordSymbol, generateProgression, invertChord } from './progression.js';
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

const $ = id => document.getElementById(id);
const restored = loadSession();
let session = withStudioChoices(restored.session);
let recoveryRaw = restored.recoveryRaw;
let sessionSaved = false;
let selected = null;
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
function liveChoice(key) {
  return ['mixer', 'metronome', 'band', 'drums', 'timbres'].includes(key) || (key === 'bpm' && audio.position.mode === 'loop');
}
function updateSession(patch) {
  const live = !exercisePlayback && pending === null && audio.position.mode !== 'idle' && Object.keys(patch).every(liveChoice);
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
  renderControls(); studioTimeline.render(); renderProgression(); renderForm(); renderFeedback();
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
  travelHistory, removeSelected,
});
const studioTimeline = mountStudioTimeline($('studio-editor'), {
  getSession: () => session, isBusy: busy, updateSession,
  getSelection: () => selected,
  setSelection: id => { selected = id; },
  selectionChanged: renderControls, commitNote, notify: message,
});
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
  $('practice-session-title').textContent = session.name;
  $('session-badge').textContent = `${session.meter.beats}/${session.meter.unit} · ${session.bars} comp. · loop ${session.loop.startBar + 1}–${session.loop.endBar}`;
  transport.render();
  $('train').disabled = pending !== null || (session.training.evaluation !== 'free' && !session.notes.some(note => note.start >= session.loop.startBar * barTicks(session) && note.start < session.loop.endBar * barTicks(session)));
  $('train-pad').disabled = !['countin', 'train'].includes(audio.position.mode);
  $('clear').disabled = locked || session.notes.length === 0;
  for (const id of ['generate', 'variation', 'load-groove', 'generate-drums', 'generate-progression', 'add-chord', 'new-session', 'duplicate-session', 'save-session', 'restore-session', 'delete-session', 'replace-recovery', 'replace-library-recovery', 'apply-share']) $(id).disabled = locked;
  $('load-groove').disabled ||= !$('groove-library').value;
  $('restore-session').disabled ||= !$('session-library').value;
  $('delete-session').disabled ||= !$('session-library').value;
  $('apply-share').disabled ||= !sharedSession;
  const note = session.notes.find(item => item.id === selected);
  $('selection-text').textContent = note ? `Nota selecionada · MIDI ${note.pitch} · ${format(note.duration)} ticks` : 'Clique para criar; selecione uma nota para editar.';
  $('note-detail').hidden = !note;
  if (!note) $('note-detail').open = false;
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
  studioTimeline.renderControls();
  $('add-section').disabled = locked || session.form.sections.length >= 32;
  for (const input of document.querySelectorAll('#form-sections input, #form-sections select, #form-sections button')) input.disabled = locked || input.dataset.boundary === 'true';
  practice?.setBusy(locked);
}
function format(number) { return String(Math.round(number * 1000) / 1000); }

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
  if (busy() || !selected) return;
  const notes = updateNote(session.notes, selected, patch, session);
  if (notes === session.notes) { message('Sem sobreposição e sem ultrapassar o fim da frase.', true); renderControls(); return; }
  updateSession({ notes });
}
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

for (const key of PROGRESSION_KEYS) { const option = document.createElement('option'); option.value = key.id; option.textContent = key.label; $('progression-key').append(option); }
function renderProgression() {
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
    const duration = document.createElement('input'); duration.type = 'number'; duration.min = String(1 / session.meter.beats); duration.max = '16'; duration.step = String(1 / session.meter.beats); duration.value = chord.durationBars; duration.setAttribute('aria-label', `Duração do acorde ${index + 1} em compassos`);
    duration.addEventListener('change', () => replaceChord(index, { ...chord, durationBars: Number(duration.value) }));
    const inversion = document.createElement('select'); inversion.setAttribute('aria-label', `Inversão do acorde ${index + 1}`);
    const inversionCount = CHORD_QUALITIES[chord.quality]?.length ?? chord.notes.length;
    for (let value = 0; value < inversionCount; value++) { const option = document.createElement('option'); option.value = value; option.textContent = value === 0 ? 'Fundamental' : `${value}ª inversão`; inversion.append(option); }
    inversion.value = chord.inversion ?? 0;
    inversion.addEventListener('change', () => {
      try { replaceChord(index, invertChord(chord, Number(inversion.value))); }
      catch (error) { message(error.message, true); renderProgression(); }
    });
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
  // Fit the harmonic cycle using whole denominator beats, including 7/8 and
  // progressions with an odd chord count. Extend only when each chord would
  // otherwise get less than one beat; existing phrase notes remain unchanged.
  const bars = Math.max(session.bars, Math.ceil(base.length / session.meter.beats));
  const beats = bars * session.meter.beats;
  const perChord = Math.floor(beats / base.length);
  const remainder = beats % base.length;
  const chords = base.map((chord, index) => ({ ...chord, durationBars: (perChord + (index < remainder ? 1 : 0)) / session.meter.beats }));
  const loop = { ...session.loop, endBar: session.loop.endBar === session.bars ? bars : session.loop.endBar };
  updateSession({ bars, loop, progression: { enabled: true, chords } });
});


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
$('new-session').addEventListener('click', () => {
  if (!busy() && replaceSession(createSession())) message('Nova sessão criada. Desfazer recupera a anterior.');
});
$('duplicate-session').addEventListener('click', () => {
  if (busy()) return;
  const copy = mergeSession(session, { name: `${session.name.slice(0, 112)} · cópia` });
  const item = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), session: copy };
  if (writeLibrary([...library.entries, item]) && replaceSession(copy)) {
    $('session-library').value = item.id; renderControls();
    message('Cópia guardada na biblioteca e aberta. Desfazer recupera a sessão anterior.');
  }
});
$('save-session').addEventListener('click', () => {
  if (busy()) return;
  const item = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), session: structuredClone(session) };
  if (writeLibrary([...library.entries, item])) { $('session-library').value = item.id; renderControls(); message('Sessão completa guardada na biblioteca.'); }
});
$('session-library').addEventListener('change', renderControls);
$('restore-session').addEventListener('click', () => { const item = library.entries.find(entry => entry.id === $('session-library').value); if (item) replaceSession(item.session); });
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
