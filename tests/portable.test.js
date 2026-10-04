import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePhrase, parseShare } from '../src/portable.js';
import { createSession, serializeSession, parseSession, encodeSessionLink, decodeSessionLink } from '../src/session.js';
import { parseChordSymbol } from '../src/progression.js';

const legacy = (patch = {}) => ({ format: 'groovegoblin-phrase', version: 1, bpm: 110, bars: 2, notes: [{ id: 'original-ç', start: 20, duration: 3 }], ...patch });
const rich = () => createSession({
  name: 'Quiálteras — ação 🎵', bars: 3, meter: { beats: 7, unit: 8 }, bpm: 137, subdivision: 7, swing: 0.25,
  notes: [{ id: 'n-ç', start: 4 / 7, duration: 12 / 7, pitch: 0, velocity: 0, articulation: 'ghost', offsetMs: -80 }, { id: 'fim', start: 40, duration: 2, pitch: 127, articulation: 'tenuto' }],
  progression: { keyId: 'g-major', enabled: true, chords: [{ ...parseChordSymbol('D7/F#'), durationBars: 2 / 7 }] },
  drums: { enabled: true, style: 'shuffle', seed: 0xffffffff }, band: { bassEnabled: true, mode: 'follow', role: 'bass' },
  loop: { startBar: 1, endBar: 3 }, training: { countInBars: 0, repetitions: 9, evaluation: 'style', goal: 'pitch' },
  form: { enabled: true, loop: false, sections: [{ id: 'intro', name: 'Introdução', kind: 'intro', startBar: 0, endBar: 1, repeats: 1, bpm: 90, meter: null, density: 'sparse' }, { id: 'theme', name: 'Tema', kind: 'A', startBar: 1, endBar: 3, repeats: 2, bpm: null, meter: null, density: null }] },
  mixer: { bass: { muted: true, volume: 0.3 } }, extensions: { annotations: [{ text: '<b>ação</b>', tick: 2 / 3 }] },
});

test('sessão inteira faz roundtrip de arquivo e link Unicode, sem perda de frações ou expressão', () => {
  const original = rich();
  const before = structuredClone(original);
  const json = serializeSession(original);
  const hash = encodeSessionLink(original);
  assert.deepEqual(parseSession(json), original);
  assert.deepEqual(decodeSessionLink(hash), original);
  assert.match(hash, /^#session=[A-Za-z0-9_-]+$/);
  assert.deepEqual(original, before);
  const imported = parseSession(json);
  imported.notes[0].pitch = 60;
  imported.progression.chords[0].notes[0].midi = 90;
  imported.extensions.annotations[0].text = 'editado';
  assert.deepEqual(parseSession(json), before);
  assert.deepEqual(original, before);
});

test('arquivos e links antigos migram para uma sessão completa sem mudar ataques, IDs ou BPM', () => {
  for (const bars of [1, 2, 4]) {
    const document = legacy({ bars, notes: [{ id: 'a', start: bars * 16 - 1, duration: 1 }] });
    const expected = createSession({ bpm: 110, bars, notes: document.notes });
    const text = JSON.stringify(document);
    assert.deepEqual(parseSession(text), expected);
    assert.deepEqual(decodeSessionLink(`#phrase=${encodeURIComponent(text)}`), expected);
    assert.equal(parsePhrase(text).ok, true);
    assert.equal(parseShare(`#phrase=${encodeURIComponent(text)}`).ok, true);
  }
  const old = legacy({ notes: [{ id: 'old', start: 0, duration: 1 }] });
  delete old.bars;
  assert.equal(parseSession(JSON.stringify(old)).bars, 1);
});

test('importação rejeita documentos ou notas inválidos atomicamente, não corrige valores', () => {
  const session = rich();
  const document = { format: 'groovegoblin-session', version: 2, session };
  const invalid = [null, [], false, {}, { ...document, format: 'outro' }, { ...document, version: 1 }, { ...document, extra: true },
    ...[null, [], { ...session, version: 1 }, { ...session, bpm: 300.5 }, { ...session, unknown: true }, { ...session, meter: { beats: 7, unit: 3 } }, { ...session, loop: { startBar: 3, endBar: 2 } }].map(session => ({ ...document, session })),
  ];
  for (const patch of [{ id: '' }, { start: -0.001 }, { duration: 0 }, { pitch: 128 }, { pitch: 1.5 }, { pitch: null }, { velocity: null }, { velocity: 1.1 }, { articulation: 'bad' }, { offsetMs: 81 }, { extra: true }]) {
    invalid.push({ ...document, session: { ...session, notes: [{ ...session.notes[0], ...patch }] } });
  }
  invalid.push({ ...document, session: { ...session, notes: [session.notes[0], { ...session.notes[0], id: 'overlap' }] } });
  invalid.push({ ...document, session: { ...session, notes: [session.notes[0], { ...session.notes[0], start: 4 }] } });
  for (const value of invalid) assert.throws(() => parseSession(JSON.stringify(value)), TypeError);
  for (const text of ['', '{', 'undefined', '{"session":']) assert.throws(() => parseSession(text), TypeError);
  for (const value of [null, undefined, 1, {}, []]) assert.throws(() => parseSession(value), TypeError);
  assert.deepEqual(session, rich());
});

test('leitor legado continua estrito sobre grade inteira, campos, versão e limites históricos', () => {
  for (const patch of [{ format: 'wrong' }, { version: 2 }, { bpm: 39 }, { bpm: 241 }, { bars: 3 }, { extra: true },
    { notes: [{ id: 'a', start: 0.5, duration: 1 }] }, { notes: [{ id: 'a', start: 0, duration: 1.5 }] },
    { notes: [{ id: 'a', start: 0, duration: 1, pitch: 69 }] }, { notes: [{ id: 'a', start: 31, duration: 2 }] },
    { notes: [{ id: 'a', start: 0, duration: 4 }, { id: 'b', start: 2, duration: 1 }] },
  ]) {
    const text = JSON.stringify(legacy(patch));
    assert.equal(parsePhrase(text).ok, false);
    assert.throws(() => parseSession(text), TypeError);
  }
});

test('links inválidos, malformados ou longos não produzem estados parciais', () => {
  for (const hash of [undefined, null, 1, {}, '', '#', '#session=', '#session=%7B', '#session=!', '#session=A', '#session=__8', '#session=bnVsbA', '#outro=valor', '#phrase=%', '#phrase=%7B', `#session=${'a'.repeat(65536)}`]) {
    assert.throws(() => decodeSessionLink(hash), TypeError);
  }
  assert.equal(parseShare(`#phrase=${'a'.repeat(32769)}`).ok, false);
  const large = createSession({ extensions: { text: 'ç'.repeat(25000) } });
  assert.throws(() => encodeSessionLink(large), RangeError);
  assert.deepEqual(parseSession(serializeSession(large)), large);
  for (const invalid of [null, {}, { ...rich(), bpm: 301 }]) {
    assert.throws(() => serializeSession(invalid), TypeError);
    assert.throws(() => encodeSessionLink(invalid), TypeError);
  }
});
