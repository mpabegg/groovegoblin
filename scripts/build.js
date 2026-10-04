import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const project = resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = resolve(project, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(project, 'index.html'), resolve(output, 'index.html'));
await cp(resolve(project, 'src'), resolve(output, 'src'), { recursive: true });
await cp(resolve(project, 'assets'), resolve(output, 'assets'), { recursive: true });
await cp(resolve(project, 'README.md'), resolve(output, 'README.md'));
await cp(resolve(project, 'guide.html'), resolve(output, 'guide.html'));
await writeFile(resolve(output, '.nojekyll'), '');
console.log(`Static site built in ${output}`);
