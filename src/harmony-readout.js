// Leitura fixa da harmonia corrente: "Agora · Próximo". Fica colada na
// partitura (Estúdio e Treinar) para acompanhar a reprodução e o treino sem
// deslocar o desenho a cada compasso: o texto só é reescrito quando muda.
//
// Regra de visibilidade: a leitura some quando a sessão que ela representa não
// tem acordes nenhum naquele ponto — nunca porque a fonte é "gerada". Um
// exercício gerado executado sem harmonia fica sem leitura; a fonte autoral
// com acordes continua legível.
import { chordNowNext } from './progression.js';
import { ticksPerBar } from './session.js';

// Texto e rótulo acessível para uma sessão e uma posição, ou null quando não há
// acorde nenhum (sessão sem progressão, progressão vazia ou desligada).
export function harmonyReadoutState(session, position = {}) {
  if (!session) return null;
  const value = chordNowNext(session, position.tick ?? 0);
  const current = value?.current ?? null;
  const next = value?.next ?? null;
  if (!next) return null;
  const bar = ticksPerBar(session);
  const compasso = event => Math.floor(event.start / bar) + 1;
  return {
    text: `Agora: ${current ? current.chord.symbol : 'silêncio'} · Próximo: ${next.chord.symbol}`,
    label: `Agora: ${current ? `${current.chord.symbol}, compasso ${compasso(current)}` : 'sem acorde'} · Próximo: ${next.chord.symbol}, compasso ${compasso(next)}`,
  };
}

// Impressão digital só da harmonia (acordes, ciclo e janela do loop). Serve para
// comparar o material que está soando com o que a partitura exibe: duas fontes
// diferentes com os mesmos acordes no mesmo lugar não se escondem.
export function harmonySignature(session) {
  const progression = session?.progression;
  if (!progression || !progression.enabled || !Array.isArray(progression.chords) || progression.chords.length === 0) return '';
  const chords = progression.chords.map(chord => `${chord.symbol}@${chord.startBar}+${chord.durationBars}`).join(',');
  const loop = session.loop ? `${session.loop.startBar}-${session.loop.endBar}` : '';
  return `${session.bars}|${session.meter.beats}/${session.meter.unit}|${progression.cycleBars}|${chords}|${loop}`;
}

export function createHarmonyReadout() {
  const element = document.createElement('p');
  element.className = 'harmony-now-next';
  element.setAttribute('role', 'status');
  // O valor muda a cada acorde; anunciá-lo interromperia a leitura da partitura.
  element.setAttribute('aria-live', 'off');
  element.hidden = true;
  let signature = '';

  function write(text, label, hidden) {
    const next = `${text}\u0000${label}\u0000${hidden}`;
    if (next === signature) return;
    signature = next;
    element.hidden = hidden;
    if (hidden) { element.textContent = ''; element.removeAttribute('aria-label'); element.removeAttribute('title'); return; }
    element.textContent = text;
    element.setAttribute('aria-label', label);
    element.title = label;
  }

  return {
    element,
    // hidden: outro material está soando naquela partitura (por exemplo, um
    // exercício executado no Treinar enquanto o Estúdio exibe a frase autoral).
    update(session, position = {}, { hidden = false } = {}) {
      const state = hidden ? null : harmonyReadoutState(session, position);
      write(state?.text ?? '', state?.label ?? '', !state);
    },
  };
}
