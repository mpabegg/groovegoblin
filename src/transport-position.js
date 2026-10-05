import { ticksPerBar } from './session.js';

export function rulerTick(session, fraction) {
  const step = 4 / session.subdivision;
  const measure = ticksPerBar(session);
  const tick = Math.max(0, Math.min(session.bars * measure, fraction * session.bars * measure));
  const bar = Math.min(session.bars - 1, Math.floor(tick / measure));
  const local = Math.min(measure - 1e-8, tick - bar * measure);
  return bar * measure + Math.floor(local / step + 1e-9) * step;
}
export function rulerStep(session, tick, direction) {
  const measure = ticksPerBar(session); const step = 4 / session.subdivision;
  const bar = Math.floor(tick / measure); const local = tick - bar * measure;
  if (direction > 0) {
    const next = (Math.floor(local / step + 1e-8) + 1) * step;
    return Math.min(rulerTick(session, 1), next < measure - 1e-8 ? bar * measure + next : (bar + 1) * measure);
  }
  const previous = (Math.ceil(local / step - 1e-8) - 1) * step;
  return Math.max(0, previous >= 0 ? bar * measure + previous : (bar - 1) * measure + Math.floor((measure - 1e-8) / step) * step);
}

export function rulerLoop(session, fromFraction, toFraction) {
  const bar = fraction => Math.max(0, Math.min(session.bars - 1, Math.floor(fraction * session.bars)));
  const from = bar(fromFraction); const to = bar(toFraction);
  return { startBar: Math.min(from, to), endBar: Math.max(from, to) + 1 };
}

// Resolve a source tick in the existing plan. Form keeps its sections/tempo/meter;
// seek picks the first occurrence of the source bar. A bar absent from the plan
// resolves to its nearest playable bar (first occurrence wins ties).
export function playbackStartTick(session, plan, startTick) {
  if (!Number.isFinite(startTick)) return 0;
  const measure = ticksPerBar(session);
  const tick = Math.max(0, Math.min(rulerTick(session, 1), startTick));
  const sourceBar = Math.floor(tick / measure);
  let index = 0; let distance = Infinity;
  for (const [candidate, bar] of plan.bars.entries()) {
    const next = Math.abs(bar.sourceBar - sourceBar);
    if (next < distance) { index = candidate; distance = next; }
    if (next === 0) break;
  }
  const local = distance === 0 ? tick % measure : 0;
  return index * measure + local;
}
