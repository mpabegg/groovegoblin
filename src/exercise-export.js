import { serializeSession } from './session.js';
import { COURSE_EXPORT_NOTICE, isCourseContent, shareableSession } from './course-privacy.js';

export function exportCurrentExercise({ library, session, download, notify }) {
  const entry = library.activeEntry();
  if (entry) {
    download(library.exportExercise(entry.id), 'groovegoblin-exercicio.json');
    if (isCourseContent({ entry, session: entry.session })) notify(COURSE_EXPORT_NOTICE);
    return;
  }
  const privateContent = isCourseContent({ session });
  download(serializeSession(shareableSession(session, { privateContent })), 'groovegoblin-documento-atual.json');
  notify(`Biblioteca indisponível: exportado só o documento musical atual, sem metadados. Baixe também os originais em Ajuda.${privateContent ? ` ${COURSE_EXPORT_NOTICE}` : ''}`, true);
}
