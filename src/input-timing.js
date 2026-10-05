// Browser input latency and residual physical calibration are separate terms.
// Capture clock is processing-correlated; press() applies output correlation ONCE.
export function captureFrameTime(frame, sampleRate, processingPair, inputLatencySeconds = 0, compensationMs = 0) {
  return processingPair.performanceTime + (frame / sampleRate - processingPair.contextTime - inputLatencySeconds) * 1000 - compensationMs;
}
export function contextPerformanceTime(contextTime, pair) {
  return pair.performanceTime + (contextTime - pair.contextTime) * 1000;
}
export function compensatedTime(timeMs, compensationMs = 0) { return timeMs - compensationMs; }

export const CALIBRATION_REFRACTORY_SECONDS = 0.05;
export const CALIBRATION_WINDOW_MS = 200;
export const INPUT_DELIVERY_MARGIN_MS = 40;

export function inputTailSeconds({ instrument = false, inputLatencySeconds = 0, compensationMs = 0 } = {}) {
  return Math.max(0, inputLatencySeconds) + Math.max(0, compensationMs) / 1000
    + (instrument || compensationMs > 0 ? INPUT_DELIVERY_MARGIN_MS / 1000 : 0);
}

export function calibrationCollectionDeadline(lastClickMs, inputLatencySeconds = 0) {
  return lastClickMs + Math.max(0, inputLatencySeconds) * 1000 + CALIBRATION_WINDOW_MS + INPUT_DELIVERY_MARGIN_MS;
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function calibrateInput(clicks, attacks, { windowMs = CALIBRATION_WINDOW_MS, maxSpreadMs = 45 } = {}) {
  if (clicks.length !== 8 || attacks.some(value => !Number.isFinite(value)) || clicks.some(value => !Number.isFinite(value))) {
    return { ok: false, reason: 'São necessários oito cliques e ataques válidos.' };
  }
  const pairs = clicks.map(click => attacks.filter(attack => Math.abs(attack - click) <= windowMs));
  if (pairs.some(pair => pair.length > 1) || attacks.some(attack => clicks.filter(click => Math.abs(attack - click) <= windowMs).length > 1)) {
    return { ok: false, reason: 'Pareamento ambíguo: toque apenas uma vez por clique, usando fones.' };
  }
  // Warm-up clicks are intentionally discarded; all six measured clicks are needed.
  if (pairs.slice(2).some(pair => pair.length !== 1)) return { ok: false, reason: 'Ataques insuficientes: toque junto dos oito cliques e tente novamente.' };
  const deviations = pairs.slice(2).map((pair, i) => pair[0] - clicks[i + 2]);
  const compensationMs = median(deviations);
  const spreadMs = Math.max(...deviations) - Math.min(...deviations);
  if (spreadMs > maxSpreadMs || median(deviations.map(value => Math.abs(value - compensationMs))) > 15) {
    return { ok: false, reason: 'Dispersão alta: repita com pulso estável e fones.', spreadMs };
  }
  return { ok: true, compensationMs: Math.round(compensationMs), spreadMs, deviations };
}

export function detectClickLeak(clicks, attacks, { toleranceMs = 12, minimum = 3 } = {}) {
  const hits = clicks.filter(click => attacks.some(attack => Math.abs(attack - click) <= toleranceMs));
  return { leaking: hits.length >= minimum, coincident: hits.length };
}

export const INPUT_PREFERENCES_KEY = 'groovegoblin.input.v1';
export const CALIBRATION_KEY = 'groovegoblin.input-calibration.v1';
export function readInputPreferences(storage) {
  try {
    storage ??= globalThis.localStorage;
    const value = JSON.parse(storage.getItem(INPUT_PREFERENCES_KEY) ?? '{}');
    return { deviceId: typeof value.deviceId === 'string' ? value.deviceId : '', channel: ['1', '2', 'sum'].includes(value.channel) ? value.channel : 'sum', sensitivity: Number.isFinite(value.sensitivity) && value.sensitivity >= 0.5 && value.sensitivity <= 2 ? value.sensitivity : 1, lastMode: value.lastMode === 'instrument' ? 'instrument' : 'keyboard' };
  } catch { return { deviceId: '', channel: 'sum', sensitivity: 1, lastMode: 'keyboard' }; }
}
export function readCalibration(deviceId, storage) {
  try {
    storage ??= globalThis.localStorage;
    const value = JSON.parse(storage.getItem(CALIBRATION_KEY) ?? '{}')[deviceId];
    return Number.isFinite(value) && Math.abs(value) <= 500 ? value : null;
  } catch { return null; }
}
export function saveCalibration(deviceId, value, storage = globalThis.localStorage) {
  let entries;
  try { entries = JSON.parse(storage.getItem(CALIBRATION_KEY) ?? '{}'); } catch { entries = {}; }
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) entries = {};
  if (value === null) delete entries[deviceId];
  else {
    if (!Number.isFinite(value) || Math.abs(value) > 500) throw new RangeError('Compensação deve estar entre −500 e 500 ms.');
    // Defining an own key also handles device IDs such as '__proto__'.
    Object.defineProperty(entries, deviceId, { value, enumerable: true, configurable: true, writable: true });
  }
  storage.setItem(CALIBRATION_KEY, JSON.stringify(entries));
}
