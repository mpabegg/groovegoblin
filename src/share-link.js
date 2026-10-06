// Compartilhamento por link: monta o endereço com a sessão no fragmento e
// trata a área de transferência sem deixar promessa sem tratamento. Uma sessão
// maior que o limite do link (64 compassos com muitas notas/edições) recebe um
// aviso para exportar o arquivo, em vez de um link truncado ou de um erro
// silencioso; a sessão atual nunca é alterada.
import { encodeSessionLink } from './session.js';

export function shareUrl(session, location = globalThis.location) {
  return `${location.origin}${location.pathname}${location.search}${encodeSessionLink(session)}`;
}

export function mountShareLink({ button, output, field, getSession, notify, location = globalThis.location }) {
  function copy(url) {
    let attempt = null;
    try { attempt = navigator.clipboard?.writeText(url) ?? null; } catch { attempt = null; }
    Promise.resolve(attempt).then(
      () => notify(attempt === null ? 'Copie o link selecionado.' : 'Link do exercício copiado, sem servidor.'),
      () => notify('Copie o link selecionado.'),
    );
  }
  button.addEventListener('click', () => {
    let url;
    try {
      url = shareUrl(getSession(), location);
    } catch (error) {
      output.hidden = true;
      notify(`Não foi possível gerar o link: ${error.message} Exporte o exercício em “Exportar exercício” e envie o arquivo; a sessão foi preservada.`, true);
      return;
    }
    field.value = url; output.hidden = false; field.focus(); field.select();
    copy(url);
  });
}
