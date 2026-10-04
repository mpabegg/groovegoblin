import { validateSession } from './session.js';

// Histórico de sessões completas (session.js). O primeiro push estabelece a
// base (não há estado anterior a desfazer). Push distinto descarta o redo e
// acrescenta um snapshot; push estruturalmente igual ao atual não altera nem
// o ponteiro nem o redo. A ordem das notas faz parte do estado. O limite
// conta snapshots, incluindo o atual, e descarta os mais antigos.
// Snapshots são sessões canônicas profundas e congeladas: undo/redo devolvem
// a mesma referência interna, sem permitir que o chamador a modifique.
// Quem consome decide o que é uma edição (ex.: mexer só no mixer não precisa
// de push). Um limite deve ser inteiro positivo.
function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

export class History {
  #limit;
  #states = [];
  #keys = [];
  #index = -1;

  constructor(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError('O limite do histórico deve ser um inteiro positivo.');
    }
    this.#limit = limit;
  }

  push(session) {
    const result = validateSession(session);
    if (!result.ok) throw new TypeError(`O histórico requer uma sessão válida: ${result.error}`);
    const key = JSON.stringify(result.session);
    if (this.#keys[this.#index] === key) return;

    this.#states.length = this.#index + 1;
    this.#keys.length = this.#index + 1;
    this.#states.push(freezeDeep(result.session));
    this.#keys.push(key);
    if (this.#states.length > this.#limit) {
      this.#states.shift();
      this.#keys.shift();
    }
    this.#index = this.#states.length - 1;
  }

  undo() {
    if (!this.canUndo) return null;
    this.#index -= 1;
    return this.#states[this.#index];
  }

  redo() {
    if (!this.canRedo) return null;
    this.#index += 1;
    return this.#states[this.#index];
  }

  get current() {
    return this.#states[this.#index] ?? null;
  }

  get canUndo() {
    return this.#index > 0;
  }

  get canRedo() {
    return this.#index < this.#states.length - 1;
  }
}
