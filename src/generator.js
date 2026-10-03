import { BAR_OPTIONS, TICKS_PER_BAR } from './model.js';

const ATTACK_COUNTS = Object.freeze({ sparse: 2, medium: 4, busy: 8 });
const DURATIONS = Object.freeze({
  short: [1],
  mixed: [1, 2, 3, 4, 6, 8],
  long: [4, 6, 8, 12, 16],
});
const STYLES = ['straight', 'mixed', 'syncopated'];

// Mulberry32: estado uint32, inclusive seed zero; nao usa relógio ou aleatoriedade
// externa. Serve à reprodução de frases, nao a fins criptográficos.
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function tickWeight(tick, syncopation) {
  if (syncopation === 'straight') return tick % 4 === 0 ? 12 : tick % 2 === 0 ? 3 : 1;
  if (syncopation === 'syncopated') return tick % 4 === 0 ? 1 : 4;
  return 1;
}

export function generateGroove(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Informe as opções do gerador.');
  }
  const { bars, seed, density, syncopation, lengths } = options;
  if (!BAR_OPTIONS.includes(bars)) {
    throw new TypeError('O número de compassos deve ser 1, 2 ou 4.');
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError('A semente deve ser um inteiro uint32 entre 0 e 4294967295.');
  }
  if (typeof density !== 'string' || !Object.hasOwn(ATTACK_COUNTS, density)) {
    throw new TypeError('A densidade deve ser sparse, medium ou busy.');
  }
  if (!STYLES.includes(syncopation)) {
    throw new TypeError('A síncope deve ser straight, mixed ou syncopated.');
  }
  if (typeof lengths !== 'string' || !Object.hasOwn(DURATIONS, lengths)) {
    throw new TypeError('A duração deve ser short, mixed ou long.');
  }

  const random = seededRandom(seed);
  const attacks = ATTACK_COUNTS[density];
  const weights = Array.from({ length: TICKS_PER_BAR }, (_, tick) => tickWeight(tick, syncopation));
  const barWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const starts = [];

  // Sorteio ponderado sem reposição: todos os 16 ticks continuam elegíveis.
  // Os pesos são preferências, nao regras que impedem 8 ataques por compasso.
  for (let bar = 0; bar < bars; bar += 1) {
    let available = (1 << TICKS_PER_BAR) - 1;
    let remainingWeight = barWeight;
    for (let attack = 0; attack < attacks; attack += 1) {
      let target = random() * remainingWeight;
      for (let tick = 0; tick < TICKS_PER_BAR; tick += 1) {
        if ((available & (1 << tick)) === 0) continue;
        target -= weights[tick];
        if (target < 0) {
          starts.push(bar * TICKS_PER_BAR + tick);
          available &= ~(1 << tick);
          remainingWeight -= weights[tick];
          break;
        }
      }
    }
  }
  starts.sort((a, b) => a - b);

  // Durações são sorteadas só depois dos ataques: trocar lengths preserva o
  // ritmo dos ataques. Clamp global permite sustentar através da barra, sem
  // sobrepor nem fundir a próxima nota; escolhas menores deixam pausas reais.
  const choices = DURATIONS[lengths];
  const totalTicks = bars * TICKS_PER_BAR;
  const notes = starts.map((start, index) => {
    const next = starts[index + 1] ?? totalTicks;
    const duration = choices.length === 1 ? choices[0] : choices[Math.floor(random() * choices.length)];
    return { id: `generated-${seed}-${index}`, start, duration: Math.min(duration, next - start) };
  });
  return { notes, bars, seed };
}
