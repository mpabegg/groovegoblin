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
 * - Coordenada do transporte: tick T contínuo desde o início (inclui a
 *   contagem). time(T) = anchorTime + (T - anchorTick) * secPerTick; mudar o
 *   andamento só reancora no instante atual. O compasso b do transporte é
 *   contagem (b < countInBars) ou o compasso de sessão
 *   loopStart + ((b - barBase) mod loopBars).
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
 * fazer os toques parecerem ATRASADOS. Não há calibração física aqui.
 *
 * Fechamento do treino
 * --------------------
 * O fim do treino e o gate de press/release usam o mesmo relógio
 * correlacionado à saída, para não descartar uma soltura feita em resposta
 * ao último som que a pessoa ainda está ouvindo.
 */

import { validateSession, MIXER_CHANNELS, BPM_MIN, BPM_MAX } from './session.js';
import { EPSILON, ticksPerBar, beatTicks, secondsPerTick, sessionTicks } from './meter.js';
import { prepareArrangement } from './arrangement.js';
import { playTone, playChord, playClick, playDrum, loadDrumSamples } from './synth.js';

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

function mod(value, base) {
  return ((value % base) + base) % base;
}

// Master com compressor suave para mixes com muitas vozes simultâneas.
function createBuses(ctx, mixer) {
  const master = ctx.createGain();
  master.gain.value = 0.9;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -10;
  compressor.knee.value = 6;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.2;
  master.connect(compressor);
  compressor.connect(ctx.destination);
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
  switch (event.kind) {
    case 'note':
    case 'pulse':
      return [playTone(ctx, buses[event.channel], {
        time, duration, pitch: event.pitch, velocity: event.velocity, timbre: event.timbre, articulation: event.articulation,
      })];
    case 'chord':
      return playChord(ctx, buses.chords, {
        time, duration, pitches: event.pitches, velocity: event.velocity, timbre: event.timbre, articulation: event.articulation,
      });
    case 'drum':
      return [playDrum(ctx, buses.drums, { time, instrument: event.instrument, velocity: event.velocity }, samples)];
    case 'click':
      return [playClick(ctx, buses.metronome, { time, accent: event.accent, velocity: event.velocity })];
    default:
      return [];
  }
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
  #mixer = Object.fromEntries(MIXER_CHANNELS.map(channel => [channel, { volume: 1, muted: false }]));

  #generation = 0;
  #timerId = null;
  #finishTimeoutId = null;

  #mode = null; // null | 'loop' | 'train' | 'preview'
  #session = null;
  #arrangement = null;
  #samples = null;
  #sampleStatus = 'unloaded';
  #startedAt = 0;

  #anchorTime = 0;
  #anchorTick = 0;
  #secPerTick = 0;
  #barTicks = 16;
  #countInBars = 0;
  #loopStart = 0;
  #loopBars = 1;
  #repetitions = 0;
  #barBase = 0;
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
  #previewResolve = null;

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

  setMixer(mixer) {
    for (const channel of MIXER_CHANNELS) {
      if (!mixer || !mixer[channel]) continue;
      const { volume, muted } = mixer[channel];
      this.#mixer[channel] = { volume, muted };
      if (this.#buses) this.#setGain(this.#buses[channel], muted ? 0 : volume);
    }
  }

  async playSession(session, { mode = 'loop' } = {}) {
    if (mode !== 'loop' && mode !== 'train') throw new TypeError('O modo de reprodução deve ser loop ou train.');
    const valid = checkedSession(session);
    this.stop();
    const gen = this.#generation;
    const ctx = this.#ensureContext();
    this.#session = valid;
    this.setMixer(valid.mixer);

    await Promise.all([
      ctx.state === 'suspended' ? ctx.resume() : Promise.resolve(),
      valid.drums.enabled ? this.#loadSamples() : Promise.resolve(),
    ]);
    if (gen !== this.#generation) return; // stop() venceu durante resume/carregamento

    const train = mode === 'train';
    this.#arrangement = prepareArrangement(valid);
    this.#barTicks = ticksPerBar(valid);
    this.#secPerTick = secondsPerTick(valid.bpm);
    this.#countInBars = train ? valid.training.countInBars : 0;
    this.#loopStart = valid.loop.startBar;
    this.#loopBars = valid.loop.endBar - valid.loop.startBar;
    this.#repetitions = train ? valid.training.repetitions : 0;
    this.#endBar = train ? this.#countInBars + this.#loopBars * this.#repetitions : Infinity;
    this.#barBase = this.#countInBars;
    this.#nextBar = 0;
    this.#pending = [];
    this.#onsets = [];
    this.#anchorTick = 0;
    this.#anchorTime = ctx.currentTime + SESSION_PRIME_SEC;
    this.#dispatchedTime = this.#anchorTime;
    this.#attempts = [];
    this.#heldAttempt = null;
    this.#held = false;
    this.#heldPitch = null;
    this.#startedAt = Date.now();
    this.#mode = mode;
    this.#emitState();
    this.#runScheduler(gen);
    if (train) this.#scheduleFinish(gen);
  }

  // Aplica mudanças ao vivo. Em 'loop' tudo vale (andamento, notas, compasso,
  // loop, banda...); mudanças estruturais (compasso/loop) entram no próximo
  // compasso. Em 'train' a grade avaliada fica congelada: só mixer, banda,
  // metrônomo, pulso e timbres mudam.
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
    const ctx = this.#ctx;
    const structural = ticksPerBar(valid) !== this.#barTicks
      || valid.loop.startBar !== previous.loop.startBar || valid.loop.endBar !== previous.loop.endBar;
    if (valid.bpm !== previous.bpm) this.#reanchor(ctx.currentTime, secondsPerTick(valid.bpm));

    const dispatchedTick = this.#tickAtTime(this.#dispatchedTime);
    const currentBar = Math.max(0, Math.floor((dispatchedTick + EPSILON) / this.#barTicks));
    this.#session = valid;
    this.#arrangement = prepareArrangement(valid);
    if (valid.drums.enabled && !this.#samples) this.#loadSamples().catch(() => {});

    if (structural) {
      // O compasso em curso termina como estava; o novo layout começa no próximo.
      const nextBar = Math.max(currentBar + 1, this.#countInBars);
      const boundary = nextBar * this.#barTicks;
      this.#pending = this.#pending.filter(item => item.transportTick < boundary - EPSILON);
      const boundaryTime = this.#timeOfTick(boundary);
      const sessionBar = this.#sessionBarOf(Math.max(currentBar, this.#countInBars));
      const newTicks = ticksPerBar(valid);
      // Eventos restantes do compasso atual mudam para a nova coordenada.
      const shift = nextBar * newTicks - boundary;
      for (const item of this.#pending) {
        item.transportTick += shift;
        item.key += shift;
      }
      this.#barTicks = newTicks;
      this.#anchorTime = boundaryTime;
      this.#anchorTick = nextBar * newTicks;
      this.#onsets = [];
      this.#loopStart = valid.loop.startBar;
      this.#loopBars = valid.loop.endBar - valid.loop.startBar;
      const following = sessionBar + 1;
      const target = following >= this.#loopStart && following < valid.loop.endBar ? following : this.#loopStart;
      this.#barBase = nextBar - (target - this.#loopStart);
      this.#nextBar = nextBar;
    } else {
      this.#pending = [];
      this.#nextBar = currentBar;
      if (currentBar < this.#endBar) this.#generateBar(currentBar, this.#dispatchedTime);
      this.#nextBar = currentBar + 1;
    }
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
    this.#mode = null;
    this.#pending = [];
    this.#onsets = [];
    this.#attempts = [];
    this.#heldAttempt = null;
    this.#held = false;
    this.#heldPitch = null;
    this.#keyDown = false;
    const resolve = this.#previewResolve;
    this.#previewResolve = null;
    if (resolve) resolve();
    if (wasActive) this.#emitState(); // treino interrompido não entrega onFinish
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
    if (gen !== this.#generation) return;
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
    await new Promise(resolve => {
      this.#previewResolve = resolve;
      this.#finishTimeoutId = setTimeout(() => {
        if (gen !== this.#generation) return;
        this.#finishTimeoutId = null;
        this.#previewResolve = null;
        this.#mode = null;
        resolve();
      }, Math.max(0, (end - ctx.currentTime + PREVIEW_TAIL_SEC) * 1000));
    });
  }

  press(eventTimeStamp = performance.now(), pitch = null) {
    if (this.#keyDown) return; // repetição de tecla do SO, independente do modo
    this.#keyDown = true;
    if (pitch !== null && (!Number.isInteger(pitch) || pitch < 0 || pitch > 127)) pitch = null;
    const mode = this.position.mode;
    const audioTime = this.#ctx ? this.#toAudioTime(eventTimeStamp) : 0;
    let sessionTick = 0;
    if (mode === 'loop' || mode === 'train' || mode === 'countin') {
      const tick = this.#tickAtTime(audioTime);
      this.#onsets.push(tick);
      const keep = tick - this.#barTicks * 3;
      this.#onsets = this.#onsets.filter(value => value >= keep);
      const bar = Math.floor(tick / this.#barTicks);
      if (bar >= this.#countInBars) sessionTick = this.#sessionBarOf(bar) * this.#barTicks + (tick - bar * this.#barTicks);
    }
    this.#startMonitor(pitch ?? (this.#session ? referencePitch(this.#session, sessionTick) : 69));
    if (mode !== 'train') return; // ignora idle/contagem/loop

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
    this.#heldAttempt.end = Math.max(t, this.#heldAttempt.start);
    this.#heldAttempt = null;
    this.#held = false;
    this.#heldPitch = null;
    this.#emitState();
  }

  // {mode, tick (sessão), bar (1-based, compasso da sessão), beat (1-based na
  // unidade do compasso), repetition (treino 1..N; loop: passagem 1..),
  // repetitions (treino), held, pitch, startTick/endTick do loop,
  // ticksPerBar, countInBar/countInBars, bpm, previewing}.
  get position() {
    const idle = {
      mode: 'idle', tick: 0, bar: 1, beat: 1, repetition: 0, repetitions: 0, held: false, pitch: null,
      startTick: 0, endTick: this.#session ? sessionTicks(this.#session) : 16, ticksPerBar: this.#session ? ticksPerBar(this.#session) : 16,
      countInBar: 0, countInBars: 0, bpm: this.#session?.bpm ?? 0, previewing: this.#mode === 'preview',
    };
    if (!this.#ctx || this.#mode === null || this.#mode === 'preview') return idle;
    const tick = Math.max(0, this.#tickAtTime(this.#nowAudioTime()));
    const bar = Math.floor(tick / this.#barTicks);
    if (bar >= this.#endBar) return idle;
    const local = tick - bar * this.#barTicks;
    const beat = Math.floor(local / beatTicks(this.#session)) + 1;
    const base = {
      held: this.#held, pitch: this.#heldPitch, beat, ticksPerBar: this.#barTicks,
      startTick: this.#loopStart * this.#barTicks, endTick: (this.#loopStart + this.#loopBars) * this.#barTicks,
      repetitions: this.#repetitions, countInBars: this.#countInBars, bpm: this.#session.bpm, previewing: false,
    };
    if (bar < this.#countInBars) {
      return { ...base, mode: 'countin', tick: base.startTick, bar: this.#loopStart + 1, repetition: 0, countInBar: bar + 1 };
    }
    const sessionBar = this.#sessionBarOf(bar);
    const repetition = this.#mode === 'train'
      ? Math.floor((bar - this.#countInBars) / this.#loopBars) + 1
      : Math.floor((bar - this.#barBase) / this.#loopBars) + 1;
    return { ...base, mode: this.#mode, tick: sessionBar * this.#barTicks + local, bar: sessionBar + 1, repetition, countInBar: 0 };
  }

  // -- internals ------------------------------------------------------

  #sessionBarOf(bar) {
    return this.#loopStart + mod(bar - this.#barBase, this.#loopBars);
  }

  #timeOfTick(tick) {
    return this.#anchorTime + (tick - this.#anchorTick) * this.#secPerTick;
  }

  #tickAtTime(time) {
    return this.#anchorTick + (time - this.#anchorTime) / this.#secPerTick;
  }

  #reanchor(time, secPerTick) {
    this.#anchorTick = this.#tickAtTime(time);
    this.#anchorTime = time;
    this.#secPerTick = secPerTick;
  }

  #trainStartTime() {
    return this.#timeOfTick(this.#countInBars * this.#barTicks);
  }

  #ensureContext() {
    if (!this.#ctx) {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      this.#ctx = new Ctor();
      this.#buses = createBuses(this.#ctx, this.#mixer).buses;
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

  #generateBar(bar, notBefore = -Infinity) {
    const train = this.#mode === 'train';
    const events = bar < this.#countInBars
      ? this.#arrangement.countInEvents()
      : this.#arrangement.barEvents(this.#sessionBarOf(bar), {
        barIndex: bar - this.#countInBars,
        includePhrase: !train,
        activity: activityFor(this.#onsets, bar, this.#barTicks),
      });
    const barStart = bar * this.#barTicks;
    for (const event of events) {
      const transportTick = barStart + event.tick;
      if (this.#timeOfTick(transportTick) + event.offsetMs / 1000 < notBefore - EPSILON) continue;
      this.#pending.push({ transportTick, event, key: transportTick + event.offsetMs / 1000 / this.#secPerTick });
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
      const { transportTick, event } = this.#pending[0];
      let time = this.#timeOfTick(transportTick) + event.offsetMs / 1000;
      if (time >= horizon) break;
      this.#pending.shift();
      if (time < now) {
        if (now - time > LATE_DROP_SEC) continue; // aba congelada: não despeja eventos atrasados
        time = now;
      }
      for (const entry of dispatch(ctx, this.#buses, this.#samples, event, time, this.#secPerTick)) this.#track(entry);
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
      const remaining = this.#timeOfTick(this.#endBar * this.#barTicks) - this.#nowAudioTime();
      if (remaining <= 0) this.#finishTrain(gen);
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
    const session = this.#session;
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
    const ctx = this.#ctx;
    if (typeof ctx.getOutputTimestamp === 'function') {
      const { contextTime, performanceTime } = ctx.getOutputTimestamp();
      const valid = Number.isFinite(contextTime) && Number.isFinite(performanceTime)
        && !(contextTime === 0 && performanceTime === 0);
      if (valid) return contextTime + (eventTimeStampMs - performanceTime) / 1000;
    }
    // Sem correlação de saída válida: par novo (performance.now(), currentTime)
    // agora, nunca uma âncora em cache (currentTime congela em suspend/resume).
    const fallbackPerfMs = performance.now();
    return ctx.currentTime + (eventTimeStampMs - fallbackPerfMs) / 1000;
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
  loops = 1, sampleRate = 44100, attempts = null, countIn = Boolean(attempts), tailSeconds = 1, contextFactory = null,
} = {}) {
  const valid = checkedSession(session);
  if (!Number.isInteger(loops) || loops < 1 || loops > 64) throw new TypeError('O número de repetições deve ser de 1 a 64.');
  if (attempts !== null && (!Array.isArray(attempts) || attempts.some(attempt => !attempt || !Number.isFinite(attempt.start)))) {
    throw new TypeError('As tentativas devem ser uma lista de {start, end}.');
  }
  const arrangement = prepareArrangement(valid);
  const barTicks = ticksPerBar(valid);
  const secPerTick = secondsPerTick(valid.bpm);
  const countInBars = countIn ? valid.training.countInBars : 0;
  const loopBars = valid.loop.endBar - valid.loop.startBar;
  const totalBars = countInBars + loopBars * loops;
  const length = Math.ceil((totalBars * barTicks * secPerTick + tailSeconds) * sampleRate);
  const ctx = contextFactory
    ? contextFactory({ numberOfChannels: 2, length, sampleRate })
    : new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const { buses } = createBuses(ctx, valid.mixer);
  const samples = valid.drums.enabled ? await loadDrumSamples(ctx).catch(() => null) : null;
  const trainStart = countInBars * barTicks;
  const onsets = (attempts ?? []).map(attempt => trainStart + attempt.start / secPerTick);

  for (let bar = 0; bar < totalBars; bar += 1) {
    const events = bar < countInBars
      ? arrangement.countInEvents()
      : arrangement.barEvents(valid.loop.startBar + ((bar - countInBars) % loopBars), {
        barIndex: bar - countInBars, includePhrase: !attempts, activity: activityFor(onsets, bar, barTicks),
      });
    for (const event of events) {
      const time = Math.max(0, (bar * barTicks + event.tick) * secPerTick + event.offsetMs / 1000);
      dispatch(ctx, buses, samples, event, time, secPerTick);
    }
  }
  for (const attempt of attempts ?? []) {
    const start = trainStart * secPerTick + attempt.start;
    if (start < 0) continue;
    const end = Number.isFinite(attempt.end) ? attempt.end : attempt.start + 0.1;
    const sessionTick = valid.loop.startBar * barTicks + ((attempt.start / secPerTick) % (loopBars * barTicks));
    playTone(ctx, buses.phrase, {
      time: start, duration: Math.max(0.03, end - attempt.start), pitch: attempt.pitch ?? referencePitch(valid, sessionTick),
      velocity: 0.8, timbre: valid.timbres.phrase, articulation: 'tenuto',
    });
  }
  return ctx.startRendering();
}
