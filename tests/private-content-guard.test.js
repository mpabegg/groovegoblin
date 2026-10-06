import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkStagedPrivateContent } from '../scripts/private-content-guard.js';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/private-content-guard.js', import.meta.url));
async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'groove-private-guard-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await run('git', ['init', '--quiet'], { cwd });
  return {
    cwd,
    async put(file, text) {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await writeFile(join(cwd, file), text);
    },
    async stage(...files) { await run('git', ['add', '--force', '--', ...files], { cwd }); },
  };
}

test('private guard refuses new PDF, audio and ZIP outside test fixtures', async t => {
  const repo = await repository(t);
  for (const file of ['apostila-exemplo.pdf', 'faixa-exemplo.mp3', 'pacote-exemplo.zip']) {
    await repo.put(file, 'conteúdo fictício');
    await repo.stage(file);
  }
  const result = await checkStagedPrivateContent(repo);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(({ file, code }) => [file, code]).sort(), [
    ['apostila-exemplo.pdf', 'material-novo'],
    ['faixa-exemplo.mp3', 'material-novo'],
    ['pacote-exemplo.zip', 'material-novo'],
  ]);
});

test('private guard refuses a force-added path under ignored local', async t => {
  const repo = await repository(t);
  await repo.put('.gitignore', 'local/\n');
  await repo.put('local/exemplo.json', '{}');
  await repo.stage('local/exemplo.json');
  const result = await checkStagedPrivateContent(repo);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, [{ file: 'local/exemplo.json', line: 1, code: 'caminho-privado' }]);
});

test('private guard inspects staged bytes and never prints the private term', async t => {
  const repo = await repository(t);
  const term = 'Termo Privado Fictício';
  await repo.put('local/termos-privados.txt', `${term}\n`);
  await repo.put('exemplo.js', '// exemplo\n// TERMO PRIVADO FICTÍCIO\n');
  await repo.stage('exemplo.js');
  await repo.put('exemplo.js', '// limpo só na cópia de trabalho\n');
  const result = await checkStagedPrivateContent(repo);
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, [{ file: 'exemplo.js', line: 2, code: 'termo-privado' }]);
  let failure;
  try { await run(process.execPath, [script], { cwd: repo.cwd }); } catch (error) { failure = error; }
  assert.equal(failure?.code, 1);
  assert.match(failure.stderr, /exemplo\.js.*:2:/);
  assert.equal(`${failure.stdout}${failure.stderr}`.toLocaleLowerCase('pt-BR').includes(term.toLocaleLowerCase('pt-BR')), false);
});

test('private guard allows fixture media and ordinary source without a private list', async t => {
  const repo = await repository(t);
  await repo.put('tests/fixtures/apostila-exemplo.pdf', '%PDF-1.4\nexemplo');
  await repo.put('src/exemplo.js', 'export const exemplo = 1;\n');
  await repo.stage('tests/fixtures/apostila-exemplo.pdf', 'src/exemplo.js');
  const result = await checkStagedPrivateContent(repo);
  assert.equal(result.ok, true);
  assert.equal(result.files, 2);
  assert.deepEqual(result.findings, []);
});

test('private guard blocks rather than ignore an unreadable private list', async t => {
  const repo = await repository(t);
  await mkdir(join(repo.cwd, 'local/termos-privados.txt'), { recursive: true });
  const result = await checkStagedPrivateContent(repo);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});
