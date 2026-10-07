// Importador de cursos (laptop → ssh → trabalhador no Pi), com dados fictícios.
//
// O "ssh" dos testes é um node local que recebe o MESMO programa pelo stdin e
// fala com um servidor de verdade (modo tailscale, data dir temporário). Nada
// aqui vem de curso real: mapa e catálogo são os fixtures de exemplo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { attachmentRefKey } from '../src/course-attachments.js';
import { matchKey } from '../server/matching.js';
import { MANAGED_DATA_ENTRIES, materialPathProblem, mergeProgress, planFlatten, refsToRestore, resolveMaterialFolder, suffixedName } from '../scripts/course-import-worker.js';
import { ImportConfigError, MANIFEST_FORMAT, intakeLimitSources, resolveRemoteConfig, runImport } from '../scripts/import-courses.js';
import { LOGIN, PUBLIC_ORIGIN, startServer, tailscaleEnv, tempDir } from './server-harness.js';
import { buildPdf } from './server-zip-fixtures.js';

const FIXTURES = new URL('./fixtures/course/', import.meta.url);
const COURSE_ID = 'curso-de-exemplo';
const LESSON_ID = 'lesson-downloads';
const APOSTILA = 'apostila-exemplo-4-cordas.pdf';
const FAIXA_4 = 'faixa-exemplo-4-cordas-80bpm.mp3';
const FAIXA_5 = 'faixa-exemplo-5-cordas-90bpm.mp3';
const sha = (data) => createHash('sha256').update(data).digest('hex');
const audio = (text) => Buffer.from(`ID3\x04\x00\x00\x00\x00\x00\x00${text}`, 'latin1');

test('cópia plana: mesmo nome+conteúdo entra uma vez; conteúdo diferente ganha sufixo determinístico que ainda casa', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const sources = [
    { rel: 'modulo-2/Apostila.pdf', name: 'Apostila.pdf', size: 10, sha256: a },
    { rel: 'modulo-1/Apostila.pdf', name: 'Apostila.pdf', size: 10, sha256: a },
    { rel: 'extras/Apostila.pdf', name: 'Apostila.pdf', size: 12, sha256: b },
  ];
  const plan = planFlatten(sources, new Map());
  assert.deepEqual(planFlatten([...sources].reverse(), new Map()), plan, 'a ordem de leitura não muda o plano');
  assert.equal(plan.collapsed, 1);
  assert.deepEqual(plan.copies.map((copy) => copy.storedAs), ['Apostila.pdf', suffixedName('Apostila.pdf', a)]);
  assert.equal(plan.copies[0].sha256, b, 'o primeiro caminho em ordem fica com o nome puro');
  assert.equal(plan.collisions.length, 1);
  assert.equal(plan.collisions[0].variants.length, 2);
  assert.equal(matchKey(plan.copies[1].storedAs), matchKey('Apostila.pdf'), 'a variante continua casando com o mesmo material');

  // Pasta de entrada já ocupada por outro conteúdo no nome puro: nada é
  // sobrescrito; o que já está lá não é copiado de novo.
  const occupied = planFlatten(sources, new Map([['Apostila.pdf', { sha256: 'c'.repeat(64), size: 3 }], [suffixedName('Apostila.pdf', a), { sha256: a, size: 10 }]]));
  assert.deepEqual(occupied.copies.map((copy) => [copy.storedAs, copy.sha256]), [[suffixedName('Apostila.pdf', b), b]]);
  assert.deepEqual(occupied.present.map((entry) => entry.storedAs), [suffixedName('Apostila.pdf', a)]);
});

test('vínculos anteriores voltam depois do scan, menos os que apontam para blob sumido', () => {
  const ref = (sha256) => ({ sha256, size: 1, kind: 'audio', name: 'x.mp3' });
  const before = { manual: ref('1'.repeat(64)), broken: ref('2'.repeat(64)), same: ref('3'.repeat(64)) };
  const after = { manual: ref('9'.repeat(64)), broken: ref('8'.repeat(64)), same: ref('3'.repeat(64)), fresh: ref('7'.repeat(64)) };
  const decision = refsToRestore(before, after, (sha256) => sha256 !== '2'.repeat(64));
  assert.deepEqual(Object.keys(decision.restore), ['manual']);
  assert.deepEqual(decision.keptScan, ['broken']);
});

test('configuração: o manifesto decide; fontes discordantes param sem citar o valor', () => {
  const deployEnv = { SSH_TARGET: 'pi@pi-exemplo', NODE_BIN: '/usr/bin/node', SERVICE_USER: 'groovegoblin', DATA_DIR: '/var/lib/groovegoblin', SERVICE_PORT: '5173' };
  const deploymentResult = { dataDir: '/srv/outro-lugar', envFile: '/etc/groovegoblin/groove.env' };
  assert.throws(() => resolveRemoteConfig({ deployEnv, deploymentResult }), (error) => error instanceof ImportConfigError && /dataDir/.test(error.message) && !error.message.includes('/srv/outro-lugar'));
  const remote = resolveRemoteConfig({ deployEnv, deploymentResult, manifestRemote: { dataDir: '/var/lib/groovegoblin' } });
  assert.equal(remote.dataDir, '/var/lib/groovegoblin');
  assert.equal(remote.servicePort, 5173);
  assert.equal(remote.sshTarget, 'pi@pi-exemplo');
});

test('pasta de material dentro do diretório de dados: árvore própria aceita; pastas geridas, ancestral, fora da raiz e links recusados', async (t) => {
  const dir = await tempDir(t, 'gg-material-');
  const dataDir = join(dir, 'dados');
  for (const name of ['material/curso', 'entrada/curso', 'blobs', 'backups', 'private', 'tmp', 'import-backups']) await mkdir(join(dataDir, name), { recursive: true });
  await mkdir(join(dir, 'fora'), { recursive: true });
  const refused = (reason) => (error) => error?.code === 'material_path_refused' && error.detail?.reason === reason;

  // Árvore própria dentro do diretório de dados: aceita (relativa ou absoluta).
  const own = { materialRoot: join(dataDir, 'material') };
  const accepted = await resolveMaterialFolder(own, 'curso', dataDir, { linksProtected: true });
  assert.equal(accepted.path, join(dataDir, 'material', 'curso'));
  assert.equal(accepted.underDataDir, true);
  assert.equal((await resolveMaterialFolder({ materialRoot: dataDir }, 'material/curso', dataDir, { linksProtected: true })).underDataDir, true);
  assert.equal((await resolveMaterialFolder(own, join(dataDir, 'material', 'curso'), dataDir, { linksProtected: true })).path, accepted.path);
  // Sem a proteção de links físicos do kernel, nada de ler dali como root.
  await assert.rejects(resolveMaterialFolder(own, 'curso', dataDir, { linksProtected: false }), refused('hardlinks-unprotected'));

  // Pastas geridas pelo servidor/importador: nunca.
  for (const name of MANAGED_DATA_ENTRIES) assert.equal(materialPathProblem(join(dataDir, name, 'x'), dataDir), 'managed-dir', name);
  await assert.rejects(resolveMaterialFolder({ materialRoot: dataDir }, 'entrada/curso', dataDir, { linksProtected: true }), refused('managed-dir'));
  await assert.rejects(resolveMaterialFolder({ materialRoot: dataDir }, 'backups', dataDir, { linksProtected: true }), refused('managed-dir'));
  // O próprio diretório de dados ou um ancestral: nunca.
  await assert.rejects(resolveMaterialFolder({ materialRoot: dataDir }, '.', dataDir, { linksProtected: true }), refused('contains-data-dir'));
  await assert.rejects(resolveMaterialFolder({ materialRoot: dir }, '.', dataDir, { linksProtected: true }), refused('contains-data-dir'));
  await assert.rejects(resolveMaterialFolder({ materialRoot: dir }, 'dados', dataDir, { linksProtected: true }), refused('contains-data-dir'));
  // Fora da raiz configurada: nem relativa com "..", nem absoluta.
  await assert.rejects(resolveMaterialFolder(own, '../../fora', dataDir, { linksProtected: true }), refused('outside-root'));
  await assert.rejects(resolveMaterialFolder(own, join(dir, 'fora'), dataDir, { linksProtected: true }), refused('outside-root'));
  // Link dentro da raiz apontando para uma pasta gerida ou para fora da raiz.
  await symlink(join(dataDir, 'entrada', 'curso'), join(dataDir, 'material', 'atalho-entrada'));
  await symlink(join(dir, 'fora'), join(dataDir, 'material', 'atalho-fora'));
  await assert.rejects(resolveMaterialFolder({ materialRoot: dataDir }, 'material/atalho-entrada', dataDir, { linksProtected: true }), refused('link-managed-dir'));
  await assert.rejects(resolveMaterialFolder(own, 'atalho-fora', dataDir, { linksProtected: true }), refused('link-outside-root'));
});

test('progresso: aulas assistidas do servidor ficam (união com o mapa), aula sumida cai, e a união é estável', () => {
  const document = {
    format: 'groovegoblin-course',
    course: { id: 'c', sections: [{ id: 's', lessons: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }] },
    progress: { watchedLessonIds: ['b', 'a'] },
  };
  const merged = mergeProgress(document, ['a', 'sumida', 'c', 'a']);
  assert.deepEqual(merged.document.progress.watchedLessonIds, ['a', 'c', 'b']);
  assert.deepEqual(merged.dropped, ['sumida']);
  assert.equal(merged.kept, 2);
  assert.equal(merged.added, 1);
  const again = mergeProgress(merged.document, merged.document.progress.watchedLessonIds);
  assert.equal(JSON.stringify(again.document), JSON.stringify(merged.document), 'segunda rodada: mesmo documento');
  // Sem progresso no servidor nem no convertido: documento intacto.
  const { progress, ...bare } = document;
  // includeProgress false com progresso no servidor: o do servidor fica.
  assert.deepEqual(mergeProgress(bare, ['c']).document.progress, { watchedLessonIds: ['c'] });
});

async function fixtureJson(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8'));
}

async function snapshotTree(root) {
  const out = {};
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const info = await lstat(path);
      if (info.isDirectory()) await walk(path);
      else out[path] = info.isSymbolicLink() ? 'link' : `${sha(await readFile(path))}|${info.mode}|${info.mtimeMs}`;
    }
  }
  await walk(root);
  return out;
}

// Pi de mentira: servidor real + ambiente do serviço + pasta de material
// aninhada + manifesto privado. O "ssh" roda o programa num node local.
async function setup(t, { materialUnderData = false } = {}) {
  const dir = await tempDir(t, 'gg-import-');
  const dataDir = join(dir, 'dados');
  const running = await startServer(t, { dataDir, env: tailscaleEnv() });
  const { client } = running;
  const envFile = join(dir, 'groove.env');
  await writeFile(envFile, [`PORT=${running.port}`, 'GROOVE_HOST=127.0.0.1', `GROOVE_DATA_DIR=${dataDir}`, 'GROOVE_AUTH=tailscale', `GROOVE_ALLOWED_LOGINS=${LOGIN}`, `GROOVE_PUBLIC_ORIGIN=${PUBLIC_ORIGIN}`, ''].join('\n'), { mode: 0o600 });

  // Material fora do diretório de dados, ou numa árvore própria dentro dele.
  const materialRoot = materialUnderData ? join(dataDir, 'material') : join(dir, 'material');
  const material = join(materialRoot, 'curso');
  const files = {
    [`modulo-1/${APOSTILA}`]: buildPdf('apostila de exemplo'),
    [`modulo-2/${APOSTILA}`]: buildPdf('apostila de exemplo'),
    [`extras/${APOSTILA}`]: buildPdf('apostila de exemplo revisada'),
    [`modulo-1/faixas/${FAIXA_4}`]: audio('faixa quatro'),
    [`modulo-1/faixas/${FAIXA_5}`]: audio('faixa cinco do pacote'),
    'modulo-1/notas.txt': Buffer.from('anotação fictícia'),
  };
  for (const [rel, data] of Object.entries(files)) {
    await mkdir(join(material, rel, '..'), { recursive: true });
    await writeFile(join(material, rel), data);
  }
  await symlink(join(material, 'modulo-1', APOSTILA), join(material, 'atalho.pdf'));

  const map = await fixtureJson('map-example.json');
  const catalog = await fixtureJson('catalog-example.json');
  await writeFile(join(dir, 'mapa.json'), JSON.stringify(map));
  await writeFile(join(dir, 'catalogo.json'), JSON.stringify(catalog));
  const manifestPath = join(dir, 'course-import.json');
  await writeFile(manifestPath, JSON.stringify({
    format: MANIFEST_FORMAT,
    remote: { sshTarget: 'pi-exemplo', nodeBin: process.execPath, envFile, serviceUser: userInfo().username, dataDir, materialRoot },
    outputDir: join(dir, 'privado'),
    courses: [{ map: 'mapa.json', catalog: 'catalogo.json', materialFolder: 'curso' }],
  }), { mode: 0o600 });

  // Estado anterior: o curso já importado COM progresso, um estado do curso no
  // app e um vínculo manual da faixa de 5 cordas para outra gravação.
  const imported = await client.post('/api/courses/convert', { json: { map, catalog, includeProgress: true } });
  assert.equal(imported.status, 201);
  const manualAudio = audio('gravação escolhida à mão');
  assert.equal((await client.put(`/api/blobs/${sha(manualAudio)}`, { body: manualAudio, headers: { 'Content-Type': 'application/octet-stream' } })).status, 201);
  const courseDoc = (await client.get(`/api/docs/courses/${COURSE_ID}`)).json();
  const resource = courseDoc.course.sections.flatMap((section) => section.lessons).find((lesson) => lesson.id === LESSON_ID).resources.find((item) => item.name === FAIXA_5);
  const manualKey = attachmentRefKey(COURSE_ID, LESSON_ID, resource.id);
  const manualRef = { sha256: sha(manualAudio), size: manualAudio.length, kind: 'audio', name: 'gravacao-manual.mp3', addedAt: '2026-01-01T00:00:00.000Z' };
  assert.equal((await client.create('courseAttachments', COURSE_ID, { refs: { [manualKey]: manualRef } })).status, 201);
  assert.equal((await client.create('courseStates', COURSE_ID, { lessons: { 'lesson-1': { watched: true, notes: 'nota fictícia' } } })).status, 201);

  const sshCalls = [];
  const fakeSsh = (command, args, options) => {
    sshCalls.push({ command, args });
    return spawn(process.execPath, ['--input-type=module', '-'], options);
  };
  const run = async (mode) => {
    const printed = [];
    const outcome = await runImport({ manifestPath, mode, spawnImpl: fakeSsh, print: (line) => printed.push(line) });
    return { ...outcome, printed };
  };
  const rewriteManifest = async (change) => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    change(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest));
  };
  return { dir, dataDir, client, material, materialRoot, manifestPath, map, catalog, manualKey, manualRef, sshCalls, run, rewriteManifest };
}

async function backupCount(client) {
  return (await client.get('/api/backups')).json().backups.length;
}

test('importa: instantâneo antes, curso idêntico intacto, cópia plana real, vínculo manual preservado e segunda rodada sem cópia', async (t) => {
  const ctx = await setup(t);
  const { client } = ctx;
  const originals = await snapshotTree(ctx.material);
  const stateBefore = await client.get(`/api/docs/courseStates/${COURSE_ID}`);
  const courseBefore = await client.get(`/api/docs/courses/${COURSE_ID}`);

  // Plano: nada muda no servidor nem no disco.
  const cursor = (await client.get('/api/health')).json().cursor;
  const plan = await ctx.run('plan');
  assert.equal(plan.exitCode, 0, plan.printed.join('\n'));
  assert.equal(plan.result.remote.courses[0].conversion.planned, 'unchanged');
  assert.equal(plan.result.remote.courses[0].source.planned, 5);
  assert.equal((await client.get('/api/health')).json().cursor, cursor);
  assert.equal(await backupCount(client), 0);
  await assert.rejects(stat(join(ctx.dataDir, 'entrada', COURSE_ID)), { code: 'ENOENT' });

  const first = await ctx.run('apply');
  assert.equal(first.exitCode, 0, first.printed.join('\n'));
  const remote = first.result.remote;
  const course = remote.courses[0];
  assert.ok(remote.backup?.name, 'instantâneo feito pela API');
  assert.equal(await backupCount(client), 1);

  // Cópia independente do instantâneo: fora de backups/, dono do serviço, 0600.
  const archive = remote.backup.archive;
  assert.match(archive.path, new RegExp(`^import-backups/${first.result.runId}/${remote.backup.name.replace(/\./g, '\\.')}$`));
  const archivePath = join(ctx.dataDir, archive.path);
  const archived = await readFile(archivePath);
  assert.equal(sha(archived), archive.sha256);
  assert.equal(sha(await readFile(join(ctx.dataDir, 'backups', remote.backup.name))), archive.sha256, 'mesmos bytes do instantâneo da API');
  assert.equal((await stat(archivePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(ctx.dataDir, 'import-backups', first.result.runId))).mode & 0o777, 0o700);

  // Progresso: o curso foi importado com progresso, então a reimportação usa o
  // mesmo formato e reconhece o documento como idêntico — nada é regravado.
  assert.equal(course.includeProgress, true);
  assert.equal(course.conversion.status, 'unchanged');
  const courseAfter = await client.get(`/api/docs/courses/${COURSE_ID}`);
  assert.equal(courseAfter.headers['x-groove-rev'], courseBefore.headers['x-groove-rev']);
  assert.deepEqual(courseAfter.json().progress, { watchedLessonIds: ['welcome-1', 'lesson-1'] });
  assert.equal(course.after.courseStates.unchanged, true);
  assert.equal((await client.get(`/api/docs/courseStates/${COURSE_ID}`)).headers['x-groove-rev'], stateBefore.headers['x-groove-rev']);

  // Cópia plana: arquivos comuns do serviço (0600, sem link), um por conteúdo,
  // variante com sufixo determinístico; originais intactos; TODO arquivo comum
  // entra (o .txt também, e o scan o relata como não casado); link fica fora.
  const intake = join(ctx.dataDir, 'entrada', COURSE_ID);
  const revised = buildPdf('apostila de exemplo revisada');
  const original = buildPdf('apostila de exemplo');
  const expectedNames = [APOSTILA, suffixedName(APOSTILA, sha(original)), FAIXA_4, FAIXA_5, 'notas.txt'].sort();
  assert.deepEqual((await readdir(intake)).sort(), expectedNames);
  for (const name of expectedNames) {
    const info = await lstat(join(intake, name));
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.nlink, 1);
    assert.equal(info.mode & 0o777, 0o600);
  }
  assert.equal(sha(await readFile(join(intake, APOSTILA))), sha(revised), '"extras/" vem antes de "modulo-1/": fica com o nome puro');
  assert.equal(course.source.duplicatesCollapsed, 1);
  assert.equal(course.source.collisions.length, 1);
  assert.equal(course.source.skipped.symlinks, 1);
  assert.deepEqual(course.source.skippedPaths, [{ rel: 'atalho.pdf', kind: 'symlink' }]);
  assert.equal(course.source.unsupported, 1);
  assert.equal(course.copy.copied, 5);
  assert.deepEqual(course.copy.repaired, { hardlinks: 0, ownerMode: 0 });
  assert.equal(course.copy.originalsChanged, 0);
  assert.deepEqual(await snapshotTree(ctx.material), originals);

  // O scan achou outra faixa para o material vinculado à mão; o vínculo manual voltou.
  assert.deepEqual(course.scan.restored, [ctx.manualKey]);
  const refs = (await client.get(`/api/docs/courseAttachments/${COURSE_ID}`)).json().refs;
  assert.equal(refs[ctx.manualKey].sha256, ctx.manualRef.sha256);
  assert.equal(Object.keys(refs).length, 3);
  assert.equal(course.after.report.total, 3);
  assert.equal(course.after.report.available, 3);
  assert.equal(course.after.report.missing, 0);
  assert.equal(course.after.report.unmatchedByReason.unsupported, 1, 'o .txt aparece no relatório do scan');
  assert.equal(course.after.course.stats.sections, 3);
  assert.equal(course.after.course.stats.lessons, 5);
  assert.equal(course.after.course.matchesExpected, true);

  // Terminal só com contagens; o resto em arquivos 0600.
  const screen = first.printed.join('\n');
  for (const secret of [COURSE_ID, APOSTILA, LOGIN, ctx.dataDir, 'pi-exemplo']) assert.ok(!screen.includes(secret), `o terminal não cita ${secret}`);
  assert.equal((await stat(first.resultPath)).mode & 0o777, 0o600);
  assert.equal((await stat(first.logPath)).mode & 0o777, 0o600);
  assert.ok((await readFile(first.logPath, 'utf8')).includes(APOSTILA), 'o log bruto tem o detalhe');
  assert.ok(ctx.sshCalls[0].args.includes('BatchMode=yes'));
  assert.match(ctx.sshCalls[0].args.at(-1), /^sudo -n -- '.+' --input-type=module -$/);

  // Segunda rodada: nada a copiar, curso idêntico, mesmo estado final.
  const second = await ctx.run('apply');
  assert.equal(second.exitCode, 0, second.printed.join('\n'));
  const again = second.result.remote.courses[0];
  assert.equal(again.conversion.status, 'unchanged');
  assert.equal(again.copy.copied, 0);
  assert.equal(again.source.present, 5);
  assert.equal(again.after.attachments.digest, course.after.attachments.digest);
  assert.equal(again.after.report.digest, course.after.report.digest);
  assert.equal(again.after.course.digest, course.after.course.digest);
  assert.deepEqual((await readdir(intake)).sort(), expectedNames);

  // O diário do mesmo dia foi substituído pela segunda rodada; a cópia da
  // primeira (o estado de antes da importação) continua intacta.
  assert.equal(second.result.remote.backup.name, remote.backup.name);
  assert.notEqual(sha(await readFile(join(ctx.dataDir, 'backups', remote.backup.name))), archive.sha256);
  assert.equal(sha(await readFile(archivePath)), archive.sha256);
  assert.notEqual(second.result.remote.backup.archive.path, archive.path);
});

test('mapa alterado: reimporta com CAS, mantém as aulas assistidas no app (não volta ao progresso do mapa) e o estado do curso', async (t) => {
  const ctx = await setup(t);
  const { client } = ctx;
  // O app marcou mais uma aula depois da primeira importação.
  const stored = await client.get(`/api/docs/courses/${COURSE_ID}`);
  const marked = { ...stored.json(), progress: { watchedLessonIds: ['lesson-3', 'welcome-1', 'lesson-1'] } };
  assert.equal((await client.update('courses', COURSE_ID, stored.headers['x-groove-rev'], marked)).status, 200);
  const revBefore = (await client.get(`/api/docs/courses/${COURSE_ID}`)).headers['x-groove-rev'];
  const stateRev = (await client.get(`/api/docs/courseStates/${COURSE_ID}`)).headers['x-groove-rev'];

  // O id do curso sai do título: com courseId fixado no manifesto, um título
  // novo para antes de qualquer conexão em vez de criar um segundo curso.
  const retitled = structuredClone(ctx.map);
  retitled.curso.titulo = 'Outro Curso de Exemplo';
  await writeFile(join(ctx.dir, 'mapa.json'), JSON.stringify(retitled));
  const manifest = JSON.parse(await readFile(ctx.manifestPath, 'utf8'));
  manifest.courses[0].courseId = COURSE_ID;
  await writeFile(ctx.manifestPath, JSON.stringify(manifest));
  const refused = await ctx.run('apply');
  assert.equal(refused.exitCode, 2);
  assert.equal(ctx.sshCalls.length, 0);

  const changed = structuredClone(ctx.map);
  changed.modulos[1].aulas[0].titulo = 'Aula 1 (revista)';
  await writeFile(join(ctx.dir, 'mapa.json'), JSON.stringify(changed));
  const outcome = await ctx.run('apply');
  assert.equal(outcome.exitCode, 0, outcome.printed.join('\n'));
  const course = outcome.result.remote.courses[0];
  assert.equal(course.conversion.planned, 'update');
  assert.equal(course.conversion.status, 'updated');
  const after = await client.get(`/api/docs/courses/${COURSE_ID}`);
  assert.notEqual(after.headers['x-groove-rev'], revBefore);
  const lesson = after.json().course.sections.flatMap((section) => section.lessons).find((item) => item.id === 'lesson-1');
  assert.equal(lesson.title, 'Aula 1 (revista)');
  assert.deepEqual(after.json().progress, { watchedLessonIds: ['lesson-3', 'welcome-1', 'lesson-1'] }, 'o progresso atual fica; o do mapa só soma');
  assert.equal(course.progress.kept, 3);
  assert.deepEqual(course.progress.dropped, []);
  assert.equal(course.conversion.progress.written, true);
  assert.equal(course.after.course.watchedLost, 0);
  assert.equal(course.after.course.matchesExpected, true);
  assert.equal((await client.get(`/api/docs/courseStates/${COURSE_ID}`)).headers['x-groove-rev'], stateRev);
  const refs = (await client.get(`/api/docs/courseAttachments/${COURSE_ID}`)).json().refs;
  assert.equal(refs[ctx.manualKey].sha256, ctx.manualRef.sha256, 'vínculo manual preservado');

  // Segunda rodada: a união já está guardada, nada é reconvertido.
  const again = await ctx.run('apply');
  assert.equal(again.exitCode, 0, again.printed.join('\n'));
  assert.equal(again.result.remote.courses[0].conversion.status, 'unchanged');
  assert.equal((await client.get(`/api/docs/courses/${COURSE_ID}`)).headers['x-groove-rev'], after.headers['x-groove-rev']);
});

test('curso sem aulas assistidas: reimportação após sincronização não reconverte nem muda a revisão', async (t) => {
  const ctx = await setup(t);
  const map = structuredClone(ctx.map);
  for (const module of map.modulos) {
    for (const lesson of module.aulas) if (lesson.meu_progresso) lesson.meu_progresso.assistida = false;
  }
  await writeFile(join(ctx.dir, 'mapa.json'), JSON.stringify(map));
  await ctx.rewriteManifest((manifest) => { manifest.courses[0].includeProgress = true; });
  const stored = await ctx.client.get(`/api/docs/courses/${COURSE_ID}`);
  const exported = stored.json();
  delete exported.progress; // representação normal exportada pelo app sem marcações
  assert.equal((await ctx.client.update('courses', COURSE_ID, stored.headers['x-groove-rev'], exported)).status, 200);
  const before = await ctx.client.get(`/api/docs/courses/${COURSE_ID}`);
  const plan = await ctx.run('plan');
  assert.equal(plan.exitCode, 0, plan.printed.join('\n'));
  assert.equal(plan.result.remote.courses[0].conversion.planned, 'unchanged');
  for (let round = 0; round < 2; round += 1) {
    const outcome = await ctx.run('apply');
    assert.equal(outcome.exitCode, 0, outcome.printed.join('\n'));
    assert.equal(outcome.result.remote.courses[0].conversion.status, 'unchanged');
    const after = await ctx.client.get(`/api/docs/courses/${COURSE_ID}`);
    assert.equal(after.headers['x-groove-rev'], before.headers['x-groove-rev']);
    assert.deepEqual(after.json(), before.json());
  }
});

test('material numa árvore própria dentro do diretório de dados: importa; pasta gerida como origem para antes de qualquer escrita', async (t) => {
  const ctx = await setup(t, { materialUnderData: true });
  const originals = await snapshotTree(ctx.material);
  const outcome = await ctx.run('apply');
  assert.equal(outcome.exitCode, 0, outcome.printed.join('\n'));
  const course = outcome.result.remote.courses[0];
  assert.equal(course.source.underDataDir, true);
  assert.equal(course.copy.copied, 5);
  assert.equal(course.after.report.available, 3);
  assert.deepEqual(await snapshotTree(ctx.material), originals);

  // A pasta de entrada (gerida) como origem: recusada no Pi, sem instantâneo novo.
  await ctx.rewriteManifest((manifest) => {
    manifest.remote.materialRoot = ctx.dataDir;
    manifest.courses[0].materialFolder = `entrada/${COURSE_ID}`;
  });
  const cursor = (await ctx.client.get('/api/health')).json().cursor;
  const refused = await ctx.run('apply');
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.result.remote.error.code, 'material_path_refused');
  assert.equal(refused.result.remote.error.reason, 'managed-dir');
  assert.equal(refused.result.remote.mutated, false);
  assert.equal(refused.result.remote.backup, null);
  assert.equal((await ctx.client.get('/api/health')).json().cursor, cursor);
  assert.equal((await readdir(join(ctx.dataDir, 'import-backups'))).length, 1);
});

test('pasta de entrada com cópia antiga ligada ao original por link físico e com modo errado: trocada por cópia nova, original intocado', async (t) => {
  const ctx = await setup(t);
  const intake = join(ctx.dataDir, 'entrada', COURSE_ID);
  const source4 = join(ctx.material, 'modulo-1', 'faixas', FAIXA_4);
  await chmod(source4, 0o644);
  await mkdir(intake, { mode: 0o700 });
  await link(source4, join(intake, FAIXA_4));
  await writeFile(join(intake, FAIXA_5), audio('faixa cinco do pacote'));
  await chmod(join(intake, FAIXA_5), 0o644);
  const before = await lstat(source4);
  assert.equal(before.nlink, 2);
  const originals = await snapshotTree(ctx.material);

  const plan = await ctx.run('plan');
  assert.equal(plan.exitCode, 0, plan.printed.join('\n'));
  const planned = plan.result.remote.courses[0].source.repairs;
  assert.deepEqual([planned.hardlinks, planned.ownerMode], [1, 2]);
  assert.equal((await lstat(join(intake, FAIXA_4))).ino, before.ino, 'o plano não troca nada');

  const outcome = await ctx.run('apply');
  assert.equal(outcome.exitCode, 0, outcome.printed.join('\n'));
  const course = outcome.result.remote.courses[0];
  assert.deepEqual(course.copy.repaired, { hardlinks: 1, ownerMode: 2 });
  assert.equal(course.copy.copied, 3);
  for (const name of [FAIXA_4, FAIXA_5]) {
    const info = await lstat(join(intake, name));
    assert.equal(info.nlink, 1);
    assert.equal(info.mode & 0o777, 0o600);
  }
  assert.notEqual((await lstat(join(intake, FAIXA_4))).ino, before.ino);
  // O inode original só perdeu a entrada da pasta de entrada: modo, dono e bytes iguais.
  const after = await lstat(source4);
  assert.equal(after.ino, before.ino);
  assert.equal(after.nlink, 1);
  assert.equal(after.mode, before.mode);
  assert.equal(after.uid, before.uid);
  assert.deepEqual(await snapshotTree(ctx.material), originals);

  const again = await ctx.run('apply');
  assert.equal(again.exitCode, 0, again.printed.join('\n'));
  assert.deepEqual(again.result.remote.courses[0].copy.repaired, { hardlinks: 0, ownerMode: 0 });
});

test('nome que a pasta de entrada não aceita: para na pré-checagem por padrão; com invalidNames "skip" segue e lista', async (t) => {
  const ctx = await setup(t);
  await writeFile(join(ctx.material, 'modulo-1', '.DS_Store'), 'fictício');
  const refused = await ctx.run('plan');
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.result.remote.error.code, 'source_refused');
  assert.deepEqual(refused.result.remote.error.problems, [{ courseId: COURSE_ID, code: 'invalid_names', paths: ['modulo-1/.DS_Store'] }]);
  assert.ok(!refused.printed.join('\n').includes('.DS_Store'), 'o terminal só conta');

  await ctx.rewriteManifest((manifest) => { manifest.invalidNames = 'skip'; });
  const plan = await ctx.run('plan');
  assert.equal(plan.exitCode, 0, plan.printed.join('\n'));
  assert.deepEqual(plan.result.remote.courses[0].source.invalidNames, ['modulo-1/.DS_Store']);
  assert.equal(plan.result.remote.courses[0].source.planned, 5);
});

test('falha de ssh: detalhe só no log privado, terminal sem host nem mensagem crua', async (t) => {
  const ctx = await setup(t);
  const printed = [];
  const failing = () => spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => { process.stderr.write("ssh: connect to host pi-secreto.example.invalid port 22: Connection refused\\n"); process.exit(255); });'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const outcome = await runImport({ manifestPath: ctx.manifestPath, mode: 'apply', spawnImpl: failing, print: (line) => printed.push(line) });
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result.error.code, 'ssh_failed');
  assert.ok(!printed.join('\n').includes('pi-secreto'));
  assert.ok((await readFile(outcome.logPath, 'utf8')).includes('pi-secreto'));
  assert.equal((await stat(outcome.logPath)).mode & 0o777, 0o600);
  assert.equal((await stat(outcome.resultPath)).mode & 0o777, 0o600);
  assert.equal(await backupCount(ctx.client), 0);
});

test('limite da pasta de entrada do Pi estourado: para na pré-checagem, sem instantâneo nem cópia', async (t) => {
  const { limitsFile } = intakeLimitSources();
  if (!limitsFile) return t.skip('o servidor deste checkout não lê limites de arquivo');
  const ctx = await setup(t);
  await writeFile(join(ctx.dataDir, limitsFile), JSON.stringify({ maxEntries: 3 }));
  const cursor = (await ctx.client.get('/api/health')).json().cursor;
  const outcome = await ctx.run('apply');
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result.remote.error.code, 'limits_exceeded');
  assert.equal(outcome.result.remote.mutated, false);
  assert.equal(outcome.result.remote.limits.effective.maxEntries, 3);
  assert.equal(await backupCount(ctx.client), 0);
  assert.equal((await ctx.client.get('/api/health')).json().cursor, cursor);
  await assert.rejects(stat(join(ctx.dataDir, 'entrada', COURSE_ID)), { code: 'ENOENT' });
});
