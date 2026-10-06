// A2 — Gerador de estudos por receita (puro).
// Receita serializável -> notas com corda/casa + avisos. Sem DOM, sem sessão
// persistida, sem curso: a receita vive FORA da sessão (A4 guarda em arquivo/
// estado do Estúdio). "Forma" aqui é forma de digitação (offsets em corda/casa),
// conceito distinto de `song-form.js`/`form.js` (seções de música), que não são
// usados por este módulo.
//
// Coordenadas: 4 ticks = semínima, 16 ticks = compasso (4/4 fixo), como
// `meter.TICKS_PER_QUARTER`/`model.TICKS_PER_BAR`. Corda 1 = mais aguda
// (`tablature.stringPitch`); a numeração é estável entre baixo 4 e 5 cordas
// (o baixo 5 acrescenta a corda 5 = Si grave), então uma forma de 4 cordas é
// reutilizável no baixo 5 — inclusive descendo um jogo de cordas até a Si.
//
// Toda função é pura: nada muta a entrada; a receita normalizada é congelada.
// `notes[].fret`/`notes[].string` são DERIVADOS (posição na região) e `fret`
// não é campo canônico de `model.NOTE_KEYS` — use `canonicalNotes(result)`
// antes de validar/persistir numa sessão v5.

import { CHORD_QUALITIES, PROGRESSION_KEYS, chordTimeline, parseChordSymbol } from './progression.js';
import { formatInstrumentNote, normalizeInstrumentProfile, standardInstrumentProfile } from './instrument-profile.js';

export const STUDY_TICKS_PER_QUARTER = 4;
export const STUDY_TICKS_PER_BAR = 16;
export const STUDY_MAX_NOTES = 512; // espelha session.MAX_NOTES (avisa, nunca descarta)
export const STUDY_MAX_BARS = 128; // teto do período/voltas (para com aviso)
export const STUDY_MIN_FRET = 0;
export const STUDY_MAX_FRET = 24; // espelha tablature.MAX_TAB_FRET
export const STUDY_VERSION = 1;
export const STUDY_MAX_VOLTAS = 64;
// Compassos por bloco digitáveis; os percursos aceitam o mínimo derivado
// (a escada inteira de um acorde pode pedir mais de 4), até 128.
export const STUDY_MAX_FIGURE_BARS = 4;
export const STUDY_MAX_PERCURSO_FIGURE_BARS = 128;
export const STUDY_PERIOD = 'periodo'; // voltas:'periodo' = até o estado do início da volta voltar

export const STUDY_REGION_DEFAULT = Object.freeze({ from: 1, to: 12, open: false, strings: null });

export const STUDY_QUALITIES = Object.freeze(['major', 'minor', 'aug', 'dim', 'maj7', 'm7', '7', 'm7b5', 'dim7']);
export const STUDY_QUALITY_IDS = Object.freeze({ major: '', minor: 'm', aug: 'aug', dim: 'dim', maj7: 'maj7', m7: 'm7', 7: '7', m7b5: 'm7b5', dim7: 'dim7' });
export const STUDY_QUALITY_LABELS = Object.freeze({
  major: 'maior', minor: 'menor', aug: 'aumentado', dim: 'diminuto', maj7: 'maior com sétima maior',
  m7: 'menor com sétima', 7: 'dominante com sétima', m7b5: 'meio diminuto', dim7: 'diminuto com sétima',
});
export const STUDY_PROGRESSIONS = Object.freeze(['quartas', 'quintas', 'cromatica', 'lista', 'sessao']);
export const STUDY_RHYTHMS = Object.freeze(['quarters', 'eighths', 'arpejo']);
export const STUDY_ORDERS = Object.freeze(['sobe', 'desce', 'sobe-desce', 'desce-sobe']);
export const STUDY_FINALS = Object.freeze(['nenhum', 'acorde', 'tonica']);
export const STUDY_FAMILIES = Object.freeze([
  'arpejo_triade_forma_unica',
  'arpejo_triade_formas_combinadas',
  'arpejo_tres_inversoes_por_acorde',
  'movimento_continuo_linha_4_notas',
  'movimento_continuo_grave_agudo_grave',
  'movimento_continuo_agudo_grave_agudo',
]);
export const STUDY_WARNING_CODES = Object.freeze([
  'aumentar-compassos', 'sem-posicao', 'limite-128', 'notas-acima-de-512', 'forma-divergente', 'forma-nao-aplicada',
]);
// Famílias cujo resultado depende de uma FORMA escolhida (o autor digita uma
// forma; o gerador não pode inventar uma e alegar correspondência).
export const STUDY_SHAPE_FAMILIES = Object.freeze([
  'arpejo_triade_forma_unica', 'arpejo_triade_formas_combinadas', 'arpejo_tres_inversoes_por_acorde',
]);
export const STUDY_CONTINUOUS_FAMILIES = Object.freeze([
  'movimento_continuo_linha_4_notas', 'movimento_continuo_grave_agudo_grave', 'movimento_continuo_agudo_grave_agudo',
]);
// Percursos: cada acorde toca TODAS as notas da escada, ida e volta.
export const STUDY_PERCURSO_FAMILIES = Object.freeze(['movimento_continuo_grave_agudo_grave', 'movimento_continuo_agudo_grave_agudo']);

// Teto de `figure.bars` por família (contrato da UI: o máximo é dinâmico).
export function maxFigureBars(family) {
  return STUDY_PERCURSO_FAMILIES.includes(family) ? STUDY_MAX_PERCURSO_FIGURE_BARS : STUDY_MAX_FIGURE_BARS;
}

const HARMONIC_FAMILIES = STUDY_SHAPE_FAMILIES;
const CONTINUOUS_FAMILIES = STUDY_CONTINUOUS_FAMILIES;
const PERCURSO_ORDER = Object.freeze({ movimento_continuo_grave_agudo_grave: 'sobe-desce', movimento_continuo_agudo_grave_agudo: 'desce-sobe' });
const DEGREE_STEPS = Object.freeze({ 1: [1, 0], 3: [3, 0], 5: [5, 0], 7: [7, 0], 8: [1, 1], 10: [3, 1], 12: [5, 1], 14: [7, 1] });
const DEGREE_LABELS = Object.freeze({ 1: 'Tônica', 3: 'Terça', 5: 'Quinta', 7: 'Sétima', 8: 'Tônica (oitava)', 10: 'Terça (oitava)', 12: 'Quinta (oitava)', 14: 'Sétima (oitava)' });
const ROLE_LABELS = Object.freeze({ 0: 'Tônica', 3: 'Terça menor', 4: 'Terça maior', 6: 'Quinta diminuta', 7: 'Quinta justa', 8: 'Quinta aumentada', 9: 'Sétima diminuta', 10: 'Sétima menor', 11: 'Sétima maior' });
const CYCLE_STEPS = Object.freeze({ quartas: 5, quintas: 7, cromatica: 1 });
const SHARP_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);
const FLAT_NAMES = Object.freeze(['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']);
// Qualidades de terça menor: grafia do modo menor do app.
const MINOR_THIRD_QUALITIES = Object.freeze(['minor', 'dim', 'm7', 'm7b5', 'dim7']);
const modeOf = quality => (MINOR_THIRD_QUALITIES.includes(quality) ? 'minor' : 'major');
// Grafia que o app já usa (tônica das tonalidades de `progression.js`).
function tonicName(pitchClass, mode = 'major') {
  return PROGRESSION_KEYS.find(key => key.mode === mode && key.pitchClass === pitchClass).tonic;
}
// Só um acidente: os nomes precisam existir para `progression.parseChordSymbol`.
const NOTE_PATTERN = /^([A-G])([#b]?)(-?\d+)?$/;
const NATURALS = [0, 2, 4, 5, 7, 9, 11];
const POSITION_WINDOW = 4096; // teto de combinações da busca exaustiva de posições
const OCTAVE_SHIFTS = Object.freeze([-3, -2, -1, 0, 1, 2, 3]);
const STRING_PENALTY = 25; // nota fora das cordas da região pesa mais que qualquer casa
const MAX_FIGURE_DEGREES = 8;
const PERIOD_TURN_LIMIT = 1024;

const mod12 = value => ((value % 12) + 12) % 12;

// ---------------------------------------------------------------- utilidades

export function noteName(pitch, { octave = true, flats = false, solfege = false } = {}) {
  return formatInstrumentNote(pitch, { noteNames: solfege ? 'solfege' : 'letters' }, { octave, flats });
}

function parseNote(value) {
  const match = NOTE_PATTERN.exec(String(value ?? '').trim().replaceAll('♯', '#').replaceAll('♭', 'b'));
  if (!match) return null;
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
  return { name: match[1] + match[2], pitchClass: mod12(NATURALS['CDEFGAB'.indexOf(match[1])] + accidental), octave: match[3] ?? null };
}

function pitchClassOf(name) {
  const parsed = parseNote(name);
  if (!parsed || parsed.octave !== null) throw new TypeError(`Nota desconhecida: "${String(name).slice(0, 16)}". Use, por exemplo, C, F# ou Bb.`);
  return parsed.pitchClass;
}

function qualityTones(quality) {
  return CHORD_QUALITIES[STUDY_QUALITY_IDS[quality]].map(([semitone], index) => ({ degree: [1, 3, 5, 7][index], semitone }));
}

// Terça/quinta/sétima ausentes em tríades: estende a qualidade, como
// instrument-patterns.degreeInterval (nunca inventa altura arbitrária).
function extendSemitone(quality, degree, tones) {
  if (degree !== 7) throw new TypeError(`A qualidade ${quality} não tem o grau ${degree}.`);
  if (quality === 'dim') return 9;
  return tones.some(tone => tone.degree === 3 && tone.semitone === 3) ? 10 : 11;
}

function degreeSemitone(quality, degree) {
  const step = DEGREE_STEPS[degree];
  if (!step) throw new TypeError(`Grau ${degree} não suportado; use 1, 3, 5, 7, 8, 10, 12 ou 14.`);
  const [base, octave] = step;
  const tones = qualityTones(quality);
  const tone = tones.find(item => item.degree === base);
  return (tone ? tone.semitone : extendSemitone(quality, base, tones)) + 12 * octave;
}

// Grau uma oitava acima (1 -> 8 ... 7 -> 14); acima de 14 fica o grau-base.
function degreeAbove(degree) {
  return degree <= 7 ? degree + 7 : DEGREE_STEPS[degree][0];
}

// Âncora da forma: a tônica (grau 1) ou, sem ela, a oitava (grau 8) — o
// editor de formas (A3) aceita a raiz escrita como grau 8.
const isRootDegree = degree => degree === 1 || degree === 8;
function shapeAnchor(notes) {
  return notes.find(note => note.degree === 1) ?? notes.find(note => note.degree === 8) ?? null;
}

function normalizeDegreeList(list) {
  if (!Array.isArray(list) || list.length === 0) throw new TypeError('Informe ao menos um grau para a figura.');
  if (list.length > MAX_FIGURE_DEGREES) throw new TypeError(`A figura aceita até ${MAX_FIGURE_DEGREES} graus.`);
  list.forEach(degree => {
    if (!Number.isInteger(degree) || !DEGREE_STEPS[degree]) throw new TypeError(`Grau ${degree} não suportado; use 1, 3, 5, 7, 8, 10, 12 ou 14.`);
  });
  if (new Set(list).size !== list.length) throw new TypeError('Os graus da figura não podem se repetir; use a ordem (sobe-desce, desce-sobe) para voltar.');
  return Object.freeze([...list]);
}

function compares(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

// ------------------------------------------------------------------ receita

function normalizeProfile(value) {
  if (value === undefined || value === null) return Object.freeze(standardInstrumentProfile('bass', 4));
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('O perfil do instrumento deve ser um objeto.');
  const keys = Object.keys(value);
  if (keys.includes('tuning')) return Object.freeze(normalizeInstrumentProfile(value));
  if (keys.some(key => !['type', 'strings', 'noteNames'].includes(key))) throw new TypeError('Campo desconhecido no perfil do instrumento.');
  const type = value.type ?? 'bass';
  const strings = value.strings ?? (type === 'bass' ? 4 : 6);
  const profile = standardInstrumentProfile(type, strings);
  return Object.freeze({ ...profile, noteNames: value.noteNames ?? 'letters' });
}

function normalizeRegion(value) {
  if (value === undefined || value === null) return STUDY_REGION_DEFAULT;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('A região deve ser um objeto {from,to}.');
  const unknown = Object.keys(value).filter(key => !['from', 'to', 'open', 'strings'].includes(key));
  if (unknown.length) throw new TypeError(`Campo desconhecido na região: ${unknown[0]}.`);
  const from = value.from ?? STUDY_REGION_DEFAULT.from;
  const to = value.to ?? STUDY_REGION_DEFAULT.to;
  const open = value.open === true;
  const strings = value.strings === undefined || value.strings === null ? null : value.strings;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < STUDY_MIN_FRET || to > STUDY_MAX_FRET) throw new TypeError(`A região deve usar casas entre ${STUDY_MIN_FRET} e ${STUDY_MAX_FRET}.`);
  if (from > to) throw new TypeError('A região precisa de uma casa inicial menor ou igual à final.');
  if (!open && from < 1) throw new TypeError('A região sem cordas soltas começa na casa 1; use open:true para admitir a casa 0.');
  if (strings !== null && (!Array.isArray(strings) || strings.length === 0 || strings.some(item => !Number.isInteger(item) || item < 1 || item > 8) || new Set(strings).size !== strings.length)) {
    throw new TypeError('A região deve listar cordas distintas, da 1 (mais aguda) à mais grave.');
  }
  return Object.freeze({ from, to, open, strings: strings ? Object.freeze([...strings].sort((a, b) => a - b)) : null });
}

function normalizeShape(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('A forma deve ser um objeto.');
  const unknown = Object.keys(value).filter(key => !['quality', 'degrees', 'notes', 'id', 'label'].includes(key));
  if (unknown.length) throw new TypeError(`Campo desconhecido na forma: ${unknown[0]}.`);
  const quality = value.quality ?? 'major';
  if (!STUDY_QUALITIES.includes(quality)) throw new TypeError('Qualidade de forma inválida.');
  if (!Array.isArray(value.notes) || value.notes.length === 0) throw new TypeError('A forma precisa de notas com corda, casa e grau.');
  const notes = value.notes.map(entry => {
    if (!entry || typeof entry !== 'object' || !Number.isInteger(entry.string) || entry.string < 1 || entry.string > 8
      || !Number.isInteger(entry.fret) || entry.fret < STUDY_MIN_FRET || entry.fret > STUDY_MAX_FRET || !DEGREE_STEPS[entry.degree]) {
      throw new TypeError('Cada nota da forma precisa de corda (1..8), casa (0..24) e grau válido.');
    }
    return Object.freeze({ string: entry.string, fret: entry.fret, degree: entry.degree });
  });
  if (!notes.some(note => isRootDegree(note.degree))) throw new TypeError('A forma precisa de uma âncora na tônica (grau 1 ou 8).');
  if (new Set(notes.map(note => `${note.string}:${note.fret}`)).size !== notes.length) throw new TypeError('A forma repete a mesma corda/casa.');
  // `degrees` é a ORDEM da figura escolhida no Braço (A3); sem ela, a ordem
  // dos graus (T-3-5). Todo grau listado precisa de uma nota na forma.
  const present = [...new Set(notes.map(note => note.degree))].sort((a, b) => a - b);
  let degrees = present;
  if (value.degrees !== undefined && value.degrees !== null) {
    degrees = [...normalizeDegreeList(value.degrees)];
    const missing = degrees.find(degree => !present.includes(degree));
    if (missing !== undefined) throw new TypeError(`A forma lista o grau ${missing}, mas nenhuma nota tem esse grau.`);
  }
  return Object.freeze({ id: value.id ?? null, label: value.label ?? null, quality, degrees: Object.freeze(degrees), notes: Object.freeze(notes) });
}

function normalizeShapes(value) {
  const single = normalizeShape(value.shape);
  if (value.shapes === undefined || value.shapes === null) return single ? Object.freeze([single]) : null;
  if (!Array.isArray(value.shapes) || value.shapes.length === 0 || value.shapes.length > 4) throw new TypeError('As formas (shapes) devem ser uma lista de 1 a 4 formas.');
  const shapes = Object.freeze(value.shapes.map(normalizeShape));
  if (single && JSON.stringify(single) !== JSON.stringify(shapes[0])) throw new TypeError('shape deve ser igual a shapes[0]; informe só um dos dois.');
  return shapes;
}

// Entrada de acorde da lista: nome da fundamental (usa a qualidade da
// progressão), cifra completa ('Am7'), classe de altura ou {root,quality,name}.
function normalizeChordEntry(entry, quality) {
  if (typeof entry === 'string') {
    const bare = parseNote(entry);
    if (bare && bare.octave === null) return Object.freeze({ root: bare.pitchClass, quality, name: bare.name });
    let chord;
    try { chord = parseChordSymbol(entry); } catch { throw new TypeError(`Acorde desconhecido na lista: "${entry.slice(0, 16)}".`); }
    if (chord.bass !== null && chord.bass !== chord.root) throw new TypeError('Acordes com baixo invertido (C/E) não entram no estudo; use a fundamental.');
    return Object.freeze({ root: chord.root, quality: chordQualityOf(chord.quality), name: /^[A-G][#b]?/.exec(chord.symbol)[0] });
  }
  if (Number.isInteger(entry) && entry >= 0 && entry <= 11) return Object.freeze({ root: entry, quality, name: null });
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('Cada acorde da lista deve ser um nome, uma cifra ou um objeto {root,quality}.');
  const unknown = Object.keys(entry).filter(key => !['root', 'quality', 'name'].includes(key));
  if (unknown.length) throw new TypeError(`Campo desconhecido no acorde: ${unknown[0]}.`);
  const itemQuality = entry.quality ?? quality;
  if (!STUDY_QUALITIES.includes(itemQuality)) throw new TypeError(`Qualidade desconhecida no acorde: ${itemQuality}.`);
  const root = Number.isInteger(entry.root) && entry.root >= 0 && entry.root <= 11 ? entry.root : pitchClassOf(entry.root);
  let name = typeof entry.root === 'string' ? parseNote(entry.root).name : null;
  if (entry.name !== undefined && entry.name !== null) {
    const typed = parseNote(entry.name);
    if (!typed || typed.octave !== null || typed.pitchClass !== root) throw new TypeError('O nome do acorde precisa grafar a mesma fundamental.');
    name = typed.name;
  }
  return Object.freeze({ root, quality: itemQuality, name });
}

function normalizeProgression(value) {
  if (value === undefined || value === null) return Object.freeze({ kind: 'quartas', start: 'C', direction: 'ascendente', quality: 'major', chords: Object.freeze([]), length: null, spelling: 'auto' });
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('A progressão deve ser um objeto.');
  const unknown = Object.keys(value).filter(key => !['kind', 'start', 'direction', 'quality', 'chords', 'length', 'spelling'].includes(key));
  if (unknown.length) throw new TypeError(`Campo desconhecido na progressão: ${unknown[0]}.`);
  const kind = value.kind ?? 'quartas';
  if (!STUDY_PROGRESSIONS.includes(kind)) throw new TypeError(`Progressão desconhecida: ${kind}.`);
  const quality = value.quality ?? 'major';
  if (!STUDY_QUALITIES.includes(quality)) throw new TypeError(`Qualidade desconhecida: ${quality}.`);
  const direction = value.direction ?? 'ascendente';
  if (!['ascendente', 'descendente'].includes(direction)) throw new TypeError('A direção da progressão deve ser ascendente ou descendente.');
  const spelling = value.spelling ?? 'auto';
  if (!['auto', 'sustenidos', 'bemois'].includes(spelling)) throw new TypeError('A grafia deve ser auto, sustenidos ou bemóis.');
  // Nota inicial: oitava opcional (só a classe de altura importa) e validada aqui.
  const startValue = value.start ?? 'C';
  const start = Number.isInteger(startValue) && startValue >= 0 && startValue <= 11 ? tonicName(startValue, modeOf(quality)) : parseNote(startValue)?.name;
  if (!start) throw new TypeError(`Nota inicial desconhecida: "${String(startValue).slice(0, 16)}". Use, por exemplo, C, F#, Bb ou C2.`);
  const chords = value.chords ?? [];
  if (!Array.isArray(chords)) throw new TypeError('A lista de acordes deve ser um vetor.');
  if (chords.length > STUDY_MAX_VOLTAS) throw new TypeError(`A lista aceita até ${STUDY_MAX_VOLTAS} acordes.`);
  const entries = chords.map(entry => normalizeChordEntry(entry, quality));
  const length = value.length ?? null;
  if (length !== null && (!Number.isInteger(length) || length < 1 || length > 64)) throw new TypeError('O tamanho do ciclo deve ser um inteiro de 1 a 64.');
  if (kind === 'lista' && entries.length === 0) throw new TypeError('A progressão "lista" precisa ao menos de um acorde.');
  if (length !== null && CYCLE_STEPS[kind] && length > 12) throw new TypeError('O ciclo de quartas/quintas/cromático tem 12 acordes; length não pode ser maior.');
  if (length !== null && kind === 'lista' && length > entries.length) throw new TypeError(`A lista tem ${entries.length} acorde(s); length não pode ser maior.`);
  return Object.freeze({ kind, start, direction, quality, chords: Object.freeze(entries), length, spelling });
}

export function normalizeRecipe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('A receita deve ser um objeto.');
  const unknown = Object.keys(value).filter(key => !['version', 'family', 'profile', 'progression', 'bars', 'region', 'shape', 'shapes', 'figure', 'rhythm', 'voltas', 'final'].includes(key));
  if (unknown.length) throw new TypeError(`Campo desconhecido na receita: ${unknown[0]}.`);
  if ((value.version ?? STUDY_VERSION) !== STUDY_VERSION) throw new TypeError(`A versão da receita deve ser ${STUDY_VERSION}.`);
  const family = value.family ?? 'arpejo_triade_forma_unica';
  if (!STUDY_FAMILIES.includes(family)) throw new TypeError(`Família desconhecida: ${family}.`);
  const profile = normalizeProfile(value.profile);
  const progression = normalizeProgression(value.progression);
  const region = normalizeRegion(value.region);
  const shapes = normalizeShapes(value);
  const harmonic = HARMONIC_FAMILIES.includes(family);
  if (shapes && shapes.some(shape => shape.quality !== progression.quality)) throw new TypeError('A qualidade da forma e da progressão precisam ser iguais.');
  if (shapes && !harmonic) throw new TypeError('O movimento contínuo percorre a região; forma de digitação vale só para os arpejos.');
  if (shapes && family === 'arpejo_triade_forma_unica' && shapes.length > 1) throw new TypeError('A forma única usa exatamente uma forma.');
  if (shapes && progression.chords.some(chord => chord.quality !== progression.quality)) throw new TypeError('Com forma de digitação, todos os acordes da lista precisam da qualidade da forma.');
  const figure = value.figure ?? {};
  if (typeof figure !== 'object' || Array.isArray(figure)) throw new TypeError('A figura deve ser um objeto.');
  const unknownFigure = Object.keys(figure).filter(key => !['degrees', 'inversions', 'notes', 'order', 'bars'].includes(key));
  if (unknownFigure.length) throw new TypeError(`Campo desconhecido na figura: ${unknownFigure[0]}.`);
  const familyOrder = PERCURSO_ORDER[family] ?? null;
  const order = figure.order ?? familyOrder ?? 'sobe';
  if (!STUDY_ORDERS.includes(order)) throw new TypeError(`Ordem desconhecida: ${order}.`);
  if (familyOrder && order !== familyOrder) throw new TypeError(`A família ${family} percorre ${familyOrder}; a ordem não pode mudar.`);
  // null = padrão da família: contínuo usa todos os graus do acorde vigente;
  // arpejo com forma toca na ordem `shape.degrees` da forma usada no acorde.
  let degrees = null;
  if (figure.degrees !== undefined && figure.degrees !== null) degrees = normalizeDegreeList(figure.degrees);
  else if (harmonic && !shapes) degrees = Object.freeze(qualityTones(progression.quality).map(tone => tone.degree));
  const inverts = family === 'arpejo_tres_inversoes_por_acorde';
  if (inverts && degrees && degrees.some(degree => degree > 7)) throw new TypeError('As inversões giram os graus-base (1, 3, 5, 7); a oitava é gerada.');
  const defaultRhythm = harmonic ? 'arpejo' : 'quarters';
  const rhythm = value.rhythm ?? defaultRhythm;
  if (!STUDY_RHYTHMS.includes(rhythm)) throw new TypeError(`Ritmo desconhecido: ${rhythm}.`);
  if (!harmonic && rhythm === 'arpejo') throw new TypeError('O movimento contínuo usa semínimas (quarters) ou colcheias (eighths).');
  // Arpejo: q q h | h ligada + pausa h (2 compassos); as três inversões têm
  // um compasso cada (q q h).
  const figureBars = figure.bars ?? (rhythm === 'arpejo' ? (inverts ? 1 : 2) : null);
  const maxFigure = maxFigureBars(family);
  if (figureBars !== null && (!Number.isInteger(figureBars) || figureBars < 1 || figureBars > maxFigure)) throw new TypeError(`Os compassos da figura devem ser um inteiro de 1 a ${maxFigure} (ou null para automático).`);
  const bars = value.bars === undefined ? null : value.bars;
  if (bars !== null && (!Number.isInteger(bars) || bars < 1 || bars > STUDY_MAX_BARS)) throw new TypeError(`A receita pede de 1 a ${STUDY_MAX_BARS} compassos (ou bars:null para automático).`);
  const voltas = value.voltas ?? 1;
  if (voltas !== STUDY_PERIOD && (!Number.isInteger(voltas) || voltas < 1 || voltas > STUDY_MAX_VOLTAS)) throw new TypeError(`As voltas devem ser um inteiro de 1 a ${STUDY_MAX_VOLTAS} ou "${STUDY_PERIOD}".`);
  // Padrão do pedido: "repetir o primeiro acorde no fim" = sim.
  const final = value.final ?? 'tonica';
  if (!STUDY_FINALS.includes(final)) throw new TypeError('O final deve ser nenhum, acorde ou tonica.');
  const several = shapes && shapes.length > 1 ? shapes.length : null;
  const notes = figure.notes ?? 4;
  const inversions = figure.inversions ?? (family === 'arpejo_tres_inversoes_por_acorde' && several ? several : 3);
  if (!Number.isInteger(notes) || notes < 1 || notes > 32) throw new TypeError('As notas por acorde devem ser um inteiro de 1 a 32.');
  if (!Number.isInteger(inversions) || inversions < 1 || inversions > 4) throw new TypeError('As inversões devem ser um inteiro de 1 a 4.');
  if (several && family === 'arpejo_tres_inversoes_por_acorde' && inversions !== several) throw new TypeError('Com várias formas, cada inversão usa uma forma: inversions deve ser igual ao número de formas.');
  return Object.freeze({
    version: STUDY_VERSION, family, profile, progression, bars, region, shape: shapes ? shapes[0] : null, shapes,
    figure: Object.freeze({ degrees, inversions, notes, order, bars: figureBars }),
    rhythm, voltas, final,
  });
}

export function defaultRecipe(overrides = {}) {
  return normalizeRecipe({ version: STUDY_VERSION, ...overrides });
}

// ------------------------------------------------------------------ acordes

function chordRecord(root, quality, rootName) {
  const tones = qualityTones(quality);
  return Object.freeze({
    root, rootName, quality, symbol: `${rootName}${STUDY_QUALITY_IDS[quality]}`,
    label: `${rootName} ${STUDY_QUALITY_LABELS[quality]}`,
    degrees: Object.freeze(tones.map(tone => Object.freeze({
      degree: tone.degree, semitone: tone.semitone, label: DEGREE_LABELS[tone.degree], role: ROLE_LABELS[tone.semitone],
    }))),
  });
}

const QUALITY_FROM_ID = Object.freeze(Object.fromEntries(Object.entries(STUDY_QUALITY_IDS).map(([name, id]) => [id, name])));

function chordQualityOf(qualityId) {
  const name = QUALITY_FROM_ID[qualityId];
  if (!name) throw new TypeError(`Qualidade de acorde sem receita no gerador de estudo: ${qualityId}.`);
  return name;
}

// Grafia: nome digitado na lista/sessão é mantido; `spelling` explícito
// (bemois/sustenidos) vale para o resto; no automático, o ciclo de quartas
// MAIOR (= quintas descendentes) usa bemóis (C F Bb Eb Ab Db Gb B E A D G) e
// todo o resto usa a grafia de tonalidade do app (`PROGRESSION_KEYS`), no modo
// menor para qualidades de terça menor.
function spellRoot(progression, pitchClass, quality, typed = null) {
  if (typed) return typed;
  if (progression.spelling === 'bemois') return FLAT_NAMES[pitchClass];
  if (progression.spelling === 'sustenidos') return SHARP_NAMES[pitchClass];
  const descending = progression.direction === 'descendente';
  const flatCycle = (progression.kind === 'quartas' && !descending) || (progression.kind === 'quintas' && descending);
  if (flatCycle && modeOf(quality) === 'major') return FLAT_NAMES[pitchClass];
  return tonicName(pitchClass, modeOf(quality));
}

// Ciclo de acordes da receita (uma volta, sem repetir). `sessao` lê o ciclo da
// progressão da sessão; a grade do estudo continua 4/4.
export function chordCycle(recipe, { session = null } = {}) {
  const normalized = normalizeRecipe(recipe);
  const { progression } = normalized;
  if (progression.kind === 'lista' || progression.kind === 'sessao') {
    const listed = progression.kind === 'sessao' ? sessionChords(session, progression) : progression.chords;
    const length = progression.length ?? listed.length;
    if (length > listed.length) throw new TypeError(`O ciclo da progressão tem ${listed.length} acorde(s); length não pode ser maior.`);
    return Object.freeze(listed.slice(0, length).map(entry => chordRecord(entry.root, entry.quality, spellRoot(progression, entry.root, entry.quality, entry.name))));
  }
  const step = (progression.direction === 'descendente' ? -1 : 1) * CYCLE_STEPS[progression.kind];
  const start = pitchClassOf(progression.start);
  const length = progression.length ?? 12;
  return Object.freeze(Array.from({ length }, (_, index) => {
    const pitchClass = mod12(start + index * step);
    return chordRecord(pitchClass, progression.quality, spellRoot(progression, pitchClass, progression.quality));
  }));
}

function sessionChords(session, progression) {
  if (progression.chords.length) return progression.chords;
  if (!session || !Array.isArray(session.progression?.chords)) throw new TypeError('A progressão "sessao" precisa da sessão (ou de uma lista de acordes) para gerar o estudo.');
  const chords = [];
  for (const event of chordTimeline(session)) {
    const previous = chords[chords.length - 1];
    if (previous && previous.root === event.chord.root && previous.quality === chordQualityOf(event.chord.quality)) continue;
    const typed = typeof event.chord.symbol === 'string' ? /^[A-G][#b]?/.exec(event.chord.symbol)?.[0] ?? null : null;
    chords.push(Object.freeze({ root: event.chord.root, quality: chordQualityOf(event.chord.quality), name: typed && pitchClassOf(typed) === event.chord.root ? typed : null }));
  }
  if (chords.length === 0) throw new TypeError('A sessão não tem progressão ativa para gerar o estudo.');
  return chords;
}

// ------------------------------------------------------------------ posição

// Helpers públicos aceitam perfil completo ou atalho {type,strings}.
function asProfile(profile) {
  return profile && Array.isArray(profile.tuning) ? profile : normalizeProfile(profile);
}

// Região parcial (helpers públicos) sem lançar: completa com os padrões.
function asRegion(region) {
  const value = region ?? STUDY_REGION_DEFAULT;
  return {
    from: Number.isInteger(value.from) ? value.from : STUDY_REGION_DEFAULT.from,
    to: Number.isInteger(value.to) ? value.to : STUDY_REGION_DEFAULT.to,
    open: value.open === true,
    strings: Array.isArray(value.strings) && value.strings.length ? value.strings : null,
  };
}

function stringOpen(profile, string) { return profile.tuning[profile.strings - string]; }

function allowedStrings(profile, strings) {
  return strings ? strings.filter(string => string <= profile.strings) : Array.from({ length: profile.strings }, (_, index) => index + 1);
}

function lowFret(region) { return region.open ? region.from : Math.max(1, region.from); }

function fretDistance(fret, region) {
  const low = lowFret(region);
  return fret < low ? low - fret : fret > region.to ? fret - region.to : 0;
}

function inRegion(position, region) {
  return fretDistance(position.fret, region) === 0 && (!region.strings || region.strings.includes(position.string));
}

function positionsFor(profile, pitch, bounds) {
  const found = [];
  for (const string of allowedStrings(profile, bounds.strings)) {
    const fret = pitch - stringOpen(profile, string);
    if (fret < bounds.from || fret > bounds.to || (!bounds.open && fret < 1)) continue;
    found.push(Object.freeze({ string, fret, pitch }));
  }
  return found;
}

const lowestPosition = (best, item) => (item.fret < best.fret || (item.fret === best.fret && item.string > best.string) ? item : best);

// Posição mais grave/menor casa: casa mínima; empate resolve pela corda mais
// grave (número maior = altura menor).
export function choosePosition(value, pitch, region) {
  const found = positionsFor(asProfile(value), pitch, asRegion(region));
  return found.length ? found.reduce(lowestPosition) : null;
}

// Melhor combinação de posições (uma por altura) pela pontuação dada; acima do
// teto de combinações, cai para a menor casa de cada altura.
function combine(lists, score) {
  if (lists.reduce((total, list) => total * list.length, 1) > POSITION_WINDOW) {
    const positions = lists.map(list => list.reduce(lowestPosition));
    return { positions, score: score(positions) };
  }
  let best = null;
  const chosen = [];
  const pick = index => {
    if (index === lists.length) {
      const value = score(chosen);
      if (best === null || compares(value, best.score) < 0) best = { score: value, positions: [...chosen] };
      return;
    }
    for (const candidate of lists[index]) { chosen.push(candidate); pick(index + 1); chosen.pop(); }
  };
  pick(0);
  return best;
}

function fretSpan(positions) {
  const frets = positions.map(item => item.fret);
  return { min: Math.min(...frets), max: Math.max(...frets), sum: frets.reduce((total, fret) => total + fret, 0) };
}

// Mão compacta: menor casa máxima, menor abertura, menor soma; empate mais grave.
function compactScore(positions) {
  const { min, max, sum } = fretSpan(positions);
  return [max, max - min, sum, -Math.max(...positions.map(item => item.string))];
}

// Região mínima que contém as posições (cordas = as da região + as usadas).
function expansionOf(region, positions) {
  const { min, max } = fretSpan(positions);
  const from = Math.min(region.from, min);
  const used = positions.map(item => item.string);
  const strings = !region.strings ? null
    : used.every(string => region.strings.includes(string)) ? Object.freeze([...region.strings])
      : Object.freeze([...new Set([...region.strings, ...used])].sort((a, b) => a - b));
  return Object.freeze({ from, to: Math.max(region.to, max), open: region.open || from === 0, strings });
}

function expansionCost(region, positions) {
  const { min, max } = fretSpan(positions);
  return Math.max(0, lowFret(region) - min) + Math.max(0, max - region.to);
}

// Menor expansão em casas; empate mantém as cordas pedidas. Devolve também as
// posições que realizam essa expansão (as notas são emitidas nelas).
function leastExpansion(profile, pitches, region) {
  const options = region.strings ? [region.strings, null] : [null];
  let best = null;
  options.forEach((strings, rank) => {
    const lists = pitches.map(pitch => positionsFor(profile, pitch, { from: STUDY_MIN_FRET, to: STUDY_MAX_FRET, open: region.open, strings }));
    if (lists.some(list => list.length === 0)) return;
    const found = combine(lists, positions => [expansionCost(region, positions), rank, ...compactScore(positions)]);
    if (best === null || compares(found.score, best.score) < 0) best = found;
  });
  if (!best) return null;
  return { positions: best.positions, expansion: expansionOf(region, best.positions), cost: best.score[0] };
}

// Busca exaustiva na região (posições completas, mão compacta, empate mais
// grave). Quando não cabe: `positions:null`, a expansão mínima e, em `nearest`,
// as posições dessa expansão.
export function regionPositions(value, pitches, region) {
  const profile = asProfile(value);
  const area = asRegion(region);
  const lists = pitches.map(pitch => positionsFor(profile, pitch, area));
  if (lists.every(list => list.length)) return { positions: combine(lists, compactScore).positions, expansion: null, nearest: null, inside: true };
  const nearest = leastExpansion(profile, pitches, area);
  return { positions: null, expansion: nearest?.expansion ?? null, nearest: nearest?.positions ?? null, inside: false, cost: nearest?.cost ?? null };
}

// Raiz na afinação atual, como resolveInstrumentPatternNotes: oitava mais
// próxima tocável a partir da corda mais grave.
export function rootPitchFor(root, value) {
  const low = asProfile(value).tuning[0];
  return low + mod12(root - mod12(low));
}

// ------------------------------------------------------------------- formas

// Intervalo entre cordas; corda inexistente no perfil assume quartas (baixo).
function stringInterval(profile, from, to) {
  if (from <= profile.strings && to <= profile.strings) return stringOpen(profile, to) - stringOpen(profile, from);
  return 5 * (from - to);
}

// Jogos de cordas aceitos: o escrito; no baixo 5, uma forma de 4 cordas pode
// descer um jogo até a corda Si; forma que usa corda inexistente sobe o mínimo.
// Só desloca quando o desenho de casas fica idêntico (mesmos intervalos).
function shapeShifts(profile, shape) {
  const strings = shape.notes.map(note => note.string);
  const high = Math.max(...strings);
  const low = Math.min(...strings);
  const anchor = shapeAnchor(shape.notes);
  const shifts = [];
  if (high <= profile.strings) shifts.push(0);
  else if (low - (high - profile.strings) >= 1) shifts.push(profile.strings - high);
  if (profile.type === 'bass' && profile.strings === 5 && high <= 4) shifts.push(1);
  return shifts.filter(shift => shift === 0 || shape.notes.every(note => (
    stringInterval(profile, anchor.string + shift, note.string + shift) === stringInterval(profile, anchor.string, note.string)
  )));
}

// Posições da forma por jogo de cordas e oitava. Ordem: cabe na região
// (distância 0), depois a MAIS GRAVE, depois a de casa mais baixa; empate
// fica no jogo de cordas escrito.
function shapeCandidates(profile, shape, root, region) {
  const anchor = shapeAnchor(shape.notes);
  const candidates = [];
  for (const shift of shapeShifts(profile, shape)) {
    const offset = mod12(root - (stringOpen(profile, anchor.string + shift) + anchor.fret));
    for (let octave = -2; octave <= 2; octave += 1) {
      const delta = offset + 12 * octave;
      const placed = shape.notes.map(note => {
        const string = note.string + shift;
        const fret = note.fret + delta;
        return { string, fret, degree: note.degree, pitch: stringOpen(profile, string) + fret };
      });
      if (placed.some(item => item.fret < STUDY_MIN_FRET || item.fret > STUDY_MAX_FRET)) continue;
      const { min, max } = fretSpan(placed);
      const stray = region.strings ? placed.filter(item => !region.strings.includes(item.string)).length : 0;
      const distance = Math.max(0, lowFret(region) - min) + Math.max(0, max - region.to) + STRING_PENALTY * stray;
      const pitches = placed.map(item => item.pitch);
      candidates.push({
        shift, placed, minFret: min, maxFret: max, distance, minPitch: Math.min(...pitches), maxPitch: Math.max(...pitches),
        score: [distance, Math.min(...pitches), max, Math.abs(shift), shift],
      });
    }
  }
  return candidates.sort((a, b) => compares(a.score, b.score));
}

function shapeDegreesOk(quality, placed) {
  const roots = placed.filter(item => isRootDegree(item.degree));
  if (!roots.length) return false;
  const anchor = roots.reduce((low, item) => (item.pitch < low.pitch ? item : low));
  try {
    return placed.every(item => mod12(item.pitch - anchor.pitch) === mod12(degreeSemitone(quality, item.degree)));
  } catch {
    return false;
  }
}

function placedShape(candidate, region, quality) {
  const positions = Object.freeze(candidate.placed.map(item => Object.freeze({ ...item, outside: !inRegion(item, region) })));
  return {
    positions, expansion: candidate.distance === 0 ? null : expansionOf(region, candidate.placed), inside: candidate.distance === 0,
    stringShift: candidate.shift, degreesOk: shapeDegreesOk(quality, candidate.placed),
  };
}

// Forma móvel: desloca a forma escrita até a fundamental do acorde, mantendo o
// desenho (reutilizável entre fundamentais e entre baixo 4/5). Escolha:
// dentro da região, mais grave, menor casa, jogo de cordas escrito; no baixo
// de 5 cordas a forma de 4 desce para a corda Si quando isso a põe mais grave.
// `positions[i]` corresponde a `shape.notes[i]`.
export function applyShape(value, shape, chord, region) {
  const profile = asProfile(value);
  const area = asRegion(region);
  const quality = shape?.quality ?? chord?.quality ?? 'major';
  if (!Array.isArray(shape?.notes) || !shapeAnchor(shape.notes)) {
    return { positions: null, expansion: null, inside: false, stringShift: null, degreesOk: false, reason: 'ancora' };
  }
  const candidates = shapeCandidates(profile, shape, mod12(chord.root), area);
  if (!candidates.length) {
    return { positions: null, expansion: null, inside: false, stringShift: null, degreesOk: false, reason: shapeShifts(profile, shape).length ? 'casas' : 'cordas' };
  }
  return placedShape(candidates[0], area, quality);
}

// -------------------------------------------------------------------- ritmo

const rhythmUnit = rhythm => (rhythm === 'eighths' ? 2 : STUDY_TICKS_PER_QUARTER);

// Arpejo (qualquer figura-base: `arpejo`/`quarters` = semínima, `eighths` =
// colcheia): a figura UMA vez, em ordem; a última nota completa o compasso em
// que começa e, se o bloco tem outro compasso, liga uma mínima nele; o resto é
// pausa. Semínimas n=3: q q h | h ligada + pausa h | pausa...
// Colcheias n=3: 0/2 2/2 4/12 (+8 ligada no segundo compasso).
function arpeggioCells(count, bars, unit) {
  const lastStart = unit * (count - 1);
  const barEnd = (Math.floor(lastStart / STUDY_TICKS_PER_BAR) + 1) * STUDY_TICKS_PER_BAR;
  const tie = barEnd < bars * STUDY_TICKS_PER_BAR ? STUDY_TICKS_PER_BAR / 2 : 0;
  return Array.from({ length: count }, (_, index) => ({
    start: index * unit,
    duration: index === count - 1 ? barEnd - lastStart + tie : unit,
  }));
}

function minimumBars(rhythm, count) {
  return Math.max(1, Math.ceil((count * rhythmUnit(rhythm)) / STUDY_TICKS_PER_BAR));
}

// Arpejos: regra do arpejo em qualquer base. Contínuo/percursos: cada nota
// uma vez e a última preenche a sobra do bloco.
function slotCells(rhythm, count, ticks, continuous) {
  const unit = rhythmUnit(rhythm);
  if (!continuous) return arpeggioCells(count, ticks / STUDY_TICKS_PER_BAR, unit);
  return Array.from({ length: count }, (_, index) => ({ start: index * unit, duration: index === count - 1 ? ticks - index * unit : unit }));
}

// ------------------------------------------------------ arpejos (região/forma)

function orderFigure(order, entries) {
  if (order === 'desce') return [...entries].reverse();
  if (order === 'sobe-desce') return [...entries, ...entries.slice(0, -1).reverse()];
  if (order === 'desce-sobe') return [...entries].reverse().concat(entries.slice(1));
  return [...entries];
}

// Inversão k da lista de graus: começa no k-ésimo e sobe a oitava dos
// anteriores (1 3 5 -> 3 5 8 -> 5 8 10; a quarta de uma tríade = 8 10 12).
function rotateDegrees(degrees, index) {
  return degrees.map((_, offset) => {
    const position = offset + index;
    const degree = degrees[position % degrees.length];
    return position >= degrees.length ? degreeAbove(degree) : degree;
  });
}

// Graus do slot: as inversões giram a figura; forma única e formas combinadas
// tocam a figura como está (o que muda entre elas é ONDE: forma transportada
// ou posição que cabe na região).
function slotDegrees(recipe, inversion) {
  const base = recipe.figure.degrees;
  if (recipe.family === 'arpejo_tres_inversoes_por_acorde') return rotateDegrees(base, inversion);
  return [...base];
}

// Sem forma: a oitava cujas posições completas cabem na região, a MAIS GRAVE
// (empate: menor casa máxima). Sem nenhuma, a de menor expansão.
function regionArpeggio(chord, degrees, profile, region) {
  const rootPitch = rootPitchFor(chord.root, profile);
  const semitones = degrees.map(degree => degreeSemitone(chord.quality, degree));
  let best = null;
  for (const shift of OCTAVE_SHIFTS) {
    const pitches = semitones.map(semitone => rootPitch + semitone + 12 * shift);
    if (pitches.some(pitch => pitch < 0 || pitch > 127)) continue;
    const solved = regionPositions(profile, pitches, region);
    const positions = solved.positions ?? solved.nearest;
    if (!positions) continue;
    const score = [solved.inside ? 0 : 1, solved.inside ? 0 : solved.cost, Math.min(...pitches), fretSpan(positions).max];
    if (best === null || compares(score, best.score) < 0) best = { score, pitches, positions };
  }
  if (!best) throw new TypeError(`O acorde ${chord.symbol} não cabe no braço deste instrumento.`);
  return degrees.map((degree, index) => ({
    degree, pitch: best.pitches[index], string: best.positions[index].string, fret: best.positions[index].fret,
    outside: !inRegion(best.positions[index], region),
  }));
}

// Altura que a forma não tem (oitava de um grau, ou grau ausente): posição
// junto à mão da forma, depois dentro da região, menor casa, corda mais grave.
function nearShape(profile, pitch, pool, region) {
  const { min, max } = fretSpan(pool);
  for (const candidate of [pitch, pitch - 12, pitch + 12]) {
    const everywhere = { from: STUDY_MIN_FRET, to: STUDY_MAX_FRET, strings: null };
    let found = positionsFor(profile, candidate, { ...everywhere, open: region.open });
    if (!found.length) found = positionsFor(profile, candidate, { ...everywhere, open: true });
    if (!found.length) continue;
    const scored = found.map(item => ({
      item, score: [item.fret < min ? min - item.fret : item.fret > max ? item.fret - max : 0, inRegion(item, region) ? 0 : 1, item.fret, -item.string],
    })).sort((a, b) => compares(a.score, b.score));
    return scored[0].item;
  }
  return null;
}

function poolEntry(item, region, derived = false) {
  return { degree: item.degree, pitch: item.pitch, string: item.string, fret: item.fret, outside: !inRegion(item, region), derived, source: item.source ?? null };
}

// Grau da figura -> nota da forma: altura exata relativa à âncora; senão a
// mesma classe de altura (nota livre mais próxima); senão deriva a altura.
function mapDegrees(degrees, pool, tonicPitch, quality, profile, region, usage) {
  const used = new Set();
  return degrees.map(degree => {
    const target = tonicPitch + degreeSemitone(quality, degree);
    const free = pool.filter((_, index) => !used.has(index));
    let index = pool.findIndex((item, position) => !used.has(position) && item.pitch === target);
    if (index < 0 && free.length) {
      const sameClass = pool.map((item, position) => ({ item, position }))
        .filter(({ item, position }) => !used.has(position) && mod12(item.pitch - target) === 0)
        .sort((a, b) => Math.abs(a.item.pitch - target) - Math.abs(b.item.pitch - target));
      if (sameClass.length) index = sameClass[0].position;
    }
    if (index >= 0) {
      used.add(index);
      return { ...poolEntry(pool[index], region), degree };
    }
    if (!pool.some(item => mod12(item.pitch - target) === 0)) usage.missing.add(degree);
    const position = nearShape(profile, target, pool, region);
    if (!position) throw new TypeError(`O grau ${degree} não cabe no braço deste instrumento.`);
    return { degree, pitch: position.pitch, string: position.string, fret: position.fret, outside: !inRegion(position, region), derived: true, source: null };
  });
}

// Inversão k de uma lista de alturas: começa na k-ésima e sobe uma oitava as
// anteriores (derivadas quando a forma não tem essa altura).
function rotatePitches(entries, index, pool, profile, region) {
  return entries.map((_, offset) => {
    const position = offset + index;
    const entry = entries[position % entries.length];
    const octaves = Math.floor(position / entries.length);
    if (octaves === 0) return entry;
    const pitch = entry.pitch + 12 * octaves;
    const exact = pool.find(item => item.pitch === pitch);
    const placed = exact ?? nearShape(profile, pitch, pool, region);
    if (!placed) throw new TypeError('A inversão sai do braço deste instrumento.');
    return {
      ...entry, degree: octaves === 1 ? degreeAbove(entry.degree) : entry.degree, pitch: placed.pitch, string: placed.string, fret: placed.fret,
      outside: !inRegion(placed, region), derived: !exact, source: exact?.source ?? null,
    };
  });
}

// Posição de UMA forma no acorde (`shapeIndex` = posição em recipe.shapes).
function placeShape(shape, shapeIndex, chord, profile, region) {
  const candidates = shapeCandidates(profile, shape, chord.root, region);
  if (!candidates.length) return { failure: { shapeIndex, reason: shapeShifts(profile, shape).length ? 'casas' : 'cordas' } };
  const chosen = candidates[0];
  if (!shapeDegreesOk(shape.quality, chosen.placed)) return { failure: { shapeIndex, reason: 'graus' } };
  const pool = chosen.placed.map((item, noteIndex) => ({ ...item, source: { shapeIndex, noteIndex } })).sort((a, b) => a.pitch - b.pitch);
  return { shape, shapeIndex, candidate: chosen, pool };
}

// Formas combinadas: em cada acorde, a forma cuja posição cabe na região; com
// mais de uma, a mais grave (depois menor casa, depois a ordem da lista).
function placeCombined(shapes, chord, profile, region) {
  let best = null;
  let failure = null;
  shapes.forEach((shape, shapeIndex) => {
    const placed = placeShape(shape, shapeIndex, chord, profile, region);
    if (placed.failure) { failure ??= placed.failure; return; }
    const { distance, minPitch, maxFret } = placed.candidate;
    const score = [distance, minPitch, maxFret, shapeIndex];
    if (best === null || compares(score, best.score) < 0) best = { ...placed, score };
  });
  return best ?? { failure };
}

// Altura-base da tônica na forma colocada (grau 8 sozinho = raiz uma oitava abaixo).
function rootBase(pool) {
  const ones = pool.filter(item => item.degree === 1).map(item => item.pitch);
  return ones.length ? Math.min(...ones) : Math.min(...pool.filter(item => item.degree === 8).map(item => item.pitch)) - 12;
}

function shapeArpeggio(recipe, chord, inversion, profile, region, usage, report) {
  const { family, figure, shapes } = recipe;
  const perSlot = family === 'arpejo_tres_inversoes_por_acorde' && shapes.length > 1;
  const placed = family === 'arpejo_triade_formas_combinadas'
    ? placeCombined(shapes, chord, profile, region)
    : placeShape(perSlot ? shapes[inversion] : shapes[0], perSlot ? inversion : 0, chord, profile, region);
  if (placed.failure) {
    const { shapeIndex, reason } = placed.failure;
    report.once(`forma:${chord.symbol}:${shapeIndex}:${reason}`, {
      code: 'forma-nao-aplicada', chord: chord.symbol, reason, shapeIndex, action: { kind: 'trocar-forma' },
    });
    const degrees = figure.degrees ?? [...new Set(shapes[0].degrees.map(degree => (family === 'arpejo_tres_inversoes_por_acorde' ? DEGREE_STEPS[degree][0] : degree)))];
    return { entries: regionArpeggio(chord, slotDegrees({ ...recipe, figure: { ...figure, degrees } }, inversion), profile, region), shapeIndex: null };
  }
  const { pool, shape, shapeIndex } = placed;
  const key = source => `${source.shapeIndex}:${source.noteIndex}`;
  pool.forEach(item => usage.used.add(key(item.source)));
  // Ordem da figura: a pedida; sem ela, a ordem de graus da própria forma.
  let base = mapDegrees(figure.degrees ?? shape.degrees, pool, rootBase(pool), chord.quality, profile, region, usage);
  if (!perSlot && family === 'arpejo_tres_inversoes_por_acorde') base = rotatePitches(base, inversion, pool, profile, region);
  base.forEach(entry => { if (entry.source) usage.played.add(key(entry.source)); });
  return { entries: base, shapeIndex };
}

// --------------------------------------------------------- movimento contínuo

function ladderTones(chord, degrees) {
  if (!degrees) return chord.degrees.map(tone => ({ degree: tone.degree, semitone: tone.semitone }));
  const bases = [...new Set(degrees.map(degree => DEGREE_STEPS[degree][0]))];
  return bases.map(degree => ({ degree, semitone: degreeSemitone(chord.quality, degree) }));
}

// Escada = toda altura de acorde tocável na região, grave -> agudo.
function chordLadder(chord, profile, region, degrees) {
  const rootPitch = rootPitchFor(chord.root, profile);
  const entries = [];
  for (const tone of ladderTones(chord, degrees)) {
    for (let octave = -3; octave <= 4; octave += 1) {
      const pitch = rootPitch + tone.semitone + 12 * octave;
      if (pitch < 0 || pitch > 127 || entries.some(entry => entry.pitch === pitch)) continue;
      const position = choosePosition(profile, pitch, region);
      if (position) entries.push({ pitch, degree: tone.degree, string: position.string, fret: position.fret, outside: false });
    }
  }
  return entries.sort((a, b) => a.pitch - b.pitch);
}

// Escada com menos de duas alturas não anda: expande a região o mínimo (em
// casas; empate mantém as cordas, depois prefere casas mais graves) e marca
// como `outside` o que ficou fora da região pedida. Nada é descartado.
function movementLadder(chord, profile, region, degrees) {
  const ladder = chordLadder(chord, profile, region, degrees);
  if (ladder.length >= 2) return ladder;
  const options = region.strings ? [region.strings, null] : [null];
  const floor = region.open ? STUDY_MIN_FRET : 1;
  for (let added = 1; added <= 2 * STUDY_MAX_FRET; added += 1) {
    for (const strings of options) {
      for (let down = Math.min(added, region.from - floor); down >= 0; down -= 1) {
        const to = region.to + added - down;
        if (to > STUDY_MAX_FRET) continue;
        const wide = chordLadder(chord, profile, { from: region.from - down, to, open: region.open, strings }, degrees);
        if (wide.length < 2) continue;
        return wide.map(entry => {
          const inside = choosePosition(profile, entry.pitch, region);
          return inside ? { ...entry, string: inside.string, fret: inside.fret, outside: false } : { ...entry, outside: true };
        });
      }
    }
  }
  throw new TypeError(`O acorde ${chord.symbol} não tem duas alturas tocáveis neste instrumento.`);
}

// Próxima nota estrita: a altura da escada mais próxima ALÉM da última na
// direção; sem nenhuma, vira. A primeira nota é a mais grave (ou a mais aguda).
function stepLadder(ladder, last, direction) {
  if (last === null) return { entry: direction > 0 ? ladder[0] : ladder[ladder.length - 1], direction };
  const above = ladder.find(entry => entry.pitch > last);
  const below = ladder.findLast(entry => entry.pitch < last);
  const ahead = direction > 0 ? above : below;
  if (ahead) return { entry: ahead, direction };
  const back = direction > 0 ? below : above;
  return back ? { entry: back, direction: -direction } : { entry: ladder[0], direction };
}

// Direção do passo seguinte a partir de `pitch` (vira na borda da escada).
function nextDirection(ladder, pitch, direction) {
  const ahead = direction > 0 ? ladder.some(entry => entry.pitch > pitch) : ladder.some(entry => entry.pitch < pitch);
  if (ahead) return direction;
  const back = direction > 0 ? ladder.some(entry => entry.pitch < pitch) : ladder.some(entry => entry.pitch > pitch);
  return back ? -direction : direction;
}

function percursoPass(ladder, descendFirst) {
  const up = ladder;
  const down = [...ladder].reverse();
  return descendFirst ? [...down, ...up.slice(1)] : [...up, ...down.slice(1)];
}

const sameState = (a, b) => a.pitch === b.pitch && a.direction === b.direction;

// Linha contínua por voltas: a nota carrega de acorde para acorde (altura e
// direção, nunca índice). Estado da volta = (primeira nota, direção do passo
// seguinte), o que determina todo o resto da linha. `end` = última nota e
// direção ao fim da volta (de onde sai a nota do compasso final).
function simulateLine(ladders, notes, descendFirst, count) {
  const voltas = [];
  let last = null;
  let direction = descendFirst ? -1 : 1;
  for (let volta = 0; volta < count; volta += 1) {
    let afterFirst = null;
    const slots = ladders.map(ladder => Array.from({ length: notes }, () => {
      const moved = stepLadder(ladder, last, direction);
      last = moved.entry.pitch;
      direction = moved.direction;
      if (afterFirst === null) afterFirst = direction;
      return moved.entry;
    }));
    const first = slots[0][0];
    // O passo seguinte à primeira nota usa a escada da célula seguinte.
    const following = notes > 1 ? ladders[0] : ladders[1 % ladders.length];
    voltas.push({
      slots, state: { pitch: first.pitch, direction: nextDirection(following, first.pitch, afterFirst), entry: first },
      end: { pitch: last, direction },
    });
  }
  return voltas;
}

// ------------------------------------------------------------- plano/notas

function harmonic(recipe) { return HARMONIC_FAMILIES.includes(recipe.family); }

function slotsPerChord(recipe) {
  return recipe.family === 'arpejo_tres_inversoes_por_acorde' ? recipe.figure.inversions : 1;
}

function createReport() {
  const list = [];
  const keys = new Set();
  return {
    list,
    push(warning) { list.push(warning); },
    once(key, warning) { if (!keys.has(key)) { keys.add(key); list.push(warning); } },
  };
}

function describeState(state) {
  return Object.freeze({
    pitch: state.pitch, direction: state.direction > 0 ? 'subindo' : 'descendo',
    string: state.entry.string, fret: state.entry.fret, degree: state.entry.degree,
  });
}

// Núcleo: ciclo, padrões por slot, voltas (fixas ou período), compasso final
// e teto de 128. Regras do teto: só voltas INTEIRAS; o compasso final conta
// dentro dos 128; capado = para na última volta inteira, SEM compasso final,
// com `limite-128` propondo o maior número de voltas que cabe com o final.
function compose(normalized, session) {
  const cycle = chordCycle(normalized, { session });
  // Região aceita qualidades mistas (I–vi–ii–V); a forma é de UMA qualidade.
  if (normalized.shapes && cycle.some(chord => chord.quality !== normalized.shapes[0].quality)) {
    throw new TypeError('Com forma de digitação, todos os acordes do ciclo precisam da qualidade da forma.');
  }
  const { profile, region, figure, rhythm, family } = normalized;
  const report = createReport();
  const perChord = slotsPerChord(normalized);
  const continuous = CONTINUOUS_FAMILIES.includes(family);
  const percurso = STUDY_PERCURSO_FAMILIES.includes(family);
  const descendFirst = figure.order === 'desce' || figure.order === 'desce-sobe';
  const usage = { used: new Set(), played: new Set(), missing: new Set() };

  // Padrões de UMA volta: harmonia e percursos repetem idênticos a cada volta.
  let patterns = null;
  let ladders = null;
  if (harmonic(normalized)) {
    patterns = cycle.flatMap((chord, chordIndex) => Array.from({ length: perChord }, (_, inversion) => {
      const placed = normalized.shapes
        ? shapeArpeggio(normalized, chord, inversion, profile, region, usage, report)
        : { entries: regionArpeggio(chord, slotDegrees(normalized, inversion), profile, region), shapeIndex: null };
      return { chordIndex, inversion: perChord > 1 ? inversion : null, shapeIndex: placed.shapeIndex, entries: orderFigure(figure.order, placed.entries) };
    }));
  } else {
    ladders = cycle.map(chord => movementLadder(chord, profile, region, figure.degrees));
    if (percurso) patterns = ladders.map((ladder, chordIndex) => ({ chordIndex, inversion: null, shapeIndex: null, entries: percursoPass(ladder, descendFirst) }));
  }

  // Percursos: o maior acorde decide o mínimo (todos os slots têm o mesmo tamanho).
  const counts = patterns ? patterns.map(pattern => pattern.entries.length) : [figure.notes];
  const minimumFigureBars = Math.max(...counts.map(count => minimumBars(rhythm, count)));
  const barsPerSlot = Math.max(figure.bars ?? 0, minimumFigureBars);
  const ticksPerSlot = barsPerSlot * STUDY_TICKS_PER_BAR;
  const figureShort = figure.bars !== null && figure.bars < minimumFigureBars;
  const slotsPerVolta = cycle.length * perChord;
  const barsPerVolta = slotsPerVolta * barsPerSlot;
  const finalWanted = normalized.final !== 'nenhum' ? 1 : 0;
  const fit = Math.floor(STUDY_MAX_BARS / barsPerVolta);
  const periodic = normalized.voltas === STUDY_PERIOD;

  // Estados por volta (só a linha contínua muda de volta para volta).
  let line = null;
  let periodLength = 1;
  if (!harmonic(normalized) && !percurso) {
    line = simulateLine(ladders, figure.notes, descendFirst, Math.max(fit, 1) + 1);
    const back = line.findIndex((volta, index) => index > 0 && sameState(volta.state, line[0].state));
    periodLength = back > 0 ? back : null;
  }
  const requested = periodic ? periodLength : normalized.voltas;
  const voltasFit = requested !== null && requested <= fit;
  const capped = !voltasFit || requested * barsPerVolta + finalWanted > STUDY_MAX_BARS;
  const voltas = voltasFit ? requested : Math.max(fit, 1);
  const partialSlots = !voltasFit && fit === 0 ? Math.max(1, Math.floor(STUDY_MAX_BARS / barsPerSlot)) : null;
  const finalBars = finalWanted && !capped ? 1 : 0;
  if (capped) {
    const room = STUDY_MAX_BARS - finalWanted;
    const best = Math.floor(room / barsPerVolta);
    report.push({
      code: 'limite-128', limit: STUDY_MAX_BARS, needed: requested === null ? null : requested * barsPerVolta + finalWanted,
      period: periodLength, voltas, finalOmitted: finalWanted === 1,
      action: best >= 1
        ? { kind: 'reduzir-voltas', voltas: best }
        : { kind: 'reduzir-voltas', voltas: 1, length: Math.max(1, Math.floor(room / (barsPerSlot * perChord))) },
    });
  }

  const slots = [];
  for (let volta = 0; volta < voltas; volta += 1) {
    for (let position = 0; position < slotsPerVolta; position += 1) {
      if (partialSlots !== null && slots.length >= partialSlots) break;
      const chordIndex = Math.floor(position / perChord);
      const pattern = patterns ? patterns[position] : null;
      const entries = pattern ? pattern.entries : line[volta].slots[chordIndex];
      const index = slots.length;
      slots.push({
        index, volta, chordIndex, inversion: pattern ? pattern.inversion : null, shapeIndex: pattern ? pattern.shapeIndex : null,
        start: index * ticksPerSlot, ticks: ticksPerSlot, entries, cells: slotCells(rhythm, entries.length, ticksPerSlot, continuous),
      });
    }
  }
  const generatedBars = slots.length * barsPerSlot;
  const neededBars = generatedBars + finalBars;
  const shortTotal = normalized.bars !== null && normalized.bars < neededBars;
  // Um aviso por causa: a figura curta já leva o total corrigido na ação.
  if (figureShort) {
    report.push({
      code: 'aumentar-compassos', scope: 'figura', minimumFigureBars, figureBars: figure.bars, minimumBars: neededBars,
      action: { kind: 'aumentar-compassos', figureBars: minimumFigureBars, bars: shortTotal ? neededBars : null },
    });
  } else if (shortTotal) {
    report.push({
      code: 'aumentar-compassos', scope: 'total', minimumBars: neededBars, requestedBars: normalized.bars,
      action: { kind: 'aumentar-compassos', bars: neededBars },
    });
  }
  const actualBars = capped || normalized.bars === null ? neededBars : Math.max(normalized.bars, neededBars);

  if (normalized.shapes) {
    const unused = [];
    normalized.shapes.forEach((shape, shapeIndex) => shape.notes.forEach((note, noteIndex) => {
      if (!usage.played.has(`${shapeIndex}:${noteIndex}`) && usage.used.has(`${shapeIndex}:${noteIndex}`)) unused.push(note.degree);
    }));
    const missing = [...usage.missing];
    if (unused.length || missing.length) {
      const degrees = normalized.shapes[0].degrees;
      report.push({ code: 'forma-divergente', unused: [...new Set(unused)].sort((a, b) => a - b), missing: missing.sort((a, b) => a - b), action: { kind: 'usar-graus-da-forma', degrees } });
    }
  }

  const states = line
    ? line.slice(0, voltas).map(volta => describeState(volta.state))
    : ladders
      ? Array.from({ length: voltas }, () => describeState({ pitch: patterns[0].entries[0].pitch, direction: descendFirst ? -1 : 1, entry: patterns[0].entries[0] }))
      : [];
  const period = Object.freeze({
    mode: periodic ? STUDY_PERIOD : 'fixo', requested: normalized.voltas, voltas, length: periodLength,
    closed: periodLength !== null && voltas % periodLength === 0 && partialSlots === null,
    capped, barsPerVolta, bars: generatedBars,
    states: Object.freeze(states.map((state, volta) => Object.freeze({ volta, ...state }))),
  });
  const finalChordIndex = finalBars ? (normalized.final === 'tonica' ? 0 : slots[slots.length - 1].chordIndex) : null;
  return {
    recipe: normalized, cycle, slots, ticksPerSlot, barsPerSlot, figureBars: figure.bars, minimumFigureBars,
    neededBars, generatedBars, actualBars, finalBars, finalChordIndex, capped, voltas, period, report, ladders,
    lineEnd: line && partialSlots === null ? line[voltas - 1].end : null,
  };
}

export function planSlots(recipe, { session = null } = {}) {
  const plan = compose(normalizeRecipe(recipe), session);
  const slots = plan.slots.map(slot => Object.freeze({
    index: slot.index, volta: slot.volta, chordIndex: slot.chordIndex, inversion: slot.inversion, shapeIndex: slot.shapeIndex,
    start: slot.start, ticks: slot.ticks,
    cells: Object.freeze(slot.cells.map(cell => Object.freeze({ start: cell.start, duration: cell.duration }))),
  }));
  return Object.freeze({
    recipe: plan.recipe, chords: plan.cycle, slots: Object.freeze(slots),
    cells: slots[0].cells, cellsPerSlot: slots[0].cells.length, ticksPerSlot: plan.ticksPerSlot,
    barsPerSlot: plan.barsPerSlot, minimumFigureBars: plan.minimumFigureBars, generatedBars: plan.generatedBars,
    neededBars: plan.neededBars, actualBars: plan.actualBars, finalBars: plan.finalBars, finalChordIndex: plan.finalChordIndex,
    capped: plan.capped, voltas: plan.voltas, period: plan.period,
    warnings: Object.freeze(plan.report.list.map(warning => Object.freeze({ ...warning }))),
  });
}

// Estado do período no início da volta `turn` (0 = primeira): nota inicial e
// direção do passo seguinte, simulados pela mesma linha da geração.
export function periodState(recipe, turn, { session = null } = {}) {
  const normalized = normalizeRecipe(recipe);
  if (!CONTINUOUS_FAMILIES.includes(normalized.family)) throw new TypeError('O período se aplica aos movimentos contínuos.');
  if (!Number.isInteger(turn) || turn < 0 || turn > PERIOD_TURN_LIMIT) throw new TypeError(`A volta do período deve ser um inteiro de 0 a ${PERIOD_TURN_LIMIT}.`);
  const cycle = chordCycle(normalized, { session });
  const ladders = cycle.map(chord => movementLadder(chord, normalized.profile, normalized.region, normalized.figure.degrees));
  const descendFirst = normalized.figure.order === 'desce' || normalized.figure.order === 'desce-sobe';
  let state;
  let notesPerVolta;
  if (STUDY_PERCURSO_FAMILIES.includes(normalized.family)) {
    const passes = ladders.map(ladder => percursoPass(ladder, descendFirst));
    notesPerVolta = passes.reduce((total, pass) => total + pass.length, 0);
    state = { pitch: passes[0][0].pitch, direction: descendFirst ? -1 : 1, entry: passes[0][0] };
  } else {
    notesPerVolta = ladders.length * normalized.figure.notes;
    state = simulateLine(ladders, normalized.figure.notes, descendFirst, turn + 1)[turn].state;
  }
  const described = describeState(state);
  return Object.freeze({
    turn, step: turn * notesPerVolta, index: ladders[0].findIndex(entry => entry.pitch === state.pitch),
    ladderLength: ladders[0].length, ...described,
  });
}

function countWarnings(warnings) {
  const counts = {};
  for (const warning of warnings) counts[warning.code] = (counts[warning.code] ?? 0) + 1;
  return counts;
}

function roleOf(pitch, chord, degree) {
  return ROLE_LABELS[mod12(pitch - chord.root)] ?? DEGREE_LABELS[degree];
}

// Tônica mais grave do acorde dentro da região; sem nenhuma, a de menor
// expansão (marcada `outside`, e o aviso `sem-posicao` sai por acorde).
function lowestTonic(recipe, chord) {
  const nominal = rootPitchFor(chord.root, recipe.profile);
  for (const shift of OCTAVE_SHIFTS) {
    const pitch = nominal + 12 * shift;
    if (pitch < 0 || pitch > 127) continue;
    const position = choosePosition(recipe.profile, pitch, recipe.region);
    if (position) return { pitch, string: position.string, fret: position.fret, outside: false };
  }
  let best = null;
  for (const shift of OCTAVE_SHIFTS) {
    const pitch = nominal + 12 * shift;
    if (pitch < 0 || pitch > 127) continue;
    const nearest = leastExpansion(recipe.profile, [pitch], recipe.region);
    if (nearest && (best === null || nearest.cost < best.cost)) best = { pitch, position: nearest.positions[0], cost: nearest.cost };
  }
  if (!best) throw new TypeError(`A tônica de ${chord.symbol} não cabe no braço deste instrumento.`);
  return { pitch: best.pitch, string: best.position.string, fret: best.position.fret, outside: true };
}

// Linha contínua: a nota final segue a regra da linha restrita à tônica — a
// tônica da escada mais próxima ALÉM da última nota na direção do movimento;
// sem nenhuma, vira (a transição para o compasso final também é estrita).
function lineTonic(ladder, chord, end) {
  const tonics = ladder.filter(entry => mod12(entry.pitch - chord.root) === 0);
  if (!tonics.length) return null;
  const above = tonics.find(entry => entry.pitch > end.pitch);
  const below = tonics.findLast(entry => entry.pitch < end.pitch);
  const chosen = (end.direction > 0 ? above ?? below : below ?? above) ?? tonics[0];
  return { pitch: chosen.pitch, string: chosen.string, fret: chosen.fret, outside: chosen.outside === true };
}

// Compasso final ("repetir o primeiro acorde no fim"): uma nota longa na
// tônica do PRIMEIRO acorde (`tonica`) ou do último tocado (`acorde`), do fim
// das voltas até o fim dos compassos (1 compasso, ou a sobra de `bars`).
function finalNote(plan, noteCount) {
  if (!plan.finalBars) return null;
  const { recipe } = plan;
  const start = plan.generatedBars * STUDY_TICKS_PER_BAR;
  const ticks = plan.actualBars * STUDY_TICKS_PER_BAR - start;
  const chordIndex = plan.finalChordIndex;
  const chord = plan.cycle[chordIndex];
  const chosen = (plan.lineEnd ? lineTonic(plan.ladders[chordIndex], chord, plan.lineEnd) : null) ?? lowestTonic(recipe, chord);
  return {
    chord, chordIndex, start, ticks,
    note: {
      id: `study-${noteCount}`, start, duration: ticks, pitch: chosen.pitch, velocity: 0.8, articulation: 'tenuto', offsetMs: 0,
      string: chosen.string, fret: chosen.fret, degree: 1, chordIndex, slotIndex: null, role: 'Tônica', outside: chosen.outside,
    },
  };
}

function chordEntry(chord, chordIndex, fields, entries) {
  return Object.freeze({
    index: chordIndex, ...fields, root: chord.root, rootName: chord.rootName, quality: chord.quality, symbol: chord.symbol,
    label: chord.label, degrees: chord.degrees,
    shape: Object.freeze(entries.map(item => Object.freeze({ degree: item.degree, pitch: item.pitch, string: item.string, fret: item.fret, role: roleOf(item.pitch, chord, item.degree) }))),
  });
}

export function generateStudy(recipe, { session = null } = {}) {
  const plan = compose(normalizeRecipe(recipe), session);
  const normalized = plan.recipe;
  const region = normalized.region;
  const notes = [];
  const chords = [];
  const slots = [];
  for (const slot of plan.slots) {
    const chord = plan.cycle[slot.chordIndex];
    slot.cells.forEach((cell, cellIndex) => {
      const item = slot.entries[cell.note ?? cellIndex];
      notes.push(Object.freeze({
        id: `study-${notes.length}`, start: slot.start + cell.start, duration: cell.duration,
        pitch: item.pitch, velocity: 0.8, articulation: 'normal', offsetMs: 0, string: item.string, fret: item.fret,
        degree: item.degree, chordIndex: slot.chordIndex, slotIndex: slot.index, role: roleOf(item.pitch, chord, item.degree), outside: item.outside === true,
      }));
    });
    chords.push(chordEntry(chord, slot.chordIndex, { slot: slot.index, volta: slot.volta, start: slot.start, ticks: slot.ticks, inversion: slot.inversion, shapeIndex: slot.shapeIndex, final: false }, slot.entries));
    slots.push(Object.freeze({ index: slot.index, volta: slot.volta, chordIndex: slot.chordIndex, inversion: slot.inversion, shapeIndex: slot.shapeIndex, start: slot.start, ticks: slot.ticks }));
  }
  const playedDegrees = Object.freeze([...new Set(notes.map(note => note.degree))].sort((a, b) => a - b));
  // Ordem tocada no primeiro bloco (graus como emitidos, oitava incluída).
  const degreeOrder = Object.freeze(plan.slots.length ? plan.slots[0].entries.map(entry => entry.degree) : []);
  const last = finalNote(plan, notes.length);
  let finalBar = null;
  if (last) {
    notes.push(Object.freeze(last.note));
    chords.push(chordEntry(last.chord, last.chordIndex, { slot: null, volta: null, start: last.start, ticks: last.ticks, inversion: null, shapeIndex: null, final: true }, [last.note]));
    finalBar = Object.freeze({
      bar: last.start / STUDY_TICKS_PER_BAR, start: last.start, ticks: last.ticks, chordIndex: last.chordIndex,
      symbol: last.chord.symbol, root: last.chord.root, quality: last.chord.quality, repeatsFirst: last.chordIndex === 0,
    });
  }
  // Fora da região: um aviso por acorde, com a contagem e a expansão mínima
  // que cobre exatamente as posições emitidas.
  const outside = new Map();
  for (const note of notes) {
    if (!note.outside) continue;
    const symbol = plan.cycle[note.chordIndex].symbol;
    if (!outside.has(symbol)) outside.set(symbol, []);
    outside.get(symbol).push(note);
  }
  const warnings = [...plan.report.list];
  for (const [symbol, list] of outside) {
    const expansion = expansionOf(region, list);
    warnings.push({ code: 'sem-posicao', chord: symbol, count: list.length, expansion, action: { kind: 'expandir-regiao', region: expansion } });
  }
  if (notes.length > STUDY_MAX_NOTES) {
    warnings.push({ code: 'notas-acima-de-512', count: notes.length, limit: STUDY_MAX_NOTES, action: { kind: 'aumentar-limite', limit: STUDY_MAX_NOTES } });
  }
  const frozenWarnings = Object.freeze(warnings.map(warning => Object.freeze({ ...warning, action: Object.freeze({ ...warning.action }) })));
  const frets = notes.map(note => note.fret);
  const positions = notes.map(note => Object.freeze({ noteId: note.id, string: note.string, fret: note.fret, outside: note.outside === true }));
  const usedStrings = [...new Set(notes.map(note => note.string))].sort((a, b) => a - b);
  return Object.freeze({
    recipe: normalized, bars: normalized.bars ?? plan.actualBars, actualBars: plan.actualBars,
    ticks: plan.actualBars * STUDY_TICKS_PER_BAR, chords: Object.freeze(chords), slots: Object.freeze(slots),
    notes: Object.freeze(notes), positions: Object.freeze(positions), warnings: frozenWarnings,
    warningCounts: Object.freeze(countWarnings(frozenWarnings)), period: plan.period, finalBar,
    meta: Object.freeze({
      family: normalized.family, profile: normalized.profile, quality: normalized.progression.quality, progression: normalized.progression.kind,
      rhythm: normalized.rhythm, figureBars: plan.barsPerSlot, degrees: normalized.figure.degrees ?? degreeOrder, degreeOrder, playedDegrees,
      order: normalized.figure.order, strings: Object.freeze(usedStrings), region, voltas: plan.voltas, voltasRequested: normalized.voltas,
      period: plan.period.length, periodClosed: plan.period.closed, capped: plan.capped, finalBar: finalBar !== null,
      generatedBars: plan.generatedBars, minFret: frets.length ? Math.min(...frets) : null, maxFret: frets.length ? Math.max(...frets) : null,
      noteCount: notes.length, chordCount: plan.cycle.length, slotCount: plan.slots.length,
    }),
  });
}

// Metadados da receita para a metadata FUTURA do exercício (A4). Nada é
// persistido em `extensions` da sessão; a receita vive fora dela.
export function studyMetadata(result) {
  const { recipe, meta } = result;
  return Object.freeze({
    version: recipe.version, family: recipe.family, quality: recipe.progression.quality,
    progression: recipe.progression.kind, rhythm: recipe.rhythm, figureBars: meta.figureBars,
    degrees: meta.degrees, playedDegrees: meta.playedDegrees, order: recipe.figure.order, inversions: recipe.figure.inversions,
    shapes: recipe.shapes?.length ?? 0, notes: recipe.figure.notes, bars: result.actualBars,
    voltas: meta.voltas, voltasRequested: recipe.voltas, period: meta.period, periodClosed: meta.periodClosed, capped: meta.capped,
    finalBar: meta.finalBar, degreeOrder: meta.degreeOrder,
    final: recipe.final, region: recipe.region, profile: { type: recipe.profile.type, strings: recipe.profile.strings },
    strings: meta.strings, minFret: meta.minFret, maxFret: meta.maxFret, noteCount: meta.noteCount, warnings: result.warningCounts,
  });
}

// Notas canônicas (subconjunto de model.NOTE_KEYS) — sem `fret` nem derivados.
export function canonicalNotes(result) {
  return result.notes.map(note => ({
    id: note.id, start: note.start, duration: note.duration, pitch: note.pitch, velocity: note.velocity,
    articulation: note.articulation, offsetMs: note.offsetMs, string: note.string,
  }));
}

// ------------------------------------------------------- catálogo (A5)
//
// Entrada da receita = campos de DEFINIÇÃO do material (família, qualidade,
// cifras/regra, região declarada, compassos por acorde, contorno, inversão,
// compasso final, origem 5 cordas, forma fornecida). Campos de OBSERVAÇÃO
// (total_de_compassos, cordas_usadas, extensao_em_casas, observada_na_tab,
// padrao_codigo) nunca entram: são o que `catalogValues` permite conferir.

const CATALOG_QUALITY_ALIASES = Object.freeze({
  major: 'major', maior: 'major', maj: 'major', M: 'major', minor: 'minor', menor: 'minor', min: 'minor', m: 'minor',
  aug: 'aug', aumentada: 'aug', aumentado: 'aug', '+': 'aug', dim: 'dim', diminuta: 'dim', diminuto: 'dim', '°': 'dim',
  maj7: 'maj7', '7M': 'maj7', m7: 'm7', 'm7b5': 'm7b5', 'ø': 'm7b5', '7': '7', dim7: 'dim7', '°7': 'dim7',
  mista: 'mista', misto: 'mista',
});

const CATALOG_INVERSIONS = Object.freeze({
  fundamental: 0, 'estado fundamental': 0, 'posicao fundamental': 0, 'posição fundamental': 0,
  primeira: 1, '1a': 1, '1ª': 1, 'primeira inversao': 1, 'primeira inversão': 1,
  segunda: 2, '2a': 2, '2ª': 2, 'segunda inversao': 2, 'segunda inversão': 2,
  terceira: 3, '3a': 3, '3ª': 3, 'terceira inversao': 3, 'terceira inversão': 3,
});

// Vocabulário antigo do ritmo (palavra) -> tipo realizado; null = não é palavra.
const CATALOG_RHYTHMS = Object.freeze({
  quarters: 'quarters', q: 'quarters', seminimas: 'quarters', 'semínimas': 'quarters',
  eighths: 'eighths', e: 'eighths', colcheias: 'eighths',
  arpejo: 'arpejo', qqh: 'arpejo',
});

// Contorno: palavra de direção ou sequência de graus ("T-3-5", "3-5-T").
const CONTOUR_ORDERS = Object.freeze({
  sobe: 'sobe', desce: 'desce', 'sobe-desce': 'sobe-desce', 'desce-sobe': 'desce-sobe',
  'grave-agudo-grave': 'sobe-desce', 'agudo-grave-agudo': 'desce-sobe',
});
const CONTOUR_DEGREES = Object.freeze({
  t: 1, r: 1, f: 1, 1: 1, 8: 1, 3: 3, b3: 3, 5: 5, b5: 5, '#5': 5, 7: 7, b7: 7, '7m': 7, bb7: 7,
});

const plainText = value => value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function catalogQuality(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return STUDY_QUALITIES.includes(trimmed) ? trimmed : CATALOG_QUALITY_ALIASES[trimmed] ?? CATALOG_QUALITY_ALIASES[trimmed.toLowerCase()] ?? CATALOG_QUALITY_ALIASES[trimmed.replaceAll('♭', 'b')] ?? null;
}

export function catalogRhythm(value) {
  if (typeof value !== 'string') return null;
  return CATALOG_RHYTHMS[value.trim().toLowerCase().replace(/\s+/g, ' ')] ?? null;
}

// `padrao_codigo` normalizado ("q q h | h(lig) pausa_h"); null = fora do
// vocabulário (q, h, w, e, s, com ponto, ligadura "(lig)" e "pausa_").
export function normalizeRhythmCode(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = plainText(value).replaceAll('♩', 'q')
    .replace(/\s*\(\s*lig[a-z]*\s*\)/g, '(lig)')
    .replace(/pausa[\s_-]*(?=[whqes])/g, 'pausa_');
  const token = /^(pausa_)?[whqes]\.?(\(lig\))?$/;
  const bars = text.split('|').map(bar => bar.trim().split(/\s+/).filter(Boolean));
  if (bars.some(bar => bar.length === 0 || bar.some(item => !token.test(item)))) return null;
  return bars.map(bar => bar.join(' ')).join(' | ');
}

export function catalogContour(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = plainText(value);
  if (CONTOUR_ORDERS[text]) return Object.freeze({ order: CONTOUR_ORDERS[text], degrees: null });
  const tokens = text.replaceAll('♭', 'b').split(/[\s,–—-]+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const degrees = tokens.map(item => CONTOUR_DEGREES[item]);
  if (degrees.some(degree => degree === undefined) || new Set(degrees).size !== degrees.length) return null;
  return Object.freeze({ order: null, degrees: Object.freeze(degrees) });
}

// Graus-base do contorno -> graus da figura, cada um ACIMA do anterior
// ("3-5-T" -> 3 5 8; "5-T-3" -> 5 8 10). null se não sobe.
function ascendingDegrees(bases, quality) {
  const out = [];
  let previous = -Infinity;
  for (const base of bases) {
    let degree = base;
    if (degreeSemitone(quality, degree) <= previous) degree = degreeAbove(degree);
    if (degreeSemitone(quality, degree) <= previous) return null;
    previous = degreeSemitone(quality, degree);
    out.push(degree);
  }
  return out;
}

function catalogInversion(value) {
  if (Number.isInteger(value)) return value >= 0 && value <= 3 ? value : null;
  if (typeof value !== 'string') return null;
  return CATALOG_INVERSIONS[value.trim().toLowerCase()] ?? null;
}

// Regra textual do ciclo ("ciclo de quartas", "quintas descendente"...).
function catalogRule(value) {
  if (typeof value !== 'string') return null;
  const text = plainText(value);
  const kind = /quart/.test(text) ? 'quartas' : /quint/.test(text) ? 'quintas' : /cromat/.test(text) ? 'cromatica' : null;
  if (!kind) return null;
  return { kind, direction: /descend/.test(text) ? 'descendente' : 'ascendente' };
}

// Cifras -> ciclo + voltas: com compasso final, a última cifra igual à
// primeira é o acorde final (não uma volta); a lista que se repete inteira
// vira o ciclo menor e o número de voltas.
function catalogCycle(cifras, hasFinal) {
  let list = cifras.map(cifra => cifra.trim());
  if (hasFinal && list.length > 1 && list[list.length - 1] === list[0]) list = list.slice(0, -1);
  for (let period = 1; period <= list.length; period += 1) {
    if (list.length % period || list.length / period > STUDY_MAX_VOLTAS) continue;
    if (list.every((cifra, index) => cifra === list[index % period])) return { chords: list.slice(0, period), voltas: list.length / period };
  }
  return { chords: list, voltas: 1 };
}

// Região de ENTRADA = a declarada pelo autor; `observada_na_tab` e
// `cordas_usadas` são conferência (nunca alimentam a receita).
function catalogRegion(entry) {
  const declared = entry?.regiao_do_braco?.declarada ?? null;
  if (!Number.isInteger(declared?.de) || !Number.isInteger(declared?.ate)) return STUDY_REGION_DEFAULT;
  const from = Math.max(STUDY_MIN_FRET, Math.min(declared.de, declared.ate));
  const to = Math.min(STUDY_MAX_FRET, Math.max(declared.de, declared.ate));
  return { from, to, open: from === 0, strings: null };
}

// Forma opcional no material: `forma.notas` = [{corda,casa,grau}] ou
// [{string,fret,degree}]. Nunca é inventada.
function catalogShape(entry, quality) {
  const source = entry?.forma?.notas ?? entry?.forma_do_braco?.notas;
  if (!Array.isArray(source) || source.length === 0) return null;
  const notes = source.map(item => ({
    string: item?.string ?? item?.corda, fret: item?.fret ?? item?.casa, degree: item?.degree ?? item?.grau,
  }));
  if (notes.some(note => !Number.isInteger(note.string) || !Number.isInteger(note.fret) || !Number.isInteger(note.degree))) return null;
  return { quality, notes };
}

// Material do catálogo (formato A5) -> receita, só com campos de definição.
// `instrument` padrão: baixo 5 se `origem_tipo` é "5cordas", senão baixo 4.
// Linha contínua de 5 cordas sem lista completa = "até fechar o período".
export function recipeFromCatalog(entry, { instrument = null, declaredRhythm = false } = {}) {
  if (!entry || typeof entry !== 'object') throw new TypeError('Material de catálogo inválido.');
  const family = STUDY_FAMILIES.includes(entry.familia) ? entry.familia : null;
  if (!family) throw new TypeError('Família de catálogo sem receita no gerador.');
  const declaredQuality = catalogQuality(entry.qualidade);
  if (!declaredQuality) throw new TypeError('Qualidade de catálogo sem receita no gerador.');
  const mixed = declaredQuality === 'mista';
  const quality = mixed ? 'major' : declaredQuality;
  const harmonicFamily = HARMONIC_FAMILIES.includes(family);
  const fiveStrings = entry.origem_tipo === '5cordas';
  const profile = instrument ?? { type: 'bass', strings: fiveStrings ? 5 : 4 };
  const finalField = entry?.figura_ritmica?.compasso_final;
  const hasFinal = finalField !== undefined && finalField !== null && finalField !== false && finalField !== '' && !(Array.isArray(finalField) && finalField.length === 0);
  const cifras = Array.isArray(entry?.sequencia_de_acordes?.cifras) ? entry.sequencia_de_acordes.cifras.filter(cifra => typeof cifra === 'string' && cifra.trim()) : [];
  const rule = catalogRule(entry?.sequencia_de_acordes?.regra);
  let progression;
  let listedVoltas = 1;
  if (cifras.length) {
    const cycle = catalogCycle(cifras, hasFinal);
    progression = { kind: 'lista', quality, chords: cycle.chords };
    listedVoltas = cycle.voltas;
  } else if (rule && !mixed) progression = { kind: rule.kind, direction: rule.direction, quality, start: 'C' };
  else throw new TypeError('Material sem acordes: informe cifras ou a regra do ciclo.');
  const shape = harmonicFamily && !mixed ? catalogShape(entry, quality) : null;
  const contour = catalogContour(entry?.contorno?.padrao);
  const order = PERCURSO_ORDER[family] || !contour?.order || contour.order === PERCURSO_ORDER[family] ? undefined : contour.order;
  const inverts = family === 'arpejo_tres_inversoes_por_acorde';
  let degrees;
  if (harmonicFamily && contour?.degrees) {
    const ascending = ascendingDegrees(contour.degrees, quality);
    // As inversões giram a figura em posição fundamental (T primeiro, sem oitava).
    degrees = inverts ? (ascending && ascending[0] === 1 && ascending.every(degree => degree <= 7) ? ascending : undefined) : ascending ?? undefined;
  } else if (family === 'arpejo_triade_forma_unica' && !shape) {
    // `inversao` = em que inversão está a forma única (não uma contagem).
    const inversion = catalogInversion(entry.inversao);
    if (inversion) degrees = rotateDegrees(qualityTones(quality).map(tone => tone.degree), inversion);
  }
  // Compassos por acorde -> por bloco (as três inversões dividem o acorde).
  const perChord = Number.isInteger(entry.compassos_por_acorde) && entry.compassos_por_acorde >= 1 ? entry.compassos_por_acorde : null;
  const perSlot = perChord === null ? undefined : inverts ? (perChord % 3 === 0 ? perChord / 3 : undefined) : perChord;
  const figureBars = perSlot !== undefined && perSlot <= maxFigureBars(family) ? perSlot : undefined;
  const rhythm = declaredRhythm ? catalogRhythm(entry?.figura_ritmica?.padrao_codigo) : null;
  const usableRhythm = rhythm && !(rhythm === 'arpejo' && !harmonicFamily) ? rhythm : undefined;
  const voltas = listedVoltas > 1 ? listedVoltas
    : fiveStrings && family === 'movimento_continuo_linha_4_notas' ? STUDY_PERIOD : 1;
  return normalizeRecipe({
    family, profile, progression, bars: null, region: catalogRegion(entry), shape,
    rhythm: usableRhythm, figure: { bars: figureBars, order, degrees }, voltas, final: hasFinal ? 'tonica' : 'nenhum',
  });
}

// Ritmo como realizado nas notas: colcheias se há passo de 2 ticks; arpejo
// se, numa família de arpejo, alguma nota passa da semínima; senão semínimas.
function realizedRhythm(result) {
  const body = result.notes.filter(note => note.slotIndex !== null);
  for (let index = 1; index < body.length; index += 1) {
    if (body[index].slotIndex === body[index - 1].slotIndex && body[index].start - body[index - 1].start === 2) return 'eighths';
  }
  if (HARMONIC_FAMILIES.includes(result.recipe.family) && body.some(note => note.duration > STUDY_TICKS_PER_QUARTER)) return 'arpejo';
  return 'quarters';
}

const DURATION_TOKENS = Object.freeze([[16, 'w'], [12, 'h.'], [8, 'h'], [6, 'q.'], [4, 'q'], [3, 'e.'], [2, 'e'], [1, 's']]);

function durationTokens(ticks) {
  const tokens = [];
  let rest = ticks;
  for (const [length, token] of DURATION_TOKENS) while (rest >= length) { tokens.push(token); rest -= length; }
  return tokens;
}

// Código rítmico REALIZADO do primeiro acorde (todos os blocos dele na
// primeira volta), no formato do catálogo: "q q h | h(lig) pausa_h".
export function rhythmCode(result) {
  const volta = result.slots[0]?.volta ?? 0;
  const blocks = result.slots.filter(slot => slot.chordIndex === result.slots[0]?.chordIndex && slot.volta === volta);
  if (!blocks.length) return null;
  const from = Math.min(...blocks.map(slot => slot.start));
  const to = Math.max(...blocks.map(slot => slot.start + slot.ticks));
  const indexes = new Set(blocks.map(slot => slot.index));
  const notes = result.notes.filter(note => indexes.has(note.slotIndex)).sort((a, b) => a.start - b.start);
  const bars = Array.from({ length: (to - from) / STUDY_TICKS_PER_BAR }, () => []);
  const emit = (start, length, rest) => {
    let time = start;
    let first = true;
    while (time < start + length) {
      const bar = Math.floor((time - from) / STUDY_TICKS_PER_BAR);
      const piece = Math.min(start + length, from + (bar + 1) * STUDY_TICKS_PER_BAR) - time;
      for (const token of durationTokens(piece)) {
        bars[bar].push(rest ? `pausa_${token}` : first ? token : `${token}(lig)`);
        first = false;
      }
      time += piece;
    }
  };
  let cursor = from;
  for (const note of notes) {
    if (note.start > cursor) emit(cursor, note.start - cursor, true);
    emit(note.start, note.duration, false);
    cursor = note.start + note.duration;
  }
  if (cursor < to) emit(cursor, to - cursor, true);
  return bars.map(bar => bar.join(' ')).join(' | ');
}

// Valores DERIVADOS das notas geradas, para conferir com os campos de
// observação do catálogo. `bars` inclui o compasso final; `stringNames` são
// as cordas soltas usadas (G D A E B); `degreeOrder` = graus-base tocados no
// primeiro bloco, na ordem.
export function catalogValues(recipe, { session = null } = {}) {
  const normalized = normalizeRecipe(recipe);
  const result = generateStudy({ ...normalized, bars: null }, { session });
  const stringNames = [...new Set(result.meta.strings.map(string => noteName(stringOpen(normalized.profile, string), { octave: false })))];
  return Object.freeze({
    bars: result.actualBars, strings: result.meta.strings, stringNames: Object.freeze(stringNames), stringCount: normalized.profile.strings,
    minFret: result.meta.minFret, maxFret: result.meta.maxFret, rhythm: realizedRhythm(result), rhythmCode: rhythmCode(result),
    degrees: result.meta.playedDegrees, degreeOrder: Object.freeze(result.meta.degreeOrder.map(degree => DEGREE_STEPS[degree][0])),
    family: result.meta.family, order: result.meta.order, voltas: result.meta.voltas, period: result.period.length,
    capped: result.meta.capped, chordCount: result.meta.chordCount, noteCount: result.meta.noteCount, warnings: result.warningCounts,
  });
}
