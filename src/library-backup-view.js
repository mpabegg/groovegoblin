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
//
// O host injeta as lojas: `library`, `store` (cursos), `attachments`, `shapes`
// (formas A3) e `bindings` (vínculos rótulo→forma do catálogo A5). Loja ausente
// vira "não conferido"/recusa honesta, nunca um arquivo com cara de completo.

import {
  buildBackup, serializeBackup, summarizeBackup, importBackup, describeImportResult,
  backupFileName, backupAttachmentSummary, recognizeBackup, validateBackup, formatByteSize,
  PRIVATE_CONTENT_LABEL,
} from './library-backup.js';

const ATTACHMENT_HINT = 'Incluir anexos';
const PRIVATE_HINT = 'Leva cursos, aulas, vínculos, anotações, progresso e anexos: não compartilhe nem envie a serviços públicos.';
const PRIVATE_CONFIRM_TEXT = 'Este arquivo vai levar o conteúdo pago dos seus cursos: catálogo, títulos de aula, vínculos, anotações, progresso, anexos e bytes de registros ilegíveis. Guarde-o só para você: não compartilhe, não envie a serviços públicos e apague-o depois de restaurar.';

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
  const bindings = host.bindings ?? null;
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
  // Opt-in EXPLÍCITO de conteúdo de curso (B6): desmarcado por padrão, como a
  // opção sem cursos sempre foi. Os anexos só ficam disponíveis sob ele.
  const privateCheckbox = el(document, 'input', { id: 'backup-include-course-content', type: 'checkbox' });
  const privateField = el(document, 'label', { id: 'backup-private-field', className: 'backup-field' }, [
    privateCheckbox,
    el(document, 'span', { text: PRIVATE_CONTENT_LABEL }),
    el(document, 'span', { id: 'backup-private-hint', className: 'backup-private-hint', text: PRIVATE_HINT }),
  ]);
  const exportConfirm = el(document, 'button', { id: 'backup-export-confirm', type: 'button', className: 'primary', text: 'Exportar arquivo' });
  const exportCancel = el(document, 'button', { id: 'backup-export-cancel', type: 'button', text: 'Cancelar' });
  const exportActions = el(document, 'div', { className: 'backup-actions' }, [exportCancel, exportConfirm]);

  // Confirmação NATIVA (um `<dialog>` do próprio documento) antes de qualquer
  // download privado: sem "OK" explícito, nenhum arquivo é gerado.
  const privateDialog = el(document, 'dialog', {
    id: 'backup-private-dialog', className: 'backup-dialog backup-private-dialog',
    'aria-labelledby': 'backup-private-dialog-title', 'aria-describedby': 'backup-private-dialog-body',
  });
  const privateDialogTitle = el(document, 'h2', { id: 'backup-private-dialog-title', text: 'Baixar backup com conteúdo privado?' });
  const privateDialogBody = el(document, 'p', { id: 'backup-private-dialog-body', text: PRIVATE_CONFIRM_TEXT });
  const privateDialogConfirm = el(document, 'button', { id: 'backup-private-confirm', type: 'button', className: 'primary', text: 'Baixar com conteúdo privado' });
  const privateDialogCancel = el(document, 'button', { id: 'backup-private-cancel', type: 'button', text: 'Cancelar' });
  privateDialog.append(
    privateDialogTitle, privateDialogBody,
    el(document, 'div', { className: 'backup-actions' }, [privateDialogCancel, privateDialogConfirm]),
  );

  // ------------------------------------------------------------------ importação
  const importFile = el(document, 'input', { id: 'backup-import-file', type: 'file', accept: '.json,application/json' });
  const importSummary = el(document, 'div', { id: 'backup-import-preview', className: 'backup-summary' });
  const importErrors = el(document, 'ul', { id: 'backup-import-errors', className: 'backup-errors' });
  const importConfirm = el(document, 'button', { id: 'backup-import-confirm', type: 'button', className: 'primary', text: 'Importar', disabled: true });
  const importCancel = el(document, 'button', { id: 'backup-import-cancel', type: 'button', text: 'Cancelar' });
  const importActions = el(document, 'div', { className: 'backup-actions' }, [importCancel, importConfirm]);

  let mode = 'export';
  let pending = null;   // { text, document, legacy }
  let pendingPrivateConfirm = null;   // resolve da confirmação privada em curso

  // Abre a confirmação nativa e só resolve quando o usuário decidir. Cancelar
  // (ou fechar) resolve `false`: nenhum arquivo é gerado.
  function requestPrivateConfirmation() {
    if (pendingPrivateConfirm) return pendingPrivateConfirm.promise;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pendingPrivateConfirm = { promise, resolve };
    if (typeof privateDialog.showModal === 'function') {
      if (!privateDialog.open) privateDialog.showModal();
    } else privateDialog.setAttribute('open', '');
    return promise;
  }

  function settlePrivateConfirmation(agreed) {
    const current = pendingPrivateConfirm;
    pendingPrivateConfirm = null;
    if (typeof privateDialog.close === 'function') privateDialog.close();
    else privateDialog.removeAttribute('open');
    current?.resolve(agreed === true);
  }

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
    return {
      includeAttachments: attachmentCheckbox.checked === true,
      includeCourseContent: privateCheckbox.checked === true,
    };
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
    if (bindings && bindings.status === 'unavailable') {
      return `Os vínculos de forma do catálogo não podem ser lidos agora${bindings.error ? ` (${bindings.error})` : ''}; exporte em um navegador com armazenamento disponível.`;
    }
    return null;
  }

  function renderExportSummary() {
    const summary = exerciseSummary(library);
    const courses = store && typeof store.snapshotAll === 'function' ? store.snapshotAll() : null;
    const shapeCount = shapes && typeof shapes.exportDocument === 'function'
      ? Object.values(shapes.exportDocument().instruments ?? {}).reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0)
      : null;
    const privateOn = privateCheckbox.checked === true;
    const bindingCount = privateOn && bindings && typeof bindings.list === 'function' ? bindings.list().length : null;
    exportSummary.textContent = `${summary.entries} exercício(s), ${summary.records} treino(s) registrado(s)`
      + (courses ? `; ${courses.records.length} curso(s) e ${courses.states.length} estado(s) de progresso (${courses.orphans.length} órfão(s))` : '')
      + (shapeCount === null ? '' : `; ${shapeCount} forma(s) de dedilhado`)
      + (bindingCount === null ? '' : `; ${bindingCount} vínculo(s) de forma do catálogo`)
      + (privateOn ? ' — o arquivo leva o conteúdo privado dos cursos.' : ' — o arquivo sai sem conteúdo de curso.');
  }

  function renderExport() {
    mode = 'export';
    title.textContent = 'Exportar biblioteca';
    clear(body);
    // Padrão: backup público — sem conteúdo de curso e sem anexos.
    privateCheckbox.checked = false;
    attachmentCheckbox.checked = false;
    renderExportSummary();
    const blocked = exportBlockReason();
    exportConfirm.disabled = blocked !== null;
    if (blocked) {
      exportSummary.textContent = blocked;
    }
    const totals = attachments && typeof attachments.totals === 'function' ? attachments.totals() : null;
    attachmentField.hidden = false;
    renderAttachmentAvailability(totals);
    privateCheckbox.disabled = blocked !== null;
    body.append(exportSummary, privateField, attachmentField, exportActions);
  }

  // Anexos são conteúdo de curso: só ficam selecionáveis sob o opt-in privado.
  function renderAttachmentAvailability(totals) {
    const privateOn = privateCheckbox.checked === true;
    attachmentCheckbox.disabled = !privateOn || !totals || totals.files === 0;
    if (!privateOn) {
      attachmentCheckbox.checked = false;
      attachmentSize.textContent = 'Só com conteúdo privado de cursos.';
      return;
    }
    if (!totals || totals.files === 0) {
      attachmentSize.textContent = totals ? 'Nenhum anexo guardado.' : attachmentTotalsLabel();
    } else {
      attachmentSize.textContent = `Inclui ${totals.files} arquivo(s) no backup (${formatByteSize(totals.bytes)}).`;
    }
  }

  function summarizeDocument(document_) {
    const summary = summarizeBackup(document_);
    const parts = [`${summary.exercises} exercício(s)`];
    if (summary.coursesOmitted) parts.push('conteúdo de curso omitido (backup público)');
    else if (summary.coursesAvailable === false) parts.push('cursos não conferidos (backup gerado sem a loja de cursos)');
    else parts.push(`${summary.courses} curso(s)`, `${summary.states} estado(s) de progresso`);
    if (summary.orphans > 0) parts.push(`${summary.orphans} estado(s) órfão(s)`);
    if (summary.shapesAvailable === false) parts.push('formas de dedilhado não conferidas');
    else parts.push(`${summary.shapes} forma(s) de dedilhado`);
    if (summary.shapesCorrupt) parts.push('formas de dedilhado ilegíveis (bytes só no arquivo)');
    if (summary.bindingsOmitted) parts.push('vínculos de forma do catálogo omitidos (backup público)');
    else if (summary.bindingsAvailable) parts.push(`${summary.bindings} vínculo(s) de forma do catálogo`);
    else parts.push('vínculos de forma do catálogo não conferidos');
    if (summary.bindingsCorrupt) parts.push('vínculos de forma ilegíveis na origem (nada sobrescrito)');
    if (summary.attachments.included) parts.push(`anexos: ${summary.attachments.label}`);
    else if (summary.attachments.files > 0) parts.push(`sem anexos (o backup citava ${summary.attachments.label})`);
    else if (summary.attachmentsOmitted) parts.push('anexos omitidos (backup público)');
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
    const payload = exportPayload();
    const includeCourseContent = options.includeCourseContent ?? payload.includeCourseContent;
    const includeAttachments = options.includeAttachments ?? payload.includeAttachments;
    // Opt-in privado SEM confirmação explícita não baixa nada: a confirmação
    // nativa vem primeiro e o cancelamento encerra sem gerar arquivo.
    if (includeCourseContent && options.confirmed !== true) {
      const agreed = await requestPrivateConfirmation();
      if (!agreed) {
        setStatus('Exportação cancelada: nenhum arquivo com conteúdo privado foi gerado.', false);
        return { ok: false, code: 'cancelled', message: 'confirmação recusada' };
      }
    }
    try {
      const built = await buildBackup({ library, store, attachments, includeAttachments, includeCourseContent, now, shapes, bindings });
      if (built?.ok !== true) {
        // Recusa honesta (biblioteca corrompida/indisponível, loja não
        // persistente, anexos sem o opt-in privado): nenhum arquivo é gerado e
        // o motivo fica visível.
        setStatus(`Exportação não concluída: ${built?.error ?? 'loja indisponível'}.`, true);
        notify?.(`Exportação não concluída: ${built?.error ?? 'loja indisponível'}`, true);
        return { ok: false, code: built?.code ?? 'unavailable', store: built?.store ?? null, message: built?.error ?? 'loja indisponível' };
      }
      const text = serializeBackup(built.document);
      const filename = options.filename ?? backupFileName(now, { includeCourseContent });
      const ok = host.download ? (host.download(text, filename), true) : defaultDownload(document, text, filename);
      if (!ok) {
        setStatus('Não foi possível iniciar o download neste navegador; exporte novamente.', true);
        return { ok: false, code: 'download', summary: built.summary };
      }
      const label = includeCourseContent
        ? (includeAttachments ? 'PRIVADO com anexos' : 'PRIVADO com conteúdo de curso')
        : 'sem conteúdo de curso';
      const coursesLabel = built.summary.coursesOmitted
        ? 'cursos omitidos de propósito'
        : built.summary.coursesAvailable === false
          ? 'sem a loja de cursos'
          : `${built.summary.courses} curso(s)`;
      setStatus(`Backup gerado ${label}: ${built.summary.exercises} exercício(s), ${coursesLabel}.`);
      return { ok: true, filename, text, summary: built.summary, includeCourseContent };
    } catch (error) {
      setStatus(`Exportação não concluída: ${error?.message ?? error}`, true);
      return { ok: false, code: error?.code ?? 'export', message: error?.message ?? String(error) };
    }
  }

  async function importText(text) {
    const result = await importBackup(text, { library, store, attachments, now, shapes, bindings });
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
  privateCheckbox.addEventListener('change', () => {
    setStatus(null);
    const totals = attachments && typeof attachments.totals === 'function' ? attachments.totals() : null;
    renderAttachmentAvailability(totals);
    renderExportSummary();
  });
  privateDialogConfirm.addEventListener('click', () => settlePrivateConfirmation(true));
  privateDialogCancel.addEventListener('click', () => settlePrivateConfirmation(false));
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
  rootHost.appendChild(privateDialog);

  const api = {
    dialog, privateDialog, title, status,
    openExport, openImport, close,
    exportLibrary, importText, review,
    confirmPrivate: () => settlePrivateConfirmation(true),
    cancelPrivate: () => settlePrivateConfirmation(false),
    get mode() { return mode; },
    get pending() { return pending ? { legacy: pending.legacy } : null; },
    get privatePending() { return pendingPrivateConfirm !== null; },
    render() { if (mode === 'export') renderExport(); else renderImport(); return api; },
    destroy() {
      destroyed = true;
      settlePrivateConfirmation(false);
      if (typeof dialog.remove === 'function') dialog.remove();
      else if (typeof dialog.parentNode?.removeChild === 'function') dialog.parentNode.removeChild(dialog);
      if (typeof privateDialog.remove === 'function') privateDialog.remove();
      else if (typeof privateDialog.parentNode?.removeChild === 'function') privateDialog.parentNode.removeChild(privateDialog);
    },
  };
  return api;
}
