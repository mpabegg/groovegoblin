// A4 — Adaptador de sessão do estudo: transforma a receita/resultado do gerador
// (A2) em (1) uma sessão-símile só para a PRÉVIA do diálogo e (2) uma sessão v5
// canônica + metadata do exercício.
//
// Regras do contrato da etapa:
//  - a receita NUNCA entra na sessão: metadata fica fora (`metadata.study`),
//    portanto nada disso aparece em `session.extensions`;
//  - banda desligada (sem baixo automático) e bateria desligada: o estudo é o
//    material, sem acompanhamento por cima;
//  - a harmonia (cifras) É a da receita e fica ligada na sessão: é o que faz
//    "Agora · Próximo" e a avaliação de altura funcionarem no treino normal;
//  - perfil de baixo 4 ou 5 cordas, igual ao pedido na receita.
//
// Módulo sem DOM: a prévia devolve um objeto com os campos que os renderizadores
// existentes leem (`bars`, `meter`, `notes`, `progression`, `extensions.studio`),
// sem passar pela validação estrita da sessão — validar é papel do COMMIT
// (`studyExercise`), que lança com mensagem clara em vez de gravar documento
// inválido.

import { MAX_BARS, SESSION_NAME_MAX, createSession, DEFAULT_BPM } from './session.js';
import { PROGRESSION_KEYS } from './progression.js';
import { instrumentInputPitch, normalizeInstrumentProfile, standardInstrumentProfile } from './instrument-profile.js';
import {
  STUDY_MAX_NOTES, STUDY_QUALITY_IDS, STUDY_TICKS_PER_BAR, canonicalNotes, noteName, studyMetadata,
} from './study-generator.js';
import { recipeTitle } from './study-recipe.js';

const MINOR_QUALITIES = Object.freeze(['minor', 'm7', 'm7b5', 'dim', 'dim7']);
const CYCLE_QUALITY_IDS = STUDY_QUALITY_IDS;

function flatsFor(recipe) {
  if (recipe.progression.spelling === 'bemois') return true;
  if (recipe.progression.spelling === 'sustenidos') return false;
  return /b/.test(String(recipe.progression.start ?? ''));
}

// A receita carrega o perfil MÍNIMO do instrumento (`{type, strings}`), que é o
// que o motor precisa para escolher posições; a SESSÃO exige o perfil completo
// (afinação e nomes das notas). Este é o único ponto de tradução: um perfil já
// completo (o do instrumento ativo, vindo do host) passa como veio, validado.
function sessionProfile(profile) {
  if (!profile) return null;
  if (Array.isArray(profile.tuning)) return normalizeInstrumentProfile(profile);
  const type = profile.type === 'guitar' ? 'guitar' : 'bass';
  const strings = Number.isInteger(profile.strings) ? profile.strings : 4;
  return standardInstrumentProfile(type, strings);
}

// Sessão-símile da prévia: mesmos campos que a sessão real, montada a partir do
// resultado (as notas derivadas `fret`/`string` do gerador são justamente o que a
// tablatura desenha; `canonicalNotes` só é usado no commit).
export function previewSession(result, { phraseView = 'tab', name = 'Prévia do estudo', bpm = DEFAULT_BPM, profile = null } = {}) {
  const instrument = sessionProfile(profile ?? result.recipe.profile);
  return {
    name: fitName(name),
    bpm,
    bars: result.actualBars,
    meter: { beats: 4, unit: 4 },
    subdivision: 4,
    swing: 0,
    swingUnit: 'eighth',
    notes: result.notes,
    progression: progressionFromResult(result),
    loop: { startBar: 0, endBar: result.actualBars },
    band: { bassEnabled: false, style: 'pop', density: 'medium', mode: 'steady', role: 'solo' },
    drums: { enabled: false, seed: 1, style: 'complement', density: 'medium', edits: [] },
    extensions: { studio: { instrument, phraseView } },
  };
}

function fitName(name) {
  const trimmed = String(name ?? '').trim() || 'Estudo';
  return trimmed.length <= SESSION_NAME_MAX ? trimmed : trimmed.slice(0, SESSION_NAME_MAX).trimEnd();
}

// Progressão da sessão a partir de UMA volta do ciclo do estudo: um acorde por
// bloco da receita, cobrindo TODOS os slots daquela volta (as inversões de um
// mesmo acorde somam uma duração só) e com a duração real em compassos. É a
// mesma harmonia que a grade de slots desenha — nada de acorde "médio"
// inventado, e nenhum buraco entre acordes.
export function progressionFromResult(result) {
  const volta0 = result.slots[0]?.volta ?? 0;
  const groups = new Map();
  for (const slot of result.slots) {
    if ((slot.volta ?? volta0) !== volta0) continue;
    const group = groups.get(slot.chordIndex) ?? { start: slot.start, end: slot.start + slot.ticks };
    group.start = Math.min(group.start, slot.start);
    group.end = Math.max(group.end, slot.start + slot.ticks);
    groups.set(slot.chordIndex, group);
  }
  const chords = [];
  let cycleBars = 0;
  let first = null;
  for (const [index, group] of groups) {
    const record = result.chords.find(chord => chord.index === index && chord.final !== true) ?? null;
    if (!record) continue;
    const startBar = group.start / STUDY_TICKS_PER_BAR;
    const durationBars = (group.end - group.start) / STUDY_TICKS_PER_BAR;
    chords.push({
      symbol: record.symbol,
      quality: CYCLE_QUALITY_IDS[record.quality] ?? '',
      root: record.root,
      bass: null,
      inversion: 0,
      degree: null,
      function: 'other',
      source: 'custom',
      startBar,
      durationBars,
      notes: chordNotes(record, result.recipe),
    });
    cycleBars += durationBars;
    if (first === null) first = record;
  }
  return {
    keyId: keyIdFor(first, result.recipe),
    enabled: true,
    cycleBars,
    chords,
  };
}

// Vozes do acorde para a sessão: as mesmas posições que o estudo toca (1 a 8
// notas, teto do formato da sessão). Sem posições desenhadas, a voz é a própria
// fundamental do acorde — nunca uma nota de outro acorde.
function chordNotes(chord, recipe) {
  const flats = flatsFor(recipe);
  const pitches = chord.shape.map(item => item.pitch).slice(0, 8);
  const root = pitches.length ? pitches : [rootPitch(recipe.profile, chord.root)];
  return root.map(pitch => ({ name: noteName(pitch, { octave: false, flats }), midi: pitch }));
}

function rootPitch(profile, root) {
  const low = profile.tuning[0];
  return low + (((root - (low % 12)) % 12) + 12) % 12;
}

function keyIdFor(chord, recipe) {
  if (!chord) return 'c-major';
  const mode = MINOR_QUALITIES.includes(chord.quality) ? 'minor' : 'major';
  return PROGRESSION_KEYS.find(key => key.pitchClass === chord.root && key.mode === mode)?.id ?? 'c-major';
}

// Sessão canônica + bloco `study` da metadata (receita FORA da sessão).
export function studyExercise(result, { profile = null, name = null, bpm = DEFAULT_BPM, origin = null, group = null } = {}) {
  const instrument = sessionProfile(profile ?? result.recipe.profile);
  const title = fitName(name ?? recipeTitle(result.recipe));
  if (result.actualBars > MAX_BARS) {
    throw new RangeError(`O estudo tem ${result.actualBars} compassos; uma sessão aceita até ${MAX_BARS}. Reduza voltas ou o tamanho da figura.`);
  }
  const notes = canonicalNotes(result);
  if (notes.length > STUDY_MAX_NOTES) {
    throw new RangeError(`O estudo tem ${notes.length} notas; uma sessão aceita até ${STUDY_MAX_NOTES}. Reduza voltas, inversões ou notas por acorde.`);
  }
  const progression = progressionFromResult(result);
  if (progression.chords.length > 64) {
    throw new RangeError(`A progressão tem ${progression.chords.length} acordes; uma sessão aceita até 64 por ciclo. Reduza a lista de acordes ou o tamanho do ciclo.`);
  }
  const session = createSession({
    name: title,
    bpm,
    bars: result.actualBars,
    loop: { startBar: 0, endBar: result.actualBars },
    notes,
    progression,
    // Banda OFF explícita: o estudo é tocado por você, sem baixo automático.
    band: { bassEnabled: false, mode: 'steady' },
    drums: { enabled: false },
    timbres: { phrase: instrument.type === 'bass' ? 'electric-bass' : 'clean-guitar' },
    extensions: { studio: { instrument, phraseView: 'tab', inputPitch: instrumentInputPitch(instrument) } },
  });
  return {
    session,
    name: title,
    study: Object.freeze({
      version: result.recipe.version,
      recipe: result.recipe,
      summary: studyMetadata(result),
      origin: origin ?? null,
      group: group ?? null,
    }),
  };
}
