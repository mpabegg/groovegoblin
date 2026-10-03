import { TICKS_PER_BAR, validPhrase } from './model.js';

// Durations are semiquaver ticks. Notes retain dotted values and their
// alignment without changing the onset or release of any original note.
const NOTE_VALUES = [
  { duration: 16, value: 'whole', dotted: false, alignment: 16 },
  { duration: 12, value: 'half', dotted: true, alignment: 4 },
  { duration: 8, value: 'half', dotted: false, alignment: 4 },
  { duration: 6, value: 'quarter', dotted: true, alignment: 4 },
  { duration: 4, value: 'quarter', dotted: false, alignment: 4 },
  { duration: 3, value: 'eighth', dotted: true, alignment: 2 },
  { duration: 2, value: 'eighth', dotted: false, alignment: 2 },
  { duration: 1, value: 'sixteenth', dotted: false, alignment: 1 },
];

// Undotted rests expose beats and half-bars, even when silence starts offbeat.
const REST_VALUES = [
  { duration: 16, value: 'whole', dotted: false, alignment: 16 },
  { duration: 8, value: 'half', dotted: false, alignment: 8 },
  { duration: 4, value: 'quarter', dotted: false, alignment: 4 },
  { duration: 2, value: 'eighth', dotted: false, alignment: 2 },
  { duration: 1, value: 'sixteenth', dotted: false, alignment: 1 },
];

export function buildRhythmNotation(notes, bars = 1) {
  if (!validPhrase(notes, bars)) throw new TypeError('Frase rítmica inválida.');
  const measures = Array.from({ length: bars }, (_, index) => ({ index: index + 1, events: [] }));

  function appendInterval(start, end, noteId = null) {
    const intervalStart = start;
    const values = noteId === null ? REST_VALUES : NOTE_VALUES;
    while (start < end) {
      const measureIndex = Math.floor(start / TICKS_PER_BAR);
      const available = Math.min(end, (measureIndex + 1) * TICKS_PER_BAR) - start;
      const symbol = values.find(candidate => candidate.duration <= available && start % candidate.alignment === 0);
      const segmentEnd = start + symbol.duration;
      measures[measureIndex].events.push({
        kind: noteId === null ? 'rest' : 'note',
        start,
        duration: symbol.duration,
        value: symbol.value,
        dotted: symbol.dotted,
        noteId,
        tieFromPrevious: noteId !== null && start > intervalStart,
        tieToNext: noteId !== null && segmentEnd < end,
      });
      start = segmentEnd;
    }
  }

  let cursor = 0;
  for (const note of [...notes].sort((a, b) => a.start - b.start)) {
    appendInterval(cursor, note.start);
    appendInterval(note.start, note.start + note.duration, note.id);
    cursor = note.start + note.duration;
  }
  appendInterval(cursor, bars * TICKS_PER_BAR);
  return { bars, measures };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const STAFF_Y = 70;
const MEASURE_WIDTH = 560;
const LEFT = 80;
const DIGITS = {
  1: 'M2 3 L5 0 L5 12 M2 12 H8',
  2: 'M0 3 C0 -1 8 -1 8 3 C8 6 0 8 0 12 H8',
  3: 'M0 1 C9 -2 11 6 4 6 C11 6 9 14 0 11',
  4: 'M6 12 V0 L0 8 H9',
};

export function renderRhythmNotation(container, model) {
  const document = container.ownerDocument;
  function element(name, attributes = {}, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (parent) parent.appendChild(node);
    return node;
  }
  function title(parent, text) {
    const node = element('title', {}, parent);
    node.textContent = text;
  }
  function line(parent, x1, y1, x2, y2, width = 1.5) {
    return element('line', { x1, y1, x2, y2, stroke: 'currentColor', 'stroke-width': width }, parent);
  }
  function digit(parent, value, x, y, scale = 1) {
    element('path', {
      d: DIGITS[value], transform: `translate(${x} ${y}) scale(${scale})`,
      fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }, parent);
  }

  const width = LEFT + model.bars * MEASURE_WIDTH + 24;
  const attacks = model.measures.reduce((count, measure) => count + measure.events.filter(event => event.kind === 'note' && !event.tieFromPrevious).length, 0);
  const svg = element('svg', {
    xmlns: SVG_NS, width: '100%', height: 136, viewBox: `0 0 ${width} 136`,
    role: 'img', 'aria-label': `Partitura rítmica em 4/4: ${model.bars} compasso(s), ${attacks} ataque(s). Pauta de uma linha, sem alturas.`,
    class: 'rhythm-notation', 'data-bars': model.bars,
  });
  title(svg, 'Ritmo em pauta de uma linha: ataques, durações, pausas e ligaduras; sem alturas musicais.');
  const staff = element('g', { class: 'rhythm-staff', 'aria-hidden': 'true' }, svg);
  line(staff, LEFT, STAFF_Y, width - 24, STAFF_Y, 1);
  digit(staff, 4, 40, 43, 1.5);
  digit(staff, 4, 40, 76, 1.5);
  for (let index = 0; index <= model.bars; index += 1) {
    const x = LEFT + index * MEASURE_WIDTH;
    const barline = element('g', { class: 'rhythm-barline' }, staff);
    line(barline, x, 53, x, 87, index === model.bars ? 3 : 1.5);
    if (index === model.bars) line(barline, x - 6, 53, x - 6, 87, 1);
    else digit(staff, index + 1, x + 14, 16);
  }

  function drawNote(group, event, x) {
    const hollow = event.value === 'whole' || event.value === 'half';
    element('ellipse', {
      cx: x, cy: STAFF_Y, rx: event.value === 'whole' ? 9 : 7, ry: 4.8,
      transform: `rotate(${event.value === 'whole' ? 0 : -20} ${x} ${STAFF_Y})`,
      fill: hollow ? 'none' : 'currentColor', stroke: 'currentColor', 'stroke-width': hollow ? 2.2 : 1,
    }, group);
    if (event.value === 'whole') return;
    const stemX = x + 6;
    line(group, stemX, STAFF_Y - 1, stemX, STAFF_Y - 36, 1.7);
    const flags = event.value === 'sixteenth' ? 2 : event.value === 'eighth' ? 1 : 0;
    for (let index = 0; index < flags; index += 1) {
      const y = STAFF_Y - 36 + index * 9;
      element('path', {
        d: `M ${stemX} ${y} C ${stemX + 2} ${y + 7}, ${stemX + 17} ${y + 8}, ${stemX + 12} ${y + 23} C ${stemX + 22} ${y + 7}, ${stemX + 5} ${y + 6}, ${stemX} ${y + 1} Z`,
        fill: 'currentColor',
      }, group);
    }
  }

  function drawRest(group, event, x) {
    if (event.value === 'whole' || event.value === 'half') {
      element('rect', {
        x: x - 7, y: event.value === 'whole' ? STAFF_Y : STAFF_Y - 6,
        width: 14, height: 6, fill: 'currentColor',
      }, group);
    } else if (event.value === 'quarter') {
      element('path', {
        d: `M ${x - 4} 45 L ${x + 6} 56 L ${x - 1} 66 L ${x + 7} 77 C ${x - 4} 73, ${x - 10} 80, ${x - 2} 91 C ${x - 14} 83, ${x - 10} 73, ${x} 73 L ${x - 8} 63 L ${x - 1} 54 Z`,
        fill: 'currentColor',
      }, group);
    } else {
      const flags = event.value === 'sixteenth' ? 2 : 1;
      line(group, x + 5, 55, x - 4, 86, 2);
      for (let index = 0; index < flags; index += 1) {
        const y = 58 + index * 10;
        const offset = index * -3;
        element('circle', { cx: x - 4 + offset, cy: y, r: 3.8, fill: 'currentColor' }, group);
        element('path', {
          d: `M ${x - 4 + offset} ${y + 3} Q ${x + 1 + offset} ${y + 8} ${x + 5 + offset} ${y - 3}`,
          fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
        }, group);
      }
    }
  }

  let previousNote = null;
  const ties = element('g', { class: 'rhythm-ties' }, svg);
  for (const measure of model.measures) {
    const measureLeft = LEFT + (measure.index - 1) * MEASURE_WIDTH;
    for (const event of measure.events) {
      const wholeMeasureRest = event.kind === 'rest' && event.duration === TICKS_PER_BAR;
      const x = wholeMeasureRest
        ? measureLeft + MEASURE_WIDTH / 2
        : measureLeft + 24 + (event.start % TICKS_PER_BAR) * 32;
      const attributes = {
        class: `rhythm-${event.kind}`, 'data-start': event.start, 'data-duration': event.duration,
        'data-value': event.value, 'data-dotted': event.dotted,
        'data-tied-from': event.tieFromPrevious, 'data-tied-to': event.tieToNext,
      };
      if (event.kind === 'note') attributes['data-note-id'] = event.noteId;
      const group = element('g', attributes, svg);
      title(group, `${event.kind === 'note' ? `Nota ${event.noteId}` : 'Pausa'}: início ${event.start} semicolcheia(s), duração ${event.duration} semicolcheia(s), compasso ${measure.index}${event.tieFromPrevious ? '; continuação ligada' : ''}${event.tieToNext ? '; segue ligada' : ''}.`);
      if (event.kind === 'note') {
        drawNote(group, event, x);
        if (event.tieFromPrevious && previousNote && previousNote.event.noteId === event.noteId && previousNote.event.tieToNext) {
          const fromX = previousNote.x + 5;
          const toX = x - 5;
          const span = toX - fromX;
          element('path', {
            class: 'rhythm-tie', 'data-note-id': event.noteId,
            'data-from-start': previousNote.event.start, 'data-to-start': event.start,
            d: `M ${fromX} 81 C ${fromX + span / 3} 98, ${toX - span / 3} 98, ${toX} 81 C ${toX - span / 3} 94, ${fromX + span / 3} 94, ${fromX} 81 Z`,
            fill: 'currentColor',
          }, ties);
        }
        previousNote = { event, x };
      } else {
        drawRest(group, event, x);
        previousNote = null;
      }
      if (event.dotted) {
        element('circle', { cx: x + 15, cy: STAFF_Y - 7, r: 2.3, fill: 'currentColor' }, group);
      }
    }
  }
  container.replaceChildren(svg);
  return svg;
}
