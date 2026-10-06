// Painel do material do curso, embutido na própria origem (rodada 6, etapa 8 / B4b).
//
// Um único painel lateral para o app inteiro: a apostila abre num <iframe> da
// MESMA origem (a resposta do blob é `inline` com CSP de PDF e
// `frame-ancestors 'self'`), já na página pedida (`#page=N`); a faixa toca num
// player nativo com `Range`; o que não é PDF nem áudio só baixa. Nada de vídeo:
// a aula continua apontando para o site do curso.
//
// O painel nunca inventa URL: quem sabe o endereço do blob é o cliente do
// conteúdo (`course-content.js`), e o sha256 é conferido antes de virar `src`.
// Sem servidor, o painel nunca abre e nem aparece.

import { createEl } from './practice.js';
import { CONTENT_KINDS, formatContentSize } from './course-content.js';

export const MATERIAL_PANEL_LABEL = 'Painel do material';

const SHA256 = /^[0-9a-f]{64}$/;

export function materialRefLabel(ref, fallback = 'Material') {
  return typeof ref?.name === 'string' && ref.name.trim() !== '' ? ref.name : fallback;
}

export function materialRefKind(ref) {
  if (ref?.kind === CONTENT_KINDS.pdf || ref?.kind === CONTENT_KINDS.audio) return ref.kind;
  return CONTENT_KINDS.other;
}

// Endereço do material, sempre derivado do sha conferido — nunca de texto solto.
export function materialPanelUrl(content, sha256) {
  if (!content || typeof content.blobUrl !== 'function' || typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;
  const url = content.blobUrl(sha256);
  return typeof url === 'string' && url !== '' ? url : null;
}

export function mountMaterialPanel(container, { content = null, notify = null, documentRef = null } = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para o painel do material.');
  const root = createEl('aside', {
    id: 'material-panel',
    className: 'material-panel',
    hidden: true,
    'aria-label': MATERIAL_PANEL_LABEL,
  });
  container.appendChild(root);
  let bound = content;
  let current = null;
  let opener = null;

  function closeNodes() {
    // Áudio para de tocar quando o painel fecha ou troca de faixa.
    const audio = root.querySelector?.('audio');
    if (audio && typeof audio.pause === 'function') audio.pause();
    const frame = root.querySelector?.('iframe');
    if (frame && 'src' in frame) frame.src = '';
  }

  function bodyNode(target, url) {
    const kind = materialRefKind(target);
    if (kind === CONTENT_KINDS.pdf) {
      const frame = createEl('iframe', {
        id: 'material-panel-frame',
        className: 'material-panel-frame',
        title: `Apostila: ${materialRefLabel(target)}`,
        referrerpolicy: 'no-referrer',
        loading: 'eager',
      });
      frame.src = target.page ? `${url}#page=${Number(target.page)}` : url;
      return createEl('div', { className: 'material-panel-frame-wrap' }, [
        frame,
        createEl('p', { className: 'material-panel-note muted', text: target.page ? `Abrindo na página ${Number(target.page)} do material, direto do servidor.` : 'Abrindo o material direto do servidor.' }),
      ]);
    }
    if (kind === CONTENT_KINDS.audio) {
      const audio = createEl('audio', {
        id: 'material-panel-audio',
        className: 'material-panel-audio',
        controls: true,
        loop: true,
        preload: 'metadata',
        'aria-label': `Ouvir ${materialRefLabel(target)} em repetição`,
      });
      audio.src = url;
      return createEl('div', { className: 'material-panel-audio-wrap' }, [
        audio,
        createEl('p', { className: 'material-panel-note muted', text: 'A faixa toca do servidor, em repetição, direto do arquivo do curso.' }),
      ]);
    }
    return createEl('p', { className: 'material-panel-note muted' }, [
      createEl('a', { className: 'material-panel-download', href: url, download: materialRefLabel(target), rel: 'noopener noreferrer', text: 'Baixar arquivo do servidor' }),
    ]);
  }

  function render() {
    root.replaceChildren();
    if (!current) return;
    const url = materialPanelUrl(bound, current.sha256);
    if (url === null) { current = null; root.hidden = true; return; }
    const title = createEl('h2', { className: 'material-panel-title', text: materialRefLabel(current) });
    const bits = [];
    if (current.kind) bits.push(current.kind === CONTENT_KINDS.pdf ? 'apostila' : current.kind === CONTENT_KINDS.audio ? 'faixa' : 'arquivo');
    if (Number.isFinite(current.size) && current.size > 0) bits.push(formatContentSize(current.size));
    if (current.page) bits.push(`página ${Number(current.page)}`);
    const close = createEl('button', { id: 'material-panel-close', type: 'button', text: 'Fechar painel' });
    close.addEventListener('click', () => controller.close());
    root.append(
      createEl('header', { className: 'material-panel-head' }, [
        createEl('div', { className: 'material-panel-heading' }, [title, createEl('p', { className: 'material-panel-meta muted', text: bits.join(' · ') })]),
        close,
      ]),
      bodyNode(current, url),
    );
    close.focus?.({ preventScroll: true });
  }

  function open(target) {
    if (!target || typeof target.sha256 !== 'string' || materialPanelUrl(bound, target.sha256) === null) return false;
    if (current && current.sha256 === target.sha256 && current.page === (target.page ?? null)) { root.hidden = false; return true; }
    closeNodes();
    const active = documentRef?.activeElement ?? globalThis.document?.activeElement ?? null;
    if (active && typeof active.focus === 'function' && !root.contains?.(active)) opener = active;
    current = {
      sha256: target.sha256,
      kind: materialRefKind(target),
      name: typeof target.name === 'string' ? target.name : null,
      size: Number.isFinite(target.size) ? target.size : null,
      page: Number.isInteger(target.page) && target.page > 0 ? target.page : null,
      refKey: typeof target.refKey === 'string' ? target.refKey : null,
    };
    root.hidden = false;
    render();
    return true;
  }

  function close({ restoreFocus = true } = {}) {
    if (root.hidden && current === null) return false;
    closeNodes();
    current = null;
    root.replaceChildren();
    root.hidden = true;
    if (restoreFocus && opener && typeof opener.focus === 'function' && opener.isConnected !== false) opener.focus({ preventScroll: true });
    opener = null;
    return true;
  }

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault?.(); close(); }
  });

  const controller = {
    element: root,
    open,
    close,
    render,
    get current() { return current ? { ...current } : null; },
    get isOpen() { return !root.hidden; },
    get content() { return bound; },
    set content(value) { bound = value ?? null; },
    destroy() {
      closeNodes();
      current = null;
      root.remove();
    },
  };
  void notify;
  return controller;
}

// ── nós que as páginas da aula/exercício usam ───────────────────────────────

function fallbackName(ref, name) {
  return typeof name === 'string' && name.trim() !== '' ? name : materialRefLabel(ref);
}

// Ações do material do servidor para uma linha de material da aula. Devolve
// lista vazia quando não há cópia no servidor (aí vale o anexo local de hoje).
export function serverMaterialNodes({ panel, ref, index = 0, name = null, page = null } = {}) {
  if (!panel || !ref || typeof ref.sha256 !== 'string') return [];
  const kind = materialRefKind(ref);
  const label = fallbackName(ref, name);
  if (kind === CONTENT_KINDS.pdf) {
    const button = createEl('button', {
      id: `lesson-material-panel-${index}`, type: 'button', className: 'primary',
      dataset: { action: 'open-apostila', refKey: ref.refKey ?? '' },
      text: page ? `Abrir na apostila (página ${Number(page)})` : 'Abrir na apostila',
    });
    button.addEventListener('click', () => panel.open({ sha256: ref.sha256, kind, name: label, size: ref.size, page }));
    return [button];
  }
  if (kind === CONTENT_KINDS.audio) {
    const url = materialPanelUrl(panel.content, ref.sha256);
    if (url === null) return [];
    const audio = createEl('audio', {
      className: 'lesson-audio material-panel-audio',
      controls: true,
      loop: true,
      preload: 'metadata',
      dataset: { action: 'play-track', refKey: ref.refKey ?? '' },
      'aria-label': `Ouvir ${label} em repetição, do servidor`,
    });
    audio.src = url;
    return [audio, createEl('span', { className: 'lesson-audio-note muted', text: 'toca em repetição, direto do servidor (com Range)' })];
  }
  return [];
}

// "Ver na apostila": o mesmo painel, aberto da página do exercício gerado.
export function apostilaButtonNode({ panel, ref, index = 0, page = null, label = 'Ver na apostila' } = {}) {
  if (!panel || !ref || typeof ref.sha256 !== 'string' || materialRefKind(ref) !== CONTENT_KINDS.pdf) return null;
  const button = createEl('button', {
    id: `apostila-${index}`, type: 'button',
    dataset: { action: 'open-apostila', refKey: ref.refKey ?? '' },
    text: label,
  });
  button.addEventListener('click', () => panel.open({ sha256: ref.sha256, kind: CONTENT_KINDS.pdf, name: materialRefLabel(ref), size: ref.size, page }));
  return button;
}

// ── instância única do app ──────────────────────────────────────────────────
// Montada na primeira abertura, no body: a mesma página da apostila serve a
// aula e o exercício gerado, sem cada tela montar o seu painel.
let shared = null;

export function sharedMaterialPanel({ content = null, container = null, documentRef = null, notify = null } = {}) {
  if (shared) {
    if (content && !shared.content) shared.content = content;
    return shared;
  }
  const body = container ?? globalThis.document?.body ?? null;
  if (!body) return null;
  shared = mountMaterialPanel(body, { content, documentRef: documentRef ?? globalThis.document ?? null, notify });
  return shared;
}

export function resetSharedMaterialPanel() {
  shared?.destroy();
  shared = null;
}
