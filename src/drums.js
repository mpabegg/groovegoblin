import { BAR_OPTIONS, TICKS_PER_BAR, validPhrase } from './model.js';

export const DRUM_INSTRUMENTS = Object.freeze(['kick', 'snare', 'hihat']);

// Mulberry32, como no gerador de frases: a semente não depende do relógio.
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateDrums({ notes, bars, seed }) {
  if (!BAR_OPTIONS.includes(bars) || !validPhrase(notes, bars)) throw new TypeError('Informe uma frase válida de 1, 2 ou 4 compassos.');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError('A semente da bateria deve ser um inteiro uint32.');
  }
  const random = seededRandom(seed);
  const hits = [];
  for (let bar = 0; bar < bars; bar += 1) {
    const offset = bar * TICKS_PER_BAR;
    const attacks = notes.filter(note => note.start >= offset && note.start < offset + TICKS_PER_BAR)
      .map(note => note.start - offset).sort((a, b) => a - b);
    const kicks = new Set([0]);
    // Um apoio na segunda metade, depois até dois ataques selecionados da frase.
    // Coincidir com o baixo é válido: apoiar não significa copiar todos os ataques.
    kicks.add(attacks.includes(8) || random() < 0.65 ? 8 : 10);
    const candidates = attacks.filter(tick => !kicks.has(tick) && tick !== 4 && tick !== 12);
    const count = Math.min(candidates.length, attacks.length > 6 ? 1 : 2);
    for (let index = 0; index < count; index += 1) {
      const choice = Math.floor(random() * candidates.length);
      kicks.add(candidates.splice(choice, 1)[0]);
    }
    for (const tick of [...kicks].sort((a, b) => a - b)) {
      hits.push({ instrument: 'kick', start: offset + tick, velocity: tick === 0 ? 0.9 : 0.72 });
    }
    for (const tick of [4, 12]) {
      hits.push({ instrument: 'snare', start: offset + tick, velocity: tick === 12 ? 0.82 : 0.76 });
    }
    // Colcheias com espaço nas frases densas; um único pickup opcional, não um fill copiado.
    for (let tick = 0; tick < TICKS_PER_BAR; tick += 2) {
      if (tick % 4 !== 0 && (attacks.length > 6 || random() < 0.22)) continue;
      hits.push({ instrument: 'hihat', start: offset + tick, velocity: tick % 4 === 0 ? 0.5 : 0.32 });
    }
    if (attacks.length <= 6 && random() < 0.5) {
      hits.push({ instrument: 'hihat', start: offset + 15, velocity: 0.24 });
    }
  }
  hits.sort((a, b) => a.start - b.start || DRUM_INSTRUMENTS.indexOf(a.instrument) - DRUM_INSTRUMENTS.indexOf(b.instrument));
  return { hits, bars, seed };
}
