// Transições do resultado: quem é o dono do treino (frase da sessão x exercício
// à parte), quando o resultado fica obsoleto e quando o aviso automático de
// tomada guardada é silenciado sem esconder erros nem outros avisos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { trainingOwner } from '../src/training-result.js';
import { sessionOwner } from '../src/result-view.js';
import { quietTakeNotices, TAKE_SAVED_PREFIX, PLAYGROUND_SAVED_PREFIX } from '../src/take-notices.js';

const session = () => createSession({ bars: 4, bpm: 100, notes: [{ id: 'a', start: 0, duration: 4, pitch: 52 }] });
const takeSaved = `${TAKE_SAVED_PREFIX}3 ataque(s)).`;

test('dono do treino é decidido na origem: frase da sessão ou cópia do exercício', () => {
  const current = session();
  assert.deepEqual(trainingOwner(null, current), sessionOwner(current));
  const generated = createSession({ bars: 1, bpm: 100, notes: [{ id: 'g', start: 0, duration: 4, pitch: 60 }], extensions: { practice: { objective: 'timing', source: 'generated' } } });
  const owner = trainingOwner(generated, current);
  assert.equal(owner.kind, 'exercise');
  assert.deepEqual(owner.snapshot.notes, generated.notes);
  assert.equal(owner.snapshot.extensions.practice.source, 'generated');
  generated.notes[0].pitch = 12;
  assert.equal(owner.snapshot.notes[0].pitch, 60);
  const fromSession = createSession({ bars: 4, bpm: 100, notes: [{ id: 'a', start: 0, duration: 4, pitch: 52 }], extensions: { practice: { objective: 'timing', source: 'session' } } });
  assert.equal(trainingOwner(fromSession, current).kind, 'session');
  assert.equal(trainingOwner({ notes: [], bars: 1 }, current).kind, 'exercise');
});

test('resultado da sessão fica obsoleto quando a frase ou o andamento mudam', () => {
  const current = session();
  const owner = sessionOwner(current);
  assert.equal(sessionOwner(session()).key, owner.key);
  assert.notEqual(sessionOwner({ ...current, bpm: 90 }).key, owner.key);
  assert.notEqual(sessionOwner({ ...current, notes: [{ id: 'a', start: 0, duration: 8, pitch: 52 }] }).key, owner.key);
  assert.notEqual(sessionOwner({ ...current, loop: { startBar: 1, endBar: 2 } }).key, owner.key);
  assert.equal(sessionOwner(current).kind, 'session');
});

test('aviso de tomada guardada é silenciado apenas durante a captura automática', async () => {
  const seen = [];
  const notices = quietTakeNotices((text, error = false) => seen.push({ text, error }));
  await notices.capture(async () => { notices.notify(takeSaved); });
  assert.deepEqual(seen, []);
  notices.notify(takeSaved);
  assert.equal(seen.length, 1);
  await notices.capture(async () => { notices.notify(takeSaved, true); });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].error, true);
  await notices.capture(async () => { notices.notify('Tomada guardada em “Estudar uma música” sem áudio (falha); use “Renderizar de novo”.'); });
  assert.equal(seen.length, 3);
  assert.match(seen[2].text, /sem áudio/);
  await notices.capture(async () => { notices.notify('Sessão guardada na biblioteca.'); });
  assert.equal(seen.length, 4);
});

test('confirmação automática do playground é silenciada só na janela do treino', () => {
  const seen = [];
  const notices = quietTakeNotices((text, error = false) => seen.push({ text, error }));
  const saved = `${PLAYGROUND_SAVED_PREFIX}: cultive-a em Erros férteis quando quiser.`;
  notices.around(() => { notices.notify(saved); });
  assert.deepEqual(seen, []);
  notices.notify(saved);
  assert.equal(seen.length, 1);
  notices.around(() => {
    notices.notify(saved, true);
    notices.notify('outro aviso qualquer');
  });
  assert.equal(seen.length, 3);
  assert.equal(seen[1].error, true);
  assert.equal(seen[2].text, 'outro aviso qualquer');
  assert.equal(notices.around(() => 7), 7);
  let threw = false;
  try { notices.around(() => { throw new Error('falha na janela'); }); } catch { threw = true; }
  assert.equal(threw, true);
  notices.notify(saved);
  assert.equal(seen.length, 4);
});

test('captura devolve o resultado, propaga falhas e reabre os avisos', async () => {
  const seen = [];
  const notices = quietTakeNotices(text => seen.push(text));
  const item = { id: 'take-1' };
  assert.equal(await notices.capture(async () => item), item);
  await assert.rejects(notices.capture(async () => { throw new Error('falha ao guardar'); }), /falha ao guardar/);
  notices.notify(takeSaved);
  assert.equal(seen.length, 1);
  await notices.capture(async () => {
    notices.notify(takeSaved);
    await notices.capture(async () => { notices.notify(takeSaved); });
    notices.notify(takeSaved);
  });
  assert.equal(seen.length, 1);
});
