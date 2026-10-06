// A2 — testes do gerador de estudos (valores calculados à mão).
// Coordenadas: 4 ticks = semínima, 16 = compasso. Baixo 4 cordas: E1 28, A1 33,
// D2 38, G2 43 (corda 1 = G2). Região 1..5 (sem soltas): E 29..33, A 34..38,
// D 39..43, G 44..48 — toda altura de 29 a 48 existe, cada uma numa só casa.
// Baixo 5 cordas acrescenta B0 23 (corda 5): região 1..5 = 24..28 nela.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_KEYS, MIN_DURATION, validPhrase } from '../src/model.js';
import {
  STUDY_MAX_BARS, STUDY_MAX_NOTES, STUDY_REGION_DEFAULT, STUDY_FAMILIES, STUDY_QUALITIES, STUDY_PERIOD,
  STUDY_MAX_FIGURE_BARS, STUDY_MAX_PERCURSO_FIGURE_BARS, maxFigureBars,
  normalizeRecipe, defaultRecipe, chordCycle, planSlots, generateStudy, canonicalNotes, noteName,
  regionPositions, applyShape, periodState, recipeFromCatalog, catalogValues, catalogContour,
  normalizeRhythmCode, rhythmCode, studyMetadata, STUDY_WARNING_CODES,
} from '../src/study-generator.js';

const bass = { type: 'bass', strings: 4 };
const bass5 = { type: 'bass', strings: 5 };
const region5 = { from: 1, to: 5, open: false };
const QUARTAS = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'B', 'E', 'A', 'D', 'G'];
// Forma móvel genérica: T na corda 4, terça uma casa atrás na corda 3, quinta duas à frente.
const SHAPE_A = { quality: 'major', notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }] };
// O mesmo desenho um jogo de cordas acima (T na corda 3).
const SHAPE_B = { quality: 'major', notes: [{ string: 3, fret: 3, degree: 1 }, { string: 2, fret: 2, degree: 3 }, { string: 2, fret: 5, degree: 5 }] };
const simple = (overrides = {}) => ({
  family: 'arpejo_triade_forma_unica',
  profile: bass,
  progression: { kind: 'lista', quality: 'major', chords: ['C'] },
  bars: 2,
  region: region5,
  final: 'nenhum',
  ...overrides,
});
const line = (chords, overrides = {}) => generateStudy({
  family: 'movimento_continuo_linha_4_notas', profile: bass,
  progression: { kind: 'lista', quality: 'major', chords }, region: region5, final: 'nenhum', ...overrides,
});
const pitches = notes => notes.map(note => note.pitch);
const spans = notes => notes.map(note => [note.start, note.duration]);
const places = notes => notes.map(note => [note.string, note.fret]);
const count = (result, code) => result.warnings.filter(warning => warning.code === code).length;

function assertMonophonic(notes) {
  for (let index = 1; index < notes.length; index += 1) {
    assert.ok(notes[index - 1].start + notes[index - 1].duration <= notes[index].start + 1e-9, `sobreposição em ${index}`);
  }
  for (const note of notes) assert.ok(note.duration >= MIN_DURATION, 'duração abaixo do mínimo');
}

test('receita: defaults, validação e regiões', () => {
  const recipe = defaultRecipe();
  assert.equal(recipe.family, 'arpejo_triade_forma_unica');
  assert.equal(recipe.rhythm, 'arpejo');
  assert.equal(recipe.figure.bars, 2);
  assert.deepEqual(recipe.region, STUDY_REGION_DEFAULT);
  assert.deepEqual(recipe.figure.degrees, [1, 3, 5]);
  assert.equal(recipe.bars, null);
  // "Repetir o primeiro acorde no fim": sim por padrão.
  assert.equal(recipe.final, 'tonica');
  // `figure` não tem mais a contagem morta `shapes`; o campo é recusado.
  assert.deepEqual(Object.keys(recipe.figure).sort(), ['bars', 'degrees', 'inversions', 'notes', 'order']);
  assert.throws(() => normalizeRecipe(simple({ figure: { shapes: 2 } })), /Campo desconhecido na figura: shapes/);
  assert.equal(studyMetadata(generateStudy(simple())).shapes, 0);
  // Compassos por bloco: 1..4 em geral; percursos aceitam o mínimo derivado até 128.
  assert.equal(STUDY_MAX_FIGURE_BARS, 4);
  assert.equal(STUDY_MAX_PERCURSO_FIGURE_BARS, 128);
  assert.equal(maxFigureBars('arpejo_triade_forma_unica'), 4);
  assert.equal(maxFigureBars('movimento_continuo_linha_4_notas'), 4);
  assert.equal(maxFigureBars('movimento_continuo_grave_agudo_grave'), 128);
  assert.throws(() => normalizeRecipe(simple({ figure: { bars: 5 } })), /1 a 4/);
  assert.equal(normalizeRecipe({ family: 'movimento_continuo_agudo_grave_agudo', figure: { bars: 5 } }).figure.bars, 5);
  assert.throws(() => normalizeRecipe({ family: 'movimento_continuo_agudo_grave_agudo', figure: { bars: 129 } }), /1 a 128/);
  // As três inversões têm um compasso cada (q q h).
  assert.equal(defaultRecipe({ family: 'arpejo_tres_inversoes_por_acorde' }).figure.bars, 1);
  assert.equal(normalizeRecipe(simple({ voltas: STUDY_PERIOD })).voltas, 'periodo');
  // Nota inicial validada já na receita (oitava opcional, só a classe importa).
  assert.equal(normalizeRecipe(simple({ progression: { kind: 'quartas', start: 'C2' } })).progression.start, 'C');
  assert.throws(() => normalizeRecipe(simple({ progression: { kind: 'quartas', start: 'H' } })), /Nota inicial desconhecida/);
  assert.throws(() => normalizeRecipe({ ...simple(), extra: 1 }), /Campo desconhecido/);
  assert.throws(() => normalizeRecipe(simple({ family: 'arpejo_de_curso' })), /Família desconhecida/);
  assert.throws(() => normalizeRecipe(simple({ progression: { kind: 'blues' } })), /Progressão desconhecida/);
  assert.throws(() => normalizeRecipe(simple({ progression: { kind: 'lista', quality: 'maior' } })), /Qualidade desconhecida/);
  assert.throws(() => normalizeRecipe(simple({ region: { from: 0, to: 12 } })), /corda solta|casa 1/);
  assert.throws(() => normalizeRecipe(simple({ region: { from: 1, to: 30 } })), /casas entre/);
  assert.throws(() => normalizeRecipe(simple({ bars: 129 })), /1 a 128/);
  assert.throws(() => normalizeRecipe(simple({ voltas: 'sempre' })), /voltas/);
  assert.throws(() => normalizeRecipe(simple({ rhythm: 'arpejo', family: 'movimento_continuo_linha_4_notas' })), /movimento contínuo/);
  assert.throws(() => normalizeRecipe(simple({ final: 'coda' })), /final deve ser/);
  assert.throws(() => normalizeRecipe(simple({ shape: { quality: 'major', notes: [{ string: 3, fret: 2, degree: 3 }] } })), /âncora na tônica/);
  assert.throws(() => normalizeRecipe(simple({ shape: { quality: 'minor', notes: [{ string: 3, fret: 2, degree: 1 }] } })), /precisam ser iguais/);
  // Raiz escrita como grau 8 (editor de formas do A3) é âncora válida.
  assert.equal(normalizeRecipe(simple({ shape: { quality: 'major', notes: [{ string: 4, fret: 3, degree: 5 }, { string: 3, fret: 3, degree: 8 }] } })).shape.notes.length, 2);
  assert.equal(STUDY_FAMILIES.length, 6);
  assert.equal(STUDY_QUALITIES.length, 9);
  assert.equal(STUDY_MAX_BARS, 128);
  assert.equal(STUDY_MAX_NOTES, 512);
});

test('ritmo do arpejo: q q h | h ligada + pausa h; compassos seguintes só pausa', () => {
  const result = generateStudy(simple());
  assert.deepEqual(spans(result.notes), [[0, 4], [4, 4], [8, 16]]); // a terceira atravessa a barra (ligadura)
  assert.ok(result.notes.every(note => note.start + note.duration <= 24)); // pausa de mínima 24..32
  assert.equal(result.actualBars, 2);
  assert.deepEqual(pitches(result.notes), [36, 40, 43]); // C2 E2 G2
  assert.deepEqual(places(result.notes), [[3, 3], [2, 2], [2, 5]]);
  assert.deepEqual(result.notes.map(note => note.role), ['Tônica', 'Terça maior', 'Quinta justa']);
  assertMonophonic(result.notes);
  assert.deepEqual(result.warnings, []);
  assert.equal(rhythmCode(result), 'q q h | h(lig) pausa_h');
  // 1 compasso: q q h sem ligadura.
  const one = generateStudy(simple({ figure: { bars: 1 }, bars: 1 }));
  assert.deepEqual(spans(one.notes), [[0, 4], [4, 4], [8, 8]]);
  // 3 e 4 compassos: a ligadura NÃO cresce; o resto é pausa.
  for (const bars of [3, 4]) {
    const long = generateStudy(simple({ figure: { bars }, bars }));
    assert.deepEqual(spans(long.notes), [[0, 4], [4, 4], [8, 16]]);
    assert.equal(long.actualBars, bars);
  }
  assert.equal(rhythmCode(generateStudy(simple({ figure: { bars: 3 }, bars: 3 }))), 'q q h | h(lig) pausa_h | pausa_w');
});

test('arpejo em semínimas ou colcheias: figura UMA vez, última preenche o compasso, liga e pausa', () => {
  // Semínimas (base explícita): igual ao ritmo do arpejo, para 1..4 compassos.
  const quarter = bars => generateStudy(simple({ rhythm: 'quarters', figure: { bars }, bars }));
  assert.deepEqual(spans(quarter(1).notes), [[0, 4], [4, 4], [8, 8]]);
  for (const bars of [2, 3, 4]) {
    const result = quarter(bars);
    assert.deepEqual(pitches(result.notes), [36, 40, 43]);
    assert.deepEqual(spans(result.notes), [[0, 4], [4, 4], [8, 16]]);
    assert.equal(result.actualBars, bars);
  }
  // Colcheias: 0, 2, 4; a última fica com 12 (resto do compasso) e +8 ligada a partir de 2 compassos.
  const eighth = bars => generateStudy(simple({ rhythm: 'eighths', figure: { bars }, bars }));
  assert.deepEqual(spans(eighth(1).notes), [[0, 2], [2, 2], [4, 12]]);
  assert.equal(rhythmCode(eighth(1)), 'e e h.');
  for (const bars of [2, 3, 4]) {
    const result = eighth(bars);
    assert.deepEqual(pitches(result.notes), [36, 40, 43]);
    assert.deepEqual(spans(result.notes), [[0, 2], [2, 2], [4, 20]]);
    assert.equal(result.actualBars, bars);
  }
  assert.equal(rhythmCode(eighth(3)), 'e e h. | h(lig) pausa_h | pausa_w');
  // Sobe-desce em colcheias: 36 40 43 40 36 uma vez, sem repetir nem cortar no meio.
  const both = generateStudy(simple({ rhythm: 'eighths', figure: { order: 'sobe-desce' }, bars: null }));
  assert.deepEqual(pitches(both.notes), [36, 40, 43, 40, 36]);
  assert.deepEqual(spans(both.notes), [[0, 2], [2, 2], [4, 2], [6, 2], [8, 8]]);
  // Inversões em colcheias: 1 compasso cada, a última preenche 12.
  const inversions = generateStudy({ family: 'arpejo_tres_inversoes_por_acorde', profile: bass, progression: { kind: 'lista', quality: 'major', chords: ['C'] }, rhythm: 'eighths', final: 'nenhum' });
  assert.deepEqual(spans(inversions.notes), [[0, 2], [2, 2], [4, 12], [16, 2], [18, 2], [20, 12], [32, 2], [34, 2], [36, 12]]);
  // Contínuo e percursos não mudam: cada nota uma vez, a última preenche o bloco.
  assert.deepEqual(spans(line(['C'], { rhythm: 'eighths' }).notes), [[0, 2], [2, 2], [4, 2], [6, 10]]);
});

test('critério 2: arpejo T-3-5 em quartas, 2 compassos por acorde, repete o primeiro acorde = 25 compassos', () => {
  const result = generateStudy({
    family: 'arpejo_triade_forma_unica', profile: bass, progression: { kind: 'quartas', quality: 'major', start: 'C' },
    figure: { degrees: [1, 3, 5], bars: 2 }, bars: null,
  });
  const body = result.chords.filter(chord => !chord.final);
  assert.deepEqual(body.map(chord => chord.symbol), QUARTAS);
  assert.equal(result.actualBars, 25);
  assert.equal(result.notes.length, 37);
  // Cada acorde na posição completa MAIS GRAVE das casas 1..12 (calculadas à mão).
  assert.deepEqual(body.map(chord => chord.shape.map(item => item.pitch)), [
    [36, 40, 43], [29, 33, 36], [34, 38, 41], [39, 43, 46], [32, 36, 39], [37, 41, 44],
    [30, 34, 37], [35, 39, 42], [40, 44, 47], [33, 37, 40], [38, 42, 45], [31, 35, 38],
  ]);
  assert.deepEqual(body.map(chord => chord.shape.map(item => [item.string, item.fret])), [
    [[3, 3], [2, 2], [2, 5]], [[4, 1], [4, 5], [3, 3]], [[3, 1], [3, 5], [2, 3]], [[2, 1], [2, 5], [1, 3]],
    [[4, 4], [3, 3], [2, 1]], [[3, 4], [2, 3], [1, 1]], [[4, 2], [3, 1], [3, 4]], [[3, 2], [2, 1], [2, 4]],
    [[2, 2], [1, 1], [1, 4]], [[4, 5], [3, 4], [2, 2]], [[3, 5], [2, 4], [1, 2]], [[4, 3], [3, 2], [3, 5]],
  ]);
  for (let slot = 0; slot < 12; slot += 1) {
    assert.deepEqual(spans(result.notes.slice(slot * 3, slot * 3 + 3)), [[slot * 32, 4], [slot * 32 + 4, 4], [slot * 32 + 8, 16]]);
  }
  // Compasso final: o PRIMEIRO acorde (C), tônica mais grave na região, uma semibreve.
  const last = result.notes[36];
  assert.deepEqual([last.start, last.duration, last.pitch, last.string, last.fret], [384, 16, 36, 3, 3]);
  assert.deepEqual(result.finalBar, { bar: 24, start: 384, ticks: 16, chordIndex: 0, symbol: 'C', root: 0, quality: 'major', repeatsFirst: true });
  assert.equal(result.chords.at(-1).final, true);
  assert.equal(result.chords.at(-1).symbol, 'C');
  assertMonophonic(result.notes);
  assert.deepEqual(result.warnings, []);
  // bars explícito: 25 dá o mesmo; 24 avisa o mínimo (o compasso final conta).
  assert.equal(generateStudy({ ...result.recipe, bars: 25 }).notes.length, 37);
  const short = generateStudy({ ...result.recipe, bars: 24 });
  assert.deepEqual(short.warnings.map(warning => [warning.code, warning.minimumBars, warning.action.bars]), [['aumentar-compassos', 25, 25]]);
  assert.equal(short.actualBars, 25, 'não trunca');
  // Explícito 'acorde' = tônica do ÚLTIMO acorde tocado (G), mesmo ciclo.
  const lastChord = generateStudy({ ...result.recipe, final: 'acorde' });
  assert.deepEqual([lastChord.finalBar.symbol, lastChord.finalBar.chordIndex, lastChord.finalBar.repeatsFirst], ['G', 11, false]);
  assert.equal(lastChord.notes.at(-1).pitch % 12, 7);
});

test('final: padrão repete o primeiro acorde; nenhum deixa a sobra muda; acorde = último acorde tocado', () => {
  // Receita mínima (padrões): ciclo de quartas em C termina em C.
  const plain = generateStudy({ profile: bass, progression: { kind: 'quartas' } });
  assert.equal(plain.recipe.final, 'tonica');
  assert.deepEqual([plain.finalBar.symbol, plain.finalBar.chordIndex, plain.finalBar.repeatsFirst], ['C', 0, true]);
  assert.equal(plain.actualBars, 25);
  const base = { family: 'arpejo_triade_forma_unica', profile: bass, region: region5, progression: { kind: 'quartas', quality: 'major', length: 2 }, bars: 5 };
  const silent = generateStudy({ ...base, final: 'nenhum' });
  assert.equal(silent.notes.length, 6); // C 36 40 43, F 29 33 36
  assert.equal(silent.actualBars, 5);
  assert.equal(silent.finalBar, null);
  const tonic = generateStudy({ ...base, final: 'tonica' });
  assert.equal(tonic.notes.length, 7);
  // Sobra = compasso 5 (start 64); a nota longa cobre exatamente a sobra.
  assert.deepEqual([tonic.notes[6].start, tonic.notes[6].duration, tonic.notes[6].pitch], [64, 16, 36]);
  // ['C','F'] em 2 voltas (8 compassos) + final do ÚLTIMO acorde (F): índice 1 no ciclo, não 3.
  const chord = generateStudy({ ...base, progression: { kind: 'lista', quality: 'major', chords: ['C', 'F'] }, voltas: 2, bars: 9, final: 'acorde' });
  assert.equal(chord.finalBar.chordIndex, 1);
  assert.equal(chord.finalBar.symbol, 'F');
  assert.deepEqual([chord.notes.at(-1).start, chord.notes.at(-1).pitch, chord.notes.at(-1).string, chord.notes.at(-1).fret], [128, 29, 4, 1]);
});

test('compassos insuficientes: avisa o mínimo e não trunca', () => {
  const result = generateStudy(simple({ bars: 1 }));
  assert.equal(count(result, 'aumentar-compassos'), 1);
  const [warning] = result.warnings;
  assert.equal(warning.minimumBars, 2);
  assert.deepEqual(warning.action, { kind: 'aumentar-compassos', bars: 2 });
  assert.equal(result.notes.length, 3); // nada foi descartado
  assert.equal(result.actualBars, 2);
  // Com compasso final, o mínimo inclui o final.
  const withFinal = generateStudy(simple({ final: 'acorde' }));
  assert.deepEqual(withFinal.warnings.map(item => [item.minimumBars, item.action.bars]), [[3, 3]]);
});

test('sem posição na região: avisa o acorde + menor expansão, mantém as notas e a ação resolve', () => {
  const result = generateStudy(simple({ region: { from: 1, to: 1 } }));
  assert.equal(result.notes.length, 3);
  assert.equal(count(result, 'sem-posicao'), 1);
  const [warning] = result.warnings;
  assert.equal(warning.chord, 'C');
  assert.deepEqual(warning.expansion, { from: 1, to: 5, open: false, strings: null });
  assert.deepEqual(warning.action, { kind: 'expandir-regiao', region: { from: 1, to: 5, open: false, strings: null } });
  assert.ok(result.notes.every(note => note.outside === true));
  assert.deepEqual(places(result.notes), [[3, 3], [2, 2], [2, 5]]);
  assertMonophonic(result.notes);
  assert.deepEqual(generateStudy(simple({ region: warning.action.region })).warnings, []);
});

test('região: busca completa, menor casa e empate mais grave', () => {
  // C2 (36) cabe em A1 casa 3 e em E1 casa 8; 40 em D2 casa 2; 43 em D2 casa 5.
  const solved = regionPositions(bass, [36, 40, 43], region5);
  assert.deepEqual(places(solved.positions), [[3, 3], [2, 2], [2, 5]]);
  assert.deepEqual(solved.positions.map(item => item.pitch), [36, 40, 43]);
  assert.equal(solved.expansion, null);
  const high = regionPositions(bass, [60, 64, 67], region5);
  assert.equal(high.positions, null);
  assert.deepEqual(high.expansion, { from: 1, to: 24, open: false, strings: null }); // 67 só na corda 1, casa 24
  assert.deepEqual(regionPositions(bass, [29, 34], region5).positions.map(item => item.fret), [1, 1]);
});

test('linha contínua: começa no mais grave subindo; a nota de um acorde novo sai da ÚLTIMA altura tocada', () => {
  // Escada de C em 1..5 = G1 C2 E2 G2 C3 (31 36 40 43 48).
  const one = line(['C'], { bars: 1 });
  assert.deepEqual(spans(one.notes), [[0, 4], [4, 4], [8, 4], [12, 4]]);
  assert.deepEqual(pitches(one.notes), [31, 36, 40, 43]);
  assert.deepEqual(places(one.notes), [[4, 3], [3, 3], [2, 2], [2, 5]]);
  // E (32 35 40 44 47): acima de 43 a próxima é 44, sobe até 47, vira na borda.
  assert.deepEqual(pitches(line(['C', 'E']).notes), [31, 36, 40, 43, 44, 47, 44, 40]);
  // F (29 33 36 41 45 48) depois C: de 41 subindo -> 43, 48, vira -> 43, 40.
  assert.deepEqual(pitches(line(['F', 'C']).notes), [29, 33, 36, 41, 43, 48, 43, 40]);
  // 5 notas por acorde: a última preenche a sobra do segundo compasso.
  const five = line(['C'], { figure: { notes: 5 } });
  assert.deepEqual(spans(five.notes), [[0, 4], [4, 4], [8, 4], [12, 4], [16, 16]]);
  assert.equal(five.actualBars, 2);
  assert.equal(rhythmCode(five), 'q q q q | w');
});

test('critério 3: linha contínua em 1..5 pelo ciclo de quartas = 13 compassos, toda transição estrita', () => {
  const result = generateStudy({
    family: 'movimento_continuo_linha_4_notas', profile: bass, progression: { kind: 'quartas', quality: 'major' },
    region: region5, figure: { notes: 4, bars: 1 }, rhythm: 'quarters', bars: 13, final: 'tonica',
  });
  assert.equal(result.actualBars, 13);
  assert.equal(result.notes.length, 49);
  assert.deepEqual(pitches(result.notes), [
    31, 36, 40, 43, 45, 48, 45, 41, 38, 34, 29, 34, 39, 43, 46, 43, 39, 36, 32, 36, 37, 41, 44, 41,
    37, 34, 30, 34, 35, 39, 42, 47, 44, 40, 35, 32, 33, 37, 40, 45, 42, 38, 33, 30, 31, 35, 38, 43,
    48, // compasso final: a tônica de C seguinte a 43 subindo
  ]);
  // Conferência da regra: cada nota é a altura do acorde vigente mais próxima
  // ALÉM da anterior na direção; sem nenhuma, a direção vira.
  const rootOf = symbol => ({ C: 0, F: 5, Bb: 10, Eb: 3, Ab: 8, Db: 1, Gb: 6, B: 11, E: 4, A: 9, D: 2, G: 7 })[symbol];
  const ladder = symbol => Array.from({ length: 20 }, (_, index) => 29 + index).filter(pitch => [0, 4, 7].includes((((pitch - rootOf(symbol)) % 12) + 12) % 12));
  let direction = 1;
  for (let index = 1; index < result.notes.length; index += 1) {
    const chord = result.chords.find(item => item.index === result.notes[index].chordIndex);
    const tones = index === 48 ? ladder('C').filter(pitch => pitch % 12 === 0) : ladder(chord.symbol);
    const last = result.notes[index - 1].pitch;
    const ahead = direction > 0 ? tones.find(pitch => pitch > last) : tones.findLast(pitch => pitch < last);
    const expected = ahead ?? (direction > 0 ? tones.findLast(pitch => pitch < last) : tones.find(pitch => pitch > last));
    if (ahead === undefined) direction = -direction;
    assert.equal(result.notes[index].pitch, expected, `transição ${index}`);
  }
  assert.deepEqual([result.notes[48].start, result.notes[48].duration, result.notes[48].string, result.notes[48].fret], [192, 16, 1, 5]);
  assert.equal(result.finalBar.symbol, 'C');
  assert.deepEqual(result.warnings, []);
  assertMonophonic(result.notes);
});

test('critério 5: "até fechar o período" fecha em 3 voltas e para em 128 com aviso', () => {
  // Região 3..5: escada de C = [31 36 43 48]. Estados: 31↑ -> 43↓ -> 43↑ -> 31↑ (volta ao início).
  const recipe = defaultRecipe({
    family: 'movimento_continuo_linha_4_notas', profile: bass, progression: { kind: 'lista', quality: 'major', chords: ['C'] },
    region: { from: 3, to: 5 }, voltas: STUDY_PERIOD, final: 'nenhum',
  });
  const result = generateStudy(recipe);
  assert.equal(result.actualBars, 3);
  assert.deepEqual(pitches(result.notes), [31, 36, 43, 48, 43, 36, 31, 36, 43, 48, 43, 36]);
  assert.equal(result.period.mode, 'periodo');
  assert.equal(result.period.length, 3);
  assert.equal(result.period.voltas, 3);
  assert.equal(result.period.closed, true);
  assert.equal(result.period.capped, false);
  assert.deepEqual(result.period.states.map(state => [state.pitch, state.direction]), [[31, 'subindo'], [43, 'descendo'], [43, 'subindo']]);
  assert.deepEqual([0, 1, 2, 3].map(turn => { const state = periodState(recipe, turn); return [state.pitch, state.direction]; }),
    [[31, 'subindo'], [43, 'descendo'], [43, 'subindo'], [31, 'subindo']]);
  assert.throws(() => periodState(simple(), 0), /movimentos contínuos/);
  // Com compasso final: tônica seguinte a 36 descendo não existe -> vira -> 48.
  const closing = generateStudy({ ...recipe, final: 'acorde' });
  assert.equal(closing.actualBars, 4);
  assert.deepEqual([closing.notes.at(-1).pitch, closing.notes.at(-1).string, closing.notes.at(-1).fret], [48, 1, 5]);
  // Região 1..5: 31↑ -> 48↓ -> 31↑ = período 2.
  assert.equal(line(['C'], { voltas: STUDY_PERIOD }).period.length, 2);
  // Quartas em 1..5 nunca volta a 31↑: para na última volta inteira em 128 (10 x 12 = 120), sem final.
  const capped = generateStudy({
    family: 'movimento_continuo_linha_4_notas', profile: bass, progression: { kind: 'quartas', quality: 'major' },
    region: region5, voltas: STUDY_PERIOD, final: 'tonica',
  });
  assert.equal(capped.actualBars, 120);
  assert.equal(capped.slots.length, 120);
  assert.equal(capped.finalBar, null);
  assert.equal(capped.period.length, null);
  assert.equal(capped.period.closed, false);
  assert.equal(capped.period.capped, true);
  assert.deepEqual(capped.warnings, [{
    code: 'limite-128', limit: 128, needed: null, period: null, voltas: 10, finalOmitted: true, action: { kind: 'reduzir-voltas', voltas: 10 },
  }]);
});

test('critério 4: percursos tocam TODA a escada ida e volta; faltando compassos, avisa o mínimo e a ação resolve', () => {
  const recipe = {
    family: 'movimento_continuo_grave_agudo_grave', profile: bass, progression: { kind: 'lista', quality: 'major', chords: ['C'] },
    region: region5, figure: { bars: 1 }, final: 'nenhum',
  };
  const result = generateStudy(recipe);
  // 2L-1 = 9 notas (L = 5) -> mínimo ceil(9/4) = 3 compassos; nada truncado.
  assert.deepEqual(pitches(result.notes), [31, 36, 40, 43, 48, 43, 40, 36, 31]);
  assert.deepEqual(spans(result.notes), [[0, 4], [4, 4], [8, 4], [12, 4], [16, 4], [20, 4], [24, 4], [28, 4], [32, 16]]);
  assert.equal(result.actualBars, 3);
  assert.deepEqual(result.warnings, [{
    code: 'aumentar-compassos', scope: 'figura', minimumFigureBars: 3, figureBars: 1, minimumBars: 3,
    action: { kind: 'aumentar-compassos', figureBars: 3, bars: null },
  }]);
  const fixed = generateStudy({ ...recipe, figure: { bars: result.warnings[0].action.figureBars } });
  assert.deepEqual(fixed.warnings, []);
  assert.deepEqual(pitches(fixed.notes), pitches(result.notes));
  // Com total pedido: C (9 notas) e F (29 33 36 41 45 48 -> 11 notas) pedem 3; a ação corrige os dois números.
  const total = generateStudy({ ...recipe, progression: { kind: 'lista', quality: 'major', chords: ['C', 'F'] }, bars: 3 });
  assert.deepEqual(total.warnings.map(warning => warning.action), [{ kind: 'aumentar-compassos', figureBars: 3, bars: 6 }]);
  assert.deepEqual(generateStudy({ ...total.recipe, figure: { ...total.recipe.figure, bars: 3 }, bars: 6 }).warnings, []);
  // Agudo-grave-agudo começa pela mais aguda.
  assert.deepEqual(pitches(generateStudy({ ...recipe, family: 'movimento_continuo_agudo_grave_agudo', figure: {} }).notes), [48, 43, 40, 36, 31, 36, 40, 43, 48]);
  // Região 3..5: [31 36 43 48] -> 7 notas em 2 compassos; a última preenche a sobra.
  const small = generateStudy({ ...recipe, region: { from: 3, to: 5 }, figure: {} });
  assert.equal(small.actualBars, 2);
  assert.deepEqual(spans(small.notes).at(-1), [24, 8]);
  // Baixo 5, C em 1..12: escada [24 28 31 36 40 43 48 52 55] (L = 9) -> 17 semínimas = 5 compassos.
  // A ação passa do teto digitável (4) e o motor ACEITA, porque é percurso.
  const five = { ...recipe, profile: bass5, region: { from: 1, to: 12 }, figure: { bars: 4 } };
  const short = generateStudy(five);
  assert.deepEqual(pitches(short.notes), [24, 28, 31, 36, 40, 43, 48, 52, 55, 52, 48, 43, 40, 36, 31, 28, 24]);
  assert.deepEqual(short.warnings.map(warning => warning.action), [{ kind: 'aumentar-compassos', figureBars: 5, bars: null }]);
  const applied = generateStudy({ ...five, figure: { bars: short.warnings[0].action.figureBars } });
  assert.deepEqual(applied.warnings, []);
  assert.equal(applied.actualBars, 5);
  assert.deepEqual(spans(applied.notes).at(-1), [64, 16]);
});

test('região sem escada: expande o mínimo, mantém as 4 notas marcadas fora e avisa', () => {
  // Corda 1 casa 1 = 44 (G#): nenhuma nota de C. Menor expansão com duas alturas: casas 1..3, todas as cordas.
  const result = line(['C'], { region: { from: 1, to: 1, strings: [1] } });
  assert.deepEqual(pitches(result.notes), [31, 36, 40, 36]);
  assert.deepEqual(places(result.notes), [[4, 3], [3, 3], [2, 2], [3, 3]]);
  assert.ok(result.notes.every(note => note.outside));
  assert.deepEqual(result.warnings, [{
    code: 'sem-posicao', chord: 'C', count: 4, expansion: { from: 1, to: 3, open: false, strings: [1, 2, 3, 4] },
    action: { kind: 'expandir-regiao', region: { from: 1, to: 3, open: false, strings: [1, 2, 3, 4] } },
  }]);
  assert.deepEqual(line(['C'], { region: result.warnings[0].action.region }).warnings, []);
});

test('três inversões: um compasso por inversão, cada uma na posição completa mais grave', () => {
  const result = generateStudy({
    family: 'arpejo_tres_inversoes_por_acorde', profile: bass, progression: { kind: 'lista', quality: 'maj7', chords: ['C'] },
    region: { from: 1, to: 12 }, final: 'nenhum',
  });
  assert.equal(result.slots.length, 3);
  assert.deepEqual(result.chords.map(chord => chord.inversion), [0, 1, 2]);
  assert.deepEqual(result.chords.map(chord => chord.shape.map(item => item.degree)), [[1, 3, 5, 7], [3, 5, 7, 8], [5, 7, 8, 10]]);
  assert.deepEqual(result.chords.map(chord => chord.shape.map(item => item.pitch)), [[36, 40, 43, 47], [40, 43, 47, 48], [31, 35, 36, 40]]);
  assert.deepEqual(result.chords[2].shape.map(item => [item.string, item.fret]), [[4, 3], [3, 2], [3, 3], [2, 2]]);
  assert.equal(result.actualBars, 3);
  assert.equal(result.notes.length, 12);
  assert.deepEqual(spans(result.notes.slice(0, 4)), [[0, 4], [4, 4], [8, 4], [12, 4]]);
  // Eb maior: 39 43 46 | 31 34 39 (4/3 3/1 2/1) | 34 39 43 — nada de oitava acima por inércia.
  const eb = generateStudy({ family: 'arpejo_tres_inversoes_por_acorde', profile: bass, progression: { kind: 'lista', quality: 'major', chords: ['Eb'] }, final: 'nenhum' });
  assert.deepEqual(eb.chords.map(chord => chord.shape.map(item => item.pitch)), [[39, 43, 46], [31, 34, 39], [34, 39, 43]]);
  assert.deepEqual(eb.chords[1].shape.map(item => [item.string, item.fret]), [[4, 3], [3, 1], [2, 1]]);
  assertMonophonic(result.notes);
});

test('formas combinadas: em cada acorde, a posição (ou a forma) que cabe na região', () => {
  const plain = generateStudy(simple({ family: 'arpejo_triade_formas_combinadas' }));
  assert.deepEqual(pitches(plain.notes), [36, 40, 43]);
  // Duas formas: C só cabe em 1..5 pela forma B (T na corda 3); G pela forma A.
  const result = generateStudy(simple({
    family: 'arpejo_triade_formas_combinadas', progression: { kind: 'lista', quality: 'major', chords: ['C', 'G'] },
    shapes: [SHAPE_A, SHAPE_B], bars: null,
  }));
  assert.deepEqual(pitches(result.notes), [36, 40, 43, 31, 35, 38]);
  assert.deepEqual(places(result.notes), [[3, 3], [2, 2], [2, 5], [4, 3], [3, 2], [3, 5]]);
  assert.deepEqual(result.chords.map(chord => chord.shapeIndex), [1, 0]);
  assert.deepEqual(result.warnings, []);
});

test('forma: ordem dos graus, âncora no grau 8, graus ausentes avisados', () => {
  const region = { from: 1, to: 12 };
  // Notas listadas 5,1,3 sem `degrees`: toca T-3-5 (36 40 43 em 4/8 3/7 3/10).
  const listed = { quality: 'major', notes: [SHAPE_A.notes[2], SHAPE_A.notes[0], SHAPE_A.notes[1]] };
  const ordered = generateStudy(simple({ region, shape: listed }));
  assert.deepEqual(pitches(ordered.notes), [36, 40, 43]);
  assert.deepEqual(places(ordered.notes), [[4, 8], [3, 7], [3, 10]]);
  // A ordem escolhida no Braço (`degrees`) é a ordem tocada.
  assert.deepEqual(pitches(generateStudy(simple({ region, shape: { ...SHAPE_A, degrees: [3, 5, 1] } })).notes), [40, 43, 36]);
  // Raiz escrita como grau 8: 5 na corda 4 casa 3, 8 na corda 3 casa 3 -> G1 C2.
  const octave = generateStudy(simple({ shape: { quality: 'major', degrees: [5, 8], notes: [{ string: 4, fret: 3, degree: 5 }, { string: 3, fret: 3, degree: 8 }] } }));
  assert.deepEqual(pitches(octave.notes), [31, 36]);
  assert.deepEqual(spans(octave.notes), [[0, 4], [4, 20]]);
  // Forma de 4 notas com figura de 3: a oitava não tocada é avisada.
  const dropped = generateStudy(simple({ region, shape: { quality: 'major', notes: [...SHAPE_A.notes, { string: 2, fret: 5, degree: 8 }] }, figure: { degrees: [1, 3, 5] } }));
  assert.deepEqual(dropped.warnings, [{ code: 'forma-divergente', unused: [8], missing: [], action: { kind: 'usar-graus-da-forma', degrees: [1, 3, 5, 8] } }]);
  // Figura de 4 graus numa forma de 3: a oitava sai junto à mão (C3 = 48 na corda 2 casa 10).
  const added = generateStudy(simple({ region, shape: SHAPE_A, figure: { degrees: [1, 3, 5, 8] } }));
  assert.deepEqual(pitches(added.notes), [36, 40, 43, 48]);
  assert.deepEqual(places(added.notes).at(-1), [2, 10]);
});

test('critério 6: 5 cordas usa a corda Si como a mais grave e mantém a região', () => {
  // Forma de 4 cordas desce um jogo até a Si: E maior = 28 32 35 em 5/5 4/4 4/7, dentro de 1..12.
  const placed = applyShape(bass5, SHAPE_A, { root: 4 }, { from: 1, to: 12 });
  assert.equal(placed.stringShift, 1);
  assert.deepEqual(placed.positions.map(item => [item.string, item.fret, item.pitch]), [[5, 5, 28], [4, 4, 32], [4, 7, 35]]);
  const e5 = generateStudy(simple({ profile: bass5, region: { from: 1, to: 12 }, progression: { kind: 'lista', quality: 'major', chords: ['E'] }, shape: SHAPE_A }));
  assert.deepEqual(places(e5.notes), [[5, 5], [4, 4], [4, 7]]);
  assert.deepEqual(e5.warnings, []);
  // No baixo 4 a mesma forma só cabe na casa 12 (40 44 47 em 4/12 3/11 3/14) e avisa.
  const e4 = generateStudy(simple({ region: { from: 1, to: 12 }, progression: { kind: 'lista', quality: 'major', chords: ['E'] }, shape: SHAPE_A }));
  assert.deepEqual(places(e4.notes), [[4, 12], [3, 11], [3, 14]]);
  assert.deepEqual(e4.warnings.map(warning => warning.code), ['sem-posicao']);
  // Forma escrita na corda Si volta a caber no baixo 4 pelo deslocamento inverso.
  const fromB = { quality: 'major', notes: SHAPE_A.notes.map(note => ({ ...note, string: note.string + 1 })) };
  assert.deepEqual(places(generateStudy(simple({ region: { from: 1, to: 12 }, shape: fromB })).notes), [[4, 8], [3, 7], [3, 10]]);
  // Linha contínua em 1..5 no baixo 5: escada [24 28 31 36 40 43 48], começa no C1 da corda Si.
  const five = line(['C'], { profile: bass5 });
  assert.deepEqual(pitches(five.notes), [24, 28, 31, 36]);
  assert.deepEqual(places(five.notes), [[5, 1], [5, 5], [4, 3], [3, 3]]);
  assert.deepEqual(five.meta.region, { from: 1, to: 5, open: false, strings: null });
});

test('grafia: bemóis só nas quartas maiores; o resto usa a grafia de tonalidade do app', () => {
  const symbols = progression => chordCycle(defaultRecipe({ progression })).map(chord => chord.symbol);
  assert.deepEqual(symbols({ kind: 'quartas' }), QUARTAS);
  assert.deepEqual(symbols({ kind: 'quintas', direction: 'descendente' }), QUARTAS);
  // Maior fora das quartas: tônicas maiores do app (C Db D Eb E F F# G Ab A Bb B).
  assert.deepEqual(symbols({ kind: 'quintas' }), ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F']);
  assert.deepEqual(symbols({ kind: 'quartas', direction: 'descendente' }), ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F']);
  assert.deepEqual(symbols({ kind: 'cromatica' }), ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']);
  // Terça menor: tônicas menores do app (C C# D Eb E F F# G G# A Bb B), inclusive nas quartas.
  assert.deepEqual(symbols({ kind: 'quartas', quality: 'minor' }), ['Cm', 'Fm', 'Bbm', 'Ebm', 'G#m', 'C#m', 'F#m', 'Bm', 'Em', 'Am', 'Dm', 'Gm']);
  assert.deepEqual(symbols({ kind: 'quartas', quality: 'm7b5' }).slice(4, 6), ['G#m7b5', 'C#m7b5']);
  assert.deepEqual(symbols({ kind: 'quartas', quality: '7' }).slice(4, 7), ['Ab7', 'Db7', 'Gb7']);
  // Grafia explícita vale; nome digitado na lista é mantido.
  assert.deepEqual(symbols({ kind: 'quartas', spelling: 'sustenidos' }), ['C', 'F', 'A#', 'D#', 'G#', 'C#', 'F#', 'B', 'E', 'A', 'D', 'G']);
  assert.deepEqual(symbols({ kind: 'quintas', spelling: 'bemois' }).slice(6, 8), ['Gb', 'Db']);
  assert.deepEqual(symbols({ kind: 'lista', chords: ['C#', 'Gb', 'A#m'] }), ['C#', 'Gb', 'A#m']);
  // Início numérico segue a mesma grafia.
  assert.equal(normalizeRecipe({ progression: { start: 1 } }).progression.start, 'Db');
  assert.equal(normalizeRecipe({ progression: { start: 1, quality: 'minor' } }).progression.start, 'C#');
  assert.equal(noteName(22, { flats: true }), 'B♭0');
  assert.equal(noteName(10, { octave: false }), 'A♯');
  assert.equal(noteName(34, { flats: true, solfege: true }), 'Si♭1');
});

test('progressões: sessão lida da timeline e lista com qualidades mistas (I–vi)', () => {
  const session = {
    bars: 4, meter: { beats: 4, unit: 4 },
    progression: {
      enabled: true, cycleBars: 4, keyId: 'c-major',
      chords: [
        { startBar: 0, durationBars: 2, root: 0, quality: 'maj7' },
        { startBar: 2, durationBars: 1, root: 5, quality: 'maj7' },
        { startBar: 3, durationBars: 1, root: 7, quality: '7' },
      ],
    },
  };
  const result = generateStudy(defaultRecipe({
    family: 'movimento_continuo_linha_4_notas', profile: bass,
    progression: { kind: 'sessao' }, bars: 3, region: region5, figure: { notes: 4 }, final: 'nenhum',
  }), { session });
  assert.deepEqual(result.chords.map(chord => chord.symbol), ['Cmaj7', 'Fmaj7', 'G7']);
  assert.equal(result.actualBars, 3);
  assertMonophonic(result.notes);
  // Arpejo na região aceita C e Am (Am = 33 36 40 em 1..5).
  const mixed = generateStudy(simple({ progression: { kind: 'lista', quality: 'major', chords: ['C', 'Am'] }, bars: null }));
  assert.deepEqual(pitches(mixed.notes), [36, 40, 43, 33, 36, 40]);
  assert.throws(() => generateStudy(simple({ progression: { kind: 'lista', quality: 'major', chords: ['C', 'Am'] }, shape: SHAPE_A })), /qualidade da forma/);
});

test('limites: 128 compassos só com voltas inteiras e sem final; 512 notas avisa sem descartar', () => {
  const capped = generateStudy(defaultRecipe({
    family: 'arpejo_triade_forma_unica', profile: bass, progression: { kind: 'quartas', quality: 'major' }, bars: 128, region: region5, voltas: 12,
  }));
  // 12 voltas x 24 + 1 = 289 > 128: para em 5 voltas (120), sem compasso final.
  assert.equal(count(capped, 'limite-128'), 1);
  assert.equal(capped.actualBars, 120);
  assert.equal(capped.slots.length, 60);
  assert.equal(capped.finalBar, null);
  assert.ok(capped.notes.every(note => note.start + note.duration <= 120 * 16));
  const warning = capped.warnings.find(item => item.code === 'limite-128');
  assert.equal(warning.needed, 289);
  assert.equal(warning.finalOmitted, true);
  assert.deepEqual(warning.action, { kind: 'reduzir-voltas', voltas: 5 }); // 5 x 24 + 1 = 121 <= 128
  assert.deepEqual(generateStudy({ ...capped.recipe, bars: null, voltas: 5 }).warnings, []);
  // 512 notas: linha de 32 colcheias (4 compassos) x 12 acordes x 2 voltas = 768 notas em 96 compassos.
  const dense = generateStudy(defaultRecipe({
    family: 'movimento_continuo_linha_4_notas', profile: bass, progression: { kind: 'quartas', quality: 'major' },
    region: region5, figure: { notes: 32 }, rhythm: 'eighths', voltas: 2, final: 'nenhum',
  }));
  assert.equal(dense.actualBars, 96);
  assert.equal(dense.notes.length, 768);
  assert.equal(count(dense, 'notas-acima-de-512'), 1);
  assert.equal(dense.notes.length, dense.slots.length * 32); // nenhuma nota descartada
});

test('notas canônicas: sem derivados, válidas para a sessão v5', () => {
  const result = generateStudy(simple());
  const canonical = canonicalNotes(result);
  for (const note of canonical) {
    assert.deepEqual(Object.keys(note).filter(key => !NOTE_KEYS.includes(key)), []);
    assert.equal(Object.hasOwn(note, 'fret'), false);
    assert.ok(Number.isInteger(note.string) && note.string >= 1 && note.string <= 4);
  }
  assert.equal(validPhrase(canonical, result.actualBars), true);
  assert.deepEqual(canonical.map(note => note.id), result.notes.map(note => note.id));
});

test('plano de slots: figura x voltas x compassos por slot + compasso final', () => {
  const plan = planSlots(defaultRecipe({ progression: { kind: 'quartas', quality: 'major' }, voltas: 2, region: region5 }));
  assert.equal(plan.slots.length, 24);
  assert.equal(plan.ticksPerSlot, 32);
  assert.equal(plan.cellsPerSlot, 3);
  assert.equal(plan.generatedBars, 48);
  assert.equal(plan.neededBars, 49);
  assert.equal(plan.finalBars, 1);
  assert.equal(plan.finalChordIndex, 0); // padrão 'tonica' = primeiro acorde (C)
  assert.equal(planSlots({ ...plan.recipe, final: 'acorde' }).finalChordIndex, 11); // último acorde tocado (G)
  assert.equal(plan.barsPerSlot, 2);
  const quarters = planSlots(defaultRecipe({
    family: 'movimento_continuo_linha_4_notas', progression: { kind: 'lista', quality: 'major', chords: ['C', 'G'] }, region: region5,
  }));
  assert.equal(quarters.ticksPerSlot, 16);
  assert.equal(quarters.neededBars, 3);
  assert.equal(quarters.cellsPerSlot, 4);
});

test('catálogo: receita só com campos de definição; derivados honestos para conferência', () => {
  const entry = {
    familia: 'arpejo_triade_formas_combinadas', qualidade: 'maior',
    sequencia_de_acordes: { cifras: [...QUARTAS, 'C'] }, regiao_do_braco: { declarada: { de: 1, ate: 5 }, observada_na_tab: { de: 1, ate: 5 } },
    compassos_por_acorde: 2, contorno: { padrao: 'T-3-5' },
    figura_ritmica: { padrao_codigo: 'q q h | h(lig) pausa_h', compasso_final: 'w' }, total_de_compassos: 25,
  };
  const recipe = recipeFromCatalog(entry);
  // A última cifra = acorde final (não uma 13ª fundamental); total observado NÃO entra.
  assert.equal(recipe.progression.chords.length, 12);
  assert.equal(recipe.final, 'tonica');
  assert.equal(recipe.bars, null);
  assert.deepEqual(recipe.figure.degrees, [1, 3, 5]);
  const values = catalogValues(recipe);
  assert.equal(values.bars, 25);
  assert.deepEqual(values.stringNames, ['G', 'D', 'A', 'E']);
  assert.deepEqual([values.minFret, values.maxFret], [1, 5]);
  assert.equal(values.rhythmCode, 'q q h | h(lig) pausa_h');
  assert.deepEqual(values.degreeOrder, [1, 3, 5]);
  assert.equal(values.noteCount, 37);
  // Contorno "3-5-T" sobe a tônica uma oitava; inversões dividem os compassos do acorde.
  assert.deepEqual(catalogContour('3-5-T').degrees, [3, 5, 1]);
  assert.deepEqual(recipeFromCatalog({ ...entry, familia: 'arpejo_triade_forma_unica', contorno: { padrao: '3-5-T' } }).figure.degrees, [3, 5, 8]);
  assert.equal(recipeFromCatalog({ ...entry, familia: 'arpejo_tres_inversoes_por_acorde', compassos_por_acorde: 3 }).figure.bars, 1);
  // `inversao` = qual inversão (não contagem): 0 não lança.
  assert.deepEqual(recipeFromCatalog({ familia: 'arpejo_triade_forma_unica', qualidade: 'maior', inversao: 1, sequencia_de_acordes: { cifras: ['C'] } }).figure.degrees, [3, 5, 8]);
  assert.doesNotThrow(() => recipeFromCatalog({ familia: 'arpejo_triade_forma_unica', qualidade: 'maior', inversao: 0, sequencia_de_acordes: { cifras: ['C'] } }));
  // Regra textual e 5 cordas: linha contínua "até fechar o período".
  const five = recipeFromCatalog({ familia: 'movimento_continuo_linha_4_notas', qualidade: 'maior', origem_tipo: '5cordas', sequencia_de_acordes: { regra: 'ciclo de quartas' } });
  assert.equal(five.profile.strings, 5);
  assert.equal(five.voltas, 'periodo');
  assert.equal(five.progression.kind, 'quartas');
  // Lista que se repete inteira = voltas.
  const repeated = recipeFromCatalog({ familia: 'movimento_continuo_linha_4_notas', qualidade: 'maior', sequencia_de_acordes: { cifras: ['C', 'G', 'C', 'G'] } });
  assert.deepEqual([repeated.progression.chords.length, repeated.voltas], [2, 2]);
  // Qualidade mista vem das cifras.
  const mixed = recipeFromCatalog({ familia: 'movimento_continuo_linha_4_notas', qualidade: 'mista', sequencia_de_acordes: { cifras: ['C', 'Am', 'Dm', 'G7'] } });
  assert.deepEqual(mixed.progression.chords.map(chord => chord.quality), ['major', 'minor', 'minor', '7']);
  assert.equal(normalizeRhythmCode('Q Q H | H (lig) pausa h'), 'q q h | h(lig) pausa_h');
  assert.equal(normalizeRhythmCode('q q h | x'), null);
  assert.throws(() => recipeFromCatalog({ familia: 'arpejo_de_curso', qualidade: 'maior' }), /Família de catálogo/);
  assert.throws(() => recipeFromCatalog({ familia: 'arpejo_triade_forma_unica', qualidade: 'lídio' }), /Qualidade de catálogo/);
  // Forma fornecida pelo material (binding do A5) é usada como está.
  const bound = recipeFromCatalog({
    familia: 'arpejo_triade_forma_unica', qualidade: 'maior', sequencia_de_acordes: { cifras: ['C', 'G'] },
    forma: { notas: [{ corda: 4, casa: 3, grau: 1 }, { corda: 3, casa: 2, grau: 3 }, { corda: 3, casa: 5, grau: 5 }] },
  });
  const boundNotes = generateStudy(bound).notes;
  assert.deepEqual(places(boundNotes), [[4, 8], [3, 7], [3, 10], [4, 3], [3, 2], [3, 5]]);
  assert.deepEqual(pitches(boundNotes), [36, 40, 43, 31, 35, 38]);
});

test('nada de sessão: a receita é serializável e não toca extensions', () => {
  const recipe = defaultRecipe(simple());
  assert.equal(Object.hasOwn(recipe, 'extensions'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(recipe)).family, recipe.family);
  assert.equal(Object.isFrozen(recipe), true);
  assert.ok(STUDY_WARNING_CODES.every(code => typeof code === 'string'));
  assert.deepEqual(defaultRecipe(simple()).figure.degrees, [1, 3, 5]);
  assert.equal(normalizeRecipe(defaultRecipe(simple())).region.to, 5);
});
