// Diálogo nativo de backup da Biblioteca (rodada 5, etapa 7).
//
// Módulo AUTOCONTIDO de interface: monta um `<dialog>` nativo com a exportação
// (incluindo o opt-in de anexos com quantidade e tamanho ANTES de gerar o
// arquivo) e a importação (prévia do que vem e recusa antes de tocar em
// qualquer loja). O pai só monta o módulo e liga os botões existentes da
// Biblioteca — nenhum HTML do app precisa mudar.
//
// Nada aqui busca a rede: o download é um Blob local e a leitura vem do arquivo
// que o usuário escolheu. O `document` sai do contêiner (ownerDocument), nunca
// de um global, para o módulo poder ser montado e testado com um DOM próprio.

import {
  buildBackup, serializeBackup, summarizeBackup, importBackup, describeImportResult,
  backupFileName, backupAttachmentSummary, recognizeBackup, validateBackup, formatByteSize,
} from './library-backup.js';

const ATTACHMENT_HINT = 'Incluir anexos';

function el(document, tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'checked' || key === 'disabled' || key === 'hidden') node[key] = true;
    else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node) {
  if (typeof node.replaceChildren === 'function') node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
}

function defaultDownload(document, text, filename) {
  const view = document.defaultView ?? globalThis;
  if (typeof view.URL?.createObjectURL !== 'function' || typeof view.Blob !== 'function') return false;
  const url = view.URL.createObjectURL(new view.Blob([text], { type: 'application/json' }));
  const link = el(document, 'a', { href: url, download: filename, rel: 'noopener' });
  const host = document.body ?? document.documentElement;
  if (host && typeof host.appendChild === 'function') host.appendChild(link);
  if (typeof link.click === 'function') link.click();
  if (typeof link.remove === 'function') link.remove();
  else if (host && typeof host.removeChild === 'function') host.removeChild(link);
  if (typeof view.setTimeout === 'function') view.setTimeout(() => view.URL.revokeObjectURL(url), 0);
  return true;
}

function exerciseSummary(library) {
  let entries = 0;
  let records = 0;
  try {
    const exported = JSON.parse(library.exportLibrary());
    entries = Array.isArray(exported.entries) ? exported.entries.length : 0;
    for (const entry of exported.entries ?? []) records += entry?.metadata?.records?.length ?? 0;
  } catch { /* a prévia não pode derrubar o diálogo */ }
  return { entries, records };
}

// Monta o diálogo. Devolve os métodos que o pai liga aos botões da Biblioteca.
export function mountLibraryBackup(container, host = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para o backup da biblioteca.');
  const document = container.ownerDocument ?? globalThis.document;
  if (!document || typeof document.createElement !== 'function') throw new TypeError('O contêiner precisa de um documento DOM.');
  const library = host.library;
  if (!library || typeof library.exportLibrary !== 'function' || typeof library.importEntries !== 'function') {
    throw new TypeError('Biblioteca de exercícios ausente para o backup.');
  }
  const store = host.store ?? null;
  const attachments = host.attachments ?? null;
  const shapes = host.shapes ?? null;
  const now = host.now ?? (() => new Date().toISOString());
  const notify = (text, error = false) => host.notify?.(text, error);
  let destroyed = false;

  const dialog = el(document, 'dialog', { id: 'library-backup-dialog', className: 'backup-dialog', 'aria-label': 'Backup da biblioteca' });
  const title = el(document, 'h2', { id: 'library-backup-title', text: 'Backup da biblioteca' });
  const body = el(document, 'div', { id: 'library-backup-body', className: 'backup-body' });
  const status = el(document, 'p', { id: 'library-backup-status', className: 'backup-status', role: 'status', hidden: true });
  dialog.append(title, body, status);

  // ---------------------------------------------------------------- exportação
  const exportSummary = el(document, 'p', { id: 'backup-export-summary', className: 'backup-summary' });
  const attachmentCheckbox = el(document, 'input', { id: 'backup-include-attachments', type: 'checkbox' });
  const attachmentSize = el(document, 'span', { id: 'backup-attachments-size', className: 'backup-attachments-size' });
  const attachmentField = el(document, 'label', { id: 'backup-attachments-field', className: 'backup-field' }, [
    attachmentCheckbox, el(document, 'span', { text: ATTACHMENT_HINT }), attachmentSize,
  ]);
  const exportConfirm = el(document, 'button', { id: 'backup-export-confirm', type: 'button', className: 'primary', text: 'Exportar arquivo' });
  const exportCancel = el(document, 'button', { id: 'backup-export-cancel', type: 'button', text: 'Cancelar' });
  const exportActions = el(document, 'div', { className: 'backup-actions' }, [exportCancel, exportConfirm]);

  // ------------------------------------------------------------------ importação
  const importFile = el(document, 'input', { id: 'backup-import-file', type: 'file', accept: '.json,application/json' });
  const importSummary = el(document, 'div', { id: 'backup-import-preview', className: 'backup-summary' });
  const importErrors = el(document, 'ul', { id: 'backup-import-errors', className: 'backup-errors' });
  const importConfirm = el(document, 'button', { id: 'backup-import-confirm', type: 'button', className: 'primary', text: 'Importar', disabled: true });
  const importCancel = el(document, 'button', { id: 'backup-import-cancel', type: 'button', text: 'Cancelar' });
  const importActions = el(document, 'div', { className: 'backup-actions' }, [importCancel, importConfirm]);

  let mode = 'export';
  let pending = null;   // { text, document, legacy }

  function setStatus(text, error = false, visible = true) {
    status.textContent = text ?? '';
    status.hidden = !visible || !text;
    if (error) status.setAttribute('data-error', 'true');
    else status.removeAttribute('data-error');
  }

  function attachmentTotalsLabel() {
    if (!attachments || typeof attachments.totals !== 'function') return 'Anexos indisponíveis neste navegador.';
    const totals = attachments.totals();
    return backupAttachmentSummary(totals).label;
  }

  function exportPayload() {
    return { includeAttachments: attachmentCheckbox.checked === true };
  }

  // Motivo pelo qual a exportação agregada NÃO pode ser honesta agora: loja
  // lida como vazia seria um arquivo incompleto com cara de completo.
  function exportBlockReason() {
    const status = typeof library.status === 'string' ? library.status : null;
    if (status !== null && status !== 'ready') {
      return status === 'corrupt'
        ? 'A biblioteca de exercícios está corrompida: baixe os originais em Ajuda antes de exportar.'
        : 'A biblioteca de exercícios está indisponível neste navegador; exporte o documento atual pela Ajuda.';
    }
    if (store && store.persistent === false) {
      return `Os cursos guardados não podem ser lidos agora${store.error ? ` (${store.error})` : ''}; exporte em um navegador com IndexedDB.`;
    }
    if (attachments && attachments.persistent === false) {
      return `Os anexos guardados não podem ser lidos agora${attachments.error ? ` (${attachments.error})` : ''}; exporte em um navegador com IndexedDB.`;
    }
    if (shapes && shapes.status === 'unavailable') {
      return `As formas de dedilhado guardadas não podem ser lidas agora${shapes.warning ? ` (${shapes.warning})` : ''}; exporte em um navegador com armazenamento disponível.`;
    }
    return null;
  }

  function renderExport() {
    mode = 'export';
    title.textContent = 'Exportar biblioteca';
    clear(body);
    const summary = exerciseSummary(library);
    const courses = store && typeof store.snapshotAll === 'function' ? store.snapshotAll() : null;
    const shapeCount = shapes && typeof shapes.exportDocument === 'function'
      ? Object.values(shapes.exportDocument().instruments ?? {}).reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0)
      : null;
    exportSummary.textContent = `${summary.entries} exercício(s), ${summary.records} treino(s) registrado(s)`
      + (courses ? `; ${courses.records.length} curso(s) e ${courses.states.length} estado(s) de progresso (${courses.orphans.length} órfão(s))` : '')
      + (shapeCount === null ? '' : `; ${shapeCount} forma(s) de dedilhado`);
    const blocked = exportBlockReason();
    exportConfirm.disabled = blocked !== null;
    if (blocked) {
      exportSummary.textContent = blocked;
    }
    const totals = attachments && typeof attachments.totals === 'function' ? attachments.totals() : null;
    attachmentField.hidden = false;
    attachmentCheckbox.checked = false;   // padrão: sem anexos
    if (!totals || totals.files === 0) {
      attachmentCheckbox.disabled = true;
      attachmentSize.textContent = totals ? 'Nenhum anexo guardado.' : attachmentTotalsLabel();
    } else {
      attachmentCheckbox.disabled = false;
      attachmentSize.textContent = `Inclui ${totals.files} arquivo(s) no backup (${formatByteSize(totals.bytes)}).`;
    }
    body.append(exportSummary, attachmentField, exportActions);
  }

  function summarizeDocument(document_) {
    const summary = summarizeBackup(document_);
    const parts = [`${summary.exercises} exercício(s)`];
    if (summary.coursesAvailable === false) parts.push('cursos não conferidos (backup gerado sem a loja de cursos)');
    else parts.push(`${summary.courses} curso(s)`, `${summary.states} estado(s) de progresso`);
    if (summary.orphans > 0) parts.push(`${summary.orphans} estado(s) órfão(s)`);
    if (summary.shapesAvailable === false) parts.push('formas de dedilhado não conferidas');
    else parts.push(`${summary.shapes} forma(s) de dedilhado`);
    if (summary.shapesCorrupt) parts.push('formas de dedilhado ilegíveis (bytes só no arquivo)');
    if (summary.attachments.included) parts.push(`anexos: ${summary.attachments.label}`);
    else if (summary.attachments.files > 0) parts.push(`sem anexos (o backup citava ${summary.attachments.label})`);
    else if (summary.attachments.available === false) parts.push('anexos não conferidos');
    return `${parts.join('; ')}.`;
  }

  function renderImport() {
    mode = 'import';
    title.textContent = 'Importar backup';
    clear(body);
    importFile.value = '';
    clear(importSummary);
    clear(importErrors);
    importConfirm.disabled = true;
    pending = null;
    importSummary.appendChild(el(document, 'p', { text: 'Escolha um arquivo de backup do GrooveGoblin (novo ou antigo). Nada é gravado antes da conferência completa.' }));
    importErrors.hidden = true;
    body.append(importFile, importSummary, importErrors, importActions);
  }

  function showImportErrors(errors) {
    clear(importErrors);
    const list = (errors ?? []).slice(0, 20);
    if (list.length === 0) { importErrors.hidden = true; return; }
    for (const error of list) {
      importErrors.appendChild(el(document, 'li', { text: error.message ?? String(error) }));
    }
    importErrors.hidden = false;
  }

  function review(text) {
    let document_;
    try { document_ = JSON.parse(text); }
    catch {
      pending = null;
      importConfirm.disabled = true;
      clear(importSummary);
      showImportErrors([{ message: 'Não foi possível ler o arquivo: o JSON é inválido.' }]);
      setStatus('Importação rejeitada: o arquivo não é um JSON válido.', true);
      return { ok: false, kind: 'invalid' };
    }
    const recognized = recognizeBackup(document_);
    if (recognized.kind === 'invalid') {
      pending = null;
      importConfirm.disabled = true;
      clear(importSummary);
      showImportErrors(recognized.errors);
      setStatus('Importação rejeitada.', true);
      return { ok: false, kind: 'invalid' };
    }
    if (recognized.kind !== 'aggregate') {
      // Caminho antigo: só exercícios, contrato de importação de sempre.
      pending = { text, legacy: recognized.kind };
      importConfirm.disabled = false;
      clear(importSummary);
      importSummary.appendChild(el(document, 'p', { text: 'Backup antigo: os exercícios entram pelo caminho de importação de sempre (sem cursos e sem anexos).' }));
      showImportErrors([]);
      setStatus(null);
      return { ok: true, kind: recognized.kind };
    }
    const validated = validateBackup(document_);
    if (!validated.ok) {
      pending = null;
      importConfirm.disabled = true;
      clear(importSummary);
      importSummary.appendChild(el(document, 'p', { text: 'O arquivo não passou na validação; nada será gravado.' }));
      showImportErrors(validated.errors);
      setStatus('Importação rejeitada antes de gravar.', true);
      return { ok: false, kind: 'aggregate' };
    }
    pending = { text, legacy: null };
    importConfirm.disabled = false;
    clear(importSummary);
    importSummary.appendChild(el(document, 'p', { text: summarizeDocument(document_) }));
    showImportErrors([]);
    setStatus(null);
    return { ok: true, kind: 'aggregate' };
  }

  async function exportLibrary(options = {}) {
    const includeAttachments = options.includeAttachments ?? exportPayload().includeAttachments;
    try {
      const built = await buildBackup({ library, store, attachments, includeAttachments, now, shapes });
      if (built?.ok !== true) {
        // Recusa honesta (biblioteca corrompida/indisponível, loja não
        // persistente): nenhum arquivo é gerado e o motivo fica visível.
        setStatus(`Exportação não concluída: ${built?.error ?? 'loja indisponível'}.`, true);
        notify?.(`Exportação não concluída: ${built?.error ?? 'loja indisponível'}`, true);
        return { ok: false, code: built?.code ?? 'unavailable', store: built?.store ?? null, message: built?.error ?? 'loja indisponível' };
      }
      const text = serializeBackup(built.document);
      const filename = options.filename ?? backupFileName(now);
      const ok = host.download ? (host.download(text, filename), true) : defaultDownload(document, text, filename);
      if (!ok) {
        setStatus('Não foi possível iniciar o download neste navegador; exporte novamente.', true);
        return { ok: false, code: 'download', summary: built.summary };
      }
      const label = includeAttachments ? 'com anexos' : 'sem anexos';
      const coursesLabel = built.summary.coursesAvailable === false
        ? 'sem a loja de cursos'
        : `${built.summary.courses} curso(s)`;
      setStatus(`Backup gerado ${label}: ${built.summary.exercises} exercício(s), ${coursesLabel}.`);
      return { ok: true, filename, text, summary: built.summary };
    } catch (error) {
      setStatus(`Exportação não concluída: ${error?.message ?? error}`, true);
      return { ok: false, code: error?.code ?? 'export', message: error?.message ?? String(error) };
    }
  }

  async function importText(text) {
    const result = await importBackup(text, { library, store, attachments, now, shapes });
    const message = describeImportResult(result);
    setStatus(message, !result.ok);
    notify(message, !result.ok);
    return result;
  }

  function open() {
    setStatus(null);
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else dialog.setAttribute('open', '');
  }

  function close() {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function openExport() {
    renderExport();
    open();
    // As lojas carregam o banco de forma preguiçosa: quando ficarem prontas, a
    // prévia é redesenhada (o arquivo em si sempre espera o `ready`).
    const pendingReady = [store, attachments]
      .filter(candidate => candidate && typeof candidate.ready === 'function')
      .map(candidate => candidate.ready().catch(() => {}));
    if (pendingReady.length > 0) {
      Promise.all(pendingReady).then(() => { if (!destroyed && mode === 'export') renderExport(); });
    }
    return api;
  }
  function openImport() { renderImport(); open(); return api; }

  exportConfirm.addEventListener('click', () => { if (!destroyed) exportLibrary().catch(() => {}); });
  exportCancel.addEventListener('click', close);
  attachmentCheckbox.addEventListener('change', () => { setStatus(null); });
  importConfirm.addEventListener('click', () => {
    if (destroyed || !pending) return;
    const text = pending.text;
    importConfirm.disabled = true;
    importText(text).then(result => {
      if (result.ok) renderImport();
      else importConfirm.disabled = false;
    }).catch(() => { importConfirm.disabled = false; });
  });
  importCancel.addEventListener('click', close);
  importFile.addEventListener('change', event => {
    const file = event?.target?.files?.[0] ?? null;
    if (!file) return;
    if (typeof file.text === 'function') {
      Promise.resolve(file.text()).then(text => review(text)).catch(() => setStatus('Não foi possível ler o arquivo escolhido.', true));
    } else setStatus('Não foi possível ler o arquivo escolhido.', true);
  });

  const rootHost = document.body ?? container;
  rootHost.appendChild(dialog);

  const api = {
    dialog, title, status,
    openExport, openImport, close,
    exportLibrary, importText, review,
    get mode() { return mode; },
    get pending() { return pending ? { legacy: pending.legacy } : null; },
    render() { if (mode === 'export') renderExport(); else renderImport(); return api; },
    destroy() {
      destroyed = true;
      if (typeof dialog.remove === 'function') dialog.remove();
      else if (typeof dialog.parentNode?.removeChild === 'function') dialog.parentNode.removeChild(dialog);
    },
  };
  return api;
}
