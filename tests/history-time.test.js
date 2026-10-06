// Tempo real do Percurso: união de intervalos, fronteiras de dia LOCAL (com
// DST), janela de 28 datas e agrupamento por instrumento. Nenhuma asserção de
// DOM, string de path ou fiação: só comportamento determinístico.
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WINDOW_DAYS,
  addLocalDays,
  buildIntervals,
  dailyTotals,
  instrumentTotals,
  localDayKey,
  nextLocalMidnight,
  normalizeInterval,
  parseInstant,
  recentDayKeys,
  recordIntervals,
  sourceCounts,
  splitByLocalDays,
  startOfLocalDay,
  totalMs,
  unionIntervals,
} from '../src/history-time.js';

const HOUR = 3600000;

function at(text) { return Date.parse(text); }

test('união junta sobrepostos e encostados e mantém separados os distantes', () => {
  const spans = unionIntervals([
    { startMs: 0, endMs: HOUR },
    { startMs: HOUR / 2, endMs: 2 * HOUR },          // sobreposto
    { startMs: 2 * HOUR, endMs: 3 * HOUR },          // encostado
    { startMs: 5 * HOUR, endMs: 6 * HOUR },          // separado
  ]);
  assert.equal(spans.length, 2);
  assert.deepEqual([spans[0].startMs, spans[0].endMs], [0, 3 * HOUR]);
  assert.equal(spans[0].count, 3);
  assert.deepEqual([spans[1].startMs, spans[1].endMs], [5 * HOUR, 6 * HOUR]);
  assert.equal(totalMs([{ startMs: 0, endMs: HOUR }, { startMs: 0, endMs: HOUR }]), HOUR);
});

test('o mesmo treino em três fontes conta UMA vez, nunca três', () => {
  const start = at('2026-10-01T10:00:00-03:00');
  const intervals = buildIntervals({
    records: [{ id: 'rec', ownerId: 'ex-1', source: 'trainer', startedAt: new Date(start).toISOString(), endedAt: new Date(start + 30 * 60000).toISOString() }],
    activity: [
      { id: 'trainer', exerciseId: 'ex-1', instrument: 'guitar', source: 'trainer', startedAt: new Date(start).toISOString(), endedAt: new Date(start + 30 * 60000).toISOString() },
      { id: 'today', exerciseId: 'ex-1', instrument: 'guitar', source: 'today', startedAt: new Date(start + 10 * 60000).toISOString(), endedAt: new Date(start + 40 * 60000).toISOString() },
    ],
    resolveInstrument: id => (id === 'ex-1' ? 'guitar' : null),
  });
  assert.equal(intervals.length, 3);
  assert.equal(totalMs(intervals), 40 * 60000);
  assert.deepEqual(sourceCounts(intervals), { trainer: 1, today: 1, record: 1, unknown: 0 });
});

test('intervalos inválidos não ganham duração inventada e são descartados', () => {
  const valid = { id: 'a', startedAt: '2026-10-01T10:00:00-03:00', endedAt: '2026-10-01T10:30:00-03:00' };
  assert.equal(normalizeInterval({ ...valid, startedAt: '' }), null);
  assert.equal(normalizeInterval({ ...valid, endedAt: 'ontem' }), null);
  assert.equal(normalizeInterval({ ...valid, endedAt: valid.startedAt }), null, 'duração zero não vira intervalo');
  assert.equal(normalizeInterval({ ...valid, startedAt: null, endedAt: null }), null);
  assert.equal(normalizeInterval({ id: 'sem-tempo' }), null);
  assert.equal(normalizeInterval(valid).ms, 30 * 60000);
  assert.equal(parseInstant('2026-10-01T10:00:00-03:00'), at('2026-10-01T10:00:00-03:00'));
  assert.equal(parseInstant('x'), null);
  const spans = unionIntervals([valid, { id: 'b' }, { id: 'c', startedAt: 'nao-e-data', endedAt: '2026-10-01T11:00:00-03:00' }]);
  assert.equal(spans.length, 1);
  assert.equal(totalMs([valid, { id: 'b' }]), 30 * 60000);
});

test('um intervalo que atravessa a meia-noite local vira dois dias', () => {
  const start = at('2026-10-01T23:30:00-04:00');
  const end = at('2026-10-02T00:45:00-04:00');
  const pieces = splitByLocalDays(start, end);
  assert.deepEqual(pieces.map(piece => piece.dayKey), ['2026-10-01', '2026-10-02']);
  assert.equal(pieces[0].ms, 30 * 60000);
  assert.equal(pieces[1].ms, 45 * 60000);
  assert.equal(pieces.reduce((sum, piece) => sum + piece.ms, 0), end - start);
});

test('virada de horário de verão: dia local de 23 h é um único dia', () => {
  const start = startOfLocalDay(at('2026-03-08T12:00:00-05:00'));
  const end = nextLocalMidnight(start);
  assert.equal(end - start, 23 * HOUR, 'primavera tem 23 h, não 24 h');
  const pieces = splitByLocalDays(start, end);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].dayKey, '2026-03-08');
  assert.equal(pieces[0].ms, 23 * HOUR);
  const totals = dailyTotals([{ startMs: start, endMs: end }], { days: 3, now: at('2026-03-08T20:00:00-04:00') });
  assert.equal(totals.totalMs, 23 * HOUR);
  assert.equal(totals.byDay.at(-1).dayKey, '2026-03-08');
});

test('virada de horário de verão: dia local de 25 h também é um único dia', () => {
  const start = startOfLocalDay(at('2026-11-01T12:00:00-04:00'));
  const end = nextLocalMidnight(start);
  assert.equal(end - start, 25 * HOUR, 'outono tem 25 h, não 24 h');
  const totals = dailyTotals([{ startMs: start, endMs: end }], { days: 2, now: at('2026-11-01T20:00:00-05:00') });
  assert.equal(totals.totalMs, 25 * HOUR);
  assert.deepEqual(totals.byDay.map(row => row.dayKey), ['2026-10-31', '2026-11-01']);
  assert.equal(totals.byDay[0].ms, 0);
});

test('intervalo entre dias DST soma horas reais, sem presumir 24 h', () => {
  const start = at('2026-03-07T22:00:00-05:00');
  const end = at('2026-03-08T04:00:00-04:00');
  const pieces = splitByLocalDays(start, end);
  assert.deepEqual(pieces.map(piece => piece.dayKey), ['2026-03-07', '2026-03-08']);
  assert.equal(pieces[0].ms, 2 * HOUR);
  assert.equal(pieces[1].ms, 3 * HOUR);
  assert.deepEqual(recentDayKeys(2, at('2026-03-08T10:00:00-04:00')), ['2026-03-07', '2026-03-08']);
});

test('janela de 28 datas locais termina hoje e corta o excesso', () => {
  const now = at('2026-10-28T15:00:00-04:00');
  const keys = recentDayKeys(WINDOW_DAYS, now);
  assert.equal(keys.length, 28);
  assert.equal(keys.at(-1), '2026-10-28');
  assert.equal(keys[0], '2026-10-01');
  const inside = { startMs: at('2026-10-27T20:00:00-04:00'), endMs: at('2026-10-27T21:00:00-04:00') };
  const before = { startMs: at('2026-09-29T20:00:00-04:00'), endMs: at('2026-09-29T21:00:00-04:00') };
  const crossing = { startMs: at('2026-09-30T23:00:00-04:00'), endMs: at('2026-10-01T01:00:00-04:00') };
  const totals = dailyTotals([inside, before, crossing], { days: WINDOW_DAYS, now });
  assert.equal(totals.byDay.length, 28);
  assert.equal(totals.byDay.find(row => row.dayKey === '2026-10-27').ms, HOUR);
  assert.equal(totals.byDay[0].dayKey, '2026-10-01');
  assert.equal(totals.byDay[0].ms, HOUR, 'só a parte dentro da janela conta');
  assert.equal(totals.totalMs, 2 * HOUR);
  assert.equal(totals.practicedDays, 2);
  assert.equal(addLocalDays(startOfLocalDay(now), 1), nextLocalMidnight(now));
  assert.equal(localDayKey(now), '2026-10-28');
});

test('totais por instrumento usam a união de cada categoria e nunca chutam', () => {
  const totals = instrumentTotals([
    { id: 'g1', instrument: 'guitar', startMs: 0, endMs: HOUR },
    { id: 'g2', instrument: 'guitar', startMs: 30 * 60000, endMs: 2 * HOUR },
    { id: 'b1', instrument: 'bass', startMs: HOUR, endMs: 90 * 60000 },
    { id: 'x1', instrument: null, startMs: 4 * HOUR, endMs: 5 * HOUR },
  ]);
  assert.equal(totals.guitar.ms, 2 * HOUR, 'sobreposição de guitarra conta uma vez');
  assert.equal(totals.bass.ms, 30 * 60000);
  assert.equal(totals.unknown.ms, HOUR);
  assert.equal(totals.unknown.spans, 1);
});

test('registros avaliados da biblioteca entram pelo intervalo e herdam o instrumento dono', () => {
  const library = {
    list: () => [{ id: 'ex-1' }, { id: 'ex-2' }],
    records: id => (id === 'ex-1'
      ? [
        { id: 'r1', ownerId: 'ex-1', source: 'authored', startedAt: '2026-10-01T10:00:00-03:00', endedAt: '2026-10-01T10:20:00-03:00' },
        { id: 'r2', ownerId: 'ex-1', source: 'authored', startedAt: null, endedAt: null, durationMs: 600000 },
      ]
      : []),
  };
  const records = recordIntervals(library);
  assert.equal(records.length, 2);
  const intervals = buildIntervals({ records, resolveInstrument: id => (id === 'ex-1' ? 'bass' : null) });
  assert.equal(intervals.length, 1, 'registro sem intervalo não inventa duração (durationMs não é intervalo)');
  assert.equal(intervals[0].instrument, 'bass');
  assert.equal(intervals[0].source, 'record');
  assert.equal(instrumentTotals(intervals).bass.ms, 20 * 60000);
  assert.deepEqual(sourceCounts(intervals), { trainer: 0, today: 0, record: 1, unknown: 0 });
});

test('registro com ownerId histórico (importado) segue o exercício do contêiner', () => {
  const intervals = buildIntervals({
    records: [{
      id: 'r', exerciseId: 'novo', ownerId: 'antigo',
      startedAt: '2026-10-01T10:00:00-04:00', endedAt: '2026-10-01T10:10:00-04:00',
    }],
    resolveInstrument: id => (id === 'novo' ? 'bass' : id === 'antigo' ? 'guitar' : null),
  });
  assert.equal(intervals[0].instrument, 'bass', 'o contêiner manda, não o dono histórico');
  assert.equal(intervals[0].exerciseId, 'novo');
  assert.equal(intervals[0].ownerId, 'antigo', 'o dono histórico continua registrado no intervalo');
});

test('activity sem startedAt/endedAt válidos é ignorada sem quebrar a leitura', () => {
  const intervals = buildIntervals({
    activity: [
      { id: 'ok', instrument: 'guitar', source: 'today', startedAt: '2026-10-01T10:00:00-03:00', endedAt: '2026-10-01T10:10:00-03:00' },
      { id: 'quebrado', instrument: 'guitar', source: 'today', startedAt: 'nada', endedAt: 'nada' },
      null,
    ],
  });
  assert.equal(intervals.length, 1);
  assert.equal(totalMs(intervals), 10 * 60000);
  assert.equal(unionIntervals([null, undefined, 3]).length, 0);
});
