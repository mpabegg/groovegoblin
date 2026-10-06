import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createAssetManifest } from './asset-manifest.js';
import { assertPublicTree } from './public-content.js';

const project = resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = resolve(project, 'dist');

// Refuse rather than deleting a private file someone put in an old dist.
await assertPublicTree(output, { allowMissing: true });
await assertPublicTree(project, { source: true });
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(project, 'index.html'), resolve(output, 'index.html'));
await cp(resolve(project, 'src'), resolve(output, 'src'), { recursive: true });
await cp(resolve(project, 'assets'), resolve(output, 'assets'), { recursive: true });
await cp(resolve(project, 'README.md'), resolve(output, 'README.md'));
await cp(resolve(project, 'guide.html'), resolve(output, 'guide.html'));
for (const file of ['manifest.webmanifest', 'icon.svg', 'sw.js']) {
  await cp(resolve(project, file), resolve(output, file));
}
const manifest = await createAssetManifest(output);
const worker = await readFile(resolve(output, 'sw.js'), 'utf8');
await writeFile(resolve(output, 'sw.js'), worker.replace('__GROOVE_REVISION__', manifest.version));
await writeFile(resolve(output, 'offline-assets.json'), JSON.stringify(manifest));
await writeFile(resolve(output, '.nojekyll'), '');
await assertPublicTree(output);
console.log('Static site built in dist/; public-content boundary verified.');
