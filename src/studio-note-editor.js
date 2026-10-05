import { sessionTicks } from './session.js';
import { addNote } from './model.js';
import { quantizeTick } from './meter.js';
import { editNotes, pasteNotes, NOTE_FIGURES, rememberedDuration, rememberDuration } from './studio-editing.js';

export function mountStudioNoteEditor(grid, host, view) {
  const $ = id => document.getElementById(id);
  let drag = null; let suppressClick = false; let copied = []; let duration = rememberedDuration();
  const more = document.createElement('details'); more.id = 'creation-more-figures'; more.className = 'track-disclosure';
  const summary = document.createElement('summary'); summary.textContent = 'Mais'; summary.setAttribute('aria-label', 'Mais figuras de duração');
  const extra = document.createElement('div'); extra.id = 'extra-creation-duration'; extra.className = 'track-popover creation-figures-popover';
  extra.setAttribute('role', 'group'); extra.setAttribute('aria-label', 'Durações pontuadas, semibreve e quiálteras');
  more.append(summary, extra); $('creation-duration').append(more);
  const ids = () => host.getEditorSelection()?.kind === 'note' ? host.getEditorSelection().ids ?? [host.getSelection()] : [];
  function choose(chosen, primary = chosen.at(-1)) {
    host.setEditorSelection(chosen.length ? { kind: 'note', id: primary, ids: chosen } : null);
    view.renderNotes(); host.selectionChanged?.();
    if (!chosen.length) grid.focus({ preventScroll: true });
  }
  function select(id, toggle = false, preview = true) {
    choose(toggle ? ids().includes(id) ? ids().filter(value => value !== id) : [...ids(), id] : [id]);
    if (preview && ids().includes(id)) host.auditionNotes?.([host.getSession().notes.find(note => note.id === id)]);
    const note = host.getSession().notes.find(note => note.id === id); if (note && ids().includes(id)) setDuration(note.duration);
  }
  function setDuration(ticks) {
    duration = ticks; rememberDuration(ticks);
    for (const button of $('creation-duration').querySelectorAll('button')) button.setAttribute('aria-pressed', String(Math.abs(Number(button.dataset.duration) - duration) < 1e-8));
    const selectedFigure = NOTE_FIGURES.find(([ticks]) => Math.abs(ticks - duration) < 1e-8);
    summary.title = `Mais figuras · duração ativa: ${selectedFigure?.[2] ?? `${duration} ticks`}`;
    summary.classList.toggle('active-figure', !!selectedFigure && !NOTE_FIGURES.slice(0, 4).includes(selectedFigure));
  }
  for (const [index, [ticks, figure, name]] of NOTE_FIGURES.entries()) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'preset'; button.dataset.duration = ticks;
    button.textContent = figure; button.title = name; button.setAttribute('aria-label', `Duração de criação: ${name}`);
    button.addEventListener('click', () => { setDuration(ticks); if (ids().length) commit({ duration: ticks }); });
    if (index < 4) $('creation-duration').insertBefore(button, more); else extra.append(button);
  }
  setDuration(duration);
  function commit(patch) {
    const session = host.getSession();
    if (!ids().length) return;
    const primary = session.notes.find(note => note.id === host.getSelection());
    const operation = typeof patch === 'function' ? patch : note => ({ ...patch, ...(patch.start === undefined ? {} : { start: note.start + patch.start - primary.start }) });
    const notes = editNotes(session.notes, ids(), operation, session);
    if (notes === session.notes) { host.notify('Alteração cancelada: preserve os limites e evite sobreposição.', true); host.selectionChanged?.(); return false; }
    if (host.updateSession({ notes })) { if (patch.duration !== undefined) setDuration(patch.duration); return true; }
    return false;
  }
  function create(tick) {
    const session = host.getSession(); const length = Math.min(duration, sessionTicks(session) - tick);
    const notes = addNote(session.notes, tick, length, session, { pitch: session.extensions?.studio?.inputPitch ?? 69, velocity: 0.8, articulation: 'normal' });
    if (notes === session.notes) { host.notify('Posição ocupada ou duração ultrapassa a frase.', true); return; }
    const note = notes.find(item => !session.notes.some(previous => previous.id === item.id));
    choose([note.id]); if (host.updateSession({ notes })) { view.focusNote(note.id); host.auditionNotes?.([note]); }
  }
  function remove() {
    if (!ids().length) return;
    const chosen = new Set(ids());
    if (host.updateSession({ notes: host.getSession().notes.filter(note => !chosen.has(note.id)) })) { choose([]); grid.focus({ preventScroll: true }); }
  }
  grid.setAttribute('aria-multiselectable', 'true');
  grid.addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; return; }
    const block = event.target.closest('.note');
    if (block) { select(block.dataset.id, event.shiftKey); return; }
    view.setCursor((event.clientX - grid.getBoundingClientRect().left) / grid.getBoundingClientRect().width * sessionTicks(host.getSession())); create(view.getCursor());
  });
  grid.addEventListener('focusin', event => {
    const block = event.target.closest('.note');
    if (!drag && block && !ids().includes(block.dataset.id)) select(block.dataset.id, false, false);
  });
  grid.addEventListener('keydown', event => {
    if (event.altKey) return;
    const session = host.getSession(); const key = event.key.toLowerCase();
    if (event.ctrlKey || event.metaKey) {
      if (!['a', 'c', 'v', 'd'].includes(key)) return;
      event.preventDefault();
      if (key === 'a') { choose(session.notes.map(note => note.id)); return; }
      if (key === 'c') { copied = session.notes.filter(note => ids().includes(note.id)).map(note => ({ ...note })); host.notify(`${copied.length} notas copiadas no editor.`); return; }
      const source = key === 'd' ? session.notes.filter(note => ids().includes(note.id)) : copied;
      const tick = key === 'd' && source.length ? Math.max(...source.map(note => note.start + note.duration)) : view.getCursor();
      const pasted = pasteNotes(session.notes, source, tick, session);
      if (!pasted) { host.notify('Não foi possível colar: preserve os limites e evite sobreposição.', true); return; }
      choose(pasted.ids); host.updateSession({ notes: pasted.notes }); view.focusNote(pasted.ids[0]); return;
    }
    const block = event.target.closest('.note'); const step = event.shiftKey ? 4 : 4 / session.subdivision;
    if (!block) {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); view.navigate(event.key, event.shiftKey); }
      else if (event.key === 'Enter') { event.preventDefault(); create(view.getCursor()); }
      else if (event.key === 'ArrowDown' && session.notes.length) { event.preventDefault(); const note = session.notes.find(note => note.start >= view.getCursor()) ?? session.notes[0]; select(note.id); view.focusNote(note.id); }
      return;
    }
    if (event.key === 'Enter') { event.preventDefault(); select(block.dataset.id, event.shiftKey); return; }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault(); const notes = [...session.notes].sort((a, b) => a.start - b.start); const index = notes.findIndex(note => note.id === block.dataset.id); const next = notes[index + (event.key === 'PageDown' ? 1 : -1)]; if (next) { select(next.id); view.focusNote(next.id); } return;
    }
    const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : null;
    if (delta !== null) { event.preventDefault(); commit(note => ({ start: note.start + delta })); }
    else if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); if (commit(note => ({ duration: note.duration + (event.key === 'ArrowUp' ? step : -step) }))) setDuration(host.getSession().notes.find(note => note.id === host.getSelection()).duration); }
    else if (['1', '2', '3', '4', '6', '8'].includes(event.key)) { event.preventDefault(); commit({ duration: Number(event.key) }); }
  });
  grid.addEventListener('pointerdown', event => {
    suppressClick = false; if (event.button !== 0) return;
    const block = event.target.closest('.note'); const session = host.getSession();
    event.preventDefault();
    if (block) {
      if (event.shiftKey) { select(block.dataset.id, true); if (ids().includes(block.dataset.id)) view.focusNote(block.dataset.id); else grid.focus({ preventScroll: true }); suppressClick = true; return; }
      if (!ids().includes(block.dataset.id)) select(block.dataset.id); else host.auditionNotes?.([session.notes.find(note => note.id === block.dataset.id)]);
      drag = { type: 'notes', ids: [...ids()], x: event.clientX, y: event.clientY, original: session, next: session.notes, resize: !!event.target.closest('.handle'), pointer: event.pointerId };
      view.focusNote(block.dataset.id);
    } else {
      drag = { type: 'marquee', x: event.clientX, y: event.clientY, original: session, pointer: event.pointerId, additive: event.shiftKey, ids: event.shiftKey ? [...ids()] : [], moved: false };
      grid.focus({ preventScroll: true });
    }
    grid.setPointerCapture(event.pointerId);
  });
  grid.addEventListener('pointermove', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const box = grid.getBoundingClientRect();
    if (drag.type === 'marquee') {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3 && !drag.moved) return;
      drag.moved = true;
      const left = Math.min(drag.x, event.clientX); const right = Math.max(drag.x, event.clientX); const top = Math.min(drag.y, event.clientY); const bottom = Math.max(drag.y, event.clientY);
      const chosen = [...grid.querySelectorAll('.note')].filter(block => { const rect = block.getBoundingClientRect(); return rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom; }).map(block => block.dataset.id);
      choose([...new Set([...drag.ids, ...chosen])]);
      const marquee = $('note-marquee'); marquee.hidden = false; Object.assign(marquee.style, { left: `${left - box.left}px`, top: `${top - box.top}px`, width: `${right - left}px`, height: `${bottom - top}px` }); return;
    }
    const delta = quantizeTick((event.clientX - drag.x) / box.width * sessionTicks(drag.original), drag.original.subdivision);
    drag.next = editNotes(drag.original.notes, drag.ids, note => drag.resize ? { duration: note.duration + delta } : { start: note.start + delta }, drag.original);
    drag.invalid = delta !== 0 && drag.next === drag.original.notes; view.renderNotes(drag.next);
  });
  grid.addEventListener('pointerup', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const previous = drag; cancelDrag();
    if (previous.type === 'marquee' && !previous.moved) { view.setCursor((event.clientX - grid.getBoundingClientRect().left) / grid.getBoundingClientRect().width * sessionTicks(host.getSession())); create(view.getCursor()); }
    else if (previous.type === 'notes' && previous.next !== previous.original.notes) { host.updateSession({ notes: previous.next }); if (previous.resize) setDuration(previous.next.find(note => note.id === host.getSelection()).duration); }
    else if (previous.invalid) host.notify('Movimento cancelado: preserve os limites e evite sobreposição.', true);
    suppressClick = true; view.renderNotes();
  });
  function cancelDrag() {
    const previous = drag; drag = null; $('note-marquee').hidden = true;
    if (previous && grid.hasPointerCapture(previous.pointer)) grid.releasePointerCapture(previous.pointer); return !!previous;
  }
  grid.addEventListener('pointercancel', () => { cancelDrag(); view.renderNotes(); });
  grid.addEventListener('lostpointercapture', event => { if (drag?.pointer === event.pointerId) { cancelDrag(); view.renderNotes(); } });
  return { ids, commit, remove, cancelDrag, setDuration };
}
