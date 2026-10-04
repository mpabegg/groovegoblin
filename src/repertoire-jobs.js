// Cliente do worker de repertório: uma tarefa por vez, progresso e cancelamento.
// Cancelar encerra o worker (único modo de interromper laços síncronos de DSP) e
// um novo worker é criado sob demanda na próxima tarefa.

export class JobCancelledError extends Error {
  constructor() {
    super('Tarefa cancelada.');
    this.name = 'JobCancelledError';
  }
}

export function createJobRunner({ workerUrl = new URL('./repertoire-worker.js', import.meta.url), WorkerClass = globalThis.Worker } = {}) {
  let worker = null;
  let active = null;
  let sequence = 0;

  function ensureWorker() {
    if (!WorkerClass) throw new Error('Este navegador não oferece Web Workers; a análise local não pode rodar sem travar a página.');
    if (worker) return worker;
    worker = new WorkerClass(workerUrl, { type: 'module' });
    worker.onmessage = event => {
      const message = event.data;
      if (!active || message.id !== active.id) return;
      if (message.type === 'progress') active.onProgress?.(message.stage, message.fraction);
      else if (message.type === 'result') finish(job => job.resolve(message.result));
      else if (message.type === 'error') finish(job => job.reject(new Error(message.message)));
    };
    worker.onerror = event => {
      event.preventDefault?.();
      const message = event.message ? `Falha no processamento local: ${event.message}` : 'Falha ao carregar o processamento local (worker).';
      reset();
      finish(job => job.reject(new Error(message)));
    };
    return worker;
  }

  function finish(settle) {
    const job = active;
    active = null;
    if (job) settle(job);
  }

  function reset() {
    worker?.terminate();
    worker = null;
  }

  return {
    get busy() { return active !== null; },
    get stage() { return active?.label ?? null; },
    run(type, payload, { transfer = [], onProgress, label = type } = {}) {
      if (active) return Promise.reject(new Error('Já existe um processamento em andamento; aguarde ou cancele.'));
      let target;
      try {
        target = ensureWorker();
      } catch (error) {
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => {
        active = { id: ++sequence, resolve, reject, onProgress, label };
        target.postMessage({ id: active.id, type, payload }, transfer);
      });
    },
    cancel() {
      if (!active) return false;
      reset();
      finish(job => job.reject(new JobCancelledError()));
      return true;
    },
    dispose() {
      this.cancel();
      reset();
    },
  };
}
