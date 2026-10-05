// Detector streaming local. Frame numbers refer to samples, never message arrival.
// State is explicit, copied per block, and independent of block boundaries.
export function refractorySeconds({ bpm = 100, subdivision = 4, swing = 0 } = {}) {
  const step = 60 / bpm / subdivision * (1 - Math.min(0.75, swing));
  return Math.max(0.05, step * 0.4);
}

export function createOnsetState(sampleRate = 48000) {
  return { sampleRate, frame: 0, envelope: 0, energy: 0, noise: 1e-6, lastOnset: -Infinity, bassPeak: 0, bassMagnitude: 0, bassRising: false, bassRiseFrame: 0, bassLastFrame: -Infinity, bassQuietFrames: 0 };
}

export function detectOnsets(previous, samples, { frame = previous.frame, sensitivity = 1, refractory = 0.05, instrumentType = 'guitar' } = {}) {
  const state = { ...previous };
  const events = [];
  const rate = state.sampleRate;
  const attack = 1 - Math.exp(-1 / (rate * 0.003));
  const release = Math.exp(-1 / (rate * 0.03));
  const energyAlpha = 1 - Math.exp(-1 / (rate * 0.001));
  const noiseAlpha = 1 - Math.exp(-1 / (rate * 0.2));
  const bassSmoothing = 1 - Math.exp(-1 / (rate * 0.001));
  const bassRelease = Math.exp(-1 / (rate * 0.08));
  const bassQuietHoldFrames = Math.ceil(rate * 0.008);
  const gain = Math.max(0.5, Math.min(2, sensitivity));
  const holdFrames = Math.max(1, Math.ceil(Math.max(0.05, refractory) * rate));
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = Number.isFinite(samples[i]) ? samples[i] : 0;
    const square = x * x;
    const magnitude = Math.abs(x);
    const baseline = state.envelope;
    state.energy += energyAlpha * (square - state.energy);
    // Only the quiet floor adapts: a decaying/sustained note is not background.
    if (state.energy < Math.max(4e-6, state.noise * 4)) state.noise += noiseAlpha * (state.energy - state.noise);
    const floor = Math.max(0.008 / gain, Math.sqrt(state.noise) * 6 / gain);
    const flux = magnitude - baseline;
    if (instrumentType === 'bass') {
      // Compare a rising lobe with completed lobes, not its own evolving peak.
      // 80 ms peak memory bridges B0 half-periods without phase-cycle attacks.
      const before = state.bassMagnitude;
      state.bassMagnitude += bassSmoothing * (magnitude - before);
      state.bassPeak *= bassRelease;
      // A real rest ends peak memory, even when its preceding strike was
      // rejected by refractory. Otherwise that ignored strike masks a valid
      // later reattack. Require sustained quiet, not a bass phase trough.
      state.bassQuietFrames = state.bassMagnitude < floor * 0.5 && state.energy < floor * floor * 0.25
        ? state.bassQuietFrames + 1 : 0;
      if (state.bassQuietFrames >= bassQuietHoldFrames) state.bassPeak = 0;
      const rising = state.bassMagnitude > before;
      if (rising && !state.bassRising) {
        state.bassRiseFrame = frame + i;
      }
      if (!rising && state.bassRising) state.bassPeak = Math.max(state.bassPeak, before);
      state.bassRising = rising;
      const bassFlux = state.bassMagnitude - state.bassPeak;
      if (rising && frame + i - state.lastOnset >= holdFrames
        && state.bassRiseFrame - state.bassLastFrame >= holdFrames
        && state.bassMagnitude > floor && state.bassMagnitude > state.bassPeak * 1.65
        && state.energy > Math.max(1e-6 / gain, state.noise * 2 / gain)) {
        // Publish the observed rising-lobe origin, never a fixed backdate.
        // Both origin and confirmation obey the minimum/grid refractory.
        state.lastOnset = frame + i;
        state.bassLastFrame = state.bassRiseFrame;
        events.push({ frame: state.bassRiseFrame, level: Math.sqrt(state.energy), flux: bassFlux });
        state.bassPeak = Math.max(state.bassPeak, state.bassMagnitude);
      }
    } else if (frame + i - state.lastOnset >= holdFrames && magnitude > floor
      && flux > Math.max(floor * 0.25, baseline * 0.65)
      && state.energy > Math.max(1e-6 / gain, state.noise * 2 / gain)) {
      state.lastOnset = frame + i;
      events.push({ frame: frame + i, level: Math.sqrt(state.energy), flux });
    }
    // Peak envelope avoids phase-cycle 'onsets' on sustained bass/guitar tones.
    state.envelope = magnitude > baseline ? baseline + attack * (magnitude - baseline) : baseline * release;
    sum += square;
  }
  state.frame = frame + samples.length;
  return { state, events, level: Math.sqrt(sum / Math.max(1, samples.length)) };
}

export function selectInputSample(channels, index, channel = 'sum') {
  if (channel === '1') return channels[0]?.[index] ?? 0;
  if (channel === '2') return channels[1]?.[index] ?? 0;
  if (!channels.length) return 0;
  let sum = 0;
  for (const samples of channels) sum += samples[index] ?? 0;
  return sum / channels.length;
}
