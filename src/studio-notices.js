// A notice refers only to the current canonical history entry, never a copy of the session.
export function mountStudioNotices(host) {
  const $ = id => document.getElementById(id);
  let entry = null;
  let retired = false;
  function render() {
    $('replacement-undo').hidden = retired || entry === null;
    $('replacement-retired').hidden = !retired;
    $('replacement-undo').disabled = host.isBusy() || !host.canUndo();
    $('replacement-undo').title = host.isBusy() ? 'Pare a reprodução antes de desfazer' : !host.canUndo() ? 'Não há alteração anterior para recuperar' : 'Desfazer esta substituição';
  }
  function changed(current, text = null) {
    if (text) {
      entry = current; retired = false;
      $('replacement-text').textContent = text;
      $('replacement-notice').hidden = false;
    } else if (entry !== null && entry !== current) {
      entry = null; retired = true;
    }
    render();
  }
  $('replacement-undo').addEventListener('click', () => {
    if (retired || entry === null || entry !== host.current() || host.isBusy() || !host.canUndo()) return;
    host.undo();
    entry = null; retired = false;
    $('replacement-text').textContent = 'Substituição desfeita.';
    $('replacement-notice').hidden = false;
    $('replacement-undo').hidden = true;
    $('replacement-retired').hidden = true;
  });
  return { changed, render };
}
