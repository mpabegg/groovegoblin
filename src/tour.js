// Tour guiado "Como usar": um <dialog> modal nativo que apenas ensina.
// Não toca som, não altera a sessão nem o histórico; ao sair, devolve aba,
// painéis abertos, modo de foco, rolagem e foco exatamente como estavam.

export const TOUR_STORAGE_KEY = 'groovegoblin:tour:v1';

const STEPS = [
  {
    tab: 'tab-studio', target: '#studio-editor',
    title: 'Estúdio: editar e tocar sua Sessão',
    body: 'Acordes, Frase, Bateria e Baixo compartilham régua, zoom e um único cursor. Clique na régua escolhe início; arraste define o loop verde; clique duplo restaura tudo. A régua tem um só foco de Tab: setas/Home/End escolhem início; Enter/Shift+F10 abre ações do compasso. Zoom mostra 4 ou 2 compassos, com cabeçalhos fixos. Acordes tracejados são repetições automáticas: clique para materializar. Na Frase, clique cria; arraste notas ou a borda para editar. Na Bateria, clique no vazio adiciona, num ataque remove; arraste verticalmente para intensidade. Um foco de Tab: setas navegam posição/linha; Enter alterna ataque; Shift+cima/baixo ajusta intensidade. Variar ou mudar estilo com edições oferece Manter, Descartar ou Cancelar; densidade mantém. Restaurar (padrão gerado) aparece só com diferenças e admite Desfazer. Cada cabeçalho tem M, S e volume; desligar solos restaura o mix guardado. Tom, progressões, estilos, densidades e Variar continuam visíveis. “Som” conserva timbre/opções e biblioteca da Frase. “Compasso” abre fórmula, subdivisão e swing. “Sessão” abre biblioteca, arquivos e links.',
  },
  {
    tab: 'tab-practice', target: '#train-pad',
    title: 'Treinar: tocar → comparar → repetir',
    body: 'Confira a partitura da frase atual, organizada em linhas de quatro compassos. “Ouvir frase” toca uma passagem audível sem mudar mutes, volume ou sessão, com a mesma parada global. Use “Treinar esta frase”; espere a contagem, pressione Espaço ou a área de toque no início de cada nota, segure e solte no final. Durante o treino, Espaço toca o ritmo, não inicia um loop. Os resultados aparecem abaixo. “Editar no Estúdio” volta ao editor; a prática guiada é opcional e seus exercícios não substituem a sessão guardada.',
  },
  {
    tab: 'tab-repertoire', target: '#repertoire-mount',
    title: 'Músicas: estudar um trecho',
    body: 'Importe um áudio, escolha um trecho A–B, repita em loop e ajuste a velocidade para estudar. Análise de pulsos e acordes, tomadas e setlists ficam nesta atividade. O intercâmbio por arquivo leva notas à Frase do Estúdio; não é entrada de instrumento ao vivo. Seus arquivos são processados neste navegador.',
  },
  {
    tab: 'tab-studio', target: '#tab-explore',
    title: 'Escolha sua atividade',
    body: 'Estúdio, Treinar e Músicas ficam no topo. Em “Mais opções”, Explorar reúne jogos e experiências; Percurso mostra seus treinos e revisões. O mesmo botão “Parar” continua acessível quando há som em outras áreas, e Esc interrompe todo o áudio fora desta ajuda. “Ajuda e app → Como usar” abre este tour opcional; “Atalhos” e “Offline” ficam no mesmo menu. Ao fechar a ajuda, sua atividade, painéis, menus, foco e rolagem voltam ao estado anterior.',
  },
];

const MARGIN = 12;
const GAP = 14;
const PAD = 8;
const MOBILE = '(max-width: 640px)';

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
 * host: { activateTab(id), isBusy(), notify(text, error) }
 */
export function mountTour(button, host) {
  let state = null;

  const title = el('h2', { id: 'tour-title', className: 'tour-title', tabIndex: -1 });
  const body = el('p', { id: 'tour-body', className: 'tour-body' });
  const count = el('span', { className: 'tour-count', 'aria-hidden': 'true' });
  const bar = el('span', { className: 'tour-progress-fill' });
  const progress = el('div', { className: 'tour-progress', role: 'progressbar', 'aria-label': 'Progresso do tour', 'aria-valuemin': '1', 'aria-valuemax': String(STEPS.length) }, bar);
  const live = el('p', { className: 'tour-live', 'aria-live': 'polite' });
  const skip = el('button', { type: 'button', className: 'tour-skip', text: 'Fechar ajuda' });
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
  button.addEventListener('click', start);

  function start() {
    if (state) return false;
    if (host.isBusy()) {
      host.notify('Pare o som ou o processamento da música antes de abrir “Como usar”.', true);
      return false;
    }
    const tab = document.querySelector('.intentions [role=tab][aria-selected=true]');
    state = {
      index: 0, token: 0, raf: 0, settleTimer: 0, settling: false, animations: [],
      restore: {
        tab: tab?.id ?? 'tab-studio',
        details: [...document.querySelectorAll('details')].map(node => ({ node, id: node.id, open: node.open })),
        focusMode: document.body.classList.contains('performance-focus'),
        x: scrollX, y: scrollY,
        gridLeft: document.querySelector('#studio-scroll')?.scrollLeft ?? 0,
        gridTop: document.querySelector('#studio-scroll')?.scrollTop ?? 0,
        focus: document.activeElement,
      },
    };
    // O foco na execução esconde detalhes; só a vista muda, não a sessão.
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
    const contextualIndex = STEPS.findIndex(step => step.tab === tab?.id);
    show(Math.max(0, contextualIndex), { first: true });
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
    // A ativação pode reaplicar o foco na execução e fechar “Mais opções”.
    // Abrimos os ancestrais reais, incluindo details sem id, sem editar dados.
    document.body.classList.remove('performance-focus');
    for (let node = button.parentElement; node; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement) node.open = false;
    }
    const targetNode = document.querySelector(step.target);
    const ancestors = [];
    for (let node = targetNode; node; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement) ancestors.push(node);
    }
    for (const details of ancestors.reverse()) details.open = true;
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
    writeFlag(status);
    if (dialog.open) dialog.close();
    document.documentElement.classList.remove('tour-active');
    host.activateTab(restore.tab);
    for (const { node, id, open } of restore.details) {
      const details = id ? document.getElementById(id) : node;
      if (details?.isConnected) details.open = open;
    }
    document.body.classList.toggle('performance-focus', restore.focusMode);
    const grid = document.querySelector('#studio-scroll');
    if (grid) { grid.scrollLeft = restore.gridLeft; grid.scrollTop = restore.gridTop; }
    scrollTo({ top: restore.y, left: restore.x, behavior: 'instant' });
    const focus = restore.focus instanceof HTMLElement && restore.focus !== document.body && restore.focus.isConnected && !restore.focus.closest('[hidden], [inert]') ? restore.focus : button;
    focus.focus({ preventScroll: true });
  }

  return {
    start,
    get open() { return state !== null; },
  };
}
