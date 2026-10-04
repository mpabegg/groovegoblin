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

export class GrooveAudio {
  #onStateCb;
  #onFinishCb;

  #ctx = null;
  #masterGain = null;

  #generation = 0;
  #timerId = null;
  #finishTimeoutId = null;

  #sessionKind = null; // null | 'play' | 'progression' | 'train'
  #sessionStartTime = 0; // ctx.currentTime anchor for the active session
  #secPerTick = 0;
  #scheduleCursor = 0; // next tick index not yet handed to the audio graph
  #notes = [];
  #metronomeEnabled = false;
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

  play(notes, bpm, metronome, bars = 1) {
    return this.#startLoop(notes, bpm, metronome, TICKS_PER_BAR * this.#validBars(bars), 'play');
  }

  playProgression(progression, bpm, metronome = false) {
    // Tétrades são simultâneas; não passam pelo modelo monofônico de frases.
    const notes = progression.chords.flatMap((chord, index) => chord.notes.map(note => ({
      start: index * TICKS_PER_BAR, duration: TICKS_PER_BAR,
      frequency: 440 * 2 ** ((note.midi - 69) / 12), gainScale: 0.25,
    })));
    return this.#startLoop(notes, bpm, metronome, progression.chords.length * TICKS_PER_BAR, 'progression');
  }

  async #startLoop(notes, bpm, metronome, totalTicks, kind) {
    this.stop();
    const gen = this.#generation;
    const ctx = this.#ensureContext();

    this.#notes = notes;
    this.#secPerTick = 60 / bpm / TICKS_PER_BEAT;
    this.#metronomeEnabled = !!metronome;
    this.#totalTicks = totalTicks;

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    if (gen !== this.#generation) return; // stop() won the race during resume()

    this.#sessionKind = kind;
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

    if (this.#sessionKind === 'play' || this.#sessionKind === 'progression') {
      const tick = elapsedTicks % this.#totalTicks;
      return {
        mode: this.#sessionKind,
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
    }
    return this.#ctx;
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
    const isPlay = this.#sessionKind === 'play' || this.#sessionKind === 'progression';
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
        this.#scheduleNote(time, note.duration * this.#secPerTick, note.frequency, note.gainScale);
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

  #scheduleNote(time, durationSec, frequency = NOTE_FREQUENCY_HZ, gainScale = 1) {
    const ctx = this.#ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(frequency, time);

    const attack = Math.min(NOTE_ATTACK_SEC, durationSec / 4);
    const decay = Math.min(NOTE_DECAY_SEC, durationSec / 4);
    const release = Math.min(NOTE_RELEASE_SEC, durationSec / 4);
    const sustainEnd = time + durationSec - release;

    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(NOTE_PEAK_GAIN * gainScale, time + attack);
    gain.gain.linearRampToValueAtTime(NOTE_SUSTAIN_GAIN * gainScale, time + attack + decay);
    gain.gain.setValueAtTime(NOTE_SUSTAIN_GAIN * gainScale, sustainEnd);
    gain.gain.linearRampToValueAtTime(0, time + durationSec);

    osc.connect(gain).connect(this.#masterGain);
    osc.start(time);
    osc.stop(time + durationSec + 0.01);
    this.#trackNode(osc, gain);
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
