// Histórico por exercício (rodada 4, item 5).
//
// Aberto a partir do item da biblioteca, mostra o andamento REAL registrado no
// exercício: BPM por treino com a linha do alvo, aproveitamento por treino e a
// lista de treinos legível (data, modo, fonte, BPM, aproveitamento, duração).
//
// Fonte e material são separados em TODA estatística: uma execução de material
// GERADO nunca avança o melhor resultado do exercício AUTORAL — a comparação e
// o alvo continuam sendo do material autoral (mesma chave de material da
// biblioteca). Duração desconhecida (registro sem intervalo válido) é exibida
// como desconhecida; nunca é inventada.
//
// O módulo só lê a biblioteca. Limpeza de histórico passa por um caminho
// explícito do host (clearRecords) que preserva exercício e metadados.

import { createEl, formatDatePt, renderKeepingFocus } from './practice.js';
import { materialKey, referenceFingerprint, summarize } from './exercise-library.js';
import { parseInstant } from './history-time.js';
import { accuracyChart, bpmChart } from './history-charts.js';

const PASS_RATIO = 0.8;

const MODE_LABELS = Object.freeze({
  train: 'Avaliado',
  free: 'Modo livre',
  listen: 'Ouvindo',
  together: 'Tocar junto',
  routine: 'Rotina',
  practice: 'Prática',
  evaluated: 'Avaliado',
});
const SOURCE_LABELS = Object.freeze({ authored: 'autoral', generated: 'gerado' });

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Chave do material AUTORAL do exercício: a mesma regra que a biblioteca usa
// para eleger o melhor resultado (frase, alvo, repetições e origem autoral).
export function authoredMaterialKey(session) {
  const goal = session?.training?.goal ?? null;
  const repetitions = session?.training?.repetitions ?? null;
  return materialKey({
    referenceFingerprint: referenceFingerprint(session, { goal, repetitions }),
    goal,
    repetitions,
    source: 'authored',
  });
}

export function isAuthoredAttempt(record, key) {
  return record?.materialKey === key
    && record?.summary?.mode !== 'free'
    && finiteOr(record?.summary?.expected, 0) > 0;
}

// Alvo do histórico: metadados normalizados sempre trazem a chave targetBPM
// (número ou null). null é "sem alvo definido" — nunca herda o andamento atual.
// Só metadados legados crus, sem a chave, caem no andamento da sessão.
export function targetOf(session, metadata = null) {
  if (isObject(metadata) && Object.hasOwn(metadata, 'targetBPM')) return finiteOr(metadata.targetBPM, null);
  return finiteOr(session?.bpm, null);
}

// Duração de um registro: SEMPRE do intervalo fechado quando ele existe; o
// campo gravado só é usado como fallback de um registro antigo que já o tinha.
export function recordDuration(record) {
  const start = parseInstant(record?.startedAt);
  const end = parseInstant(record?.endedAt);
  if (start !== null && end !== null && end > start) return end - start;
  const stored = finiteOr(record?.durationMs, null);
  return stored !== null && stored > 0 ? stored : null;
}

export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours} h ${minutes % 60} min`;
  }
  if (minutes > 0) return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
  return `${seconds} s`;
}

function atOf(record) {
  return parseInstant(record?.startedAt) ?? parseInstant(record?.date) ?? parseInstant(record?.endedAt) ?? parseInstant(record?.completedAt);
}

// Ordem cronológica crescente; registros sem data válida vão para o fim e
// continuam visíveis (nunca descartados em silêncio).
export function chronological(records = []) {
  return (Array.isArray(records) ? records : []).slice().sort((a, b) => {
    const atA = atOf(a);
    const atB = atOf(b);
    if (atA === null && atB === null) return 0;
    if (atA === null) return 1;
    if (atB === null) return -1;
    return atA - atB;
  });
}

export function newestFirst(records = []) {
  // Mais recente primeiro por data REAL. Registro sem data (legado/importado
  // sem intervalo) NUNCA vira "o mais recente": vai para o fim nos dois
  // sentidos, porque inverter a ordem cronológica o colocaria na frente.
  return (Array.isArray(records) ? records : []).slice().sort((a, b) => {
    const atA = atOf(a);
    const atB = atOf(b);
    if (atA === null && atB === null) return 0;
    if (atA === null) return 1;
    if (atB === null) return -1;
    return atB - atA;
  });
}

// Melhor BPM aprovado (≥80% dos ataques no tempo) considerando SOMENTE o
// material autoral — a mesma conta da lista da biblioteca.
export function exerciseProgress(entry) {
  const session = entry?.session ?? null;
  const metadata = isObject(entry?.metadata) ? entry.metadata : { records: [] };
  const records = Array.isArray(metadata.records) ? metadata.records : [];
  const stats = summarize({
    id: entry?.id ?? null,
    session,
    metadata: { ...metadata, records },
    createdAt: entry?.createdAt ?? null,
    updatedAt: entry?.updatedAt ?? null,
  });
  const key = authoredMaterialKey(session);
  const attempts = chronological(records.filter(record => isAuthoredAttempt(record, key)));
  const firstBpm = attempts.length > 0 ? finiteOr(attempts[0].bpm, null) : null;
  const bestBpm = stats.bestBpm;
  return {
    id: stats.id,
    name: stats.name,
    instrument: stats.instrument,
    targetBPM: stats.targetBPM,
    progress: stats.progress,
    lastTrainedAt: stats.lastTrainedAt,
    recordsCount: stats.recordsCount,
    attempts: attempts.length,
    generated: records.filter(record => record.source === 'generated').length,
    firstBpm,
    bestBpm,
    bpmGain: bestBpm !== null && firstBpm !== null ? bestBpm - firstBpm : null,
  };
}

// Exercícios que mais avançaram: progresso em direção ao alvo, depois ganho de
// BPM desde o primeiro treino autoral aprovado. Sem treino autoral o exercício
// não entra no ranking (não há avanço a mostrar).
export function progressRanking(entries = [], { limit = 8 } = {}) {
  const rows = (Array.isArray(entries) ? entries : [])
    .map(exerciseProgress)
    .filter(row => row.attempts > 0);
  rows.sort((a, b) => (b.progress - a.progress)
    || ((b.bpmGain ?? -Infinity) - (a.bpmGain ?? -Infinity))
    || ((b.bestBpm ?? -Infinity) - (a.bestBpm ?? -Infinity))
    || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'pt-BR'));
  return Number.isInteger(limit) && limit > 0 ? rows.slice(0, limit) : rows;
}

// Aproveitamento por treino: `percent` é a nota objetiva quando existe e, sem
// ela, a fração de ataques no tempo. Modo livre não tem denominador: fica sem
// percentual (nunca é tratado como 0%).
export function accuracyPoints(records = []) {
  const points = [];
  for (const record of chronological(records)) {
    const summary = isObject(record?.summary) ? record.summary : {};
    const expected = finiteOr(summary.expected, 0);
    const attackOk = finiteOr(summary.attackOk, 0);
    const metric = finiteOr(record?.metric, null);
    const percent = metric !== null ? Math.round(metric * 100)
      : expected > 0 ? Math.round((attackOk / expected) * 100) : null;
    points.push({
      id: record?.id ?? null,
      atMs: atOf(record),
      percent: percent === null ? null : Math.max(0, Math.min(100, percent)),
      attackOk,
      expected,
      free: finiteOr(summary.free, 0),
      mode: record?.mode ?? null,
      source: record?.source === 'generated' ? 'generated' : 'authored',
      bpm: finiteOr(record?.bpm, null),
    });
  }
  return points;
}

// BPM por treino, marcando a fonte para o gráfico separar gerado de autoral.
export function bpmPoints(records = [], session = null) {
  const key = authoredMaterialKey(session);
  const points = [];
  for (const record of chronological(records)) {
    const bpm = finiteOr(record?.bpm, null);
    if (bpm === null) continue;
    points.push({
      id: record?.id ?? null,
      atMs: atOf(record),
      bpm,
      authored: isAuthoredAttempt(record, key),
      source: record?.source === 'generated' ? 'generated' : 'authored',
      mode: record?.mode ?? null,
    });
  }
  return points;
}

// Linhas legíveis do histórico: nunca escondem registro e nunca inventam
// duração; dono, modo, fonte, BPM e aproveitamento vêm do registro real.
export function runRows(records = []) {
  return newestFirst(records).map(record => {
    const summary = isObject(record?.summary) ? record.summary : {};
    const expected = finiteOr(summary.expected, 0);
    const attackOk = finiteOr(summary.attackOk, 0);
    const metric = finiteOr(record?.metric, null);
    const percent = metric !== null ? Math.round(metric * 100)
      : expected > 0 ? Math.round((attackOk / expected) * 100) : null;
    const durationMs = recordDuration(record);
    const free = finiteOr(summary.free, 0);
    return {
      id: record?.id ?? null,
      at: record?.startedAt ?? record?.completedAt ?? record?.endedAt ?? null,
      atMs: atOf(record),
      bpm: finiteOr(record?.bpm, null),
      mode: record?.mode ?? null,
      source: record?.source === 'generated' ? 'generated' : 'authored',
      percent,
      accuracyText: percent !== null ? `${percent}%`
        : free > 0 ? `${free} ataque(s) livres` : 'sem avaliação',
      durationMs,
      durationText: formatDuration(durationMs),
      repetitions: finiteOr(record?.repetitions, null),
      goal: record?.goal ?? null,
    };
  });
}

// Resumo do histórico do exercício: separa autoral de gerado e só soma
// duração de registros com intervalo/durationMs reais.
export function historySummary(records = [], session = null, metadata = null) {
  const list = Array.isArray(records) ? records : [];
  const key = authoredMaterialKey(session);
  const authored = list.filter(record => isAuthoredAttempt(record, key));
  const known = list.filter(record => recordDuration(record) !== null);
  return {
    total: list.length,
    authored: authored.length,
    generated: list.filter(record => record.source === 'generated').length,
    knownDurationMs: known.reduce((sum, record) => sum + recordDuration(record), 0),
    unknownDuration: list.length - known.length,
    firstAt: list.length > 0 ? atOf(chronological(list)[0]) : null,
    lastAt: list.length > 0 ? atOf(newestFirst(list)[0]) : null,
    targetBPM: targetOf(session, metadata),
    bestBpm: authored.reduce((best, record) => {
      const ratio = finiteOr(record.summary?.attackOk, 0) / Math.max(1, finiteOr(record.summary?.expected, 1));
      const bpm = finiteOr(record.bpm, null);
      return ratio >= PASS_RATIO && bpm !== null && (best === null || bpm > best) ? bpm : best;
    }, null),
  };
}

// Payload de exportação do histórico (mantém os registros completos, sem
// reescrever a sessão autoral nem os metadados do exercício).
export function historyExportPayload(entry, { now = () => new Date().toISOString() } = {}) {
  return JSON.stringify({
    version: 1,
    kind: 'groovegoblin-exercise-history',
    exportedAt: now(),
    exercise: {
      id: entry?.id ?? null,
      name: entry?.metadata?.name ?? entry?.session?.name ?? 'Exercício',
      targetBPM: targetOf(entry?.session, entry?.metadata),
      instrument: entry?.session?.extensions?.studio?.instrument?.type ?? null,
    },
    records: (entry?.metadata?.records ?? []).map(record => ({ ...record })),
  });
}

function slugify(text) {
  return (text || 'exercicio').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60) || 'exercicio';
}

// Painel do histórico aberto a partir da biblioteca. O host entrega a
// biblioteca, o exercício, o download e o caminho explícito de limpeza.
export function mountExerciseHistory(container, host) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para o histórico do exercício.');
  const library = host?.library;
  if (!library || typeof library.get !== 'function' || typeof library.records !== 'function') throw new TypeError('O histórico do exercício precisa da biblioteca.');
  const exerciseId = host?.exerciseId;
  if (typeof exerciseId !== 'string' || exerciseId.length === 0) throw new TypeError('O histórico do exercício precisa de um exercício.');

  const root = createEl('section', { className: 'history-root', 'aria-label': 'Histórico do exercício' });
  container.appendChild(root);
  let armed = false;
  let armedTimer = null;

  function notify(text, error = false) { host?.notify?.(text, error); }

  function render() {
    renderKeepingFocus(root, renderAll);
  }

  function renderEmpty(entry) {
    root.replaceChildren(
      createEl('header', { className: 'history-head' }, [
        createEl('h2', { className: 'history-title', text: `Histórico · ${entry?.metadata?.name ?? 'Exercício'}` }),
        closeButton(),
      ]),
      createEl('p', { className: 'history-hint muted', text: 'Nenhum treino registrado ainda neste exercício. Conclua um treino avaliado para ver BPM, aproveitamento e a lista de execuções aqui.' }),
    );
  }

  function closeButton() {
    const button = createEl('button', { type: 'button', className: 'history-close', text: 'Fechar', 'aria-label': 'Fechar histórico do exercício' });
    button.addEventListener('click', () => host?.close?.());
    return button;
  }

  function renderAll() {
    const entry = library.get(exerciseId);
    if (!entry) { renderEmpty(null); return; }
    const records = library.records(exerciseId);
    if (records.length === 0) { renderEmpty(entry); return; }
    const session = entry.session ?? null;
    const metadata = entry.metadata ?? null;
    const summary = historySummary(records, session, metadata);
    const targetBPM = summary.targetBPM;

    const head = createEl('header', { className: 'history-head' }, [
      createEl('div', { className: 'history-head-text' }, [
        createEl('h2', { className: 'history-title', text: `Histórico · ${metadata?.name ?? 'Exercício'}` }),
        createEl('p', { className: 'history-meta muted', text: `${summary.total} treino(s) registrado(s) · ${summary.authored} do material autoral · ${targetBPM === null ? 'sem alvo definido' : `alvo ${targetBPM} BPM`}` }),
      ]),
      createEl('div', { className: 'history-actions' }, [
        exportButton(entry),
        clearButton(),
        closeButton(),
      ]),
    ]);

    const facts = createEl('ul', { className: 'history-facts' }, [
      fact('Primeiro treino', summary.firstAt === null ? '—' : formatDatePt(summary.firstAt)),
      fact('Último treino', summary.lastAt === null ? '—' : formatDatePt(summary.lastAt)),
      fact('Melhor BPM autoral', summary.bestBpm === null ? '—' : `${summary.bestBpm} BPM`),
      fact('Tempo conhecido', formatDuration(summary.knownDurationMs) ?? '—'),
    ]);
    if (summary.unknownDuration > 0) {
      facts.appendChild(fact('Duração não registrada', `${summary.unknownDuration} treino(s) sem intervalo salvo`));
    }

    const bpmPointsList = bpmPoints(records, session);
    const accuracyPointsList = accuracyPoints(records);

    const bpmSection = createEl('section', { className: 'history-section', 'aria-labelledby': 'history-bpm-title' }, [
      createEl('h3', { id: 'history-bpm-title', text: 'Andamento por treino' }),
      bpmPointsList.length === 0
        ? createEl('p', { className: 'history-hint muted', text: 'Nenhum treino com BPM registrado.' })
        : bpmChart({ points: bpmPointsList, targetBPM, bestAuthoredBpm: summary.bestBpm }),
      createEl('p', { className: 'history-hint', text: 'Cada marca é um treino real (a data aparece na lista abaixo). A linha tracejada é o alvo; material gerado aparece com marca própria e NÃO altera o melhor autoral.' }),
    ]);

    const accuracySection = createEl('section', { className: 'history-section', 'aria-labelledby': 'history-accuracy-title' }, [
      createEl('h3', { id: 'history-accuracy-title', text: 'Aproveitamento por treino' }),
      accuracyPointsList.length === 0
        ? createEl('p', { className: 'history-hint muted', text: 'Nenhum treino registrado.' })
        : accuracyChart({ points: accuracyPointsList }),
    ]);

    const runsSection = createEl('section', { className: 'history-section', 'aria-labelledby': 'history-runs-title' }, [
      createEl('h3', { id: 'history-runs-title', text: 'Treinos registrados' }),
      createEl('ul', { className: 'history-runs' }, runRows(records).map(renderRun)),
    ]);

    root.replaceChildren(head, facts, bpmSection, accuracySection, runsSection);
  }

  function fact(label, value) {
    return createEl('li', {}, [
      createEl('span', { className: 'history-fact-label', text: label }),
      createEl('span', { className: 'history-fact-value', text: value }),
    ]);
  }

  function renderRun(row) {
    const item = createEl('li', { className: `history-run history-run-${row.source}` });
    item.append(
      createEl('span', { className: 'history-run-at', text: row.at === null ? 'data desconhecida' : formatDatePt(row.at) }),
      createEl('span', { className: 'history-run-detail', text: [
        MODE_LABELS[row.mode] ?? row.mode ?? 'Treino',
        SOURCE_LABELS[row.source],
        row.bpm === null ? null : `${row.bpm} BPM`,
        row.accuracyText,
        row.durationText === null ? 'duração não registrada' : row.durationText,
      ].filter(Boolean).join(' · ') }),
    );
    return item;
  }

  function exportButton(entry) {
    const button = createEl('button', { type: 'button', text: 'Exportar histórico (.json)' });
    button.addEventListener('click', () => {
      const payload = historyExportPayload(entry);
      const name = `${slugify(entry?.metadata?.name)}-historico.json`;
      if (host?.download) host.download(payload, name);
      else notify('Download indisponível neste navegador.', true);
    });
    return button;
  }

  // Limpeza explícita: dois toques deliberados, nunca automática. Só os
  // treinos registrados são removidos; exercício, nome, etiquetas e alvo ficam.
  function clearButton() {
    const button = createEl('button', {
      type: 'button',
      className: armed ? 'practice-danger' : null,
      text: armed ? 'Confirmar: apagar histórico deste exercício' : 'Apagar histórico deste exercício',
    });
    button.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        clearTimeout(armedTimer);
        armedTimer = setTimeout(() => { armed = false; render(); }, 5000);
        render();
        return;
      }
      clearTimeout(armedTimer);
      armed = false;
      if (typeof host?.clearRecords !== 'function') { notify('Limpeza de histórico indisponível.', true); return; }
      const result = host.clearRecords(exerciseId);
      if (!result || result.saved === false) notify('Não foi possível salvar a limpeza: o histórico continua guardado neste navegador.', true);
      else notify(`Histórico apagado: ${result.removed} treino(s) removido(s). Exercício, nome, etiquetas e alvo foram mantidos.`);
      render();
    });
    return button;
  }

  const unsubscribe = library.subscribe(render);
  render();
  return {
    render,
    destroy() { clearTimeout(armedTimer); unsubscribe?.(); root.remove(); },
  };
}
