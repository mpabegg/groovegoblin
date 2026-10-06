import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_FAMILIES, CATALOG_LABEL_SHAPE_FAMILIES, CATALOG_LIMITS, CATALOG_MAX_FIGURE_BARS,
  CATALOG_MAX_PERCURSO_FIGURE_BARS, CATALOG_PERIOD, applyCatalog, catalogMaxFigureBars,
  catalogRecipeFromEntry, catalogSuggestion, generatorRecipe, normalizeCatalogRecipe, recipeNeedsShape,
  shapeLabelKey,
} from '../src/course-catalog.js';
import { generateStudy, maxFigureBars, STUDY_MAX_FIGURE_BARS, STUDY_MAX_PERCURSO_FIGURE_BARS } from '../src/study-generator.js';

// Catálogo 100% FICTÍCIO (curso de exemplo, example.invalid). Nenhum dado de
// curso real entra aqui — nem título, nem cifra do curso, nem nome de arquivo.
// O que os testes fixam é o ENCONTRO com o motor: a receita que sai da entrada
// é GERADA de verdade (`generateStudy`) e os compassos/notas/avisos conferidos
// são os do motor, não uma cópia do módulo.

const CYCLE = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'B', 'E', 'A', 'D', 'G', 'C'];
const MINOR_CYCLE = ['Cm', 'Fm', 'Bbm', 'Ebm', 'Abm', 'Dbm', 'Gbm', 'Bm', 'Em', 'Am', 'Dm', 'Gm', 'Cm'];

// Molde de tríade maior do app (baixo de 4 cordas): tônica em (4,3), terça em
// (3,2), quinta em (3,5).
const MAJOR_SHAPE = {
  id: 'bass4-maior-fundamental',
  label: 'Maior · fundamental',
  quality: 'major',
  degrees: [1, 3, 5],
  notes: [{ string: 4, fret: 3, degree: 1 }, { string: 3, fret: 2, degree: 3 }, { string: 3, fret: 5, degree: 5 }],
};

function entry(overrides = {}) {
  return {
    id: 'cat-1',
    origem_tipo: 'workbook',
    familia: 'arpejo_triade_forma_unica',
    aula_id: 7,
    nome_do_exercicio: 'Exercício fictício',
    pagina_do_pdf: 12,
    qualidade: 'maior',
    inversao: 'fundamental',
    forma: { forma: 'Shape 1', dedilhado_no_texto: 'descrição fictícia' },
    // A forma única do catálogo não declara a região: o motor usa 1–12 (a
    // posição mais grave em que a forma cabe). `observada_na_tab` é CONFERÊNCIA.
    regiao_do_braco: { declarada: null, observada_na_tab: { de: 1, ate: 5 } },
    sequencia_de_acordes: { regra: 'ciclo de quartas a partir de C', cifras: CYCLE },
    compassos_por_acorde: 2,
    total_de_compassos: 25,
    formula_de_compasso: '4/4',
    andamento_escrito: '♩ = 110',
    modo_de_pratica: 'com metrônomo',
    faixas_indicadas: ['faixa-ficticia.mp3'],
    figura_ritmica: { padrao_codigo: 'q q h | h(lig) pausa_h', muda: false, variantes: [], compasso_final: 'w' },
    contorno: { padrao: 'T-3-5', varia: false, variantes: [] },
    cordas_usadas: ['G', 'D', 'A', 'E'],
    extensao_em_casas: { menor: 1, maior: 5, amplitude: 4 },
    igual_a: null,
    semelhante_a: null,
    comparacao_4_cordas: null,
    ...overrides,
  };
}

function lesson(id, overrides = {}) {
  return {
    id, title: `Aula ${id}`, url: null, type: 'aula', videoSeconds: null, hasVideo: false,
    summary: null, practiceInstruction: null, key: null, chordFormula: null, tuning: null,
    techniques: [], initialBpm: null, targetBpm: null, resources: [], resourceRefs: [],
    suggestedExercises: [{ id: `sugestao-${id}`, title: 'Sugestão do mapa', description: null, initialBpm: null, targetBpm: null, bars: null, trackNames: [], pdfPage: null, strings: null, recipe: null, practiceMode: null, catalogId: null, variantOf: null }],
    ...overrides,
  };
}

function course(lessons) {
  return {
    id: 'curso-exemplo',
    title: 'Curso de Exemplo',
    author: null,
    url: null,
    instrument: 'bass',
    strings: 4,
    language: null,
    dailyMinutes: null,
    summary: null,
    catalog: null,
    sections: [{ id: 'modulo-1', title: 'Módulo 1', type: 'módulo', week: null, summary: null, objective: null, prerequisites: [], lessons }],
  };
}

// Gera o material do jeito que a página da aula gera: receita do catálogo ->
// `generatorRecipe` (com a forma quando o rótulo existe) -> `generateStudy`.
function generate(recipe, shape = null) {
  return generateStudy(generatorRecipe(recipe, shape === null ? {} : { shape }));
}

const warningCodes = out => [...new Set(out.warnings.map(warning => warning.code))];

// ------------------------------------------------ receita a partir da entrada

test('a receita da forma única vem do motor: ciclo em lista, contorno e compasso final', () => {
  const { recipe, reason } = catalogRecipeFromEntry(entry());
  assert.equal(reason, null);
  assert.equal(recipe.family, 'arpejo_triade_forma_unica');
  assert.deepEqual(recipe.profile, { type: 'bass', strings: 4 });
  // As cifras do catálogo são a progressão: o ciclo escrito vira a lista que o
  // motor toca (sem repetir o acorde final) e `compasso_final` vira o final.
  assert.equal(recipe.progression.kind, 'lista');
  assert.deepEqual(recipe.progression.chords, CYCLE.slice(0, 12));
  assert.equal(recipe.progression.quality, 'major');
  assert.equal(recipe.rhythm, 'arpejo');
  assert.equal(recipe.figure.bars, 2);
  // O contorno "T-3-5" vira a ordem de graus ACOIMA do anterior (a do motor).
  assert.deepEqual(recipe.figure.degrees, [1, 3, 5]);
  assert.equal(recipe.figure.notes, 4);
  assert.equal(recipe.final, 'tonica');
  assert.equal(recipe.voltas, 1);
  // A região de ENTRADA é a declarada; sem declarada, o padrão do motor (1–12)
  // — `observada_na_tab` é conferência e não vira receita.
  assert.deepEqual(recipe.region, { from: 1, to: 12, open: false, strings: null });
  assert.deepEqual(recipe.shapeLabel, { label: 'Shape 1', quality: 'major', inversion: 'fundamental' });
  assert.equal(recipeNeedsShape(recipe), true);
  // Nada de `figure.shapes` (o motor rejeita o campo): a figura guardada tem só
  // os cinco campos do contrato.
  assert.deepEqual(Object.keys(recipe.figure).sort(), ['bars', 'degrees', 'inversions', 'notes', 'order']);
  assert.equal(normalizeCatalogRecipe(recipe).ok, true);
  // Critério do pedido: arpejo T-3-5 pelo ciclo de quartas, 2 compassos por
  // acorde, com acorde final = 25 compassos e 37 notas.
  const out = generate(recipe, MAJOR_SHAPE);
  assert.equal(out.actualBars, 25);
  assert.equal(out.notes.length, 37);
  // O molde do app não cabe inteiro em 1–12 para três fundamentais: o motor
  // NÃO trunca (as 37 notas saem), ele avisa e a ação amplia a região.
  assert.deepEqual(warningCodes(out), ['sem-posicao']);
  assert.deepEqual(out.warnings.map(warning => warning.chord).sort(), ['E', 'Eb', 'F']);
  for (const warning of out.warnings) assert.equal(warning.action.kind, 'expandir-regiao');
});

test('a região declarada manda e o acorde final só conta quando o catálogo o indica', () => {
  const comRegiao = catalogRecipeFromEntry(entry({
    familia: 'movimento_continuo_linha_4_notas',
    forma: null,
    regiao_do_braco: { declarada: { de: 1, ate: 5 }, observada_na_tab: { de: 1, ate: 9 } },
    compassos_por_acorde: 1,
    contorno: { padrao: null },
  })).recipe;
  assert.deepEqual(comRegiao.region, { from: 1, to: 5, open: false, strings: null });
  // Linha contínua de 4 notas na região 1–5, ciclo de quartas, 1 compasso por
  // acorde: 13 compassos e 49 notas (critério 3 do pedido).
  const out = generate(comRegiao);
  assert.equal(out.actualBars, 13);
  assert.equal(out.notes.length, 49);
  assert.deepEqual(out.warnings, []);
  assert.equal(recipeNeedsShape(comRegiao), false);
  // Sem `compasso_final` no catálogo a receita NÃO inventa nota longa.
  const semFinal = catalogRecipeFromEntry(entry({ figura_ritmica: { padrao_codigo: 'q q q q' } })).recipe;
  assert.equal(semFinal.final, 'nenhum');
  // Progressão só pela regra do ciclo (sem cifras): o motor expande o ciclo.
  const soRegra = catalogRecipeFromEntry(entry({ sequencia_de_acordes: { regra: 'ciclo de quartas a partir de C', cifras: [] } })).recipe;
  assert.equal(soRegra.progression.kind, 'quartas');
  assert.deepEqual(soRegra.progression.chords, []);
  assert.equal(soRegra.final, 'tonica');
});

test('progressão em lista mista mantém a qualidade de cada acorde', () => {
  const { recipe } = catalogRecipeFromEntry(entry({
    familia: 'movimento_continuo_agudo_grave_agudo',
    qualidade: 'mista',
    forma: { forma: 'sem forma fixa: todas as notas do acorde dentro da região' },
    regiao_do_braco: { declarada: { de: 5, ate: 8 }, observada_na_tab: null },
    sequencia_de_acordes: { regra: null, cifras: ['Em', 'A7', 'D', 'G', 'C'] },
    compassos_por_acorde: 1,
    figura_ritmica: {},
    contorno: { padrao: null },
  }));
  assert.equal(recipe.progression.kind, 'lista');
  assert.deepEqual(recipe.progression.chords, ['Em', 'A7', 'D', 'G', 'C']);
  assert.equal(recipe.shapeLabel, null);
  assert.equal(recipeNeedsShape(recipe), false);
  const out = generate(recipe);
  assert.equal(out.actualBars, 15);
  assert.equal(out.notes.length, 35);
  // A qualidade vem de cada cifra: o motor não impõe uma qualidade única à
  // família de região (só a forma física exigiria isso).
  assert.deepEqual([...new Set(out.chords.map(chord => chord.quality))].sort(), ['7', 'major', 'minor']);
  assert.deepEqual(warningCodes(out), ['aumentar-compassos']);
});

test('família desconhecida, progressão ausente e cifra ilegível não viram receita inventada', () => {
  assert.deepEqual(catalogRecipeFromEntry(entry({ familia: 'familia-inexistente' })).recipe, null);
  assert.equal(catalogRecipeFromEntry(entry({ familia: 'familia-inexistente' })).reason, 'familia-desconhecida');
  const noProgression = catalogRecipeFromEntry(entry({
    familia: 'movimento_continuo_linha_4_notas',
    sequencia_de_acordes: { regra: null, cifras: [] },
  }));
  assert.equal(noProgression.recipe, null);
  assert.equal(noProgression.reason, 'progressao-ausente');
  // Cifras com marcador sem cifra: o motor recusa o acorde e o exercício entra
  // sem receita (a aula mantém "Criar no Estúdio"), sem derrubar a ligação.
  const placeholder = catalogRecipeFromEntry(entry({ sequencia_de_acordes: { regra: 'ciclo de quartas a partir de C', cifras: ['C', '(sem cifra)', 'F'] } }));
  assert.equal(placeholder.recipe, null);
  assert.equal(placeholder.reason, 'sem-receita');
  assert.equal(typeof placeholder.detail, 'string');
});

test('as seis famílias do catálogo geram material de verdade (limite real com o motor)', () => {
  const cases = [
    {
      family: 'arpejo_triade_forma_unica',
      overrides: { regiao_do_braco: { declarada: { de: 1, ate: 5 }, observada_na_tab: null } },
      shape: MAJOR_SHAPE, bars: 25, notes: 37, warnings: ['sem-posicao'],
    },
    {
      family: 'arpejo_triade_formas_combinadas',
      overrides: {
        inversao: '1ª inversão',
        forma: { forma: 'combinação das duas formas (a forma de cada acorde é escolhida pela região)' },
        regiao_do_braco: { declarada: { de: 1, ate: 5 }, observada_na_tab: null },
        compassos_por_acorde: 1,
        contorno: { padrao: '3-5-T' },
      },
      bars: 13, notes: 37, warnings: [],
    },
    {
      family: 'movimento_continuo_linha_4_notas',
      overrides: {
        forma: null,
        regiao_do_braco: { declarada: { de: 1, ate: 5 }, observada_na_tab: null },
        compassos_por_acorde: 1,
        contorno: { padrao: null },
      },
      bars: 13, notes: 49, warnings: [],
    },
    {
      family: 'movimento_continuo_grave_agudo_grave',
      overrides: {
        qualidade: 'menor',
        forma: null,
        regiao_do_braco: { declarada: { de: 1, ate: 5 }, observada_na_tab: null },
        sequencia_de_acordes: { regra: 'ciclo de quartas a partir de Cm', cifras: MINOR_CYCLE },
        compassos_por_acorde: 1,
        contorno: { padrao: 'sobe-desce' },
      },
      bars: 37, notes: 109, warnings: ['aumentar-compassos'],
    },
    {
      family: 'arpejo_tres_inversoes_por_acorde',
      overrides: {
        qualidade: 'diminuta',
        inversao: 'fundamental, 1ª e 2ª inversões em sequência (um compasso cada)',
        forma: { forma: 'Shape 1 de cada inversão (descrição fictícia)' },
        regiao_do_braco: { declarada: { de: 1, ate: 7 }, observada_na_tab: null },
        sequencia_de_acordes: { regra: 'ciclo de quartas a partir de Cº', cifras: ['Cdim', 'Fdim', 'Bbdim', 'Ebdim', 'Abdim', 'Dbdim', 'Gbdim', 'Bdim', 'Edim', 'Adim', 'Ddim', 'Gdim', 'Cdim'] },
        compassos_por_acorde: 3,
        contorno: { padrao: 'T-3-5-3-5-3-5-3-5' },
      },
      bars: 37, notes: 109, warnings: [],
    },
  ];
  for (const item of cases) {
    const { recipe, reason } = catalogRecipeFromEntry(entry({ familia: item.family, ...item.overrides }));
    assert.equal(reason, null, item.family);
    assert.equal(normalizeCatalogRecipe(recipe).ok, true, item.family);
    const out = generate(recipe, item.shape ?? null);
    assert.equal(out.actualBars, item.bars, item.family);
    assert.equal(out.notes.length, item.notes, item.family);
    assert.deepEqual(warningCodes(out), item.warnings, item.family);
  }
});

test('o percurso mantém a ordem da família e NÃO trunca a escada que não cabe', () => {
  // 5 cordas, região 1–12: a escada do acorde não cabe em 4 compassos e o motor
  // pede 5 — sem truncar nada. O teto de `figure.bars` é o DA FAMÍLIA (128).
  const { recipe } = catalogRecipeFromEntry(entry({
    origem_tipo: '5cordas',
    familia: 'movimento_continuo_grave_agudo_grave',
    forma: null,
    regiao_do_braco: { declarada: { de: 1, ate: 12 }, observada_na_tab: null },
    sequencia_de_acordes: { regra: 'ciclo de quartas a partir de C', cifras: ['C'] },
    compassos_por_acorde: 4,
    contorno: { padrao: null },
  }));
  assert.deepEqual(recipe.profile, { type: 'bass', strings: 5 });
  assert.equal(recipe.figure.order, 'sobe-desce');
  const out = generate(recipe);
  const warning = out.warnings.find(item => item.code === 'aumentar-compassos');
  assert.equal(warning.minimumFigureBars, 5);
  assert.equal(warning.action.figureBars, 5);
  // Nada de truncar: o material usa o mínimo da família mais o compasso final.
  assert.equal(out.actualBars, 6);
  // A ação do motor volta pelo documento sem ser recusada (o teto antigo de 4
  // recusava justamente este valor derivado).
  const fixed = normalizeCatalogRecipe({ ...recipe, figure: { ...recipe.figure, bars: warning.action.figureBars } });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.recipe.figure.bars, 5);
  assert.equal(generate(fixed.recipe).actualBars, 6);
  // Tetos: percursos até 128, os demais até 4 (os números são os do MOTOR).
  assert.equal(catalogMaxFigureBars('movimento_continuo_grave_agudo_grave'), STUDY_MAX_PERCURSO_FIGURE_BARS);
  assert.equal(catalogMaxFigureBars('movimento_continuo_linha_4_notas'), STUDY_MAX_FIGURE_BARS);
  assert.equal(CATALOG_MAX_FIGURE_BARS, STUDY_MAX_FIGURE_BARS);
  assert.equal(CATALOG_MAX_PERCURSO_FIGURE_BARS, STUDY_MAX_PERCURSO_FIGURE_BARS);
  assert.equal(maxFigureBars('movimento_continuo_agudo_grave_agudo'), 128);
  assert.equal(CATALOG_LIMITS.bars, 4);
  assert.equal(CATALOG_LIMITS.barsPercurso, 128);
});

test('sugestão do catálogo traz página, faixas, modo de prática e andamento escrito', () => {
  const { suggestion } = catalogSuggestion(entry(), { id: 'catalogo-1', index: 0 });
  assert.equal(suggestion.id, 'catalogo-1');
  assert.equal(suggestion.title, 'Exercício fictício');
  assert.equal(suggestion.pdfPage, 12);
  assert.deepEqual(suggestion.trackNames, ['faixa-ficticia.mp3']);
  assert.equal(suggestion.practiceMode, 'com metrônomo');
  assert.equal(suggestion.initialBpm, 110);
  assert.equal(suggestion.targetBpm, null);
  assert.equal(suggestion.bars, 25);
  assert.equal(suggestion.strings, 4);
  assert.equal(suggestion.catalogId, 'cat-1');
  assert.equal(suggestion.variantOf, null);
});

// ------------------------------------------------------------- ligação

function findResourceStub(map) {
  return (lessonEntry, name) => {
    const found = map.get(name);
    if (!found) return null;
    return { lesson: lessonEntry.lesson, resource: { id: found } };
  };
}

test('liga cada exercício à sua aula pelo id numérico e substitui as sugestões', () => {
  const doc = course([lesson('7'), lesson('8')]);
  const result = applyCatalog(doc, [entry()], { catalogId: 'cat-teste', findResource: findResourceStub(new Map([['faixa-ficticia.mp3', 'recurso-1']])) });
  const lessons = result.course.sections[0].lessons;
  assert.equal(result.counts.bound, 1);
  assert.equal(result.counts.replaced, 1);
  assert.equal(result.counts.unknownLesson, 0);
  assert.equal(lessons[0].suggestedExercises.length, 1);
  assert.equal(lessons[0].suggestedExercises[0].id, 'cat-1');
  assert.equal(lessons[0].suggestedExercises[0].recipe.family, 'arpejo_triade_forma_unica');
  // A receita que entra no documento é a mesma que o motor gera.
  assert.equal(generate(lessons[0].suggestedExercises[0].recipe, MAJOR_SHAPE).actualBars, 25);
  assert.deepEqual(lessons[0].resourceRefs, [{ lessonId: '7', resourceId: 'recurso-1' }]);
  assert.equal(result.counts.refs, 1);
  // A aula que o catálogo não cita continua com a sugestão do mapa.
  assert.equal(lessons[1].suggestedExercises.length, 1);
  assert.equal(lessons[1].suggestedExercises[0].id, 'sugestao-8');
  assert.deepEqual(result.course.catalog, { id: 'cat-teste', entries: 1 });
  // A estrutura de entrada não é mutada.
  assert.equal(doc.sections[0].lessons[0].suggestedExercises[0].id, 'sugestao-7');
});

test('exercício de 5 cordas entra como variação do de 4 cordas da mesma aula', () => {
  const doc = course([lesson('7')]);
  const base = entry();
  const variant = entry({
    id: 'cat-1-5',
    origem_tipo: '5cordas',
    familia: 'movimento_continuo_linha_4_notas',
    nome_do_exercicio: 'Exercício fictício em cinco cordas',
    forma: null,
    contorno: { padrao: null },
    igual_a: 'cat-1',
    semelhante_a: null,
  });
  const result = applyCatalog(doc, [base, variant], { findResource: () => null });
  const suggestions = result.course.sections[0].lessons[0].suggestedExercises;
  assert.equal(result.counts.variations, 1);
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0].id, 'cat-1');
  assert.equal(suggestions[1].id, 'cat-1-5');
  assert.equal(suggestions[1].variantOf, 'cat-1');
  assert.equal(suggestions[1].strings, 5);
  assert.deepEqual(suggestions[1].recipe.profile, { type: 'bass', strings: 5 });
  // Cinco cordas na linha contínua: "até a linha voltar ao estado inicial".
  assert.equal(suggestions[1].recipe.voltas, CATALOG_PERIOD);
});

test('catálogo sem aula no mapa, sem receita ou com campo estranho gera aviso', () => {
  const doc = course([lesson('7')]);
  const warnings = [];
  const result = applyCatalog(doc, [
    entry({ id: 'cat-ok' }),
    entry({ id: 'cat-sem-aula', aula_id: 999 }),
    entry({ id: 'cat-sem-receita', familia: 'familia-inexistente' }),
    entry({ id: 'cat-estranho', campo_estranho: true, regiao_do_braco: { declarada: { de: 1, ate: 5, extra: 1 } } }),
  ], { findResource: () => null, warnings });
  assert.equal(result.counts.entries, 4);
  assert.equal(result.counts.unknownLesson, 1);
  assert.equal(result.counts.withoutRecipe, 1);
  assert.equal(result.counts.ignoredFields, 2);
  const codes = warnings.map(warning => warning.code);
  assert.ok(codes.includes('catalogo-aula-ausente'));
  assert.ok(codes.includes('catalogo-sem-receita'));
  assert.ok(codes.filter(code => code === 'catalogo-campo-ignorado').length === 2);
  // Só os que têm aula entram na lista da aula 7 (o sem receita entra sem ela).
  assert.deepEqual(result.course.sections[0].lessons[0].suggestedExercises.map(item => item.id).sort(), ['cat-estranho', 'cat-ok', 'cat-sem-receita']);
  assert.equal(result.course.sections[0].lessons[0].suggestedExercises.find(item => item.id === 'cat-sem-receita').recipe, null);
  // Nenhum aviso repete conteúdo do catálogo (só caminho de campo).
  assert.equal(JSON.stringify(warnings).includes('Exercício fictício'), false);
});

test('exercício com cifra ilegível entra sem receita e com aviso honesto', () => {
  const warnings = [];
  const result = applyCatalog(course([lesson('7')]), [
    entry({ id: 'cat-placeholder', sequencia_de_acordes: { regra: 'ciclo de quartas a partir de C', cifras: ['C', '(sem cifra)', 'F'] } }),
  ], { findResource: () => null, warnings });
  const suggestion = result.course.sections[0].lessons[0].suggestedExercises[0];
  assert.equal(suggestion.recipe, null);
  assert.equal(result.counts.withoutRecipe, 1);
  const warning = warnings.find(item => item.code === 'catalogo-sem-receita');
  assert.match(warning.message, /não pôde ser lida pelo gerador/);
  // Nem o acorde que o motor recusou aparece no aviso.
  assert.equal(warning.message.includes('(sem cifra)'), false);
});

test('faixa indicada sem material equivalente avisa e não cria vínculo quebrado', () => {
  const doc = course([lesson('7')]);
  const warnings = [];
  const result = applyCatalog(doc, [entry()], { findResource: () => null, warnings });
  assert.equal(result.counts.refs, 0);
  assert.deepEqual(result.course.sections[0].lessons[0].resourceRefs, []);
  assert.equal(warnings.filter(warning => warning.code === 'catalogo-faixa-ausente').length, 1);
});

test('o catálogo substitui as sugestões de várias aulas e mantém ids únicos', () => {
  const doc = course([lesson('7'), lesson('8')]);
  const result = applyCatalog(doc, [
    entry({ id: 'cat-1', aula_id: 7 }),
    entry({ id: 'cat-1', aula_id: 8, nome_do_exercicio: 'Exercício fictício repetido' }),
  ], { findResource: () => null });
  const [first, second] = result.course.sections[0].lessons;
  assert.equal(first.suggestedExercises.length, 1);
  assert.equal(second.suggestedExercises.length, 1);
  assert.equal(first.suggestedExercises[0].id, 'cat-1');
  assert.equal(second.suggestedExercises[0].id, 'cat-1');
});

// ------------------------------------------------------- receita do gerador

test('a receita do gerador não leva o rótulo da forma nem inventa digitação', () => {
  const { recipe } = catalogRecipeFromEntry(entry());
  assert.equal(recipeNeedsShape(recipe), true);
  const semForma = generatorRecipe(recipe);
  assert.equal(Object.hasOwn(semForma, 'shapeLabel'), false);
  assert.equal(Object.hasOwn(semForma, 'shape'), false);
  assert.equal(semForma.family, 'arpejo_triade_forma_unica');
  assert.deepEqual(semForma.progression.chords, CYCLE.slice(0, 12));
  assert.equal(shapeLabelKey(recipe.shapeLabel), JSON.stringify(['Shape 1', 'major', 'fundamental']));
  // Sem forma, os graus do contorno valem (é o que o motor posiciona na região).
  assert.deepEqual(semForma.figure.degrees, [1, 3, 5]);
  const comForma = generatorRecipe(recipe, { shape: MAJOR_SHAPE });
  assert.equal(comForma.shape.id, MAJOR_SHAPE.id);
  assert.equal(comForma.shape.notes.length, 3);
  assert.equal(Object.hasOwn(comForma, 'shapeLabel'), false);
  // Com forma física a ORDEM vem da forma: o contorno sai do caminho.
  assert.equal(comForma.figure.degrees, undefined);
  assert.equal(comForma.figure.bars, 2);
});

test('forma de outra qualidade é recusada em vez de gerar um estudo errado', () => {
  const { recipe } = catalogRecipeFromEntry(entry());
  assert.throws(() => generatorRecipe(recipe, {
    shape: { id: 'x', quality: 'minor', degrees: [1, 3, 5], notes: [{ string: 4, fret: 3, degree: 1 }] },
  }), /mesma qualidade/);
});

test('a figura recusa o campo morto `shapes` e respeita o teto da família', () => {
  const { recipe } = catalogRecipeFromEntry(entry());
  // Regressão: a UI antiga mandava `figure.shapes` e o motor recusava a receita.
  const comShapes = normalizeCatalogRecipe({ ...recipe, figure: { ...recipe.figure, shapes: 2 } });
  assert.equal(comShapes.ok, false);
  assert.equal(comShapes.errors[0].path, 'figure.shapes');
  assert.match(comShapes.errors[0].message, /não previsto/);
  const base = { progression: { kind: 'quartas', quality: 'major', start: 'C' } };
  // Percursos aceitam até 128 (o valor derivado do motor); os demais até 4.
  assert.equal(normalizeCatalogRecipe({ ...base, family: 'movimento_continuo_grave_agudo_grave', rhythm: 'quarters', figure: { bars: 128 } }).ok, true);
  const percurso = normalizeCatalogRecipe({ ...base, family: 'movimento_continuo_grave_agudo_grave', rhythm: 'quarters', figure: { bars: 129 } });
  assert.equal(percurso.ok, false);
  assert.match(percurso.errors[0].message, /entre 1 e 128/);
  const arpejo = normalizeCatalogRecipe({ ...base, family: 'arpejo_triade_forma_unica', figure: { bars: 5 } });
  assert.equal(arpejo.ok, false);
  assert.match(arpejo.errors[0].message, /entre 1 e 4/);
  // Os limites de notas e inversões são os do motor (não um número inventado).
  assert.equal(normalizeCatalogRecipe({ ...base, family: 'arpejo_triade_forma_unica', figure: { notes: 32, inversions: 4 } }).ok, true);
  assert.equal(normalizeCatalogRecipe({ ...base, family: 'arpejo_triade_forma_unica', figure: { inversions: 5 } }).ok, false);
  assert.equal(CATALOG_LIMITS.notes, 32);
  assert.equal(CATALOG_LIMITS.inversions, 4);
});

test('o rótulo da forma existe só na família de forma única', () => {
  assert.deepEqual([...CATALOG_LABEL_SHAPE_FAMILIES], ['arpejo_triade_forma_unica']);
  assert.ok(CATALOG_FAMILIES.includes('arpejo_triade_forma_unica'));
  assert.ok(CATALOG_FAMILIES.includes('arpejo_triade_formas_combinadas'));
  // A família de região tem a descrição do autor, não uma forma escolhível: o
  // rótulo não entra (pedir uma forma ali imporia qualidade única à região).
  const combinadas = catalogRecipeFromEntry(entry({
    familia: 'arpejo_triade_formas_combinadas',
    forma: { forma: 'combinação das duas formas (a forma de cada acorde é escolhida pela região)' },
    regiao_do_braco: { declarada: { de: 1, ate: 5 }, observada_na_tab: null },
  })).recipe;
  assert.equal(combinadas.shapeLabel, null);
  assert.equal(recipeNeedsShape(combinadas), false);
  const comLabel = normalizeCatalogRecipe({ ...combinadas, shapeLabel: { label: 'Shape 1', quality: 'major', inversion: null } });
  assert.equal(comLabel.ok, false);
  assert.equal(comLabel.errors[0].path, 'shapeLabel');
  // Contínua com qualidade mista também não pede forma.
  const misto = catalogRecipeFromEntry(entry({ qualidade: 'mista', forma: { forma: 'Shape 1' } })).recipe;
  assert.equal(misto.shapeLabel, null);
});

test('receita inválida é recusada com o caminho do campo', () => {
  const bad = normalizeCatalogRecipe({ family: 'arpejo_triade_forma_unica', region: { from: 9, to: 5 } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(error => error.path === 'region.from'));
  const unknown = normalizeCatalogRecipe({ family: 'arpejo_triade_forma_unica', extra: 1 });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some(error => error.path === 'extra' && error.code === 'campo-desconhecido'));
  assert.equal(normalizeCatalogRecipe({ family: 'arpejo_triade_forma_unica', rhythm: 'galope' }).ok, false);
  assert.equal(normalizeCatalogRecipe({ family: 'arpejo_triade_forma_unica', voltas: 0 }).ok, false);
});

test('todas as famílias do catálogo são aceitas e as contínuas recusam ritmo de arpejo', () => {
  for (const family of CATALOG_FAMILIES) {
    const { recipe } = catalogRecipeFromEntry(entry({
      familia: family,
      forma: family === 'arpejo_triade_forma_unica' ? { forma: 'Shape 1' } : null,
      contorno: { padrao: family.startsWith('arpejo') ? 'T-3-5' : null },
    }));
    assert.equal(normalizeCatalogRecipe(recipe).ok, true, family);
  }
  const continuous = catalogRecipeFromEntry(entry({ familia: 'movimento_continuo_linha_4_notas', forma: null, contorno: { padrao: null } })).recipe;
  assert.equal(normalizeCatalogRecipe({ ...continuous, rhythm: 'arpejo' }).ok, false);
});

test('limites do catálogo são finitos e o excedente é ignorado com aviso', () => {
  const many = Array.from({ length: CATALOG_LIMITS.entries + 2 }, (_, index) => entry({ id: `cat-${index}` }));
  const warnings = [];
  const result = applyCatalog(course([lesson('7')]), many, { findResource: () => null, warnings });
  assert.equal(result.counts.entries, CATALOG_LIMITS.entries);
  assert.ok(warnings.some(warning => warning.code === 'catalogo-grande'));
  assert.equal(result.counts.bound, CATALOG_LIMITS.entries);
});
