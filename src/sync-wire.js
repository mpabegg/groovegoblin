// Composição da sincronização (etapa 7 · B4).
//
// Um único ponto de montagem: pega a biblioteca de exercícios e as lojas
// compartilhadas (cursos, anexos, Hoje), monta cliente, fila durável, estado,
// motor, linha de status e a conversão no servidor. O `main.js` só chama isto e
// passa o resultado adiante — nenhuma crescente de código lá.
//
// Nada aqui é obrigatório: sem IndexedDB, sem localStorage ou sem servidor, o
// que existe continua funcionando e o que falta simplesmente não aparece.

import { createServerClient } from './server-client.js';
import { createSyncOutbox } from './sync-outbox.js';
import { createSyncState } from './sync-store.js';
import { buildSyncPorts } from './sync-adapters.js';
import { createSyncEngine } from './sync-engine.js';
import { mountSyncStatus } from './sync-status.js';
import { createServerConvert } from './course-convert-server.js';
import { sharedCourseStore } from './course-store.js';
import { sharedAttachmentStore } from './course-attachments.js';

function findContainer(doc, selector) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  try { return doc.querySelector(selector); } catch { return null; }
}

// A loja de Hoje é pedida por import dinâmico: a instância única
// (`sharedTodayStore`) entra junto com o patch de `today-store.js`. Sem ela, a
// sincronização continua funcionando — só a fila do dia e as rotinas ficam de
// fora, como qualquer outra coleção ausente.
async function resolveTodayStore(provided, missing) {
  if (provided) return provided;
  return resolveShared('./today-store.js', 'sharedTodayStore', 'Fila do dia e rotinas', missing);
}

// Módulos de outras etapas entram por import dinâmico do caminho REAL: as
// formas (A3) e os vínculos (A5) vivem em `src/` depois do merge. Ausência não
// vira substituto nenhum — vira AVISO: a coleção correspondente fica de fora, e
// a linha de Ajuda diz exatamente qual módulo não foi encontrado (nada é
// omitido em silêncio, nenhum stub entra no lugar).
async function resolveShared(path, exportName, label, missing) {
  try {
    const module = await import(path);
    if (typeof module?.[exportName] !== 'function') {
      missing.push(`${label} fora da sincronização: ${path} não exporta ${exportName}.`);
      return null;
    }
    const value = module[exportName]();
    return value && typeof value.then === 'function' ? await value : value;
  } catch (cause) {
    missing.push(`${label} fora da sincronização: ${path} indisponível (${cause?.message ?? cause}).`);
    return null;
  }
}

export async function installSync({
  library = null,
  todayStore = null,
  shapesStore = null,
  bindingStore = null,
  preferences = null,
  extraPorts = [],
  storage = globalThis.localStorage ?? null,
  location = globalThis.location ?? null,
  document: doc = globalThis.document ?? null,
  notify = () => {},
  download = null,
  helpContainer = null,
  headerContainer = null,
  intervalMs = undefined,
  onReady = () => {},
  start = true,
} = {}) {
  const base = location?.href ? new URL('.', location.href).href : null;
  const client = createServerClient({ base, requestOrigin: null });
  const outbox = createSyncOutbox({ storage });
  const state = createSyncState({ storage });

  const missing = [];
  const [courseStore, attachments, today, shapes, bindings] = await Promise.all([
    sharedCourseStore().catch(() => null),
    sharedAttachmentStore().catch(() => null),
    resolveTodayStore(todayStore, missing),
    shapesStore ?? resolveShared('./fingering-shapes.js', 'sharedFingeringShapeStore', 'Formas', missing),
    bindingStore ?? resolveShared('./course-shape-binding.js', 'sharedShapeBindingStore', 'Vínculos de forma', missing),
  ]);
  for (const message of missing) notify(message, true);

  const ports = buildSyncPorts({
    library, courseStore, attachments, today, shapes, bindings,
    preferences: preferences ?? { storage },
    extras: extraPorts,
  });
  const engine = createSyncEngine({
    client, ports, outbox, state,
    document: doc,
    notify,
    initialWarnings: missing,
    ...(intervalMs === undefined ? {} : { intervalMs }),
  });

  const help = helpContainer ?? findContainer(doc, '#app-menu .app-menu-content');
  const header = headerContainer ?? findContainer(doc, '.masthead-actions');
  const status = help
    ? mountSyncStatus({ engine, helpContainer: help, headerContainer: header, document: doc, notify, download })
    : null;

  const convert = courseStore && doc
    ? createServerConvert({ client, store: courseStore, document: doc, notify })
    : null;

  if (start) void engine.start().catch(() => {});

  const sync = {
    client, outbox, state, engine, status, convert, ports,
    stores: { courseStore, attachments, today, shapes, bindings },
    destroy() { engine.stop(); status?.destroy(); convert?.destroy(); },
  };
  onReady(sync);
  return sync;
}
