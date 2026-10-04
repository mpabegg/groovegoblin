// Percurso (aba de progresso) do GrooveGoblin: lê o MESMO armazenamento da
// prática (groovegoblin.practice.v1) e mostra resumo, progresso por objetivo
// com revisão espaçada, percurso de tempo, histórico completo com
// exportação/importação/exclusão individuais e robustas. A gravação de novas
// execuções é responsabilidade da prática (practice.onFinish); o Percurso
// apenas renderiza (mountJourney retorna {render, destroy}).

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

export function mountJourney(container, host, options = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para o percurso.');
  requireHost(host);
  const storage = options.storage ?? safeStorage();
  let confirmClearArmed = false;
  let confirmClearTimer = null;

  const root = createEl('section', { className: 'journey-root', 'aria-label': 'Percurso de prática' });

  function load() {
    return loadPracticeState(storage);
  }

  function render() {
    const info = load();
    if (!container.contains(root)) container.appendChild(root);
    renderKeepingFocus(root, () => {
      root.replaceChildren();
    if (info.warnings.length > 0) {
      const box = createEl('div', { className: 'practice-warnings', role: 'status' });
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
      root.appendChild(box);
    }
    const state = info.state;
    root.appendChild(renderSummary(state));
    root.appendChild(renderObjectives(state));
    root.appendChild(renderTempoJourney(state));
    root.appendChild(renderEarStats(state));
    root.appendChild(renderHistory(state));
    root.appendChild(renderDataControls(state));
    });
    return api;
  }

  function renderSummary(state) {
    const totals = practiceTotals(state);
    const section = createEl('section', { className: 'journey-section', 'aria-labelledby': 'journey-summary-title' });
    section.appendChild(createEl('h3', { id: 'journey-summary-title', text: 'Resumo' }));
    const list = createEl('ul', { className: 'journey-summary' });
    const minutes = Math.round(totals.totalSeconds / 60);
    const entries = [
      ['Execuções registradas', String(totals.runs)],
      ['Treinos avaliados', String(totals.attemptRuns)],
      ['Improvisações (escolhas criativas)', String(totals.creativeRuns)],
      ['Perguntas de ouvido', `${totals.earCorrect} de ${totals.earQuestions} certas`],
      ['Tempo total tocado', minutes > 0 ? `${minutes} min` : `${totals.totalSeconds} s`],
      ['Primeiro/último bpm avaliado', totals.firstBpm === null ? '—' : `${totals.firstBpm} → ${totals.lastBpm} bpm`],
      ['Maior bpm avaliado', totals.bestBpm > 0 ? `${totals.bestBpm} bpm` : '—'],
    ];
    for (const [label, value] of entries) {
      list.appendChild(createEl('li', {}, [
        createEl('span', { className: 'journey-summary-label', text: label }),
        createEl('span', { className: 'journey-summary-value', text: value }),
      ]));
    }
    section.appendChild(list);
    return section;
  }

  function renderObjectives(state) {
    const section = createEl('section', { className: 'journey-section', 'aria-labelledby': 'journey-objectives-title' });
    section.appendChild(createEl('h3', { id: 'journey-objectives-title', text: 'Progresso por objetivo' }));
    const queue = reviewQueue(state.skills);
    const list = createEl('ul', { className: 'journey-objectives' });
    for (const objective of OBJECTIVES) {
      const progress = objectiveProgress(state, objective.id);
      const dueText = progress.skill ? formatDaysFromNow(progress.skill.dueAt) : 'sem dados ainda';
      const item = createEl('li', { className: 'journey-objective' });
      item.appendChild(createEl('h4', { text: objective.name }));
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
    const section = createEl('section', { className: 'journey-section', 'aria-labelledby': 'journey-tempo-title' });
    section.appendChild(createEl('h3', { id: 'journey-tempo-title', text: 'Percurso de tempo' }));
    const runs = state.history.filter(entry => entry.kind === 'attempt');
    if (runs.length === 0) {
      section.appendChild(createEl('p', { className: 'practice-hint', text: 'Conclua exercícios em “Treinar ritmo” para acompanhar sua evolução de BPM. A adaptação de velocidade pode ser ajustada em “Configurar rotina”.' }));
      return section;
    }
    section.appendChild(bpmJourneyChart(runs.map(entry => entry.bpm)));
    section.appendChild(createEl('p', { className: 'practice-hint', text: `Cada barra é um treino avaliado (${runs[0].bpm} bpm no primeiro, ${runs[runs.length - 1].bpm} bpm no último).` }));
    return section;
  }

  function renderEarStats(state) {
    const section = createEl('section', { className: 'journey-section', 'aria-labelledby': 'journey-ear-title' });
    section.appendChild(createEl('h3', { id: 'journey-ear-title', text: 'Ouvido' }));
    const earRuns = state.history.filter(entry => entry.kind === 'ear');
    if (earRuns.length === 0) {
      section.appendChild(createEl('p', { className: 'practice-hint', text: 'Abra “Jogos de ouvido” em “Treinar ritmo” para acumular este resumo: contagem de respostas, sem nota única.' }));
      return section;
    }
    const list = createEl('ul', { className: 'journey-summary' });
    for (const [gameId, name] of Object.entries(EAR_GAME_NAMES)) {
      const gameRuns = earRuns.filter(entry => entry.objective === gameId);
      const correct = gameRuns.filter(entry => entry.metrics.correct === 1).length;
      list.appendChild(createEl('li', {}, [
        createEl('span', { className: 'journey-summary-label', text: name }),
        createEl('span', { className: 'journey-summary-value', text: gameRuns.length === 0 ? '—' : `${correct} de ${gameRuns.length} certas` }),
      ]));
    }
    section.appendChild(list);
    return section;
  }

  function renderHistory(state) {
    const section = createEl('section', { className: 'journey-section', 'aria-labelledby': 'journey-history-title' });
    section.appendChild(createEl('h3', { id: 'journey-history-title', text: 'Histórico completo' }));
    if (state.history.length === 0) {
      section.appendChild(createEl('p', { className: 'practice-hint', text: 'Nada registrado ainda: o histórico local cresce com cada treino, improvisação e jogo de ouvido.' }));
      return section;
    }
    const list = createEl('ul', { className: 'journey-history' });
    for (const entry of [...state.history].reverse()) {
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
        const payload = { version: 1, kind: 'groovegoblin.practice-history-entry', entry };
        if (!downloadText(`groovegoblin-registro-${entry.id}.json`, JSON.stringify(payload, null, 2))) {
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
    section.appendChild(createEl('h3', { id: 'journey-data-title', text: 'Dados locais' }));
    section.appendChild(createEl('p', { className: 'practice-hint', text: 'Tudo fica neste navegador (chave própria e versionada). Exporte para levar, importe registros individuais — entradas inválidas são ignoradas com aviso, nunca corrompem o que já está salvo.' }));
    const controls = createEl('div', { className: 'practice-inline-controls' });
    const exportAll = createEl('button', { type: 'button', className: 'practice-primary', text: 'Exportar tudo (.json)' });
    exportAll.addEventListener('click', () => {
      const payload = { version: 1, kind: 'groovegoblin.practice-history', exportedAt: new Date().toISOString(), objective: state.objective, history: state.history };
      if (!downloadText('groovegoblin-percurso.json', JSON.stringify(payload, null, 2))) {
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

    const clearAll = createEl('button', { type: 'button', className: confirmClearArmed ? 'practice-danger' : '', text: confirmClearArmed ? 'Confirmar: apagar TUDO' : 'Apagar todo o histórico' });
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
      host.notify(`Histórico apagado: ${removed} registro(s) removidos. As revisões espaçadas dos objetivos foram mantidas.`);
      render();
    });
    controls.appendChild(clearAll);
    section.appendChild(controls);
    section.appendChild(createEl('p', { className: 'practice-hint', text: `Chave de armazenamento: ${PRACTICE_STORAGE_KEY}` }));
    return section;
  }

  function destroy() {
    clearTimeout(confirmClearTimer);
    root.remove();
  }

  const api = { render, destroy };
  return api;
}
