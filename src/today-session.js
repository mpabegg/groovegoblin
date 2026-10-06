// Máquina de estado da sessão de hoje (rodada 4, item 4 — etapa 5; itens de
// aula na etapa 7).
//
// Responsabilidades: manter a fila ativa, contar o tempo praticado de cada item
// de EXERCÍCIO a partir de intervalos FECHADOS, avisar (uma única vez por item)
// quando a meta do item zera — sem nunca trocar de item nem interromper um
// treino em curso —, e encerrar com resumo.
//
// Itens de AULA são diferentes por contrato:
//  - abrem a página da aula na Biblioteca, NUNCA o Treinar;
//  - NÃO ligam relógio sozinhos, NÃO contam para zero e NÃO avisam meta;
//  - o tempo de estudo é opcional e explícito ("Contar tempo"), fecha em
//    intervalo positivo e vai para o contador de aulas do CURSO (recordWatch),
//    nunca para o diário de prática como exercício fantasma;
//  - o resumo mostra ESTUDO, sem BPM inventado.
//
// Regras que o desenho garante por construção:
//  - Nada de "tempo desde a criação da fila": o relógio só corre enquanto o item
//    está ativo e o intervalo é aberto e fechado explicitamente.
//  - Fechar/reabrir volta SEMPRE pausado (a loja não persiste intervalo aberto),
//    então a noite parada nunca é cobrada — nem no exercício, nem na aula.
//  - Cada intervalo fechado vira um registro idempotente (id próprio) para o
//    histórico compartilhado; repetir o fechamento não duplica nada.
//  - Falar em ocioso não interrompe o áudio: só Próximo/Encerrar pedem parada.

import { itemTargetMs, queueTotalMs, DEFAULT_ITEM_MINUTES, ITEM_KIND_LESSON, itemKind } from './today-store.js';

function defaultUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `run-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function createTodaySession({
  store, library = null, getActivity = () => null, notify = () => {},
  now = Date.now, uuid = defaultUuid, openItem = null, openLesson = null,
  lessonExists = null, recordWatch = null,
  getOwner = null, isExecuting = null, stopExecution = null, onEvent = null,
} = {}) {
  if (!store || typeof store.saveSession !== 'function' || typeof store.items !== 'function') {
    throw new TypeError('A sessão de hoje precisa da loja da fila.');
  }
  const readActivity = typeof getActivity === 'function' ? getActivity : () => getActivity;
  // Estado restaurado: se havia sessão salva, ela volta PAUSADA.
  let session = store.session() ?? null;
  let live = null;
  // Cronômetro de ESTUDO da aula: memória pura, nunca persistido aberto.
  let study = null;
  let autoResume = false;
  let lastReason = session ? 'restored' : null;
  let lastSummary = store.summary() ?? null;
  let journalWarning = null;
  let watchWarning = null;
  let watchPending = 0;

  function emit(name, payload = {}) {
    try { onEvent?.(name, payload); } catch { /* Um ouvinte quebrado não derruba a sessão. */ }
  }

  function journalProblem(text, reason) {
    journalWarning = text;
    emit('journal-problem', { reason, warning: text });
  }

  function label(item) {
    return item?.name ?? item?.exerciseId ?? item?.lessonId ?? 'item';
  }

  function activeItem() {
    return session ? session.items[session.activeIndex] ?? null : null;
  }

  function activeKind() {
    const item = activeItem();
    return item ? itemKind(item) : null;
  }

  function isLesson(item = activeItem()) {
    return !!item && itemKind(item) === ITEM_KIND_LESSON;
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

  function studyMs(at = now()) {
    return study ? Math.max(0, at - study.startedAtMs) : 0;
  }

  function openMs(item, at = now()) {
    if (!item) return 0;
    return (live && live.itemId === item.id ? liveMs(at) : 0) + (study && study.itemId === item.id ? studyMs(at) : 0);
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
    if (!item || isLesson(item)) return;
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
    if (item && !isLesson(item) && durationMs > 0) {
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

  // ----- aula: cronômetro de estudo explícito ---------------------------------

  function openStudy(reason = 'manual') {
    if (!session || study) return null;
    const item = activeItem();
    if (!isLesson(item)) return null;
    if (!item.startedAt) item.startedAt = new Date(now()).toISOString();
    study = {
      id: `s-${uuid()}`,
      itemId: item.id,
      courseId: item.courseId,
      lessonId: item.lessonId,
      startedAtMs: now(),
      startedAtIso: new Date(now()).toISOString(),
    };
    lastReason = reason;
    persist();
    emit('study-started', { reason, itemId: item.id });
    return clone(study);
  }

  // Fecha o cronômetro de estudo e entrega SÓ o intervalo FECHADO e positivo ao
  // contador de aulas do curso. Nada vai para o diário de prática; falha do
  // contador é visível e nunca vira rejeição não tratada.
  function closeStudy(reason = 'manual') {
    if (!session || !study) return null;
    const item = session.items.find(candidate => candidate.id === study.itemId) ?? activeItem();
    const endMs = Math.max(study.startedAtMs, now());
    const durationMs = endMs - study.startedAtMs;
    if (item && isLesson(item) && durationMs > 0) {
      item.elapsedMs += durationMs;
      item.practiced = item.elapsedMs > 0;
    }
    const record = {
      id: study.id,
      courseId: study.courseId,
      lessonId: study.lessonId,
      startedAt: study.startedAtIso,
      endedAt: new Date(endMs).toISOString(),
      ms: Math.max(0, durationMs),
    };
    study = null;
    persist();
    emit('study-stopped', { reason, record: clone(record) });
    if (record.ms > 0) flushWatch(record, reason);
    return record;
  }

  function flushWatch(record, reason) {
    if (typeof recordWatch !== 'function') {
      watchWarning = 'O tempo de estudo ficou só na fila: o contador de aulas do curso não está ligado.';
      emit('watch-problem', { reason, warning: watchWarning });
      return;
    }
    watchPending += 1;
    Promise.resolve()
      .then(() => recordWatch(record.courseId, record.lessonId, { startedAt: record.startedAt, endedAt: record.endedAt }))
      .then(stored => {
        watchPending = Math.max(0, watchPending - 1);
        if (stored === null || stored === undefined) {
          watchWarning = 'O contador de aulas do curso não aceitou o intervalo de estudo; o tempo continua na fila.';
          emit('watch-problem', { reason, warning: watchWarning });
        } else {
          watchWarning = null;
        }
      })
      .catch(error => {
        watchPending = Math.max(0, watchPending - 1);
        watchWarning = `O tempo de estudo não pôde ser gravado no curso (${error?.message ?? error}); o tempo continua na fila.`;
        emit('watch-problem', { reason, warning: watchWarning });
      });
  }

  function finalizeItem(item, at = now()) {
    if (!item) return null;
    item.finishedAt = new Date(at).toISOString();
    if (isLesson(item)) {
      // Aula não tem BPM: o que existe é tempo de ESTUDO fechado.
      item.practiced = item.elapsedMs > 0;
      return item;
    }
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

  function lessonPresent(item) {
    if (typeof lessonExists !== 'function') return true;
    try { return lessonExists(item.courseId, item.lessonId) !== false; }
    catch { return true; }
  }

  // Abre o item ativo no destino certo: aula na Biblioteca (página da aula),
  // exercício no Treinar. Devolve false só quando o item não pôde ser aberto.
  function openActive(item, { start = false } = {}) {
    if (!item) return false;
    if (isLesson(item)) {
      if (typeof openLesson !== 'function') return true;
      // `openLesson` pode devolver uma promessa (página da aula); o sucesso é
      // responsabilidade do host, que mostra o motivo. Aqui só conta não abrir
      // por falta de destino.
      try { openLesson(clone(item), { start }); } catch (error) { notify(`Não foi possível abrir a aula: ${error.message}`, true); return false; }
      return true;
    }
    return selectItem(item.exerciseId, { start });
  }

  function summarize(reason) {
    const items = session.items.map(item => ({
      kind: itemKind(item),
      exerciseId: item.exerciseId,
      courseId: item.courseId ?? null,
      lessonId: item.lessonId ?? null,
      name: item.name ?? item.exerciseId ?? item.lessonId,
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
    study = null;
    autoResume = false;
    lastSummary = store.summary() ?? summary;
    lastReason = reason;
    emit('completed', { summary: clone(lastSummary) });
    return clone(lastSummary);
  }

  function snapshot(at = now()) {
    const item = activeItem();
    const activity = readActivity();
    const elapsedMs = item ? item.elapsedMs + openMs(item, at) : 0;
    const targetMs = item ? itemTargetMs(item) : 0;
    const items = session ? session.items : [];
    const totalElapsedMs = items.reduce((total, candidate) => total + candidate.elapsedMs + openMs(candidate, at), 0);
    const kind = item ? itemKind(item) : null;
    return {
      active: !!session,
      kind,
      lesson: kind === ITEM_KIND_LESSON,
      running: !!live || !!study,
      suspended: autoResume,
      paused: !!session && !live && !study,
      index: session?.activeIndex ?? -1,
      count: items.length,
      item: clone(item),
      name: item ? label(item) : null,
      elapsedMs,
      // Estimativa da aula nunca é contagem regressiva: `estimateOnly` avisa a
      // interface para não cobrar zero nem falar em meta.
      estimateOnly: kind === ITEM_KIND_LESSON,
      targetMs,
      remainingMs: kind === ITEM_KIND_LESSON ? 0 : Math.max(0, targetMs - elapsedMs),
      overtimeMs: kind === ITEM_KIND_LESSON ? 0 : Math.max(0, elapsedMs - targetMs),
      studyRunning: !!study,
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
      watch: {
        pending: watchPending,
        warning: watchWarning,
        problem: watchWarning,
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
        const kind = itemKind(item);
        const durationMin = item.durationMin ?? DEFAULT_ITEM_MINUTES;
        if (kind === ITEM_KIND_LESSON) {
          // Item de aula: sem exerciseId inventado e sem BPM de exercício.
          return {
            id: item.id,
            kind,
            exerciseId: null,
            courseId: item.courseId,
            lessonId: item.lessonId,
            durationMin,
            name: item.name ?? item.lessonId,
            instrument: null,
            elapsedMs: 0,
            startBpm: null,
            endBpm: null,
            startedAt: null,
            finishedAt: null,
            practiced: false,
          };
        }
        const description = describe(item.exerciseId);
        return {
          id: item.id,
          kind,
          exerciseId: item.exerciseId,
          courseId: item.courseId ?? null,
          lessonId: item.lessonId ?? null,
          durationMin,
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
    // Aula NÃO liga relógio sozinho: só o exercício abre intervalo de prática.
    const opened = activeItem();
    if (opened && !isLesson(opened) && !live) openInterval(now(), 'started');
    emit('item-changed', { index: session.activeIndex, kind: activeKind() });
    return clone(session);
  }

  // Itens cujo exercício saiu da biblioteca (ou cuja aula saiu do curso) não
  // podem ser abertos: são finalizados sem tempo e a sessão segue para o
  // próximo existente. Nunca inventa tempo nem mantém uma fila travada.
  function skipMissing({ start = false } = {}) {
    let guard = session ? session.items.length + 1 : 0;
    while (session && guard-- > 0) {
      const item = activeItem();
      if (!item) break;
      if (isLesson(item)) {
        if (lessonPresent(item)) {
          // Abre a página da aula (destino da Biblioteca) e NÃO liga relógio.
          openActive(item, { start });
          return true;
        }
        if (study) closeStudy('missing');
        const current = activeItem();
        if (current) { finalizeItem(current); current.practiced = false; }
        notify(`Aula “${label(item)}” não está mais no curso; item pulado.`, true);
        if (session.activeIndex + 1 >= session.items.length) { complete('missing'); return false; }
        session.activeIndex += 1;
        persist();
        start = false;
        continue;
      }
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
  // de voltar a contar. Vale só para item de EXERCÍCIO.
  function ownerOf() {
    return typeof getOwner === 'function' ? getOwner() : null;
  }

  function ownerMismatch() {
    const item = activeItem();
    if (!item || isLesson(item)) return false;
    const owner = ownerOf();
    return owner !== null && owner !== undefined && owner !== item.exerciseId;
  }

  function resume(reason = 'manual') {
    if (!session) return null;
    const item = activeItem();
    if (isLesson(item)) {
      // Retomar uma aula reabre a página e NÃO liga o cronômetro: contar tempo
      // continua sendo um ato explícito.
      autoResume = false;
      const opened = openActive(item, { start: false });
      if (!opened) {
        notify(`A aula “${label(item)}” não pôde ser reaberta.`, true);
        return null;
      }
      lastReason = reason;
      emit('resumed', { reason });
      return clone(session);
    }
    if (ownerMismatch()) {
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
    if (isLesson(activeItem())) {
      const record = closeStudy(reason);
      lastReason = reason;
      emit('paused', { reason, record: clone(record) });
      return clone(session);
    }
    const record = closeInterval(reason);
    lastReason = reason;
    emit('paused', { reason, record: clone(record) });
    return clone(session);
  }

  // "Contar tempo" da aula: só o usuário liga; nada de contagem automática.
  function startStudy(reason = 'manual') {
    if (!session) return null;
    const item = activeItem();
    if (!isLesson(item)) return null;
    autoResume = false;
    openStudy(reason);
    emit('resumed', { reason, study: true });
    return clone(session);
  }

  function stopStudy(reason = 'manual') {
    if (!session) return null;
    if (!study) return clone(session);
    autoResume = false;
    closeStudy(reason);
    lastReason = reason;
    emit('paused', { reason, study: true });
    return clone(session);
  }

  function suspend(reason = 'hidden') {
    if (!session) return null;
    if (isLesson(activeItem())) {
      if (!study) return null;
      closeStudy(reason);
      lastReason = reason;
      emit('suspended', { reason });
      return clone(session);
    }
    if (!live) return null;
    closeInterval(reason);
    autoResume = true;
    lastReason = reason;
    emit('suspended', { reason });
    return clone(session);
  }

  function wake(reason = 'visible') {
    if (!session || live || study) return null;
    if (isLesson(activeItem())) return null;
    if (!autoResume) return null;
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

  function advance() {
    if (session.activeIndex + 1 >= session.items.length) {
      const summary = complete('queue-end');
      return { completed: true, summary };
    }
    session.activeIndex += 1;
    persist();
    emit('item-changed', { index: session.activeIndex, kind: activeKind() });
    skipMissing();
    if (!session) return { completed: true, summary: clone(lastSummary) };
    const item = activeItem();
    // Item de aula abre a página da aula sem ligar relógio; exercício abre o
    // intervalo de prática como sempre.
    if (!live && !study && item && !isLesson(item)) openInterval(now(), 'next');
    return { completed: false, index: session.activeIndex };
  }

  function next() {
    if (!session) return { completed: false };
    const item = activeItem();
    const executing = typeof isExecuting === 'function' ? isExecuting() : false;
    if (executing && typeof stopExecution === 'function') stopExecution(`Encerrando o treino de “${label(item)}” para passar ao próximo item.`);
    if (isLesson(item)) closeStudy('next');
    else closeInterval('next');
    // closeInterval/closeStudy persistem e trocam a sessão por um clone:
    // finalizar a referência antiga perderia horário de fim e BPM final.
    finalizeItem(activeItem());
    autoResume = false;
    return advance();
  }

  function finish(reason = 'manual') {
    if (!session) return null;
    const executing = typeof isExecuting === 'function' ? isExecuting() : false;
    if (executing && typeof stopExecution === 'function') stopExecution('Encerrando o treino do item atual.');
    if (isLesson(activeItem())) closeStudy(reason);
    else closeInterval(reason);
    finalizeItem(activeItem());
    return complete(reason);
  }

  // Só o relógio de Atribuição é afetado aqui: nenhum áudio é tocado. Item de
  // aula NUNCA conta para zero nem avisa meta.
  function tick() {
    if (!session) return snapshot();
    const at = now();
    const item = activeItem();
    if (item && !isLesson(item)) {
      if (live && ownerMismatch()) pause('selection');
      if (item && live && item.elapsedMs + liveMs(at) >= itemTargetMs(item) && !session.announced.includes(item.id)) {
        session.announced.push(item.id);
        persist();
        // persist troca a sessão por um clone: o evento lê o item reobtido.
        const current = activeItem() ?? item;
        const elapsed = current.elapsedMs + liveMs(at);
        notify(`Tempo do item “${label(current)}” atingido. Nada foi interrompido: use Próximo quando quiser.`);
        emit('target-reached', { item: clone(current), elapsedMs: elapsed });
      }
    }
    emit('tick', { at });
    return snapshot(at);
  }

  // Dono errado nunca recebe tempo: se o exercício ativo da biblioteca deixou
  // de ser o item da fila, o relógio pausa e só Retomar volta.
  function ownerChanged(exerciseId) {
    if (!session || !live) return null;
    const item = activeItem();
    if (!item || isLesson(item) || exerciseId === item.exerciseId) return null;
    return pause('selection');
  }

  function dismissSummary() {
    lastSummary = null;
    store.saveSummary(null);
    emit('summary-dismissed');
  }

  function destroy() {
    if (live) pause('unload');
    if (study) stopStudy('unload');
    emit('destroyed');
  }

  return {
    store,
    start,
    resume,
    pause,
    startStudy,
    stopStudy,
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
