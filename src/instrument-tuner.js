import { getInstrumentProfile, formatInstrumentNote } from './instrument-profile.js';
import { pitchReading } from './instrument-pitch.js';
import { TunerCaptureLease } from './tuner-capture.js';

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key in node && !key.includes('-')) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children); return node;
}

export function mountInstrumentTuner(host) {
  const lease = new TunerCaptureLease(host.capture, host);
  let previousFocus = null, unsubscribe = null, staleTimer = null, reading = null, generation = 0;
  const reference = el('input', { id: 'tuner-reference', type: 'number', min: '430', max: '450', step: '1', value: '440', 'aria-label': 'Referência Lá4 em hertz' });
  const note = el('output', { id: 'tuner-note', text: '—', 'aria-live': 'polite' });
  const cents = el('output', { id: 'tuner-cents', text: 'Altura não identificada' });
  const detail = el('output', { id: 'tuner-frequency' });
  const needle = el('div', { id: 'tuner-needle', className: 'tuner-needle', hidden: true, 'aria-hidden': 'true' });
  const strings = el('div', { id: 'tuner-strings', className: 'tuner-strings', 'aria-label': 'Afinação real das cordas do perfil' });
  const status = el('p', { id: 'tuner-status', className: 'tool-hint', role: 'status', 'aria-live': 'polite' });
  const retry = el('button', { id: 'tuner-activate', type: 'button', text: 'Ativar entrada', hidden: true });
  const close = el('button', { id: 'tuner-close', type: 'button', text: 'Fechar afinador' });
  const dialog = el('dialog', { id: 'instrument-tuner', className: 'shortcuts-dialog tuner-dialog', 'aria-labelledby': 'tuner-title', 'aria-describedby': 'tuner-description' },
    el('h2', { id: 'tuner-title', text: 'Afinador' }),
    el('p', { id: 'tuner-description', text: 'Toque uma corda por vez. A agulha mede cents em relação à corda mais próxima da afinação do seu perfil; o centro é afinado. Use fones, sem acordes ou banda vazando na entrada.' }),
    el('div', { className: 'tuner-reading' }, note, cents, detail),
    el('div', { className: 'tuner-scale', 'aria-hidden': 'true' }, el('span', { text: '−50' }), el('span', { text: '0' }), el('span', { text: '+50' }), needle),
    strings,
    el('label', { className: 'tuner-reference' }, el('span', { text: 'Lá4 / A4 (Hz)' }), reference), status, retry, close,
    el('p', { className: 'tool-hint muted', text: 'Áudio somente em memória neste dispositivo, sem gravação ou envio. Fechar encerra a entrada aberta só pelo afinador; uma entrada de Praticar já ativa continua ligada.' }));
  document.body.append(dialog);

  function paint() {
    const profile = getInstrumentProfile(host.getSession());
    const result = pitchReading(reading?.frequency, profile, Number(reference.value));
    strings.replaceChildren(...profile.tuning.map((pitch, index) => {
      const number = profile.strings - index;
      const selected = result?.string === number;
      return el('span', { className: selected ? 'tuner-string nearest' : 'tuner-string', 'data-string': number, 'aria-current': selected ? 'true' : 'false',
        text: `${number} · ${formatInstrumentNote(pitch, profile)}` });
    }));
    needle.hidden = !result;
    if (!result) {
      note.textContent = '—'; cents.textContent = 'Altura não identificada'; detail.textContent = '';
      return;
    }
    note.textContent = formatInstrumentNote(result.note, profile);
    const offset = Math.round(result.targetCents);
    cents.textContent = `${offset > 0 ? '+' : ''}${offset} cents · corda ${result.string} (${formatInstrumentNote(result.target, profile)})`;
    detail.textContent = `${reading.frequency.toFixed(2)} Hz · alvo ${result.targetFrequency.toFixed(2)} Hz · confiança ${Math.round(reading.confidence * 100)}%`;
    needle.style.setProperty('--tuner-position', `${50 + Math.max(-50, Math.min(50, result.targetCents))}%`);
    needle.classList.toggle('in-tune', Math.abs(result.targetCents) <= 5);
  }
  function clear() { clearTimeout(staleTimer); staleTimer = null; reading = null; paint(); }
  function receive(pitch) {
    if (!dialog.open) return;
    clearTimeout(staleTimer);
    reading = pitch.frequency !== null && pitch.confidence >= 0.85 ? pitch : null;
    paint();
    if (pitch.stopped) {
      status.textContent = 'Entrada inativa. Ative entrada para tentar novamente.'; retry.hidden = false;
    } else {
      status.textContent = reading ? 'Uma nota identificada; ajuste a corda até o centro.' : 'Toque uma corda sustentada; silêncio, ruído ou sinal ambíguo não identificam uma altura.';
      staleTimer = setTimeout(() => { clear(); status.textContent = 'Sem sinal recente. Verifique a entrada e toque uma corda.'; }, 500);
    }
  }
  async function activate() {
    const request = ++generation;
    clear(); retry.hidden = true; status.textContent = 'Abrindo entrada de áudio…';
    const started = await lease.acquire();
    if (request !== generation || !dialog.open) return;
    if (started) {
      retry.hidden = true; status.textContent = 'Toque uma corda sustentada; a análise usa uma janela de 160 ms.';
      host.ready?.();
    } else {
      retry.hidden = false;
      if (!status.textContent || status.textContent === 'Abrindo entrada de áudio…') status.textContent = 'Não foi possível abrir a entrada. Verifique a permissão e o dispositivo; em Praticar → Configurar você pode escolher outra entrada.';
    }
  }
  function open(trigger) {
    if (dialog.open) return;
    previousFocus = trigger ?? document.activeElement;
    clear(); status.textContent = ''; retry.hidden = true;
    dialog.showModal(); close.focus({ preventScroll: true });
    unsubscribe = host.capture.subscribePitch(receive);
    void activate();
  }
  function finished() {
    ++generation;
    unsubscribe?.(); unsubscribe = null;
    lease.release(); clear(); host.closed?.();
    const focus = previousFocus?.checkVisibility?.() === false
      ? document.getElementById('instrument-options')?.querySelector?.('summary') ?? document.getElementById('studio-instrument')
      : previousFocus;
    focus?.focus({ preventScroll: true }); previousFocus = null;
  }
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', finished);
  dialog.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); });
  reference.addEventListener('input', () => {
    const value = Number(reference.value);
    if (reference.value !== '' && Number.isFinite(value) && value >= 430 && value <= 450) paint();
    else { needle.hidden = true; note.textContent = '—'; cents.textContent = 'Escolha uma referência entre 430 e 450 Hz'; detail.textContent = ''; }
  });
  reference.addEventListener('change', () => {
    const value = Number(reference.value);
    reference.value = reference.value !== '' && Number.isFinite(value) ? String(Math.max(430, Math.min(450, value))) : '440'; paint();
  });
  retry.addEventListener('click', () => { void activate(); });
  host.button.addEventListener('click', () => open(host.button));
  const profileButton = document.getElementById('instrument-profile-tuner');
  profileButton?.addEventListener('click', () => open(profileButton));
  return {
    open,
    suspend(message) {
      ++generation; lease.suspended(); clear();
      if (dialog.open) { status.textContent = message; retry.hidden = false; }
    },
  };
}
