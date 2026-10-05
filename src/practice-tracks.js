// Only actual backing voices: the written phrase remains suppressed in training.
export function practiceVoices(session) {
  return [
    ['metronome', session.companion.enabled ? 'Metrônomo / polirritmia' : 'Metrônomo', session.metronome.enabled || session.companion.enabled],
    ['drums', 'Bateria', session.drums.enabled && session.band.role !== 'drums'],
    ['chords', 'Acordes', session.progression.enabled && session.progression.chords.length > 0 && session.band.role !== 'harmony'],
    ['bass', 'Baixo', session.band.bassEnabled && session.band.role !== 'bass'],
  ].map(([channel, label, available]) => ({ channel, label, available }));
}
export function mountPracticeTracks(container, host) {
  const line = document.createElement('div');
  line.id = 'practice-audible-tracks'; line.className = 'practice-audible-tracks';
  line.setAttribute('aria-label', 'Faixas audíveis no treino');
  const caption = document.createElement('span'); caption.textContent = 'Ouvir no treino:'; line.append(caption);
  const buttons = new Map();
  for (const { channel, label } of practiceVoices(host.getSession())) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.id = `practice-audible-${channel}`;
    button.addEventListener('click', () => { host.toggleAudible(channel); render(); });
    buttons.set(channel, button); line.append(button);
  }
  container.append(line);
  function render() {
    const session = host.getSession(); const mixer = host.getMixer(session);
    for (const voice of practiceVoices(session)) {
      const button = buttons.get(voice.channel);
      const audible = voice.available && !mixer[voice.channel].muted && mixer[voice.channel].volume > 0;
      button.disabled = !voice.available;
      button.setAttribute('aria-pressed', String(audible));
      button.textContent = voice.label;
      button.title = voice.available ? 'Alternar audição nesta visita; respeita os solos e não muda a frase.' : 'Faixa desativada ou reservada para você no Estúdio.';
    }
  }
  render(); return { render };
}
