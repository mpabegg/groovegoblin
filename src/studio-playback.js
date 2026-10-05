import { ticksPerBar, MIXER_CHANNELS } from './session.js';
import { playbackStartTick } from './transport-position.js';
import { compileBarPlan } from './form.js';
import { normalizeAccelerator } from './transport-tempo.js';

// Solo is an overlay, never a saved mute. Clearing it restores the latest manual mix.
export function effectiveMixer(mixer, solos = new Set()) {
  return Object.fromEntries(MIXER_CHANNELS.map(channel => [channel, {
    ...mixer[channel], muted: mixer[channel].muted || (channel !== 'metronome' && solos.size > 0 && !solos.has(channel)),
  }]));
}

export function phrasePreviewSession(session) {
  return {
    ...session, form: { ...session.form, enabled: false },
    progression: { ...session.progression, enabled: false },
    drums: { ...session.drums, enabled: false },
    band: { ...session.band, bassEnabled: false },
    metronome: { ...session.metronome, enabled: false },
    companion: { ...session.companion, enabled: false },
    mixer: Object.fromEntries(MIXER_CHANNELS.map(channel => [channel, {
      ...session.mixer[channel], muted: channel !== 'phrase',
      volume: channel === 'phrase' && session.mixer.phrase.volume === 0 ? 1 : session.mixer[channel].volume,
    }])),
  };
}

export function createStudioPlayback({ getSession, getPlaybackSession = getSession, audio, render, notify, isPending = () => false }) {
  const solos = new Set();
  const audible = new Map();
  let countInBars = 0;
  let accelerator = normalizeAccelerator();
  try { const saved = JSON.parse(globalThis.localStorage?.getItem('groovegoblin.transport') ?? '{}'); countInBars = [1, 2].includes(saved.countInBars) ? saved.countInBars : 0; accelerator = normalizeAccelerator(saved.accelerator); } catch { /* Browser storage is optional. */ }
  function save() { try { globalThis.localStorage?.setItem('groovegoblin.transport', JSON.stringify({ countInBars, accelerator })); } catch { /* Session export remains canonical. */ } }
  let startTick = null;
  let listening = false;
  const mixer = (session = getPlaybackSession()) => {
    const base = listening ? phrasePreviewSession(session).mixer : session.mixer;
    const manual = Object.fromEntries(MIXER_CHANNELS.map(channel => [channel, audible.has(channel)
      ? { ...base[channel], muted: !audible.get(channel), volume: audible.get(channel) && base[channel].volume === 0 ? 1 : base[channel].volume }
      : base[channel]]));
    return listening ? manual : effectiveMixer(manual, solos);
  };
  function playableTick(tick) {
    const session = getSession(); const plan = compileBarPlan(session);
    const measure = ticksPerBar(session); const offset = playbackStartTick(session, plan, tick);
    return plan.at(Math.floor(offset / measure)).sourceBar * measure + offset % measure;
  }
  return {
    getStartTick: () => startTick,
    isListening: () => listening,
    getCanonicalBpm: () => getSession().bpm,
    getPreferences: () => ({ countInBars, accelerator: { ...accelerator } }),
    setPreferences(value) { countInBars = [1, 2].includes(value.countInBars) ? value.countInBars : 0; accelerator = normalizeAccelerator(value.accelerator); save(); render(); },
    getPlayOptions: mode => mode === 'train' ? {} : { countInBars, accelerator },
    isSolo: channel => solos.has(channel),
    applyMixer: () => audio.setMixer(mixer()),
    toggleSolo(channel) { if (solos.has(channel)) solos.delete(channel); else solos.add(channel); audio.setMixer(mixer()); render(); },
    toggleAudible(channel) {
      const enabled = !mixer()[channel].muted && mixer()[channel].volume > 0;
      audible.set(channel, !enabled);
      if (!enabled && channel !== 'metronome' && solos.size) solos.add(channel);
      audio.setMixer(mixer()); render();
    },
    setListening(value) { listening = value; audio.setMixer(mixer()); render(); },
    seek(tick) {
      if (isPending()) { notify('Aguarde a preparação ou pare o transporte antes de escolher o início.'); return; }
      const mode = audio.position.mode;
      if (['countin', 'train'].includes(mode)) { notify('O início do treino continua no loop; pare o treino para escolher outro ponto.'); return; }
      startTick = playableTick(tick);
      if (startTick !== tick) notify('Início ajustado ao compasso mais próximo dentro do loop ou da forma.');
      audio.seek(startTick);
      render();
    },
    getMixer: mixer,
    reconcile() {
      if (startTick !== null) startTick = playableTick(startTick);
      audio.setMixer(mixer());
    },
  };
}
