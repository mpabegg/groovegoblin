// Motor de sincronização local-primeiro (etapa 7 · B4).
//
// Regras que este módulo garante, na ordem em que importam:
// 1. sem servidor, nada acontece: nem erro, nem aviso insistente;
// 2. nenhuma operação apaga dados locais ou remotos sem deixar cópia —
//    conflito vira "cópia em conflito" com as ações "ficar com esta" e
//    "ficar com a outra", e a versão descartada vai para as cópias baixáveis;
// 3. toda alteração local passa pela fila durável ANTES da rede, então
//    recarregar no meio de um envio não perde nada;
// 4. o pull é fusão (união), nunca substituição crua;
// 5. bytes de anexo só deixam o navegador depois de confirmados no servidor e
//    apenas quando o material NÃO está marcado "manter offline".

import { canonicalText, bodyDigest } from './sync-store.js';
import { outboxKey } from './sync-outbox.js';

const PULL_PAGE = 500;
const MAX_PAGES = 40;
const DEFAULT_INTERVAL_MS = 3 * 60 * 1000;
const SCAN_DEBOUNCE_MS = 400;

// A sondagem de `/api/health` na abertura só acontece com MOTIVO, nunca por
// adivinhação de endereço:
//
// 1. o próprio servidor marca a página que ele serve
//    (`<html data-groove-server="on">`, trocado por `server/static.js` só quando
//    a API está ligada) — assim qualquer host, inclusive HTTPS próprio, é
//    reconhecido, e o site estático (marcador `off` ou ausente) não faz
//    requisição nenhuma, então não há 404 no console;
// 2. ou este navegador já sincronizou com um servidor nesta origem (o
//    `dataId` guardado é evidência, não palpite);
// 3. ou o usuário pediu ("Procurar servidor agora").
export const SERVER_MARKER_ATTR = 'data-groove-server';
export const SERVER_MARKER_ON = 'on';

export function serverMarkerSays(document_) {
  const root = document_?.documentElement ?? document_?.querySelector?.('html') ?? null;
  if (!root || typeof root.getAttribute !== 'function') return null;
  let value = null;
  try { value = root.getAttribute(SERVER_MARKER_ATTR); } catch { return null; }
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim().toLowerCase() === SERVER_MARKER_ON;
}

export function createSyncEngine({
  client,
  ports = [],
  outbox,
  state,
  now = () => new Date().toISOString(),
  intervalMs = DEFAULT_INTERVAL_MS,
  pageLimit = PULL_PAGE,
  online = () => globalThis.navigator?.onLine !== false,
  document: doc = globalThis.document ?? null,
  shouldProbe = null,
  initialWarnings = [],
  timers = {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: handle => clearInterval(handle),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: handle => clearTimeout(handle),
  },
  notify = () => {},
} = {}) {
  if (!client) throw new TypeError('O motor de sincronização precisa do cliente do servidor.');
  if (!outbox) throw new TypeError('O motor de sincronização precisa da fila durável.');
  if (!state) throw new TypeError('O motor de sincronização precisa do estado durável.');

  const listeners = new Set();
  // Várias portas podem servir a MESMA coleção (formas e vínculos de forma
  // moram em `forms`): cada uma é dona dos seus documentos, e a resolução por
  // documento evita aplicar o pull na loja errada.
  const byCollection = new Map();
  for (const port of ports) {
    if (!byCollection.has(port.collection)) byCollection.set(port.collection, []);
    byCollection.get(port.collection).push(port);
  }
  const unsupported = ports.filter(port => port.supported === false);
  const probePolicy = shouldProbe ?? (() => Boolean(state.dataId) || serverMarkerSays(doc) === true);
  const warnings = [];
  for (const message of initialWarnings) if (message) warnings.push(message);
  const degraded = new Set();
  let mode = 'unknown';
  let health = null;
  let firstConnect = null;
  let busy = null;
  let summary = null;
  let timer = null;
  let scanTimer = null;
  let queue = Promise.resolve();
  const unsubscribes = [];

  function emit() {
    for (const listener of [...listeners]) {
      try { listener(snapshot()); } catch { /* um assinante quebrado não derruba o motor */ }
    }
  }

  function warn(message) {
    if (!message || warnings.includes(message)) return;
    warnings.push(message);
    emit();
  }

  function portFor(collection, id = null) {
    const list = byCollection.get(collection) ?? [];
    if (id === null) return list.find(port => port.supported !== false) ?? null;
    return list.find(port => port.supported !== false && (typeof port.owns !== 'function' || port.owns(id))) ?? null;
  }

  function supportedPorts() { return ports.filter(port => port.supported !== false); }

  // Rótulo do porto nos avisos: uma coleção pode ter mais de um documento
  // (formas + vínculos), e dizer qual deles não pôde ser lido é o que o usuário
  // precisa saber.
  function portLabel(port) {
    return port.singleton && port.documentId ? `${port.collection} (${port.documentId})` : port.collection;
  }

  // Serializa tudo: dois ciclos de sincronização simultâneos (botão + timer +
  // evento de rede) não podem intercalar leituras e escritas.
  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  function snapshot() {
    return {
      mode,
      connected: mode === 'connected',
      online: online(),
      firstConnect,
      busy,
      lastSyncAt: state.lastSyncAt,
      pending: outbox.count(),
      conflicts: state.conflicts.length,
      recovered: state.recovered.length,
      pinned: state.pinned.length,
      health: health ? { mode: health.mode ?? null, version: health.version ?? null, dataId: health.dataId ?? null, storage: health.storage ?? null } : null,
      serverEmpty: health ? isServerEmpty(health) : null,
      summary,
      // Coleções que a última varredura não conseguiu ler (armazenamento
      // indisponível/ilegível). Não é erro de servidor: nada é enviado nem
      // removido a partir delas enquanto durar.
      degraded: [...degraded],
      warnings: [...new Set([...warnings, outbox.warning, state.warning, ...unsupported.map(port => port.unsupportedReason)].filter(Boolean))],
    };
  }

  function isServerEmpty(value) {
    const storage = value?.storage ?? {};
    return (storage.docs ?? 0) + (storage.tombstones ?? 0) === 0;
  }

  async function localHasData() {
    for (const port of supportedPorts()) {
      const documents = await port.list();
      if (documents.length > 0) return true;
    }
    return false;
  }

  // --------------------------------------------------------------- descoberta
  async function probe({ force = false } = {}) {
    if (!force && !probePolicy()) {
      // Site estático público: nenhuma requisição é feita, então nem 404 nem
      // erro de console. O modo local é o comportamento normal (critério 15).
      health = null;
      mode = 'local';
      firstConnect = null;
      emit();
      return { ok: false, mode: 'local', code: 'skipped', message: 'Sem servidor nesta origem.' };
    }
    const result = await client.probe();
    if (!result.ok) {
      health = null;
      mode = result.mode === 'identity' ? 'identity' : online() ? 'local' : 'offline';
      if (result.mode === 'identity') warn('O servidor recusou este dispositivo: identidade do Tailscale ausente ou fora da lista permitida.');
      firstConnect = null;
      emit();
      return result;
    }
    health = result.health;
    mode = 'connected';
    state.setServer({ dataId: health.dataId ?? null, cursor: state.cursor });
    const empty = isServerEmpty(health);
    if (!state.firstSyncDone) {
      const hasLocal = await localHasData();
      firstConnect = hasLocal && empty ? 'upload' : hasLocal ? 'merge' : null;
    } else {
      firstConnect = null;
    }
    emit();
    return { ok: true, mode: 'connected', health, firstConnect };
  }

  // ------------------------------------------------------------------ varredura
  // Detecta o que mudou localmente (impressão digital do corpo) e o que
  // desapareceu. Uma coleção indisponível (armazenamento ilegível/ausente) fica
  // de fora INTEIRA — a guarda é a disponibilidade declarada pelo porto, nunca o
  // tamanho da listagem: apagar o último documento de uma loja boa precisa subir
  // como lápide, senão o servidor o ressuscita.
  async function scan() {
    const enqueued = { documents: 0, deletions: 0, blobs: 0 };
    if (mode !== 'connected') return enqueued;
    // Documento com conflito aberto não é enviado: quem decide é o usuário.
    const blocked = new Set(state.conflicts.map(conflict => conflict.id));
    for (const port of supportedPorts()) {
      const ready = typeof port.available === 'function' ? await port.available() : true;
      if (!ready) {
        degraded.add(portLabel(port));
        warn(`Os dados de ${portLabel(port)} não puderam ser lidos agora; nada foi enviado nem removido a partir deles.`);
        continue;
      }
      let documents = [];
      try { documents = await port.list(); } catch (cause) {
        degraded.add(portLabel(port));
        warn(`Não foi possível ler os dados locais de ${portLabel(port)}: ${cause.message}`);
        continue;
      }
      degraded.delete(portLabel(port));
      const seen = new Set();
      for (const doc of documents) {
        seen.add(doc.id);
        const key = `${port.collection}|${doc.id}`;
        if (blocked.has(key)) continue;
        const digest = bodyDigest(canonicalText(doc.body));
        if (state.digest(port.collection, doc.id) === digest) continue;
        const rev = state.revision(port.collection, doc.id);
        const result = outbox.enqueue({
          kind: 'doc-put', collection: port.collection, docId: doc.id, body: doc.body,
          baseRev: rev, create: rev === null,
        });
        if (result.ok) enqueued.documents += 1;
        else warn('A fila de sincronização está cheia; novas alterações esperam.');
      }
      // Remoção local: só para documentos que JÁ materializamos aqui (temos
      // revisão E impressão digital guardadas). Com a loja disponível e o
      // documento ausente da listagem, ele foi apagado neste navegador.
      // A varredura é limitada ao que ESTE porto possui: `forms` guarda dois
      // documentos (formas e vínculos) em portos separados, e sem `owns` cada
      // um apagaria o documento do outro como se tivesse sumido daqui.
      const owns = typeof port.owns === 'function' ? port.owns : null;
      for (const key of Object.keys(state.revisions)) {
        const [collection, id] = splitKey(key);
        if (collection !== port.collection || seen.has(id) || blocked.has(key)) continue;
        if (owns && !owns(id)) continue;
        if (state.digest(collection, id) === null) continue;
        const rev = state.revision(collection, id);
        if (rev === null) continue;
        const result = outbox.enqueue({ kind: 'doc-delete', collection, docId: id, baseRev: rev });
        if (result.ok) enqueued.deletions += 1;
      }
      const blobs = port.blobs;
      if (blobs && typeof blobs.list === 'function') {
        let files = [];
        try { files = await blobs.list(); } catch { files = []; }
        for (const file of files) {
          if (state.blobConfirmed(file.sha256)) continue;
          const result = outbox.enqueue({ kind: 'blob-put', sha256: file.sha256, size: file.size ?? null, name: file.name ?? null });
          if (result.ok) enqueued.blobs += 1;
        }
      }
    }
    if (enqueued.documents || enqueued.deletions || enqueued.blobs) emit();
    return enqueued;
  }

  function splitKey(key) {
    const index = key.indexOf('|');
    return index < 0 ? [key, ''] : [key.slice(0, index), key.slice(index + 1)];
  }

  // -------------------------------------------------------------------- envio
  async function sendOp(op) {
    switch (op.kind) {
      case 'doc-put': {
        const result = await client.putDoc(op.collection, op.docId, op.body, { create: op.create, rev: op.baseRev });
        if (result.ok) {
          state.markSent(op.collection, op.docId, result.rev, bodyDigest(canonicalText(op.body)));
          outbox.remove(op.id);
          return 'sent';
        }
        if (result.code === 'precondition_failed') return resolvePreconditionFailure(op, result);
        outbox.fail(op.id, result.message);
        return result.offline || result.status === 0 ? 'offline' : 'failed';
      }
      case 'doc-delete': {
        const result = await client.deleteDoc(op.collection, op.docId, { rev: op.baseRev });
        if (result.ok || result.status === 404) {
          state.clearRevision(op.collection, op.docId);
          outbox.remove(op.id);
          return 'sent';
        }
        if (result.code === 'precondition_failed') return resolvePreconditionFailure(op, result);
        outbox.fail(op.id, result.message);
        return result.offline || result.status === 0 ? 'offline' : 'failed';
      }
      case 'blob-put': {
        const blobs = portFor(op.collection)?.blobs
          ?? [...byCollection.values()].flat().find(entry => entry.blobs)?.blobs
          ?? null;
        // Dedup: um HEAD antes do PUT economiza o envio de arquivos grandes que
        // já estão no servidor.
        const head = await client.headBlob(op.sha256);
        if (head.ok && head.exists) {
          state.confirmBlob(op.sha256, { size: head.size ?? op.size });
          outbox.remove(op.id);
          return 'sent';
        }
        if (!head.ok && head.status !== 404) {
          outbox.fail(op.id, head.message);
          return head.offline || head.status === 0 ? 'offline' : 'failed';
        }
        const bytes = blobs && typeof blobs.read === 'function' ? await blobs.read(op.sha256) : null;
        if (!bytes) {
          outbox.fail(op.id, 'Os bytes deste arquivo não estão mais neste navegador.');
          return 'failed';
        }
        const result = await client.putBlob(op.sha256, bytes);
        if (result.ok) {
          state.confirmBlob(op.sha256, { size: op.size });
          outbox.remove(op.id);
          return 'sent';
        }
        outbox.fail(op.id, result.message);
        return result.offline || result.status === 0 ? 'offline' : 'failed';
      }
      default:
        outbox.remove(op.id);
        return 'dropped';
    }
  }

  // 412: o servidor tem outra revisão. Três desfechos possíveis, nunca perda:
  // - o corpo remoto é IGUAL ao nosso → foi o nosso próprio envio que chegou
  //   (recarga no meio do envio); nada a fazer além de registrar a revisão;
  // - o remoto é diferente → cópia em conflito (a local) + servidor aplicado;
  // - o remoto foi apagado → lápide aplicada e a intenção local guardada.
  async function resolvePreconditionFailure(op, result) {
    const remote = await client.getDoc(op.collection, op.docId);
    const knownRev = result.conflict?.rev ?? null;
    const remoteDeleted = remote.ok ? remote.deleted === true : result.conflict?.deleted === true;
    const port = portFor(op.collection, op.docId);
    if (!remoteDeleted && remote.ok && op.kind === 'doc-put' && canonicalText(remote.body) === canonicalText(op.body)) {
      state.markSent(op.collection, op.docId, remote.rev ?? knownRev, bodyDigest(canonicalText(op.body)));
      outbox.remove(op.id);
      return 'echo';
    }
    if (port) {
      const stored = state.addConflict({
        id: `${op.collection}|${op.docId}`,
        collection: op.collection,
        docId: op.docId,
        intent: op.kind === 'doc-delete' ? 'delete' : 'put',
        localBody: op.kind === 'doc-put' ? op.body : null,
        baseRev: op.baseRev,
        serverRev: remote.ok ? remote.rev ?? knownRev : knownRev,
        serverBody: remote.ok && !remoteDeleted ? remote.body : null,
        serverDeleted: remoteDeleted,
      });
      if (!stored.ok && stored.code === 'full') warn('Há cópias em conflito demais guardadas; resolva as antigas para continuar.');
      if (remoteDeleted) {
        const local = await port.get(op.docId).catch(() => null);
        if (local) await port.remove(op.docId).catch(() => {});
        state.clearRevision(op.collection, op.docId);
      } else if (remote.ok) {
        await applyRemote(port, { id: op.docId, body: remote.body }, remote.rev ?? knownRev);
      }
    }
    outbox.remove(op.id);
    notify(`Conflito no servidor em “${op.docId}”: a versão do servidor ficou e a sua virou cópia em conflito.`);
    return 'conflict';
  }

  async function flush() {
    if (mode !== 'connected') return { ok: false, code: mode };
    let sent = 0;
    let conflicts = 0;
    let failed = 0;
    for (const op of outbox.list()) {
      const result = await sendOp(op);
      if (result === 'sent') sent += 1;
      else if (result === 'conflict') conflicts += 1;
      else if (result === 'failed') failed += 1;
      else if (result === 'offline') {
        mode = 'offline';
        emit();
        return { ok: false, code: 'offline', sent, conflicts, failed };
      }
    }
    if (mode === 'offline' && online()) mode = 'connected';
    state.markSynced(now());
    emit();
    return { ok: true, sent, conflicts, failed, pending: outbox.count() };
  }

  // -------------------------------------------------------------------- pull
  // A impressão digital registrada é a do corpo DO SERVIDOR: se a fusão local
  // produzir algo diferente (união de formas, progresso somado, notas
  // acrescentadas), a varredura seguinte percebe a diferença e sobe a união —
  // nada fica preso só no navegador. Quando o porto não aplicou (ilegível, sem
  // suporte), nenhuma impressão digital é registrada: assim o documento também
  // não entra na detecção de remoção.
  async function applyRemote(port, doc, rev) {
    const result = await port.apply(doc);
    const applied = !result?.skipped;
    const digest = applied && doc.body !== undefined && doc.body !== null ? bodyDigest(canonicalText(doc.body)) : null;
    state.markSent(port.collection, doc.id, rev ?? state.revision(port.collection, doc.id), digest);
    if (result?.changed) emit();
    return result;
  }

  async function pull({ full = false } = {}) {
    if (mode !== 'connected') return { ok: false, code: mode };
    const counts = { applied: 0, removed: 0, conflicts: 0, pages: 0, resynced: false };
    let since = full ? null : state.cursor;
    let restart = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await client.changes({ since, limit: pageLimit });
      if (!result.ok) {
        if (result.status === 410) {
          // Cursor inútil (outro diretório de dados ou lápides podadas):
          // ressincroniza do zero, sem descartar nada.
          state.resetCursor();
          since = null;
          counts.resynced = true;
          restart = true;
          if (page > MAX_PAGES - 2) break;
          continue;
        }
        if (result.offline || result.status === 0) mode = 'offline';
        emit();
        return { ok: false, code: result.code ?? 'error', ...counts };
      }
      restart = false;
      counts.pages += 1;
      for (const change of result.changes) {
        const port = portFor(change.collection, change.id);
        if (!port || port.supported === false) continue;
        if (change.rev === state.revision(change.collection, change.id) && !counts.resynced) continue;
        if (change.deleted) {
          const local = await port.get(change.id).catch(() => null);
          if (local) {
            await port.remove(change.id).catch(() => {});
            counts.removed += 1;
          }
          state.clearRevision(change.collection, change.id);
          continue;
        }
        const local = await port.get(change.id).catch(() => null);
        const storedDigest = state.digest(change.collection, change.id);
        const diverged = local !== null && storedDigest !== null && bodyDigest(canonicalText(local.body)) !== storedDigest;
        // Leitura condicional pelo que TEMOS: o feed pode citar uma revisão que
        // já é a nossa (o `If-None-Match` com a revisão do feed responderia 304
        // e o corpo nunca chegaria — era o defeito do pull). Havendo divergência
        // local, o corpo do servidor é obrigatório: a cópia em conflito guarda
        // os dois lados.
        const knownRev = state.revision(change.collection, change.id);
        const remote = await client.getDoc(change.collection, change.id, { rev: diverged ? null : knownRev });
        if (!remote.ok) {
          if (remote.deleted) {
            if (local) { await port.remove(change.id).catch(() => {}); counts.removed += 1; }
            state.clearRevision(change.collection, change.id);
          }
          continue;
        }
        if (remote.notModified) { state.setRevision(change.collection, change.id, remote.rev ?? change.rev); continue; }
        // Os dois lados mudaram desde a última sincronização: o servidor fica e
        // a versão local vira cópia em conflito (nada é descartado).
        if (diverged) {
          const stored = state.addConflict({
            id: `${change.collection}|${change.id}`,
            collection: change.collection,
            docId: change.id,
            intent: 'put',
            localBody: local?.body ?? null,
            baseRev: state.revision(change.collection, change.id),
            serverRev: remote.rev ?? change.rev,
            serverBody: remote.body,
            serverDeleted: false,
          });
          if (stored.ok) {
            counts.conflicts += 1;
            // A intenção local já está guardada na cópia em conflito: o envio
            // pendente deste documento sai da fila para não sobrescrever, sem
            // aviso, a versão do servidor que acabou de ser aplicada.
            outbox.remove(outboxKey({ collection: change.collection, docId: change.id }));
            notify(`Conflito no servidor em “${change.id}”: a versão do servidor ficou e a sua virou cópia em conflito.`);
          }
        }
        await applyRemote(port, { id: change.id, body: remote.body }, remote.rev ?? change.rev);
        counts.applied += 1;
      }
      state.setCursor(result.cursor ?? since);
      if (!result.more || restart) break;
      since = result.cursor;
    }
    state.markSynced(now());
    emit();
    return { ok: true, ...counts };
  }

  // ------------------------------------------------------------- primeiros passos
  // "Enviar meus dados para o servidor": tudo que existe localmente vira
  // criação no servidor (nada é sobrescrito sem revisão conhecida).
  async function sendAll() {
    if (mode !== 'connected') return { ok: false, code: mode };
    busy = 'send';
    emit();
    try {
      const scanned = await scan();
      const result = await flush();
      const blobs = await releaseLocalBytes();
      state.markFirstSyncDone();
      firstConnect = null;
      summary = { kind: 'send', ...scanned, sent: result.sent ?? 0, pending: outbox.count(), blobsReleased: blobs.released };
      emit();
      return { ok: true, ...summary };
    } finally {
      busy = null;
      emit();
    }
  }

  // "Mesclar": traz o servidor (fusão), depois sobe o que é só local. Nenhum
  // lado perde nada — a fusão é união e o conflito guarda cópia.
  async function mergeBoth() {
    if (mode !== 'connected') return { ok: false, code: mode };
    busy = 'merge';
    emit();
    try {
      const pulled = await pull({ full: true });
      const scanned = await scan();
      const result = await flush();
      await releaseLocalBytes();
      state.markFirstSyncDone();
      firstConnect = null;
      summary = { kind: 'merge', pulled, ...scanned, sent: result.sent ?? 0, conflicts: (pulled.conflicts ?? 0) + (result.conflicts ?? 0), pending: outbox.count() };
      emit();
      return { ok: true, ...summary };
    } finally {
      busy = null;
      emit();
    }
  }

  // ------------------------------------------------------------------ anexos
  // Libera bytes locais só quando o blob está confirmado no servidor E o
  // material não está marcado "manter offline".
  async function releaseLocalBytes() {
    const confirmed = new Set(Object.keys(state.confirmedBlobs()));
    const pinned = new Set(state.pinned.map(entry => entry.sha256));
    let released = 0;
    let freedBytes = 0;
    for (const port of supportedPorts()) {
      if (!port.blobs || typeof port.blobs.release !== 'function') continue;
      const digests = typeof port.blobs.list === 'function' ? (await port.blobs.list()).map(file => file.sha256) : [];
      const result = await port.blobs.release(digests, { confirmed, pinned });
      released += result.released ?? 0;
      freedBytes += result.freedBytes ?? 0;
    }
    if (released > 0) emit();
    return { released, freedBytes };
  }

  // ------------------------------------------------------------------ ciclos
  async function syncNow() {
    if (mode !== 'connected') {
      const probed = await probe();
      if (!probed.ok) return { ok: false, code: probed.mode ?? 'offline' };
    }
    if (firstConnect) {
      // A oferta de primeira conexão é recalculada a cada ciclo: o servidor
      // pode ter recebido dados de outro navegador depois da sondagem da
      // abertura, e "enviar meus dados" com dados dos dois lados não é a mesma
      // coisa que "mesclar sem apagar nada". A sondagem é uma requisição de
      // saúde; a decisão continua sendo do usuário.
      await probe();
      if (firstConnect) return { ok: false, code: 'first-connect', firstConnect };
    }
    busy = 'sync';
    emit();
    try {
      await scan();
      const pushed = await flush();
      const pulled = await pull();
      await scan();
      const pushedAfterPull = await flush();
      await releaseLocalBytes();
      summary = {
        kind: 'sync',
        sent: (pushed.sent ?? 0) + (pushedAfterPull.sent ?? 0),
        applied: pulled.applied ?? 0,
        removed: pulled.removed ?? 0,
        conflicts: (pushed.conflicts ?? 0) + (pulled.conflicts ?? 0) + (pushedAfterPull.conflicts ?? 0),
        pending: outbox.count(),
      };
      return summary;
    } finally {
      busy = null;
      emit();
    }
  }

  function refreshLocalChanges() {
    if (mode !== 'connected' || firstConnect) return;
    void enqueue(async () => {
      await scan();
      await flush();
    }).catch(() => {});
  }

  // Uma alteração local nunca dispara rede imediata: agrupa em uma varredura
  // curta para não escrever a cada tecla.
  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = timers.setTimeout(() => {
      scanTimer = null;
      refreshLocalChanges();
    }, SCAN_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------------ ciclo de vida
  async function start() {
    for (const port of supportedPorts()) {
      if (typeof port.subscribe !== 'function') continue;
      const unsubscribe = port.subscribe(scheduleScan);
      if (typeof unsubscribe === 'function') unsubscribes.push(unsubscribe);
    }
    const probed = await probe();
    if (probed.ok && !firstConnect) await syncNow();
    if (timer === null) {
      timer = timers.setInterval(() => { void enqueue(() => syncNow()); }, intervalMs);
    }
    emit();
    return snapshot();
  }

  function stop() {
    timers.clearInterval(timer);
    timer = null;
    timers.clearTimeout(scanTimer);
    scanTimer = null;
    for (const unsubscribe of unsubscribes.splice(0)) {
      try { unsubscribe(); } catch { /* assinante quebrado */ }
    }
    emit();
  }

  return {
    get mode() { return mode; },
    get firstConnect() { return firstConnect; },
    snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Assinante inválido.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start: () => enqueue(start),
    stop,
    probe: options => enqueue(() => probe(options)),
    syncNow: () => enqueue(syncNow),
    pull: options => enqueue(() => pull(options)),
    flush: () => enqueue(flush),
    scan: () => enqueue(scan),
    sendAll: () => enqueue(sendAll),
    mergeBoth: () => enqueue(mergeBoth),

    // Remoção local explícita (a interface chama quando o usuário apaga algo):
    // manda a lápide com a revisão conhecida e some com o documento no servidor.
    recordLocalDelete(collection, docId) {
      const rev = state.revision(collection, docId);
      if (rev === null) {
        // Nunca esteve no servidor: basta esquecer qualquer envio pendente.
        outbox.remove(outboxKey({ collection, docId }));
        emit();
        return { ok: true, skipped: 'never-synced' };
      }
      const result = outbox.enqueue({ kind: 'doc-delete', collection, docId, baseRev: rev });
      emit();
      return result;
    },

    conflicts() { return state.conflicts; },
    recovered() { return state.recovered; },
    pinned() { return state.pinned; },

    // Escolha explícita do usuário. A versão descartada NUNCA é perdida: vai
    // para as cópias baixáveis antes de qualquer escrita.
    async resolveConflict(id, side) {
      const conflict = state.conflicts.find(entry => entry.id === id);
      if (!conflict) return { ok: false, code: 'missing' };
      const port = portFor(conflict.collection);
      if (side === 'mine') {
        // Guarda a versão do servidor antes de qualquer coisa.
        state.addRecovered({
          id: `${conflict.id}|servidor|${now()}`,
          collection: conflict.collection,
          docId: conflict.docId,
          side: 'server',
          body: conflict.serverBody,
          rev: conflict.serverRev,
          deleted: conflict.serverDeleted === true,
        });
        state.removeConflict(id);
        if (conflict.intent === 'delete') {
          if (conflict.serverDeleted) { emit(); return { ok: true, side: 'mine', deleted: true }; }
          // "Quero apagar mesmo": a lápide vai contra a revisão atual.
          outbox.enqueue({ kind: 'doc-delete', collection: conflict.collection, docId: conflict.docId, baseRev: conflict.serverRev });
          emit();
          const removed = await enqueue(flush);
          if (port) await port.remove(conflict.docId).catch(() => {});
          return { ok: true, side: 'mine', deleted: true, ...removed };
        }
        const create = conflict.serverDeleted === true || conflict.serverRev === null;
        outbox.enqueue({
          kind: 'doc-put', collection: conflict.collection, docId: conflict.docId,
          body: conflict.localBody, baseRev: create ? null : conflict.serverRev, create,
        });
        emit();
        const flushed = await enqueue(flush);
        // A cópia local volta a ser a escolhida (o servidor acabou de recebê-la):
        // sem isto, o navegador ficaria com a versão do servidor até o próximo
        // pull, e o usuário veria a troca sem entender por quê.
        if (conflict.localBody && port) {
          await applyRemote(port, { id: conflict.docId, body: conflict.localBody }, state.revision(conflict.collection, conflict.docId));
        }
        return { ok: true, side: 'mine', ...flushed };
      }
      state.addRecovered({
        id: `${conflict.id}|local|${now()}`,
        collection: conflict.collection,
        docId: conflict.docId,
        side: 'local',
        body: conflict.localBody,
        rev: conflict.baseRev,
        deleted: false,
      });
      state.removeConflict(id);
      emit();
      return { ok: true, side: 'server' };
    },

    // "Manter offline": o anexo continua no navegador e nunca é liberado.
    pinAttachment(sha256, meta = {}) {
      const changed = state.pinBlob({ sha256, ...meta });
      emit();
      return changed;
    },
    unpinAttachment(sha256) {
      const changed = state.unpinBlob(sha256);
      emit();
      return changed;
    },
    releaseLocalBytes: () => enqueue(releaseLocalBytes),
    refreshLocalChanges,

    exportRecovered() {
      return JSON.stringify({
        format: 'groovegoblin-sync-conflicts',
        version: 1,
        exportedAt: now(),
        conflicts: state.conflicts,
        recovered: state.recovered,
      });
    },
  };
}
