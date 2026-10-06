// Leitor de ZIP nativo, limitado e sem dependências (rodada 6, etapa 8 / B4b).
//
// Só o necessário para abrir os pacotes de PDF de um curso, e sempre com o
// servidor no comando do que é aceito:
//  - diretório central (assinatura, contagem, tamanho e deslocamento) conferido
//    antes de olhar qualquer membro;
//  - travessia recusada (nome absoluto, `..`, contrabarra, letra de unidade,
//    caractere de controle, nome vazio ou longo demais);
//  - link simbólico recusado pelos atributos externos do UNIX;
//  - ZIP criptografado recusado (flag de cifra e método AES);
//  - método de compressão só `store` (0) e `deflate` (8);
//  - ZIP64 recusado (o teto de membro é 64 MiB, não precisa);
//  - bomba recusada por tamanho declarado, por razão de compressão e por
//    `maxOutputLength` do próprio zlib (nunca confiamos no tamanho declarado);
//  - orçamento CUMULATIVO entre lotes e entre arquivos (membros e bytes), para
//    uma pasta inteira de ZIPs não estourar a memória do Pi;
//  - nenhum membro é descompactado além do que sobra do total do arquivo e do
//    orçamento do curso, e TODO byte descompactado entra na conta — inclusive o
//    de um ".pdf" com assinatura inválida, que era descartado sem contar.
//
// O conteúdo nunca é servido direto: quem grava é o blob store (endereçado por
// sha256, com tipo pela assinatura). Aqui só devolvemos os membros já filtrados.

import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const inflateRawAsync = promisify(inflateRaw);

const MIB = 1024 * 1024;
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const EOCD_MAX_COMMENT = 0xffff;
const CD_FIXED = 46;
const LOCAL_FIXED = 30;
const UNIX_LINK = 0xa000;
const UNIX_DIR = 0x4000;
const UNIX_MODE_MASK = 0xf000;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const METHOD_AES = 99;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const PDF_SIGNATURE = Buffer.from('%PDF-');

export const ZIP_LIMITS = Object.freeze({
  maxEntries: 2000,          // membros no diretório central
  maxMemberBytes: 64 * MIB,  // por membro descompactado
  maxTotalBytes: 512 * MIB,  // por arquivo, somando os membros lidos
  maxRatio: 400,             // descompactado / compactado
  maxNameBytes: 240,         // por nome de membro
});

const SKIP_DEFAULTS = Object.freeze(['.DS_Store', 'Thumbs.db', '__MACOSX/', '.git/']);

export class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

export function isZipSignature(head) {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

// Sanitiza o nome de um membro: devolve o nome normalizado ou lança. A barra
// final é do formato (membro de diretório), não travessia: ela é ignorada na
// conferência das partes.
function safeMemberName(raw, limits) {
  if (raw === '') throw new ZipError('bad-name', 'Um membro do ZIP não tem nome.');
  if (Buffer.byteLength(raw, 'utf8') > limits.maxNameBytes) throw new ZipError('bad-name', 'Um nome de membro do ZIP é longo demais.');
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new ZipError('bad-name', 'Um nome de membro do ZIP tem caractere de controle.');
  if (raw.includes('\\')) throw new ZipError('bad-name', 'Um nome de membro do ZIP usa contrabarra.');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new ZipError('bad-name', 'Um nome de membro do ZIP é um caminho absoluto.');
  const parts = (raw.endsWith('/') ? raw.slice(0, -1) : raw).split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') throw new ZipError('bad-name', 'Um nome de membro do ZIP tenta sair da pasta.');
  }
  return raw;
}

function findEocd(buffer) {
  if (buffer.length < EOCD_MIN) return -1;
  const first = Math.max(0, buffer.length - EOCD_MIN - EOCD_MAX_COMMENT);
  for (let offset = buffer.length - EOCD_MIN; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIG) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + EOCD_MIN + commentLength === buffer.length) return offset;
  }
  return -1;
}

function decodeName(buffer, flags) {
  const utf8 = (flags & FLAG_UTF8) !== 0;
  return buffer.toString(utf8 ? 'utf8' : 'latin1');
}

// Diretório central conferido: devolve a lista de membros (sem descompactar).
export function readCentralDirectory(buffer, limits = ZIP_LIMITS) {
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_MIN) throw new ZipError('truncated', 'O arquivo é pequeno demais para ser um ZIP.');
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new ZipError('not-zip', 'O arquivo não tem o fim de diretório central de um ZIP.');
  const disk = buffer.readUInt16LE(eocd + 4);
  const cdDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entriesTotal = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('multidisk', 'O ZIP é multidisco; não é aceito aqui.');
  if (entriesOnDisk !== entriesTotal) throw new ZipError('multidisk', 'O ZIP está incompleto (nem todas as partes estão no arquivo).');
  if (entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('zip64', 'O ZIP usa o formato ZIP64; não é aceito aqui.');
  if (entriesTotal > limits.maxEntries) throw new ZipError('too-many-entries', `O ZIP tem mais de ${limits.maxEntries} membros.`);
  if (cdOffset + cdSize > eocd) throw new ZipError('truncated', 'O diretório central do ZIP aponta para fora do arquivo.');

  const entries = [];
  let cursor = cdOffset;
  for (let index = 0; index < entriesTotal; index += 1) {
    if (cursor + CD_FIXED > buffer.length || buffer.readUInt32LE(cursor) !== CD_SIG) throw new ZipError('truncated', 'O diretório central do ZIP está cortado.');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + CD_FIXED + nameLength + extraLength + commentLength;
    if (end > buffer.length) throw new ZipError('truncated', 'O diretório central do ZIP está cortado.');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('zip64', 'O ZIP usa o formato ZIP64; não é aceito aqui.');
    const name = safeMemberName(decodeName(buffer.subarray(cursor + CD_FIXED, cursor + CD_FIXED + nameLength), flags), limits);
    const mode = (externalAttributes >>> 16) & UNIX_MODE_MASK;
    if ((flags & FLAG_ENCRYPTED) !== 0 || method === METHOD_AES) throw new ZipError('encrypted', 'Um membro do ZIP é criptografado.');
    if (mode === UNIX_LINK) throw new ZipError('symlink', 'Um membro do ZIP é um link simbólico.');
    const directory = mode === UNIX_DIR || name.endsWith('/');
    if (!directory && method !== METHOD_STORE && method !== METHOD_DEFLATE) throw new ZipError('unsupported-method', `Um membro do ZIP usa um método de compressão (${method}) que não é aceito.`);
    entries.push({
      name,
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localOffset,
      directory,
      ignored: SKIP_DEFAULTS.some((item) => name === item || name.startsWith(item)),
    });
    cursor = end;
  }
  if (cursor > cdOffset + cdSize) throw new ZipError('truncated', 'O diretório central do ZIP passa do próprio tamanho declarado.');
  return entries;
}

// Descompacta UM membro. O teto de saída é do zlib (`maxOutputLength`), então um
// cabeçalho mentiroso não vira alocação gigante. `maxOutput` (opcional) rebaixa
// esse teto para o que ainda cabe no total do arquivo e no orçamento do curso.
export async function readMember(buffer, entry, limits = ZIP_LIMITS, maxOutput = null) {
  if (entry.directory) throw new ZipError('bad-name', 'Uma pasta do ZIP não tem conteúdo.');
  if (entry.uncompressedSize > limits.maxMemberBytes) throw new ZipError('member-too-large', 'Um membro do ZIP passa do tamanho máximo aceito.');
  const cap = maxOutput === null ? limits.maxMemberBytes : Math.min(limits.maxMemberBytes, maxOutput);
  if (cap <= 0) throw new ZipError('total-too-large', 'Não sobra orçamento para descompactar outros membros deste ZIP.');
  const start = entry.localOffset;
  if (start + LOCAL_FIXED > buffer.length || buffer.readUInt32LE(start) !== LOCAL_SIG) throw new ZipError('bad-local-header', 'Um membro do ZIP não tem cabeçalho local válido.');
  const nameLength = buffer.readUInt16LE(start + 26);
  const extraLength = buffer.readUInt16LE(start + 28);
  const dataStart = start + LOCAL_FIXED + nameLength + extraLength;
  if (dataStart + entry.compressedSize > buffer.length) throw new ZipError('truncated', 'Um membro do ZIP está cortado.');
  const packed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === METHOD_STORE) {
    if (packed.length !== entry.uncompressedSize) throw new ZipError('size-mismatch', 'Um membro do ZIP tem tamanho declarado diferente do conteúdo.');
    return Buffer.from(packed);
  }
  if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.maxRatio) {
    throw new ZipError('ratio', 'Um membro do ZIP tem razão de compressão absurda (possível bomba).');
  }
  let data;
  try {
    data = await inflateRawAsync(packed, { maxOutputLength: cap });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /larger than|maxOutputLength/i.test(error?.message ?? '')) {
      throw new ZipError('bomb', 'Um membro do ZIP descompacta além do limite aceito.');
    }
    throw new ZipError('corrupt', 'Um membro do ZIP não pôde ser descompactado.');
  }
  if (data.length !== entry.uncompressedSize) throw new ZipError('size-mismatch', 'Um membro do ZIP tem tamanho declarado diferente do conteúdo.');
  return data;
}

// Orçamento cumulativo: o chamador cria um só por curso/lote e passa em todas as
// chamadas, para a soma dos ZIPs não estourar os limites.
export function createZipBudget({ maxFiles, maxBytes }) {
  return { files: 0, bytes: 0, maxFiles, maxBytes };
}

// Cobra o orçamento. Os BYTES contam sempre (o custo de descompactar já
// aconteceu, mesmo quando o membro não é PDF e não vai ser guardado); `files`
// fica em 0 para esses, para um ".pdf" mentiroso não gastar a cota de materiais.
function chargeBudget(budget, bytes, files = 1) {
  if (!budget) return;
  if (budget.files + files > budget.maxFiles) throw new ZipError('budget', 'Os pacotes deste curso já passaram do número de PDFs aceito.');
  if (budget.bytes + bytes > budget.maxBytes) throw new ZipError('budget', 'Os pacotes deste curso já passaram do tamanho aceito.');
  budget.files += files;
  budget.bytes += bytes;
}

// O teto desta descompactação: o menor entre o limite do membro, o que falta do
// total do arquivo e o que falta do orçamento cumulativo. É esse número que vira
// `maxOutputLength` do zlib: nenhum membro descompacta além do que resta.
function remainingRoom(limits, budget, totalBytes) {
  return Math.min(limits.maxMemberBytes, limits.maxTotalBytes - totalBytes, budget ? budget.maxBytes - budget.bytes : Infinity);
}

function roomError(limits, budget, totalBytes, room) {
  const roomTotal = limits.maxTotalBytes - totalBytes;
  if (roomTotal <= 0 || roomTotal === room) return new ZipError('total-too-large', 'O ZIP descompacta além do limite aceito.');
  return new ZipError('budget', 'Os pacotes deste curso já passaram do tamanho aceito.');
}

// Lê os membros que interessam (por padrão, PDFs). Devolve contagens do que foi
// visto para o relatório poder ser honesto sem expor nomes que não casaram.
export async function readZipMembers(buffer, { limits = ZIP_LIMITS, budget = null, accept = null } = {}) {
  const entries = readCentralDirectory(buffer, limits);
  const members = [];
  let totalBytes = 0;
  let candidates = 0;
  for (const entry of entries) {
    if (entry.directory) continue;
    if (entry.ignored) continue;
    if (accept && !accept(entry.name)) continue;
    candidates += 1;
    if (entry.uncompressedSize > limits.maxMemberBytes) throw new ZipError('member-too-large', 'Um membro do ZIP passa do tamanho máximo aceito.');
    const room = remainingRoom(limits, budget, totalBytes);
    if (room <= 0 || entry.uncompressedSize > room) throw roomError(limits, budget, totalBytes, room);
    const data = await readMember(buffer, entry, limits, room);
    // Todo byte EFETIVAMENTE descompactado entra na conta do arquivo e do curso,
    // antes de saber se é PDF: um ".pdf" de assinatura inválida custa a mesma
    // memória e o mesmo tempo de CPU que um PDF de verdade.
    totalBytes += data.length;
    // A assinatura manda: um ".pdf" que não é PDF não entra.
    if (!isZipSignature(data) && !data.subarray(0, 5).equals(PDF_SIGNATURE)) {
      chargeBudget(budget, data.length, 0);
      members.push({ name: entry.name, data: null, invalid: true, skipped: true });
      continue;
    }
    chargeBudget(budget, data.length);
    members.push({ name: entry.name, data, invalid: false, skipped: false });
  }
  return { entries: entries.length, candidates, members, bytes: totalBytes };
}
