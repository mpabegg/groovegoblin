// Máquina de estado da sessão de hoje (rodada 4, item 4 — etapa 5).
//
// Responsabilidades: manter a fila ativa, contar o tempo praticado de cada item
// a partir de intervalos FECHADOS, avisar (uma única vez por item) quando a meta
// do item zera — sem nunca trocar de item nem interromper um treino em curso —,
// e encerrar com resumo de exercícios, tempos e mudanças de BPM.
//
// Regras que o desenho garante por construção:
//  - Nada de "tempo desde a criação da fila": o relógio só corre enquanto o item
//    está ativo e o intervalo é aberto e fechado explicitamente.
//  - Fechar/reabrir volta SEMPRE pausado (a loja não persiste intervalo aberto),
//    então a noite parada nunca é cobrada.
//  - Cada intervalo fechado vira um registro idempotente (id próprio) para o
//    histórico compartilhado; repetir o fechamento não duplica nada.
//  - Falar em ocioso não interrompe o áudio: só Próximo/Encerrar pedem parada.

import { itemTargetMs, queueTotalMs, DEFAULT_ITEM_MINUTES } from './today-store.js';

function defaultUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `run-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function createTodaySession({
  store, library = null, getActivity = () => null, notify = () => {},
  now = Date.now, uuid = defaultUuid, openItem = null, getOwner = null,
  isExecuting = null, stopExecution = null, onEvent = null,
} = {}) {
  if (!store || typeof store.saveSession !== 'function' || typeof store.items !== 'function') {
    throw new TypeError('A sessão de hoje precisa da loja da fila.');
  }
  const readActivity = typeof getActivity === 'function' ? getActivity : () => getActivity;
  // Estado restaurado: se havia sessão salva, ela volta PAUSADA.
  let session = store.session() ?? null;
  let live = null;
  let autoResume = false;
  let lastReason = session ? 'restored' : null;
  let lastSummary = store.summary() ?? null;
  let journalWarning = null;

  function emit(name, payload = {}) {
    try { onEvent?.(name, payload); } catch { /* Um ouvinte quebrado não derruba a sessão. */ }
  }

  function journalProblem(text, reason) {
    journalWarning = text;
    emit('journal-problem', { reason, warning: text });
  }

  function label(item) {
    return item?.name ?? item?.exerciseId ?? 'exercício';
  }

  function activeItem() {
    return session ? session.items[session.activeIndex] ?? null : null;
  }

  function bpmOf(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function describe(exerciseId) {
    let row = null;
    try { row = library?.list?.().find(candidate => candidate.id === exerciseId) ?? null; } catch { row = null; }
    const entry = library?.get?.(exerciseId) ?? null;
    return {
      name: row?.name ?? entry?.metadata?.name ?? null,
      instrument: row?.instrument ?? null,
      bpm: bpmOf(row?.bpm) ?? bpmOf(entry?.session?.bpm),
    };
  }

  function liveMs(at = now()) {
    return live ? Math.max(0, at - live.startedAtMs) : 0;
  }

  function persist() {
    if (!session) { store.saveSession(null); return; }
    if (store.saveSession(session)) {
      const saved = store.session();
      if (saved) session = saved;
    }
  }

  function openInterval(at, reason) {
    if (!session || live) return;
    const item = activeItem();
    if (!item) return;
    if (!item.startedAt) item.startedAt = new Date(at).toISOString();
    if (item.startBpm === null) item.startBpm = describe(item.exerciseId).bpm;
    live = {
      // Id curto (limite de 80 do diário de atividade) e único por intervalo.
      id: `t-${uuid()}`,
      itemId: item.id,
      startedAtMs: at,
      startedAtIso: new Date(at).toISOString(),
    };
    lastReason = reason;
    persist();
  }

  // Fecha o intervalo vivo e devolve o registro FECHADO (ou null quando não
  // havia nada aberto — é isso que torna pagehide/visibilitychange idempotentes).
  function closeInterval(reason) {
    if (!session || !live) return null;
    const item = session.items.find(candidate => candidate.id === live.itemId) ?? activeItem();
    const endMs = Math.max(live.startedAtMs, now());
    const durationMs = endMs - live.startedAtMs;
    if (item && durationMs > 0) {
      item.elapsedMs += durationMs;
      item.practiced = true;
    }
    const record = {
      id: live.id,
      exerciseId: item?.exerciseId ?? null,
      instrument: item?.instrument ?? null,
      startedAt: live.startedAtIso,
      endedAt: new Date(endMs).toISOString(),
      source: 'today',
      mode: 'practice',
    };
    live = null;
    persist();
    // Só intervalo FECHADO vai para o diário compartilhado. Nem dado inválido
    // nem falha do diário passam em silêncio: o tempo fica na fila e o motivo
    // aparece no painel.
    const activity = readActivity();
    if (durationMs > 0) {
      if (!record.exerciseId || (record.instrument !== 'guitar' && record.instrument !== 'bass')) {
        journalProblem('O item não tem dono/instrumento válido; o intervalo ficou só na fila.', reason);
      } else if (!activity) {
        journalProblem('Diário de prática compartilhado indisponível; o intervalo ficou só na fila.', reason);
      } else {
        try {
          const stored = typeof activity.append === 'function' ? activity.append(record) : null;
          if (stored) journalWarning = null;
          else journalProblem(activity.warning ?? 'O diário de prática recusou o intervalo; o tempo ficou só na fila.', reason);
        } catch (error) {
          journalProblem(`O diário de prática falhou ao registrar o intervalo (${error?.message ?? error}); o tempo ficou só na fila.`, reason);
        }
      }
    }
    return record;
  }

  function finalizeItem(item, at = now()) {
    if (!item) return null;
    item.finishedAt = new Date(at).toISOString();
    // Só um item realmente iniciado registra BPM final: item nunca praticado
    // não ganha número nenhum.
    if (item.startedAt) item.endBpm = describe(item.exerciseId).bpm ?? item.startBpm;
    item.practiced = item.elapsedMs > 0;
    return item;
  }

  function selectItem(exerciseId, { start = false } = {}) {
    if (typeof openItem !== 'function') return true;
    try { return openItem(exerciseId, { start }) !== false; }
    catch (error) { notify(`Não foi possível abrir o exercício: ${error.message}`, true); return false; }
  }

  function summarize(reason) {
    const items = session.items.map(item => ({
      exerciseId: item.exerciseId,
      name: item.name ?? item.exerciseId,
      instrument: item.instrument,
      elapsedMs: item.elapsedMs,
      plannedMs: itemTargetMs(item),
      bpm: { from: item.startBpm, to: item.endBpm },
      practiced: item.practiced,
    }));
    return {
      finishedAt: new Date(now()).toISOString(),
      reason,
      totalElapsedMs: items.reduce((total, item) => total + item.elapsedMs, 0),
      plannedMs: items.reduce((total, item) => total + item.plannedMs, 0),
      items,
    };
  }

  function complete(reason) {
    if (!session) return null;
    const summary = summarize(reason);
    store.saveSession(null);
    store.saveSummary(summary);
    session = null;
    live = null;
    autoResume = false;
    lastSummary = store.summary() ?? summary;
    lastReason = reason;
    emit('completed', { summary: clone(lastSummary) });
    return clone(lastSummary);
  }

  function snapshot(at = now()) {
    const item = activeItem();
    const activity = readActivity();
    const elapsedMs = item ? item.elapsedMs + liveMs(at) : 0;
    const targetMs = item ? itemTargetMs(item) : 0;
    const items = session ? session.items : [];
    const totalElapsedMs = items.reduce((total, candidate) => (
      total + candidate.elapsedMs + (live && candidate.id === live.itemId ? liveMs(at) : 0)
    ), 0);
    return {
      active: !!session,
      running: !!live,
      suspended: autoResume,
      paused: !!session && !live,
      index: session?.activeIndex ?? -1,
      count: items.length,
      item: clone(item),
      name: item ? label(item) : null,
      elapsedMs,
      targetMs,
      remainingMs: Math.max(0, targetMs - elapsedMs),
      overtimeMs: Math.max(0, elapsedMs - targetMs),
      totalElapsedMs,
      plannedMs: session ? queueTotalMs(items) : 0,
      summary: clone(lastSummary),
      reason: lastReason,
      activityMissing: activity === null,
      journal: {
        present: activity !== null,
        status: activity?.status ?? null,
        warning: activity?.warning ?? null,
        problem: journalWarning,
      },
    };
  }

  function start() {
    if (session) return resume('start');
    const items = store.items();
    if (items.length === 0) {
      notify('Monte a fila de hoje antes de começar.', true);
      return null;
    }
    session = {
      id: uuid(),
      queueId: store.queue()?.id ?? null,
      createdAt: new Date(now()).toISOString(),
      activeIndex: 0,
      announced: [],
      items: items.map(item => {
        const description = describe(item.exerciseId);
        return {
          id: item.id,
          exerciseId: item.exerciseId,
          durationMin: item.durationMin ?? DEFAULT_ITEM_MINUTES,
          // Nome e instrumento são congelados no início: a biblioteca pode
          // mudar depois sem reescrever o que foi praticado.
          name: description.name,
          instrument: description.instrument,
          elapsedMs: 0,
          startBpm: null,
          endBpm: null,
          startedAt: null,
          finishedAt: null,
          practiced: false,
        };
      }),
    };
    persist();
    lastSummary = null;
    emit('session-started', { session: clone(session) });
    skipMissing({ start: true });
    if (!session) return null;
    if (!live) openInterval(now(), 'started');
    emit('item-changed', { index: session.activeIndex });
    return clone(session);
  }

  // Itens cujo exercício saiu da biblioteca não podem ser abertos: são
  // finalizados sem tempo e a sessão segue para o próximo existente. Nunca
  // inventa tempo nem mantém uma fila travada.
  function skipMissing({ start = false } = {}) {
    let guard = session ? session.items.length + 1 : 0;
    while (session && guard-- > 0) {
      const item = activeItem();
      if (!item) break;
      if (selectItem(item.exerciseId, { start })) return true;
      if (live) closeInterval('missing');
      // closeInterval persiste e troca a sessão por um clone: o item precisa
      // ser reobtido, senão o fim gravado se perde na referência velha.
      const current = activeItem();
      if (current) {
        finalizeItem(current);
        current.practiced = false;
      }
      notify(`Exercício “${item.name ?? item.exerciseId}” não está mais na biblioteca; item pulado.`, true);
      if (session.activeIndex + 1 >= session.items.length) { complete('missing'); return false; }
      session.activeIndex += 1;
      persist();
      start = false;
    }
    return false;
  }

  // Dono errado nunca recebe tempo: se o exercício ativo da biblioteca deixou
  // de ser o item da fila, o relógio pausa e retomar reabre o item certo antes
  // de voltar a contar.
  function ownerOf() {
    return typeof getOwner === 'function' ? getOwner() : null;
  }

  function ownerMismatch() {
    const item = activeItem();
    const owner = ownerOf();
    return !!item && owner !== null && owner !== undefined && owner !== item.exerciseId;
  }

  function resume(reason = 'manual') {
    if (!session) return null;
    if (ownerMismatch()) {
      const item = activeItem();
      if (!selectItem(item.exerciseId, { start: false })) {
        notify(`O exercício ativo é outro e “${label(item)}” não pôde ser reaberto; use Próximo para seguir.`, true);
        return null;
      }
    }
    autoResume = false;
    lastReason = reason;
    if (!live) { openInterval(now(), reason); emit('resumed', { reason }); }
    return clone(session);
  }

  function pause(reason = 'manual') {
    if (!session) return null;
    autoResume = false;
    const record = closeInterval(reason);
    lastReason = reason;
    emit('paused', { reason, record: clone(record) });
    return clone(session);
  }

  function suspend(reason = 'hidden') {
    if (!session || !live) return null;
    closeInterval(reason);
    autoResume = true;
    lastReason = reason;
    emit('suspended', { reason });
    return clone(session);
  }

  function wake(reason = 'visible') {
    if (!session || !autoResume || live) return null;
    autoResume = false;
    if (ownerMismatch()) {
      lastReason = 'selection';
      emit('paused', { reason: 'selection' });
      return null;
    }
    lastReason = reason;
    openInterval(now(), reason);
    emit('resumed', { reason });
    return clone(session);
  }

  function next() {
    if (!session) return { completed: false };
    const item = activeItem();
    const executing = typeof isExecuting === 'function' ? isExecuting() : false;
    if (executing && typeof stopExecution === 'function') stopExecution(`Encerrando o treino de “${label(item)}” para passar ao próximo item.`);
    closeInterval('next');
    // closeInterval persiste e troca a sessão por um clone: finalizar a
    // referência antiga perderia horário de fim e BPM final do item.
    finalizeItem(activeItem());
    autoResume = false;
    if (session.activeIndex + 1 >= session.items.length) {
      const summary = complete('queue-end');
      return { completed: true, summary };
    }
    session.activeIndex += 1;
    persist();
    emit('item-changed', { index: session.activeIndex });
    skipMissing();
    if (!session) return { completed: true, summary: clone(lastSummary) };
    if (!live) openInterval(now(), 'next');
    return { completed: false, index: session.activeIndex };
  }

  function finish(reason = 'manual') {
    if (!session) return null;
    const executing = typeof isExecuting === 'function' ? isExecuting() : false;
    if (executing && typeof stopExecution === 'function') stopExecution('Encerrando o treino do item atual.');
    closeInterval(reason);
    finalizeItem(activeItem());
    return complete(reason);
  }

  // Só o relógio de Atribuição é afetado aqui: nenhum áudio é tocado.
  function tick() {
    if (!session) return snapshot();
    const at = now();
    if (live && ownerMismatch()) pause('selection');
    const item = activeItem();
    if (item && live && item.elapsedMs + liveMs(at) >= itemTargetMs(item) && !session.announced.includes(item.id)) {
      session.announced.push(item.id);
      persist();
      // persist troca a sessão por um clone: o evento lê o item reobtido.
      const current = activeItem() ?? item;
      const elapsed = current.elapsedMs + liveMs(at);
      notify(`Tempo do item “${label(current)}” atingido. Nada foi interrompido: use Próximo quando quiser.`);
      emit('target-reached', { item: clone(current), elapsedMs: elapsed });
    }
    emit('tick', { at });
    return snapshot(at);
  }

  // Dono errado nunca recebe tempo: se o exercício ativo da biblioteca deixou
  // de ser o item da fila, o relógio pausa e só Retomar volta.
  function ownerChanged(exerciseId) {
    if (!session || !live) return null;
    const item = activeItem();
    if (!item || exerciseId === item.exerciseId) return null;
    return pause('selection');
  }

  function dismissSummary() {
    lastSummary = null;
    store.saveSummary(null);
    emit('summary-dismissed');
  }

  function destroy() {
    if (live) pause('unload');
    emit('destroyed');
  }

  return {
    store,
    start,
    resume,
    pause,
    suspend,
    wake,
    next,
    finish,
    tick,
    ownerChanged,
    dismissSummary,
    snapshot,
    destroy,
  };
}
