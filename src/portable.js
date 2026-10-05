// Leitores do formato legado groovegoblin-phrase v1 (arquivo e link #phrase=).
// Exportação e compartilhamento atuais usam a sessão v5 (session.js), que
// chama estes leitores para migrar arquivos e links antigos com rigor.
import { validPhrase } from './model.js';

export const PORTABLE_FORMAT = 'groovegoblin-phrase';
export const PORTABLE_VERSION = 1;

const LEGACY_BAR_OPTIONS = [1, 2, 4];
const DOCUMENT_KEYS = ['format', 'version', 'bpm', 'bars', 'notes'];
const NOTE_KEYS = ['id', 'start', 'duration'];
const SHARE_PREFIX = '#phrase=';
const SHARE_MAX_LENGTH = 32768;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function isValidBpm(bpm) {
  return Number.isInteger(bpm) && bpm >= 40 && bpm <= 240;
}

// v1 tinha somente ticks inteiros de semicolcheia em 4/4.
function hasValidNotes(notes, bars) {
  return validPhrase(notes, bars) && notes.every((note) => (
    hasOnlyKeys(note, NOTE_KEYS) && NOTE_KEYS.every((key) => Object.hasOwn(note, key))
    && Number.isInteger(note.start) && Number.isInteger(note.duration) && note.duration >= 1
  ));
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

  const bars = Object.hasOwn(document, 'bars') ? document.bars : 1;
  if (!LEGACY_BAR_OPTIONS.includes(bars)) {
    return { ok: false, error: 'A frase deve ter 1, 2 ou 4 compassos.' };
  }
  if (!hasValidNotes(document.notes, bars)) {
    return { ok: false, error: 'As notas da frase são inválidas, se sobrepõem ou excedem os compassos.' };
  }

  return { ok: true, notes: document.notes, bpm: document.bpm, bars };
}

// Apenas valida: aplicar a frase e persistir o estado são decisões do consumidor.
export function parseShare(hash) {
  if (typeof hash !== 'string' || !hash.startsWith(SHARE_PREFIX)) {
    return { ok: false, error: 'O fragmento não contém um link de frase reconhecido.' };
  }
  const encoded = hash.slice(SHARE_PREFIX.length);
  if (encoded.length > SHARE_MAX_LENGTH) {
    return { ok: false, error: 'A frase excede o limite de 32768 caracteres do link compartilhado.' };
  }
  let text;
  try {
    text = decodeURIComponent(encoded);
  } catch {
    return { ok: false, error: 'Não foi possível ler o link: a codificação é inválida.' };
  }
  return parsePhrase(text);
}
