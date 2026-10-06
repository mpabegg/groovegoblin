// Respostas, cabeçalhos de segurança e leitura limitada de corpo.

export const STATIC_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "manifest-src 'self'",
].join('; ');
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";
const HSTS = 'max-age=31536000';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

export function baseSecurityHeaders({ hsts }) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (hsts) headers['Strict-Transport-Security'] = HSTS;
  return headers;
}

// Cabeçalhos de TODA resposta estática (inclusive os fallbacks 400/404 do app):
// o mesmo conjunto que o handler estático usa, com a CSP estática (uma só fonte).
export function staticSecurityHeaders({ hsts }) {
  return { ...baseSecurityHeaders({ hsts }), 'Content-Security-Policy': STATIC_CSP };
}

export function apiHeaders(context, extra = {}) {
  return {
    ...baseSecurityHeaders(context),
    'Content-Security-Policy': API_CSP,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'private, no-store',
    ...extra,
  };
}

export function sendJson(response, context, status, value, extra = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, apiHeaders(context, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    ...extra,
  }));
  response.end(response.req.method === 'HEAD' ? undefined : body);
}

export function sendEmpty(response, context, status, extra = {}) {
  response.writeHead(status, apiHeaders(context, extra));
  response.end();
}

export function sendError(response, context, error) {
  const body = { error: error.code, message: error.message, ...error.extra };
  const headers = { ...error.headers };
  // Corpo não lido numa resposta de erro: fechar a conexão evita ler 200 MiB à toa.
  if (!response.req.complete) headers.Connection = 'close';
  sendJson(response, context, error.status, body, headers);
}

export function headerCount(request, name) {
  const lower = name.toLowerCase();
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === lower) count += 1;
  }
  return count;
}

export function singleHeader(request, name) {
  const count = headerCount(request, name);
  if (count === 0) return null;
  if (count > 1) throw new HttpError(400, 'duplicate_header', `Cabeçalho ${name} repetido.`);
  return request.headers[name.toLowerCase()];
}

export function declaredLength(request, limit) {
  const raw = singleHeader(request, 'content-length');
  if (raw === null) return null;
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, 'bad_request', 'Content-Length inválido.');
  const length = Number(raw);
  if (length > limit) throw new HttpError(413, 'payload_too_large', `Corpo maior que o limite de ${limit} bytes.`, { limit });
  return length;
}

// Lê o corpo inteiro com teto. Estourar o teto interrompe a leitura na hora.
export function readBody(request, limit) {
  declaredLength(request, limit);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const fail = (error) => {
      if (done) return;
      done = true;
      request.removeListener('data', onData);
      request.resume();
      reject(error);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > limit) {
        fail(new HttpError(413, 'payload_too_large', `Corpo maior que o limite de ${limit} bytes.`, { limit }));
        return;
      }
      chunks.push(chunk);
    };
    request.on('data', onData);
    request.once('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, total));
    });
    request.once('error', () => fail(new HttpError(400, 'bad_request', 'A conexão caiu durante o envio.')));
    request.once('aborted', () => fail(new HttpError(400, 'bad_request', 'A conexão caiu durante o envio.')));
  });
}

const JSON_TYPE = /^application\/json(?:\s*;\s*charset=(?:"utf-8"|utf-8))?$/i;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export function requireContentType(request, expected) {
  const type = singleHeader(request, 'content-type');
  const ok = expected === 'json' ? JSON_TYPE.test(type ?? '') : (type ?? '').trim().toLowerCase() === expected;
  if (!ok) {
    throw new HttpError(415, 'unsupported_media_type', expected === 'json'
      ? 'Envie o corpo como application/json.'
      : `Envie o corpo como ${expected}.`);
  }
}

export async function readJson(request, limit, { object = true } = {}) {
  requireContentType(request, 'json');
  const body = await readBody(request, limit);
  let value;
  try {
    value = JSON.parse(decoder.decode(body));
  } catch {
    throw new HttpError(400, 'invalid_json', 'O corpo não é JSON UTF-8 válido.');
  }
  if (object && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new HttpError(400, 'invalid_json', 'O corpo precisa ser um objeto JSON.');
  }
  return value;
}
