// Tour guiado "Como usar": um <dialog> modal nativo que apenas ensina.
// Não toca som, não altera a sessão nem o histórico; ao sair, devolve aba,
// conteúdo da Biblioteca (Exercícios/Cursos), painéis abertos, modo de foco,
// rolagem e foco exatamente como estavam.

import { setStudioDetailsOpen } from './studio-popovers.js';

export const TOUR_STORAGE_KEY = 'groovegoblin:tour:v1';

const STEPS = [
  {
    tab: 'tab-library', mode: 'exercises', target: '#library-mount .library-toolbar',
    title: 'Sua biblioteca, sempre salva',
    body: 'Cada exercício fica salvo automaticamente neste navegador. Novo preserva o anterior; Editar abre o Estúdio e Treinar abre sua frase. Etiquetas, alvo de BPM e anotações ajudam a organizar; Histórico reúne as tentativas e os gráficos de cada exercício. “Montar sessão de hoje” prepara uma fila com durações: quando o tempo chega a zero, você escolhe Próximo ou Encerrar. Salve uma rotina para recriar a fila. Exporte a biblioteca antes de limpar os dados do navegador.',
  },
  {
    tab: 'tab-library', mode: 'courses', target: '#library-mode',
    title: 'Cursos na mesma biblioteca',
    body: 'Em Conteúdo, escolha Cursos e use Importar curso para ler um mapa JSON do seu computador: nada é baixado nem enviado, e sua biblioteca de exercícios não muda. O mapa traz seções e aulas; cada aula mostra tipo, duração, estado e sugestões, e os exercícios sugeridos só passam a existir quando você cria ou vincula um exercício seu do Estúdio — a importação não cria exercícios sozinha. PDFs e áudios de apoio são anexados manualmente e ficam neste navegador; o app não baixa nem incorpora vídeo ou prévia de link. Reimportar o mesmo curso atualiza a estrutura e preserva progresso, anotações e vínculos.',
  },
  {
    tab: 'tab-studio', target: '#studio-instrument',
    title: 'Seu instrumento, sua parte',
    body: 'A frase é sempre sua parte: Guitarra (6 cordas) ou Baixo (meu), com 4 ou 5 cordas. Configure afinação e nomes C D E ou Dó Ré Mi na seta ao lado; trocar instrumento com notas oferece transpor, manter alturas ou cancelar. O perfil acompanha o exercício. No metrônomo, escolha contagem de 0, 1 ou 2 compassos. TAP ajusta o andamento; o acelerador sobe a cada número de voltas escolhido e, ao parar, volta ao BPM salvo.',
  },
  {
    tab: 'tab-studio', target: '#studio-editor',
    title: 'Editar, ler e estudar sua parte',
    body: 'Escolha Ritmo ou Tablatura no cabeçalho. Clique para criar, arraste para mover e use a borda para duração; Shift+clique seleciona um grupo. Na Tab, digite casas 0–24: ↑/↓ mudam a corda quando as alturas cabem, ←/→ movem no tempo e Shift+↑/↓ muda duração. “Padrões” oferece frases prontas de ritmo, guitarra e baixo. “Gerar linha de baixo” escreve uma parte editável; “Estudar esta linha” copia o acompanhamento após confirmação. Régua define início e loop; a miniatura revela trechos fora da vista. Tudo pode ser desfeito.',
  },
  {
    tab: 'tab-studio', target: '#track-chords',
    title: 'Harmonia: acordes e Braço',
    body: 'Escolha o tom e abra “Progressões prontas”: sequências como blues de 12 compassos e ii–V–I oferecem ajustar o exercício ou repetir/cortar. Selecione um acorde para inspecionar. O inspetor fica logo abaixo da linha do tempo; “Braço” vem depois, com afinação do perfil e funções T, 3, 5 e 7. Bateria e baixo gerado podem ficar recolhidos sem perder ligar/desligar, M, S e volume. Em Baixo (meu), o acompanhamento não liga outro baixo automaticamente.',
  },
  {
    tab: 'tab-practice', target: '#practice-mount',
    title: 'Um treinador, duas fontes e três modos',
    body: 'Use a frase atual ou um exercício gerado. Avaliado mostra o resultado; Tocar junto repete com acelerador opcional; Rotina combina ouvir, tocar, ler, memorizar e improvisar. BPM, transporte, partitura e entrada são compartilhados. Teclado usa Espaço; Instrumento usa os ataques capturados. “Configurar” reúne canal, teste, calibração e diagnóstico sem áudio. Somente “Salvar amostra · 10 s” grava um WAV por pedido explícito, sem envio. Ao terminar, a partitura mostra sinais e desvios: Enter repete, L treina o pior trecho, − reduz 10 BPM e + sobe 4 só com pelo menos 90%. Sugestões nunca mudam o BPM sozinhas.',
  },
  {
    tab: 'tab-repertoire', target: '#repertoire-mount',
    title: 'Músicas: estudar um trecho',
    body: 'Importe um áudio, escolha um trecho A–B, repita em loop e ajuste a velocidade para estudar. Análise de pulsos e acordes, tomadas e setlists ficam nesta atividade. O intercâmbio por arquivo leva notas à Frase do Estúdio; não é entrada de instrumento ao vivo. Seus arquivos são processados neste navegador.',
  },
  {
    tab: 'tab-studio', target: '#tab-explore',
    title: 'Escolha sua atividade',
    body: 'Biblioteca, Estúdio, Treinar e Músicas ficam no topo. Em “Mais opções”, Explorar inclui os jogos de ouvido; Percurso reúne tempo nos últimos 28 dias, instrumentos e evolução dos exercícios. Dados antigos sem vínculo continuam em Anteriores. Parar permanece acessível quando há som em outras áreas; Esc interrompe o áudio, inclusive nesta ajuda. Ao fechar o tour, sua atividade, painéis, menus, foco e rolagem voltam ao estado anterior.',
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

// A Biblioteca é uma só aba com dois conteúdos; o tour entra no conteúdo do
// passo pelo próprio seletor nativo, sem ganchos novos no host, e devolve a
// escolha anterior ao sair. Trocar de conteúdo só oculta/mostra o painel, sem
// destruir o curso aberto nem as anotações em rascunho.
const librarySelect = () => document.querySelector('#library-mode');
const libraryMode = () => librarySelect()?.value ?? 'exercises';
function setLibraryMode(next) {
  const select = librarySelect();
  if (!select || select.value === next) return;
  select.value = next;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

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

  // O tour isola os atalhos de edição e treino. A captura global de Esc
  // ainda interrompe o áudio; aqui a mesma tecla fecha e restaura a vista.
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
    const tabId = tab?.id ?? 'tab-studio';
    const priorMode = libraryMode();
    state = {
      index: 0, token: 0, raf: 0, settleTimer: 0, settling: false, animations: [],
      restore: {
        tab: tabId,
        library: priorMode,
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
    const contextualIndex = tabId === 'tab-library'
      ? STEPS.findIndex(step => step.tab === 'tab-library' && step.mode === priorMode)
      : STEPS.findIndex(step => step.tab === tabId);
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
    // O conteúdo da Biblioteca (Exercícios/Cursos) é trocado antes de medir o
    // alvo: o passo dos exercícios vive no painel oculto em Cursos.
    if (step.mode) setLibraryMode(step.mode);
    // A ativação pode reaplicar o foco na execução e fechar “Mais opções”.
    // Abrimos os ancestrais reais, incluindo details sem id, sem editar dados.
    document.body.classList.remove('performance-focus');
    for (let node = button.parentElement; node; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement) setStudioDetailsOpen(node, false);
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
    // Devolve o conteúdo escolhido na Biblioteca antes dos painéis e do foco:
    // o curso aberto e o rascunho voltam ao painel, sem recarregar nada.
    setLibraryMode(restore.library);
    for (const { node, id, open } of restore.details) {
      const details = id ? document.getElementById(id) : node;
      if (details?.isConnected) setStudioDetailsOpen(details, open);
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
