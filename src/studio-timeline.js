import { ticksPerBar, sessionTicks } from './session.js';
import { addNote, updateNote } from './model.js';
import { quantizeTick } from './meter.js';
import { generateDrums } from './drums.js';
import { generateBass } from './band.js';
import { mountStudioHarmony } from './studio-harmony.js';
import { buildRhythmNotation, renderRhythmNotation } from './notation.js';
import { mountStudioTracks } from './studio-tracks.js';

const figure = duration => ({ 1: '𝅘𝅥𝅯', 2: '♪', 3: '♪·', 4: '♩', 6: '♩·', 8: '𝅗𝅥', 12: '𝅗𝅥·', 16: '𝅝' })[duration] ?? '';
const number = value => String(Math.round(value * 1000) / 1000);

// The host owns session mutation, history and selection. No second transport or clock.
export function mountStudioTimeline(root, host) {
  const $ = id => document.getElementById(id);
  const grid = $('grid');
  const scroll = $('studio-scroll');
  const canvas = $('studio-canvas');
  const tracks = mountStudioTracks(host);
  const harmony = mountStudioHarmony(root, host);
  let drag = null;
  let cursor = 0;
  let creationTicks = [];
  let zoom = 1;
  let suppressClick = false;

  function size() {
    const width = scroll.clientWidth;
    canvas.style.width = `${200 + Math.max(0, width - 200) * zoom}px`;
  }
  new ResizeObserver(size).observe(scroll);
  $('timeline-zoom').addEventListener('change', event => { zoom = Number(event.target.value); size(); });
  function select(id) { host.setSelection(id); renderNotes(); host.selectionChanged?.(); }
  function focusNote(id) { $('notes').querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); }
  function create(tick) {
    if (host.isBusy()) return;
    const session = host.getSession();
    const notes = addNote(session.notes, tick, Math.min(4 / session.subdivision, sessionTicks(session) - tick), session, {
      pitch: session.extensions?.studio?.inputPitch ?? 69, velocity: 0.8, articulation: 'normal',
    });
    if (notes === session.notes) { host.notify('Posição ocupada ou duração ultrapassa a frase.', true); return; }
    const id = notes.find(note => !session.notes.some(previous => previous.id === note.id)).id;
    host.setSelection(id); host.updateSession({ notes }); focusNote(id);
  }
  function cursorPosition() {
    const session = host.getSession();
    const total = sessionTicks(session);
    cursor = creationTicks.findLast(tick => tick <= cursor + 1e-8) ?? 0;
    $('grid-cursor').style.left = `${cursor / total * 100}%`;
    $('grid-cursor').style.width = `${Math.min(4 / session.subdivision, total - cursor) / total * 100}%`;
    grid.setAttribute('aria-label', `Frase: compasso ${Math.floor(cursor / ticksPerBar(session)) + 1}, posição ${number(cursor % ticksPerBar(session))} ticks. Setas navegam; Enter cria; seta para baixo entra nas notas.`);
  }
  grid.addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; return; }
    const block = event.target.closest('.note');
    if (block) { if (!host.isBusy()) select(block.dataset.id); return; }
    const session = host.getSession();
    const box = grid.getBoundingClientRect();
    cursor = (event.clientX - box.left) / box.width * sessionTicks(session);
    cursorPosition(); create(cursor);
  });
  grid.addEventListener('focusin', event => {
    const block = event.target.closest('.note');
    if (block && !host.isBusy() && block.dataset.id !== host.getSelection()) select(block.dataset.id);
  });
  grid.addEventListener('keydown', event => {
    if (host.isBusy() || event.ctrlKey || event.metaKey || event.altKey) return;
    const block = event.target.closest('.note');
    const session = host.getSession();
    const step = event.shiftKey ? 4 : 4 / session.subdivision;
    if (!block) {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const index = creationTicks.indexOf(cursor);
        cursor = event.key === 'Home' ? 0 : event.key === 'End' ? creationTicks.at(-1)
          : event.shiftKey ? cursor + direction * 4 : creationTicks[Math.max(0, Math.min(creationTicks.length - 1, index + direction))];
        cursorPosition();
      } else if (event.key === 'Enter') { event.preventDefault(); create(cursor); }
      else if (event.key === 'ArrowDown' && session.notes.length) {
        event.preventDefault(); const note = [...session.notes].sort((a, b) => a.start - b.start).find(item => item.start >= cursor) ?? session.notes[0];
        select(note.id); focusNote(note.id);
      }
      return;
    }
    if (event.key === 'Enter') { event.preventDefault(); select(block.dataset.id); return; }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault(); const notes = [...session.notes].sort((a, b) => a.start - b.start);
      const index = notes.findIndex(note => note.id === block.dataset.id);
      const next = notes[index + (event.key === 'PageDown' ? 1 : -1)];
      if (next) { select(next.id); focusNote(next.id); }
      return;
    }
    const note = session.notes.find(item => item.id === block.dataset.id);
    const patch = event.key === 'ArrowLeft' ? { start: note.start - step } : event.key === 'ArrowRight' ? { start: note.start + step }
      : event.key === 'ArrowDown' ? { duration: note.duration - step } : event.key === 'ArrowUp' ? { duration: note.duration + step }
        : ['1', '2', '3', '4', '6', '8'].includes(event.key) ? { duration: Number(event.key) } : null;
    if (patch) { event.preventDefault(); host.setSelection(note.id); host.commitNote(patch); }
  });
  grid.addEventListener('pointerdown', event => {
    suppressClick = false;
    const block = event.target.closest('.note');
    if (!block || host.isBusy() || event.button !== 0) return;
    event.preventDefault();
    const session = host.getSession();
    const note = session.notes.find(item => item.id === block.dataset.id);
    host.setSelection(note.id);
    drag = { id: note.id, x: event.clientX, start: note.start, duration: note.duration, resize: !!event.target.closest('.handle'), original: session, next: session.notes, pointer: event.pointerId };
    grid.setPointerCapture(event.pointerId); renderNotes(); focusNote(note.id); host.selectionChanged?.();
  });
  grid.addEventListener('pointermove', event => {
    if (!drag || drag.pointer !== event.pointerId || host.isBusy()) return;
    const delta = quantizeTick((event.clientX - drag.x) / grid.getBoundingClientRect().width * sessionTicks(drag.original), drag.original.subdivision);
    drag.next = updateNote(drag.original.notes, drag.id, drag.resize ? { duration: drag.duration + delta } : { start: drag.start + delta }, drag.original);
    renderNotes(drag.next);
  });
  grid.addEventListener('pointerup', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const { next, original } = drag;
    // Pointer capture retargets even a stationary note click to the grid.
    cancelDrag(); suppressClick = true;
    if (!host.isBusy() && next !== original.notes) host.updateSession({ notes: next });
    else renderNotes();
  });
  grid.addEventListener('pointercancel', () => { cancelDrag(); renderNotes(); });
  grid.addEventListener('lostpointercapture', event => { if (drag?.pointer === event.pointerId) { cancelDrag(); renderNotes(); } });
  function cancelDrag() {
    const previous = drag; drag = null;
    if (previous && grid.hasPointerCapture(previous.pointer)) grid.releasePointerCapture(previous.pointer);
    return previous !== null;
  }
  function renderGrid(session) {
    const total = sessionTicks(session); const measure = ticksPerBar(session); const step = 4 / session.subdivision;
    $('marks').replaceChildren(); $('beat-labels').replaceChildren();
    creationTicks = [];
    for (let bar = 0; bar < session.bars; bar++) {
      for (let tick = 0; tick < measure - 1e-8; tick += step) {
        creationTicks.push(bar * measure + tick);
        const mark = document.createElement('span');
        const beat = tick / (16 / session.meter.unit);
        mark.className = `mark ${tick === 0 ? 'bar-mark' : Math.abs(beat - Math.round(beat)) < 1e-8 ? 'beat-mark' : ''}`;
        mark.style.left = `${(bar * measure + tick) / total * 100}%`; $('marks').append(mark);
      }
      for (let beat = 0; beat < session.meter.beats; beat++) {
        const label = document.createElement('span'); label.textContent = beat === 0 ? `${bar + 1} · 1` : String(beat + 1);
        label.className = beat === 0 ? 'ruler-bar' : 'ruler-beat';
        label.style.left = `${(bar * measure + beat * 16 / session.meter.unit) / total * 100}%`; $('beat-labels').append(label);
      }
    }
    root.style.setProperty('--bar-width', `${100 / session.bars}%`); cursorPosition();
  }
  function renderNotes(previewNotes) {
    const session = host.getSession(); const notes = previewNotes ?? session.notes; const total = sessionTicks(session);
    const focusedId = document.activeElement?.closest('.note')?.dataset.id;
    $('notes').replaceChildren();
    for (const note of [...notes].sort((a, b) => a.start - b.start)) {
      const selected = note.id === host.getSelection();
      const block = document.createElement('div'); block.className = `note${selected ? ' selected' : ''}`; block.dataset.id = note.id;
      block.setAttribute('role', 'gridcell'); block.tabIndex = selected || (!host.getSelection() && note === notes[0]) ? 0 : -1;
      block.style.left = `calc(${note.start / total * 100}% + 2px)`; block.style.width = `max(6px, calc(${note.duration / total * 100}% - 4px))`;
      block.setAttribute('aria-selected', String(selected)); block.setAttribute('aria-disabled', String(host.isBusy()));
      block.setAttribute('aria-label', `Nota MIDI ${note.pitch}: início ${number(note.start)}, duração ${number(note.duration)} ticks, velocidade ${number(note.velocity)}, ${note.articulation}`);
      block.textContent = figure(note.duration);
      const handle = document.createElement('span'); handle.className = 'handle'; handle.setAttribute('aria-hidden', 'true'); block.append(handle);
      $('notes').append(block);
    }
    const notation = buildRhythmNotation(notes, session); renderRhythmNotation($('rhythm-score'), notation);
    const svg = $('rhythm-score').querySelector('svg'); svg.style.minWidth = '0'; svg.setAttribute('preserveAspectRatio', 'none');
    if (!previewNotes) renderRhythmNotation($('practice-rhythm-score'), notation);
    if (focusedId) focusNote(focusedId);
  }
  function renderDrums(session) {
    const rows = $('drum-rows'); rows.replaceChildren();
    if (!session.drums.enabled) return;
    const names = { kick: 'Bumbo', snare: 'Caixa', hihat: 'Chimbal / percussão' };
    const pattern = generateDrums(session);
    for (const voice of ['kick', 'snare', 'hihat']) {
      const row = document.createElement('div'); row.className = `drum-line drum-${voice}`; row.dataset.voice = voice;
      const hits = pattern.hits.filter(hit => voice === 'hihat' ? !['kick', 'snare'].includes(hit.instrument) : hit.instrument === voice);
      row.setAttribute('role', 'img'); row.setAttribute('aria-label', `${names[voice]}: ${hits.length} ataques. Referência gerada, somente leitura.`);
      const label = document.createElement('span'); label.className = 'drum-voice-label'; label.textContent = names[voice];
      for (const hit of hits) {
        const mark = document.createElement('span'); mark.className = 'drum-hit'; mark.dataset.voice = hit.instrument; mark.dataset.start = hit.start; mark.dataset.position = hit.start / sessionTicks(session);
        mark.style.left = `${hit.start / sessionTicks(session) * 100}%`; mark.style.opacity = String(Math.max(0.25, hit.velocity));
        mark.title = `${hit.instrument} · posição ${number(hit.start)} · intensidade ${Math.round(hit.velocity * 100)}%`; mark.setAttribute('aria-hidden', 'true'); row.append(mark);
      }
      row.append(label); rows.append(row);
    }
  }
  function renderBass(session) {
    const lane = $('bass-lane'); lane.replaceChildren();
    if (!session.band.bassEnabled) return;
    const notes = generateBass(session); lane.setAttribute('role', 'img'); lane.setAttribute('aria-label', `Baixo gerado: ${notes.length} notas. Somente leitura.`);
    for (const note of notes) {
      const block = document.createElement('span'); block.className = 'bass-note'; block.dataset.start = note.start; block.dataset.duration = note.duration; block.dataset.pitch = note.pitch;
      block.style.left = `${note.start / sessionTicks(session) * 100}%`; block.style.width = `${Math.min(note.duration, sessionTicks(session) - note.start) / sessionTicks(session) * 100}%`;
      block.title = `Baixo MIDI ${note.pitch} · posição ${number(note.start)} · duração ${number(note.duration)}`; lane.append(block);
    }
  }
  function render() {
    const session = host.getSession(); tracks.render(); renderGrid(session); harmony.render(); renderDrums(session); renderBass(session); renderNotes(); size();
  }
  function renderControls() { tracks.render(); harmony.renderControls(); grid.setAttribute('aria-disabled', String(host.isBusy())); }
  function position(value, { hidden = false } = {}) {
    const session = host.getSession(); const visible = !hidden && !['idle', 'countin'].includes(value.mode);
    const fraction = Math.max(0, Math.min(1, (value.tick ?? 0) / sessionTicks(session)));
    $('playhead').hidden = !visible; $('playhead').style.left = `calc(200px + (100% - 200px) * ${fraction})`;
    harmony.position(value, { hidden });
    if (visible && zoom > 1 && document.body.dataset.intent === 'studio') {
      const x = 200 + fraction * (canvas.clientWidth - 200);
      if (x < scroll.scrollLeft + 216 || x > scroll.scrollLeft + scroll.clientWidth - 24) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 2);
    }
  }
  return { render, renderNotes, renderControls, position, cancelDrag: () => { const notes = cancelDrag(); const chords = harmony.cancelDrag(); if (chords) harmony.renderLane(); return notes || chords; }, removeChord: harmony.removeSelected, renderSelection: () => { renderNotes(); harmony.render(); } };
}
