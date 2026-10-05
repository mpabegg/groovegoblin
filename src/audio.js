/**
 * GrooveAudio — transporte único do GrooveGoblin.
 *
 * Arquitetura
 * -----------
 * - Uma sessão canônica (session.js) é tocada por UM transporte: frase,
 *   bateria, acordes, baixo, metrônomo e pulso polirrítmico saem do mesmo
 *   relógio e da mesma realização pura (arrangement.js), que também alimenta
 *   renderSession() offline — o arquivo exportado soa como o transporte.
 * - Scheduler lookahead clássico: um setInterval acorda a cada 25 ms, gera
 *   compassos inteiros um pouco antes de começarem (para o modo "follow"
 *   decidir com os toques mais recentes) e entrega ao grafo Web Audio só os
 *   eventos dos próximos 100 ms. Assim updateSession()/setTempo() valem quase
 *   imediatamente: o que ainda não foi entregue é refeito.
 * - Coordenada interna: cada compasso ocupa rootTicks. compileBarPlan
 *   converte essa coordenada para segundos reais usando BPM e fórmula de
 *   cada seção; realtime e offline consomem os mesmos eventos de compasso.
 * - `position` é PUXADO: cada leitura rederiva modo/tick/compasso/tempo do
 *   instante correlacionado à SAÍDA (getOutputTimestamp), não do relógio de
 *   processamento. `onState` é EMPURRADO apenas em transições de
 *   modo/repetição/tecla presa. Um contador #generation invalida
 *   continuações assíncronas (resume, carregamento de samples) após stop().
 *
 * Timestamp → domínio de áudio (press/release)
 * --------------------------------------------
 * press()/release() recebem tempo de performance.now()/event.timeStamp e
 * reportam segundos relativos ao primeiro compasso avaliado do treino.
 * Correlacionamos com getOutputTimestamp() (o que está nos alto-falantes
 * agora, já incluindo latência de saída), lendo um par novo a cada
 * conversão. Sem esse par (ou com stub zerado), lemos um par novo
 * (performance.now(), currentTime) — sem latência de saída, o que tende a
 * fazer os toques parecerem ATRASADOS. A entrada aplica calibração física
 * antes de press/release; este transporte não a aplica uma segunda vez.
 *
 * Fechamento do treino
 * --------------------
 * O fim do treino e o gate de press/release usam o mesmo relógio
 * correlacionado à saída, para não descartar uma soltura feita em resposta
 * ao último som que a pessoa ainda está ouvindo.
 */

import { validateSession, MIXER_CHANNELS, BPM_MIN, BPM_MAX } from './session.js';
import { EPSILON, ticksPerBar, secondsPerTick, sessionTicks, performTick } from './meter.js';
import { prepareArrangement } from './arrangement.js';
import { playTone, playChord, playClick, playDrum, loadDrumSamples } from './synth.js';
import { compileBarPlan } from './form.js';
import { playbackStartTick } from './transport-position.js';
import { acceleratedBarPlan, normalizeAccelerator } from './transport-tempo.js';

import { contextPerformanceTime } from './input-timing.js';
const LOOKAHEAD_INTERVAL_SEC = 0.025;
const SCHEDULE_AHEAD_SEC = 0.1;
const SESSION_PRIME_SEC = 0.06;
const BAR_EARLY_SEC = 0.1; // maior que o microtempo negativo máximo (80 ms)
const LATE_DROP_SEC = 0.05;
const GAIN_FADE_SEC = 0.01;
const MONITOR_MAX_SEC = 8;
const PREVIEW_TAIL_SEC = 0.05;

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

function checkedSession(session) {
  const result = validateSession(session);
  if (!result.ok) throw new TypeError(result.error);
  return freezeDeep(result.session);
}


// Limitador final: linear abaixo de -1,94 dB, limitado a ±0,95 (sem corte PCM).
const LIMITER_CURVE = Float32Array.from({ length: 4097 }, (_, index) => {
  const x = (index / 4096 * 2 - 1) * 4;
  const magnitude = Math.abs(x);
  return Math.sign(x) * (magnitude <= 0.8 ? magnitude : 0.8 + 0.15 * Math.tanh((magnitude - 0.8) / 0.15));
});
// Master com compressor suave para mixes com muitas vozes simultâneas.
function createBuses(ctx, mixer) {
  const master = ctx.createGain();
  master.gain.value = 0.45; // Reserva para cinco canais e acordes simultâneos.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -10;
  compressor.knee.value = 6;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.2;
  master.connect(compressor);
  const limiterInput = ctx.createGain();
  limiterInput.gain.value = 0.25;
  const limiter = ctx.createWaveShaper();
  limiter.curve = LIMITER_CURVE;
  compressor.connect(limiterInput).connect(limiter).connect(ctx.destination);
  const buses = {};
  for (const channel of MIXER_CHANNELS) {
    const bus = ctx.createGain();
    const { volume, muted } = mixer[channel];
    bus.gain.value = muted ? 0 : volume;
    bus.connect(master);
    buses[channel] = bus;
  }
  return { master, buses };
}

// Entrega um evento do arranjo ao grafo; devolve as entradas a rastrear.
function dispatch(ctx, buses, samples, event, time, secPerTick) {
  const duration = event.duration * secPerTick;
  let entries;
  switch (event.kind) {
    case 'note':
    case 'pulse':
      entries = [playTone(ctx, buses[event.channel], {
        time, duration, pitch: event.pitch, velocity: event.velocity, timbre: event.timbre, articulation: event.articulation,
      })]; break;
    case 'chord':
      entries = playChord(ctx, buses.chords, {
        time, duration, pitches: event.pitches, velocity: event.velocity, timbre: event.timbre, articulation: event.articulation,
      }); break;
    case 'drum':
      entries = [playDrum(ctx, buses.drums, { time, instrument: event.instrument, velocity: event.velocity }, samples)]; break;
    case 'click':
      entries = [playClick(ctx, buses.metronome, { time, accent: event.accent, velocity: event.velocity })]; break;
    default: return [];
  }
  if (Number.isFinite(event.maxSeconds)) {
    const end = time + Math.max(0, event.maxSeconds);
    for (const entry of entries) {
      if (entry.end <= end) continue;
      const fade = Math.max(time, end - 0.01);
      entry.gain.gain.cancelScheduledValues(fade);
      entry.gain.gain.setTargetAtTime(0, fade, 0.002);
      entry.gain.gain.setValueAtTime(0, end);
      for (const source of entry.sources) source.stop(end);
      entry.end = end;
    }
  }
  return entries;
}

// Atividade real de teclado/toque nos dois compassos anteriores (modo follow).
function activityFor(onsets, bar, barTicks) {
  const local = index => onsets
    .filter(tick => tick >= index * barTicks - EPSILON && tick < (index + 1) * barTicks - EPSILON)
    .map(tick => tick - index * barTicks);
  return { previous: local(bar - 1), earlier: local(bar - 2) };
}

// Altura de referência mais próxima (para o retorno sonoro de toques sem altura).
function referencePitch(session, sessionTick) {
  let best = null;
  for (const note of session.notes) {
    const distance = Math.abs(note.start - sessionTick);
    if (!best || distance < best.distance) best = { distance, pitch: note.pitch };
  }
  return best ? best.pitch : 69;
}

export class GrooveAudio {
  #onStateCb;
  #onFinishCb;

  #ctx = null;
  #buses = null;
  #countBuses = null;
  #mixer = Object.fromEntries(MIXER_CHANNELS.map(channel => [channel, { volume: 1, muted: false }]));

  #generation = 0;
  #timerId = null;
  #finishTimeoutId = null;

  #mode = null; // null | 'loop' | 'train' | 'preview'
  #session = null;
  #arrangement = null;
  #plan = null;
  #executedSession = null;
  #samples = null;
  #sampleStatus = 'unloaded';
  #startedAt = 0;

  #anchorTime = 0;
  #anchorTick = 0;
  #secPerTick = 0;
  #barTicks = 16;
  #countInBars = 0;
  #normalCountBars = 0;
  #normalCountEnd = 0;
  #normalCountStart = 0;
  #accelerator = normalizeAccelerator();
  #acceleratorStartCycle = 0;
  #inputTailSeconds = 0;
  #loopStart = 0;
  #loopBars = 1;
  #repetitions = 0;
  #nextBar = 0;
  #endBar = Infinity;
  #pending = [];
  #dispatchedTime = 0;
  #onsets = [];

  #attempts = [];
  #heldAttempt = null;
  #held = false;
  #heldPitch = null;
  #keyDown = false;
  #monitor = null;
  #calibrationBus = null;
  #calibrationClockCancel = null;
  #previewResolve = null;
  #auditionRequest = 0;

  #activeNodes = new Set();
  #lastSnapshot = null;

  constructor({ onState = () => {}, onFinish = () => {} } = {}) {
    this.#onStateCb = onState;
    this.#onFinishCb = onFinish;
  }

  get context() {
    return this.#ctx;
  }

  // 'unloaded' | 'loaded' | 'failed' (falha => bateria sintetizada).
  get drumSamples() {
    return this.#sampleStatus;
  }

  get session() {
    return this.#session;
  }

  async prepareInput() {
    const context = this.#ensureContext();
    if (context.state === 'suspended') await context.resume();
    return context;
  }

  // Both input and calibration use this same output-correlated clock.
  outputClock() {
    return this.#outputTimestamp() ?? { contextTime: this.#ctx?.currentTime ?? 0, performanceTime: performance.now() };
  }

  #outputTimestamp() {
    const ctx = this.#ctx;
    if (typeof ctx?.getOutputTimestamp === 'function') {
      const pair = ctx.getOutputTimestamp();
      const age = performance.now() - pair.performanceTime;
      if (Number.isFinite(pair.contextTime) && Number.isFinite(pair.performanceTime)
        && !(pair.contextTime === 0 && pair.performanceTime === 0) && age >= -10 && age < 250
        && pair.contextTime <= ctx.currentTime + 0.01) return pair;
    }
    return null;
  }

  #calibrationOutputClock() {
    if (typeof this.#ctx.getOutputTimestamp !== 'function') return Promise.resolve(this.outputClock());
    this.#calibrationClockCancel?.();
    const deadline = performance.now() + 1000;
    return new Promise((resolve, reject) => {
      let timer = null;
      const finish = (pair, error) => {
        clearTimeout(timer); this.#calibrationClockCancel = null;
        if (error) reject(error); else resolve(pair);
      };
      this.#calibrationClockCancel = () => finish(null, new Error('Calibração interrompida.'));
      const check = () => {
        const pair = this.#outputTimestamp();
        if (pair) { finish(pair); return; }
        if (performance.now() >= deadline) {
          finish(null, new Error('O relógio de saída ainda não está disponível. Aguarde e tente calibrar novamente.')); return;
        }
        timer = setTimeout(check, 10);
      };
      check();
    });
  }

  async calibrationClicks() {
    const ctx = this.#ctx;
    if (!ctx || ctx.state !== 'running') throw new Error('Prepare o áudio antes de calibrar.');
    const generation = this.#generation;
    const pair = await this.#calibrationOutputClock();
    if (generation !== this.#generation || ctx.state !== 'running') throw new Error('Calibração interrompida.');
    this.#calibrationBus?.disconnect();
    this.#calibrationBus = ctx.createGain();
    this.#calibrationBus.gain.value = 0.15;
    this.#calibrationBus.connect(ctx.destination);
    return Array.from({ length: 8 }, (_, index) => {
      const time = ctx.currentTime + 0.5 + index * 0.65;
      this.#track(playClick(ctx, this.#calibrationBus, { time, accent: index === 0 ? 'bar' : 'beat' }));
      return contextPerformanceTime(time, pair);
    });
  }

  get countInClicks() {
    if (this.#mode !== 'train') return [];
    const pair = this.outputClock();
    const clicks = [];
    for (let bar = 0; bar < this.#countInBars; bar++) {
      for (const event of this.#arrangement.countInEvents()) {
        clicks.push(contextPerformanceTime(this.#timeOfTick(bar * this.#barTicks + event.tick), pair));
      }
    }
    return clicks;
  }

  // Synthetic gate ends are bookkeeping only, never measured durations.
  writtenInputDuration(eventTimeStamp) {
    if (!this.#session || !this.#plan) return 0.1;
    const tick = this.#tickAtTime(this.#toAudioTime(eventTimeStamp));
    const bar = Math.max(this.#countInBars, Math.floor(tick / this.#barTicks));
    const sessionTick = this.#sessionBarOf(bar) * this.#barTicks + tick - Math.floor(tick / this.#barTicks) * this.#barTicks;
    const start = this.#loopStart * this.#barTicks;
    const end = start + this.#loopBars * this.#barTicks;
    let nearest = null;
    for (const note of this.#session.notes) {
      if (note.start < start || note.start >= end) continue;
      if (!nearest || Math.abs(performTick(this.#session, note.start) - sessionTick) < Math.abs(performTick(this.#session, nearest.start) - sessionTick)) nearest = note;
    }
    return nearest ? (performTick(this.#session, nearest.start + nearest.duration) - performTick(this.#session, nearest.start)) * this.#secPerTick : 0.1;
  }

  setMixer(mixer) {
    for (const channel of MIXER_CHANNELS) {
      if (!mixer || !mixer[channel]) continue;
      const { volume, muted } = mixer[channel];
      this.#mixer[channel] = { volume, muted };
      if (this.#buses) this.#setGain(this.#buses[channel], muted ? 0 : volume);
    }
  }

  async playSession(session, { mode = 'loop', startTick = null, once = false, mixer = null, inputTailSeconds = 0, countInBars = 0, accelerator = null } = {}) {
    if (mode !== 'loop' && mode !== 'train') throw new TypeError('O modo de reprodução deve ser loop ou train.');
    const valid = checkedSession(session);
    this.stop();
    const gen = this.#generation;
    const ctx = this.#ensureContext();
    this.#session = valid;
    this.setMixer(mixer ?? valid.mixer);

    await Promise.all([
      ctx.state === 'suspended' ? ctx.resume() : Promise.resolve(),
      valid.drums.enabled ? this.#loadSamples() : Promise.resolve(),
    ]);
    if (gen !== this.#generation) return false; // stop() venceu durante resume/carregamento

    const train = mode === 'train';
    this.#inputTailSeconds = train ? Math.max(0, inputTailSeconds) : 0;
    this.#accelerator = normalizeAccelerator(train || once ? null : accelerator);
    this.#acceleratorStartCycle = 0;
    this.#plan = train ? compileBarPlan(valid, { training: true }) : acceleratedBarPlan(valid, this.#accelerator);
    this.#executedSession = valid;
    this.#arrangement = prepareArrangement(valid);
    this.#barTicks = ticksPerBar(valid);
    this.#secPerTick = secondsPerTick(valid.bpm);
    this.#countInBars = train ? valid.training.countInBars : 0;
    this.#normalCountBars = train ? 0 : [1, 2].includes(countInBars) ? countInBars : 0;
    this.#normalCountEnd = train ? 0 : playbackStartTick(valid, this.#plan, startTick);
    if (!train && this.#normalCountEnd > EPSILON) {
      this.#acceleratorStartCycle = Math.ceil(this.#normalCountEnd / this.#barTicks / this.#plan.bars.length);
      this.#plan = acceleratedBarPlan(valid, this.#accelerator, this.#acceleratorStartCycle);
    }
    this.#normalCountStart = this.#normalCountEnd - this.#normalCountBars * this.#barTicks;
    this.#loopStart = valid.loop.startBar;
    this.#loopBars = valid.loop.endBar - valid.loop.startBar;
    this.#repetitions = train ? valid.training.repetitions : 0;
    this.#endBar = train ? this.#countInBars + this.#loopBars * this.#repetitions
      : once ? this.#plan.bars.length : this.#plan.loop ? Infinity : this.#plan.bars.length;
    this.#anchorTick = train ? 0 : this.#normalCountStart;
    this.#nextBar = Math.floor((train ? this.#anchorTick : this.#normalCountEnd) / this.#barTicks);
    this.#pending = [];
    this.#onsets = [];
    this.#anchorTime = ctx.currentTime + SESSION_PRIME_SEC;
    this.#dispatchedTime = this.#anchorTime;
    this.#attempts = [];
    this.#heldAttempt = null;
    this.#held = false;
    this.#heldPitch = null;
    this.#startedAt = Date.now();
    this.#mode = mode;
    if (this.#normalCountBars) this.#generateNormalCount();
    this.#generateBar(this.#nextBar, !train && (startTick !== null || this.#normalCountBars) ? this.#timeOfTick(this.#normalCountEnd) : -Infinity);
    this.#nextBar += 1;
    this.#emitState();
    this.#runScheduler(gen);
    if (Number.isFinite(this.#endBar)) this.#scheduleFinish(gen);
    return true;
  }

  // Mixer é imediato. Eventos ainda não despachados são recompilados na
  // mesma posição relativa do compasso. O treino conserva a grade executada.
  updateSession(session) {
    let valid = checkedSession(session);
    this.setMixer(valid.mixer);
    if (this.#mode !== 'loop' && this.#mode !== 'train') {
      this.#session = valid;
      return;
    }
    const previous = this.#session;
    if (this.#mode === 'train') {
      valid = checkedSession({
        ...valid, bpm: previous.bpm, bars: previous.bars, meter: previous.meter, loop: previous.loop, notes: previous.notes,
        training: previous.training, swing: previous.swing, swingUnit: previous.swingUnit, subdivision: previous.subdivision,
      });
    }
    const now = this.#ctx.currentTime;
    const oldTicks = this.#barTicks;
    const currentTick = this.#tickAtTime(now);
    const barPosition = currentTick / oldTicks;
    this.#session = valid;
    this.#arrangement = prepareArrangement(valid);
    if (valid.bpm !== previous.bpm) this.#acceleratorStartCycle = Math.max(0, Math.floor(currentTick / oldTicks / this.#plan.bars.length));
    this.#plan = this.#mode === 'train' ? compileBarPlan(valid, { training: true }) : acceleratedBarPlan(valid, this.#accelerator, this.#acceleratorStartCycle);
    this.#barTicks = ticksPerBar(valid);
    this.#secPerTick = secondsPerTick(valid.bpm);
    this.#loopStart = valid.loop.startBar;
    this.#loopBars = valid.loop.endBar - valid.loop.startBar;
    this.#anchorTick = barPosition * this.#barTicks;
    this.#anchorTime = now;
    this.#endBar = this.#mode === 'train' ? this.#countInBars + this.#loopBars * this.#repetitions
      : this.#plan.loop ? Infinity : this.#plan.bars.length;
    this.#onsets = this.#onsets.map(tick => tick / oldTicks * this.#barTicks);
    if (valid.drums.enabled && !this.#samples) this.#loadSamples().catch(() => {});
    this.#pending = [];
    const counting = this.#mode === 'loop' && this.#normalCountBars && currentTick < this.#normalCountEnd;
    if (counting) this.#generateNormalCount(this.#dispatchedTime);
    const currentBar = Math.max(0, Math.floor((counting ? this.#normalCountEnd : this.#tickAtTime(this.#dispatchedTime)) / this.#barTicks));
    if (currentBar < this.#endBar) this.#generateBar(currentBar, Math.max(this.#dispatchedTime, counting ? this.#timeOfTick(this.#normalCountEnd) : -Infinity));
    this.#nextBar = currentBar + 1;
    clearTimeout(this.#finishTimeoutId);
    this.#finishTimeoutId = null;
    if (Number.isFinite(this.#endBar)) this.#scheduleFinish(this.#generation);
    if (this.#timerId === null && (this.#mode === 'loop' || this.#mode === 'train')) this.#runScheduler(this.#generation);
  }

  // Seek reanchors the same scheduler. Training has an immutable evaluated timeline.
  seek(startTick) {
    if (this.#mode !== 'loop') return false;
    this.#silenceActiveNodes();
    this.#normalCountBars = 0;
    this.#anchorTick = playbackStartTick(this.#session, this.#plan, startTick);
    this.#anchorTime = this.#ctx.currentTime + SESSION_PRIME_SEC;
    this.#dispatchedTime = this.#anchorTime;
    this.#pending = [];
    this.#onsets = [];
    this.#nextBar = Math.floor(this.#anchorTick / this.#barTicks);
    this.#generateBar(this.#nextBar, this.#anchorTime);
    this.#nextBar += 1;
    clearTimeout(this.#finishTimeoutId);
    this.#finishTimeoutId = null;
    if (Number.isFinite(this.#endBar)) this.#scheduleFinish(this.#generation);
    if (this.#timerId === null) this.#runScheduler(this.#generation);
    else this.#tickScheduler(this.#generation);
    this.#emitState();
    return true;
  }

  // Muda o andamento no loop sem reiniciar (não permitido durante o treino).
  setTempo(bpm) {
    if (!Number.isInteger(bpm) || bpm < BPM_MIN || bpm > BPM_MAX) throw new TypeError(`O BPM deve ser um inteiro entre ${BPM_MIN} e ${BPM_MAX}.`);
    if (this.#mode !== 'loop') {
      if (this.#session && this.#mode === null) this.#session = checkedSession({ ...this.#session, bpm });
      return this.#mode === null;
    }
    this.updateSession({ ...this.#session, bpm });
    return true;
  }

  stop() {
    const wasActive = this.#mode !== null;
    this.#generation += 1; // invalida resume()/finish em andamento
    this.#calibrationClockCancel?.();
    if (this.#timerId !== null) {
      clearInterval(this.#timerId);
      this.#timerId = null;
    }
    if (this.#finishTimeoutId !== null) {
      clearTimeout(this.#finishTimeoutId);
      this.#finishTimeoutId = null;
    }
    this.#silenceActiveNodes();
    this.#stopMonitor();
    this.#calibrationBus?.disconnect();
    this.#calibrationBus = null;
    this.#mode = null;
    this.#normalCountBars = 0;
    this.#accelerator = normalizeAccelerator();
    this.#pending = [];
    this.#onsets = [];
    this.#attempts = [];
    this.#heldAttempt = null;
    this.#held = false;
    this.#heldPitch = null;
    this.#keyDown = false;
    const resolve = this.#previewResolve;
    this.#previewResolve = null;
    if (resolve) resolve(false);
    if (wasActive) this.#emitState(); // treino interrompido não entrega onFinish
  }
  // Editor feedback is not a transport mode. A resume race cannot interrupt a loop or train.
  async audition(notes, { bpm = 100, timbre = 'soft-lead', channel = 'phrase' } = {}) {
    if (this.#mode !== null) return false;
    if (!Array.isArray(notes) || notes.some(note => !note || !Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127)) throw new TypeError('Alturas inválidas para a prévia.');
    if (!Number.isInteger(bpm) || bpm < BPM_MIN || bpm > BPM_MAX || !['phrase', 'chords'].includes(channel)) throw new TypeError('Opções inválidas para a prévia.');
    const gen = this.#generation; const request = ++this.#auditionRequest;
    const ctx = this.#ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    if (gen !== this.#generation || request !== this.#auditionRequest || this.#mode !== null) return false;
    const time = ctx.currentTime + 0.01;
    const duration = Math.min(0.35, Math.max(0.12, secondsPerTick(bpm) * 2));
    if (channel === 'chords') {
      for (const entry of playChord(ctx, this.#buses.chords, { time, duration, pitches: notes.map(note => note.pitch), velocity: notes[0]?.velocity ?? 0.65, timbre })) this.#track(entry);
    } else {
      for (const note of notes) this.#track(playTone(ctx, this.#buses.phrase, { time, duration, pitch: note.pitch, velocity: note.velocity ?? 0.8, articulation: note.articulation ?? 'normal', timbre }));
    }
    return true;
  }

  // Toque avulso (jogos de ouvido, prévias): notas podem se sobrepor.
  // notes: [{start, duration (ticks), pitch, velocity?, articulation?}].
  async preview(notes, { bpm = 100, timbre = 'soft-lead', channel = 'phrase' } = {}) {
    if (!Array.isArray(notes) || notes.some(note => !note || !Number.isFinite(note.start) || note.start < 0
      || !Number.isFinite(note.duration) || note.duration <= 0 || !Number.isInteger(note.pitch ?? 69))) {
      throw new TypeError('A prévia requer notas com início, duração e altura válidos.');
    }
    if (!Number.isInteger(bpm) || bpm < BPM_MIN || bpm > BPM_MAX) throw new TypeError(`O BPM deve ser um inteiro entre ${BPM_MIN} e ${BPM_MAX}.`);
    if (!MIXER_CHANNELS.includes(channel)) throw new TypeError('Canal de prévia desconhecido.');
    this.stop();
    const gen = this.#generation;
    const ctx = this.#ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    if (gen !== this.#generation) return false;
    const secPerTick = secondsPerTick(bpm);
    const start = ctx.currentTime + SESSION_PRIME_SEC;
    let end = start;
    for (const note of notes) {
      const entry = playTone(ctx, this.#buses[channel], {
        time: start + note.start * secPerTick, duration: note.duration * secPerTick, pitch: note.pitch ?? 69,
        velocity: note.velocity ?? 0.8, timbre, articulation: note.articulation ?? 'normal',
      });
      this.#track(entry);
      end = Math.max(end, entry.end);
    }
    this.#mode = 'preview';
    return new Promise(resolve => {
      this.#previewResolve = resolve;
      const finish = () => {
        if (gen !== this.#generation) return;
        const remaining = end + PREVIEW_TAIL_SEC - this.#nowAudioTime();
        if (remaining > 1e-9) {
          this.#finishTimeoutId = setTimeout(finish, Math.max(4, remaining * 1000));
          return;
        }
        this.#finishTimeoutId = null;
        this.#previewResolve = null;
        this.#mode = null;
        resolve(true);
      };
      finish();
    });
  }

  press(eventTimeStamp = performance.now(), pitch = null, { monitor = true } = {}) {
    if (this.#keyDown) return; // repetição de tecla do SO, independente do modo
    this.#keyDown = true;
    if (pitch !== null && (!Number.isInteger(pitch) || pitch < 0 || pitch > 127)) pitch = null;
    const mode = this.position.mode;
    const audioTime = this.#ctx ? this.#toAudioTime(eventTimeStamp) : 0;
    let sessionTick = 0;
    if (mode === 'loop' || mode === 'train' || mode === 'countin') {
      const tick = this.#tickAtTime(audioTime);
      if (tick >= 0) this.#onsets.push(tick);
      const keep = tick - this.#barTicks * 3;
      this.#onsets = this.#onsets.filter(value => value >= keep);
      const bar = Math.floor(tick / this.#barTicks);
      if (bar >= this.#countInBars) sessionTick = this.#sessionBarOf(bar) * this.#barTicks + (tick - bar * this.#barTicks);
    }
    if (monitor) this.#startMonitor(pitch ?? (this.#session ? referencePitch(this.#session, sessionTick) : 69));
    // position describes the audible clock, not the compensated event's window.
    if (this.#mode !== 'train' || audioTime < this.#trainStartTime()
      || audioTime >= this.#timeOfTick(this.#endBar * this.#barTicks)) return;

    const attempt = { start: audioTime - this.#trainStartTime(), end: null, pitch };
    this.#attempts.push(attempt);
    this.#heldAttempt = attempt;
    this.#held = true;
    this.#heldPitch = pitch;
    this.#emitState();
  }

  release(eventTimeStamp = performance.now()) {
    if (!this.#keyDown) return;
    this.#keyDown = false;
    this.#stopMonitor();
    if (!this.#heldAttempt) return; // o press correspondente foi ignorado

    const t = this.#toAudioTime(eventTimeStamp) - this.#trainStartTime();
    const limit = this.#timeOfTick(this.#endBar * this.#barTicks) - this.#trainStartTime();
    this.#heldAttempt.end = Math.max(this.#heldAttempt.start, Math.min(t, limit));
    this.#heldAttempt = null;
    this.#held = false;
    this.#heldPitch = null;
    this.#emitState();
  }

  // {mode, tick (sessão), bar (1-based, compasso da sessão), beat (1-based na
  // unidade do compasso), repetition (treino 1..N; loop: passagem 1..),
  // repetitions (treino), held, pitch, startTick/endTick do loop,
  // ticksPerBar (fonte), countInBar/countInBars, bpm, previewing,
  // meter (tocado), sectionId/sectionName/sectionIndex/sectionRepeat, formBar}.
  get position() {
    const idle = {
      mode: 'idle', tick: 0, bar: 1, beat: 1, repetition: 0, repetitions: 0, held: false, pitch: null,
      training: false,
      startTick: 0, endTick: this.#session ? sessionTicks(this.#session) : 16, ticksPerBar: this.#session ? ticksPerBar(this.#session) : 16,
      countInBar: 0, countInBars: 0, bpm: this.#session?.bpm ?? 0, previewing: this.#mode === 'preview',
    };
    if (!this.#ctx || this.#mode === null || this.#mode === 'preview') return idle;
    const now = this.#nowAudioTime();
    let tick = Math.max(this.#anchorTick, this.#tickAtTime(now));
    if (this.#mode === 'loop' && this.#normalCountBars && tick < this.#normalCountEnd - EPSILON) {
      const countTick = Math.max(0, tick - this.#normalCountStart);
      return { ...idle, mode: 'countin', tick: this.#sessionBarOf(Math.floor(this.#normalCountEnd / this.#barTicks)) * this.#barTicks,
        bpm: this.#session.bpm, meter: this.#session.meter, countInBars: this.#normalCountBars,
        countInBar: Math.floor(countTick / this.#barTicks) + 1, beat: Math.floor(countTick % this.#barTicks / (16 / this.#session.meter.unit)) + 1 };
    }
    if (tick >= this.#endBar * this.#barTicks) {
      if (this.#mode !== 'train' || now >= this.#timeOfTick(this.#endBar * this.#barTicks) + this.#inputTailSeconds) return idle;
      tick = this.#endBar * this.#barTicks - EPSILON;
    }
    const bar = Math.floor(tick / this.#barTicks);
    const local = tick - bar * this.#barTicks;
    const descriptor = bar >= this.#countInBars ? this.#plan.at(bar - this.#countInBars) : null;
    const beat = Math.floor(local / this.#barTicks * (descriptor?.meter.beats ?? this.#session.meter.beats)) + 1;
    const base = {
      held: this.#held, pitch: this.#heldPitch, beat, ticksPerBar: this.#barTicks,
      training: this.#mode === 'train',
      startTick: this.#loopStart * this.#barTicks, endTick: (this.#loopStart + this.#loopBars) * this.#barTicks,
      repetitions: this.#repetitions, countInBars: this.#countInBars, bpm: descriptor?.bpm ?? this.#session.bpm, previewing: false,
      meter: descriptor?.meter ?? this.#session.meter, sectionId: descriptor?.sectionId ?? null,
      sectionName: descriptor?.sectionName ?? '', sectionIndex: descriptor?.sectionIndex ?? -1,
      sectionRepeat: descriptor?.sectionRepeat ?? 0, formBar: bar - this.#countInBars + 1,
      acceleration: this.#mode === 'loop' ? this.#plan.acceleration?.(bar) ?? null : null,
    };
    if (bar < this.#countInBars) {
      return { ...base, mode: 'countin', tick: base.startTick, bar: this.#loopStart + 1, repetition: 0, countInBar: bar + 1 };
    }
    const sessionBar = this.#sessionBarOf(bar);
    const repetition = this.#mode === 'train'
      ? Math.floor((bar - this.#countInBars) / this.#loopBars) + 1
      : Math.floor((bar - this.#countInBars) / this.#plan.bars.length) + 1;
    return { ...base, mode: this.#mode, tick: sessionBar * this.#barTicks + local, bar: sessionBar + 1, repetition, countInBar: 0 };
  }

  // -- internals ------------------------------------------------------

  #sessionBarOf(bar) {
    return this.#plan.at(bar - this.#countInBars).sourceBar;
  }

  // Coordenada interna: um compasso = rootTicks, mesmo com outra fórmula.
  // A conversão usa a duração REAL de cada compasso do plano compartilhado.
  #planSeconds(tick) {
    if (this.#mode === 'loop' && this.#normalCountBars) {
      const end = this.#normalCountEnd;
      const secondsAtEnd = this.#plan.timeAt(Math.floor(end / this.#barTicks)) + end % this.#barTicks / this.#barTicks * this.#plan.at(Math.floor(end / this.#barTicks)).duration;
      if (tick < end) return secondsAtEnd + (tick - end) * this.#secPerTick;
    }
    const position = tick / this.#barTicks;
    if (position < this.#countInBars) return tick * this.#secPerTick;
    const index = Math.floor(position) - this.#countInBars;
    return this.#countInBars * this.#barTicks * this.#secPerTick
      + this.#plan.timeAt(index) + (position - Math.floor(position)) * this.#plan.at(index).duration;
  }

  #timeOfTick(tick) {
    return this.#anchorTime + this.#planSeconds(tick) - this.#planSeconds(this.#anchorTick);
  }

  #tickAtTime(time) {
    const seconds = time - this.#anchorTime + this.#planSeconds(this.#anchorTick);
    if (this.#mode === 'loop' && this.#normalCountBars) {
      const end = this.#normalCountEnd; const endSeconds = this.#planSeconds(end);
      if (seconds < endSeconds) return end + (seconds - endSeconds) / this.#secPerTick;
    }
    const countSeconds = this.#countInBars * this.#barTicks * this.#secPerTick;
    if (seconds < countSeconds) return seconds / this.#secPerTick;
    const located = this.#plan.locate(seconds - countSeconds);
    return (this.#countInBars + located.index + located.fraction) * this.#barTicks;
  }

  #trainStartTime() {
    return this.#timeOfTick(this.#countInBars * this.#barTicks);
  }

  #ensureContext() {
    if (!this.#ctx) {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      this.#ctx = new Ctor();
      const { master, buses } = createBuses(this.#ctx, this.#mixer);
      this.#buses = buses;
      const count = this.#ctx.createGain(); count.gain.value = 0.65; count.connect(master);
      this.#countBuses = { ...buses, metronome: count };
    }
    return this.#ctx;
  }

  async #loadSamples() {
    try {
      this.#samples = await loadDrumSamples(this.#ctx);
      this.#sampleStatus = 'loaded';
    } catch {
      this.#samples = null;
      this.#sampleStatus = 'failed';
    }
  }

  #setGain(node, value) {
    const gain = node.gain;
    const now = this.#ctx.currentTime;
    if (typeof gain.cancelAndHoldAtTime === 'function') {
      gain.cancelAndHoldAtTime(now);
    } else {
      const current = gain.value;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(current, now);
    }
    gain.linearRampToValueAtTime(value, now + GAIN_FADE_SEC);
  }

  #generateNormalCount(notBefore = -Infinity) {
    for (let bar = 0; bar < this.#normalCountBars; bar++) {
      for (const event of this.#arrangement.countInEvents()) {
        const transportTick = this.#normalCountStart + bar * this.#barTicks + event.tick;
        if (this.#timeOfTick(transportTick) < notBefore - EPSILON) continue;
        this.#pending.push({ transportTick, event: { ...event, normalCount: true }, secPerTick: this.#secPerTick, key: this.#timeOfTick(transportTick) });
      }
    }
  }

  #generateBar(bar, notBefore = -Infinity) {
    const train = this.#mode === 'train';
    const descriptor = bar < this.#countInBars ? null : this.#plan.at(bar - this.#countInBars);
    const events = descriptor
      ? descriptor.events({ barIndex: bar - this.#countInBars, includePhrase: !train,
        activity: activityFor(this.#onsets, bar, this.#barTicks) })
      : this.#arrangement.countInEvents();
    const secPerTick = descriptor?.secPerTick ?? this.#secPerTick;
    const eventTicks = descriptor?.ticks ?? this.#barTicks;
    const barStart = bar * this.#barTicks;
    for (const event of events) {
      const transportTick = barStart + event.tick / eventTicks * this.#barTicks;
      const time = this.#timeOfTick(transportTick) + (event.offsetMs ?? 0) / 1000;
      if (time < notBefore - EPSILON) continue;
      this.#pending.push({ transportTick, event, secPerTick, key: time });
    }
    this.#pending.sort((a, b) => a.key - b.key);
  }

  #runScheduler(gen) {
    this.#tickScheduler(gen);
    this.#timerId = setInterval(() => this.#tickScheduler(gen), LOOKAHEAD_INTERVAL_SEC * 1000);
  }

  #tickScheduler(gen) {
    if (gen !== this.#generation) return;
    const ctx = this.#ctx;
    const now = ctx.currentTime;
    const horizon = now + SCHEDULE_AHEAD_SEC;
    while (this.#nextBar < this.#endBar && this.#timeOfTick(this.#nextBar * this.#barTicks) - BAR_EARLY_SEC < horizon) {
      this.#generateBar(this.#nextBar);
      this.#nextBar += 1;
    }
    while (this.#pending.length > 0) {
      const { transportTick, event, secPerTick } = this.#pending[0];
      let time = this.#timeOfTick(transportTick) + (event.offsetMs ?? 0) / 1000;
      if (time >= horizon) break;
      this.#pending.shift();
      if (time < now) {
        if (now - time > LATE_DROP_SEC) continue; // aba congelada: não despeja eventos atrasados
        time = now;
      }
      for (const entry of dispatch(ctx, event.normalCount ? this.#countBuses : this.#buses, this.#samples, event, time, secPerTick)) this.#track(entry);
    }
    this.#dispatchedTime = horizon;
    if (this.#nextBar >= this.#endBar && this.#pending.length === 0 && this.#timerId !== null) {
      clearInterval(this.#timerId);
      this.#timerId = null;
    }
    this.#checkTransition();
  }

  #scheduleFinish(gen) {
    const check = () => {
      if (gen !== this.#generation) return;
      // Relógio correlacionado à saída: ver "Fechamento do treino".
      const remaining = this.#timeOfTick(this.#endBar * this.#barTicks) + (this.#mode === 'train' ? this.#inputTailSeconds : 0) - this.#nowAudioTime();
      if (remaining <= 1e-9) {
        if (this.#mode === 'train') this.#finishTrain(gen);
        else this.stop();
      }
      else this.#finishTimeoutId = setTimeout(check, Math.max(4, remaining * 1000));
    };
    check();
  }

  #finishTrain(gen) {
    if (gen !== this.#generation || this.#mode !== 'train') return;
    const total = (this.#endBar - this.#countInBars) * this.#barTicks * this.#secPerTick;
    if (this.#heldAttempt) {
      this.#heldAttempt.end = total; // segurada até o fim: fecha no limite final
      this.#heldAttempt = null;
    }
    this.#held = false;
    this.#heldPitch = null;
    this.#keyDown = false;
    this.#stopMonitor();
    const attempts = this.#attempts;
    this.#attempts = [];
    if (this.#timerId !== null) {
      clearInterval(this.#timerId);
      this.#timerId = null;
    }
    this.#finishTimeoutId = null;
    this.#silenceActiveNodes();
    const session = this.#executedSession;
    const detail = {
      session, bpm: session.bpm, repetitions: this.#repetitions, countInBars: this.#countInBars,
      loop: { startBar: session.loop.startBar, endBar: session.loop.endBar }, startedAt: this.#startedAt,
    };
    this.#mode = null;
    this.#emitState(); // -> idle
    this.#onFinishCb(attempts, detail);
  }

  #startMonitor(pitch) {
    if (!this.#session || !this.#session.training.monitor) return;
    const ctx = this.#ensureContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    this.#stopMonitor();
    const entry = playTone(ctx, this.#buses.phrase, {
      time: ctx.currentTime, duration: MONITOR_MAX_SEC, pitch, velocity: 0.8, timbre: this.#session.timbres.phrase, articulation: 'tenuto',
    });
    this.#track(entry);
    this.#monitor = entry;
  }

  #stopMonitor() {
    const entry = this.#monitor;
    this.#monitor = null;
    if (!entry || !this.#ctx) return;
    this.#fadeOut(entry, this.#ctx.currentTime);
    this.#activeNodes.delete(entry);
  }

  #toAudioTime(eventTimeStampMs) {
    const pair = this.outputClock();
    return pair.contextTime + (eventTimeStampMs - pair.performanceTime) / 1000;
  }

  #nowAudioTime() {
    return this.#toAudioTime(performance.now());
  }

  #emitState() {
    const pos = this.position;
    this.#lastSnapshot = { mode: pos.mode, repetition: pos.repetition, held: pos.held };
    this.#onStateCb(pos);
  }

  #checkTransition() {
    const pos = this.position;
    const prev = this.#lastSnapshot;
    if (prev && prev.mode === pos.mode && prev.repetition === pos.repetition && prev.held === pos.held) return;
    this.#lastSnapshot = { mode: pos.mode, repetition: pos.repetition, held: pos.held };
    this.#onStateCb(pos);
  }

  #track(entry) {
    this.#activeNodes.add(entry);
    let remaining = entry.sources.length;
    for (const source of entry.sources) {
      source.onended = () => {
        remaining -= 1;
        if (remaining > 0) return;
        this.#activeNodes.delete(entry);
        try {
          for (const node of entry.sources) node.disconnect();
          entry.gain.disconnect();
        } catch {
          // já desconectado
        }
      };
    }
  }

  #fadeOut(entry, now) {
    try {
      entry.gain.gain.cancelScheduledValues(now);
      entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
      entry.gain.gain.linearRampToValueAtTime(0, now + 0.01);
      for (const source of entry.sources) source.stop(now + 0.015);
    } catch {
      // nó já terminado
    }
  }

  #silenceActiveNodes() {
    const ctx = this.#ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const entry of this.#activeNodes) this.#fadeOut(entry, now);
    this.#activeNodes.clear();
  }
}

// Renderização offline real do arranjo (mesma realização do transporte).
// Com `attempts` ({start,end,pitch?} em segundos desde o primeiro compasso
// avaliado, como entregues por onFinish), o canal da frase toca a execução
// real por teclado/toque em vez da referência, após a contagem.
export async function renderSession(session, {
  loops, sampleRate = 44100, attempts = null, countIn = attempts !== null, tailSeconds = 1, contextFactory = null,
} = {}) {
  const valid = checkedSession(session);
  const training = attempts !== null;
  loops ??= training ? valid.training.repetitions : 1;
  if (!Number.isInteger(loops) || loops < 1 || loops > 64) throw new TypeError('O número de repetições deve ser de 1 a 64.');
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000
    || !Number.isFinite(tailSeconds) || tailSeconds < 0 || tailSeconds > 10) throw new TypeError('Taxa de amostragem ou cauda inválida.');
  if (training && (!Array.isArray(attempts) || attempts.some(attempt => !attempt || !Number.isFinite(attempt.start)
    || attempt.start < 0 || !Number.isFinite(attempt.end) || attempt.end < attempt.start
    || (attempt.pitch != null && (!Number.isInteger(attempt.pitch) || attempt.pitch < 0 || attempt.pitch > 127))))) {
    throw new TypeError('As tentativas devem ter início/término válidos em segundos e altura MIDI opcional.');
  }
  const arrangement = prepareArrangement(valid);
  const plan = compileBarPlan(valid, { training, repetitions: loops });
  const barTicks = ticksPerBar(valid);
  const secPerTick = secondsPerTick(valid.bpm);
  const countInBars = countIn ? valid.training.countInBars : 0;
  const countSeconds = countInBars * barTicks * secPerTick;
  const endTime = countSeconds + plan.duration * loops;
  const length = Math.max(1, Math.ceil((endTime + tailSeconds) * sampleRate));
  const ctx = contextFactory
    ? contextFactory({ numberOfChannels: 2, length, sampleRate })
    : new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const { buses, master } = createBuses(ctx, valid.mixer);
  // A mesma parada musical do transporte: nenhuma voz cruza o fim finito.
  master.gain.setValueAtTime(0.45, Math.max(0, endTime - 0.01));
  master.gain.linearRampToValueAtTime(0, endTime);
  const samples = valid.drums.enabled ? await loadDrumSamples(ctx).catch(() => null) : null;
  const onsets = (attempts ?? []).map(attempt => countInBars * barTicks + attempt.start / secPerTick);
  for (let bar = 0; bar < countInBars; bar += 1) {
    for (const event of arrangement.countInEvents()) dispatch(ctx, buses, samples, event, (bar * barTicks + event.tick) * secPerTick, secPerTick);
  }
  for (let index = 0; index < plan.bars.length * loops; index += 1) {
    const descriptor = plan.at(index);
    const start = countSeconds + plan.timeAt(index);
    const events = descriptor.events({ barIndex: index, includePhrase: !training,
      activity: activityFor(onsets, index + countInBars, barTicks) });
    for (const event of events) {
      const time = Math.max(countSeconds, start + event.tick * descriptor.secPerTick + (event.offsetMs ?? 0) / 1000);
      if (time < endTime) dispatch(ctx, buses, samples, event, time, descriptor.secPerTick);
    }
  }
  for (const attempt of attempts ?? []) {
    const start = countSeconds + attempt.start;
    if (start >= endTime || attempt.end <= attempt.start) continue;
    const end = Math.min(countSeconds + attempt.end, endTime);
    const sessionTick = valid.loop.startBar * barTicks + ((attempt.start / secPerTick) % (plan.bars.length * barTicks));
    playTone(ctx, buses.phrase, {
      time: start, duration: end - start, pitch: attempt.pitch ?? referencePitch(valid, sessionTick),
      velocity: 0.8, timbre: valid.timbres.phrase, articulation: 'tenuto',
    });
  }
  return ctx.startRendering();
}
