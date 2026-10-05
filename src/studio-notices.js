// Undo is bound to a canonical history identity, never a copied session or a later edit.
export function mountStudioNotices(host) {
  const $ = id => document.getElementById(id);
  let entry = null;
  let timer = null;
  let action = null;
  const actionButton = document.createElement('button');
  actionButton.id = 'toast-action'; actionButton.type = 'button'; actionButton.hidden = true;
  $('studio-toast').insertBefore(actionButton, $('replacement-undo'));
  actionButton.addEventListener('click', () => {
    if (!action || entry !== host.current()) return;
    const run = action; close(); run();
  });
  function close() {
    clearTimeout(timer); timer = null; entry = null;
    $('studio-toast').hidden = true;
    $('replacement-undo').hidden = true;
    action = null; actionButton.hidden = true;
  }
  function render() {
    const eligible = entry !== null && entry === host.current() && host.canUndo();
    if (entry !== null && entry !== host.current()) close();
    $('replacement-undo').hidden = !eligible;
    $('replacement-undo').disabled = host.isBusy() || !eligible;
    $('replacement-undo').title = host.isBusy() ? 'Pare a reprodução antes de desfazer' : 'Desfazer esta alteração';
  }
  function show(text, { error = false, current = null, action: nextAction = null, actionLabel = '' } = {}) {
    close();
    if (!text) return;
    entry = current;
    action = nextAction; actionButton.hidden = !action; actionButton.textContent = actionLabel;
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
