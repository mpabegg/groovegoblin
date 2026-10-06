// Cliente do material do curso no servidor e pasta de entrada (rodada 6, etapa 8) — consumidor.
//
// Sonda de /api/health (modo local quieto), relatório, envio de vários arquivos
// com o nome percent-encoded no cabeçalho, vínculo manual e a interface da
// pasta de entrada na página do curso (arrastar/soltar e vincular).
//
// Tudo fictício: "Curso de Exemplo", "Apostila de Exemplo", exemplo.invalid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_KINDS, CONTENT_STATUS, contentExtension, contentKindOf, createCourseContentClient,
  decodeFilenameHeader, encodeFilenameHeader, formatContentSize, intakeAccepts, mountCourseMaterials,
  parseContentRefs, resetSharedCourseMaterials, sharedCourseMaterials,
} from '../src/course-content.js';
import { installDom, makeEvent, makeRoot } from './course-lesson-dom.js';

const BASE = 'https://groove.exemplo.ts.net/';
const COURSE_ID = 'curso-exemplo';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function jsonResponse(status, value) {
  return { ok: status >= 200 && status < 300, status, async json() { return value; } };
}

function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null };
    calls.push(call);
    for (const [fragment, handler] of routes) {
      if (call.url.includes(fragment)) return handler(call);
    }
    return jsonResponse(404, { error: 'not_found' });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const HEALTH_OK = ['/api/health', () => jsonResponse(200, { ok: true, service: 'groovegoblin', apiVersion: 1 })];

function reportFixture() {
  return {
    courseId: COURSE_ID, total: 159, available: 142, refs: 142, missingBlobs: 0,
    missing: [{ refKey: 'ref-1', lessonId: 'aula-1', resourceId: 'material-1', name: 'Apostila de Exemplo.pdf', role: 'apostila', extension: 'pdf' }],
    unmatched: [{ id: 'Extra de Exemplo.pdf', name: 'Extra de Exemplo.pdf', extension: 'pdf', size: 10, reason: 'no-material', insideZip: null }],
    files: { scanned: 3, skipped: 0, sixStrings: 0, bytes: 2048, files: 3 },
    zip: { archives: 0, entries: 0, pdfMembers: 0, bytes: 0 },
  };
}

test('conteúdo: sem servidor fica quieto em modo local', async () => {
  const client = createCourseContentClient({ basePath: BASE, fetchImpl: makeFetch([]) });
  assert.equal(client.status, CONTENT_STATUS.unknown);
  assert.equal(client.available(), false);
  assert.equal(await client.start(), CONTENT_STATUS.local);
  assert.equal(client.available(), false);
  assert.equal(await client.report(COURSE_ID), null);
  assert.equal(await client.loadRefs(COURSE_ID), null);
  assert.equal(await client.upload(COURSE_ID, { name: 'a.pdf' }).then((result) => result.error), 'local');
});

test('conteúdo: sonda aceita só a resposta do próprio servidor e avisa quem observa', async () => {
  const payloads = [
    ['/api/health', () => jsonResponse(200, { ok: true, service: 'outro servico' })],
  ];
  const estranho = createCourseContentClient({ basePath: BASE, fetchImpl: makeFetch(payloads) });
  assert.equal(await estranho.start(), CONTENT_STATUS.local);

  const events = [];
  const client = createCourseContentClient({ basePath: BASE, fetchImpl: makeFetch([HEALTH_OK]), onChange: (id) => events.push(id) });
  assert.equal(await client.start(), CONTENT_STATUS.ready);
  assert.equal(client.available(), true);
  assert.deepEqual(events, [null]);
  assert.equal(await client.probe(), CONTENT_STATUS.ready);
  assert.deepEqual(events, [null], 'a segunda sonda não repete o aviso');
  assert.equal(client.healthUrl(), `${BASE}api/health`);
});

test('conteúdo: relatório e vínculos vêm da API autenticada da própria origem', async () => {
  const fetchImpl = makeFetch([
    HEALTH_OK,
    [`/api/courses/${COURSE_ID}/materials`, () => jsonResponse(200, reportFixture())],
    [`/api/docs/courseAttachments/${COURSE_ID}`, () => jsonResponse(200, {
      refs: {
        'ref-1': { sha256: SHA_A, size: 10, kind: 'pdf', name: 'Apostila de Exemplo.pdf', addedAt: '2026-01-01T00:00:00.000Z' },
        'ref-2': { sha256: 'nao-e-sha', size: 1, kind: 'pdf', name: 'quebrado', addedAt: null },
      },
    })],
  ]);
  const client = createCourseContentClient({ basePath: BASE, fetchImpl });
  await client.start();

  const report = await client.report(COURSE_ID);
  assert.equal(report.available, 142);
  assert.equal(report.total, 159);

  const refs = await client.loadRefs(COURSE_ID);
  assert.deepEqual(Object.keys(refs), ['ref-1'], 'vínculo sem sha256 válido é descartado');
  assert.equal(client.refFor(COURSE_ID, 'ref-1').kind, 'pdf');
  assert.equal(client.refFor(COURSE_ID, 'ref-2'), null);
  assert.equal(client.hasRefs(COURSE_ID), true);
  assert.equal(client.blobUrl(SHA_A), `${BASE}api/blobs/${SHA_A}`);
  assert.equal(client.blobUrl('curto'), null);

  const urls = fetchImpl.calls.map((call) => call.url);
  assert.deepEqual(urls, [
    `${BASE}api/health`,
    `${BASE}api/courses/${COURSE_ID}/materials`,
    `${BASE}api/docs/courseAttachments/${COURSE_ID}`,
  ]);
});

test('conteúdo: importar a pasta de entrada vai por POST e o relatório continua GET', async () => {
  const fetchImpl = makeFetch([
    HEALTH_OK,
    [`/api/courses/${COURSE_ID}/materials/scan`, (call) => (call.method === 'POST' ? jsonResponse(200, reportFixture()) : jsonResponse(405, { error: 'method_not_allowed' }))],
    [`/api/courses/${COURSE_ID}/materials`, () => jsonResponse(200, reportFixture())],
  ]);
  const client = createCourseContentClient({ basePath: BASE, fetchImpl });
  await client.start();

  const applied = await client.scan(COURSE_ID);
  assert.equal(applied.ok, true);
  assert.equal(applied.report.available, 142);
  const post = fetchImpl.calls.at(-1);
  assert.equal(post.method, 'POST');
  assert.equal(post.url, `${BASE}api/courses/${COURSE_ID}/materials/scan`);

  const report = await client.report(COURSE_ID);
  assert.equal(report.available, 142);
  assert.equal(fetchImpl.calls.at(-1).method, 'GET');
  assert.equal(fetchImpl.calls.at(-1).url, `${BASE}api/courses/${COURSE_ID}/materials`);
});

test('conteúdo: curso sem vínculos no servidor devolve mapa vazio em vez de erro', async () => {
  const client = createCourseContentClient({
    basePath: BASE,
    fetchImpl: makeFetch([HEALTH_OK, ['/api/docs/courseAttachments/', () => jsonResponse(404, { error: 'not_found' })]]),
  });
  await client.start();
  assert.deepEqual(await client.loadRefs('outro-curso'), {});
  assert.equal(client.refFor('outro-curso', 'ref-1'), null);
});

test('conteúdo: envio manda o nome percent-encoded e vários arquivos em fila', async () => {
  const fetchImpl = makeFetch([
    HEALTH_OK,
    [`/api/courses/${COURSE_ID}/materials`, (call) => (call.method === 'POST'
      ? jsonResponse(201, { ok: true, stored: { id: call.headers['X-Groove-Filename'], matched: ['ref-1'], unmatched: false } })
      : jsonResponse(200, reportFixture()))],
    ['/api/docs/courseAttachments/', () => jsonResponse(200, { refs: {} })],
  ]);
  const client = createCourseContentClient({ basePath: BASE, fetchImpl });
  await client.start();
  await client.loadRefs(COURSE_ID);

  const file = { name: 'Apostila de Exemplo (1).pdf', size: 12 };
  const single = await client.upload(COURSE_ID, file);
  assert.equal(single.ok, true);
  const post = fetchImpl.calls.find((call) => call.method === 'POST');
  assert.equal(post.url, `${BASE}api/courses/${COURSE_ID}/materials`);
  assert.equal(post.headers['Content-Type'], 'application/octet-stream');
  assert.equal(post.headers['X-Groove-Filename'], encodeURIComponent('Apostila de Exemplo (1).pdf'));
  assert.equal(decodeFilenameHeader(post.headers['X-Groove-Filename']), 'Apostila de Exemplo (1).pdf');
  assert.equal(post.body, file);
  assert.equal(client.hasRefs(COURSE_ID), false, 'o envio invalida a cópia dos vínculos');

  const seen = [];
  const results = await client.uploadMany(COURSE_ID, [{ name: 'a.pdf' }, { name: 'b.mp3' }], { onEach: (info) => seen.push(info.index) });
  assert.equal(results.length, 2);
  assert.deepEqual(seen, [0, 1]);
  assert.equal(fetchImpl.calls.filter((call) => call.method === 'POST').length, 3);
  assert.equal(decodeFilenameHeader(encodeFilenameHeader('Módulo 1.pdf')), 'Módulo 1.pdf');
  assert.equal(decodeFilenameHeader('%E0%ZZ'), null);
  assert.equal(decodeFilenameHeader(''), null);
});

test('conteúdo: vínculo manual manda refKey e id em JSON e respeita o erro do servidor', async () => {
  const fetchImpl = makeFetch([
    HEALTH_OK,
    ['/materials/bind', (call) => (JSON.parse(String(call.body)).id === 'ruim'
      ? jsonResponse(400, { error: 'six_strings', message: 'de 6 cordas' })
      : jsonResponse(200, { ok: true, ref: { refKey: 'ref-1', sha256: SHA_B, size: 3, kind: 'pdf', name: 'x.pdf' } }))],
  ]);
  const client = createCourseContentClient({ basePath: BASE, fetchImpl });
  await client.start();
  const bound = await client.bind(COURSE_ID, { refKey: 'ref-1', id: 'Apostila.pdf' });
  assert.equal(bound.ok, true);
  const call = fetchImpl.calls.at(-1);
  assert.equal(call.url, `${BASE}api/courses/${COURSE_ID}/materials/bind`);
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(call.body)), { refKey: 'ref-1', id: 'Apostila.pdf' });

  const refused = await client.bind(COURSE_ID, { refKey: 'ref-1', id: 'ruim' });
  assert.deepEqual([refused.ok, refused.error, refused.message], [false, 'six_strings', 'de 6 cordas']);
});

test('conteúdo: tipo pelo nome aceita só o que a pasta de entrada recebe', () => {
  assert.equal(contentKindOf('Apostila.PDF'), CONTENT_KINDS.pdf);
  assert.equal(contentKindOf('Faixa.mp3'), CONTENT_KINDS.audio);
  assert.equal(contentKindOf('Pacote.zip'), CONTENT_KINDS.other);
  assert.equal(contentExtension('Apostila.PDF'), 'pdf');
  assert.equal(intakeAccepts('a.pdf'), true);
  assert.equal(intakeAccepts('a.WAV'), true);
  assert.equal(intakeAccepts('a.zip'), true);
  assert.equal(intakeAccepts('a.mp4'), false);
  assert.equal(formatContentSize(0), '0 B');
  assert.equal(formatContentSize(2048), '2 KB');
  assert.equal(formatContentSize(3 * 1024 * 1024), '3.0 MB');
  assert.equal(parseContentRefs({ refs: { x: { sha256: SHA_A, size: 2, kind: 'audio', name: 'n', addedAt: null } } }).x.kind, 'audio');
  assert.equal(parseContentRefs({ refs: [] }), null);
  assert.equal(parseContentRefs(null), null);
});

test('conteúdo: sem servidor, nada de material do servidor é montado na página do curso', async (t) => {
  const release = installDom();
  const root = makeRoot();
  const client = createCourseContentClient({ basePath: BASE, fetchImpl: makeFetch([]) });
  t.after(() => { resetSharedCourseMaterials(); release(); });
  await client.start();
  assert.equal(sharedCourseMaterials({ content: client, courseId: COURSE_ID }), null);
  assert.equal(root.children.length, 0);
});

test('conteúdo: a página do curso lista o relatório, envia por arrastar/soltar e vincula', async (t) => {
  const release = installDom();
  t.after(() => { resetSharedCourseMaterials(); release(); });
  const root = makeRoot();
  const notifications = [];
  const uploads = [];
  const binds = [];
  const content = {
    available: () => true,
    scan: async () => ({ ok: true, report: reportFixture() }),
    report: async () => reportFixture(),
    loadRefs: async () => ({}),
    uploadMany: async (courseId, files, { onEach }) => {
      files.forEach((file, index) => onEach?.({ index, total: files.length, name: file.name }));
      uploads.push({ courseId, names: files.map((file) => file.name) });
      return files.map(() => ({ ok: true }));
    },
    bind: async (courseId, payload) => { binds.push({ courseId, ...payload }); return { ok: true }; },
  };
  const materials = mountCourseMaterials(root, { content, courseId: COURSE_ID, notify: (text, error) => notifications.push({ text, error: !!error }) });
  await tick();

  const group = root.querySelector('#course-content-group');
  assert.match(group.querySelector('summary').textContent, /Material do curso no servidor — 142 de 159 materiais disponíveis/);
  assert.equal(root.querySelectorAll('.course-content-item').length, 0, 'a lista só é montada quando o grupo abre');

  group.open = true;
  group.dispatchEvent(makeEvent('toggle'));
  await tick();
  const itens = [...root.querySelectorAll('.course-content-item')].map((node) => node.textContent);
  assert.ok(itens.some((text) => text.includes('Faltando (1)') || text.includes('Apostila de Exemplo.pdf')));
  assert.ok(itens.some((text) => text.includes('Extra de Exemplo.pdf')));
  assert.match(root.querySelector('#course-content-missing').textContent, /Apostila de Exemplo\.pdf/);

  const zone = root.querySelector('.course-intake-drop');
  zone.dispatchEvent(makeEvent('drop', { dataTransfer: { files: [{ name: 'Apostila de Exemplo.pdf' }, { name: 'video.mp4' }] } }));
  await tick();
  assert.deepEqual(uploads, [{ courseId: COURSE_ID, names: ['Apostila de Exemplo.pdf'] }], 'arquivo que a pasta não aceita nem é enviado');
  assert.ok(notifications.some((item) => item.error === false && /1 arquivo\(s\) enviados/.test(item.text)));

  const select = root.querySelector('#course-content-unmatched').querySelector('select');
  const botao = root.querySelector('#course-content-unmatched').querySelector('button');
  select.value = 'ref-1';
  botao.click();
  await tick();
  assert.deepEqual(binds, [{ courseId: COURSE_ID, refKey: 'ref-1', id: 'Extra de Exemplo.pdf' }]);
  void materials;
});

test('conteúdo: a página do curso importa a pasta por POST antes de mostrar o relatório', async (t) => {
  const release = installDom();
  t.after(() => { resetSharedCourseMaterials(); release(); });
  const calls = [];
  const base = {
    available: () => true,
    scan: async (courseId) => { calls.push(['scan', courseId]); return { ok: true, report: reportFixture() }; },
    report: async (courseId) => { calls.push(['report', courseId]); return reportFixture(); },
    loadRefs: async () => ({}),
    uploadMany: async () => [],
    bind: async () => ({ ok: true }),
  };
  const root = makeRoot();
  const mounted = mountCourseMaterials(root, { content: base, courseId: COURSE_ID, notify: () => {} });
  await tick();
  assert.deepEqual(calls, [['scan', COURSE_ID]], 'o GET do relatório é só reserva');
  assert.match(root.querySelector('#course-content-group').querySelector('summary').textContent, /142 de 159 materiais disponíveis/);

  // POST recusado (servidor antigo, limite): mostra o que já está gravado, sem mentir.
  calls.length = 0;
  const refused = { ...base, scan: async (courseId) => { calls.push(['scan', courseId]); return { ok: false, error: 'limit_exceeded' }; } };
  const outro = mountCourseMaterials(makeRoot(), { content: refused, courseId: COURSE_ID, notify: () => {} });
  await tick();
  assert.deepEqual(calls, [['scan', COURSE_ID], ['report', COURSE_ID]]);
  void mounted;
  void outro;
});

test('conteúdo: falha do servidor no envio é avisada sem mentir sobre o que subiu', async (t) => {
  const release = installDom();
  const root = makeRoot();
  t.after(() => { resetSharedCourseMaterials(); release(); });
  const notifications = [];
  const content = {
    available: () => true,
    scan: async () => ({ ok: true, report: reportFixture() }),
    report: async () => reportFixture(),
    loadRefs: async () => ({}),
    uploadMany: async () => [{ ok: false, error: 'six_strings', message: 'de 6 cordas' }],
    bind: async () => ({ ok: false, error: 'unsupported_file' }),
  };
  mountCourseMaterials(root, { content, courseId: COURSE_ID, notify: (text, error) => notifications.push({ text, error: !!error }) });
  await tick();
  const group = root.querySelector('#course-content-group');
  group.open = true;
  group.dispatchEvent(makeEvent('toggle'));
  await tick();

  const zone = root.querySelector('.course-intake-drop');
  zone.dispatchEvent(makeEvent('drop', { dataTransfer: { files: [{ name: 'Apostila.pdf' }] } }));
  await tick();
  assert.ok(notifications.some((item) => item.error && /0 de 1 arquivo\(s\) enviados/.test(item.text)), 'nada subiu: o aviso não pode dizer que subiu');
  assert.ok(notifications.some((item) => item.error && /6 cordas/.test(item.text)));

  const select = root.querySelector('#course-content-unmatched').querySelector('select');
  select.value = 'ref-1';
  root.querySelector('#course-content-unmatched').querySelector('button').click();
  await tick();
  assert.ok(notifications.some((item) => item.error && /Só PDF, áudio/.test(item.text)));
});
