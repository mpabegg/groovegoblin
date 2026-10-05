import { createSession } from './session.js';
import { mergeSession } from './studio-state.js';
import { normalizeInstrumentProfile, standardInstrumentProfile, instrumentInputPitch } from './instrument-profile.js';

export const INSTRUMENT_PREFERENCE_KEY = 'groovegoblin.studio.instrument.v1';
const SESSION_KEYS = ['groovegoblin.session.v2', 'groovegoblin.v1', 'groovegoblin.preferences.v1', 'groovegoblin.mixer.v1'];

export function readInstrumentPreference(storage) {
  try {
    storage ??= globalThis.localStorage;
    const raw = storage.getItem(INSTRUMENT_PREFERENCE_KEY);
    return raw === null ? standardInstrumentProfile() : normalizeInstrumentProfile(JSON.parse(raw));
  } catch { return standardInstrumentProfile(); }
}

export function saveInstrumentPreference(profile, storage) {
  try {
    const normalized = normalizeInstrumentProfile(profile);
    storage ??= globalThis.localStorage;
    storage.setItem(INSTRUMENT_PREFERENCE_KEY, JSON.stringify(normalized));
    return true;
  } catch { return false; }
}

// Restoration never changes notes, timbres, mixer or the legacy band role.
export function withStudioChoices(value) {
  const studio = value.extensions?.studio ?? {};
  return mergeSession(value, { extensions: { studio: {
    ...studio,
    generator: { seed: 0, density: 'medium', syncopation: 'mixed', lengths: 'mixed', ...studio.generator },
    inputPitch: studio.inputPitch ?? (studio.instrument ? instrumentInputPitch(studio.instrument) : 69),
    performanceFocus: studio.performanceFocus ?? false,
    progressionFunction: studio.progressionFunction ?? 'cadence',
  } } });
}

export function createStudioSession(storage) {
  const instrument = readInstrumentPreference(storage);
  return withStudioChoices(createSession({
    bars: 4, loop: { startBar: 0, endBar: 4 }, progression: { cycleBars: 4 },
    timbres: { phrase: instrument.type === 'bass' ? 'electric-bass' : 'clean-guitar' },
    extensions: { studio: { instrument, inputPitch: instrumentInputPitch(instrument) } },
  }));
}

export function initialStudioSession(restored, storage) {
  try {
    storage ??= globalThis.localStorage;
    if (restored.storageAvailable && restored.recoveryRaw === null && !restored.warnings?.length
      && SESSION_KEYS.every(key => storage.getItem(key) === null)) return createStudioSession(storage);
  } catch { /* Preserve recovery and storage-unavailable defaults. */ }
  return restored.session;
}
