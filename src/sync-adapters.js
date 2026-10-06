// Adaptadores entre as lojas locais e as coleções do servidor (etapa 7 · B4).
//
// Cada adaptador é um "porto" pequeno e testável:
//
//   {
//     collection: 'exercises',            // coleção no servidor
//     singleton: false,                   // um único documento?
//     documentId: 'default',              // id fixo quando singleton
//     async list() -> [{ id, body, updatedAt }]
//     async get(id) -> { id, body, updatedAt } | null
//     async apply({ id, body }) -> { changed, body }   // fusão, nunca apaga
//     async remove(id) -> { changed }
//     subscribe(listener) -> unsubscribe
//     blobs?: { list(), read(sha), release(shas, {pinned}), pinned() }
//   }
//
// Regras que valem para todos:
// - nenhuma escrita local é feita por `apply`/`remove` sem passar pelas APIs
//   públicas da loja (ou por métodos de sincronização explicitamente
//   propostos na etapa — ver `local/round6-stage7-wiring.md`);
// - `apply` é SEMPRE aditivo (união). Nada é apagado por causa de um documento
//   remoto, exceto lápides explícitas do servidor;
// - o corpo do documento é o JSON do próprio app. O de CURSO é exatamente o
//   envelope `groovegoblin-course` (`{format, version, course, progress?}`) que
//   o servidor grava na conversão — nada de envelope paralelo; o estado do
//   curso viaja SEPARADO, na coleção `courseStates`.

export const SYNC_COLLECTIONS = Object.freeze({
  exercises: 'exercises',
  courses: 'courses',
  courseStates: 'courseStates',
  courseAttachments: 'courseAttachments',
  todayQueues: 'todayQueues',
  routines: 'routines',
  forms: 'forms',
  preferences: 'preferences',
});

// Coleções que o servidor conhece e que esta etapa não usa.
export const UNUSED_COLLECTIONS = Object.freeze({});

// Dois documentos independentes dentro da coleção `forms`: as formas de
// dedilhado (A3) e os vínculos rótulo→forma (A5). Cada um é `exportDocument()`
// da sua própria loja — nada de envelope paralelo — e a indisponibilidade de um
// não apaga nem bloqueia o outro.
export const SHAPES_DOC_ID = 'shapes';
export const BINDINGS_DOC_ID = 'bindings';

// O que fica FORA da sincronização, com o motivo. Cada chave é uma decisão
// registrada — e nenhuma varredura do armazenamento inteiro acontece: só os
// portos declarados abaixo leem alguma coisa.
export const EXCLUDED_LOCAL_KEYS = Object.freeze([
  { key: 'groovegoblin.input.v1', reason: 'dispositivo de entrada escolhido é da máquina' },
  { key: 'groovegoblin.input-calibration.v1', reason: 'calibração de latência é da máquina' },
  { key: 'groovegoblin.studio.instrument.v1', reason: 'dispositivo/instrumento da sessão é da máquina' },
  { key: 'groovegoblin.studio.track-layout.v1', reason: 'layout de faixas é da máquina' },
  { key: 'groovegoblin.mixer.v1', reason: 'mixer/ganhos são o estado momentâneo do navegador' },
  { key: 'groovegoblin.session.v2', reason: 'documento de trabalho da sessão, não preferência' },
  { key: 'groovegoblin.repertoire.ui.v1', reason: 'dados e preferências da aba Músicas (fora do escopo da rodada)' },
  { key: 'groovegoblin.playground.v1', reason: 'capturas, ovos e contagem do Explorar são conteúdo/progresso de uma máquina, não preferência' },
  { key: 'groovegoblin.practice-activity.v1', reason: 'diário de tempo praticado: dado derivado, já refletido nos registros dos exercícios' },
  { key: 'groovegoblin.practice.v1.skills', reason: 'habilidades medidas no jogo de ouvido são histórico, não configuração' },
  { key: 'groovegoblin.practice.v1.history', reason: 'histórico de prática é dado, não configuração' },
  { key: 'groovegoblin.preferences.v1', reason: 'chave legada (só leitura de migração)' },
  { key: 'groovegoblin.v1', reason: 'chave legada (só leitura de migração)' },
  { key: 'groovegoblin.session.v2.recovery', reason: 'bytes de recuperação ficam locais' },
]);

// Preferências realmente portáteis: um allowlist EXPLÍCITO de chave + campos.
// Nada de copiar o `localStorage` inteiro; o que não está aqui não sai do
// navegador (dispositivo, calibração, layout, mixer, Músicas, histórico).
export const PREFERENCE_SECTIONS = Object.freeze([
  Object.freeze({
    id: 'practice',
    key: 'groovegoblin.practice.v1',
    fields: Object.freeze(['objective', 'routine']),
    reason: 'configuração do treino (objetivo e rotina), nunca histórico nem habilidades',
  }),
  Object.freeze({
    id: 'transport',
    key: 'groovegoblin.transport',
    fields: Object.freeze(['countInBars', 'accelerator']),
    reason: 'contagem de entrada e acelerador de andamento lembrados',
  }),
]);


const SHA_PREFIX = 'sha256:';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toHex(bytes) {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

// sha256 do conteúdo: a identidade do blob é o HASH, não o nome do arquivo.
export function createSha256({ crypto: cryptoImpl = globalThis.crypto } = {}) {
  return async function sha256(bytes) {
    if (!cryptoImpl?.subtle || typeof cryptoImpl.subtle.digest !== 'function') return null;
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const hash = await cryptoImpl.subtle.digest('SHA-256', view);
    return toHex(new Uint8Array(hash));
  };
}

export function localFileSha(fileId) {
  return typeof fileId === 'string' && fileId.startsWith(SHA_PREFIX) && /^[0-9a-f]{64}$/.test(fileId.slice(SHA_PREFIX.length))
    ? fileId.slice(SHA_PREFIX.length)
    : null;
}

// ---------------------------------------------------------------- exercícios
// Um documento por exercício: `{ id, createdAt, updatedAt, session, metadata }`.
// O id do documento É o id do exercício — é ele que mantém o mesmo exercício
// com a mesma identidade nos dois navegadores (importar por conteúdo criaria
// uma cópia nova, e a cópia voltaria como um segundo exercício).
export function createExerciseAdapter(library) {
  if (!library) throw new TypeError('Adaptador de exercícios precisa da biblioteca.');
  const usesRemote = typeof library.applyRemoteEntry === 'function' && typeof library.removeRemoteEntry === 'function';

  function localEntries() {
    if (typeof library.entries === 'function') return library.entries();
    // Recurso existente e seguro: a exportação da biblioteca traz as entradas
    // inteiras. É o plano B quando o método direto não existe.
    //
    // `includeCourseContent` é OBRIGATÓRIO aqui: a partir da etapa 8 o mesmo
    // módulo sanitiza exercícios marcados como conteúdo de curso por padrão
    // (para link e exportação pública). O payload de sincronização é o
    // snapshot autenticado do usuário — NUNCA pode sair sanitizado, senão o
    // outro navegador receberia um exercício mutilado. A etapa 8 ignora o
    // argumento (a função ainda não o lê), então a chamada já é correta agora.
    const parsed = JSON.parse(library.exportLibrary({ includeCourseContent: true }));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  }

  function bodyOf(entry) {
    return {
      id: entry.id,
      createdAt: entry.createdAt ?? null,
      updatedAt: entry.updatedAt ?? null,
      session: entry.session,
      metadata: entry.metadata,
    };
  }

  function getDoc(id) {
    if (typeof library.get === 'function') {
      const entry = library.get(id);
      return entry ? { id, body: bodyOf(entry), updatedAt: entry.updatedAt ?? null } : null;
    }
    const found = localEntries().find(entry => entry.id === id);
    return found ? { id, body: bodyOf(found), updatedAt: found.updatedAt ?? null } : null;
  }

  return {
    collection: SYNC_COLLECTIONS.exercises,
    singleton: false,
    get supported() { return usesRemote; },
    unsupportedReason: usesRemote ? null : 'A biblioteca ainda não expõe a aplicação de documento remoto (ver patch da etapa 7).',
    // "Disponível" quer dizer: a listagem é AUTORITATIVA. Biblioteca corrompida
    // não é: nada é enviado nem removido a partir dela.
    available: () => library.status !== 'corrupt' && library.status !== 'unavailable',
    async list() {
      return localEntries().map(entry => ({ id: entry.id, body: bodyOf(entry), updatedAt: entry.updatedAt ?? null }));
    },
    async get(id) { return getDoc(id); },
    async apply({ id, body }) {
      if (!usesRemote) return { changed: false, body: null, skipped: 'unsupported' };
      if (!isObject(body) || !isObject(body.session)) return { changed: false, body: null, skipped: 'invalid' };
      library.applyRemoteEntry({ ...body, id });
      const current = getDoc(id);
      return { changed: true, body: current?.body ?? null };
    },
    async remove(id) {
      if (!usesRemote) return { changed: false, skipped: 'unsupported' };
      const removed = library.removeRemoteEntry(id);
      return { changed: removed === true, skipped: removed === true ? null : 'protected' };
    },
    subscribe(listener) {
      return typeof library.subscribe === 'function' ? library.subscribe(listener) : () => {};
    },
  };
}

// -------------------------------------------------------------------- cursos
// Corpo = envelope canônico `groovegoblin-course`. Aplicar é a REIMPORTAÇÃO
// (com reconciliação por URL da etapa 1), nunca uma sobrescrita crua.
export function createCourseAdapter(store) {
  if (!store) throw new TypeError('Adaptador de cursos precisa da loja de cursos.');
  function updatedAtOf(id) {
    return store.list().find(item => item.id === id)?.updatedAt ?? null;
  }
  function getDoc(id) {
    const exported = store.exportText(id);
    if (!exported.ok) return null;
    try {
      return { id, body: JSON.parse(exported.text), updatedAt: updatedAtOf(id) };
    } catch {
      return null;
    }
  }
  return {
    collection: SYNC_COLLECTIONS.courses,
    singleton: false,
    // IndexedDB indisponível ou em erro: a listagem não é autoritativa.
    available: () => store.persistent !== false && (store.errorCode ?? null) === null,
    async list() {
      const documents = [];
      for (const record of store.list()) {
        const document_ = getDoc(record.id);
        if (document_) documents.push(document_);
      }
      return documents;
    },
    async get(id) { return getDoc(id); },
    async apply({ id, body }) {
      if (!isObject(body) || body.course?.id !== id) return { changed: false, body: null, skipped: 'invalid' };
      const result = await store.importText(JSON.stringify(body), { source: 'servidor' });
      if (!result.ok) return { changed: false, body: null, skipped: result.code ?? 'rejected' };
      const current = getDoc(id);
      return { changed: true, body: current?.body ?? null };
    },
    // Lápide do servidor: o curso sai da biblioteca e o estado continua
    // guardado (é `removeCourse`, a mesma ação da interface).
    async remove(id) {
      const removed = await store.removeCourse(id);
      return { changed: removed === true };
    },
    subscribe(listener) {
      return typeof store.subscribe === 'function' ? store.subscribe(listener) : () => {};
    },
  };
}

// ------------------------------------------------------------ estado do curso
// Coleção separada da estrutura. Aplicar é `importSnapshot`, que faz UNIÃO:
// progresso, anotações, vínculos e intervalos só crescem.
export function createCourseStateAdapter(store) {
  if (!store) throw new TypeError('Adaptador de estado precisa da loja de cursos.');
  // O estado viaja como CONTEÚDO portátil: progresso (watched/skipped/notas/
  // vínculos/sugestões), lápides, intervalos de estudo, aula ativa e
  // preferências. Os carimbos de tempo — `createdAt`/`updatedAt` do estado, o de
  // cada aula e o de cada lápide — são de CADA navegador: a fusão preserva os
  // locais e reescreve os seus, então mandá-los faria os dois lados gravarem
  // bytes diferentes para o MESMO progresso e o documento subiria a cada ciclo,
  // sem fim. Nenhum progresso fica de fora; só o "quando" de cada máquina.
  function withoutStamp(record) {
    if (!isObject(record)) return record;
    const { updatedAt, ...rest } = record;
    return rest;
  }
  function portableState(state) {
    const { createdAt, updatedAt, lessons, removed, ...rest } = state;
    return {
      ...rest,
      lessons: Object.fromEntries(Object.entries(lessons ?? {}).map(([id, lesson]) => [id, withoutStamp(lesson)])),
      removed: (removed ?? []).map(entry => (isObject(entry?.state) ? { ...entry, state: withoutStamp(entry.state) } : entry)),
    };
  }
  function document_(state) {
    return { id: state.courseId, body: portableState(state), updatedAt: state.updatedAt ?? null };
  }
  function getDoc(id) {
    const state = store.snapshotAll().states.find(item => item.courseId === id) ?? null;
    return state ? document_(state) : null;
  }
  return {
    collection: SYNC_COLLECTIONS.courseStates,
    singleton: false,
    available: () => store.persistent !== false && (store.errorCode ?? null) === null,
    async list() {
      return store.snapshotAll().states.map(state => document_(state));
    },
    async get(id) { return getDoc(id); },
    async apply({ id, body }) {
      if (!isObject(body) || body.courseId !== id) return { changed: false, body: null, skipped: 'invalid' };
      const result = await store.importSnapshot({ records: [], states: [body] });
      if (!result.ok) return { changed: false, body: null, skipped: result.code ?? 'rejected' };
      const current = getDoc(id);
      return { changed: true, body: current?.body ?? null };
    },
    // Estado nunca é apagado por uma lápide remota: o progresso do usuário não
    // se perde por causa de uma remoção feita em outro navegador.
    async remove() {
      return { changed: false, skipped: 'protected' };
    },
    subscribe(listener) {
      return typeof store.subscribe === 'function' ? store.subscribe(listener) : () => {};
    },
  };
}

// ------------------------------------------------------------------- anexos
// Um documento por curso, no shape COMBINADO com o intake do servidor:
// `{ "refs": { "<refKey>": { sha256, size, kind, name, addedAt } } }` — nada
// além disso dentro do documento (o id do documento é o courseId).
// Os BYTES vivem só em `/api/blobs/:sha256`; o navegador guarda uma cópia
// apenas dos anexos marcados "manter offline".
export function createAttachmentAdapter(attachments, { sha256 = createSha256() } = {}) {
  if (!attachments) throw new TypeError('Adaptador de anexos precisa da loja de anexos.');
  const canAdopt = typeof attachments.adoptRemoteRef === 'function';
  const canDrop = typeof attachments.dropBlob === 'function';

  // Enumeração única de arquivos: uma passada, sem N leituras por referência.
  // Referência sem bytes locais (material que já vive no servidor) continua
  // entrando no documento: o hash está no próprio identificador do arquivo, e o
  // nome/tamanho/tipo vêm da referência — por isso o documento não muda quando
  // os bytes são liberados.
  async function scan() {
    const refs = attachments.listAll();
    const byFile = new Map();
    for (const ref of refs) {
      if (byFile.has(ref.fileId)) continue;
      const file = await attachments.getFile(ref.key);
      if (file) byFile.set(ref.fileId, file);
    }
    const byCourse = new Map();
    for (const ref of refs) {
      const file = byFile.get(ref.fileId) ?? null;
      let digest = localFileSha(ref.fileId);
      if (!digest) {
        if (!file) continue;
        try { digest = await sha256(new Uint8Array(await file.blob.arrayBuffer())); } catch { digest = null; }
      }
      if (!digest) continue;
      if (!byCourse.has(ref.courseId)) byCourse.set(ref.courseId, {});
      byCourse.get(ref.courseId)[ref.key] = {
        sha256: digest,
        size: file?.size ?? ref.size ?? null,
        kind: file?.kind ?? ref.kind ?? 'other',
        name: ref.name ?? file?.name ?? null,
        addedAt: ref.addedAt ?? file?.addedAt ?? null,
      };
    }
    const blobs = new Map();
    for (const [fileId, file] of byFile) {
      let digest = localFileSha(fileId);
      if (!digest) {
        try { digest = await sha256(new Uint8Array(await file.blob.arrayBuffer())); } catch { digest = null; }
      }
      if (!digest) continue;
      blobs.set(digest, { sha256: digest, size: file.size ?? file.blob.size ?? null, name: file.name ?? null, fileId, blob: file.blob });
    }
    return { byCourse, blobs };
  }

  // Campos que o documento carrega. Comparar os dois lados evita adoção à toa
  // e, principalmente, faz o `addedAt` convergir para o do servidor.
  function sameRefFields(existing, entry) {
    const same = (a, b) => (a ?? null) === (b ?? null);
    return same(existing.name, entry.name ?? null)
      && same(existing.size, entry.size ?? null)
      && same(existing.kind, entry.kind ?? 'other')
      && same(existing.addedAt, entry.addedAt ?? null);
  }

  async function getDoc(id) {
    const { byCourse } = await scan();
    return { id, body: { refs: byCourse.get(id) ?? {} }, updatedAt: null };
  }

  return {
    collection: SYNC_COLLECTIONS.courseAttachments,
    singleton: false,
    get supported() { return canAdopt; },
    unsupportedReason: canAdopt ? null : 'A loja de anexos ainda não expõe a adoção de referência remota (ver patch da etapa 7).',
    available: () => attachments.persistent !== false,
    scan,
    async list() {
      const { byCourse } = await scan();
      return [...byCourse.entries()].map(([id, refs]) => ({ id, body: { refs }, updatedAt: null }));
    },
    async get(id) { return getDoc(id); },
    async apply({ id, body }) {
      if (!isObject(body) || !isObject(body.refs)) return { changed: false, body: null, skipped: 'invalid' };
      if (!canAdopt) return { changed: false, body: null, skipped: 'unsupported' };
      let changed = false;
      for (const [key, entry] of Object.entries(body.refs)) {
        if (!isObject(entry) || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) continue;
        const existing = attachments.get(key);
        if (existing && localFileSha(existing.fileId) === entry.sha256) {
          // Mesmos BYTES: nada a baixar. Mas os campos que o documento carrega
          // (nome, tipo, tamanho, `addedAt`) podem ter mudado no servidor, e
          // adotá-los é o que faz os dois navegadores gravarem os MESMOS bytes.
          // Sem isso, o `addedAt` de cada máquina ficava diferente para o mesmo
          // material e o documento subia a cada ciclo, sem fim.
          if (sameRefFields(existing, entry)) continue;
          await attachments.adoptRemoteRef({
            key, sha256: entry.sha256, size: entry.size ?? null, kind: entry.kind ?? 'other',
            name: entry.name ?? null, addedAt: entry.addedAt ?? null,
          });
          changed = true;
          continue;
        }
        if (existing) continue; // divergência local: o motor trata como conflito, não aqui
        // A adoção é serializada na loja real (devolve promessa) e síncrona na
        // de mentira: esperar o resultado cobre as duas — sem isso, o motor
        // marcaria o documento como sincronizado antes da gravação.
        await attachments.adoptRemoteRef({
          key, sha256: entry.sha256, size: entry.size ?? null, kind: entry.kind ?? 'other',
          name: entry.name ?? null, addedAt: entry.addedAt ?? null,
        });
        changed = true;
      }
      const current = await getDoc(id);
      return { changed, body: current.body };
    },
    // Lápide remota do conjunto de anexos de um curso: ação explícita de
    // limpeza da própria loja (referências saem; bytes usados por outro curso
    // ficam).
    async remove(id) {
      const result = await attachments.clearCourse(id);
      return { changed: (result?.refs ?? 0) > 0 };
    },
    subscribe(listener) {
      return typeof attachments.subscribe === 'function' ? attachments.subscribe(listener) : () => {};
    },
    blobs: {
      async list() {
        const { blobs } = await scan();
        return [...blobs.values()].map(entry => ({ sha256: entry.sha256, size: entry.size, name: entry.name }));
      },
      async read(digest) {
        const { blobs } = await scan();
        const entry = blobs.get(digest);
        if (!entry) return null;
        try { return new Uint8Array(await entry.blob.arrayBuffer()); } catch { return null; }
      },
      localIds() {
        return attachments.listAll().map(ref => ({ refKey: ref.key, fileId: ref.fileId }));
      },
      // Só libera bytes de blob JÁ confirmado no servidor e NÃO marcado
      // "manter offline". Enquanto o envio não confirmar, os bytes ficam.
      async release(digests, { confirmed, pinned }) {
        if (!canDrop) return { released: 0, freedBytes: 0, skipped: 'unsupported' };
        const wanted = new Set(digests.filter(digest => confirmed.has(digest) && !pinned.has(digest)));
        if (wanted.size === 0) return { released: 0, freedBytes: 0, skipped: null };
        const { blobs } = await scan();
        let released = 0;
        let freedBytes = 0;
        for (const [digest, entry] of blobs) {
          if (!wanted.has(digest)) continue;
          const result = await attachments.dropBlob(entry.fileId);
          if (result?.dropped !== false) {
            released += 1;
            freedBytes += entry.size ?? 0;
          }
        }
        return { released, freedBytes, skipped: null };
      },
    },
  };
}

// ------------------------------------------------------------------- hoje
// Um documento: a fila do dia. `singleton`.
export function createTodayQueueAdapter(today, { version = 2 } = {}) {
  if (!today) throw new TypeError('Adaptador da fila precisa da loja de hoje.');
  const ID = 'default';
  // O documento é o CONTEÚDO da fila (os itens). O id e os carimbos da fila são
  // de CADA navegador: a fila nasce com id/horários próprios e `setItems`
  // reescreve `updatedAt` a cada aplicação. Mandá-los faria os dois lados
  // gravarem bytes diferentes para a MESMA fila — o documento subiria a cada
  // ciclo, para sempre, sem nenhuma mudança de conteúdo.
  function document_() {
    const queue = today.queue();
    if (!queue) return null;
    return {
      id: ID,
      body: { version, items: Array.isArray(queue.items) ? queue.items : [] },
      updatedAt: queue.updatedAt ?? null,
    };
  }
  return {
    collection: SYNC_COLLECTIONS.todayQueues,
    singleton: true,
    documentId: ID,
    owns: id => id === ID,
    available: () => true,
    async list() {
      const doc = document_();
      return doc ? [doc] : [];
    },
    async get(id) { return id === ID ? document_() : null; },
    async apply({ body }) {
      if (!isObject(body) || !Array.isArray(body.items)) return { changed: false, body: null, skipped: 'invalid' };
      today.setItems(body.items);
      const current = document_();
      return { changed: true, body: current?.body ?? null };
    },
    async remove() {
      return { changed: false, skipped: 'protected' };
    },
    subscribe(listener) {
      return typeof today.subscribe === 'function' ? today.subscribe(listener) : () => {};
    },
  };
}

// ----------------------------------------------------------------- rotinas
// Um documento: todas as rotinas nomeadas. O NOME é a identidade entre
// navegadores (`saveRoutine` atualiza pelo nome, sem duplicar homônimos), então
// ids locais diferentes nos dois lados não geram cópias.
export function createRoutinesAdapter(today, { version = 2 } = {}) {
  if (!today) throw new TypeError('Adaptador de rotinas precisa da loja de hoje.');
  const ID = 'all';
  // Nome + itens são a identidade e o conteúdo (`saveRoutine` atualiza pelo
  // nome). Id, createdAt e updatedAt são de cada navegador — a rotina é
  // recriada/atualizada localmente ao aplicar, com id e carimbos próprios — e
  // não viajam: ver a fila do dia (o documento subiria para sempre).
  function document_() {
    const routines = today.routines();
    const portable = routines
      .filter(routine => isObject(routine) && typeof routine.name === 'string' && Array.isArray(routine.items))
      .map(routine => ({ name: routine.name, items: routine.items }));
    const updatedAt = routines.reduce((newest, routine) => ((routine?.updatedAt ?? '') > newest ? routine.updatedAt : newest), '');
    return { id: ID, body: { version, routines: portable }, updatedAt: updatedAt || null };
  }
  return {
    collection: SYNC_COLLECTIONS.routines,
    singleton: true,
    documentId: ID,
    owns: id => id === ID,
    available: () => true,
    async list() { return [document_()]; },
    async get(id) { return id === ID ? document_() : null; },
    // União por nome: rotina remota com o mesmo nome atualiza a local; rotina
    // que só existe localmente continua, e sobe no envio seguinte.
    async apply({ body }) {
      if (!isObject(body) || !Array.isArray(body.routines)) return { changed: false, body: null, skipped: 'invalid' };
      let changed = false;
      for (const routine of body.routines) {
        if (!isObject(routine) || typeof routine.name !== 'string' || routine.name.trim() === '') continue;
        if (!Array.isArray(routine.items)) continue;
        today.saveRoutine(routine.name, routine.items);
        changed = true;
      }
      const current = document_();
      return { changed, body: current?.body ?? null };
    },
    async remove() {
      return { changed: false, skipped: 'protected' };
    },
    subscribe(listener) {
      return typeof today.subscribe === 'function' ? today.subscribe(listener) : () => {};
    },
  };
}

// ---------------------------------------------------------- formas (A3)
// O documento é exatamente `exportDocument()` da loja de formas
// (`{version, instruments:{bass4,bass5,guitar6}}`); aplicar é `importDocument`,
// que faz UNIÃO idempotente — forma igual não duplica, forma com o mesmo id e
// conteúdo diferente entra como forma nova. Nada é sobrescrito em silêncio, e
// uma lápide remota nunca apaga as formas do navegador.
export function createShapesAdapter(store) {
  if (!store) throw new TypeError('Adaptador de formas precisa da loja de formas.');
  const ready = () => store.status === 'ready';
  function document_() {
    return ready() ? { id: SHAPES_DOC_ID, body: store.exportDocument(), updatedAt: null } : null;
  }
  return {
    collection: SYNC_COLLECTIONS.forms,
    singleton: true,
    documentId: SHAPES_DOC_ID,
    owns: id => id === SHAPES_DOC_ID,
    available: ready,
    async list() {
      const doc = document_();
      return doc ? [doc] : [];
    },
    async get(id) {
      return id === SHAPES_DOC_ID ? document_() : null;
    },
    async apply({ body }) {
      if (!ready()) return { changed: false, body: null, skipped: 'unavailable' };
      if (!isObject(body) || !isObject(body.instruments)) return { changed: false, body: null, skipped: 'invalid' };
      let result = null;
      try { result = store.importDocument(body); } catch (cause) {
        return { changed: false, body: null, skipped: 'rejected', error: cause?.message ?? String(cause) };
      }
      const current = document_();
      return { changed: (result?.added ?? 0) + (result?.renamed ?? 0) > 0, body: current?.body ?? null, skipped: result?.ok === false ? 'partial' : null };
    },
    // Lápide remota não apaga formas: elas são do usuário e o documento é
    // união, não substituição.
    async remove() {
      return { changed: false, skipped: 'protected' };
    },
    subscribe(listener) {
      return typeof store.subscribe === 'function' ? store.subscribe(listener) : () => {};
    },
  };
}

// -------------------------------------------------- vínculos de forma (A5)
// Mesmo padrão, documento próprio (`{version, bindings:[…]}`) na MESMA coleção
// `forms`. A união preserva a escolha local: vínculo que já existe aqui não é
// trocado pelo do arquivo/servidor.
export function createShapeBindingsAdapter(store) {
  if (!store) throw new TypeError('Adaptador de vínculos precisa da loja de vínculos.');
  const ready = () => store.status === 'ready';
  function document_() {
    return ready() ? { id: BINDINGS_DOC_ID, body: store.exportDocument(), updatedAt: null } : null;
  }
  return {
    collection: SYNC_COLLECTIONS.forms,
    singleton: true,
    documentId: BINDINGS_DOC_ID,
    owns: id => id === BINDINGS_DOC_ID,
    available: ready,
    async list() {
      const doc = document_();
      return doc ? [doc] : [];
    },
    async get(id) {
      return id === BINDINGS_DOC_ID ? document_() : null;
    },
    async apply({ body }) {
      if (!ready()) return { changed: false, body: null, skipped: 'unavailable' };
      if (!isObject(body) || !Array.isArray(body.bindings)) return { changed: false, body: null, skipped: 'invalid' };
      let result = null;
      try { result = store.importDocument(body); } catch (cause) {
        return { changed: false, body: null, skipped: 'rejected', error: cause?.message ?? String(cause) };
      }
      const current = document_();
      return { changed: (result?.added ?? 0) > 0, body: current?.body ?? null, skipped: null };
    },
    async remove() {
      return { changed: false, skipped: 'protected' };
    },
    subscribe(listener) {
      return typeof store.subscribe === 'function' ? store.subscribe(listener) : () => {};
    },
  };
}

// ---------------------------------------------------------- preferências
// Um único documento com as seções portáteis. Leitura e escrita passam por um
// allowlist EXPLÍCITO de chave + campos: o resto do armazenamento (dispositivo,
// calibração, layout, mixer, Músicas, histórico) nunca é lido nem escrito.
// Aplicar MESCLA campo a campo dentro do JSON existente — nada de substituir o
// documento inteiro, e um JSON ilegível não é sobrescrito.
export function createPreferencesAdapter({ storage = globalThis.localStorage, sections = PREFERENCE_SECTIONS } = {}) {
  const ID = 'default';
  function readKey(key) {
    if (!storage || typeof storage.getItem !== 'function') return { ok: false, value: null };
    try {
      const raw = storage.getItem(key);
      if (raw === null || raw === undefined || raw === '') return { ok: true, value: {} };
      const parsed = JSON.parse(raw);
      if (!isObject(parsed)) return { ok: false, value: null };
      return { ok: true, value: parsed };
    } catch {
      return { ok: false, value: null };
    }
  }

  function project() {
    const body = { version: 1 };
    for (const section of sections) {
      const read = readKey(section.key);
      if (!read.ok) continue;
      const picked = {};
      for (const field of section.fields) {
        if (read.value[field] === undefined) continue;
        picked[field] = read.value[field];
      }
      if (Object.keys(picked).length > 0) body[section.id] = picked;
    }
    return body;
  }

  return {
    collection: SYNC_COLLECTIONS.preferences,
    singleton: true,
    documentId: ID,
    owns: id => id === ID,
    // Sem armazenamento legível não há listagem autoritativa.
    available: () => sections.every(section => readKey(section.key).ok),
    sections,
    async list() {
      const body = project();
      return Object.keys(body).length > 1 ? [{ id: ID, body, updatedAt: null }] : [];
    },
    async get(id) {
      if (id !== ID) return null;
      const body = project();
      return Object.keys(body).length > 1 ? { id: ID, body, updatedAt: null } : null;
    },
    async apply({ body }) {
      if (!isObject(body)) return { changed: false, body: null, skipped: 'invalid' };
      if (!storage || typeof storage.setItem !== 'function') return { changed: false, body: null, skipped: 'unavailable' };
      let changed = false;
      let readable = false;
      for (const section of sections) {
        const incoming = body[section.id];
        if (!isObject(incoming)) continue;
        const read = readKey(section.key);
        // JSON ilegível: não é sobrescrito (o módulo dono decide o que fazer).
        if (!read.ok) continue;
        readable = true;
        const next = { ...read.value };
        let touched = false;
        for (const field of section.fields) {
          if (incoming[field] === undefined) continue;
          if (JSON.stringify(next[field]) === JSON.stringify(incoming[field])) continue;
          next[field] = incoming[field];
          touched = true;
        }
        if (!touched) continue;
        try { storage.setItem(section.key, JSON.stringify(next)); } catch { continue; }
        changed = true;
      }
      // Nada pôde ser lido: o armazenamento não é utilizável agora — o motor
      // não pode tratar isso como "as preferências foram apagadas".
      if (!readable) return { changed: false, body: null, skipped: 'unavailable' };
      const current = project();
      return { changed, body: Object.keys(current).length > 1 ? current : null };
    },
    // Preferência removida no servidor não apaga a escolha local: o campo volta
    // a subir na próxima varredura.
    async remove() {
      return { changed: false, skipped: 'protected' };
    },
    // As lojas de preferência do app não expõem assinatura de mudança; a
    // alteração sobe na varredura seguinte (a cada poucos minutos, na volta da
    // rede e ao abrir).
    subscribe() { return () => {}; },
  };
}

// Compõe os portos do app. `extras` permite registrar coleções de outras etapas
// sem tocar neste arquivo.
export function buildSyncPorts({ library = null, courseStore = null, attachments = null, today = null, shapes = null, bindings = null, preferences = null, extras = [] } = {}) {
  const ports = [];
  if (library) ports.push(createExerciseAdapter(library));
  if (courseStore) {
    ports.push(createCourseAdapter(courseStore));
    ports.push(createCourseStateAdapter(courseStore));
  }
  if (attachments) ports.push(createAttachmentAdapter(attachments));
  if (today) {
    ports.push(createTodayQueueAdapter(today));
    ports.push(createRoutinesAdapter(today));
  }
  if (shapes) ports.push(createShapesAdapter(shapes));
  if (bindings) ports.push(createShapeBindingsAdapter(bindings));
  if (preferences) ports.push(createPreferencesAdapter(preferences));
  for (const extra of extras) {
    if (!extra?.collection || typeof extra.list !== 'function') throw new TypeError('Porto extra inválido.');
    ports.push(extra);
  }
  // Duas coleções podem ter portos diferentes (formas e vínculos moram em
  // `forms`), mas nenhum documento pode ter dois donos.
  const singletonKeys = new Set();
  const wholeCollections = new Set();
  for (const port of ports) {
    if (wholeCollections.has(port.collection)) throw new Error(`Coleção repetida nos portos de sincronização: ${port.collection}`);
    if (!port.singleton) {
      if ([...singletonKeys].some(key => key.startsWith(`${port.collection}|`))) {
        throw new Error(`Coleção repetida nos portos de sincronização: ${port.collection}`);
      }
      wholeCollections.add(port.collection);
      continue;
    }
    const key = `${port.collection}|${port.documentId ?? ''}`;
    if (singletonKeys.has(key)) throw new Error(`Documento repetido nos portos de sincronização: ${key}`);
    singletonKeys.add(key);
  }
  return ports;
}
