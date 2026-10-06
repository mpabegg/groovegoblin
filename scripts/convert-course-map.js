#!/usr/bin/env node
// Conversor de mapas de curso em português para o formato "groovegoblin-course" v1.
//
//   node scripts/convert-course-map.js <mapa.json> [--output local/curso-convertido.json] [--com-progresso]
//
// O conversor é tolerante: campo ausente, nulo ou embrulhado em { valor, inferido }
// não derruba a conversão. O que não pode ser lido com segurança fica nulo e gera
// um aviso. Avisos e relatórios citam apenas o caminho do campo — nunca títulos,
// nomes de arquivo ou endereços do mapa original — e nada é buscado na rede.
//
// Observações do idioma de origem: "≈25 (12 acordes × 2 + acorde final)" vale 25,
// porque só há um número fora da explicação entre parênteses; "80 ou 90 BPM" fica
// nulo, porque a fonte admite dois andamentos. Material ou exercício de 6 cordas é
// descartado, porque o app só aceita baixo de 4 ou 5 cordas; um curso que declara 6
// cordas é incompatível: a conversão falha apontando course.strings e nada é gravado.
// O progresso pessoal do mapa (aulas assistidas e anotações) só sai com
// --com-progresso, e as anotações nunca.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COURSE_FORMAT,
  COURSE_LIMITS,
  COURSE_VERSION,
  RESOURCE_ROLES,
  normalizeCourse,
  serializeCourse,
} from '../src/course-format.js';

export const DEFAULT_OUTPUT = 'local/curso-convertido.json';

const BPM_RANGE = { min: COURSE_LIMITS.bpmMin, max: COURSE_LIMITS.bpmMax };
const BARS_RANGE = { min: COURSE_LIMITS.barsMin, max: COURSE_LIMITS.barsMax };
const PAGE_RANGE = { min: COURSE_LIMITS.pdfPageMin, max: COURSE_LIMITS.pdfPageMax };
const WEEK_RANGE = { min: COURSE_LIMITS.weekMin, max: COURSE_LIMITS.weekMax };
const DAILY_MINUTES_RANGE = { min: COURSE_LIMITS.dailyMinutesMin, max: COURSE_LIMITS.dailyMinutesMax };

const ROOT_KEYS = ['_sobre', 'curso', 'modulos'];
const COURSE_KEYS = [
  'id', 'curso_id', 'titulo', 'autor', 'url', 'descricao', 'instrumento', 'idioma',
  'total_aulas', 'minutos_diarios', 'daily_minutes', 'minutos_por_dia', 'cordas', 'strings', 'modulos',
];
const INSTRUMENT_KEYS = ['nome', 'cordas', 'strings', 'tipo'];
const MODULE_KEYS = ['ordem', 'ordem_global', 'id', 'titulo', 'descricao', 'prerequisitos', 'objetivo', 'semana', 'aulas'];
const LESSON_KEYS = [
  'ordem', 'ordem_global', 'id', 'titulo', 'url', 'tipo_de_aula', 'video', 'resumo',
  'tecnicas_ou_conceitos', 'tom', 'formula_de_compasso', 'afinacao', 'andamentos',
  'instrucoes_de_pratica', 'exercicios', 'anexos', 'backing_tracks', 'meu_progresso', 'cordas', 'strings',
];
const VIDEO_KEYS = ['hospedagem', 'duracao', 'duracao_segundos'];
const TEMPO_KEYS = ['inicial', 'alvo'];
const EXERCISE_KEYS = [
  'ordem', 'id', 'nome', 'descricao', 'compassos_aproximados', 'andamento_inicial',
  'andamento_alvo', 'arquivo_correspondente', 'cordas', 'strings', 'pagina_pdf',
];
const ANEXO_KEYS = ['id', 'nome', 'arquivo', 'extensao', 'papel', 'tipo', 'cordas', 'strings', 'andamento', 'compassos_por_acorde', 'estilo', 'estendida'];
const TRACK_KEYS = ['id', 'nome', 'arquivo', 'extensao', 'papel', 'tipo', 'andamento', 'compassos_por_acorde', 'estilo', 'estendida', 'cordas', 'strings'];
const PROGRESS_KEYS = ['assistida', 'anotacoes'];

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'ogg', 'oga', 'flac'];
const PACKAGE_EXTENSIONS = ['zip', 'rar', '7z'];
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collapse(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

function warn(warnings, path, code, message) {
  warnings.push({ path, code, message });
}

function ignoredKeys(source, allowed, path, warnings) {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) warn(warnings, path === '' ? key : `${path}.${key}`, 'campo-ignorado', 'Campo do mapa não reconhecido; foi ignorado.');
  }
}

function field(source, names) {
  for (const name of names) {
    if (Object.hasOwn(source, name) && source[name] !== undefined) return source[name];
  }
  return undefined;
}

// Campos embrulhados em { valor, inferido }: o valor é usado e a marcação de
// inferência é apenas informativa. Vale para qualquer campo — escalar, lista ou
// objeto (curso, módulo, aula, material, exercício, vídeo, andamentos) — e
// embrulhos aninhados são abertos em sequência.
const WRAPPER_DEPTH = 4;

function unwrap(value, path, warnings) {
  let current = value;
  for (let depth = 0; depth < WRAPPER_DEPTH; depth += 1) {
    if (!isObject(current) || !Object.hasOwn(current, 'valor')) return current;
    for (const key of Object.keys(current)) {
      if (key !== 'valor' && key !== 'inferido') {
        warn(warnings, path === '' ? key : `${path}.${key}`, 'campo-ignorado', 'Campo do mapa não reconhecido; foi ignorado.');
      }
    }
    if (Object.hasOwn(current, 'inferido') && typeof current.inferido !== 'boolean') {
      warn(warnings, path === '' ? 'inferido' : `${path}.inferido`, 'inferido-invalido', 'A marcação de inferência deste campo não é verdadeira nem falsa e foi ignorada.');
    }
    current = current.valor;
  }
  return current;
}

function readText(value, path, max, warnings, code = 'texto-ilegivel') {
  const raw = unwrap(value, path, warnings);
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    warn(warnings, path, code, 'O campo não pôde ser lido como texto; ficou indefinido.');
    return null;
  }
  const text = collapse(raw);
  if (text === null) return null;
  if (text.length > max) {
    warn(warnings, path, 'texto-truncado', 'O texto deste campo era longo demais e foi cortado.');
    return text.slice(0, max);
  }
  return text;
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function readUrl(value, path, warnings) {
  const raw = unwrap(value, path, warnings);
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    warn(warnings, path, 'url-ilegivel', 'O endereço não pôde ser lido; ficou indefinido.');
    return null;
  }
  const text = collapse(raw);
  if (text === null) return null;
  if (!isHttpUrl(text)) {
    warn(warnings, path, 'url-ignorada', 'O endereço não é http(s) e foi descartado.');
    return null;
  }
  if (text.length > COURSE_LIMITS.url) {
    warn(warnings, path, 'url-longa', 'O endereço excede o limite e foi descartado, sem alterar seu destino.');
    return null;
  }
  return text;
}

// Somente números inequívocos: um único número fora de explicações entre
// parênteses e dentro da faixa pedida. "≈25 (12 acordes × 2 + acorde final)" dá
// 25; "80 ou 90 BPM", "90-100" ou "8.5" ficam nulos.
export function parseUnambiguousInteger(value, { min = null, max = null } = {}) {
  const fence = (number) => (
    Number.isInteger(number) && (min === null || number >= min) && (max === null || number <= max) ? number : null
  );
  const source = typeof value === 'string' ? collapse(value) : value;
  if (typeof source === 'number') return fence(source);
  if (typeof source !== 'string') return null;
  const outside = source.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  const numbers = outside.match(/\d+/g) ?? [];
  if (numbers.length !== 1) return null;
  return fence(Number(numbers[0]));
}

// Duração de vídeo em hh:mm:ss ou mm:ss (com "m:ss" curto aceito).
export function parseVideoDuration(value) {
  const source = typeof value === 'string' ? collapse(value) : value;
  if (typeof source === 'number') {
    return Number.isInteger(source) && source >= 0 && source <= COURSE_LIMITS.videoSecondsMax ? source : null;
  }
  if (typeof source !== 'string') return null;
  const match = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(source);
  if (match === null) return null;
  const [, hours, minutes, seconds] = match;
  const total = seconds === undefined
    ? Number(hours) * 60 + Number(minutes)
    : Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return total <= COURSE_LIMITS.videoSecondsMax ? total : null;
}

export function classifySectionTitle(title) {
  const text = collapse(title)?.toLowerCase() ?? null;
  if (text === null) return 'outro';
  if (/semin/.test(text)) return 'seminário';
  if (/boas[-\s]?vindas|bem[-\s]?vindo|apresenta|introdu/.test(text)) return 'boas-vindas';
  return 'módulo';
}

export function classifyResourceRole(value) {
  const text = collapse(value)?.toLowerCase() ?? '';
  if (text.includes('apostila') || text.includes('partitura') || text.includes('cifra') || text.includes('pdf')) return 'apostila';
  if (text.includes('faixa') || text.includes('backing') || text.includes('playback') || text.includes('áudio') || text.includes('audio')) return 'faixa';
  if (text.includes('pacote') || text.includes('zip') || text.includes('arquivo')) return 'pacote de exercícios';
  return RESOURCE_ROLES.includes(text) ? text : 'outro';
}

// "6 cordas"/"6-cordas"/"seis cordas" no nome do arquivo denuncia material que o
// app não toca; a checagem é por nome, sem baixar nada.
export function mentionsSixStrings(value) {
  const text = collapse(value)?.toLowerCase() ?? null;
  if (text === null) return false;
  return /(^|[^0-9])6\s*[-_ ]?\s*(cordas|strings)/.test(text) || /seis cordas/.test(text);
}

export function slugifyId(value, fallback = 'item') {
  const text = collapse(value) ?? '';
  const slug = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return slug === '' ? fallback : slug;
}

function ensureUniqueId(used, base, path, warnings) {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  if (candidate !== base) warn(warnings, path, 'id-ajustado', 'O identificador foi ajustado para não repetir outro do mesmo curso.');
  return candidate;
}

function readInteger(value, path, range, warnings, code = 'numero-ilegivel') {
  const raw = unwrap(value, path, warnings);
  if (raw === undefined || raw === null) return null;
  const number = parseUnambiguousInteger(raw, range);
  if (number === null) {
    warn(warnings, path, code, 'O número deste campo não pôde ser lido com segurança; ficou indefinido.');
    return null;
  }
  return number;
}

function readBoolean(value, path, warnings, fallback = false) {
  const raw = unwrap(value, path, warnings);
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    warn(warnings, path, 'booleano-ilegivel', 'O campo deveria ser verdadeiro ou falso e foi ignorado.');
    return fallback;
  }
  return raw;
}

// 4 ou 5 são aceitos; 6 é sinalizado para descarte; o resto fica indefinido.
function readStrings(value, path, warnings) {
  const raw = unwrap(value, path, warnings);
  if (raw === undefined || raw === null) return null;
  const number = typeof raw === 'number' ? raw : parseUnambiguousInteger(raw);
  if (number === 4 || number === 5 || number === 6) return number;
  warn(warnings, path, 'cordas-ignoradas', 'A quantidade de cordas não foi reconhecida e ficou indefinida.');
  return null;
}

function readTextList(value, path, { limit, max }, warnings) {
  const raw = unwrap(value, path, warnings);
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const texts = [];
  for (const [index, item] of list.entries()) {
    if (texts.length >= limit) {
      warn(warnings, path, 'lista-longa', 'A lista deste campo tinha itens demais e foi cortada.');
      break;
    }
    const text = readText(item, `${path}[${index}]`, max, warnings);
    if (text !== null && !texts.includes(text)) texts.push(text);
  }
  return texts;
}

// Listas do mapa: o campo pode vir embrulhado (uma vez ou aninhado) e só perde
// itens quando o valor, já aberto, não é uma lista.
function listEntries(value, path, warnings, {
  code = 'lista-ilegivel',
  message = 'A lista deste campo não foi reconhecida; nenhum item foi convertido.',
} = {}) {
  const raw = unwrap(value, path, warnings);
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warn(warnings, path, code, message);
    return [];
  }
  return raw.map((entry, index) => ({ entry, index, path: `${path}[${index}]` }));
}

function collectedEntries(source, key, path, warnings) {
  return listEntries(source[key], path, warnings);
}

// Ordena por "ordem" (ou "ordem_global"), preservando a ordem do arquivo quando
// o campo não existe. A posição original fica no caminho de cada item.
function orderEntries(entries) {
  return entries
    .map((item, position) => ({
      ...item,
      key: orderKey(item.entry, item.index ?? position),
      position,
    }))
    .sort((a, b) => (a.key - b.key) || (a.position - b.position));
}

// A ordem aceita o mesmo caminho dos demais números: inteiro, texto numérico
// inequívoco ou embrulho { valor, inferido }. Fora disso, a ordem do arquivo manda.
function orderKey(entry, index) {
  const plain = unwrap(entry, '', []);
  if (isObject(plain)) {
    for (const name of ['ordem', 'ordem_global']) {
      const number = parseUnambiguousInteger(unwrap(plain[name], '', []));
      if (number !== null) return number;
    }
  }
  return index;
}

function extensionOf(declaredValue, name, warnings, path) {
  const declared = (collapse(unwrap(declaredValue, path, warnings)) ?? '').replace(/^\.+/, '').toLowerCase();
  if (declared !== '' && !/^[a-z0-9]{1,8}$/.test(declared)) {
    warn(warnings, path, 'extensao-ignorada', 'A extensão declarada não foi reconhecida e foi descartada.');
  }
  const fromName = typeof name === 'string' ? (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? '').toLowerCase() : '';
  for (const candidate of [declared, fromName]) {
    if (/^[a-z0-9]{1,8}$/.test(candidate)) return candidate;
  }
  return null;
}

function convertRole(raw, { kind, extension }, path, warnings) {
  const declared = unwrap(raw, path, warnings);
  const text = collapse(declared) ?? null;
  if (text !== null) {
    const role = classifyResourceRole(text);
    if (role === 'outro' && !/outro|diversos|extra/i.test(text)) {
      warn(warnings, path, 'papel-desconhecido', 'O papel declarado para este material não foi reconhecido; foi usado "outro".');
    }
    return role;
  }
  if (kind === 'faixa') return 'faixa';
  if (PACKAGE_EXTENSIONS.includes(extension)) return 'pacote de exercícios';
  if (AUDIO_EXTENSIONS.includes(extension)) return 'faixa';
  if (extension === 'pdf') return 'apostila';
  return 'outro';
}

function convertVideo(value, path, warnings) {
  const video = unwrap(value, path, warnings);
  if (video === undefined || video === null) return { seconds: null, hasVideo: false };
  if (!isObject(video)) {
    warn(warnings, path, 'video-ilegivel', 'Os dados de vídeo desta aula não foram reconhecidos; a aula ficou sem vídeo.');
    return { seconds: null, hasVideo: false };
  }
  ignoredKeys(video, VIDEO_KEYS, path, warnings);
  const hosting = readText(video.hospedagem, `${path}.hospedagem`, COURSE_LIMITS.label, warnings);
  const declared = readInteger(video.duracao_segundos, `${path}.duracao_segundos`, { min: 0, max: COURSE_LIMITS.videoSecondsMax }, warnings, 'duracao-ilegivel');
  const duration = readText(video.duracao, `${path}.duracao`, COURSE_LIMITS.label, warnings);
  let seconds = declared;
  if (seconds === null && duration !== null) {
    seconds = parseVideoDuration(duration);
    if (seconds === null) warn(warnings, `${path}.duracao`, 'duracao-ilegivel', 'A duração do vídeo não pôde ser lida; o tempo ficou indefinido.');
  }
  const hasVideo = seconds !== null || hosting !== null || duration !== null;
  return { seconds, hasVideo };
}

function convertTempos(value, path, warnings) {
  const tempos = { initial: null, target: null };
  const source = unwrap(value, path, warnings);
  if (source === undefined || source === null) return tempos;
  if (!isObject(source)) {
    tempos.initial = readInteger(source, path, BPM_RANGE, warnings, 'andamento-ilegivel');
    return tempos;
  }
  ignoredKeys(source, TEMPO_KEYS, path, warnings);
  tempos.initial = readInteger(source.inicial, `${path}.inicial`, BPM_RANGE, warnings, 'andamento-ilegivel');
  tempos.target = readInteger(source.alvo, `${path}.alvo`, BPM_RANGE, warnings, 'andamento-ilegivel');
  return tempos;
}

function convertResource(raw, { kind, path, lessonId, usedIds }, warnings, counts) {
  const material = unwrap(raw, path, warnings);
  if (!isObject(material)) {
    warn(warnings, path, 'material-invalido', 'Uma entrada de material não é um objeto e foi descartada.');
    counts.discarded += 1;
    return null;
  }
  ignoredKeys(material, kind === 'anexo' ? ANEXO_KEYS : TRACK_KEYS, path, warnings);
  const name = readText(field(material, ['nome', 'arquivo']), `${path}.nome`, COURSE_LIMITS.name, warnings);
  if (name === null) warn(warnings, `${path}.nome`, 'nome-ausente', 'Este material não tem nome; foi usado um nome genérico.');
  const extension = extensionOf(field(material, ['extensao']), name, warnings, `${path}.extensao`);
  const strings = readStrings(field(material, ['cordas', 'strings']), `${path}.cordas`, warnings);
  if (strings === 6 || mentionsSixStrings(name)) {
    warn(warnings, path, 'cordas-6', 'Um material de 6 cordas foi descartado.');
    counts.discarded += 1;
    return null;
  }
  return {
    id: ensureUniqueId(usedIds, slugifyId(name, `${lessonId}-material-${counts.resources + 1}`), `${path}.nome`, warnings),
    name: name ?? `material-${counts.resources + 1}`,
    extension,
    role: convertRole(field(material, ['papel', 'tipo']), { kind, extension }, `${path}.papel`, warnings),
    bpm: readInteger(field(material, ['andamento']), `${path}.andamento`, BPM_RANGE, warnings, 'andamento-ilegivel'),
    barsPerChord: readInteger(field(material, ['compassos_por_acorde']), `${path}.compassos_por_acorde`, { min: 1, max: 2 }, warnings, 'compassos-ilegiveis'),
    style: readText(field(material, ['estilo']), `${path}.estilo`, COURSE_LIMITS.name, warnings),
    extended: readBoolean(field(material, ['estendida']), `${path}.estendida`, warnings, false),
    strings,
  };
}

function convertExercise(raw, { path, lessonId, usedIds, index }, warnings, counts) {
  const fonte = unwrap(raw, path, warnings);
  if (!isObject(fonte)) {
    warn(warnings, path, 'exercicio-invalido', 'Uma entrada de exercício não é um objeto e foi descartada.');
    counts.discarded += 1;
    return { exercise: null, track: null, path };
  }
  ignoredKeys(fonte, EXERCISE_KEYS, path, warnings);
  const name = readText(field(fonte, ['nome']), `${path}.nome`, COURSE_LIMITS.name, warnings);
  if (name === null) warn(warnings, `${path}.nome`, 'nome-ausente', 'Este exercício não tem nome; foi usado um nome genérico.');
  const strings = readStrings(field(fonte, ['cordas', 'strings']), `${path}.cordas`, warnings);
  const track = readText(field(fonte, ['arquivo_correspondente']), `${path}.arquivo_correspondente`, COURSE_LIMITS.name, warnings);
  if (strings === 6 || mentionsSixStrings(name) || mentionsSixStrings(track)) {
    warn(warnings, path, 'cordas-6', 'Um exercício ligado a material de 6 cordas foi descartado.');
    counts.discarded += 1;
    return { exercise: null, track: null, path };
  }
  const title = name ?? `Exercício ${index + 1}`;
  return {
    path,
    track,
    exercise: {
      id: ensureUniqueId(usedIds, slugifyId(name, `${lessonId}-exercicio-${index + 1}`), `${path}.nome`, warnings),
      title,
      description: readText(field(fonte, ['descricao']), `${path}.descricao`, COURSE_LIMITS.summary, warnings),
      initialBpm: readInteger(field(fonte, ['andamento_inicial']), `${path}.andamento_inicial`, BPM_RANGE, warnings, 'andamento-ilegivel'),
      targetBpm: readInteger(field(fonte, ['andamento_alvo']), `${path}.andamento_alvo`, BPM_RANGE, warnings, 'andamento-ilegivel'),
      bars: readInteger(field(fonte, ['compassos_aproximados']), `${path}.compassos_aproximados`, BARS_RANGE, warnings, 'compassos-ilegiveis'),
      trackNames: track === null ? [] : [track],
      pdfPage: readInteger(field(fonte, ['pagina_pdf']), `${path}.pagina_pdf`, PAGE_RANGE, warnings, 'pagina-ilegivel'),
      strings,
    },
  };
}

function convertLesson(raw, context, warnings, counts) {
  const { path, sectionId, usedLessonIds, ordinal } = context;
  const source = unwrap(raw, path, warnings);
  if (!isObject(source)) {
    warn(warnings, path, 'aula-invalida', 'Uma entrada de aula não é um objeto e foi descartada.');
    counts.discarded += 1;
    return null;
  }
  ignoredKeys(source, LESSON_KEYS, path, warnings);
  const title = readText(source.titulo, `${path}.titulo`, COURSE_LIMITS.title, warnings);
  if (title === null) warn(warnings, `${path}.titulo`, 'titulo-ausente', 'Esta aula não tem título; foi usado um título genérico.');
  const declaredId = readText(source.id, `${path}.id`, COURSE_LIMITS.id, warnings);
  const id = ensureUniqueId(
    usedLessonIds,
    slugifyId(declaredId, `${sectionId}-aula-${ordinal}`),
    `${path}.id`,
    warnings,
  );
  const type = readText(source.tipo_de_aula, `${path}.tipo_de_aula`, COURSE_LIMITS.label, warnings);
  if (type === null) warn(warnings, `${path}.tipo_de_aula`, 'tipo-ausente', 'O tipo desta aula não foi informado; foi usado um rótulo genérico.');
  const video = convertVideo(source.video, `${path}.video`, warnings);
  const tempos = convertTempos(source.andamentos, `${path}.andamentos`, warnings);
  const lesson = {
    id,
    title: title ?? 'Aula sem título',
    url: readUrl(source.url, `${path}.url`, warnings),
    type: type ?? 'aula',
    videoSeconds: video.seconds,
    hasVideo: video.hasVideo,
    summary: readText(source.resumo, `${path}.resumo`, COURSE_LIMITS.summary, warnings),
    practiceInstruction: readText(source.instrucoes_de_pratica, `${path}.instrucoes_de_pratica`, COURSE_LIMITS.summary, warnings),
    key: readText(source.tom, `${path}.tom`, COURSE_LIMITS.shortText, warnings),
    chordFormula: readText(source.formula_de_compasso, `${path}.formula_de_compasso`, COURSE_LIMITS.shortText, warnings),
    tuning: readText(source.afinacao, `${path}.afinacao`, COURSE_LIMITS.shortText, warnings),
    techniques: readTextList(source.tecnicas_ou_conceitos, `${path}.tecnicas_ou_conceitos`, { limit: COURSE_LIMITS.techniques, max: COURSE_LIMITS.shortText }, warnings),
    initialBpm: tempos.initial,
    targetBpm: tempos.target,
    resources: [],
    resourceRefs: [],
    suggestedExercises: [],
  };

  const usedResourceIds = new Set();
  const resourceEntries = [
    ...collectedEntries(source, 'anexos', `${path}.anexos`, warnings).map((item) => ({ ...item, kind: 'anexo' })),
    ...collectedEntries(source, 'backing_tracks', `${path}.backing_tracks`, warnings).map((item) => ({ ...item, kind: 'faixa' })),
  ];
  const keptResources = resourceEntries.slice(0, COURSE_LIMITS.resources);
  if (resourceEntries.length > keptResources.length) {
    warn(warnings, `${path}.anexos`, 'lista-longa', 'Os materiais desta aula eram muitos e o excedente foi descartado.');
    counts.discarded += resourceEntries.length - keptResources.length;
  }
  for (const { entry, path: entryPath, kind } of keptResources) {
    const resource = convertResource(entry, { kind, path: entryPath, lessonId: id, usedIds: usedResourceIds }, warnings, counts);
    if (resource !== null) {
      lesson.resources.push(resource);
      counts.resources += 1;
    }
  }

  const usedExerciseIds = new Set();
  const links = [];
  const exerciseEntries = collectedEntries(source, 'exercicios', `${path}.exercicios`, warnings);
  const keptExercises = exerciseEntries.slice(0, COURSE_LIMITS.exercises);
  if (exerciseEntries.length > keptExercises.length) {
    warn(warnings, `${path}.exercicios`, 'lista-longa', 'Os exercícios desta aula eram muitos e o excedente foi descartado.');
    counts.discarded += exerciseEntries.length - keptExercises.length;
  }
  for (const { entry, path: entryPath } of keptExercises) {
    const converted = convertExercise(entry, { path: entryPath, lessonId: id, usedIds: usedExerciseIds, index: lesson.suggestedExercises.length }, warnings, counts);
    if (converted.exercise !== null) {
      lesson.suggestedExercises.push(converted.exercise);
      counts.exercises += 1;
      links.push({ track: converted.track, path: converted.path });
    }
  }

  const rawProgress = unwrap(source.meu_progresso, `${path}.meu_progresso`, warnings);
  const progress = isObject(rawProgress) ? rawProgress : {};
  if (isObject(rawProgress)) ignoredKeys(progress, PROGRESS_KEYS, `${path}.meu_progresso`, warnings);
  const watched = readBoolean(progress.assistida, `${path}.meu_progresso.assistida`, warnings, false);
  if (progress.anotacoes !== undefined && progress.anotacoes !== null) {
    warn(warnings, `${path}.meu_progresso.anotacoes`, 'anotacoes-descartadas', 'As anotações pessoais do mapa não são convertidas.');
  }

  counts.lessons += 1;
  return { lesson, path, links, watched };
}

function convertSection(raw, { path, usedSectionIds, usedLessonIds, ordinal, lessonBudget }, warnings, counts) {
  const source = unwrap(raw, path, warnings);
  if (!isObject(source)) {
    warn(warnings, path, 'modulo-invalido', 'Uma entrada de módulo não é um objeto e foi descartada.');
    counts.discarded += 1;
    return null;
  }
  ignoredKeys(source, MODULE_KEYS, path, warnings);
  const title = readText(source.titulo, `${path}.titulo`, COURSE_LIMITS.title, warnings);
  const type = classifySectionTitle(title);
  if (type === 'outro') warn(warnings, `${path}.titulo`, 'titulo-ausente', 'Esta seção não tem título; foi marcada como "outro" com um título genérico.');
  const sectionId = ensureUniqueId(
    usedSectionIds,
    slugifyId(field(source, ['id']) ?? title, `modulo-${ordinal}`),
    `${path}.id`,
    warnings,
  );
  const section = {
    id: sectionId,
    title: title ?? 'Seção sem título',
    type,
    week: readInteger(field(source, ['semana']), `${path}.semana`, WEEK_RANGE, warnings),
    summary: readText(field(source, ['descricao']), `${path}.descricao`, COURSE_LIMITS.summary, warnings),
    objective: readText(field(source, ['objetivo']), `${path}.objetivo`, COURSE_LIMITS.summary, warnings),
    prerequisites: readTextList(field(source, ['prerequisitos']), `${path}.prerequisitos`, { limit: COURSE_LIMITS.prerequisites, max: COURSE_LIMITS.mediumText }, warnings),
    lessons: [],
  };
  counts.sections += 1;
  const entries = [];
  const lessonEntries = orderEntries(listEntries(source.aulas, `${path}.aulas`, warnings, {
    code: 'aulas-ilegiveis',
    message: 'A lista de aulas deste módulo não foi reconhecida; nenhuma aula foi convertida.',
  }));
  const keptLessons = lessonEntries.slice(0, Math.min(COURSE_LIMITS.lessonsPerSection, lessonBudget));
  if (lessonEntries.length > keptLessons.length) {
    warn(warnings, `${path}.aulas`, 'lista-longa', 'As aulas deste módulo eram muitas e o excedente foi descartado.');
    counts.discarded += lessonEntries.length - keptLessons.length;
  }
  for (const { entry, index } of keptLessons) {
    const lessonPath = `${path}.aulas[${index}]`;
    const converted = convertLesson(entry, {
      path: lessonPath,
      sectionId,
      usedLessonIds,
      ordinal: index + 1,
    }, warnings, counts);
    if (converted === null) continue;
    section.lessons.push(converted.lesson);
    entries.push({ section, lesson: converted.lesson, path: lessonPath, links: converted.links, watched: converted.watched });
  }
  return { section, entries };
}

function normalizeFileName(value) {
  const text = collapse(value)?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') ?? null;
  return text;
}

function withoutExtension(fileName) {
  return (fileName ?? '').replace(/\.[a-z0-9]{1,8}$/, '');
}

function findResource(entry, file, entries) {
  const target = normalizeFileName(file);
  if (target === null) return null;
  const scopes = [
    entries.filter((candidate) => candidate.lesson === entry.lesson),
    entries.filter((candidate) => candidate.section === entry.section && candidate.lesson !== entry.lesson),
    entries.filter((candidate) => candidate.section !== entry.section),
  ];
  for (const scope of scopes) {
    for (const candidate of scope) {
      const exact = candidate.lesson.resources.find((resource) => normalizeFileName(resource.name) === target);
      if (exact !== undefined) return { lesson: candidate.lesson, resource: exact };
    }
    for (const candidate of scope) {
      const packageResource = candidate.lesson.resources.find((resource) => (
        resource.role === 'pacote de exercícios'
        && withoutExtension(normalizeFileName(resource.name)) !== ''
        && withoutExtension(target).startsWith(withoutExtension(normalizeFileName(resource.name)))
      ));
      if (packageResource !== undefined) return { lesson: candidate.lesson, resource: packageResource };
    }
  }
  return null;
}

// Material citado por exercício vira vínculo com o recurso equivalente do curso,
// sem baixar nada: primeiro na própria aula, depois no mesmo módulo, depois no
// resto do curso. Um pacote de exercícios do módulo serve de destino.
function linkResourceRefs(entries, warnings, counts) {
  for (const entry of entries) {
    const seen = new Set();
    for (const link of entry.links) {
      if (link.track === null) continue;
      const match = findResource(entry, link.track, entries);
      if (match === null) {
        warn(warnings, link.path, 'vinculo-ausente', 'O arquivo citado pelo exercício não tem material equivalente no curso; o vínculo não foi criado.');
        continue;
      }
      const key = `${match.lesson.id}/${match.resource.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entry.lesson.resourceRefs.push({ lessonId: match.lesson.id, resourceId: match.resource.id });
      counts.resourceRefs += 1;
    }
  }
}

function buildCourse(root, warnings, counts) {
  const course = {
    id: 'curso',
    title: 'Curso sem título',
    author: null,
    url: null,
    instrument: 'bass',
    strings: 4,
    language: null,
    dailyMinutes: null,
    summary: null,
    sections: [],
  };
  const declaredCourse = unwrap(root.curso, 'curso', warnings);
  if (!isObject(declaredCourse)) {
    warn(warnings, 'curso', 'curso-ausente', 'O mapa não traz os dados do curso; o documento ficou com um curso genérico.');
  } else {
    ignoredKeys(declaredCourse, COURSE_KEYS, 'curso', warnings);
  }
  const source = isObject(declaredCourse) ? declaredCourse : {};
  const title = readText(field(source, ['titulo']), 'curso.titulo', COURSE_LIMITS.title, warnings);
  if (title === null) warn(warnings, 'curso.titulo', 'titulo-ausente', 'O título do curso não foi informado; foi usado um título genérico.');
  course.title = title ?? 'Curso sem título';
  course.id = slugifyId(field(source, ['id', 'curso_id']) ?? title, 'curso');
  course.author = readText(field(source, ['autor']), 'curso.autor', COURSE_LIMITS.title, warnings);
  course.url = readUrl(field(source, ['url']), 'curso.url', warnings);
  course.summary = readText(field(source, ['descricao']), 'curso.descricao', COURSE_LIMITS.summary, warnings);
  course.language = readText(field(source, ['idioma']), 'curso.idioma', COURSE_LIMITS.language, warnings);
  course.dailyMinutes = readInteger(field(source, ['minutos_diarios', 'daily_minutes', 'minutos_por_dia']), 'curso.minutos_diarios', DAILY_MINUTES_RANGE, warnings);

  const declaredInstrument = unwrap(source.instrumento, 'curso.instrumento', warnings);
  const instrument = isObject(declaredInstrument) ? declaredInstrument : {};
  if (isObject(declaredInstrument)) ignoredKeys(declaredInstrument, INSTRUMENT_KEYS, 'curso.instrumento', warnings);
  const instrumentName = readText(isObject(declaredInstrument) ? declaredInstrument.nome : declaredInstrument, 'curso.instrumento', COURSE_LIMITS.label, warnings);
  if (instrumentName !== null && !/baixo|bass|contrabaixo/i.test(instrumentName)) {
    warn(warnings, 'curso.instrumento', 'instrumento-diferente', 'O mapa aponta outro instrumento; este formato aceita somente baixo.');
  }
  const declaredStrings = readStrings(
    field(instrument, ['cordas', 'strings']) ?? field(source, ['cordas', 'strings']),
    'curso.cordas',
    warnings,
  );
  if (declaredStrings === 6) {
    warn(warnings, 'curso.cordas', 'cordas-6', 'O mapa declara 6 cordas; este formato aceita somente baixo de 4 ou 5 cordas, então este curso não foi convertido.');
    course.strings = 6;
  } else if (declaredStrings === 4 || declaredStrings === 5) {
    course.strings = declaredStrings;
  }

  const declaredTotal = unwrap(field(source, ['total_aulas']), 'curso.total_aulas', warnings);
  const total = typeof declaredTotal === 'number' && Number.isInteger(declaredTotal) ? declaredTotal : parseUnambiguousInteger(declaredTotal);
  const entries = [];
  const usedSectionIds = new Set();
  const usedLessonIds = new Set();
  const modulesAtRoot = field(root, ['modulos']);
  const modulesInsideCourse = field(source, ['modulos']);
  const declaredModules = modulesAtRoot !== undefined && modulesAtRoot !== null ? modulesAtRoot : modulesInsideCourse;
  const moduleEntries = orderEntries(listEntries(declaredModules, 'modulos', warnings, {
    code: 'modulos-ilegiveis',
    message: 'A lista de módulos do mapa não foi reconhecida; nenhuma seção foi convertida.',
  }));
  if (moduleEntries.length === 0 && (declaredModules === undefined || declaredModules === null)) {
    warn(warnings, 'modulos', 'modulos-ausentes', 'O mapa não traz módulos; nenhuma seção foi convertida.');
  }
  const keptModules = moduleEntries.slice(0, COURSE_LIMITS.sections);
  if (moduleEntries.length > keptModules.length) {
    warn(warnings, 'modulos', 'lista-longa', 'O mapa tinha módulos demais e o excedente foi descartado.');
    counts.discarded += moduleEntries.length - keptModules.length;
  }
  let lessonBudget = COURSE_LIMITS.lessons;
  for (const { entry, index } of keptModules) {
    if (lessonBudget <= 0) {
      warn(warnings, `modulos[${index}]`, 'lista-longa', 'O curso tinha aulas demais; as seções seguintes foram descartadas.');
      counts.discarded += keptModules.length - index;
      break;
    }
    const converted = convertSection(entry, {
      path: `modulos[${index}]`,
      usedSectionIds,
      usedLessonIds,
      ordinal: index + 1,
      lessonBudget,
    }, warnings, counts);
    if (converted === null) continue;
    course.sections.push(converted.section);
    entries.push(...converted.entries);
    lessonBudget -= converted.entries.length;
  }
  linkResourceRefs(entries, warnings, counts);
  if (total !== null && total !== counts.lessons) {
    warn(warnings, 'curso.total_aulas', 'total-aulas-divergente', 'O total de aulas declarado no mapa difere das aulas convertidas.');
  }
  const watchedIds = entries.filter((entry) => entry.watched).map((entry) => entry.lesson.id);
  return { course, watchedIds };
}

// Converte um mapa já interpretado (objeto) em documento do formato. O retorno
// traz o documento, os avisos (com caminho de campo) e as contagens de material
// convertido e descartado. includeProgress liga o progresso pessoal do mapa.
export function convertCourseMap(value, { includeProgress = false } = {}) {
  const warnings = [];
  const counts = { sections: 0, lessons: 0, resources: 0, resourceRefs: 0, exercises: 0, discarded: 0 };
  const wrapped = unwrap(value, '', warnings);
  const root = isObject(wrapped) ? wrapped : {};
  if (!isObject(wrapped)) warn(warnings, '', 'raiz', 'A raiz do mapa não é um objeto; o curso convertido ficou vazio.');
  else ignoredKeys(root, ROOT_KEYS, '', warnings);
  const { course, watchedIds } = buildCourse(root, warnings, counts);
  const document = { format: COURSE_FORMAT, version: COURSE_VERSION, course };
  if (includeProgress) document.progress = { watchedLessonIds: watchedIds };
  const validation = normalizeCourse(document);
  return {
    document,
    warnings,
    counts,
    valid: validation.ok,
    problems: validation.ok ? [] : validation.errors,
  };
}

// ── Linha de comando ─────────────────────────────────────────────────────────

const USAGE = [
  'Uso: node scripts/convert-course-map.js <mapa.json> [--output CAMINHO] [--com-progresso]',
  '',
  '  <mapa.json>        mapa de curso em JSON (use - para ler da entrada padrão)',
  `  --output CAMINHO   onde gravar o curso convertido (padrão: ${DEFAULT_OUTPUT})`,
  '  --com-progresso    inclui as aulas assistidas do mapa no documento',
].join('\n');

function parseArgs(argv) {
  const args = { input: null, output: null, includeProgress: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output' || arg === '-o') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) return { error: 'A opção --output precisa de um caminho.' };
      args.output = next;
      index += 1;
    } else if (arg.startsWith('--output=')) {
      args.output = arg.slice('--output='.length);
    } else if (arg === '--com-progresso' || arg === '--include-progress') {
      args.includeProgress = true;
    } else if (arg === '--ajuda' || arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '-') {
      args.input = '-';
    } else if (arg.startsWith('-')) {
      return { error: `Opção desconhecida: ${arg}.` };
    } else if (args.input === null) {
      args.input = arg;
    } else {
      return { error: 'Informe apenas um arquivo de entrada.' };
    }
  }
  return { args };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function describeIoError(error) {
  switch (error?.code) {
    case 'ENOENT': return 'arquivo não encontrado';
    case 'EACCES':
    case 'EPERM': return 'permissão negada';
    case 'EISDIR': return 'o caminho é uma pasta';
    case 'ENOSPC': return 'não há espaço livre';
    default: return 'falha de entrada e saída';
  }
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    console.error(parsed.error);
    console.error(USAGE);
    return 2;
  }
  const { args } = parsed;
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.input === null) {
    console.error('Informe o arquivo do mapa de curso (ou - para a entrada padrão).');
    console.error(USAGE);
    return 2;
  }

  let text;
  try {
    text = args.input === '-' ? await readStdin() : await readFile(args.input, 'utf8');
  } catch (error) {
    console.error(`Não foi possível ler ${args.input}: ${describeIoError(error)}.`);
    return 2;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    console.error(`${args.input} não contém JSON válido.`);
    return 2;
  }

  const result = convertCourseMap(value, { includeProgress: args.includeProgress });
  if (!result.valid) {
    console.error('A conversão não gerou um curso válido; nenhum arquivo foi gravado.');
    for (const problem of result.problems) console.error(`- ${problem.path === '' ? 'documento' : problem.path}: ${problem.message}`);
    if (result.warnings.length > 0) {
      console.error(`Avisos (${result.warnings.length}):`);
      for (const warning of result.warnings) console.error(`- ${warning.path === '' ? 'mapa' : warning.path}: ${warning.message}`);
    }
    return 1;
  }

  const output = args.output ?? DEFAULT_OUTPUT;
  const serialized = serializeCourse(result.document);
  if (!serialized.ok) {
    console.error('A conversão não gerou um curso válido; nenhum arquivo foi gravado.');
    return 1;
  }
  try {
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(resolve(output), serialized.text, 'utf8');
  } catch (error) {
    console.error(`Não foi possível gravar ${output}: ${describeIoError(error)}.`);
    return 2;
  }

  const { counts } = result;
  console.log(`Curso convertido em ${output}`);
  console.log(`Seções ${counts.sections} · aulas ${counts.lessons} · materiais ${counts.resources} · exercícios ${counts.exercises} · vínculos ${counts.resourceRefs} · descartados ${counts.discarded}`);
  const watched = result.document.progress?.watchedLessonIds.length ?? 0;
  console.log(args.includeProgress
    ? `Progresso do mapa incluído: ${watched} aulas assistidas.`
    : 'Progresso do mapa fora do documento (use --com-progresso para incluir as aulas assistidas).');
  if (result.warnings.length === 0) console.log('Sem avisos.');
  else {
    console.log(`Avisos (${result.warnings.length}):`);
    for (const warning of result.warnings) console.log(`- ${warning.path === '' ? 'mapa' : warning.path}: ${warning.message}`);
  }
  return 0;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
