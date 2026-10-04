// Pacote portátil de tarefa (arquivo JSON, sem servidor): sessão + objetivo +
// marcadores/comentários da referência + exercícios e, opcionalmente, o áudio de
// referência embutido em base64. Importação estrita e atômica.

import { normalizeMarker, normalizeExercise, normalizeRegion } from './repertoire.js';

export const PACKAGE_FORMAT = 'groovegoblin-assignment';
export const PACKAGE_VERSION = 1;
export const PACKAGE_EXTENSION = '.groovegoblin.json';
export const MAX_EMBEDDED_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_PACKAGE_CHARS = Math.ceil(MAX_EMBEDDED_AUDIO_BYTES * 4 / 3) + 4 * 1024 * 1024;

const TOP_KEYS = ['format', 'version', 'createdAt', 'title', 'objective', 'session', 'reference', 'exercises', 'audio'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
  return btoa(binary);
}

export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function referenceFromItem(item) {
  return {
    id: item.id,
    name: item.name,
    duration: item.duration,
    sampleRate: item.sampleRate,
    channels: item.channels,
    mimeType: item.media?.mimeType ?? '',
    fileName: item.media?.fileName ?? '',
    region: item.region,
    markers: item.markers,
    tempo: item.tempo,
    chords: item.chords.filter(chord => chord.edited || chord.confidence >= 0.5).map(({ start, end, label, confidence, edited }) => ({ start, end, label, confidence, edited })),
    note: item.note,
  };
}

export function createAssignmentPackage({ title, objective = '', session = null, item = null, exercises = [], audio = null }) {
  const name = typeof title === 'string' ? title.trim().slice(0, 200) : '';
  if (!name) throw new RangeError('Dê um título à tarefa.');
  if (audio && (!(audio.bytes instanceof Uint8Array) || audio.bytes.length > MAX_EMBEDDED_AUDIO_BYTES)) {
    throw new RangeError(`O áudio embutido deve ter no máximo ${Math.round(MAX_EMBEDDED_AUDIO_BYTES / 1024 / 1024)} MB; compartilhe sem áudio e envie o arquivo separadamente.`);
  }
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    createdAt: new Date().toISOString(),
    title: name,
    objective: String(objective).slice(0, 5000),
    session: isObject(session) ? structuredClone(session) : null,
    reference: item ? referenceFromItem(item) : null,
    exercises: exercises.map(exercise => ({ ...exercise, practice: undefined })),
    audio: audio ? { mimeType: audio.mimeType || 'application/octet-stream', fileName: audio.fileName || '', size: audio.bytes.length, data: bytesToBase64(audio.bytes) } : null,
  };
}

export function serializePackage(pkg) {
  return JSON.stringify(pkg, null, pkg.audio ? 0 : 2);
}

function fail(error) {
  return { ok: false, error };
}

function validReference(raw) {
  if (raw === null) return { ok: true, value: null };
  if (!isObject(raw)) return fail('A referência do pacote é inválida.');
  if (!Number.isFinite(raw.duration) || raw.duration <= 0 || raw.duration > 6 * 3600) return fail('A duração da referência é inválida.');
  if (raw.markers !== undefined && !Array.isArray(raw.markers)) return fail('Os marcadores da referência devem ser uma lista.');
  const markers = (raw.markers ?? []).map(marker => normalizeMarker(marker, raw.duration));
  if (markers.some(marker => !marker)) return fail('Há marcadores inválidos ou fora da duração da referência.');
  if (markers.length > 500) return fail('O pacote tem marcadores demais (limite de 500).');
  const chords = Array.isArray(raw.chords) ? raw.chords : [];
  if (!chords.every(chord => isObject(chord) && Number.isFinite(chord.start) && Number.isFinite(chord.end) && typeof chord.label === 'string')) {
    return fail('Os acordes anotados da referência são inválidos.');
  }
  const tempo = isObject(raw.tempo) && Number.isFinite(raw.tempo.bpm) ? {
    bpm: raw.tempo.bpm,
    offset: Number.isFinite(raw.tempo.offset) ? raw.tempo.offset : 0,
    beatsPerBar: Number.isInteger(raw.tempo.beatsPerBar) ? raw.tempo.beatsPerBar : 4,
    beatUnit: [2, 4, 8, 16].includes(raw.tempo.beatUnit) ? raw.tempo.beatUnit : 4,
    meterSource: ['studio', 'manual', 'default'].includes(raw.tempo.meterSource) ? raw.tempo.meterSource : 'manual',
    source: ['analysis', 'manual', 'tap'].includes(raw.tempo.source) ? raw.tempo.source : 'manual',
  } : null;
  return {
    ok: true,
    value: {
      id: typeof raw.id === 'string' ? raw.id.slice(0, 120) : null,
      name: typeof raw.name === 'string' ? raw.name.slice(0, 200) : 'Referência',
      duration: raw.duration,
      sampleRate: Number.isFinite(raw.sampleRate) ? raw.sampleRate : 0,
      channels: Number.isInteger(raw.channels) ? raw.channels : 0,
      mimeType: typeof raw.mimeType === 'string' ? raw.mimeType.slice(0, 100) : '',
      fileName: typeof raw.fileName === 'string' ? raw.fileName.slice(0, 200) : '',
      region: normalizeRegion(raw.region, raw.duration),
      markers,
      tempo,
      chords: chords.slice(0, 5000).map(chord => ({ start: chord.start, end: chord.end, label: chord.label.slice(0, 24), confidence: Number.isFinite(chord.confidence) ? chord.confidence : 0, alternatives: [], edited: chord.edited === true })),
      note: typeof raw.note === 'string' ? raw.note.slice(0, 4000) : '',
    },
  };
}

// Valida tudo antes de devolver qualquer parte; a sessão é validada pela visão com
// validateSession (src/session.js), dona do formato canônico.
export function parsePackage(text) {
  if (typeof text !== 'string') return fail('O pacote deve ser um texto JSON.');
  if (text.length > MAX_PACKAGE_CHARS) return fail('O pacote é grande demais para ser importado.');
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return fail('Não foi possível ler o pacote: o JSON é inválido.');
  }
  if (!isObject(document) || !Object.keys(document).every(key => TOP_KEYS.includes(key))) return fail('O arquivo contém campos que não pertencem a um pacote de tarefa.');
  if (document.format !== PACKAGE_FORMAT) return fail('O arquivo não é um pacote de tarefa do GrooveGoblin.');
  if (document.version !== PACKAGE_VERSION) return fail('A versão do pacote não é compatível com esta versão do GrooveGoblin.');
  if (typeof document.title !== 'string' || !document.title.trim()) return fail('O pacote não tem título.');
  if (document.objective !== undefined && typeof document.objective !== 'string') return fail('O objetivo do pacote deve ser texto.');
  if (document.session !== null && document.session !== undefined && !isObject(document.session)) return fail('A sessão do pacote é inválida.');
  const reference = validReference(document.reference ?? null);
  if (!reference.ok) return reference;
  if (document.exercises !== undefined && !Array.isArray(document.exercises)) return fail('Os exercícios do pacote devem ser uma lista.');
  const exercises = (document.exercises ?? []).map(normalizeExercise);
  if (exercises.some(exercise => !exercise)) return fail('Há exercícios inválidos no pacote.');
  if (exercises.length > 200) return fail('O pacote tem exercícios demais (limite de 200).');
  let audio = null;
  if (document.audio !== null && document.audio !== undefined) {
    const raw = document.audio;
    if (!isObject(raw) || typeof raw.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data)) return fail('O áudio embutido no pacote está corrompido.');
    let bytes;
    try {
      bytes = base64ToBytes(raw.data);
    } catch {
      return fail('O áudio embutido no pacote está corrompido.');
    }
    if (bytes.length > MAX_EMBEDDED_AUDIO_BYTES) return fail('O áudio embutido excede o limite de 25 MB.');
    if (Number.isFinite(raw.size) && raw.size !== bytes.length) return fail('O áudio embutido está incompleto (tamanho divergente).');
    audio = { mimeType: typeof raw.mimeType === 'string' ? raw.mimeType.slice(0, 100) : '', fileName: typeof raw.fileName === 'string' ? raw.fileName.slice(0, 200) : '', bytes };
  }
  if (audio && !reference.value) return fail('O pacote tem áudio mas nenhuma referência descrita.');
  return {
    ok: true,
    value: {
      title: document.title.trim().slice(0, 200),
      objective: (document.objective ?? '').slice(0, 5000),
      createdAt: typeof document.createdAt === 'string' ? document.createdAt : null,
      session: document.session ?? null,
      reference: reference.value,
      exercises,
      audio,
    },
  };
}
