// Anexos de material de aula (rodada 5, etapa 6).
//
// Um curso traz METADADOS de material (nome, extensão, papel) — nunca o
// arquivo. Aqui mora o arquivo que o usuário escolheu no próprio computador:
// um IndexedDB PRÓPRIO (`groovegoblin-course-attachments`, versão 1) para não
// mexer no banco de cursos, no armazenamento de arranjos nem dentro da sessão.
// Nada é baixado da rede: o material de terceiros continua só um link externo.
//
// Propriedade composta (courseID, lessonID, resourceID): a referência é o que
// a aula mostra; o arquivo é identificado pelo CONTEÚDO (SHA-256 quando o
// navegador oferece). Assim o mesmo arquivo usado por duas aulas/cursos ocupa
// bytes UMA vez e remover uma referência não apaga o arquivo das outras.
//
// Regras duras:
//  - sem IndexedDB a loja nasce `persistent: false`, diz o motivo e RECUSA
//    toda gravação: nenhuma "salva falsa" só na memória;
//  - quota negada propaga erro honesto e não altera os registros anteriores;
//  - o apetite por espaço é medido em `totals()` (bytes de arquivos únicos);
//  - tipo do arquivo é conferido pelo CONTEÚDO básico, não só pela extensão:
//    PDF só é PDF com cabeçalho `%PDF-`, e HTML/SVG renomeado nunca é tratado
//    como documento executável;
//  - remover referência nunca apaga arquivo usado por outra referência, e
//    remover/reimportar curso NÃO apaga anexo nenhum: só ação explícita.

// Limites do lado do usuário: nome curto o bastante para a lista e teto de
// arquivo que não estoura a quota sem aviso.
export const ATTACHMENT_LIMITS = Object.freeze({
  name: 160,
  fileBytes: 128 * 1024 * 1024,
});

export const ATTACHMENT_DB_NAME = 'groovegoblin-course-attachments';
export const ATTACHMENT_DB_VERSION = 1;
// Chaves físicas: a referência é uma string composta (JSON seguro contra ids
// que já contenham separadores) e o arquivo é chaveado pelo conteúdo.
export const ATTACHMENT_KEY_PATHS = Object.freeze({ files: 'id', refs: 'key' });
export const ATTACHMENT_STORE_NAMES = Object.freeze(Object.keys(ATTACHMENT_KEY_PATHS));
export const ATTACHMENT_SCHEMA_VERSION = 1;
export const ATTACHMENT_FORMAT = 'groovegoblin-course-attachments';

export const ATTACHMENT_KINDS = Object.freeze({ pdf: 'pdf', audio: 'audio', other: 'other' });
export const ATTACHMENT_SOURCES = Object.freeze(['upload', 'import']);

export const AUDIO_EXTENSIONS = Object.freeze(['mp3', 'wav', 'wave', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'webm']);
export const PDF_EXTENSIONS = Object.freeze(['pdf']);

export const ATTACHMENTS_UNAVAILABLE_MESSAGE = 'Este navegador não oferece IndexedDB para os anexos. Enviar arquivos está indisponível e nada seria salvo — por isso a loja recusa a gravação.';
export const ATTACHMENTS_BLOCKED_MESSAGE = 'Outra aba do GrooveGoblin está bloqueando o banco de anexos. Feche as outras abas e recarregue antes de enviar arquivos.';
export const ATTACHMENTS_DIGEST_MAX_BYTES = 64 * 1024 * 1024;

export class AttachmentStorageError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'AttachmentStorageError';
    this.code = code;
    this.cause = cause;
  }
}

export function describeAttachmentStorageError(error) {
  if (error instanceof AttachmentStorageError) return error;
  const name = error?.name ?? '';
  if (name === 'QuotaExceededError' || /quota/i.test(error?.message ?? '')) {
    return new AttachmentStorageError('quota', 'O espaço local do navegador acabou. Os anexos e o progresso já salvos continuam intactos; remova um anexo para liberar espaço antes de enviar outro.', error);
  }
  if (name === 'InvalidStateError' || name === 'UnknownError') {
    return new AttachmentStorageError('unavailable', 'O banco de anexos do navegador ficou indisponível (aba privada, limpeza de dados ou erro interno). Nada foi gravado.', error);
  }
  if (name === 'VersionError') {
    return new AttachmentStorageError('version', 'O banco de anexos foi criado por uma versão mais nova do GrooveGoblin. Atualize a página ou o aplicativo.', error);
  }
  return new AttachmentStorageError('unknown', `Falha no armazenamento dos anexos: ${error?.message || name || 'erro desconhecido'}.`, error);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isBlob(value) {
  return isObject(value) && typeof value.arrayBuffer === 'function' && typeof value.size === 'number' && Number.isFinite(value.size);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function defaultUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isoNow() {
  return new Date().toISOString();
}

// Referência composta: JSON evita colisão de identificadores que já contenham
// dois-pontos, barras ou qualquer separador "bonito".
export function attachmentRefKey(courseId, lessonId, resourceId) {
  if (!isText(courseId) || !isText(lessonId) || !isText(resourceId)) {
    throw new TypeError('A referência do anexo precisa de curso, aula e material.');
  }
  return JSON.stringify([courseId, lessonId, resourceId]);
}

export function parseAttachmentRefKey(key) {
  if (typeof key !== 'string') return null;
  let parts;
  try { parts = JSON.parse(key); } catch { return null; }
  if (!Array.isArray(parts) || parts.length !== 3 || parts.some(part => !isText(part))) return null;
  return { courseId: parts[0], lessonId: parts[1], resourceId: parts[2] };
}

export function extensionOfName(name) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name ?? '').trim());
  return match ? match[1].toLowerCase() : '';
}

export function normalizeExtension(value) {
  const text = String(value ?? '').trim().replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(text) ? text : '';
}

export function isAudioExtension(extension) {
  return AUDIO_EXTENSIONS.includes(normalizeExtension(extension));
}

export function isPdfExtension(extension) {
  return PDF_EXTENSIONS.includes(normalizeExtension(extension));
}

function startsWithBytes(bytes, signature) {
  if (bytes.length < signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false;
  }
  return true;
}

function asciiAt(bytes, offset, length) {
  if (bytes.length < offset + length) return '';
  let text = '';
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[offset + index]);
  return text;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53]; // OggS
const FLAC_MAGIC = [0x66, 0x4c, 0x61, 0x43]; // fLaC

// Classificação pelo CONTEÚDO: extensão entra só como expectativa. Devolve o
// que o arquivo realmente parece ser, se foi possível confirmar e o aviso
// honesto quando a extensão mente.
export async function sniffAttachmentKind(blob, extension = '') {
  const ext = normalizeExtension(extension);
  let bytes = new Uint8Array(0);
  try {
    bytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  } catch {
    bytes = new Uint8Array(0);
  }
  const mime = blob.type || '';
  const head = asciiAt(bytes, 0, 16).trim().toLowerCase();
  const looksHtml = head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<script') || head.startsWith('<?xml') || head.startsWith('<svg');
  const looksPdf = startsWithBytes(bytes, PDF_MAGIC);
  const looksZip = startsWithBytes(bytes, ZIP_MAGIC);
  const looksPng = startsWithBytes(bytes, PNG_MAGIC);
  const looksJpeg = startsWithBytes(bytes, JPEG_MAGIC);
  const looksOgg = startsWithBytes(bytes, OGG_MAGIC);
  const looksFlac = startsWithBytes(bytes, FLAC_MAGIC);
  const looksWav = bytes.length >= 12 && asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WAVE';
  const looksMp3 = (bytes.length >= 3 && asciiAt(bytes, 0, 3) === 'ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  const audioLike = mime.startsWith('audio/') || isAudioExtension(ext);
  const extSaysPdf = isPdfExtension(ext);
  // Assinatura RECONHECIDA de áudio: só ela confirma o formato. Extensão ou
  // mime dizem a intenção, nunca a verdade do conteúdo.
  const recognizedAudio = looksWav || looksOgg || looksFlac || looksMp3;

  // PDF é PDF pelo CONTEÚDO: um arquivo com cabeçalho `%PDF-` é PDF mesmo que o
  // mapa do curso não declare a extensão (ou declare outra).
  if (looksPdf) return { kind: ATTACHMENT_KINDS.pdf, mime: 'application/pdf', verified: true, warning: null };
  if (extSaysPdf) {
    const what = looksHtml ? 'uma página web (HTML)' : looksZip ? 'um pacote compactado' : recognizedAudio ? 'um áudio' : 'outro tipo de arquivo';
    return {
      kind: ATTACHMENT_KINDS.other,
      mime: mime || 'application/octet-stream',
      verified: false,
      warning: `O arquivo tem extensão .pdf, mas o conteúdo é ${what}. Ele não será aberto como PDF — dá para baixar o original ou enviar o PDF correto.`,
    };
  }
  if (audioLike) {
    if (recognizedAudio) return { kind: ATTACHMENT_KINDS.audio, mime: mime || (isAudioExtension(ext) ? `audio/${ext}` : 'audio/mpeg'), verified: true, warning: null };
    if (looksHtml || looksZip || looksPng || looksJpeg) {
      const what = looksHtml ? 'uma página web (HTML)' : looksZip ? 'um pacote compactado' : 'uma imagem';
      return {
        kind: ATTACHMENT_KINDS.other,
        mime: mime || 'application/octet-stream',
        verified: false,
        warning: `O arquivo tem extensão de áudio, mas o conteúdo é ${what}. Ele não será tocado como áudio nem aberto como documento — só dá para baixar o original ou enviar o arquivo correto.`,
      };
    }
    // Formato sem assinatura conhecida (m4a/aac/opus/webm, por exemplo): o
    // player nativo ainda pode tentar, mas o formato NÃO está confirmado.
    return {
      kind: ATTACHMENT_KINDS.audio,
      mime: mime || 'audio/mpeg',
      verified: false,
      warning: 'Não foi possível confirmar o formato do áudio (sem assinatura conhecida); o player tenta tocar assim mesmo — se não tocar, envie o arquivo em outro formato.',
    };
  }
  if (looksHtml) {
    return {
      kind: ATTACHMENT_KINDS.other,
      mime: 'application/octet-stream',
      verified: true,
      warning: 'Este arquivo é uma página web; ele só pode ser baixado, nunca aberto dentro do aplicativo.',
    };
  }
  return { kind: ATTACHMENT_KINDS.other, mime: mime || 'application/octet-stream', verified: true, warning: null };
}

// Rótulo legível do espaço ocupado, sem inventar precisão.
export function formatAttachmentSize(bytes) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${value} B`;
  const units = ['kB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[unit]}`;
}

export function attachmentKindLabel(kind) {
  if (kind === ATTACHMENT_KINDS.pdf) return 'PDF';
  if (kind === ATTACHMENT_KINDS.audio) return 'Áudio';
  return 'Arquivo';
}

// ------------------------------------------------------------------ registro

function normalizeAttachmentFile(value) {
  if (!isObject(value) || !isText(value.id)) return null;
  if (!isBlob(value.blob) || value.blob.size <= 0) return null;
  const size = Number.isFinite(value.size) ? value.size : value.blob.size;
  const kind = ATTACHMENT_KINDS[value.kind] ?? (value.kind === 'pdf' || value.kind === 'audio' ? value.kind : ATTACHMENT_KINDS.other);
  return {
    id: value.id,
    size,
    mime: isText(value.mime) ? value.mime : (value.blob.type || 'application/octet-stream'),
    kind,
    name: isText(value.name) ? value.name : 'arquivo',
    extension: normalizeExtension(value.extension),
    addedAt: isText(value.addedAt) ? value.addedAt : isoNow(),
    blob: value.blob,
  };
}

function normalizeAttachmentRef(value) {
  if (!isObject(value) || !isText(value.key) || !isText(value.fileId)) return null;
  const parsed = parseAttachmentRefKey(value.key);
  if (!parsed) return null;
  return {
    key: value.key,
    courseId: parsed.courseId,
    lessonId: parsed.lessonId,
    resourceId: parsed.resourceId,
    fileId: value.fileId,
    name: isText(value.name) ? value.name : 'arquivo',
    extension: normalizeExtension(value.extension),
    role: isText(value.role) ? value.role : null,
    source: ATTACHMENT_SOURCES.includes(value.source) ? value.source : 'upload',
    addedAt: isText(value.addedAt) ? value.addedAt : isoNow(),
    verified: value.verified !== false,
    warning: isText(value.warning) ? value.warning : null,
  };
}

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = factory.open(ATTACHMENT_DB_NAME, ATTACHMENT_DB_VERSION);
    } catch (error) {
      reject(describeAttachmentStorageError(error));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ATTACHMENT_STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: ATTACHMENT_KEY_PATHS[name] });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(describeAttachmentStorageError(request.error));
    request.onblocked = () => reject(new AttachmentStorageError('blocked', ATTACHMENTS_BLOCKED_MESSAGE));
  });
}

// Backend sobre IndexedDB. `writeBatch` aceita `{ store, value }` para gravar e
// `{ store, id, remove: true }` para apagar — referência e arquivo mudam na
// MESMA transação, então remover nunca deixa a aula apontando para nada.
function idbBackend(db) {
  const run = (stores, mode, action) => new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(stores, mode);
    } catch (error) {
      reject(describeAttachmentStorageError(error));
      return;
    }
    let result;
    let failed = false;
    const request = action(name => transaction.objectStore(name), transaction);
    if (request) {
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => { failed = true; reject(describeAttachmentStorageError(request.error)); };
    }
    transaction.oncomplete = () => { if (!failed) resolve(result); };
    transaction.onabort = () => { if (!failed) reject(describeAttachmentStorageError(transaction.error || request?.error)); };
    transaction.onerror = event => event.preventDefault();
  });
  return {
    getAll: store => run(store, 'readonly', objectStore => objectStore(store).getAll()),
    get: (store, id) => run(store, 'readonly', objectStore => objectStore(store).get(id)),
    writeBatch: entries => run([...new Set(entries.map(entry => entry.store))], 'readwrite', objectStore => {
      let last = null;
      for (const entry of entries) {
        last = entry.remove ? objectStore(entry.store).delete(entry.id) : objectStore(entry.store).put(entry.value);
      }
      return last;
    }),
    delete: (store, id) => run(store, 'readwrite', objectStore => objectStore(store).delete(id)),
  };
}

function defaultDigest() {
  const subtle = globalThis.crypto?.subtle;
  return subtle && typeof subtle.digest === 'function' ? subtle : null;
}

// Envelope de backup: validado por INTEIRO antes de qualquer decodificação.
function validateAttachmentEnvelope(document) {
  if (!isObject(document) || document.format !== ATTACHMENT_FORMAT) {
    return { ok: false, code: 'invalid', error: 'O arquivo não é um backup de anexos do GrooveGoblin.', errors: [{ path: 'format', code: 'formato', message: 'Formato de anexos não reconhecido.' }], plan: null };
  }
  if (!Number.isInteger(document.version) || document.version > ATTACHMENT_SCHEMA_VERSION) {
    return { ok: false, code: 'version', error: 'O backup de anexos foi criado por uma versão mais nova do GrooveGoblin.', errors: [{ path: 'version', code: 'versao', message: 'Versão de anexos não suportada.' }], plan: null };
  }
  if (!Array.isArray(document.files) || !Array.isArray(document.refs)) {
    return { ok: false, code: 'invalid', error: 'O backup de anexos está incompleto: faltam os arquivos ou as referências.', errors: [{ path: 'files', code: 'estrutura', message: 'Esperado uma lista de arquivos e uma lista de referências.' }], plan: null };
  }
  return null;
}

// --------------------------------------------------------------- loja (fábrica)

export function createAttachmentStore({
  backend, now = isoNow, uuid = defaultUuid, digest = defaultDigest(), persistent = true, error = null,
} = {}) {
  const listeners = new Set();
  const files = new Map();
  const refs = new Map();
  const corrupt = [];
  let loaded = false;
  let loading = null;
  let loadWarning = null;
  let warning = null;

  const unavailable = () => error ?? new AttachmentStorageError('unavailable', ATTACHMENTS_UNAVAILABLE_MESSAGE);

  function requireWritable() {
    if (!persistent || !backend) throw unavailable();
  }

  function emit() {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* um assinante quebrado não derruba a loja */ }
    }
  }

  async function loadAll() {
    const [rawFiles, rawRefs] = await Promise.all([backend.getAll('files'), backend.getAll('refs')]);
    for (const raw of rawFiles) {
      const file = normalizeAttachmentFile(raw);
      if (file) files.set(file.id, file);
      else corrupt.push({ store: 'files', id: raw?.id ?? null });
    }
    for (const raw of rawRefs) {
      const ref = normalizeAttachmentRef(raw);
      if (ref) refs.set(ref.key, ref);
      else corrupt.push({ store: 'refs', id: raw?.key ?? null });
    }
    if (corrupt.length > 0) loadWarning = `Há ${corrupt.length} registro(s) de anexo ilegíveis preservados; nada foi apagado.`;
    loaded = true;
    emit();
  }

  function ready() {
    if (!persistent || !backend || loaded) return Promise.resolve();
    if (!loading) loading = loadAll().catch(cause => { loading = null; throw describeAttachmentStorageError(cause); });
    return loading;
  }

  async function prepare() {
    requireWritable();
    await ready();
  }

  // Escritas SERIALIZADAS: duas mutações concorrentes (outra aba não entra
  // aqui, mas put/remove/import do próprio app sim) são aplicadas em ordem, e a
  // memória nunca fica à frente do banco. O erro continua subindo para quem
  // chamou; a fila só espera o resultado.
  let writeQueue = Promise.resolve();
  function serialize(action) {
    const run = writeQueue.then(action, action);
    writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function contentId(blob) {
    if (digest && blob.size <= ATTACHMENTS_DIGEST_MAX_BYTES) {
      try {
        const hash = await digest.digest('SHA-256', await blob.arrayBuffer());
        const bytes = new Uint8Array(hash);
        let hex = '';
        for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
        return `sha256:${hex}`;
      } catch { /* sem hash: cai no identificador local */ }
    }
    return `local:${uuid()}:${blob.size}`;
  }

  function refsOf(courseId = null) {
    const list = [...refs.values()].filter(ref => courseId === null || ref.courseId === courseId);
    return list.sort((a, b) => (a.addedAt ?? '').localeCompare(b.addedAt ?? '') || a.key.localeCompare(b.key));
  }

  function joined(ref) {
    const file = files.get(ref.fileId) ?? null;
    return {
      ...clone(ref),
      fileId: ref.fileId,
      present: file !== null,
      size: file?.size ?? null,
      mime: file?.mime ?? null,
      kind: file?.kind ?? ATTACHMENT_KINDS.other,
      contentName: file?.name ?? ref.name,
      contentAddedAt: file?.addedAt ?? null,
    };
  }

  function sharedBy(fileId, exceptKey = null) {
    return [...refs.values()].filter(ref => ref.fileId === fileId && ref.key !== exceptKey).length;
  }

  // Espaço ocupado: bytes de arquivos ÚNICOS referenciados (por curso, quando
  // pedido). Arquivo usado por duas aulas conta uma vez só.
  function totalsOf(courseId = null) {
    const list = refsOf(courseId);
    const byKind = { pdf: { files: 0, bytes: 0 }, audio: { files: 0, bytes: 0 }, other: { files: 0, bytes: 0 } };
    let bytes = 0;
    const ids = new Set();
    for (const ref of list) {
      if (ids.has(ref.fileId)) continue;
      ids.add(ref.fileId);
      const file = files.get(ref.fileId);
      if (!file) continue;
      bytes += file.size;
      const bucket = byKind[file.kind] ?? byKind.other;
      bucket.files += 1;
      bucket.bytes += file.size;
    }
    return { files: ids.size, refs: list.length, bytes, byKind };
  }

  async function dropFileIfUnused(fileId) {
    if (!fileId || sharedBy(fileId) > 0 || !files.has(fileId)) return false;
    try {
      await backend.writeBatch([{ store: 'files', id: fileId, remove: true }]);
    } catch {
      // Falha ao liberar espaço não pode apagar a referência: o arquivo órfão
      // continua contado em totals(), honestamente.
      return false;
    }
    files.delete(fileId);
    return true;
  }

  // Corpo do envio de arquivo (chamado serializado por put).
  async function putNow({ courseId, lessonId, resourceId, name = null, extension = null, role = null, blob = null, source = 'upload' } = {}) {
    await prepare();
    if (!isBlob(blob)) throw new TypeError('Envie um arquivo para anexar ao material.');
    if (blob.size <= 0) throw new AttachmentStorageError('empty', 'O arquivo está vazio; nada foi salvo.');
    if (blob.size > ATTACHMENT_LIMITS.fileBytes) {
      throw new AttachmentStorageError('too-large', `Este arquivo tem ${formatAttachmentSize(blob.size)} e passa do limite de ${formatAttachmentSize(ATTACHMENT_LIMITS.fileBytes)} por material. Nada foi salvo.`);
    }
    const cleanName = (isText(name) ? name : 'arquivo').slice(0, ATTACHMENT_LIMITS.name);
    const ext = normalizeExtension(extension ?? extensionOfName(cleanName));
    const sniffed = await sniffAttachmentKind(blob, ext);
    const id = await contentId(blob);
    const timestamp = now();
    const existing = files.get(id) ?? null;
    const key = attachmentRefKey(courseId, lessonId, resourceId);
    const previous = refs.get(key) ?? null;
    const fileRecord = existing ?? {
      id, size: blob.size, mime: sniffed.mime, kind: sniffed.kind, name: cleanName, extension: ext, addedAt: timestamp, blob,
    };
    const refRecord = {
      key, courseId, lessonId, resourceId, fileId: id,
      name: cleanName, extension: ext, role: isText(role) ? role : null,
      source: ATTACHMENT_SOURCES.includes(source) ? source : 'upload',
      addedAt: timestamp,
      verified: sniffed.verified,
      warning: sniffed.warning,
    };
    const entries = [];
    if (!existing) entries.push({ store: 'files', value: fileRecord });
    entries.push({ store: 'refs', value: refRecord });
    try {
      await backend.writeBatch(entries);
    } catch (cause) {
      throw describeAttachmentStorageError(cause);
    }
    if (!existing) files.set(id, fileRecord);
    refs.set(key, refRecord);
    warning = null;
    let freedBytes = 0;
    if (previous && previous.fileId !== id) {
      const previousFile = files.get(previous.fileId);
      const dropped = await dropFileIfUnused(previous.fileId);
      if (dropped) freedBytes = previousFile?.size ?? 0;
    }
    emit();
    return {
      key, fileId: id, size: blob.size, mime: fileRecord.mime, kind: fileRecord.kind,
      reusedFile: existing !== null, replaced: previous !== null, verified: sniffed.verified,
      warning: sniffed.warning ?? null, freedBytes,
    };
  }

  // Corpo da remoção (chamado serializado por remove).
  async function removeNow(key) {
    await prepare();
    const ref = refs.get(key);
    if (!ref) return { removed: false, freedBytes: 0, fileDeleted: false };
    const file = files.get(ref.fileId) ?? null;
    const fileDeleted = sharedBy(ref.fileId, key) === 0 && file !== null;
    const entries = [{ store: 'refs', id: key, remove: true }];
    if (fileDeleted) entries.push({ store: 'files', id: ref.fileId, remove: true });
    try {
      await backend.writeBatch(entries);
    } catch (cause) {
      throw describeAttachmentStorageError(cause);
    }
    refs.delete(key);
    if (fileDeleted) files.delete(ref.fileId);
    emit();
    return { removed: true, freedBytes: fileDeleted ? file.size : 0, fileDeleted, shared: !fileDeleted };
  }

  // Corpo da limpeza explícita (chamado serializado por clearCourse).
  async function clearNow(courseId) {
    await prepare();
    const list = refsOf(courseId);
    if (list.length === 0) return { refs: 0, files: 0, freedBytes: 0 };
    const removing = new Set(list.map(ref => ref.key));
    // Arquivo usado por ref FORA do conjunto continua guardado: a contagem de
    // espaço é feita contra o que sobra, não contra o que sai.
    const remaining = [...refs.values()].filter(ref => !removing.has(ref.key));
    const stillUsed = id => remaining.some(ref => ref.fileId === id);
    const entries = list.map(ref => ({ store: 'refs', id: ref.key, remove: true }));
    let freedBytes = 0;
    let filesDeleted = 0;
    for (const id of new Set(list.map(ref => ref.fileId))) {
      if (stillUsed(id)) continue;
      const file = files.get(id);
      entries.push({ store: 'files', id, remove: true });
      freedBytes += file?.size ?? 0;
      filesDeleted += 1;
    }
    try {
      await backend.writeBatch(entries);
    } catch (cause) {
      throw describeAttachmentStorageError(cause);
    }
    for (const ref of list) refs.delete(ref.key);
    for (const id of new Set(list.map(ref => ref.fileId))) if (!stillUsed(id)) files.delete(id);
    emit();
    return { refs: list.length, files: filesDeleted, freedBytes };
  }

  function api() {
    return {
      get persistent() { return persistent && !!backend; },
      get error() { return error ? error.message ?? String(error) : null; },
      get errorCode() { return error?.code ?? null; },
      get warning() { return warning ?? loadWarning; },
      get schemaVersion() { return ATTACHMENT_SCHEMA_VERSION; },
      get dbName() { return ATTACHMENT_DB_NAME; },
      ready,
      subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('Assinante inválido.');
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      corrupt() { return corrupt.map(entry => clone(entry)); },

      // Lista de METADADOS (sem blob) do material anexado a uma aula.
      list(courseId, lessonId) {
        return refsOf(courseId).filter(ref => ref.lessonId === lessonId).map(joined);
      },
      listByCourse(courseId) { return refsOf(courseId).map(joined); },
      listAll() { return refsOf(null).map(joined); },
      get(key) {
        const ref = refs.get(key);
        return ref ? joined(ref) : null;
      },
      has(key) { return refs.has(key); },
      async getBlob(key) {
        await ready();
        const ref = refs.get(key);
        if (!ref) return null;
        const file = files.get(ref.fileId);
        return file ? file.blob : null;
      },
      async getFile(key) {
        await ready();
        const ref = refs.get(key);
        if (!ref) return null;
        const file = files.get(ref.fileId);
        return file ? { ...clone({ ...file, blob: undefined }), blob: file.blob } : null;
      },

      // Envia (ou substitui) o arquivo de um material (serializado na fila de
      // escrita; o corpo está em putNow, junto dos outros auxiliares).
      put(options = {}) {
        return serialize(() => putNow(options));
      },

      // Remove a REFERÊNCIA; o arquivo só sai quando nenhuma outra aponta para
      // ele (mesmo arquivo em duas aulas ocupa bytes uma vez).
      remove(key) {
        return serialize(() => removeNow(key));
      },

      // Ação EXPLÍCITA de limpeza (nenhum fluxo automático chama isto: remover
      // ou reimportar um curso nunca apaga anexos).
      clearCourse(courseId) {
        return serialize(() => clearNow(courseId));
      },

      // Espaço ocupado pelos anexos (bytes de arquivos únicos).
      totals(courseId = null) { return totalsOf(courseId); },

      // Exportação estruturada (etapa 7): metadados sempre; bytes só quando o
      // usuário pedir (includeBlobs), para o backup padrão ficar leve.
      async exportStructured({ courseId = null, includeBlobs = false } = {}) {
        await ready();
        const list = refsOf(courseId);
        const ids = [...new Set(list.map(ref => ref.fileId))];
        const fileDocs = [];
        for (const id of ids) {
          const file = files.get(id);
          if (!file) continue;
          const doc = { id: file.id, size: file.size, mime: file.mime, kind: file.kind, name: file.name, extension: file.extension, addedAt: file.addedAt };
          if (includeBlobs) {
            try {
              doc.dataBase64 = await blobToBase64(file.blob);
            } catch (cause) {
              return { ok: false, code: 'encode', error: `Não foi possível ler o arquivo “${file.name}” para exportar: ${cause.message}`, document: null };
            }
          }
          fileDocs.push(doc);
        }
        return {
          ok: true,
          document: {
            format: ATTACHMENT_FORMAT,
            version: ATTACHMENT_SCHEMA_VERSION,
            exportedAt: now(),
            scope: courseId === null ? 'todos' : courseId,
            includeBlobs: includeBlobs === true,
            totals: totalsOf(courseId),
            files: fileDocs,
            refs: list.map(ref => ({
              key: ref.key, courseId: ref.courseId, lessonId: ref.lessonId, resourceId: ref.resourceId,
              fileId: ref.fileId, name: ref.name, extension: ref.extension, role: ref.role,
              source: ref.source, addedAt: ref.addedAt, verified: ref.verified, warning: ref.warning,
            })),
          },
        };
      },

      // PRÉ-VOO TOTAL, sem escrever nada: valida o envelope inteiro e
      // decodifica UMA vez os arquivos que a importação usaria. O `prepared`
      // devolvido carrega o plano (metadados) e os blobs prontos para o commit.
      async prepareImport(document, { includeBlobs = true, now: importedAt = now() } = {}) {
        requireWritable();
        await ready();
        const invalid = validateAttachmentEnvelope(document);
        if (invalid) return invalid;
        const byId = new Map();
        for (const file of document.files) if (isText(file?.id)) byId.set(file.id, file);
        const decoded = new Map();
        const errors = [];
        const filePlans = [];
        const refPlans = [];
        const addRefs = [];
        const addFiles = [];
        const reusedFiles = new Set();
        let skipped = 0;

        const decode = id => {
          if (decoded.has(id)) return decoded.get(id);
          const fileDoc = byId.get(id);
          if (!fileDoc || typeof fileDoc.dataBase64 !== 'string') return null;
          try {
            const blob = base64ToBlob(fileDoc.dataBase64, isText(fileDoc.mime) ? fileDoc.mime : 'application/octet-stream');
            if (blob.size <= 0) return null;
            const record = normalizeAttachmentFile({ ...fileDoc, blob, addedAt: importedAt });
            if (!record) return null;
            decoded.set(id, record);
            return record;
          } catch { return null; }
        };

        // 1) Catálogo completo do envelope: o que já existe, o que entra e o que
        // veio sem uso (não é gravado). Colisão de id com tamanho diferente é
        // conflito: o arquivo do usuário é preservado.
        for (const fileDoc of [...byId.values()]) {
          const id = fileDoc.id;
          const stored = files.get(id) ?? null;
          let kind = stored?.kind ?? (ATTACHMENT_KINDS[fileDoc.kind] ?? ATTACHMENT_KINDS.other);
          let verified = stored ? true : null;
          let warning = null;
          const size = Number.isFinite(fileDoc.size) ? fileDoc.size : null;
          const conflict = stored !== null && size !== null && size !== stored.size;
          if (conflict) {
            errors.push({
              path: 'files',
              message: 'Um arquivo do backup tem o mesmo identificador de um arquivo guardado, mas tamanho diferente; o arquivo do usuário foi preservado.',
            });
          }
          filePlans.push({
            id,
            present: stored !== null,
            conflict,
            size: stored?.size ?? size,
            mime: stored?.mime ?? (isText(fileDoc.mime) ? fileDoc.mime : 'application/octet-stream'),
            kind,
            verified,
            warning,
            action: stored ? 'keep' : 'candidate',
          });
        }

        // 2) Referências: nada existente é sobrescrito; só as NOVAS com arquivo
        // utilizável entram — e só os arquivos delas são decodificados/gravados.
        for (const raw of document.refs) {
          const ref = normalizeAttachmentRef(raw);
          if (!ref) {
            errors.push({ path: 'refs', message: 'Uma referência de anexo do backup é inválida e foi ignorada.' });
            refPlans.push({ key: raw?.key ?? null, status: 'invalid', fileId: raw?.fileId ?? null, action: 'skip' });
            skipped += 1;
            continue;
          }
          const stored = refs.get(ref.key) ?? null;
          if (stored) {
            const conflict = stored.fileId !== ref.fileId;
            refPlans.push({ key: ref.key, status: conflict ? 'conflict' : 'existing', fileId: ref.fileId, storedFileId: stored.fileId, action: 'keep' });
            skipped += 1;
            continue;
          }
          if (!byId.has(ref.fileId)) {
            refPlans.push({ key: ref.key, status: 'missing-file', fileId: ref.fileId, action: 'skip' });
            skipped += 1;
            continue;
          }
          if (files.has(ref.fileId)) {
            reusedFiles.add(ref.fileId);
            addRefs.push(ref);
            refPlans.push({ key: ref.key, status: 'new', fileId: ref.fileId, action: 'add' });
            continue;
          }
          const fileDoc = byId.get(ref.fileId);
          if (typeof fileDoc.dataBase64 !== 'string') {
            // Envelope de catálogo (sem bytes): nada a aplicar, mas o plano diz
            // exatamente por quê — só é erro se os bytes foram pedidos.
            if (includeBlobs === true) {
              errors.push({ path: 'files', message: `Os bytes de um arquivo do backup não vieram no envelope (${ref.fileId}).` });
            }
            refPlans.push({ key: ref.key, status: 'blob-missing', fileId: ref.fileId, action: 'skip' });
            skipped += 1;
            continue;
          }
          const record = decode(ref.fileId);
          if (!record) {
            errors.push({ path: 'files', message: `O arquivo de uma referência do backup não pôde ser lido e ela foi ignorada (${ref.fileId}).` });
            refPlans.push({ key: ref.key, status: 'corrupt', fileId: ref.fileId, action: 'skip' });
            skipped += 1;
            continue;
          }
          addRefs.push(ref);
          if (!addFiles.some(item => item.id === record.id)) {
            addFiles.push(record);
            const plan = filePlans.find(item => item.id === record.id);
            if (plan) { plan.action = 'add'; plan.size = record.size; plan.mime = record.mime; plan.kind = record.kind; }
          }
          refPlans.push({ key: ref.key, status: 'new', fileId: ref.fileId, action: 'add' });
        }

        const plan = {
          files: filePlans,
          refs: refPlans,
          addRefs,
          addFiles,
          reusedFiles: reusedFiles.size,
          skipped,
          totals: {
            files: addFiles.length,
            refs: addRefs.length,
            reusedFiles: reusedFiles.size,
            skipped,
            bytes: addFiles.reduce((total, file) => total + file.size, 0),
          },
        };
        return { ok: true, prepared: { plan, preparedAt: now() }, plan, errors };
      },

      // Aplica o plano do `prepareImport`. Se algo mudou no meio do caminho
      // (outra aba/ação), nada é sobrescrito: o que já existe é pulado e o
      // retorno diz `changed: true`. Arquivos e referências entram na MESMA
      // transação; quota negada aborta a transação e nada muda na memória.
      commitPrepared(prepared) {
        return serialize(() => {
          const plan = prepared?.plan;
          if (!isObject(plan) || !Array.isArray(plan.addRefs) || !Array.isArray(plan.addFiles)) {
            return Promise.resolve({ ok: false, code: 'invalid', error: 'Prepare a importação antes de aplicar.', addedFiles: 0, addedRefs: 0, reusedFiles: 0, skipped: 0, bytes: 0, changed: false });
          }
          const run = async () => {
            const entries = [];
            const newFiles = [];
            const newRefs = [];
            let skipped = plan.skipped;
            let changed = false;
            // Referências primeiro: só os arquivos que as refs NOVAS realmente
            // usam são gravados — importar nunca deixa bytes órfãos.
            const wantedRefs = [];
            for (const ref of plan.addRefs) {
              if (refs.has(ref.key)) { changed = true; skipped += 1; continue; }
              wantedRefs.push(ref);
            }
            const neededFileIds = new Set(wantedRefs.map(ref => ref.fileId));
            for (const record of plan.addFiles) {
              if (!neededFileIds.has(record.id)) { changed = true; continue; }
              if (files.has(record.id)) { changed = true; continue; }
              newFiles.push(record);
              entries.push({ store: 'files', value: record });
            }
            for (const ref of wantedRefs) {
              if (!files.has(ref.fileId) && !newFiles.some(record => record.id === ref.fileId)) { changed = true; skipped += 1; continue; }
              newRefs.push(ref);
              entries.push({ store: 'refs', value: ref });
            }
            if (entries.length > 0) {
              try {
                await backend.writeBatch(entries);
              } catch (cause) {
                throw describeAttachmentStorageError(cause);
              }
              for (const record of newFiles) files.set(record.id, record);
              for (const ref of newRefs) refs.set(ref.key, ref);
            }
            emit();
            return {
              ok: true,
              addedFiles: newFiles.length,
              addedRefs: newRefs.length,
              reusedFiles: plan.reusedFiles,
              skipped,
              bytes: newFiles.reduce((total, file) => total + file.size, 0),
              changed,
            };
          };
          return run();
        });
      },
      // Importação em MODO MESCLA: nada existente é sobrescrito nem apagado;
      // referências já presentes são preservadas como estão. É `prepareImport`
      // + `commitPrepared`, então validar e aplicar nunca divergem e nenhum
      // blob é decodificado duas vezes.
      async importStructured(document, { includeBlobs = true, now: importedAt = now() } = {}) {
        const prepared = await api().prepareImport(document, { includeBlobs, now: importedAt });
        if (!prepared.ok) return { ok: false, code: prepared.code, error: prepared.error, errors: prepared.errors };
        const committed = await api().commitPrepared(prepared.prepared);
        return {
          ok: true,
          addedFiles: committed.addedFiles,
          addedRefs: committed.addedRefs,
          reusedFiles: committed.reusedFiles,
          skippedRefs: committed.skipped,
          bytes: committed.bytes,
          changed: committed.changed,
          plan: prepared.plan,
        };
      },
    };
  }

  return api();
}

// Fábrica usada pelo app: a dependência de IndexedDB é explícita e injetável.
export async function openAttachmentStore({ indexedDB = globalThis.indexedDB, now = isoNow, uuid = defaultUuid, digest = defaultDigest() } = {}) {
  if (!indexedDB) {
    return createAttachmentStore({ persistent: false, error: new AttachmentStorageError('unavailable', ATTACHMENTS_UNAVAILABLE_MESSAGE), now, uuid, digest });
  }
  try {
    const db = await openDatabase(indexedDB);
    db.onversionchange = () => db.close();
    return createAttachmentStore({ backend: idbBackend(db), persistent: true, now, uuid, digest });
  } catch (cause) {
    return createAttachmentStore({ persistent: false, error: describeAttachmentStorageError(cause), now, uuid, digest });
  }
}

// Uma única loja já carregada: o tamanho e as referências ficam disponíveis
// para a aula e o backup mesmo quando nenhuma aula foi aberta nesta visita.
let sharedPromise = null;
export function sharedAttachmentStore(options) {
  if (!sharedPromise) sharedPromise = openAttachmentStore(options).then(async store => {
    await store.ready();
    return store;
  });
  return sharedPromise;
}
export function resetSharedAttachmentStore() {
  sharedPromise = null;
}

// ------------------------------------------------------------------ base64

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const encode = globalThis.btoa;
  if (typeof encode !== 'function') throw new Error('Codificação base64 indisponível neste navegador.');
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return encode(binary);
}

export function base64ToBlob(text, mime = 'application/octet-stream') {
  const decode = globalThis.atob;
  if (typeof decode !== 'function') throw new Error('Decodificação base64 indisponível neste navegador.');
  const binary = decode(String(text));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}
