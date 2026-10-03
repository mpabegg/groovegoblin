import { BAR_OPTIONS, validPhrase } from './model.js';

// Histórico de estados {notes, bpm, bars}; cada nota guarda {id, start, duration}.
// O primeiro push estabelece a base (não há estado anterior a desfazer). Push
// distinto descarta o redo e acrescenta um snapshot; push estruturalmente igual
// ao atual não altera nem o ponteiro nem o redo. A ordem das notas faz parte do
// estado. O limite conta snapshots, incluindo o atual, e descarta os mais antigos.
// Snapshots são cópias profundas congeladas: undo/redo devolvem a mesma referência
// interna, sem permitir que o chamador a modifique. Campos fora do modelo não
// fazem parte do snapshot. Um limite deve ser inteiro positivo.
export class History {
  #limit;
  #states = [];
  #index = -1;

  constructor(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError('O limite do histórico deve ser um inteiro positivo.');
    }
    this.#limit = limit;
  }

  push(state) {
    if (
      state === null ||
      typeof state !== 'object' ||
      !BAR_OPTIONS.includes(state.bars) ||
      !Number.isInteger(state.bpm) ||
      state.bpm < 40 ||
      state.bpm > 240 ||
      !validPhrase(state.notes, state.bars)
    ) {
      throw new TypeError('O histórico requer uma frase válida com BPM entre 40 e 240.');
    }

    const current = this.#states[this.#index];
    if (
      current &&
      current.bpm === state.bpm &&
      current.bars === state.bars &&
      current.notes.length === state.notes.length &&
      current.notes.every((note, index) => {
        const next = state.notes[index];
        return note.id === next.id && note.start === next.start && note.duration === next.duration;
      })
    ) {
      return;
    }

    const snapshot = Object.freeze({
      notes: Object.freeze(state.notes.map(({ id, start, duration }) => Object.freeze({ id, start, duration }))),
      bpm: state.bpm,
      bars: state.bars,
    });
    this.#states.length = this.#index + 1;
    this.#states.push(snapshot);
    if (this.#states.length > this.#limit) this.#states.shift();
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

  get canUndo() {
    return this.#index > 0;
  }

  get canRedo() {
    return this.#index < this.#states.length - 1;
  }
}
