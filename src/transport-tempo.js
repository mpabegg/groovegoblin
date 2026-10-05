import { BPM_MIN, BPM_MAX } from './session.js';
import { compileBarPlan } from './form.js';

export function normalizeAccelerator(value = {}) {
  value ??= {};
  const integer = (number, fallback, min, max) => Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
  return { enabled: value.enabled === true, increment: integer(value.increment, 5, 1, 100), loops: integer(value.loops, 1, 1, 100), cap: integer(value.cap, 160, BPM_MIN, BPM_MAX) };
}

// The musical plan owns the acceleration, including the lookahead across seams.
// No RAF callback or independent timer can move the next loop's first attack.
export function acceleratedBarPlan(session, settings, startCycle = 0) {
  const base = compileBarPlan(session); const config = normalizeAccelerator(settings);
  if (!config.enabled || !base.loop || session.bpm >= config.cap) return base;
  const stages = Math.ceil((config.cap - session.bpm) / config.increment);
  const bpmAt = (bpm, stage) => Math.max(bpm, Math.min(config.cap, bpm + stage * config.increment));
  const plans = new Map([[0, base]]);
  const durations = Array.from({ length: stages + 1 }, (_, stage) => base.bars.reduce((sum, bar) => sum + bar.duration * bar.bpm / bpmAt(bar.bpm, stage), 0));
  const ends = []; let elapsed = startCycle * durations[0];
  for (let stage = 0; stage < stages; stage++) { elapsed += durations[stage] * config.loops; ends.push(elapsed); }
  const stageAt = cycle => Math.min(stages, Math.max(0, Math.floor((cycle - startCycle) / config.loops)));
  const planAt = stage => {
    if (!plans.has(stage)) plans.set(stage, compileBarPlan({ ...session, bpm: bpmAt(session.bpm, stage), form: { ...session.form, sections: session.form.sections.map(section => ({ ...section, bpm: section.bpm === null ? null : bpmAt(section.bpm, stage) })) } }));
    return plans.get(stage);
  };
  const cycleTime = cycle => {
    if (cycle <= startCycle) return cycle * durations[0];
    const stage = stageAt(cycle); const start = stage ? ends[stage - 1] : startCycle * durations[0];
    return start + (cycle - startCycle - stage * config.loops) * durations[stage];
  };
  return { ...base,
    at(index) { const cycle = Math.floor(index / base.bars.length); return planAt(stageAt(cycle)).at(index); },
    timeAt(index) { const cycle = Math.floor(index / base.bars.length); return cycleTime(cycle) + this.at(index).start; },
    locate(seconds) {
      if (seconds < startCycle * durations[0]) return base.locate(seconds);
      let stage = 0; while (stage < stages && seconds + 1e-10 >= ends[stage]) stage++;
      const start = stage ? ends[stage - 1] : startCycle * durations[0];
      const located = planAt(stage).locate(seconds - start);
      return { ...located, index: (startCycle + stage * config.loops) * base.bars.length + located.index };
    },
    acceleration(index) {
      const cycle = Math.floor(index / base.bars.length); const stage = stageAt(cycle);
      return { bpm: bpmAt(session.bpm, stage), completedLoops: Math.max(0, cycle - startCycle), nextIn: stage >= stages ? null : config.loops - Math.max(0, cycle - startCycle) % config.loops, cap: config.cap };
    },
  };
}

export function createTapTempo() {
  let last = null; let intervals = [];
  return time => {
    if (!Number.isFinite(time)) return null;
    const interval = last === null ? null : time - last; last = time;
    if (interval === null || interval > 2500 || interval <= 0) { intervals = []; return null; }
    intervals.push(interval); intervals = intervals.slice(-8);
    if (intervals.length < 3) return null;
    const sorted = [...intervals].sort((a, b) => a - b); const median = sorted[Math.floor(sorted.length / 2)];
    const stable = intervals.filter(value => Math.abs(value - median) <= median * 0.25);
    if (stable.length < 3) return null;
    return Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(60000 / (stable.reduce((sum, value) => sum + value, 0) / stable.length))));
  };
}
