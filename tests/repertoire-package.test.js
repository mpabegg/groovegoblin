import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  createAssignmentPackage,
  serializePackage,
  parsePackage,
  bytesToBase64,
  base64ToBytes,
} from '../src/repertoire-package.js';
import { createItem, createMarker, createExercise } from '../src/repertoire.js';

function reference() {
  const item = createItem({ kind: 'reference', source: 'import', name: 'Música', duration: 120, sampleRate: 48000, channels: 2, media: { id: 'md-1', mimeType: 'audio/mpeg', size: 4, fileName: 'musica.mp3' } });
  return {
    ...item,
    region: { start: 10, end: 20 },
    markers: [createMarker({ kind: 'section', time: 8, label: 'Refrão' }), createMarker({ kind: 'comment', time: 12, end: 14, label: 'Atenção', text: 'segure a nota' })],
    tempo: { bpm: 100, offset: 0.2, beatsPerBar: 7, beatUnit: 8, meterSource: 'studio', source: 'analysis' },
    chords: [{ start: 10, end: 12, label: 'Am', confidence: 0.9, alternatives: [], edited: false }, { start: 12, end: 14, label: 'F', confidence: 0.2, alternatives: [], edited: true }, { start: 14, end: 16, label: 'G', confidence: 0.1, alternatives: [], edited: false }],
  };
}

test('package: ida e volta com sessão, referência, exercícios e áudio embutido', () => {
  const item = reference();
  const exercise = createExercise(item, item.region, { name: 'Refrão lento', speedFrom: 0.6, speedTo: 0.9, speedStep: 0.1 });
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const pkg = createAssignmentPackage({ title: '  Tarefa da semana  ', objective: 'Tocar junto a 90%', session: { version: 2, bpm: 100, notes: [] }, item, exercises: [exercise], audio: { bytes, mimeType: 'audio/mpeg', fileName: 'musica.mp3' } });
  assert.equal(pkg.format, PACKAGE_FORMAT);
  assert.equal(pkg.version, PACKAGE_VERSION);
  const parsed = parsePackage(serializePackage(pkg));
  assert.equal(parsed.ok, true, parsed.error);
  const value = parsed.value;
  assert.equal(value.title, 'Tarefa da semana');
  assert.equal(value.objective, 'Tocar junto a 90%');
  assert.deepEqual(value.session, { version: 2, bpm: 100, notes: [] });
  assert.equal(value.reference.id, item.id);
  assert.deepEqual(value.reference.region, { start: 10, end: 20 });
  assert.deepEqual(value.reference.markers.map(marker => marker.label), ['Refrão', 'Atenção']);
  assert.deepEqual(value.reference.chords.map(chord => chord.label), ['Am', 'F'], 'acordes de baixa confiança não editados ficam fora');
  assert.deepEqual(value.reference.tempo, item.tempo);
  assert.equal(value.exercises.length, 1);
  assert.equal(value.exercises[0].name, 'Refrão lento');
  assert.deepEqual(value.exercises[0].practice, { sessions: 0, bestSpeed: 0, lastPracticed: null });
  assert.deepEqual(Array.from(value.audio.bytes), Array.from(bytes));
});

test('package: base64 preserva todos os valores de byte', () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, index) => index % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});

test('package: título obrigatório e limite do áudio embutido', () => {
  assert.throws(() => createAssignmentPackage({ title: '   ' }), /título/);
  assert.throws(() => createAssignmentPackage({ title: 'x', audio: { bytes: [1, 2] } }), /no máximo/);
});

test('package: importação recusa documentos inválidos sem expor partes', () => {
  const valid = JSON.parse(serializePackage(createAssignmentPackage({ title: 'Ok', item: reference() })));
  const cases = [
    ['{', /JSON é inválido/],
    [JSON.stringify({ ...valid, format: 'outro' }), /não é um pacote/],
    [JSON.stringify({ ...valid, version: 9 }), /versão/],
    [JSON.stringify({ ...valid, extra: 1 }), /campos/],
    [JSON.stringify({ ...valid, title: '' }), /título/],
    [JSON.stringify({ ...valid, reference: { ...valid.reference, duration: -1 } }), /duração/],
    [JSON.stringify({ ...valid, reference: { ...valid.reference, markers: [{ kind: 'section', time: 999 }] } }), /marcadores/],
    [JSON.stringify({ ...valid, exercises: [{ id: 'e' }] }), /exercícios/],
    [JSON.stringify({ ...valid, audio: { data: '###', size: 1 } }), /corrompido/],
    [JSON.stringify({ ...valid, audio: { data: bytesToBase64(new Uint8Array([1, 2, 3])), size: 4 } }), /incompleto/],
    [JSON.stringify({ ...valid, reference: null, audio: { data: bytesToBase64(new Uint8Array([1])), size: 1 } }), /nenhuma referência/],
  ];
  for (const [text, pattern] of cases) {
    const result = parsePackage(text);
    assert.equal(result.ok, false, text.slice(0, 80));
    assert.match(result.error, pattern);
    assert.deepEqual(Object.keys(result).sort(), ['error', 'ok']);
  }
  assert.equal(parsePackage(42).ok, false);
});
