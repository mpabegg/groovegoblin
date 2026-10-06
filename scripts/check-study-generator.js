// Conferência do gerador de estudos (A2) contra um catálogo real OPCIONAL.
//
// Uso:
//   node scripts/check-study-generator.js [caminho-do-catalogo.json] [--formas=caminho.json]
//
// PRIVACIDADE: a saída traz SÓ contagens (por família, por motivo e por
// checagem). Nunca imprime título, nome de exercício, id, origem, caminho,
// filename, URL nem qualquer trecho do material. O caminho do catálogo também
// não é ecoado. Sem argumento, usa fixtures públicos inventados.
//
// Sem circularidade: a receita (`recipeFromCatalog`) é montada só com campos de
// DEFINIÇÃO do material (família, qualidade, cifras/regra, região DECLARADA,
// compassos por acorde, contorno, inversão, compasso final, origem 5 cordas,
// forma) e as checagens comparam valores DERIVADOS das notas geradas
// (`catalogValues`) com os campos de OBSERVAÇÃO, que nunca entram na receita:
//   bars          total_de_compassos                x compassos gerados (com o compasso final)
//   strings       cordas_usadas (G D A E B ou 1..5)  x cordas soltas das notas tocadas
//   minmax-frets  extensao_em_casas.menor/maior     x menor/maior casa tocada
//   regiao        regiao_do_braco.observada_na_tab  x todas as casas tocadas dentro dela
//   rhythm        figura_ritmica.padrao_codigo      x código realizado no 1º acorde ("q q h | h(lig) pausa_h")
// Só essas observações independentes contam para "conferido sem divergência"
// e para o código de saída.
//
// INFORMATIVO (nunca conta como ok, divergência nem exit code): `graus-ordem`
// compara `contorno.padrao` ("T-3-5") com os graus-base tocados no 1º bloco.
// O contorno também DEFINE a figura da receita, então a igualdade é quase
// sempre por construção; a linha só serve para achar contornos que o gerador
// recusou ou não realizou. Material só com contorno = `sem-dados-para-conferir`.
//
// formas (--formas=) — biblioteca de formas escolhidas/criadas na UI (etapa 5),
//   que "lembra o binding" material -> forma:
//   { "versao": 1, "formas": [ { "familia": "...", "qualidade": "...",
//       "graus": [1,3,5], "notas": [{ "corda": 4, "casa": 3, "grau": 1 }, ...],
//       "aplicar": { "aula_id": 12, "pagina_do_pdf": 7 } } ] }
//   `aplicar` é comparado com os campos do material (igualdade estrita por chave).
//
// Forma única SEM forma (no material ou na biblioteca): só as checagens que
// não dependem da digitação (bars, rhythm) rodam; cordas/casas/região contam
// `forma-nao-definida` — nunca correspondência com o autor. Formas combinadas
// e três inversões são posições da REGIÃO e são conferidas inteiras.

import { readFileSync, statSync } from 'node:fs';
import {
  STUDY_FAMILIES, recipeFromCatalog, catalogValues, catalogRhythm, catalogContour, normalizeRhythmCode,
} from '../src/study-generator.js';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MiB, medido em bytes ANTES de ler
const MAX_NODES = 20000;
const MAX_DEPTH = 8;
const MAX_ENTRIES = 4000;
const CHECKS = ['bars', 'strings', 'minmax-frets', 'regiao', 'rhythm'];
const INFO = ['graus-ordem-igual', 'graus-ordem-diferente', 'contorno-nao-mapeado'];
// Divergência = material coberto cujo valor derivado difere do observado.
const DIVERGENCES = [...CHECKS, 'erro'];
// Fora de escopo / não conferível: nunca conta como ok nem como divergência.
const UNCHECKED = ['forma-nao-definida', 'familia-desconhecida', 'qualidade-desconhecida', 'acordes-nao-definidos', 'ritmo-nao-mapeado', 'sem-dados-para-conferir'];
const REASONS = [...DIVERGENCES, ...UNCHECKED];
const HARMONIC = ['arpejo_triade_forma_unica', 'arpejo_triade_formas_combinadas', 'arpejo_tres_inversoes_por_acorde'];

function readJson(path) {
  if (statSync(path).size > MAX_BYTES) throw new Error('arquivo grande demais');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function pick(source, ...keys) {
  for (const key of keys) if (source && typeof source === 'object' && source[key] !== undefined && source[key] !== null) return source[key];
  return null;
}

// Percorre o envelope com limites (profundidade, nós, entradas) e sem imprimir nada.
function collectEntries(value) {
  const entries = [];
  let nodes = 0;
  const walk = (node, depth) => {
    if (nodes >= MAX_NODES || entries.length >= MAX_ENTRIES || depth > MAX_DEPTH || node === null || typeof node !== 'object') return;
    nodes += 1;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (pick(node, 'familia', 'family')) { entries.push(node); return; }
    for (const item of Object.values(node)) walk(item, depth + 1);
  };
  walk(value, 0);
  return entries;
}

function matchBinding(entry, rules) {
  for (const rule of rules) {
    const selector = rule?.aplicar;
    if (!selector || typeof selector !== 'object') continue;
    const keys = Object.keys(selector);
    if (keys.length && keys.every(key => pick(entry, key) === selector[key])) return rule;
  }
  return null;
}

function shapeNotes(entry, binding) {
  const direct = pick(pick(entry, 'forma', 'forma_do_braco'), 'notas');
  if (Array.isArray(direct) && direct.length) return direct;
  if (binding && Array.isArray(binding.notas) && binding.notas.length) return binding.notas;
  return null;
}

function withShape(entry, notes) {
  const mapped = notes.map(note => ({
    corda: pick(note, 'string', 'corda'), casa: pick(note, 'fret', 'casa'), grau: pick(note, 'degree', 'grau'),
  }));
  if (mapped.some(note => !Number.isInteger(note.corda) || !Number.isInteger(note.casa) || !Number.isInteger(note.grau))) return null;
  return { ...entry, forma: { ...(pick(entry, 'forma') ?? {}), notas: mapped } };
}

const sortedUnique = list => [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// cordas_usadas: letras das cordas soltas ("G","D","A","E","B") ou números 1..5.
function stringsDiffer(declared, values) {
  if (declared.every(Number.isInteger)) return sortedUnique(declared).join(',') !== sortedUnique(values.strings).join(',');
  if (declared.every(item => typeof item === 'string' && /^[A-G][#b]?$/i.test(item.trim()))) {
    const letters = declared.map(item => item.trim().replace(/^./, letter => letter.toUpperCase()));
    return sortedUnique(letters).join(',') !== sortedUnique(values.stringNames).join(',');
  }
  return null;
}

function compare(entry, rules) {
  const family = typeof pick(entry, 'familia', 'family') === 'string' ? pick(entry, 'familia', 'family').trim() : '';
  if (!STUDY_FAMILIES.includes(family)) return { family: 'desconhecida', checks: [], divergences: [], unchecked: ['familia-desconhecida'], info: [] };
  const binding = matchBinding(entry, rules);
  const notes = shapeNotes(entry, binding);
  const bound = notes ? withShape({ ...entry, familia: family }, notes) : null;
  const source = bound ?? { ...entry, familia: family };
  // Forma única sem digitação: casas/cordas dependem da forma do autor.
  const geometryKnown = family !== 'arpejo_triade_forma_unica' || bound !== null;
  let values;
  try {
    values = catalogValues(recipeFromCatalog(source));
  } catch (error) {
    const message = String(error?.message);
    const reason = /Qualidade de catálogo/.test(message) ? 'qualidade-desconhecida' : /Material sem acordes/.test(message) ? 'acordes-nao-definidos' : null;
    return reason ? { family, checks: [], divergences: [], unchecked: [reason], info: [] } : { family, checks: ['erro'], divergences: ['erro'], unchecked: [], info: [] };
  }
  const checks = [];
  const divergences = [];
  const unchecked = [];
  const info = [];
  const check = (name, differs) => { checks.push(name); if (differs) divergences.push(name); };

  const declaredBars = pick(entry, 'total_de_compassos');
  if (Number.isInteger(declaredBars)) check('bars', declaredBars !== values.bars);

  const strings = pick(entry, 'cordas_usadas');
  const extension = pick(entry, 'extensao_em_casas', 'extensão_em_casas');
  const observed = pick(pick(entry, 'regiao_do_braco', 'região_do_braço'), 'observada_na_tab');
  const geometryDeclared = (Array.isArray(strings) && strings.length) || extension !== null || observed !== null;
  if (!geometryKnown) {
    if (geometryDeclared) unchecked.push('forma-nao-definida');
  } else {
    if (Array.isArray(strings) && strings.length) {
      const differs = stringsDiffer(strings, values);
      if (differs !== null) check('strings', differs);
    }
    const menor = pick(extension, 'menor');
    const maior = pick(extension, 'maior');
    if (Number.isInteger(menor) || Number.isInteger(maior)) {
      check('minmax-frets', (Number.isInteger(menor) && menor !== values.minFret) || (Number.isInteger(maior) && maior !== values.maxFret));
    }
    if (Number.isInteger(observed?.de) && Number.isInteger(observed?.ate)) {
      const low = Math.min(observed.de, observed.ate);
      const high = Math.max(observed.de, observed.ate);
      check('regiao', values.minFret < low || values.maxFret > high);
    }
  }

  const code = pick(pick(entry, 'figura_ritmica', 'figura_rítmica'), 'padrao_codigo', 'padrão_codigo');
  if (code !== null) {
    const word = catalogRhythm(code);
    const declared = word ? null : normalizeRhythmCode(code);
    if (word) check('rhythm', word !== values.rhythm);
    else if (declared) check('rhythm', declared !== values.rhythmCode);
    else unchecked.push('ritmo-nao-mapeado');
  }

  // Informativo: o contorno define a figura; comparar não prova nada sozinho.
  const contourText = pick(pick(entry, 'contorno'), 'padrao', 'padrão');
  if (HARMONIC.includes(family) && contourText !== null) {
    const contour = catalogContour(contourText);
    if (contour?.degrees) info.push(contour.degrees.join(',') === values.degreeOrder.join(',') ? 'graus-ordem-igual' : 'graus-ordem-diferente');
    else if (!contour) info.push('contorno-nao-mapeado');
  }

  if (checks.length === 0) unchecked.push('sem-dados-para-conferir');
  return { family, checks, divergences, unchecked, info };
}

// Fixtures inventados (valores calculados à mão para o gerador atual).
function fixtures() {
  return [
    {
      // C: 31 36 40 43 (4/3 3/3 2/2 2/5); G a partir de 43 subindo: 47 43 38 35 (1/4 2/5 3/5 3/2).
      familia: 'movimento_continuo_linha_4_notas', qualidade: 'maior', sequencia_de_acordes: { cifras: ['C', 'G'] },
      regiao_do_braco: { declarada: { de: 1, ate: 5 }, observada_na_tab: { de: 1, ate: 5 } }, cordas_usadas: ['G', 'D', 'A', 'E'],
      total_de_compassos: 2, contorno: { padrao: 'sobe' }, figura_ritmica: { padrao_codigo: 'q q q q' },
      extensao_em_casas: { menor: 2, maior: 5 },
    },
    // Forma única sem digitação: só compassos e ritmo (q q h | h(lig) pausa_h) são conferíveis; o contorno é informativo.
    {
      familia: 'arpejo_triade_forma_unica', qualidade: 'maior', sequencia_de_acordes: { cifras: ['C'] }, total_de_compassos: 2,
      figura_ritmica: { padrao_codigo: 'q q h | h(lig) pausa_h' }, contorno: { padrao: 'T-3-5' },
    },
    { familia: 'conteudo-do-curso', qualidade: 'maior' },
  ];
}

function main() {
  const args = process.argv.slice(2);
  const formsFlag = args.find(argument => argument.startsWith('--formas='));
  const catalog = args.find(argument => !argument.startsWith('--')) ?? null;
  let entries = fixtures();
  if (catalog) {
    try {
      entries = collectEntries(readJson(catalog));
    } catch {
      entries = [];
      console.log('catálogo não pôde ser lido (contagens zeradas).');
    }
  }
  let rules = [];
  if (formsFlag) {
    try {
      const library = readJson(formsFlag.slice('--formas='.length));
      rules = Array.isArray(library?.formas) ? library.formas : Array.isArray(library) ? library : [];
    } catch {
      console.log('biblioteca de formas não pôde ser lida; seguindo sem binding.');
    }
  }
  const byFamily = new Map();
  const byReason = Object.fromEntries(REASONS.map(reason => [reason, 0]));
  const byCheck = Object.fromEntries(CHECKS.map(name => [name, 0]));
  const byInfo = Object.fromEntries(INFO.map(name => [name, 0]));
  let clean = 0;
  let divergent = 0;
  let unverifiable = 0;
  for (const entry of entries) {
    const result = compare(entry, rules);
    const bucket = byFamily.get(result.family) ?? { total: 0, clean: 0, reasons: {} };
    bucket.total += 1;
    for (const name of result.checks) if (byCheck[name] !== undefined) byCheck[name] += 1;
    for (const name of result.info) byInfo[name] += 1;
    for (const reason of [...result.divergences, ...result.unchecked]) {
      bucket.reasons[reason] = (bucket.reasons[reason] ?? 0) + 1;
      byReason[reason] += 1;
    }
    if (result.divergences.length) divergent += 1;
    else if (result.checks.length) { bucket.clean += 1; clean += 1; } else unverifiable += 1;
    byFamily.set(result.family, bucket);
  }
  console.log(`study-generator: ${entries.length} material(is); ${byFamily.size} família(s); ${clean} conferido(s) sem divergência; ${divergent} com divergência; ${unverifiable} não conferível(is).`);
  [...byFamily.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).forEach(([family, bucket]) => {
    const reasons = Object.entries(bucket.reasons).sort(([a], [b]) => (a < b ? -1 : 1)).map(([reason, value]) => `${reason} ${value}`).join(' · ');
    console.log(`  ${family}: ${bucket.total} · ok ${bucket.clean}${reasons ? ` · ${reasons}` : ''}`);
  });
  const nonzero = REASONS.filter(reason => byReason[reason] > 0);
  console.log(`motivos: ${nonzero.length ? nonzero.map(reason => `${reason} ${byReason[reason]}`).join(' · ') : 'nenhum'}`);
  console.log(`checagens: ${CHECKS.map(name => `${name} ${byCheck[name]}`).join(' · ')}`);
  console.log(`informativo (não conta): ${INFO.map(name => `${name} ${byInfo[name]}`).join(' · ')}`);
  if (!catalog) console.log('(sem catálogo: contagens apenas dos fixtures públicos inventados.)');
  if (divergent) process.exitCode = 1;
}

main();
