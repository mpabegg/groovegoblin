import { TICKS_PER_BAR, addNote, moveNote, resizeNote, deleteNote, loadState, saveState, validPhrase, loadPreferences, savePreferences } from './model.js';
import { evaluate, summarizeFeedback } from './feedback.js';
import { GrooveAudio } from './audio.js';
import { History } from './history.js';
import { serializePhrase, parsePhrase, serializeShare, parseShare } from './portable.js';
import { buildTimelineData, renderTimeline } from './timeline.js';
import { GROOVES, loadGroove } from './library.js';
import { generateGroove } from './generator.js';
import { buildRhythmNotation, renderRhythmNotation } from './notation.js';
import { PROGRESSION_KEYS, generateProgression } from './progression.js';
import { generateDrums, DRUM_INSTRUMENTS } from './drums.js';

const $ = id => document.getElementById(id);
const restored = loadState();
const preferences = loadPreferences();
let notes = restored.notes;
let bpm = restored.bpm;
let bars = restored.bars;
let selected = null;
let drag = null;
let starting = false;
let startingMode = null;
let importing = false;
let startGeneration = 0;
let lastMode = 'idle';
let results = null;
let notationNotes = null;
let notationBars = 0;
let recoveryRaw = restored.recoveryRaw;
let sharedPhrase = null;
let activeInput = null;
let progression = generateProgression({ keyId: 'c-major' });
let activeChord = -1;
let drumSeed = 0;
let drumPattern = generateDrums({ notes, bars, seed: drumSeed });
let drumLoading = false;
let drumRequest = 0;
const history = new History(100);

// Durações predefinidas (em semicolcheias) e seus nomes musicais.
const PRESETS = [
  { ticks: 1, label: '1/16' }, { ticks: 2, label: '1/8' }, { ticks: 3, label: '1/8.' },
  { ticks: 4, label: '1/4' }, { ticks: 6, label: '1/4.' }, { ticks: 8, label: '1/2' },
  { ticks: 12, label: '1/2.' }, { ticks: 16, label: '1/1' },
];
const PRESET_KEYS = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit6: 6, Digit8: 8 };

const totalTicks = () => TICKS_PER_BAR * bars;
$('metronome').checked = preferences.metronome;
for (const id of ['density', 'syncopation', 'lengths']) $(id).value = preferences[id];
$('bpm').value = bpm;
$('bars').value = bars;
const audio = new GrooveAudio({ onState: () => renderControls(), onFinish: attempts => {
  results = evaluate(notes, attempts, bpm, bars);
  clearInput();
  renderFeedback();
  $('train-state').textContent = 'Treino concluído. Compare ataque e término abaixo; ouça a referência novamente.';
  renderControls();
} });

function busy() { return starting || importing || audio.position.mode !== 'idle'; }
function progressionSession() { return audio.position.mode === 'progression' || (starting && startingMode === 'progression'); }
function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}
function persist() {
  if (recoveryRaw !== null) {
    $('saved').textContent = 'Edições só na memória · dados anteriores protegidos';
    return;
  }
  $('saved').textContent = saveState(notes, bpm, bars)
    ? 'Salvo neste navegador'
    : 'Só na memória · exporte para não perder';
}
function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('download-recovery').addEventListener('click', () => {
  if (recoveryRaw !== null) download(recoveryRaw, 'groovegoblin-dados-originais.json');
});
$('replace-recovery').addEventListener('click', () => {
  if (busy() || recoveryRaw === null) return;
  if (!saveState(notes, bpm, bars)) {
    message('Não foi possível substituir os dados. Os originais foram preservados; exporte sua frase.', true);
    return;
  }
  recoveryRaw = null;
  $('recovery').hidden = true;
  $('saved').textContent = 'Salvo neste navegador';
  message('Dados salvos substituídos pela frase atual.');
});
function invalidateFeedback() {
  results = null;
  renderFeedback();
}
function commit(next, invalidText = 'Sem sobreposição e sem ultrapassar a barra final.') {
  if (next === notes) { message(invalidText, true); return false; }
  notes = next;
  history.push({ notes, bpm, bars });
  persist();
  invalidateFeedback();
  message('Frase atualizada. Notas vizinhas têm ataques separados.');
  renderNotes();
  refreshDrums();
  return true;
}
function applyState(state) {
  const focusedNote = document.activeElement?.closest('.note')?.dataset.id;
  const focusedTick = document.activeElement?.classList.contains('cell') ? Number(document.activeElement.dataset.tick) : null;
  const oldStart = notes.find(note => note.id === focusedNote)?.start ?? focusedTick;
  cancelDrag();
  notes = state.notes;
  bpm = state.bpm;
  bars = state.bars;
  refreshDrums();
  $('bpm').value = bpm;
  $('bars').value = bars;
  if (!notes.some(n => n.id === selected)) selected = null;
  persist();
  invalidateFeedback();
  renderGrid();
  renderNotes();
  if (focusedNote || focusedTick !== null) {
    const target = focusedNote && $('notes').querySelector(`[data-id="${CSS.escape(focusedNote)}"]`);
    (target || $('cells').querySelector(`[data-tick="${Math.min(oldStart ?? 0, totalTicks() - 1)}"]`))?.focus({ preventScroll: true });
  }
}
function undo() {
  if (busy()) return;
  const state = history.undo();
  if (!state) { message('Nada para desfazer.'); return; }
  applyState(state);
  message('Desfeito.');
}
function redo() {
  if (busy()) return;
  const state = history.redo();
  if (!state) { message('Nada para refazer.'); return; }
  applyState(state);
  message('Refeito.');
}

function renderGrid() {
  const total = totalTicks();
  document.querySelector('.grid-shell').style.minWidth = `${bars * 560}px`;
  $('cells').replaceChildren();
  $('cells').style.gridTemplateColumns = `repeat(${total}, 1fr)`;
  for (let tick = 0; tick < total; tick++) {
    const cell = document.createElement('button');
    cell.type = 'button'; cell.className = 'cell'; cell.dataset.tick = tick;
    const bar = Math.floor(tick / TICKS_PER_BAR) + 1;
    cell.setAttribute('aria-label', `Criar nota no compasso ${bar}, posição ${tick % TICKS_PER_BAR + 1}`);
    cell.addEventListener('click', () => {
      if (busy()) return;
      const next = addNote(notes, tick, 1, bars);
      if (next !== notes) selected = next.find(note => note.start === tick)?.id;
      commit(next, 'Esta posição já está ocupada. Selecione a nota para editá-la.');
    });
    $('cells').append(cell);
  }
  $('marks').replaceChildren();
  for (let tick = 0; tick <= total; tick++) {
    const mark = document.createElement('span');
    mark.className = `mark ${tick % TICKS_PER_BAR === 0 ? 'bar-mark' : tick % 4 === 0 ? 'beat-mark' : tick % 2 === 0 ? 'medium' : ''} ${tick === total ? 'end' : ''}`;
    mark.style.left = `${tick / total * 100}%`;
    $('marks').append(mark);
  }
  const beatLabels = $('beat-labels');
  beatLabels.replaceChildren();
  beatLabels.style.gridTemplateColumns = `repeat(${bars * 4}, 1fr)`;
  for (let bar = 0; bar < bars; bar++) for (let beat = 1; beat <= 4; beat++) {
    const label = document.createElement('span');
    label.textContent = beat === 1 ? `${bar + 1} · ${beat}` : `${beat}`;
    beatLabels.append(label);
  }
  const next = document.createElement('span');
  next.className = 'next-bar'; next.textContent = '1 ↗';
  beatLabels.append(next);
  const subdivisions = $('subdivision-labels');
  subdivisions.replaceChildren();
  subdivisions.style.gridTemplateColumns = `repeat(${bars * 4}, 1fr)`;
  for (let bar = 0; bar < bars; bar++) for (let beat = 1; beat <= 4; beat++) {
    const span = document.createElement('span');
    span.textContent = `${beat} e & a`;
    subdivisions.append(span);
  }
}

function refreshDrums() {
  drumPattern = generateDrums({ notes, bars, seed: drumSeed });
  renderDrums();
}
function renderDrums() {
  const labels = { kick: 'Bumbo', snare: 'Caixa', hihat: 'Chimbal' };
  const total = totalTicks();
  $('drum-rows').replaceChildren();
  for (const instrument of DRUM_INSTRUMENTS) {
    const hits = drumPattern.hits.filter(hit => hit.instrument === instrument);
    const row = document.createElement('div');
    row.className = `drum-lane drum-${instrument}`;
    const label = document.createElement('div');
    label.className = 'drum-label';
    label.textContent = labels[instrument];
    const steps = document.createElement('div');
    steps.className = 'drum-steps';
    steps.style.gridTemplateColumns = `repeat(${total}, 1fr)`;
    steps.setAttribute('role', 'img');
    steps.setAttribute('aria-label', `${labels[instrument]}: ${hits.map(hit => `compasso ${Math.floor(hit.start / TICKS_PER_BAR) + 1}, posição ${hit.start % TICKS_PER_BAR + 1}`).join('; ')}`);
    for (let tick = 0; tick < total; tick += 1) {
      const hit = hits.find(hit => hit.start === tick);
      const step = document.createElement('span');
      step.className = `drum-step${hit ? ' hit' : ''}${hit?.velocity >= 0.5 ? ' accent' : ''}${tick % TICKS_PER_BAR === 0 ? ' bar-start' : ''}`;
      step.textContent = hit ? '●' : '·';
      step.setAttribute('aria-hidden', 'true');
      steps.append(step);
    }
    row.append(label, steps);
    $('drum-rows').append(row);
  }
}

function renderNotes(preview = notes) {
  const focused = document.activeElement;
  const focusedNote = focused?.closest('.note')?.dataset.id;
  const focusedTick = focused?.classList.contains('cell') ? Number(focused.dataset.tick) : null;
  const total = totalTicks();
  $('notes').replaceChildren();
  for (const note of [...preview].sort((a,b) => a.start - b.start)) {
    const block = document.createElement('button');
    block.type = 'button'; block.className = `note${selected === note.id ? ' selected' : ''}`;
    block.dataset.id = note.id; block.dataset.start = note.start; block.dataset.duration = note.duration;
    block.style.left = `calc(${note.start / total * 100}% + 2px)`;
    block.style.width = `calc(${note.duration / total * 100}% - 4px)`;
    block.disabled = busy();
    const bar = Math.floor(note.start / TICKS_PER_BAR) + 1;
    block.setAttribute('aria-label', `Nota: compasso ${bar}, posição ${note.start % TICKS_PER_BAR + 1}, duração ${note.duration} semicolcheias`);
    block.setAttribute('aria-pressed', selected === note.id);
    block.title = `Compasso ${bar} · início ${note.start % TICKS_PER_BAR + 1} · duração ${note.duration}/16. Arraste; borda direita redimensiona.`;
    block.append(document.createTextNode(PRESETS.find(p => p.ticks === note.duration)?.label ?? `${note.duration}/16`));
    const handle = document.createElement('span'); handle.className = 'handle'; handle.dataset.resize = 'true'; handle.setAttribute('aria-hidden','true'); block.append(handle);
    block.addEventListener('click', () => { if (!busy()) { selected = note.id; block.focus({ preventScroll: true }); renderNotes(); } });
    $('notes').append(block);
  }
  if (notationNotes !== preview || notationBars !== bars) {
    renderRhythmNotation($('rhythm-score'), buildRhythmNotation(preview, bars));
    notationNotes = preview;
    notationBars = bars;
  }
  if (focusedNote || focusedTick !== null) {
    const target = $('notes').querySelector(`[data-id="${CSS.escape(selected ?? focusedNote ?? '')}"]`)
      ?? $('cells').querySelector(`[data-tick="${focusedTick ?? 0}"]`);
    target?.focus({ preventScroll: true });
  }
  renderControls();
}
function cancelDrag() {
  if (drag && $('grid').hasPointerCapture(drag.pointer)) $('grid').releasePointerCapture(drag.pointer);
  drag = null;
}
$('grid').addEventListener('pointerdown', event => {
  const block = event.target.closest('.note');
  if (!block || busy() || event.button !== 0) return;
  event.preventDefault();
  const note = notes.find(n => n.id === block.dataset.id);
  selected = note.id;
  drag = { id: note.id, x: event.clientX, start: note.start, duration: note.duration, resize: !!event.target.closest('.handle'), original: notes, next: notes, pointer: event.pointerId };
  $('grid').setPointerCapture(event.pointerId);
  renderNotes();
});
$('grid').addEventListener('pointermove', event => {
  if (!drag || drag.pointer !== event.pointerId || busy()) return;
  const delta = Math.round((event.clientX - drag.x) / $('grid').getBoundingClientRect().width * totalTicks());
  const next = drag.resize ? resizeNote(drag.original, drag.id, drag.duration + delta, bars) : moveNote(drag.original, drag.id, drag.start + delta, bars);
  if (next === drag.original && delta !== 0) message('Limite: não é possível sobrepor notas ou sair do fim da frase.', true);
  else message(drag.resize ? 'Duração quantizada em semicolcheias.' : 'Início quantizado em semicolcheias.');
  drag.next = next;
  renderNotes(next);
});
$('grid').addEventListener('pointerup', event => {
  if (!drag || drag.pointer !== event.pointerId) return;
  const next = drag.next; drag = null;
  $('grid').releasePointerCapture(event.pointerId);
  if (!busy() && next !== notes) commit(next); else renderNotes();
});
$('grid').addEventListener('pointercancel', () => { drag = null; renderNotes(); });

function renderControls() {
  const locked = busy();
  const note = notes.find(n => n.id === selected);
  if (!note) selected = null;
  const playingProgression = audio.position.mode === 'progression';
  $('play').disabled = (locked && !playingProgression) || notes.length === 0;
  $('train').disabled = (locked && !playingProgression) || notes.length === 0;
  $('stop').disabled = !starting && audio.position.mode === 'idle';
  $('bpm').disabled = locked;
  $('bars').disabled = locked;
  $('metronome').disabled = importing || starting || ['train','countin'].includes(audio.position.mode);
  const training = ['train', 'countin'].includes(audio.position.mode);
  $('drums-enabled').disabled = importing || starting || training || playingProgression;
  $('generate-drums').disabled = locked || drumLoading;
  const drumsEnabled = $('drums-enabled').checked;
  $('drum-lanes').classList.toggle('drums-off', !drumsEnabled || training || playingProgression);
  $('drums-state').textContent = drumLoading
    ? 'Carregando samples…'
    : training ? 'Silenciada durante o treino'
      : playingProgression ? 'Silenciada durante a progressão'
        : !drumsEnabled ? 'Desligada · frase continua sem bateria'
          : audio.position.mode === 'play' ? 'Ligada · tocando no mesmo loop' : 'Ligada · pronta para ouvir';
  $('clear').disabled = locked || notes.length === 0;
  $('delete').disabled = locked || !note;
  $('undo').disabled = locked || !history.canUndo;
  $('redo').disabled = locked || !history.canRedo;
  for (const id of ['groove-library', 'density', 'syncopation', 'lengths', 'seed', 'generate', 'variation']) $(id).disabled = locked;
  $('load-groove').disabled = locked || !$('groove-library').value;
  $('export').disabled = locked;
  $('import').disabled = locked;
  $('share').disabled = locked;
  $('apply-share').disabled = locked || !sharedPhrase;
  $('replace-recovery').disabled = locked;
  $('train-pad').disabled = !['countin', 'train'].includes(audio.position.mode);
  $('progression-key').disabled = $('generate-progression').disabled = importing || (locked && !progressionSession());
  $('play-progression').disabled = importing || progressionSession();
  $('stop-progression').disabled = !progressionSession();
  const key = PROGRESSION_KEYS.find(item => item.id === progression.keyId);
  $('progression-status').textContent = `${progressionSession() ? 'Em loop' : 'Pronta para ouvir'} · ${key.label} · ${progression.chords.length} acordes.`;
  const editable = locked || !note;
  $('note-start').disabled = $('note-duration').disabled = editable;
  $('note-start').max = $('note-duration').max = totalTicks();
  $('note-start').value = note ? note.start + 1 : '';
  $('note-duration').value = note?.duration ?? '';
  for (const preset of $('presets').children) preset.disabled = editable || !PRESETS.some(p => p.ticks === Number(preset.dataset.ticks) && p.ticks + note?.start <= totalTicks());
  $('selection-text').textContent = note ? `Nota selecionada · ${note.duration} semicolcheia${note.duration === 1 ? '' : 's'} (${PRESETS.find(p => p.ticks === note.duration)?.label ?? `${note.duration}/16`})` : 'Clique para criar · arraste para mover · puxe a borda direita para durar · setas movem/redimensionam.';
  document.querySelectorAll('.cell, .note').forEach(element => { element.disabled = locked; });
}
for (const preset of PRESETS) {
  const chip = document.createElement('button');
  chip.type = 'button'; chip.className = 'preset'; chip.dataset.ticks = preset.ticks;
  chip.textContent = preset.label;
  chip.title = `${preset.ticks} semicolcheia${preset.ticks === 1 ? '' : 's'}`;
  chip.addEventListener('click', () => {
    if (busy() || !selected) return;
    commit(resizeNote(notes, selected, preset.ticks, bars), 'Esta duração não cabe a partir do início da nota.');
  });
  $('presets').append(chip);
}

$('note-start').addEventListener('change', event => { if (!busy() && selected) commit(moveNote(notes, selected, Number(event.target.value) - 1, bars)); renderControls(); });
$('note-duration').addEventListener('change', event => { if (!busy() && selected) commit(resizeNote(notes, selected, Number(event.target.value), bars)); renderControls(); });
function removeSelected() {
  if (busy() || !selected) return;
  const note = notes.find(item => item.id === selected);
  const wasFocused = document.activeElement?.classList.contains('note');
  const next = deleteNote(notes, selected);
  selected = null;
  commit(next);
  if (wasFocused) $('cells').querySelector(`[data-tick="${note.start}"]`)?.focus({ preventScroll: true });
}
$('delete').addEventListener('click', removeSelected);
$('clear').addEventListener('click', () => { if (!busy()) { selected = null; commit([]); } });
$('bpm').addEventListener('change', event => {
  const value = Number(event.target.value);
  if (Number.isInteger(value) && value >= 40 && value <= 240 && !busy()) {
    bpm = value;
    history.push({ notes, bpm, bars });
    persist(); invalidateFeedback(); message(`Tempo: ${bpm} BPM.`);
  }
  else message('Use um BPM inteiro entre 40 e 240.', true);
  event.target.value = bpm;
  renderControls();
});
$('bars').addEventListener('change', event => {
  const value = Number(event.target.value);
  if (busy()) { event.target.value = bars; return; }
  if (!validPhrase(notes, value)) {
    message('Há notas além do novo tamanho. Mova-as antes de reduzir a frase.', true);
    event.target.value = bars;
    return;
  }
  bars = value;
  refreshDrums();
  history.push({ notes, bpm, bars });
  persist(); invalidateFeedback();
  renderGrid(); renderNotes();
  message(`Frase com ${bars} compasso${bars === 1 ? '' : 's'}.`);
});
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('export').addEventListener('click', () => {
  if (busy()) return;
  try {
    const text = serializePhrase({ notes, bpm, bars });
    download(text, 'groovegoblin-frase.json');
    message('Frase exportada como arquivo JSON.');
  } catch (error) {
    message(`Não foi possível exportar: ${error.message}`, true);
  }
});
$('import').addEventListener('click', () => { if (!busy()) $('import-file').click(); });
$('import-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || busy()) return;
  importing = true;
  cancelDrag();
  renderControls();
  try {
    const parsed = parsePhrase(await file.text());
    if (!parsed.ok) { message(`Importação rejeitada: ${parsed.error}`, true); return; }
    const state = { notes: parsed.notes, bpm: parsed.bpm, bars: parsed.bars };
    history.push(state);
    selected = null;
    applyState(state);
    message(`Frase importada: ${parsed.bars} compasso${parsed.bars === 1 ? '' : 's'}, ${parsed.bpm} BPM.`);
  } catch {
    message('Não foi possível ler o arquivo. A frase atual foi preservada.', true);
  } finally {
    importing = false;
    renderControls();
  }
});
$('share').addEventListener('click', async () => {
  if (busy()) return;
  try {
    const url = serializeShare({ notes, bpm, bars }, location.href);
    $('share-url').value = url;
    $('share-output').hidden = false;
    $('share-url').focus(); $('share-url').select();
    try {
      await navigator.clipboard.writeText(url);
      message('Link copiado. A frase fica no próprio link, sem servidor.');
    } catch {
      message('Copie o link selecionado; a área de transferência não está disponível.');
    }
  } catch (error) { message(`Não foi possível compartilhar: ${error.message}`, true); }
});
function previewShare() {
  sharedPhrase = null;
  $('share-preview').hidden = true;
  if (!location.hash) { renderControls(); return; }
  const parsed = parseShare(location.hash);
  if (!parsed.ok) { message(`Link rejeitado: ${parsed.error} Sua frase foi preservada.`, true); renderControls(); return; }
  sharedPhrase = { notes: parsed.notes, bpm: parsed.bpm, bars: parsed.bars };
  $('share-description').textContent = `${parsed.notes.length} notas · ${parsed.bars} compasso${parsed.bars === 1 ? '' : 's'} · ${parsed.bpm} BPM.`;
  $('share-preview').hidden = false;
  renderControls();
}
function dismissShare() {
  sharedPhrase = null;
  $('share-preview').hidden = true;
  window.history.replaceState(null, '', `${location.pathname}${location.search}`);
  renderControls();
}
$('dismiss-share').addEventListener('click', dismissShare);
$('apply-share').addEventListener('click', () => {
  if (busy() || !sharedPhrase) return;
  replacePhrase(sharedPhrase);
  dismissShare();
  message('Frase recebida aplicada. Desfazer recupera sua frase anterior.');
});
window.addEventListener('hashchange', previewShare);
function persistPreferences() {
  const seed = $('seed').value === '' ? NaN : Number($('seed').value);
  const saved = savePreferences({
    metronome: $('metronome').checked,
    density: $('density').value, syncopation: $('syncopation').value,
    lengths: $('lengths').value, seed,
  });
  if (!saved) message('Preferências não salvas: use uma semente inteira válida e armazenamento disponível.', true);
}
$('metronome').addEventListener('change', event => { audio.setMetronome(event.target.checked); persistPreferences(); });
for (const id of ['density', 'syncopation', 'lengths', 'seed']) $(id).addEventListener('change', persistPreferences);
$('generate-drums').addEventListener('click', () => {
  if (busy() || drumLoading) return;
  drumSeed = newSeed();
  refreshDrums();
  $('drums-enabled').checked = true;
  renderControls();
  message('Bateria gerada. Sua frase, BPM e compassos foram preservados.');
});
$('drums-enabled').addEventListener('change', async event => {
  const enabled = event.target.checked;
  const request = ++drumRequest;
  drumLoading = enabled && audio.position.mode === 'play';
  renderControls();
  try {
    await audio.setDrumsEnabled(enabled);
  } catch (error) {
    if (request === drumRequest) {
      $('drums-enabled').checked = false;
      message(`${error.message}. A frase continua tocando sem bateria; tente ativar novamente.`, true);
    }
  } finally {
    if (request === drumRequest) { drumLoading = false; renderControls(); }
  }
});
function replacePhrase(state) {
  history.push(state);
  selected = null;
  applyState(state);
}
for (const groove of GROOVES) {
  const option = document.createElement('option');
  option.value = groove.id;
  option.textContent = `${groove.name} · ${groove.bars} compasso${groove.bars === 1 ? '' : 's'}`;
  $('groove-library').append(option);
}
$('groove-library').addEventListener('change', () => {
  const groove = GROOVES.find(item => item.id === $('groove-library').value);
  const description = $('groove-description');
  description.replaceChildren();
  if (groove) {
    for (const text of [groove.description, groove.durationNote]) {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      description.append(paragraph);
    }
    for (const source of groove.sources) {
      const link = document.createElement('a');
      link.href = source.url; link.textContent = source.title;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      description.append(link);
    }
  } else description.textContent = 'Escolha um groove para conhecer seus ataques e suas fontes.';
  renderControls();
});
$('load-groove').addEventListener('click', () => {
  if (busy() || !$('groove-library').value) return;
  const groove = GROOVES.find(item => item.id === $('groove-library').value);
  replacePhrase(loadGroove(groove.id));
  message(`Padrão carregado: ${groove.name}. Você pode editar todas as notas.`);
});
function newSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
function generate(variation) {
  if (busy()) return;
  if (variation) $('seed').value = newSeed();
  try {
    const generated = generateGroove({
      bars, seed: $('seed').value === '' ? NaN : Number($('seed').value),
      density: $('density').value, syncopation: $('syncopation').value, lengths: $('lengths').value,
    });
    persistPreferences();
    replacePhrase({ notes: generated.notes, bpm, bars: generated.bars });
    message(`Groove gerado · semente ${generated.seed}. Edite livremente ou peça outra variação.`);
  } catch (error) {
    message(error.message, true);
  }
}
$('seed').value = preferences.seed ?? newSeed();
if (preferences.seed === null) persistPreferences();
$('generate').addEventListener('click', () => generate(false));
$('variation').addEventListener('click', () => generate(true));
for (const key of PROGRESSION_KEYS) {
  const option = document.createElement('option');
  option.value = key.id; option.textContent = key.label;
  $('progression-key').append(option);
}
$('progression-key').value = progression.keyId;
function renderProgression() {
  const items = progression.chords.map((chord, index) => {
    const item = document.createElement('li');
    item.className = 'progression-chord';
    const degree = document.createElement('span');
    degree.textContent = `Compasso ${index + 1} · ${chord.roman} · grau ${chord.degree}`;
    const symbol = document.createElement('strong');
    symbol.textContent = chord.symbol;
    const tones = document.createElement('span');
    tones.textContent = chord.notes.map(note => note.name).join(' · ');
    item.append(degree, symbol, tones);
    return item;
  });
  $('progression-chords').replaceChildren(...items);
  activeChord = -1;
}
function regenerateProgression() {
  if (importing || (busy() && !progressionSession())) return;
  const restart = progressionSession();
  if (restart) stop();
  progression = generateProgression({ keyId: $('progression-key').value });
  renderProgression();
  renderControls();
  if (restart) void begin('progression');
}
$('progression-key').addEventListener('change', regenerateProgression);
$('generate-progression').addEventListener('click', regenerateProgression);
$('play-progression').addEventListener('click', () => begin('progression'));
$('stop-progression').addEventListener('click', () => stop('Progressão parada.'));
async function begin(mode) {
  if (importing || (mode !== 'progression' && (!notes.length || (busy() && audio.position.mode !== 'progression')))) return;
  if (busy()) stop();
  const generation = ++startGeneration;
  cancelDrag();
  if (mode === 'train') {
    $('inspiration').open = false;
    $('grid').scrollIntoView({ block: 'start' });
  }
  startingMode = mode;
  drumLoading = mode === 'play' && $('drums-enabled').checked;
  starting = true; renderNotes();
  try {
    if (mode === 'train') { invalidateFeedback(); await audio.train(notes, bpm, bars); }
    else if (mode === 'progression') await audio.playProgression(progression, bpm, $('metronome').checked);
    else await audio.play(notes, bpm, $('metronome').checked, bars, { hits: drumPattern.hits, enabled: $('drums-enabled').checked });
  } catch (error) {
    if (generation === startGeneration) { audio.stop(); message(`Não foi possível iniciar o áudio: ${error.message}`, true); }
  } finally {
    if (generation === startGeneration) { starting = false; startingMode = null; drumLoading = false; renderControls(); }
  }
}
$('play').addEventListener('click', () => begin('play'));
$('train').addEventListener('click', () => begin('train'));
function stop(reason) {
  const wasTrain = ['countin','train'].includes(audio.position.mode);
  ++startGeneration;
  starting = false;
  startingMode = null;
  ++drumRequest;
  drumLoading = false;
  cancelDrag();
  audio.stop();
  clearInput();
  if (wasTrain) $('train-state').textContent = 'Treino interrompido; resultado parcial descartado. Comece novamente.';
  if (reason) message(reason);
  renderNotes();
}
$('stop').addEventListener('click', () => stop('Sessão parada.'));
function clearInput() {
  const input = activeInput;
  activeInput = null;
  if (input?.source === 'pointer' && $('train-pad').hasPointerCapture(input.id)) $('train-pad').releasePointerCapture(input.id);
}
$('train-pad').addEventListener('pointerdown', event => {
  if (event.button !== 0 || activeInput || !['countin', 'train'].includes(audio.position.mode)) return;
  event.preventDefault();
  activeInput = { source: 'pointer', id: event.pointerId };
  $('train-pad').focus({ preventScroll: true });
  $('train-pad').setPointerCapture(event.pointerId);
  audio.press(event.timeStamp);
});
$('train-pad').addEventListener('pointerup', event => {
  if (activeInput?.source !== 'pointer' || activeInput.id !== event.pointerId) return;
  audio.release(event.timeStamp);
  clearInput();
});
for (const type of ['pointercancel', 'lostpointercapture']) $('train-pad').addEventListener(type, event => {
  if (activeInput?.source === 'pointer' && activeInput.id === event.pointerId) stop('Treino interrompido pelo cancelamento do toque. Comece novamente.');
});
const editingTarget = event => event.target instanceof Element && !!event.target.closest('input, textarea, select, [contenteditable=true]');
window.addEventListener('keydown', event => {
  const trainingKey = event.code === 'Space' || (event.code === 'Enter' && event.target === $('train-pad'));
  if (trainingKey && ['countin','train'].includes(audio.position.mode)) {
    event.preventDefault();
    if (!event.repeat && !activeInput) {
      activeInput = { source: 'keyboard', id: event.code };
      audio.press(event.timeStamp);
    }
    return;
  }
  if (editingTarget(event)) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); return; }
  if (event.key === 'Escape' && busy()) { stop('Sessão interrompida.'); return; }
  if (busy() || !selected) return;
  const note = notes.find(n => n.id === selected);
  const step = event.shiftKey ? 4 : 1;
  if (event.key === 'ArrowLeft') { event.preventDefault(); commit(moveNote(notes, selected, note.start - step, bars)); }
  if (event.key === 'ArrowRight') { event.preventDefault(); commit(moveNote(notes, selected, note.start + step, bars)); }
  if (event.key === 'ArrowDown') { event.preventDefault(); commit(resizeNote(notes, selected, note.duration - step, bars)); }
  if (event.key === 'ArrowUp') { event.preventDefault(); commit(resizeNote(notes, selected, note.duration + step, bars)); }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && PRESET_KEYS[event.code]) {
    event.preventDefault();
    commit(resizeNote(notes, selected, PRESET_KEYS[event.code], bars), 'Esta duração não cabe a partir do início da nota.');
  }
});
window.addEventListener('keyup', event => {
  if (activeInput?.source !== 'keyboard' || activeInput.id !== event.code) return;
  event.preventDefault();
  audio.release(event.timeStamp);
  clearInput();
});
window.addEventListener('blur', () => { if (busy()) stop('Sessão interrompida ao perder o foco.'); });
document.addEventListener('visibilitychange', () => { if (document.hidden && busy()) stop('Sessão interrompida ao trocar de aba.'); });

function describeTiming(value, type) {
  const ms = Math.round(value);
  if (Math.abs(value) <= results.toleranceMs) return { text: `Dentro da tolerância (${ms > 0 ? '+' : ''}${ms} ms)`, className: 'ok' };
  return { text: `${value < 0 ? type === 'onset' ? 'Adiantado' : 'Antes do esperado' : type === 'onset' ? 'Atrasado' : 'Depois do esperado'} · ${ms > 0 ? '+' : ''}${ms} ms`, className: 'error-timing' };
}
function renderFeedback() {
  $('feedback').replaceChildren();
  if (!results) {
    $('timeline').replaceChildren();
    const text = document.createElement('p'); text.className = 'muted'; text.textContent = 'Ao concluir o treino, cada ataque e cada término aparecerão separados, além de notas omitidas e extras.'; $('feedback').append(text); return;
  }
  renderTimeline($('timeline'), buildTimelineData(results, { bpm, bars }));
  const summary = document.createElement('p'); summary.className = 'result-summary';
  const matched = results.rows.filter(r => r.kind === 'matched').length;
  summary.textContent = `${matched} notas associadas · ${results.rows.filter(r => r.kind === 'missed').length} omitidas · ${results.rows.filter(r => r.kind === 'extra').length} extras. Tolerância de ataque e término: ±${Math.round(results.toleranceMs)} ms. Janela máxima de associação do ataque: ${Math.round(results.matchWindowMs)} ms. Valores negativos = antes; positivos = depois. Referência usada: ${bpm} BPM, ${bars} compasso${bars === 1 ? '' : 's'}.`;
  $('feedback').append(summary);
  const overview = summarizeFeedback(results);
  const counts = document.createElement('p'); counts.className = 'timing-counts';
  counts.textContent = `Ataques dentro da tolerância: ${overview.attackOk}/${overview.expected} · Términos dentro da tolerância: ${overview.endOk}/${overview.expected}. Contagens independentes; notas sem associação não contam como acertos.`;
  $('feedback').append(counts);
  const advice = document.createElement('div'); advice.className = 'practice-advice';
  const heading = document.createElement('h3'); heading.textContent = 'Próximo passo'; advice.append(heading);
  for (const text of overview.advice) { const paragraph = document.createElement('p'); paragraph.textContent = text; advice.append(paragraph); }
  $('feedback').append(advice);
  const bar = 240 / bpm;
  for (let repetition = 1; repetition <= 4; repetition++) {
    const section = document.createElement('div'); section.className = 'result-rep';
    const title = document.createElement('h3'); title.textContent = `Repetição ${repetition} / 4`; section.append(title);
    const scroll = document.createElement('div'); scroll.className = 'table-scroll';
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Nota / posição</th><th>Ataque</th><th>Término</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const row of results.rows.filter(row => row.repetition === repetition)) {
      const tr = document.createElement('tr'); tr.dataset.kind = row.kind;
      const label = document.createElement('td');
      const position = row.kind === 'extra' ? (row.actualStart - (repetition - 1) * bar * bars) / bar * 16 + 1 : (row.expectedStart - (repetition - 1) * bar * bars) / bar * 16 + 1;
      label.textContent = `${row.kind === 'extra' ? 'Extra' : 'Nota'} · posição ${Math.round(position * 10) / 10}`;
      tr.append(label);
      for (const type of ['onset', 'end']) {
        const cell = document.createElement('td');
        if (row.kind === 'matched') { const description = describeTiming(type === 'onset' ? row.onsetMs : row.endMs, type); cell.textContent = description.text; cell.className = description.className; }
        else { cell.textContent = row.kind === 'missed' ? 'Omitida' : type === 'onset' ? 'Ataque extra' : `Duração ${Math.round((row.actualEnd - row.actualStart) * 1000)} ms`; cell.className = row.kind === 'missed' ? 'missing' : 'extra'; }
        tr.append(cell);
      }
      body.append(tr);
    }
    if (!body.children.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 3; td.textContent = 'Nenhuma nota nesta repetição.'; tr.append(td); body.append(tr); }
    table.append(body); scroll.append(table); section.append(scroll); $('feedback').append(section);
  }
}
function frame() {
  const position = audio.position;
  if (position.mode !== lastMode) { lastMode = position.mode; renderControls(); }
  const total = totalTicks();
  $('playhead').hidden = position.mode === 'idle' || position.mode === 'progression';
  $('playhead').style.left = `${Math.max(0, Math.min(position.mode === 'countin' ? TICKS_PER_BAR : total, position.tick)) / total * 100}%`;
  $('drum-playhead').hidden = position.mode !== 'play';
  $('drum-playhead').style.left = $('playhead').style.left;
  if (position.mode !== 'idle' && position.mode !== 'progression') {
    const scroll = document.querySelector('.grid-scroll');
    const x = position.tick / total * $('grid').clientWidth;
    if (x < scroll.scrollLeft + 16 || x > scroll.scrollLeft + scroll.clientWidth - 32) {
      scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 3);
    }
  }
  const chordIndex = position.mode === 'progression' ? position.bar - 1 : -1;
  if (chordIndex !== activeChord) {
    activeChord = chordIndex;
    Array.from($('progression-chords').children).forEach((item, index) => {
      item.classList.toggle('current', index === chordIndex);
      if (index === chordIndex) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  }
  const activeTraining = ['countin','train'].includes(position.mode);
  $('train-pad').classList.toggle('active', activeTraining);
  $('train-pad').classList.toggle('held', position.held);
  $('held-state').textContent = position.held ? 'PRESSIONADA · nota em curso' : 'ESPAÇO ou toque · pressionar / soltar';
  const where = position.mode === 'idle' ? 'Pronto para compor' : `compasso ${position.bar}${position.mode === 'train' ? ` · repetição ${position.repetition}/4` : ''} · tempo ${position.beat}`;
  $('position-text').textContent = position.mode === 'idle' ? where : `${position.mode === 'countin' ? 'Entrada' : position.mode === 'train' ? 'Treino' : position.mode === 'progression' ? 'Harmonia' : 'Loop'} · ${where}`;
  if (position.mode === 'countin') $('train-state').textContent = `Contagem de entrada · ${position.beat} / 4. Aguarde para tocar.`;
  if (position.mode === 'train') $('train-state').textContent = `Repetição ${position.repetition} / 4 · compasso ${position.bar} · pressione e solte nos limites de cada nota.`;
  requestAnimationFrame(frame);
}
history.push({ notes, bpm, bars });
renderProgression();
renderDrums();
renderGrid(); renderNotes(); renderFeedback();
if (restored.warning) message(restored.warning, true);
$('recovery').hidden = recoveryRaw === null;
$('saved').textContent = recoveryRaw !== null ? 'Edições só na memória · dados anteriores protegidos'
  : restored.storageAvailable ? (restored.notes.length ? 'Frase restaurada neste navegador' : 'Pronto · mudanças serão salvas neste navegador')
    : 'Só na memória · exporte para não perder';
previewShare();
requestAnimationFrame(frame);
