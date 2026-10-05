import { generateDrums } from './drums.js';
import { sessionTicks, ticksPerBar } from './session.js';
import { drumHitPatch, drumRowVoice, sameDrumPosition } from './studio-drum-editing.js';

const VOICES = ['kick', 'snare', 'hihat'];
const NAMES = { kick: 'Bumbo', snare: 'Caixa', hihat: 'Chimbal / outras percussões' };
const intensity = value => Math.round(Math.max(0.05, Math.min(1, value)) * 1000) / 1000;

// One focusable surface, not one native control per generated hit.
export function mountStudioDrums(host) {
  const $ = id => document.getElementById(id);
  const lane = $('drum-lanes'); const rows = $('drum-rows'); const restore = $('restore-generated-drums');
  lane.tabIndex = 0; lane.setAttribute('role', 'grid'); lane.setAttribute('aria-rowcount', '3');
  let rowIndex = 0; let cursor = 0; let overlap = 0; let pattern = []; let positions = []; let drag = null;
  const target = document.createElement('span'); target.id = 'drum-cursor'; target.className = 'drum-cursor'; target.setAttribute('role', 'gridcell');
  lane.setAttribute('aria-activedescendant', target.id);
  const decision = document.createElement('dialog'); decision.id = 'drum-edit-decision'; decision.className = 'shortcuts-dialog';
  decision.setAttribute('aria-labelledby', 'drum-edit-decision-title'); decision.setAttribute('aria-describedby', 'drum-edit-decision-description');
  const title = document.createElement('h2'); title.id = 'drum-edit-decision-title'; title.textContent = 'Preservar as edições da bateria?';
  const description = document.createElement('p'); description.id = 'drum-edit-decision-description';
  description.textContent = 'Manter aplica suas diferenças de posição e intensidade sobre o novo padrão. Remoções continuam removidas; ataques adicionados continuam presentes. Descartar volta ao padrão gerado. Cancelar não altera a sessão.';
  const keep = document.createElement('button'); keep.id = 'drum-edit-keep'; keep.type = 'button'; keep.textContent = 'Manter edições';
  const discard = document.createElement('button'); discard.id = 'drum-edit-discard'; discard.type = 'button'; discard.textContent = 'Descartar edições';
  const cancel = document.createElement('button'); cancel.id = 'drum-edit-cancel'; cancel.type = 'button'; cancel.textContent = 'Cancelar';
  decision.append(title, description, keep, discard, cancel); document.body.append(decision);
  let request = null; let previousFocus = null;
  function dismiss() { request = null; decision.close(); }
  function choose(clear) {
    const current = request;
    if (!current) return;
    if (current.session !== host.getSession()) { dismiss(); host.notify('Sessão alterada; escolha a variação ou o estilo novamente.'); return; }
    dismiss();
    const patch = clear ? { ...current.patch, drums: { ...current.patch.drums, edits: [] } } : current.patch;
    host.updateSession(patch, { ...current.options, drumDecision: true });
  }
  keep.addEventListener('click', () => choose(false)); discard.addEventListener('click', () => choose(true)); cancel.addEventListener('click', dismiss);
  decision.addEventListener('cancel', () => { request = null; });
  decision.addEventListener('close', () => { request = null; previousFocus?.focus({ preventScroll: true }); previousFocus = null; });
  decision.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); });
  function requestChange(patch, options = {}) {
    const session = host.getSession();
    if (options.drumDecision || !session.drums.edits.length || !['style', 'seed'].some(key => patch.drums?.[key] !== undefined && patch.drums[key] !== session.drums[key])) return false;
    request = { session, patch, options }; previousFocus = document.activeElement;
    $('drum-style').value = session.drums.style; $('drum-seed').value = session.drums.seed;
    decision.showModal(); cancel.focus({ preventScroll: true }); return true;
  }
  function hitsAtCursor() { return pattern.filter(hit => drumRowVoice(hit.instrument) === VOICES[rowIndex] && sameDrumPosition(hit.start, cursor)); }
  function currentHit() { const hits = hitsAtCursor(); return hits[overlap % Math.max(1, hits.length)]; }
  function cursorPosition() {
    const session = host.getSession(); const total = sessionTicks(session);
    cursor = Math.max(0, Math.min(cursor, positions.at(-1) ?? 0));
    const row = rows.children[rowIndex]; if (!row) return;
    row.append(target); target.style.left = `${cursor / total * 100}%`; target.style.width = `${Math.min(4 / session.subdivision, total - cursor) / total * 100}%`;
    const hit = currentHit(); const measure = ticksPerBar(session);
    const text = `${NAMES[VOICES[rowIndex]]}, compasso ${Math.floor(cursor / measure) + 1}, tempo ${Math.round((cursor % measure / (16 / session.meter.unit) + 1) * 1000) / 1000}. ${hit ? `${hit.instrument}, intensidade ${Math.round(hit.velocity * 100)}%, ataque ${overlap % hitsAtCursor().length + 1} de ${hitsAtCursor().length}` : 'Posição vazia'}.`;
    target.setAttribute('aria-label', text);
    lane.setAttribute('aria-label', `Bateria editável. ${text} Esquerda/direita navegam; cima/baixo escolhem linha; Enter adiciona ou remove; Delete remove; Shift+cima/baixo ajusta intensidade; PageUp/PageDown escolhem ataques sobrepostos.`);
    lane.setAttribute('aria-colcount', String(positions.length)); target.setAttribute('aria-rowindex', String(rowIndex + 1)); target.setAttribute('aria-colindex', String(positions.findIndex(tick => sameDrumPosition(tick, cursor)) + 1));
  }
  function render() {
    const session = host.getSession(); restore.hidden = !session.drums.edits.length;
    rows.replaceChildren(); $('drum-voice-labels').replaceChildren();
    lane.setAttribute('aria-disabled', String(!session.drums.enabled));
    if (!session.drums.enabled) return;
    pattern = generateDrums(session).hits; positions = [];
    const measure = ticksPerBar(session); const step = 4 / session.subdivision;
    for (let bar = 0; bar < session.bars; bar++) for (let tick = 0; tick < measure - 1e-8; tick += step) positions.push(bar * measure + tick);
    positions = [...positions, ...pattern.map(hit => hit.start)].sort((a, b) => a - b).filter((tick, index, all) => !index || !sameDrumPosition(tick, all[index - 1]));
    for (const voice of VOICES) {
      const row = document.createElement('div'); row.className = `drum-line drum-${voice}`; row.dataset.voice = voice; row.setAttribute('role', 'row');
      const label = document.createElement('span'); label.className = 'drum-voice-label'; label.textContent = voice === 'hihat' ? 'Chimbal +' : NAMES[voice]; label.title = NAMES[voice];
      for (const hit of pattern.filter(hit => drumRowVoice(hit.instrument) === voice)) {
        const mark = document.createElement('span'); mark.className = 'drum-hit'; mark.dataset.voice = hit.instrument; mark.dataset.start = hit.start; mark.dataset.position = hit.start / sessionTicks(session);
        mark.style.left = `${hit.start / sessionTicks(session) * 100}%`; mark.style.opacity = String(Math.max(0.25, hit.velocity));
        mark.title = `${hit.instrument} · intensidade ${Math.round(hit.velocity * 100)}%. Clique remove; arraste verticalmente para ajustar.`; mark.setAttribute('aria-hidden', 'true'); row.append(mark);
      }
      rows.append(row); $('drum-voice-labels').append(label);
    }
    cursorPosition();
  }
  function commit(voice, start, velocity) {
    try { return host.updateSession(drumHitPatch(host.getSession(), voice, start, velocity), { notice: velocity === null ? 'Ataque da bateria removido.' : 'Ataque da bateria ajustado.' }); }
    catch (error) { host.notify(error.message, true); return false; }
  }
  function snap(x) {
    const session = host.getSession(); const box = lane.getBoundingClientRect(); const tick = Math.max(0, Math.min(1, (x - box.left) / box.width)) * sessionTicks(session);
    const measure = ticksPerBar(session); const bar = Math.min(session.bars - 1, Math.floor(tick / measure));
    const step = 4 / session.subdivision; const local = Math.round((tick - bar * measure) / step) * step;
    const last = Math.ceil((measure - 1e-8) / step) - 1;
    return bar * measure + Math.max(0, Math.min(last * step, local));
  }
  function cancelDrag() {
    if (!drag) return false;
    const id = drag.id; drag = null;
    if (lane.hasPointerCapture(id)) lane.releasePointerCapture(id);
    render(); return true;
  }
  lane.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !host.getSession().drums.enabled || drag) return;
    const row = event.target.closest('.drum-line'); if (!row) return;
    event.preventDefault(); event.stopPropagation(); lane.focus({ preventScroll: true });
    const mark = event.target.closest('.drum-hit'); rowIndex = VOICES.indexOf(row.dataset.voice); overlap = 0;
    const hit = mark ? pattern.find(item => item.instrument === mark.dataset.voice && sameDrumPosition(item.start, Number(mark.dataset.start))) : null;
    cursor = hit?.start ?? snap(event.clientX); cursorPosition();
    drag = { id: event.pointerId, session: host.getSession(), y: event.clientY, hit, mark, velocity: hit?.velocity, moved: false, start: cursor, voice: row.dataset.voice };
    lane.setPointerCapture(event.pointerId);
  });
  lane.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId || !drag.hit) return;
    const distance = drag.y - event.clientY;
    if (Math.abs(distance) >= 4) drag.moved = true;
    if (drag.moved) { drag.velocity = intensity(drag.hit.velocity + distance / 100); drag.mark.style.opacity = String(Math.max(0.25, drag.velocity)); drag.mark.title = `Intensidade ${Math.round(drag.velocity * 100)}%`; }
  });
  lane.addEventListener('pointerup', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const current = drag; drag = null; if (lane.hasPointerCapture(event.pointerId)) lane.releasePointerCapture(event.pointerId);
    if (current.session !== host.getSession()) { render(); host.notify('Sessão alterada durante o gesto; ataque preservado.'); return; }
    commit(current.hit?.instrument ?? current.voice, current.start, current.hit ? current.moved ? current.velocity : null : 0.75);
  });
  for (const type of ['pointercancel', 'lostpointercapture']) lane.addEventListener(type, event => { if (drag?.id === event.pointerId) cancelDrag(); });
  lane.addEventListener('click', event => event.stopImmediatePropagation());
  lane.addEventListener('focus', () => { host.setEditorSelection?.(null); host.selectionChanged?.(); });
  lane.addEventListener('keydown', event => {
    if (!host.getSession().drums.enabled || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key; const hit = currentHit();
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
      const index = positions.findIndex(tick => tick >= cursor - 1e-8);
      cursor = key === 'Home' ? positions[0] : key === 'End' ? positions.at(-1) : positions[Math.max(0, Math.min(positions.length - 1, index + (key === 'ArrowRight' ? 1 : -1)))]; overlap = 0;
    } else if (['ArrowUp', 'ArrowDown'].includes(key)) {
      if (event.shiftKey) { if (hit) commit(hit.instrument, hit.start, intensity(hit.velocity + (key === 'ArrowUp' ? 0.05 : -0.05))); }
      else { rowIndex = Math.max(0, Math.min(2, rowIndex + (key === 'ArrowDown' ? 1 : -1))); overlap = 0; }
    } else if (['PageUp', 'PageDown'].includes(key)) overlap = Math.max(0, overlap + (key === 'PageDown' ? 1 : -1));
    else if (key === 'Enter') commit(hit?.instrument ?? VOICES[rowIndex], cursor, hit ? null : 0.75);
    else if (key === 'Delete' || key === 'Backspace') { if (hit) commit(hit.instrument, hit.start, null); }
    else return;
    event.preventDefault(); event.stopPropagation(); cursorPosition();
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  restore.addEventListener('click', () => host.updateSession({ drums: { edits: [] } }, { notice: 'Bateria gerada restaurada; diferenças manuais removidas.' }));
  return { render, requestChange, cancelDrag };
}
