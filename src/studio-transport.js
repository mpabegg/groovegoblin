const $ = id => document.getElementById(id);
const editingTarget = target => target instanceof Element
  && (target.isContentEditable || !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable=false])'));
const dialogOpen = () => !!document.querySelector('dialog[open], [role=dialog][aria-modal=true]');

// Um só botão atende o transporte do Estúdio e a parada global nas outras áreas.
export function mountStudioTransport(host) {
  const play = $('play');
  const home = play.parentElement;
  const next = play.nextSibling;
  const globalSlot = $('global-transport');
  const dialog = $('shortcuts-dialog');
  let previousFocus = null;
  let rendered = null;

  function toggle() {
    if (host.getState().active) host.stop();
    else host.play();
  }
  function render() {
    const state = host.getState();
    const studio = document.body.dataset.intent === 'studio';
    if (rendered && rendered.studio === studio && rendered.active === state.active
      && rendered.locked === state.locked && rendered.canUndo === state.canUndo && rendered.canRedo === state.canRedo) return;
    rendered = { studio, active: state.active, locked: state.locked, canUndo: state.canUndo, canRedo: state.canRedo };
    const parent = studio ? home : globalSlot;
    if (play.parentElement !== parent) {
      const focused = document.activeElement === play;
      if (studio) home.insertBefore(play, next); else globalSlot.append(play);
      if (focused && (studio || state.active)) play.focus({ preventScroll: true });
    }
    play.hidden = !studio && !state.active;
    play.disabled = false; // Uma preparação pendente também pode ser interrompida.
    play.textContent = state.active ? 'Parar' : 'Tocar';
    play.setAttribute('aria-label', state.active ? 'Parar todo o som' : 'Tocar sessão');
    play.title = state.active ? 'Parar todo o som (Esc)' : 'Tocar sessão (Espaço)';
    play.classList.toggle('is-playing', state.active);
    $('undo').disabled = state.locked || !state.canUndo;
    $('redo').disabled = state.locked || !state.canRedo;
    $('undo').title = state.locked ? 'Pare a reprodução antes de desfazer' : !state.canUndo ? 'Nenhuma alteração para desfazer' : 'Desfazer (Ctrl+Z)';
    $('redo').title = state.locked ? 'Pare a reprodução antes de refazer' : !state.canRedo ? 'Nenhuma alteração para refazer' : 'Refazer (Ctrl+Shift+Z)';
  }
  function position({ position, pending, ticksPerBar, repetitions }) {
    const text = position.mode === 'idle' ? pending ? 'Preparando…' : 'Pronto'
      : `${position.mode === 'countin' ? 'Entrada' : position.mode === 'train' ? 'Treino' : 'Loop'} · compasso ${position.bar ?? Math.floor((position.tick ?? 0) / ticksPerBar) + 1} · tempo ${position.beat ?? 1}${position.mode === 'train' ? ` · ${position.repetition}/${repetitions}` : ''}`;
    if ($('position-text').textContent !== text) $('position-text').textContent = text;
  }
  function openShortcuts() {
    if (dialogOpen()) return;
    previousFocus = document.activeElement;
    dialog.showModal();
  }
  play.addEventListener('click', toggle);
  $('undo').addEventListener('click', () => host.travelHistory('undo'));
  $('redo').addEventListener('click', () => host.travelHistory('redo'));
  $('shortcuts-open').addEventListener('click', openShortcuts);
  $('shortcuts-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); host.stop(); dialog.close(); });
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('keyup', event => event.stopPropagation());

  // Esc precisa chegar à parada mesmo quando uma ajuda modal isola as teclas.
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    host.stop();
    if (document.body.dataset.intent === 'studio') host.deselect?.();
    if (dialog.open) { event.preventDefault(); dialog.close(); }
  }, { capture: true });
  window.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.key === 'Escape' || editingTarget(event.target) || dialogOpen()) return;
    if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); if (!event.repeat) openShortcuts(); return;
    }
    const state = host.getState();
    if (document.body.dataset.intent !== 'studio') return;
    if (event.code === 'Space' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (state.training) return;
      // Espaço nos controles mantém sua ativação nativa; notas/células são o editor.
      if (event.target instanceof Element && event.target.closest('button:not(.note):not(.cell), a, summary, [role=button], [role=tab]')) return;
      event.preventDefault(); if (!event.repeat) toggle(); return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); host.travelHistory(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo'); return;
    }
    if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); host.removeSelected(); }
  });
  return { render, position };
}
