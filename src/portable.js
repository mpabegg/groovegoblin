import { BAR_OPTIONS, DEFAULT_BARS, validPhrase } from './model.js';

export const PORTABLE_FORMAT = 'groovegoblin-phrase';
export const PORTABLE_VERSION = 1;

const DOCUMENT_KEYS = ['format', 'version', 'bpm', 'bars', 'notes'];
const NOTE_KEYS = ['id', 'start', 'duration'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function isValidBpm(bpm) {
  return Number.isInteger(bpm) && bpm >= 40 && bpm <= 240;
}

function hasValidNotes(notes, bars) {
  return validPhrase(notes, bars) && notes.every((note) => (
    hasOnlyKeys(note, NOTE_KEYS) && NOTE_KEYS.every((key) => Object.hasOwn(note, key))
  ));
}

// Exporta somente o estado portátil, sem mutar nem reordenar as notas/IDs.
// As notas também são estritas na exportação, evitando perda silenciosa de dados.
export function serializePhrase(state) {
  if (!isObject(state) || !isValidBpm(state.bpm) || !BAR_OPTIONS.includes(state.bars)
      || !hasValidNotes(state.notes, state.bars)) {
    throw new TypeError('A frase deve conter notas válidas, BPM inteiro entre 40 e 240 e 1, 2 ou 4 compassos.');
  }

  return JSON.stringify({
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    bpm: state.bpm,
    bars: state.bars,
    notes: state.notes.map(({ id, start, duration }) => ({ id, start, duration })),
  }, null, 2);
}

// Importação atômica: só entrega estado após validar o documento inteiro.
// Arquivos da versão 1 sem "bars" representam um compasso (retrocompatibilidade).
// Erros de sintaxe não expõem mensagens internas do parser JSON ao usuário.
export function parsePhrase(text) {
  if (typeof text !== 'string') {
    return { ok: false, error: 'O conteúdo da frase deve ser um texto JSON.' };
  }

  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Não foi possível ler o arquivo: o JSON é inválido.' };
  }

  if (!hasOnlyKeys(document, DOCUMENT_KEYS)
      || !['format', 'version', 'bpm', 'notes'].every((key) => Object.hasOwn(document, key))) {
    return { ok: false, error: 'O arquivo deve conter apenas os campos esperados de uma frase.' };
  }
  if (document.format !== PORTABLE_FORMAT) {
    return { ok: false, error: 'O arquivo não está no formato de frase do GrooveGoblin.' };
  }
  if (!Number.isInteger(document.version) || document.version !== PORTABLE_VERSION) {
    return { ok: false, error: 'A versão do arquivo de frase não é compatível.' };
  }
  if (!isValidBpm(document.bpm)) {
    return { ok: false, error: 'O BPM deve ser um número inteiro entre 40 e 240.' };
  }

  const bars = Object.hasOwn(document, 'bars') ? document.bars : DEFAULT_BARS;
  if (!BAR_OPTIONS.includes(bars)) {
    return { ok: false, error: 'A frase deve ter 1, 2 ou 4 compassos.' };
  }
  if (!hasValidNotes(document.notes, bars)) {
    return { ok: false, error: 'As notas da frase são inválidas, se sobrepõem ou excedem os compassos.' };
  }

  return { ok: true, notes: document.notes, bpm: document.bpm, bars };
}
