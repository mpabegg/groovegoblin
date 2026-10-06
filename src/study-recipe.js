// A4 — Receita de estudo vista pela interface: presets, estado dos controles e
// ações corretivas. Módulo PURO (sem DOM, sem biblioteca, sem sessão
// persistida): só traduz de/para `src/study-generator.js`, que continua sendo o
// dono da validação e da geometria.
//
// Duas direções:
//  - `controlsToRecipe(controls)` monta a receita a partir do formulário e
//    deixa o gerador validar (`normalizeRecipe` lança TypeError em português).
//  - `recipeToControls(recipe)` volta ao formulário — é assim que uma VARIAÇÃO
//    abre o diálogo preenchido com a receita do exercício original, sem tocar
//    no original.
//
// A "forma" de dedilhado entra por `shapeLookup` injetado: este módulo não
// conhece a loja de formas (A3) nem o DOM.

import { parseChordSymbol } from './progression.js';
import {
  STUDY_FAMILIES, STUDY_PROGRESSIONS, STUDY_QUALITIES, STUDY_QUALITY_IDS, STUDY_QUALITY_LABELS,
  STUDY_RHYTHMS, STUDY_FINALS, STUDY_MAX_BARS, STUDY_MAX_FIGURE_BARS, STUDY_MAX_NOTES, STUDY_REGION_DEFAULT,
  STUDY_SHAPE_FAMILIES, STUDY_CONTINUOUS_FAMILIES, defaultRecipe, maxFigureBars, normalizeRecipe,
} from './study-generator.js';

// Modo de voltas "até fechar o período" do gerador (`PERIOD`). O valor é
// um token do contrato da receita; fica aqui como literal para que a interface
// não dependa de um export novo do motor (se o token mudar, `normalizeRecipe`
// recusa e a tela mostra o erro — nunca um estudo silenciosamente diferente).
const PERIOD = 'periodo';

// Nome da qualidade do estudo a partir da cifra (`'' -> major`, `m -> minor`).
const QUALITY_NAME_FROM_ID = Object.freeze(Object.fromEntries(
  Object.entries(STUDY_QUALITY_IDS).map(([name, id]) => [id, name]),
));

export const STUDY_PRESET_IDS = Object.freeze(['arpejo-quartas', 'continuo', 'sobe-desce', 'personalizado']);

export const STUDY_FAMILY_LABELS = Object.freeze({
  arpejo_triade_forma_unica: 'Arpejo de tríade (uma forma)',
  arpejo_triade_formas_combinadas: 'Arpejo com formas combinadas',
  arpejo_tres_inversoes_por_acorde: 'Arpejo nas inversões do acorde',
  movimento_continuo_linha_4_notas: 'Movimento contínuo em 4 notas',
  movimento_continuo_grave_agudo_grave: 'Movimento grave–agudo–grave',
  movimento_continuo_agudo_grave_agudo: 'Movimento agudo–grave–agudo',
});

export const STUDY_PROGRESSION_LABELS = Object.freeze({
  quartas: 'Ciclo de quartas',
  quintas: 'Ciclo de quintas',
  cromatica: 'Cromático',
  lista: 'Lista de acordes',
  sessao: 'Progressão da sessão atual',
});

export const STUDY_RHYTHM_LABELS = Object.freeze({
  arpejo: 'Arpejo (semínimas + ligadura)',
  quarters: 'Semínimas',
  eighths: 'Colcheias',
});

export const STUDY_ORDER_LABELS = Object.freeze({
  sobe: 'Subindo',
  desce: 'Descendo',
  'sobe-desce': 'Sobe e desce',
  'desce-sobe': 'Desce e sobe',
});

// Final do estudo: a pergunta é "repetir o primeiro acorde no fim?" — Sim
// (tônica do PRIMEIRO acorde da progressão, o PADRÃO do pedido), Não (para na
// última volta) ou a tônica do último acorde tocado. O motor é quem posiciona
// a nota; aqui é só o rótulo, e cada um diz o que realmente sai.
export const STUDY_FINAL_LABELS = Object.freeze({
  tonica: 'Sim: repetir o primeiro acorde no fim',
  nenhum: 'Não: para no fim da última volta',
  acorde: 'Não: termina na tônica do último acorde tocado',
});

// Aviso -> rótulo da correção. O gerador já manda a ação em `warning.action`;
// aqui só se decide o texto e o que a ação muda na receita. O rótulo recebe a
// receita corrigida e a anterior para dizer exatamente o que muda.
const WARNING_LABELS = Object.freeze({
  'aumentar-compassos': (fixed, previous) => {
    const perChord = previous && fixed.figure.bars !== previous.figure.bars && fixed.bars === previous.bars;
    const bars = fixed.bars ?? fixed.figure.bars;
    return perChord
      ? `Aumentar para ${fixed.figure.bars} compasso${fixed.figure.bars === 1 ? '' : 's'} por acorde`
      : `Aumentar para ${bars} compasso${bars === 1 ? '' : 's'}`;
  },
  // A chave é o `kind` da AÇÃO (o que `applyWarningAction` recebe), não o
  // motivo do aviso: o modelo da tela agrupa por motivo ('sem-posicao') e
  // passa a ação crua do motor ('expandir-regiao') para cá.
  'expandir-regiao': fixed => `Ampliar a região para ${fixed.region.from}–${fixed.region.to}`,
  'reduzir-voltas': fixed => `Reduzir para ${fixed.voltas} volta${fixed.voltas === 1 ? '' : 's'}`,
  'aumentar-limite': () => 'Reduzir para caber em uma sessão',
  'reduzir-ciclo': fixed => `Reduzir o ciclo para ${fixed.progression.length} acorde${fixed.progression.length === 1 ? '' : 's'}`,
  'usar-graus-da-forma': fixed => `Usar os graus da forma (${Array.isArray(fixed.figure.degrees) ? fixed.figure.degrees.join(',') : 'da forma'})`,
});

// Inícios por progressão, já na ordem do ciclo (quartas/quintas) para que a
// lista da interface e o botão "outras 11 tonalidades" mostrem o mesmo grupo.
const CYCLE_STARTS = Object.freeze({
  quartas: Object.freeze(['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'B', 'E', 'A', 'D', 'G']),
  quintas: Object.freeze(['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#', 'F']),
  cromatica: Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']),
});
const PLAIN_STARTS = Object.freeze(['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']);

export function cycleStarts(kind) {
  return CYCLE_STARTS[kind] ?? PLAIN_STARTS;
}

// Progressão em ciclo: percorre as 12 tonalidades por si mesma (não precisa de
// "Nas 12 tonalidades"). Lista/sessão não têm ciclo de tonalidades.
export function isCycleProgression(recipe) {
  return ['quartas', 'quintas', 'cromatica'].includes(recipe?.progression?.kind);
}

// "Nas 12 tonalidades" (item A4): a lista de acordes pode ser TRANSPOSTA para
// as outras 11 tonalidades (ex.: I–vi–ii–V em C -> em Db, D, ...). Um ciclo
// (quartas/quintas/cromática) já percorre as 12 fundamentais por si; a
// progressão "da sessão" não tem lista própria para transpor.
export function canTransposeProgression(recipe) {
  return recipe?.progression?.kind === 'lista';
}

export function isShapeFamily(family) {
  return STUDY_SHAPE_FAMILIES.includes(family);
}

// Famílias que GIRAM os graus-base (inversões/combinadas): as mesmas formas são
// rotacionadas por slot, então a forma precisa caber no braço em todas as
// inversões. Serve para explicar, na tela, o que ajustar quando o motor recusa.
export function isRotatingFamily(family) {
  return family === 'arpejo_tres_inversoes_por_acorde' || family === 'arpejo_triade_formas_combinadas';
}

export function isContinuousFamily(family) {
  return STUDY_CONTINUOUS_FAMILIES.includes(family);
}

// Percursos (grave–agudo–grave / agudo–grave–agudo) têm a ORDEM da família: a
// figura atravessa a região subindo e voltando. Ordem digitada diferente é
// recusada pelo gerador, então a receita nem a manda (a família decide).
export function isPercursoFamily(family) {
  return family === 'movimento_continuo_grave_agudo_grave' || family === 'movimento_continuo_agudo_grave_agudo';
}

// Teto do controle "Compassos por bloco". O contrato do motor é DINÂMICO: um
// percurso toca a escada inteira de cada acorde e pode precisar de mais de 4
// compassos (5 cordas, região 1–12 em Dó = 17 semínimas = 5 compassos); os
// arpejos continuam com o teto de 4. O teto nunca é um corte arbitrário: é o
// maior entre o teto declarado da família, o mínimo que o aviso do motor pediu
// e o valor que já está resolvido na receita.
export function figureBarsLimit({ family = null, minimumFigureBars = 0, current = 0 } = {}) {
  const declared = maxFigureBars(family);
  const minimum = Number.isFinite(minimumFigureBars) && minimumFigureBars > 0 ? Math.ceil(minimumFigureBars) : 0;
  const resolved = Number.isFinite(current) && current > 0 ? Math.ceil(current) : 0;
  return Math.max(STUDY_MAX_FIGURE_BARS, declared, minimum, resolved);
}

// ---------------------------------------------------------------- presets

// Receitas-base dos três presets do diálogo (item A4). Nomes e números são os
// do pedido: arpejo em quartas com 25 compassos (o acorde final repete o
// primeiro), linha contínua na região 1–5 com 13 compassos e "sobe e desce"
// na mesma região. `final: 'tonica'` = o último compasso traz a tônica do
// PRIMEIRO acorde da progressão (repetir o começo), nunca um acorde de fora.
function presetSpec(id) {
  const region = overrides => Object.freeze({ ...STUDY_REGION_DEFAULT, ...overrides });
  if (id === 'continuo') {
    return {
      label: 'Linha contínua numa região',
      overrides: {
        family: 'movimento_continuo_linha_4_notas',
        figure: { notes: 4, order: 'sobe', bars: 1 },
        rhythm: 'quarters',
        region: region({ from: 1, to: 5 }),
        bars: 13,
        final: 'tonica',
      },
    };
  }
  if (id === 'sobe-desce') {
    return {
      label: 'Sobe e desce numa região',
      overrides: {
        family: 'movimento_continuo_grave_agudo_grave',
        figure: { notes: 4, order: 'sobe-desce', bars: 1 },
        rhythm: 'quarters',
        region: region({ from: 1, to: 5 }),
        final: 'tonica',
      },
    };
  }
  if (id === 'arpejo-quartas') {
    return {
      label: 'Arpejo pelo ciclo de quartas',
      overrides: {
        family: 'arpejo_triade_forma_unica',
        figure: { degrees: [1, 3, 5], bars: 2, order: 'sobe' },
        rhythm: 'arpejo',
        bars: 25,
        final: 'tonica',
      },
    };
  }
  return null;
}

export const STUDY_PRESETS = Object.freeze(STUDY_PRESET_IDS
  .filter(id => id !== 'personalizado')
  .map(id => Object.freeze({ id, label: presetSpec(id).label })));

export function presetRecipe(id, { profile = null, start = 'C', quality = 'major' } = {}) {
  const spec = presetSpec(id);
  if (spec === null) throw new RangeError(`Preset de estudo desconhecido: ${id}.`);
  return defaultRecipe({
    profile: profile ?? { type: 'bass', strings: 4 },
    progression: { kind: 'quartas', start, quality },
    ...spec.overrides,
  });
}

export function presetControls(id, options = {}) {
  return recipeToControls(presetRecipe(id, options));
}

// ----------------------------------------------------- controles <-> receita

// Estado do formulário: tudo texto/número/bool, serializável, sem objetos da
// receita (exceto a forma, que o diálogo guarda só pelo id).
export function defaultControls({ profile = null, start = 'C', quality = 'major' } = {}) {
  return presetControls('arpejo-quartas', { profile, start, quality });
}

const SHAPE_LIST = recipe => (Array.isArray(recipe.shapes) ? recipe.shapes : recipe.shape ? [recipe.shape] : []);

// A receita pode vir do documento do CURSO (etapa 5): lá a lista de acordes é
// TEXTO (as cifras, que o motor aceita normalmente) e existe `shapeLabel` — o
// rótulo da forma do catálogo, que a página da aula usa para pedir/escolher a
// forma. O motor NÃO conhece `shapeLabel` ("Campo desconhecido na receita"), e
// a tela não precisa dele para nada: ele sai antes de falar com o motor. Sem
// isto, "Ajustar no Estúdio de estudo" numa sugestão de aula lançaria na cara
// do usuário.
function withoutCourseKeys(recipe) {
  if (!recipe || typeof recipe !== 'object') return recipe;
  const { shapeLabel, ...rest } = recipe;
  return rest;
}

export function recipeToControls(recipe) {
  const normalized = normalizeRecipe(withoutCourseKeys(recipe));
  const strings = normalized.region.strings;
  const shapes = SHAPE_LIST(normalized);
  return Object.freeze({
    preset: 'personalizado',
    strings: normalized.profile.strings,
    start: normalized.progression.start,
    family: normalized.family,
    progression: normalized.progression.kind,
    direction: normalized.progression.direction,
    quality: normalized.progression.quality,
    chords: normalized.progression.chords.map(chordName).join(', '),
    cycleLength: normalized.progression.length,
    bars: normalized.bars,
    regionFrom: normalized.region.from,
    regionTo: normalized.region.to,
    regionOpen: normalized.region.open,
    regionStrings: strings ? strings.join(',') : 'todas',
    // Ids das formas escolhidas (ordem = ordem da figura) e os registros
    // completos: uma forma SEM id (material do catálogo) continua sendo a mesma
    // forma na variação — nada é esquecido.
    shapeIds: Object.freeze(shapes.map(record => record.id).filter(id => typeof id === 'string' && id)),
    shapeRecords: Object.freeze(shapes),
    rhythm: normalized.rhythm,
    figureBars: normalized.figure.bars,
    // Graus podem vir nulos no movimento contínuo (o motor resolve pelos tons
    // do acorde): a tela mostra vazio em vez de inventar graus.
    degrees: Array.isArray(normalized.figure.degrees) ? normalized.figure.degrees.join(',') : '',
    inversions: normalized.figure.inversions,
    notes: normalized.figure.notes,
    order: normalized.figure.order,
    voltas: normalized.voltas,
    final: normalized.final,
  });
}

const CHORD_ROOT_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);

function chordName(chord) {
  return `${CHORD_ROOT_NAMES[((chord.root % 12) + 12) % 12] ?? 'C'}${STUDY_QUALITY_IDS[chord.quality] ?? ''}`;
}

function parseIntIn(value, { min, max, field, allowEmpty = false }) {
  const text = String(value ?? '').trim();
  if (text === '') {
    if (allowEmpty) return null;
    throw new TypeError(`Informe ${field.charAt(0).toLowerCase()}${field.slice(1)}.`);
  }
  const number = Number(text);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new TypeError(`${field} deve ser um inteiro de ${min} a ${max}.`);
  }
  return number;
}

function parseDegrees(value) {
  const text = String(value ?? '').trim();
  if (text === '') return undefined;
  const parts = text.split(/[,;\s]+/).filter(Boolean).map(part => Number(part));
  if (parts.some(part => !Number.isInteger(part))) throw new TypeError('Os graus devem ser números separados por vírgula (ex.: 1,3,5).');
  return parts;
}

function parseStrings(value, strings) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === '' || text === 'todas' || text === 'all') return null;
  const parts = text.split(/[,;\s]+/).filter(Boolean).map(part => Number(part));
  if (parts.some(part => !Number.isInteger(part) || part < 1 || part > 8)) throw new TypeError('As cordas devem ser números de 1 (mais aguda) a 8.');
  if (new Set(parts).size !== parts.length) throw new TypeError('As cordas devem ser distintas.');
  if (parts.some(part => part > strings)) throw new TypeError(`Este instrumento tem ${strings} corda(s).`);
  return parts.length ? parts : null;
}

function parseChords(value) {
  const text = String(value ?? '').trim();
  if (text === '') return [];
  return text.split(/[,;]+/).map(part => part.trim()).filter(Boolean).map(symbol => {
    // Cifra livre -> {fundamental, qualidade}: a lista do estudo aceita
    // QUALIDADE POR ACORDE (o esquema `{root, quality}` do gerador). Cifras com
    // qualidade fora do vocabulário do estudo (6, 9, sus...) são recusadas com
    // o nome do acorde em vez de virarem outro acorde.
    const parsed = parseChordSymbol(symbol);
    const quality = QUALITY_NAME_FROM_ID[parsed.quality];
    if (!quality) throw new TypeError(`Qualidade não suportada no estudo: ${symbol}. Use maior, menor, aug, dim, maj7, m7, 7, m7b5 ou dim7.`);
    return { root: parsed.root, quality };
  });
}

// Voltas: inteiro 1..64 ou o modo `PERIOD` ('periodo'), que repete até o
// estado de período voltar ao da primeira volta, capado em 128 compassos.
function parseVoltas(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === '') throw new TypeError(`Informe as voltas (1 a 64) ou "${PERIOD}".`);
  if (text === PERIOD || text === 'período' || text === 'period') return PERIOD;
  return parseIntIn(text, { min: 1, max: 64, field: 'As voltas' });
}

// Formas de dedilhado escolhidas (ids), na ordem. Uma forma sem id (material do
// catálogo) só sobrevive como registro — nunca é inventada.
function shapesFor(controls, family, shapeLookup) {
  if (!isShapeFamily(family)) return [];
  const ids = Array.isArray(controls.shapeIds) ? controls.shapeIds.filter(id => typeof id === 'string' && id) : [];
  if (ids.length === 0) {
    const records = Array.isArray(controls.shapeRecords) ? controls.shapeRecords.filter(record => record && !record.id) : [];
    return records;
  }
  const picked = ids.map(id => shapeLookup(id));
  if (picked.some(record => !record)) throw new TypeError('A forma de dedilhado escolhida não está mais disponível.');
  return picked;
}

// `shapeLookup(id)` devolve a forma no schema do gerador (`shapeForRecipe`) ou
// null quando não há forma escolhida.
export function controlsToRecipe(controls, { shapeLookup = () => null } = {}) {
  if (!controls || typeof controls !== 'object') throw new TypeError('Controles de estudo ausentes.');
  const strings = controls.strings === 5 ? 5 : 4;
  const family = controls.family;
  if (!STUDY_FAMILIES.includes(family)) throw new TypeError(`Família desconhecida: ${family}.`);
  if (!STUDY_QUALITIES.includes(controls.quality)) throw new TypeError(`Qualidade desconhecida: ${controls.quality}.`);
  const progression = controls.progression;
  if (!STUDY_PROGRESSIONS.includes(progression)) throw new TypeError(`Progressão desconhecida: ${progression}.`);
  const rhythm = controls.rhythm;
  if (!STUDY_RHYTHMS.includes(rhythm)) throw new TypeError(`Ritmo desconhecido: ${rhythm}.`);
  const shapes = shapesFor(controls, family, shapeLookup);
  const shaped = shapes.length > 0;
  const progressao = {
    kind: progression,
    start: controls.start,
    direction: controls.direction === 'descendente' ? 'descendente' : 'ascendente',
    quality: shaped ? shapes[0].quality : controls.quality,
    // Só a progressão "lista" tem lista própria: nas outras, o texto guardado
    // no campo (escondido) NÃO entra na receita — o motor lê o ciclo dele
    // (quartas/quintas/cromático) ou a progressão da sessão.
    chords: progression === 'lista' ? parseChords(controls.chords) : [],
    length: controls.cycleLength === null || controls.cycleLength === '' || controls.cycleLength === undefined
      ? null
      : parseIntIn(controls.cycleLength, { min: 1, max: 64, field: 'O tamanho do ciclo' }),
  };
  return normalizeRecipe({
    version: 1,
    family,
    profile: { type: 'bass', strings },
    progression: progressao,
    bars: controls.bars === null || controls.bars === '' || controls.bars === undefined
      ? null
      : parseIntIn(controls.bars, { min: 1, max: STUDY_MAX_BARS, field: 'Os compassos', allowEmpty: true }),
    region: {
      from: parseIntIn(controls.regionFrom, { min: 0, max: 24, field: 'A casa inicial' }),
      to: parseIntIn(controls.regionTo, { min: 0, max: 24, field: 'A casa final' }),
      open: controls.regionOpen === true,
      strings: parseStrings(controls.regionStrings, strings),
    },
    ...(shaped ? { shapes } : {}),
    figure: {
      // Com forma, os graus vêm DA FORMA (um grau digitado em desacordo com a
      // forma é recusado pelo gerador). No movimento contínuo, graus explícitos
      // são recusados: a figura é o movimento pela escada do acorde.
      degrees: shaped || !isShapeFamily(family) ? undefined : parseDegrees(controls.degrees),
      // As inversões são a ÚNICA contagem da figura (o motor usa
      // `figure.inversions` para girar os graus-base). Mais de uma forma
      // escolhida define a contagem — uma forma por inversão; com UMA forma, a
      // contagem digitada continua valendo e o motor gira a mesma forma. As
      // formas combinadas não têm contagem: elas tocam as formas escolhidas.
      inversions: shaped && family === 'arpejo_tres_inversoes_por_acorde' && shapes.length > 1
        ? shapes.length
        : parseIntIn(controls.inversions, { min: 1, max: 4, field: 'As inversões' }),
      notes: parseIntIn(controls.notes, { min: 1, max: 32, field: 'As notas por acorde' }),
      order: isPercursoFamily(family) ? undefined : controls.order,
      // Vazio = automático (o mínimo da família, sem truncar nada); o teto é o
      // da família (percurso até 128) — nunca um corte arbitrário em 4.
      bars: parseIntIn(controls.figureBars, { min: 1, max: figureBarsLimit({ family }), field: 'Os compassos da figura', allowEmpty: true }),
    },
    rhythm,
    voltas: parseVoltas(controls.voltas),
    // Padrão do pedido: "repetir o primeiro acorde no fim" = sim. Um valor
    // ausente/desconhecido cai na tônica do PRIMEIRO acorde, nunca na nota do
    // último (que é uma escolha explícita do usuário).
    final: STUDY_FINALS.includes(controls.final) ? controls.final : 'tonica',
  });
}

// ------------------------------------------------------------- correções

// Aplica a ação corretiva de um aviso e devolve `{recipe, label}` — ou null
// quando não existe correção automática (o aviso continua honesto na tela).
// Nunca aplica mais de uma coisa por vez: a prévia mostra o efeito.
export function applyWarningAction(recipe, action) {
  if (!recipe || !action || typeof action.kind !== 'string') return null;
  const original = recipe;
  if (action.kind === 'aumentar-compassos') {
    // `figureBars` (escopo figura) e `bars` (escopo total) podem vir juntos: a
    // correção aplica o que o gerador mandou, sem inventar o outro.
    const next = { ...recipe };
    if (Number.isInteger(action.figureBars)) next.figure = { ...recipe.figure, bars: action.figureBars };
    if (Number.isInteger(action.bars)) next.bars = action.bars;
    if (!Number.isInteger(action.figureBars) && !Number.isInteger(action.bars)) return null;
    return decide(original, next, action.kind);
  }
  if (action.kind === 'expandir-regiao' && action.region) {
    const region = {
      from: action.region.from,
      to: action.region.to,
      open: action.region.open === true || action.region.from <= 0 ? true : recipe.region.open,
      strings: action.region.strings ?? recipe.region.strings,
    };
    return decide(original, { ...recipe, region }, action.kind);
  }
  if (action.kind === 'usar-graus-da-forma') {
    if (!Array.isArray(action.degrees) || action.degrees.length === 0) return null;
    return decide(original, { ...recipe, figure: { ...recipe.figure, degrees: action.degrees } }, action.kind);
  }
  if (action.kind === 'reduzir-voltas') {
    // O gerador já calcula o maior número de voltas inteiras que cabem — e,
    // quando nem UMA volta cabe, quantos acordes do ciclo cabem (`length`).
    const next = { ...recipe };
    const cycleLength = recipe.progression.length ?? recipe.progression.chords.length;
    let shortened = false;
    if (Number.isInteger(action.length) && Number.isInteger(cycleLength) && action.length < cycleLength) {
      next.progression = { ...recipe.progression, length: action.length };
      shortened = true;
    }
    const target = Number.isInteger(action.voltas) && action.voltas >= 1
      ? action.voltas
      : recipe.voltas === PERIOD ? 1 : Math.max(1, recipe.voltas - 1);
    next.voltas = target;
    const fixed = decide(original, next, shortened ? 'reduzir-ciclo' : action.kind);
    return fixed;
  }
  if (action.kind === 'aumentar-limite') {
    // O teto de 512 notas é da sessão: a correção honesta é reduzir o material
    // (voltas, inversões ou notas por acorde), nunca descartar notas.
    if (recipe.voltas === PERIOD) return decide(original, { ...recipe, voltas: 1 }, action.kind);
    if (recipe.voltas > 1) return decide(original, { ...recipe, voltas: recipe.voltas - 1 }, action.kind);
    if (recipe.figure.inversions > 1 && recipe.family === 'arpejo_tres_inversoes_por_acorde') {
      return decide(original, { ...recipe, figure: { ...recipe.figure, inversions: recipe.figure.inversions - 1 } }, action.kind);
    }
    if (recipe.figure.notes > 1) return decide(original, { ...recipe, figure: { ...recipe.figure, notes: recipe.figure.notes - 1 } }, action.kind);
    return null;
  }
  // 'trocar-forma' não tem correção automática: o usuário escolhe outra forma
  // (a tela mostra o motivo). Nada de trocar a forma por conta própria.
  return null;
}

// Só existe correção quando ela MUDA a receita: um botão que não muda nada é
// um botão morto (e o gerador pode mandar uma ação que já está satisfeita).
function decide(original, candidate, kind) {
  let normalized;
  try { normalized = normalizeRecipe(candidate); }
  catch { return null; }
  let previous = null;
  try { previous = normalizeRecipe(original); } catch { previous = null; }
  if (previous !== null && JSON.stringify(previous) === JSON.stringify(normalized)) return null;
  const label = WARNING_LABELS[kind]?.(normalized, previous) ?? null;
  if (!label) return null;
  return { recipe: normalized, label };
}

// -------------------------------------------------- nas 12 tonalidades

// As outras 11 tonalidades da MESMA lista de acordes: transposição de todos os
// acordes (+1..+11 semitons), na ordem cromática. É o que faz um I–vi–ii–V em C
// virar o mesmo exercício em Db, D, ... — mesmos graus, outra tonalidade. Um
// ciclo não precisa disso (já percorre as 12 fundamentais) e a progressão "da
// sessão" não tem lista própria: os dois devolvem lista vazia.
export function otherKeyRecipes(recipe) {
  const normalized = normalizeRecipe(recipe);
  if (!canTransposeProgression(normalized)) return Object.freeze([]);
  const chords = normalized.progression.chords;
  const others = [];
  for (let shift = 1; shift <= 11; shift += 1) {
    const moved = chords.map(chord => ({ root: (((chord.root + shift) % 12) + 12) % 12, quality: chord.quality }));
    others.push(normalizeRecipe({
      ...normalized,
      progression: {
        ...normalized.progression,
        // A tonalidade da lista transposta é a do PRIMEIRO acorde deslocado: é o
        // que o nome do exercício e o campo "Tonalidade inicial" mostram (e o
        // que o motor usa para a grafia dos acordes). Sem isto as 11 irmãs
        // sairiam todas com o nome da tonalidade ORIGINAL.
        start: PLAIN_STARTS[moved[0].root],
        chords: moved,
      },
    }));
  }
  return Object.freeze(others);
}

// ---------------------------------------------------------------- rótulos

export function recipeTitle(recipe) {
  const normalized = normalizeRecipe(recipe);
  const quality = normalized.progression.quality === 'major' ? 'maior'
    : normalized.progression.quality === 'minor' ? 'menor'
      : STUDY_QUALITY_LABELS[normalized.progression.quality];
  return `${STUDY_FAMILY_LABELS[normalized.family] ?? normalized.family} · ${normalized.progression.start} ${quality} · ${STUDY_PROGRESSION_LABELS[normalized.progression.kind] ?? normalized.progression.kind}`;
}

export function recipeGroupLabel(recipe) {
  const normalized = normalizeRecipe(recipe);
  const first = normalized.progression.chords[0];
  return `Nas 12 tonalidades · ${first ? chordName(first) : 'sem acorde'}`;
}

// Resumo curto para a linha de estado da prévia.
export function recipeSummary(recipe, result) {
  const normalized = normalizeRecipe(recipe);
  const parts = [
    `${result.actualBars} compasso${result.actualBars === 1 ? '' : 's'}`,
    `${result.meta.chordCount} acorde${result.meta.chordCount === 1 ? '' : 's'}`,
    `${result.meta.slotCount} bloco${result.meta.slotCount === 1 ? '' : 's'}`,
    `${result.meta.noteCount} nota${result.meta.noteCount === 1 ? '' : 's'}`,
    result.meta.minFret === null ? 'sem casa usada' : `casas ${result.meta.minFret}–${result.meta.maxFret}`,
    `cordas ${result.meta.strings.join(',')}`,
  ];
  if (normalized.voltas === PERIOD || result.period?.mode === PERIOD) {
    const period = result.period ?? null;
    if (period) {
      parts.push(period.closed
        ? `período fechado em ${period.voltas} volta${period.voltas === 1 ? '' : 's'}`
        : `período não fechou em ${period.voltas} volta${period.voltas === 1 ? '' : 's'}`);
      if (period.capped) parts.push('capado em 128 compassos');
    } else if (Number.isFinite(result.meta.voltas)) {
      parts.push(`${result.meta.voltas} volta${result.meta.voltas === 1 ? '' : 's'}`);
    }
  } else if (Number.isFinite(result.meta.voltas) && result.meta.voltas > 1) {
    parts.push(`${result.meta.voltas} voltas`);
  }
  if (result.meta.noteCount > STUDY_MAX_NOTES) parts.push(`acima do teto de ${STUDY_MAX_NOTES} notas`);
  return parts.join(' · ');
}

// Mensagem de erro do commit: o que impede o exercício de virar sessão, em
// português, com a ação que resolve.
export function commitBlockReason(error) {
  return error instanceof Error ? error.message : String(error ?? '');
}
