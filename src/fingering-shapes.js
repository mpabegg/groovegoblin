// A3 — Formas de dedilhado NOMEADAS do Braço (rodada 6).
//
// Uma forma é um molde móvel de digitação: a posição relativa de cada grau do
// acorde (corda e deslocamento de casas em relação à tônica), escolhida pelo
// próprio usuário no painel "Braço" e nomeada por ele. Ela vive FORA da sessão
// v5: nenhum campo de `extensions` muda. O documento é um só (localStorage, como
// a biblioteca de exercícios) e está agrupado por INSTRUMENTO + CORDAS
// (`bass4`, `bass5`, `guitar6`) — a numeração de cordas é estável (1 = mais
// aguda), então uma forma escrita no baixo de 4 cordas continua válida no de 5,
// deslocada para começar na corda Si quando for a melhor posição.
//
// Regras duras:
//  - **graus conferidos contra a afinação**: cada nota clicada precisa distar da
//    tônica exatamente o intervalo do grau que declara (1 = 0, 3 = terça da
//    qualidade, 5 = quinta, 7 = sétima, 8/10/12/14 = oitava +1). A raiz pode ser
//    o grau 1 ou a sua oitava (8), como no A2. Uma forma que não fecha é
//    `TypeError`, nunca é guardada "quase certa";
//  - **graus = conjunto das notas**: como o A2 exige, todo grau declarado tem
//    nota e toda nota tem grau declarado; a ORDEM declarada é a ordem da figura;
//  - **nada de curso**: as únicas formas embutidas são 2–3 genéricas
//    (maior, menor, oitava), montadas por construção e validadas contra a
//    afinação padrão de cada instrumento. Nenhum título, id ou material de
//    curso entra aqui;
//  - **o gerador A2 é a autoridade de posição**: `shapeOverlay` delega a
//    `applyShape`, então o que o Braço destaca é exatamente o que o estudo
//    gerado toca (inclusive o deslocamento entre conjuntos de cordas);
//  - **bytes corrompidos não são sobrescritos**: documento ilegível vira
//    `status: 'corrupt'` com `recoveryRaw` preservado e gravação bloqueada até
//    ação explícita;
//  - o documento exportado (`exportDocument`) é o mesmo bloco que vai para o
//    backup privado agregado e que o servidor pode guardar como coleção
//    `forms`.

import { CHORD_QUALITIES } from './progression.js';
import { formatInstrumentNote, normalizeInstrumentProfile, standardInstrumentProfile } from './instrument-profile.js';
// A2 é a autoridade da geometria: a posição da forma no braço é `applyShape`.
import {
  applyShape, STUDY_MAX_FRET, STUDY_MIN_FRET, STUDY_QUALITIES, STUDY_QUALITY_IDS,
} from './study-generator.js';

export const FINGERING_SHAPES_KIND = 'groovegoblin-fingering-shapes';
export const FINGERING_SHAPES_VERSION = 1;
export const FINGERING_SHAPES_KEY = 'groovegoblin-fingering-shapes';
export const SHAPE_LABEL_MAX = 60;
export const SHAPE_MIN_NOTES = 2;   // âncora + ao menos uma nota: uma nota só não é forma
export const SHAPE_MAX_NOTES = 6;
export const SHAPE_DEGREE_OPTIONS = Object.freeze([1, 3, 5, 7, 8]);        // graus que a interface oferece
// Mesmo conjunto do A2 (`DEGREE_STEPS`): o backup pode trazer formas de outra
// origem com graus de oitava mais altos, e elas continuam conferíveis.
const DEGREE_BASE = Object.freeze({ 1: 1, 3: 3, 5: 5, 7: 7, 8: 1, 10: 3, 12: 5, 14: 7 });
const DEGREE_OCTAVE = Object.freeze({ 1: 0, 3: 0, 5: 0, 7: 0, 8: 1, 10: 1, 12: 1, 14: 1 });
export const SHAPE_DEGREES = Object.freeze([1, 3, 5, 7, 8, 10, 12, 14]);
export const SHAPE_DEGREE_LABELS = Object.freeze({
  1: 'T (âncora)', 3: '3ª', 5: '5ª', 7: '7ª', 8: '8ª', 10: '3ª (oitava)', 12: '5ª (oitava)', 14: '7ª (oitava)',
});
export const SHAPE_INSTRUMENTS = Object.freeze(['bass4', 'bass5', 'guitar6']);
const INSTRUMENT_LABELS = Object.freeze({ bass4: 'Baixo 4 cordas', bass5: 'Baixo 5 cordas', guitar6: 'Guitarra 6 cordas' });

// Formas genéricas: escritas na referência de 4 cordas (cordas 4–3–2), deslocadas
// em +2 cordas na guitarra (que acrescenta as duas graves). Nenhuma vem de curso.
// O rótulo é curto de propósito: quem mostra acrescenta o marcador "genérica"
// (a interface do Braço e o diálogo do estudo).
const GENERIC_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'generica-maior', label: 'Tríade maior', quality: 'major', degrees: [1, 3, 5],
    notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }],
  }),
  Object.freeze({
    id: 'generica-menor', label: 'Tríade menor', quality: 'minor', degrees: [1, 3, 5],
    notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 1, degree: 3 }, { string: 3, fret: 5, degree: 5 }],
  }),
  Object.freeze({
    id: 'generica-oitava', label: 'Oitava', quality: 'major', degrees: [1, 5, 8],
    notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 5, degree: 5 }, { string: 2, fret: 5, degree: 8 }],
  }),
]);
const GENERIC_IDS = new Set(GENERIC_DEFINITIONS.map(definition => definition.id));

// -------------------------------------------------------------- utilidades

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

let sequence = 0;
function defaultUuid() {
  sequence += 1;
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `forma-${Date.now().toString(36)}-${sequence}`;
}

function issue(code, message, index = null) {
  return index === null ? { code, message } : { code, message, index };
}

// Perfil completo a partir de um perfil, de um atalho {type,strings} ou do
// identificador de instrumento do documento ('bass4', 'bass5', 'guitar6').
export function asShapeProfile(value = null) {
  if (typeof value === 'string') {
    if (!SHAPE_INSTRUMENTS.includes(value)) throw new TypeError(`Instrumento desconhecido nas formas: ${value}.`);
    const type = value.startsWith('guitar') ? 'guitar' : 'bass';
    const strings = Number(value.slice(-1));
    return standardInstrumentProfile(type, strings);
  }
  if (value === null || value === undefined) return standardInstrumentProfile('bass', 4);
  if (!isObject(value)) throw new TypeError('O perfil do instrumento deve ser um objeto.');
  if (Array.isArray(value.tuning)) return normalizeInstrumentProfile(value);
  const type = value.type ?? 'bass';
  const strings = value.strings ?? (type === 'bass' ? 4 : 6);
  return { ...standardInstrumentProfile(type, strings), noteNames: value.noteNames ?? 'letters' };
}

// 'bass4' | 'bass5' | 'guitar6' — a chave do documento (baixo/cordas).
export function shapeInstrumentId(value) {
  const profile = asShapeProfile(value);
  return `${profile.type}${profile.strings}`;
}

export function shapeInstrumentLabel(id) {
  return INSTRUMENT_LABELS[id] ?? id;
}

// Grupos do documento para um instrumento: mesmo tipo, todas as contagens de
// cordas (o A2 posiciona a forma em qualquer conjunto de cordas compatível, para
// baixo E acima). A ordem é da mais grave para a mais aguda.
export function reuseChain(value) {
  const profile = asShapeProfile(value);
  return SHAPE_INSTRUMENTS.filter(id => id.startsWith(profile.type))
    .sort((a, b) => Number(a.slice(-1)) - Number(b.slice(-1)));
}

// Intervalo (em semitons, a partir da âncora) de um grau dentro de uma
// qualidade — espelha o `degreeSemitone` do A2, inclusive a sétima estendida
// das tríades (nunca uma altura arbitrária).
export function degreeInterval(quality, degree) {
  if (!STUDY_QUALITIES.includes(quality)) throw new TypeError(`Qualidade desconhecida: ${quality}.`);
  const base = DEGREE_BASE[degree];
  if (!Number.isInteger(degree) || base === undefined) throw new TypeError(`Grau ${degree} não suportado; use ${SHAPE_DEGREE_OPTIONS.join(', ')}.`);
  const tones = CHORD_QUALITIES[STUDY_QUALITY_IDS[quality]].map(([semitone], index) => ({ degree: [1, 3, 5, 7][index], semitone }));
  const tone = tones.find(item => item.degree === base);
  let semitone;
  if (tone) semitone = tone.semitone;
  else if (quality === 'dim') semitone = 9;
  else semitone = tones.some(item => item.degree === 3 && item.semitone === 3) ? 10 : 11;
  return semitone + 12 * DEGREE_OCTAVE[degree];
}

function stringOpen(profile, string) {
  return profile.tuning[profile.strings - string];
}

function noteKey(string, fret) {
  return `${string}:${fret}`;
}

// ------------------------------------------------------------- validação

// Conferência completa e NÃO lançante: a interface mostra o motivo exato de cada
// clique antes de salvar. `notes` volta com altura, distância da âncora e o
// intervalo esperado do grau declarado.
export function checkShape(value, { profile = null } = {}) {
  const errors = [];
  if (!isObject(value)) {
    return { ok: false, errors: [issue('forma', 'A forma deve ser um objeto com qualidade, graus e notas.')], notes: [], instrument: null, anchor: null, degrees: [] };
  }
  const unknown = Object.keys(value).filter(key => !['id', 'label', 'quality', 'degrees', 'notes'].includes(key));
  if (unknown.length) errors.push(issue('campo', `Campo desconhecido na forma: ${unknown[0]}.`));
  const id = value.id ?? null;
  if (id !== null && (typeof id !== 'string' || id.length === 0)) errors.push(issue('id', 'O identificador da forma deve ser texto.'));
  const quality = value.quality ?? 'major';
  if (!STUDY_QUALITIES.includes(quality)) errors.push(issue('qualidade', `Qualidade de forma inválida: ${quality}.`));
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  if (value.label !== undefined && value.label !== null && typeof value.label !== 'string') errors.push(issue('nome', 'O nome da forma deve ser texto.'));
  else if (label.length === 0) errors.push(issue('nome', 'Dê um nome à forma.'));
  else if (label.length > SHAPE_LABEL_MAX) errors.push(issue('nome', `O nome da forma admite até ${SHAPE_LABEL_MAX} caracteres.`));

  let instrument = null;
  let resolved = null;
  try {
    resolved = asShapeProfile(profile);
    instrument = `${resolved.type}${resolved.strings}`;
  } catch (error) {
    errors.push(issue('instrumento', error.message));
  }

  const list = Array.isArray(value.notes) ? value.notes : null;
  if (!list || list.length === 0) errors.push(issue('sem-notas', 'Clique as notas da forma no braço.'));
  else if (list.length < SHAPE_MIN_NOTES) errors.push(issue('sem-notas', `Uma forma precisa da âncora e de ao menos ${SHAPE_MIN_NOTES - 1} outra nota.`));
  else if (list.length > SHAPE_MAX_NOTES) errors.push(issue('limite-notas', `Uma forma admite até ${SHAPE_MAX_NOTES} notas; remova ${list.length - SHAPE_MAX_NOTES}.`));

  const notes = [];
  const seen = new Set();
  const structural = [];
  for (const [index, note] of (list ?? []).entries()) {
    if (!isObject(note)) { errors.push(issue('nota', 'Cada nota precisa de corda, casa e grau.', index)); structural.push(null); continue; }
    const unknownNote = Object.keys(note).filter(key => !['string', 'fret', 'degree'].includes(key));
    if (unknownNote.length) errors.push(issue('campo', `Campo desconhecido na nota da forma: ${unknownNote[0]}.`, index));
    const { string, fret, degree } = note;
    let broken = false;
    if (!Number.isInteger(string) || string < 1 || (resolved && string > resolved.strings)) {
      errors.push(issue('corda', `A corda ${string} não existe neste instrumento (1 a ${resolved ? resolved.strings : 8}).`, index));
      broken = true;
    }
    if (!Number.isInteger(fret) || fret < STUDY_MIN_FRET || fret > STUDY_MAX_FRET) {
      errors.push(issue('casa', `A casa ${fret} está fora do braço (${STUDY_MIN_FRET} a ${STUDY_MAX_FRET}).`, index));
      broken = true;
    }
    if (!Number.isInteger(degree) || DEGREE_BASE[degree] === undefined) {
      errors.push(issue('grau', `Grau ${degree} não suportado na forma (${SHAPE_DEGREES.join(', ')}).`, index));
      broken = true;
    }
    if (!broken && seen.has(noteKey(string, fret))) {
      errors.push(issue('duplicada', `A corda ${string} na casa ${fret} aparece duas vezes.`, index));
      broken = true;
    }
    if (!broken) seen.add(noteKey(string, fret));
    structural.push(broken || !resolved ? null : { string, fret, degree });
  }

  const roots = structural.filter(note => note !== null && (note.degree === 1 || note.degree === 8));
  if (structural.some(note => note !== null) && roots.length === 0) errors.push(issue('ancora', 'Marque a tônica (grau 1) ou a sua oitava (grau 8): a forma precisa de uma raiz.'));
  // A âncora é a entrada de grau 1; sem ela, a oitava da tônica (grau 8) vale
  // como raiz — o A2 aceita as duas, e a forma continua conferível assim.
  const anchor = structural.find(note => note !== null && note.degree === 1) ?? roots[0] ?? null;

  const degrees = [];
  const rawDegrees = value.degrees === undefined || value.degrees === null ? structural.filter(Boolean).map(note => note.degree) : value.degrees;
  if (!Array.isArray(rawDegrees) || rawDegrees.length === 0) errors.push(issue('graus', 'Escolha os graus da forma.'));
  else {
    for (const degree of rawDegrees) {
      if (!Number.isInteger(degree) || DEGREE_BASE[degree] === undefined) { errors.push(issue('graus', `Grau ${degree} não suportado na forma.`)); continue; }
      if (degrees.includes(degree)) { errors.push(issue('graus', `O grau ${degree} aparece duas vezes.`)); continue; }
      degrees.push(degree);
    }
    if (degrees.length > 0 && !degrees.some(degree => degree === 1 || degree === 8)) errors.push(issue('graus', 'Os graus da forma incluem a raiz (grau 1 ou 8).'));
    // O A2 exige que os graus da figura sejam EXATAMENTE os graus das notas da
    // forma: um grau marcado sem nota é recusado aqui, com o motivo. A ORDEM
    // declarada é preservada — é ela que a figura do gerador usa.
    for (const degree of degrees) {
      if (!structural.some(note => note !== null && note.degree === degree)) {
        errors.push(issue('graus', `O grau ${degree} (${SHAPE_DEGREE_LABELS[degree] ?? degree}) está marcado, mas nenhuma nota clicada o usa. Clique a nota desse grau ou tire-o da forma.`));
      }
    }
  }

  const tonicPitch = anchor && resolved ? stringOpen(resolved, anchor.string) + anchor.fret - (anchor.degree === 8 ? 12 : 0) : null;
  if (tonicPitch !== null) {
    structural.forEach((note, index) => {
      if (!note) return;
      if (!degrees.includes(note.degree)) errors.push(issue('graus', `A nota da corda ${note.string} casa ${note.fret} usa o grau ${note.degree}, fora dos graus escolhidos.`, index));
      const pitch = stringOpen(resolved, note.string) + note.fret;
      const offset = pitch - tonicPitch;
      let expected = null;
      try { expected = degreeInterval(quality, note.degree); } catch (error) { errors.push(issue('grau', error.message, index)); }
      // Raiz (grau 1 ou 8, como no A2): qualquer oitava exata da tônica vale —
      // uma tônica dobrada não é um grau errado.
      const isRoot = note.degree === 1 || note.degree === 8;
      const degreeOk = expected !== null && (isRoot ? offset % 12 === 0 : expected === offset);
      if (!degreeOk && expected !== null) {
        errors.push(issue('intervalo', isRoot
          ? `${formatInstrumentNote(pitch, resolved)} está a ${offset} semitom(ns) da tônica; o grau ${note.degree} (${SHAPE_DEGREE_LABELS[note.degree] ?? note.degree}) precisa de uma oitava exata.`
          : `${formatInstrumentNote(pitch, resolved)} está a ${offset} semitom(ns) da tônica, mas o grau ${note.degree} (${SHAPE_DEGREE_LABELS[note.degree] ?? note.degree}) dista ${expected}.`, index));
      }
      notes.push({ ...note, pitch, offset, expected, degreeOk });
    });
  }

  return { ok: errors.length === 0, errors, notes, instrument, anchor, tonicPitch, degrees };
}

// Igual a `checkShape`, mas lança na primeira falha (convenção do projeto:
// TypeError em português, nunca um registro parcial).
export function normalizeShape(value, options = {}) {
  const report = checkShape(value, options);
  if (!report.ok) throw new TypeError(report.errors[0].message);
  const label = String(value.label).trim();
  return Object.freeze({
    id: value.id ?? null,
    label,
    quality: value.quality ?? 'major',
    degrees: Object.freeze([...report.degrees]),
    notes: Object.freeze(report.notes.map(note => Object.freeze({ string: note.string, fret: note.fret, degree: note.degree }))),
  });
}

// Forma pronta para o gerador A2: só as cinco chaves que `normalizeShape` do A2
// aceita (as marcações da interface — instrumento, genérica, reutilizada — não
// vão para a receita).
export function toGeneratorShape(value) {
  if (!isObject(value)) throw new TypeError('A forma deve ser um objeto.');
  return {
    id: value.id ?? null,
    label: value.label ?? null,
    quality: value.quality ?? 'major',
    degrees: Array.isArray(value.degrees) ? [...value.degrees] : [...new Set((value.notes ?? []).map(note => note?.degree))],
    notes: (value.notes ?? []).map(note => ({ string: note.string, fret: note.fret, degree: note.degree })),
  };
}

// "Cabe neste instrumento?" = existe posição para a forma nesta afinação. Quem
// responde é o posicionador do A2 (que também move a forma entre conjuntos de
// cordas, ex.: usar a corda Si do baixo 5), nunca uma conta paralela daqui.
export function applicableTo(value, profile) {
  const resolved = asShapeProfile(profile);
  const notes = Array.isArray(value?.notes) ? value.notes : null;
  if (!notes || notes.length === 0) return false;
  if (!notes.some(note => note.degree === 1 || note.degree === 8)) return false;
  // Alguma fundamental posiciona a forma? (O A2 move a forma entre conjuntos de
  // cordas; o deslocamento pode trocar a classe de altura da âncora.)
  for (let root = 0; root < 12; root += 1) {
    try {
      const placed = applyShape(resolved, value, { root, notes: [] }, { from: STUDY_MIN_FRET, to: STUDY_MAX_FRET, open: true, strings: null });
      if (placed.positions !== null) return true;
    } catch { /* esta fundamental não serve; tenta a próxima */ }
  }
  return false;
}

// Posição absoluta da forma para uma fundamental, com a MESMA geometria do
// gerador (A2 `applyShape`). As notas voltam com corda, casa, grau e altura.
export function shapeOverlay(value, profile, root, region = null) {
  if (!isObject(value) || !Array.isArray(value.notes) || value.notes.length === 0) throw new TypeError('Informe a forma com as notas clicadas.');
  const rootPitch = Number.isInteger(root) ? ((root % 12) + 12) % 12 : null;
  if (rootPitch === null) throw new TypeError('Informe a fundamental (0–11) para posicionar a forma.');
  const resolved = asShapeProfile(profile);
  if (!(value.notes ?? []).some(note => note.degree === 1 || note.degree === 8)) throw new TypeError('A forma precisa de uma raiz (grau 1 ou 8).');
  const window = { from: STUDY_MIN_FRET, to: STUDY_MAX_FRET, open: true, strings: null, ...(region ?? {}) };
  const placed = applyShape(resolved, value, { root: rootPitch, notes: [] }, window);
  return Object.freeze({
    root: rootPitch,
    positions: placed.positions ?? null,
    expansion: placed.expansion ?? null,
    // Campos que o A2 acrescentou (conjunto de cordas, graus conferidos, motivo).
    inside: placed.inside ?? null,
    stringShift: placed.stringShift ?? 0,
    degreesOk: placed.degreesOk ?? null,
    reason: placed.reason ?? null,
  });
}

// --------------------------------------------------- formas genéricas

// As 2–3 genéricas (maior, menor, oitava), já validadas contra a afinação padrão
// do instrumento. Nunca vêm de curso e nunca são gravadas no documento.
export function genericShapes(value = null) {
  const profile = asShapeProfile(value);
  const shift = profile.type === 'guitar' ? profile.strings - 4 : 0;
  return Object.freeze(GENERIC_DEFINITIONS.map(definition => {
    const shape = {
      id: definition.id,
      label: definition.label,
      quality: definition.quality,
      degrees: [...definition.degrees],
      notes: definition.notes.map(note => ({ ...note, string: note.string + shift })),
    };
    const report = checkShape(shape, { profile });
    if (!report.ok) throw new Error(`Forma genérica inválida para ${profile.type}: ${report.errors[0].message}`);
    return Object.freeze({
      ...shape,
      degrees: Object.freeze(shape.degrees),
      notes: Object.freeze(shape.notes.map(note => Object.freeze(note))),
      instrument: `${profile.type}${profile.strings}`,
      generic: true,
      reused: false,
      applicable: true,
    });
  }));
}

export function isGenericShape(value) {
  return GENERIC_IDS.has(value?.id ?? null);
}

// ------------------------------------------------------------- documento

function emptyDocument() {
  return Object.freeze({ version: FINGERING_SHAPES_VERSION, instruments: Object.freeze({}) });
}

function freezeGroups(groups) {
  const instruments = {};
  for (const [id, shapes] of Object.entries(groups)) instruments[id] = Object.freeze([...shapes]);
  return Object.freeze({ version: FINGERING_SHAPES_VERSION, instruments: Object.freeze(instruments) });
}

// Validação estrita do documento inteiro (load/import do backup). Lança com o
// primeiro problema: nada é aceito "quase certo".
export function validateShapeDocument(value) {
  if (!isObject(value)) throw new TypeError('O documento de formas deve ser um objeto.');
  const unknown = Object.keys(value).filter(key => !['version', 'instruments'].includes(key));
  if (unknown.length) throw new TypeError(`Campo desconhecido no documento de formas: ${unknown[0]}.`);
  if (value.version !== FINGERING_SHAPES_VERSION) throw new TypeError('Versão do documento de formas não suportada.');
  if (!isObject(value.instruments)) throw new TypeError('O documento de formas precisa dos instrumentos.');
  const groups = {};
  for (const [id, shapes] of Object.entries(value.instruments)) {
    if (!SHAPE_INSTRUMENTS.includes(id)) throw new TypeError(`Instrumento desconhecido nas formas: ${id}.`);
    if (!Array.isArray(shapes)) throw new TypeError(`As formas de ${id} devem ser uma lista.`);
    const ids = new Set();
    groups[id] = shapes.map(shape => {
      const normalized = normalizeShape(shape, { profile: id });
      if (ids.has(normalized.id)) throw new TypeError(`A forma ${normalized.id} aparece duas vezes em ${id}.`);
      ids.add(normalized.id);
      return normalized;
    });
  }
  return freezeGroups(groups);
}

// ------------------------------------------------------------- loja

function readTarget(candidate) {
  try {
    const target = candidate === undefined ? globalThis.localStorage : candidate;
    if (target && typeof target.getItem === 'function' && typeof target.setItem === 'function') return target;
  } catch { /* acesso bloqueado: memória volátil */ }
  return null;
}

// Loja das formas nomeadas. Como a biblioteca de exercícios: estado em memória
// sempre utilizável, persistência best-effort e bytes corrompidos preservados.
export function createFingeringShapeStore({ storage, uuid = defaultUuid } = {}) {
  const target = readTarget(storage);
  const listeners = new Set();
  let status = target === null ? 'unavailable' : 'ready';
  let warning = target === null ? 'As formas de dedilhado não podem ser guardadas neste navegador; elas valem só nesta visita.' : null;
  let recoveryRaw = null;
  let persistent = target !== null;
  let revision = 0;
  let document_ = emptyDocument();

  function emit() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* um assinante quebrado não derruba a loja */ }
    }
  }

  function persist() {
    if (status !== 'ready' || target === null) return false;
    try {
      target.setItem(FINGERING_SHAPES_KEY, JSON.stringify(document_));
      warning = null;
      persistent = true;
      return true;
    } catch {
      warning = 'Não foi possível guardar as formas neste navegador (sem espaço?); elas continuam nesta visita.';
      persistent = false;
      return false;
    }
  }

  function load() {
    if (target === null) return;
    let raw = null;
    try { raw = target.getItem(FINGERING_SHAPES_KEY); } catch {
      status = 'unavailable';
      warning = 'As formas de dedilhado não podem ser lidas neste navegador; elas valem só nesta visita.';
      return;
    }
    if (raw === null) return;
    try {
      document_ = validateShapeDocument(JSON.parse(raw));
    } catch {
      // Nunca sobrescreve bytes ilegíveis: ficam recuperáveis até ação explícita.
      status = 'corrupt';
      recoveryRaw = raw;
      warning = 'As formas guardadas estão ilegíveis: os bytes originais foram preservados. Baixe-os e recomece para gravar de novo.';
    }
  }

  function group(id) {
    return document_.instruments[id] ?? Object.freeze([]);
  }

  // A conferência "cabe neste instrumento?" chama o posicionador do A2; a lista
  // fica memorizada por (perfil, revisão) para o desenho do Braço não repetir a
  // conta a cada repintura.
  let listCache = { key: '', rows: Object.freeze([]) };
  function list(profile = null) {
    const own = shapeInstrumentId(profile);
    const resolved = asShapeProfile(profile);
    const key = JSON.stringify([own, resolved.tuning, revision]);
    if (key === listCache.key) return listCache.rows;
    const rows = [];
    for (const shape of genericShapes(resolved)) rows.push(Object.freeze({ ...shape, instrument: own, reused: false }));
    for (const id of reuseChain(resolved)) {
      for (const shape of group(id)) {
        rows.push(Object.freeze({
          ...shape,
          instrument: id,
          generic: false,
          reused: id !== own,
          applicable: applicableTo(shape, resolved),
        }));
      }
    }
    listCache = { key, rows: Object.freeze(rows) };
    return listCache.rows;
  }

  function find(id, profile = null) {
    const own = shapeInstrumentId(profile);
    for (const shape of group(own)) if (shape.id === id) return shape;
    for (const shape of genericShapes(own)) if (shape.id === id) return shape;
    return null;
  }

  // Nenhuma mutação grava enquanto os bytes guardados estiverem ilegíveis: o
  // usuário baixa os originais e recomeça (ação explícita), em vez de perder a
  // única cópia em silêncio.
  function requireWritable() {
    if (status === 'corrupt') throw new Error('As formas guardadas estão ilegíveis; baixe os bytes originais e recomece antes de salvar.');
  }

  // Salva (cria/atualiza) conferindo os graus contra a AFINAÇÃO PADRÃO do grupo
  // de destino: a forma é reutilizável, então a geometria canônica é a da
  // afinação padrão do grupo — afinações alternativas são avisadas na interface.
  // `group` mantém a forma no instrumento de origem quando ela é editada a
  // partir de outra sessão (ex.: forma do baixo 4 usada no baixo 5).
  function save(value, profile = null, { group: targetGroup = null } = {}) {
    requireWritable();
    const id = targetGroup ?? shapeInstrumentId(profile);
    if (!SHAPE_INSTRUMENTS.includes(id)) throw new TypeError(`Instrumento desconhecido nas formas: ${id}.`);
    const canonical = asShapeProfile(id);
    const normalized = normalizeShape(value, { profile: canonical });
    const shapeId = normalized.id === null || GENERIC_IDS.has(normalized.id) ? `${id}-${uuid()}` : normalized.id;
    const record = Object.freeze({ ...normalized, id: shapeId });
    const shapes = group(id);
    const index = shapes.findIndex(shape => shape.id === shapeId);
    const next = index >= 0 ? shapes.map((shape, position) => (position === index ? record : shape)) : [...shapes, record];
    document_ = freezeGroups({ ...document_.instruments, [id]: next });
    revision += 1;
    persist();
    emit();
    return record;
  }

  function remove(id, profile = null) {
    if (status === 'corrupt') return false;
    const own = shapeInstrumentId(profile);
    const shapes = group(own);
    const next = shapes.filter(shape => shape.id !== id);
    if (next.length === shapes.length) return false;
    const groups = { ...document_.instruments };
    if (next.length === 0) delete groups[own];
    else groups[own] = next;
    document_ = freezeGroups(groups);
    revision += 1;
    persist();
    emit();
    return true;
  }

  function exportDocument() {
    const instruments = {};
    for (const [id, shapes] of Object.entries(document_.instruments)) instruments[id] = shapes.map(shape => ({ ...shape }));
    return { version: FINGERING_SHAPES_VERSION, instruments };
  }

  // União idempotente: mesmo id e mesmo conteúdo não duplica; mesmo id com
  // conteúdo diferente entra como forma NOVA (id próprio) — nada é sobrescrito
  // em silêncio. Formas inválidas são recusadas com o motivo, sem derrubar o
  // resto do documento.
  function importDocument(value) {
    const errors = [];
    if (status === 'corrupt') return { ok: false, added: 0, reused: 0, renamed: 0, errors: [issue('documento', 'As formas guardadas estão ilegíveis; baixe os bytes originais e recomece antes de importar. Nada foi importado.')] };
    if (!isObject(value)) return { ok: false, added: 0, reused: 0, renamed: 0, errors: [issue('documento', 'O documento de formas deve ser um objeto.')] };
    if (value.version !== FINGERING_SHAPES_VERSION) errors.push(issue('documento', 'Versão do documento de formas não suportada; as formas foram conferidas uma a uma.'));
    if (!isObject(value.instruments)) return { ok: false, added: 0, reused: 0, renamed: 0, errors: [...errors, issue('documento', 'O documento de formas precisa dos instrumentos.')] };
    const groups = { ...document_.instruments };
    let added = 0;
    let reused = 0;
    let renamed = 0;
    for (const [id, shapes] of Object.entries(value.instruments)) {
      if (!SHAPE_INSTRUMENTS.includes(id)) { errors.push(issue('instrumento', `Instrumento desconhecido nas formas: ${id}.`)); continue; }
      if (!Array.isArray(shapes)) { errors.push(issue('instrumento', `As formas de ${id} devem ser uma lista.`)); continue; }
      for (const raw of shapes) {
        let normalized;
        try {
          normalized = normalizeShape(raw, { profile: id });
        } catch (error) {
          errors.push(issue('forma', `${id}: ${error.message}`));
          continue;
        }
        const current = groups[id] ?? [];
        const existingIndex = current.findIndex(shape => shape.id === normalized.id);
        if (existingIndex >= 0 && JSON.stringify(current[existingIndex]) === JSON.stringify(normalized)) { reused += 1; continue; }
        const shapeId = existingIndex >= 0 ? `${id}-${uuid()}` : normalized.id;
        if (existingIndex >= 0) renamed += 1;
        else added += 1;
        groups[id] = [...current, Object.freeze({ ...normalized, id: shapeId })];
      }
    }
    if (added > 0 || renamed > 0) {
      document_ = freezeGroups(groups);
      revision += 1;
      persist();
      emit();
    }
    return { ok: errors.length === 0, added, reused, renamed, errors };
  }

  // Ação explícita depois de baixar os bytes: recomeça vazio (a recuperação
  // continua disponível em `recoveryRaw`).
  function discardCorrupt() {
    if (status !== 'corrupt') return false;
    status = 'ready';
    warning = null;
    document_ = emptyDocument();
    revision += 1;
    persist();
    emit();
    return true;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Assinante da loja de formas inválido.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  load();

  return {
    get status() { return status; },
    get warning() { return warning; },
    get recoveryRaw() { return recoveryRaw; },
    get persistent() { return persistent; },
    get kind() { return FINGERING_SHAPES_KIND; },
    get version() { return FINGERING_SHAPES_VERSION; },
    list,
    generics: profile => genericShapes(profile),
    find,
    group,
    save,
    remove,
    exportDocument,
    importDocument,
    discardCorrupt,
    subscribe,
    shapeOverlay: (value, profile, root, region) => shapeOverlay(value, profile, root, region),
    applicableTo,
  };
}

// Loja compartilhada (o Estúdio e o diálogo de backup usam a mesma instância; o
// futuro estudo da Biblioteca A4 importa daqui, sem passar pelo main.js).
let sharedStore = null;
export function sharedFingeringShapeStore(options) {
  if (sharedStore === null) sharedStore = createFingeringShapeStore(options);
  return sharedStore;
}
export function resetSharedFingeringShapeStore() {
  sharedStore = null;
}
