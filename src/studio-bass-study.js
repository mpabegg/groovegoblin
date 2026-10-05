import { STYLES, DENSITIES, STYLE_LABELS, DENSITY_LABELS } from './session.js';
import { generateBass } from './band.js';
import { getInstrumentProfile } from './instrument-profile.js';
import { generatedBassPhrasePatch, studyBassLinePatch, bassStudyNotice, bassOverlapCount, playablePitch } from './bass-study.js';
import { saveInstrumentPreference } from './studio-session.js';
import { setStudioDetailsOpen } from './studio-popovers.js';

export function mountStudioBassStudy(host) {
  const $ = id => document.getElementById(id);
  const tools = document.createElement('details'); tools.id = 'bass-phrase-tools'; tools.className = 'track-disclosure';
  const summary = document.createElement('summary'); summary.textContent = 'Gerar linha de baixo';
  const popover = document.createElement('div'); popover.className = 'track-popover';
  const row = document.createElement('div'); row.className = 'tool-row';
  function select(id, name, values, labels) {
    const label = document.createElement('label'); label.textContent = name;
    const node = document.createElement('select'); node.id = id; node.setAttribute('aria-label', `${name} da linha de baixo editável`);
    for (const value of values) { const option = document.createElement('option'); option.value = value; option.textContent = labels[value]; node.append(option); }
    label.append(node); row.append(label); return node;
  }
  const style = select('bass-phrase-style', 'Estilo', STYLES, STYLE_LABELS);
  const density = select('bass-phrase-density', 'Densidade', DENSITIES, DENSITY_LABELS);
  const generate = document.createElement('button'); generate.id = 'generate-bass-phrase'; generate.type = 'button'; generate.textContent = 'Gerar na minha parte'; row.append(generate);
  const hint = document.createElement('p'); hint.className = 'tool-hint muted'; hint.textContent = 'Segue os acordes em todos os compassos. Notas novas usam a oitava tocável mais próxima nas cordas atuais (casas 0–24). Sustentações sobrepostas param no próximo ataque; a banda não muda.';
  popover.append(row, hint); tools.append(summary, popover); $('track-phrase').querySelector('.track-extra').prepend(tools);
  const study = document.createElement('button'); study.id = 'study-bass-line'; study.type = 'button'; study.textContent = 'Estudar esta linha'; study.setAttribute('aria-haspopup', 'dialog');
  $('track-bass').querySelector('.track-extra').prepend(study);
  const dialog = document.createElement('dialog'); dialog.id = 'bass-study-decision'; dialog.className = 'shortcuts-dialog'; dialog.setAttribute('aria-labelledby', 'bass-study-title'); dialog.setAttribute('aria-describedby', 'bass-study-description');
  const title = document.createElement('h2'); title.id = 'bass-study-title';
  const description = document.createElement('p'); description.id = 'bass-study-description';
  const actions = document.createElement('div'); actions.className = 'tool-row';
  const apply = document.createElement('button'); apply.id = 'bass-study-apply'; apply.type = 'button'; apply.textContent = 'Substituir minha frase';
  const cancel = document.createElement('button'); cancel.id = 'bass-study-cancel'; cancel.type = 'button'; cancel.textContent = 'Cancelar';
  actions.append(apply, cancel); dialog.append(title, description, actions); document.body.append(dialog);
  let request = null; let previousFocus = null;
  function dismiss() { request = null; dialog.close(); }
  cancel.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', () => { request = null; });
  dialog.addEventListener('close', () => {
    request = null;
    const movedToBass = previousFocus === study && getInstrumentProfile(host.getSession()).type === 'bass';
    const focus = movedToBass || (previousFocus === generate && !tools.open) ? summary : previousFocus;
    focus?.focus({ preventScroll: true }); previousFocus = null;
  });
  dialog.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); });
  function commit(value) {
    if (value.session !== host.getSession()) { dismiss(); host.notify('Sessão alterada; escolha a linha novamente.', true); return; }
    if (host.updateSession(value.patch, { structural: true, notice: value.notice })) {
      // Keep the history-bound undo notice and the musical adaptation visible when storage fails.
      if (value.copied && !saveInstrumentPreference(value.profile)) host.notifyAction(`${value.notice} Não foi possível lembrar o perfil para novas sessões.`, '', null);
      setStudioDetailsOpen(tools, false); if (dialog.open) dismiss();
    }
  }
  apply.addEventListener('click', () => { if (request && !host.isBusy()) commit(request); });
  function choose(copied) {
    if (host.isBusy()) return;
    try {
      const session = host.getSession();
      const options = { style: style.value, density: density.value };
      const sourceSession = copied ? session : { ...session, band: { ...session.band, ...options } };
      const source = generateBass(sourceSession);
      if (!source.length) { host.notify('Não há notas de baixo neste trecho harmônico. A frase foi preservada.', true); return; }
      const patch = copied ? studyBassLinePatch(session) : generatedBassPhrasePatch(session, options);
      const profile = copied ? patch.extensions.studio.instrument : getInstrumentProfile(session);
      const shortened = bassOverlapCount(source);
      const notice = bassStudyNotice(patch, profile, copied, shortened);
      const value = { session, patch, profile, copied, notice };
      if (!copied && !session.notes.length) { commit(value); return; }
      request = value; previousFocus = document.activeElement;
      title.textContent = copied ? 'Estudar a linha de baixo gerada?' : 'Gerar e substituir sua frase?';
      const outside = patch.notes.filter(note => !playablePitch(note.pitch, profile)).length;
      description.textContent = `${copied ? 'Trocar para Baixo de 4 cordas padrão, desligar somente o baixo gerado e copiar a linha real, incluindo seu timbre?' : 'Gerar uma linha na afinação atual? Oitavas novas são ajustadas apenas quando necessário às casas 0–24.'} A frase atual será substituída somente ao confirmar; Desfazer recupera tudo numa única ação. BPM, swing, compassos, acordes, bateria e mix são preservados. ${shortened ? `${shortened} sustentações sobrepostas serão encurtadas até o próximo ataque para manter monofonia; ataques, alturas e dinâmicas são preservados. ` : ''}${outside ? `${outside} notas fora do alcance serão mantidas sem retunar nem remover. ` : ''}Shuffle/jazz mantém os ataques e durações sonoros sem aplicar o swing global duas vezes.`;
      dialog.showModal(); cancel.focus({ preventScroll: true });
    } catch (error) { host.notify(error.message, true); }
  }
  generate.addEventListener('click', () => choose(false)); study.addEventListener('click', () => choose(true));
  tools.addEventListener('toggle', () => { if (tools.open) { const session = host.getSession(); style.value = session.band.style; density.value = session.band.density; } });
  function render() {
    const session = host.getSession(); const bass = getInstrumentProfile(session).type === 'bass';
    tools.hidden = !bass; study.hidden = bass;
    if (!bass && tools.open) setStudioDetailsOpen(tools, false);
    if (!tools.open) { style.value = session.band.style; density.value = session.band.density; }
  }
  render();
  return { render };
}
