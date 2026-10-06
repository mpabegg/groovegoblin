// A4 — Testes do controlador do estudo (com uma tela de mentira): criação,
// variação que NUNCA sobrescreve o original, 12 tonalidades agrupadas e o
// caminho programático que a etapa 5/cursos usa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, parseSession, serializeSession } from '../src/session.js';
import { standardInstrumentProfile } from '../src/instrument-profile.js';
import { createExerciseLibrary } from '../src/exercise-library.js';
import { defaultRecipe, generateStudy } from '../src/study-generator.js';
import { createStudyController } from '../src/study-controller.js';
import { presetRecipe, recipeTitle } from '../src/study-recipe.js';
import { memoryStorage } from './storage-fixture.js';

function clockNow() {
  let time = Date.UTC(2026, 0, 1, 12, 0, 0);
  return () => new Date(time += 1000).toISOString();
}

function setup({ instrument = standardInstrumentProfile('bass', 4) } = {}) {
  const library = createExerciseLibrary({
    storage: memoryStorage(), parse: parseSession, serialize: serializeSession,
    currentSession: createSession({ name: 'Atual', bpm: 100 }), now: clockNow(), uuid: (() => { let n = 0; return () => `ex-${++n}`; })(),
  });
  const notifications = [];
  const opened = [];
  const initialId = library.active();
  const initialBytes = JSON.stringify(library.get(initialId));
  let handlers = null;
  const states = [];
  const calls = [];
  const view = {
    open(state) { states.push(state); calls.push('open'); },
    render(state) { states.push(state); calls.push('render'); },
    close() { calls.push('close'); },
    destroy() { calls.push('destroy'); },
  };
  const controller = createStudyController({
    library,
    openExercise: (id, options) => { opened.push([id, options]); },
    getInstrument: () => instrument,
    notify: (text, error = false) => notifications.push([text, error]),
    bpm: 92,
  }, { viewFactory: (given) => { handlers = given; return view; }, uuid: (() => { let n = 0; return () => `grupo-${++n}`; })() });
  return {
    library, controller, notifications, opened, states, calls, view, initialId, initialBytes,
    handlers: () => handlers,
    last: () => states[states.length - 1],
    created: index => library.get(opened[index][0]),
  };
}

test('abrir o diálogo: um preset válido, prévia gerada e o instrumento atual como padrão', () => {
  const context = setup({ instrument: standardInstrumentProfile('bass', 5) });
  context.controller.open();
  assert.equal(context.calls.filter(call => call === 'open').length, 1);
  const state = context.last();
  assert.equal(state.controls.preset, 'arpejo-quartas');
  assert.equal(state.controls.strings, 5, 'baixo 5 cordas do instrumento atual');
  assert.equal(state.canCreate, true);
  assert.deepEqual(state.warnings, []);
  assert.equal(state.preview.result.actualBars, 25);
  assert.equal(state.preview.result.recipe.profile.strings, 5);
  assert.match(state.status, /25 compassos/);
  assert.equal(state.error, null);
  // Reabrir não cria outra tela.
  context.controller.open();
  assert.equal(context.calls.length, 2);
});

test('criar: exercício comum na biblioteca, aberto no Estúdio, com a receita fora da sessão', () => {
  const context = setup();
  context.controller.open();
  context.handlers().onCreate();
  assert.equal(context.library.size(), 2, 'exercício atual + estudo novo');
  assert.equal(context.opened.length, 1);
  const created = context.created(0);
  assert.equal(created.metadata.study.recipe.family, 'arpejo_triade_forma_unica');
  assert.deepEqual(created.metadata.tags, ['estudo']);
  assert.equal(created.session.band.bassEnabled, false);
  assert.equal(created.session.extensions.studio.phraseView, 'tab');
  assert.equal(created.session.extensions.studio.instrument.strings, 4);
  assert.equal(Object.hasOwn(created.session.extensions.studio, 'recipe'), false);
  assert.equal(created.session.bars, 25);
  assert.equal(created.session.notes.length, 37);
  assert.equal(created.session.bpm, 92);
  assert.deepEqual(context.opened[0][1], { train: false });
  assert.equal(context.calls.includes('close'), true, 'o diálogo fecha depois de criar');
  assert.match(context.notifications[0][0], /abre no Estúdio/);
  assert.equal(JSON.stringify(context.library.get(context.initialId)), context.initialBytes, 'a sessão que já existia não mudou');
});

test('variação: preenche com a receita do original, cria NOVO e não altera o original', () => {
  const context = setup();
  context.controller.open();
  context.handlers().onCreate();
  const originalId = context.opened[0][0];
  const original = context.library.get(originalId);
  const before = JSON.stringify(original);

  context.controller.openVariation(originalId);
  const state = context.last();
  assert.equal(state.title, `Variação de “${original.metadata.name}”`);
  assert.equal(state.origin, original.metadata.name);
  assert.equal(state.controls.bars, 25);
  assert.equal(state.controls.regionFrom, 1);
  assert.equal(state.createLabel, 'Criar variação');

  // O usuário muda tonalidade e região; a forma escolhida viria do Braço (A3).
  context.handlers().onControls({ ...state.controls, start: 'F#', regionFrom: 3, regionTo: 9 });
  const changed = context.last();
  assert.equal(changed.controls.start, 'F#');
  assert.equal(changed.controls.preset, 'personalizado');
  assert.equal(changed.canCreate, true);

  context.handlers().onCreate();
  assert.equal(context.library.size(), 3);
  const variation = context.created(1);
  assert.notEqual(variation.id, originalId);
  assert.deepEqual(variation.metadata.study.origin, { id: originalId, name: original.metadata.name });
  assert.equal(variation.metadata.study.recipe.progression.start, 'F#');
  assert.equal(variation.metadata.study.recipe.region.from, 3);
  assert.equal(variation.metadata.study.recipe.region.to, 9);
  assert.notDeepEqual(variation.metadata.study.recipe, original.metadata.study.recipe);
  assert.equal(JSON.stringify(context.library.get(originalId)), before, 'o original ficou byte a byte igual');
});

test('nas 12 tonalidades: 12 exercícios novos com id próprio, no mesmo grupo, copiando a receita', () => {
  const context = setup();
  context.controller.open();
  // O caso do pedido: uma lista que NÃO é um ciclo (I–vi–ii–V em C). Um ciclo
  // já percorre as 12 tonalidades e o botão nem aparece.
  const state = context.last();
  assert.equal(state.canOtherKeys, false, 'o preset em quartas é um ciclo');
  context.handlers().onControls({
    ...state.controls,
    family: 'movimento_continuo_linha_4_notas', rhythm: 'quarters', figureBars: 1,
    progression: 'lista', chords: 'C, Am, Dm7, G7', bars: 4,
  });
  assert.equal(context.last().canOtherKeys, true);
  const before = context.library.size();
  const made = context.controller.generateOtherKeys();
  assert.equal(made.length, 12);
  assert.equal(context.library.size(), before + 12);
  const group = made[0].metadata.study.group;
  assert.ok(group && group.id);
  assert.match(group.label, /Nas 12 tonalidades/);
  assert.deepEqual(made.map(entry => entry.metadata.study.group.id), new Array(12).fill(group.id));
  // Ids próprios e nada sobrescrito: o exercício que já existia continua igual.
  assert.equal(new Set(made.map(entry => entry.id)).size, 12);
  assert.equal(JSON.stringify(context.library.get(context.initialId)), context.initialBytes);
  // O estudo atual ainda NÃO estava salvo: a base é ele (criado uma vez) e as
  // 11 transposições ficam ligadas a ela — nunca a um exercício de fora. O grupo
  // é o vínculo entre as 12.
  assert.equal(made[0].metadata.study.origin, null);
  for (const sibling of made.slice(1)) {
    assert.deepEqual(sibling.metadata.study.origin, { id: made[0].id, name: made[0].metadata.name });
  }
  // As 12 tonalidades, sem repetir, com os mesmos graus.
  const roots = made.map(entry => entry.metadata.study.recipe.progression.chords[0].root);
  assert.equal(new Set(roots).size, 12);
  assert.deepEqual([...roots].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  for (const entry of made) {
    assert.equal(entry.metadata.study.recipe.progression.kind, 'lista');
    assert.deepEqual(entry.metadata.study.recipe.progression.chords.map(chord => chord.quality), ['major', 'minor', 'm7', '7']);
    assert.deepEqual(context.library.get(entry.id).metadata.records, [], 'exercício novo começa sem histórico');
    // Cada exercício criado é uma sessão canônica válida.
    assert.deepEqual(parseSession(serializeSession(context.library.get(entry.id).session)), JSON.parse(JSON.stringify(context.library.get(entry.id).session)));
  }
  assert.equal(context.opened.length, 1, 'só o primeiro abre no Estúdio');
});

test('nas 12 tonalidades de uma variação: o vínculo de origem é copiado e o original mantém o histórico', () => {
  const context = setup();
  context.controller.open();
  context.handlers().onCreate();
  const originalId = context.opened[0][0];
  // O original ganha histórico de treino: gerar as 12 tonalidades não pode
  // tocar nele nem no histórico dele.
  context.library.updateMetadata(originalId, {
    records: [{ id: 'r1', ownerId: originalId, startedAt: '2026-01-01T00:00:00.000Z', bpm: 92, summary: { mode: 'train', expected: 4, attackOk: 4 } }],
  });
  const original = JSON.stringify(context.library.get(originalId));
  context.controller.openVariation(originalId);
  const state = context.last();
  context.handlers().onControls({
    ...state.controls, family: 'movimento_continuo_linha_4_notas', rhythm: 'quarters', figureBars: 1,
    progression: 'lista', chords: 'C, Am, Dm7, G7', bars: 4,
  });
  const made = context.controller.generateOtherKeys();
  assert.equal(made.length, 12);
  // As 12 copiam o vínculo de origem do estudo multiplicado (a variação da
  // mesma origem) e compartilham o grupo da transposição.
  const origin = { id: originalId, name: context.library.get(originalId).metadata.name };
  assert.deepEqual(made.map(entry => entry.metadata.study.origin), new Array(12).fill(origin));
  const group = made[0].metadata.study.group;
  assert.ok(group && group.id);
  assert.deepEqual(made.map(entry => entry.metadata.study.group.id), new Array(12).fill(group.id));
  assert.equal(new Set(made.map(entry => entry.metadata.study.recipe.progression.chords[0].root)).size, 12);
  // O original (sessão + receita + histórico) ficou byte a byte igual.
  assert.equal(JSON.stringify(context.library.get(originalId)), original);
  assert.equal(context.library.records(originalId).length, 1);
});

test('nas 12 tonalidades de um estudo já salvo: cria só as OUTRAS 11 e não toca na base', () => {
  const context = setup();
  // A base: um estudo salvo com uma lista transponível (I–vi–ii–V em C).
  const baseRecipe = defaultRecipe({
    family: 'movimento_continuo_linha_4_notas', profile: { type: 'bass', strings: 4 },
    progression: { kind: 'lista', quality: 'major', chords: [{ root: 0, quality: 'major' }, { root: 9, quality: 'minor' }, { root: 2, quality: 'm7' }, { root: 7, quality: '7' }] },
    region: { from: 1, to: 12, open: false }, figure: { notes: 4, order: 'sobe', bars: 1 },
    rhythm: 'quarters', bars: null, voltas: 1, final: 'tonica',
  });
  const saved = context.controller.create(baseRecipe, { name: 'Estudo base', open: false });
  context.library.updateMetadata(saved.id, {
    records: [{ id: 'r1', ownerId: saved.id, startedAt: '2026-01-01T00:00:00.000Z', bpm: 92, summary: { mode: 'train', expected: 4, attackOk: 4 } }],
  });
  const before = JSON.stringify(context.library.get(saved.id));
  const size = context.library.size();
  // O diálogo abre com a MESMA receita (o usuário abriu o estudo salvo): a base
  // não é duplicada — saem só as outras 11 tonalidades.
  context.controller.open({ recipe: saved.metadata.study.recipe });
  const made = context.controller.generateOtherKeys();
  assert.equal(made.length, 12, 'o retorno é o grupo inteiro, com a base no começo');
  assert.equal(made[0].id, saved.id, 'a base é o exercício que já existia');
  assert.equal(context.library.size(), size + 11, 'cria só as OUTRAS 11');
  const stored = context.library.get(saved.id);
  const prior = JSON.parse(before);
  assert.deepEqual(stored.session, prior.session, 'a sessão da base ficou byte a byte igual');
  assert.deepEqual(stored.metadata.study.recipe, prior.metadata.study.recipe, 'a receita da base não mudou');
  assert.deepEqual(stored.metadata.records, prior.metadata.records, 'o histórico da base não foi tocado');
  assert.equal(prior.metadata.study.group, null, 'a base não tinha grupo antes');
  assert.equal(context.library.records(saved.id).length, 1, 'o histórico da base não foi tocado');
  const group = made[0].metadata.study.group;
  assert.ok(group && group.id);
  assert.deepEqual(made.map(entry => entry.metadata.study.group.id), new Array(12).fill(group.id));
  for (const sibling of made.slice(1)) {
    assert.equal(sibling.id !== saved.id, true);
    assert.deepEqual(sibling.metadata.study.origin, { id: saved.id, name: saved.metadata.name });
  }
  const roots = made.map(entry => entry.metadata.study.recipe.progression.chords[0].root);
  assert.equal(new Set(roots).size, 12, 'as 12 tonalidades, sem repetir');
});

test('variação e transposições preservam a ascendência de curso (B6)', () => {
  const context = setup();
  const lessonOrigin = { id: 'aula-7', name: 'Título privado da aula', kind: 'course', private: true };
  const lesson = context.controller.create(presetRecipe('arpejo-quartas'), { origin: lessonOrigin, name: 'Estudo da aula', open: false });
  assert.equal(lesson.metadata.study.origin.private, true);
  // A variação de um exercício de aula nasce com o vínculo MARCADO (a origem
  // herdada é de curso): o rótulo privado não pode vazar na exportação padrão.
  context.controller.openVariation(lesson.id);
  context.handlers().onCreate();
  const variation = context.created(0);
  assert.deepEqual(variation.metadata.study.origin, { id: lesson.id, name: lesson.metadata.name, kind: 'course', private: true });
  // E as 11 tonalidades de uma lista de aula copiam a marca, não a perdem.
  const lista = defaultRecipe({
    family: 'movimento_continuo_linha_4_notas', profile: { type: 'bass', strings: 4 },
    progression: { kind: 'lista', quality: 'major', chords: [{ root: 0, quality: 'major' }, { root: 9, quality: 'minor' }] },
    region: { from: 1, to: 12, open: false }, figure: { notes: 4, order: 'sobe', bars: 1 },
    rhythm: 'quarters', bars: null, voltas: 1, final: 'tonica',
  });
  const base = context.controller.create(lista, { origin: lessonOrigin, open: false });
  context.controller.open({ recipe: base.metadata.study.recipe });
  const made = context.controller.generateOtherKeys();
  assert.equal(made.length, 12);
  for (const sibling of made.slice(1)) {
    assert.equal(sibling.metadata.study.origin.private, true, 'a marca privada viaja com o vínculo');
    assert.equal(sibling.metadata.study.origin.kind, 'course');
    assert.equal(sibling.metadata.study.origin.id, base.id);
  }
});

test('caminho programático (etapa 5): cria sem abrir o diálogo e sem tocar na sessão atual', () => {
  const context = setup();
  const recipe = defaultRecipe({
    family: 'movimento_continuo_grave_agudo_grave', profile: { type: 'bass', strings: 4 },
    progression: { kind: 'quartas', quality: 'minor' }, bars: 12,
    region: { from: 1, to: 5, open: false }, figure: { notes: 4, order: 'sobe-desce' }, rhythm: 'quarters', voltas: 1, final: 'nenhum',
  });
  const entry = context.controller.create(recipe, { origin: { id: 'aula-1', name: 'Aula 1' }, group: { id: 'g1', label: 'Aula 1 · movimento' }, name: 'Estudo da aula', bpm: 84, open: false });
  assert.equal(context.calls.length, 0, 'nenhuma tela foi criada');
  assert.equal(context.opened.length, 0, 'nada abriu no Estúdio');
  assert.equal(entry.metadata.name, 'Estudo da aula');
  assert.equal(entry.session.name, 'Estudo da aula');
  assert.equal(entry.session.bpm, 84);
  assert.deepEqual(entry.metadata.study.origin, { id: 'aula-1', name: 'Aula 1' });
  assert.deepEqual(entry.metadata.study.group, { id: 'g1', label: 'Aula 1 · movimento' });
  assert.equal(entry.metadata.study.recipe.family, 'movimento_continuo_grave_agudo_grave');
  assert.equal(context.library.size(), 2);
  // A sessão "Atual" da biblioteca não foi tocada: nada de extensions.studio.
  assert.equal(context.library.get(context.initialId).session.extensions.studio, undefined);
  assert.equal(JSON.stringify(context.library.get(context.initialId)), context.initialBytes, 'a sessão "Atual" ficou byte a byte igual');
});

test('abre a receita do CURSO (etapa 5) no diálogo: cifras em texto, shapeLabel descartado', () => {
  const context = setup();
  const course = {
    version: 1, family: 'arpejo_triade_forma_unica', profile: { type: 'bass', strings: 4 },
    progression: { kind: 'lista', quality: 'major', chords: ['C', 'Am', 'Dm7', 'G7'], length: 4, start: 'C' },
    bars: null, region: { from: 1, to: 5, open: false, strings: null }, shapeLabel: 'Forma 1',
    figure: { degrees: null, inversions: 1, notes: 4, order: 'sobe', bars: 1 },
    rhythm: 'arpejo', voltas: 1, final: 'tonica',
  };
  context.controller.open({ recipe: course });
  const state = context.last();
  assert.equal(state.controls.chords, 'C, Am, Dm7, G7');
  assert.equal(state.canCreate, true, 'a receita do curso vira um estudo criável');
  assert.deepEqual(state.warnings, []);
});

test('controles inválidos param a criação com a mensagem do gerador (nada é gravado)', () => {
  const context = setup();
  context.controller.open();
  const before = context.library.size();
  const state = context.last();
  context.handlers().onControls({ ...state.controls, regionFrom: 9, regionTo: 3 });
  const broken = context.last();
  assert.equal(broken.canCreate, false);
  assert.match(broken.error, /casa inicial menor ou igual/);
  assert.equal(broken.preview, null);
  context.handlers().onCreate();
  assert.equal(context.library.size(), before, 'nada foi criado com a receita inválida');
  // Voltar a um valor coerente libera a criação de novo.
  context.handlers().onControls({ ...state.controls, regionFrom: 1, regionTo: 5 });
  assert.equal(context.last().canCreate, true);
});

test('arpejo de região com ciclo misto (I–vi–ii–V) cria; com forma física a tela explica o que ajustar', () => {
  const context = setup();
  context.controller.open();
  const state = context.last();
  // O arpejo de REGIÃO aceita qualidades mistas: é o caso musical do pedido
  // (I–vi–ii–V em Dó) e o motor gera normalmente.
  context.handlers().onControls({
    ...state.controls, progression: 'lista', chords: 'C, Am, Dm7, G7', bars: 8,
  });
  const mixed = context.last();
  assert.equal(mixed.error, null);
  assert.equal(mixed.errorHint, null);
  assert.equal(mixed.canCreate, true);
  assert.equal(mixed.preview.result.notes.length > 0, true);
  context.handlers().onCreate();
  const created = context.created(0);
  assert.deepEqual(created.session.progression.chords.map(chord => chord.symbol), ['C', 'Am', 'Dm7', 'G7']);
  assert.deepEqual(created.session.progression.chords.map(chord => chord.quality), ['', 'm', 'm7', '7'], 'qualidade POR ACORDE na progressão da sessão');
  // A sessão ativa passa a ser esse estudo: o ciclo dela é misto. Com uma forma
  // FÍSICA o motor recusa em tempo de geração (a forma toca uma qualidade só) e
  // a dica vem do ESTADO (o ciclo real da sessão), sem casar texto de erro.
  context.controller.open();
  const reopened = context.last();
  const shapeId = reopened.shapes[0]?.id ?? null;
  assert.ok(shapeId, 'a loja de formas do Braço tem uma forma para escolher');
  context.handlers().onControls({ ...reopened.controls, progression: 'sessao', chords: '', shapeIds: [shapeId] });
  const refused = context.last();
  assert.equal(refused.canCreate, false);
  assert.equal(refused.preview, null);
  assert.match(refused.error, /qualidade da forma/);
  assert.match(refused.errorHint, /forma de dedilhado toca uma qualidade só/);
  // Tirar a forma volta a tocar a REGIÃO: o mesmo ciclo misto é aceito.
  context.handlers().onControls({ ...refused.controls, shapeIds: [] });
  assert.equal(context.last().error, null);
  assert.equal(context.last().errorHint, null);
  assert.equal(context.last().canCreate, true);
});

test('aviso corretivo: aplica a correção e refaz a prévia', () => {
  const context = setup();
  context.controller.open();
  const state = context.last();
  // Compassos menores do que a figura pede -> aviso com ação de ajuste.
  context.handlers().onControls({ ...state.controls, bars: 2 });
  const warned = context.last();
  assert.equal(warned.warnings.length >= 1, true);
  const warning = warned.warnings.find(item => item.key === 'aumentar-compassos' && item.label);
  assert.ok(warning, 'o aviso com correção traz o rótulo');
  context.handlers().onApplyWarning(warning.action);
  const fixed = context.last();
  assert.equal(fixed.controls.bars, 25, 'o total proposto conta o compasso final (24 de ciclo + 1)');
  assert.equal(fixed.warnings.length, 0);
  assert.equal(fixed.canCreate, true);
});

test('avisos: um modelo por MOTIVO (teto de controles do diálogo) e a região cobre todos os acordes de uma vez', () => {
  const context = setup();
  context.controller.open();
  const state = context.last();
  // Região estreita no ciclo de quartas: TODOS os 12 acordes ficam fora.
  context.handlers().onControls({ ...state.controls, regionFrom: 1, regionTo: 1 });
  const warned = context.last();
  const position = warned.warnings.filter(item => item.key === 'sem-posicao');
  assert.equal(position.length, 1, 'vários acordes fora da região viram UM motivo com UMA ação');
  assert.equal(position[0].warnings.length, 12, 'os 12 avisos crus continuam no modelo');
  assert.deepEqual(position[0].codes, ['sem-posicao']);
  assert.match(position[0].label, /Ampliar a região/);
  assert.equal(warned.warnings.length, 1, 'o diálogo não ganha um controle por acorde');
  // A ação única cobre TODAS as posições fora.
  context.handlers().onApplyWarning(position[0].action);
  const fixed = context.last();
  assert.deepEqual(fixed.warnings, []);
  assert.equal(fixed.canCreate, true);
  assert.equal(fixed.controls.regionFrom, 1);
  assert.ok(fixed.controls.regionTo > 1, 'a região ampliada cobre as posições que faltavam');
});

test('vínculo de curso (B6): receita musical no exercício, rótulo privado FORA da sessão, nome musical', () => {
  const context = setup();
  const recipe = defaultRecipe({
    family: 'arpejo_triade_forma_unica', profile: { type: 'bass', strings: 4 },
    progression: { kind: 'quartas', quality: 'major' }, bars: 8,
    region: { from: 1, to: 5, open: false }, figure: { degrees: [1, 3, 5], bars: 2, order: 'sobe' },
    rhythm: 'arpejo', voltas: 1, final: 'nenhum',
  });
  const entry = context.controller.create(recipe, {
    origin: { id: 'aula-7', name: 'Título privado da aula', kind: 'course', private: true },
    group: { id: 'g-aula', label: 'Rótulo privado do grupo', private: true },
    name: 'Nome privado do material',
    open: false,
  });
  assert.equal(entry.metadata.name, recipeTitle(recipe), 'nome do exercício é o rótulo musical');
  assert.equal(entry.session.name, recipeTitle(recipe));
  assert.equal(JSON.stringify(entry.session).includes('privado'), false, 'nada privado entra na sessão');
  assert.equal(Object.hasOwn(entry.session.extensions.studio, 'recipe'), false);
  assert.deepEqual(entry.metadata.study.origin, { id: 'aula-7', name: 'Título privado da aula', kind: 'course', private: true });
  assert.deepEqual(entry.metadata.study.group, { id: 'g-aula', label: 'Rótulo privado do grupo', private: true });
  assert.equal(entry.metadata.study.recipe.family, 'arpejo_triade_forma_unica', 'os parâmetros musicais ficam no exercício');
  assert.match(context.notifications[0][0], /rótulo musical/);
  // A exportação PADRÃO do exercício (B6/etapa 8) sai SEM o bloco `study`: a
  // receita pode carregar texto livre (nome/id de forma, resumo, campos
  // importados), e o público não leva vínculo, grupo nem receita.
  const exportedText = context.library.exportExercise(entry.id);
  assert.equal(exportedText.includes('privado'), false, 'nada privado sai na exportação padrão');
  const exported = JSON.parse(exportedText);
  assert.equal(Object.hasOwn(exported.exercise.metadata, 'study'), false, 'o bloco study fica de fora');
  // A música continua a mesma: o que sai é só metadado de curso.
  assert.deepEqual(
    exported.exercise.session.notes.map(note => [note.pitch, note.start, note.duration]),
    entry.session.notes.map(note => [note.pitch, note.start, note.duration]),
  );
  // `privateName` explícito assume o rótulo interno (uso interno do curso).
  const named = context.controller.create(recipe, {
    origin: { id: 'aula-7', name: 'Título privado', kind: 'course', private: true },
    name: 'Nome interno', privateName: true, open: false,
  });
  assert.equal(named.metadata.name, 'Nome interno');
  assert.equal(named.session.extensions.studio.instrument.strings, 4);
});

test('destruir remove a tela e o controlador continua consistente', () => {
  const context = setup();
  context.controller.open();
  context.controller.destroy();
  assert.equal(context.calls.includes('destroy'), true);
  assert.equal(context.controller.view, null);
});
