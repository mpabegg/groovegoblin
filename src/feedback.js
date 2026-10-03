// Avaliacao de uma tentativa de execucao contra a frase, repetida 4x em uma
// timeline continua (sem particionar por compasso). A frase pode ter 1, 2 ou
// 4 compassos (bars): a repeticao N comeca em (N-1)*bars*barSeconds segundos.
// Formulas (bpm e por tempo/quarter note, compasso 4/4 com 16 ticks de
// semicolcheia):
//   tickSeconds       = (60 / bpm) / 4   -- 1 tick = 1/4 de tempo
//   barSeconds        = 16 * tickSeconds -- duracao de um compasso 4/4
//   repetitionSeconds = bars * barSeconds
//   tickMs       = tickSeconds * 1000
//   matchWindowMs = tickMs / 2         -- raio de busca para decidir SE uma
//                                         tentativa pertence a uma nota esperada
//   toleranceMs   = matchWindowMs / 2  -- dentro disso => 'ok'; fora (mas
//                                         ainda dentro da matchWindow) => 'early'/'late'
//
// Por que janela = meio tick: pelas regras do modelo (sem sobreposicao,
// duracao minima 1 tick), o espacamento MINIMO entre dois onsets esperados
// quaisquer na frase -- inclusive atravessando a fronteira entre repeticoes
// (fim de uma nota em end=16 seguido do inicio tick=0 da proxima repeticao)
// -- e sempre >= 1 tick. Usar meio tick de raio para cada nota esperada
// garante que as janelas de busca de notas vizinhas nunca se sobrepoem,
// mesmo no caso mais apertado (duas notas de 1 tick adjacentes) e mesmo
// quando essa adjacencia cruza a fronteira de compasso. Isso permite que o
// matching seja global/continuo (ignorando onde cada compasso "termina")
// sem ambiguidade de a qual repeticao uma tentativa pertence.
//
// Ambiguidades conhecidas (tradeoff documentado):
// - A janela/tolerancia escalam com o tick (relativas ao bpm), nao sao um
//   valor absoluto fixo. Em bpm alto (ate 240) a janela fica bem estreita
//   (ex.: bpm=240 -> tick=62.5ms -> matchWindow=31.25ms), exigindo precisao
//   humana alta; em bpm baixo (ate 40) a janela fica larga (tick=375ms ->
//   matchWindow=187.5ms), tolerando mais imprecisao. Isso e intencional:
//   a nocao de "no tempo" e relativa a grade de quantizacao, nao ao relogio.
// - O matching usa SOMENTE o onset (start) da tentativa para decidir se ela
//   corresponde a uma nota esperada, avanca ou e sobra; a duracao/fim NUNCA
//   e usada para essa decisao (para nao "corrigir" uma nota deslocada so
//   porque sua duracao bateu). Fim e onset sao sempre classificados de forma
//   independente, com base nos tempos absolutos esperados vs. reais.
// - Para uma tentativa 'extra' (sem nota esperada correspondente), a
//   repeticao reportada e estimada pela posicao absoluta do onset dentro das
//   4 janelas de repeticao (floor(start / repetitionSeconds) + 1, limitada a
//   1..4); e uma heuristica de exibicao, nao participa da decisao de matching.

import { TICKS_PER_BAR, DEFAULT_BARS } from './model.js';

export const REPETITIONS = 4;

function classify(diffMs, toleranceMs) {
  if (diffMs < -toleranceMs) return 'early';
  if (diffMs > toleranceMs) return 'late';
  return 'ok';
}

function extraRepetition(start, repetitionSeconds) {
  const rep = Math.floor(start / repetitionSeconds) + 1;
  return Math.min(REPETITIONS, Math.max(1, rep));
}

export function evaluate(notes, attempts, bpm, bars = DEFAULT_BARS) {
  const tickSeconds = (60 / bpm) / 4;
  const barSeconds = TICKS_PER_BAR * tickSeconds;
  const repetitionSeconds = bars * barSeconds;
  const tickMs = tickSeconds * 1000;
  const matchWindowMs = tickMs / 2;
  const toleranceMs = matchWindowMs / 2;

  const phrase = [...notes].sort((a, b) => a.start - b.start);

  const expected = [];
  for (let rep = 1; rep <= REPETITIONS; rep += 1) {
    const offset = (rep - 1) * repetitionSeconds;
    for (const note of phrase) {
      expected.push({
        noteId: note.id,
        repetition: rep,
        expectedStart: offset + note.start * tickSeconds,
        expectedEnd: offset + (note.start + note.duration) * tickSeconds,
      });
    }
  }

  const actual = [...attempts].sort((a, b) => a.start - b.start);

  const rows = [];
  let i = 0;
  let j = 0;
  while (i < expected.length && j < actual.length) {
    const exp = expected[i];
    const att = actual[j];
    const onsetMs = (att.start - exp.expectedStart) * 1000;

    if (onsetMs < -matchWindowMs) {
      rows.push({
        kind: 'extra',
        repetition: extraRepetition(att.start, repetitionSeconds),
        actualStart: att.start,
        actualEnd: att.end,
      });
      j += 1;
    } else if (onsetMs > matchWindowMs) {
      rows.push({
        kind: 'missed',
        repetition: exp.repetition,
        noteId: exp.noteId,
        expectedStart: exp.expectedStart,
        expectedEnd: exp.expectedEnd,
      });
      i += 1;
    } else {
      const endMs = (att.end - exp.expectedEnd) * 1000;
      rows.push({
        kind: 'matched',
        repetition: exp.repetition,
        noteId: exp.noteId,
        expectedStart: exp.expectedStart,
        expectedEnd: exp.expectedEnd,
        actualStart: att.start,
        actualEnd: att.end,
        onsetMs,
        endMs,
        onset: classify(onsetMs, toleranceMs),
        ending: classify(endMs, toleranceMs),
      });
      i += 1;
      j += 1;
    }
  }

  while (i < expected.length) {
    const exp = expected[i];
    rows.push({
      kind: 'missed',
      repetition: exp.repetition,
      noteId: exp.noteId,
      expectedStart: exp.expectedStart,
      expectedEnd: exp.expectedEnd,
    });
    i += 1;
  }

  while (j < actual.length) {
    const att = actual[j];
    rows.push({
      kind: 'extra',
      repetition: extraRepetition(att.start, repetitionSeconds),
      actualStart: att.start,
      actualEnd: att.end,
    });
    j += 1;
  }

  return { rows, toleranceMs, matchWindowMs };
}

export function summarizeFeedback(result) {
  let matched = 0;
  let missed = 0;
  let extra = 0;
  let attackOk = 0;
  let endOk = 0;
  for (const row of result.rows) {
    if (row.kind === 'matched') {
      matched += 1;
      if (row.onset === 'ok') attackOk += 1;
      if (row.ending === 'ok') endOk += 1;
    } else if (row.kind === 'missed') {
      missed += 1;
    } else if (row.kind === 'extra') {
      extra += 1;
    }
  }

  const expected = matched + missed;
  const advice = [];
  if (expected === 0) {
    advice.push('Adicione notas à frase para ter uma referência, ouça essa referência e conte as subdivisões antes de tocar.');
  } else if (matched === 0) {
    advice.push('Ouça a referência e conte as subdivisões em voz alta antes de tentar tocar novamente.');
  } else {
    if (attackOk < matched) {
      advice.push('Conte as subdivisões em voz alta e pratique pressionar nos ataques da referência.');
    }
    if (endOk < matched) {
      advice.push('Pratique os limites de cada nota: pressione no início e solte no término indicado pela referência.');
    }
    if (matched === expected && attackOk === matched && endOk === matched) {
      advice.push('Os ataques e términos das notas esperadas ficaram dentro da tolerância; mantenha essa coordenação e repita a frase.');
    }
  }
  if (missed > 0 || extra > 0) {
    advice.push('Notas sem correspondência ou tentativas extras podem resultar de ataques fora da janela de correspondência; compare com a referência antes de repetir.');
  }

  return { expected, matched, missed, extra, attackOk, endOk, advice };
}
