// Casamento de arquivos da pasta de entrada com os materiais do curso.
//
// Rodada 6, etapa 8 (B4b). Módulo puro, sem I/O e sem dependências: recebe o
// nome do arquivo e a lista de materiais do curso (o documento `courses/<id>` já
// convertido) e diz quais materiais aquele arquivo serve.
//
// A tolerância é a do relato: maiúsculas/minúsculas, acentos, espaços, hífens,
// underscores e sufixos de cópia como "(1)" não distinguem dois nomes. Também
// seguimos a regra do conversor para material de 6 cordas: o arquivo que só
// existe em 6 cordas é ignorado; o que cita as duas versões fica, porque o app
// toca a de 4 ou 5.
//
// Nada aqui imprime nem devolve caminho absoluto; os nomes devolvidos são nomes
// de material do curso (conteúdo privado) e só o chamador autenticado os vê.

export const AUDIO_EXTENSIONS = Object.freeze(['mp3', 'wav', 'wave', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'webm']);
export const PDF_EXTENSIONS = Object.freeze(['pdf']);
export const ZIP_EXTENSIONS = Object.freeze(['zip']);

// Marcador de membro de ZIP: `<zip>::<membro>` nunca confunde com um nome de
// arquivo da pasta, porque a barra invertida e o "::" não entram em nome de
// arquivo guardado (validateStoredName recusa).
export const ZIP_MEMBER_SEPARATOR = '::';

const FILE_EXTENSION = /\.([A-Za-z0-9]{1,8})$/;
const COPY_SUFFIX = /(?:\s*[-–—]?\s*(?:c[oó]pia|copy)\s*\d*)$/;
// O navegador batiza a segunda cópia baixada de "(1)", "(2)"…: isso não
// distingue dois nomes (só dígitos entre parênteses contam; "(4 cordas)" fica).
const NUMBERED_COPY_SUFFIX = /(?:\s*[-–—]?\s*\(\s*\d+\s*\))$/;
const SIX_STRINGS = /(^|[^0-9])6\s*[-_ ]?\s*(cordas|strings)/;
const SEIS_CORDAS = /seis\s+cordas/;
const DIACRITICS = /[\u0300-\u036f]/g;
const NOT_KEY = /[^a-z0-9]+/g;

// Dobra o texto: sem acento, minúsculo, espaços colapsados. Mesma ideia do
// `foldText` do conversor, sem importar o conversor (o servidor não deve
// depender do script de linha de comando para casar nome de arquivo).
export function foldName(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFD').replace(DIACRITICS, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function extensionOf(name) {
  const match = FILE_EXTENSION.exec(String(name ?? '').trim());
  return match ? match[1].toLowerCase() : '';
}

// Nome sem a extensão final (só quando a extensão parece extensão).
export function withoutExtension(name) {
  const text = String(name ?? '');
  return FILE_EXTENSION.test(text) ? text.replace(FILE_EXTENSION, '') : text;
}

function stripCopySuffixes(stem) {
  let current = stem;
  for (;;) {
    const next = current.replace(COPY_SUFFIX, '').replace(NUMBERED_COPY_SUFFIX, '');
    if (next === current || next.trim() === '') return current;
    current = next;
  }
}

// Chave de casamento: sem extensão, sem acento, sem separador nenhum, sem
// sufixo de cópia. "Apostila 4-Cordas (1).PDF" e "apostila 4 cordas.pdf" caem na
// mesma chave.
export function matchKey(name) {
  const folded = foldName(name);
  if (folded === '') return null;
  const key = stripCopySuffixes(withoutExtension(folded)).replace(NOT_KEY, '');
  return key === '' ? null : key;
}

function mentionsAlternateStrings(text) {
  const numbers = (text.match(/\d+/g) ?? []).map(Number);
  if (numbers.length < 2) return false;
  return numbers.includes(4) || numbers.includes(5);
}

// "6 cordas", "6-cordas", "seis cordas" no nome denuncia material de 6 cordas —
// a não ser que o mesmo nome cite também a versão de 4 ou 5 ("4 e 6 cordas").
export function isSixStringsName(name) {
  const text = foldName(name);
  if (text === '') return false;
  if (!SIX_STRINGS.test(text) && !SEIS_CORDAS.test(text)) return false;
  return !mentionsAlternateStrings(text);
}

export function isPdfName(name) {
  return PDF_EXTENSIONS.includes(extensionOf(name));
}

export function isAudioName(name) {
  return AUDIO_EXTENSIONS.includes(extensionOf(name));
}

export function isZipName(name) {
  return ZIP_EXTENSIONS.includes(extensionOf(name));
}

export const FILE_KINDS = Object.freeze({ pdf: 'pdf', audio: 'audio', zip: 'zip', other: 'other', sixStrings: 'six-strings', invalid: 'invalid' });

// Tipo do arquivo pelo NOME (a assinatura do conteúdo é conferida depois, no
// blob store, que nunca confia no que o cliente declarou).
export function classifyFileName(name) {
  const text = String(name ?? '').trim();
  if (text === '' || text.length > 240 || /[\u0000-\u001f\u007f]/.test(text) || text.includes('/') || text.includes('\\')) return FILE_KINDS.invalid;
  if (isSixStringsName(text)) return FILE_KINDS.sixStrings;
  if (isPdfName(text)) return FILE_KINDS.pdf;
  if (isAudioName(text)) return FILE_KINDS.audio;
  if (isZipName(text)) return FILE_KINDS.zip;
  return FILE_KINDS.other;
}

export function memberId(zipName, memberName) {
  return `${zipName}${ZIP_MEMBER_SEPARATOR}${memberName}`;
}

export function parseMemberId(id) {
  if (typeof id !== 'string') return null;
  const index = id.indexOf(ZIP_MEMBER_SEPARATOR);
  if (index <= 0 || index + ZIP_MEMBER_SEPARATOR.length >= id.length) return null;
  return { zipName: id.slice(0, index), memberName: id.slice(index + ZIP_MEMBER_SEPARATOR.length) };
}

// Índice dos materiais do curso. Material = `lesson.resources[]` do documento
// convertido (v1 e v2). A chave do vínculo é a mesma do app:
// `JSON.stringify([courseId, lessonId, resourceId])`.
export function courseMaterialIndex(course, courseId) {
  // `courses/<id>` guarda o ENVELOPE `groovegoblin-course`
  // (`{ format, version, course, progress? }`, o mesmo que a conversão e a
  // sincronização gravam) — os materiais vivem no curso de dentro. Um curso
  // passado direto (sem envelope) também é aceito.
  const root = course !== null && typeof course === 'object' && course.course !== null && typeof course.course === 'object' ? course.course : course;
  const list = [];
  const sections = Array.isArray(root?.sections) ? root.sections : [];
  for (const section of sections) {
    const lessons = Array.isArray(section?.lessons) ? section.lessons : [];
    for (const lesson of lessons) {
      const resources = Array.isArray(lesson?.resources) ? lesson.resources : [];
      for (const resource of resources) {
        if (typeof resource?.id !== 'string' || resource.id === '') continue;
        if (typeof lesson?.id !== 'string' || lesson.id === '') continue;
        const name = typeof resource.name === 'string' && resource.name.trim() !== '' ? resource.name : resource.id;
        list.push({
          refKey: JSON.stringify([courseId, lesson.id, resource.id]),
          lessonId: lesson.id,
          resourceId: resource.id,
          name,
          extension: typeof resource.extension === 'string' ? resource.extension : '',
          role: typeof resource.role === 'string' ? resource.role : null,
          strings: resource.strings ?? null,
          page: Number.isInteger(resource.pdfPage) ? resource.pdfPage : null,
          key: matchKey(name),
        });
      }
    }
  }
  const byKey = new Map();
  for (const material of list) {
    if (material.key === null) continue;
    if (!byKey.has(material.key)) byKey.set(material.key, []);
    byKey.get(material.key).push(material);
  }
  return Object.freeze({
    courseId,
    list: Object.freeze(list),
    total: list.length,
    byKey,
    match(name) {
      const key = matchKey(name);
      return key === null ? [] : (byKey.get(key) ?? []);
    },
    byRefKey(refKey) {
      return list.find((material) => material.refKey === refKey) ?? null;
    },
  });
}

// A página da apostila de um exercício sugerido: primeiro a página declarada no
// próprio exercício, depois a do material que casa com as faixas citadas.
export function apostilaPageFor(index, lesson, exercise) {
  if (Number.isInteger(exercise?.pdfPage)) return exercise.pdfPage;
  for (const trackName of exercise?.trackNames ?? []) {
    const matches = index.match(trackName);
    const withPage = matches.find((material) => Number.isInteger(material.page) && material.page > 0);
    if (withPage) return withPage.page;
  }
  return null;
}
