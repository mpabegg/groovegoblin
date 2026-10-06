// A3 — Editor das formas de dedilhado DENTRO do painel Braço (rodada 6).
//
// Módulo autocontido de interface: monta uma seção no `<details>` do Braço que
// já existe (`studio-fretboard.js`), usa a MESMA tabela de notas e não exige
// nada novo no HTML do app (nem uma linha no `main.js`). O `document` sai do
// contêiner (ownerDocument), nunca de um global, como nos outros diálogos.
//
// O fluxo é o do músico: escolher uma forma, ligar "Destacar no braço" para vê-la
// posicionada na fundamental do acorde atual, ou entrar em "Editar notas" e
// CLICAR as notas de um acorde de referência. Cada clique é conferido contra a
// afinação: a nota só entra se distar da tônica exatamente o intervalo do grau
// (1, 3, 5, 7, 8/10/12/14). A ordem dos graus é escolhida e vale como ordem da
// figura. Nada é salvo "quase certo": o motivo exato aparece na linha de estado.
//
// As genéricas (maior, menor, oitava) vêm prontas e NÃO são sobrescritas: o
// primeiro clique as transforma numa cópia sua, e salvar cria uma forma nova.
// Nunca há material de curso nesta loja.

import { formatInstrumentNote } from './instrument-profile.js';
import { STUDY_QUALITIES, STUDY_QUALITY_LABELS } from './study-generator.js';
import {
  asShapeProfile, checkShape, degreeInterval, isGenericShape, SHAPE_DEGREE_LABELS, SHAPE_DEGREE_OPTIONS,
  SHAPE_LABEL_MAX, SHAPE_MAX_NOTES, shapeInstrumentId, shapeInstrumentLabel, toGeneratorShape,
} from './fingering-shapes.js';

const HINT = 'Escolha uma forma e ligue “Destacar no braço” para vê-la posicionada na fundamental do acorde atual. Em “Editar notas”, clique as notas do acorde de referência: a primeira vira a tônica (grau 1) e cada clique seguinte só entra no grau cujo intervalo fecha contra a afinação. A ordem dos graus é a ordem da figura.';

function el(document, tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'className') node.className = String(value);
    else if (key === 'hidden') { if (value) node.hidden = true; }
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node) {
  if (typeof node.replaceChildren === 'function') node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
}

function defaultDownload(document, text, filename) {
  const view = document.defaultView ?? globalThis;
  if (typeof view.URL?.createObjectURL !== 'function' || typeof view.Blob !== 'function') return false;
  const url = view.URL.createObjectURL(new view.Blob([text], { type: 'application/json' }));
  const link = el(document, 'a', { href: url, download: filename, rel: 'noopener' });
  const host = document.body ?? document.documentElement;
  if (host && typeof host.appendChild === 'function') host.appendChild(link);
  if (typeof link.click === 'function') link.click();
  if (typeof link.remove === 'function') link.remove();
  else if (host && typeof host.removeChild === 'function') host.removeChild(link);
  if (typeof view.setTimeout === 'function') view.setTimeout(() => view.URL.revokeObjectURL(url), 0);
  return true;
}

function copyDraft(record) {
  return {
    id: record?.id ?? null,
    label: record?.label ?? '',
    quality: record?.quality ?? 'major',
    degrees: [...(record?.degrees ?? [1, 3, 5])],
    notes: (record?.notes ?? []).map(note => ({ string: note.string, fret: note.fret, degree: note.degree })),
  };
}

// Monta o editor. Devolve o que o Braço precisa: `signature` entra na assinatura
// do desenho (o quadro é repintado quando a forma muda), `render` acompanha o
// perfil da sessão e `decorate` marca as células da tabela.
export function mountFingeringShapes(container, host = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('Informe o painel do Braço para montar as formas.');
  const document = container.ownerDocument ?? globalThis.document;
  if (!document || typeof document.createElement !== 'function') throw new TypeError('O painel do Braço precisa de um documento DOM.');
  const store = host.store;
  if (!store || typeof store.list !== 'function' || typeof store.save !== 'function') throw new TypeError('Loja de formas de dedilhado ausente.');
  const table = host.table ?? null;
  const repaint = typeof host.repaint === 'function' ? host.repaint : () => {};
  const download = typeof host.download === 'function' ? host.download : (text, filename) => defaultDownload(document, text, filename);
  const now = host.now ?? (() => new Date().toISOString());

  const section = el(document, 'section', { id: 'fingering-shapes', className: 'fingering-shapes' });
  const heading = el(document, 'h3', { text: 'Formas de dedilhado' });
  const hint = el(document, 'p', { className: 'tool-hint muted', text: HINT });
  const select = el(document, 'select', { id: 'shape-select', 'aria-label': 'Forma de dedilhado' });
  const selectLabel = el(document, 'label', { className: 'shape-field' }, ['Forma ', select]);
  const overlayToggle = el(document, 'input', { id: 'shape-overlay', type: 'checkbox' });
  overlayToggle.checked = true;
  const overlayLabel = el(document, 'label', { className: 'toggle' }, [overlayToggle, ' Destacar no braço']);
  const editButton = el(document, 'button', { id: 'shape-edit', type: 'button', 'aria-pressed': 'false', text: 'Editar notas' });
  const saveButton = el(document, 'button', { id: 'shape-save', type: 'button', className: 'primary', text: 'Salvar forma' });
  const newButton = el(document, 'button', { id: 'shape-new', type: 'button', text: 'Nova forma' });
  const deleteButton = el(document, 'button', { id: 'shape-delete', type: 'button', text: 'Excluir' });
  const controls = el(document, 'div', { className: 'tool-row' }, [selectLabel, overlayLabel, editButton, saveButton, newButton, deleteButton]);
  const nameInput = el(document, 'input', { id: 'shape-name', type: 'text', maxlength: String(SHAPE_LABEL_MAX) });
  const nameLabel = el(document, 'label', { className: 'shape-field' }, ['Nome ', nameInput]);
  const qualitySelect = el(document, 'select', { id: 'shape-quality', 'aria-label': 'Qualidade da forma' });
  for (const quality of STUDY_QUALITIES) qualitySelect.append(el(document, 'option', { value: quality, text: STUDY_QUALITY_LABELS[quality] }));
  const qualityLabel = el(document, 'label', { className: 'shape-field' }, ['Qualidade ', qualitySelect]);
  const fields = el(document, 'div', { className: 'tool-row' }, [nameLabel, qualityLabel]);
  const degreesFieldset = el(document, 'fieldset', { id: 'shape-degrees', className: 'shape-degrees' });
  degreesFieldset.append(el(document, 'legend', { text: 'Graus da forma (na ordem da figura)' }));
  const orderList = el(document, 'ol', { id: 'shape-degree-order', className: 'shape-order', 'aria-label': 'Ordem dos graus' });
  const addDegreeSelect = el(document, 'select', { id: 'shape-degree-add', 'aria-label': 'Grau para acrescentar' });
  const addDegreeButton = el(document, 'button', { id: 'shape-degree-add-button', type: 'button', text: 'Acrescentar grau' });
  degreesFieldset.append(orderList, el(document, 'div', { className: 'tool-row' }, [addDegreeSelect, addDegreeButton]));
  const status = el(document, 'p', { id: 'shape-status', className: 'tool-hint', role: 'status' });
  const overlayStatus = el(document, 'p', { id: 'shape-overlay-status', className: 'tool-hint muted', role: 'status' });
  const noteList = el(document, 'ul', { id: 'shape-notes', className: 'shape-notes', 'aria-label': 'Notas clicadas da forma' });
  const recovery = el(document, 'div', { id: 'shape-recovery', className: 'shape-recovery', hidden: true });

  section.append(heading, hint, controls, fields, degreesFieldset, status, overlayStatus, noteList, recovery);
  container.append(section);

  let profile = null;
  let profileKey = '';
  let listKey = '';
  let draftKey = '';
  let draft = copyDraft(null);
  let source = { generic: false, instrument: null };
  let editMode = false;
  let pendingDelete = false;
  let started = false;
  let options = [];
  let lastMessage = { text: '', error: false };

  function meta() {
    const id = profile === null ? 'bass4' : shapeInstrumentId(profile);
    return { id, profile: asShapeProfile(id), label: shapeInstrumentLabel(id) };
  }

  // Geometria da forma: o grupo de origem manda (a forma foi escrita nele); sem
  // origem, o instrumento da sessão.
  function home() {
    const id = source.instrument ?? meta().id;
    return { id, profile: asShapeProfile(id), label: shapeInstrumentLabel(id) };
  }

  // Perfil usado para converter clique (corda/casa) em altura: o da sessão — é a
  // tabela que o usuário está vendo —, caindo para o de origem quando a âncora
  // nem existe na sessão (forma do baixo 5 vista no baixo 4).
  function clickProfile() {
    if (profile === null) return home().profile;
    const anchor = draft.notes.find(note => note.degree === 1) ?? draft.notes.find(note => note.degree === 8) ?? null;
    return anchor && anchor.string > profile.strings ? home().profile : profile;
  }

  function openPitch(profileValue, string) {
    if (!Number.isInteger(string) || string < 1 || string > profileValue.strings) return null;
    return profileValue.tuning[profileValue.strings - string];
  }

  function setStatus(text, error = false) {
    lastMessage = { text: text ?? '', error };
    status.textContent = text ?? '';
    if (error) status.setAttribute('data-error', 'true');
    else status.removeAttribute('data-error');
  }

  function setOverlayStatus(text) {
    overlayStatus.textContent = text ?? '';
  }

  function report() {
    return checkShape(draft, { profile: home().profile });
  }

  // ------------------------------------------------------------- seleção

  function optionLabel(record) {
    const parts = [record.label || '(sem nome)'];
    if (record.generic) parts.push('genérica');
    else if (record.reused) parts.push(`do ${shapeInstrumentLabel(record.instrument).toLowerCase()}`);
    if (!record.applicable) parts.push('não cabe neste instrumento');
    return parts.join(' · ');
  }

  function renderSelect() {
    const records = store.list(profile);
    const key = JSON.stringify([profileKey, store.status, records.map(record => [record.id, record.instrument, record.applicable, record.label])]);
    options = records;
    if (key === listKey) return;
    listKey = key;
    clear(select);
    if (draft.id === null) select.append(el(document, 'option', { value: '', text: 'Nova forma (não salva)' }));
    for (const record of records) {
      const option = el(document, 'option', { value: record.id, text: optionLabel(record) });
      if (!record.applicable) {
        option.disabled = true;
        option.title = `“${record.label}” não tem posição em ${meta().label}.`;
      }
      select.append(option);
    }
    if (draft.id !== null && !records.some(record => record.id === draft.id)) {
      select.prepend(el(document, 'option', { value: draft.id, text: `${draft.label || draft.id} (forma de outro instrumento)` }));
    }
    select.value = draft.id ?? '';
  }

  function adopt(record) {
    draft = copyDraft(record);
    source = { generic: record.generic === true, instrument: record.instrument ?? null };
    draftKey = '';
    listKey = '';
  }

  // ------------------------------------------------------------- desenho

  function anchorLabel() {
    const anchor = draft.notes.find(note => note.degree === 1) ?? draft.notes.find(note => note.degree === 8) ?? null;
    if (anchor === null) return null;
    const pitch = openPitch(home().profile, anchor.string);
    if (pitch === null) return `corda ${anchor.string}, casa ${anchor.fret}`;
    return `${formatInstrumentNote(pitch + anchor.fret, home().profile)} (corda ${anchor.string}, casa ${anchor.fret})`;
  }

  function refreshStatus(current = report()) {
    if (!current.ok) { setStatus(current.errors[0].message, true); return; }
    const home_ = home();
    const where = draft.id === null ? 'nova, ainda não salva' : `guardada em ${home_.label}`;
    let text = `Forma “${draft.label}” (${where}): ${current.notes.length} nota(s), graus ${current.degrees.join(' · ')}. Referência: ${anchorLabel()}.`;
    if (source.generic) text += ' Genérica: o primeiro clique na nota cria uma cópia sua.';
    if (profile !== null && JSON.stringify(profile.tuning) !== JSON.stringify(home_.profile.tuning)) {
      const live = checkShape(draft, { profile });
      if (!live.ok) { setStatus(`${text} A afinação atual da sessão muda os graus desta forma: ${live.errors[0].message}`, true); return; }
    }
    setStatus(text, false);
  }

  function renderDegrees() {
    clear(orderList);
    draft.degrees.forEach((degree, index) => {
      const up = el(document, 'button', { type: 'button', text: '↑', 'aria-label': `Mover o grau ${degree} para cima` });
      const down = el(document, 'button', { type: 'button', text: '↓', 'aria-label': `Mover o grau ${degree} para baixo` });
      const remove = el(document, 'button', { type: 'button', text: '×', 'aria-label': `Tirar o grau ${degree} da forma` });
      up.disabled = index === 0;
      down.disabled = index === draft.degrees.length - 1;
      up.addEventListener('click', () => swapDegrees(index, index - 1));
      down.addEventListener('click', () => swapDegrees(index, index + 1));
      remove.addEventListener('click', () => { draft.degrees.splice(index, 1); mutate(); });
      orderList.append(el(document, 'li', {}, [el(document, 'span', { text: SHAPE_DEGREE_LABELS[degree] ?? String(degree) }), up, down, remove]));
    });
    if (draft.degrees.length === 0) orderList.append(el(document, 'li', { className: 'muted', text: 'Nenhum grau escolhido.' }));
    clear(addDegreeSelect);
    const missing = SHAPE_DEGREE_OPTIONS.filter(degree => !draft.degrees.includes(degree));
    for (const degree of missing) addDegreeSelect.append(el(document, 'option', { value: String(degree), text: SHAPE_DEGREE_LABELS[degree] ?? String(degree) }));
    addDegreeButton.disabled = missing.length === 0;
    addDegreeSelect.disabled = missing.length === 0;
  }

  function swapDegrees(from, to) {
    if (to < 0 || to >= draft.degrees.length) return;
    const degrees = [...draft.degrees];
    [degrees[from], degrees[to]] = [degrees[to], degrees[from]];
    draft.degrees = degrees;
    mutate();
  }

  function renderDraft(force = false) {
    const key = JSON.stringify([profileKey, store.status, draft, pendingDelete, source.generic, source.instrument]);
    if (!force && key === draftKey) return;
    draftKey = key;
    nameInput.value = draft.label;
    qualitySelect.value = draft.quality;
    renderDegrees();
    const home_ = home().profile;
    clear(noteList);
    draft.notes.forEach((note, index) => {
      const pitch = openPitch(home_, note.string);
      const text = `Corda ${note.string} · casa ${note.fret} · ${SHAPE_DEGREE_LABELS[note.degree] ?? note.degree}`
        + (pitch === null ? '' : ` · ${formatInstrumentNote(pitch + note.fret, home_)}`);
      const removeButton = el(document, 'button', { type: 'button', text: 'Remover', 'aria-label': `Remover a nota da corda ${note.string}, casa ${note.fret}` });
      removeButton.addEventListener('click', () => { draft.notes.splice(index, 1); mutate(); });
      noteList.append(el(document, 'li', {}, [el(document, 'span', { text }), removeButton]));
    });
    if (draft.notes.length === 0) noteList.append(el(document, 'li', { className: 'muted', text: 'Nenhuma nota ainda: entre em “Editar notas” e clique as casas no braço.' }));
    editButton.setAttribute('aria-pressed', String(editMode));
    editButton.textContent = editMode ? 'Terminar edição' : 'Editar notas';
    deleteButton.disabled = draft.id === null || isGenericShape(draft);
    deleteButton.title = deleteButton.disabled ? 'As formas genéricas não podem ser excluídas' : 'Excluir esta forma guardada';
    const current = report();
    saveButton.disabled = !current.ok;
    saveButton.title = current.ok ? `Guardar esta forma em ${home().label}` : current.errors[0].message;
    if (!pendingDelete) deleteButton.textContent = 'Excluir';
    refreshStatus(current);
  }

  // ------------------------------------------------------- clique nas notas

  // Primeira edição de uma genérica: vira cópia do usuário (nova forma).
  function detachGeneric({ rename }) {
    if (!source.generic) return;
    source = { ...source, generic: false };
    draft.id = null;
    if (rename) draft.label = `${draft.label.replace(/\(genérica\)/i, '').trim() || 'Minha forma'} (minha)`.slice(0, SHAPE_LABEL_MAX);
  }

  function mutate({ rename = true } = {}) {
    detachGeneric({ rename });
    listKey = '';
    renderDraft(true);
    repaint();
  }

  function toggleNote(string, fret) {
    const index = draft.notes.findIndex(note => note.string === string && note.fret === fret);
    if (index >= 0) { draft.notes.splice(index, 1); mutate(); return; }
    if (draft.notes.length >= SHAPE_MAX_NOTES) { setStatus(`Uma forma admite até ${SHAPE_MAX_NOTES} notas; remova uma antes de marcar outra.`, true); return; }
    const geometry = clickProfile();
    const open = openPitch(geometry, string);
    if (open === null) { setStatus(`A corda ${string} não existe em ${shapeInstrumentLabel(shapeInstrumentId(geometry))}.`, true); return; }
    const anchor = draft.notes.find(note => note.degree === 1) ?? draft.notes.find(note => note.degree === 8) ?? null;
    if (anchor === null) { draft.notes.push({ string, fret, degree: 1 }); mutate(); return; }
    const anchorRoot = openPitch(geometry, anchor.string) + anchor.fret - (anchor.degree === 8 ? 12 : 0);
    const offset = open + fret - anchorRoot;
    const degrees = draft.degrees.length ? draft.degrees : SHAPE_DEGREE_OPTIONS;
    // Raiz (grau 1 ou 8, como no A2): qualquer oitava exata da tônica.
    const matches = degrees.filter(degree => (degree === 1 || degree === 8)
      ? offset % 12 === 0
      : degreeInterval(draft.quality, degree) === offset);
    if (matches.length === 0) {
      const reachable = SHAPE_DEGREE_OPTIONS.filter(degree => degree !== 1)
        .map(degree => `${SHAPE_DEGREE_LABELS[degree] ?? degree} = ${degreeInterval(draft.quality, degree)} semitom(ns)`)
        .join(', ');
      setStatus(`A corda ${string} casa ${fret} está a ${offset} semitom(ns) da tônica, e nenhum grau escolhido tem esse intervalo (${reachable}). Acrescente o grau certo ou clique outra casa.`, true);
      return;
    }
    let degree;
    if (offset === 0) {
      // Mesma altura da tônica (outra corda): tônica dobrada, grau 1.
      degree = matches.includes(1) ? 1 : matches[0];
    } else if (offset % 12 === 0) {
      // Oitava exata: exige o grau 8, para a forma dizer o que é.
      if (!matches.includes(8)) { setStatus(`A casa ${fret} da corda ${string} é a oitava exata da tônica: acrescente o grau 8 aos graus da forma para marcá-la.`, true); return; }
      degree = 8;
    } else {
      degree = matches[0];
    }
    draft.notes.push({ string, fret, degree });
    if (!draft.degrees.includes(degree)) draft.degrees = [...draft.degrees, degree];
    mutate();
  }

  // -------------------------------------------------------------- ações

  function selectRecord(id) {
    const record = options.find(item => item.id === id);
    if (!record) return;
    if (!record.applicable) {
      setStatus(`“${record.label}” não tem posição em ${meta().label}; ela continua guardada em ${shapeInstrumentLabel(record.instrument)}.`, true);
      return;
    }
    pendingDelete = false;
    adopt(record);
    editMode = false;
    renderSelect();
    renderDraft(true);
    repaint();
    setStatus(`Forma “${draft.label}” carregada (${record.generic ? 'genérica' : `guardada em ${shapeInstrumentLabel(record.instrument)}`}).`, false);
    refreshStatus();
  }

  function save() {
    const current = report();
    if (!current.ok) { setStatus(current.errors[0].message, true); return; }
    const group = source.instrument ?? meta().id;
    try {
      const record = store.save({ ...draft, id: draft.id, label: draft.label.trim() }, profile, { group });
      draft = copyDraft(record);
      source = { generic: false, instrument: group };
      listKey = '';
      renderSelect();
      renderDraft(true);
      repaint();
      setStatus(`Forma “${record.label}” salva em ${shapeInstrumentLabel(group)}.`, false);
    } catch (error) {
      setStatus(error?.message ?? String(error), true);
    }
  }

  function remove() {
    const group = source.instrument ?? meta().id;
    if (draft.id === null || isGenericShape(draft)) return;
    if (!pendingDelete) {
      pendingDelete = true;
      deleteButton.textContent = 'Confirmar exclusão';
      deleteButton.title = `Clique de novo para excluir “${draft.label}”`;
      setStatus(`Excluir “${draft.label}”? Clique de novo em “Confirmar exclusão”. A forma guardada não pode ser recuperada por aqui.`, false);
      return;
    }
    const removed = store.remove(draft.id, group);
    pendingDelete = false;
    draft = copyDraft(null);
    source = { generic: false, instrument: null };
    listKey = '';
    renderSelect();
    renderDraft(true);
    repaint();
    setStatus(removed ? 'Forma excluída.' : 'A forma já não estava guardada.', !removed);
  }

  function startNew() {
    pendingDelete = false;
    draft = copyDraft(null);
    draft.label = `${STUDY_QUALITY_LABELS[draft.quality]} · fundamental`.slice(0, SHAPE_LABEL_MAX);
    source = { generic: false, instrument: null };
    editMode = true;
    listKey = '';
    renderSelect();
    renderDraft(true);
    repaint();
    setStatus('Nova forma: escolha a qualidade e a ordem dos graus, clique as notas do acorde de referência no braço (a primeira é a tônica) e dê um nome.', false);
  }

  let recoveryKey = '';
  function refreshRecovery() {
    const key = JSON.stringify([store.status, store.persistent, store.warning]);
    if (key === recoveryKey) return;
    recoveryKey = key;
    clear(recovery);
    if (store.status === 'ready' && store.persistent !== false) { recovery.hidden = true; return; }
    recovery.hidden = false;
    recovery.append(el(document, 'p', { text: store.warning ?? 'As formas não podem ser guardadas neste navegador.' }));
    if (store.status === 'corrupt') {
      const downloadButton = el(document, 'button', { type: 'button', text: 'Baixar bytes originais' });
      downloadButton.addEventListener('click', () => {
        const ok = download(store.recoveryRaw ?? '', `groovegoblin-formas-${now().slice(0, 10)}.json`);
        setStatus(ok ? 'Bytes originais baixados; recomece quando quiser.' : 'Não foi possível baixar os bytes originais neste navegador.', !ok);
      });
      const restart = el(document, 'button', { type: 'button', text: 'Recomeçar (descartar)' });
      restart.addEventListener('click', () => {
        store.discardCorrupt();
        listKey = '';
        draft = copyDraft(null);
        source = { generic: false, instrument: null };
        renderSelect();
        renderDraft(true);
        refreshRecovery();
        repaint();
        setStatus('Formas recomeçadas vazias; os bytes antigos continuam disponíveis para download até recarregar a página.', false);
      });
      recovery.append(el(document, 'div', { className: 'tool-row' }, [downloadButton, restart]));
    }
  }

  // ------------------------------------------------------------ ligações

  select.addEventListener('change', () => selectRecord(select.value));
  overlayToggle.addEventListener('change', () => repaint());
  editButton.addEventListener('click', () => {
    editMode = !editMode;
    pendingDelete = false;
    renderDraft(true);
    repaint();
    setStatus(editMode ? 'Edição de notas: clique as casas no braço para marcar e desmarcar.' : 'Edição de notas encerrada.', false);
  });
  saveButton.addEventListener('click', save);
  newButton.addEventListener('click', startNew);
  deleteButton.addEventListener('click', remove);
  addDegreeButton.addEventListener('click', () => {
    const degree = Number(addDegreeSelect.value);
    if (!SHAPE_DEGREE_OPTIONS.includes(degree) || draft.degrees.includes(degree)) return;
    draft.degrees = [...draft.degrees, degree];
    mutate();
  });
  nameInput.addEventListener('input', () => {
    draft.label = nameInput.value;
    // Enquanto o nome é digitado a forma já deixa de ser genérica, mas o texto
    // digitado não é reescrito.
    detachGeneric({ rename: false });
    listKey = '';
    renderDraft(true);
    repaint();
  });
  qualitySelect.addEventListener('change', () => { draft.quality = qualitySelect.value; mutate(); });
  if (table) table.addEventListener('click', event => {
    if (!editMode) return;
    const cell = event.target?.closest?.('td[data-string][data-fret]');
    if (!cell) return;
    event.preventDefault();
    toggleNote(Number(cell.dataset.string), Number(cell.dataset.fret));
  });
  const unsubscribe = store.subscribe(() => { listKey = ''; renderSelect(); renderDraft(true); refreshRecovery(); repaint(); });

  // ---------------------------------------------------------------- API

  function render(nextProfile = null) {
    profile = nextProfile ?? null;
    const key = profile === null ? 'nenhum' : JSON.stringify([profile.type, profile.strings, profile.tuning, profile.noteNames]);
    if (key !== profileKey) { profileKey = key; listKey = ''; }
    // Na primeira abertura, a genérica maior já aparece selecionada: o destaque
    // no braço funciona antes de o usuário criar qualquer coisa.
    if (!started) {
      started = true;
      const first = store.list(profile).find(record => record.applicable !== false);
      if (first) adopt(first);
    }
    renderSelect();
    renderDraft();
    refreshRecovery();
  }

  function decorate(target, context = {}) {
    if (!target) return;
    const cells = target.querySelectorAll('td[data-string][data-fret]');
    for (const cell of cells) {
      cell.classList.remove('fretboard-shape', 'fretboard-shape-anchor');
      delete cell.dataset.shapeDegree;
    }
    target.dataset.shapeEditing = editMode ? 'true' : 'false';
    const current = context.profile ?? profile;
    const root = Number.isInteger(context.root) ? context.root : null;
    const from = Number.isInteger(context.from) ? context.from : 0;
    const to = Number.isInteger(context.to) ? context.to : from + 12;
    const marks = new Map();
    let mode = 'nada';
    let extra = '';
    if (editMode && draft.notes.length > 0) {
      mode = 'escrita';
      for (const note of draft.notes) marks.set(`${note.string}:${note.fret}`, note.degree);
    } else if (overlayToggle.checked && draft.notes.length > 0 && current !== null && root !== null) {
      mode = 'posição';
      try {
        const placed = store.shapeOverlay(toGeneratorShape(draft), current, root, { from, to, strings: null, open: true });
        if (placed.positions === null) {
          mode = 'aviso';
          setOverlayStatus(`“${draft.label}” não tem posição nesta afinação (${placed.reason === 'cordas' ? 'faltam cordas para o molde' : 'as casas não cabem no braço'}).`);
        } else {
          for (const note of placed.positions) marks.set(`${note.string}:${note.fret}`, note.degree);
          if (placed.degreesOk === false) extra += ' A afinação atual não fecha os graus desta forma.';
          if (placed.stringShift > 0) extra += ' Deslocada para as cordas mais graves (usa a corda mais grave do instrumento).';
          if (placed.stringShift < 0) extra += ' Deslocada para as cordas mais agudas.';
        }
      } catch (error) {
        mode = 'aviso';
        setOverlayStatus(error?.message ?? String(error));
      }
    }
    let visible = 0;
    for (const cell of cells) {
      const degree = marks.get(`${cell.dataset.string}:${cell.dataset.fret}`);
      if (degree === undefined) continue;
      cell.classList.add('fretboard-shape');
      if (degree === 1 || degree === 8) cell.classList.add('fretboard-shape-anchor');
      cell.dataset.shapeDegree = String(degree);
      visible += 1;
    }
    if (mode === 'escrita') {
      setOverlayStatus(`Editando “${draft.label || 'nova forma'}”: ${draft.notes.length}/${SHAPE_MAX_NOTES} nota(s) na posição escrita. Clique para marcar ou desmarcar.`);
    } else if (mode === 'posição') {
      const name = current === null ? '' : formatInstrumentNote(root, current, { octave: false });
      const hidden = marks.size - visible;
      setOverlayStatus(`“${draft.label}” em ${name} (fundamental do acorde atual): ${visible} nota(s) nas casas ${from}–${to}${hidden > 0 ? `; ${hidden} fora desta faixa` : ''}.${extra}`);
    } else if (mode === 'aviso') {
      // a mensagem específica já está na linha
    } else if (draft.notes.length === 0) {
      setOverlayStatus('Nenhuma nota marcada; entre em “Editar notas” para clicar as casas.');
    } else if (!overlayToggle.checked) {
      setOverlayStatus('Destaque desligado.');
    } else {
      setOverlayStatus('');
    }
  }

  render(null);

  return {
    element: section,
    render,
    decorate,
    signature: () => JSON.stringify([profileKey, store.status, editMode, overlayToggle.checked, draft, options.length]),
    selected: () => ({ ...draft, degrees: [...draft.degrees], notes: draft.notes.map(note => ({ ...note })) }),
    message: () => ({ ...lastMessage }),
    store,
    destroy() {
      unsubscribe?.();
      if (typeof section.remove === 'function') section.remove();
      else if (section.parentNode?.removeChild) section.parentNode.removeChild(section);
    },
  };
}
