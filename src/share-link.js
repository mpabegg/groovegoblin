// Compartilhamento por link: monta o endereço com a sessão no fragmento e
// trata a área de transferência sem deixar promessa sem tratamento. Uma sessão
// maior que o limite do link (128 compassos com muitas notas/edições) recebe um
// aviso para exportar o arquivo, em vez de um link truncado ou de um erro
// silencioso; a sessão atual nunca é alterada.
import { encodeSessionLink } from './session.js';
import { COURSE_EXPORT_NOTICE, isCourseContent, shareableSession } from './course-privacy.js';

export function shareUrl(session, location = globalThis.location, options = {}) {
  return `${location.origin}${location.pathname}${location.search}${encodeSessionLink(shareableSession(session, options))}`;
}

export function mountShareLink({ button, output, field, getSession, notify, location = globalThis.location }) {
  function copy(url, privateContent) {
    let attempt = null;
    try { attempt = navigator.clipboard?.writeText(url) ?? null; } catch { attempt = null; }
    Promise.resolve(attempt).then(
      () => notify(`${attempt === null ? 'Copie o link selecionado.' : 'Link do exercício copiado, sem servidor.'}${privateContent ? ` ${COURSE_EXPORT_NOTICE}` : ''}`),
      () => notify('Copie o link selecionado.'),
    );
  }
  button.addEventListener('click', () => {
    let url;
    const session = getSession();
    const privateContent = isCourseContent({ session });
    try {
      url = shareUrl(session, location, { privateContent });
    } catch (error) {
      output.hidden = true;
      notify(`Não foi possível gerar o link: ${error.message} Exporte o exercício em “Exportar exercício” e envie o arquivo; a sessão foi preservada.`, true);
      return;
    }
    field.value = url; output.hidden = false; field.focus(); field.select();
    if (privateContent) {
      let notice = output.querySelector('[data-course-export-notice]');
      if (!notice) {
        notice = document.createElement('p');
        notice.dataset.courseExportNotice = '';
        output.append(notice);
      }
      notice.textContent = COURSE_EXPORT_NOTICE;
    } else output.querySelector?.('[data-course-export-notice]')?.remove();
    copy(url, privateContent);
  });
}
