// Backup agregado da Biblioteca (rodada 5, etapa 7).
//
// Um único envelope versionado reúne o que hoje vive em três lugares: a
// biblioteca de exercícios (localStorage, documento `groovegoblin-exercise-library`),
// a loja de cursos (IndexedDB próprio, catálogo + TODOS os estados, inclusive
// órfãos de `removeCourse`) e, opcionalmente, os anexos de aula (IndexedDB
// próprio, etapa 6). A sessão v5 NÃO muda: o exercício continua sendo o mesmo
// documento canônico.
//
// Regras duras desta camada:
//  - **validar tudo antes de qualquer mutação**: envelope, exercícios, cursos,
//    estados e anexos são conferidos ANTES da primeira gravação;
//  - **sem atomicidade global fingida**: localStorage e os dois IndexedDB não
//    têm transação comum. Cada loja confirma a escrita antes de mexer na
//    memória e uma falha posterior é relatada como PARCIAL, com precisão, sem
//    rollback destrutivo e sem retentativa automática;
//  - **anexos são opt-in**: o padrão não leva bytes; o diálogo mostra quantidade
//    e tamanho e só inclui o que o usuário pedir;
//  - **conteúdo de curso fora do padrão (B6)**: o backup público (padrão) não
//    leva catálogo, estados, vínculos, textos, anexos nem bytes ilegíveis de
//    curso, e os exercícios passam por `course-privacy.js` com a loja REAL; o
//    opt-in explícito `includeCourseContent` gera o arquivo PRIVADO;
//  - **vínculos rótulo→forma do catálogo (A5)** são conteúdo de curso (o rótulo
//    é do catálogo pago): só viajam no backup privado, e a importação é união
//    idempotente DEPOIS das formas e dos cursos;
//  - **legado continua entrando**: backups antigos de biblioteca/exercício e a
//    sessão crua seguem pelo caminho de importação que já existia, sem mudança
//    de contrato;
//  - reimportar o mesmo backup é idempotente (dedup por conteúdo completo nos
//    exercícios, união sem duplicatas nos estados).
//
// Textos e exemplos são FICTÍCIOS; nenhum arquivo é buscado da rede.

import { validateSnapshot } from './course-store.js';
import { shareableLibrary } from './course-privacy.js';

export const LIBRARY_BACKUP_KIND = 'groovegoblin-library-backup';
export const LIBRARY_BACKUP_VERSION = 1;
// Conteúdo de curso (B6): o envelope público é o PADRÃO; o privado é um opt-in
// explícito, com nome de arquivo marcado e confirmação na interface.
export const PRIVATE_FILENAME_MARK = 'PRIVADO';
export const PRIVATE_CONTENT_LABEL = 'Incluir conteúdo privado de cursos';
export const LEGACY_LIBRARY_KIND = 'groovegoblin-exercise-library';
export const LEGACY_EXERCISE_KIND = 'groovegoblin-exercise';
// Erros devolvidos de uma vez; o resto continua no relatório da loja.
const MAX_ERRORS = 100;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

function issue(path, code, message) {
  return { path, code, message };
}

function isoNow() {
  return new Date().toISOString();
}

// Rótulo honesto de espaço ocupado (o mesmo espírito do rótulo dos anexos, sem
// depender de módulo de interface).
export function formatByteSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mega = bytes / (1024 * 1024);
  return `${(mega >= 10 ? String(Math.round(mega)) : mega.toFixed(1).replace('.', ',')).replace(',0', '')} MB`;
}

export function backupAttachmentSummary(totals) {
  const known = isObject(totals);
  const files = known && Number.isFinite(totals.files) ? totals.files : 0;
  const bytes = known && Number.isFinite(totals.bytes) ? totals.bytes : 0;
  return {
    available: known,
    files,
    refs: known && Number.isFinite(totals.refs) ? totals.refs : 0,
    bytes,
    label: known
      ? `${files} arquivo${files === 1 ? '' : 's'} (${formatByteSize(bytes)})`
      : 'anexos não conferidos',
  };
}

export function backupFileName(now = isoNow, { includeCourseContent = false } = {}) {
  const stamp = String(now()).replace(/[:.]/g, '-');
  const mark = includeCourseContent ? `-${PRIVATE_FILENAME_MARK}` : '';
  return `groovegoblin-backup${mark}-${stamp}.json`;
}

// Resumo do envelope para o diálogo (tamanho/counts antes de gerar o arquivo).
export function summarizeBackup(document) {
  const entries = Array.isArray(document?.exercises?.entries) ? document.exercises.entries : [];
  const records = Array.isArray(document?.courses?.records) ? document.courses.records : [];
  const states = Array.isArray(document?.courses?.states) ? document.courses.states : [];
  const orphans = states.filter(state => !records.some(record => record.id === state.courseId)).length;
  const attachments = document?.attachments ?? {};
  const courses = document?.courses ?? {};
  const shapes = document?.shapes ?? {};
  const bindingBlock = document?.shapeBindings ?? {};
  const courseContent = document?.privacy?.courseContent === 'included' ? 'included' : 'omitted';
  const shapeList = shapes.instruments !== null && typeof shapes.instruments === 'object' ? Object.values(shapes.instruments) : [];
  return {
    exercises: entries.length,
    records: entries.reduce((total, entry) => total + (entry?.metadata?.records?.length ?? 0), 0),
    courses: records.length,
    states: states.length,
    orphans,
    // Uma loja AUSENTE não vira "0 curso": o arquivo diz que não foi conferida.
    coursesAvailable: courses.available !== false,
    // Omissão INTENCIONAL (backup público) é diferente de loja que falhou: o
    // resumo precisa distinguir as duas para o diálogo não mentir. Um arquivo sem
    // os campos novos (rodada 5) não é nem "incluído" nem "omitido": é sem marca.
    courseContent: courseContent === 'included' ? 'included' : (courses.omitted === true ? 'omitted' : 'unmarked'),
    coursesOmitted: courses.omitted === true,
    corrupt: Array.isArray(courses.corrupt) ? courses.corrupt.length : 0,
    // Idem para as formas de dedilhado: contagem só quando a loja foi conferida.
    shapesAvailable: shapes.available === true,
    shapes: shapeList.reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0),
    shapesCorrupt: shapes.available === true && shapes.corrupt !== undefined && shapes.corrupt !== null,
    // Vínculos rótulo→forma: contagem só quando o bloco veio (privado).
    bindingsAvailable: bindingBlock.available === true,
    bindings: Array.isArray(bindingBlock.bindings) ? bindingBlock.bindings.length : 0,
    bindingsOmitted: bindingBlock.omitted === true,
    bindingsCorrupt: bindingBlock.corrupt === true,
    attachments: attachments.included === true
      ? { included: true, ...backupAttachmentSummary(attachments.document?.totals ?? attachments.totals) }
      : { included: false, ...backupAttachmentSummary(attachments.totals ?? null) },
    attachmentsOmitted: attachments.omitted === true,
  };
}

// Recusa HONESTA de exportação: não fabrica arquivo nenhum e nomeia a loja.
function exportRefusal(code, store, error) {
  return { ok: false, code, store, error, document: null, summary: null };
}

function controllerUnavailable(controller) {
  return controller !== null && typeof controller === 'object' && controller.persistent === false;
}

function controllerReason(controller, fallback) {
  const message = typeof controller?.error === 'string' && controller.error.length > 0 ? controller.error : fallback;
  return message;
}

// Um vínculo legado (exercício ligado a uma aula ANTES de o marcador pegajoso
// existir) só pode ser declarado público quando a loja de cursos RESPONDE.
// Loja ausente, com erro, não persistente ou com registros ilegíveis ⇒ o backup
// público redige por precaução: o arquivo nunca afirma "sem conteúdo de curso"
// sobre o que não pôde conferir.
function privacyStoreUnknown(store) {
  if (!store || typeof store.originsOf !== 'function') return true;
  if (store.persistent === false || store.error) return true;
  if (typeof store.corrupt === 'function') {
    try { if (store.corrupt().length > 0) return true; }
    catch { return true; }
  }
  return false;
}

// Monta o envelope. `includeAttachments` é o opt-in explícito do diálogo: sem
// ele nenhum byte de arquivo entra no documento (mas o total ocupado continua
// explícito no resumo).
//
// `includeCourseContent` é o opt-in explícito de conteúdo de curso (B6). O
// PADRÃO é o backup público: catálogo, estados, vínculos, textos, anexos e
// bytes ilegíveis de curso ficam de fora, e os exercícios passam pela redação de
// `course-privacy.js` (com a loja REAL, não só o marcador pegajoso). Anexos
// exigem as duas opções: são conteúdo de curso por natureza.
//
// Uma loja INDISPONÍVEL não vira "0 curso"/"0 anexo": os dados continuam no
// disco e um arquivo com cara de completo seria pior que nenhum. Biblioteca
// corrompida/indisponível ou controlador entregue com `persistent === false`
// RECUSAM a exportação agregada, com o caminho de recuperação na mensagem.
export async function buildBackup({
  library, store = null, attachments = null, includeAttachments = false, now = isoNow, app = null, shapes = null,
  bindings = null, includeCourseContent = false,
} = {}) {
  if (!library || typeof library.exportLibrary !== 'function') throw new TypeError('Biblioteca de exercícios ausente para exportar.');
  const status = typeof library.status === 'string' ? library.status : null;
  if (status !== null && status !== 'ready') {
    return exportRefusal(status === 'corrupt' ? 'corrupt' : 'unavailable', 'library', status === 'corrupt'
      ? 'A biblioteca de exercícios está corrompida: os bytes originais se baixam em Ajuda antes de qualquer backup novo. Nada foi exportado.'
      : 'A biblioteca de exercícios está indisponível neste navegador; nada foi exportado (o documento musical atual se baixa pela Ajuda).');
  }
  if (shapes !== null && typeof shapes.exportDocument !== 'function') throw new TypeError('Loja de formas de dedilhado inválida para exportar.');
  if (bindings !== null && typeof bindings.exportDocument !== 'function') throw new TypeError('Loja de vínculos de forma do catálogo inválida para exportar.');
  if (controllerUnavailable(store)) {
    return exportRefusal('unavailable', 'courses', `Os cursos guardados não podem ser lidos agora (${controllerReason(store, 'loja de cursos indisponível')}). Nada foi exportado: o arquivo sairia sem os cursos e o progresso que continuam no disco.`);
  }
  if (controllerUnavailable(attachments)) {
    return exportRefusal('unavailable', 'attachments', `Os anexos guardados não podem ser lidos agora (${controllerReason(attachments, 'loja de anexos indisponível')}). Nada foi exportado: o arquivo sairia sem os arquivos que continuam no disco.`);
  }
  // Formas de dedilhado: loja indisponível RECUSA (o arquivo sairia sem elas).
  // Documento ILEGÍVEL não recusa: os bytes vão no envelope, preservados, para o
  // usuário não perder a única cópia.
  if (shapes !== null && shapes.status === 'unavailable') {
    return exportRefusal('unavailable', 'shapes', `As formas de dedilhado guardadas não podem ser lidas agora (${controllerReason(shapes, 'loja de formas indisponível')}). Nada foi exportado: o arquivo sairia sem elas.`);
  }
  // Vínculos rótulo→forma do catálogo: mesma regra da loja de formas.
  if (bindings !== null && bindings.status === 'unavailable') {
    return exportRefusal('unavailable', 'shapeBindings', `Os vínculos de forma do catálogo não podem ser lidos agora (${controllerReason(bindings, 'loja de vínculos indisponível')}). Nada foi exportado: o arquivo sairia sem eles.`);
  }
  if (includeAttachments && !includeCourseContent) {
    return exportRefusal('private-required', 'attachments', 'Anexos de aula são conteúdo de curso: marque e confirme "Incluir conteúdo privado de cursos" para levá-los no arquivo. O backup público sai sem nenhum anexo.');
  }
  // A loja carrega de forma preguiçosa: a decisão de redigir ou não só vale
  // depois do `ready`, senão um vínculo legado ainda não lido passaria por
  // público.
  if (store && typeof store.ready === 'function') await store.ready();
  const rawExercises = JSON.parse(library.exportLibrary({ includeCourseContent: true }));
  // Loja de cursos que não responde ⇒ não há como declarar um vínculo legado
  // público: a redação do backup público é conservadora (ver a nota do módulo).
  const unknownCourses = privacyStoreUnknown(store);
  let exercises = rawExercises;
  if (!includeCourseContent) {
    try {
      exercises = shareableLibrary(rawExercises, unknownCourses ? { unknownCourses: true } : { courseStore: store });
    } catch {
      // Falha ao consultar as origens conta como loja desconhecida, nunca como
      // "sem conteúdo de curso".
      exercises = shareableLibrary(rawExercises, { unknownCourses: true });
    }
  }
  // Loja de cursos AUSENTE (API opcional): o envelope é explícito sobre isso.
  // No backup PÚBLICO o bloco inteiro é omitido DE PROPÓSITO (catálogo, estados,
  // vínculos e bytes ilegíveis são conteúdo de curso); `omitted` separa essa
  // omissão intencional de uma loja que falhou.
  let courses = {
    available: store !== null,
    omitted: !includeCourseContent,
    records: [], states: [], orphans: [], corrupt: [],
  };
  if (includeCourseContent && store && typeof store.snapshotAll === 'function') {
    const snapshot = store.snapshotAll();
    courses = {
      available: true,
      omitted: false,
      records: snapshot.records,
      states: snapshot.states,
      orphans: snapshot.orphans.map(state => state.courseId),
      corrupt: snapshot.corrupt.map(entry => ({ store: entry.store, id: entry.id ?? null, raw: entry.raw ?? null })),
    };
  }
  // Formas de dedilhado (A3): loja AUSENTE vira `available:false` explícito,
  // nunca "0 forma" silencioso.
  let shapeBlock = { available: false, version: null, instruments: {}, corrupt: null };
  if (shapes !== null) {
    const exported = shapes.exportDocument();
    shapeBlock = {
      available: true,
      version: exported.version,
      instruments: exported.instruments,
      corrupt: shapes.status === 'corrupt' ? { raw: shapes.recoveryRaw ?? null, error: shapes.warning ?? null } : null,
    };
  }
  // Vínculos rótulo→forma do catálogo (A5/A6): o RÓTULO é do catálogo pago, então
  // este bloco só existe no backup PRIVADO. No público ele sai omitido e SEM
  // nenhum rótulo; loja ausente vira `available:false` explícito.
  let bindingBlock = { available: false, omitted: !includeCourseContent, version: null, bindings: [], corrupt: false, error: null };
  if (includeCourseContent && bindings !== null) {
    const exported = bindings.exportDocument();
    bindingBlock = {
      available: true,
      omitted: false,
      version: exported.version,
      bindings: Array.isArray(exported.bindings) ? exported.bindings : [],
      // Bytes ilegíveis no navegador de origem não são inventados: o bloco diz
      // que estavam ilegíveis e nada é sobrescrito.
      corrupt: bindings.status === 'corrupt',
      error: bindings.status === 'corrupt' ? (bindings.error ?? null) : null,
    };
  }
  // Anexos (nomes, tipos e bytes) são conteúdo de curso: no backup público o
  // bloco sai VAZIO e declarado como omitido, sem nem ler os totais da loja.
  let attachmentBlock = { included: false, document: null, totals: null, omitted: !includeCourseContent };
  if (includeCourseContent && attachments && typeof attachments.totals === 'function') {
    if (typeof attachments.ready === 'function') await attachments.ready();
    attachmentBlock.totals = attachments.totals();
  }
  if (includeAttachments) {
    if (!attachments || typeof attachments.exportStructured !== 'function') {
      throw new Error('Os anexos deste navegador não podem ser lidos agora; exporte a biblioteca sem anexos.');
    }
    const exported = await attachments.exportStructured({ includeBlobs: true });
    if (!exported?.ok) throw new Error(exported?.error ?? 'Não foi possível ler os anexos para exportar; exporte sem anexos.');
    attachmentBlock = { included: true, document: exported.document, totals: exported.document.totals ?? null, omitted: false };
  }
  const document = {
    kind: LIBRARY_BACKUP_KIND,
    version: LIBRARY_BACKUP_VERSION,
    exportedAt: now(),
    app,
    privacy: { courseContent: includeCourseContent ? 'included' : 'omitted' },
    exercises,
    courses,
    shapes: shapeBlock,
    shapeBindings: bindingBlock,
    attachments: attachmentBlock,
  };
  return { ok: true, document, summary: summarizeBackup(document) };
}

export function serializeBackup(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

// Reconhece o que o usuário escolheu. O caminho LEGADO é preservado: biblioteca
// agregada nova, biblioteca/exercício antigos e sessão crua.
export function recognizeBackup(value) {
  if (!isObject(value)) return { kind: 'invalid', errors: [issue('', 'estrutura', 'O backup deve ser um objeto JSON.')] };
  if (value.kind === LIBRARY_BACKUP_KIND) return { kind: 'aggregate', errors: [] };
  if (value.kind === LEGACY_LIBRARY_KIND) return { kind: 'legacy-library', errors: [] };
  if (value.kind === LEGACY_EXERCISE_KIND) return { kind: 'legacy-exercise', errors: [] };
  if (value.kind !== undefined && value.kind !== null) {
    return { kind: 'invalid', errors: [issue('kind', 'formato', 'Este arquivo não é um backup do GrooveGoblin.')] };
  }
  // Sem `kind`: o caminho antigo aceitava a sessão crua.
  return { kind: 'legacy-session', errors: [] };
}

// Validação PURA do envelope agregado (não toca em loja nenhuma). Os anexos são
// conferidos de verdade pelo preflight da loja de anexos; aqui só a estrutura.
export function validateBackup(document) {
  const errors = [];
  if (!isObject(document)) return { ok: false, errors: [issue('', 'estrutura', 'O backup deve ser um objeto JSON.')] };
  if (document.kind !== LIBRARY_BACKUP_KIND) errors.push(issue('kind', 'formato', 'Este arquivo não é um backup agregado da biblioteca.'));
  if (!Number.isInteger(document.version) || document.version < 1 || document.version > LIBRARY_BACKUP_VERSION) {
    errors.push(issue('version', 'versao', 'A versão deste backup não é suportada por este GrooveGoblin.'));
  }
  const exercises = document.exercises;
  if (!isObject(exercises) || !Array.isArray(exercises.entries)) {
    errors.push(issue('exercises.entries', 'estrutura', 'O backup está sem a lista de exercícios.'));
  } else {
    exercises.entries.forEach((entry, index) => {
      const path = `exercises.entries[${index}]`;
      if (!isObject(entry)) { errors.push(issue(path, 'exercicio', 'Cada exercício do backup deve ser um objeto.')); return; }
      if (entry.id !== undefined && entry.id !== null && !isText(entry.id)) errors.push(issue(`${path}.id`, 'id', 'O identificador do exercício deve ser texto.'));
      if (!isObject(entry.session)) errors.push(issue(`${path}.session`, 'sessao', 'O exercício do backup está sem a sessão.'));
      if (entry.metadata !== undefined && entry.metadata !== null && !isObject(entry.metadata)) errors.push(issue(`${path}.metadata`, 'metadados', 'Os metadados do exercício devem ser um objeto.'));
    });
    if (exercises.activeId !== undefined && exercises.activeId !== null && !isText(exercises.activeId)) {
      errors.push(issue('exercises.activeId', 'id', 'O exercício ativo do backup deve ser um identificador.'));
    }
  }
  const snapshot = validateSnapshot(document.courses);
  if (!snapshot.ok) {
    for (const error of snapshot.errors) errors.push(issue(`courses.${error.path}`.replace(/\.$/, ''), error.code, error.message));
  }
  // `omitted` marca omissão INTENCIONAL de conteúdo de curso (backup público),
  // distinta de loja que não pôde ser lida (`available:false`).
  if (document.courses !== undefined && document.courses !== null && isObject(document.courses)
    && document.courses.omitted !== undefined && typeof document.courses.omitted !== 'boolean') {
    errors.push(issue('courses.omitted', 'estrutura', 'O bloco de cursos precisa dizer se foi omitido de propósito.'));
  }
  const privacy = document.privacy;
  if (privacy !== undefined && privacy !== null) {
    if (!isObject(privacy)) {
      errors.push(issue('privacy', 'estrutura', 'O bloco de privacidade do backup está inválido.'));
    } else if (privacy.courseContent !== undefined && privacy.courseContent !== 'included' && privacy.courseContent !== 'omitted') {
      errors.push(issue('privacy.courseContent', 'estrutura', 'A privacidade do backup precisa dizer se o conteúdo de curso entrou.'));
    }
  }
  // Vínculos rótulo→forma do catálogo (A5). Ausente/null = arquivo da rodada 5
  // (ou público antigo) — continua legível. Presente = conferido ANTES de gravar.
  const shapeBindings = document.shapeBindings;
  if (shapeBindings !== undefined && shapeBindings !== null) {
    if (!isObject(shapeBindings)) {
      errors.push(issue('shapeBindings', 'estrutura', 'O bloco de vínculos de forma do catálogo está inválido.'));
    } else {
      if (typeof shapeBindings.available !== 'boolean') {
        errors.push(issue('shapeBindings.available', 'estrutura', 'O bloco de vínculos de forma precisa dizer se foi conferido.'));
      }
      if (shapeBindings.omitted !== undefined && typeof shapeBindings.omitted !== 'boolean') {
        errors.push(issue('shapeBindings.omitted', 'estrutura', 'O bloco de vínculos de forma precisa dizer se foi omitido de propósito.'));
      }
      if (shapeBindings.corrupt !== undefined && typeof shapeBindings.corrupt !== 'boolean') {
        errors.push(issue('shapeBindings.corrupt', 'recuperacao', 'O bloco de recuperação dos vínculos de forma está inválido.'));
      }
      const list = shapeBindings.bindings;
      if (shapeBindings.available === true) {
        if (!Number.isInteger(shapeBindings.version) || shapeBindings.version < 1) {
          errors.push(issue('shapeBindings.version', 'versao', 'Os vínculos de forma do backup estão sem versão compatível.'));
        }
        if (!Array.isArray(list)) {
          errors.push(issue('shapeBindings.bindings', 'estrutura', 'O bloco de vínculos de forma está sem a lista de vínculos.'));
        } else {
          const seen = new Set();
          list.forEach((binding, index) => {
            const path = `shapeBindings.bindings[${index}]`;
            if (!isObject(binding)) { errors.push(issue(path, 'vinculo', 'Cada vínculo de forma deve ser um objeto.')); return; }
            if (!isText(binding.label)) errors.push(issue(`${path}.label`, 'rotulo', 'O vínculo de forma precisa do rótulo do catálogo.'));
            if (!isText(binding.shapeId)) errors.push(issue(`${path}.shapeId`, 'forma', 'O vínculo de forma precisa da forma escolhida.'));
            for (const key of ['id', 'quality', 'inversion', 'instrument', 'boundAt']) {
              const value = binding[key];
              if (value !== undefined && value !== null && !isText(value)) errors.push(issue(`${path}.${key}`, 'vinculo', `O campo ${key} do vínculo de forma deve ser texto.`));
            }
            // Duplicata por rótulo é recusada: a união por id perderia uma delas.
            if (isText(binding.label)) {
              const key = binding.id ?? JSON.stringify([binding.label.trim(), binding.quality ?? null, binding.inversion ?? null]);
              if (seen.has(key)) errors.push(issue(`${path}.label`, 'duplicado', 'O mesmo rótulo de forma aparece mais de uma vez no backup.'));
              seen.add(key);
            }
          });
        }
      } else if (list !== undefined && list !== null && (!Array.isArray(list) || list.length > 0)) {
        errors.push(issue('shapeBindings.bindings', 'estrutura', 'Vínculos de forma não conferidos não podem trazer rótulos.'));
      }
    }
  }
  const attachments = document.attachments;
  if (attachments !== undefined && attachments !== null) {
    if (!isObject(attachments)) {
      errors.push(issue('attachments', 'estrutura', 'O bloco de anexos do backup está inválido.'));
    } else if (attachments.included === true) {
      if (!isObject(attachments.document)) errors.push(issue('attachments.document', 'estrutura', 'O backup diz incluir anexos, mas não traz os arquivos.'));
      else if (!isText(attachments.document.format)) errors.push(issue('attachments.document.format', 'formato', 'Os anexos do backup estão sem formato reconhecível.'));
    } else if (attachments.included !== false) {
      errors.push(issue('attachments.included', 'estrutura', 'O bloco de anexos precisa dizer se os arquivos foram incluídos.'));
    }
  }
  const shapes = document.shapes;
  if (shapes !== undefined && shapes !== null) {
    if (!isObject(shapes)) {
      errors.push(issue('shapes', 'estrutura', 'O bloco de formas de dedilhado do backup está inválido.'));
    } else if (shapes.available !== true && shapes.available !== false) {
      errors.push(issue('shapes.available', 'estrutura', 'O bloco de formas de dedilhado precisa dizer se foi conferido.'));
    } else if (shapes.available === true) {
      if (!isObject(shapes.instruments)) {
        errors.push(issue('shapes.instruments', 'estrutura', 'O bloco de formas de dedilhado está sem os instrumentos.'));
      } else {
        for (const [id, list] of Object.entries(shapes.instruments)) {
          if (!Array.isArray(list)) { errors.push(issue(`shapes.instruments.${id}`, 'estrutura', 'Cada instrumento do backup de formas deve listar as formas.')); continue; }
          list.forEach((shape, index) => {
            const path = `shapes.instruments.${id}[${index}]`;
            if (!isObject(shape)) { errors.push(issue(path, 'forma', 'Cada forma do backup deve ser um objeto.')); return; }
            if (!isText(shape.id)) errors.push(issue(`${path}.id`, 'id', 'A forma do backup precisa de um identificador.'));
            if (!isText(shape.label)) errors.push(issue(`${path}.label`, 'nome', 'A forma do backup precisa de um nome.'));
            if (!isText(shape.quality)) errors.push(issue(`${path}.quality`, 'qualidade', 'A forma do backup precisa de uma qualidade.'));
            if (!Array.isArray(shape.degrees) || shape.degrees.length === 0) errors.push(issue(`${path}.degrees`, 'graus', 'A forma do backup precisa dos graus.'));
            if (!Array.isArray(shape.notes) || shape.notes.length === 0) { errors.push(issue(`${path}.notes`, 'notas', 'A forma do backup precisa das notas clicadas no braço.')); return; }
            shape.notes.forEach((note, position) => {
              if (!isObject(note) || !Number.isInteger(note.string) || !Number.isInteger(note.fret) || !Number.isInteger(note.degree)) {
                errors.push(issue(`${path}.notes[${position}]`, 'nota', 'Cada nota da forma precisa de corda, casa e grau inteiros.'));
              }
            });
          });
        }
      }
      if (shapes.corrupt !== undefined && shapes.corrupt !== null && !isObject(shapes.corrupt)) {
        errors.push(issue('shapes.corrupt', 'recuperacao', 'O bloco de recuperação das formas está inválido.'));
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, errors: [] };
}

// Valida e decodifica todos os anexos antes de qualquer mutação. A loja devolve
// um pacote preparado, aplicado depois sem decodificar os arquivos novamente.
async function preflightAttachments(attachments, document) {
  if (!attachments) {
    return { ok: false, errors: [issue('attachments', 'indisponivel', 'Este navegador não oferece a loja de anexos; o backup com anexos não pode ser importado aqui. Importe-o sem eles.')] };
  }
  if (typeof attachments.prepareImport === 'function' && typeof attachments.commitPrepared === 'function') {
    let prepared;
    try {
      // Sem opções: a loja decodifica/valida com o seu próprio relógio e SEM
      // gravar nada. O pacote devolvido é aplicado depois, sem decodificar de novo.
      prepared = await attachments.prepareImport(document);
    } catch (error) {
      return { ok: false, errors: [issue('attachments', error?.code ?? 'anexos', error?.message ?? 'Não foi possível ler os anexos do backup.')] };
    }
    if (!prepared?.ok) {
      return { ok: false, errors: prepared?.errors?.length ? prepared.errors : [issue('attachments', prepared?.code ?? 'anexos', prepared?.error ?? 'Os anexos do backup não passaram na validação.')] };
    }
    // Plano com QUALQUER problema (referência inválida, arquivo ilegível,
    // colisão de conteúdo) recusa a importação inteira: nada é aplicado "pela
    // metade" em silêncio — o usuário vê o que está errado antes de gravar.
    if (prepared.errors?.length) return { ok: false, errors: prepared.errors };
    return {
      ok: true,
      warnings: [],
      commit: () => attachments.commitPrepared(prepared.prepared),
    };
  }
  return { ok: false, errors: [issue('attachments', 'preflight', 'A loja de anexos desta versão não sabe validar o backup antes de gravar; nada foi importado. Atualize a página e tente de novo.')] };
}

function attachmentErrorMessage(error) {
  const code = error?.code ?? null;
  const base = error?.message ?? 'Falha ao gravar os anexos.';
  return code === 'quota' ? `Sem espaço para os anexos: ${base}` : base;
}

// Importação completa. Devolve sempre um resultado honesto: `ok` com o que
// entrou, ou falha/parcial com o que JÁ entrou (nada é apagado para "corrigir").
//
// Ordem: exercícios (commit antes da memória) → cursos (remapeando vínculos com
// o mapa origem→destino) → anexos. Assim nenhum curso aponta para exercício que
// não entrou, e os anexos, que são o volume maior, entram por último.
export async function importBackup(input, { library, store = null, attachments = null, shapes = null, bindings = null } = {}) {
  if (!library || typeof library.importEntries !== 'function') throw new TypeError('Biblioteca de exercícios ausente para importar.');
  let document = input;
  let text = null;
  if (typeof input === 'string') {
    text = input;
    try { document = JSON.parse(input); }
    catch { return { ok: false, phase: 'parse', partial: false, applied: null, errors: [issue('', 'json', 'Não foi possível ler o arquivo: o JSON é inválido.')] }; }
  }
  const recognized = recognizeBackup(document);
  if (recognized.kind === 'invalid') {
    return { ok: false, phase: 'validate', partial: false, applied: null, errors: recognized.errors };
  }
  // Caminho LEGADO: contrato antigo, intacto (sem cursos, sem anexos).
  if (recognized.kind !== 'aggregate') {
    const payload = text ?? JSON.stringify(document);
    try {
      const result = recognized.kind === 'legacy-library' ? library.importLibrary(payload) : library.importExercise(payload);
      return { ok: true, legacy: recognized.kind, phase: 'done', partial: false, applied: { exercises: { added: result.added, reused: result.skipped ?? 0 } }, errors: [] };
    } catch (error) {
      return { ok: false, legacy: recognized.kind, phase: 'exercises', partial: false, applied: null, errors: [issue('exercises', 'importacao', error?.message ?? 'Importação recusada.')] };
    }
  }
  const validated = validateBackup(document);
  if (!validated.ok) return { ok: false, phase: 'validate', partial: false, applied: null, errors: validated.errors };

  let commitAttachments = null;
  let attachmentWarnings = [];
  if (document.attachments?.included === true) {
    const preflight = await preflightAttachments(attachments, document.attachments.document);
    if (!preflight.ok) return { ok: false, phase: 'attachments', partial: false, applied: null, errors: preflight.errors };
    commitAttachments = preflight.commit;
    attachmentWarnings = preflight.warnings ?? [];
  }

  let exerciseResult;
  try {
    exerciseResult = library.importEntries(document.exercises.entries, { activeId: document.exercises.activeId ?? null });
  } catch (error) {
    return { ok: false, phase: 'exercises', partial: false, applied: null, errors: [issue('exercises', 'importacao', error?.message ?? 'Importação de exercícios recusada.')] };
  }
  const applied = { exercises: { added: exerciseResult.added, reused: exerciseResult.reused }, courses: null, shapes: null, bindings: null, attachments: null };

  const courseSnapshot = document.courses ?? { records: [], states: [] };
  const courseRecords = Array.isArray(courseSnapshot.records) ? courseSnapshot.records : [];
  const courseStates = Array.isArray(courseSnapshot.states) ? courseSnapshot.states : [];
  const warnings = [...attachmentWarnings];
  // Registro ilegível cru veio no arquivo mas NUNCA é gravado: o aviso é
  // explícito para o usuário não achar que os bytes voltaram para a loja.
  if (Array.isArray(courseSnapshot.corrupt) && courseSnapshot.corrupt.length > 0) {
    warnings.push(issue('courses.corrupt', 'recuperacao', `${courseSnapshot.corrupt.length} registro(s) de curso ilegível(is) do backup não foram gravados (os bytes continuam preservados só no arquivo).`));
  }
  applied.courses = { added: 0, merged: 0, unchanged: 0, orphans: 0, tombstones: 0, resurrected: 0, watched: 0, notes: 0, links: 0, watch: 0 };
  let courseResult = null;
  // Sem NENHUM curso/estado para gravar, a fase de cursos é pulada: um backup
  // só de exercícios não vira "importação parcial" por a loja existir e não ser
  // gravável.
  if (courseRecords.length + courseStates.length > 0) {
    if (!store || typeof store.importSnapshot !== 'function' || store.persistent === false) {
      return {
        ok: false, phase: 'courses', partial: true, applied, warnings,
        errors: [issue('courses', 'indisponivel', `O backup traz ${courseRecords.length} curso(s) e ${courseStates.length} estado(s), mas a loja de cursos não está disponível neste navegador; os exercícios entraram e os cursos não. Importe-o num navegador com IndexedDB ou use só os exercícios.`)],
        report: null,
      };
    }
    const remap = id => exerciseResult.map[id] ?? id;
    try {
      courseResult = await store.importSnapshot(courseSnapshot, { remapExerciseId: remap });
    } catch (error) {
      courseResult = { ok: false, code: 'unknown', error: error?.message ?? 'Falha ao importar os cursos.' };
    }
    if (!courseResult.ok) {
      // O relatório PARCIAL do importSnapshot diz quantos cursos entraram antes
      // da falha; é ele que a mensagem mostra (nunca 0 por omissão).
      applied.courses = courseResult.report ?? null;
      return {
        ok: false, phase: 'courses', partial: true, applied, warnings,
        errors: courseResult.errors?.length ? courseResult.errors : [issue('courses', courseResult.code ?? 'cursos', courseResult.error ?? 'Não foi possível importar os cursos.')],
        report: courseResult.report ?? null,
      };
    }
    applied.courses = courseResult.report;
  }

  // Formas de dedilhado (A3): união idempotente. Forma recusada vira AVISO (o
  // arquivo continua com ela; nada foi apagado para "corrigir").
  const shapeSnapshot = document.shapes ?? null;
  if (shapeSnapshot?.available === true) {
    const incoming = Object.values(shapeSnapshot.instruments ?? {}).reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0);
    if (incoming > 0) {
      if (!shapes || typeof shapes.importDocument !== 'function') {
        return {
          ok: false, phase: 'shapes', partial: true, applied, warnings,
          errors: [issue('shapes', 'indisponivel', `O backup traz ${incoming} forma(s) de dedilhado, mas a loja de formas não está disponível neste navegador; os exercícios${applied.courses ? ' e os cursos' : ''} entraram e as formas não.`)],
          report: courseResult?.report ?? null,
        };
      }
      const result = shapes.importDocument(shapeSnapshot);
      applied.shapes = { added: result.added, reused: result.reused, renamed: result.renamed };
      for (const error of (result.errors ?? []).slice(0, 5)) {
        warnings.push(issue(`shapes.${error.code ?? 'forma'}`, 'formas', `Forma não importada: ${error.message}`));
      }
    } else {
      applied.shapes = { added: 0, reused: 0, renamed: 0 };
    }
    if (shapeSnapshot.corrupt !== undefined && shapeSnapshot.corrupt !== null) {
      warnings.push(issue('shapes.corrupt', 'recuperacao', 'Havia formas ilegíveis no backup (bytes preservados só no arquivo); elas não foram gravadas.'));
    }
  }

  // Vínculos rótulo→forma do catálogo (A5): união idempotente, DEPOIS das formas
  // (o vínculo aponta para o id de uma forma) e dos cursos. O bloco público vem
  // omitido, sem nenhum rótulo.
  const bindingSnapshot = document.shapeBindings ?? null;
  if (bindingSnapshot?.available === true) {
    const incoming = Array.isArray(bindingSnapshot.bindings) ? bindingSnapshot.bindings.length : 0;
    if (incoming > 0) {
      if (!bindings || typeof bindings.importDocument !== 'function') {
        return {
          ok: false, phase: 'shapeBindings', partial: true, applied, warnings,
          errors: [issue('shapeBindings', 'indisponivel', `O backup traz ${incoming} vínculo(s) de forma do catálogo, mas a loja de vínculos não está disponível neste navegador; o resto entrou e os vínculos não.`)],
          report: courseResult?.report ?? null,
        };
      }
      let result;
      try {
        result = bindings.importDocument({ version: bindingSnapshot.version ?? 1, bindings: bindingSnapshot.bindings });
      } catch (error) {
        return {
          ok: false, phase: 'shapeBindings', partial: true, applied, warnings,
          errors: [issue('shapeBindings', 'vinculos', `Os vínculos de forma do backup não passaram na validação da loja: ${error?.message ?? error}`)],
          report: courseResult?.report ?? null,
        };
      }
      applied.bindings = { added: result.added, total: result.total ?? null };
      // Gravação negada não vira sucesso falso: nada é apagado, o arquivo
      // continua com os vínculos e a falha é dita.
      if (result.added > 0 && (bindings.status === 'blocked' || bindings.status === 'corrupt')) {
        return {
          ok: false, phase: 'shapeBindings', partial: true, applied, warnings,
          errors: [issue('shapeBindings', 'gravacao', `Os vínculos de forma do catálogo não foram gravados neste navegador (${bindings.error ?? 'o armazenamento recusou'}); eles continuam preservados só no arquivo.`)],
          report: courseResult?.report ?? null,
        };
      }
    } else {
      applied.bindings = { added: 0, total: null };
    }
    if (bindingSnapshot.corrupt === true) {
      warnings.push(issue('shapeBindings.corrupt', 'recuperacao', 'Havia vínculos de forma ilegíveis no navegador de origem; eles não vieram no arquivo e nada foi sobrescrito.'));
    }
  }
  let attachmentResult = null;
  if (commitAttachments) {
    try {
      attachmentResult = await commitAttachments();
    } catch (error) {
      return {
        ok: false, phase: 'attachments', partial: true, applied, warnings,
        errors: [issue('attachments', error?.code ?? 'anexos', attachmentErrorMessage(error))],
        report: courseResult?.report ?? null,
      };
    }
    if (attachmentResult?.ok === false) {
      return {
        ok: false, phase: 'attachments', partial: true, applied, warnings,
        errors: [issue('attachments', attachmentResult.code ?? 'anexos', attachmentResult.error ?? 'Os anexos não foram aplicados.')],
        report: courseResult?.report ?? null,
      };
    }
  }

  return {
    ok: true,
    phase: 'done',
    partial: false,
    legacy: null,
    map: exerciseResult.map,
    applied,
    attachments: attachmentResult,
    warnings,
    report: courseResult?.report ?? null,
    // Omissão INTENCIONAL de conteúdo de curso (arquivo público) é informada,
    // para "0 curso(s)" não ser lido como "a loja falhou".
    courseContent: document.privacy?.courseContent === 'included'
      ? 'included'
      : (document.courses?.omitted === true ? 'omitted' : 'unmarked'),
    errors: [],
  };
}

// Texto para a interface. Nunca afirma sucesso além do que o resultado diz.
export function describeImportResult(result) {
  if (!result) return 'Importação não executada.';
  if (!result.ok) {
    const detail = result.errors?.[0]?.message ?? 'erro desconhecido';
    if (result.partial) {
      const exercicios = result.applied?.exercises?.added ?? 0;
      const cursos = result.applied?.courses?.added ?? 0;
      const base = `Importação PARCIAL: ${detail} O que já entrou foi preservado (${exercicios} exercício(s), ${cursos} curso(s) novo(s)); nada foi apagado nem repetido automaticamente.`;
      const warnings = result.warnings?.length ?? 0;
      return warnings > 0 ? `${base} ${warnings} aviso(s) registrados.` : base;
    }
    return `Importação rejeitada: ${detail} Nada foi alterado.`;
  }
  if (result.legacy) {
    return `Importação concluída: ${result.applied?.exercises?.added ?? 0} exercício(s) adicionado(s), ${result.applied?.exercises?.reused ?? 0} já presente(s) sem sobrescrever.`;
  }
  const exercises = result.applied?.exercises ?? { added: 0, reused: 0 };
  const courses = result.applied?.courses ?? { added: 0, merged: 0, orphans: 0 };
  const shapes = result.applied?.shapes ?? null;
  const attachments = result.attachments ?? null;
  const parts = [
    `${exercises.added} exercício(s) adicionado(s)`,
    `${exercises.reused} já presente(s)`,
    `${courses.added} curso(s) novo(s)`,
    `${courses.merged + courses.orphans} estado(s) atualizado(s)`,
  ];
  if (shapes) parts.push(`${shapes.added} forma(s) de dedilhado`);
  if (result.applied?.bindings) parts.push(`${result.applied.bindings.added} vínculo(s) de forma do catálogo`);
  if (attachments) parts.push(`${attachments.addedFiles ?? 0} arquivo(s) de anexo`);
  const warnings = result.warnings?.length ?? 0;
  const omittedNote = result.courseContent === 'omitted' ? ' Arquivo público: o conteúdo de curso ficou de fora por opção.' : '';
  return `Importação concluída: ${parts.join('; ')}.${warnings > 0 ? ` ${warnings} aviso(s) registrados.` : ''}${omittedNote}`;
}
