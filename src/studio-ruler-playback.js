import { ticksPerBar, sessionTicks } from './session.js';
import { rulerLoop, rulerTick, rulerStep } from './transport-position.js';

export function mountRulerPlayback(ruler, host) {
  let drag = null;
  ruler.tabIndex = 0;
  ruler.setAttribute('role', 'slider');
  ruler.setAttribute('aria-orientation', 'horizontal');
  ruler.setAttribute('aria-describedby', 'timeline-reading-help');
  ruler.title = 'Clique: início · Arraste: loop · Clique duplo: loop completo · Setas/Home/End: navegar · Enter/Shift+F10: ações. Ajuda e app → Atalhos (?)';
  const selectedTick = () => host.getStartTick() ?? host.getSession().loop.startBar * ticksPerBar(host.getSession());
  const selectedBar = () => Math.floor(selectedTick() / ticksPerBar(host.getSession()));
  function reveal(tick = selectedTick()) {
    const scroll = document.getElementById('studio-scroll');
    const canvas = document.getElementById('studio-canvas');
    const x = 200 + tick / sessionTicks(host.getSession()) * (canvas.clientWidth - 200);
    if (x < scroll.scrollLeft + 216) scroll.scrollLeft = Math.max(0, x - 216);
    else if (x > scroll.scrollLeft + scroll.clientWidth - 24) scroll.scrollLeft = x - scroll.clientWidth + 24;
  }
  function fraction(event) {
    const rect = ruler.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }
  function render(loop = drag?.moved ? rulerLoop(host.getSession(), drag.from, drag.to) : host.getSession().loop) {
    const session = host.getSession();
    let range = ruler.querySelector('.ruler-loop');
    if (!range) { range = document.createElement('div'); range.className = 'ruler-loop'; range.setAttribute('aria-hidden', 'true'); ruler.append(range); }
    range.style.left = `${loop.startBar / session.bars * 100}%`;
    range.style.width = `${(loop.endBar - loop.startBar) / session.bars * 100}%`;
    range.title = `Loop: compassos ${loop.startBar + 1}–${loop.endBar}`;
    let start = ruler.querySelector('.ruler-start');
    if (!start) { start = document.createElement('div'); start.className = 'ruler-start'; start.setAttribute('aria-hidden', 'true'); ruler.append(start); }
    const tick = host.getStartTick(); start.hidden = tick === null;
    start.style.left = `${(tick ?? 0) / sessionTicks(session) * 100}%`;
    ruler.setAttribute('aria-label', 'Início de reprodução na régua');
    const value = selectedTick(); const measure = ticksPerBar(session);
    const beat = Math.round((value % measure / (16 / session.meter.unit) + 1) * 1000) / 1000;
    ruler.setAttribute('aria-valuemin', '0');
    ruler.setAttribute('aria-valuemax', String(rulerTick(session, 1)));
    ruler.setAttribute('aria-valuenow', String(value));
    ruler.setAttribute('aria-valuetext', `Compasso ${Math.floor(value / measure) + 1}, tempo ${beat}. Loop: compassos ${loop.startBar + 1} a ${loop.endBar}.`);
    for (const label of ruler.querySelectorAll('[data-bar]')) label.classList.toggle('ruler-current', Number(label.dataset.bar) === Math.floor(value / measure));
  }
  function cancelDrag() {
    if (!drag) return false;
    const id = drag.id; drag = null;
    if (ruler.hasPointerCapture(id)) ruler.releasePointerCapture(id);
    render(); return true;
  }
  ruler.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    ruler.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, from: fraction(event), to: fraction(event), moved: false };
    ruler.setPointerCapture(event.pointerId);
  });
  ruler.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    drag.to = fraction(event);
    drag.moved ||= Math.abs(event.clientX - drag.x) >= 4;
    if (drag.moved) render(rulerLoop(host.getSession(), drag.from, drag.to));
  });
  ruler.addEventListener('pointerup', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const value = drag; drag = null;
    if (ruler.hasPointerCapture(event.pointerId)) ruler.releasePointerCapture(event.pointerId);
    if (value.moved) host.updateSession({ loop: rulerLoop(host.getSession(), value.from, fraction(event)) }, { notice: 'Loop definido na régua.' });
    else host.seek(rulerTick(host.getSession(), fraction(event)));
    render();
    reveal();
  });
  for (const type of ['pointercancel', 'lostpointercapture']) ruler.addEventListener(type, cancelDrag);
  function reset() { cancelDrag(); host.updateSession({ loop: { startBar: 0, endBar: host.getSession().bars } }, { notice: 'Loop completo restaurado.' }); host.seek(0); render(); reveal(); }
  ruler.addEventListener('dblclick', event => { event.preventDefault(); reset(); });
  ruler.addEventListener('keydown', event => {
    if (event.target !== ruler || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const session = host.getSession();
    if (event.shiftKey) {
      if (event.key === 'Home') { reset(); return; }
      const endBar = event.key === 'End' ? session.bars : Math.max(session.loop.startBar + 1, Math.min(session.bars, session.loop.endBar + (event.key === 'ArrowRight' ? 1 : -1)));
      host.updateSession({ loop: { ...session.loop, endBar } }, { notice: 'Fim do loop ajustado na régua.' });
      reveal((endBar - 1) * ticksPerBar(session));
    } else {
      const tick = selectedTick();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rulerTick(session, 1) : rulerStep(session, tick, event.key === 'ArrowRight' ? 1 : -1);
      host.seek(next);
      reveal();
    }
    render();
  });
  return { render, cancelDrag, selectedBar, reveal };
}
