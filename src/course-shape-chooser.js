// Diálogo de escolha da forma do catálogo (rodada 6, etapa 5 — A5/A6).
//
// O catálogo referencia a forma pelo RÓTULO e não traz a digitação: na hora de
// gerar, o app PEDE a forma correspondente ("Shape 1" da qualidade e inversão
// tais) — escolher uma das que o usuário já tem (o painel Braço as guarda) ou
// criar uma nova. A escolha é lembrada pelo rótulo (course-shape-binding.js) e
// vale para as próximas aulas com o mesmo rótulo.
//
// Regras: nada é inventado (a lista vem da loja de formas, A3, injetada pelo
// host); um botão só aparece quando tem efeito (o "Abrir o Braço" só existe com
// o gancho ligado); o diálogo é nativo (`<dialog>`), então Esc, foco e leitura
// de tela seguem o navegador. Um único controle novo aparece no repouso da
// página — o botão que abre este diálogo.

import { createEl } from './practice.js';

export const SHAPE_CHOOSER_HINT = 'A forma é um molde de digitação: o mesmo rótulo vale para as próximas aulas até você trocar a escolha.';

function optionLabel(choice) {
  const parts = [choice?.label ?? choice?.id ?? 'forma'];
  if (choice?.generic) parts.push('(exemplo)');
  if (choice?.reused) parts.push('(de 4 cordas)');
  return parts.join(' ');
}

export function mountShapeChooser(container, { notify = null, onCreate = null } = {}) {
  if (container && typeof container.appendChild !== 'function') throw new TypeError('Informe um contêiner DOM para o diálogo da forma.');
  let dialog = null;
  let pending = null;

  function resolve(value) {
    const current = pending;
    pending = null;
    if (dialog?.open) dialog.close();
    if (current) current(value);
  }

  function build() {
    dialog = createEl('dialog', { id: 'lesson-shape-chooser', className: 'shape-chooser' });
    const form = createEl('form', { method: 'dialog' });
    form.append(createEl('h3', { id: 'lesson-shape-chooser-title', text: 'Escolher a forma deste exercício' }));
    const detail = createEl('p', { id: 'lesson-shape-chooser-detail', className: 'muted', text: '' });
    const select = createEl('select', { id: 'lesson-shape-chooser-select', 'aria-describedby': 'lesson-shape-chooser-hint' });
    const empty = createEl('p', { id: 'lesson-shape-chooser-empty', className: 'muted', hidden: true, text: '' });
    const remember = createEl('input', { id: 'lesson-shape-chooser-remember', type: 'checkbox', checked: true });
    const hint = createEl('p', { id: 'lesson-shape-chooser-hint', className: 'muted', text: SHAPE_CHOOSER_HINT });
    const confirm = createEl('button', { id: 'lesson-shape-chooser-confirm', type: 'submit', className: 'primary', text: 'Usar esta forma' });
    const cancel = createEl('button', { id: 'lesson-shape-chooser-cancel', type: 'button', text: 'Cancelar' });
    const create = createEl('button', { id: 'lesson-shape-chooser-create', type: 'button', text: 'Criar no painel Braço' });
    create.hidden = typeof onCreate !== 'function';
    cancel.addEventListener('click', () => resolve(null));
    create.addEventListener('click', () => {
      try { onCreate?.(); } catch (error) { notify?.(`Não foi possível abrir o painel Braço: ${error?.message ?? error}`, true); }
      resolve(null);
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const shapeId = select.value;
      if (shapeId === '') { notify?.('Escolha uma forma para gerar o exercício.', true); return; }
      resolve({ shapeId, remember: remember.checked === true });
    });
    form.append(
      detail,
      createEl('label', { className: 'shape-chooser-field' }, [createEl('span', { text: 'Forma' }), select]),
      empty,
      createEl('label', { className: 'shape-chooser-remember' }, [remember, createEl('span', { text: 'Lembrar esta forma para as próximas aulas com este rótulo' })]),
      hint,
      createEl('div', { className: 'shape-chooser-actions' }, [confirm, create, cancel]),
    );
    dialog.append(form);
    if (container) container.appendChild(dialog);
    return dialog;
  }

  return {
    // `choices` vem da loja de formas (mesma qualidade do rótulo). Devolve
    // `{ shapeId, remember }` ou null quando o usuário desiste.
    ask({ label = null, quality = null, inversion = null, choices = [], instrument = null } = {}) {
      if (pending) resolve(null);
      if (!dialog) build();
      const title = dialog.querySelector('#lesson-shape-chooser-title');
      const detail = dialog.querySelector('#lesson-shape-chooser-detail');
      const select = dialog.querySelector('#lesson-shape-chooser-select');
      const empty = dialog.querySelector('#lesson-shape-chooser-empty');
      const hint = dialog.querySelector('#lesson-shape-chooser-hint');
      const confirm = dialog.querySelector('#lesson-shape-chooser-confirm');
      const remember = dialog.querySelector('#lesson-shape-chooser-remember');
      const name = label ?? 'forma do curso';
      title.textContent = `Forma de “${name}”`;
      const where = [quality, inversion, instrument].filter(value => typeof value === 'string' && value.trim() !== '');
      detail.textContent = where.length > 0
        ? `O curso indica a forma ${where.join(' · ')}. Escolha a sua equivalente para gerar o exercício com notas.`
        : 'O curso indica uma forma para este exercício. Escolha a sua equivalente para gerar o exercício com notas.';
      select.replaceChildren();
      select.append(createEl('option', { value: '', text: 'Escolha uma forma…' }));
      for (const choice of choices) {
        select.append(createEl('option', { value: choice.id, text: optionLabel(choice) }));
      }
      select.value = '';
      select.disabled = choices.length === 0;
      confirm.disabled = choices.length === 0;
      empty.hidden = choices.length > 0;
      empty.textContent = choices.length === 0
        ? 'Você ainda não tem uma forma desta qualidade com posição neste instrumento. Crie uma no painel Braço (ou escolha uma forma de exemplo e ajuste depois): o exercício gerado continua editável.'
        : '';
      remember.checked = true;
      hint.textContent = SHAPE_CHOOSER_HINT;
      return new Promise(resolvePromise => {
        pending = resolvePromise;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else resolve(null);
        select.focus({ preventScroll: true });
      });
    },
    destroy() {
      resolve(null);
      dialog?.remove();
      dialog = null;
    },
  };
}
