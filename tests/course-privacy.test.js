import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, parseSession, serializeSession, decodeSessionLink, validateSession } from '../src/session.js';
import { createExerciseLibrary } from '../src/exercise-library.js';
import { createCourseStore } from '../src/course-store.js';
import { bindCoursePrivacy, shareableSession, shareableExercise, shareableLibrary, PUBLIC_EXERCISE_NAME } from '../src/course-privacy.js';
import { shareUrl } from '../src/share-link.js';
import { sessionMidiDownload } from '../src/repertoire-view.js';
import { sessionToMidi } from '../src/repertoire-formats.js';
import { createAssignmentPackage, parsePackage, serializePackage } from '../src/repertoire-package.js';
import { courseText, memoryBackend } from './course-fixtures.js';
import { memoryStorage } from './storage-fixture.js';

const SECRET = 'SEGREDO';
const location = { origin: 'https://example.invalid', pathname: '/', search: '' };
function privateSession() {
  return createSession({
    name: SECRET, bars: 2,
    notes: [{ id: SECRET, start: 0, duration: 4, pitch: 36, string: 3 }],
    progression: { enabled: true, cycleBars: 2, chords: [{ symbol: SECRET, quality: SECRET, roman: SECRET,
      root: 0, startBar: 0, durationBars: 2, notes: [{ midi: 48, name: SECRET }, { midi: 52, name: SECRET }, { midi: 55, name: SECRET }] }] },
    form: { enabled: true, loop: false, sections: [{ id: SECRET, name: SECRET, kind: 'A', startBar: 0, endBar: 2, repeats: 2 }] },
    extensions: { privateCourse: SECRET, studio: { privateText: SECRET, phraseView: 'tab', inputPitch: 36,
      instrument: { type: 'bass', strings: 4, tuning: [28, 33, 38, 43], noteNames: 'letters' } } },
  });
}
function library(storage = memoryStorage(), session = privateSession()) {
  let id = 0;
  return createExerciseLibrary({ storage, parse: parseSession, serialize: serializeSession, currentSession: session,
    uuid: () => `example-${++id}`, now: () => '2026-01-01T00:00:00.000Z' });
}
function musicalNotes(session) {
  return session.notes.map(({ id, ...note }) => note);
}

test('private session export removes free text without changing the played music or source', () => {
  const source = privateSession();
  const before = structuredClone(source);
  const safe = shareableSession(source, { privateContent: true });
  assert.equal(JSON.stringify(safe).includes(SECRET), false);
  assert.equal(validateSession(safe).ok, true);
  assert.deepEqual(musicalNotes(safe), musicalNotes(source));
  assert.deepEqual(safe.progression.chords[0].notes.map(n => n.midi), [48, 52, 55]);
  assert.equal(safe.form.sections[0].repeats, 2);
  assert.deepEqual(safe.extensions.studio.instrument, source.extensions.studio.instrument);
  assert.deepEqual(source, before);
  const decoded = decodeSessionLink(new URL(shareUrl(source, location, { privateContent: true })).hash);
  assert.deepEqual(decoded, safe);
});

test('public exercise stays unchanged; tainted exercise exports neither metadata nor origin', () => {
  const entry = { id: SECRET, session: privateSession(), metadata: { name: SECRET, tags: [SECRET], notes: SECRET,
    targetBPM: 120, records: [{ name: SECRET }], courseContent: true, study: { origin: { kind: 'course', label: SECRET } } } };
  const before = structuredClone(entry);
  const safe = shareableExercise(entry);
  assert.equal(JSON.stringify(safe).includes(SECRET), false);
  assert.equal(safe.metadata.targetBPM, 120);
  assert.deepEqual(musicalNotes(safe.session), musicalNotes(entry.session));
  assert.deepEqual(entry, before);
  const ordinary = { ...entry, metadata: { ...entry.metadata, courseContent: false, study: null } };
  assert.deepEqual(shareableExercise(ordinary), ordinary);
});

test('legacy course link taints persistently, survives unlink/duplicate, and sanitizes task packages', async t => {
  const storage = memoryStorage();
  const exercises = library(storage);
  const courses = createCourseStore({ backend: memoryBackend() });
  await courses.ready();
  await courses.importText(courseText());
  const detach = bindCoursePrivacy(exercises, Promise.resolve(courses));
  t.after(detach);
  await Promise.resolve();
  const id = exercises.active();
  await courses.linkExercise('curso-exemplo', 'aula-1', id);
  assert.equal(exercises.get(id).metadata.courseContent, true);
  await courses.unlinkExercise('curso-exemplo', 'aula-1', id);
  exercises.updateMetadata(id, { courseContent: false });
  assert.equal(exercises.get(id).metadata.courseContent, true);
  const duplicate = exercises.duplicate(id);
  assert.equal(duplicate.metadata.courseContent, true);
  assert.equal(library(storage).get(id).metadata.courseContent, true);
  const exported = JSON.parse(exercises.exportExercise(id));
  assert.equal(JSON.stringify(exported).includes(SECRET), false);
  const pkg = createAssignmentPackage({ title: SECRET, objective: SECRET, session: exercises.activeEntry().session,
    audio: { bytes: new Uint8Array([1, 2, 3]), fileName: `${SECRET}.mp3` } });
  assert.equal(serializePackage(pkg).includes(SECRET), false);
  assert.equal(pkg.audio, null);
  assert.equal(pkg.reference, null);
  assert.equal(parsePackage(serializePackage(pkg)).ok, true);
  assert.equal(JSON.stringify(decodeSessionLink(new URL(shareUrl(exercises.activeEntry().session, location)).hash)).includes(SECRET), false);
});

test('public library export has unique remapped IDs while explicit private snapshots preserve everything', () => {
  const exercises = library();
  exercises.updateMetadata(exercises.active(), { courseContent: true });
  exercises.duplicate(exercises.active());
  const snapshot = JSON.parse(exercises.exportLibrary({ includeCourseContent: true }));
  const safe = JSON.parse(exercises.exportLibrary());
  assert.equal(JSON.stringify(safe).includes(SECRET), false);
  assert.equal(new Set(safe.entries.map(e => e.id)).size, safe.entries.length);
  assert.ok(safe.entries.some(e => e.id === safe.activeId));
  assert.equal(snapshot.entries[0].session.name, SECRET);
  assert.equal(snapshot.entries[0].metadata.courseContent, true);
  assert.deepEqual(JSON.parse(exercises.exportLibrary({ includeCourseContent: true })), snapshot);
});

test('private session MIDI export drops the course title from the file name and the track', async (t) => {
  // Sem vínculo de curso, o MIDI continua com o nome que o usuário deu.
  const solto = sessionMidiDownload(privateSession());
  assert.equal(solto.privateContent, false);
  assert.equal(solto.fileName, 'segredo.mid');
  assert.equal(Buffer.from(solto.bytes).includes(Buffer.from(SECRET)), true, 'o nome do usuário não é conteúdo de curso');

  const storage = memoryStorage();
  const exercises = library(storage);
  const courses = createCourseStore({ backend: memoryBackend() });
  await courses.ready();
  await courses.importText(courseText());
  const detach = bindCoursePrivacy(exercises, Promise.resolve(courses));
  t.after(detach);
  await Promise.resolve();
  await courses.linkExercise('curso-exemplo', 'aula-1', exercises.active());

  const source = exercises.activeEntry().session;
  const linked = sessionMidiDownload(source);
  assert.equal(linked.privateContent, true);
  assert.equal(linked.fileName, 'estudo-musical.mid', 'o nome do arquivo não leva o título do curso');
  assert.equal(Buffer.from(linked.bytes).includes(Buffer.from(SECRET)), false, 'o evento de texto FF 03 do MIDI não leva o título');
  assert.deepEqual(
    Buffer.from(linked.bytes),
    Buffer.from(sessionToMidi({ ...source, name: PUBLIC_EXERCISE_NAME })),
    'só o nome muda: a frase (canal 1) e os acordes (canal 2) saem iguais',
  );
});

test('canário: o bloco study privado não sai no público, nem dentro da receita ou do resumo', () => {
  // Texto livre ANINHADO no bloco privado: nome/id de forma autoral ou
  // importada, resumo e um campo importado desconhecido. Nada disso é prova de
  // que a receita é pública — por isso o bloco inteiro fica de fora.
  const CANARY = 'CANARIO-DE-ESTUDO';
  const exercises = library();
  const id = exercises.active();
  exercises.updateMetadata(id, {
    courseContent: true,
    study: {
      version: 1,
      recipe: {
        family: 'arpejo_triade_forma_unica',
        shape: { id: 'forma-1', name: CANARY },
        shapes: [{ id: 'forma-1', name: CANARY }],
        imported: { name: CANARY },
      },
      summary: { title: CANARY, bars: 2 },
      origin: { id: 'aula-7', name: CANARY, kind: 'course', private: true },
      group: { id: 'g-aula', label: CANARY, private: true },
    },
  });
  const marked = exercises.get(id);
  assert.equal(marked.metadata.study.recipe.shape.name, CANARY, 'o canário está guardado na loja');

  // Exportação PADRÃO: bloco study inteiro fora, música idêntica.
  const exported = exercises.exportExercise(id);
  assert.equal(exported.includes(CANARY), false);
  const parsed = JSON.parse(exported);
  assert.equal(Object.hasOwn(parsed.exercise.metadata, 'study'), false);
  assert.deepEqual(musicalNotes(parsed.exercise.session), musicalNotes(marked.session));
  assert.deepEqual(musicalNotes(shareableExercise(marked).session), musicalNotes(marked.session));
  assert.equal(JSON.stringify(shareableLibrary({ entries: [marked], activeId: id })).includes(CANARY), false);

  // MIDI e link de compartilhamento: música igual e nenhum canário do bloco.
  const midi = sessionMidiDownload(marked.session);
  assert.equal(Buffer.from(midi.bytes).includes(Buffer.from(CANARY)), false);
  const shared = decodeSessionLink(new URL(shareUrl(marked.session, location, { privateContent: true })).hash);
  assert.deepEqual(musicalNotes(shared), musicalNotes(marked.session));
  assert.equal(JSON.stringify(shared).includes(CANARY), false);

  // Retrato PRIVADO explícito: o bloco inteiro continua no arquivo.
  const raw = JSON.parse(exercises.exportLibrary({ includeCourseContent: true }));
  const kept = raw.entries.find(candidate => candidate.id === id);
  assert.equal(kept.metadata.study.recipe.shape.name, CANARY);
  assert.equal(kept.metadata.study.summary.title, CANARY);
  assert.equal(kept.metadata.study.origin.private, true);
});

test('marca pegajosa: importar, duplicar ou autosalvar cópia sem marca não apaga a marca local', () => {
  const exercises = library();
  const id = exercises.active();
  exercises.updateMetadata(id, { courseContent: true });
  const entry = exercises.get(id);

  // Cópia da MESMA sessão vinda de fora SEM a marca: o documento local não pode
  // perder a marca histórica (o vínculo com a aula já existiu).
  exercises.importExercise(JSON.stringify({ kind: 'groovegoblin-exercise', exercise: {
    id: 'documento-de-fora', session: entry.session, metadata: { ...entry.metadata, courseContent: false, name: 'Cópia sem marca' },
  } }));
  assert.equal(exercises.get(id).metadata.courseContent, true, 'a importação não apaga a marca local');

  const copy = exercises.duplicate(id);
  assert.equal(exercises.get(copy.id).metadata.courseContent, true, 'a cópia leva a marca');

  exercises.autosave({ ...exercises.get(id).session, bpm: 90 }, id);
  assert.equal(exercises.get(id).metadata.courseContent, true, 'o autosave não apaga a marca');
  assert.equal(exercises.get(id).metadata.study, null);

  // O retrato público continua sem nada do exercício marcado.
  assert.equal(exercises.exportExercise(id).includes(SECRET), false);
  assert.equal(JSON.stringify(shareableLibrary({ entries: [exercises.get(id)], activeId: id })).includes(SECRET), false);
});

test('importação legada (B6): documento sem marca com o MESMO id de um exercício marcado nasce marcado', () => {
  const CANARY = 'CANARIO-DE-CURSO';
  const exercises = library();
  const marked = exercises.new({
    session: createSession({ name: CANARY, bars: 2, bpm: 80, notes: [{ id: 'm1', start: 0, duration: 4, pitch: 36, string: 3 }] }),
    metadata: { name: CANARY, notes: CANARY },
  });
  exercises.updateMetadata(marked.id, { courseContent: true });
  const plain = exercises.new({ session: createSession({ name: 'Exercício Livre', bars: 2, notes: [{ id: 'p1', start: 0, duration: 4, pitch: 52, string: 4 }] }) });

  // Documento ANTIGO: mesmo id, SEM `courseContent` e SEM `study`, com a sessão
  // um pouco diferente (logo, documento NOVO pela chave de conteúdo — a chave
  // inclui a marca). A herança por ID é o que impede a cópia pública.
  const legacySession = createSession({ name: CANARY, bars: 2, bpm: 95, notes: [{ id: 'm1', start: 0, duration: 4, pitch: 36, string: 3 }] });
  const legacyMetadata = { name: CANARY, tags: [], targetBPM: null, notes: CANARY, records: [], courseContent: false };
  const outcome = exercises.importExercise(JSON.stringify({ kind: 'groovegoblin-exercise', exercise: {
    id: marked.id, createdAt: marked.createdAt, updatedAt: marked.updatedAt, metadata: legacyMetadata, session: legacySession,
  } }));
  assert.equal(outcome.added, 1, 'a sessão diferente entra como documento novo');

  // O exercício ATIVO é um exercício público: nenhuma folga conservadora do
  // ativo pode mascarar o vazamento.
  exercises.select(plain.id);
  const copy = exercises.list().find(row => row.name === CANARY && row.id !== marked.id);
  assert.ok(copy, 'a cópia entrou na biblioteca');
  assert.equal(exercises.get(copy.id).metadata.courseContent, true, 'a marca é herdada pelo id de origem');
  assert.equal(JSON.stringify(shareableLibrary({ entries: [exercises.get(copy.id)], activeId: plain.id })).includes(CANARY), false);
  assert.equal(exercises.exportExercise(copy.id).includes(CANARY), false);
  assert.equal(exercises.exportLibrary().includes(CANARY), false, 'o retrato público não leva o canário');
  assert.equal(exercises.exportLibrary({ includeCourseContent: true }).includes(CANARY), true, 'o retrato privado leva o documento inteiro');

  // Mesmo caminho da importação AGREGADA (backup): o documento antigo com o
  // mesmo id também nasce marcado, e o retrato público sai limpo.
  const aggregated = library();
  const local = aggregated.new({
    session: createSession({ name: CANARY, bars: 2, bpm: 80, notes: [{ id: 'm1', start: 0, duration: 4, pitch: 36, string: 3 }] }),
    metadata: { name: CANARY, notes: CANARY },
  });
  aggregated.updateMetadata(local.id, { courseContent: true });
  const result = aggregated.importEntries([{ id: local.id, session: legacySession, metadata: legacyMetadata }], { activeId: null });
  assert.equal(result.added, 1);
  const rows = aggregated.list().filter(row => row.name === CANARY);
  assert.equal(rows.length, 2, 'o documento antigo entra como exercício novo');
  assert.deepEqual(rows.map(row => aggregated.get(row.id).metadata.courseContent), [true, true]);
  assert.equal(aggregated.exportLibrary().includes(CANARY), false);
});

test('duplicate import cannot discard a newly supplied privacy mark', () => {
  const exercises = library();
  const id = exercises.active();
  const entry = exercises.get(id);
  const outcome = exercises.importExercise(JSON.stringify({ kind: 'groovegoblin-exercise', exercise: {
    session: entry.session, metadata: { ...entry.metadata, courseContent: true },
  } }));
  assert.deepEqual(outcome, { added: 0, skipped: 1 });
  assert.equal(exercises.get(id).metadata.courseContent, true);
  assert.equal(exercises.exportExercise(id).includes(SECRET), false);
});

test('documento remoto (sync): não rebaixa a marca local e o vínculo de material da aula sobrevive', () => {
  const CANARY = 'CANARIO-DE-CURSO';
  const MATERIAL = { name: 'Apostila-Exemplo.pdf', lessonId: 'aula-7', resourceId: 'recurso-1', page: 3 };
  const exercises = library();
  const marked = exercises.new({
    session: createSession({ name: CANARY, bars: 2, bpm: 80, notes: [{ id: 'm1', start: 0, duration: 4, pitch: 36, string: 3 }] }),
    metadata: {
      name: CANARY, notes: CANARY,
      study: { version: 5, recipe: { pattern: 'arpeggio' }, summary: null,
        origin: { id: 'aula-7', name: CANARY, kind: 'course', material: MATERIAL }, group: null },
    },
  });
  assert.equal(exercises.get(marked.id).metadata.courseContent, true, 'a origem de curso tinge o exercício');
  // Um exercício PÚBLICO é o ativo: nenhuma folga conservadora do ativo pode
  // mascarar o vazamento pelo retrato público.
  const plain = exercises.new({ session: createSession({ name: 'Exercício Livre', bars: 2, notes: [{ id: 'p1', start: 0, duration: 4, pitch: 52, string: 4 }] }) });
  exercises.select(plain.id);

  const oldSession = createSession({ name: CANARY, bars: 2, bpm: 95, notes: [{ id: 'm1', start: 0, duration: 4, pitch: 36, string: 3 }] });
  const oldMetadata = {
    name: CANARY, tags: [], targetBPM: null, notes: CANARY, records: [], courseContent: false,
    study: { version: 5, recipe: { pattern: 'arpeggio' }, summary: null,
      origin: { id: 'aula-7', name: CANARY, kind: 'course' }, group: null },
  };
  // Documento remoto ANTIGO do MESMO exercício: sem a marca e sem o vínculo de
  // material. Aplicar o servidor não pode rebaixar o que já era privado aqui,
  // nem apagar a apostila que a aula já conhecia.
  exercises.applyRemoteEntry({ id: marked.id, createdAt: marked.createdAt, updatedAt: '2026-02-02T00:00:00.000Z', session: oldSession, metadata: oldMetadata });
  const applied = exercises.get(marked.id);
  assert.equal(applied.metadata.courseContent, true, 'a marca local não desce com o documento remoto');
  assert.deepEqual(applied.metadata.study.origin.material, MATERIAL, 'o vínculo de material sobrevive à aplicação remota');
  assert.equal(exercises.exportLibrary().includes(CANARY), false, 'o retrato público continua limpo');
  assert.equal(exercises.exportLibrary().includes('Apostila-Exemplo.pdf'), false, 'o nome do material privado não sai no retrato público');
  assert.equal(exercises.exportLibrary({ includeCourseContent: true }).includes(CANARY), true, 'o retrato privado leva o documento inteiro');

  // Documento remoto COM vínculo (outro recurso/página): o que o servidor manda
  // vale, e o retrato público continua sem o material.
  const remoteMaterial = { name: 'Apostila-Exemplo.pdf', lessonId: 'aula-9', resourceId: 'recurso-2', page: 12 };
  exercises.applyRemoteEntry({
    id: marked.id, createdAt: marked.createdAt, updatedAt: '2026-03-03T00:00:00.000Z', session: oldSession,
    metadata: { ...oldMetadata,
      study: { version: 5, recipe: { pattern: 'arpeggio' }, summary: null,
        origin: { id: 'aula-7', name: CANARY, kind: 'course', material: remoteMaterial }, group: null } },
  });
  assert.deepEqual(exercises.get(marked.id).metadata.study.origin.material, remoteMaterial, 'o material do servidor é aplicado');
  assert.equal(exercises.get(marked.id).metadata.courseContent, true);
  assert.equal(exercises.exportLibrary().includes('Apostila-Exemplo.pdf'), false);
});
