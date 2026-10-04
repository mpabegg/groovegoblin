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
  loadPreferences,
  savePreferences,
  MIXER_CHANNELS,
  loadMixer,
  saveMixer,
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
  assert.equal(state.recoveryRaw, null);
  assert.equal(state.storageAvailable, true);
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
  assert.equal(state.recoveryRaw, null);
  assert.equal(state.storageAvailable, false);
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
  assert.ok(typeof state.warning === 'string' && state.warning.length > 0);
  assert.equal(state.recoveryRaw, null);
  assert.equal(state.storageAvailable, false);
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

test('loadState: armazenamento vazio disponível não requer escrita', () => {
  let reads = 0;
  const storage = {
    getItem(key) {
      assert.equal(key, 'groovegoblin.v1');
      reads += 1;
      return null;
    },
    setItem() { assert.fail('loadState não deve escrever'); },
    removeItem() { assert.fail('loadState não deve remover'); },
  };
  assert.deepEqual(loadState(storage), {
    notes: [], bpm: 100, bars: 1,
    warning: null, recoveryRaw: null, storageAvailable: true,
  });
  assert.equal(reads, 1);
});

test('loadState: estado válido mantém bytes salvos sem solicitar recuperação', () => {
  for (const bars of [undefined, 1, 2, 4]) {
    const document = {
      notes: [{ id: 'original-ç', start: 8, duration: 4 }],
      bpm: 110,
      ...(bars === undefined ? {} : { bars }),
    };
    const raw = ` \n${JSON.stringify(document, null, 2)}\n `;
    const storage = createStorage({ 'groovegoblin.v1': raw });
    storage.setItem = () => assert.fail('loadState não deve escrever');
    storage.removeItem = () => assert.fail('loadState não deve remover');
    assert.deepEqual(loadState(storage), {
      notes: document.notes, bpm: 110, bars: bars ?? 1,
      warning: null, recoveryRaw: null, storageAvailable: true,
    });
    assert.equal(storage.getItem('groovegoblin.v1'), raw);
  }
});

test('loadState: dados corrompidos preservam conteúdo original exato para recuperação', () => {
  const payloads = [
    '', '  {não é JSON}\r\n', 'null', ' [] ', '42', '"texto"',
    ' {\n "notes": [], "bpm": "100", "bars": 1\n}\n',
    JSON.stringify({ notes: [], bpm: 39, bars: 1 }),
    JSON.stringify({ notes: [], bpm: 241, bars: 1 }),
    JSON.stringify({ notes: [], bpm: 100.5, bars: 1 }),
    JSON.stringify({ notes: [], bars: 1 }),
    JSON.stringify({ notes: null, bpm: 100, bars: 1 }),
    JSON.stringify({ bpm: 100, bars: 1 }),
    JSON.stringify({ notes: [{ id: 'fora', start: 16, duration: 1 }], bpm: 100 }),
    JSON.stringify({
      notes: [{ id: 'a', start: 0, duration: 4 }, { id: 'b', start: 2, duration: 4 }],
      bpm: 90,
    }),
  ];
  for (const raw of payloads) {
    const storage = createStorage({ 'groovegoblin.v1': raw });
    storage.setItem = () => assert.fail('loadState não deve sobrescrever dados inválidos');
    storage.removeItem = () => assert.fail('loadState não deve remover dados inválidos');
    const state = loadState(storage);
    assert.equal(state.recoveryRaw, raw);
    assert.equal(state.storageAvailable, true);
    assert.ok(typeof state.warning === 'string' && state.warning.length > 0);
    assert.equal(storage.getItem('groovegoblin.v1'), raw);
    assert.equal(loadState(storage).recoveryRaw, raw);
  }
});

for (const bars of [null, 0, 3, -1, 1.5, '1', false, [], {}]) {
  test(`loadState: bars explícito inválido ${JSON.stringify(bars)} exige recuperação`, () => {
    const notes = [{ id: 'mantida', start: 0, duration: 4 }];
    const raw = `\n${JSON.stringify({ notes, bpm: 120, bars }, null, 2)}\n`;
    const storage = createStorage({ 'groovegoblin.v1': raw });
    const state = loadState(storage);
    assert.deepEqual(state.notes, notes);
    assert.equal(state.bpm, 120);
    assert.equal(state.bars, 1);
    assert.ok(typeof state.warning === 'string' && state.warning.length > 0);
    assert.equal(state.recoveryRaw, raw);
    assert.equal(state.storageAvailable, true);
    assert.equal(storage.getItem('groovegoblin.v1'), raw);
  });
}

test('loadState: armazenamento global ausente retorna disponibilidade falsa', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  delete globalThis.localStorage;
  const state = loadState();
  assert.equal(state.storageAvailable, false);
  assert.equal(state.recoveryRaw, null);
  assert.deepEqual(state.notes, []);
  assert.equal(state.bpm, 100);
  assert.equal(state.bars, 1);
  assert.ok(typeof state.warning === 'string' && state.warning.length > 0);
});

const defaultPreferences = {
  metronome: true, density: 'medium', syncopation: 'mixed', lengths: 'mixed', seed: null,
};
const validPreferences = {
  metronome: false, density: 'busy', syncopation: 'syncopated', lengths: 'long', seed: 123456,
};

test('preferências: ausência retorna padrões sem acessar ou alterar a frase salva', () => {
  const phraseRaw = '  {"notes":[],"bpm":100,"bars":1}\n';
  const storage = createStorage({ 'groovegoblin.v1': phraseRaw });
  const getItem = storage.getItem;
  storage.getItem = (key) => {
    assert.equal(key, 'groovegoblin.preferences.v1');
    return getItem(key);
  };
  storage.setItem = () => assert.fail('loadPreferences não deve escrever');
  storage.removeItem = () => assert.fail('loadPreferences não deve remover');
  const first = loadPreferences(storage);
  assert.deepEqual(first, defaultPreferences);
  first.density = 'busy';
  assert.deepEqual(loadPreferences(storage), defaultPreferences);
  assert.equal(getItem('groovegoblin.v1'), phraseRaw);
});

test('preferências: round-trip preserva todos os campos e mantém a frase salva intacta', () => {
  const phraseRaw = ' \n{frase inválida preservada}\r\n';
  const storage = createStorage({ 'groovegoblin.v1': phraseRaw });
  const preferences = Object.freeze({ ...validPreferences });
  const snapshot = structuredClone(preferences);
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    assert.equal(key, 'groovegoblin.preferences.v1');
    setItem(key, value);
  };
  assert.equal(savePreferences(preferences, storage), true);
  assert.deepEqual(loadPreferences(storage), preferences);
  assert.deepEqual(preferences, snapshot);
  assert.equal(storage.getItem('groovegoblin.v1'), phraseRaw);
  assert.deepEqual(JSON.parse(storage.getItem('groovegoblin.preferences.v1')), preferences);
});

test('preferências: aceita todas as opções e limites uint32 da semente', () => {
  const storage = createStorage();
  for (const metronome of [true, false]) {
    for (const density of ['sparse', 'medium', 'busy']) {
      for (const syncopation of ['straight', 'mixed', 'syncopated']) {
        for (const lengths of ['short', 'mixed', 'long']) {
          for (const seed of [0, 0xffffffff]) {
            const preferences = { metronome, density, syncopation, lengths, seed };
            assert.equal(savePreferences(preferences, storage), true);
            assert.deepEqual(loadPreferences(storage), preferences);
          }
        }
      }
    }
  }
});

test('preferências: JSON inválido e valores não-objeto usam padrões sem reescrever', () => {
  for (const raw of ['', '{inválido', 'null', '[]', 'true', '42', '"texto"']) {
    const storage = createStorage({ 'groovegoblin.preferences.v1': raw });
    storage.setItem = () => assert.fail('loadPreferences não deve escrever');
    assert.deepEqual(loadPreferences(storage), defaultPreferences);
    assert.equal(storage.getItem('groovegoblin.preferences.v1'), raw);
  }
});

const invalidPreferenceFields = {
  metronome: [null, 0, 1, 'false', [], {}],
  density: [null, false, 'dense', 'Medium', 1, [], {}],
  syncopation: [null, false, 'swing', 'Mixed', 1, [], {}],
  lengths: [null, false, 'medium', 'Long', 1, [], {}],
  seed: [null, -1, 0x100000000, 1.5, '123', false, [], {}],
};

for (const [field, invalidValues] of Object.entries(invalidPreferenceFields)) {
  test(`preferências: ${field} inválido usa apenas o padrão desse campo e impede gravação`, () => {
    for (const value of invalidValues) {
      const invalid = { ...validPreferences, [field]: value };
      const raw = JSON.stringify(invalid);
      const storage = createStorage({
        'groovegoblin.preferences.v1': raw,
        'groovegoblin.v1': 'frase intocada',
      });
      assert.deepEqual(loadPreferences(storage), {
        ...validPreferences, [field]: defaultPreferences[field],
      });
      assert.equal(savePreferences(invalid, storage), false);
      assert.equal(storage.getItem('groovegoblin.preferences.v1'), raw);
      assert.equal(storage.getItem('groovegoblin.v1'), 'frase intocada');
    }
  });
  test(`preferências: ${field} ausente usa padrão ao carregar e impede gravação incompleta`, () => {
    const partial = { ...validPreferences };
    delete partial[field];
    const raw = JSON.stringify(partial);
    const storage = createStorage({ 'groovegoblin.preferences.v1': raw });
    assert.deepEqual(loadPreferences(storage), {
      ...validPreferences, [field]: defaultPreferences[field],
    });
    assert.equal(savePreferences(partial, storage), false);
    assert.equal(storage.getItem('groovegoblin.preferences.v1'), raw);
  });
}

test('preferências: salvamento rejeita não-objetos, semente não finita e campos herdados', () => {
  const storage = createStorage({ 'groovegoblin.preferences.v1': 'original' });
  for (const value of [
    undefined, null, [], false, 1, 'preferências', Object.create(validPreferences),
    { ...validPreferences, seed: NaN },
    { ...validPreferences, seed: Infinity },
  ]) {
    assert.equal(savePreferences(value, storage), false);
    assert.equal(storage.getItem('groovegoblin.preferences.v1'), 'original');
  }
});

test('preferências: indisponibilidade de leitura/escrita usa padrões e retorna false', () => {
  const storage = {
    getItem() { throw new Error('indisponível'); },
    setItem() { throw new Error('quota excedida'); },
  };
  assert.deepEqual(loadPreferences(storage), defaultPreferences);
  assert.equal(savePreferences(validPreferences, storage), false);
});

test('preferências: getter global bloqueado não lança e mantém padrões', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('Bloqueado', 'SecurityError'); },
  });
  assert.deepEqual(loadPreferences(), defaultPreferences);
  assert.equal(savePreferences(validPreferences), false);
});

const defaultMixer = () => Object.fromEntries(MIXER_CHANNELS.map(channel => [channel, { volume: 1, muted: false }]));
const validMixer = {
  phrase: { volume: 0.25, muted: true },
  metronome: { volume: 0, muted: false },
  drums: { volume: 0.75, muted: false },
  chords: { volume: 1, muted: true },
};

test('mixer: canais atuais e padrões independentes sem ler ou alterar frase/preferências', () => {
  assert.deepEqual(MIXER_CHANNELS, ['phrase', 'metronome', 'drums', 'chords']);
  const storage = createStorage({
    'groovegoblin.v1': 'frase preservada',
    'groovegoblin.preferences.v1': 'preferências preservadas',
  });
  const getItem = storage.getItem;
  storage.getItem = key => {
    assert.equal(key, 'groovegoblin.mixer.v1');
    return getItem(key);
  };
  storage.setItem = () => assert.fail('loadMixer não deve escrever');
  storage.removeItem = () => assert.fail('loadMixer não deve remover');
  const loaded = loadMixer(storage);
  assert.deepEqual(loaded, { mixer: defaultMixer(), warnings: [] });
  loaded.mixer.phrase.volume = 0;
  loaded.mixer.metronome.muted = true;
  assert.deepEqual(loaded.mixer.drums, { volume: 1, muted: false });
  assert.deepEqual(loadMixer(storage), { mixer: defaultMixer(), warnings: [] });
  assert.equal(getItem('groovegoblin.v1'), 'frase preservada');
  assert.equal(getItem('groovegoblin.preferences.v1'), 'preferências preservadas');
});

test('mixer: round-trip conserva volume de canais mutados e não escreve outras chaves', () => {
  const storage = createStorage();
  const mixer = Object.freeze(Object.fromEntries(Object.entries(validMixer).map(([channel, settings]) => [channel, Object.freeze({ ...settings })])));
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    assert.equal(key, 'groovegoblin.mixer.v1');
    setItem(key, value);
  };
  assert.equal(saveMixer(mixer, storage), true);
  assert.deepEqual(loadMixer(storage), { mixer, warnings: [] });
  assert.deepEqual(JSON.parse(storage.getItem('groovegoblin.mixer.v1')), mixer);
  for (const volume of [0, 0.001, 0.5, 1]) {
    for (const muted of [false, true]) {
      const settings = Object.fromEntries(MIXER_CHANNELS.map(channel => [channel, { volume, muted }]));
      assert.equal(saveMixer(settings, storage), true);
      assert.deepEqual(loadMixer(storage), { mixer: settings, warnings: [] });
    }
  }
});

test('mixer: JSON inválido e não-objetos geram aviso e preservam bytes sem reescrever', () => {
  for (const raw of ['', '{inválido', 'null', '[]', 'true', '42', '"mixer"']) {
    const storage = createStorage({ 'groovegoblin.mixer.v1': raw });
    storage.setItem = () => assert.fail('loadMixer não deve escrever');
    const loaded = loadMixer(storage);
    assert.deepEqual(loaded.mixer, defaultMixer());
    assert.ok(loaded.warnings.length > 0);
    assert.equal(storage.getItem('groovegoblin.mixer.v1'), raw);
  }
});

for (const channel of MIXER_CHANNELS) {
  test(`mixer: ${channel} inválido ou ausente recupera somente esse canal`, () => {
    for (const value of [undefined, null, [], false, 1, 'canal']) {
      const mixer = structuredClone(validMixer);
      if (value === undefined) delete mixer[channel];
      else mixer[channel] = value;
      const raw = JSON.stringify(mixer);
      const storage = createStorage({ 'groovegoblin.mixer.v1': raw });
      const loaded = loadMixer(storage);
      assert.deepEqual(loaded.mixer, { ...validMixer, [channel]: { volume: 1, muted: false } });
      assert.ok(loaded.warnings.some(warning => warning.includes(channel)));
      assert.equal(saveMixer(mixer, storage), false);
      assert.equal(storage.getItem('groovegoblin.mixer.v1'), raw);
    }
  });
  for (const [field, values] of Object.entries({
    volume: [undefined, null, -0.1, 1.1, '0.5', true, [], {}, NaN, Infinity, -Infinity],
    muted: [undefined, null, 0, 1, 'false', [], {}],
  })) {
    test(`mixer: ${channel}.${field} inválido recupera só o campo e rejeita gravação`, () => {
      for (const value of values) {
        const mixer = structuredClone(validMixer);
        if (value === undefined) delete mixer[channel][field];
        else mixer[channel][field] = value;
        const raw = JSON.stringify(mixer);
        const storage = createStorage({ 'groovegoblin.mixer.v1': raw });
        const loaded = loadMixer(storage);
        assert.deepEqual(loaded.mixer, {
          ...validMixer,
          [channel]: { ...validMixer[channel], [field]: defaultMixer()[channel][field] },
        });
        assert.ok(loaded.warnings.some(warning => warning.includes(`${channel}.${field}`)));
        assert.equal(saveMixer(mixer, storage), false);
        assert.equal(storage.getItem('groovegoblin.mixer.v1'), raw);
      }
    });
  }
}

test('mixer: gravação rejeita não-objetos e campos herdados sem escrita parcial', () => {
  const storage = createStorage({ 'groovegoblin.mixer.v1': 'original' });
  for (const mixer of [
    undefined, null, [], true, 1, 'mixer', Object.create(validMixer),
    { ...validMixer, phrase: Object.create(validMixer.phrase) },
  ]) {
    assert.equal(saveMixer(mixer, storage), false);
    assert.equal(storage.getItem('groovegoblin.mixer.v1'), 'original');
  }
});

test('mixer: armazenamento bloqueado ou quota excedida retorna padrões com aviso/false', () => {
  const storage = {
    getItem() { throw new Error('bloqueado'); },
    setItem() { throw new Error('quota excedida'); },
  };
  const loaded = loadMixer(storage);
  assert.deepEqual(loaded.mixer, defaultMixer());
  assert.ok(loaded.warnings.length > 0);
  assert.equal(saveMixer(validMixer, storage), false);
});

test('mixer: getter global bloqueado ou armazenamento ausente não lança', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('Bloqueado', 'SecurityError'); },
  });
  for (const blocked of [true, false]) {
    if (!blocked) delete globalThis.localStorage;
    const loaded = loadMixer();
    assert.deepEqual(loaded.mixer, defaultMixer());
    assert.ok(loaded.warnings.length > 0);
    assert.equal(saveMixer(validMixer), false);
  }
});
