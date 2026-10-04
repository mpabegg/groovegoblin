// Avaliação de uma execução por teclado/toque contra a sessão: o trecho do
// loop (loop.startBar..endBar) repetido N vezes numa linha do tempo contínua,
// sem particionar por compasso. A repetição r começa em (r-1)*repetitionSeconds.
// Tempo: BPM em semínimas; 1 tick = 1/4 de semínima; swing e microtempo
// (offsetMs) fazem parte do tempo ESPERADO de cada nota.
//
// Janelas (derivadas, nunca constantes absolutas):
//   gridSeconds   = passo da subdivisão da sessão (4/subdivision ticks)
//   spacing       = menor distância entre ataques esperados consecutivos,
//                   incluindo a volta da última nota para a primeira
//   matchWindowMs = min(gridSeconds, spacing) / 2 -- raio para decidir SE uma
//                   tentativa pertence a uma nota; janelas vizinhas nunca se
//                   sobrepõem, então o casamento contínuo não é ambíguo
//   toleranceMs   = matchWindowMs / 2 -- dentro disso => 'ok'
// Em 4/4 com subdivisão 4 isso reproduz a regra histórica: janela = meio tick.
//
// Modos (session.training.evaluation):
// - strict: desvio absoluto contra a grade (com swing/microtempo).
// - style: mesma correspondência, mas ataques/términos são classificados em
//   relação à mediana pessoal ("feel": tocar consistentemente atrás ou à
//   frente do tempo não é erro); o deslocamento sistemático é relatado.
// - free: sem frase de referência; cada ataque é medido contra o ponto mais
//   próximo da grade de subdivisão (improviso, leitura livre).
// Nenhum modo produz nota estética: só evidências objetivas (contagens,
// desvios em ms, deriva por repetição).
//
// O casamento usa SOMENTE o ataque (start); a duração/fim nunca decide se
// uma tentativa corresponde. Para uma tentativa 'extra', a repetição
// reportada é estimada pela posição absoluta do ataque (heurística de exibição).

import { EPSILON, ticksPerBar, gridStep, performTick, secondsPerTick, swingLocalTick } from './meter.js';
import { validateSession, createSession } from './session.js';

export const REPETITIONS = 4;

function classify(diffMs, toleranceMs) {
  if (diffMs < -toleranceMs) return 'early';
  if (diffMs > toleranceMs) return 'late';
  return 'ok';
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function describe(values) {
  if (values.length === 0) return { count: 0, meanMs: null, medianMs: null, sdMs: null, meanAbsMs: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    count: values.length,
    meanMs: mean,
    medianMs: median(values),
    sdMs: Math.sqrt(variance),
    meanAbsMs: values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length,
  };
}

// Inclinação (ms por repetição) da média dos desvios: >0 arrastando, <0 correndo.
function drift(perRepetition) {
  const points = perRepetition.filter(entry => entry.meanOnsetMs !== null);
  if (points.length < 2) return null;
  const meanX = points.reduce((sum, entry) => sum + entry.repetition, 0) / points.length;
  const meanY = points.reduce((sum, entry) => sum + entry.meanOnsetMs, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const entry of points) {
    numerator += (entry.repetition - meanX) * (entry.meanOnsetMs - meanY);
    denominator += (entry.repetition - meanX) ** 2;
  }
  return denominator === 0 ? null : numerator / denominator;
}

function geometry(session) {
  const barTicks = ticksPerBar(session);
  const tickSeconds = secondsPerTick(session.bpm);
  const startTick = session.loop.startBar * barTicks;
  const endTick = session.loop.endBar * barTicks;
  const repetitionSeconds = (endTick - startTick) * tickSeconds;
  const timeOf = tick => (performTick(session, tick) - startTick) * tickSeconds;
  return { barTicks, tickSeconds, startTick, endTick, repetitionSeconds, timeOf };
}

function extraRepetition(start, repetitionSeconds, repetitions) {
  const rep = Math.floor(start / repetitionSeconds) + 1;
  return Math.min(repetitions, Math.max(1, rep));
}

function referenceRows(session, attempts, options) {
  const { tickSeconds, startTick, endTick, repetitionSeconds, timeOf } = geometry(session);
  const repetitions = options.repetitions;
  const phrase = session.notes
    .filter(note => note.start >= startTick - EPSILON && note.start < endTick - EPSILON)
    .sort((a, b) => a.start - b.start);
  const local = phrase.map(note => ({
    note,
    start: timeOf(note.start) + note.offsetMs / 1000,
    end: timeOf(Math.min(note.start + note.duration, endTick)),
  })).sort((a, b) => a.start - b.start);

  const gridSeconds = gridStep(session.subdivision) * tickSeconds;
  let spacing = Infinity;
  for (let index = 0; index < local.length; index += 1) {
    const next = index + 1 < local.length ? local[index + 1].start : local[0].start + repetitionSeconds;
    spacing = Math.min(spacing, next - local[index].start);
  }
  const matchWindowMs = (Math.min(gridSeconds, spacing) * 1000) / 2;
  const toleranceMs = matchWindowMs / 2;

  const expected = [];
  for (let rep = 1; rep <= repetitions; rep += 1) {
    const offset = (rep - 1) * repetitionSeconds;
    for (const { note, start, end } of local) {
      expected.push({ noteId: note.id, pitch: note.pitch, repetition: rep, expectedStart: offset + start, expectedEnd: offset + end });
    }
  }
  const actual = [...attempts].sort((a, b) => a.start - b.start);
  const rows = [];
  const extra = att => ({
    kind: 'extra', repetition: extraRepetition(att.start, repetitionSeconds, repetitions),
    actualStart: att.start, actualEnd: att.end, pitch: att.pitch ?? null,
  });
  const missed = exp => ({
    kind: 'missed', repetition: exp.repetition, noteId: exp.noteId,
    expectedStart: exp.expectedStart, expectedEnd: exp.expectedEnd, expectedPitch: exp.pitch,
  });
  let i = 0;
  let j = 0;
  while (i < expected.length && j < actual.length) {
    const exp = expected[i];
    const att = actual[j];
    const onsetMs = (att.start - exp.expectedStart) * 1000;
    if (onsetMs < -matchWindowMs) {
      rows.push(extra(att));
      j += 1;
    } else if (onsetMs > matchWindowMs) {
      rows.push(missed(exp));
      i += 1;
    } else {
      const endMs = (att.end - exp.expectedEnd) * 1000;
      const pitch = att.pitch ?? null;
      rows.push({
        kind: 'matched', repetition: exp.repetition, noteId: exp.noteId,
        expectedStart: exp.expectedStart, expectedEnd: exp.expectedEnd, actualStart: att.start, actualEnd: att.end,
        onsetMs, endMs, onset: classify(onsetMs, toleranceMs), ending: classify(endMs, toleranceMs),
        expectedPitch: exp.pitch, pitch, pitchOk: pitch === null ? null : pitch === exp.pitch,
      });
      i += 1;
      j += 1;
    }
  }
  while (i < expected.length) rows.push(missed(expected[i++]));
  while (j < actual.length) rows.push(extra(actual[j++]));

  if (options.mode === 'style') {
    const matched = rows.filter(row => row.kind === 'matched');
    const feelOnset = median(matched.map(row => row.onsetMs)) ?? 0;
    const feelEnd = median(matched.map(row => row.endMs)) ?? 0;
    for (const row of matched) {
      row.relativeOnsetMs = row.onsetMs - feelOnset;
      row.relativeEndMs = row.endMs - feelEnd;
      row.onset = classify(row.relativeOnsetMs, toleranceMs);
      row.ending = classify(row.relativeEndMs, toleranceMs);
    }
  }
  return { rows, toleranceMs, matchWindowMs, repetitionSeconds };
}

// Modo livre: cada ataque contra o ponto de subdivisão (com swing) mais próximo.
function freeRows(session, attempts, options) {
  const { barTicks, tickSeconds, startTick, repetitionSeconds } = geometry(session);
  const step = gridStep(session.subdivision);
  const gridSeconds = step * tickSeconds;
  const toleranceMs = (gridSeconds * 1000) / 4;
  const rows = [...attempts].sort((a, b) => a.start - b.start).map(att => {
    const straightTick = att.start / tickSeconds;
    const candidates = [Math.floor(straightTick / step) - 1, Math.floor(straightTick / step), Math.floor(straightTick / step) + 1, Math.floor(straightTick / step) + 2]
      .map(index => index * step)
      .map(tick => {
        const bar = Math.floor((tick + EPSILON) / barTicks);
        return { tick, performed: bar * barTicks + swingLocalTick(tick - bar * barTicks, session.swing, session.swingUnit, barTicks) };
      });
    let best = candidates[0];
    for (const candidate of candidates) {
      if (Math.abs(candidate.performed * tickSeconds - att.start) < Math.abs(best.performed * tickSeconds - att.start)) best = candidate;
    }
    const deviationMs = (att.start - best.performed * tickSeconds) * 1000;
    const loopTicks = repetitionSeconds / tickSeconds;
    return {
      kind: 'free', repetition: extraRepetition(att.start, repetitionSeconds, options.repetitions),
      actualStart: att.start, actualEnd: att.end, pitch: att.pitch ?? null,
      nearestTick: startTick + (((best.tick % loopTicks) + loopTicks) % loopTicks),
      deviationMs, onsetMs: deviationMs, onset: classify(deviationMs, toleranceMs),
    };
  });
  return { rows, toleranceMs, matchWindowMs: (gridSeconds * 1000) / 2, repetitionSeconds };
}

function statistics(rows, repetitions, mode) {
  const scored = rows.filter(row => row.kind === 'matched' || row.kind === 'free');
  const onsets = scored.map(row => row.onsetMs);
  const endings = rows.filter(row => row.kind === 'matched').map(row => row.endMs);
  const perRepetition = Array.from({ length: repetitions }, (_, index) => {
    const repetition = index + 1;
    const inRep = rows.filter(row => row.repetition === repetition);
    const values = inRep.filter(row => row.kind === 'matched' || row.kind === 'free').map(row => row.onsetMs);
    const summary = describe(values);
    return {
      repetition,
      matched: inRep.filter(row => row.kind === 'matched').length,
      missed: inRep.filter(row => row.kind === 'missed').length,
      extra: inRep.filter(row => row.kind === 'extra').length,
      played: inRep.filter(row => row.kind !== 'missed').length,
      meanOnsetMs: summary.meanMs,
      meanAbsOnsetMs: summary.meanAbsMs,
    };
  });
  return {
    onset: describe(onsets),
    ending: describe(endings),
    perRepetition,
    driftMsPerRepetition: drift(perRepetition),
    feelMs: mode === 'free' ? null : median(onsets),
  };
}

// Avalia tentativas ({start,end,pitch?} em segundos desde o primeiro compasso
// avaliado) contra a sessão. options: {mode, goal, repetitions}.
export function evaluateSession(session, attempts, options = {}) {
  const checked = validateSession(session);
  if (!checked.ok) throw new TypeError(checked.error);
  const valid = checked.session;
  if (!Array.isArray(attempts)) throw new TypeError('As tentativas devem ser uma lista.');
  const mode = options.mode ?? valid.training.evaluation;
  const goal = options.goal ?? valid.training.goal;
  const repetitions = options.repetitions ?? valid.training.repetitions;
  if (!['strict', 'style', 'free'].includes(mode)) throw new TypeError('Modo de avaliação desconhecido.');
  const normalized = attempts.map(att => ({ start: att.start, end: att.end ?? att.start, pitch: att.pitch ?? null }));
  const core = mode === 'free'
    ? freeRows(valid, normalized, { repetitions })
    : referenceRows(valid, normalized, { repetitions, mode });
  return {
    ...core,
    mode,
    goal,
    repetitions,
    bpm: valid.bpm,
    startBar: valid.loop.startBar,
    loopBars: valid.loop.endBar - valid.loop.startBar,
    barSeconds: ticksPerBar(valid) * secondsPerTick(valid.bpm),
    stats: statistics(core.rows, repetitions, mode),
  };
}

// API histórica: frase + bpm + compassos (4/4 por padrão). options aceita
// {session} ou {meter, subdivision, swing, swingUnit, repetitions, loop, mode, goal}.
export function evaluate(notes, attempts, bpm, bars = 1, options = {}) {
  const { session: base, mode, goal, repetitions = REPETITIONS, ...fields } = options;
  const session = base
    ? { ...base, notes, bpm, bars }
    : createSession({
      notes, bpm, bars,
      ...Object.fromEntries(['meter', 'subdivision', 'swing', 'swingUnit', 'loop'].filter(key => key in fields).map(key => [key, fields[key]])),
    });
  return evaluateSession(session, attempts, { mode: mode ?? 'strict', goal: goal ?? 'duration', repetitions });
}

const ms = value => `${Math.round(Math.abs(value))} ms`;

export function summarizeFeedback(result) {
  let matched = 0;
  let missed = 0;
  let extra = 0;
  let attackOk = 0;
  let endOk = 0;
  let pitchChecked = 0;
  let pitchOk = 0;
  let free = 0;
  for (const row of result.rows) {
    if (row.kind === 'matched') {
      matched += 1;
      if (row.onset === 'ok') attackOk += 1;
      if (row.ending === 'ok') endOk += 1;
      if (row.pitchOk !== null && row.pitchOk !== undefined) {
        pitchChecked += 1;
        if (row.pitchOk) pitchOk += 1;
      }
    } else if (row.kind === 'missed') {
      missed += 1;
    } else if (row.kind === 'extra') {
      extra += 1;
    } else if (row.kind === 'free') {
      free += 1;
      if (row.onset === 'ok') attackOk += 1;
    }
  }

  const mode = result.mode ?? 'strict';
  const goal = result.goal ?? 'duration';
  const stats = result.stats ?? null;
  const expected = matched + missed;
  const advice = [];
  if (mode === 'free') {
    if (free === 0) {
      advice.push('Nenhum toque registrado. Toque livremente sobre o pulso; os ataques serão comparados com a subdivisão mais próxima.');
    } else {
      advice.push(`${attackOk} de ${free} ataques ficaram dentro de ±${ms(result.toleranceMs)} da subdivisão mais próxima.`);
      if (stats?.onset.medianMs !== null && Math.abs(stats.onset.medianMs) > result.toleranceMs) {
        advice.push(`Seus ataques tendem a cair ${ms(stats.onset.medianMs)} ${stats.onset.medianMs > 0 ? 'depois' : 'antes'} da grade; se não for intencional, ouça o metrônomo e ajuste.`);
      }
    }
  } else if (expected === 0) {
    advice.push('Adicione notas à frase (ou ao trecho do loop) para ter uma referência, ouça essa referência e conte as subdivisões antes de tocar.');
  } else if (matched === 0) {
    advice.push('Ouça a referência e conte as subdivisões em voz alta antes de tentar tocar novamente.');
  } else {
    if (attackOk < matched) {
      advice.push(mode === 'style'
        ? 'Alguns ataques variaram em relação ao seu próprio pulso; busque consistência nas posições, mesmo mantendo seu deslocamento.'
        : 'Conte as subdivisões em voz alta e pratique pressionar nos ataques da referência.');
    }
    if (goal !== 'timing' && endOk < matched) {
      advice.push('Pratique os limites de cada nota: pressione no início e solte no término indicado pela referência.');
    }
    if (goal === 'pitch' && pitchChecked > 0 && pitchOk < pitchChecked) {
      advice.push(`${pitchChecked - pitchOk} nota(s) tocada(s) com altura diferente da referência; toque a frase devagar conferindo cada altura.`);
    }
    if (mode === 'style' && stats?.feelMs !== null && Math.abs(stats.feelMs) > result.toleranceMs) {
      advice.push(`Seu pulso ficou consistentemente ${ms(stats.feelMs)} ${stats.feelMs > 0 ? 'atrás' : 'à frente'} da grade; no modo estilo isso é tratado como escolha, não como erro.`);
    }
    if (matched === expected && attackOk === matched && (goal === 'timing' || endOk === matched)) {
      advice.push('Os ataques' + (goal === 'timing' ? '' : ' e términos') + ' das notas esperadas ficaram dentro da tolerância; mantenha essa coordenação e repita a frase.');
    }
  }
  if (stats?.driftMsPerRepetition !== null && stats?.driftMsPerRepetition !== undefined && Math.abs(stats.driftMsPerRepetition) > result.toleranceMs / 2) {
    advice.push(`Ao longo das repetições os ataques ${stats.driftMsPerRepetition > 0 ? 'atrasaram' : 'adiantaram'} cerca de ${ms(stats.driftMsPerRepetition)} por repetição.`);
  }
  if (missed > 0 || extra > 0) {
    advice.push('Notas sem correspondência ou tentativas extras podem resultar de ataques fora da janela de correspondência; compare com a referência antes de repetir.');
  }

  return {
    expected, matched, missed, extra, attackOk, endOk,
    pitchChecked, pitchOk: pitchChecked > 0 ? pitchOk : null, free, mode, goal, stats, advice,
  };
}

// Sugestão de andamento para o próximo treino a partir de evidências objetivas.
// Sobe training.tempoStep quando todos os ataques casaram dentro da tolerância
// (ou 90% no modo livre), desce quando menos de 60% casaram; caso contrário mantém.
export function suggestTempo(session, summary) {
  const { bpm } = session;
  const step = session.training.tempoStep;
  const clamp = value => Math.min(300, Math.max(30, value));
  if (summary.mode === 'free') {
    if (summary.free === 0) return { bpm, change: 0, reason: 'Sem toques registrados; andamento mantido.' };
    const ratio = summary.attackOk / summary.free;
    if (ratio >= 0.9) return { bpm: clamp(bpm + step), change: 1, reason: `${Math.round(ratio * 100)}% dos ataques na grade; tente ${clamp(bpm + step)} BPM.` };
    if (ratio < 0.6) return { bpm: clamp(bpm - step), change: -1, reason: `${Math.round(ratio * 100)}% dos ataques na grade; reduza para ${clamp(bpm - step)} BPM.` };
    return { bpm, change: 0, reason: 'Resultado intermediário; repita no mesmo andamento.' };
  }
  if (summary.expected === 0) return { bpm, change: 0, reason: 'A frase não tem notas no trecho avaliado; andamento mantido.' };
  const matchedRatio = summary.matched / summary.expected;
  if (summary.matched === summary.expected && summary.attackOk === summary.matched && summary.extra === 0) {
    return { bpm: clamp(bpm + step), change: 1, reason: `Todos os ataques casaram dentro da tolerância; tente ${clamp(bpm + step)} BPM.` };
  }
  if (matchedRatio < 0.6) {
    return { bpm: clamp(bpm - step), change: -1, reason: `${Math.round(matchedRatio * 100)}% das notas casaram; reduza para ${clamp(bpm - step)} BPM.` };
  }
  return { bpm, change: 0, reason: 'Resultado intermediário; repita no mesmo andamento.' };
}
