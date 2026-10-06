// Saída de arquivos que PODEM carregar conteúdo privado de curso — ou bytes
// crus de recuperação, que não dá para redigir sem perder a recuperação.
//
// Convenção única do app, a mesma do backup agregado da Biblioteca: o nome do
// arquivo ganha a marca PRIVADO e o download só acontece depois de uma
// confirmação NATIVA explícita. Cancelar (ou fechar o diálogo) não gera arquivo
// nenhum e nada é reescrito: os bytes saem intactos.
//
// Este módulo é também a casa do download JSON de baixo nível (createObjectURL
// + <a download>), que antes vivia dentro do main.js — um só lugar para as
// duas convenções de saída usadas pelos hosts de tela.
//
// Textos são fictícios; nada aqui busca a rede.

import { PRIVATE_FILENAME_MARK } from './library-backup.js';

export const PRIVATE_CONFIRM_TITLE = 'Baixar arquivo com conteúdo privado?';
export const PRIVATE_CONFIRM_TEXT = 'Este arquivo pode levar títulos de aula, vínculos, anotações e progresso do curso — ou bytes crus de recuperação que não dá para redigir. Guarde-o só para você: não compartilhe, não envie a serviços públicos e apague-o depois de restaurar.';
export const PRIVATE_CONFIRM_ACCEPT = 'Baixar com conteúdo privado';
export const PRIVATE_CONFIRM_CANCEL = 'Cancelar';

function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.appendChild(child);
  }
  return node;
}

// Marca PRIVADO antes da extensão (a mesma convenção de `backupFileName`).
export function privateFileName(filename) {
  const name = String(filename ?? '');
  if (name.length === 0) return PRIVATE_FILENAME_MARK;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}-${PRIVATE_FILENAME_MARK}`;
  return `${name.slice(0, dot)}-${PRIVATE_FILENAME_MARK}${name.slice(dot)}`;
}

// Download JSON de baixo nível. Não decide nada sobre privacidade: quem chama
// responde pelo conteúdo (o público passa por `course-privacy.js` antes).
export function download(text, filename, { document: doc = globalThis.document } = {}) {
  const view = doc?.defaultView ?? globalThis;
  const url = view.URL.createObjectURL(new view.Blob([text], { type: 'application/json' }));
  const link = el(doc, 'a', { href: url, download: filename });
  const host = doc.body ?? doc.documentElement;
  host.appendChild(link);
  link.click();
  link.remove();
  view.setTimeout(() => view.URL.revokeObjectURL(url), 1000);
  return true;
}

/**
 * Confirmação nativa + nome marcado para um punhado de arquivos privados.
 *
 * - `container` recebe o `<dialog>` (ausente: `document.body`);
 * - `document` é o documento do contêiner (testes passam um DOM duplo);
 * - `download(text, filename)` é o escritor do host (ausente: o download JSON
 *   deste módulo, no mesmo documento);
 * - `notify(text, error)` só é usado para avisar o cancelamento.
 *
 * `download(text, filename)` do controlador pede a confirmação, marca o nome e
 * então escreve; devolve `false` sem escrever nada quando o usuário recusa.
 */
export function mountPrivateDownload(container = null, { document: doc = container?.ownerDocument ?? globalThis.document, download: write = null, notify = null } = {}) {
  if (!doc || typeof doc.createElement !== 'function') throw new TypeError('O download privado precisa de um documento DOM.');
  const dialog = el(doc, 'dialog', {
    className: 'backup-dialog backup-private-dialog',
    'aria-label': PRIVATE_CONFIRM_TITLE,
  });
  const accept = el(doc, 'button', { type: 'button', className: 'primary', text: PRIVATE_CONFIRM_ACCEPT });
  const cancel = el(doc, 'button', { type: 'button', text: PRIVATE_CONFIRM_CANCEL });
  dialog.append(
    el(doc, 'h2', { text: PRIVATE_CONFIRM_TITLE }),
    el(doc, 'p', { text: PRIVATE_CONFIRM_TEXT }),
    el(doc, 'div', { className: 'backup-actions' }, [cancel, accept]),
  );
  const mountPoint = container ?? doc.body ?? doc.documentElement;
  if (mountPoint && typeof mountPoint.appendChild === 'function') mountPoint.appendChild(dialog);

  let pending = null;

  // Abre a confirmação nativa e só resolve quando o usuário decidir. Sem
  // `showModal` (DOM sem suporte) o aviso abre pelo atributo `open`: a decisão
  // continua explícita e o cancelamento continua sem arquivo.
  function request() {
    if (pending) return pending.promise;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pending = { promise, resolve };
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else dialog.setAttribute('open', '');
    return promise;
  }

  function settle(agreed) {
    const current = pending;
    pending = null;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    current?.resolve(agreed === true);
  }

  accept.addEventListener('click', () => settle(true));
  cancel.addEventListener('click', () => settle(false));
  // Esc/fechar o diálogo também é recusa: nenhum arquivo é gerado.
  dialog.addEventListener('cancel', event => { event?.preventDefault?.(); settle(false); });
  dialog.addEventListener('close', () => { if (pending) settle(false); });

  async function downloadPrivate(text, filename) {
    const agreed = await request();
    if (!agreed) {
      notify?.('Download cancelado: nenhum arquivo privado foi gerado.', false);
      return false;
    }
    const writeFile = typeof write === 'function' ? write : (value, name) => download(value, name, { document: doc });
    writeFile(text, privateFileName(filename));
    return true;
  }

  return {
    dialog,
    request,
    download: downloadPrivate,
    filename: privateFileName,
    destroy() {
      settle(false);
      dialog.remove();
    },
  };
}
