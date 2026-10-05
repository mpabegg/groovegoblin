// Bateria por estilo/densidade para qualquer fórmula de compasso.
// Retorna golpes em ticks retos da sessão; o swing (quando cabível) e o
// microtempo são aplicados pelo arranjo. kick/snare/hihat usam os samples
// CC0 locais; os demais instrumentos são sintetizados (synth.js).
import { ticksPerBar, beatTicks, groupStarts, beatGroups } from './meter.js';
import { seededRandom, deriveSeed } from './random.js';
import { validateSession } from './session.js';
import { DRUM_EDIT_VOICES, DRUM_POSITION_EPSILON } from './drum-edits.js';

export const DRUM_INSTRUMENTS = Object.freeze(['kick', 'snare', 'hihat']);
export const SYNTH_DRUMS = Object.freeze(['openhat', 'rim', 'ride', 'shaker', 'tom', 'triangle']);
export const DRUM_VOICES = DRUM_EDIT_VOICES;
// Estilos escritos em grade de tercina: o swing da sessão não é reaplicado.
export const TRIPLET_STYLES = Object.freeze(['shuffle', 'jazz']);

const T = 8 / 3; // última tercina de colcheia dentro da semínima

function range(start, end, step) {
  const values = [];
  for (let tick = start; tick < end - 1e-9; tick += step) values.push(tick);
  return values;
}

// Modelos 4/4 (16 ticks): [instrumento, tick, velocidade]. "bar" (0/1) alterna
// padrões de dois compassos como a clave da bossa.
const TEMPLATES = {
  pop: ({ density }) => [
    ['kick', 0, 0.9], ['kick', 8, 0.82], ...(density === 'busy' ? [['kick', 10, 0.6]] : []),
    ['snare', 4, 0.8], ['snare', 12, 0.85],
    ...hats(density, 0.45, 0.3),
  ],
  rock: ({ density }) => [
    ['kick', 0, 0.95], ['kick', 8, 0.85], ...(density !== 'sparse' ? [['kick', 10, 0.7]] : []),
    ...(density === 'busy' ? [['kick', 3, 0.55]] : []),
    ['snare', 4, 0.9], ['snare', 12, 0.9],
    ...hats(density, 0.5, 0.38),
  ],
  funk: ({ density }) => [
    ['kick', 0, 0.95], ['kick', 3, 0.6], ['kick', 10, 0.8], ...(density === 'busy' ? [['kick', 7, 0.55]] : []),
    ['snare', 4, 0.9], ['snare', 12, 0.9],
    ...(density !== 'sparse' ? [['snare', 7, 0.24], ['snare', 9, 0.22]] : []),
    ...(density === 'busy' ? [['snare', 14, 0.24]] : []),
    ...range(0, 16, density === 'sparse' ? 2 : 1).map(tick => ['hihat', tick, tick % 2 === 0 ? 0.45 : 0.22]),
  ],
  shuffle: ({ density }) => [
    ['kick', 0, 0.9], ['kick', 8, 0.8], ...(density === 'busy' ? [['kick', 8 + T, 0.55]] : []),
    ['snare', 4, 0.85], ['snare', 12, 0.85],
    ...range(0, 16, 4).flatMap(beat => [
      ['hihat', beat, 0.45], ...(density !== 'sparse' ? [['hihat', beat + T, 0.3]] : []),
    ]),
  ],
  jazz: ({ density, random }) => [
    ['ride', 0, 0.5], ['ride', 4, 0.55], ['ride', 4 + T, 0.35], ['ride', 8, 0.5], ['ride', 12, 0.55], ['ride', 12 + T, 0.35],
    ['hihat', 4, 0.3], ['hihat', 12, 0.3],
    ...(density === 'sparse' ? [] : range(0, 16, 4).map(tick => ['kick', tick, 0.22])),
    ...(density === 'busy'
      ? [T, 4 + T, 8 + T, 12 + T].filter(() => random() < 0.45).map(tick => ['snare', tick, 0.28])
      : []),
  ],
  bossa: ({ density, bar }) => [
    ['kick', 0, 0.75], ['kick', 6, 0.55], ['kick', 8, 0.75], ['kick', 14, 0.55],
    ...(bar % 2 === 0 ? [0, 6, 12] : [4, 10]).map(tick => ['rim', tick, 0.6]),
    ...(density === 'busy'
      ? range(0, 16, 1).map(tick => ['shaker', tick, tick % 2 === 0 ? 0.32 : 0.18])
      : hats(density, 0.35, 0.25)),
  ],
  samba: ({ density }) => [
    ['kick', 0, 0.5], ['kick', 4, 0.85], ['kick', 8, 0.5], ['kick', 12, 0.85],
    ...(density === 'busy' ? [['kick', 3, 0.4], ['kick', 11, 0.4]] : []),
    ...(density !== 'sparse' ? [0, 3, 6, 10, 12].map(tick => ['rim', tick, 0.5]) : []),
    ...range(0, 16, density === 'sparse' ? 2 : 1).map(tick => ['shaker', tick, tick % 4 === 3 ? 0.45 : 0.22]),
  ],
  baiao: ({ density }) => [
    ['kick', 0, 0.85], ['kick', 3, 0.6], ['kick', 8, 0.85], ['kick', 11, 0.6],
    ...(density !== 'sparse' ? [2, 6, 10, 14].map(tick => ['rim', tick, 0.45]) : []),
    ...range(0, 16, density === 'sparse' ? 2 : 1).map(tick => ['triangle', tick, tick % 4 === 2 ? 0.45 : 0.22]),
  ],
  reggae: ({ density }) => [
    ['kick', 8, 0.85], ['rim', 8, 0.75],
    ...hats(density, 0.35, 0.3),
    ...(density === 'busy' ? [['openhat', 14, 0.3]] : []),
  ],
  waltz: ({ density }) => [
    ['kick', 0, 0.85], ['snare', 4, 0.45], ['snare', 8, 0.45], ['kick', 8, 0.4],
    ...(density === 'busy' ? [['kick', 10, 0.35]] : []),
    ['snare', 12, 0.5],
    ...hats(density, 0.35, 0.22),
  ],
};

function hats(density, onBeat, offBeat) {
  const step = density === 'sparse' ? 4 : density === 'busy' ? 1 : 2;
  return range(0, 16, step).map(tick => ['hihat', tick, tick % 4 === 0 ? onBeat : tick % 2 === 0 ? offBeat : offBeat * 0.6]);
}

// Valsa em 3/4 tem modelo próprio; outros estilos em 3/4 usam o genérico.
function waltzThreeFour(density) {
  return [
    ['kick', 0, 0.85], ['snare', 4, 0.4], ['snare', 8, 0.4],
    ...range(0, 12, density === 'busy' ? 2 : 4).map(tick => ['hihat', tick, tick % 4 === 0 ? 0.35 : 0.22]),
  ];
}

// Padrão genérico por agrupamento de tempos: bumbo nos grupos pares,
// caixa nos ímpares (ou no meio de um grupo único), chimbal por subdivisão.
function genericBar(session, style, density) {
  const barTicks = ticksPerBar(session);
  const starts = groupStarts(session);
  const step = beatTicks(session);
  const hits = [];
  starts.forEach((start, index) => {
    if (index % 2 === 0) hits.push(['kick', start, index === 0 ? 0.9 : 0.72]);
    else hits.push([style === 'reggae' || style === 'bossa' ? 'rim' : 'snare', start, 0.8]);
  });
  if (starts.length === 1 && barTicks > step) hits.push(['snare', Math.floor(beatGroups(session)[0] / 2) * step || step, 0.75]);
  const triplet = TRIPLET_STYLES.includes(style) && session.meter.unit <= 4;
  const hatStep = density === 'sparse' ? Math.max(step, 2) : density === 'busy' ? 1 : 2;
  const cymbal = style === 'jazz' ? 'ride' : style === 'samba' || style === 'bossa' ? 'shaker' : style === 'baiao' ? 'triangle' : 'hihat';
  if (triplet) {
    for (const beat of range(0, barTicks, 4)) {
      hits.push([cymbal, beat, 0.45]);
      if (density !== 'sparse' && beat + T < barTicks) hits.push([cymbal, beat + T, 0.3]);
    }
  } else {
    for (const tick of range(0, barTicks, hatStep)) {
      hits.push([cymbal, tick, starts.includes(tick) ? 0.45 : tick % 2 === 0 ? 0.32 : 0.2]);
    }
  }
  if (style === 'funk' && density !== 'sparse') {
    for (const tick of range(3, barTicks, 4)) hits.push(['snare', tick, 0.22]);
  }
  return hits;
}

// Estilo complementar: o bumbo apoia alguns ataques da frase sem copiá-los.
function complementBar(session, bar, attacks, random) {
  const barTicks = ticksPerBar(session);
  const starts = groupStarts(session);
  const fourFour = barTicks === 16 && session.meter.unit === 4;
  const middle = fourFour ? 8 : starts[Math.floor(starts.length / 2)] ?? 0;
  const backbeats = fourFour ? [4, 12] : starts.filter((_, index) => index % 2 === 1);
  const kicks = new Set([0]);
  // Um apoio na segunda metade, depois até dois ataques selecionados da frase.
  // Coincidir com o baixo é válido: apoiar não significa copiar todos os ataques.
  if (middle > 0) kicks.add(attacks.includes(middle) || random() < 0.65 ? middle : Math.min(middle + 2, barTicks - 1));
  const candidates = attacks.filter(tick => !kicks.has(tick) && !backbeats.includes(tick));
  const count = Math.min(candidates.length, attacks.length > 6 ? 1 : 2);
  for (let index = 0; index < count; index += 1) {
    const choice = Math.floor(random() * candidates.length);
    kicks.add(candidates.splice(choice, 1)[0]);
  }
  const hits = [...kicks].sort((a, b) => a - b).map(tick => ['kick', tick, tick === 0 ? 0.9 : 0.72]);
  for (const tick of backbeats) hits.push(['snare', tick, tick === backbeats.at(-1) ? 0.82 : 0.76]);
  // Colcheias com espaço nas frases densas; um único pickup opcional, não um fill copiado.
  for (let tick = 0; tick < barTicks; tick += 2) {
    if (tick % 4 !== 0 && (attacks.length > 6 || random() < 0.22)) continue;
    hits.push(['hihat', tick, tick % 4 === 0 ? 0.5 : 0.32]);
  }
  if (attacks.length <= 6 && random() < 0.5) hits.push(['hihat', barTicks - 1, 0.24]);
  return hits;
}

function templateFor(session, style, bar, random) {
  const { density } = session.drums;
  const barTicks = ticksPerBar(session);
  if (style === 'waltz' && barTicks === 12 && session.meter.unit === 4) return waltzThreeFour(density);
  if (session.meter.unit === 4 && session.meter.beats === 4) return TEMPLATES[style]({ density, bar, random });
  if (session.meter.unit === 4 && session.meter.beats === 2) {
    const half = (bar % 2) * 8;
    return TEMPLATES[style]({ density, bar: Math.floor(bar / 2), random })
      .filter(([, tick]) => tick >= half && tick < half + 8)
      .map(([instrument, tick, velocity]) => [instrument, tick - half, velocity]);
  }
  return genericBar(session, style, density);
}

// Virada curta no último tempo do fim do loop (ou a cada 4 compassos).
function fillBar(session, bar) {
  const { startBar, endBar } = session.loop;
  if (bar < startBar || bar >= endBar) return false;
  const loopBars = endBar - startBar;
  return (loopBars >= 2 && bar === endBar - 1) || (bar - startBar) % 4 === 3;
}

function addFill(hits, session) {
  const barTicks = ticksPerBar(session);
  const start = barTicks - Math.min(4, barTicks);
  const kept = hits.filter(([instrument, tick]) => tick < start || (instrument === 'kick' && tick === start));
  const fill = range(start, barTicks, 1).map((tick, index) => [index % 2 === 0 ? 'snare' : 'tom', tick, 0.5 + index * 0.08]);
  return [...kept, ...fill];
}

export function generateDrums(session) {
  const checked = validateSession(session);
  if (!checked.ok) throw new TypeError(checked.error);
  const valid = checked.session;
  const { seed, style, density } = valid.drums;
  const barTicks = ticksPerBar(valid);
  const hits = [];
  const stream = seededRandom(seed); // complementar: uma sequência contínua entre compassos
  for (let bar = 0; bar < valid.bars; bar += 1) {
    const offset = bar * barTicks;
    const random = style === 'complement' ? stream : seededRandom(deriveSeed(seed, bar));
    const attacks = valid.notes.filter(note => note.start >= offset - 1e-6 && note.start < offset + barTicks - 1e-6)
      .map(note => note.start - offset).sort((a, b) => a - b);
    let barHits = style === 'complement'
      ? complementBar(valid, bar, attacks, random)
      : templateFor(valid, style, bar, random);
    const fills = style === 'complement' ? density === 'busy' : density !== 'sparse';
    if (fills && fillBar(valid, bar)) barHits = addFill(barHits, valid);
    const seen = new Set();
    for (const [instrument, tick, velocity] of barHits) {
      const key = `${instrument}:${tick.toFixed(4)}`;
      if (seen.has(key) || tick < 0 || tick >= barTicks - 1e-9) continue;
      seen.add(key);
      const humanized = style === 'complement' ? velocity : velocity * (0.94 + random() * 0.12);
      hits.push({ instrument, start: offset + tick, velocity: Math.min(1, Math.max(0.05, Number(humanized.toFixed(3)))) });
    }
  }
  for (const edit of valid.drums.edits) {
    const index = hits.findIndex(hit => hit.instrument === edit.voice && Math.abs(hit.start - edit.start) <= DRUM_POSITION_EPSILON);
    if (edit.velocity === null) { if (index >= 0) hits.splice(index, 1); }
    else if (index >= 0) hits[index] = { ...hits[index], velocity: edit.velocity };
    else hits.push({ instrument: edit.voice, start: edit.start, velocity: edit.velocity });
  }
  hits.sort((a, b) => a.start - b.start || DRUM_VOICES.indexOf(a.instrument) - DRUM_VOICES.indexOf(b.instrument));
  return { hits, bars: valid.bars, seed, style };
}
