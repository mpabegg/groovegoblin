// Limite de 128 compassos (rodada 6, etapa 1): comportamento observável nas
// bordas 128/129, nas operações por compasso, no roundtrip arquivo/link, nos
// documentos legados (v2/3/4, inclusive o teto anterior de 64) e no
// compartilhamento que não cabe no link. Nenhuma asserção depende de textos
// exatos: só de aceitação/rejeição, estrutura e preservação de dados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSession, patchSession, validateSession, serializeSession, parseSession,
  encodeSessionLink, decodeSessionLink, MAX_BARS, MAX_CHORDS, MAX_NOTES, ticksPerBar } from '../src/session.js';
import { clearBar, copyBar, duplicateBar, repeatPhraseInNewBars, timelineWidth } from '../src/studio-bars.js';
import { buildRhythmNotation } from '../src/notation.js';
import { notationSystems } from '../src/studio-score.js';
import { normalizeSession } from '../src/practice.js';
import { mountShareLink, shareUrl } from '../src/share-link.js';

const barTicks = ticksPerBar({ bars: MAX_BARS, meter: { beats: 4, unit: 4 } });
const notePerBar = (bars, duration = 2) => Array.from({ length: bars }, (_, bar) => (
  { id: `nota-${bar}`, start: bar * barTicks + 1, duration, pitch: 40 + (bar % 12) }
));
const denseNotes = count => Array.from({ length: count }, (_, index) => (
  { id: `densa-${index}`, start: Math.floor(index / 4) * barTicks + (index % 4) * 4, duration: 1, pitch: 40 + (index % 12) }
));
const chordAt = bar => ({ symbol: 'C', notes: [{ name: 'C', midi: 60 }], startBar: bar, durationBars: 1 });

test('borda de 128 compassos: 128 aceito, 129 rejeitado apontando o campo', () => {
  const full = createSession({ bars: MAX_BARS });
  assert.equal(full.bars, 128);
  assert.deepEqual(full.loop, { startBar: 0, endBar: 128 });
  assert.match(validateSession({ ...full, bars: MAX_BARS + 1 }).error, /1 a 128 compassos/);
  assert.match(validateSession({ ...full, loop: { startBar: 0, endBar: MAX_BARS + 1 } }).error, /loop/);
  assert.match(validateSession({ ...full, loop: { startBar: MAX_BARS, endBar: MAX_BARS } }).error, /loop/);
  assert.ok(validateSession({ ...full, bars: MAX_BARS, loop: { startBar: MAX_BARS - 1, endBar: MAX_BARS }, notes: [{ id: 'fim', start: (MAX_BARS - 1) * barTicks, duration: 4, pitch: 60 }] }).ok);
});

test('128 acordes cabem em 128 compassos; 129 são rejeitados pelo campo', () => {
  const full = createSession({ bars: MAX_BARS });
  const withChords = count => ({ ...full, progression: { ...full.progression, chords: Array.from({ length: count }, (_, bar) => chordAt(bar)), cycleBars: count, enabled: true } });
  assert.equal(MAX_CHORDS, 128);
  const accepted = validateSession(withChords(MAX_CHORDS));
  assert.ok(accepted.ok, accepted.error);
  assert.equal(accepted.session.progression.chords.length, 128);
  assert.equal(accepted.session.progression.chords.at(-1).startBar, 127);
  const rejected = validateSession(withChords(MAX_CHORDS + 1));
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /progressão/);
});

test('roundtrip de arquivo e de link preserva 128 compassos e cada compasso ocupado', () => {
  const session = createSession({ bars: MAX_BARS, notes: notePerBar(MAX_BARS) });
  assert.deepEqual(parseSession(serializeSession(session)), session);
  assert.deepEqual(decodeSessionLink(encodeSessionLink(session)), session);
  const bars = new Set(parseSession(serializeSession(session)).notes.map(note => Math.floor(note.start / barTicks)));
  assert.equal(bars.size, 128);
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

test('documentos legados no teto anterior (64 compassos) continuam carregando', () => {
  const session = createSession({ bars: 64, notes: notePerBar(64) });
  const file = JSON.stringify({ format: 'groovegoblin-session', version: 4, session: { ...session, version: 4 } });
  assert.deepEqual(parseSession(file), session);
  assert.equal(parseSession(file).bars, 64);
  assert.deepEqual(decodeSessionLink(encodeSessionLink(session)), session);
});

test('operações por compasso alcançam o 128º compasso e param no limite', () => {
  const source = createSession({ bars: MAX_BARS - 1, notes: [{ id: 'a', start: 1, duration: 2, pitch: 60 }] });
  const grown = patchSession(source, duplicateBar(source, 0).patch);
  assert.equal(grown.bars, MAX_BARS);
  assert.ok(duplicateBar(grown, 0).error);
  const copied = patchSession(source, copyBar(source, 0, MAX_BARS - 2).patch);
  assert.equal(copied.notes.length, 2);
  assert.equal(Math.floor(copied.notes.at(-1).start / barTicks), MAX_BARS - 2);
  const withLast = patchSession(grown, { notes: [...grown.notes, { id: 'ultimo', start: (MAX_BARS - 1) * barTicks + 1, duration: 2, pitch: 60 }] });
  const cleared = patchSession(withLast, clearBar(withLast, MAX_BARS - 1).patch);
  assert.deepEqual(cleared.notes.map(note => note.id).sort(), grown.notes.map(note => note.id).sort());
});

test('repetir a frase leva o conteúdo aos 128 compassos sem perder ataques', () => {
  const source = createSession({ bars: 16, notes: notePerBar(16) });
  const expanded = patchSession(source, { bars: MAX_BARS });
  const repeated = patchSession(expanded, repeatPhraseInNewBars(expanded, source).patch);
  assert.equal(repeated.notes.length, 128);
  assert.deepEqual([...new Set(repeated.notes.map(note => Math.floor(note.start / barTicks)))].sort((a, b) => a - b), Array.from({ length: MAX_BARS }, (_, bar) => bar));
  assert.equal(new Set(repeated.notes.map(note => note.id)).size, 128);
});

test('partitura fatia 128 compassos em 32 sistemas de 4 (faixa de aproveitamento acessível)', () => {
  const session = createSession({ bars: MAX_BARS, notes: notePerBar(MAX_BARS) });
  const systems = notationSystems(buildRhythmNotation(session.notes, session));
  assert.equal(systems.length, 32);
  assert.deepEqual(systems.map(system => [system.barOffset, system.bars]), Array.from({ length: 32 }, (_, index) => [index * 4, 4]));
  assert.equal(systems.at(-1).barOffset + systems.at(-1).bars, MAX_BARS);
  assert.deepEqual(systems.flatMap(system => system.measures.map(measure => measure.index)), Array.from({ length: 32 }, () => [1, 2, 3, 4]).flat());
});

test('linha do tempo e treino usam os 128 compassos da sessão', () => {
  const session = createSession({ bars: MAX_BARS });
  assert.ok(timelineWidth(1280, session, 4) > 1280, 'a linha do tempo precisa rolar com 128 compassos');
  assert.equal(normalizeSession(session).bars, 128);
  assert.equal(normalizeSession({ ...session, bars: MAX_BARS + 1 }).bars, MAX_BARS);
});

test('512 notas continuam sendo o teto, mesmo com 128 compassos', () => {
  const session = createSession({ bars: MAX_BARS, notes: denseNotes(MAX_NOTES) });
  assert.equal(validateSession(session).ok, true);
  assert.equal(validateSession({ ...session, notes: [...session.notes, { id: 'extra', start: 0.5, duration: 0.5, pitch: 60 }] }).ok, false);
});

test('compartilhar um exercício leve de 128 compassos cabe no link', () => {
  const location = { origin: 'https://example.invalid', pathname: '/app/', search: '' };
  const light = createSession({ bars: MAX_BARS, notes: notePerBar(MAX_BARS, 1) });
  const url = shareUrl(light, location);
  assert.ok(url.startsWith('https://example.invalid/app/#session='));
  assert.deepEqual(decodeSessionLink(new URL(url).hash), light);
});

test('fixture pública longa (128 compassos) carrega de ponta a ponta', () => {
  const text = readFileSync(new URL('./fixtures/session-128-bars.json', import.meta.url), 'utf8');
  const session = parseSession(text);
  assert.equal(session.bars, 128);
  assert.equal(session.notes.length, 128);
  assert.equal(session.progression.chords.length, 128);
  assert.deepEqual(parseSession(serializeSession(session)), session);
  assert.deepEqual(decodeSessionLink(encodeSessionLink(session)), session);
  const systems = notationSystems(buildRhythmNotation(session.notes, session));
  assert.equal(systems.length, 32);
  assert.equal(systems.at(-1).barOffset + systems.at(-1).bars, 128);
});

test('compartilhar avisa para exportar quando a sessão não cabe no link', async () => {
  const location = { origin: 'https://example.invalid', pathname: '/app/', search: '' };
  const dense = createSession({ bars: MAX_BARS, notes: denseNotes(MAX_NOTES) });
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
  const light = createSession({ bars: MAX_BARS, notes: notePerBar(MAX_BARS, 1) });
  mountShareLink({ button, output: shown, field: field2, getSession: () => light, notify: (text, error) => copied.push([text, error]), location });
  button.listener();
  assert.equal(shown.hidden, false);
  assert.match(field2.value, /#session=/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(copied.length, 1);
  assert.equal(copied[0][1], undefined, 'sucesso não é reportado como erro');
});
