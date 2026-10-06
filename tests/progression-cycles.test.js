// Ciclos pelos 12 tons (etapa 3) e a leitura "Agora · Próximo": ordem exata,
// tamanho com acorde final de UM compasso, tríades maior/menor/aumentada/
// diminuta, ajuste da sessão no mesmo fluxo das progressões prontas e o próximo
// acorde no fim de um loop parcial ou total. Sem DOM, sem redação.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, ticksPerBar, sessionTicks } from '../src/session.js';
import { MAX_BARS, completeNote } from '../src/model.js';
import { parseChordSymbol, chordTimeline, chordNowNext } from '../src/progression.js';
import {
  CYCLE_ORDERS, CYCLE_TRIADS, CYCLE_BARS_PER_CHORD, cycleOrderId, findCycleOrder, cycleProgression,
  cyclePresetLabel, namedProgression, namedProgressionPatch,
} from '../src/studio-progressions.js';

const MILLISECOND = 1e-6;
const order = id => CYCLE_ORDERS.find(value => value.id === id);
const pitchClasses = roots => roots.map(root => parseChordSymbol(root).root);
const chord = (symbol, startBar, durationBars) => ({ ...parseChordSymbol(symbol), startBar, durationBars });
const cycle = (id, options) => cycleProgression('c-major', cycleOrderId(id), options);

test('os três ciclos trazem os 12 tons nas ordens exatas', () => {
  assert.deepEqual(CYCLE_ORDERS.map(value => value.id), ['fourths', 'fifths', 'chromatic']);
  assert.deepEqual(order('fourths').roots, ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'B', 'E', 'A', 'D', 'G']);

  const fourths = pitchClasses(order('fourths').roots);
  for (const [index, pitch] of fourths.entries()) assert.equal(pitch, (index * 5) % 12, 'cada passo do ciclo de quartas sobe cinco semitons');

  // Quintas é o inverso do ciclo de quartas começando em C: a mesma sequência de
  // classes de altura, lida para trás.
  const reversed = [...fourths].reverse();
  assert.deepEqual(pitchClasses(order('fifths').roots), [reversed.at(-1), ...reversed.slice(0, -1)]);
  for (const [index, pitch] of pitchClasses(order('fifths').roots).entries()) assert.equal(pitch, (index * 7) % 12, 'cada passo do ciclo de quintas sobe sete semitons');

  // Cromática ascendente: doze classes distintas, uma por semitom.
  assert.deepEqual(pitchClasses(order('chromatic').roots), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  for (const roots of CYCLE_ORDERS.map(value => value.roots)) assert.equal(new Set(roots).size, 12, 'nenhum ciclo repete grafia');
  assert.equal(findCycleOrder('cycle-ninth'), null);
  assert.equal(findCycleOrder('blues-major'), null);
});

test('as quatro tríades mantêm cifra, qualidade e intervalos exatos', () => {
  assert.deepEqual(CYCLE_BARS_PER_CHORD, [1, 2]);
  assert.deepEqual(CYCLE_TRIADS.map(value => [value.id, value.quality]), [['major', ''], ['minor', 'm'], ['augmented', 'aug'], ['diminished', 'dim']]);
  const intervals = { major: [0, 4, 7], minor: [0, 3, 7], augmented: [0, 4, 8], diminished: [0, 3, 6] };
  for (const triad of CYCLE_TRIADS) {
    const { chords } = cycle('fourths', { triad: triad.id });
    assert.equal(chords.length, 13);
    for (const [index, symbol] of order('fourths').roots.entries()) {
      assert.equal(chords[index].symbol, `${symbol}${triad.quality}`, 'a cifra é a fundamental do ciclo com a qualidade escolhida');
      assert.equal(chords[index].quality, triad.quality);
      assert.deepEqual(chords[index].notes.map(note => note.midi % 12), intervals[triad.id].map(step => (chords[index].root + step) % 12));
    }
  }
});

test('dois compassos por acorde resultam em 25 com o primeiro repetido em um compasso', () => {
  const progression = cycle('fourths', { triad: 'major', barsPerChord: 2 });
  assert.equal(progression.cycleBars, 25);
  assert.equal(progression.chords.length, 13);
  assert.equal(progression.enabled, true);
  assert.equal(progression.keyId, 'c-major');
  for (const [index, value] of progression.chords.entries()) {
    const last = index === 12;
    assert.equal(value.startBar, last ? 24 : index * 2);
    assert.equal(value.durationBars, last ? 1 : 2);
    assert.ok(value.startBar + value.durationBars <= progression.cycleBars, 'nada passa do ciclo');
  }
  assert.equal(progression.chords.at(-1).symbol, 'C');
  assert.deepEqual(progression.chords.at(-1), { ...progression.chords[0], startBar: 24, durationBars: 1 }, 'o acorde final é o primeiro, em UM compasso');
});

test('sem acorde final o ciclo tem 12 ou 24 compassos', () => {
  const two = cycle('fifths', { barsPerChord: 2, repeatFirst: false });
  assert.equal(two.cycleBars, 24); assert.equal(two.chords.length, 12);
  assert.ok(two.chords.every(value => value.durationBars === 2));
  assert.equal(two.chords.at(-1).startBar, 22);
  const one = cycle('chromatic', { repeatFirst: false });
  assert.equal(one.cycleBars, 12); assert.equal(one.chords.length, 12);
  const repeating = cycle('chromatic');
  assert.equal(repeating.cycleBars, 13);
  assert.deepEqual(repeating.chords.at(-1), { ...repeating.chords[0], startBar: 12, durationBars: 1 }, 'o padrão repete o primeiro em UM compasso');
  assert.deepEqual(repeating.chords.slice(0, 12).map(value => value.symbol), ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']);
});

test('ciclo recusa ordem, tríade, compassos e repetição fora do previsto', () => {
  assert.throws(() => cycle('blues-major'), /ciclos pelos 12 tons/);
  assert.throws(() => cycle('fourths', { triad: 'maj7' }), /tríade/);
  assert.throws(() => cycle('fourths', { barsPerChord: 3 }), /1 ou 2 compassos/);
  assert.throws(() => cycle('fourths', { repeatFirst: 'sim' }), /sim ou não/);
  assert.throws(() => namedProgression('cycle-fourths', 'dó maior'), /tonalidades/);
});

test('o tamanho do ciclo fica legível antes de aplicar', () => {
  assert.equal(cyclePresetLabel('cycle-fourths', { barsPerChord: 2 }), 'Quartas · tríades maior · 2 compassos por acorde + o primeiro repetido em 1 compasso = 25 compassos');
  assert.equal(cyclePresetLabel('cycle-fifths', { triad: 'diminished', barsPerChord: 2, repeatFirst: false }), 'Quintas (inverso) · tríades diminuta · 2 compassos por acorde, sem acorde final = 24 compassos');
  assert.equal(cyclePresetLabel('cycle-chromatic', {}), 'Cromática ascendente · tríades maior · 1 compasso por acorde + o primeiro repetido em 1 compasso = 13 compassos');
  assert.throws(() => cyclePresetLabel('blues-major'), /ciclos pelos 12 tons/);
});

test('o ciclo mantém a tonalidade da sessão e ajusta o tamanho como o blues de 12', () => {
  const session = createSession({
    bars: 4, loop: { startBar: 1, endBar: 4 },
    notes: [completeNote({ id: 'kept', start: 4, duration: 2, pitch: 52 })],
    drums: { edits: [{ voice: 'kick', start: 2, velocity: null }] },
    form: { sections: [{ id: 'a', name: 'A', startBar: 0, endBar: 4, repeats: 1, kind: 'A' }] },
  });
  const before = structuredClone(session);
  assert.ok(namedProgressionPatch(session, 'cycle-fourths', 'exact').error, 'tamanho diferente exige decisão explícita');
  const preflight = namedProgressionPatch(session, 'cycle-fourths', 'resize');
  assert.ok(preflight.patch, preflight.error);
  assert.equal(preflight.patch.bars, 13);
  assert.deepEqual(preflight.patch.loop, { startBar: 1, endBar: 13 });
  const next = createSession({ ...session, ...preflight.patch });
  assert.equal(next.progression.keyId, session.progression.keyId);
  assert.equal(next.progression.cycleBars, 13);
  assert.deepEqual(next.progression.chords.map(value => value.symbol), ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'B', 'E', 'A', 'D', 'G', 'C']);
  assert.deepEqual(next.notes, session.notes);
  assert.deepEqual(next.drums, session.drums);
  assert.deepEqual(next.form, session.form);
  assert.deepEqual(session, before, 'o preflight não altera a sessão');

  const exact = namedProgressionPatch(next, 'cycle-fourths', 'exact');
  assert.ok(exact.patch); assert.equal(exact.patch.progression.cycleBars, 13);
});

test('o ciclo de dois compassos ajusta a sessão para 25 quando ela admite 25 compassos', () => {
  // A etapa 2 eleva o teto de compassos da sessão; até lá o preflight recusa e
  // nada é alterado. Este teste registra os dois lados sem forjar o sucesso.
  const session = createSession({ bars: 4, loop: { startBar: 0, endBar: 4 } });
  const preflight = namedProgressionPatch(session, 'cycle-fourths', 'resize', { triad: 'minor', barsPerChord: 2 });
  if (MAX_BARS < 25) {
    assert.match(preflight.error, /Nenhum dado foi alterado/);
    assert.equal(preflight.patch, undefined);
    return;
  }
  assert.equal(preflight.patch.bars, 25);
  const next = createSession({ ...session, ...preflight.patch });
  assert.equal(next.progression.chords.length, 13);
  assert.ok(next.progression.chords.every(value => value.symbol.endsWith('m')));
  assert.equal(next.progression.chords.at(-1).durationBars, 1);
  assert.equal(chordTimeline(next).length, 13, 'o ciclo inteiro cabe na sessão ajustada');
});

test('repetir/cortar só a harmonia recorta o ciclo sem passar do tamanho da sessão', () => {
  const session = createSession({ bars: 9, loop: { startBar: 0, endBar: 9 } });
  const cut = namedProgressionPatch(session, 'cycle-fourths', 'repeat-cut', { barsPerChord: 2 });
  assert.equal(cut.patch.progression.cycleBars, 9);
  assert.equal(cut.patch.progression.chords.length, 5, 'o exercício corta o ciclo no próprio limite');
  assert.ok(cut.patch.progression.chords.every((value, index, all) => value.startBar + value.durationBars <= 9
    && (index === 0 || value.startBar >= all[index - 1].startBar + all[index - 1].durationBars)));
});

test('Agora · Próximo seguem o ciclo e trocam no início de cada compasso', () => {
  const session = createSession({ bars: 13, loop: { startBar: 0, endBar: 13 }, progression: cycle('fourths') });
  const measure = ticksPerBar(session);
  const symbols = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'B', 'E', 'A', 'D', 'G', 'C'];
  for (let bar = 0; bar < 13; bar++) {
    for (const offset of [0, measure / 2, measure - MILLISECOND]) {
      const value = chordNowNext(session, bar * measure + offset);
      assert.equal(value.current.chord.symbol, symbols[bar], `compasso ${bar + 1}`);
      assert.equal(value.next.chord.symbol, symbols[bar + 1] ?? symbols[0]);
      assert.equal(value.current.start, bar * measure);
    }
  }
  // Fim do loop inteiro: o próximo é o primeiro acorde outra vez.
  const end = chordNowNext(session, sessionTicks(session) - MILLISECOND);
  assert.equal(end.current.chord.symbol, 'C');
  assert.equal(end.next.chord.symbol, 'C');
  assert.equal(end.next.start, 0);
});

test('no fim de um loop parcial o próximo é o primeiro acorde do loop', () => {
  const session = createSession({ bars: 13, loop: { startBar: 2, endBar: 5 }, progression: cycle('fifths', { barsPerChord: 2 }) });
  const measure = ticksPerBar(session);
  assert.equal(chordNowNext(session, 2 * measure).current.chord.symbol, 'G', 'o loop começa no segundo acorde');
  assert.equal(chordNowNext(session, 2 * measure).next.chord.symbol, 'D');
  const last = chordNowNext(session, 4 * measure + measure / 2);
  assert.equal(last.current.chord.symbol, 'D');
  assert.equal(last.next.chord.symbol, 'G', 'volta ao primeiro acorde do loop');
  assert.equal(last.next.start, 2 * measure);
  // Fora do loop (parado, ou ouvindo a sessão toda) a leitura segue a sessão.
  assert.equal(chordNowNext(session, 0).current.chord.symbol, 'C');
  assert.equal(chordNowNext(session, 8 * measure).current.chord.symbol, 'E');
});

test('pausas harmônicas e progressão desligada são honestas', () => {
  const gap = createSession({ bars: 4, loop: { startBar: 0, endBar: 4 }, progression: { keyId: 'c-major', enabled: true, cycleBars: 4, chords: [chord('C', 0, 1), chord('F', 2, 1)] } });
  const measure = ticksPerBar(gap);
  const middle = chordNowNext(gap, 1.5 * measure);
  assert.equal(middle.current, null, 'não há acorde soando no silêncio');
  assert.equal(middle.next.chord.symbol, 'F');
  const tail = chordNowNext(gap, 3.5 * measure);
  assert.equal(tail.current, null);
  assert.equal(tail.next.chord.symbol, 'C', 'o próximo volta ao primeiro no fim do loop');
  assert.equal(chordNowNext(createSession({ bars: 4 }), 0), null);
  assert.equal(chordNowNext(createSession({ bars: 4, progression: { enabled: false, chords: [chord('C', 0, 1)], cycleBars: 1 } }), 0), null);
});
