// A4 — Testes da camada de receita da interface (presets, controles <->
// receita, ações corretivas e as 12 tonalidades). Só invariantes que valem a
// pena: a matemática musical é do A2, aqui só se confere que a tradução não
// inventa nem perde nada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_NAME_MAX } from '../src/session.js';
import { STUDY_FAMILIES, STUDY_MAX_BARS, defaultRecipe, normalizeRecipe, chordCycle, generateStudy } from '../src/study-generator.js';
import {
  STUDY_PRESET_IDS, STUDY_PRESETS, applyWarningAction, canTransposeProgression, controlsToRecipe, defaultControls, figureBarsLimit,
  isCycleProgression, isShapeFamily, otherKeyRecipes, presetControls, presetRecipe, recipeGroupLabel,
  recipeSummary, recipeTitle, recipeToControls,
} from '../src/study-recipe.js';

// Mesmo token de voltas do contrato da receita (STUDY_PERIOD no motor).
const PERIOD = 'periodo';

const bass4 = { type: 'bass', strings: 4 };
const bass5 = { type: 'bass', strings: 5 };
const ROUND_TRIP = {
  version: 1, family: 'arpejo_triade_forma_unica', profile: bass4,
  progression: { kind: 'quartas', start: 'C', direction: 'ascendente', quality: 'major', chords: [], length: null, spelling: 'auto' },
  bars: 25, region: { from: 1, to: 5, open: false, strings: null }, shape: null,
  figure: { degrees: [1, 3, 5], inversions: 3, notes: 4, order: 'sobe', bars: 2 },
  rhythm: 'arpejo', voltas: 1, final: 'acorde',
};

test('os três presets são receitas válidas: arpejo 25 compassos, linha contínua 13 e sobe-desce', () => {
  assert.deepEqual(STUDY_PRESETS.map(preset => preset.id), ['arpejo-quartas', 'continuo', 'sobe-desce']);
  assert.equal(STUDY_PRESET_IDS.includes('personalizado'), true);
  assert.deepEqual(STUDY_PRESETS.map(preset => preset.label), [
    'Arpejo pelo ciclo de quartas', 'Linha contínua numa região', 'Sobe e desce numa região',
  ]);
  const byId = Object.fromEntries(STUDY_PRESETS.map(preset => [preset.id, presetRecipe(preset.id)]));
  // Arpejo T-3-5 no ciclo de quartas, 2 compassos por acorde e acorde final: 25.
  assert.equal(byId['arpejo-quartas'].family, 'arpejo_triade_forma_unica');
  assert.equal(byId['arpejo-quartas'].rhythm, 'arpejo');
  assert.equal(byId['arpejo-quartas'].figure.bars, 2);
  assert.deepEqual(byId['arpejo-quartas'].figure.degrees, [1, 3, 5]);
  assert.equal(byId['arpejo-quartas'].bars, 25);
  // Linha contínua de 4 notas na região 1–5, 1 compasso por acorde: 13.
  assert.equal(byId.continuo.family, 'movimento_continuo_linha_4_notas');
  assert.equal(byId.continuo.figure.notes, 4);
  assert.equal(byId.continuo.figure.bars, 1);
  assert.equal(byId.continuo.bars, 13);
  assert.deepEqual(byId.continuo.region, { from: 1, to: 5, open: false, strings: null });
  // Sobe e desce na mesma região: o período é da família.
  assert.equal(byId['sobe-desce'].family, 'movimento_continuo_grave_agudo_grave');
  assert.equal(byId['sobe-desce'].figure.order, 'sobe-desce');
  assert.deepEqual(byId['sobe-desce'].region, { from: 1, to: 5, open: false, strings: null });
  for (const recipe of Object.values(byId)) {
    assert.equal(STUDY_FAMILIES.includes(recipe.family), true);
    assert.equal(recipe.final, 'tonica', 'o acorde final repete o primeiro acorde da progressão');
    assert.ok(generateStudy(recipe).notes.length > 0);
  }
  const arpejo = generateStudy(byId['arpejo-quartas']);
  assert.equal(arpejo.actualBars, 25);
  assert.equal(arpejo.chords[0].root, 0);
  assert.equal(arpejo.chords[arpejo.chords.length - 1]?.final === true || arpejo.notes[arpejo.notes.length - 1].chordIndex === 0, true, 'a nota final é do PRIMEIRO acorde');
});

test('controles -> receita -> controles devolve a MESMA receita (os presets e uma receita qualquer)', () => {
  for (const preset of STUDY_PRESETS) {
    const recipe = presetRecipe(preset.id);
    assert.deepEqual(controlsToRecipe(recipeToControls(recipe)), normalizeRecipe(recipe), preset.id);
  }
  assert.deepEqual(controlsToRecipe(recipeToControls(ROUND_TRIP)), normalizeRecipe(ROUND_TRIP));
  const controls = recipeToControls(ROUND_TRIP);
  assert.equal(controls.progression, 'quartas');
  assert.equal(controls.regionFrom, 1);
  assert.equal(controls.regionTo, 5);
  assert.equal(controls.bars, 25);
  assert.equal(controls.voltas, 1);
  assert.equal(controls.chords, '', 'progressão em ciclo não tem lista de acordes');
  assert.deepEqual(controls.shapeIds, []);
});

test('lista de acordes, ciclo e cordas viajam pelo formulário', () => {
  const controls = {
    ...recipeToControls(ROUND_TRIP),
    progression: 'lista', chords: 'C, Am, Dm7, G7', cycleLength: 4,
    regionStrings: '1,2,3', regionOpen: true, regionFrom: 0, regionTo: 7,
  };
  const recipe = controlsToRecipe(controls);
  assert.equal(recipe.progression.kind, 'lista');
  assert.deepEqual(recipe.progression.chords.map(chord => [chord.root, chord.quality]), [[0, 'major'], [9, 'minor'], [2, 'm7'], [7, '7']]);
  assert.equal(recipe.progression.length, 4);
  assert.deepEqual(recipe.region, { from: 0, to: 7, open: true, strings: [1, 2, 3] });
  // Volta ao formulário com o mesmo texto de acordes.
  assert.equal(recipeToControls(recipe).chords, 'C, Am, Dm7, G7');
});

test('o formulário recusa o que a receita recusa, com mensagem em português', () => {
  const base = recipeToControls(ROUND_TRIP);
  assert.throws(() => controlsToRecipe({ ...base, regionFrom: 9, regionTo: 3 }), /casa inicial menor ou igual/);
  assert.throws(() => controlsToRecipe({ ...base, bars: String(STUDY_MAX_BARS + 1) }), /compassos/);
  assert.throws(() => controlsToRecipe({ ...base, voltas: '' }), /voltas/);
  assert.throws(() => controlsToRecipe({ ...base, voltas: '0' }), /voltas/);
  assert.throws(() => controlsToRecipe({ ...base, voltas: '65' }), /voltas/);
  assert.throws(() => controlsToRecipe({ ...base, degrees: '2,9' }), /Grau/);
  assert.throws(() => controlsToRecipe({ ...base, progression: 'lista', chords: '' }), /lista/);
  assert.throws(() => controlsToRecipe({ ...base, regionStrings: '1,1' }), /distintas/);
  assert.throws(() => controlsToRecipe({ ...base, regionStrings: '5' }), /4 corda/);
  assert.throws(() => controlsToRecipe({ ...base, progression: 'lista', chords: 'C6' }), /Qualidade não suportada/);
  assert.throws(() => controlsToRecipe({ ...base, progression: 'lista', chords: 'H7' }), /Cifra não reconhecida/);
  assert.equal(controlsToRecipe({ ...base, voltas: 'periodo' }).voltas, PERIOD);
  assert.equal(recipeToControls(controlsToRecipe({ ...base, voltas: 'periodo' })).voltas, PERIOD);
});

test('nos percursos a ordem é da família: ordem digitada não entra na receita', () => {
  const percurso = presetControls('sobe-desce');
  const recipe = controlsToRecipe({ ...percurso, order: 'desce' });
  assert.equal(recipe.figure.order, 'sobe-desce');
  const back = controlsToRecipe({ ...percurso, family: 'movimento_continuo_agudo_grave_agudo', order: 'sobe' });
  assert.equal(back.figure.order, 'desce-sobe');
  // O "linha de 4 notas" aceita ordem digitada.
  assert.equal(controlsToRecipe({ ...presetControls('continuo'), order: 'desce' }).figure.order, 'desce');
});

test('movimento contínuo ignora graus digitados e só aceita semínimas/colcheias', () => {
  const continuous = presetControls('continuo');
  const recipe = controlsToRecipe({ ...continuous, degrees: '1,7' });
  assert.notDeepEqual(recipe.figure.degrees, [1, 7], 'graus digitados não valem no contínuo');
  assert.throws(() => controlsToRecipe({ ...continuous, rhythm: 'arpejo' }), /movimento contínuo/);
});

test('forma escolhida manda na qualidade e nos graus; família sem forma não leva forma', () => {
  const shape = { id: 'forma-x', label: 'Forma de teste', quality: 'minor', degrees: [1, 3, 5], notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }] };
  const controls = { ...presetControls('arpejo-quartas'), shapeIds: ['forma-x'], quality: 'major' };
  const recipe = controlsToRecipe(controls, { shapeLookup: id => (id === 'forma-x' ? shape : null) });
  assert.equal(recipe.progression.quality, 'minor', 'a forma traz a qualidade');
  assert.equal(recipe.figure.degrees, null, 'com forma, os graus (e a ORDEM deles) vêm da forma — a tela não inventa um 1,3,5');
  assert.equal(recipe.shape.id, 'forma-x');
  assert.throws(() => controlsToRecipe({ ...controls, shapeIds: ['sumida'] }, { shapeLookup: () => null }), /não está mais disponível/);
  // A mesma escolha numa família contínua é descartada (forma exige família de forma).
  const continuous = controlsToRecipe({ ...presetControls('continuo'), shapeIds: ['forma-x'] }, { shapeLookup: () => shape });
  assert.equal(continuous.shape, null);
});

test('as formas ESCOLHIDAS são a figura: sem contagem própria, e as inversões acompanham a seleção', () => {
  const shape = id => ({ id, label: id, quality: 'major', degrees: [1, 3, 5], notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }] });
  const lookup = id => shape(id);
  // Formas combinadas: a figura toca as DUAS formas escolhidas no mesmo bloco.
  // Não existe contagem para digitar — o motor não tem esse campo e um controle
  // assim não mudaria nada.
  const combined = { ...presetControls('arpejo-quartas'), family: 'arpejo_triade_formas_combinadas', shapeIds: ['a', 'b'] };
  const combinedRecipe = controlsToRecipe(combined, { shapeLookup: lookup });
  assert.equal(combinedRecipe.shapes.length, 2);
  assert.equal(Object.hasOwn(combinedRecipe.figure, 'shapes'), false, 'a figura não carrega contagem de formas');
  assert.deepEqual(recipeToControls(combinedRecipe).shapeIds, ['a', 'b'], 'a seleção volta inteira para a tela');
  const combinedResult = generateStudy(combinedRecipe);
  const playedChords = combinedResult.chords.filter(chord => chord.final !== true).length;
  assert.equal(combinedResult.slots.length, playedChords, 'uma posição por acorde: as formas se combinam no mesmo bloco');
  // Inversões: uma forma por inversão quando há várias.
  const inverted = { ...presetControls('arpejo-quartas'), family: 'arpejo_tres_inversoes_por_acorde', shapeIds: ['a', 'b', 'c'], inversions: 2 };
  const recipe = controlsToRecipe(inverted, { shapeLookup: lookup });
  assert.equal(recipe.figure.inversions, 3, 'três formas = três inversões, uma por slot');
  assert.equal(recipe.shapes.length, 3);
  assert.equal(isShapeFamily(recipe.family), true);
  // Uma forma só: a contagem digitada continua (o motor gira a MESMA forma).
  const single = controlsToRecipe({ ...presetControls('arpejo-quartas'), family: 'arpejo_tres_inversoes_por_acorde', shapeIds: ['a'], inversions: 3 }, { shapeLookup: lookup });
  assert.equal(single.figure.inversions, 3);
  assert.equal(single.shapes.length, 1);
});

test('arpejo de REGIÃO aceita o ciclo misto (I–vi–ii–V); só a forma FÍSICA exige qualidade única', () => {
  const controls = { ...presetControls('arpejo-quartas'), progression: 'lista', chords: 'C, Am, Dm7, G7', bars: null, final: 'nenhum' };
  const recipe = controlsToRecipe(controls);
  assert.equal(recipe.shape, null);
  const result = generateStudy(recipe);
  assert.deepEqual(result.chords.map(chord => chord.symbol), ['C', 'Am', 'Dm7', 'G7']);
  assert.deepEqual(result.chords.map(chord => chord.quality), ['major', 'minor', 'm7', '7']);
  assert.ok(result.notes.length > 0, 'o ciclo misto sai com notas — nada de recusa na região');
  assert.equal(result.warningCounts['forma-divergente'], undefined);
  // Com uma forma de dedilhado a qualidade é única: a MESMA lista é recusada
  // pela regra da forma (não pela região), com a mensagem do motor.
  const shape = { id: 'f', label: 'Forma', quality: 'major', degrees: [1, 3, 5], notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }] };
  assert.throws(
    () => controlsToRecipe({ ...controls, shapeIds: ['f'] }, { shapeLookup: () => shape }),
    /qualidade da forma/,
  );
});

test('a forma manda nos graus NA ORDEM escrita; sem forma, o padrão do final é repetir o primeiro acorde', () => {
  const shape = {
    id: 'ordem', label: 'Forma em ordem própria', quality: 'major', degrees: [5, 1, 8],
    notes: [{ string: 3, fret: 0, degree: 5 }, { string: 4, fret: 3, degree: 1 }, { string: 2, fret: 1, degree: 8 }],
  };
  const controls = { ...presetControls('arpejo-quartas'), shapeIds: ['ordem'], progression: 'lista', chords: 'C', bars: null };
  const recipe = controlsToRecipe(controls, { shapeLookup: () => shape });
  assert.equal(recipe.figure.degrees, null, 'os graus vêm da forma, não de um 1,3,5 inventado');
  assert.equal(recipeToControls(recipe).degrees, '', 'a tela não repõe graus por cima da ordem da forma');
  assert.deepEqual(generateStudy(recipe).meta.degreeOrder, [5, 1, 8], 'a ordem escrita na forma é a ordem tocada');
  // Sem `final` na receita, o padrão do pedido é repetir o PRIMEIRO acorde.
  const lookup = { shapeLookup: () => shape };
  assert.equal(controlsToRecipe({ ...controls, final: undefined }, lookup).final, 'tonica');
  assert.equal(controlsToRecipe({ ...controls, final: 'acorde' }, lookup).final, 'acorde', 'a escolha explícita continua valendo');
});

test('percurso aceita o mínimo maior que 4 (teto dinâmico); arpejo continua em 4', () => {
  // 5 cordas, Dó na região 1–12: a escada inteira do acorde são 17 semínimas =
  // 5 compassos por bloco. O controle mostra 1–4 em repouso, mas o aviso do
  // motor pede 5 e a correção precisa caber.
  const percurso = { ...presetControls('sobe-desce', { profile: bass5 }), regionFrom: 1, regionTo: 12, figureBars: 1 };
  const recipe = controlsToRecipe(percurso);
  const result = generateStudy(recipe);
  const warning = result.warnings.find(item => item.code === 'aumentar-compassos' && item.scope === 'figura');
  assert.equal(warning.minimumFigureBars, 5, 'a escada de 17 semínimas não cabe em 4 compassos');
  assert.equal(warning.action.figureBars, 5);
  const fixed = applyWarningAction(recipe, warning.action);
  assert.equal(fixed.recipe.figure.bars, 5);
  assert.match(fixed.label, /Aumentar para 5 compassos por acorde/);
  const fixedResult = generateStudy(fixed.recipe);
  assert.deepEqual(fixedResult.warnings, [], 'a correção resolve o aviso sem mexer no ritmo');
  assert.equal(fixedResult.meta.figureBars, 5);
  assert.equal(fixedResult.notes.filter(note => note.slotIndex === 0).length, 17, 'as 17 semínimas do primeiro acorde continuam lá');
  // O formulário aceita o número maior que 4 no percurso — sem corte arbitrário.
  assert.equal(controlsToRecipe({ ...recipeToControls(fixed.recipe), figureBars: 5 }).figure.bars, 5);
  // O teto do controle é o da FAMÍLIA (percurso até 128, arpejo 4) e nunca fica
  // abaixo do mínimo pedido nem do valor já resolvido — nada de corte arbitrário.
  assert.equal(figureBarsLimit({ family: recipe.family }), 128);
  assert.equal(figureBarsLimit({ family: recipe.family, minimumFigureBars: 5, current: 5 }), 128);
  assert.equal(figureBarsLimit({ family: 'arpejo_triade_forma_unica' }), 4, 'o arpejo continua com teto 4');
  assert.equal(figureBarsLimit({ family: 'arpejo_triade_forma_unica', minimumFigureBars: 5, current: 5 }), 5);
  assert.throws(() => controlsToRecipe({ ...percurso, family: 'arpejo_triade_forma_unica', figureBars: 5 }), /1 a 4/);
});

test('ações corretivas mexem na receita e nunca existem sem efeito', () => {
  const recipe = defaultRecipe({ ...ROUND_TRIP, bars: 4 });
  // O total que o motor propõe CONTA o compasso final (24 de ciclo + 1).
  const raised = applyWarningAction(recipe, { kind: 'aumentar-compassos', bars: 25 });
  assert.equal(raised.recipe.bars, 25);
  assert.match(raised.label, /Aumentar para 25 compassos/);
  const figureRaised = applyWarningAction(recipe, { kind: 'aumentar-compassos', scope: 'figura', figureBars: 3 });
  assert.equal(figureRaised.recipe.figure.bars, 3);
  assert.equal(figureRaised.recipe.bars, 4, 'escopo figura não mexe nos compassos da receita');
  assert.match(figureRaised.label, /Aumentar para 3 compassos por acorde/);
  const widened = applyWarningAction(recipe, { kind: 'expandir-regiao', region: { from: 1, to: 9, open: false, strings: [1, 2, 3] } });
  assert.deepEqual(widened.recipe.region, { from: 1, to: 9, open: false, strings: [1, 2, 3] });
  const fewer = applyWarningAction({ ...recipe, voltas: 4 }, { kind: 'reduzir-voltas', voltas: 2 });
  assert.equal(fewer.recipe.voltas, 2);
  assert.match(fewer.label, /2 voltas/);
  assert.equal(applyWarningAction({ ...recipe, voltas: 2 }, { kind: 'reduzir-voltas', voltas: 2 }), null, 'sem redução: nada de botão sem efeito');
  assert.equal(applyWarningAction({ ...recipe, voltas: PERIOD }, { kind: 'reduzir-voltas', voltas: 3 }).recipe.voltas, 3);
  assert.equal(applyWarningAction(recipe, { kind: 'aumentar-compassos', figureBars: recipe.figure.bars }), null, 'figura já no tamanho pedido: sem mudança, sem botão');
  // 128 compassos estourados: corta o ciclo, não as voltas.
  const listed = defaultRecipe({
    ...ROUND_TRIP, bars: null, progression: { kind: 'lista', quality: 'major', chords: Array.from({ length: 40 }, (_, index) => ({ root: index % 12, quality: 'major' })) }, region: { from: 1, to: 5, open: false },
  });
  // "Nem uma volta cabe": o gerador manda quantos acordes do ciclo cabem.
  const shortened = applyWarningAction(listed, { kind: 'reduzir-voltas', voltas: 1, length: 12 });
  assert.equal(shortened.recipe.progression.length, 12);
  assert.match(shortened.label, /12 acordes/);
  assert.equal(applyWarningAction(listed, { kind: 'reduzir-voltas', voltas: listed.voltas }), null, 'nada a reduzir: sem botão');
  // Graus da forma.
  const shaped = applyWarningAction(defaultRecipe({ ...ROUND_TRIP, shape: { quality: 'major', notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }] } }), { kind: 'usar-graus-da-forma', degrees: [1, 3, 5] });
  assert.equal(shaped, null, 'a receita já usava os graus da forma: sem botão morto');
  // Limite de notas: sem voltas para cortar, corta inversões.
  const limited = applyWarningAction(defaultRecipe({ ...ROUND_TRIP, family: 'arpejo_tres_inversoes_por_acorde', voltas: 1, figure: { degrees: [1, 3, 5], inversions: 3, bars: 2, order: 'sobe' } }), { kind: 'aumentar-limite', limit: 512 });
  assert.equal(limited.recipe.figure.inversions, 2, 'sem voltas para cortar, corta inversões');
  assert.equal(applyWarningAction(recipe, { kind: 'desconhecida' }), null);
  assert.equal(applyWarningAction(recipe, { kind: 'trocar-forma', shapeIndex: 1 }), null, 'trocar forma é escolha do usuário');
});

test('nas 12 tonalidades: a MESMA lista transposta para as outras 11, sem mexer no original', () => {
  // I–vi–ii–V em C: é o exemplo do pedido (progressão que não é um ciclo).
  const recipe = defaultRecipe({
    ...ROUND_TRIP,
    progression: { kind: 'lista', quality: 'major', chords: [{ root: 0, quality: 'major' }, { root: 9, quality: 'minor' }, { root: 2, quality: 'minor' }, { root: 7, quality: '7' }] },
    bars: null,
  });
  assert.equal(canTransposeProgression(recipe), true);
  const others = otherKeyRecipes(recipe);
  assert.equal(others.length, 11);
  const firsts = [recipe, ...others].map(item => item.progression.chords[0].root);
  assert.equal(new Set(firsts).size, 12, 'as 12 tonalidades, sem repetir');
  assert.deepEqual([...firsts].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  // Os graus e as qualidades acompanham a transposição: o mesmo exercício na
  // outra tonalidade (a fundamental sobe, a qualidade de cada acorde fica).
  const transposed = others[1];
  assert.deepEqual(transposed.progression.chords.map(chord => [chord.root, chord.quality]), [[2, 'major'], [11, 'minor'], [4, 'minor'], [9, '7']]);
  assert.equal(others.every(item => item.family === recipe.family && item.rhythm === recipe.rhythm), true);
  assert.deepEqual(recipe.progression.chords.map(chord => chord.root), [0, 9, 2, 7], 'a receita original não muda');
  // Um ciclo já percorre as 12 tonalidades; a progressão da sessão não tem lista.
  assert.deepEqual(otherKeyRecipes(defaultRecipe(ROUND_TRIP)), []);
  assert.equal(canTransposeProgression(defaultRecipe(ROUND_TRIP)), false);
  assert.equal(canTransposeProgression(defaultRecipe({ ...ROUND_TRIP, progression: { kind: 'sessao' } })), false);
  assert.match(recipeGroupLabel(recipe), /Nas 12 tonalidades/);
});

test('rótulos e resumo dizem o que o exercício é, sem passar do teto do nome', () => {
  for (const key of ['C', 'Db', 'F#', 'B']) {
    for (const preset of STUDY_PRESETS) {
      const recipe = presetRecipe(preset.id, { start: key, quality: 'maj7' });
      const title = recipeTitle(recipe);
      assert.ok(title.length <= SESSION_NAME_MAX, `${title} (${title.length})`);
      assert.match(title, /Ciclo de quartas/);
    }
  }
  assert.match(recipeGroupLabel(defaultRecipe(ROUND_TRIP)), /12 tonalidades/);
  const result = generateStudy(defaultRecipe({ ...ROUND_TRIP, bars: 25 }));
  const summary = recipeSummary(defaultRecipe({ ...ROUND_TRIP, bars: 25 }), result);
  assert.match(summary, /25 compassos/);
  assert.match(summary, /12 acordes/);
  assert.match(summary, /37 notas/);
  assert.match(summary, /cordas 1,2,3,4/);
});

test('receita vinda do CURSO (cifras em texto e shapeLabel) abre no diálogo sem quebrar', () => {
  // Schema do documento do curso (etapa 5): `progression.chords` é lista de
  // CIFRAS e existe `shapeLabel`, que o motor não conhece. A tela precisa
  // aceitar essa receita (é o caminho "Ajustar no Estúdio de estudo" da aula).
  const course = {
    version: 1, family: 'arpejo_triade_forma_unica', profile: bass4,
    progression: { kind: 'lista', quality: 'major', chords: ['C', 'Am', 'Dm7', 'G7'], length: 4, start: 'C' },
    bars: null, region: { from: 1, to: 5, open: false, strings: null }, shapeLabel: 'Forma 1',
    figure: { degrees: null, inversions: 1, notes: 4, order: 'sobe', bars: 1 },
    rhythm: 'arpejo', voltas: 1, final: 'tonica',
  };
  const controls = recipeToControls(course);
  assert.equal(controls.chords, 'C, Am, Dm7, G7', 'as cifras em texto voltam ao campo da lista');
  const recipe = controlsToRecipe(controls);
  assert.equal(Object.hasOwn(recipe, 'shapeLabel'), false, 'shapeLabel é do curso e não vai para o motor');
  assert.equal(recipe.progression.kind, 'lista');
  assert.ok(generateStudy(recipe).notes.length > 0, 'a receita do curso gera material no diálogo');
});

test('controles padrão são um preset válido e o ciclo de quartas é o esperado', () => {
  const controls = defaultControls({ profile: bass5 });
  assert.equal(controls.preset, 'personalizado');
  const recipe = controlsToRecipe(controls);
  assert.equal(recipe.profile.strings, 5);
  assert.deepEqual(chordCycle(recipe).map(chord => chord.root), [0, 5, 10, 3, 8, 1, 6, 11, 4, 9, 2, 7]);
  assert.deepEqual(recipeToControls(recipe).shapeIds, []);
});
