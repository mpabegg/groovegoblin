// Prática guiada do GrooveGoblin: objetivos, rotina configurável, exercícios
// parciais, adaptação de tempo com critérios claros, revisão espaçada, jogos
// de ouvido e histórico local persistido. Toda a UI é construída com
// createElement/textContent (nunca HTML não confiável). O módulo não importa o
// motor de áudio: todo som passa pelo host (play/stop/preview).

import { evaluateSession, summarizeFeedback } from './feedback.js';
import { generateGroove } from './generator.js';

// ---------------------------------------------------------------------------
// Utilidades compartilhadas (usadas também por playground.js e practice-view.js)
// ---------------------------------------------------------------------------

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function numOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Mulberry32 determinística (mesma do gerador de frases).
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalizeSeed(value, fallback = 1) {
  if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) return value;
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff) return parsed;
  return fallback;
}

export function createEl(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') {
      for (const [name, data] of Object.entries(value)) node.dataset[name] = String(data);
    } else if (key === 'checked' || key === 'disabled' || key === 'readOnly' || key === 'selected') {
      node[key] = true;
    } else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const fallbackMemory = new Map();
export function safeStorage() {
  try {
    const candidate = globalThis.localStorage;
    if (candidate && typeof candidate.getItem === 'function') return candidate;
  } catch {
    // acesso bloqueado: usar armazenamento em memória
  }
  const memory = fallbackMemory;
  return {
    volatile: true,
    getItem: key => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: key => memory.delete(key),
  };
}

// Sessão normalizada para uso interno da prática. Não substitui o contrato de
// sessão do motor: apenas aceita qualquer sessão razoável e deriva campos.
export function normalizeSession(session) {
  const s = session && typeof session === 'object' ? session : {};
  const beats = Number.isInteger(s?.meter?.beats) && s.meter.beats > 0 && s.meter.beats <= 32 ? s.meter.beats : 4;
  const unit = Number.isInteger(s?.meter?.unit) && [2, 4, 8, 16].includes(s.meter.unit) ? s.meter.unit : 4;
  const ticksPerBar = (beats * 16) / unit;
  const bpm = clamp(Math.round(numOr(s.bpm, 100)), 30, 300);
  const bars = clamp(Math.round(numOr(s.bars, 4)), 1, 16);
  const notes = Array.isArray(s.notes)
    ? s.notes
        .filter(note => note && typeof note === 'object' && Number.isFinite(note.start) && Number.isFinite(note.duration))
        .map((note, index) => ({
          id: typeof note.id === 'string' && note.id ? note.id : `note-${index}`,
          start: note.start,
          duration: Math.max(0.05, note.duration),
          pitch: Number.isFinite(note.pitch) ? Math.round(clamp(note.pitch, 0, 127)) : 69,
          velocity: clamp(numOr(note.velocity, 0.8), 0, 1),
          articulation: note.articulation ?? 'normal',
          offsetMs: numOr(note.offsetMs, 0),
        }))
        .sort((a, b) => a.start - b.start)
    : [];
  const chordTones = Array.isArray(s?.progression?.chords)
    ? s.progression.chords.flatMap(chord => (Array.isArray(chord?.notes) ? chord.notes.map(n => (Number.isFinite(n) ? n : Number.isFinite(n?.midi) ? n.midi : null)).filter(m => m !== null) : []))
    : [];
  return {
    notes,
    bpm,
    bars,
    meter: { beats, unit },
    ticksPerBar,
    ticksPerBeat: ticksPerBar / beats,
    chordTones,
    swing: clamp(numOr(s?.swing, 0), 0, 0.75),
    repetitions: Number.isInteger(s?.training?.repetitions) && s.training.repetitions > 0 ? Math.min(64, s.training.repetitions) : 4,
    tempoStep: Number.isInteger(s?.training?.tempoStep) && s.training.tempoStep > 0 ? Math.min(20, s.training.tempoStep) : 4,
  };
}

export function tickSeconds(bpm) {
  return (60 / clamp(bpm, 30, 300)) / 4;
}

// Único ponto de contato com o preview do motor (contrato Engine:
// host.preview(notes, {bpm, timbre, channel}) -> Promise que resolve ao fim;
// notes {start, duration (ticks, 4 = semínima), pitch, velocity?} podem se
// sobrepor (acordes/intervalos harmônicos). Controle de volume do playground
// escala a velocity das notas, sem inventar opção inexistente no motor.
export async function previewPhrase(host, notes, options = {}) {
  if (!host || typeof host.preview !== 'function') {
    throw new Error('Este host não oferece prévia de áudio.');
  }
  const volume = clamp(numOr(options.volume, 0.8), 0.05, 1);
  const normalized = notes
    .map(note => ({
      start: numOr(note.start, 0),
      duration: Math.max(0.05, numOr(note.duration, 1)),
      pitch: Math.round(clamp(numOr(note.pitch, 69), 0, 127)),
      velocity: Math.round(clamp(numOr(note.velocity, 0.8) * volume, 0, 1) * 100) / 100,
      articulation: note.articulation ?? 'normal',
    }))
    .sort((a, b) => a.start - b.start);
  return host.preview(normalized, {
    bpm: clamp(Math.round(numOr(options.bpm, 100)), 30, 300),
    timbre: options.timbre,
    channel: options.channel,
  });
}

export function formatDatePt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatDaysFromNow(dueMs, now = Date.now()) {
  const days = (dueMs - now) / 86400000;
  if (days <= 0) return 'hoje';
  if (days < 1) return 'em menos de 1 dia';
  return `em ${Math.round(days)} dia(s)`;
}

const disclosureStates = new WeakMap();

// Preserve disclosure state and semantic focus, even when the current action changes.
export function renderKeepingFocus(root, renderContent) {
  const selector = 'button, input, select, textarea, summary, a[href], [tabindex]';
  const focused = document.activeElement;
  const hadFocus = root.contains(focused);
  const region = hadFocus ? focused.closest('section[aria-labelledby], section[aria-label], [role="region"][aria-label], .practice-ear-game, .playground-passage') : null;
  const regionLabel = region?.getAttribute('aria-labelledby') ?? region?.getAttribute('aria-label');
  const key = node => node.id || node.dataset.focusKey
    || (node.dataset.tick !== undefined ? `tick:${node.dataset.grid}:${node.dataset.tick}` : null)
    || `${node.tagName}:${node.getAttribute('type') ?? ''}:${node.getAttribute('aria-label') ?? ''}:${node.textContent}`;
  const focusKey = hadFocus ? key(focused) : null;
  const matches = hadFocus ? Array.from(root.querySelectorAll(selector)).filter(node => key(node) === focusKey) : [];
  const occurrence = matches.indexOf(focused);
  const disclosures = disclosureStates.get(root) ?? new Map();
  disclosureStates.set(root, disclosures);
  for (const node of root.querySelectorAll('details[data-disclosure]')) disclosures.set(node.dataset.disclosure, node.open);
  renderContent();
  for (const node of root.querySelectorAll('details[data-disclosure]')) {
    if (disclosures.has(node.dataset.disclosure)) node.open = disclosures.get(node.dataset.disclosure);
  }
  if (!hadFocus) return;
  const visible = node => !node.disabled && !node.closest('[hidden]')
    && !Array.from(root.querySelectorAll('details:not([open])')).some(details => details.contains(node) && node !== details.querySelector('summary'));
  const controls = Array.from(root.querySelectorAll(selector)).filter(visible);
  const replacement = controls.filter(node => key(node) === focusKey)[occurrence];
  const nextRegion = regionLabel ? Array.from(root.querySelectorAll('[aria-labelledby], [aria-label]'))
    .find(node => (node.getAttribute('aria-labelledby') ?? node.getAttribute('aria-label')) === regionLabel) : null;
  const fallback = nextRegion ? controls.find(node => nextRegion.contains(node) && node.classList.contains('practice-primary'))
    ?? controls.find(node => nextRegion.contains(node)) : null;
  (replacement ?? fallback ?? controls.find(node => node.classList.contains('practice-primary')) ?? controls[0])?.focus({ preventScroll: true });
}

// Grade de ticks acessível: cada célula é um <button> quando interativa.
export function renderTickGrid(notes, bars, ticksPerBar, options = {}) {
  const ticksPerBeat = numOr(options.ticksPerBeat, 4);
  const marked = options.marked instanceof Set ? options.marked : new Set(options.marked ?? []);
  const hidden = options.hidden instanceof Set ? options.hidden : new Set(options.hidden ?? []);
  const onToggle = typeof options.onToggle === 'function' ? options.onToggle : null;
  const grid = createEl('div', { className: `practice-grid${options.className ? ' ' + options.className : ''}`, role: 'group', 'aria-label': options.ariaLabel ?? 'Grade de ticks' });
  const covered = tick => notes.some(note => tick >= note.start && tick < note.start + note.duration);
  const onset = tick => notes.some(note => Math.abs(note.start - tick) < 0.001);
  for (let bar = 0; bar < bars; bar += 1) {
    const row = createEl('div', { className: 'practice-grid-row', role: 'group', 'aria-label': `Compasso ${bar + 1}` });
    for (let t = 0; t < ticksPerBar; t += 1) {
      const tick = bar * ticksPerBar + t;
      const beat = Math.floor(t / ticksPerBeat) + 1;
      const isBeat = t % ticksPerBeat === 0;
      const classes = ['practice-tick'];
      if (isBeat) classes.push('practice-tick-beat');
      if (covered(tick)) classes.push('practice-tick-on');
      if (onset(tick)) classes.push('practice-tick-onset');
      if (marked.has(tick)) classes.push('practice-tick-marked');
      if (hidden.has(tick)) classes.push('practice-tick-hidden');
      const label = `Compasso ${bar + 1}, ${isBeat ? `pulso ${beat}` : `subdivisão ${t % ticksPerBeat + 1} do pulso ${beat}`}${onset(tick) ? ', ataque' : covered(tick) ? ', nota sustentada' : ', silêncio'}${marked.has(tick) ? ', marcado' : ''}`;
      const cell = onToggle
        ? createEl('button', { type: 'button', className: classes.join(' '), dataset: { tick, grid: options.ariaLabel ?? 'Grade de ticks' }, 'aria-label': label, 'aria-pressed': marked.has(tick) ? 'true' : 'false', title: label })
        : createEl('div', { className: classes.join(' '), 'aria-label': label, title: label });
      if (onToggle) {
        cell.addEventListener('click', () => onToggle(tick, cell));
      }
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Objetivos, etapas e exercícios
// ---------------------------------------------------------------------------

export const OBJECTIVES = Object.freeze([
  { id: 'timing', name: 'Tempo exato', focus: 'Ataques dentro da janela de tolerância: pressione junto ao clique e solte no término de cada nota.' },
  { id: 'durations', name: 'Durações', focus: 'Sustente cada nota até o término indicado; alterne notas curtas e longas sem fundir vizinhas.' },
  { id: 'syncopation', name: 'Síncope', focus: 'Os ataques caem fora dos tempos fortes; mantenha o pulso interno enquanto toca os contratempos.' },
  { id: 'rests', name: 'Pausas', focus: 'Toque apenas nos ataques e deixe o silêncio respirar nas pausas, sem antecipar a nota seguinte.' },
  { id: 'accents', name: 'Ataques acentuados', focus: 'Ouça o contraste de intensidades gerado e toque no tempo das notas fortes. O teclado avalia o momento dos ataques, não a força física do toque.' },
  { id: 'inner-pulse', name: 'Pulso interno', focus: 'Mantenha o pulso quando o clique silenciar nos compassos silenciosos e retome no tempo.' },
]);

export const STAGES = Object.freeze([
  { id: 'listen', name: 'Escutar', description: 'Ouça a referência e conte as subdivisões em voz alta.' },
  { id: 'imitate', name: 'Imitar', description: 'Reproduza a referência ouvida sobre o clique; a avaliação compara ataques e términos.' },
  { id: 'read', name: 'Ler', description: 'Leia a frase na grade com os pulsos numerados antes de tocar de novo.' },
  { id: 'memorize', name: 'Memorizar', description: 'Ouça, memorize e toque com o clique silencioso em parte dos compassos.' },
  { id: 'improvise', name: 'Improvisar', description: 'Improvise sobre o acompanhamento: escolha criativa, sem nota certa ou errada.' },
]);

const OBJECTIVE_PROFILES = {
  timing: { density: 'medium', syncopation: 'straight', lengths: 'short', metronome: { silentBars: 0, audibleBars: 1 } },
  durations: { density: 'sparse', syncopation: 'straight', lengths: 'mixed', metronome: { silentBars: 0, audibleBars: 1 } },
  syncopation: { density: 'medium', syncopation: 'syncopated', lengths: 'short', metronome: { silentBars: 0, audibleBars: 1 } },
  rests: { density: 'sparse', syncopation: 'mixed', lengths: 'long', metronome: { silentBars: 0, audibleBars: 1 } },
  accents: { density: 'medium', syncopation: 'mixed', lengths: 'short', metronome: { silentBars: 0, audibleBars: 1 } },
  'inner-pulse': { density: 'sparse', syncopation: 'straight', lengths: 'short', metronome: { silentBars: 2, audibleBars: 1 } },
};

const DENSITY_CYCLE = ['sparse', 'medium', 'busy'];
const LENGTH_CYCLE = ['short', 'mixed', 'long'];
const SYNC_CYCLE = ['straight', 'mixed', 'syncopated'];

function cycleNext(list, current) {
  const index = list.indexOf(current);
  return list[(index + 1) % list.length];
}
function cyclePrev(list, current) {
  const index = list.indexOf(current);
  return list[(index - 1 + list.length) % list.length];
}

function applyAccents(notes, objective, ticksPerBeat) {
  if (objective === 'inner-pulse') {
    return notes.map(note => ({ ...note, velocity: Math.round(clamp(numOr(note.velocity, 0.8), 0.05, 1) * 100) / 100 }));
  }
  if (objective === 'accents') {
    return notes.map((note, index) => {
      const strong = index === 0 || Math.abs(note.start % (ticksPerBeat * 2)) < 0.001;
      return { ...note, velocity: strong ? 1 : 0.5 };
    });
  }
  return notes.map(note => ({
    ...note,
    velocity: Math.abs(note.start % ticksPerBeat) < 0.001 ? 0.9 : 0.75,
  }));
}

function levelFromSkill(skill) {
  const reps = numOr(skill?.repetitions, 0);
  if (reps >= 4) return 2;
  if (reps >= 1) return 1;
  return 0;
}

export function generateExercise(options = {}) {
  const objective = OBJECTIVES.some(o => o.id === options.objective) ? options.objective : 'timing';
  const seed = normalizeSeed(options.seed, 1);
  const normalized = normalizeSession(options.session);
  const source = options.source === 'session' ? 'session' : 'generated';
  const bars = source === 'session' ? normalized.bars : [1, 2, 4].includes(options.bars) ? options.bars : 1;
  const meter = source === 'session' ? normalized.meter : { beats: 4, unit: 4 };
  const level = clamp(Math.round(numOr(options.level, 0)), 0, 2);
  const profile = OBJECTIVE_PROFILES[objective];
  const session = options.session && typeof options.session === 'object' ? options.session : null;

  let notes;
  let bpm = clamp(Math.round(numOr(options.bpm, 90)), 30, 300);
  let density = DENSITY_CYCLE.includes(options.density) ? options.density : profile.density;
  const syncopation = SYNC_CYCLE.includes(options.syncopation) ? options.syncopation : profile.syncopation;
  const lengths = LENGTH_CYCLE.includes(options.lengths) ? options.lengths : profile.lengths;
  if (!options.density && level > 0 && ['timing', 'syncopation', 'accents'].includes(objective)) {
    density = level === 2 ? 'busy' : 'medium';
  }

  if (source === 'session' && session) {
    // Preserve the studio meter and phrase when choosing the current session.
    notes = normalized.notes.map(note => ({ ...note }));
    bpm = normalized.bpm;
  } else {
    const groove = generateGroove({ bars, seed, density, syncopation, lengths });
    const contour = [0, 2, 3, 5, 7, 10, 12];
    const random = mulberry32(seed ^ 0x9e3779b9);
    let pitch = 69;
    notes = groove.notes.map((note, index) => {
      if (index > 0) {
        const step = contour[Math.floor(random() * contour.length)];
        pitch = clamp(pitch + step - 3, 57, 81);
      }
      return { id: `ex-${seed}-${index}`, start: note.start, duration: note.duration, pitch, velocity: 0.8 };
    });
  }

  const ticksPerBeat = 16 / meter.unit;
  notes = applyAccents(notes, objective, ticksPerBeat).sort((a, b) => a.start - b.start);
  const meta = OBJECTIVES.find(o => o.id === objective);
  return {
    objective,
    objectiveName: meta.name,
    focus: meta.focus,
    source,
    seed,
    bars,
    bpm,
    meter,
    ticksPerBar: meter.beats * 16 / meter.unit,
    ticksPerBeat,
    level,
    density,
    syncopation,
    lengths,
    metronome: { enabled: true, pattern: 'quarters', silentBars: profile.metronome.silentBars, audibleBars: profile.metronome.audibleBars },
    notes,
  };
}

// Exercício parcial: varia exatamente UMA dimensão a partir do exercício atual.
export const VARIANT_DIMENSIONS = Object.freeze([
  { id: 'attacks', name: 'Quantidade de ataques' },
  { id: 'durations', name: 'Durações das notas' },
  { id: 'syncopation', name: 'Síncope' },
  { id: 'rests', name: 'Pausas' },
  { id: 'accents', name: 'Acentos' },
  { id: 'tempo', name: 'Tempo' },
  { id: 'pitch', name: 'Alturas (contorno)' },
]);

export function partialVariant(exercise, dimension, options = {}) {
  if (!exercise || typeof exercise !== 'object') throw new TypeError('Informe o exercício de base.');
  if (!VARIANT_DIMENSIONS.some(d => d.id === dimension)) throw new TypeError('Dimensão desconhecida para a variação parcial.');
  const variant = {
    ...exercise,
    notes: exercise.notes.map(note => ({ ...note })),
    parentSeed: exercise.seed,
    changed: dimension,
  };
  if (exercise.source === 'session') {
    // Com a frase da sessão não há gerador: variações musicais diretas.
    switch (dimension) {
      case 'attacks':
        variant.notes = exercise.notes.filter((_, index) => index % 2 === 0);
        if (variant.notes.length === 0) variant.notes = exercise.notes.map(note => ({ ...note }));
        break;
      case 'durations':
        variant.notes = exercise.notes.map(note => ({ ...note, duration: Math.max(0.05, note.duration / 2) }));
        break;
      case 'syncopation':
        variant.notes = exercise.notes.map((note, index) => ({
          ...note,
          start: Math.min((exercise.notes[index + 1]?.start ?? exercise.bars * exercise.ticksPerBar) - note.duration, note.start + (Math.abs(note.start % exercise.ticksPerBeat) < 0.001 && note.start >= exercise.ticksPerBeat ? exercise.ticksPerBeat / 2 : 0)),
        }));
        break;
      case 'rests':
        variant.notes = exercise.notes.map(note => ({ ...note, duration: Math.max(0.05, note.duration / 2) }));
        break;
      case 'accents':
        variant.notes = exercise.notes.map(note => ({ ...note, velocity: note.velocity >= 0.9 ? 0.6 : 1 }));
        break;
      case 'tempo':
        variant.bpm = clamp(exercise.bpm + (options.direction === 'down' ? -8 : 8), 30, 300);
        break;
      case 'pitch':
        variant.notes = exercise.notes.map(note => ({ ...note, pitch: clamp(note.pitch - 5, 21, 108) }));
        break;
      default:
        break;
    }
    return variant;
  }

  switch (dimension) {
    case 'attacks':
      variant.density = cycleNext(DENSITY_CYCLE, exercise.density);
      break;
    case 'durations':
      variant.lengths = cycleNext(LENGTH_CYCLE, exercise.lengths);
      break;
    case 'syncopation':
      variant.syncopation = cycleNext(SYNC_CYCLE, exercise.syncopation);
      break;
    case 'rests':
      variant.density = cyclePrev(DENSITY_CYCLE, exercise.density);
      break;
    case 'accents':
      variant.notes = exercise.notes.map(note => ({
        ...note,
        velocity: Math.abs((note.start + 2) % 8) < 0.001 ? 1 : Math.abs((note.start + 2) % 4) < 0.001 ? 0.8 : 0.5,
      }));
      return variant;
    case 'tempo':
      variant.bpm = clamp(exercise.bpm + (options.direction === 'down' ? -8 : 8), 30, 300);
      return variant;
    case 'pitch': {
      const random = mulberry32(exercise.seed ^ 0x5f356495);
      variant.notes = exercise.notes.map(note => ({ ...note, pitch: clamp(note.pitch + (random() < 0.5 ? -2 : 2), 57, 81) }));
      return variant;
    }
    default:
      break;
  }
  const base = generateExercise({
    objective: exercise.objective,
    seed: exercise.seed,
    bars: exercise.bars,
    bpm: exercise.bpm,
    level: exercise.level,
    density: variant.density,
    syncopation: variant.syncopation,
    lengths: variant.lengths,
    source: 'generated',
  });
  return {
    ...variant,
    notes: base.notes.map((note, index) => ({ ...note, pitch: exercise.notes[index]?.pitch ?? note.pitch })),
    metronome: { ...base.metronome },
  };
}

// ---------------------------------------------------------------------------
// Avaliação de uma execução e adaptação de tempo
// ---------------------------------------------------------------------------

// Contrato definitivo (Main + Engine): onFinish recebe detail.results com a
// avaliação da execução congelada (ou detail.session para avaliar aqui com
// evaluateSession). Nenhum fallback para a evaluate legada do modelo.
export function evaluationFromDetail(detail, attempts, fallbackSession) {
  const results = detail && typeof detail === 'object' ? detail.results : null;
  if (results && typeof results === 'object' && Array.isArray(results.rows)) {
    return { rows: results.rows, summary: summarizeFeedback(results), source: 'detalhe' };
  }
  const session = detail?.session ?? fallbackSession;
  const result = evaluateSession(session, attempts);
  return { rows: result.rows, summary: summarizeFeedback(result), source: 'engine' };
}

export function objectiveMetric(objective, { rows, summary, notes, ticksPerBeat = 4 }) {
  const expected = Math.max(1, numOr(summary?.expected, 0));
  const matched = Math.max(0, numOr(summary?.matched, 0));
  const offbeat = new Set(notes.filter(note => Math.abs(note.start % ticksPerBeat) > 0.001).map(note => note.id));
  const accented = new Set(notes.filter(note => (numOr(note.velocity, 0.8)) >= 0.8).map(note => note.id));
  switch (objective) {
    case 'timing':
      return clamp(numOr(summary?.attackOk, 0) / expected, 0, 1);
    case 'durations':
      return clamp(numOr(summary?.endOk, 0) / expected, 0, 1);
    case 'syncopation': {
      let offExpected = 0;
      let offOk = 0;
      for (const row of rows) {
        const id = row.noteId;
        if (id !== undefined && offbeat.has(id)) {
          offExpected += 1;
          if (row.kind === 'matched' && row.onset === 'ok') offOk += 1;
        }
      }
      return offExpected === 0 ? clamp(numOr(summary?.attackOk, 0) / expected, 0, 1) : clamp(offOk / offExpected, 0, 1);
    }
    case 'rests':
      return clamp(matched / expected - numOr(summary?.extra, 0) / expected, 0, 1);
    case 'accents': {
      let accExpected = 0;
      let accOk = 0;
      for (const row of rows) {
        if (row.noteId !== undefined && accented.has(row.noteId)) {
          accExpected += 1;
          if (row.kind === 'matched' && row.onset === 'ok') accOk += 1;
        }
      }
      return accExpected === 0 ? clamp(numOr(summary?.attackOk, 0) / expected, 0, 1) : clamp(accOk / accExpected, 0, 1);
    }
    case 'inner-pulse': {
      const perRep = new Map();
      for (const row of rows) {
        if (row.kind === 'missed' || row.kind === 'matched') {
          const rep = row.repetition ?? 1;
          const entry = perRep.get(rep) ?? { expected: 0, ok: 0 };
          entry.expected += 1;
          if (row.kind === 'matched' && row.onset === 'ok') entry.ok += 1;
          perRep.set(rep, entry);
      }
      }
      if (perRep.size === 0) return 0;
      const ratios = [...perRep.values()].map(entry => entry.ok / Math.max(1, entry.expected));
      const mean = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
      const spread = Math.max(...ratios) - Math.min(...ratios);
      return clamp(mean - spread / 2, 0, 1);
    }
    default:
      return clamp(matched / expected, 0, 1);
  }
}

export function tempoCriteriaText(tempoStep = 4) {
  return `Critério de tempo: ≥90% de cobertura e ≥90% de ataques no tempo com ≤10% de sobras sobe ${tempoStep} bpm; menos de 70% de cobertura ou 60% de ataques no tempo desce ${tempoStep} bpm; entre os dois, mantém (zona de prática).`;
}

export function adaptTempo(bpm, summary, options = {}) {
  const tempoStep = clamp(Math.round(numOr(options.tempoStep, 4)), 1, 40);
  const expected = Math.max(1, numOr(summary?.expected, 0));
  const coverage = clamp(numOr(summary?.matched, 0) / expected, 0, 1);
  const attackRatio = clamp(numOr(summary?.attackOk, 0) / expected, 0, 1);
  const extraRate = clamp(numOr(summary?.extra, 0) / expected, 0, 1);
  const base = clamp(Math.round(numOr(bpm, 100)), 30, 300);
  if (numOr(summary?.expected, 0) <= 0) return { bpmDelta: 0, nextBpm: base, zone: 'prática', reason: 'Sem notas esperadas; tempo mantido.', coverage, attackRatio, extraRate };

  let bpmDelta = 0;
  let zone = 'prática';
  let reason = 'Cobertura e ataques na zona de prática: tempo mantido.';
  if (coverage >= 0.9 && attackRatio >= 0.9 && extraRate <= 0.1) {
    bpmDelta = tempoStep;
    zone = 'desafio';
    reason = `Cobertura ${Math.round(coverage * 100)}% e ataques no tempo ${Math.round(attackRatio * 100)}% com poucas sobras: sobe ${tempoStep} bpm.`;
  } else if (coverage < 0.7 || attackRatio < 0.6) {
    bpmDelta = -tempoStep;
    zone = 'conforto';
    reason = `Cobertura ${Math.round(coverage * 100)}% e ataques no tempo ${Math.round(attackRatio * 100)}%: desce ${tempoStep} bpm para garantir precisão.`;
  }
  const nextBpm = clamp(base + bpmDelta, 30, 300);
  if (nextBpm - base !== bpmDelta) {
    bpmDelta = nextBpm - base;
    reason = `Limite de andamento: ajuste real de ${bpmDelta > 0 ? '+' : ''}${bpmDelta} bpm.`;
  }
  return { bpmDelta, nextBpm, zone, reason, coverage, attackRatio, extraRate };
}

// ---------------------------------------------------------------------------
// Revisão espaçada (estilo SM-2 simplificado, sem punição)
// ---------------------------------------------------------------------------

export function createSkill(now = Date.now()) {
  return { ease: 2.5, intervalDays: 0, repetitions: 0, lapses: 0, dueAt: now, lastAt: null };
}

export function performanceQuality(metric) {
  if (metric >= 0.9) return 5;
  if (metric >= 0.75) return 4;
  if (metric >= 0.5) return 3;
  if (metric >= 0.25) return 2;
  return 1;
}

export function nextReview(skill, quality, now = Date.now()) {
  const current = { ...createSkill(now), ...skill };
  let { ease, intervalDays, repetitions, lapses } = current;
  if (quality < 3) {
    repetitions = 0;
    lapses += 1;
    intervalDays = 1;
  } else {
    repetitions += 1;
    if (repetitions === 1) intervalDays = 1;
    else if (repetitions === 2) intervalDays = 3;
    else intervalDays = Math.max(1, Math.round(intervalDays * ease));
    ease = clamp(ease + 0.1 - (5 - quality) * 0.08, 1.3, 2.8);
  }
  return {
    ease: Math.round(ease * 100) / 100,
    intervalDays,
    repetitions,
    lapses,
    dueAt: now + intervalDays * 86400000,
    lastAt: now,
  };
}

export function reviewQueue(skills, now = Date.now()) {
  return OBJECTIVES
    .map(objective => ({ objective, skill: skills[objective.id] ?? null }))
    .map(entry => ({ ...entry, due: entry.skill ? entry.skill.dueAt <= now : true }))
    .sort((a, b) => {
      if (a.due !== b.due) return a.due ? -1 : 1;
      return String(a.objective.name).localeCompare(String(b.objective.name), 'pt-BR');
    });
}

// ---------------------------------------------------------------------------
// Estado persistido (chave própria e versionada)
// ---------------------------------------------------------------------------

export const PRACTICE_STORAGE_KEY = 'groovegoblin.practice.v1';
export const HISTORY_LIMIT = 200;

export function createPracticeState() {
  return {
    version: 1,
    objective: 'timing',
    routine: {
      stages: STAGES.map(stage => stage.id),
      listenRepetitions: 2,
      memorizeSilentBars: 2,
      adaptiveTempo: true,
    },
    skills: {},
    history: [],
  };
}

export function validateRunEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, error: 'entrada não é um objeto' };
  if (typeof entry.id !== 'string' || !entry.id || entry.id.length > 80) return { ok: false, error: 'id ausente ou inválido' };
  const at = typeof entry.at === 'string' ? Date.parse(entry.at) : Number.isFinite(entry.at) ? entry.at : NaN;
  if (!Number.isFinite(at) || Math.abs(at) > 8640000000000000) return { ok: false, error: 'data ausente ou inválida' };
  if (!['attempt', 'creative', 'ear'].includes(entry.kind)) return { ok: false, error: 'tipo de registro inválido' };
  if (entry.kind === 'attempt' && !OBJECTIVES.some(o => o.id === entry.objective)) {
    return { ok: false, error: 'objetivo inválido para uma tentativa' };
  }
  if (typeof entry.objective !== 'string' || !entry.objective || entry.objective.length > 60) {
    return { ok: false, error: 'objetivo ausente' };
  }
  const bpm = numOr(entry.bpm, NaN);
  if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300) return { ok: false, error: 'bpm fora do intervalo 30–300' };
  const notes = Array.isArray(entry.notes) ? entry.notes
    .filter(n => n && Number.isFinite(n.start) && n.start >= 0 && Number.isFinite(n.duration) && n.duration > 0)
    .map((n, index) => ({ id: typeof n.id === 'string' ? n.id.slice(0, 80) : `history-${index}`, start: n.start, duration: n.duration, pitch: clamp(Math.round(numOr(n.pitch, 69)), 21, 108), velocity: clamp(numOr(n.velocity, 0.8), 0, 1) })) : [];
  const metrics = {};
  for (const key of ['expected', 'matched', 'missed', 'extra', 'attackOk', 'endOk', 'objectiveScore']) {
    metrics[key] = Math.max(0, Math.round(numOr(entry?.metrics?.[key], 0)));
  }
  if (entry.kind === 'ear') metrics.correct = entry?.metrics?.correct === 1 || entry?.metrics?.correct === true ? 1 : 0;
  return {
    ok: true,
    value: {
      id: entry.id,
      at: new Date(at).toISOString(),
      kind: entry.kind,
      objective: entry.objective,
      stage: typeof entry.stage === 'string' && entry.stage.length <= 40 ? entry.stage : '—',
      bpm: Math.round(bpm),
      bars: Number.isInteger(entry.bars) && entry.bars > 0 && entry.bars <= 16 ? entry.bars : 1,
      durationSec: Math.max(0, Math.round(numOr(entry.durationSec, 0))),
      notes,
      metrics,
      tempoDelta: Math.round(clamp(numOr(entry.tempoDelta, 0), -40, 40)),
    },
  };
}

export function validatePracticeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'estado não é um objeto' };
  if (value.version !== 1) return { ok: false, error: `versão não suportada: ${String(value.version)}` };
  if (value.history !== undefined && !Array.isArray(value.history)) return { ok: false, error: 'histórico não é uma lista' };
  if (value.routine !== undefined && (!value.routine || typeof value.routine !== 'object' || Array.isArray(value.routine))) return { ok: false, error: 'rotina inválida' };
  if (value.skills !== undefined && (!value.skills || typeof value.skills !== 'object' || Array.isArray(value.skills))) return { ok: false, error: 'revisões inválidas' };
  if (value.objective !== undefined && !OBJECTIVES.some(o => o.id === value.objective)) {
    return { ok: false, error: 'objetivo selecionado inválido' };
  }
  const stages = Array.isArray(value?.routine?.stages)
    ? value.routine.stages.filter(id => STAGES.some(stage => stage.id === id))
    : STAGES.map(stage => stage.id);
  const skills = {};
  if (value.skills && typeof value.skills === 'object' && !Array.isArray(value.skills)) {
    for (const objective of OBJECTIVES) {
      const skill = value.skills[objective.id];
      if (skill && typeof skill === 'object' && !Array.isArray(skill)) {
        skills[objective.id] = {
          ease: clamp(numOr(skill.ease, 2.5), 1.3, 2.8),
          intervalDays: Math.max(0, Math.round(numOr(skill.intervalDays, 0))),
          repetitions: Math.max(0, Math.round(numOr(skill.repetitions, 0))),
          lapses: Math.max(0, Math.round(numOr(skill.lapses, 0))),
          dueAt: Number.isFinite(skill.dueAt) ? skill.dueAt : Date.now(),
          lastAt: Number.isFinite(skill.lastAt) ? skill.lastAt : null,
        };
      }
    }
  }
  const warnings = [];
  const history = [];
  if (Array.isArray(value.history)) {
    for (const entry of value.history) {
      const validated = validateRunEntry(entry);
      if (validated.ok) history.push(validated.value);
      else warnings.push(`Registro ignorado: ${validated.error}.`);
    }
  }
  return {
    ok: true,
    state: {
      version: 1,
      objective: OBJECTIVES.some(o => o.id === value.objective) ? value.objective : 'timing',
      routine: {
        stages: [...new Set(stages)],
        listenRepetitions: clamp(Math.round(numOr(value?.routine?.listenRepetitions, 2)), 1, 8),
        memorizeSilentBars: clamp(Math.round(numOr(value?.routine?.memorizeSilentBars, 2)), 0, 8),
        adaptiveTempo: value?.routine?.adaptiveTempo !== false,
      },
      skills,
      history: history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-HISTORY_LIMIT),
    },
    warnings,
  };
}

export function loadPracticeState(storage = safeStorage()) {
  const warnings = [];
  if (storage.volatile) warnings.push('Armazenamento persistente indisponível: o histórico dura apenas nesta página. Exporte antes de fechar.');
  let recoveryRaw = null;
  let raw = null;
  try {
    raw = storage.getItem(PRACTICE_STORAGE_KEY);
    recoveryRaw = storage.getItem(`${PRACTICE_STORAGE_KEY}.recovery`);
    if (recoveryRaw !== null) warnings.push('Uma cópia dos dados antigos foi preservada para recuperação no Percurso.');
  } catch (error) {
    warnings.push(`Não foi possível ler o armazenamento local (${error.message}).`);
    return { state: createPracticeState(), warnings, recoveryRaw: null };
  }
  if (raw === null || raw === undefined) return { state: createPracticeState(), warnings, recoveryRaw: null };
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnings.push(`Dados de prática corrompidos (${error.message}); começando do zero sem apagar os dados antigos.`);
    recoveryRaw = raw;
    return { state: createPracticeState(), warnings, recoveryRaw };
  }
  const validated = validatePracticeState(parsed);
  if (!validated.ok) {
    warnings.push(`Dados de prática inválidos (${validated.error}); começando do zero sem apagar os dados antigos.`);
    recoveryRaw = raw;
    return { state: createPracticeState(), warnings, recoveryRaw };
  }
  return { state: validated.state, warnings: [...warnings, ...validated.warnings], recoveryRaw };
}

export function savePracticeState(state, storage = safeStorage()) {
  try {
    const existing = storage.getItem(PRACTICE_STORAGE_KEY);
    if (existing !== null) {
      let valid = false;
      try { const checked = validatePracticeState(JSON.parse(existing)); valid = checked.ok && checked.warnings.length === 0; } catch { /* preserve corrupt bytes */ }
      const backup = storage.getItem(`${PRACTICE_STORAGE_KEY}.recovery`);
      if (!valid && backup !== null && backup !== existing) return false;
      if (!valid && storage.getItem(`${PRACTICE_STORAGE_KEY}.recovery`) === null) {
        storage.setItem(`${PRACTICE_STORAGE_KEY}.recovery`, existing);
      }
    }
    storage.setItem(PRACTICE_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

const executionIds = new WeakMap();
let executionSequence = 0;
export function runId(attempts, bpm = 0) {
  if (Array.isArray(attempts) && executionIds.has(attempts)) return executionIds.get(attempts);
  const id = `run-${Date.now().toString(36)}-${(++executionSequence).toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}-${Math.round(numOr(bpm, 0))}`;
  if (Array.isArray(attempts)) executionIds.set(attempts, id);
  return id;
}

export function recordRun(state, run, now = Date.now()) {
  const validated = validateRunEntry(run);
  if (!validated.ok) return { recorded: false, error: validated.error };
  const entry = validated.value;
  if (state.history.some(existing => existing.id === entry.id)) return { recorded: false, reason: 'duplicado' };
  state.history.push(entry);
  if (state.history.length > HISTORY_LIMIT) state.history.splice(0, state.history.length - HISTORY_LIMIT);
  state.history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (entry.kind === 'attempt' && OBJECTIVES.some(o => o.id === entry.objective)) {
    const quality = performanceQuality(entry.metrics.objectiveScore / 100);
    state.skills[entry.objective] = nextReview(state.skills[entry.objective], quality, now);
  }
  return { recorded: true, entry };
}


export function deleteRun(state, id) {
  const index = state.history.findIndex(entry => entry.id === id);
  if (index === -1) return false;
  state.history.splice(index, 1);
  return true;
}

export function clearHistory(state) {
  const removed = state.history.length;
  state.history = [];
  return removed;
}

export function deleteObjectiveData(state, objectiveId) {
  const before = state.history.length;
  state.history = state.history.filter(entry => entry.objective !== objectiveId);
  const skillRemoved = delete state.skills[objectiveId];
  if (state.objective === objectiveId) state.objective = OBJECTIVES[0].id;
  return { historyRemoved: before - state.history.length, skillRemoved: !!skillRemoved };
}

export function importRuns(state, entries, now = Date.now()) {
  const result = { added: 0, skipped: 0, duplicates: 0, warnings: [] };
  if (!Array.isArray(entries)) {
    result.warnings.push('O arquivo não contém uma lista de registros.');
    return result;
  }
  const seen = new Set(state.history.map(entry => entry.id));
  for (const entry of entries) {
    const validated = validateRunEntry(entry);
    if (!validated.ok) {
      result.skipped += 1;
      result.warnings.push(`Registro ignorado: ${validated.error}.`);
      continue;
    }
    if (seen.has(validated.value.id)) {
      result.duplicates += 1;
      continue;
    }
    state.history.push(validated.value);
    seen.add(validated.value.id);
    result.added += 1;
  }
  state.history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (state.history.length > HISTORY_LIMIT) state.history.splice(0, state.history.length - HISTORY_LIMIT);
  void now;
  return result;
}

export function practiceTotals(state) {
  const attempts = state.history.filter(entry => entry.kind === 'attempt');
  return {
    runs: state.history.length,
    attemptRuns: attempts.length,
    creativeRuns: state.history.filter(entry => entry.kind === 'creative').length,
    earQuestions: state.history.filter(entry => entry.kind === 'ear').length,
    earCorrect: state.history.filter(entry => entry.kind === 'ear' && entry.metrics.correct === 1).length,
    totalSeconds: state.history.reduce((sum, entry) => sum + entry.durationSec, 0),
    firstBpm: attempts.length > 0 ? attempts[0].bpm : null,
    lastBpm: attempts.length > 0 ? attempts[attempts.length - 1].bpm : null,
    bestBpm: attempts.reduce((best, entry) => Math.max(best, entry.bpm), 0),
  };
}

export function objectiveProgress(state, objectiveId) {
  const runs = state.history.filter(entry => entry.kind === 'attempt' && entry.objective === objectiveId);
  const skill = state.skills[objectiveId] ?? null;
  return {
    objective: OBJECTIVES.find(o => o.id === objectiveId) ?? null,
    runs: runs.length,
    recentScores: runs.slice(-10).map(entry => entry.metrics.objectiveScore),
    bestScore: runs.reduce((best, entry) => Math.max(best, entry.metrics.objectiveScore), 0),
    bpmJourney: runs.map(entry => entry.bpm),
    skill,
    level: skill ? levelFromSkill(skill) : 0,
  };
}

// ---------------------------------------------------------------------------
// Jogos de ouvido (referência gerada + controles de resposta)
// ---------------------------------------------------------------------------

export const INTERVALS = Object.freeze([
  { semitones: 1, name: '2ª menor' },
  { semitones: 2, name: '2ª maior' },
  { semitones: 3, name: '3ª menor' },
  { semitones: 4, name: '3ª maior' },
  { semitones: 5, name: '4ª justa' },
  { semitones: 6, name: 'tritono' },
  { semitones: 7, name: '5ª justa' },
  { semitones: 8, name: '6ª menor' },
  { semitones: 9, name: '6ª maior' },
  { semitones: 10, name: '7ª menor' },
  { semitones: 11, name: '7ª maior' },
  { semitones: 12, name: 'oitava' },
]);

function shuffleSeeded(items, random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function generateIntervalQuestion(seed, options = {}) {
  const random = mulberry32(normalizeSeed(seed, 1));
  const root = Math.round(clamp(numOr(options.root, 0) || (57 + Math.floor(random() * 13)), 48, 72));
  const interval = INTERVALS[Math.floor(random() * INTERVALS.length)];
  const distractors = shuffleSeeded(
    INTERVALS.filter(item => item.semitones !== interval.semitones),
    random
  ).slice(0, 3);
  const optionsList = shuffleSeeded([interval, ...distractors], random).map(item => item.name);
  return {
    kind: 'interval',
    seed,
    root,
    interval,
    answer: interval.name,
    options: optionsList,
    referenceNotes: [
      { start: 0, duration: 4, pitch: root, velocity: 0.85 },
      { start: 4, duration: 4, pitch: root + interval.semitones, velocity: 0.85 },
    ],
    togetherNotes: [
      { start: 0, duration: 4, pitch: root, velocity: 0.7 },
      { start: 0, duration: 4, pitch: root + interval.semitones, velocity: 0.7 },
    ],
  };
}

export const CHORD_FUNCTIONS = Object.freeze([
  { id: 'tonic', name: 'Tônica', degree: 0, semitones: [0, 4, 7] },
  { id: 'subdominant', name: 'Subdominante', degree: 5, semitones: [5, 9, 12] },
  { id: 'dominant', name: 'Dominante', degree: 7, semitones: [7, 11, 14] },
]);

export function generateChordFunctionQuestion(seed, options = {}) {
  const random = mulberry32(normalizeSeed(seed, 1));
  const root = Math.round(clamp(numOr(options.root, 0) || 60, 55, 67));
  const target = CHORD_FUNCTIONS[Math.floor(random() * CHORD_FUNCTIONS.length)];
  const referenceNotes = [
    { start: 0, duration: 8, pitch: root, velocity: 0.55 },
    { start: 0, duration: 8, pitch: root + 4, velocity: 0.55 },
    { start: 0, duration: 8, pitch: root + 7, velocity: 0.55 },
    { start: 8, duration: 8, pitch: root + target.semitones[0], velocity: 0.6 },
    { start: 8, duration: 8, pitch: root + target.semitones[1], velocity: 0.6 },
    { start: 8, duration: 8, pitch: root + target.semitones[2], velocity: 0.6 },
  ];
  return {
    kind: 'chord',
    seed,
    root,
    target,
    answer: target.name,
    options: CHORD_FUNCTIONS.map(fn => fn.name),
    referenceNotes,
  };
}

export function generateRhythmQuestion(seed, options = {}) {
  const random = mulberry32(normalizeSeed(seed, 1) ^ 0x1234abcd);
  const bars = [1, 2].includes(options.bars) ? options.bars : 1;
  const density = ['sparse', 'medium', 'busy'].includes(options.density) ? options.density : 'medium';
  const groove = generateGroove({ bars, seed: normalizeSeed(seed, 1), density, syncopation: 'mixed', lengths: 'short' });
  const extraTick = Math.floor(random() * 16);
  const notes = groove.notes.map((note, index) => ({
    id: `ear-rhythm-${index}`,
    start: note.start,
    duration: note.duration,
    pitch: 69,
    velocity: 0.85,
  }));
  if (density === 'sparse' && bars === 1 && !notes.some(note => note.start === extraTick)) {
    notes.push({ id: `ear-rhythm-extra`, start: extraTick, duration: 1, pitch: 69, velocity: 0.85 });
    notes.sort((a, b) => a.start - b.start);
  }
  return {
    kind: 'rhythm',
    seed,
    bars,
    ticksPerBar: 16,
    notes,
    onsets: notes.map(note => note.start),
  };
}

export function checkRhythmAnswer(question, selectedTicks) {
  const expected = new Set(question.onsets);
  const selected = new Set(Array.isArray(selectedTicks) ? selectedTicks : []);
  const missed = [...expected].filter(tick => !selected.has(tick)).sort((a, b) => a - b);
  const extra = [...selected].filter(tick => !expected.has(tick)).sort((a, b) => a - b);
  return { correct: missed.length === 0 && extra.length === 0, missed, extra };
}

// ---------------------------------------------------------------------------
// Montagem da aba Praticar
// ---------------------------------------------------------------------------

function requireHost(host) {
  if (!host || typeof host !== 'object') throw new TypeError('A prática requer um host do estúdio.');
  for (const method of ['getSession', 'updateSession', 'play', 'stop', 'notify']) {
    if (typeof host[method] !== 'function') throw new TypeError(`O host da prática precisa do método ${method}.`);
  }
}

export function mountPractice(container, host, options = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para a prática.');
  requireHost(host);
  const storage = options.storage ?? safeStorage();
  const loadInfo = loadPracticeState(storage);
  const state = loadInfo.state;
  const session0 = normalizeSession(host.getSession());

  let exercise = generateExercise({ objective: state.objective, seed: 1, bars: 1, bpm: session0.bpm, level: levelFromSkill(state.skills[state.objective]), source: 'generated', session: host.getSession() });
  let exerciseSource = 'generated';
  let seedValue = 1;
  let stageIndex = 0;
  let listens = 0;
  let routineDone = false;
  let lastRun = null;
  let comparing = null;
  const completedRuns = new WeakMap();
  let pendingStage = null;
  let improvisation = null;
  let variantDimension = VARIANT_DIMENSIONS[0].id;
  let earActivity = 'interval';
  const earGames = {
    interval: { question: null, answered: null, seed: 1 },
    chord: { question: null, answered: null, seed: 1 },
    rhythm: { question: null, marked: new Set(), answered: null, seed: 1 },
  };

  const root = createEl('section', { className: 'practice-root', 'aria-label': 'Prática guiada' });

  function save() {
    if (!savePracticeState(state, storage)) host.notify('Não foi possível salvar o histórico de prática local.', true);
  }

  function rerender() {
    if (root.isConnected === false && !container.contains(root)) container.appendChild(root);
    renderKeepingFocus(root, renderAll);
  }

  function activeStage() {
    const stages = state.routine.stages;
    if (stages.length === 0 || stageIndex >= stages.length) return null;
    return STAGES.find(stage => stage.id === stages[stageIndex]) ?? null;
  }

  function applyExerciseToSession() {
    host.updateSession({
      notes: exercise.notes.map(note => ({ ...note })),
      bpm: exercise.bpm,
      bars: exercise.bars,
      meter: exercise.meter,
      loop: exercise.source === 'session' ? host.getSession().loop : { startBar: 0, endBar: exercise.bars },
      metronome: { ...exercise.metronome },
      training: { goal: exercise.objective === 'durations' ? 'duration' : 'timing', adaptive: state.routine.adaptiveTempo },
      extensions: { practice: { objective: exercise.objective, stage: activeStage()?.name ?? 'execução livre' } },
    });
  }

  function rebuildExercise({ preserveBpm = false } = {}) {
    const previousBpm = preserveBpm && exercise ? exercise.bpm : undefined;
    exercise = generateExercise({
      objective: state.objective,
      seed: seedValue,
      bars: exercise?.bars === 2 || exercise?.bars === 4 ? exercise.bars : 1,
      bpm: previousBpm ?? host.getSession()?.bpm ?? 90,
      level: levelFromSkill(state.skills[state.objective]),
      source: exerciseSource,
      session: host.getSession(),
    });
  }

  function stageComplete() {
    pendingStage = null;
    if (improvisation) {
      host.stop();
      host.updateSession(improvisation.restore);
      improvisation = null;
    }
    stageIndex += 1;
    listens = 0;
    if (stageIndex >= state.routine.stages.length) {
      routineDone = true;
      stageIndex = state.routine.stages.length;
    }
    rerender();
  }

  function processRun(attempts, detail) {
    Object.assign(state, loadPracticeState(storage).state);
    const session = detail?.session && typeof detail.session === 'object' ? detail.session : host.getSession();
    const normalized = normalizeSession(session);
    const { rows, summary } = evaluationFromDetail(detail, attempts, session);
    const objective = OBJECTIVES.some(item => item.id === session.extensions?.practice?.objective)
      ? session.extensions.practice.objective : state.objective;
    const metric = summary.mode === 'free' ? 0 : objectiveMetric(objective, { rows, summary, notes: normalized.notes, ticksPerBeat: normalized.ticksPerBeat });
    const adapt = session.training?.adaptive && summary.expected > 0 && session.training?.evaluation !== 'free'
      ? adaptTempo(normalized.bpm, summary, { tempoStep: normalized.tempoStep }) : null;
    const run = {
      id: runId(attempts, normalized.bpm),
      at: new Date().toISOString(),
      kind: summary.mode === 'free' || summary.expected === 0 ? 'creative' : 'attempt',
      objective,
      stage: session.extensions?.practice?.stage ?? 'execução livre',
      bpm: normalized.bpm,
      bars: normalized.bars,
      durationSec: Math.round((session.loop?.endBar - session.loop?.startBar || normalized.bars) * normalized.ticksPerBar * tickSeconds(normalized.bpm) * normalized.repetitions),
      notes: normalized.notes,
      metrics: {
        ...summary,
        objectiveScore: Math.round(metric * 100),
      },
      tempoDelta: adapt?.bpmDelta ?? 0,
    };
    const recorded = recordRun(state, run);
    if (recorded.recorded) save();
    lastRun = recorded.recorded ? recorded.entry : state.history.find(entry => entry.id === run.id) ?? run;
    if (recorded.recorded && adapt && adapt.bpmDelta !== 0) {
      host.updateSession({ bpm: adapt.nextBpm });
      if (exercise.objective === objective) exercise.bpm = adapt.nextBpm;
      host.notify(`Tempo adaptado: ${adapt.reason}`);
    }
    rerender();
    return { run: lastRun, summary, metric, adapt };
  }

  function findPreviousRun() {
    if (!lastRun) return null;
    const previous = state.history.filter(entry => entry.kind === 'attempt' && entry.id !== lastRun.id);
    return previous.length > 0 ? previous[previous.length - 1] : null;
  }

  // ----- seções ---------------------------------------------------------------

  function renderAll() {
    root.replaceChildren();
    if (loadInfo.warnings.length > 0) {
      const warningBox = createEl('div', { className: 'practice-warnings', role: 'status' });
      for (const warning of loadInfo.warnings) warningBox.appendChild(createEl('p', { text: warning }));
      root.appendChild(warningBox);
    }
    root.appendChild(renderObjectivesSection());
    const current = renderExerciseSection();
    current.classList.add('practice-current');
    current.appendChild(renderStagesSection());
    current.appendChild(disclosure('exercise', 'Ajustar exercício', renderExerciseControls()));
    root.appendChild(current);
    if (lastRun) root.appendChild(renderResultsSection());
    root.appendChild(disclosure('routine', 'Configurar rotina', renderRoutineSection()));
    root.appendChild(disclosure('ear', 'Jogos de ouvido', renderEarSection()));
    root.appendChild(disclosure('history', 'Histórico e revisões', renderHistorySection()));
  }

  function disclosure(id, label, content) {
    return createEl('details', { className: 'practice-disclosure', dataset: { disclosure: id } }, [
      createEl('summary', { text: label, dataset: { focusKey: `disclosure-${id}` } }),
      content,
    ]);
  }

  function renderObjectivesSection() {
    const section = createEl('section', { className: 'practice-section', 'aria-labelledby': 'practice-objectives-title' });
    section.appendChild(createEl('h3', { id: 'practice-objectives-title', text: 'Objetivo' }));
    const list = createEl('select', { id: 'practice-objective', 'aria-label': 'Objetivo de prática' });
    for (const objective of OBJECTIVES) {
      const skill = state.skills[objective.id] ?? null;
      list.appendChild(createEl('option', {
        value: objective.id,
        selected: state.objective === objective.id,
        text: `${objective.name} · nível ${levelFromSkill(skill) + 1}`,
      }));
    }
    list.addEventListener('change', () => {
      state.objective = list.value;
      save();
      rebuildExercise({ preserveBpm: true });
      stageIndex = 0;
      listens = 0;
      routineDone = false;
      rerender();
    });
    section.appendChild(list);
    const focus = OBJECTIVES.find(o => o.id === state.objective);
    section.appendChild(createEl('p', { className: 'practice-focus', role: 'status', text: focus?.focus ?? '' }));
    const skill = state.skills[state.objective];
    if (skill) section.appendChild(createEl('p', { className: 'practice-hint', text: `Próxima revisão: ${formatDaysFromNow(skill.dueAt)}.` }));
    return section;
  }

  function renderRoutineSection() {
    const section = createEl('section', { className: 'practice-section', 'aria-labelledby': 'practice-routine-title' });
    section.appendChild(createEl('h3', { id: 'practice-routine-title', text: 'Rotina' }));
    const stageList = createEl('div', { className: 'practice-stage-config' });
    for (const stage of STAGES) {
      const enabled = state.routine.stages.includes(stage.id);
      const label = createEl('label', { className: 'practice-stage-toggle' });
      const checkbox = createEl('input', { type: 'checkbox', 'aria-label': `Etapa ${stage.name}` });
      checkbox.checked = enabled;
      checkbox.addEventListener('change', () => {
        const stages = new Set(state.routine.stages);
        if (checkbox.checked) {
          const order = STAGES.map(s => s.id).filter(id => stages.has(id) || id === stage.id);
          state.routine.stages = order;
        } else {
          stages.delete(stage.id);
          state.routine.stages = [...stages];
        }
        stageIndex = Math.min(stageIndex, Math.max(0, state.routine.stages.length - 1));
        routineDone = state.routine.stages.length === 0 ? true : routineDone && stageIndex >= state.routine.stages.length;
        save();
        rerender();
      });
      label.appendChild(checkbox);
      label.appendChild(createEl('span', { text: `${stage.name}: ${stage.description}` }));
      stageList.appendChild(label);
    }
    section.appendChild(stageList);

    const controls = createEl('div', { className: 'practice-routine-controls' });
    const listenInput = createEl('input', { type: 'number', min: '1', max: '8', value: String(state.routine.listenRepetitions), 'aria-label': 'Escutas da referência na etapa Escutar' });
    listenInput.addEventListener('change', () => {
      state.routine.listenRepetitions = clamp(Math.round(Number(listenInput.value) || 2), 1, 8);
      listenInput.value = String(state.routine.listenRepetitions);
      save();
    });
    controls.appendChild(createEl('label', {}, [createEl('span', { text: 'Escutas por referência: ' }), listenInput]));
    const silentInput = createEl('input', { type: 'number', min: '0', max: '8', value: String(state.routine.memorizeSilentBars), 'aria-label': 'Compassos silenciosos na etapa Memorizar' });
    silentInput.addEventListener('change', () => {
      state.routine.memorizeSilentBars = clamp(Math.round(Number(silentInput.value) || 0), 0, 8);
      silentInput.value = String(state.routine.memorizeSilentBars);
      save();
    });
    controls.appendChild(createEl('label', {}, [createEl('span', { text: 'Compassos silenciosos (memorizar): ' }), silentInput]));
    const adaptive = createEl('input', { type: 'checkbox', 'aria-label': 'Adaptar tempo automaticamente' });
    adaptive.checked = state.routine.adaptiveTempo;
    adaptive.addEventListener('change', () => {
      state.routine.adaptiveTempo = adaptive.checked;
      save();
      rerender();
    });
    controls.appendChild(createEl('label', {}, [adaptive, createEl('span', { text: 'Adaptar tempo pelos resultados' })]));
    section.appendChild(controls);
    section.appendChild(createEl('p', { className: 'practice-criteria', text: tempoCriteriaText(4) }));
    return section;
  }

  function renderExerciseSection() {
    const section = createEl('section', { className: 'practice-section', 'aria-labelledby': 'practice-exercise-title' });
    section.appendChild(createEl('h3', { id: 'practice-exercise-title', text: 'Sua frase' }));
    const meta = createEl('p', { className: 'practice-exercise-meta' });
    meta.appendChild(createEl('span', { text: `${exercise.objectiveName} · ${exercise.bars} compasso(s) · ${exercise.notes.length} nota(s)` }));
    if (exercise.changed) meta.appendChild(createEl('span', { className: 'practice-changed', text: ` · variação: ${VARIANT_DIMENSIONS.find(d => d.id === exercise.changed)?.name ?? exercise.changed}` }));
    section.appendChild(meta);
    const tempoInput = createEl('input', {
      id: 'practice-exercise-bpm',
      type: 'number',
      min: '30',
      max: '300',
      step: '1',
      value: String(exercise.bpm),
      'aria-label': 'Andamento do exercício (BPM)',
    });
    tempoInput.addEventListener('change', () => {
      exercise.bpm = clamp(Math.round(numOr(tempoInput.valueAsNumber, exercise.bpm)), 30, 300);
      rerender();
    });
    section.appendChild(createEl('div', { className: 'practice-inline-controls' }, [
      createEl('label', { for: 'practice-exercise-bpm' }, [
        createEl('span', { text: 'Andamento do exercício (BPM)' }),
        tempoInput,
      ]),
    ]));
    section.appendChild(renderTickGrid(exercise.notes, exercise.bars, exercise.ticksPerBar, {
      ticksPerBeat: exercise.ticksPerBeat,
      ariaLabel: 'Frase do exercício',
      className: exercise.notes.some(note => note.velocity >= 0.9) ? 'practice-grid-accents' : '',
    }));
    return section;
  }

  function renderExerciseControls() {
    const section = createEl('div', { className: 'practice-exercise-controls' });

    const sourceControls = createEl('div', { className: 'practice-inline-controls' });
    for (const [value, label] of [['generated', 'Frase gerada'], ['session', 'Frase atual do estúdio']]) {
      const button = createEl('button', {
        type: 'button',
        className: `practice-chip${exerciseSource === value ? ' practice-chip-selected' : ''}`,
        'aria-pressed': exerciseSource === value ? 'true' : 'false',
        text: label,
      });
      button.addEventListener('click', () => {
        exerciseSource = value;
        rebuildExercise({ preserveBpm: true });
        rerender();
      });
      sourceControls.appendChild(button);
    }
    section.appendChild(sourceControls);

    const generatorControls = createEl('div', { className: 'practice-inline-controls' });
    const seedInput = createEl('input', { type: 'number', min: '0', max: '4294967295', value: String(seedValue), 'aria-label': 'Semente do exercício' });
    seedInput.addEventListener('change', () => {
      seedValue = normalizeSeed(seedInput.value, seedValue);
      seedInput.value = String(seedValue);
      rebuildExercise({ preserveBpm: true });
      rerender();
    });
    generatorControls.appendChild(createEl('label', {}, [createEl('span', { text: 'Semente: ' }), seedInput]));
    const generateButton = createEl('button', { type: 'button', text: 'Gerar exercício' });
    generateButton.addEventListener('click', () => {
      rebuildExercise({ preserveBpm: true });
      rerender();
      host.notify('Exercício gerado a partir da semente atual.');
    });
    generatorControls.appendChild(generateButton);
    const dimensionSelect = createEl('select', { 'aria-label': 'Dimensão a variar' });
    for (const dimension of VARIANT_DIMENSIONS) {
      dimensionSelect.appendChild(createEl('option', { value: dimension.id, text: dimension.name }));
    }
    dimensionSelect.value = variantDimension;
    dimensionSelect.addEventListener('change', () => { variantDimension = dimensionSelect.value; });
    const variantButton = createEl('button', { type: 'button', text: 'Variar uma dimensão' });
    variantButton.addEventListener('click', () => {
      exercise = partialVariant(exercise, dimensionSelect.value);
      rerender();
      host.notify(`Variação aplicada: ${VARIANT_DIMENSIONS.find(d => d.id === dimensionSelect.value)?.name ?? ''} (demais dimensões preservadas).`);
    });
    generatorControls.appendChild(createEl('label', {}, [createEl('span', { text: 'Variar: ' }), dimensionSelect, variantButton]));
    section.appendChild(generatorControls);


    const playControls = createEl('div', { className: 'practice-inline-controls' });
    const applyButton = createEl('button', { type: 'button', text: 'Usar esta frase na sessão' });
    applyButton.addEventListener('click', () => {
      applyExerciseToSession();
      host.notify('Frase do exercício aplicada à sessão do estúdio.');
    });
    playControls.appendChild(applyButton);
    if (state.routine.stages.length > 0) section.appendChild(renderFreeControls());
    section.appendChild(playControls);
    return section;
  }

  function renderFreeControls() {
    const playControls = createEl('div', { className: 'practice-inline-controls', 'aria-label': 'Pratique sem seguir a rotina' });
    const listenOnce = createEl('button', { type: 'button', text: 'Ouvir referência' });
    listenOnce.addEventListener('click', async () => {
      try {
        await previewPhrase(host, exercise.notes, { bpm: exercise.bpm, loops: 2 });
      } catch (error) {
        host.notify(error.message, true);
      }
    });
    playControls.appendChild(listenOnce);
    const train = createEl('button', { type: 'button', className: 'practice-primary', text: 'Treinar sem seguir a rotina' });
    train.addEventListener('click', () => {
      pendingStage = null;
      applyExerciseToSession();
      host.play('train').catch(error => host.notify(error.message, true));
    });
    playControls.appendChild(train);
    const stopButton = createEl('button', { type: 'button', text: 'Cancelar', dataset: { focusKey: 'practice-cancel' } });
    stopButton.addEventListener('click', cancel);
    playControls.appendChild(stopButton);
    return playControls;
  }

  function cancel() {
    pendingStage = null;
    host.stop();
    if (improvisation) host.updateSession(improvisation.restore);
    improvisation = null;
    rerender();
  }

  function renderStagesSection() {
    const section = createEl('section', { className: 'practice-section practice-routine-current', 'aria-labelledby': 'practice-stages-title' });
    section.appendChild(createEl('h3', { id: 'practice-stages-title', text: 'Agora' }));
    if (state.routine.stages.length === 0) {
      section.appendChild(createEl('p', { text: 'Prática livre: ouça a frase e toque quando estiver pronto. Configure a rotina abaixo para seguir etapas.' }));
      section.appendChild(renderFreeControls());
      return section;
    }
    const steps = createEl('ol', { className: 'practice-steps' });
    state.routine.stages.forEach((stageId, index) => {
      const stage = STAGES.find(s => s.id === stageId);
      const li = createEl('li', { className: `practice-step${index === stageIndex && !routineDone ? ' practice-step-active' : ''}${index < stageIndex || routineDone ? ' practice-step-done' : ''}` });
      li.appendChild(createEl('span', {
        className: 'practice-step-name',
        text: stage.name,
        'aria-current': index === stageIndex && !routineDone ? 'step' : null,
      }));
      steps.appendChild(li);
    });
    section.appendChild(steps);

    const stopButton = createEl('button', { type: 'button', text: 'Cancelar', dataset: { focusKey: 'practice-cancel' } });
    stopButton.addEventListener('click', cancel);
    if (routineDone) {
      section.appendChild(createEl('p', { className: 'practice-done', role: 'status', text: 'Rotina concluída! A revisão espaçada agenda os próximos objetivos; veja a aba Percurso.' }));
      const restart = createEl('button', { type: 'button', className: 'practice-primary', dataset: { focusKey: 'routine-action' }, text: 'Recomeçar rotina' });
      restart.addEventListener('click', () => {
        stageIndex = 0;
        listens = 0;
        routineDone = false;
        rerender();
      });
      section.appendChild(restart);
      section.appendChild(stopButton);
      return section;
    }

    const stage = activeStage();
    if (!stage) return section;
    const panel = createEl('div', { className: 'practice-stage-panel' });
    panel.appendChild(createEl('p', { className: 'practice-stage-description', text: `Etapa ${stageIndex + 1}/${state.routine.stages.length} · ${stage.name}: ${stage.description}` }));
    const controls = createEl('div', { className: 'practice-inline-controls' });

    if (stage.id === 'listen') {
      const listenButton = createEl('button', { type: 'button', className: 'practice-primary', dataset: { focusKey: 'routine-action' }, text: `Ouvir referência (${listens}/${state.routine.listenRepetitions})` });
      listenButton.addEventListener('click', async () => {
        try {
          const completed = await previewPhrase(host, exercise.notes, { bpm: exercise.bpm });
          if (completed === false || activeStage()?.id !== 'listen') return;
          listens += 1;
          if (listens >= state.routine.listenRepetitions) stageComplete();
          else rerender();
        } catch (error) {
          host.notify(error.message, true);
        }
      });
      controls.appendChild(listenButton);
    } else if (stage.id === 'imitate' || stage.id === 'memorize') {
      const trainButton = createEl('button', { type: 'button', className: 'practice-primary', dataset: { focusKey: 'routine-action' }, text: stage.id === 'imitate' ? 'Treinar com a referência' : 'Treinar com clique parcial' });
      trainButton.addEventListener('click', () => {
        pendingStage = stageIndex;
        applyExerciseToSession();
        if (stage.id === 'memorize') {
          host.updateSession({ metronome: { silentBars: state.routine.memorizeSilentBars, audibleBars: 1, pattern: 'quarters', enabled: true } });
        }
        host.play('train').catch(error => {
          pendingStage = null;
          host.notify(`Não foi possível iniciar o treino: ${error?.message ?? error}`, true);
        });
        host.notify('Treino iniciado: toque no teclado ou superfície do estúdio quando o clique contar 1.');
      });
      controls.appendChild(trainButton);
      controls.appendChild(createEl('span', { className: 'practice-hint', text: 'Toque no teclado ou na superfície. Ao terminar, veja o resultado abaixo.' }));
    } else if (stage.id === 'read') {
      const counts = createEl('p', { className: 'practice-counts', text: 'Conte em voz alta: 1 · e · e · a, 2 · e · e · a… (um ataque por nota na grade acima).' });
      panel.appendChild(counts);
      const readDone = createEl('button', { type: 'button', className: 'practice-primary', dataset: { focusKey: 'routine-action' }, text: 'Concluir leitura' });
      readDone.addEventListener('click', () => stageComplete());
      controls.appendChild(readDone);
    } else if (stage.id === 'improvise') {
      const improviseStart = createEl('button', { type: 'button', className: 'practice-primary', dataset: { focusKey: 'routine-action' }, disabled: !!improvisation, text: 'Tocar acompanhamento e improvisar' });
      improviseStart.addEventListener('click', async () => {
        if (improvisation) return;
        applyExerciseToSession();
        const current = host.getSession();
        const restore = { band: { role: current.band.role }, mixer: { phrase: { muted: current.mixer.phrase.muted } } };
        host.updateSession({ band: { role: 'solo' }, mixer: { phrase: { muted: true } } });
        try {
          await host.play('loop');
          improvisation = { startAt: performance.now(), restore };
          rerender();
          host.notify('Acompanhamento em loop; improvise no teclado do estúdio. Conclua quando quiser.');
        } catch (error) {
          host.updateSession(restore);
          host.notify(`Não foi possível iniciar o acompanhamento: ${error?.message ?? error}`, true);
        }
      });
      controls.appendChild(improviseStart);
      const finish = createEl('button', { type: 'button', className: improvisation ? 'practice-primary' : '', text: 'Concluir improvisação', disabled: !improvisation });
      finish.addEventListener('click', () => {
        if (!improvisation) return;
        const durationSec = (performance.now() - improvisation.startAt) / 1000;
        host.stop();
        host.updateSession(improvisation.restore);
        improvisation = null;
        Object.assign(state, loadPracticeState(storage).state);
        const creative = {
          id: `creative-${Date.now()}`,
          at: new Date().toISOString(),
          kind: 'creative',
          objective: state.objective,
          stage: 'Improvisar',
          bpm: exercise.bpm,
          bars: exercise.bars,
          durationSec,
          notes: exercise.notes,
          metrics: { expected: 0, matched: 0, missed: 0, extra: 0, attackOk: 0, endOk: 0, objectiveScore: 0 },
          tempoDelta: 0,
        };
        lastRun = recordRun(state, creative).entry ?? creative;
        save();
        stageComplete();
        host.notify('Improvisação registrada como escolha criativa (sem nota).');
      });
      controls.appendChild(finish);
    }
    controls.appendChild(stopButton);

    const skip = createEl('button', { type: 'button', text: 'Pular etapa' });
    skip.addEventListener('click', () => stageComplete());
    controls.appendChild(skip);
    panel.appendChild(controls);
    section.appendChild(panel);
    return section;
  }

  function renderResultsSection() {
    const section = createEl('section', { id: 'practice-results', tabindex: '-1', className: 'practice-section', 'aria-labelledby': 'practice-results-title' });
    section.appendChild(createEl('h3', { id: 'practice-results-title', text: 'Resultados' }));
    if (lastRun.kind === 'creative') {
      section.appendChild(createEl('p', { role: 'status', text: 'Execução livre registrada no histórico como material criativo, sem nota ou revisão por acerto.' }));
      return section;
    }
    const m = lastRun.metrics;
    const table = createEl('table', { className: 'practice-metrics', 'aria-label': 'Métricas da última execução' });
    const head = createEl('tr', {}, [
      createEl('th', { scope: 'col', text: 'Dimensão' }),
      createEl('th', { scope: 'col', text: 'Resultado' }),
    ]);
    table.appendChild(createEl('thead', {}, [head]));
    const body = createEl('tbody');
    const rows = [
      ['Cobertura (notas tocadas)', `${m.matched}/${m.expected}`],
      ['Ataques no tempo', `${m.attackOk}/${m.expected}`],
      ['Términos no tempo (durações)', `${m.endOk}/${Math.max(1, m.matched)}`],
      ['Notas perdidas', String(m.missed)],
      ['Sobras (tocadas fora)', String(m.extra)],
      [`Aproveitamento do objetivo (${OBJECTIVES.find(o => o.id === lastRun.objective)?.name ?? lastRun.objective})`, `${m.objectiveScore}%`],
    ];
    if (lastRun.tempoDelta !== 0) rows.push(['Adaptação de tempo', `${lastRun.tempoDelta > 0 ? '+' : ''}${lastRun.tempoDelta} bpm`]);
    for (const [dimension, value] of rows) {
      body.appendChild(createEl('tr', {}, [createEl('th', { scope: 'row', text: dimension }), createEl('td', { text: value })]));
    }
    table.appendChild(body);
    section.appendChild(table);

    const controls = createEl('div', { className: 'practice-inline-controls' });
    const reference = createEl('button', { type: 'button', text: 'Ouvir referência' });
    reference.addEventListener('click', () => host.play('loop').catch(error => host.notify(`Falha ao reproduzir: ${error?.message ?? error}`, true)));
    controls.appendChild(reference);
    // O take desta execução é capturado automaticamente pelo estúdio
    // (Repertório); aqui comparamos execuções locais sem duplicar captura.
    const previousRun = findPreviousRun();
    if (previousRun) {
      const compareButton = createEl('button', { type: 'button', text: `Comparar com execução anterior (${previousRun.bpm} bpm)` });
      compareButton.addEventListener('click', () => {
        comparing = previousRun;
        rerender();
      });
      controls.appendChild(compareButton);
    }
    section.appendChild(controls);

    if (comparing) {
      const box = createEl('div', { className: 'practice-comparison', role: 'region', 'aria-label': 'Comparação com execução anterior' });
      box.appendChild(createEl('p', { text: `Comparação — execução atual vs. execução anterior de ${formatDatePt(comparing.at)} (${comparing.bpm} bpm). O take desta execução fica no Repertório, capturado automaticamente pelo estúdio:` }));
      const cmpTable = createEl('table', { className: 'practice-metrics' });
      cmpTable.appendChild(createEl('thead', {}, [createEl('tr', {}, [
        createEl('th', { scope: 'col', text: 'Métrica' }),
        createEl('th', { scope: 'col', text: 'Atual' }),
        createEl('th', { scope: 'col', text: 'Take salvo' }),
      ])]));
      const cmpBody = createEl('tbody');
      for (const key of ['matched', 'attackOk', 'endOk', 'missed', 'extra']) {
        const label = { matched: 'Notas tocadas', attackOk: 'Ataques no tempo', endOk: 'Términos no tempo', missed: 'Perdidas', extra: 'Sobras' }[key];
        cmpBody.appendChild(createEl('tr', {}, [
          createEl('th', { scope: 'row', text: label }),
          createEl('td', { text: String(lastRun.metrics[key] ?? 0) }),
          createEl('td', { text: String(comparing.metrics[key] ?? 0) }),
        ]));
      }
      cmpBody.appendChild(createEl('tr', {}, [
        createEl('th', { scope: 'row', text: 'Aproveitamento do objetivo' }),
        createEl('td', { text: `${lastRun.metrics.objectiveScore}%` }),
        createEl('td', { text: `${comparing.metrics.objectiveScore}%` }),
      ]));
      cmpTable.appendChild(cmpBody);
      box.appendChild(cmpTable);
      section.appendChild(box);
    }
    return section;
  }

  function renderEarSection() {
    const section = createEl('section', { className: 'practice-section', 'aria-labelledby': 'practice-ear-title' });
    section.appendChild(createEl('h3', { id: 'practice-ear-title', text: 'Jogos de ouvido' }));
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'Ouça, responda e confira. Cada jogo revela a resposta, sem punição.' }));
    const chooser = createEl('select', { id: 'practice-ear-activity', 'aria-label': 'Jogo de ouvido' });
    for (const [id, label] of [['interval', 'Intervalos'], ['chord', 'Função do acorde'], ['rhythm', 'Reconhecimento de ritmo']]) {
      chooser.appendChild(createEl('option', { value: id, selected: earActivity === id, text: label }));
    }
    chooser.addEventListener('change', () => { earActivity = chooser.value; rerender(); });
    section.appendChild(chooser);
    section.appendChild(({ interval: renderIntervalGame, chord: renderChordGame, rhythm: renderRhythmGame })[earActivity]());
    return section;
  }

  function earSeedControl(gameId, onNew) {
    const game = earGames[gameId];
    const wrap = createEl('div', { className: 'practice-ear-navigation' });
    const newButton = createEl('button', {
      type: 'button',
      className: !game.question || game.answered ? 'practice-primary' : '',
      text: game.answered ? 'Próxima questão' : game.question ? 'Trocar questão' : 'Começar',
      dataset: { focusKey: 'ear-next' },
    });
    newButton.addEventListener('click', () => {
      host.stop();
      game.seed = (game.seed + 1) >>> 0;
      onNew();
      root.querySelector('.practice-ear-game .practice-inline-controls button')?.focus();
    });
    wrap.appendChild(newButton);
    const advanced = createEl('details', { className: 'practice-disclosure', dataset: { disclosure: `ear-seed-${gameId}` } });
    advanced.appendChild(createEl('summary', { text: 'Opções avançadas', dataset: { focusKey: `ear-seed-${gameId}` } }));
    const controls = createEl('div', { className: 'practice-inline-controls' });
    const seedInput = createEl('input', { type: 'number', min: '0', max: '4294967295', step: '1', value: String(game.seed), 'aria-label': 'Semente do jogo de ouvido' });
    controls.appendChild(createEl('label', {}, [createEl('span', { text: 'Semente: ' }), seedInput]));
    const reproduce = createEl('button', { type: 'button', text: 'Gerar com esta semente' });
    reproduce.addEventListener('click', () => {
      if (!seedInput.reportValidity()) return;
      host.stop();
      game.seed = normalizeSeed(seedInput.value, game.seed);
      onNew();
    });
    controls.appendChild(reproduce);
    advanced.appendChild(createEl('p', { className: 'practice-hint', text: 'Use a mesma semente para reproduzir uma questão. Próxima questão escolhe outra automaticamente.' }));
    advanced.appendChild(controls);
    wrap.appendChild(advanced);
    return wrap;
  }

  function answerButtons(question, answered, onAnswer) {
    const wrap = createEl('div', { className: 'practice-ear-answers', role: 'group', 'aria-label': 'Alternativas' });
    for (const option of question.options) {
      const isAnswer = option === question.answer;
      let className = 'practice-ear-answer';
      if (answered) {
        if (isAnswer) className += ' practice-ear-answer-correct';
        else if (answered.choice === option) className += ' practice-ear-answer-wrong';
      }
      const button = createEl('button', { type: 'button', className, text: option, disabled: !!answered });
      button.addEventListener('click', () => {
        onAnswer(option);
        root.querySelector('[data-focus-key="ear-next"]')?.focus();
      });
      wrap.appendChild(button);
    }
    return wrap;
  }

  function recordEar(gameId, correct) {
    Object.assign(state, loadPracticeState(storage).state);
    const ok = correct ? 1 : 0;
    const run = {
      id: `ear-${gameId}-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      at: new Date().toISOString(),
      kind: 'ear',
      objective: gameId,
      stage: 'ouvido',
      bpm: 90,
      bars: 1,
      durationSec: 0,
      notes: [],
      metrics: { expected: 1, matched: ok, missed: 1 - ok, extra: 0, attackOk: ok, endOk: ok, objectiveScore: ok * 100, correct: ok },
      tempoDelta: 0,
    };
    recordRun(state, run);
    save();
  }

  function renderIntervalGame() {
    const game = earGames.interval;
    const box = createEl('div', { className: 'practice-ear-game', 'aria-label': 'Jogo de intervalos' });
    box.appendChild(createEl('h4', { text: 'Intervalos' }));
    if (!game.question) box.appendChild(createEl('p', { className: 'practice-hint', text: 'Ouça duas notas e diga o intervalo entre a primeira e a segunda.' }));
    const navigation = earSeedControl('interval', () => {
      game.question = generateIntervalQuestion(game.seed);
      game.answered = null;
      rerender();
    });
    if (game.question) {
      const controls = createEl('div', { className: 'practice-inline-controls' });
      const play = createEl('button', { type: 'button', className: game.answered ? '' : 'practice-primary', text: 'Ouvir referência (ascendente)' });
      play.addEventListener('click', () => previewPhrase(host, game.question.referenceNotes, { bpm: 90 }).catch(error => host.notify(error.message, true)));
      controls.appendChild(play);
      const together = createEl('button', { type: 'button', text: 'Ouvir as duas juntas' });
      together.addEventListener('click', () => previewPhrase(host, game.question.togetherNotes, { bpm: 90 }).catch(error => host.notify(error.message, true)));
      controls.appendChild(together);
      box.appendChild(controls);
      box.appendChild(answerButtons(game.question, game.answered, choice => {
        game.answered = { choice };
        recordEar('ear-interval', game.answered.choice === game.question.answer);
        rerender();
      }));
      if (game.answered) {
        const ok = game.answered.choice === game.question.answer;
        box.appendChild(createEl('p', { className: 'practice-ear-feedback', role: 'status', text: ok ? `Correto: ${game.question.answer} (${game.question.interval.semitones} semitons).` : `Era ${game.question.answer} (${game.question.interval.semitones} semitons); você escolheu ${game.answered.choice}. Ouça a referência novamente para comparar.` }));
      }
    }
    box.appendChild(navigation);
    return box;
  }

  function renderChordGame() {
    const game = earGames.chord;
    const box = createEl('div', { className: 'practice-ear-game', 'aria-label': 'Jogo de função de acorde' });
    box.appendChild(createEl('h4', { text: 'Função do acorde' }));
    if (!game.question) box.appendChild(createEl('p', { className: 'practice-hint', text: 'Ouça a tônica e depois um segundo acorde; diga a função dele.' }));
    const navigation = earSeedControl('chord', () => {
      game.question = generateChordFunctionQuestion(game.seed);
      game.answered = null;
      rerender();
    });
    if (game.question) {
      const controls = createEl('div', { className: 'practice-inline-controls' });
      const play = createEl('button', { type: 'button', className: game.answered ? '' : 'practice-primary', text: 'Ouvir tônica e acorde' });
      play.addEventListener('click', () => previewPhrase(host, game.question.referenceNotes, { bpm: 90 }).catch(error => host.notify(error.message, true)));
      controls.appendChild(play);
      box.appendChild(controls);
      box.appendChild(answerButtons(game.question, game.answered, choice => {
        game.answered = { choice };
        recordEar('ear-chord', game.answered.choice === game.question.answer);
        rerender();
      }));
      if (game.answered) {
        const ok = game.answered.choice === game.question.answer;
        box.appendChild(createEl('p', { className: 'practice-ear-feedback', role: 'status', text: ok ? `Correto: ${game.question.answer}.` : `Era ${game.question.answer}; você escolheu ${game.answered.choice}. Ouça a referência novamente para comparar.` }));
      }
    }
    box.appendChild(navigation);
    return box;
  }

  function renderRhythmGame() {
    const game = earGames.rhythm;
    const box = createEl('div', { className: 'practice-ear-game', 'aria-label': 'Jogo de reconhecimento de ritmo' });
    box.appendChild(createEl('h4', { text: 'Reconhecimento de ritmo' }));
    if (!game.question) box.appendChild(createEl('p', { className: 'practice-hint', text: 'Ouça o ritmo e marque na grade os ticks onde há ataques; depois confira.' }));
    const navigation = earSeedControl('rhythm', () => {
      game.question = generateRhythmQuestion(game.seed);
      game.marked = new Set();
      game.answered = null;
      rerender();
    });
    if (game.question) {
      const controls = createEl('div', { className: 'practice-inline-controls' });
      const play = createEl('button', { type: 'button', className: game.answered ? '' : 'practice-primary', text: 'Ouvir ritmo' });
      play.addEventListener('click', () => previewPhrase(host, game.question.notes, { bpm: 90 }).catch(error => host.notify(error.message, true)));
      controls.appendChild(play);
      const check = createEl('button', { type: 'button', text: 'Conferir resposta' });
      check.addEventListener('click', () => {
        game.answered = checkRhythmAnswer(game.question, [...game.marked]);
        recordEar('ear-rhythm', game.answered.correct);
        rerender();
        root.querySelector('[data-focus-key="ear-next"]')?.focus();
      });
      check.disabled = !!game.answered;
      controls.appendChild(check);
      box.appendChild(controls);
      box.appendChild(renderTickGrid(game.answered ? game.question.notes : [], game.question.bars, game.question.ticksPerBar, {
        marked: game.answered ? new Set([...game.question.onsets]) : game.marked,
        onToggle: game.answered ? null : tick => {
          if (game.marked.has(tick)) game.marked.delete(tick);
          else game.marked.add(tick);
          rerender();
        },
        ariaLabel: 'Resposta: marque os ataques',
      }));
      if (game.answered) {
        const missed = game.answered.missed.length;
        const extra = game.answered.extra.length;
        box.appendChild(createEl('p', {
          className: 'practice-ear-feedback',
          role: 'status',
          text: game.answered.correct
            ? 'Correto: todos os ataques marcados nos ticks certos.'
            : `Quase: ${missed} ataque(s) não marcado(s) e ${extra} marcação(ões) extra(s). A grade agora mostra os ataques reais.`,
        }));
      }
    }
    box.appendChild(navigation);
    return box;
  }

  function renderHistorySection() {
    const section = createEl('section', { className: 'practice-section', 'aria-labelledby': 'practice-history-title' });
    section.appendChild(createEl('h3', { id: 'practice-history-title', text: 'Histórico local' }));
    const review = createEl('button', { type: 'button', text: 'Revisar próximo objetivo' });
    review.addEventListener('click', () => {
      const due = reviewQueue(state.skills).find(entry => entry.due);
      if (!due) { host.notify('Todas as revisões estão em dia. Escolha um objetivo para praticar.'); return; }
      state.objective = due.objective.id;
      save();
      rebuildExercise();
      stageIndex = 0;
      routineDone = false;
      rerender();
    });
    section.appendChild(review);
    const recent = state.history.slice(-8).reverse();
    if (recent.length === 0) {
      section.appendChild(createEl('p', { className: 'practice-hint', text: 'Nenhuma execução registrada ainda. O histórico fica neste navegador e pode ser exportado na aba Percurso.' }));
      return section;
    }
    const list = createEl('ul', { className: 'practice-history' });
    for (const entry of recent) {
      const objectiveName = OBJECTIVES.find(o => o.id === entry.objective)?.name ?? entry.objective;
      const summary = entry.kind === 'attempt'
        ? `${entry.metrics.matched}/${entry.metrics.expected} notas · ${entry.metrics.objectiveScore}% do objetivo · ${entry.bpm} bpm`
        : entry.kind === 'ear'
          ? `${entry.metrics.correct === 1 ? 'acertou' : 'errou'} (${objectiveName})`
          : 'escolha criativa (improvisação)';
      const item = createEl('li', {}, [
        createEl('span', { className: 'practice-history-at', text: formatDatePt(entry.at) }),
        createEl('span', { className: 'practice-history-summary', text: `${objectiveName} · ${entry.stage} · ${summary}` }),
      ]);
      list.appendChild(item);
    }
    section.appendChild(list);
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'Histórico completo, exportação, importação e exclusão individual ficam na aba Percurso.' }));
    return section;
  }

  function onFinish(attempts, detail) {
    if (!Array.isArray(attempts)) return null;
    if (completedRuns.has(attempts)) return completedRuns.get(attempts);
    const result = processRun(attempts, detail);
    completedRuns.set(attempts, result);
    if (attempts.length === 0) host.notify('Nenhum toque: notas esperadas registradas como perdidas, sem sucesso automático.');
    if (pendingStage !== null && pendingStage === stageIndex) stageComplete();
    pendingStage = null;
    return result;
  }

  function render() {
    const previousObjective = state.objective;
    Object.assign(state, loadPracticeState(storage).state);
    if (previousObjective !== state.objective) rebuildExercise();
    rerender();
    return api;
  }

  function destroy() {
    pendingStage = null;
    if (improvisation) host.updateSession(improvisation.restore);
    improvisation = null;
    root.remove();
  }

  const api = { render, onFinish, cancel, destroy };
  return api;
}
