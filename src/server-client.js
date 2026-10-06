// Cliente da API do servidor pessoal (etapa 7 · B4).
//
// Só fala HTTP: nada aqui conhece lojas locais, DOM ou IndexedDB. Todas as
// chamadas devolvem um resultado discriminado ({ ok: true, … } ou
// { ok: false, code, … }) — uma falha de rede nunca vira exceção para quem
// chamou, porque o app tem de continuar funcionando sem servidor.
//
// Contrato do servidor em `local/round6-server-api.md` (etapa 6, estável):
// - toda rota exige autenticação (mesma origem/Tailscale) e cabeçalhos de
//   segurança; `Cache-Control: private, no-store`;
// - escrita condicional por `ETag` (`If-Match`/`If-None-Match`), 412 com a
//   revisão atual quando a revisão é velha;
// - cursor opaco no feed `changes`, com 410 quando o cursor não serve mais.

export const SERVER_API_VERSION = 1;
export const SERVER_SERVICE = 'groovegoblin';

const JSON_TYPE = 'application/json';
const OCTET_TYPE = 'application/octet-stream';
const DEFAULT_TIMEOUT_MS = 4000;
const BLOB_TIMEOUT_MS = 120000;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256HexPattern(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

// A revisão viaja no `ETag`/`X-Groove-Rev`, sempre entre aspas.
export function parseRevision(headers) {
  const raw = headers?.get?.('x-groove-rev') ?? headers?.get?.('etag') ?? null;
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return /^[0-9]+$/.test(text) ? text : null;
}

function etag(rev) {
  return `"${rev}"`;
}

// O servidor devolve `{"error":"<código>","message":"<pt-BR>"}` em toda falha.
async function readPayload(response) {
  const type = response.headers?.get?.('content-type') ?? '';
  if (!type.includes('json')) return { data: null, text: null };
  let text = null;
  try { text = await response.text(); } catch { return { data: null, text: null }; }
  try { return { data: JSON.parse(text), text }; } catch { return { data: null, text }; }
}

export function createServerClient({
  base = null,
  fetch: fetchImpl = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  online = () => globalThis.navigator?.onLine !== false,
  requestOrigin = null,
  now = () => Date.now(),
} = {}) {
  // Mesma origem: a base é a pasta do app (já inclui o BASE_PATH do GitHub
  // Pages). Em teste, `base` aponta para o servidor efêmero.
  const baseHref = base
    ?? (globalThis.location?.href ? new URL('.', globalThis.location.href).href : 'http://localhost/');
  const root = new URL(baseHref);
  if (!root.pathname.endsWith('/')) root.pathname = `${root.pathname}/`;
  const doFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis) ?? null;

  function url(path, query = null) {
    const target = new URL(path, root);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === null || value === undefined) continue;
      target.searchParams.set(key, String(value));
    }
    return target.href;
  }

  // Cada pedido tem teto de tempo próprio: servidor mudo não pode travar o app.
  async function request(method, path, { body = null, headers = {}, query = null, timeout = timeoutMs, contentType = JSON_TYPE, raw = false } = {}) {
    if (typeof doFetch !== 'function') return { ok: false, status: 0, code: 'unsupported', message: 'Este navegador não sabe falar com o servidor.', offline: false };
    if (method !== 'GET' && method !== 'HEAD' && !online()) return { ok: false, status: 0, code: 'offline', message: 'Sem conexão.', offline: true };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), Math.max(1, timeout)) : null;
    const sent = { ...headers };
    if (sent.Accept === undefined) sent.Accept = JSON_TYPE;
    if (body !== null && body !== undefined) sent['Content-Type'] = contentType;
    // O navegador já envia Origin/Sec-Fetch-Site sozinho nas escritas; em teste
    // (Node) estes cabeçalhos são informados de fora.
    if (requestOrigin && method !== 'GET' && method !== 'HEAD') {
      sent.Origin = requestOrigin;
      sent['Sec-Fetch-Site'] = 'same-origin';
    }
    let response;
    try {
      response = await doFetch(url(path, query), {
        method,
        headers: sent,
        body: body === null || body === undefined ? undefined : body,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller?.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = error?.name === 'AbortError';
      return { ok: false, status: 0, code: aborted ? 'timeout' : 'network', message: aborted ? 'O servidor não respondeu a tempo.' : 'O servidor não respondeu.', offline: false, cause: error };
    }
    clearTimeout(timer);
    if (raw) return { ok: response.ok, status: response.status, headers: response.headers, response };
    const { data } = await readPayload(response);
    if (response.ok) return { ok: true, status: response.status, headers: response.headers, data };
    return {
      ok: false,
      status: response.status,
      headers: response.headers,
      data,
      code: typeof data?.error === 'string' ? data.error : `http_${response.status}`,
      message: typeof data?.message === 'string' ? data.message : `O servidor respondeu ${response.status}.`,
      offline: false,
    };
  }

  const jsonRequest = (method, path, value, options = {}) => request(method, path, {
    ...options,
    body: value === undefined ? null : JSON.stringify(value),
  });

  return {
    get base() { return root.href; },
    // Endereço direto de um blob: o navegador toca áudio e abre PDF por aqui,
    // com Range e sem passar pelo cache do service worker.
    blobUrl(sha256) {
      if (!sha256HexPattern(sha256)) throw new TypeError('Blob precisa do sha256 em hexadecimal.');
      return url(`api/blobs/${sha256}`);
    },
    convertUrl() { return url('api/courses/convert'); },

    // ------------------------------------------------------------- descoberta
    // `health` é a única chamada que decide se o app entra em modo servidor.
    // 404 (site estático), erro de rede e tempo esgotado significam "modo
    // local", sem aviso; 401 é um problema de identidade que merece aviso.
    async probe({ timeout = timeoutMs } = {}) {
      const result = await request('GET', 'api/health', { timeout });
      if (result.ok) {
        const health = result.data;
        if (!isObject(health) || health.ok !== true || health.service !== SERVER_SERVICE) {
          return { ok: false, mode: 'local', code: 'unsupported', message: 'A resposta do servidor não é do GrooveGoblin.' };
        }
        return { ok: true, health, apiVersion: health.apiVersion ?? null, mode: health.mode ?? 'dev' };
      }
      if (result.status === 404) return { ok: false, mode: 'local', code: 'local', message: 'Sem servidor nesta origem.' };
      if (result.status === 401 || result.status === 403) {
        return { ok: false, mode: 'identity', code: result.code, message: 'Identidade do Tailscale ausente ou não permitida neste dispositivo.' };
      }
      return { ok: false, mode: 'local', code: result.code, status: result.status, message: result.message };
    },

    // ------------------------------------------------------------ documentos
    async listDocs(collection, { timeout } = {}) {
      const result = await request('GET', `api/docs/${encodeURIComponent(collection)}`, { timeout });
      if (!result.ok) return result;
      const items = Array.isArray(result.data?.items) ? result.data.items : [];
      return { ok: true, items, cursor: result.data?.cursor ?? null };
    },

    // Leitura condicional: `rev` conhecida e igual → `notModified` (nada muda
    // localmente, nenhum byte trafega).
    async getDoc(collection, id, { rev = null, timeout } = {}) {
      const headers = rev ? { 'If-None-Match': etag(rev) } : {};
      const result = await request('GET', `api/docs/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, { headers, timeout });
      if (result.status === 304) return { ok: true, notModified: true, rev, body: null, deleted: false };
      if (!result.ok) {
        return {
          ...result,
          deleted: result.status === 404 && result.data?.deleted === true,
          rev: parseRevision(result.headers),
        };
      }
      return {
        ok: true,
        notModified: false,
        rev: parseRevision(result.headers),
        body: result.data,
        deleted: result.data?.deleted === true,
      };
    },

    // Escrita condicional. `create` exige `If-None-Match: *`; `rev` exige
    // `If-Match: "<rev>"`. 412 devolve `conflict` com a revisão atual do
    // servidor — quem chama guarda a cópia local e busca o documento atual.
    async putDoc(collection, id, body, { create = false, rev = null, timeout } = {}) {
      const headers = create ? { 'If-None-Match': '*' } : rev ? { 'If-Match': etag(rev) } : null;
      if (!headers) return { ok: false, status: 0, code: 'precondition_required', message: 'Toda escrita precisa de revisão ou de criação explícita.' };
      const result = await jsonRequest('PUT', `api/docs/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, body, { headers, timeout });
      if (result.status === 412) {
        const current = isObject(result.data?.current) ? result.data.current : null;
        return {
          ok: false,
          status: 412,
          code: 'precondition_failed',
          message: 'O documento mudou no servidor desde a última sincronização.',
          // O servidor manda só a revisão atual (`{rev, deleted}`): o CORPO da
          // versão do servidor vem do `getDoc` seguinte, nunca daqui.
          conflict: { rev: current?.rev ?? parseRevision(result.headers), deleted: current?.deleted === true, body: null },
        };
      }
      if (!result.ok) return result;
      return {
        ok: true,
        status: result.status,
        rev: parseRevision(result.headers) ?? result.data?.rev ?? null,
        // Criação é 201 no servidor; a resposta não traz campo `created`.
        created: result.status === 201,
        cursor: result.data?.cursor ?? null,
      };
    },

    async deleteDoc(collection, id, { rev = null, timeout } = {}) {
      const headers = rev ? { 'If-Match': etag(rev) } : null;
      if (!headers) return { ok: false, status: 0, code: 'precondition_required', message: 'Remover exige a revisão atual.' };
      const result = await request('DELETE', `api/docs/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, { headers, timeout });
      if (result.status === 412) {
        const current = isObject(result.data?.current) ? result.data.current : null;
        return { ok: false, status: 412, code: 'precondition_failed', message: 'O documento mudou no servidor.', conflict: { rev: current?.rev ?? parseRevision(result.headers), deleted: current?.deleted === true } };
      }
      if (!result.ok) return result;
      return { ok: true, status: result.status, rev: parseRevision(result.headers) ?? result.data?.rev ?? null, deleted: result.data?.deleted === true };
    },

    // ---------------------------------------------------------------- feed
    // Pagina até `more:false`. 410 (cursor_reset/cursor_expired) pede
    // ressincronização completa, sem `since`.
    async changes({ since = null, limit = 500, timeout } = {}) {
      const result = await request('GET', 'api/changes', { query: { since, limit }, timeout });
      if (!result.ok) return result;
      return {
        ok: true,
        cursor: result.data?.cursor ?? null,
        more: result.data?.more === true,
        changes: Array.isArray(result.data?.changes) ? result.data.changes : [],
      };
    },

    // --------------------------------------------------------------- blobs
    async headBlob(sha256, { timeout } = {}) {
      if (!sha256HexPattern(sha256)) return { ok: false, status: 0, code: 'invalid_sha', message: 'Hash de arquivo inválido.' };
      const result = await request('HEAD', `api/blobs/${sha256}`, { timeout });
      if (result.ok) return { ok: true, exists: true, size: Number(result.headers?.get?.('content-length') ?? 0) || null };
      if (result.status === 404) return { ok: true, exists: false, size: null };
      return result;
    },

    // Backend endereçado por conteúdo: o servidor confere o hash durante a
    // leitura; um 200 sem corpo significa que o blob já existia.
    async putBlob(sha256, bytes, { timeout = BLOB_TIMEOUT_MS } = {}) {
      if (!sha256HexPattern(sha256)) return { ok: false, status: 0, code: 'invalid_sha', message: 'Hash de arquivo inválido.' };
      const result = await request('PUT', `api/blobs/${sha256}`, { body: bytes, contentType: OCTET_TYPE, timeout });
      if (!result.ok) return result;
      return { ok: true, status: result.status, created: result.data?.created === true, size: result.data?.size ?? null };
    },

    async deleteBlob(sha256, { timeout } = {}) {
      if (!sha256HexPattern(sha256)) return { ok: false, status: 0, code: 'invalid_sha', message: 'Hash de arquivo inválido.' };
      const result = await request('DELETE', `api/blobs/${sha256}`, { timeout });
      if (!result.ok) return { ...result, missing: result.status === 404 };
      return { ok: true, status: result.status, deleted: result.data?.deleted === true };
    },

    async readBlob(sha256, { timeout = BLOB_TIMEOUT_MS } = {}) {
      if (!sha256HexPattern(sha256)) return { ok: false, status: 0, code: 'invalid_sha', message: 'Hash de arquivo inválido.' };
      const result = await request('GET', `api/blobs/${sha256}`, { timeout, raw: true });
      if (!result.ok) return result;
      try {
        const bytes = new Uint8Array(await result.response.arrayBuffer());
        return { ok: true, bytes, status: result.status };
      } catch (error) {
        return { ok: false, status: result.status, code: 'network', message: 'Não foi possível ler o arquivo do servidor.', cause: error };
      }
    },

    // -------------------------------------------------------------- privados
    async putPrivate(name, value, { timeout } = {}) {
      const result = await jsonRequest('PUT', `api/private/${encodeURIComponent(name)}`, value, { timeout });
      if (!result.ok) return result;
      return { ok: true, status: result.status, sha256: result.data?.sha256 ?? null, size: result.data?.size ?? null };
    },

    async getPrivate(name, { timeout } = {}) {
      const result = await request('GET', `api/private/${encodeURIComponent(name)}`, { timeout });
      if (!result.ok) return result;
      return { ok: true, status: result.status, body: result.data };
    },

    // ------------------------------------------------------------ conversão
    // O servidor guarda mapa e catálogo na área privada e grava o curso
    // convertido em `courses/<id>`; a resposta nunca traz o conteúdo.
    async convert({ map = undefined, catalog = undefined, includeProgress = false, dryRun = false, expectedRev = null, timeout = 60000 } = {}) {
      const payload = { includeProgress, dryRun };
      if (map !== undefined) payload.map = map;
      if (catalog !== undefined) payload.catalog = catalog;
      if (expectedRev !== null) payload.expectedRev = expectedRev;
      const result = await jsonRequest('POST', 'api/courses/convert', payload, { timeout });
      if (result.ok) {
        return {
          ok: true,
          status: result.status,
          saved: result.data?.saved === true,
          created: result.data?.created === true,
          courseId: result.data?.courseId ?? null,
          rev: parseRevision(result.headers) ?? result.data?.rev ?? null,
          counts: result.data?.counts ?? null,
          warnings: Array.isArray(result.data?.warnings) ? result.data.warnings : [],
          private: result.data?.private ?? null,
        };
      }
      if (result.status === 422) {
        return { ok: false, status: 422, code: 'conversion_invalid', message: result.message, problems: result.data?.problems ?? [], warnings: result.data?.warnings ?? [], counts: result.data?.counts ?? null, private: result.data?.private ?? null };
      }
      if (result.status === 409) {
        return { ok: false, status: 409, code: 'conflict', message: result.message, courseId: result.data?.courseId ?? null, rev: result.data?.rev ?? null, counts: result.data?.counts ?? null, warnings: result.data?.warnings ?? [], private: result.data?.private ?? null };
      }
      return result;
    },
  };
}
