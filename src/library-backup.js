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
//  - **legado continua entrando**: backups antigos de biblioteca/exercício e a
//    sessão crua seguem pelo caminho de importação que já existia, sem mudança
//    de contrato;
//  - reimportar o mesmo backup é idempotente (dedup por conteúdo completo nos
//    exercícios, união sem duplicatas nos estados).
//
// Textos e exemplos são FICTÍCIOS; nenhum arquivo é buscado da rede.

import { validateSnapshot } from './course-store.js';

export const LIBRARY_BACKUP_KIND = 'groovegoblin-library-backup';
export const LIBRARY_BACKUP_VERSION = 1;
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

export function backupFileName(now = isoNow) {
  const stamp = String(now()).replace(/[:.]/g, '-');
  return `groovegoblin-backup-${stamp}.json`;
}

// Resumo do envelope para o diálogo (tamanho/counts antes de gerar o arquivo).
export function summarizeBackup(document) {
  const entries = Array.isArray(document?.exercises?.entries) ? document.exercises.entries : [];
  const records = Array.isArray(document?.courses?.records) ? document.courses.records : [];
  const states = Array.isArray(document?.courses?.states) ? document.courses.states : [];
  const orphans = states.filter(state => !records.some(record => record.id === state.courseId)).length;
  const attachments = document?.attachments ?? {};
  const courses = document?.courses ?? {};
  return {
    exercises: entries.length,
    records: entries.reduce((total, entry) => total + (entry?.metadata?.records?.length ?? 0), 0),
    courses: records.length,
    states: states.length,
    orphans,
    // Uma loja AUSENTE não vira "0 curso": o arquivo diz que não foi conferida.
    coursesAvailable: courses.available !== false,
    corrupt: Array.isArray(courses.corrupt) ? courses.corrupt.length : 0,
    attachments: attachments.included === true
      ? { included: true, ...backupAttachmentSummary(attachments.document?.totals ?? attachments.totals) }
      : { included: false, ...backupAttachmentSummary(attachments.totals ?? null) },
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

// Monta o envelope. `includeAttachments` é o opt-in explícito do diálogo: sem
// ele nenhum byte de arquivo entra no documento (mas o total ocupado continua
// explícito no resumo).
//
// Uma loja INDISPONÍVEL não vira "0 curso"/"0 anexo": os dados continuam no
// disco e um arquivo com cara de completo seria pior que nenhum. Biblioteca
// corrompida/indisponível ou controlador entregue com `persistent === false`
// RECUSAM a exportação agregada, com o caminho de recuperação na mensagem.
export async function buildBackup({
  library, store = null, attachments = null, includeAttachments = false, now = isoNow, app = null,
} = {}) {
  if (!library || typeof library.exportLibrary !== 'function') throw new TypeError('Biblioteca de exercícios ausente para exportar.');
  const status = typeof library.status === 'string' ? library.status : null;
  if (status !== null && status !== 'ready') {
    return exportRefusal(status === 'corrupt' ? 'corrupt' : 'unavailable', 'library', status === 'corrupt'
      ? 'A biblioteca de exercícios está corrompida: os bytes originais se baixam em Ajuda antes de qualquer backup novo. Nada foi exportado.'
      : 'A biblioteca de exercícios está indisponível neste navegador; nada foi exportado (o documento musical atual se baixa pela Ajuda).');
  }
  if (controllerUnavailable(store)) {
    return exportRefusal('unavailable', 'courses', `Os cursos guardados não podem ser lidos agora (${controllerReason(store, 'loja de cursos indisponível')}). Nada foi exportado: o arquivo sairia sem os cursos e o progresso que continuam no disco.`);
  }
  if (controllerUnavailable(attachments)) {
    return exportRefusal('unavailable', 'attachments', `Os anexos guardados não podem ser lidos agora (${controllerReason(attachments, 'loja de anexos indisponível')}). Nada foi exportado: o arquivo sairia sem os arquivos que continuam no disco.`);
  }
  const exercises = JSON.parse(library.exportLibrary());
  // Loja de cursos AUSENTE (API opcional): o envelope é explícito sobre isso.
  let courses = { available: store !== null, records: [], states: [], orphans: [], corrupt: [] };
  if (store && typeof store.snapshotAll === 'function') {
    if (typeof store.ready === 'function') await store.ready();
    const snapshot = store.snapshotAll();
    courses = {
      available: true,
      records: snapshot.records,
      states: snapshot.states,
      orphans: snapshot.orphans.map(state => state.courseId),
      corrupt: snapshot.corrupt.map(entry => ({ store: entry.store, id: entry.id ?? null, raw: entry.raw ?? null })),
    };
  }
  let attachmentBlock = { included: false, document: null, totals: null };
  if (attachments && typeof attachments.totals === 'function') {
    if (typeof attachments.ready === 'function') await attachments.ready();
    attachmentBlock.totals = attachments.totals();
  }
  if (includeAttachments) {
    if (!attachments || typeof attachments.exportStructured !== 'function') {
      throw new Error('Os anexos deste navegador não podem ser lidos agora; exporte a biblioteca sem anexos.');
    }
    const exported = await attachments.exportStructured({ includeBlobs: true });
    if (!exported?.ok) throw new Error(exported?.error ?? 'Não foi possível ler os anexos para exportar; exporte sem anexos.');
    attachmentBlock = { included: true, document: exported.document, totals: exported.document.totals ?? null };
  }
  const document = {
    kind: LIBRARY_BACKUP_KIND,
    version: LIBRARY_BACKUP_VERSION,
    exportedAt: now(),
    app,
    exercises,
    courses,
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
export async function importBackup(input, { library, store = null, attachments = null } = {}) {
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
  const applied = { exercises: { added: exerciseResult.added, reused: exerciseResult.reused }, courses: null, attachments: null };

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
  const attachments = result.attachments ?? null;
  const parts = [
    `${exercises.added} exercício(s) adicionado(s)`,
    `${exercises.reused} já presente(s)`,
    `${courses.added} curso(s) novo(s)`,
    `${courses.merged + courses.orphans} estado(s) atualizado(s)`,
  ];
  if (attachments) parts.push(`${attachments.addedFiles ?? 0} arquivo(s) de anexo`);
  const warnings = result.warnings?.length ?? 0;
  return `Importação concluída: ${parts.join('; ')}.${warnings > 0 ? ` ${warnings} aviso(s) registrados.` : ''}`;
}
