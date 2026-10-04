// Transporte próprio do repertório (AudioContext separado do motor do estúdio).
// A visão garante a exclusão mútua: chama host.stop() antes de tocar e a UI chama
// stop() do repertório antes de tocar o estúdio.
//
// Modos:
// - single: um buffer (original ou trecho já processado) com laço opcional;
// - sequence: etapas agendadas sem emendas no relógio do áudio (escada de velocidade);
// - ab: dois buffers iniciados no MESMO instante; alternar troca só os ganhos,
//   então A e B permanecem sincronizados na mesma posição relativa.

const START_DELAY_SEC = 0.04;
const SWITCH_SEC = 0.012;

export class RepertoirePlayer {
  #ctx = null;
  #master = null;
  #nodes = [];
  #plan = null;
  #onEnded;

  constructor({ onEnded = () => {} } = {}) {
    this.#onEnded = onEnded;
  }

  get playing() {
    return this.#plan !== null;
  }

  get mode() {
    return this.#plan?.kind ?? 'idle';
  }

  get sampleRate() {
    return this.#context().sampleRate;
  }

  #context() {
    if (this.#ctx) return this.#ctx;
    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Este navegador não oferece Web Audio; não é possível tocar ou decodificar áudio.');
    this.#ctx = new AudioContextClass();
    this.#master = this.#ctx.createGain();
    this.#master.connect(this.#ctx.destination);
    return this.#ctx;
  }

  async decode(arrayBuffer) {
    return this.#context().decodeAudioData(arrayBuffer);
  }

  createBuffer(channels, sampleRate) {
    const ctx = this.#context();
    const length = Math.max(1, channels[0]?.length ?? 1);
    const buffer = ctx.createBuffer(channels.length, length, sampleRate);
    channels.forEach((channel, index) => buffer.copyToChannel(channel, index));
    return buffer;
  }

  async #prepare() {
    this.stop();
    const ctx = this.#context();
    const plan = { kind: 'pending' };
    this.#plan = plan;
    if (ctx.state === 'suspended') await ctx.resume();
    return this.#plan === plan ? ctx : null; // stop() venceu durante resume()
  }

  #source(buffer, gainValue) {
    const ctx = this.#ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    source.connect(gain).connect(this.#master);
    this.#nodes.push({ source, gain });
    return { source, gain };
  }

  #ended(plan) {
    if (this.#plan !== plan) return;
    this.#teardown();
    this.#onEnded(plan.kind);
  }

  async playSingle({ buffer, offset = 0, loop = false, loopStart = 0, loopEnd = buffer.duration, originStart = 0, speed = 1, gain = 1, label = '' }) {
    const ctx = await this.#prepare();
    if (!ctx) return false;
    const start = Math.max(0, Math.min(offset, buffer.duration));
    const { source } = this.#source(buffer, gain);
    const when = ctx.currentTime + START_DELAY_SEC;
    if (loop && loopEnd - loopStart > 0.01) {
      source.loop = true;
      source.loopStart = loopStart;
      source.loopEnd = loopEnd;
      source.start(when, start >= loopEnd ? loopStart : start);
    } else {
      const end = Math.min(loopEnd, buffer.duration);
      source.start(when, start, Math.max(0.001, end - start));
    }
    const plan = { kind: 'single', when, offset: start >= loopEnd && loop ? loopStart : start, loop: loop && loopEnd - loopStart > 0.01, loopStart, loopEnd, originStart, speed, label };
    source.onended = () => this.#ended(plan);
    this.#plan = plan;
    return true;
  }

  // steps: [{ buffer, loops, originStart, speed, label }]
  async playSequence(steps) {
    const ctx = await this.#prepare();
    if (!ctx) return false;
    let time = ctx.currentTime + START_DELAY_SEC;
    const scheduled = [];
    for (const step of steps) {
      const { source } = this.#source(step.buffer, step.gain ?? 1);
      const length = step.buffer.duration * step.loops;
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = step.buffer.duration;
      source.start(time, 0);
      source.stop(time + length);
      scheduled.push({ ...step, startTime: time, length, source });
      time += length;
    }
    const plan = { kind: 'sequence', when: scheduled[0]?.startTime ?? ctx.currentTime, steps: scheduled };
    scheduled[scheduled.length - 1].source.onended = () => this.#ended(plan);
    this.#plan = plan;
    return true;
  }

  async playAB({ a, b, length, active = 'a' }) {
    const ctx = await this.#prepare();
    if (!ctx) return false;
    const when = ctx.currentTime + START_DELAY_SEC;
    const sides = {};
    for (const [key, side] of [['a', a], ['b', b]]) {
      const { source, gain } = this.#source(side.buffer, key === active ? side.gain : 0);
      source.loop = true;
      source.loopStart = side.start;
      source.loopEnd = side.start + length;
      source.start(when, side.start);
      sides[key] = { ...side, gain, level: side.gain };
    }
    this.#plan = { kind: 'ab', when, length, active, sides };
    return true;
  }

  switchAB(which) {
    const plan = this.#plan;
    if (plan?.kind !== 'ab' || !['a', 'b'].includes(which)) return false;
    const now = this.#ctx.currentTime;
    for (const key of ['a', 'b']) {
      const param = plan.sides[key].gain.gain;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(key === which ? plan.sides[key].level : 0, now + SWITCH_SEC);
    }
    plan.active = which;
    return true;
  }

  #now() {
    const ctx = this.#ctx;
    return ctx.currentTime - (Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0);
  }

  // Posição em coordenadas do áudio ORIGINAL (segundos), para o cursor da forma de onda.
  position() {
    const plan = this.#plan;
    if (!plan || plan.kind === 'pending') return null;
    const elapsed = Math.max(0, this.#now() - plan.when);
    if (plan.kind === 'single') {
      let t = plan.offset + elapsed;
      if (plan.loop && t >= plan.loopEnd) t = plan.loopStart + ((t - plan.loopStart) % (plan.loopEnd - plan.loopStart));
      return { kind: 'single', time: plan.originStart + t * plan.speed, label: plan.label };
    }
    if (plan.kind === 'sequence') {
      let index = plan.steps.findIndex(step => elapsed < step.startTime - plan.when + step.length);
      if (index < 0) index = plan.steps.length - 1;
      const step = plan.steps[index];
      const local = Math.max(0, elapsed - (step.startTime - plan.when));
      const t = local % step.buffer.duration;
      return { kind: 'sequence', time: step.originStart + t * step.speed, step: index, steps: plan.steps.length, loop: Math.min(step.loops, Math.floor(local / step.buffer.duration) + 1), loops: step.loops, speed: step.speed, label: step.label };
    }
    const t = elapsed % plan.length;
    return { kind: 'ab', time: t, active: plan.active, a: plan.sides.a.start + t, b: plan.sides.b.start + t };
  }

  #teardown() {
    for (const { source, gain } of this.#nodes) {
      source.onended = null;
      try { source.stop(); } catch { /* já parado */ }
      source.disconnect();
      gain.disconnect();
    }
    this.#nodes = [];
    this.#plan = null;
  }

  stop() {
    this.#teardown();
  }

  async close() {
    this.stop();
    const ctx = this.#ctx;
    this.#ctx = null;
    if (ctx && ctx.state !== 'closed') await ctx.close();
  }
}
