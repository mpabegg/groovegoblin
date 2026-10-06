import { editChords } from './studio-editing.js';
import { MAX_CHORDS } from './session.js';

export function mountStudioChordSelection(lane, host) {
  let copied = []; let cursor = 0; let drag = null; let suppressClick = false;
  const indices = () => host.getEditorSelection()?.kind === 'chord' ? host.getEditorSelection().indices ?? [host.getChordSelection()] : [];
  function choose(values) {
    host.setEditorSelection(values.length ? { kind: 'chord', index: values.at(-1), indices: values } : null); host.selectionChanged?.();
  }
  function apply(chords, selected) {
    choose(selected);
    return host.updateSession({ progression: { chords } });
  }
  function remove() {
    const chosen = new Set(indices()); if (!chosen.size) return;
    if (apply(host.getSession().progression.chords.filter((_, index) => !chosen.has(index)), [])) lane.focus({ preventScroll: true });
  }
  function paste(source, tick) {
    const session = host.getSession();
    if (!source.length || session.progression.chords.length + source.length > MAX_CHORDS) return false;
    const start = Math.min(...source.map(chord => chord.startBar));
    const added = source.map(chord => ({ ...chord, notes: [...chord.notes], startBar: tick + chord.startBar - start }));
    const combined = [...session.progression.chords, ...added];
    const edited = editChords({ ...session.progression, chords: combined }, added.map(chord => combined.indexOf(chord)), {}, session.meter.beats);
    return edited && apply(edited.chords, edited.indices);
  }
  lane.setAttribute('aria-multiselectable', 'true');
  lane.addEventListener('keydown', event => {
    if (event.target.closest('[data-ghost="true"]')) return;
    const session = host.getSession(); const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ['a', 'c', 'v', 'd'].includes(key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (key === 'a') { choose(session.progression.chords.map((_, index) => index)); return; }
      if (key === 'c') { copied = session.progression.chords.filter((_, index) => indices().includes(index)).map(chord => ({ ...chord, notes: [...chord.notes] })); host.notify(`${copied.length} acordes copiados no editor.`); return; }
      const source = key === 'd' ? session.progression.chords.filter((_, index) => indices().includes(index)) : copied;
      const tick = key === 'd' && source.length ? Math.max(...source.map(chord => chord.startBar + chord.durationBars)) : cursor;
      if (!paste(source, tick)) host.notify('Não foi possível colar: preserve os limites e as pausas do ciclo.', true); return;
    }
    if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); remove(); return; }
    if (indices().length < 2 || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const delta = (['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1) / session.meter.beats;
    const resize = event.shiftKey || ['ArrowUp', 'ArrowDown'].includes(event.key);
    const edited = editChords(session.progression, indices(), chord => resize ? { durationBars: chord.durationBars + delta } : { startBar: chord.startBar + delta }, session.meter.beats);
    if (edited) apply(edited.chords, edited.indices); else host.notify('Alteração cancelada: preserve limites e pausas do ciclo.', true);
  }, true);
  lane.addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  lane.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const block = event.target.closest('.studio-chord'); const session = host.getSession(); const box = lane.getBoundingClientRect();
    if (block?.dataset.ghost === 'true') return;
    cursor = Math.max(0, Math.min(session.progression.cycleBars - 1 / session.meter.beats, Math.floor((event.clientX - box.left) / box.width * session.bars * session.meter.beats) / session.meter.beats));
    if (block && event.shiftKey) {
      event.preventDefault(); event.stopImmediatePropagation(); const index = Number(block.dataset.index);
      choose(indices().includes(index) ? indices().filter(value => value !== index) : [...indices(), index]); lane.focus({ preventScroll: true }); host.auditionChord?.(session.progression.chords[index]); suppressClick = true; return;
    }
    if (block && (indices().length < 2 || !indices().includes(Number(block.dataset.index)))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    lane.focus({ preventScroll: true });
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, session, indices: event.shiftKey || block ? [...indices()] : [], group: !!block, resize: !!event.target.closest('.chord-handle'), moved: false, next: null };
    lane.setPointerCapture(event.pointerId);
  }, true);
  lane.addEventListener('pointermove', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3 && !drag.moved) return;
    drag.moved = true;
    if (drag.group) {
      const delta = Math.round((event.clientX - drag.x) / lane.getBoundingClientRect().width * drag.session.bars * drag.session.meter.beats) / drag.session.meter.beats;
      drag.next = editChords(drag.session.progression, drag.indices, chord => drag.resize ? { durationBars: chord.durationBars + delta } : { startBar: chord.startBar + delta }, drag.session.meter.beats);
      lane.classList.toggle('invalid-drop', !drag.next); return;
    }
    const left = Math.min(drag.x, event.clientX); const right = Math.max(drag.x, event.clientX); const top = Math.min(drag.y, event.clientY); const bottom = Math.max(drag.y, event.clientY);
    const chosen = [...lane.querySelectorAll('.studio-chord:not([data-ghost="true"])')].filter(block => { const rect = block.getBoundingClientRect(); return rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom; }).map(block => Number(block.dataset.index));
    choose([...new Set([...drag.indices, ...chosen])]);
    lane.querySelector('.chord-marquee')?.remove();
    const marquee = document.createElement('div'); marquee.className = 'chord-marquee'; const box = lane.getBoundingClientRect(); Object.assign(marquee.style, { left: `${left - box.left}px`, top: `${top - box.top}px`, width: `${right - left}px`, height: `${bottom - top}px` }); lane.append(marquee);
  }, true);
  lane.addEventListener('pointerup', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const previous = drag; cancelDrag();
    if (!previous.moved && !previous.group) return; // Existing harmony click creates the chord.
    event.preventDefault(); event.stopImmediatePropagation(); suppressClick = true;
    if (previous.group && previous.moved) {
      if (previous.next) apply(previous.next.chords, previous.next.indices); else host.notify('Movimento cancelado: preserve limites e pausas do ciclo.', true);
    }
  }, true);
  function cancelDrag() {
    const previous = drag; drag = null;
    lane.querySelector('.chord-marquee')?.remove(); lane.classList.remove('invalid-drop');
    if (previous && lane.hasPointerCapture(previous.pointer)) lane.releasePointerCapture(previous.pointer); return !!previous;
  }
  lane.addEventListener('pointercancel', cancelDrag, true);
  lane.addEventListener('lostpointercapture', event => { if (drag?.pointer === event.pointerId) cancelDrag(); }, true);
  return { indices, remove, cancelDrag };
}
