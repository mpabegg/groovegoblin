// Detector streaming local. Frame numbers refer to samples, never message arrival.
// State is explicit, copied per block, and independent of block boundaries.
export function refractorySeconds({ bpm = 100, subdivision = 4, swing = 0 } = {}) {
  const step = 60 / bpm / subdivision * (1 - Math.min(0.75, swing));
  return Math.max(0.05, step * 0.4);
}

export function createOnsetState(sampleRate = 48000) {
  return { sampleRate, frame: 0, envelope: 0, energy: 0, noise: 1e-6, lastOnset: -Infinity };
}

export function detectOnsets(previous, samples, { frame = previous.frame, sensitivity = 1, refractory = 0.05 } = {}) {
  const state = { ...previous };
  const events = [];
  const rate = state.sampleRate;
  const attack = 1 - Math.exp(-1 / (rate * 0.003));
  const release = Math.exp(-1 / (rate * 0.03));
  const energyAlpha = 1 - Math.exp(-1 / (rate * 0.001));
  const noiseAlpha = 1 - Math.exp(-1 / (rate * 0.2));
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
    if (frame + i - state.lastOnset >= holdFrames && magnitude > floor
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
