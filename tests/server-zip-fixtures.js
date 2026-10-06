// Construtor de ZIP para os testes da etapa 8 (B4b). Fictício e mínimo: monta
// arquivos no formato real (cabeçalho local, diretório central, EOCD) para o
// leitor nativo poder ser exercitado de verdade, inclusive nos casos ruins
// (travessia, link simbólico, cifra, tamanho mentiroso).

import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function buildPdf(texto = 'curso de exemplo') {
  return Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.from(texto, 'utf8'), Buffer.from('\n%%EOF\n', 'latin1')]);
}

// entries: { name, data, method: 'store'|'deflate', flags, mode, encrypted,
//            declaredUncompressed, packed, localOffset }
// Overrides do EOCD existem só para os casos ruins (multidisco, ZIP64, corte).
export function buildZip(entries, { comment = '', disk = 0, cdDisk = 0, entriesTotal = null, cdSize = null, cdOffset = null } = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.method === 'deflate' ? 8 : 0;
    const flags = (entry.encrypted ? 0x0001 : 0) | (/[^\x00-\x7f]/.test(entry.name) ? 0x0800 : 0) | (entry.flags ?? 0);
    const packed = entry.packed ?? (method === 8 ? deflateRawSync(raw) : raw);
    const declared = entry.declaredUncompressed ?? raw.length;
    const crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(declared, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, packed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x031e, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(packed.length, 20);
    centralHeader.writeUInt32LE(declared, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(entry.localOffset ?? offset, 42);
    central.push(centralHeader, name);
    offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  const commentBytes = Buffer.from(comment, 'utf8');
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(disk, 4);
  eocd.writeUInt16LE(cdDisk, 6);
  eocd.writeUInt16LE(entriesTotal ?? entries.length, 8);
  eocd.writeUInt16LE(entriesTotal ?? entries.length, 10);
  eocd.writeUInt32LE(cdSize ?? directory.length, 12);
  eocd.writeUInt32LE(cdOffset ?? offset, 16);
  eocd.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...local, directory, eocd, commentBytes]);
}

export const UNIX_SYMLINK = 0o120777;
export const UNIX_DIRECTORY = 0o040755;
