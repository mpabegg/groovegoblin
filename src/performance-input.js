import { InstrumentCapture } from './instrument-capture.js';
import { InstrumentInputGate, instrumentSession } from './instrument-input.js';
import { refractorySeconds } from './instrument-onsets.js';
import { calibrateInput, compensatedTime, detectClickLeak, inputTailSeconds, calibrationCollectionDeadline, CALIBRATION_REFRACTORY_SECONDS, INPUT_PREFERENCES_KEY, readInputPreferences, readCalibration, saveCalibration } from './input-timing.js';
import { getInstrumentProfile } from './instrument-profile.js';
import { mountInstrumentTuner } from './instrument-tuner.js';
import { InstrumentPitchEvaluation, instrumentPitchAvailable, INSTRUMENT_PITCH_TAIL_SECONDS } from './instrument-pitch-evaluation.js';
import { createDiagnosticLog, createSampleRecorder, diagnosticReport, encodeSampleWav, SAMPLE_SECONDS } from './instrument-diagnostics.js';

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
  const trainingActive = (position = audio.position) => position.mode === 'train' || (position.mode === 'countin' && position.training !== false);
  const pad = $('train-pad');
  const preferences = readInputPreferences();
  const gate = new InstrumentInputGate(audio);
  const pitchEvaluation = new InstrumentPitchEvaluation();
  let unsubscribeEvaluationPitch = null;
  let mode = 'keyboard'; // Intent is remembered; capture never starts at mount.
  let activeInput = null;
  let preparing = false;
  let selectionGeneration = 0;
  let inPractice = false;
  let preparation = Promise.resolve();
  let cancelPreparation = () => {};
  let permissionStatus = null;
  let permissionListener = null;
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
  const diagnostics = createDiagnosticLog();
  let diagnosticPitchOff = null;
  let sampleRecorder = null;
  let observedSampleRate = null;

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
  const reason = el('p', { id: 'instrument-goal-reason', className: 'tool-hint muted', text: 'Instrumento avalia ataques e, em frases monofônicas, alturas (±50 cents; baixa confiança = não identificada). Durações não são medidas; use Teclado para avaliar pressão e soltura.', hidden: true });
  const test = el('button', { id: 'instrument-test', type: 'button', text: 'Testar entrada' });
  const diagnostic = el('ol', { id: 'instrument-diagnostic', className: 'instrument-diagnostic', hidden: true, 'aria-label': 'Ataques detectados: instante e nível' });
  const exportDiagnostics = el('button', { id: 'input-diagnostics-export', type: 'button', text: 'Exportar diagnóstico (JSON)' });
  const sampleButton = el('button', { id: 'instrument-sample', type: 'button', text: `Salvar amostra · ${SAMPLE_SECONDS} s` });
  const cancelSample = el('button', { id: 'instrument-sample-cancel', type: 'button', text: 'Cancelar amostra', hidden: true });
  const sampleProgress = el('progress', { id: 'instrument-sample-progress', max: SAMPLE_SECONDS, value: 0, hidden: true, 'aria-label': `Progresso da amostra de ${SAMPLE_SECONDS} segundos` });
  const sampleStatus = el('output', { id: 'instrument-sample-status', role: 'status', 'aria-live': 'polite' });
  const instrumentPanel = el('div', { id: 'instrument-panel', hidden: true },
    el('div', { className: 'tool-row' }, label('Dispositivo', device), label('Canal', channel), label('Sensibilidade', sensitivity)),
    el('p', { className: 'tool-hint muted', text: 'Use fones: o clique e a banda podem vazar no microfone e gerar ataques falsos. Durante a contagem, espere sem tocar para diagnosticar vazamento.' }), test, diagnostic,
    el('div', { className: 'tool-row' }, exportDiagnostics, sampleButton, cancelSample, sampleProgress), sampleStatus,
    el('p', { className: 'tool-hint muted', text: `Exportar diagnóstico baixa um JSON com dispositivo, canal, taxa real, sensibilidade, compensação, perfil e os ataques realmente observados (instante, nível, altura estimada e confiança) do último Testar entrada ou treino — sem áudio. Salvar amostra é a única exceção que grava: ${SAMPLE_SECONDS} s do canal escolhido, baixados como WAV neste dispositivo; cancelar ou sair descarta a gravação.` }));
  const calibrate = el('button', { id: 'input-calibrate', type: 'button', text: 'Calibrar latência · 8 cliques' });
  const cancelCalibration = el('button', { id: 'input-calibration-cancel', type: 'button', text: 'Cancelar calibração', hidden: true });
  const manual = el('input', { id: 'input-compensation', type: 'number', min: '-500', max: '500', step: '1', value: storedCalibration ?? 0 });
  const clearCalibration = el('button', { id: 'input-calibration-reset', type: 'button', text: 'Zerar calibração' });
  const compensation = el('output', { id: 'input-compensation-status' });
  const activateInstrument = el('button', { id: 'instrument-activate', type: 'button', text: 'Ativar instrumento' });
  const summary = el('output', { id: 'instrument-summary' });
  const configure = el('button', { id: 'input-configure', type: 'button', text: 'Configurar', 'aria-controls': 'input-configuration', 'aria-expanded': 'false' });
  const tunerButton = el('button', { id: 'instrument-tuner-open', type: 'button', text: 'Afinador', 'aria-haspopup': 'dialog', 'aria-controls': 'instrument-tuner' });
  const configuration = el('div', { id: 'input-configuration', hidden: true },
    reason, instrumentPanel,
    el('details', { id: 'input-calibration', className: 'control-detail' },
      el('summary', { text: 'Calibração de latência (teclado ou instrumento)' }),
      el('p', { className: 'tool-hint muted', text: 'Toque junto dos oito cliques. Os dois primeiros são aquecimento; a mediana dos seis restantes compensa o atraso residual. Use fones e pulso estável. A calibração inclui seu tempo de resposta, não é uma medição laboratorial.' }),
      el('div', { className: 'tool-row' }, calibrate, cancelCalibration, label('Compensação manual (ms)', manual), clearCalibration), compensation),
    el('p', { id: 'instrument-privacy', className: 'tool-hint muted', text: `Privacidade: o áudio da entrada é analisado somente neste dispositivo; nada é enviado nem guardado no navegador. Exceção explícita: "Salvar amostra · ${SAMPLE_SECONDS} s" grava ${SAMPLE_SECONDS} segundos do canal escolhido apenas enquanto você pede e baixa um WAV local; cancelar, trocar de canal ou sair descarta a gravação. Ativar instrumento pode pedir permissão. A última entrada escolhida é lembrada; ao entrar em Praticar, reabrimos somente se a permissão já estiver concedida. Teclado, sair de Praticar ou perder foco encerra a captura.` }));
  const panel = el('section', { className: 'performance-entry', 'aria-label': 'Entrada e calibração' },
    el('div', { className: 'input-compact' }, label('Entrada', entry), activateInstrument, summary,
      el('div', { className: 'instrument-meter' }, level, levelText), tunerButton, configure),
    configuration, status);
  $('performance-input').prepend(panel);
  configure.addEventListener('click', () => {
    configuration.hidden = !configuration.hidden;
    configure.setAttribute('aria-expanded', String(!configuration.hidden));
  });

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
      const hadPracticeInput = mode === 'instrument' || preparing;
      tuner.suspend(`${message} Verifique a permissão; para trocar de dispositivo, feche e use Praticar → Configurar.`);
      const request = ++selectionGeneration;
      watchPermission(null);
      preparing = false; mode = 'keyboard'; entry.value = mode;
      testing = false; diagnostic.hidden = true; test.textContent = 'Testar entrada';
      closeDiagnostics(); stopSample('Captura encerrada durante a amostra; o áudio foi descartado.');
      recoveringDevices = recover; enumeratingDevices = recover;
      if (recover) { configuration.hidden = false; configure.setAttribute('aria-expanded', 'true'); }
      if (recover) {
        device.replaceChildren(el('option', { value: '', text: 'Procurando entradas disponíveis…', disabled: true }));
        device.value = '';
      }
      if (hadPracticeInput && (audio.position.mode !== 'idle' || calibration)) host.stop();
      if (hadPracticeInput) reset();
      loadCompensation(); status.textContent = hadPracticeInput ? `${message} Voltamos ao Teclado.` : message;
      host.notify(status.textContent, true); host.changed();
      if (recover) void recoverDevices(request);
    },
    onAttack(attack) {
      if (mode !== 'instrument') return; // A tuner-only capture never submits practice attacks.
      flashedUntil = performance.now() + 120;
      if (testing) {
        const item = el('li', { text: `${(attack.time / 1000).toFixed(3)} s · nível ${(attack.level * 100).toFixed(1)}%` });
        diagnostic.prepend(item); while (diagnostic.children.length > 32) diagnostic.lastChild.remove();
      }
      if (calibration) { calibration.attacks.push(attack.time); return; }
      if (testing || trainingActive()) {
        observedSampleRate = attack.sampleRate ?? observedSampleRate;
        diagnostics.attack(attack);
      }
      const time = compensatedTime(attack.time, storedCalibration ?? 0);
      const currentMode = audio.position.mode;
      if (trainingActive()) pitchEvaluation.attack(attack, gate.attack(time));
      if (trainingActive() && currentMode === 'countin' && !audio.position.held) {
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
  const tuner = mountInstrumentTuner({
    capture, button: tunerButton, getSession: host.getSession,
    settings: () => ({ ...preferences, instrumentType: getInstrumentProfile(host.getSession()).type, refractory: refractorySeconds(host.getSession()) }),
    practiceActive: () => mode === 'instrument',
    practicePreparing: () => preparing,
    preparation: () => preparation,
    ready: () => { void monitorPermission(); },
    closed: () => { stopSample('Captura encerrada durante a amostra; o áudio foi descartado.'); if (!capture.active && !preparing) watchPermission(null); },
  });
  // Diagnostics borrow the live capture: subscribing to pitch only while a
  // Test/training is observed keeps the real estimate paired with each attack.
  function openDiagnostics(source) {
    diagnostics.reset(source);
    diagnosticPitchOff ??= capture.subscribePitch(event => {
      if (event.stopped) return;
      observedSampleRate = event.sampleRate ?? observedSampleRate;
      diagnostics.pitch(event);
    });
  }
  function closeDiagnostics() { diagnosticPitchOff?.(); diagnosticPitchOff = null; }
  function stopSample(message = '') {
    const recorder = sampleRecorder;
    sampleRecorder = null;
    if (!recorder) return false;
    recorder.cancel();
    if (message) sampleStatus.textContent = message;
    return true;
  }
  function channelText() { return channel.options[['1', '2', 'sum'].indexOf(preferences.channel)]?.textContent ?? preferences.channel; }
  function downloadFile(name, blob) {
    if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return false;
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: name, hidden: true });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  }
  async function monitorPermission() {
    if (permissionStatus || !navigator.permissions?.query) return;
    const request = selectionGeneration;
    try {
      const permission = await navigator.permissions.query({ name: 'microphone' });
      if (request === selectionGeneration && capture.active) {
        if (permission.state === 'granted') watchPermission(permission);
        else endCapture('Permissão da entrada revogada. Ative instrumento para tentar novamente.');
      }
    } catch { /* An explicit capture also works without Permissions API support. */ }
  }

  function watchPermission(value) {
    if (permissionStatus && permissionListener) permissionStatus.removeEventListener?.('change', permissionListener);
    permissionStatus = value;
    permissionListener = () => { if (value.state !== 'granted') endCapture('Permissão da entrada revogada. Ative instrumento para tentar novamente.'); };
    value?.addEventListener?.('change', permissionListener);
  }
  async function selectMode(value, { automatic = false, reopen = false } = {}) {
    if (!automatic) { preferences.lastMode = value; persistPreferences(); }
    if (value === 'instrument' && !reopen && (capture.active || preparing)) return preparation;
    const request = ++selectionGeneration;
    recoveringDevices = false; enumeratingDevices = false;
    if (!automatic) host.stop();
    reset(); capture.stop(); testing = false; diagnostic.hidden = true;
    test.textContent = 'Testar entrada'; diagnostics.reset(null); sampleStatus.textContent = '';
    mode = value; entry.value = value; preparing = value === 'instrument';
    status.textContent = preparing ? 'Abrindo entrada de áudio…' : 'Entrada por teclado/toque; captura encerrada.';
    loadCompensation(); host.changed();
    if (value !== 'instrument') return;
    const started = await capture.start({ ...preferences, instrumentType: getInstrumentProfile(host.getSession()).type, refractory: refractorySeconds(host.getSession()) });
    if (request !== selectionGeneration) return;
    preparing = false;
    if (started) {
      preferences.deviceId = capture.deviceId; persistPreferences(); loadCompensation();
      status.textContent = '';
    }
    render(); host.changed();
  }
  function trackPreparation(operation) {
    cancelPreparation();
    preparation = Promise.race([operation, new Promise(resolve => { cancelPreparation = resolve; })]);
    return preparation;
  }
  function chooseMode(value, options) {
    if (value === 'instrument' && !options?.reopen && (capture.active || preparing)) {
      if (capture.active && mode !== 'instrument') {
        host.stop(); reset(); mode = 'instrument'; entry.value = mode;
        loadCompensation(); status.textContent = ''; render(); host.changed();
      }
      preferences.lastMode = 'instrument'; persistPreferences();
      return preparation;
    }
    return trackPreparation(selectMode(value, options));
  }
  async function restoreInstrument(request) {
    if (preferences.lastMode !== 'instrument' || !navigator.permissions?.query || document.hidden) return;
    try {
      const permission = await navigator.permissions.query({ name: 'microphone' });
      if (request !== selectionGeneration || !inPractice || document.hidden) return;
      if (permission.state !== 'granted') return;
      watchPermission(permission);
      await selectMode('instrument', { automatic: true });
    } catch { /* Unsupported microphone permission queries never prompt. */ }
  }
  function activate(id) {
    const entered = id === 'tab-practice';
    if (entered === inPractice) return preparation;
    inPractice = entered;
    if (!entered) { endCapture('Captura encerrada ao sair de Praticar.'); return preparation; }
    if (capture.active || preparing) return preparation;
    const request = ++selectionGeneration;
    return trackPreparation(restoreInstrument(request));
  }
  entry.addEventListener('change', () => { void chooseMode(entry.value); });
  activateInstrument.addEventListener('click', () => { void chooseMode('instrument'); });
  device.addEventListener('change', () => {
    if (!device.value) return;
    preferences.deviceId = device.value; persistPreferences();
    if (mode === 'instrument') void chooseMode('instrument', { reopen: true });
    else { status.textContent = 'Entrada selecionada. Ative instrumento para abri-la; o teclado continua ativo.'; render(); host.changed(); }
  });
  channel.addEventListener('change', () => {
    stopSample('Canal alterado durante a amostra; a gravação foi descartada.');
    preferences.channel = channel.value; capture.configure({ channel: channel.value }); persistPreferences(); render();
  });
  sensitivity.addEventListener('input', () => { preferences.sensitivity = Number(sensitivity.value); capture.configure({ sensitivity: preferences.sensitivity }); persistPreferences(); });
  test.addEventListener('click', () => {
    testing = !testing; diagnostic.hidden = !testing; diagnostic.replaceChildren();
    test.textContent = testing ? 'Encerrar teste da entrada' : 'Testar entrada';
    if (testing) { openDiagnostics('test'); sampleStatus.textContent = ''; }
    else closeDiagnostics();
    status.textContent = testing ? 'Diagnóstico sem treino: toque no instrumento e confira instantes e níveis abaixo.' : 'Diagnóstico encerrado; entrada continua ativa.';
    render();
  });
  exportDiagnostics.addEventListener('click', () => {
    const selected = [...device.options].find(option => option.value === capture.deviceId);
    const report = diagnosticReport({
      attacks: diagnostics.entries(), source: diagnostics.source,
      device: { deviceId: capture.deviceId, calibrationDeviceId: capture.calibrationDeviceId, label: selected?.textContent ?? '' },
      channel: preferences.channel, sampleRate: capture.sampleRate ?? observedSampleRate,
      sensitivity: preferences.sensitivity, compensation: storedCalibration,
      profile: getInstrumentProfile(host.getSession()),
    });
    sampleStatus.textContent = downloadFile('groovegoblin-entrada-diagnostico.json', new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
      ? `Diagnóstico exportado: ${report.attacks.length} ataque(s) observado(s), sem áudio.`
      : 'Download indisponível neste ambiente.';
  });
  sampleButton.addEventListener('click', () => {
    const rate = capture.sampleRate;
    if (sampleRecorder || !capture.active || !Number.isFinite(rate)) { sampleStatus.textContent = 'Ative o instrumento antes de salvar a amostra.'; return; }
    const recorder = createSampleRecorder({
      capture, channel: preferences.channel, sampleRate: rate,
      onProgress({ seconds, total }) { sampleProgress.value = seconds; sampleProgress.max = total; sampleStatus.textContent = `Gravando ${seconds.toFixed(1)} s de ${total} s do canal ${channelText()}…`; },
      onFinish({ data, sampleRate }) {
        sampleRecorder = null;
        const ok = downloadFile(`groovegoblin-amostra-${SAMPLE_SECONDS}s-canal-${preferences.channel}.wav`, new Blob([encodeSampleWav({ data, sampleRate })], { type: 'audio/wav' }));
        sampleStatus.textContent = ok ? `Amostra de ${SAMPLE_SECONDS} s do canal ${channelText()} baixada em ${sampleRate} Hz (WAV PCM 16 bits).` : 'Download indisponível neste ambiente; a amostra foi descartada.';
        render();
      },
      onCancel() { sampleRecorder = null; sampleStatus.textContent = 'Amostra cancelada; a gravação foi descartada e a entrada continua ativa.'; render(); },
      onError(message) { sampleRecorder = null; sampleStatus.textContent = message; host.notify(message, true); render(); },
    });
    if (!recorder.start()) { sampleStatus.textContent = 'Não foi possível iniciar a amostra; verifique a entrada.'; return; }
    sampleRecorder = recorder; render();
  });
  cancelSample.addEventListener('click', () => stopSample());
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
    unsubscribeEvaluationPitch?.(); unsubscribeEvaluationPitch = null; pitchEvaluation.reset();
    closeDiagnostics();
    stopSample('Amostra cancelada ao reiniciar o transporte; a gravação foi descartada.');
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
    if (mode !== 'keyboard' || event.button !== 0 || activeInput || (!calibration && !trainingActive())) return;
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
    if ((event.code === 'Space' || (event.code === 'Enter' && event.target === pad)) && (calibration || trainingActive())) {
      event.preventDefault(); if (!event.repeat) keyboardAttack(event.timeStamp, 'keyboard', event.code);
    }
  }, { capture: true });
  window.addEventListener('keyup', event => {
    if (activeInput?.source !== 'keyboard' || activeInput.id !== event.code) return;
    event.preventDefault(); keyboardRelease(event.timeStamp);
  });
  function endCapture(message = 'Captura encerrada ao perder foco. Ative instrumento para reabrir.') {
    ++selectionGeneration;
    watchPermission(null);
    cancelPreparation();
    preparation = Promise.resolve();
    const hadCapture = mode === 'instrument' || preparing || !!calibration || recoveringDevices;
    preparing = false; recoveringDevices = false; enumeratingDevices = false;
    capture.stop(); mode = 'keyboard'; entry.value = mode;
    tuner.suspend(typeof message === 'string' ? message : 'Captura encerrada ao perder foco. Ative entrada para reabrir.');
    stopSample('Captura encerrada; a amostra foi descartada.');
    if (hadCapture) host.stop();
    reset(); loadCompensation(); status.textContent = typeof message === 'string' ? message : 'Captura encerrada ao perder foco. Ative instrumento para reabrir.'; host.changed();
  }
  window.addEventListener('pagehide', endCapture);
  window.addEventListener('blur', endCapture);
  document.addEventListener('visibilitychange', () => { if (document.hidden) endCapture(); });

  function render() {
    instrumentPanel.hidden = mode !== 'instrument' && !recoveringDevices; reason.hidden = mode !== 'instrument';
    activateInstrument.hidden = mode === 'instrument';
    activateInstrument.disabled = preparing;
    const selectedDevice = [...device.options].find(option => option.value === capture.deviceId);
    summary.textContent = mode === 'instrument'
      ? `Instrumento · ${selectedDevice?.textContent || 'Entrada de áudio'} · ${channel.options[[ '1', '2', 'sum' ].indexOf(preferences.channel)]?.textContent ?? preferences.channel} · ${storedCalibration ?? 0} ms`
      : `Teclado · ${storedCalibration ?? 0} ms`;
    level.hidden = levelText.hidden = mode !== 'instrument';
    const locked = host.isBusy();
    $('train').disabled ||= preparing || !!calibration;
    entry.options[1].disabled = recoveringDevices && enumeratingDevices;
    device.disabled = preparing || locked || enumeratingDevices || (recoveringDevices && device.options.length < 2);
    channel.disabled = mode !== 'instrument' || preparing || locked;
    sensitivity.disabled = mode !== 'instrument' || preparing || !!calibration;
    test.disabled = !capture.active || locked;
    exportDiagnostics.disabled = mode !== 'instrument' || preparing || locked || !capture.active;
    sampleButton.disabled = exportDiagnostics.disabled || !!calibration || !!sampleRecorder;
    cancelSample.hidden = !sampleRecorder;
    sampleProgress.hidden = !sampleRecorder;
    if (!sampleRecorder) sampleProgress.value = 0;
    calibrate.disabled = preparing || locked || (mode === 'instrument' && !capture.active);
    cancelCalibration.hidden = !calibration; manual.disabled = clearCalibration.disabled = locked || preparing;
    compensation.textContent = storedCalibration === null ? 'Sem calibração. Compensação 0 ms.' : `Compensação ${storedCalibration} ms (${mode === 'instrument' ? 'dispositivo atual' : 'teclado/toque'}).`;
    const goal = $('training-goal');
    if (goal) {
      const pitchAvailable = instrumentPitchAvailable(host.getSession());
      for (const option of goal.options) option.disabled = mode === 'instrument' && option.value !== 'timing' && !(option.value === 'pitch' && pitchAvailable);
      if (mode === 'instrument' && goal.value !== 'timing' && !(goal.value === 'pitch' && pitchAvailable)) goal.value = 'timing';
      goal.title = mode === 'instrument' ? `${reason.textContent}${pitchAvailable ? '' : ' Alturas exigem uma frase de referência sem notas sobrepostas, fora da execução livre.'}` : '';
    }
    $('input-pitch').disabled = mode === 'instrument' || locked;
    const monitor = document.querySelector('[data-path="training.monitor"]');
    if (monitor && mode === 'instrument') { monitor.disabled = true; monitor.title = 'O instrumento já é audível: não duplicamos cada ataque com uma nota sintetizada.'; }
    if (monitor && mode === 'keyboard') monitor.title = '';
    pad.disabled = !calibration && !trainingActive();
    pad.setAttribute('aria-label', mode === 'instrument' ? 'Indicador dos ataques do instrumento e nível de entrada' : 'Tocar o ritmo: pressione no início da nota e solte no final');
    pad.title = mode === 'instrument' ? 'Ataques capturados localmente; teclado e toque não enviam notas neste modo' : 'Espaço: pressione no ataque, segure e solte no término';
  }
  function frame(position, session) {
    pad.classList.toggle('active', trainingActive(position) || !!calibration);
    pad.classList.toggle('held', mode === 'instrument' ? performance.now() < flashedUntil : !!position.held || (!!calibration && !!activeInput));
    pad.classList.toggle('instrument-input', mode === 'instrument');
    $('held-state').textContent = mode === 'instrument' ? `INSTRUMENTO · ${session.training.goal === 'pitch' ? 'ataques e alturas' : 'ataques e nível'}` : position.held ? 'PRESSIONADA · nota em curso' : 'ESPAÇO ou toque · pressionar / soltar';
    if (calibration) $('train-state').textContent = `Calibração · ${calibration.clicks.filter(time => time <= performance.now()).length}/8 cliques · toque junto.`;
    else if (trainingActive(position) && position.mode === 'countin') $('train-state').textContent = mode === 'instrument' ? 'Espere sem tocar durante a contagem. Use fones.' : 'Espere a contagem de entrada. Depois, toque o ritmo.';
    else if (position.mode === 'train') $('train-state').textContent = `Repetição ${position.repetition}/${session.training.repetitions} · ${mode === 'instrument' ? `toque uma nota por vez; avaliamos ${session.training.goal === 'pitch' ? 'ataques e alturas' : 'só ataques'}.` : 'pressione no início de cada nota e solte no final.'}`;
  }
  render();
  return {
    reset, render, frame, activate,
    subscribePitch: listener => capture.subscribePitch(listener),
    subscribeAttacks: listener => capture.subscribeAttacks(listener),
    async prepareTraining() { await preparation; return inPractice && !document.hidden; },
    get instrument() { return mode === 'instrument'; },
    get calibrating() { return !!calibration; },
    get preparing() { return preparing; },
    session(value) {
      return mode === 'instrument' ? instrumentSession(value, { compensationMs: storedCalibration })
        : { ...value, extensions: { ...value.extensions, performanceInput: { mode: 'keyboard', calibrated: storedCalibration !== null } } };
    },
    playOptions(playMode, value = host.getSession()) {
      return playMode === 'train' ? { inputTailSeconds: inputTailSeconds({ instrument: mode === 'instrument', inputLatencySeconds: mode === 'instrument' ? capture.inputLatencySeconds : 0, compensationMs: storedCalibration ?? 0 }) + (mode === 'instrument' && value.training.goal === 'pitch' && instrumentPitchAvailable(value) ? INSTRUMENT_PITCH_TAIL_SECONDS : 0) } : {};
    },
    started(value) {
      unsubscribeEvaluationPitch?.(); unsubscribeEvaluationPitch = null; pitchEvaluation.reset();
      if (mode === 'instrument' && value.training.goal === 'pitch') {
        pitchEvaluation.start(); unsubscribeEvaluationPitch = capture.subscribePitch(event => pitchEvaluation.pitch(event));
      }
      gate.reset(); testing = false; diagnostic.hidden = true; test.textContent = 'Testar entrada';
      if (mode === 'instrument') openDiagnostics('training');
      leakClicks = audio.countInClicks; leakAttacks = []; leakWarned = false;
      capture.configure({ refractory: refractorySeconds(value), instrumentType: getInstrumentProfile(value).type });
    },
    instruction() { return mode === 'instrument' ? 'Depois da contagem, toque uma nota por vez no instrumento. Ataques e alturas usa ±50 cents e separa oitavas; baixa confiança fica não identificada. Use fones para evitar vazamento.' : 'Depois da contagem, toque com Espaço ou na área de toque. Instrumento é uma entrada opcional, ativada somente por você.'; },
    resultNote(value) {
      const input = value.extensions?.performanceInput;
      if (input?.mode === 'instrument') return `Instrumento: ${value.training.goal === 'pitch' ? 'alturas monofônicas com tolerância de ±50 cents; oitavas diferentes separadas e baixa confiança não identificada' : 'alturas não avaliadas neste objetivo'}. Términos não avaliados: são gates escritos, não sustentações medidas.${input.calibrated ? '' : ' Sem calibração: calibre a entrada para compensar o atraso residual.'}`;
      return input?.mode === 'keyboard' && !input.calibrated ? 'Teclado/toque sem calibração: calibre a entrada para compensar o atraso residual do dispositivo.' : '';
    },
  };
}
