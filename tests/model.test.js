import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validPhrase,
  addNote,
  moveNote,
  resizeNote,
  deleteNote,
  loadState,
  saveState,
} from '../src/model.js';

function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test('validPhrase: frase vazia e valida', () => {
  assert.equal(validPhrase([]), true);
});

test('validPhrase: end=16 e permitido (limite do compasso)', () => {
  assert.equal(validPhrase([{ id: 'a', start: 14, duration: 2 }]), true);
});

test('validPhrase: end=17 e rejeitado (fora do compasso)', () => {
  assert.equal(validPhrase([{ id: 'a', start: 15, duration: 2 }]), false);
});

test('validPhrase: notas adjacentes (fim == inicio) sao validas e distintas', () => {
  const notes = [
    { id: 'a', start: 0, duration: 4 },
    { id: 'b', start: 4, duration: 4 },
  ];
  assert.equal(validPhrase(notes), true);
});

test('validPhrase: sobreposicao e rejeitada', () => {
  const notes = [
    { id: 'a', start: 0, duration: 4 },
    { id: 'b', start: 3, duration: 4 },
  ];
  assert.equal(validPhrase(notes), false);
});

test('validPhrase: duracao com qualquer numero de ticks (inclui pontuadas) e valida', () => {
  assert.equal(validPhrase([{ id: 'a', start: 0, duration: 3 }]), true);
});

test('addNote: adiciona nota valida gerando id unico', () => {
  const result = addNote([], 0, 4);
  assert.equal(result.length, 1);
  assert.equal(typeof result[0].id, 'string');
  assert.ok(result[0].id.length > 0);
  assert.equal(result[0].start, 0);
  assert.equal(result[0].duration, 4);
});

test('addNote: ids gerados em chamadas sucessivas sao unicos', () => {
  let notes = addNote([], 0, 1);
  notes = addNote(notes, 2, 1);
  notes = addNote(notes, 4, 1);
  const ids = new Set(notes.map((n) => n.id));
  assert.equal(ids.size, 3);
});

test('addNote: end=16 no limite e aceito', () => {
  const result = addNote([], 14, 2);
  assert.equal(result.length, 1);
});

test('addNote: end=17 (acima do limite) e rejeitado, retorna o array original', () => {
  const original = [];
  const result = addNote(original, 15, 2);
  assert.equal(result, original);
});

test('addNote: sobreposicao e rejeitada, retorna o array original (mesma referencia)', () => {
  const original = addNote([], 0, 4);
  const result = addNote(original, 2, 2);
  assert.equal(result, original);
  assert.equal(result.length, 1);
});

test('addNote: notas adjacentes distintas nao se fundem', () => {
  let notes = addNote([], 0, 4);
  notes = addNote(notes, 4, 4);
  assert.equal(notes.length, 2);
  assert.notEqual(notes[0].id, notes[1].id);
});

test('addNote: mantém frase original congelada e produz nova nota editável', () => {
  const original = Object.freeze([]);
  const result = addNote(original, 0, 1);
  assert.deepEqual(original, []);
  assert.deepEqual(result.map(({start, duration}) => ({start, duration})), [{start: 0, duration: 1}]);
  const moved = moveNote(result, result[0].id, 4);
  assert.equal(result[0].start, 0);
  assert.equal(moved[0].start, 4);
});

test('moveNote: move para posicao livre com sucesso, preservando duracao', () => {
  let notes = addNote([], 0, 4);
  const id = notes[0].id;
  notes = moveNote(notes, id, 8);
  assert.equal(notes[0].start, 8);
  assert.equal(notes[0].duration, 4);
});

test('moveNote: deslocamento mantém a duracao correta mesmo apos multiplos movimentos', () => {
  let notes = addNote([], 0, 3);
  const id = notes[0].id;
  notes = moveNote(notes, id, 5);
  notes = moveNote(notes, id, 10);
  assert.equal(notes[0].start, 10);
  assert.equal(notes[0].duration, 3);
});

test('moveNote: rejeita sobreposicao com outra nota, retorna array original', () => {
  let notes = addNote([], 0, 4);
  notes = addNote(notes, 8, 4);
  const movingId = notes[0].id;
  const result = moveNote(notes, movingId, 6);
  assert.equal(result, notes);
});

test('moveNote: rejeita mover para fora do compasso (end>16)', () => {
  let notes = addNote([], 0, 2);
  const id = notes[0].id;
  const result = moveNote(notes, id, 15);
  assert.equal(result, notes);
});

test('moveNote: id inexistente retorna array original', () => {
  const notes = addNote([], 0, 2);
  const result = moveNote(notes, 'inexistente', 5);
  assert.equal(result, notes);
});

test('resizeNote: redimensiona com sucesso mantendo start', () => {
  let notes = addNote([], 0, 2);
  const id = notes[0].id;
  notes = resizeNote(notes, id, 5);
  assert.equal(notes[0].start, 0);
  assert.equal(notes[0].duration, 5);
});

test('resizeNote: rejeita quando ultrapassa end=16', () => {
  let notes = addNote([], 10, 2);
  const id = notes[0].id;
  const result = resizeNote(notes, id, 10);
  assert.equal(result, notes);
});

test('resizeNote: permite crescer exatamente até end=16', () => {
  let notes = addNote([], 10, 2);
  const id = notes[0].id;
  notes = resizeNote(notes, id, 6);
  assert.equal(notes[0].duration, 6);
});

test('resizeNote: rejeita sobreposicao com vizinho ao crescer', () => {
  let notes = addNote([], 0, 2);
  notes = addNote(notes, 4, 2);
  const id = notes[0].id;
  const result = resizeNote(notes, id, 5);
  assert.equal(result, notes);
});

test('deleteNote: remove nota existente', () => {
  let notes = addNote([], 0, 2);
  const id = notes[0].id;
  notes = deleteNote(notes, id);
  assert.equal(notes.length, 0);
});

test('deleteNote: id inexistente retorna array original', () => {
  const notes = addNote([], 0, 2);
  const result = deleteNote(notes, 'inexistente');
  assert.equal(result, notes);
});

test('restauracao: saveState seguido de loadState recupera frase e bpm exatos', () => {
  const storage = createStorage();
  const notes = addNote([], 0, 4);
  const ok = saveState(notes, 120, 1, storage);
  assert.equal(ok, true);

  const state = loadState(storage);
  assert.deepEqual(state.notes, notes);
  assert.equal(state.bpm, 120);
  assert.equal(state.warning, null);
});

test('loadState: JSON corrompido usa padrao com aviso', () => {
  const storage = createStorage({ 'groovegoblin.v1': '{nao e json' });
  const state = loadState(storage);
  assert.deepEqual(state.notes, []);
  assert.equal(state.bpm, 100);
  assert.ok(typeof state.warning === 'string' && state.warning.length > 0);
});

test('loadState: bpm invalido (fora de 40..240) usa padrao com aviso, mantendo frase valida', () => {
  const storage = createStorage({
    'groovegoblin.v1': JSON.stringify({ notes: [{ id: 'a', start: 0, duration: 1 }], bpm: 300 }),
  });
  const state = loadState(storage);
  assert.deepEqual(state.notes, [{ id: 'a', start: 0, duration: 1 }]);
  assert.equal(state.bpm, 100);
  assert.ok(typeof state.warning === 'string' && state.warning.length > 0);
});

test('loadState: frase invalida (sobreposicao) usa frase vazia com aviso, mantendo bpm valido', () => {
  const storage = createStorage({
    'groovegoblin.v1': JSON.stringify({
      notes: [
        { id: 'a', start: 0, duration: 4 },
        { id: 'b', start: 2, duration: 4 },
      ],
      bpm: 90,
    }),
  });
  const state = loadState(storage);
  assert.deepEqual(state.notes, []);
  assert.equal(state.bpm, 90);
  assert.ok(typeof state.warning === 'string' && state.warning.length > 0);
});

test('loadState: falha ao acessar storage retorna padrao com aviso, sem lancar', () => {
  const storage = {
    getItem() {
      throw new Error('indisponivel');
    },
  };
  const state = loadState(storage);
  assert.deepEqual(state.notes, []);
  assert.equal(state.bpm, 100);
  assert.ok(typeof state.warning === 'string' && state.warning.length > 0);
});

test('saveState: bpm fora de 40..240 e rejeitado (retorna false, nao escreve)', () => {
  const storage = createStorage();
  const ok = saveState([], 10, 1, storage);
  assert.equal(ok, false);
  assert.equal(storage.getItem('groovegoblin.v1'), null);
});

test('saveState: falha ao escrever no storage retorna false, sem lancar', () => {
  const storage = {
    setItem() {
      throw new Error('quota excedida');
    },
  };
  const ok = saveState([], 100, 1, storage);
  assert.equal(ok, false);
});

test('armazenamento bloqueado no getter mantém operação em memória com aviso', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('Armazenamento bloqueado', 'SecurityError'); },
  });
  const state = loadState();
  assert.deepEqual(state.notes, []);
  assert.match(state.warning, /armazenamento/i);
  const phrase = addNote(state.notes, 4, 3);
  assert.deepEqual(phrase.map(({start, duration}) => ({start, duration})), [{start: 4, duration: 3}]);
  assert.equal(saveState(phrase, 100, 1), false);
});

test('quantização rejeita início fracionário, duração zero e posições negativas', () => {
  const notes = addNote([], 4, 3);
  const id = notes[0].id;
  assert.equal(addNote(notes, 0.5), notes);
  assert.equal(moveNote(notes, id, -1), notes);
  assert.equal(moveNote(notes, id, 4.5), notes);
  assert.equal(resizeNote(notes, id, 0), notes);
  assert.equal(resizeNote(notes, id, 2.5), notes);
  assert.deepEqual(notes.map(({start, duration}) => ({start, duration})), [{start: 4, duration: 3}]);
});

test('BPM fracionário não substitui dados válidos previamente salvos', () => {
  const storage = createStorage();
  const notes = addNote([], 4, 6);
  saveState(notes, 120, 1, storage);
  assert.equal(saveState([], 120.5, 1, storage), false);
  assert.deepEqual(loadState(storage).notes, notes);
  assert.equal(loadState(storage).bpm, 120);
});

test('frases de múltiplos compassos: validPhrase aceita notas além do 16º tick apenas com bars suficiente', () => {
  const twoBars = [{id: 'a', start: 20, duration: 8}];
  assert.equal(validPhrase(twoBars, 2), true);
  assert.equal(validPhrase(twoBars, 1), false);
  assert.equal(validPhrase(twoBars, 4), true);
  assert.equal(validPhrase(twoBars, 3), false);
});

test('frases de múltiplos compassos: edições respeitam o limite do tamanho atual', () => {
  let notes = addNote([], 20, 8, 2);
  assert.deepEqual(notes.map(({start, duration}) => ({start, duration})), [{start: 20, duration: 8}]);
  const id = notes[0].id;
  assert.equal(addNote(notes, 31, 2, 2), notes);
  assert.equal(moveNote(notes, id, 24, 2).find(n => n.id === id).start, 24);
  assert.equal(resizeNote(notes, id, 12, 2).find(n => n.id === id).duration, 12);
  assert.equal(resizeNote(notes, id, 13, 2), notes);
  const grown = addNote(notes, 40, 16, 4);
  assert.equal(grown.length, 2);
  assert.equal(moveNote(grown, id, 30, 2), grown);
});

test('persistência: frase de 2 compassos salva e restaurada com o mesmo tamanho', () => {
  const storage = createStorage();
  const notes = addNote(addNote([], 0, 4, 2), 20, 8, 2);
  assert.equal(saveState(notes, 96, 2, storage), true);
  const state = loadState(storage);
  assert.deepEqual(state.notes, notes);
  assert.equal(state.bpm, 96);
  assert.equal(state.bars, 2);
  assert.equal(state.warning, null);
});

test('persistência: dados antigos sem "bars" são restaurados como frase de 1 compasso', () => {
  const storage = createStorage({
    'groovegoblin.v1': JSON.stringify({notes: [{id: 'a', start: 8, duration: 4}], bpm: 110}),
  });
  const state = loadState(storage);
  assert.deepEqual(state.notes, [{id: 'a', start: 8, duration: 4}]);
  assert.equal(state.bars, 1);
  assert.equal(state.warning, null);
});
