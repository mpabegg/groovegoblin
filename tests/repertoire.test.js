import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mountRepertoire,
  formatTime,
  parseTime,
  normalizeRegion,
  createMarker,
  upsertMarker,
  removeMarker,
  sectionList,
  sectionAt,
  speedLadder,
  createItem,
  normalizeItem,
  createExercise,
  exerciseSchedule,
  recordPractice,
  regionNotesToSessionPatch,
  createSetlist,
  addSetlistEntry,
  moveSetlistEntry,
  removeSetlistEntry,
  pruneSetlist,
  compareOnsets,
  tapTempo,
  beatGrid,
  normalizeExercise,
  normalizeSetlist,
} from '../src/repertoire.js';
import { openRepertoireStore, describeStorageError, formatBytes } from '../src/repertoire-store.js';
import { createJobRunner, JobCancelledError } from '../src/repertoire-jobs.js';

function item(overrides = {}) {
  return createItem({ kind: 'reference', source: 'import', name: 'Faixa', duration: 60, sampleRate: 44100, channels: 2, media: { id: 'md', mimeType: 'audio/wav', size: 10, fileName: 'f.wav' }, ...overrides });
}

test('repertoire: mountRepertoire é exportado pelo módulo principal e exige host completo', () => {
  assert.equal(typeof mountRepertoire, 'function');
  assert.throws(() => mountRepertoire(null, {}), /contêiner/);
  assert.throws(() => mountRepertoire({ append() {} }, { getSession() {} }), /host\./);
});

test('repertoire: tempos formatados e lidos em m:ss,d', () => {
  assert.equal(formatTime(83.44), '1:23.4');
  assert.equal(formatTime(5), '0:05.0');
  assert.equal(formatTime(65.9, { precise: false }), '1:05');
  assert.equal(parseTime('1:23,4'), 83.4);
  assert.equal(parseTime('83.4'), 83.4);
  assert.ok(Number.isNaN(parseTime('1:75')));
  assert.ok(Number.isNaN(parseTime('abc')));
});

test('repertoire: trechos são ordenados, limitados à duração e têm tamanho mínimo', () => {
  assert.deepEqual(normalizeRegion({ start: 20, end: 10 }, 60), { start: 10, end: 20 });
  assert.deepEqual(normalizeRegion({ start: -5, end: 99 }, 60), { start: 0, end: 60 });
  assert.equal(normalizeRegion({ start: 1, end: 1.01 }, 60), null);
  assert.equal(normalizeRegion({ start: NaN, end: 3 }, 60), null);
  assert.equal(normalizeRegion(null, 60), null);
});

test('repertoire: marcadores ordenados, seções vão até a próxima seção', () => {
  let markers = [];
  const verse = createMarker({ kind: 'section', time: 10, label: 'Verso' });
  const chorus = createMarker({ kind: 'section', time: 30, label: 'Refrão' });
  const note = createMarker({ kind: 'comment', time: 15, text: 'respire' });
  markers = upsertMarker(markers, chorus);
  markers = upsertMarker(markers, note);
  markers = upsertMarker(markers, verse);
  assert.deepEqual(markers.map(marker => marker.time), [10, 15, 30]);
  assert.equal(note.label, 'Comentário');
  const sections = sectionList(markers, 60);
  assert.deepEqual(sections.map(section => [section.label, section.time, section.end]), [['Verso', 10, 30], ['Refrão', 30, 60]]);
  assert.equal(sectionAt(markers, 60, 31).label, 'Refrão');
  assert.equal(sectionAt(markers, 60, 5), null);
  assert.equal(removeMarker(markers, note.id).length, 2);
  assert.throws(() => createMarker({ kind: 'invalido', time: 1 }), RangeError);
});

test('repertoire: escada de velocidade inclui o alvo e recusa escadas enormes', () => {
  assert.deepEqual(speedLadder(0.7, 1, 0.1), [0.7, 0.8, 0.9, 1]);
  assert.deepEqual(speedLadder(0.7, 0.95, 0.1), [0.7, 0.8, 0.9, 0.95]);
  assert.deepEqual(speedLadder(1, 0.8, 0.1), [1, 0.9, 0.8]);
  assert.throws(() => speedLadder(0.25, 1.5, 0.01), /40 etapas/);
  assert.throws(() => speedLadder(0.5, 1, 0), RangeError);
});

test('repertoire: exercício extraído exige trecho, filtra notas e registra prática', () => {
  const source = item();
  assert.throws(() => createExercise(source, null), /trecho/);
  const notes = [{ start: 5, end: 6, midi: 60, confidence: 0.9 }, { start: 11, end: 12, midi: 62, confidence: 0.8 }];
  const exercise = createExercise(source, { start: 10, end: 20 }, { speedFrom: 0.5, speedTo: 0.8, speedStep: 0.15, loopsPerStep: 3, notes });
  assert.equal(exercise.itemId, source.id);
  assert.deepEqual(exercise.notes.map(note => note.midi), [62]);
  assert.deepEqual(exerciseSchedule(exercise), [{ speed: 0.5, loops: 3 }, { speed: 0.65, loops: 3 }, { speed: 0.8, loops: 3 }]);
  const practiced = recordPractice(recordPractice(exercise, 0.65), 0.5);
  assert.equal(practiced.practice.sessions, 2);
  assert.equal(practiced.practice.bestSpeed, 0.65);
  assert.throws(() => createExercise(source, { start: 10, end: 20 }, { speedFrom: 0.1, speedTo: 0.5, speedStep: 0.1 }), /25%/);
  assert.deepEqual(normalizeExercise(JSON.parse(JSON.stringify(exercise))), exercise);
  assert.equal(normalizeExercise({ ...exercise, speedStep: -1 }), null);
});

test('repertoire: notas do trecho ancoram no pulso, quantizam e ficam monofônicas', () => {
  // 120 BPM: semicolcheia = 0,125 s; pulso em 0,1 + k·0,5.
  const notes = [
    { start: 10.13, end: 10.6, midi: 60, confidence: 0.9 },
    { start: 10.35, end: 10.9, midi: 64, confidence: 0.95 },
    { start: 10.6, end: 11.1, midi: 67, confidence: 0.3 },
    { start: 11.1, end: 11.6, midi: 65, confidence: 0.8 },
  ];
  const { patch, warnings } = regionNotesToSessionPatch(notes, { start: 10.1, end: 12.1, bpm: 120, beatOffset: 0.1, beatsPerBar: 4, minConfidence: 0.5, semitones: 2, idPrefix: 'x' });
  assert.deepEqual(patch.notes.map(note => [note.start, note.duration, note.pitch]), [[0, 2, 62], [2, 4, 66], [8, 4, 67]]);
  assert.deepEqual(patch.meter, { beats: 4, unit: 4 });
  assert.equal(patch.bars, 1);
  assert.equal(patch.bpm, 120);
  assert.ok(warnings.length === 1);
  assert.throws(() => regionNotesToSessionPatch([], { start: 0, end: 1, bpm: 120 }), /Nenhuma hipótese/);
  assert.throws(() => regionNotesToSessionPatch(notes, { start: 0, end: 1, bpm: 0 }), /andamento/);
});

test('repertoire: setlists adicionam, movem, removem e descartam órfãos', () => {
  let setlist = createSetlist('  Ensaio  ');
  assert.equal(setlist.name, 'Ensaio');
  setlist = addSetlistEntry(setlist, { kind: 'item', id: 'a' });
  setlist = addSetlistEntry(setlist, { kind: 'exercise', id: 'e' });
  setlist = addSetlistEntry(setlist, { kind: 'item', id: 'b' });
  setlist = moveSetlistEntry(setlist, 2, -2);
  assert.deepEqual(setlist.entries.map(entry => entry.id), ['b', 'a', 'e']);
  assert.equal(moveSetlistEntry(setlist, 0, -1), setlist);
  setlist = removeSetlistEntry(setlist, 1);
  assert.deepEqual(setlist.entries.map(entry => entry.id), ['b', 'e']);
  const pruned = pruneSetlist(setlist, { items: [{ id: 'b' }], exercises: [] });
  assert.deepEqual(pruned.entries.map(entry => entry.id), ['b']);
  assert.equal(pruneSetlist(pruned, { items: [{ id: 'b' }], exercises: [] }), pruned);
  assert.throws(() => createSetlist(' '), /nome/);
  assert.throws(() => addSetlistEntry(setlist, { kind: 'x', id: 'y' }), TypeError);
  assert.deepEqual(normalizeSetlist(JSON.parse(JSON.stringify(setlist))), setlist);
});

test('repertoire: comparação de ataques emparelha, mede deslocamento e conta sobras', () => {
  const result = compareOnsets([0, 0.5, 1, 1.5], [0.02, 0.53, 1.2, 1.51, 1.9], { tolerance: 0.1 });
  assert.equal(result.matched, 3);
  assert.equal(result.missing, 1);
  assert.equal(result.extra, 2);
  assert.ok(Math.abs(result.meanOffset - 0.02) < 1e-9);
  const shifted = compareOnsets([0, 1], [{ time: 0.3 }, { time: 1.3 }], { offset: 0.3 });
  assert.equal(shifted.matched, 2);
  assert.ok(Math.abs(shifted.meanAbsolute) < 1e-9);
});

test('repertoire: toque no pulso e grade de compassos', () => {
  assert.equal(tapTempo([0, 500]), null);
  assert.equal(tapTempo([0, 500, 1000, 1500, 2000]), 120);
  assert.equal(tapTempo([0, 600, 1200, 5000, 5600, 6200]), 100);
  const grid = beatGrid({ bpm: 120, offset: 0.25, beatsPerBar: 3 }, 0, 2);
  assert.deepEqual(grid.map(beat => beat.time), [0.25, 0.75, 1.25, 1.75]);
  assert.deepEqual(grid.map(beat => beat.downbeat), [true, false, false, true]);
  assert.deepEqual(grid.map(beat => beat.bar), [1, 1, 1, 2]);
});

test('repertoire: normalizeItem valida registros e descarta marcadores inválidos', () => {
  const valid = item({ markers: [{ kind: 'section', time: 5, label: 'A' }, { kind: 'section', time: 500 }, { kind: 'x', time: 1 }], processing: { speed: 9, semitones: 40, algorithm: 'wsola' } });
  assert.equal(valid.markers.length, 1);
  assert.deepEqual(valid.processing, { speed: 1.5, semitones: 12, cents: 0, algorithm: 'wsola' });
  assert.equal(valid.loop, true);
  assert.equal(normalizeItem({ ...valid, duration: 0 }), null);
  assert.equal(normalizeItem({ ...valid, source: 'microfone' }), null);
  assert.equal(normalizeItem('lixo'), null);
  const take = normalizeItem({ ...valid, kind: 'take', source: 'attempt', attempts: [{ start: 0.5, end: 0.7, pitch: 60 }, { nope: 1 }], session: { bpm: 90 } });
  assert.deepEqual(take.attempts, [{ start: 0.5, end: 0.7, pitch: 60 }]);
  assert.deepEqual(take.session, { bpm: 90 });
});

test('store: sem IndexedDB usa memória, avisa e devolve registros danificados sem apagar', async () => {
  const store = await openRepertoireStore({ indexedDB: undefined, storageManager: undefined });
  assert.equal(store.persistent, false);
  assert.match(store.error.message, /IndexedDB/);
  const good = item();
  await store.putItem(good);
  await store.putItem({ id: 'quebrado', kind: 'reference' });
  await store.putMedia('md', new Blob(['abc']));
  await store.putAnalysis(good.id, { tempo: [{ bpm: 100 }] });
  const loaded = await store.loadAll();
  assert.deepEqual(loaded.items.map(entry => entry.id), [good.id]);
  assert.deepEqual(loaded.corrupt.map(record => [record.store, record.id]), [['items', 'quebrado']]);
  assert.equal(await (await store.getMedia('md')).text(), 'abc');
  assert.deepEqual(await store.getAnalysis(good.id), { tempo: [{ bpm: 100 }] });
  await store.deleteItem(good);
  assert.equal(await store.getMedia('md'), null);
  assert.equal(await store.getAnalysis(good.id), null);
  assert.equal(await store.estimate(), null);
});

test('store: erros de cota e de versão viram mensagens acionáveis', () => {
  const quota = describeStorageError(Object.assign(new Error('x'), { name: 'QuotaExceededError' }));
  assert.equal(quota.code, 'quota');
  assert.match(quota.message, /espaço/);
  assert.equal(describeStorageError({ name: 'VersionError' }).code, 'version');
  assert.equal(formatBytes(1536), '1,5 KB');
  assert.equal(formatBytes(20 * 1024 * 1024), '20 MB');
});

test('jobs: progresso, resultado, ocupado e cancelamento que encerra o worker', async () => {
  const instances = [];
  class FakeWorker {
    constructor(url, options) { this.url = url; this.options = options; this.posted = []; this.terminated = false; instances.push(this); }
    postMessage(message, transfer) { this.posted.push({ message, transfer }); }
    terminate() { this.terminated = true; }
  }
  const runner = createJobRunner({ workerUrl: 'worker.js', WorkerClass: FakeWorker });
  const progress = [];
  const first = runner.run('analyze', { a: 1 }, { onProgress: (stage, fraction) => progress.push([stage, fraction]) });
  assert.equal(runner.busy, true);
  await assert.rejects(runner.run('process', {}), /em andamento/);
  const worker = instances[0];
  assert.deepEqual(worker.options, { type: 'module' });
  const { id } = worker.posted[0].message;
  worker.onmessage({ data: { id: id + 99, type: 'result', result: 'outro' } });
  worker.onmessage({ data: { id, type: 'progress', stage: 'Ataques', fraction: 0.5 } });
  worker.onmessage({ data: { id, type: 'result', result: { ok: true } } });
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(progress, [['Ataques', 0.5]]);
  assert.equal(runner.busy, false);

  const second = runner.run('hpss', {});
  assert.equal(runner.cancel(), true);
  await assert.rejects(second, JobCancelledError);
  assert.equal(worker.terminated, true);
  const third = runner.run('beats', {});
  assert.equal(instances.length, 2, 'um novo worker substitui o encerrado');
  instances[1].onmessage({ data: { id: instances[1].posted[0].message.id, type: 'error', message: 'falhou' } });
  await assert.rejects(third, /falhou/);
  await assert.rejects(createJobRunner({ WorkerClass: undefined }).run('x', {}), /Web Workers/);
});

test('worker: executa DSP real e responde com progresso e resultado', async () => {
  const messages = [];
  globalThis.self = { postMessage: (message, transfer) => messages.push({ message, transfer }) };
  await import('../src/repertoire-worker.js');
  const rate = 22050;
  const channel = new Float32Array(rate / 2);
  for (let i = 0; i < channel.length; i++) channel[i] = 0.4 * Math.sin(2 * Math.PI * 330 * i / rate);
  globalThis.self.onmessage({ data: { id: 7, type: 'process', payload: { channels: [channel], sampleRate: rate, speed: 0.5, semitones: 0, cents: 0, algorithm: 'vocoder' } } });
  const result = messages.find(entry => entry.message.type === 'result');
  assert.equal(result.message.id, 7);
  assert.equal(result.message.result.channels[0].length, channel.length * 2);
  assert.equal(result.transfer.length, 1);
  assert.ok(messages.some(entry => entry.message.type === 'progress' && entry.message.fraction === 1));
  globalThis.self.onmessage({ data: { id: 8, type: 'desconhecida' } });
  assert.match(messages.at(-1).message.message, /desconhecida/);
  globalThis.self.onmessage({ data: { id: 9, type: 'process', payload: { channels: [channel], sampleRate: rate, speed: 9 } } });
  assert.equal(messages.at(-1).message.type, 'error');
  delete globalThis.self;
});
