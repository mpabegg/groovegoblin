// Serviços de aplicação que o `main.js` monta em UMA linha (etapa 7).
//
// O `main.js` tem teto de linhas e não pode crescer. Este módulo existe para
// que a costura toda (uso offline + sincronização + gancho da conversão no
// servidor) caiba na troca de uma linha já existente:
//
//   - import { setupOffline } from './offline.js';
//   + import { mountAppServices, appImportNodes } from './app-services.js';
//
//   -setupOffline({ isBusy: ..., canReload: ..., notify: message });
//   +mountAppServices({ library, document, notify: message, download, isBusy: ..., canReload: ..., onReady: () => libraryView.render() });
//
//   -  library, openExercise, notify: message, download, openExerciseHistory,
//   +  library, openExercise, notify: message, download, openExerciseHistory, serverImport: appImportNodes,
//
// Nenhuma linha nova: as três linhas mudam de conteúdo, o total continua
// igual. `installSync` resolve as lojas compartilhadas sozinho; o único dado
// que precisa vir daqui é a biblioteca de exercícios (instância do main) e os
// retornos de chamada que o main já tem.

import { setupOffline } from './offline.js';
import { installSync } from './sync-wire.js';

let current = null;

// Gancho lido pela vista Cursos (`host.serverImport`): devolve os nós da
// conversão no servidor quando a montagem terminou, e lista vazia antes disso.
// Sem servidor, a lista continua vazia e nada aparece na tela.
export function appImportNodes() {
  return current?.convert ? current.convert.nodes : [];
}

// Marcação "manter offline" (B4, item 226): o app marca no motor de
// sincronização os bytes que o usuário escolheu guardar no navegador, e é isso
// que impede a liberação automática dos bytes depois de confirmados no
// servidor. O objeto é estável e resolve o motor na hora do uso: a montagem da
// sincronização é assíncrona, e um `null` capturado cedo desligaria a ação para
// sempre. Sem servidor, `available()` é falso e nenhum controle aparece.
export function appPins() {
  const engine = () => (current && typeof current.engine?.pinAttachment === 'function' ? current.engine : null);
  return {
    available: () => engine() !== null,
    has: sha256 => Boolean(engine() && typeof sha256 === 'string'
      && current.engine.pinned().some(entry => entry.sha256 === sha256)),
    pin(sha256, meta = {}) { const target = engine(); return target ? target.pinAttachment(sha256, meta) : false; },
    unpin(sha256) { const target = engine(); return target ? target.unpinAttachment(sha256) : false; },
  };
}

export function mountAppServices({
  document: doc = globalThis.document ?? null,
  isBusy = () => false,
  canReload = () => true,
  notify = () => {},
  library = null,
  download = null,
  onReady = null,
  installOptions = {},
} = {}) {
  const disposeOffline = setupOffline({ isBusy, canReload, notify });
  void installSync({
    ...installOptions,
    library,
    document: doc,
    notify,
    download,
    onReady(sync) {
      current = sync;
      if (typeof onReady === 'function') onReady(sync);
    },
  }).catch(error => {
    // Falha ao montar a sincronização não pode derrubar o app: ele continua
    // funcionando como site local.
    notify(`Sincronização indisponível: ${error?.message ?? error}`, true);
  });
  return {
    get sync() { return current; },
    dispose() {
      disposeOffline?.();
      current?.destroy();
      current = null;
    },
  };
}
