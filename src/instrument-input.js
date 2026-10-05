// Input is a local preference, never a mutation of the saved session.
export function instrumentSession(session, { compensationMs = null } = {}) {
  return {
    ...session,
    training: { ...session.training, goal: 'timing' },
    extensions: {
      ...session.extensions,
      performanceInput: { mode: 'instrument', calibrated: compensationMs !== null },
      practice: { ...session.extensions?.practice, objective: 'timing' },
    },
  };
}

// Exact event timestamps survive callback/timer lateness. Release is either the
// next attack or the nominal written gate, not inferred acoustic sustain.
export class InstrumentInputGate {
  constructor(audio) { this.audio = audio; this.deadline = null; this.timer = null; }
  attack(time) {
    if (this.deadline !== null) this.audio.release(Math.min(time, this.deadline));
    clearTimeout(this.timer);
    this.audio.press(time, null, { monitor: false });
    this.deadline = time + this.audio.writtenInputDuration(time) * 1000;
    const deadline = this.deadline;
    this.timer = setTimeout(() => {
      if (this.deadline !== deadline) return;
      this.audio.release(deadline); this.deadline = null; this.timer = null;
    }, Math.max(0, deadline - performance.now()));
  }
  reset() { clearTimeout(this.timer); this.timer = null; this.deadline = null; }
}
