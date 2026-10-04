/**
 * GrooveAudio — Web Audio engine for GrooveGoblin.
 *
 * Architecture
 * ------------
 * - A single lookahead scheduler (classic "setInterval wakes up, schedule a
 *   little further into the future than we already have" pattern) enqueues
 *   oscillator/gain nodes onto the real AudioContext timeline. It never uses
 *   requestAnimationFrame: rAF is reserved for the UI, which should instead
 *   poll `position` on its own rAF loop.
 * - `position` is PULLED, not cached: every read re-derives mode/tick/beat/
 *   repetition from the current output-correlated audio instant (see below)
 *   against the single `#sessionStartTime` anchor recorded when play()/
 *   train() began. `tick` is fractional (smooth playhead), `beat` is 1..4.
 *   Hardware timestamps are a browser-provided *estimate*, not a physical
 *   guarantee — treat `position` as a conservative approximation for UI
 *   animation, not a sample-accurate measurement.
 * - `onState` is PUSHED on transitions: the same lookahead interval re-reads
 *   `position` each tick and fires the callback only when mode/repetition/
 *   held actually changed, plus a one-off watchdog timer closes out training
 *   once the output-correlated clock (not the raw processing clock) reaches
 *   the boundary — see "Output-clock gating" below for why.
 * - A monotonically increasing `#generation` counter guards every `await
 *   ctx.resume()` continuation. stop() always bumps it first, so if stop()
 *   races a pending resume() (or a second play()/train() call races a first
 *   one), the stale continuation notices the mismatch and aborts before
 *   touching the graph or firing callbacks.
 *
 * Timestamp → audio domain mapping (press/release)
 * -------------------------------------------------
 * press()/release() receive a `performance.now()`-domain timestamp (DOM
 * event.timeStamp shares that clock) and must report seconds relative to
 * the start of training's first repetition, in the *audio* clock domain,
 * since that is the clock every scheduled click/boundary is expressed in.
 *
 * The conservative, non-calibrating way to correlate the two clocks is
 * `AudioContext.getOutputTimestamp()`, which returns a simultaneous
 * (contextTime, performanceTime) pair describing what is physically at the
 * speakers *right now* — i.e. it already reflects the hardware/output
 * latency between scheduling a sound and a user actually hearing it. We
 * read a fresh pair on every conversion (no caching, no drift assumptions,
 * no measurement routine) and linearly project the event timestamp through
 * it: `audioTime = contextTime + (eventMs - performanceTime) / 1000`.
 *
 * Where `getOutputTimestamp` is unavailable or returns a degenerate/zeroed
 * stub, we fall back to reading a fresh (performance.now(), ctx.currentTime)
 * pair at the moment of *each* conversion — never a pair cached once at
 * context creation, because `currentTime` freezes while the context is
 * suspended and a stale anchor would silently desync across a suspend/
 * resume cycle. That fallback still ignores output latency entirely (no
 * output clock to read), and since raw `currentTime` is the processing
 * clock running slightly *ahead* of what is actually audible, events
 * mapped through it tend to read as later in the schedule than what the
 * user really heard — i.e. onsets/releases skew towards appearing late,
 * not early. This is a real limitation worth surfacing in the UI/report,
 * not something this module tries to auto-correct.
 *
 * Output-clock gating (position / press-release / train finish)
 * ----------------------------------------------------------------
 * `position`'s mode/tick/repetition (and therefore the press()/release()
 * mode gate, since both call the `position` getter) and the training
 * finish watchdog are all derived from the same output-correlated instant
 * used to map press/release timestamps, not from raw `ctx.currentTime`.
 * Raw `currentTime` is the processing clock and runs ahead of what is
 * physically audible; gating on it would flip to 'idle' (and fire
 * onFinish) slightly before the user has actually heard the final click,
 * potentially discarding a last release the user makes in direct response
 * to a sound they are only now hearing. The lookahead scheduler itself
 * (enqueuing oscillators ahead of time) still uses raw `ctx.currentTime`,
 * since Web Audio scheduling is necessarily expressed on that clock.
 *
 * Note envelopes (attack contrast + held sustain)
 * ----------------------------------------------
 * Each model note ramps from zero to an attack peak, decays to a lower
 * nonzero sustain level, then releases to zero exactly at its nominal end.
 * The peak makes each new onset stand out from the preceding sustain,
 * including adjacent notes and the loop seam, without inserting a rest or
 * moving an onset/end. Notation ties are parts of one model note, so they
 * share one envelope: there is no re-attack at a beat or internal barline.
 * Each ramp is capped at a quarter of the duration to keep short notes'
 * stages ordered and leave a held sustain before release.
 */

import { TICKS_PER_BAR, BAR_OPTIONS } from './model.js';
import { DRUM_INSTRUMENTS } from './drums.js';

const TICKS_PER_BEAT = 4;

const LOOKAHEAD_INTERVAL_SEC = 0.025;
const SCHEDULE_AHEAD_SEC = 0.1;
const SESSION_PRIME_SEC = 0.06;

const NOTE_ATTACK_SEC = 0.004;
const NOTE_DECAY_SEC = 0.025;
const NOTE_RELEASE_SEC = 0.015;
const NOTE_FREQUENCY_HZ = 440;
const NOTE_PEAK_GAIN = 0.55;
const NOTE_SUSTAIN_GAIN = 0.22;

const CLICK_DURATION_SEC = 0.035;
const CLICK_GAIN = 0.4;
const CLICK_ACCENT_GAIN = 0.55;
const CLICK_FREQUENCY_HZ = 1500;
const CLICK_ACCENT_FREQUENCY_HZ = 2200;

const DRUM_SAMPLE_URLS = Object.freeze({
  kick: new URL('../assets/drums/kick.wav', import.meta.url),
  snare: new URL('../assets/drums/snare.wav', import.meta.url),
  hihat: new URL('../assets/drums/hihat.wav', import.meta.url),
});
// Peaks leave room for the reference; original decoded samples stay untouched.
const DRUM_PEAK_GAINS = Object.freeze({ kick: 0.24, snare: 0.2, hihat: 0.1 });
const DRUM_FADE_SEC = 0.01;

export class GrooveAudio {
  #onStateCb;
  #onFinishCb;

  #ctx = null;
  #masterGain = null;

  #generation = 0;
  #timerId = null;
  #finishTimeoutId = null;

  #sessionKind = null; // null | 'play' | 'train'
  #sessionStartTime = 0; // ctx.currentTime anchor for the active session
  #secPerTick = 0;
  #scheduleCursor = 0; // next tick index not yet handed to the audio graph
  #notes = [];
  #metronomeEnabled = false;
  #drumHits = [];
  #drumsEnabled = false;
  #drumGain = null;
  #drumBuffers = null;
  #drumLoad = null;
  #drumGeneration = 0;
  #totalTicks = TICKS_PER_BAR; // ticks por repeticao/loop: bars * TICKS_PER_BAR

  #attempts = [];
  #heldAttempt = null;
  #held = false;
  #keyDown = false;

  #activeNodes = new Set();
  #lastSnapshot = null;

  constructor({ onState = () => {}, onFinish = () => {} } = {}) {
    this.#onStateCb = onState;
    this.#onFinishCb = onFinish;
  }

  async play(notes, bpm, metronome, bars = 1, { hits = [], enabled = false } = {}) {
    this.stop();
    const gen = this.#generation;
    const ctx = this.#ensureContext();

    this.#notes = notes;
    this.#secPerTick = 60 / bpm / TICKS_PER_BEAT;
    this.#metronomeEnabled = !!metronome;
    this.#totalTicks = TICKS_PER_BAR * this.#validBars(bars);
    this.#drumHits = hits;
    this.#drumsEnabled = !!enabled;
    this.#setDrumGain(0, true);

    await Promise.all([
      ctx.state === 'suspended' ? ctx.resume() : Promise.resolve(),
      enabled ? this.#loadDrums() : Promise.resolve(),
    ]);
    if (gen !== this.#generation) return; // stop() won during resume/sample loading
    this.#setDrumGain(enabled ? 1 : 0);

    this.#sessionKind = 'play';
    this.#scheduleCursor = 0;
    this.#sessionStartTime = ctx.currentTime + SESSION_PRIME_SEC;
    this.#emitState();
    this.#runScheduler(gen);
  }

  async train(notes, bpm, bars = 1) {
    this.stop();
    const gen = this.#generation;
    const ctx = this.#ensureContext();

    void notes; // training is never sonified; kept for signature parity with play()
    this.#notes = [];
    this.#secPerTick = 60 / bpm / TICKS_PER_BEAT;
    this.#metronomeEnabled = true;
    this.#totalTicks = TICKS_PER_BAR * this.#validBars(bars);

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    if (gen !== this.#generation) return; // stop() won the race during resume()

    this.#sessionKind = 'train';
    this.#scheduleCursor = 0;
    this.#sessionStartTime = ctx.currentTime + SESSION_PRIME_SEC;
    this.#attempts = [];
    this.#heldAttempt = null;
    this.#held = false;
    this.#keyDown = false;
    this.#emitState();
    this.#runScheduler(gen);

    const totalDuration = (TICKS_PER_BAR + this.#totalTicks * 4) * this.#secPerTick;
    this.#scheduleFinish(gen, totalDuration);
  }

  stop() {
    const wasActive = this.#sessionKind !== null;
    this.#generation += 1; // invalidates any in-flight resume()/finish continuation
    this.#drumGeneration += 1;
    this.#drumsEnabled = false;
    this.#setDrumGain(0);

    if (this.#timerId !== null) {
      clearInterval(this.#timerId);
      this.#timerId = null;
    }
    if (this.#finishTimeoutId !== null) {
      clearTimeout(this.#finishTimeoutId);
      this.#finishTimeoutId = null;
    }

    this.#silenceActiveNodes();

    this.#sessionKind = null;
    this.#sessionStartTime = 0;
    this.#attempts = [];
    this.#heldAttempt = null;
    this.#held = false;
    this.#keyDown = false;
    this.#scheduleCursor = 0;

    if (wasActive) this.#emitState(); // interrupted training delivers no onFinish
  }

  setMetronome(enabled) {
    this.#metronomeEnabled = !!enabled;
  }

  async setDrumsEnabled(enabled) {
    const request = ++this.#drumGeneration;
    const gen = this.#generation;
    this.#drumsEnabled = !!enabled;
    this.#setDrumGain(0);
    if (!enabled || this.#sessionKind !== 'play') return true;
    try {
      await this.#loadDrums();
    } catch (error) {
      if (request !== this.#drumGeneration || gen !== this.#generation) return false;
      this.#drumsEnabled = false;
      throw error;
    }
    if (request !== this.#drumGeneration || gen !== this.#generation) return false;
    this.#setDrumGain(1);
    return true;
  }

  press(eventTimeStamp = performance.now()) {
    if (this.#keyDown) return; // OS key-repeat guard, independent of mode
    this.#keyDown = true;
    if (this.position.mode !== 'train') return; // ignores idle/countin/play

    const t = this.#toAudioTime(eventTimeStamp) - this.#trainStartAudioTime();
    const attempt = { start: t, end: null };
    this.#attempts.push(attempt);
    this.#heldAttempt = attempt;
    this.#held = true;
    this.#emitState();
  }

  release(eventTimeStamp = performance.now()) {
    if (!this.#keyDown) return;
    this.#keyDown = false;
    if (!this.#heldAttempt) return; // the matching press was ignored (repeat/countin)

    const t = this.#toAudioTime(eventTimeStamp) - this.#trainStartAudioTime();
    this.#heldAttempt.end = Math.max(t, this.#heldAttempt.start);
    this.#heldAttempt = null;
    this.#held = false;
    this.#emitState();
  }

  get position() {
    const ctx = this.#ctx;
    if (!ctx || this.#sessionKind === null) {
      return { mode: 'idle', tick: 0, repetition: 0, bar: 1, beat: 1, held: false };
    }

    const now = this.#nowAudioTime();
    const elapsedTicks = Math.max(0, (now - this.#sessionStartTime) / this.#secPerTick);

    if (this.#sessionKind === 'play') {
      const tick = elapsedTicks % this.#totalTicks;
      return {
        mode: 'play',
        tick,
        repetition: 0,
        bar: Math.floor(tick / TICKS_PER_BAR) + 1,
        beat: Math.floor((tick % TICKS_PER_BAR) / TICKS_PER_BEAT) + 1,
        held: false,
      };
    }

    // 'train': one measure of count-in (always a single 4/4 bar), then four
    // evaluated repetitions of the whole phrase (bars * 16 ticks each).
    if (elapsedTicks < TICKS_PER_BAR) {
      return {
        mode: 'countin',
        tick: elapsedTicks,
        repetition: 0,
        bar: 1,
        beat: Math.floor(elapsedTicks / TICKS_PER_BEAT) + 1,
        held: this.#held,
      };
    }
    const trainTicks = elapsedTicks - TICKS_PER_BAR;
    if (trainTicks < this.#totalTicks * 4) {
      const tick = trainTicks % this.#totalTicks;
      return {
        mode: 'train',
        tick,
        repetition: Math.floor(trainTicks / this.#totalTicks) + 1,
        bar: Math.floor(tick / TICKS_PER_BAR) + 1,
        beat: Math.floor((tick % TICKS_PER_BAR) / TICKS_PER_BEAT) + 1,
        held: this.#held,
      };
    }
    return { mode: 'idle', tick: 0, repetition: 0, bar: 1, beat: 1, held: false };
  }

  get context() {
    return this.#ctx;
  }

  // -- internals ------------------------------------------------------

  #trainStartAudioTime() {
    return this.#sessionStartTime + TICKS_PER_BAR * this.#secPerTick;
  }

  #validBars(bars) {
    return BAR_OPTIONS.includes(bars) ? bars : 1;
  }

  #ensureContext() {
    if (!this.#ctx) {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      const ctx = new Ctor();
      this.#ctx = ctx;
      this.#masterGain = ctx.createGain();
      this.#masterGain.gain.value = 1;
      this.#masterGain.connect(ctx.destination);
      this.#drumGain = ctx.createGain();
      this.#drumGain.gain.value = 0;
      this.#drumGain.connect(this.#masterGain);
    }
    return this.#ctx;
  }

  #setDrumGain(value, immediate = false) {
    if (!this.#drumGain) return;
    const gain = this.#drumGain.gain;
    const now = this.#ctx.currentTime;
    if (!immediate && typeof gain.cancelAndHoldAtTime === 'function') {
      gain.cancelAndHoldAtTime(now);
    } else {
      const current = gain.value;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(current, now);
    }
    if (immediate) gain.setValueAtTime(value, now);
    else gain.linearRampToValueAtTime(value, now + DRUM_FADE_SEC);
  }

  async #loadDrums() {
    if (this.#drumBuffers) return;
    if (!this.#drumLoad) {
      this.#drumLoad = Promise.all(DRUM_INSTRUMENTS.map(async instrument => {
        const response = await fetch(DRUM_SAMPLE_URLS[instrument]);
        if (!response.ok) throw new Error(`${instrument}.wav: HTTP ${response.status}`);
        const buffer = await this.#ctx.decodeAudioData(await response.arrayBuffer());
        let peak = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
          const data = buffer.getChannelData(channel);
          for (let index = 0; index < data.length; index += 1) {
            peak = Math.max(peak, Math.abs(data[index]));
          }
        }
        const makeupGain = peak > 0 ? DRUM_PEAK_GAINS[instrument] / peak : 0;
        return [instrument, { buffer, makeupGain }];
      })).then(entries => {
        this.#drumBuffers = Object.fromEntries(entries);
      }).catch(error => {
        throw new Error(`Falha ao carregar samples de bateria: ${error.message}`);
      }).finally(() => { this.#drumLoad = null; });
    }
    await this.#drumLoad;
  }

  #toAudioTime(eventTimeStampMs) {
    const ctx = this.#ctx;
    if (typeof ctx.getOutputTimestamp === 'function') {
      const { contextTime, performanceTime } = ctx.getOutputTimestamp();
      const valid =
        Number.isFinite(contextTime) &&
        Number.isFinite(performanceTime) &&
        !(contextTime === 0 && performanceTime === 0);
      if (valid) {
        return contextTime + (eventTimeStampMs - performanceTime) / 1000;
      }
    }
    // No (valid) output-clock correlation available: read a fresh
    // (performance.now(), ctx.currentTime) pair right now rather than a
    // cached anchor, since currentTime freezes across suspend/resume and a
    // stale anchor would desync. Still ignores output latency entirely.
    const fallbackPerfMs = performance.now();
    const fallbackCtxSec = ctx.currentTime;
    return fallbackCtxSec + (eventTimeStampMs - fallbackPerfMs) / 1000;
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
    if (prev && prev.mode === pos.mode && prev.repetition === pos.repetition && prev.held === pos.held) {
      return;
    }
    this.#lastSnapshot = { mode: pos.mode, repetition: pos.repetition, held: pos.held };
    this.#onStateCb(pos);
  }

  #runScheduler(gen) {
    this.#tickScheduler(gen);
    this.#timerId = setInterval(() => this.#tickScheduler(gen), LOOKAHEAD_INTERVAL_SEC * 1000);
  }

  #tickScheduler(gen) {
    if (gen !== this.#generation) return;
    const ctx = this.#ctx;
    const horizon = ctx.currentTime + SCHEDULE_AHEAD_SEC;
    const isPlay = this.#sessionKind === 'play';
    const totalTrainTicks = TICKS_PER_BAR + this.#totalTicks * 4;

    while (true) {
      const tickTime = this.#sessionStartTime + this.#scheduleCursor * this.#secPerTick;
      if (tickTime >= horizon) break;
      if (!isPlay && this.#scheduleCursor >= totalTrainTicks) break;

      if (isPlay) {
        this.#schedulePlayTick(this.#scheduleCursor, tickTime);
      } else {
        this.#scheduleMetronomeTick(this.#scheduleCursor, tickTime);
      }
      this.#scheduleCursor += 1;
    }

    if (!isPlay && this.#scheduleCursor >= totalTrainTicks && this.#timerId !== null) {
      clearInterval(this.#timerId);
      this.#timerId = null;
    }

    this.#checkTransition();
  }

  #schedulePlayTick(tickIndex, time) {
    const tick = tickIndex % this.#totalTicks;
    if (this.#metronomeEnabled && tick % TICKS_PER_BEAT === 0) {
      this.#scheduleClick(time, tickIndex % TICKS_PER_BAR === 0);
    }
    for (const note of this.#notes) {
      if (note.start === tick) {
        this.#scheduleNote(time, note.duration * this.#secPerTick);
      }
    }
    if (this.#drumsEnabled && this.#drumBuffers) {
      for (const hit of this.#drumHits) {
        if (hit.start === tick) this.#scheduleDrum(time, hit);
      }
    }
  }

  #scheduleMetronomeTick(tickIndex, time) {
    // Count-in and the four evaluated repetitions share one uninterrupted
    // click pattern; evaluation is always audible and cannot be muted.
    // Accents mark the start of every bar of the phrase.
    if (tickIndex % TICKS_PER_BEAT === 0) {
      this.#scheduleClick(time, tickIndex % TICKS_PER_BAR === 0);
    }
  }

  #scheduleFinish(gen, totalDurationSec) {
    const check = () => {
      if (gen !== this.#generation) return;
      // Output-correlated, not raw ctx.currentTime: see module comment
      // "Output-clock gating" — avoids cutting off a release the user makes
      // in response to a sound they are only now actually hearing.
      const remaining = this.#sessionStartTime + totalDurationSec - this.#nowAudioTime();
      if (remaining <= 0) {
        this.#finishTrain(gen);
      } else {
        this.#finishTimeoutId = setTimeout(check, Math.max(4, remaining * 1000));
      }
    };
    check();
  }

  #finishTrain(gen) {
    if (gen !== this.#generation) return;
    if (this.#sessionKind !== 'train') return;

    const totalTrainDuration = this.#totalTicks * 4 * this.#secPerTick;
    if (this.#heldAttempt) {
      this.#heldAttempt.end = totalTrainDuration; // held through the end: close at the final boundary
      this.#heldAttempt = null;
    }
    this.#held = false;
    this.#keyDown = false;

    const attempts = this.#attempts;
    this.#attempts = [];
    if (this.#timerId !== null) {
      clearInterval(this.#timerId);
      this.#timerId = null;
    }
    this.#finishTimeoutId = null;
    this.#sessionKind = null;
    this.#sessionStartTime = 0;

    this.#emitState(); // -> idle
    this.#onFinishCb(attempts);
  }

  #scheduleClick(time, accent) {
    const ctx = this.#ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(accent ? CLICK_ACCENT_FREQUENCY_HZ : CLICK_FREQUENCY_HZ, time);

    const peak = accent ? CLICK_ACCENT_GAIN : CLICK_GAIN;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.002);
    gain.gain.linearRampToValueAtTime(0, time + CLICK_DURATION_SEC);

    osc.connect(gain).connect(this.#masterGain);
    osc.start(time);
    osc.stop(time + CLICK_DURATION_SEC + 0.005);
    this.#trackNode(osc, gain);
  }

  #scheduleNote(time, durationSec) {
    const ctx = this.#ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(NOTE_FREQUENCY_HZ, time);

    const attack = Math.min(NOTE_ATTACK_SEC, durationSec / 4);
    const decay = Math.min(NOTE_DECAY_SEC, durationSec / 4);
    const release = Math.min(NOTE_RELEASE_SEC, durationSec / 4);
    const sustainEnd = time + durationSec - release;

    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(NOTE_PEAK_GAIN, time + attack);
    gain.gain.linearRampToValueAtTime(NOTE_SUSTAIN_GAIN, time + attack + decay);
    gain.gain.setValueAtTime(NOTE_SUSTAIN_GAIN, sustainEnd);
    gain.gain.linearRampToValueAtTime(0, time + durationSec);

    osc.connect(gain).connect(this.#masterGain);
    osc.start(time);
    osc.stop(time + durationSec + 0.01);
    this.#trackNode(osc, gain);
  }

  #scheduleDrum(time, { instrument, velocity }) {
    const source = this.#ctx.createBufferSource();
    const gain = this.#ctx.createGain();
    const sample = this.#drumBuffers[instrument];
    source.buffer = sample.buffer;
    gain.gain.setValueAtTime(velocity * sample.makeupGain, time);
    source.connect(gain).connect(this.#drumGain);
    source.start(time);
    this.#trackNode(source, gain);
  }

  #trackNode(osc, gain) {
    const entry = { osc, gain };
    this.#activeNodes.add(entry);
    osc.onended = () => {
      this.#activeNodes.delete(entry);
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // already disconnected
      }
    };
  }

  #silenceActiveNodes() {
    const ctx = this.#ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const { osc, gain } of this.#activeNodes) {
      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.01);
        osc.stop(now + 0.015);
      } catch {
        // node already stopped/ended
      }
    }
    this.#activeNodes.clear();
  }
}
