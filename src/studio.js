// Navegação das atividades: o workspace pertence permanentemente ao Estúdio.
export function mountStudio({ onActivate }) {
  const tabs = [...document.querySelectorAll('.intentions [role=tab]')];
  function activate(tab) {
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
    }
    document.body.dataset.intent = tab.id.slice(4);
    const more = tab.closest('.secondary-activities');
    if (more) more.open = true;
    else document.querySelector('.secondary-activities').open = false;
    onActivate(tab.id);
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      const index = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : event.key === 'ArrowRight' ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : null;
      if (next === null) return;
      event.preventDefault(); activate(tabs[next]); tabs[next].focus();
    });
  }
  document.getElementById('edit-in-studio').addEventListener('click', () => {
    activate(document.getElementById('tab-studio'));
    const editor = document.getElementById('studio-editor');
    document.getElementById('grid').focus({ preventScroll: true });
    editor.scrollIntoView({ block: 'start', behavior: 'instant' });
  });
  return { activate };
}
