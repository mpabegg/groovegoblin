// A4 — Controlador do Estúdio de estudo da Biblioteca.
//
// É a costura entre quatro peças que não se conhecem: a Biblioteca (loja
// autoritativa + caminho único de troca de exercício), o diálogo
// (`study-view.js`), a receita (`study-recipe.js`) e o gerador (A2). Nenhuma
// regra de música mora aqui: o controlador só traduz estado, chama o gerador,
// monta a sessão (`study-session.js`) e pede a criação do exercício.
//
// Contrato público (etapa 4 e etapa 5/cursos):
//   const studies = createStudyController(host);
//   studies.open({ recipe?, origin?, group?, preset?, profile?, title?, hint? })
//   studies.openVariation(exerciseId)        // preenche com a receita do original
//   studies.generateOtherKeys()             // 12 tonalidades agrupadas
//   studies.create(recipe, { origin, group, name, privateName, bpm, open })
//   studies.destroy()
//
// PRIVACIDADE (B6): a receita é sempre musical (parâmetros), o nome do
// exercício é sempre um rótulo musical (`recipeTitle`) e o vínculo de origem
// (aula/curso) fica em metadata.study.origin — NUNCA na sessão. Um vínculo com
// `private: true` (kind 'course'/'material') é rótulo privado: mostra-se na
// Biblioteca (uso interno) e a exportação padrão da etapa 8 pode removê-lo
// conservando `recipe`. Um nome vindo de material de curso só entra no
// exercício com `privateName: true` explícito; sem isso, o estudo usa o rótulo
// musical e avisa.
//
// `host` (o pai passa o que já existe; nada de duplicar a Biblioteca):
//   library         (obrigatório) createExerciseLibrary
//   openExercise    (id, {train}) — caminho único de abertura/ativação
//   getInstrument   () => perfil atual (usado só para o padrão de 4/5 cordas)
//   notify          (texto, erro?)
//   bpm             número inicial do exercício (padrão: 100)
//
// O exercício criado é um exercício COMUM: sessão v5 válida (editável no
// Estúdio, treinável como qualquer outro), banda desligada, perfil de baixo 4/5
// e a receita FORA da sessão (metadata.study). Nunca sobrescreve nada: uma
// variação é sempre um exercício novo ligado ao original.

import { MAX_BARS, DEFAULT_BPM } from './session.js';
import { standardInstrumentProfile } from './instrument-profile.js';
import { STUDY_MAX_NOTES, chordCycle, generateStudy } from './study-generator.js';
import { shapeChoicesForRecipe, shapeForRecipe } from './fingering-shapes-controller.js';
import {
  applyWarningAction, canTransposeProgression, controlsToRecipe, defaultControls,
  isRotatingFamily, isShapeFamily, otherKeyRecipes, presetControls, recipeGroupLabel, recipeSummary,
  recipeTitle, recipeToControls,
} from './study-recipe.js';
import { progressionFromResult, studyExercise } from './study-session.js';
import { createStudyView } from './study-view.js';

// Campos comparados para saber se o preset escolhido ainda descreve o
// formulário (qualquer edição o torna "personalizado"). `preset` e os registros
// de forma ficam de fora de propósito.
const CONTROL_KEYS = Object.freeze([
  'strings', 'start', 'family', 'progression', 'direction', 'quality', 'chords', 'cycleLength', 'bars',
  'regionFrom', 'regionTo', 'regionOpen', 'regionStrings', 'rhythm', 'figureBars', 'degrees', 'inversions',
  'notes', 'order', 'voltas', 'final',
]);

// Avisos que falam do MESMO problema (o estudo passa do que uma sessão aceita)
// viram uma linha só: a ação de um deles resolve os dois.
const SIZE_CODES = Object.freeze(['limite-128', 'notas-acima-de-512']);

// Região que cobre TODAS as posições que ficaram fora: início mínimo, fim
// máximo, cordas soltas se alguma precisa e a união das cordas pedidas (sem
// restrição quando alguma posição não pede cordas). É a correção do motivo
// inteiro de uma vez, em vez de um botão por acorde.
function mergedRegionAction(warnings) {
  const expansions = warnings.map(warning => warning.expansion).filter(region => region && Number.isInteger(region.from) && Number.isInteger(region.to));
  if (expansions.length === 0) return null;
  const strings = expansions.some(region => !Array.isArray(region.strings))
    ? null
    : [...new Set(expansions.flatMap(region => region.strings))].sort((a, b) => a - b);
  return {
    kind: 'expandir-regiao',
    region: {
      from: Math.min(...expansions.map(region => region.from)),
      to: Math.max(...expansions.map(region => region.to)),
      open: expansions.some(region => region.open === true),
      strings,
    },
  };
}

function signature(controls) {
  return JSON.stringify([CONTROL_KEYS.map(key => String(controls?.[key] ?? '')), (controls?.shapeIds ?? []).join('|')]);
}

function groupId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `grupo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createStudyController(host = {}, { viewFactory = createStudyView, uuid = groupId } = {}) {
  const library = host.library;
  if (!library || typeof library.new !== 'function' || typeof library.get !== 'function') {
    throw new TypeError('Controlador de estudo: informe host.library (biblioteca de exercícios).');
  }
  const notify = (text, error = false) => { if (typeof host.notify === 'function') host.notify(text, error); };

  let view = null;
  let state = {
    mode: 'new', title: 'Novo estudo', hint: '', origin: null, group: null,
    controls: null, recipe: null, result: null, shapes: [], error: null, errorKind: null, presetSignature: null,
  };

  function profileFor(strings) {
    return standardInstrumentProfile('bass', strings === 5 ? 5 : 4);
  }

  function defaultStrings() {
    try {
      const current = host.getInstrument?.();
      if (current?.type === 'bass' && current.strings === 5) return 5;
    } catch { /* preferência indisponível: baixo 4 */ }
    return 4;
  }

  function shapeRecords(strings) {
    try { return shapeChoicesForRecipe(profileFor(strings)); }
    catch { return []; } // sem loja de formas não há forma para escolher — nada é inventado
  }

  function lookupShape(id, strings) {
    try { return shapeForRecipe(id, profileFor(strings)); }
    catch { return null; }
  }

  function sessionForRecipe() {
    try { return library.get(library.active())?.session ?? null; }
    catch { return null; }
  }

  // Vínculo de origem de uma variação/transposição. B6 (privacidade): o rótulo
  // carrega o NOME de um exercício que pode ter vindo de material de curso. Se a
  // origem dele já é de curso (`private`/`kind`) ou o próprio exercício é
  // material de curso (`metadata.courseContent`), o vínculo nasce marcado como
  // privado — a exportação padrão (etapa 8) remove o rótulo e conserva a
  // receita. O módulo de privacidade ainda não existe: aqui só se PRESERVA a
  // marca herdada, nunca se inventa uma.
  function originLinkFor(entry) {
    const inherited = entry?.metadata?.study?.origin ?? null;
    const tainted = entry?.metadata?.courseContent === true || inherited?.private === true || inherited?.kind === 'course';
    if (!tainted) return { id: entry.id, name: entry.metadata.name };
    return { id: entry.id, name: entry.metadata.name, kind: inherited?.kind === 'material' ? 'material' : 'course', private: true };
  }

  // A base de um grupo de transposição pode JÁ existir na Biblioteca: um estudo
  // salvo com esta MESMA receita e este instrumento (o usuário abriu a receita
  // dele no diálogo). Nesse caso "Nas 12 tonalidades" cria só as OUTRAS 11 — a
  // base não é duplicada e fica byte a byte igual, com o histórico dela.
  function savedBaseFor(recipe) {
    if (!recipe) return null;
    const wanted = JSON.stringify(recipe);
    let rows = [];
    try { rows = library.list({}); }
    catch { return null; }
    for (const row of rows) {
      const entry = library.get(row.id);
      const stored = entry?.metadata?.study?.recipe ?? null;
      if (stored && JSON.stringify(stored) === wanted) return entry;
    }
    return null;
  }

  function bpm() {
    return Number.isFinite(host.bpm) ? host.bpm : DEFAULT_BPM;
  }

  // O que impede o exercício de virar sessão. Poucos casos, todos reais:
  // compassos, notas e acordes do ciclo têm teto no formato da sessão.
  function commitBlock(result) {
    if (!result) return null;
    if (result.actualBars > MAX_BARS) {
      return `O estudo tem ${result.actualBars} compassos e uma sessão aceita até ${MAX_BARS}. Reduza voltas ou o tamanho da figura.`;
    }
    if (result.meta.noteCount > STUDY_MAX_NOTES) {
      return `O estudo tem ${result.meta.noteCount} notas e uma sessão aceita até ${STUDY_MAX_NOTES}. Reduza voltas, inversões ou notas por acorde.`;
    }
    // O limite é do CICLO (uma volta), não do material todo: um ciclo de 12
    // acordes repetido em 6 voltas continua sendo 12 acordes na progressão.
    const cycle = progressionFromResult(result).chords.length;
    if (cycle > 64) return `A progressão tem ${cycle} acordes e uma sessão aceita até 64 por ciclo. Reduza a lista ou o tamanho do ciclo.`;
    return null;
  }

  // Recalcula receita, resultado, avisos e o estado do rodapé a partir do
  // formulário. Nenhum caminho escreve na biblioteca daqui.
  // `errorKind`: 'receita' (o formulário não fecha uma receita), 'material' (a
  // receita é válida mas o motor recusou gerar: a tela diz o que ajustar) ou
  // 'sessao' (não cabe numa sessão; a mensagem já diz o limite).
  function recompute() {
    const controls = state.controls;
    state.shapes = shapeRecords(controls.strings);
    let recipe = null;
    let error = null;
    try { recipe = controlsToRecipe(controls, { shapeLookup: id => lookupShape(id, controls.strings) }); }
    catch (failure) { error = failure.message; }
    state.recipe = recipe;
    state.result = null;
    state.errorKind = null;
    if (!recipe) {
      state.error = error;
      state.errorKind = 'receita';
      return;
    }
    try { state.result = generateStudy(recipe, { session: sessionForRecipe() }); }
    catch (failure) {
      state.error = failure.message;
      state.errorKind = 'material';
      return;
    }
    state.error = commitBlock(state.result);
    state.errorKind = state.error === null ? null : 'sessao';
  }

  // Qualidades do ciclo REAL (uma volta), com a sessão ativa quando a
  // progressão é "sessao": é esse ciclo que o motor percorre, não a lista do
  // formulário. O arpejo de REGIÃO aceita o ciclo misto (I–vi–ii–V); só a
  // forma física exige uma qualidade única — é essa a única mistura que o
  // motor recusa em tempo de geração.
  function cycleQualities(recipe) {
    try { return [...new Set(chordCycle(recipe, { session: sessionForRecipe() }).map(chord => chord.quality))]; }
    catch { return []; }
  }

  // O que fazer quando o material não sai com a configuração atual: derivado do
  // ESTADO (sem casar texto de erro) e só quando a receita é válida.
  function errorHint() {
    if (state.error === null || state.errorKind !== 'material' || !state.recipe) return null;
    if (isShapeFamily(state.recipe.family) && (state.recipe.shapes?.length ?? 0) > 0 && cycleQualities(state.recipe).length > 1) {
      return 'A forma de dedilhado toca uma qualidade só e este ciclo tem qualidades diferentes: escolha uma forma da qualidade do ciclo ou tire a forma para tocar a região.';
    }
    if (isRotatingFamily(state.recipe.family) && (state.recipe.shapes?.length ?? 0) > 0) {
      return 'Escolha menos formas ou amplie a região: as mesmas formas girando por inversão precisam caber no braço.';
    }
    if (isRotatingFamily(state.recipe.family)) {
      return 'Amplie a região de casas ou reduza as inversões: os graus giram e precisam caber no braço.';
    }
    return 'Amplie a região de casas: as posições do estudo precisam caber no braço deste instrumento.';
  }

  // Um modelo por MOTIVO de aviso, não por aviso: o motor repete dois avisos
  // por acorde (sem-posicao, forma-nao-aplicada) e o diálogo tem teto de
  // controles (10 em repouso, 14 no pior caso). O que compartilha a mesma
  // correção — o tamanho do estudo, teto de 128 compassos e 512 notas — vira
  // UMA linha com UMA ação. Cada modelo carrega os avisos crus: nenhum aviso do
  // motor é escondido.
  function warningModels() {
    const result = state.result;
    if (!result) return [];
    const groups = new Map();
    for (const warning of result.warnings) {
      const key = SIZE_CODES.includes(warning.code) ? 'teto' : warning.code;
      const group = groups.get(key) ?? { key, codes: [], warnings: [] };
      group.warnings.push(warning);
      if (!group.codes.includes(warning.code)) group.codes.push(warning.code);
      groups.set(key, group);
    }
    return [...groups.values()].map(group => {
      const candidates = group.key === 'sem-posicao'
        ? [mergedRegionAction(group.warnings)].filter(Boolean)
        : group.warnings.map(warning => warning.action);
      let action = null;
      let label = null;
      for (const candidate of candidates) {
        const fix = applyWarningAction(result.recipe, candidate);
        if (fix) { action = candidate; label = fix.label; break; }
      }
      return { key: group.key, codes: group.codes, warnings: group.warnings, action, label };
    });
  }

  function viewState() {
    const result = state.result;
    const canOtherKeys = Boolean(state.recipe) && Boolean(result) && canTransposeProgression(state.recipe);
    return {
      title: state.title,
      hint: state.hint,
      origin: state.origin?.name ?? null,
      group: state.group ? `Grupo: ${state.group.label}.` : null,
      controls: state.controls,
      shapes: state.shapes,
      preview: result ? { result, bpm: bpm() } : null,
      status: result ? recipeSummary(state.recipe, result) : '',
      warnings: warningModels(),
      error: state.error,
      errorHint: errorHint(),
      canCreate: Boolean(result) && state.error === null,
      createLabel: state.mode === 'variation' ? 'Criar variação' : 'Criar exercício',
      canOtherKeys,
      otherKeysHint: canOtherKeys
        ? 'Cria as outras 11 tonalidades desta lista de acordes, agrupadas e ligadas a este exercício.'
        : 'Disponível para a progressão "lista de acordes": um ciclo já percorre as 12 tonalidades por si.',
    };
  }

  function render() {
    if (!view) return;
    view.render(viewState());
  }

  // Aceita um formulário vindo da tela: aplica preset, resolve a forma
  // anônima e recalcula. O preset só continua marcado enquanto nada mais mudou.
  function acceptControls(raw) {
    const previous = state.controls;
    let controls = { ...raw };
    const changedSelection = (previous?.shapeIds ?? []).join('|') !== (controls.shapeIds ?? []).join('|');
    // Uma forma sem id (material do catálogo) sobrevive a edições que não
    // mexem na seleção; escolher outra forma descarta o registro anônimo.
    controls.shapeRecords = changedSelection ? [] : (previous?.shapeRecords ?? []);
    if (controls.preset && controls.preset !== 'personalizado' && controls.preset !== previous?.preset) {
      const applied = presetControls(controls.preset, {
        profile: profileFor(controls.strings), start: controls.start, quality: controls.quality,
      });
      controls = { ...applied, preset: controls.preset };
      state.presetSignature = signature(controls);
    } else if (controls.preset !== previous?.preset) {
      state.presetSignature = null;
    } else if (controls.preset && controls.preset !== 'personalizado' && state.presetSignature !== signature(controls)) {
      // O preset descrevia o formulário; depois de qualquer edição ele deixa de
      // valer e o diálogo diz a verdade ("Personalizado").
      controls = { ...controls, preset: 'personalizado' };
      state.presetSignature = null;
    }
    state.controls = controls;
    recompute();
    render();
  }

  // Cria o exercício a partir do estado atual. `overrides` permite o fluxo das
  // 12 tonalidades (grupo próprio) e o modo silencioso das 11 irmãs.
  function commit(overrides = {}) {
    const recipe = overrides.recipe ?? state.recipe;
    const result = recipe === state.recipe ? state.result : generateStudy(recipe, { session: sessionForRecipe() });
    if (!recipe || !result) return null;
    const group = overrides.group ?? state.group ?? null;
    const origin = overrides.origin ?? state.origin ?? null;
    let prepared;
    const title = overrides.name ?? recipeTitle(recipe);
    try { prepared = studyExercise(result, { profile: recipe.profile, name: title, bpm: bpm(), origin, group }); }
    catch (failure) {
      state.error = failure.message;
      render();
      notify(failure.message, true);
      return null;
    }
    let entry;
    try {
      entry = library.new({
        session: prepared.session,
        metadata: { name: prepared.name, tags: ['estudo'], study: prepared.study },
      });
    } catch (failure) {
      notify(`Não foi possível guardar o estudo: ${failure.message}`, true);
      return null;
    }
    return { entry, prepared };
  }

  function finish(entry, { open = true } = {}) {
    if (view) view.close();
    if (!open) return entry;
    try { host.openExercise?.(entry.id, { train: false }); }
    catch (failure) { notify(failure.message, true); }
    return entry;
  }

  function openNextState() {
    recompute();
    if (!view) view = viewFactory({
      onControls: acceptControls,
      onApplyWarning: applyWarning,
      onCreate: () => { const made = commit(); if (made) openExerciseAfterCreate(made.entry); },
      onOtherKeys: () => generateOtherKeys(),
      onClose: () => { /* o diálogo nativo só fecha; o estado fica para reabrir */ },
    });
    view.open(viewState());
  }

  function openExerciseAfterCreate(entry, message) {
    notify(message ?? `Estudo “${entry.metadata.name}” criado na biblioteca; ele abre no Estúdio pronto para editar.`);
    finish(entry);
  }

  function applyWarning(action) {
    if (!state.recipe) return;
    const fix = applyWarningAction(state.recipe, action);
    if (!fix) { notify('Este aviso não tem correção automática: ajuste os controles.', true); return; }
    state.controls = { ...recipeToControls(fix.recipe), preset: 'personalizado' };
    state.presetSignature = null;
    recompute();
    render();
    notify(fix.label);
  }

  function openVariation(id) {
    const entry = library.get(id);
    const recipe = entry?.metadata?.study?.recipe ?? null;
    if (!recipe) {
      notify('Este exercício não guarda uma receita de estudo: use Duplicar para copiá-lo.', true);
      return null;
    }
    return open({ recipe, origin: originLinkFor(entry), mode: 'variation' });
  }

  // Abre o diálogo. Sem receita, começa no preset (padrão: arpejo em quartas) e
  // no instrumento atual quando ele já é um baixo de 5 cordas.
  function open({ recipe = null, origin = null, group = null, preset = null, mode = 'new', title = null, hint = null } = {}) {
    state.mode = mode === 'variation' ? 'variation' : 'new';
    state.origin = origin ?? null;
    state.group = group ?? null;
    state.title = title ?? (state.mode === 'variation' ? `Variação de “${state.origin?.name ?? 'estudo'}”` : 'Novo estudo');
    state.hint = hint ?? (state.mode === 'variation'
      ? 'Mude tonalidade, região, forma, compassos ou cordas: o resultado é um exercício NOVO ligado ao original, que não é alterado.'
      : 'O resultado é um exercício comum e editável no Estúdio. A banda fica desligada e as cifras entram na sessão (Agora · Próximo e avaliação de altura).');
    const strings = recipe ? recipe.profile.strings : defaultStrings();
    if (recipe) {
      state.controls = recipeToControls(recipe);
      state.presetSignature = null;
    } else if (preset) {
      const controls = presetControls(preset, { profile: profileFor(strings) });
      state.controls = { ...controls, preset };
      state.presetSignature = signature(state.controls);
    } else {
      state.controls = { ...defaultControls({ profile: profileFor(strings) }), preset: 'arpejo-quartas' };
      state.presetSignature = signature(state.controls);
    }
    openNextState();
    return view;
  }

  // "Nas 12 tonalidades": as OUTRAS 11 tonalidades da mesma lista de acordes,
  // todas NOVAS e ligadas à BASE — que é o exercício que já guarda esta receita
  // (se existir: 11 exercícios criados, a base fica intacta) ou o estudo atual,
  // criado uma vez junto com as 11 (12 no total, quando ainda não estava
  // salvo). Cada exercício tem id próprio; o grupo da transposição é o vínculo
  // entre as 12 e o vínculo de origem preserva a ascendência (aula/curso).
  function generateOtherKeys() {
    if (!state.recipe || !canTransposeProgression(state.recipe)) {
      notify('Nas 12 tonalidades vale para a lista de acordes: um ciclo já percorre as 12 tonalidades.', true);
      return null;
    }
    const saved = savedBaseFor(state.recipe);
    const group = state.group ?? saved?.metadata?.study?.group ?? { id: uuid(), label: recipeGroupLabel(state.recipe) };
    const origin = state.origin ?? null;
    const base = saved ?? commit({ group, origin })?.entry ?? null;
    if (!base) return null;
    // A base JÁ existente entra no MESMO grupo: o grupo é o que liga as 12 na
    // Biblioteca, e sem isto as 11 irmãs ficariam agrupadas e a base sozinha.
    // Só o rótulo do grupo muda: sessão, receita e histórico ficam intactos.
    const baseEntry = saved && saved.metadata.study.group?.id !== group.id
      ? library.updateMetadata(saved.id, { study: { ...saved.metadata.study, group } })
      : base;
    // As transposições copiam o vínculo de origem do estudo multiplicado (uma
    // variação de aula continua ligada à aula); sem vínculo próprio, ficam
    // ligadas à BASE — nunca a um exercício de fora.
    const siblingOrigin = origin ?? originLinkFor(base);
    const made = [baseEntry];
    for (const recipe of otherKeyRecipes(state.recipe)) {
      const created = commit({ recipe, group, origin: siblingOrigin });
      if (!created) break;
      made.push(created.entry);
    }
    const created = made.length - (saved ? 1 : 0);
    if (made.length === 12) {
      notify(`${made.length} tonalidades em ${group.label}: ${created} exercício${created === 1 ? '' : 's'} novo${created === 1 ? '' : 's'}${saved ? ` (a base “${base.metadata.name}” já existia e não foi tocada)` : ''}. O primeiro abre no Estúdio; os outros ficam na Biblioteca, no mesmo grupo.`);
    } else {
      notify(`${made.length} tonalidade${made.length === 1 ? '' : 's'} em ${group.label}: as demais falharam. Nada foi perdido.`, true);
    }
    finish(baseEntry);
    return made;
  }

  // Caminho programático (etapa 5/cursos): gera, guarda e devolve o exercício
  // sem passar pelo diálogo. O nome é sempre um rótulo MUSICAL; um nome de
  // material de curso só entra com `privateName: true` explícito. Nome e BPM
  // explícitos são aplicados depois de criar, pelos caminhos normais da
  // biblioteca (a receita e o vínculo continuam em metadata).
  function create(recipe, { origin = null, group = null, name = null, privateName = false, bpm: requested = null, open: openAfter = true } = {}) {
    const previous = { controls: state.controls, recipe: state.recipe, result: state.result, group: state.group, origin: state.origin };
    let entry = null;
    try {
      state.recipe = recipe;
      state.result = generateStudy(recipe, { session: sessionForRecipe() });
      state.group = group;
      state.origin = origin;
      const musical = recipeTitle(recipe);
      const privateOrigin = origin?.private === true || group?.private === true;
      let title = musical;
      if (name && (!privateOrigin || privateName)) title = name;
      else if (name && privateOrigin) notify('Nome privado não aplicado: o exercício usa o rótulo musical do estudo.');
      const made = commit({ recipe, group, origin, name: title });
      if (!made) return null;
      entry = made.entry;
      if (Number.isFinite(requested)) {
        try { entry = library.autosave({ ...library.get(entry.id).session, bpm: requested }, entry.id); }
        catch (failure) { notify(`BPM não aplicado: ${failure.message}`, true); }
      }
      return openAfter ? finish(entry) : entry;
    } finally {
      state.controls = previous.controls;
      state.recipe = previous.recipe;
      state.result = previous.result;
      state.group = previous.group;
      state.origin = previous.origin;
    }
  }

  return {
    open,
    openVariation,
    generateOtherKeys,
    create,
    destroy() { view?.destroy(); view = null; },
    get view() { return view; },
    get state() { return state; },
  };
}
