import { EPSILON, ticksPerBar } from './meter.js';
import { validPhrase } from './model.js';

// Durações em ticks (4 = semínima). Notas mantêm valores pontuados e seu
// alinhamento sem mudar o ataque nem o término de nenhuma nota original.
const NOTE_VALUES = [
  { duration: 16, value: 'whole', dotted: false, alignment: 16 },
  { duration: 12, value: 'half', dotted: true, alignment: 4 },
  { duration: 8, value: 'half', dotted: false, alignment: 4 },
  { duration: 6, value: 'quarter', dotted: true, alignment: 4 },
  { duration: 4, value: 'quarter', dotted: false, alignment: 4 },
  { duration: 3, value: 'eighth', dotted: true, alignment: 2 },
  { duration: 2, value: 'eighth', dotted: false, alignment: 2 },
  { duration: 1.5, value: 'sixteenth', dotted: true, alignment: 1 },
  { duration: 1, value: 'sixteenth', dotted: false, alignment: 1 },
  { duration: 0.5, value: 'thirty-second', dotted: false, alignment: 0.5 },
];

// Pausas sem ponto expõem tempos e meios compassos, mesmo quando o silêncio
// começa no contratempo.
const REST_VALUES = [
  { duration: 16, value: 'whole', dotted: false, alignment: 16 },
  { duration: 8, value: 'half', dotted: false, alignment: 8 },
  { duration: 4, value: 'quarter', dotted: false, alignment: 4 },
  { duration: 2, value: 'eighth', dotted: false, alignment: 2 },
  { duration: 1, value: 'sixteenth', dotted: false, alignment: 1 },
  { duration: 0.5, value: 'thirty-second', dotted: false, alignment: 0.5 },
];

// Quiálteras reconhecidas dentro de uma semínima: n notas no tempo de m.
const TUPLETS = [
  { actual: 3, normal: 2, unit: 2 },
  { actual: 6, normal: 4, unit: 1 },
  { actual: 5, normal: 4, unit: 1 },
  { actual: 7, normal: 4, unit: 1 },
];

function near(value, target) {
  return Math.abs(value - target) < EPSILON;
}

function isMultiple(value, step) {
  return near(value / step, Math.round(value / step));
}

function resolveSpan(span, options) {
  if (typeof span === 'number') {
    return { bars: span, meter: options.meter ?? { beats: 4, unit: 4 }, subdivision: options.subdivision ?? 4 };
  }
  if (span && typeof span === 'object') {
    return { bars: span.bars, meter: options.meter ?? span.meter ?? { beats: 4, unit: 4 }, subdivision: options.subdivision ?? span.subdivision ?? 4 };
  }
  return { bars: NaN, meter: { beats: 4, unit: 4 }, subdivision: 4 };
}

// Spans de detecção de quiálteras: semínimas a partir da barra (o último
// pode ser menor em compassos como 7/8); compassos compostos usam a
// semínima pontuada e permanecem binários.
function beatSpans(meter, barTicks) {
  const compound = meter.unit === 8 && meter.beats % 3 === 0 && meter.beats >= 6;
  const size = compound ? 6 : 4;
  const spans = [];
  for (let start = 0; start < barTicks - EPSILON; start += size) spans.push({ start, end: Math.min(barTicks, start + size), compound });
  return spans;
}

export function buildRhythmNotation(notes, span = 1, options = {}) {
  const { bars, meter, subdivision } = resolveSpan(span, options);
  if (!validPhrase(notes, { bars, meter })) throw new TypeError('Frase rítmica inválida.');
  const barTicks = ticksPerBar(meter);
  const total = bars * barTicks;
  const sorted = [...notes].sort((a, b) => a.start - b.start);

  // Segmentos contínuos (notas e silêncios) cobrindo toda a frase.
  const segments = [];
  let cursor = 0;
  for (const note of sorted) {
    if (note.start > cursor + EPSILON) segments.push({ start: cursor, end: note.start, note: null });
    segments.push({ start: note.start, end: note.start + note.duration, note });
    cursor = note.start + note.duration;
  }
  if (cursor < total - EPSILON) segments.push({ start: cursor, end: total, note: null });

  // Uma semínima pode misturar escrita binária e quiáltera. Procuramos o
  // grupo inteiro primeiro; se não cabe, dividimos em metades/ quartos sem
  // deslocar nenhuma fronteira da frase. Frações não reconhecíveis ficam
  // explicitamente aproximadas, nunca recebem uma razão fictícia.
  const spans = [];
  const boundaries = [...new Set(segments.flatMap(segment => [segment.start, segment.end]))];
  function classifySpan(start, end, bar, compound = false) {
    const inside = boundaries.filter(value => value > start + EPSILON && value < end - EPSILON).map(value => value - start);
    const length = end - start;
    const binary = inside.every(value => isMultiple(value, 0.5));
    const candidate = !binary && !compound && [1, 2, 4].some(size => near(length, size))
      ? TUPLETS.find(item => length / item.normal >= 0.5 - EPSILON
        && inside.every(value => isMultiple(value, length / item.actual)))
      : null;
    const tuplet = candidate ? { ...candidate, unit: length / candidate.normal } : null;
    if (!binary && !tuplet && length >= 2 - EPSILON) {
      const split = compound && length > 4 ? 4 : length / 2;
      classifySpan(start, start + split, bar);
      classifySpan(start + split, end, bar);
      return;
    }
    spans.push({ start, end, bar, tuplet, approximate: !binary && !tuplet, id: `t${bar + 1}-${start}` });
  }
  for (let bar = 0; bar < bars; bar += 1) {
    for (const local of beatSpans(meter, barTicks)) {
      classifySpan(bar * barTicks + local.start, bar * barTicks + local.end, bar, local.compound);
    }
  }

  const measures = Array.from({ length: bars }, (_, index) => ({ index: index + 1, events: [] }));
  const spanAt = tick => spans.find(item => tick >= item.start - EPSILON && tick < item.end - EPSILON);

  function push(segment, start, duration, symbol, tuplet, intervalStart, approximate) {
    const measureIndex = Math.min(bars - 1, Math.floor((start + EPSILON) / barTicks));
    const note = segment.note;
    measures[measureIndex].events.push({
      kind: note ? 'note' : 'rest',
      start,
      duration,
      value: symbol.value,
      dotted: symbol.dotted,
      noteId: note ? note.id : null,
      tieFromPrevious: Boolean(note) && start > intervalStart + EPSILON,
      tieToNext: Boolean(note) && start + duration < segment.end - EPSILON,
      tuplet: tuplet ? { actual: tuplet.tuplet.actual, normal: tuplet.tuplet.normal, id: tuplet.id } : null,
      articulation: note ? note.articulation ?? 'normal' : null,
      velocity: note ? note.velocity ?? 0.8 : null,
      pitch: note ? note.pitch ?? 69 : null,
      approximate,
    });
  }

  function binary(segment, start, end, approximate) {
    const values = segment.note ? NOTE_VALUES : REST_VALUES;
    const fullBarRest = !segment.note && near(start % barTicks, 0) && near(end - start, barTicks);
    if (fullBarRest) {
      push(segment, start, barTicks, { value: 'whole', dotted: false }, null, segment.start, approximate);
      return;
    }
    while (start < end - EPSILON) {
      const local = start - Math.floor((start + EPSILON) / barTicks) * barTicks;
      const available = end - start;
      // Valores fracionários (semicolcheia pontuada, fusa) só onde a própria
      // frase sai da grade de semicolcheias; senão a grafia histórica é mantida.
      const fractional = !isMultiple(local, 1) || !isMultiple(available, 1);
      const symbol = values.find(candidate => candidate.duration <= available + EPSILON && isMultiple(local, candidate.alignment)
        && (fractional || Number.isInteger(candidate.duration)))
        ?? (approximate ? { duration: available, value: 'thirty-second', dotted: false } : values.at(-1));
      const duration = Math.min(symbol.duration, available);
      push(segment, start, duration, symbol, null, segment.start, approximate);
      start += duration;
    }
  }

  function tupletPiece(segment, start, end, span) {
    const { unit } = span.tuplet;
    const realUnit = (span.end - span.start) / span.tuplet.actual;
    const values = segment.note ? NOTE_VALUES : REST_VALUES;
    let position = Math.round((start - span.start) / realUnit);
    let remaining = Math.round((end - start) / realUnit);
    while (remaining > 0) {
      const nominalStart = position * unit;
      const symbol = values.find(candidate => candidate.duration <= remaining * unit + EPSILON && isMultiple(nominalStart, candidate.alignment)
        && isMultiple(candidate.duration, unit)) ?? values.find(candidate => near(candidate.duration, unit));
      const units = Math.round(symbol.duration / unit);
      push(segment, span.start + position * realUnit, units * realUnit, symbol, span, segment.start, false);
      position += units;
      remaining -= units;
    }
  }

  for (const segment of segments) {
    // Divide em barras e nas fronteiras de spans de quiáltera/aproximação.
    let start = segment.start;
    while (start < segment.end - EPSILON) {
      const current = spanAt(start);
      const barEnd = (Math.floor((start + EPSILON) / barTicks) + 1) * barTicks;
      let end = Math.min(segment.end, barEnd);
      if (current.tuplet || current.approximate) {
        end = Math.min(end, current.end);
        if (current.tuplet) tupletPiece(segment, start, end, current);
        else binary(segment, start, end, true);
      } else {
        for (const other of spans) {
          if ((other.tuplet || other.approximate) && other.start > start + EPSILON && other.start < end - EPSILON) end = other.start;
        }
        binary(segment, start, end, false);
      }
      start = end;
    }
  }
  return { bars, meter: { ...meter }, ticksPerBar: barTicks, subdivision, measures };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const STAFF_Y = 70;
const LEFT = 80;
const PX_PER_TICK = 32;
const DIGITS = {
  0: 'M4 0 C-1 0 -1 12 4 12 C9 12 9 0 4 0 Z',
  1: 'M2 3 L5 0 L5 12 M2 12 H8',
  2: 'M0 3 C0 -1 8 -1 8 3 C8 6 0 8 0 12 H8',
  3: 'M0 1 C9 -2 11 6 4 6 C11 6 9 14 0 11',
  4: 'M6 12 V0 L0 8 H9',
  5: 'M8 0 H1 L0 5 C6 3 9 6 8 9 C7 13 1 12 0 10',
  6: 'M7 1 C2 -1 0 4 0 8 C0 13 8 13 8 8 C8 4 1 4 0 8',
  7: 'M0 0 H8 L3 12',
  8: 'M4 6 C-1 5 0 0 4 0 C8 0 9 5 4 6 C-1 7 -1 12 4 12 C9 12 9 7 4 6 Z',
  9: 'M8 4 C7 8 0 8 0 4 C0 -1 8 -1 8 4 C8 8 7 12 1 11',
};

function formatTicks(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace('.', ',');
}

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
  function number(parent, value, x, y, scale = 1) {
    const text = String(value);
    [...text].forEach((char, index) => {
      element('path', {
        d: DIGITS[char], transform: `translate(${x + index * 11 * scale - ((text.length - 1) * 5.5 * scale)} ${y}) scale(${scale})`,
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }, parent);
    });
  }

  const meter = model.meter ?? { beats: 4, unit: 4 };
  const barTicks = model.ticksPerBar ?? 16;
  const layouts = [];
  let right = LEFT;
  for (const measure of model.measures) {
    let cursor = 24;
    const positions = measure.events.map(event => {
      const x = cursor;
      cursor += Math.max(32, event.duration * PX_PER_TICK);
      return x;
    });
    const width = Math.max(48 + barTicks * PX_PER_TICK, cursor + 24);
    layouts.push({ left: right, width, positions });
    right += width;
  }
  const width = right + 24;
  const attacks = model.measures.reduce((count, measure) => count + measure.events.filter(event => event.kind === 'note' && !event.tieFromPrevious).length, 0);
  const tuplets = new Set(model.measures.flatMap(measure => measure.events.filter(event => event.tuplet).map(event => event.tuplet.id)));
  const svg = element('svg', {
    xmlns: SVG_NS, width: '100%', height: 150, viewBox: `0 0 ${width} 150`,
    role: 'img', 'aria-label': `Partitura rítmica em ${meter.beats}/${meter.unit}: ${model.bars} compasso(s), ${attacks} ataque(s)${tuplets.size ? `, ${tuplets.size} grupo(s) de quiálteras` : ''}. Pauta de uma linha, sem alturas.`,
    class: 'rhythm-notation', 'data-bars': model.bars, 'data-meter': `${meter.beats}/${meter.unit}`,
  });
  svg.style.minWidth = `${width}px`;
  title(svg, 'Ritmo em pauta de uma linha: ataques, durações, pausas, ligaduras, quiálteras e articulações; sem alturas musicais.');
  const staff = element('g', { class: 'rhythm-staff', 'aria-hidden': 'true' }, svg);
  line(staff, LEFT, STAFF_Y, width - 24, STAFF_Y, 1);
  number(staff, meter.beats, 44, 43, 1.5);
  number(staff, meter.unit, 44, 76, 1.5);
  for (let index = 0; index <= model.bars; index += 1) {
    const x = index === model.bars ? right : layouts[index].left;
    const barline = element('g', { class: 'rhythm-barline' }, staff);
    line(barline, x, 53, x, 87, index === model.bars ? 3 : 1.5);
    if (index === model.bars) line(barline, x - 6, 53, x - 6, 87, 1);
    else number(staff, index + 1, x + 18, 16);
  }

  function drawNote(group, event, x) {
    const hollow = event.value === 'whole' || event.value === 'half';
    const ghost = event.articulation === 'ghost';
    element('ellipse', {
      cx: x, cy: STAFF_Y, rx: event.value === 'whole' ? 9 : 7, ry: 4.8,
      transform: `rotate(${event.value === 'whole' ? 0 : -20} ${x} ${STAFF_Y})`,
      fill: hollow ? 'none' : 'currentColor', stroke: 'currentColor', 'stroke-width': hollow ? 2.2 : 1,
    }, group);
    if (ghost) {
      for (const side of [-1, 1]) {
        element('path', {
          class: 'rhythm-ghost', d: `M ${x + side * 10} ${STAFF_Y - 7} Q ${x + side * 14} ${STAFF_Y} ${x + side * 10} ${STAFF_Y + 7}`,
          fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3,
        }, group);
      }
    }
    if (event.articulation === 'accent') {
      element('path', { class: 'rhythm-accent', d: `M ${x - 6} ${STAFF_Y + 12} L ${x + 6} ${STAFF_Y + 16} L ${x - 6} ${STAFF_Y + 20}`, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }, group);
    } else if (event.articulation === 'staccato') {
      element('circle', { class: 'rhythm-staccato', cx: x, cy: STAFF_Y + 14, r: 2, fill: 'currentColor' }, group);
    } else if (event.articulation === 'tenuto') {
      line(group, x - 6, STAFF_Y + 14, x + 6, STAFF_Y + 14, 2);
    }
    if (event.value === 'whole') return;
    const stemX = x + 6;
    line(group, stemX, STAFF_Y - 1, stemX, STAFF_Y - 36, 1.7);
    const flags = { 'thirty-second': 3, sixteenth: 2, eighth: 1 }[event.value] ?? 0;
    for (let index = 0; index < flags; index += 1) {
      const y = STAFF_Y - 36 + index * 8;
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
      const flags = { 'thirty-second': 3, sixteenth: 2 }[event.value] ?? 1;
      line(group, x + 5, 55, x - 4, 86, 2);
      for (let index = 0; index < flags; index += 1) {
        const y = 58 + index * 9;
        const offset = index * -3;
        element('circle', { cx: x - 4 + offset, cy: y, r: 3.6, fill: 'currentColor' }, group);
        element('path', {
          d: `M ${x - 4 + offset} ${y + 3} Q ${x + 1 + offset} ${y + 8} ${x + 5 + offset} ${y - 3}`,
          fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
        }, group);
      }
    }
  }

  let previousNote = null;
  const ties = element('g', { class: 'rhythm-ties' }, svg);
  const groups = new Map();
  for (const measure of model.measures) {
    const layout = layouts[measure.index - 1];
    for (const [eventIndex, event] of measure.events.entries()) {
      const wholeMeasureRest = event.kind === 'rest' && near(event.duration, barTicks);
      const x = layout.left + (wholeMeasureRest ? layout.width / 2 : layout.positions[eventIndex]);
      const attributes = {
        class: `rhythm-${event.kind}`, 'data-start': event.start, 'data-duration': event.duration,
        'data-value': event.value, 'data-dotted': event.dotted,
        'data-tied-from': event.tieFromPrevious, 'data-tied-to': event.tieToNext,
      };
      if (event.kind === 'note') {
        attributes['data-note-id'] = event.noteId;
        attributes['data-articulation'] = event.articulation;
      }
      if (event.tuplet) attributes['data-tuplet'] = `${event.tuplet.actual}:${event.tuplet.normal}`;
      const group = element('g', attributes, svg);
      const tupletText = event.tuplet ? `; quiáltera ${event.tuplet.actual}:${event.tuplet.normal}` : '';
      const articulation = event.kind === 'note' && event.articulation && event.articulation !== 'normal' ? `; articulação ${event.articulation}` : '';
      title(group, `${event.kind === 'note' ? `Nota ${event.noteId}` : 'Pausa'}: início ${formatTicks(event.start)} semicolcheia(s), duração ${formatTicks(event.duration)} semicolcheia(s), compasso ${measure.index}${tupletText}${articulation}${event.approximate ? '; grafia aproximada' : ''}${event.tieFromPrevious ? '; continuação ligada' : ''}${event.tieToNext ? '; segue ligada' : ''}.`);
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
      if (event.tuplet) {
        const entry = groups.get(event.tuplet.id) ?? { tuplet: event.tuplet, first: x, last: x };
        entry.first = Math.min(entry.first, x);
        entry.last = Math.max(entry.last, x);
        groups.set(event.tuplet.id, entry);
      }
    }
  }
  const brackets = element('g', { class: 'rhythm-tuplets' }, svg);
  for (const { tuplet, first, last } of groups.values()) {
    const bracket = element('g', { class: 'rhythm-tuplet', 'data-tuplet': `${tuplet.actual}:${tuplet.normal}` }, brackets);
    const y = STAFF_Y - 46;
    const left = first - 4;
    const right = last + 10;
    const middle = (left + right) / 2;
    line(bracket, left, y + 5, left, y, 1.2);
    line(bracket, left, y, middle - 9, y, 1.2);
    line(bracket, middle + 9, y, right, y, 1.2);
    line(bracket, right, y, right, y + 5, 1.2);
    number(bracket, tuplet.actual, middle - 4, y - 6, 0.9);
  }
  container.replaceChildren(svg);
  return svg;
}
