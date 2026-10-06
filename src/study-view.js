// A4 — Diálogo "Novo estudo" da Biblioteca: UMA tela, diálogo nativo criado em
// tempo de execução, prévia ao vivo (tablatura + partitura rítmica + cifras),
// contagem real de compassos e avisos com ação corretiva.
//
// Orçamento de controles VISÍVEIS (critério 8: no máximo 14):
//  - em repouso: Preset, Instrumento, Tonalidade inicial, Região de/até (2),
//    "Mais opções" (recolhido), Criar, Cancelar = 8 (9 com "Nas 12 tonalidades",
//    que só aparece quando a progressão é uma lista);
//  - com "Mais opções" aberto: Preset, "Mais opções", Grupo, até 4 campos do
//    grupo escolhido, Criar, Cancelar = 9 (10 com "Nas 12 tonalidades") — os
//    campos primários saem e viram uma linha de CONTEXTO (texto);
//  - avisos do motor: um botão por motivo (o controlador agrupa), no máximo 4.
// Total no pior caso: 10 + 4 = 14. Nenhum campo foi cortado: os 18 campos
// avançados vivem em 5 grupos (Progressão, Figura, Forma, Região, Duração), um
// visível por vez, reusando os MESMOS nós de campo (nada duplicado, nada
// perdido — o formulário inteiro continua sendo lido no commit). Não existe
// contagem de "formas combinadas": a figura toca as formas ESCOLHIDAS.
//
// Este módulo não conhece a biblioteca nem a loja de formas: recebe o estado
// pronto do controlador (A4) e devolve intenções (`onControls`, `onCreate`,
// `onApplyWarning`, `onOtherKeys`). A prévia usa os renderizadores EXISTENTES:
// `renderPracticeScore` já desenha tablatura, partitura e cifras, e
// `harmony-readout.js` fornece a leitura "Agora · Próximo".

import { createEl } from './practice.js';
import { buildRhythmNotation } from './notation.js';
import { renderPracticeScore } from './studio-score.js';
import { createHarmonyReadout } from './harmony-readout.js';
import { STUDY_MAX_BARS, STUDY_QUALITIES, STUDY_QUALITY_LABELS, STUDY_RHYTHMS } from './study-generator.js';
import {
  STUDY_FAMILY_LABELS, STUDY_FINAL_LABELS, STUDY_ORDER_LABELS, STUDY_PRESETS,
  STUDY_PROGRESSION_LABELS, STUDY_RHYTHM_LABELS,
  cycleStarts, figureBarsLimit, isContinuousFamily, isCycleProgression, isPercursoFamily, isShapeFamily,
} from './study-recipe.js';
import { previewSession } from './study-session.js';

// Texto curto dos motivos que aparecem UMA vez por geração. A ação corretiva
// vem do gerador; o RÓTULO do botão é calculado pelo controlador, que é quem
// sabe mexer na receita. Os motivos que o motor repete por acorde
// (sem-posicao, forma-nao-aplicada) e o teto da sessão (128 compassos / 512
// notas) são escritos em `warningText`, sempre sobre o motivo inteiro.
const WARNING_TEXT = Object.freeze({
  'aumentar-compassos': warning => (warning.scope === 'figura'
    ? `A figura não cabe em ${warning.figureBars} compasso(s) por bloco: são necessários ${warning.minimumFigureBars}.`
    : `A receita pede ${warning.requestedBars} compasso(s) e o estudo precisa de ${warning.minimumBars} (o compasso final conta).`),
  'forma-divergente': warning => `A figura e a forma não usam os mesmos graus: sobram ${warning.unused?.join(',') || 'nenhum'} e faltam ${warning.missing?.join(',') || 'nenhum'}.`,
});

// Por que uma forma não entrou naquele acorde (motivo do motor).
const SHAPE_REASON_TEXT = Object.freeze({
  cordas: 'usa mais cordas do que o instrumento',
  casas: 'sai das casas 0–24',
  graus: 'graus fora da figura',
});

// Texto de UM motivo (modelo) de aviso: os avisos repetidos por acorde são
// resumidos na linha inteira, nunca escondidos.
function warningText(model) {
  const warnings = model.warnings ?? [];
  if (model.key === 'sem-posicao') {
    const notes = warnings.reduce((total, warning) => total + (warning.count ?? 0), 0);
    return `${notes} nota(s) em ${warnings.length} acorde(s) ficam fora da região; nada foi descartado.`;
  }
  if (model.key === 'teto') {
    const parts = warnings.map(warning => (warning.code === 'limite-128'
      ? (warning.needed === null || warning.needed === undefined
        ? `o ciclo passa do teto de ${warning.limit} compassos`
        : `o ciclo pede ${warning.needed} compassos e o teto é ${warning.limit}`)
      : `o estudo chega a ${warning.count} notas e uma sessão aceita ${warning.limit}`));
    return `O estudo passa do que uma sessão aceita: ${parts.join('; ')}.`;
  }
  if (model.key === 'forma-nao-aplicada') {
    const reasons = [...new Set(warnings.map(warning => SHAPE_REASON_TEXT[warning.reason] ?? 'não cabe no braço'))];
    return `${warnings.length} acorde(s) não receberam a forma (${reasons.join('; ')}); o estudo usou as posições da região.`;
  }
  const warning = warnings[0] ?? {};
  return WARNING_TEXT[model.key]?.(warning) ?? 'Aviso do gerador sem texto conhecido.';
}

// Mínimo de compassos por bloco que o motor pediu no aviso (um percurso de 5
// cordas na região 1–12 precisa de 5): o controle aceita esse número em vez de
// recusar a correção do próprio aviso.
function requiredFigureBars(models) {
  const values = (models ?? [])
    .flatMap(model => model?.warnings ?? [])
    .map(warning => warning.minimumFigureBars)
    .filter(value => Number.isFinite(value));
  return values.length ? Math.max(...values) : 0;
}

// Grupo de opções do painel avançado: UMA tela, um grupo visível por vez. Cada
// grupo declara no máximo 4 campos VISÍVEIS ao mesmo tempo (as regras de
// aplicabilidade escondem o resto), então o diálogo não passa de 10 controles
// visíveis em nenhum estado — 14 no pior caso, com os botões dos avisos.
const ADVANCED_GROUPS = Object.freeze([
  Object.freeze(['progressao', 'Progressão']),
  Object.freeze(['figura', 'Figura']),
  Object.freeze(['forma', 'Forma']),
  Object.freeze(['regiao', 'Região']),
  Object.freeze(['duracao', 'Duração']),
]);

function fill(select, options, value) {
  select.replaceChildren();
  for (const [optionValue, label] of options) select.append(createEl('option', { value: String(optionValue), text: label }));
  const text = value === null || value === undefined ? '' : String(value);
  if ([...select.options].some(option => option.value === text)) select.value = text;
}

function labelled(label, control, className = '') {
  return createEl('label', { className: `study-field ${className}`.trim() }, [createEl('span', { text: label }), control]);
}

function input(id, label, attributes = {}) {
  return createEl('input', { id, type: 'number', 'aria-label': label, ...attributes });
}

export function createStudyView({
  onControls = () => {}, onApplyWarning = () => {}, onCreate = () => {}, onOtherKeys = () => {}, onClose = () => {},
} = {}) {
  const dialog = createEl('dialog', {
    id: 'study-dialog', className: 'study-dialog',
    'aria-labelledby': 'study-title', 'aria-describedby': 'study-hint',
  });
  const heading = createEl('h2', { id: 'study-title', text: 'Novo estudo' });
  const hint = createEl('p', { id: 'study-hint', className: 'study-hint muted' });

  const preset = createEl('select', { id: 'study-preset', 'aria-label': 'Preset do estudo' });
  const profile = createEl('select', { id: 'study-profile', 'aria-label': 'Instrumento' });
  const start = createEl('select', { id: 'study-start', 'aria-label': 'Tonalidade inicial' });
  const quality = createEl('select', { id: 'study-quality', 'aria-label': 'Qualidade do acorde' });
  const bars = input('study-bars', 'Compassos', { min: '1', max: String(STUDY_MAX_BARS), placeholder: 'automático' });
  const regionFrom = input('study-region-from', 'Região: primeira casa', { min: '0', max: '24' });
  const regionTo = input('study-region-to', 'Região: última casa', { min: '0', max: '24' });

  const family = createEl('select', { id: 'study-family', 'aria-label': 'Família do estudo' });
  const progression = createEl('select', { id: 'study-progression', 'aria-label': 'Progressão de acordes' });
  const direction = createEl('select', { id: 'study-direction', 'aria-label': 'Sentido do ciclo' });
  const cycleLength = input('study-cycle-length', 'Acordes do ciclo', { min: '1', max: '64', placeholder: 'natural' });
  const chords = createEl('input', { id: 'study-chords', type: 'text', placeholder: 'C, Am, Dm7, G7', 'aria-label': 'Lista de acordes' });
  const rhythm = createEl('select', { id: 'study-rhythm', 'aria-label': 'Figura rítmica' });
  const degrees = createEl('input', { id: 'study-degrees', type: 'text', placeholder: '1,3,5', 'aria-label': 'Graus por acorde' });
  const figureBars = input('study-figure-bars', 'Compassos por bloco', { min: '1', max: '4', placeholder: 'automático' });
  const inversions = input('study-inversions', 'Inversões por acorde', { min: '1', max: '4' });
  const notes = input('study-notes', 'Notas por acorde', { min: '1', max: '32' });
  const order = createEl('select', { id: 'study-order', 'aria-label': 'Ordem da figura' });
  const voltas = createEl('input', { id: 'study-voltas', type: 'text', placeholder: '1 (ou periodo)', 'aria-label': 'Voltas do ciclo' });
  const final = createEl('select', { id: 'study-final', 'aria-label': 'Preenchimento final' });
  const shape = createEl('select', { id: 'study-shape', 'aria-label': 'Forma de dedilhado' });
  const regionStrings = createEl('input', { id: 'study-region-strings', type: 'text', placeholder: 'todas', 'aria-label': 'Cordas da região' });
  const regionOpen = createEl('input', { id: 'study-region-open', type: 'checkbox', 'aria-label': 'Admitir cordas soltas (casa 0)' });
  const otherKeys = createEl('button', { id: 'study-other-keys', type: 'button', text: 'Nas 12 tonalidades' });

  const field = {
    direction: labelled('Sentido', direction),
    chords: labelled('Lista de acordes', chords, 'study-field-wide'),
    degrees: labelled('Graus por acorde', degrees),
    inversions: labelled('Inversões', inversions),
    notes: labelled('Notas por acorde', notes),
    order: labelled('Ordem', order),
    shape: labelled('Forma de dedilhado (Braço)', shape, 'study-field-wide'),
  };

  // UMA tela, um grupo de opções visível por vez: os MESMOS nós de campo são
  // escondidos por CSS, então nenhum controle é duplicado e nenhum valor
  // digitado se perde (o formulário inteiro continua sendo lido no commit).
  const groupSelect = createEl('select', { id: 'study-advanced-group', 'aria-label': 'Grupo de opções' });
  const contextLine = createEl('p', { id: 'study-advanced-context', className: 'study-advanced-context muted' });
  const groups = {
    progressao: createEl('div', { className: 'study-group', dataset: { group: 'progressao' } }, [
      labelled('Progressão', progression),
      labelled('Qualidade', quality),
      field.direction,
      field.chords,
      labelled('Acordes do ciclo', cycleLength),
    ]),
    figura: createEl('div', { className: 'study-group', dataset: { group: 'figura' } }, [
      labelled('Família', family),
      labelled('Figura rítmica', rhythm),
      field.degrees,
      field.notes,
      field.order,
    ]),
    forma: createEl('div', { className: 'study-group', dataset: { group: 'forma' } }, [
      field.shape,
      field.inversions,
      createEl('p', { className: 'study-hint muted', text: 'A forma de dedilhado vale para as famílias de arpejo; as inversões, para "Arpejo nas inversões".' }),
    ]),
    regiao: createEl('div', { className: 'study-group', dataset: { group: 'regiao' } }, [
      labelled('Cordas da região', regionStrings),
      labelled('Cordas soltas', regionOpen, 'study-field-inline'),
    ]),
    duracao: createEl('div', { className: 'study-group', dataset: { group: 'duracao' } }, [
      labelled('Compassos', bars),
      labelled('Compassos por bloco', figureBars),
      labelled('Voltas', voltas),
      labelled('Final', final),
    ]),
  };

  const advanced = createEl('details', { id: 'study-advanced', className: 'study-advanced-details', dataset: { disclosure: 'study-advanced' } }, [
    createEl('summary', { text: 'Mais opções' }),
    createEl('div', { className: 'study-advanced' }, [
      contextLine,
      labelled('Grupo', groupSelect),
      groups.progressao,
      groups.figura,
      groups.forma,
      groups.regiao,
      groups.duracao,
      createEl('p', {
        className: 'study-hint muted',
        text: 'Progressão "lista" usa a lista de acordes; "sessão" lê a progressão do exercício ativo. Cordas: "todas" ou números separados por vírgula (1 = mais aguda).',
      }),
    ]),
  ]);

  // Campos primários: aparecem em repouso e saem quando "Mais opções" abre (os
  // valores viram a linha de contexto do painel).
  const primaryRow = createEl('div', { className: 'study-row', id: 'study-primary' }, [
    labelled('Instrumento', profile),
    labelled('Tonalidade inicial', start),
    labelled('Região de (casa)', regionFrom),
    labelled('até', regionTo),
  ]);

  const readout = createHarmonyReadout();
  const tabScore = createEl('div', { id: 'study-preview-tab', className: 'rhythm-score study-preview-score' });
  const rhythmScore = createEl('div', { id: 'study-preview-rhythm', className: 'rhythm-score study-preview-score' });
  const status = createEl('p', { id: 'study-status', className: 'study-status', role: 'status' });
  const errorBox = createEl('div', { id: 'study-error', className: 'study-error', role: 'alert', hidden: true });
  const errorHint = createEl('p', { id: 'study-error-hint', className: 'study-error-hint', hidden: true });
  const originLine = createEl('p', { id: 'study-origin', className: 'study-hint muted', hidden: true });
  const warningList = createEl('ul', { id: 'study-warning-list', className: 'study-warning-list' });
  const warnings = createEl('div', { className: 'study-warnings', hidden: true }, [warningList]);

  const create = createEl('button', { id: 'study-create', type: 'button', className: 'primary', text: 'Criar exercício' });
  const cancel = createEl('button', { id: 'study-cancel', type: 'button', text: 'Cancelar' });

  dialog.append(
    heading,
    hint,
    createEl('div', { className: 'study-body' }, [
      createEl('div', { className: 'study-row' }, [labelled('Preset', preset, 'study-field-wide')]),
      primaryRow,
      originLine,
      advanced,
      status,
      errorBox,
      errorHint,
      warnings,
      createEl('section', { className: 'study-preview', 'aria-label': 'Prévia do estudo' }, [
        createEl('h3', { className: 'study-preview-title', text: 'Prévia' }),
        readout.element,
        tabScore,
        rhythmScore,
      ]),
    ]),
    createEl('div', { className: 'study-actions' }, [otherKeys, create, cancel]),
  );
  (document.body ?? document.documentElement).appendChild(dialog);

  // ------------------------------------------------------------- escrita

  // Escreve só o que mudou e nunca escreve NaN: o texto que o usuário digitou
  // (ainda inválido) fica na tela, com o erro explicado ao lado.
  function write(node, value) {
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    const text = value === null || value === undefined ? '' : String(value);
    if (node.value !== text) node.value = text;
  }

  function writeChoice(node, value) {
    const text = value === null || value === undefined ? '' : String(value);
    if (node.value !== text) writeChoiceValue(node, text);
  }

  function writeChoiceValue(node, text) {
    if ([...node.options].some(option => option.value === text)) node.value = text;
  }

  let controls = null;
  let activeGroup = 'progressao';
  fill(groupSelect, ADVANCED_GROUPS, activeGroup);

  // Contexto do painel avançado: os valores dos campos primários como TEXTO
  // (nenhum controle a mais). Só valores musicais — nada privado.
  function contextText(next) {
    if (!next) return '';
    const strings = next.strings === 5 ? 'Baixo 5 cordas' : 'Baixo 4 cordas';
    const quality = STUDY_QUALITY_LABELS[next.quality] ?? next.quality ?? '';
    const region = Number.isFinite(Number(next.regionFrom)) && Number.isFinite(Number(next.regionTo))
      ? `região ${Number(next.regionFrom)}–${Number(next.regionTo)}`
      : 'região automática';
    return `${strings} · ${next.start ?? 'C'} ${quality} · ${region}`;
  }

  // Em repouso: campos primários. Com "Mais opções" aberto: eles saem, o painel
  // mostra o contexto e UM grupo de campos (o escolhido). Nunca mais de 10
  // controles visíveis.
  function applyLayout() {
    const open = advanced.open === true;
    primaryRow.hidden = open;
    for (const [key, node] of Object.entries(groups)) node.hidden = !open || key !== activeGroup;
    if (open) contextLine.textContent = contextText(controls);
  }

  // Preenche a lista só quando ela muda de verdade (rótulos incluídos): um
  // seletor com as mesmas 12 tonalidades em OUTRA ordem precisa ser reescrito.
  function fillIfChanged(select, options, value) {
    const signature = options.map(([optionValue, label]) => `${optionValue}\u0000${label}`).join('\u0001');
    if (select.dataset.options !== signature) {
      fill(select, options, value);
      select.dataset.options = signature;
    }
    writeChoice(select, value);
  }

  function renderOptions(next) {
    // Listas que dependem do estado: tonalidades (ordem do ciclo), ritmos
    // possíveis para a família e formas de dedilhado disponíveis.
    fillIfChanged(preset, [...STUDY_PRESETS.map(item => [item.id, item.label]), ['personalizado', 'Personalizado']], next.preset);
    fillIfChanged(start, cycleStarts(next.progression).map(name => [name, name]), next.start);
    const rhythms = isContinuousFamily(next.family) ? ['quarters', 'eighths'] : STUDY_RHYTHMS;
    fillIfChanged(rhythm, rhythms.map(id => [id, STUDY_RHYTHM_LABELS[id]]), next.rhythm);
    fillIfChanged(profile, [[4, 'Baixo 4 cordas'], [5, 'Baixo 5 cordas']], next.strings);
    fillIfChanged(quality, STUDY_QUALITIES.map(id => [id, STUDY_QUALITY_LABELS[id]]), next.quality);
    fillIfChanged(family, Object.entries(STUDY_FAMILY_LABELS), next.family);
    fillIfChanged(progression, Object.entries(STUDY_PROGRESSION_LABELS), next.progression);
    fillIfChanged(direction, [['ascendente', 'Ascendente'], ['descendente', 'Descendente']], next.direction);
    fillIfChanged(order, Object.entries(STUDY_ORDER_LABELS), next.order);
    fillIfChanged(final, Object.entries(STUDY_FINAL_LABELS), next.final);
  }

  function renderFields(next, warnings = []) {
    controls = next;
    write(bars, next.bars);
    write(regionFrom, next.regionFrom);
    write(regionTo, next.regionTo);
    write(cycleLength, next.cycleLength);
    write(chords, next.chords);
    write(degrees, next.degrees);
    write(figureBars, next.figureBars);
    // Teto DINÂMICO do controle: o maior entre o teto da família, o mínimo que
    // o aviso do motor pediu (5 cordas na região 1–12 = 5 compassos) e o valor
    // já resolvido na receita. Vazio continua valendo = automático.
    figureBars.max = String(figureBarsLimit({
      family: next.family,
      minimumFigureBars: requiredFigureBars(warnings),
      current: Number(next.figureBars),
    }));
    write(inversions, next.inversions);
    write(notes, next.notes);
    write(voltas, next.voltas);
    write(regionStrings, next.regionStrings);
    regionOpen.checked = next.regionOpen === true;
    const harmonic = !isContinuousFamily(next.family);
    const shaped = Array.isArray(next.shapeIds) && next.shapeIds.length > 0;
    // Só fica na tela o controle que vale para a receita escolhida.
    field.chords.hidden = next.progression !== 'lista';
    field.direction.hidden = !isCycleProgression({ progression: { kind: next.progression } });
    field.degrees.hidden = !harmonic || shaped;
    field.inversions.hidden = next.family !== 'arpejo_tres_inversoes_por_acorde';
    field.notes.hidden = harmonic;
    field.shape.hidden = !isShapeFamily(next.family);
    // Nos percursos a ordem é da família (sobe-desce / desce-sobe): o controle
    // sai da tela em vez de oferecer uma escolha que o gerador recusa.
    field.order.hidden = isPercursoFamily(next.family);
    degrees.disabled = shaped && harmonic;
    // Com MAIS DE UMA forma escolhida a contagem vem da seleção (uma forma por
    // inversão); com uma só, a contagem digitada continua valendo (o motor gira
    // a mesma forma).
    const counted = (next.shapeIds ?? []).length > 1;
    inversions.disabled = counted && next.family === 'arpejo_tres_inversoes_por_acorde';
  }

  function renderShapes(next, records) {
    // Uma forma por figura (`arpejo_triade_forma_unica`) é escolha única; as
    // famílias que combinam formas usam tantas quantas a figura pede — a
    // receita acompanha a contagem (uma seleção de 2 formas pede 2 slots).
    const single = next.family === 'arpejo_triade_forma_unica';
    if (shape.multiple === single) {
      shape.multiple = !single;
      shape.size = single ? 1 : 3;
    }
    const options = single
      ? [['', 'Nenhuma (derivar pela região)'], ...records.map(record => [record.id, `${record.label}${record.generic ? ' (genérica)' : ''}`])]
      : [...records.map(record => [record.id, `${record.label}${record.generic ? ' (genérica)' : ''}`])];
    const sameOptions = shape.options.length === options.length
      && options.every((option, index) => shape.options[index]?.value === String(option[0]));
    if (!sameOptions) {
      fill(shape, options, '');
      for (const option of [...shape.options]) option.selected = next.shapeIds.includes(option.value);
    }
  }

  function readShapeIds() {
    return shape.multiple
      ? [...shape.selectedOptions].map(option => option.value).filter(Boolean)
      : (shape.value ? [shape.value] : []);
  }

  function renderPreview(preview) {
    if (!preview) {
      tabScore.replaceChildren();
      rhythmScore.replaceChildren();
      readout.update(null, {});
      return;
    }
    try {
      const tab = previewSession(preview.result, { phraseView: 'tab', bpm: preview.bpm });
      const rhythmView = previewSession(preview.result, { phraseView: 'rhythm', bpm: preview.bpm });
      renderPracticeScore(tabScore, buildRhythmNotation(tab.notes, tab), tab, { strokes: false });
      renderPracticeScore(rhythmScore, buildRhythmNotation(rhythmView.notes, rhythmView), rhythmView, { strokes: false });
      readout.update(rhythmView, { tick: 0, mode: 'idle' });
    } catch (error) {
      // O desenho da prévia é acessório: o exercício é gerado e validado de novo
      // no commit. Se o renderizador recusar o material (por exemplo mais
      // compassos do que a partitura aceita), a tela DIZ isso em vez de mostrar
      // um desenho parcial.
      tabScore.replaceChildren(createEl('p', { className: 'study-preview-note muted', text: `Prévia indisponível: ${error.message}` }));
      rhythmScore.replaceChildren();
      readout.update(null, {});
    }
  }

  function renderWarnings(list) {
    warnings.hidden = list.length === 0;
    warningList.replaceChildren();
    for (const model of list) {
      const item = createEl('li', { className: 'study-warning', dataset: { code: model.key } }, [
        createEl('span', { text: warningText(model) }),
      ]);
      // Sem ação calculada não existe botão: um botão que não muda a receita é
      // um controle morto (o motivo continua escrito na linha).
      if (model.label) {
        const apply = createEl('button', { type: 'button', text: model.label, dataset: { action: model.key } });
        apply.addEventListener('click', () => onApplyWarning(model.action));
        item.append(apply);
      }
      warningList.append(item);
    }
  }

  function render(state) {
    if (state.title) heading.textContent = state.title;
    hint.textContent = state.hint ?? '';
    originLine.hidden = !state.origin;
    originLine.textContent = state.origin ? `Variação de “${state.origin}” — o original não é alterado.` : '';
    if (state.group) originLine.textContent = `${originLine.textContent} ${state.group}`.trim();
    renderOptions(state.controls);
    renderFields(state.controls, state.warnings ?? []);
    renderShapes(state.controls, state.shapes ?? []);
    status.textContent = state.status ?? '';
    status.hidden = !state.status;
    errorBox.hidden = !state.error;
    errorBox.textContent = state.error ?? '';
    errorHint.hidden = !state.errorHint;
    errorHint.textContent = state.errorHint ?? '';
    create.disabled = state.canCreate !== true;
    create.textContent = state.createLabel ?? 'Criar exercício';
    otherKeys.hidden = state.canOtherKeys !== true;
    otherKeys.title = state.otherKeysHint ?? '';
    renderWarnings(state.warnings ?? []);
    renderPreview(state.preview ?? null);
    applyLayout();
  }

  // O formulário inteiro volta a cada mudança: o controlador valida, gera e
  // decide o que a tela mostra. Nenhum campo é lido fora deste caminho.
  function read() {
    const number = node => (node.value.trim() === '' ? null : Number(node.value));
    return {
      preset: preset.value,
      strings: Number(profile.value) === 5 ? 5 : 4,
      start: start.value,
      family: family.value,
      progression: progression.value,
      direction: direction.value,
      quality: quality.value,
      chords: chords.value,
      cycleLength: number(cycleLength),
      bars: number(bars),
      regionFrom: number(regionFrom),
      regionTo: number(regionTo),
      regionOpen: regionOpen.checked,
      regionStrings: regionStrings.value,
      shapeIds: readShapeIds(),
      rhythm: rhythm.value,
      figureBars: number(figureBars),
      degrees: degrees.value,
      inversions: number(inversions),
      notes: number(notes),
      order: order.value,
      voltas: voltas.value.trim(),
      final: final.value,
    };
  }

  const emit = () => onControls(read());
  for (const node of [preset, profile, start, family, progression, direction, quality, rhythm, order, final, shape, regionOpen]) {
    node.addEventListener('change', emit);
  }
  for (const node of [bars, regionFrom, regionTo, cycleLength, chords, degrees, figureBars, inversions, notes, voltas, regionStrings]) {
    node.addEventListener('input', emit);
  }
  create.addEventListener('click', () => onCreate());
  otherKeys.addEventListener('click', () => onOtherKeys());
  // O grupo é só do LAYOUT: trocar de grupo não muda a receita (não emite).
  groupSelect.addEventListener('change', () => { activeGroup = groupSelect.value; applyLayout(); });
  advanced.addEventListener('toggle', applyLayout);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => onClose());

  return {
    element: dialog,
    // Abre (ou reabre) com o estado completo do controlador.
    open(state) {
      activeGroup = 'progressao';
      groupSelect.value = activeGroup;
      advanced.open = false;
      render(state);
      if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
      else dialog.open = true;
      dialog.querySelector('#study-preset')?.focus({ preventScroll: true });
    },
    render(state) { controls = state.controls; render(state); },
    get controls() { return controls; },
    close() { if (dialog.open) dialog.close(); else onClose(); },
    destroy() { if (dialog.open) dialog.close(); dialog.remove(); },
  };
}
