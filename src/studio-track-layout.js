export const TRACK_LAYOUT_KEY = 'groovegoblin.studio.track-layout.v1';
export const COLLAPSIBLE_TRACKS = Object.freeze(['drums', 'bass']);
const NAMES = { drums: 'Bateria', bass: 'Baixo gerado' };

// Presentation only: never part of the session, history, exports or shared links.
export function readTrackLayout(storage) {
  let saved = {};
  try {
    storage ??= globalThis.localStorage;
    saved = JSON.parse(storage.getItem(TRACK_LAYOUT_KEY) ?? '{}') ?? {};
  } catch { /* Compact lines remain the safe default. */ }
  return Object.fromEntries(COLLAPSIBLE_TRACKS.map(track => [track, saved[track] === 'expanded' ? 'expanded' : 'compact']));
}

export function saveTrackLayout(layout, storage) {
  try {
    storage ??= globalThis.localStorage;
    storage.setItem(TRACK_LAYOUT_KEY, JSON.stringify(Object.fromEntries(COLLAPSIBLE_TRACKS.map(track => [track, layout[track] === 'expanded' ? 'expanded' : 'compact']))));
    return true;
  } catch { return false; }
}

// A compact generated track keeps enable, M/S and volume on one line; expanding restores editing.
export function mountTrackLayout(storage) {
  const layout = readTrackLayout(storage);
  const toggles = new Map();
  for (const track of COLLAPSIBLE_TRACKS) {
    const row = document.getElementById(`track-${track}`);
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'track-layout-toggle'; toggle.id = `track-${track}-layout`;
    toggle.setAttribute('aria-controls', row.id);
    toggle.addEventListener('click', () => {
      layout[track] = layout[track] === 'expanded' ? 'compact' : 'expanded';
      saveTrackLayout(layout, storage); apply(track);
    });
    row.querySelector('.track-inline-mixer').append(toggle);
    toggles.set(track, { row, toggle });
  }
  function apply(track) {
    const { row, toggle } = toggles.get(track); const expanded = layout[track] === 'expanded';
    row.classList.toggle('track-compact', !expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', `Detalhes e edição: ${NAMES[track]}`);
    toggle.title = expanded ? `Recolher ${NAMES[track]} para uma linha` : `Expandir ${NAMES[track]}: estilo, densidade${track === 'drums' ? ', ataques editáveis' : ', estudar a linha'} e som`;
    toggle.textContent = expanded ? '▴' : '▾';
    // Drum hits are only a read-out while compact; the expanded grid owns pointer and keyboard editing.
    const drums = row.querySelector('#drum-lanes');
    if (drums) { drums.inert = !expanded; drums.tabIndex = expanded ? 0 : -1; }
  }
  for (const track of COLLAPSIBLE_TRACKS) apply(track);
  return {
    isCompact: track => layout[track] !== 'expanded',
    render() { for (const track of COLLAPSIBLE_TRACKS) apply(track); },
  };
}
