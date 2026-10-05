// Undo is bound to a canonical history identity, never a copied session or a later edit.
export function mountStudioNotices(host) {
  const $ = id => document.getElementById(id);
  let entry = null;
  let timer = null;
  function close() {
    clearTimeout(timer); timer = null; entry = null;
    $('studio-toast').hidden = true;
    $('replacement-undo').hidden = true;
  }
  function render() {
    const eligible = entry !== null && entry === host.current() && host.canUndo();
    if (entry !== null && entry !== host.current()) close();
    $('replacement-undo').hidden = !eligible;
    $('replacement-undo').disabled = host.isBusy() || !eligible;
    $('replacement-undo').title = host.isBusy() ? 'Pare a reprodução antes de desfazer' : 'Desfazer esta alteração';
  }
  function show(text, { error = false, current = null } = {}) {
    close();
    if (!text) return;
    entry = current;
    $('message').textContent = text;
    $('message').classList.toggle('error', error);
    $('studio-toast').hidden = false;
    render();
    timer = setTimeout(close, entry !== null && host.canUndo() ? 10000 : 6000);
  }
  function changed(current, text = null) {
    if (text) show(text, { current });
    else if (entry !== null && entry !== current) close();
    render();
  }
  $('replacement-undo').addEventListener('click', () => {
    if (entry === null || entry !== host.current() || host.isBusy() || !host.canUndo()) return;
    host.undo();
    show('Alteração desfeita.');
  });
  $('toast-close').addEventListener('click', close);
  return { changed, render, show, close };
}
