import { captureFrameTime } from './input-timing.js';
import { createPitchStream } from './instrument-pitch.js';

const errors = {
  NotAllowedError: 'Permissão de microfone negada. Autorize o dispositivo no navegador para usar Instrumento.',
  NotFoundError: 'Nenhuma entrada de áudio encontrada. Conecte o microfone ou a interface.',
  NotReadableError: 'Não foi possível abrir a entrada de áudio; ela pode estar em uso ou desconectada.',
  OverconstrainedError: 'O dispositivo escolhido não está disponível. Escolha outra entrada.',
};

const isAlias = id => !id || ['default', 'communications'].includes(id);
const physicalLabel = label => (label ?? '').replace(/^(?:default|padrão|communications|comunicações)\s*[-–:]\s*/i, '').trim();

// A system-default alias is not a physical calibration identity.
export function resolveInputDevice(settings, devices, requestedDeviceId = '', trackLabel = '') {
  if (!isAlias(settings.deviceId)) return { deviceId: settings.deviceId, calibrationDeviceId: settings.deviceId };
  const alias = devices.find(device => device.deviceId === settings.deviceId);
  const groupId = settings.groupId || alias?.groupId;
  const physical = devices.filter(device => !isAlias(device.deviceId));
  const grouped = groupId ? physical.filter(device => device.groupId === groupId) : [];
  const label = physicalLabel(trackLabel || alias?.label);
  const exactLabel = (grouped.length ? grouped : physical).filter(device => label && physicalLabel(device.label) === label);
  const requested = physical.find(device => device.deviceId === requestedDeviceId && (!groupId || device.groupId === groupId));
  const resolved = grouped.length === 1 ? grouped[0] : exactLabel.length === 1 ? exactLabel[0] : requested;
  if (resolved) return { deviceId: resolved.deviceId, calibrationDeviceId: resolved.deviceId };
  // Some browsers expose only a default endpoint but identify its physical group.
  // Without either identity, callers must not persist/reuse a default calibration.
  return { deviceId: settings.deviceId || requestedDeviceId || 'default', calibrationDeviceId: groupId ? `group:${groupId}` : null };
}

export class InstrumentCapture {
  #generation = 0;
  #stream = null;
  #context = null;
  #source = null;
  #worklet = null;
  #mute = null;
  #deviceListener = null;
  #pitchListeners = new Set();
  #attackListeners = new Set();
  #pitchStream = null;
  constructor({ onAttack, onLevel, onError, onDevices = () => {} }) {
    this.onAttack = onAttack; this.onLevel = onLevel; this.onError = onError; this.onDevices = onDevices;
    this.deviceId = ''; this.calibrationDeviceId = null; this.inputLatencySeconds = 0; this.settings = {};
  }
  get active() { return this.#worklet !== null; }
  subscribePitch(listener) {
    this.#pitchListeners.add(listener);
    this.configure({ pitchEnabled: true });
    return () => { this.#pitchListeners.delete(listener); this.configure({ pitchEnabled: this.#pitchListeners.size > 0 }); };
  }
  subscribeAttacks(listener) {
    this.#attackListeners.add(listener);
    return () => this.#attackListeners.delete(listener);
  }
  async devices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
  }
  async start(settings) {
    this.stop();
    const generation = this.#generation;
    this.settings = { ...settings, pitchEnabled: this.#pitchListeners.size > 0 };
    let stream = null;
    let context = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode) throw new Error('Instrumento precisa de HTTPS/localhost e de um navegador com AudioWorklet e captura de áudio.');
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 2 }, ...(settings.deviceId ? { deviceId: { exact: settings.deviceId } } : {}),
      }, video: false });
      if (generation !== this.#generation) { stream.getTracks().forEach(track => track.stop()); return false; }
      this.#stream = stream;
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('A entrada escolhida não forneceu uma faixa de áudio.');
      const actual = track.getSettings();
      const devices = await this.devices();
      if (generation !== this.#generation) return false;
      Object.assign(this, resolveInputDevice(actual, devices, settings.deviceId, track.label));
      this.inputLatencySeconds = Number.isFinite(actual.latency) && actual.latency >= 0 ? actual.latency : 0;
      track.onended = () => this.#fail('Entrada de áudio desconectada. O treino foi interrompido.', true);
      track.onmute = () => this.#fail('Entrada de áudio interrompida pelo dispositivo ou navegador.', true);
      context = new AudioContext({ latencyHint: 'interactive' });
      this.#context = context;
      await context.audioWorklet.addModule(new URL('./instrument-worklet.js', import.meta.url));
      if (generation !== this.#generation) return false;
      await context.resume();
      if (generation !== this.#generation) return false;
      this.#source = context.createMediaStreamSource(stream);
      this.#worklet = new AudioWorkletNode(context, 'instrument-onsets', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'max', processorOptions: this.settings });
      this.#mute = context.createGain(); this.#mute.gain.value = 0;
      this.#source.connect(this.#worklet).connect(this.#mute).connect(context.destination);
      this.#pitchStream = null;
      this.#worklet.onprocessorerror = () => this.#fail('O analisador de ataques parou. Selecione Instrumento novamente para reiniciar.');
      this.#worklet.port.onmessage = ({ data }) => {
        if (generation !== this.#generation) return;
        const pair = { contextTime: context.currentTime, performanceTime: performance.now() };
        const frameTime = frame => captureFrameTime(frame, context.sampleRate, pair, this.inputLatencySeconds);
        if (data.type === 'samples') {
          if (!this.#pitchListeners.size || data.channel !== this.settings.channel) return;
          this.#pitchStream ??= createPitchStream(context.sampleRate);
          this.#pitchStream.push(data.samples, data.startFrame, result => {
            const pitch = { ...result, sampleRate: context.sampleRate, captureId: generation, deviceId: this.deviceId,
              time: frameTime(result.frame), startTime: frameTime(result.startFrame), endTime: frameTime(result.endFrame) };
            for (const listener of this.#pitchListeners) listener(pitch);
          });
          return;
        }
        this.onLevel(data.level, data.channels);
        for (const event of data.events) {
          const attack = { ...event, id: `${generation}:${event.frame}`, captureId: generation, sampleRate: context.sampleRate, time: frameTime(event.frame), deviceId: this.deviceId };
          this.onAttack(attack);
          for (const listener of this.#attackListeners) listener(attack);
        }
      };
      context.onstatechange = () => {
        if (generation === this.#generation && ['closed', 'interrupted'].includes(context.state)) this.#fail('O navegador interrompeu a captura de áudio.');
      };
      this.#deviceListener = async () => {
        try {
          const devices = await this.devices();
          if (generation !== this.#generation) return;
          this.onDevices(devices);
          const current = resolveInputDevice(track.getSettings(), devices, settings.deviceId, track.label);
          if ((!isAlias(this.deviceId) && !devices.some(device => device.deviceId === this.deviceId))
            || (this.calibrationDeviceId && current.calibrationDeviceId && current.calibrationDeviceId !== this.calibrationDeviceId)
            || !devices.length) this.#fail('Entrada de áudio desconectada ou substituída. O treino foi interrompido.', true);
        } catch (error) { if (generation === this.#generation) this.#fail(error.message); }
      };
      navigator.mediaDevices.addEventListener('devicechange', this.#deviceListener);
      this.onDevices(devices);
      return generation === this.#generation;
    } catch (error) {
      if (generation === this.#generation) this.#fail(errors[error.name] ?? error.message, ['NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(error.name));
      else { stream?.getTracks().forEach(track => track.stop()); if (context && context.state !== 'closed') void context.close().catch(() => {}); }
      return false;
    }
  }
  configure(settings) {
    if (settings.channel !== undefined || settings.pitchEnabled === false) this.#pitchStream?.reset();
    Object.assign(this.settings, settings);
    this.#worklet?.port.postMessage({ type: 'settings', settings });
  }
  #fail(message, recoverDevices = false) { this.stop(); this.onError(message, { recoverDevices }); }
  stop() {
    ++this.#generation;
    if (this.#deviceListener) navigator.mediaDevices?.removeEventListener('devicechange', this.#deviceListener);
    this.#deviceListener = null;
    if (this.#worklet) { this.#worklet.port.onmessage = null; this.#worklet.port.close(); this.#worklet.onprocessorerror = null; }
    for (const node of [this.#source, this.#worklet, this.#mute]) node?.disconnect();
    this.#source = this.#worklet = this.#mute = null;
    this.#pitchStream = null;
    if (this.#stream) for (const track of this.#stream.getTracks()) { track.onended = track.onmute = null; track.stop(); }
    this.#stream = null;
    const context = this.#context; this.#context = null;
    if (context) { context.onstatechange = null; if (context.state !== 'closed') void context.close().catch(() => {}); }
    this.deviceId = ''; this.calibrationDeviceId = null; this.inputLatencySeconds = 0;
    for (const listener of this.#pitchListeners) listener({ frequency: null, confidence: 0, rms: 0, stopped: true });
    this.onLevel(0, 0);
  }
}
