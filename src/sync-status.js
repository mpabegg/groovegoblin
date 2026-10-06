// Estado visível da sincronização (etapa 7 · B4).
//
// Duas superfícies, e só duas:
// - uma LINHA em "Ajuda e app" (sempre presente, mesmo sem servidor);
// - um INDICADOR discreto no cabeçalho, apenas quando há problema (conflito,
//   identidade recusada, fila que não grava, aviso do motor).
//
// O painel também concentra as ações raras: sincronizar agora, procurar o
// servidor, enviar/mesclar na primeira conexão, resolver conflitos e baixar as
// cópias guardadas. Nada disso aparece na vista padrão.

import { mountPrivateDownload } from './private-download.js';

const BUTTON_LABELS = {
  sync: 'Sincronizar agora',
  find: 'Procurar servidor agora',
  upload: 'Enviar meus dados para o servidor',
  merge: 'Mesclar sem apagar nada',
  later: 'Agora não',
  recovered: 'Baixar cópias guardadas',
  server: 'Ficar com a do servidor',
  mine: 'Ficar com esta',
  release: 'Deixar de manter offline',
};

export function relativeTime(iso, now = Date.now()) {
  if (typeof iso !== 'string') return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'agora mesmo';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  return `há ${days} ${days === 1 ? 'dia' : 'dias'}`;
}

// A linha pedida no contrato: sincronizado / fila / sem conexão / sem servidor.
export function statusText(snapshot, { now = Date.now() } = {}) {
  if (!snapshot) return 'Sem servidor (dados só neste navegador)';
  if (snapshot.mode === 'identity') return 'Servidor: identidade do Tailscale ausente ou não permitida';
  if (snapshot.mode !== 'connected') {
    return snapshot.mode === 'offline' ? 'Servidor: sem conexão' : 'Sem servidor (dados só neste navegador)';
  }
  if (snapshot.conflicts > 0) {
    return `Servidor: ${snapshot.conflicts} ${snapshot.conflicts === 1 ? 'conflito' : 'conflitos'} para resolver`;
  }
  if (!snapshot.online) return 'Servidor: sem conexão';
  if (snapshot.pending > 0) {
    return `Servidor: ${snapshot.pending} ${snapshot.pending === 1 ? 'alteração' : 'alterações'} na fila`;
  }
  const relative = relativeTime(snapshot.lastSyncAt, now);
  return relative ? `Servidor: sincronizado ${relative}` : 'Servidor: pronto para sincronizar';
}

// O indicador do cabeçalho só aparece com problema de verdade: fila normal e
// ausência de servidor não são problema.
export function problemOf(snapshot) {
  if (!snapshot) return null;
  if (snapshot.mode === 'identity') return 'identity';
  if (snapshot.conflicts > 0) return 'conflicts';
  if (Array.isArray(snapshot.warnings) && snapshot.warnings.length > 0) return 'warning';
  return null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function detailLines(snapshot) {
  const lines = [];
  if (snapshot.mode === 'connected') {
    const used = formatBytes(snapshot.health?.storage?.usedBytes);
    const free = formatBytes(snapshot.health?.storage?.freeBytes);
    if (used || free) lines.push(`Espaço no servidor: ${used ?? '—'} usados, ${free ?? '—'} livres.`);
    if (snapshot.pinned > 0) lines.push(`${snapshot.pinned} material(is) marcado(s) para uso offline neste navegador.`);
  } else if (snapshot.mode === 'offline') {
    lines.push('Sem conexão: as alterações continuam guardadas aqui e sobem quando a rede voltar.');
  } else if (snapshot.mode === 'identity') {
    lines.push('Confira se este dispositivo está na tailnet e se o login está na lista permitida do servidor.');
  } else if (snapshot.mode === 'local') {
    lines.push('Os dados vivem só neste navegador. Com um servidor na mesma origem, esta linha passa a mostrar a sincronização.');
  }
  if (Array.isArray(snapshot.degraded) && snapshot.degraded.length > 0) {
    lines.push(`Sem leitura agora: ${snapshot.degraded.join(', ')} — nada é enviado nem removido a partir daí.`);
  }
  for (const warning of snapshot.warnings ?? []) lines.push(warning);
  return lines;
}

export function mountSyncStatus({
  engine,
  helpContainer,
  headerContainer = null,
  document: doc = globalThis.document,
  now = () => Date.now(),
  notify = () => {},
  download = null,
} = {}) {
  if (!engine || typeof engine.snapshot !== 'function') throw new TypeError('Painel de sincronização precisa do motor.');
  if (!helpContainer || typeof helpContainer.appendChild !== 'function') throw new TypeError('Painel de sincronização precisa do contêiner de Ajuda.');

  const el = (tag, props = {}) => {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (key === 'hidden') node.hidden = value === true;
      else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
    }
    return node;
  };

  const details = el('details', { className: 'sync-help' });
  details.appendChild(el('summary', { text: 'Servidor' }));
  const panel = el('div', { className: 'sync-panel', id: 'sync-panel' });
  details.appendChild(panel);
  helpContainer.appendChild(details);
  // As cópias guardadas pela sincronização (conflitos e recuperação) são
  // documentos CRUS: podem conter o curso privado inteiro, e não dá para
  // redigir sem perder a recuperação. Saem pela MESMA convenção das outras
  // saídas privadas: nome com a marca PRIVADO e confirmação nativa; cancelar
  // não gera arquivo e os bytes saem intactos.
  const privateFiles = mountPrivateDownload(helpContainer, { document: doc, download, notify });

  const line = el('p', { id: 'sync-status', className: 'sync-status', role: 'status', 'aria-live': 'polite' });
  const detail = el('div', { className: 'sync-detail muted' });
  const actions = el('div', { className: 'sync-actions' });
  const first = el('div', { className: 'sync-first', hidden: true });
  const conflictsBox = el('div', { className: 'sync-conflicts' });
  const pinnedBox = el('div', { className: 'sync-pinned' });
  panel.append(line, detail, first, actions, conflictsBox, pinnedBox);

  const button = (label, onClick, props = {}) => {
    const node = el('button', { type: 'button', text: label, ...props });
    node.addEventListener('click', () => { void Promise.resolve(onClick()).catch(error => notify(error?.message ?? String(error), true)); });
    return node;
  };

  const syncButton = button(BUTTON_LABELS.sync, () => engine.syncNow());
  const findButton = button(BUTTON_LABELS.find, () => engine.probe({ force: true }).then(result => {
    if (result?.ok) notify('Servidor encontrado nesta origem.');
    else notify('Nenhum servidor respondeu nesta origem.', true);
  }));
  const uploadButton = button(BUTTON_LABELS.upload, () => engine.sendAll().then(result => notify(`Envio concluído: ${result.sent ?? 0} documento(s).`)));
  const mergeButton = button(BUTTON_LABELS.merge, () => engine.mergeBoth().then(result => notify(`Mesclagem concluída: ${result.sent ?? 0} enviado(s), ${result.applied ?? 0} trazido(s), ${result.conflicts ?? 0} conflito(s).`)));
  const laterButton = button(BUTTON_LABELS.later, () => { first.hidden = true; });
  const recoveredButton = button(BUTTON_LABELS.recovered, () => privateFiles.download(engine.exportRecovered(), 'groovegoblin-sincronizacao-copias.json'));
  first.append(uploadButton, mergeButton, laterButton);
  actions.append(syncButton, findButton, recoveredButton);

  let indicator = null;
  if (headerContainer && typeof headerContainer.appendChild === 'function') {
    indicator = el('button', { type: 'button', className: 'sync-indicator', hidden: true, 'aria-label': 'Sincronização com problema' });
    indicator.addEventListener('click', () => {
      details.open = true;
      line.focus?.({ preventScroll: false });
    });
    headerContainer.appendChild(indicator);
  }

  function renderConflicts(snapshot) {
    const conflicts = engine.conflicts();
    conflictsBox.replaceChildren();
    if (conflicts.length === 0) return;
    conflictsBox.appendChild(el('p', { className: 'muted', text: `Cópias em conflito (${conflicts.length}): a versão do servidor está em uso; escolha o que fica. Nada é apagado sem guardar a outra.` }));
    const list = el('ul', { className: 'sync-conflict-list' });
    for (const conflict of conflicts) {
      const item = el('li', { className: 'sync-conflict' });
      const title = conflict.intent === 'delete'
        ? `${conflict.docId} — você apagou aqui; o servidor ainda tem.`
        : `${conflict.docId} — mudou aqui e no servidor.`;
      item.appendChild(el('p', { text: title }));
      item.appendChild(button(BUTTON_LABELS.mine, async () => {
        await engine.resolveConflict(conflict.id, 'mine');
        notify('A sua versão foi enviada; a do servidor ficou guardada nas cópias.');
      }));
      item.appendChild(button(BUTTON_LABELS.server, async () => {
        await engine.resolveConflict(conflict.id, 'server');
        notify('A versão do servidor ficou; a sua continua guardada nas cópias.');
      }));
      list.appendChild(item);
    }
    conflictsBox.appendChild(list);
    if (snapshot.recovered > 0) {
      conflictsBox.appendChild(el('p', { className: 'muted', text: `${snapshot.recovered} cópia(s) de segurança guardadas durante a resolução de conflitos.` }));
    }
  }

  function renderOfflineList() {
    const pinned = engine.pinned();
    pinnedBox.replaceChildren();
    if (pinned.length === 0) return;
    pinnedBox.appendChild(el('p', { className: 'muted', text: 'Mantidos offline neste navegador:' }));
    const list = el('ul', { className: 'sync-pinned-list' });
    for (const entry of pinned) {
      const item = el('li');
      item.appendChild(el('span', { text: entry.name ?? entry.sha256.slice(0, 12) }));
      item.appendChild(button(BUTTON_LABELS.release, () => { engine.unpinAttachment(entry.sha256); }));
      list.appendChild(item);
    }
    pinnedBox.appendChild(list);
  }

  function render(snapshot = engine.snapshot()) {
    line.textContent = statusText(snapshot, { now: now() });
    detail.replaceChildren();
    for (const text of detailLines(snapshot)) detail.appendChild(el('p', { className: 'muted', text }));
    const connected = snapshot.mode === 'connected';
    syncButton.hidden = !connected || Boolean(snapshot.firstConnect);
    syncButton.disabled = Boolean(snapshot.busy);
    findButton.hidden = connected;
    recoveredButton.hidden = (snapshot.recovered ?? 0) === 0 && (snapshot.conflicts ?? 0) === 0;
    if (snapshot.firstConnect) {
      first.hidden = false;
      uploadButton.hidden = snapshot.firstConnect !== 'upload' && snapshot.firstConnect !== 'merge';
      mergeButton.hidden = snapshot.firstConnect !== 'merge';
    } else if (first.hidden === false) {
      first.hidden = true;
    }
    renderConflicts(snapshot);
    renderOfflineList();
    const problem = problemOf(snapshot);
    if (indicator) {
      indicator.hidden = problem === null;
      indicator.textContent = problem === 'identity' ? 'Servidor: identidade' : problem === 'conflicts' ? `Servidor: ${snapshot.conflicts} conflito(s)` : 'Servidor: atenção';
      indicator.setAttribute('title', statusText(snapshot, { now: now() }));
    }
  }

  const unsubscribe = engine.subscribe(() => render());
  render();

  return {
    render,
    destroy() {
      unsubscribe();
      privateFiles.destroy();
      details.remove?.();
      indicator?.remove?.();
    },
  };
}
