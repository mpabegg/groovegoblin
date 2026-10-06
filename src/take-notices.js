// O resultado do treino já é o retorno de uma tomada concluída: as confirmações
// automáticas de guardar (repertório e playground) continuam acontecendo, mas
// sem o aviso de sucesso naquele momento. Falhas (error=true) e todos os demais
// avisos passam intactos; nenhum módulo de repertório/playground é alterado.
export const TAKE_SAVED_PREFIX = 'Tomada guardada em “Estudar uma música” (';
export const PLAYGROUND_SAVED_PREFIX = 'Tentativa do treino guardada no playground';

export function quietTakeNotices(notify) {
  let capturing = 0;
  const automatic = text => typeof text === 'string'
    && (text.startsWith(TAKE_SAVED_PREFIX) || text.startsWith(PLAYGROUND_SAVED_PREFIX));
  return {
    notify(text, error = false) {
      if (capturing > 0 && !error && automatic(text)) return;
      notify(text, error);
    },
    // Janela da gravação automática (assíncrona no repertório).
    async capture(save) {
      capturing += 1;
      try { return await save(); } finally { capturing -= 1; }
    },
    // Janela de um trecho síncrono (a captura automática do playground).
    around(run) {
      capturing += 1;
      try { return run(); } finally { capturing -= 1; }
    },
  };
}
