import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT_FILES = ['index.html', 'guide.html', 'README.md', 'manifest.webmanifest', 'icon.svg', 'sw.js'];

/** Content-address the complete public application, never user media or storage. */
export async function createAssetManifest(root) {
  const files = [...ROOT_FILES];
  async function walk(directory) {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  await walk('src');
  await walk('assets');
  files.sort();
  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    const content = await readFile(join(root, file));
    hash.update(file).update('\0').update(content).update('\0');
    bytes += content.length;
  }
  return { version: hash.digest('hex').slice(0, 24), files, bytes };
}
