import { clearBar, copyBar, duplicateBar, materializeHarmony, repeatPhraseInNewBars } from './studio-bars.js';
import { mountRulerPlayback } from './studio-ruler-playback.js';
import { ticksPerBar, MAX_BARS } from './session.js';

// Native event dispatch may run a microtask checkpoint between listeners.
// A task runs only after the canonical data-path listener has applied the change.
export function offerBarIncrease(host, original, expectedBars) {
  return setTimeout(() => {
    const current = host.getSession();
    if (current === original || current.bars !== expectedBars || current.bars <= original.bars
      || current.meter.beats !== original.meter.beats || current.meter.unit !== original.meter.unit) return;
    host.notifyAction(`Sessão com ${current.bars} compassos`, 'Repetir a frase nos novos compassos', () => {
      const value = repeatPhraseInNewBars(host.getSession(), original);
      if (value.error) host.notify(value.error, true);
      else host.updateSession(value.patch, { notice: 'Frase repetida nos novos compassos; pausas e intensidades preservadas.' });
    });
  }, 0);
}

export function defaultCopyTarget(bars, source) {
  return bars < 2 ? null : source + 1 < bars ? source + 1 : 0;
}

export function mountStudioRuler(root, host) {
  const dialog = document.createElement('dialog'); dialog.id = 'bar-actions-dialog'; dialog.className = 'shortcuts-dialog';
  dialog.setAttribute('aria-labelledby', 'bar-actions-title');
  dialog.innerHTML = '<h2 id="bar-actions-title"></h2><p id="bar-actions-help"></p><div class="tool-row"><button id="duplicate-bar" type="button">Duplicar compasso (inserir após)</button><button id="clear-bar" type="button">Limpar este compasso</button><label>Copiar para o compasso<select id="copy-bar-target"></select></label><button id="copy-bar" type="button">Copiar sem substituir</button></div><button id="materialize-chords" type="button" hidden>Materializar daqui até o fim da sessão</button><button id="bar-actions-close" type="button">Fechar</button>';
  root.append(dialog);
  const $ = id => dialog.querySelector(`#${id}`);
  let selectedBar = 0; let focus = null;
  function close() { dialog.close(); }
  dialog.addEventListener('close', () => { if (focus?.isConnected) focus.focus({ preventScroll: true }); });
  $('bar-actions-close').addEventListener('click', close);
  function commit(operation, notice) {
    const session = host.getSession(); const value = operation(session);
    if (value.error) { host.notify(value.error, true); return; }
    close();
    if (host.updateSession(value.patch, { notice })) { host.setEditorSelection(null); host.selectionChanged?.(); }
  }
  $('duplicate-bar').addEventListener('click', () => commit(session => duplicateBar(session, selectedBar), `Compasso ${selectedBar + 1} duplicado: cópia inserida após ele, posteriores deslocados. Acordes habilitados materializados; sustentações na inserção divididas, sem perder trechos.`));
  $('clear-bar').addEventListener('click', () => commit(session => clearBar(session, selectedBar), `Compasso ${selectedBar + 1} limpo; sustentações fora dele preservadas.`));
  $('copy-bar').addEventListener('click', () => {
    const target = $('copy-bar-target').value;
    if (target === '') { host.notify('Escolha um compasso de destino.', true); return; }
    commit(session => copyBar(session, selectedBar, Number(target)), `Compasso ${selectedBar + 1} copiado para ${Number(target) + 1} sem substituir dados.`);
  });
  $('materialize-chords').addEventListener('click', () => commit(session => materializeHarmony(session, selectedBar), 'Repetições harmônicas materializadas; acordes e pausas preservados.'));
  function open(bar, anchor, ghost = false) {
    selectedBar = bar; focus = anchor;
    $('bar-actions-title').textContent = ghost ? 'Repetição automática de acordes' : `Compasso ${bar + 1}`;
    $('bar-actions-help').textContent = ghost ? 'Esta ocorrência vem do ciclo harmônico. Materializar permite editar daqui até o fim sem mudar o padrão anterior. Todas as ocorrências anteriores são preservadas, inclusive pausas.' : `Inclui a frase e, quando habilitados, os acordes. Duplicar insere uma cópia logo após, deslocando os compassos seguintes, loop e forma (limite: ${MAX_BARS}); os acordes ficam explícitos para preservar cada ocorrência. Sustentações na inserção são divididas sem perder seus trechos. Copiar acrescenta apenas o trecho dentro do compasso e recusa sobreposições. Limpar remove só o trecho deste compasso.`;
    const target = $('copy-bar-target'); target.replaceChildren();
    for (let index = 0; index < host.getSession().bars; index++) {
      if (index === bar) continue;
      const option = document.createElement('option'); option.value = index; option.textContent = String(index + 1); target.append(option);
    }
    const destination = defaultCopyTarget(host.getSession().bars, bar);
    target.value = destination === null ? '' : String(destination);
    for (const id of ['duplicate-bar', 'clear-bar', 'copy-bar']) $(id).hidden = ghost;
    target.closest('label').hidden = ghost; $('copy-bar').disabled = !target.options.length;
    $('materialize-chords').hidden = !ghost;
    dialog.showModal();
  }
  const ruler = document.getElementById('beat-labels');
  const playback = mountRulerPlayback(ruler, host);
  ruler.addEventListener('contextmenu', event => {
    const bar = event.target.closest('[data-bar]'); if (!bar) return;
    event.preventDefault(); open(Number(bar.dataset.bar), ruler);
  });
  ruler.addEventListener('keydown', event => {
    if (event.target !== ruler) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10') || event.key === 'Enter') {
      event.preventDefault();
      const bar = playback.selectedBar();
      playback.reveal(bar * ticksPerBar(host.getSession()));
      open(bar, ruler);
    }
  });
  let pendingOffer = null;
  document.getElementById('bars').addEventListener('change', event => {
    clearTimeout(pendingOffer);
    pendingOffer = offerBarIncrease(host, host.getSession(), Number(event.target.value));
  });
  return { offerMaterialize: (bar, anchor) => open(bar, anchor, true), render: playback.render, cancelDrag: playback.cancelDrag };
}
