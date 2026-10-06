import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MEDIA = /\.(?:pdf|mp3|wav|wave|ogg|oga|flac|aac|m4a|opus|aif|aiff|wma|zip|mp4|webm|mov)$/i;
const git = async (cwd, ...args) => (await run('git', args, {
  cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
})).stdout;

// Read the index, not the working tree: only these bytes would enter the commit.
// Private terms never leave this process, including in errors or diagnostics.
export async function checkStagedPrivateContent({ cwd = process.cwd() } = {}) {
  try {
    const root = (await git(cwd, 'rev-parse', '--show-toplevel')).trim();
    let terms = [];
    try {
      terms = [...new Set((await readFile(resolve(root, 'local/termos-privados.txt'), 'utf8'))
        .split(/\r?\n/).map(term => term.trim()).filter(Boolean)
        .map(term => term.toLocaleLowerCase('pt-BR')))];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const fields = (await git(root, 'diff', '--cached', '--name-status', '-z', '--diff-filter=ACMR', '--no-ext-diff'))
      .split('\0');
    const findings = [];
    let files = 0;
    for (let index = 0; fields[index];) {
      const status = fields[index++];
      let file = fields[index++];
      if (status.startsWith('R') || status.startsWith('C')) file = fields[index++];
      if (!file) throw new Error('invalid-index');
      files++;
      if (file === 'local' || file.startsWith('local/')) {
        findings.push({ file, line: 1, code: 'caminho-privado' });
        continue;
      }
      if (status[0] !== 'M' && MEDIA.test(file) && !file.startsWith('tests/fixtures/')) {
        findings.push({ file, line: 1, code: 'material-novo' });
      }
      if (!terms.length) continue;
      const contents = await git(root, 'show', `:${file}`);
      if (contents.includes('\0')) continue;
      const lines = contents.split('\n');
      for (let line = 0; line < lines.length; line++) {
        const text = lines[line].toLocaleLowerCase('pt-BR');
        if (terms.some(term => text.includes(term))) findings.push({ file, line: line + 1, code: 'termo-privado' });
      }
    }
    return { ok: findings.length === 0, files, findings };
  } catch {
    return { ok: false, files: 0, findings: [], error: 'Não foi possível conferir o índice ou a lista privada; commit bloqueado.' };
  }
}

export async function main() {
  const result = await checkStagedPrivateContent();
  if (result.error) console.error(result.error);
  for (const finding of result.findings) {
    console.error(`${JSON.stringify(finding.file)}:${finding.line}: ${finding.code}`);
  }
  if (!result.ok) console.error('Commit bloqueado pela proteção de conteúdo privado. Nenhum termo ou trecho foi exibido.');
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
