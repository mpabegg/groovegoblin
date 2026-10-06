// Catálogo de exercícios do curso (rodada 6, etapa 5 — A5).
//
// O catálogo é o levantamento dos exercícios do curso: uma lista de objetos em
// que TODO campo é opcional (apêndice do pedido). Este módulo é PURO e faz
// três coisas, sem DOM, sem rede e sem sessão:
//
//  1. lê uma entrada do catálogo com tolerância (campo ausente não derruba
//     nada) e monta a SUGESTÃO de exercício + a RECEITA de estudo da família
//     gerável correspondente;
//  2. liga as sugestões às aulas do curso por `aula_id` (o id NUMÉRICO do
//     mapa, já estável como texto desde a etapa 1) e substitui os exercícios
//     sugeridos dessas aulas, ligando as faixas indicadas aos materiais;
//  3. valida a receita contra um schema estrito (usado pelo formato do curso,
//     que é a porta de entrada) e a converte na receita do gerador A2 —
//     resolvendo a FORMA de dedilhado pelo rótulo, nunca inventando digitação.
//
// Avisos citam só o caminho do campo (`catalogo[].familia`), nunca títulos,
// nomes de arquivo ou cifras: o relatório do conversor pode ser mostrado.
//
// Sobre "forma única": o catálogo traz o rótulo ("Shape 1", da qualidade e da
// inversão) e NUNCA a digitação. A receita guarda esse rótulo em `shapeLabel`;
// `generatorRecipe(recipe, { shape })` só fecha a receita quando uma forma de
// verdade é escolhida (a escolha fica na loja de vínculos, `course-shape-
// binding.js`, e é lembrada para as próximas aulas com o mesmo rótulo).
//
// O mapeamento catálogo -> receita NÃO é reimplementado aqui: `catalogRecipe-
// FromEntry` delega para `recipeFromCatalog` do motor (`study-generator.js`),
// que já lê as seis famílias, o ciclo de cifras, o compasso final, o contorno
// de graus, o teto dinâmico de `figure.bars` e a região declarada. Este módulo
// acrescenta o que é do CURSO: o rótulo da forma, os motivos dos avisos e a
// ligação com a aula. Uma segunda tradução do mesmo formato seria uma API
// incompatível esperando para divergir.

import {
  STUDY_CONTINUOUS_FAMILIES, STUDY_FAMILIES, STUDY_FINALS, STUDY_MAX_FIGURE_BARS,
  STUDY_MAX_FRET, STUDY_MAX_PERCURSO_FIGURE_BARS, STUDY_MAX_VOLTAS, STUDY_MIN_FRET,
  STUDY_ORDERS, STUDY_PERIOD, STUDY_PROGRESSIONS, STUDY_QUALITY_IDS, STUDY_RHYTHMS,
  STUDY_SHAPE_FAMILIES, STUDY_VERSION, maxFigureBars, recipeFromCatalog,
} from './study-generator.js';

// As seis famílias do levantamento: a lista é a do MOTOR (mesmos ids).
export const CATALOG_FAMILIES = STUDY_FAMILIES;

// Famílias em que o catálogo referencia UMA forma de digitação pelo RÓTULO
// ("Shape 1" da qualidade e da inversão): só a forma única. É a única em que o
// autor desenha uma forma fixa; nas outras o catálogo diz "sem forma fixa" ou
// "combinação de formas" (descrição, não uma forma escolhível) e quem posiciona
// é a REGIÃO — pedir uma forma física ali imporia a essas famílias de região a
// qualidade única que só a forma física exige.
export const CATALOG_LABEL_SHAPE_FAMILIES = Object.freeze(['arpejo_triade_forma_unica']);

// Famílias HARMÔNICAS do motor (arpejo; aceitam `shapes[]`). NÃO significa que
// o catálogo traga uma forma: ver CATALOG_LABEL_SHAPE_FAMILIES.
export const CATALOG_SHAPE_FAMILIES = STUDY_SHAPE_FAMILIES;

export const CATALOG_CONTINUOUS_FAMILIES = STUDY_CONTINUOUS_FAMILIES;

export const CATALOG_ORIGINS = Object.freeze(['workbook', '5cordas', 'extra']);

// Campos do apêndice do pedido. Tudo opcional; campo reconhecido e sem destino
// no formato v2 é ignorado SEM aviso (está documentado aqui).
export const CATALOG_ENTRY_FIELDS = Object.freeze([
  'id', 'origem_tipo', 'familia', 'modulo', 'video_numero', 'aula_id', 'nome_do_exercicio',
  'pagina_do_pdf', 'qualidade', 'inversao', 'forma', 'regiao_do_braco', 'sequencia_de_acordes',
  'compassos_por_acorde', 'total_de_compassos', 'formula_de_compasso', 'andamento_escrito',
  'modo_de_pratica', 'faixas_indicadas', 'figura_ritmica', 'contorno', 'cordas_usadas',
  'extensao_em_casas', 'igual_a', 'semelhante_a', 'comparacao_4_cordas',
]);

// Campos conhecidos e deliberadamente ignorados (sem aviso): são DESCRIÇÕES da
// partitura (o texto do dedilhado, a fórmula de compasso, as variantes do
// autor, as medidas derivadas) — o formato guarda a regra, não a transcrição.
export const CATALOG_IGNORED_FIELDS = Object.freeze([
  'modulo', 'video_numero', 'formula_de_compasso', 'cordas_usadas', 'extensao_em_casas',
  'comparacao_4_cordas',
]);

// Campos internos de `forma`, `figura_ritmica`, `contorno` e `sequencia_de_acordes`.
const FORMA_FIELDS = Object.freeze(['forma', 'dedilhado_no_texto']);
const SEQUENCE_FIELDS = Object.freeze(['regra', 'cifras']);
const RHYTHM_FIELDS = Object.freeze(['padrao_codigo', 'muda', 'variantes', 'compasso_final']);
const CONTOUR_FIELDS = Object.freeze(['padrao', 'varia', 'variantes']);
const REGION_FIELDS = Object.freeze(['declarada', 'observada_na_tab']);
const REGION_EDGE_FIELDS = Object.freeze(['de', 'ate']);

export const CATALOG_PERIOD = STUDY_PERIOD;
// Mesma versão do motor: a receita guardada no curso é a receita do A2.
export const RECIPE_VERSION = STUDY_VERSION;

// Teto de `figure.bars` por família: o MESMO do motor. É dinâmico — os dois
// percursos aceitam até 128 (a escada inteira tem de caber; nada é truncado) e
// as demais famílias até 4. `catalogMaxFigureBars` expõe a regra para o resto
// da etapa 5 não repetir o número.
export const CATALOG_MAX_FIGURE_BARS = STUDY_MAX_FIGURE_BARS;
export const CATALOG_MAX_PERCURSO_FIGURE_BARS = STUDY_MAX_PERCURSO_FIGURE_BARS;

export function catalogMaxFigureBars(family) {
  return maxFigureBars(family);
}

export const CATALOG_LIMITS = Object.freeze({
  id: 128,
  title: 300,
  text: 240,
  shortText: 80,
  label: 80,
  chords: 64,
  degrees: 8,
  // `notes` e `inversions` são os limites do `normalizeRecipe` do motor: uma
  // receita que ele recusaria não pode entrar no documento do curso.
  notes: 32,
  inversions: 4,
  bars: STUDY_MAX_FIGURE_BARS,
  barsPercurso: STUDY_MAX_PERCURSO_FIGURE_BARS,
  voltas: STUDY_MAX_VOLTAS,
  regionMin: STUDY_MIN_FRET,
  regionMax: STUDY_MAX_FRET,
  bpmMin: 30,
  bpmMax: 300,
  pdfPage: 9999,
  trackNames: 32,
  entries: 4000,
});

// Schema da receita do catálogo, como o formato do curso a guarda.
export const RECIPE_KEYS = Object.freeze([
  'version', 'family', 'profile', 'progression', 'region', 'bars', 'figure', 'rhythm', 'voltas', 'final', 'shapeLabel',
]);
const PROGRESSION_KEYS = Object.freeze(['kind', 'start', 'direction', 'quality', 'chords', 'length', 'spelling']);
const FIGURE_KEYS = Object.freeze(['bars', 'degrees', 'order', 'notes', 'inversions']);
const SHAPE_LABEL_KEYS = Object.freeze(['label', 'quality', 'inversion']);

const PROGRESSION_KINDS = STUDY_PROGRESSIONS;
const STUDY_QUALITIES = Object.freeze(Object.keys(STUDY_QUALITY_IDS));
const RHYTHMS = STUDY_RHYTHMS;
const ORDERS = STUDY_ORDERS;
const FINALS = STUDY_FINALS;
const DEGREES = Object.freeze([1, 3, 5, 7, 8, 10, 12, 14]);
const STRING_COUNTS = Object.freeze([4, 5]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max && !CONTROL_CHARS.test(value);
}

function collapse(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

function fold(value) {
  return collapse(value)?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') ?? null;
}

// Campos embrulhados em { valor, inferido }: o valor vale; a marcação é
// informativa. Mesma tolerância do conversor do mapa.
function unwrap(value) {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isObject(current) || !Object.hasOwn(current, 'valor')) return current;
    current = current.valor;
  }
  return current;
}

function readText(value, max = CATALOG_LIMITS.text) {
  const raw = unwrap(value);
  if (typeof raw !== 'string') return null;
  const text = collapse(raw);
  if (text === null || text.length > max) return null;
  return text;
}

function readInteger(value, { min, max } = {}) {
  const raw = unwrap(value);
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) return null;
    if (min !== undefined && raw < min) return null;
    if (max !== undefined && raw > max) return null;
    return raw;
  }
  if (typeof raw !== 'string') return null;
  const text = collapse(raw);
  if (text === null || !/^-?\d+$/.test(text)) return null;
  const number = Number(text);
  if (min !== undefined && number < min) return null;
  if (max !== undefined && number > max) return null;
  return number;
}

function readTextList(value, { limit, max }) {
  const raw = unwrap(value);
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const texts = [];
  for (const item of list) {
    if (texts.length >= limit) break;
    const text = readText(item, max);
    if (text !== null && !texts.includes(text)) texts.push(text);
  }
  return texts;
}

// ------------------------------------------------------------ receita: schema

function noteIssue(errors, path, code, message) {
  if (errors.length >= 100) return;
  errors.push({ path, code, message });
}

function checkKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    noteIssue(errors, path === '' ? key : `${path}.${key}`, 'campo-desconhecido', 'Campo não previsto na receita.');
  }
}

function readEnumField(value, path, allowed, errors) {
  if (!allowed.includes(value)) {
    noteIssue(errors, path, 'valor', `Esperado um destes valores: ${allowed.join(', ')}.`);
    return null;
  }
  return value;
}

function readIntField(value, path, { min, max }, errors) {
  if (!Number.isInteger(value) || value < min || value > max) {
    noteIssue(errors, path, 'numero', `Esperado número inteiro entre ${min} e ${max}.`);
    return null;
  }
  return value;
}

function normalizeRecipeProgression(value, path, errors) {
  if (!isObject(value)) {
    noteIssue(errors, path, 'objeto', 'A progressão da receita deve ser um objeto.');
    return null;
  }
  checkKeys(value, PROGRESSION_KEYS, path, errors);
  const kind = readEnumField(value.kind, `${path}.kind`, PROGRESSION_KINDS, errors) ?? 'quartas';
  const quality = STUDY_QUALITIES.includes(value.quality) ? value.quality : 'major';
  if (!STUDY_QUALITIES.includes(value.quality)) {
    noteIssue(errors, `${path}.quality`, 'valor', 'Qualidade de acorde não reconhecida na receita.');
  }
  const start = isText(value.start, CATALOG_LIMITS.shortText) ? value.start.trim() : 'C';
  const direction = value.direction === 'descendente' ? 'descendente' : 'ascendente';
  const spelling = ['auto', 'sustenidos', 'bemois'].includes(value.spelling) ? value.spelling : 'auto';
  const chords = [];
  const raw = value.chords === undefined || value.chords === null ? [] : value.chords;
  if (!Array.isArray(raw)) {
    noteIssue(errors, `${path}.chords`, 'lista', 'A lista de acordes da receita deve ser um vetor.');
  } else if (raw.length > CATALOG_LIMITS.chords) {
    noteIssue(errors, `${path}.chords`, 'limite', `A lista de acordes aceita no máximo ${CATALOG_LIMITS.chords} itens.`);
  } else {
    for (const [index, chord] of raw.entries()) {
      const text = readText(chord, 16);
      if (text === null) {
        noteIssue(errors, `${path}.chords[${index}]`, 'texto', 'Cada acorde da receita deve ser uma cifra curta.');
        continue;
      }
      chords.push(text);
    }
  }
  const length = value.length === undefined || value.length === null ? null : readIntField(value.length, `${path}.length`, { min: 1, max: 64 }, errors);
  if (kind === 'lista' && chords.length === 0) {
    noteIssue(errors, `${path}.chords`, 'lista', 'A progressão em lista precisa de ao menos um acorde.');
  }
  return { kind, start, direction, quality, chords, length, spelling };
}

function normalizeRecipeRegion(value, path, errors) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) {
    noteIssue(errors, path, 'objeto', 'A região da receita deve ser um objeto {from,to}.');
    return null;
  }
  const allowed = ['from', 'to', 'open', 'strings'];
  checkKeys(value, allowed, path, errors);
  const from = readIntField(value.from, `${path}.from`, { min: CATALOG_LIMITS.regionMin, max: CATALOG_LIMITS.regionMax }, errors);
  const to = readIntField(value.to, `${path}.to`, { min: CATALOG_LIMITS.regionMin, max: CATALOG_LIMITS.regionMax }, errors);
  if (from === null || to === null) return null;
  if (from > to) {
    noteIssue(errors, `${path}.from`, 'regiao', 'A casa inicial da região precisa ser menor ou igual à final.');
    return null;
  }
  const open = value.open === true;
  if (!open && from < 1) {
    noteIssue(errors, `${path}.from`, 'regiao', 'A região sem cordas soltas começa na casa 1.');
    return null;
  }
  const strings = value.strings === undefined || value.strings === null ? null : value.strings;
  const normalizedStrings = [];
  if (strings !== null) {
    if (!Array.isArray(strings) || strings.length === 0) {
      noteIssue(errors, `${path}.strings`, 'lista', 'As cordas da região devem ser uma lista de números.');
    } else {
      for (const [index, item] of strings.entries()) {
        if (!Number.isInteger(item) || item < 1 || item > 8) {
          noteIssue(errors, `${path}.strings[${index}]`, 'numero', 'A corda da região deve ser um número de 1 a 8.');
          continue;
        }
        if (!normalizedStrings.includes(item)) normalizedStrings.push(item);
      }
    }
  }
  return { from, to, open, strings: normalizedStrings.length > 0 ? normalizedStrings.sort((a, b) => a - b) : null };
}

function normalizeRecipeFigure(value, path, errors, maxBars) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) {
    noteIssue(errors, path, 'objeto', 'A figura da receita deve ser um objeto.');
    return null;
  }
  checkKeys(value, FIGURE_KEYS, path, errors);
  // `shapes` NÃO existe: o motor rejeita o campo ("Campo desconhecido na
  // figura: shapes") e a forma física é o `shape` de `generatorRecipe`, nunca
  // uma contagem na figura.
  const figure = { bars: null, degrees: null, order: null, notes: null, inversions: null };
  const limits = { bars: maxBars, notes: CATALOG_LIMITS.notes, inversions: CATALOG_LIMITS.inversions };
  for (const key of ['bars', 'notes', 'inversions']) {
    if (value[key] === undefined || value[key] === null) continue;
    figure[key] = readIntField(value[key], `${path}.${key}`, { min: 1, max: limits[key] }, errors);
  }
  if (value.order !== undefined && value.order !== null) {
    figure.order = readEnumField(value.order, `${path}.order`, ORDERS, errors);
  }
  if (value.degrees !== undefined && value.degrees !== null) {
    const raw = value.degrees;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > CATALOG_LIMITS.degrees) {
      noteIssue(errors, `${path}.degrees`, 'lista', `A figura aceita de 1 a ${CATALOG_LIMITS.degrees} graus.`);
    } else {
      const degrees = [];
      for (const [index, degree] of raw.entries()) {
        if (!DEGREES.includes(degree)) {
          noteIssue(errors, `${path}.degrees[${index}]`, 'valor', `Grau não suportado: use ${DEGREES.join(', ')}.`);
          continue;
        }
        degrees.push(degree);
      }
      if (new Set(degrees).size !== degrees.length) noteIssue(errors, `${path}.degrees`, 'grau', 'Os graus da figura não podem se repetir.');
      figure.degrees = degrees.length > 0 ? degrees : null;
    }
  }
  return figure;
}

function normalizeShapeLabel(value, path, errors) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) {
    noteIssue(errors, path, 'objeto', 'O rótulo da forma deve ser um objeto.');
    return null;
  }
  checkKeys(value, SHAPE_LABEL_KEYS, path, errors);
  const label = isText(value.label, CATALOG_LIMITS.label) ? value.label.trim() : null;
  if (label === null) noteIssue(errors, `${path}.label`, 'texto', 'O rótulo da forma precisa de texto.');
  const quality = STUDY_QUALITIES.includes(value.quality) ? value.quality : null;
  if (quality === null) noteIssue(errors, `${path}.quality`, 'valor', 'A qualidade do rótulo da forma não foi reconhecida.');
  const inversion = value.inversion === undefined || value.inversion === null ? null
    : isText(value.inversion, CATALOG_LIMITS.label) ? value.inversion.trim() : null;
  if (value.inversion !== undefined && value.inversion !== null && inversion === null) {
    noteIssue(errors, `${path}.inversion`, 'texto', 'A inversão do rótulo da forma precisa de texto curto.');
  }
  return label === null || quality === null ? null : { label, quality, inversion };
}

// Valida e canoniza a receita guardada no documento do curso. Tolerante ao que
// é OPCIONAL (todos os campos da receita têm padrão), estrito no que o gerador
// recusaria: nunca é melhor guardar uma receita que não vira material sem
// ninguém saber. Devolve `{ ok, recipe }` ou `{ ok: false, errors }` com o
// caminho de cada campo.
export function normalizeCatalogRecipe(value) {
  const errors = [];
  if (!isObject(value)) {
    noteIssue(errors, '', 'objeto', 'A receita de estudo deve ser um objeto.');
    return { ok: false, errors };
  }
  checkKeys(value, RECIPE_KEYS, '', errors);
  if ((value.version ?? RECIPE_VERSION) !== RECIPE_VERSION) {
    noteIssue(errors, 'version', 'versao', `A versão da receita de estudo deve ser ${RECIPE_VERSION}.`);
  }
  const family = readEnumField(value.family, 'family', CATALOG_FAMILIES, errors);
  const profileRaw = isObject(value.profile) ? value.profile : { type: 'bass', strings: 4 };
  checkKeys(profileRaw, ['type', 'strings'], 'profile', errors);
  const strings = STRING_COUNTS.includes(profileRaw.strings) ? profileRaw.strings : 4;
  if (profileRaw.type !== undefined && profileRaw.type !== 'bass') {
    noteIssue(errors, 'profile.type', 'instrumento', 'A receita de estudo aceita somente baixo ("bass").');
  }
  const progression = normalizeRecipeProgression(value.progression, 'progression', errors);
  const region = normalizeRecipeRegion(value.region, 'region', errors);
  // O teto de `figure.bars` é DINÂMICO (percursos até 128): o valor derivado
  // pelo motor para um percurso que não cabe em 4 compassos tem de voltar pelo
  // documento sem ser recusado — e nada é truncado para caber em 4.
  const figure = normalizeRecipeFigure(value.figure, 'figure', errors, family === null ? CATALOG_LIMITS.bars : catalogMaxFigureBars(family));
  const shapeLabel = normalizeShapeLabel(value.shapeLabel, 'shapeLabel', errors);
  const bars = value.bars === undefined || value.bars === null ? null : readIntField(value.bars, 'bars', { min: 1, max: 128 }, errors);
  const rhythm = value.rhythm === undefined || value.rhythm === null ? (CATALOG_SHAPE_FAMILIES.includes(family) ? 'arpejo' : 'quarters') : readEnumField(value.rhythm, 'rhythm', RHYTHMS, errors);
  const final = value.final === undefined || value.final === null ? 'acorde' : readEnumField(value.final, 'final', FINALS, errors);
  let voltas = value.voltas === undefined || value.voltas === null ? 1 : value.voltas;
  if (voltas !== CATALOG_PERIOD) voltas = readIntField(voltas, 'voltas', { min: 1, max: CATALOG_LIMITS.voltas }, errors);
  if (family === null) return { ok: false, errors };
  if (shapeLabel !== null && !CATALOG_LABEL_SHAPE_FAMILIES.includes(family)) {
    // Uma forma física só existe onde o curso desenha UMA forma (forma única).
    // Nas famílias de região o catálogo diz "sem forma fixa"/"combinação de
    // formas" e quem posiciona é a região — um rótulo ali obrigaria a uma
    // qualidade única que só a forma física exige.
    noteIssue(errors, 'shapeLabel', 'forma', 'A receita só referencia uma forma pelo rótulo na família de forma única; as demais posicionam pela região.');
  }
  if (rhythm === 'arpejo' && CATALOG_CONTINUOUS_FAMILIES.includes(family)) {
    noteIssue(errors, 'rhythm', 'ritmo', 'O movimento contínuo usa semínimas (quarters) ou colcheias (eighths).');
  }
  if (errors.length > 0) return { ok: false, errors };
  const recipe = {
    version: RECIPE_VERSION,
    family,
    profile: { type: 'bass', strings },
    progression,
    region,
    bars,
    rhythm,
    figure,
    voltas,
    final,
    shapeLabel: CATALOG_SHAPE_FAMILIES.includes(family) ? shapeLabel : null,
  };
  return { ok: true, recipe };
}

// ------------------------------------------------------------------ entrada

// A progressão de ENTRADA da entrada: o motor usa as cifras quando existem e a
// regra do ciclo quando elas faltam. Aqui só se decide se a entrada descreve
// alguma coisa gerável, antes de chamar o motor (o motivo do aviso fica estável).
function classifyProgression(entry) {
  const sequence = isObject(unwrap(entry.sequencia_de_acordes)) ? unwrap(entry.sequencia_de_acordes) : {};
  const rule = fold(sequence.regra) ?? '';
  const chords = readTextList(sequence.cifras, { limit: CATALOG_LIMITS.chords, max: 16 });
  let kind = 'lista';
  if (/quarta/.test(rule)) kind = 'quartas';
  else if (/quinta/.test(rule)) kind = 'quintas';
  else if (/cromatic/.test(rule)) kind = 'cromatica';
  return { kind, chords, rule };
}

// Rótulo da forma do curso: SÓ a família de forma única referencia uma forma
// pelo rótulo ("Shape 1" da qualidade e da inversão). Nas demais o campo do
// catálogo é uma descrição ("sem forma fixa…", "combinação das N formas…") e a
// região decide as posições — nada de impor a elas a qualidade única que a
// forma física exige. `mista` nunca é uma forma: a lista de cifras manda.
function shapeLabelFromEntry(entry, family, recipe) {
  if (!CATALOG_LABEL_SHAPE_FAMILIES.includes(family)) return null;
  if (fold(entry?.qualidade) === 'mista') return null;
  const forma = isObject(unwrap(entry.forma)) ? unwrap(entry.forma) : {};
  const label = readText(forma.forma, CATALOG_LIMITS.label);
  if (label === null) return null;
  const inversion = readText(entry.inversao, CATALOG_LIMITS.label);
  return { label, quality: recipe.progression.quality, inversion };
}

// A receita do motor volta na forma de ENTRADA — a que o documento do curso e o
// diálogo do estudo guardam: perfil simples ({type, strings}) e cifras de TEXTO
// (o motor já expandiu o ciclo e o documento guarda a progressão que ele toca).
function catalogProgression(progression) {
  const chords = (Array.isArray(progression?.chords) ? progression.chords : []).map(chord => (typeof chord === 'string'
    ? chord
    : `${chord?.name ?? ''}${STUDY_QUALITY_IDS[chord?.quality] ?? ''}`));
  return { ...progression, chords };
}

// Família do catálogo -> receita. Devolve `recipe: null` quando a entrada não
// descreve uma família gerável ou quando a progressão não fecha (motivo em
// `reason`, um código estável, sem conteúdo do curso).
//
// O mapeamento é o do MOTOR (`recipeFromCatalog`): o ciclo de cifras vira lista
// com as voltas que o autor escreveu, o compasso final vira o final da receita,
// o contorno vira a ordem de graus (acima do anterior), o teto de
// `figure.bars` é o da família e a região de entrada é a DECLARADA (a observada
// na tablatura é conferência, nunca fonte). Este módulo só acrescenta o rótulo
// da forma e o motivo do aviso.
export function catalogRecipeFromEntry(entry, { strings = null } = {}) {
  const family = CATALOG_FAMILIES.includes(entry?.familia) ? entry.familia : null;
  if (family === null) return { recipe: null, reason: 'familia-desconhecida' };
  const progression = classifyProgression(entry);
  if (progression.kind === 'lista' && progression.chords.length === 0) {
    return { recipe: null, reason: 'progressao-ausente' };
  }
  const instrument = strings === null ? null : { type: 'bass', strings: strings === 5 ? 5 : 4 };
  // Todo campo do catálogo é OPCIONAL: sem `qualidade` legível a base é maior (o
  // motor exige uma qualidade e não a inventa). Só aí vale a segunda tentativa.
  const candidates = fold(entry?.qualidade) === null ? [entry, { ...entry, qualidade: 'maior' }] : [entry];
  let translated = null;
  let failure = null;
  for (const candidate of candidates) {
    try {
      translated = recipeFromCatalog(candidate, { instrument });
      failure = null;
      break;
    } catch (error) {
      failure = error;
    }
  }
  if (translated === null) {
    // Cifras com marcador sem cifra ("(sem cifra)") ou família/qualidade fora do
    // vocabulário do motor: a aula entra sem receita e mantém "Criar no Estúdio".
    return { recipe: null, reason: 'sem-receita', detail: failure?.message ?? null };
  }
  // O schema do CURSO não tem `shape`/`shapes` (a forma física entra depois, por
  // `generatorRecipe`): a receita guardada é só parâmetro musical + rótulo.
  const { shape, shapes, ...musical } = translated;
  void shape;
  void shapes;
  const recipe = {
    ...musical,
    profile: { type: 'bass', strings: musical.profile.strings },
    progression: catalogProgression(musical.progression),
    shapeLabel: shapeLabelFromEntry(entry, family, musical),
  };
  const normalized = normalizeCatalogRecipe(recipe);
  if (!normalized.ok) return { recipe: null, reason: 'receita-invalida', errors: normalized.errors };
  return { recipe: normalized.recipe, reason: null };
}

// Nome do exercício do catálogo -> id estável dentro da aula (o mesmo id em
// toda reimportação, para a aula lembrar o que já foi gerado).
function slug(value) {
  const text = collapse(value) ?? '';
  const slugged = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60);
  return slugged === '' ? null : slugged;
}

function uniqueId(used, base, index) {
  let candidate = base ?? `catalogo-${index + 1}`;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

// Andamento escrito ("♩ = 110") vira BPM inicial; sem número inequívoco, nulo.
function bpmFromWritten(value) {
  const text = collapse(value);
  if (text === null) return null;
  const numbers = text.match(/\d{1,4}/g) ?? [];
  if (numbers.length !== 1) return null;
  const number = Number(numbers[0]);
  return Number.isInteger(number) && number >= CATALOG_LIMITS.bpmMin && number <= CATALOG_LIMITS.bpmMax ? number : null;
}

// Sugestão de exercício + receita a partir de uma entrada do catálogo.
export function catalogSuggestion(entry, { id, index = 0 } = {}) {
  const origin = CATALOG_ORIGINS.includes(entry?.origem_tipo) ? entry.origem_tipo : 'workbook';
  const strings = origin === '5cordas' ? 5 : 4;
  const { recipe, reason } = catalogRecipeFromEntry(entry, { strings });
  const title = readText(entry?.nome_do_exercicio, CATALOG_LIMITS.title)
    ?? readText(entry?.id, CATALOG_LIMITS.title)
    ?? `Exercício ${index + 1}`;
  return {
    suggestion: {
      id,
      title,
      description: null,
      initialBpm: bpmFromWritten(entry?.andamento_escrito),
      targetBpm: null,
      bars: readInteger(entry?.total_de_compassos, { min: 1, max: 128 }),
      trackNames: readTextList(entry?.faixas_indicadas, { limit: CATALOG_LIMITS.trackNames, max: CATALOG_LIMITS.title }),
      pdfPage: readInteger(entry?.pagina_do_pdf, { min: 1, max: CATALOG_LIMITS.pdfPage }),
      strings,
      recipe,
      practiceMode: readText(entry?.modo_de_pratica, CATALOG_LIMITS.text),
      catalogId: readText(entry?.id, CATALOG_LIMITS.id) ?? id,
      variantOf: null,
    },
    recipe,
    reason,
    origin,
  };
}

// --------------------------------------------------------------- ligação

function lessonsOf(course) {
  const entries = [];
  const sections = Array.isArray(course?.sections) ? course.sections : [];
  sections.forEach((section, sectionIndex) => {
    const lessons = Array.isArray(section?.lessons) ? section.lessons : [];
    lessons.forEach((lesson, lessonIndex) => entries.push({ section, sectionIndex, lesson, lessonIndex }));
  });
  return entries;
}

function catalogReferenceKeys(entry) {
  const keys = [];
  for (const name of ['igual_a', 'semelhante_a']) {
    const value = unwrap(entry?.[name]);
    if (typeof value === 'string' && value.trim() !== '') keys.push(value.trim());
  }
  return keys;
}

// Liga o catálogo ao curso: cada entrada vai para a aula indicada por `aula_id`
// (o id numérico do mapa, já texto), os exercícios sugeridos dessas aulas são
// SUBSTITUÍDOS pelos do catálogo e as faixas indicadas viram vínculos com os
// materiais (pelo `findResource` injetado, o mesmo do conversor do mapa).
//
// Exercícios de 5 cordas entram como VARIAÇÕES do exercício de 4 cordas
// correspondente (`igual_a`/`semelhante_a`; sem referência, o exercício de 4
// cordas da mesma aula), no mesmo lugar do curso que ele.
export function applyCatalog(course, entries, { catalogId = null, findResource = null, warnings = [] } = {}) {
  const counts = { entries: 0, bound: 0, replaced: 0, variations: 0, unknownLesson: 0, withoutRecipe: 0, refs: 0, ignoredFields: 0 };
  // Trabalha numa cópia: a estrutura entra e sai sem efeito colateral no que o
  // chamador já tinha em mãos.
  const sections = (Array.isArray(course?.sections) ? course.sections : []).map(section => ({
    ...section,
    lessons: (Array.isArray(section?.lessons) ? section.lessons : []).map(lesson => ({
      ...lesson,
      suggestedExercises: [...(lesson.suggestedExercises ?? [])],
      resourceRefs: [...(lesson.resourceRefs ?? [])],
    })),
  }));
  const draft = { ...course, sections };
  const lessons = lessonsOf(draft);
  const byId = new Map(lessons.map(item => [item.lesson.id, item]));
  const groups = new Map();
  const rawEntries = Array.isArray(entries) ? entries : [];
  if (rawEntries.length > CATALOG_LIMITS.entries) {
    warnings.push({ path: 'catalogo', code: 'catalogo-grande', message: `O catálogo tinha mais de ${CATALOG_LIMITS.entries} entradas e o excedente foi ignorado.` });
  }
  const parsed = [];
  for (const [index, raw] of rawEntries.slice(0, CATALOG_LIMITS.entries).entries()) {
    const path = `catalogo[${index}]`;
    const entry = unwrap(raw);
    if (!isObject(entry)) {
      warnings.push({ path, code: 'catalogo-invalido', message: 'Uma entrada do catálogo não é um objeto e foi ignorada.' });
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (CATALOG_ENTRY_FIELDS.includes(key) || CATALOG_IGNORED_FIELDS.includes(key) || key === 'valor' || key === 'inferido') continue;
      warnings.push({ path: `${path}.${key}`, code: 'catalogo-campo-ignorado', message: 'Campo do catálogo não reconhecido; foi ignorado.' });
      counts.ignoredFields += 1;
    }
    for (const [nested, allowed] of [['forma', FORMA_FIELDS], ['sequencia_de_acordes', SEQUENCE_FIELDS], ['figura_ritmica', RHYTHM_FIELDS], ['contorno', CONTOUR_FIELDS], ['regiao_do_braco', REGION_FIELDS]]) {
      const value = unwrap(entry[nested]);
      if (!isObject(value)) continue;
      for (const key of Object.keys(value)) {
        if (allowed.includes(key)) continue;
        warnings.push({ path: `${path}.${nested}.${key}`, code: 'catalogo-campo-ignorado', message: 'Campo do catálogo não reconhecido; foi ignorado.' });
        counts.ignoredFields += 1;
      }
      if (nested === 'regiao_do_braco') {
        for (const edgeName of ['declarada', 'observada_na_tab']) {
          const edge = unwrap(value[edgeName]);
          if (!isObject(edge)) continue;
          for (const key of Object.keys(edge)) {
            if (REGION_EDGE_FIELDS.includes(key)) continue;
            warnings.push({ path: `${path}.regiao_do_braco.${edgeName}.${key}`, code: 'catalogo-campo-ignorado', message: 'Campo do catálogo não reconhecido; foi ignorado.' });
            counts.ignoredFields += 1;
          }
        }
      }
    }
    const aulaId = readInteger(entry.aula_id, {});
    const lessonId = aulaId === null ? null : String(aulaId);
    parsed.push({ entry, path, lessonId, references: catalogReferenceKeys(entry) });
  }
  counts.entries = parsed.length;
  // Sugestão por entrada: o id é estável (slug do id/nome do catálogo, único
  // dentro da aula) e a variação de 5 cordas aponta para a entrada de 4 cordas.
  const byCatalogId = new Map();
  const built = parsed.map((item, index) => {
    const provisional = readText(item.entry?.id, CATALOG_LIMITS.id) ?? `catalogo-${index + 1}`;
    const converted = catalogSuggestion(item.entry, { id: provisional, index });
    const target = item.lessonId !== null && byId.has(item.lessonId) ? byId.get(item.lessonId) : null;
    const record = { ...item, ...converted, target, index };
    byCatalogId.set(provisional, record);
    return record;
  });
  for (const [index, record] of built.entries()) {
    const base = record.references.map(key => byCatalogId.get(key)).find(candidate => candidate !== undefined && candidate !== record) ?? null;
    const sameLesson = built.find(candidate => candidate !== record && candidate.suggestion.strings === 4 && candidate.lessonId === record.lessonId) ?? null;
    const counterpart = record.suggestion.strings === 5 ? base ?? sameLesson : null;
    if (counterpart !== null) {
      record.suggestion.variantOf = counterpart.suggestion.id;
      record.suggestion.strings = 5;
      counts.variations += 1;
    }
    if (record.target === null) {
      counts.unknownLesson += 1;
      warnings.push({
        path: `${record.path}.aula_id`, code: 'catalogo-aula-ausente',
        message: 'O exercício do catálogo aponta para uma aula que não existe no mapa; ele ficou fora do curso.',
      });
      continue;
    }
    if (record.suggestion.recipe === null) {
      counts.withoutRecipe += 1;
      // Nada da entrada do catálogo entra no aviso (nem a cifra que o motor
      // recusou): só o caminho do campo e o motivo.
      const messages = {
        'progressao-ausente': 'O exercício do catálogo não traz a progressão de acordes; entrou sem receita.',
        'sem-receita': 'A progressão deste exercício do catálogo não pôde ser lida pelo gerador; entrou sem receita.',
        'receita-invalida': 'A receita montada para este exercício não passou pelo schema do curso; entrou sem receita.',
      };
      warnings.push({
        path: `${record.path}.familia`, code: 'catalogo-sem-receita',
        message: messages[record.reason] ?? 'A família deste exercício do catálogo não é gerável; entrou sem receita.',
      });
    }
    const host = counterpart !== null ? counterpart.target : record.target;
    const group = groups.get(host.lesson.id) ?? { lesson: host.lesson, item: host, suggestions: [] };
    groups.set(host.lesson.id, group);
    group.suggestions.push(record);
  }
  // Ids finais, únicos dentro da aula: a variação de 5 cordas só pode apontar
  // para o id FINAL do exercício de 4 cordas correspondente.
  const finalIds = new Map();
  for (const group of groups.values()) {
    const used = new Set();
    for (const record of group.suggestions) {
      finalIds.set(record.suggestion.catalogId, uniqueId(used, slug(record.suggestion.catalogId) ?? slug(record.suggestion.title), record.index));
    }
  }
  for (const group of groups.values()) {
    const suggestions = [];
    const refsBySuggestion = new Map();
    for (const record of group.suggestions) {
      const suggestion = {
        ...record.suggestion,
        id: finalIds.get(record.suggestion.catalogId),
        variantOf: record.suggestion.variantOf === null ? null : finalIds.get(record.suggestion.variantOf) ?? null,
      };
      counts.bound += 1;
      // As faixas indicadas viram vínculos com o material do curso. Um material
      // citado por dois exercícios entra uma vez só na aula.
      for (const name of suggestion.trackNames) {
        const found = typeof findResource === 'function' ? findResource(group.item, name) : null;
        if (found === null) {
          warnings.push({
            path: record.path, code: 'catalogo-faixa-ausente',
            message: 'Uma faixa indicada pelo catálogo não tem material equivalente no curso; o vínculo não foi criado.',
          });
          continue;
        }
        const list = refsBySuggestion.get(suggestion) ?? [];
        if (!list.some(ref => ref.lessonId === found.lesson.id && ref.resourceId === found.resource.id)) {
          list.push({ lessonId: found.lesson.id, resourceId: found.resource.id });
        }
        refsBySuggestion.set(suggestion, list);
      }
      suggestions.push(suggestion);
    }
    counts.replaced += group.lesson.suggestedExercises?.length ?? 0;
    group.lesson.suggestedExercises = suggestions;
    const seen = new Set((group.lesson.resourceRefs ?? []).map(ref => `${ref.lessonId}/${ref.resourceId}`));
    const lessonRefs = Array.isArray(group.lesson.resourceRefs) ? group.lesson.resourceRefs : [];
    const addRef = ref => {
      const key = `${ref.lessonId}/${ref.resourceId}`;
      if (seen.has(key)) return;
      seen.add(key);
      lessonRefs.push({ lessonId: ref.lessonId, resourceId: ref.resourceId });
      counts.refs += 1;
    };
    for (const list of refsBySuggestion.values()) for (const ref of list) addRef(ref);
    group.lesson.resourceRefs = lessonRefs;
  }
  const catalog = { id: catalogId, entries: counts.bound };
  draft.catalog = catalog;
  return { course: draft, counts, warnings };
}

// ------------------------------------------------------- receita do gerador

// Rótulo da forma como a loja de vínculos o guarda: três campos, texto puro.
export function shapeLabelKey(value) {
  if (!isObject(value) || !isText(value.label)) return null;
  return JSON.stringify([value.label, value.quality ?? null, value.inversion ?? null]);
}

export function recipeShapeLabel(recipe) {
  return isObject(recipe?.shapeLabel) ? recipe.shapeLabel : null;
}

// A receita precisa de uma forma escolhida para virar material?
export function recipeNeedsShape(recipe) {
  return CATALOG_LABEL_SHAPE_FAMILIES.includes(recipe?.family) && isObject(recipe?.shapeLabel);
}

// Receita do catálogo -> receita do gerador A2. Só os campos que o gerador
// conhece; `shapeLabel` NUNCA vai para lá (o gerador recusaria) e a forma
// escolhida entra em `shape`. Sem forma, a receita das famílias de região vale
// sem ela (o motor posiciona pela região/graus) — quem decide pedir a forma é a
// interface, pelo rótulo.
export function generatorRecipe(recipe, { shape = null } = {}) {
  if (!isObject(recipe)) throw new TypeError('A receita de estudo do catálogo não é um objeto.');
  const normalized = normalizeCatalogRecipe(recipe);
  if (!normalized.ok) {
    const first = normalized.errors[0];
    throw new TypeError(`A receita guardada no curso é inválida (${first.path || 'receita'}: ${first.message})`);
  }
  const base = normalized.recipe;
  const out = {
    version: RECIPE_VERSION,
    family: base.family,
    profile: { type: 'bass', strings: base.profile.strings },
    progression: { ...base.progression },
    rhythm: base.rhythm,
    voltas: base.voltas,
    final: base.final,
  };
  if (base.region !== null) out.region = { ...base.region };
  if (base.bars !== null) out.bars = base.bars;
  if (base.figure !== null) {
    const figure = {};
    for (const key of FIGURE_KEYS) if (base.figure[key] !== null) figure[key] = Array.isArray(base.figure[key]) ? [...base.figure[key]] : base.figure[key];
    // Com forma física a ORDEM dos graus é a da forma (o motor usa
    // `shape.degrees`); o contorno do catálogo vale só quando ela não existe.
    if (shape !== null) delete figure.degrees;
    if (Object.keys(figure).length > 0) out.figure = figure;
  }
  if (shape !== null) {
    if (!isObject(shape) || !Array.isArray(shape.notes) || shape.notes.length === 0) {
      throw new TypeError('A forma escolhida para o estudo não tem notas.');
    }
    if (base.progression.quality !== shape.quality) {
      throw new TypeError('A forma escolhida não é da mesma qualidade da progressão do exercício.');
    }
    out.shape = {
      id: typeof shape.id === 'string' ? shape.id : null,
      label: typeof shape.label === 'string' ? shape.label : null,
      quality: shape.quality,
      degrees: Array.isArray(shape.degrees) ? [...shape.degrees] : undefined,
      notes: shape.notes.map(note => ({ string: note.string, fret: note.fret, degree: note.degree })),
    };
  }
  return out;
}
