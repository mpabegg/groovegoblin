import { TIMBRES, TIMBRE_LABELS, STYLES, DENSITIES, STYLE_LABELS, DENSITY_LABELS } from './session.js';

const names = { phrase: 'Frase', chords: 'Acordes', drums: 'Bateria', bass: 'Baixo', metronome: 'Metrônomo' };

// Controls use the same validated session/history/live-audio path as the transport.
export function mountStudioTracks(host) {
  const controls = [];
  for (const channel of ['drum', 'bass']) {
    for (const [kind, values, labels] of [['style', STYLES, STYLE_LABELS], ['density', DENSITIES, DENSITY_LABELS]]) {
      const select = document.getElementById(`${channel}-${kind}`);
      for (const value of values) {
        const option = document.createElement('option'); option.value = value; option.textContent = labels[value]; select.append(option);
      }
    }
  }
  document.getElementById('generate-drums').addEventListener('click', () => {
    if (!host.isBusy()) host.updateSession({ drums: { enabled: true, seed: crypto.getRandomValues(new Uint32Array(1))[0] } }, { notice: 'Nova variação da bateria aplicada.' });
  });
  for (const [channel, name] of Object.entries(names)) {
    const container = document.getElementById(`track-${channel}-sound`);
    const sound = document.createElement('details'); sound.className = 'track-sound'; sound.id = `track-${channel}-mix`;
    const summary = document.createElement('summary'); summary.textContent = 'Som'; summary.setAttribute('aria-label', `Som e opções: ${name}`);
    const popover = document.createElement('div'); popover.className = 'track-sound-popover';
    sound.append(summary, popover);
    const volumeLabel = document.createElement('label'); volumeLabel.className = 'track-volume';
    const volume = document.createElement('input'); volume.type = 'range'; volume.min = '0'; volume.max = '100';
    volume.id = `mixer-${channel}-volume`; volume.setAttribute('aria-label', `Volume: ${name}`);
    const output = document.createElement('output'); output.id = `mixer-${channel}-value`;
    volumeLabel.append(volume, output);
    const mute = document.createElement('button'); mute.type = 'button'; mute.className = 'track-mute';
    mute.id = `mixer-${channel}-muted`; mute.textContent = 'M'; mute.title = `Silenciar ${name}`;
    mute.setAttribute('aria-label', `Silenciar ${name}`);
    volume.addEventListener('input', () => host.updateSession({ mixer: { [channel]: { volume: Number(volume.value) / 100 } } }));
    mute.addEventListener('click', () => host.updateSession({ mixer: { [channel]: { muted: !host.getSession().mixer[channel].muted } } }));
    popover.append(volumeLabel, mute); container.append(sound);
    let timbre;
    if (TIMBRES[channel]) {
      timbre = document.createElement('select'); timbre.id = `track-${channel}-timbre`; timbre.dataset.path = `timbres.${channel}`;
      timbre.setAttribute('aria-label', `Timbre: ${name}`);
      for (const value of TIMBRES[channel]) {
        const option = document.createElement('option'); option.value = value; option.textContent = TIMBRE_LABELS[value]; timbre.append(option);
      }
      const label = document.createElement('label'); label.className = 'track-timbre-label'; label.append(document.createTextNode('Timbre'), timbre); popover.append(label);
    }
    if (channel === 'drums') popover.append(document.getElementById('drum-advanced'));
    controls.push({ channel, volume, output, mute, timbre, summary });
  }
  function render() {
    const session = host.getSession();
    for (const { channel, volume, output, mute, timbre, summary } of controls) {
      const value = session.mixer[channel];
      volume.value = Math.round(value.volume * 100); volume.setAttribute('aria-valuetext', `${volume.value}%`);
      output.textContent = `${volume.value}%`; mute.setAttribute('aria-pressed', String(value.muted));
      summary.textContent = value.muted ? 'Som · M' : 'Som';
      summary.title = `Volume ${volume.value}%${value.muted ? ' · silenciado' : ''}`;
      if (timbre) timbre.value = session.timbres[channel];
    }
    for (const [channel, enabled] of [['chords', session.progression.enabled], ['drums', session.drums.enabled], ['bass', session.band.bassEnabled]]) {
      const row = document.getElementById(`track-${channel}`); row.classList.toggle('track-disabled', !enabled);
      // An inactive track keeps its enable switch, not a bank of inactive controls.
      for (const node of row.querySelectorAll('.track-extra, .track-lane')) node.hidden = !enabled;
    }
    document.getElementById('track-drums').classList.toggle('role-suppressed', session.band.role === 'drums');
    document.getElementById('track-bass').classList.toggle('role-suppressed', session.band.role === 'bass');
    document.getElementById('track-chords').classList.toggle('role-suppressed', session.band.role === 'harmony');
  }
  return { render };
}
