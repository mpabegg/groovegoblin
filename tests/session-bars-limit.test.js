// Limite de 64 compassos (rodada 5, etapa 2): comportamento observável nas
// bordas 64/65, nas operações por compasso, no roundtrip arquivo/link e no
// compartilhamento que não cabe no link. Nenhuma asserção depende de textos
// exatos: só de aceitação/rejeição, estrutura e preservação de dados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, patchSession, validateSession, serializeSession, parseSession,
  encodeSessionLink, decodeSessionLink, MAX_BARS, ticksPerBar } from '../src/session.js';
import { clearBar, copyBar, duplicateBar, repeatPhraseInNewBars, timelineWidth } from '../src/studio-bars.js';
import { buildRhythmNotation } from '../src/notation.js';
import { notationSystems } from '../src/studio-score.js';
import { normalizeSession } from '../src/practice.js';
import { mountShareLink, shareUrl } from '../src/share-link.js';

const barTicks = ticksPerBar({ bars: 64, meter: { beats: 4, unit: 4 } });
const notePerBar = (bars, duration = 2) => Array.from({ length: bars }, (_, bar) => (
  { id: `nota-${bar}`, start: bar * barTicks + 1, duration, pitch: 40 + (bar % 12) }
));

test('borda de 64 compassos: 64 aceito, 65 rejeitado apontando o campo', () => {
  assert.equal(MAX_BARS, 64);
  const full = createSession({ bars: MAX_BARS });
  assert.equal(full.bars, 64);
  assert.deepEqual(full.loop, { startBar: 0, endBar: 64 });
  assert.match(validateSession({ ...full, bars: 65 }).error, /1 a 64 compassos/);
  assert.match(validateSession({ ...full, loop: { startBar: 0, endBar: 65 } }).error, /loop/);
  assert.match(validateSession({ ...full, loop: { startBar: 64, endBar: 64 } }).error, /loop/);
  assert.ok(validateSession({ ...full, bars: 64, loop: { startBar: 63, endBar: 64 }, notes: [{ id: 'fim', start: 63 * barTicks, duration: 4, pitch: 60 }] }).ok);
});

test('roundtrip de arquivo e de link preserva 64 compassos e cada compasso ocupado', () => {
  const session = createSession({ bars: 64, notes: notePerBar(64) });
  assert.deepEqual(parseSession(serializeSession(session)), session);
  assert.deepEqual(decodeSessionLink(encodeSessionLink(session)), session);
  const bars = new Set(parseSession(serializeSession(session)).notes.map(note => Math.floor(note.start / barTicks)));
  assert.equal(bars.size, 64);
});

test('documentos legados de até 16 compassos carregam iguais ao equivalente v5', () => {
  const session = createSession({ bars: 16, notes: notePerBar(16, 4) });
  for (const version of [2, 3, 4]) {
    const legacy = { ...session, version, drums: { ...session.drums }, progression: { ...session.progression }, mixer: JSON.parse(JSON.stringify(session.mixer)) };
    if (version === 2) delete legacy.progression.cycleBars;
    if (version < 4) delete legacy.drums.edits;
    const result = validateSession(legacy);
    assert.ok(result.ok, result.error);
    assert.deepEqual(result.session, session);
  }
  const file = JSON.stringify({ format: 'groovegoblin-session', version: 4, session: { ...session, version: 4 } });
  assert.deepEqual(parseSession(file), session);
});

test('operações por compasso alcançam o 64º compasso e param no limite', () => {
  const source = createSession({ bars: 63, notes: [{ id: 'a', start: 1, duration: 2, pitch: 60 }] });
  const grown = patchSession(source, duplicateBar(source, 0).patch);
  assert.equal(grown.bars, 64);
  assert.ok(duplicateBar(grown, 0).error);
  const copied = patchSession(source, copyBar(source, 0, 62).patch);
  assert.equal(copied.notes.length, 2);
  assert.equal(Math.floor(copied.notes.at(-1).start / barTicks), 62);
  const withLast = patchSession(grown, { notes: [...grown.notes, { id: 'ultimo', start: 63 * barTicks + 1, duration: 2, pitch: 60 }] });
  const cleared = patchSession(withLast, clearBar(withLast, 63).patch);
  assert.deepEqual(cleared.notes.map(note => note.id).sort(), grown.notes.map(note => note.id).sort());
});

test('repetir a frase leva o conteúdo aos 64 compassos sem perder ataques', () => {
  const source = createSession({ bars: 16, notes: notePerBar(16) });
  const expanded = patchSession(source, { bars: 64 });
  const repeated = patchSession(expanded, repeatPhraseInNewBars(expanded, source).patch);
  assert.equal(repeated.notes.length, 64);
  assert.deepEqual([...new Set(repeated.notes.map(note => Math.floor(note.start / barTicks)))].sort((a, b) => a - b), Array.from({ length: 64 }, (_, bar) => bar));
  assert.equal(new Set(repeated.notes.map(note => note.id)).size, 64);
});

test('partitura fatia 64 compassos em 16 sistemas de 4 (faixa de aproveitamento acessível)', () => {
  const session = createSession({ bars: 64, notes: notePerBar(64) });
  const systems = notationSystems(buildRhythmNotation(session.notes, session));
  assert.equal(systems.length, 16);
  assert.deepEqual(systems.map(system => [system.barOffset, system.bars]), Array.from({ length: 16 }, (_, index) => [index * 4, 4]));
  assert.equal(systems.at(-1).barOffset + systems.at(-1).bars, 64);
  assert.deepEqual(systems.flatMap(system => system.measures.map(measure => measure.index)), Array.from({ length: 16 }, () => [1, 2, 3, 4]).flat());
});

test('linha do tempo e treino usam os 64 compassos da sessão', () => {
  const session = createSession({ bars: 64 });
  assert.ok(timelineWidth(1280, session, 4) > 1280, 'a linha do tempo precisa rolar com 64 compassos');
  assert.equal(normalizeSession(session).bars, 64);
  assert.equal(normalizeSession({ ...session, bars: 65 }).bars, MAX_BARS);
});

test('compartilhar avisa para exportar quando a sessão não cabe no link', async () => {
  const location = { origin: 'https://example.invalid', pathname: '/app/', search: '' };
  const small = createSession({ bars: 64, notes: notePerBar(64, 1) });
  const url = shareUrl(small, location);
  assert.ok(url.startsWith('https://example.invalid/app/#session='));
  assert.deepEqual(decodeSessionLink(new URL(url).hash), small);

  const dense = createSession({ bars: 64, notes: Array.from({ length: 512 }, (_, index) => (
    { id: `densa-${index}`, start: Math.floor(index / 8) * barTicks + (index % 8) * 2, duration: 1, pitch: 40 + (index % 12) }
  )) });
  assert.equal(validateSession(dense).ok, true);
  assert.throws(() => shareUrl(dense, location), RangeError);

  const button = { listener: null, addEventListener(type, listener) { if (type === 'click') this.listener = listener; } };
  const output = { hidden: false };
  const field = { value: 'endereço anterior', focus() {}, select() {} };
  const notices = [];
  mountShareLink({ button, output, field, getSession: () => dense, notify: (text, error) => notices.push([text, error]), location });
  button.listener();
  assert.equal(notices.length, 1);
  assert.equal(notices[0][1], true);
  assert.match(notices[0][0], /Exportar exercício/);
  assert.equal(output.hidden, true);
  assert.equal(field.value, 'endereço anterior');

  const copied = [];
  const shown = { hidden: true };
  const field2 = { value: '', focus() {}, select() {} };
  mountShareLink({ button, output: shown, field: field2, getSession: () => small, notify: (text, error) => copied.push([text, error]), location });
  button.listener();
  assert.equal(shown.hidden, false);
  assert.match(field2.value, /#session=/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(copied.length, 1);
  assert.equal(copied[0][1], undefined, 'sucesso não é reportado como erro');
});
