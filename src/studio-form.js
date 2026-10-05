import { DENSITIES } from './session.js';
import { FORM_KINDS, FORM_LABELS, FORM_DESCRIPTIONS } from './form.js';

const densityLabels = { sparse: 'Poucas notas', medium: 'Média', busy: 'Muitas notas' };
const emptyReason = 'Adicione uma seção para habilitar Tocar a forma.';
const lockedReason = 'Pare a reprodução antes de editar a forma.';

// Session validation/history belong to the host; playback uses its existing frame.
export function mountStudioForm(host) {
  const $ = id => document.getElementById(id);
  const list = $('form-sections');
  let lastPosition = { mode: 'idle' };

  function apply(patch) {
    if (host.isBusy()) { host.notify(lockedReason, true); renderControls(); return false; }
    const applied = host.updateSession({ form: patch });
    if (!applied) render();
    return applied;
  }
  for (const key of ['enabled', 'loop']) {
    $(`form-${key}`).addEventListener('change', event => {
      if (key === 'enabled' && event.target.checked && !host.getSession().form.sections.length) {
        host.notify(emptyReason, true); renderControls(); return;
      }
      apply({ [key]: event.target.checked });
    });
  }
  $('add-section').addEventListener('click', () => {
    const session = host.getSession();
    if (session.form.sections.length >= 32) return;
    const section = { id: crypto.randomUUID(), name: `Seção ${session.form.sections.length + 1}`, kind: 'A', startBar: session.loop.startBar, endBar: session.loop.endBar, repeats: 1, bpm: null, meter: null, density: null };
    if (apply({ sections: [...session.form.sections, section] })) focusSection(section.id);
  });
  function focusSection(id) {
    [...list.children].find(row => row.dataset.sectionId === id)?.querySelector('input')?.focus({ preventScroll: true });
  }
  function change(id, patch) {
    apply({ sections: host.getSession().form.sections.map(section => section.id === id ? { ...section, ...patch } : section) });
  }
  function move(id, delta) {
    const sections = [...host.getSession().form.sections];
    const index = sections.findIndex(section => section.id === id);
    if (index < 0 || index + delta < 0 || index + delta >= sections.length) return;
    [sections[index], sections[index + delta]] = [sections[index + delta], sections[index]];
    if (apply({ sections })) focusSection(id);
  }
  function remove(id) {
    const session = host.getSession();
    const index = session.form.sections.findIndex(section => section.id === id);
    const sections = session.form.sections.filter(section => section.id !== id);
    if (apply({ sections, enabled: session.form.enabled && sections.length > 0 })) {
      if (sections.length) focusSection(sections[Math.min(index, sections.length - 1)].id);
      else $('add-section').focus({ preventScroll: true });
    }
  }
  function options(select, values, labels) {
    for (const value of values) {
      const option = document.createElement('option'); option.value = value; option.textContent = labels[value] ?? value; select.append(option);
    }
  }
  function render() {
    const session = host.getSession();
    const open = new Set([...list.querySelectorAll('details[open]')].map(detail => detail.closest('tr').dataset.sectionId));
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.closest('tr')?.dataset.sectionId;
    const focusedField = focused?.dataset.formField;
    list.replaceChildren();
    for (const [index, section] of session.form.sections.entries()) {
      const row = document.createElement('tr'); row.dataset.sectionId = section.id;
      const sectionLabel = section.name || `Seção ${index + 1}`;
      const cell = content => {
        const cell = document.createElement('td'); cell.append(content); row.append(cell); return cell;
      };
      const label = (text, control, field, visible = false) => {
        const label = document.createElement('label');
        const caption = document.createElement('span'); caption.textContent = text; caption.className = visible ? '' : 'sr-only';
        control.dataset.formField = field;
        label.append(caption, control); return label;
      };
      const number = (text, field, value, min, max, commit, optional = false) => {
        const input = document.createElement('input'); input.type = 'number'; input.min = min; input.max = max; input.step = 1;
        input.value = value ?? ''; input.required = !optional;
        if (optional) input.placeholder = 'Herdar';
        input.addEventListener('change', () => {
          if (!input.reportValidity()) return;
          commit(input.value === '' ? null : Number(input.value));
        });
        return label(`${text} · ${sectionLabel}`, input, field, optional);
      };
      const name = document.createElement('input'); name.type = 'text'; name.value = section.name; name.maxLength = 80;
      name.addEventListener('change', () => change(section.id, { name: name.value }));
      cell(label(`Nome da seção ${index + 1}`, name, 'name'));
      const kind = document.createElement('select'); options(kind, FORM_KINDS, FORM_LABELS); kind.value = section.kind;
      kind.addEventListener('change', () => change(section.id, { kind: kind.value }));
      cell(label(`Tipo e papel · ${sectionLabel}`, kind, 'kind'));
      const range = document.createElement('div'); range.className = 'form-range';
      range.append(number('Primeiro compasso', 'startBar', section.startBar + 1, 1, session.bars, value => change(section.id, { startBar: value - 1 })));
      const separator = document.createElement('span'); separator.textContent = '–'; separator.setAttribute('aria-hidden', 'true'); range.append(separator);
      range.append(number('Último compasso', 'endBar', section.endBar, 1, session.bars, value => change(section.id, { endBar: value })));
      cell(range);
      cell(number('Repetições', 'repeats', section.repeats, 1, 16, value => change(section.id, { repeats: value })));
      const detail = document.createElement('details'); detail.id = `form-section-options-${section.id}`; detail.className = 'form-more'; detail.open = open.has(section.id);
      const summary = document.createElement('summary'); summary.textContent = 'Mais'; summary.dataset.formField = 'more'; summary.setAttribute('aria-label', `Mais opções · ${sectionLabel}`);
      const popover = document.createElement('div'); popover.className = 'form-popover';
      const description = document.createElement('p'); description.className = 'tool-hint muted'; description.textContent = FORM_DESCRIPTIONS[section.kind];
      const overrides = document.createElement('div'); overrides.className = 'tool-row';
      overrides.append(number('BPM (semínimas)', 'bpm', section.bpm, 30, 300, value => change(section.id, { bpm: value }), true));
      overrides.append(number('Tempos', 'beats', section.meter?.beats, 1, 16, value => change(section.id, { meter: value === null ? null : { beats: value, unit: section.meter?.unit ?? session.meter.unit } }), true));
      const unit = document.createElement('select'); options(unit, ['', 2, 4, 8, 16], { '': 'Herdar', 2: '/2', 4: '/4', 8: '/8', 16: '/16' }); unit.value = section.meter?.unit ?? '';
      unit.addEventListener('change', () => change(section.id, { meter: unit.value === '' ? null : { beats: section.meter?.beats ?? session.meter.beats, unit: Number(unit.value) } }));
      overrides.append(label(`Unidade · ${sectionLabel}`, unit, 'unit', true));
      const density = document.createElement('select'); options(density, ['', ...DENSITIES], { '': 'Herdar', ...densityLabels }); density.value = section.density ?? '';
      density.addEventListener('change', () => change(section.id, { density: density.value || null }));
      overrides.append(label(`Densidade da banda · ${sectionLabel}`, density, 'density', true));
      const hint = document.createElement('p'); hint.className = 'tool-hint muted'; hint.textContent = 'Campos vazios ou Herdar usam os valores da sessão.';
      const actions = document.createElement('div'); actions.className = 'form-actions';
      const button = (text, field, action, reason = '') => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.dataset.formField = field;
        button.dataset.disabledReason = reason; button.addEventListener('click', action); actions.append(button);
        if (reason) {
          const explanation = document.createElement('span'); explanation.className = 'tool-hint muted'; explanation.textContent = reason;
          explanation.id = `form-boundary-${index}-${field}`; button.setAttribute('aria-describedby', explanation.id); actions.append(explanation);
        }
      };
      button('Mover acima', 'up', () => move(section.id, -1), index === 0 ? 'Esta já é a primeira seção.' : '');
      button('Mover abaixo', 'down', () => move(section.id, 1), index === session.form.sections.length - 1 ? 'Esta já é a última seção.' : '');
      button('Excluir seção', 'remove', () => remove(section.id));
      popover.append(description, overrides, hint, actions); detail.append(summary, popover); cell(detail);
      list.append(row);
    }
    renderControls(); frame(lastPosition);
    if (focusedId && focusedField) {
      [...list.children].find(row => row.dataset.sectionId === focusedId)?.querySelector(`[data-form-field="${focusedField}"]`)?.focus({ preventScroll: true });
    }
  }
  function renderControls() {
    const session = host.getSession(); const locked = host.isBusy(); const empty = !session.form.sections.length;
    $('form-enabled').checked = session.form.enabled;
    $('form-enabled').disabled = locked || empty;
    $('form-enabled').title = empty ? emptyReason : locked ? lockedReason : '';
    $('form-loop').checked = session.form.loop;
    $('form-loop').disabled = locked;
    $('form-loop').title = locked ? lockedReason : '';
    $('add-section').disabled = locked || session.form.sections.length >= 32;
    $('add-section').title = locked ? lockedReason : session.form.sections.length >= 32 ? 'A forma já tem o limite de 32 seções.' : '';
    $('form-empty').hidden = !empty;
    $('form-table').hidden = empty;
    for (const control of list.querySelectorAll('input, select, button')) {
      control.disabled = locked || !!control.dataset.disabledReason;
      control.title = locked ? lockedReason : control.dataset.disabledReason || '';
    }
  }
  function frame(position) {
    lastPosition = position;
    const text = position.sectionId && position.mode === 'loop'
      ? `${position.sectionName} · repetição ${position.sectionRepeat} · compasso ${position.bar} da sessão · ${position.bpm} BPM · ${position.meter.beats}/${position.meter.unit}`
      : position.mode === 'train' || position.mode === 'countin' ? 'Treino no loop da sessão (forma não executada).'
        : host.getSession().form.enabled ? 'Forma pronta; reproduza para acompanhar as seções.' : 'Forma desativada: reprodução do loop da sessão.';
    if ($('form-position').textContent !== text) $('form-position').textContent = text;
    for (const row of list.children) {
      const active = position.mode === 'loop' && row.dataset.sectionId === position.sectionId;
      if (active && row.getAttribute('aria-current') !== 'step') row.setAttribute('aria-current', 'step');
      else if (!active && row.hasAttribute('aria-current')) row.removeAttribute('aria-current');
    }
  }
  return { render, renderControls, frame };
}
