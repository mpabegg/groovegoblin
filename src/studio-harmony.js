import { ticksPerBar, sessionTicks } from './session.js';
import { PROGRESSION_KEYS, CHORD_QUALITIES, chordTimeline, getDiatonicChords, getBorrowedChords, getSecondaryDominants, parseChordSymbol, generateProgression, invertChord } from './progression.js';
import { mountStudioChordSelection } from './studio-chord-selection.js';
import { musicalDuration } from './studio-bars.js';
import { mountStudioFretboard } from './studio-fretboard.js';
import { mountNamedProgressions } from './studio-progressions.js';

const EPSILON = 1e-8;
const number = value => String(Math.round(value * 1000) / 1000);
const snap = (bar, beats) => Math.round(bar * beats) / beats;

// A single allocation of whole written beats: never extends the source session.
export function fitHarmony(chords, session) {
  const beatCount = session.bars * session.meter.beats;
  const source = chords.slice(0, beatCount);
  if (!source.length) return [];
  const perChord = Math.floor(beatCount / source.length);
  const remainder = beatCount % source.length;
  let startBeat = 0;
  return source.map((chord, index) => {
    const durationBeats = perChord + (index < remainder ? 1 : 0);
    const positioned = { ...chord, startBar: startBeat / session.meter.beats, durationBars: durationBeats / session.meter.beats };
    startBeat += durationBeats;
    return positioned;
  });
}

// Occupied drops reorder identities across existing slots, preserving every pause.
// Empty drops move only the selected event, retaining its duration.
export function editHarmony(progression, index, startBar, durationBars, reorder = false) {
  const original = progression.chords[index];
  if (!original || startBar < -EPSILON || startBar >= progression.cycleBars || durationBars <= EPSILON) return null;
  const target = progression.chords.findIndex((chord, i) => i !== index && startBar >= chord.startBar - EPSILON && startBar < chord.startBar + chord.durationBars - EPSILON);
  if (reorder && target >= 0) {
    const identities = [...progression.chords];
    identities.splice(target, 0, identities.splice(index, 1)[0]);
    return { chords: identities.map((chord, i) => ({ ...chord, startBar: progression.chords[i].startBar, durationBars: progression.chords[i].durationBars })), index: target };
  }
  if (startBar + durationBars > progression.cycleBars + EPSILON) return null;
  if (progression.chords.some((chord, i) => i !== index && startBar < chord.startBar + chord.durationBars - EPSILON && startBar + durationBars > chord.startBar + EPSILON)) return null;
  const replacement = { ...original, startBar: Math.max(0, startBar), durationBars };
  const chords = progression.chords.map((chord, i) => i === index ? replacement : chord).sort((a, b) => a.startBar - b.startBar);
  return { chords, index: chords.indexOf(replacement) };
}

// Host owns history, one note/chord selection, and the only audio clock.
export function mountStudioHarmony(root, host) {
  const $ = id => document.getElementById(id);
  const lane = $('chord-lane');
  let drag = null;
  let cursor = 0;
  let suppressClick = false;
  let markers = [];
  let activeChord = -1;
  let inspectorSignature = '';
  const selectedIndex = () => host.getChordSelection();
  const focusChord = index => (lane.querySelector(`[data-index="${index}"][tabindex="0"]`) ?? lane.querySelector(`[data-index="${index}"]`))?.focus({ preventScroll: true });
  const group = mountStudioChordSelection(lane, host);
  const fretboard = mountStudioFretboard(host);
  const named = mountNamedProgressions(host);

  for (const key of PROGRESSION_KEYS) {
    const option = document.createElement('option'); option.value = key.id; option.textContent = key.label; $('progression-key').append(option);
  }
  function select(index) {
    host.setChordSelection(index); host.selectionChanged?.(); renderLane(); renderInspector();
    const chord = host.getSession().progression.chords[index]; if (chord) host.auditionChord?.(chord);
  }
  function apply(chords, index, extra = {}, notice = null, structural = false) {
    const previous = host.getEditorSelection();
    host.setChordSelection(index);
    const session = host.getSession();
    if (!host.updateSession({ progression: { ...session.progression, chords, cycleBars: session.progression.cycleBars, ...extra } }, { notice, structural })) {
      host.setEditorSelection(previous); host.selectionChanged?.(); render(); return false;
    }
    return true;
  }
  function replaceSelected(replacement) {
    if (host.isBusy()) return;
    const session = host.getSession(); const index = selectedIndex(); const chord = session.progression.chords[index];
    if (!chord) return;
    const next = { ...replacement, startBar: chord.startBar, durationBars: chord.durationBars };
    if (apply(session.progression.chords.map((value, i) => i === index ? next : value), index)) host.auditionChord?.(next);
  }
  function removeSelected() { group.remove(); }
  function create(bar) {
    if (host.isBusy()) return;
    const session = host.getSession(); const progression = session.progression;
    const startBar = Math.floor(Math.max(0, bar) % progression.cycleBars + EPSILON);
    if (progression.chords.length >= 64) { host.notify('A sessão admite até 64 acordes.', true); return; }
    const next = progression.chords.find(chord => chord.startBar > startBar);
    const durationBars = Math.min(1, progression.cycleBars - startBar, next ? next.startBar - startBar : Infinity);
    if (durationBars < 1 / session.meter.beats - EPSILON || progression.chords.some(chord => startBar < chord.startBar + chord.durationBars - EPSILON && startBar + durationBars > chord.startBar + EPSILON)) {
      host.notify('Posição ocupada. Selecione ou mova o acorde existente.', true); return;
    }
    const chord = { ...getDiatonicChords(progression.keyId)[0], startBar, durationBars, inversion: 0 };
    const chords = [...progression.chords, chord].sort((a, b) => a.startBar - b.startBar);
    if (apply(chords, chords.indexOf(chord), { enabled: true })) { focusChord(chords.indexOf(chord)); host.auditionChord?.(chord); }
  }
  function generate() {
    if (host.isBusy()) return;
    const session = host.getSession(); const mode = $('progression-function').value;
    if (named.generate(mode)) return;
    const diatonic = getDiatonicChords(session.progression.keyId);
    const degrees = mode === 'cadence' ? [1, 4, 5, 1] : [1, 6, 2, 5];
    const base = mode === 'random' ? generateProgression({ keyId: session.progression.keyId }).chords : degrees.map(degree => degree === 5 && session.progression.keyId.endsWith('-minor') ? getBorrowedChords(session.progression.keyId).find(chord => chord.roman === 'V7') : diatonic[degree - 1]);
    if (apply(fitHarmony(base, session), null, { enabled: true, cycleBars: session.bars }, `Progressão aplicada aos ${session.bars} compassos.`, true)) {
      $('harmony-options').open = false;
    }
  }
  $('generate-progression').addEventListener('click', generate);
  $('fit-progression').addEventListener('click', () => {
    if (host.isBusy()) return;
    const session = host.getSession();
    if (!session.progression.chords.length) { host.notify('Crie um acorde antes de ajustar o ciclo.'); return; }
    apply(fitHarmony(session.progression.chords, session), null, { cycleBars: session.bars }, 'Acordes ajustados ao tamanho da sessão, sem pausas.');
  });
  $('delete-chord').addEventListener('click', removeSelected);
  $('chord-symbol').addEventListener('change', event => {
    try { replaceSelected(parseChordSymbol(event.target.value)); }
    catch (error) { host.notify(error.message, true); inspectorSignature = ''; renderInspector(); }
  });

  function barAt(event) {
    const box = lane.getBoundingClientRect();
    return Math.max(0, Math.min(host.getSession().bars - EPSILON, (event.clientX - box.left) / box.width * host.getSession().bars));
  }
  lane.addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; return; }
    const block = event.target.closest('.studio-chord');
    if (block?.dataset.ghost === 'true') { host.offerMaterialize(Number(block.dataset.start) / ticksPerBar(host.getSession()), block); return; }
    if (block) { if (!host.isBusy()) select(Number(block.dataset.index)); }
    else { cursor = Math.floor(barAt(event)); create(cursor); }
  });
  lane.addEventListener('focusin', event => {
    const block = event.target.closest('.studio-chord');
    if (block && block.dataset.ghost !== 'true' && !drag && !host.isBusy() && !group.indices().includes(Number(block.dataset.index))) select(Number(block.dataset.index));
  });
  lane.addEventListener('keydown', event => {
    if (host.isBusy() || event.ctrlKey || event.metaKey || event.altKey) return;
    const block = event.target.closest('.studio-chord');
    if (block?.dataset.ghost === 'true') {
      if (event.key === 'Enter') { event.preventDefault(); host.offerMaterialize(Number(block.dataset.start) / ticksPerBar(host.getSession()), block); }
      return;
    }
    if (!block) {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); cursor = Math.max(0, Math.min(host.getSession().bars - 1, cursor + (event.key === 'ArrowRight' ? 1 : -1)));
        lane.setAttribute('aria-label', `Acordes, compasso ${cursor + 1}. Enter cria uma tônica; seta para baixo entra nos acordes.`);
      } else if (event.key === 'Enter') { event.preventDefault(); create(cursor); }
      else if (event.key === 'ArrowDown' && markers.length) { event.preventDefault(); select(markers[0].index); focusChord(markers[0].index); }
      return;
    }
    const index = Number(block.dataset.index);
    if (event.key === 'Enter') { event.preventDefault(); select(index); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); host.setChordSelection(index); removeSelected(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const session = host.getSession(); const chord = session.progression.chords[index]; const delta = (['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1) / session.meter.beats;
    const resize = event.shiftKey || ['ArrowUp', 'ArrowDown'].includes(event.key);
    const edited = editHarmony(session.progression, index, resize ? chord.startBar : snap(chord.startBar + delta, session.meter.beats), resize ? snap(chord.durationBars + delta, session.meter.beats) : chord.durationBars, !resize);
    if (edited && edited.chords[edited.index].durationBars >= 1 / session.meter.beats - EPSILON) { apply(edited.chords, edited.index); focusChord(edited.index); }
    else host.notify('Sem sobreposição e sem ultrapassar os limites do ciclo.', true);
  });
  lane.addEventListener('pointerdown', event => {
    suppressClick = false;
    const block = event.target.closest('.studio-chord');
    if (!block || block.dataset.ghost === 'true' || host.isBusy() || event.button !== 0) return;
    event.preventDefault();
    const index = Number(block.dataset.index); const session = host.getSession();
    host.setChordSelection(index);
    host.auditionChord?.(session.progression.chords[index]);
    drag = { pointer: event.pointerId, x: event.clientX, index, original: session, next: null, resize: !!event.target.closest('.chord-handle'), occurrence: Number(block.dataset.start) / ticksPerBar(session) - session.progression.chords[index].startBar, moved: false };
    lane.setPointerCapture(event.pointerId); host.selectionChanged?.(); renderLane(); renderInspector(); focusChord(index);
  });
  lane.addEventListener('pointermove', event => {
    if (!drag || drag.pointer !== event.pointerId || host.isBusy()) return;
    const { original, index, resize } = drag; const chord = original.progression.chords[index];
    if (Math.abs(event.clientX - drag.x) > 3) drag.moved = true;
    if (!drag.moved) return;
    const box = lane.getBoundingClientRect();
    const delta = (event.clientX - drag.x) / box.width * original.bars;
    const proposed = chord.startBar + drag.occurrence + delta;
    const pointerBar = (event.clientX - box.left) / box.width * original.bars;
    const inLane = proposed >= -EPSILON && proposed < original.bars - EPSILON && pointerBar >= 0 && pointerBar < original.bars;
    const cyclePosition = ((pointerBar % original.progression.cycleBars) + original.progression.cycleBars) % original.progression.cycleBars;
    const occupied = !resize && original.progression.chords.find((value, i) => i !== index && cyclePosition >= value.startBar && cyclePosition < value.startBar + value.durationBars);
    const startBar = resize ? chord.startBar : occupied ? occupied.startBar : snap(((proposed % original.progression.cycleBars) + original.progression.cycleBars) % original.progression.cycleBars, original.meter.beats);
    const durationBars = resize ? snap(chord.durationBars + delta, original.meter.beats) : chord.durationBars;
    drag.next = (resize || inLane) && durationBars >= 1 / original.meter.beats - EPSILON ? editHarmony(original.progression, index, startBar, durationBars, !resize) : null;
    lane.classList.toggle('invalid-drop', !drag.next);
    renderLane(drag.next ? { ...original.progression, chords: drag.next.chords } : original.progression, drag.next?.index ?? index);
  });
  lane.addEventListener('pointerup', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const { next, original, moved } = drag;
    cancelDrag(); suppressClick = true;
    if (!host.isBusy() && moved && next && JSON.stringify(next.chords) !== JSON.stringify(original.progression.chords)) { apply(next.chords, next.index); focusChord(next.index); }
    else { renderLane(); if (moved && !next) host.notify('Movimento cancelado: preserve os limites e as pausas do ciclo.', true); }
  });
  lane.addEventListener('pointercancel', () => { cancelDrag(); renderLane(); });
  lane.addEventListener('lostpointercapture', event => { if (drag?.pointer === event.pointerId) { cancelDrag(); renderLane(); } });
  function cancelDrag() {
    const previous = drag; drag = null; lane.classList.remove('invalid-drop'); const grouped = group.cancelDrag();
    if (previous && lane.hasPointerCapture(previous.pointer)) lane.releasePointerCapture(previous.pointer);
    return previous !== null || grouped;
  }
  function renderLane(preview, previewIndex) {
    const session = host.getSession(); const progression = preview ?? session.progression; const index = previewIndex ?? selectedIndex();
    const focused = document.activeElement?.closest('.studio-chord'); const focusedStart = focused?.dataset.start;
    markers = chordTimeline({ ...session, progression }); activeChord = -1; lane.replaceChildren();
    lane.setAttribute('aria-disabled', String(host.isBusy())); lane.classList.toggle('harmony-preview', !!preview);
    if (!progression.enabled) return;
    const total = sessionTicks(session); let end = 0;
    const focusedMarker = index === null ? -1 : markers.findIndex(event => event.index === index && String(event.start) === focusedStart);
    const tabMarker = focusedMarker >= 0 ? focusedMarker : index === null ? -1 : markers.findIndex(event => event.index === index);
    function silence(start, duration) {
      if (duration <= EPSILON) return;
      const gap = document.createElement('span'); gap.className = 'harmony-silence'; gap.style.left = `${start / total * 100}%`; gap.style.width = `${duration / total * 100}%`; gap.setAttribute('aria-hidden', 'true'); gap.title = 'Silêncio harmônico'; lane.append(gap);
    }
    markers.forEach((event, marker) => {
      silence(end, event.start - end); end = event.start + event.duration;
      const ghost = event.start / ticksPerBar(session) >= progression.cycleBars - EPSILON;
      const chosen = !ghost && (preview ? event.index === index : group.indices().includes(event.index));
      const block = document.createElement('div'); block.className = `studio-chord${ghost ? ' harmony-ghost' : ''}${chosen ? ' selected' : ''}`; block.dataset.ghost = String(ghost); block.dataset.index = event.index; block.dataset.marker = marker; block.dataset.start = event.start; block.dataset.duration = event.duration;
      block.setAttribute('role', 'option'); block.setAttribute('aria-selected', String(chosen)); block.setAttribute('aria-disabled', String(host.isBusy()));
      block.tabIndex = ghost || marker === tabMarker ? 0 : -1; block.textContent = event.chord.symbol;
      block.style.left = `${event.start / total * 100}%`; block.style.width = `${event.duration / total * 100}%`;
      block.setAttribute('aria-label', `${event.chord.symbol}, compasso ${number(event.start / ticksPerBar(session) + 1)}, duração ${musicalDuration(event.duration, session)}. ${ghost ? 'Repetição automática; Enter oferece materializar daqui até o fim.' : 'Setas movem; Shift+setas redimensiona; Delete exclui.'}`);
      block.title = ghost ? 'Repetição automática · clique para materializar daqui até o fim' : `${event.chord.roman || event.chord.symbol} · arraste para mover/reordenar; borda direita redimensiona`;
      const handle = document.createElement('span'); handle.className = 'chord-handle'; handle.setAttribute('aria-hidden', 'true');
      if (!ghost && event.duration / total * lane.getBoundingClientRect().width >= 12) block.append(handle); lane.append(block);
    });
    silence(end, total - end);
    for (let bar = progression.cycleBars; bar < session.bars - EPSILON; bar += progression.cycleBars) {
      const boundary = document.createElement('span'); boundary.className = 'harmony-cycle-boundary'; boundary.style.left = `${bar / session.bars * 100}%`; boundary.title = 'Recomeço do ciclo harmônico'; boundary.setAttribute('aria-hidden', 'true'); lane.append(boundary);
    }
    if (focusedStart !== undefined && group.indices().includes(Number(focused.dataset.index))) (lane.querySelector(`[data-start="${focusedStart}"][data-index="${focused.dataset.index}"]`) ?? lane.querySelector(`[data-index="${index}"]`))?.focus({ preventScroll: true });
  }
  function renderInspector() {
    const session = host.getSession(); const chord = session.progression.chords[selectedIndex()]; const locked = host.isBusy();
    $('chord-inspector').hidden = !chord;
    fretboard.render(session, chord, markers);
    if (!chord) { inspectorSignature = ''; return; }
    const signature = JSON.stringify([group.indices(), chord, session.progression.keyId]);
    if (signature !== inspectorSignature) {
      inspectorSignature = signature;
      const focus = document.activeElement; const focusId = focus?.id; const focusChoice = focus?.dataset.chordChoice; const focusInversion = focus?.dataset.inversion;
      $('chord-selection-title').textContent = group.indices().length > 1 ? `${group.indices().length} acordes selecionados` : `${chord.symbol} · compasso ${number(chord.startBar + 1)} · ${number(chord.durationBars)} comp.`;
      $('chord-symbol').value = chord.symbol;
      for (const [id, choices] of [['chord-diatonic', getDiatonicChords(session.progression.keyId)], ['chord-borrowed', getBorrowedChords(session.progression.keyId)], ['chord-secondary', getSecondaryDominants(session.progression.keyId)]]) {
        const group = $(id); group.replaceChildren();
        for (const choice of choices) {
          const button = document.createElement('button'); button.type = 'button'; button.dataset.chordChoice = `${id}:${choice.roman}`;
          const degree = document.createElement('span'); degree.textContent = choice.roman; const symbol = document.createElement('strong'); symbol.textContent = choice.symbol; button.append(degree, symbol);
          button.setAttribute('aria-pressed', String(chord.source === choice.source && chord.degree === choice.degree && chord.root === choice.root && chord.quality === choice.quality));
          button.addEventListener('click', () => replaceSelected(choice)); group.append(button);
        }
      }
      const inversions = $('chord-inversions'); inversions.replaceChildren();
      for (let value = 0; value < (CHORD_QUALITIES[chord.quality]?.length ?? chord.notes.length); value++) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.inversion = value; button.textContent = value === 0 ? 'Fundamental' : `${value}ª inversão`; button.setAttribute('aria-pressed', String(value === chord.inversion));
        button.addEventListener('click', () => { try { replaceSelected(invertChord(chord, value)); } catch (error) { host.notify(error.message, true); } }); inversions.append(button);
      }
      if (focusChoice) $('chord-inspector').querySelector(`[data-chord-choice="${CSS.escape(focusChoice)}"]`)?.focus({ preventScroll: true });
      else if (focusInversion !== undefined) inversions.querySelector(`[data-inversion="${focusInversion}"]`)?.focus({ preventScroll: true });
      else if (focusId && $('chord-inspector').contains(focus)) $(focusId)?.focus({ preventScroll: true });
    }
    for (const control of $('chord-inspector').querySelectorAll('button, input')) {
      control.disabled = locked;
      control.title = locked ? 'Pare a reprodução antes de editar os acordes' : control.dataset.inversion !== undefined ? control.textContent : '';
    }
  }
  function renderContext() {
    const session = host.getSession(); const progression = session.progression;
    let end = 0; let gaps = false;
    for (const chord of progression.chords) { if (chord.startBar > end + EPSILON) gaps = true; end = chord.startBar + chord.durationBars; }
    gaps ||= end < progression.cycleBars - EPSILON;
    const mismatch = Math.abs(progression.cycleBars - session.bars) > EPSILON;
    $('harmony-context').hidden = !progression.enabled || (!mismatch && !gaps);
    $('progression-status').textContent = `${progression.chords.length} acordes · ciclo de ${number(progression.cycleBars)} comp.${mismatch ? progression.cycleBars < session.bars ? ' · repete na sessão' : ' · continua além da sessão' : ''}${gaps ? ' · áreas hachuradas em silêncio' : ''}${!progression.chords.length ? ' · crie um acorde para ajustar' : ''}`;
    $('fit-progression').disabled = host.isBusy() || !progression.chords.length;
    $('fit-progression').title = !progression.chords.length ? 'Crie um acorde antes de ajustar' : 'Distribuir os acordes em tempos inteiros e preencher a sessão, retirando as pausas';
  }
  function renderControls() { renderInspector(); renderContext(); lane.setAttribute('aria-disabled', String(host.isBusy())); }
  function render() { renderLane(); renderControls(); }
  function position(value, { hidden = false } = {}) {
    fretboard.position(value, { hidden });
    const visible = !hidden && !['idle', 'countin'].includes(value.mode);
    const index = visible ? markers.findIndex(event => value.tick >= event.start && value.tick < event.start + event.duration) : -1;
    if (index === activeChord) return;
    activeChord = index;
    for (const block of lane.querySelectorAll('.studio-chord')) {
      const current = Number(block.dataset.marker) === index; block.classList.toggle('current', current);
      if (current) block.setAttribute('aria-current', 'step'); else block.removeAttribute('aria-current');
    }
  }
  return { render, renderLane, renderControls, renderInspector, position, cancelDrag, removeSelected };
}
