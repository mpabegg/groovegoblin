import { EPSILON, ticksPerBar, beatTicks, beatGroups, groupStarts, gridStep, roundTick } from './meter.js';
import { MIN_BARS, MAX_BARS } from './model.js';
import { METER_UNITS, MAX_BEATS, SUBDIVISIONS } from './session.js';
import { findKey } from './progression.js';
import { seededRandom } from './random.js';

// Ataques por compasso de 16 ticks; outros compassos escalam proporcionalmente.
const ATTACK_COUNTS = Object.freeze({ sparse: 2, medium: 4, busy: 8 });
// Durações em passos da grade (em 4/4 com subdivisão 4, passo = 1 tick).
const DURATIONS = Object.freeze({
  short: [1],
  mixed: [1, 2, 3, 4, 6, 8],
  long: [4, 6, 8, 12, 16],
});
const STYLES = ['straight', 'mixed', 'syncopated'];
const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };

function isMultiple(value, step) {
  return Math.abs(value / step - Math.round(value / step)) < 1e-6;
}

function tickWeight(tick, syncopation, beat) {
  const onBeat = isMultiple(tick, beat);
  const onHalf = isMultiple(tick, beat / 2);
  if (syncopation === 'straight') return onBeat ? 12 : onHalf ? 3 : 1;
  if (syncopation === 'syncopated') return onBeat ? 1 : 4;
  return 1;
}

function validMeter(meter) {
  return meter !== null && typeof meter === 'object' && Number.isInteger(meter.beats)
    && meter.beats >= 1 && meter.beats <= MAX_BEATS && METER_UNITS.includes(meter.unit);
}

// Frase rítmica reproduzível. Opções históricas (bars, seed, density,
// syncopation, lengths) mais meter, subdivision (por semínima: 3 = tercinas),
// accents (acento no tempo 1 e nos inícios de grupo; notas fantasmas em
// semicolcheias de contratempo quando densa) e keyId (contorno melódico na
// escala; sem keyId todas as notas usam a altura 69).
export function generateGroove(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Informe as opções do gerador.');
  }
  const {
    bars, seed, density, syncopation, lengths,
    meter = { beats: 4, unit: 4 }, subdivision = 4, accents = true, keyId = null,
  } = options;
  if (!Number.isInteger(bars) || bars < MIN_BARS || bars > MAX_BARS) {
    throw new TypeError(`O número de compassos deve ser inteiro entre ${MIN_BARS} e ${MAX_BARS}.`);
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
  if (!validMeter(meter)) throw new TypeError('Compasso inválido.');
  if (!SUBDIVISIONS.includes(subdivision)) throw new TypeError('A subdivisão deve ser de 1 a 8 partes por semínima.');
  if (typeof accents !== 'boolean') throw new TypeError('accents deve ser booleano.');
  const key = keyId === null ? null : findKey(keyId);

  const random = seededRandom(seed);
  const barTicks = ticksPerBar(meter);
  const step = gridStep(subdivision);
  const slots = [];
  for (let tick = 0; tick < barTicks - EPSILON; tick += step) slots.push(roundTick(tick));
  const attacks = Math.max(1, Math.min(slots.length, Math.round((ATTACK_COUNTS[density] * barTicks) / 16)));
  const beat = Math.min(beatTicks(meter), 4);
  const weights = slots.map(tick => tickWeight(tick, syncopation, beat));
  const barWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const starts = [];

  // Sorteio ponderado sem reposição: todos os pontos da grade continuam
  // elegíveis. Os pesos são preferências, não regras.
  for (let bar = 0; bar < bars; bar += 1) {
    const available = slots.map(() => true);
    let remainingWeight = barWeight;
    for (let attack = 0; attack < attacks; attack += 1) {
      let target = random() * remainingWeight;
      for (let index = 0; index < slots.length; index += 1) {
        if (!available[index]) continue;
        target -= weights[index];
        if (target < 0) {
          starts.push(roundTick(bar * barTicks + slots[index]));
          available[index] = false;
          remainingWeight -= weights[index];
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
  const totalTicks = bars * barTicks;
  const notes = starts.map((start, index) => {
    const next = starts[index + 1] ?? totalTicks;
    const steps = choices.length === 1 ? choices[0] : choices[Math.floor(random() * choices.length)];
    return { id: `generated-${seed}-${index}`, start, duration: roundTick(Math.min(steps * step, next - start)) };
  });

  // Dinâmica e alturas vêm de fontes separadas: não alteram ataques/durações.
  const strong = groupStarts(meter).filter((_, index) => index === 0 || beatGroups(meter)[index] > 1);
  const melody = seededRandom((seed ^ 0x5bd1e995) >>> 0);
  let degree = 0;
  return {
    notes: notes.map(note => {
      const local = note.start - Math.floor((note.start + EPSILON) / barTicks) * barTicks;
      let articulation = 'normal';
      let velocity = 0.8;
      if (accents && strong.some(tick => Math.abs(tick - local) < EPSILON)) {
        articulation = 'accent';
        velocity = 0.95;
      } else if (accents && density === 'busy' && note.duration <= step + EPSILON && !isMultiple(local, beat / 2)) {
        articulation = 'ghost';
        velocity = 0.4;
      }
      let pitch = 69;
      if (key) {
        degree = Math.max(-3, Math.min(9, degree + Math.round((melody() - 0.5) * 4)));
        const scale = SCALES[key.mode];
        const octave = Math.floor(degree / 7);
        pitch = 60 + key.pitchClass + scale[((degree % 7) + 7) % 7] + 12 * octave;
      }
      return { ...note, pitch, velocity, articulation, offsetMs: 0 };
    }),
    bars,
    seed,
  };
}

// Padrão polirrítmico: `pulses` ataques igualmente espaçados a cada
// `spanBeats` tempos do compasso (ex.: 3 contra 4 em 4/4 = pulses 3, spanBeats 4).
export function generatePolyrhythm({ bars = 1, meter = { beats: 4, unit: 4 }, pulses = 3, spanBeats = meter?.beats, pitch = 69 } = {}) {
  if (!Number.isInteger(bars) || bars < MIN_BARS || bars > MAX_BARS) throw new TypeError(`O número de compassos deve ser inteiro entre ${MIN_BARS} e ${MAX_BARS}.`);
  if (!validMeter(meter)) throw new TypeError('Compasso inválido.');
  if (!Number.isInteger(pulses) || pulses < 2 || pulses > 12) throw new TypeError('A polirritmia deve ter de 2 a 12 pulsos.');
  if (!Number.isInteger(spanBeats) || spanBeats < 1 || spanBeats > MAX_BEATS * 4) throw new TypeError('A duração do ciclo deve ser um número inteiro de tempos.');
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) throw new TypeError('Altura inválida.');
  const span = spanBeats * beatTicks(meter);
  const total = bars * ticksPerBar(meter);
  const length = span / pulses;
  const notes = [];
  for (let index = 0; index * length < total - EPSILON; index += 1) {
    const start = roundTick(index * length);
    notes.push({
      id: `poly-${pulses}-${index}`, start, duration: roundTick(Math.min(length, total - start)), pitch,
      velocity: index % pulses === 0 ? 0.95 : 0.8, articulation: index % pulses === 0 ? 'accent' : 'normal', offsetMs: 0,
    });
  }
  return notes;
}
