import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const files = ['server.js', 'sw.js'];
async function collect(directory) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(path);
    else if (/\.[cm]?js$/.test(entry.name)) files.push(path);
  }
}
for (const directory of ['src', 'scripts', 'server', 'tests']) await collect(directory);
let failed = 0;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`${file}: ${result.stderr || result.error?.message || 'checagem interrompida'}`);
    failed++;
  }
}
console.log(`${files.length} módulos verificados; ${failed} falhas.`);
if (failed) process.exitCode = 1;
