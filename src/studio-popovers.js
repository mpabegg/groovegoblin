// Keep the familiar details/summary keyboard triggers, but put their panels in the native top layer.
// Coordinates follow the actual trigger (including zoom/scroll), never a page-wide fixed location.
export function mountStudioPopovers() {
  const panels = new Map();
  const selector = '.transport-popover, .track-popover, .track-sound-popover, .inspector-popover, .form-popover, .app-menu-content, .activity-menu';
  function position(panel, summary) {
    const trigger = summary.getBoundingClientRect();
    const gap = 6; const edge = 12;
    panel.style.maxHeight = `${Math.max(80, window.innerHeight - edge * 2)}px`;
    const width = panel.offsetWidth; const height = panel.offsetHeight;
    const left = Math.max(edge, Math.min(trigger.left, window.innerWidth - width - edge));
    const below = trigger.bottom + gap;
    const above = trigger.top - height - gap;
    const top = below + height <= window.innerHeight - edge ? below : above >= edge ? above : Math.max(edge, window.innerHeight - height - edge);
    panel.style.left = `${left}px`; panel.style.top = `${top}px`;
  }
  function bind(panel) {
    if (panels.has(panel) || panel.closest('.chord-advanced, #drum-advanced')) return;
    const detail = panel.parentElement;
    const summary = detail?.querySelector(':scope > summary');
    if (detail?.tagName !== 'DETAILS' || !summary) return;
    panel.setAttribute('popover', 'auto'); panel.classList.add('anchored-popover');
    panel.id ||= `${detail.id || 'studio-options'}-popover`;
    summary.setAttribute('aria-controls', panel.id); summary.setAttribute('aria-expanded', 'false');
    const observer = new ResizeObserver(() => { if (panel.matches(':popover-open')) position(panel, summary); });
    panels.set(panel, { detail, summary, observer });
    let pointerOpened = false;
    function hide() {
      if (panel.matches(':popover-open')) panel.hidePopover();
      detail.open = false; summary.setAttribute('aria-expanded', 'false');
    }
    // A summary is not a native popover invoker: light-dismiss can close it before its click arrives.
    summary.addEventListener('pointerdown', () => { pointerOpened = panel.matches(':popover-open'); });
    summary.addEventListener('click', event => {
      event.preventDefault();
      const close = (event.detail > 0 && pointerOpened) || panel.matches(':popover-open'); pointerOpened = false;
      if (close) hide();
      else { detail.open = true; panel.showPopover(); position(panel, summary); }
    });
    detail.addEventListener('toggle', () => { if (!detail.open) hide(); });
    panel.addEventListener('toggle', event => {
      const open = event.newState === 'open'; detail.open = open;
      summary.setAttribute('aria-expanded', String(open));
      if (open) position(panel, summary);
    });
    observer.observe(panel);
    if (detail.open) { panel.showPopover(); position(panel, summary); }
  }
  function discover() {
    for (const panel of document.querySelectorAll(selector)) bind(panel);
    for (const [panel, { observer }] of panels) if (!panel.isConnected) { observer.disconnect(); panels.delete(panel); }
  }
  function reposition() {
    for (const [panel, { summary }] of panels) {
      if (!panel.matches(':popover-open')) continue;
      const rect = summary.getBoundingClientRect();
      if (!summary.getClientRects().length || rect.bottom < 0 || rect.top > window.innerHeight) panel.hidePopover();
      else position(panel, summary);
    }
  }
  discover();
  new MutationObserver(discover).observe(document.getElementById('panel-studio'), { childList: true, subtree: true });
  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, { capture: true, passive: true });
  // Native auto popovers handle Escape and light-dismiss; changing activity also closes them.
  function close() {
    for (const [panel] of panels) if (panel.matches(':popover-open')) panel.hidePopover();
  }
  return { close };
}
