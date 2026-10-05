import { ticksPerBar, performTick, secondsPerTick } from './meter.js';

export const PITCH_CONFIDENCE = 0.85;
export const PITCH_TOLERANCE_CENTS = 50;
// A complete 160 ms bass-safe window after the 15 ms transient, allowing
// 50 ms hop alignment and retries before 320 ms. PCM delivery adds 20 ms.
export const PITCH_ANALYSIS_SECONDS = 0.32;
export const INSTRUMENT_PITCH_TAIL_SECONDS = PITCH_ANALYSIS_SECONDS + 0.02;
const SETTLE_SECONDS = 0.015;

export function instrumentPitchAvailable(session) {
  if (session.training.evaluation === 'free') return false;
  const barTicks = ticksPerBar(session);
  const start = session.loop.startBar * barTicks, end = session.loop.endBar * barTicks;
  const seconds = secondsPerTick(session.bpm);
  const notes = session.notes.filter(note => note.start >= start && note.start < end).map(note => ({
    start: performTick(session, note.start) * seconds + (note.offsetMs ?? 0) / 1000,
    end: performTick(session, Math.min(end, note.start + note.duration)) * seconds + (note.offsetMs ?? 0) / 1000,
  })).sort((a, b) => a.start - b.start);
  return notes.length > 0 && notes.every((note, index) => index === 0 || note.start >= notes[index - 1].end - 1e-9)
    && notes.at(-1).end <= notes[0].start + (end - start) * seconds + 1e-9;
}

// Only the comparison sees the reference. Detection and estimate selection do not.
export function classifyInstrumentPitch(estimate, expectedPitch) {
  if (!(estimate?.frequency > 0 && Number.isFinite(estimate.frequency))
    || !Number.isFinite(estimate.confidence) || estimate.confidence < PITCH_CONFIDENCE || estimate.confidence > 1) {
    return { pitchStatus: 'unidentified', pitchOk: null, pitchCents: null };
  }
  const cents = 1200 * Math.log2(estimate.frequency / (440 * 2 ** ((expectedPitch - 69) / 12)));
  const octaves = Math.round(cents / 1200);
  // The epsilon covers floating-point log/pow roundoff at the inclusive boundary.
  const within = value => Math.abs(value) <= PITCH_TOLERANCE_CENTS + 1e-7;
  const pitchStatus = within(cents) ? 'correct' : octaves !== 0 && within(cents - octaves * 1200) ? 'octave' : 'wrong';
  return { pitchStatus, pitchOk: pitchStatus === 'correct', pitchCents: cents };
}

export const PITCH_STATUS_LABELS = Object.freeze({
  correct: 'Nota certa', wrong: 'Nota errada', unidentified: 'Não identificada', octave: 'Oitava diferente',
});
export function instrumentPitchCounts(summary) {
  return `Alturas: ${summary.pitchCorrect} certa(s) · ${summary.pitchWrong} errada(s) · ${summary.pitchUnidentified} não identificada(s) · ${summary.pitchOctave} com oitava diferente`;
}

export function instrumentPitchLabel(row) {
  if (row.kind !== 'matched') return '—';
  const label = PITCH_STATUS_LABELS[row.pitchStatus] ?? PITCH_STATUS_LABELS.unidentified;
  return Number.isFinite(row.pitchCents) ? `${label} · ${row.pitchCents >= 0 ? '+' : ''}${Math.round(row.pitchCents)} cents` : label;
}
// Stable accepted-attempt handles survive the written gate's release. Source
// frames, not callback time or window midpoint, delimit disjoint note regions.
// A rejected/count-in/final attack still closes the preceding region.
export class InstrumentPitchEvaluation {
  constructor() { this.reset(); }
  reset() { this.attacks = []; this.captureId = null; this.active = false; }
  start() { this.reset(); this.active = true; }
  attack(attack, attempt) {
    if (!this.active || !Number.isFinite(attack.frame) || !(attack.sampleRate > 0)) return;
    if (this.captureId === null) this.captureId = attack.captureId;
    if (attack.captureId !== this.captureId) return;
    const previous = this.attacks.at(-1);
    if (previous && attack.frame <= previous.frame) return;
    if (previous?.attempt?.pitchEstimate?.endFrame > attack.frame) previous.attempt.pitchEstimate = null;
    if (attempt) { attempt.attackId = attack.id; attempt.pitchEstimate = null; }
    this.attacks.push({ frame: attack.frame, sampleRate: attack.sampleRate, attempt });
  }
  pitch(event) {
    if (!this.active) return;
    if (event.stopped) { if (event.captureId === undefined || event.captureId === this.captureId) this.reset(); return; }
    if (event.captureId !== this.captureId) return;
    if (!Number.isFinite(event.startFrame) || !Number.isFinite(event.endFrame) || event.endFrame <= event.startFrame) return;
    for (let index = this.attacks.length - 1; index >= 0; index--) {
      const attack = this.attacks[index];
      if (attack.frame > event.startFrame) continue;
      const next = this.attacks[index + 1];
      if (!attack.attempt || event.sampleRate !== attack.sampleRate
        || event.startFrame < attack.frame + SETTLE_SECONDS * attack.sampleRate
        || event.endFrame > attack.frame + PITCH_ANALYSIS_SECONDS * attack.sampleRate
        || (next && event.endFrame > next.frame)) return;
      if (!(event.frequency > 0 && Number.isFinite(event.frequency))
        || !Number.isFinite(event.confidence) || event.confidence < PITCH_CONFIDENCE || event.confidence > 1) return;
      const selected = attack.attempt.pitchEstimate;
      if (!selected || event.endFrame < selected.endFrame) {
        attack.attempt.pitchEstimate = { frequency: event.frequency, confidence: event.confidence,
          startFrame: event.startFrame, endFrame: event.endFrame, captureId: event.captureId };
      }
      return;
    }
  }
}
