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
//
// Etapa 8 (B4b): o MESMO contexto de origem ganha a ação "Ver na apostila" do
// exercício gerado, resolvida contra o curso ATUAL da loja (ver o bloco de
// material no fim do arquivo). O painel é o único do app (material-panel.js) e
// a ação só existe com servidor: sem ele não há nó nenhum, e os anexos manuais
// da página da aula continuam como sempre.

import { createEl } from './practice.js';
import { attachmentRefKey } from './course-attachments.js';
import { courseLessons } from './course-progress.js';
import { foldFileName } from './course-catalog.js';
import { CONTENT_KINDS } from './course-content.js';

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
export function mountExerciseOrigins(container, {
  store, exerciseId, onOpenLesson = null, label = 'Origem',
  library = null, content = null, panel = null, notify = null, attachments = null,
} = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para as origens.');
  if (!store || typeof store.originsOf !== 'function') throw new TypeError('Loja de cursos ausente para as origens.');
  const root = createEl('div', { className: 'course-origin-root' });
  root.hidden = true;
  container.appendChild(root);
  let currentId = exerciseId ?? null;

  function render() {
    const origins = currentId ? store.originsOf(currentId) : [];
    const materials = currentId ? exerciseMaterialActions(store, currentId, { library, content, panel, notify, attachments }) : [];
    root.replaceChildren();
    root.hidden = origins.length === 0 && materials.length === 0;
    root.dataset.exerciseId = String(currentId ?? '');
    for (const node of exerciseOriginBadges(origins, { onOpenLesson, label })) root.append(node);
    for (const node of materials) root.append(node);
  }

  const unsubscribe = typeof store.subscribe === 'function' ? store.subscribe(render) : null;
  render();

  return {
    render,
    get origins() { return currentId ? store.originsOf(currentId) : []; },
    get materials() { return currentId ? exerciseMaterialTargets(store, currentId, { library }) : []; },
    setExercise(id) { currentId = id ?? null; render(); },
    destroy() { unsubscribe?.(); root.remove(); },
  };
}

// ─────────────────── material do exercício (etapa 8 / B4b) ──────────────────
//
// O exercício gerado guarda em `metadata.study.origin.material` o material
// EXATO que o catálogo apontou (nome do arquivo + ids + página). Aqui esse
// vínculo é resolvido contra o CURSO ATUAL da loja: a identidade que vale é o
// NOME do arquivo — a MESMA convenção de casamento por nome do conversor do
// mapa —, então uma reimportação que troca ids de aula continua achando o
// material, e ids guardados nunca são usados às cegas.
//
// Honestidade acima de conveniência: sem nome no mapa atual, ou com mais de um
// material possível, NÃO há ação (nada de abrir o PDF errado nem afirmar uma
// página que o catálogo não indicou). O único caso "sem nome" que abre é o do
// exercício antigo cuja aula tem UM ÚNICO PDF inequívoco — e aí sem afirmar
// página nenhuma.

const PDF_EXTENSION = 'pdf';

function isPdfResource(resource) {
  return typeof resource?.extension === 'string' && resource.extension.toLowerCase() === PDF_EXTENSION;
}

// Candidatos a apostila: o que a página da aula sempre considerou material de
// leitura (papel `apostila` ou arquivo PDF).
function isApostilaCandidate(resource) {
  return resource?.role === 'apostila' || isPdfResource(resource);
}

// Só PDF abre no painel embutido: um pacote .zip citado como fonte não vira
// apostila.
function onlyPdf(index) {
  return index.filter(entry => isPdfResource(entry.resource));
}

function materialNames(material) {
  const list = Array.isArray(material?.names)
    ? material.names
    : (typeof material?.name === 'string' ? [material.name] : []);
  const names = [];
  for (const value of list) {
    const folded = foldFileName(value);
    if (folded !== null && !names.includes(folded)) names.push(folded);
  }
  return names;
}

function materialPage(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function materialTarget(course, entry, page, homeLessonId = null) {
  const other = homeLessonId !== null && entry.lessonId !== homeLessonId;
  return {
    courseId: course.id,
    lessonId: entry.lessonId,
    resourceId: entry.resource.id,
    refKey: attachmentRefKey(course.id, entry.lessonId, entry.resource.id),
    name: entry.resource.name,
    extension: entry.resource.extension ?? '',
    page: materialPage(page),
    // O material pode morar em OUTRA aula (a pasta de downloads do módulo): o
    // rótulo diz de onde ele vem, para o botão não mentir sobre a origem.
    fromOtherLesson: other,
    ownerLessonTitle: other ? (entry.ownerLessonTitle ?? null) : null,
  };
}

// Índice do curso INTEIRO: a apostila de um exercício pode morar em outra aula
// (a pasta de downloads do módulo, por exemplo) e o nome do arquivo é a chave.
function courseMaterialIndex(course) {
  const index = [];
  for (const lesson of courseLessons(course)) {
    for (const resource of lesson.resources ?? []) {
      if (!isApostilaCandidate(resource)) continue;
      index.push({ lessonId: lesson.id, ownerLessonTitle: lesson.title, resource });
    }
  }
  return index;
}

// Materiais da PRÓPRIA aula: os recursos dela e as referências a material de
// outra aula — a mesma lista que a página da aula mostra.
function lessonMaterialIndex(course, lesson) {
  const index = [];
  const seen = new Set();
  const push = (lessonId, resource, title) => {
    if (!isApostilaCandidate(resource)) return;
    const key = `${lessonId}/${resource.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    index.push({ lessonId, ownerLessonTitle: title, resource, fromOtherLesson: lessonId !== lesson.id });
  };
  for (const resource of lesson?.resources ?? []) push(lesson.id, resource, lesson.title);
  const lessons = new Map(courseLessons(course).map(item => [item.id, item]));
  for (const ref of lesson?.resourceRefs ?? []) {
    const owner = lessons.get(ref.lessonId) ?? null;
    const resource = (owner?.resources ?? []).find(item => item.id === ref.resourceId) ?? null;
    if (resource) push(ref.lessonId, resource, owner?.title ?? null);
  }
  return index;
}

// O material CITADO (nome/ids guardados) dentro do mapa ATUAL. Nome primeiro —
// é a identidade estável; os ids só desempatam nomes repetidos.
function citedMaterial(course, material) {
  const index = onlyPdf(courseMaterialIndex(course));
  const names = materialNames(material);
  const pinned = entry => entry.resource.id === material?.resourceId
    && (material?.lessonId === null || material?.lessonId === undefined || entry.lessonId === material.lessonId);
  if (names.length > 0) {
    const byName = index.filter(entry => names.includes(foldFileName(entry.resource.name)));
    if (byName.length <= 1) return byName;
    const exact = byName.filter(pinned);
    return exact.length === 1 ? exact : byName;
  }
  if (typeof material?.resourceId === 'string' && material.resourceId !== '') return index.filter(pinned);
  return [];
}

function hasMaterial(material) {
  return material !== null && typeof material === 'object'
    && (materialNames(material).length > 0 || (typeof material.resourceId === 'string' && material.resourceId !== ''));
}

// Escolhas de material de uma SUGESTÃO da aula (página da aula): o catálogo
// aponta o arquivo, então a lista tem um item; com duas fontes de mesmo nome ou
// dois PDFs possíveis sem fonte explícita, a lista tem as opções e a página
// decide (nunca "o primeiro PDF").
export function suggestionMaterialChoices(course, lesson, suggestion) {
  if (!course || !lesson || !suggestion) return { choices: [], explicit: false };
  if (hasMaterial(suggestion.material)) {
    return {
      choices: citedMaterial(course, suggestion.material).map(entry => materialTarget(course, entry, suggestion.pdfPage, lesson.id)),
      explicit: true,
    };
  }
  const own = onlyPdf(lessonMaterialIndex(course, lesson));
  // Sem fonte explícita: a página do catálogo vale para o exercício DESTA aula;
  // com dois PDFs possíveis ninguém sabe qual deles é o citado, então a página
  // não é afirmada.
  const page = own.length === 1 ? suggestion.pdfPage : null;
  return { choices: own.map(entry => materialTarget(course, entry, page, lesson.id)), explicit: false };
}

// Material do exercício no contexto PRÓPRIO dele (Estúdio/Biblioteca): resolve
// o vínculo guardado no exercício contra o curso atual da loja. Uma VARIAÇÃO
// não está vinculada a aula nenhuma: ela aponta para o exercício original
// (`metadata.study.origin.id`) e é de lá que o material vem — um salto por vez,
// com limite, sem ciclo.
export function exerciseMaterialTargets(store, exerciseId, { library = null, material = null, depth = 0 } = {}) {
  if (depth > 4 || !store || typeof store.originsOf !== 'function' || typeof store.get !== 'function') return [];
  const saved = material ?? savedOriginMaterial(library, exerciseId);
  const targets = [];
  for (const origin of store.originsOf(exerciseId)) {
    // Aula removida do mapa: o material não está mais lá e nada é adivinhado.
    if (origin.removed) continue;
    const course = store.get(origin.courseId)?.course ?? null;
    if (!course) continue;
    const lesson = courseLessons(course).find(item => item.id === origin.lessonId) ?? null;
    if (!lesson) continue;
    if (hasMaterial(saved)) {
      const hits = citedMaterial(course, saved);
      if (hits.length === 1) targets.push(materialTarget(course, hits[0], saved.page, origin.lessonId));
      continue;
    }
    // Exercício antigo (sem material guardado): só o ÚNICO PDF inequívoco da
    // aula, sem afirmar página nenhuma.
    const own = onlyPdf(lessonMaterialIndex(course, lesson));
    if (own.length === 1) targets.push(materialTarget(course, own[0], null, origin.lessonId));
  }
  if (targets.length > 0) return targets;
  const parent = variationParent(library, exerciseId);
  if (parent === null) return targets;
  return exerciseMaterialTargets(store, parent, { library, depth: depth + 1 });
}

function savedOriginMaterial(library, exerciseId) {
  try {
    const entry = library?.get?.(exerciseId) ?? null;
    return entry?.metadata?.study?.origin?.material ?? null;
  } catch {
    return null;   // sem biblioteca não há vínculo guardado — nada é inventado
  }
}

// Exercício original de uma variação (rótulo do Estúdio de estudo). Sem vínculo
// de curso próprio, é ele quem responde pelo material.
function variationParent(library, exerciseId) {
  try {
    const entry = library?.get?.(exerciseId) ?? null;
    const origin = entry?.metadata?.study?.origin ?? null;
    if (!origin || typeof origin.id !== 'string' || origin.id === '' || origin.id === exerciseId) return null;
    return origin.id;
  } catch {
    return null;
  }
}

// Cópia GUARDADA neste navegador para o refKey EXATO (a MESMA chave da loja de
// anexos compartilhada do app). Não é um resolvedor novo nem um segundo cache:
// é a loja de anexos que já existe, consultada pelo vínculo exato. Devolve
// `null` quando não há bytes locais para esse material.
async function localMaterialCopy(attachments, refKey) {
  if (!attachments || typeof refKey !== 'string' || refKey === '') return null;
  let store = attachments;
  try { if (store && typeof store.then === 'function') store = await store; } catch { return null; }
  if (!store || typeof store.getBlob !== 'function') return null;
  let entry = null;
  try { entry = typeof store.get === 'function' ? store.get(refKey) : null; } catch { entry = null; }
  let blob = null;
  try { blob = await store.getBlob(refKey); } catch { blob = null; }
  if (!blob) return null;
  const fileId = typeof entry?.fileId === 'string' ? entry.fileId : '';
  const sha256 = fileId.startsWith('sha256:') && /^[0-9a-f]{64}$/.test(fileId.slice(7)) ? fileId.slice(7) : null;
  const size = Number.isFinite(entry?.size) ? entry.size : (Number.isFinite(blob.size) ? blob.size : null);
  return { blob, sha256, name: typeof entry?.name === 'string' ? entry.name : null, size };
}

// Abre o MESMO painel do app (instância única) no material exato: o sha vem do
// cliente do conteúdo da própria origem e o painel nunca inventa endereço.
// Quando existe cópia GUARDADA neste navegador para o mesmo refKey (marcada
// "manter offline" ou restaurada de um backup), o painel abre dos BYTES LOCAIS
// — o painel já prefere a cópia —, então a ação não falha com a rede fora nem
// declara indisponível um arquivo que está aqui.
async function openMaterialTarget(target, { content, panel, notify, attachments = null }) {
  const tell = text => { if (typeof notify === 'function') notify(text, true); };
  if (!panel) { tell('O painel do material não está disponível nesta página.'); return false; }
  // Cópia GUARDADA primeiro: quando existe para o refKey exato, ela manda e a
  // ação NÃO depende da rede (o painel prefere os bytes locais). Sem cópia, a
  // referência do servidor é resolvida como antes.
  const copy = await localMaterialCopy(attachments, target.refKey);
  if (copy) {
    const opened = panel.open({
      sha256: copy.sha256 ?? '',
      kind: CONTENT_KINDS.pdf,
      name: copy.name ?? target.name,
      size: copy.size,
      page: target.page,
      refKey: target.refKey,
      localBlob: copy.blob,
    });
    if (opened) return true;
  }
  let ref = null;
  try {
    if (content && typeof content.loadRefs === 'function') await content.loadRefs(target.courseId);
    ref = content && typeof content.refFor === 'function' ? content.refFor(target.courseId, target.refKey) : null;
  } catch {
    ref = null;
  }
  if (!ref || typeof ref.sha256 !== 'string') {
    tell(`A apostila “${target.name ?? 'do curso'}” não está no servidor; importe os arquivos na página do curso.`);
    return false;
  }
  const opened = panel.open({
    sha256: ref.sha256,
    kind: CONTENT_KINDS.pdf,
    name: ref.name ?? target.name,
    size: ref.size,
    page: target.page,
    refKey: target.refKey,
  });
  if (!opened) tell('Não foi possível abrir a apostila no painel.');
  return opened;
}

function materialButton(target, { content, panel, notify, attachments = null }) {
  const button = createEl('button', {
    type: 'button',
    className: 'course-origin-material',
    dataset: {
      action: 'open-material',
      courseId: target.courseId,
      lessonId: target.lessonId,
      resourceId: target.resourceId,
      refKey: target.refKey,
      focusKey: `material:${target.courseId}:${target.refKey}`,
    },
    title: target.page === null
      ? 'Abre a apostila da aula de origem no painel do app.'
      : `Abre a apostila da aula de origem no painel do app, na página ${target.page}.`,
    text: target.page === null ? 'Ver na apostila' : `Ver na apostila (página ${target.page})`,
  });
  button.addEventListener('click', () => { void openMaterialTarget(target, { content, panel, notify, attachments }); });
  return button;
}

// Portão do servidor: a ação nova só aparece com servidor, mas nunca fica
// escondida para sempre porque a sondagem ainda não voltou (recarregar direto
// no Estúdio não passa por Cursos). O nó nasce escondido e se mostra quando a
// sondagem do cliente responde — `content.start()` é idempotente e memorizado.
function serverReadiness(content) {
  const ready = () => Boolean(content && typeof content.available === 'function' && content.available());
  const waiters = [];
  let waiting = false;
  const whenSettled = callback => {
    if (ready() || typeof content?.start !== 'function') { callback(); return; }
    waiters.push(callback);
    if (waiting) return;
    waiting = true;
    Promise.resolve(content.start()).catch(() => {}).then(() => {
      waiting = false;
      for (const fn of waiters.splice(0, waiters.length)) fn();
    });
  };
  return { ready, whenSettled };
}

// Ação "Ver na apostila" do exercício gerado no contexto DELE (Estúdio e
// Biblioteca). Sem servidor (ou sem painel) devolve lista vazia: a ação nova é
// do servidor e não aparece fingindo funcionar. O total de controles no repouso
// continua 1 (o botão) para qualquer número de aulas.
export function exerciseMaterialActions(store, exerciseId, {
  library = null, material = null, content = null, panel = null, notify = null, attachments = null,
} = {}) {
  if (!panel || !content) return [];
  const targets = exerciseMaterialTargets(store, exerciseId, { library, material });
  if (targets.length === 0) return [];
  const server = serverReadiness(content);
  const nodes = targets.length === 1
    ? [materialButton(targets[0], { content, panel, notify, attachments })]
    : [materialPicker(targets, { content, panel, notify, attachments })];
  for (const node of nodes) {
    node.hidden = !server.ready();
    if (!node.hidden) continue;
    server.whenSettled(() => { node.hidden = !server.ready(); });
  }
  return nodes;
}

function materialPicker(targets, { content, panel, notify, attachments = null }) {
  const details = createEl('details', {
    className: 'course-origin-material-more',
    dataset: { disclosure: 'course-origin-material-more' },
  });
  details.append(createEl('summary', { text: `Apostila (${targets.length} aulas)` }));
  const list = createEl('ul', { className: 'course-origin-material-list' });
  for (const target of targets) {
    list.append(createEl('li', { className: 'course-origin-material-item' }, [materialButton(target, { content, panel, notify, attachments })]));
  }
  details.append(list);
  return details;
}
