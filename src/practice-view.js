// Percurso (aba de progresso) do GrooveGoblin — rodada 4, item 5.
//
// O Percurso agora é um PANORAMA do tempo realmente praticado: tempo por dia
// local (últimos 28 dias), tempo por instrumento e os exercícios que mais
// avançaram. O tempo vem dos intervalos FECHADOS do treinador/fila de Hoje
// (host.activity) somados aos treinos avaliados registrados na biblioteca —
// com UNIÃO de intervalos sobrepostos, porque o mesmo treino aparece nas duas
// fontes. Dias são locais (DST incluído) e nada presume dia de 24 h.
//
// Os registros antigos de groovegoblin.practice.v1 (prática guiada e jogos de
// ouvido) continuam aqui, em “Anteriores”: leitura, exportação, importação,
// exclusão individual e limpeza total seguem disponíveis. Eles não têm
// exerciseId nem intervalo, então NUNCA são chutados para um exercício nem
// entram nos totais de tempo (nenhuma duração é inventada).
//
// A gravação de novas execuções é responsabilidade do treinador/biblioteca; o
// Percurso apenas renderiza (mountJourney retorna {render, destroy}).

import {
  createEl,
  formatDatePt,
  formatDaysFromNow,
  safeStorage,
  loadPracticeState,
  savePracticeState,
  practiceTotals,
  objectiveProgress,
  reviewQueue,
  importRuns,
  deleteRun,
  clearHistory,
  deleteObjectiveData,
  OBJECTIVES,
  PRACTICE_STORAGE_KEY,
  renderKeepingFocus,
} from './practice.js';
import {
  WINDOW_DAYS,
  buildIntervals,
  dailyTotals,
  instrumentTotals,
  recordIntervals,
  sourceCounts,
} from './history-time.js';
import { formatDuration, progressRanking } from './exercise-history.js';
import { dailyBars } from './history-charts.js';

function requireHost(host) {
  if (!host || typeof host !== 'object') throw new TypeError('O percurso requer um host do estúdio.');
  if (typeof host.notify !== 'function') throw new TypeError('O host do percurso precisa do método notify.');
}

function downloadText(name, text, type = 'application/json') {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return false;
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = createEl('a', { href: url, download: name });
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

const EAR_GAME_NAMES = {
  'ear-interval': 'Intervalos',
  'ear-chord': 'Função do acorde',
  'ear-rhythm': 'Reconhecimento de ritmo',
};

function scoreBars(values) {
  const wrap = createEl('div', { className: 'journey-bars', role: 'img', 'aria-label': 'Últimos aproveitamentos' });
  if (values.length === 0) {
    wrap.appendChild(createEl('span', { className: 'journey-bar journey-bar-empty', text: 'sem execuções' }));
    return wrap;
  }
  for (const value of values) {
    const bar = createEl('span', { className: 'journey-bar', title: `${value}%` });
    bar.style.height = `${Math.max(4, Math.round(value))}%`;
    wrap.appendChild(bar);
  }
  return wrap;
}

function bpmJourneyChart(values) {
  const wrap = createEl('div', { className: 'journey-bpm', role: 'img', 'aria-label': 'Percurso de tempo (bpm por execução)' });
  if (values.length === 0) {
    wrap.appendChild(createEl('p', { className: 'practice-hint', text: 'Sem execuções avaliadas ainda para desenhar o percurso de tempo.' }));
    return wrap;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  for (const bpm of values) {
    const bar = createEl('span', { className: 'journey-bpm-bar', title: `${bpm} bpm` });
    const height = max === min ? 100 : 12 + Math.round(((bpm - min) / (max - min)) * 88);
    bar.style.height = `${height}%`;
    wrap.appendChild(bar);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Dados do panorama (puro: sem DOM, para teste determinístico)
// ---------------------------------------------------------------------------

function activityList(activity) {
  if (!activity || typeof activity.list !== 'function') return [];
  try {
    const listed = activity.list();
    return Array.isArray(listed) ? listed : [];
  } catch {
    return [];
  }
}

function instrumentResolver(library) {
  return ownerId => {
    if (!library || typeof library.get !== 'function' || typeof ownerId !== 'string') return null;
    const entry = library.get(ownerId);
    const type = entry?.session?.extensions?.studio?.instrument?.type;
    return type === 'bass' ? 'bass' : type === 'guitar' ? 'guitar' : null;
  };
}

// Panorama numérico do Percurso: intervalos combinados (biblioteca + activity),
// unidos, cortados em dias locais e agrupados por instrumento, mais o ranking
// de progresso do material autoral. `now` é injetável para o teste de janela.
export function journeyOverview({ library = null, activity = null, now = Date.now(), days = WINDOW_DAYS } = {}) {
  const records = recordIntervals(library);
  const intervals = buildIntervals({
    records,
    activity: activityList(activity),
    resolveInstrument: instrumentResolver(library),
  });
  const window = dailyTotals(intervals, { days, now });
  const instruments = instrumentTotals(intervals, { from: window.windowStart, to: window.windowEnd });
  const entries = library && typeof library.list === 'function' ? library.list() : [];
  const ranking = [];
  for (const row of entries) {
    const entry = typeof library.get === 'function' ? library.get(row.id) : null;
    if (entry) ranking.push(entry);
  }
  return {
    days: window,
    instruments,
    sources: sourceCounts(intervals),
    intervals: intervals.length,
    recordsWithInterval: intervals.filter(interval => interval.source === 'record').length,
    ranking: progressRanking(ranking, { limit: 8 }),
    exercises: entries.length,
  };
}

// Payload do histórico completo legado: preserva TODOS os campos de cada
// registro, na ordem, sem reescrever nada do que está guardado.
export function legacyExportPayload(state, now = () => new Date().toISOString()) {
  return {
    version: 1,
    kind: 'groovegoblin.practice-history',
    exportedAt: now(),
    objective: state?.objective ?? null,
    history: (state?.history ?? []).map(entry => ({ ...entry })),
  };
}

export function legacyEntryExportPayload(entry) {
  return { version: 1, kind: 'groovegoblin.practice-history-entry', entry: { ...entry } };
}

export function legacyHistoryEntries(state) {
  return [...(state?.history ?? [])].reverse();
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

export function mountJourney(container, host, options = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para o percurso.');
  requireHost(host);
  const storage = options.storage ?? safeStorage();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let confirmClearArmed = false;
  let confirmClearTimer = null;
  let subscribedActivity = null;
  let unsubscribeActivity = null;

  const root = createEl('section', { className: 'journey-root', 'aria-label': 'Percurso de prática' });

  function load() {
    return loadPracticeState(storage);
  }

  function syncActivitySubscription() {
    const activity = host.activity ?? null;
    if (activity === subscribedActivity) return;
    unsubscribeActivity?.();
    subscribedActivity = activity;
    unsubscribeActivity = activity && typeof activity.subscribe === 'function' ? activity.subscribe(() => render()) : null;
  }

  function render() {
    syncActivitySubscription();
    const info = load();
    if (!container.contains(root)) container.appendChild(root);
    renderKeepingFocus(root, () => {
      root.replaceChildren();
      root.appendChild(renderOverview(loadOverview()));
      root.appendChild(renderLegacy(info));
      root.appendChild(renderDataControls(info.state));
    });
    return api;
  }

  function loadOverview() {
    const library = host.library ?? null;
    if (!library || typeof library.list !== 'function') {
      return { libraryMissing: true };
    }
    return journeyOverview({ library, activity: host.activity ?? null, now: now(), days: WINDOW_DAYS });
  }

  function renderOverview(overview) {
    const section = createEl('section', { className: 'journey-section journey-overview', 'aria-labelledby': 'journey-overview-title' });
    section.appendChild(createEl('h3', { id: 'journey-overview-title', text: 'Panorama dos últimos 28 dias' }));
    if (overview.libraryMissing) {
      section.appendChild(createEl('p', { className: 'practice-hint', text: 'A biblioteca de exercícios ainda não está disponível; abra um exercício para registrar o tempo praticado.' }));
      return section;
    }
    const { days, instruments, sources } = overview;
    const practicedLabel = days.practicedDays === 1 ? '1 dia com prática' : `${days.practicedDays} dias com prática`;
    const average = days.practicedDays > 0 ? Math.round(days.totalMs / days.practicedDays) : 0;
    section.appendChild(createEl('ul', { className: 'journey-summary' }, [
      summaryRow('Tempo praticado (28 dias)', formatDuration(days.totalMs) ?? '0 s'),
      summaryRow('Dias com prática', practicedLabel),
      summaryRow('Média por dia praticado', average > 0 ? formatDuration(average) : '—'),
      summaryRow('Treinos avaliados com intervalo', String(overview.recordsWithInterval)),
      summaryRow('Blocos da fila de Hoje', String(sources.today)),
      summaryRow('Blocos do treinador', String(sources.trainer)),
    ]));
    const ariaLabel = `Tempo praticado por dia nos últimos ${days.days} dias: ${formatDuration(days.totalMs) ?? 'nenhum tempo'}, em ${practicedLabel}.`;
    section.appendChild(dailyBars({ rows: days.byDay, ariaLabel }));
    section.appendChild(createEl('p', {
      className: 'practice-hint',
      text: overview.intervals === 0
        ? 'Sem intervalos de prática nesta sessão: os totais usam os treinos avaliados registrados na biblioteca, e intervalos do treinador/fila aparecem quando existirem.'
        : 'Intervalos sobrepostos (treinador, fila de Hoje e treino avaliado do mesmo treino) contam UMA vez só. Registros antigos sem intervalo não entram nestes totais: eles ficam em “Anteriores”.',
    }));
    const activityBox = renderActivityState();
    if (activityBox) section.appendChild(activityBox);

    const instrumentSection = createEl('section', { className: 'journey-section', 'aria-labelledby': 'journey-instrument-title' });
    instrumentSection.appendChild(createEl('h3', { id: 'journey-instrument-title', text: 'Tempo por instrumento (28 dias)' }));
    const instrumentRows = [
      ['Guitarra', instruments.guitar, 'guitar'],
      ['Baixo', instruments.bass, 'bass'],
    ];
    const maxInstrument = Math.max(1, instruments.guitar.ms, instruments.bass.ms, instruments.unknown.ms);
    const list = createEl('ul', { className: 'journey-instruments' });
    for (const [label, data, key] of instrumentRows) {
      list.appendChild(instrumentRow(label, data.ms, maxInstrument, key));
    }
    instrumentSection.appendChild(list);
    if (instruments.unknown.ms > 0) {
      instrumentSection.appendChild(createEl('p', { className: 'practice-hint', text: `Sem instrumento identificado: ${formatDuration(instruments.unknown.ms)} — exercício removido da biblioteca ou bloco sem instrumento. Nada é atribuído por chute.` }));
    }
    instrumentSection.appendChild(createEl('p', { className: 'practice-hint', text: 'Cada categoria une os próprios intervalos antes de somar; um bloco sem instrumento identificado nunca é contado como guitarra nem como baixo.' }));

    const rankingSection = createEl('section', { className: 'journey-section', 'aria-labelledby': 'journey-ranking-title' });
    rankingSection.appendChild(createEl('h3', { id: 'journey-ranking-title', text: 'Exercícios que mais avançaram' }));
    if (overview.ranking.length === 0) {
      rankingSection.appendChild(createEl('p', { className: 'practice-hint', text: 'Nenhum treino avaliado com material autoral ainda. Conclua um treino do exercício para ver o avanço em direção ao alvo.' }));
    } else {
      const ordered = createEl('ol', { className: 'journey-ranking' });
      for (const row of overview.ranking) {
        const item = createEl('li', { className: 'journey-ranking-item' });
        const percent = Math.round((row.progress ?? 0) * 100);
        item.append(
          createEl('span', { className: 'journey-ranking-name', text: row.name }),
          createEl('span', { className: 'journey-ranking-detail', text: [
            `alvo ${row.targetBPM ?? '—'} BPM`,
            row.bestBpm === null ? 'sem aprovação ≥80%' : `melhor autoral ${row.bestBpm} BPM`,
            row.bpmGain === null ? null : `${row.bpmGain >= 0 ? '+' : ''}${row.bpmGain} BPM desde o 1º`,
            `${percent}% do alvo`,
            `${row.attempts} treino(s) autoral(is)`,
          ].filter(Boolean).join(' · ') }),
          createEl('span', { className: 'journey-ranking-bar', role: 'img', 'aria-label': `${percent}% do alvo` }, [createEl('span', { style: `width: ${percent}%` })]),
        );
        if (typeof host.openExerciseHistory === 'function') {
          const open = createEl('button', { type: 'button', text: 'Histórico' });
          open.addEventListener('click', () => host.openExerciseHistory(row.id));
          item.appendChild(open);
        }
        ordered.appendChild(item);
      }
      rankingSection.appendChild(ordered);
      rankingSection.appendChild(createEl('p', { className: 'practice-hint', text: 'O avanço usa SOMENTE execuções do material autoral: um desempenho de material gerado nunca faz o exercício subir de BPM nem atingir o alvo.' }));
    }
    section.appendChild(instrumentSection);
    section.appendChild(rankingSection);
    return section;
  }

  // Estado da loja de intervalos (dona: R4Trainer). Nunca limpamos nem
  // sobrescrevemos bytes corrompidos daqui: só mostramos o aviso e oferecemos o
  // download do original, para que a recuperação continue possível.
  function renderActivityState() {
    const activity = host.activity ?? null;
    if (!activity) return null;
    let warning = null;
    let status = null;
    let recoveryRaw = null;
    try {
      warning = typeof activity.warning === 'string' && activity.warning.length > 0 ? activity.warning : null;
      status = typeof activity.status === 'string' ? activity.status : null;
      recoveryRaw = typeof activity.recoveryRaw === 'string' ? activity.recoveryRaw : null;
    } catch { return null; }
    if (!warning && recoveryRaw === null && status !== 'corrupt') return null;
    const box = createEl('div', { className: 'practice-warnings journey-activity-state', role: 'status' });
    if (warning) box.appendChild(createEl('p', { text: warning }));
    if (recoveryRaw !== null) {
      box.appendChild(createEl('p', { className: 'practice-hint', text: 'Os intervalos originais ficam preservados; baixe-os antes de qualquer recuperação manual.' }));
      const download = createEl('button', { type: 'button', text: 'Baixar intervalos corrompidos (.json)' });
      download.addEventListener('click', () => {
        if (!downloadText('groovegoblin-intervalos-corrompidos.json', recoveryRaw)) {
          host.notify('Download indisponível neste ambiente; os bytes originais continuam guardados.', true);
        }
      });
      box.appendChild(download);
    }
    return box;
  }

  function instrumentRow(label, ms, max, key) {
    const percent = ms > 0 ? Math.max(2, Math.round((ms / max) * 100)) : 0;
    const row = createEl('li', { className: `journey-instrument journey-instrument-${key}` });
    row.append(
      createEl('span', { className: 'journey-instrument-label', text: label }),
      createEl('span', { className: 'journey-instrument-bar', role: 'img', 'aria-label': `${label}: ${formatDuration(ms) ?? 'nenhum tempo'}` }, [createEl('span', { style: `width: ${percent}%` })]),
      createEl('span', { className: 'journey-instrument-value', text: formatDuration(ms) ?? 'nenhum tempo' }),
    );
    return row;
  }

  function summaryRow(label, value) {
    return createEl('li', {}, [
      createEl('span', { className: 'journey-summary-label', text: label }),
      createEl('span', { className: 'journey-summary-value', text: value }),
    ]);
  }

  // -------------------------------------------------------------------------
  // Anteriores (legado preservado: leitura, exportação, exclusão)
  // -------------------------------------------------------------------------

  function renderLegacy(info) {
    const wrapper = createEl('div', { className: 'journey-legacy' });
    const section = createEl('section', { className: 'journey-section', 'aria-labelledby': 'journey-legacy-title' });
    section.appendChild(createEl('h3', { id: 'journey-legacy-title', text: 'Anteriores · prática guiada e jogos de ouvido' }));
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'Registros guardados em groovegoblin.practice.v1 continuam legíveis e exportáveis. Eles não têm vínculo com um exercício da biblioteca nem intervalo de tempo real, então aparecem AQUI e nunca são atribuídos a um exercício nem somados aos 28 dias.' }));
    wrapper.appendChild(section);
    if (info.warnings.length > 0) wrapper.appendChild(renderWarnings(info));
    const state = info.state;
    section.appendChild(renderLegacySummary(state));
    section.appendChild(renderObjectives(state));
    section.appendChild(renderTempoJourney(state));
    section.appendChild(renderEarStats(state));
    section.appendChild(renderHistory(state));
    return wrapper;
  }

  function renderWarnings(info) {
    const box = createEl('div', { className: 'practice-warnings journey-section', role: 'status' });
    for (const warning of info.warnings) box.appendChild(createEl('p', { text: warning }));
    if (info.recoveryRaw !== null) {
      const recover = createEl('button', { type: 'button', text: 'Baixar dados brutos corrompidos (.json)' });
      recover.addEventListener('click', () => {
        if (!downloadText('groovegoblin-pratica-corrompida.json', info.recoveryRaw)) {
          host.notify('Download indisponível neste ambiente; os dados antigos continuam guardados sem serem apagados.', true);
        }
      });
      box.appendChild(recover);
      const reset = createEl('button', { type: 'button', text: 'Apagar todos os dados de prática e recuperação' });
      let armed = false;
      reset.addEventListener('click', () => {
        if (!armed) { armed = true; reset.textContent = 'Confirmar: apagar prática, revisões e dados brutos'; return; }
        try {
          storage.removeItem(PRACTICE_STORAGE_KEY);
          storage.removeItem(`${PRACTICE_STORAGE_KEY}.recovery`);
          host.notify('Todos os dados de prática e recuperação foram apagados por sua escolha.');
          render();
        } catch (error) { host.notify(`Não foi possível apagar os dados: ${error.message}`, true); }
      });
      box.appendChild(reset);
    }
    return box;
  }

  function renderLegacySummary(state) {
    const totals = practiceTotals(state);
    const section = createEl('section', { className: 'journey-subsection', 'aria-labelledby': 'journey-summary-title' });
    section.appendChild(createEl('h4', { id: 'journey-summary-title', text: 'Resumo dos registros anteriores' }));
    const list = createEl('ul', { className: 'journey-summary' });
    const minutes = Math.round(totals.totalSeconds / 60);
    const entries = [
      ['Execuções registradas', String(totals.runs)],
      ['Treinos avaliados', String(totals.attemptRuns)],
      ['Improvisações (escolhas criativas)', String(totals.creativeRuns)],
      ['Perguntas de ouvido', `${totals.earCorrect} de ${totals.earQuestions} certas`],
      ['Tempo total tocado (duração gravada, sem intervalo)', minutes > 0 ? `${minutes} min` : `${totals.totalSeconds} s`],
      ['Primeiro/último bpm avaliado', totals.firstBpm === null ? '—' : `${totals.firstBpm} → ${totals.lastBpm} bpm`],
      ['Maior bpm avaliado', totals.bestBpm > 0 ? `${totals.bestBpm} bpm` : '—'],
    ];
    for (const [label, value] of entries) list.appendChild(summaryRow(label, value));
    section.appendChild(list);
    return section;
  }

  function renderObjectives(state) {
    const section = createEl('section', { className: 'journey-subsection', 'aria-labelledby': 'journey-objectives-title' });
    section.appendChild(createEl('h4', { id: 'journey-objectives-title', text: 'Progresso por objetivo (prática guiada anterior)' }));
    const queue = reviewQueue(state.skills);
    const list = createEl('ul', { className: 'journey-objectives' });
    for (const objective of OBJECTIVES) {
      const progress = objectiveProgress(state, objective.id);
      const dueText = progress.skill ? formatDaysFromNow(progress.skill.dueAt) : 'sem dados ainda';
      const item = createEl('li', { className: 'journey-objective' });
      item.appendChild(createEl('h5', { text: objective.name }));
      item.appendChild(createEl('p', { className: 'practice-hint', text: objective.focus }));
      const meta = createEl('ul', { className: 'journey-objective-meta' });
      meta.appendChild(createEl('li', { text: `Execuções: ${progress.runs}` }));
      meta.appendChild(createEl('li', { text: `Melhor aproveitamento: ${progress.bestScore}%` }));
      meta.appendChild(createEl('li', { text: `Nível do exercício: ${progress.level + 1} de 3` }));
      meta.appendChild(createEl('li', { text: `Próxima revisão: ${dueText}` }));
      item.appendChild(meta);
      item.appendChild(scoreBars(progress.recentScores));
      list.appendChild(item);
    }
    section.appendChild(list);
    const nextDue = queue.filter(entry => entry.due).map(entry => entry.objective.name);
    section.appendChild(createEl('p', {
      className: 'practice-hint',
      text: nextDue.length > 0
        ? `Revisão em dia de: ${nextDue.join(', ')}. A revisão espaçada dobra o intervalo quando vai bem e volta a 1 dia quando vai mal — sem punição, só ritmo de estudo.`
        : 'Nenhuma revisão vencida: a revisão espaçada agenda os próximos retornos conforme seu desempenho.',
    }));
    return section;
  }

  function renderTempoJourney(state) {
    const section = createEl('section', { className: 'journey-subsection', 'aria-labelledby': 'journey-tempo-title' });
    section.appendChild(createEl('h4', { id: 'journey-tempo-title', text: 'Percurso de tempo dos registros anteriores' }));
    const runs = state.history.filter(entry => entry.kind === 'attempt');
    if (runs.length === 0) {
      section.appendChild(createEl('p', { className: 'practice-hint', text: 'Sem treinos avaliados no histórico antigo.' }));
      return section;
    }
    section.appendChild(bpmJourneyChart(runs.map(entry => entry.bpm)));
    section.appendChild(createEl('p', { className: 'practice-hint', text: `Cada barra é um treino antigo (${runs[0].bpm} bpm no primeiro, ${runs[runs.length - 1].bpm} bpm no último).` }));
    return section;
  }

  function renderEarStats(state) {
    const section = createEl('section', { className: 'journey-subsection', 'aria-labelledby': 'journey-ear-title' });
    section.appendChild(createEl('h4', { id: 'journey-ear-title', text: 'Ouvido' }));
    const earRuns = state.history.filter(entry => entry.kind === 'ear');
    if (earRuns.length === 0) {
      section.appendChild(createEl('p', { className: 'practice-hint', text: 'Os jogos de ouvido ficam em Explorar; as respostas registradas aparecem aqui.' }));
      return section;
    }
    const list = createEl('ul', { className: 'journey-summary' });
    for (const [gameId, name] of Object.entries(EAR_GAME_NAMES)) {
      const gameRuns = earRuns.filter(entry => entry.objective === gameId);
      const correct = gameRuns.filter(entry => entry.metrics.correct === 1).length;
      list.appendChild(summaryRow(name, gameRuns.length === 0 ? '—' : `${correct} de ${gameRuns.length} certas`));
    }
    section.appendChild(list);
    return section;
  }

  function renderHistory(state) {
    const section = createEl('section', { className: 'journey-subsection', 'aria-labelledby': 'journey-history-title' });
    section.appendChild(createEl('h4', { id: 'journey-history-title', text: 'Histórico completo anterior' }));
    if (state.history.length === 0) {
      section.appendChild(createEl('p', { className: 'practice-hint', text: 'Nada registrado em prática.v1: o histórico daqui para frente é por exercício, na Biblioteca.' }));
      return section;
    }
    const list = createEl('ul', { className: 'journey-history' });
    for (const entry of legacyHistoryEntries(state)) {
      const objectiveName = OBJECTIVES.find(o => o.id === entry.objective)?.name ?? EAR_GAME_NAMES[entry.objective] ?? entry.objective;
      const kindLabel = entry.kind === 'attempt' ? 'treino' : entry.kind === 'ear' ? 'ouvido' : 'improvisação';
      const summary = entry.kind === 'attempt'
        ? `${entry.metrics.matched}/${entry.metrics.expected} notas · ${entry.metrics.objectiveScore}% do objetivo · ${entry.bpm} bpm${entry.tempoDelta !== 0 ? ` · tempo ${entry.tempoDelta > 0 ? '+' : ''}${entry.tempoDelta}` : ''}`
        : entry.kind === 'ear'
          ? `${entry.metrics.correct === 1 ? 'acertou' : 'errou'}`
          : 'escolha criativa, sem avaliação';
      const item = createEl('li', { className: 'journey-history-item' });
      item.appendChild(createEl('span', { className: 'practice-history-at', text: `${formatDatePt(entry.at)} · ${kindLabel} · ${objectiveName}` }));
      item.appendChild(createEl('span', { className: 'practice-history-summary', text: `${entry.stage} — ${summary}` }));
      const controls = createEl('div', { className: 'practice-inline-controls' });
      const exportOne = createEl('button', { type: 'button', text: 'Exportar (.json)' });
      exportOne.addEventListener('click', () => {
        if (!downloadText(`groovegoblin-registro-${entry.id}.json`, JSON.stringify(legacyEntryExportPayload(entry), null, 2))) {
          host.notify('Download indisponível neste ambiente.', true);
        }
      });
      controls.appendChild(exportOne);
      const deleteOne = createEl('button', { type: 'button', text: 'Apagar' });
      deleteOne.addEventListener('click', () => {
        deleteRun(state, entry.id);
        if (!savePracticeState(state, storage)) { host.notify('Não foi possível salvar a exclusão.', true); return; }
        host.notify('Registro apagado do histórico local.');
        render();
      });
      controls.appendChild(deleteOne);
      item.appendChild(controls);
      list.appendChild(item);
    }
    section.appendChild(list);
    return section;
  }

  function renderDataControls(state) {
    const section = createEl('section', { className: 'journey-section', 'aria-labelledby': 'journey-data-title' });
    section.appendChild(createEl('h3', { id: 'journey-data-title', text: 'Dados anteriores' }));
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'Estes controles transferem ou limpam os registros anteriores da prática guiada e dos jogos de ouvido. Entradas inválidas são ignoradas com aviso, sem corromper o que já está salvo. Os exercícios e seus novos registros são exportados pela Biblioteca; a limpeza do histórico novo é por exercício, no Histórico do item.' }));
    const controls = createEl('div', { className: 'practice-inline-controls' });
    const exportAll = createEl('button', { type: 'button', className: 'practice-primary', text: 'Exportar registros anteriores (.json)' });
    exportAll.addEventListener('click', () => {
      if (!downloadText('groovegoblin-percurso.json', JSON.stringify(legacyExportPayload(state), null, 2))) {
        host.notify('Download indisponível neste ambiente.', true);
      }
    });
    controls.appendChild(exportAll);

    const importInput = createEl('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Importar registros do percurso (.json)' });
    importInput.addEventListener('change', async () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return;
      let parsed = null;
      try {
        parsed = JSON.parse(await file.text());
      } catch (error) {
        host.notify(`Arquivo inválido (${error.message}): nada foi importado.`, true);
        importInput.value = '';
        return;
      }
      if (!Array.isArray(parsed) && parsed?.version !== undefined && parsed.version !== 1) {
        host.notify('Versão do histórico não suportada: nada foi importado.', true);
        importInput.value = '';
        return;
      }
      const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.history) ? parsed.history : parsed?.kind === 'groovegoblin.practice-history-entry' && parsed.entry ? [parsed.entry] : null;
      if (entries === null) {
        host.notify('Arquivo sem lista de registros (esperado array ou {history: [...]}): nada foi importado.', true);
        importInput.value = '';
        return;
      }
      const fresh = load();
      const result = importRuns(fresh.state, entries);
      if (result.added > 0 && !savePracticeState(fresh.state, storage)) {
        host.notify('Não foi possível salvar os registros importados.', true);
        return;
      }
      host.notify(`Importação: ${result.added} registro(s) adicionado(s), ${result.duplicates} duplicado(s) ignorado(s), ${result.skipped} inválido(s) ignorado(s).${result.warnings.length > 0 ? ' Detalhes: ' + result.warnings.slice(0, 3).join(' ') : ''}`);
      importInput.value = '';
      render();
    });
    controls.appendChild(importInput);

    const objectiveSelect = createEl('select', { 'aria-label': 'Objetivo para apagar dados' });
    for (const objective of OBJECTIVES) {
      objectiveSelect.appendChild(createEl('option', { value: objective.id, text: objective.name }));
    }
    const deleteObjective = createEl('button', { type: 'button', text: 'Apagar dados deste objetivo' });
    deleteObjective.addEventListener('click', () => {
      const fresh = load();
      const result = deleteObjectiveData(fresh.state, objectiveSelect.value);
      if (!savePracticeState(fresh.state, storage)) { host.notify('Não foi possível salvar a exclusão.', true); return; }
      host.notify(`Dados de "${objectiveSelect.selectedOptions[0]?.textContent ?? objectiveSelect.value}" apagados: ${result.historyRemoved} registro(s)${result.skillRemoved ? ' e revisão espaçada' : ''}.`);
      render();
    });
    controls.appendChild(createEl('label', {}, [objectiveSelect, deleteObjective]));

    const clearAll = createEl('button', { type: 'button', className: confirmClearArmed ? 'practice-danger' : '', text: confirmClearArmed ? 'Confirmar: apagar TUDO' : 'Apagar todo o histórico anterior' });
    clearAll.addEventListener('click', () => {
      if (!confirmClearArmed) {
        confirmClearArmed = true;
        clearAll.textContent = 'Confirmar: apagar TUDO';
        clearAll.className = 'practice-danger';
        clearTimeout(confirmClearTimer);
        confirmClearTimer = setTimeout(() => {
          confirmClearArmed = false;
          render();
        }, 5000);
        return;
      }
      clearTimeout(confirmClearTimer);
      confirmClearArmed = false;
      const fresh = load();
      const removed = clearHistory(fresh.state);
      if (!savePracticeState(fresh.state, storage)) { host.notify('Não foi possível salvar a exclusão.', true); return; }
      host.notify(`Histórico anterior apagado: ${removed} registro(s) removidos. As revisões espaçadas dos objetivos foram mantidas.`);
      render();
    });
    controls.appendChild(clearAll);
    section.appendChild(controls);
    section.appendChild(createEl('p', { className: 'practice-hint', text: `Chave de armazenamento: ${PRACTICE_STORAGE_KEY}` }));
    return section;
  }

  function destroy() {
    clearTimeout(confirmClearTimer);
    unsubscribeActivity?.();
    unsubscribeLibrary?.();
    root.remove();
  }

  const unsubscribeLibrary = host.library && typeof host.library.subscribe === 'function' ? host.library.subscribe(() => render()) : null;
  const api = { render, destroy };
  return api;
}
