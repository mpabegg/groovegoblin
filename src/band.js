// Baixo e acompanhamento harmônico por estilo/densidade, derivados da
// linha do tempo de acordes (chordTimeline). Saída em ticks retos da sessão.
import { ticksPerBar, beatTicks, groupStarts, sessionTicks } from './meter.js';
import { chordTimeline, findKey } from './progression.js';
import { seededRandom, deriveSeed } from './random.js';

const T = 8 / 3;
const BASS_LOW = 28; // E1

function range(start, end, step) {
  const values = [];
  for (let tick = start; tick < end - 1e-9; tick += step) values.push(tick);
  return values;
}

// Modelos de baixo em 4/4: [tick, função, duração, velocidade].
// R fundamental, 5 quinta, 5- quinta abaixo, 8 oitava, 3 terça, 6 sexta,
// 7 sétima, L nota de condução (3 ou 5), A aproximação cromática ao próximo acorde.
const BASS_TEMPLATES = {
  pop: {
    sparse: [[0, 'R', 8, 0.85], [8, '5', 8, 0.7]],
    medium: [[0, 'R', 4, 0.85], [6, 'R', 2, 0.6], [8, '5', 4, 0.75], [14, 'A', 2, 0.6]],
    busy: [[0, 'R', 2, 0.85], [2, 'R', 2, 0.55], [4, '5', 2, 0.65], [6, 'R', 2, 0.55], [8, '8', 2, 0.75], [10, 'R', 2, 0.55], [12, '5', 2, 0.65], [14, 'A', 2, 0.6]],
  },
  rock: {
    sparse: range(0, 16, 4).map(tick => [tick, 'R', 4, tick === 0 ? 0.85 : 0.7]),
    medium: range(0, 16, 2).map(tick => [tick, 'R', 2, tick % 4 === 0 ? 0.8 : 0.6]),
    busy: range(0, 16, 2).map(tick => [tick, tick === 12 ? '5' : tick === 14 ? '8' : 'R', 2, tick % 4 === 0 ? 0.8 : 0.6]),
  },
  funk: {
    sparse: [[0, 'R', 2, 0.9], [10, '5', 2, 0.7]],
    medium: [[0, 'R', 1.5, 0.9], [3, '8', 1, 0.7], [6, 'R', 1, 0.6], [10, '5', 1, 0.75], [11, '7', 1, 0.6], [14, 'A', 1, 0.7]],
    busy: [[0, 'R', 1.5, 0.9], [2, 'R', 0.5, 0.35], [3, '8', 1, 0.7], [6, 'R', 1, 0.6], [7, '8', 1, 0.6], [10, '5', 1, 0.75], [11, '7', 1, 0.6], [13, '8', 1, 0.6], [14, 'A', 1, 0.7]],
  },
  shuffle: {
    sparse: [[0, 'R', 4, 0.8], [4, '3', 4, 0.7], [8, '5', 4, 0.75], [12, '6', 4, 0.7]],
    medium: [[0, 'R', 4, 0.8], [4, '3', 4, 0.7], [8, '5', 4, 0.75], [12, '6', 4, 0.7]],
    busy: range(0, 16, 4).flatMap((beat, index) => [
      [beat, ['R', '3', '5', '6'][index], T, 0.8], [beat + T, ['R', '3', '5', '6'][index], 4 - T, 0.55],
    ]),
  },
  jazz: {
    sparse: [[0, 'R', 8, 0.75], [8, '5', 8, 0.7]],
    medium: [[0, 'R', 4, 0.8], [4, 'L', 4, 0.7], [8, '5', 4, 0.72], [12, 'A', 4, 0.7]],
    busy: [[0, 'R', 4, 0.8], [4, 'L', 4, 0.7], [8, '5', 4, 0.72], [10 + 2 / 3, '5', 4 / 3, 0.45], [12, 'A', 4, 0.7]],
  },
  bossa: {
    sparse: [[0, 'R', 8, 0.8], [8, '5', 8, 0.7]],
    medium: [[0, 'R', 6, 0.8], [6, '5', 2, 0.6], [8, '5', 6, 0.75], [14, 'R', 2, 0.6]],
    busy: [[0, 'R', 6, 0.8], [6, '5', 2, 0.6], [8, '5', 4, 0.75], [12, '8', 2, 0.55], [14, 'A', 2, 0.6]],
  },
  samba: {
    sparse: [[0, 'R', 3, 0.6], [4, '5-', 4, 0.9], [8, 'R', 3, 0.6], [12, '5-', 4, 0.9]],
    medium: [[0, 'R', 2, 0.6], [3, 'R', 1, 0.4], [4, '5-', 4, 0.9], [8, 'R', 2, 0.6], [11, 'R', 1, 0.4], [12, '5-', 4, 0.9]],
    busy: [[0, 'R', 2, 0.6], [3, 'R', 1, 0.4], [4, '5-', 2, 0.9], [6, '8', 1, 0.45], [7, 'R', 1, 0.45], [8, 'R', 2, 0.6], [11, 'R', 1, 0.4], [12, '5-', 2, 0.9], [14, 'A', 2, 0.5]],
  },
  baiao: {
    sparse: [[0, 'R', 3, 0.85], [8, 'R', 3, 0.85]],
    medium: [[0, 'R', 3, 0.85], [3, '5', 5, 0.7], [8, 'R', 3, 0.85], [11, '5', 5, 0.7]],
    busy: [[0, 'R', 3, 0.85], [3, '5', 3, 0.7], [6, '8', 2, 0.5], [8, 'R', 3, 0.85], [11, '5', 3, 0.7], [14, 'A', 2, 0.5]],
  },
  reggae: {
    sparse: [[4, 'R', 4, 0.8], [12, '5', 4, 0.75]],
    medium: [[2, 'R', 1.5, 0.7], [4, 'R', 3, 0.8], [8, '5', 2, 0.7], [11, '3', 1, 0.6], [12, 'R', 3, 0.75]],
    busy: [[2, 'R', 1.5, 0.7], [4, 'R', 2, 0.8], [6, '3', 2, 0.6], [8, '5', 2, 0.7], [11, '3', 1, 0.6], [12, 'R', 2, 0.75], [14, 'A', 2, 0.6]],
  },
  waltz: {
    sparse: [[0, 'R', 16, 0.8]],
    medium: [[0, 'R', 4, 0.85], [8, '5', 4, 0.6]],
    busy: [[0, 'R', 4, 0.85], [8, '5', 4, 0.6], [12, 'R', 4, 0.7]],
  },
};

// Acompanhamento em 4/4: [tick, duração, velocidade]; "B" = padrão do 2º compasso.
const COMP_TEMPLATES = {
  pop: { sparse: [[0, 16, 0.5]], medium: [[0, 8, 0.55], [8, 8, 0.5]], busy: range(0, 16, 4).map(tick => [tick, 4, tick % 8 === 0 ? 0.5 : 0.4]) },
  rock: { sparse: [[0, 16, 0.55]], medium: range(0, 16, 4).map(tick => [tick, 3, 0.5]), busy: range(0, 16, 2).map(tick => [tick, 1.5, tick % 4 === 0 ? 0.5 : 0.4]) },
  funk: { sparse: [[6, 1, 0.5], [14, 1, 0.5]], medium: [[2, 1, 0.5], [6, 1, 0.5], [10, 1, 0.5], [14, 1, 0.5]], busy: [[2, 1, 0.5], [3, 0.5, 0.35], [6, 1, 0.5], [7, 0.5, 0.35], [10, 1, 0.5], [14, 1, 0.5], [15, 0.5, 0.35]] },
  shuffle: { sparse: [[0, 16, 0.45]], medium: [[4, 2, 0.5], [12, 2, 0.5]], busy: [[4, 2, 0.5], [4 + T, 4 / 3, 0.35], [12, 2, 0.5], [12 + T, 4 / 3, 0.35]] },
  jazz: { sparse: [[0, 6, 0.5]], medium: [[0, 3, 0.55], [6, 2, 0.5]], busy: [[0, 3, 0.55], [6, 2, 0.5], [8 + T, 4 / 3, 0.4], [12 + T, 4 / 3, 0.4]] },
  bossa: {
    sparse: [[0, 8, 0.45], [8, 8, 0.4]],
    medium: [[0, 2, 0.45], [6, 2, 0.45], [10, 2, 0.45], [12, 2, 0.45]],
    mediumB: [[2, 2, 0.45], [6, 2, 0.45], [8, 2, 0.45], [14, 2, 0.45]],
    busy: [[0, 2, 0.45], [3, 1, 0.35], [6, 2, 0.45], [10, 2, 0.45], [12, 2, 0.45]],
    busyB: [[2, 2, 0.45], [6, 2, 0.45], [8, 2, 0.45], [11, 1, 0.35], [14, 2, 0.45]],
  },
  samba: {
    sparse: [[0, 8, 0.45], [8, 8, 0.4]],
    medium: [[0, 1, 0.5], [3, 1, 0.45], [6, 1, 0.5], [10, 1, 0.45]],
    mediumB: [[2, 1, 0.45], [6, 1, 0.5], [8, 1, 0.45], [12, 1, 0.5], [14, 1, 0.45]],
    busy: [[0, 1, 0.5], [3, 1, 0.45], [6, 1, 0.5], [8, 1, 0.4], [10, 1, 0.45], [13, 1, 0.4]],
    busyB: [[2, 1, 0.45], [6, 1, 0.5], [8, 1, 0.45], [12, 1, 0.5], [14, 1, 0.45], [15, 1, 0.35]],
  },
  baiao: { sparse: [[2, 1, 0.45], [10, 1, 0.45]], medium: [[2, 1, 0.45], [6, 1, 0.45], [10, 1, 0.45], [14, 1, 0.45]], busy: [[0, 1, 0.4], [2, 1, 0.45], [6, 1, 0.45], [8, 1, 0.4], [10, 1, 0.45], [14, 1, 0.45]] },
  reggae: { sparse: [[4, 1.5, 0.5], [12, 1.5, 0.5]], medium: [[4, 1.5, 0.5], [12, 1.5, 0.5]], busy: [[2, 1, 0.45], [6, 1, 0.45], [10, 1, 0.45], [14, 1, 0.45]] },
  waltz: { sparse: [[0, 16, 0.45]], medium: [[4, 3, 0.45], [12, 3, 0.45]], busy: [[4, 2, 0.45], [8, 2, 0.4], [12, 2, 0.45]] },
};

const WALTZ_34 = {
  bass: { sparse: [[0, 'R', 12, 0.8]], medium: [[0, 'R', 4, 0.85]], busy: [[0, 'R', 4, 0.85], [8, '5', 4, 0.55]] },
  comp: { sparse: [[0, 12, 0.45]], medium: [[4, 3, 0.45], [8, 3, 0.45]], busy: [[4, 2, 0.45], [6, 1, 0.3], [8, 3, 0.45]] },
};

function isFourFour(session) {
  return session.meter.beats === 4 && session.meter.unit === 4;
}

function isThreeFour(session) {
  return session.meter.beats === 3 && session.meter.unit === 4;
}

function chordAt(timeline, tick) {
  return timeline.find(event => tick >= event.start - 1e-6 && tick < event.start + event.duration - 1e-6) ?? null;
}

function bassRootMidi(pc) {
  return BASS_LOW + ((pc - 4 + 12) % 12);
}

function chordInterval(chord, semitoneOptions, fallback) {
  for (const option of semitoneOptions) {
    if (chord.notes.some(note => (note.midi - chord.root + 120) % 12 === option)) return option;
  }
  return fallback;
}

function bassPitch(symbol, event, next, random) {
  const chord = event.chord;
  const rootPc = chord.bass ?? chord.root;
  const root = bassRootMidi(rootPc);
  switch (symbol) {
    case 'R': return root;
    case '5': return root + chordInterval(chord, [7, 6, 8], 7);
    case '5-': return root + chordInterval(chord, [7, 6, 8], 7) - 12;
    case '8': return root + 12;
    case '3': return root + chordInterval(chord, [4, 3], 4);
    case '6': return root + (chordInterval(chord, [4, 3], 4) === 3 ? 10 : 9);
    case '7': return root + chordInterval(chord, [10, 11, 9], 10);
    case 'L': return root + (random() < 0.5 ? chordInterval(chord, [4, 3], 4) : chordInterval(chord, [7, 6, 8], 7));
    case 'A': {
      const target = bassRootMidi((next ?? event).chord.bass ?? (next ?? event).chord.root);
      if (!next || next === event) return root + 7;
      return target + (random() < 0.5 ? -1 : 1);
    }
    default: return root;
  }
}

// Sem progressão, o baixo usa a tônica da tonalidade como pedal.
function harmonicTimeline(session) {
  const timeline = chordTimeline(session);
  if (timeline.length > 0 || (session.progression?.enabled && session.progression.chords.length > 0)) return timeline;
  const key = findKey(session.progression.keyId);
  const minor = key.mode === 'minor';
  const chord = {
    symbol: key.tonic, root: key.pitchClass, bass: null, quality: minor ? 'm' : '',
    notes: [0, minor ? 3 : 4, 7].map(interval => ({ name: '', midi: 48 + key.pitchClass + interval })),
  };
  return [{ start: 0, duration: sessionTicks(session), chord, index: 0 }];
}

function genericBass(session, density) {
  const starts = groupStarts(session);
  const barTicks = ticksPerBar(session);
  const notes = starts.map((start, index) => [start, index === 0 ? 'R' : index % 2 ? '5' : 'R', (starts[index + 1] ?? barTicks) - start, index === 0 ? 0.85 : 0.7]);
  if (density === 'sparse') return [[0, 'R', starts[1] ?? barTicks, 0.85]];
  if (density === 'busy') {
    return range(0, barTicks, 2).map(tick => [tick, starts.includes(tick) ? (tick === 0 ? 'R' : '5') : 'R', 2, starts.includes(tick) ? 0.8 : 0.55]);
  }
  return notes;
}

function genericComp(session, density) {
  const starts = groupStarts(session);
  const barTicks = ticksPerBar(session);
  if (density === 'sparse') return [[0, barTicks, 0.45]];
  const step = beatTicks(session);
  const stabs = starts.map(start => [start, Math.min(step * 1.5, 3), start === 0 ? 0.5 : 0.42]);
  if (density === 'busy') stabs.push(...starts.map(start => [start + step / 2 + (step >= 4 ? step / 2 : 0), 1, 0.32]));
  return stabs.filter(([tick]) => tick < barTicks);
}

function barTemplate(templates, session, style, density, bar, kind) {
  if (kind === 'bass' && style === 'waltz' && isThreeFour(session)) return WALTZ_34.bass[density];
  if (kind === 'comp' && style === 'waltz' && isThreeFour(session)) return WALTZ_34.comp[density];
  if (isFourFour(session) && templates[style]) {
    const entry = templates[style];
    return (bar % 2 === 1 && entry[`${density}B`]) || entry[density];
  }
  if (session.meter.unit === 4 && session.meter.beats === 2 && templates[style]) {
    const half = (bar % 2) * 8;
    return barTemplate(templates, { ...session, meter: { beats: 4, unit: 4 } }, style, density, Math.floor(bar / 2), kind)
      .filter(([tick]) => tick >= half && tick < half + 8)
      .map(([tick, ...rest]) => [tick - half, ...rest]);
  }
  return kind === 'bass' ? genericBass(session, density) : genericComp(session, density);
}

// Notas do baixo: {start, duration, pitch, velocity, articulation}.
export function generateBass(session) {
  const timeline = harmonicTimeline(session);
  const { style, density } = session.band;
  const barTicks = ticksPerBar(session);
  const notes = [];
  for (let bar = 0; bar < session.bars; bar += 1) {
    const offset = bar * barTicks;
    const random = seededRandom(deriveSeed(session.drums.seed, 0xba55, bar));
    let pattern;
    if (style === 'complement') {
      const attacks = session.notes.filter(note => note.start >= offset && note.start < offset + barTicks).map(note => note.start - offset);
      const picks = [0, ...attacks.filter(tick => tick > 0).slice(0, density === 'sparse' ? 1 : density === 'busy' ? 5 : 3)];
      pattern = [...new Set(picks)].sort((a, b) => a - b)
        .map((tick, index, all) => [tick, index % 2 ? '5' : 'R', (all[index + 1] ?? barTicks) - tick, index === 0 ? 0.85 : 0.65]);
    } else {
      pattern = barTemplate(BASS_TEMPLATES, session, style, density, bar, 'bass');
    }
    for (const [tick, symbol, duration, velocity] of pattern) {
      const start = offset + tick;
      const event = chordAt(timeline, start);
      if (!event) continue;
      const next = timeline[timeline.indexOf(event) + 1] ?? timeline[0];
      const changeAt = event.start + event.duration;
      const end = Math.min(start + duration, changeAt, offset + barTicks * 2);
      const nextStart = next && next.start > event.start ? next.start : sessionTicks(session);
      const beforePause = nextStart > changeAt + 1e-6;
      // A aproximação só faz sentido imediatamente antes de uma troca de acorde.
      const approach = symbol === 'A' && changeAt - start <= 4 + 1e-6 ? next : event;
      notes.push({
        start, duration: beforePause ? Math.min(Math.max(0.25, end - start), changeAt - start) : Math.max(0.25, end - start),
        pitch: bassPitch(symbol, event, approach, random),
        velocity: Math.min(1, velocity * (0.95 + random() * 0.1)), articulation: duration <= 1 ? 'staccato' : 'normal',
      });
    }
  }
  return notes.filter(note => note.start < sessionTicks(session));
}

// Acordes do acompanhamento: {start, duration, pitches, velocity, articulation}.
export function generateComping(session) {
  const timeline = chordTimeline(session);
  if (timeline.length === 0) return [];
  const { style, density } = session.band;
  const barTicks = ticksPerBar(session);
  const events = [];
  for (let bar = 0; bar < session.bars; bar += 1) {
    const offset = bar * barTicks;
    const random = seededRandom(deriveSeed(session.drums.seed, 0xc0de, bar));
    const pattern = style === 'complement' ? [[0, barTicks, 0.45]] : barTemplate(COMP_TEMPLATES, session, style, density, bar, 'comp');
    const starts = new Set();
    for (const [tick, duration, velocity] of pattern) {
      const start = offset + tick;
      const event = chordAt(timeline, start);
      if (!event) continue;
      const end = Math.min(start + duration, event.start + event.duration);
      starts.add(start);
      events.push({
        start, duration: end - start, pitches: upper(event.chord), velocity: velocity * (0.95 + random() * 0.1),
        articulation: duration <= 1.5 ? 'staccato' : 'normal',
      });
    }
    // Sustentações longas não podem esconder uma troca de acorde dentro do compasso.
    const sustained = pattern.length <= 2 && pattern.some(([, duration]) => duration >= 6);
    for (const event of timeline) {
      if (event.start <= offset || event.start >= offset + barTicks || starts.has(event.start)) continue;
      if (!sustained && pattern.some(([tick]) => offset + tick > event.start && offset + tick < event.start + 2)) continue;
      events.push({
        start: event.start, duration: Math.min(event.duration, offset + barTicks - event.start), pitches: upper(event.chord),
        velocity: 0.45, articulation: 'normal',
      });
    }
  }
  return events.sort((a, b) => a.start - b.start);
}

function upper(chord) {
  return chord.notes.map(note => note.midi);
}
