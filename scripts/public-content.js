import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Only the existing, redistributed CC0 kit is public audio. A matching filename
// alone never authorizes another recording. Provenance: assets/drums/README.md.
const PUBLIC_AUDIO = new Map([
  ['assets/drums/kick.wav', 'a2d8829e8b2b59e8afb12fa396b01758827059339c2a84ad066d17b36c82d1ff'],
  ['assets/drums/snare.wav', '6ec8445cb207df8f1178d8c3894f47969fd53fb2b81c404317e466de4598dc3e'],
  ['assets/drums/hihat.wav', 'e1fb54c9a030800038abcebbed1c056fb74bdeec627315f3cd5fd893c6e6b031'],
]);
const ROOT_FILES = ['index.html', 'guide.html', 'README.md', 'manifest.webmanifest', 'icon.svg', 'sw.js'];
const PUBLIC_FILES = new Set([...ROOT_FILES, '.nojekyll', 'offline-assets.json', 'assets/drums/README.md', 'assets/drums/LICENSE.txt']);
const SOURCE_FILE = /^src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:js|css)$/;

function refused(reason) {
  // Paths can themselves contain private course titles. Never echo them.
  throw new Error(`Publicação recusada: ${reason}. Nenhum conteúdo privado foi exibido.`);
}

function mediaSignature(bytes) {
  const prefix = bytes.subarray(0, 16);
  const ascii = prefix.toString('latin1');
  return ascii.startsWith('%PDF-') || ascii.startsWith('ID3') || ascii.startsWith('OggS')
    || ascii.startsWith('fLaC') || ascii.startsWith('PK\x03\x04') || ascii.startsWith('PK\x05\x06')
    || (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') || ascii.slice(4, 8) === 'ftyp'
    || (prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0);
}

/** Validate before removing an old dist, and again before publishing its result. */
export async function assertPublicTree(root, { source = false, allowMissing = false } = {}) {
  let rootStat;
  try { rootStat = await lstat(root); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) refused('diretório de publicação inválido');

  async function inspect(relative) {
    const absolute = join(root, relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) refused('link simbólico na área pública');
    if (stat.isDirectory()) {
      if (relative !== 'src' && !relative.startsWith('src/') && relative !== 'assets' && relative !== 'assets/drums') {
        refused('diretório não autorizado na área pública');
      }
      for (const entry of await readdir(absolute)) await inspect(`${relative}/${entry}`);
      return;
    }
    if (!stat.isFile()) refused('entrada não regular na área pública');
    const expected = PUBLIC_AUDIO.get(relative);
    if (!expected && !PUBLIC_FILES.has(relative) && !SOURCE_FILE.test(relative)) refused('arquivo não autorizado na área pública');
    const bytes = await readFile(absolute);
    if (expected) {
      if (createHash('sha256').update(bytes).digest('hex') !== expected) refused('áudio diferente do kit público licenciado');
    } else if (mediaSignature(bytes)) refused('PDF, áudio, vídeo ou arquivo compactado na área pública');
  }

  const entries = source ? [...ROOT_FILES, 'src', 'assets'] : await readdir(root);
  for (const entry of entries) await inspect(entry);
}
