// Treinador único da aba Treinar. Um só material (a frase da sessão, ou o
// exercício gerado aplicado a ela), um só par fonte×modo e os controles
// compartilhados do painel: partitura, transporte, entrada de toque e resultado
// anotado. O motor musical continua em practice.js (geração, objetivos, etapas,
// estado) e no Engine; aqui vive só o controlador/UI e o registro de tempo real.
//
// Combinações (fonte × modo) — cada uma roda no Engine existente:
//   sessão × Avaliado    -> host.play('train', ...) na frase da sessão
//   sessão × Tocar junto -> host.play('loop', ...) com o acelerador do transporte
//   sessão × Rotina      -> etapas ouvir/tocar/ler/memorizar/improvisar
//   gerado × as três     -> idem, com o material gerado aplicado à sessão
//
// O gerenciador de tempo (activity) recebe SEMPRE intervalos fechados: início
// depois do play aceito e fim em finish/stop/cancelar/borrar a página.

import {
  OBJECTIVES,
  STAGES,
  clamp,
  createEl,
  formatDaysFromNow,
  generateExercise,
  levelFromSkill,
  loadPracticeState,
  normalizeSeed,
  objectiveMetric,
  evaluationFromDetail,
  previewPhrase,
  recordSkillReview,
  renderKeepingFocus,
  reviewQueue,
  safeStorage,
  tickSeconds,
  updatePracticeState,
  normalizeSession,
} from './practice.js';
import { performTick } from './meter.js';
import { mergeSession } from './studio-state.js';

export const TRAINER_SOURCES = Object.freeze([
  { id: 'session', name: 'Frase da sessão' },
  { id: 'generated', name: 'Exercício gerado' },
]);

export const TRAINER_MODES = Object.freeze([
  { id: 'evaluated', name: 'Avaliado', description: 'Execução avaliada com o resultado anotado abaixo. O andamento só muda por ação explícita sua (−10, +4 condicionado ou a sugestão).' },
  { id: 'together', name: 'Tocar junto', description: 'Repetição em loop com o acompanhamento, sem avaliação, usando o Acelerador do transporte (popover do BPM). O tempo tocado entra no Percurso.' },
  { id: 'routine', name: 'Rotina', description: 'Etapas Ouvir, Tocar, Ler, Memorizar (com compassos silenciosos) e Improvisar sobre o acompanhamento.' },
]);

// Puro: o que cada combinação fonte×modo inicia. É a matriz dos seis casos.
export function trainerRun(source, mode) {
  if (!TRAINER_SOURCES.some(item => item.id === source)) throw new RangeError('Fonte desconhecida do treinador.');
  if (!TRAINER_MODES.some(item => item.id === mode)) throw new RangeError('Modo desconhecido do treinador.');
  return {
    material: source,
    evaluated: mode === 'evaluated',
    together: mode === 'together',
    routine: mode === 'routine',
    loops: mode !== 'evaluated',
    evaluatedStage: mode === 'evaluated' || mode === 'routine',
  };
}

// Puro: avanço de etapa sem DOM. Contagem zero já nasce concluída.
export function advanceStage(count, index) {
  const total = Math.max(0, Math.round(Number(count) || 0));
  const next = Math.min(total, Math.max(0, Math.round(Number(index) || 0)) + 1);
  return { index: total === 0 ? 0 : next, done: total === 0 || next >= total };
}

function requireHost(host) {
  if (!host || typeof host !== 'object') throw new TypeError('O treinador requer um host do estúdio.');
  for (const method of ['getSession', 'play', 'stop', 'notify']) {
    if (typeof host[method] !== 'function') throw new TypeError(`O host do treinador precisa do método ${method}.`);
  }
}

function instrumentOf(session) {
  const value = session?.extensions?.studio?.instrument;
  const type = typeof value === 'string' ? value : value?.type;
  return type === 'bass' ? 'bass' : 'guitar';
}

export function mountPractice(container, host, options = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para o treinador.');
  requireHost(host);
  const storage = options.storage ?? safeStorage();
  const activity = options.activity ?? host.activity ?? null;
  const loadInfo = loadPracticeState(storage);
  let practice = loadInfo.state;
  const warnings = loadInfo.warnings.slice();

  let source = 'session';
  let mode = 'evaluated';
  let seedValue = 1;
  // Material gerado TRANSITÓRIO: a referência mostrada no painel e executada
  // quando a fonte é "Exercício gerado". Nunca é gravada na biblioteca nem
  // sobrescreve as notas autorais; "Aplicar à sessão" é ação explícita.
  let generatedMaterial = null;
  let stageIndex = 0;
  let listens = 0;
  let routineDone = practice.routine.stages.length === 0;
  let pendingStage = null;
  let resultPending = false;
  let improvisation = false;
  let openInterval = null;
  let activityWarning = null;
  const completedRuns = new WeakMap();

  const root = createEl('section', { className: 'practice-root trainer-root', 'aria-label': 'Treinador' });
  const transportButton = () => (container.ownerDocument ?? document).getElementById?.('train') ?? null;

  // ----- estado persistido (objetivo, rotina, revisões) -----------------------

  // Sempre lê o estado validado na hora de gravar: dois consumidores do mesmo
  // estado legado (treinador e jogos de ouvido) nunca sobrescrevem um ao outro.
  function commit(mutate) {
    const result = updatePracticeState(storage, mutate);
    practice = result.state;
    if (result.warnings.length > 0 && warnings.length === 0) warnings.push(...result.warnings);
    if (!result.saved) host.notify('Não foi possível salvar as preferências de prática localmente.', true);
    return result.value;
  }

  // ----- tempo real (intervalos fechados) ------------------------------------

  function reportActivityWarning() {
    if (!activity) return;
    if (!activity.warning || activity.warning === activityWarning) return;
    activityWarning = activity.warning;
    host.notify(activity.warning, true);
  }

  function openRun(modeId) {
    closeRun();
    if (!activity) return;
    openInterval = {
      mode: modeId,
      exerciseId: host.activeExerciseId?.() ?? null,
      instrument: instrumentOf(host.getSession()),
      startedAt: new Date().toISOString(),
    };
  }

  function closeRun() {
    if (!openInterval) return null;
    const interval = openInterval;
    openInterval = null;
    if (!activity) return null;
    const endedAt = new Date().toISOString();
    const record = activity.append({ exerciseId: interval.exerciseId, instrument: interval.instrument, source: 'trainer', mode: interval.mode, startedAt: interval.startedAt, endedAt });
    reportActivityWarning();
    return record;
  }

  function journalClosed(modeId, startedAt) {
    if (!activity) return null;
    const record = activity.append({
      exerciseId: host.activeExerciseId?.() ?? null,
      instrument: instrumentOf(host.getSession()),
      source: 'trainer',
      mode: modeId,
      startedAt,
      endedAt: new Date().toISOString(),
    });
    reportActivityWarning();
    return record;
  }

  const lifecycle = () => { closeRun(); activity?.flush(); reportActivityWarning(); };
  const onVisibility = () => { if (document.hidden) lifecycle(); };
  window.addEventListener('pagehide', lifecycle);
  window.addEventListener('blur', lifecycle);
  document.addEventListener('visibilitychange', onVisibility);

  // ----- material ------------------------------------------------------------

  // Origem declarada da execução: a frase do estúdio (autoral) ou o material
  // gerado transitório da fonte "Exercício gerado".
  function currentSource() {
    return source === 'generated' && generatedMaterial ? 'generated' : 'session';
  }

  function materialSnapshot() {
    return source === 'generated' && generatedMaterial ? generatedMaterial : host.getSession();
  }

  // Mostra a referência do material na MESMA partitura do painel (host fino) e
  // nas execuções seguintes; a sessão autoral continua canônica.
  function publishSource() {
    host.setSourceSnapshot?.(source === 'generated' ? generatedMaterial : null);
  }

  // Gera a referência do exercício com o gerador existente. Só material: nada
  // é aplicado à sessão nem gravado na biblioteca.
  function generateReference() {
    const session = host.getSession();
    const level = levelFromSkill(practice.skills[practice.objective]);
    const exercise = generateExercise({
      objective: practice.objective,
      seed: seedValue,
      bars: session.bars,
      bpm: session.bpm,
      level,
      source: 'generated',
      session,
    });
    generatedMaterial = mergeSession(session, {
      notes: exercise.notes.map(note => ({ ...note })),
      bpm: exercise.bpm,
      bars: exercise.bars,
      meter: exercise.meter,
      loop: { startBar: 0, endBar: exercise.bars },
    });
    publishSource();
    return generatedMaterial;
  }

  // Ação explícita e separada: copia a referência mostrada para a sessão, com o
  // Desfazer do histórico. Só aqui as notas autorais mudam.
  function applyToSession() {
    if (!generatedMaterial) return false;
    const patch = {
      notes: generatedMaterial.notes.map(note => ({ ...note })),
      bpm: generatedMaterial.bpm,
      bars: generatedMaterial.bars,
      meter: generatedMaterial.meter,
      loop: { ...generatedMaterial.loop },
    };
    const level = levelFromSkill(practice.skills[practice.objective]);
    if (host.updateSession(patch, { notice: `Exercício gerado (${OBJECTIVES.find(o => o.id === practice.objective)?.name ?? practice.objective}, nível ${level + 1}) aplicado à sua frase da sessão.` }) === false) {
      host.notify('Não foi possível aplicar o exercício gerado; sua frase continua igual.', true);
      return false;
    }
    // A sessão passou a ser o material mostrado: a referência continua a mesma.
    publishSource();
    resultPending = false;
    host.clearResult?.();
    return true;
  }

  function runSnapshot({ stage = null, patch = {} } = {}) {
    const base = materialSnapshot();
    const declared = currentSource();
    const meta = {
      objective: practice.objective,
      source: declared,
      stage: stage?.name ?? 'execução livre',
      mode,
    };
    // A frase da sessão conserva o objetivo de treino escolhido nela; um
    // exercício gerado treina o objetivo da prática (duração só no objetivo
    // de durações), como no treinador anterior — sem tocar na sessão salva.
    const training = declared === 'generated'
      ? { goal: practice.objective === 'durations' ? 'duration' : 'timing' }
      : {};
    return mergeSession(base, mergeSession({ training, extensions: { practice: meta } }, patch));
  }

  function previewReference(snapshot = runSnapshot()) {
    const ticks = snapshot.meter.beats * 16 / snapshot.meter.unit;
    const startTick = snapshot.loop.startBar * ticks;
    const endTick = snapshot.loop.endBar * ticks;
    const offsetTicks = note => (note.offsetMs ?? 0) / tickSeconds(snapshot.bpm) / 1000;
    const notes = snapshot.notes.filter(note => note.start >= startTick && note.start < endTick).map(note => {
      const start = Math.max(0, performTick(snapshot, note.start) - startTick + offsetTicks(note));
      const end = Math.min(endTick - startTick, performTick(snapshot, note.start + note.duration) - startTick + offsetTicks(note));
      return { ...note, start, duration: Math.max(0.05, end - start) };
    });
    return previewPhrase(host, notes, { bpm: snapshot.bpm, timbre: snapshot.timbres.phrase });
  }

  // ----- execução ------------------------------------------------------------

  function busy() {
    return typeof host.isBusy === 'function' ? !!host.isBusy() : false;
  }

  async function playTrain(snapshot, modeId) {
    try {
      await host.play('train', snapshot);
    } catch (error) {
      host.notify(`Não foi possível iniciar o treino: ${error?.message ?? error}`, true);
      return false;
    }
    openRun(modeId);
    rerender();
    return true;
  }

  function startEvaluated(stage = null, { advance = false } = {}) {
    if (busy()) { host.notify('Pare a reprodução antes de iniciar outro treino.', true); return false; }
    pendingStage = advance ? stageIndex : null;
    resultPending = false;
    const patch = stage?.id === 'memorize'
      ? { metronome: { silentBars: practice.routine.memorizeSilentBars, audibleBars: 1, pattern: 'quarters', enabled: true } }
      : {};
    rerender();
    return playTrain(runSnapshot({ stage, patch }), mode === 'routine' ? 'routine' : 'evaluated');
  }

  // Execução de um exercício à parte entregue pelo resultado (repetir/loop/+4/−10
  // num material gerado): o tempo também é registrado como treino do treinador.
  function startSnapshot(snapshot) {
    if (busy()) return false;
    resultPending = false;
    rerender();
    return playTrain(snapshot, mode === 'routine' ? 'routine' : 'evaluated');
  }

  async function startTogether() {
    if (busy()) { host.notify('Pare a reprodução antes de começar de novo.', true); return false; }
    try {
      await host.play('loop', runSnapshot());
    } catch (error) {
      host.notify(`Não foi possível iniciar o acompanhamento: ${error?.message ?? error}`, true);
      return false;
    }
    openRun('together');
    rerender();
    return true;
  }

  async function startImprovisation() {
    if (improvisation) return false;
    if (busy()) { host.notify('Pare a reprodução antes de improvisar.', true); return false; }
    const session = host.getSession();
    const snapshot = runSnapshot({
      patch: {
        band: { role: 'solo' },
        mixer: mergeSession(session.mixer, { phrase: { muted: true } }),
        form: { enabled: false, sections: [] },
      },
    });
    try {
      await host.play('loop', snapshot);
    } catch (error) {
      host.notify(`Não foi possível iniciar o acompanhamento: ${error?.message ?? error}`, true);
      return false;
    }
    improvisation = true;
    openRun('routine');
    rerender();
    host.notify('Acompanhamento em loop; improvise no seu instrumento. Esta etapa registra o tempo de prática, sem avaliar som ou microfone.');
    return true;
  }

  function finishImprovisation() {
    if (!improvisation) return false;
    improvisation = false;
    closeRun();
    host.stop();
    stageComplete();
    return true;
  }

  function activeStage() {
    const stages = practice.routine.stages;
    if (stages.length === 0 || stageIndex >= stages.length) return null;
    return STAGES.find(stage => stage.id === stages[stageIndex]) ?? null;
  }

  function stageComplete() {
    pendingStage = null;
    improvisation = false;
    const advanced = advanceStage(practice.routine.stages.length, stageIndex);
    stageIndex = advanced.index;
    routineDone = advanced.done;
    listens = 0;
    rerender();
  }

  function listenOnce() {
    if (activeStage()?.id !== 'listen') return false;
    const startedAt = new Date().toISOString();
    return previewReference()
      .then(() => {
        journalClosed('routine', startedAt);
        if (activeStage()?.id !== 'listen') return true;
        listens += 1;
        if (listens >= practice.routine.listenRepetitions) stageComplete();
        else rerender();
        return true;
      })
      .catch(error => { host.notify(error.message, true); return false; });
  }

  // O transporte existente executa a ação da etapa atual.
  function runStage() {
    if (practice.routine.stages.length === 0) {
      host.notify('Escolha ao menos uma etapa em “Configurar rotina”.');
      return false;
    }
    if (routineDone) {
      stageIndex = 0;
      listens = 0;
      routineDone = false;
      pendingStage = null;
      rerender();
      return true;
    }
    const stage = activeStage();
    if (!stage) return false;
    if (stage.id === 'listen') return listenOnce();
    if (stage.id === 'imitate' || stage.id === 'memorize') return startEvaluated(stage, { advance: true });
    if (stage.id === 'read') { stageComplete(); return true; }
    if (stage.id === 'improvise') return improvisation ? finishImprovisation() : startImprovisation();
    return false;
  }

  function start() {
    if (mode === 'together') return startTogether();
    if (mode === 'routine') return runStage();
    return startEvaluated();
  }

  function cancel() {
    pendingStage = null;
    resultPending = false;
    improvisation = false;
    closeRun();
    host.stop();
    rerender();
  }

  // Rótulo/ação primária do transporte: avaliado/tocar junto têm um só rótulo;
  // na Rotina ele é a ação da ETAPA atual (sem segundo botão primário no painel).
  // dataset.reference marca as etapas que rodam sem notas escritas (ouvir, ler,
  // improvisar) — main.js pode usar isso para não desabilitar o transporte.
  function stageTransportLabel() {
    if (routineDone) return 'Recomeçar rotina';
    const stage = activeStage();
    if (!stage) return 'Iniciar rotina';
    if (stage.id === 'listen') return `Ouvir referência (${listens}/${practice.routine.listenRepetitions})`;
    if (stage.id === 'imitate') return 'Tocar o ritmo';
    if (stage.id === 'memorize') return 'Tocar de memória';
    if (stage.id === 'read') return 'Concluir leitura';
    if (stage.id === 'improvise') return improvisation ? 'Concluir improvisação' : 'Tocar acompanhamento e improvisar';
    return 'Iniciar rotina';
  }

  function transportNeedsWrittenNotes() {
    if (mode !== 'routine') return true;
    const stage = activeStage();
    if (!stage) return true;
    return stage.id === 'imitate' || stage.id === 'memorize';
  }

  function syncTransportLabel() {
    const button = transportButton();
    if (!button) return;
    const label = mode === 'together' ? 'Tocar junto em loop' : mode === 'routine' ? stageTransportLabel() : 'Treinar esta frase';
    if (button.textContent !== label) button.textContent = label;
    button.dataset.reference = String(!transportNeedsWrittenNotes());
    if (button.dataset.reference === 'true' && !busy()) button.disabled = false;
    const preview = document.getElementById('listen-phrase');
    if (preview) preview.hidden = mode === 'routine' && activeStage()?.id === 'listen' && !routineDone;
  }

  function rerender() {
    if (root.isConnected === false && !container.contains(root)) container.appendChild(root);
    renderKeepingFocus(root, renderAll);
  }

  // ----- interface ----------------------------------------------------------

  function renderAll() {
    root.replaceChildren();
    if (warnings.length > 0) {
      const box = createEl('div', { className: 'practice-warnings', role: 'status' });
      for (const text of warnings) box.appendChild(createEl('p', { text }));
      root.appendChild(box);
    }
    root.appendChild(renderTitle());
    root.appendChild(renderSelectors());
    const sourcePanel = renderSourcePanel();
    if (sourcePanel) root.appendChild(sourcePanel);
    if (mode === 'routine') root.appendChild(renderRoutinePanel());
    root.appendChild(renderDetailsRow());
    for (const control of root.querySelectorAll('select, #trainer-generate, .practice-routine-current button:not([data-allow-busy]), .practice-routine-controls input, #trainer-seed')) {
      control.dataset.idleOnly = String(control.disabled);
    }
    syncTransportLabel();
    setBusy(busy());
  }

  function renderSelectors() {
    const row = createEl('div', { className: 'trainer-controls' });
    const sourceSelect = createEl('select', { id: 'trainer-source', 'aria-label': 'Fonte do treino', dataset: { focusKey: 'trainer-source' } });
    for (const item of TRAINER_SOURCES) sourceSelect.appendChild(createEl('option', { value: item.id, selected: source === item.id, text: item.name }));
    sourceSelect.addEventListener('change', () => {
      source = sourceSelect.value;
      resultPending = false;
      host.clearResult?.();
      // Selecionar "Exercício gerado" PREPARA a referência gerada e mostra a
      // partitura dela; a sessão autoral não é tocada nem autossalva.
      if (source === 'generated') generateReference();
      else publishSource();
      rerender();
    });
    row.appendChild(createEl('label', { className: 'trainer-field' }, [createEl('span', { text: 'Fonte' }), sourceSelect]));

    const objectiveSelect = createEl('select', { id: 'trainer-objective', 'aria-label': 'Objetivo da prática', dataset: { focusKey: 'trainer-objective' } });
    for (const objective of OBJECTIVES) {
      objectiveSelect.appendChild(createEl('option', {
        value: objective.id,
        selected: practice.objective === objective.id,
        text: `${objective.name} · nível ${levelFromSkill(practice.skills[objective.id]) + 1}`,
      }));
    }
    objectiveSelect.addEventListener('change', () => {
      commit(state => { state.objective = objectiveSelect.value; });
      stageIndex = 0;
      listens = 0;
      routineDone = practice.routine.stages.length === 0;
      resultPending = false;
      host.clearResult?.();
      if (source === 'generated') generateReference();
      rerender();
    });
    row.appendChild(createEl('label', { className: 'trainer-field' }, [createEl('span', { text: 'Objetivo da prática' }), objectiveSelect]));

    const modeSelect = createEl('select', { id: 'trainer-mode', 'aria-label': 'Modo do treino', dataset: { focusKey: 'trainer-mode' } });
    for (const item of TRAINER_MODES) modeSelect.appendChild(createEl('option', { value: item.id, selected: mode === item.id, text: item.name }));
    modeSelect.addEventListener('change', () => {
      mode = modeSelect.value;
      resultPending = false;
      improvisation = false;
      host.clearResult?.();
      rerender();
    });
    row.appendChild(createEl('label', { className: 'trainer-field' }, [createEl('span', { text: 'Modo' }), modeSelect]));
    if (source === 'generated') {
      const again = createEl('button', { type: 'button', className: 'practice-primary', id: 'trainer-generate', text: 'Gerar outro exercício', dataset: { focusKey: 'trainer-generate' } });
      again.addEventListener('click', () => {
        seedValue = (normalizeSeed(seedValue, 1) + 1) >>> 0;
        generateReference();
        resultPending = false;
        host.clearResult?.();
        rerender();
      });
      row.appendChild(again);
    }
    return row;
  }

  // Opções menos usadas do material gerado: semente, regeneração com semente e
  // a cópia explícita para a sessão (com Desfazer). Sempre acessíveis.
  function renderGeneratedAdvanced() {
    const section = createEl('details', { className: 'practice-disclosure', dataset: { disclosure: 'trainer-generated' } });
    section.appendChild(createEl('summary', { text: 'Avançado · semente e cópia para a sessão', dataset: { focusKey: 'trainer-advanced' } }));
    const body = createEl('div', { className: 'practice-section' });
    const row = createEl('div', { className: 'practice-inline-controls' });
    const seedInput = createEl('input', {
      id: 'trainer-seed', type: 'number', min: '0', max: '4294967295', step: '1',
      value: String(seedValue), 'aria-label': 'Semente do exercício gerado', dataset: { focusKey: 'trainer-seed' },
    });
    seedInput.addEventListener('change', () => {
      seedValue = normalizeSeed(seedInput.value, seedValue);
      seedInput.value = String(seedValue);
    });
    row.appendChild(createEl('label', {}, [createEl('span', { text: 'Semente: ' }), seedInput]));
    const reproduce = createEl('button', { type: 'button', text: 'Gerar com esta semente' });
    reproduce.addEventListener('click', () => {
      seedValue = normalizeSeed(seedInput.value, seedValue);
      generateReference();
      resultPending = false;
      host.clearResult?.();
      rerender();
    });
    row.appendChild(reproduce);
    const apply = createEl('button', { type: 'button', id: 'trainer-apply-to-session', text: 'Aplicar à sessão' });
    apply.addEventListener('click', () => { if (applyToSession()) rerender(); });
    row.appendChild(apply);
    body.appendChild(row);
    body.appendChild(createEl('p', { className: 'practice-hint', text: 'A referência gerada já é o material dos treinos (sem tocar na sua frase). “Aplicar à sessão” copia exatamente esta referência para a frase, com Desfazer.' }));
    section.appendChild(body);
    return section;
  }

  function renderSourcePanel() {
    if (source === 'session') return null;
    return createEl('p', {
      className: 'practice-hint trainer-source-hint',
      text: 'Referência gerada: já é o material dos treinos; sua frase guardada continua intacta.',
    });
  }

  function renderTitle() {
    // Uma linha só: o painel já está dentro da aba Treinar. Na Rotina, a linha
    // mostra as etapas e a etapa atual (com a descrição) em vez do texto geral.
    const head = createEl('div', { className: 'trainer-head' });
    const stage = mode === 'routine' ? activeStage() : null;
    if (mode === 'routine' && practice.routine.stages.length > 0) {
      const steps = createEl('ol', { className: 'practice-steps' });
      practice.routine.stages.forEach((stageId, index) => {
        const item = STAGES.find(entry => entry.id === stageId);
        const node = createEl('li', { className: `practice-step${index === stageIndex && !routineDone ? ' practice-step-active' : ''}${index < stageIndex || routineDone ? ' practice-step-done' : ''}` });
        node.appendChild(createEl('span', {
          className: 'practice-step-name',
          text: item.name,
          'aria-current': index === stageIndex && !routineDone ? 'step' : null,
        }));
        steps.appendChild(node);
      });
      head.appendChild(steps);
    }
    const hint = stage && !routineDone
      ? `Etapa ${stageIndex + 1}/${practice.routine.stages.length} · ${stage.name}: ${stage.description}`
      : TRAINER_MODES.find(item => item.id === mode)?.description ?? '';
    head.appendChild(createEl('span', { className: 'practice-hint', id: 'trainer-mode-hint', text: hint }));
    return head;
  }

  function renderRoutineConfig() {
    const section = createEl('details', { className: 'practice-disclosure', dataset: { disclosure: 'trainer-routine' } });
    section.appendChild(createEl('summary', { text: 'Configurar rotina', dataset: { focusKey: 'trainer-routine-config' } }));
    const body = createEl('div', { className: 'practice-section' });
    const stageList = createEl('div', { className: 'practice-stage-config' });
    for (const stage of STAGES) {
      const label = createEl('label', { className: 'practice-stage-toggle' });
      const checkbox = createEl('input', { type: 'checkbox', 'aria-label': `Etapa ${stage.name}` });
      checkbox.checked = practice.routine.stages.includes(stage.id);
      checkbox.addEventListener('change', () => {
        commit(state => {
          const stages = new Set(state.routine.stages);
          if (checkbox.checked) stages.add(stage.id);
          else stages.delete(stage.id);
          state.routine.stages = STAGES.map(item => item.id).filter(id => stages.has(id));
        });
        stageIndex = Math.min(stageIndex, Math.max(0, practice.routine.stages.length - 1));
        routineDone = practice.routine.stages.length === 0 ? true : routineDone && stageIndex >= practice.routine.stages.length;
        rerender();
      });
      label.appendChild(checkbox);
      label.appendChild(createEl('span', { text: `${stage.name}: ${stage.description}` }));
      stageList.appendChild(label);
    }
    body.appendChild(stageList);

    const controls = createEl('div', { className: 'practice-routine-controls' });
    const listenInput = createEl('input', { type: 'number', min: '1', max: '8', value: String(practice.routine.listenRepetitions), 'aria-label': 'Escutas da referência na etapa Ouvir' });
    listenInput.addEventListener('change', () => {
      commit(state => { state.routine.listenRepetitions = clamp(Math.round(Number(listenInput.value) || 2), 1, 8); });
      listenInput.value = String(practice.routine.listenRepetitions);
    });
    controls.appendChild(createEl('label', {}, [createEl('span', { text: 'Escutas por referência: ' }), listenInput]));
    const silentInput = createEl('input', { type: 'number', min: '0', max: '8', value: String(practice.routine.memorizeSilentBars), 'aria-label': 'Compassos silenciosos na etapa Memorizar' });
    silentInput.addEventListener('change', () => {
      commit(state => { state.routine.memorizeSilentBars = clamp(Math.round(Number(silentInput.value) || 0), 0, 8); });
      silentInput.value = String(practice.routine.memorizeSilentBars);
    });
    controls.appendChild(createEl('label', {}, [createEl('span', { text: 'Compassos silenciosos (memorizar): ' }), silentInput]));
    body.appendChild(controls);
    body.appendChild(createEl('p', { className: 'practice-hint', text: 'O clique silencia nos compassos escolhidos da etapa Memorizar; a etapa Ouvir conta as escutas da referência antes de tocar.' }));
    section.appendChild(body);
    return section;
  }

  // A ação primária da etapa vive no transporte único (#train): o rótulo muda
  // com a etapa e o clique encaminha runStage. Aqui ficam só o estado da etapa,
  // o atalho de pular e a continuação depois do resultado — sem botão primário
  // duplicado.
  function renderRoutinePanel() {
    const section = createEl('section', { className: 'practice-section trainer-routine', 'aria-labelledby': 'trainer-mode-hint' });
    if (practice.routine.stages.length === 0) {
      section.appendChild(createEl('p', { className: 'practice-hint', text: 'Nenhuma etapa ativa: abra “Configurar rotina” e escolha ouvir, tocar, ler, memorizar ou improvisar.' }));
      return section;
    }
    const controls = createEl('div', { className: 'practice-inline-controls trainer-routine-actions' });
    if (resultPending) {
      controls.appendChild(createEl('span', { className: 'practice-done', role: 'status', text: routineDone ? 'Rotina concluída! Confira o resultado abaixo.' : 'Confira seu resultado abaixo e siga para a próxima etapa.' }));
      const next = createEl('button', { type: 'button', className: 'practice-primary', dataset: { focusKey: 'routine-action' }, text: routineDone ? 'Recomeçar rotina' : 'Continuar rotina' });
      next.addEventListener('click', () => {
        resultPending = false;
        if (routineDone) { stageIndex = 0; listens = 0; routineDone = false; }
        rerender();
      });
      controls.appendChild(next);
      section.appendChild(controls);
      return section;
    }

    const stage = activeStage();
    if (!stage) return section;
    if (stage.id === 'listen') {
      controls.appendChild(createEl('span', { className: 'practice-hint', text: `O transporte acima toca a referência e conta as escutas (${listens}/${practice.routine.listenRepetitions}).` }));
    } else if (stage.id === 'imitate' || stage.id === 'memorize') {
      controls.appendChild(createEl('span', { className: 'practice-hint', text: stage.id === 'memorize'
        ? `O transporte acima inicia a execução de memória, com o clique silencioso em ${practice.routine.memorizeSilentBars} compasso(s). Espere a contagem; depois pressione e solte Espaço ou a área de toque.`
        : 'O transporte acima toca o ritmo. Espere a contagem; depois pressione e solte Espaço ou a área de toque.' }));
    } else if (stage.id === 'read') {
      controls.appendChild(createEl('span', { className: 'practice-counts', text: 'Conte em voz alta: 1 · e · e · a, 2 · e · e · a…' }));
      controls.appendChild(createEl('span', { className: 'practice-hint', text: 'O transporte acima conclui a leitura quando você terminar.' }));
    } else if (stage.id === 'improvise') {
      controls.appendChild(createEl('span', {
        className: 'practice-hint',
        text: improvisation
          ? 'Acompanhamento em loop; improvise no seu instrumento. O transporte acima conclui a improvisação. Esta etapa registra o tempo de prática, sem avaliar som ou microfone.'
          : 'O transporte acima toca o acompanhamento em loop para improvisar; esta etapa registra o tempo de prática, sem avaliar som ou microfone.',
      }));
    }
    const skip = createEl('button', { type: 'button', text: 'Pular etapa' });
    skip.addEventListener('click', () => { host.stop(); stageComplete(); });
    controls.appendChild(skip);
    section.appendChild(controls);
    return section;
  }

  // Configurar rotina e Histórico/revisões dividem uma linha: dois detalhes
  // fechados em vez de dois blocos empilhados.
  function renderDetailsRow() {
    const row = createEl('div', { className: 'trainer-details-row' });
    if (source === 'generated') row.appendChild(renderGeneratedAdvanced());
    if (mode === 'routine') row.appendChild(renderRoutineConfig());
    row.appendChild(renderHistorySection());
    return row;
  }

  function renderHistorySection() {
    const section = createEl('details', { className: 'practice-disclosure', dataset: { disclosure: 'trainer-history' } });
    section.appendChild(createEl('summary', { text: 'Histórico e revisões', dataset: { focusKey: 'trainer-history' } }));
    const body = createEl('div', { className: 'practice-section' });
    const row = createEl('div', { className: 'practice-inline-controls' });
    const history = createEl('button', { type: 'button', id: 'trainer-exercise-history', text: 'Histórico do exercício' });
    history.addEventListener('click', () => {
      if (typeof host.openExerciseHistory !== 'function') { host.notify('O histórico por exercício abre na Biblioteca.', false); return; }
      host.openExerciseHistory(host.activeExerciseId?.() ?? undefined);
    });
    row.appendChild(history);
    const review = createEl('button', { type: 'button', text: 'Revisar próximo objetivo' });
    review.addEventListener('click', () => {
      const due = reviewQueue(practice.skills).find(entry => entry.due);
      if (!due) { host.notify('Todas as revisões estão em dia. Escolha um objetivo para praticar.'); return; }
      commit(state => { state.objective = due.objective.id; });
      stageIndex = 0;
      listens = 0;
      resultPending = false;
      rerender();
    });
    row.appendChild(review);
    body.appendChild(row);
    const skill = practice.skills[practice.objective];
    body.appendChild(createEl('p', {
      className: 'practice-hint',
      text: `Os treinos avaliados ficam no exercício dono da biblioteca; aqui só o agendamento por objetivo. ${skill ? `Próxima revisão de ${OBJECTIVES.find(o => o.id === practice.objective)?.name ?? ''}: ${formatDaysFromNow(skill.dueAt)}.` : 'Nenhuma revisão agendada para este objetivo ainda.'}`,
    }));
    section.appendChild(body);
    return section;
  }

  function setBusy(locked) {
    for (const control of root.querySelectorAll('[data-idle-only]')) control.disabled = locked || control.dataset.idleOnly === 'true';
  }

  // ----- ciclo de vida ------------------------------------------------------

  // main.js: botão do transporte, repetir do resultado e abrir um exercício.
  function useSession({ train = false } = {}) {
    if (train) {
      // O material gerado é sempre preparado a partir do exercício ativo no
      // momento de começar (nunca uma referência de outro exercício).
      if (source === 'generated') generateReference();
      start();
    } else {
      stageIndex = 0;
      listens = 0;
      routineDone = practice.routine.stages.length === 0;
      resultPending = false;
      rerender();
    }
    return api;
  }

  function onFinish(attempts, detail) {
    if (!Array.isArray(attempts)) return null;
    if (completedRuns.has(attempts)) return completedRuns.get(attempts);
    closeRun();
    const session = detail?.session && typeof detail.session === 'object' ? detail.session : host.getSession();
    const normalized = normalizeSession(session);
    const { rows, summary } = evaluationFromDetail(detail, attempts, session);
    const objective = OBJECTIVES.some(item => item.id === session.extensions?.practice?.objective)
      ? session.extensions.practice.objective
      : practice.objective;
    const metric = summary.mode === 'free' ? 0 : objectiveMetric(objective, { rows, summary, notes: normalized.notes, ticksPerBeat: normalized.ticksPerBeat });
    commit(state => { recordSkillReview(state, objective, metric); });
    if (pendingStage !== null && pendingStage === stageIndex) stageComplete();
    resultPending = true;
    pendingStage = null;
    const result = { summary, metric, objective, adapt: null, revision: practice.skills[objective] ?? null };
    completedRuns.set(attempts, result);
    rerender();
    if (attempts.length === 0) host.notify('Nenhum toque: notas esperadas registradas como perdidas, sem sucesso automático.');
    return result;
  }

  function render() {
    practice = loadPracticeState(storage).state;
    rerender();
    return api;
  }

  function destroy() {
    closeRun();
    window.removeEventListener('pagehide', lifecycle);
    window.removeEventListener('blur', lifecycle);
    document.removeEventListener('visibilitychange', onVisibility);
    improvisation = false;
    pendingStage = null;
    root.remove();
  }

  const api = { render, onFinish, cancel, destroy, useSession, setBusy, start, startSnapshot, get source() { return source; }, get mode() { return mode; } };
  container.appendChild(root);
  renderAll();
  return api;
}
