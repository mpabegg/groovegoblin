// Leitura "Agora · Próximo" (etapa 3): a mesma função alimenta a partitura do
// Estúdio e a do Treinar. A leitura some apenas quando a sessão que ela
// representa não tem acorde nenhum — um exercício gerado sem harmonia fica sem
// leitura, e a fonte autoral com acordes continua legível, mesmo durante uma
// execução gerada que herde os mesmos acordes. Sem DOM real: um duplo mínimo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, ticksPerBar } from '../src/session.js';
import { parseChordSymbol } from '../src/progression.js';
import { harmonyReadoutState, harmonySignature, createHarmonyReadout } from '../src/harmony-readout.js';
import { mergeSession } from '../src/studio-state.js';

const chord = (symbol, startBar, durationBars) => ({ ...parseChordSymbol(symbol), startBar, durationBars });
const withChords = ({ bars = 4, chords = [chord('C', 0, 2), chord('F', 2, 2)], loop } = {}) => createSession({
  bars,
  loop: loop ?? { startBar: 0, endBar: bars },
  progression: { enabled: true, cycleBars: bars, chords },
});

// ----- duplo mínimo de documento ---------------------------------------------

function stubElement() {
  const attributes = new Map();
  const element = {
    className: '', hidden: false, textContent: '',
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
  };
  // No DOM real, `title` é refletido no atributo: remover o atributo limpa a
  // propriedade (o código esconde a leitura removendo `title`).
  Object.defineProperty(element, 'title', {
    enumerable: true,
    configurable: true,
    get: () => element.getAttribute('title') ?? '',
    set: value => element.setAttribute('title', value),
  });
  return element;
}

function withStubDocument(run) {
  const original = globalThis.document;
  const created = [];
  globalThis.document = { createElement: () => { const element = stubElement(); created.push(element); return element; } };
  try { return run(created); } finally { globalThis.document = original; }
}

// ----- estado da leitura -----------------------------------------------------

test('a leitura mostra o acorde que soa e o seguinte, com o compasso no rótulo', () => {
  const session = withChords();
  const bar = ticksPerBar(session);
  assert.deepEqual(harmonyReadoutState(session, { tick: 0 }), { text: 'Agora: C · Próximo: F', label: 'Agora: C, compasso 1 · Próximo: F, compasso 3' });
  assert.deepEqual(harmonyReadoutState(session, { tick: 2 * bar }), { text: 'Agora: F · Próximo: C', label: 'Agora: F, compasso 3 · Próximo: C, compasso 1' });
});

test('pausa harmônica fala de silêncio sem perder o próximo acorde', () => {
  const session = withChords({ chords: [chord('C', 0, 1), chord('F', 2, 1)] });
  const bar = ticksPerBar(session);
  assert.equal(harmonyReadoutState(session, { tick: 1.5 * bar }).text, 'Agora: silêncio · Próximo: F');
});

test('no fim de um loop parcial ou do loop inteiro o próximo acorde volta ao primeiro da janela', () => {
  const partial = withChords({ bars: 6, chords: [chord('C', 0, 1), chord('F', 1, 1), chord('G', 2, 1), chord('A', 3, 1), chord('D', 4, 1), chord('E', 5, 1)], loop: { startBar: 4, endBar: 6 } });
  const bar = ticksPerBar(partial);
  assert.equal(harmonyReadoutState(partial, { tick: 5.5 * bar }).text, 'Agora: E · Próximo: D', 'loop parcial volta ao primeiro acorde da janela');
  const whole = withChords({ bars: 4, chords: [chord('C', 0, 1), chord('F', 1, 1), chord('G', 2, 1), chord('A', 3, 1)], loop: { startBar: 0, endBar: 4 } });
  assert.equal(harmonyReadoutState(whole, { tick: 3.5 * bar }).text, 'Agora: A · Próximo: C', 'loop inteiro volta ao primeiro acorde');
});

test('sem acorde nenhum não há leitura — e nunca uma leitura vazia escrita na página', () => {
  const bare = createSession({ bars: 4 });
  assert.equal(harmonyReadoutState(bare, { tick: 0 }), null);
  assert.equal(harmonyReadoutState(null, { tick: 0 }), null);
  assert.equal(harmonyReadoutState({ ...withChords(), progression: { enabled: false, cycleBars: 4, chords: [chord('C', 0, 4)] } }, { tick: 0 }), null);
});

test('a impressão digital só compara harmonia, ciclo e loop', () => {
  const session = withChords();
  assert.equal(harmonySignature({ ...session, notes: [...session.notes] }), harmonySignature(session));
  assert.notEqual(harmonySignature({ ...session, progression: { ...session.progression, chords: [chord('C', 0, 4)] } }), harmonySignature(session));
  assert.notEqual(harmonySignature({ ...session, loop: { startBar: 1, endBar: 3 } }), harmonySignature(session));
  assert.equal(harmonySignature(createSession({ bars: 4 })), '');
  assert.equal(harmonySignature(null), '');
});

// ----- elemento montado ------------------------------------------------------

test('o elemento nasce escondido, escreve a leitura e volta a esconder sem acordes', () => {
  withStubDocument(() => {
    const readout = createHarmonyReadout();
    const element = readout.element;
    assert.equal(element.hidden, true);
    assert.equal(element.getAttribute('role'), 'status');
    assert.equal(element.getAttribute('aria-live'), 'off');
    const session = withChords();
    readout.update(session, { tick: 0 });
    assert.equal(element.hidden, false);
    assert.equal(element.textContent, 'Agora: C · Próximo: F');
    assert.equal(element.getAttribute('aria-label'), 'Agora: C, compasso 1 · Próximo: F, compasso 3');
    assert.equal(element.title, element.getAttribute('aria-label'));
    readout.update(createSession({ bars: 4 }), { tick: 0 });
    assert.equal(element.hidden, true);
    assert.equal(element.textContent, '');
    assert.equal(element.getAttribute('aria-label'), null);
    assert.equal(element.title, '');
  });
});

test('material gerado que herda os acordes mantém a leitura; gerado sem harmonia esconde', () => {
  withStubDocument(() => {
    const readout = createHarmonyReadout();
    const element = readout.element;
    const authored = withChords();
    // Fonte executada gerada a partir da frase autoral: mesmos acordes, notas novas.
    const generated = mergeSession(authored, { notes: authored.notes.map(note => ({ ...note, pitch: note.pitch + 1 })) });
    assert.equal(harmonySignature(generated), harmonySignature(authored));
    readout.update(generated, { tick: 0 });
    assert.equal(element.hidden, false, 'o material gerado com os mesmos acordes continua legível');
    // Exercício gerado sem progressão: nenhuma leitura, sem esconder a autoral.
    readout.update({ ...generated, progression: { ...generated.progression, enabled: false } }, { tick: 0 });
    assert.equal(element.hidden, true);
    readout.update(authored, { tick: 0 });
    assert.equal(element.hidden, false, 'a fonte autoral volta a ser legível');
  });
});

test('material de outro exercício soando esconde só a leitura do Estúdio (hidden explícito)', () => {
  withStubDocument(() => {
    const readout = createHarmonyReadout();
    const element = readout.element;
    const authored = withChords();
    readout.update(authored, { tick: 0 }, { hidden: true });
    assert.equal(element.hidden, true, 'outra harmonia soando na partitura do Estúdio');
    assert.equal(element.textContent, '');
    readout.update(authored, { tick: 0 }, { hidden: false });
    assert.equal(element.hidden, false);
    assert.equal(element.textContent, 'Agora: C · Próximo: F');
  });
});
