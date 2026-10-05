// Monophonic YIN. No DOM, expected-note input, recording or network dependency.
export const MIN_PITCH_FREQUENCY = 440 * 2 ** ((23 - 69) / 12); // B0
export const MAX_PITCH_FREQUENCY = 440 * 2 ** ((88 - 69) / 12); // E6
const unidentified = (rms = 0, confidence = 0) => ({ frequency: null, confidence, rms });
const sinc = x => Math.abs(x) < 1e-10 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);

export function createPitchDetector(sampleRate, {
  minFrequency = MIN_PITCH_FREQUENCY * 0.97,
  maxFrequency = MAX_PITCH_FREQUENCY * 1.03,
  windowSeconds = 0.16,
  minRms = 0.003,
  minConfidence = 0.85,
} = {}) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || !(minFrequency > 0 && maxFrequency > minFrequency && maxFrequency < sampleRate / 2)) throw new RangeError('Intervalo ou taxa de amostragem inválidos.');
  // Integer decimation retains 8–12 kHz. A windowed-sinc filter removes aliases.
  const stride = Math.max(1, Math.floor(sampleRate / 8000));
  const rate = sampleRate / stride;
  const maxLag = Math.ceil(rate / minFrequency);
  const minLag = Math.max(2, Math.floor(rate / maxFrequency));
  const windowSize = Math.ceil(sampleRate * Math.max(windowSeconds, 4 / minFrequency));
  const reduced = new Float64Array(Math.ceil(windowSize / stride));
  const normalized = new Float64Array(maxLag + 2);
  const radius = stride === 1 ? 0 : 24 * stride;
  const filter = new Float64Array(2 * radius + 1);
  if (radius) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const value = (0.9 / stride) * sinc(k * 0.9 / stride) * (0.5 + 0.5 * Math.cos(Math.PI * k / radius));
      filter[k + radius] = value; sum += value;
    }
    for (let k = 0; k < filter.length; k++) filter[k] /= sum;
  }
  // Lanczos interpolation refines the actual waveform difference, rather than
  // rounding a short E6 period or interpolating biased normalized YIN values.
  const weights = new Float64Array(24);
  function fractionalDifference(lag, count) {
    const whole = Math.floor(lag), fraction = lag - whole;
    let weightSum = 0;
    for (let k = -11; k <= 12; k++) {
      const x = k - fraction;
      const weight = sinc(x) * sinc(x / 12);
      weights[k + 11] = weight; weightSum += weight;
    }
    let total = 0;
    for (let i = 12; i < count - 12; i++) {
      let shifted = 0;
      for (let k = -11; k <= 12; k++) shifted += reduced[i + whole + k] * weights[k + 11];
      const delta = reduced[i] - shifted / weightSum;
      total += delta * delta;
    }
    return total;
  }
  const basis = new Float64Array(9), rotation = new Float64Array(8);
  const matrix = new Float64Array(90), rhs = new Float64Array(9);
  function harmonicFitError(lag, count, harmonics) {
    // Near Nyquist, finite sinc interpolation cannot represent a strong third
    // harmonic accurately. Fit free sin/cos amplitudes at the candidate's
    // harmonics instead; the period remains a measured, continuous parameter.
    const dimensions = 2 * harmonics + 1;
    matrix.fill(0); rhs.fill(0);
    for (let h = 0; h < harmonics; h++) {
      const angle = 2 * Math.PI * (h + 1) / lag;
      rotation[h * 2] = Math.sin(angle); rotation[h * 2 + 1] = Math.cos(angle);
      basis[h * 2] = 0; basis[h * 2 + 1] = 1;
    }
    basis[dimensions - 1] = 1; // Fit DC too: mean removal must not bias a short fit.
    let energy = 0;
    for (let i = 0; i < count; i++) {
      const sample = reduced[i]; energy += sample * sample;
      for (let row = 0; row < dimensions; row++) {
        rhs[row] += basis[row] * sample;
        for (let col = row; col < dimensions; col++) matrix[row * 10 + col] += basis[row] * basis[col];
      }
      for (let h = 0; h < harmonics; h++) {
        const a = h * 2, sine = basis[a], cosine = basis[a + 1];
        basis[a] = sine * rotation[a + 1] + cosine * rotation[a];
        basis[a + 1] = cosine * rotation[a + 1] - sine * rotation[a];
      }
    }
    for (let row = 0; row < dimensions; row++) {
      matrix[row * 10 + dimensions] = rhs[row];
      for (let col = 0; col < row; col++) matrix[row * 10 + col] = matrix[col * 10 + row];
    }
    for (let col = 0; col < dimensions; col++) {
      let pivot = col;
      for (let row = col + 1; row < dimensions; row++) if (Math.abs(matrix[row * 10 + col]) > Math.abs(matrix[pivot * 10 + col])) pivot = row;
      if (Math.abs(matrix[pivot * 10 + col]) < 1e-10) return Infinity;
      if (pivot !== col) for (let j = col; j <= dimensions; j++) {
        const value = matrix[col * 10 + j]; matrix[col * 10 + j] = matrix[pivot * 10 + j]; matrix[pivot * 10 + j] = value;
      }
      const diagonal = matrix[col * 10 + col];
      for (let j = col; j <= dimensions; j++) matrix[col * 10 + j] /= diagonal;
      for (let row = 0; row < dimensions; row++) if (row !== col) {
        const factor = matrix[row * 10 + col];
        for (let j = col; j <= dimensions; j++) matrix[row * 10 + j] -= factor * matrix[col * 10 + j];
      }
    }
    for (let row = 0; row < dimensions; row++) energy -= matrix[row * 10 + dimensions] * rhs[row];
    return Math.max(0, energy);
  }
  return {
    sampleRate, windowSize,
    detect(samples) {
      if (samples.length < windowSize) return unidentified();
      const offset = samples.length - windowSize;
      let mean = 0, energy = 0;
      for (let i = offset; i < samples.length; i++) {
        const value = samples[i];
        if (!Number.isFinite(value)) return unidentified();
        mean += value; energy += value * value;
      }
      mean /= windowSize;
      const rms = Math.sqrt(Math.max(0, energy / windowSize - mean * mean));
      if (rms < minRms) return unidentified(rms);
      let length = 0;
      // Discard filter edges instead of manufacturing reflected periods.
      for (let i = radius; i < windowSize - radius; i += stride) {
        let value = 0;
        if (!radius) value = samples[offset + i];
        else for (let k = -radius; k <= radius; k++) value += samples[offset + i + k] * filter[k + radius];
        reduced[length++] = value - mean;
      }
      const count = length - maxLag - 14;
      if (count < maxLag + 24) return unidentified(rms);
      normalized[0] = 1;
      let cumulative = 0;
      for (let lag = 1; lag <= maxLag + 1; lag++) {
        let sum = 0;
        for (let i = 0; i < count; i++) { const delta = reduced[i] - reduced[i + lag]; sum += delta * delta; }
        cumulative += sum;
        normalized[lag] = cumulative > 0 ? sum * lag / cumulative : 1;
      }
      let measuredEnergy = 0;
      for (let i = 0; i < count; i++) measuredEnergy += reduced[i] * reduced[i];
      let candidate = 0;
      // Refine early periodic troughs. Short, harmonics-rich periods may lie
      // between integer lags: their integer error is not their confidence.
      for (let lag = minLag; lag <= maxLag; lag++) {
        const shortTrough = lag < 12 && normalized[lag] < 0.6
          && normalized[lag] <= normalized[lag - 1] && normalized[lag] < normalized[lag + 1];
        if (normalized[lag] < 0.15 || shortTrough) {
          while (lag < maxLag && normalized[lag + 1] < normalized[lag]) lag++;
          candidate = lag; break;
        }
      }
      if (!candidate) return unidentified(rms);
      function minimize(error, left, right, steps) {
        const ratio = (Math.sqrt(5) - 1) / 2;
        let a = right - ratio * (right - left), b = left + ratio * (right - left);
        let da = error(a), db = error(b);
        for (let step = 0; step < steps; step++) {
          if (da < db) { right = b; b = a; db = da; a = right - ratio * (right - left); da = error(a); }
          else { left = a; a = b; da = db; b = left + ratio * (right - left); db = error(b); }
        }
        const lag = (left + right) / 2;
        return { lag, error: error(lag) };
      }
      function refine(center, spectral = center < 12) {
        let result;
        if (spectral) {
          const harmonics = Math.min(4, Math.max(1, Math.floor(center / 2)));
          const shortCount = Math.min(count, Math.ceil(center * 16));
          const shortError = lag => harmonicFitError(lag, shortCount, harmonics);
          // A long-window spectral objective has many side lobes: golden
          // search over ±1 sample is NOT unimodal. Bracket its global peak on
          // a cheap sixteen-cycle fit, then refine only its main lobe.
          const step = 0.125;
          let coarse = center, coarseError = Infinity;
          for (let lag = center - 1; lag <= center + 1; lag += step) {
            const error = shortError(lag);
            if (error < coarseError) { coarse = lag; coarseError = error; }
          }
          const short = minimize(shortError, coarse - step, coarse + step, 24);
          const width = 0.5 * short.lag * short.lag / (count * harmonics);
          result = minimize(lag => harmonicFitError(lag, count, harmonics), short.lag - width, short.lag + width, 24);
        } else result = minimize(lag => fractionalDifference(lag, count), center - 1, center + 1, 16);
        const denominator = spectral ? measuredEnergy : 2 * measuredEnergy * (count - 24) / count;
        result.error /= Math.max(1e-20, denominator);
        return result;
      }
      let best = refine(candidate);
      const initialLag = best.lag;
      // A weak fundamental underneath a dominant even harmonic can produce
      // an early, shallow trough. Accept a longer period only for a substantial
      // improvement over the *fractionally refined* error, not sample rounding.
      for (const multiple of [2, 3]) {
        if (best.error < 0.0001) break;
        const center = Math.round(initialLag * multiple);
        if (center > maxLag || normalized[center] >= 0.15) continue;
        // Compare the same error model. Comparing a spectral amplitude fit
        // with a shifted-waveform fit can invent subharmonics on envelopes.
        const alternative = refine(center, candidate < 12);
        if (alternative.error < best.error * 0.25) best = alternative;
      }
      const confidence = Math.max(0, Math.min(1, 1 - best.error));
      if (confidence < minConfidence) return unidentified(rms, confidence);
      const frequency = rate / best.lag;
      return frequency >= minFrequency && frequency <= maxFrequency && Number.isFinite(frequency)
        ? { frequency, confidence, rms } : unidentified(rms, confidence);
    },
  };
}

export function detectMonophonicPitch(samples, sampleRate, options) {
  return createPitchDetector(sampleRate, options).detect(samples);
}

// A reusable ephemeral ring and scratch window. Callback frame is the window
// midpoint; bounds are original source frames, with endFrame exclusive.
export function createPitchStream(sampleRate, options = {}) {
  const detector = createPitchDetector(sampleRate, options);
  const ring = new Float32Array(detector.windowSize);
  const window = new Float32Array(detector.windowSize);
  const hop = Math.max(128, Math.round(sampleRate * (options.hopSeconds ?? 0.05)));
  let written = 0, next = ring.length, expectedFrame = null;
  return {
    windowSize: ring.length, hop,
    reset() { written = 0; next = ring.length; expectedFrame = null; },
    push(samples, startFrame, onPitch) {
      if (expectedFrame !== null && expectedFrame !== startFrame) { written = 0; next = ring.length; }
      for (let i = 0; i < samples.length; i++) {
        ring[written % ring.length] = samples[i]; written++;
        if (written >= next) {
          const endFrame = startFrame + i + 1, start = written % ring.length;
          for (let j = 0; j < window.length; j++) window[j] = ring[(start + j) % ring.length];
          onPitch({ ...detector.detect(window), startFrame: endFrame - window.length, endFrame, frame: endFrame - window.length / 2 });
          next += hop;
        }
      }
      expectedFrame = startFrame + samples.length;
    },
  };
}

export function pitchReading(frequency, profile, reference = 440) {
  if (!(frequency > 0 && Number.isFinite(frequency)) || !Number.isFinite(reference) || reference < 430 || reference > 450) return null;
  const midi = 69 + 12 * Math.log2(frequency / reference);
  const note = Math.round(midi);
  let index = 0;
  for (let i = 1; i < profile.tuning.length; i++) if (Math.abs(midi - profile.tuning[i]) < Math.abs(midi - profile.tuning[index])) index = i;
  const target = profile.tuning[index];
  return { midi, note, cents: (midi - note) * 100, string: profile.strings - index, target, targetFrequency: reference * 2 ** ((target - 69) / 12), targetCents: (midi - target) * 100 };
}
