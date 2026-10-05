import { ticksPerBar, sessionTicks, ARTICULATION_LABELS } from './session.js';
import { mountStudioNoteEditor } from './studio-note-editor.js';
import { mountStudioDrums } from './studio-drums.js';
import { generateBass } from './band.js';
import { mountStudioHarmony } from './studio-harmony.js';
import { mountStudioTracks } from './studio-tracks.js';
import { getInstrumentProfile, formatInstrumentNote } from './instrument-profile.js';
import { timelineWidth, musicalDuration } from './studio-bars.js';
import { mountStudioRuler } from './studio-ruler.js';
import { mountStudioScores } from './studio-score.js';
import { phraseView, resolveTabPosition, mountPhraseView } from './tablature.js';

const figure = duration => ({ 1: '𝅘𝅥𝅯', 2: '♪', 3: '♪·', 4: '♩', 6: '♩·', 8: '𝅗𝅥', 12: '𝅗𝅥·', 16: '𝅝' })[duration] ?? '';
const number = value => String(Math.round(value * 1000) / 1000);

// The host owns session mutation, history and selection. No second transport or clock.
export function mountStudioTimeline(root, host) {
  const $ = id => document.getElementById(id);
  const grid = $('grid');
  const scroll = $('studio-scroll');
  const canvas = $('studio-canvas');
  const tracks = mountStudioTracks(host);
  const ruler = mountStudioRuler(root, host);
  const harmony = mountStudioHarmony(root, { ...host, offerMaterialize: ruler.offerMaterialize });
  const drums = mountStudioDrums(host);
  const renderPhraseView = mountPhraseView(host);
  const scores = mountStudioScores($('rhythm-score'), $('practice-rhythm-score'), host);
  let cursor = 0;
  let creationTicks = [];
  let visibleBars = 4;

  function size() {
    const width = scroll.clientWidth;
    const session = host.getSession();
    canvas.style.width = `${timelineWidth(width, session, visibleBars)}px`;
    const beatWidth = (canvas.clientWidth - 200) / session.bars / session.meter.beats;
    root.classList.toggle('compact-ruler', beatWidth < 40);
    for (const block of $('bass-lane').querySelectorAll('.bass-note')) {
      block.textContent = block.getBoundingClientRect().width >= 30 ? formatInstrumentNote(Number(block.dataset.pitch), getInstrumentProfile(session), { octave: false }) : '';
    }
  }
  new ResizeObserver(size).observe(scroll);
  $('timeline-zoom').addEventListener('change', event => { visibleBars = Number(event.target.value); size(); });
  $('bass-lane').addEventListener('click', () => host.notify('Baixo gerado: ajuste o estilo ou a densidade no cabeçalho.'));
  function focusNote(id) { $('notes').querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); }
  const editor = mountStudioNoteEditor(grid, host, {
    renderNotes, focusNote, getCursor: () => cursor,
    setCursor: tick => { cursor = tick; cursorPosition(); },
    navigate: (key, shift) => {
      const direction = key === 'ArrowRight' ? 1 : -1;
      const index = creationTicks.indexOf(cursor);
      cursor = key === 'Home' ? 0 : key === 'End' ? creationTicks.at(-1) : shift ? cursor + direction * 4 : creationTicks[Math.max(0, Math.min(creationTicks.length - 1, index + direction))];
      cursorPosition();
    },
  });
  function cursorPosition() {
    const session = host.getSession();
    const total = sessionTicks(session);
    cursor = creationTicks.findLast(tick => tick <= cursor + 1e-8) ?? 0;
    $('grid-cursor').style.left = `${cursor / total * 100}%`;
    $('grid-cursor').style.width = `${Math.min(4 / session.subdivision, total - cursor) / total * 100}%`;
    const tabHelp = phraseView(session) === 'tab' ? 'Setas horizontais navegam; setas verticais escolhem corda; Enter cria; dígitos escolhem casa.' : 'Setas navegam; Enter cria; seta para baixo entra nas notas.';
    grid.setAttribute('aria-label', `Frase: compasso ${Math.floor(cursor / ticksPerBar(session)) + 1}, tempo ${number(cursor % ticksPerBar(session) / (16 / session.meter.unit) + 1)}. ${tabHelp}`);
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
        label.setAttribute('aria-hidden', 'true');
        if (beat === 0) { label.dataset.bar = bar; label.title = `Compasso ${bar + 1}. Clique escolhe início; botão direito abre ações.`; }
        label.style.left = `${(bar * measure + beat * 16 / session.meter.unit) / total * 100}%`; $('beat-labels').append(label);
      }
    }
    root.style.setProperty('--bar-width', `${100 / session.bars}%`); cursorPosition();
    ruler.render();
  }
  function renderNotes(previewNotes) {
    const session = host.getSession(); const notes = previewNotes ?? session.notes; const total = sessionTicks(session);
    const profile = getInstrumentProfile(session); const tab = phraseView(session) === 'tab';
    const focusedId = document.activeElement?.closest('.note')?.dataset.id;
    $('notes').replaceChildren();
    for (const note of [...notes].sort((a, b) => a.start - b.start)) {
      const selected = editor.ids().includes(note.id);
      const position = resolveTabPosition(note, profile);
      const block = document.createElement('div'); block.className = `note${selected ? ' selected' : ''}${!position.playable ? ' tab-out-of-range' : ''}`; block.dataset.id = note.id;
      if (tab) {
        block.dataset.string = position.string; block.dataset.fret = position.fret;
        block.style.top = `calc(${(position.string - 0.5) / profile.strings * 100}% - 12px)`;
      }
      block.setAttribute('role', 'gridcell'); block.tabIndex = selected ? 0 : -1;
      block.style.left = `calc(${note.start / total * 100}% + 2px)`; block.style.width = `max(6px, calc(${note.duration / total * 100}% - 4px))`;
      block.setAttribute('aria-selected', String(selected)); block.setAttribute('aria-disabled', String(host.isBusy()));
      const fingering = position.playable ? `corda ${position.string}, casa ${position.fret}` : 'fora da extensão de casas 0–24; altura preservada';
      block.setAttribute('aria-label', `Nota ${formatInstrumentNote(note.pitch, profile)}: ${fingering}, compasso ${Math.floor(note.start / ticksPerBar(session)) + 1}, tempo ${number(note.start % ticksPerBar(session) / (16 / session.meter.unit) + 1)}, duração ${musicalDuration(note.duration, session)}, intensidade ${Math.round(note.velocity * 100)}%, ${ARTICULATION_LABELS[note.articulation]}`);
      block.textContent = tab ? position.playable ? String(position.fret) : '!' : figure(note.duration);
      block.title = `${formatInstrumentNote(note.pitch, profile)} · ${fingering}`;
      const handle = document.createElement('span'); handle.className = 'handle'; handle.setAttribute('aria-hidden', 'true');
      if (note.duration / total * grid.getBoundingClientRect().width - 4 >= 12) block.append(handle);
      $('notes').append(block);
    }
    scores.render(session, notes);
    if (focusedId && editor.ids().includes(focusedId)) focusNote(focusedId);
  }
  function renderBass(session) {
    const lane = $('bass-lane'); lane.replaceChildren();
    if (!session.band.bassEnabled) return;
    const notes = generateBass(session); lane.setAttribute('role', 'img'); lane.setAttribute('aria-label', `Baixo gerado: ${notes.length} notas. Somente leitura.`);
    for (const note of notes) {
      const block = document.createElement('span'); block.className = 'bass-note'; block.dataset.start = note.start; block.dataset.duration = note.duration; block.dataset.pitch = note.pitch;
      block.style.left = `${note.start / sessionTicks(session) * 100}%`; block.style.width = `${Math.min(note.duration, sessionTicks(session) - note.start) / sessionTicks(session) * 100}%`;
      block.title = `Baixo ${formatInstrumentNote(note.pitch, getInstrumentProfile(session))} · tempo ${number(note.start / (16 / session.meter.unit) + 1)} · duração ${musicalDuration(note.duration, session)}`; lane.append(block);
    }
  }
  function render() {
    const session = host.getSession(); renderPhraseView(); size(); tracks.render(); renderGrid(session); harmony.render(); drums.render(); renderBass(session); renderNotes(); size();
  }
  function renderControls() {
    tracks.render(); ruler.render(); harmony.renderControls(); grid.setAttribute('aria-disabled', String(host.isBusy()));
    const { companion } = host.getSession();
    for (const button of $('creation-duration').querySelectorAll('button')) button.title = `${button.getAttribute('aria-label')} · ${musicalDuration(Number(button.dataset.duration), host.getSession())}`;
    $('polyrhythm-description').textContent = `${companion.pulses} pulsos a cada ${companion.spanBeats} ${companion.spanBeats === 1 ? 'tempo' : 'tempos'}`;
  }
  function position(value, { hidden = false } = {}) {
    const session = host.getSession(); const visible = !hidden && !['idle', 'countin'].includes(value.mode);
    const fraction = Math.max(0, Math.min(1, (value.tick ?? 0) / sessionTicks(session)));
    $('playhead').hidden = !visible; $('playhead').style.left = `calc(200px + (100% - 200px) * ${fraction})`;
    harmony.position(value, { hidden });
    scores.position(value, { hidden });
    if (visible && canvas.clientWidth > scroll.clientWidth && document.body.dataset.intent === 'studio') {
      const x = 200 + fraction * (canvas.clientWidth - 200);
      if (x < scroll.scrollLeft + 216 || x > scroll.scrollLeft + scroll.clientWidth - 24) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 2);
    }
  }
  return { render, renderNotes, renderControls, position, requestDrumChange: drums.requestChange, commitNote: editor.commit, removeNotes: editor.remove, cancelDrag: () => { const drum = drums.cancelDrag(); const range = ruler.cancelDrag(); const notes = editor.cancelDrag(); const chords = harmony.cancelDrag(); if (chords) harmony.renderLane(); return drum || range || notes || chords; }, removeChord: harmony.removeSelected, renderSelection: () => { renderNotes(); harmony.render(); } };
}
