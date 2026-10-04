export function setupOffline({ isBusy = () => false, canReload = () => true, notify = () => {} } = {}) {
  const container = document.getElementById('offline-status');
  if (!container) return () => {};
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  const prepare = document.createElement('button');
  prepare.type = 'button';
  prepare.textContent = 'Preparar uso offline';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.textContent = 'Aplicar atualização';
  apply.hidden = true;
  container.replaceChildren(status, document.createTextNode(' '), prepare, document.createTextNode(' '), apply);
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    status.textContent = 'Uso offline requer HTTPS ou localhost e suporte a service worker.';
    prepare.hidden = true;
    return () => {};
  }
  let registration = null;
  let reloadRequested = false;
  let reloadDeferred = false;
  let preparing = false;
  let disposed = false;
  const message = text => { if (!disposed) status.textContent = text; };
  const unsavedWarning = 'A sessão atual está só na memória. Salve-a antes de atualizar, ou exporte uma cópia e recarregue manualmente.';
  function refresh() {
    if (disposed) return;
    const ready = Boolean(registration?.active);
    apply.hidden = !registration?.waiting && !reloadDeferred;
    apply.textContent = reloadDeferred ? 'Recarregar versão atualizada' : 'Aplicar atualização';
    prepare.textContent = ready ? 'Verificar atualização offline' : 'Preparar uso offline';
    if (reloadDeferred) message(canReload() ? 'Versão atualizada. Pare a reprodução ou o treino e recarregue quando estiver pronto.' : unsavedWarning);
    else if (registration?.waiting) message('Nova versão pronta. A aplicação só recarrega ao aplicar, com o transporte parado.');
    else if (ready) message(navigator.onLine ? 'Aplicação disponível offline neste navegador.' : 'Sem conexão · usando a cópia local.');
    else message('Prepare a aplicação uma vez conectado para abrir também sem internet.');
  }
  function watch(worker) {
    if (!worker) return;
    const changed = () => {
      if (worker.state === 'installed' || worker.state === 'activated') refresh();
      else if (worker.state === 'redundant') message('Não foi possível preparar esta versão. Sua cópia anterior foi preservada; tente novamente conectado.');
    };
    worker.addEventListener('statechange', changed);
    changed();
  }
  function observe(value) {
    registration = value;
    registration.addEventListener('updatefound', () => watch(registration.installing));
    watch(registration.installing);
    refresh();
  }
  const scope = new URL('../', import.meta.url).href;
  navigator.serviceWorker.getRegistration(scope).then(value => {
    if (!disposed && value?.scope === scope && !registration) observe(value);
  }).catch(() => message('Não foi possível consultar a instalação offline.'));
  prepare.addEventListener('click', async () => {
    if (preparing) return;
    preparing = true;
    prepare.disabled = true;
    message('Baixando os recursos da aplicação. Seus arquivos de áudio continuam privados.');
    try {
      if (registration) await registration.update();
      else observe(await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope, updateViaCache: 'none' }));
      if (!registration.installing) refresh();
    } catch (error) {
      message(`Não foi possível preparar o modo offline: ${error.message}`);
      notify('Falha ao preparar o modo offline. Verifique a conexão e tente novamente.', true);
    } finally {
      preparing = false;
      prepare.disabled = false;
    }
  });
  apply.addEventListener('click', () => {
    if (isBusy()) {
      notify('Pare a reprodução ou o treino antes de aplicar a atualização.', true);
      return;
    }
    if (!canReload()) { notify(unsavedWarning, true); return; }
    if (reloadDeferred) { window.location.reload(); return; }
    if (!registration?.waiting) return;
    reloadRequested = true;
    prepare.disabled = true;
    apply.disabled = true;
    message('Aplicando a atualização…');
    registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
  });
  const controllerChanged = () => {
    const saved = canReload();
    if (reloadRequested && !isBusy() && saved) window.location.reload();
    else {
      if (reloadRequested) {
        reloadDeferred = true;
        prepare.disabled = false;
        apply.disabled = false;
        if (!saved) notify(unsavedWarning, true);
        else notify('Atualização pronta; a operação em curso foi preservada. Pare e recarregue quando estiver pronto.');
      }
      refresh();
    }
  };
  navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
  window.addEventListener('online', refresh);
  window.addEventListener('offline', refresh);
  refresh();
  return () => {
    disposed = true;
    navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
    window.removeEventListener('online', refresh);
    window.removeEventListener('offline', refresh);
  };
}
