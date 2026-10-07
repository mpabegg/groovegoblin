// Conteúdo de curso no servidor: cliente da API de materiais (rodada 6, etapa 8 / B4b).
//
// Este módulo é a única porta do app para o material do curso que mora no
// servidor pessoal. Ele:
//  - sonda `GET api/health` na própria origem, com tempo curto e SEM barulho:
//    sem servidor (404, rede fora, resposta estranha) o app fica em modo local
//    exatamente como hoje, e toda a interface de material do servidor fica
//    escondida (os anexos manuais do navegador continuam iguais);
//  - lê o relatório de materiais do curso (disponíveis/faltantes/não casados);
//  - importa a pasta de entrada (`POST .../materials/scan`: casa por nome e grava
//    o que falta) e só então lê o relatório — ler nunca escreve no servidor;
//  - envia arquivo por arquivo (o usuário pode arrastar vários: o app enfileira);
//  - vincula manualmente um arquivo a um material;
//  - lê os vínculos (`courseAttachments/<courseId>`, mesmo shape da etapa 7) e
//    monta a URL do blob autenticado para o painel/player.
//
// Nada aqui usa URL externa, `eval`, HTML de terceiros nem nome de arquivo em
// log. O nome do arquivo vai no cabeçalho `X-Groove-Filename`, percent-encoded.
//
// O DOM do relatório/pasta de entrada é montado aqui para que a página do curso
// precise de uma linha só (ver o patch de integração).

import { createEl } from './practice.js';
// Mesma detecção de servidor da sincronização: o marcador
// `data-groove-server` no `<html>`. Página estática tem `off` e nada aqui
// toca a rede.
import { serverMarkerSays } from './sync-engine.js';

const DOCS_PREFIX = 'api/docs/courseAttachments';
const MATERIALS_PREFIX = 'api/courses';
const BLOBS_PREFIX = 'api/blobs';
const HEALTH_PATH = 'api/health';

export const CONTENT_PROBE_TIMEOUT_MS = 6000;
export const CONTENT_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export const CONTENT_STATUS = Object.freeze({ unknown: 'unknown', ready: 'ready', local: 'local' });
export const CONTENT_KINDS = Object.freeze({ pdf: 'pdf', audio: 'audio', other: 'other' });

export const CONTENT_AUDIO_EXTENSIONS = Object.freeze(['mp3', 'wav', 'wave', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'webm']);
export const CONTENT_PDF_EXTENSIONS = Object.freeze(['pdf']);
export const CONTENT_ZIP_EXTENSIONS = Object.freeze(['zip']);
export const CONTENT_ACCEPT = '.pdf,.mp3,.wav,.zip,application/pdf,audio/mpeg,audio/wav,application/zip';

const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_BASE = new URL('../', import.meta.url);

export function formatContentSize(bytes) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function contentExtension(name) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name ?? '').trim());
  return match ? match[1].toLowerCase() : '';
}

// Tipo pelo nome, só para decidir a interface; o servidor confere a assinatura.
export function contentKindOf(name) {
  const extension = contentExtension(name);
  if (CONTENT_PDF_EXTENSIONS.includes(extension)) return CONTENT_KINDS.pdf;
  if (CONTENT_AUDIO_EXTENSIONS.includes(extension)) return CONTENT_KINDS.audio;
  return CONTENT_KINDS.other;
}

// O que a pasta de entrada aceita: PDF, áudio do curso e ZIP de PDFs.
export function intakeAccepts(name) {
  const extension = contentExtension(name);
  return CONTENT_PDF_EXTENSIONS.includes(extension)
    || CONTENT_AUDIO_EXTENSIONS.includes(extension)
    || CONTENT_ZIP_EXTENSIONS.includes(extension);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function encodeFilenameHeader(name) {
  return encodeURIComponent(String(name));
}

export function decodeFilenameHeader(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes('\u0000') ? null : decoded;
  } catch {
    return null;
  }
}

export function refsShape() {
  return { refs: {} };
}

// Lê o mapa de vínculos devolvido pelo servidor (ou o corpo local, se alguém
// passar o documento inteiro).
export function parseContentRefs(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const refs = value.refs;
  if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) return null;
  const clean = {};
  for (const [key, ref] of Object.entries(refs)) {
    if (typeof key !== 'string' || key === '' || ref === null || typeof ref !== 'object') continue;
    if (typeof ref.sha256 !== 'string' || !SHA256.test(ref.sha256)) continue;
    clean[key] = {
      sha256: ref.sha256,
      size: Number.isFinite(ref.size) ? ref.size : 0,
      kind: ref.kind === CONTENT_KINDS.pdf || ref.kind === CONTENT_KINDS.audio ? ref.kind : CONTENT_KINDS.other,
      name: isText(ref.name) ? ref.name : null,
      addedAt: isText(ref.addedAt) ? ref.addedAt : null,
    };
  }
  return clean;
}

function coursePath(courseId, suffix = '') {
  return `${MATERIALS_PREFIX}/${encodeURIComponent(courseId)}/materials${suffix}`;
}

// Cliente. `fetchImpl` entra por injeção nos testes; em produção usa o `fetch`
// da própria origem (mesma origem = sem CORS e sem cookie entre domínios).
export function createCourseContentClient({
  basePath = DEFAULT_BASE,
  fetchImpl = null,
  timeoutMs = CONTENT_PROBE_TIMEOUT_MS,
  uploadTimeoutMs = CONTENT_UPLOAD_TIMEOUT_MS,
  onChange = null,
  fetchRef = typeof fetch === 'function' ? fetch : null,
  documentRef = null,
  // Explícito para testes: `true`/`false` força a decisão; `null` (padrão) lê o
  // marcador da página.
  serverDeclaredOverride = null,
} = {}) {
  const root = basePath instanceof URL ? basePath : new URL(String(basePath), DEFAULT_BASE);
  const fetcher = fetchImpl ?? fetchRef;
  const doc = documentRef ?? globalThis.document ?? null;
  const markerOverride = serverDeclaredOverride;
  const refsCache = new Map();
  let status = CONTENT_STATUS.unknown;
  let starting = null;
  let destroyed = false;

  function url(path) {
    return new URL(path, root).href;
  }

  // Nunca lança por rede/tempo: devolve null (modo local, sem aviso insistente).
  async function request(path, { method = 'GET', headers = {}, body = null, timeout = timeoutMs } = {}) {
    if (destroyed || typeof fetcher !== 'function') return null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    if (controller && timeout > 0) timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetcher(url(path), {
        method,
        headers,
        body,
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller ? controller.signal : undefined,
      });
      return response ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function json(response) {
    if (!response || typeof response.json !== 'function') return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  // Sondagem: só acontece com o servidor declarado no marcador da página
  // (`data-groove-server="on"`, o MESMO padrão de detecção da sincronização).
  // Página estática (GitHub Pages, servidor comum, HTTP por IP) tem o marcador
  // `off` e NÃO faz nenhuma requisição a `/api` — nem a sonda de saúde.
  function serverDeclared() {
    if (markerOverride !== null) return markerOverride === true;
    return serverMarkerSays(doc) === true;
  }

  async function probe() {
    if (!serverDeclared()) {
      status = CONTENT_STATUS.local;
      starting = Promise.resolve(status);
      return status;
    }
    const response = await request(HEALTH_PATH);
    const body = response?.ok ? await json(response) : null;
    const ready = Boolean(body && body.ok === true && body.service === 'groovegoblin');
    const next = ready ? CONTENT_STATUS.ready : CONTENT_STATUS.local;
    const changed = next !== status;
    status = next;
    if (changed && ready) onChange?.(null);
    return status;
  }

  function start() {
    if (!starting) starting = probe();
    return starting;
  }

  async function report(courseId) {
    if (!isText(courseId) || status !== CONTENT_STATUS.ready) return null;
    const response = await request(coursePath(courseId));
    if (!response || !response.ok) return null;
    const body = await json(response);
    return body && typeof body === 'object' ? body : null;
  }

  // Importa: casa a pasta de entrada com os materiais e grava o que falta. É
  // ESCRITA, então vai por POST (mesma origem, com o Origin/Sec-Fetch-Site do
  // próprio servidor). O relatório volta no corpo.
  async function scan(courseId) {
    if (!isText(courseId) || status !== CONTENT_STATUS.ready) return null;
    const response = await request(coursePath(courseId, '/scan'), { method: 'POST' });
    if (!response) return { ok: false, error: 'network' };
    const body = await json(response);
    if (!response.ok) return { ok: false, error: body?.error ?? `http_${response.status}`, message: body?.message ?? null };
    refsCache.delete(courseId);
    return { ok: true, report: body && typeof body === 'object' ? body : null };
  }

  async function loadRefs(courseId, { refresh = false } = {}) {
    if (!isText(courseId) || status !== CONTENT_STATUS.ready) return null;
    if (!refresh && refsCache.has(courseId)) return refsCache.get(courseId);
    const response = await request(`${DOCS_PREFIX}/${encodeURIComponent(courseId)}`);
    if (!response) return null;
    if (response.status === 404) {
      const empty = refsShape().refs;
      refsCache.set(courseId, empty);
      return empty;
    }
    if (!response.ok) return null;
    const clean = parseContentRefs(await json(response));
    if (!clean) return null;
    refsCache.set(courseId, clean);
    return clean;
  }

  function refFor(courseId, refKey) {
    const cached = refsCache.get(courseId);
    if (!cached || typeof refKey !== 'string') return null;
    return cached[refKey] ?? null;
  }

  function hasRefs(courseId) {
    return refsCache.has(courseId);
  }

  async function refreshRefs(courseId) {
    const fresh = await loadRefs(courseId, { refresh: true });
    onChange?.(courseId);
    return fresh;
  }

  async function upload(courseId, file) {
    if (status !== CONTENT_STATUS.ready) return { ok: false, error: 'local' };
    const name = file?.name;
    if (!isText(name)) return { ok: false, error: 'filename_required' };
    const response = await request(coursePath(courseId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Groove-Filename': encodeFilenameHeader(name) },
      body: file,
      timeout: uploadTimeoutMs,
    });
    if (!response) return { ok: false, error: 'network' };
    const body = await json(response);
    if (!response.ok) return { ok: false, error: body?.error ?? `http_${response.status}`, message: body?.message ?? null };
    refsCache.delete(courseId);
    return { ok: true, ...(body && typeof body === 'object' ? body : {}) };
  }

  // Vários arquivos, um por vez: o servidor recebe um corpo por chamada, e a
  // fila mantém a memória do navegador e do Pi previsíveis.
  async function uploadMany(courseId, files, { onEach = null } = {}) {
    const list = [...(files ?? [])];
    const results = [];
    for (const [index, file] of list.entries()) {
      onEach?.({ index, total: list.length, name: file?.name ?? '' });
      results.push(await upload(courseId, file));
    }
    await refreshRefs(courseId);
    return results;
  }

  async function bind(courseId, { refKey, id }) {
    if (status !== CONTENT_STATUS.ready) return { ok: false, error: 'local' };
    const response = await request(coursePath(courseId, '/bind'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refKey, id }),
    });
    if (!response) return { ok: false, error: 'network' };
    const body = await json(response);
    if (!response.ok) return { ok: false, error: body?.error ?? `http_${response.status}`, message: body?.message ?? null };
    refsCache.delete(courseId);
    return { ok: true, ...(body && typeof body === 'object' ? body : {}) };
  }

  function blobUrl(sha256) {
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;
    return url(`${BLOBS_PREFIX}/${sha256}`);
  }

  function destroy() {
    destroyed = true;
    refsCache.clear();
  }

  return {
    start,
    probe,
    get status() { return status; },
    available: () => status === CONTENT_STATUS.ready,
    report,
    scan,
    loadRefs,
    refFor,
    hasRefs,
    refreshRefs,
    upload,
    uploadMany,
    bind,
    blobUrl,
    materialsUrl: (courseId) => url(coursePath(courseId)),
    healthUrl: () => url(HEALTH_PATH),
    destroy,
  };
}

// ── interface da pasta de entrada na página do curso ────────────────────────

function errorText(result) {
  const code = result?.error;
  if (code === 'local') return 'O servidor não está disponível agora.';
  if (code === 'network') return 'Não foi possível falar com o servidor; tente de novo.';
  if (code === 'six_strings') return 'Este arquivo é de 6 cordas; o app toca baixo de 4 ou 5.';
  if (code === 'unsupported_file') return 'Só PDF, áudio do curso e ZIP de PDFs entram na pasta de entrada.';
  if (code === 'too_large') return 'O arquivo passa do tamanho aceito pelo servidor.';
  if (code === 'filename_required' || code === 'invalid_filename') return 'O nome do arquivo não é aceito.';
  if (code === 'file_missing') return 'O arquivo não está mais na pasta de entrada do servidor.';
  if (code === 'invalid_ref') return 'Escolha um material deste curso.';
  if (code === 'limit_exceeded') return 'A pasta de entrada deste curso passou do limite do servidor.';
  return result?.message ?? 'Não foi possível concluir a operação.';
}

export function mountCourseMaterials(container, host) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para o material do curso.');
  const content = host?.content ?? null;
  const courseId = host?.courseId ?? null;
  const notify = (text, error = false) => host?.notify?.(text, error);

  const root = createEl('section', { className: 'course-content', 'aria-label': 'Material do curso no servidor', dataset: { courseId: courseId ?? '' } });
  container.appendChild(root);
  const view = { report: null, loading: false, error: null, open: false, message: null };
  let busy = false;

  function binding() {
    return content && typeof content.available === 'function' && content.available() && typeof courseId === 'string' && courseId !== '';
  }

  async function load() {
    if (!binding()) return;
    view.loading = true;
    view.error = null;
    render();
    // O relatório é LEITURA; casar a pasta com os materiais e gravar vínculos é
    // ESCRITA e vai por POST, na própria origem (o servidor confere Origin e
    // Sec-Fetch-Site). Sem o POST (servidor antigo, erro), cai no GET somente
    // leitura, que mostra o que já está gravado.
    const applied = await content.scan(courseId);
    const [report] = await Promise.all([applied?.ok ? Promise.resolve(applied.report) : content.report(courseId), content.loadRefs(courseId)]);
    view.loading = false;
    if (!report) { view.error = 'O servidor não respondeu ao pedido de materiais.'; render(); return; }
    view.report = report;
    render();
  }

  async function sendFiles(files) {
    const list = [...(files ?? [])].filter((file) => intakeAccepts(file?.name));
    if (list.length === 0) { notify('Nada para enviar: escolha PDFs, MP3s, WAVs ou ZIPs de PDFs.', true); return; }
    busy = true;
    view.message = null;
    render();
    const results = await content.uploadMany(courseId, list, {
      onEach: ({ index, total, name }) => { view.message = `Enviando ${index + 1} de ${total}: ${name}`; render(); },
    });
    busy = false;
    const failures = results.filter((result) => !result.ok);
    view.message = null;
    await load();
    if (failures.length === 0) notify(`${list.length} arquivo(s) enviados para a pasta de entrada do curso.`);
    else notify(`${list.length - failures.length} de ${list.length} arquivo(s) enviados. ${errorText(failures[0])}`, true);
  }

  async function bindOne(id, refKey) {
    if (!isText(refKey)) { notify('Escolha o material para vincular.', true); return; }
    busy = true;
    render();
    const result = await content.bind(courseId, { refKey, id });
    busy = false;
    await load();
    if (!result.ok) { notify(errorText(result), true); return; }
    notify('Material vinculado.');
  }

  function uploader() {
    const input = createEl('input', {
      id: 'course-intake-file', type: 'file', multiple: true, hidden: true,
      accept: CONTENT_ACCEPT, 'aria-label': 'Arquivos para a pasta de entrada do curso',
    });
    input.addEventListener('change', (event) => {
      const files = [...(event.target.files ?? [])];
      event.target.value = '';
      void sendFiles(files);
    });
    const button = createEl('button', { id: 'course-intake-choose', type: 'button', className: 'primary', text: 'Escolher arquivos' });
    button.disabled = busy;
    button.addEventListener('click', () => input.click());
    const zone = createEl('div', { className: 'course-intake-drop', dataset: { dropzone: 'files' } }, [
      createEl('p', { className: 'course-intake-hint muted', text: 'Arraste PDFs, MP3s, WAVs e ZIPs de PDFs aqui, ou copie os arquivos direto para a pasta entrada/ do curso no servidor.' }),
      button, input,
    ]);
    zone.addEventListener('dragover', (event) => { event.preventDefault?.(); zone.dataset.dragging = 'true'; });
    zone.addEventListener('dragleave', () => { delete zone.dataset.dragging; });
    zone.addEventListener('drop', (event) => {
      event.preventDefault?.();
      delete zone.dataset.dragging;
      const files = [...(event.dataTransfer?.files ?? [])];
      void sendFiles(files);
    });
    return zone;
  }

  function bindControl(entry) {
    const select = createEl('select', { id: `course-intake-bind-${entry.id}`, 'aria-label': `Material para ${entry.name}` });
    select.append(createEl('option', { value: '', text: 'Escolher material…' }));
    for (const material of view.report?.missing ?? []) {
      select.append(createEl('option', { value: material.refKey, text: material.name }));
    }
    const button = createEl('button', { type: 'button', text: 'Vincular' });
    button.disabled = busy;
    button.addEventListener('click', () => void bindOne(entry.id, select.value));
    return [select, button];
  }

  function listItem(text, extra = []) {
    return createEl('li', { className: 'course-content-item' }, [createEl('span', { className: 'course-content-name', text }), ...extra]);
  }

  function reportBody() {
    const box = createEl('div', { className: 'course-content-body' });
    if (view.loading) box.append(createEl('p', { className: 'muted', role: 'status', text: 'Lendo a pasta de entrada do curso…' }));
    if (view.error) box.append(createEl('p', { className: 'courses-error', role: 'alert', text: view.error }));
    if (view.message) box.append(createEl('p', { className: 'muted', role: 'status', text: view.message }));
    const report = view.report;
    if (report) {
      box.append(createEl('p', {
        className: 'course-content-count', role: 'status',
        text: `${report.available} de ${report.total} materiais disponíveis${report.missingBlobs > 0 ? ` · ${report.missingBlobs} arquivo(s) sumiram do servidor` : ''}.`,
      }));
      if (report.files) {
        box.append(createEl('p', {
          className: 'muted',
          text: `Pasta de entrada: ${report.files.scanned} arquivo(s), ${formatContentSize(report.files.bytes)}${report.files.sixStrings > 0 ? ` · ${report.files.sixStrings} ignorado(s) de 6 cordas` : ''}${report.zip?.archives > 0 ? ` · ${report.zip.archives} pacote(s) com ${report.zip.pdfMembers} PDF(s)` : ''}.`,
        }));
      }
      box.append(uploader());
      const missing = report.missing ?? [];
      const unmatched = report.unmatched ?? [];
      box.append(createEl('details', { id: 'course-content-missing', className: 'course-content-group' }, [
        createEl('summary', { text: `Faltando (${missing.length})` }),
        missing.length === 0
          ? createEl('p', { className: 'muted', text: 'Todos os materiais do curso estão no servidor.' })
          : createEl('ul', { className: 'course-content-list' }, missing.map((material) => listItem(material.name))),
      ]));
      box.append(createEl('details', { id: 'course-content-unmatched', className: 'course-content-group' }, [
        createEl('summary', { text: `Não casaram (${unmatched.length})` }),
        unmatched.length === 0
          ? createEl('p', { className: 'muted', text: 'Todo arquivo da pasta de entrada casou com um material do curso.' })
          : createEl('ul', { className: 'course-content-list' }, unmatched.map((entry) => listItem(
            `${entry.name}${entry.insideZip ? ` (dentro de ${entry.insideZip})` : ''}${entry.reason === 'six-strings' ? ' — 6 cordas' : ''}`,
            missing.length > 0 ? bindControl(entry) : [],
          ))),
      ]));
      const refresh = createEl('button', { id: 'course-content-refresh', type: 'button', text: 'Atualizar' });
      refresh.disabled = busy;
      refresh.addEventListener('click', () => void load());
      box.append(refresh);
    }
    return box;
  }

  function render() {
    root.replaceChildren();
    if (!binding()) return;
    const count = view.report ? `${view.report.available} de ${view.report.total} materiais disponíveis` : 'lendo…';
    const details = createEl('details', { id: 'course-content-group', className: 'course-content-group' });
    details.append(createEl('summary', { text: `Material do curso no servidor — ${count}` }));
    if (view.open) {
      details.open = true;
      details.append(reportBody());
    } else {
      details.addEventListener('toggle', () => {
        if (details.open) { view.open = true; void load(); }
        else view.open = false;
      });
    }
    root.append(details);
  }

  const controller = {
    courseId,
    element: root,
    render,
    open() { view.open = true; void load(); },
    async reload() { await load(); },
    destroy() { root.remove(); },
  };
  render();
  void load();
  return controller;
}

// Uma instância por curso, compartilhada entre re-renderizações da página do
// curso: a lista de arquivos não pisca e um envio em andamento não morre quando
// o usuário muda um filtro. Devolve o nó a pendurar na página (ou null sem
// servidor — aí nada de material do servidor aparece, e os anexos manuais
// continuam como sempre).
let shared = null;

export function sharedCourseMaterials(host) {
  const enabled = Boolean(host?.content && typeof host.content.available === 'function' && host.content.available() && isText(host.courseId));
  if (!enabled) {
    shared?.destroy();
    shared = null;
    return null;
  }
  if (shared && shared.courseId === host.courseId) return shared.element;
  shared?.destroy();
  const holder = host.documentRef?.createElement
    ? host.documentRef.createElement('div')
    : globalThis.document.createElement('div');
  shared = mountCourseMaterials(holder, host);
  return shared.element;
}

export function resetSharedCourseMaterials() {
  shared?.destroy();
  shared = null;
}
