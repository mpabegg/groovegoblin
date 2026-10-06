// Integração da tela de resultado com a aba Treinar do app: ocupa o lugar da
// área de toque depois de um treino concluído e traduz atalhos em ações.
import { mountResult, sessionOwner } from './result-view.js';

// O dono do treino é decidido no INÍCIO: a frase da sessão (refeita a partir da
// sessão atual) ou um exercício à parte (a cópia exata que foi treinada). O
// resultado nunca volta a olhar a seleção corrente para decidir o dono.
export function trainingOwner(practiceSession, currentSession) {
  return practiceSession && practiceSession.extensions?.practice?.source !== 'session'
    ? { kind: 'exercise', snapshot: structuredClone(practiceSession) }
    : sessionOwner(currentSession);
}

function editing(target) {
  return target instanceof Element && (target.isContentEditable || !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable=false])'));
}

// host: getSession, isBusy, updateSession, retry, train, resultNote(session) e,
// opcionalmente, captureRunContext(session, { source, objective }) /
// recordRun(context, detail) para a biblioteca guardar a execução.
export function mountTrainingResult(host, { comparisons } = {}) {
  const $ = id => document.getElementById(id);
  // A área de treino (toque, opções de toque, partitura da frase, ajustes do
  // treino) sai de cena enquanto o resultado ocupa o lugar dela; o painel do
  // treinador também fica oculto só enquanto o resultado está aberto.
  const covered = ['practice-rhythm-score', 'train-pad', 'input-options', 'training-options', 'practice-mount'].map($);
  let owner = null;
  let context = null;
  const view = mountResult($('training-result'), {
    ...host,
    onVisibility: visible => { for (const node of covered) node.hidden = visible; },
    closed: () => $('train')?.focus({ preventScroll: true }),
    calibrate() {
      if ($('input-configure')?.getAttribute('aria-expanded') !== 'true') $('input-configure')?.click();
      const details = $('input-calibration'); if (details) details.open = true;
      $('input-calibrate')?.focus({ preventScroll: false });
    },
  }, { comparisons });

  window.addEventListener('keydown', event => {
    if (!view.visible || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.body.dataset.intent !== 'practice' || editing(event.target) || document.querySelector('dialog[open]')) return;
    const kind = event.key === 'Enter' ? 'retry' : event.key.toLowerCase() === 'l' ? 'loop' : event.key === '-' ? 'slower' : event.key === '+' ? 'faster' : null;
    if (!kind) return;
    // Enter num controle focado mantém a ativação nativa desse controle.
    if (kind === 'retry' && event.target instanceof Element && event.target.closest('button, a[href], summary, [role=button], [role=tab]')) return;
    if (view.act(kind)) event.preventDefault();
  });

  return {
    view,
    began(practiceSession) {
      owner = trainingOwner(practiceSession, host.getSession());
      const snapshot = owner.kind === 'exercise' ? owner.snapshot : host.getSession();
      context = host.captureRunContext?.(snapshot, {
        source: owner.kind === 'exercise' ? owner.snapshot.extensions?.practice?.source ?? 'generated' : 'session',
        objective: owner.kind === 'exercise' ? owner.snapshot.extensions?.practice?.objective ?? null : null,
      }) ?? null;
      view.clear();
    },
    finished({ session, results, focus = false }) {
      view.show({ session, results, owner: owner ?? sessionOwner(host.getSession()), note: host.resultNote?.(session) ?? '', key: context?.comparisonKey ?? null });
      if (context) host.recordRun?.(context, { session, results });
      owner = null; context = null;
      if (focus) { view.focus(); $('training-result').scrollIntoView({ block: 'nearest', behavior: 'instant' }); }
    },
    render: () => view.render(),
    clear: () => view.clear(),
  };
}
