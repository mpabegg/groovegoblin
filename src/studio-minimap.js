import { sessionTicks } from './session.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export function minimapViewport(scrollLeft, viewportWidth, canvasWidth, headerWidth = 200) {
  const width = Math.max(1, canvasWidth - headerWidth);
  return { start: clamp(scrollLeft / width, 0, 1), end: clamp((scrollLeft + viewportWidth - headerWidth) / width, 0, 1), overflow: canvasWidth > viewportWidth + 1 };
}

export function mountStudioMinimap({ scroll, canvas, getSession }) {
  const root = document.getElementById('phrase-minimap'); const navigation = document.getElementById('minimap-navigation'); const drawing = document.getElementById('minimap-drawing');
  const svg = (tag, attributes) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); return node; };
  let viewport = null;
  function sync() {
    root.style.width = `${scroll.clientWidth}px`;
    const range = minimapViewport(scroll.scrollLeft, scroll.clientWidth, canvas.clientWidth);
    root.hidden = !range.overflow;
    if (!viewport) return;
    viewport.setAttribute('x', range.start * 1000); viewport.setAttribute('width', Math.max(1, (range.end - range.start) * 1000));
    const bars = getSession().bars; const bar = Math.min(bars, Math.floor(range.start * bars) + 1);
    navigation.setAttribute('aria-valuemax', bars); navigation.setAttribute('aria-valuenow', bar);
    navigation.setAttribute('aria-valuetext', `Compassos visíveis ${bar} a ${Math.min(bars, Math.ceil(range.end * bars))} de ${bars}. Setas rolam; Home e End vão às extremidades.`);
  }
  function move(fraction) {
    const musicWidth = canvas.clientWidth - 200; const visible = scroll.clientWidth - 200;
    scroll.scrollLeft = clamp(fraction * musicWidth - visible / 2, 0, canvas.clientWidth - scroll.clientWidth); sync();
  }
  navigation.addEventListener('click', event => { const box = navigation.getBoundingClientRect(); move(clamp((event.clientX - box.left) / box.width, 0, 1)); });
  navigation.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const width = Math.max(1, canvas.clientWidth - 200); const visible = scroll.clientWidth - 200;
    if (event.key === 'Home') scroll.scrollLeft = 0;
    else if (event.key === 'End') scroll.scrollLeft = canvas.clientWidth - scroll.clientWidth;
    else scroll.scrollLeft += (['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 1) * (event.key.startsWith('Page') ? visible : width / getSession().bars);
    sync();
  });
  scroll.addEventListener('scroll', sync, { passive: true });
  new ResizeObserver(sync).observe(scroll);
  return { sync, render(notes = getSession().notes) {
    const session = getSession(); const total = sessionTicks(session); drawing.replaceChildren();
    const pitches = notes.map(note => note.pitch); const low = Math.min(40, ...pitches); const high = Math.max(low + 12, ...pitches);
    for (let bar = 0; bar < session.bars; bar++) {
      const x = bar / session.bars * 1000;
      drawing.append(svg('line', { x1: x, x2: x, y1: 0, y2: 32, class: 'minimap-bar' }));
      if (session.bars <= 16 || bar % 2 === 0) { const label = svg('text', { x: x + 3, y: 9 }); label.textContent = bar + 1; drawing.append(label); }
    }
    for (const note of notes) drawing.append(svg('rect', { x: note.start / total * 1000, y: 12 + (high - note.pitch) / (high - low) * 13, width: Math.max(2, note.duration / total * 1000), height: 3, class: 'minimap-note' }));
    viewport = svg('rect', { y: 0.5, height: 31, class: 'minimap-viewport' }); drawing.append(viewport); sync();
  } };
}
