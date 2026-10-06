// Resumo derivado do resultado de evaluateSession (feedback.js), sem reavaliar
// nada: estado por nota e repetição, aproveitamento por compasso, trecho mais
// fraco, tendência/consistência dos ataques no tempo, marcas dos ataques extras,
// ações sugeridas e a chave de comparação entre tentativas. Nenhum valor daqui
// altera o algoritmo de avaliação; tudo é leitura de results.rows e dos campos
// já calculados (toleranceMs, loopBars, startBar, repetitions, mode, goal).
import { summarizeFeedback } from './feedback.js';
import { ticksPerBar, secondsPerTick } from './meter.js';

export const FASTER_RATIO = 0.9;
export const FASTER_BPM = 4;
export const SLOWER_BPM = 10;
export const MIN_BPM = 30;
export const MAX_BPM = 300;
// Um desvio médio abaixo disso é ruído de execução, não tendência.
export const MIN_TENDENCY_MS = 5;
const WEAK_BAR_RATIO = 0.9;
const MIN_ONSETS = 2;
const MIN_SPREAD_ONSETS = 3;
// Empates de "Todas" escolhem o problema mais grave: um acerto nunca esconde
// uma falha igualmente frequente.
const SEVERITY = { missed: 4, wrong: 3, late: 2, early: 2, ok: 1 };

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Média aritmética: é o número que o resumo chama de "média" — nunca o mediano.
function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Desvio padrão populacional: oscilação dos ataques em torno do próprio pulso.
function spread(values) {
  if (values.length < MIN_SPREAD_ONSETS) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

const ms = value => `${Math.round(Math.abs(value))} ms`;

// Altura errada só conta quando o objetivo avaliou alturas; oitava diferente é
// erro de altura (fica separado no rótulo/tooltip da nota), nunca um acerto
// silencioso; baixa confiança segue sem julgamento de altura.
export function rowStatus(row, results) {
  if (row.kind === 'missed') return 'missed';
  if (row.kind !== 'matched') return null;
  const wrongPitch = results.goal === 'pitch'
    && (row.pitchStatus === 'wrong' || row.pitchStatus === 'octave' || (row.pitchStatus === undefined && row.pitchOk === false));
  return wrongPitch ? 'wrong' : row.onset;
}

export function modalStatus(statuses, onsets = []) {
  if (!statuses.length) return null;
  const counts = new Map();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const tied = [...counts.keys()].filter(status => counts.get(status) === top);
  tied.sort((a, b) => SEVERITY[b] - SEVERITY[a]);
  if (tied.length > 1 && SEVERITY[tied[0]] === SEVERITY[tied[1]] && tied.includes('early') && tied.includes('late')) {
    const middle = median(onsets);
    return middle !== null && middle < 0 ? 'early' : 'late';
  }
  return tied[0];
}

// repetition: número (1..N) ou 'all'. Map noteId -> { status, rows }.
export function noteResults(results, repetition = 'all') {
  const byNote = new Map();
  for (const row of results.rows) {
    if (row.noteId === undefined || (repetition !== 'all' && row.repetition !== repetition)) continue;
    const status = rowStatus(row, results);
    if (!status) continue;
    const entry = byNote.get(row.noteId) ?? { rows: [], statuses: [] };
    entry.rows.push(row); entry.statuses.push(status); byNote.set(row.noteId, entry);
  }
  for (const entry of byNote.values()) {
    entry.status = modalStatus(entry.statuses, entry.rows.filter(row => row.kind === 'matched').map(row => row.onsetMs));
  }
  return byNote;
}

// Aproveitamento = ataques no tempo (e altura certa quando avaliada) / notas
// esperadas no compasso. Compassos fora do loop ficam com ratio null.
export function barAccuracy(results, session, repetition = 'all') {
  const barTicks = ticksPerBar(session);
  const barOf = new Map(session.notes.map(note => [note.id, Math.floor(note.start / barTicks + 1e-9)]));
  const bars = Array.from({ length: results.loopBars }, (_, index) => ({ bar: results.startBar + index, ok: 0, total: 0, ratio: null }));
  for (const row of results.rows) {
    if (row.noteId === undefined || (repetition !== 'all' && row.repetition !== repetition)) continue;
    const status = rowStatus(row, results);
    const entry = bars[(barOf.get(row.noteId) ?? -1) - results.startBar];
    if (!status || !entry) continue;
    entry.total += 1; if (status === 'ok') entry.ok += 1;
  }
  for (const entry of bars) entry.ratio = entry.total ? entry.ok / entry.total : null;
  return bars;
}

export function worstBar(bars) {
  let worst = null;
  for (const entry of bars) if (entry.ratio !== null && entry.ratio < 1 && (!worst || entry.ratio < worst.ratio)) worst = entry;
  return worst;
}

// O compasso mais fraco, unido a um vizinho também abaixo de 90% (o seguinte
// primeiro); no máximo dois. Nada a repetir quando tudo ficou certo, quando o
// trecho já é o loop inteiro ou quando só há um compasso.
export function weakRange(bars) {
  const worst = worstBar(bars);
  if (!worst || bars.length < 2) return null;
  const index = bars.indexOf(worst);
  const weak = entry => entry && entry.ratio !== null && entry.ratio < WEAK_BAR_RATIO;
  let start = index, end = index;
  if (bars.length > 2 && weak(bars[index + 1])) end = index + 1;
  else if (bars.length > 2 && weak(bars[index - 1])) start = index - 1;
  const startBar = bars[start].bar, endBar = bars[end].bar + 1;
  return endBar - startBar >= bars.length ? null : { startBar, endBar };
}

// Marcas dos ataques que não correspondem a nenhuma nota escrita: extras (com a
// posição real medida) e, no modo livre, cada ataque contra a subdivisão mais
// próxima. A partitura mostra UMA passagem da frase: a posição de uma repetição
// posterior é trazida para a mesma passagem (como o estado modal das notas) e as
// repetições que caíram no mesmo ponto viram uma única marca.
export function attackMarks(results, session, repetition = 'all') {
  const barTicks = ticksPerBar(session);
  const startTick = results.startBar * barTicks;
  const loopTicks = results.loopBars * barTicks;
  const tickSeconds = secondsPerTick(results.bpm);
  const marks = new Map();
  for (const row of results.rows) {
    if (repetition !== 'all' && row.repetition !== repetition) continue;
    let status, tick;
    if (row.kind === 'extra' && Number.isFinite(row.actualStart)) {
      status = 'extra';
      const absolute = startTick + row.actualStart / tickSeconds;
      tick = startTick + (((absolute - startTick) % loopTicks) + loopTicks) % loopTicks;
    } else if (row.kind === 'free' && Number.isFinite(row.nearestTick)) {
      status = 'free'; tick = row.nearestTick;
    } else continue;
    const key = `${status}@${tick.toFixed(2)}`;
    const mark = marks.get(key) ?? { status, tick, rows: [] };
    mark.rows.push(row); marks.set(key, mark);
  }
  return [...marks.values()].sort((a, b) => a.tick - b.tick);
}

// Veredito, frases contextuais (no máximo três), ações sugeridas e números crus.
// session é necessária apenas para o compasso das notas e para a extensão de
// entrada (calibração); results vem inteiro de evaluateSession.
export function resultSummary(results, session) {
  const feedback = summarizeFeedback(results);
  const scored = results.rows.filter(row => row.kind === 'matched' || row.kind === 'free');
  const onsets = scored.map(row => row.onsetMs);
  const free = results.mode === 'free';
  const verdict = free
    ? { kind: 'free', ok: feedback.attackOk, count: feedback.free }
    : feedback.expected === 0 ? { kind: 'empty', ok: 0, expected: 0 }
      : { kind: 'attacks', ok: feedback.attackOk, expected: feedback.expected };
  const ratio = free ? (feedback.free ? feedback.attackOk / feedback.free : null)
    : verdict.kind === 'attacks' ? verdict.ok / verdict.expected : null;
  const medianMs = median(onsets);
  const meanMs = mean(onsets);
  // A tendência sai da média real (e é escrita como "em média"), não do mediano.
  const tendencyMs = meanMs !== null && onsets.length >= MIN_ONSETS && Math.abs(meanMs) >= MIN_TENDENCY_MS ? meanMs : null;
  const spreadMs = spread(onsets);
  const consistency = spreadMs === null ? null : spreadMs <= results.toleranceMs / 2 ? 'regular' : 'irregular';
  const pitchWrong = results.goal === 'pitch'
    ? results.rows.filter(row => row.kind === 'matched' && rowStatus(row, results) === 'wrong').length : 0;
  const input = session.extensions?.performanceInput;
  const uncalibrated = !!input && input.calibrated === false;
  // No máximo três frases: falhas de altura e tendência primeiro, depois a
  // calibração ausente; a consistência é a primeira a sair.
  const candidates = [
    pitchWrong > 0 && { kind: 'pitch', count: pitchWrong, order: 2, priority: 0 },
    tendencyMs !== null && { kind: 'tendency', valueMs: tendencyMs, order: 0, priority: 1 },
    uncalibrated && { kind: 'calibration', action: 'calibrate', order: 3, priority: 2 },
    consistency && { kind: 'consistency', value: consistency, spreadMs, order: 1, priority: 3 },
  ].filter(Boolean).sort((a, b) => a.priority - b.priority).slice(0, 3).sort((a, b) => a.order - b.order);
  const fragments = candidates.map(({ order, priority, ...fragment }) => ({ ...fragment, text: fragmentText(fragment) }));
  const bars = barAccuracy(results, session);
  const weak = verdict.kind === 'attacks' ? weakRange(bars) : null;
  const slower = results.bpm > MIN_BPM ? Math.max(MIN_BPM, results.bpm - SLOWER_BPM) : null;
  return {
    feedback, verdict, ratio, medianMs, tendencyMs, spreadMs, consistency, pitchWrong, uncalibrated, fragments, bars, weak,
    actions: {
      retry: true,
      loop: weak,
      slower,
      faster: ratio !== null && ratio >= FASTER_RATIO && results.bpm + FASTER_BPM <= MAX_BPM ? results.bpm + FASTER_BPM : null,
    },
  };
}

// Sugestão de andamento depois de uma execução AVALIADA (com notas esperadas):
// ≥90% dos ataques no tempo sugere +4 BPM; <70% sugere −4 BPM. É só uma
// sugestão — nada muda sozinho; o CTA explícito do resultado aplica.
export const SUGGEST_HIGH_RATIO = 0.9;
export const SUGGEST_LOW_RATIO = 0.7;
export const SUGGEST_BPM = 4;

export function tempoSuggestion(summary, bpm) {
  const ratio = typeof summary?.ratio === 'number' ? summary.ratio : null;
  const base = Number.isFinite(bpm) ? Math.round(bpm) : null;
  if (ratio === null || base === null || summary?.verdict?.kind !== 'attacks') return null;
  const clampBpm = value => Math.max(MIN_BPM, Math.min(MAX_BPM, value));
  if (ratio >= SUGGEST_HIGH_RATIO) {
    const target = clampBpm(base + SUGGEST_BPM);
    return target === base ? null : { direction: 'up', delta: target - base, bpm: target, ratio };
  }
  if (ratio < SUGGEST_LOW_RATIO) {
    const target = clampBpm(base - SUGGEST_BPM);
    return target === base ? null : { direction: 'down', delta: target - base, bpm: target, ratio };
  }
  return null;
}

function fragmentText(fragment) {
  if (fragment.kind === 'tendency') {
    return fragment.valueMs > 0
      ? `Você atrasa em média ${ms(fragment.valueMs)}.`
      : `Você adianta em média ${ms(fragment.valueMs)}.`;
  }
  if (fragment.kind === 'consistency') {
    return fragment.value === 'regular'
      ? 'Seu tempo foi regular.'
      : `Seu tempo oscilou bastante (±${ms(fragment.spreadMs)}).`;
  }
  if (fragment.kind === 'pitch') {
    return `${fragment.count} ${fragment.count === 1 ? 'nota' : 'notas'} com altura errada; toque devagar conferindo cada altura.`;
  }
  return 'Entrada sem calibração: o atraso residual do dispositivo pode deslocar os desvios.';
}

// Material musical que define "o mesmo exercício": notas e geometria, sem
// andamento, loop, mixer ou entrada.
export function exerciseFingerprint(session) {
  const notes = [...session.notes].sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)))
    .map(note => [note.start, note.duration, note.pitch, note.offsetMs ?? 0]);
  return JSON.stringify([session.meter.beats, session.meter.unit, session.bars, session.subdivision, session.swing, session.swingUnit, notes]);
}

// Duas tentativas só se comparam com o mesmo material, trecho, andamento,
// repetições, modo, objetivo e origem.
export function comparisonKey(session, results, origin = 'session') {
  return JSON.stringify([origin, exerciseFingerprint(session), results.startBar, results.loopBars, results.bpm, results.repetitions, results.mode, results.goal]);
}

// Só o necessário para a frase "Tentativa anterior: N de M".
export function comparisonEntry(summary) {
  const { kind, ok = null, expected = null } = summary.verdict;
  return { kind, ok, expected };
}

// Memória da etapa: só nesta visita. A biblioteca durável pode substituir via
// host.previousResult(key); este é o gancho estreito de identidade/comparação.
export function createComparisonMemory(limit = 50) {
  const entries = [];
  return {
    record(key, entry) {
      entries.push({ key, ...entry });
      if (entries.length > limit) entries.shift();
      return entry;
    },
    previous(key) {
      for (let index = entries.length - 1; index >= 0; index -= 1) if (entries[index].key === key) return entries[index];
      return null;
    },
    get size() { return entries.length; },
  };
}
