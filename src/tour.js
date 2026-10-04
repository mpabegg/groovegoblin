// Tour guiado "Como usar": um <dialog> modal nativo que apenas ensina.
// Não toca som, não altera a sessão nem o histórico; ao sair, devolve aba,
// painéis abertos, modo de foco, rolagem e foco exatamente como estavam.

export const TOUR_STORAGE_KEY = 'groovegoblin:tour:v1';

const STEPS = [
  {
    tab: 'tab-practice', target: '.intentions',
    title: 'Cinco intenções, uma sessão',
    body: 'Escolha o que quer fazer: Praticar, Banda, Explorar, Repertório ou Percurso. Todas as abas compartilham a mesma sessão — frase, banda, treino e mixer — e tudo fica neste navegador.',
  },
  {
    tab: 'tab-practice', target: '.performance .transport',
    title: 'Transporte e andamento',
    body: '“Ouvir em loop” toca o arranjo completo; “Começar treino” faz a contagem de entrada e repete o loop da frase para você tocar junto. Ajuste o BPM (em semínimas) e o metrônomo. “Parar” ou Esc interrompem.',
  },
  {
    tab: 'tab-practice', target: '#train-pad',
    title: 'Área de toque do treino',
    body: 'Durante o treino, pressione no ataque e solte no término de cada nota — com a barra de espaço ou segurando aqui. O GrooveGoblin não grava microfone nem instrumento: avalia só esses toques de teclado ou tela.',
  },
  {
    tab: 'tab-practice', open: ['studio-editor'], target: '#studio-editor .grid-scroll',
    title: 'Grade da frase',
    body: 'Em “Editar frase e organizar sessões”: clique numa célula para criar uma nota, arraste para mover e puxe a borda direita para mudar a duração. Abaixo, bateria e partitura rítmica acompanham cada mudança; Ctrl+Z desfaz.',
  },
  {
    tab: 'tab-practice', open: ['studio-editor'], target: '#studio-editor .session-library',
    title: 'Guardar, exportar e compartilhar',
    body: 'Guarde sessões completas na biblioteca local, exporte ou importe um arquivo .json, ou gere um link que carrega a sessão inteira sem servidor. Quem recebe vê uma prévia antes de aplicar.',
  },
  {
    tab: 'tab-band', target: '#panel-band > .panel:first-child',
    title: 'Banda e harmonia',
    body: 'Escolha seu papel e a banda deixa esse instrumento para você. Baixo e bateria seguem estilos e densidades; a harmonia aceita progressões funcionais geradas ou acordes escritos à mão, com inversões.',
  },
  {
    tab: 'tab-band', target: '#mixer',
    title: 'Mixer da sessão',
    body: 'Volume e silenciamento de frase, metrônomo, bateria, harmonia e baixo. Dá para ajustar durante a reprodução, e o mixer viaja junto com a sessão e o link.',
  },
  {
    tab: 'tab-explore', target: '#playground-mount',
    title: 'Explorar',
    body: 'Jogos de ouvido e ritmo: dueto de chamado e resposta, a masmorra do clique sumido, o chefe que devora os espaços e transformações da frase. Nada toca sozinho — todo som começa de um botão seu.',
  },
  {
    tab: 'tab-repertoire', target: '#repertoire-mount',
    title: 'Repertório',
    body: 'Importe arquivos de áudio ou MIDI que você já tem: marque trechos A–B, mude velocidade sem mudar a altura, analise pulsos e acordes, compare takes e monte setlists. O processamento é local.',
  },
  {
    tab: 'tab-journey', target: '#journey-mount',
    title: 'Percurso',
    body: 'Acompanhe aproveitamento e BPM ao longo dos treinos concluídos e as revisões espaçadas agendadas. Para rever este tour, use “Como usar” no topo a qualquer momento.',
  },
];

const MARGIN = 12;
const GAP = 14;
const PAD = 8;
const MOBILE = '(max-width: 640px)';

function readFlag() {
  try { return localStorage.getItem(TOUR_STORAGE_KEY); } catch { return null; }
}
function writeFlag(status) {
  try { localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify({ status, at: new Date().toISOString() })); } catch { /* memória basta nesta visita */ }
}
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key in node && !key.includes('-')) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

/**
 * host: { activateTab(id), isBusy(), notify(text, error), canAutoOpen() }
 */
export function mountTour(button, host) {
  let seenThisVisit = readFlag() !== null;
  let state = null;

  const title = el('h2', { id: 'tour-title', className: 'tour-title', tabIndex: -1 });
  const body = el('p', { id: 'tour-body', className: 'tour-body' });
  const count = el('span', { className: 'tour-count', 'aria-hidden': 'true' });
  const bar = el('span', { className: 'tour-progress-fill' });
  const progress = el('div', { className: 'tour-progress', role: 'progressbar', 'aria-label': 'Progresso do tour', 'aria-valuemin': '1', 'aria-valuemax': String(STEPS.length) }, bar);
  const live = el('p', { className: 'tour-live', 'aria-live': 'polite' });
  const skip = el('button', { type: 'button', className: 'tour-skip', text: 'Pular tour' });
  const back = el('button', { type: 'button', text: 'Voltar' });
  const next = el('button', { type: 'button', className: 'primary' });
  const card = el('div', { className: 'tour-card' },
    el('div', { className: 'tour-meta' }, el('span', { className: 'eyebrow', text: 'COMO USAR' }), count),
    progress, title, body, live,
    el('div', { className: 'tour-actions' }, skip, el('span', { className: 'tour-spacer' }), back, next));
  const spot = el('div', { className: 'tour-spot', 'aria-hidden': 'true' });
  const dialog = el('dialog', { className: 'tour', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-body' }, spot, card);
  document.body.append(dialog);

  // Isolamento: nenhuma tecla do tour chega aos atalhos globais (Esc para o
  // transporte, Espaço toca no treino, atalhos do editor e do repertório).
  dialog.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); finish('skipped'); return; }
    if (event.key === 'Tab') {
      const first = skip;
      const last = next;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === title)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
      return;
    }
    if (event.target === skip) return;
    if (event.key === 'ArrowRight' && !event.repeat) { event.preventDefault(); go(1); }
    if (event.key === 'ArrowLeft' && !event.repeat) { event.preventDefault(); go(-1); }
  });
  for (const type of ['keyup', 'keypress']) dialog.addEventListener(type, event => event.stopPropagation());
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish('skipped'); });
  dialog.addEventListener('close', () => finish('skipped'));
  skip.addEventListener('click', () => finish('skipped'));
  back.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  button.addEventListener('click', () => start({ auto: false }));

  function start({ auto }) {
    if (state) return false;
    if (host.isBusy()) {
      host.notify('Pare a reprodução ou o processamento do repertório antes de abrir o tour “Como usar”.', true);
      return false;
    }
    const tab = document.querySelector('.intentions [role=tab][aria-selected=true]');
    state = {
      auto, index: 0, token: 0, raf: 0, settleTimer: 0, settling: false, animations: [],
      restore: {
        tab: tab?.id ?? 'tab-practice',
        open: Object.fromEntries(['studio-editor', 'inspiration'].map(id => [id, document.getElementById(id)?.open ?? false])),
        focusMode: document.body.classList.contains('performance-focus'),
        x: scrollX, y: scrollY,
        gridLeft: document.querySelector('.grid-scroll')?.scrollLeft ?? 0,
        focus: document.activeElement,
      },
    };
    if (auto) { seenThisVisit = true; writeFlag('shown'); }
    // O foco na execução esconde as abas; só a vista muda, não a sessão.
    document.body.classList.remove('performance-focus');
    document.documentElement.classList.add('tour-active');
    addEventListener('resize', onViewport);
    addEventListener('scroll', onScroll, { passive: true });
    globalThis.visualViewport?.addEventListener('resize', onViewport);
    try { dialog.showModal(); } catch (error) {
      // Sem modal não há isolamento: desfaz tudo e não insiste.
      document.body.classList.toggle('performance-focus', state.restore.focusMode);
      state = null;
      document.documentElement.classList.remove('tour-active');
      removeEventListener('resize', onViewport);
      removeEventListener('scroll', onScroll);
      globalThis.visualViewport?.removeEventListener('resize', onViewport);
      host.notify(`Não foi possível abrir o tour: ${error.message}`, true);
      return false;
    }
    show(0, { first: true });
    return true;
  }

  function go(delta) {
    if (!state) return;
    const index = state.index + delta;
    if (index >= STEPS.length) { finish('completed'); return; }
    if (index < 0) return;
    show(index);
  }

  function cancelMotion() {
    cancelAnimationFrame(state.raf); state.raf = 0;
    clearTimeout(state.settleTimer); state.settleTimer = 0;
    removeEventListener('scrollend', state.onScrollEnd ?? (() => {}));
    for (const animation of state.animations) animation.cancel();
    state.animations = [];
    state.settling = false;
  }

  async function show(index, { first = false } = {}) {
    cancelMotion();
    const token = ++state.token;
    const step = STEPS[index];
    const reduce = reducedMotion();
    state.index = index;
    if (!first && !reduce) {
      const out = card.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px) scale(.985)' }], { duration: 140, easing: 'ease-in', fill: 'forwards' });
      state.animations.push(out);
      // Abas ocultas podem congelar animações: o tempo-limite garante o avanço.
      try { await Promise.race([out.finished, new Promise(resolve => setTimeout(resolve, 200))]); } catch { return; }
      if (token !== state?.token) return;
    }
    host.activateTab(step.tab);
    for (const id of step.open ?? []) { const details = document.getElementById(id); if (details) details.open = true; }
    title.textContent = step.title;
    body.textContent = step.body;
    count.textContent = `${index + 1} de ${STEPS.length}`;
    progress.setAttribute('aria-valuenow', String(index + 1));
    progress.setAttribute('aria-valuetext', `Passo ${index + 1} de ${STEPS.length}`);
    bar.style.width = `${(index + 1) / STEPS.length * 100}%`;
    live.textContent = `Passo ${index + 1} de ${STEPS.length}: ${step.title}`;
    back.disabled = index === 0;
    next.textContent = index === STEPS.length - 1 ? 'Concluir' : 'Próximo';
    if (document.activeElement === back && back.disabled) next.focus();
    if (first) next.focus();
    for (const animation of state.animations) animation.cancel();
    state.animations = [];
    layout({ scroll: reduce ? 'instant' : 'smooth', animate: !first && !reduce });
    if (!reduce) state.animations.push(card.animate([{ opacity: 0, transform: 'translateY(8px) scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: first ? 220 : 260, easing: 'cubic-bezier(.2,.8,.2,1)' }));
  }

  function target() {
    const node = document.querySelector(STEPS[state.index].target);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? node : null;
  }

  // Geometria: no celular o cartão vira folha inferior e o alvo fica acima;
  // na tela larga o cartão vai ao lado, abaixo ou acima do alvo, nunca fora
  // da tela. Alvos maiores que a área livre recebem um destaque recortado.
  function plan() {
    const { width: vw, height: vh } = dialog.getBoundingClientRect();
    const mobile = matchMedia(MOBILE).matches;
    card.classList.toggle('sheet', mobile);
    const cardW = mobile ? vw : Math.min(420, vw - MARGIN * 2);
    card.style.width = `${cardW}px`;
    const cardH = card.offsetHeight;
    return { vw, vh, mobile, cardW, cardH };
  }

  function region(view, rect) {
    if (view.mobile) return { mode: 'sheet', top: MARGIN, bottom: view.vh - view.cardH - GAP };
    if (rect && rect.width + PAD * 2 <= view.vw - view.cardW - GAP - MARGIN * 2) return { mode: 'side', top: MARGIN, bottom: view.vh - MARGIN };
    return { mode: 'stack', top: MARGIN, bottom: view.vh - MARGIN };
  }

  function layout({ scroll = false, animate = false } = {}) {
    if (!state) return;
    const view = plan();
    const node = target();
    let rect = node?.getBoundingClientRect() ?? null;
    let area = region(view, rect);
    let delta = 0;
    if (rect && scroll) {
      const free = area.mode === 'stack' ? area.bottom - area.top - view.cardH - GAP : area.bottom - area.top;
      const height = rect.height + PAD * 2;
      const desired = height <= free ? area.top + (free - height) / 2 + PAD : area.top + PAD;
      const max = document.documentElement.scrollHeight - innerHeight;
      const goal = clamp(scrollY + rect.top - desired, 0, max);
      delta = goal - scrollY;
      if (Math.abs(delta) > 1) {
        scrollTo({ top: goal, left: scrollX, behavior: scroll });
        if (scroll === 'smooth') awaitSettle();
      }
      rect = { top: rect.top - delta, bottom: rect.bottom - delta, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    }
    place(view, area, rect, animate);
  }

  function place(view, area, rect, animate) {
    let spotBox;
    let cardTop;
    let cardLeft = 0;
    if (!rect) {
      spotBox = { top: view.vh / 2, left: view.vw / 2, width: 0, height: 0 };
      cardTop = view.mobile ? view.vh - view.cardH : (view.vh - view.cardH) / 2;
      cardLeft = view.mobile ? 0 : (view.vw - view.cardW) / 2;
    } else {
      const box = { top: rect.top - PAD, bottom: rect.bottom + PAD, left: Math.max(MARGIN / 2, rect.left - PAD), right: Math.min(view.vw - MARGIN / 2, rect.right + PAD) };
      if (area.mode === 'sheet') {
        cardTop = view.vh - view.cardH;
      } else if (area.mode === 'side') {
        const right = view.vw - box.right - GAP - MARGIN >= view.cardW;
        cardLeft = right ? box.right + GAP : box.left - GAP - view.cardW;
        cardTop = clamp(box.top, MARGIN, view.vh - view.cardH - MARGIN);
      } else {
        cardLeft = clamp(box.left + (box.right - box.left - view.cardW) / 2, MARGIN, view.vw - view.cardW - MARGIN);
        const below = box.bottom + GAP;
        const above = box.top - GAP - view.cardH;
        if (below + view.cardH <= view.vh - MARGIN) cardTop = below;
        else if (above >= MARGIN) cardTop = above;
        else { cardTop = view.vh - view.cardH - MARGIN; area = { ...area, bottom: cardTop - GAP }; }
      }
      // Recorta o destaque à área visível que o cartão não cobre.
      const top = Math.max(box.top, area.top - PAD / 2);
      const bottom = Math.min(box.bottom, area.mode === 'side' ? view.vh - MARGIN / 2 : area.bottom);
      spotBox = bottom - top >= 24
        ? { top, left: box.left, width: box.right - box.left, height: bottom - top }
        : { top: area.top, left: box.left, width: box.right - box.left, height: 0 };
      spot.classList.toggle('clipped', top > box.top || bottom < box.bottom);
    }
    spot.classList.toggle('instant', !animate);
    card.classList.toggle('instant', !animate);
    spot.style.transform = `translate(${spotBox.left}px, ${spotBox.top}px)`;
    spot.style.width = `${spotBox.width}px`;
    spot.style.height = `${spotBox.height}px`;
    card.style.left = `${Math.round(cardLeft)}px`;
    card.style.top = `${Math.round(cardTop)}px`;
    if (!animate) { void spot.offsetWidth; spot.classList.remove('instant'); card.classList.remove('instant'); }
  }

  // Espera a rolagem suave acabar (scrollend ou estabilidade), sem laço ocioso.
  function awaitSettle() {
    state.settling = true;
    const token = state.token;
    let lastY = scrollY;
    let still = 0;
    const started = performance.now();
    const done = () => {
      if (!state || token !== state.token || !state.settling) return;
      cancelAnimationFrame(state.raf); state.raf = 0;
      clearTimeout(state.settleTimer); state.settleTimer = 0;
      removeEventListener('scrollend', state.onScrollEnd);
      state.settling = false;
      layout({ animate: true });
    };
    state.onScrollEnd = done;
    addEventListener('scrollend', done, { once: true });
    const watch = () => {
      if (!state || token !== state.token) return;
      still = Math.abs(scrollY - lastY) < 0.5 ? still + 1 : 0;
      lastY = scrollY;
      if (still >= 6 || performance.now() - started > 1400) { done(); return; }
      state.raf = requestAnimationFrame(watch);
    };
    state.raf = requestAnimationFrame(watch);
    state.settleTimer = setTimeout(done, 1500);
  }

  let viewportFrame = 0;
  function onViewport() {
    if (!state || viewportFrame) return;
    viewportFrame = requestAnimationFrame(() => { viewportFrame = 0; if (state) { cancelMotion(); layout({ scroll: 'instant' }); } });
  }
  let scrollFrame = 0;
  function onScroll() {
    if (!state || state.settling || scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; if (state && !state.settling) layout(); });
  }

  function finish(status) {
    if (!state) return;
    const { restore } = state;
    cancelMotion();
    state = null;
    cancelAnimationFrame(viewportFrame); viewportFrame = 0;
    cancelAnimationFrame(scrollFrame); scrollFrame = 0;
    removeEventListener('resize', onViewport);
    removeEventListener('scroll', onScroll);
    globalThis.visualViewport?.removeEventListener('resize', onViewport);
    seenThisVisit = true;
    writeFlag(status);
    if (dialog.open) dialog.close();
    document.documentElement.classList.remove('tour-active');
    host.activateTab(restore.tab);
    for (const [id, open] of Object.entries(restore.open)) { const details = document.getElementById(id); if (details) details.open = open; }
    document.body.classList.toggle('performance-focus', restore.focusMode);
    const grid = document.querySelector('.grid-scroll');
    if (grid) grid.scrollLeft = restore.gridLeft;
    scrollTo({ top: restore.y, left: restore.x, behavior: 'instant' });
    const focus = restore.focus instanceof HTMLElement && restore.focus !== document.body && restore.focus.isConnected && !restore.focus.closest('[hidden], [inert]') ? restore.focus : button;
    focus.focus({ preventScroll: true });
  }

  return {
    start: () => start({ auto: false }),
    get open() { return state !== null; },
    /** Abre uma vez na primeira visita, sem atropelar avisos ou interação. */
    autoStart({ delay = 700 } = {}) {
      if (seenThisVisit) return;
      let interacted = false;
      const mark = () => { interacted = true; };
      const events = ['pointerdown', 'keydown'];
      for (const type of events) addEventListener(type, mark, { capture: true, once: true });
      setTimeout(() => {
        for (const type of events) removeEventListener(type, mark, { capture: true });
        if (seenThisVisit || interacted || document.hidden || host.isBusy() || !host.canAutoOpen()) return;
        start({ auto: true });
      }, delay);
    },
  };
}
