import { InstrumentCapture } from './instrument-capture.js';
import { InstrumentInputGate, instrumentSession } from './instrument-input.js';
import { refractorySeconds } from './instrument-onsets.js';
import { calibrateInput, compensatedTime, detectClickLeak, inputTailSeconds, calibrationCollectionDeadline, CALIBRATION_REFRACTORY_SECONDS, INPUT_PREFERENCES_KEY, readInputPreferences, readCalibration, saveCalibration } from './input-timing.js';

const $ = id => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key in node && !key.includes('-')) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children); return node;
}
const label = (text, input) => el('label', {}, el('span', { text }), input);

export function mountPerformanceInput(host) {
  const audio = host.audio;
  const pad = $('train-pad');
  const preferences = readInputPreferences();
  const gate = new InstrumentInputGate(audio);
  let mode = 'keyboard'; // Never restore permission/capture automatically.
  let activeInput = null;
  let preparing = false;
  let selectionGeneration = 0;
  let recoveringDevices = false;
  let enumeratingDevices = false;
  let calibration = null;
  let calibrationTimer = null;
  let testing = false;
  let flashedUntil = 0;
  let leakClicks = [];
  let leakAttacks = [];
  let leakWarned = false;
  let storedCalibration = readCalibration('keyboard');

  const entry = el('select', { id: 'performance-entry', 'aria-label': 'Entrada do treino' },
    el('option', { value: 'keyboard', text: 'Teclado' }), el('option', { value: 'instrument', text: 'Instrumento' }));
  const device = el('select', { id: 'instrument-device', 'aria-label': 'Dispositivo de entrada' });
  const channel = el('select', { id: 'instrument-channel', 'aria-label': 'Canal de entrada' },
    ...[['1', 'Canal 1'], ['2', 'Canal 2'], ['sum', 'Soma (média dos canais)']].map(([value, text]) => el('option', { value, text })));
  channel.value = preferences.channel;
  const sensitivity = el('input', { id: 'instrument-sensitivity', type: 'range', min: '0.5', max: '2', step: '0.05', value: preferences.sensitivity, 'aria-label': 'Sensibilidade dos ataques' });
  const level = el('meter', { id: 'instrument-level', min: 0, max: 1, low: 0.01, high: 0.85, optimum: 0.2, value: 0, 'aria-label': 'Nível da entrada de áudio' });
  const levelText = el('output', { id: 'instrument-level-text', text: 'Entrada inativa' });
  const status = el('p', { id: 'instrument-status', className: 'tool-hint', role: 'status', 'aria-live': 'polite' });
  const reason = el('p', { id: 'instrument-goal-reason', className: 'tool-hint muted', text: 'Instrumento avalia apenas ataques. Durações e alturas não são medidas; o teclado conserva seus objetivos anteriores.', hidden: true });
  const test = el('button', { id: 'instrument-test', type: 'button', text: 'Testar entrada' });
  const diagnostic = el('ol', { id: 'instrument-diagnostic', className: 'instrument-diagnostic', hidden: true, 'aria-label': 'Ataques detectados: instante e nível' });
  const instrumentPanel = el('div', { id: 'instrument-panel', hidden: true },
    el('div', { className: 'tool-row' }, label('Dispositivo', device), label('Canal', channel), label('Sensibilidade', sensitivity)),
    el('div', { className: 'instrument-meter' }, level, levelText),
    el('p', { className: 'tool-hint muted', text: 'Use fones: o clique e a banda podem vazar no microfone e gerar ataques falsos. Durante a contagem, espere sem tocar para diagnosticar vazamento.' }), test, diagnostic);
  const calibrate = el('button', { id: 'input-calibrate', type: 'button', text: 'Calibrar latência · 8 cliques' });
  const cancelCalibration = el('button', { id: 'input-calibration-cancel', type: 'button', text: 'Cancelar calibração', hidden: true });
  const manual = el('input', { id: 'input-compensation', type: 'number', min: '-500', max: '500', step: '1', value: storedCalibration ?? 0 });
  const clearCalibration = el('button', { id: 'input-calibration-reset', type: 'button', text: 'Zerar calibração' });
  const compensation = el('output', { id: 'input-compensation-status' });
  const panel = el('section', { className: 'performance-entry', 'aria-label': 'Entrada e calibração' },
    el('div', { className: 'tool-row' }, label('Entrada', entry)), reason, instrumentPanel,
    el('details', { id: 'input-calibration', className: 'control-detail' },
      el('summary', { text: 'Calibração de latência (teclado ou instrumento)' }),
      el('p', { className: 'tool-hint muted', text: 'Toque junto dos oito cliques. Os dois primeiros são aquecimento; a mediana dos seis restantes compensa o atraso residual. Use fones e pulso estável. A calibração inclui seu tempo de resposta, não é uma medição laboratorial.' }),
      el('div', { className: 'tool-row' }, calibrate, cancelCalibration, label('Compensação manual (ms)', manual), clearCalibration), compensation),
    status, el('p', { id: 'instrument-privacy', className: 'tool-hint muted', text: 'Privacidade: o áudio da entrada é analisado apenas neste dispositivo, não é gravado nem enviado. Só selecionar Instrumento solicita acesso; voltar a Teclado encerra a captura.' }));
  $('performance-input').prepend(panel);

  const key = () => mode === 'instrument' ? capture.calibrationDeviceId : 'keyboard';
  function persistPreferences() {
    try { localStorage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify(preferences)); }
    catch { host.notify('A escolha da entrada fica apenas nesta visita; armazenamento indisponível.', true); }
  }
  function loadCompensation() {
    const deviceKey = key();
    storedCalibration = deviceKey === null ? null : readCalibration(deviceKey);
    manual.value = storedCalibration ?? 0; render();
  }
  function saveCompensation(value) {
    storedCalibration = value;
    const deviceKey = key();
    if (deviceKey === null) host.notify('O navegador não identifica esta entrada física. Compensação somente nesta captura; escolha um dispositivo específico para guardá-la.', true);
    else {
      try { saveCalibration(deviceKey, value); }
      catch { host.notify('Compensação aplicada nesta visita; não foi possível guardá-la neste navegador.', true); }
    }
    manual.value = value ?? 0; render();
  }
  function renderDevices(devices) {
    device.replaceChildren();
    if (recoveringDevices) device.append(el('option', { value: '', text: devices.length ? 'Escolha outra entrada' : 'Nenhuma entrada disponível', disabled: true }));
    else if (!devices.length) device.append(el('option', { value: '', text: 'Nenhuma entrada disponível' }));
    for (const [index, item] of devices.entries()) device.append(el('option', { value: item.deviceId, text: item.label || `Entrada de áudio ${index + 1}` }));
    device.value = recoveringDevices ? '' : devices.some(item => item.deviceId === preferences.deviceId) ? preferences.deviceId : capture.deviceId;
  }
  async function recoverDevices(request) {
    try {
      const devices = await capture.devices();
      if (request !== selectionGeneration) return;
      renderDevices(devices);
      status.textContent += devices.length ? ' Escolha uma entrada e depois selecione Instrumento.' : ' Conecte uma entrada e selecione Instrumento para tentar novamente.';
    } catch {
      if (request !== selectionGeneration) return;
      recoveringDevices = false;
      status.textContent += ' Não foi possível listar as entradas; verifique o dispositivo antes de selecionar Instrumento novamente.';
    }
    if (request !== selectionGeneration) return;
    enumeratingDevices = false; render(); host.changed();
  }
  const capture = new InstrumentCapture({
    onDevices: renderDevices,
    onLevel(value, channels) {
      level.value = Math.min(1, value);
      levelText.textContent = mode === 'instrument' && capture.active ? `${Math.round(value * 100)}% · ${channels} canal(is)` : 'Entrada inativa';
      pad.style.setProperty('--input-level', String(Math.min(1, value * 4)));
      if (preferences.channel === '2' && channels === 1) status.textContent = 'Esta entrada tem apenas um canal. Escolha Canal 1 ou Soma.';
    },
    onError(message, { recoverDevices: recover = false } = {}) {
      const request = ++selectionGeneration;
      preparing = false; mode = 'keyboard'; entry.value = mode;
      testing = false; diagnostic.hidden = true; test.textContent = 'Testar entrada';
      recoveringDevices = recover; enumeratingDevices = recover;
      if (recover) {
        device.replaceChildren(el('option', { value: '', text: 'Procurando entradas disponíveis…', disabled: true }));
        device.value = '';
      }
      host.stop(); reset(); loadCompensation(); status.textContent = `${message} Voltamos ao Teclado.`;
      host.notify(status.textContent, true); host.changed();
      if (recover) void recoverDevices(request);
    },
    onAttack(attack) {
      flashedUntil = performance.now() + 120;
      if (testing) {
        const item = el('li', { text: `${(attack.time / 1000).toFixed(3)} s · nível ${(attack.level * 100).toFixed(1)}%` });
        diagnostic.prepend(item); while (diagnostic.children.length > 32) diagnostic.lastChild.remove();
      }
      if (calibration) { calibration.attacks.push(attack.time); return; }
      const time = compensatedTime(attack.time, storedCalibration ?? 0);
      const currentMode = audio.position.mode;
      if (currentMode === 'countin' || currentMode === 'train') gate.attack(time);
      if (currentMode === 'countin' && !audio.position.held) {
        leakClicks = audio.countInClicks;
        leakAttacks.push(attack.time);
        if (!leakWarned && detectClickLeak(leakClicks, leakAttacks).leaking) {
          leakWarned = true;
          status.textContent = 'Possível vazamento do metrônomo: ataques coincidem com os cliques da contagem. Use fones e reduza o volume. Não é possível separar clique e instrumento neste sinal.';
          host.notify(status.textContent, true);
        }
        return;
      }
    },
  });

  async function selectMode(value) {
    const request = ++selectionGeneration;
    recoveringDevices = false; enumeratingDevices = false;
    host.stop(); reset(); capture.stop(); testing = false; diagnostic.hidden = true;
    test.textContent = 'Testar entrada';
    mode = value; entry.value = value; preparing = value === 'instrument';
    status.textContent = preparing ? 'Abrindo entrada de áudio…' : 'Entrada por teclado/toque; captura encerrada.';
    loadCompensation(); host.changed();
    if (value !== 'instrument') return;
    const started = await capture.start({ ...preferences, refractory: refractorySeconds(host.getSession()) });
    if (request !== selectionGeneration) return;
    preparing = false;
    if (started) {
      preferences.deviceId = capture.deviceId; persistPreferences(); loadCompensation();
      status.textContent = 'Entrada ativa. Ajuste o canal e a sensibilidade, teste os ataques e calibre antes de treinar.';
    }
    render(); host.changed();
  }
  entry.addEventListener('change', () => { void selectMode(entry.value); });
  device.addEventListener('change', () => {
    if (!device.value) return;
    preferences.deviceId = device.value; persistPreferences();
    if (mode === 'instrument') void selectMode('instrument');
    else { status.textContent = 'Entrada selecionada. Selecione Instrumento para abri-la; o teclado continua ativo.'; render(); host.changed(); }
  });
  channel.addEventListener('change', () => { preferences.channel = channel.value; capture.configure({ channel: channel.value }); persistPreferences(); });
  sensitivity.addEventListener('input', () => { preferences.sensitivity = Number(sensitivity.value); capture.configure({ sensitivity: preferences.sensitivity }); persistPreferences(); });
  test.addEventListener('click', () => {
    testing = !testing; diagnostic.hidden = !testing; diagnostic.replaceChildren();
    test.textContent = testing ? 'Encerrar teste da entrada' : 'Testar entrada';
    status.textContent = testing ? 'Diagnóstico sem treino: toque no instrumento e confira instantes e níveis abaixo.' : 'Diagnóstico encerrado; entrada continua ativa.';
  });
  manual.addEventListener('change', () => {
    if (manual.value === '' || !manual.reportValidity()) { manual.value = storedCalibration ?? 0; return; }
    saveCompensation(Number(manual.value));
  });
  clearCalibration.addEventListener('click', () => saveCompensation(null));
  cancelCalibration.addEventListener('click', () => host.stop());
  calibrate.addEventListener('click', async () => {
    host.stop(); reset();
    calibration = { clicks: [], attacks: [] };
    const current = calibration;
    capture.configure({ refractory: CALIBRATION_REFRACTORY_SECONDS });
    status.textContent = 'Prepare-se: toque junto de cada um dos oito cliques.'; render(); host.changed();
    try {
      await audio.prepareInput();
      if (calibration !== current) return;
      current.clicks = await audio.calibrationClicks();
      if (calibration !== current) return;
      calibrationTimer = setTimeout(() => {
        if (calibration !== current) return;
        const result = calibrateInput(current.clicks, current.attacks);
        calibration = null; calibrationTimer = null; audio.stop();
        if (result.ok) { saveCompensation(result.compensationMs); status.textContent = `Compensação ${result.compensationMs} ms · dispersão ${Math.round(result.spreadMs)} ms.`; }
        else status.textContent = result.reason;
        reset(); render(); host.changed();
      }, Math.max(0, calibrationCollectionDeadline(current.clicks.at(-1), mode === 'instrument' ? capture.inputLatencySeconds : 0) - performance.now()));
    } catch (error) {
      if (calibration !== current) return;
      host.stop(); status.textContent = `Calibração não iniciada: ${error.message}`; render(); host.changed();
    }
  });

  function reset() {
    if (calibration) {
      status.textContent = 'Calibração cancelada; compensação anterior preservada.';
      $('train-state').textContent = 'Calibração interrompida. Você pode tentar novamente.';
    }
    const input = activeInput; activeInput = null;
    if (input?.source === 'pointer' && pad.hasPointerCapture(input.id)) pad.releasePointerCapture(input.id);
    gate.reset(); clearTimeout(calibrationTimer); calibrationTimer = null; calibration = null;
    if (capture.active) capture.configure({ refractory: refractorySeconds(host.getSession()) });
    flashedUntil = 0; render();
  }
  function keyboardAttack(time, source, id) {
    if (mode !== 'keyboard' || activeInput) return;
    activeInput = { source, id };
    if (calibration) calibration.attacks.push(time);
    else audio.press(compensatedTime(time, storedCalibration ?? 0), Number($('input-pitch').value));
  }
  function keyboardRelease(time) {
    if (!calibration) audio.release(compensatedTime(time, storedCalibration ?? 0));
    const input = activeInput; activeInput = null;
    if (input?.source === 'pointer' && pad.hasPointerCapture(input.id)) pad.releasePointerCapture(input.id);
  }
  pad.addEventListener('pointerdown', event => {
    if (mode !== 'keyboard' || event.button !== 0 || activeInput || (!calibration && !['countin', 'train'].includes(audio.position.mode))) return;
    event.preventDefault(); keyboardAttack(event.timeStamp, 'pointer', event.pointerId); pad.setPointerCapture(event.pointerId);
  });
  pad.addEventListener('pointerup', event => {
    if (activeInput?.source === 'pointer' && activeInput.id === event.pointerId) keyboardRelease(event.timeStamp);
  });
  for (const type of ['pointercancel', 'lostpointercapture']) pad.addEventListener(type, event => {
    if (activeInput?.source === 'pointer' && activeInput.id === event.pointerId) host.stop('Toque cancelado; recomece o treino.');
  });
  window.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.key === 'Escape' || document.querySelector('dialog[open], [role=dialog][aria-modal=true]')) return;
    if (event.target instanceof Element && (event.target.isContentEditable || event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable=false])'))) return;
    if (!calibration && host.isPreparingTraining() && event.code === 'Space') { event.preventDefault(); return; }
    if ((event.code === 'Space' || (event.code === 'Enter' && event.target === pad)) && (calibration || ['countin', 'train'].includes(audio.position.mode))) {
      event.preventDefault(); if (!event.repeat) keyboardAttack(event.timeStamp, 'keyboard', event.code);
    }
  }, { capture: true });
  window.addEventListener('keyup', event => {
    if (activeInput?.source !== 'keyboard' || activeInput.id !== event.code) return;
    event.preventDefault(); keyboardRelease(event.timeStamp);
  });
  function endCapture() {
    if (mode !== 'instrument' && !calibration && !recoveringDevices) return;
    ++selectionGeneration; preparing = false; recoveringDevices = false; enumeratingDevices = false;
    capture.stop(); mode = 'keyboard'; entry.value = mode;
    host.stop(); loadCompensation(); status.textContent = 'Captura encerrada ao sair da página ou perder o foco. Selecione Instrumento para reabrir.'; host.changed();
  }
  window.addEventListener('pagehide', endCapture);
  window.addEventListener('blur', endCapture);
  document.addEventListener('visibilitychange', () => { if (document.hidden) endCapture(); });

  function render() {
    instrumentPanel.hidden = mode !== 'instrument' && !recoveringDevices; reason.hidden = mode !== 'instrument';
    const locked = host.isBusy();
    $('train').disabled ||= preparing || !!calibration;
    entry.options[1].disabled = recoveringDevices && enumeratingDevices;
    device.disabled = preparing || locked || enumeratingDevices || (recoveringDevices && device.options.length < 2);
    channel.disabled = mode !== 'instrument' || preparing || locked;
    sensitivity.disabled = mode !== 'instrument' || preparing || !!calibration;
    test.disabled = !capture.active || locked;
    calibrate.disabled = preparing || locked || (mode === 'instrument' && !capture.active);
    cancelCalibration.hidden = !calibration; manual.disabled = clearCalibration.disabled = locked || preparing;
    compensation.textContent = storedCalibration === null ? 'Sem calibração. Compensação 0 ms.' : `Compensação ${storedCalibration} ms (${mode === 'instrument' ? 'dispositivo atual' : 'teclado/toque'}).`;
    const goal = $('training-goal');
    if (goal) {
      for (const option of goal.options) option.disabled = mode === 'instrument' && option.value !== 'timing';
      if (mode === 'instrument') { goal.value = 'timing'; goal.disabled = true; goal.title = reason.textContent; }
      else goal.title = '';
    }
    $('input-pitch').disabled = mode === 'instrument' || locked;
    const monitor = document.querySelector('[data-path="training.monitor"]');
    if (monitor && mode === 'instrument') { monitor.disabled = true; monitor.title = 'O instrumento já é audível: não duplicamos cada ataque com uma nota sintetizada.'; }
    if (monitor && mode === 'keyboard') monitor.title = '';
    pad.disabled = !calibration && !['countin', 'train'].includes(audio.position.mode);
    pad.setAttribute('aria-label', mode === 'instrument' ? 'Indicador dos ataques do instrumento e nível de entrada' : 'Tocar o ritmo: pressione no início da nota e solte no final');
    pad.title = mode === 'instrument' ? 'Ataques capturados localmente; teclado e toque não enviam notas neste modo' : 'Espaço: pressione no ataque, segure e solte no término';
  }
  function frame(position, session) {
    pad.classList.toggle('active', ['countin', 'train'].includes(position.mode) || !!calibration);
    pad.classList.toggle('held', mode === 'instrument' ? performance.now() < flashedUntil : !!position.held || (!!calibration && !!activeInput));
    pad.classList.toggle('instrument-input', mode === 'instrument');
    $('held-state').textContent = mode === 'instrument' ? 'INSTRUMENTO · ataques e nível' : position.held ? 'PRESSIONADA · nota em curso' : 'ESPAÇO ou toque · pressionar / soltar';
    if (calibration) $('train-state').textContent = `Calibração · ${calibration.clicks.filter(time => time <= performance.now()).length}/8 cliques · toque junto.`;
    else if (position.mode === 'countin') $('train-state').textContent = mode === 'instrument' ? 'Espere sem tocar durante a contagem. Use fones.' : 'Espere a contagem de entrada. Depois, toque o ritmo.';
    else if (position.mode === 'train') $('train-state').textContent = `Repetição ${position.repetition}/${session.training.repetitions} · ${mode === 'instrument' ? 'toque cada ataque no instrumento; avaliamos só ataques.' : 'pressione no início de cada nota e solte no final.'}`;
  }
  render();
  return {
    reset, render, frame,
    get instrument() { return mode === 'instrument'; },
    get calibrating() { return !!calibration; },
    get preparing() { return preparing; },
    session(value) {
      return mode === 'instrument' ? instrumentSession(value, { compensationMs: storedCalibration })
        : { ...value, extensions: { ...value.extensions, performanceInput: { mode: 'keyboard', calibrated: storedCalibration !== null } } };
    },
    playOptions(playMode) {
      return playMode === 'train' ? { inputTailSeconds: inputTailSeconds({ instrument: mode === 'instrument', inputLatencySeconds: mode === 'instrument' ? capture.inputLatencySeconds : 0, compensationMs: storedCalibration ?? 0 }) } : {};
    },
    started(value) {
      gate.reset(); testing = false; diagnostic.hidden = true; test.textContent = 'Testar entrada';
      leakClicks = audio.countInClicks; leakAttacks = []; leakWarned = false;
      capture.configure({ refractory: refractorySeconds(value) });
    },
    instruction() { return mode === 'instrument' ? 'Depois da contagem, toque no instrumento. Avaliamos só ataques; use fones para evitar vazamento.' : 'Depois da contagem, toque com Espaço ou na área de toque. Instrumento é uma entrada opcional, ativada somente por você.'; },
    resultNote(value) {
      const input = value.extensions?.performanceInput;
      if (input?.mode === 'instrument') return `Instrumento: términos e alturas não avaliados; os términos mostrados são gates escritos, não sustentações medidas.${input.calibrated ? '' : ' Sem calibração: calibre a entrada para compensar o atraso residual.'}`;
      return input?.mode === 'keyboard' && !input.calibrated ? 'Teclado/toque sem calibração: calibre a entrada para compensar o atraso residual do dispositivo.' : '';
    },
  };
}
