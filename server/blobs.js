// Blobs: upload com hash verificado no stream, tipo pela assinatura do
// conteúdo (nunca pelo que o cliente declarou) e leitura com Range.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { HttpError, declaredLength } from './http.js';
import { openExclusive, removeQuiet, tempName } from './fsutil.js';

const SIGNATURES = [
  { type: 'application/pdf', ext: 'pdf', inline: true, test: (b) => ascii(b, 0, 5) === '%PDF-' },
  { type: 'audio/wav', ext: 'wav', inline: true, test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE' },
  { type: 'audio/ogg', ext: 'ogg', inline: true, test: (b) => ascii(b, 0, 4) === 'OggS' },
  { type: 'audio/flac', ext: 'flac', inline: true, test: (b) => ascii(b, 0, 4) === 'fLaC' },
  { type: 'audio/mpeg', ext: 'mp3', inline: true, test: (b) => ascii(b, 0, 3) === 'ID3' || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { type: 'audio/mp4', ext: 'm4a', inline: true, test: (b) => ascii(b, 4, 4) === 'ftyp' },
  { type: 'audio/webm', ext: 'webm', inline: true, test: (b) => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { type: 'image/png', ext: 'png', inline: true, test: (b) => b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' },
  { type: 'image/jpeg', ext: 'jpg', inline: true, test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'application/zip', ext: 'zip', inline: false, test: (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
];
const UNKNOWN = { type: 'application/octet-stream', ext: 'bin', inline: false };
export const SNIFF_BYTES = 16;

function ascii(bytes, offset, length) {
  if (bytes.length < offset + length) return '';
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function sniffBlob(head) {
  const found = SIGNATURES.find((signature) => signature.test(head));
  return found ? { type: found.type, ext: found.ext, inline: found.inline } : UNKNOWN;
}

// CSP por tipo para quando o blob for aberto direto numa aba/iframe do app.
export function blobCsp(kind) {
  if (kind.type === 'application/pdf') return "default-src 'none'; object-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'";
  if (kind.type.startsWith('audio/')) return "default-src 'none'; media-src 'self'; frame-ancestors 'self'";
  if (kind.type.startsWith('image/')) return "default-src 'none'; img-src 'self'; frame-ancestors 'self'";
  return "default-src 'none'; frame-ancestors 'none'; sandbox";
}

export function blobDisposition(sha, kind) {
  return `${kind.inline ? 'inline' : 'attachment'}; filename="${sha.slice(0, 12)}.${kind.ext}"`;
}

// Interpreta um Range de uma faixa só. Devolve null para ignorar (servir
// inteiro), { unsatisfiable: true } ou { start, end } inclusivos.
export function parseRange(header, size) {
  if (header === null || header === undefined) return null;
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!match) return null; // sintaxe inválida ou várias faixas: RFC 9110 permite ignorar
  const [, first, last] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return { unsatisfiable: true };
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return { unsatisfiable: true };
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return null;
  return { start, end };
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

// Recebe o corpo do PUT em tmp/, calculando sha256 e tamanho, com teto. O
// arquivo volta sincronizado; o chamador decide commit ou descarte. Estourar o
// teto para de gravar na hora sem derrubar o socket, para o 413 ainda chegar.
// `reserveSpace(bytes)` (opcional) reserva espaço de disco ANTES de escrever e
// devolve a função que libera a reserva; sem Content-Length a reserva é o teto
// inteiro do blob. O intake (etapa 8) usa o mesmo gancho.
export async function receiveBlob(request, { tmpDir, maxBytes, reserveSpace = null }) {
  const declared = declaredLength(request, maxBytes);
  const release = reserveSpace ? await reserveSpace(declared ?? maxBytes) : null;
  try {
    const path = join(tmpDir, tempName('blob'));
    const handle = await openExclusive(path);
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      await new Promise((resolve, reject) => {
        let writes = Promise.resolve();
        let settled = false;
        const dropped = () => new HttpError(400, 'bad_request', 'A conexão caiu durante o envio.');
        const finish = (error) => {
          if (settled) return;
          settled = true;
          request.removeListener('data', onData);
          if (error) {
            request.resume();
            reject(error);
          } else resolve();
        };
        const onData = (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new HttpError(413, 'payload_too_large', `Blob maior que o limite de ${maxBytes} bytes.`, { limit: maxBytes }));
            return;
          }
          if (head.length < SNIFF_BYTES) head = Buffer.concat([head, chunk.subarray(0, SNIFF_BYTES - head.length)]);
          hash.update(chunk);
          request.pause();
          writes = writes.then(() => writeAll(handle, chunk)).then(() => { if (!settled) request.resume(); }, finish);
        };
        request.on('data', onData);
        request.once('end', () => writes.then(() => finish(request.complete ? null : dropped())));
        request.once('aborted', () => finish(dropped()));
        request.once('error', () => finish(dropped()));
        request.once('close', () => { if (!request.complete) finish(dropped()); });
      });
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await removeQuiet(path).catch(() => {});
      if (error instanceof HttpError) throw error;
      if (error?.code === 'ENOSPC') throw new HttpError(507, 'insufficient_storage', 'Sem espaço livre no servidor.');
      throw error;
    }
    await handle.close();
    return { path, sha256: hash.digest('hex'), size, kind: sniffBlob(head) };
  } finally {
    release?.();
  }
}
