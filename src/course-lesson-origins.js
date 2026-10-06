// Origem do exercício (rodada 5, etapa 6).
//
// Um exercício criado a partir de uma sugestão de aula (ou vinculado a uma aula
// existente) guarda a origem FORA do exercício: a loja de cursos responde
// `store.originsOf(exerciseId)` com curso, seção e aula. Este módulo transforma
// essa resposta em etiquetas COMPACTAS, para a Biblioteca e o Estúdio mostrarem
// de onde o exercício veio SEM copiar título de curso para dentro do exercício.
//
// Regras de apresentação (combinadas com o integrador):
//  - ZERO origens → nenhum nó (nem linha extra no Estúdio);
//  - UMA origem → um único botão com o rótulo completo (curso · seção · aula);
//  - DUAS ou mais → um `<details>` cujo resumo é o ÚNICO controle no repouso
//    (“Origem (N aulas)”); as etiquetas — cada uma com o rótulo completo — são
//    montadas quando ele abre. Por isso a contagem de controles em repouso é 1
//    para qualquer número de origens, na Biblioteca (chamando a factory direto)
//    e no Estúdio (pelo controller que se atualiza com a loja);
//  - aula que saiu do mapa do curso TAMBÉM abre: a página da aula mostra a
//    versão arquivada (estado, anotações, vínculos e anexos guardados) — o
//    botão só indica “aula removida do curso” no texto e no title;
//  - nada é gravado aqui: a origem é lida da loja a cada mudança.

import { createEl } from './practice.js';

export function originLabel(origin) {
  const parts = [origin?.courseTitle ?? origin?.courseId ?? 'curso'];
  if (origin?.sectionTitle) parts.push(origin.sectionTitle);
  parts.push(origin?.lessonTitle ?? origin?.lessonId ?? 'aula');
  return parts.join(' · ');
}

export function originTitle(origin) {
  if (origin?.removed) return `Abrir a aula removida do curso (estado e anexos guardados): ${originLabel(origin)}`;
  return `Abrir a aula de origem: ${originLabel(origin)}`;
}

function originButton(origin, onOpenLesson) {
  const label = originLabel(origin);
  const button = createEl('button', {
    type: 'button',
    className: `course-origin${origin?.removed ? ' course-origin-removed' : ''}`,
    dataset: {
      focusKey: `origin:${origin?.courseId}:${origin?.lessonId}`,
      courseId: origin?.courseId ?? '',
      lessonId: origin?.lessonId ?? '',
    },
    title: originTitle(origin),
    text: origin?.removed ? `${label} (aula removida do curso)` : label,
  });
  if (typeof onOpenLesson === 'function') {
    button.addEventListener('click', () => onOpenLesson(origin.courseId, origin.lessonId));
  } else {
    button.disabled = true;
  }
  return button;
}

// Etiquetas de origem prontas — o chamador decide onde pôr. O TOTAL de
// controles no repouso é sempre 1 (ou 0 sem origem): a Biblioteca chama esta
// factory direto por linha, sem controller próprio.
export function exerciseOriginBadges(origins, { onOpenLesson = null, label = 'Origem' } = {}) {
  const list = Array.isArray(origins) ? origins : [];
  if (list.length === 0) return [];
  if (list.length === 1) return [originButton(list[0], onOpenLesson)];
  const details = createEl('details', {
    className: 'course-origin-more',
    dataset: { disclosure: 'course-origin-more' },
  });
  details.append(createEl('summary', {
    text: `${label} (${list.length} aulas)`,
    title: list.map(origin => originTitle(origin)).join(' | '),
  }));
  let filled = false;
  details.addEventListener('toggle', () => {
    if (!details.open || filled) return;
    filled = true;
    const list_node = createEl('ul', { className: 'course-origin-list' });
    for (const origin of list) {
      list_node.append(createEl('li', { className: 'course-origin-item' }, [originButton(origin, onOpenLesson)]));
    }
    details.append(list_node);
  });
  return [details];
}

// Controller dinâmico do Estúdio/Biblioteca: monta as etiquetas de UM exercício
// dentro de um contêiner e se atualiza quando a loja de cursos muda. A
// Biblioteca pode usar só a factory acima (sem controller, para não vazar
// assinatura por linha).
export function mountExerciseOrigins(container, { store, exerciseId, onOpenLesson = null, label = 'Origem' } = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para as origens.');
  if (!store || typeof store.originsOf !== 'function') throw new TypeError('Loja de cursos ausente para as origens.');
  const root = createEl('div', { className: 'course-origin-root' });
  root.hidden = true;
  container.appendChild(root);
  let currentId = exerciseId ?? null;

  function render() {
    const origins = currentId ? store.originsOf(currentId) : [];
    root.replaceChildren();
    root.hidden = origins.length === 0;
    root.dataset.exerciseId = String(currentId ?? '');
    for (const node of exerciseOriginBadges(origins, { onOpenLesson, label })) root.append(node);
  }

  const unsubscribe = typeof store.subscribe === 'function' ? store.subscribe(render) : null;
  render();

  return {
    render,
    get origins() { return currentId ? store.originsOf(currentId) : []; },
    setExercise(id) { currentId = id ?? null; render(); },
    destroy() { unsubscribe?.(); root.remove(); },
  };
}
