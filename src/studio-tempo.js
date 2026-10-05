import { createTapTempo } from './transport-tempo.js';

export function mountStudioTempo(playback) {
  const $ = id => document.getElementById(id); const tap = createTapTempo();
  let accelerating = false;
  const ids = ['play-count-in', 'accelerator-enabled', 'accelerator-increment', 'accelerator-loops', 'accelerator-cap'];
  function render() {
    const pref = playback.getPreferences();
    $('play-count-in').value = pref.countInBars;
    $('accelerator-enabled').checked = pref.accelerator.enabled;
    $('accelerator-increment').value = pref.accelerator.increment;
    $('accelerator-loops').value = pref.accelerator.loops;
    $('accelerator-cap').value = pref.accelerator.cap;
  }
  for (const id of ids) $(id).addEventListener('change', () => {
    if (!$(id).checkValidity()) { render(); return; }
    playback.setPreferences({ countInBars: Number($('play-count-in').value), accelerator: { enabled: $('accelerator-enabled').checked, increment: Number($('accelerator-increment').value), loops: Number($('accelerator-loops').value), cap: Number($('accelerator-cap').value) } });
  });
  $('tap-tempo').addEventListener('click', () => {
    const bpm = tap(performance.now());
    $('tap-tempo').title = bpm === null ? 'Marque pelo menos quatro pulsos regulares' : `Tap: ${bpm} BPM`;
    if (bpm !== null) { $('bpm').value = bpm; $('bpm').dispatchEvent(new Event('change', { bubbles: true })); }
  });
  render();
  return {
    position(position) {
      const acceleration = position.acceleration;
      if (acceleration && document.activeElement !== $('bpm')) $('bpm').value = position.bpm;
      else if (accelerating && !acceleration) $('bpm').value = playback.getCanonicalBpm();
      accelerating = !!acceleration;
      $('bpm').title = acceleration ? `Andamento atual; editar redefine o BPM inicial. ${acceleration.nextIn === null ? 'Limite atingido' : `Próxima subida em ${acceleration.nextIn} volta(s)`}` : 'Semínimas por minuto';
      const text = acceleration ? `Atual: ${position.bpm} BPM · ${acceleration.nextIn === null ? `limite ${acceleration.cap} atingido` : `próximo aumento em ${acceleration.nextIn} volta(s)`}` : 'Ajustes valem na próxima reprodução. Parar restaura o BPM da sessão. O treino mantém sua própria entrada e seu andamento.';
      if ($('accelerator-status').textContent !== text) $('accelerator-status').textContent = text;
    },
  };
}
