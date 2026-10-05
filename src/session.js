// Sessão canônica do GrooveGoblin (versão 4): frase, harmonia, banda,
// metrônomo, treino, loop e mixer em um único documento persistido,
// exportado e compartilhado. validateSession é estrita: campos
// desconhecidos ou valores inválidos rejeitam o documento inteiro; campos
// ausentes recebem os padrões (documentos de versões menores do mesmo
// formato continuam carregando). Nada é corrigido silenciosamente.

import { EPSILON, ticksPerBar, sessionTicks, beatGroups } from './meter.js';
import {
  ARTICULATIONS, MAX_BARS, MIN_BARS, NOTE_KEYS, completeNote, isValidNote, validPhrase,
} from './model.js';
import { CHORD_FUNCTIONS, CHORD_SOURCES, CHORD_QUALITIES, PROGRESSION_KEYS } from './progression.js';
import { parsePhrase, parseShare } from './portable.js';
import { normalizeForm } from './form.js';
import { DRUM_EDIT_VOICES, MAX_DRUM_EDITS, DRUM_POSITION_EPSILON } from './drum-edits.js';
import { normalizeInstrumentProfile } from './instrument-profile.js';
export { DRUM_EDIT_VOICES, MAX_DRUM_EDITS, DRUM_POSITION_EPSILON };

export { ticksPerBar, sessionTicks, beatGroups, ARTICULATIONS, MIN_BARS, MAX_BARS };

export const SESSION_VERSION = 4;
export const SESSION_FORMAT = 'groovegoblin-session';
export const BPM_MIN = 30;
export const BPM_MAX = 300;
export const DEFAULT_BPM = 100;
export const METER_UNITS = Object.freeze([2, 4, 8, 16]);
export const MAX_BEATS = 16;
export const SUBDIVISIONS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
export const SWING_MAX = 0.75;
export const SWING_UNITS = Object.freeze(['eighth', 'sixteenth']);
export const MIXER_CHANNELS = Object.freeze(['phrase', 'metronome', 'drums', 'chords', 'bass']);
export const STYLES = Object.freeze(['complement', 'pop', 'rock', 'funk', 'shuffle', 'jazz', 'bossa', 'samba', 'baiao', 'reggae', 'waltz']);
export const DENSITIES = Object.freeze(['sparse', 'medium', 'busy']);
export const BAND_MODES = Object.freeze(['steady', 'follow']);
export const ROLES = Object.freeze(['solo', 'bass', 'harmony', 'drums']);
export const METRONOME_PATTERNS = Object.freeze(['quarters', 'backbeat', 'offbeats', 'subdivisions', 'downbeats']);
export const EVALUATION_MODES = Object.freeze(['strict', 'style', 'free']);
export const GOALS = Object.freeze(['timing', 'duration', 'pitch']);
export const SYNCOPATIONS = Object.freeze(['straight', 'mixed', 'syncopated']);
export const LENGTHS = Object.freeze(['short', 'mixed', 'long']);
export const TIMBRES = Object.freeze({
  phrase: Object.freeze(['soft-lead', 'pluck', 'marimba', 'electric-piano', 'organ', 'square-lead', 'woodblock', 'nylon-guitar', 'clean-guitar', 'muted-guitar', 'upright-bass', 'electric-bass', 'synth-bass']),
  chords: Object.freeze(['electric-piano', 'pad', 'organ', 'nylon-guitar', 'pluck']),
  bass: Object.freeze(['upright-bass', 'electric-bass', 'synth-bass']),
});

export const STYLE_LABELS = Object.freeze({
  complement: 'Complementar à frase', pop: 'Pop', rock: 'Rock', funk: 'Funk', shuffle: 'Shuffle', jazz: 'Jazz (swing)',
  bossa: 'Bossa nova', samba: 'Samba', baiao: 'Baião', reggae: 'Reggae (one drop)', waltz: 'Valsa',
});
export const DENSITY_LABELS = Object.freeze({ sparse: 'Esparsa', medium: 'Média', busy: 'Cheia' });
export const BAND_MODE_LABELS = Object.freeze({ steady: 'Constante', follow: 'Responde à sua execução' });
export const ROLE_LABELS = Object.freeze({ solo: 'Solo/melodia', bass: 'Baixo', harmony: 'Harmonia', drums: 'Bateria' });
export const METRONOME_PATTERN_LABELS = Object.freeze({
  quarters: 'Todos os tempos', backbeat: 'Tempos 2 e 4', offbeats: 'Contratempos',
  subdivisions: 'Subdivisões', downbeats: 'Só o tempo 1',
});
export const EVALUATION_MODE_LABELS = Object.freeze({
  strict: 'Estrito (grade exata)', style: 'Estilo (pulso pessoal consistente)', free: 'Livre (sem frase de referência)',
});
export const GOAL_LABELS = Object.freeze({ timing: 'Ataques', duration: 'Ataques e durações', pitch: 'Ataques e alturas' });
export const ARTICULATION_LABELS = Object.freeze({
  normal: 'Normal', accent: 'Acento', ghost: 'Nota fantasma', staccato: 'Staccato', tenuto: 'Tenuto', legato: 'Legato',
});
export const SWING_UNIT_LABELS = Object.freeze({ eighth: 'Colcheias', sixteenth: 'Semicolcheias' });
export const TIMBRE_LABELS = Object.freeze({
  'soft-lead': 'Sintetizador suave', pluck: 'Pluck', marimba: 'Marimba', 'electric-piano': 'Piano elétrico',
  organ: 'Órgão', 'square-lead': 'Onda quadrada', woodblock: 'Wood block', pad: 'Pad', 'nylon-guitar': 'Violão de nylon',
  'upright-bass': 'Contrabaixo acústico', 'electric-bass': 'Baixo elétrico', 'synth-bass': 'Baixo sintetizado',
  'clean-guitar': 'Guitarra limpa', 'muted-guitar': 'Guitarra abafada',
});

const STORAGE_KEY = 'groovegoblin.session.v2';
const RECOVERY_KEY = 'groovegoblin.session.v2.recovery';
const LEGACY_PHRASE_KEY = 'groovegoblin.v1';
const LEGACY_PREFERENCES_KEY = 'groovegoblin.preferences.v1';
const LEGACY_MIXER_KEY = 'groovegoblin.mixer.v1';
const LINK_PREFIX = '#session=';
const LINK_MAX_LENGTH = 65536;
const EXTENSIONS_MAX_LENGTH = 65536;
const MAX_NOTES = 512;
const MAX_CHORDS = 64;
const MAX_CYCLE_BARS = MAX_CHORDS * MAX_BARS;
// Starts/cycles can sum up to 64 individually valid legacy durations.
// Retain those exact values after saving v3; do not quantize during migration.
const POSITION_GRID_EPSILON = MAX_CHORDS * EPSILON;

class SessionError extends TypeError {}

function fail(message) {
  throw new SessionError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function defaultMixer() {
  return Object.fromEntries(MIXER_CHANNELS.map(channel => [channel, { volume: 1, muted: false }]));
}

function defaults() {
  return {
    version: SESSION_VERSION,
    name: 'Sessão sem título',
    notes: [],
    bpm: DEFAULT_BPM,
    bars: 1,
    meter: { beats: 4, unit: 4 },
    subdivision: 4,
    swing: 0,
    swingUnit: 'eighth',
    progression: { keyId: 'c-major', chords: [], enabled: false, cycleBars: 1 },
    drums: { enabled: false, seed: 1, style: 'complement', density: 'medium', edits: [] },
    band: { bassEnabled: false, style: 'pop', density: 'medium', mode: 'steady', role: 'solo' },
    loop: { startBar: 0, endBar: 1 },
    form: { enabled: false, loop: true, sections: [] },
    training: { countInBars: 1, repetitions: 4, goal: 'timing', evaluation: 'strict', tempoStep: 4, adaptive: false, monitor: true },
    metronome: { enabled: true, pattern: 'quarters', silentBars: 0, audibleBars: 1 },
    companion: { enabled: false, pulses: 3, spanBeats: 4, pitch: 84 },
    generator: { density: 'medium', syncopation: 'mixed', lengths: 'mixed', seed: null },
    timbres: { phrase: 'soft-lead', chords: 'electric-piano', bass: 'upright-bass' },
    mixer: defaultMixer(),
    extensions: {},
  };
}

// Cada seção: validadores por campo. Campos ausentes herdam o padrão.
const SECTIONS = {
  meter: {
    beats: value => isInt(value, 1, MAX_BEATS),
    unit: value => METER_UNITS.includes(value),
  },
  progression: {
    keyId: value => PROGRESSION_KEYS.some(key => key.id === value),
    chords: value => Array.isArray(value) && value.length <= MAX_CHORDS,
    cycleBars: value => isNumber(value) && value > 0 && value <= MAX_CYCLE_BARS,
    enabled: value => typeof value === 'boolean',
  },
  drums: {
    enabled: value => typeof value === 'boolean',
    seed: value => isInt(value, 0, 0xffffffff),
    style: value => STYLES.includes(value),
    density: value => DENSITIES.includes(value),
    edits: value => Array.isArray(value) && value.length <= MAX_DRUM_EDITS,
  },
  band: {
    bassEnabled: value => typeof value === 'boolean',
    style: value => STYLES.includes(value),
    density: value => DENSITIES.includes(value),
    mode: value => BAND_MODES.includes(value),
    role: value => ROLES.includes(value),
  },
  loop: {
    startBar: value => isInt(value, 0, MAX_BARS - 1),
    endBar: value => isInt(value, 1, MAX_BARS),
  },
  training: {
    countInBars: value => isInt(value, 0, 4),
    repetitions: value => isInt(value, 1, 64),
    goal: value => GOALS.includes(value),
    evaluation: value => EVALUATION_MODES.includes(value),
    tempoStep: value => isInt(value, 1, 20),
    adaptive: value => typeof value === 'boolean',
    monitor: value => typeof value === 'boolean',
  },
  metronome: {
    enabled: value => typeof value === 'boolean',
    pattern: value => METRONOME_PATTERNS.includes(value),
    silentBars: value => isInt(value, 0, 8),
    audibleBars: value => isInt(value, 1, 8),
  },
  companion: {
    enabled: value => typeof value === 'boolean',
    pulses: value => isInt(value, 2, 12),
    spanBeats: value => isInt(value, 1, MAX_BEATS * 4),
    pitch: value => isInt(value, 24, 108),
  },
  generator: {
    density: value => DENSITIES.includes(value),
    syncopation: value => SYNCOPATIONS.includes(value),
    lengths: value => LENGTHS.includes(value),
    seed: value => value === null || isInt(value, 0, 0xffffffff),
  },
  timbres: {
    phrase: value => TIMBRES.phrase.includes(value),
    chords: value => TIMBRES.chords.includes(value),
    bass: value => TIMBRES.bass.includes(value),
  },
};

const SECTION_LABELS = {
  meter: 'compasso', progression: 'progressão', drums: 'bateria', band: 'banda', loop: 'loop', training: 'treino',
  metronome: 'metrônomo', companion: 'pulso polirrítmico', generator: 'gerador', timbres: 'timbres',
};

const TOP_LEVEL = {
  version: value => [2, 3, SESSION_VERSION].includes(value),
  name: value => typeof value === 'string' && value.length <= 80,
  bpm: value => isInt(value, BPM_MIN, BPM_MAX),
  bars: value => isInt(value, MIN_BARS, MAX_BARS),
  subdivision: value => SUBDIVISIONS.includes(value),
  swing: value => isNumber(value) && value >= 0 && value <= SWING_MAX,
  swingUnit: value => SWING_UNITS.includes(value),
};

const TOP_LEVEL_MESSAGES = {
  version: 'A versão da sessão não é compatível.',
  name: 'O nome da sessão deve ser um texto de até 80 caracteres.',
  bpm: `O BPM deve ser um inteiro entre ${BPM_MIN} e ${BPM_MAX}.`,
  bars: `A sessão deve ter de ${MIN_BARS} a ${MAX_BARS} compassos.`,
  subdivision: 'A subdivisão deve ser de 1 a 8 partes por semínima.',
  swing: `O swing deve estar entre 0 e ${SWING_MAX}.`,
  swingUnit: 'A unidade de swing deve ser colcheia ou semicolcheia.',
};

const ALLOWED_KEYS = new Set([...Object.keys(TOP_LEVEL), ...Object.keys(SECTIONS), 'notes', 'mixer', 'extensions', 'form']);

function normalizeSection(name, value, base, legacy) {
  if (value === undefined) return { ...base };
  if (!isObject(value)) fail(`A seção ${SECTION_LABELS[name]} da sessão é inválida.`);
  const validators = SECTIONS[name];
  const result = { ...base };
  for (const [key, field] of Object.entries(value)) {
    if (!Object.hasOwn(validators, key) || (legacy && name === 'progression' && key === 'cycleBars')) fail(`Campo desconhecido em ${SECTION_LABELS[name]}: ${key}.`);
    if (!validators[key](field)) fail(`Valor inválido em ${SECTION_LABELS[name]}.${key}.`);
    result[key] = field;
  }
  return result;
}

const CHORD_KEYS = ['symbol', 'roman', 'quality', 'degree', 'root', 'bass', 'function', 'source', 'inversion', 'startBar', 'durationBars', 'notes'];

function normalizeChord(chord, beats, legacy) {
  if (!isObject(chord)) fail('Cada acorde da progressão deve ser um objeto.');
  for (const key of Object.keys(chord)) {
    if (!CHORD_KEYS.includes(key) || (legacy && key === 'startBar')) fail(`Campo desconhecido em acorde: ${key}.`);
  }
  if (typeof chord.symbol !== 'string' || chord.symbol.length < 1 || chord.symbol.length > 32) fail('Cada acorde precisa de uma cifra.');
  if (!Array.isArray(chord.notes) || chord.notes.length < 1 || chord.notes.length > 8) fail(`O acorde ${chord.symbol} deve ter de 1 a 8 notas.`);
  const notes = chord.notes.map(note => {
    if (!isObject(note) || Object.keys(note).some(key => key !== 'name' && key !== 'midi')
      || typeof note.name !== 'string' || note.name.length < 1 || note.name.length > 8 || !isInt(note.midi, 0, 127)) {
      fail(`As notas do acorde ${chord.symbol} são inválidas.`);
    }
    return { name: note.name, midi: note.midi };
  });
  const durationBars = chord.durationBars ?? 1;
  // Durações em tempos inteiros do compasso (meio compasso em 4/4 = 2 tempos).
  if (!isNumber(durationBars) || durationBars <= 0 || durationBars > MAX_BARS
    || Math.abs(durationBars * beats - Math.round(durationBars * beats)) > EPSILON) {
    fail(`A duração do acorde ${chord.symbol} deve ser um número inteiro de tempos.`);
  }
  const startBar = chord.startBar === undefined ? 0 : chord.startBar;
  if (!legacy && (!isNumber(startBar) || startBar < 0 || startBar > MAX_CYCLE_BARS
    || Math.abs(startBar * beats - Math.round(startBar * beats)) > POSITION_GRID_EPSILON)) {
    fail(`O início do acorde ${chord.symbol} deve ser um número inteiro de tempos.`);
  }
  const degree = chord.degree ?? null;
  const root = chord.root ?? notes[0].midi % 12;
  const bass = chord.bass ?? null;
  const fn = chord.function ?? 'other';
  const source = chord.source ?? (degree === null ? 'custom' : 'diatonic');
  const inversion = chord.inversion ?? 0;
  if (degree !== null && !isInt(degree, 1, 7)) fail(`Grau inválido no acorde ${chord.symbol}.`);
  if (!isInt(root, 0, 11) || (bass !== null && !isInt(bass, 0, 11))) fail(`Fundamental ou baixo inválido no acorde ${chord.symbol}.`);
  if (!CHORD_FUNCTIONS.includes(fn) || !CHORD_SOURCES.includes(source)) fail(`Função ou origem inválida no acorde ${chord.symbol}.`);
  const intervals = Object.hasOwn(CHORD_QUALITIES, chord.quality ?? '') ? CHORD_QUALITIES[chord.quality ?? ''] : null;
  const foreignBass = bass !== null && intervals && !intervals.some(([semitones]) => (root + semitones) % 12 === bass);
  const tones = new Set(notes.map(note => note.midi % 12).filter(pc => !foreignBass || pc !== bass));
  if (!isInt(inversion, 0, tones.size - 1)) fail(`Inversão inválida no acorde ${chord.symbol}.`);
  for (const key of ['roman', 'quality']) {
    if (Object.hasOwn(chord, key) && (typeof chord[key] !== 'string' || chord[key].length > 16)) fail(`Campo ${key} inválido no acorde ${chord.symbol}.`);
  }
  return {
    symbol: chord.symbol, roman: chord.roman ?? '', quality: chord.quality ?? '', degree, root, bass,
    function: fn, source, inversion, durationBars, notes, ...(!legacy && { startBar }),
  };
}

function normalizeNotes(notes, session) {
  if (!Array.isArray(notes) || notes.length > MAX_NOTES) fail(`A frase deve ser uma lista de até ${MAX_NOTES} notas.`);
  const limit = sessionTicks(session);
  for (const note of notes) {
    if (!isObject(note) || Object.keys(note).some(key => !NOTE_KEYS.includes(key))) fail('As notas da frase contêm campos desconhecidos.');
    if (!isValidNote(note, limit)) fail('As notas da frase são inválidas ou excedem os compassos.');
  }
  const completed = notes.map(completeNote);
  if (!validPhrase(completed, session)) fail('As notas da frase se sobrepõem ou repetem IDs.');
  return completed;
}
// Absolute straight ticks preserve triplets and other generated off-grid attacks.
// A tombstone is retained even when the current generator has no hit there.
function normalizeDrumEdits(edits, session) {
  const limit = sessionTicks(session);
  const seen = new Map();
  const result = edits.map(edit => {
    if (!isObject(edit) || Object.keys(edit).length !== 3
      || Object.keys(edit).some(key => !['voice', 'start', 'velocity'].includes(key))
      || !DRUM_EDIT_VOICES.includes(edit.voice)
      || !isNumber(edit.start) || edit.start < 0 || edit.start >= limit - DRUM_POSITION_EPSILON
      || (edit.velocity !== null && (!isNumber(edit.velocity) || edit.velocity < 0.05 || edit.velocity > 1))) {
      fail('Diferença manual da bateria inválida: use voz, posição dentro da sessão e intensidade de 5–100% (ou null para remover).');
    }
    const positions = seen.get(edit.voice) ?? [];
    if (positions.some(start => Math.abs(start - edit.start) <= DRUM_POSITION_EPSILON)) fail('A bateria contém diferenças repetidas na mesma voz e posição.');
    positions.push(edit.start); seen.set(edit.voice, positions);
    return { voice: edit.voice, start: edit.start, velocity: edit.velocity };
  });
  return result.sort((a, b) => a.start - b.start || DRUM_EDIT_VOICES.indexOf(a.voice) - DRUM_EDIT_VOICES.indexOf(b.voice));
}

function normalizeMixer(value) {
  const mixer = defaultMixer();
  if (value === undefined) return mixer;
  if (!isObject(value)) fail('O mixer da sessão é inválido.');
  for (const [channel, settings] of Object.entries(value)) {
    if (!MIXER_CHANNELS.includes(channel)) fail(`Canal desconhecido no mixer: ${channel}.`);
    if (!isObject(settings)) fail(`Canal ${channel} do mixer inválido.`);
    for (const [field, setting] of Object.entries(settings)) {
      if (field === 'volume' && isNumber(setting) && setting >= 0 && setting <= 1) mixer[channel].volume = setting;
      else if (field === 'muted' && typeof setting === 'boolean') mixer[channel].muted = setting;
      else fail(`Valor inválido no mixer: ${channel}.${field}.`);
    }
  }
  return mixer;
}

function normalizeExtensions(value) {
  if (value === undefined) return {};
  if (!isObject(value)) fail('As extensões da sessão devem ser um objeto.');
  if (isObject(value.studio) && Object.hasOwn(value.studio, 'instrument')) {
    try { normalizeInstrumentProfile(value.studio.instrument); }
    catch (error) { fail(`Perfil do instrumento inválido: ${error.message}`); }
  }
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    fail('As extensões da sessão devem ser JSON.');
  }
  if (text.length > EXTENSIONS_MAX_LENGTH) fail('As extensões da sessão são grandes demais.');
  const extensions = JSON.parse(text);
  if (isObject(extensions.studio) && Object.hasOwn(extensions.studio, 'instrument')) {
    extensions.studio.instrument = normalizeInstrumentProfile(extensions.studio.instrument);
  }
  return extensions;
}

// Constrói uma cópia canônica e profunda, ou lança SessionError.
function normalize(value, version = SESSION_VERSION) {
  if (!isObject(value)) fail('A sessão deve ser um objeto.');
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) fail(`Campo desconhecido na sessão: ${key}.`);
  }
  const base = defaults();
  const legacy = version === 2;
  base.version = version;
  if (legacy) delete base.progression.cycleBars;
  const session = { version: SESSION_VERSION };
  if (!Object.hasOwn(value, 'version')) fail('A sessão não informa a versão.');
  if (value.version !== version) fail(TOP_LEVEL_MESSAGES.version);
  for (const [key, validate] of Object.entries(TOP_LEVEL)) {
    if (!Object.hasOwn(value, key)) {
      session[key] = base[key];
    } else if (!validate(value[key])) {
      fail(TOP_LEVEL_MESSAGES[key]);
    } else {
      session[key] = value[key];
    }
  }
  for (const name of Object.keys(SECTIONS)) {
    session[name] = normalizeSection(name, value[name], base[name], legacy);
  }
  if (version < 4 && Object.hasOwn(value.drums ?? {}, 'edits')) fail('Diferenças manuais da bateria exigem sessão versão 4.');
  session.drums.edits = normalizeDrumEdits(session.drums.edits, session);
  if (!Object.hasOwn(value, 'loop')) session.loop = { startBar: 0, endBar: session.bars };
  else if (!Object.hasOwn(value.loop, 'endBar')) session.loop.endBar = session.bars;
  if (!Object.hasOwn(value.companion ?? {}, 'spanBeats')) session.companion.spanBeats = session.meter.beats;
  if (session.loop.startBar >= session.loop.endBar || session.loop.endBar > session.bars) {
    fail('O loop deve começar antes de terminar e caber nos compassos da sessão.');
  }
  try { session.form = normalizeForm(value.form, session.bars); }
  catch (error) { fail(error.message); }
  session.progression.chords = session.progression.chords.map(chord => normalizeChord(chord, session.meter.beats, legacy));
  if (!legacy) {
    if (!Object.hasOwn(value.progression ?? {}, 'cycleBars')) session.progression.cycleBars = session.bars;
    const { cycleBars, chords } = session.progression;
    if (Math.abs(cycleBars * session.meter.beats - Math.round(cycleBars * session.meter.beats)) > POSITION_GRID_EPSILON) {
      fail('O ciclo harmônico deve ser um número inteiro de tempos.');
    }
    let endBar = 0;
    for (const chord of chords) {
      if (chord.startBar < endBar - EPSILON) fail('Os acordes devem estar em ordem cronológica, sem sobreposição.');
      endBar = chord.startBar + chord.durationBars;
      if (endBar > cycleBars + EPSILON) fail('Os acordes devem caber no ciclo harmônico.');
    }
  }
  session.notes = normalizeNotes(value.notes ?? [], session);
  session.mixer = normalizeMixer(value.mixer);
  session.extensions = normalizeExtensions(value.extensions);
  return session;
}

// Primeiro valida o formato antigo inteiro: campos exclusivos da v3 não
// podem transformar um documento v2 inválido em uma migração aparentemente válida.
function migrateSession(value) {
  if (![2, 3].includes(value?.version)) return value;
  const session = normalize(value, value.version);
  if (value.version === 2) {
    let cursor = 0;
    session.progression.chords = session.progression.chords.map(chord => {
      const positioned = { ...chord, startBar: cursor };
      cursor += chord.durationBars;
      return positioned;
    });
    session.progression.cycleBars = cursor || session.bars;
  }
  session.version = SESSION_VERSION;
  return session;
}

export function validateSession(value) {
  try {
    return { ok: true, session: normalize(migrateSession(value)) };
  } catch (error) {
    if (error instanceof SessionError) return { ok: false, error: error.message };
    return { ok: false, error: 'A sessão é inválida.' };
  }
}

// Sessão completa a partir de padrões; seções aninhadas são mescladas campo a
// campo. Ao mudar "bars" sem informar o loop, o loop cobre toda a sessão.
export function createSession(overrides = {}) {
  if (!isObject(overrides)) throw new TypeError('As opções da sessão devem ser um objeto.');
  if ([2, 3].includes(overrides.version)) {
    const migrated = validateSession(overrides);
    if (!migrated.ok) throw new TypeError(migrated.error);
    return migrated.session;
  }
  const base = defaults();
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = isObject(value) && isObject(base[key]) && key !== 'extensions' ? { ...base[key], ...value } : value;
  }
  if (isObject(merged.progression) && Array.isArray(merged.progression.chords)) {
    let cursor = 0;
    merged.progression.chords = merged.progression.chords.map(chord => {
      if (!isObject(chord)) return chord;
      const positioned = Object.hasOwn(chord, 'startBar') ? chord : { ...chord, startBar: cursor };
      cursor = positioned.startBar + (positioned.durationBars ?? 1);
      return positioned;
    });
    if (!Object.hasOwn(overrides.progression ?? {}, 'cycleBars')) merged.progression.cycleBars = cursor || merged.bars;
  }
  if (!Object.hasOwn(overrides, 'loop')) merged.loop = { startBar: 0, endBar: merged.bars };
  else if (!Object.hasOwn(overrides.loop, 'endBar')) merged.loop.endBar = merged.bars;
  if (!isObject(overrides.companion) || !Object.hasOwn(overrides.companion, 'spanBeats')) {
    merged.companion = { ...merged.companion, spanBeats: merged.meter?.beats ?? 4 };
  }
  if (isObject(overrides.mixer)) {
    merged.mixer = Object.fromEntries(MIXER_CHANNELS.map(channel => [channel, { ...base.mixer[channel], ...overrides.mixer[channel] }]));
  }
  const result = validateSession(merged);
  if (!result.ok) throw new TypeError(result.error);
  return result.session;
}

// Aplica um patch (seções aninhadas mescladas) e devolve uma sessão válida.
// Ajusta o loop e remove notas que não cabem quando o tamanho encolhe.
export function patchSession(session, patch) {
  if (!isObject(patch)) throw new TypeError('O patch da sessão deve ser um objeto.');
  const next = { ...session };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = isObject(value) && isObject(session[key]) && key !== 'extensions' && key !== 'mixer'
      ? { ...session[key], ...value }
      : key === 'mixer' && isObject(value)
        ? Object.fromEntries(MIXER_CHANNELS.map(channel => [channel, { ...session.mixer[channel], ...value[channel] }]))
        : value;
  }
  const editStructureError = drumEditStructureError(session, next);
  if (editStructureError) throw new TypeError(editStructureError);
  if ((Object.hasOwn(patch, 'bars') || Object.hasOwn(patch, 'meter')) && !Object.hasOwn(patch, 'loop')) {
    const covered = session.loop.startBar === 0 && session.loop.endBar === session.bars;
    const bars = next.bars;
    next.loop = covered || session.loop.endBar > bars
      ? { startBar: Math.min(session.loop.startBar, bars - 1), endBar: covered ? bars : Math.min(session.loop.endBar, bars) }
      : session.loop;
    if (next.loop.startBar >= next.loop.endBar) next.loop = { startBar: 0, endBar: bars };
  }
  if (!Object.hasOwn(patch, 'notes') && (Object.hasOwn(patch, 'bars') || Object.hasOwn(patch, 'meter'))) {
    const limit = next.bars * ticksPerBar(next.meter);
    next.notes = session.notes.filter(note => note.start + note.duration <= limit + EPSILON);
  }
  const result = validateSession(next);
  if (!result.ok) throw new TypeError(result.error);
  return result.session;
}

// Structural edits must never reinterpret authored straight-tick positions.
export function drumEditStructureError(previous, next) {
  if (!previous.drums.edits?.length || !next.drums.edits?.length) return null;
  if (previous.meter.beats !== next.meter.beats || previous.meter.unit !== next.meter.unit) {
    return 'Compasso não alterado: há edições manuais da bateria. Restaure a bateria gerada antes de mudar o compasso; Desfazer recupera suas edições.';
  }
  if (next.drums.edits.some(edit => edit.start >= sessionTicks(next) - DRUM_POSITION_EPSILON)) {
    return 'Tamanho não alterado: há edições de bateria nos compassos que seriam removidos. Remova essas edições ou restaure a bateria gerada primeiro.';
  }
  return null;
}
// ----- Persistência --------------------------------------------------------

function readLegacy(storage, warnings) {
  const overrides = {};
  let recoveryRaw = null;
  const raw = storage.getItem(LEGACY_PHRASE_KEY);
  if (raw != null) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!isObject(parsed)) {
      warnings.push('Dados salvos antigos corrompidos; usando padrões.');
      recoveryRaw = raw;
    } else {
      const bars = Object.hasOwn(parsed, 'bars') ? parsed.bars : 1;
      if ([1, 2, 4].includes(bars)) overrides.bars = bars;
      else warnings.push('Número de compassos salvo inválido; usando 1.');
      if (validPhrase(parsed.notes, overrides.bars ?? 1)) overrides.notes = parsed.notes.map(completeNote);
      else warnings.push('Frase salva inválida; usando frase vazia.');
      if (isInt(parsed.bpm, 40, 240)) overrides.bpm = parsed.bpm;
      else warnings.push('BPM salvo inválido; usando 100.');
      if (warnings.length > 0) recoveryRaw = raw;
    }
  }
  const preferences = safeParse(storage.getItem(LEGACY_PREFERENCES_KEY));
  if (isObject(preferences)) {
    if (typeof preferences.metronome === 'boolean') overrides.metronome = { enabled: preferences.metronome };
    const generator = {};
    for (const key of ['density', 'syncopation', 'lengths', 'seed']) {
      if (Object.hasOwn(preferences, key) && SECTIONS.generator[key](preferences[key])) generator[key] = preferences[key];
    }
    if (Object.keys(generator).length) overrides.generator = generator;
  }
  const mixer = safeParse(storage.getItem(LEGACY_MIXER_KEY));
  if (isObject(mixer)) {
    const migrated = {};
    for (const channel of ['phrase', 'metronome', 'drums', 'chords']) {
      const settings = mixer[channel];
      if (isObject(settings) && isNumber(settings.volume) && settings.volume >= 0 && settings.volume <= 1
        && typeof settings.muted === 'boolean') {
        migrated[channel] = { volume: settings.volume, muted: settings.muted };
      } else {
        warnings.push(`Canal ${channel} do mixer antigo inválido; usando padrão.`);
      }
    }
    overrides.mixer = migrated;
  }
  return { session: createSession(overrides), recoveryRaw };
}

function safeParse(raw) {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// A chave física v2 é mantida: a versão do JSON governa a migração, sem
// descartar sessões antigas. Dados inválidos não são sobrescritos; uma cópia
// fica em groovegoblin.session.v2.recovery e o texto volta em recoveryRaw.
export function loadSession(storage) {
  let raw;
  try {
    storage ??= globalThis.localStorage;
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return {
      session: createSession(), warnings: ['Não foi possível acessar o armazenamento local; usando padrões.'],
      recoveryRaw: null, storageAvailable: false,
    };
  }
  const warnings = [];
  if (raw == null) {
    try {
      const { session, recoveryRaw } = readLegacy(storage, warnings);
      return { session, warnings, recoveryRaw, storageAvailable: true };
    } catch {
      return { session: createSession(), warnings: ['Dados antigos ilegíveis; usando padrões.'], recoveryRaw: null, storageAvailable: true };
    }
  }
  const parsed = safeParse(raw);
  const result = parsed === undefined ? { ok: false, error: 'JSON inválido.' } : validateSession(parsed);
  if (result.ok) return { session: result.session, warnings, recoveryRaw: null, storageAvailable: true };
  let backedUp = false;
  try {
    storage.setItem(RECOVERY_KEY, raw);
    backedUp = true;
  } catch {
    backedUp = false;
  }
  warnings.push(`Sessão salva inválida (${result.error}); usando padrões.${backedUp ? ' Uma cópia do original foi guardada para recuperação.' : ''}`);
  return { session: createSession(), warnings, recoveryRaw: raw, storageAvailable: true };
}

export function saveSession(session, storage) {
  const result = validateSession(session);
  if (!result.ok) return false;
  try {
    storage ??= globalThis.localStorage;
    storage.setItem(STORAGE_KEY, JSON.stringify(result.session));
    return true;
  } catch {
    return false;
  }
}

// ----- Arquivo e link ------------------------------------------------------

export function serializeSession(session) {
  const result = validateSession(session);
  if (!result.ok) throw new TypeError(result.error);
  return JSON.stringify({ format: SESSION_FORMAT, version: SESSION_VERSION, session: result.session }, null, 2);
}

function fromLegacy({ notes, bpm, bars }) {
  return createSession({ notes: notes.map(completeNote), bpm, bars });
}

// Importação atômica e estrita; aceita também frases v1 (groovegoblin-phrase).
export function parseSession(text) {
  if (typeof text !== 'string') throw new TypeError('O conteúdo da sessão deve ser um texto JSON.');
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new TypeError('Não foi possível ler o arquivo: o JSON é inválido.');
  }
  if (isObject(document) && document.format === 'groovegoblin-phrase') {
    const legacy = parsePhrase(text);
    if (!legacy.ok) throw new TypeError(legacy.error);
    return fromLegacy(legacy);
  }
  if (isObject(document) && !Object.hasOwn(document, 'format')) {
    const result = validateSession(document);
    if (!result.ok) throw new TypeError(result.error);
    return result.session;
  }
  if (!isObject(document) || Object.keys(document).some(key => !['format', 'version', 'session'].includes(key))) {
    throw new TypeError('O arquivo deve conter apenas os campos de uma sessão do GrooveGoblin.');
  }
  if (document.format !== SESSION_FORMAT) throw new TypeError('O arquivo não está no formato de sessão do GrooveGoblin.');
  if (![2, 3, SESSION_VERSION].includes(document.version) || document.session?.version !== document.version) {
    throw new TypeError('A versão do arquivo de sessão não é compatível.');
  }
  const result = validateSession(document.session);
  if (!result.ok) throw new TypeError(result.error);
  return result.session;
}

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(encoded) {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new TypeError('Não foi possível ler o link: a codificação é inválida.');
  const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (encoded.length % 4)) % 4);
  let binary;
  try {
    binary = atob(base64);
  } catch {
    throw new TypeError('Não foi possível ler o link: a codificação é inválida.');
  }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError('Não foi possível ler o link: a codificação é inválida.');
  }
}

// Fragmento '#session=<base64url(JSON)>' — o consumidor compõe a URL.
export function encodeSessionLink(session) {
  const result = validateSession(session);
  if (!result.ok) throw new TypeError(result.error);
  const hash = LINK_PREFIX + toBase64Url(JSON.stringify(result.session));
  if (hash.length > LINK_MAX_LENGTH) throw new RangeError(`A sessão excede o limite de ${LINK_MAX_LENGTH} caracteres do link.`);
  return hash;
}

export function decodeSessionLink(hash) {
  if (typeof hash === 'string' && hash.startsWith('#phrase=')) {
    const legacy = parseShare(hash);
    if (!legacy.ok) throw new TypeError(legacy.error);
    return fromLegacy(legacy);
  }
  if (typeof hash !== 'string' || !hash.startsWith(LINK_PREFIX)) {
    throw new TypeError('O fragmento não contém um link de sessão reconhecido.');
  }
  if (hash.length > LINK_MAX_LENGTH) throw new TypeError(`O link excede o limite de ${LINK_MAX_LENGTH} caracteres.`);
  const parsed = safeParse(fromBase64Url(hash.slice(LINK_PREFIX.length)));
  if (parsed === undefined) throw new TypeError('Não foi possível ler o link: o conteúdo é inválido.');
  const result = validateSession(parsed);
  if (!result.ok) throw new TypeError(result.error);
  return result.session;
}
