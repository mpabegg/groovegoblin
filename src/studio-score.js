import { buildRhythmNotation, renderRhythmNotation, rhythmNotationLayout, notationTickX } from './notation.js';
import { getInstrumentProfile, getInstrumentClef, formatInstrumentNote } from './instrument-profile.js';
import { phraseView, resolveTabPosition, stringPitch } from './tablature.js';
import { chordTimeline } from './progression.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function notationSystems(model) {
  const systems = [];
  for (let offset = 0; offset < model.measures.length; offset += 4) {
    const measures = model.measures.slice(offset, offset + 4).map((measure, index) => ({ ...measure, index: index + 1 }));
    systems.push({ ...model, bars: measures.length, barOffset: offset, measures });
  }
  return systems;
}

export function scoreChordSegments(session, system) {
  const barTicks = system.ticksPerBar;
  const segments = [];
  for (const occurrence of chordTimeline(session)) {
    for (let bar = system.barOffset; bar < system.barOffset + system.bars; bar++) {
      const start = Math.max(occurrence.start, bar * barTicks);
      const end = Math.min(occurrence.start + occurrence.duration, (bar + 1) * barTicks);
      if (end > start + 1e-8) segments.push({ start, end, symbol: occurrence.chord.symbol, continued: start > occurrence.start });
    }
  }
  return segments;
}

export function suggestedStroke(event, session) {
  if (event.kind !== 'note' || event.tieFromPrevious) return null;
  const beatTicks = 16 / session.meter.unit;
  const onBeat = Math.abs(event.start / beatTicks - Math.round(event.start / beatTicks)) < 1e-6;
  const subdivision = Math.round(event.start * session.subdivision / 4);
  return onBeat || subdivision % 2 === 0 ? 'down' : 'up';
}

function svgElement(svg, name, attributes = {}, text) {
  const node = svg.ownerDocument.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  svg.append(node);
  return node;
}

function renderSystem(row, system, session, { strokes = true } = {}) {
  const profile = getInstrumentProfile(session);
  const tab = phraseView(session) === 'tab';
  const options = { compact: true, clef: getInstrumentClef(profile), noteLabel: pitch => formatInstrumentNote(pitch, profile) };
  const geometry = rhythmNotationLayout(system, options);
  const svg = renderRhythmNotation(row, system, options);
  svg.style.minWidth = '0'; svg.style.width = '100%'; svg.style.height = 'auto';
  svg.classList.add('instrument-score');
  const staffBottom = Number(svg.dataset.scoreBottom);
  const tabTop = staffBottom + 8;
  const height = tab ? tabTop + (profile.strings - 1) * 16 + 16 : staffBottom;
  svg.setAttribute('viewBox', `0 8 ${geometry.width} ${height - 8}`);
  svg.setAttribute('height', height - 8);
  svg.dataset.phraseView = tab ? 'tab' : 'rhythm';
  const labels = scoreChordSegments(session, system).map(segment => {
    const x = notationTickX(system, geometry, segment.start);
    const bar = geometry.layouts[Math.floor(segment.start / system.ticksPerBar) - system.barOffset];
    const endX = segment.end >= (Math.floor(segment.start / system.ticksPerBar) + 1) * system.ticksPerBar
      ? bar.left + bar.width : notationTickX(system, geometry, segment.end);
    const textWidth = Math.min(segment.symbol.length * 10, Math.max(18, endX - x - 4));
    const node = svgElement(svg, 'text', { class: 'score-chord', x, y: 39, 'font-size': 18, 'font-weight': 600, textLength: textWidth, lengthAdjust: 'spacingAndGlyphs', 'data-start': segment.start, 'data-end': segment.end, tabindex: 0, role: 'img', 'aria-label': `Acorde ${segment.symbol}${segment.continued ? ', continuação' : ''}, início ${segment.start}, término ${segment.end}` }, segment.symbol);
    return { ...segment, node };
  });
  if (tab) {
    svgElement(svg, 'text', { x: 14, y: tabTop + 14, 'font-size': 14, 'aria-hidden': 'true' }, 'TAB');
    for (let string = 1; string <= profile.strings; string++) {
      const y = tabTop + (string - 1) * 16;
      svgElement(svg, 'line', { class: 'score-tab-string', x1: 80, x2: geometry.right, y1: y, y2: y, stroke: 'currentColor', 'stroke-width': 0.8, 'data-string': string, 'data-pitch': stringPitch(profile, string), 'aria-hidden': 'true' });
      svgElement(svg, 'text', { x: 45, y: y + 4, 'font-size': 11, 'aria-hidden': 'true' }, formatInstrumentNote(stringPitch(profile, string), profile, { octave: false }));
    }
    for (const layout of geometry.layouts) {
      svgElement(svg, 'line', { x1: layout.left, x2: layout.left, y1: tabTop, y2: tabTop + (profile.strings - 1) * 16, stroke: 'currentColor', 'aria-hidden': 'true' });
      for (const { event, x } of layout.events) {
        if (event.kind !== 'note') continue;
        const position = resolveTabPosition(event, profile);
        const y = tabTop + (position.string - 1) * 16;
        const label = `${formatInstrumentNote(event.pitch, profile)}, corda ${position.string}, casa ${position.fret}${position.playable ? '' : ', fora do alcance 0–24; altura preservada'}${event.tieFromPrevious ? ', continuação ligada' : ''}`;
        const group = svgElement(svg, 'g', { class: `score-tab-note${position.playable ? '' : ' unplayable'}`, 'data-note-id': event.noteId, 'data-start': event.start, 'data-duration': event.duration, 'data-string': position.string, 'data-fret': position.fret, tabindex: 0, role: 'img', 'aria-label': label });
        const background = svg.ownerDocument.createElementNS(SVG_NS, 'rect');
        const text = `${position.fret}${position.playable ? '' : '!'}`;
        const boxWidth = Math.max(18, text.length * 10);
        for (const [key, value] of Object.entries({ x: x - boxWidth / 2, y: y - 9, width: boxWidth, height: 18, rx: 3, class: 'score-fret-background' })) background.setAttribute(key, value);
        group.append(background);
        const fret = svg.ownerDocument.createElementNS(SVG_NS, 'text');
        for (const [key, value] of Object.entries({ x, y: y + 5, 'text-anchor': 'middle', 'font-size': 15, fill: 'currentColor' })) fret.setAttribute(key, value);
        fret.textContent = text; group.append(fret);
      }
    }
    svgElement(svg, 'line', { x1: geometry.right, x2: geometry.right, y1: tabTop, y2: tabTop + (profile.strings - 1) * 16, stroke: 'currentColor', 'aria-hidden': 'true' });
  } else if (strokes && profile.type === 'guitar' && session.progression.enabled) {
    for (const layout of geometry.layouts) {
      for (const { event, x } of layout.events) {
        const stroke = suggestedStroke(event, session);
        if (!stroke) continue;
        svgElement(svg, 'text', { class: 'score-stroke', x, y: height - 6, 'font-size': 18, 'text-anchor': 'middle', 'aria-hidden': 'true', 'data-stroke': stroke }, stroke === 'down' ? '↓' : '↑');
      }
    }
  }
  const cursor = svgElement(svg, 'line', { class: 'score-playhead', x1: 0, x2: 0, y1: 22, y2: height - 2, 'aria-hidden': 'true', visibility: 'hidden' });
  const events = [...svg.querySelectorAll('.rhythm-note, .score-tab-note')].map(node => ({ node, start: Number(node.dataset.start), end: Number(node.dataset.start) + Number(node.dataset.duration) }));
  return { system, geometry, svg, cursor, events, labels };
}

// Legacy rhythm-only callers still use the same renderer and system slicing.
export function renderPracticeScore(container, model, session = null, options = {}) {
  container.replaceChildren();
  const rows = [];
  for (const system of notationSystems(model)) {
    const row = container.ownerDocument.createElement('div'); row.className = 'practice-score-system';
    row.setAttribute('aria-label', `Compassos ${system.barOffset + 1} a ${system.barOffset + system.bars}`);
    row.style.width = `${system.bars / 4 * 100}%`;
    if (session) rows.push(renderSystem(row, system, session, options));
    else {
      const svg = renderRhythmNotation(row, system);
      svg.style.minWidth = '0'; svg.style.width = '100%'; svg.style.height = 'auto';
    }
    container.append(row);
  }
  return rows;
}

export function positionScore(rows, position, { hidden = false } = {}) {
  const tick = position.tick ?? 0;
  const visible = !hidden && !['idle', 'countin'].includes(position.mode);
  for (const row of rows) {
    const start = row.system.barOffset * row.system.ticksPerBar;
    const end = start + row.system.bars * row.system.ticksPerBar;
    const active = visible && tick >= start && tick < end;
    row.cursor.setAttribute('visibility', active ? 'visible' : 'hidden');
    if (active) {
      const x = notationTickX(row.system, row.geometry, tick);
      row.cursor.setAttribute('x1', x); row.cursor.setAttribute('x2', x);
    }
    for (const event of row.events) event.node.classList.toggle('score-active', active && tick >= event.start && tick < event.end);
    for (const label of row.labels) label.node.classList.toggle('score-active', active && tick >= label.start && tick < label.end);
  }
}

export function mountStudioScores(studioContainer, practiceContainer, host) {
  let strokes = true, studioSession = null, practiceSession = null, execution = null;
  let studioRows = [], practiceRows = [];
  function renderView(container, session) {
    const model = buildRhythmNotation(session.notes, session);
    const rows = renderPracticeScore(container, model, session, { strokes });
    if (getInstrumentProfile(session).type === 'guitar' && phraseView(session) === 'rhythm' && session.progression.enabled) {
      const toolbar = container.ownerDocument.createElement('div'); toolbar.className = 'score-suggestions';
      const toggle = container.ownerDocument.createElement('button'); toggle.type = 'button'; toggle.dataset.scoreStrokes = '';
      toggle.setAttribute('aria-pressed', String(strokes)); toggle.textContent = strokes ? 'Ocultar palhetadas sugeridas' : 'Mostrar palhetadas sugeridas';
      toggle.addEventListener('click', () => {
        strokes = !strokes;
        studioRows = renderView(studioContainer, studioSession);
        practiceRows = renderView(practiceContainer, practiceSession);
        container.querySelector('[data-score-strokes]')?.focus({ preventScroll: true });
      });
      const hint = container.ownerDocument.createElement('span'); hint.textContent = '↓/↑ são sugestões rítmicas, não técnica acústica autoral.';
      toolbar.append(toggle, hint); container.prepend(toolbar);
    }
    return rows;
  }
  function render(session, notes = session.notes) {
    studioSession = notes === session.notes ? session : { ...session, notes };
    studioRows = renderView(studioContainer, studioSession);
    // A partitura do Treinar mostra a fonte atual do treinador (frase da sessão
    // ou o exercício gerado transitório), sem tocar na sessão autoral.
    const source = host.getSourceSession?.() ?? session;
    if (!execution) { practiceSession = source; practiceRows = renderView(practiceContainer, practiceSession); }
  }
  function position(value, { hidden = false } = {}) {
    const active = value.mode !== 'idle';
    const snapshot = active ? host.getExecutionSession?.() ?? null : null;
    if (snapshot !== execution) {
      execution = snapshot;
      practiceSession = snapshot ?? host.getSourceSession?.() ?? host.getSession();
      practiceRows = renderView(practiceContainer, practiceSession);
    }
    positionScore(studioRows, value, { hidden: hidden && value.mode === 'train' });
    positionScore(practiceRows, value);
  }
  return { render, position };
}
