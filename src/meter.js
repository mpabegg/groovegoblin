// Coordenadas de tempo compartilhadas pelo motor: 4 ticks = semínima, para
// qualquer fórmula de compasso. Ticks podem ser fracionários (quiálteras,
// microtempo); comparações usam EPSILON em vez de igualdade exata.
// BPM conta SEMÍNIMAS por minuto; em 6/8 uma colcheia dura meio tempo de BPM.

export const TICKS_PER_QUARTER = 4;
export const EPSILON = 1e-6;

function meterOf(value) {
  return value && typeof value === 'object' && value.meter ? value.meter : value;
}

// Aceita uma sessão ou um compasso {beats, unit}: 7/8 => 14, 3/4 => 12.
export function ticksPerBar(value) {
  const meter = meterOf(value);
  return (meter.beats * 16) / meter.unit;
}

// Duração (em ticks) da unidade escrita no denominador: /4 => 4, /8 => 2.
export function beatTicks(value) {
  return 16 / meterOf(value).unit;
}

export function sessionTicks(session) {
  return session.bars * ticksPerBar(session);
}

export function secondsPerTick(bpm) {
  return 60 / bpm / TICKS_PER_QUARTER;
}

// Passo da grade em ticks: subdivisão por semínima (3 => tercinas de colcheia).
export function gridStep(subdivision) {
  return TICKS_PER_QUARTER / subdivision;
}

export function quantizeTick(tick, subdivision) {
  const step = gridStep(subdivision);
  return roundTick(Math.round(tick / step) * step);
}

// Remove ruído de ponto flutuante sem perder frações de quiálteras de até 1/840.
export function roundTick(tick) {
  return Math.round(tick * 1e9) / 1e9;
}

// Agrupamento de tempos usado para acentos de metrônomo e padrões de banda.
// Compassos compostos (6/8, 9/8, 12/8) agrupam colcheias em 3; compassos
// irregulares usam agrupamentos convencionais (5/8 = 3+2, 7/8 = 2+2+3).
export function beatGroups(value) {
  const { beats, unit } = meterOf(value);
  if (unit <= 4) {
    if (beats === 5) return [3, 2];
    if (beats === 7) return [4, 3];
    return Array.from({ length: beats }, () => 1);
  }
  if (beats <= 3) return [beats];
  if (beats % 3 === 0) return Array.from({ length: beats / 3 }, () => 3);
  if (beats === 5) return [3, 2];
  if (beats === 7) return [2, 2, 3];
  const groups = Array.from({ length: Math.floor(beats / 2) }, () => 2);
  if (beats % 2 === 1) groups[groups.length - 1] = 3;
  return groups;
}

// Inícios (em ticks locais do compasso) de cada grupo de beatGroups.
export function groupStarts(value) {
  const step = beatTicks(value);
  const starts = [];
  let cursor = 0;
  for (const group of beatGroups(value)) {
    starts.push(cursor * step);
    cursor += group;
  }
  return starts;
}

// Swing desloca a segunda metade de cada par (colcheias ou semicolcheias)
// por um mapeamento linear por partes, contínuo e monotônico: 0 = reto,
// 1/3 = tercina (2:1), 0.75 = máximo permitido. Cada compasso recomeça a
// grade; um par incompleto no fim de compassos irregulares fica reto.
export function swingLocalTick(localTick, swing, swingUnit, barTicks) {
  if (!swing) return localTick;
  const period = swingUnit === 'sixteenth' ? 2 : 4;
  const base = Math.floor((localTick + EPSILON) / period) * period;
  if (base + period > barTicks + EPSILON) return localTick;
  const half = period / 2;
  const x = localTick - base;
  const warped = x < half ? x * (1 + swing) : half * (1 + swing) + (x - half) * (1 - swing);
  return base + warped;
}

// Tick tocado (com swing) para um tick absoluto da sessão.
export function performTick(session, tick) {
  const barTicks = ticksPerBar(session);
  const bar = Math.floor((tick + EPSILON) / barTicks);
  const local = tick - bar * barTicks;
  return bar * barTicks + swingLocalTick(local, session.swing, session.swingUnit, barTicks);
}
