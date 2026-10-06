// A4 — Testes do adaptador de sessão do estudo: o que o exercício criado é
// (sessão v5 válida, banda desligada, perfil do pedido, harmonia para
// Agora/Próximo) e onde a receita NÃO está (fora da sessão).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_KEYS } from '../src/model.js';
import { SESSION_NAME_MAX, parseSession, serializeSession } from '../src/session.js';
import { chordNowNext } from '../src/progression.js';
import { buildRhythmNotation } from '../src/notation.js';
import { STUDY_MAX_NOTES, defaultRecipe, generateStudy } from '../src/study-generator.js';
import { previewSession, progressionFromResult, studyExercise } from '../src/study-session.js';
import { presetRecipe, recipeTitle } from '../src/study-recipe.js';

const bass4 = { type: 'bass', strings: 4 };
const bass5 = { type: 'bass', strings: 5 };
// 25 compassos em quartas maiores, arpejo de 2 compassos na região 1..5: o
// exemplo conferido à mão no A2 (12 acordes, 24 compassos de ciclo, 37 notas).
const quartas = (overrides = {}) => defaultRecipe({
  family: 'arpejo_triade_forma_unica', profile: bass4,
  progression: { kind: 'quartas', quality: 'major' },
  bars: 25, region: { from: 1, to: 5, open: false },
  figure: { degrees: [1, 3, 5], bars: 2, order: 'sobe' },
  rhythm: 'arpejo', voltas: 1, final: 'acorde',
  ...overrides,
});
const CYCLE_ROOTS = [0, 5, 10, 3, 8, 1, 6, 11, 4, 9, 2, 7];

test('o exercício é uma sessão v5 válida: compassos reais, notas canônicas, banda desligada e perfil do pedido', () => {
  const recipe = quartas();
  const result = generateStudy(recipe);
  const { session, name, study } = studyExercise(result, { profile: recipe.profile });
  assert.equal(session.bars, 25);
  assert.equal(session.bars, result.actualBars);
  assert.deepEqual(session.loop, { startBar: 0, endBar: 25 });
  assert.equal(session.notes.length, result.notes.length);
  assert.equal(session.notes.length, 37);
  for (const note of session.notes) {
    for (const key of Object.keys(note)) assert.ok(NOTE_KEYS.includes(key), `campo derivado na sessão: ${key}`);
    assert.equal(Object.hasOwn(note, 'fret'), false);
  }
  // A sessão atravessa o parser canônico sem perder nada (é um exercício comum).
  assert.deepEqual(parseSession(serializeSession(session)), JSON.parse(JSON.stringify(session)));
  // Banda OFF e sem bateria automática; treino normal disponível.
  assert.equal(session.band.bassEnabled, false);
  assert.equal(session.drums.enabled, false);
  assert.ok(session.training.repetitions >= 1);
  // Perfil do instrumento pedido, com a tabulação já aberta.
  assert.equal(session.extensions.studio.instrument.type, 'bass');
  assert.equal(session.extensions.studio.instrument.strings, 4);
  assert.deepEqual(session.extensions.studio.instrument.tuning, [28, 33, 38, 43]);
  assert.equal(session.extensions.studio.phraseView, 'tab');
  // A receita vive FORA da sessão.
  assert.equal(study.recipe.family, 'arpejo_triade_forma_unica');
  assert.equal(study.origin, null);
  assert.equal(study.group, null);
  assert.equal(Object.hasOwn(session.extensions.studio, 'recipe'), false);
  assert.equal(Object.hasOwn(session.extensions, 'study'), false);
  assert.equal(name, recipeTitle(recipe));
  assert.ok(name.length <= SESSION_NAME_MAX);
  assert.equal(session.name, name);
});

test('a progressão da sessão é uma volta do ciclo, com cifra e vozes por acorde', () => {
  const recipe = quartas();
  const result = generateStudy(recipe);
  const session = studyExercise(result, { profile: recipe.profile }).session;
  assert.equal(session.progression.enabled, true);
  assert.equal(session.progression.cycleBars, 24);
  assert.equal(session.progression.chords.length, 12);
  assert.deepEqual(session.progression.chords.map(chord => chord.root), CYCLE_ROOTS);
  session.progression.chords.forEach((chord, index) => {
    assert.equal(chord.startBar, index * 2, `início do acorde ${index}`);
    assert.equal(chord.durationBars, 2);
    assert.ok(chord.symbol.length > 0);
    assert.ok(chord.notes.length >= 1 && chord.notes.length <= 8);
    for (const note of chord.notes) {
      assert.ok(note.midi >= 0 && note.midi <= 127);
      assert.ok(note.name.length >= 1 && note.name.length <= 8);
    }
    assert.equal(noteNameOf(chord.notes, chord.root), true, `a fundamental está na voz do acorde ${chord.symbol}`);
  });
  assert.equal(session.progression.keyId, 'c-major');
  // "Agora · Próximo" acompanha a harmonia do estudo (treino normal).
  const now = chordNowNext(session, 0);
  assert.equal(now.current.chord.symbol, session.progression.chords[0].symbol);
  assert.equal(now.next.chord.symbol, session.progression.chords[1].symbol);
  assert.equal(chordNowNext(session, 20 * 16).current.chord.symbol, session.progression.chords[10].symbol);
  // Qualidade menor escolhe a tonalidade menor.
  const minor = studyExercise(generateStudy(quartas({ progression: { kind: 'quartas', quality: 'm7' } })), { profile: bass4 }).session;
  assert.match(minor.progression.keyId, /-minor$/);
});

function noteNameOf(notes, root) {
  return notes.some(note => note.midi % 12 === root);
}

test('presets de aceitação: 25 compassos no arpejo e 13 na linha contínua, com o final no PRIMEIRO acorde', () => {
  const arpejo = studyExercise(generateStudy(presetRecipe('arpejo-quartas')), { profile: bass4 });
  assert.equal(arpejo.session.bars, 25);
  assert.equal(arpejo.session.notes.length, 37);
  const finalNote = arpejo.session.notes[arpejo.session.notes.length - 1];
  assert.equal(finalNote.start, 24 * 16, 'a nota final ocupa o compasso 25');
  assert.equal(finalNote.pitch % 12, arpejo.session.progression.chords[0].root, 'a nota final é a tônica do primeiro acorde da progressão');
  assert.equal(arpejo.session.progression.chords.length, 12);
  assert.equal(arpejo.session.progression.cycleBars, 24);
  // Ritmo do arpejo: semínima, semínima e a terceira ligada (compasso + meio).
  assert.deepEqual(arpejo.session.notes.slice(0, 3).map(note => [note.start, note.duration]), [[0, 4], [4, 4], [8, 16]]);
  // Linha contínua na região 1–5: 13 compassos, 4 notas por acorde + final.
  const continuo = studyExercise(generateStudy(presetRecipe('continuo')), { profile: bass4 });
  assert.equal(continuo.session.bars, 13);
  assert.equal(continuo.session.progression.cycleBars, 12);
  assert.equal(continuo.session.notes.length, 49);
  assert.deepEqual(continuo.session.progression.chords.map(chord => chord.durationBars), new Array(12).fill(1));
  const firstFour = continuo.session.notes.slice(0, 4);
  assert.deepEqual(firstFour.map(note => note.start), [0, 4, 8, 12]);
  assert.ok(firstFour[0].pitch < firstFour[3].pitch, 'a linha começa subindo pela escada do acorde');
});

test('lista de acordes leva QUALIDADE POR ACORDE para a progressão', () => {
  const recipe = defaultRecipe({
    family: 'movimento_continuo_linha_4_notas', profile: bass4,
    progression: { kind: 'lista', quality: 'major', chords: [{ root: 0, quality: 'major' }, { root: 9, quality: 'minor' }, { root: 2, quality: 'minor' }, { root: 7, quality: '7' }] },
    figure: { notes: 4, order: 'sobe' }, rhythm: 'quarters', bars: null, voltas: 1, final: 'nenhum',
    region: { from: 1, to: 12, open: false },
  });
  const session = studyExercise(generateStudy(recipe), { profile: bass4 }).session;
  assert.deepEqual(session.progression.chords.map(chord => [chord.root, chord.quality]), [[0, ''], [9, 'm'], [2, 'm'], [7, '7']]);
  assert.deepEqual(session.progression.chords.map(chord => chord.durationBars), [1, 1, 1, 1]);
  assert.equal(session.progression.cycleBars, 4);
});

test('arpejo: a figura toca UMA vez no primeiro compasso, a última nota fecha com ligadura e o resto é pausa', () => {
  const recipe = defaultRecipe({
    family: 'arpejo_triade_forma_unica', profile: bass4,
    progression: { kind: 'lista', quality: 'major', chords: [{ root: 0, quality: 'major' }] },
    region: { from: 1, to: 12, open: false }, figure: { degrees: [1, 3, 5], bars: 3, order: 'sobe' },
    rhythm: 'arpejo', bars: null, voltas: 1, final: 'nenhum',
  });
  const session = studyExercise(generateStudy(recipe), { profile: bass4 }).session;
  assert.equal(session.bars, 3);
  // (0,4) (4,4) (8,16): a terceira nota preenche a sobra do compasso 1 e leva a
  // ligadura de uma mínima no compasso 2; o resto dos compassos é pausa. A UI
  // não inventa ritmo: estas são as durações do motor.
  assert.deepEqual(session.notes.map(note => [note.start, note.duration]), [[0, 4], [4, 4], [8, 16]]);
});

test('arpejo de região com ciclo misto (I–vi–ii–V) vira exercício comum: cifra por acorde e Agora/Próximo', () => {
  const recipe = defaultRecipe({
    family: 'arpejo_triade_forma_unica', profile: bass4,
    progression: { kind: 'lista', quality: 'major', chords: [{ root: 0, quality: 'major' }, { root: 9, quality: 'minor' }, { root: 2, quality: 'minor' }, { root: 7, quality: '7' }] },
    region: { from: 1, to: 12, open: false }, figure: { degrees: [1, 3, 5], bars: 2, order: 'sobe' },
    rhythm: 'arpejo', bars: null, voltas: 1, final: 'tonica',
  });
  const result = generateStudy(recipe);
  assert.deepEqual(result.warnings, [], 'o ciclo misto sai sem aviso: a região aceita as qualidades do ciclo');
  const session = studyExercise(result, { profile: bass4 }).session;
  assert.equal(session.bars, 9);
  assert.deepEqual(session.progression.chords.map(chord => [chord.symbol, chord.quality]), [['C', ''], ['Am', 'm'], ['Dm', 'm'], ['G7', '7']]);
  assert.deepEqual(session.progression.chords.map(chord => chord.durationBars), [2, 2, 2, 2]);
  assert.equal(session.progression.cycleBars, 8);
  // O estudo fecha com a tônica do PRIMEIRO acorde (padrão do pedido).
  const finalNote = session.notes[session.notes.length - 1];
  assert.equal(finalNote.start, 8 * 16);
  assert.equal(finalNote.pitch % 12, 0);
  const now = chordNowNext(session, 0);
  assert.equal(now.current.chord.symbol, 'C');
  assert.equal(now.next.chord.symbol, 'Am');
});

test('perfil de 5 cordas muda a extensão do instrumento sem mudar a sessão', () => {
  const session = studyExercise(generateStudy(quartas({ profile: bass5 })), { profile: bass5 }).session;
  assert.deepEqual(session.extensions.studio.instrument.tuning, [23, 28, 33, 38, 43]);
  assert.equal(session.extensions.studio.instrument.strings, 5);
  assert.ok(session.notes.every(note => note.string >= 1 && note.string <= 5));
  assert.deepEqual(parseSession(serializeSession(session)), JSON.parse(JSON.stringify(session)));
});

test('prévia: mesma contagem de compassos e uma sessão-símile que os renderizadores aceitam', () => {
  const recipe = quartas();
  const result = generateStudy(recipe);
  const preview = previewSession(result, { phraseView: 'tab', bpm: 84 });
  assert.equal(preview.bars, result.actualBars);
  assert.equal(preview.bars, 25);
  assert.equal(preview.notes, result.notes, 'a prévia desenha as notas derivadas do gerador (corda/casa)');
  assert.equal(preview.extensions.studio.phraseView, 'tab');
  assert.equal(preview.bpm, 84);
  assert.equal(preview.progression.enabled, true);
  const model = buildRhythmNotation(preview.notes, preview);
  assert.equal(model.measures.length, 25);
  assert.deepEqual(progressionFromResult(result).chords.length, 12);
  assert.equal(previewSession(result, { phraseView: 'rhythm' }).extensions.studio.phraseView, 'rhythm');
});

test('estudo que não cabe numa sessão é recusado com o limite, e o motor não truncou nada', () => {
  // 8 notas por compasso é a densidade máxima do motor (colcheias contínuas),
  // então passar de 512 notas implica passar de 64 compassos: a sessão recusa
  // pelo limite que estourou primeiro e nunca grava documento parcial.
  const recipe = defaultRecipe({
    family: 'movimento_continuo_linha_4_notas', profile: bass4,
    progression: { kind: 'quartas', quality: 'major' },
    region: { from: 1, to: 12, open: false },
    figure: { notes: 32, order: 'sobe' }, rhythm: 'eighths', bars: null, voltas: 2, final: 'nenhum',
  });
  const result = generateStudy(recipe);
  assert.ok(result.notes.length > STUDY_MAX_NOTES);
  assert.equal(result.warningCounts['notas-acima-de-512'], 1);
  assert.equal(result.meta.noteCount, result.notes.length, 'nada é descartado no resultado');
  assert.throws(() => studyExercise(result, { profile: bass4 }), error => {
    assert.ok(error instanceof RangeError, 'o commit lança erro de faixa');
    const match = /(\d+) (notas|compassos)/.exec(error.message);
    assert.ok(match, error.message);
    assert.ok(Number(match[1]) > 0);
    return true;
  });
  // Um estudo menor (volt...) cabe normalmente.
  const smaller = generateStudy({ ...recipe, voltas: 1 });
  assert.ok(smaller.notes.length <= STUDY_MAX_NOTES);
  assert.ok(studyExercise(smaller, { profile: bass4 }).session.notes.length === smaller.notes.length);
});

test('o teto de compassos é avisado, o material para no teto e continua coerente', () => {
  const recipe = quartas({ bars: null, voltas: 6 }); // 144 compassos de ciclo pedidos
  const result = generateStudy(recipe);
  assert.equal(result.warningCounts['limite-128'], 1);
  assert.ok(result.actualBars > 25 && result.actualBars <= 128);
  assert.equal(result.slots.length * 2, result.actualBars, 'o capado para em voltas inteiras');
  for (const note of result.notes) {
    assert.ok(note.start + note.duration <= result.actualBars * 16 + 1e-6, 'nota além dos compassos reais');
  }
});
